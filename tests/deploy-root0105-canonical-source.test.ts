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
import { FINANCIAL0104_MIGRATION_NAME } from "../scripts/deploy/financial0104-recipe.ts";
import {
  compileFinancial0104ImportShapes,
  compileRoot0105ImportShapes,
  financial0104LedgerApplied,
  financial0104SourceSchemaReady,
  moneyStripeCustomerGuardRows,
} from "../scripts/deploy/financial0104-schema-shape.ts";
import { verifyFreshV2IntegrationStorageTarget } from "../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { isPostAuth103RecipeSuffix } from "../scripts/deploy/post-auth103-recipes.ts";
import {
  ROOT0105_MIGRATION_NAME,
  ROOT0105_RECIPE_DIGEST,
  root0105Recipe,
} from "../scripts/deploy/root0105-recipe.ts";
import { readCurrentAuditedMigrationSourceArtifact } from "../scripts/deploy/schema.ts";
import { auth103SourceSchemaReady } from "../scripts/deploy/schema-auth103-native-source.ts";
import {
  composeFinancial0104ImportData,
  type Financial0104ImportInput,
} from "../scripts/deploy/schema-financial0104-source.ts";
import { moneyUnitCutoverSchemaMatches } from "../scripts/deploy/schema-money-unit-cutover.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { workerMoneyUnitSchemaReady, workerSchemaAllowsPending } from "../scripts/deploy/worker.ts";
import { AUTH103_NATIVE_CATALOG_QUERY } from "../src/auth103-native-source-contract.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  FINANCIAL_0104_CATALOG_QUERY,
  FINANCIAL_0104_DDL,
  FINANCIAL_0104_OBJECTS,
} from "../src/financial-0104-source-contract.ts";
import { canonicalJson } from "../src/json.ts";
import {
  inspectMoneyCutoverGuard,
  MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES,
  moneyCutoverStripeCustomerGuardDefinitions,
} from "../src/money-cutover-sql.ts";
import {
  ROOT_0105_DDL,
  ROOT_0105_MIGRATION,
  ROOT_0105_OBJECTS,
} from "../src/root-0105-org-capture-triggers.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

// Root post-Auth103 chain conservation only. These fixtures never mint Money,
// Auth or Financial authority; they replay the exact source bytes locally.
const ROOT = resolve(import.meta.dir, "..");
const LONG = 180_000;
const AUTH103_ARTIFACT_DIGEST =
  "sha256:2c21373800229c14ce2e462a314f1915919059511786fe0349997914eab1f358";
const EPOCH = `sha256:${"e".repeat(64)}`;
const hash = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
type Source = ReturnType<typeof readFinancial0104CanonicalMigrationSource>;
type Profile = "ordinary" | "money-preserved";

