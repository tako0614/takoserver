import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createOrdinaryFinancialPublicSql } from "../src/ordinary-financial-public-sql.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2ContainerHostAcceptance } from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const prefix = "WITH host_form_admission AS (SELECT 1 AS permitted";

function fixture(grammar: "ordinary" | "retained-container" = "retained-container") {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
  return {
    database,
    sql: createOrdinaryFinancialPublicSql(createSqliteSql(database), grammar),
  };
}

test("only retained top-level engine wrapper gains the existing direct INSERT syntax", async () => {
  const retained = fixture();
  for (const [index, admission] of ["", " WHERE (EXISTS (SELECT 1 WHERE ? = 1))"].entries()) {
    const statement = `${prefix}${admission}) INSERT OR ABORT INTO main.orgs(id) SELECT ? FROM host_form_admission RETURNING id`;
    const params = admission ? [1, `row-${index}`] : [`row-${index}`];
    expect((await retained.sql.batch([{ sql: statement, params }]))[0]).toEqual({
      changes: 1,
      rows: [{ id: `row-${index}` }],
    });
    const ordinary = fixture("ordinary");
    await expect(ordinary.sql.batch([{ sql: statement, params }])).rejects.toThrow(
      "INSERT conflict mode",
    );
  }
});

test("admission expression and original parameters remain effective, not replaced by true", async () => {
  const f = fixture();
  const statement = `${prefix} WHERE (? = 1 AND ')' != '(' AND 'DELETE' = 'DELETE')) INSERT OR ABORT INTO main.orgs(id) SELECT ? FROM host_form_admission RETURNING id`;
  expect((await f.sql.batch([{ sql: statement, params: [0, "refused"] }]))[0]?.changes).toBe(0);
  expect((await f.sql.batch([{ sql: statement, params: [1, "kept"] }]))[0]?.rows).toEqual([
    { id: "kept" },
  ]);
  expect(f.database.query("SELECT id FROM orgs").all()).toEqual([{ id: "kept" }]);
});

test("other CTEs, quoted prefix tokens and write-shaped predicates gain no retained exception", async () => {
  const f = fixture();
  for (const wrapper of [
    "WITH other AS (SELECT 1 AS permitted)",
    "WITH RECURSIVE host_form_admission AS (SELECT 1 AS permitted)",
    "WITH host_form_admission AS (SELECT '1' AS permitted)",
    'WITH "host_form_admission" AS (SELECT 1 AS permitted)',
    "WITH host_form_admission AS (SELECT 1 AS 'permitted')",
    "WITH host_form_admission AS (SELECT 1 AS permitted UNION SELECT 1)",
    `${prefix}), extra AS (SELECT 1)`,
    `${prefix} WHERE (1) OR (1))`,
    `${prefix} WHERE (EXISTS (DELETE FROM orgs RETURNING id)))`,
    `${prefix} WHERE (PRAGMA table_info(orgs)))`,
    `${prefix} WHERE ())`,
    `${prefix} WHERE (1)`,
  ])
    await expect(
      f.sql.batch([{ sql: `${wrapper} INSERT OR ABORT INTO main.orgs(id) VALUES('bad')` }]),
    ).rejects.toThrow("ordinary public SQL refused");
  expect(f.database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
});

test("wrapper still fences protected targets and trigger bodies", async () => {
  const f = fixture();
  f.database.exec("CREATE TABLE financial_source_events(id TEXT PRIMARY KEY)");
  await expect(
    f.sql.batch([
      { sql: `${prefix}) INSERT OR ABORT INTO main.financial_source_events(id) VALUES('bad')` },
    ]),
  ).rejects.toThrow("protected write");
  f.database.exec(`CREATE TABLE stages(id TEXT);
    CREATE TRIGGER no_bypass AFTER INSERT ON orgs BEGIN
      INSERT OR ABORT INTO stages(id) VALUES(NEW.id);
    END;`);
  await expect(
    f.sql.batch([{ sql: `${prefix}) INSERT OR ABORT INTO main.orgs(id) VALUES('bad')` }]),
  ).rejects.toThrow("INSERT conflict mode");
  expect(f.database.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 0 });
});

function engine(sql: Sql, retained: boolean) {
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "test-container-backend",
      targetKey: "test-container-target",
      async execute() {
        return { kind: "no_effect", code: "fixture_no_effect", message: "No native effect" };
      },
      async reconcile() {
        return { kind: "no_effect", code: "fixture_no_effect", message: "No native effect" };
      },
    },
  };
  return createTakoformV2Engine(
    {
      sql,
      replayWindowSeconds: 120,
      now: () => new Date("2026-10-16T00:00:00.000Z"),
      async authorize(principal, space) {
        return principal === "container-owner-test" && space === "default";
      },
      forms: retained ? {} : { [CONTAINER_CONTRACT.formUrl]: form },
      ...(retained ? { retainedForms: { [CONTAINER_CONTRACT.formUrl]: form } } : {}),
    },
    createV2ContainerHostAcceptance({
      sql,
      installationId: "test-installation",
      backendId: "test-container-backend",
      targetKey: "test-container-target",
    }),
  );
}

test("actual retained engine DELETE keeps the store wrapper and original terminal on local SQLite", async () => {
  const database = new Database(":memory:");
  databases.push(database);
  migrateSqlite(database);
  const base = createSqliteSql(database);
  await base.batch(v2ContainerOwnerMigrationCandidate());
  const setup = engine(base, false);
  const created = await setup.acceptCreate({
    principal: "container-owner-test",
    key: "financial-wrapper-create-original",
    input: {
      form: CONTAINER_CONTRACT.formUrl,
      space: "default",
      name: "retained",
      spec: {
        image: `registry.example/image@sha256:${"d".repeat(64)}`,
        httpPort: 8080,
        healthPath: "/",
        workloadRevision: "r1",
        requiredSensitiveVars: [],
        outboundInternet: true,
      },
    },
  });
  expect((await setup.runNext())?.status).toBe("failed");
  const batches: (readonly SqlStatement[])[] = [];
  const sql = createOrdinaryFinancialPublicSql(
    {
      query: base.query,
      run: base.run,
      async batch(statements) {
        batches.push(statements);
        return base.batch(statements);
      },
    },
    "retained-container",
  );
  const retained = engine(sql, true);
  const deleted = await retained.acceptDelete({
    principal: "container-owner-test",
    key: "financial-wrapper-delete-original",
    uid: created.resourceUid,
    expectedGeneration: 1,
  });
  expect(deleted.generation).toBe(2);
  const terminal = batches.flat().filter((statement) => statement.sql.startsWith(prefix));
  expect(terminal).toHaveLength(1);
  expect(terminal[0]?.sql).toContain(") INSERT OR ABORT INTO main.tf_v2_container_acceptances");
  expect(
    database
      .query("SELECT action, generation FROM tf_v2_container_acceptances ORDER BY generation")
      .all(),
  ).toEqual([
    { action: "create", generation: 1 },
    { action: "delete", generation: 2 },
  ]);
  // Acceptance only: no retained backend execution, native DELETE or live authority.
});
