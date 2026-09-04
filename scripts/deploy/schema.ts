import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type ArtifactBlobIoDeploymentCompatibility,
  inspectArtifactBlobIoDeploymentCompatibility,
} from "./artifact-blob-io-compatibility.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  type D1SchemaState,
  pendingMigrations,
  readD1SchemaState,
  readMigrationArtifact,
} from "./migrations.ts";
import {
  type CommandResult,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  sealDirectory,
  unsealDirectory,
} from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { acquireWranglerVersionPublicationLease } from "./wrangler-state.ts";

const RECEIPT_KIND = "takoserver.d1-schema-rehearsal-receipt@v3";
const REHEARSAL_ATTEMPT_KIND = "takoserver.d1-schema-rehearsal-attempt@v2";
const PRODUCTION_ATTEMPT_KIND = "takoserver.d1-schema-production-attempt@v1";
const REHEARSAL_BASELINE_MIGRATION = "0022_takoform_admission.sql";
const LEGACY_PRODUCTION_CATCHUP_BOUNDARY = "0022" as const;
const LEGACY_PRODUCTION_CATCHUP_FROM_MIGRATION = "0016_takos_id_organization_projection.sql";
const CANONICAL_0016_APPLICATION_SCHEMA_SHAPE_DIGEST =
  "sha256:5c53ab9a929eab9323b45640f29bca203a0aef387b515cdb3a56c6aa42426c0b";
const AUDITED_MIGRATION_LINEAGE = [
  "0001_runtime_storage.sql",
  "0002_takoform_state.sql",
  "0003_control_plane.sql",
  "0004_commerce.sql",
  "0005_resource_deployments.sql",
  "0006_resource_attachments.sql",
  "0007_logical_resources_drop_native_identity.sql",
  "0008_remove_native_identity_migration_guard.sql",
  "0009_resource_migrations.sql",
  "0010_attachment_target_uniqueness.sql",
  "0011_resource_migration_attachment_rebindings.sql",
  "0012_resource_migration_commercial_authority.sql",
  "0013_provision_token_release_fence.sql",
  "0014_provider_meter_checkpoints.sql",
  "0015_takoform_resource_relations.sql",
  "0016_takos_id_organization_projection.sql",
  "0017_wallet_credit_lots.sql",
  "0018_usage_amount_micros.sql",
  "0019_takoform_native_claim.sql",
  "0020_takoform_deferred_operations.sql",
  "0021_takoform_provider_mutation_sagas.sql",
  REHEARSAL_BASELINE_MIGRATION,
  "0023_takoform_host_authority.sql",
  "0024_takoform_provider_execution_leases.sql",
  "0025_resource_migration_execution.sql",
  "0026_takoform_provider_mutation_outcomes.sql",
  "0027_reseller_settlement_intents.sql",
  "0028_reseller_settlement_cancellation.sql",
  "0029_resource_deletion_attestations.sql",
  "0030_integration_e2e_credential_pairs.sql",
  "0031_takoform_artifact_lifecycle.sql",
  "0032_worker_runtime_input_preparations.sql",
  "0033_takoform_artifact_lifecycle_forward_repair.sql",
  "0034_cloudflare_managed_worker_state.sql",
  "0035_worker_endpoint_origin_reservation_v2.sql",
  "0036_provider_repair_and_managed_schedule_reconciliation.sql",
  "0037_worker_runtime_input_preparation_v2.sql",
  "0038_selfhost_edge_kv.sql",
  "0039_takoform_live_native_claim_across_tenants.sql",
  "0040_selfhost_queues_and_schedules.sql",
  "0041_selfhost_object_buckets.sql",
  "0042_worker_endpoint_origin_reservation_space_id.sql",
  "0043_artifact_blob_io_fences.sql",
  "0044_artifact_consumer_resolution_receipts.sql",
  "0045_cloudflare_provider_executor_operations.sql",
  "0046_exact_artifact_recovery_receipts.sql",
  "0047_sponsorship_cutover_consumption.sql",
  "0048_resource_execution_evidence.sql",
  "0049_artifact_consumer_active_resolution.sql",
] as const;
const AUDITED_MIGRATION_SHA256: Readonly<
  Record<(typeof AUDITED_MIGRATION_LINEAGE)[number], string>
> = {
  "0001_runtime_storage.sql":
    "sha256:a69f1671922738f00904677afd1fb23a8543f0c71cd8a65c46290d7137cf4875",
  "0002_takoform_state.sql":
    "sha256:85436c61592f426fd29aa8c44705c4f920ad2aa23d8a36e99182900f4e7d9e8c",
  "0003_control_plane.sql":
    "sha256:a8d86899b2295e35f482bb4d9e74cd962cf5dc6158194f35ed30181ff9d4c218",
  "0004_commerce.sql": "sha256:46fde2756b5275eb01c0187dd8e7e5098445aa500af2d5e8a36b82e47755f993",
  "0005_resource_deployments.sql":
    "sha256:130c9a6cc34317dbd29eec08feb183c370178f04bb21aedddaae37c835a96d46",
  "0006_resource_attachments.sql":
    "sha256:d16e0741f5d3164136fa184fd0c5391425c7dc34d671eb16516b2c2bc33eaf78",
  "0007_logical_resources_drop_native_identity.sql":
    "sha256:e6ab003295c5d2c3154c5825ea82a8649dd3cb21d9d7f65936afbe2479216825",
  "0008_remove_native_identity_migration_guard.sql":
    "sha256:f1c970c0378e250c6b3344489eddf99d32b7dd7383b28d13452c3834bc681590",
  "0009_resource_migrations.sql":
    "sha256:b6d8c92fcdbcc1af1938fb1451a0f7d11129317949e5d6f7cfd0705174ad4f07",
  "0010_attachment_target_uniqueness.sql":
    "sha256:f5082d73ed0325ef3f029586d35215ad0624de62a7ed195b020a082a3e7d0a98",
  "0011_resource_migration_attachment_rebindings.sql":
    "sha256:70db0b35578d8306abf2e28cad7ec96740b914313e9161d604d5a32f3c4bd3b1",
  "0012_resource_migration_commercial_authority.sql":
    "sha256:eb71362ade25dea627fcd13ed46e61981d4f6dbe1ce63781aa80ce1f6e92651c",
  "0013_provision_token_release_fence.sql":
    "sha256:a074131fabc780e0ed309b56d61645e29e271b18480d759885d2e2e28cdd5d7b",
  "0014_provider_meter_checkpoints.sql":
    "sha256:f2c74d2e9becb7506091a176f4dbbf9d9b8bbfccdad777edc8842dc3655d772c",
  "0015_takoform_resource_relations.sql":
    "sha256:d47abe2779aa08dd6b4424f98e43b19c27eb901d064e97875e503d9297b6a17c",
  "0016_takos_id_organization_projection.sql":
    "sha256:058102474fd510763a5688a80ce651f65b8a9ffd1e49b18adaf854023b81abab",
  "0017_wallet_credit_lots.sql":
    "sha256:5b11be0379d7a57fb341d7fa24157cc5d6185fd038b22168cd137570e7631be3",
  "0018_usage_amount_micros.sql":
    "sha256:5e750153fda0f4cf04c2d74930742333183805c9489c485d50786322c4d5a60f",
  "0019_takoform_native_claim.sql":
    "sha256:845d41f1c39ae4f88c1bd40f9671b3dbc7ca946b48619f3055d417e92e569eed",
  "0020_takoform_deferred_operations.sql":
    "sha256:8036877bb306f2d37523acb368c7f8b3f481bbdd170fd4ec5810bc67f7a5b062",
  "0021_takoform_provider_mutation_sagas.sql":
    "sha256:faf0b501b4979192ead3f44631f81b961f03457d2cdaa899729e4bdaaf4667bb",
  "0022_takoform_admission.sql":
    "sha256:9dda5b290074280c48abc827a07d220eccbcfceac92908da5f99b4844642f038",
  "0023_takoform_host_authority.sql":
    "sha256:c062c97eb7c9e96ef51367d82c3dbba4eddf74fa8d1c12c9677f8cefd7220fe4",
  "0024_takoform_provider_execution_leases.sql":
    "sha256:0fc3822ee2bccffbb575e3e293df54c28d72e95ef1361f3f1985649b1d5b1cf9",
  "0025_resource_migration_execution.sql":
    "sha256:fdce468ba118aeddeb67c2a5f8684e693d04741284d5e3485e78d030e371ec7b",
  "0026_takoform_provider_mutation_outcomes.sql":
    "sha256:8ccbc0712ce9e46812195db4d0fc1a32e733c20c5a04bbae5aca26122fbdbb5e",
  "0027_reseller_settlement_intents.sql":
    "sha256:8b4242994fe6bb06caed9480dbe33c1274e202cb7c0aad259921af11fd0e589c",
  "0028_reseller_settlement_cancellation.sql":
    "sha256:176889fb20a411f925034cd8d66d5d8745525f5dd0465303d246fccbeb890dd5",
  "0029_resource_deletion_attestations.sql":
    "sha256:cc5728df5a57d92fe30e6c3e9799ed2ff36cf6789623ecb5d4c0a29c0d547fa2",
  "0030_integration_e2e_credential_pairs.sql":
    "sha256:f56544579bdd280892c273001901ef1c16627fc1a6eb794109b49360159058a9",
  "0031_takoform_artifact_lifecycle.sql":
    "sha256:dda3a01d915ef5871ad5a7fb8499761bce4309243044aa0b206076e1cf9bda45",
  "0032_worker_runtime_input_preparations.sql":
    "sha256:1b54d7c911a8da53aa58b5b1ac54c91f4785bdb1e08125322227ae0ffd201e8f",
  "0033_takoform_artifact_lifecycle_forward_repair.sql":
    "sha256:1a9b9ada29694407494bcf9dcdf38a93ac0d089469b06e47d757cdac2a92a377",
  "0034_cloudflare_managed_worker_state.sql":
    "sha256:5d5922412ac3d479454191720cff3460b8d5c7484ecdb7041ebef584960483ec",
  "0035_worker_endpoint_origin_reservation_v2.sql":
    "sha256:658406c5316dc5cd596273f480f3cf3676cad0c0188daf49168aed4f5742dcc8",
  "0036_provider_repair_and_managed_schedule_reconciliation.sql":
    "sha256:bece89d176a5f28af29879cda9c5e969302ef800b4c4d1a1e6a3bd2f7ddf408b",
  "0037_worker_runtime_input_preparation_v2.sql":
    "sha256:dbea42fc9e522a4bbcd0ab3df4cebd99447ca6326e40b83767e49bd30ac3eb25",
  "0038_selfhost_edge_kv.sql":
    "sha256:c39955805b4a613a5544384d6dacdbc23c4ea5e42cc68d752cfadbfe69564282",
  "0039_takoform_live_native_claim_across_tenants.sql":
    "sha256:2827667a25efa9e46a004eeed0153dcf112ebb473a7e4ed4388f4846c01941c6",
  "0040_selfhost_queues_and_schedules.sql":
    "sha256:10b1e4207184576737717052eaddf66a567387ea11c8d47b1cac62f4bead7bec",
  "0041_selfhost_object_buckets.sql":
    "sha256:602dba6c847e1e292f77bbc8cc9031cdd8dbbf4fc820feab32cb557d92d79365",
  "0042_worker_endpoint_origin_reservation_space_id.sql":
    "sha256:e3f2c9ed578eb92100158059fc6c16d4719b67b1dafcc30645c10791196d0254",
  "0043_artifact_blob_io_fences.sql":
    "sha256:8a85fa1b6d8ba67fec9d4e37ac9975c9f575ade3c2e9d6d4c4c1ac1a977447fc",
  "0044_artifact_consumer_resolution_receipts.sql":
    "sha256:ea0ebaab3e944b23ddea3c0ab8c847560fec2931471c8dd8e81b334e5548b5e2",
  "0045_cloudflare_provider_executor_operations.sql":
    "sha256:7d87cb2eec7a3434ece89f1e5d2ecac470d1e717c0611ee3f47b5390f991f9f2",
  "0046_exact_artifact_recovery_receipts.sql":
    "sha256:e5cd3a0b5a955642a0072b819c5de7148dac03a12c21721e4ecf9013e6d5b189",
  "0047_sponsorship_cutover_consumption.sql":
    "sha256:d7629fce50cc6d84a97554e92f32f1f3c6920577565b7fa7d06b773fe4b699c6",
  "0048_resource_execution_evidence.sql":
    "sha256:64293c3efa4ffd07bde36bf440862fb9fcb6e57290c172b771b09d955c3d2740",
  "0049_artifact_consumer_active_resolution.sql":
    "sha256:260605201a3a932fd5702aa1fdd2a449b74945a9dcd86f205cb54fcbcd757b29",
};
export const SCHEMA_WAVE_BOUNDARIES = [
  LEGACY_PRODUCTION_CATCHUP_BOUNDARY,
  "0028",
  "0033",
  "0036",
  "0043",
  "0044",
  "0045",
  "0046",
  "0047",
  "0048",
  "0049",
] as const;
export type SchemaWaveBoundary = (typeof SCHEMA_WAVE_BOUNDARIES)[number];
const SCHEMA_WAVES: Readonly<
  Record<
    SchemaWaveBoundary,
    {
      readonly fromCount: number;
      readonly fromMigration: string;
      readonly throughCount: number;
      readonly throughMigration: string;
    }
  >
> = {
  "0022": {
    fromCount: 16,
    fromMigration: LEGACY_PRODUCTION_CATCHUP_FROM_MIGRATION,
    throughCount: 22,
    throughMigration: REHEARSAL_BASELINE_MIGRATION,
  },
  "0028": {
    fromCount: 22,
    fromMigration: REHEARSAL_BASELINE_MIGRATION,
    throughCount: 28,
    throughMigration: "0028_reseller_settlement_cancellation.sql",
  },
  "0033": {
    fromCount: 28,
    fromMigration: "0028_reseller_settlement_cancellation.sql",
    throughCount: 33,
    throughMigration: "0033_takoform_artifact_lifecycle_forward_repair.sql",
  },
  "0036": {
    fromCount: 33,
    fromMigration: "0033_takoform_artifact_lifecycle_forward_repair.sql",
    throughCount: 36,
    throughMigration: "0036_provider_repair_and_managed_schedule_reconciliation.sql",
  },
  "0043": {
    fromCount: 36,
    fromMigration: "0036_provider_repair_and_managed_schedule_reconciliation.sql",
    throughCount: 43,
    throughMigration: "0043_artifact_blob_io_fences.sql",
  },
  "0044": {
    fromCount: 43,
    fromMigration: "0043_artifact_blob_io_fences.sql",
    throughCount: 44,
    throughMigration: "0044_artifact_consumer_resolution_receipts.sql",
  },
  "0045": {
    fromCount: 44,
    fromMigration: "0044_artifact_consumer_resolution_receipts.sql",
    throughCount: 45,
    throughMigration: "0045_cloudflare_provider_executor_operations.sql",
  },
  "0046": {
    fromCount: 45,
    fromMigration: "0045_cloudflare_provider_executor_operations.sql",
    throughCount: 46,
    throughMigration: "0046_exact_artifact_recovery_receipts.sql",
  },
  "0047": {
    fromCount: 46,
    fromMigration: "0046_exact_artifact_recovery_receipts.sql",
    throughCount: 47,
    throughMigration: "0047_sponsorship_cutover_consumption.sql",
  },
  "0048": {
    fromCount: 47,
    fromMigration: "0047_sponsorship_cutover_consumption.sql",
    throughCount: 48,
    throughMigration: "0048_resource_execution_evidence.sql",
  },
  "0049": {
    fromCount: 48,
    fromMigration: "0048_resource_execution_evidence.sql",
    throughCount: 49,
    throughMigration: "0049_artifact_consumer_active_resolution.sql",
  },
};
const RECEIPT_CHAIN_BOUNDARIES = SCHEMA_WAVE_BOUNDARIES.filter(
  (boundary): boundary is Exclude<SchemaWaveBoundary, "0022"> =>
    boundary !== LEGACY_PRODUCTION_CATCHUP_BOUNDARY,
);
const RESOURCE_DELETION_ATTESTATION_MIGRATION = "0029_resource_deletion_attestations.sql";
const PROVIDER_REPAIR_MIGRATION = "0036_provider_repair_and_managed_schedule_reconciliation.sql";
const PROVIDER_EXECUTION_LEASE_MIGRATION = "0024_takoform_provider_execution_leases.sql";
const RUNTIME_INPUT_PREPARATION_MIGRATION = "0032_worker_runtime_input_preparations.sql";
const RUNTIME_INPUT_PREPARATION_V2_MIGRATION = "0037_worker_runtime_input_preparation_v2.sql";
const LIVE_NATIVE_CLAIM_MIGRATION = "0039_takoform_live_native_claim_across_tenants.sql";
const ARTIFACT_BLOB_IO_FENCE_MIGRATION = "0043_artifact_blob_io_fences.sql";
const RUNTIME_INPUT_QUIESCENCE_TRIGGER =
  "takoserver_0037_worker_runtime_input_preparations_quiescence";
