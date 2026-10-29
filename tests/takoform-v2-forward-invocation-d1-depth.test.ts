import { expect, test } from "bun:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { root0106Recipe } from "../scripts/deploy/root0106-recipe.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { createForwardV2WorkerInvocationLifecycle } from "../src/takoform-v2/worker-invocation-custody.ts";
import { createV2WorkerNativeIdentityMigrationRecipe } from "../src/takoform-v2/worker-native-identity-schema.ts";

test("Forward invocation authorization compiles within local D1 expression depth and refuses an absent parent", async () => {
  const runtime = new Miniflare({
    cf: false,
    log: new Log(LogLevel.ERROR),
    workers: [
      {
        config: {
          name: "forward-invocation-depth",
          type: "worker",
          compatibilityDate: "2026-08-18",
          triggers: [],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('local fixture');}};",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "forward-invocation-depth" } },
        },
      },
    ],
  });
  try {
    const db = await runtime.getD1Database("STATE_DB");
    // Existing source recipes in fresh local D1 only; no live migration.
    for (const migration of MIGRATIONS)
      for (const statement of frameHostMigrationSql(migration.sql))
        await db.prepare(statement).run();
    await db.batch(
      createV2WorkerNativeIdentityMigrationRecipe()
        .steps.flatMap((step) => step.statements)
        .map((sql) => db.prepare(sql)),
    );
    // Select the existing exact registered bytes as well as the new runtime
    // expression. A runtime optimization must never silently repin a recipe.
    await db.batch(frameHostMigrationSql(root0106Recipe().sql).map((sql) => db.prepare(sql)));
    const raw = createD1Sql(db);
    const errors: string[] = [];
    const changes: number[] = [];
    const sql: Sql = {
      query: raw.query,
      batch: raw.batch,
      async run(statement, params) {
        try {
          const result = await raw.run(statement, params);
          changes.push(result.changes);
          return result;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    };
    const lifecycle = createForwardV2WorkerInvocationLifecycle({ sql });
    expect(
      await lifecycle.beginSend({ invocationId: "absent-parent", custodyToken: "fixture-only" }),
    ).toBe(false);
    // False alone can hide a swallowed D1 parse error. The real guarded UPDATE
    // must execute and report zero changes without any parent authority.
    expect(errors).toEqual([]);
    expect(changes).toEqual([0]);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM tf_v2_worker_invocations").first())?.n,
    ).toBe(0);
  } finally {
    await runtime.dispose();
  }
}, 60_000);
