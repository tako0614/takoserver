import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AUTH103_NATIVE_CATALOG_QUERY,
  AUTH103_NATIVE_CURRENT_PREDICATE,
  AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE,
  AUTH103_NATIVE_MIGRATIONS,
  AUTH103_NATIVE_PROFILE,
  type Auth103NativeSourceManifest,
  auth103RpRegistrationRecord,
} from "../../src/auth103-native-source-contract.ts";
import { canonicalJson } from "../../src/json.ts";
import { MONEY_CUTOVER_EPOCH } from "../../src/money-cutover-sql.ts";
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";
import { applicationSchemaMatches } from "./application-schema-shape.ts";
import { readAuth103CanonicalMigrationSource } from "./auth103-canonical-migration-source.ts";
import {
  createAuth103NativeSourceInstallContribution,
  prepareAuth103NativeBuildSource,
  readAuth103NativeBuildDefine,
} from "./auth103-native-source.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { buildD1MigrationImport, type D1MigrationImportArtifact } from "./d1-migration-import.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  canonicalSchemaShape,
  type D1SchemaState,
  type MigrationArtifact,
  readD1SchemaState,
} from "./migrations.ts";
import {
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { qualifySource } from "./qualification.ts";
import { writeWorkerConfig } from "./realized-config.ts";
import {
  type MoneyOriginalPreserved100Source,
  type MoneyOriginalPreserved103Precursor,
  moneyPost100ExpectedPreservedShape,
  moneyPost103ExpectedPreservedShape,
  readIntegrationMoneyOriginalPreserved100Source,
  readIntegrationMoneyOriginalPreserved103Precursor,
} from "./schema-money-unit-cutover.ts";
import { exactV2MaintenanceModuleDigest } from "./schema-v2-existing-transition.ts";
import { type DeployTarget, loadTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  inspectLiveWorkerVersion,
  workerVersionAnnotationProfile,
  workerVersionIdentity,
} from "./worker-live.ts";
import {
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  parseWorkerDeploymentChain,
} from "./worker-state.ts";
import { acquireWranglerVersionPublicationLease } from "./wrangler-state.ts";

const MODE = "pre-auth103-quiesced";
const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const dataDigest = (value: unknown) => digest(canonicalJson(value));
const failure = "Auth103 source registration inspection is unavailable";
const versionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function finiteOriginalRead<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw preflightError(message);
  }
}

/** Finite historical file DATA only; neither reader grants custody authority. */
export function readAuth103ExpectedScratchConfigBytes(path: string): Buffer {
  return finiteOriginalRead(
    () => readFileSync(path),
    "Auth103 original Worker config is unavailable",
  );
}

export function readAuth103OriginalRetainedInstallSql(path: string): string {
  return finiteOriginalRead(
    () => readFileSync(path, "utf8"),
    "Auth103 original source installation contribution is unavailable",
  );
}

export interface Auth103OriginalHistory extends Record<string, unknown> {
  readonly kind: "takoserver.auth103-original-history@v1";
  readonly environment: "integration";
  readonly commit: string;
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly workerName: string;
  readonly targetRef: string;
  readonly sourceRef: string;
  readonly authSchemaRef: string;
  readonly sourceDigest: string;
  readonly importDigest: string;
  readonly importBytes: number;
  readonly originalBundleDigest: `sha256:${string}`;
  readonly originalVersionId: string;
  readonly originalDeploymentId: string;
  readonly sourceRegistrationRef: string;
  readonly rpRegistrationRef: string;
  readonly deploymentRef: string;
  readonly deploymentReceiptRef: string;
  readonly rpReceiptRef: string;
  readonly sourceProfile: "ordinary" | "money-preserved";
}

function originalJson(
  path: string,
  maxBytes: number,
  format: "compact" | "pretty" = "compact",
): Record<string, unknown> {
  const before = finiteOriginalRead(
    () => lstatSync(path, { bigint: true }),
    "Auth103 original custody file is unavailable",
  );
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes)
  )
    throw preflightError("Auth103 original custody file is unavailable");
  const bytes = finiteOriginalRead(
    () => readFileSync(path),
    "Auth103 original custody file is unavailable",
  );
  const after = finiteOriginalRead(
    () => lstatSync(path, { bigint: true }),
    "Auth103 original custody file changed during read",
  );
  if (
    bytes.byteLength !== Number(before.size) ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.size !== after.size
  )
    throw preflightError("Auth103 original custody file changed during read");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw preflightError("Auth103 original custody JSON is incomplete");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw preflightError("Auth103 original custody JSON is malformed");
  const expected = `${JSON.stringify(value, null, format === "pretty" ? 2 : undefined)}\n`;
  if (!bytes.equals(Buffer.from(expected, "utf8")))
    throw preflightError("Auth103 original custody bytes differ from its writer format");
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, names: readonly string[]): void {
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(names))
    throw preflightError("Auth103 original custody record has an unexpected shape");
}

/** Only the original owner dispatch and its physically retained release may
 * supply a historical import/Version selector. This reader never repairs it. */
