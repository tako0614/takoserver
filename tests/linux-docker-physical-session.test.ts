import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileLinuxContainerEgress } from "../src/providers/linux-container-egress.ts";
import {
  openDockerPhysicalProcess,
  readDockerPhysicalBridge,
  readDockerPhysicalBridgeBinding,
} from "../src/providers/linux-docker-physical-session.ts";

let root: string;
let helper: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "integration-physical-peer-"));
  helper = join(root, "native-session");
  const child = Bun.spawn(
    [
      "cc",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      new URL("../scripts/native/docker-container-physical-session.c", import.meta.url).pathname,
      "-o",
      helper,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  } finally {
    clearTimeout(timer);
  }
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true });
});

async function fixture(use: (socketPath: string, requests: string[]) => Promise<void>) {
  const socketPath = join(root, `s-${crypto.randomUUID().slice(0, 8)}`);
  const requests: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (data) => {
      input += data.toString();
      if (!input.includes("\r\n\r\n")) return;
      requests.push(input.split("\r\n")[0] ?? "");
      const body = JSON.stringify({ Id: "a".repeat(64), synthetic: true });
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await use(socketPath, requests);
  } finally {
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
          }),
      ),
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(sockets.size).toBe(0);
  }
}
function options(socketPath: string) {
  return {
    helper,
    socketPath,
    peerPid: process.pid,
    peerUid: process.getuid?.() ?? -1,
    networkId: "a".repeat(64),
    table: "takos_cx_fixture",
    signal: new AbortController().signal,
  };
}

test("captures the genuine own Unix peer and retains its namespace read-only", async () => {
  await fixture(async (socketPath, requests) => {
    const owned = await openDockerPhysicalProcess(options(socketPath));
    try {
      expect(owned.metadata.peerPid).toBe(process.pid);
      expect(owned.metadata.captureOnly).toBe(true);
      expect(`net:[${String(owned.metadata.namespaceInode)}]`).toBe(
        await readlink("/proc/self/ns/net"),
      );
      await owned.current();
      expect(requests).toHaveLength(0);
      await expect(owned.link("integration0")).rejects.toThrow(
        "docker_physical_session_unavailable",
      );
    } finally {
      await owned.close();
    }
  });
});

test("refuses wrong peer PID and UID before native command access", async () => {
  await fixture(async (socketPath, requests) => {
    await expect(
      openDockerPhysicalProcess({ ...options(socketPath), peerPid: process.pid + 1 }),
    ).rejects.toThrow("docker_physical_session_unavailable");
    await expect(
      openDockerPhysicalProcess({ ...options(socketPath), peerUid: (process.getuid?.() ?? 0) + 1 }),
    ).rejects.toThrow("docker_physical_session_unavailable");
    expect(requests).toHaveLength(0);
  });
});

test("native mode itself refuses the actual parent namespace before any exec", async () => {
  await fixture(async (socketPath, requests) => {
    await expect(
      openDockerPhysicalProcess({
        ...options(socketPath),
        native: { ipBinary: "/never-executed/ip", nftBinary: "/never-executed/nft" },
      }),
    ).rejects.toThrow("docker_physical_session_unavailable");
    expect(requests).toHaveLength(0);
  });
});

test("reads only the exact selected synthetic network through the pinned peer", async () => {
  await fixture(async (socketPath, requests) => {
    const owned = await openDockerPhysicalProcess(options(socketPath));
    try {
      expect(await owned.network()).toEqual({ Id: "a".repeat(64), synthetic: true });
      expect(requests).toEqual([`GET /v1.51/networks/${"a".repeat(64)} HTTP/1.1`]);
      await owned.current();
    } finally {
      await owned.close();
    }
  });
});

test("refuses arbitrary nft argv and changed script before sending a command", async () => {
  await fixture(async (socketPath, requests) => {
    const owned = await openDockerPhysicalProcess(options(socketPath));
    try {
      const plan = compileLinuxContainerEgress({
        namespace: { parent: "net:[1]", selected: "net:[2]" },
        table: "takos_cx_fixture",
        killSwitch: true,
        tenants: [
          {
            authority: {
              tenantRef: "synthetic",
              generation: 1,
              policyDigest: `sha256:${"b".repeat(64)}`,
              outboundInternet: false,
            },
            interfaces: ["fixture0"],
            maxConnections: 1,
            packetLimitBytes: 1000,
          },
        ],
      });
      const port = owned.port(plan);
      await expect(port.execute({ argv: ["nft", "flush", "ruleset"] })).rejects.toThrow();
      await expect(
        port.execute({ argv: ["nft", "--check", "-f", "-"], stdin: `${plan.script}\n` }),
      ).rejects.toThrow();
      await owned.current();
      expect(requests).toHaveLength(0);
    } finally {
      await owned.close();
    }
  });
});

test("revocation terminates only its captured helper and joins cleanup", async () => {
  await fixture(async (socketPath) => {
    const revoke = new AbortController();
    const owned = await openDockerPhysicalProcess({
      ...options(socketPath),
      signal: revoke.signal,
    });
    revoke.abort();
    await expect(owned.current()).rejects.toThrow();
    await owned.close();
  });
});

