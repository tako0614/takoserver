import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError } from "./errors.ts";
import {
  CloudflareIntegrationStorageProvider,
  type IntegrationStorageGenerationInvocation,
  type IntegrationStorageOriginalCreateOptions,
  verifyIntegrationStorageOriginalCreate,
} from "./integration-storage-generation.ts";
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
  type MoneyPost94Phase,
  type MoneyPost94SelectionReviewBinding,
  type MoneyResumeProof,
  type MoneyReviewBinding,
  type MoneyReviewProof,
  type MoneyStageOriginProof,
  type MoneyUnitCutoverOptions,
  type MoneyUnitHeldConvertSourceFacts,
  type MoneyUnitResumeState,
  type MoneyWriterProof,
  moneyCutoverBindingDigest,
  readMoneyUnitHeldConvertFacts,
  readMoneyUnitResumeState,
} from "./schema-money-unit-cutover.ts";
import { exactV2MaintenanceModuleDigest } from "./schema-v2-existing-transition.ts";
import { type DeployTarget, parseDeployTarget } from "./target.ts";
import { probeMoneyCutoverFrozen, probeProduct } from "./worker.ts";
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
  readonly writerEpoch: string;
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
  readonly originCertificatePath?: string;
  readonly originCertificateDigest?: string;
  /** Fresh writer locators only; native original custody remains separately held. */
  readonly originalOrigin?: {
    readonly invocation: IntegrationStorageGenerationInvocation;
    readonly originalTargetPath: string;
  };
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

interface MoneyHeldPost94Declaration extends Omit<Declaration, "kind" | "phase"> {
  readonly kind: "takoserver.money-cutover-owner-post94-declaration@v1";
  readonly phase: MoneyPost94Phase;
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
  readonly convertedBackupPath: string;
  readonly selectedStripeMode: "test";
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

/** The import producer seals 0500/0400; retained legacy custody used 0700/0600. */
function sealedImportBytes(path: string, label: string): Uint8Array {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    relative(REPOSITORY, path) === "" ||
    !relative(REPOSITORY, path).startsWith(`..${sep}`)
  )
    throw preflightError(`${label} must be canonical, absolute and outside the repository`);
  const directory = dirname(path);
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  const identity = (value: BigIntStats) =>
    [
      value.dev,
      value.ino,
      value.uid,
      value.gid,
      value.mode,
      value.nlink,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
    ]
      .map(String)
      .join(":");
  const directoryIdentity = (value: BigIntStats) =>
    [value.dev, value.ino, value.uid, value.gid, value.mode].map(String).join(":");
  const inspectDirectories = () => {
    const identities: string[] = [];
    let leaf: BigIntStats | undefined;
    for (let current = directory; ; current = dirname(current)) {
      const status = lstatSync(current, { bigint: true });
      if (!status.isDirectory() || status.isSymbolicLink())
        throw preflightError(`${label} has an unsafe directory or ancestor`);
      if (leaf === undefined) {
        leaf = status;
        if (
          (uid !== undefined && status.uid !== uid) ||
          ![0o500n, 0o700n].includes(status.mode & 0o777n)
        )
          throw preflightError(`${label} requires an owned exact 0500/0400 or 0700/0600 pair`);
      }
      identities.push(directoryIdentity(status));
      if (current === dirname(current)) break;
    }
    if (leaf === undefined) throw preflightError(`${label} directory is unavailable`);
    return { leaf, identity: identities.join("/") };
  };
  let fd: number | undefined;
  try {
    const parent = inspectDirectories();
    const mode = (parent.leaf.mode & 0o777n) === 0o500n ? 0o400n : 0o600n;
    const validate = (status: BigIntStats) => {
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        (status.mode & 0o777n) !== mode ||
        status.size > BigInt(MAX_PROTECTED_BYTES) ||
        (uid !== undefined && status.uid !== uid)
      )
        throw preflightError(`${label} requires an owned link-free bounded matched-mode import`);
    };
    const named = lstatSync(path, { bigint: true });
    validate(named);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const held = fstatSync(fd, { bigint: true });
    validate(held);
    if (identity(named) !== identity(held)) throw preflightError(`${label} changed while opening`);
    const bytes = new Uint8Array(Number(held.size));
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) throw preflightError(`${label} was truncated`);
      count += read;
    }
    if (
      readSync(fd, new Uint8Array(1), 0, 1, null) !== 0 ||
      identity(fstatSync(fd, { bigint: true })) !== identity(held) ||
      identity(lstatSync(path, { bigint: true })) !== identity(held) ||
      inspectDirectories().identity !== parent.identity
    )
      throw preflightError(`${label} changed during its held read`);
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
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

function parseDeclaration(
  value: unknown,
  target: DeployTarget,
  originalRead = false,
  originalWriter = false,
): Declaration {
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
    "writerEpoch",
    "maintenanceSourceRoot",
    "maintenancePublicationReceiptPath",
    "maintenancePublicationReceiptDigest",
    ...(originalRead ? [] : ["originCertificatePath", "originCertificateDigest"]),
    ...(originalWriter ? ["originalOrigin"] : []),
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
    target.moneyCutoverWriterPolicy !== "transaction-fenced-usd-micros-v1" ||
    target.moneyCutoverWriterEpoch !== value.writerEpoch ||
    !requireSha(value.writerEpoch) ||
    !scopedWorkersDevOrigin(target) ||
    !ACCOUNT.test(target.accountId) ||
    !UUID.test(target.d1.databaseId) ||
    !(
      STAGE.test(target.d1.databaseName) ||
      (originalRead && /^integration-ts-[0-9a-f]{32}$/u.test(target.d1.databaseName))
    ) ||
    target.r2.bucketName !== target.d1.databaseName ||
    !requireCommit(value.maintenanceCommit) ||
    !requireSha(value.maintenanceModuleDigest) ||
    (!originalRead && !requireSha(value.originCertificateDigest)) ||
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

function moneyHeldPost94CommonDeclaration(value: Declaration | MoneyHeldPost94Declaration): string {
  const excluded = new Set([
    "kind",
    "phase",
    "writerEpoch",
    "reviewEvidencePath",
    "resumeCommit",
    "resumeModuleDigest",
    "resumeSourceRoot",
    "resumePublicationReceiptPath",
    "resumePublicationReceiptDigest",
    "previousWriterEpoch",
    "nextWriterEpoch",
    "convertedBackupPath",
    "selectedStripeMode",
  ]);
  const recordValue = value as unknown as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(recordValue)
      .filter((name) => !excluded.has(name))
      .sort()
      .map((name) => [name, recordValue[name]]),
  );
}

