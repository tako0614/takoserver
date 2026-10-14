import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { MONEY_CUTOVER_EPOCH } from "../../src/money-cutover-sql.ts";
import { RemoteD1 } from "./d1.ts";
import { buildD1MigrationImport } from "./d1-migration-import.ts";
import { normalizeSnapshotDump } from "./d1-snapshot-restore.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  moneyShadowHash,
  moneyShadowProtectedBytes,
  readMoneyShadowCreateReview,
  readMoneyShadowOrigin,
} from "./integration-money-shadow-create.ts";
import {
  CloudflareIntegrationStorageProvider,
  type IntegrationStorageD1Database,
} from "./integration-storage-generation.ts";
import { type MigrationFile, readD1SchemaState, readMigrationArtifact } from "./migrations.ts";
import {
  type CommandResult,
  REPOSITORY,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { qualifySource, sealDirectory } from "./qualification.ts";
import {
  assertMoneyCutoverSource,
  assertMoneyNativeForeignKeys,
  buildMoneyCutoverImportSql,
  type MoneySchemaPhase,
  moneyUnitCutoverSchemaMatches,
  moneyUnitCutoverSourcePrefixDigest,
  readMoneyAggregateDigest,
  readMoneyFrozenDataDigest,
  readMoneyPendingCount,
  readMoneyPreimageDigest,
  readWholeDatabaseDataDigest,
} from "./schema-money-unit-cutover.ts";

const ACCOUNT = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA = /^sha256:[0-9a-f]{64}$/u;
const NAME = /^takoserver-r-[0-9a-f]{32}$/u;
const MISSING_TABLE = "money_cutover_rehearsal_missing_0094_probe";
const FALSE_RESUME_CHECK = "epoch = 'usd-micros-v2'";
const PHASES = [
  "seed",
  "freeze",
  "prepare",
  "classify",
  "failure-probe",
  "convert",
  "resume-failure-probe",
  "resume",
  "legacy-insert-probe",
  "legacy-update-probe",
  "legacy-delete-probe",
  "stale-epoch-probe",
  "permit-failure-probe",
  "permit-success",
] as const;
export type MoneyRehearsalPhase = (typeof PHASES)[number];
type FailureProbePhase = Extract<MoneyRehearsalPhase, `${string}-probe`>;
const isFailureProbe = (phase: MoneyRehearsalPhase): phase is FailureProbePhase =>
  phase.endsWith("-probe");

export interface MoneyRehearsalDeclaration {
  readonly kind: "takoserver.money-unit-rehearsal@v1";
  readonly environment: "rehearsal";
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly createDeclarationPath: string;
  readonly createDeclarationDigest: string;
  readonly createReceiptPath: string;
  readonly createReceiptDigest: string;
  readonly reviewPath: string;
  readonly custodyDirectory: string;
  readonly phase: MoneyRehearsalPhase;
}

/** Distinct integration-only synthetic target; never an ordinary staging D1. */
export interface IntegrationMoneyShadowRehearsalDeclaration {
  readonly kind: "takoserver.integration-money-shadow-rehearsal@v1";
  readonly environment: "integration";
  readonly purpose: "synthetic-money-import-atomicity";
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly stageOriginReceiptPath: string;
  readonly stageOriginReceiptDigest: string;
  readonly createDeclarationPath: string;
  readonly createDeclarationDigest: string;
  readonly createReceiptPath: string;
  readonly createReceiptDigest: string;
  readonly reviewPath: string;
  readonly custodyDirectory: string;
  readonly snapshotPath: string;
  readonly phase: MoneyRehearsalPhase;
}

export interface MoneyRehearsalInvocation {
  readonly action: "status" | "apply";
  readonly environment: "rehearsal";
  readonly commit: string;
}

export interface IntegrationMoneyShadowRehearsalInvocation {
  readonly action: "status" | "apply";
  readonly environment: "integration";
  readonly commit: string;
}

export interface MoneyRehearsalProvider {
  getD1(databaseId: string): Promise<IntegrationStorageD1Database>;
  listD1(name: string): Promise<readonly IntegrationStorageD1Database[]>;
}

export interface MoneyRehearsalOptions {
  /** Provider and command seams are for local tests; live CLI supplies neither. */
  readonly provider?: MoneyRehearsalProvider;
  readonly run?: (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ) => Promise<CommandResult>;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly sourceDirectory?: string;
  readonly fetcher?: typeof fetch;
}

interface Binding {
  readonly kind: "takoserver.money-rehearsal-dispatch@v1";
  readonly phase: MoneyRehearsalPhase;
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly createReceiptDigest: string;
  readonly sourceCommit: string;
  readonly sourceDigest: string;
  readonly beforePhase: "empty" | MoneySchemaPhase;
  readonly afterPhase: MoneySchemaPhase;
  readonly beforeShapeDigest: string;
  readonly beforeFinancialDigest: string;
  readonly afterFinancialDigest: string;
  readonly beforeApplicationDigest: string;
  readonly afterApplicationDigest: string;
  readonly preimageDigest: string;
  readonly aggregateDigest: string;
  readonly importDigest: string;
  readonly sourceSql0094Digest: string;
  readonly writerEpoch: string;
  readonly wranglerVersion: "4.123.0";
  readonly wranglerLauncherDigest: string;
  readonly wranglerModuleDigest: string;
  readonly importTransport: "wrangler-d1-execute-remote-file" | "structured-d1-import-file";
  readonly importEndpoint: string;
  readonly reviewDigest: string;
  readonly sealedImportPath: string;
  readonly authorityProfile?: "integration-shadow-oauth";
  readonly credentialSource?: "wrangler-oauth";
  readonly stageOriginReceiptDigest?: string;
  readonly beforeSnapshotDigest?: string;
}

type ReviewBinding = Omit<Binding, "kind" | "reviewDigest" | "sealedImportPath"> & {
  readonly kind: "takoserver.money-rehearsal-review-binding@v1";
};

interface DispatchRecord {
  readonly kind: "takoserver.money-rehearsal-dispatch-record@v1";
  readonly bindingDigest: string;
  readonly binding: Binding;
}

interface TerminalRecord {
  readonly kind: "takoserver.money-rehearsal-terminal@v1";
  readonly bindingDigest: string;
  readonly result: "success" | "expected-sql-failure";
  readonly afterShapeDigest: string;
  readonly afterFinancialDigest: string;
  readonly afterApplicationDigest: string;
  readonly diagnosticDigest: string | null;
  readonly uploadHostClass: "selected-account-r2" | "cloudflare-r2-system" | null;
  readonly presignedUriDigest: string | null;
  readonly beforeSnapshotDigest?: string;
  readonly afterSnapshotDigest?: string;
}

const hash = (bytes: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const jsonHash = (value: unknown): string => hash(JSON.stringify(value));

function importEndpoint(accountId: string, databaseId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/import`;
}

/** The URL is accepted only as an authenticated D1 init result; expose no signed URI bytes. */
export function classifyMoneyRehearsalUploadUrl(
  signedUrl: string,
  selectedAccountId: string,
): {
  readonly url: URL;
  readonly hostClass: "selected-account-r2" | "cloudflare-r2-system";
  readonly presignedUriDigest: string;
} {
  let url: URL;
  try {
    url = new URL(signedUrl);
  } catch {
    throw mutationError("money rehearsal D1 import signed upload URL is malformed");
  }
  const labels = url.hostname.split(".");
  const suffix = labels.slice(-3).join(".");
  const prefix = labels.slice(0, -3);
  const systemAccount = prefix.at(-1);
  const validSystemAccount = systemAccount !== undefined && ACCOUNT.test(systemAccount);
  const bucket = prefix.length === 2 ? prefix[0] : undefined;
  const validBucket =
    bucket === undefined ||
    (bucket.length >= 3 &&
      bucket.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(bucket));
  if (
    !ACCOUNT.test(selectedAccountId) ||
    signedUrl.length > 4096 ||
    url.protocol !== "https:" ||
    suffix !== "r2.cloudflarestorage.com" ||
    (prefix.length !== 1 && prefix.length !== 2) ||
    !validSystemAccount ||
    !validBucket ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !/^\/[A-Za-z0-9/_%.-]+$/u.test(url.pathname) ||
    url.pathname === "/" ||
    !url.searchParams.has("X-Amz-Signature") ||
    !url.searchParams.has("X-Amz-Credential")
  ) {
    throw mutationError(
      "money rehearsal D1 import signed upload is outside qualified R2 TLS hosts",
    );
  }
  return {
    url,
    hostClass:
      bucket === undefined && systemAccount === selectedAccountId
        ? "selected-account-r2"
        : "cloudflare-r2-system",
    presignedUriDigest: hash(url.href),
  };
}

async function boundedResponseText(response: Response): Promise<string> {
  const stream = response.body;
  if (stream === null) throw mutationError("money rehearsal D1 import response has no body");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    let part: Awaited<ReturnType<typeof reader.read>>;
    try {
      part = await reader.read();
    } catch {
      throw mutationError("money rehearsal D1 import response is unreadable");
    }
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw mutationError("money rehearsal D1 import response exceeds its bound");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse only the structured authenticated D1 import result, never CLI stderr. */
export function reviewedFailureProbeResult(
  value: unknown,
  phase: FailureProbePhase = "failure-probe",
): string {
  const error =
    record(value) && typeof value.error === "string" && value.errors === undefined
      ? value.error
      : record(value) &&
          Array.isArray(value.errors) &&
          value.errors.length === 1 &&
          typeof value.errors[0] === "string" &&
          (value.error === undefined || value.error === value.errors[0])
        ? value.errors[0]
        : null;
  const expectedSqlError =
    phase === "failure-probe" || phase === "permit-failure-probe"
      ? `no such table: ${MISSING_TABLE}`
      : phase === "resume-failure-probe"
        ? `CHECK constraint failed: ${FALSE_RESUME_CHECK}`
        : phase === "stale-epoch-probe"
          ? "money cutover Writer epoch revoked"
          : "money cutover writer permit required";
  if (
    !record(value) ||
    value.success !== true ||
    value.status !== "error" ||
    error === null ||
    !new RegExp(
      `^(?:D1_ERROR: |SQLITE_ERROR: )?${expectedSqlError.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:: SQLITE_(?:ERROR|CONSTRAINT|CONSTRAINT_CHECK|CONSTRAINT_TRIGGER))?$`,
      "u",
    ).test(error)
  ) {
    throw mutationError(
      "money rehearsal native import did not return the exact late SQL-fault response; quarantine D1",
    );
  }
  return jsonHash(value);
}

/** Pinned Wrangler 4.123.0's init/upload/ingest/poll D1 import protocol, observed as TLS JSON. */
export async function importFailureProbe(
  accountId: string,
  databaseId: string,
  token: string,
  sql: string,
  fetcher: typeof fetch,
  phase: FailureProbePhase = "failure-probe",
): Promise<{
  readonly diagnosticDigest: string;
  readonly uploadHostClass: "selected-account-r2" | "cloudflare-r2-system";
  readonly presignedUriDigest: string;
}> {
  if (
    !ACCOUNT.test(accountId) ||
    !UUID.test(databaseId) ||
    token.length === 0 ||
    token.trim() !== token ||
    !(phase === "failure-probe" || phase === "permit-failure-probe"
      ? sql.endsWith(`INSERT INTO ${MISSING_TABLE} VALUES (1);\n`)
      : phase === "resume-failure-probe"
        ? sql.includes("UPDATE money_cutover_freeze SET source_digest =") &&
          sql.includes("'invalid-resume-epoch'")
        : phase === "stale-epoch-probe"
          ? sql.includes("INSERT INTO money_cutover_writer_permit")
          : sql.includes("stripe_events"))
  ) {
    throw preflightError(
      "money rehearsal structured import requires the exact failure-probe target",
    );
  }
  const endpoint = importEndpoint(accountId, databaseId);
  const bytes = Buffer.from(sql, "utf8");
  const etag = createHash("md5").update(bytes).digest("hex");
  const post = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch {
      throw mutationError("money rehearsal D1 import ACK unknown; preserve dispatch");
    }
    if (!response.ok) {
      throw mutationError("money rehearsal D1 import transport or API failure; preserve dispatch");
    }
    const raw = await boundedResponseText(response);
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw mutationError("money rehearsal D1 import response was not JSON; preserve dispatch");
    }
    if (!record(envelope) || envelope.success !== true || !record(envelope.result)) {
      throw mutationError(
        "money rehearsal D1 import API response was not successful; preserve dispatch",
      );
    }
    return envelope.result;
  };
  const init = await post({ action: "init", etag });
  if (
    typeof init.upload_url !== "string" ||
    init.upload_url.length > 4096 ||
    typeof init.filename !== "string" ||
    !/^[A-Za-z0-9/_:.-]{1,512}$/u.test(init.filename)
  ) {
    throw mutationError(
      "money rehearsal D1 import did not issue a fresh upload; preserve dispatch",
    );
  }
  const uploadTarget = classifyMoneyRehearsalUploadUrl(init.upload_url, accountId);
  let upload: Response;
  try {
    upload = await fetcher(uploadTarget.url, {
      method: "PUT",
      headers: { "Content-Length": String(bytes.length) },
      body: bytes,
      redirect: "error",
    });
  } catch {
    throw mutationError("money rehearsal D1 SQL upload ACK unknown; preserve dispatch");
  }
  if (upload.status !== 200 || upload.headers.get("etag")?.replace(/^"|"$/gu, "") !== etag) {
    throw mutationError(
      "money rehearsal D1 SQL upload etag was not acknowledged; preserve dispatch",
    );
  }
  let state = await post({ action: "ingest", filename: init.filename, etag });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (state.success !== true) {
      throw mutationError("money rehearsal D1 import status is indeterminate; preserve dispatch");
    }
    if (state.status === "error") {
      return {
        diagnosticDigest: reviewedFailureProbeResult(state, phase),
        uploadHostClass: uploadTarget.hostClass,
        presignedUriDigest: uploadTarget.presignedUriDigest,
      };
    }
    if (state.status === "complete") {
      throw mutationError("money rehearsal failure probe unexpectedly completed; quarantine D1");
    }
    if (
      state.status !== "active" ||
      typeof state.at_bookmark !== "string" ||
      !/^[\x21-\x7e]{1,512}$/u.test(state.at_bookmark)
    ) {
      throw mutationError("money rehearsal D1 import progress is malformed; preserve dispatch");
    }
    state = await post({ action: "poll", current_bookmark: state.at_bookmark });
  }
  throw mutationError("money rehearsal D1 import exceeded bounded polling; preserve dispatch");
}

export function readMoneyRehearsalWranglerProvenance(
  packageRoot = join(REPOSITORY, "node_modules/wrangler"),
): {
  readonly wranglerVersion: "4.123.0";
  readonly wranglerLauncherDigest: string;
  readonly wranglerModuleDigest: string;
} {
  const packageJson: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (
    !record(packageJson) ||
    packageJson.version !== "4.123.0" ||
    packageJson.main !== "wrangler-dist/cli.js" ||
    !record(packageJson.bin) ||
    packageJson.bin.wrangler !== "./bin/wrangler.js"
  )
    throw preflightError("money rehearsal requires pinned Wrangler 4.123.0");
  const launcher = join(packageRoot, "bin/wrangler.js");
  if (
    packageRoot === join(REPOSITORY, "node_modules/wrangler") &&
    realpathSync(wranglerCommand([])[0] ?? "") !== realpathSync(launcher)
  )
    throw preflightError("pinned Wrangler launcher does not match the executable");
  const launcherBytes = readFileSync(launcher);
  if (!launcherBytes.toString("utf8").includes('path.join(__dirname, "../wrangler-dist/cli.js")'))
    throw preflightError("pinned Wrangler launcher no longer delegates to its CLI module");
  return {
    wranglerVersion: "4.123.0",
    wranglerLauncherDigest: hash(launcherBytes),
    wranglerModuleDigest: hash(readFileSync(join(packageRoot, "wrangler-dist/cli.js"))),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protectedDirectory(path: string): void {
  if (!isAbsolute(path) || !relative(REPOSITORY, path).startsWith(".."))
    throw preflightError("rehearsal custody must be outside the repository");
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    realpathSync(path) !== path
  ) {
    throw preflightError(
      "rehearsal custody directory must be owned and mode 0700 without symlinks",
    );
  }
}

function protectedBytes(path: string, label: string, maxBytes = 1024 * 1024): Buffer {
  if (!isAbsolute(path) || !relative(REPOSITORY, path).startsWith(".."))
    throw preflightError(`${label} must be outside the repository`);
  protectedDirectory(dirname(path));
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    stat.size > maxBytes
  ) {
    throw preflightError(`${label} must be owned 0600 regular file`);
  }
  return readFileSync(path);
}

function protectedJson(path: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(protectedBytes(path, label).toString("utf8"));
  } catch {
    throw preflightError(`${label} is missing or malformed`);
  }
  if (!record(value)) throw preflightError(`${label} must be an object`);
  return value;
}

function writeOnce(path: string, value: string | Uint8Array): void {
  protectedDirectory(dirname(path));
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw mutationError("rehearsal custody already exists; do not retry or overwrite");
  }
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

function validateDeclaration(
  value: MoneyRehearsalDeclaration | IntegrationMoneyShadowRehearsalDeclaration,
): void {
  if (value.kind === "takoserver.integration-money-shadow-rehearsal@v1") {
    if (
      Object.keys(value).sort().join(",") !==
        "accountId,createDeclarationDigest,createDeclarationPath,createReceiptDigest,createReceiptPath,custodyDirectory,databaseId,databaseName,environment,kind,phase,purpose,reviewPath,snapshotPath,stageOriginReceiptDigest,stageOriginReceiptPath" ||
      value.environment !== "integration" ||
      value.purpose !== "synthetic-money-import-atomicity" ||
      !ACCOUNT.test(value.accountId) ||
      !/^takoserver-ms-[0-9a-f]{32}$/u.test(value.databaseName) ||
      !UUID.test(value.databaseId) ||
      !SHA.test(value.stageOriginReceiptDigest) ||
      !SHA.test(value.createDeclarationDigest) ||
      !SHA.test(value.createReceiptDigest) ||
      !PHASES.includes(value.phase) ||
      basename(value.snapshotPath) !== `${value.phase}-before.sql`
    )
      throw preflightError("money shadow rehearsal requires exact integration-only declaration");
    protectedDirectory(value.custodyDirectory);
    for (const path of [
      value.stageOriginReceiptPath,
      value.createDeclarationPath,
      value.createReceiptPath,
      value.reviewPath,
      value.snapshotPath,
    ]) {
      if (!isAbsolute(path) || !relative(REPOSITORY, path).startsWith(".."))
        throw preflightError("money shadow evidence must stay outside repository");
    }
    return;
  }
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "accountId,createDeclarationDigest,createDeclarationPath,createReceiptDigest,createReceiptPath,custodyDirectory,databaseId,databaseName,environment,kind,phase,reviewPath" ||
    value.kind !== "takoserver.money-unit-rehearsal@v1" ||
    value.environment !== "rehearsal" ||
    !ACCOUNT.test(value.accountId) ||
    !NAME.test(value.databaseName) ||
    !UUID.test(value.databaseId) ||
    !SHA.test(value.createDeclarationDigest) ||
    !SHA.test(value.createReceiptDigest) ||
    !PHASES.includes(value.phase)
  )
    throw preflightError("money rehearsal requires one exact rehearsal-only declaration");
  protectedDirectory(value.custodyDirectory);
  for (const path of [value.createDeclarationPath, value.createReceiptPath, value.reviewPath]) {
    if (!isAbsolute(path) || !relative(REPOSITORY, path).startsWith(".."))
      throw preflightError("money rehearsal evidence must stay outside repository");
  }
}

function validateCreation(
  value: MoneyRehearsalDeclaration | IntegrationMoneyShadowRehearsalDeclaration,
): void {
  if (value.kind === "takoserver.integration-money-shadow-rehearsal@v1") {
    const origin = readMoneyShadowOrigin(
      value.stageOriginReceiptPath,
      value.stageOriginReceiptDigest,
      value.accountId,
    );
    if (value.databaseId === origin.stagingDatabaseId)
      throw preflightError("money shadow rehearsal cannot select the staging D1 identity");
    const original = moneyShadowProtectedBytes(
      value.createDeclarationPath,
      "shadow D1 create declaration",
    );
    const receipt = moneyShadowProtectedBytes(
      value.createReceiptPath,
      "shadow D1 terminal create receipt",
    );
    if (
      moneyShadowHash(original) !== value.createDeclarationDigest ||
      moneyShadowHash(receipt) !== value.createReceiptDigest
    )
      throw preflightError("shadow D1 creation evidence changed");
    let originalJson: unknown;
    let receiptJson: unknown;
    try {
      originalJson = JSON.parse(original.toString("utf8"));
      receiptJson = JSON.parse(receipt.toString("utf8"));
    } catch {
      throw preflightError("shadow D1 creation evidence is malformed");
    }
    if (
      !record(originalJson) ||
      Object.keys(originalJson).sort().join(",") !==
        "accountId,custodyDirectory,environment,kind,name,purpose,reviewPath,stageOriginReceiptDigest,stageOriginReceiptPath" ||
      originalJson.kind !== "takoserver.integration-money-shadow-create@v1" ||
      originalJson.environment !== "integration" ||
      originalJson.purpose !== "synthetic-money-import-atomicity" ||
      originalJson.accountId !== value.accountId ||
      originalJson.name !== value.databaseName ||
      originalJson.stageOriginReceiptDigest !== origin.receiptDigest ||
      !record(receiptJson) ||
      receiptJson.kind !== "takoserver.integration-money-shadow-create-terminal@v1" ||
      receiptJson.surface !== "takoserver-integration-money-shadow-create" ||
      receiptJson.environment !== "integration" ||
      receiptJson.purpose !== "synthetic-money-import-atomicity" ||
      receiptJson.credentialSource !== "wrangler-oauth" ||
      receiptJson.accountId !== value.accountId ||
      receiptJson.databaseName !== value.databaseName ||
      receiptJson.databaseId !== value.databaseId ||
      receiptJson.stageOriginReceiptDigest !== origin.receiptDigest ||
      receiptJson.schemaObjectCount !== 0 ||
      !SHA.test(String(receiptJson.bindingDigest)) ||
      !SHA.test(String(receiptJson.reviewDigest)) ||
      !COMMIT.test(String(receiptJson.commit))
    )
      throw preflightError("shadow D1 creation was not terminal, empty and exact-target");
    if (
      value.createReceiptPath !==
        join(String(originalJson.custodyDirectory), "create.terminal.json") ||
      originalJson.stageOriginReceiptPath !== value.stageOriginReceiptPath ||
      originalJson.custodyDirectory === value.custodyDirectory
    )
      throw preflightError("shadow D1 create custody is not independently selected");
    const createBinding = {
      kind: "takoserver.integration-money-shadow-create-binding@v1",
      purpose: "synthetic-money-import-atomicity",
      environment: "integration",
      credentialSource: "wrangler-oauth",
      sourceCommit: receiptJson.commit,
      sourceDigest: origin.sourceDigest,
      accountId: value.accountId,
      databaseName: value.databaseName,
      stageOrigin: origin,
      nativeNameAbsent: true,
    };
    const dispatch = protectedJson(
      join(String(originalJson.custodyDirectory), "create.dispatched.json"),
      "shadow D1 create immutable dispatch",
    );
    if (
      dispatch.kind !== "takoserver.integration-money-shadow-create-dispatch@v1" ||
      dispatch.bindingDigest !== jsonHash(createBinding) ||
      JSON.stringify(dispatch.binding) !== JSON.stringify(createBinding) ||
      dispatch.reviewDigest !== receiptJson.reviewDigest ||
      receiptJson.bindingDigest !== dispatch.bindingDigest
    )
      throw preflightError("shadow D1 create terminal lacks exact immutable dispatch");
    if (
      readMoneyShadowCreateReview(
        String(originalJson.reviewPath),
        String(receiptJson.bindingDigest),
      ) !== receiptJson.reviewDigest
    )
      throw preflightError("shadow D1 create independent review is not retained");
    return;
  }
  const original = protectedBytes(value.createDeclarationPath, "rehearsal D1 create declaration");
  const receipt = protectedBytes(value.createReceiptPath, "rehearsal D1 terminal create receipt");
  if (
    hash(original) !== value.createDeclarationDigest ||
    hash(receipt) !== value.createReceiptDigest
  )
    throw preflightError("rehearsal D1 creation evidence changed");
  let originalJson: unknown;
  let receiptJson: unknown;
  try {
    originalJson = JSON.parse(original.toString("utf8"));
    receiptJson = JSON.parse(receipt.toString("utf8"));
  } catch {
    throw preflightError("rehearsal D1 creation evidence is invalid JSON");
  }
  if (
    !record(originalJson) ||
    Object.keys(originalJson).sort().join(",") !== "accountId,environment,kind,name" ||
    originalJson.kind !== "takoserver.rehearsal-d1-create@v1" ||
    originalJson.environment !== "rehearsal" ||
    originalJson.accountId !== value.accountId ||
    originalJson.name !== value.databaseName ||
    !record(receiptJson) ||
    receiptJson.kind !== "takoserver.rehearsal-d1-create-apply@v1" ||
    receiptJson.surface !== "takoserver-rehearsal-d1-create" ||
    receiptJson.environment !== "rehearsal" ||
    receiptJson.databaseName !== value.databaseName ||
    receiptJson.databaseId !== value.databaseId ||
    receiptJson.schemaObjectCount !== 0 ||
    !COMMIT.test(String(receiptJson.commit)) ||
    typeof receiptJson.reviewer !== "string" ||
    receiptJson.reviewer.length < 2
  ) {
    throw preflightError("rehearsal D1 creation was not terminal, empty and exact-target");
  }
}

function phaseShape(phase: MoneyRehearsalPhase): {
  before: "empty" | MoneySchemaPhase;
  after: MoneySchemaPhase;
  previous: MoneyRehearsalPhase | null;
} {
  switch (phase) {
    case "seed":
      return { before: "empty", after: "0092", previous: null };
    case "freeze":
      return { before: "0092", after: "0092-fenced", previous: "seed" };
    case "prepare":
      return { before: "0092-fenced", after: "0093-fenced", previous: "freeze" };
    case "classify":
      return { before: "0093-fenced", after: "0093-fenced", previous: "prepare" };
    case "failure-probe":
      return { before: "0093-fenced", after: "0093-fenced", previous: "classify" };
    case "convert":
      return { before: "0093-fenced", after: "0094-fenced", previous: "failure-probe" };
    case "resume-failure-probe":
      return { before: "0094-fenced", after: "0094-fenced", previous: "convert" };
    case "resume":
      return { before: "0094-fenced", after: "0094", previous: "resume-failure-probe" };
    case "legacy-insert-probe":
      return { before: "0094", after: "0094", previous: "resume" };
    case "legacy-update-probe":
      return { before: "0094", after: "0094", previous: "legacy-insert-probe" };
    case "legacy-delete-probe":
      return { before: "0094", after: "0094", previous: "legacy-update-probe" };
    case "stale-epoch-probe":
      return { before: "0094", after: "0094", previous: "legacy-delete-probe" };
    case "permit-failure-probe":
      return { before: "0094", after: "0094", previous: "stale-epoch-probe" };
    case "permit-success":
      return { before: "0094", after: "0094", previous: "permit-failure-probe" };
  }
}

const classifications = [
  {
    org_id: "org-rehearsal",
    ref: "credit-rehearsal",
    original_kind: "direct" as const,
    original_amount_minor: "900719925473",
    original_expires_at: null,
    consumption_class: "free" as const,
    evidence_ref: "synthetic-reviewed-rehearsal-credit",
    reviewed_at: "2026-10-14T00:00:00Z",
  },
];

function fixtureSeedSql(files: readonly MigrationFile[]): string {
  const base = buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql;
  return `${base}\nINSERT INTO principals (id, provider, provider_subject, email, display_name, created_at) VALUES ('principal-rehearsal','github','synthetic-rehearsal','rehearsal@example.invalid','Synthetic rehearsal','2026-10-14T00:00:00Z');\nINSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES ('org-rehearsal','Synthetic rehearsal','principal-rehearsal','2026-10-14T00:00:00Z');\nINSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at) VALUES ('fund-rehearsal','org-rehearsal','funding','credit-rehearsal',900719925473,0,'2026-10-14T00:00:00Z');\nINSERT INTO wallet_credit_lots (org_id, ref, kind, amount_minor, expires_at, created_at, cursor_handle) VALUES ('org-rehearsal','credit-rehearsal','direct',900719925473,NULL,'2026-10-14T00:00:00Z','11111111111111111111111111111111');\nINSERT INTO stripe_events (event_id,type,livemode,object_id,event_created_at,received_at,outcome,outcome_detail,settled_at) VALUES ('evt_rehearsal','checkout.session.completed',0,'cs_rehearsal','2026-10-14T00:00:00Z','2026-10-14T00:00:01Z','ignored','synthetic','2026-10-14T00:00:02Z');\n`;
}

export interface SyntheticPlan {
  readonly sql: Readonly<Record<MoneyRehearsalPhase, string>>;
  readonly financial: Readonly<Record<MoneyRehearsalPhase | "empty", string>>;
  readonly application: Readonly<Record<MoneyRehearsalPhase | "empty", string>>;
  readonly preimageDigest: string;
  readonly aggregateDigest: string;
  readonly writerEpoch: string;
}

async function applicationDigest(
  reader: {
    query(
      phase: "preflight" | "verification",
      description: string,
      sql: string,
    ): Promise<readonly Record<string, unknown>[]>;
  },
  phase: "preflight" | "verification",
): Promise<string> {
  const rows = await reader.query(
    phase,
    "complete application table inventory",
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations') ORDER BY name",
  );
  const names = rows.map((row) => row.name);
  if (names.some((name) => typeof name !== "string" || !/^[a-z_][a-z_0-9]*$/u.test(name))) {
    throw preflightError("money rehearsal application table inventory is malformed");
  }
  return readWholeDatabaseDataDigest(reader, phase, names as string[]);
}

/** Local protected export is an independent byte-complete witness for the late-fault phase. */
async function shadowSnapshot(
  declaration: IntegrationMoneyShadowRehearsalDeclaration,
  path: string,
  root: string,
  configPath: string,
  expectedApplicationDigest: string,
  files: readonly MigrationFile[],
  run: NonNullable<MoneyRehearsalOptions["run"]>,
  childEnvironment: Readonly<Record<string, string>>,
  expectedPhase: "0093-fenced" | "0094-fenced" | "0094",
): Promise<string> {
  if (!existsSync(path)) {
    const rawPath = join(root, "raw-native-export.sql");
    let result: CommandResult;
    try {
      result = await run(
        wranglerCommand([
          "d1",
          "export",
          declaration.databaseName,
          "--remote",
          "--yes",
          "--config",
          configPath,
          "--output",
          rawPath,
        ]),
        { env: childEnvironment },
      );
      if (result.exitCode !== 0)
        throw preflightError("money shadow native export failed before the failure probe");
      const normalized = normalizeSnapshotDump(readFileSync(rawPath));
      writeOnce(path, normalized.sql);
    } catch (error) {
      if (error instanceof Error && error.name === "DeployError") throw error;
      throw preflightError("money shadow native export failed before the failure probe");
    } finally {
      rmSync(rawPath, { force: true });
    }
  }
  const bytes = protectedBytes(path, "money shadow full native snapshot", 16 * 1024 * 1024);
  return verifyMoneyShadowSnapshotBytes(bytes, expectedApplicationDigest, files, expectedPhase);
}

export async function verifyMoneyShadowSnapshotBytes(
  bytes: Uint8Array,
  expectedApplicationDigest: string,
  files: readonly MigrationFile[],
  expectedPhase: "0093-fenced" | "0094-fenced" | "0094" = "0093-fenced",
): Promise<string> {
  const normalized = normalizeSnapshotDump(bytes);
  if (
    normalized.nulBytes !== 0 ||
    normalized.bytes !== bytes.length ||
    hash(bytes) !== normalized.digest
  )
    throw preflightError("money shadow protected snapshot lost bytes or normalization");
  const snapshot = new Database(":memory:");
  try {
    snapshot.exec(normalized.sql);
    const reader = {
      async query(_phase: unknown, _description: unknown, sql: string) {
        return snapshot.query(sql).all() as Record<string, unknown>[];
      },
      async column(_phase: unknown, _description: unknown, sql: string, name: string) {
        return (snapshot.query(sql).all() as Record<string, unknown>[]).map((row) =>
          String(row[name]),
        );
      },
    };
    const state = await readD1SchemaState(reader as unknown as RemoteD1);
    if (!moneyUnitCutoverSchemaMatches(state, files, expectedPhase))
      throw preflightError("money shadow full export has unexpected schema");
    if ((await applicationDigest(reader, "preflight")) !== expectedApplicationDigest)
      throw preflightError("money shadow full export differs from all native application rows");
    await assertMoneyNativeForeignKeys(reader, "preflight");
    return normalized.digest;
  } catch (error) {
    if (error instanceof Error && error.name === "DeployError") throw error;
    throw preflightError("money shadow protected export cannot be fully restored and checked");
  } finally {
    snapshot.close();
  }
}

export async function buildMoneyRehearsalSyntheticPlan(
  files: readonly MigrationFile[],
  declaration: MoneyRehearsalDeclaration | IntegrationMoneyShadowRehearsalDeclaration,
): Promise<SyntheticPlan> {
  const seed = fixtureSeedSql(files);
  const database = new Database(":memory:");
  const reader = {
    query: async (_phase: unknown, _description: unknown, sql: string) =>
      database.query(sql).all() as Record<string, unknown>[],
  };
  const sql = {} as Record<MoneyRehearsalPhase, string>;
  const financial = {} as Record<MoneyRehearsalPhase | "empty", string>;
  const application = {} as Record<MoneyRehearsalPhase | "empty", string>;
  const originDigest = declaration.createReceiptDigest;
  const backupDigest = hash(seed);
  const writerDigest = hash("synthetic rehearsal has no Worker writer");
  // Synthetic-only epoch: the reviewed import proves the DB guard policy, not a deployed Worker.
  const writerEpoch = hash(
    `synthetic-money-rehearsal:${declaration.accountId}:${declaration.databaseId}:${declaration.createReceiptDigest}`,
  );
  const anchor = hash(
    JSON.stringify({
      kind: "takoserver.money-rehearsal-anchor@v1",
      accountId: declaration.accountId,
      databaseId: declaration.databaseId,
      originDigest,
      backupDigest,
      writerDigest,
    }),
  );
  try {
    sql.seed = seed;
    financial.empty = hash("empty synthetic rehearsal");
    application.empty = hash("empty synthetic rehearsal application");
    database.exec(seed);
    const preimageDigest = await readMoneyPreimageDigest(reader, "preflight");
    const aggregateDigest = await readMoneyAggregateDigest(reader, "preflight");
    financial.seed = await readMoneyFrozenDataDigest(reader, "preflight");
    application.seed = await applicationDigest(reader, "preflight");
    for (const phase of ["freeze", "prepare", "classify", "convert"] as const) {
      sql[phase] = buildMoneyCutoverImportSql({
        phase,
        files,
        anchor,
        originDigest,
        backupDigest,
        writerDigest,
        writerEpoch,
        classifications: phase === "classify" ? classifications : [],
      });
      database.exec(`BEGIN TRANSACTION;\n${sql[phase]}\nCOMMIT;`);
      financial[phase] = await readMoneyFrozenDataDigest(reader, "preflight");
      application[phase] = await applicationDigest(reader, "preflight");
    }
    sql["failure-probe"] = `${sql.convert}\nINSERT INTO ${MISSING_TABLE} VALUES (1);\n`;
    financial["failure-probe"] = financial.classify;
    application["failure-probe"] = application.classify;
    sql.resume = buildMoneyCutoverImportSql({
      phase: "resume",
      files,
      anchor,
      originDigest,
      backupDigest,
      writerDigest,
      writerEpoch,
    });
    sql["resume-failure-probe"] =
      `UPDATE money_cutover_freeze SET source_digest = '${hash("synthetic resume false precondition")}' WHERE singleton = 1;\n${sql.resume}`;
    financial["resume-failure-probe"] = financial.convert;
    application["resume-failure-probe"] = application.convert;
    database.exec(`BEGIN TRANSACTION;\n${sql.resume}\nCOMMIT;`);
    financial.resume = await readMoneyFrozenDataDigest(reader, "preflight");
    application.resume = await applicationDigest(reader, "preflight");
    sql["legacy-insert-probe"] =
      "INSERT INTO stripe_events (event_id,type,livemode,event_created_at,received_at,outcome,settled_at) VALUES ('evt_legacy_insert','synthetic',0,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z','ignored','2026-10-14T00:00:00Z');\n";
    sql["legacy-update-probe"] =
      "UPDATE stripe_events SET outcome = 'deferred' WHERE event_id = 'evt_rehearsal';\n";
    sql["legacy-delete-probe"] = "DELETE FROM stripe_events WHERE event_id = 'evt_rehearsal';\n";
    const staleEpoch = hash(`revoked-synthetic-rehearsal:${writerEpoch}`);
    sql["stale-epoch-probe"] =
      `INSERT INTO money_cutover_writer_permit (singleton, epoch, writer_epoch) VALUES (1, '${MONEY_CUTOVER_EPOCH}', '${staleEpoch}');\n`;
    const permitInsert = `INSERT INTO money_cutover_writer_permit (singleton, epoch, writer_epoch) VALUES (1, '${MONEY_CUTOVER_EPOCH}', '${writerEpoch}');`;
    const permitDelete = `DELETE FROM money_cutover_writer_permit WHERE singleton = 1 AND epoch = '${MONEY_CUTOVER_EPOCH}' AND writer_epoch = '${writerEpoch}';`;
    sql["permit-failure-probe"] =
      `${permitInsert}\nUPDATE stripe_events SET outcome = 'deferred' WHERE event_id = 'evt_rehearsal';\nINSERT INTO ${MISSING_TABLE} VALUES (1);\n`;
    sql["permit-success"] =
      `${permitInsert}\nUPDATE stripe_events SET outcome = 'deferred' WHERE event_id = 'evt_rehearsal' AND outcome = 'ignored';\n${permitDelete}\n`;
    for (const phase of [
      "legacy-insert-probe",
      "legacy-update-probe",
      "legacy-delete-probe",
      "stale-epoch-probe",
      "permit-failure-probe",
    ] as const) {
      financial[phase] = financial.resume;
      application[phase] = application.resume;
    }
    database.exec(`BEGIN TRANSACTION;\n${sql["permit-success"]}\nCOMMIT;`);
    const event = database
      .query("SELECT outcome FROM stripe_events WHERE event_id = 'evt_rehearsal'")
      .get() as { outcome: unknown } | null;
    if (event?.outcome !== "deferred")
      throw preflightError("synthetic permitted Stripe UPDATE did not change the seeded row");
    const permit = database
      .query("SELECT COUNT(*) AS n FROM money_cutover_writer_permit")
      .get() as {
      n: number;
    };
    if (permit.n !== 0)
      throw preflightError("synthetic permitted Stripe UPDATE left a writer permit");
    financial["permit-success"] = await readMoneyFrozenDataDigest(reader, "preflight");
    application["permit-success"] = await applicationDigest(reader, "preflight");
    if (
      financial["permit-success"] === financial.resume ||
      application["permit-success"] === application.resume
    )
      throw preflightError("synthetic permitted Stripe UPDATE has no observable native readback");
    return { sql, financial, application, preimageDigest, aggregateDigest, writerEpoch };
  } finally {
    database.close();
  }
}

function readDispatch(directory: string, phase: MoneyRehearsalPhase): DispatchRecord | null {
  const path = join(directory, `${phase}.dispatched.json`);
  if (!existsSync(path)) return null;
  const value = protectedJson(path, "rehearsal dispatch");
  if (
    value.kind !== "takoserver.money-rehearsal-dispatch-record@v1" ||
    !record(value.binding) ||
    value.binding.phase !== phase ||
    !SHA.test(String(value.bindingDigest)) ||
    jsonHash(value.binding) !== value.bindingDigest
  ) {
    throw mutationError("rehearsal dispatch custody is malformed or divergent");
  }
  return value as unknown as DispatchRecord;
}

function readTerminal(
  directory: string,
  phase: MoneyRehearsalPhase,
  dispatch: DispatchRecord | null,
): TerminalRecord | null {
  const path = join(directory, `${phase}.terminal.json`);
  if (!existsSync(path)) return null;
  const value = protectedJson(path, "rehearsal terminal");
  if (
    dispatch === null ||
    value.kind !== "takoserver.money-rehearsal-terminal@v1" ||
    value.bindingDigest !== dispatch.bindingDigest ||
    !SHA.test(String(value.afterShapeDigest)) ||
    !SHA.test(String(value.afterFinancialDigest)) ||
    !SHA.test(String(value.afterApplicationDigest)) ||
    (isFailureProbe(phase)
      ? value.result !== "expected-sql-failure" ||
        !SHA.test(String(value.diagnosticDigest)) ||
        (value.uploadHostClass !== "selected-account-r2" &&
          value.uploadHostClass !== "cloudflare-r2-system") ||
        !SHA.test(String(value.presignedUriDigest))
      : value.result !== "success" ||
        value.diagnosticDigest !== null ||
        value.uploadHostClass !== null ||
        value.presignedUriDigest !== null)
  ) {
    throw mutationError("rehearsal terminal custody lacks its exact immutable dispatch");
  }
  return value as unknown as TerminalRecord;
}

function reviewedDigest(
  value: MoneyRehearsalDeclaration | IntegrationMoneyShadowRehearsalDeclaration,
  binding: ReviewBinding,
): string | null {
  if (!existsSync(value.reviewPath)) return null;
  const review = protectedJson(value.reviewPath, "money rehearsal independent review");
  if (
    Object.keys(review).sort().join(",") !==
      "bindingDigest,evidenceDigest,evidencePath,kind,reviewer" ||
    review.kind !== "takoserver.money-rehearsal-independent-review@v1" ||
    review.bindingDigest !== jsonHash(binding) ||
    !SHA.test(String(review.evidenceDigest)) ||
    typeof review.evidencePath !== "string" ||
    hash(protectedBytes(review.evidencePath, "independent money rehearsal review evidence")) !==
      review.evidenceDigest ||
    typeof review.reviewer !== "string" ||
    review.reviewer.trim() !== review.reviewer ||
    review.reviewer.length < 2
  ) {
    throw preflightError(
      "money rehearsal independent review does not bind the exact phase evidence",
    );
  }
  return jsonHash(review);
}

/** Native rehearsal only. This receipt never grants integration or production apply authority. */
export async function runMoneyUnitRehearsal(
  declaration: MoneyRehearsalDeclaration,
  invocation: MoneyRehearsalInvocation,
  options: MoneyRehearsalOptions = {},
): Promise<Record<string, unknown>> {
  return runSyntheticMoneyRehearsal(declaration, invocation, options);
}

export async function runIntegrationMoneyShadowRehearsal(
  declaration: IntegrationMoneyShadowRehearsalDeclaration,
  invocation: IntegrationMoneyShadowRehearsalInvocation,
  options: MoneyRehearsalOptions = {},
): Promise<Record<string, unknown>> {
  return runSyntheticMoneyRehearsal(declaration, invocation, options);
}

async function runSyntheticMoneyRehearsal(
  declaration: MoneyRehearsalDeclaration | IntegrationMoneyShadowRehearsalDeclaration,
  invocation: MoneyRehearsalInvocation | IntegrationMoneyShadowRehearsalInvocation,
  options: MoneyRehearsalOptions,
): Promise<Record<string, unknown>> {
  const shadow = declaration.kind === "takoserver.integration-money-shadow-rehearsal@v1";
  const selectedEnvironment = shadow ? "integration" : "rehearsal";
  if (
    invocation.environment !== selectedEnvironment ||
    !COMMIT.test(invocation.commit) ||
    (invocation.action !== "status" && invocation.action !== "apply")
  )
    throw preflightError(
      shadow
        ? "money shadow accepts only integration status/apply"
        : "money rehearsal accepts only exact rehearsal status/apply",
    );
  validateDeclaration(declaration);
  validateCreation(declaration);
  const files = readMigrationArtifact(
    options.sourceDirectory ?? join(REPOSITORY, "migrations"),
  ).files;
  assertMoneyCutoverSource(files);
  if (
    options.sourceDirectory !== undefined &&
    options.sourceDirectory !== join(REPOSITORY, "migrations") &&
    invocation.action === "apply"
  ) {
    throw preflightError("money rehearsal apply uses only this reviewed worktree source");
  }
  const credential = await resolveCloudflareCredential(selectedEnvironment, {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  if (
    shadow
      ? credential.source !== "oauth" || "CLOUDFLARE_API_TOKEN" in credential.childEnvironment
      : credential.source !== "api-token"
  )
    throw preflightError(
      shadow
        ? "money shadow requires Wrangler OAuth without an API token surrogate"
        : "money rehearsal requires an explicit API token",
    );
  const provider =
    options.provider ??
    new CloudflareIntegrationStorageProvider(declaration.accountId, credential.token);
  const [identity, inventory] = await Promise.all([
    provider.getD1(declaration.databaseId),
    provider.listD1(declaration.databaseName),
  ]);
  if (
    identity.uuid !== declaration.databaseId ||
    identity.name !== declaration.databaseName ||
    inventory.length !== 1 ||
    inventory[0]?.uuid !== declaration.databaseId ||
    inventory[0]?.name !== declaration.databaseName
  ) {
    throw preflightError("money rehearsal native D1 identity differs from terminal create custody");
  }
  const shape = phaseShape(declaration.phase);
  const previousDispatch =
    shape.previous === null ? null : readDispatch(declaration.custodyDirectory, shape.previous);
  const previous =
    shape.previous === null
      ? null
      : readTerminal(declaration.custodyDirectory, shape.previous, previousDispatch);
  if (shape.previous !== null && previous === null)
    throw preflightError(`money rehearsal requires terminal ${shape.previous} custody`);
  if (
    previousDispatch !== null &&
    (previousDispatch.binding.accountId !== declaration.accountId ||
      previousDispatch.binding.databaseId !== declaration.databaseId ||
      previousDispatch.binding.createReceiptDigest !== declaration.createReceiptDigest ||
      previousDispatch.binding.sourceCommit !== invocation.commit ||
      (shadow &&
        (previousDispatch.binding.authorityProfile !== "integration-shadow-oauth" ||
          previousDispatch.binding.credentialSource !== "wrangler-oauth" ||
          previousDispatch.binding.stageOriginReceiptDigest !==
            declaration.stageOriginReceiptDigest)) ||
      (!shadow && previousDispatch.binding.authorityProfile !== undefined))
  ) {
    throw preflightError("money rehearsal predecessor custody belongs to another D1");
  }
  const dispatched = readDispatch(declaration.custodyDirectory, declaration.phase);
  const terminal = readTerminal(declaration.custodyDirectory, declaration.phase, dispatched);
  if (invocation.action === "apply" && dispatched !== null)
    throw mutationError("money rehearsal phase already dispatched; inspect by status, never retry");
  const run = options.run ?? runCommand;
  const root = mkdtempSync(join(declaration.custodyDirectory, `money-${declaration.phase}-`));
  try {
    const configPath = join(root, "wrangler.jsonc");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          name: shadow ? "takoserver-integration-money-shadow" : "takoserver-money-rehearsal",
          account_id: declaration.accountId,
          compatibility_date: "2026-08-17",
          d1_databases: [
            {
              binding: "STATE_DB",
              database_name: declaration.databaseName,
              database_id: declaration.databaseId,
            },
          ],
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const database = new RemoteD1(configPath, { environment: credential.childEnvironment, run });
    const current = await readD1SchemaState(database);
    const empty =
      current.applied.length === 0 &&
      (
        await database.query(
          "preflight",
          "empty rehearsal schema",
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV'",
        )
      )[0]?.n === 0;
    const exactBefore =
      shape.before === "empty"
        ? empty
        : moneyUnitCutoverSchemaMatches(current, files, shape.before);
    const exactAfter = moneyUnitCutoverSchemaMatches(current, files, shape.after);
    if (!exactBefore && !exactAfter)
      throw preflightError(
        "money rehearsal D1 has partial or foreign schema; quarantine without retry",
      );
    const plan = await buildMoneyRehearsalSyntheticPlan(files, declaration);
    const beforeFinancialDigest =
      shape.before === "empty"
        ? plan.financial.empty
        : await readMoneyFrozenDataDigest(database, "preflight");
    const beforeApplicationDigest =
      shape.before === "empty"
        ? plan.application.empty
        : await applicationDigest(database, "preflight");
    const predecessorFinancial =
      shape.previous === null ? plan.financial.empty : plan.financial[shape.previous];
    const predecessorApplication =
      shape.previous === null ? plan.application.empty : plan.application[shape.previous];
    if (exactBefore && dispatched === null && beforeFinancialDigest !== predecessorFinancial)
      throw preflightError(
        "money rehearsal predecessor financial rows differ from synthetic fixture",
      );
    if (exactBefore && dispatched === null && beforeApplicationDigest !== predecessorApplication)
      throw preflightError(
        "money rehearsal predecessor complete application rows differ from synthetic fixture",
      );
    if (!empty) await assertMoneyNativeForeignKeys(database, "preflight");
    if (exactBefore && dispatched === null && shape.before !== "empty") {
      if (
        (await readMoneyPreimageDigest(database, "preflight")) !== plan.preimageDigest ||
        (await readMoneyAggregateDigest(database, "preflight")) !== plan.aggregateDigest
      ) {
        throw preflightError("money rehearsal predecessor preimage or aggregates differ");
      }
    }
    if (
      dispatched === null &&
      (isFailureProbe(declaration.phase) || declaration.phase === "convert") &&
      (await readMoneyPendingCount(database, "preflight")) !== 0
    )
      throw preflightError("money rehearsal has pending conversion work");
    const sql = plan.sql[declaration.phase];
    const sourceDigest = moneyUnitCutoverSourcePrefixDigest(
      files,
      declaration.phase === "seed" || declaration.phase === "freeze"
        ? 92
        : declaration.phase === "prepare" || declaration.phase === "classify"
          ? 93
          : 94,
    );
    const provenance = readMoneyRehearsalWranglerProvenance();
    const transport = isFailureProbe(declaration.phase)
      ? "structured-d1-import-file"
      : "wrangler-d1-execute-remote-file";
    const endpoint = importEndpoint(declaration.accountId, declaration.databaseId);
    if (
      shadow &&
      isFailureProbe(declaration.phase) &&
      dispatched !== null &&
      !existsSync(declaration.snapshotPath)
    )
      throw mutationError(
        "money shadow dispatched failure probe lost its protected before snapshot",
      );
    const beforeSnapshotDigest =
      shadow && isFailureProbe(declaration.phase) && exactBefore
        ? await shadowSnapshot(
            declaration,
            declaration.snapshotPath,
            root,
            configPath,
            beforeApplicationDigest,
            files,
            run,
            credential.childEnvironment,
            declaration.phase === "failure-probe"
              ? "0093-fenced"
              : declaration.phase === "resume-failure-probe"
                ? "0094-fenced"
                : "0094",
          )
        : shadow && isFailureProbe(declaration.phase) && existsSync(declaration.snapshotPath)
          ? hash(
              protectedBytes(
                declaration.snapshotPath,
                "money shadow before snapshot",
                16 * 1024 * 1024,
              ),
            )
          : null;
    if (dispatched !== null) {
      const retained = dispatched.binding;
      if (
        retained.accountId !== declaration.accountId ||
        retained.databaseId !== declaration.databaseId ||
        retained.databaseName !== declaration.databaseName ||
        retained.createReceiptDigest !== declaration.createReceiptDigest ||
        (shadow &&
          (retained.authorityProfile !== "integration-shadow-oauth" ||
            retained.credentialSource !== "wrangler-oauth" ||
            retained.stageOriginReceiptDigest !== declaration.stageOriginReceiptDigest)) ||
        (!shadow && retained.authorityProfile !== undefined) ||
        retained.sourceCommit !== invocation.commit ||
        retained.sourceDigest !== sourceDigest ||
        retained.sourceSql0094Digest !== files[93]?.digest ||
        retained.writerEpoch !== plan.writerEpoch ||
        retained.importDigest !== hash(sql) ||
        retained.wranglerVersion !== provenance.wranglerVersion ||
        retained.wranglerLauncherDigest !== provenance.wranglerLauncherDigest ||
        retained.wranglerModuleDigest !== provenance.wranglerModuleDigest ||
        retained.importTransport !== transport ||
        retained.importEndpoint !== endpoint ||
        (shadow &&
          isFailureProbe(declaration.phase) &&
          retained.beforeSnapshotDigest !== beforeSnapshotDigest) ||
        !isAbsolute(retained.sealedImportPath) ||
        !relative(declaration.custodyDirectory, retained.sealedImportPath).startsWith(
          `money-${declaration.phase}-`,
        ) ||
        hash(protectedBytes(retained.sealedImportPath, "retained money rehearsal import")) !==
          retained.importDigest
      ) {
        throw mutationError(
          "money rehearsal retained dispatch source, target, transport or SQL diverged",
        );
      }
      const observedApplication = empty
        ? plan.application.empty
        : await applicationDigest(database, "preflight");
      const observedFinancial = empty ? plan.financial.empty : beforeFinancialDigest;
      const matchesExpected =
        exactAfter &&
        observedApplication === plan.application[declaration.phase] &&
        observedFinancial === plan.financial[declaration.phase];
      if (
        terminal !== null &&
        (!matchesExpected ||
          terminal.afterShapeDigest !== current.shapeDigest ||
          terminal.afterApplicationDigest !== observedApplication ||
          terminal.afterFinancialDigest !== observedFinancial ||
          (shadow &&
            isFailureProbe(declaration.phase) &&
            (terminal.beforeSnapshotDigest !== beforeSnapshotDigest ||
              terminal.afterSnapshotDigest !== beforeSnapshotDigest ||
              !existsSync(`${declaration.snapshotPath}.after.sql`) ||
              hash(
                protectedBytes(
                  `${declaration.snapshotPath}.after.sql`,
                  "money shadow after snapshot",
                  16 * 1024 * 1024,
                ),
              ) !== terminal.afterSnapshotDigest)))
      ) {
        throw verificationError(
          "money rehearsal terminal receipt differs from native exact-after readback",
        );
      }
      return {
        kind: "takoserver.money-rehearsal-dispatched-readback@v1",
        environment: selectedEnvironment,
        phase: declaration.phase,
        databaseId: declaration.databaseId,
        schemaShapeDigest: current.shapeDigest,
        custody: terminal === null ? "dispatched" : "terminal",
        exactAfter: matchesExpected,
        applicationDigest: observedApplication,
        financialDigest: observedFinancial,
        uploadHostClass: terminal?.uploadHostClass ?? null,
        presignedUriDigest: terminal?.presignedUriDigest ?? null,
        readyForApply: false,
        nextAction:
          terminal === null
            ? "quarantine; no retry or inferred failure-probe acknowledgement"
            : "next reviewed phase",
        rehearsalOnly: true,
        grantsIntegrationApply: false,
        workerD1BatchProven: false,
      };
    }
    const reviewBinding: ReviewBinding = {
      kind: "takoserver.money-rehearsal-review-binding@v1",
      phase: declaration.phase,
      accountId: declaration.accountId,
      databaseName: declaration.databaseName,
      databaseId: declaration.databaseId,
      createReceiptDigest: declaration.createReceiptDigest,
      sourceCommit: invocation.commit,
      sourceDigest,
      beforePhase: shape.before,
      afterPhase: shape.after,
      beforeShapeDigest: current.shapeDigest,
      beforeFinancialDigest,
      afterFinancialDigest: plan.financial[declaration.phase],
      beforeApplicationDigest,
      afterApplicationDigest: plan.application[declaration.phase],
      preimageDigest: plan.preimageDigest,
      aggregateDigest: plan.aggregateDigest,
      importDigest: hash(sql),
      sourceSql0094Digest: files[93]?.digest ?? "",
      writerEpoch: plan.writerEpoch,
      ...(shadow
        ? {
            authorityProfile: "integration-shadow-oauth" as const,
            credentialSource: "wrangler-oauth" as const,
            stageOriginReceiptDigest: declaration.stageOriginReceiptDigest,
          }
        : {}),
      ...(beforeSnapshotDigest === null ? {} : { beforeSnapshotDigest }),
      ...provenance,
      importTransport: transport,
      importEndpoint: endpoint,
    };
    const reviewDigest = reviewedDigest(declaration, reviewBinding);
    const status = {
      kind: "takoserver.money-rehearsal-status@v1",
      environment: selectedEnvironment,
      phase: declaration.phase,
      databaseId: declaration.databaseId,
      databaseName: declaration.databaseName,
      schemaPhase: empty ? "empty" : exactBefore ? shape.before : shape.after,
      schemaShapeDigest: current.shapeDigest,
      importDigest: reviewBinding.importDigest,
      ...(beforeSnapshotDigest === null ? {} : { beforeSnapshotDigest }),
      reviewBinding,
      reviewBindingDigest: jsonHash(reviewBinding),
      custody: terminal === null ? (dispatched === null ? null : "dispatched") : "terminal",
      readyForApply: exactBefore && dispatched === null && reviewDigest !== null,
      rehearsalOnly: true,
      grantsIntegrationApply: false,
      workerD1BatchProven: false,
    };
    if (invocation.action === "status") return status;
    if (!exactBefore)
      throw preflightError("money rehearsal phase is already terminal; apply refuses replay");
    if (reviewDigest === null)
      throw preflightError("money rehearsal requires protected phase-specific independent review");
    await qualifySource({
      environment: selectedEnvironment,
      commit: invocation.commit,
      policy: "clean-remote",
      run,
    });
    validateCreation(declaration);
    if (reviewedDigest(declaration, reviewBinding) !== reviewDigest)
      throw preflightError("money rehearsal independent review changed before dispatch");
    if (
      beforeSnapshotDigest !== null &&
      (!shadow ||
        hash(
          protectedBytes(
            declaration.snapshotPath,
            "money shadow before snapshot",
            16 * 1024 * 1024,
          ),
        ) !== beforeSnapshotDigest)
    )
      throw preflightError("money shadow protected before snapshot changed before dispatch");
    const [identityNow, inventoryNow] = await Promise.all([
      provider.getD1(declaration.databaseId),
      provider.listD1(declaration.databaseName),
    ]);
    if (
      identityNow.uuid !== declaration.databaseId ||
      identityNow.name !== declaration.databaseName ||
      inventoryNow.length !== 1 ||
      inventoryNow[0]?.uuid !== declaration.databaseId
    )
      throw preflightError("money rehearsal target changed before dispatch");
    const beforeNow = await readD1SchemaState(database);
    if (
      beforeNow.shapeDigest !== current.shapeDigest ||
      (shape.before === "empty"
        ? beforeNow.applied.length !== 0
        : !moneyUnitCutoverSchemaMatches(beforeNow, files, shape.before))
    ) {
      throw preflightError("money rehearsal predecessor changed before dispatch");
    }
    if (
      shape.before === "empty" &&
      (
        await database.query(
          "preflight",
          "empty rehearsal dispatch fence",
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV'",
        )
      )[0]?.n !== 0
    ) {
      throw preflightError("money rehearsal empty D1 changed before seed dispatch");
    }
    if (
      shape.before !== "empty" &&
      (await readMoneyFrozenDataDigest(database, "preflight")) !== predecessorFinancial
    ) {
      throw preflightError("money rehearsal financial rows changed before dispatch");
    }
    if (
      shape.before !== "empty" &&
      (await applicationDigest(database, "preflight")) !== predecessorApplication
    ) {
      throw preflightError("money rehearsal complete application rows changed before dispatch");
    }
    const provenanceNow = readMoneyRehearsalWranglerProvenance();
    if (
      provenanceNow.wranglerLauncherDigest !== provenance.wranglerLauncherDigest ||
      provenanceNow.wranglerModuleDigest !== provenance.wranglerModuleDigest
    ) {
      throw preflightError(
        "money rehearsal pinned Wrangler launcher or CLI changed before dispatch",
      );
    }
    const importPath = join(root, "import.sql");
    writeOnce(importPath, sql);
    const sealed = sealDirectory(root, ["wrangler.jsonc", "import.sql"]);
    const binding: Binding = {
      ...reviewBinding,
      kind: "takoserver.money-rehearsal-dispatch@v1",
      reviewDigest,
      sealedImportPath: importPath,
    };
    const bindingDigest = jsonHash(binding);
    if (readDispatch(declaration.custodyDirectory, declaration.phase) !== null)
      throw mutationError("money rehearsal dispatch appeared before mutation");
    writeOnce(
      join(declaration.custodyDirectory, `${declaration.phase}.dispatched.json`),
      `${JSON.stringify({ kind: "takoserver.money-rehearsal-dispatch-record@v1", bindingDigest, binding })}\n`,
    );
    sealed.assertUnchanged();
    let diagnosticDigest: string | null = null;
    let uploadHostClass: TerminalRecord["uploadHostClass"] = null;
    let presignedUriDigest: string | null = null;
    if (isFailureProbe(declaration.phase)) {
      const observed = await importFailureProbe(
        declaration.accountId,
        declaration.databaseId,
        credential.token,
        sql,
        options.fetcher ?? fetch,
        declaration.phase,
      );
      diagnosticDigest = observed.diagnosticDigest;
      uploadHostClass = observed.uploadHostClass;
      presignedUriDigest = observed.presignedUriDigest;
    } else {
      let result: CommandResult;
      try {
        result = await run(
          wranglerCommand([
            "d1",
            "execute",
            declaration.databaseName,
            "--remote",
            "--yes",
            "--config",
            configPath,
            "--file",
            importPath,
          ]),
          { env: credential.childEnvironment },
        );
      } catch {
        throw mutationError(
          "money rehearsal import ACK unknown; preserve dispatch and inspect by status only",
        );
      }
      if (result.exitCode !== 0) {
        throw mutationError(
          "money rehearsal import was not acknowledged; preserve dispatch and inspect by status only",
        );
      }
    }
    sealed.assertUnchanged();
    const provenanceAfter = readMoneyRehearsalWranglerProvenance();
    if (
      provenanceAfter.wranglerLauncherDigest !== provenance.wranglerLauncherDigest ||
      provenanceAfter.wranglerModuleDigest !== provenance.wranglerModuleDigest
    ) {
      throw verificationError("money rehearsal pinned Wrangler bytes changed during import");
    }
    const after = await readD1SchemaState(database, "verification");
    if (!moneyUnitCutoverSchemaMatches(after, files, shape.after))
      throw verificationError(
        "money rehearsal native import changed schema unexpectedly; quarantine D1",
      );
    const afterFinancialDigest = await readMoneyFrozenDataDigest(database, "verification");
    if (afterFinancialDigest !== plan.financial[declaration.phase])
      throw verificationError(
        "money rehearsal native financial rows differ from sealed synthetic fixture",
      );
    const afterApplicationDigest = await applicationDigest(database, "verification");
    if (afterApplicationDigest !== plan.application[declaration.phase])
      throw verificationError(
        "money rehearsal native complete application rows differ from sealed synthetic fixture",
      );
    const afterSnapshotDigest =
      shadow && isFailureProbe(declaration.phase)
        ? await shadowSnapshot(
            declaration,
            `${declaration.snapshotPath}.after.sql`,
            root,
            configPath,
            afterApplicationDigest,
            files,
            run,
            credential.childEnvironment,
            declaration.phase === "failure-probe"
              ? "0093-fenced"
              : declaration.phase === "resume-failure-probe"
                ? "0094-fenced"
                : "0094",
          )
        : null;
    if (afterSnapshotDigest !== null && afterSnapshotDigest !== beforeSnapshotDigest)
      throw verificationError(
        "money shadow full native export bytes changed after late SQL failure",
      );
    const converted = PHASES.indexOf(declaration.phase) >= PHASES.indexOf("convert");
    if (
      (await readMoneyPreimageDigest(database, "verification", converted)) !==
        plan.preimageDigest ||
      (await readMoneyAggregateDigest(database, "verification", converted)) !== plan.aggregateDigest
    ) {
      throw verificationError("money rehearsal native financial preimage or aggregates changed");
    }
    await assertMoneyNativeForeignKeys(database, "verification");
    const terminalRecord: TerminalRecord = {
      kind: "takoserver.money-rehearsal-terminal@v1",
      bindingDigest,
      result: isFailureProbe(declaration.phase) ? "expected-sql-failure" : "success",
      afterShapeDigest: after.shapeDigest,
      afterFinancialDigest,
      afterApplicationDigest,
      diagnosticDigest,
      uploadHostClass,
      presignedUriDigest,
      ...(beforeSnapshotDigest === null ? {} : { beforeSnapshotDigest }),
      ...(afterSnapshotDigest === null ? {} : { afterSnapshotDigest }),
    };
    writeOnce(
      join(declaration.custodyDirectory, `${declaration.phase}.terminal.json`),
      `${JSON.stringify(terminalRecord)}\n`,
    );
    return {
      ...status,
      custody: "terminal",
      readyForApply: false,
      afterShapeDigest: after.shapeDigest,
      afterFinancialDigest,
      afterApplicationDigest,
      importResult: terminalRecord.result,
      uploadHostClass,
      presignedUriDigest,
      nativeRehearsal: true,
      grantsIntegrationApply: false,
      workerD1BatchProven: false,
    };
  } finally {
    if (invocation.action === "status") rmSync(root, { recursive: true, force: true });
  }
}
