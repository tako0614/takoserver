import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfhostV2SqliteBindingBroker,
  type V2SqliteInvocationAuthority,
} from "../src/providers/selfhost-v2-sqlite-binding-broker.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { v2SqliteWorkerProjection } from "../src/providers/selfhost-v2-sqlite-worker-projection.ts";
import {
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
} from "../src/providers/selfhost-worker-wrapper.ts";
import {
  WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING,
  WORKERD_V2_PRIVATE_QUEUE_SETTLEMENT_BINDING,
  WORKERD_V2_PRIVATE_READINESS_BINDING,
} from "../src/providers/workerd-v2-private-binding-names.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import { createSQLiteWorkerBindingAuthority } from "../src/takoform-v2/forms/sqlite-worker-binding-authority.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const TARGET = "sqlite-binding-target";
const BUNDLE_FORM = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";
const WORKERD = nativeEvidenceBinary("workerd-artifact");

async function fixture(bindingName = "DB", invocationScoped = false) {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-binding-"));
  const stagingRoot = join(root, "sql-input-staging");
  mkdirSync(stagingRoot, { mode: 0o700 });
  const control = new Database(join(root, "control.sqlite"));
  control.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ]) {
    control.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = createSqliteSql(control);
  const store = createSelfhostV2SQLiteStore({ root: join(root, "native"), sql, targetKey: TARGET });
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 120,
    leaseMilliseconds: 1_000,
    forms: { [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store }) },
    async authorize() {
      return true;
    },
  });
  const created = await engine.acceptCreate({
    principal: "alice",
    key: "sqlite-binding-create-0001",
    input: { form: SQLITE_DATABASE_FORM_URL, space: "default", name: "db", spec: {} },
  });
  expect((await engine.runNext())?.status).toBe("succeeded");
  const databaseUid = created.resourceUid;
  await store.withAuthorizedDatabase({
    resourceUid: databaseUid,
    stillAuthorized: async () => true,
    use(database) {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    },
  });
  function settled(uid: string, form: string, name: string) {
    control
      .prepare(`INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key, active_name,
       generation, observed_generation, phase, spec_json, observed_json, last_operation)
      VALUES (?, 'alice', ?, 'default', ?, 'worker-backend', ?, ?, 1, 1, 'idle', '{}',
        '{"ready":true}', ?)`)
      .run(uid, form, name, TARGET, name, `op-${uid}`);
    control
      .prepare(`INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
       created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
      VALUES (?,?,'alice',?,'fp','create',1,'succeeded','complete',
       '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',
       'worker-backend',?,?,'{}')`)
      .run(`op-${uid}`, uid, `replay-${uid}`, TARGET, `key-${uid}`);
  }
  settled("worker-one", MODULE_WORKER_FORM_URL, "worker");
  settled("bundle-one", BUNDLE_FORM, "bundle");
  const spec = JSON.stringify({
    worker: { resourceUid: "worker-one" },
    bundle: { resourceUid: "bundle-one" },
    handlers: ["fetch"],
    sqliteBindings: [{ name: bindingName, resource: { resourceUid: databaseUid } }],
  });
  control
    .prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,last_operation,busy_operation)
    VALUES ('version-one','alice',?,'default','version','worker-backend',?,'version',
      1,0,'pending',?,'op-version-one','op-version-one')`)
    .run(WORKER_VERSION_FORM_URL, TARGET, spec);
  control
    .prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES ('op-version-one','version-one','alice','replay-version','fp','create',1,
      'queued','none','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z',
      '2026-10-08T00:00:00Z','worker-backend',?,'key-version',?)`)
    .run(TARGET, spec);
  control.exec(
    "INSERT INTO tf_v2_operation_reference_sets (operation_id, sealed) VALUES ('op-version-one', 0)",
  );
  const referenceTargets: [string, string][] = [
    ["worker-one", MODULE_WORKER_FORM_URL],
    ["bundle-one", BUNDLE_FORM],
    [databaseUid, SQLITE_DATABASE_FORM_URL],
  ];
  for (const [uid, form] of referenceTargets) {
    control
      .prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness) VALUES ('op-version-one',?,?,'observed')`)
      .run(uid, form);
  }
  control.exec(
    "UPDATE tf_v2_operation_reference_sets SET sealed=1 WHERE operation_id='op-version-one'",
  );
  control.exec("UPDATE tf_v2_operations SET status='running' WHERE id='op-version-one'");
  control.exec(
    "UPDATE tf_v2_operations SET status='reconciling', effect='unknown' WHERE id='op-version-one'",
  );
  control.exec(`UPDATE tf_v2_operations SET status='succeeded', effect='complete',
    result_observed_json='{"ready":true,"resolvedBindings":true,"bundleVerified":true}'
    WHERE id='op-version-one'`);
  const invocation = invocationScoped
    ? {
        handle: { invocationId: "invocation-one", custodyToken: "custody-token-one-0001" },
        expected: {
          backendId: "worker-backend",
          targetKey: TARGET,
          principal: "alice",
          space: "default",
          workerUid: "worker-one",
          deploymentUid: "deployment-one",
          deploymentGeneration: 1,
          sourceOperationId: "source-operation-one",
          ingress: {
            kind: "endpoint" as const,
            endpointUid: "endpoint-one",
            endpointGeneration: 1,
          },
          versionUid: "version-one",
          versionGeneration: 1,
          versionOperationId: "op-version-one",
          nativeIdentity: "native-identity-one",
          closureDigest: `sha256:${"a".repeat(64)}` as const,
          confirmedReceipt: "confirmed-receipt-one",
        },
      }
    : undefined;
  const grant = {
    principal: "alice",
    space: "default",
    targetKey: TARGET,
    workerUid: "worker-one",
    workerVersionUid: "version-one",
    nativeVersionId: "v2-native-one",
    incarnationId: "incarnation-one",
    servingSourceOperationId: "source-operation-one",
    bindings: [{ name: bindingName, resourceUid: databaseUid }],
    ...(invocation ? { invocation } : {}),
  };
  let nativeCurrent = true;
  let graphCurrent = true;
  let retirement: { retiredAtMs: number; receiptDigest: `sha256:${string}` } | null = null;
  let drainState: "pending" | "drained" = "pending";
  let drainReceiptDigest: `sha256:${string}` | null = null;
  let loseDrainAck = false;
  let readCount = 0;
  let readHook: ((count: number) => Promise<void>) | undefined;
  let proofPatch: {
    space?: string;
    targetKey?: string;
    versionGeneration?: number;
    noNativeDispatchAtMs?: number;
  } = {};
  const invocationAuthority: V2SqliteInvocationAuthority | undefined = invocation
    ? {
        async read() {
          readCount += 1;
          await readHook?.(readCount);
          return {
            ...invocation.expected,
            handle: invocation.handle,
            phase: "send_authorized",
            bodyState: null,
            noNativeDispatchAtMs: null,
            retirement,
            sqliteDrainState: drainState,
            sqliteDrainReceiptDigest: drainReceiptDigest,
            ...proofPatch,
          };
        },
        async confirmSQLiteDrained(input) {
          if (
            !retirement ||
            drainState !== "pending" ||
            input.handle.invocationId !== invocation.handle.invocationId ||
            input.handle.custodyToken !== invocation.handle.custodyToken
          )
            return false;
          drainState = "drained";
          drainReceiptDigest = input.receiptDigest;
          if (loseDrainAck) {
            loseDrainAck = false;
            return false;
          }
          return true;
        },
      }
    : undefined;
  const authority = createSQLiteWorkerBindingAuthority({ sql, targetKey: TARGET });
  const broker = createSelfhostV2SqliteBindingBroker({
    store,
    stagingRoot,
    signingKey: new Uint8Array(32).fill(7),
    ...(invocationAuthority ? { invocationAuthority } : {}),
    resolveCurrentBinding: authority.resolveCurrentBinding,
    async observeVersionTarget(input) {
      return nativeCurrent
        ? { kind: "confirmed" as const, ...input, status: "active" as const }
        : { kind: "unknown" as const };
    },
    async graphStillCurrent() {
      return graphCurrent;
    },
  });
  const token = broker.issueGrant(grant);
  async function call(op: string, statement?: unknown, binding = bindingName) {
    const request = new Request(`http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ protocol: SELFHOST_DATA_PLANE_PROTOCOL, binding, op, statement }),
    });
    const response = await broker.handle(request);
    return response ? await response.json() : null;
  }
  return {
    root,
    control,
    sql,
    store,
    engine,
    databaseUid,
    broker,
    grant,
    token,
    setReadHook(hook: ((count: number) => Promise<void>) | undefined) {
      readHook = hook;
    },
    setProofPatch(patch: typeof proofPatch) {
      proofPatch = patch;
    },
    readCount() {
      return readCount;
    },
    retire() {
      retirement = { retiredAtMs: 1, receiptDigest: `sha256:${"b".repeat(64)}` };
    },
    changeRetirementDigest() {
      retirement = { retiredAtMs: 1, receiptDigest: `sha256:${"c".repeat(64)}` };
    },
    drained() {
      return drainState === "drained";
    },
    loseNextDrainAck() {
      loseDrainAck = true;
    },
    call,
    stopNative() {
      nativeCurrent = false;
    },
    stopGraph() {
      graphCurrent = false;
    },
    close() {
      control.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a SQLite binding broker requires private signing authority", () => {
  expect(() => createSelfhostV2SqliteBindingBroker({} as never)).toThrow(TypeError);
});