/** A finite custody-file DATA check. It confers no provider or D1 authority. */
export function readAuth103OriginalDispatchData(input: {
  readonly custody: string;
  readonly commit: string;
  readonly targetRef: string;
  readonly sourceRef: string;
  readonly importDigest: string;
  readonly importBytes: number;
  readonly bundleDigest: `sha256:${string}`;
  readonly currentRelease?: string;
}): {
  readonly versionId: string;
  readonly deploymentId: string;
  readonly releaseDirectory: string;
} {
  const record = originalJson(join(input.custody, "auth103-dispatched.json"), 4096);
  exactFields(record, [
    "kind",
    "commit",
    "targetRef",
    "sourceRef",
    "importDigest",
    "importBytes",
    "bundleDigest",
    "versionId",
    "deploymentId",
    "releaseDirectory",
  ]);
  if (
    record.kind !== "takoserver.auth103-dispatched@v1" ||
    record.commit !== input.commit ||
    record.targetRef !== input.targetRef ||
    record.sourceRef !== input.sourceRef ||
    record.importDigest !== input.importDigest ||
    record.importBytes !== input.importBytes ||
    record.bundleDigest !== input.bundleDigest ||
    typeof record.versionId !== "string" ||
    !versionId.test(record.versionId) ||
    typeof record.deploymentId !== "string" ||
    record.deploymentId.length === 0 ||
    typeof record.releaseDirectory !== "string" ||
    !isAbsolute(record.releaseDirectory) ||
    resolve(record.releaseDirectory) !== record.releaseDirectory
  )
    throw preflightError("Auth103 original dispatch differs from its selected source");
  const release = record.releaseDirectory;
  const location = relative(input.custody, release).split(sep);
  if (
    location.length !== 2 ||
    !/^auth103-source-[A-Za-z0-9]+$/u.test(location[0] ?? "") ||
    location[1] !== "release" ||
    finiteOriginalRead(
      () => realpathSync(release),
      "Auth103 original release is outside its dispatch custody",
    ) !== release
  )
    throw preflightError("Auth103 original release is outside its dispatch custody");
  const stat = finiteOriginalRead(
    () => lstatSync(release),
    "Auth103 original release inventory is incomplete",
  );
  const inventory = finiteOriginalRead(
    () => readdirSync(release),
    "Auth103 original release inventory is incomplete",
  );
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    JSON.stringify(inventory.slice().sort()) !==
      JSON.stringify([
        "auth103-one-import.sql",
        "auth103-source-install.sql",
        "worker.js",
        "wrangler.jsonc",
      ])
  )
    throw preflightError("Auth103 original release inventory is incomplete");
  for (const name of inventory) {
    const historical = join(release, name);
    const file = finiteOriginalRead(
      () => lstatSync(historical),
      "Auth103 original release bytes differ from the source-owned build",
    );
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      !finiteOriginalRead(() => {
        const bytes = readFileSync(historical);
        return (
          input.currentRelease === undefined ||
          bytes.equals(readFileSync(join(input.currentRelease, name)))
        );
      }, "Auth103 original release bytes differ from the source-owned build")
    )
      throw preflightError("Auth103 original release bytes differ from the source-owned build");
  }
  return {
    versionId: record.versionId,
    deploymentId: record.deploymentId,
    releaseDirectory: release,
  };
}

/** Historical GET uses only the four original retained files. It never
 * rebuilds a Worker, writes into dispatch custody, or seals it with chmod. */
function readAuth103RetainedWorkerArtifact(input: {
  readonly custody: string;
  readonly scratch: string;
  readonly target: DeployTarget;
  readonly commit: string;
}) {
  const record = originalJson(join(input.custody, "auth103-dispatched.json"), 4096);
  if (
    typeof record.releaseDirectory !== "string" ||
    !isAbsolute(record.releaseDirectory) ||
    resolve(record.releaseDirectory) !== record.releaseDirectory
  )
    throw preflightError("Auth103 original release locator is unavailable");
  const release = record.releaseDirectory;
  const location = relative(input.custody, release).split(sep);
  if (
    location.length !== 2 ||
    !/^auth103-source-[A-Za-z0-9]+$/u.test(location[0] ?? "") ||
    location[1] !== "release" ||
    finiteOriginalRead(
      () => realpathSync(release),
      "Auth103 original release locator is unavailable",
    ) !== release
  )
    throw preflightError("Auth103 original release locator is unavailable");
  const names = [
    "auth103-one-import.sql",
    "auth103-source-install.sql",
    "worker.js",
    "wrangler.jsonc",
  ] as const;
  const readRelease = () => {
    const inventory = finiteOriginalRead(
      () => readdirSync(release).sort(),
      "Auth103 original release inventory is incomplete",
    );
    if (JSON.stringify(inventory) !== JSON.stringify(names))
      throw preflightError("Auth103 original release inventory is incomplete");
    return names.map((name) => {
      const path = join(release, name);
      return finiteOriginalRead(() => {
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
          throw preflightError("Auth103 original release inventory is incomplete");
        const bytes = readFileSync(path);
        const after = lstatSync(path, { bigint: true });
        if (
          BigInt(bytes.byteLength) !== before.size ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          before.size !== after.size
        )
          throw preflightError("Auth103 original release changed during read");
        return bytes;
      }, "Auth103 original release inventory is incomplete");
    });
  };
  const original = prepareAuth103NativeBuildSource({
    sourceRoot: REPOSITORY,
    commit: input.commit,
    target: input.target,
  });
  const first = readRelease();
  const bundleDigest = digest(first[2]!);
  const expectedConfig = finiteOriginalRead(
    () =>
      writeWorkerConfig(input.target, {
        path: join(input.scratch, "expected-original-wrangler.jsonc"),
        main: "worker.js",
        commit: input.commit,
        sourceRepositoryRoot: REPOSITORY,
        auth103NativeSource: original,
        workerArtifactDigest: bundleDigest,
        authorityProfile: {
          kind: "provenance-bound-jit",
          provenance: { sourceCommit: input.commit, artifactDigest: bundleDigest },
        },
      }),
    "Auth103 original Worker config is unavailable",
  );
  if (!first[3]!.equals(readAuth103ExpectedScratchConfigBytes(expectedConfig)))
    throw preflightError("Auth103 original Worker config differs from its source-owned target");
  const expectedInstall = finiteOriginalRead(
    () => createAuth103NativeSourceInstallContribution(original, join(release, "worker.js")),
    "Auth103 original source installation contribution is unavailable",
  );
  if (expectedInstall === null || !first[1]!.equals(Buffer.from(expectedInstall)))
    throw preflightError("Auth103 original source installation differs from its owner");
  const assertUnchanged = () => {
    const current = readRelease();
    if (current.some((bytes, index) => !bytes.equals(first[index]!)))
      throw preflightError("Auth103 original release changed during historical read");
  };
  return {
    releaseDirectory: release,
    configPath: join(release, "wrangler.jsonc"),
    bundleDigestHex: bundleDigest.slice(7),
    auth103SourceInstallPath: join(release, "auth103-source-install.sql"),
    auth103NativeSource: original,
    seal: () => ({ assertUnchanged }),
  };
}

export function compileAuth103NativeImportShapes(artifact: MigrationArtifact) {
  const database = new Database(":memory:", { strict: true });
  try {
    database.query("PRAGMA foreign_keys=ON").all();
    let prefixShape = "";
    for (const [index, file] of artifact.files.entries()) {
      const bytes = readFileSync(file.path);
      if (bytes.byteLength !== file.bytes || digest(bytes) !== file.digest)
        throw preflightError("Auth103 source changed while compiling its expected shape");
      database.query("BEGIN IMMEDIATE").all();
      try {
        for (const statement of frameHostMigrationSql(bytes.toString("utf8")))
          database.query(statement).all();
        database.query("COMMIT").all();
      } catch {
        database.query("ROLLBACK").all();
        throw preflightError("Auth103 expected source compilation failed");
      }
      if (index === 99) prefixShape = shape(database);
    }
    if (prefixShape.length === 0) throw preflightError(failure);
    return Object.freeze({
      prefixShape,
      postShape: shape(database),
      catalog: Object.freeze(database.query(AUTH103_NATIVE_CATALOG_QUERY).all()),
    });
  } catch {
    // Engine failures can contain an opaque predecessor SQL body.
    throw preflightError("Auth103 expected source compilation failed");
  } finally {
    database.close();
  }
}