function sourceRoot(physical: "100" | "103" | "104" | "105" = "100"): string {
  const root = mkdtempSync(resolve(tmpdir(), "root0105-source-"));
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
  if (physical === "104" || physical === "105")
    writeFileSync(resolve(directory, FINANCIAL0104_MIGRATION_NAME), FINANCIAL_0104_DDL, {
      mode: 0o600,
      flag: "wx",
    });
  if (physical === "105")
    writeFileSync(resolve(directory, ROOT0105_MIGRATION_NAME), ROOT_0105_DDL, {
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

function tableData(database: Database): string {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all();
  return canonicalJson(
    tables.map(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      return [name, database.query(`SELECT * FROM ${quoted}`).all()];
    }),
  );
}

function expectMissingMoneyDependency(database: Database, sql: string): void {
  let failure: unknown;
  try {
    database.exec(sql);
  } catch (error) {
    failure = error;
  }
  const message = String(failure);
  // Pin the causal class while allowing SQLite's optional `main.` qualification
  // and platform-specific error prefixes. Generic throws and constraint errors
  // do not count as reaching the missing Money dependency.
  expect(message).toMatch(
    /no such table: (?:main\.)?money_cutover_(?:freeze|writer_permit|authorized_epoch)/u,
  );
}

// Each source root regenerates the same exact bytes, so the compiled shapes are
// shared per profile and chain digest; every test still builds its own steps.
const compiledShapes = new Map<
  string,
  {
    readonly at104: ReturnType<typeof compileFinancial0104ImportShapes>;
    readonly at105: ReturnType<typeof compileRoot0105ImportShapes>;
  }
>();

function inputs(source: Source, profile: Profile) {
  const key = `${profile}:${source.auth103.digest}:${source.artifact.digest}:${source.artifact105.digest}`;
  let shapes = compiledShapes.get(key);
  if (shapes === undefined) {
    shapes = {
      at104: compileFinancial0104ImportShapes(source.auth103, source.artifact, profile),
      at105: compileRoot0105ImportShapes(
        source.auth103,
        source.artifact,
        source.artifact105,
        profile,
      ),
    };
    compiledShapes.set(key, shapes);
  }
  const { at104, at105 } = shapes;
  const recipes = source.auth103Recipes;
  const common = {
    auth103CatalogJson: JSON.stringify(at104.auth103Catalog),
    registration: [
      recipes.registrationRef,
      recipes.recipeDigest,
      recipes.clockSourceDigest,
      recipes.clockPolicyRef,
    ] as const,
    ...(profile === "money-preserved" ? { moneyWriterEpoch: EPOCH } : {}),
  };
  const step104: Financial0104ImportInput = {
    ...common,
    artifact: source.artifact,
    prefixShape: at104.prefixShape,
    postShape: at104.postShape,
  };
  const step105: Financial0104ImportInput = {
    ...common,
    artifact: source.artifact105,
    prefixShape: at105.prefixShape,
    postShape: at105.postShape,
  };
  return { at104, at105, step104, step105 };
}

// The ordinary exact103 replay is identical for every test of one Auth103
// artifact: it runs once and each test opens its own copy (foreign keys on).
const ordinary103Images = new Map<string, Uint8Array>();

function ordinary103(source: Source) {
  let image = ordinary103Images.get(source.auth103.digest);
  if (image === undefined) {
    const database = new Database(":memory:", { strict: true });
    database.query("PRAGMA foreign_keys=ON").all();
    for (const [index, file] of source.auth103.files.slice(0, 100).entries())
      run(database, buildD1MigrationImport([file], { freshLedger: index === 0 }).sql);
    run(
      database,
      buildD1MigrationImport(source.auth103.files.slice(100), { freshLedger: false }).sql,
    );
    image = database.serialize();
    database.close();
    ordinary103Images.set(source.auth103.digest, image);
  }
  const database = Database.deserialize(image, { strict: true });
  database.query("PRAGMA foreign_keys=ON").all();
  return database;
}

/** Money-preserved installed103 rebuilt from Money's own exact post103 shape, thawed. */
function moneyPreserved103(source: Source, prefixShape: string) {
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
  return database;
}

test("Root pins its exact 0105 recipe after the exact Financial0104 and the unchanged Auth103", () => {
  const recipe = root0105Recipe();
  expect(recipe.name).toBe(ROOT_0105_MIGRATION);
  expect(recipe.digest).toBe(ROOT0105_RECIPE_DIGEST);
  expect(hash(ROOT_0105_DDL)).toBe(ROOT0105_RECIPE_DIGEST);
  const source = readFinancial0104CanonicalMigrationSource(ROOT);
  try {
    expect(source.auth103.digest).toBe(AUTH103_ARTIFACT_DIGEST);
    expect(source.artifact105.names).toEqual([...source.artifact.names, ROOT0105_MIGRATION_NAME]);
    expect(source.artifact105.files.slice(0, 104).map((file) => file.digest)).toEqual(
      source.artifact.files.map((file) => file.digest),
    );
    expect(source.artifact105.files[104]?.digest ?? "").toBe(ROOT0105_RECIPE_DIGEST);
    expect(source.artifactFor(104)).toBe(source.artifact);
    expect(source.artifactFor(105)).toBe(source.artifact105);
  } finally {
    source.dispose();
  }
});

test(
  "only the exact physical chain joins the audited inventory; tampered, foreign or orphan 0105 is refused",
  () => {
    const root = sourceRoot("105");
    expect(
      readCurrentAuditedMigrationSourceArtifact(resolve(root, "migrations")).files,
    ).toHaveLength(100);
    const auth103 = readAuth103CanonicalMigrationSource(root);
    try {
      expect(auth103.artifact.digest).toBe(AUTH103_ARTIFACT_DIGEST);
      expect(auth103.physicalNames).toHaveLength(105);
      expect(
        isPostAuth103RecipeSuffix(
          readMigrationArtifact(resolve(root, "migrations")).files.slice(103),
        ),
      ).toBe(true);
    } finally {
      auth103.dispose();
    }
    const tampered = sourceRoot("105");
    writeFileSync(
      resolve(tampered, "migrations", ROOT0105_MIGRATION_NAME),
      `-- unreviewed Root change\n${ROOT_0105_DDL}`,
    );
    const foreign = sourceRoot("104");
    writeFileSync(resolve(foreign, "migrations", "0105_foreign.sql"), ROOT_0105_DDL);
    const orphan = sourceRoot("103");
    writeFileSync(resolve(orphan, "migrations", ROOT0105_MIGRATION_NAME), ROOT_0105_DDL);
    // A 0105 without its 0104 is not even a gap-free lineage.
    expect(() => readAuth103CanonicalMigrationSource(orphan)).toThrow();
    expect(() => readFinancial0104CanonicalMigrationSource(orphan)).toThrow();
    expect(() =>
      readCurrentAuditedMigrationSourceArtifact(resolve(orphan, "migrations")),
    ).toThrow();
    for (const refused of [tampered, foreign]) {
      expect(() => readAuth103CanonicalMigrationSource(refused)).toThrow(
        "Auth103 audited source inventory changed or has a foreign successor",
      );
      expect(() => readFinancial0104CanonicalMigrationSource(refused)).toThrow();
      expect(() =>
        readCurrentAuditedMigrationSourceArtifact(resolve(refused, "migrations")),
      ).toThrow("audited source extension must be exactly the owning101/102/103 recipes");
    }
  },
  LONG,
);

test(
  "ordinary exact103 moves to exact104 and then exact105 by two guarded imports that never replay",
  () => {
    const root = sourceRoot("100");
    const source = readFinancial0104CanonicalMigrationSource(root);
    const { step104, step105 } = inputs(source, "ordinary");
    const database = ordinary103(source);
    try {
      const local = source.physicalNames;
      database.exec(
        "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES('principal:a','google','a','a@invalid.example','A','2026-10-15T00:00:00.000Z')",
      );
      database.exec(
        "INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES('org:a','A','principal:a','2026-10-15T00:00:00.000Z')",
      );
      const import105 = composeFinancial0104ImportData(step105);
      // 0105 never runs on exact103.
      expect(() => run(database, import105.sql)).toThrow();
      expect(count(database, "d1_migrations")).toBe(103);
      run(database, composeFinancial0104ImportData(step104).sql);
      const at104 = state(database, local);
      expect(financial0104SourceSchemaReady(at104, root, "normal")).toBe(true);
      expect(financial0104LedgerApplied(local, at104.applied, root)).toBe(true);
      const auth103Catalog = canonicalJson(database.query(AUTH103_NATIVE_CATALOG_QUERY).all());
      expect(import105.sql).toContain(
        buildD1MigrationImport(source.artifact105.files.slice(104), { freshLedger: false }).sql,
      );
      expect(import105.sql).not.toContain("money_cutover_fence_stripe");
      run(database, import105.sql);
      const after = state(database, local);
      expect(after.applied).toEqual([...source.artifact105.names]);
      expect(financial0104SourceSchemaReady(after, root, "normal")).toBe(true);
      expect(financial0104SourceSchemaReady(after, root, "normal", "money-preserved")).toBe(false);
      expect(financial0104SourceSchemaReady(at104, root, "maintenance")).toBe(true);
      expect(auth103SourceSchemaReady(after, root, "normal")).toBe(false);
      expect(financial0104LedgerApplied(local, after.applied, root)).toBe(true);
      expect(canonicalJson(database.query(AUTH103_NATIVE_CATALOG_QUERY).all())).toBe(
        auth103Catalog,
      );
      for (const object of ROOT_0105_OBJECTS)
        expect(
          database
            .query("SELECT type,tbl_name,sql FROM sqlite_schema WHERE name=?")
            .get(object.name),
        ).toEqual({ type: object.type, tbl_name: object.tbl_name, sql: object.sql });
      // The install-time backfill records the existing Org once, raw.
      expect(
        database
          .query("SELECT org_id,phase FROM financial_customer_history_birth_observations")
          .all(),
      ).toEqual([{ org_id: "org:a", phase: "raw" }]);
      expect(database.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
      expect(() => run(database, import105.sql)).toThrow();
      expect(count(database, "d1_migrations")).toBe(105);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);

test(
  "ordinary exact105 schema and catalog readiness do not imply Financial writes have Money SQL dependencies",
  () => {
    const root = sourceRoot("100");
    const source = readFinancial0104CanonicalMigrationSource(root);
    const { step104, step105 } = inputs(source, "ordinary");
    const database = ordinary103(source);
    try {
      const local = source.physicalNames;
      run(database, composeFinancial0104ImportData(step104).sql);
      run(database, composeFinancial0104ImportData(step105).sql);

      const ready = state(database, local);
      expect(ready.applied).toEqual([...source.artifact105.names]);
      expect(financial0104SourceSchemaReady(ready, root, "normal")).toBe(true);
      expect(financial0104LedgerApplied(local, ready.applied, root)).toBe(true);
      const installedCatalog = database.query(FINANCIAL_0104_CATALOG_QUERY).all();
      const catalogRows = new Set(installedCatalog.map((row) => canonicalJson(row)));
      const recipeRows = new Set(
        FINANCIAL_0104_OBJECTS.map(({ type, name, tbl_name, sql }) =>
          canonicalJson({ type, name, tbl_name, sql }),
        ),
      );
      expect(catalogRows).toEqual(recipeRows);

      const missingMoneyTables = [
        "money_cutover_freeze",
        "money_cutover_writer_permit",
        "money_cutover_authorized_epoch",
      ] as const;
      // The historical 0094 money_unit_policy remains part of this exact chain;
      // it does not install the request-time cutover writer frame.
      expect(
        database.query("SELECT name FROM sqlite_schema WHERE name='money_unit_policy'").get(),
      ).toEqual({ name: "money_unit_policy" });
      for (const name of missingMoneyTables)
        expect(database.query("SELECT name FROM sqlite_schema WHERE name=?").get(name)).toBeNull();

      // These are structural SQL dependency probes only. Their sentinel JSON is
      // not a Financial original, Customer consent, H0 enrollment, or authority;
      // they establish that ordinary 0105's exact schema still has executable
      // Financial fences whose named Root Money dependencies are absent.
      const probes = [
        {
          table: "financial_retained_r1_originals",
          sql: `INSERT INTO financial_retained_r1_originals
            (r1_ref,challenge_ref,preparation_ref,receipt_ref,command_json,original_json,original_digest,terms_ref,terms_digest,source_registration_ref,source_registration_digest,source_incarnation,scope_json)
            VALUES('probe:r1','probe:challenge','probe:preparation','probe:receipt','{}','{"scopeRealm":{"writerEpoch":"probe:unselected"}}','probe:digest','probe:terms','probe:terms-digest','probe:source','probe:source-digest','probe:incarnation','{"writerEpoch":"probe:unselected"}')`,
        },
        {
          table: "financial_customer_admissions",
          sql: `INSERT INTO financial_customer_admissions
            (admission_ref,challenge_ref,grant_ref,issuance_attempt,expected_receipt_ref,organization_id,action_kind,action_ref,request_fingerprint,action_json,selection_json,terms_json,context_json,realm_json,customer_request_json,customer_fingerprint,stripe_key,created_at)
            VALUES('probe:admission','probe:challenge','probe:grant','probe:attempt','probe:receipt','probe:org','topup','probe:action','probe:fingerprint','{}','{}','{}','{}','{}','{}','probe:fingerprint','probe:key','2026-10-24T00:00:00.000Z')`,
        },
        {
          table: "financial_history_primary_roots",
          sql: `INSERT INTO financial_history_primary_roots
            (primary_ref,primary_incarnation,physical_binding_ref,physical_binding_incarnation,root_json)
            VALUES('probe:primary','probe:primary-inc','probe:binding','probe:binding-inc','{"primaryRef":"probe:primary","primaryIncarnation":"probe:primary-inc","physicalBindingRef":"probe:binding","physicalBindingIncarnation":"probe:binding-inc","writerEpoch":"probe:unselected"}')`,
        },
      ] as const;
      const beforeState = state(database, local);
      const beforeData = tableData(database);
      for (const probe of probes) {
        expect(
          database
            .query("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
            .get(`${probe.table}_money_fence`),
        ).toBeTruthy();
        expectMissingMoneyDependency(database, probe.sql);
        expect(count(database, probe.table)).toBe(0);
        expect(state(database, local)).toEqual(beforeState);
        expect(tableData(database)).toBe(beforeData);
      }
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);

test(
  "the 0105 guards refuse a foreign exact104 and a tampered 0105 artifact; a physical 0105 stays pending",
  () => {
    const root = sourceRoot("105");
    const source = readFinancial0104CanonicalMigrationSource(root);
    const { step104, step105 } = inputs(source, "ordinary");
    const database = ordinary103(source);
    try {
      run(database, composeFinancial0104ImportData(step104).sql);
      const local = readMigrationArtifact(resolve(root, "migrations")).names;
      expect(local).toEqual([...source.artifact105.names]);
      const at104 = state(database, local);
      // A physical 0105 leaves it pending for a normal exact104 Host.
      expect(financial0104SourceSchemaReady(at104, root, "normal")).toBe(false);
      expect(financial0104SourceSchemaReady(at104, root, "maintenance")).toBe(true);
      expect(financial0104LedgerApplied(local, at104.applied, root)).toBe(false);
      database.exec("CREATE TABLE foreign_successor_probe (id INTEGER PRIMARY KEY)");
      expect(() => run(database, composeFinancial0104ImportData(step105).sql)).toThrow();
      expect(count(database, "d1_migrations")).toBe(104);
      database.exec("DROP TABLE foreign_successor_probe");
      const file = source.artifact105.files[104];
      if (file === undefined) throw new Error("generated 0105 missing");
      const bytes = readFileSync(file.path);
      writeFileSync(file.path, Buffer.concat([Buffer.from("-- foreign\n"), bytes]));
      expect(() => composeFinancial0104ImportData(step105)).toThrow(
        "Root0105 import requires the exact Auth103 artifact plus 0104 and 0105",
      );
      expect(() => source.assertCurrent()).toThrow();
      writeFileSync(file.path, bytes);
      run(database, composeFinancial0104ImportData(step105).sql);
      const after = state(database, local);
      expect(financial0104SourceSchemaReady(after, root, "normal")).toBe(true);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);

test(
  "a thawed Money-preserved chain installs the Stripe customer guard generation with 0104 and keeps it through 0105",
  async () => {
    const root = sourceRoot("100");
    const source = readFinancial0104CanonicalMigrationSource(root);
    const { at104, step104, step105 } = inputs(source, "money-preserved");
    const database = moneyPreserved103(source, at104.prefixShape);
    const sql = createSqliteSql(database);
    try {
      const local = source.physicalNames;
      // Before 0104 the guard predates the generation: no Stripe fence is required...
      expect(await inspectMoneyCutoverGuard(sql, EPOCH)).toBe("ready");
      // ...and an early Stripe fence (without 0104's link table) is refused.
      const [early] = moneyCutoverStripeCustomerGuardDefinitions();
      if (early === undefined) throw new Error("missing Stripe definition");
      database.exec(early[1]);
      await expect(inspectMoneyCutoverGuard(sql, EPOCH)).rejects.toThrow(
        "money cutover Stripe customer fence predates its generation",
      );
      database.exec(`DROP TRIGGER ${early[0]}`);
      const import104 = composeFinancial0104ImportData(step104);
      expect(import104.sql).toContain(early[1]);
      run(database, import104.sql);
      for (const [name, definition] of moneyCutoverStripeCustomerGuardDefinitions())
        expect(database.query("SELECT sql FROM sqlite_schema WHERE name=?").get(name)).toEqual({
          sql: definition,
        });
      expect(moneyStripeCustomerGuardRows().map((row) => row.table)).toEqual(
        MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES.flatMap((table) => [table, table, table]),
      );
      const after104 = state(database, local);
      expect(financial0104SourceSchemaReady(after104, root, "normal", "money-preserved")).toBe(
        true,
      );
      expect(financial0104SourceSchemaReady(after104, root, "normal")).toBe(false);
      expect(await inspectMoneyCutoverGuard(sql, EPOCH)).toBe("ready");
      // Each Stripe fence refuses outside the Money frame.
      expect(() =>
        database.exec(
          "INSERT INTO stripe_billing_customers(org_id,customer_id,created_at) VALUES('org:x','cus_X','2026-10-15T00:00:00.000Z')",
        ),
      ).toThrow("money cutover writer permit required");
      run(database, composeFinancial0104ImportData(step105).sql);
      const after105 = state(database, local);
      expect(after105.applied).toEqual([...source.artifact105.names]);
      expect(financial0104SourceSchemaReady(after105, root, "normal", "money-preserved")).toBe(
        true,
      );
      expect(financial0104SourceSchemaReady(after105, root, "normal")).toBe(false);
      expect(await inspectMoneyCutoverGuard(sql, EPOCH)).toBe("ready");
      // With 0104's link table present, a missing or changed Stripe fence is refused.
      const [, second] = moneyCutoverStripeCustomerGuardDefinitions();
      if (second === undefined) throw new Error("missing Stripe definition");
      database.exec(`DROP TRIGGER ${second[0]}`);
      await expect(inspectMoneyCutoverGuard(sql, EPOCH)).rejects.toThrow(
        "money cutover Stripe customer trigger differs",
      );
      expect(
        financial0104SourceSchemaReady(state(database, local), root, "normal", "money-preserved"),
      ).toBe(false);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);

test(
  "a frozen Money-preserved exact104 refuses 0105",
  () => {
    const root = sourceRoot("100");
    const source = readFinancial0104CanonicalMigrationSource(root);
    const { at104, step104, step105 } = inputs(source, "money-preserved");
    const database = moneyPreserved103(source, at104.prefixShape);
    try {
      run(database, composeFinancial0104ImportData(step104).sql);
      database.exec(
        "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
      );
      expect(() => run(database, composeFinancial0104ImportData(step105).sql)).toThrow();
      expect(count(database, "d1_migrations")).toBe(104);
      database.exec("DELETE FROM money_cutover_freeze");
      run(database, composeFinancial0104ImportData(step105).sql);
      expect(count(database, "d1_migrations")).toBe(105);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);

test(
  "a Worker on a Money-preserved post-Auth103 primary reads its own money-preserved profile",
  async () => {
    const root = sourceRoot("100");
    const source = readFinancial0104CanonicalMigrationSource(root);
    const ordinaryTarget: DeployTarget = {
      kind: "takoserver.deploy-target@v2",
      environment: "integration",
      accountId: "a".repeat(32),
      workerName: "takoserver-api-integration-root0105",
      publicOrigin: "https://root0105.integration.example.test",
      d1: {
        databaseId: "00000000-0000-4000-8000-000000000105",
        databaseName: `integration-ts-${"5".repeat(32)}`,
      },
      r2: { bucketName: `integration-ts-${"5".repeat(32)}` },
      signing: { currentKeyId: "current" },
    };
    const moneyTarget: DeployTarget = {
      ...ordinaryTarget,
      moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
      moneyCutoverWriterEpoch: EPOCH,
      auth103NativeProfile: "root-shared-auth-staging-v1",
    };
    const { auth103NativeProfile: _profile, ...moneyWithoutAuthProfile } = moneyTarget;
    // Every parsed Money target carries the v2-0092 storage lineage, so the
    // Worker's storage proof reads the same primary before any schema check.
    const storageLineage = { config: "{}", storageLineage: "v2-0092" } as const;
    const moneyStorageTarget: DeployTarget = { ...moneyTarget, takoformV2: storageLineage };
    const storageProof = (target: DeployTarget, observed: ReturnType<typeof observe>) =>
      verifyFreshV2IntegrationStorageTarget(target, "integration", "v2-0092", {
        provider: {
          getD1: async () => ({ name: target.d1.databaseName, uuid: target.d1.databaseId }),
          getR2: async (name: string) => ({ name }),
        },
        reader: { read: async () => observed },
        migrationDirectory: resolve(root, "migrations"),
        allowCurrentAuditedSuccessor: true,
      });
    const observe = (database: Database) => ({
      ...state(database, source.physicalNames),
      moneyUnitPolicy: database
        .query<{ ledger_unit: string; historical_usage_unit: string; cash_unit: string }, []>(
          "SELECT ledger_unit,historical_usage_unit,cash_unit FROM money_unit_policy",
        )
        .all(),
    });
    // Refusal is a false result or the existing pending-migration preflight error.
    const refuses = (target: DeployTarget, observed: ReturnType<typeof observe>) => {
      try {
        return !workerSchemaAllowsPending(target, observed, root);
      } catch {
        return true;
      }
    };
    const preserved = inputs(source, "money-preserved");
    const ordinary = inputs(source, "ordinary");
    const moneyDatabase = moneyPreserved103(source, preserved.at104.prefixShape);
    const ordinaryDatabase = ordinary103(source);
    try {
      for (const step of [undefined, preserved.step104, preserved.step105]) {
        if (step !== undefined) run(moneyDatabase, composeFinancial0104ImportData(step).sql);
        const observed = observe(moneyDatabase);
        expect(workerMoneyUnitSchemaReady(observed, root)).toBe(true);
        expect(workerSchemaAllowsPending(moneyTarget, observed, root)).toBe(true);
        expect(await storageProof(moneyStorageTarget, observed)).toMatchObject({
          appliedMigrations: observed.applied,
        });
        await expect(
          storageProof({ ...moneyWithoutAuthProfile, takoformV2: storageLineage }, observed),
        ).rejects.toThrow();
        // Neither an ordinary target nor a Money target off the Auth103 lineage serves it.
        expect(refuses(ordinaryTarget, observed)).toBe(true);
        expect(
          workerSchemaAllowsPending(
            { ...moneyWithoutAuthProfile, takoformV2: storageLineage },
            observed,
            root,
          ),
        ).toBe(false);
      }
      // No Money cutover phase resumes past Auth103: its Stripe generation is
      // installed only by the Money-preserved 0104 import above.
      const audited = readCurrentAuditedMigrationSourceArtifact(resolve(root, "migrations")).files;
      for (const phase of [
        "0092",
        "0092-fenced",
        "0093",
        "0093-fenced",
        "0094",
        "0094-fenced",
        "0098",
        "0098-fenced",
      ] as const)
        expect(moneyUnitCutoverSchemaMatches(observe(moneyDatabase), audited, phase)).toBe(false);
      for (const step of [undefined, ordinary.step104, ordinary.step105]) {
        if (step !== undefined) run(ordinaryDatabase, composeFinancial0104ImportData(step).sql);
        const observed = observe(ordinaryDatabase);
        expect(workerMoneyUnitSchemaReady(observed, root)).toBe(true);
        expect(workerSchemaAllowsPending(ordinaryTarget, observed, root)).toBe(true);
        // The ordinary shape lacks Money's guards, so the Money writer is refused.
        expect(refuses(moneyTarget, observed)).toBe(true);
      }
      // A Money-preserved exact105 missing one Stripe customer fence qualifies neither check.
      const [first] = moneyCutoverStripeCustomerGuardDefinitions();
      if (first === undefined) throw new Error("missing Stripe definition");
      moneyDatabase.exec(`DROP TRIGGER ${first[0]}`);
      const missing = observe(moneyDatabase);
      expect(workerMoneyUnitSchemaReady(missing, root)).toBe(false);
      expect(refuses(moneyTarget, missing)).toBe(true);
      await expect(storageProof(moneyStorageTarget, missing)).rejects.toThrow();
    } finally {
      moneyDatabase.close();
      ordinaryDatabase.close();
      source.dispose();
    }
  },
  LONG,
);
