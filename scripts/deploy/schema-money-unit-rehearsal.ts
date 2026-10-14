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
import { dirname, isAbsolute, join, relative } from "node:path";
import { RemoteD1 } from "./d1.ts";
import { buildD1MigrationImport } from "./d1-migration-import.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
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
const PHASES = ["seed", "freeze", "prepare", "classify", "failure-probe", "convert"] as const;
export type MoneyRehearsalPhase = (typeof PHASES)[number];

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

export interface MoneyRehearsalInvocation {
  readonly action: "status" | "apply";
  readonly environment: "rehearsal";
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
  readonly wranglerVersion: "4.123.0";
  readonly wranglerLauncherDigest: string;
  readonly wranglerModuleDigest: string;
  readonly importTransport: "wrangler-d1-execute-remote-file" | "structured-d1-import-file";
  readonly importEndpoint: string;
  readonly reviewDigest: string;
  readonly sealedImportPath: string;
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
export function reviewedFailureProbeResult(value: unknown): string {
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
  if (
    !record(value) ||
    value.success !== true ||
    value.status !== "error" ||
    error === null ||
    !new RegExp(
      `^(?:D1_ERROR: |SQLITE_ERROR: )?no such table: ${MISSING_TABLE}(?:: SQLITE_ERROR)?$`,
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
    !sql.endsWith(`INSERT INTO ${MISSING_TABLE} VALUES (1);\n`)
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
        diagnosticDigest: reviewedFailureProbeResult(state),
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

function protectedBytes(path: string, label: string): Buffer {
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
    stat.size > 1024 * 1024
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

function validateDeclaration(value: MoneyRehearsalDeclaration): void {
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

function validateCreation(value: MoneyRehearsalDeclaration): void {
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
  return `${base}\nINSERT INTO principals (id, provider, provider_subject, email, display_name, created_at) VALUES ('principal-rehearsal','github','synthetic-rehearsal','rehearsal@example.invalid','Synthetic rehearsal','2026-10-14T00:00:00Z');\nINSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES ('org-rehearsal','Synthetic rehearsal','principal-rehearsal','2026-10-14T00:00:00Z');\nINSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at) VALUES ('fund-rehearsal','org-rehearsal','funding','credit-rehearsal',900719925473,0,'2026-10-14T00:00:00Z');\nINSERT INTO wallet_credit_lots (org_id, ref, kind, amount_minor, expires_at, created_at, cursor_handle) VALUES ('org-rehearsal','credit-rehearsal','direct',900719925473,NULL,'2026-10-14T00:00:00Z','11111111111111111111111111111111');\n`;
}

export interface SyntheticPlan {
  readonly sql: Readonly<Record<MoneyRehearsalPhase, string>>;
  readonly financial: Readonly<Record<MoneyRehearsalPhase | "empty", string>>;
  readonly application: Readonly<Record<MoneyRehearsalPhase | "empty", string>>;
  readonly preimageDigest: string;
  readonly aggregateDigest: string;
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

export async function buildMoneyRehearsalSyntheticPlan(
  files: readonly MigrationFile[],
  declaration: MoneyRehearsalDeclaration,
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
        classifications: phase === "classify" ? classifications : [],
      });
      database.exec(`BEGIN TRANSACTION;\n${sql[phase]}\nCOMMIT;`);
      financial[phase] = await readMoneyFrozenDataDigest(reader, "preflight");
      application[phase] = await applicationDigest(reader, "preflight");
    }
    sql["failure-probe"] = `${sql.convert}\nINSERT INTO ${MISSING_TABLE} VALUES (1);\n`;
    financial["failure-probe"] = financial.classify;
    application["failure-probe"] = application.classify;
    return { sql, financial, application, preimageDigest, aggregateDigest };
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
    (phase === "failure-probe"
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

function reviewedDigest(value: MoneyRehearsalDeclaration, binding: ReviewBinding): string | null {
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
  if (
    invocation.environment !== "rehearsal" ||
    !COMMIT.test(invocation.commit) ||
    (invocation.action !== "status" && invocation.action !== "apply")
  )
    throw preflightError("money rehearsal accepts only exact rehearsal status/apply");
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
  const credential = await resolveCloudflareCredential("rehearsal", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  if (credential.source !== "api-token")
    throw preflightError("money rehearsal requires an explicit API token");
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
      previousDispatch.binding.sourceCommit !== invocation.commit)
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
          name: "takoserver-money-rehearsal",
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
      (declaration.phase === "failure-probe" || declaration.phase === "convert") &&
      (await readMoneyPendingCount(database, "preflight")) !== 0
    )
      throw preflightError("money rehearsal has pending conversion work");
    const sql = plan.sql[declaration.phase];
    const sourceDigest = moneyUnitCutoverSourcePrefixDigest(
      files,
      declaration.phase === "convert" || declaration.phase === "failure-probe"
        ? 94
        : declaration.phase === "seed" || declaration.phase === "freeze"
          ? 92
          : 93,
    );
    const provenance = readMoneyRehearsalWranglerProvenance();
    const transport =
      declaration.phase === "failure-probe"
        ? "structured-d1-import-file"
        : "wrangler-d1-execute-remote-file";
    const endpoint = importEndpoint(declaration.accountId, declaration.databaseId);
    if (dispatched !== null) {
      const retained = dispatched.binding;
      if (
        retained.accountId !== declaration.accountId ||
        retained.databaseId !== declaration.databaseId ||
        retained.databaseName !== declaration.databaseName ||
        retained.createReceiptDigest !== declaration.createReceiptDigest ||
        retained.sourceCommit !== invocation.commit ||
        retained.sourceDigest !== sourceDigest ||
        retained.sourceSql0094Digest !== files[93]?.digest ||
        retained.importDigest !== hash(sql) ||
        retained.wranglerVersion !== provenance.wranglerVersion ||
        retained.wranglerLauncherDigest !== provenance.wranglerLauncherDigest ||
        retained.wranglerModuleDigest !== provenance.wranglerModuleDigest ||
        retained.importTransport !== transport ||
        retained.importEndpoint !== endpoint ||
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
          terminal.afterFinancialDigest !== observedFinancial)
      ) {
        throw verificationError(
          "money rehearsal terminal receipt differs from native exact-after readback",
        );
      }
      return {
        kind: "takoserver.money-rehearsal-dispatched-readback@v1",
        environment: "rehearsal",
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
      ...provenance,
      importTransport: transport,
      importEndpoint: endpoint,
    };
    const reviewDigest = reviewedDigest(declaration, reviewBinding);
    const status = {
      kind: "takoserver.money-rehearsal-status@v1",
      environment: "rehearsal",
      phase: declaration.phase,
      databaseId: declaration.databaseId,
      databaseName: declaration.databaseName,
      schemaPhase: empty ? "empty" : exactBefore ? shape.before : shape.after,
      schemaShapeDigest: current.shapeDigest,
      importDigest: reviewBinding.importDigest,
      reviewBinding,
      reviewBindingDigest: jsonHash(reviewBinding),
      custody: terminal === null ? (dispatched === null ? null : "dispatched") : "terminal",
      readyForApply: exactBefore && dispatched === null && reviewDigest !== null,
      rehearsalOnly: true,
      grantsIntegrationApply: false,
    };
    if (invocation.action === "status") return status;
    if (!exactBefore)
      throw preflightError("money rehearsal phase is already terminal; apply refuses replay");
    if (reviewDigest === null)
      throw preflightError("money rehearsal requires protected phase-specific independent review");
    await qualifySource({
      environment: "rehearsal",
      commit: invocation.commit,
      policy: "clean-remote",
      run,
    });
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
    if (declaration.phase === "failure-probe") {
      const observed = await importFailureProbe(
        declaration.accountId,
        declaration.databaseId,
        credential.token,
        sql,
        options.fetcher ?? fetch,
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
    const converted = declaration.phase === "convert";
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
      result: declaration.phase === "failure-probe" ? "expected-sql-failure" : "success",
      afterShapeDigest: after.shapeDigest,
      afterFinancialDigest,
      afterApplicationDigest,
      diagnosticDigest,
      uploadHostClass,
      presignedUriDigest,
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
    };
  } finally {
    if (invocation.action === "status") rmSync(root, { recursive: true, force: true });
  }
}