const RUNTIME_INPUT_QUIESCENCE_TRIGGER_SQL = `CREATE TRIGGER ${RUNTIME_INPUT_QUIESCENCE_TRIGGER}
BEFORE INSERT ON worker_runtime_input_preparations
BEGIN
  SELECT RAISE(ABORT, 'runtime_input_preparation_v2_quiesced');
END`;
const RUNTIME_INPUT_QUIESCENCE_INSTALL_SQL = RUNTIME_INPUT_QUIESCENCE_TRIGGER_SQL.replace(
  "CREATE TRIGGER ",
  "CREATE TRIGGER IF NOT EXISTS ",
);

export type SchemaProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface SchemaReader {
  read(phase: DeployPhase): Promise<D1SchemaState>;
  /** Fixed 0016->0022 catch-up snapshot; counts bind rehearsal to production. */
  legacyProductionCatchupDataIntegrity?(phase: DeployPhase): Promise<{
    readonly ledgerRowCount: number;
    readonly principalRowCount: number;
    readonly organizationRowCount: number;
    readonly organizationMembershipRowCount: number;
    readonly organizationOwnerProjectionMismatchCount: number;
    readonly usageEventRowCount: number;
    readonly resourceDeploymentRowCount: number;
    readonly activeResourceUidConflictCount: number;
    readonly liveNativeIdentityConflictCount: number;
  }>;
  /** Read-only 0029 preflight; both counts must be exactly zero. */
  resourceDeletionAttestationBackfillCounts?(phase: DeployPhase): Promise<{
    readonly malformedFormRefCount: number;
    readonly duplicateLiveResourceUidCount: number;
  }>;
  /** Read-only 0036 preflight; required when that migration is the pending head. */
  unmatchedProviderRepairSagaCount?(phase: DeployPhase): Promise<number>;
  /** Read-only 0037 predecessor proof; the replaced v1 table must be empty. */
  legacyRuntimeInputPreparationCount?(phase: DeployPhase): Promise<number>;
  /** Test boundary for the monotonic D1 trigger install/readback and zero predecessor proof. */
  installRuntimeInputPreparationV2Quiescence?(phase: DeployPhase): Promise<{
    readonly status: "installed";
    readonly predecessorRowCount: number;
  }>;
  /** Read-only 0039 preflight; the tightened live claim must already be unique. */
  duplicateLiveNativeClaimCount?(phase: DeployPhase): Promise<number>;
  /** Read-only 0043 preflight; an active root may not already overlap deletion. */
  activeRootDeletingArtifactCandidateConflictCount?(phase: DeployPhase): Promise<number>;
  /** Test/read boundary for the staged 0043 Worker and external drain proof. */
  artifactBlobIoDeploymentCompatibility?(
    phase: DeployPhase,
  ): Promise<ArtifactBlobIoDeploymentCompatibility>;
}

export interface SchemaInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly throughMigration?: SchemaWaveBoundary;
}

export interface SchemaOptions {
  readonly run?: SchemaProcess;
  readonly reader?: SchemaReader;
  readonly migrationDirectory?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly receiptPath?: string;
  readonly predecessorReceiptPath?: string;
  readonly leaseRoot?: string;
  readonly review?: string;
  readonly artifactBlobIoQuiescenceReceiptPath?: string;
  readonly artifactBlobIoCompatibilityReader?: (
    phase: DeployPhase,
    context: { readonly bearerToken: string | undefined },
  ) => Promise<ArtifactBlobIoDeploymentCompatibility>;
}

export type SchemaBaselineOptions = Omit<SchemaOptions, "receiptPath" | "predecessorReceiptPath">;

interface RehearsalReceiptLink {
  readonly digest: string;
  readonly receipt: RehearsalReceipt;
}

interface RehearsalReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly commit: string;
  readonly fromMigration: string;
  readonly throughMigration: string;
  readonly migrationDigest: string;
  readonly throughPrefixDigest: string;
  readonly migrationFiles: readonly {
    readonly name: string;
    readonly digest: string;
    readonly bytes: number;
  }[];
  readonly preAppliedMigrations: readonly string[];
  readonly preShapeDigest: string;
  readonly preApplicationShapeDigest: string | null;
  readonly preDataIntegrityDigest: string | null;
  readonly postAppliedMigrations: readonly string[];
  readonly postShapeDigest: string;
  readonly postDataIntegrityDigest: string | null;
  readonly predecessorReceipt: RehearsalReceiptLink | null;
}

interface RehearsalAttempt {
  readonly kind: typeof REHEARSAL_ATTEMPT_KIND;
  readonly commit: string;
  readonly fromMigration: string;
  readonly throughMigration: string;
  readonly migrationDigest: string;
  readonly throughPrefixDigest: string;
  readonly migrationFiles: RehearsalReceipt["migrationFiles"];
  readonly preAppliedMigrations: readonly string[];
  readonly preShapeDigest: string;
  readonly preApplicationShapeDigest: string | null;
  readonly preDataIntegrityDigest: string | null;
  readonly predecessorReceiptDigest: string | null;
}

interface ProductionAttempt {
  readonly kind: typeof PRODUCTION_ATTEMPT_KIND;
  readonly commit: string;
  readonly fromMigration: string;
  readonly throughMigration: string;
  readonly receiptDigest: string;
  readonly preAppliedMigrations: readonly string[];
  readonly preShapeDigest: string;
  readonly preApplicationShapeDigest: string | null;
  readonly preDataIntegrityDigest: string | null;
}

/**
 * Creates the one production-shaped rehearsal predecessor used by the
 * protected 0023+ migration lane. It deliberately cannot write a rehearsal
 * receipt: an empty-to-baseline bootstrap is not evidence for a production
 * transition whose durable predecessor already exists.
 */
