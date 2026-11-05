import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { root0106CatalogPredicate } from "../scripts/deploy/financial0104-schema-shape.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  parseContainerConsumerWorkerVersionSpec,
  validateContainerConsumerWorkerVersionUpdate,
} from "../src/takoform-v2/forms/container-consumer-specs.ts";
import {
  FORWARD_WORKER_VERSION_FORM_URL,
  parseForwardWorkerVersionSpec,
  parseWorkerVersionSpec,
  validateForwardWorkerVersionUpdate,
  validateWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  containerConsumerWorkerNativeSchemaReady,
  createContainerConsumerWorkerNativeSourceRecipe,
  createForwardWorkerNative106Recipe,
  forwardWorkerNativeSchemaReady,
} from "../src/takoform-v2/forward-worker-native-schema.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { v2WorkerInvocationSchemaReady } from "../src/takoform-v2/worker-invocation-schema.ts";
import {
  createContainerConsumerV2NativeDeletionCustody,
  createForwardV2NativeDeletionCustody,
  createV2NativeDeletionCustody,
} from "../src/takoform-v2/worker-native-deletions.ts";
import {
  createContainerConsumerV2NativeEffectCustody,
  createForwardV2NativeEffectCustody,
  createV2NativeEffectCustody,
} from "../src/takoform-v2/worker-native-effects.ts";
import { createV2WorkerNativeIdentityMigrationRecipe } from "../src/takoform-v2/worker-native-identity-schema.ts";

type Recipe = { readonly steps: readonly { readonly statements: readonly string[] }[] };
type Form =
  | typeof WORKER_VERSION_FORM_URL
  | typeof FORWARD_WORKER_VERSION_FORM_URL
  | typeof CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL;
const DIGEST = `sha256:${"a".repeat(64)}` as const;
function apply(db: Database, recipe: Recipe) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of recipe.steps) for (const statement of step.statements) db.exec(statement);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the assertion can already roll back */
    }
    throw error;
  }
}
function database() {
  const db = new Database(":memory:");
  migrateSqlite(db);
  db.exec("PRAGMA foreign_keys = ON");
  apply(db, createV2WorkerNativeIdentityMigrationRecipe());
  apply(db, createForwardWorkerNative106Recipe());
  return db;
}
type CatalogRow = { type: string; name: string; tbl_name: string; sql: string | null };
const catalog = (db: Database) =>
  db
    .query<CatalogRow, []>(
      "SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name",
    )
    .all();
const ready = (db: Database, consumer = false) =>
  db
    .query(
      `SELECT 1 WHERE ${consumer ? containerConsumerWorkerNativeSchemaReady() : forwardWorkerNativeSchemaReady()}`,
    )
    .all().length === 1;

