import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-native-source.ts";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { readFinancial0104CanonicalMigrationSource } from "../scripts/deploy/financial0104-canonical-source.ts";
import { FINANCIAL0104_MIGRATION_NAME } from "../scripts/deploy/financial0104-recipe.ts";
import {
  compileFinancial0104ImportShapes,
  compileRoot0105ImportShapes,
  compileRoot0106ImportShapes,
  financial0104SourceSchemaReady,
} from "../scripts/deploy/financial0104-schema-shape.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { readCurrentAuditedMigrationSourceArtifact } from "../scripts/deploy/schema.ts";
import {
  composeFinancial0104ImportData,
  type Financial0104ImportInput,
} from "../scripts/deploy/schema-financial0104-source.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { workerMoneyUnitSchemaReady, workerSchemaAllowsPending } from "../scripts/deploy/worker.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { FINANCIAL_0104_DDL } from "../src/financial-0104-source-contract.ts";
import { ROOT_0105_DDL } from "../src/root-0105-org-capture-triggers.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { createForwardWorkerNative106Recipe } from "../src/takoform-v2/forward-worker-native-schema.ts";
import { V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL } from "../src/takoform-v2/operation-generation-index.ts";

const ROOT = resolve(import.meta.dir, "..");
const LONG = 180_000;
const EPOCH = `sha256:${"e".repeat(64)}`;
const target: DeployTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration-root0106",
  publicOrigin: "https://root0106.integration.example.test",
  d1: {
    databaseId: "00000000-0000-4000-8000-000000000106",
    databaseName: `integration-ts-${"6".repeat(32)}`,
  },
  r2: { bucketName: `integration-ts-${"6".repeat(32)}` },
  signing: { currentKeyId: "current" },
};

function sourceRoot106(): string {
  const root = mkdtempSync(resolve(tmpdir(), "root0106-source-"));
  const directory = resolve(root, "migrations");
  mkdirSync(directory);
  mkdirSync(resolve(root, "src"));
  writeFileSync(
    resolve(root, "src/auth103-source-clock.ts"),
    readFileSync(resolve(ROOT, "src/auth103-source-clock.ts")),
  );
  for (const row of MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100))
    writeFileSync(resolve(directory, row.name), row.sql, { flag: "wx" });
  for (const row of createAuth103CanonicalSourceArtifacts(root).files)
    writeFileSync(resolve(directory, row.name), row.sql, { flag: "wx" });
  writeFileSync(resolve(directory, FINANCIAL0104_MIGRATION_NAME), FINANCIAL_0104_DDL, {
    flag: "wx",
  });
  writeFileSync(resolve(directory, "0105_root_org_history_capture.sql"), ROOT_0105_DDL, {
    flag: "wx",
  });
  const recipe = createForwardWorkerNative106Recipe();
  writeFileSync(
    resolve(directory, recipe.name),
    `${recipe.steps.flatMap((step) => step.statements).join("\n")}\n`,
    { flag: "wx" },
  );
  return root;
}

