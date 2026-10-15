import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  CloudflareIntegrationStorageProvider,
  type IntegrationStorageD1Database,
  type IntegrationStorageFetcher,
} from "./integration-storage-generation.ts";
import { readMigrationArtifact } from "./migrations.ts";
import { REPOSITORY, resolveCloudflareCredential } from "./process.ts";
import type { QualificationProcess } from "./qualification.ts";
import { qualifySource } from "./qualification.ts";
import { readSchemaObjectCount } from "./rehearsal-d1-create.ts";
import {
  assertMoneyCutoverSource,
  moneyUnitCutoverSourcePrefixDigest,
} from "./schema-money-unit-cutover.ts";

const ACCOUNT = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA = /^sha256:[0-9a-f]{64}$/u;
const NAME = /^takoserver-ms-[0-9a-f]{32}$/u;

export interface IntegrationMoneyShadowCreateDeclaration {
  readonly kind: "takoserver.integration-money-shadow-create@v1";
  readonly environment: "integration";
  readonly purpose: "synthetic-money-import-atomicity";
  readonly accountId: string;
  readonly name: string;
  readonly stageOriginReceiptPath: string;
  readonly stageOriginReceiptDigest: string;
  readonly reviewPath: string;
  readonly custodyDirectory: string;
}

export interface IntegrationMoneyShadowCreateInvocation {
  readonly action: "status" | "apply";
  readonly environment: "integration";
  readonly commit: string;
}

export interface IntegrationMoneyShadowCreateProvider {
  listD1(name: string): Promise<readonly IntegrationStorageD1Database[]>;
  getD1(id: string): Promise<IntegrationStorageD1Database>;
  createD1(name: string): Promise<IntegrationStorageD1Database>;
  readSchemaObjectCount(id: string): Promise<number>;
}

export interface IntegrationMoneyShadowCreateOptions {
  readonly run?: QualificationProcess;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly provider?: IntegrationMoneyShadowCreateProvider;
  readonly fetcher?: IntegrationStorageFetcher;
  readonly sourceDirectory?: string;
}

export interface MoneyShadowOrigin {
  readonly receiptDigest: string;
  readonly accountId: string;
  readonly stagingDatabaseId: string;
  readonly stagingDatabaseName: string;
  readonly sourceCommit: string;
  readonly sourceDigest: string;
  readonly reviewEvidenceDigest: string;
}

export interface MoneyShadowCreateBinding {
  readonly kind: "takoserver.integration-money-shadow-create-binding@v1";
  readonly purpose: "synthetic-money-import-atomicity";
  readonly environment: "integration";
  readonly credentialSource: "wrangler-oauth";
  readonly sourceCommit: string;
  readonly sourceDigest: string;
  readonly accountId: string;
  readonly databaseName: string;
  readonly stageOrigin: MoneyShadowOrigin;
  readonly nativeNameAbsent: true;
}

export interface MoneyShadowCreateTerminal {
  readonly kind: "takoserver.integration-money-shadow-create-terminal@v1";
  readonly surface: "takoserver-integration-money-shadow-create";
  readonly environment: "integration";
  readonly purpose: "synthetic-money-import-atomicity";
  readonly credentialSource: "wrangler-oauth";
  readonly bindingDigest: string;
  readonly reviewDigest: string;
  readonly stageOriginReceiptDigest: string;
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly schemaObjectCount: 0;
  readonly commit: string;
}

export function moneyShadowHash(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function moneyShadowProtectedDirectory(path: string): void {
  if (!isAbsolute(path) || !relative(REPOSITORY, path).startsWith(".."))
    throw preflightError("money shadow custody must be outside this repository");
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    realpathSync(path) !== path
  )
    throw preflightError("money shadow custody directory must be owned 0700 without symlinks");
}

export function moneyShadowProtectedBytes(path: string, label: string): Buffer {
  if (!isAbsolute(path) || !relative(REPOSITORY, path).startsWith(".."))
    throw preflightError(`${label} must be outside this repository`);
  moneyShadowProtectedDirectory(dirname(path));
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    stat.size > 1024 * 1024
  )
    throw preflightError(`${label} must be one owned 0600 regular file`);
  return readFileSync(path);
}

export function moneyShadowWriteOnce(path: string, value: string | Uint8Array): void {
  moneyShadowProtectedDirectory(dirname(path));
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw mutationError("money shadow custody already exists; inspect by status, never retry");
  }
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function protectedJson(path: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(moneyShadowProtectedBytes(path, label).toString("utf8"));
  } catch {
    throw preflightError(`${label} is malformed or absent`);
  }
  if (!record(parsed)) throw preflightError(`${label} must be an object`);
  return parsed;
}

