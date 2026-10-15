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
const MICROS_MIGRATION = "0094_wallet_usd_micros.sql";
const CURRENT_SOURCE_TAIL = "0100_hosted_on_demand.sql";
const ROOT = mkdtempSync(
  join(process.env.TMPDIR ?? "/tmp", "takoserver-actor-kv-schema-inventory-"),
);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("the current source closure projects to an explicit 0066 apply artifact", () => {
  const source = readCurrentAuditedMigrationSourceArtifact();
  const artifact = projectApplyQualifiedMigrationArtifact(source);
  expect(source.names[84]).toBe("0085_v2_edge_kv_native_custody.sql");
  expect(source.names[85]).toBe("0086_v2_worker_service_invocation_custody.sql");
  expect(source.names[86]).toBe("0087_v2_worker_cron_invocation_custody.sql");
  expect(source.names[87]).toBe("0088_v2_worker_sqlite_external_drain.sql");
  expect(source.names[88]).toBe("0089_v2_worker_cron_match_guard_depth.sql");
  expect(source.names[89]).toBe("0090_v2_queue_sqlite_external_drain.sql");
  expect(source.names[90]).toBe("0091_stripe_events.sql");
  expect(source.names[91]).toBe("0092_org_wallet_lifecycle.sql");
  expect(source.files[84]).toMatchObject({
    name: "0085_v2_edge_kv_native_custody.sql",
    digest: "sha256:1a123aa756178762b45dd67949f36bea12a8be2f62b32e451480d0ce7f40fa11",
  });
  expect(source.files[85]).toMatchObject({
    name: "0086_v2_worker_service_invocation_custody.sql",
    digest: "sha256:4bacc1b2d8d3d78a7736ccc66257d2e8c8a077ec82a0fc1a208038266b28a0d5",
  });
  expect(source.files[86]).toMatchObject({
    name: "0087_v2_worker_cron_invocation_custody.sql",
    digest: "sha256:0375e932701b6596363468a784cdef91d56846f9e4a49cc65ff5890c0f2d0b7e",
  });
  expect(source.files[87]).toMatchObject({
    name: "0088_v2_worker_sqlite_external_drain.sql",
    digest: "sha256:88bf294753e8bd43809634410c4a8648cb3e0500e7400d53ec4c8f17fae46c84",
  });
  expect(source.files[88]).toMatchObject({
    name: "0089_v2_worker_cron_match_guard_depth.sql",
    digest: "sha256:eaed1f01e78de59c4488e5c882e984d6c5e5f9010e8e8bab51dac3a74f0fca7b",
  });
  expect(source.files[89]).toMatchObject({
    name: "0090_v2_queue_sqlite_external_drain.sql",
    digest: "sha256:9a2590842a6986dbc9e0b906a3b0efdae2da7d1244c24a5cf2be81a8f11ab802",
  });
  expect(source.files[91]).toMatchObject({
    name: "0092_org_wallet_lifecycle.sql",
    digest: "sha256:315fb662a48c013ed3299fb6f23e648e03bda5f4cabc0d03dcaf8777d048712f",
  });
  expect(source.files[90]).toMatchObject({
    name: "0091_stripe_events.sql",
    digest: "sha256:e32149261d1025e4fa375c944fb4299ab3bc140fade37832f8e0d3a394f96b6e",
  });
  // New source is audited without changing any frozen apply-qualified prefix.
  expect(source.names).toHaveLength(100);
  expect(source.names.slice(92)).toEqual([
    "0093_wallet_credit_classification_proofs.sql",
    MICROS_MIGRATION,
    "0095_stripe_billing.sql",
    "0096_subscription_checkout_custody.sql",
    "0097_subscription_cancellation_custody.sql",
    "0098_stripe_mode_realm.sql",
    "0099_hosted_billing_extensions.sql",
    CURRENT_SOURCE_TAIL,
  ]);
  expect(source.files[92]).toMatchObject({
    name: "0093_wallet_credit_classification_proofs.sql",
    digest: "sha256:fc0307e23ee2f80e3eb96da21db7ea065ba7a04d5c582191c34bdf9d4afc3037",
  });
  expect(source.files[93]).toMatchObject({
    name: MICROS_MIGRATION,
    digest: "sha256:7ce85b52626f6cbef6e06484e9cddb5052fab76f9718fea279108e2db6da8e44",
  });
  expect(source.files[94]).toMatchObject({
    name: "0095_stripe_billing.sql",
    digest: "sha256:54f27fccaaa1d624505b333cf21ee0e7d59a798830a3c083b16065fa8f65a826",
  });
  expect(source.files[97]).toMatchObject({
    name: "0098_stripe_mode_realm.sql",
    digest: "sha256:5865ae1809dad2887b7786ebc5a372266521826ecbf8c2f59c308d211f08272f",
  });
  expect(source.files[98]).toMatchObject({
    name: "0099_hosted_billing_extensions.sql",
    digest: "sha256:b7ad0ad7876ac993d1b6de1cb14c2aea62067147638f48456626baf9673156d8",
  });
  expect(source.files[99]).toMatchObject({
    name: CURRENT_SOURCE_TAIL,
    digest: "sha256:da2b839959b4c7bc06e3d74507043c1ba9f6acf80baa927d8b6c30484d2676d4",
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
      writeFileSync(join(directory, "0101_unreviewed.sql"), "CREATE TABLE unreviewed (id TEXT);\n");
    expect(() => readCurrentAuditedMigrationSourceArtifact(directory)).toThrow(
      "audited migration lineage must contain exactly 0001-0100",
    );
    expect(() => readAuditedMigrationArtifact(directory)).toThrow(
      "audited migration lineage must contain exactly 0001-0100",
    );
  }
});