/** Exact alternate source replay from Money's retained fenced98 lineage.
 * Its guard objects are compiled by the Money owner; the Auth owner still
 * checks the registered103 recipes and their independent catalog. */
export function compileAuth103MoneyPreservedImportShapes(artifact: MigrationArtifact) {
  if (artifact.files.length !== 103)
    throw preflightError("Auth103 Money-preserved source requires exactly 103 migrations");
  const ordinary = compileAuth103NativeImportShapes(artifact);
  const prefixShape = moneyPost100ExpectedPreservedShape(artifact.files.slice(0, 100));
  const postShape = moneyPost103ExpectedPreservedShape(artifact.files);
  if (prefixShape === ordinary.prefixShape || postShape === ordinary.postShape)
    throw preflightError("Auth103 Money-preserved source lost its distinct frozen guards");
  return Object.freeze({ prefixShape, postShape, catalog: ordinary.catalog });
}

function shape(database: Database): string {
  return canonicalSchemaShape(
    database
      .query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
        "SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_schema " +
          "WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
      )
      .all(),
  );
}

/** Schema readiness DATA only. Native request qualification still requires the
 * actual platform binding and the source/RP/deployment originals and receipts. */
export function auth103SourceSchemaReady(
  input: {
    readonly local: readonly string[];
    readonly applied: readonly string[];
    readonly shape?: string;
    readonly shapeDigest?: string;
  },
  sourceRoot: string,
  mode: "maintenance" | "normal",
  profile: "ordinary" | "money-preserved" = "ordinary",
): boolean {
  try {
    if (input.shape === undefined || input.shapeDigest === undefined) return false;
    const source = readAuth103CanonicalMigrationSource(sourceRoot);
    try {
      if (JSON.stringify(input.local) !== JSON.stringify(source.physicalNames)) return false;
      const count = input.applied.length;
      if (
        (count !== 100 && count !== 103) ||
        (mode === "normal" && count !== 103) ||
        input.applied.some((name, index) => name !== source.artifact.names[index])
      )
        return false;
      const expected =
        profile === "money-preserved"
          ? compileAuth103MoneyPreservedImportShapes(source.artifact)
          : compileAuth103NativeImportShapes(source.artifact);
      source.assertCurrent();
      return applicationSchemaMatches(
        { applied: input.applied, shape: input.shape, shapeDigest: input.shapeDigest },
        count === 100 ? expected.prefixShape : expected.postShape,
      );
    } finally {
      source.dispose();
    }
  } catch {
    return false;
  }
}

function ledgerPredicate(names: readonly string[]): string {
  return `(SELECT json_group_array(name) FROM (SELECT name FROM main.d1_migrations ORDER BY id))
    IS ${sqlLiteral(JSON.stringify(names))}
    AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema
      WHERE tbl_name='d1_migrations' AND type<>'table' AND name NOT GLOB 'sqlite_*')`;
}

function originalShapePredicate(expectedShape: string): string {
  return `NOT EXISTS (
    WITH expected AS MATERIALIZED (SELECT value FROM json_each(${sqlLiteral(expectedShape)})),
    actual AS MATERIALIZED (SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM main.sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' AND tbl_name NOT IN ('d1_migrations','_cf_KV','_cf_METADATA'))
    SELECT 1 FROM expected LEFT JOIN actual ON actual.type=json_extract(expected.value,'$.type')
      AND actual.name=json_extract(expected.value,'$.name')
      AND actual.tbl_name=json_extract(expected.value,'$.table')
    WHERE actual.name IS NULL OR actual.sql IS NOT json_extract(expected.value,'$.sql')
    UNION ALL
    SELECT 1 FROM actual WHERE NOT EXISTS (SELECT 1 FROM expected
      WHERE actual.type=json_extract(expected.value,'$.type') AND actual.name=json_extract(expected.value,'$.name')
        AND actual.tbl_name=json_extract(expected.value,'$.table'))
  )`;
}

function boundPredicate(sql: string, values: readonly string[]): string {
  let index = 0;
  const output = sql.replaceAll("?", () => {
    const value = values[index++];
    if (value === undefined) throw preflightError("Auth103 fixed predicate bind mismatch");
    return sqlLiteral(value);
  });
  if (index !== values.length) throw preflightError("Auth103 fixed predicate bind mismatch");
  return output;
}

/** Exact Money row identity remains frozen on both sides of ONE103. The
 * source object is produced by the original Money owner, never by a selector
 * or manifest parsed by this SQL composer. */
type MoneyOriginalSource = MoneyOriginalPreserved100Source | MoneyOriginalPreserved103Precursor;

function moneyOriginalFrozenPredicate(source: MoneyOriginalSource): string {
  if (
    (source.kind !== "takoserver.money-original-preserved100-source@v1" &&
      source.kind !== "takoserver.money-original-preserved103-precursor@v1") ||
    source.qualification !== "native-read-only"
  )
    throw preflightError("Auth103 Money original100 source is unavailable");
  return `(SELECT count(*) FROM main.money_cutover_freeze)=1
    AND EXISTS (SELECT 1 FROM main.money_cutover_freeze WHERE singleton=1
      AND binding_digest=${sqlLiteral(source.freezeBindingDigest)}
      AND origin_digest=${sqlLiteral(source.originDigest)}
      AND backup_digest=${sqlLiteral(source.original92BackupDigest)}
      AND writer_digest=${sqlLiteral(source.freezeWriterDigest)}
      AND source_digest=${sqlLiteral(source.freezeSourceDigest)})
    AND (SELECT count(*) FROM main.money_cutover_authorized_epoch)=1
    AND EXISTS (SELECT 1 FROM main.money_cutover_authorized_epoch WHERE singleton=1
      AND writer_epoch=${sqlLiteral(source.currentWriterEpoch)})
    AND NOT EXISTS (SELECT 1 FROM main.money_cutover_writer_permit)
    AND (SELECT count(*) FROM main.money_unit_policy)=1
    AND EXISTS (SELECT 1 FROM main.money_unit_policy WHERE singleton=1
      AND ledger_unit=${sqlLiteral(MONEY_CUTOVER_EPOCH)}
      AND historical_usage_unit='microcent-v1' AND cash_unit='usd-cents-v1')`;
}

