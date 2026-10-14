import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalSchemaShape,
  type D1SchemaState,
  readMigrationArtifact,
} from "../scripts/deploy/migrations.ts";
import {
  moneyUnitCutoverSchemaMatches,
  readMoneyAggregateDigest,
  readMoneyFrozenDataDigest,
  readMoneyPreimageDigest,
  readWholeDatabaseDataDigest,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import {
  buildMoneyRehearsalSyntheticPlan,
  classifyMoneyRehearsalUploadUrl,
  importFailureProbe,
  type MoneyRehearsalDeclaration,
  readMoneyRehearsalWranglerProvenance,
  reviewedFailureProbeResult,
  runMoneyUnitRehearsal,
  verifyMoneyShadowSnapshotBytes,
} from "../scripts/deploy/schema-money-unit-rehearsal.ts";
import { createMoneyCutoverSql, inspectMoneyCutoverGuard } from "../src/money-cutover-sql.ts";
import type { Sql, SqlParam, SqlStatement } from "../src/ports.ts";

const files = readMigrationArtifact().files;
const sha = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function declaration(root: string): MoneyRehearsalDeclaration {
  return {
    kind: "takoserver.money-unit-rehearsal@v1",
    environment: "rehearsal",
    accountId: "1".repeat(32),
    databaseName: `takoserver-r-${"2".repeat(32)}`,
    databaseId: "11111111-1111-4111-8111-111111111111",
    createDeclarationPath: join(root, "create.json"),
    createDeclarationDigest: sha("create"),
    createReceiptPath: join(root, "receipt.json"),
    createReceiptDigest: sha("receipt"),
    reviewPath: join(root, "review.json"),
    custodyDirectory: join(root, "custody"),
    phase: "seed",
  };
}

function localState(database: Database): D1SchemaState {
  const applied = (
    database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
  ).map(({ name }) => name);
  const rows = database
    .query(
      "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Record<string, unknown>[];
  const shape = canonicalSchemaShape(rows);
  return { applied, shape, shapeDigest: sha(shape) };
}

const reader = (database: Database) => ({
  query: async (_phase: unknown, _description: unknown, sql: string) =>
    database.query(sql).all() as Record<string, unknown>[],
});

async function allApplicationDigest(database: Database): Promise<string> {
  const rows = database
    .query(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations') ORDER BY name",
    )
    .all() as { name: string }[];
  return readWholeDatabaseDataDigest(
    reader(database),
    "preflight",
    rows.map(({ name }) => name),
  );
}

/** Local SQLite adapter exercises the public batch contract, not native Worker D1.batch. */
function localSql(database: Database): Sql {
  const args = (params?: readonly SqlParam[]) => (params ?? []) as never[];
  const execute = (statement: SqlStatement) => {
    const result = database.query(statement.sql).run(...args(statement.params));
    return { rows: [], changes: result.changes };
  };
  return {
    async query(sql, params) {
      return database.query(sql).all(...args(params)) as Record<string, unknown>[];
    },
    async run(sql, params) {
      return execute({ sql, ...(params === undefined ? {} : { params }) });
    },
    async batch(statements) {
      database.exec("BEGIN TRANSACTION");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

describe("money-unit native rehearsal source", () => {
  test("protected shadow snapshot restores every 0093 row byte and rejects same-schema value drift", async () => {
    const root = mkdtempSync("/dev/shm/t/money-shadow-snapshot-test-");
    try {
      const plan = await buildMoneyRehearsalSyntheticPlan(files, declaration(root));
      const full = `${plan.sql.seed}\n${(["freeze", "prepare", "classify"] as const)
        .map((phase) => `BEGIN TRANSACTION;\n${plan.sql[phase]}\nCOMMIT;`)
        .join("\n")}`;
      expect(
        await verifyMoneyShadowSnapshotBytes(Buffer.from(full), plan.application.classify, files),
      ).toBe(sha(full));
      const drifted = full.replace("Synthetic rehearsal", "Changed rehearsal");
      await expect(
        verifyMoneyShadowSnapshotBytes(Buffer.from(drifted), plan.application.classify, files),
      ).rejects.toThrow("differs from all native application rows");
      await expect(
        verifyMoneyShadowSnapshotBytes(
          Buffer.from(`${full}\nCREATE TABLE foreign_table (x TEXT);`),
          plan.application.classify,
          files,
        ),
      ).rejects.toThrow("unexpected schema");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("sealed synthetic 94 failure after reinstall rolls back to complete 93 fenced state", async () => {
    const root = mkdtempSync("/dev/shm/t/money-rehearsal-test-");
    const database = new Database(":memory:");
    try {
      const plan = await buildMoneyRehearsalSyntheticPlan(files, declaration(root));
      database.exec(plan.sql.seed);
      for (const phase of ["freeze", "prepare", "classify"] as const)
        database.exec(`BEGIN TRANSACTION;\n${plan.sql[phase]}\nCOMMIT;`);
      expect(moneyUnitCutoverSchemaMatches(localState(database), files, "0093-fenced")).toBe(true);
      expect(await allApplicationDigest(database)).toBe(plan.application.classify);
      const before = await readMoneyPreimageDigest(reader(database), "preflight");
      expect(() =>
        database.exec(`BEGIN TRANSACTION;\n${plan.sql["failure-probe"]}\nCOMMIT;`),
      ).toThrow();
      database.exec("ROLLBACK");
      expect(moneyUnitCutoverSchemaMatches(localState(database), files, "0093-fenced")).toBe(true);
      expect(await allApplicationDigest(database)).toBe(plan.application.classify);
      expect(await readMoneyPreimageDigest(reader(database), "verification")).toBe(before);
      expect(() => database.exec("DELETE FROM wallet_credit_lots")).toThrow();
      database.exec(`BEGIN TRANSACTION;\n${plan.sql.convert}\nCOMMIT;`);
      expect(moneyUnitCutoverSchemaMatches(localState(database), files, "0094-fenced")).toBe(true);
      expect(await allApplicationDigest(database)).toBe(plan.application.convert);
      expect(await readMoneyPreimageDigest(reader(database), "verification", true)).toBe(before);
      expect(
        (
          database
            .query("SELECT settled_delta_micros AS n FROM ledger WHERE id = 'fund-rehearsal'")
            .get() as { n: number }
        ).n,
      ).toBe(9007199254730000);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("false resume CHECK rolls back prior mutation; permanent guard admits only pinned batch permits", async () => {
    const root = mkdtempSync("/dev/shm/t/money-rehearsal-epoch-");
    const database = new Database(":memory:");
    try {
      const plan = await buildMoneyRehearsalSyntheticPlan(files, declaration(root));
      database.exec(plan.sql.seed);
      for (const phase of ["freeze", "prepare", "classify", "convert"] as const)
        database.exec(`BEGIN TRANSACTION;\n${plan.sql[phase]}\nCOMMIT;`);
      const fencedDigest = await allApplicationDigest(database);
      expect(fencedDigest).toBe(plan.application.convert);
      const beforeFreeze = database.query("SELECT * FROM money_cutover_freeze").get();
      expect(() => {
        database.exec("BEGIN TRANSACTION");
        try {
          for (const statement of plan.sql["resume-failure-probe"].split(";\n")) {
            if (statement.trim()) database.query(statement).run();
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }).toThrow("CHECK constraint failed");
      expect(database.query("SELECT * FROM money_cutover_freeze").get()).toEqual(beforeFreeze);
      expect(await allApplicationDigest(database)).toBe(fencedDigest);
      expect(database.query("SELECT COUNT(*) AS n FROM money_cutover_writer_permit").get()).toEqual(
        { n: 0 },
      );
      database.exec(`BEGIN TRANSACTION;\n${plan.sql.resume}\nCOMMIT;`);
      expect(moneyUnitCutoverSchemaMatches(localState(database), files, "0094")).toBe(true);
      expect(await allApplicationDigest(database)).toBe(plan.application.resume);
      const raw = localSql(database);
      expect(await inspectMoneyCutoverGuard(raw, plan.writerEpoch)).toBe("ready");
      for (const phase of [
        "legacy-insert-probe",
        "legacy-update-probe",
        "legacy-delete-probe",
      ] as const)
        expect(() => database.query(plan.sql[phase]).run()).toThrow(
          "money cutover writer permit required",
        );
      const staleEpoch = sha(`revoked-synthetic-rehearsal:${plan.writerEpoch}`);
      const stale = createMoneyCutoverSql(raw, staleEpoch);
      await expect(
        stale.run("UPDATE stripe_events SET outcome = outcome WHERE event_id = 'evt_rehearsal'"),
      ).rejects.toThrow("epoch revoked");
      const current = createMoneyCutoverSql(raw, plan.writerEpoch);
      await current.run(
        "UPDATE stripe_events SET outcome = outcome WHERE event_id = 'evt_rehearsal'",
      );
      const readyDigest = await allApplicationDigest(database);
      await expect(
        current.batch([
          { sql: "UPDATE stripe_events SET outcome = 'deferred' WHERE event_id = 'evt_rehearsal'" },
          { sql: "INSERT INTO money_cutover_rehearsal_missing_0094_probe VALUES (1)" },
        ]),
      ).rejects.toThrow("no such table");
      expect(await allApplicationDigest(database)).toBe(readyDigest);
      expect(database.query("SELECT COUNT(*) AS n FROM money_cutover_writer_permit").get()).toEqual(
        { n: 0 },
      );
      for (const skippedUpdate of [
        plan.sql["permit-success"].replace(
          "event_id = 'evt_rehearsal' AND outcome = 'ignored'",
          "event_id = 'evt_missing' AND outcome = 'ignored'",
        ),
        plan.sql["permit-success"].replace("SET outcome = 'deferred'", "SET outcome = outcome"),
      ]) {
        expect(skippedUpdate).not.toBe(plan.sql["permit-success"]);
        database.exec(`BEGIN TRANSACTION;\n${skippedUpdate}\nCOMMIT;`);
        expect(await allApplicationDigest(database)).toBe(plan.application.resume);
        expect(await allApplicationDigest(database)).not.toBe(plan.application["permit-success"]);
        expect(
          database.query("SELECT COUNT(*) AS n FROM money_cutover_writer_permit").get(),
        ).toEqual({ n: 0 });
      }
      database.exec(`BEGIN TRANSACTION;\n${plan.sql["permit-success"]}\nCOMMIT;`);
      expect(
        database.query("SELECT outcome FROM stripe_events WHERE event_id = 'evt_rehearsal'").get(),
      ).toEqual({ outcome: "deferred" });
      expect(await allApplicationDigest(database)).toBe(plan.application["permit-success"]);
      expect(await readMoneyFrozenDataDigest(reader(database), "verification")).toBe(
        plan.financial["permit-success"],
      );
      expect(plan.financial["permit-success"]).not.toBe(plan.financial.resume);
      expect(await readMoneyPreimageDigest(reader(database), "verification", true)).toBe(
        plan.preimageDigest,
      );
      expect(await readMoneyAggregateDigest(reader(database), "verification", true)).toBe(
        plan.aggregateDigest,
      );
      expect(database.query("SELECT COUNT(*) AS n FROM money_cutover_writer_permit").get()).toEqual(
        { n: 0 },
      );
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("production invocation and forged creation evidence refuse before provider read", async () => {
    const root = mkdtempSync("/dev/shm/t/money-rehearsal-trap-");
    const custody = join(root, "custody");
    mkdirSync(custody, { mode: 0o700 });
    const selected = declaration(root);
    let reads = 0;
    const provider = {
      getD1: async () => {
        reads += 1;
        throw new Error("provider read");
      },
      listD1: async () => {
        reads += 1;
        throw new Error("provider read");
      },
    };
    try {
      await expect(
        runMoneyUnitRehearsal(
          selected,
          { action: "status", environment: "production", commit: "a".repeat(40) } as never,
          { provider },
        ),
      ).rejects.toThrow("rehearsal status/apply");
      expect(reads).toBe(0);
      writeFileSync(selected.createDeclarationPath, "{}", { mode: 0o600 });
      writeFileSync(selected.createReceiptPath, "{}", { mode: 0o600 });
      await expect(
        runMoneyUnitRehearsal(
          selected,
          { action: "status", environment: "rehearsal", commit: "a".repeat(40) },
          { provider },
        ),
      ).rejects.toThrow("creation evidence changed");
      expect(reads).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a retained dispatch blocks apply before any Wrangler import or qualification", async () => {
    const root = mkdtempSync("/dev/shm/t/money-rehearsal-dispatched-");
    mkdirSync(join(root, "custody"), { mode: 0o700 });
    try {
      const base = declaration(root);
      const create = `${JSON.stringify({
        kind: "takoserver.rehearsal-d1-create@v1",
        environment: "rehearsal",
        accountId: base.accountId,
        name: base.databaseName,
      })}\n`;
      const receipt = `${JSON.stringify({
        kind: "takoserver.rehearsal-d1-create-apply@v1",
        surface: "takoserver-rehearsal-d1-create",
        environment: "rehearsal",
        commit: "a".repeat(40),
        reviewer: "independent reviewer",
        databaseName: base.databaseName,
        databaseId: base.databaseId,
        schemaObjectCount: 0,
      })}\n`;
      writeFileSync(base.createDeclarationPath, create, { mode: 0o600 });
      writeFileSync(base.createReceiptPath, receipt, { mode: 0o600 });
      const selected = {
        ...base,
        createDeclarationDigest: sha(create),
        createReceiptDigest: sha(receipt),
      };
      const binding = { phase: "seed" };
      writeFileSync(
        join(selected.custodyDirectory, "seed.dispatched.json"),
        `${JSON.stringify({
          kind: "takoserver.money-rehearsal-dispatch-record@v1",
          bindingDigest: sha(JSON.stringify(binding)),
          binding,
        })}\n`,
        { mode: 0o600 },
      );
      let commands = 0;
      const provider = {
        getD1: async () => ({ uuid: selected.databaseId, name: selected.databaseName }) as never,
        listD1: async () => [{ uuid: selected.databaseId, name: selected.databaseName } as never],
      };
      await expect(
        runMoneyUnitRehearsal(
          selected,
          { action: "apply", environment: "rehearsal", commit: "a".repeat(40) },
          {
            provider,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-rehearsal-token" },
            run: async () => {
              commands += 1;
              throw new Error("unexpected command");
            },
          },
        ),
      ).rejects.toThrow("already dispatched");
      expect(commands).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failure proof requires one exact authenticated provider SQL error, never echoed diagnostics", () => {
    const exact = {
      success: true,
      status: "error",
      errors: ["D1_ERROR: no such table: money_cutover_rehearsal_missing_0094_probe: SQLITE_ERROR"],
    };
    expect(reviewedFailureProbeResult(exact)).toBe(sha(JSON.stringify(exact)));
    const documented = { success: true, status: "error", error: exact.errors[0] };
    expect(reviewedFailureProbeResult(documented)).toBe(sha(JSON.stringify(documented)));
    for (const response of [
      {
        ...exact,
        errors: ["network timeout while sending money_cutover_rehearsal_missing_0094_probe"],
      },
      {
        ...exact,
        errors: ["auth refused: no such table: money_cutover_rehearsal_missing_0094_probe"],
      },
      { ...exact, errors: [...exact.errors, "TLS connection lost"] },
      { ...exact, error: "auth failure" },
      { ...exact, success: false },
      { ...exact, status: "processing" },
      {
        ...exact,
        errors: [
          "D1_ERROR: no such table: money_cutover_rehearsal_missing_0094_probe: SQLITE_ERROR\nnetwork timeout",
        ],
      },
    ]) {
      expect(() => reviewedFailureProbeResult(response)).toThrow("exact late SQL-fault");
    }
    const phaseErrors = [
      [
        "resume-failure-probe",
        "D1_ERROR: CHECK constraint failed: epoch = 'usd-micros-v2': SQLITE_CONSTRAINT_CHECK",
      ],
      [
        "legacy-insert-probe",
        "D1_ERROR: money cutover writer permit required: SQLITE_CONSTRAINT_TRIGGER",
      ],
      [
        "legacy-update-probe",
        "D1_ERROR: money cutover writer permit required: SQLITE_CONSTRAINT_TRIGGER",
      ],
      [
        "legacy-delete-probe",
        "D1_ERROR: money cutover writer permit required: SQLITE_CONSTRAINT_TRIGGER",
      ],
      [
        "stale-epoch-probe",
        "D1_ERROR: money cutover Writer epoch revoked: SQLITE_CONSTRAINT_TRIGGER",
      ],
      [
        "permit-failure-probe",
        "D1_ERROR: no such table: money_cutover_rehearsal_missing_0094_probe: SQLITE_ERROR",
      ],
    ] as const;
    for (const [phase, diagnostic] of phaseErrors) {
      const response = { success: true, status: "error", error: diagnostic };
      expect(reviewedFailureProbeResult(response, phase)).toBe(sha(JSON.stringify(response)));
      expect(() =>
        reviewedFailureProbeResult({ ...response, error: `${diagnostic}\nnetwork timeout` }, phase),
      ).toThrow("exact late SQL-fault");
      expect(() => reviewedFailureProbeResult({ ...response, status: "active" }, phase)).toThrow(
        "exact late SQL-fault",
      );
    }
  });

  test("Wrangler provenance binds the delegated executable CLI module bytes", () => {
    const installed = readMoneyRehearsalWranglerProvenance();
    expect(installed.wranglerModuleDigest).toBe(
      sha(readFileSync(join(import.meta.dir, "../node_modules/wrangler/wrangler-dist/cli.js"))),
    );
    const root = mkdtempSync("/dev/shm/t/money-rehearsal-wrangler-");
    try {
      mkdirSync(join(root, "bin"));
      mkdirSync(join(root, "wrangler-dist"));
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          version: "4.123.0",
          main: "wrangler-dist/cli.js",
          bin: { wrangler: "./bin/wrangler.js" },
        }),
      );
      writeFileSync(
        join(root, "bin/wrangler.js"),
        'path.join(__dirname, "../wrangler-dist/cli.js")',
      );
      writeFileSync(join(root, "wrangler-dist/cli.js"), "actual CLI v1");
      const before = readMoneyRehearsalWranglerProvenance(root);
      expect(before.wranglerVersion).toBe("4.123.0");
      expect(before.wranglerModuleDigest).toBe(sha("actual CLI v1"));
      writeFileSync(join(root, "wrangler-dist/cli.js"), "actual CLI tampered");
      const after = readMoneyRehearsalWranglerProvenance(root);
      expect(after.wranglerLauncherDigest).toBe(before.wranglerLauncherDigest);
      expect(after.wranglerModuleDigest).not.toBe(before.wranglerModuleDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("structured import sends exact SQL to authenticated target and polls active to SQL error", async () => {
    const account = "1".repeat(32);
    const databaseId = "11111111-1111-4111-8111-111111111111";
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/import`;
    const signed = `https://fixture.${"f".repeat(32)}.r2.cloudflarestorage.com/import.sql?X-Amz-Signature=${"a".repeat(64)}&X-Amz-Credential=fixture`;
    const sql = "SELECT 1;\nINSERT INTO money_cutover_rehearsal_missing_0094_probe VALUES (1);\n";
    const md5 = createHash("md5").update(sql).digest("hex");
    const actions: string[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === "PUT") {
        expect(String(url)).toBe(signed);
        expect(Buffer.from(init.body as Uint8Array).toString("utf8")).toBe(sql);
        expect(new Headers(init.headers).get("Content-Length")).toBe(
          String(Buffer.byteLength(sql)),
        );
        expect(init.redirect).toBe("error");
        actions.push("upload");
        return new Response("", { status: 200, headers: { etag: `"${md5}"` } });
      }
      expect(String(url)).toBe(endpoint);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const action = String(body.action);
      actions.push(action);
      if (action === "init") {
        expect(body.etag).toBe(md5);
        return Response.json({
          success: true,
          result: { upload_url: signed, filename: "rehearsal.sql" },
        });
      }
      if (action === "ingest") {
        expect(body.etag).toBe(md5);
        return Response.json({
          success: true,
          result: { success: true, status: "active", at_bookmark: "bookmark-1" },
        });
      }
      expect(action).toBe("poll");
      expect(body.current_bookmark).toBe("bookmark-1");
      return Response.json({
        success: true,
        result: {
          success: true,
          status: "error",
          error: "no such table: money_cutover_rehearsal_missing_0094_probe",
        },
      });
    };
    const result = await importFailureProbe(
      account,
      databaseId,
      "synthetic-token",
      sql,
      fetcher as typeof fetch,
    );
    expect(actions).toEqual(["init", "upload", "ingest", "poll"]);
    expect(result.uploadHostClass).toBe("cloudflare-r2-system");
    expect(result.presignedUriDigest).toBe(sha(signed));
    expect(result.diagnosticDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("unknown import status and off-family signed upload host refuse", async () => {
    const account = "1".repeat(32);
    const databaseId = "11111111-1111-4111-8111-111111111111";
    const signed = `https://${account}.r2.cloudflarestorage.com/import.sql?X-Amz-Signature=${"a".repeat(64)}&X-Amz-Credential=fixture`;
    expect(classifyMoneyRehearsalUploadUrl(signed, account).hostClass).toBe("selected-account-r2");
    for (const bad of [
      signed.replace("r2.cloudflarestorage.com", "r2.cloudflarestorage.com.evil.test"),
      signed.replace("https:", "http:"),
      signed.replace("X-Amz-Signature", "Unsigned"),
    ]) {
      expect(() => classifyMoneyRehearsalUploadUrl(bad, account)).toThrow();
    }
    const sql = "INSERT INTO money_cutover_rehearsal_missing_0094_probe VALUES (1);\n";
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === "PUT") {
        return new Response("", {
          status: 200,
          headers: { etag: createHash("md5").update(sql).digest("hex") },
        });
      }
      const action = (JSON.parse(String(init?.body)) as { action: string }).action;
      return Response.json({
        success: true,
        result:
          action === "init"
            ? { upload_url: signed, filename: "rehearsal.sql" }
            : { success: true, status: "processing", at_bookmark: "bookmark-1" },
      });
    };
    await expect(
      importFailureProbe(account, databaseId, "synthetic-token", sql, fetcher as typeof fetch),
    ).rejects.toThrow("progress is malformed");
  });
});