/** A protected suffix declaration is selection data, never a new writer grant. */
function parseHeldPost94Declaration(
  value: unknown,
  target: DeployTarget,
  facts: MoneyUnitHeldConvertFacts,
  request: MoneyUnitHeldConvertRequest,
): MoneyHeldPost94Declaration {
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw preflightError("money held post94 declaration is not exact TEST selection data");
  const requiredSelection = [
    "kind",
    "phase",
    "selectedStripeMode",
    "previousWriterEpoch",
    "nextWriterEpoch",
    "convertedBackupPath",
  ] as const;
  const selected = Object.fromEntries(
    requiredSelection.map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        throw preflightError("money held post94 declaration requires own-data TEST selection");
      return [name, descriptor.value];
    }),
  ) as Record<(typeof requiredSelection)[number], unknown>;
  if (
    Reflect.ownKeys(value).some((name) => {
      if (typeof name !== "string") return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    }) ||
    selected.kind !== "takoserver.money-cutover-owner-post94-declaration@v1" ||
    (selected.phase !== "suffix98" && selected.phase !== "resume98") ||
    selected.selectedStripeMode !== "test" ||
    selected.previousWriterEpoch !== facts.previousWriterEpoch ||
    selected.nextWriterEpoch !== facts.nextWriterEpoch ||
    selected.convertedBackupPath !== request.convertedBackupPath
  )
    throw preflightError("money held post94 declaration is not exact TEST selection data");
  const phase = selected.phase;
  // parseDeclaration also reads optional fields; its projection must not
  // inherit same-realm Object.prototype values absent from the protected JSON.
  const projected: Record<string, unknown> = Object.assign(Object.create(null), value);
  for (const name of [
    "previousWriterEpoch",
    "nextWriterEpoch",
    "convertedBackupPath",
    "selectedStripeMode",
  ])
    delete projected[name];
  projected.kind = "takoserver.money-cutover-owner-declaration@v1";
  projected.phase = phase === "suffix98" ? "convert" : "resume";
  parseDeclaration(
    projected,
    phase === "suffix98" ? target : { ...target, moneyCutoverWriterEpoch: facts.nextWriterEpoch },
    true,
    true,
  );
  return value as unknown as MoneyHeldPost94Declaration;
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
  /** Normal authority publication adds maintenance; closure transition retires its mode on resume. */
  readonly resultKind:
    | "takoserver.worker-apply@v2"
    | "takoserver.worker-closure-transition-apply@v1";
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
    !["takoserver.worker-apply@v2", "takoserver.worker-closure-transition-apply@v1"].includes(
      String(value.resultKind),
    ) ||
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

