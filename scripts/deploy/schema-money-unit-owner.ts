import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type * as TypeScript from "typescript";
import { SHARED_AUTH_STAGING_PROFILE } from "../../src/shared-auth-oidc-client.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError } from "./errors.ts";
import {
  CloudflareIntegrationStorageProvider,
  type IntegrationStorageGenerationInvocation,
  type IntegrationStorageOriginalCreateOptions,
  verifyIntegrationStorageOriginalCreate,
} from "./integration-storage-generation.ts";
import {
  readIntegrationMoneyMaintenancePublicationOriginal,
  readIntegrationMoneyMaintenanceSuccessorOriginal,
} from "./integration-worker-bootstrap.ts";
import {
  captureMoneyNativeBuildClosure,
  type MoneyNativeBuildClosure,
} from "./money-native-build-closure.ts";
import {
  type CommandResult,
  REPOSITORY,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import { expectedWorkerSecrets, writeWorkerConfig } from "./realized-config.ts";
import {
  captureMoneyUnitConverted94Backup,
  type MoneyCustodyPhase,
  type MoneyCutoverCustody,
  type MoneyCutoverCustodyReceipt,
  type MoneyCutoverDispatchBinding,
  type MoneyCutoverPhase,
  type MoneyHeldNormalWorkerModeFacts,
  type MoneyPost94ImportReviewBinding,
  type MoneyPost94Phase,
  type MoneyPost94SelectionReviewBinding,
  type MoneyPreserved100ReviewBinding,
  type MoneyResumeProof,
  type MoneyReviewBinding,
  type MoneyReviewProof,
  type MoneyStageOriginProof,
  type MoneyUnitConverted94BackupData,
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
import {
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  optionalExactPlainTextBinding,
  parseWorkerDeploymentHistory,
  parseWorkerSecretInventory,
  versionSecretBindingNames,
} from "./worker-state.ts";
import { parseWranglerVersionUploadOutput } from "./wrangler-state.ts";

const SHA = /^sha256:[0-9a-f]{64}$/u;

const RETAINED_INACTIVE_UPLOAD_ENTRIES = [
  "CUSTODY",
  "INTENT.json",
  "REQUEST.json",
  "SIGNING-GENESIS.json",
  "build-owner",
  "wrangler-version-upload.jsonl",
];

/**
 * Read-only witness for the script secret store of the original maintenance
 * Worker after the first normal-Version upload (outcome UNKNOWN). Uploading
 * an inactive Version with --secrets-file puts its secret names into the
 * script store although the served maintenance Version binds none. The names
 * are accepted only when the retained upload root, its CUSTODY files, its
 * signing genesis and a GET of the uploaded (never served) Version all name
 * exactly the same secrets. This grants nothing: it is DATA that lets the
 * existing exact checks continue, and any other inventory still refuses.
 */
export async function readRetainedInactiveUploadWitness(input: {
  readonly root: string;
  readonly workerName: string;
  readonly allowedNames: readonly string[];
  readonly workerVersion: (workerName: string, versionId: string) => Promise<unknown>;
}): Promise<{
  readonly names: readonly string[];
  readonly versionId: string;
  assertCurrent(): void;
}> {
  const refuse = (): never => {
    throw preflightError(
      "money maintenance Worker secret store differs from its retained inactive upload",
    );
  };
  let entries: string[];
  try {
    if (!lstatSync(input.root).isDirectory()) return refuse();
    entries = readdirSync(input.root).sort();
  } catch {
    return refuse();
  }
  if (JSON.stringify(entries) !== JSON.stringify([...RETAINED_INACTIVE_UPLOAD_ENTRIES].sort()))
    return refuse();
  const custody = join(input.root, "CUSTODY");
  const names = readdirSync(custody).sort();
  if (names.length === 0 || names.some((name) => !input.allowedNames.includes(name)))
    return refuse();
  const files = [
    join(input.root, "SIGNING-GENESIS.json"),
    join(input.root, "wrangler-version-upload.jsonl"),
    ...names.map((name) => join(custody, name)),
  ];
  const seal = () =>
    files.map((path) => {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) return refuse();
      return [path, stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
    });
  const before = seal();
  let genesisNames: unknown;
  let versionId: string;
  try {
    genesisNames = (
      JSON.parse(readFileSync(join(input.root, "SIGNING-GENESIS.json"), "utf8")) as {
        secretNames?: unknown;
      }
    ).secretNames;
    versionId = parseWranglerVersionUploadOutput(
      readFileSync(join(input.root, "wrangler-version-upload.jsonl"), "utf8"),
      input.workerName,
    ).versionId;
  } catch {
    return refuse();
  }
  if (
    !Array.isArray(genesisNames) ||
    JSON.stringify([...genesisNames].sort()) !== JSON.stringify(names)
  )
    return refuse();
  const bound = versionSecretBindingNames(
    "preflight",
    versionId,
    await input.workerVersion(input.workerName, versionId),
  );
  if (JSON.stringify(bound) !== JSON.stringify(names)) return refuse();
  return Object.freeze({
    names: Object.freeze(names),
    versionId,
    assertCurrent() {
      if (JSON.stringify(seal()) !== JSON.stringify(before)) refuse();
    },
  });
}
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
 * DATA classification only: the owning scope reader separately authenticates
 * the maintenance profile through its native original publication context.
 */
function standaloneMoneyTargetData(target: DeployTarget): boolean {
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
    (target.schemaMaintenanceMode === undefined ||
      target.schemaMaintenanceMode === "pre-wallet-usd-micros-quiesced")
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
    (standaloneMoneyTargetData(target)
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
      !standaloneMoneyTargetData(target) ||
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
  readonly surface:
    | "takoserver-worker-authority-cutover"
    | "takoserver-integration-worker-bootstrap";
  readonly originalCreateTerminalCustodyDigest?: string;
  readonly originalMaintenanceDispatchDigest?: string;
  readonly originalMaintenanceTerminalCustodyDigest?: string;
  readonly originalMaintenanceSourceCommit?: string;
  readonly originalMaintenanceSuccessorDispatchDigest?: string;
  readonly originalMaintenanceSuccessorTerminalCustodyDigest?: string;
  /** Normal authority publication adds maintenance; closure transition retires its mode on resume. */
  readonly resultKind:
    | "takoserver.worker-apply@v2"
    | "takoserver.worker-closure-transition-apply@v1"
    | "takoserver.integration-worker-bootstrap-original-money-maintenance-apply@v1"
    | "takoserver.integration-worker-original-money-maintenance-successor-apply@v1";
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
  originalMaintenance?: {
    readonly originalCreate: IntegrationStorageOriginalCreateOptions;
    readonly terminalCustodyDigest: string;
  },
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
  const originalBootstrap =
    record(value) &&
    value.resultKind ===
      "takoserver.integration-worker-bootstrap-original-money-maintenance-apply@v1";
  const originalSuccessor =
    record(value) &&
    value.resultKind ===
      "takoserver.integration-worker-original-money-maintenance-successor-apply@v1";
  const originalFields = [
    "originalCreateTerminalCustodyDigest",
    "originalMaintenanceDispatchDigest",
    "originalMaintenanceTerminalCustodyDigest",
  ];
  const successorFields = [
    "originalCreateTerminalCustodyDigest",
    "originalMaintenanceSourceCommit",
    "originalMaintenanceDispatchDigest",
    "originalMaintenanceSuccessorDispatchDigest",
    "originalMaintenanceSuccessorTerminalCustodyDigest",
  ];
  if (
    !record(value) ||
    !keys(value, [
      ...fields,
      ...(originalBootstrap ? originalFields : originalSuccessor ? successorFields : []),
    ]) ||
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
    (originalBootstrap || originalSuccessor
      ? value.surface !== "takoserver-integration-worker-bootstrap" ||
        phase !== "maintenance" ||
        originalMaintenance === undefined ||
        value.originalCreateTerminalCustodyDigest !== originalMaintenance.terminalCustodyDigest ||
        !requireSha(value.originalMaintenanceDispatchDigest) ||
        (originalSuccessor
          ? !requireCommit(value.originalMaintenanceSourceCommit) ||
            !requireSha(value.originalMaintenanceSuccessorDispatchDigest) ||
            !requireSha(value.originalMaintenanceSuccessorTerminalCustodyDigest)
          : !requireSha(value.originalMaintenanceTerminalCustodyDigest))
      : value.surface !== "takoserver-worker-authority-cutover" ||
        !["takoserver.worker-apply@v2", "takoserver.worker-closure-transition-apply@v1"].includes(
          String(value.resultKind),
        )) ||
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
  if (originalBootstrap) {
    if (originalMaintenance === undefined)
      throw preflightError("original maintenance native owner is unavailable");
    const retained = readIntegrationMoneyMaintenancePublicationOriginal(
      originalMaintenance.originalCreate,
      target,
      commit,
      originalMaintenance.terminalCustodyDigest,
    );
    if (
      retained === null ||
      retained.result === null ||
      retained.dispatchDigest !== value.originalMaintenanceDispatchDigest ||
      retained.terminalDigest !== value.originalMaintenanceTerminalCustodyDigest ||
      retained.resultDigest !== value.resultDigest ||
      retained.result.deploymentId !== value.deploymentId ||
      retained.result.versionId !== value.versionId ||
      retained.result.bundleDigest !== value.bundleDigest ||
      retained.result.artifactDigest !== value.artifactDigest ||
      retained.result.artifactBytes !== value.artifactBytes ||
      retained.result.artifactFiles !== value.artifactFiles
    )
      throw preflightError(
        "money original maintenance receipt differs from the original source-built publication custody",
      );
  }
  if (originalSuccessor) {
    if (originalMaintenance === undefined)
      throw preflightError("original maintenance native owner is unavailable");
    const retained = readIntegrationMoneyMaintenanceSuccessorOriginal(
      originalMaintenance.originalCreate,
      target,
      commit,
      originalMaintenance.terminalCustodyDigest,
    );
    if (
      retained === null ||
      retained.result === null ||
      retained.originalFirst.result !== null ||
      retained.originalFirst.resultDigest !== null ||
      retained.originalFirst.terminalDigest !== null ||
      retained.originalFirst.dispatchDigest !== value.originalMaintenanceDispatchDigest ||
      retained.originalFirst.binding.sourceCommit !== value.originalMaintenanceSourceCommit ||
      retained.binding.originalDispatchDigest !== value.originalMaintenanceDispatchDigest ||
      retained.binding.originalSourceCommit !== value.originalMaintenanceSourceCommit ||
      retained.dispatchDigest !== value.originalMaintenanceSuccessorDispatchDigest ||
      retained.terminalDigest !== value.originalMaintenanceSuccessorTerminalCustodyDigest ||
      retained.resultDigest !== value.resultDigest ||
      retained.result.kind !==
        "takoserver.integration-worker-original-money-maintenance-successor-apply@v1" ||
      retained.result.originalSourceCommit !== value.originalMaintenanceSourceCommit ||
      retained.result.originalDispatchDigest !== value.originalMaintenanceDispatchDigest ||
      retained.result.originalCreateTerminalCustodyDigest !==
        originalMaintenance.terminalCustodyDigest ||
      retained.result.writerEpoch !== target.moneyCutoverWriterEpoch ||
      retained.result.originalDispatchPreserved !== true ||
      retained.result.originalTerminalRecovery !== "not-manufactured-by-successor" ||
      retained.result.deploymentId !== value.deploymentId ||
      retained.result.versionId !== value.versionId ||
      retained.result.bundleDigest !== value.bundleDigest ||
      retained.result.artifactDigest !== value.artifactDigest ||
      retained.result.artifactBytes !== value.artifactBytes ||
      retained.result.artifactFiles !== value.artifactFiles
    )
      throw preflightError(
        "money original maintenance successor receipt differs from distinct source-built publication custody",
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
  const path = (phase: MoneyCustodyPhase, state: "dispatched" | "terminal") => {
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
        "preserved100",
      ].includes(phase)
    )
      throw preflightError("money custody phase is not a closed owning phase");
    return join(directory, `${phase}.${state}.json`);
  };
  const parseReceipt = (
    value: unknown,
    phase: MoneyCustodyPhase,
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
  const parseBinding = (value: unknown, phase: MoneyCustodyPhase): MoneyCutoverDispatchBinding => {
    const preserved100 = phase === "preserved100";
    const post94 = phase === "suffix98" || phase === "resume98";
    const financialFields =
      post94 &&
      record(value) &&
      [
        "financialContributionDigest",
        "financialSourceBindingDigest",
        "financialContributionPath",
      ].some((name) => Object.hasOwn(value, name))
        ? [
            "financialContributionDigest",
            "financialSourceBindingDigest",
            "financialContributionPath",
          ]
        : [];
    const genesisFields =
      post94 &&
      record(value) &&
      ["signingGenesisDigest", "signingGenesisPath"].some((name) => Object.hasOwn(value, name))
        ? ["signingGenesisDigest", "signingGenesisPath"]
        : [];
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
          ...financialFields,
          ...genesisFields,
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
      ...(preserved100
        ? [
            "suffixBindingDigest",
            "suffixPostDigest",
            "expectedAfterShapeDigest",
            "nextWriterEpoch",
            "suffixReviewDigest",
          ]
        : []),
    ];
    if (
      !record(value) ||
      ((post94 || preserved100) &&
        Reflect.ownKeys(value).some((name) => {
          if (typeof name !== "string") return true;
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
        })) ||
      !keys(value, fields) ||
      value.kind !==
        (preserved100
          ? "takoserver.money-cutover-dispatch@v3"
          : post94
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
      (preserved100
        ? value.afterSchemaPhase !== "0100-fenced" || value.writerEpoch !== value.nextWriterEpoch
        : post94
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
      (genesisFields.length !== 0 &&
        (typeof value.signingGenesisPath !== "string" ||
          !isAbsolute(value.signingGenesisPath) ||
          dirname(value.signingGenesisPath) !== dirname(value.sealedImportPath))) ||
      (financialFields.length !== 0 &&
        (typeof value.financialContributionPath !== "string" ||
          !isAbsolute(value.financialContributionPath) ||
          dirname(value.financialContributionPath) !== dirname(value.sealedImportPath))) ||
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
        ...(preserved100
          ? [
              "suffixBindingDigest",
              "suffixPostDigest",
              "expectedAfterShapeDigest",
              "nextWriterEpoch",
              "suffixReviewDigest",
            ]
          : []),
        ...post94Fields.filter(
          (field) =>
            field !== "selectedStripeMode" &&
            field !== "financialContributionPath" &&
            field !== "signingGenesisPath",
        ),
      ].every((field) => requireSha(value[field]))
    ) {
      throw preflightError("money dispatch binding is malformed");
    }
    return value as unknown as MoneyCutoverDispatchBinding;
  };
  const readDispatchRecord = (
    phase: MoneyCustodyPhase,
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
  const readTerminal = (phase: MoneyCustodyPhase): MoneyCutoverCustodyReceipt | null => {
    const value = protectedJson(path(phase, "terminal"), "money terminal custody", undefined, true);
    return value === null ? null : parseReceipt(value, phase, "terminal");
  };
  const writeRecord = (
    phase: MoneyCustodyPhase,
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

/**
 * Compares two independently owned target selections. This is a source/profile
 * conservation check only: the Auth103 owner must still prove its own original
 * native history and the Money owner must prove the intervening deployments.
 * A caller-supplied Auth103 descriptor alone never authorizes publication.
 */
export function assertMoneyUnitOriginalPost103TargetProfile(
  options: MoneyUnitOriginalCutoverOptions,
  moneyTarget: DeployTarget,
  auth103OriginalTarget: DeployTarget,
  originalNextWriterEpoch: string,
): DeployTarget {
  const original = assertMoneyUnitOriginalWriterOptions(options, moneyTarget);
  const auth = parseDeployTarget(
    auth103OriginalTarget,
    "original Auth103 target profile",
    "integration",
  );
  if (
    original.schemaMaintenanceMode !== "pre-wallet-usd-micros-quiesced" ||
    original.auth103NativeProfile !== undefined ||
    !/^sha256:[0-9a-f]{64}$/u.test(originalNextWriterEpoch) ||
    original.moneyCutoverWriterEpoch === originalNextWriterEpoch ||
    auth.schemaMaintenanceMode !== "pre-auth103-quiesced" ||
    auth.auth103NativeProfile !== "root-shared-auth-staging-v1" ||
    original.accountId !== auth.accountId ||
    original.d1.databaseId !== auth.d1.databaseId ||
    original.d1.databaseName !== auth.d1.databaseName ||
    original.r2.bucketName !== auth.r2.bucketName ||
    original.workerName !== auth.workerName
  )
    throw preflightError("money post103 targets do not select one original physical Host");
  const expected: DeployTarget = {
    ...original,
    schemaMaintenanceMode: "pre-auth103-quiesced",
    auth103NativeProfile: "root-shared-auth-staging-v1",
    moneyCutoverWriterEpoch: originalNextWriterEpoch,
    publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
  };
  const fields = Object.keys(expected).sort();
  if (
    JSON.stringify(Object.keys(auth).sort()) !== JSON.stringify(fields) ||
    fields.some(
      (field) =>
        JSON.stringify(auth[field as keyof DeployTarget]) !==
        JSON.stringify(expected[field as keyof DeployTarget]),
    )
  )
    throw preflightError(
      "money post103 target changes fields outside the reviewed profile transition",
    );
  return auth;
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
  const nativeBuild =
    nativeOnly && declaration.phase === "convert" ? captureMoneyNativeBuildClosure() : undefined;
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
    {
      declaration: declarationInput.value,
      assertUnchanged,
      nativeOnly,
      ...(nativeBuild === undefined ? {} : { nativeBuild }),
    },
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
  if (nativeOnly) {
    const nativeReader = nativeNormalWorkerReaders.get(options);
    if (!nativeReader) throw preflightError("money original native mode reader is unavailable");
    nativeNormalWorkerReaders.set(sealed, nativeReader);
  }
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
 * Explicit historical94 export/local-seal selection. Only the existing unchanged
 * default-native original convert owner may reach the lower DATA producer.
 * This neither mints a held context nor dispatches SQL or selects a next epoch.
 */
export async function captureMoneyUnitOriginalConverted94Backup(
  options: MoneyUnitOriginalCutoverOptions,
  convertedBackupPath: string,
): Promise<MoneyUnitConverted94BackupData> {
  const target = originalHeldMoneyOwner(options);
  if (
    typeof convertedBackupPath !== "string" ||
    !isAbsolute(convertedBackupPath) ||
    resolve(convertedBackupPath) !== convertedBackupPath ||
    resolve(convertedBackupPath) === resolve(options.backupPath)
  )
    throw preflightError("money converted94 capture requires a separate exact protected path");
  const result = await captureMoneyUnitConverted94Backup({ target, options, convertedBackupPath });
  if (originalHeldMoneyOwner(options) !== target)
    throw preflightError("money converted94 original native owner changed during capture");
  return result;
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

interface MoneyHeldNormalWorkerSelector {
  readonly kind: "takoserver.money-held-normal-worker-selector@v1";
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly bucketName: string;
  readonly workerName: string;
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
  readonly convertBindingDigest: string;
  readonly converted94BackupDigest: string;
  readonly sourceRoot: string;
  readonly sourceCommit: string;
  readonly versionId: string;
  readonly moduleDigest: string;
  readonly artifactDigest: string;
  readonly artifactBytes: number;
  readonly artifactFiles: number;
  readonly selectedStripeMode: "test";
}

function normalWorkerDataMethod(receiver: object, name: string): unknown {
  let current: object | null = receiver;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

type NativeNormalWorkerReader = (
  context: MoneyUnitHeldConvertContext,
  selector: MoneyHeldNormalWorkerSelector,
) => Promise<MoneyHeldNormalWorkerModeFacts>;

// Only the private native factory inserts readers. No consumer registration,
// dependency injection, selected JSON or source-inspection result can insert one.
const nativeNormalWorkerReaders = new WeakMap<MoneyUnitCutoverOptions, NativeNormalWorkerReader>();

declare const heldNormalWorkerModeBrand: unique symbol;
export interface MoneyUnitHeldNormalWorkerModePreparation {
  readonly [heldNormalWorkerModeBrand]: true;
  readonly kind: "takoserver.money-held-normal-worker-mode-preparation@v1";
  readonly facts: MoneyHeldNormalWorkerModeFacts;
  readonly bindingDigest: string;
}

const heldNormalWorkerModes = new WeakMap<
  object,
  {
    readonly context: MoneyUnitHeldConvertContext;
    readonly selectorPath: string;
    readonly selectorSeal: string;
    readonly selectorJson: string;
    readonly reader: NativeNormalWorkerReader;
    readonly facts: MoneyHeldNormalWorkerModeFacts;
    readonly factsJson: string;
    readonly bindingDigest: string;
  }
>();

// Reviewed Root entry source identities, not caller-supplied semantics. A changed
// entry/call path needs a separate source review rather than default inference.
const NORMAL_ENTRY_SOURCE =
  "sha256:29de9a0ae29d3dabf624265088ffd315802c1c62122b61a354600355d6e5a58c";
const NORMAL_ENTRY_MODULE_SOURCE =
  "sha256:af8653dfb12f4e0db3841abb7ee31c757dc4cfcaaaa9859f1d91f7bd6bd48612";

/**
 * Component-only syntax DATA. This cannot mint a native preparation. The private
 * reader alone feeds immutable selected-Git source into it after native checks.
 * Source text, diagnostics and unrelated literals are never returned/logged.
 */
export async function inspectMoneyNormalWorkerModeFunctionSource(
  source: string,
): Promise<{ readonly sourceDigest: string; readonly functionDigest: string } | null> {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_PROTECTED_BYTES)
    return null;
  const ts = await import("typescript");
  const file = ts.createSourceFile("selected-mode-source.ts", source, ts.ScriptTarget.Latest, true);
  const functions = file.statements.filter(
    (node): node is TypeScript.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "parseStripeMode",
  );
  const fn = functions[0];
  const parameter = fn?.parameters[0];
  if (
    functions.length !== 1 ||
    !fn?.body ||
    fn.asteriskToken ||
    fn.modifiers?.some((node) => node.kind === ts.SyntaxKind.AsyncKeyword) ||
    !fn.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword) ||
    fn.parameters.length !== 1 ||
    !parameter ||
    !ts.isIdentifier(parameter.name) ||
    parameter.initializer ||
    parameter.dotDotDotToken ||
    parameter.questionToken ||
    fn.body.statements.length !== 3
  )
    return null;
  const name = parameter.name.text;
  const equal = (node: TypeScript.Expression, value: "undefined" | "test" | "live"): boolean =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isIdentifier(node.left) &&
    node.left.text === name &&
    (value === "undefined"
      ? ts.isIdentifier(node.right) && node.right.text === "undefined"
      : ts.isStringLiteral(node.right) && node.right.text === value);
  const first = fn.body.statements[0];
  const second = fn.body.statements[1];
  const third = fn.body.statements[2];
  if (
    !first ||
    !ts.isIfStatement(first) ||
    first.elseStatement ||
    !equal(first.expression, "undefined") ||
    !ts.isReturnStatement(first.thenStatement) ||
    !first.thenStatement.expression ||
    !ts.isStringLiteral(first.thenStatement.expression) ||
    first.thenStatement.expression.text !== "test" ||
    !second ||
    !ts.isIfStatement(second) ||
    second.elseStatement ||
    !ts.isBinaryExpression(second.expression) ||
    second.expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken ||
    !equal(second.expression.left, "test") ||
    !equal(second.expression.right, "live") ||
    !ts.isReturnStatement(second.thenStatement) ||
    !second.thenStatement.expression ||
    !ts.isIdentifier(second.thenStatement.expression) ||
    second.thenStatement.expression.text !== name ||
    !third ||
    !ts.isThrowStatement(third)
  )
    return null;
  const protectedNames = new Set(["parseStripeMode", "undefined"]);
  const bound = (node: TypeScript.BindingName): boolean => {
    if (ts.isIdentifier(node)) return protectedNames.has(node.text);
    return node.elements.some((item) => ts.isBindingElement(item) && bound(item.name));
  };
  const mentionsProtected = (node: TypeScript.Node): boolean => {
    if (ts.isIdentifier(node) && protectedNames.has(node.text)) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (mentionsProtected(child)) found = true;
    });
    return found;
  };
  let safe = true;
  const visit = (node: TypeScript.Node): void => {
    if (
      ts.isIdentifier(node) &&
      ["eval", "Function", "module", "exports", "require"].includes(node.text)
    )
      safe = false;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      bound(node.name)
    )
      safe = false;
    if (
      (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) &&
      node.name &&
      protectedNames.has(node.name.text)
    )
      safe = false;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isImportEqualsDeclaration(node)) &&
      node !== fn &&
      node.name &&
      protectedNames.has(node.name.text)
    )
      safe = false;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      mentionsProtected(node.left)
    )
      safe = false;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      mentionsProtected(node.operand)
    )
      safe = false;
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      mentionsProtected(node.initializer)
    )
      safe = false;
    if (ts.isDeleteExpression(node) && mentionsProtected(node.expression)) safe = false;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return safe
    ? Object.freeze({ sourceDigest: digest(source), functionDigest: digest(fn.getText(file)) })
    : null;
}

function heldNormalSelector(
  value: unknown,
  context: MoneyUnitHeldConvertContext,
): MoneyHeldNormalWorkerSelector {
  const held = heldMoneyContexts.get(context);
  if (
    !held ||
    !record(value) ||
    !keys(value, [
      "kind",
      "accountId",
      "databaseId",
      "databaseName",
      "bucketName",
      "workerName",
      "previousWriterEpoch",
      "nextWriterEpoch",
      "convertBindingDigest",
      "converted94BackupDigest",
      "sourceRoot",
      "sourceCommit",
      "versionId",
      "moduleDigest",
      "artifactDigest",
      "artifactBytes",
      "artifactFiles",
      "selectedStripeMode",
    ])
  )
    throw preflightError("money normal Worker selector is not a closed selection");
  const facts = held.facts;
  if (
    value.kind !== "takoserver.money-held-normal-worker-selector@v1" ||
    value.accountId !== facts.storage.accountId ||
    value.databaseId !== facts.storage.databaseId ||
    value.databaseName !== facts.storage.databaseName ||
    value.bucketName !== facts.storage.bucketName ||
    value.workerName !== held.target.workerName ||
    value.previousWriterEpoch !== facts.previousWriterEpoch ||
    value.nextWriterEpoch !== facts.nextWriterEpoch ||
    value.convertBindingDigest !== facts.conversion.convertBindingDigest ||
    value.converted94BackupDigest !== facts.converted94.backupDigest ||
    value.selectedStripeMode !== "test" ||
    typeof value.sourceRoot !== "string" ||
    !isAbsolute(value.sourceRoot) ||
    resolve(value.sourceRoot) !== value.sourceRoot ||
    typeof value.sourceCommit !== "string" ||
    !requireCommit(value.sourceCommit) ||
    typeof value.versionId !== "string" ||
    !UUID.test(value.versionId) ||
    value.versionId === facts.maintenance.versionId ||
    typeof value.moduleDigest !== "string" ||
    !requireSha(value.moduleDigest) ||
    typeof value.artifactDigest !== "string" ||
    !requireSha(value.artifactDigest) ||
    typeof value.artifactBytes !== "number" ||
    !Number.isSafeInteger(value.artifactBytes) ||
    value.artifactBytes <= 0 ||
    typeof value.artifactFiles !== "number" ||
    !Number.isSafeInteger(value.artifactFiles) ||
    value.artifactFiles <= 0
  )
    throw preflightError("money normal Worker selector differs from original held source");
  return Object.freeze<MoneyHeldNormalWorkerSelector>({
    kind: "takoserver.money-held-normal-worker-selector@v1",
    accountId: facts.storage.accountId,
    databaseId: facts.storage.databaseId,
    databaseName: facts.storage.databaseName,
    bucketName: facts.storage.bucketName,
    workerName: held.target.workerName,
    previousWriterEpoch: facts.previousWriterEpoch,
    nextWriterEpoch: facts.nextWriterEpoch,
    convertBindingDigest: facts.conversion.convertBindingDigest,
    converted94BackupDigest: facts.converted94.backupDigest,
    sourceRoot: value.sourceRoot,
    sourceCommit: value.sourceCommit,
    versionId: value.versionId,
    moduleDigest: value.moduleDigest,
    artifactDigest: value.artifactDigest,
    artifactBytes: value.artifactBytes,
    artifactFiles: value.artifactFiles,
    selectedStripeMode: "test",
  });
}

function assertNormalHeldContext(context: unknown): asserts context is MoneyUnitHeldConvertContext {
  if (typeof context !== "object" || context === null || !heldMoneyContexts.has(context))
    throw preflightError("money normal Worker requires its original held context");
}

/** Native uploaded-Version preparation; never a claim that it serves traffic. */
export async function readMoneyUnitHeldNormalWorkerModePreparation(
  context: unknown,
  selectorPath: string,
): Promise<MoneyUnitHeldNormalWorkerModePreparation> {
  assertNormalHeldContext(context);
  await assertMoneyUnitHeldConvertCurrent(context);
  const held = heldMoneyContexts.get(context);
  if (
    !held ||
    typeof selectorPath !== "string" ||
    !isAbsolute(selectorPath) ||
    resolve(selectorPath) !== selectorPath
  )
    throw preflightError(
      "money normal Worker preparation needs original held context and canonical selector",
    );
  const target = originalHeldMoneyOwner(held.options);
  const reader = nativeNormalWorkerReaders.get(held.options);
  if (!reader || target !== held.target)
    throw preflightError("money normal Worker native owner is unavailable");
  const input = originalMoneyInput(selectorPath, "money normal Worker selector");
  const selector = heldNormalSelector(input.value, context);
  const facts = freezeOriginalMoneyData(structuredClone(await reader(context, selector)));
  await assertMoneyUnitHeldConvertCurrent(context);
  input.assertUnchanged();
  if (
    nativeNormalWorkerReaders.get(held.options) !== reader ||
    originalHeldMoneyOwner(held.options) !== target
  )
    throw preflightError("money normal Worker owner changed during preparation");
  const bindingDigest = digest(JSON.stringify(facts));
  const preparation = Object.freeze({
    kind: "takoserver.money-held-normal-worker-mode-preparation@v1" as const,
    facts,
    bindingDigest,
  }) as MoneyUnitHeldNormalWorkerModePreparation;
  heldNormalWorkerModes.set(preparation, {
    context,
    selectorPath,
    selectorSeal: input.seal,
    selectorJson: JSON.stringify(selector),
    reader,
    facts,
    factsJson: JSON.stringify(facts),
    bindingDigest,
  });
  return preparation;
}

/**
 * Pre-import only: repeats exact immutable native GET/source build and held94.
 * A post-import98/resume operation needs its own phase/custody; it cannot reuse
 * the held94 assertion, relax a legacy phase, or claim this was serving100%.
 */
export async function assertMoneyUnitHeldNormalWorkerModePreparationCurrent(
  preparation: unknown,
  context: unknown,
): Promise<void> {
  const selected =
    typeof preparation === "object" && preparation !== null
      ? heldNormalWorkerModes.get(preparation)
      : undefined;
  if (
    !selected ||
    typeof preparation !== "object" ||
    preparation === null ||
    selected.context !== context ||
    !ownMoneyValue(
      preparation,
      "kind",
      "takoserver.money-held-normal-worker-mode-preparation@v1",
    ) ||
    !ownMoneyValue(preparation, "facts", selected.facts) ||
    !ownMoneyValue(preparation, "bindingDigest", selected.bindingDigest)
  )
    throw preflightError("money normal Worker preparation origin differs");
  assertNormalHeldContext(context);
  await assertMoneyUnitHeldConvertCurrent(context);
  const held = heldMoneyContexts.get(context);
  if (
    !held ||
    nativeNormalWorkerReaders.get(held.options) !== selected.reader ||
    JSON.stringify(selected.facts) !== selected.factsJson
  )
    throw preflightError("money normal Worker held owner or detached facts changed");
  const input = originalMoneyInput(selected.selectorPath, "money normal Worker selector");
  const selector = heldNormalSelector(input.value, context);
  if (input.seal !== selected.selectorSeal || JSON.stringify(selector) !== selected.selectorJson)
    throw preflightError("money normal Worker selector changed after preparation");
  const current = await selected.reader(context, selector);
  await assertMoneyUnitHeldConvertCurrent(context);
  input.assertUnchanged();
  if (
    nativeNormalWorkerReaders.get(held.options) !== selected.reader ||
    JSON.stringify(current) !== selected.factsJson ||
    digest(JSON.stringify(current)) !== selected.bindingDigest
  )
    throw preflightError("money normal Worker native/source preparation changed");
}

/** Transport of original members only; the aggregate grants no import or resume permission. */
export interface MoneyUnitHeldPost94ConsumerInputs {
  readonly context: MoneyUnitHeldConvertContext;
  readonly selection: MoneyUnitHeldPost94Selection;
  readonly normalWorkerModePreparation: MoneyUnitHeldNormalWorkerModePreparation;
}

/** Original pre-upload members; never an uploaded Version, signing or dispatch permission. */
export interface MoneyUnitHeldPost94ContextSelection {
  readonly context: MoneyUnitHeldConvertContext;
  readonly selection: MoneyUnitHeldPost94Selection;
}

/** Original native owner → one held context → protected selection and immutable-Version mode. */
export async function readMoneyUnitHeldPost94ContextSelection(
  options: MoneyUnitOriginalCutoverOptions,
  post94DeclarationPath: string,
): Promise<MoneyUnitHeldPost94ContextSelection> {
  const target = originalHeldMoneyOwner(options);
  for (const path of [post94DeclarationPath]) {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      /[\0\r\n]/.test(path)
    )
      throw preflightError("money held post94 inputs require canonical protected paths");
  }
  const input = originalMoneyInput(post94DeclarationPath, "money held post94 declaration");
  const value = input.value;
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw preflightError("money held post94 inputs require own-data suffix selection");
  const selected = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      throw preflightError("money held post94 inputs require own-data suffix selection");
    return descriptor.value;
  };
  const previousWriterEpoch = selected("previousWriterEpoch");
  const nextWriterEpoch = selected("nextWriterEpoch");
  const convertedBackupPath = selected("convertedBackupPath");
  if (
    selected("kind") !== "takoserver.money-cutover-owner-post94-declaration@v1" ||
    selected("phase") !== "suffix98" ||
    selected("selectedStripeMode") !== "test" ||
    typeof previousWriterEpoch !== "string" ||
    typeof nextWriterEpoch !== "string" ||
    typeof convertedBackupPath !== "string"
  )
    throw preflightError("money held post94 inputs require pre-import suffix98 TEST selection");
  const request = heldMoneySelection({
    previousWriterEpoch,
    nextWriterEpoch,
    convertedBackupPath,
    selectedStripeMode: "test",
  });
  const assertInputs = (): void => {
    if (originalHeldMoneyOwner(options) !== target)
      throw preflightError("money held post94 original owner changed");
    input.assertUnchanged();
  };
  const context = await readMoneyUnitHeldConvertContext(options, request);
  assertInputs();
  await assertMoneyUnitHeldConvertCurrent(context);
  assertInputs();
  const selection = await readMoneyUnitHeldPost94Selection(context, post94DeclarationPath);
  assertInputs();
  await assertMoneyUnitHeldConvertCurrent(context);
  assertInputs();
  await assertMoneyUnitHeldPost94SelectionOrigin(selection, context);
  assertInputs();
  return Object.freeze({ context, selection });
}

