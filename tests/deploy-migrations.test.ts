import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalSchemaShape,
  pendingMigrations,
  readMigrationArtifact,
} from "../scripts/deploy/migrations.ts";

describe("ordered D1 migration state", () => {
  test("qualifies exact gap-free migration names and bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-migrations-"));
    try {
      writeFileSync(join(root, "0001_first.sql"), "CREATE TABLE first (id TEXT);\n");
      writeFileSync(join(root, "0002_second.sql"), "ALTER TABLE first ADD COLUMN n INTEGER;\n");
      const artifact = readMigrationArtifact(root);
      expect(artifact.names).toEqual(["0001_first.sql", "0002_second.sql"]);
      expect(artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(pendingMigrations(artifact.names, ["0001_first.sql"])).toEqual(["0002_second.sql"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses gaps, reordered lineage, and newer remote state", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-migrations-gap-"));
    try {
      writeFileSync(join(root, "0001_first.sql"), "SELECT 1;\n");
      writeFileSync(join(root, "0003_third.sql"), "SELECT 3;\n");
      expect(() => readMigrationArtifact(root)).toThrow("gap-free");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(() => pendingMigrations(["0001_a.sql", "0002_b.sql"], ["0002_b.sql"])).toThrow(
      "diverges",
    );
    expect(() => pendingMigrations(["0001_a.sql"], ["0001_a.sql", "0002_b.sql"])).toThrow(
      "more applied",
    );
  });

  test("digests only a strictly ordered full sqlite_schema shape", () => {
    const rows = [
      { type: "index", name: "items_name", tbl_name: "items", sql: "CREATE INDEX items_name" },
      { type: "table", name: "items", tbl_name: "items", sql: "CREATE TABLE items" },
    ];
    expect(canonicalSchemaShape(rows)).toBe(
      `${JSON.stringify(rows.map((row) => ({ type: row.type, name: row.name, table: row.tbl_name, sql: row.sql })))}\n`,
    );
    expect(() => canonicalSchemaShape([...rows].reverse())).toThrow("canonically ordered");
    expect(() => canonicalSchemaShape([{ type: "table", name: "items" }])).toThrow(
      "string tbl_name",
    );
  });
});

type ShapeRow = { type: string; name: string; tbl_name: string; sql: string };

function binaryOrderedRows(pairs: readonly (readonly [string, string])[]): ShapeRow[] {
  const database = new Database(":memory:", { strict: true });
  try {
    return database
      .query<ShapeRow, string[]>(
        `WITH source(type,name,tbl_name,sql) AS (VALUES ${pairs.map(() => "(?,?,?,?)").join(",")}) ` +
          "SELECT type,name,tbl_name,sql FROM source ORDER BY type,name",
      )
      .all(...pairs.flatMap(([type, name]) => [type, name, name, "source-only shape DATA"]));
  } finally {
    database.close();
  }
}

function unchangedShape(rows: readonly ShapeRow[]): string {
  return `${JSON.stringify(rows.map((row) => ({ type: row.type, name: row.name, table: row.tbl_name, sql: row.sql })))}\n`;
}

describe("SQLite BINARY schema shape order", () => {
  test("accepts actual SQLite Auth103 name order without locale sorting or input mutation", () => {
    const rows = binaryOrderedRows([
      ["table", "auth_principal_incarnations"],
      ["table", "auth103_native_source_registration"],
      ["index", "z_lookup"],
      ["index", "a_lookup"],
    ]);
    expect(rows.map(({ type, name }) => [type, name])).toEqual([
      ["index", "a_lookup"],
      ["index", "z_lookup"],
      ["table", "auth103_native_source_registration"],
      ["table", "auth_principal_incarnations"],
    ]);
    const localeSorted = [...rows].sort((left, right) =>
      `${left.type}\0${left.name}`.localeCompare(`${right.type}\0${right.name}`),
    );
    expect(localeSorted.map(({ name }) => name)).not.toEqual(rows.map(({ name }) => name));
    const before = JSON.stringify(rows);
    expect(canonicalSchemaShape(rows)).toBe(unchangedShape(rows));
    expect(JSON.stringify(rows)).toBe(before);
    expect(() => canonicalSchemaShape(localeSorted)).toThrow("canonically ordered");
    expect(() => canonicalSchemaShape([...rows].reverse())).toThrow("canonically ordered");
  });

  test("matches actual SQLite UTF8 order for non-ASCII names and rejects UTF16 reversal", () => {
    const names = ["a\u{10000}", "a\uE000", "aé", "ae\u0301", "a_A", "a0"];
    const rows = binaryOrderedRows(names.map((name) => ["table", name] as const));
    expect(rows.map(({ name }) => name)).toEqual([
      "a0",
      "a_A",
      "ae\u0301",
      "aé",
      "a\uE000",
      "a\u{10000}",
    ]);
    const before = JSON.stringify(rows);
    expect(canonicalSchemaShape(rows)).toBe(unchangedShape(rows));
    expect(JSON.stringify(rows)).toBe(before);
    const utf16Sorted = [...rows].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    expect(utf16Sorted.map(({ name }) => name)).not.toEqual(rows.map(({ name }) => name));
    expect(() => canonicalSchemaShape(utf16Sorted)).toThrow("canonically ordered");
    expect(() => canonicalSchemaShape([...rows].reverse())).toThrow("canonically ordered");
  });
});