function custody(directory: string, originalRead = false): MoneyCutoverCustody {
  protectedDirectory(directory, "money custody directory");
  const path = (phase: MoneyCutoverPhase, state: "dispatched" | "terminal") => {
    if (
      ![
        "freeze",
        "prepare",
        "classify",
        "convert",
        "resume",
        "abandon",
        "suffix98",
        "resume98",
      ].includes(phase)
    )
      throw preflightError("money custody phase is not a closed owning phase");
    return join(directory, `${phase}.${state}.json`);
  };
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
    const post94 = phase === "suffix98" || phase === "resume98";
    const post94Fields = post94
      ? [
          "previousWriterEpoch",
          "nextWriterEpoch",
          "original92BackupDigest",
          "converted94BackupDigest",
          "convertBindingDigest",
          "modePreparationDigest",
          "selectedStripeMode",
          "selectionReviewDigest",
        ]
      : [];
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
      "writerEpoch",
      "reviewDigest",
      "beforeShapeDigest",
      "afterSchemaPhase",
      "sealedImportPath",
      ...post94Fields,
    ];
    if (
      !record(value) ||
      (post94 &&
        Reflect.ownKeys(value).some((name) => {
          if (typeof name !== "string") return true;
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
        })) ||
      !keys(value, fields) ||
      value.kind !==
        (post94
          ? "takoserver.money-cutover-dispatch@v2"
          : "takoserver.money-cutover-dispatch@v1") ||
      value.phase !== phase ||
      !ACCOUNT.test(String(value.accountId)) ||
      !UUID.test(String(value.databaseId)) ||
      !(
        STAGE.test(String(value.databaseName)) ||
        (originalRead && /^integration-ts-[0-9a-f]{32}$/u.test(String(value.databaseName)))
      ) ||
      !requireCommit(value.sourceCommit) ||
      (post94
        ? value.afterSchemaPhase !== (phase === "suffix98" ? "0098-fenced" : "0098") ||
          value.previousWriterEpoch === value.nextWriterEpoch ||
          value.writerEpoch !==
            (phase === "suffix98" ? value.previousWriterEpoch : value.nextWriterEpoch) ||
          value.original92BackupDigest !== value.backupDigest ||
          value.selectedStripeMode !== "test"
        : !["0092", "0092-fenced", "0093", "0093-fenced", "0094", "0094-fenced"].includes(
            String(value.afterSchemaPhase),
          )) ||
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
        "writerEpoch",
        "reviewDigest",
        "beforeShapeDigest",
        ...post94Fields.filter((field) => field !== "selectedStripeMode"),
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
    const bytes = sealedImportBytes(binding.sealedImportPath, "money sealed import SQL");
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
      const bytes = sealedImportBytes(binding.sealedImportPath, "money sealed import SQL");
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
  expected: "maintenance" | "guarded" | "healthy",
): Promise<void> {
  if (expected === "guarded") {
    await probeMoneyCutoverFrozen(origin, fetcher);
    return;
  }
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
  if (expected === "maintenance") {
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
  // Read selection never grants the historical writer a new namespace.
  if (!STAGE.test(target.d1.databaseName))
    throw preflightError("money cutover writer requires its existing legacy staging origin");
  return loadMoneyUnitOwnerOptions(declarationPath, target, dependencies);
}

export interface MoneyUnitOriginalOriginRead {
  readonly invocation: IntegrationStorageGenerationInvocation;
  readonly originalTarget: DeployTarget;
  readonly custody: IntegrationStorageOriginalCreateOptions;
}

/** Locators select existing custody; no result, status or native proof port is accepted. */
export interface MoneyUnitOriginalCutoverRequest {
  readonly selectedTarget: DeployTarget;
  readonly declarationPath: string;
  readonly originalCreate: IntegrationStorageOriginalCreateOptions;
}

export interface MoneyUnitOriginalCutoverOptions extends MoneyUnitCutoverOptions {
  readonly originalOriginQualification: "independent-origin-review-required";
}

const originalMoneyWriters = new WeakMap<
  MoneyUnitCutoverOptions,
  {
    readonly target: string;
    readonly ownedTarget: DeployTarget;
    readonly assertUnchanged: () => void;
    readonly nativeOnly: boolean;
    readonly phase: MoneyCutoverPhase;
    readonly backupPath: string;
    readonly declarationCommon: string;
    readonly reviewEvidencePath: string;
    readonly methods: {
      readonly stageOriginProof: MoneyUnitCutoverOptions["stageOriginProof"];
      readonly storageIdentityRead: MoneyUnitCutoverOptions["storageIdentityRead"];
      readonly maintenanceProof: MoneyUnitCutoverOptions["maintenanceProof"];
      readonly custody: MoneyCutoverCustody;
      readonly custodyRead: MoneyCutoverCustody["read"];
      readonly custodyReadDispatch: MoneyCutoverCustody["readDispatch"];
    };
  }
>();

/** Checks existing owner provenance only; no caller can register options or mint a grant. */
export function assertMoneyUnitOriginalWriterOptions(
  options: MoneyUnitCutoverOptions,
  target: DeployTarget,
): DeployTarget {
  const selected = originalMoneyWriters.get(options);
  if (
    selected === undefined ||
    selected.target !==
      JSON.stringify(
        parseDeployTarget(
          target,
          "fresh money writer target",
          "integration",
          "money-original-cutover",
        ),
      )
  )
    throw preflightError("fresh money writer requires the same owning original options and target");
  selected.assertUnchanged();
  return selected.ownedTarget;
}

function freezeOriginalMoneyData<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeOriginalMoneyData(child);
    Object.freeze(value);
  }
  return value;
}

function originalMoneyInput(path: string, label: string) {
  protectedDirectory(dirname(path), label);
  if (resolve(path) !== path) throw preflightError(`${label} path must be canonical`);
  const parent = lstatSync(dirname(path), { bigint: true });
  const identity = (value: BigIntStats) =>
    [
      value.dev,
      value.ino,
      value.uid,
      value.gid,
      value.mode,
      value.nlink,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
    ]
      .map(String)
      .join(":");
  const parentIdentity = (value: BigIntStats) =>
    [value.dev, value.ino, value.uid, value.gid, value.mode].map(String).join(":");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw preflightError(`${label} cannot be opened safely`);
  }
  let bytes: Uint8Array;
  let heldIdentity: string;
  try {
    const held = fstatSync(fd, { bigint: true });
    if (
      !held.isFile() ||
      held.nlink !== 1n ||
      (held.mode & 0o777n) !== 0o600n ||
      held.size > BigInt(MAX_PROTECTED_BYTES) ||
      (typeof process.getuid === "function" && held.uid !== BigInt(process.getuid()))
    )
      throw preflightError(`${label} must be an owned single-link bounded 0600 regular file`);
    heldIdentity = identity(held);
    if (identity(lstatSync(path, { bigint: true })) !== heldIdentity)
      throw preflightError(`${label} named and held file differ`);
    const buffer = new Uint8Array(Number(held.size));
    let count = 0;
    while (count < buffer.byteLength) {
      const read = readSync(fd, buffer, count, buffer.byteLength - count, null);
      if (read === 0) throw preflightError(`${label} was truncated`);
      count += read;
    }
    if (
      readSync(fd, new Uint8Array(1), 0, 1, null) !== 0 ||
      identity(fstatSync(fd, { bigint: true })) !== heldIdentity ||
      identity(lstatSync(path, { bigint: true })) !== heldIdentity ||
      parentIdentity(lstatSync(dirname(path), { bigint: true })) !== parentIdentity(parent)
    )
      throw preflightError(`${label} changed during held read`);
    protectedDirectory(dirname(path), label);
    bytes = buffer;
  } finally {
    closeSync(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw preflightError(`${label} is not fatal-UTF8 JSON`);
  }
  const seal = `${heldIdentity}:${parentIdentity(parent)}:${digest(bytes)}`;
  return {
    value,
    seal,
    assertUnchanged() {
      if (originalMoneyInput(path, label).seal !== seal)
        throw preflightError(`${label} changed after selection`);
    },
  };
}

// Only the default-dependencies route can produce a native held-convert source.
// The frozen null-prototype sentinel has no own or inherited ports. Caller-supplied
// objects (including Proxies) cannot obtain its unexported identity. Legacy
// dependency injection remains available below.
const nativeOriginalMoneyDependencies: MoneyUnitOwnerDependencies = Object.freeze(
  Object.create(null),
);