/** Same live members only; normal JSON alone cannot mint this original member graph. */
export async function composeMoneyUnitHeldPost94ConsumerInputs(
  options: MoneyUnitOriginalCutoverOptions,
  original: MoneyUnitHeldPost94ContextSelection,
  normalPreparation: MoneyUnitHeldNormalWorkerModePreparation,
): Promise<MoneyUnitHeldPost94ConsumerInputs> {
  if (!record(original) || Reflect.ownKeys(original).length !== 2)
    throw preflightError("money live original context/selection transport is malformed");
  const context = Object.getOwnPropertyDescriptor(original, "context"),
    selection = Object.getOwnPropertyDescriptor(original, "selection");
  if (!context || !("value" in context) || !selection || !("value" in selection))
    throw preflightError("money live original members must be own DATA");
  const inputs: MoneyUnitHeldPost94ConsumerInputs = Object.freeze({
    context: context.value,
    selection: selection.value,
    normalWorkerModePreparation: normalPreparation,
  });
  await assertMoneyUnitHeldPost94ConsumerInputsOrigin(options, inputs);
  if (
    Object.getOwnPropertyDescriptor(original, "context")?.value !== inputs.context ||
    Object.getOwnPropertyDescriptor(original, "selection")?.value !== inputs.selection
  )
    throw preflightError("money live original transport changed during await");
  return inputs;
}

