import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertMigrationPragmaAssignments,
  assertMigrationPragmasDenied,
  isMigrationPragmaAssignment,
  prepareMigrationSql,
} from "../src/sqlite-migration-policy.ts";
import {
  SQLITE_MIGRATION_APPLICATION_FORM_URL,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0,
  sqliteMigrationApplicationReferences,
} from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import {
  SQLITE_MIGRATION_SET_FORM_URL,
  SQLITE_MIGRATION_SET_FORM_URL_0_2_0,
  SQLITE_MIGRATION_SET_FORM_URL_0_3_0,
} from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import corpus from "./fixtures/sqlite-migration-pragma-030-cases.json";

// Exact source-only owner corpus, tako0614/takoform-forms PR18 merge997a4deb.
// It admits one parser-extracted statement, never an entire migration file.
test("0.3 statement policy matches all 56 byte-pinned owning Form cases", () => {
  const bytes = readFileSync(
    new URL("./fixtures/sqlite-migration-pragma-030-cases.json", import.meta.url),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "be8c006466c18a25a2efd07c4244042609fe23e956f4aca2c5626d56403c5ce5",
  );
  expect(corpus.form).toBe(SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0);
  expect(corpus.migrationSetForm).toBe(SQLITE_MIGRATION_SET_FORM_URL_0_3_0);
  expect(corpus.cases).toHaveLength(56);
  for (const entry of corpus.cases) {
    expect(isMigrationPragmaAssignment(entry.sql), entry.id).toBe(entry.allowed);
  }
});

test("0.3 file framing keeps outside comments and separate statements without rewriting SQL", () => {
  const first = "-- outside the extracted statement\nPRAGMA defer_foreign_keys=ON;";
  const second = "\n/* between statements */ PRAGMA defer_foreign_keys=OFF;";
  expect(prepareMigrationSql(first + second + " -- trailing outside comment")).toEqual([
    first,
    second,
  ]);
  expect(isMigrationPragmaAssignment(first + second)).toBe(false);
  for (const sql of [
    "PRAGMA/* inside */ defer_foreign_keys=ON;",
    "PRAGMA defer_foreign_keys /* inside */ =ON;",
    "PRAGMA defer_foreign_keys=ON /* inside */;",
    "PRAGMA\ufeffdefer_foreign_keys=ON;",
    "PRAGMA defer_foreign_keys=ON\ufeff;",
  ]) {
    expect(() => assertMigrationPragmaAssignments(sql), sql).toThrow();
  }
  const vt = "PRAGMA\vdefer_foreign_keys\v=\vON;";
  expect(prepareMigrationSql(vt)).toEqual([vt]);
  // Joined PRAGMA+BOM is a native syntax error, not a successful PRAGMA
  // effect. The whole-file policy classifies that invalid command narrowly;
  // ordinary valid SQLite identifier continuation remains unchanged.
  const unicodeIdentifier = "CREATE TABLE foo\ufeffbar(value);";
  expect(prepareMigrationSql(unicodeIdentifier)).toEqual([unicodeIdentifier]);
  const outsideBom = "\ufeffSELECT 1;";
  expect(prepareMigrationSql(outsideBom)).toEqual([outsideBom]);
  // Native SQLite must execute these exact bytes separately; policy admission
  // does not assert that a particular engine supports the Form's VT spelling.
});

test("retained 0.2 rejects actual PRAGMA while preserving harmless native SQL literals", () => {
  expect(() =>
    assertMigrationPragmasDenied("SELECT 'PRAGMA defer_foreign_keys=ON';"),
  ).not.toThrow();
  for (const value of ["ON", "OFF", "TRUE", "FALSE", "1", "0"]) {
    expect(() => assertMigrationPragmasDenied(`PRAGMA defer_foreign_keys=${value};`)).toThrow();
  }
});

test("exact migration version constants retain old references without mixed-version aliases", () => {
  expect(SQLITE_MIGRATION_APPLICATION_FORM_URL).toBe(SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0);
  expect(SQLITE_MIGRATION_SET_FORM_URL).toBe(SQLITE_MIGRATION_SET_FORM_URL_0_3_0);
  const spec = { database: { resourceUid: "db" }, migrationSet: { resourceUid: "set" } };
  expect(sqliteMigrationApplicationReferences(spec).map((ref) => ref.formUrl)).toEqual([
    "https://edge.forms.takoform.com/forms/SQLiteDatabase/0.2.0/",
    SQLITE_MIGRATION_SET_FORM_URL_0_3_0,
  ]);
  expect(
    sqliteMigrationApplicationReferences(spec, SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0)[1]
      ?.formUrl,
  ).toBe(SQLITE_MIGRATION_SET_FORM_URL_0_2_0);
  expect(() =>
    sqliteMigrationApplicationReferences(spec, "https://unknown.example/" as never),
  ).toThrow();
});
