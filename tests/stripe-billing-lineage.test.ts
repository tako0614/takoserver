import { expect, test } from "bun:test";
import {
  projectApplyQualifiedMigrationArtifact,
  projectFreshIntegrationV2MigrationArtifact0091,
  projectFreshProductionMigrationArtifact,
  projectFreshProductionV2MigrationArtifact,
  projectFreshProductionV2MigrationArtifact0089,
  projectFreshV2ArtifactMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
} from "../scripts/deploy/schema.ts";

test("0099 source audit preserves every existing deployment apply ceiling", () => {
  const source = readCurrentAuditedMigrationSourceArtifact();
  expect(source.names).toHaveLength(99);
  expect(source.names.slice(-7)).toEqual([
    "0093_wallet_credit_classification_proofs.sql",
    "0094_wallet_usd_micros.sql",
    "0095_stripe_billing.sql",
    "0096_subscription_checkout_custody.sql",
    "0097_subscription_cancellation_custody.sql",
    "0098_stripe_mode_realm.sql",
    "0099_hosted_billing_extensions.sql",
  ]);
  expect(source.files.slice(-4)).toMatchObject([
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
  ]);
  const projections = [
    [projectApplyQualifiedMigrationArtifact(source), 66],
    [projectFreshProductionMigrationArtifact(source), 69],
    [projectFreshV2ArtifactMigrationArtifact(source), 75],
    [projectFreshProductionV2MigrationArtifact(source), 88],
    [projectFreshProductionV2MigrationArtifact0089(source), 89],
    [projectFreshIntegrationV2MigrationArtifact0091(source), 91],
  ] as const;
  for (const [artifact, ceiling] of projections) {
    expect(artifact.names).toEqual(source.names.slice(0, ceiling));
    expect(artifact.names).not.toContain("0096_subscription_checkout_custody.sql");
    expect(artifact.names).not.toContain("0097_subscription_cancellation_custody.sql");
    expect(artifact.names).not.toContain("0098_stripe_mode_realm.sql");
    expect(artifact.names).not.toContain("0099_hosted_billing_extensions.sql");
    expect(artifact.files).toHaveLength(ceiling);
  }
});