/** Original native owner → one held context → protected selection and immutable-Version mode. */
export async function readMoneyUnitHeldPost94ConsumerInputs(
  options: MoneyUnitOriginalCutoverOptions,
  post94DeclarationPath: string,
  normalWorkerSelectorPath: string,
): Promise<MoneyUnitHeldPost94ConsumerInputs> {
  const target = originalHeldMoneyOwner(options);
  for (const path of [post94DeclarationPath, normalWorkerSelectorPath]) {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      /[\0\r\n]/.test(path)
    )
      throw preflightError("money held post94 inputs require canonical protected paths");
  }
  const input = originalMoneyInput(post94DeclarationPath, "money held post94 declaration");
  const normalInput = originalMoneyInput(normalWorkerSelectorPath, "money normal Worker selector");
  const value = input.value;
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw preflightError("money held post94 inputs require own-data suffix selection");
  const selected = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      throw preflightError("money held post94 inputs require own-data suffix selection");
    return descriptor.value;
  };
  const previousWriterEpoch = selected("previousWriterEpoch");
  const nextWriterEpoch = selected("nextWriterEpoch");
  const convertedBackupPath = selected("convertedBackupPath");
  if (
    selected("kind") !== "takoserver.money-cutover-owner-post94-declaration@v1" ||
    selected("phase") !== "suffix98" ||
    selected("selectedStripeMode") !== "test" ||
    typeof previousWriterEpoch !== "string" ||
    typeof nextWriterEpoch !== "string" ||
    typeof convertedBackupPath !== "string"
  )
    throw preflightError("money held post94 inputs require pre-import suffix98 TEST selection");
  const request = heldMoneySelection({
    previousWriterEpoch,
    nextWriterEpoch,
    convertedBackupPath,
    selectedStripeMode: "test",
  });
  const assertInputs = (): void => {
    if (originalHeldMoneyOwner(options) !== target)
      throw preflightError("money held post94 original owner changed");
    input.assertUnchanged();
    normalInput.assertUnchanged();
  };
  const context = await readMoneyUnitHeldConvertContext(options, request);
  assertInputs();
  await assertMoneyUnitHeldConvertCurrent(context);
  assertInputs();
  const selection = await readMoneyUnitHeldPost94Selection(context, post94DeclarationPath);
  assertInputs();
  await assertMoneyUnitHeldConvertCurrent(context);
  assertInputs();
  await assertMoneyUnitHeldPost94SelectionOrigin(selection, context);
  assertInputs();
  const normalWorkerModePreparation = await readMoneyUnitHeldNormalWorkerModePreparation(
    context,
    normalWorkerSelectorPath,
  );
  assertInputs();
  await assertMoneyUnitHeldConvertCurrent(context);
  assertInputs();
  await assertMoneyUnitHeldPost94SelectionOrigin(selection, context);
  assertInputs();
  await assertMoneyUnitHeldNormalWorkerModePreparationCurrent(normalWorkerModePreparation, context);
  assertInputs();
  return Object.freeze({ context, selection, normalWorkerModePreparation });
}