/** Existing cutover owner, explicitly selected with the genuine fresh creator's locators. */
export async function loadMoneyUnitOriginalCutoverOptions(
  request: MoneyUnitOriginalCutoverRequest,
  dependencies: MoneyUnitOwnerDependencies = nativeOriginalMoneyDependencies,
): Promise<MoneyUnitOriginalCutoverOptions> {
  const nativeOnly = dependencies === nativeOriginalMoneyDependencies;
  if (!record(request) || !keys(request, ["selectedTarget", "declarationPath", "originalCreate"]))
    throw preflightError("fresh money writer requires only target and original custody locators");
  const selected = JSON.stringify(request);
  const target = freezeOriginalMoneyData(
    parseDeployTarget(
      structuredClone(request.selectedTarget),
      "fresh money writer target",
      "integration",
      "money-original-cutover",
    ),
  );
  const declarationInput = originalMoneyInput(request.declarationPath, "fresh money declaration");
  const declaration = parseDeclaration(declarationInput.value, target, true, true);
  const origin = declaration.originalOrigin;
  if (
    !record(origin) ||
    !keys(origin, ["invocation", "originalTargetPath"]) ||
    !record(origin.invocation) ||
    !keys(origin.invocation, [
      "action",
      "environment",
      "commit",
      "generation",
      "namespace",
      "freshLineage",
    ]) ||
    origin.invocation.action !== "apply" ||
    origin.invocation.environment !== "integration" ||
    origin.invocation.namespace !== "integration-ts" ||
    origin.invocation.freshLineage !== "v2-0092" ||
    !requireCommit(origin.invocation.commit) ||
    typeof origin.invocation.generation !== "string" ||
    !/^[0-9a-f]{32}$/u.test(origin.invocation.generation) ||
    target.d1.databaseName !== `integration-ts-${origin.invocation.generation}` ||
    typeof origin.originalTargetPath !== "string"
  )
    throw preflightError(
      "fresh money original selection requires the exact original six-field invocation",
    );
  const originalTargetInput = originalMoneyInput(
    origin.originalTargetPath,
    "money original collision target",
  );
  const original: MoneyUnitOriginalOriginRead = freezeOriginalMoneyData({
    invocation: structuredClone(origin.invocation),
    originalTarget: parseDeployTarget(
      originalTargetInput.value,
      origin.originalTargetPath,
      "integration",
    ),
    custody: structuredClone(request.originalCreate),
  });
  const assertUnchanged = () => {
    if (JSON.stringify(request) !== selected)
      throw preflightError("fresh money original selection changed during qualification");
    declarationInput.assertUnchanged();
    originalTargetInput.assertUnchanged();
  };
  // Capture optional ports before awaits, retaining their component provenance.
  const { state, storage, fetcher, publicArtifactBuilder, run, cloudflareEnvironment } =
    dependencies;
  const capturedState =
    state === undefined
      ? undefined
      : (() => {
          const {
            workerDeployments,
            workerVersion,
            workerVersionWithModules,
            workerSecrets,
            workerDomains,
            workerSubdomain,
            workerAccountSubdomain,
          } = state;
          return Object.freeze({
            workerDeployments: workerDeployments.bind(state),
            workerVersion: workerVersion.bind(state),
            workerVersionWithModules: workerVersionWithModules.bind(state),
            workerSecrets: workerSecrets.bind(state),
            workerDomains: workerDomains.bind(state),
            workerSubdomain: workerSubdomain.bind(state),
            workerAccountSubdomain: workerAccountSubdomain.bind(state),
          });
        })();
  const capturedStorage =
    storage === undefined
      ? undefined
      : (() => {
          const { getD1, getR2 } = storage;
          return Object.freeze({ getD1: getD1.bind(storage), getR2: getR2.bind(storage) });
        })();
  // Keep native absence closed and pin the same runner used by the default fallback.
  const ownedDependencies: MoneyUnitOwnerDependencies = Object.freeze({
    __proto__: nativeOnly ? null : Object.prototype,
    ...(nativeOnly ? { run: runCommand } : {}),
    ...(capturedState === undefined ? {} : { state: capturedState }),
    ...(capturedStorage === undefined ? {} : { storage: capturedStorage }),
    ...(fetcher === undefined ? {} : { fetcher }),
    ...(publicArtifactBuilder === undefined ? {} : { publicArtifactBuilder }),
    ...(run === undefined ? {} : { run }),
    ...(cloudflareEnvironment === undefined
      ? {}
      : {
          cloudflareEnvironment: Object.freeze({ ...cloudflareEnvironment }),
        }),
  });
  assertUnchanged();
  const options = await loadMoneyUnitOwnerOptions(
    request.declarationPath,
    target,
    ownedDependencies,
    original,
    { declaration: declarationInput.value, assertUnchanged },
  );
  assertUnchanged();
  const sealed = Object.freeze({
    __proto__: nativeOnly ? null : Object.prototype,
    ...options,
    custody: Object.freeze({
      read: options.custody.read.bind(options.custody),
      readDispatch: options.custody.readDispatch.bind(options.custody),
      dispatch: options.custody.dispatch.bind(options.custody),
      terminal: options.custody.terminal.bind(options.custody),
    }),
    originalOriginQualification: "independent-origin-review-required" as const,
  });
  originalMoneyWriters.set(sealed, {
    target: JSON.stringify(target),
    ownedTarget: target,
    assertUnchanged,
    nativeOnly,
    phase: sealed.phase,
    backupPath: sealed.backupPath,
    declarationCommon: moneyHeldPost94CommonDeclaration(declaration),
    reviewEvidencePath: declaration.reviewEvidencePath,
    methods: Object.freeze({
      stageOriginProof: sealed.stageOriginProof,
      storageIdentityRead: sealed.storageIdentityRead,
      maintenanceProof: sealed.maintenanceProof,
      custody: sealed.custody,
      custodyRead: sealed.custody.read,
      custodyReadDispatch: sealed.custody.readDispatch,
    }),
  });
  return sealed;
}

/** Explicit suffix request, held separately from historical and native mode facts. */
export interface MoneyUnitHeldConvertRequest {
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
  readonly convertedBackupPath: string;
  readonly selectedStripeMode: "test";
}

