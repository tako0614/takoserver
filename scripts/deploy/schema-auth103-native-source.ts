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
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";
import { applicationSchemaMatches } from "./application-schema-shape.ts";
import {
  createAuth103CanonicalSourceArtifacts,
  readAuth103NativeBuildDefine,
} from "./auth103-native-source.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { buildD1MigrationImport, type D1MigrationImportArtifact } from "./d1-migration-import.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  canonicalSchemaShape,
  type D1SchemaState,
  type MigrationArtifact,
  readD1SchemaState,
  readMigrationArtifact,
} from "./migrations.ts";
import {
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { qualifySource } from "./qualification.ts";
import { readAuditedMigrationSourcePrefix100 } from "./schema.ts";
import { exactV2MaintenanceModuleDigest } from "./schema-v2-existing-transition.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { inspectLiveWorkerVersion } from "./worker-live.ts";
import { acquireWranglerVersionPublicationLease } from "./wrangler-state.ts";

const MODE = "pre-auth103-quiesced";
const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const dataDigest = (value: unknown) => digest(canonicalJson(value));
const failure = "Auth103 source registration inspection is unavailable";

/** Audit the original100 and compare every successor with the actual owner
 * recipes. No caller-supplied hash, SQL, projection or registration is trusted. */
function registeredSource(sourceRoot: string) {
  const directory = resolve(sourceRoot, "migrations");
  const prefix = readAuditedMigrationSourcePrefix100(directory);
  const artifact = readMigrationArtifact(directory);
  if (
    artifact.files.length !== 103 ||
    JSON.stringify(artifact.names.slice(100)) !== JSON.stringify(AUTH103_NATIVE_MIGRATIONS)
  )
    throw preflightError(
      "Auth103 source requires exactly audited100 plus the fixed101/102/103 recipes",
    );
  const recipes = createAuth103CanonicalSourceArtifacts(sourceRoot);
  for (const [index, file] of artifact.files.slice(100).entries()) {
    const expected = recipes.files[index];
    if (
      expected === undefined ||
      file.name !== expected.name ||
      file.digest !== digest(expected.sql) ||
      readFileSync(file.path, "utf8") !== expected.sql
    )
      throw preflightError("Auth103 source differs from the original owner recipes");
  }
  return { prefix, artifact, recipes };
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
): boolean {
  try {
    if (input.shape === undefined || input.shapeDigest === undefined) return false;
    const source = registeredSource(sourceRoot);
    if (JSON.stringify(input.local) !== JSON.stringify(source.artifact.names)) return false;
    const count = input.applied.length;
    if (
      (count !== 100 && count !== 103) ||
      (mode === "normal" && count !== 103) ||
      input.applied.some((name, index) => name !== source.artifact.names[index])
    )
      return false;
    const expected = compileAuth103NativeImportShapes(source.artifact);
    return applicationSchemaMatches(
      { applied: input.applied, shape: input.shape, shapeDigest: input.shapeDigest },
      count === 100 ? expected.prefixShape : expected.postShape,
    );
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

/** SQL DATA composer, not source enrollment authority. The actual route below
 * obtains all inputs from the audited source and ORIGINAL artifact constructor.
 * The unchanged ledger importer remains the only migration-file composer. */
export function composeAuth103NativeImportData(input: {
  readonly artifact: MigrationArtifact;
  readonly prefixShape: string;
  readonly catalogJson: string;
  readonly registration: readonly [string, string, string, string];
  readonly installSql: string;
}): D1MigrationImportArtifact {
  if (
    input.artifact.files.length !== 103 ||
    JSON.stringify(input.artifact.names.slice(100)) !== JSON.stringify(AUTH103_NATIVE_MIGRATIONS)
  )
    throw preflightError("Auth103 import requires the fixed three successors");
  const install = frameHostMigrationSql(input.installSql);
  if (
    install.length !== 4 ||
    !/^INSERT INTO auth103_native_deployment_receipts\(/u.test(install[3]?.trim() ?? "")
  )
    throw preflightError("Auth103 import requires its mandatory final deployment receipt");
  const migrations = buildD1MigrationImport(input.artifact.files.slice(100), {
    freshLedger: false,
  });
  const before = `${ledgerPredicate(input.artifact.names.slice(0, 100))} AND ${originalShapePredicate(input.prefixShape)}`;
  const after = `${ledgerPredicate(input.artifact.names)} AND ${boundPredicate(
    AUTH103_NATIVE_CURRENT_PREDICATE,
    [...input.registration, input.catalogJson],
  )}`;
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
    realpathSync(requested) !== requested
  )
    throw preflightError("Auth103 custody requires its original absolute physical directory");
  const stat = lstatSync(requested);
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

export async function runD1SchemaAuth103(
  invocation: {
    readonly action: "status" | "apply";
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
  const custody = custodyDirectory();
  const custodyStat = lstatSync(custody, { bigint: true });
  const assertTarget = () => {
    if (canonicalJson(target) !== selectedTarget)
      throw preflightError("Auth103 target changed during preparation");
    const current = lstatSync(custody, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== custodyStat.dev ||
      current.ino !== custodyStat.ino ||
      current.mode !== custodyStat.mode ||
      realpathSync(custody) !== custody
    )
      throw preflightError("Auth103 original custody directory changed during preparation");
  };
  const attempt = join(custody, "auth103-dispatched.json");
  if (invocation.action === "apply" && existsSync(attempt))
    throw mutationError("Auth103 dispatch already exists; read status without replay");
  const source = await qualifySource({ environment: "integration", commit: invocation.commit });
  if (source.dirty)
    throw preflightError("Auth103 registration requires unchanged committed source");
  assertTarget();
  const registered = registeredSource(REPOSITORY);
  const shapes = compileAuth103NativeImportShapes(registered.artifact);
  const root = mkdtempSync(join(custody, "auth103-source-"));
  let dispatched = false;
  let leases: Awaited<ReturnType<typeof acquireWranglerVersionPublicationLease>>[] = [];
  try {
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
    const artifact = await prepareWorkerArtifact({
      root,
      target,
      commit: invocation.commit,
      run: runCommand,
    });
    assertTarget();
    const original = artifact.auth103NativeSource;
    if (original === undefined || artifact.auth103SourceInstallPath === undefined)
      throw preflightError("Auth103 original source/artifact installation contribution is absent");
    const manifest = JSON.parse(
      readAuth103NativeBuildDefine(original, target, invocation.commit, REPOSITORY),
    ) as Auth103NativeSourceManifest | null;
    if (manifest === null || manifest.catalogDigest !== dataDigest(shapes.catalog))
      throw preflightError("Auth103 original source catalog differs from its importer");
    const contribution = composeAuth103NativeImportData({
      artifact: registered.artifact,
      prefixShape: shapes.prefixShape,
      catalogJson: JSON.stringify(shapes.catalog),
      registration: [
        manifest.registrationRef,
        manifest.recipeDigest,
        manifest.clockSourceDigest,
        manifest.clockPolicyRef,
      ],
      installSql: readFileSync(artifact.auth103SourceInstallPath, "utf8"),
    });
    const importPath = join(artifact.releaseDirectory, "auth103-one-import.sql");
    writeFileSync(importPath, contribution.sql, { flag: "wx", mode: 0o600 });
    const sealed = artifact.seal(["auth103-one-import.sql"]);
    sealed.assertUnchanged();
    const credential = await resolveCloudflareCredential("integration");
    assertTarget();
    sealed.assertUnchanged();
    const database = new RemoteD1(artifact.configPath, {
      environment: credential.childEnvironment,
    });
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
    const initial = await readD1SchemaState(database);
    assertTarget();
    sealed.assertUnchanged();
    const alreadyInstalled = await installed("preflight", initial);
    const before =
      JSON.stringify(initial.applied) === JSON.stringify(registered.prefix.names) &&
      applicationSchemaMatches(initial, shapes.prefixShape);
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
  }
}
