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
