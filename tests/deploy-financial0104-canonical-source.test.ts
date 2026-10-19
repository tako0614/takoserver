import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readAuth103CanonicalMigrationSource } from "../scripts/deploy/auth103-canonical-migration-source.ts";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-native-source.ts";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { readFinancial0104CanonicalMigrationSource } from "../scripts/deploy/financial0104-canonical-source.ts";
import {
  FINANCIAL0104_MIGRATION_NAME,
  FINANCIAL0104_ROOT_RECIPE_DIGEST,
} from "../scripts/deploy/financial0104-recipe.ts";
import {
  compileFinancial0104ImportShapes,
  financial0104LedgerApplied,
  financial0104SourceSchemaReady,
} from "../scripts/deploy/financial0104-schema-shape.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { readCurrentAuditedMigrationSourceArtifact } from "../scripts/deploy/schema.ts";
import { auth103SourceSchemaReady } from "../scripts/deploy/schema-auth103-native-source.ts";
import {
  composeFinancial0104ImportData,
  type Financial0104ImportInput,
} from "../scripts/deploy/schema-financial0104-source.ts";
import {
  AUTH103_NATIVE_CATALOG_QUERY,
  AUTH103_NATIVE_MIGRATIONS,
} from "../src/auth103-native-source-contract.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  FINANCIAL_0104_DDL,
  FINANCIAL_0104_PREDECESSOR,
  financial0104RecipeDigest,
} from "../src/financial-0104-source-contract.ts";
import { canonicalJson } from "../src/json.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

// Root registration conservation only. These fixtures never mint Money,
// Auth or Financial authority; they replay the exact source bytes locally.
const ROOT = resolve(import.meta.dir, "..");
const LONG = 120_000;
/** The Auth103 artifact digest before Financial0104 registration existed. */
const AUTH103_ARTIFACT_DIGEST =
  "sha256:2c21373800229c14ce2e462a314f1915919059511786fe0349997914eab1f358";
const EPOCH = `sha256:${"e".repeat(64)}`;
const hash = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sourceRoot(physical: "100" | "103" | "104" = "100"): string {
  const root = mkdtempSync(resolve(tmpdir(), "financial0104-source-"));
  roots.push(root);
  const directory = resolve(root, "migrations");
  mkdirSync(directory);
  mkdirSync(resolve(root, "src"));
  writeFileSync(
    resolve(root, "src/auth103-source-clock.ts"),
    readFileSync(resolve(ROOT, "src/auth103-source-clock.ts")),
    { mode: 0o600 },
  );
  for (const row of MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100))
    writeFileSync(resolve(directory, row.name), row.sql, { mode: 0o600, flag: "wx" });
  if (physical !== "100")
    for (const row of createAuth103CanonicalSourceArtifacts(root).files)
      writeFileSync(resolve(directory, row.name), row.sql, { mode: 0o600, flag: "wx" });
  if (physical === "104")
    writeFileSync(resolve(directory, FINANCIAL0104_MIGRATION_NAME), FINANCIAL_0104_DDL, {
      mode: 0o600,
      flag: "wx",
    });
  return root;
}

function run(database: Database, sql: string): void {
  database.query("BEGIN IMMEDIATE").all();
  try {
    for (const statement of frameHostMigrationSql(sql)) database.query(statement).all();
    database.query("COMMIT").all();
  } catch (error) {
    database.query("ROLLBACK").all();
    throw error;
  }
}

function state(database: Database, local: readonly string[]) {
  const shape = canonicalSchemaShape(
    database
      .query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
        "SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
      )
      .all(),
  );
  return {
    local,
    applied: database
      .query<{ name: string }, []>("SELECT name FROM d1_migrations ORDER BY id")
      .all()
      .map(({ name }) => name),
    shape,
    shapeDigest: hash(shape),
  };
}

const count = (database: Database, table: string) =>
  database.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;

