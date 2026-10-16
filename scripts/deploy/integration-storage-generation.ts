import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  applicationSchemaMatches,
  canonicalApplicationShape,
  deriveExpectedApplicationShape,
} from "./application-schema-shape.ts";
import { RemoteD1 } from "./d1.ts";
import { buildD1MigrationImport } from "./d1-migration-import.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  assertFreshV2DataReadback,
  type FreshV2D1Lineage,
  type FreshV2DataReader,
} from "./fresh-v2-data-readback.ts";
import { type D1SchemaState, MONEY_UNIT_MIGRATION, readD1SchemaState } from "./migrations.ts";
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
import {
  projectApplyQualifiedMigrationArtifact,
  projectCanonicalIntegrationV2MigrationArtifact0092,
  projectFreshIntegrationV2MigrationArtifact0091,
  projectFreshIntegrationV2MigrationArtifact0092,
  projectFreshProductionV2MigrationArtifact,
  projectFreshProductionV2MigrationArtifact0089,
  projectFreshV2ArtifactMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
  readSealedApplyQualifiedMigrationArtifact,
  readSealedFreshIntegrationV2MigrationArtifact0091,
  readSealedFreshIntegrationV2MigrationArtifact0092,
  readSealedFreshProductionV2MigrationArtifact,
  readSealedFreshProductionV2MigrationArtifact0089,
  readSealedFreshV2ArtifactMigrationArtifact,
  type SchemaReader,
} from "./schema.ts";
import {
  type MoneySchemaPhase,
  moneyUnitCutoverExpectedShape,
  moneyUnitCutoverSchemaMatches,
  moneyUnitCutoverSourcePrefixDigest,
} from "./schema-money-unit-cutover.ts";
import type { DeployTarget } from "./target.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GENERATION = /^[0-9a-f]{32}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_D1_LIST_PAGES = 100;
const MAX_R2_LIST_PAGES = 100;
const R2_LIST_PAGE_SIZE = 100;
const MAX_MIGRATION_DIAGNOSTIC_NAMES = 128;

interface BoundedMigrationFailureEvidence {
  readonly exitCode: number | null;
  readonly appliedMigrations: readonly string[] | null;
  readonly expectedMigrations: readonly string[];
}

// Keep migration evidence in a private typed error so normalization never has
// to trust or forward arbitrary error detail text.
class MigrationApplyError extends DeployError {
  constructor(
    message: string,
    readonly evidence: BoundedMigrationFailureEvidence,
  ) {
    super("mutation", message);
  }
}

/**
 * Fresh-only integration payloads. `v2-artifacts-0075` is the historical
 * artifact Host payload. `v2-0088` and `v2-0089` are the same closed,
 * fixed-digest audited payloads as the production fresh-init profiles: a
 * brand-new generation that already carries 0081 private inputs and the 0088
 * drain (or 0089 Cron) schema, so a freshly bootstrapped Host never needs the
 * in-place 0066→0088 wave and its historical predecessor-source proofs.
 * `v2-0091` (through the Stripe event table) and `v2-0092` (through the
 * Organization wallet lifecycle tables) are the staging-only profiles: no
 * production surface offers them, and their apply also requires the
 * production target so the production D1 identity is refused explicitly.
 */
export type IntegrationFreshLineage = "v2-artifacts-0075" | FreshV2D1Lineage;

const INTEGRATION_FRESH_LINEAGES: readonly IntegrationFreshLineage[] = [
  "v2-artifacts-0075",
  "v2-0088",
  "v2-0089",
  "v2-0091",
  "v2-0092",
];

/** Profiles no production surface offers; their apply requires the production target. */
const STAGING_ONLY_LINEAGES: ReadonlySet<IntegrationFreshLineage> = new Set(["v2-0091", "v2-0092"]);

/** The exact production D1 a staging generation must never be. */
export interface ProductionD1Identity {
  readonly databaseName: string;
  readonly databaseId: string;
}

/**
 * Production D1 names: the original `takoserver-runtime…` databases and the
 * `takoserver-p-<generation>` ones production fresh init creates. The
 * generated-name allowlist below already excludes both; this names them so a
 * future change to that allowlist cannot silently admit one.
 */
const PRODUCTION_D1_NAME = /^takoserver-(?:runtime(?:$|-)|p-)/u;
const FRESH_GENERATED_NAME = /^integration-takoserver-[0-9a-f]{32}$/u;
const GENERATED_D1_NAME = /^(?:integration-takoserver-|takoserver-i-)[0-9a-f]{32}$/u;
const PREFIXED_D1_NAME = /^integration-ts-([0-9a-f]{32})$/u;

/** Explicit original-create selector; omitted uses the default fresh integration namespace. */
export type IntegrationStorageGenerationNamespace = "integration-ts";

/** A formatter, not creation or storage authority. No arbitrary prefix is accepted. */
export function integrationStorageGenerationName(
  generation: string,
  namespace?: IntegrationStorageGenerationNamespace,
): string {
  if (
    typeof generation !== "string" ||
    !GENERATION.test(generation) ||
    (namespace !== undefined && namespace !== "integration-ts")
  ) {
    throw preflightError(
      "integration generation requires one closed namespace and 32 lowercase hex",
    );
  }
  return namespace === "integration-ts"
    ? `integration-ts-${generation}`
    : `integration-takoserver-${generation}`;
}

export interface IntegrationStorageOriginalCreateOptions {
  readonly kind: "positive-fresh-0092";
  /** Existing, owned 0700 directory outside every checkout. Never replace or rotate it to retry. */
  readonly custodyDirectory: string;
  /** Pin at operator provisioning, retain unchanged on reopen; never infer a new pin on load. */
  readonly custodyIdentity: { readonly device: string; readonly inode: string };
}

/**
 * Original-operation evidence, not a money origin certificate or runtime readiness.
 * Even provider-native evidence requires independent review of original protected custody.
 * A composing command/redaction port is source-owned execution, not authority to supply rows,
 * identities or post-fact certificates. All explicit read/provider/source test seams issue only
 * the distinct component-simulation result below; neither form is accepted by the money owner yet.
 */
export interface IntegrationStorageOriginalCreateEvidence {
  readonly kind:
    | "takoserver.integration-fresh-0092-original-create@v1"
    | "takoserver.integration-fresh-0092-component-result@v1";
  readonly authority: "provider-native" | "component-simulation";
  readonly qualification: "independent-origin-review-required" | "component-simulation-only";
  readonly commandPort: "owner-default" | "composing-source-owned";
  readonly namespace: "integration-ts";
  readonly generation: string;
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly bucketName: string;
  readonly sourceCommit: string;
  readonly migrationDigest: string;
  readonly migrationImportDigest: string;
  readonly schemaShapeDigest: string;
  readonly createDispatchDigest: string;
  readonly identifiedDigest: string;
  readonly importDispatchDigest: string;
  readonly r2DispatchDigest: string;
  readonly originalBindingDigest: string;
  readonly d1IdentityReadbackDigest: string;
  readonly r2IdentityReadbackDigest: string;
  readonly freshDataPolicyDigest: string;
}

export interface IntegrationStorageOriginalCreateReceipt
  extends IntegrationStorageOriginalCreateEvidence {
  readonly terminalCustodyDigest: string;
}

/** Locators and read ports only; no saved result, source override or current-schema claim. */
export interface IntegrationStorageOriginalCreateVerificationOptions
  extends Pick<
    IntegrationStorageGenerationTargetVerificationOptions,
    "provider" | "fetcher" | "run" | "cloudflareEnvironment"
  > {
  readonly originalCreate: IntegrationStorageOriginalCreateOptions;
}

/** Original fixed92 custody and current identity, never money or runtime readiness. */
export interface IntegrationStorageOriginalCreateVerification {
  readonly qualification: IntegrationStorageOriginalCreateEvidence["qualification"];
  readonly originalCreate: IntegrationStorageOriginalCreateReceipt;
  readonly originalSelectedTargetDigest: string;
  readonly custodyRootIdentityDigest: string;
  readonly nativeReadback: {
    readonly authority: IntegrationStorageOriginalCreateEvidence["authority"];
    readonly accountId: string;
    readonly d1: { readonly databaseId: string; readonly databaseName: string };
    readonly r2: { readonly bucketName: string };
  };
}

/**
 * An operator-provisioned staging pair: one D1 and one R2 bucket sharing the
 * name `takoserver-staging-<label>`. It stands in for a generated pair only on
 * a target that selects a staging-only lineage (`v2-0091` or `v2-0092`), and only
 * for the read-side proofs (identity readback, that lineage's exact ledger and
 * canonical schema, and the empty-data proof at first publication). This
 * default creator uses only `integration-takoserver-<generation>`; the separate
 * original-custody creator admits `integration-ts-<generation>`. A
 * production-named database never qualifies.
 */
const STAGING_PAIR_NAME = /^takoserver-staging-[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/u;

/**
 * Staging storage is never production storage. The generated name can only be
 * `integration-takoserver-<generation>` on this shared read/default-creator seam.
 * The original-custody creator retains its separate identity and continuity fences.
 * Historical `takoserver-i-<generation>`
 * pairs remain readable; only the fresh prefix is admitted by the creation
 * fence. This checks both against production naming and,
 * where the operator's production target is supplied, against its exact D1
 * name and id, before creation and again once the new id is known.
 */
export function assertStagingD1NotProduction(
  candidate: { readonly databaseName: string; readonly databaseId?: string },
  production: ProductionD1Identity | undefined,
  phase: "preflight" | "mutation" = "preflight",
): void {
  const refuse = (message: string) =>
    phase === "preflight" ? preflightError(message) : mutationError(message);
  if (
    !GENERATED_D1_NAME.test(candidate.databaseName) ||
    PRODUCTION_D1_NAME.test(candidate.databaseName)
  ) {
    throw refuse(
      "staging D1 generation refuses any database that is not a generated integration D1",
    );
  }
  if (
    production !== undefined &&
    (candidate.databaseName === production.databaseName ||
      (candidate.databaseId !== undefined && candidate.databaseId === production.databaseId))
  ) {
    throw refuse("staging D1 generation refuses the production target's D1");
  }
}

export function isIntegrationFreshLineage(value: unknown): value is IntegrationFreshLineage {
  return (
    typeof value === "string" && (INTEGRATION_FRESH_LINEAGES as readonly string[]).includes(value)
  );
}

export interface IntegrationStorageGenerationInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly generation: string;
  readonly namespace?: IntegrationStorageGenerationNamespace;
  /** Exact fresh-only payload; omitted means the historical 0066 payload. */
  readonly freshLineage?: IntegrationFreshLineage;
}

export interface IntegrationStorageD1Database {
  readonly name: string;
  readonly uuid: string;
}

export interface IntegrationStorageR2Bucket {
  readonly name: string;
}

/**
 * The only provider capability this surface needs.  It deliberately has no
 * delete, update, Worker, route, namespace, or target-binding operation.
 */
export interface IntegrationStorageGenerationProvider {
  listD1(name: string): Promise<readonly IntegrationStorageD1Database[]>;
  getD1(databaseId: string): Promise<IntegrationStorageD1Database>;
  createD1(name: string): Promise<IntegrationStorageD1Database>;
  listR2(name: string): Promise<readonly IntegrationStorageR2Bucket[]>;
  getR2(name: string): Promise<IntegrationStorageR2Bucket>;
  createR2(name: string): Promise<IntegrationStorageR2Bucket>;
}

/** Read-only provider authority used when a generated target is admitted for publication. */
export interface IntegrationStorageTargetReadProvider {
  getD1(databaseId: string): Promise<IntegrationStorageD1Database>;
  getR2(name: string): Promise<IntegrationStorageR2Bucket>;
}

export type IntegrationStorageFetcher = (request: Request) => Promise<Response>;

export type IntegrationStorageGenerationProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface IntegrationStorageGenerationStateReader {
  read(phase: DeployPhase): Promise<D1SchemaState>;
}

export interface IntegrationStorageGenerationOptions {
  readonly run?: IntegrationStorageGenerationProcess;
  readonly review?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly outputDirectory?: string;
  /** Test-only source seam; production callers use the repository migrations. */
  readonly migrationDirectory?: string;
  /** Narrow provider seam used by tests and local contract simulations. */
  readonly provider?: IntegrationStorageGenerationProvider;
  readonly fetcher?: IntegrationStorageFetcher;
  /** Narrow D1 state seam; no provider adoption or state writes are exposed. */
  readonly reader?: IntegrationStorageGenerationStateReader | Pick<SchemaReader, "read">;
  readonly readD1State?: (
    phase: DeployPhase,
    input: {
      readonly configPath: string;
      readonly databaseName: string;
      readonly databaseId: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly run: IntegrationStorageGenerationProcess;
    },
  ) => Promise<D1SchemaState>;
  readonly wranglerCommand?: (args: readonly string[]) => readonly string[];
  /** Test seam for the fresh v2-0088/0089/0091/0092 empty-data proof; deploy uses remote D1. */
  readonly freshV2DataReader?: FreshV2DataReader;
  /**
   * The production target's D1, read from `TAKOSERVER_DEPLOY_TARGET_PRODUCTION`.
   * Optional in general, required to apply a staging-only profile (`v2-0091`, `v2-0092`).
   */
  readonly productionD1?: ProductionD1Identity;
  /** Dedicated new integration-ts/fresh92 path, mutually exclusive with productionD1. */
  readonly originalCreate?: IntegrationStorageOriginalCreateOptions;
}

export interface IntegrationStorageGenerationTargetProof {
  readonly generation: string;
  readonly namespace?: IntegrationStorageGenerationNamespace;
  readonly d1: { readonly databaseId: string; readonly databaseName: string };
  readonly r2: { readonly bucketName: string };
  readonly migrationDigest: string;
  readonly appliedMigrations: readonly string[];
  readonly schemaShapeDigest: string;
}