/** SQL DATA composer, not source enrollment authority. The actual route below
 * obtains all inputs from the audited source and ORIGINAL artifact constructor.
 * The unchanged ledger importer remains the only migration-file composer. */
export function composeAuth103NativeImportData(input: {
  readonly artifact: MigrationArtifact;
  readonly prefixShape: string;
  readonly postShape?: string;
  readonly moneySource?: MoneyOriginalSource;
  readonly catalogJson: string;
  readonly registration: readonly [string, string, string, string];
  readonly installSql: string;
}): D1MigrationImportArtifact {
  if (
    input.artifact.files.length !== 103 ||
    JSON.stringify(input.artifact.names.slice(100)) !== JSON.stringify(AUTH103_NATIVE_MIGRATIONS)
  )
    throw preflightError("Auth103 import requires the fixed three successors");
  if ((input.postShape === undefined) !== (input.moneySource === undefined))
    throw preflightError("Auth103 Money union requires its source and exact postshape together");
  if (
    input.moneySource !== undefined &&
    (input.prefixShape !== moneyPost100ExpectedPreservedShape(input.artifact.files.slice(0, 100)) ||
      input.postShape !== moneyPost103ExpectedPreservedShape(input.artifact.files))
  )
    throw preflightError("Auth103 Money union differs from its fixed source replay");
  const install = frameHostMigrationSql(input.installSql);
  if (
    install.length !== 4 ||
    !/^INSERT INTO auth103_native_deployment_receipts\(/u.test(install[3]?.trim() ?? "")
  )
    throw preflightError("Auth103 import requires its mandatory final deployment receipt");
  const migrations = buildD1MigrationImport(input.artifact.files.slice(100), {
    freshLedger: false,
  });
  const frozen =
    input.moneySource === undefined
      ? ""
      : ` AND (${moneyOriginalFrozenPredicate(input.moneySource)})`;
  const before = `${ledgerPredicate(input.artifact.names.slice(0, 100))} AND ${originalShapePredicate(input.prefixShape)}${frozen}`;
  const after = `${ledgerPredicate(input.artifact.names)} AND ${boundPredicate(
    AUTH103_NATIVE_CURRENT_PREDICATE,
    [...input.registration, input.catalogJson],
  )}${input.postShape === undefined ? "" : ` AND ${originalShapePredicate(input.postShape)}${frozen}`}`;
  // The false branch always raises a real SQL error. No scratch DDL is added to
  // the owner's101/102 precondition catalog and no JS post-check grants rollback.
  const guard = (predicate: string) =>
    `SELECT json(CASE WHEN (${predicate}) IS 1 THEN '{}' ELSE '!' END);\n`;
  const sql =
    guard(before) +
    migrations.sql +
    "\n" +
    install.slice(0, 3).join(";\n") +
    ";\n" +
    guard(after) +
    install[3] +
    ";\n";
  return Object.freeze({ sql, digest: digest(sql), bytes: Buffer.byteLength(sql) });
}

function custodyDirectory(): string {
  const requested = requireEnvironment("TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY");
  if (
    !isAbsolute(requested) ||
    resolve(requested) !== requested ||
    finiteOriginalRead(
      () => realpathSync(requested),
      "Auth103 custody requires its original absolute physical directory",
    ) !== requested
  )
    throw preflightError("Auth103 custody requires its original absolute physical directory");
  const stat = finiteOriginalRead(
    () => lstatSync(requested),
    "Auth103 custody requires an owned0700 directory",
  );
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw preflightError("Auth103 custody requires an owned0700 directory");
  for (let path = requested; ; path = dirname(path)) {
    if (existsSync(join(path, ".git")))
      throw preflightError("Auth103 custody must stay outside Git");
    if (path === dirname(path)) break;
  }
  return requested;
}

/** A read-only original custody identity. Paths themselves grant no authority. */
export function readAuth103OriginalCustodyDirectory() {
  const path = custodyDirectory();
  const before = finiteOriginalRead(
    () => lstatSync(path, { bigint: true }),
    "Auth103 original custody directory changed during preparation",
  );
  const assertUnchanged = () => {
    const current = finiteOriginalRead(
      () => lstatSync(path, { bigint: true }),
      "Auth103 original custody directory changed during preparation",
    );
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.mode !== before.mode ||
      finiteOriginalRead(
        () => realpathSync(path),
        "Auth103 original custody directory changed during preparation",
      ) !== path
    )
      throw preflightError("Auth103 original custody directory changed during preparation");
  };
  assertUnchanged();
  return Object.freeze({ path, assertUnchanged });
}

function protectedMoneyLocator(name: string): string {
  const path = requireEnvironment(name);
  if (!isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/u.test(path))
    throw preflightError(`${name} requires a canonical absolute protected path`);
  return path;
}

/** Original Money custody is reconstructed by its owner from retained inputs.
 * The added target path is only a locator: neither it nor the Auth target may
 * mint a Money proof or silently relabel the pre-wallet target profile. */