function importInput(
  root: string,
  profile: "ordinary" | "money-preserved",
): {
  readonly input: Financial0104ImportInput;
  readonly source: ReturnType<typeof readFinancial0104CanonicalMigrationSource>;
  readonly shapes: ReturnType<typeof compileFinancial0104ImportShapes>;
} {
  const source = readFinancial0104CanonicalMigrationSource(root);
  const shapes = compileFinancial0104ImportShapes(source.auth103, source.artifact, profile);
  const recipes = source.auth103Recipes;
  return {
    source,
    shapes,
    input: {
      artifact: source.artifact,
      prefixShape: shapes.prefixShape,
      postShape: shapes.postShape,
      auth103CatalogJson: JSON.stringify(shapes.auth103Catalog),
      registration: [
        recipes.registrationRef,
        recipes.recipeDigest,
        recipes.clockSourceDigest,
        recipes.clockPolicyRef,
      ],
      ...(profile === "money-preserved" ? { moneyWriterEpoch: EPOCH } : {}),
    },
  };
}

/** Exact ordinary installed103 through the unchanged ledger importer. */
function ordinary103(source: ReturnType<typeof readFinancial0104CanonicalMigrationSource>) {
  const database = new Database(":memory:", { strict: true });
  database.query("PRAGMA foreign_keys=ON").all();
  for (const [index, file] of source.auth103.files.slice(0, 100).entries())
    run(database, buildD1MigrationImport([file], { freshLedger: index === 0 }).sql);
  run(
    database,
    buildD1MigrationImport(source.auth103.files.slice(100), { freshLedger: false }).sql,
  );
  return database;
}

