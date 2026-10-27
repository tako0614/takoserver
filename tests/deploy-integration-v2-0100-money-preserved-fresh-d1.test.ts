import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Miniflare } from "miniflare";
import type { FreshV2DataReadback } from "../scripts/deploy/fresh-v2-data-readback.ts";
import {
  type IntegrationStorageGenerationProcess,
  runIntegrationStorageGeneration,
  verifyFreshV2IntegrationStorageTarget,
} from "../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape } from "../scripts/deploy/migrations.ts";
import { mintFreshMoneyWriterEpoch } from "../scripts/deploy/money-fresh-writer-epoch.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { bytesDigest } from "../src/json.ts";
import {
  inspectMoneyCutoverGuard,
  MONEY_CUTOVER_WRITER_EPOCH_PATTERN,
  MONEY_CUTOVER_WRITER_POLICY,
} from "../src/money-cutover-sql.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";

/**
 * A real Miniflare D1 journey for the staging-only fresh Money-preserved 0100
 * lineage: the storage generation imports its one sealed file, the readback
 * proves the exact preserved shape, test pin and minted Writer epoch, and the
 * current Worker selected with that Money writer policy and epoch starts.
 */

const ORIGIN = "https://api.fresh-v2-0100mp.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const GENERATION = "c".repeat(32);
const NAME = `integration-takoserver-${GENERATION}`;
const DATABASE_ID = "00000000-0000-4000-8000-0000000001b0";
const ACCOUNT = "b".repeat(32);
const ORGANIZATION = "org-fresh-0100mp";
const TOKEN = "fresh-0100mp-test-token";
const PRODUCTION_D1 = {
  databaseName: "takoserver-runtime",
  databaseId: "85c5a15d-a80f-42fe-a907-7ec0d86e008e",
} as const;

type D1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;

