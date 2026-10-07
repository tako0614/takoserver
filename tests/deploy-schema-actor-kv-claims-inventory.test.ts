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
const CURRENT_SOURCE_TAIL = "0083_v2_queue_consumer_acceptance.sql";
const ROOT = mkdtempSync(
  join(process.env.TMPDIR ?? "/tmp", "takoserver-actor-kv-schema-inventory-"),
);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("the current source closure projects to an explicit 0066 apply artifact", () => {
  const source = readCurrentAuditedMigrationSourceArtifact();
  const artifact = projectApplyQualifiedMigrationArtifact(source);
  expect(source.names.at(-3)).toBe("0081_v2_private_inputs.sql");
  expect(source.names.at(-2)).toBe("0082_v2_queue_batch_settlements.sql");
  expect(source.names.at(-1)).toBe(CURRENT_SOURCE_TAIL);
  expect(source.files.at(-3)).toMatchObject({
    name: "0081_v2_private_inputs.sql",
    digest: "sha256:c371ee2d52bdde69fae5b70888913a5179beb3df6797067bd2ff0dc4aeaabe85",
  });
  expect(source.files.at(-2)).toMatchObject({
    name: "0082_v2_queue_batch_settlements.sql",
    digest: "sha256:9531bcf872272ddbdf370436a906223b15a13471aff7e4466f0b16f134ecdffc",
  });
  expect(source.files.at(-1)).toMatchObject({
    name: CURRENT_SOURCE_TAIL,
    digest: "sha256:b0009351f394a461394b41c37ac1d96a6e9fe9d8a2650591f4bdd1d6bd4734fb",
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
      writeFileSync(join(directory, "0084_unreviewed.sql"), "CREATE TABLE unreviewed (id TEXT);\n");
    expect(() => readCurrentAuditedMigrationSourceArtifact(directory)).toThrow(
      "audited migration lineage must contain exactly 0001-0083",
    );
    expect(() => readAuditedMigrationArtifact(directory)).toThrow(
      "audited migration lineage must contain exactly 0001-0083",
    );
  }
});