export async function runD1SchemaRehearsalBaseline(
  invocation: SchemaInvocation,
  target: DeployTarget,
  options: SchemaBaselineOptions = {},
): Promise<Record<string, unknown>> {
  if (
    invocation.environment !== "rehearsal" ||
    target.environment !== "rehearsal" ||
    invocation.throughMigration !== undefined
  ) {
    throw preflightError("D1 rehearsal baseline is rehearsal-only and accepts no wave selector");
  }
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential(invocation.environment, {
    cloudflareEnvironment: options.cloudflareEnvironment,
    run,
  });
  const environment = credential?.childEnvironment ?? {};
  const sourceMigrations = readMigrationArtifact(
    options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
  );
  const baselineIndex = AUDITED_MIGRATION_LINEAGE.indexOf(REHEARSAL_BASELINE_MIGRATION);
  if (
    baselineIndex !== 21 ||
    JSON.stringify(sourceMigrations.names.slice(0, baselineIndex + 1)) !==
      JSON.stringify(AUDITED_MIGRATION_LINEAGE.slice(0, baselineIndex + 1))
  ) {
    throw preflightError(
      `D1 rehearsal baseline requires exact migration ${REHEARSAL_BASELINE_MIGRATION}`,
    );
  }
  assertAuditedMigrationHashes(sourceMigrations.files, baselineIndex + 1);
  const baselineNames = sourceMigrations.names.slice(0, baselineIndex + 1);
  const baselineFiles = sourceMigrations.files.slice(0, baselineIndex + 1);
  const baselineDigest = digestMigrationFiles(baselineFiles);
  const baselineBytes = baselineFiles.reduce((total, file) => total + file.bytes, 0);
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-schema-baseline-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const inspectionConfig = writeD1Config(
      join(root, "inspect-wrangler.jsonc"),
      target,
      options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
    );
    const initial = await readState(
      "preflight",
      inspectionConfig,
      environment,
      run,
      options.reader,
    );
    const empty = initial.applied.length === 0 && initial.shape === "[]\n";
    if (invocation.action === "status") {
      return {
        kind: "takoserver.d1-schema-rehearsal-baseline-status@v1",
        surface: "takoserver-d1-schema-rehearsal-baseline",
        environment: "rehearsal",
        selectedCommit: invocation.commit,
        baselineThroughMigration: REHEARSAL_BASELINE_MIGRATION,
        migrationDigest: baselineDigest,
        migrationBytes: baselineBytes,
        appliedMigrations: initial.applied,
        schemaShapeDigest: initial.shapeDigest,
        readyForApply: empty,
        rehearsalReceipt: "not-emitted-by-baseline",
      };
    }
    if (!empty) {
      throw preflightError(
        "D1 rehearsal baseline requires an exact empty selected database",
        `applied=${JSON.stringify(initial.applied)} shapeDigest=${initial.shapeDigest}`,
      );
    }

    const source = await qualifySource({
      environment: "production",
      commit: invocation.commit,
      run,
    });
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    await checked(run, "preflight", "scoped migration gate `bun run check:migrations`", [
      "bun",
      "run",
      "check:migrations",
    ]);

    const release = join(root, "release");
    const sealedMigrations = join(release, "migrations");
    mkdirSync(sealedMigrations, { recursive: true, mode: 0o700 });
    for (const file of baselineFiles) copyFileSync(file.path, join(sealedMigrations, file.name));
    const sealedMigrationArtifact = readMigrationArtifact(sealedMigrations);
    assertAuditedMigrationHashes(sealedMigrationArtifact.files, baselineIndex + 1);
    if (
      sealedMigrationArtifact.digest !== baselineDigest ||
      JSON.stringify(sealedMigrationArtifact.names) !== JSON.stringify(baselineNames)
    ) {
      throw preflightError("sealed D1 rehearsal baseline differs from the qualified prefix");
    }
    const configPath = writeD1Config(join(release, "wrangler.jsonc"), target, "migrations");
    const artifact = sealDirectory(release, [
      "wrangler.jsonc",
      ...baselineNames.map((name) => `migrations/${name}`),
    ]);

    const requalified = await readState("preflight", configPath, environment, run, options.reader);
    assertSamePreState(initial, requalified);
    artifact.assertUnchanged();
    const fenced = await readState("preflight", configPath, environment, run, options.reader);
    assertSamePreState(requalified, fenced);
    artifact.assertUnchanged();

    const apply = await run(
      wranglerCommand([
        "d1",
        "migrations",
        "apply",
        target.d1.databaseName,
        "--remote",
        "--config",
        configPath,
      ]),
      { env: environment },
    );
    if (apply.exitCode !== 0) {
      throw mutationError(
        "D1 rehearsal baseline apply acknowledgement is indeterminate; inspect exact lineage and shape",
        `${apply.stdout}${apply.stderr}`.trim(),
      );
    }
    const post = await readState("verification", configPath, environment, run, options.reader);
    if (JSON.stringify(post.applied) !== JSON.stringify(baselineNames)) {
      throw verificationError(
        "D1 rehearsal baseline post-readback does not contain exact 0001-0022 lineage",
        `expected=${JSON.stringify(baselineNames)} actual=${JSON.stringify(post.applied)}`,
      );
    }

    return {
      kind: "takoserver.d1-schema-rehearsal-baseline-apply@v1",
      surface: "takoserver-d1-schema-rehearsal-baseline",
      environment: "rehearsal",
      commit: source.commit,
      remoteRef: source.remoteRef,
      reviewer,
      baselineThroughMigration: REHEARSAL_BASELINE_MIGRATION,
      migrationDigest: sealedMigrationArtifact.digest,
      migrationBytes: sealedMigrationArtifact.bytes,
      preAppliedMigrations: initial.applied,
      preShapeDigest: initial.shapeDigest,
      postShapeDigest: post.shapeDigest,
      appliedMigrations: post.applied,
      rehearsalReceipt: "not-emitted-by-baseline",
      rollback:
        "destroy only this explicitly disposable rehearsal database; never reset production",
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

/** One forward-only D1 migration lane with rehearsal-to-production shape proof. */
export async function runD1Schema(
  invocation: SchemaInvocation,
  target: DeployTarget,
  options: SchemaOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("D1 schema invocation and target environments differ");
  }
  if (
    invocation.throughMigration !== undefined &&
    !SCHEMA_WAVE_BOUNDARIES.includes(invocation.throughMigration)
  ) {
    throw preflightError("D1 schema through migration is not an approved fixed wave boundary");
  }
  if (invocation.environment === "integration" && invocation.throughMigration !== undefined) {
    throw preflightError(
      "integration D1 schema accepts no wave selector; protected wave evidence is rehearsal/production only",
    );
  }
  if (invocation.environment !== "integration" && invocation.throughMigration === undefined) {
    throw preflightError(
      "rehearsal and production D1 schema invocations require one fixed --through-migration boundary",
    );
  }
  const run = options.run ?? runCommand;
  const credential =
    invocation.environment === "integration" &&
    options.reader !== undefined &&
    invocation.action === "status"
      ? undefined
      : await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
        });
  const environment = credential?.childEnvironment ?? {};
  const sourceMigrations = readMigrationArtifact(
    options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
  );
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-schema-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let lease: Awaited<ReturnType<typeof acquireWranglerVersionPublicationLease>> | null = null;
  try {
    lease =
      invocation.action === "apply"
        ? await acquireWranglerVersionPublicationLease({
            accountId: target.accountId,
            // Reuse the repository's owned kernel-lease primitive, but key this
            // lane by the durable D1 identity rather than the adjacent Worker.
            // Two descriptors that name the same database therefore cannot
            // bypass each other's attempt/mutation/finalization lease.
            workerName: `d1-${target.d1.databaseId}`,
            ...(options.leaseRoot === undefined ? {} : { root: options.leaseRoot }),
          })
        : null;
    const inspectionConfig = writeD1Config(
      join(root, "inspect-wrangler.jsonc"),
      target,
      options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
    );
    const initial = await readState(
      "preflight",
      inspectionConfig,
      environment,
      run,
      options.reader,
    );
    const wave = selectSchemaWave(sourceMigrations, initial.applied, invocation);
    const dataPreflights = await inspectDataPreflights({
      phase: "preflight",
      pending: wave.pending,
      applied: initial.applied,
      configPath: inspectionConfig,
      environment,
      run,
      injected: options.reader,
    });
    const legacyCatchupIntegrity = await inspectLegacyProductionCatchupDataIntegrity({
      phase: "preflight",
      wave,
      configPath: inspectionConfig,
      environment,
      run,
      injected: options.reader,
    });
    const legacyCatchupApplicationShapeDigest =
      wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY
        ? applicationSchemaShapeDigest(initial)
        : null;
    const artifactBlobIoCompatibility = await inspectArtifactBlobIoCompatibility({
      phase: "preflight",
      pending: wave.pending,
      target,
      selectedCommit: invocation.commit,
      bearerToken: credential?.token,
      injected: options.reader,
      compatibilityReader: options.artifactBlobIoCompatibilityReader,
      receiptPath: options.artifactBlobIoQuiescenceReceiptPath,
    });
    if (invocation.action === "status") {
      return {
        kind: "takoserver.d1-schema-status@v3",
        surface: "takoserver-d1-schema",
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        evidenceClass:
          invocation.environment === "integration" && invocation.throughMigration === undefined
            ? "integration-only"
            : "production-wave",
        fromMigration: wave.fromMigration,
        throughMigration: wave.throughMigration,
        migrationDigest: wave.migrationDigest,
        migrationBytes: wave.migrationBytes,
        throughPrefixDigest: wave.throughPrefixDigest,
        appliedMigrations: initial.applied,
        pendingMigrations: wave.pending,
        lastAppliedMigration: last(initial.applied),
        nextPendingMigration: wave.pending[0] ?? null,
        schemaShapeDigest: initial.shapeDigest,
        dataPreflights,
        legacyProductionCatchup: {
          ...legacyCatchupIntegrity,
          applicationSchemaShapeDigest: legacyCatchupApplicationShapeDigest,
          expectedApplicationSchemaShapeDigest:
            wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY
              ? CANONICAL_0016_APPLICATION_SCHEMA_SHAPE_DIGEST
              : null,
        },
        artifactBlobIoCompatibility,
        readyForApply:
          wave.pending.length > 0 &&
          dataPreflights.status === "ready" &&
          (wave.selector !== LEGACY_PRODUCTION_CATCHUP_BOUNDARY ||
            (legacyCatchupIntegrity.status === "ready" &&
              (JSON.stringify(initial.applied) !== JSON.stringify(wave.fromPrefixNames) ||
                legacyCatchupApplicationShapeDigest ===
                  CANONICAL_0016_APPLICATION_SCHEMA_SHAPE_DIGEST))) &&
          (artifactBlobIoCompatibility.status === "ready" ||
            artifactBlobIoCompatibility.status === "not_pending"),
      };
    }
    assertDataPreflightsReady(dataPreflights, "before qualification");
    assertLegacyProductionCatchupReady(
      wave,
      initial,
      legacyCatchupIntegrity,
      "before qualification",
    );
    assertArtifactBlobIoCompatibilityReady(artifactBlobIoCompatibility, "before qualification");
    if (invocation.environment === "integration" && wave.pending.length === 0) {
      throw preflightError(
        "the selected D1 migration wave is already complete; --apply refuses to turn a no-op into green mutation evidence",
      );
    }

    const source = await qualifySource({
      environment: invocation.environment === "integration" ? "integration" : "production",
      commit: invocation.commit,
      run,
    });
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    const receiptPath =
      invocation.environment === "integration"
        ? null
        : exactReceiptPath(
            options.receiptPath ?? requireEnvironment("TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH"),
          );
    const rehearsalReceiptAlreadyExists =
      invocation.environment === "rehearsal" && receiptPath !== null && existsSync(receiptPath);
    if (rehearsalReceiptAlreadyExists && wave.pending.length > 0) {
      throw preflightError("rehearsal receipt already exists and will not be overwritten");
    }
    await checked(run, "preflight", "scoped migration gate `bun run check:migrations`", [
      "bun",
      "run",
      "check:migrations",
    ]);

    const release = join(root, "release");
    const sealedMigrations = join(release, "migrations");
    mkdirSync(sealedMigrations, { recursive: true, mode: 0o700 });
    for (const file of wave.throughPrefixFiles) {
      copyFileSync(file.path, join(sealedMigrations, file.name));
    }
    const sealedMigrationArtifact = readMigrationArtifact(sealedMigrations);
    if (wave.selector !== null) {
      assertAuditedMigrationHashes(sealedMigrationArtifact.files, wave.throughPrefixFiles.length);
    }
    if (
      sealedMigrationArtifact.digest !== wave.throughPrefixDigest ||
      JSON.stringify(sealedMigrationArtifact.names) !== JSON.stringify(wave.throughPrefixNames)
    ) {
      throw preflightError("sealed migration prefix differs from the qualified source bytes");
    }
    const configPath = writeD1Config(join(release, "wrangler.jsonc"), target, "migrations");
    const artifact = sealDirectory(release, [
      "wrangler.jsonc",
      ...wave.throughPrefixNames.map((name) => `migrations/${name}`),
    ]);

    const requalified = await readState("preflight", configPath, environment, run, options.reader);
    assertSamePreState(initial, requalified);
    const requalifiedWave = selectSchemaWave(sourceMigrations, requalified.applied, invocation);
    if (JSON.stringify(requalifiedWave.pending) !== JSON.stringify(wave.pending)) {
      throw preflightError("D1 selected wave suffix changed during qualification");
    }
    const requalifiedDataPreflights = await inspectDataPreflights({
      phase: "preflight",
      pending: requalifiedWave.pending,
      applied: requalified.applied,
      configPath,
      environment,
      run,
      injected: options.reader,
    });
    const requalifiedLegacyCatchupIntegrity = await inspectLegacyProductionCatchupDataIntegrity({
      phase: "preflight",
      wave: requalifiedWave,
      configPath,
      environment,
      run,
      injected: options.reader,
    });
    assertSameDataPreflights(dataPreflights, requalifiedDataPreflights, "during qualification");
    assertSameLegacyProductionCatchupIntegrity(
      legacyCatchupIntegrity,
      requalifiedLegacyCatchupIntegrity,
      "during qualification",
    );
    assertDataPreflightsReady(requalifiedDataPreflights, "after qualification");
    assertLegacyProductionCatchupReady(
      requalifiedWave,
      requalified,
      requalifiedLegacyCatchupIntegrity,
      "after qualification",
    );
    const requalifiedArtifactBlobIoCompatibility = await inspectArtifactBlobIoCompatibility({
      phase: "preflight",
      pending: requalifiedWave.pending,
      target,
      selectedCommit: invocation.commit,
      bearerToken: credential?.token,
      injected: options.reader,
      compatibilityReader: options.artifactBlobIoCompatibilityReader,
      receiptPath: options.artifactBlobIoQuiescenceReceiptPath,
    });
    assertSameArtifactBlobIoCompatibility(
      artifactBlobIoCompatibility,
      requalifiedArtifactBlobIoCompatibility,
      "during qualification",
    );
    assertArtifactBlobIoCompatibilityReady(
      requalifiedArtifactBlobIoCompatibility,
      "after qualification",
    );

    const receiptEvidence =
      invocation.environment === "production" || rehearsalReceiptAlreadyExists
        ? readReceiptEvidence(receiptPath as string)
        : null;
    if (receiptEvidence) {
      assertReceiptMatches(receiptEvidence.receipt, {
        commit: source.commit,
        wave: requalifiedWave,
        pre: requalified,
        artifact: sourceMigrations,
        preDataIntegrity: requalifiedLegacyCatchupIntegrity,
      });
    }

    artifact.assertUnchanged();
    const fenced = await readState("preflight", configPath, environment, run, options.reader);
    assertSamePreState(requalified, fenced);
    const fencedWave = selectSchemaWave(sourceMigrations, fenced.applied, invocation);
    const fencedDataPreflights = await inspectDataPreflights({
      phase: "preflight",
      pending: fencedWave.pending,
      applied: fenced.applied,
      configPath,
      environment,
      run,
      injected: options.reader,
    });
    const fencedLegacyCatchupIntegrity = await inspectLegacyProductionCatchupDataIntegrity({
      phase: "preflight",
      wave: fencedWave,
      configPath,
      environment,
      run,
      injected: options.reader,
    });
    assertSameDataPreflights(
      requalifiedDataPreflights,
      fencedDataPreflights,
      "at the final mutation fence",
    );
    assertDataPreflightsReady(fencedDataPreflights, "at the final mutation fence");
    assertSameLegacyProductionCatchupIntegrity(
      requalifiedLegacyCatchupIntegrity,
      fencedLegacyCatchupIntegrity,
      "at the final mutation fence",
    );
    assertLegacyProductionCatchupReady(
      fencedWave,
      fenced,
      fencedLegacyCatchupIntegrity,
      "at the final mutation fence",
    );
    const fencedArtifactBlobIoCompatibility = await inspectArtifactBlobIoCompatibility({
      phase: "preflight",
      pending: fencedWave.pending,
      target,
      selectedCommit: invocation.commit,
      bearerToken: credential?.token,
      injected: options.reader,
      compatibilityReader: options.artifactBlobIoCompatibilityReader,
      receiptPath: options.artifactBlobIoQuiescenceReceiptPath,
    });
    assertSameArtifactBlobIoCompatibility(
      requalifiedArtifactBlobIoCompatibility,
      fencedArtifactBlobIoCompatibility,
      "at the final mutation fence",
    );
    assertArtifactBlobIoCompatibilityReady(
      fencedArtifactBlobIoCompatibility,
      "at the final mutation fence",
    );
    artifact.assertUnchanged();
    const predecessorReceiptEvidence =
      invocation.environment === "rehearsal"
        ? receiptEvidence?.receipt.predecessorReceipt === undefined
          ? readPredecessorReceiptEvidence(options.predecessorReceiptPath, {
              commit: source.commit,
              wave: fencedWave,
              artifact: sourceMigrations,
            })
          : receiptEvidence.receipt.predecessorReceipt
        : null;
    const rehearsalAttempt =
      invocation.environment === "rehearsal"
        ? prepareRehearsalAttempt(receiptPath as string, {
            commit: source.commit,
            wave: fencedWave,
            pre: fenced,
            preDataIntegrity: fencedLegacyCatchupIntegrity,
            predecessorReceipt: predecessorReceiptEvidence,
          })
        : null;
    if (predecessorReceiptEvidence && rehearsalAttempt) {
      assertPredecessorReceiptMatches(predecessorReceiptEvidence, {
        commit: source.commit,
        wave: fencedWave,
        artifact: sourceMigrations,
        preShapeDigest: rehearsalAttempt.preShapeDigest,
      });
    }
    const fencedReceiptEvidence =
      receiptPath && receiptEvidence ? readReceiptEvidence(receiptPath) : null;
    if (fencedReceiptEvidence && receiptEvidence && receiptPath) {
      if (fencedReceiptEvidence.digest !== receiptEvidence.digest) {
        throw preflightError("D1 rehearsal receipt bytes changed during qualification");
      }
      assertReceiptMatches(fencedReceiptEvidence.receipt, {
        commit: source.commit,
        wave: fencedWave,
        pre: fenced,
        artifact: sourceMigrations,
        preDataIntegrity: fencedLegacyCatchupIntegrity,
      });
      if (invocation.environment === "production") {
        const productionAttempt = prepareProductionAttempt(receiptPath, {
          commit: source.commit,
          wave: fencedWave,
          pre: fenced,
          preDataIntegrity: fencedLegacyCatchupIntegrity,
          receiptDigest: fencedReceiptEvidence.digest,
        });
        if (
          productionAttempt.preShapeDigest !== fencedReceiptEvidence.receipt.preShapeDigest ||
          productionAttempt.preApplicationShapeDigest !==
            fencedReceiptEvidence.receipt.preApplicationShapeDigest ||
          productionAttempt.preDataIntegrityDigest !==
            fencedReceiptEvidence.receipt.preDataIntegrityDigest ||
          JSON.stringify(productionAttempt.preAppliedMigrations) !==
            JSON.stringify(fencedReceiptEvidence.receipt.preAppliedMigrations)
        ) {
          throw preflightError(
            "production attempt predecessor does not match the exact rehearsal receipt",
          );
        }
      }
    }
    let runtimeInputQuiescence: "not-required" | "installed-and-zero" = "not-required";
    let providerAcknowledgement = "reconciled-complete-without-second-apply";
    let post = fenced;
    if (fencedWave.pending.length > 0) {
      runtimeInputQuiescence = await enforceRuntimeInputPreparationV2Quiescence({
        pending: fencedWave.pending,
        applied: fenced.applied,
        configPath,
        environment,
        run,
        injected: options.reader,
      });
      const mutationArtifactBlobIoCompatibility = await inspectArtifactBlobIoCompatibility({
        phase: "mutation",
        pending: fencedWave.pending,
        target,
        selectedCommit: invocation.commit,
        bearerToken: credential?.token,
        injected: options.reader,
        compatibilityReader: options.artifactBlobIoCompatibilityReader,
        receiptPath: options.artifactBlobIoQuiescenceReceiptPath,
      });
      if (
        JSON.stringify(mutationArtifactBlobIoCompatibility) !==
        JSON.stringify(fencedArtifactBlobIoCompatibility)
      ) {
        throw mutationError(
          "0043 artifact blob I/O deployment compatibility changed at the immediate migration fence",
        );
      }
      if (
        mutationArtifactBlobIoCompatibility.status !== "ready" &&
        mutationArtifactBlobIoCompatibility.status !== "not_pending"
      ) {
        throw mutationError(
          "0043 artifact blob I/O deployment compatibility is not ready at the immediate migration fence",
        );
      }
      // Keep this D1 count after the slower Worker/history proof. The only
      // later provider reads are the selected catch-up integrity fence and the
      // 0037 exact monotonic-trigger/zero-count fence immediately below.
      await enforceArtifactBlobIoConflictMutationFence({
        pending: fencedWave.pending,
        configPath,
        environment,
        run,
        injected: options.reader,
      });
      const immediateLegacyCatchupIntegrity = await inspectLegacyProductionCatchupDataIntegrity({
        phase: "mutation",
        wave: fencedWave,
        configPath,
        environment,
        run,
        injected: options.reader,
      });
      assertSameLegacyProductionCatchupIntegrity(
        fencedLegacyCatchupIntegrity,
        immediateLegacyCatchupIntegrity,
        "at the immediate migration fence",
      );
      assertLegacyProductionCatchupReady(
        fencedWave,
        fenced,
        immediateLegacyCatchupIntegrity,
        "at the immediate migration fence",
      );
      await verifyRuntimeInputPreparationV2QuiescenceAtMigrationFence({
        pending: fencedWave.pending,
        applied: fenced.applied,
        configPath,
        environment,
        run,
        injected: options.reader,
      });
      const apply = await run(
        wranglerCommand([
          "d1",
          "migrations",
          "apply",
          target.d1.databaseName,
          "--remote",
          "--config",
          configPath,
        ]),
        { env: environment },
      );
      providerAcknowledgement = "acknowledged";
      if (apply.exitCode !== 0) {
        let readback: D1SchemaState;
        try {
          readback = await readState("mutation", configPath, environment, run, options.reader);
        } catch (error) {
          throw mutationError(
            "D1 migration apply failed and authoritative readback also failed; do not retry blindly",
            JSON.stringify({
              fromMigration: wave.fromMigration,
              throughMigration: wave.throughMigration,
              providerDiagnostics: `${apply.stdout}${apply.stderr}`.trim(),
              readbackError:
                error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            }),
          );
        }
        let remaining: readonly string[];
        try {
          remaining = pendingMigrations(wave.throughPrefixNames, readback.applied);
        } catch (error) {
          throw mutationError(
            "D1 migration apply failed and authoritative lineage is outside the selected wave",
            JSON.stringify({
              fromMigration: wave.fromMigration,
              throughMigration: wave.throughMigration,
              lastAppliedMigration: last(readback.applied),
              appliedMigrations: readback.applied,
              schemaShapeDigest: readback.shapeDigest,
              providerDiagnostics: `${apply.stdout}${apply.stderr}`.trim(),
              lineageError:
                error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            }),
          );
        }
        if (remaining.length > 0) {
          throw mutationError(
            "D1 migration wave partially applied; status and a retry must retain this exact selected wave and evidence",
            JSON.stringify({
              fromMigration: wave.fromMigration,
              throughMigration: wave.throughMigration,
              lastAppliedMigration: last(readback.applied),
              nextPendingMigration: remaining[0] ?? null,
              appliedMigrations: readback.applied,
              schemaShapeDigest: readback.shapeDigest,
              providerDiagnostics: `${apply.stdout}${apply.stderr}`.trim(),
            }),
          );
        }
        providerAcknowledgement = "provider-error-recovered-by-authoritative-readback";
        post = readback;
      } else {
        post = await readState("verification", configPath, environment, run, options.reader);
      }
    }
    const postLegacyCatchupIntegrity = await inspectLegacyProductionCatchupDataIntegrity({
      phase: "verification",
      wave,
      configPath,
      environment,
      run,
      injected: options.reader,
    });
    assertSameLegacyProductionCatchupIntegrity(
      fencedLegacyCatchupIntegrity,
      postLegacyCatchupIntegrity,
      "across the migration",
    );
    if (JSON.stringify(post.applied) !== JSON.stringify(wave.throughPrefixNames)) {
      throw verificationError(
        "D1 post-readback does not contain the exact selected-wave lineage",
        `expected=${JSON.stringify(wave.throughPrefixNames)} actual=${JSON.stringify(post.applied)}`,
      );
    }
    if (
      fencedReceiptEvidence &&
      postLegacyCatchupIntegrity.dataIntegrityDigest !==
        fencedReceiptEvidence.receipt.postDataIntegrityDigest
    ) {
      throw verificationError(
        "production D1 post-data integrity differs from the exact rehearsal receipt",
      );
    }
    if (pendingMigrations(wave.throughPrefixNames, post.applied).length !== 0) {
      throw verificationError(
        "D1 post-readback still has migrations pending within the selected wave",
      );
    }
    if (
      fencedReceiptEvidence &&
      post.shapeDigest !== fencedReceiptEvidence.receipt.postShapeDigest
    ) {
      throw verificationError(
        "production D1 post-shape differs from the exact rehearsal receipt",
        `expected=${fencedReceiptEvidence.receipt.postShapeDigest} actual=${post.shapeDigest}`,
      );
    }
    if (receiptPath && invocation.environment === "production") {
      removeAttemptFile(`${receiptPath}.production-attempt`, "D1 production wave attempt evidence");
    }

    if (invocation.environment === "rehearsal" && receiptPath) {
      const completedReceipt: RehearsalReceipt = {
        kind: RECEIPT_KIND,
        commit: source.commit,
        fromMigration: wave.fromMigration as string,
        throughMigration: wave.throughMigration,
        migrationDigest: wave.migrationDigest,
        throughPrefixDigest: wave.throughPrefixDigest,
        migrationFiles: wave.migrationFiles.map(({ name, digest, bytes }) => ({
          name,
          digest,
          bytes,
        })),
        preAppliedMigrations: wave.fromPrefixNames,
        preShapeDigest: (rehearsalAttempt as RehearsalAttempt).preShapeDigest,
        preApplicationShapeDigest: (rehearsalAttempt as RehearsalAttempt).preApplicationShapeDigest,
        preDataIntegrityDigest: (rehearsalAttempt as RehearsalAttempt).preDataIntegrityDigest,
        postAppliedMigrations: post.applied,
        postShapeDigest: post.shapeDigest,
        postDataIntegrityDigest: postLegacyCatchupIntegrity.dataIntegrityDigest,
        predecessorReceipt:
          predecessorReceiptEvidence === null
            ? null
            : {
                digest: predecessorReceiptEvidence.digest,
                receipt: predecessorReceiptEvidence.receipt,
              },
      };
      if (fencedReceiptEvidence) {
        if (digestReceipt(completedReceipt) !== fencedReceiptEvidence.digest) {
          throw verificationError(
            "completed D1 rehearsal state does not match the existing exact receipt",
          );
        }
      } else {
        writeReceipt(receiptPath, completedReceipt);
      }
      removeAttemptFile(`${receiptPath}.attempt`, "D1 rehearsal attempt evidence");
    }

    return {
      kind: "takoserver.d1-schema-apply@v3",
      surface: "takoserver-d1-schema",
      environment: invocation.environment,
      commit: source.commit,
      remoteRef: source.remoteRef,
      reviewer,
      evidenceClass:
        invocation.environment === "integration" && invocation.throughMigration === undefined
          ? "integration-only"
          : "production-wave",
      fromMigration: wave.fromMigration,
      throughMigration: wave.throughMigration,
      migrationDigest: wave.migrationDigest,
      migrationBytes: wave.migrationBytes,
      throughPrefixDigest: wave.throughPrefixDigest,
      pendingMigrations: wave.pending,
      dataPreflights: fencedDataPreflights,
      legacyProductionCatchup: {
        ...postLegacyCatchupIntegrity,
        applicationSchemaShapeDigest:
          wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY
            ? CANONICAL_0016_APPLICATION_SCHEMA_SHAPE_DIGEST
            : null,
      },
      artifactBlobIoCompatibility: fencedArtifactBlobIoCompatibility,
      runtimeInputQuiescence,
      preShapeDigest: requalified.shapeDigest,
      postShapeDigest: post.shapeDigest,
      appliedMigrations: post.applied,
      lastAppliedMigration: last(post.applied),
      nextPendingMigration: null,
      providerAcknowledgement,
      rehearsalReceipt:
        invocation.environment === "rehearsal"
          ? rehearsalReceiptAlreadyExists
            ? "reconciled-existing-exact-receipt"
            : "written-without-overwrite"
          : invocation.environment === "production"
            ? "exact-match-consumed-read-only"
            : "not-emitted-integration-evidence-is-never-production-acceptable",
      rollback: "forward repair only: D1 migrations have no down path",
    };
  } finally {
    try {
      unsealDirectory(root);
      if (temporary) rmSync(root, { recursive: true, force: true });
    } finally {
      await lease?.release();
    }
  }
}