async function readOriginalMoneySelection(
  authTarget: DeployTarget,
  through: 100 | 103,
): Promise<{ readonly source: MoneyOriginalSource; readonly assertLocator: () => void }> {
  const originalTargetPath = protectedMoneyLocator("TAKOSERVER_D1_MONEY_ORIGINAL_TARGET_PATH");
  const originalCreatePath = protectedMoneyLocator(
    "TAKOSERVER_INTEGRATION_STORAGE_ORIGINAL_CREATE_INPUT_PATH",
  );
  const convertDeclarationPath = protectedMoneyLocator(
    "TAKOSERVER_D1_MONEY_CUTOVER_DECLARATION_PATH",
  );
  const post94DeclarationPath = protectedMoneyLocator(
    "TAKOSERVER_D1_MONEY_POST94_DECLARATION_PATH",
  );
  const targetStat = finiteOriginalRead(
    () => lstatSync(originalTargetPath, { bigint: true }),
    "Auth103 original Money target locator is not a protected regular file",
  );
  if (
    !targetStat.isFile() ||
    targetStat.isSymbolicLink() ||
    targetStat.nlink !== 1n ||
    (targetStat.mode & 0o077n) !== 0n ||
    (typeof process.getuid === "function" && targetStat.uid !== BigInt(process.getuid()))
  )
    throw preflightError("Auth103 original Money target locator is not a protected regular file");
  const targetBytes = finiteOriginalRead(
    () => readFileSync(originalTargetPath),
    "Auth103 original Money target locator changed during read",
  );
  const targetDigest = digest(targetBytes);
  const assertLocator = () => {
    const current = finiteOriginalRead(
      () => lstatSync(originalTargetPath, { bigint: true }),
      "Auth103 original Money target locator changed during read",
    );
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== targetStat.dev ||
      current.ino !== targetStat.ino ||
      current.mode !== targetStat.mode ||
      current.mtimeNs !== targetStat.mtimeNs ||
      current.ctimeNs !== targetStat.ctimeNs ||
      current.size !== targetStat.size ||
      digest(
        finiteOriginalRead(
          () => readFileSync(originalTargetPath),
          "Auth103 original Money target locator changed during read",
        ),
      ) !== targetDigest
    )
      throw preflightError("Auth103 original Money target locator changed during read");
  };
  const moneyTarget = loadTarget(originalTargetPath, "integration", "money-original-cutover");
  assertLocator();
  const { loadIntegrationStorageOriginalCreateInput } = await import(
    "./integration-storage-generation.ts"
  );
  const { assertMoneyUnitOriginalPost103TargetProfile, loadMoneyUnitOriginalCutoverOptions } =
    await import("./schema-money-unit-owner.ts");
  const options = await loadMoneyUnitOriginalCutoverOptions({
    selectedTarget: moneyTarget,
    declarationPath: convertDeclarationPath,
    originalCreate: loadIntegrationStorageOriginalCreateInput(originalCreatePath),
  });
  assertLocator();
  if (through === 100) {
    const source = await readIntegrationMoneyOriginalPreserved100Source(
      moneyTarget,
      options,
      post94DeclarationPath,
    );
    assertMoneyUnitOriginalPost103TargetProfile(
      options,
      moneyTarget,
      authTarget,
      source.currentWriterEpoch,
    );
    assertLocator();
    return { source, assertLocator };
  }
  const source = await readIntegrationMoneyOriginalPreserved103Precursor(
    moneyTarget,
    options,
    post94DeclarationPath,
    authTarget,
  );
  if (canonicalJson(source.authTarget) !== canonicalJson(authTarget))
    throw preflightError("Auth103 original Money precursor selected another Auth target");
  assertLocator();
  return { source, assertLocator };
}

