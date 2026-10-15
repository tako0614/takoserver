import { readlink } from "node:fs/promises";
import {
  compileLinuxContainerEgress,
  linuxContainerEgressAllows,
  linuxContainerEgressKillScript,
  verifyLinuxContainerEgressReadback,
} from "../src/providers/linux-container-egress.ts";

function plans(parent: string, selected: string) {
  return Object.fromEntries(
    ["transport", "connections", "udp", "quota", "kill", "false"].map((phase) => {
      const plan = compileLinuxContainerEgress({
        namespace: { parent, selected },
        table: "takos_cx_native",
        killSwitch: false,
        tenants: [
          {
            authority: {
              tenantRef: "a",
              generation: 1,
              policyDigest: `sha256:${"a".repeat(64)}`,
              outboundInternet: phase !== "false",
            },
            interfaces: ["cx_a", "cx_a2"],
            maxConnections: ["connections", "udp"].includes(phase) ? 2 : 128,
            packetLimitBytes: phase === "quota" ? 512 : 1048576,
          },
          {
            authority: {
              tenantRef: "b",
              generation: 1,
              policyDigest: `sha256:${"b".repeat(64)}`,
              outboundInternet: true,
            },
            interfaces: ["cx_b"],
            maxConnections: 128,
            packetLimitBytes: 1048576,
          },
        ],
      });
      for (const [address, port, transport] of [
        ["8.8.8.8", 24, "tcp"],
        ["2606:4700:4700::1111", 26, "tcp"],
        ["8.8.8.8", 25, "udp"],
      ] as const) {
        if (!linuxContainerEgressAllows(plan, "b", address, port, transport)) {
          throw new Error("controlled public sink conflicts with current egress policy");
        }
      }
      return [phase, plan];
    }),
  );
}

if (process.argv[2] === "--compile-child") {
  const parent = process.argv[3];
  if (!parent) throw new Error("parent namespace required");
  const compiled = plans(parent, await readlink("/proc/self/ns/net"));
  if (!compiled.kill) throw new Error("kill phase missing");
  process.stdout.write(
    JSON.stringify({
      plans: compiled,
      killScript: linuxContainerEgressKillScript(compiled.kill, "a"),
    }),
  );
} else {
  if (process.platform !== "linux") throw new Error("native Linux network namespaces required");
  const parent = await readlink("/proc/self/ns/net");
  const child = Bun.spawn(
    [
      "timeout",
      "--kill-after=5s",
      "110s",
      "unshare",
      "--net",
      "--",
      "python3",
      `${import.meta.dir}/fixtures/container-network-egress/probe.py`,
      "--parent",
      parent,
      "--compiler",
      import.meta.path,
      "--bun",
      process.execPath,
    ],
    {
      env: { PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stderr) process.stderr.write(stderr);
  process.stdout.write(stdout);
  if (code !== 0) throw new Error(`isolated native acceptance exited ${code}`);
  const result: unknown = JSON.parse(stdout);
  if (
    typeof result !== "object" ||
    result === null ||
    !("namespace" in result) ||
    !("readbacks" in result)
  ) {
    throw new Error("native acceptance receipt missing");
  }
  const evidence = result as {
    namespace: string;
    readbacks: {
      phase: string;
      before: unknown;
      after: unknown;
      killed?: boolean;
      drifted?: unknown;
    }[];
    cleanup: { childrenReaped: boolean };
  };
  const compiled = plans(parent, evidence.namespace);
  for (const entry of evidence.readbacks) {
    const plan = compiled[entry.phase];
    if (!plan) throw new Error("unknown native phase");
    const initial = verifyLinuxContainerEgressReadback(plan, entry.before);
    verifyLinuxContainerEgressReadback(
      plan,
      entry.after,
      initial.structuralDigest,
      entry.killed ? ["a"] : [],
    );
    if (entry.drifted !== undefined) {
      let refused = false;
      try {
        verifyLinuxContainerEgressReadback(plan, entry.drifted, initial.structuralDigest);
      } catch {
        refused = true;
      }
      if (!refused) throw new Error("native drift was accepted");
    }
  }
  if ((await readlink("/proc/self/ns/net")) !== parent || !evidence.cleanup.childrenReaped) {
    throw new Error("native namespace cleanup incomplete");
  }
}