export function readMoneyShadowOrigin(
  path: string,
  expectedDigest: string,
  expectedAccountId: string,
  sourceDirectory = join(REPOSITORY, "migrations"),
): MoneyShadowOrigin {
  if (!SHA.test(expectedDigest)) throw preflightError("money shadow origin digest is invalid");
  const bytes = moneyShadowProtectedBytes(path, "reviewed staging origin receipt");
  if (moneyShadowHash(bytes) !== expectedDigest)
    throw preflightError("reviewed staging origin receipt changed");
  const origin = protectedJson(path, "reviewed staging origin receipt");
  const files = readMigrationArtifact(sourceDirectory).files;
  assertMoneyCutoverSource(files);
  const sourceDigest = moneyUnitCutoverSourcePrefixDigest(files, 92);
  if (
    Object.keys(origin).sort().join(",") !==
      "accountId,appliedMigrationsCount,bucketName,databaseId,databaseName,freshLineage,generation,generationApplyLogDigest,generationStatusLogDigest,kind,migrationDigest,reviewEvidenceDigest,reviewRef,reviewedAt,reviewer,schemaShapeDigest,sourceCommit,state,statusPresence,statusReadback,statusTargetSelection" ||
    origin.kind !== "takoserver.money-stage-origin-certificate@v1" ||
    origin.state !== "reviewed" ||
    origin.accountId !== expectedAccountId ||
    !UUID.test(String(origin.databaseId)) ||
    !ACCOUNT.test(String(origin.generation)) ||
    !/^takoserver-i-[0-9a-f]{32}$/u.test(String(origin.databaseName)) ||
    origin.databaseName !== `takoserver-i-${origin.generation}` ||
    origin.bucketName !== origin.databaseName ||
    origin.freshLineage !== "v2-0092" ||
    origin.migrationDigest !== sourceDigest ||
    origin.appliedMigrationsCount !== 92 ||
    origin.statusReadback !== "complete-0092" ||
    origin.statusPresence !== "both" ||
    !record(origin.statusTargetSelection) ||
    origin.statusTargetSelection.d1 !== false ||
    origin.statusTargetSelection.r2 !== false ||
    origin.statusTargetSelection.databaseIdExact !== null ||
    !COMMIT.test(String(origin.sourceCommit)) ||
    !SHA.test(String(origin.reviewEvidenceDigest)) ||
    !SHA.test(String(origin.generationApplyLogDigest)) ||
    !SHA.test(String(origin.generationStatusLogDigest)) ||
    !SHA.test(String(origin.schemaShapeDigest)) ||
    typeof origin.reviewer !== "string" ||
    origin.reviewer.length < 2 ||
    typeof origin.reviewRef !== "string" ||
    origin.reviewRef.length < 2 ||
    typeof origin.reviewedAt !== "string" ||
    !/^20\d\d-\d\d-\d\dT/u.test(origin.reviewedAt)
  )
    throw preflightError("money shadow requires a reviewed exact integration staging 0092 origin");
  return {
    receiptDigest: expectedDigest,
    accountId: expectedAccountId,
    stagingDatabaseId: String(origin.databaseId),
    stagingDatabaseName: String(origin.databaseName),
    sourceCommit: String(origin.sourceCommit),
    sourceDigest,
    reviewEvidenceDigest: String(origin.reviewEvidenceDigest),
  };
}

function validateDeclaration(value: IntegrationMoneyShadowCreateDeclaration): void {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "accountId,custodyDirectory,environment,kind,name,purpose,reviewPath,stageOriginReceiptDigest,stageOriginReceiptPath" ||
    value.kind !== "takoserver.integration-money-shadow-create@v1" ||
    value.environment !== "integration" ||
    value.purpose !== "synthetic-money-import-atomicity" ||
    !ACCOUNT.test(value.accountId) ||
    !NAME.test(value.name) ||
    !SHA.test(value.stageOriginReceiptDigest)
  )
    throw preflightError("money shadow create requires an exact integration-only declaration");
  moneyShadowProtectedDirectory(value.custodyDirectory);
  if (!isAbsolute(value.reviewPath) || !relative(REPOSITORY, value.reviewPath).startsWith(".."))
    throw preflightError("money shadow review must be outside the repository");
}

export function readMoneyShadowCreateReview(path: string, bindingDigest: string): string | null {
  if (!existsSync(path)) return null;
  const review = protectedJson(path, "independent money shadow create review");
  if (
    Object.keys(review).sort().join(",") !==
      "bindingDigest,decision,evidenceDigest,evidencePath,kind,reviewedAt,reviewer" ||
    review.kind !== "takoserver.integration-money-shadow-create-review@v1" ||
    review.bindingDigest !== bindingDigest ||
    review.decision !== "approved" ||
    !SHA.test(String(review.evidenceDigest)) ||
    typeof review.evidencePath !== "string" ||
    moneyShadowHash(
      moneyShadowProtectedBytes(review.evidencePath, "independent money shadow create evidence"),
    ) !== review.evidenceDigest ||
    typeof review.reviewer !== "string" ||
    review.reviewer.trim() !== review.reviewer ||
    review.reviewer.length < 2 ||
    typeof review.reviewedAt !== "string" ||
    !/^20\d\d-\d\d-\d\dT/u.test(review.reviewedAt)
  )
    throw preflightError("independent shadow create review does not bind exact evidence");
  return moneyShadowHash(moneyShadowProtectedBytes(path, "independent money shadow create review"));
}

