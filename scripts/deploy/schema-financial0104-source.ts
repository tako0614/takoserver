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
  compileRoot0105ImportShapes,
  compileRoot0106ImportShapes,
  compileRoot0107ImportShapes,
  compileRoot0108ImportShapes,
  type Financial0104Profile,
  financial0104CatalogPredicate,
  moneyStripeCustomerGuardInstallSql,
  root0105CatalogPredicate,
  root0106CatalogPredicate,
  root0106PredecessorPredicate,
  root0107PhysicalPredicate,
  root0107PredecessorPredicate,
  root0108PhysicalPredicate,
  root0108PredecessorPredicate,
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
import { ROOT0105_MIGRATION_NAME, root0105Recipe } from "./root0105-recipe.ts";
import { ROOT0106_MIGRATION_NAME, root0106Recipe } from "./root0106-recipe.ts";
import { ROOT0107_MIGRATION_NAME, root0107Recipe } from "./root0107-recipe.ts";
import { ROOT0108_MIGRATION_NAME, root0108Recipe } from "./root0108-recipe.ts";
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

/** A Money-preserved target admits 0104 and successors only AFTER its post103
 * thaw: Money's own release guard is pinned to the exact 103 ledger, so the
 * chain never runs while the original freeze row, a stray permit or another
 * epoch remains. */
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
  /** The exact target chain artifact through 0104–0108. */
  readonly artifact: MigrationArtifact;
  readonly prefixShape: string;
  readonly postShape: string;
  readonly auth103CatalogJson: string;
  readonly predecessorAuth103CatalogJson?: string;
  readonly registration: readonly [string, string, string, string];
  readonly moneyWriterEpoch?: string;
}

/** Exact first/final guards around the unchanged ledger import of ONE chain
 * step: exact103 -> 0104 through exact106 -> 0107. Each after-state is exact;
 * 0106 and 0107 check their physical predecessor/successor as well. */