export interface FreshV2ArtifactIntegrationStorageTargetProof
  extends IntegrationStorageGenerationTargetProof {
  readonly freshLineage: "v2-artifacts-0075";
}

export interface FreshV2IntegrationStorageTargetProof
  extends IntegrationStorageGenerationTargetProof {
  readonly freshLineage: IntegrationFreshLineage;
}

export interface CanonicalV20092IntegrationStorageTargetProof
  extends IntegrationStorageGenerationTargetProof {
  readonly appliedSchemaLineage: "v2-0092";
}

export interface CanonicalV20092IntegrationStorageIdentityProof {
  readonly accountId: string;
  readonly d1: { readonly databaseId: string; readonly databaseName: string };
  readonly r2: { readonly bucketName: string };
  readonly productionD1: ProductionD1Identity;
}

/**
 * Narrow read-only seam for proving that the selected integration Worker
 * target names one existing generated storage pair with the exact audited D1
 * schema. It intentionally exposes no create/delete/update capability.
 */
export interface IntegrationStorageGenerationTargetVerificationOptions {
  readonly run?: IntegrationStorageGenerationProcess;
  /** Wrangler executable selected by the composing owner. */
  readonly wranglerPath?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly provider?: IntegrationStorageTargetReadProvider;
  readonly fetcher?: IntegrationStorageFetcher;
  readonly reader?: IntegrationStorageGenerationStateReader | Pick<SchemaReader, "read">;
  readonly readD1State?: IntegrationStorageGenerationOptions["readD1State"];
  readonly migrationDirectory?: string;
  readonly outputDirectory?: string;
  readonly wranglerCommand?: IntegrationStorageGenerationOptions["wranglerCommand"];
  /** Read-only Worker proof after an independently qualified 0094 cutover. */
  readonly allowCurrentAuditedSuccessor?: boolean;
  /** Read-side only for the dedicated non-serving 0092/0093/0094 money maintenance campaign. */
  readonly allowMoneyUnitMaintenance?: boolean;
}

export type IntegrationStorageGeneratedStateOptions = Pick<
  IntegrationStorageGenerationOptions,
  "readD1State" | "reader" | "wranglerCommand"
> & { readonly wranglerPath?: string };

/**
 * Read-only/status and one-way fresh-storage bootstrap for integration.
 *
 * Fresh names are derived only from the explicit generation. The selected
 * target contributes the account and environment guard; it can also select
 * the exact legacy generation for status alone. Apply never touches its
 * current D1/R2 and refuses either half of a same-generation selected pair.
 */
export async function runIntegrationStorageGeneration(
  selectedInvocation: IntegrationStorageGenerationInvocation,
  selectedTarget: DeployTarget,
  options: IntegrationStorageGenerationOptions = {},
): Promise<Record<string, unknown>> {
  const { invocation, target } = snapshotStorageContext({
    invocation: selectedInvocation,
    target: selectedTarget,
  });
  const names = validateInvocation(invocation, target);
  // Own dispatch data while retaining the original creator's caller-currentness fence.
  const original = prepareOriginalCreate(invocation, target, names, options, "create", {
    invocation: selectedInvocation,
    target: selectedTarget,
  });
  if (invocation.action === "apply") assertFreshGenerationNames(names, original);
  if (original === null) {
    assertStagingD1NotProduction({ databaseName: names.databaseName }, options.productionD1);
  }
  if (
    original === null &&
    invocation.action === "apply" &&
    invocation.freshLineage !== undefined &&
    STAGING_ONLY_LINEAGES.has(invocation.freshLineage) &&
    options.productionD1 === undefined
  ) {
    throw preflightError(
      `the staging-only ${invocation.freshLineage} profile requires TAKOSERVER_DEPLOY_TARGET_PRODUCTION, ` +
        "so the production D1 is refused by its exact identity",
    );
  }
  if (invocation.action === "status") {
    const provider = await resolveProvider(target, options);
    original?.assertUnchanged();
    return await statusStorageGeneration(invocation, target, names, provider, options, original);
  }
  return await applyStorageGeneration(invocation, target, names, options, original);
}

/**
 * Proves, without provider mutation, the exact generated storage pair selected
 * by an integration target. The D1 binding ID, resource name, R2 name, audited
 * migration lineage and canonical application schema all participate in the
 * returned proof so callers can compare two fences exactly.
 */
export async function verifyIntegrationStorageGenerationTarget(
  target: DeployTarget,
  environment: DeployEnvironment,
  options: IntegrationStorageGenerationTargetVerificationOptions = {},
): Promise<IntegrationStorageGenerationTargetProof> {
  return await verifyGeneratedStorageTarget(target, environment, options, "apply-0066");
}

/**
 * Reopen the original protected operation without writing, adopting or completing it.
 * The original incumbent collision tuple remains distinct from the selected new pair.
 * Current SQL/data may have advanced under another owner; only native identities are read.
 */
export async function verifyIntegrationStorageOriginalCreate(
  originalInvocation: IntegrationStorageGenerationInvocation,
  originalTarget: DeployTarget,
  selectedTarget: DeployTarget,
  options: IntegrationStorageOriginalCreateVerificationOptions,
): Promise<IntegrationStorageOriginalCreateVerification> {
  if (
    originalInvocation.action !== "apply" ||
    !originalRecord(options) ||
    Object.keys(options).some(
      (key) =>
        !["originalCreate", "provider", "fetcher", "run", "cloudflareEnvironment"].includes(key),
    )
  ) {
    throw preflightError(
      "original creation verification requires only original selectors and read ports",
    );
  }
  const names = validateInvocation(originalInvocation, originalTarget);
  const original = prepareOriginalCreate(
    originalInvocation,
    originalTarget,
    names,
    { originalCreate: options.originalCreate },
    "read-retained",
  );
  if (original === null) throw preflightError("original creation custody is required");
  const selectedIdentity = () => ({
    ...generatedStorageTarget(selectedTarget, "integration"),
    freshLineage: selectedTarget.takoformV2?.storageLineage,
  });
  const selected = selectedIdentity();
  const retained = original.readTerminal();
  if (
    selected.namespace !== "integration-ts" ||
    selected.accountId !== retained.originalCreate.accountId ||
    selected.generation !== retained.originalCreate.generation ||
    selected.databaseName !== retained.originalCreate.databaseName ||
    selected.databaseId !== retained.originalCreate.databaseId ||
    selected.bucketName !== retained.originalCreate.bucketName
  ) {
    throw preflightError("selected storage differs from the original create ACK identity");
  }
  const ports = [
    options.originalCreate,
    options.provider,
    options.fetcher,
    options.run,
    options.cloudflareEnvironment,
  ] as const;
  const snapshot = () =>
    JSON.stringify({
      selected: selectedIdentity(),
      cloudflareEnvironment: options.cloudflareEnvironment,
      keys: Object.keys(options).sort(),
    });
  const before = snapshot();
  const assertUnchanged = () => {
    if (
      snapshot() !== before ||
      [
        options.originalCreate,
        options.provider,
        options.fetcher,
        options.run,
        options.cloudflareEnvironment,
      ].some((port, index) => port !== ports[index]) ||
      JSON.stringify(original.readTerminal()) !== JSON.stringify(retained)
    ) {
      throw preflightError(
        "original creation custody or selected identity changed during readback",
      );
    }
  };
  // Read-port overrides do not describe how the historical creator obtained its identity.
  const observerAuthority =
    options.provider !== undefined || options.fetcher !== undefined
      ? ("component-simulation" as const)
      : ("provider-native" as const);
  const { provider } = await resolveTargetReadProvider(selectedTarget, "integration", options);
  assertUnchanged();
  const d1 = validateD1Summary(
    await providerCall("preflight", "original creation D1 identity readback failed", () =>
      provider.getD1(selected.databaseId),
    ),
    "original creation D1 identity readback",
  );
  assertUnchanged();
  if (d1.name !== selected.databaseName || d1.uuid !== selected.databaseId) {
    throw preflightError("original creation D1 identity readback differs from its ACK");
  }
  const r2 = validateR2Summary(
    await providerCall("preflight", "original creation R2 identity readback failed", () =>
      provider.getR2(selected.bucketName),
    ),
    "original creation R2 identity readback",
  );
  assertUnchanged();
  if (r2.name !== selected.bucketName) {
    throw preflightError("original creation R2 identity readback differs from its retained name");
  }
  return {
    ...retained,
    qualification:
      retained.originalCreate.authority === "provider-native" &&
      observerAuthority === "provider-native"
        ? "independent-origin-review-required"
        : "component-simulation-only",
    nativeReadback: {
      authority: observerAuthority,
      accountId: selected.accountId,
      d1: { databaseId: d1.uuid, databaseName: d1.name },
      r2: { bucketName: r2.name },
    },
  };
}

/**
 * Read-only proof for one generated integration pair with the complete fixed
 * v2 artifact schema. Existing v1 target readers remain pinned to 0066.
 */
export async function verifyFreshV2ArtifactIntegrationStorageTarget(
  target: DeployTarget,
  environment: DeployEnvironment,
  options: IntegrationStorageGenerationTargetVerificationOptions = {},
): Promise<FreshV2ArtifactIntegrationStorageTargetProof> {
  const proof = await verifyGeneratedStorageTarget(
    target,
    environment,
    options,
    "v2-artifacts-0075",
  );
  return { ...proof, freshLineage: "v2-artifacts-0075" };
}

/**
 * Read-only proof for one generated integration pair. The selected lineage
 * remains its immutable creation claim. An explicit caller option can also
 * prove the complete current audited 0094 schema after a separate cutover;
 * this does not qualify or apply that cutover. Data is not rechecked because
 * a running Host legitimately writes rows after the generation proof.
 */
export async function verifyFreshV2IntegrationStorageTarget(
  target: DeployTarget,
  environment: DeployEnvironment,
  lineage: IntegrationFreshLineage,
  options: IntegrationStorageGenerationTargetVerificationOptions = {},
): Promise<FreshV2IntegrationStorageTargetProof> {
  if (!isIntegrationFreshLineage(lineage)) {
    throw preflightError("unsupported fresh integration migration lineage");
  }
  const proof = await verifyGeneratedStorageTarget(target, environment, options, lineage);
  return { ...proof, freshLineage: lineage };
}

/** Read-only proof selected after the reviewed in-place 0088→0092 wave. */
export async function verifyCanonicalV20092IntegrationStorageTarget(
  selectedTarget: DeployTarget,
  environment: DeployEnvironment,
  options: IntegrationStorageGenerationTargetVerificationOptions = {},
): Promise<CanonicalV20092IntegrationStorageTargetProof> {
  const target = snapshotStorageContext(selectedTarget);
  if (
    environment !== "integration" ||
    target.takoformV2?.storageLineage !== "v2-0088" ||
    target.takoformV2.appliedSchemaLineage !== "v2-0092"
  ) {
    throw preflightError(
      "canonical 0092 storage proof requires explicit applied lineage on the original 0088 integration target",
    );
  }
  const proof = await verifyGeneratedStorageTarget(target, environment, options, "applied-v2-0092");
  return { ...proof, appliedSchemaLineage: "v2-0092" };
}

/** Provider GET identity fence before the schema mutation, independent of its applied lineage. */
export async function verifyCanonicalV20092IntegrationStorageIdentity(
  selectedTarget: DeployTarget,
  productionD1: ProductionD1Identity,
  options: IntegrationStorageGenerationTargetVerificationOptions = {},
): Promise<CanonicalV20092IntegrationStorageIdentityProof> {
  const target = snapshotStorageContext(selectedTarget);
  if (target.takoformV2?.storageLineage !== "v2-0088") {
    throw preflightError("canonical 0092 identity proof requires the original v2-0088 target");
  }
  const generated = generatedStorageTarget(target, "integration");
  const productionDescriptor = validateD1Summary(
    { uuid: productionD1.databaseId, name: productionD1.databaseName },
    "canonical 0092 read-only production descriptor",
  );
  assertStagingD1NotProduction(
    { databaseName: generated.databaseName, databaseId: generated.databaseId },
    { databaseId: productionDescriptor.uuid, databaseName: productionDescriptor.name },
  );
  const { provider } = await resolveTargetReadProvider(target, "integration", options);
  const selectedD1 = validateD1Summary(
    await providerCall("preflight", "canonical 0092 D1 identity GET failed", () =>
      provider.getD1(generated.databaseId),
    ),
    "canonical 0092 D1 identity GET",
  );
  const selectedR2 = validateR2Summary(
    await providerCall("preflight", "canonical 0092 R2 identity GET failed", () =>
      provider.getR2(generated.bucketName),
    ),
    "canonical 0092 R2 identity GET",
  );
  if (
    selectedD1.uuid !== generated.databaseId ||
    selectedD1.name !== generated.databaseName ||
    selectedR2.name !== generated.bucketName
  ) {
    throw preflightError(
      "canonical 0092 provider identity differs from the exact generated pair or production descriptor",
    );
  }
  return {
    accountId: generated.accountId,
    d1: { databaseId: selectedD1.uuid, databaseName: selectedD1.name },
    r2: { bucketName: selectedR2.name },
    productionD1: {
      databaseId: productionDescriptor.uuid,
      databaseName: productionDescriptor.name,
    },
  };
}

