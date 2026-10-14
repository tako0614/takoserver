import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError } from "./errors.ts";
import { CloudflareIntegrationStorageProvider } from "./integration-storage-generation.ts";
import {
  type CommandResult,
  REPOSITORY,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import { writeWorkerConfig } from "./realized-config.ts";
import {
  type MoneyCutoverCustody,
  type MoneyCutoverCustodyReceipt,
  type MoneyCutoverDispatchBinding,
  type MoneyCutoverPhase,
  type MoneyResumeProof,
  type MoneyReviewBinding,
  type MoneyReviewProof,
  type MoneyStageOriginProof,
  type MoneyUnitCutoverOptions,
  type MoneyWriterProof,
  moneyCutoverBindingDigest,
} from "./schema-money-unit-cutover.ts";
import { exactV2MaintenanceModuleDigest } from "./schema-v2-existing-transition.ts";
import type { DeployTarget } from "./target.ts";
import { probeProduct } from "./worker.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { inspectLiveWorkerVersion, workerVersionIdentity } from "./worker-live.ts";
import { optionalExactPlainTextBinding, parseWorkerDeploymentHistory } from "./worker-state.ts";

const SHA = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ACCOUNT = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STAGE = /^takoserver-i-[0-9a-f]{32}$/u;
const WORKER = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const SOURCE_0092 = "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2";
const MONEY_TABLES = [
  "ledger",
  "wallet_credit_lots",
  "wallet_credit_allocations",
  "reseller_settlement_guards",
  "wallet_allocation_guards",
  "quotes",
  "reservations",
  "usage_statements",
  "usage_events",
  "idempotency",
  "reseller_settlement_intents",
  "stripe_events",
  "org_wallet_holds",
  "org_wallet_usage_records",
  "org_wallet_grant_snapshots",
  "org_wallet_pricing_revisions",
  "org_wallet_monthly_tariffs",
  "sponsorship_tenants",
  "sponsorship_resources",
  "sponsorship_credential_issuance_operations",
] as const;
const PRIVATE_ROLES = ["cpe", "gateway", "receipt-authority", "tail"] as const;
const MAX_PROTECTED_BYTES = 1024 * 1024;
const PRIVATE_ENTRIES = [
  "src/entry-cloudflare-provider-executor-complete.ts",
  "src/entry-cloudflare-managed-worker-gateway.ts",
  "src/entry-cloudflare-managed-object-receipt-authority.ts",
  "src/entry-cloudflare-v2-worker-tail.ts",
] as const;

type OwnerState = Pick<
  CloudflareState,
  | "workerDeployments"
  | "workerVersion"
  | "workerVersionWithModules"
  | "workerSecrets"
  | "workerDomains"
  | "workerSubdomain"
  | "workerAccountSubdomain"
>;
type StorageRead = Pick<CloudflareIntegrationStorageProvider, "getD1" | "getR2">;

interface Declaration {
  readonly kind: "takoserver.money-cutover-owner-declaration@v1";
  readonly phase: MoneyCutoverPhase;
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly bucketName: string;
  readonly workerName: string;
  readonly maintenanceCommit: string;
  readonly maintenanceModuleDigest: string;
  readonly maintenanceSourceRoot: string;
  readonly maintenancePublicationReceiptPath: string;
  readonly maintenancePublicationReceiptDigest: string;
  readonly resumeCommit?: string;
  readonly resumeModuleDigest?: string;
  readonly resumeSourceRoot?: string;
  readonly resumePublicationReceiptPath?: string;
  readonly resumePublicationReceiptDigest?: string;
  readonly originCertificatePath: string;
  readonly originCertificateDigest: string;
  readonly privateWriterScopePath: string;
  readonly privateWriterScopeDigest: string;
  readonly privateSourceRoot?: string;
  readonly reviewEvidencePath: string;
  readonly backupPath: string;
  readonly classificationManifestPath?: string;
  readonly classificationManifestDigest?: string;
  readonly custodyDirectory: string;
  readonly outputDirectory: string;
  readonly leaseRoot: string;
}

interface PrivateComponent {
  readonly role: (typeof PRIVATE_ROLES)[number];
  readonly workerName: string;
  readonly sourceCommit: string;
  readonly moduleDigest: string;
  readonly deploymentId: string;
  readonly versionId: string;
  readonly nativeBindingsDigest: string;
}

interface PrivateWriterScope {
  readonly kind: "takoserver.money-private-writer-scope@v1";
  readonly profile: "managed-wfp" | "standalone-host";
  readonly state: "reviewed";
  readonly reviewedAt: string;
  readonly reviewEvidenceDigest: string;
  readonly accountId: string;
  readonly databaseId: string;
  readonly sourceInventoryDigest: string;
  readonly publicSourceCommit?: string;
  readonly dependencyClosureDigest: string;
  readonly reviewedDmlTables: readonly string[];
  readonly reviewedOperations: readonly ["INSERT", "UPDATE", "DELETE"];
  readonly reviewedIndirectChannels: readonly [
    "dynamic-sql",
    "sql-string-concatenation",
    "sql-cte",
    "sql-trigger",
    "remote-host-api",
    "subrequests",
  ];
  readonly components: readonly PrivateComponent[];
  readonly reviewer: string;
  readonly reviewRef: string;
}

/**
 * Excludes target-declared private money writers and service authorities.
 * operatorIdentity is a validated public verification key, not a private
 * service binding; the public source and exact native closure still bind it.
 */
function standaloneMoneyTarget(target: DeployTarget): boolean {
  return (
    target.cloudflareProviderExecutor === undefined &&
    target.edgeSupplies === undefined &&
    target.objectBucketSupplies === undefined &&
    target.formAuthority === undefined &&
    target.integrationE2eCredentialAuthority === undefined &&
    target.sponsorshipAuthority === undefined &&
    target.exactArtifactRecovery === undefined &&
    target.zones === undefined &&
    target.aiModels === undefined &&
    target.protected0058Custody === undefined &&
    target.artifactBlobIoMode === undefined &&
    target.schemaMaintenanceMode === undefined
  );
}

function scopedWorkersDevOrigin(target: DeployTarget): boolean {
  try {
    const origin = new URL(target.publicOrigin);
    return (
      origin.protocol === "https:" &&
      origin.username === "" &&
      origin.password === "" &&
      origin.port === "" &&
      origin.pathname === "/" &&
      origin.search === "" &&
      origin.hash === "" &&
      origin.hostname.startsWith(`${target.workerName}.`) &&
      origin.hostname.endsWith(".workers.dev") &&
      (target.aliases === undefined || target.aliases.length === 0)
    );
  } catch {
    return false;
  }
}

export interface MoneyUnitOwnerDependencies {
  /** Narrow read-only test seams; live calls construct these from the selected credential. */
  readonly state?: OwnerState;
  readonly storage?: StorageRead;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly run?: (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ) => Promise<CommandResult>;
  /** Test seam only: production dry-run builds from a clean, exact-commit checkout. */
  readonly publicArtifactBuilder?: (
    sourceRoot: string,
    commit: string,
    target: DeployTarget,
    outputRoot: string,
  ) => Promise<{
    readonly bundleDigest: string;
    readonly artifactDigest: string;
    readonly artifactBytes: number;
    readonly artifactFiles: number;
  }>;
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    required.every((key) => actual.includes(key)) &&
    actual.every((key) => required.includes(key) || optional.includes(key))
  );
}

