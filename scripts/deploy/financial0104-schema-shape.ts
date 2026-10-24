import {
  FINANCIAL_0104_CATALOG_QUERY,
  FINANCIAL_0104_OBJECTS,
  FINANCIAL_0104_TABLES,
} from "../../src/financial-0104-source-contract.ts";
import { canonicalJson } from "../../src/json.ts";
import {
  MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES,
  moneyCutoverStripeCustomerGuardDefinitions,
} from "../../src/money-cutover-sql.ts";
import { ROOT_0105_OBJECTS } from "../../src/root-0105-org-capture-triggers.ts";
import {
  forwardWorkerNativePredecessorReady,
  forwardWorkerNativeSchemaReady,
} from "../../src/takoform-v2/forward-worker-native-schema.ts";
import {
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME,
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL,
} from "../../src/takoform-v2/operation-generation-index.ts";
import { applicationSchemaMatches } from "./application-schema-shape.ts";
import { sqlLiteral } from "./d1.ts";
import { preflightError } from "./errors.ts";
import { readFinancial0104CanonicalMigrationSource } from "./financial0104-canonical-source.ts";
import { canonicalSchemaShape, type MigrationArtifact } from "./migrations.ts";
import {
  auth103SourceSchemaReady,
  compileAuth103MoneyPreservedImportShapes,
  compileAuth103NativeImportShapes,
} from "./schema-auth103-native-source.ts";

type ShapeRow = { type: string; name: string; table: string; sql: string };
export type Financial0104Profile = "ordinary" | "money-preserved";

function rows(shape: string): ShapeRow[] {
  const parsed = JSON.parse(shape) as unknown;
  if (!Array.isArray(parsed)) throw preflightError("Financial0104 expected shape is malformed");
  return parsed as ShapeRow[];
}
const key = (row: { type: string; name: string }) => `${row.type}\0${row.name}`;
const project = (value: readonly ShapeRow[]) =>
  canonicalSchemaShape(
    value.map(({ type, name, table, sql }) => ({ type, name, tbl_name: table, sql })),
  );
const encoder = new TextEncoder();
const binary = (left: string, right: string) => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

const byTypeName = (left: ShapeRow, right: ShapeRow) =>
  binary(left.type, right.type) || binary(left.name, right.name);

/**
 * The Money cutover guard's Stripe customer generation as exact shape rows.
 * A Money-preserved primary receives these in the SAME guarded import that
 * creates 0104's Customer link table; never by a numbered migration.
 */
export function moneyStripeCustomerGuardRows(): readonly ShapeRow[] {
  const tables = MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES as readonly string[];
  return moneyCutoverStripeCustomerGuardDefinitions().map(([name, sql]) => {
    const table = tables.find((candidate) => name.startsWith(`money_cutover_fence_${candidate}_`));
    if (table === undefined || !sql.includes(` ON ${table} `))
      throw preflightError("Money Stripe customer guard definition is malformed");
    return Object.freeze({ type: "trigger", name, table, sql });
  });
}

/** Install SQL for the Stripe customer generation (Money-preserved only). */
export function moneyStripeCustomerGuardInstallSql(): string {
  return moneyStripeCustomerGuardRows()
    .map((row) => `${row.sql};`)
    .join("\n");
}

/**
 * Exact post-104 expected shapes. 0104 adds objects only: the ordinary replay
 * must keep every post-103 row byte-identical and add exactly the Financial
 * recipe objects; the Money-preserved post-104 shape is that SAME delta plus
 * the Money guard's Stripe customer generation added to Money's own post-103
 * shape (whose owner replay stays pinned at 103).
 */