type MigrationArtifact = ReturnType<typeof readMigrationArtifact>;
type MigrationArtifactFile = MigrationArtifact["files"][number];

interface SelectedSchemaWave {
  readonly selector: SchemaWaveBoundary | null;
  readonly fromMigration: string | null;
  readonly throughMigration: string;
  readonly fromPrefixNames: readonly string[];
  readonly throughPrefixNames: readonly string[];
  readonly migrationFiles: readonly MigrationArtifactFile[];
  readonly throughPrefixFiles: readonly MigrationArtifactFile[];
  readonly migrationDigest: string;
  readonly migrationBytes: number;
  readonly throughPrefixDigest: string;
  readonly pending: readonly string[];
}

function selectSchemaWave(
  artifact: MigrationArtifact,
  applied: readonly string[],
  invocation: SchemaInvocation,
): SelectedSchemaWave {
  pendingMigrations(artifact.names, applied);
  if (invocation.throughMigration === undefined) {
    if (invocation.environment !== "integration") {
      throw preflightError(
        "rehearsal and production D1 schema invocations require one fixed --through-migration boundary",
      );
    }
    const migrationFiles = artifact.files.slice(applied.length);
    return {
      selector: null,
      fromMigration: last(applied),
      throughMigration: artifact.names.at(-1) as string,
      fromPrefixNames: [...applied],
      throughPrefixNames: artifact.names,
      migrationFiles,
      throughPrefixFiles: artifact.files,
      migrationDigest: digestMigrationFiles(migrationFiles),
      migrationBytes: migrationFiles.reduce((total, file) => total + file.bytes, 0),
      throughPrefixDigest: artifact.digest,
      pending: artifact.names.slice(applied.length),
    };
  }

  const definition = SCHEMA_WAVES[invocation.throughMigration];
  if (JSON.stringify(artifact.names) !== JSON.stringify(AUDITED_MIGRATION_LINEAGE)) {
    throw preflightError(
      "selected D1 wave requires the exact audited source inventory 0001-0049",
      `from=${definition.fromMigration} through=${definition.throughMigration}`,
    );
  }
  assertAuditedMigrationHashes(artifact.files);
  if (applied.length < definition.fromCount || applied.length > definition.throughCount) {
    throw preflightError(
      "selected D1 wave is not the exact current wave and cannot skip or replay a boundary",
      `selected=${definition.fromMigration}->${definition.throughMigration} lastApplied=${last(applied)}`,
    );
  }
  const fromPrefixNames = artifact.names.slice(0, definition.fromCount);
  const throughPrefixNames = artifact.names.slice(0, definition.throughCount);
  const migrationFiles = artifact.files.slice(definition.fromCount, definition.throughCount);
  const throughPrefixFiles = artifact.files.slice(0, definition.throughCount);
  return {
    selector: invocation.throughMigration,
    fromMigration: definition.fromMigration,
    throughMigration: definition.throughMigration,
    fromPrefixNames,
    throughPrefixNames,
    migrationFiles,
    throughPrefixFiles,
    migrationDigest: digestMigrationFiles(migrationFiles),
    migrationBytes: migrationFiles.reduce((total, file) => total + file.bytes, 0),
    throughPrefixDigest: digestMigrationFiles(throughPrefixFiles),
    pending: artifact.names.slice(applied.length, definition.throughCount),
  };
}

function assertAuditedMigrationHashes(
  files: readonly MigrationArtifactFile[],
  count: number = AUDITED_MIGRATION_LINEAGE.length,
): void {
  for (const [index, name] of AUDITED_MIGRATION_LINEAGE.slice(0, count).entries()) {
    const file = files[index];
    const body = file === undefined ? null : readFileSync(file.path);
    const actualDigest = body === null ? "missing" : digestBytes(body);
    if (
      file?.name !== name ||
      file.digest !== AUDITED_MIGRATION_SHA256[name] ||
      actualDigest !== AUDITED_MIGRATION_SHA256[name] ||
      file?.bytes !== body?.byteLength
    ) {
      throw preflightError(
        "selected D1 wave requires the exact audited migration SHA-256 for every 0001-0049 file",
        `position=${index + 1} name=${name} expected=${AUDITED_MIGRATION_SHA256[name]} actual=${actualDigest}`,
      );
    }
  }
}

function digestMigrationFiles(files: readonly MigrationArtifactFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const body = readFileSync(file.path);
    hash.update(file.name);
    hash.update("\0");
    hash.update(String(body.byteLength));
    hash.update("\0");
    hash.update(body);
  }
  return `sha256:${hash.digest("hex")}`;
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface LegacyProductionCatchupDataIntegrity {
  readonly status: "not_pending" | "ready" | "data_repair_required";
  readonly dataIntegrityDigest: string | null;
  readonly ledgerRowCount: number | null;
  readonly principalRowCount: number | null;
  readonly organizationRowCount: number | null;
  readonly organizationMembershipRowCount: number | null;
  readonly organizationOwnerProjectionMismatchCount: number | null;
  readonly usageEventRowCount: number | null;
  readonly resourceDeploymentRowCount: number | null;
  readonly activeResourceUidConflictCount: number | null;
  readonly liveNativeIdentityConflictCount: number | null;
}

async function inspectLegacyProductionCatchupDataIntegrity(input: {
  readonly phase: DeployPhase;
  readonly wave: SelectedSchemaWave;
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: SchemaProcess;
  readonly injected: SchemaReader | undefined;
}): Promise<LegacyProductionCatchupDataIntegrity> {
  if (input.wave.selector !== LEGACY_PRODUCTION_CATCHUP_BOUNDARY) {
    return {
      status: "not_pending",
      dataIntegrityDigest: null,
      ledgerRowCount: null,
      principalRowCount: null,
      organizationRowCount: null,
      organizationMembershipRowCount: null,
      organizationOwnerProjectionMismatchCount: null,
      usageEventRowCount: null,
      resourceDeploymentRowCount: null,
      activeResourceUidConflictCount: null,
      liveNativeIdentityConflictCount: null,
    };
  }
  const raw = input.injected
    ? await input.injected.legacyProductionCatchupDataIntegrity?.(input.phase)
    : (
        await new RemoteD1(input.configPath, {
          environment: input.environment,
          run: input.run,
        }).query(
          input.phase,
          "0016 to 0022 critical data integrity",
          `SELECT
             (SELECT COUNT(*) FROM ledger) AS ledger_row_count,
             (SELECT COUNT(*) FROM principals) AS principal_row_count,
             (SELECT COUNT(*) FROM orgs) AS organization_row_count,
             (SELECT COUNT(*) FROM org_memberships) AS organization_membership_row_count,
             (SELECT COUNT(*) FROM orgs AS organization
              WHERE NOT EXISTS (
                SELECT 1 FROM org_memberships AS membership
                WHERE membership.org_id = organization.id
                  AND membership.principal_id = organization.owner_principal_id
                  AND membership.role = 'owner'
              )) AS organization_owner_projection_mismatch_count,
             (SELECT COUNT(*) FROM usage_events) AS usage_event_row_count,
             (SELECT COUNT(*) FROM tf_resource_deployments) AS resource_deployment_row_count,
             (SELECT COUNT(*) FROM (
                SELECT tenant_id, resource_uid
                FROM tf_resource_deployments WHERE state = 'active'
                GROUP BY tenant_id, resource_uid HAVING COUNT(*) > 1
              )) AS active_resource_uid_conflict_count,
             (SELECT COUNT(*) FROM (
                SELECT tenant_id, provider_installation_ref, native_id
                FROM tf_resource_deployments
                WHERE state IN ('provisioning', 'candidate', 'active', 'draining')
                GROUP BY tenant_id, provider_installation_ref, native_id
                HAVING COUNT(*) > 1
              )) AS live_native_identity_conflict_count`,
        )
      )[0];
  const row = raw as Readonly<Record<string, unknown>> | undefined;
  const snapshot = {
    ledgerRowCount: exactNonnegativeCount(
      row?.ledgerRowCount ?? row?.ledger_row_count,
      "0016 to 0022 ledger row count",
    ),
    principalRowCount: exactNonnegativeCount(
      row?.principalRowCount ?? row?.principal_row_count,
      "0016 to 0022 principal row count",
    ),
    organizationRowCount: exactNonnegativeCount(
      row?.organizationRowCount ?? row?.organization_row_count,
      "0016 to 0022 organization row count",
    ),
    organizationMembershipRowCount: exactNonnegativeCount(
      row?.organizationMembershipRowCount ?? row?.organization_membership_row_count,
      "0016 to 0022 organization membership row count",
    ),
    organizationOwnerProjectionMismatchCount: exactNonnegativeCount(
      row?.organizationOwnerProjectionMismatchCount ??
        row?.organization_owner_projection_mismatch_count,
      "0016 to 0022 organization owner projection mismatch count",
    ),
    usageEventRowCount: exactNonnegativeCount(
      row?.usageEventRowCount ?? row?.usage_event_row_count,
      "0016 to 0022 usage event row count",
    ),
    resourceDeploymentRowCount: exactNonnegativeCount(
      row?.resourceDeploymentRowCount ?? row?.resource_deployment_row_count,
      "0016 to 0022 resource deployment row count",
    ),
    activeResourceUidConflictCount: exactNonnegativeCount(
      row?.activeResourceUidConflictCount ?? row?.active_resource_uid_conflict_count,
      "0016 to 0022 active Resource UID conflict count",
    ),
    liveNativeIdentityConflictCount: exactNonnegativeCount(
      row?.liveNativeIdentityConflictCount ?? row?.live_native_identity_conflict_count,
      "0016 to 0022 live native identity conflict count",
    ),
  };
  const dataIntegrityDigest = digestBytes(
    Buffer.from(
      JSON.stringify({
        kind: "takoserver.d1-0016-to-0022-critical-data@v1",
        ...snapshot,
      }),
    ),
  );
  return {
    status:
      snapshot.ledgerRowCount === 0 &&
      snapshot.organizationOwnerProjectionMismatchCount === 0 &&
      snapshot.activeResourceUidConflictCount === 0 &&
      snapshot.liveNativeIdentityConflictCount === 0
        ? "ready"
        : "data_repair_required",
    dataIntegrityDigest,
    ...snapshot,
  };
}