function originalPost94Inputs(
  options: MoneyUnitOriginalCutoverOptions,
  inputs: MoneyUnitHeldPost94ConsumerInputs,
) {
  const fields = ["context", "selection", "normalWorkerModePreparation"] as const;
  if (!record(inputs) || Reflect.ownKeys(inputs).length !== fields.length)
    throw preflightError("money ONE requires original post94 transport members");
  const captured = Object.fromEntries(
    fields.map((name) => {
      const slot = Object.getOwnPropertyDescriptor(inputs, name);
      if (!slot || !("value" in slot))
        throw preflightError("money ONE post94 members must be own data");
      return [name, slot.value];
    }),
  ) as unknown as MoneyUnitHeldPost94ConsumerInputs;
  const held = heldMoneyContexts.get(captured.context),
    selection = heldPost94Selections.get(captured.selection),
    mode = heldNormalWorkerModes.get(captured.normalWorkerModePreparation);
  if (
    !held ||
    held.options !== options ||
    held.target !== originalHeldMoneyOwner(options) ||
    !selection ||
    selection.context !== captured.context ||
    !mode ||
    mode.context !== captured.context
  )
    throw preflightError("money ONE original options/context/selection/mode graph differs");
  return { captured, held, selection, mode };
}

/** Original aggregate transport never replaces original member provenance. */
export async function assertMoneyUnitHeldPost94ConsumerInputsOrigin(
  options: MoneyUnitOriginalCutoverOptions,
  inputs: MoneyUnitHeldPost94ConsumerInputs,
): Promise<void> {
  const selected = originalPost94Inputs(options, inputs);
  const assertLocal = () => {
    const current = originalPost94Inputs(options, inputs);
    if (
      current.held !== selected.held ||
      current.selection !== selected.selection ||
      current.mode !== selected.mode ||
      current.captured.context !== selected.captured.context ||
      current.captured.selection !== selected.captured.selection ||
      current.captured.normalWorkerModePreparation !== selected.captured.normalWorkerModePreparation
    )
      throw preflightError("money ONE post94 original transport changed during await");
  };
  await assertMoneyUnitHeldPost94SelectionOrigin(
    selected.captured.selection,
    selected.captured.context,
  );
  assertLocal();
  await assertMoneyUnitHeldNormalWorkerModePreparationCurrent(
    selected.captured.normalWorkerModePreparation,
    selected.captured.context,
  );
  assertLocal();
}