export function runD1SchemaAuth103(
  invocation: {
    readonly action: "history";
    readonly environment: "integration";
    readonly commit: string;
  },
  target: DeployTarget,
  productionD1: { readonly databaseId: string; readonly databaseName: string },
): Promise<Auth103OriginalHistory>;
export function runD1SchemaAuth103(
  invocation: {
    readonly action: "status" | "apply";
    readonly environment: "integration";
    readonly commit: string;
  },
  target: DeployTarget,
  productionD1: { readonly databaseId: string; readonly databaseName: string },
): Promise<Record<string, unknown>>;
export async function runD1SchemaAuth103(
  invocation: {
    readonly action: "status" | "apply" | "history";
    readonly environment: "integration";
    readonly commit: string;
  },
  target: DeployTarget,
  productionD1: { readonly databaseId: string; readonly databaseName: string },
) {
  if (
    target.environment !== "integration" ||
    target.schemaMaintenanceMode !== MODE ||
    target.auth103NativeProfile !== AUTH103_NATIVE_PROFILE ||
    target.d1.databaseId === productionD1.databaseId ||
    target.d1.databaseName === productionD1.databaseName
  )
    throw preflightError(
      "Auth103 requires the distinct integration target and source-proved whole-Host quiescence",
    );
  const selectedTarget = canonicalJson(target);
  const custodyOwner = readAuth103OriginalCustodyDirectory();
  const custody = custodyOwner.path;
  const custodyStat = finiteOriginalRead(
    () => lstatSync(custody, { bigint: true }),
    "Auth103 original custody directory changed during preparation",
  );
  const assertTarget = () => {
    if (canonicalJson(target) !== selectedTarget)
      throw preflightError("Auth103 target changed during preparation");
    custodyOwner.assertUnchanged();
  };
  const attempt = join(custody, "auth103-dispatched.json");
  if (invocation.action === "apply" && existsSync(attempt))
    throw mutationError("Auth103 dispatch already exists; read status without replay");
  const source = await qualifySource({ environment: "integration", commit: invocation.commit });
  if (source.dirty)
    throw preflightError("Auth103 registration requires unchanged committed source");
  assertTarget();
  // A history rebuild uses disposable scratch and does not alter dispatch custody.
  const root = mkdtempSync(
    join(invocation.action === "history" ? tmpdir() : custody, "auth103-source-"),
  );
  let dispatched = false;
  let leases: Awaited<ReturnType<typeof acquireWranglerVersionPublicationLease>>[] = [];
  try {
    const registered = readAuth103CanonicalMigrationSource(REPOSITORY, root);
    if (invocation.action === "apply") {
      const reviewer = requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW");
      if (reviewer.trim() !== reviewer || reviewer.length > 256 || reviewer.includes("\n"))
        throw preflightError("Auth103 independent review must name one reviewer");
      for (const workerName of [`d1-${target.d1.databaseId}`, target.workerName].sort())
        leases.push(
          await acquireWranglerVersionPublicationLease({ accountId: target.accountId, workerName }),
        );
      assertTarget();
      for (const command of [
        ["bun", "test", "tests/deploy-auth103-native-source.test.ts"],
        ["bun", "run", "check:migrations"],
      ]) {
        const checked = await runCommand(command);
        assertTarget();
        if (checked.exitCode !== 0) throw preflightError("Auth103 scoped source gate failed");
      }
    }
    const artifact =
      invocation.action === "history"
        ? readAuth103RetainedWorkerArtifact({
            custody,
            scratch: root,
            target,
            commit: invocation.commit,
          })
        : await prepareWorkerArtifact({
            root,
            target,
            commit: invocation.commit,
            run: runCommand,
          });
    assertTarget();
    const original = artifact.auth103NativeSource;
    if (original === undefined || artifact.auth103SourceInstallPath === undefined)
      throw preflightError("Auth103 original source/artifact installation contribution is absent");
    const manifestJson = readAuth103NativeBuildDefine(
      original,
      target,
      invocation.commit,
      REPOSITORY,
    );
    const manifest = JSON.parse(manifestJson) as Auth103NativeSourceManifest | null;
    const credential = await resolveCloudflareCredential("integration");
    assertTarget();
    const database = new RemoteD1(artifact.configPath, {
      environment: credential.childEnvironment,
    });
    const initial = await readD1SchemaState(database);
    assertTarget();
    const moneyPreserved = target.moneyCutoverWriterPolicy !== undefined;
    if (
      moneyPreserved &&
      (target.moneyCutoverWriterPolicy !== "transaction-fenced-usd-micros-v1" ||
        !/^sha256:[0-9a-f]{64}$/u.test(target.moneyCutoverWriterEpoch ?? ""))
    )
      throw preflightError("Auth103 Money profile is not the exact fenced writer policy");
    if (moneyPreserved && initial.applied.length !== 100 && initial.applied.length !== 103)
      throw preflightError("Auth103 original Money state is neither exact100 nor exact103");
    const moneyThrough = initial.applied.length === 100 ? 100 : 103;
    const moneySelection = moneyPreserved
      ? await readOriginalMoneySelection(target, moneyThrough)
      : undefined;
    if (moneySelection !== undefined) {
      if (
        (moneyThrough === 100 &&
          moneySelection.source.kind !== "takoserver.money-original-preserved100-source@v1") ||
        (moneyThrough === 103 &&
          moneySelection.source.kind !== "takoserver.money-original-preserved103-precursor@v1") ||
        moneySelection.source.accountId !== target.accountId ||
        moneySelection.source.databaseId !== target.d1.databaseId ||
        moneySelection.source.databaseName !== target.d1.databaseName ||
        moneySelection.source.workerName !== target.workerName ||
        moneySelection.source.currentWriterEpoch !== target.moneyCutoverWriterEpoch ||
        moneySelection.source.schemaShapeDigest !== initial.shapeDigest
      )
        throw preflightError("Auth103 original Money native source differs from selected D1");
    }
    const shapes = moneyPreserved
      ? compileAuth103MoneyPreservedImportShapes(registered.artifact)
      : compileAuth103NativeImportShapes(registered.artifact);
    if (manifest === null || manifest.catalogDigest !== dataDigest(shapes.catalog))
      throw preflightError("Auth103 original source catalog differs from its importer");
    const contribution = composeAuth103NativeImportData({
      artifact: registered.artifact,
      prefixShape: shapes.prefixShape,
      ...(moneySelection === undefined
        ? {}
        : { postShape: shapes.postShape, moneySource: moneySelection.source }),
      catalogJson: JSON.stringify(shapes.catalog),
      registration: [
        manifest.registrationRef,
        manifest.recipeDigest,
        manifest.clockSourceDigest,
        manifest.clockPolicyRef,
      ],
      installSql:
        invocation.action === "history"
          ? readAuth103OriginalRetainedInstallSql(artifact.auth103SourceInstallPath)
          : readFileSync(artifact.auth103SourceInstallPath, "utf8"),
    });
    const importPath = join(artifact.releaseDirectory, "auth103-one-import.sql");
    if (invocation.action === "history") {
      if (
        !finiteOriginalRead(
          () => readFileSync(importPath).equals(Buffer.from(contribution.sql)),
          "Auth103 original import is unavailable",
        )
      )
        throw preflightError("Auth103 original import differs from its source-owned composer");
    } else writeFileSync(importPath, contribution.sql, { flag: "wx", mode: 0o600 });
    const sealed = artifact.seal(["auth103-one-import.sql"]);
    sealed.assertUnchanged();
    registered.assertCurrent();
    if (
      readAuth103NativeBuildDefine(original, target, invocation.commit, REPOSITORY) !== manifestJson
    )
      throw preflightError("Auth103 source manifest changed before import seal");
    moneySelection?.assertLocator();
    const assertMoneyCurrent = async () => {
      if (moneySelection === undefined) return;
      moneySelection.assertLocator();
      const again = await readOriginalMoneySelection(target, moneyThrough);
      if (canonicalJson(again.source) !== canonicalJson(moneySelection.source))
        throw preflightError("Auth103 original Money native source changed during read");
      again.assertLocator();
    };
    const state = new CloudflareState({ accountId: target.accountId, token: credential.token });
    const native = async (phase: DeployPhase) => {
      assertTarget();
      sealed.assertUnchanged();
      readAuth103NativeBuildDefine(original, target, invocation.commit, REPOSITORY);
      const current = await inspectLiveWorkerVersion(phase, target, state, {});
      assertTarget();
      sealed.assertUnchanged();
      const module = exactV2MaintenanceModuleDigest(
        phase,
        await state.workerVersionWithModules(target.workerName, current.history.versionId),
      );
      assertTarget();
      sealed.assertUnchanged();
      if (
        current.commit !== invocation.commit ||
        current.bundleDigestHex !== artifact.bundleDigestHex ||
        module !== artifact.bundleDigestHex
      )
        throw preflightError(
          "Auth103 requires the actual all-traffic source-built quiesced Worker",
        );
      return current;
    };
    const deploymentRef = dataDigest([
      "takoserver.auth103.native-deployment.v1",
      manifest.targetRef,
      manifest.sourceRef,
      `sha256:${artifact.bundleDigestHex}`,
    ]);
    const rpJson = canonicalJson(auth103RpRegistrationRecord(manifest));
    const deploymentJson = canonicalJson({
      receiptRef: dataDigest(["takoserver.auth103.native-deployment-receipt.v1", deploymentRef]),
      manifest,
      artifactDigest: `sha256:${artifact.bundleDigestHex}`,
      rpRecordJson: rpJson,
    });
    const currentness = boundPredicate(
      `(${AUTH103_NATIVE_CURRENT_PREDICATE}) AND (${AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE})`,
      [
        manifest.registrationRef,
        manifest.recipeDigest,
        manifest.clockSourceDigest,
        manifest.clockPolicyRef,
        JSON.stringify(shapes.catalog),
        deploymentRef,
        deploymentJson,
        manifest.rpRegistration.registrationRef,
        manifest.rpRegistration.registrationDigest,
        rpJson,
      ],
    );
    const installed = async (phase: DeployPhase, snapshot: D1SchemaState) => {
      if (
        JSON.stringify(snapshot.applied) !== JSON.stringify(registered.artifact.names) ||
        !applicationSchemaMatches(snapshot, shapes.postShape)
      )
        return false;
      const rows = await database.query(
        phase,
        "Auth103 original installation receipts",
        `SELECT CASE WHEN ${currentness} THEN 1 ELSE 0 END AS current`,
      );
      assertTarget();
      sealed.assertUnchanged();
      return rows.length === 1 && rows[0]?.current === 1;
    };
    moneySelection?.assertLocator();
    const alreadyInstalled = await installed("preflight", initial);
    const before =
      JSON.stringify(initial.applied) === JSON.stringify(registered.prefix.names) &&
      applicationSchemaMatches(initial, shapes.prefixShape);
    if (invocation.action === "history") {
      if (!alreadyInstalled || target.integrationE2eCredentialAuthority !== undefined)
        throw preflightError("Auth103 original installation history is unavailable");
      const originalDispatch = readAuth103OriginalDispatchData({
        custody,
        commit: source.commit,
        targetRef: manifest.targetRef,
        sourceRef: manifest.sourceRef,
        importDigest: contribution.digest,
        importBytes: contribution.bytes,
        bundleDigest: `sha256:${artifact.bundleDigestHex}`,
      });
      const originalInstalled = originalJson(
        join(custody, "auth103-installed.json"),
        4096,
        "pretty",
      );
      exactFields(originalInstalled, [
        "kind",
        "environment",
        "commit",
        "sourceDigest",
        "importDigest",
        "importBytes",
        "appliedCount",
        "targetRef",
        "sourceRef",
        "authSchemaRef",
        "providerAcknowledgement",
        "rollback",
        "nativeRequestQualified",
      ]);
      if (
        originalInstalled.kind !== "takoserver.auth103-source-apply@v1" ||
        originalInstalled.environment !== "integration" ||
        originalInstalled.commit !== source.commit ||
        originalInstalled.sourceDigest !== registered.artifact.digest ||
        originalInstalled.importDigest !== contribution.digest ||
        originalInstalled.importBytes !== contribution.bytes ||
        originalInstalled.appliedCount !== 103 ||
        originalInstalled.targetRef !== manifest.targetRef ||
        originalInstalled.sourceRef !== manifest.sourceRef ||
        originalInstalled.authSchemaRef !== manifest.authSchemaRef ||
        originalInstalled.providerAcknowledgement !== "acknowledged" ||
        originalInstalled.rollback !==
          "forward repair only after dispatch; JS postconditions do not prove rollback" ||
        originalInstalled.nativeRequestQualified !== false
      )
        throw preflightError("Auth103 original installation acknowledgement is unavailable");
      const historyBefore = parseWorkerDeploymentChain(
        await state.workerDeployments(target.workerName),
        "preflight",
        { requireUuidVersionIds: true },
      );
      const match = historyBefore.filter(
        (entry) =>
          entry.deploymentId === originalDispatch.deploymentId &&
          entry.versionId === originalDispatch.versionId,
      );
      if (match.length !== 1)
        throw preflightError("Auth103 original Worker deployment is absent from provider history");
      const historicalVersion = await state.workerVersion(
        target.workerName,
        originalDispatch.versionId,
      );
      if (workerVersionAnnotationProfile(historicalVersion) !== "canonical")
        throw preflightError("Auth103 original Worker Version annotation is unavailable");
      const identity = workerVersionIdentity("preflight", historicalVersion);
      if (
        identity.commit !== source.commit ||
        identity.bundleDigestHex !== artifact.bundleDigestHex
      )
        throw preflightError("Auth103 original Worker Version source identity changed");
      assertExactVersionBindingClosure(
        "preflight",
        originalDispatch.versionId,
        historicalVersion,
        expectedExactBindingClosure(target, {
          workerArtifactDigest: `sha256:${artifact.bundleDigestHex}`,
        }),
      );
      const moduleDigest = exactV2MaintenanceModuleDigest(
        "preflight",
        await state.workerVersionWithModules(target.workerName, originalDispatch.versionId),
      );
      if (moduleDigest !== artifact.bundleDigestHex)
        throw preflightError("Auth103 original Worker module differs from its sealed artifact");
      const historyAfter = parseWorkerDeploymentChain(
        await state.workerDeployments(target.workerName),
        "preflight",
        { requireUuidVersionIds: true },
      );
      if (canonicalJson(historyAfter) !== canonicalJson(historyBefore))
        throw preflightError("Auth103 Worker deployment history changed during historical read");
      assertTarget();
      sealed.assertUnchanged();
      if (!(await installed("preflight", await readD1SchemaState(database))))
        throw preflightError("Auth103 original installation changed during historical read");
      await assertMoneyCurrent();
      registered.assertCurrent();
      const dispatchAfter = readAuth103OriginalDispatchData({
        custody,
        commit: source.commit,
        targetRef: manifest.targetRef,
        sourceRef: manifest.sourceRef,
        importDigest: contribution.digest,
        importBytes: contribution.bytes,
        bundleDigest: `sha256:${artifact.bundleDigestHex}`,
      });
      if (
        dispatchAfter.versionId !== originalDispatch.versionId ||
        dispatchAfter.deploymentId !== originalDispatch.deploymentId ||
        dispatchAfter.releaseDirectory !== originalDispatch.releaseDirectory ||
        canonicalJson(originalJson(join(custody, "auth103-installed.json"), 4096, "pretty")) !==
          canonicalJson(originalInstalled)
      )
        throw preflightError("Auth103 original custody changed during historical read");
      assertTarget();
      sealed.assertUnchanged();
      const result: Auth103OriginalHistory = Object.freeze({
        kind: "takoserver.auth103-original-history@v1",
        environment: "integration",
        commit: source.commit,
        accountId: target.accountId,
        databaseId: target.d1.databaseId,
        databaseName: target.d1.databaseName,
        workerName: target.workerName,
        targetRef: manifest.targetRef,
        sourceRef: manifest.sourceRef,
        authSchemaRef: manifest.authSchemaRef,
        sourceDigest: registered.artifact.digest,
        importDigest: contribution.digest,
        importBytes: contribution.bytes,
        originalBundleDigest: `sha256:${artifact.bundleDigestHex}`,
        originalVersionId: originalDispatch.versionId,
        originalDeploymentId: originalDispatch.deploymentId,
        sourceRegistrationRef: manifest.registrationRef,
        rpRegistrationRef: manifest.rpRegistration.registrationRef,
        deploymentRef,
        deploymentReceiptRef: dataDigest([
          "takoserver.auth103.native-deployment-receipt.v1",
          deploymentRef,
        ]),
        rpReceiptRef: manifest.rpRegistration.receiptRef,
        sourceProfile: moneyPreserved ? "money-preserved" : "ordinary",
      });
      return result;
    }
    if (invocation.action === "status")
      return {
        kind: "takoserver.auth103-source-status@v1",
        environment: "integration",
        commit: source.commit,
        status: alreadyInstalled
          ? "installed-original-source"
          : before
            ? "original100-awaiting-source-install"
            : "foreign-or-indeterminate",
        appliedCount: initial.applied.length,
        sourceDigest: registered.artifact.digest,
        importDigest: contribution.digest,
        dispatchRecorded: existsSync(attempt),
        nativeRequestQualified: false,
      };
    if (!before || alreadyInstalled)
      throw preflightError(
        "Auth103 apply requires exact original100; installed or foreign state is never replayed",
      );
    const serving = await native("preflight");
    const final = await readD1SchemaState(database, "mutation");
    assertTarget();
    sealed.assertUnchanged();
    if (
      final.shapeDigest !== initial.shapeDigest ||
      JSON.stringify(final.applied) !== JSON.stringify(initial.applied)
    )
      throw preflightError("Auth103 predecessor changed before dispatch");
    const finalServing = await native("mutation");
    await assertMoneyCurrent();
    registered.assertCurrent();
    if (
      serving.history.versionId !== finalServing.history.versionId ||
      serving.history.deploymentId !== finalServing.history.deploymentId
    )
      throw preflightError("Auth103 quiesced publication changed before dispatch");
    // Write once BEFORE dispatch. Any uncertain acknowledgement remains GET-only
    // even if the old100 shape is still visible; it never licenses another import.
    const dispatchBytes = Buffer.from(
      `${JSON.stringify({
        kind: "takoserver.auth103-dispatched@v1",
        commit: source.commit,
        targetRef: manifest.targetRef,
        sourceRef: manifest.sourceRef,
        importDigest: contribution.digest,
        importBytes: contribution.bytes,
        bundleDigest: `sha256:${artifact.bundleDigestHex}`,
        versionId: serving.history.versionId,
        deploymentId: serving.history.deploymentId,
        releaseDirectory: artifact.releaseDirectory,
      })}\n`,
    );
    let dispatchFile = -1;
    let dispatchDirectory = -1;
    try {
      // The original marker and its directory entry must both survive a crash
      // before any remote command may be dispatched. Keep even partial records.
      assertTarget();
      dispatchDirectory = openSync(
        custody,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const heldDirectory = fstatSync(dispatchDirectory, { bigint: true });
      if (
        heldDirectory.dev !== custodyStat.dev ||
        heldDirectory.ino !== custodyStat.ino ||
        heldDirectory.mode !== custodyStat.mode
      )
        throw new Error("changed dispatch custody");
      dispatchFile = openSync(
        attempt,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(dispatchFile, 0o600);
      let offset = 0;
      while (offset < dispatchBytes.byteLength) {
        const count = writeSync(
          dispatchFile,
          dispatchBytes,
          offset,
          dispatchBytes.byteLength - offset,
        );
        if (count < 1) throw new Error("short dispatch write");
        offset += count;
      }
      fsyncSync(dispatchFile);
      fsyncSync(dispatchDirectory);
      assertTarget();
    } catch {
      throw mutationError(
        "Auth103 dispatch could not be durably retained; preserve custody and inspect status without replay",
      );
    } finally {
      if (dispatchFile >= 0) closeSync(dispatchFile);
      if (dispatchDirectory >= 0) closeSync(dispatchDirectory);
    }
    dispatched = true;
    const imported = await runCommand(
      wranglerCommand([
        "d1",
        "execute",
        target.d1.databaseName,
        "--remote",
        "--yes",
        "--config",
        artifact.configPath,
        "--file",
        importPath,
      ]),
      { env: credential.childEnvironment },
    );
    assertTarget();
    sealed.assertUnchanged();
    if (imported.exitCode !== 0)
      throw mutationError(
        "Auth103 import acknowledgement is unknown; preserve custody and inspect status without replay",
      );
    const post = await readD1SchemaState(database, "verification");
    assertTarget();
    sealed.assertUnchanged();
    if (!(await installed("verification", post)))
      throw verificationError(
        "Auth103 import was acknowledged but source/receipt postconditions are unproved; repair forward",
      );
    await native("verification");
    const result = {
      kind: "takoserver.auth103-source-apply@v1",
      environment: "integration",
      commit: source.commit,
      sourceDigest: registered.artifact.digest,
      importDigest: contribution.digest,
      importBytes: contribution.bytes,
      appliedCount: post.applied.length,
      targetRef: manifest.targetRef,
      sourceRef: manifest.sourceRef,
      authSchemaRef: manifest.authSchemaRef,
      providerAcknowledgement: "acknowledged",
      rollback: "forward repair only after dispatch; JS postconditions do not prove rollback",
      nativeRequestQualified: false,
    };
    writeFileSync(join(custody, "auth103-installed.json"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return result;
  } catch (error) {
    if (dispatched) {
      if (
        error instanceof Error &&
        "phase" in error &&
        (error.phase === "mutation" || error.phase === "verification")
      )
        throw error;
      throw mutationError(
        "Auth103 may have changed after dispatch; preserve custody and inspect status without replay",
      );
    }
    throw error;
  } finally {
    // Retain sealed source/import on every outcome; never auto-restore DB or
    // release its source seal merely because a JavaScript postcondition failed.
    for (const lease of leases.reverse()) await lease.release();
    leases = [];
    if (invocation.action === "history") rmSync(root, { recursive: true, force: true });
  }
}

/** Read-only native owner history. Consumers receive verified DATA, never an
 * import selector, repair permission or current request authority. */
export async function readD1SchemaAuth103OriginalHistory(
  invocation: { readonly commit: string },
  target: DeployTarget,
  productionD1: { readonly databaseId: string; readonly databaseName: string },
): Promise<Auth103OriginalHistory> {
  const result = await runD1SchemaAuth103(
    { action: "history", environment: "integration", commit: invocation.commit },
    target,
    productionD1,
  );
  if (result.kind !== "takoserver.auth103-original-history@v1")
    throw preflightError("Auth103 original history is unavailable");
  return result;
}