export function compileFinancial0104ImportShapes(
  auth103: MigrationArtifact,
  artifact: MigrationArtifact,
  profile: Financial0104Profile,
) {
  if (
    auth103.files.length !== 103 ||
    artifact.files.length !== 104 ||
    artifact.files.slice(0, 103).some((file, index) => file.digest !== auth103.files[index]?.digest)
  )
    throw preflightError("Financial0104 shapes require the exact Auth103 predecessor");
  const ordinary103 = compileAuth103NativeImportShapes(auth103);
  const ordinary104 = compileAuth103NativeImportShapes(artifact);
  if (canonicalJson(ordinary104.catalog) !== canonicalJson(ordinary103.catalog))
    throw preflightError("Financial0104 changed the owned Auth103 catalog");
  const before = new Map(rows(ordinary103.postShape).map((row) => [key(row), row]));
  const after = rows(ordinary104.postShape);
  const delta: ShapeRow[] = [];
  for (const row of after) {
    const prior = before.get(key(row));
    if (prior === undefined) delta.push(row);
    else if (canonicalJson(prior) !== canonicalJson(row))
      throw preflightError("Financial0104 rewrote a post-103 object");
  }
  if (after.length - delta.length !== before.size)
    throw preflightError("Financial0104 removed a post-103 object");
  const recipe = FINANCIAL_0104_OBJECTS.map(({ type, name, tbl_name, sql }) => ({
    type,
    name,
    table: tbl_name,
    sql,
  })).sort((left, right) => binary(left.type, right.type) || binary(left.name, right.name));
  if (canonicalJson(delta) !== canonicalJson(recipe))
    throw preflightError("Financial0104 delta differs from its recipe objects");
  let prefixShape = ordinary103.postShape;
  let postShape = ordinary104.postShape;
  if (profile === "money-preserved") {
    const money = compileAuth103MoneyPreservedImportShapes(auth103);
    const preserved = rows(money.postShape);
    const names = new Set(preserved.map(key));
    const stripe = moneyStripeCustomerGuardRows();
    if ([...delta, ...stripe].some((row) => names.has(key(row))))
      throw preflightError("Financial0104 collides with a Money-preserved object");
    const tables = new Set(
      [...preserved, ...delta].filter((row) => row.type === "table").map((row) => row.name),
    );
    if (stripe.some((row) => !tables.has(row.table)))
      throw preflightError("Money Stripe customer generation lacks one of its tables");
    prefixShape = money.postShape;
    postShape = project([...preserved, ...delta, ...stripe].sort(byTypeName));
  }
  return Object.freeze({
    prefixShape,
    postShape,
    auth103Catalog: ordinary103.catalog,
    ordinaryPostShape: ordinary104.postShape,
    financialCatalog: financial0104Catalog(profile),
  });
}

/** Exact Financial catalog rows (by Financial table): the recipe objects, plus
 * the Money guard's Stripe fences on the 0104 link table when Money-preserved. */
function financial0104Catalog(profile: Financial0104Profile) {
  const financialTables = new Set(FINANCIAL_0104_TABLES as readonly string[]);
  return Object.freeze(
    [
      ...FINANCIAL_0104_OBJECTS.map(({ type, name, tbl_name, sql }) => ({
        type,
        name,
        tbl_name,
        sql,
      })),
      ...(profile === "money-preserved"
        ? moneyStripeCustomerGuardRows()
            .filter((row) => financialTables.has(row.table))
            .map(({ type, name, table, sql }) => ({ type, name, tbl_name: table, sql }))
        : []),
    ].map((row) => Object.freeze(row)),
  );
}

/**
 * Exact post-105 expected shapes: the post-104 shape of the same profile plus
 * exactly Root's 0105 objects (trace indexes and Org capture triggers). 0105
 * adds objects only and leaves the Auth103 catalog unchanged.
 */
export function compileRoot0105ImportShapes(
  auth103: MigrationArtifact,
  artifact104: MigrationArtifact,
  artifact105: MigrationArtifact,
  profile: Financial0104Profile,
) {
  if (
    artifact105.files.length !== 105 ||
    artifact105.files
      .slice(0, 104)
      .some((file, index) => file.digest !== artifact104.files[index]?.digest)
  )
    throw preflightError("Root0105 shapes require the exact post-104 predecessor");
  const at104 = compileFinancial0104ImportShapes(auth103, artifact104, profile);
  const ordinary105 = compileAuth103NativeImportShapes(artifact105);
  if (canonicalJson(ordinary105.catalog) !== canonicalJson(at104.auth103Catalog))
    throw preflightError("Root0105 changed the owned Auth103 catalog");
  const before = new Map(rows(at104.ordinaryPostShape).map((row) => [key(row), row]));
  const after = rows(ordinary105.postShape);
  const delta: ShapeRow[] = [];
  for (const row of after) {
    const prior = before.get(key(row));
    if (prior === undefined) delta.push(row);
    else if (canonicalJson(prior) !== canonicalJson(row))
      throw preflightError("Root0105 rewrote a post-104 object");
  }
  if (after.length - delta.length !== before.size)
    throw preflightError("Root0105 removed a post-104 object");
  const recipe = ROOT_0105_OBJECTS.map(({ type, name, tbl_name, sql }) => ({
    type,
    name,
    table: tbl_name,
    sql,
  })).sort(byTypeName);
  if (canonicalJson(delta) !== canonicalJson(recipe))
    throw preflightError("Root0105 delta differs from its recipe objects");
  const prefix = rows(at104.postShape);
  const names = new Set(prefix.map(key));
  if (delta.some((row) => names.has(key(row))))
    throw preflightError("Root0105 collides with a post-104 object");
  return Object.freeze({
    prefixShape: at104.postShape,
    postShape:
      profile === "ordinary"
        ? ordinary105.postShape
        : project([...prefix, ...delta].sort(byTypeName)),
    auth103Catalog: at104.auth103Catalog,
    financialCatalog: at104.financialCatalog,
  });
}