/** Closed retained locator from the same genuine graph, never a new backup selection. */
export function readMoneyUnitHeldPost94ConvertedBackupPath(
  options: MoneyUnitOriginalCutoverOptions,
  inputs: MoneyUnitHeldPost94ConsumerInputs,
): string {
  return originalPost94Inputs(options, inputs).held.request.convertedBackupPath;
}

/** Original retained selector DATA for the real signing-genesis owner; no new selection. */
export function readMoneyUnitHeldPost94NormalWorkerSelectorPath(
  options: MoneyUnitOriginalCutoverOptions,
  inputs: MoneyUnitHeldPost94ConsumerInputs,
): string {
  return originalPost94Inputs(options, inputs).mode.selectorPath;
}

/** Protected independent-review DATA, safe also to re-read after dispatch; no held94 assertion. */
export function readMoneyUnitHeldPost94IndependentReview(
  options: MoneyUnitOriginalCutoverOptions,
  inputs: MoneyUnitHeldPost94ConsumerInputs,
  binding: MoneyPost94ImportReviewBinding,
): MoneyReviewProof | null {
  const selected = originalPost94Inputs(options, inputs),
    facts = selected.held.facts;
  const input = originalMoneyInput(
    selected.selection.declarationPath,
    "money ONE original suffix declaration",
  );
  const declaration = parseHeldPost94Declaration(
    input.value,
    selected.held.target,
    facts,
    selected.held.request,
  );
  if (
    input.seal !== selected.selection.declarationSeal ||
    JSON.stringify(declaration) !== selected.selection.declarationJson ||
    binding.kind !== "takoserver.money-post94-import-review@v1" ||
    binding.phase !== "suffix98" ||
    declaration.phase !== "suffix98" ||
    binding.accountId !== facts.storage.accountId ||
    binding.databaseId !== facts.storage.databaseId ||
    binding.previousWriterEpoch !== facts.previousWriterEpoch ||
    binding.nextWriterEpoch !== facts.nextWriterEpoch ||
    binding.modePreparationDigest !== selected.captured.normalWorkerModePreparation.bindingDigest ||
    binding.selectionReviewDigest !== selected.captured.selection.selectionReviewDigest
  )
    throw preflightError("money ONE review differs from original declaration/selection/mode");
  const value = protectedJson(
    declaration.reviewEvidencePath,
    "money ONE independent review",
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
  )
    throw preflightError("money ONE independent review is malformed or differs from exact binding");
  input.assertUnchanged();
  return value as unknown as MoneyReviewProof;
}

