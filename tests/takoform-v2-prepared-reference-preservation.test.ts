import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JsonObject, Sql, SqlStatement } from "../src/ports.ts";
import { createSharedAppLedger } from "../src/shared-app-ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";
import { createWorkerEndpointOriginV2Acceptance } from "../src/worker-endpoint-origin-v2-acceptance.ts";

const FORM = "https://forms.example.test/PreparedBinding/1.0.0/";
const TARGET_FORM = "https://forms.example.test/PreparedBindingTarget/1.0.0/";
const PRINCIPAL = "org:organization";
const SPACE = "organization";
const AT = "2026-10-15T00:00:00.000Z";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function coreSchema(db: Database) {
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ])
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}

// Existing compiler's unmounted domain fixture, not an allocated/live migration.
function hostSchema(db: Database) {
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    db.exec(`CREATE TABLE ${prefix}_assignments (
      incarnation TEXT PRIMARY KEY CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
      organization_id TEXT NOT NULL, product TEXT NOT NULL CHECK(product IN ('takoserver','takosumi-hosted')),
      reservation_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      script TEXT, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at),
      CHECK((state='released')=(released_at IS NOT NULL)),
      CHECK(released_at IS NULL OR released_at>=created_at), CHECK(state<>'reserved' OR script IS NULL),
      CHECK(state<>'active' OR script IS NOT NULL))`);
    db.exec(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY CHECK(length(normalized_name) BETWEEN 3 AND 32 AND normalized_name NOT GLOB '*[^a-z0-9-]*'),
      incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      released_at INTEGER, updated_at INTEGER NOT NULL, CHECK((state='released')=(released_at IS NOT NULL)))`);
  }
  db.exec(`CREATE TABLE shared_app_staging_endpoint_bindings (
    incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL, name TEXT NOT NULL,
    endpoint_uid TEXT NOT NULL UNIQUE REFERENCES tf_v2_resources(uid),
    endpoint_generation INTEGER NOT NULL CHECK(endpoint_generation>=1),
    form_url TEXT NOT NULL, backend_id TEXT NOT NULL, target_key TEXT NOT NULL,
    create_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
    current_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id))`);
}

function fixture() {
  const db = new Database(":memory:");
  coreSchema(db);
  hostSchema(db);
  const raw = createSqliteSql(db);
  let gate:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  const batches: (readonly SqlStatement[])[] = [];
  const sql: Sql = {
    query: raw.query,
    run: raw.run,
    async batch(statements) {
      if (statements.some((statement) => /INSERT INTO tf_v2_operations\b/u.test(statement.sql))) {
        batches.push(statements);
        if (gate) {
          const held = gate;
          gate = undefined;
          held.entered.resolve();
          await held.release.promise;
        }
      }
      return raw.batch(statements);
    },
  };
  const ledger = createSharedAppLedger({
    environment: "staging",
    primary: () => sql,
    clock: () => new Date(AT),
  });
  const backend = {
    id: "prepared-binding-backend",
    targetKey: "prepared-binding-sqlite",
    async execute(input: { previousOutput: JsonObject }) {
      return { kind: "complete" as const, observed: { ready: true }, output: input.previousOutput };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend,
    async prepareAdmission(input) {
      if (!input.prepareExactReferences) throw new Error("missing Core preparation");
      return input.prepareExactReferences(async (lookup) => {
        const selected = await lookup(input.spec.target as string);
        return selected ? [{ ...selected, readiness: "ready" }] : null;
      });
    },
  };
  const target: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: { ...backend, id: "prepared-target-backend" },
  };
  const capability = createWorkerEndpointOriginV2Acceptance({
    sql,
    ledger,
    formUrl: FORM,
    backendId: backend.id,
    targetKey: backend.targetKey,
  });
  const engine = createTakoformV2Engine(
    {
      sql,
      now: () => new Date(AT),
      replayWindowSeconds: 3600,
      authorize: async (principal, space) => principal === `org:${space}`,
      forms: { [FORM]: form, [TARGET_FORM]: target },
    },
    capability,
  );
  return {
    db,
    engine,
    batches,
    async target() {
      const op = await engine.acceptCreate({
        principal: PRINCIPAL,
        key: "binding-target-create-0001",
        input: { form: TARGET_FORM, space: SPACE, name: "target", spec: {} },
      });
      expect(await engine.runNext()).toMatchObject({ id: op.id, status: "succeeded" });
      return op.resourceUid;
    },
    async reserve() {
      return ledger
        .forTrustedOwner({ organizationId: SPACE, product: "takoserver" })
        .reserve({ reservationId: "prepared-reservation", name: "selected-name" });
    },
    create(targetUid: string) {
      return engine.acceptCreate({
        principal: PRINCIPAL,
        key: "binding-consumer-create-0001",
        input: { form: FORM, space: SPACE, name: "selected-name", spec: { target: targetUid } },
      });
    },
    pause() {
      const held = { entered: deferred(), release: deferred() };
      gate = held;
      return held;
    },
  };
}

test("actual Host compiler receives the chosen sealed set in CREATE and UPDATE", async () => {
  const f = fixture();
  try {
    const target = await f.target();
    const reservation = await f.reserve();
    const created = await f.create(target);
    expect(
      f.db
        .query(
          "SELECT endpoint_uid,endpoint_generation,create_operation_id,current_operation_id FROM shared_app_staging_endpoint_bindings WHERE incarnation = ?",
        )
        .get(reservation.incarnation),
    ).toEqual({
      endpoint_uid: created.resourceUid,
      endpoint_generation: 1,
      create_operation_id: created.id,
      current_operation_id: created.id,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const changed = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "binding-consumer-update-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { target },
    });
    expect(
      f.db
        .query(
          "SELECT endpoint_generation,create_operation_id,current_operation_id FROM shared_app_staging_endpoint_bindings WHERE incarnation = ?",
        )
        .get(reservation.incarnation),
    ).toEqual({
      endpoint_generation: 2,
      create_operation_id: created.id,
      current_operation_id: changed.id,
    });
    for (const id of [created.id, changed.id]) {
      expect(
        f.db
          .query("SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?")
          .get(id),
      ).toEqual({ sealed: 1 });
      expect(
        f.db
          .query(
            "SELECT target_uid,form_url FROM tf_v2_operation_references WHERE operation_id = ?",
          )
          .all(id),
      ).toEqual([{ target_uid: target, form_url: TARGET_FORM }]);
    }
    expect(
      f.batches.filter((batch) =>
        batch.some((statement) => statement.sql.startsWith("WITH host_form_admission")),
      ),
    ).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("Core preimage refusal gates every Host terminal in CREATE and UPDATE", async () => {
  for (const action of ["create", "update"] as const) {
    const f = fixture();
    try {
      const target = await f.target();
      await f.reserve();
      const created = action === "update" ? await f.create(target) : undefined;
      if (created) await f.engine.runNext();
      const before = f.db.query("SELECT * FROM shared_app_staging_endpoint_bindings").all();
      const gate = f.pause();
      const key =
        action === "create" ? "binding-consumer-create-0001" : "binding-consumer-update-0001";
      const pending = created
        ? f.engine.acceptUpdate({
            principal: PRINCIPAL,
            key,
            uid: created.resourceUid,
            expectedGeneration: 1,
            spec: { target },
          })
        : f.create(target);
      await gate.entered.promise;
      const moved = await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: "binding-target-race-0001",
        uid: target,
        expectedGeneration: 1,
        spec: { revision: 2 },
      });
      expect(await f.engine.runNext()).toMatchObject({ id: moved.id, status: "succeeded" });
      gate.release.resolve();
      await expect(pending).rejects.toMatchObject({
        code: "dependency_conflict",
        status: 409,
        detail: undefined,
      });
      expect(f.db.query("SELECT * FROM shared_app_staging_endpoint_bindings").all()).toEqual(
        before,
      );
      expect(f.db.query("SELECT 1 FROM tf_v2_operations WHERE replay_key = ?").all(key)).toEqual(
        [],
      );
      expect(
        f.db.query("SELECT count(*) AS count FROM tf_v2_resources WHERE form_url = ?").get(FORM),
      ).toEqual({ count: created ? 1 : 0 });
    } finally {
      f.db.close();
    }
  }
});

test("legacy admission without preparation adds no read grant or reference SQL", async () => {
  const db = new Database(":memory:");
  coreSchema(db);
  const raw = createSqliteSql(db);
  const traces: (readonly SqlStatement[])[] = [];
  let reads = 0;
  const sql: Sql = {
    query: raw.query,
    run: raw.run,
    async batch(statements) {
      traces.push(statements);
      return raw.batch(statements);
    },
  };
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    async prepareAdmission() {
      return {
        sql: "? = ?",
        params: [new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer],
      };
    },
    backend: {
      id: "legacy-admission",
      targetKey: "legacy-sqlite",
      async execute() {
        return { kind: "complete", observed: {}, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3600,
    authorize: async (_principal, _space, access) => {
      if (access === "read") {
        reads++;
        return false;
      }
      return true;
    },
    forms: { [FORM]: form },
  });
  try {
    expect(
      (
        await engine.acceptCreate({
          principal: "alice",
          key: "legacy-consumer-create-0001",
          input: { form: FORM, space: "space", name: "legacy", spec: {} },
        })
      ).status,
    ).toBe("queued");
    expect(reads).toBe(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toHaveLength(3);
    expect(traces[0]?.[0]?.sql).toBe("SELECT 1 AS permitted WHERE (? = ?)");
    expect(traces[0]?.[0]?.params).toEqual([
      new Uint8Array([1, 2]).buffer,
      new Uint8Array([1, 2]).buffer,
    ]);
    expect(
      traces
        .flat()
        .some(
          (statement) =>
            statement.sql.includes("json_each") || statement.sql.includes("operation_reference"),
        ),
    ).toBe(false);
  } finally {
    db.close();
  }
});

test("caller mutation during async preparation cannot change accepted spec or chosen target", async () => {
  const db = new Database(":memory:");
  coreSchema(db);
  const sql = createSqliteSql(db);
  const entered = deferred();
  const release = deferred();
  const backend: V2Form["backend"] = {
    id: "snapshot-reference",
    targetKey: "sqlite",
    async execute() {
      return { kind: "complete", observed: { ready: true }, output: {} };
    },
    async reconcile() {
      return { kind: "unknown" };
    },
  };
  const targetForm: V2Form = { validateCreate() {}, validateUpdate() {}, backend };
  const consumer: V2Form = {
    ...targetForm,
    async prepareAdmission(input) {
      if (!input.prepareExactReferences) throw new Error("missing Core preparation");
      return input.prepareExactReferences(async (lookup) => {
        entered.resolve();
        await release.promise;
        const selected = await lookup(input.spec.target as string);
        return selected ? [{ ...selected, readiness: "ready" }] : null;
      });
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms: { [FORM]: consumer, [TARGET_FORM]: targetForm },
  });
  try {
    const first = await engine.acceptCreate({
      principal: "alice",
      key: "snapshot-target-create-0001",
      input: { form: TARGET_FORM, space: "space", name: "target", spec: {} },
    });
    await engine.runNext();
    const request = {
      principal: "alice",
      key: "snapshot-consumer-create-0001",
      input: { form: FORM, space: "space", name: "consumer", spec: { target: first.resourceUid } },
    };
    const pending = engine.acceptCreate(request);
    await entered.promise;
    request.input.spec.target = "mutated-target";
    request.input.space = "mutated-space";
    release.resolve();
    const op = await pending;
    expect(
      db.query("SELECT space,spec_json FROM tf_v2_resources WHERE uid = ?").get(op.resourceUid),
    ).toEqual({ space: "space", spec_json: JSON.stringify({ target: first.resourceUid }) });
    expect(
      db
        .query("SELECT target_uid FROM tf_v2_operation_references WHERE operation_id = ?")
        .all(op.id),
    ).toEqual([{ target_uid: first.resourceUid }]);
  } finally {
    db.close();
  }
});