export type MoneyUnitHeldConvertFacts = Omit<MoneyUnitHeldConvertSourceFacts, "qualification"> & {
  readonly selectedStripeMode: "test";
};

declare const moneyUnitHeldConvertBrand: unique symbol;

/** Runtime identity is minted and checked by the original owner, never by this shape. */
export interface MoneyUnitHeldConvertContext {
  readonly [moneyUnitHeldConvertBrand]: true;
  readonly kind: "takoserver.money-held-convert-context@v1";
  readonly facts: MoneyUnitHeldConvertFacts;
}

const heldMoneyContexts = new WeakMap<
  object,
  {
    readonly options: MoneyUnitOriginalCutoverOptions;
    readonly target: DeployTarget;
    readonly request: MoneyUnitHeldConvertRequest;
    readonly selection: string;
    readonly facts: MoneyUnitHeldConvertFacts;
    readonly factsJson: string;
  }
>();

function ownMoneyValue(receiver: object, name: string, expected: unknown): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, name);
  return descriptor !== undefined && "value" in descriptor && descriptor.value === expected;
}

function heldMoneySelection(request: MoneyUnitHeldConvertRequest): MoneyUnitHeldConvertRequest {
  const names = record(request) ? Reflect.ownKeys(request) : [];
  if (
    !record(request) ||
    names.some((name) => typeof name !== "string") ||
    names.sort().join(",") !==
      "convertedBackupPath,nextWriterEpoch,previousWriterEpoch,selectedStripeMode"
  )
    throw preflightError("money held convert requires only exact source request fields");
  const selected = Object.fromEntries(
    ["previousWriterEpoch", "nextWriterEpoch", "convertedBackupPath", "selectedStripeMode"].map(
      (name) => {
        const descriptor = Object.getOwnPropertyDescriptor(request, name);
        if (descriptor === undefined || !("value" in descriptor))
          throw preflightError("money held convert request fields must be own data");
        return [name, descriptor.value];
      },
    ),
  ) as unknown as MoneyUnitHeldConvertRequest;
  if (
    !SHA.test(selected.previousWriterEpoch) ||
    !SHA.test(selected.nextWriterEpoch) ||
    selected.previousWriterEpoch === selected.nextWriterEpoch ||
    typeof selected.convertedBackupPath !== "string" ||
    !isAbsolute(selected.convertedBackupPath) ||
    resolve(selected.convertedBackupPath) !== selected.convertedBackupPath ||
    selected.selectedStripeMode !== "test"
  )
    throw preflightError("money held convert source selection is invalid");
  return Object.freeze(selected);
}

function originalHeldMoneyOwner(options: MoneyUnitOriginalCutoverOptions): DeployTarget {
  const selected = originalMoneyWriters.get(options);
  if (
    selected === undefined ||
    !selected.nativeOnly ||
    selected.phase !== "convert" ||
    !ownMoneyValue(options, "phase", selected.phase) ||
    !ownMoneyValue(options, "backupPath", selected.backupPath) ||
    !ownMoneyValue(options, "stageOriginProof", selected.methods.stageOriginProof) ||
    !ownMoneyValue(options, "storageIdentityRead", selected.methods.storageIdentityRead) ||
    !ownMoneyValue(options, "maintenanceProof", selected.methods.maintenanceProof) ||
    !ownMoneyValue(options, "custody", selected.methods.custody) ||
    !ownMoneyValue(selected.methods.custody, "read", selected.methods.custodyRead) ||
    !ownMoneyValue(selected.methods.custody, "readDispatch", selected.methods.custodyReadDispatch)
  )
    throw preflightError("money held convert requires unchanged native original owner methods");
  return assertMoneyUnitOriginalWriterOptions(options, selected.ownedTarget);
}

/**
 * Creates an opaque physical/custody/history context from the genuine original
 * native owner. Requested TEST is intent only, never historical or native mode
 * qualification. This reader cannot import, dispatch, or release a freeze.
 */
export async function readMoneyUnitHeldConvertContext(
  options: MoneyUnitOriginalCutoverOptions,
  request: MoneyUnitHeldConvertRequest,
): Promise<MoneyUnitHeldConvertContext> {
  const target = originalHeldMoneyOwner(options);
  const selected = heldMoneySelection(request);
  if (
    selected.previousWriterEpoch !== options.writerEpoch ||
    resolve(selected.convertedBackupPath) === resolve(options.backupPath)
  )
    throw preflightError("money held convert selection differs from the original owner");
  const source = await readMoneyUnitHeldConvertFacts({
    target,
    options,
    previousWriterEpoch: selected.previousWriterEpoch,
    nextWriterEpoch: selected.nextWriterEpoch,
    convertedBackupPath: selected.convertedBackupPath,
  });
  if (
    originalHeldMoneyOwner(options) !== target ||
    JSON.stringify(heldMoneySelection(request)) !== JSON.stringify(selected)
  )
    throw preflightError("money held convert request changed during observation");
  const { qualification, ...sourceFacts } = source;
  if (qualification !== "component-simulation-only")
    throw preflightError("money held convert lower fact reader changed qualification");
  const facts: MoneyUnitHeldConvertFacts = freezeOriginalMoneyData(
    structuredClone({ ...sourceFacts, selectedStripeMode: selected.selectedStripeMode }),
  );
  const context = Object.freeze({
    kind: "takoserver.money-held-convert-context@v1" as const,
    facts,
  }) as MoneyUnitHeldConvertContext;
  heldMoneyContexts.set(context, {
    options,
    target,
    request,
    selection: JSON.stringify(selected),
    facts,
    factsJson: JSON.stringify(facts),
  });
  return context;
}