/** Same protected exact-review record, fixed under the original Money output. */
export function readMoneyUnitOriginalPreserved100IndependentReview(
  options: MoneyUnitOriginalCutoverOptions,
  binding: MoneyPreserved100ReviewBinding,
): MoneyReviewProof | null {
  const target = originalHeldMoneyOwner(options);
  if (
    options.outputDirectory === undefined ||
    binding.kind !== "takoserver.money-preserved100-import-review@v1" ||
    binding.phase !== "preserved100" ||
    binding.accountId !== target.accountId ||
    binding.databaseId !== target.d1.databaseId ||
    binding.databaseName !== target.d1.databaseName ||
    binding.bucketName !== target.r2.bucketName ||
    binding.workerName !== target.workerName ||
    !requireCommit(binding.sourceCommit) ||
    ![
      binding.sourceDigest,
      binding.importDigest,
      binding.suffixBindingDigest,
      binding.suffixPostDigest,
      binding.suffixReviewDigest,
      binding.freezeBindingDigest,
      binding.originDigest,
      binding.original92BackupDigest,
      binding.writerDigest,
      binding.nextWriterEpoch,
      binding.beforeShapeDigest,
      binding.afterShapeDigest,
    ].every(requireSha)
  )
    throw preflightError("money preserved100 review binding differs from original source");
  const value = protectedJson(
    join(options.outputDirectory, "money-preserved100-independent-review.json"),
    "money preserved100 independent review",
    undefined,
    true,
  );
  if (value === null) return null;
  return parseMoneyUnitPreserved100ExactReviewData(value, binding);
}

/** Pure record decoder only. The native owner above supplies protected bytes and origin. */
export function parseMoneyUnitPreserved100ExactReviewData(
  value: unknown,
  binding: MoneyPreserved100ReviewBinding,
): MoneyReviewProof {
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
  )
    throw preflightError("money preserved100 review record differs from exact source/import");
  return value as unknown as MoneyReviewProof;
}