export async function runIntegrationMoneyShadowCreate(
  declaration: IntegrationMoneyShadowCreateDeclaration,
  invocation: IntegrationMoneyShadowCreateInvocation,
  options: IntegrationMoneyShadowCreateOptions = {},
): Promise<Record<string, unknown>> {
  validateDeclaration(declaration);
  if (
    invocation.environment !== "integration" ||
    (invocation.action !== "status" && invocation.action !== "apply") ||
    !COMMIT.test(invocation.commit)
  )
    throw preflightError(
      "money shadow create accepts integration status/apply and exact commit only",
    );
  if (
    invocation.action === "apply" &&
    options.sourceDirectory !== undefined &&
    options.sourceDirectory !== join(REPOSITORY, "migrations")
  )
    throw preflightError("money shadow create apply requires this reviewed worktree source");
  const origin = readMoneyShadowOrigin(
    declaration.stageOriginReceiptPath,
    declaration.stageOriginReceiptDigest,
    declaration.accountId,
    options.sourceDirectory,
  );
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  if (credential.source !== "oauth" || "CLOUDFLARE_API_TOKEN" in credential.childEnvironment)
    throw preflightError(
      "integration money shadow requires canonical Wrangler OAuth, never an API token surrogate",
    );
  const identity = new CloudflareIntegrationStorageProvider(
    declaration.accountId,
    credential.token,
    {
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    },
  );
  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  const provider: IntegrationMoneyShadowCreateProvider = options.provider ?? {
    listD1: (name) => identity.listD1(name),
    getD1: (id) => identity.getD1(id),
    createD1: (name) => identity.createD1(name),
    readSchemaObjectCount: (id) =>
      readSchemaObjectCount(fetcher, declaration.accountId, credential.token, id),
  };
  const dispatchedPath = join(declaration.custodyDirectory, "create.dispatched.json");
  const terminalPath = join(declaration.custodyDirectory, "create.terminal.json");
  let inventory: readonly IntegrationStorageD1Database[];
  try {
    inventory = await provider.listD1(declaration.name);
  } catch {
    throw preflightError("money shadow name absence or presence cannot be proved");
  }
  if (inventory.length > 1 || (inventory.length === 1 && inventory[0]?.name !== declaration.name))
    throw preflightError("money shadow name inventory is not exact");
  const existing = inventory[0];
  if (existing !== undefined && !UUID.test(existing.uuid))
    throw preflightError("money shadow inventory UUID is malformed");
  const binding: MoneyShadowCreateBinding = {
    kind: "takoserver.integration-money-shadow-create-binding@v1",
    purpose: "synthetic-money-import-atomicity",
    environment: "integration",
    credentialSource: "wrangler-oauth",
    sourceCommit: invocation.commit,
    sourceDigest: origin.sourceDigest,
    accountId: declaration.accountId,
    databaseName: declaration.name,
    stageOrigin: origin,
    nativeNameAbsent: true,
  };
  const bindingDigest = moneyShadowHash(JSON.stringify(binding));
  const dispatch = existsSync(dispatchedPath)
    ? protectedJson(dispatchedPath, "shadow create dispatch")
    : null;
  const terminal = existsSync(terminalPath)
    ? protectedJson(terminalPath, "shadow create terminal")
    : null;
  if (
    dispatch !== null &&
    (dispatch.kind !== "takoserver.integration-money-shadow-create-dispatch@v1" ||
      dispatch.bindingDigest !== bindingDigest ||
      JSON.stringify(dispatch.binding) !== JSON.stringify(binding))
  )
    throw mutationError(
      "money shadow retained create dispatch differs from current origin or source",
    );
  if (
    terminal !== null &&
    (dispatch === null ||
      terminal.kind !== "takoserver.integration-money-shadow-create-terminal@v1" ||
      terminal.bindingDigest !== bindingDigest ||
      terminal.databaseName !== declaration.name ||
      terminal.accountId !== declaration.accountId ||
      terminal.credentialSource !== "wrangler-oauth" ||
      terminal.stageOriginReceiptDigest !== origin.receiptDigest ||
      !UUID.test(String(terminal.databaseId)) ||
      terminal.schemaObjectCount !== 0)
  )
    throw verificationError("money shadow terminal create custody is inconsistent");
  if (terminal !== null) {
    let native: IntegrationStorageD1Database;
    try {
      native = await provider.getD1(String(terminal.databaseId));
    } catch {
      throw verificationError("money shadow terminal create native identity cannot be read");
    }
    if (
      existing?.uuid !== terminal.databaseId ||
      native.uuid !== terminal.databaseId ||
      native.name !== declaration.name
    )
      throw verificationError("money shadow terminal create differs from native identity");
  }
  const reviewDigest =
    existing === undefined && dispatch === null
      ? readMoneyShadowCreateReview(declaration.reviewPath, bindingDigest)
      : null;
  const status = {
    kind: "takoserver.integration-money-shadow-create-status@v1",
    surface: "takoserver-integration-money-shadow-create",
    environment: "integration",
    credentialSource: "wrangler-oauth",
    binding: existing === undefined || dispatch !== null ? binding : null,
    bindingDigest: existing === undefined || dispatch !== null ? bindingDigest : null,
    reviewDigest,
    databaseName: declaration.name,
    databaseId: existing?.uuid ?? null,
    nativePresence: existing === undefined ? "absent" : "present",
    custody: terminal !== null ? "terminal" : dispatch !== null ? "dispatched" : null,
    readyForApply: existing === undefined && dispatch === null && reviewDigest !== null,
  };
  if (invocation.action === "status") return status;
  if (existing !== undefined || dispatch !== null)
    throw mutationError(
      "money shadow create already exists or was dispatched; no adoption or retry",
    );
  if (reviewDigest === null)
    throw preflightError(
      "money shadow create requires protected binding-specific independent review",
    );
  await qualifySource({
    environment: "integration",
    commit: invocation.commit,
    policy: "clean-remote",
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  if (
    JSON.stringify(
      readMoneyShadowOrigin(
        declaration.stageOriginReceiptPath,
        declaration.stageOriginReceiptDigest,
        declaration.accountId,
        options.sourceDirectory,
      ),
    ) !== JSON.stringify(origin) ||
    readMoneyShadowCreateReview(declaration.reviewPath, bindingDigest) !== reviewDigest
  )
    throw preflightError("money shadow origin or independent review changed before create");
  const fenced = await provider.listD1(declaration.name);
  if (fenced.length !== 0)
    throw preflightError("money shadow name appeared before create; refusing adoption");
  moneyShadowWriteOnce(
    dispatchedPath,
    `${JSON.stringify({ kind: "takoserver.integration-money-shadow-create-dispatch@v1", bindingDigest, binding, reviewDigest })}\n`,
  );
  let created: IntegrationStorageD1Database;
  try {
    created = await provider.createD1(declaration.name);
  } catch {
    throw mutationError(
      "money shadow create ACK unknown; retain dispatch, inspect by status, never retry",
    );
  }
  if (
    created.name !== declaration.name ||
    !UUID.test(created.uuid) ||
    created.uuid === origin.stagingDatabaseId
  )
    throw verificationError(
      "money shadow create returned foreign identity; retain dispatch, never retry",
    );
  let actual: IntegrationStorageD1Database;
  let finalInventory: readonly IntegrationStorageD1Database[];
  let count: number;
  try {
    [actual, finalInventory, count] = await Promise.all([
      provider.getD1(created.uuid),
      provider.listD1(declaration.name),
      provider.readSchemaObjectCount(created.uuid),
    ]);
  } catch {
    throw verificationError(
      "money shadow create native readback failed; retain dispatch and never retry",
    );
  }
  if (actual.name !== declaration.name || actual.uuid !== created.uuid)
    throw verificationError("money shadow create native identity differs; retain dispatch");
  if (
    finalInventory.length !== 1 ||
    finalInventory[0]?.uuid !== created.uuid ||
    finalInventory[0]?.name !== declaration.name
  )
    throw verificationError("money shadow create native name inventory differs; retain dispatch");
  if (count !== 0)
    throw verificationError(
      "money shadow D1 has application schema; retain dispatch and quarantine",
    );
  const result: MoneyShadowCreateTerminal = {
    kind: "takoserver.integration-money-shadow-create-terminal@v1",
    surface: "takoserver-integration-money-shadow-create",
    environment: "integration",
    purpose: "synthetic-money-import-atomicity",
    credentialSource: "wrangler-oauth",
    bindingDigest,
    reviewDigest,
    stageOriginReceiptDigest: origin.receiptDigest,
    accountId: declaration.accountId,
    databaseName: declaration.name,
    databaseId: created.uuid,
    schemaObjectCount: 0,
    commit: invocation.commit,
  };
  moneyShadowWriteOnce(terminalPath, `${JSON.stringify(result)}\n`);
  return result as unknown as Record<string, unknown>;
}
