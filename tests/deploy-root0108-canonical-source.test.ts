import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { readFinancial0104CanonicalMigrationSource } from "../scripts/deploy/financial0104-canonical-source.ts";
import {
  compileFinancial0104ImportShapes,
  compileRoot0105ImportShapes,
  compileRoot0106ImportShapes,
  compileRoot0107ImportShapes,
  compileRoot0108ImportShapes,
  financial0104SourceSchemaReady,
} from "../scripts/deploy/financial0104-schema-shape.ts";
import { canonicalSchemaShape } from "../scripts/deploy/migrations.ts";
import { isPostAuth103RecipeSuffix } from "../scripts/deploy/post-auth103-recipes.ts";
import { root0107Recipe } from "../scripts/deploy/root0107-recipe.ts";
import { root0108Recipe } from "../scripts/deploy/root0108-recipe.ts";
import {
  composeFinancial0104ImportData,
  type Financial0104ImportInput,
} from "../scripts/deploy/schema-financial0104-source.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { workerSchemaAllowsPending } from "../scripts/deploy/worker.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

const ROOT = resolve(import.meta.dir, "..");
const LONG = 180_000;
const target: DeployTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "history-schema-test",
  publicOrigin: "https://history-schema.example.test",
  d1: {
    databaseId: "00000000-0000-4000-8000-000000000108",
    databaseName: `integration-ts-${"8".repeat(32)}`,
  },
  r2: { bucketName: `integration-ts-${"8".repeat(32)}` },
  signing: { currentKeyId: "current" },
};

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

test(
  "registered 0108 preserves every prior artifact and refuses changed successor bytes",
  () => {
    const source = readFinancial0104CanonicalMigrationSource(ROOT);
    try {
      expect(source.artifact108.files).toHaveLength(108);
      expect(source.artifact108.files.slice(0, 107).map(({ digest }) => digest)).toEqual(
        source.artifact107.files.map(({ digest }) => digest),
      );
      expect(source.artifact108.files.slice(0, 103).map(({ digest }) => digest)).toEqual(
        source.auth103.files.map(({ digest }) => digest),
      );
      expect(source.artifactFor(108)).toBe(source.artifact108);
      expect(root0107Recipe().digest).toBe(
        "sha256:274fd5f006e2bc83a38deb3c48af853e5e329d0cf1b412c22a0e695e2b70ddb4",
      );
      expect(source.artifact108.files[107]?.digest).toBe(root0108Recipe().digest);
      expect(isPostAuth103RecipeSuffix(source.artifact108.files.slice(103))).toBe(true);
      const last = source.artifact108.files[107];
      if (!last) throw new Error("missing generated successor");
      const bytes = readFileSync(last.path);
      try {
        writeFileSync(last.path, "SELECT 1;\n");
        expect(isPostAuth103RecipeSuffix(source.artifact108.files.slice(103))).toBe(false);
        expect(() => source.assertCurrent()).toThrow();
      } finally {
        writeFileSync(last.path, bytes);
      }
      source.assertCurrent();
    } finally {
      source.dispose();
    }
  },
  LONG,
);

for (const profile of ["ordinary", "money-preserved"] as const) {
  test(
    `0108 adds only history exclusions and preserves the ${profile} predecessor`,
    () => {
      const source = readFinancial0104CanonicalMigrationSource(ROOT);
      try {
        const before = compileRoot0107ImportShapes(
          source.auth103,
          source.artifact,
          source.artifact105,
          source.artifact106,
          source.artifact107,
          profile,
        );
        const after = compileRoot0108ImportShapes(
          source.auth103,
          source.artifact,
          source.artifact105,
          source.artifact106,
          source.artifact107,
          source.artifact108,
          profile,
        );
        expect(after.prefixShape).toBe(before.postShape);
        expect(after.auth103Catalog).toEqual(before.auth103Catalog);
        expect(after.financialCatalog).toEqual(before.financialCatalog);
        const prior = new Map(
          (JSON.parse(before.postShape) as { type: string; name: string }[]).map((row) => [
            `${row.type}/${row.name}`,
            row,
          ]),
        );
        const added = [];
        for (const row of JSON.parse(after.postShape) as { type: string; name: string }[]) {
          const key = `${row.type}/${row.name}`;
          const previous = prior.get(key);
          if (previous !== undefined) {
            expect(row).toEqual(previous);
            prior.delete(key);
          } else added.push(row);
        }
        expect(prior.size).toBe(0);
        expect(added).toHaveLength(10);
        expect(added.filter((row) => row.type === "table").map((row) => row.name)).toEqual([
          "shared_app_staging_origin_history",
        ]);
        expect(added.filter((row) => row.type === "trigger")).toHaveLength(9);
      } finally {
        source.dispose();
      }
    },
    LONG,
  );
}

