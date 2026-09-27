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
    digest: "sha256:d6f13070a6dc535b88f6d2977422eb6dfc01207ca2161381a541626c7c0955d0",
  });

  const changed = join(ROOT, "changed-migrations");
  cpSync(resolve(import.meta.dir, "../migrations"), changed, { recursive: true });
  const migrationPath = join(changed, MIGRATION);
  writeFileSync(migrationPath, `${readFileSync(migrationPath, "utf8")}\n-- changed\n`);
  expect(() => readAuditedMigrationArtifact(changed)).toThrow("exact audited migration SHA-256");
});
