import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  FORWARD_WORKER_VERSION_FORM_URL,
  parseForwardWorkerVersionSpec,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  createForwardWorkerNative106Recipe,
  forwardWorkerNativePredecessorReady,
  forwardWorkerNativeSchemaReady,
} from "../src/takoform-v2/forward-worker-native-schema.ts";
import { FORWARD_NATIVE_BASE_OBJECTS } from "../src/takoform-v2/forward-worker-native-source.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import { createForwardV2NativeEffectCustody } from "../src/takoform-v2/worker-native-effects.ts";
import {
  createV2WorkerNativeIdentityMigrationRecipe,
  v2WorkerNativeIdentityDomainReady,
  v2WorkerOpaqueDeletionTableSql,
} from "../src/takoform-v2/worker-native-identity-schema.ts";

test("isolated local D1 accepts exact Forward native successor closure", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "forward-native-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "forward-native-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const db = await runtime.getD1Database("STATE_DB");
    for (const [index, migration] of MIGRATIONS.entries())
      for (const statement of frameHostMigrationSql(migration.sql)) {
        try {
          await db.prepare(statement).run();
        } catch {
          throw new Error(`canonical local D1 import failed at ${index + 1}`);
        }
      }
    for (const [index, recipe] of [
      createV2WorkerNativeIdentityMigrationRecipe(),
      createForwardWorkerNative106Recipe(),
    ].entries()) {
      if (index === 1) {
        const before = await db
          .prepare(`SELECT 1 AS ready WHERE ${forwardWorkerNativePredecessorReady()}`)
          .all();
        if (before.results.length !== 1) {
          const old = await db
            .prepare(`SELECT 1 AS ready WHERE ${v2WorkerNativeIdentityDomainReady("opaque255")}`)
            .all();
          const found = await db
            .prepare(
              "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('tf_v2_worker_native_effects','tf_v2_worker_native_deletions','tf_v2_worker_cron_matches','queue_v2_batch_executions') AND type IN ('table','index','trigger')",
            )
            .all();
          const expected = FORWARD_NATIVE_BASE_OBJECTS.map((entry) =>
            entry.name === "tf_v2_worker_native_deletions" && entry.type === "table"
              ? { ...entry, sql: v2WorkerOpaqueDeletionTableSql }
              : entry,
          );
          const changed = expected
            .filter(
              (entry) =>
                !found.results.some(
                  (row) =>
                    row.name === entry.name &&
                    row.type === entry.type &&
                    row.tbl_name === entry.tbl_name &&
                    row.sql === entry.sql,
                ),
            )
            .map((entry) => entry.name);
          throw new Error(
            `protected local D1 predecessor shape refused old=${old.results.length} catalog=${found.results.length}/${expected.length} changed=${changed.join(",")}`,
          );
        }
      }
      const statements = recipe.steps.flatMap((step) => step.statements);
      try {
        await db.batch(statements.map((statement) => db.prepare(statement)));
      } catch {
        throw new Error(`protected local D1 candidate ${index + 1} refused`);
      }
    }
    const rows = await db
      .prepare(`SELECT 1 AS ready WHERE ${forwardWorkerNativeSchemaReady()}`)
      .all();
    expect(rows.results).toEqual([{ ready: 1 }]);
    const sql = createD1Sql(db);
    const now = () => new Date();
    const engine = createTakoformV2Engine({
      sql,
      now,
      replayWindowSeconds: 3600,
      leaseMilliseconds: 60_000,
      authorize: async () => true,
      forms: {
        [FORWARD_WORKER_VERSION_FORM_URL]: {
          validateCreate: parseForwardWorkerVersionSpec,
          validateUpdate: parseForwardWorkerVersionSpec,
          backend: {
            id: "forward-native-d1-backend",
            targetKey: "target-a",
            async execute() {
              return { kind: "unknown" as const };
            },
            async reconcile() {
              return { kind: "unknown" as const };
            },
          },
        },
      },
    });
    const accepted = await engine.acceptCreate({
      principal: "org-a",
      key: "forward-d1-create-key",
      input: {
        form: FORWARD_WORKER_VERSION_FORM_URL,
        space: "production",
        name: "forward-d1-version",
        spec: {
          worker: { resourceUid: "worker-a" },
          bundle: { resourceUid: "bundle-a" },
          handlers: ["fetch"],
          containerBindings: [],
        },
      },
    });
    const store = createV2Store(sql);
    const operation = await store.operation(accepted.id);
    const resource = operation && (await store.resource(operation.resource_uid));
    if (!operation || !resource) throw new Error("local D1 accepted Operation missing");
    const leaseToken = "forward-d1-lease";
    const at = Date.now();
    expect(await store.claim(operation.id, leaseToken, at, at + 60_000)).toBe(true);
    expect(await store.markDispatch(operation.id, leaseToken, now().toISOString())).toBe(true);
    const identity = {
      execution: {
        operationId: operation.id,
        resourceUid: resource.uid,
        principal: operation.principal,
        action: operation.action,
        generation: operation.generation,
        form: resource.form_url,
        space: resource.space,
        name: resource.name,
        spec: JSON.parse(operation.accepted_spec_json),
        previousObserved: {},
        previousOutput: {},
        backendKey: operation.backend_key,
        backendId: operation.backend_id,
        targetKey: operation.target_key,
        leaseToken,
      },
      nativeIdentity: "forward-d1-script",
      closureDigest: `sha256:${"a".repeat(64)}` as const,
    };
    const custody = createForwardV2NativeEffectCustody({ sql, now });
    expect(await custody.grant(identity)).toBe("granted");
    expect(await custody.grant(identity)).toBe("already_granted");
    expect(await custody.confirm({ ...identity, receipt: "forward-d1-etag" })).toBe(true);
  } finally {
    await runtime.dispose();
  }
}, 120_000);
