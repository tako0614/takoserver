import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import {
  copyAuditedSchemaFixture,
  copyCurrentSchemaFixture,
} from "./helpers/audited-schema-fixture.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "takoserver-d1-migration-import-tests-"));
const migrationsDirectory = copyAuditedSchemaFixture(join(fixtureRoot, "migrations"));
const sourceArtifact = readMigrationArtifact(migrationsDirectory);

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe("D1 migration SQL import builder", () => {
  test("retains frozen 0047 bytes and emits one ordered Wrangler ledger row per file", () => {
    const artifact = buildD1MigrationImport(sourceArtifact.files, { freshLedger: true });
    const migration0047 = sourceArtifact.files.find((file) => file.name.startsWith("0047_"));
    expect(migration0047).toBeDefined();
    const source = readFileSync(migration0047?.path ?? "");
    const ledger = Buffer.from(
      `\nINSERT INTO "d1_migrations" (name)\nvalues ('${migration0047?.name}');`,
      "utf8",
    );
    expect(
      Buffer.from(artifact.sql, "utf8").indexOf(Buffer.concat([source, ledger])),
    ).toBeGreaterThan(-1);

    const names = [
      ...artifact.sql.matchAll(/INSERT INTO "d1_migrations" \(name\)\nvalues \('([^']+)'\);/gu),
    ].map((match) => match[1]);
    expect(names).toEqual([...sourceArtifact.names]);
    expect(names).toHaveLength(sourceArtifact.files.length);
    expect(artifact.bytes).toBe(Buffer.byteLength(artifact.sql, "utf8"));
    expect(artifact.digest).toBe(
      `sha256:${createHash("sha256").update(Buffer.from(artifact.sql, "utf8")).digest("hex")}`,
    );
  });

  test("does not parenthesize SQL, omits fresh-ledger DDL when requested, and rejects changed bytes", () => {
    const artifact = buildD1MigrationImport(sourceArtifact.files, { freshLedger: false });
    expect(artifact.sql).not.toContain('CREATE TABLE IF NOT EXISTS "d1_migrations"');
    expect(artifact.sql).toContain("SELECT CASE");
    expect(artifact.sql).not.toContain("(\nSELECT CASE");

    const changedPath = sourceArtifact.files[0]?.path;
    if (!changedPath) throw new Error("fixture has no first migration");
    const original = readFileSync(changedPath);
    writeFileSync(changedPath, Buffer.concat([original, Buffer.from("-- changed\n", "utf8")]));
    try {
      expect(() => buildD1MigrationImport(sourceArtifact.files, { freshLedger: true })).toThrow(
        "source bytes changed",
      );
    } finally {
      writeFileSync(changedPath, original);
    }
  });

  test("imports an existing-ledger 0047 suffix without prepending ledger DDL", () => {
    const migration0047 = sourceArtifact.files.find((file) => file.name.startsWith("0047_"));
    if (!migration0047) throw new Error("fixture has no 0047 migration");
    const artifact = buildD1MigrationImport([migration0047], { freshLedger: false });
    const source = readFileSync(migration0047.path);
    const expected = Buffer.concat([
      source,
      Buffer.from(
        `\nINSERT INTO "d1_migrations" (name)\nvalues ('${migration0047.name}');`,
        "utf8",
      ),
    ]);
    expect(Buffer.from(artifact.sql, "utf8")).toEqual(expected);
    expect(artifact.sql).not.toContain('CREATE TABLE IF NOT EXISTS "d1_migrations"');
    expect(artifact.sql.match(/INSERT INTO "d1_migrations" \(name\)/gu)).toHaveLength(1);
  });

  test("executes the current 0052 fresh import into SQLite with exact application schema and lineage", () => {
    const currentSource = readMigrationArtifact(
      copyCurrentSchemaFixture(join(fixtureRoot, "current-migrations")),
    );
    const artifact = buildD1MigrationImport(currentSource.files, { freshLedger: true });
    const imported = new Database(":memory:");
    const expected = new Database(":memory:");
    try {
      imported.exec(artifact.sql);
      for (const file of currentSource.files) {
        expected.exec(readFileSync(file.path, "utf8"));
      }

      const applied = imported.query("SELECT name FROM d1_migrations ORDER BY id").all() as Array<{
        name: string;
      }>;
      expect(applied.map(({ name }) => name)).toEqual([...currentSource.names]);

      const rows = (database: Database) =>
        database
          .query(
            "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
              "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' " +
              "ORDER BY type, name",
          )
          .all() as Record<string, unknown>[];
      expect(canonicalSchemaShape(rows(imported))).toBe(canonicalSchemaShape(rows(expected)));
    } finally {
      imported.close();
      expected.close();
    }
  });

  test("rejects an unsafe or out-of-order migration filename", () => {
    const [first, ...rest] = sourceArtifact.files;
    if (!first) throw new Error("fixture has no first migration");
    const malformed = { ...first, name: "0001_bad');DROP TABLE d1_migrations;--.sql" };
    expect(() => buildD1MigrationImport([malformed, ...rest], { freshLedger: true })).toThrow(
      "ordered migration filename",
    );
  });
});
