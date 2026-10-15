import { expect, test } from "bun:test";
import {
  projectApplyQualifiedMigrationArtifact,
  projectFreshIntegrationV2MigrationArtifact0091,
  projectFreshIntegrationV2MigrationArtifact0092,
  projectFreshProductionMigrationArtifact,
  projectFreshProductionV2MigrationArtifact,
  projectFreshProductionV2MigrationArtifact0089,
  projectFreshV2ArtifactMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
  runD1Schema,
  SCHEMA_WAVE_BOUNDARIES,
  type SchemaWaveBoundary,
} from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

test("0100 source audit preserves every existing deployment apply ceiling", () => {
  const source = readCurrentAuditedMigrationSourceArtifact();
  expect(source.names).toHaveLength(100);
  expect(source.names.slice(-8)).toEqual([
    "0093_wallet_credit_classification_proofs.sql",
    "0094_wallet_usd_micros.sql",
    "0095_stripe_billing.sql",
    "0096_subscription_checkout_custody.sql",
    "0097_subscription_cancellation_custody.sql",
    "0098_stripe_mode_realm.sql",
    "0099_hosted_billing_extensions.sql",
    "0100_hosted_on_demand.sql",
  ]);
  expect(source.files.slice(-5)).toMatchObject([
    {
      name: "0096_subscription_checkout_custody.sql",
      digest: "sha256:050f0eced06d19e7503e42a6b4d9d7d529cc84d763fd55fcf0253ef5efaf712e",
    },
    {
      name: "0097_subscription_cancellation_custody.sql",
      digest: "sha256:80f5572d6ae15250f2cb0202aedab692d4b68690595ca06a114ba39ee5949ca5",
    },
    {
      name: "0098_stripe_mode_realm.sql",
      digest: "sha256:5865ae1809dad2887b7786ebc5a372266521826ecbf8c2f59c308d211f08272f",
    },
    {
      name: "0099_hosted_billing_extensions.sql",
      digest: "sha256:b7ad0ad7876ac993d1b6de1cb14c2aea62067147638f48456626baf9673156d8",
    },
    {
      name: "0100_hosted_on_demand.sql",
      digest: "sha256:da2b839959b4c7bc06e3d74507043c1ba9f6acf80baa927d8b6c30484d2676d4",
    },
  ]);
  const projections = [
    [projectApplyQualifiedMigrationArtifact(source), 66],
    [projectFreshProductionMigrationArtifact(source), 69],
    [projectFreshV2ArtifactMigrationArtifact(source), 75],
    [projectFreshProductionV2MigrationArtifact(source), 88],
    [projectFreshProductionV2MigrationArtifact0089(source), 89],
    [projectFreshIntegrationV2MigrationArtifact0091(source), 91],
    [projectFreshIntegrationV2MigrationArtifact0092(source), 92],
  ] as const;
  for (const [artifact, ceiling] of projections) {
    expect(artifact.names).toEqual(source.names.slice(0, ceiling));
    expect(artifact.names).not.toContain("0096_subscription_checkout_custody.sql");
    expect(artifact.names).not.toContain("0097_subscription_cancellation_custody.sql");
    expect(artifact.names).not.toContain("0098_stripe_mode_realm.sql");
    expect(artifact.names).not.toContain("0099_hosted_billing_extensions.sql");
    expect(artifact.names).not.toContain("0100_hosted_on_demand.sql");
    expect(artifact.files).toHaveLength(ceiling);
  }
});

test("0100 source registration refuses unqualified apply before any provider call", async () => {
  const target: DeployTarget = {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "a".repeat(32),
    workerName: "synthetic-source-only-audit",
    d1: { databaseName: "synthetic-source-only-audit", databaseId: "synthetic-d1-id" },
    r2: { bucketName: "synthetic-source-only-audit" },
    publicOrigin: "https://synthetic-source-only-audit.example.test",
    signing: { currentKeyId: "synthetic-source-only-key" },
  };
  let providerCalls = 0;
  const run = async () => {
    providerCalls += 1;
    throw new Error("unexpected provider command in source-only refusal");
  };
  const invocation = {
    action: "apply" as const,
    environment: "integration" as const,
    commit: "b".repeat(40),
    throughMigration: "0100" as SchemaWaveBoundary,
  };
  expect(SCHEMA_WAVE_BOUNDARIES.at(-1)).toBe("0094");
  expect(SCHEMA_WAVE_BOUNDARIES).not.toContain("0100");
  await expect(runD1Schema(invocation, target, { run })).rejects.toThrow(
    "not an approved fixed wave boundary",
  );
  await expect(
    runD1Schema(
      invocation,
      { ...target, moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1" },
      { run },
    ),
  ).rejects.toThrow("requires a reviewed 0095 suffix route");
  expect(providerCalls).toBe(0);
});