test("the original peer pidfd refuses use after that owned server exits", async () => {
  const socketPath = join(root, "owned-child-peer");
  const program =
    `import {createServer} from "node:net";` +
    `createServer(()=>{}).listen(${JSON.stringify(socketPath)},()=>console.log("ready"));` +
    `process.stdin.resume();process.stdin.on("end",()=>process.exit(0));`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", program], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 5000);
  let owned: Awaited<ReturnType<typeof openDockerPhysicalProcess>> | undefined;
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    owned = await openDockerPhysicalProcess({ ...options(socketPath), peerPid: child.pid });
    await owned.current();
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await expect(owned.current()).rejects.toThrow("docker_physical_session_unavailable");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.exited;
    await owned?.close();
    await reader.cancel();
    expect(await stderr).toBe("");
  }
});

test("mock native JSON must agree on exact NetworkID, bridge kind/index and IPAM", async () => {
  const native = {
    backend: "docker" as const,
    installationId: "integration-fixture",
    resourceUid: "resource",
    incarnationId: "incarnation",
    revision: "revision",
    nativeId: "c".repeat(64),
    network: "fixture-network",
    networkId: "b".repeat(64),
    image: `fixture@sha256:${"d".repeat(64)}`,
    imageId: `sha256:${"e".repeat(64)}`,
    identityLabel: `sha256:${"f".repeat(64)}`,
    revisionLabel: `sha256:${"1".repeat(64)}`,
  };
  const policy = {
    tenantRef: "synthetic",
    generation: 1,
    policyDigest: `sha256:${"2".repeat(64)}`,
    outboundInternet: false,
  };
  const network = {
    Id: native.networkId,
    Name: native.network,
    Driver: "bridge",
    Scope: "local",
    Internal: true,
    Ingress: false,
    Attachable: false,
    Labels: { "takoserver.installation": native.installationId },
    Options: { "com.docker.network.bridge.name": "cx_fixture" },
    Containers: {} as Record<string, unknown>,
    IPAM: { Config: [{ Subnet: "172.20.0.0/24", Gateway: "172.20.0.1" }] },
  };
  const link = {
    ifname: "cx_fixture",
    ifindex: 8,
    address: "02:00:00:00:00:01",
    linkinfo: { info_kind: "bridge" },
  };
  const address = {
    ifname: "cx_fixture",
    ifindex: 8,
    addr_info: [{ local: "172.20.0.1", prefixlen: 24, scope: "global" }],
  };
  for (const change of [
    "none",
    "id",
    "driver",
    "name",
    "kind",
    "index",
    "subnet",
    "extra-address",
    "foreign-member",
  ]) {
    const n = structuredClone(network),
      l = structuredClone(link),
      a = structuredClone(address);
    if (change === "id") n.Id = "3".repeat(64);
    if (change === "driver") n.Driver = "macvlan";
    if (change === "name") n.Options["com.docker.network.bridge.name"] = "";
    if (change === "kind") l.linkinfo.info_kind = "veth";
    if (change === "index") a.ifindex++;
    if (change === "subnet") {
      const config = n.IPAM.Config[0];
      if (!config) throw new Error("missing synthetic fixture IPAM");
      config.Subnet = "10.0.0.0/24";
    }
    if (change === "extra-address")
      a.addr_info.push({ local: "192.168.1.1", prefixlen: 24, scope: "global" });
    if (change === "foreign-member") n.Containers["4".repeat(64)] = {};
    const mock = {
      current: async () => {},
      network: async () => n,
      link: async () => [l],
      addresses: async () => [a],
    } as unknown as Awaited<ReturnType<typeof openDockerPhysicalProcess>>;
    const read = readDockerPhysicalBridge(mock, native, policy, {
      tcpPorts: [8080],
      conntrackMark: 1001,
    });
    if (change === "none") {
      await expect(read).resolves.toMatchObject({
        networkId: native.networkId,
        bridge: "cx_fixture",
        ifindex: 8,
      });
      const original = await readDockerPhysicalBridgeBinding(mock, native, policy, {
        tcpPorts: [8080],
        conntrackMark: 1001,
      });
      expect(original.ipam).toEqual([{ subnet: "172.20.0.0/24", gateway: "172.20.0.1" }]);
      // Matching changes on both sides remain individually valid, but must not
      // disappear from the full original allocation signature.
      const config = n.IPAM.Config[0],
        actual = a.addr_info[0];
      if (!config || !actual) throw new Error("missing synthetic IPAM");
      config.Subnet = "172.20.0.0/25";
      actual.prefixlen = 25;
      const changed = await readDockerPhysicalBridgeBinding(mock, native, policy, {
        tcpPorts: [8080],
        conntrackMark: 1001,
      });
      expect(changed.bridge).toEqual(original.bridge);
      expect(changed.ipam).not.toEqual(original.ipam);
      expect(Object.isFrozen(original.ipam)).toBe(true);
      expect(Object.isFrozen(original.ipam[0])).toBe(true);
    } else await expect(read).rejects.toThrow("docker_physical_session_unavailable");
  }
});