function protectedDirectory(path: string, label: string): void {
  if (
    !isAbsolute(path) ||
    relative(REPOSITORY, path) === "" ||
    !relative(REPOSITORY, path).startsWith(`..${sep}`)
  ) {
    throw preflightError(`${label} must be absolute and outside the repository`);
  }
  const parts: string[] = [];
  for (let current = resolve(path); current !== dirname(current); current = dirname(current))
    parts.push(current);
  // The private leaf is owner-only. Ancestors may be a shared mount such as /dev/shm.
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw preflightError(`${label} is unavailable`);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw preflightError(`${label} must be an owned link-free 0700 directory`);
  }
  for (const ancestor of parts.slice(1)) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error();
    } catch {
      throw preflightError(`${label} has an unsafe ancestor`);
    }
  }
}

function protectedBytes(path: string, label: string, allowAbsent = false): Uint8Array | null {
  protectedDirectory(dirname(path), label);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (allowAbsent && record(error) && error.code === "ENOENT") return null;
    throw preflightError(`${label} is unavailable`);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > MAX_PROTECTED_BYTES ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw preflightError(`${label} must be an owned link-free 0600 file within the byte bound`);
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw preflightError(`${label} cannot be opened safely`);
  }
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function protectedJson(
  path: string,
  label: string,
  expectedDigest?: string,
  allowAbsent = false,
): unknown | null {
  const bytes = protectedBytes(path, label, allowAbsent);
  if (bytes === null) return null;
  if (expectedDigest !== undefined && digest(bytes) !== expectedDigest)
    throw preflightError(`${label} digest differs from the declaration`);
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw preflightError(`${label} is malformed JSON`);
  }
}

function requireSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}
function requireCommit(value: unknown): value is string {
  return typeof value === "string" && COMMIT.test(value);
}
function requireReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 16 &&
    value.length <= 512 &&
    !/[\r\n\0]/u.test(value) &&
    !/pending|tbd|todo|placeholder|unknown/i.test(value)
  );
}

function requireReviewedAt(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  )
    return false;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || epoch > Date.now()) return false;
  const canonical = new Date(epoch).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function requireReviewEvidence(value: unknown): value is string {
  return (
    requireSha(value) &&
    value !== `sha256:${"0".repeat(64)}` &&
    value !== "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
}

function requireReviewer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 2 &&
    value.length <= 256 &&
    !/[\r\n\0]/u.test(value) &&
    !/pending|tbd|todo|placeholder|unknown/i.test(value)
  );
}

function parseDeclaration(value: unknown, target: DeployTarget): Declaration {
  const required = [
    "kind",
    "phase",
    "accountId",
    "databaseId",
    "databaseName",
    "bucketName",
    "workerName",
    "maintenanceCommit",
    "maintenanceModuleDigest",
    "maintenanceSourceRoot",
    "maintenancePublicationReceiptPath",
    "maintenancePublicationReceiptDigest",
    "originCertificatePath",
    "originCertificateDigest",
    "privateWriterScopePath",
    "privateWriterScopeDigest",
    "reviewEvidencePath",
    "backupPath",
    "custodyDirectory",
    "outputDirectory",
    "leaseRoot",
  ];
  const optional = [
    "resumeCommit",
    "resumeModuleDigest",
    "resumeSourceRoot",
    "resumePublicationReceiptPath",
    "resumePublicationReceiptDigest",
    "privateSourceRoot",
    "classificationManifestPath",
    "classificationManifestDigest",
  ];
  if (
    !record(value) ||
    !keys(value, required, optional) ||
    value.kind !== "takoserver.money-cutover-owner-declaration@v1" ||
    !["freeze", "prepare", "classify", "convert", "resume", "abandon"].includes(
      String(value.phase),
    ) ||
    target.environment !== "integration" ||
    target.accountId !== value.accountId ||
    target.d1.databaseId !== value.databaseId ||
    target.d1.databaseName !== value.databaseName ||
    target.r2.bucketName !== value.bucketName ||
    target.workerName !== value.workerName ||
    !scopedWorkersDevOrigin(target) ||
    !ACCOUNT.test(target.accountId) ||
    !UUID.test(target.d1.databaseId) ||
    !STAGE.test(target.d1.databaseName) ||
    target.r2.bucketName !== target.d1.databaseName ||
    !requireCommit(value.maintenanceCommit) ||
    !requireSha(value.maintenanceModuleDigest) ||
    !requireSha(value.originCertificateDigest) ||
    !requireSha(value.privateWriterScopeDigest) ||
    !requireSha(value.maintenancePublicationReceiptDigest) ||
    (standaloneMoneyTarget(target)
      ? value.privateSourceRoot !== undefined
      : typeof value.privateSourceRoot !== "string" || !isAbsolute(value.privateSourceRoot)) ||
    (value.privateSourceRoot !== undefined &&
      (typeof value.privateSourceRoot !== "string" || !isAbsolute(value.privateSourceRoot))) ||
    !required
      .filter(
        (field) => field.endsWith("Path") || field.endsWith("Directory") || field.endsWith("Root"),
      )
      .every((field) => typeof value[field] === "string" && isAbsolute(value[field] as string)) ||
    (value.phase === "resume" &&
      (!requireCommit(value.resumeCommit) ||
        !requireSha(value.resumeModuleDigest) ||
        typeof value.resumeSourceRoot !== "string" ||
        !isAbsolute(value.resumeSourceRoot) ||
        typeof value.resumePublicationReceiptPath !== "string" ||
        !isAbsolute(value.resumePublicationReceiptPath) ||
        !requireSha(value.resumePublicationReceiptDigest) ||
        value.resumeCommit === value.maintenanceCommit ||
        value.resumeModuleDigest === value.maintenanceModuleDigest)) ||
    (value.phase !== "resume" &&
      (value.resumeCommit !== undefined ||
        value.resumeModuleDigest !== undefined ||
        value.resumeSourceRoot !== undefined ||
        value.resumePublicationReceiptPath !== undefined ||
        value.resumePublicationReceiptDigest !== undefined)) ||
    (value.classificationManifestPath === undefined) !==
      (value.classificationManifestDigest === undefined) ||
    (value.classificationManifestDigest !== undefined &&
      !requireSha(value.classificationManifestDigest)) ||
    (value.classificationManifestPath !== undefined &&
      (typeof value.classificationManifestPath !== "string" ||
        !isAbsolute(value.classificationManifestPath)))
  ) {
    throw preflightError(
      "money owner declaration is malformed or differs from the exact staging target",
    );
  }
  return value as unknown as Declaration;
}

