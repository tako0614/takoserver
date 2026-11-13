import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { canonicalDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import type { DockerContainerNativeIdentity } from "../src/providers/docker-container-runtime-preparation.ts";
import { createLinuxDockerCoreRuntime } from "../src/providers/linux-docker-core-runtime.ts";
import {
  type DockerPhysicalProcessOptions,
  observeDockerPhysicalGuestDrain,
  openDockerPhysicalProcess,
} from "../src/providers/linux-docker-physical-session.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";

const nativeId = "a".repeat(64);
const namespaceDevice = "4",
  namespaceInode = "200";
const table = `takos_cx_${nativeId.slice(0, 32)}`;
const identity = {
  nativeId,
  namespaceDevice,
  namespaceInode,
  fenceTable: `${table}_drain`,
  barrier: "unproven",
};
const flow = () => ({
  kind: "docker-guest-flow-snapshot@1",
  ...identity,
  tcp4: 0,
  udp4: 0,
  tcp6: 0,
  udp6: 0,
});
function options(signal = new AbortController().signal): DockerPhysicalProcessOptions {
  return {
    helper: "/synthetic/not-executed/helper",
    socketPath: "/synthetic/not-opened/docker.sock",
    peerPid: 1,
    peerUid: 0,
    networkId: "b".repeat(64),
    table,
    signal,
    nativeId,
    native: {
      ipBinary: "/synthetic/not-executed/ip",
      nftBinary: "/synthetic/not-executed/nft",
      guestNamespaceRoot: "/synthetic/not-opened/namespaces",
      guestFailClosed: true,
    },
  };
}
const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Only framed child stdio is doubled. The original private process closure,
 * descriptor/options validation, request sequencing and strict parser run. */
function rawStdio(
  replyTo: (command: string) => Promise<{ body: string; status?: number }> = async (command) => ({
    body: JSON.stringify(
      command === "DRAINBEGIN" ? { kind: "docker-guest-drain-fence@1", ...identity } : flow(),
    ),
  }),
) {
  const commands: string[] = [];
  let opened = 0,
    live = 0;
  const spawnStub = () => {
    opened++;
    live++;
    const child = new EventEmitter();
    const stdout = new PassThrough();
    let input = Buffer.alloc(0),
      ended = false,
      armed = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      live--;
      child.emit("close", 0, null);
    };
    const reply = (body: string, status = 0) => {
      if (ended) return;
      const bytes = Buffer.concat([Buffer.from([status]), Buffer.from(body)]);
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(bytes.length);
      const wire = Buffer.concat([prefix, bytes]);
      stdout.write(wire.subarray(0, 2));
      stdout.write(wire.subarray(2));
    };
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, done) {
        input = Buffer.concat([input, chunk]);
        while (input.length >= 4 && input.length >= input.readUInt32BE(0) + 4) {
          const length = input.readUInt32BE(0);
          const command = input.subarray(4, length + 4).toString("utf8");
          input = input.subarray(length + 4);
          commands.push(command);
          void (async () => {
            if (command === "CLOSE") {
              reply("{}");
              queueMicrotask(finish);
            } else if (command === "CURRENT") reply("{}");
            else if (command === "ARMGUEST") {
              armed = true;
              reply("{}");
            } else if (command === "DRAINBEGIN" && !armed) reply("drain_begin_refused", 1);
            else {
              const result = await replyTo(command);
              reply(result.body, result.status);
            }
          })();
        }
        done();
      },
      destroy(_error, done) {
        queueMicrotask(finish);
        done();
      },
    });
    queueMicrotask(() =>
      reply(
        JSON.stringify({
          kind: "docker-physical-session@1",
          peerPid: 1,
          peerUid: 0,
          captureOnly: false,
          nativeId,
          namespaceKind: "container",
          namespaceDevice,
          namespaceInode,
          parentDevice: "4",
          parentInode: "100",
        }),
      ),
    );
    // Raw ChildProcess IO shape only, never an owner/verification/runtime cast.
    return Object.assign(child, {
      stdin,
      stdout,
      kill: () => {
        finish();
        return true;
      },
    }) as unknown as childProcess.ChildProcess;
  };
  const installed = spyOn(childProcess, "spawn").mockImplementation(
    spawnStub as typeof importedSpawn,
  );
  if (!Object.is(installed, importedSpawn)) {
    installed.mockRestore();
    throw new Error("raw stdio interception unavailable");
  }
  return {
    commands,
    opened: () => opened,
    restore() {
      installed.mockRestore();
      expect(live).toBe(0);
    },
  };
}

