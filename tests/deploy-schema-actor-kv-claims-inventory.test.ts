import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAuditedMigrationArtifact } from "../scripts/deploy/schema.ts";

const MIGRATION = "0066_cloudflare_managed_actor_kv_capability_claims.sql";
const ROOT = mkdtempSync(
  join(process.env.TMPDIR ?? "/tmp", "takoserver-actor-kv-schema-inventory-"),
);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("the public schema checker pins the exact 0001-0066 source inventory and migration digest", () => {
  const artifact = readAuditedMigrationArtifact();
  expect(artifact.names.at(-1)).toBe(MIGRATION);
  expect(artifact.files.at(-1)).toMatchObject({
    name: MIGRATION,
    digest: "sha256:14d9f1ba2d44c2628192d0b07d7f02e0ab9e3b1f1268c0517248dedfb47848e4",
  });

  const changed = join(ROOT, "changed-migrations");
  cpSync(resolve(import.meta.dir, "../migrations"), changed, { recursive: true });
  const migrationPath = join(changed, MIGRATION);
  writeFileSync(migrationPath, `${readFileSync(migrationPath, "utf8")}\n-- changed\n`);
  expect(() => readAuditedMigrationArtifact(changed)).toThrow("exact audited migration SHA-256");
});