function parseOrigin(value: unknown, target: DeployTarget): MoneyStageOriginProof {
  const fields = [
    "kind",
    "state",
    "reviewedAt",
    "reviewEvidenceDigest",
    "accountId",
    "databaseId",
    "databaseName",
    "bucketName",
    "sourceCommit",
    "generation",
    "freshLineage",
    "migrationDigest",
    "appliedMigrationsCount",
    "schemaShapeDigest",
    "generationApplyLogDigest",
    "generationStatusLogDigest",
    "statusReadback",
    "statusPresence",
    "statusTargetSelection",
    "reviewer",
    "reviewRef",
  ];
  if (
    !record(value) ||
    !keys(value, fields) ||
    value.kind !== "takoserver.money-stage-origin-certificate@v1" ||
    value.state !== "reviewed" ||
    !requireReviewedAt(value.reviewedAt) ||
    !requireReviewEvidence(value.reviewEvidenceDigest) ||
    value.accountId !== target.accountId ||
    value.databaseId !== target.d1.databaseId ||
    value.databaseName !== target.d1.databaseName ||
    value.bucketName !== target.r2.bucketName ||
    !requireCommit(value.sourceCommit) ||
    typeof value.generation !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.generation) ||
    value.databaseName !== `takoserver-i-${value.generation}` ||
    value.freshLineage !== "v2-0092" ||
    value.migrationDigest !== SOURCE_0092 ||
    value.appliedMigrationsCount !== 92 ||
    !requireSha(value.schemaShapeDigest) ||
    !requireSha(value.generationApplyLogDigest) ||
    !requireSha(value.generationStatusLogDigest) ||
    value.statusReadback !== "complete-0092" ||
    value.statusPresence !== "both" ||
    !record(value.statusTargetSelection) ||
    !keys(value.statusTargetSelection, ["d1", "r2", "databaseIdExact"]) ||
    value.statusTargetSelection.d1 !== false ||
    value.statusTargetSelection.r2 !== false ||
    value.statusTargetSelection.databaseIdExact !== null ||
    !requireReference(value.reviewRef) ||
    !requireReviewer(value.reviewer)
  ) {
    throw preflightError("money 0092 origin certificate is malformed or unbound");
  }
  return {
    kind: "takoserver.money-stage-origin@v1",
    state: "terminal",
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    databaseName: target.d1.databaseName,
    bucketName: target.r2.bucketName,
    sourceDigest: SOURCE_0092,
    sourceCommit: value.sourceCommit as string,
    terminalCustodyDigest: digest(
      JSON.stringify({
        generationApplyLogDigest: value.generationApplyLogDigest,
        generationStatusLogDigest: value.generationStatusLogDigest,
      }),
    ),
  };
}

function parsePrivateScope(
  value: unknown,
  target: DeployTarget,
  maintenanceCommit: string,
): PrivateWriterScope {
  if (
    !record(value) ||
    !keys(
      value,
      [
        "kind",
        "profile",
        "state",
        "reviewedAt",
        "reviewEvidenceDigest",
        "accountId",
        "databaseId",
        "sourceInventoryDigest",
        "dependencyClosureDigest",
        "reviewedDmlTables",
        "reviewedOperations",
        "reviewedIndirectChannels",
        "components",
        "reviewer",
        "reviewRef",
      ],
      ["publicSourceCommit"],
    ) ||
    value.kind !== "takoserver.money-private-writer-scope@v1" ||
    !["managed-wfp", "standalone-host"].includes(String(value.profile)) ||
    value.state !== "reviewed" ||
    !requireReviewedAt(value.reviewedAt) ||
    !requireReviewEvidence(value.reviewEvidenceDigest) ||
    value.accountId !== target.accountId ||
    value.databaseId !== target.d1.databaseId ||
    !requireSha(value.sourceInventoryDigest) ||
    !requireSha(value.dependencyClosureDigest) ||
    JSON.stringify(value.reviewedDmlTables) !== JSON.stringify(MONEY_TABLES) ||
    JSON.stringify(value.reviewedOperations) !== JSON.stringify(["INSERT", "UPDATE", "DELETE"]) ||
    JSON.stringify(value.reviewedIndirectChannels) !==
      JSON.stringify([
        "dynamic-sql",
        "sql-string-concatenation",
        "sql-cte",
        "sql-trigger",
        "remote-host-api",
        "subrequests",
      ]) ||
    !Array.isArray(value.components) ||
    !requireReference(value.reviewRef) ||
    !requireReviewer(value.reviewer)
  ) {
    throw preflightError("money private writer scope evidence is malformed or incomplete");
  }
  if (value.profile === "standalone-host") {
    if (
      !standaloneMoneyTarget(target) ||
      value.publicSourceCommit !== maintenanceCommit ||
      value.components.length !== 0
    ) {
      throw preflightError(
        "money standalone Host scope has private authority or unreviewed source",
      );
    }
    return value as unknown as PrivateWriterScope;
  }
  if (value.publicSourceCommit !== undefined || value.components.length !== PRIVATE_ROLES.length) {
    throw preflightError("money managed WfP scope does not cover its four private components");
  }
  const components = value.components as unknown[];
  for (const [index, item] of components.entries()) {
    if (
      !record(item) ||
      !keys(item, [
        "role",
        "workerName",
        "sourceCommit",
        "moduleDigest",
        "deploymentId",
        "versionId",
        "nativeBindingsDigest",
      ]) ||
      item.role !== PRIVATE_ROLES[index] ||
      typeof item.workerName !== "string" ||
      !WORKER.test(item.workerName) ||
      !requireCommit(item.sourceCommit) ||
      !requireSha(item.moduleDigest) ||
      !requireSha(item.nativeBindingsDigest) ||
      typeof item.deploymentId !== "string" ||
      !UUID.test(item.deploymentId) ||
      typeof item.versionId !== "string" ||
      !UUID.test(item.versionId)
    ) {
      throw preflightError("money private writer component evidence is malformed");
    }
  }
  const known = target.cloudflareProviderExecutor;
  const typedComponents = components as PrivateComponent[];
  if (
    !known ||
    typedComponents[0]?.workerName !== known.workerName ||
    typedComponents[1]?.workerName !== known.gatewayWorkerName ||
    typedComponents[2]?.workerName !== known.receiptAuthorityWorkerName ||
    new Set(components.map((item) => (item as Record<string, unknown>).workerName)).size !==
      components.length
  ) {
    throw preflightError(
      "money private writer components differ from selected private supply topology",
    );
  }
  return value as unknown as PrivateWriterScope;
}

interface PublicPublicationReceipt {
  readonly kind: "takoserver.money-public-worker-publication@v1";
  readonly state: "reviewed";
  readonly reviewedAt: string;
  readonly reviewEvidenceDigest: string;
  readonly phase: "maintenance" | "resume";
  readonly accountId: string;
  readonly databaseId: string;
  readonly workerName: string;
  readonly sourceCommit: string;
  readonly bundleDigest: string;
  readonly artifactDigest: string;
  readonly artifactBytes: number;
  readonly artifactFiles: number;
  readonly deploymentId: string;
  readonly versionId: string;
  readonly surface: "takoserver-worker-authority-cutover";
  readonly resultKind: "takoserver.worker-apply@v2";
  readonly resultDigest: string;
  readonly ownerGateDigest: string;
  readonly reviewer: string;
  readonly reviewRef: string;
}