test("fresh v2-0100-money-preserved generation starts the current Worker with its Money writer", async () => {
  // The Financial owner mints for exactly this D1; the test port returns that
  // real record so the Worker can be configured with its epoch up front.
  const record = mintFreshMoneyWriterEpoch({
    accountId: ACCOUNT,
    databaseId: DATABASE_ID,
    databaseName: NAME,
    generation: GENERATION,
  });
  expect(record.epoch).toMatch(MONEY_CUTOVER_WRITER_EPOCH_PATTERN);
  const config = JSON.stringify({
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/v2/authentication",
  });
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "helpers/takoform-v2-entry-worker-miniflare.ts")],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
  });
  expect(build.success).toBe(true);
  const bundle = build.outputs[0];
  if (!bundle) throw new Error("missing Worker test bundle");
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "fresh-0100mp-entry",
          type: "worker",
          compatibilityDate: "2026-08-17",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: await bundle.text() } },
          },
          env: {
            STATE_DB: { type: "d1", id: NAME },
            OBJECTS: { type: "r2", name: NAME },
            PUBLIC_ORIGIN: { type: "text", value: ORIGIN },
            TAKOSERVER_ENVIRONMENT: { type: "text", value: "integration" },
            TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY: {
              type: "text",
              value: MONEY_CUTOVER_WRITER_POLICY,
            },
            TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: { type: "text", value: record.epoch },
            WORKER_VERSION: {
              type: "json",
              value: { id: "00000000-0000-4000-8000-0000000000a1" },
            },
            TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: { type: "text", value: "A".repeat(43) },
            TAKOSERVER_TAKOFORM_V2_CONFIG: { type: "text", value: config },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    const d1 = await runtime.getD1Database("STATE_DB");
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
      publicOrigin: ORIGIN,
      signing: { currentKeyId: "integration-current" },
    } satisfies DeployTarget;
    let d1Created = false;
    let r2Created = false;
    let importCount = 0;
    let mints = 0;
    const provider = {
      async listD1(name: string) {
        return d1Created ? [{ name, uuid: DATABASE_ID }] : [];
      },
      async getD1() {
        return { name: NAME, uuid: DATABASE_ID };
      },
      async createD1(name: string) {
        d1Created = true;
        return { name, uuid: DATABASE_ID };
      },
      async listR2(name: string) {
        return r2Created ? [{ name }] : [];
      },
      async getR2(name: string) {
        return { name };
      },
      async createR2(name: string) {
        expect(importCount).toBe(1);
        r2Created = true;
        return { name };
      },
    };
    const run: IntegrationStorageGenerationProcess = async (command) => {
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(`${"c".repeat(40)}\n`);
      if (key === "git branch --show-current") return ok("fresh-0100mp-test\n");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
      if (key === "bun run check:migrations") return ok("green\n");
      if (command.includes("execute") && command.includes("--file")) {
        const file = command[command.indexOf("--file") + 1];
        if (!file) throw new Error("no sealed import path");
        importCount += 1;
        // Miniflare D1 cannot consume Wrangler's one-file import transport;
        // feed the same sealed bytes as actual D1 statements, in order.
        for (const statement of frameHostMigrationSql(readFileSync(file, "utf8")))
          await d1.prepare(statement).all();
        return ok("imported\n");
      }
      throw new Error(`unexpected local test command ${key}`);
    };
    const reader = { read: async () => await d1State(d1) };
    const freshV2DataReader = {
      async read() {
        try {
          return await miniflareData(d1);
        } catch (error) {
          // Status catches readback failures; retain the fixture's raw D1 cause.
          console.error("fresh Money fixture D1 readback failed", error);
          throw error;
        }
      },
    };
    const invocation = {
      action: "apply",
      environment: "integration",
      commit: "c".repeat(40),
      generation: GENERATION,
      freshLineage: "v2-0100-money-preserved",
    } as const;
    const result = await runIntegrationStorageGeneration(invocation, target, {
      provider,
      run,
      review: "test-review",
      reader,
      freshV2DataReader,
      productionD1: PRODUCTION_D1,
      freshMoneyWriterEpoch: () => {
        mints += 1;
        return record;
      },
    });
    expect(mints).toBe(1);
    expect(importCount).toBe(1);
    expect(r2Created).toBe(true);
    expect(result).toMatchObject({
      freshLineage: "v2-0100-money-preserved",
      moneyPreserved: { epochBindingDigest: record.bindingDigest },
      stripeRealmClaim: { mode: "test", historyTables: 72 },
    });
    expect((result.appliedMigrations as string[]).length).toBe(100);
    // Without an output directory the private record outlives the release.
    const retained = result.moneyWriterEpochRecord as { path: string };
    expect(JSON.parse(readFileSync(retained.path, "utf8"))).toEqual(record);
    rmSync(dirname(retained.path), { recursive: true, force: true });

    const status = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      target,
      { provider, run, reader, freshV2DataReader },
    );
    expect(status).toMatchObject({
      schemaReadback: "complete-0100",
      dataReadback: "empty-seeded",
      readyForApply: false,
      writerEpochCheck: "form-only",
    });
    const generatedTarget = {
      ...target,
      d1: { databaseName: NAME, databaseId: DATABASE_ID },
      r2: { bucketName: NAME },
      takoformV2: { config, storageLineage: "v2-0100-money-preserved" as const },
    } satisfies DeployTarget;
    expect(
      await verifyFreshV2IntegrationStorageTarget(
        generatedTarget,
        "integration",
        "v2-0100-money-preserved",
        { provider, reader },
      ),
    ).toMatchObject({
      freshLineage: "v2-0100-money-preserved",
      migrationDigest: result.migrationDigest,
    });
    // The plain v2-0100 selector never qualifies the preserved shape.
    await expect(
      verifyFreshV2IntegrationStorageTarget(
        { ...generatedTarget, takoformV2: { config, storageLineage: "v2-0100" as const } },
        "integration",
        "v2-0100",
        { provider, reader },
      ),
    ).rejects.toThrow("application schema");

    expect(await inspectMoneyCutoverGuard(createD1Sql(d1), record.epoch)).toBe("ready");
    const sql = createD1Sql(d1);
    const now = new Date().toISOString();
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      [ORGANIZATION, "Fresh 0100 preserved", "principal-fresh-0100mp", now],
    );
    await sql.run(
      "INSERT INTO auth_tokens (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at, revoked_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, NULL)",
      [
        await bytesDigest(new TextEncoder().encode(TOKEN)),
        "key-fresh-0100mp",
        "principal-fresh-0100mp",
        ORGANIZATION,
        "fresh-0100mp-test",
        JSON.stringify(["resources:write"]),
        now,
        new Date(Date.now() + 3_600_000).toISOString(),
      ],
    );
    const support = await runtime.dispatchFetch(
      `${BASE}/support?form=${encodeURIComponent(SQLITE_MIGRATION_SET_FORM_URL)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(support.status).toBe(200);

    // An import that stopped before its Writer epoch row is quarantined.
    await d1.prepare("DELETE FROM money_cutover_authorized_epoch").run();
    const interrupted = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      target,
      { provider, run, reader, freshV2DataReader },
    );
    expect(interrupted).toMatchObject({
      schemaReadback: "complete-0100",
      dataReadback: "interrupted",
    });
    expect(String(interrupted.resume)).toContain("Quarantine");
  } finally {
    await runtime.dispose();
  }
}, 180_000);

async function miniflareData(database: D1): Promise<FreshV2DataReadback> {
  const tables = (
    await database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);
  const tableCounts: Record<string, number> = {};
  for (const name of tables) {
    const row = await database
      .prepare(`SELECT COUNT(*) AS count FROM "${name}"`)
      .first<{ count: number }>();
    tableCounts[name] = row?.count ?? -1;
  }
  const rows = async (sql: string) =>
    (await database.prepare(sql).all<Record<string, unknown>>()).results;
  const ledger = await database
    .prepare("SELECT COUNT(*) AS count FROM d1_migrations")
    .first<{ count: number }>();
  return {
    tableCounts,
    ledgerRows: ledger?.count ?? -1,
    foreignKeyViolations: (
      await rows("SELECT 1 AS violation FROM pragma_foreign_key_check LIMIT 1")
    ).length,
    invocationEpoch: await rows(
      "SELECT singleton, epoch_id, state, opened_at_ms, closed_at_ms FROM tf_cloudflare_provider_invocation_epoch LIMIT 2",
    ),
    acceptanceCounter: await rows(
      "SELECT id, last_order, last_operation_id FROM tf_v2_operation_acceptance_counter LIMIT 2",
    ),
    moneyUnitPolicy: await rows(
      "SELECT singleton, ledger_unit, historical_usage_unit, cash_unit FROM money_unit_policy LIMIT 2",
    ),
    stripeRealm: await rows("SELECT singleton, mode, pinned_at FROM stripe_mode_realm LIMIT 2"),
    authorizedEpoch: await rows(
      "SELECT singleton, writer_epoch FROM money_cutover_authorized_epoch LIMIT 2",
    ),
  };
}

async function d1State(database: D1) {
  const tableNames = (
    await database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
  ).results.map((row) => row.name);
  const applied = tableNames.includes("d1_migrations")
    ? (
        await database.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()
      ).results.map((row) => row.name)
    : [];
  const rows = await database
    .prepare(
      "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all<{ type: string; name: string; tbl_name: string; sql: string }>();
  // Miniflare's local D1 emulation adds _cf_METADATA, which the production
  // schema reader does not own.
  const shape = canonicalSchemaShape(rows.results.filter((row) => row.name !== "_cf_METADATA"));
  return {
    applied,
    shape,
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
  };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}