/** Money-preserved installed103 rebuilt from Money's own exact post103 shape. */
function moneyPreserved103(
  source: ReturnType<typeof readFinancial0104CanonicalMigrationSource>,
  prefixShape: string,
) {
  const database = new Database(":memory:", { strict: true });
  const rows = (
    JSON.parse(prefixShape) as { type: string; name: string; table: string; sql: string }[]
  ).filter(({ name }) => !name.startsWith("sqlite_"));
  for (const type of ["table", "index", "view", "trigger"])
    for (const row of rows.filter((candidate) => candidate.type === type)) database.exec(row.sql);
  database.exec(
    "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  for (const name of source.auth103.names)
    database.query("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
  const recipes = source.auth103Recipes;
  database
    .query(
      "INSERT INTO auth103_native_source_registration(registration_ref,recipe_digest,clock_source_digest,clock_policy_ref) VALUES (?,?,?,?)",
    )
    .run(
      recipes.registrationRef,
      recipes.recipeDigest,
      recipes.clockSourceDigest,
      recipes.clockPolicyRef,
    );
  database.exec(
    "INSERT INTO money_unit_policy VALUES (1,'usd-micros-v2','microcent-v1','usd-cents-v1')",
  );
  database.query("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)").run(EPOCH);
  database.exec(
    "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
  );
  return database;
}

test("the Auth103 artifact, recipes and registration stay byte-identical beside the separate 104", () => {
  expect(AUTH103_NATIVE_MIGRATIONS).toHaveLength(3);
  expect<string | undefined>(FINANCIAL_0104_PREDECESSOR).toBe(AUTH103_NATIVE_MIGRATIONS[2]);
  const auth103 = readAuth103CanonicalMigrationSource(ROOT);
  const financial = readFinancial0104CanonicalMigrationSource(ROOT);
  try {
    expect(auth103.artifact.digest).toBe(AUTH103_ARTIFACT_DIGEST);
    expect(auth103.artifact.files).toHaveLength(103);
    expect(financial.auth103.digest).toBe(AUTH103_ARTIFACT_DIGEST);
    expect(canonicalJson(financial.auth103Recipes)).toBe(
      canonicalJson(createAuth103CanonicalSourceArtifacts(ROOT)),
    );
    expect(financial.artifact.names).toEqual([
      ...auth103.artifact.names,
      FINANCIAL0104_MIGRATION_NAME,
    ]);
    expect(financial.artifact.digest).not.toBe(AUTH103_ARTIFACT_DIGEST);
    expect(financial.artifact.files[103]?.digest ?? "").toBe(FINANCIAL0104_ROOT_RECIPE_DIGEST);
  } finally {
    financial.dispose();
    auth103.dispose();
  }
});

test("Root pins the exact Financial recipe digest", async () => {
  expect(await financial0104RecipeDigest()).toBe(FINANCIAL0104_ROOT_RECIPE_DIGEST);
  expect(hash(FINANCIAL_0104_DDL)).toBe(FINANCIAL0104_ROOT_RECIPE_DIGEST);
});

test(
  "only the exact physical 0104 recipe joins the audited inventory; tampered or foreign 0104 is refused",
  () => {
    for (const physical of ["100", "103", "104"] as const) {
      const root = sourceRoot(physical);
      const view = readCurrentAuditedMigrationSourceArtifact(resolve(root, "migrations"));
      expect(view.files).toHaveLength(100);
      const auth103 = readAuth103CanonicalMigrationSource(root);
      try {
        expect(auth103.artifact.digest).toBe(AUTH103_ARTIFACT_DIGEST);
        expect(auth103.physicalNames).toHaveLength(Number(physical));
      } finally {
        auth103.dispose();
      }
    }
    const tampered = sourceRoot("104");
    const path = resolve(tampered, "migrations", FINANCIAL0104_MIGRATION_NAME);
    writeFileSync(path, `-- unreviewed Financial change\n${FINANCIAL_0104_DDL}`);
    expect(() => readAuth103CanonicalMigrationSource(tampered)).toThrow(
      "Auth103 audited source inventory changed or has a foreign successor",
    );
    expect(() => readFinancial0104CanonicalMigrationSource(tampered)).toThrow();
    expect(() =>
      readCurrentAuditedMigrationSourceArtifact(resolve(tampered, "migrations")),
    ).toThrow("audited source extension must be exactly the owning101/102/103 recipes");
    const foreign = sourceRoot("103");
    writeFileSync(resolve(foreign, "migrations", "0104_foreign.sql"), FINANCIAL_0104_DDL);
    expect(() => readAuth103CanonicalMigrationSource(foreign)).toThrow(
      "Auth103 audited source inventory changed or has a foreign successor",
    );
    expect(() => readCurrentAuditedMigrationSourceArtifact(resolve(foreign, "migrations"))).toThrow(
      "audited source extension must be exactly the owning101/102/103 recipes",
    );
  },
  LONG,
);

test(
  "one guarded import moves ordinary exact103 to exact104 and never replays",
  () => {
    const root = sourceRoot("100");
    const { input, source, shapes } = importInput(root, "ordinary");
    const database = ordinary103(source);
    try {
      const local = source.physicalNames;
      expect(auth103SourceSchemaReady(state(database, local), root, "normal")).toBe(true);
      expect(financial0104SourceSchemaReady(state(database, local), root, "normal")).toBe(true);
      const auth103Catalog = canonicalJson(database.query(AUTH103_NATIVE_CATALOG_QUERY).all());
      expect(auth103Catalog).toBe(canonicalJson(shapes.auth103Catalog));
      const imported = composeFinancial0104ImportData(input);
      expect(imported.sql).toContain(
        buildD1MigrationImport(source.artifact.files.slice(103), { freshLedger: false }).sql,
      );
      expect(imported.digest).toBe(hash(imported.sql));
      run(database, imported.sql);
      const after = state(database, local);
      expect(after.applied).toEqual([...source.artifact.names]);
      expect(financial0104SourceSchemaReady(after, root, "normal")).toBe(true);
      expect(financial0104SourceSchemaReady(after, root, "normal", "money-preserved")).toBe(false);
      expect(auth103SourceSchemaReady(after, root, "normal")).toBe(false);
      expect(financial0104LedgerApplied(local, after.applied, root)).toBe(true);
      expect(canonicalJson(database.query(AUTH103_NATIVE_CATALOG_QUERY).all())).toBe(
        auth103Catalog,
      );
      expect(database.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
      // No Money tables: the Financial fences make every Financial write fail closed.
      expect(() =>
        database.exec(
          "INSERT INTO financial_action_source_registrations VALUES ('r','i','d','financial-action-registration-canonical-v1','{}','2026-01-01T00:00:00.000Z')",
        ),
      ).toThrow();
      expect(count(database, "financial_action_source_registrations")).toBe(0);
      // Installed or foreign state is never replayed by the same import.
      expect(() => run(database, imported.sql)).toThrow();
      expect(count(database, "d1_migrations")).toBe(104);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);

test(
  "the guards refuse a foreign predecessor and a tampered 0104 artifact",
  () => {
    const root = sourceRoot("100");
    const { input, source } = importInput(root, "ordinary");
    const database = ordinary103(source);
    try {
      database.exec("CREATE TABLE foreign_successor_probe (id INTEGER PRIMARY KEY)");
      expect(() => run(database, composeFinancial0104ImportData(input).sql)).toThrow();
      expect(count(database, "d1_migrations")).toBe(103);
      database.exec("DROP TABLE foreign_successor_probe");
      const file = source.artifact.files[103];
      if (file === undefined) throw new Error("generated 0104 missing");
      const bytes = readFileSync(file.path);
      writeFileSync(file.path, Buffer.concat([Buffer.from("-- foreign\n"), bytes]));
      expect(() => composeFinancial0104ImportData(input)).toThrow(
        "Financial0104 import requires the exact Auth103 artifact plus 0104",
      );
      expect(() => source.assertCurrent()).toThrow();
      writeFileSync(file.path, bytes);
      run(database, composeFinancial0104ImportData(input).sql);
      expect(count(database, "d1_migrations")).toBe(104);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);

test(
  "a Money-preserved exact103 accepts 0104 only after the post103 thaw",
  () => {
    const root = sourceRoot("100");
    const { input, source, shapes } = importInput(root, "money-preserved");
    const database = moneyPreserved103(source, shapes.prefixShape);
    try {
      const local = source.physicalNames;
      const imported = composeFinancial0104ImportData(input);
      // Money's own thaw guard is pinned to the exact103 ledger: frozen refuses.
      expect(() => run(database, imported.sql)).toThrow();
      expect(count(database, "d1_migrations")).toBe(103);
      database.exec("DELETE FROM money_cutover_freeze");
      database
        .query("INSERT INTO money_cutover_writer_permit VALUES (1,'usd-micros-v2',?)")
        .run(EPOCH);
      expect(() => run(database, imported.sql)).toThrow();
      database.exec("DELETE FROM money_cutover_writer_permit");
      run(database, imported.sql);
      const after = state(database, local);
      expect(after.applied).toEqual([...source.artifact.names]);
      expect(financial0104SourceSchemaReady(after, root, "normal", "money-preserved")).toBe(true);
      expect(financial0104SourceSchemaReady(after, root, "normal")).toBe(false);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);

test(
  "a physical 0104 checkout reports 0104 pending for a normal exact103 Host",
  () => {
    const root = sourceRoot("104");
    const source = readFinancial0104CanonicalMigrationSource(root);
    const database = ordinary103(source);
    try {
      const local = readMigrationArtifact(resolve(root, "migrations")).names;
      expect(local).toEqual([...source.artifact.names]);
      const current = state(database, local);
      expect(auth103SourceSchemaReady(current, root, "normal")).toBe(false);
      expect(financial0104SourceSchemaReady(current, root, "normal")).toBe(false);
      expect(financial0104SourceSchemaReady(current, root, "maintenance")).toBe(true);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);