/** Historical selection comparison only; never calls pre-import held94 currentness after dispatch. */
export function assertMoneyUnitOriginalPost94DispatchData(
  options: MoneyUnitOriginalCutoverOptions,
  declarationPath: string,
  binding: unknown,
): void {
  const target = originalHeldMoneyOwner(options),
    original = originalMoneyWriters.get(options);
  const input = originalMoneyInput(declarationPath, "money post94 original declaration"),
    value = input.value;
  if (
    !original ||
    !record(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !record(binding)
  )
    throw preflightError("money post94 status requires original protected selection and dispatch");
  for (const key of Reflect.ownKeys(value)) {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !slot || !("value" in slot) || !slot.enumerable)
      throw preflightError("money post94 status selection must be own data");
  }
  if (
    value.kind !== "takoserver.money-cutover-owner-post94-declaration@v1" ||
    value.phase !== "suffix98" ||
    value.selectedStripeMode !== "test" ||
    value.previousWriterEpoch !== options.writerEpoch ||
    !requireSha(value.nextWriterEpoch) ||
    value.nextWriterEpoch === value.previousWriterEpoch ||
    typeof value.convertedBackupPath !== "string" ||
    !isAbsolute(value.convertedBackupPath) ||
    resolve(value.convertedBackupPath) !== value.convertedBackupPath ||
    resolve(value.convertedBackupPath) === resolve(options.backupPath) ||
    binding.kind !== "takoserver.money-cutover-dispatch@v2" ||
    binding.phase !== "suffix98" ||
    binding.previousWriterEpoch !== value.previousWriterEpoch ||
    binding.nextWriterEpoch !== value.nextWriterEpoch ||
    binding.accountId !== target.accountId ||
    binding.databaseId !== target.d1.databaseId ||
    binding.databaseName !== target.d1.databaseName ||
    binding.classificationDigest !== options.classificationManifestDigest
  )
    throw preflightError("money post94 original selection and dispatch differ");
  const projected: Record<string, unknown> = Object.assign(Object.create(null), value);
  for (const name of [
    "previousWriterEpoch",
    "nextWriterEpoch",
    "convertedBackupPath",
    "selectedStripeMode",
  ])
    delete projected[name];
  projected.kind = "takoserver.money-cutover-owner-declaration@v1";
  projected.phase = "convert";
  parseDeclaration(projected, target, true, true);
  if (
    moneyHeldPost94CommonDeclaration(value as unknown as MoneyHeldPost94Declaration) !==
      original.declarationCommon ||
    resolve(String(value.reviewEvidencePath)) === resolve(original.reviewEvidencePath)
  )
    throw preflightError("money post94 declaration cannot replace the original convert owner");
  input.assertUnchanged();
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
  originalWriter?: {
    readonly declaration: unknown;
    readonly assertUnchanged: () => void;
    readonly nativeOnly: boolean;
    readonly nativeBuild?: MoneyNativeBuildClosure;
  },
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
  const originalOrigin = await readOrigin();
  const originalMaintenance =
    originalWriter?.nativeOnly === true && originalRead !== undefined
      ? {
          originalCreate: originalRead.custody,
          terminalCustodyDigest: originalOrigin.terminalCustodyDigest,
        }
      : undefined;
  const readMaintenancePublication = (): PublicPublicationReceipt =>
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
      originalMaintenance,
    );
  // The DATA predicate above does not qualify a maintenance target. Only this
  // source-owned closure can admit its reviewed standalone scope, after the
  // existing default-native original context and actual protected publication
  // readers have authenticated the unchanged target and original chain.
  const readReviewedPrivateScope = (): PrivateWriterScope => {
    if (
      target.schemaMaintenanceMode === "pre-wallet-usd-micros-quiesced" &&
      standaloneMoneyTargetData(target)
    ) {
      if (originalMaintenance === undefined)
        throw preflightError(
          "money standalone maintenance requires its native original publication owner",
        );
      const publication = readMaintenancePublication();
      if (
        publication.resultKind !==
          "takoserver.integration-worker-bootstrap-original-money-maintenance-apply@v1" &&
        publication.resultKind !==
          "takoserver.integration-worker-original-money-maintenance-successor-apply@v1"
      )
        throw preflightError(
          "money standalone maintenance requires original source-built publication custody",
        );
    }
    return parsePrivateScope(
      protectedJson(
        declaration.privateWriterScopePath,
        "money private writer scope",
        declaration.privateWriterScopeDigest,
      ),
      target,
      declaration.maintenanceCommit,
    );
  };
  const scope = readReviewedPrivateScope();
  readMaintenancePublication();
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
  const nativeModeMethods = originalWriter?.nativeOnly
    ? Object.freeze({
        version: normalWorkerDataMethod(selectedState, "workerVersion"),
        modules: normalWorkerDataMethod(selectedState, "workerVersionWithModules"),
        d1: normalWorkerDataMethod(selectedStorage, "getD1"),
        r2: normalWorkerDataMethod(selectedStorage, "getR2"),
      })
    : undefined;
  const fetcher =
    dependencies.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init));

  async function readPrivateScope(): Promise<{
    readonly privateScopeDigest: string;
    readonly privateSourceInventoryDigest: string;
    readonly privateDependencyClosureDigest: string;
    readonly privateDeploymentsDigest: string;
  }> {
    // Re-read the protected reviewed inventory every time, so a later phase cannot inherit a replaced file.
    readReviewedPrivateScope();
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
    const selectedPublication = parsePublicPublicationReceipt(
      protectedJson(
        maintenance
          ? declaration.maintenancePublicationReceiptPath
          : (declaration.resumePublicationReceiptPath ?? ""),
        "money public Worker terminal publication",
        maintenance
          ? declaration.maintenancePublicationReceiptDigest
          : declaration.resumePublicationReceiptDigest,
      ),
      target,
      maintenance ? "maintenance" : "resume",
      maintenance ? declaration.maintenanceCommit : (declaration.resumeCommit ?? ""),
      maintenance ? declaration.maintenanceModuleDigest : (declaration.resumeModuleDigest ?? ""),
      maintenance ? originalMaintenance : undefined,
    );
    const originalMaintenancePublication =
      maintenance &&
      (selectedPublication.resultKind ===
        "takoserver.integration-worker-bootstrap-original-money-maintenance-apply@v1" ||
        selectedPublication.resultKind ===
          "takoserver.integration-worker-original-money-maintenance-successor-apply@v1");
    // The original maintenance Version binds no secret. Its script store may
    // still hold exactly the names of the retained inactive upload, witnessed
    // by that upload's custody and a GET of the uploaded Version.
    let inventory: readonly unknown[] | undefined;
    let retained: Awaited<ReturnType<typeof readRetainedInactiveUploadWitness>> | undefined;
    if (originalMaintenancePublication) {
      inventory = await selectedState.workerSecrets(target.workerName);
      const held = [...parseWorkerSecretInventory(inventory, "preflight")].sort();
      if (held.length > 0) {
        retained = await readRetainedInactiveUploadWitness({
          root: join(declaration.outputDirectory, "money-inactive-normal-version"),
          workerName: target.workerName,
          allowedNames: expectedWorkerSecrets(plainTarget),
          workerVersion: (workerName, versionId) =>
            selectedState.workerVersion(workerName, versionId),
        });
        if (JSON.stringify(held) !== JSON.stringify(retained.names))
          throw preflightError(
            "money maintenance Worker secret store differs from its retained inactive upload",
          );
      }
    }
    const live = await inspectLiveWorkerVersion("preflight", selectedTarget, selectedState, {
      ...(originalMaintenancePublication
        ? {
            expectedSecrets: [],
            ...(inventory === undefined ? {} : { secretInventory: inventory }),
            ...(retained === undefined ? {} : { expectedInventorySecrets: retained.names }),
          }
        : {}),
      ...(selectedTarget.integrationE2eCredentialAuthority === undefined
        ? {}
        : { authorityProfile: { kind: "provenance-bound-jit" as const } }),
    });
    if (retained !== undefined) {
      if (retained.versionId === live.history.versionId)
        throw preflightError("money retained inactive upload became the served Version");
      retained.assertCurrent();
    }
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
              ...(originalMaintenancePublication ? { transitionExpectedSecrets: [] } : {}),
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
      maintenance ? originalMaintenance : undefined,
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
        originalMaintenance,
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

  async function readNormalWorkerMode(
    context: MoneyUnitHeldConvertContext,
    selector: MoneyHeldNormalWorkerSelector,
  ): Promise<MoneyHeldNormalWorkerModeFacts> {
    const held = heldMoneyContexts.get(context);
    if (
      !held ||
      !originalWriter?.nativeOnly ||
      !originalWriter.nativeBuild ||
      selector.sourceCommit !== originalWriter.nativeBuild.sourceCommit ||
      !nativeModeMethods ||
      Object.getPrototypeOf(dependencies) !== null ||
      Reflect.ownKeys(dependencies).join(",") !== "run" ||
      dependencies.run !== runCommand ||
      typeof nativeModeMethods.version !== "function" ||
      typeof nativeModeMethods.modules !== "function" ||
      typeof nativeModeMethods.d1 !== "function" ||
      typeof nativeModeMethods.r2 !== "function"
    )
      throw preflightError("money normal Worker requires the original native owner closure");
    const originalAssertion = originalWriter.assertUnchanged;
    const nativeBuild = originalWriter.nativeBuild;
    const versionRead = nativeModeMethods.version;
    const moduleRead = nativeModeMethods.modules;
    const d1Read = nativeModeMethods.d1;
    const r2Read = nativeModeMethods.r2;
    const assertLocal = () => {
      if (
        heldMoneyContexts.get(context) !== held ||
        held.target !== target ||
        originalHeldMoneyOwner(held.options) !== target ||
        nativeNormalWorkerReaders.get(held.options) !== readNormalWorkerMode ||
        JSON.stringify(held.facts) !== held.factsJson ||
        JSON.stringify(heldMoneySelection(held.request)) !== held.selection ||
        held.facts.previousWriterEpoch !== selector.previousWriterEpoch ||
        held.facts.nextWriterEpoch !== selector.nextWriterEpoch ||
        normalWorkerDataMethod(selectedState, "workerVersion") !== versionRead ||
        normalWorkerDataMethod(selectedState, "workerVersionWithModules") !== moduleRead ||
        normalWorkerDataMethod(selectedStorage, "getD1") !== d1Read ||
        normalWorkerDataMethod(selectedStorage, "getR2") !== r2Read
      )
        throw preflightError("money normal Worker original context or native receiver changed");
      originalAssertion();
    };
    const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
      assertLocal();
      await assertMoneyUnitHeldConvertCurrent(context);
      assertLocal();
      let result: T;
      try {
        result = await operation();
      } catch {
        throw preflightError("money normal Worker native/source observation failed");
      }
      assertLocal();
      await assertMoneyUnitHeldConvertCurrent(context);
      assertLocal();
      return result;
    };
    const readStorage = async (): Promise<void> => {
      const d1: unknown = await checked(() =>
        Reflect.apply(d1Read, selectedStorage, [target.d1.databaseId]),
      );
      const r2: unknown = await checked(() =>
        Reflect.apply(r2Read, selectedStorage, [target.r2.bucketName]),
      );
      if (
        !record(d1) ||
        !record(r2) ||
        d1.uuid !== held.facts.storage.databaseId ||
        d1.name !== held.facts.storage.databaseName ||
        r2.name !== held.facts.storage.bucketName
      )
        throw preflightError("money normal Worker native D1/R2 differs from original held target");
    };
    const readVersion = (): Promise<unknown> =>
      checked(() =>
        Reflect.apply(versionRead, selectedState, [target.workerName, selector.versionId]),
      );
    const readModules = (): Promise<unknown> =>
      checked(() =>
        Reflect.apply(moduleRead, selectedState, [target.workerName, selector.versionId]),
      );
    await readStorage();
    const version = await readVersion();
    if (!record(version) || version.id !== selector.versionId)
      throw preflightError("money normal Worker native immutable Version identity differs");
    const identity = workerVersionIdentity("preflight", version);
    if (
      identity.commit !== selector.sourceCommit ||
      `sha256:${identity.bundleDigestHex}` !== selector.moduleDigest
    )
      throw preflightError("money normal Worker selected source differs from native annotation");
    const nativeModuleDigest = `sha256:${exactV2MaintenanceModuleDigest("preflight", await readModules())}`;
    if (nativeModuleDigest !== selector.moduleDigest)
      throw preflightError("money normal Worker native module differs from selected source");
    const nativeStripeMode = optionalExactPlainTextBinding(
      "preflight",
      selector.versionId,
      version,
      "TAKOSERVER_STRIPE_MODE",
    );
    if (nativeStripeMode !== null && nativeStripeMode !== "test")
      throw preflightError("money normal Worker native Stripe mode is not TEST");
    const signingKeyId = optionalExactPlainTextBinding(
      "preflight",
      selector.versionId,
      version,
      "TAKOSERVER_SIGNING_KEY_ID",
    );
    if (signingKeyId === null || !/^[A-Za-z0-9._:-]{1,128}$/u.test(signingKeyId))
      throw preflightError("money normal Worker native signing-key selector is unavailable");
    const { schemaMaintenanceMode: _maintenance, ...plainTarget } = target;
    const normalTarget: DeployTarget = {
      ...plainTarget,
      moneyCutoverWriterEpoch: held.facts.nextWriterEpoch,
    };
    const expected = {
      ...expectedExactBindingClosure(normalTarget, {
        signingKeyId,
        workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
        ...(normalTarget.integrationE2eCredentialAuthority === undefined
          ? {}
          : {
              authorityProfile: {
                kind: "provenance-bound-jit" as const,
                provenance: {
                  sourceCommit: selector.sourceCommit,
                  artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
                },
              },
            }),
      }),
      // Exactly this native TEST binding is allowed independently from Hosted
      // feature selection. A live/invalid value never reaches this inventory.
      ...(nativeStripeMode === "test" && normalTarget.hostedBilling === undefined
        ? {
            TAKOSERVER_STRIPE_MODE: { type: "plain_text", fields: { text: "test" } },
          }
        : {}),
    };
    const assertVersion = (observed: unknown) => {
      if (!record(observed) || observed.id !== selector.versionId)
        throw preflightError("money normal Worker immutable Version identity changed");
      const current = workerVersionIdentity("preflight", observed);
      if (
        current.commit !== selector.sourceCommit ||
        `sha256:${current.bundleDigestHex}` !== nativeModuleDigest ||
        optionalExactPlainTextBinding(
          "preflight",
          selector.versionId,
          observed,
          "TAKOSERVER_SCHEMA_MAINTENANCE_MODE",
        ) !== null ||
        optionalExactPlainTextBinding(
          "preflight",
          selector.versionId,
          observed,
          "TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY",
        ) !== "transaction-fenced-usd-micros-v1" ||
        optionalExactPlainTextBinding(
          "preflight",
          selector.versionId,
          observed,
          "TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH",
        ) !== held.facts.nextWriterEpoch ||
        optionalExactPlainTextBinding(
          "preflight",
          selector.versionId,
          observed,
          "TAKOSERVER_STRIPE_MODE",
        ) !== nativeStripeMode
      )
        throw preflightError("money normal Worker native mode/policy/next epoch differs");
      assertExactVersionBindingClosure("preflight", selector.versionId, observed, expected);
    };
    assertVersion(version);
    const buildRoot = mkdtempSync(join(declaration.outputDirectory, "money-normal-build-"));
    // A selector chooses only an immutable version of the reviewed full source.
    // The factory captured its own tools/dependencies before its first await.
    const build = await checked(() =>
      nativeBuild.bindSource(selector.sourceRoot, selector.sourceCommit, buildRoot),
    );
    const sourceAt = (
      path: "src/entry-worker.ts" | "src/entry-cloudflare-worker.ts" | "src/stripe-mode-realm.ts",
    ): Promise<string> => checked(() => build.sourceAt(path));
    const entrySource = await sourceAt("src/entry-worker.ts");
    const entryModuleSource = await sourceAt("src/entry-cloudflare-worker.ts");
    if (
      digest(entrySource) !== NORMAL_ENTRY_SOURCE ||
      digest(entryModuleSource) !== NORMAL_ENTRY_MODULE_SOURCE
    )
      throw preflightError("money normal Worker entry/source call path is not reviewed");
    // Only an opaque parser AST/digest is retained. The unrelated module source
    // and any SQL literals are never displayed, copied into evidence or returned.
    const parserSource = await sourceAt("src/stripe-mode-realm.ts");
    const parser = await checked(() => inspectMoneyNormalWorkerModeFunctionSource(parserSource));
    if (!parser) throw preflightError("money normal Worker source mode/default is unknown");
    build.assertCurrent();
    const prepared = await checked(() =>
      prepareWorkerArtifact({
        root: buildRoot,
        target: normalTarget,
        commit: selector.sourceCommit,
        sourceRepositoryRoot: selector.sourceRoot,
        wranglerPath: build.wranglerPath,
        dryRunCommand: "versions-upload",
        run: build.run,
        writeConfig: ({ path, main, bundleDigestHex, formImplementationIdentity }) => {
          const configPath = writeWorkerConfig(normalTarget, {
            path,
            main,
            commit: selector.sourceCommit,
            signingKeyId,
            sourceRepositoryRoot: selector.sourceRoot,
            topology: "version-only",
            ...(formImplementationIdentity === undefined ? {} : { formImplementationIdentity }),
            ...(bundleDigestHex === undefined
              ? {}
              : { workerArtifactDigest: `sha256:${bundleDigestHex}` as const }),
            ...(normalTarget.integrationE2eCredentialAuthority === undefined
              ? {}
              : bundleDigestHex === undefined
                ? { authorityProfile: { kind: "historical-pre-jit" as const } }
                : {
                    authorityProfile: {
                      kind: "provenance-bound-jit" as const,
                      provenance: {
                        sourceCommit: selector.sourceCommit,
                        artifactDigest: `sha256:${bundleDigestHex}` as const,
                      },
                    },
                  }),
          });
          if (nativeStripeMode === "test" && normalTarget.hostedBilling === undefined) {
            // This owner-created private build config mirrors an observed native
            // TEST binding; it does not enable Hosted or accept caller config/SQL.
            const configInput = originalMoneyInput(
              configPath,
              "money normal Worker generated configuration",
            );
            const config = configInput.value;
            if (
              !record(config) ||
              !record(config.vars) ||
              Object.hasOwn(config.vars, "TAKOSERVER_STRIPE_MODE")
            )
              throw preflightError("money normal Worker generated configuration differs");
            const contents = `${JSON.stringify(
              { ...config, vars: { ...config.vars, TAKOSERVER_STRIPE_MODE: "test" } },
              null,
              2,
            )}\n`;
            const before = lstatSync(configPath, { bigint: true });
            if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n)
              throw preflightError("money normal Worker generated configuration is not private");
            const fd = openSync(configPath, constants.O_WRONLY | constants.O_NOFOLLOW);
            try {
              const heldConfig = fstatSync(fd, { bigint: true });
              if (
                heldConfig.dev !== before.dev ||
                heldConfig.ino !== before.ino ||
                heldConfig.nlink !== 1n
              )
                throw preflightError("money normal Worker generated configuration changed");
              configInput.assertUnchanged();
              ftruncateSync(fd, 0);
              writeFileSync(fd, contents);
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          }
          return configPath;
        },
      }),
    );
    const sealed = prepared.seal();
    sealed.assertUnchanged();
    if (
      `sha256:${prepared.bundleDigestHex}` !== nativeModuleDigest ||
      sealed.digest !== selector.artifactDigest ||
      sealed.bytes !== selector.artifactBytes ||
      sealed.files !== selector.artifactFiles
    )
      throw preflightError(
        "money normal Worker source-built module/artifact differs from native/selector",
      );
    build.assertCurrent();
    assertVersion(await readVersion());
    if (
      `sha256:${exactV2MaintenanceModuleDigest("preflight", await readModules())}` !==
      nativeModuleDigest
    )
      throw preflightError("money normal Worker native immutable module changed");
    await readStorage();
    sealed.assertUnchanged();
    build.assertCurrent();
    assertLocal();
    return freezeOriginalMoneyData<MoneyHeldNormalWorkerModeFacts>({
      kind: "takoserver.money-held-normal-worker-mode-facts@v1",
      accountId: held.facts.storage.accountId,
      databaseId: held.facts.storage.databaseId,
      databaseName: held.facts.storage.databaseName,
      bucketName: held.facts.storage.bucketName,
      workerName: target.workerName,
      previousWriterEpoch: held.facts.previousWriterEpoch,
      nextWriterEpoch: held.facts.nextWriterEpoch,
      heldConvertDigest: digest(held.factsJson),
      convertBindingDigest: held.facts.conversion.convertBindingDigest,
      converted94BackupDigest: held.facts.converted94.backupDigest,
      versionId: selector.versionId,
      sourceCommit: selector.sourceCommit,
      moduleDigest: nativeModuleDigest,
      sourceArtifactDigest: sealed.digest,
      sourceArtifactBytes: sealed.bytes,
      sourceArtifactFiles: sealed.files,
      sourceTreeDigest: build.sourceTreeDigest,
      dependencyClosureDigest: build.dependencyClosureDigest,
      toolClosureDigest: build.toolClosureDigest,
      nativeBindingDigest: digest(JSON.stringify(expected)),
      stripeMode: "test",
      modeEvidence:
        nativeStripeMode === "test"
          ? "explicit-native-test"
          : "verified-source-default-test-native-absence",
      entrySourceDigest: NORMAL_ENTRY_SOURCE,
      entryModuleSourceDigest: NORMAL_ENTRY_MODULE_SOURCE,
      parserSourceDigest: parser.sourceDigest,
      parserFunctionDigest: parser.functionDigest,
    });
  }

  const result: MoneyUnitCutoverOptions = {
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
  if (originalWriter?.nativeOnly) nativeNormalWorkerReaders.set(result, readNormalWorkerMode);
  return result;
}