test("SQL staging requires an operator-private real directory", async () => {
  const host = await fixture();
  try {
    const root = join(host.root, "sql-input-staging");
    const alias = join(host.root, "sql-input-alias");
    symlinkSync(root, alias);
    const options = {
      store: host.store,
      signingKey: new Uint8Array(32).fill(7),
      stagingRoot: alias,
      observeVersionTarget: async () => ({ kind: "unknown" as const }),
      graphStillCurrent: async () => false,
      resolveCurrentBinding: async () => null,
    };
    expect(() => createSelfhostV2SqliteBindingBroker(options)).toThrow(TypeError);
    chmodSync(root, 0o755);
    expect(() => createSelfhostV2SqliteBindingBroker({ ...options, stagingRoot: root })).toThrow(
      TypeError,
    );
  } finally {
    host.close();
  }
});

test("SQLite bindings refuse incomplete or unresolved WorkerVersion observations", async () => {
  const host = await fixture();
  try {
    const updateObservation = host.control.prepare(
      "UPDATE tf_v2_resources SET observed_json = ? WHERE uid = 'version-one'",
    );
    for (const observation of [
      { ready: true },
      { ready: true, resolvedBindings: true },
      { ready: true, resolvedBindings: false, bundleVerified: true },
      { ready: true, resolvedBindings: true, bundleVerified: false },
      { ready: true, resolvedBindings: "true", bundleVerified: true },
    ]) {
      updateObservation.run(JSON.stringify(observation));
      expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
        ok: false,
        error: { code: "backend_unavailable" },
      });
    }
    updateObservation.run(
      JSON.stringify({ ready: true, resolvedBindings: true, bundleVerified: true }),
    );
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: true,
      value: { rows: [], rowsWritten: 0 },
    });
  } finally {
    host.close();
  }
});