function applicationSchemaShapeDigest(state: D1SchemaState): string {
  let value: unknown;
  try {
    value = JSON.parse(state.shape);
  } catch {
    throw preflightError("0016 canonical application schema shape is not valid JSON");
  }
  if (!Array.isArray(value)) {
    throw preflightError("0016 canonical application schema shape is not an array");
  }
  const applicationRows = value.filter((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.type !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.table !== "string" ||
      typeof entry.sql !== "string"
    ) {
      throw preflightError("0016 canonical application schema shape has an invalid row");
    }
    return entry.name !== "d1_migrations" && entry.table !== "d1_migrations";
  });
  return digestBytes(Buffer.from(`${JSON.stringify(applicationRows)}\n`));
}

function assertLegacyProductionCatchupReady(
  wave: SelectedSchemaWave,
  state: D1SchemaState,
  integrity: LegacyProductionCatchupDataIntegrity,
  when: string,
): void {
  if (wave.selector !== LEGACY_PRODUCTION_CATCHUP_BOUNDARY) return;
  if (integrity.status !== "ready" || integrity.dataIntegrityDigest === null) {
    throw preflightError(
      `0016 to 0022 production catch-up critical data requires operator repair ${when}`,
      JSON.stringify(integrity),
    );
  }
  if (
    JSON.stringify(state.applied) === JSON.stringify(wave.fromPrefixNames) &&
    applicationSchemaShapeDigest(state) !== CANONICAL_0016_APPLICATION_SCHEMA_SHAPE_DIGEST
  ) {
    throw preflightError(
      `0016 to 0022 production catch-up requires the exact canonical 0001-0016 application schema shape ${when}`,
    );
  }
}

function assertSameLegacyProductionCatchupIntegrity(
  left: LegacyProductionCatchupDataIntegrity,
  right: LegacyProductionCatchupDataIntegrity,
  when: string,
): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw preflightError(`0016 to 0022 critical data integrity changed ${when}`);
  }
}

interface ResourceDeletionAttestationPreflight {
  readonly status: "not_pending" | "ready" | "legacy_data_repair_required";
  readonly malformedFormRefCount: number;
  readonly duplicateLiveResourceUidCount: number;
}

interface ProviderRepairPreflight {
  readonly status: "not_pending" | "ready" | "operator_reconciliation_required";
  readonly unmatchedDispatchedSagaCount: number;
}

interface RuntimeInputPreparationV2Preflight {
  readonly status: "not_pending" | "ready" | "legacy_data_repair_required";
  readonly predecessorRowCount: number;
  readonly quiescence: "not_required" | "required_at_apply" | "installed";
}

interface LiveNativeClaimPreflight {
  readonly status: "not_pending" | "ready" | "legacy_data_repair_required";
  readonly duplicateLiveNativeClaimCount: number;
}

interface ArtifactBlobIoFencePreflight {
  readonly status: "not_pending" | "ready" | "legacy_data_repair_required";
  readonly activeRootDeletingCandidateConflictCount: number;
}

interface DataPreflights {
  readonly status: "ready" | "data_repair_required";
  readonly resourceDeletionAttestation: ResourceDeletionAttestationPreflight;
  readonly providerRepair: ProviderRepairPreflight;
  readonly runtimeInputPreparationV2: RuntimeInputPreparationV2Preflight;
  readonly liveNativeClaim: LiveNativeClaimPreflight;
  readonly artifactBlobIoFence: ArtifactBlobIoFencePreflight;
}

type ArtifactBlobIoCompatibilityPreflight =
  | ArtifactBlobIoDeploymentCompatibility
  | {
      readonly status: "not_pending";
      readonly currentCompatibilityDeploymentId: null;
      readonly rollbackCompatibilityDeploymentId: null;
      readonly currentCompatibilityVersionId: null;
      readonly rollbackCompatibilityVersionId: null;
      readonly unsafePredecessorInvocations: "unproven";
    };

async function inspectArtifactBlobIoCompatibility(input: {
  readonly phase: DeployPhase;
  readonly pending: readonly string[];
  readonly target: DeployTarget;
  readonly selectedCommit: string;
  readonly bearerToken: string | undefined;
  readonly injected: SchemaReader | undefined;
  readonly compatibilityReader:
    | ((
        phase: DeployPhase,
        context: { readonly bearerToken: string | undefined },
      ) => Promise<ArtifactBlobIoDeploymentCompatibility>)
    | undefined;
  readonly receiptPath: string | undefined;
}): Promise<ArtifactBlobIoCompatibilityPreflight> {
  if (!input.pending.includes(ARTIFACT_BLOB_IO_FENCE_MIGRATION)) {
    return {
      status: "not_pending",
      currentCompatibilityDeploymentId: null,
      rollbackCompatibilityDeploymentId: null,
      currentCompatibilityVersionId: null,
      rollbackCompatibilityVersionId: null,
      unsafePredecessorInvocations: "unproven",
    };
  }
  if (input.compatibilityReader) {
    return await input.compatibilityReader(input.phase, { bearerToken: input.bearerToken });
  }
  const injected = input.injected?.artifactBlobIoDeploymentCompatibility;
  if (injected) return await injected(input.phase);
  const token = input.bearerToken;
  if (typeof token !== "string") {
    throw preflightError("0043 compatibility preflight requires CLOUDFLARE_API_TOKEN");
  }
  return await inspectArtifactBlobIoDeploymentCompatibility({
    phase: input.phase,
    target: input.target,
    selectedCommit: input.selectedCommit,
    state: new CloudflareState({ accountId: input.target.accountId, token }),
    ...((input.receiptPath ?? process.env.TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH)
      ? {
          receiptPath:
            input.receiptPath ??
            (process.env.TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH as string),
        }
      : {}),
  });
}

function assertArtifactBlobIoCompatibilityReady(
  preflight: ArtifactBlobIoCompatibilityPreflight,
  when: string,
): void {
  if (preflight.status !== "ready" && preflight.status !== "not_pending") {
    throw preflightError(
      `0043 artifact blob I/O deployment compatibility requires operator action ${when}`,
      JSON.stringify(preflight),
    );
  }
}

function assertSameArtifactBlobIoCompatibility(
  left: ArtifactBlobIoCompatibilityPreflight,
  right: ArtifactBlobIoCompatibilityPreflight,
  when: string,
): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw preflightError(`0043 artifact blob I/O deployment compatibility changed ${when}`);
  }
}

async function inspectDataPreflights(input: {
  readonly phase: DeployPhase;
  readonly pending: readonly string[];
  readonly applied: readonly string[];
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: SchemaProcess;
  readonly injected: SchemaReader | undefined;
}): Promise<DataPreflights> {
  const database = input.injected
    ? null
    : new RemoteD1(input.configPath, { environment: input.environment, run: input.run });
  const [
    resourceDeletionAttestation,
    providerRepair,
    runtimeInputPreparationV2,
    liveNativeClaim,
    artifactBlobIoFence,
  ] = await Promise.all([
    inspectResourceDeletionAttestationPreflight({ ...input, database }),
    inspectProviderRepairPreflight(input),
    inspectRuntimeInputPreparationV2Preflight({ ...input, database }),
    inspectLiveNativeClaimPreflight({ ...input, database }),
    inspectArtifactBlobIoFencePreflight({ ...input, database }),
  ]);
  return {
    status:
      resourceDeletionAttestation.status === "legacy_data_repair_required" ||
      providerRepair.status === "operator_reconciliation_required" ||
      runtimeInputPreparationV2.status === "legacy_data_repair_required" ||
      liveNativeClaim.status === "legacy_data_repair_required" ||
      artifactBlobIoFence.status === "legacy_data_repair_required"
        ? "data_repair_required"
        : "ready",
    resourceDeletionAttestation,
    providerRepair,
    runtimeInputPreparationV2,
    liveNativeClaim,
    artifactBlobIoFence,
  };
}

function assertDataPreflightsReady(preflights: DataPreflights, when: string): void {
  if (preflights.status !== "ready") {
    throw preflightError(
      `D1 migration data preflights require operator repair ${when}`,
      JSON.stringify(preflights),
    );
  }
}

function assertSameDataPreflights(left: DataPreflights, right: DataPreflights, when: string): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw preflightError(`D1 migration data preflights changed ${when}`);
  }
}

async function inspectResourceDeletionAttestationPreflight(input: {
  readonly phase: DeployPhase;
  readonly pending: readonly string[];
  readonly injected: SchemaReader | undefined;
  readonly database: RemoteD1 | null;
}): Promise<ResourceDeletionAttestationPreflight> {
  if (!input.pending.includes(RESOURCE_DELETION_ATTESTATION_MIGRATION)) {
    return {
      status: "not_pending",
      malformedFormRefCount: 0,
      duplicateLiveResourceUidCount: 0,
    };
  }
  const counts = input.injected
    ? await input.injected.resourceDeletionAttestationBackfillCounts?.(input.phase)
    : await readResourceDeletionAttestationBackfillCounts(input.database as RemoteD1, input.phase);
  const malformedFormRefCount = exactNonnegativeCount(
    counts?.malformedFormRefCount,
    "0029 malformed FormRef preflight",
  );
  const duplicateLiveResourceUidCount = exactNonnegativeCount(
    counts?.duplicateLiveResourceUidCount,
    "0029 duplicate live Resource UID preflight",
  );
  return {
    status:
      malformedFormRefCount === 0 && duplicateLiveResourceUidCount === 0
        ? "ready"
        : "legacy_data_repair_required",
    malformedFormRefCount,
    duplicateLiveResourceUidCount,
  };
}

async function inspectRuntimeInputPreparationV2Preflight(input: {
  readonly phase: DeployPhase;
  readonly pending: readonly string[];
  readonly applied: readonly string[];
  readonly injected: SchemaReader | undefined;
  readonly database: RemoteD1 | null;
}): Promise<RuntimeInputPreparationV2Preflight> {
  if (!input.pending.includes(RUNTIME_INPUT_PREPARATION_V2_MIGRATION)) {
    return { status: "not_pending", predecessorRowCount: 0, quiescence: "not_required" };
  }
  if (!input.applied.includes(RUNTIME_INPUT_PREPARATION_MIGRATION)) {
    return { status: "ready", predecessorRowCount: 0, quiescence: "required_at_apply" };
  }
  const count = input.injected
    ? await input.injected.legacyRuntimeInputPreparationCount?.(input.phase)
    : await readSingleCount(
        input.database as RemoteD1,
        input.phase,
        "0037 runtime-input predecessor preflight",
        "SELECT COUNT(*) AS row_count FROM worker_runtime_input_preparations",
        "row_count",
      );
  const predecessorRowCount = exactNonnegativeCount(
    count,
    "0037 runtime-input predecessor preflight",
  );
  const quiescence = input.injected
    ? "required_at_apply"
    : await inspectRuntimeInputQuiescence(input.database as RemoteD1, input.phase);
  return {
    status: predecessorRowCount === 0 ? "ready" : "legacy_data_repair_required",
    predecessorRowCount,
    quiescence,
  };
}

async function inspectRuntimeInputQuiescence(
  database: RemoteD1,
  phase: DeployPhase,
): Promise<"required_at_apply" | "installed"> {
  const rows = await database.query(
    phase,
    "0037 runtime-input quiescence status",
    `SELECT COALESCE((
       SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = '${RUNTIME_INPUT_QUIESCENCE_TRIGGER}'
     ), '') AS trigger_sql`,
  );
  if (rows.length !== 1 || typeof rows[0]?.trigger_sql !== "string") {
    throw preflightError("0037 runtime-input quiescence status returned a malformed result");
  }
  if (rows[0].trigger_sql === "") return "required_at_apply";
  if (rows[0].trigger_sql !== RUNTIME_INPUT_QUIESCENCE_TRIGGER_SQL) {
    throw preflightError("0037 runtime-input quiescence trigger exists with unexpected SQL");
  }
  return "installed";
}

async function enforceRuntimeInputPreparationV2Quiescence(input: {
  readonly pending: readonly string[];
  readonly applied: readonly string[];
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: SchemaProcess;
  readonly injected: SchemaReader | undefined;
}): Promise<"not-required" | "installed-and-zero"> {
  if (
    !input.pending.includes(RUNTIME_INPUT_PREPARATION_V2_MIGRATION) ||
    !input.applied.includes(RUNTIME_INPUT_PREPARATION_MIGRATION)
  ) {
    return "not-required";
  }
  if (input.injected) {
    const result = await input.injected.installRuntimeInputPreparationV2Quiescence?.("mutation");
    if (result?.status !== "installed" || result.predecessorRowCount !== 0) {
      throw mutationError(
        "0037 runtime-input quiescence could not prove its monotonic insert guard and zero predecessor",
      );
    }
    return "installed-and-zero";
  }

  const database = new RemoteD1(input.configPath, {
    environment: input.environment,
    run: input.run,
  });
  const before = await readRuntimeInputQuiescence(database, "mutation");
  if (before.triggerSql === "") {
    await database.statement(
      "mutation",
      "0037 runtime-input monotonic quiescence trigger",
      RUNTIME_INPUT_QUIESCENCE_INSTALL_SQL,
    );
  } else if (before.triggerSql !== RUNTIME_INPUT_QUIESCENCE_TRIGGER_SQL) {
    throw mutationError("0037 runtime-input quiescence trigger exists with unexpected SQL");
  }
  const after = await readRuntimeInputQuiescence(database, "mutation");
  if (
    after.triggerSql !== RUNTIME_INPUT_QUIESCENCE_TRIGGER_SQL ||
    after.predecessorRowCount !== 0
  ) {
    throw mutationError(
      "0037 runtime-input quiescence did not read back the exact insert guard and zero predecessor",
      JSON.stringify(after),
    );
  }
  return "installed-and-zero";
}

