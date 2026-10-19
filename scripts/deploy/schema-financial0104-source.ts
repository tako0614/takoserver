import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  AUTH103_NATIVE_CURRENT_PREDICATE,
  AUTH103_NATIVE_MIGRATIONS,
} from "../../src/auth103-native-source-contract.ts";
import { canonicalJson } from "../../src/json.ts";
import { MONEY_CUTOVER_EPOCH } from "../../src/money-cutover-sql.ts";
import { applicationSchemaMatches } from "./application-schema-shape.ts";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { buildD1MigrationImport, type D1MigrationImportArtifact } from "./d1-migration-import.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { readFinancial0104CanonicalMigrationSource } from "./financial0104-canonical-source.ts";
import { FINANCIAL0104_MIGRATION_NAME, financial0104RootRecipe } from "./financial0104-recipe.ts";
import {
  compileFinancial0104ImportShapes,
  type Financial0104Profile,
  financial0104CatalogPredicate,
} from "./financial0104-schema-shape.ts";
import { type D1SchemaState, type MigrationArtifact, readD1SchemaState } from "./migrations.ts";
import {
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { qualifySource } from "./qualification.ts";
import {
  boundPredicate,
  ledgerPredicate,
  originalShapePredicate,
  readAuth103OriginalCustodyDirectory,
} from "./schema-auth103-native-source.ts";
import type { DeployTarget } from "./target.ts";
import { acquireWranglerVersionPublicationLease } from "./wrangler-state.ts";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ROLLBACK = "forward repair only after dispatch; JS postconditions do not prove rollback";

/** A Money-preserved target admits 0104 only AFTER its post103 thaw: Money's
 * own release guard is pinned to the exact 103 ledger, so 104 never runs while
 * the original freeze row, a stray permit or another epoch remains. */
export function financial0104MoneyThawedPredicate(writerEpoch: string): string {
  if (!SHA256.test(writerEpoch))
    throw preflightError("Financial0104 Money profile requires the exact writer epoch");
  return `NOT EXISTS (SELECT 1 FROM main.money_cutover_freeze)
    AND (SELECT count(*) FROM main.money_cutover_authorized_epoch)=1
    AND EXISTS (SELECT 1 FROM main.money_cutover_authorized_epoch WHERE singleton=1
      AND writer_epoch=${sqlLiteral(writerEpoch)})
    AND NOT EXISTS (SELECT 1 FROM main.money_cutover_writer_permit)
    AND (SELECT count(*) FROM main.money_unit_policy)=1
    AND EXISTS (SELECT 1 FROM main.money_unit_policy WHERE singleton=1
      AND ledger_unit=${sqlLiteral(MONEY_CUTOVER_EPOCH)}
      AND historical_usage_unit='microcent-v1' AND cash_unit='usd-cents-v1')`;
}

export interface Financial0104ImportInput {
  readonly artifact: MigrationArtifact;
  readonly prefixShape: string;
  readonly postShape: string;
  readonly auth103CatalogJson: string;
  readonly registration: readonly [string, string, string, string];
  readonly moneyWriterEpoch?: string;
}

/** Exact first/final guards around the unchanged ledger import of ONE 0104. */
export function financial0104ImportPredicates(input: Financial0104ImportInput) {
  const recipe = financial0104RootRecipe();
  const file = input.artifact.files[103];
  if (
    input.artifact.files.length !== 104 ||
    file === undefined ||
    JSON.stringify(input.artifact.names.slice(100)) !==
      JSON.stringify([...AUTH103_NATIVE_MIGRATIONS, FINANCIAL0104_MIGRATION_NAME]) ||
    file.digest !== recipe.digest ||
    readFileSync(file.path, "utf8") !== recipe.sql
  )
    throw preflightError("Financial0104 import requires the exact Auth103 artifact plus 0104");
  const auth103 = boundPredicate(AUTH103_NATIVE_CURRENT_PREDICATE, [
    ...input.registration,
    input.auth103CatalogJson,
  ]);
  const money =
    input.moneyWriterEpoch === undefined
      ? ""
      : ` AND (${financial0104MoneyThawedPredicate(input.moneyWriterEpoch)})`;
  return Object.freeze({
    before: `${ledgerPredicate(input.artifact.names.slice(0, 103))} AND ${auth103} AND ${originalShapePredicate(input.prefixShape)}${money}`,
    after: `${ledgerPredicate(input.artifact.names)} AND ${auth103} AND ${originalShapePredicate(input.postShape)} AND ${financial0104CatalogPredicate()}${money}`,
  });
}

/** SQL DATA composer only. The unchanged ledger importer is the only migration
 * composer; the false branch of each guard raises a real SQL error. */
export function composeFinancial0104ImportData(
  input: Financial0104ImportInput,
): D1MigrationImportArtifact {
  const { before, after } = financial0104ImportPredicates(input);
  const migration = buildD1MigrationImport(input.artifact.files.slice(103), { freshLedger: false });
  const guard = (predicate: string) =>
    `SELECT json(CASE WHEN (${predicate}) IS 1 THEN '{}' ELSE '!' END);\n`;
  const sql = `${guard(before)}${migration.sql}\n${guard(after)}`;
  return Object.freeze({
    sql,
    digest: `sha256:${createHash("sha256").update(sql).digest("hex")}`,
    bytes: Buffer.byteLength(sql),
  });
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
    { mode: 0o600, flag: "wx" },
  );
  return path;
}