test(
  "only exact107 can install108 once, without importing or rewriting any predecessor origins",
  () => {
    const source = readFinancial0104CanonicalMigrationSource(ROOT);
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
      const at107 = compileRoot0107ImportShapes(
        source.auth103,
        source.artifact,
        source.artifact105,
        source.artifact106,
        source.artifact107,
        "ordinary",
      );
      const at108 = compileRoot0108ImportShapes(
        source.auth103,
        source.artifact,
        source.artifact105,
        source.artifact106,
        source.artifact107,
        source.artifact108,
        "ordinary",
      );
      const recipes = source.auth103Recipes;
      const input = (
        artifact: typeof source.artifact,
        shape: Pick<typeof at104, "prefixShape" | "postShape" | "auth103Catalog">,
        predecessorAuth103CatalogJson?: string,
      ): Financial0104ImportInput => ({
        artifact,
        prefixShape: shape.prefixShape,
        postShape: shape.postShape,
        auth103CatalogJson: JSON.stringify(shape.auth103Catalog),
        registration: [
          recipes.registrationRef,
          recipes.recipeDigest,
          recipes.clockSourceDigest,
          recipes.clockPolicyRef,
        ],
        ...(predecessorAuth103CatalogJson === undefined ? {} : { predecessorAuth103CatalogJson }),
      });
      run(database, composeFinancial0104ImportData(input(source.artifact, at104)).sql);
      run(database, composeFinancial0104ImportData(input(source.artifact105, at105)).sql);
      run(
        database,
        composeFinancial0104ImportData(
          input(source.artifact106, at106, JSON.stringify(at106.predecessorAuth103Catalog)),
        ).sql,
      );
      const migration = composeFinancial0104ImportData(input(source.artifact108, at108));
      expect(() => run(database, migration.sql)).toThrow();
      run(database, composeFinancial0104ImportData(input(source.artifact107, at107)).sql);
      database.exec(`INSERT INTO shared_app_staging_assignments
      (incarnation,name,organization_id,product,reservation_id,generation,state,created_at,updated_at)
      VALUES ('${"a".repeat(32)}','kept-app','org-one','takoserver','prior-reservation',1,'reserved',1,1)`);
      const retained = database.query("SELECT * FROM shared_app_staging_assignments").all();
      database.exec("CREATE TEMP TABLE shared_app_staging_origin_history(id INTEGER)");
      expect(() => run(database, migration.sql)).toThrow();
      database.exec("DROP TABLE temp.shared_app_staging_origin_history");
      run(database, migration.sql);
      expect(
        database.query("SELECT count(*) AS n FROM shared_app_staging_origin_history").get(),
      ).toEqual({ n: 0 });
      expect(database.query("SELECT * FROM shared_app_staging_assignments").all()).toEqual(
        retained,
      );
      expect(database.query("SELECT count(*) AS n FROM d1_migrations").get()).toEqual({ n: 108 });
      expect(() => run(database, migration.sql)).toThrow();
      const shape = canonicalSchemaShape(
        database
          .query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
            "SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
          )
          .all(),
      );
      const state = {
        local: source.physicalNames,
        applied: source.artifact108.names,
        shape,
        shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
      };
      expect(financial0104SourceSchemaReady(state, ROOT, "normal")).toBe(true);
      expect(workerSchemaAllowsPending(target, state, ROOT)).toBe(true);
      expect(() =>
        workerSchemaAllowsPending({ ...target, environment: "production" }, state, ROOT),
      ).toThrow();
      database.exec("DROP TRIGGER shared_app_staging_origin_history_no_delete");
      const tamperedShape = canonicalSchemaShape(
        database
          .query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
            "SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
          )
          .all(),
      );
      expect(
        financial0104SourceSchemaReady(
          {
            ...state,
            shape: tamperedShape,
            shapeDigest: `sha256:${createHash("sha256").update(tamperedShape).digest("hex")}`,
          },
          ROOT,
          "normal",
        ),
      ).toBe(false);
    } finally {
      database.close();
      source.dispose();
    }
  },
  LONG,
);