/** Re-runs the same original owner and complete held read before future dispatch. */
export async function assertMoneyUnitHeldConvertCurrent(context: unknown): Promise<void> {
  const held =
    typeof context === "object" && context !== null ? heldMoneyContexts.get(context) : undefined;
  if (
    held === undefined ||
    !ownMoneyValue(context as object, "kind", "takoserver.money-held-convert-context@v1") ||
    !ownMoneyValue(context as object, "facts", held.facts) ||
    JSON.stringify(heldMoneySelection(held.request)) !== held.selection
  )
    throw preflightError("money held convert context or source request differs");
  const target = originalHeldMoneyOwner(held.options);
  if (target !== held.target || JSON.stringify(held.facts) !== held.factsJson)
    throw preflightError("money held convert owner or detached facts changed");
  const selected = heldMoneySelection(held.request);
  const current = await readMoneyUnitHeldConvertFacts({
    target,
    options: held.options,
    previousWriterEpoch: selected.previousWriterEpoch,
    nextWriterEpoch: selected.nextWriterEpoch,
    convertedBackupPath: selected.convertedBackupPath,
  });
  if (
    originalHeldMoneyOwner(held.options) !== target ||
    JSON.stringify(heldMoneySelection(held.request)) !== held.selection
  )
    throw preflightError("money held convert source changed during currentness read");
  const { qualification, ...currentFacts } = current;
  if (
    qualification !== "component-simulation-only" ||
    JSON.stringify({ ...currentFacts, selectedStripeMode: selected.selectedStripeMode }) !==
      held.factsJson
  )
    throw preflightError("money held convert physical or custody facts changed");
}

declare const moneyUnitHeldPost94SelectionBrand: unique symbol;

/** Protected declaration and review data only; no mode or Financial authority. */
export interface MoneyUnitHeldPost94Selection {
  readonly [moneyUnitHeldPost94SelectionBrand]: true;
  readonly kind: "takoserver.money-held-post94-selection@v1";
  readonly phase: MoneyPost94Phase;
  readonly selectedStripeMode: "test";
  readonly declarationDigest: string;
  readonly reviewBinding: MoneyPost94SelectionReviewBinding;
  readonly selectionReviewDigest: string;
}

const heldPost94Selections = new WeakMap<
  object,
  {
    readonly context: MoneyUnitHeldConvertContext;
    readonly declarationPath: string;
    readonly declarationSeal: string;
    readonly declarationJson: string;
    readonly declarationDigest: string;
    readonly reviewBinding: MoneyPost94SelectionReviewBinding;
    readonly selectionReviewDigest: string;
  }
>();

/** Reads a second protected declaration through the original held context only. */
export async function readMoneyUnitHeldPost94Selection(
  context: MoneyUnitHeldConvertContext,
  declarationPath: string,
): Promise<MoneyUnitHeldPost94Selection> {
  await assertMoneyUnitHeldConvertCurrent(context);
  const held = heldMoneyContexts.get(context);
  if (
    held === undefined ||
    typeof declarationPath !== "string" ||
    !isAbsolute(declarationPath) ||
    resolve(declarationPath) !== declarationPath
  )
    throw preflightError("money held post94 requires original context and canonical declaration");
  const original = originalMoneyWriters.get(held.options);
  if (original === undefined)
    throw preflightError("money held post94 original declaration is unavailable");
  const input = originalMoneyInput(declarationPath, "money held post94 declaration");
  const declaration = parseHeldPost94Declaration(
    input.value,
    held.target,
    held.facts,
    held.request,
  );
  if (
    moneyHeldPost94CommonDeclaration(declaration) !== original.declarationCommon ||
    resolve(declaration.reviewEvidencePath) === resolve(original.reviewEvidencePath)
  )
    throw preflightError("money held post94 declaration differs from the original owner");
  const declarationJson = JSON.stringify(declaration);
  const declarationDigest = digest(declarationJson);
  const facts = held.facts;
  const reviewBinding: MoneyPost94SelectionReviewBinding = Object.freeze({
    kind: "takoserver.money-post94-selection-review@v1",
    phase: declaration.phase,
    accountId: facts.storage.accountId,
    databaseId: facts.storage.databaseId,
    databaseName: facts.storage.databaseName,
    previousWriterEpoch: facts.previousWriterEpoch,
    nextWriterEpoch: facts.nextWriterEpoch,
    original92BackupDigest: facts.original92.backupDigest,
    converted94BackupDigest: facts.converted94.backupDigest,
    convertBindingDigest: facts.conversion.convertBindingDigest,
    selectedStripeMode: facts.selectedStripeMode,
    declarationDigest,
  });
  const selectionReviewDigest = moneyCutoverBindingDigest(reviewBinding);
  await assertMoneyUnitHeldConvertCurrent(context);
  input.assertUnchanged();
  const selection = Object.freeze({
    kind: "takoserver.money-held-post94-selection@v1" as const,
    phase: declaration.phase,
    selectedStripeMode: facts.selectedStripeMode,
    declarationDigest,
    reviewBinding,
    selectionReviewDigest,
  }) as MoneyUnitHeldPost94Selection;
  heldPost94Selections.set(selection, {
    context,
    declarationPath,
    declarationSeal: input.seal,
    declarationJson,
    declarationDigest,
    reviewBinding,
    selectionReviewDigest,
  });
  return selection;
}

/** Rechecks original facts and the same protected declaration before future use. */
export async function assertMoneyUnitHeldPost94SelectionCurrent(selection: unknown): Promise<void> {
  const selected =
    typeof selection === "object" && selection !== null
      ? heldPost94Selections.get(selection)
      : undefined;
  if (
    selected === undefined ||
    !ownMoneyValue(selection as object, "kind", "takoserver.money-held-post94-selection@v1") ||
    !ownMoneyValue(selection as object, "declarationDigest", selected.declarationDigest) ||
    !ownMoneyValue(selection as object, "reviewBinding", selected.reviewBinding) ||
    !ownMoneyValue(selection as object, "selectionReviewDigest", selected.selectionReviewDigest)
  )
    throw preflightError("money held post94 selection is not the original owner selection");
  await assertMoneyUnitHeldConvertCurrent(selected.context);
  const held = heldMoneyContexts.get(selected.context);
  const original = held === undefined ? undefined : originalMoneyWriters.get(held.options);
  if (held === undefined || original === undefined)
    throw preflightError("money held post94 original owner disappeared");
  const input = originalMoneyInput(selected.declarationPath, "money held post94 declaration");
  const declaration = parseHeldPost94Declaration(
    input.value,
    held.target,
    held.facts,
    held.request,
  );
  if (
    input.seal !== selected.declarationSeal ||
    JSON.stringify(declaration) !== selected.declarationJson ||
    moneyHeldPost94CommonDeclaration(declaration) !== original.declarationCommon ||
    resolve(declaration.reviewEvidencePath) === resolve(original.reviewEvidencePath) ||
    !ownMoneyValue(selection as object, "phase", declaration.phase) ||
    !ownMoneyValue(selection as object, "selectedStripeMode", declaration.selectedStripeMode) ||
    moneyCutoverBindingDigest(selected.reviewBinding) !== selected.selectionReviewDigest
  )
    throw preflightError("money held post94 declaration or review selection changed");
  await assertMoneyUnitHeldConvertCurrent(selected.context);
  input.assertUnchanged();
}