async function verifyRuntimeInputPreparationV2QuiescenceAtMigrationFence(input: {
  readonly pending: readonly string[];
  readonly applied: readonly string[];
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: SchemaProcess;
  readonly injected: SchemaReader | undefined;
}): Promise<void> {
  if (
    !input.pending.includes(RUNTIME_INPUT_PREPARATION_V2_MIGRATION) ||
    !input.applied.includes(RUNTIME_INPUT_PREPARATION_MIGRATION)
  ) {
    return;
  }
  if (input.injected) {
    const result = await input.injected.installRuntimeInputPreparationV2Quiescence?.("mutation");
    if (result?.status !== "installed" || result.predecessorRowCount !== 0) {
      throw mutationError("0037 runtime-input quiescence changed at the immediate migration fence");
    }
    return;
  }
  const database = new RemoteD1(input.configPath, {
    environment: input.environment,
    run: input.run,
  });
  const fenced = await readRuntimeInputQuiescence(database, "mutation");
  if (
    fenced.triggerSql !== RUNTIME_INPUT_QUIESCENCE_TRIGGER_SQL ||
    fenced.predecessorRowCount !== 0
  ) {
    throw mutationError(
      "0037 runtime-input quiescence changed at the immediate migration fence",
      JSON.stringify(fenced),
    );
  }
}

async function readRuntimeInputQuiescence(
  database: RemoteD1,
  phase: DeployPhase,
): Promise<{ readonly triggerSql: string; readonly predecessorRowCount: number }> {
  const rows = await database.query(
    phase,
    "0037 runtime-input quiescence readback",
    `SELECT
       COALESCE((
         SELECT sql FROM sqlite_schema
         WHERE type = 'trigger' AND name = '${RUNTIME_INPUT_QUIESCENCE_TRIGGER}'
       ), '') AS trigger_sql,
       (SELECT COUNT(*) FROM worker_runtime_input_preparations) AS predecessor_count`,
  );
  if (
    rows.length !== 1 ||
    typeof rows[0]?.trigger_sql !== "string" ||
    !Number.isSafeInteger(rows[0]?.predecessor_count) ||
    Number(rows[0]?.predecessor_count) < 0
  ) {
    throw mutationError("0037 runtime-input quiescence readback returned a malformed result");
  }
  return {
    triggerSql: rows[0].trigger_sql,
    predecessorRowCount: Number(rows[0].predecessor_count),
  };
}

async function inspectLiveNativeClaimPreflight(input: {
  readonly phase: DeployPhase;
  readonly pending: readonly string[];
  readonly injected: SchemaReader | undefined;
  readonly database: RemoteD1 | null;
}): Promise<LiveNativeClaimPreflight> {
  if (!input.pending.includes(LIVE_NATIVE_CLAIM_MIGRATION)) {
    return { status: "not_pending", duplicateLiveNativeClaimCount: 0 };
  }
  const count = input.injected
    ? await input.injected.duplicateLiveNativeClaimCount?.(input.phase)
    : await readSingleCount(
        input.database as RemoteD1,
        input.phase,
        "0039 duplicate live native claim preflight",
        `SELECT COUNT(*) AS duplicate_count
         FROM (
           SELECT provider_installation_ref, native_id
           FROM tf_resource_deployments
           WHERE state IN ('provisioning', 'candidate', 'active', 'draining')
           GROUP BY provider_installation_ref, native_id
           HAVING COUNT(*) > 1
         )`,
        "duplicate_count",
      );
  const duplicateLiveNativeClaimCount = exactNonnegativeCount(
    count,
    "0039 duplicate live native claim preflight",
  );
  return {
    status: duplicateLiveNativeClaimCount === 0 ? "ready" : "legacy_data_repair_required",
    duplicateLiveNativeClaimCount,
  };
}

async function inspectArtifactBlobIoFencePreflight(input: {
  readonly phase: DeployPhase;
  readonly pending: readonly string[];
  readonly injected: SchemaReader | undefined;
  readonly database: RemoteD1 | null;
}): Promise<ArtifactBlobIoFencePreflight> {
  if (!input.pending.includes(ARTIFACT_BLOB_IO_FENCE_MIGRATION)) {
    return { status: "not_pending", activeRootDeletingCandidateConflictCount: 0 };
  }
  const count = await readArtifactBlobIoConflictCount(input);
  return {
    status: count === 0 ? "ready" : "legacy_data_repair_required",
    activeRootDeletingCandidateConflictCount: count,
  };
}

async function enforceArtifactBlobIoConflictMutationFence(input: {
  readonly pending: readonly string[];
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: SchemaProcess;
  readonly injected: SchemaReader | undefined;
}): Promise<void> {
  if (!input.pending.includes(ARTIFACT_BLOB_IO_FENCE_MIGRATION)) return;
  const database = input.injected
    ? null
    : new RemoteD1(input.configPath, { environment: input.environment, run: input.run });
  const count = await readArtifactBlobIoConflictCount({
    phase: "mutation",
    injected: input.injected,
    database,
  });
  if (count !== 0) {
    throw mutationError(
      "0043 artifact blob I/O conflict appeared at the immediate migration mutation fence",
      JSON.stringify({ activeRootDeletingCandidateConflictCount: count }),
    );
  }
}

async function readArtifactBlobIoConflictCount(input: {
  readonly phase: DeployPhase;
  readonly injected: SchemaReader | undefined;
  readonly database: RemoteD1 | null;
}): Promise<number> {
  const count = input.injected
    ? await input.injected.activeRootDeletingArtifactCandidateConflictCount?.(input.phase)
    : await readSingleCount(
        input.database as RemoteD1,
        input.phase,
        "0043 active-root/deleting-candidate conflict preflight",
        `SELECT COUNT(*) AS conflict_count
         FROM tf_artifact_gc_candidates AS candidate
         WHERE candidate.state = 'deleting' AND EXISTS (
           SELECT 1
           FROM tf_artifact_roots AS root
           WHERE root.state = 'active' AND (
             (root.target_kind = candidate.kind AND root.digest = candidate.digest) OR
             (candidate.kind = 'blob' AND root.target_kind = 'manifest' AND EXISTS (
               SELECT 1
               FROM tf_artifact_manifest_members AS member
               WHERE member.manifest_digest = root.digest
                 AND member.blob_digest = candidate.digest
             ))
           )
         )`,
        "conflict_count",
      );
  return exactNonnegativeCount(count, "0043 active-root/deleting-candidate conflict preflight");
}

async function readResourceDeletionAttestationBackfillCounts(
  database: RemoteD1,
  phase: DeployPhase,
): Promise<{
  readonly malformedFormRefCount: number;
  readonly duplicateLiveResourceUidCount: number;
}> {
  const malformedFormRefCount = await readSingleCount(
    database,
    phase,
    "0029 malformed FormRef preflight",
    MALFORMED_FORM_REF_COUNT_SQL,
    "malformed_count",
  );
  const duplicateLiveResourceUidCount = await readSingleCount(
    database,
    phase,
    "0029 duplicate live Resource UID preflight",
    `SELECT COUNT(*) AS duplicate_count
     FROM (
       SELECT tenant_id, uid
       FROM tf_resources
       GROUP BY tenant_id, uid
       HAVING COUNT(*) > 1
     )`,
    "duplicate_count",
  );
  return { malformedFormRefCount, duplicateLiveResourceUidCount };
}

async function readSingleCount(
  database: RemoteD1,
  phase: DeployPhase,
  label: string,
  sql: string,
  field: string,
): Promise<number> {
  const rows = await database.query(phase, label, sql);
  if (rows.length !== 1) throw preflightError(`${label} returned a malformed count`);
  return exactNonnegativeCount(rows[0]?.[field], label);
}

function exactNonnegativeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw preflightError(`${label} is unavailable`);
  }
  return Number(value);
}

// This mirrors the complete fail-closed FormRef grammar used by migration
// 0029. Keeping the read-only count named separately lets an operator repair
// malformed rows without learning about them only from a generic SQL abort.
const MALFORMED_FORM_REF_COUNT_SQL = `WITH RECURSIVE refs AS (
  SELECT
    rowid AS row_id,
    json_valid(resource_json) AS resource_json_valid,
    CASE WHEN json_valid(resource_json)
      THEN json_extract(resource_json, '$.form.formRef') END AS form_ref_json,
    CASE WHEN json_valid(resource_json)
      THEN json_extract(resource_json, '$.form.formRef.apiVersion') END AS api_version,
    CASE WHEN json_valid(resource_json)
      THEN json_extract(resource_json, '$.form.formRef.kind') END AS kind,
    CASE WHEN json_valid(resource_json)
      THEN json_extract(resource_json, '$.form.formRef.definitionVersion') END AS definition_version,
    CASE WHEN json_valid(resource_json)
      THEN json_extract(resource_json, '$.form.formRef.schemaDigest') END AS schema_digest,
    CASE WHEN json_valid(resource_json)
      THEN json_type(resource_json, '$.form.formRef') END AS form_ref_type,
    CASE WHEN json_valid(resource_json)
      THEN json_type(resource_json, '$.form.formRef.apiVersion') END AS api_version_type,
    CASE WHEN json_valid(resource_json)
      THEN json_type(resource_json, '$.form.formRef.kind') END AS kind_type,
    CASE WHEN json_valid(resource_json)
      THEN json_type(resource_json, '$.form.formRef.definitionVersion') END AS definition_version_type,
    CASE WHEN json_valid(resource_json)
      THEN json_type(resource_json, '$.form.formRef.schemaDigest') END AS schema_digest_type
  FROM tf_resources
), parts AS (
  SELECT refs.*,
    CASE WHEN instr(api_version, '/') > 0
      THEN substr(api_version, 1, instr(api_version, '/') - 1) ELSE api_version END AS group_name,
    CASE WHEN instr(api_version, '/') > 0
      THEN substr(api_version, instr(api_version, '/') + 1) ELSE '' END AS version
  FROM refs
), semver AS (
  SELECT parts.*,
    CASE WHEN instr(definition_version, '-') > 0
      THEN substr(definition_version, 1, instr(definition_version, '-') - 1)
      ELSE definition_version END AS core_version,
    CASE WHEN instr(definition_version, '-') > 0
      THEN substr(definition_version, instr(definition_version, '-') + 1) ELSE '' END AS pre_release
  FROM parts
), semver_parts AS (
  SELECT semver.*,
    substr(core_version, 1, instr(core_version, '.') - 1) AS major,
    substr(core_version, instr(core_version, '.') + 1) AS minor_patch
  FROM semver
), version_parts AS (
  SELECT semver_parts.*,
    substr(minor_patch, 1, instr(minor_patch, '.') - 1) AS minor,
    substr(minor_patch, instr(minor_patch, '.') + 1) AS patch
  FROM semver_parts
), api_segments(row_id, segment, remainder) AS (
  SELECT row_id,
    CASE WHEN instr(group_name, '.') = 0 THEN group_name
      ELSE substr(group_name, 1, instr(group_name, '.') - 1) END,
    CASE WHEN instr(group_name, '.') = 0 THEN ''
      ELSE substr(group_name, instr(group_name, '.') + 1) END
  FROM version_parts
  UNION ALL
  SELECT row_id,
    CASE WHEN instr(remainder, '.') = 0 THEN remainder
      ELSE substr(remainder, 1, instr(remainder, '.') - 1) END,
    CASE WHEN instr(remainder, '.') = 0 THEN ''
      ELSE substr(remainder, instr(remainder, '.') + 1) END
  FROM api_segments WHERE remainder <> ''
)
SELECT COUNT(*) AS malformed_count
FROM version_parts
WHERE
  resource_json_valid <> 1
  OR form_ref_type <> 'object'
  OR api_version_type <> 'text'
  OR kind_type <> 'text'
  OR definition_version_type <> 'text'
  OR schema_digest_type <> 'text'
  OR api_version IS NULL OR kind IS NULL OR definition_version IS NULL OR schema_digest IS NULL
  OR length(api_version) < 1 OR length(api_version) > 320
  OR api_version GLOB '*[^a-z0-9./-]*'
  OR api_version LIKE '%/%/%'
  OR length(group_name) < 3 OR group_name NOT LIKE '%.%'
  OR group_name GLOB '*[^a-z0-9.-]*'
  OR group_name GLOB '[-.]*' OR group_name GLOB '*[-.]'
  OR group_name LIKE '%..%' OR group_name LIKE '%.-%' OR group_name LIKE '%-.'
  OR group_name IN ('forms.takoform.com', 'packages.forms.takoform.com', 'trust.forms.takoform.com')
  OR EXISTS (
    SELECT 1 FROM api_segments
    WHERE api_segments.row_id = version_parts.row_id
      AND (
        length(api_segments.segment) < 1 OR length(api_segments.segment) > 63
        OR api_segments.segment GLOB '*[^a-z0-9-]*'
        OR substr(api_segments.segment, 1, 1) GLOB '[^a-z0-9]'
        OR substr(api_segments.segment, -1, 1) GLOB '[^a-z0-9]'
      )
  )
  OR (
    version <> '' AND (
      length(version) < 2 OR substr(version, 1, 1) <> 'v'
      OR NOT (
        (substr(version, 2) NOT GLOB '*[^0-9]*')
        OR (
          instr(version, 'alpha') > 2
          AND instr(version, 'alpha') = length(version) - length(substr(version, instr(version, 'alpha') + 5)) - 4
          AND substr(version, 2, instr(version, 'alpha') - 2) NOT GLOB '*[^0-9]*'
          AND length(substr(version, 2, instr(version, 'alpha') - 2)) > 0
          AND substr(version, instr(version, 'alpha') + 5) NOT GLOB '*[^0-9]*'
          AND length(substr(version, instr(version, 'alpha') + 5)) > 0
        )
        OR (
          instr(version, 'beta') > 2
          AND instr(version, 'beta') = length(version) - length(substr(version, instr(version, 'beta') + 4)) - 3
          AND substr(version, 2, instr(version, 'beta') - 2) NOT GLOB '*[^0-9]*'
          AND length(substr(version, 2, instr(version, 'beta') - 2)) > 0
          AND substr(version, instr(version, 'beta') + 4) NOT GLOB '*[^0-9]*'
          AND length(substr(version, instr(version, 'beta') + 4)) > 0
        )
      )
    )
  )
  OR length(kind) < 1 OR length(kind) > 64
  OR substr(kind, 1, 1) NOT GLOB '[A-Z]'
  OR kind GLOB '*[^A-Za-z0-9]*'
  OR length(core_version) < 5
  OR length(core_version) - length(replace(core_version, '.', '')) <> 2
  OR core_version GLOB '*[^0-9.]*'
  OR length(major) < 1 OR major GLOB '*[^0-9]*'
  OR length(minor) < 1 OR minor GLOB '*[^0-9]*'
  OR length(patch) < 1 OR patch GLOB '*[^0-9]*'
  OR (length(major) > 1 AND substr(major, 1, 1) = '0')
  OR (length(minor) > 1 AND substr(minor, 1, 1) = '0')
  OR (length(patch) > 1 AND substr(patch, 1, 1) = '0')
  OR (pre_release <> '' AND (pre_release GLOB '*[^0-9A-Za-z.-]*' OR length(pre_release) = 0))
  OR length(schema_digest) <> 71
  OR substr(schema_digest, 1, 7) <> 'sha256:'
  OR substr(schema_digest, 8) GLOB '*[^0-9a-f]*'
  OR (
    (SELECT COUNT(*) FROM json_each(form_ref_json)) <> 4
    OR EXISTS (
      SELECT 1 FROM json_each(form_ref_json) AS field
      WHERE field.key NOT IN ('apiVersion', 'kind', 'definitionVersion', 'schemaDigest')
    )
  )`;