export function financial0104ImportPredicates(input: Financial0104ImportInput) {
  const recipe = financial0104RootRecipe();
  const count = input.artifact.files.length;
  const file104 = input.artifact.files[103];
  const file105 = input.artifact.files[104];
  const file106 = input.artifact.files[105];
  const file107 = input.artifact.files[106];
  const file108 = input.artifact.files[107];
  const expectedNames = [
    ...AUTH103_NATIVE_MIGRATIONS,
    FINANCIAL0104_MIGRATION_NAME,
    ...(count >= 105 ? [ROOT0105_MIGRATION_NAME] : []),
    ...(count >= 106 ? [ROOT0106_MIGRATION_NAME] : []),
    ...(count >= 107 ? [ROOT0107_MIGRATION_NAME] : []),
    ...(count === 108 ? [ROOT0108_MIGRATION_NAME] : []),
  ];
  if (
    (count !== 104 && count !== 105 && count !== 106 && count !== 107 && count !== 108) ||
    file104 === undefined ||
    JSON.stringify(input.artifact.names.slice(100)) !== JSON.stringify(expectedNames) ||
    file104.digest !== recipe.digest ||
    readFileSync(file104.path, "utf8") !== recipe.sql ||
    (count >= 105 &&
      (file105 === undefined ||
        file105.digest !== root0105Recipe().digest ||
        readFileSync(file105.path, "utf8") !== root0105Recipe().sql)) ||
    (count >= 106 &&
      (file106 === undefined ||
        file106.digest !== root0106Recipe().digest ||
        readFileSync(file106.path, "utf8") !== root0106Recipe().sql)) ||
    (count >= 107 &&
      (file107 === undefined ||
        file107.digest !== root0107Recipe().digest ||
        readFileSync(file107.path, "utf8") !== root0107Recipe().sql)) ||
    (count === 108 &&
      (file108 === undefined ||
        file108.digest !== root0108Recipe().digest ||
        readFileSync(file108.path, "utf8") !== root0108Recipe().sql))
  )
    throw preflightError(
      count === 108
        ? "Root0108 import requires the exact Auth103 artifact plus0104 through0108"
        : count === 107
          ? "Root0107 import requires the exact Auth103 artifact plus 0104 through 0107"
          : count === 106
            ? "Root0106 import requires the exact Auth103 artifact plus 0104, 0105 and 0106"
            : count === 105
              ? "Root0105 import requires the exact Auth103 artifact plus 0104 and 0105"
              : "Financial0104 import requires the exact Auth103 artifact plus 0104",
    );
  if (count === 106 && input.predecessorAuth103CatalogJson === undefined)
    throw preflightError("Root0106 requires the exact predecessor Auth103 catalog");
  const auth103After = boundPredicate(AUTH103_NATIVE_CURRENT_PREDICATE, [
    ...input.registration,
    input.auth103CatalogJson,
  ]);
  const auth103Before =
    count === 106
      ? boundPredicate(AUTH103_NATIVE_CURRENT_PREDICATE, [
          ...input.registration,
          input.predecessorAuth103CatalogJson as string,
        ])
      : auth103After;
  const profile: Financial0104Profile =
    input.moneyWriterEpoch === undefined ? "ordinary" : "money-preserved";
  const money =
    input.moneyWriterEpoch === undefined
      ? ""
      : ` AND (${financial0104MoneyThawedPredicate(input.moneyWriterEpoch)})`;
  const financial = ` AND ${financial0104CatalogPredicate(profile)}`;
  const root105 = ` AND ${root0105CatalogPredicate()}`;
  const root106 = ` AND (${root0106CatalogPredicate()})`;
  return Object.freeze({
    before: `${ledgerPredicate(input.artifact.names.slice(0, count - 1))} AND ${auth103Before} AND ${originalShapePredicate(input.prefixShape)}${count >= 105 ? financial : ""}${count === 106 ? `${root105} AND (${root0106PredecessorPredicate()})` : ""}${count === 107 ? `${root105}${root106} AND (${root0107PredecessorPredicate()})` : ""}${count === 108 ? `${root105}${root106} AND (${root0107PhysicalPredicate()}) AND (${root0108PredecessorPredicate()})` : ""}${money}`,
    after: `${ledgerPredicate(input.artifact.names)} AND ${auth103After} AND ${originalShapePredicate(input.postShape)}${financial}${count >= 105 ? root105 : ""}${count >= 106 ? root106 : ""}${count >= 107 ? ` AND (${root0107PhysicalPredicate()})` : ""}${count === 108 ? ` AND (${root0108PhysicalPredicate()})` : ""}${money}`,
  });
}

/** SQL DATA composer only. The unchanged ledger importer is the only migration
 * composer; the false branch of each guard raises a real SQL error. On a
 * Money-preserved 0104 step the Money guard's Stripe customer generation is
 * installed in the same import, after 0104 creates its link table. */
