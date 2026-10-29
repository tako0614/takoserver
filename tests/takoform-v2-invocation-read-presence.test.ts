import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql, SqlWrite } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2WorkerInvocationLifecycle } from "../src/takoform-v2/worker-invocation-custody.ts";

const handle = { invocationId: "invocation-001", custodyToken: "private-custody-token-001" };
const digest = `sha256:${"a".repeat(64)}` as const;

async function seed(sql: Sql) {
  for (const [uid, form, name] of [
    ["worker-one", "ModuleWorker/0.3.0", "worker"],
    ["deployment-one", "WorkerDeployment/0.4.0", "deployment"],
    ["endpoint-one", "WorkerEndpoint/0.3.0", "endpoint"],
    ["version-one", "WorkerVersion/0.5.0", "version"],
  ] as const) {
    await sql.run(
      `INSERT INTO tf_v2_resources
       (uid, principal, form_url, space, name, backend_id, target_key,
        active_name, generation, observed_generation, phase, spec_json, last_operation)
       VALUES (?, 'org-1', ?, 'prod', ?, 'backend-one', 'target-one', ?, 1, 1, 'idle', '{}', ?)`,
      [uid, `https://edge.forms.takoform.com/forms/${form}/`, name, name, `op-${uid}`],
    );
  }
  for (const uid of ["deployment-one", "version-one"]) {
    await sql.run(
      `INSERT INTO tf_v2_operations
       (id, resource_uid, principal, replay_key, request_fingerprint, action,
        generation, status, effect, created_at, updated_at, retain_until,
        backend_id, target_key, backend_key, accepted_spec_json)
       VALUES (?, ?, 'org-1', ?, 'fp', 'create', 1, 'succeeded', 'complete',
        '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z',
        'backend-one', 'target-one', ?, '{}')`,
      [`op-${uid}`, uid, `replay-${uid}`, `key-${uid}`],
    );
  }
  await sql.run(
    `INSERT INTO tf_v2_worker_invocations
     (invocation_id, custody_token, backend_id, target_key, principal, space,
      worker_uid, deployment_uid, deployment_generation, source_operation_id,
      endpoint_uid, endpoint_generation, version_uid, version_generation,
      version_operation_id, native_identity, closure_digest, confirmed_receipt,
      admitted_at_ms)
     VALUES (?, ?, 'backend-one', 'target-one', 'org-1', 'prod',
       'worker-one', 'deployment-one', 1, 'op-deployment-one',
       'endpoint-one', 1, 'version-one', 1, 'op-version-one',
       'script-one', ?, 'etag-one', 1000)`,
    [handle.invocationId, handle.custodyToken, digest],
  );
}

