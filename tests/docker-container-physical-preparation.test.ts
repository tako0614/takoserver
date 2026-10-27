import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerContainerCreateRecord } from "../src/providers/docker-container-create-custody.ts";
import {
  createDockerPhysicalRuntimePreparation,
  type DockerPhysicalOwnerPort,
} from "../src/providers/docker-container-physical-preparation.ts";
import type { DockerContainerNativeIdentity } from "../src/providers/docker-container-runtime-preparation.ts";
import {
  compileLinuxContainerEgress,
  type LinuxContainerEgressPlan,
  verifyLinuxContainerEgressReadback,
} from "../src/providers/linux-container-egress.ts";

function required<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw Error("fixture missing");
  return x;
}
function readback(plan: LinuxContainerEgressPlan) {
  const objects: Record<string, unknown>[] = [
    { table: { family: "inet", name: plan.table } },
    { set: { family: "inet", table: plan.table, name: "disabled", type: "ifname" } },
  ];
  if (plan.hostHttp) {
    objects.push({
      set: {
        family: "inet",
        table: plan.table,
        name: "outbound_denied",
        type: "ifname",
        elem: plan.tenants
          .filter((tenant) => !tenant.authority.outboundInternet)
          .flatMap((tenant) => tenant.interfaces),
      },
    });
  }
  const disabled = plan.tenants
    .filter((tenant) => plan.killSwitch || (!plan.hostHttp && !tenant.authority.outboundInternet))
    .flatMap((tenant) => tenant.interfaces);
  if (disabled.length) (required(objects[1]).set as Record<string, unknown>).elem = disabled;
  for (const hook of plan.hostHttp ? ["input", "forward", "output"] : ["input", "forward"])
    objects.push({
      chain: {
        family: "inet",
        table: plan.table,
        name: hook,
        type: "filter",
        hook,
        prio: -10,
        policy: "accept",
      },
    });
  for (const [index, tenant] of plan.tenants.entries()) {
    objects.push({ chain: { family: "inet", table: plan.table, name: `t${index}` } });
    objects.push({
      quota: {
        family: "inet",
        table: plan.table,
        name: `q${index}`,
        bytes: tenant.packetLimitBytes,
        inv: true,
      },
    });
  }
  for (const name of [
    "killed",
    "host_denied",
    ...(plan.hostHttp ? ["host_replies"] : []),
    ...plan.tenants.flatMap((_, index) => [
      `accepted${index}`,
      `denied${index}`,
      `cap_denied${index}`,
    ]),
  ]) {
    objects.push({ counter: { family: "inet", table: plan.table, name, bytes: 0, packets: 0 } });
  }
  for (const [index, key] of plan.ruleTags.entries()) {
    const [chain, comment] = key.split(":");
    objects.push({
      rule: {
        family: "inet",
        table: plan.table,
        chain,
        comment,
        expr: structuredClone(plan.ruleExpressions[index]),
      },
    });
  }
  if (plan.bridgeRules) {
    const common = { family: "bridge", table: plan.bridgeRules.table };
    objects.push({ table: { family: "bridge", name: common.table } });
    objects.push({ set: { ...common, name: "disabled", type: "ifname", elem: disabled } });
    for (const name of ["killed", "bridge_denied"])
      objects.push({ counter: { ...common, name, bytes: 0, packets: 0 } });
    for (const hook of ["prerouting", "input", "forward", "output"])
      objects.push({
        chain: { ...common, name: hook, type: "filter", hook, prio: -210, policy: "accept" },
      });
    for (const [index, tag] of plan.bridgeRules.ruleTags.entries()) {
      const [chain, comment] = tag.split(":");
      objects.push({
        rule: {
          ...common,
          chain,
          comment,
          expr: structuredClone(plan.bridgeRules.ruleExpressions[index]),
        },
      });
    }
  }
  return { nftables: objects };
}