async function inspectProviderRepairPreflight(input: {
  readonly phase: DeployPhase;
  readonly pending: readonly string[];
  readonly applied: readonly string[];
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: SchemaProcess;
  readonly injected: SchemaReader | undefined;
}): Promise<ProviderRepairPreflight> {
  if (!input.pending.includes(PROVIDER_REPAIR_MIGRATION)) {
    return { status: "not_pending", unmatchedDispatchedSagaCount: 0 };
  }
  // Before 0024 no row can carry execution_started_at, so no dispatched
  // historical saga exists for 0036 to reconstruct.
  if (!input.applied.includes(PROVIDER_EXECUTION_LEASE_MIGRATION)) {
    return { status: "ready", unmatchedDispatchedSagaCount: 0 };
  }
  const count = input.injected
    ? await input.injected.unmatchedProviderRepairSagaCount?.(input.phase)
    : await readUnmatchedProviderRepairSagaCount(
        new RemoteD1(input.configPath, { environment: input.environment, run: input.run }),
        input.phase,
      );
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw preflightError("D1 provider repair preflight is unavailable");
  }
  return {
    status: count === 0 ? "ready" : "operator_reconciliation_required",
    unmatchedDispatchedSagaCount: Number(count),
  };
}

async function readUnmatchedProviderRepairSagaCount(
  database: RemoteD1,
  phase: DeployPhase,
): Promise<number> {
  const rows = await database.query(
    phase,
    "0036 unmatched provider repair preflight",
    `SELECT COUNT(*) AS unmatched_count
     FROM tf_provider_mutation_sagas AS saga
     WHERE saga.phase = 'planned'
       AND saga.receipt_json IS NULL
       AND saga.execution_started_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM tf_deferred_operations AS operation
         WHERE operation.id = saga.operation_id
           AND operation.tenant_id = saga.tenant_id
           AND operation.resource_uid = saga.resource_uid
           AND operation.replay_key = saga.replay_key
           AND operation.fingerprint = saga.fingerprint
           AND operation.target_space = saga.target_space
           AND operation.target_api_version = saga.target_api_version
           AND operation.target_kind = saga.target_kind
           AND operation.target_name = saga.target_name
           AND operation.accepted_uid IS saga.accepted_uid
           AND operation.accepted_generation IS saga.accepted_generation
           AND operation.accepted_revision IS saga.accepted_revision
           AND operation.phase = 'committing'
           AND operation.terminal_json IS NULL
       )`,
  );
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.unmatched_count)) {
    throw preflightError("D1 provider repair preflight returned a malformed count");
  }
  return Number(rows[0]?.unmatched_count);
}

async function readState(
  phase: DeployPhase,
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: SchemaProcess,
  injected: SchemaReader | undefined,
): Promise<D1SchemaState> {
  if (injected) return await injected.read(phase);
  return withoutRuntimeInputQuiescenceTrigger(
    await readD1SchemaState(new RemoteD1(configPath, { environment, run }), phase),
  );
}

function withoutRuntimeInputQuiescenceTrigger(state: D1SchemaState): D1SchemaState {
  if (
    !state.applied.includes(RUNTIME_INPUT_PREPARATION_MIGRATION) ||
    state.applied.includes(RUNTIME_INPUT_PREPARATION_V2_MIGRATION)
  ) {
    return state;
  }
  let rows: unknown;
  try {
    rows = JSON.parse(state.shape);
  } catch {
    throw preflightError("D1 canonical schema shape could not be normalized for quiescence");
  }
  if (!Array.isArray(rows)) {
    throw preflightError("D1 canonical schema shape could not be normalized for quiescence");
  }
  const filtered = rows.filter(
    (row) =>
      !(
        isRecord(row) &&
        row.type === "trigger" &&
        row.name === RUNTIME_INPUT_QUIESCENCE_TRIGGER &&
        row.table === "worker_runtime_input_preparations" &&
        row.sql === RUNTIME_INPUT_QUIESCENCE_TRIGGER_SQL
      ),
  );
  if (filtered.length === rows.length) return state;
  const shape = `${JSON.stringify(filtered)}\n`;
  return { applied: state.applied, shape, shapeDigest: digestBytes(Buffer.from(shape, "utf8")) };
}

