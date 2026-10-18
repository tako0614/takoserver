import { MIGRATIONS } from "./db-schema.ts";
import type { SqlStatement } from "./ports.ts";
import { frameHostMigrationSql } from "./sqlite-migration-policy.ts";

// Unregistered, fixed source candidate only. No caller SQL or registration/apply
// entrypoint. The existing migration owner must execute ALL statements inside
// one transaction; defer_foreign_keys is intentionally not switched OFF before
// COMMIT. SQLite, native D1, and exact101/102 union qualification remain pending.
const ASSERTION = "auth103_principal_assertion";
const ROWS = "auth103_principal_rows";
const LINKS = "auth103_principal_links";
const SCHEMA = "auth103_principal_schema";
const NEXT = "auth103_principals_next";
const FIELDS = "id, provider, provider_subject, email, display_name, created_at";
const OWNER_TRIGGER = "personal_organizations_owner_insert";

// Read canonical source as data; do not duplicate its historical body here.
// Statement framing belongs to the existing trusted Host schema owner. Only
// the fixed header is selected; an unsupported source spelling fails closed.
const sourcePrefix = /^(?:[ \t\r\n]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;
const ownerTriggerHeader =
  /^CREATE TRIGGER(?: IF NOT EXISTS)? personal_organizations_owner_insert(?=[ \t\r\n])/u;

function canonicalOwnerTrigger() {
  const prefix = MIGRATIONS.filter(
    ({ name }) =>
      /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) &&
      Number(name.slice(0, 4)) >= 1 &&
      Number(name.slice(0, 4)) <= 100,
  );
  if (
    prefix.length !== 100 ||
    prefix.some(({ name }, index) => Number(name.slice(0, 4)) !== index + 1)
  ) {
    throw new Error("canonical Principal predecessor source is unavailable");
  }
  const matches = prefix.flatMap(({ sql }) =>
    frameHostMigrationSql(sql).flatMap((source) => {
      const definition = source.replace(sourcePrefix, "");
      return ownerTriggerHeader.test(definition) ? [{ source, definition }] : [];
    }),
  );
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    throw new Error("canonical Principal dependency source is unavailable");
  }
  // SQLite stores CREATE TRIGGER without IF NOT EXISTS, source-prefix comments,
  // or the final statement separator. The trigger body remains byte-exact.
  const catalog = match.definition
    .replace(/^CREATE TRIGGER IF NOT EXISTS /u, "CREATE TRIGGER ")
    .replace(/[ \t\r\n]+$/u, "")
    .replace(/;$/u, "");
  return Object.freeze({ source: match.source, catalog });
}

const ownerTrigger = canonicalOwnerTrigger();

// From nonprotected 0016 source, matched to canonical100 catalog SHA-256
// 6d45301559d3f888cc26b99d666aed4f40b31f69bb55cd033cfbf5062b023fd3.
const legacyDefinition = `CREATE TABLE "principals" (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject),
  CHECK (provider IN ('takos-id', 'google', 'github'))
)`;
const expandedDefinition = legacyDefinition.replace(
  "'takos-id', 'google', 'github'",
  "'takos-id', 'google', 'github', 'shared-account'",
);
const literal = (value: string): string => `'${value.replace(/'/gu, "''")}'`;
const excluded = [ASSERTION, ROWS, LINKS, SCHEMA, NEXT].map(literal).join(", ");
const conservedSchema = `SELECT type, name, tbl_name, sql FROM main.sqlite_schema
  WHERE tbl_name <> 'principals' AND name NOT IN (${excluded})`;
// Only these native-reserved tables with no possible FK clause are omitted.
// REFERENCES is mandatory for every SQLite FK; a matching user table with a FK
// stays in this materialized source and reaches the unchanged original guard.
const inbound = `WITH auth103_inbound_catalog AS MATERIALIZED (
  SELECT * FROM main.sqlite_schema WHERE type = 'table'
    AND NOT (name COLLATE NOCASE IN ('_cf_kv', '_cf_metadata')
      AND sql IS NOT NULL AND sql NOT GLOB '*[Rr][Ee][Ff][Ee][Rr][Ee][Nn][Cc][Ee][Ss]*')
)
SELECT source.name AS relation, fk.*
  FROM auth103_inbound_catalog source JOIN pragma_foreign_key_list(source.name, 'main') fk
  WHERE source.type = 'table' AND lower(fk."table") = 'principals'`;
const dependentObjects = `SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE
  (tbl_name = 'principals' AND type = 'trigger')
  OR (type IN ('trigger', 'view') AND instr(lower(sql), 'principals') > 0)`;
const originalOwnerTrigger = `
  (SELECT count(*) FROM (${dependentObjects})) = 1
  AND NOT EXISTS (SELECT 1 FROM (${dependentObjects}) WHERE (
    type = 'trigger' AND name = ${literal(OWNER_TRIGGER)}
    AND tbl_name = 'personal_organizations' AND sql = ${literal(ownerTrigger.catalog)}
  ) IS NOT TRUE)`;
