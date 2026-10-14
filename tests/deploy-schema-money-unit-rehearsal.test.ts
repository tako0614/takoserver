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
} from "../scripts/deploy/schema-money-unit-rehearsal.ts";

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

describe("money-unit native rehearsal source", () => {
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
