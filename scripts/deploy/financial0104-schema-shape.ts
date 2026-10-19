import {
  FINANCIAL_0104_CATALOG_QUERY,
  FINANCIAL_0104_OBJECTS,
  FINANCIAL_0104_TABLES,
} from "../../src/financial-0104-source-contract.ts";
import { canonicalJson } from "../../src/json.ts";
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

/**
 * Exact post-104 expected shapes. 0104 adds objects only: the ordinary replay
 * must keep every post-103 row byte-identical and add exactly the Financial
 * recipe objects; the Money-preserved post-104 shape is that SAME delta added
 * to Money's own post-103 shape (whose owner replay stays pinned at 103).
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
    if (delta.some((row) => names.has(key(row))))
      throw preflightError("Financial0104 collides with a Money-preserved object");
    prefixShape = money.postShape;
    postShape = project(
      [...preserved, ...delta].sort(
        (left, right) => binary(left.type, right.type) || binary(left.name, right.name),
      ),
    );
  }
  return Object.freeze({
    prefixShape,
    postShape,
    auth103Catalog: ordinary103.catalog,
    financialCatalog: Object.freeze(
      FINANCIAL_0104_OBJECTS.map(({ type, name, tbl_name, sql }) =>
        Object.freeze({ type, name, tbl_name, sql }),
      ),
    ),
  });
}

/** Read-only SQL predicate: the Financial catalog is EXACTLY the recipe. */
export function financial0104CatalogPredicate(): string {
  const expected = JSON.stringify(
    FINANCIAL_0104_OBJECTS.map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql })),
  );
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

const compiledCache = new Map<string, ReturnType<typeof compileFinancial0104ImportShapes>>();

/** Schema readiness DATA only: every Auth103 state keeps its own owner check;
 * the only addition is the exact104 ledger plus exact post-104 shape. */
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
  if (input.applied.length !== 104)
    return auth103SourceSchemaReady(input, sourceRoot, mode, profile);
  try {
    if (input.shape === undefined || input.shapeDigest === undefined) return false;
    const source = readFinancial0104CanonicalMigrationSource(sourceRoot);
    try {
      if (
        JSON.stringify(input.local) !== JSON.stringify(source.physicalNames) ||
        JSON.stringify(input.applied) !== JSON.stringify(source.artifact.names)
      )
        return false;
      const cacheKey = `${profile}:${source.artifact.digest}`;
      let expected = compiledCache.get(cacheKey);
      if (expected === undefined) {
        expected = compileFinancial0104ImportShapes(source.auth103, source.artifact, profile);
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

/** Exact104 projection for pending selection: a physical checkout without
 * 0104 has no pending migration once D1 carries the exact Root104 ledger. */
export function financial0104LedgerApplied(
  local: readonly string[],
  applied: readonly string[],
  sourceRoot: string,
): boolean {
  if (applied.length !== 104 || (local.length !== 100 && local.length !== 103)) return false;
  try {
    const source = readFinancial0104CanonicalMigrationSource(sourceRoot);
    try {
      if (
        JSON.stringify(local) !== JSON.stringify(source.physicalNames) ||
        JSON.stringify(applied) !== JSON.stringify(source.artifact.names)
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
