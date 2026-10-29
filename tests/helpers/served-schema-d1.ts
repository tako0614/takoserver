// Local Miniflare D1 built from the served schema: migrations through 0100, the
// Auth103 canonical source, Financial 0104 and Root 0105, behind the same strict
// D1 driver and Sql wrappers the Worker composes. Synthetic DATA only.
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { createAuth103CanonicalSourceArtifacts } from "../../scripts/deploy/auth103-canonical-recipes.ts";
import { MIGRATIONS } from "../../src/db-schema.ts";
import { FINANCIAL_0104_DDL } from "../../src/financial-0104-source-contract.ts";
import {
  createFreshNativeSql,
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../../src/money-cutover-sql.ts";
import type { Sql } from "../../src/ports.ts";
import { ROOT_0105_DDL } from "../../src/root-0105-org-capture-triggers.ts";
import { createD1Sql } from "../../src/sql-d1.ts";
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";

const ROOT = resolve(import.meta.dir, "../..");
const WRITER = `sha256:${"c".repeat(64)}`;

export const SERVED_SQL_MODES = ["money", "fresh-native"] as const;
export type ServedSqlMode = (typeof SERVED_SQL_MODES)[number];

/** The caller owns `runtime.dispose()`. */
export async function createServedSchemaD1(mode: ServedSqlMode) {
  const id = `served-schema-d1-${crypto.randomUUID()}`;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: id,
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('local only'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    // Preserve native metadata creation after the first nonempty source. Only
    // fresh fixture genesis is grouped; request/settlement batches stay native.
    const groups = [
      ...MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100).map(({ sql }) => sql),
      ...createAuth103CanonicalSourceArtifacts(ROOT).files.map(({ sql }) => sql),
      FINANCIAL_0104_DDL,
      ROOT_0105_DDL,
    ]
      .map(frameHostMigrationSql)
      .filter((statements) => statements.length > 0);
    const [first, ...rest] = groups;
    const remaining = rest.flat();
    if (first) await database.batch(first.map((statement) => database.prepare(statement)));
    if (remaining.length > 0)
      await database.batch(remaining.map((statement) => database.prepare(statement)));
    const raw = createD1Sql(database.withSession("first-primary"), {
      acknowledgement: "explicit-d1-result",
    });
    let sql: Sql;
    if (mode === "money") {
      const present = await raw.query(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='money_cutover_writer_permit'",
      );
      if (present.length === 0)
        for (const ddl of [
          MONEY_CUTOVER_FREEZE_DDL,
          MONEY_CUTOVER_PERMIT_DDL,
          MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
          MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
        ])
          await raw.run(ddl);
      await raw.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [WRITER]);
      sql = createMoneyCutoverSql(raw, WRITER);
    } else sql = createFreshNativeSql(raw);
    return { runtime, database, raw, sql };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
