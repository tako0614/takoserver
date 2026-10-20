import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEPLOY_CONTRACT } from "../scripts/deploy/contract.ts";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  buildFreshMoneyPreservedPreEpochImport,
  composeFreshMoneyPreservedImport,
  FRESH_MONEY_WRITER_EPOCH_OWNER_UNAVAILABLE,
  FRESH_MONEY_WRITER_EPOCH_RECORD_FILE,
  freshMoneyPreservedRealmClaim,
} from "../scripts/deploy/fresh-money-preserved.ts";
import {
  appendFreshStripeRealmClaim,
  buildFreshStripeRealmClaim,
} from "../scripts/deploy/fresh-stripe-realm-claim.ts";
import {
  assertFreshV2DataReadback,
  FRESH_V2_INTERRUPTED_MONEY_PRESERVED,
  FRESH_V2_MONEY_WRITER_EPOCH_MISMATCH,
  type FreshV2DataReadback,
} from "../scripts/deploy/fresh-v2-data-readback.ts";
import {
  type IntegrationStorageGenerationProcess,
  isGeneratedIntegrationStorageTarget,
  runIntegrationStorageGeneration,
} from "../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape } from "../scripts/deploy/migrations.ts";
import {
  type FreshMoneyWriterEpochBinding,
  type FreshMoneyWriterEpochRecord,
  mintFreshMoneyWriterEpoch,
} from "../scripts/deploy/money-fresh-writer-epoch.ts";
import {
  projectFreshIntegrationV2MigrationArtifact0100,
  readCurrentAuditedMigrationSourceArtifact,
} from "../scripts/deploy/schema.ts";
import {
  moneyPost100ExpectedPreservedShape,
  moneyPost100PreservedFreshImportSegments,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { inspectMoneyCutoverGuard } from "../src/money-cutover-sql.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

/**
 * The staging-only fresh Money-preserved 0100 lineage: one sealed import of
 * the Money-owned preserved replay, Financial's test realm claim over that
 * replay's inventory, then one Writer epoch row minted for the new D1 only.
 */

const MIGRATIONS = resolve(import.meta.dir, "../migrations");
const ROOT = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "takoserver-staging-d1-0100mp-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const files = projectFreshIntegrationV2MigrationArtifact0100(
  readCurrentAuditedMigrationSourceArtifact(MIGRATIONS),
).files;
const preEpoch = buildFreshMoneyPreservedPreEpochImport(files);
const replay = moneyPost100PreservedFreshImportSegments(files).join("\n");
const claim = freshMoneyPreservedRealmClaim(replay);
const PLAIN_0100_IMPORT_DIGEST =
  "sha256:1e9c81545ecb4d376693f7016a60911426dbdde46c8433386d3ac1f771c614ab";
const GENERATION = "d".repeat(32);
const NAME = `integration-takoserver-${GENERATION}`;
const DATABASE_ID = "00000000-0000-4000-8000-0000000001a0";
const ACCOUNT = "b".repeat(32);
const PRODUCTION_D1 = {
  databaseName: "takoserver-runtime",
  databaseId: "85c5a15d-a80f-42fe-a907-7ec0d86e008e",
} as const;
const binding: FreshMoneyWriterEpochBinding = {
  accountId: ACCOUNT,
  databaseId: DATABASE_ID,
  databaseName: NAME,
  generation: GENERATION,
};

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: ACCOUNT,
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000001",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://takoserver-api-integration.example.workers.dev",
  signing: { currentKeyId: "integration-current" },
} satisfies DeployTarget;

function execute(database: Database, sql: string): void {
  for (const statement of frameHostMigrationSql(sql)) database.query(statement).all();
}

function count(database: Database, sql: string): number {
  return (database.query(sql).get() as { n: number }).n;
}