test("a signed Version binding reaches only its current UID database and survives same-spec PUT", async () => {
  const host = await fixture();
  try {
    expect(
      await host.call("execute", {
        sql: "INSERT INTO records (id, body) VALUES (?, ?)",
        params: [1, "kept"],
      }),
    ).toEqual({
      ok: true,
      value: { rows: [], rowsWritten: 1 },
    });
    expect(
      await host.call("query", { sql: "SELECT body FROM records WHERE id = ?", params: [1] }),
    ).toEqual({
      ok: true,
      value: { rows: [{ body: "kept" }], rowsWritten: 0 },
    });
    expect(await host.call("query", { sql: "SELECT body FROM records" }, "OTHER")).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    const update = await host.engine.acceptUpdate({
      principal: "alice",
      key: "sqlite-binding-update-0001",
      uid: host.databaseUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    expect((await host.engine.runNext())?.status).toBe("succeeded");
    expect(update.generation).toBe(2);
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: true,
      value: { rows: [{ body: "kept" }], rowsWritten: 0 },
    });
    host.stopNative();
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
  } finally {
    host.close();
  }
});

test("inline SQL refuses extra and duplicate envelope fields before executing", async () => {
  const host = await fixture();
  try {
    const route = `http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`;
    const headers = { authorization: `Bearer ${host.token}` };
    const protocol = JSON.stringify(SELFHOST_DATA_PLANE_PROTOCOL);
    const insert = (id: number) =>
      JSON.stringify({ sql: `INSERT INTO records (id, body) VALUES (${id}, 'forbidden')` });
    const invalidBodies = [
      `{"statement":${insert(1)},"extra":true,"protocol":${protocol},"binding":"DB","op":"execute"}`,
      `{"statement":${insert(2)},"binding":"OTHER","protocol":${protocol},"binding":"DB","op":"execute"}`,
      `{"statement":${insert(3)},"b\\u0069nding":"OTHER","protocol":${protocol},"binding":"DB","op":"execute"}`,
      `{"statements":[${insert(4)}],"extra":true,"protocol":${protocol},"binding":"DB","op":"transaction"}`,
    ];
    for (const body of invalidBodies) {
      const response = await host.broker.handle(
        new Request(route, { method: "POST", headers, body }),
      );
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({
        ok: false,
        error: { code: "backend_unavailable" },
      });
    }
    expect(await host.call("query", { sql: "SELECT count(*) AS count FROM records" })).toEqual({
      ok: true,
      value: { rows: [{ count: 0 }], rowsWritten: 0 },
    });
    expect(
      await host.call("execute", {
        sql: "INSERT INTO records (id, body) VALUES (?, ?)",
        params: [5, '{"op":"execute","binding":"OTHER"}'],
      }),
    ).toEqual({ ok: true, value: { rows: [], rowsWritten: 1 } });
    expect(await host.call("query", { sql: "SELECT body FROM records WHERE id = 5" })).toEqual({
      ok: true,
      value: { rows: [{ body: '{"op":"execute","binding":"OTHER"}' }], rowsWritten: 0 },
    });
  } finally {
    host.close();
  }
});

