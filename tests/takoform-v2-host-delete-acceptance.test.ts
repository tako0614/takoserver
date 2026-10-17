import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  captureV2HostAcceptance,
  prepareV2HostAcceptance,
  type V2HostAcceptance,
  type V2HostDeleteAcceptanceContext,
  type V2PreparedHostAcceptance,
} from "../src/takoform-v2/host-acceptance.ts";
import type { V2Backend, V2Form } from "../src/takoform-v2/types.ts";

// A synthetic internal issuer proves the neutral Core seam only. It is not
// Container authority, a native retirement proof, or an App composition test.
const FORM = "https://forms.example.test/NeutralDelete/1.0.0/";
const AT = "2026-10-15T00:00:00.000Z";
const CREATE_KEY = "neutral-delete-create-key-0001";
const DELETE_KEY = "neutral-delete-delete-key-0001";
const INITIAL_OUTPUT = { address: "original.example.invalid" };
const BACKEND_ID = "neutral-delete-backend";
const TARGET_KEY = "neutral-delete-target";

type Mode =
  | "claim"
  | "false-guard"
  | "throw"
  | "resolved-undefined"
  | "foreign-sql"
  | "other-context"
  | "malformed";

function fixture(
  options: { issuer?: boolean; deleteMethod?: boolean; mode?: Mode; race?: boolean } = {},
) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  db.exec(`CREATE TABLE neutral_delete_marker (
    operation_id TEXT PRIMARY KEY,
    resource_uid TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    output_json TEXT NOT NULL
  )`);
  const raw = createSqliteSql(db);
  const batches: SqlStatement[][] = [];
  const sql: Sql = {
    query: raw.query,
    run: raw.run,
    async batch(statements) {
      batches.push([...statements]);
      return raw.batch(statements);
    },
  };
  const mode = options.mode ?? "claim";
  const race = options.race ?? false;
  let raced = false;
  let prepareCalls = 0;
  const genericActions: string[] = [];
  const contexts: V2HostDeleteAcceptanceContext[] = [];
  const issuer: V2HostAcceptance = {
    assertSql(value) {
      if (value !== sql) throw new TypeError("foreign construction Sql");
    },
    initialOutput() {
      return undefined;
    },
    prepare(context) {
      genericActions.push(context.action);
      return undefined;
    },
    async prepareDelete(context): Promise<V2PreparedHostAcceptance> {
      prepareCalls += 1;
      contexts.push(context);
      if (mode === "throw") throw new Error("neutral issuer refusal");
      if (mode === "resolved-undefined") return undefined as unknown as V2PreparedHostAcceptance;
      if (race && !raced) {
        raced = true;
        await engine.acceptUpdate({
          principal: "owner",
          key: "neutral-delete-raced-update-0001",
          uid: context.resourceUid,
          expectedGeneration: context.generation - 1,
          spec: { value: "raced" },
        });
      }
      const guard: SqlStatement =
        mode === "false-guard"
          ? { sql: "0", params: [] }
          : {
              sql: `EXISTS (SELECT 1 FROM tf_v2_resources
                WHERE uid = ? AND principal = ? AND form_url = ? AND space = ?
                  AND name = ? AND backend_id = ? AND target_key = ?
                  AND generation = ? AND spec_json = ? AND output_json = ?)`,
              params: [
                context.resourceUid,
                context.principal,
                context.form,
                context.space,
                context.name,
                context.backendId,
                context.targetKey,
                context.generation - 1,
                context.specJson,
                context.outputJson,
              ],
            };
      const terminal: SqlStatement = {
        sql: `INSERT INTO neutral_delete_marker
          (operation_id, resource_uid, spec_json, output_json)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM host_form_admission)
            AND EXISTS (SELECT 1 FROM tf_v2_operations operation
              JOIN tf_v2_resources resource ON resource.uid = operation.resource_uid
              WHERE operation.id = ? AND operation.action = 'delete'
                AND operation.generation = ? AND operation.status = 'queued'
                AND resource.uid = ? AND resource.generation = ?
                AND resource.phase = 'deleting'
                AND resource.busy_operation = operation.id)`,
        params: [
          context.operationId,
          context.resourceUid,
          context.specJson,
          context.outputJson,
          context.operationId,
          context.generation,
          context.resourceUid,
          context.generation,
        ],
      };
      if (mode === "malformed") return {} as V2PreparedHostAcceptance;
      if (mode === "foreign-sql")
        return prepareV2HostAcceptance({ ...sql }, context, guard, terminal);
      if (mode === "other-context")
        return prepareV2HostAcceptance(sql, Object.freeze({ ...context }), guard, terminal);
      return prepareV2HostAcceptance(sql, context, guard, terminal);
    },
  };
  const backend: V2Backend = {
    id: BACKEND_ID,
    targetKey: TARGET_KEY,
    async execute(input) {
      return { kind: "complete" as const, observed: { ready: true }, output: input.previousOutput };
    },
    async reconcile(input) {
      return { kind: "complete" as const, observed: { ready: true }, output: input.previousOutput };
    },
  };
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    initialOutput() {
      return INITIAL_OUTPUT;
    },
    references(spec: JsonObject) {
      const dependsOn = spec.dependsOn;
      return typeof dependsOn === "string"
        ? [{ resourceUid: dependsOn, formUrl: FORM, readiness: "observed" as const }]
        : [];
    },
    backend,
  };
  const genericOnlyIssuer: V2HostAcceptance = {
    assertSql: issuer.assertSql,
    initialOutput: issuer.initialOutput,
    prepare: issuer.prepare,
  };
  const engine = createTakoformV2Engine(
    {
      sql,
      forms: { [FORM]: form },
      replayWindowSeconds: 3600,
      now: () => new Date(AT),
      authorize: async (principal, space) => principal === "owner" && space === "space",
    },
    options.issuer === false
      ? undefined
      : options.deleteMethod === false
        ? genericOnlyIssuer
        : issuer,
  );
  async function create(name = "target", spec: JsonObject = { value: "original" }) {
    const operation = await engine.acceptCreate({
      principal: "owner",
      key: name === "target" ? CREATE_KEY : "neutral-delete-referrer-key-0001",
      input: { form: FORM, space: "space", name, spec },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    return operation;
  }
  function resource(uid: string) {
    return db.query("SELECT * FROM tf_v2_resources WHERE uid = ?").get(uid) as Record<
      string,
      unknown
    > | null;
  }
  function snapshot(uid: string) {
    return {
      resource: resource(uid),
      operations: db
        .query("SELECT id, action, generation, status FROM tf_v2_operations ORDER BY id")
        .all(),
      references: db
        .query("SELECT * FROM tf_v2_resource_references ORDER BY target_uid, referrer_uid")
        .all(),
      markers: db.query("SELECT * FROM neutral_delete_marker ORDER BY operation_id").all(),
    };
  }
  function deleteTarget(uid: string, generation = 1) {
    return engine.acceptDelete({
      principal: "owner",
      key: DELETE_KEY,
      uid,
      expectedGeneration: generation,
    });
  }
  return {
    db,
    sql,
    batches,
    engine,
    issuer,
    contexts,
    create,
    resource,
    snapshot,
    deleteTarget,
    prepareCalls: () => prepareCalls,
    genericActions: () => [...genericActions],
  };
}

test("DELETE issuer receives the settled target and appends a last terminal", async () => {
  const f = fixture();
  try {
    const created = await f.create();
    const before = f.resource(created.resourceUid);
    expect(before).not.toBeNull();
    f.batches.length = 0;
    const deleted = await f.deleteTarget(created.resourceUid);
    expect(deleted).toMatchObject({
      action: "delete",
      generation: 2,
      resourceUid: created.resourceUid,
    });
    expect(f.contexts).toHaveLength(1);
    const context = f.contexts[0]!;
    expect(Object.isFrozen(context)).toBe(true);
    expect(context).toMatchObject({
      action: "delete",
      principal: before!.principal,
      resourceUid: before!.uid,
      generation: Number(before!.generation) + 1,
      form: before!.form_url,
      space: before!.space,
      name: before!.name,
      backendId: before!.backend_id,
      targetKey: before!.target_key,
      specJson: before!.spec_json,
      outputJson: before!.output_json,
      referencesJson: null,
      operationId: deleted.id,
    });
    expect(context.key).toBe(DELETE_KEY);
    expect(context.fingerprint).toMatch(/^v2-request-sha256:/u);
    expect(context.at).toBe(AT);
    expect(context.retainUntil).toBe("2026-10-15T01:00:00.000Z");
    expect(f.genericActions()).toEqual(["create"]);
    expect(f.batches).toHaveLength(1);
    const statements = f.batches[0]!;
    expect(
      statements.filter((item) => item.sql.includes("INSERT INTO neutral_delete_marker")),
    ).toHaveLength(1);
    expect(statements.at(-1)?.sql).toContain("INSERT INTO neutral_delete_marker");
    expect(f.snapshot(created.resourceUid).markers).toEqual([
      {
        operation_id: deleted.id,
        resource_uid: created.resourceUid,
        spec_json: context.specJson,
        output_json: context.outputJson,
      },
    ]);
    expect(f.resource(created.resourceUid)).toMatchObject({
      generation: 2,
      phase: "deleting",
      busy_operation: deleted.id,
    });
  } finally {
    f.db.close();
  }
});

for (const mode of [
  "throw",
  "false-guard",
  "resolved-undefined",
  "foreign-sql",
  "other-context",
  "malformed",
] as const) {
  test(`DELETE ${mode} leaves Core rows, references and marker unchanged`, async () => {
    const f = fixture({ mode });
    try {
      const created = await f.create();
      const before = f.snapshot(created.resourceUid);
      f.batches.length = 0;
      await expect(f.deleteTarget(created.resourceUid)).rejects.toThrow();
      expect(f.snapshot(created.resourceUid)).toEqual(before);
      expect(f.batches).toHaveLength(mode === "false-guard" ? 1 : 0);
      expect(f.prepareCalls()).toBe(1);
    } finally {
      f.db.close();
    }
  });
}

test("terminal failure rolls back Core DELETE and neutral marker", async () => {
  const f = fixture();
  try {
    const created = await f.create();
    const before = f.snapshot(created.resourceUid);
    f.db.exec(`CREATE TRIGGER neutral_delete_terminal_failure
      BEFORE INSERT ON neutral_delete_marker
      BEGIN SELECT RAISE(ABORT, 'neutral terminal failure'); END`);
    f.batches.length = 0;
    await expect(f.deleteTarget(created.resourceUid)).rejects.toThrow();
    expect(f.batches).toHaveLength(1);
    expect(f.batches[0]!.at(-1)?.sql).toContain("INSERT INTO neutral_delete_marker");
    expect(f.snapshot(created.resourceUid)).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("stale generation and inbound references refuse before DELETE issuer", async () => {
  const stale = fixture();
  const referenced = fixture();
  try {
    const target = await stale.create();
    const staleBefore = stale.snapshot(target.resourceUid);
    await expect(stale.deleteTarget(target.resourceUid, 0)).rejects.toMatchObject({
      code: "generation_conflict",
      status: 409,
    });
    expect(stale.prepareCalls()).toBe(0);
    expect(stale.snapshot(target.resourceUid)).toEqual(staleBefore);

    const owned = await referenced.create();
    await referenced.create("referrer", { dependsOn: owned.resourceUid });
    const before = referenced.snapshot(owned.resourceUid);
    await expect(referenced.deleteTarget(owned.resourceUid)).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    expect(referenced.prepareCalls()).toBe(0);
    expect(referenced.snapshot(owned.resourceUid)).toEqual(before);
  } finally {
    stale.db.close();
    referenced.db.close();
  }
});

test("a real UPDATE accepted after DELETE preflight cannot admit stale DELETE", async () => {
  const f = fixture({ race: true });
  try {
    const created = await f.create();
    await expect(f.deleteTarget(created.resourceUid)).rejects.toMatchObject({
      code: "resource_busy",
      status: 409,
    });
    expect(f.prepareCalls()).toBe(1);
    expect(f.resource(created.resourceUid)).toMatchObject({ generation: 2, phase: "pending" });
    expect(
      f.db.query("SELECT count(*) AS n FROM tf_v2_operations WHERE action = 'delete'").get(),
    ).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM neutral_delete_marker").get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});

test("ordinary DELETE without issuer never calls a Host method or adds a terminal", async () => {
  const f = fixture({ issuer: false });
  try {
    const created = await f.create();
    f.batches.length = 0;
    expect((await f.deleteTarget(created.resourceUid)).action).toBe("delete");
    expect(f.batches).toHaveLength(1);
    expect(f.batches[0]!.some((item) => item.sql.includes("host_form_admission"))).toBe(false);
    expect(f.db.query("SELECT count(*) AS n FROM neutral_delete_marker").get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});

test("a generic CREATE/UPDATE-only issuer leaves DELETE on the ordinary Core path", async () => {
  const f = fixture({ deleteMethod: false });
  try {
    const created = await f.create();
    f.batches.length = 0;
    expect((await f.deleteTarget(created.resourceUid)).action).toBe("delete");
    expect(f.genericActions()).toEqual(["create"]);
    expect(f.prepareCalls()).toBe(0);
    expect(f.batches).toHaveLength(1);
    expect(f.batches[0]!.some((item) => item.sql.includes("host_form_admission"))).toBe(false);
  } finally {
    f.db.close();
  }
});

test("DELETE method capture rejects getter, inherited method and present nonfunction", () => {
  const f = fixture();
  try {
    let getterCalls = 0;
    const accessor = { ...f.issuer };
    Object.defineProperty(accessor, "prepareDelete", {
      get() {
        getterCalls += 1;
        return f.issuer.prepareDelete;
      },
    });
    expect(() => captureV2HostAcceptance(accessor, f.sql)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() =>
      captureV2HostAcceptance(Object.create(f.issuer) as V2HostAcceptance, f.sql),
    ).toThrow();
    const nonfunction = { ...f.issuer };
    Object.defineProperty(nonfunction, "prepareDelete", { value: 1 });
    expect(() => captureV2HostAcceptance(nonfunction, f.sql)).toThrow();
    const captured = captureV2HostAcceptance(f.issuer, f.sql);
    expect(captured?.prepareDelete).toBeDefined();
    expect(Object.isFrozen(captured)).toBe(true);
  } finally {
    f.db.close();
  }
});
