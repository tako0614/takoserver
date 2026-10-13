import { expect, test } from "bun:test";
import {
  projectApplyQualifiedMigrationArtifact,
  projectCanonicalIntegrationV2MigrationArtifact0092,
  projectFreshIntegrationV2MigrationArtifact0091,
  projectFreshIntegrationV2MigrationArtifact0092,
  projectFreshProductionMigrationArtifact,
  projectFreshProductionV2MigrationArtifact,
  projectFreshProductionV2MigrationArtifact0089,
  projectFreshV2ArtifactMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
} from "../scripts/deploy/schema.ts";

test("0095 source audit preserves every existing deployment apply ceiling", () => {
  const source = readCurrentAuditedMigrationSourceArtifact();
  expect(source.names).toHaveLength(95);
  expect(source.names.slice(-3)).toEqual([
    "0093_wallet_credit_classification_proofs.sql",
    "0094_wallet_usd_micros.sql",
    "0095_stripe_billing.sql",
  ]);
  const projections = [
    [projectApplyQualifiedMigrationArtifact(source), 66],
    [projectFreshProductionMigrationArtifact(source), 69],
    [projectFreshV2ArtifactMigrationArtifact(source), 75],
    [projectFreshProductionV2MigrationArtifact(source), 88],
    [projectFreshProductionV2MigrationArtifact0089(source), 89],
    [projectFreshIntegrationV2MigrationArtifact0091(source), 91],
    [projectFreshIntegrationV2MigrationArtifact0092(source), 92],
    [projectCanonicalIntegrationV2MigrationArtifact0092(source), 92],
  ] as const;
  for (const [artifact, ceiling] of projections) {
    expect(artifact.names).toEqual(source.names.slice(0, ceiling));
    expect(artifact.names).not.toContain("0095_stripe_billing.sql");
    expect(artifact.files).toHaveLength(ceiling);
  }
});