/** Requires the selection and consumer input to be the same opaque held origin. */
export async function assertMoneyUnitHeldPost94SelectionOrigin(
  selection: unknown,
  context: unknown,
): Promise<void> {
  await assertMoneyUnitHeldPost94SelectionCurrent(selection);
  const selected =
    typeof selection === "object" && selection !== null
      ? heldPost94Selections.get(selection)
      : undefined;
  if (selected === undefined || selected.context !== context)
    throw preflightError("money held post94 selection differs from the supplied held context");
  await assertMoneyUnitHeldConvertCurrent(context);
}

/**
 * Compares future dispatch data to the held selection. This never qualifies
 * the Financial contribution or the normal Worker modePreparationDigest.
 */
export async function assertMoneyUnitHeldPost94DispatchSelection(
  selection: MoneyUnitHeldPost94Selection,
  binding: unknown,
): Promise<void> {
  await assertMoneyUnitHeldPost94SelectionCurrent(selection);
  const selected = heldPost94Selections.get(selection);
  const held = selected === undefined ? undefined : heldMoneyContexts.get(selected.context);
  if (selected === undefined || held === undefined)
    throw preflightError("money held post94 dispatch lacks its original selection");
  const facts = held.facts;
  if (
    !record(binding) ||
    !ownMoneyValue(binding, "kind", "takoserver.money-cutover-dispatch@v2") ||
    !ownMoneyValue(binding, "phase", selection.phase) ||
    !ownMoneyValue(binding, "selectedStripeMode", "test") ||
    !ownMoneyValue(binding, "selectionReviewDigest", selected.selectionReviewDigest) ||
    !ownMoneyValue(
      binding,
      "writerEpoch",
      selection.phase === "suffix98" ? facts.previousWriterEpoch : facts.nextWriterEpoch,
    ) ||
    !ownMoneyValue(binding, "accountId", facts.storage.accountId) ||
    !ownMoneyValue(binding, "databaseId", facts.storage.databaseId) ||
    !ownMoneyValue(binding, "databaseName", facts.storage.databaseName) ||
    !ownMoneyValue(binding, "previousWriterEpoch", facts.previousWriterEpoch) ||
    !ownMoneyValue(binding, "nextWriterEpoch", facts.nextWriterEpoch) ||
    !ownMoneyValue(binding, "original92BackupDigest", facts.original92.backupDigest) ||
    !ownMoneyValue(binding, "backupDigest", facts.original92.backupDigest) ||
    !ownMoneyValue(binding, "converted94BackupDigest", facts.converted94.backupDigest) ||
    !ownMoneyValue(binding, "convertBindingDigest", facts.conversion.convertBindingDigest) ||
    !ownMoneyValue(binding, "originDigest", facts.conversion.originDigest) ||
    !ownMoneyValue(binding, "preimageDigest", facts.conversion.preimageDigest) ||
    !ownMoneyValue(binding, "aggregateDigest", facts.conversion.aggregateDigest) ||
    !ownMoneyValue(binding, "classificationDigest", facts.conversion.classificationDigest)
  )
    throw preflightError("money held post94 dispatch differs from its TEST selection");
}

export interface MoneyUnitResumeReadRequest {
  readonly selectedTarget: DeployTarget;
  readonly declarationPath: string;
  /** Original locators, never a saved original-create result or certificate. */
  readonly original?: MoneyUnitOriginalOriginRead;
}

export interface MoneyUnitResumeReadback extends MoneyUnitResumeState {
  readonly qualification: "provider-native-readback" | "component-simulation-only";
  readonly originalOriginQualification:
    | "independent-origin-review-required"
    | "legacy-reviewed-origin";
}

/** Reads existing authority; it cannot dispatch, reconcile or terminalize a transition. */
export async function readIntegrationMoneyUnitResumeState(
  request: MoneyUnitResumeReadRequest,
  dependencies: MoneyUnitOwnerDependencies = {},
): Promise<MoneyUnitResumeReadback> {
  // Capture each port synchronously once. All awaited owners consume this owned
  // snapshot, so later removal/addition/replacement cannot change its authority.
  const { state, storage, fetcher, publicArtifactBuilder, run, cloudflareEnvironment } =
    dependencies;
  const ownedDependencies: MoneyUnitOwnerDependencies = Object.freeze({
    ...(state === undefined ? {} : { state }),
    ...(storage === undefined ? {} : { storage }),
    ...(fetcher === undefined ? {} : { fetcher }),
    ...(publicArtifactBuilder === undefined ? {} : { publicArtifactBuilder }),
    ...(run === undefined ? {} : { run }),
    ...(cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: Object.freeze({ ...cloudflareEnvironment }) }),
  });
  const componentObservation =
    state !== undefined ||
    storage !== undefined ||
    fetcher !== undefined ||
    publicArtifactBuilder !== undefined;
  const target = request.selectedTarget;
  if (
    Object.keys(request).some(
      (key) => !["selectedTarget", "declarationPath", "original"].includes(key),
    ) ||
    target.environment !== "integration" ||
    (request.original !== undefined &&
      (Object.keys(request.original).sort().join(",") !== "custody,invocation,originalTarget" ||
        !/^integration-ts-[0-9a-f]{32}$/u.test(target.d1.databaseName))) ||
    (!STAGE.test(target.d1.databaseName) && request.original === undefined)
  )
    throw preflightError("money resume read requires exact target and original-origin locators");
  const snapshot = JSON.stringify(request);
  const assertSelection = () => {
    if (JSON.stringify(request) !== snapshot)
      throw preflightError("money resume read selection changed during observation");
  };
  const options = await loadMoneyUnitOwnerOptions(
    request.declarationPath,
    target,
    ownedDependencies,
    request.original,
  );
  assertSelection();
  const readback = await readMoneyUnitResumeState(target, options);
  assertSelection();
  return {
    ...readback,
    originalOriginQualification:
      request.original === undefined
        ? "legacy-reviewed-origin"
        : "independent-origin-review-required",
    qualification: componentObservation ? "component-simulation-only" : "provider-native-readback",
  };
}