// The actual engine owns acceptance, lease/dispatch and settlement. Controlled
// backend observations exercise Core native Version intent/cleanup, not a real
// provider, bound parent admission, Container journal or @2 parent-I/O original.
function fixture(
  onDelete?: (
    execution: V2Execution,
    port: ReturnType<typeof createContainerConsumerV2NativeDeletionCustody>,
  ) => Promise<void>,
) {
  const db = database(),
    raw = createSqliteSql(db);
  const statementSizes: { bytes: number; parameters: number }[] = [];
  const observe = (statement: string, parameters = 0) => {
    statementSizes.push({ bytes: new TextEncoder().encode(statement).byteLength, parameters });
  };
  const sql: Sql = {
    query(statement, params) {
      observe(statement, params?.length);
      return raw.query(statement, params);
    },
    run(statement, params) {
      observe(statement, params?.length);
      return raw.run(statement, params);
    },
    batch(statements) {
      for (const { sql, params } of statements) observe(sql, params?.length);
      return raw.batch(statements);
    },
  };
  const effects = (form: string) => {
    if (form === WORKER_VERSION_FORM_URL) return createV2NativeEffectCustody({ sql });
    if (form === FORWARD_WORKER_VERSION_FORM_URL)
      return createForwardV2NativeEffectCustody({ sql });
    if (form === CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL)
      return createContainerConsumerV2NativeEffectCustody({ sql });
    throw new Error("unexpected native effect Form");
  };
  const deletions = (form: string) => {
    if (form === WORKER_VERSION_FORM_URL) return createV2NativeDeletionCustody({ sql });
    if (form === FORWARD_WORKER_VERSION_FORM_URL)
      return createForwardV2NativeDeletionCustody({ sql });
    if (form === CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL)
      return createContainerConsumerV2NativeDeletionCustody({ sql });
    throw new Error("unexpected native deletion Form");
  };
  const log: { action: string; form: string; generation: number; grant: string }[] = [];
  const failures: unknown[] = [];
  const execute: V2Form["backend"]["execute"] = async (execution: V2Execution) => {
    if (execution.action !== "delete") {
      const port = effects(execution.form);
      const identity = {
        execution,
        nativeIdentity: `local-version-${execution.resourceUid}-${execution.generation}`,
        closureDigest: DIGEST,
      };
      const grant = await port.grant(identity);
      log.push({
        action: execution.action,
        form: execution.form,
        generation: execution.generation,
        grant,
      });
      expect(grant).toBe("granted");
      expect(await port.grant(identity)).toBe("already_granted");
      expect(await port.inspect(identity)).toEqual({ kind: "sent" });
      expect(
        await port.grant({
          ...identity,
          execution: { ...execution, principal: "foreign-principal" },
        }),
      ).toBe("conflict");
      expect(
        await port.grant({ ...identity, execution: { ...execution, targetKey: "foreign-target" } }),
      ).toBe("conflict");
      expect(
        await port.grant({
          ...identity,
          execution: { ...execution, generation: execution.generation + 1 },
        }),
      ).toBe("conflict");
      const receipt = `controlled-version-receipt-${execution.generation}`;
      expect(await port.acknowledge({ ...identity, receipt })).toBe(true);
      expect(await port.confirm({ ...identity, receipt })).toBe(true);
    } else {
      const port = deletions(execution.form);
      if (onDelete) {
        await onDelete(execution, port);
        return { kind: "unknown" };
      }
      expect(await port.stageNext(execution)).toBe("more");
      expect(await port.stageNext(execution)).toBe("ready");
      for (let count = 0; count < 3; count++) {
        const item = await port.next(execution);
        if (!item) break;
        const receipt = item.uploadReceipt;
        if (!receipt) throw new Error("confirmed source missing");
        // Confirmed upload originals already bind this receipt. Qualification
        // is only for a previously unconfirmed source; overwriting a retained
        // upload receipt must remain refused by the unchanged source guard.
        expect(await port.qualifySource(item, receipt)).toBe(false);
        const grant = await port.grant(item, receipt);
        log.push({
          action: "delete",
          form: execution.form,
          generation: item.sourceGeneration,
          grant,
        });
        expect(grant).toBe("granted");
        expect(await port.grant(item, receipt)).toBe("already_granted");
        expect(await port.acknowledge(item, `controlled-delete-ack-${count}`)).toBe(true);
        expect(await port.confirmAbsent(item, `controlled-absence-${count}`)).toBe(true);
      }
      expect(await port.allAbsent(execution)).toBe(true);
    }
    return { kind: "complete", observed: { ready: true }, output: {} };
  };
  const backend = {
    id: "native-source-fixture",
    targetKey: "target-a",
    async execute(execution: V2Execution) {
      try {
        return await execute(execution);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
    reconcile: async () => ({ kind: "unknown" as const }),
  };
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [WORKER_VERSION_FORM_URL]: {
        validateCreate: parseWorkerVersionSpec,
        validateUpdate: validateWorkerVersionUpdate,
        backend,
      },
      [FORWARD_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseForwardWorkerVersionSpec,
        validateUpdate: validateForwardWorkerVersionUpdate,
        backend,
      },
      [CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseContainerConsumerWorkerVersionSpec,
        validateUpdate: validateContainerConsumerWorkerVersionUpdate,
        backend,
      },
    },
  });
  const spec = {
    worker: { resourceUid: "worker-a" },
    bundle: { resourceUid: "bundle-a" },
    handlers: ["fetch"],
    containerBindings: [],
  };
  let serial = 0;
  const create = async (form: Form) => {
    const accepted = await engine.acceptCreate({
      principal: "org-a",
      key: `native-source-create-${++serial}`,
      input: {
        form,
        name: `version-${serial}`,
        space: "test",
        spec:
          form === WORKER_VERSION_FORM_URL
            ? { worker: spec.worker, bundle: spec.bundle, handlers: spec.handlers }
            : spec,
      },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    return accepted;
  };
  return { db, sql, engine, spec, create, log, failures, statementSizes };
}

test("consumer native source preserves immutable registered106 bytes and changes exactly the four coupled guards", async () => {
  const old = createForwardWorkerNative106Recipe();
  const oldSql = old.steps.flatMap((step) => step.statements).join("\n") + "\n";
  expect(`sha256:${createHash("sha256").update(oldSql).digest("hex")}`).toBe(
    "sha256:1ccf6f88ebddac1f54b7f73a1dfa6ac8a05a5962bf8b649f040b20e4f88320e5",
  );
  const f = fixture();
  try {
    await f.create(FORWARD_WORKER_VERSION_FORM_URL);
    const before = catalog(f.db),
      rows = await f.sql.query("SELECT * FROM tf_v2_worker_native_effects");
    expect(ready(f.db)).toBe(true);
    expect(ready(f.db, true)).toBe(false);
    const recipe = createContainerConsumerWorkerNativeSourceRecipe();
    expect(recipe.registered).toBe(false);
    expect(recipe.predecessor).toBe(old.name);
    apply(f.db, recipe);
    expect(await f.sql.query("SELECT * FROM tf_v2_worker_native_effects")).toEqual(rows);
    const previous = new Map(before.map((row) => [String(row.name), row]));
    const changed = catalog(f.db)
      .filter((row) => JSON.stringify(previous.get(String(row.name))) !== JSON.stringify(row))
      .map((row) => row.name)
      .sort();
    expect(changed).toEqual([
      "tf_v2_worker_native_deletion_presend_absence_guard",
      "tf_v2_worker_native_deletion_send_guard",
      "tf_v2_worker_native_deletion_stage_guard",
      "tf_v2_worker_native_effect_insert_guard",
    ]);
    expect(ready(f.db)).toBe(true);
    expect(ready(f.db, true)).toBe(true);
    expect(f.db.query("SELECT * FROM pragma_foreign_key_check").all()).toEqual([]);
    await f.create(FORWARD_WORKER_VERSION_FORM_URL);
    expect(f.log.map((row) => row.grant)).toEqual(["granted", "granted"]);
  } finally {
    f.db.close();
  }
});

test("consumer source preserves accepted legacy and Forward native cleanup under the new guards", async () => {
  for (const form of [WORKER_VERSION_FORM_URL, FORWARD_WORKER_VERSION_FORM_URL] as const) {
    const f = fixture();
    try {
      apply(f.db, createContainerConsumerWorkerNativeSourceRecipe());
      const created = await f.create(form);
      await f.engine.acceptDelete({
        principal: "org-a",
        key: "compatible-source-delete",
        uid: created.resourceUid,
        expectedGeneration: 1,
      });
      const deleted = await f.engine.runNext();
      if (f.failures.length !== 0) throw f.failures[0];
      expect(deleted?.status).toBe("succeeded");
      expect(f.log).toEqual([
        { action: "create", form, generation: 1, grant: "granted" },
        { action: "delete", form, generation: 1, grant: "granted" },
      ]);
      const rows = await f.sql.query(
        "SELECT confirmed_absence_receipt FROM tf_v2_worker_native_deletions",
      );
      expect(rows).toHaveLength(1);
      expect(typeof rows[0]?.confirmed_absence_receipt).toBe("string");
      expect(ready(f.db, true)).toBe(true);
      expect(f.db.query("SELECT * FROM pragma_foreign_key_check").all()).toEqual([]);
    } finally {
      f.db.close();
    }
  }
});

test("exact 106 deploy catalog refuses the consumer successor while the runtime remains compatible", () => {
  const db = database();
  const exact106 = () => db.query(`SELECT 1 WHERE ${root0106CatalogPredicate()}`).all().length;
  try {
    expect(exact106()).toBe(1);
    apply(db, createContainerConsumerWorkerNativeSourceRecipe());
    expect(ready(db)).toBe(true);
    expect(ready(db, true)).toBe(true);
    expect(exact106()).toBe(0);
  } finally {
    db.close();
  }
});

test("consumer source runs actual accepted0.8 create/update/delete custody with one grant per original and no direct resource/effect inserts", async () => {
  const f = fixture();
  try {
    apply(f.db, createContainerConsumerWorkerNativeSourceRecipe());
    const created = await f.create(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
    await f.engine.acceptUpdate({
      principal: "org-a",
      key: "native-source-update",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: f.spec,
    });
    const updated = await f.engine.runNext();
    if (f.failures.length !== 0) throw f.failures[0];
    expect(updated?.status).toBe("succeeded");
    await f.engine.acceptDelete({
      principal: "org-a",
      key: "native-source-delete",
      uid: created.resourceUid,
      expectedGeneration: 2,
    });
    const deleted = await f.engine.runNext();
    if (f.failures.length !== 0) throw f.failures[0];
    expect(deleted?.status).toBe("succeeded");
    expect(f.log.map(({ action, generation, grant }) => ({ action, generation, grant }))).toEqual([
      { action: "create", generation: 1, grant: "granted" },
      { action: "update", generation: 2, grant: "granted" },
      { action: "delete", generation: 2, grant: "granted" },
      { action: "delete", generation: 1, grant: "granted" },
    ]);
    expect(
      (
        await f.sql.query("SELECT confirmed_absence_receipt FROM tf_v2_worker_native_deletions")
      ).every((row) => typeof row.confirmed_absence_receipt === "string"),
    ).toBe(true);
    // Measure actual engine/custody statements, including cleanup, against the
    // hosted D1 caps rather than relying on local SQLite compilation alone.
    // https://developers.cloudflare.com/d1/platform/limits/
    const maxBytes = Math.max(...f.statementSizes.map(({ bytes }) => bytes));
    console.info(
      JSON.stringify({
        kind: "native-custody-statement-budget",
        maxBytes,
        headroomBytes: 100_000 - maxBytes,
      }),
    );
    expect(maxBytes).toBeLessThanOrEqual(100_000);
    expect(Math.max(...f.statementSizes.map(({ parameters }) => parameters))).toBeLessThanOrEqual(
      100,
    );
  } finally {
    f.db.close();
  }
});

for (const phase of ["grant", "inspect", "absence", "allAbsent"] as const) {
  test(`consumer deletion ${phase} still seals the native catalog after the schema precheck`, async () => {
    let interrupted = 0;
    let isolation: { invocationReady: boolean; nativeReady: boolean } | undefined;
    const f = fixture(async (execution, port): Promise<void> => {
      expect(await port.stageNext(execution)).toBe("more");
      expect(await port.stageNext(execution)).toBe("ready");
      const item = await port.next(execution);
      if (!item?.uploadReceipt) throw new Error("actual accepted source is missing");
      if (phase !== "grant") expect(await port.grant(item, item.uploadReceipt)).toBe("granted");
      if (phase === "allAbsent")
        expect(await port.confirmAbsent(item, "controlled-absence")).toBe(true);
      const guard = f.db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_schema WHERE name = 'tf_v2_worker_native_deletion_stage_guard'",
        )
        .get();
      if (!guard) throw new Error("actual native guard is missing");
      const run = f.sql.run,
        query = f.sql.query;
      const interpose = (statement: string) => {
        const matches =
          phase === "grant"
            ? statement.includes("SET grant_lease_token = ?")
            : phase === "inspect"
              ? statement.includes("WHERE op.id = ? AND op.action = 'delete'")
              : phase === "absence"
                ? statement.includes("SET confirmed_absence_receipt = ?")
                : statement.includes("item.confirmed_absence_receipt IS NULL) LIMIT 1");
        if (matches && interrupted === 0) {
          interrupted++;
          f.db.exec("DROP TRIGGER tf_v2_worker_native_deletion_stage_guard");
          // Isolate the native seal: invocation readiness must stay true.
          isolation = {
            invocationReady:
              f.db.query(`SELECT 1 WHERE ${v2WorkerInvocationSchemaReady("cron")}`).all().length ===
              1,
            nativeReady: ready(f.db),
          };
        }
      };
      f.sql.run = (statement, params) => {
        interpose(statement);
        return run(statement, params);
      };
      f.sql.query = (statement, params) => {
        interpose(statement);
        return query(statement, params);
      };
      try {
        if (phase === "grant") expect(await port.grant(item, item.uploadReceipt)).toBe("unknown");
        else if (phase === "inspect") expect(await port.inspect(item)).toEqual({ kind: "unknown" });
        else if (phase === "absence")
          expect(await port.confirmAbsent(item, "controlled-absence")).toBe(false);
        else expect(await port.allAbsent(execution)).toBe(false);
        // Assert outside custody: its expected catch must not hide a failed
        // isolation check as an ordinary unknown/false refusal.
        expect(isolation).toEqual({ invocationReady: true, nativeReady: false });
        expect(interrupted).toBe(1);
      } finally {
        f.sql.run = run;
        f.sql.query = query;
        f.db.exec(guard.sql);
      }
    });
    try {
      apply(f.db, createContainerConsumerWorkerNativeSourceRecipe());
      const created = await f.create(CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL);
      await f.engine.acceptDelete({
        principal: "org-a",
        key: `guard-race-${phase}`,
        uid: created.resourceUid,
        expectedGeneration: 1,
      });
      await f.engine.runNext();
      if (f.failures.length !== 0) throw f.failures[0];
      expect(interrupted).toBe(1);
    } finally {
      f.db.close();
    }
  });
}

test("compatible runtime rejects every partial effect/deletion guard cohort while keeping exact old and full new closures", () => {
  const db = database();
  try {
    const recipe = createContainerConsumerWorkerNativeSourceRecipe();
    const next =
      recipe.steps[1]?.statements.filter((sql) => sql.startsWith("CREATE TRIGGER")) ?? [];
    expect(next).toHaveLength(4);
    const old = next.map((sql) => {
      const name = /CREATE TRIGGER (\w+)/u.exec(sql)?.[1];
      if (!name) throw new Error("missing trigger name");
      const row = db
        .query<{ sql: string | null }, [string]>(
          "SELECT sql FROM main.sqlite_schema WHERE name = ?",
        )
        .get(name);
      if (!row || typeof row.sql !== "string") throw new Error("old trigger missing");
      return { name, sql: row.sql };
    });
    for (let mask = 0; mask < 16; mask++) {
      db.transaction(() => {
        old.forEach((entry, index) => {
          db.exec(`DROP TRIGGER main.${entry.name}`);
          db.exec(mask & (1 << index) ? (next[index] ?? "") : entry.sql);
        });
      })();
      expect(ready(db)).toBe(mask === 0 || mask === 15);
      expect(ready(db, true)).toBe(mask === 15);
      expect(db.query(`SELECT 1 WHERE ${root0106CatalogPredicate()}`).all().length).toBe(
        mask === 0 ? 1 : 0,
      );
    }
  } finally {
    db.close();
  }
});

test("consumer source refuses an unknown predecessor and cannot be repeated against its successor", () => {
  const db = database();
  try {
    db.exec(
      "CREATE TRIGGER foreign_native_guard BEFORE INSERT ON tf_v2_worker_native_effects BEGIN SELECT 1; END",
    );
    const before = catalog(db);
    expect(() => apply(db, createContainerConsumerWorkerNativeSourceRecipe())).toThrow();
    expect(catalog(db)).toEqual(before);
    db.exec("DROP TRIGGER foreign_native_guard");
    apply(db, createContainerConsumerWorkerNativeSourceRecipe());
    const after = catalog(db);
    expect(() => apply(db, createContainerConsumerWorkerNativeSourceRecipe())).toThrow();
    expect(catalog(db)).toEqual(after);
  } finally {
    db.close();
  }
});

test("consumer cohort marker cannot authorize modified SQL outside the exact old/new catalog", () => {
  const db = database();
  try {
    const recipe = createContainerConsumerWorkerNativeSourceRecipe();
    const names =
      recipe.steps[1]?.statements.flatMap((statement) => {
        const name = /^CREATE TRIGGER (\w+)/u.exec(statement)?.[1];
        return name ? [name] : [];
      }) ?? [];
    expect(names).toHaveLength(4);
    const marker =
      "IN ('https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/', 'https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/', 'https://edge.forms.takoform.com/forms/WorkerVersion/0.8.0/')";
    for (const name of names) {
      const old = db
        .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_schema WHERE name = ?")
        .get(name);
      if (!old?.sql.includes("BEGIN")) throw new Error("old native guard is missing");
      db.exec(`DROP TRIGGER main.${name}`);
      db.exec(old.sql.replace("BEGIN", `/* ${marker} */ BEGIN`));
    }
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND instr(sql, ?) > 0",
        )
        .get(marker)?.n,
    ).toBe(4);
    expect(ready(db)).toBe(false);
    expect(ready(db, true)).toBe(false);
    expect(db.query(`SELECT 1 WHERE ${root0106CatalogPredicate()}`).all()).toHaveLength(0);
    const before = catalog(db);
    expect(() => apply(db, recipe)).toThrow();
    expect(catalog(db)).toEqual(before);
  } finally {
    db.close();
  }
});