/**
 * Separate integration-only Root registration of Financial0104 after the
 * unchanged Auth103 installation. One guarded import: exact103 ledger, current
 * Auth103 registration/catalog and exact post103 shape (thawed Money when that
 * profile applies) -> unchanged 0104 + ledger insert -> exact104 ledger, exact
 * post104 shape and Financial catalog. Dispatch is recorded once; replay never.
 */
export async function runD1SchemaFinancial0104(
  invocation: {
    readonly action: "status" | "apply";
    readonly environment: "integration";
    readonly commit: string;
  },
  target: DeployTarget,
  productionD1: { readonly databaseId: string; readonly databaseName: string },
): Promise<Record<string, unknown>> {
  if (
    invocation.environment !== "integration" ||
    target.environment !== "integration" ||
    target.artifactBlobIoMode !== undefined ||
    target.d1.databaseId === productionD1.databaseId ||
    target.d1.databaseName === productionD1.databaseName
  )
    throw preflightError("Financial0104 requires the distinct integration target");
  const moneyPreserved = target.moneyCutoverWriterPolicy !== undefined;
  if (
    moneyPreserved &&
    (target.moneyCutoverWriterPolicy !== "transaction-fenced-usd-micros-v1" ||
      !SHA256.test(target.moneyCutoverWriterEpoch ?? ""))
  )
    throw preflightError("Financial0104 Money profile is not the exact fenced writer policy");
  const profile: Financial0104Profile = moneyPreserved ? "money-preserved" : "ordinary";
  const selectedTarget = canonicalJson(target);
  const custodyOwner = readAuth103OriginalCustodyDirectory();
  const custody = custodyOwner.path;
  const custodyStat = lstatSync(custody, { bigint: true });
  const assertTarget = () => {
    if (canonicalJson(target) !== selectedTarget)
      throw preflightError("Financial0104 target changed during preparation");
    custodyOwner.assertUnchanged();
  };
  const attempt = join(custody, "financial0104-dispatched.json");
  const receipt = join(custody, "financial0104-installed.json");
  if (invocation.action === "apply" && existsSync(attempt))
    throw mutationError("Financial0104 dispatch already exists; read status without replay");
  const source = await qualifySource({ environment: "integration", commit: invocation.commit });
  if (source.dirty)
    throw preflightError("Financial0104 registration requires unchanged committed source");
  assertTarget();
  const root = mkdtempSync(join(custody, "financial0104-source-"));
  let dispatched = false;
  let leases: Awaited<ReturnType<typeof acquireWranglerVersionPublicationLease>>[] = [];
  try {
    const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, root);
    if (invocation.action === "apply") {
      const reviewer = requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW");
      if (reviewer.trim() !== reviewer || reviewer.length > 256 || reviewer.includes("\n"))
        throw preflightError("Financial0104 independent review must name one reviewer");
      leases.push(
        await acquireWranglerVersionPublicationLease({
          accountId: target.accountId,
          workerName: `d1-${target.d1.databaseId}`,
        }),
      );
      assertTarget();
      for (const command of [
        ["bun", "test", "tests/deploy-financial0104-canonical-source.test.ts"],
        ["bun", "run", "check:migrations"],
      ]) {
        const checked = await runCommand(command);
        assertTarget();
        if (checked.exitCode !== 0) throw preflightError("Financial0104 scoped source gate failed");
      }
    }
    const shapes = compileFinancial0104ImportShapes(
      registered.auth103,
      registered.artifact,
      profile,
    );
    const recipes = registered.auth103Recipes;
    const input: Financial0104ImportInput = {
      artifact: registered.artifact,
      prefixShape: shapes.prefixShape,
      postShape: shapes.postShape,
      auth103CatalogJson: JSON.stringify(shapes.auth103Catalog),
      registration: [
        recipes.registrationRef,
        recipes.recipeDigest,
        recipes.clockSourceDigest,
        recipes.clockPolicyRef,
      ],
      ...(moneyPreserved ? { moneyWriterEpoch: target.moneyCutoverWriterEpoch as string } : {}),
    };
    const predicates = financial0104ImportPredicates(input);
    const contribution = composeFinancial0104ImportData(input);
    const release = join(root, "release");
    mkdirSync(release, { mode: 0o700 });
    const configPath = writeD1Config(
      join(release, "wrangler.jsonc"),
      target,
      join(root, "migrations-unused"),
    );
    const importPath = join(release, "financial0104-one-import.sql");
    writeFileSync(importPath, contribution.sql, { flag: "wx", mode: 0o600 });
    const assertSealed = () => {
      if (!readFileSync(importPath).equals(Buffer.from(contribution.sql)))
        throw preflightError("Financial0104 sealed import changed");
    };
    const credential = await resolveCloudflareCredential("integration");
    assertTarget();
    const database = new RemoteD1(configPath, { environment: credential.childEnvironment });
    const holds = async (phase: DeployPhase, predicate: string) => {
      const rows = await database.query(
        phase,
        "Financial0104 exact guard",
        `SELECT CASE WHEN (${predicate}) IS 1 THEN 1 ELSE 0 END AS current`,
      );
      assertTarget();
      assertSealed();
      return rows.length === 1 && rows[0]?.current === 1;
    };
    const ready = async (phase: DeployPhase, snapshot: D1SchemaState) =>
      JSON.stringify(snapshot.applied) === JSON.stringify(registered.auth103.names) &&
      applicationSchemaMatches(snapshot, shapes.prefixShape) &&
      (await holds(phase, predicates.before));
    const installed = async (phase: DeployPhase, snapshot: D1SchemaState) =>
      JSON.stringify(snapshot.applied) === JSON.stringify(registered.artifact.names) &&
      applicationSchemaMatches(snapshot, shapes.postShape) &&
      (await holds(phase, predicates.after));
    const initial = await readD1SchemaState(database);
    assertTarget();
    const alreadyInstalled = await installed("preflight", initial);
    const before = !alreadyInstalled && (await ready("preflight", initial));
    if (invocation.action === "status")
      return {
        kind: "takoserver.financial0104-source-status@v1",
        environment: "integration",
        commit: source.commit,
        sourceProfile: profile,
        status: alreadyInstalled
          ? "installed-financial0104"
          : before
            ? "auth103-awaiting-financial0104"
            : "foreign-frozen-or-indeterminate",
        appliedCount: initial.applied.length,
        auth103SourceDigest: registered.auth103.digest,
        sourceDigest: registered.artifact.digest,
        recipeDigest: registered.recipe.digest,
        importDigest: contribution.digest,
        dispatchRecorded: existsSync(attempt),
        nativeRequestQualified: false,
      };
    if (!before || alreadyInstalled)
      throw preflightError(
        "Financial0104 apply requires exact installed Auth103 (thawed when Money-preserved); installed or foreign state is never replayed",
      );
    const final = await readD1SchemaState(database, "mutation");
    assertTarget();
    if (
      final.shapeDigest !== initial.shapeDigest ||
      JSON.stringify(final.applied) !== JSON.stringify(initial.applied) ||
      !(await holds("mutation", predicates.before))
    )
      throw preflightError("Financial0104 predecessor changed before dispatch");
    registered.assertCurrent();
    assertSealed();
    const dispatchBytes = Buffer.from(
      `${JSON.stringify({
        kind: "takoserver.financial0104-dispatched@v1",
        commit: source.commit,
        sourceProfile: profile,
        sourceDigest: registered.artifact.digest,
        recipeDigest: registered.recipe.digest,
        importDigest: contribution.digest,
        importBytes: contribution.bytes,
        releaseDirectory: release,
      })}\n`,
    );
    let dispatchFile = -1;
    let dispatchDirectory = -1;
    try {
      assertTarget();
      dispatchDirectory = openSync(
        custody,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const held = fstatSync(dispatchDirectory, { bigint: true });
      if (
        held.dev !== custodyStat.dev ||
        held.ino !== custodyStat.ino ||
        held.mode !== custodyStat.mode
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
        "Financial0104 dispatch could not be durably retained; preserve custody and inspect status without replay",
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
        configPath,
        "--file",
        importPath,
      ]),
      { env: credential.childEnvironment },
    );
    assertTarget();
    assertSealed();
    if (imported.exitCode !== 0)
      throw mutationError(
        "Financial0104 import acknowledgement is unknown; preserve custody and inspect status without replay",
      );
    const post = await readD1SchemaState(database, "verification");
    assertTarget();
    if (!(await installed("verification", post)))
      throw verificationError(
        "Financial0104 import was acknowledged but exact104 postconditions are unproved; repair forward",
      );
    const result = {
      kind: "takoserver.financial0104-source-apply@v1",
      environment: "integration",
      commit: source.commit,
      sourceProfile: profile,
      auth103SourceDigest: registered.auth103.digest,
      sourceDigest: registered.artifact.digest,
      recipeDigest: registered.recipe.digest,
      importDigest: contribution.digest,
      importBytes: contribution.bytes,
      appliedCount: post.applied.length,
      providerAcknowledgement: "acknowledged",
      rollback: ROLLBACK,
      nativeRequestQualified: false,
    };
    writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
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
        "Financial0104 may have changed after dispatch; preserve custody and inspect status without replay",
      );
    }
    throw error;
  } finally {
    // Retain sealed source/import on every outcome; no automatic restore.
    for (const lease of leases.reverse()) await lease.release();
    leases = [];
  }
}