function parsePublicPublicationReceipt(
  value: unknown,
  target: DeployTarget,
  phase: "maintenance" | "resume",
  commit: string,
  bundleDigest: string,
): PublicPublicationReceipt {
  const fields = [
    "kind",
    "state",
    "reviewedAt",
    "reviewEvidenceDigest",
    "phase",
    "accountId",
    "databaseId",
    "workerName",
    "sourceCommit",
    "bundleDigest",
    "artifactDigest",
    "artifactBytes",
    "artifactFiles",
    "deploymentId",
    "versionId",
    "surface",
    "resultKind",
    "resultDigest",
    "ownerGateDigest",
    "reviewer",
    "reviewRef",
  ];
  if (
    !record(value) ||
    !keys(value, fields) ||
    value.kind !== "takoserver.money-public-worker-publication@v1" ||
    value.state !== "reviewed" ||
    !requireReviewedAt(value.reviewedAt) ||
    !requireReviewEvidence(value.reviewEvidenceDigest) ||
    value.phase !== phase ||
    value.accountId !== target.accountId ||
    value.databaseId !== target.d1.databaseId ||
    value.workerName !== target.workerName ||
    value.sourceCommit !== commit ||
    value.bundleDigest !== bundleDigest ||
    !requireSha(value.artifactDigest) ||
    !Number.isSafeInteger(value.artifactBytes) ||
    Number(value.artifactBytes) <= 0 ||
    !Number.isSafeInteger(value.artifactFiles) ||
    Number(value.artifactFiles) < 2 ||
    value.surface !== "takoserver-worker-authority-cutover" ||
    value.resultKind !== "takoserver.worker-apply@v2" ||
    !UUID.test(String(value.deploymentId)) ||
    !UUID.test(String(value.versionId)) ||
    !requireSha(value.resultDigest) ||
    !requireSha(value.ownerGateDigest) ||
    !requireReviewer(value.reviewer) ||
    !requireReference(value.reviewRef)
  ) {
    throw preflightError(
      "money public Worker terminal publication evidence is malformed or unbound",
    );
  }
  return value as unknown as PublicPublicationReceipt;
}

async function cleanPublicSourceRoot(
  root: string,
  commit: string,
  run: NonNullable<MoneyUnitOwnerDependencies["run"]>,
  requireLatestMain = false,
): Promise<void> {
  if (
    !isAbsolute(root) ||
    !requireCommit(commit) ||
    relative(REPOSITORY, root) === "" ||
    !relative(REPOSITORY, root).startsWith(`..${sep}`)
  ) {
    throw preflightError("money public source selector is invalid");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch {
    throw preflightError("money public source checkout is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== resolve(root)) {
    throw preflightError("money public source checkout is unsafe");
  }
  const git = async (args: readonly string[]): Promise<string> => {
    let result: CommandResult;
    try {
      result = await run(["git", "-C", root, ...args]);
    } catch {
      throw preflightError("money public source Git read failed");
    }
    if (result.exitCode !== 0) throw preflightError("money public source Git read failed");
    return result.stdout.trim();
  };
  if (
    resolve(await git(["rev-parse", "--show-toplevel"])) !== resolve(root) ||
    (await git(["rev-parse", "HEAD"])) !== commit ||
    (await git(["status", "--porcelain=v1", "--untracked-files=all"])) !== ""
  ) {
    throw preflightError("money public source checkout is not the exact clean reviewed commit");
  }
  if (requireLatestMain) {
    const remote = await git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
    if (remote !== `${commit}\trefs/heads/main`)
      throw preflightError("money resume source is not the latest remote main commit");
  }
}

/** Recomputes the bounded direct-money-writer source inventory from immutable Git objects only. */
export async function inspectMoneyPrivateSourceArchive(
  privateSourceRoot: string,
  commit: string,
  run: NonNullable<MoneyUnitOwnerDependencies["run"]> = runCommand,
): Promise<{ readonly sourceInventoryDigest: string; readonly sourceFileCount: number }> {
  if (
    !isAbsolute(privateSourceRoot) ||
    !requireCommit(commit) ||
    relative(REPOSITORY, privateSourceRoot) === "" ||
    !relative(REPOSITORY, privateSourceRoot).startsWith(`..${sep}`)
  ) {
    throw preflightError("money private source archive selector is invalid");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(privateSourceRoot);
  } catch {
    throw preflightError("money private source archive is unavailable");
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(privateSourceRoot) !== resolve(privateSourceRoot)
  ) {
    throw preflightError("money private source archive root is unsafe");
  }
  const command = async (args: readonly string[]): Promise<CommandResult> => {
    try {
      return await run(["git", "-C", privateSourceRoot, ...args]);
    } catch {
      throw preflightError("money private source archive read failed");
    }
  };
  const root = await command(["rev-parse", "--show-toplevel"]);
  if (root.exitCode !== 0 || resolve(root.stdout.trim()) !== resolve(privateSourceRoot)) {
    throw preflightError("money private source archive is not an exact Git worktree root");
  }
  const packageFile = await command(["show", `${commit}:package.json`]);
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageFile.stdout);
  } catch {
    throw preflightError("money private source package identity is unavailable");
  }
  if (
    packageFile.exitCode !== 0 ||
    !record(packageJson) ||
    packageJson.name !== "@takoserver/private-composition"
  ) {
    throw preflightError("money private source archive has the wrong repository identity");
  }
  // `ls-tree` reads object identity only. It includes all imported/common source,
  // package and lock identities without opening operator production settings.
  const inventory = await command([
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    "src",
    "package.json",
    "bun.lock",
  ]);
  if (inventory.exitCode !== 0 || inventory.stdout.length > MAX_PROTECTED_BYTES)
    throw preflightError("money private source inventory is unavailable or too large");
  const lines = inventory.stdout.split("\0");
  if (lines.at(-1) !== "") throw preflightError("money private source inventory is unterminated");
  lines.pop();
  if (lines.length < PRIVATE_ENTRIES.length + 2 || lines.length > 1024)
    throw preflightError("money private source inventory has an unexpected size");
  const paths: string[] = [];
  for (const line of lines) {
    const match =
      /^100644 blob [0-9a-f]{40}\t(src\/[A-Za-z0-9_./-]+|package\.json|bun\.lock)$/u.exec(line);
    if (!match?.[1] || match[1].split("/").includes("..") || match[1].split("/").includes(".")) {
      throw preflightError("money private source inventory contains an unsafe path or object");
    }
    paths.push(match[1]);
  }
  if (
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths) !== JSON.stringify([...paths].sort()) ||
    PRIVATE_ENTRIES.some((entry) => !paths.includes(entry)) ||
    !paths.includes("package.json") ||
    !paths.includes("bun.lock")
  ) {
    throw preflightError("money private source inventory is incomplete or ambiguous");
  }
  const dmlPattern = `((INSERT([[:space:]]+OR[[:space:]]+[A-Z]+)?|REPLACE)[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM)[[:space:]]+["\x60']?(${MONEY_TABLES.join("|")})([^[:alnum:]_]|$)`;
  const dml = await command(["grep", "-I", "-q", "-i", "-E", dmlPattern, commit, "--", "src"]);
  if (dml.exitCode === 0)
    throw preflightError("money private source archive contains direct money-table DML");
  if (dml.exitCode !== 1)
    throw preflightError("money private source DML inspection is inconclusive");
  return { sourceInventoryDigest: digest(inventory.stdout), sourceFileCount: paths.length };
}