test(
  "only exact physical 0106 joins the registered post-Auth103 chain",
  () => {
    const root = sourceRoot106();
    try {
      const physical = readMigrationArtifact(resolve(root, "migrations"));
      expect(physical.files).toHaveLength(106);
      expect(
        readCurrentAuditedMigrationSourceArtifact(resolve(root, "migrations")).files,
      ).toHaveLength(100);
      const source = readFinancial0104CanonicalMigrationSource(root);
      try {
        expect(source.physicalNames).toEqual(physical.names);
        expect(source.artifactFor(106).names).toEqual(physical.names);
      } finally {
        source.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  LONG,
);

test(
  "foreign, missing, and byte-changed 0106 source is never registered",
  () => {
    for (const change of ["foreign", "missing-105", "tampered"] as const) {
      const root = sourceRoot106();
      try {
        const migration = resolve(root, "migrations", "0106_forward_worker_native_custody.sql");
        if (change === "foreign") {
          rmSync(migration);
          writeFileSync(resolve(root, "migrations", "0106_foreign.sql"), "SELECT 1;\n");
        } else if (change === "missing-105") {
          rmSync(resolve(root, "migrations", "0105_root_org_history_capture.sql"));
        } else {
          writeFileSync(migration, `-- changed\n${readFileSync(migration, "utf8")}`);
        }
        expect(() => readFinancial0104CanonicalMigrationSource(root)).toThrow();
        expect(() =>
          readCurrentAuditedMigrationSourceArtifact(resolve(root, "migrations")),
        ).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  LONG,
);

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
      .query<
        {
          type: string;
          name: string;
          tbl_name: string;
          sql: string;
        },
        []
      >(
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
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
  };
}

test(
  "exact 0105 advances to 0106 in one guarded local transaction and cannot replay",
  () => {
    const root = sourceRoot106();
    const source = readFinancial0104CanonicalMigrationSource(root);
    const database = new Database(":memory:", { strict: true });
    database.query("PRAGMA foreign_keys=ON").all();
    try {
      for (const [index, file] of source.auth103.files.slice(0, 100).entries())
        run(database, buildD1MigrationImport([file], { freshLedger: index === 0 }).sql);
      run(
        database,
        buildD1MigrationImport(source.auth103.files.slice(100), { freshLedger: false }).sql,
      );
      const at104 = compileFinancial0104ImportShapes(source.auth103, source.artifact, "ordinary");
      const at105 = compileRoot0105ImportShapes(
        source.auth103,
        source.artifact,
        source.artifact105,
        "ordinary",
      );
      const at106 = compileRoot0106ImportShapes(
        source.auth103,
        source.artifact,
        source.artifact105,
        source.artifact106,
        "ordinary",
      );
      const common = {
        registration: [
          source.auth103Recipes.registrationRef,
          source.auth103Recipes.recipeDigest,
          source.auth103Recipes.clockSourceDigest,
          source.auth103Recipes.clockPolicyRef,
        ] as const,
      };
      const input = (
        artifact: typeof source.artifact,
        shapes: Pick<typeof at104, "prefixShape" | "postShape" | "auth103Catalog">,
        predecessorAuth103CatalogJson?: string,
      ): Financial0104ImportInput => ({
        ...common,
        artifact,
        prefixShape: shapes.prefixShape,
        postShape: shapes.postShape,
        auth103CatalogJson: JSON.stringify(shapes.auth103Catalog),
        ...(predecessorAuth103CatalogJson === undefined ? {} : { predecessorAuth103CatalogJson }),
      });
      const import104 = composeFinancial0104ImportData(input(source.artifact, at104));
      const import105 = composeFinancial0104ImportData(input(source.artifact105, at105));
      const import106 = composeFinancial0104ImportData(
        input(source.artifact106, at106, JSON.stringify(at106.predecessorAuth103Catalog)),
      );
      expect(() => run(database, import106.sql)).toThrow();
      run(database, import104.sql);
      expect(() => run(database, import106.sql)).toThrow();
      run(database, import105.sql);
      const before = state(database, source.physicalNames);
      expect(before.applied).toEqual([...source.artifact105.names]);
      expect(financial0104SourceSchemaReady(before, root, "normal")).toBe(false);
      expect(financial0104SourceSchemaReady(before, root, "maintenance")).toBe(true);
      database.exec("CREATE TABLE foreign_forward106_probe(id INTEGER PRIMARY KEY)");
      expect(() => run(database, import106.sql)).toThrow();
      expect(state(database, source.physicalNames).applied).toHaveLength(105);
      database.exec("DROP TABLE foreign_forward106_probe");
      database.exec(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL);
      expect(() => run(database, import106.sql)).toThrow();
      database.exec("DROP INDEX tf_v2_operations_resource_generation");
      database.query("PRAGMA foreign_keys=OFF").all();
      expect(() => run(database, import106.sql)).toThrow();
      database.query("PRAGMA foreign_keys=ON").all();
      run(database, import106.sql);
      const after = state(database, source.physicalNames);
      expect(after.applied).toEqual([...source.artifact106.names]);
      expect(financial0104SourceSchemaReady(after, root, "normal")).toBe(true);
      expect(financial0104SourceSchemaReady(after, root, "normal", "money-preserved")).toBe(false);
      expect(workerSchemaAllowsPending(target, after, root)).toBe(true);
      expect(
        workerMoneyUnitSchemaReady(
          {
            ...after,
            moneyUnitPolicy: [
              {
                ledger_unit: "usd-micros-v2",
                historical_usage_unit: "microcent-v1",
                cash_unit: "usd-cents-v1",
              },
            ],
          },
          root,
        ),
      ).toBe(true);
      expect(() => run(database, import106.sql)).toThrow();
      expect(state(database, source.physicalNames).applied).toEqual(after.applied);
      database.exec("DROP INDEX tf_v2_operations_resource_generation");
      expect(
        financial0104SourceSchemaReady(state(database, source.physicalNames), root, "normal"),
      ).toBe(false);
      database.exec(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL);
      expect(
        financial0104SourceSchemaReady(state(database, source.physicalNames), root, "normal"),
      ).toBe(true);
      expect(database.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      database.close();
      source.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  LONG,
);

test(
  "thawed Money-preserved 0105 advances through exact 0106 without losing its fences",
  () => {
    const root = sourceRoot106();
    const source = readFinancial0104CanonicalMigrationSource(root);
    const at104 = compileFinancial0104ImportShapes(
      source.auth103,
      source.artifact,
      "money-preserved",
    );
    const at105 = compileRoot0105ImportShapes(
      source.auth103,
      source.artifact,
      source.artifact105,
      "money-preserved",
    );
    const at106 = compileRoot0106ImportShapes(
      source.auth103,
      source.artifact,
      source.artifact105,
      source.artifact106,
      "money-preserved",
    );
    const database = new Database(":memory:", { strict: true });
    try {
      const rows = (
        JSON.parse(at104.prefixShape) as { type: string; name: string; sql: string }[]
      ).filter(({ name }) => !name.startsWith("sqlite_"));
      for (const type of ["table", "index", "view", "trigger"])
        for (const row of rows.filter((candidate) => candidate.type === type))
          database.exec(row.sql);
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
      database.query("PRAGMA foreign_keys=ON").all();
      const common = {
        registration: [
          recipes.registrationRef,
          recipes.recipeDigest,
          recipes.clockSourceDigest,
          recipes.clockPolicyRef,
        ] as const,
        moneyWriterEpoch: EPOCH,
      };
      const input = (
        artifact: typeof source.artifact,
        shapes: Pick<typeof at104, "prefixShape" | "postShape" | "auth103Catalog">,
        predecessorAuth103CatalogJson?: string,
      ): Financial0104ImportInput => ({
        ...common,
        artifact,
        prefixShape: shapes.prefixShape,
        postShape: shapes.postShape,
        auth103CatalogJson: JSON.stringify(shapes.auth103Catalog),
        ...(predecessorAuth103CatalogJson === undefined ? {} : { predecessorAuth103CatalogJson }),
      });
      run(database, composeFinancial0104ImportData(input(source.artifact, at104)).sql);
      run(database, composeFinancial0104ImportData(input(source.artifact105, at105)).sql);
      const import106 = composeFinancial0104ImportData(
        input(source.artifact106, at106, JSON.stringify(at106.predecessorAuth103Catalog)),
      );
      database.exec(
        "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
      );
      expect(() => run(database, import106.sql)).toThrow();
      database.exec("DELETE FROM money_cutover_freeze");
      run(database, import106.sql);
      const after = state(database, source.physicalNames);
      expect(financial0104SourceSchemaReady(after, root, "normal", "money-preserved")).toBe(true);
      expect(financial0104SourceSchemaReady(after, root, "normal")).toBe(false);
      expect(
        workerSchemaAllowsPending(
          {
            ...target,
            moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
            moneyCutoverWriterEpoch: EPOCH,
            auth103NativeProfile: "root-shared-auth-staging-v1",
          },
          after,
          root,
        ),
      ).toBe(true);
      expect(
        workerMoneyUnitSchemaReady(
          {
            ...after,
            moneyUnitPolicy: [
              {
                ledger_unit: "usd-micros-v2",
                historical_usage_unit: "microcent-v1",
                cash_unit: "usd-cents-v1",
              },
            ],
          },
          root,
        ),
      ).toBe(true);
      expect(database.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      database.close();
      source.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  LONG,
);