const policy = {
  tenantRef: "synthetic-tenant",
  generation: 1,
  policyDigest: `sha256:${"a".repeat(64)}`,
  outboundInternet: false,
};
const native: DockerContainerNativeIdentity = {
  backend: "docker",
  installationId: "integration-physical",
  resourceUid: "synthetic-resource",
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

/** Explicit protocol MOCK, not native/accepted-Core/ownership qualification.
 * Actual SO_PEERPIDFD capture is tested separately against the real C helper.
 */
type ReadbackMode =
  | "empty"
  | "valid"
  | "fail-final"
  | "revoke-final"
  | "symbolic"
  | "index-before"
  | "index-after"
  | "index-after-bridge"
  | "name-after"
  | "mac-after"
  | "prefix-after"
  | "current-after"
  | "unknown-rule";

async function fixture(
  use: (f: Awaited<ReturnType<typeof create>>) => Promise<void>,
  mode: ReadbackMode = "empty",
) {
  const root = await mkdtemp(join(tmpdir(), "integration-physical-mock-"));
  const f = await create(root, mode);
  try {
    await use(f);
  } finally {
    f.revoke.abort();
    await f.joinCleanup();
    await rm(root, { recursive: true });
  }
}
async function create(root: string, mode: ReadbackMode) {
  const helper = join(root, "mock-helper"),
    transcript = join(root, "requests"),
    pidFile = join(root, "owned-helper-pid");
  const record: DockerContainerCreateRecord = {
    claimId: "2".repeat(64),
    state: "bound",
    nativeId: native.nativeId,
    intent: {
      installationId: native.installationId,
      resourceUid: native.resourceUid,
      incarnationId: native.incarnationId,
      revision: native.revision,
      nativeName: `takoserver-${native.identityLabel.slice(7)}`,
      identityLabel: native.identityLabel,
      revisionLabel: native.revisionLabel,
      policy,
      requiredSecretNames: ["SYNTHETIC"],
    },
  };
  let current = true,
    grants = 0,
    claims = 0,
    oldPrepare = 0,
    secretLoans = 0,
    detached = false,
    active = 0;
  let saved: DockerContainerCreateRecord | null = record;
  let phase: string | undefined;
  let startState: "unclaimed" | "unknown" = "unclaimed";
  const revoke = new AbortController();
  const owner: DockerPhysicalOwnerPort = {
    read: async () => structuredClone(saved),
    claim: async () => {
      throw new Error("No new CREATE claim is permitted by physical capture");
    },
    async withAuthority(_record, actualPhase, use) {
      grants++;
      phase = actualPhase;
      active++;
      try {
        const work = use({
          revocation: revoke.signal,
          stillCurrent: async () => current,
          withEnvironment: async () => {
            secretLoans++;
            throw new Error("physical never loans secrets");
          },
        });
        if (detached) {
          void work.catch(() => undefined);
          return undefined as never;
        }
        return await work;
      } finally {
        active--;
      }
    },
    bindNative: async () => {
      throw new Error("already bound");
    },
    confirmRunning: async () => {
      throw new Error("no retirement");
    },
    confirmStopped: async () => {
      throw new Error("no retirement");
    },
    confirmRemoved: async () => {
      throw new Error("no retirement");
    },
    readStartClaim: async () => startState,
    claimStart: async () => {
      claims++;
      return "claimed";
    },
    assertNetworkAllocation: async () => {
      if (!current) throw new Error("expired mock scope");
      if (mode === "current-after" && (await commands()).includes("NFTREAD")) current = false;
      if (mode === "revoke-final" && (await commands()).filter((x) => x === "NFTREAD").length >= 3)
        revoke.abort();
    },
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
    Containers: {},
    IPAM: { Config: [{ Subnet: "172.20.0.0/24", Gateway: "172.20.0.1" }] },
  };
  const bridge = {
    tenantRef: policy.tenantRef,
    generation: policy.generation,
    networkId: native.networkId,
    bridge: "cx_fixture",
    ifindex: 8,
    hostMac: "02:00:00:00:00:01",
    hostAddresses: ["172.20.0.1"],
    tcpPorts: [8080],
    conntrackMark: 1001,
  };
  const plan = compileLinuxContainerEgress({
    namespace: { parent: "net:[111]", selected: "net:[222]" },
    table: "takos_cx_fixture",
    killSwitch: true,
    hostHttp: [bridge],
    tenants: [
      {
        authority: policy,
        interfaces: [bridge.bridge],
        maxConnections: 2,
        packetLimitBytes: 10000,
      },
    ],
  });
  const aggregate = readback(plan);
  const validFixture =
    verifyLinuxContainerEgressReadback(plan, aggregate).fullRuntimeCoverage === false;
  const program =
    `#!${process.execPath}\n` +
    String.raw`
import { appendFileSync, writeFileSync } from "node:fs";
const log = LOG; const network = NETWORK; const aggregate = AGGREGATE; const mode = MODE; let reads = 0,installed=false;
writeFileSync(PIDFILE,String(process.pid));
const send = (text) => { const body=Buffer.concat([Buffer.from([0]),Buffer.from(text)]);
  const h=Buffer.alloc(4);h.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([h,body])); };
send(JSON.stringify({kind:"docker-physical-session@1",peerPid:123,peerUid:0,
 namespaceDevice:"1",namespaceInode:"222",parentDevice:"1",parentInode:"111",captureOnly:false}));
let buffer=Buffer.alloc(0);
process.stdin.on("data", data => { buffer=Buffer.concat([buffer,data]);
 while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32BE(0)) {
  const size=buffer.readUInt32BE(0),text=buffer.subarray(4,4+size).toString();buffer=buffer.subarray(4+size);
  const op=text.split(/\s/u)[0];appendFileSync(log,op+"\n");
  const after=reads>0;
  const indexChanged=(mode==="index-before"&&installed)||(mode==="index-after"&&after)||(mode==="index-after-bridge"&&reads>=2);
  const name=mode==="name-after"&&after?"cx_rebound":"cx_fixture";
  if(op==="CLOSE"){send("{}");process.exit(0);}
  else if(op==="CURRENT"||op==="NFTCHECK"||op==="NFTAPPLY"){if(op==="NFTAPPLY")installed=true;send("{}");}
  else if(op==="NETWORK"){const n=structuredClone(network);n.Options["com.docker.network.bridge.name"]=name;if(mode==="prefix-after"&&after)n.IPAM.Config[0].Subnet="172.20.0.0/25";const body=JSON.stringify(n);send("HTTP/1.1 200 OK\r\nContent-Length: "+Buffer.byteLength(body)+"\r\n\r\n"+body);}
  else if(op==="LINK")send(JSON.stringify([{ifname:name,ifindex:indexChanged?9:8,address:mode==="mac-after"&&after?"02:00:00:00:00:02":"02:00:00:00:00:01",linkinfo:{info_kind:"bridge"}}]));
  else if(op==="ADDR")send(JSON.stringify([{ifname:name,ifindex:indexChanged?9:8,addr_info:[{local:"172.20.0.1",prefixlen:mode==="prefix-after"&&after?25:24,scope:"global"}]}]));
  else if(op==="NFTREAD"){
    reads++;const family=text.split(" ")[1];const values=structuredClone(aggregate.nftables.filter(entry=>Object.values(entry)[0].family===family));
    for(const entry of values)for(const node of entry.rule?.expr??[]){if(mode==="symbolic"&&["iif","oif"].includes(node.match?.left?.meta?.key))node.match.right="cx_fixture";}
    if(mode==="unknown-rule"){const rule=values.find(entry=>entry.rule);if(rule)rule.rule.expr.push({accept:null});}
    send(JSON.stringify({nftables: mode === "empty" || (mode === "fail-final" && reads > 2) ? [] : values}));
  }
 }
});
`
      .replace("LOG", JSON.stringify(transcript))
      .replace("NETWORK", JSON.stringify(network))
      .replace("AGGREGATE", JSON.stringify(aggregate))
      .replace("MODE", JSON.stringify(mode))
      .replace("PIDFILE", JSON.stringify(pidFile));
  await writeFile(helper, program, { mode: 0o700 });
  await chmod(helper, 0o700);
  const runtime = () =>
    createDockerPhysicalRuntimePreparation({
      policy,
      requiredSecretNames: ["SYNTHETIC"],
      owner,
      process: {
        helper,
        socketPath: join(root, "unused"),
        peerPid: 123,
        peerUid: 0,
        table: "takos_cx_fixture",
        native: { ipBinary: "/never-executed/ip", nftBinary: "/never-executed/nft" },
      },
      host: { tcpPorts: [8080], conntrackMark: 1001 },
      maxConnections: 2,
      packetLimitBytes: 10000,
      ...{
        prepare: () => {
          oldPrepare++;
          throw new Error("old producer must not bootstrap authority");
        },
      },
    });
  async function commands() {
    try {
      return (await readFile(transcript, "utf8")).trim().split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async function helperGone() {
    let pid: number;
    try {
      pid = Number(await readFile(pidFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("bad own helper PID");
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }
  return {
    runtime,
    validFixture,
    active: () => active,
    helperGone,
    async joinCleanup() {
      const until = Date.now() + 2000;
      while (active !== 0 || !(await helperGone())) {
        if (Date.now() >= until) throw new Error("owned fixture cleanup not joined");
        await Bun.sleep(5);
      }
    },
    record,
    revoke,
    setCurrent(value: boolean) {
      current = value;
    },
    setRecord(value: DockerContainerCreateRecord | null) {
      saved = value;
    },
    setUnknown() {
      startState = "unknown";
    },
    setDetached() {
      detached = true;
    },
    counts: () => ({ grants, claims, oldPrepare, secretLoans, phase }),
    commands,
  };
}

test("same identity with reversed property order has one owned capture/install and no START after bad readback", async () => {
  await fixture(async (f) => {
    const runtime = f.runtime();
    const reordered = Object.fromEntries(
      Object.entries(native).reverse(),
    ) as unknown as DockerContainerNativeIdentity;
    const results = await Promise.allSettled(
      [native, reordered].map((value) =>
        runtime.authorizeStart({ native: value, state: "stopped" }, async () => {
          throw new Error("START forbidden");
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(
      runtime.authorizeStart({ native, state: "stopped" }, async () => {}),
    ).rejects.toThrow();
    expect(f.counts()).toEqual({
      grants: 1,
      claims: 0,
      oldPrepare: 0,
      secretLoans: 0,
      phase: "reconcile",
    });
    const commands = await f.commands();
    expect(commands.filter((command) => command === "NFTCHECK")).toHaveLength(1);
    expect(commands.filter((command) => command === "NFTAPPLY")).toHaveLength(1);
    // Both requested family responses are read before aggregate validation.
    expect(commands.filter((command) => command === "NFTREAD")).toHaveLength(2);
  });
});
test("claimed/unknown recovery never checks, installs or starts", async () => {
  await fixture(async (f) => {
    f.setUnknown();
    await expect(
      f.runtime().authorizeStart({ native, state: "stopped" }, async () => {}),
    ).rejects.toThrow();
    expect(f.counts().phase).toBe("observe");
    expect(f.counts().claims).toBe(0);
    expect(
      (await f.commands()).filter((command) => ["NFTCHECK", "NFTAPPLY"].includes(command)),
    ).toEqual([]);
  });
});
test("absent, foreign and expired CREATE custody refuse before any native process", async () => {
  await fixture(async (f) => {
    for (const record of [
      null,
      { ...f.record, nativeId: "3".repeat(64) },
      { ...f.record, intent: { ...f.record.intent, policy: { ...policy, generation: 2 } } },
    ]) {
      f.setRecord(record);
      await expect(
        f.runtime().authorizeStart({ native, state: "stopped" }, async () => {}),
      ).rejects.toThrow();
    }
    f.setRecord(f.record);
    f.setCurrent(false);
    await expect(
      f.runtime().authorizeStart({ native, state: "stopped" }, async () => {}),
    ).rejects.toThrow();
    expect(await f.commands()).toEqual([]);
    expect(f.counts().claims).toBe(0);
  });
});
test("a detached owner callback cannot lend native authority after it returns", async () => {
  await fixture(async (f) => {
    f.setDetached();
    await expect(
      f.runtime().authorizeStart({ native, state: "stopped" }, async () => {}),
    ).rejects.toThrow();
    expect(f.counts().claims).toBe(0);
    expect(
      (await f.commands()).filter((command) => ["NFTCHECK", "NFTAPPLY"].includes(command)),
    ).toEqual([]);
  });
});

test("valid partial readback is refused only after its helper and owner scope are joined", async () => {
  for (const recovery of [false, true]) {
    await fixture(async (f) => {
      expect(f.validFixture).toBe(true);
      if (recovery) f.setUnknown();
      const runtime = f.runtime();
      await expect(
        runtime.authorizeStart({ native, state: "stopped" }, async () => {
          throw new Error("START forbidden");
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(f.revoke.signal.aborted).toBe(false);
      expect(f.active()).toBe(0);
      expect(await f.helperGone()).toBe(true);
      const commands = await f.commands();
      expect(commands.filter((x) => x === "NFTCHECK")).toHaveLength(recovery ? 0 : 1);
      expect(commands.filter((x) => x === "NFTAPPLY")).toHaveLength(recovery ? 0 : 1);
      expect(commands.filter((x) => x === "NFTREAD")).toHaveLength(4);
      await expect(
        runtime.authorizeStart({ native, state: "stopped" }, async () => {}),
      ).rejects.toThrow();
      expect(f.counts().grants).toBe(1);
      expect(f.counts().claims).toBe(0);
      expect(f.counts().secretLoans).toBe(0);
      expect((await f.commands()).filter((x) => x === "NFTAPPLY")).toHaveLength(recovery ? 0 : 1);
    }, "valid");
  }
});

test("post-capture readback failure and revocation join refused scopes without reinstall", async () => {
  for (const mode of ["fail-final", "revoke-final"] as const) {
    await fixture(async (f) => {
      const runtime = f.runtime();
      await expect(
        runtime.authorizeStart({ native, state: "stopped" }, async () => {
          throw new Error("START forbidden");
        }),
      ).rejects.toThrow();
      expect(f.active()).toBe(0);
      expect(await f.helperGone()).toBe(true);
      expect(f.revoke.signal.aborted).toBe(mode === "revoke-final");
      await expect(
        runtime.authorizeStart({ native, state: "stopped" }, async () => {}),
      ).rejects.toThrow();
      expect(f.counts().grants).toBe(1);
      expect(f.counts().claims).toBe(0);
      expect(f.counts().secretLoans).toBe(0);
      expect((await f.commands()).filter((x) => x === "NFTAPPLY")).toHaveLength(1);
    }, mode);
  }
});

test("physical port normalizes symbolic index JSON only inside its original held binding and joins partial refusal", async () => {
  await fixture(async (f) => {
    const runtime = f.runtime();
    await expect(
      runtime.authorizeStart({ native, state: "stopped" }, async () => {
        throw new Error("START forbidden");
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.active()).toBe(0);
    expect(await f.helperGone()).toBe(true);
    expect(f.revoke.signal.aborted).toBe(false);
    const commands = await f.commands();
    for (const [index, command] of commands.entries())
      if (command === "NFTREAD") {
        expect(commands.slice(0, index).lastIndexOf("ADDR")).toBeGreaterThan(
          commands.slice(0, index).lastIndexOf("NFTREAD"),
        );
        const after = commands.slice(index + 1),
          nextRead = after.indexOf("NFTREAD"),
          nextAddr = after.indexOf("ADDR");
        expect(nextAddr).toBeGreaterThanOrEqual(0);
        if (nextRead >= 0) expect(nextAddr).toBeLessThan(nextRead);
      }
    expect(commands.filter((x) => x === "NFTREAD")).toHaveLength(4);
    expect(f.counts().claims).toBe(0);
    expect(f.counts().secretLoans).toBe(0);
  }, "symbolic");
});

test("each table read refuses changed original index/name/MAC/IPAM/current and foreign rules without replay", async () => {
  for (const mode of [
    "index-before",
    "index-after",
    "index-after-bridge",
    "name-after",
    "mac-after",
    "prefix-after",
    "current-after",
    "unknown-rule",
  ] as const) {
    await fixture(async (f) => {
      const runtime = f.runtime();
      await expect(
        runtime.authorizeStart({ native, state: "stopped" }, async () => {
          throw new Error("START forbidden");
        }),
      ).rejects.toThrow();
      expect(f.active()).toBe(0);
      expect(await f.helperGone()).toBe(true);
      await expect(
        runtime.authorizeStart({ native, state: "stopped" }, async () => {}),
      ).rejects.toThrow();
      expect(f.counts().grants).toBe(1);
      expect(f.counts().claims).toBe(0);
      expect(f.counts().secretLoans).toBe(0);
      const commands = await f.commands();
      expect(commands.filter((x) => x === "NFTAPPLY")).toHaveLength(1);
      if (mode === "index-before") expect(commands.filter((x) => x === "NFTREAD")).toHaveLength(0);
      if (mode === "index-after-bridge")
        expect(commands.filter((x) => x === "NFTREAD")).toHaveLength(2);
      if (mode === "prefix-after") expect(commands.filter((x) => x === "NFTREAD")).toHaveLength(1);
    }, mode);
  }
});