test("atomic invocation presence preserves absence, invalid custody and the original read contract", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    await seed(sql);
    let calls = 0;
    const tracked: Sql = {
        ...sql,
        batch: async (plans) => {
          calls++;
          return sql.batch(plans);
        },
      },
      owner = createV2WorkerInvocationLifecycle({ sql: tracked });
    expect(await owner.readPresence?.({ ...handle, invocationId: "missing" })).toEqual({
      kind: "missing",
    });
    const originalRecord = await owner.read(handle);
    expect(originalRecord).not.toBeNull();
    if (!originalRecord) throw new Error("fixture invocation record missing");
    expect(await owner.readPresence?.(handle)).toEqual({ kind: "valid", record: originalRecord });
    expect(await owner.read({ ...handle, custodyToken: "wrong-token" })).toBeNull();
    expect(await owner.readPresence?.({ ...handle, custodyToken: "wrong-token" })).toEqual({
      kind: "invalid",
    });
    db.exec("DROP TRIGGER tf_v2_worker_invocations_no_delete");
    expect(await owner.read(handle)).toBeNull();
    expect(await owner.readPresence?.(handle)).toEqual({ kind: "invalid" });
    expect(calls).toBe(4);
  } finally {
    db.close();
  }
});
test("presence batch shape and contradictory rows never authorize absence; mutable handle is captured", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    await seed(sql);
    const malformed: ((rows: readonly SqlWrite[]) => unknown)[] = [
      () => [],
      (rows) => rows.slice(0, 1),
      () => new Array(2),
      (rows) => [{ ...rows[0], rows: null }, rows[1]],
      (rows) => [{ ...rows[0], rows: [null] }, rows[1]],
      (rows) => [{ ...rows[0], rows: new Array(1) }, rows[1]],
    ];
    for (const mutate of malformed) {
      const transport: Sql = {
        ...sql,
        batch: async (plans) => mutate(await sql.batch(plans)) as readonly SqlWrite[],
      };
      await expect(
        createV2WorkerInvocationLifecycle({ sql: transport }).readPresence?.(handle),
      ).rejects.toThrow();
    }
    const contradictory: ((rows: readonly SqlWrite[]) => unknown)[] = [
      (rows) => [{ ...rows[0], rows: [] }, rows[1]],
      (rows) => [rows[0], { ...rows[1], rows: [] }],
      (rows) => [{ ...rows[0], rows: [{ invocation_id: "foreign" }] }, rows[1]],
      (rows) => [
        {
          ...rows[0],
          rows: [{ invocation_id: handle.invocationId }, { invocation_id: handle.invocationId }],
        },
        rows[1],
      ],
    ];
    for (const mutate of contradictory) {
      const transport: Sql = {
        ...sql,
        batch: async (plans) => mutate(await sql.batch(plans)) as readonly SqlWrite[],
      };
      expect(
        await createV2WorkerInvocationLifecycle({ sql: transport }).readPresence?.(handle),
      ).toEqual({ kind: "invalid" });
    }
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    let gets = 0;
    const transport: Sql = {
      ...sql,
      get batch() {
        gets++;
        return async function (this: Sql, plans: Parameters<Sql["batch"]>[0]) {
          expect(this).toBe(transport);
          entered();
          await gate;
          return sql.batch(plans);
        };
      },
    };
    const owner = createV2WorkerInvocationLifecycle({ sql: transport });
    const mutable = { ...handle };
    const pending = owner.readPresence?.(mutable);
    await started;
    mutable.custodyToken = "wrong-token";
    mutable.invocationId = "missing";
    Object.defineProperty(transport, "batch", {
      value: async () => {
        throw new Error("late replacement");
      },
    });
    release();
    expect((await pending)?.kind).toBe("valid");
    expect(gets).toBe(1);
  } finally {
    db.close();
  }
});

test("presence uses legacy SELECTs only when batch is absent and never falls back after a selected batch fails", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const expected = createV2WorkerInvocationLifecycle({ sql });
    await seed(sql);
    const record = await expected.read(handle);
    expect(record).not.toBeNull();
    if (!record) throw new Error("fixture invocation record missing");
    let queries = 0;
    const query: Sql["query"] = async (statement, params) => {
      queries++;
      return sql.query(statement, params);
    };
    const legacy: Sql = { ...sql, query, batch: undefined as unknown as Sql["batch"] };
    const owner = createV2WorkerInvocationLifecycle({ sql: legacy });
    expect(await owner.readPresence?.({ ...handle, invocationId: "missing" })).toEqual({
      kind: "missing",
    });
    expect(queries).toBe(1);
    expect(await owner.readPresence?.(handle)).toEqual({ kind: "valid", record });
    expect(queries).toBe(3);
    expect(await owner.readPresence?.({ ...handle, custodyToken: "wrong-token" })).toEqual({
      kind: "invalid",
    });
    expect(queries).toBe(5);
    for (const batch of [0, null]) {
      queries = 0;
      const invalid: Sql = { ...sql, query, batch: batch as unknown as Sql["batch"] };
      await expect(
        createV2WorkerInvocationLifecycle({ sql: invalid }).readPresence?.(handle),
      ).rejects.toThrow();
      expect(queries).toBe(0);
    }
    queries = 0;
    let batches = 0;
    const rejected: Sql = {
      ...sql,
      query,
      batch: async () => {
        batches++;
        throw new Error("controlled batch refusal");
      },
    };
    await expect(
      createV2WorkerInvocationLifecycle({ sql: rejected }).readPresence?.(handle),
    ).rejects.toThrow("controlled batch refusal");
    expect(batches).toBe(1);
    expect(queries).toBe(0);
  } finally {
    db.close();
  }
});