/** Read-only SQL predicate: Root's 0105 objects are present byte-exactly. */
export function root0105CatalogPredicate(): string {
  const expected = JSON.stringify(
    ROOT_0105_OBJECTS.map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql })),
  );
  return `NOT EXISTS (
    WITH expected AS MATERIALIZED (SELECT value FROM json_each(${sqlLiteral(expected)}))
    SELECT 1 FROM expected LEFT JOIN main.sqlite_schema actual
      ON actual.type=json_extract(expected.value,'$.type')
      AND actual.name=json_extract(expected.value,'$.name')
      AND actual.tbl_name=json_extract(expected.value,'$.tbl_name')
    WHERE actual.name IS NULL OR actual.sql IS NOT json_extract(expected.value,'$.sql')
  )`;
}

const forward106ChangedTriggers = Object.freeze([
  "queue_v2_batch_execution_send_guard",
  "tf_v2_worker_cron_match_insert_guard",
  "tf_v2_worker_native_deletion_presend_absence_guard",
  "tf_v2_worker_native_deletion_send_guard",
  "tf_v2_worker_native_deletion_stage_guard",
  "tf_v2_worker_native_effect_insert_guard",
]);

/** The existing native recipe changes exactly six guards and adds one index. */
export function compileRoot0106ImportShapes(
  auth103: MigrationArtifact,
  artifact104: MigrationArtifact,
  artifact105: MigrationArtifact,
  artifact106: MigrationArtifact,
  profile: Financial0104Profile,
) {
  if (
    artifact106.files.length !== 106 ||
    artifact106.files
      .slice(0, 105)
      .some(
        (file, index) =>
          file.digest !== artifact105.files[index]?.digest ||
          file.bytes !== artifact105.files[index]?.bytes,
      )
  )
    throw preflightError("Root0106 shapes require the exact post-105 predecessor");
  const at105 = compileRoot0105ImportShapes(auth103, artifact104, artifact105, profile);
  const ordinary105 = compileAuth103NativeImportShapes(artifact105);
  const ordinary106 = compileAuth103NativeImportShapes(artifact106);
  const before = new Map(rows(ordinary105.postShape).map((row) => [key(row), row]));
  const changed: ShapeRow[] = [];
  const added: ShapeRow[] = [];
  for (const row of rows(ordinary106.postShape)) {
    const prior = before.get(key(row));
    if (prior === undefined) added.push(row);
    else if (canonicalJson(prior) !== canonicalJson(row)) changed.push(row);
    before.delete(key(row));
  }
  if (
    before.size !== 0 ||
    canonicalJson(changed.map((row) => row.name).sort(binary)) !==
      canonicalJson([...forward106ChangedTriggers]) ||
    added.length !== 1 ||
    added[0]?.type !== "index" ||
    added[0]?.name !== V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME ||
    added[0]?.table !== "tf_v2_operations" ||
    added[0]?.sql !== V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL
  )
    throw preflightError("Root0106 shape delta differs from the native recipe");
  const replacements = new Map(changed.map((row) => [key(row), row]));
  const profileRows = rows(at105.postShape);
  if (added.some((row) => profileRows.some((prior) => key(prior) === key(row))))
    throw preflightError("Root0106 collides with a post-105 object");
  return Object.freeze({
    prefixShape: at105.postShape,
    postShape:
      profile === "ordinary"
        ? ordinary106.postShape
        : project(
            [...profileRows.map((row) => replacements.get(key(row)) ?? row), ...added].sort(
              byTypeName,
            ),
          ),
    predecessorAuth103Catalog: at105.auth103Catalog,
    auth103Catalog: ordinary106.catalog,
    financialCatalog: at105.financialCatalog,
  });
}

export function root0106PredecessorPredicate(): string {
  return forwardWorkerNativePredecessorReady();
}

export function root0106CatalogPredicate(): string {
  return forwardWorkerNativeSchemaReady();
}

/** Read-only SQL predicate: the Financial catalog is EXACTLY the recipe (plus
 * the Money guard's Stripe fences on the 0104 link table when Money-preserved). */
