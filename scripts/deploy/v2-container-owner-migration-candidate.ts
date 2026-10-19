import type { SqlStatement } from "../../src/ports.ts";
import {
  V2_CONTAINER_OWNER_READY,
  V2_CONTAINER_OWNER_RECIPE,
} from "../../src/takoform-v2/container-owner-schema.ts";

// Pure source candidate only: no CLI, migration registration/ordinal, database,
// environment, import-time IO, arbitrary supplied DDL or fallback baseline.
// A later owning executor MUST use one atomic batch and a genuine full100
// fixture/identity for union qualification. This recipe does not claim that proof.
const ASSERTION = "v2_container_owner_candidate_assertion";
const ownNames = V2_CONTAINER_OWNER_RECIPE.objects.map(({ name }) => `'${name}'`).join(", ");
const ownTables = V2_CONTAINER_OWNER_RECIPE.tables.map(({ name }) => `'${name}'`).join(", ");
const baseline = `(SELECT json_group_array(json_object('type', type, 'name', name, 'table', tbl_name, 'sql', sql))
  FROM (SELECT type, name, tbl_name, sql FROM main.sqlite_schema
    WHERE name <> '${ASSERTION}' AND name NOT IN (${ownNames})
      AND NOT (sql IS NULL AND tbl_name IN (${ownTables}))
    ORDER BY type, name COLLATE BINARY))`;

/** Fresh additive objects only. A collision, foreign dependency or failed
 * assertion aborts the required atomic executor; it must not retry/adopt/drop a
 * previously existing object. Schema conservation is not a native send grant,
 * canonical101 application, full100/data qualification or production permission.
 */
export function v2ContainerOwnerMigrationCandidate(): readonly SqlStatement[] {
  const statements: SqlStatement[] = [
    {
      sql: `CREATE TABLE main.${ASSERTION} (ok INTEGER NOT NULL CHECK (ok = 1), baseline TEXT NOT NULL)`,
    },
    {
      sql: `INSERT INTO main.${ASSERTION} (ok, baseline) SELECT CASE WHEN
      NOT EXISTS (SELECT 1 FROM main.sqlite_schema WHERE lower(substr(name, 1, 16)) = 'tf_v2_container_')
      AND NOT EXISTS (SELECT 1 FROM  main.sqlite_schema source  WHERE CASE WHEN lower(source.name) IN ('_cf_kv', '_cf_metadata')  AND source.sql IS NOT NULL AND instr(upper(source.sql), 'REFERENCES') = 0 THEN 0 ELSE EXISTS (SELECT 1 FROM  pragma_foreign_key_list(source.name, 'main') fk
         WHERE  source.type = 'table' AND lower(fk."table") IN (${ownTables})) END)
      THEN 1 ELSE 0 END, ${baseline}`,
    },
    ...V2_CONTAINER_OWNER_RECIPE.objects.map(({ sql }) => ({ sql })),
    {
      sql: `UPDATE main.${ASSERTION} SET ok = CASE WHEN ${V2_CONTAINER_OWNER_READY}
      AND baseline = ${baseline} THEN 1 ELSE 0 END`,
    },
    // Only the fresh candidate-owned assertion is dropped. No preexisting or
    // protected/shared object is altered, copied, renamed, rebuilt or removed.
    { sql: `DROP TABLE main.${ASSERTION}` },
  ];
  return Object.freeze(statements.map((value) => Object.freeze(value)));
}