async function verifyGeneratedStorageTarget(
  selectedTarget: DeployTarget,
  environment: DeployEnvironment,
  options: IntegrationStorageGenerationTargetVerificationOptions,
  lineage: "apply-0066" | IntegrationFreshLineage | "applied-v2-0092",
): Promise<IntegrationStorageGenerationTargetProof> {
  const target = snapshotStorageContext(selectedTarget);
  const generated = generatedStorageTarget(target, environment);
  const providerContext = await resolveTargetReadProvider(target, environment, options);
  const d1 = await providerCall("preflight", "generated target D1 identity readback failed", () =>
    providerContext.provider.getD1(generated.databaseId),
  );
  let verifiedD1: IntegrationStorageD1Database;
  try {
    verifiedD1 = validateD1Summary(d1, "generated target D1 identity readback");
  } catch {
    throw preflightError("generated target D1 identity readback returned a malformed identity");
  }
  if (verifiedD1.uuid !== generated.databaseId || verifiedD1.name !== generated.databaseName) {
    throw preflightError(
      "generated target D1 identity readback does not match the exact target ID and name",
      `databaseId=${generated.databaseId}`,
    );
  }

  const r2 = await providerCall("preflight", "generated target R2 identity readback failed", () =>
    providerContext.provider.getR2(generated.bucketName),
  );
  let verifiedR2: IntegrationStorageR2Bucket;
  try {
    verifiedR2 = validateR2Summary(r2, "generated target R2 identity readback");
  } catch {
    throw preflightError("generated target R2 identity readback returned a malformed identity");
  }
  if (verifiedR2.name !== generated.bucketName) {
    throw preflightError(
      "generated target R2 identity readback does not match the exact target name",
    );
  }

  const migrationDirectory = options.migrationDirectory ?? resolve(REPOSITORY, "migrations");
  const sourceArtifact = selectedSourceArtifact(migrationDirectory, lineage);
  const moneyMaintenance =
    options.allowMoneyUnitMaintenance === true &&
    target.schemaMaintenanceMode === "pre-wallet-usd-micros-quiesced" &&
    (lineage === "v2-0092" || lineage === "applied-v2-0092");
  const currentSource =
    (options.allowCurrentAuditedSuccessor === true || moneyMaintenance) && lineage !== "apply-0066"
      ? readCurrentAuditedMigrationSourceArtifact(migrationDirectory)
      : null;
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ??
    mkdtempSync(join(tmpdir(), "takoserver-integration-storage-verify-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const configPath = join(root, "read-wrangler.jsonc");
  try {
    if (existsSync(configPath)) {
      throw preflightError("generated target verification output directory is already in use");
    }
    writeGenerationConfig(
      configPath,
      target.accountId,
      generated.databaseName,
      generated.databaseId,
    );
    const migrationState = await readGeneratedState(
      "preflight",
      configPath,
      {
        accountId: target.accountId,
        databaseName: generated.databaseName,
        databaseId: generated.databaseId,
      },
      providerContext.environment,
      options.run ?? runCommand,
      {
        ...(options.readD1State === undefined ? {} : { readD1State: options.readD1State }),
        ...(options.reader === undefined ? {} : { reader: options.reader }),
        ...(options.wranglerCommand === undefined
          ? {}
          : { wranglerCommand: options.wranglerCommand }),
        ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
      },
    );
    // A full current schema is a read-side successor of the selected origin,
    // never a new generation payload. Both alternatives are exact audited
    // ledgers; partial states and foreign migration tails match neither.
    const currentAudited =
      currentSource === null
        ? false
        : currentSource.names.includes(MONEY_UNIT_MIGRATION) &&
          JSON.stringify(migrationState.applied) === JSON.stringify(currentSource.names);
    const moneyPhase =
      currentSource === null
        ? undefined
        : (
            [
              ...(moneyMaintenance ? ["0092", "0092-fenced", "0093", "0093-fenced"] : []),
              ...(options.allowCurrentAuditedSuccessor === true || moneyMaintenance
                ? ["0094", "0094-fenced"]
                : []),
            ] as MoneySchemaPhase[]
          ).find((phase) =>
            moneyUnitCutoverSchemaMatches(migrationState, currentSource.files, phase),
          );
    const moneyCount = moneyPhase === undefined ? undefined : Number(moneyPhase.slice(0, 4));
    const observedSource =
      moneyCount !== undefined && currentSource !== null
        ? {
            ...currentSource,
            files: currentSource.files.slice(0, moneyCount),
            names: currentSource.names.slice(0, moneyCount),
            bytes: currentSource.files
              .slice(0, moneyCount)
              .reduce((sum, file) => sum + file.bytes, 0),
            digest: moneyUnitCutoverSourcePrefixDigest(
              currentSource.files,
              moneyCount as 92 | 93 | 94,
            ),
          }
        : currentAudited && currentSource !== null
          ? currentSource
          : sourceArtifact;
    assertCompleteDatabase(
      migrationState,
      observedSource.names,
      observedSource.digest,
      moneyPhase === undefined
        ? deriveExpectedApplicationShape(observedSource.files)
        : moneyUnitCutoverExpectedShape(currentSource?.files ?? [], moneyPhase),
      generated.databaseId,
      "preflight",
    );
    return {
      generation: generated.generation,
      ...(generated.namespace === undefined ? {} : { namespace: generated.namespace }),
      d1: { databaseId: generated.databaseId, databaseName: generated.databaseName },
      r2: { bucketName: generated.bucketName },
      migrationDigest: observedSource.digest,
      appliedMigrations: [...migrationState.applied],
      schemaShapeDigest: migrationState.shapeDigest,
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

// This is the existing creator's original-operation custody, not a generic deploy controller.
const ORIGINAL_STAGES = [
  "create-dispatched",
  "identified",
  "import-dispatched",
  "r2-dispatched",
  "terminal",
] as const;
type OriginalCreateStage = (typeof ORIGINAL_STAGES)[number];
const ORIGINAL_RECORD_LIMIT = 32 * 1024;
const ORIGINAL_IMPORT_LIMIT = 16 * 1024 * 1024;
const ORIGINAL_SOURCE_0092 =
  "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2";

interface OriginalCreateBinding {
  readonly kind: "takoserver.integration-fresh-0092-create-binding@v1";
  readonly environment: "integration";
  readonly namespace: "integration-ts";
  readonly accountId: string;
  readonly generation: string;
  readonly databaseName: string;
  readonly bucketName: string;
  readonly selectedTargetDigest: string;
  readonly custodyRootIdentityDigest: string;
  readonly sourceCommit: string;
  readonly migrationDigest: string;
  readonly migrationBytes: number;
  readonly importDigest: string;
  readonly importBytes: number;
  readonly applicationShapeDigest: string;
  readonly reviewer: string;
  readonly authority: "provider-native" | "component-simulation";
  readonly commandPort: "owner-default" | "composing-source-owned";
}

interface OriginalCreateRecord {
  readonly kind: "takoserver.integration-fresh-0092-create-custody@v1";
  readonly stage: OriginalCreateStage | "unknown";
  readonly binding: OriginalCreateBinding;
  readonly previousDigest: string | null;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly digest: string;
}

interface OriginalCreateContext {
  readonly artifactRoot: string;
  assertUnchanged(): void;
  assertUnused(): void;
  binding(
    source: ReturnType<typeof selectedSourceArtifact>,
    migrationImport: ReturnType<typeof buildD1MigrationImport>,
    expectedShape: string,
    reviewer: string,
  ): OriginalCreateBinding;
  append(
    stage: OriginalCreateStage,
    binding: OriginalCreateBinding,
    evidence: Readonly<Record<string, unknown>>,
  ): OriginalCreateRecord;
  evidence(
    binding: OriginalCreateBinding,
    databaseId: string,
  ): IntegrationStorageOriginalCreateEvidence;
  retainUnknown(binding: OriginalCreateBinding, databaseId: string | null): void;
  readTerminal(): Pick<
    IntegrationStorageOriginalCreateVerification,
    "originalCreate" | "originalSelectedTargetDigest" | "custodyRootIdentityDigest"
  >;
  status(): {
    readonly state: "absent" | "unknown" | "terminal";
    readonly qualification: "diagnostic-only";
    readonly lastStage: string | null;
    readonly terminalCustodyDigest: string | null;
  };
}

function originalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function originalRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function originalKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function originalRootIdentity(root: string): { readonly device: bigint; readonly inode: bigint } {
  try {
    if (!isAbsolute(root) || root === "/" || root.endsWith("/") || realpathSync(root) !== root)
      throw new Error("alias");
    const state = lstatSync(root, { bigint: true });
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      (state.mode & 0o777n) !== 0o700n ||
      process.getuid === undefined ||
      state.uid !== BigInt(process.getuid())
    )
      throw new Error("unsafe root");
    const inside = relative(realpathSync(REPOSITORY), root);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)))
      throw new Error("repository");
    for (let cursor = root; ; cursor = dirname(cursor)) {
      if (lstatSync(join(cursor, ".git"), { throwIfNoEntry: false }) !== undefined)
        throw new Error("checkout");
      if (dirname(cursor) === cursor) break;
    }
    return { device: state.dev, inode: state.ino };
  } catch {
    throw preflightError(
      "original integration creation requires an existing owned link-free 0700 custody root outside every checkout",
    );
  }
}

/** Compare the held inode with both its original state and the currently named entry. */
function assertOriginalFileCurrent(path: string, fd: number, before: BigIntStats): void {
  const held = fstatSync(fd, { bigint: true });
  const named = lstatSync(path, { bigint: true });
  for (const stat of [held, named]) {
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.mode !== before.mode ||
      stat.uid !== before.uid ||
      stat.gid !== before.gid ||
      stat.nlink !== before.nlink ||
      stat.size !== before.size ||
      stat.mtimeNs !== before.mtimeNs ||
      stat.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("original entry changed");
    }
  }
}

