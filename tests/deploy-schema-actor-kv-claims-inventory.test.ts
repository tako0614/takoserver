import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  projectApplyQualifiedMigrationArtifact,
  readAuditedMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
  readSealedApplyQualifiedMigrationArtifact,
} from "../scripts/deploy/schema.ts";

const MIGRATION = "0066_cloudflare_managed_actor_kv_capability_claims.sql";
const CURRENT_SOURCE_TAIL = "0074_v2_worker_native_effects.sql";
const ROOT = mkdtempSync(
  join(process.env.TMPDIR ?? "/tmp", "takoserver-actor-kv-schema-inventory-"),
);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("the current source closure projects to an explicit 0066 apply artifact", () => {
  const source = readCurrentAuditedMigrationSourceArtifact();
  const artifact = projectApplyQualifiedMigrationArtifact(source);
  expect(source.names).toHaveLength(74);
  expect(source.names.at(-1)).toBe(CURRENT_SOURCE_TAIL);
  expect(source.files.at(-1)).toMatchObject({
    name: CURRENT_SOURCE_TAIL,
    digest: "sha256:9a6000586122425d0497f30a9975f632ac33019a17eb69c92b0cfa31f032480f",
  });
  expect(artifact.names).toHaveLength(66);
  expect(artifact.names.at(-1)).toBe(MIGRATION);
  expect(artifact.files.at(-1)).toMatchObject({
    name: MIGRATION,
    digest: "sha256:14d9f1ba2d44c2628192d0b07d7f02e0ab9e3b1f1268c0517248dedfb47848e4",
  });
  expect(artifact.bytes).toBe(
    source.files.slice(0, 66).reduce((total, file) => total + file.bytes, 0),
  );
  expect(artifact.digest).not.toBe(source.digest);
  expect(readAuditedMigrationArtifact().names).toEqual(artifact.names);

  const changed = join(ROOT, "changed-migrations");
  cpSync(resolve(import.meta.dir, "../migrations"), changed, { recursive: true });
  const migrationPath = join(changed, CURRENT_SOURCE_TAIL);
  writeFileSync(migrationPath, `${readFileSync(migrationPath, "utf8")}\n-- changed\n`);
  expect(() => readCurrentAuditedMigrationSourceArtifact(changed)).toThrow(
    "exact audited migration SHA-256",
  );
  expect(() => readAuditedMigrationArtifact(changed)).toThrow("exact audited migration SHA-256");

  const sealed = join(ROOT, "sealed-apply-migrations");
  mkdirSync(sealed, { recursive: true, mode: 0o700 });
  for (const file of artifact.files) cpSync(file.path, join(sealed, file.name));
  const sealedArtifact = readSealedApplyQualifiedMigrationArtifact(sealed);
  expect(sealedArtifact.names).toEqual(artifact.names);
  expect(sealedArtifact.digest).toBe(artifact.digest);
  const sealedTail = join(sealed, MIGRATION);
  writeFileSync(sealedTail, `${readFileSync(sealedTail, "utf8")}\n-- changed\n`);
  expect(() => readSealedApplyQualifiedMigrationArtifact(sealed)).toThrow(
    "exact audited migration SHA-256",
  );
  expect(() =>
    readSealedApplyQualifiedMigrationArtifact(resolve(import.meta.dir, "../migrations")),
  ).toThrow("sealed apply-qualified migration lineage must contain exactly 0001-0066");

  for (const drift of ["missing", "extra"] as const) {
    const directory = join(ROOT, `${drift}-current-source`);
    cpSync(resolve(import.meta.dir, "../migrations"), directory, { recursive: true });
    if (drift === "missing") rmSync(join(directory, CURRENT_SOURCE_TAIL));
    else
      writeFileSync(join(directory, "0075_unreviewed.sql"), "CREATE TABLE unreviewed (id TEXT);\n");
    expect(() => readCurrentAuditedMigrationSourceArtifact(directory)).toThrow(
      "audited migration lineage must contain exactly 0001-0074",
    );
    expect(() => readAuditedMigrationArtifact(directory)).toThrow(
      "audited migration lineage must contain exactly 0001-0074",
    );
  }
});