function localState(database: Database) {
  const hasLedger =
    count(database, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'd1_migrations'") === 1;
  const applied = hasLedger
    ? (
        database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
      ).map((row) => row.name)
    : [];
  const shape = canonicalSchemaShape(
    database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[],
  );
  return {
    applied,
    shape,
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
  };
}

function localData(database: Database): FreshV2DataReadback {
  const tables = (
    database
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'd1_migrations' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const rows = (sql: string) => database.query(sql).all() as Record<string, unknown>[];
  return {
    tableCounts: Object.fromEntries(
      tables.map((name) => [name, count(database, `SELECT COUNT(*) AS n FROM "${name}"`)]),
    ),
    ledgerRows: count(database, "SELECT COUNT(*) AS n FROM d1_migrations"),
    foreignKeyViolations: rows("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").length,
    invocationEpoch: rows(
      "SELECT singleton, epoch_id, state, opened_at_ms, closed_at_ms FROM tf_cloudflare_provider_invocation_epoch LIMIT 2",
    ),
    acceptanceCounter: rows(
      "SELECT id, last_order, last_operation_id FROM tf_v2_operation_acceptance_counter LIMIT 2",
    ),
    moneyUnitPolicy: rows(
      "SELECT singleton, ledger_unit, historical_usage_unit, cash_unit FROM money_unit_policy LIMIT 2",
    ),
    stripeRealm: rows("SELECT singleton, mode, pinned_at FROM stripe_mode_realm LIMIT 2"),
    authorizedEpoch: rows(
      "SELECT singleton, writer_epoch FROM money_cutover_authorized_epoch LIMIT 2",
    ),
  };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("fresh Money-preserved 0100 import", () => {
  test("the pre-epoch import is the Money replay plus Financial's claim over 72 tables", () => {
    expect(preEpoch.sql).toBe(`${replay}\n${claim.sql}`);
    expect(preEpoch.historyTables).toEqual(claim.historyTables);
    expect(claim.historyTables).toHaveLength(72);
    expect(preEpoch.shape).toBe(moneyPost100ExpectedPreservedShape(files));
  });

  test("the plain v2-0100 composed import digest is unchanged", () => {
    const plain = appendFreshStripeRealmClaim(
      buildD1MigrationImport(files, { freshLedger: true }),
      buildFreshStripeRealmClaim(files),
    );
    expect(plain.digest).toBe(PLAIN_0100_IMPORT_DIGEST);
    expect(buildFreshStripeRealmClaim(files).historyTables).toHaveLength(69);
  });

  test("the sealed import yields the exact preserved shape, one test pin and one Writer epoch", async () => {
    const record = mintFreshMoneyWriterEpoch(binding);
    const sealed = composeFreshMoneyPreservedImport(preEpoch, record);
    expect(sealed.sql.startsWith(`${preEpoch.sql}\n`)).toBe(true);
    const database = new Database(":memory:");
    try {
      execute(database, sealed.sql);
      const state = localState(database);
      expect(state.applied).toHaveLength(100);
      expect(state.applied.at(-1)).toBe("0100_hosted_on_demand.sql");
      await expect(
        assertFreshV2DataReadback(
          "verification",
          "v2-0100-money-preserved",
          "/private/wrangler.jsonc",
          {},
          preEpoch.shape,
          {
            freshV2DataReader: { read: async () => localData(database) },
            moneyWriterEpoch: { record, binding },
          },
        ),
      ).resolves.toBeUndefined();
      expect(database.query("SELECT singleton, mode FROM stripe_mode_realm").all()).toEqual([
        { singleton: 1, mode: "test" },
      ]);
      expect(
        database.query("SELECT singleton, writer_epoch FROM money_cutover_authorized_epoch").all(),
      ).toEqual([{ singleton: 1, writer_epoch: record.epoch }]);
      expect(count(database, "SELECT COUNT(*) AS n FROM money_cutover_freeze")).toBe(0);
      expect(count(database, "SELECT COUNT(*) AS n FROM money_cutover_writer_permit")).toBe(0);
      // The selected Money writer with exactly this epoch would start on it.
      expect(await inspectMoneyCutoverGuard(createSqliteSql(database), record.epoch)).toBe("ready");
      await expect(
        inspectMoneyCutoverGuard(createSqliteSql(database), `sha256:${"0".repeat(64)}`),
      ).rejects.toThrow();
    } finally {
      database.close();
    }
  });

  test("an existing live or test pin, a history row, an extra financial table or an early epoch roll the whole import back", () => {
    const record = mintFreshMoneyWriterEpoch(binding);
    const epochSql = composeFreshMoneyPreservedImport(preEpoch, record).sql.slice(
      preEpoch.sql.length + 1,
    );
    const refusals: ((db: Database) => void)[] = [
      (db) =>
        execute(
          db,
          "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at) VALUES (1, 'live', '2026-01-01T00:00:00.000Z');",
        ),
      // Even an existing test pin refuses: only this import's own INSERT may pin.
      (db) =>
        execute(
          db,
          "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at) VALUES (1, 'test', '2026-01-01T00:00:00.000Z');",
        ),
      (db) =>
        execute(
          db,
          "INSERT INTO idempotency (scope_key, fingerprint, status, body_json, expires_at) VALUES ('scope', 'fingerprint', 200, NULL, 0);",
        ),
      (db) => execute(db, "CREATE TABLE wallet_unclassified_history (id INTEGER PRIMARY KEY);"),
      (db) =>
        execute(
          db,
          `INSERT INTO money_cutover_authorized_epoch (singleton, writer_epoch) VALUES (1, '${record.epoch}');`,
        ),
    ];
    for (const before of refusals) {
      const database = new Database(":memory:");
      try {
        database.exec("BEGIN");
        expect(() => {
          execute(database, replay);
          before(database);
          execute(database, claim.sql);
          execute(database, epochSql);
        }).toThrow();
        database.exec("ROLLBACK");
        expect(
          count(database, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'"),
        ).toBe(0);
      } finally {
        database.close();
      }
    }
  });

  test("the data proof names an interrupted import and requires the minted epoch", async () => {
    const record = mintFreshMoneyWriterEpoch(binding);
    const database = new Database(":memory:");
    try {
      execute(database, composeFreshMoneyPreservedImport(preEpoch, record).sql);
      const exact = localData(database);
      const proof = (readback: FreshV2DataReadback, mint = record) =>
        assertFreshV2DataReadback(
          "verification",
          "v2-0100-money-preserved",
          "/private/wrangler.jsonc",
          {},
          preEpoch.shape,
          {
            freshV2DataReader: { read: async () => readback },
            moneyWriterEpoch: { record: mint, binding },
          },
        );
      await expect(proof(exact)).resolves.toBeUndefined();
      // Status holds no record: a well-formed single epoch is all it can see.
      await expect(
        assertFreshV2DataReadback(
          "preflight",
          "v2-0100-money-preserved",
          "/private/wrangler.jsonc",
          {},
          preEpoch.shape,
          { freshV2DataReader: { read: async () => exact } },
        ),
      ).resolves.toBeUndefined();
      for (const interrupted of [
        {
          ...exact,
          stripeRealm: [],
          authorizedEpoch: [],
          tableCounts: {
            ...exact.tableCounts,
            stripe_mode_realm: 0,
            money_cutover_authorized_epoch: 0,
          },
        },
        {
          ...exact,
          authorizedEpoch: [],
          tableCounts: { ...exact.tableCounts, money_cutover_authorized_epoch: 0 },
        },
      ])
        await expect(proof(interrupted)).rejects.toThrow(FRESH_V2_INTERRUPTED_MONEY_PRESERVED);
      await expect(proof(exact, mintFreshMoneyWriterEpoch(binding))).rejects.toThrow(
        FRESH_V2_MONEY_WRITER_EPOCH_MISMATCH,
      );
      for (const tableCounts of [
        { ...exact.tableCounts, money_cutover_freeze: 1 },
        { ...exact.tableCounts, money_cutover_writer_permit: 1 },
        { ...exact.tableCounts, ledger: 1 },
      ])
        await expect(proof({ ...exact, tableCounts })).rejects.toThrow("exact empty 0100 database");
      await expect(
        assertFreshV2DataReadback(
          "verification",
          "v2-0100-money-preserved",
          "/private/wrangler.jsonc",
          {},
          preEpoch.shape,
          { freshV2DataReader: { read: async () => exact } },
        ),
      ).rejects.toThrow("retained mint");
    } finally {
      database.close();
    }
  });
});

describe("v2-0100-money-preserved storage generation", () => {
  function trapProvider(calls: { count: number }) {
    const trap = async (): Promise<never> => {
      calls.count += 1;
      throw new Error("no provider call is allowed");
    };
    return { listD1: trap, getD1: trap, createD1: trap, listR2: trap, getR2: trap, createR2: trap };
  }

  function sourceRun(onImport: (path: string) => void): IntegrationStorageGenerationProcess {
    return async (command) => {
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(`${"c".repeat(40)}\n`);
      if (key === "git branch --show-current") return ok("staging-d1-test\n");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
      if (key === "bun run check:migrations") return ok("green\n");
      if (command.includes("execute") && command.includes("--file")) {
        onImport(command[command.indexOf("--file") + 1] as string);
        return ok("imported\n");
      }
      throw new Error(`unexpected command ${key}`);
    };
  }

  const invocation = {
    action: "apply",
    environment: "integration",
    commit: "c".repeat(40),
    generation: GENERATION,
    freshLineage: "v2-0100-money-preserved",
  } as const;

  test("apply without the production target or the epoch owner is refused before any provider call", async () => {
    const calls = { count: 0 };
    const imports: string[] = [];
    await expect(
      runIntegrationStorageGeneration(invocation, target, {
        provider: trapProvider(calls),
        run: sourceRun((path) => imports.push(path)),
        review: "test-review",
      }),
    ).rejects.toThrow("requires TAKOSERVER_DEPLOY_TARGET_PRODUCTION");
    await expect(
      runIntegrationStorageGeneration(invocation, target, {
        provider: trapProvider(calls),
        run: sourceRun((path) => imports.push(path)),
        review: "test-review",
        productionD1: PRODUCTION_D1,
        freshMoneyWriterEpoch: undefined,
      }),
    ).rejects.toThrow(FRESH_MONEY_WRITER_EPOCH_OWNER_UNAVAILABLE);
    expect(calls.count).toBe(0);
    expect(imports).toEqual([]);
  });

  test("the epoch is minted after the identity readback and sealed into the one import", async () => {
    const database = new Database(":memory:");
    const output = mkdtempSync(join(ROOT, "apply-"));
    const order: string[] = [];
    let created = false;
    let bucket = false;
    let minted: FreshMoneyWriterEpochRecord | null = null;
    try {
      const provider = {
        async listD1(name: string) {
          return created ? [{ name, uuid: DATABASE_ID }] : [];
        },
        async getD1() {
          order.push("getD1");
          return { name: NAME, uuid: DATABASE_ID };
        },
        async createD1(name: string) {
          order.push("createD1");
          created = true;
          return { name, uuid: DATABASE_ID };
        },
        async listR2(name: string) {
          return bucket ? [{ name }] : [];
        },
        async getR2(name: string) {
          return { name };
        },
        async createR2(name: string) {
          order.push("createR2");
          bucket = true;
          return { name };
        },
      };
      let importedSql = "";
      const result = await runIntegrationStorageGeneration(invocation, target, {
        provider,
        run: sourceRun((path) => {
          order.push("import");
          importedSql = readFileSync(path, "utf8");
          execute(database, importedSql);
        }),
        review: "test-review",
        productionD1: PRODUCTION_D1,
        outputDirectory: output,
        reader: { read: async () => localState(database) },
        freshV2DataReader: { read: async () => localData(database) },
        freshMoneyWriterEpoch: (selected) => {
          order.push("mint");
          expect(selected).toEqual(binding);
          minted = mintFreshMoneyWriterEpoch(selected);
          return minted;
        },
      });
      expect(order).toEqual(["createD1", "getD1", "mint", "import", "getD1", "createR2"]);
      if (minted === null) throw new Error("no epoch minted");
      const record = minted as FreshMoneyWriterEpochRecord;
      expect(importedSql).toBe(composeFreshMoneyPreservedImport(preEpoch, record).sql);
      expect(result).toMatchObject({
        freshLineage: "v2-0100-money-preserved",
        migrationImportDigest: composeFreshMoneyPreservedImport(preEpoch, record).digest,
        stripeRealmClaim: { mode: "test", historyTables: 72 },
        moneyPreserved: {
          epochBindingDigest: record.bindingDigest,
          shapeDigest: preEpoch.shapeDigest,
        },
      });
      expect(Object.keys(result.moneyPreserved as object).sort()).toEqual([
        "epochBindingDigest",
        "shapeDigest",
      ]);
      // The nonce never reaches the result; the private record reproduces it.
      expect(JSON.stringify(result)).not.toContain(record.nonce);
      const retained = result.moneyWriterEpochRecord as { path: string; digest: string };
      expect(retained.path).toBe(join(output, "money-fresh-writer-epoch.json"));
      expect(statSync(retained.path).mode & 0o777).toBe(0o600);
      const bytes = readFileSync(retained.path);
      expect(retained.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      expect(JSON.parse(bytes.toString("utf8"))).toEqual(record);
    } finally {
      database.close();
    }
  }, 60_000);

  test("a minted epoch for another D1 is refused before any import", async () => {
    const imports: string[] = [];
    let created = false;
    const provider = {
      async listD1(name: string) {
        return created ? [{ name, uuid: DATABASE_ID }] : [];
      },
      async getD1() {
        return { name: NAME, uuid: DATABASE_ID };
      },
      async createD1(name: string) {
        created = true;
        return { name, uuid: DATABASE_ID };
      },
      async listR2() {
        return [];
      },
      async getR2(name: string) {
        return { name };
      },
      async createR2(): Promise<never> {
        throw new Error("no R2 after a refused epoch");
      },
    };
    await expect(
      runIntegrationStorageGeneration(invocation, target, {
        provider,
        run: sourceRun((path) => imports.push(path)),
        review: "test-review",
        productionD1: PRODUCTION_D1,
        reader: { read: async () => ({ applied: [], shape: "[]\n", shapeDigest: "" }) },
        freshMoneyWriterEpoch: () =>
          mintFreshMoneyWriterEpoch({
            ...binding,
            databaseId: "00000000-0000-4000-8000-0000000001a1",
          }),
      }),
    ).rejects.toThrow("belongs to another D1");
    expect(imports).toEqual([]);
  }, 60_000);

  test("a failure after the mint names the retained record's path and digest, never its content", async () => {
    const output = mkdtempSync(join(ROOT, "failed-"));
    let created = false;
    let record: FreshMoneyWriterEpochRecord | null = null;
    const provider = {
      async listD1(name: string) {
        return created ? [{ name, uuid: DATABASE_ID }] : [];
      },
      async getD1() {
        return { name: NAME, uuid: DATABASE_ID };
      },
      async createD1(name: string) {
        created = true;
        return { name, uuid: DATABASE_ID };
      },
      async listR2() {
        return [];
      },
      async getR2(name: string) {
        return { name };
      },
      async createR2(): Promise<never> {
        throw new Error("no R2 after a failed import");
      },
    };
    const run: IntegrationStorageGenerationProcess = async (command) => {
      if (command.includes("execute") && command.includes("--file"))
        return { exitCode: 1, stdout: "", stderr: "import failed" };
      return await sourceRun(() => {})(command);
    };
    let error: unknown;
    try {
      await runIntegrationStorageGeneration(invocation, target, {
        provider,
        run,
        review: "test-review",
        productionD1: PRODUCTION_D1,
        outputDirectory: output,
        reader: {
          read: async () => ({
            applied: [],
            shape: "[]\n",
            shapeDigest: `sha256:${createHash("sha256").update("[]\n").digest("hex")}`,
          }),
        },
        freshMoneyWriterEpoch: (selected) => {
          record = mintFreshMoneyWriterEpoch(selected);
          return record;
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DeployError);
    if (record === null) throw new Error("no epoch minted");
    const minted = record as FreshMoneyWriterEpochRecord;
    const path = join(output, FRESH_MONEY_WRITER_EPOCH_RECORD_FILE);
    const digest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    const detail = String((error as DeployError).detail);
    expect(detail).toContain(`moneyWriterEpochRecordPath=${path}`);
    expect(detail).toContain(`moneyWriterEpochRecordDigest=${digest}`);
    const surfaced = `${(error as DeployError).message} ${detail}`;
    expect(surfaced).not.toContain(minted.nonce);
    expect(surfaced).not.toContain(minted.epoch);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }, 60_000);

  function readOnlyProvider(created: () => boolean) {
    return {
      async listD1(name: string) {
        return created() ? [{ name, uuid: DATABASE_ID }] : [];
      },
      async getD1() {
        return { name: NAME, uuid: DATABASE_ID };
      },
      async createD1(): Promise<never> {
        throw new Error("status never creates");
      },
      async listR2(name: string) {
        return created() ? [{ name }] : [];
      },
      async getR2(name: string) {
        return { name };
      },
      async createR2(): Promise<never> {
        throw new Error("status never creates");
      },
    };
  }

  async function statusWith(database: Database, epochRecordDirectory: string) {
    return await runIntegrationStorageGeneration({ ...invocation, action: "status" }, target, {
      provider: readOnlyProvider(() => true),
      run: sourceRun(() => {
        throw new Error("status never imports");
      }),
      epochRecordDirectory,
      reader: { read: async () => localState(database) },
      freshV2DataReader: { read: async () => localData(database) },
    });
  }

  /** A fresh 0700 record directory holding `value` (raw text when a string). */
  function retain(value: unknown, mode = 0o600): string {
    const directory = mkdtempSync(join(ROOT, "status-"));
    const path = join(directory, FRESH_MONEY_WRITER_EPOCH_RECORD_FILE);
    writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, {
      mode: 0o600,
    });
    chmodSync(path, mode);
    return directory;
  }

  test("status verifies a retained 0600 record, refuses a mismatch and says when only the form is checked", async () => {
    const record = mintFreshMoneyWriterEpoch(binding);
    const database = new Database(":memory:");
    const interruptedDatabase = new Database(":memory:");
    try {
      execute(database, composeFreshMoneyPreservedImport(preEpoch, record).sql);
      expect(await statusWith(database, retain(record))).toMatchObject({
        schemaReadback: "complete-0100",
        dataReadback: "empty-seeded",
        writerEpochCheck: "retained-record",
      });
      for (const absent of [mkdtempSync(join(ROOT, "status-")), join(ROOT, "status-never-created")])
        expect(await statusWith(database, absent)).toMatchObject({
          schemaReadback: "complete-0100",
          dataReadback: "empty-seeded",
          writerEpochCheck: "form-only",
        });
      // Another mint for the same D1 is a different epoch than the D1 holds.
      await expect(
        statusWith(database, retain(mintFreshMoneyWriterEpoch(binding))),
      ).rejects.toThrow(FRESH_V2_MONEY_WRITER_EPOCH_MISMATCH);
      await expect(
        statusWith(database, retain({ ...record, nonce: "0".repeat(64) })),
      ).rejects.toThrow(FRESH_V2_MONEY_WRITER_EPOCH_MISMATCH);
      // A loaded record on an interrupted import is never reported as verified.
      execute(interruptedDatabase, composeFreshMoneyPreservedImport(preEpoch, record).sql);
      interruptedDatabase.exec("DELETE FROM money_cutover_authorized_epoch");
      expect(await statusWith(interruptedDatabase, retain(record))).toMatchObject({
        schemaReadback: "complete-0100",
        dataReadback: "interrupted",
        writerEpochCheck: "not-run",
      });
    } finally {
      database.close();
      interruptedDatabase.close();
    }
  }, 60_000);

  test("a record that is not one private plain JSON object is refused, never treated as absent", async () => {
    const record = mintFreshMoneyWriterEpoch(binding);
    const database = new Database(":memory:");
    try {
      execute(database, composeFreshMoneyPreservedImport(preEpoch, record).sql);
      for (const value of ["null\n", "[]\n", "1\n", '"record"\n', "{\n"])
        await expect(statusWith(database, retain(value))).rejects.toThrow(
          /not one plain object|unreadable/u,
        );
      await expect(statusWith(database, retain(record, 0o644))).rejects.toThrow(
        "not an operator-private regular file",
      );
      // Oversize: a valid record padded beyond 4 KiB.
      await expect(
        statusWith(database, retain(`${JSON.stringify(record)}${" ".repeat(4096)}\n`)),
      ).rejects.toThrow("not an operator-private regular file");
      // A symlink to a valid 0600 record is refused, not followed.
      const real = retain(record);
      const linked = mkdtempSync(join(ROOT, "status-"));
      symlinkSync(
        join(real, FRESH_MONEY_WRITER_EPOCH_RECORD_FILE),
        join(linked, FRESH_MONEY_WRITER_EPOCH_RECORD_FILE),
      );
      await expect(statusWith(database, linked)).rejects.toThrow(
        "not an operator-private regular file",
      );
      // A looser record directory is refused as a whole.
      const loose = retain(record);
      chmodSync(loose, 0o755);
      await expect(statusWith(database, loose)).rejects.toThrow("operator-owned 0700 directory");
    } finally {
      database.close();
    }
  }, 60_000);

  test("apply with --epoch-record-directory, then status with the same directory, verifies the retained record", async () => {
    const database = new Database(":memory:");
    const directory = join(mkdtempSync(join(ROOT, "records-")), "generation");
    let created = false;
    let bucket = false;
    try {
      const provider = {
        async listD1(name: string) {
          return created ? [{ name, uuid: DATABASE_ID }] : [];
        },
        async getD1() {
          return { name: NAME, uuid: DATABASE_ID };
        },
        async createD1(name: string) {
          created = true;
          return { name, uuid: DATABASE_ID };
        },
        async listR2(name: string) {
          return bucket ? [{ name }] : [];
        },
        async getR2(name: string) {
          return { name };
        },
        async createR2(name: string) {
          bucket = true;
          return { name };
        },
      };
      const options = {
        provider,
        review: "test-review",
        productionD1: PRODUCTION_D1,
        epochRecordDirectory: directory,
        reader: { read: async () => localState(database) },
        freshV2DataReader: { read: async () => localData(database) },
      };
      const applied = await runIntegrationStorageGeneration(invocation, target, {
        ...options,
        run: sourceRun((path) => execute(database, readFileSync(path, "utf8"))),
      });
      const path = join(directory, FRESH_MONEY_WRITER_EPOCH_RECORD_FILE);
      expect(applied.moneyWriterEpochRecord).toMatchObject({ path });
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const status = await runIntegrationStorageGeneration(
        { ...invocation, action: "status" },
        target,
        {
          ...options,
          run: sourceRun(() => {
            throw new Error("status never imports");
          }),
        },
      );
      expect(status).toMatchObject({
        schemaReadback: "complete-0100",
        dataReadback: "empty-seeded",
        writerEpochCheck: "retained-record",
      });
      // The same directory never takes a second record.
      const calls = { count: 0 };
      await expect(
        runIntegrationStorageGeneration(invocation, target, {
          ...options,
          provider: trapProvider(calls),
          run: sourceRun(() => {}),
        }),
      ).rejects.toThrow("already holds a Writer epoch record");
      // A looser directory, or any other lineage, is refused before any provider call.
      const loose = mkdtempSync(join(ROOT, "records-"));
      chmodSync(loose, 0o755);
      await expect(
        runIntegrationStorageGeneration(invocation, target, {
          ...options,
          epochRecordDirectory: loose,
          provider: trapProvider(calls),
          run: sourceRun(() => {}),
        }),
      ).rejects.toThrow("operator-owned 0700 directory");
      await expect(
        runIntegrationStorageGeneration({ ...invocation, freshLineage: "v2-0100" }, target, {
          ...options,
          epochRecordDirectory: mkdtempSync(join(ROOT, "records-")),
          provider: trapProvider(calls),
          run: sourceRun(() => {}),
        }),
      ).rejects.toThrow("only for the v2-0100-money-preserved lineage");
      expect(calls.count).toBe(0);
    } finally {
      database.close();
    }
  }, 60_000);

  test("the CLI accepts --epoch-record-directory only as one absolute path on the Money-preserved generation", async () => {
    const deploy = (args: readonly string[]) => {
      const child = Bun.spawnSync(["bun", "run", "--silent", "deploy", "--", ...args], {
        cwd: resolve(import.meta.dir, ".."),
        env: { PATH: process.env.PATH ?? "" },
        stdin: "ignore",
      });
      return new TextDecoder().decode(child.stderr);
    };
    const base = [
      "takoserver-integration-storage-generation",
      "--status",
      "--environment=integration",
      `--commit=${"a".repeat(40)}`,
      `--generation=${GENERATION}`,
    ];
    const directory = join(ROOT, "cli-records");
    for (const action of ["--status", "--apply"]) {
      const accepted = deploy([
        ...base.map((flag) => (flag === "--status" ? action : flag)),
        "--fresh-lineage=v2-0100-money-preserved",
        `--epoch-record-directory=${directory}`,
      ]);
      expect(accepted).toContain("deploy target descriptor not found");
      expect(accepted).not.toContain("no target was touched");
    }
    for (const extra of [
      ["--fresh-lineage=v2-0100-money-preserved", "--epoch-record-directory=relative/records"],
      ["--fresh-lineage=v2-0100", `--epoch-record-directory=${directory}`],
      [`--epoch-record-directory=${directory}`],
      [
        "--fresh-lineage=v2-0100-money-preserved",
        `--epoch-record-directory=${directory}`,
        `--epoch-record-directory=${directory}`,
      ],
    ])
      expect(deploy([...base, ...extra])).toContain("deploy refused: no target was touched");
  }, 60_000);

  test("an operator staging pair never stands in for the Money-preserved generation", () => {
    const config = JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    });
    const staging = "takoserver-staging-throwaway-0100-example";
    const pair = {
      ...target,
      d1: { databaseName: staging, databaseId: "00000000-0000-4000-8000-000000000101" },
      r2: { bucketName: staging },
      takoformV2: { config, storageLineage: "v2-0100-money-preserved" as const },
    } satisfies DeployTarget;
    expect(isGeneratedIntegrationStorageTarget(pair, "integration")).toBe(false);
    expect(
      isGeneratedIntegrationStorageTarget(
        { ...pair, d1: { databaseName: NAME, databaseId: DATABASE_ID }, r2: { bucketName: NAME } },
        "integration",
      ),
    ).toBe(true);
  });

  test("the deploy contract names the lineage, its order and its private epoch record", () => {
    const surface = DEPLOY_CONTRACT.surfaces.find(
      (candidate) => candidate.surface === "takoserver-integration-storage-generation",
    );
    const text = JSON.stringify(surface?.obligations ?? {});
    for (const phrase of [
      "v2-0100-money-preserved",
      "Money-preserved 0001-0100 replay, Financial's test realm claim over that replay's own inventory",
      "minted by the Financial owner only after the new D1 identity readback and before the import is written",
      "operator-private (0600)",
      "exactly one authorized Writer epoch equal to the minted one, and no freeze or permit row",
      "moneyPreserved.epochBindingDigest and shapeDigest",
      "applying v2-0091, v2-0092, v2-0100 or v2-0100-money-preserved requires that production target",
    ])
      expect(text).toContain(phrase);
  });
});