const sameRows = (table: string): string => `
  NOT EXISTS (SELECT rowid, ${FIELDS} FROM main.${table}
    EXCEPT SELECT * FROM main.${ROWS})
  AND NOT EXISTS (SELECT * FROM main.${ROWS}
    EXCEPT SELECT rowid, ${FIELDS} FROM main.${table})`;
const sameLinks = `
  NOT EXISTS (SELECT rowid, * FROM main.personal_organizations
    EXCEPT SELECT * FROM main.${LINKS})
  AND NOT EXISTS (SELECT * FROM main.${LINKS}
    EXCEPT SELECT rowid, * FROM main.personal_organizations)`;
const sameSchema = `
  NOT EXISTS (SELECT * FROM main.${SCHEMA} EXCEPT ${conservedSchema})
  AND NOT EXISTS (${conservedSchema} EXCEPT SELECT * FROM main.${SCHEMA})`;
const originalIndexes = `
  (SELECT count(*) FROM pragma_index_list('principals', 'main')) = 2
  AND (SELECT count(*) FROM pragma_index_list('principals', 'main')
    WHERE "unique" = 1 AND partial = 0 AND origin = 'pk') = 1
  AND (SELECT count(*) FROM pragma_index_list('principals', 'main')
    WHERE "unique" = 1 AND partial = 0 AND origin = 'u') = 1`;

const statements = [
  "PRAGMA defer_foreign_keys = ON",
  `CREATE TABLE main.${ASSERTION} (ok INTEGER NOT NULL CHECK (ok = 1))`,
  `INSERT INTO main.${ASSERTION} (ok) SELECT CASE WHEN
    (SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = 'principals')
      = ${literal(legacyDefinition)}
    AND ${originalIndexes}
    AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema
      WHERE lower(name) IN (${[ROWS, LINKS, SCHEMA, NEXT].map(literal).join(", ")}))
    AND ${originalOwnerTrigger}
    AND (SELECT count(*) FROM (${inbound})) = 1
    AND NOT EXISTS (SELECT 1 FROM (${inbound}) WHERE (
      relation = 'personal_organizations' AND seq = 0 AND "from" = 'principal_id'
      AND "to" = 'id' AND on_update = 'NO ACTION' AND on_delete = 'NO ACTION'
      AND match = 'NONE') IS NOT TRUE)
    AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
    THEN 1 ELSE 0 END`,
  `CREATE TABLE main.${ROWS} AS SELECT rowid AS captured_rowid, ${FIELDS}
    FROM main.principals`,
  `CREATE TABLE main.${LINKS} AS SELECT rowid AS captured_rowid, *
    FROM main.personal_organizations`,
  `CREATE TABLE main.${SCHEMA} AS ${conservedSchema}`,
  expandedDefinition.replace('CREATE TABLE "principals"', `CREATE TABLE main.${NEXT}`),
  `DROP TRIGGER main.${OWNER_TRIGGER}`,
  "DROP TABLE main.principals",
  `ALTER TABLE main.${NEXT} RENAME TO principals`,
  // Populate the final parent after rename, retaining the same child rows and
  // letting its INSERTs reconcile deferred references before COMMIT.
  `INSERT INTO main.principals (rowid, ${FIELDS})
    SELECT captured_rowid, ${FIELDS} FROM main.${ROWS}`,
  `UPDATE main.${ASSERTION} SET ok = CASE WHEN ${sameRows("principals")} THEN 1 ELSE 0 END`,
  ownerTrigger.source,
  `UPDATE main.${ASSERTION} SET ok = CASE WHEN
    (SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = 'principals')
      = ${literal(expandedDefinition)}
    AND ${originalIndexes} AND ${originalOwnerTrigger} AND ${sameRows("principals")}
    AND ${sameLinks} AND ${sameSchema}
    AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
    THEN 1 ELSE 0 END`,
  `DROP TABLE main.${SCHEMA}`,
  `DROP TABLE main.${LINKS}`,
  `DROP TABLE main.${ROWS}`,
  `DROP TABLE main.${ASSERTION}`,
];

/** Fail closed on any predecessor, dependency, collision, or conservation
 * mismatch. The narrow source route admits only the observed NO ACTION child;
 * the one canonical100 owner trigger is temporarily removed and restored from
 * its original source. Unknown incoming refs/custom indexes/triggers/views need
 * a separately reviewed preserving transition. A returned recipe is never
 * native/target authority.
 */
export function authPrincipalProviderTransitionStatements(): readonly SqlStatement[] {
  return Object.freeze(statements.map((sql) => Object.freeze({ sql })));
}

/** Full source assembly only; its owner still supplies the transaction. */
export const authPrincipalProviderTransitionDDL = `${statements.join(";\n")} ;`;