export function financial0104CatalogPredicate(profile: Financial0104Profile = "ordinary"): string {
  const expected = JSON.stringify(financial0104Catalog(profile));
  return `NOT EXISTS (
    WITH expected AS MATERIALIZED (SELECT value FROM json_each(${sqlLiteral(expected)})),
    actual AS MATERIALIZED (${FINANCIAL_0104_CATALOG_QUERY})
    SELECT 1 FROM expected LEFT JOIN actual ON actual.type=json_extract(expected.value,'$.type')
      AND actual.name=json_extract(expected.value,'$.name')
      AND actual.tbl_name=json_extract(expected.value,'$.tbl_name')
    WHERE actual.name IS NULL OR actual.sql IS NOT json_extract(expected.value,'$.sql')
    UNION ALL
    SELECT 1 FROM actual WHERE NOT EXISTS (SELECT 1 FROM expected
      WHERE actual.type=json_extract(expected.value,'$.type')
        AND actual.name=json_extract(expected.value,'$.name')
        AND actual.tbl_name=json_extract(expected.value,'$.tbl_name'))
  ) AND (SELECT count(*) FROM main.sqlite_schema WHERE type='table'
    AND name IN (${FINANCIAL_0104_TABLES.map(sqlLiteral).join(",")}))=${FINANCIAL_0104_TABLES.length}`;
}

const compiledCache = new Map<string, { readonly postShape: string }>();

/** Schema readiness DATA only: every Auth103 state keeps its own owner check;
 * the only additions are the exact104/exact105/exact106 ledgers plus their exact
 * post-chain shapes. A physical successor beyond the applied ledger leaves it
 * pending for a normal Host. */
export function financial0104SourceSchemaReady(
  input: {
    readonly local: readonly string[];
    readonly applied: readonly string[];
    readonly shape?: string;
    readonly shapeDigest?: string;
  },
  sourceRoot: string,
  mode: "maintenance" | "normal",
  profile: Financial0104Profile = "ordinary",
): boolean {
  const count = input.applied.length;
  if (count !== 104 && count !== 105 && count !== 106)
    return auth103SourceSchemaReady(input, sourceRoot, mode, profile);
  try {
    if (input.shape === undefined || input.shapeDigest === undefined) return false;
    const source = readFinancial0104CanonicalMigrationSource(sourceRoot);
    try {
      const artifact = source.artifactFor(count);
      if (
        JSON.stringify(input.local) !== JSON.stringify(source.physicalNames) ||
        JSON.stringify(input.applied) !== JSON.stringify(artifact.names) ||
        (mode === "normal" && source.physicalNames.length > count)
      )
        return false;
      const cacheKey = `${profile}:${artifact.digest}`;
      let expected = compiledCache.get(cacheKey);
      if (expected === undefined) {
        expected =
          count === 104
            ? compileFinancial0104ImportShapes(source.auth103, source.artifact, profile)
            : count === 105
              ? compileRoot0105ImportShapes(
                  source.auth103,
                  source.artifact,
                  source.artifact105,
                  profile,
                )
              : compileRoot0106ImportShapes(
                  source.auth103,
                  source.artifact,
                  source.artifact105,
                  source.artifact106,
                  profile,
                );
        if (compiledCache.size >= 4) compiledCache.clear();
        compiledCache.set(cacheKey, expected);
      }
      source.assertCurrent();
      return applicationSchemaMatches(
        { applied: input.applied, shape: input.shape, shapeDigest: input.shapeDigest },
        expected.postShape,
      );
    } finally {
      source.dispose();
    }
  } catch {
    return false;
  }
}

/** Exact104/exact105/exact106 projection for pending selection: a physical checkout
 * that stops before the applied chain has no pending migration once D1
 * carries that exact Root post-Auth103 ledger. */
export function financial0104LedgerApplied(
  local: readonly string[],
  applied: readonly string[],
  sourceRoot: string,
): boolean {
  const count = applied.length;
  if (
    (count !== 104 && count !== 105 && count !== 106) ||
    (local.length !== 100 &&
      local.length !== 103 &&
      local.length !== 104 &&
      local.length !== 105) ||
    local.length >= count
  )
    return false;
  try {
    const source = readFinancial0104CanonicalMigrationSource(sourceRoot);
    try {
      if (
        JSON.stringify(local) !== JSON.stringify(source.physicalNames) ||
        JSON.stringify(applied) !== JSON.stringify(source.artifactFor(count).names)
      )
        return false;
      source.assertCurrent();
      return true;
    } finally {
      source.dispose();
    }
  } catch {
    return false;
  }
}