function writeD1Config(path: string, target: DeployTarget, migrationDirectory: string): string {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        name: target.workerName,
        account_id: target.accountId,
        compatibility_date: "2026-08-17",
        d1_databases: [
          {
            binding: "STATE_DB",
            database_name: target.d1.databaseName,
            database_id: target.d1.databaseId,
            migrations_dir: migrationDirectory,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return path;
}

function assertSamePreState(left: D1SchemaState, right: D1SchemaState): void {
  if (
    JSON.stringify(left.applied) !== JSON.stringify(right.applied) ||
    left.shapeDigest !== right.shapeDigest ||
    left.shape !== right.shape
  ) {
    throw preflightError("D1 lineage or schema shape changed during qualification");
  }
}

function assertReceiptMatches(
  receipt: RehearsalReceipt,
  input: {
    readonly commit: string;
    readonly wave: SelectedSchemaWave;
    readonly pre: D1SchemaState;
    readonly artifact: MigrationArtifact;
    readonly preDataIntegrity: LegacyProductionCatchupDataIntegrity;
  },
): void {
  assertReceiptChain(receipt, {
    boundary: input.wave.selector,
    commit: input.commit,
    artifact: input.artifact,
  });
  const files = input.wave.migrationFiles.map(({ name, digest, bytes }) => ({
    name,
    digest,
    bytes,
  }));
  const atWaveStart =
    JSON.stringify(input.pre.applied) === JSON.stringify(input.wave.fromPrefixNames);
  const catchup = input.wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY;
  if (
    receipt.commit !== input.commit ||
    receipt.fromMigration !== input.wave.fromMigration ||
    receipt.throughMigration !== input.wave.throughMigration ||
    receipt.migrationDigest !== input.wave.migrationDigest ||
    receipt.throughPrefixDigest !== input.wave.throughPrefixDigest ||
    JSON.stringify(receipt.migrationFiles) !== JSON.stringify(files) ||
    JSON.stringify(receipt.preAppliedMigrations) !== JSON.stringify(input.wave.fromPrefixNames) ||
    JSON.stringify(receipt.postAppliedMigrations) !==
      JSON.stringify(input.wave.throughPrefixNames) ||
    (atWaveStart && receipt.preShapeDigest !== input.pre.shapeDigest) ||
    (catchup &&
      ((atWaveStart &&
        receipt.preApplicationShapeDigest !== applicationSchemaShapeDigest(input.pre)) ||
        receipt.preApplicationShapeDigest !== CANONICAL_0016_APPLICATION_SCHEMA_SHAPE_DIGEST ||
        receipt.preDataIntegrityDigest !== input.preDataIntegrity.dataIntegrityDigest ||
        !sha256Digest(receipt.postDataIntegrityDigest))) ||
    (!catchup &&
      (receipt.preApplicationShapeDigest !== null ||
        receipt.preDataIntegrityDigest !== null ||
        receipt.postDataIntegrityDigest !== null))
  ) {
    throw preflightError("production state does not exactly match the D1 rehearsal receipt");
  }
}

function readPredecessorReceiptEvidence(
  pathValue: string | undefined,
  input: {
    readonly commit: string;
    readonly wave: SelectedSchemaWave;
    readonly artifact: MigrationArtifact;
  },
): ReceiptEvidence | null {
  if (input.wave.selector === null) {
    throw preflightError("integration-only migration evidence has no predecessor receipt chain");
  }
  const waveIndex = RECEIPT_CHAIN_BOUNDARIES.indexOf(
    input.wave.selector as (typeof RECEIPT_CHAIN_BOUNDARIES)[number],
  );
  if (input.wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY || waveIndex === 0) {
    if (pathValue !== undefined) {
      throw preflightError("the first D1 wave refuses a predecessor rehearsal receipt");
    }
    return null;
  }
  let configuredPath: string;
  if (pathValue !== undefined) {
    if (pathValue.trim() !== pathValue) {
      throw preflightError("the predecessor rehearsal receipt path must not have outer whitespace");
    }
    configuredPath = pathValue;
  } else if (process.env.TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH === undefined) {
    throw preflightError("a later D1 wave requires its exact predecessor rehearsal receipt");
  } else {
    configuredPath = requireEnvironment("TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH");
  }
  const path = exactReceiptPath(configuredPath);
  const evidence = readReceiptEvidence(path);
  assertReceiptChain(evidence.receipt, {
    boundary: RECEIPT_CHAIN_BOUNDARIES[waveIndex - 1] as SchemaWaveBoundary,
    commit: input.commit,
    artifact: input.artifact,
  });
  return evidence;
}

function assertPredecessorReceiptMatches(
  evidence: ReceiptEvidence,
  input: {
    readonly commit: string;
    readonly wave: SelectedSchemaWave;
    readonly artifact: MigrationArtifact;
    readonly preShapeDigest: string;
  },
): void {
  if (input.wave.selector === null) {
    throw preflightError("integration-only migration evidence has no predecessor receipt chain");
  }
  const waveIndex = RECEIPT_CHAIN_BOUNDARIES.indexOf(
    input.wave.selector as (typeof RECEIPT_CHAIN_BOUNDARIES)[number],
  );
  const predecessorBoundary = RECEIPT_CHAIN_BOUNDARIES[waveIndex - 1];
  if (predecessorBoundary === undefined) {
    throw preflightError("the first D1 wave has no predecessor rehearsal receipt");
  }
  assertReceiptChain(evidence.receipt, {
    boundary: predecessorBoundary,
    commit: input.commit,
    artifact: input.artifact,
  });
  if (
    JSON.stringify(evidence.receipt.postAppliedMigrations) !==
      JSON.stringify(input.wave.fromPrefixNames) ||
    evidence.receipt.postShapeDigest !== input.preShapeDigest
  ) {
    throw preflightError(
      "D1 predecessor rehearsal receipt does not match the selected wave predecessor state",
    );
  }
}

function assertReceiptChain(
  receipt: RehearsalReceipt,
  input: {
    readonly boundary: SchemaWaveBoundary | null;
    readonly commit: string;
    readonly artifact: MigrationArtifact;
  },
): void {
  if (input.boundary === null) {
    throw preflightError("integration-only migration evidence cannot enter a rehearsal chain");
  }
  const waveIndex = RECEIPT_CHAIN_BOUNDARIES.indexOf(
    input.boundary as (typeof RECEIPT_CHAIN_BOUNDARIES)[number],
  );
  const definition = SCHEMA_WAVES[input.boundary];
  const migrationFiles = input.artifact.files
    .slice(definition.fromCount, definition.throughCount)
    .map(({ name, digest, bytes }) => ({ name, digest, bytes }));
  const throughPrefixFiles = input.artifact.files.slice(0, definition.throughCount);
  const expectedPreApplied = input.artifact.names.slice(0, definition.fromCount);
  const expectedPostApplied = input.artifact.names.slice(0, definition.throughCount);
  if (
    receipt.commit !== input.commit ||
    receipt.fromMigration !== definition.fromMigration ||
    receipt.throughMigration !== definition.throughMigration ||
    receipt.migrationDigest !==
      digestMigrationFiles(
        input.artifact.files.slice(definition.fromCount, definition.throughCount),
      ) ||
    receipt.throughPrefixDigest !== digestMigrationFiles(throughPrefixFiles) ||
    JSON.stringify(receipt.migrationFiles) !== JSON.stringify(migrationFiles) ||
    JSON.stringify(receipt.preAppliedMigrations) !== JSON.stringify(expectedPreApplied) ||
    JSON.stringify(receipt.postAppliedMigrations) !== JSON.stringify(expectedPostApplied) ||
    (input.boundary === LEGACY_PRODUCTION_CATCHUP_BOUNDARY
      ? receipt.preApplicationShapeDigest !== CANONICAL_0016_APPLICATION_SCHEMA_SHAPE_DIGEST ||
        !sha256Digest(receipt.preDataIntegrityDigest) ||
        !sha256Digest(receipt.postDataIntegrityDigest)
      : receipt.preApplicationShapeDigest !== null ||
        receipt.preDataIntegrityDigest !== null ||
        receipt.postDataIntegrityDigest !== null)
  ) {
    throw preflightError("D1 rehearsal receipt chain does not match the frozen audited wave");
  }
  if (input.boundary === LEGACY_PRODUCTION_CATCHUP_BOUNDARY || waveIndex === 0) {
    if (receipt.predecessorReceipt !== null) {
      throw preflightError("the first D1 rehearsal receipt must have no predecessor receipt");
    }
    return;
  }
  const link = receipt.predecessorReceipt;
  if (link === null) {
    throw preflightError("D1 rehearsal receipt is missing its predecessor receipt chain");
  }
  const actualDigest = digestReceipt(link.receipt);
  if (link.digest !== actualDigest) {
    throw preflightError(
      "D1 rehearsal predecessor receipt digest does not match its exact embedded bytes",
    );
  }
  const predecessorBoundary = RECEIPT_CHAIN_BOUNDARIES[waveIndex - 1] as SchemaWaveBoundary;
  assertReceiptChain(link.receipt, {
    boundary: predecessorBoundary,
    commit: input.commit,
    artifact: input.artifact,
  });
  if (
    receipt.preShapeDigest !== link.receipt.postShapeDigest ||
    JSON.stringify(receipt.preAppliedMigrations) !==
      JSON.stringify(link.receipt.postAppliedMigrations)
  ) {
    throw preflightError("D1 rehearsal receipt chain has a mismatched predecessor transition");
  }
}

function prepareRehearsalAttempt(
  receiptPath: string,
  input: {
    readonly commit: string;
    readonly wave: SelectedSchemaWave;
    readonly pre: D1SchemaState;
    readonly preDataIntegrity: LegacyProductionCatchupDataIntegrity;
    readonly predecessorReceipt: ReceiptEvidence | null;
  },
): RehearsalAttempt {
  if (input.wave.fromMigration === null || input.wave.selector === null) {
    throw preflightError("integration-only migration evidence cannot become a rehearsal attempt");
  }
  const attemptPath = `${receiptPath}.attempt`;
  const expected: RehearsalAttempt = {
    kind: REHEARSAL_ATTEMPT_KIND,
    commit: input.commit,
    fromMigration: input.wave.fromMigration,
    throughMigration: input.wave.throughMigration,
    migrationDigest: input.wave.migrationDigest,
    throughPrefixDigest: input.wave.throughPrefixDigest,
    migrationFiles: input.wave.migrationFiles.map(({ name, digest, bytes }) => ({
      name,
      digest,
      bytes,
    })),
    preAppliedMigrations: input.wave.fromPrefixNames,
    preShapeDigest: input.pre.shapeDigest,
    preApplicationShapeDigest:
      input.wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY &&
      JSON.stringify(input.pre.applied) === JSON.stringify(input.wave.fromPrefixNames)
        ? applicationSchemaShapeDigest(input.pre)
        : null,
    preDataIntegrityDigest:
      input.wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY
        ? input.preDataIntegrity.dataIntegrityDigest
        : null,
    predecessorReceiptDigest: input.predecessorReceipt?.digest ?? null,
  };
  if (!existsSync(attemptPath)) {
    if (JSON.stringify(input.pre.applied) !== JSON.stringify(input.wave.fromPrefixNames)) {
      throw preflightError(
        "a partial rehearsal wave can resume only with its original no-overwrite attempt evidence",
      );
    }
    writeRehearsalAttempt(attemptPath, expected);
    return expected;
  }
  const attempt = readRehearsalAttempt(attemptPath);
  const atWaveStart =
    JSON.stringify(input.pre.applied) === JSON.stringify(input.wave.fromPrefixNames);
  if (
    attempt.commit !== expected.commit ||
    attempt.fromMigration !== expected.fromMigration ||
    attempt.throughMigration !== expected.throughMigration ||
    attempt.migrationDigest !== expected.migrationDigest ||
    attempt.throughPrefixDigest !== expected.throughPrefixDigest ||
    JSON.stringify(attempt.migrationFiles) !== JSON.stringify(expected.migrationFiles) ||
    JSON.stringify(attempt.preAppliedMigrations) !==
      JSON.stringify(expected.preAppliedMigrations) ||
    attempt.predecessorReceiptDigest !== expected.predecessorReceiptDigest ||
    (atWaveStart && attempt.preShapeDigest !== input.pre.shapeDigest) ||
    (atWaveStart && attempt.preApplicationShapeDigest !== expected.preApplicationShapeDigest) ||
    (input.wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY &&
      attempt.preDataIntegrityDigest !== expected.preDataIntegrityDigest)
  ) {
    throw preflightError(
      "rehearsal state does not exactly match its original wave attempt evidence",
    );
  }
  return attempt;
}

function writeRehearsalAttempt(path: string, attempt: RehearsalAttempt): void {
  try {
    writeFileSync(path, `${JSON.stringify(attempt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw preflightError(
      "D1 rehearsal attempt evidence could not be created without overwrite",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

function readRehearsalAttempt(path: string): RehearsalAttempt {
  const value = readSecureJson(path, "D1 rehearsal attempt evidence");
  assertExactKeys(value, [
    "kind",
    "commit",
    "fromMigration",
    "throughMigration",
    "migrationDigest",
    "throughPrefixDigest",
    "migrationFiles",
    "preAppliedMigrations",
    "preShapeDigest",
    "preApplicationShapeDigest",
    "preDataIntegrityDigest",
    "predecessorReceiptDigest",
  ]);
  if (
    value.kind !== REHEARSAL_ATTEMPT_KIND ||
    typeof value.commit !== "string" ||
    typeof value.fromMigration !== "string" ||
    typeof value.throughMigration !== "string" ||
    typeof value.migrationDigest !== "string" ||
    typeof value.throughPrefixDigest !== "string" ||
    !Array.isArray(value.migrationFiles) ||
    !stringArray(value.preAppliedMigrations) ||
    typeof value.preShapeDigest !== "string" ||
    (value.preApplicationShapeDigest !== null &&
      typeof value.preApplicationShapeDigest !== "string") ||
    (value.preDataIntegrityDigest !== null && typeof value.preDataIntegrityDigest !== "string") ||
    (value.predecessorReceiptDigest !== null && typeof value.predecessorReceiptDigest !== "string")
  ) {
    throw preflightError("D1 rehearsal attempt evidence has an invalid shape");
  }
  return {
    kind: REHEARSAL_ATTEMPT_KIND,
    commit: value.commit,
    fromMigration: value.fromMigration,
    throughMigration: value.throughMigration,
    migrationDigest: value.migrationDigest,
    throughPrefixDigest: value.throughPrefixDigest,
    migrationFiles: parseMigrationRows(value.migrationFiles, "D1 rehearsal attempt evidence"),
    preAppliedMigrations: value.preAppliedMigrations,
    preShapeDigest: value.preShapeDigest,
    preApplicationShapeDigest: value.preApplicationShapeDigest as string | null,
    preDataIntegrityDigest: value.preDataIntegrityDigest as string | null,
    predecessorReceiptDigest: value.predecessorReceiptDigest as string | null,
  };
}

function prepareProductionAttempt(
  receiptPath: string,
  input: {
    readonly commit: string;
    readonly wave: SelectedSchemaWave;
    readonly pre: D1SchemaState;
    readonly preDataIntegrity: LegacyProductionCatchupDataIntegrity;
    readonly receiptDigest: string;
  },
): ProductionAttempt {
  if (input.wave.fromMigration === null || input.wave.selector === null) {
    throw preflightError("integration-only migration evidence cannot become a production attempt");
  }
  const path = `${receiptPath}.production-attempt`;
  const expected: ProductionAttempt = {
    kind: PRODUCTION_ATTEMPT_KIND,
    commit: input.commit,
    fromMigration: input.wave.fromMigration,
    throughMigration: input.wave.throughMigration,
    receiptDigest: input.receiptDigest,
    preAppliedMigrations: input.wave.fromPrefixNames,
    preShapeDigest: input.pre.shapeDigest,
    preApplicationShapeDigest:
      input.wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY &&
      JSON.stringify(input.pre.applied) === JSON.stringify(input.wave.fromPrefixNames)
        ? applicationSchemaShapeDigest(input.pre)
        : null,
    preDataIntegrityDigest:
      input.wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY
        ? input.preDataIntegrity.dataIntegrityDigest
        : null,
  };
  if (!existsSync(path)) {
    if (JSON.stringify(input.pre.applied) !== JSON.stringify(input.wave.fromPrefixNames)) {
      throw preflightError(
        "a partial production wave can resume only with its original no-overwrite attempt evidence",
      );
    }
    writeProductionAttempt(path, expected);
    return expected;
  }
  const attempt = readProductionAttempt(path);
  const atWaveStart =
    JSON.stringify(input.pre.applied) === JSON.stringify(input.wave.fromPrefixNames);
  if (
    attempt.commit !== expected.commit ||
    attempt.fromMigration !== expected.fromMigration ||
    attempt.throughMigration !== expected.throughMigration ||
    attempt.receiptDigest !== expected.receiptDigest ||
    JSON.stringify(attempt.preAppliedMigrations) !==
      JSON.stringify(expected.preAppliedMigrations) ||
    (atWaveStart && attempt.preShapeDigest !== input.pre.shapeDigest) ||
    (atWaveStart && attempt.preApplicationShapeDigest !== expected.preApplicationShapeDigest) ||
    (input.wave.selector === LEGACY_PRODUCTION_CATCHUP_BOUNDARY &&
      attempt.preDataIntegrityDigest !== expected.preDataIntegrityDigest)
  ) {
    throw preflightError(
      "production state does not exactly match its original wave attempt evidence",
    );
  }
  return attempt;
}

function writeProductionAttempt(path: string, attempt: ProductionAttempt): void {
  try {
    writeFileSync(path, `${JSON.stringify(attempt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw preflightError(
      "D1 production attempt evidence could not be created without overwrite",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

function readProductionAttempt(path: string): ProductionAttempt {
  const value = readSecureJson(path, "D1 production wave attempt evidence");
  assertExactKeys(value, [
    "kind",
    "commit",
    "fromMigration",
    "throughMigration",
    "receiptDigest",
    "preAppliedMigrations",
    "preShapeDigest",
    "preApplicationShapeDigest",
    "preDataIntegrityDigest",
  ]);
  if (
    value.kind !== PRODUCTION_ATTEMPT_KIND ||
    typeof value.commit !== "string" ||
    typeof value.fromMigration !== "string" ||
    typeof value.throughMigration !== "string" ||
    typeof value.receiptDigest !== "string" ||
    !stringArray(value.preAppliedMigrations) ||
    typeof value.preShapeDigest !== "string" ||
    (value.preApplicationShapeDigest !== null &&
      typeof value.preApplicationShapeDigest !== "string") ||
    (value.preDataIntegrityDigest !== null && typeof value.preDataIntegrityDigest !== "string")
  ) {
    throw preflightError("D1 production wave attempt evidence has an invalid shape");
  }
  return {
    kind: PRODUCTION_ATTEMPT_KIND,
    commit: value.commit,
    fromMigration: value.fromMigration,
    throughMigration: value.throughMigration,
    receiptDigest: value.receiptDigest,
    preAppliedMigrations: value.preAppliedMigrations,
    preShapeDigest: value.preShapeDigest,
    preApplicationShapeDigest: value.preApplicationShapeDigest as string | null,
    preDataIntegrityDigest: value.preDataIntegrityDigest as string | null,
  };
}

function removeAttemptFile(path: string, label: string): void {
  try {
    secureFileStatus(path, label);
    rmSync(path);
  } catch (error) {
    throw verificationError(
      `${label} was completed but its marker could not be removed`,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

function writeReceipt(path: string, receipt: RehearsalReceipt): void {
  try {
    writeFileSync(path, receiptBytes(receipt), { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw verificationError(
      "D1 changed but the no-overwrite rehearsal receipt could not be written",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

interface ReceiptEvidence {
  readonly receipt: RehearsalReceipt;
  readonly digest: string;
}

function readReceiptEvidence(path: string): ReceiptEvidence {
  const { value, bytes } = readSecureJsonBytes(path, "D1 rehearsal receipt");
  const receipt = parseReceipt(value, "D1 rehearsal receipt", 0);
  if (!Buffer.from(bytes).equals(receiptBytes(receipt))) {
    throw preflightError("D1 rehearsal receipt is not in its canonical exact-byte encoding");
  }
  return { receipt, digest: digestBytes(bytes) };
}

function parseReceipt(
  value: Record<string, unknown>,
  label: string,
  depth: number,
): RehearsalReceipt {
  if (depth >= SCHEMA_WAVE_BOUNDARIES.length) {
    throw preflightError(`${label} exceeds the fixed receipt-chain depth`);
  }
  assertExactKeys(value, [
    "kind",
    "commit",
    "fromMigration",
    "throughMigration",
    "migrationDigest",
    "throughPrefixDigest",
    "migrationFiles",
    "preAppliedMigrations",
    "preShapeDigest",
    "preApplicationShapeDigest",
    "preDataIntegrityDigest",
    "postAppliedMigrations",
    "postShapeDigest",
    "postDataIntegrityDigest",
    "predecessorReceipt",
  ]);
  if (
    value.kind !== RECEIPT_KIND ||
    typeof value.commit !== "string" ||
    typeof value.fromMigration !== "string" ||
    typeof value.throughMigration !== "string" ||
    typeof value.migrationDigest !== "string" ||
    typeof value.throughPrefixDigest !== "string" ||
    !Array.isArray(value.migrationFiles) ||
    !stringArray(value.preAppliedMigrations) ||
    typeof value.preShapeDigest !== "string" ||
    (value.preApplicationShapeDigest !== null &&
      typeof value.preApplicationShapeDigest !== "string") ||
    (value.preDataIntegrityDigest !== null && typeof value.preDataIntegrityDigest !== "string") ||
    !stringArray(value.postAppliedMigrations) ||
    typeof value.postShapeDigest !== "string" ||
    (value.postDataIntegrityDigest !== null && typeof value.postDataIntegrityDigest !== "string") ||
    (value.predecessorReceipt !== null && !isRecord(value.predecessorReceipt))
  ) {
    throw preflightError(`${label} has an invalid shape`);
  }
  let predecessorReceipt: RehearsalReceiptLink | null = null;
  if (value.predecessorReceipt !== null) {
    const link = value.predecessorReceipt as Record<string, unknown>;
    assertExactKeys(link, ["digest", "receipt"]);
    if (typeof link.digest !== "string" || !isRecord(link.receipt)) {
      throw preflightError(`${label} has an invalid predecessor receipt link`);
    }
    predecessorReceipt = {
      digest: link.digest,
      receipt: parseReceipt(link.receipt, `${label} predecessor`, depth + 1),
    };
  }
  return {
    kind: RECEIPT_KIND,
    commit: value.commit,
    fromMigration: value.fromMigration,
    throughMigration: value.throughMigration,
    migrationDigest: value.migrationDigest,
    throughPrefixDigest: value.throughPrefixDigest,
    migrationFiles: parseMigrationRows(value.migrationFiles, label),
    preAppliedMigrations: value.preAppliedMigrations,
    preShapeDigest: value.preShapeDigest,
    preApplicationShapeDigest: value.preApplicationShapeDigest as string | null,
    preDataIntegrityDigest: value.preDataIntegrityDigest as string | null,
    postAppliedMigrations: value.postAppliedMigrations,
    postShapeDigest: value.postShapeDigest,
    postDataIntegrityDigest: value.postDataIntegrityDigest as string | null,
    predecessorReceipt,
  };
}

function receiptBytes(receipt: RehearsalReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function digestReceipt(receipt: RehearsalReceipt): string {
  return digestBytes(receiptBytes(receipt));
}

function readSecureJson(path: string, label: string): Record<string, unknown> {
  return readSecureJsonBytes(path, label).value;
}

function readSecureJsonBytes(
  path: string,
  label: string,
): { readonly value: Record<string, unknown>; readonly bytes: Uint8Array } {
  const status = secureFileStatus(path, label);
  if ((status.mode & 0o777) !== 0o600) {
    throw preflightError(`${label} must be an owned 0600 regular file`);
  }
  const bytes = readFileSync(path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw preflightError(`${label} is not valid JSON`);
  }
  if (!isRecord(value)) throw preflightError(`${label} must be an object`);
  return { value, bytes };
}

function parseMigrationRows(
  value: readonly unknown[],
  label: string,
): RehearsalReceipt["migrationFiles"] {
  return value.map((entry) => {
    if (!isRecord(entry)) throw preflightError(`${label} has an invalid migration row`);
    assertExactKeys(entry, ["name", "digest", "bytes"]);
    if (
      typeof entry.name !== "string" ||
      typeof entry.digest !== "string" ||
      !Number.isSafeInteger(entry.bytes) ||
      Number(entry.bytes) <= 0
    ) {
      throw preflightError(`${label} has an invalid migration row`);
    }
    return { name: entry.name, digest: entry.digest, bytes: entry.bytes as number };
  });
}

export function exactReceiptPath(value: string): string {
  if (!isAbsolute(value)) throw preflightError("D1 rehearsal receipt path must be absolute");
  const requested = resolve(value);
  const requestedParent = dirname(requested);
  let parent: string;
  try {
    parent = realpathSync(requestedParent);
  } catch {
    throw preflightError("D1 rehearsal receipt parent is unavailable");
  }
  const path = join(parent, basename(requested));
  const inside = relative(REPOSITORY, path);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw preflightError("D1 rehearsal receipt must stay outside the repository");
  }
  const status = statSync(parent, { throwIfNoEntry: false });
  if (
    !status?.isDirectory() ||
    (status.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw preflightError("D1 rehearsal receipt parent must be an owned 0700 directory");
  }
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      throw preflightError("D1 rehearsal receipt must stay outside every Git repository");
    }
    const next = dirname(cursor);
    if (next === cursor) break;
  }
  return path;
}

function secureFileStatus(path: string, label: string): Stats {
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch {
    throw preflightError(`${label} is unavailable`);
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw preflightError(`${label} must be an owned link-free regular file`);
  }
  return status;
}

async function checked(
  run: SchemaProcess,
  phase: DeployPhase,
  description: string,
  command: readonly string[],
): Promise<string> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw new DeployError(
      phase,
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw preflightError("D1 rehearsal receipt contains unexpected or missing keys");
  }
}

function last(values: readonly string[]): string | null {
  return values.length === 0 ? null : (values[values.length - 1] as string);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