/** Standalone scope binds the reviewed Host source and dependency lock, without scanning private code. */
async function inspectStandalonePublicSourceArchive(
  sourceRoot: string,
  commit: string,
  run: NonNullable<MoneyUnitOwnerDependencies["run"]>,
): Promise<string> {
  await cleanPublicSourceRoot(sourceRoot, commit, run);
  const command = async (args: readonly string[]): Promise<string> => {
    let result: CommandResult;
    try {
      result = await run(["git", "-C", sourceRoot, ...args]);
    } catch {
      throw preflightError("money standalone Host source archive read failed");
    }
    if (result.exitCode !== 0)
      throw preflightError("money standalone Host source archive read failed");
    return result.stdout;
  };
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await command(["show", `${commit}:package.json`]));
  } catch {
    throw preflightError("money standalone Host package identity is unavailable");
  }
  if (!record(packageJson) || packageJson.name !== "@takoserver/core") {
    throw preflightError("money standalone Host source archive has the wrong repository identity");
  }
  const inventory = await command([
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    "src",
    "package.json",
    "bun.lock",
  ]);
  if (inventory.length > MAX_PROTECTED_BYTES || !inventory.endsWith("\0")) {
    throw preflightError("money standalone Host source inventory is unavailable or too large");
  }
  const entries = inventory.slice(0, -1).split("\0");
  if (entries.length < 3 || entries.length > 2048)
    throw preflightError("money standalone Host source inventory has an unexpected size");
  const paths: string[] = [];
  for (const entry of entries) {
    const match =
      /^100644 blob [0-9a-f]{40}\t(src\/[A-Za-z0-9_./-]+|package\.json|bun\.lock)$/u.exec(entry);
    if (!match?.[1] || match[1].split("/").some((part) => part === "." || part === "..")) {
      throw preflightError(
        "money standalone Host source inventory contains an unsafe path or object",
      );
    }
    paths.push(match[1]);
  }
  if (
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths) !== JSON.stringify([...paths].sort()) ||
    !paths.includes("src/entry-cloudflare-worker.ts") ||
    !paths.includes("package.json") ||
    !paths.includes("bun.lock")
  ) {
    throw preflightError("money standalone Host source inventory is incomplete or ambiguous");
  }
  return digest(inventory);
}