test("failed source replacement rolls back all four guards and preserves populated accepted effects", async () => {
  const f = fixture();
  try {
    await f.create(FORWARD_WORKER_VERSION_FORM_URL);
    const before = catalog(f.db),
      rows = await f.sql.query("SELECT * FROM tf_v2_worker_native_effects");
    const recipe = createContainerConsumerWorkerNativeSourceRecipe();
    const broken = {
      steps: recipe.steps.map((step) =>
        step.name === "replace-guards"
          ? {
              statements: [
                ...step.statements,
                "SELECT absent_source_fault_column FROM tf_v2_worker_native_effects",
              ],
            }
          : step,
      ),
    };
    expect(() => apply(f.db, broken)).toThrow();
    expect(catalog(f.db)).toEqual(before);
    expect(await f.sql.query("SELECT * FROM tf_v2_worker_native_effects")).toEqual(rows);
    expect(ready(f.db)).toBe(true);
    expect(ready(f.db, true)).toBe(false);
  } finally {
    f.db.close();
  }
});

test("consumer successor still rejects foreign catalog, incoming deletion FKs and temporary source shadows", () => {
  const db = database();
  try {
    apply(db, createContainerConsumerWorkerNativeSourceRecipe());
    db.exec(
      "CREATE TRIGGER foreign_native_guard BEFORE INSERT ON tf_v2_worker_native_effects BEGIN SELECT 1; END",
    );
    expect(ready(db)).toBe(false);
    expect(ready(db, true)).toBe(false);
    db.exec("DROP TRIGGER foreign_native_guard");
    db.exec(
      "CREATE TABLE incoming_native_reference(id TEXT REFERENCES tf_v2_worker_native_deletions(delete_operation_id))",
    );
    expect(ready(db)).toBe(false);
    expect(ready(db, true)).toBe(false);
    db.exec("DROP TABLE incoming_native_reference");
    db.exec(
      "CREATE TEMP TABLE _tf_container_consumer_native_source_assert(ok INTEGER PRIMARY KEY)",
    );
    expect(ready(db)).toBe(false);
    expect(ready(db, true)).toBe(false);
  } finally {
    db.close();
  }
});

test("consumer source requires foreign-key and CHECK enforcement before and after the candidate transition", () => {
  const db = database();
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    const before = catalog(db);
    expect(ready(db)).toBe(false);
    expect(() => apply(db, createContainerConsumerWorkerNativeSourceRecipe())).toThrow();
    expect(catalog(db)).toEqual(before);
    db.exec("PRAGMA foreign_keys = ON");
    apply(db, createContainerConsumerWorkerNativeSourceRecipe());
    db.exec("PRAGMA ignore_check_constraints = ON");
    expect(ready(db)).toBe(false);
    expect(ready(db, true)).toBe(false);
    db.exec("PRAGMA ignore_check_constraints = OFF");
    expect(ready(db)).toBe(true);
    expect(ready(db, true)).toBe(true);
  } finally {
    db.close();
  }
});
