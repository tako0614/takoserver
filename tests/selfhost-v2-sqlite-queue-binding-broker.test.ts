import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createSelfhostV2SqliteQueueBindingBroker,
  type V2QueueSQLiteGrant,
  type V2QueueSQLiteProofPort,
  type V2QueueSQLiteSelectedBindings,
} from "../src/providers/selfhost-v2-sqlite-queue-binding-broker.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import type { V2QueueBatchSQLiteCustody } from "../src/queue-v2-batch-custody-contract.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";

const targetKey = "queue-sqlite-node-target";
const terminal = {
  kind: "handler_and_wait_until" as const,
  receiptDigest: "a".repeat(64),
};

function sameShardAs(uid: string): string {
  const shard = createHash("sha256").update(uid).digest("hex").slice(0, 2);
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = `database-collision-${index}`;
    if (
      candidate !== uid &&
      createHash("sha256").update(candidate).digest("hex").slice(0, 2) === shard
    )
      return candidate;
  }
  throw new Error("missing deterministic shard collision");
}

async function fixture(auxUid = "database-two") {
  const root = mkdtempSync(join(tmpdir(), "v2-queue-sqlite-node-"));
  const nativeRoot = join(root, "native");
  const execution = {
    batchId: "batch-one",
    reservationToken: "reservation-one",
    queueUid: "queue-one",
    consumerUid: "consumer-one",
    generation: 1,
    workerUid: "worker-one",
    servingSourceOperationId: "deployment-operation-one",
    workerVersionUid: "version-one",
    workerVersionGeneration: 1,
    incarnationOperationId: "incarnation-one",
  };
  const grant: V2QueueSQLiteGrant = {
    execution,
    principal: "alice",
    space: "default",
    targetKey,
    versionOperationId: "version-operation-one",
    nativeVersionId: "native-version-one",
    bindings: [
      { name: "DB", resourceUid: "database-one" },
      { name: "AUX", resourceUid: auxUid },
    ],
  };
  let custody: V2QueueBatchSQLiteCustody = {
    kind: "found",
    principal: grant.principal,
    space: grant.space,
    targetKey,
    sqliteDrainState: "pending",
    sqliteDrainReceiptDigest: null,
    terminal: null,
    retirement: null,
  };
  let selected: V2QueueSQLiteSelectedBindings | null = {
    versionOperationId: grant.versionOperationId,
    principal: grant.principal,
    space: grant.space,
    targetKey,
    workerUid: execution.workerUid,
    workerVersionUid: execution.workerVersionUid,
    workerVersionGeneration: execution.workerVersionGeneration,
    bindings: grant.bindings,
  };
  let primaryAvailable = true;
  let lostDrainAck = false;
  let inspectNativeThroughSameStore = false;
  let inspectedNativeUid: string | null = null;
  let acceptedCreatePrincipal = "alice";
  const storeOptions = {
    root: nativeRoot,
    targetKey,
    proofs: {
      async currentClaim(input: { readonly operationId: string; readonly resourceUid: string }) {
        return {
          ...createClaim(input.resourceUid),
          leaseUntilMs: Date.now() + 60_000,
        };
      },
      async acceptedCreate(input: { readonly resourceUid: string }) {
        if (input.resourceUid !== "database-one" && input.resourceUid !== auxUid) return null;
        return {
          createOperationId: `create-${input.resourceUid}`,
          resourceUid: input.resourceUid,
          principal: acceptedCreatePrincipal,
          space: "default",
          backendId: "sqlite-backend",
          targetKey,
        };
      },
    },
  };
  function createClaim(resourceUid: string) {
    return {
      operationId: `create-${resourceUid}`,
      leaseToken: `lease-${resourceUid}`,
      backendKey: "sqlite-backend-key",
      backendId: "sqlite-backend",
      targetKey,
      resourceUid,
      principal: "alice",
      action: "create" as const,
      generation: 1,
      form: SQLITE_DATABASE_FORM_URL,
      space: "default",
      name: resourceUid,
    };
  }
  const store = createSelfhostV2SQLiteStore(storeOptions);
  for (const uid of new Set(["database-one", auxUid])) {
    expect(await store.ensureCreated(createClaim(uid))).toBe("present");
  }
  await store.withAuthorizedDatabase({
    resourceUid: "database-one",
    stillAuthorized: async () => true,
    use(database) {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    },
  });
  const proofs = {
    async readCustody() {
      return primaryAvailable ? custody : ({ kind: "unknown" } as const);
    },
    async readSelectedBindings() {
      return primaryAvailable ? selected : null;
    },
    async resolveCurrentBinding(_grant: V2QueueSQLiteGrant, name: string) {
      const binding = grant.bindings.find((item) => item.name === name);
      return primaryAvailable && binding
        ? { resourceUid: binding.resourceUid, vector: "settled-vector-one" }
        : null;
    },
    async observeNative() {
      if (inspectNativeThroughSameStore) {
        const inspected = inspectedNativeUid
          ? [inspectedNativeUid]
          : [...new Set(grant.bindings.map((binding) => binding.resourceUid))];
        for (const resourceUid of inspected) {
          if (
            (await store.inspectOwnedDatabase({
              resourceUid,
              stillAuthorized: async () => true,
            })) !== "confirmed"
          )
            return { kind: "unknown" as const };
        }
      }
      return primaryAvailable
        ? {
            kind: "confirmed" as const,
            workerUid: execution.workerUid,
            versionId: grant.nativeVersionId,
            incarnationId: execution.incarnationOperationId,
            servingSourceOperationId: execution.servingSourceOperationId,
            status: "active" as const,
          }
        : ({ kind: "unknown" } as const);
    },
    async observeNativeWithPhysicalFence(
      _grant: V2QueueSQLiteGrant,
      physical: {
        assertHeld(): void;
      },
    ) {
      physical.assertHeld();
      return primaryAvailable
        ? {
            kind: "confirmed" as const,
            workerUid: execution.workerUid,
            versionId: grant.nativeVersionId,
            incarnationId: execution.incarnationOperationId,
            servingSourceOperationId: execution.servingSourceOperationId,
            status: "active" as const,
          }
        : ({ kind: "unknown" } as const);
    },
    async confirmDrained(input: Parameters<V2QueueSQLiteProofPort["confirmDrained"]>[0]) {
      if (
        !primaryAvailable ||
        custody.kind !== "found" ||
        custody.sqliteDrainState !== "pending" ||
        custody.terminal?.kind !== input.terminal.kind ||
        custody.terminal.receiptDigest !== input.terminal.receiptDigest
      )
        return false;
      custody = {
        ...custody,
        sqliteDrainState: "drained",
        sqliteDrainReceiptDigest: input.receiptDigest,
      };
      if (lostDrainAck) throw new Error("lost D1 acknowledgement");
      return true;
    },
  };
  return {
    grant,
    store,
    nativeRoot,
    proofs,
    makeBroker: (otherStore = store) =>
      createSelfhostV2SqliteQueueBindingBroker({ store: otherStore, proofs }),
    setTerminal() {
      if (custody.kind !== "found") throw new Error("missing custody");
      custody = { ...custody, terminal };
    },
    setRetirement() {
      if (custody.kind !== "found") throw new Error("missing custody");
      custody = { ...custody, retirement: terminal };
    },
    setAcceptedCreatePrincipal(value: string) {
      acceptedCreatePrincipal = value;
    },
    setDrainState(value: "pending" | null) {
      if (custody.kind !== "found") throw new Error("missing custody");
      custody = { ...custody, sqliteDrainState: value };
    },
    setSelected(value: V2QueueSQLiteSelectedBindings | null) {
      selected = value;
    },
    getSelected() {
      return selected;
    },
    setPrimaryAvailable(value: boolean) {
      primaryAvailable = value;
    },
    loseDrainAck() {
      lostDrainAck = true;
    },
    inspectNativeThroughSameStore(onlyUid?: string) {
      inspectNativeThroughSameStore = true;
      inspectedNativeUid = onlyUid ?? null;
    },
    getCustody() {
      return custody;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
    createSecondStore() {
      return createSelfhostV2SQLiteStore(storeOptions);
    },
  };
}

test("Queue SQL native owner proof can re-enter the same UID store while SQL is fenced", async () => {
  const host = await fixture();
  try {
    host.inspectNativeThroughSameStore();
    expect(
      await host.makeBroker().call({
        grant: host.grant,
        binding: "DB",
        method: "execute",
        statement: { sql: "INSERT INTO records(body) VALUES ('reentrant-native-proof')" },
      }),
    ).toMatchObject({ rowsWritten: 1 });
  } finally {
    host.cleanup();
  }
});

test("Queue SQL refuses a composition without its restricted in-lock proof port", async () => {
  const host = await fixture();
  try {
    expect(() =>
      createSelfhostV2SqliteQueueBindingBroker({
        store: host.store,
        proofs: {
          ...host.proofs,
          observeNativeWithPhysicalFence: undefined as never,
        },
      }),
    ).toThrow("trusted Queue SQLite Node proof ports are required");
  } finally {
    host.cleanup();
  }
});

for (const auxUid of ["database-one", sameShardAs("database-one")]) {
  test(`Queue SQL fences complete selected physical set with alias/shard UID ${auxUid}`, async () => {
    const host = await fixture(auxUid);
    try {
      host.inspectNativeThroughSameStore(auxUid);
      expect(
        await host.makeBroker().call({
          grant: host.grant,
          binding: "DB",
          method: "execute",
          statement: { sql: "INSERT INTO records(body) VALUES ('whole-set')" },
        }),
      ).toMatchObject({ rowsWritten: 1 });
      host.setAcceptedCreatePrincipal("mallory");
      await expect(
        host.makeBroker().call({
          grant: host.grant,
          binding: "DB",
          method: "execute",
          statement: { sql: "INSERT INTO records(body) VALUES ('forbidden')" },
        }),
      ).rejects.toMatchObject({ code: "backend_unavailable" });
    } finally {
      host.cleanup();
    }
  });
}

test("Queue store releases every shard and revokes its physical witness after an unknown", async () => {
  const host = await fixture();
  try {
    let heldWitness:
      | Parameters<V2QueueSQLiteProofPort["observeNativeWithPhysicalFence"]>[1]
      | null = null;
    await expect(
      host.store.withVerifiedDatabaseSet({
        resourceUid: "database-one",
        principal: "alice",
        space: "default",
        bindings: [...host.grant.bindings].reverse(),
        stillAuthorized: async (physical) => {
          heldWitness = physical;
          physical.assertHeld();
          throw new Error("unknown native readback");
        },
        use: async () => {
          throw new Error("unreachable SQL");
        },
      }),
    ).rejects.toThrow("unknown native readback");
    expect(() => heldWitness?.assertHeld()).toThrow("backend_unavailable");
    for (const binding of host.grant.bindings) {
      expect(
        await host.store.inspectOwnedDatabase({
          resourceUid: binding.resourceUid,
          stillAuthorized: async () => true,
        }),
      ).toBe("confirmed");
    }
  } finally {
    host.cleanup();
  }
});

test("Queue physical-set locks use canonical shard order and release an earlier shard on failure", async () => {
  const host = await fixture();
  const entries = host.grant.bindings.map(({ resourceUid }) => ({
    resourceUid,
    shard: createHash("sha256").update(resourceUid).digest("hex").slice(0, 2),
  }));
  entries.sort((left, right) => left.shard.localeCompare(right.shard));
  const first = entries[0];
  const second = entries[1];
  if (!first || !second || first.shard === second.shard) throw new Error("invalid shard fixture");
  const blocker = new DatabaseSync(join(host.nativeRoot, "locks", `${second.shard}.sqlite`));
  try {
    blocker.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    await expect(
      host.store.withVerifiedDatabaseSet({
        resourceUid: "database-one",
        principal: "alice",
        space: "default",
        bindings: [...host.grant.bindings].reverse(),
        stillAuthorized: async () => true,
        use: async () => {
          throw new Error("unreachable SQL");
        },
      }),
    ).rejects.toMatchObject({ code: "busy" });
    // The first shard was acquired before the deliberately blocked second one
    // and must already be released on the failed nested acquisition.
    expect(
      await host.store.inspectOwnedDatabase({
        resourceUid: first.resourceUid,
        stillAuthorized: async () => true,
      }),
    ).toBe("confirmed");
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    host.cleanup();
  }
});

test("Queue SQL rechecks terminal, retirement, sealed set and vector after the full pre-lock proof", async () => {
  for (const changed of ["terminal", "retirement", "selected", "vector"] as const) {
    const host = await fixture();
    try {
      if (changed === "vector") {
        const originalCurrent = host.proofs.resolveCurrentBinding;
        let reads = 0;
        host.proofs.resolveCurrentBinding = async (...args) => {
          reads += 1;
          return reads === 1
            ? await originalCurrent(...args)
            : { resourceUid: "database-one", vector: "changed-vector" };
        };
      }
      const originalNative = host.proofs.observeNative;
      host.proofs.observeNative = async () => {
        const result = await originalNative();
        if (changed === "terminal") host.setTerminal();
        if (changed === "retirement") host.setRetirement();
        if (changed === "selected") {
          const selected = host.getSelected();
          if (!selected) throw new Error("missing selected fixture");
          host.setSelected({ ...selected, bindings: selected.bindings.slice(0, 1) });
        }
        return result;
      };
      await expect(
        host.makeBroker().call({
          grant: host.grant,
          binding: "DB",
          method: "execute",
          statement: { sql: "INSERT INTO records(body) VALUES ('forbidden')" },
        }),
      ).rejects.toMatchObject({ code: "backend_unavailable" });
      await host.store.withAuthorizedDatabase({
        resourceUid: "database-one",
        stillAuthorized: async () => true,
        use(database) {
          expect(database.prepare("SELECT count(*) AS count FROM records").get()).toEqual({
            count: 0,
          });
        },
      });
    } finally {
      host.cleanup();
    }
  }
});

test("Queue SQL refuses an in-lock native change before SQL and reports post-commit change as unknown", async () => {
  for (const failAt of [2, 3]) {
    const host = await fixture();
    try {
      const original = host.proofs.observeNativeWithPhysicalFence;
      let reads = 0;
      host.proofs.observeNativeWithPhysicalFence = async (...args) => {
        reads += 1;
        return reads === failAt ? { kind: "unknown" as const } : await original(...args);
      };
      await expect(
        host.makeBroker().call({
          grant: host.grant,
          binding: "DB",
          method: "execute",
          statement: { sql: "INSERT INTO records(body) VALUES ('single-attempt')" },
        }),
      ).rejects.toMatchObject({ code: "backend_unavailable" });
      expect(reads).toBe(failAt);
      await host.store.withAuthorizedDatabase({
        resourceUid: "database-one",
        stillAuthorized: async () => true,
        use(database) {
          expect(database.prepare("SELECT count(*) AS count FROM records").get()).toEqual({
            count: failAt === 2 ? 0 : 1,
          });
        },
      });
    } finally {
      host.cleanup();
    }
  }
});

test("Queue SQL refuses aborted or expired calls before any SQL effect", async () => {
  const host = await fixture();
  try {
    for (const control of [{ signal: AbortSignal.abort() }, { deadlineAtMs: Date.now() - 1 }]) {
      await expect(
        host.makeBroker().call({
          grant: host.grant,
          binding: "DB",
          method: "execute",
          statement: { sql: "INSERT INTO records(body) VALUES ('forbidden')" },
          ...control,
        }),
      ).rejects.toMatchObject({ code: "backend_unavailable" });
    }
    const abort = new AbortController();
    const original = host.proofs.observeNativeWithPhysicalFence;
    host.proofs.observeNativeWithPhysicalFence = async (...args) => {
      const observed = await original(...args);
      abort.abort();
      return observed;
    };
    await expect(
      host.makeBroker().call({
        grant: host.grant,
        binding: "DB",
        method: "execute",
        statement: { sql: "INSERT INTO records(body) VALUES ('forbidden')" },
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    await host.store.withAuthorizedDatabase({
      resourceUid: "database-one",
      stillAuthorized: async () => true,
      use(database) {
        expect(database.prepare("SELECT count(*) AS count FROM records").get()).toEqual({
          count: 0,
        });
      },
    });
  } finally {
    host.cleanup();
  }
});

test("Queue SQL refuses an unarmed batch, missing primary proof, or incomplete selected bindings", async () => {
  const host = await fixture();
  try {
    const broker = host.makeBroker();
    const call = () =>
      broker.call({
        grant: host.grant,
        binding: "DB",
        method: "execute",
        statement: { sql: "INSERT INTO records(body) VALUES ('forbidden')" },
      });
    host.setDrainState(null);
    await expect(call()).rejects.toMatchObject({ code: "backend_unavailable" });
    host.setDrainState("pending");
    host.setPrimaryAvailable(false);
    await expect(call()).rejects.toMatchObject({ code: "backend_unavailable" });
    host.setPrimaryAvailable(true);
    const selected = host.getSelected();
    if (!selected) throw new Error("missing selected fixture");
    host.setSelected({ ...selected, bindings: selected.bindings.slice(0, 1) });
    await expect(call()).rejects.toMatchObject({ code: "backend_unavailable" });
    await host.store.withAuthorizedDatabase({
      resourceUid: "database-one",
      stillAuthorized: async () => true,
      use(database) {
        expect(database.prepare("SELECT count(*) AS count FROM records").get()).toEqual({
          count: 0,
        });
      },
    });
  } finally {
    host.cleanup();
  }
});

test("Queue SQL uses the real UID store, then terminal fences late SQL and restart drains all UIDs", async () => {
  const host = await fixture();
  try {
    const broker = host.makeBroker();
    expect(
      await broker.call({
        grant: host.grant,
        binding: "DB",
        method: "execute",
        statement: { sql: "INSERT INTO records(body) VALUES (?)", params: ["written"] },
      }),
    ).toMatchObject({ rowsWritten: 1 });
    host.setTerminal();
    await expect(
      broker.call({
        grant: host.grant,
        binding: "DB",
        method: "query",
        statement: { sql: "SELECT body FROM records" },
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    // The second store is a restarted Node owner on the same durable root.
    const secondStore = host.createSecondStore();
    const originalRecover = secondStore.recoverOwnedDatabase;
    const recovered: string[] = [];
    secondStore.recoverOwnedDatabase = async (uid) => {
      recovered.push(uid);
      return await originalRecover(uid);
    };
    const restarted = host.makeBroker(secondStore);
    expect(await restarted.drain(host.grant, terminal)).toBe(true);
    expect(recovered).toEqual(["database-one", "database-two"]);
    expect(host.getCustody()).toMatchObject({ sqliteDrainState: "drained" });
    expect(await restarted.drain(host.grant, terminal)).toBe(true);
    expect(
      await restarted.drain(
        {
          ...host.grant,
          bindings: [...host.grant.bindings].reverse(),
          execution: {
            incarnationOperationId: host.grant.execution.incarnationOperationId,
            workerVersionGeneration: host.grant.execution.workerVersionGeneration,
            workerVersionUid: host.grant.execution.workerVersionUid,
            servingSourceOperationId: host.grant.execution.servingSourceOperationId,
            workerUid: host.grant.execution.workerUid,
            generation: host.grant.execution.generation,
            consumerUid: host.grant.execution.consumerUid,
            queueUid: host.grant.execution.queueUid,
            reservationToken: host.grant.execution.reservationToken,
            batchId: host.grant.execution.batchId,
          },
        },
        { receiptDigest: terminal.receiptDigest, kind: terminal.kind },
      ),
    ).toBe(true);
    await host.store.withAuthorizedDatabase({
      resourceUid: "database-one",
      stillAuthorized: async () => true,
      use(database) {
        expect(database.prepare("SELECT body FROM records").get()).toMatchObject({
          body: "written",
        });
      },
    });
  } finally {
    host.cleanup();
  }
});

test("Queue drain waits for the exact in-flight Node SQL call to close before confirming", async () => {
  const host = await fixture();
  try {
    let committed!: () => void;
    let release!: () => void;
    const afterCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = host.store.withVerifiedDatabaseSet;
    host.store.withVerifiedDatabaseSet = async (input) =>
      await original({
        ...input,
        use: async (database, physical) => {
          const result = await input.use(database, physical);
          committed();
          await held;
          return result;
        },
      });
    const broker = host.makeBroker();
    const writing = broker.call({
      grant: host.grant,
      binding: "DB",
      method: "execute",
      statement: { sql: "INSERT INTO records(body) VALUES ('before-close')" },
    });
    await afterCommit;
    host.setTerminal();
    let drained = false;
    const draining = broker.drain(host.grant, terminal).then((result) => {
      drained = result;
      return result;
    });
    await Bun.sleep(30);
    expect(drained).toBe(false);
    expect(host.getCustody()).toMatchObject({ sqliteDrainState: "pending" });
    release();
    // The SQL committed before terminal, but the post-unlock full native read
    // now sees terminal. This is an unknown effect, never a retry permission.
    await expect(writing).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(await draining).toBe(true);
    expect(host.getCustody()).toMatchObject({ sqliteDrainState: "drained" });
    await host.store.withAuthorizedDatabase({
      resourceUid: "database-one",
      stillAuthorized: async () => true,
      use(database) {
        expect(database.prepare("SELECT body FROM records").get()).toMatchObject({
          body: "before-close",
        });
      },
    });
  } finally {
    host.cleanup();
  }
});

test("Queue drain survives process death and recovers an uncommitted UID journal", async () => {
  const host = await fixture();
  const source = new URL("../src/providers/selfhost-v2-sqlite-store.ts", import.meta.url).href;
  const childCode = `
    const { createSelfhostV2SQLiteStore } = await import(${JSON.stringify(source)});
    const store = createSelfhostV2SQLiteStore({
      root: ${JSON.stringify(host.nativeRoot)}, targetKey: ${JSON.stringify(targetKey)},
      proofs: {
        currentClaim: async () => null,
        acceptedCreate: async ({ resourceUid }) => ({
          createOperationId: 'create-' + resourceUid,
          resourceUid, principal: 'alice', space: 'default',
          backendId: 'sqlite-backend', targetKey: ${JSON.stringify(targetKey)}
        })
      }
    });
    await store.withInvocationLock('queue:batch-one', async () => {
      await store.withAuthorizedDatabase({
        resourceUid: 'database-one', stillAuthorized: async () => true,
        use: async (database) => {
          database.exec("BEGIN IMMEDIATE; INSERT INTO records(body) VALUES ('rolled-back')");
          console.log('sql-open');
          await new Promise(() => {});
        }
      });
    });
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", childCode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("sql-open");
    host.setTerminal();
    const draining = host.makeBroker(host.createSecondStore()).drain(host.grant, terminal);
    await Bun.sleep(30);
    expect(host.getCustody()).toMatchObject({ sqliteDrainState: "pending" });
    child.kill("SIGKILL");
    await child.exited;
    expect(await draining).toBe(true);
    await host.store.withAuthorizedDatabase({
      resourceUid: "database-one",
      stillAuthorized: async () => true,
      use(database) {
        expect(database.prepare("SELECT count(*) AS count FROM records").get()).toEqual({
          count: 0,
        });
      },
    });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    host.cleanup();
  }
});

test("Queue drain refuses missing primary proof, incomplete/foreign binding sets, and replays lost CAS ACK", async () => {
  const host = await fixture();
  try {
    const broker = host.makeBroker();
    host.setTerminal();
    host.setPrimaryAvailable(false);
    expect(await broker.drain(host.grant, terminal)).toBe(false);
    host.setPrimaryAvailable(true);
    const selected = host.getSelected();
    if (!selected) throw new Error("missing selected fixture");
    const firstBinding = selected.bindings[0];
    if (!firstBinding) throw new Error("missing first fixture binding");
    host.setSelected({ ...selected, bindings: selected.bindings.slice(0, 1) });
    expect(await broker.drain(host.grant, terminal)).toBe(false);
    host.setSelected({
      ...selected,
      bindings: [firstBinding, { name: "AUX", resourceUid: "foreign-db" }],
    });
    expect(await broker.drain(host.grant, terminal)).toBe(false);
    host.setSelected(selected);
    host.loseDrainAck();
    expect(await broker.drain(host.grant, terminal)).toBe(true);
    expect(host.getCustody()).toMatchObject({ sqliteDrainState: "drained" });
  } finally {
    host.cleanup();
  }
});
