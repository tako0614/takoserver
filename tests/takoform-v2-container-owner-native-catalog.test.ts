import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  inspectV2ContainerOwnerSchema,
  V2_CONTAINER_OWNER_RECIPE as recipe,
} from "../src/takoform-v2/container-owner-schema.ts";
import { currentAuditedSchemaMigrations } from "./helpers/audited-schema-fixture.ts";

const nativeMode = process.env.TAKOS_OWNER_NATIVE_CATALOG;
if (nativeMode !== undefined && nativeMode !== "1") {
  throw new TypeError("Unsupported owner catalog native mode");
}

type CatalogFixture = { readonly sql: Sql; readonly close: () => void | Promise<void> };

function auditedFull100() {
  const migrations = currentAuditedSchemaMigrations();
  expect(migrations).toHaveLength(100);
  return migrations;
}

async function portableFixture(): Promise<CatalogFixture> {
  const db = new Database(":memory:");
  try {
    auditedFull100();
    migrateSqlite(db);
    return { sql: createSqliteSql(db), close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function nativeFixture(): Promise<CatalogFixture> {
  const { Miniflare } = await import("miniflare");
  const runtime = new Miniflare({
    cf: false,
    workers: [
      {
        config: {
          name: "v2-existing-wave-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('ok')}}",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-existing-wave-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const db = await runtime.getD1Database("STATE_DB");
    const sql = createD1Sql(db);
    for (const migration of auditedFull100()) {
      const statements = frameHostMigrationSql(migration.sql).map((body) => ({ sql: body }));
      await sql.batch(statements);
    }
    return { sql, close: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

async function catalogFingerprint(sql: Sql) {
  const rows = await sql.query("SELECT type, name, sql FROM main.sqlite_schema ORDER BY name");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function identifier(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}

async function exerciseCatalogBoundary(makeFixture: () => Promise<CatalogFixture>) {
  const f = await makeFixture();
  try {
    const statements = v2ContainerOwnerMigrationCandidate();
    expect(Object.isFrozen(statements)).toBe(true);
    expect(statements).toHaveLength(28);
    const owned = identifier(recipe.tables[0]!.name);
    const extra = identifier(recipe.tables[0]!.name + "_native_catalog_extra");
    const foreign = identifier("external_native_catalog_probe");
    const extraSql = "CREATE TABLE " + extra + " (value TEXT)";
    const foreignSql = "CREATE TABLE " + foreign + " (value TEXT REFERENCES " + owned + ")";
    const dropExtra = "DROP TABLE " + extra;
    const dropForeign = "DROP TABLE " + foreign;
    const initial = await catalogFingerprint(f.sql);
    await f.sql.run(extraSql);
    const withExtra = await catalogFingerprint(f.sql);
    expect(withExtra).not.toBe(initial);
    await expect(f.sql.batch(statements)).rejects.toThrow();
    expect(await catalogFingerprint(f.sql)).toBe(withExtra);
    await f.sql.run(dropExtra);
    expect(await catalogFingerprint(f.sql)).toBe(initial);

    await f.sql.run(foreignSql);
    const withForeign = await catalogFingerprint(f.sql);
    expect(withForeign).not.toBe(initial);
    await expect(f.sql.batch(statements)).rejects.toThrow();
    expect(await catalogFingerprint(f.sql)).toBe(withForeign);
    await f.sql.run(dropForeign);
    expect(await catalogFingerprint(f.sql)).toBe(initial);

    await expect(
      f.sql.batch([...statements, { sql: "SELECT missing_owner_failure_injection()" }]),
    ).rejects.toThrow();
    expect(await catalogFingerprint(f.sql)).toBe(initial);

    await f.sql.batch(statements);
    expect(await inspectV2ContainerOwnerSchema(f.sql)).toBe(true);
    const installed = await catalogFingerprint(f.sql);
    expect(installed).not.toBe(initial);

    await f.sql.run(extraSql);
    expect(await inspectV2ContainerOwnerSchema(f.sql)).toBe(false);
    await f.sql.run(dropExtra);
    expect(await catalogFingerprint(f.sql)).toBe(installed);
    expect(await inspectV2ContainerOwnerSchema(f.sql)).toBe(true);

    await f.sql.run(foreignSql);
    expect(await inspectV2ContainerOwnerSchema(f.sql)).toBe(false);
    await f.sql.run(dropForeign);
    expect(await catalogFingerprint(f.sql)).toBe(installed);
    expect(await inspectV2ContainerOwnerSchema(f.sql)).toBe(true);

    await expect(f.sql.batch(statements)).rejects.toThrow();
    expect(await catalogFingerprint(f.sql)).toBe(installed);
  } finally {
    await f.close();
  }
}

test(
  "owner catalog portable full100 atomic readiness boundary",
  () => exerciseCatalogBoundary(portableFixture),
  120000,
);
if (nativeMode === "1") {
  test(
    "owner catalog native full100 atomic readiness boundary",
    () => exerciseCatalogBoundary(nativeFixture),
    120000,
  );
}