function custody(directory: string): MoneyCutoverCustody {
  protectedDirectory(directory, "money custody directory");
  const path = (phase: MoneyCutoverPhase, state: "dispatched" | "terminal") =>
    join(directory, `${phase}.${state}.json`);
  const parseReceipt = (
    value: unknown,
    phase: MoneyCutoverPhase,
    state: "dispatched" | "terminal",
  ): MoneyCutoverCustodyReceipt => {
    if (
      !record(value) ||
      !keys(value, ["kind", "phase", "state", "bindingDigest", "postDigest"]) ||
      value.kind !== "takoserver.money-cutover-custody@v1" ||
      value.phase !== phase ||
      value.state !== state ||
      !requireSha(value.bindingDigest) ||
      (state === "terminal" ? !requireSha(value.postDigest) : value.postDigest !== null)
    ) {
      throw preflightError("money custody receipt is malformed");
    }
    return value as unknown as MoneyCutoverCustodyReceipt;
  };
  const parseBinding = (value: unknown, phase: MoneyCutoverPhase): MoneyCutoverDispatchBinding => {
    const fields = [
      "kind",
      "phase",
      "accountId",
      "databaseId",
      "databaseName",
      "originDigest",
      "predecessorCustodyDigest",
      "sourceCommit",
      "sourceDigest",
      "importDigest",
      "backupDigest",
      "preimageDigest",
      "aggregateDigest",
      "classificationDigest",
      "writerDigest",
      "resumeDigest",
      "reviewDigest",
      "beforeShapeDigest",
      "afterSchemaPhase",
      "sealedImportPath",
    ];
    if (
      !record(value) ||
      !keys(value, fields) ||
      value.kind !== "takoserver.money-cutover-dispatch@v1" ||
      value.phase !== phase ||
      !ACCOUNT.test(String(value.accountId)) ||
      !UUID.test(String(value.databaseId)) ||
      !STAGE.test(String(value.databaseName)) ||
      !requireCommit(value.sourceCommit) ||
      !["0092", "0092-fenced", "0093", "0093-fenced", "0094", "0094-fenced"].includes(
        String(value.afterSchemaPhase),
      ) ||
      typeof value.sealedImportPath !== "string" ||
      !isAbsolute(value.sealedImportPath) ||
      ![
        "originDigest",
        "predecessorCustodyDigest",
        "sourceDigest",
        "importDigest",
        "backupDigest",
        "preimageDigest",
        "aggregateDigest",
        "classificationDigest",
        "writerDigest",
        "resumeDigest",
        "reviewDigest",
        "beforeShapeDigest",
      ].every((field) => requireSha(value[field]))
    ) {
      throw preflightError("money dispatch binding is malformed");
    }
    return value as unknown as MoneyCutoverDispatchBinding;
  };
  const readDispatchRecord = (
    phase: MoneyCutoverPhase,
  ): {
    readonly receipt: MoneyCutoverCustodyReceipt;
    readonly binding: MoneyCutoverDispatchBinding;
  } | null => {
    const value = protectedJson(
      path(phase, "dispatched"),
      "money dispatch custody",
      undefined,
      true,
    );
    if (value === null) return null;
    if (
      !record(value) ||
      !keys(value, ["kind", "receipt", "binding"]) ||
      value.kind !== "takoserver.money-cutover-dispatch-record@v1"
    ) {
      throw preflightError("money dispatch custody envelope is malformed");
    }
    const receipt = parseReceipt(value.receipt, phase, "dispatched");
    const binding = parseBinding(value.binding, phase);
    if (receipt.bindingDigest !== moneyCutoverBindingDigest(binding))
      throw preflightError("money dispatch custody binding digest differs");
    const bytes = protectedBytes(binding.sealedImportPath, "money sealed import SQL");
    if (bytes === null || digest(bytes) !== binding.importDigest)
      throw preflightError("money sealed import SQL differs from immutable dispatch");
    return { receipt, binding };
  };
  const readTerminal = (phase: MoneyCutoverPhase): MoneyCutoverCustodyReceipt | null => {
    const value = protectedJson(path(phase, "terminal"), "money terminal custody", undefined, true);
    return value === null ? null : parseReceipt(value, phase, "terminal");
  };
  const writeRecord = (
    phase: MoneyCutoverPhase,
    state: "dispatched" | "terminal",
    value: unknown,
  ): void => {
    protectedDirectory(directory, "money custody directory");
    let fd: number;
    try {
      fd = openSync(
        path(phase, state),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw mutationError(
        "money custody dispatch already exists or cannot be opened; do not retry",
      );
    }
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dirFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  };
  return {
    async read(phase) {
      const terminal = readTerminal(phase);
      const dispatched = readDispatchRecord(phase);
      if (terminal && (!dispatched || terminal.bindingDigest !== dispatched.receipt.bindingDigest))
        throw preflightError("money terminal custody lacks exact dispatch");
      return terminal ?? dispatched?.receipt ?? null;
    },
    async readDispatch(phase) {
      return readDispatchRecord(phase)?.binding ?? null;
    },
    async dispatch(binding) {
      if ((await this.read(binding.phase)) !== null)
        throw mutationError("money dispatch custody already exists; do not retry");
      parseBinding(binding, binding.phase);
      const bytes = protectedBytes(binding.sealedImportPath, "money sealed import SQL");
      if (bytes === null || digest(bytes) !== binding.importDigest)
        throw mutationError("money sealed import SQL differs before dispatch");
      const receipt: MoneyCutoverCustodyReceipt = {
        kind: "takoserver.money-cutover-custody@v1",
        phase: binding.phase,
        state: "dispatched",
        bindingDigest: moneyCutoverBindingDigest(binding),
        postDigest: null,
      };
      writeRecord(binding.phase, "dispatched", {
        kind: "takoserver.money-cutover-dispatch-record@v1",
        receipt,
        binding,
      });
      return receipt;
    },
    async terminal(binding, postDigest) {
      const existing = readDispatchRecord(binding.phase);
      if (
        !existing ||
        existing.receipt.bindingDigest !== moneyCutoverBindingDigest(binding) ||
        readTerminal(binding.phase) !== null ||
        !requireSha(postDigest)
      ) {
        throw mutationError(
          "money terminal custody cannot reconcile its exact dispatch; do not retry",
        );
      }
      const receipt: MoneyCutoverCustodyReceipt = {
        kind: "takoserver.money-cutover-custody@v1",
        phase: binding.phase,
        state: "terminal",
        bindingDigest: existing.receipt.bindingDigest,
        postDigest,
      };
      writeRecord(binding.phase, "terminal", receipt);
      return receipt;
    },
  };
}

async function probe(
  origin: string,
  fetcher: NonNullable<MoneyUnitOwnerDependencies["fetcher"]>,
  maintenance: boolean,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/healthz`, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
      redirect: "error",
    });
  } catch {
    throw preflightError("money Worker health probe is unavailable");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw preflightError("money Worker health response is malformed");
  }
  if (maintenance) {
    if (
      response.status !== 503 ||
      response.headers.get("cache-control") !== "no-store" ||
      response.headers.get("retry-after") !== "60" ||
      !record(body) ||
      !record(body.error) ||
      body.error.code !== "backend_unavailable" ||
      body.error.message !==
        "Host is quiesced for the wallet USD-micros schema maintenance transition" ||
      !record(body.error.details) ||
      body.error.details.reason !== "runtime-configuration"
    ) {
      throw preflightError("money Worker did not prove wallet-specific maintenance refusal");
    }
  } else if (response.status !== 200 || !record(body)) {
    throw preflightError("money resumed Worker did not prove healthy native service");
  } else {
    await probeProduct(origin, fetcher);
  }
}

/** Source-owned, read-only authority adapter for one existing 0092 staging target. */
export async function loadMoneyUnitCutoverOptions(
  declarationPath: string,
  target: DeployTarget,
  dependencies: MoneyUnitOwnerDependencies = {},
): Promise<MoneyUnitCutoverOptions> {
  const declaration = parseDeclaration(
    protectedJson(declarationPath, "money owner declaration"),
    target,
  );
  for (const directory of [
    declaration.custodyDirectory,
    declaration.outputDirectory,
    declaration.leaseRoot,
  ])
    protectedDirectory(directory, "money owner directory");
  parseOrigin(
    protectedJson(
      declaration.originCertificatePath,
      "money 0092 origin",
      declaration.originCertificateDigest,
    ),
    target,
  );
  const scope = parsePrivateScope(
    protectedJson(
      declaration.privateWriterScopePath,
      "money private writer scope",
      declaration.privateWriterScopeDigest,
    ),
    target,
    declaration.maintenanceCommit,
  );
  parsePublicPublicationReceipt(
    protectedJson(
      declaration.maintenancePublicationReceiptPath,
      "money maintenance terminal publication",
      declaration.maintenancePublicationReceiptDigest,
    ),
    target,
    "maintenance",
    declaration.maintenanceCommit,
    declaration.maintenanceModuleDigest,
  );
  if (
    declaration.phase === "resume" &&
    declaration.resumePublicationReceiptPath !== undefined &&
    declaration.resumePublicationReceiptDigest !== undefined &&
    declaration.resumeCommit !== undefined &&
    declaration.resumeModuleDigest !== undefined
  ) {
    parsePublicPublicationReceipt(
      protectedJson(
        declaration.resumePublicationReceiptPath,
        "money resume terminal publication",
        declaration.resumePublicationReceiptDigest,
      ),
      target,
      "resume",
      declaration.resumeCommit,
      declaration.resumeModuleDigest,
    );
  }
  let state = dependencies.state;
  let storage = dependencies.storage;
  if (state === undefined || storage === undefined) {
    const credential = await resolveCloudflareCredential("integration", {
      ...(dependencies.cloudflareEnvironment === undefined
        ? {}
        : { cloudflareEnvironment: dependencies.cloudflareEnvironment }),
      ...(dependencies.run === undefined ? {} : { run: dependencies.run }),
    });
    state ??= new CloudflareState({
      accountId: target.accountId,
      token: credential.token,
      workerDomainServiceScope: target.workerName,
    });
    storage ??= new CloudflareIntegrationStorageProvider(target.accountId, credential.token);
  }
  const selectedState = state;
  const selectedStorage = storage;
  const fetcher =
    dependencies.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init));

  async function readPrivateScope(): Promise<{
    readonly privateScopeDigest: string;
    readonly privateSourceInventoryDigest: string;
    readonly privateDependencyClosureDigest: string;
    readonly privateDeploymentsDigest: string;
  }> {
    // Re-read the protected reviewed inventory every time, so a later phase cannot inherit a replaced file.
    parsePrivateScope(
      protectedJson(
        declaration.privateWriterScopePath,
        "money private writer scope",
        declaration.privateWriterScopeDigest,
      ),
      target,
      declaration.maintenanceCommit,
    );
    if (scope.profile === "standalone-host") {
      // The closed standalone target has no declared private service or supply authority.
      // The public Version closure below proves native absence; DB fences block late DML.
      const inventoryDigest = await inspectStandalonePublicSourceArchive(
        declaration.maintenanceSourceRoot,
        declaration.maintenanceCommit,
        dependencies.run ?? runCommand,
      );
      if (inventoryDigest !== scope.sourceInventoryDigest) {
        throw preflightError(
          "money standalone Host source differs from independently reviewed inventory",
        );
      }
      return {
        privateScopeDigest: declaration.privateWriterScopeDigest,
        privateSourceInventoryDigest: inventoryDigest,
        privateDependencyClosureDigest: scope.dependencyClosureDigest,
        privateDeploymentsDigest: digest("[]"),
      };
    }
    if (declaration.privateSourceRoot === undefined)
      throw preflightError("money managed WfP source root is unavailable");
    const commits = [
      ...new Set(scope.components.map((component) => component.sourceCommit)),
    ].sort();
    const archives = [];
    for (const commit of commits) {
      const archive = await inspectMoneyPrivateSourceArchive(
        declaration.privateSourceRoot,
        commit,
        dependencies.run,
      );
      archives.push({ commit, sourceInventoryDigest: archive.sourceInventoryDigest });
    }
    if (digest(JSON.stringify(archives)) !== scope.sourceInventoryDigest) {
      throw preflightError(
        "money private source archive differs from the independently reviewed inventory",
      );
    }
    const deployments = [];
    for (const component of scope.components) {
      const history = parseWorkerDeploymentHistory(
        await selectedState.workerDeployments(component.workerName),
        "preflight",
      );
      if (!history || !UUID.test(history.deploymentId) || !UUID.test(history.versionId))
        throw preflightError("money private Worker is not entirely on one native Version");
      const version = await selectedState.workerVersion(component.workerName, history.versionId);
      const identity = workerVersionIdentity("preflight", version);
      const moduleDigest = `sha256:${exactV2MaintenanceModuleDigest("preflight", await selectedState.workerVersionWithModules(component.workerName, history.versionId))}`;
      const bindings =
        record(version) && record(version.resources) ? version.resources.bindings : null;
      if (!Array.isArray(bindings) || bindings.some((binding) => !record(binding))) {
        throw preflightError("money private Worker native binding closure is unavailable");
      }
      const nativeBindingsDigest = digest(JSON.stringify(bindings));
      if (
        identity.commit !== component.sourceCommit ||
        `sha256:${identity.bundleDigestHex}` !== moduleDigest ||
        moduleDigest !== component.moduleDigest
      ) {
        throw preflightError(
          "money private Worker differs from independently reviewed source/module inventory",
        );
      }
      if (
        history.deploymentId !== component.deploymentId ||
        history.versionId !== component.versionId ||
        nativeBindingsDigest !== component.nativeBindingsDigest
      ) {
        throw preflightError(
          "money private Worker differs from independently reviewed native deployment/binding inventory",
        );
      }
      const after = parseWorkerDeploymentHistory(
        await selectedState.workerDeployments(component.workerName),
        "preflight",
      );
      if (
        !after ||
        after.deploymentId !== history.deploymentId ||
        after.versionId !== history.versionId
      )
        throw preflightError("money private Worker changed during source proof");
      deployments.push({
        role: component.role,
        workerName: component.workerName,
        sourceCommit: component.sourceCommit,
        moduleDigest,
        deploymentId: history.deploymentId,
        versionId: history.versionId,
        nativeBindingsDigest,
      });
    }
    return {
      privateScopeDigest: declaration.privateWriterScopeDigest,
      privateSourceInventoryDigest: scope.sourceInventoryDigest,
      privateDependencyClosureDigest: scope.dependencyClosureDigest,
      privateDeploymentsDigest: digest(JSON.stringify(deployments)),
    };
  }

  async function readPublic(maintenance: boolean): Promise<{
    readonly deploymentId: string;
    readonly versionId: string;
    readonly commit: string;
    readonly moduleDigest: string;
    readonly publicPublicationDigest: string;
    readonly publicSourceArtifactDigest: string;
  }> {
    const { schemaMaintenanceMode: _mode, ...plainTarget } = target;
    const selectedTarget: DeployTarget = maintenance
      ? { ...plainTarget, schemaMaintenanceMode: "pre-wallet-usd-micros-quiesced" }
      : plainTarget;
    const live = await inspectLiveWorkerVersion("preflight", selectedTarget, selectedState, {
      ...(selectedTarget.integrationE2eCredentialAuthority === undefined
        ? {}
        : { authorityProfile: { kind: "provenance-bound-jit" as const } }),
    });
    const expectedCommit = maintenance ? declaration.maintenanceCommit : declaration.resumeCommit;
    const expectedDigest = maintenance
      ? declaration.maintenanceModuleDigest
      : declaration.resumeModuleDigest;
    const sourceRoot = maintenance
      ? declaration.maintenanceSourceRoot
      : declaration.resumeSourceRoot;
    const receiptPath = maintenance
      ? declaration.maintenancePublicationReceiptPath
      : declaration.resumePublicationReceiptPath;
    const receiptDigest = maintenance
      ? declaration.maintenancePublicationReceiptDigest
      : declaration.resumePublicationReceiptDigest;
    if (
      expectedCommit === undefined ||
      expectedDigest === undefined ||
      sourceRoot === undefined ||
      receiptPath === undefined ||
      receiptDigest === undefined
    ) {
      throw preflightError("money public source publication selector is incomplete");
    }
    if (
      live.commit !== expectedCommit ||
      `sha256:${live.bundleDigestHex}` !== expectedDigest ||
      !UUID.test(live.history.deploymentId) ||
      !UUID.test(live.history.versionId)
    ) {
      throw preflightError(
        "money public Worker source or all-traffic deployment differs from selected reviewed build",
      );
    }
    const moduleDigest = `sha256:${exactV2MaintenanceModuleDigest("preflight", await selectedState.workerVersionWithModules(target.workerName, live.history.versionId))}`;
    if (moduleDigest !== expectedDigest)
      throw preflightError(
        "money public Worker native module bytes differ from selected reviewed build",
      );
    const run = dependencies.run ?? runCommand;
    await cleanPublicSourceRoot(sourceRoot, expectedCommit, run, !maintenance);
    const buildRoot = mkdtempSync(join(declaration.outputDirectory, "money-public-build-"));
    let sourceBuilt: {
      readonly bundleDigest: string;
      readonly artifactDigest: string;
      readonly artifactBytes: number;
      readonly artifactFiles: number;
    };
    try {
      if (dependencies.publicArtifactBuilder !== undefined) {
        sourceBuilt = await dependencies.publicArtifactBuilder(
          sourceRoot,
          expectedCommit,
          selectedTarget,
          buildRoot,
        );
      } else {
        const prepared = await prepareWorkerArtifact({
          root: buildRoot,
          target: selectedTarget,
          commit: expectedCommit,
          sourceRepositoryRoot: sourceRoot,
          wranglerPath: join(sourceRoot, "node_modules/.bin/wrangler"),
          dryRunCommand: "versions-upload",
          run: (command, options) =>
            run(command, options?.env === undefined ? {} : { env: options.env }),
          writeConfig: ({ path, main, bundleDigestHex, formImplementationIdentity }) =>
            writeWorkerConfig(selectedTarget, {
              path,
              main,
              commit: expectedCommit,
              sourceRepositoryRoot: sourceRoot,
              topology: "version-only",
              ...(formImplementationIdentity === undefined ? {} : { formImplementationIdentity }),
              ...(bundleDigestHex === undefined
                ? {}
                : { workerArtifactDigest: `sha256:${bundleDigestHex}` as const }),
              ...(selectedTarget.integrationE2eCredentialAuthority === undefined
                ? {}
                : bundleDigestHex === undefined
                  ? { authorityProfile: { kind: "historical-pre-jit" as const } }
                  : {
                      authorityProfile: {
                        kind: "provenance-bound-jit" as const,
                        provenance: {
                          sourceCommit: expectedCommit,
                          artifactDigest: `sha256:${bundleDigestHex}` as const,
                        },
                      },
                    }),
            }),
        });
        const sealed = prepared.seal();
        sealed.assertUnchanged();
        sourceBuilt = {
          bundleDigest: `sha256:${prepared.bundleDigestHex}`,
          artifactDigest: sealed.digest,
          artifactBytes: sealed.bytes,
          artifactFiles: sealed.files,
        };
      }
    } catch {
      // Wrangler/build diagnostics may contain target vars or credentials.
      throw preflightError("money public Worker exact source build failed");
    }
    await cleanPublicSourceRoot(sourceRoot, expectedCommit, run, !maintenance);
    if (
      sourceBuilt.bundleDigest !== expectedDigest ||
      sourceBuilt.bundleDigest !== moduleDigest ||
      !requireSha(sourceBuilt.artifactDigest) ||
      !Number.isSafeInteger(sourceBuilt.artifactBytes) ||
      !Number.isSafeInteger(sourceBuilt.artifactFiles)
    ) {
      throw preflightError("money public Worker source-built bytes differ from native Version");
    }
    const publication = parsePublicPublicationReceipt(
      protectedJson(receiptPath, "money public Worker terminal publication", receiptDigest),
      target,
      maintenance ? "maintenance" : "resume",
      expectedCommit,
      expectedDigest,
    );
    if (
      publication.artifactDigest !== sourceBuilt.artifactDigest ||
      publication.artifactBytes !== sourceBuilt.artifactBytes ||
      publication.artifactFiles !== sourceBuilt.artifactFiles ||
      publication.deploymentId !== live.history.deploymentId ||
      publication.versionId !== live.history.versionId
    ) {
      throw preflightError(
        "money public Worker source/native identity differs from terminal publication",
      );
    }
    if (!maintenance) {
      const predecessor = parsePublicPublicationReceipt(
        protectedJson(
          declaration.maintenancePublicationReceiptPath,
          "money maintenance terminal publication",
          declaration.maintenancePublicationReceiptDigest,
        ),
        target,
        "maintenance",
        declaration.maintenanceCommit,
        declaration.maintenanceModuleDigest,
      );
      if (
        publication.deploymentId === predecessor.deploymentId ||
        publication.versionId === predecessor.versionId
      ) {
        throw preflightError("money resumed Worker reuses the old maintenance publication");
      }
    }
    const version = await selectedState.workerVersion(target.workerName, live.history.versionId);
    const mode = optionalExactPlainTextBinding(
      "preflight",
      live.history.versionId,
      version,
      "TAKOSERVER_SCHEMA_MAINTENANCE_MODE",
    );
    if (maintenance ? mode !== "pre-wallet-usd-micros-quiesced" : mode !== null)
      throw preflightError("money public Worker native mode is incorrect");
    await probe(target.publicOrigin, fetcher, maintenance);
    const after = parseWorkerDeploymentHistory(
      await selectedState.workerDeployments(target.workerName),
      "preflight",
    );
    if (
      !after ||
      after.deploymentId !== live.history.deploymentId ||
      after.versionId !== live.history.versionId
    )
      throw preflightError("money public Worker changed during source proof");
    return {
      deploymentId: live.history.deploymentId,
      versionId: live.history.versionId,
      commit: live.commit,
      moduleDigest,
      publicPublicationDigest: receiptDigest,
      publicSourceArtifactDigest: sourceBuilt.artifactDigest,
    };
  }

  return {
    phase: declaration.phase,
    maintenanceCommit: declaration.maintenanceCommit,
    ...(declaration.resumeCommit === undefined ? {} : { resumeCommit: declaration.resumeCommit }),
    async stageOriginProof() {
      return parseOrigin(
        protectedJson(
          declaration.originCertificatePath,
          "money 0092 origin",
          declaration.originCertificateDigest,
        ),
        target,
      );
    },
    async storageIdentityRead() {
      const [d1, r2] = await Promise.all([
        selectedStorage.getD1(target.d1.databaseId),
        selectedStorage.getR2(target.r2.bucketName),
      ]);
      if (
        d1.uuid !== target.d1.databaseId ||
        d1.name !== target.d1.databaseName ||
        r2.name !== target.r2.bucketName
      )
        throw preflightError("money selected staging D1/R2 native GET identity differs");
      return {
        accountId: target.accountId,
        databaseId: d1.uuid,
        databaseName: d1.name,
        bucketName: r2.name,
      };
    },
    async maintenanceProof(): Promise<MoneyWriterProof> {
      const publicWorker = await readPublic(true);
      const privateProof = await readPrivateScope();
      return {
        kind: "takoserver.money-writer-quiescence@v1",
        mode: "pre-wallet-usd-micros-quiesced",
        accountId: target.accountId,
        databaseId: target.d1.databaseId,
        workerName: target.workerName,
        deploymentId: publicWorker.deploymentId,
        versionId: publicWorker.versionId,
        sourceCommit: publicWorker.commit,
        moduleDigest: publicWorker.moduleDigest,
        trafficPercent: 100,
        privateMoneyWriters: 0,
        publicPublicationDigest: publicWorker.publicPublicationDigest,
        publicSourceArtifactDigest: publicWorker.publicSourceArtifactDigest,
        ...privateProof,
      };
    },
    async resumeProof(): Promise<MoneyResumeProof> {
      const publicWorker = await readPublic(false);
      const privateProof = await readPrivateScope();
      return {
        kind: "takoserver.money-resume-worker@v1",
        accountId: target.accountId,
        databaseId: target.d1.databaseId,
        workerName: target.workerName,
        sourceCommit: publicWorker.commit,
        moduleDigest: publicWorker.moduleDigest,
        deploymentId: publicWorker.deploymentId,
        versionId: publicWorker.versionId,
        trafficPercent: 100,
        nativeHealth: "healthy",
        oldMoneyWriters: 0,
        publicPublicationDigest: publicWorker.publicPublicationDigest,
        publicSourceArtifactDigest: publicWorker.publicSourceArtifactDigest,
        ...privateProof,
      };
    },
    async independentReview(binding: MoneyReviewBinding): Promise<MoneyReviewProof | null> {
      const value = protectedJson(
        declaration.reviewEvidencePath,
        "money independent review",
        undefined,
        true,
      );
      if (value === null) return null;
      if (
        !record(value) ||
        !keys(value, [
          "kind",
          "state",
          "reviewedAt",
          "reviewEvidenceDigest",
          "reviewer",
          "reviewRef",
          "bindingDigest",
          "evidenceDigest",
        ]) ||
        value.kind !== "takoserver.money-independent-review@v1" ||
        value.state !== "reviewed" ||
        !requireReviewedAt(value.reviewedAt) ||
        !requireReviewEvidence(value.reviewEvidenceDigest) ||
        !requireReference(value.reviewRef) ||
        !requireReviewer(value.reviewer) ||
        value.bindingDigest !== moneyCutoverBindingDigest(binding) ||
        value.evidenceDigest !== value.reviewEvidenceDigest
      ) {
        throw preflightError("money independent review is malformed or differs from exact binding");
      }
      return value as unknown as MoneyReviewProof;
    },
    custody: custody(declaration.custodyDirectory),
    backupPath: declaration.backupPath,
    ...(declaration.classificationManifestPath === undefined
      ? {}
      : {
          classificationManifestPath: declaration.classificationManifestPath,
          classificationManifestDigest: declaration.classificationManifestDigest,
        }),
    outputDirectory: declaration.outputDirectory,
    leaseRoot: declaration.leaseRoot,
    ...(dependencies.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: dependencies.cloudflareEnvironment }),
    ...(dependencies.run === undefined ? {} : { run: dependencies.run }),
  };
}