test("terminal drain waits for a lost SQL acknowledgement and refuses a late call", async () => {
  const host = await fixture("DB", true);
  try {
    let release!: () => void;
    let blocked!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    host.setReadHook(async (count) => {
      if (count === 4) {
        blocked();
        await held;
      }
    });
    const pendingSQL = host.call("execute", {
      sql: "INSERT INTO records (id, body) VALUES (1, 'committed before lost ACK')",
    });
    await reached;
    host.retire();
    const pendingDrain = host.broker.drainInvocation(host.grant);
    await Bun.sleep(30);
    expect(host.drained()).toBe(false);
    release();
    expect(await pendingSQL).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(await pendingDrain).toBe(true);
    expect(host.drained()).toBe(true);
    expect(await host.broker.drainInvocation(host.grant)).toBe(true);
    expect(
      await host.call("execute", {
        sql: "INSERT INTO records (id, body) VALUES (2, 'late SQL')",
      }),
    ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(
      await host.store.withAuthorizedDatabase({
        resourceUid: host.databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return database.prepare("SELECT id FROM records ORDER BY id").all();
        },
      }),
    ).toEqual([{ id: 1 }]);
  } finally {
    host.close();
  }
});

test("invocation-scoped SQL refuses wrong Core scope and no-native-dispatch before effect", async () => {
  const host = await fixture("DB", true);
  try {
    for (const patch of [
      { space: "foreign" },
      { targetKey: "foreign-target" },
      { versionGeneration: 2 },
      { noNativeDispatchAtMs: 1 },
    ]) {
      host.setProofPatch(patch);
      expect(
        await host.call("execute", {
          sql: "INSERT INTO records (id, body) VALUES (1, 'forbidden')",
        }),
      ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    }
    expect(
      await host.store.withAuthorizedDatabase({
        resourceUid: host.databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return database.prepare("SELECT count(*) AS count FROM records").get();
        },
      }),
    ).toEqual({ count: 0 });
  } finally {
    host.close();
  }
});