test("private original channel observes fresh family counts without turning zero into retirement", async () => {
  let reads = 0;
  const raw = rawStdio(async (command) => ({
    body: JSON.stringify(
      command === "DRAINBEGIN"
        ? { kind: "docker-guest-drain-fence@1", ...identity }
        : { ...flow(), tcp4: reads++, udp6: reads - 1 },
    ),
  }));
  let physical: Awaited<ReturnType<typeof openDockerPhysicalProcess>> | undefined;
  try {
    await expect(observeDockerPhysicalGuestDrain({ current() {} })).rejects.toThrow();
    expect(raw.opened()).toBe(0);
    physical = await openDockerPhysicalProcess(options());
    const first = await observeDockerPhysicalGuestDrain(physical);
    expect(first).toMatchObject({ tcp4: 0, udp4: 0, tcp6: 0, udp6: 0, barrier: "unproven" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.hasOwn(first, "drained")).toBe(false);
    expect(await observeDockerPhysicalGuestDrain(physical)).toMatchObject({ tcp4: 1, udp6: 1 });
    await expect(physical.resumeGuestLifetime()).rejects.toThrow();
    const port = physical.port({ table, script: "synthetic script never sent" });
    await expect(
      port.execute({ argv: ["nft", "-f", "-"], stdin: "synthetic script never sent" }),
    ).rejects.toThrow();
    expect(raw.commands.filter((x) => x === "DRAINBEGIN")).toHaveLength(1);
    expect(raw.commands.filter((x) => x === "ARMGUEST")).toHaveLength(1);
    expect(raw.commands.filter((x) => x === "DRAINREAD")).toHaveLength(2);
    expect(raw.commands.includes("RESUMEGUEST")).toBe(false);
  } finally {
    await physical?.close();
    raw.restore();
  }
});

test("strict identity, barrier, counts and duplicate JSON refusals never supply a drain grant", async () => {
  const malformed = [
    { ...flow(), nativeId: "c".repeat(64) },
    { ...flow(), namespaceInode: "201" },
    { ...flow(), fenceTable: "foreign" },
    { ...flow(), barrier: "drained" },
    { ...flow(), tcp4: -1 },
    { ...flow(), udp6: 0.5 },
    { ...flow(), tcp6: Number.MAX_SAFE_INTEGER + 1 },
    { ...flow(), unexpected: true },
  ].map((value) => JSON.stringify(value));
  malformed.push(JSON.stringify(flow()).replace('"tcp4":0', '"tcp4":1,"tcp4":0'));
  for (const body of malformed) {
    const raw = rawStdio(async (command) => ({
      body:
        command === "DRAINBEGIN"
          ? JSON.stringify({ kind: "docker-guest-drain-fence@1", ...identity })
          : body,
    }));
    const physical = await openDockerPhysicalProcess(options());
    try {
      await expect(observeDockerPhysicalGuestDrain(physical)).rejects.toThrow();
      expect(raw.commands.filter((x) => x === "DRAINBEGIN")).toHaveLength(1);
    } finally {
      await physical.close();
      raw.restore();
    }
  }
});

test("unknown fence acknowledgement consumes mutation and prevents replay or resume", async () => {
  const raw = rawStdio(async () => ({ body: "synthetic unknown fence ACK", status: 1 }));
  const physical = await openDockerPhysicalProcess(options());
  try {
    await expect(observeDockerPhysicalGuestDrain(physical)).rejects.toThrow();
    await expect(observeDockerPhysicalGuestDrain(physical)).rejects.toThrow();
    await expect(physical.resumeGuestLifetime()).rejects.toThrow();
    expect(raw.commands.filter((x) => x === "DRAINBEGIN")).toHaveLength(1);
    expect(raw.commands.includes("DRAINREAD")).toBe(false);
  } finally {
    await physical.close();
    raw.restore();
  }
});

test("foreign successful fence reply consumes the attempt before any flow read or retry", async () => {
  const raw = rawStdio(async () => ({
    body: JSON.stringify({
      kind: "docker-guest-drain-fence@1",
      ...identity,
      namespaceInode: "foreign",
    }),
  }));
  const physical = await openDockerPhysicalProcess(options());
  try {
    await expect(observeDockerPhysicalGuestDrain(physical)).rejects.toThrow();
    await expect(observeDockerPhysicalGuestDrain(physical)).rejects.toThrow();
    await expect(physical.resumeGuestLifetime()).rejects.toThrow();
    expect(raw.commands.filter((x) => x === "DRAINBEGIN")).toHaveLength(1);
    expect(raw.commands.includes("DRAINREAD")).toBe(false);
  } finally {
    await physical.close();
    raw.restore();
  }
});

test("cancellation during native collection rejects and joins original child stdio", async () => {
  const entered = deferred(),
    release = deferred();
  const raw = rawStdio(async (command) => {
    if (command === "DRAINREAD") {
      entered.resolve();
      await release.promise;
    }
    return {
      body: JSON.stringify(
        command === "DRAINBEGIN" ? { kind: "docker-guest-drain-fence@1", ...identity } : flow(),
      ),
    };
  });
  const controller = new AbortController();
  const physical = await openDockerPhysicalProcess(options(controller.signal));
  try {
    const running = observeDockerPhysicalGuestDrain(physical);
    await entered.promise;
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(raw.commands.filter((x) => x === "DRAINREAD")).toHaveLength(1);
  } finally {
    release.resolve();
    await physical.close();
    raw.restore();
  }
});

test("original Core refusal and runtime close retain the full first SQL scope before any native open", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const base = createSqliteSql(database);
  await base.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await base.batch(v2ContainerOwnerMigrationCandidate());
  const entered = deferred(),
    release = deferred();
  let gated = false;
  const sql: Sql = {
    async query(statement, params) {
      if (!gated) {
        gated = true;
        entered.resolve();
        await release.promise;
      }
      return base.query(statement, params);
    },
    run: base.run.bind(base),
    batch: base.batch.bind(base),
  };
  const core = createLinuxDockerCoreRuntime({
    sql,
    clock: () => new Date(),
    installationId: "synthetic-drain-owner",
    backendId: "synthetic-drain-backend",
    targetKey: "synthetic-drain-target",
  });
  const runtime = core.createRuntime({
    policy: {
      tenantRef: "synthetic-drain-parent",
      generation: 1,
      policyDigest: `sha256:${"1".repeat(64)}`,
      outboundInternet: true,
    },
    requiredSecretNames: [],
    process: {
      helper: "/synthetic/not-executed/helper",
      socketPath: "/synthetic/not-opened/docker.sock",
      peerPid: 1,
      peerUid: 0,
      ipBinary: "/synthetic/not-executed/ip",
      nftBinary: "/synthetic/not-executed/nft",
      guestNamespaceRoot: "/synthetic/not-opened/namespaces",
    },
    host: { tcpPorts: [8080], conntrackMark: 1, deniedDestinations: [] },
    dnsServers: ["192.0.2.53"],
    maxConnections: 4,
    packetLimitBytes: 4096,
  });
  const resourceUid = crypto.randomUUID(),
    incarnationId = crypto.randomUUID(),
    revision = `1-${"1".repeat(64)}`;
  const native: DockerContainerNativeIdentity = {
    backend: "docker",
    installationId: "synthetic-drain-owner",
    resourceUid,
    incarnationId,
    revision,
    nativeId,
    network: "synthetic-network",
    networkId: "b".repeat(64),
    image: `registry.example/app@sha256:${"1".repeat(64)}`,
    imageId: `sha256:${"1".repeat(64)}`,
    identityLabel: await canonicalDigest({
      installation: "synthetic-drain-owner",
      resource: resourceUid,
      incarnation: incarnationId,
      revision,
    }),
    revisionLabel: await canonicalDigest({ revision }),
  };
  const raw = rawStdio();
  try {
    const running = runtime.observeRetainedFlows(native);
    await entered.promise;
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(raw.opened()).toBe(0);
    release.resolve();
    await expect(running).rejects.toThrow(); // No accepted record/claim is invented.
    await closing;
    expect(closed).toBe(true);
    await expect(runtime.observeRetainedFlows(native)).rejects.toThrow();
    expect(raw.opened()).toBe(0);
  } finally {
    release.resolve();
    await runtime.close();
    raw.restore();
    database.close();
  }
});