export function composeFinancial0104ImportData(
  input: Financial0104ImportInput,
): D1MigrationImportArtifact {
  const { before, after } = financial0104ImportPredicates(input);
  const count = input.artifact.files.length;
  const migration = buildD1MigrationImport(input.artifact.files.slice(count - 1), {
    freshLedger: false,
  });
  const stripe =
    count === 104 && input.moneyWriterEpoch !== undefined
      ? `${moneyStripeCustomerGuardInstallSql()}\n`
      : "";
  const guard = (predicate: string) =>
    `SELECT json(CASE WHEN (${predicate}) IS 1 THEN '{}' ELSE '!' END);\n`;
  const sql = `${guard(before)}${migration.sql}\n${stripe}${guard(after)}`;
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
 * Separate integration-only Root post-Auth103 chain, one step per invocation.
 * 0104: exact103 ledger, current Auth103 registration/catalog and exact post103
 * shape (thawed Money when that profile applies) -> unchanged 0104 + ledger
 * insert (+ the Money guard's Stripe customer generation when Money-preserved)
 * -> exact104 ledger, exact post104 shape and Financial catalog.
 * 0105: that exact104 state -> unchanged Root 0105 + ledger insert -> exact105
 * ledger, exact post105 shape, Financial catalog and Root 0105 objects.
 * 0106: that exact105 state -> pinned Forward native recipe + ledger insert ->
 * exact106 ledger, post106 shape and native catalog.
 * 0107: exact106 -> pinned shared staging physical source + ledger insert ->
 * exact107 ledger, retained old-writer fences and post107 shape.
 * 0108: exact107 -> additive predecessor-origin metadata/non-reuse schema only;
 * no original import, drain, route transition or custody grant.
 * Each step's dispatch is recorded once; replay never.
 */
export async function runD1SchemaFinancial0104(
  invocation: {
    readonly action: "status" | "apply";
    readonly environment: "integration";
    readonly commit: string;
    readonly throughMigration?: "0104" | "0105" | "0106" | "0107" | "0108";
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
  const step = invocation.throughMigration ?? "0104";
  if (step !== "0104" && step !== "0105" && step !== "0106" && step !== "0107" && step !== "0108")
    throw preflightError("post-Auth103 chain step is not registered");
  const label =
    step === "0104"
      ? "financial0104"
      : step === "0105"
        ? "root0105"
        : step === "0106"
          ? "root0106"
          : step === "0107"
            ? "root0107"
            : "root0108";
  const selectedTarget = canonicalJson(target);
  const custodyOwner = readAuth103OriginalCustodyDirectory();
  const custody = custodyOwner.path;
  const custodyStat = lstatSync(custody, { bigint: true });
  const assertTarget = () => {
    if (canonicalJson(target) !== selectedTarget)
      throw preflightError("Financial0104 target changed during preparation");
    custodyOwner.assertUnchanged();
  };
  const attempt = join(custody, `${label}-dispatched.json`);
  const receipt = join(custody, `${label}-installed.json`);
  if (invocation.action === "apply" && existsSync(attempt))
    throw mutationError(`${label} dispatch already exists; read status without replay`);
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
        [
          "bun",
          "test",
          "tests/deploy-financial0104-canonical-source.test.ts",
          "tests/deploy-root0105-canonical-source.test.ts",
          "tests/deploy-root0106-canonical-source.test.ts",
          "tests/deploy-root0107-canonical-source.test.ts",
          ...(step === "0108" ? ["tests/deploy-root0108-canonical-source.test.ts"] : []),
        ],
        ["bun", "run", "check:migrations"],
      ]) {
        const checked = await runCommand(command);
        assertTarget();
        if (checked.exitCode !== 0) throw preflightError("Financial0104 scoped source gate failed");
      }
    }
    const shapes =
      step === "0104"
        ? compileFinancial0104ImportShapes(registered.auth103, registered.artifact, profile)
        : step === "0105"
          ? compileRoot0105ImportShapes(
              registered.auth103,
              registered.artifact,
              registered.artifact105,
              profile,
            )
          : step === "0106"
            ? compileRoot0106ImportShapes(
                registered.auth103,
                registered.artifact,
                registered.artifact105,
                registered.artifact106,
                profile,
              )
            : step === "0107"
              ? compileRoot0107ImportShapes(
                  registered.auth103,
                  registered.artifact,
                  registered.artifact105,
                  registered.artifact106,
                  registered.artifact107,
                  profile,
                )
              : compileRoot0108ImportShapes(
                  registered.auth103,
                  registered.artifact,
                  registered.artifact105,
                  registered.artifact106,
                  registered.artifact107,
                  registered.artifact108,
                  profile,
                );
    const targetArtifact =
      step === "0104"
        ? registered.artifact
        : step === "0105"
          ? registered.artifact105
          : step === "0106"
            ? registered.artifact106
            : step === "0107"
              ? registered.artifact107
              : registered.artifact108;
    const predecessorNames =
      step === "0104"
        ? registered.auth103.names
        : step === "0105"
          ? registered.artifact.names
          : step === "0106"
            ? registered.artifact105.names
            : step === "0107"
              ? registered.artifact106.names
              : registered.artifact107.names;
    const stepRecipe =
      step === "0104"
        ? registered.recipe
        : step === "0105"
          ? registered.recipe105
          : step === "0106"
            ? registered.recipe106
            : step === "0107"
              ? registered.recipe107
              : registered.recipe108;
    const recipes = registered.auth103Recipes;
    const input: Financial0104ImportInput = {
      artifact: targetArtifact,
      prefixShape: shapes.prefixShape,
      postShape: shapes.postShape,
      auth103CatalogJson: JSON.stringify(shapes.auth103Catalog),
      ...(step === "0106"
        ? {
            predecessorAuth103CatalogJson: JSON.stringify(
              (shapes as ReturnType<typeof compileRoot0106ImportShapes>).predecessorAuth103Catalog,
            ),
          }
        : {}),
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
    const importPath = join(release, `${label}-one-import.sql`);
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
      JSON.stringify(snapshot.applied) === JSON.stringify(predecessorNames) &&
      applicationSchemaMatches(snapshot, shapes.prefixShape) &&
      (await holds(phase, predicates.before));
    const installed = async (phase: DeployPhase, snapshot: D1SchemaState) =>
      JSON.stringify(snapshot.applied) === JSON.stringify(targetArtifact.names) &&
      applicationSchemaMatches(snapshot, shapes.postShape) &&
      (await holds(phase, predicates.after));
    const initial = await readD1SchemaState(database);
    assertTarget();
    const alreadyInstalled = await installed("preflight", initial);
    const before = !alreadyInstalled && (await ready("preflight", initial));
    if (invocation.action === "status")
      return {
        kind: `takoserver.${label}-source-status@v1`,
        environment: "integration",
        commit: source.commit,
        sourceProfile: profile,
        status: alreadyInstalled
          ? `installed-${label}`
          : before
            ? step === "0104"
              ? "auth103-awaiting-financial0104"
              : step === "0105"
                ? "financial0104-awaiting-root0105"
                : step === "0106"
                  ? "root0105-awaiting-root0106"
                  : step === "0107"
                    ? "root0106-awaiting-root0107"
                    : "root0107-awaiting-root0108"
            : "foreign-frozen-or-indeterminate",
        appliedCount: initial.applied.length,
        auth103SourceDigest: registered.auth103.digest,
        sourceDigest: targetArtifact.digest,
        recipeDigest: stepRecipe.digest,
        importDigest: contribution.digest,
        dispatchRecorded: existsSync(attempt),
        nativeRequestQualified: false,
      };
    if (!before || alreadyInstalled)
      throw preflightError(
        step === "0104"
          ? "Financial0104 apply requires exact installed Auth103 (thawed when Money-preserved); installed or foreign state is never replayed"
          : step === "0105"
            ? "Root0105 apply requires exact installed Financial0104 (thawed when Money-preserved); installed or foreign state is never replayed"
            : step === "0106"
              ? "Root0106 apply requires exact installed Root0105 (thawed when Money-preserved); installed or foreign state is never replayed"
              : step === "0107"
                ? "Root0107 apply requires exact installed Root0106 (thawed when Money-preserved); installed or foreign state is never replayed"
                : "Root0108 apply requires exact installed Root0107 (thawed when Money-preserved); installed or foreign state is never replayed",
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
        kind: `takoserver.${label}-dispatched@v1`,
        commit: source.commit,
        sourceProfile: profile,
        sourceDigest: targetArtifact.digest,
        recipeDigest: stepRecipe.digest,
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
        step === "0104"
          ? "Financial0104 import was acknowledged but exact104 postconditions are unproved; repair forward"
          : step === "0105"
            ? "Root0105 import was acknowledged but exact105 postconditions are unproved; repair forward"
            : step === "0106"
              ? "Root0106 import was acknowledged but exact106 postconditions are unproved; repair forward"
              : step === "0107"
                ? "Root0107 import was acknowledged but exact107 postconditions are unproved; repair forward"
                : "Root0108 import was acknowledged but exact108 postconditions are unproved; repair forward",
      );
    const result = {
      kind: `takoserver.${label}-source-apply@v1`,
      environment: "integration",
      commit: source.commit,
      sourceProfile: profile,
      auth103SourceDigest: registered.auth103.digest,
      sourceDigest: targetArtifact.digest,
      recipeDigest: stepRecipe.digest,
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
