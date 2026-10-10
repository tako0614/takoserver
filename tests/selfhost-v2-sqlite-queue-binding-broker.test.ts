import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function fixture() {
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
      { name: "AUX", resourceUid: "database-two" },
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
        if (input.resourceUid !== "database-one" && input.resourceUid !== "database-two")
          return null;
        return {
          createOperationId: `create-${input.resourceUid}`,
          resourceUid: input.resourceUid,
          principal: "alice",
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
  for (const uid of ["database-one", "database-two"]) {
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
    const original = host.store.withAuthorizedDatabase;
    host.store.withAuthorizedDatabase = async (input) =>
      await original({
        ...input,
        use: async (database) => {
          const result = await input.use(database);
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
    expect(await writing).toMatchObject({ rowsWritten: 1 });
    expect(await draining).toBe(true);
    expect(host.getCustody()).toMatchObject({ sqliteDrainState: "drained" });
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