async function loadMoneyUnitOwnerOptions(
  declarationPath: string,
  target: DeployTarget,
  dependencies: MoneyUnitOwnerDependencies,
  originalRead?: MoneyUnitOriginalOriginRead,
  originalWriter?: { readonly declaration: unknown; readonly assertUnchanged: () => void },
): Promise<MoneyUnitCutoverOptions> {
  const declaration = parseDeclaration(
    originalWriter === undefined
      ? protectedJson(declarationPath, "money owner declaration")
      : originalWriter.declaration,
    target,
    originalRead !== undefined,
    originalWriter !== undefined,
  );
  for (const directory of [
    declaration.custodyDirectory,
    declaration.outputDirectory,
    declaration.leaseRoot,
  ])
    protectedDirectory(directory, "money owner directory");
  const readOrigin = async (): Promise<MoneyStageOriginProof> => {
    originalWriter?.assertUnchanged();
    if (originalRead === undefined) {
      if (
        declaration.originCertificatePath === undefined ||
        declaration.originCertificateDigest === undefined
      )
        throw preflightError("money legacy origin certificate selector is incomplete");
      return parseOrigin(
        protectedJson(
          declaration.originCertificatePath,
          "money 0092 origin",
          declaration.originCertificateDigest,
        ),
        target,
      );
    }
    const observed = await verifyIntegrationStorageOriginalCreate(
      originalRead.invocation,
      originalRead.originalTarget,
      target,
      {
        originalCreate: originalRead.custody,
        ...(dependencies.run === undefined ? {} : { run: dependencies.run }),
        ...(dependencies.cloudflareEnvironment === undefined
          ? {}
          : { cloudflareEnvironment: dependencies.cloudflareEnvironment }),
      },
    );
    originalWriter?.assertUnchanged();
    if (
      observed.qualification !== "independent-origin-review-required" ||
      observed.originalCreate.kind !== "takoserver.integration-fresh-0092-original-create@v1" ||
      observed.originalCreate.authority !== "provider-native" ||
      observed.nativeReadback.authority !== "provider-native" ||
      observed.originalCreate.migrationDigest !== SOURCE_0092
    )
      throw preflightError("money resume read requires the genuine native original 0092 custody");
    if (
      originalWriter !== undefined &&
      (observed.originalCreate.sourceCommit !== originalRead.invocation.commit ||
        observed.originalCreate.accountId !== target.accountId ||
        observed.originalCreate.databaseId !== target.d1.databaseId ||
        observed.originalCreate.databaseName !== target.d1.databaseName ||
        observed.originalCreate.bucketName !== target.r2.bucketName ||
        observed.nativeReadback.accountId !== target.accountId ||
        observed.nativeReadback.d1.databaseId !== target.d1.databaseId ||
        observed.nativeReadback.d1.databaseName !== target.d1.databaseName ||
        observed.nativeReadback.r2.bucketName !== target.r2.bucketName)
    )
      throw preflightError("fresh money original and current primary identities differ");
    return {
      kind: "takoserver.money-stage-origin@v1",
      state: "terminal",
      accountId: observed.originalCreate.accountId,
      databaseId: observed.originalCreate.databaseId,
      databaseName: observed.originalCreate.databaseName,
      bucketName: observed.originalCreate.bucketName,
      sourceDigest: SOURCE_0092,
      sourceCommit: observed.originalCreate.sourceCommit,
      terminalCustodyDigest: observed.originalCreate.terminalCustodyDigest,
    };
  };
  await readOrigin();
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
    const writerPolicy = optionalExactPlainTextBinding(
      "preflight",
      live.history.versionId,
      version,
      "TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY",
    );
    if (writerPolicy !== "transaction-fenced-usd-micros-v1")
      throw preflightError("money public Worker native transaction writer policy differs");
    const writerEpoch = optionalExactPlainTextBinding(
      "preflight",
      live.history.versionId,
      version,
      "TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH",
    );
    if (writerEpoch !== declaration.writerEpoch || writerEpoch !== target.moneyCutoverWriterEpoch)
      throw preflightError("money public Worker native Writer epoch differs");
    if (maintenance) await probe(target.publicOrigin, fetcher, "maintenance");
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
    writerEpoch: declaration.writerEpoch,
    maintenanceCommit: declaration.maintenanceCommit,
    ...(declaration.resumeCommit === undefined ? {} : { resumeCommit: declaration.resumeCommit }),
    stageOriginProof: readOrigin,
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
        writerEpoch: declaration.writerEpoch,
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
        writerContainmentPolicy: "transaction-fenced-usd-micros-v1",
        writerEpoch: declaration.writerEpoch,
        publicPublicationDigest: publicWorker.publicPublicationDigest,
        publicSourceArtifactDigest: publicWorker.publicSourceArtifactDigest,
        ...privateProof,
      };
    },
    async resumeHealthRead(expected): Promise<void> {
      await probe(target.publicOrigin, fetcher, expected);
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
    custody: custody(declaration.custodyDirectory, originalRead !== undefined),
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