/** Shared only by the original creator's bounded read and artifact fsync paths. */
function openOriginalRegularFile(
  path: string,
  limit: number,
  sealed: boolean,
): { readonly fd: number; readonly stat: BigIntStats } {
  const named = lstatSync(path, { bigint: true });
  const uid = process.getuid?.();
  const valid = (stat: BigIntStats): boolean =>
    stat.isFile() &&
    stat.nlink === 1n &&
    uid !== undefined &&
    stat.uid === BigInt(uid) &&
    ((stat.mode & 0o777n) === 0o600n || (sealed && (stat.mode & 0o777n) === 0o400n)) &&
    stat.size > 0n &&
    stat.size <= BigInt(limit);
  if (!valid(named)) throw new Error("unsafe original entry");
  // The path can change after lstat: a FIFO must never block before held-fd validation.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!valid(stat)) throw new Error("unsafe held original entry");
    assertOriginalFileCurrent(path, fd, named);
    return { fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Load locators only; the existing creator independently constructs its custody context. */
export function loadIntegrationStorageOriginalCreateInput(
  path: string,
): IntegrationStorageOriginalCreateOptions {
  let fd = -1;
  try {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("noncanonical input path");
    const parent = dirname(path);
    const parentIdentity = originalRootIdentity(parent);
    const held = openOriginalRegularFile(path, 16 * 1024, false);
    fd = held.fd;
    const size = Number(held.stat.size);
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count < 1) throw new Error("truncated original-create input");
      offset += count;
    }
    if (readSync(fd, bytes, offset, 1, offset) !== 0)
      throw new Error("grown original-create input");
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
    if (
      !originalRecord(value) ||
      !originalKeys(value, ["kind", "custodyDirectory", "custodyIdentity"]) ||
      value.kind !== "positive-fresh-0092" ||
      typeof value.custodyDirectory !== "string" ||
      !originalRecord(value.custodyIdentity) ||
      !originalKeys(value.custodyIdentity, ["device", "inode"]) ||
      typeof value.custodyIdentity.device !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(value.custodyIdentity.device) ||
      typeof value.custodyIdentity.inode !== "string" ||
      !/^[1-9][0-9]*$/u.test(value.custodyIdentity.inode)
    ) {
      throw new Error("not original-create locators");
    }
    const custodyIdentity = originalRootIdentity(value.custodyDirectory);
    if (
      value.custodyIdentity.device !== String(custodyIdentity.device) ||
      value.custodyIdentity.inode !== String(custodyIdentity.inode)
    ) {
      throw new Error("original provisioning pin differs");
    }
    assertOriginalFileCurrent(path, fd, held.stat);
    const currentParent = originalRootIdentity(parent);
    if (
      currentParent.device !== parentIdentity.device ||
      currentParent.inode !== parentIdentity.inode
    ) {
      throw new Error("original-create input parent changed");
    }
    return Object.freeze({
      kind: "positive-fresh-0092",
      custodyDirectory: value.custodyDirectory,
      custodyIdentity: Object.freeze({
        device: value.custodyIdentity.device,
        inode: value.custodyIdentity.inode,
      }),
    });
  } catch {
    throw preflightError(
      "original-create input requires only pinned custody locators in an unchanged owned single-link 0600 regular file, at most 16 KiB, under a canonical private 0700 root outside every checkout; do not repin or retry",
    );
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function readOriginalBytes(path: string, limit: number, sealed = false): Uint8Array | null {
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return null;
  let fd = -1;
  try {
    const held = openOriginalRegularFile(path, limit, sealed);
    fd = held.fd;
    const size = Number(held.stat.size);
    // At most max+1 bytes, even if an owner grows a formerly small regular file.
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count < 1) throw new Error("truncated original entry");
      offset += count;
    }
    if (readSync(fd, bytes, offset, 1, offset) !== 0) throw new Error("grown original entry");
    assertOriginalFileCurrent(path, fd, held.stat);
    return bytes.subarray(0, size);
  } catch {
    throw mutationError(
      "original integration custody is unsafe or unreadable; retain UNKNOWN and do not retry",
    );
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Retain original sealed SQL/config bytes durably before dispatch/terminal, never as a cache. */
function syncOriginalArtifact(root: string): void {
  let directory = -1;
  try {
    const before = lstatSync(root, { bigint: true });
    if (
      !before.isDirectory() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      ![0o500n, 0o700n].includes(before.mode & 0o777n)
    )
      throw new Error("unsafe artifact directory");
    directory = openSync(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    assertOriginalFileCurrent(root, directory, before);
    for (const name of readdirSync(root).sort()) {
      const path = join(root, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        syncOriginalArtifact(path);
      } else {
        let fd = -1;
        try {
          const held = openOriginalRegularFile(path, ORIGINAL_IMPORT_LIMIT, true);
          fd = held.fd;
          fsyncSync(fd);
          assertOriginalFileCurrent(path, fd, held.stat);
        } finally {
          if (fd >= 0) closeSync(fd);
        }
      }
    }
    fsyncSync(directory);
    assertOriginalFileCurrent(root, directory, before);
  } catch {
    throw mutationError(
      "original creation artifact is unsafe or changed; retain UNKNOWN and do not retry",
    );
  } finally {
    if (directory >= 0) closeSync(directory);
  }
}

function prepareOriginalCreate(
  invocation: IntegrationStorageGenerationInvocation,
  target: DeployTarget,
  names: StorageNames,
  options: IntegrationStorageGenerationOptions,
  intent: "create" | "read-retained" = "create",
  caller: {
    readonly invocation: IntegrationStorageGenerationInvocation;
    readonly target: DeployTarget;
  } = { invocation, target },
): OriginalCreateContext | null {
  if (invocation.namespace === undefined && options.originalCreate === undefined) return null;
  if (
    invocation.namespace !== "integration-ts" ||
    invocation.freshLineage !== "v2-0092" ||
    options.originalCreate?.kind !== "positive-fresh-0092" ||
    options.productionD1 !== undefined ||
    options.outputDirectory !== undefined ||
    !originalKeys(invocation as unknown as Record<string, unknown>, [
      "action",
      "environment",
      "commit",
      "generation",
      "namespace",
      "freshLineage",
    ]) ||
    !originalKeys(options.originalCreate as unknown as Record<string, unknown>, [
      "kind",
      "custodyDirectory",
      "custodyIdentity",
    ])
  ) {
    throw preflightError(
      "original creation requires only the explicit integration-ts fresh92 selector and protected custody; no production guard, output override, caller UUID or proof input",
    );
  }
  if (
    typeof invocation.commit !== "string" ||
    typeof target.accountId !== "string" ||
    typeof target.d1.databaseId !== "string" ||
    !UUID.test(target.d1.databaseId) ||
    typeof target.d1.databaseName !== "string" ||
    typeof target.r2.bucketName !== "string"
  ) {
    throw preflightError(
      "original creation requires exact integration account and incumbent collision identities",
    );
  }
  const root = options.originalCreate.custodyDirectory;
  if (typeof root !== "string") throw preflightError("original creation custody path is required");
  const identity = originalRootIdentity(root);
  const pinnedIdentity = options.originalCreate.custodyIdentity;
  if (
    !originalRecord(pinnedIdentity) ||
    !originalKeys(pinnedIdentity, ["device", "inode"]) ||
    typeof pinnedIdentity.device !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(pinnedIdentity.device) ||
    typeof pinnedIdentity.inode !== "string" ||
    !/^[1-9][0-9]*$/u.test(pinnedIdentity.inode) ||
    pinnedIdentity.device !== String(identity.device) ||
    pinnedIdentity.inode !== String(identity.inode)
  ) {
    throw preflightError(
      "original creation custody differs from its provisioning-time device/inode pin; do not repin or retry",
    );
  }
  const custodyRootIdentityDigest = originalDigest({
    root,
    device: pinnedIdentity.device,
    inode: pinnedIdentity.inode,
  });
  const accountId = target.accountId;
  const generation = invocation.generation;
  const sourceCommit = invocation.commit;
  const stem = `integration-create-${originalDigest({ accountId, namespace: "integration-ts", generation }).slice(7)}`;
  const artifactRoot = join(root, `${stem}.artifact`);
  const path = (stage: OriginalCreateStage | "unknown") => join(root, `${stem}.${stage}.json`);
  const selectedTarget = (selected = target) => ({
    environment: selected.environment,
    accountId: selected.accountId,
    workerName: selected.workerName,
    d1: { ...selected.d1 },
    r2: { ...selected.r2 },
  });
  const callerSnapshot = (captured = false) =>
    JSON.stringify({
      invocation: captured ? invocation : caller.invocation,
      selectedTarget: selectedTarget(captured ? target : caller.target),
      originalCreate: options.originalCreate,
      productionD1: options.productionD1,
      migrationDirectory: options.migrationDirectory,
      outputDirectory: options.outputDirectory,
    });
  const callerIdentity = callerSnapshot(true);
  if (callerSnapshot() !== callerIdentity) {
    throw preflightError("original creation caller data changed during capture");
  }
  const ports = [
    options.run,
    options.provider,
    options.fetcher,
    options.reader,
    options.readD1State,
    options.freshV2DataReader,
    options.wranglerCommand,
    options.cloudflareEnvironment,
  ] as const;
  const authority = [
    options.provider,
    options.fetcher,
    options.reader,
    options.readD1State,
    options.freshV2DataReader,
    options.migrationDirectory,
    options.wranglerCommand,
  ].some((value) => value !== undefined)
    ? ("component-simulation" as const)
    : ("provider-native" as const);
  const commandPort =
    options.run === undefined ? ("owner-default" as const) : ("composing-source-owned" as const);
  let expectedBinding: OriginalCreateBinding | null = null;
  const assertContinuity = (): void => {
    const current = originalRootIdentity(root);
    if (
      current.device !== identity.device ||
      current.inode !== identity.inode ||
      callerSnapshot() !== callerIdentity ||
      [
        options.run,
        options.provider,
        options.fetcher,
        options.reader,
        options.readD1State,
        options.freshV2DataReader,
        options.wranglerCommand,
        options.cloudflareEnvironment,
      ].some((value, index) => value !== ports[index])
    ) {
      throw mutationError(
        "original integration creation binding or custody root changed; retain UNKNOWN",
      );
    }
  };
  const parseBinding = (value: unknown): OriginalCreateBinding => {
    if (
      !originalRecord(value) ||
      !originalKeys(value, [
        "kind",
        "environment",
        "namespace",
        "accountId",
        "generation",
        "databaseName",
        "bucketName",
        "selectedTargetDigest",
        "custodyRootIdentityDigest",
        "sourceCommit",
        "migrationDigest",
        "migrationBytes",
        "importDigest",
        "importBytes",
        "applicationShapeDigest",
        "reviewer",
        "authority",
        "commandPort",
      ]) ||
      value.kind !== "takoserver.integration-fresh-0092-create-binding@v1" ||
      value.environment !== "integration" ||
      value.namespace !== "integration-ts" ||
      value.accountId !== accountId ||
      value.generation !== generation ||
      value.databaseName !== names.databaseName ||
      value.bucketName !== names.bucketName ||
      value.sourceCommit !== sourceCommit ||
      value.custodyRootIdentityDigest !== custodyRootIdentityDigest ||
      value.migrationDigest !== ORIGINAL_SOURCE_0092 ||
      (intent === "create"
        ? value.authority !== authority || value.commandPort !== commandPort
        : (value.authority !== "provider-native" && value.authority !== "component-simulation") ||
          (value.commandPort !== "owner-default" &&
            value.commandPort !== "composing-source-owned")) ||
      !["selectedTargetDigest", "importDigest", "applicationShapeDigest"].every(
        (key) => typeof value[key] === "string" && SHA256.test(value[key]),
      ) ||
      !["migrationBytes", "importBytes"].every(
        (key) =>
          typeof value[key] === "number" &&
          Number.isSafeInteger(value[key]) &&
          value[key] > 0 &&
          value[key] <= ORIGINAL_IMPORT_LIMIT,
      ) ||
      typeof value.reviewer !== "string" ||
      exactReviewer(value.reviewer) !== value.reviewer ||
      (expectedBinding !== null && JSON.stringify(value) !== JSON.stringify(expectedBinding))
    ) {
      throw mutationError(
        "original integration binding differs from retained operation; retain UNKNOWN",
      );
    }
    return value as unknown as OriginalCreateBinding;
  };
  const read = (): OriginalCreateRecord[] => {
    assertContinuity();
    const records: OriginalCreateRecord[] = [];
    let gap = false;
    for (const stage of [...ORIGINAL_STAGES, "unknown"] as const) {
      const bytes = readOriginalBytes(path(stage), ORIGINAL_RECORD_LIMIT);
      if (bytes === null) {
        if (stage !== "unknown") gap = true;
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        throw mutationError("original integration custody is malformed; retain UNKNOWN");
      }
      if (
        !originalRecord(value) ||
        !originalKeys(value, [
          "kind",
          "stage",
          "binding",
          "previousDigest",
          "evidence",
          "digest",
        ]) ||
        value.kind !== "takoserver.integration-fresh-0092-create-custody@v1" ||
        value.stage !== stage ||
        !originalRecord(value.evidence) ||
        typeof value.digest !== "string" ||
        !SHA256.test(value.digest)
      ) {
        throw mutationError("original integration custody envelope is malformed; retain UNKNOWN");
      }
      const binding = parseBinding(value.binding);
      const { digest, ...body } = value;
      if (
        originalDigest(body) !== digest ||
        value.previousDigest !== (records.at(-1)?.digest ?? null) ||
        (stage !== "unknown" && gap) ||
        (stage === "unknown" && (records.length === 0 || records.at(-1)?.stage === "terminal")) ||
        (records.length > 0 && JSON.stringify(binding) !== JSON.stringify(records[0]?.binding))
      ) {
        throw mutationError(
          "original integration custody chain is partial or changed; retain UNKNOWN",
        );
      }
      const evidence = value.evidence;
      const expectedFields =
        stage === "create-dispatched"
          ? []
          : stage === "identified"
            ? ["databaseId", "createResponseDigest", "identityReadbackDigest"]
            : stage === "import-dispatched"
              ? ["databaseId", "emptySchemaDigest"]
              : stage === "r2-dispatched"
                ? [
                    "databaseId",
                    "schemaShapeDigest",
                    "appliedMigrationsDigest",
                    "freshDataPolicyDigest",
                  ]
                : stage === "terminal"
                  ? ["databaseId", "proof"]
                  : ["databaseId", "reason"];
      if (
        !originalKeys(evidence, expectedFields) ||
        (stage !== "create-dispatched" &&
          stage !== "unknown" &&
          (typeof evidence.databaseId !== "string" || !UUID.test(evidence.databaseId))) ||
        (stage === "unknown" &&
          (evidence.reason !== "original-create-incomplete" ||
            (evidence.databaseId !== null &&
              (typeof evidence.databaseId !== "string" || !UUID.test(evidence.databaseId))))) ||
        Object.entries(evidence).some(
          ([key, val]) => key.endsWith("Digest") && (typeof val !== "string" || !SHA256.test(val)),
        ) ||
        (stage === "identified" &&
          evidence.createResponseDigest !== evidence.identityReadbackDigest) ||
        (stage !== "create-dispatched" &&
          stage !== "identified" &&
          stage !== "unknown" &&
          evidence.databaseId !== records[1]?.evidence.databaseId)
      ) {
        throw mutationError(
          "original integration native evidence differs from its chain; retain UNKNOWN",
        );
      }
      if (
        stage === "terminal" &&
        JSON.stringify(evidence.proof) !==
          JSON.stringify(makeEvidence(binding, records, String(evidence.databaseId)))
      ) {
        throw mutationError(
          "original integration terminal proof does not follow its original dispatch",
        );
      }
      records.push(value as unknown as OriginalCreateRecord);
    }
    if (records.length > 0) {
      const first = records[0];
      const payload = join(artifactRoot, "release", "payload");
      const bytes = readOriginalBytes(
        join(payload, "migration-import.sql"),
        ORIGINAL_IMPORT_LIMIT,
        true,
      );
      const source = readSealedSelectedArtifact(join(payload, "migrations"), "v2-0092");
      if (
        first === undefined ||
        bytes === null ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
          first.binding.importDigest ||
        bytes.byteLength !== first.binding.importBytes ||
        source.digest !== first.binding.migrationDigest ||
        source.bytes !== first.binding.migrationBytes
      ) {
        throw mutationError(
          "original integration sealed source/import is unavailable or changed; retain UNKNOWN",
        );
      }
    }
    assertContinuity();
    return records;
  };
  const makeEvidence = (
    binding: OriginalCreateBinding,
    records: readonly OriginalCreateRecord[],
    databaseId: string,
  ): IntegrationStorageOriginalCreateEvidence => {
    if (
      records.length !== 4 ||
      records.some((record, index) => record.stage !== ORIGINAL_STAGES[index]) ||
      records[1]?.evidence.databaseId !== databaseId
    ) {
      throw mutationError(
        "original integration proof lacks sole original create/import/R2 dispatch chain",
      );
    }
    const digests = records.map((record) => record.digest);
    return {
      kind:
        binding.authority === "provider-native"
          ? "takoserver.integration-fresh-0092-original-create@v1"
          : "takoserver.integration-fresh-0092-component-result@v1",
      authority: binding.authority,
      qualification:
        binding.authority === "provider-native"
          ? "independent-origin-review-required"
          : "component-simulation-only",
      commandPort: binding.commandPort,
      namespace: "integration-ts",
      generation,
      accountId,
      databaseName: names.databaseName,
      databaseId,
      bucketName: names.bucketName,
      sourceCommit,
      migrationDigest: binding.migrationDigest,
      migrationImportDigest: binding.importDigest,
      schemaShapeDigest: String(records[3]?.evidence.schemaShapeDigest),
      createDispatchDigest: String(digests[0]),
      identifiedDigest: String(digests[1]),
      importDispatchDigest: String(digests[2]),
      r2DispatchDigest: String(digests[3]),
      originalBindingDigest: originalDigest(binding),
      d1IdentityReadbackDigest: originalDigest({ name: names.databaseName, uuid: databaseId }),
      r2IdentityReadbackDigest: originalDigest({ name: names.bucketName }),
      freshDataPolicyDigest: String(records[3]?.evidence.freshDataPolicyDigest),
    };
  };
  const write = (
    stage: OriginalCreateStage | "unknown",
    binding: OriginalCreateBinding,
    evidence: Readonly<Record<string, unknown>>,
  ): OriginalCreateRecord => {
    const prior = read();
    if (
      stage === "unknown"
        ? prior.length === 0 || ["terminal", "unknown"].includes(prior.at(-1)?.stage ?? "")
        : prior.length !== ORIGINAL_STAGES.indexOf(stage)
    ) {
      throw mutationError(
        "original integration attempt already exists or lacks its sole predecessor; do not retry",
      );
    }
    parseBinding(binding);
    const body = {
      kind: "takoserver.integration-fresh-0092-create-custody@v1" as const,
      stage,
      binding,
      previousDigest: prior.at(-1)?.digest ?? null,
      evidence,
    };
    const record = { ...body, digest: originalDigest(body) };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.byteLength > ORIGINAL_RECORD_LIMIT)
      throw mutationError("original integration record exceeds its bound");
    let fd = -1;
    let directory = -1;
    try {
      directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const current = fstatSync(directory, { bigint: true });
      if (current.dev !== identity.device || current.ino !== identity.inode)
        throw new Error("replaced root");
      fd = openSync(
        path(stage),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(fd, 0o600);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const size = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (size < 1) throw new Error("short write");
        offset += size;
      }
      fsyncSync(fd);
      fsyncSync(directory);
      assertContinuity();
    } catch {
      throw mutationError(
        "original integration dispatch could not be durably retained; preserve UNKNOWN and do not retry",
      );
    } finally {
      if (fd >= 0) closeSync(fd);
      if (directory >= 0) closeSync(directory);
    }
    read();
    return record;
  };
  return {
    artifactRoot,
    assertUnchanged() {
      read();
    },
    assertUnused() {
      if (read().length > 0 || lstatSync(artifactRoot, { throwIfNoEntry: false }) !== undefined) {
        throw mutationError(
          "original integration generation has prior or uncertain custody; do not retry or adopt",
        );
      }
    },
    binding(source, migrationImport, expectedShape, reviewer) {
      if (source.digest !== ORIGINAL_SOURCE_0092 || source.names.length !== 92)
        throw preflightError("original creation requires only the fixed audited0092 source");
      expectedBinding = Object.freeze({
        kind: "takoserver.integration-fresh-0092-create-binding@v1",
        environment: "integration",
        namespace: "integration-ts",
        accountId,
        generation,
        databaseName: names.databaseName,
        bucketName: names.bucketName,
        selectedTargetDigest: originalDigest(selectedTarget()),
        custodyRootIdentityDigest,
        sourceCommit,
        migrationDigest: source.digest,
        migrationBytes: source.bytes,
        importDigest: migrationImport.digest,
        importBytes: migrationImport.bytes,
        applicationShapeDigest: `sha256:${createHash("sha256").update(expectedShape).digest("hex")}`,
        reviewer,
        authority,
        commandPort,
      });
      return expectedBinding;
    },
    append: write,
    evidence(binding, databaseId) {
      return makeEvidence(binding, read(), databaseId);
    },
    retainUnknown(binding, databaseId) {
      try {
        if (read().length > 0)
          write("unknown", binding, { databaseId, reason: "original-create-incomplete" });
      } catch {
        /* retained dispatch/partial bytes are already UNKNOWN; never remove or overwrite them */
      }
    },
    readTerminal() {
      const records = read();
      const terminal = records.at(-1);
      const binding = records[0]?.binding;
      const databaseId = records[1]?.evidence.databaseId;
      if (
        records.length !== ORIGINAL_STAGES.length ||
        terminal?.stage !== "terminal" ||
        binding === undefined ||
        typeof databaseId !== "string" ||
        binding.selectedTargetDigest !== originalDigest(selectedTarget()) ||
        databaseId === target.d1.databaseId ||
        records[1]?.evidence.createResponseDigest !==
          originalDigest({ name: names.databaseName, uuid: databaseId }) ||
        records[1]?.evidence.identityReadbackDigest !==
          originalDigest({ name: names.databaseName, uuid: databaseId })
      ) {
        throw preflightError(
          "original creation requires its terminal chain and exact original tuple/ACK",
        );
      }
      return {
        originalCreate: {
          ...makeEvidence(binding, records.slice(0, -1), databaseId),
          terminalCustodyDigest: terminal.digest,
        },
        originalSelectedTargetDigest: binding.selectedTargetDigest,
        custodyRootIdentityDigest: binding.custodyRootIdentityDigest,
      };
    },
    status() {
      const records = read();
      const last = records.at(-1);
      return {
        state:
          last?.stage === "terminal"
            ? "terminal"
            : last !== undefined || lstatSync(artifactRoot, { throwIfNoEntry: false }) !== undefined
              ? "unknown"
              : "absent",
        qualification: "diagnostic-only",
        lastStage: last?.stage ?? null,
        terminalCustodyDigest: last?.stage === "terminal" ? last.digest : null,
      };
    },
  };
}

interface StorageNames {
  readonly databaseName: string;
  readonly bucketName: string;
  /** Whether the selected target already names this generation's D1 / R2. */
  readonly selectedByTarget: { readonly d1: boolean; readonly r2: boolean };
}

/** Own the complete input data before validation, callbacks or the first await. */
function snapshotStorageContext<T>(context: T): T {
  try {
    return structuredClone(context);
  } catch {
    throw preflightError("integration storage requires cloneable invocation and target data");
  }
}

interface GeneratedStorageTarget {
  readonly generation: string;
  readonly namespace?: IntegrationStorageGenerationNamespace;
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly bucketName: string;
}

function generatedStorageTarget(
  target: DeployTarget,
  environment: DeployEnvironment,
): GeneratedStorageTarget {
  if (environment !== "integration" || target.environment !== environment) {
    throw preflightError("generated storage target verification is integration-only");
  }
  if (!ACCOUNT_ID.test(target.accountId)) {
    throw preflightError("generated storage target verification requires one exact account id");
  }
  const databaseName = target.d1.databaseName;
  const bucketName = target.r2.bucketName;
  const generated = /^(?:integration-takoserver-|takoserver-i-)([0-9a-f]{32})$/u.exec(databaseName);
  const prefixed = PREFIXED_D1_NAME.exec(databaseName);
  if (prefixed !== null && target.takoformV2?.storageLineage !== "v2-0092") {
    throw preflightError("integration-ts readback requires its explicit fresh v2-0092 origin");
  }
  const stagingPair =
    generated === null &&
    target.takoformV2?.storageLineage !== undefined &&
    STAGING_ONLY_LINEAGES.has(target.takoformV2.storageLineage) &&
    STAGING_PAIR_NAME.test(databaseName) &&
    !PRODUCTION_D1_NAME.test(databaseName);
  if (
    (generated === null && prefixed === null && !stagingPair) ||
    bucketName !== databaseName ||
    !UUID.test(target.d1.databaseId)
  ) {
    throw preflightError(
      "integration target must select one exact matching generated D1/R2 storage pair",
    );
  }
  return {
    // A staging pair has no generation; its exact name is its identity.
    generation: generated?.[1] ?? prefixed?.[1] ?? databaseName,
    ...(prefixed === null ? {} : { namespace: "integration-ts" as const }),
    accountId: target.accountId,
    databaseName,
    databaseId: target.d1.databaseId,
    bucketName,
  };
}

/** Whether the target names an operator-provisioned staging pair rather than a generated one. */
export function isOperatorStagingPair(target: Pick<DeployTarget, "d1">): boolean {
  return STAGING_PAIR_NAME.test(target.d1.databaseName);
}

/**
 * A staging pair has no creation record proving it was empty; first
 * publication proves that, a storage rebind does not. So a staging pair enters
 * service only through first publication, never by rebinding a running Host.
 */
export function assertStorageRebindNotOperatorStagingPair(
  target: Pick<DeployTarget, "d1">,
  storageRebind: unknown,
): void {
  if (storageRebind !== undefined && isOperatorStagingPair(target)) {
    throw preflightError(
      "storage rebind refuses an operator-provisioned staging pair; it enters service only " +
        "through first publication, which proves it empty",
    );
  }
}

/** Purely identifies whether a selected environment target is this surface's generated pair. */
export function isGeneratedIntegrationStorageTarget(
  target: DeployTarget,
  environment: DeployEnvironment,
): boolean {
  try {
    generatedStorageTarget(target, environment);
    return true;
  } catch {
    return false;
  }
}

function validateInvocation(
  invocation: IntegrationStorageGenerationInvocation,
  target: DeployTarget,
): StorageNames {
  if (invocation.action !== "status" && invocation.action !== "apply") {
    throw preflightError("integration storage generation requires --status or --apply");
  }
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("integration storage generation is integration-only");
  }
  if (invocation.environment !== target.environment) {
    throw preflightError("integration storage generation and target environments differ");
  }
  if (!COMMIT.test(invocation.commit)) {
    throw preflightError(
      "integration storage generation requires one exact lowercase 40-hex commit",
    );
  }
  if (!GENERATION.test(invocation.generation)) {
    throw preflightError("--generation must be exactly 32 lowercase hexadecimal characters");
  }
  if (
    invocation.freshLineage !== undefined &&
    !isIntegrationFreshLineage(invocation.freshLineage)
  ) {
    throw preflightError("unsupported fresh integration migration lineage");
  }
  if (!ACCOUNT_ID.test(target.accountId)) {
    throw preflightError("integration storage generation requires one exact account id");
  }
  const freshName = integrationStorageGenerationName(invocation.generation, invocation.namespace);
  const legacyName = `takoserver-i-${invocation.generation}`;
  const legacyD1 = target.d1.databaseName === legacyName;
  const legacyR2 = target.r2.bucketName === legacyName;
  if (legacyD1 || legacyR2) {
    if (invocation.action === "apply") {
      throw preflightError("legacy integration storage is read-only; create a new generation");
    }
    if (!legacyD1 || !legacyR2 || invocation.namespace !== undefined) {
      throw preflightError("legacy integration status requires the exact matching pair");
    }
  }
  const databaseName = legacyD1 && legacyR2 ? legacyName : freshName;
  const bucketName = databaseName;
  if (!RESOURCE_NAME.test(databaseName) || !RESOURCE_NAME.test(bucketName)) {
    throw preflightError("integration storage generation derived an invalid provider name");
  }
  const selectedByTarget = {
    d1: target.d1.databaseName === databaseName,
    r2: target.r2.bucketName === bucketName,
  };
  // Apply creates a new pair and must never create into, or adopt, storage the
  // selected target already names. Status only reads the generated names; it
  // must keep diagnosing the pair after the operator points the target at it.
  if (invocation.action === "apply" && (selectedByTarget.d1 || selectedByTarget.r2)) {
    throw preflightError(
      "integration storage generation name collides with the selected target; " +
        "current storage is never adopted",
    );
  }
  return { databaseName, bucketName, selectedByTarget };
}

/** Creation names require either the default namespace or the original custody owner. */
function assertFreshGenerationNames(
  names: StorageNames,
  original: OriginalCreateContext | null,
): void {
  if (original !== null) original.assertUnchanged();
  const permitted =
    original === null
      ? FRESH_GENERATED_NAME.test(names.databaseName)
      : PREFIXED_D1_NAME.test(names.databaseName);
  if (!permitted || names.bucketName !== names.databaseName) {
    throw preflightError("new integration storage requires one exact integration-prefixed pair");
  }
}

async function statusStorageGeneration(
  invocation: IntegrationStorageGenerationInvocation,
  target: DeployTarget,
  names: StorageNames,
  provider: ProviderContext,
  options: IntegrationStorageGenerationOptions,
  original: OriginalCreateContext | null,
): Promise<Record<string, unknown>> {
  original?.assertUnchanged();
  const sourceArtifact =
    invocation.freshLineage === undefined
      ? null
      : selectedSourceArtifact(
          options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
          invocation.freshLineage,
        );
  const inventory = await readInventory(provider.provider, names, "preflight");
  const d1 = inventory.d1[0] ?? null;
  const r2 = inventory.r2[0] ?? null;
  const presence =
    d1 === null && r2 === null
      ? "absent"
      : d1 !== null && r2 === null
        ? "d1-only"
        : d1 === null
          ? "r2-only"
          : "both";
  const result: Record<string, unknown> = {
    kind: "takoserver.integration-storage-generation-status@v1",
    surface: "takoserver-integration-storage-generation",
    environment: "integration",
    selectedCommit: invocation.commit,
    generation: invocation.generation,
    ...(original === null ? {} : { namespace: "integration-ts" }),
    d1: {
      databaseName: names.databaseName,
      databaseId: d1?.uuid ?? null,
      present: d1 !== null,
    },
    r2: {
      bucketName: names.bucketName,
      present: r2 !== null,
    },
    presence,
    // The selected target can retain an exact legacy pair for read-only
    // diagnosis. It never widens or adopts either generation's inventory.
    targetSelection: {
      d1: names.selectedByTarget.d1,
      r2: names.selectedByTarget.r2,
      databaseIdExact: names.selectedByTarget.d1
        ? d1 !== null && target.d1.databaseId === d1.uuid
        : null,
    },
    readyForApply:
      d1 === null && r2 === null && !names.selectedByTarget.d1 && !names.selectedByTarget.r2,
    ...(original === null
      ? { productionD1Guard: productionD1GuardRecord(options.productionD1) }
      : { originalCreateCustody: original.status() }),
    rollback: "old active target remains unchanged; repair forward from any known aftermath",
  };
  if (original !== null) {
    original.assertUnchanged();
    // Complete native state is diagnosis only: status never finishes or issues original custody.
    result.readyForApply = result.readyForApply === true && original.status().state === "absent";
  }
  if (invocation.freshLineage === undefined) return result;
  result.freshLineage = invocation.freshLineage;
  result.migrationDigest = sourceArtifact?.digest;
  // This is diagnosis, not adoption: an earlier failed apply must be correlated
  // with this exact name and UUID by the operator. No status path imports SQL.
  if (d1 === null) return result;
  if (sourceArtifact === null) throw preflightError("fresh v2 status source is unavailable");
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-v2-d1-status-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const configPath = join(root, "read-wrangler.jsonc");
  try {
    if (existsSync(configPath)) {
      throw preflightError("v2 D1 status output directory is already in use");
    }
    const identity = await providerCall("preflight", "v2 D1 status identity readback failed", () =>
      provider.provider.getD1(d1.uuid),
    );
    if (identity.uuid !== d1.uuid || identity.name !== names.databaseName) {
      throw preflightError("v2 D1 status identity changed during readback");
    }
    writeGenerationConfig(configPath, target.accountId, names.databaseName, d1.uuid);
    const state = await readGeneratedState(
      "preflight",
      configPath,
      { accountId: target.accountId, databaseName: names.databaseName, databaseId: d1.uuid },
      provider.environment,
      options.run ?? runCommand,
      options,
    );
    const expectedShape = deriveExpectedApplicationShape(sourceArtifact.files);
    let complete = false;
    try {
      assertCompleteDatabase(
        state,
        sourceArtifact.names,
        sourceArtifact.digest,
        expectedShape,
        d1.uuid,
        "preflight",
      );
      complete = true;
    } catch {
      // An exact-name D1 may be partially imported or foreign. It is never
      // promoted, reset or retried merely because its name matches.
    }
    result.schemaReadback = complete
      ? `complete-${lineageCeiling(invocation.freshLineage)}`
      : "incomplete-or-divergent";
    const freshV2 = freshV2D1Lineage(invocation.freshLineage);
    let dataEmpty: boolean | null = null;
    if (complete && freshV2 !== null) {
      try {
        await assertFreshV2DataReadback(
          "preflight",
          freshV2,
          configPath,
          provider.environment,
          expectedShape,
          { ...options, run: options.run ?? runCommand },
        );
        dataEmpty = true;
      } catch {
        // A complete schema with application rows is a generation a Host (or
        // the signing registration) has already written, not a broken import.
        dataEmpty = false;
      }
      result.dataReadback = dataEmpty ? "empty-seeded" : "present";
    }
    original?.assertUnchanged();
    result.resume = !complete
      ? "Quarantine this generation and plan separate owner-reviewed forward repair; no SQL re-import or new generation retry."
      : dataEmpty === false
        ? "Complete schema with application data: this generation is in use. Keep it as the selected target; it is no longer a fresh candidate. No SQL re-import."
        : "Correlate the exact prior apply identity; separately review any missing R2 and target binding. No SQL re-import.";
    return result;
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

function selectedSourceArtifact(
  directory: string,
  lineage: "apply-0066" | IntegrationFreshLineage | "applied-v2-0092",
): ReturnType<typeof readCurrentAuditedMigrationSourceArtifact> {
  const source = readCurrentAuditedMigrationSourceArtifact(directory);
  switch (lineage) {
    case "apply-0066":
      return projectApplyQualifiedMigrationArtifact(source);
    case "v2-artifacts-0075":
      return projectFreshV2ArtifactMigrationArtifact(source);
    case "v2-0088":
      return projectFreshProductionV2MigrationArtifact(source);
    case "v2-0089":
      return projectFreshProductionV2MigrationArtifact0089(source);
    case "v2-0091":
      return projectFreshIntegrationV2MigrationArtifact0091(source);
    case "v2-0092":
      return projectFreshIntegrationV2MigrationArtifact0092(source);
    case "applied-v2-0092":
      return projectCanonicalIntegrationV2MigrationArtifact0092(source);
  }
}

function readSealedSelectedArtifact(
  directory: string,
  lineage: IntegrationFreshLineage | undefined,
): ReturnType<typeof readCurrentAuditedMigrationSourceArtifact> {
  switch (lineage) {
    case undefined:
      return readSealedApplyQualifiedMigrationArtifact(directory);
    case "v2-artifacts-0075":
      return readSealedFreshV2ArtifactMigrationArtifact(directory);
    case "v2-0088":
      return readSealedFreshProductionV2MigrationArtifact(directory);
    case "v2-0089":
      return readSealedFreshProductionV2MigrationArtifact0089(directory);
    case "v2-0091":
      return readSealedFreshIntegrationV2MigrationArtifact0091(directory);
    case "v2-0092":
      return readSealedFreshIntegrationV2MigrationArtifact0092(directory);
  }
}

function freshV2D1Lineage(lineage: IntegrationFreshLineage | undefined): FreshV2D1Lineage | null {
  return lineage === "v2-0088" ||
    lineage === "v2-0089" ||
    lineage === "v2-0091" ||
    lineage === "v2-0092"
    ? lineage
    : null;
}

function lineageCeiling(
  lineage: IntegrationFreshLineage | undefined,
): "0066" | "0075" | "0088" | "0089" | "0091" | "0092" {
  switch (lineage) {
    case undefined:
      return "0066";
    case "v2-artifacts-0075":
      return "0075";
    case "v2-0088":
      return "0088";
    case "v2-0089":
      return "0089";
    case "v2-0091":
      return "0091";
    case "v2-0092":
      return "0092";
  }
}

/** What the production guard compared, recorded in every status and apply output. */
function productionD1GuardRecord(
  production: ProductionD1Identity | undefined,
): Record<string, unknown> {
  return production === undefined
    ? { compared: "naming-only" }
    : {
        compared: "naming-and-production-target",
        productionDatabaseName: production.databaseName,
        productionDatabaseId: production.databaseId,
      };
}

interface ProviderContext {
  readonly provider: IntegrationStorageGenerationProvider;
  readonly environment: Readonly<Record<string, string>>;
}

async function resolveProvider(
  target: DeployTarget,
  options: IntegrationStorageGenerationOptions,
): Promise<ProviderContext> {
  if (options.provider !== undefined) {
    return {
      provider: options.provider,
      environment: options.cloudflareEnvironment ?? {},
    };
  }
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("integration", {
    cloudflareEnvironment: options.cloudflareEnvironment,
    run,
  });
  return {
    provider: new CloudflareIntegrationStorageProvider(target.accountId, credential.token, {
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    }),
    environment: credential.childEnvironment,
  };
}

async function resolveTargetReadProvider(
  target: DeployTarget,
  environment: DeployEnvironment,
  options: IntegrationStorageGenerationTargetVerificationOptions,
): Promise<{
  readonly provider: IntegrationStorageTargetReadProvider;
  readonly environment: Readonly<Record<string, string>>;
}> {
  if (options.provider !== undefined) {
    return {
      provider: options.provider,
      environment: options.cloudflareEnvironment ?? {},
    };
  }
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential(environment, {
    cloudflareEnvironment: options.cloudflareEnvironment,
    run,
    ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
  });
  return {
    provider: new CloudflareIntegrationStorageProvider(target.accountId, credential.token, {
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    }),
    environment: credential.childEnvironment,
  };
}

async function applyStorageGeneration(
  invocation: IntegrationStorageGenerationInvocation,
  target: DeployTarget,
  names: StorageNames,
  options: IntegrationStorageGenerationOptions,
  original: OriginalCreateContext | null,
): Promise<Record<string, unknown>> {
  original?.assertUnused();
  const run = options.run ?? runCommand;
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  await qualifySource({ environment: "integration", commit: invocation.commit, run });

  const sourceArtifact = selectedSourceArtifact(
    options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
    invocation.freshLineage ?? "apply-0066",
  );
  await checkedMigrationGate(run);
  const expectedApplicationShape = deriveExpectedApplicationShape(sourceArtifact.files);

  original?.assertUnchanged();
  const temporary = original === null && options.outputDirectory === undefined;
  const root =
    original?.artifactRoot ??
    options.outputDirectory ??
    mkdtempSync(join(tmpdir(), "takoserver-integration-storage-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = join(root, "release");
  if (existsSync(release)) {
    throw preflightError("integration storage generation output directory is already in use");
  }
  const payload = join(release, "payload");
  const migrationOutput = join(payload, "migrations");
  mkdirSync(migrationOutput, { recursive: true, mode: 0o700 });
  let sealed: ReturnType<typeof sealDirectory> | null = null;
  let migrationSeal: ReturnType<typeof sealDirectory> | null = null;
  let mutationStarted = false;
  let knownDatabaseId: string | null = null;
  let result: Record<string, unknown> | undefined;
  let operationFailed = false;
  let operationFailure: unknown;
  let originalBinding: OriginalCreateBinding | null = null;
  let originalEvidence: IntegrationStorageOriginalCreateEvidence | null = null;
  try {
    for (const file of sourceArtifact.files) {
      copyFileSync(file.path, join(migrationOutput, file.name));
    }
    const sealedArtifact = readSealedSelectedArtifact(migrationOutput, invocation.freshLineage);
    if (
      sealedArtifact.digest !== sourceArtifact.digest ||
      JSON.stringify(sealedArtifact.names) !== JSON.stringify(sourceArtifact.names)
    ) {
      throw preflightError(
        "sealed integration migration lineage differs from the qualified source",
      );
    }
    // D1's /query parser truncates the nested CASE in the frozen 0047 trigger.
    // Its /import transport accepts those exact bytes; do not rewrite history
    // or change the canonical schema to work around a transport parser.
    const migrationImport = buildD1MigrationImport(sealedArtifact.files, { freshLedger: true });
    const importPath = join(payload, "migration-import.sql");
    writeFileSync(importPath, migrationImport.sql, { mode: 0o600, flag: "wx" });
    migrationSeal = sealDirectory(payload, [
      "migration-import.sql",
      ...sourceArtifact.names.map((name) => `migrations/${name}`),
    ]);
    const configPath = join(release, "wrangler.jsonc");

    if (original !== null) {
      originalBinding = original.binding(
        sourceArtifact,
        migrationImport,
        expectedApplicationShape,
        reviewer,
      );
    }
    const provider = await resolveProvider(target, options);
    original?.assertUnchanged();
    const initial = await readInventory(provider.provider, names, "preflight");
    original?.assertUnchanged();
    assertAbsent(initial, "initial integration storage name inventory");
    const fenced = await readInventory(provider.provider, names, "preflight");
    assertAbsent(fenced, "immediate precreate integration storage absence fence");
    original?.assertUnchanged();
    migrationSeal.assertUnchanged();
    if (original !== null && originalBinding !== null) {
      syncOriginalArtifact(original.artifactRoot);
      original.append("create-dispatched", originalBinding, {});
      original.assertUnchanged();
      migrationSeal.assertUnchanged();
    }
    assertFreshGenerationNames(names, original);

    // Set this before entering the provider boundary: a lost acknowledgement
    // can mean Cloudflare created the database even when no identity returned.
    mutationStarted = true;
    const created = await providerCall("mutation", "new D1 create failed; do not retry", () =>
      provider.provider.createD1(names.databaseName),
    );
    const databaseId = validateCreatedD1(created, names.databaseName);
    const originalCreateResponse = { name: names.databaseName, uuid: databaseId };
    knownDatabaseId = databaseId;
    original?.assertUnchanged();
    if (original !== null && databaseId === target.d1.databaseId) {
      throw mutationError(
        "original creation returned the selected incumbent D1 identity; retain UNKNOWN",
      );
    }
    const createdReadback = await providerCall(
      "mutation",
      "new D1 identity readback failed; do not retry",
      () => provider.provider.getD1(databaseId),
    );
    if (createdReadback.uuid !== databaseId || createdReadback.name !== names.databaseName) {
      throw mutationError(
        "new D1 identity readback did not match the exact generated name and id",
        `databaseId=${databaseId}`,
      );
    }
    original?.assertUnchanged();
    if (original !== null && originalBinding !== null) {
      original.append("identified", originalBinding, {
        databaseId,
        createResponseDigest: originalDigest(originalCreateResponse),
        identityReadbackDigest: originalDigest({
          name: createdReadback.name,
          uuid: createdReadback.uuid,
        }),
      });
    } else {
      // Preserve the historical exact-production comparison before any SQL.
      assertStagingD1NotProduction(
        { databaseName: createdReadback.name, databaseId },
        options.productionD1,
        "mutation",
      );
    }

    const generatedTarget = {
      accountId: target.accountId,
      databaseName: names.databaseName,
      databaseId,
    };
    // The config is written only once the provider identity is known. The
    // migration directory has stayed sealed across the create/read fence.
    writeGenerationConfig(
      configPath,
      generatedTarget.accountId,
      generatedTarget.databaseName,
      generatedTarget.databaseId,
    );
    sealed = sealDirectory(release, [
      "wrangler.jsonc",
      "payload/migration-import.sql",
      ...sourceArtifact.names.map((name) => `payload/migrations/${name}`),
    ]);
    sealed.assertUnchanged();

    let preMigration: D1SchemaState;
    try {
      preMigration = await readGeneratedState(
        "mutation",
        configPath,
        generatedTarget,
        provider.environment,
        run,
        options,
      );
    } catch {
      throw mutationError(
        "new D1 empty readback failed; migration is withheld",
        `databaseId=${databaseId}`,
      );
    }
    assertEmptyDatabase(preMigration, databaseId);
    original?.assertUnchanged();
    if (original !== null && originalBinding !== null) {
      original.append("import-dispatched", originalBinding, {
        databaseId,
        emptySchemaDigest: preMigration.shapeDigest,
      });
      original.assertUnchanged();
    }

    const migration = await applySealedMigrations(
      configPath,
      names.databaseName,
      importPath,
      generatedTarget,
      provider.environment,
      run,
      options,
      sealed,
      sourceArtifact.names,
    );
    const postMigration = migration.state;
    original?.assertUnchanged();
    assertCompleteDatabase(
      postMigration,
      sourceArtifact.names,
      sourceArtifact.digest,
      expectedApplicationShape,
      databaseId,
    );
    const freshV2 = freshV2D1Lineage(invocation.freshLineage);
    if (freshV2 !== null) {
      // The fresh v2 profiles also prove the exact empty seeded data before R2
      // creation, the same independent readback the production profile uses.
      await assertFreshV2DataReadback(
        "verification",
        freshV2,
        configPath,
        provider.environment,
        expectedApplicationShape,
        { ...options, run },
      );
    }

    original?.assertUnchanged();
    const finalD1 = await providerCall(
      "verification",
      "new D1 final identity readback failed",
      () => provider.provider.getD1(databaseId),
    );
    if (finalD1.uuid !== databaseId || finalD1.name !== names.databaseName) {
      throw verificationError(
        "new D1 final identity readback did not match the exact generated name and id",
        `databaseId=${databaseId}`,
      );
    }

    const r2Fence = await readR2Presence(provider.provider, names.bucketName, "mutation");
    if (r2Fence.length > 0) {
      throw mutationError(
        "R2 generated name appeared before its post-migration create fence; do not adopt it",
        `databaseId=${databaseId} bucketName=${names.bucketName}`,
      );
    }
    original?.assertUnchanged();
    sealed.assertUnchanged();
    if (original !== null && originalBinding !== null) {
      original.append("r2-dispatched", originalBinding, {
        databaseId,
        schemaShapeDigest: postMigration.shapeDigest,
        appliedMigrationsDigest: originalDigest(postMigration.applied),
        freshDataPolicyDigest: originalDigest({
          lineage: "v2-0092",
          schema: expectedApplicationShape,
          policy: "empty-seeded@v1",
        }),
      });
      original.assertUnchanged();
      sealed.assertUnchanged();
    }
    assertFreshGenerationNames(names, original);
    const createdBucket = await providerCall("mutation", "new R2 create failed; do not retry", () =>
      provider.provider.createR2(names.bucketName),
    );
    validateCreatedR2(createdBucket, names.bucketName, databaseId);
    const bucketReadback = await providerCall(
      "verification",
      "new R2 identity readback failed",
      () => provider.provider.getR2(names.bucketName),
    );
    if (bucketReadback.name !== names.bucketName) {
      throw verificationError(
        "new R2 identity readback did not match the exact generated name",
        `databaseId=${databaseId} bucketName=${names.bucketName}`,
      );
    }

    original?.assertUnchanged();
    if (original !== null && originalBinding !== null) {
      originalEvidence = original.evidence(originalBinding, databaseId);
    }
    result = {
      kind: "takoserver.integration-storage-generation-apply@v1",
      surface: "takoserver-integration-storage-generation",
      environment: "integration",
      commit: invocation.commit,
      reviewer,
      generation: invocation.generation,
      ...(original === null ? {} : { namespace: "integration-ts" }),
      ...(invocation.freshLineage === undefined ? {} : { freshLineage: invocation.freshLineage }),
      d1: {
        databaseName: names.databaseName,
        databaseId,
      },
      r2: { bucketName: names.bucketName },
      ...(original === null
        ? { productionD1Guard: productionD1GuardRecord(options.productionD1) }
        : {}),
      migrationDigest: sourceArtifact.digest,
      migrationBytes: sourceArtifact.bytes,
      migrationImportDigest: migrationImport.digest,
      migrationImportBytes: migrationImport.bytes,
      appliedMigrations: postMigration.applied,
      schemaShapeDigest: postMigration.shapeDigest,
      rollback: "old active target remains unchanged; repair forward from this exact generation",
    };
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
    // A crash has the same semantics even if this best-effort UNKNOWN append cannot finish.
    if (originalBinding !== null) original?.retainUnknown(originalBinding, knownDatabaseId);
  }

  let cleanupFailed = false;
  let cleanupFailure: unknown;
  try {
    if (original === null) {
      if (sealed !== null) unsealDirectory(sealed.root);
      else if (migrationSeal !== null) unsealDirectory(migrationSeal.root);
      if (temporary) rmSync(root, { recursive: true, force: true });
    }
    // The new path retains the original sealed artifact outside Git, including UNKNOWN.
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }

  // Cleanup is deliberately outside a finally block: an unwinding cleanup
  // error must never replace the operation's original bounded failure.
  if (operationFailed) {
    if (!mutationStarted) throw operationFailure;
    throw normalizeAfterD1Create(
      operationFailure,
      knownDatabaseId,
      invocation,
      sourceArtifact.digest,
    );
  }
  if (cleanupFailed) {
    if (mutationStarted) {
      throw normalizeAfterD1Create(
        cleanupFailure,
        knownDatabaseId,
        invocation,
        sourceArtifact.digest,
      );
    }
    throw cleanupFailure;
  }
  if (result === undefined) {
    throw preflightError("integration storage generation produced no result");
  }
  if (original !== null && originalBinding !== null && originalEvidence !== null) {
    original.assertUnchanged();
    sealed?.assertUnchanged();
    syncOriginalArtifact(original.artifactRoot);
    const terminal = original.append("terminal", originalBinding, {
      databaseId: knownDatabaseId,
      proof: originalEvidence,
    });
    result.originalCreate = { ...originalEvidence, terminalCustodyDigest: terminal.digest };
  }
  return result;
}

export async function checkedMigrationGate(
  run: IntegrationStorageGenerationProcess,
): Promise<void> {
  const result = await run(["bun", "run", "check:migrations"]);
  if (result.exitCode !== 0) {
    throw preflightError("scoped migration gate `bun run check:migrations` failed");
  }
}

export interface GeneratedD1Target {
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
}

export async function applySealedMigrations(
  configPath: string,
  databaseName: string,
  importPath: string,
  target: GeneratedD1Target,
  environment: Readonly<Record<string, string>>,
  run: IntegrationStorageGenerationProcess,
  options: IntegrationStorageGeneratedStateOptions,
  sealed: ReturnType<typeof sealDirectory>,
  expectedMigrations: readonly string[],
): Promise<{ readonly state: D1SchemaState }> {
  sealed.assertUnchanged();
  let result: CommandResult;
  try {
    result = await run(
      (options.wranglerCommand ?? wranglerCommand)([
        "d1",
        "execute",
        databaseName,
        "--remote",
        "--yes",
        "--config",
        configPath,
        "--file",
        importPath,
      ]),
      { env: environment },
    );
  } catch {
    throw migrationFailureError(
      "D1 migration apply acknowledgement is indeterminate; inspect this exact generation " +
        "and do not retry",
      null,
      null,
      expectedMigrations,
    );
  }
  if (result.exitCode !== 0) {
    let aftermath: D1SchemaState | null = null;
    try {
      aftermath = await readGeneratedState(
        "mutation",
        configPath,
        target,
        environment,
        run,
        options,
      );
    } catch {
      // A failed readback is itself indeterminate. Do not turn it into a
      // second migration attempt or infer a new database from the name.
    }
    throw migrationFailureError(
      "D1 migration apply failed; partial or lost acknowledgement is not retried or adopted",
      result.exitCode,
      aftermath?.applied ?? null,
      expectedMigrations,
    );
  }
  const state = await readGeneratedState(
    "verification",
    configPath,
    target,
    environment,
    run,
    options,
  ).catch(() => {
    throw verificationError(
      "D1 migration post-readback failed; R2 creation is withheld",
      `databaseId=${target.databaseId}`,
    );
  });
  return { state };
}

export async function readGeneratedState(
  phase: DeployPhase,
  configPath: string,
  target: GeneratedD1Target,
  environment: Readonly<Record<string, string>>,
  run: IntegrationStorageGenerationProcess,
  options: IntegrationStorageGeneratedStateOptions,
): Promise<D1SchemaState> {
  if (options.readD1State !== undefined) {
    return await options.readD1State(phase, {
      configPath,
      databaseName: target.databaseName,
      databaseId: target.databaseId,
      environment,
      run,
    });
  }
  if (options.reader !== undefined) return await options.reader.read(phase);
  return await readD1SchemaState(
    new RemoteD1(configPath, {
      environment,
      run,
      wranglerCommand: generatedStateWranglerCommand(options),
    }),
    phase,
  );
}

function generatedStateWranglerCommand(
  options: IntegrationStorageGeneratedStateOptions,
): (args: readonly string[]) => readonly string[] {
  if (options.wranglerCommand !== undefined) return options.wranglerCommand;
  const wranglerPath = options.wranglerPath;
  return wranglerPath === undefined ? wranglerCommand : (args) => [wranglerPath, ...args];
}

export function assertEmptyDatabase(state: D1SchemaState, databaseId: string): void {
  let applicationShape: string;
  try {
    applicationShape = canonicalApplicationShape(state);
  } catch {
    throw mutationError(
      "new D1 empty readback is not a canonical schema shape; migration is withheld",
      `databaseId=${databaseId}`,
    );
  }
  if (state.applied.length !== 0 || applicationShape !== "[]\n") {
    throw mutationError(
      "new D1 is not exactly empty; migration is withheld",
      JSON.stringify({
        databaseId,
        appliedMigrations: state.applied,
        schemaShapeDigest: state.shapeDigest,
      }),
    );
  }
  if (!SHA256.test(state.shapeDigest) || state.shapeDigest !== digestShape(state.shape)) {
    throw mutationError(
      "new D1 empty readback has an invalid schema digest",
      `databaseId=${databaseId}`,
    );
  }
}

export function assertCompleteDatabase(
  state: D1SchemaState,
  expectedMigrations: readonly string[],
  migrationDigest: string,
  expectedApplicationShape: string,
  databaseId: string,
  phase: "preflight" | "verification" = "verification",
): void {
  if (JSON.stringify(state.applied) !== JSON.stringify(expectedMigrations)) {
    throw completeDatabaseReadbackError(
      phase,
      `does not contain the exact audited ${expectedMigrations[0]?.slice(0, 4) ?? "unknown"}-${expectedMigrations.at(-1)?.slice(0, 4) ?? "unknown"} lineage`,
      JSON.stringify({ databaseId, expectedMigrations, appliedMigrations: state.applied }),
    );
  }
  if (
    !SHA256.test(migrationDigest) ||
    !SHA256.test(state.shapeDigest) ||
    state.shapeDigest !== digestShape(state.shape)
  ) {
    throw completeDatabaseReadbackError(
      phase,
      "has an invalid canonical schema digest",
      `databaseId=${databaseId}`,
    );
  }
  try {
    canonicalApplicationShape(state);
  } catch {
    throw completeDatabaseReadbackError(
      phase,
      "is not a canonical schema shape",
      `databaseId=${databaseId}`,
    );
  }
  if (!applicationSchemaMatches(state, expectedApplicationShape)) {
    throw completeDatabaseReadbackError(
      phase,
      "differs from the exact audited application schema",
      `databaseId=${databaseId}`,
    );
  }
}

function completeDatabaseReadbackError(
  phase: "preflight" | "verification",
  reason: string,
  detail: string,
): DeployError {
  if (phase === "preflight") {
    return preflightError(`Existing generated D1 schema readback ${reason}`, detail);
  }
  return verificationError(`D1 migration readback ${reason}; R2 creation is withheld`, detail);
}

function digestShape(shape: string): string {
  return `sha256:${createHash("sha256").update(shape).digest("hex")}`;
}

function writeGenerationConfig(
  path: string,
  accountId: string,
  databaseName: string,
  databaseId: string,
): string {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        name: "takoserver-integration-storage-generation",
        account_id: accountId,
        compatibility_date: "2026-08-17",
        d1_databases: [
          {
            binding: "STATE_DB",
            database_name: databaseName,
            database_id: databaseId,
            migrations_dir: "payload/migrations",
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

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

async function providerCall<T>(
  phase: DeployPhase,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new DeployError(phase, message);
  }
}

function migrationFailureError(
  message: string,
  exitCode: number | null,
  appliedMigrations: readonly string[] | null,
  expectedMigrations: readonly string[],
): MigrationApplyError {
  return new MigrationApplyError(message, {
    exitCode: safeExitCode(exitCode),
    appliedMigrations: safeAppliedMigrations(appliedMigrations, expectedMigrations),
    expectedMigrations: expectedMigrations.slice(0, MAX_MIGRATION_DIAGNOSTIC_NAMES),
  });
}

function safeExitCode(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= -128 && value <= 255
    ? value
    : null;
}

function safeAppliedMigrations(
  appliedMigrations: readonly string[] | null,
  expectedMigrations: readonly string[],
): readonly string[] | null {
  if (
    appliedMigrations === null ||
    !Array.isArray(appliedMigrations) ||
    appliedMigrations.length > expectedMigrations.length ||
    appliedMigrations.length > MAX_MIGRATION_DIAGNOSTIC_NAMES ||
    appliedMigrations.some((name) => typeof name !== "string")
  ) {
    return null;
  }
  for (let index = 0; index < appliedMigrations.length; index += 1) {
    if (appliedMigrations[index] !== expectedMigrations[index]) return null;
  }
  return appliedMigrations.slice();
}

function normalizeAfterD1Create(
  error: unknown,
  databaseId: string | null,
  invocation: IntegrationStorageGenerationInvocation,
  migrationDigest: string,
): DeployError {
  const phase: DeployPhase =
    error instanceof DeployError && error.phase === "verification" ? "verification" : "mutation";
  const evidence = error instanceof MigrationApplyError ? error.evidence : undefined;
  const context =
    invocation.freshLineage === undefined
      ? []
      : [
          `generation=${invocation.generation}`,
          `freshLineage=${invocation.freshLineage}`,
          `migrationDigest=${migrationDigest}`,
        ];
  const detail =
    evidence === undefined
      ? [`databaseId=${databaseId ?? "unknown"}`, ...context].join(" ")
      : [
          `databaseId=${databaseId ?? "unknown"}`,
          ...context,
          `phase=${phase}`,
          `exitCode=${evidence.exitCode ?? "unknown"}`,
          `appliedMigrations=${JSON.stringify(evidence.appliedMigrations)}`,
          `expectedMigrations=${JSON.stringify(evidence.expectedMigrations)}`,
        ].join(" ");
  if (error instanceof DeployError) {
    return new DeployError(phase, error.message, detail);
  }
  return new DeployError(
    "mutation",
    "integration storage generation stopped after D1 creation; do not retry or adopt",
    detail,
  );
}

async function readInventory(
  provider: IntegrationStorageGenerationProvider,
  names: StorageNames,
  phase: DeployPhase,
): Promise<{
  readonly d1: readonly IntegrationStorageD1Database[];
  readonly r2: readonly IntegrationStorageR2Bucket[];
}> {
  const d1 = await providerCall(phase, "D1 generated-name inventory failed", () =>
    provider.listD1(names.databaseName),
  );
  const r2 = await providerCall(phase, "R2 generated-name inventory failed", () =>
    provider.listR2(names.bucketName),
  );
  let d1Exact: readonly IntegrationStorageD1Database[];
  let r2Exact: readonly IntegrationStorageR2Bucket[];
  try {
    d1Exact = d1.map((entry) => validateD1Summary(entry, "D1 generated-name inventory"));
    r2Exact = r2.map((entry) => validateR2Summary(entry, "R2 generated-name inventory"));
  } catch {
    throw new DeployError(phase, "generated storage inventory returned a malformed identity");
  }
  const d1Matches = d1Exact.filter((entry) => entry.name === names.databaseName);
  const r2Matches = r2Exact.filter((entry) => entry.name === names.bucketName);
  if (d1Matches.length > 1 || r2Matches.length > 1) {
    throw new DeployError(phase, "generated storage inventory contains duplicate exact names");
  }
  return { d1: d1Matches, r2: r2Matches };
}

async function readR2Presence(
  provider: IntegrationStorageGenerationProvider,
  bucketName: string,
  phase: DeployPhase,
): Promise<readonly IntegrationStorageR2Bucket[]> {
  const entries = await providerCall(phase, "R2 generated-name absence fence failed", () =>
    provider.listR2(bucketName),
  );
  let parsed: readonly IntegrationStorageR2Bucket[];
  try {
    parsed = entries.map((entry) => validateR2Summary(entry, "R2 generated-name inventory"));
  } catch {
    throw new DeployError(phase, "R2 generated-name inventory returned a malformed identity");
  }
  const matches = parsed.filter((entry) => entry.name === bucketName);
  if (matches.length > 1) {
    throw new DeployError(phase, "R2 generated-name inventory contains duplicate exact names");
  }
  return matches;
}

function assertAbsent(
  inventory: {
    readonly d1: readonly IntegrationStorageD1Database[];
    readonly r2: readonly IntegrationStorageR2Bucket[];
  },
  label: string,
): void {
  if (inventory.d1.length !== 0 || inventory.r2.length !== 0) {
    throw preflightError(
      `${label} is not empty; existing storage is never adopted`,
      JSON.stringify({
        d1: inventory.d1.map(({ name, uuid }) => ({ name, uuid })),
        r2: inventory.r2.map(({ name }) => ({ name })),
      }),
    );
  }
}

function validateCreatedD1(value: IntegrationStorageD1Database, expectedName: string): string {
  let parsed: IntegrationStorageD1Database;
  try {
    parsed = validateD1Summary(value, "new D1 create response");
  } catch {
    throw mutationError("new D1 create returned a malformed identity; do not retry or adopt");
  }
  if (parsed.name !== expectedName) {
    throw mutationError(
      "new D1 create returned an unexpected name; do not retry or adopt",
      `databaseId=${parsed.uuid}`,
    );
  }
  return parsed.uuid;
}

function validateCreatedR2(
  value: IntegrationStorageR2Bucket,
  expectedName: string,
  databaseId: string,
): void {
  let parsed: IntegrationStorageR2Bucket;
  try {
    parsed = validateR2Summary(value, "new R2 create response");
  } catch {
    throw mutationError(
      "new R2 create returned a malformed identity; do not retry or adopt",
      `databaseId=${databaseId}`,
    );
  }
  if (parsed.name !== expectedName) {
    throw mutationError(
      "new R2 create returned an unexpected name; do not retry or adopt",
      `databaseId=${databaseId} bucketName=${parsed.name}`,
    );
  }
}

function validateD1Summary(
  value: IntegrationStorageD1Database,
  label: string,
): IntegrationStorageD1Database {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !RESOURCE_NAME.test(value.name) ||
    typeof value.uuid !== "string" ||
    !UUID.test(value.uuid)
  ) {
    throw preflightError(`${label} returned a malformed D1 identity`);
  }
  return { name: value.name, uuid: value.uuid };
}

function validateR2Summary(
  value: IntegrationStorageR2Bucket,
  label: string,
): IntegrationStorageR2Bucket {
  if (!isRecord(value) || typeof value.name !== "string" || !RESOURCE_NAME.test(value.name)) {
    throw preflightError(`${label} returned a malformed R2 identity`);
  }
  return { name: value.name };
}

/** Direct Cloudflare API adapter kept local to this one-way surface. */
export class CloudflareIntegrationStorageProvider implements IntegrationStorageGenerationProvider {
  readonly #accountId: string;
  readonly #token: string;
  readonly #fetcher: IntegrationStorageFetcher;

  constructor(
    accountId: string,
    token: string,
    options: { readonly fetcher?: IntegrationStorageFetcher } = {},
  ) {
    if (!ACCOUNT_ID.test(accountId)) {
      throw preflightError("Cloudflare storage requires one account id");
    }
    if (token.length === 0 || token.trim() !== token) {
      throw preflightError("Cloudflare storage requires one exact API token");
    }
    this.#accountId = accountId;
    this.#token = token;
    this.#fetcher = options.fetcher ?? ((request) => fetch(request));
  }

  async listD1(name: string): Promise<readonly IntegrationStorageD1Database[]> {
    const values: IntegrationStorageD1Database[] = [];
    let page = 1;
    for (;;) {
      if (page > MAX_D1_LIST_PAGES) {
        throw new StorageProviderError("D1 inventory exceeded the pagination safety bound");
      }
      const url = this.url("/d1/database");
      url.searchParams.set("name", name);
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", "100");
      const envelope = await this.envelope(url, "D1 generated-name inventory");
      if (!Array.isArray(envelope.result)) {
        throw new StorageProviderError("D1 generated-name inventory returned a non-list result");
      }
      const entries = envelope.result.map((entry) => parseD1ApiSummary(entry));
      values.push(...entries);
      if (envelope.result_info === undefined) {
        if (page !== 1 || entries.length === 100) {
          throw new StorageProviderError("D1 inventory omitted pagination metadata");
        }
        break;
      }
      const info = parseD1Pagination(envelope.result_info);
      if (info.page !== page || info.perPage !== 100 || info.count !== entries.length) {
        throw new StorageProviderError("D1 inventory returned inconsistent pagination");
      }
      // Cloudflare documents total_count as the account-wide total when no
      // search parameters are supplied.  It is not a terminal count for the
      // name-filtered query, so use the requested page size and a bounded
      // short-page/empty-page closure instead of adopting that global number.
      if (entries.length < info.perPage) break;
      page += 1;
    }
    return values;
  }

  async getD1(databaseId: string): Promise<IntegrationStorageD1Database> {
    if (!UUID.test(databaseId)) throw new StorageProviderError("D1 identity is invalid");
    const url = this.url(`/d1/database/${encodeURIComponent(databaseId)}`);
    const envelope = await this.envelope(url, "D1 identity readback");
    return parseD1ApiSummary(envelope.result);
  }

  async createD1(name: string): Promise<IntegrationStorageD1Database> {
    const url = this.url("/d1/database");
    const envelope = await this.envelope(url, "D1 create", "POST", { name });
    return parseD1ApiSummary(envelope.result);
  }

  async listR2(name: string): Promise<readonly IntegrationStorageR2Bucket[]> {
    const values: IntegrationStorageR2Bucket[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 1; ; page += 1) {
      if (page > MAX_R2_LIST_PAGES) {
        throw new StorageProviderError("R2 inventory exceeded the pagination safety bound");
      }
      const url = this.url("/r2/buckets");
      url.searchParams.set("name_contains", name);
      url.searchParams.set("per_page", String(R2_LIST_PAGE_SIZE));
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const envelope = await this.envelope(url, "R2 generated-name inventory");
      if (!isRecord(envelope.result) || !Array.isArray(envelope.result.buckets)) {
        throw new StorageProviderError("R2 generated-name inventory returned a malformed result");
      }
      if (envelope.result.buckets.length > R2_LIST_PAGE_SIZE) {
        throw new StorageProviderError("R2 inventory exceeded the requested page size");
      }
      values.push(...envelope.result.buckets.map((entry) => parseR2ApiSummary(entry)));
      const next = parseR2Cursor(envelope.result_info, envelope.result.buckets.length);
      if (next === null) break;
      if (seenCursors.has(next)) throw new StorageProviderError("R2 inventory cursor repeated");
      seenCursors.add(next);
      cursor = next;
    }
    return values;
  }

  async getR2(name: string): Promise<IntegrationStorageR2Bucket> {
    const url = this.url(`/r2/buckets/${encodeURIComponent(name)}`);
    const envelope = await this.envelope(url, "R2 identity readback");
    return parseR2ApiSummary(envelope.result);
  }

  async createR2(name: string): Promise<IntegrationStorageR2Bucket> {
    const url = this.url("/r2/buckets");
    const envelope = await this.envelope(url, "R2 create", "POST", { name });
    return parseR2ApiSummary(envelope.result);
  }

  private url(path: string): URL {
    return new URL(`${CLOUDFLARE_API}/accounts/${encodeURIComponent(this.#accountId)}${path}`);
  }

  private async envelope(
    url: URL,
    label: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetcher(
        new Request(url, {
          method,
          redirect: "error",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000),
        }),
      );
    } catch {
      throw new StorageProviderError(`${label} transport failed`);
    }
    const text = await boundedResponseText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StorageProviderError(`${label} returned malformed JSON`);
    }
    if (
      !response.ok ||
      !isRecord(parsed) ||
      parsed.success !== true ||
      !Object.hasOwn(parsed, "result")
    ) {
      throw new StorageProviderError(`${label} failed (HTTP ${response.status})`);
    }
    return parsed;
  }
}

class StorageProviderError extends Error {}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new StorageProviderError("Cloudflare response exceeded the safety bound");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new StorageProviderError("Cloudflare response exceeded the safety bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseD1ApiSummary(value: unknown): IntegrationStorageD1Database {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !RESOURCE_NAME.test(value.name) ||
    typeof value.uuid !== "string" ||
    !UUID.test(value.uuid)
  ) {
    throw new StorageProviderError("Cloudflare D1 response contained a malformed identity");
  }
  return { name: value.name, uuid: value.uuid };
}

function parseR2ApiSummary(value: unknown): IntegrationStorageR2Bucket {
  if (!isRecord(value) || typeof value.name !== "string" || !RESOURCE_NAME.test(value.name)) {
    throw new StorageProviderError("Cloudflare R2 response contained a malformed identity");
  }
  return { name: value.name };
}

function parseD1Pagination(value: unknown): {
  readonly page: number;
  readonly perPage: number;
  readonly count: number;
  readonly totalCount: number;
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.page) ||
    !Number.isSafeInteger(value.per_page) ||
    !Number.isSafeInteger(value.count) ||
    !Number.isSafeInteger(value.total_count) ||
    Number(value.page) < 1 ||
    Number(value.per_page) < 1 ||
    Number(value.count) < 0 ||
    Number(value.total_count) < 0
  ) {
    throw new StorageProviderError("Cloudflare D1 pagination metadata is malformed");
  }
  return {
    page: Number(value.page),
    perPage: Number(value.per_page),
    count: Number(value.count),
    totalCount: Number(value.total_count),
  };
}

function parseR2Cursor(value: unknown, count: number): string | null {
  if (value === undefined) {
    if (count >= R2_LIST_PAGE_SIZE) {
      throw new StorageProviderError(
        "R2 full page has no pagination metadata; absence is unproved",
      );
    }
    return null;
  }
  if (!isRecord(value)) {
    throw new StorageProviderError("Cloudflare R2 pagination metadata is malformed");
  }
  if (value.per_page !== undefined && value.per_page !== R2_LIST_PAGE_SIZE) {
    throw new StorageProviderError("Cloudflare R2 pagination page size differs from the request");
  }
  if (value.cursor === undefined || value.cursor === null) return null;
  if (typeof value.cursor !== "string" || value.cursor.length === 0) {
    throw new StorageProviderError("Cloudflare R2 pagination cursor is malformed");
  }
  return value.cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