test("a killed Node SQL process releases invocation custody only after journal recovery", async () => {
  const host = await fixture("DB", true);
  const storeSource = new URL("../src/providers/selfhost-v2-sqlite-store.ts", import.meta.url).href;
  const sqlSource = new URL("../src/sql-sqlite.ts", import.meta.url).href;
  const childCode = `
    const { Database } = await import("bun:sqlite");
    const { createSqliteSql } = await import(${JSON.stringify(sqlSource)});
    const { createSelfhostV2SQLiteStore } = await import(${JSON.stringify(storeSource)});
    const control = new Database(${JSON.stringify(join(host.root, "control.sqlite"))});
    const store = createSelfhostV2SQLiteStore({
      root: ${JSON.stringify(join(host.root, "native"))},
      sql: createSqliteSql(control), targetKey: ${JSON.stringify(TARGET)}
    });
    await store.withInvocationLock("invocation-one", async () => {
      await store.withAuthorizedDatabase({
        resourceUid: ${JSON.stringify(host.databaseUid)},
        stillAuthorized: async () => true,
        async use(database) {
          database.exec("BEGIN IMMEDIATE");
          database.exec("INSERT INTO records (id, body) VALUES (7, 'uncommitted')");
          console.log("sql-open");
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
    host.retire();
    const pendingDrain = host.broker.drainInvocation(host.grant);
    await Bun.sleep(30);
    expect(host.drained()).toBe(false);
    child.kill("SIGKILL");
    await child.exited;
    expect(await pendingDrain).toBe(true);
    expect(
      await host.call("execute", { sql: "INSERT INTO records (id, body) VALUES (8, 'late')" }),
    ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(
      await host.store.withAuthorizedDatabase({
        resourceUid: host.databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return database.prepare("SELECT count(*) AS count FROM records").get();
        },
      }),
    ).toEqual({ count: 0 });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    host.close();
  }
});

test("a lost drain acknowledgement replays only the identical terminal digest", async () => {
  const host = await fixture("DB", true);
  try {
    host.retire();
    host.loseNextDrainAck();
    expect(await host.broker.drainInvocation(host.grant)).toBe(false);
    expect(host.drained()).toBe(true);
    expect(await host.broker.drainInvocation(host.grant)).toBe(true);
    host.changeRetirementDigest();
    expect(await host.broker.drainInvocation(host.grant)).toBe(false);
  } finally {
    host.close();
  }
});

test("staged SQL rolls back a later invalid statement and removes its private input", async () => {
  const host = await fixture();
  try {
    const body = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "transaction",
      statements: [
        {
          sql: "INSERT INTO records (id, body) VALUES (?, ?)",
          params: [100, "x".repeat(1_000_000)],
        },
        {
          sql: "INSERT INTO records (id, body) VALUES (?, ?)",
          params: [101, "x".repeat(1_000_000)],
        },
        { sql: "BEGIN" },
      ],
    });
    const response = await host.broker.handle(
      new Request(`http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.token}` },
        body,
      }),
    );
    expect(await response?.json()).toEqual({ ok: false, error: { code: "sql_error" } });
    expect(
      await host.call("query", { sql: "SELECT count(*) AS count FROM records WHERE id >= 100" }),
    ).toEqual({
      ok: true,
      value: { rows: [{ count: 0 }], rowsWritten: 0 },
    });
    expect(readdirSync(join(host.root, "sql-input-staging"))).toEqual([]);
  } finally {
    host.close();
  }
});

test("staged SQL retains a valid 42 MB transaction outside the inline bound", async () => {
  const host = await fixture();
  try {
    const body = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "transaction",
      statements: Array.from({ length: 42 }, (_, index) => ({
        sql: "INSERT INTO records (id, body) VALUES (?, ?)",
        params: [index + 1, "x".repeat(1_000_000)],
      })),
    });
    expect(body.length).toBeGreaterThan(42_000_000);
    const response = await host.broker.handle(
      new Request(`http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.token}` },
        body,
      }),
    );
    expect(response?.status).toBe(200);
    const result = (await response?.json()) as {
      ok: boolean;
      value?: { results: { rowsWritten: number }[] };
    };
    expect(result.ok).toBe(true);
    expect(result.value?.results.map((entry) => entry.rowsWritten)).toEqual(Array(42).fill(1));
    expect(await host.call("query", { sql: "SELECT count(*) AS count FROM records" })).toEqual({
      ok: true,
      value: { rows: [{ count: 42 }], rowsWritten: 0 },
    });
    expect(readdirSync(join(host.root, "sql-input-staging"))).toEqual([]);
  } finally {
    host.close();
  }
});

test("staged SQL output over the published 8 MiB limit rolls back before commit", async () => {
  const host = await fixture();
  try {
    const body = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "transaction",
      statements: [
        ...Array.from({ length: 9 }, (_, index) => ({
          sql: "INSERT INTO records (id, body) VALUES (?, ?)",
          params: [100 + index, "x".repeat(1_000_000)],
        })),
        { sql: "SELECT body FROM records WHERE id >= 100 ORDER BY id" },
      ],
    });
    const response = await host.broker.handle(
      new Request(`http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.token}` },
        body,
      }),
    );
    expect(await response?.json()).toEqual({ ok: false, error: { code: "sql_error" } });
    expect(
      await host.call("query", { sql: "SELECT count(*) AS count FROM records WHERE id >= 100" }),
    ).toEqual({
      ok: true,
      value: { rows: [{ count: 0 }], rowsWritten: 0 },
    });
    expect(readdirSync(join(host.root, "sql-input-staging"))).toEqual([]);
  } finally {
    host.close();
  }
});

test("a pending staged SQL call has no named SQL bytes and cleans its own directory", async () => {
  const host = await fixture();
  try {
    const body = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "transaction",
      statements: [
        {
          sql: "INSERT INTO records (id, body) VALUES (?, ?)",
          params: [100, "x".repeat(1_000_000)],
        },
        {
          sql: "INSERT INTO records (id, body) VALUES (?, ?)",
          params: [101, "x".repeat(1_000_000)],
        },
      ],
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode(body.slice(0, 1_200_000)));
      },
    });
    const pending = host.broker.handle(
      new Request(`http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.token}` },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    const stagingRoot = join(host.root, "sql-input-staging");
    let calls: string[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      calls = readdirSync(stagingRoot);
      if (calls.length > 0) break;
      await Bun.sleep(10);
    }
    expect(calls).toHaveLength(1);
    expect(readdirSync(join(stagingRoot, calls[0] as string))).toEqual([]);
    controller?.enqueue(new TextEncoder().encode(body.slice(1_200_000)));
    controller?.close();
    expect(await (await pending)?.json()).toEqual({
      ok: true,
      value: {
        results: [
          { rows: [], rowsWritten: 1 },
          { rows: [], rowsWritten: 1 },
        ],
      },
    });
    expect(readdirSync(stagingRoot)).toEqual([]);
  } finally {
    host.close();
  }
});

test("malformed or interrupted staged SQL never applies and leaves no private input", async () => {
  const host = await fixture();
  try {
    const prefix = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "transaction",
      statements: [
        {
          sql: "INSERT INTO records (id, body) VALUES (?, ?)",
          params: [100, "x".repeat(1_000_000)],
        },
        {
          sql: "INSERT INTO records (id, body) VALUES (?, ?)",
          params: [101, "x".repeat(1_000_000)],
        },
      ],
    });
    const malformed = prefix.replace(/\]\}$/, ",]}");
    const route = `http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`;
    const headers = { authorization: `Bearer ${host.token}` };
    const response = await host.broker.handle(
      new Request(route, { method: "POST", headers, body: malformed }),
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(readdirSync(join(host.root, "sql-input-staging"))).toEqual([]);

    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(malformed.slice(0, 1_200_000)));
        controller.error(new Error("simulated upload interruption"));
      },
    });
    const aborted = await host.broker.handle(
      new Request(route, {
        method: "POST",
        headers,
        body: interrupted,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(aborted?.status).toBe(400);
    expect(await aborted?.json()).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(readdirSync(join(host.root, "sql-input-staging"))).toEqual([]);
    expect(
      await host.call("query", { sql: "SELECT count(*) AS count FROM records WHERE id >= 100" }),
    ).toEqual({
      ok: true,
      value: { rows: [{ count: 0 }], rowsWritten: 0 },
    });
  } finally {
    host.close();
  }
});

test("forged, foreign, unselected, and non-current grants cannot open the UID file", async () => {
  const host = await fixture();
  try {
    const route = `http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`;
    const body = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "query",
      statement: { sql: "SELECT body FROM records" },
    });
    async function request(token: string) {
      const response = await host.broker.handle(
        new Request(route, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
      );
      return response ? { status: response.status, value: await response.json() } : null;
    }
    const [payload, signature] = host.token.split(".");
    if (!payload || !signature) throw new Error("fixture grant is incomplete");
    const forged = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    expect(await request(forged)).toEqual({
      status: 401,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signature.at(-1) ?? "");
    expect(last % 4).toBe(0);
    const alias = `${signature.slice(0, -1)}${alphabet[last | 1]}`;
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(signature, "base64url"));
    expect(await request(`${payload}.${alias}`)).toEqual({
      status: 401,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
    const foreign = host.broker.issueGrant({
      ...host.grant,
      principal: "mallory",
    });
    expect(await request(foreign)).toEqual({
      status: 200,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
    const substituted = host.broker.issueGrant({
      ...host.grant,
      bindings: [{ name: "DB", resourceUid: "another-resource" }],
    });
    expect(await request(substituted)).toEqual({
      status: 200,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
    host.stopGraph();
    expect(await request(host.token)).toEqual({
      status: 200,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
  } finally {
    host.close();
  }
});

test("a changed private owner receipt refuses SQL even with a signed, current Core grant", async () => {
  const host = await fixture();
  try {
    const receipt = join(host.root, "native", "resources", host.databaseUid, "owner.json");
    writeFileSync(
      receipt,
      JSON.stringify({
        version: 1,
        resourceUid: "foreign-uid",
        targetKey: TARGET,
        createOperationId: "foreign-operation",
      }),
    );
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
  } finally {
    host.close();
  }
});

for (const { bindingName, publicVar } of [
  { bindingName: "DB", publicVar: undefined },
  {
    bindingName: "__TAKOSERVER_SELFHOST_DATA",
    publicVar: "TAKOSERVER_SELFHOST_RUNTIME_READINESS",
  },
  { bindingName: "__TAKOSERVER_SELFHOST_RUNTIME_READINESS", publicVar: "TAKOSERVER_SELFHOST_DATA" },
  { bindingName: "__TAKOSERVER_SELFHOST_DATA_TOKEN", publicVar: undefined },
] as const) {
  test.skipIf(WORKERD === undefined)(
    `real workerd invokes the V2 SQLite facade with public names ${bindingName}/${publicVar ?? "none"}`,
    async () => {
      const host = await fixture(bindingName);
      const plane = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          return host.broker
            .handle(request)
            .then((response) => response ?? new Response(null, { status: 404 }));
        },
      });
      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = Number(reserved.port);
      reserved.stop(true);
      let child: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const artifact = await selectClosedGraphWorkerd({
          binary: WORKERD,
          privateRoot: join(host.root, "artifact"),
        });
        if (!artifact.binary) throw new Error(artifact.diagnostic ?? "pinned workerd unavailable");
        const original = `import { className } from "./class-probe.js";
    export class Application {}
    export default { async fetch(request, env) {
      const keys = Reflect.ownKeys(env).sort();
      const database = env[${JSON.stringify(bindingName)}];
      const publicValue = ${publicVar ? `env[${JSON.stringify(publicVar)}]` : "undefined"};
      const privateVisible = [
        ${JSON.stringify(WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING)},
        ${JSON.stringify(WORKERD_V2_PRIVATE_READINESS_BINDING)},
        ${JSON.stringify(WORKERD_V2_PRIVATE_QUEUE_SETTLEMENT_BINDING)}
      ].some((name) => env[name] !== undefined);
      if (new URL(request.url).pathname === "/class") return Response.json({ className: className() });
      if (new URL(request.url).pathname === "/write") {
        const result = await database.execute("INSERT INTO records (id, body) VALUES (?, ?)", [7, "native"]);
        return Response.json({ keys, publicValue, privateVisible, result, hasRaw: "close" in database || "database" in database });
      }
      if (new URL(request.url).pathname === "/oversize") {
        // Every input is legal; this transaction's aggregate wire body exceeds 40 MiB.
        const body = "x".repeat(1000000);
        let outcome;
        try {
          const result = await database.transaction(Array.from({ length: 42 }, (_, index) => ({
            sql: "INSERT INTO records (id, body) VALUES (?, ?)", params: [100 + index, body]
          })));
          outcome = { ok: true, results: result.results.length, rowsWritten: result.results.reduce((total, item) => total + item.rowsWritten, 0) };
        } catch (error) { outcome = { ok: false, name: error.name }; }
        const state = await database.query("SELECT count(*) AS count FROM records WHERE id >= 100");
        return Response.json({ outcome, state });
      }
      if (new URL(request.url).pathname === "/invalid") {
        const names = [];
        for (const invoke of [
          () => database.query(17),
          () => database.execute("SELECT 1", [], "extra"),
          () => database.query("SELECT 1", [], "extra"),
          () => database.transaction([], "extra"),
          () => database.query("SELECT ?", [undefined]),
          () => database.query("SELECT ?", [,]),
          () => database.transaction([{ sql: 17 }]),
        ]) {
          try { await invoke(); } catch (error) { names.push(error.name); }
        }
        return Response.json({ names });
      }
      if (new URL(request.url).pathname === "/ledger") {
        try { await database.query("SELECT * FROM _takoform_sqlite_migrations"); }
        catch (error) { return Response.json({ name: error.name }); }
      }
      if (new URL(request.url).pathname === "/transaction") {
        const result = await database.transaction([
          { sql: "INSERT INTO records (id, body) VALUES (?, ?)", params: [8, "committed"] },
          { sql: "SELECT body FROM records WHERE id = ?", params: [8] },
        ]);
        return Response.json(result);
      }
      if (new URL(request.url).pathname === "/rollback") {
        try {
          await database.transaction([
            { sql: "INSERT INTO records (id, body) VALUES (?, ?)", params: [9, "rolled back"] },
            { sql: "INSERT INTO missing_table VALUES (1)" },
          ]);
        } catch (error) {
          const absent = await database.query("SELECT body FROM records WHERE id = ?", [9]);
          return Response.json({ name: error.name, absent });
        }
      }
      return Response.json(await database.query("SELECT body FROM records WHERE id = ?", [7]));
    } }`;
        const projection = v2SqliteWorkerProjection({
          originalMainModule: "app.js",
          adapterModule: "v2-adapter.js",
          intrinsicModule: "v2-intrinsics.js",
          sqliteBindingNames: [bindingName],
          declaredHandlers: ["fetch"],
        });
        const modules = new Map<string, Uint8Array>([
          ["app.js", new TextEncoder().encode(original)],
          [
            "class-probe.js",
            new TextEncoder().encode(
              'import { Application } from "./v2-adapter.js"; export function className() { return Application.name; }',
            ),
          ],
          ...projection,
        ]);
        const graph = compileWorkerdVersionGraph({
          directory: "v2-sqlite-native",
          mainModule: "v2-adapter.js",
          modules,
          moduleMediaTypes: {
            "app.js": "application/javascript+module",
            "class-probe.js": "application/javascript+module",
            "v2-adapter.js": "application/javascript+module",
            "v2-intrinsics.js": "application/javascript+module",
          },
          hostnames: [],
          generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
          workerResourceUid: "worker-one",
          declaredHandlers: ["fetch"],
          readiness: { publication: "v2-sqlite-generation", probeHostname: "binding.localhost" },
          environment: publicVar
            ? [{ name: publicVar, value: "public-value", type: "plain_text" }]
            : [],
          serviceBindings: [],
          dataPlane: {
            address: `127.0.0.1:${plane.port}`,
            token: host.token,
            bindings: [{ kind: "edge.sql@1.0.0", publicName: bindingName }],
          },
        });
        const runtime = createWorkerdRuntime({
          root: host.root,
          binary: artifact.binary,
          port,
          isReady: () => true,
        });
        if (!runtime.publish) throw new Error("workerd weighted publication unavailable");
        await runtime.publish("v2-sqlite-native", {
          generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
          workerResourceUid: "worker-one",
          hostnames: ["binding.localhost"],
          versions: [
            {
              versionId: "v2-native-one",
              workerVersionUid: "version-one",
              weight: 10_000,
              ...graph,
            },
          ],
        });
        child = Bun.spawn([artifact.binary, "serve", join(host.root, "workers", "workerd.capnp")], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const origin = `http://127.0.0.1:${port}`;
        let ready = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          try {
            await fetch(origin, {
              headers: { host: "binding.localhost" },
              signal: AbortSignal.timeout(250),
            });
            ready = true;
            break;
          } catch {
            await Bun.sleep(50);
          }
        }
        expect(ready).toBe(true);
        async function call(path: string) {
          const response = await fetch(`${origin}${path}`, {
            headers: { host: "binding.localhost" },
          });
          return { status: response.status, value: await response.json() };
        }
        expect(await call("/write")).toEqual({
          status: 200,
          value: {
            keys: [bindingName, ...(publicVar ? [publicVar] : [])].sort(),
            ...(publicVar ? { publicValue: "public-value" } : {}),
            result: { rows: [], rowsWritten: 1 },
            privateVisible: false,
            hasRaw: false,
          },
        });
        expect(await call("/read")).toEqual({
          status: 200,
          value: { rows: [{ body: "native" }], rowsWritten: 0 },
        });
        expect(await call("/class")).toEqual({ status: 200, value: { className: "Application" } });
        expect(await call("/invalid")).toEqual({
          status: 200,
          value: {
            names: [
              "TypeError",
              "TypeError",
              "TypeError",
              "TypeError",
              "TypeError",
              "TypeError",
              "TypeError",
            ],
          },
        });
        expect(await call("/ledger")).toEqual({ status: 200, value: { name: "sql_error" } });
        expect(await call("/transaction")).toEqual({
          status: 200,
          value: {
            results: [
              { rows: [], rowsWritten: 1 },
              { rows: [{ body: "committed" }], rowsWritten: 0 },
            ],
          },
        });
        expect(await call("/rollback")).toEqual({
          status: 200,
          value: { name: "sql_error", absent: { rows: [], rowsWritten: 0 } },
        });
        if (bindingName === "DB" && publicVar === undefined) {
          expect(await call("/oversize")).toEqual({
            status: 200,
            value: {
              outcome: { ok: true, results: 42, rowsWritten: 42 },
              state: { rows: [{ count: 42 }], rowsWritten: 0 },
            },
          });
        }
        expect(await runtime.restore()).toEqual(["v2-sqlite-native"]);
      } finally {
        if (child) {
          child.kill();
          await child.exited;
        }
        plane.stop(true);
        host.close();
      }
    },
  );
}
