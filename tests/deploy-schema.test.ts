import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { D1SchemaState } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  exactReceiptPath,
  runD1Schema,
  type SchemaProcess,
  type SchemaReader,
} from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";

const COMMIT = "a".repeat(40);
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "rehearsal",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-rehearsal",
  d1: {
    databaseName: "takoserver-runtime-rehearsal",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-rehearsal" },
  publicOrigin: "https://api.rehearsal.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

const integration0043Target = {
  ...target,
  environment: "integration",
  artifactBlobIoMode: "pre-0043-quiesced",
} satisfies DeployTarget;

function migrations(root: string): string {
  const directory = join(root, "source-migrations");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "0001_first.sql"), "CREATE TABLE first (id TEXT);\n");
  writeFileSync(join(directory, "0002_second.sql"), "CREATE TABLE second (id TEXT);\n");
  return directory;
}

function processFixture(environment: "rehearsal" | "production") {
  const calls: string[][] = [];
  const run: SchemaProcess = async (command): Promise<CommandResult> => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") {
      return ok(environment === "production" ? "main\n" : "release/schema\n");
    }
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "git fetch --quiet origin main") return ok("");
    if (key === "git rev-parse origin/main") return ok(`${COMMIT}\n`);
    if (key === "git fetch --quiet --all --prune") return ok("");
    if (key === `git branch -r --contains ${COMMIT}`) return ok("  origin/release-schema\n");
    if (key === "bun run check:migrations") return ok("green\n");
    if (command.includes("migrations") && command.includes("apply")) return ok("applied 0002\n");
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

function readerSequence(states: readonly D1SchemaState[]): SchemaReader {
  let reads = 0;
  return {
    async read() {
      return states[Math.min(reads++, states.length - 1)] as D1SchemaState;
    },
  };
}

function integration0043Reader(states: readonly D1SchemaState[]): SchemaReader {
  let reads = 0;
  return {
    async read() {
      return states[Math.min(reads++, states.length - 1)] as D1SchemaState;
    },
    async legacyRuntimeInputPreparationCount() {
      return 0;
    },
    async installRuntimeInputPreparationV2Quiescence() {
      return { status: "installed", predecessorRowCount: 0 };
    },
    async duplicateLiveNativeClaimCount() {
      return 0;
    },
    async activeRootDeletingArtifactCandidateConflictCount() {
      return 0;
    },
  };
}

function migrationStateThrough(count: number, marker: string): D1SchemaState {
  return {
    applied: MIGRATIONS.slice(0, count).map(({ name }) => name),
    shape: `${marker}\n`,
    shapeDigest: `sha256:${marker.repeat(64).slice(0, 64)}`,
  };
}

function providerRepairReader(
  state: D1SchemaState,
  unmatched: number,
): SchemaReader & { readonly preflightReads: () => number } {
  let reads = 0;
  return {
    async read() {
      return state;
    },
    async unmatchedProviderRepairSagaCount() {
      reads += 1;
      return unmatched;
    },
    preflightReads: () => reads,
  };
}

const PRE: D1SchemaState = {
  applied: ["0001_first.sql"],
  shape: "pre-shape\n",
  shapeDigest: `sha256:${"1".repeat(64)}`,
};
const POST: D1SchemaState = {
  applied: ["0001_first.sql", "0002_second.sql"],
  shape: "post-shape\n",
  shapeDigest: `sha256:${"2".repeat(64)}`,
};

describe("forward-only D1 schema surface", () => {
  test("refuses a receipt path whose symlinked parent lands inside any Git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-receipt-link-"));
    try {
      chmodSync(root, 0o700);
      const repository = join(root, "other-repository");
      const privateDirectory = join(repository, "private");
      mkdirSync(join(repository, ".git"), { recursive: true });
      mkdirSync(privateDirectory, { mode: 0o700 });
      const link = join(root, "linked-parent");
      symlinkSync(privateDirectory, link, "dir");
      expect(() => exactReceiptPath(join(link, "receipt.json"))).toThrow("Git repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status reports the exact ordered pending suffix without mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-status-"));
    try {
      const fixture = processFixture("rehearsal");
      const result = await runD1Schema(
        { action: "status", environment: "integration", commit: COMMIT },
        { ...target, environment: "integration" },
        {
          run: fixture.run,
          reader: readerSequence([PRE]),
          migrationDirectory: migrations(root),
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.d1-schema-status@v3",
        evidenceClass: "integration-only",
        appliedMigrations: ["0001_first.sql"],
        pendingMigrations: ["0002_second.sql"],
        schemaShapeDigest: PRE.shapeDigest,
      });
      expect(fixture.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rehearsal D1 injected readers cannot bypass the explicit token lane", async () => {
    let reads = 0;
    const failure = await runD1Schema(
      { action: "status", environment: "rehearsal", commit: COMMIT, throughMigration: "0028" },
      target,
      {
        reader: {
          async read() {
            reads += 1;
            return PRE;
          },
        },
        cloudflareEnvironment: {},
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("CLOUDFLARE_API_TOKEN is required");
    expect(reads).toBe(0);
  });

  test("status reports dispatched provider sagas that block the 0036 backfill", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-provider-repair-status-"));
    try {
      const repairIndex = MIGRATIONS.findIndex(
        ({ name }) => name === "0036_provider_repair_and_managed_schedule_reconciliation.sql",
      );
      expect(repairIndex).toBeGreaterThan(0);
      const reader = providerRepairReader(
        { ...PRE, applied: MIGRATIONS.slice(0, repairIndex).map(({ name }) => name) },
        1,
      );
      const result = await runD1Schema(
        {
          action: "status",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0036",
        },
        target,
        {
          reader,
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        dataPreflights: {
          providerRepair: {
            status: "operator_reconciliation_required",
            unmatchedDispatchedSagaCount: 1,
          },
        },
      });
      expect(reader.preflightReads()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply refuses 0036 before qualification when unmatched dispatched sagas remain", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-provider-repair-apply-"));
    try {
      const repairIndex = MIGRATIONS.findIndex(
        ({ name }) => name === "0036_provider_repair_and_managed_schedule_reconciliation.sql",
      );
      expect(repairIndex).toBeGreaterThan(0);
      const reader = providerRepairReader(
        { ...PRE, applied: MIGRATIONS.slice(0, repairIndex).map(({ name }) => name) },
        1,
      );
      const fixture = processFixture("rehearsal");
      const failure = await runD1Schema(
        {
          action: "apply",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0036",
        },
        target,
        {
          reader,
          run: fixture.run,
          outputDirectory: join(root, "work"),
          receiptPath: join(root, "receipt.json"),
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("data preflights require operator repair");
      expect(fixture.calls).toHaveLength(0);
      expect(reader.preflightReads()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply refuses an empty pending suffix instead of reporting green", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-current-"));
    try {
      const fixture = processFixture("rehearsal");
      const current = { ...POST, applied: ["0001_first.sql", "0002_second.sql"] };
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        { ...target, environment: "integration" },
        {
          run: fixture.run,
          reader: readerSequence([current]),
          migrationDirectory: migrations(root),
          outputDirectory: join(root, "work"),
          receiptPath: join(root, "receipt.json"),
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("selected D1 migration wave is already complete");
      expect(fixture.calls.some((call) => call.includes("apply"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration no-selector applies the suffix but cannot emit production rehearsal evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-rehearsal-"));
    try {
      chmodSync(root, 0o700);
      const fixture = processFixture("rehearsal");
      const receiptPath = join(root, "receipt.json");
      const result = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        { ...target, environment: "integration" },
        {
          run: fixture.run,
          reader: readerSequence([PRE, PRE, PRE, POST]),
          migrationDirectory: migrations(root),
          outputDirectory: join(root, "work"),
          receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.d1-schema-apply@v3",
        evidenceClass: "integration-only",
        pendingMigrations: ["0002_second.sql"],
        postShapeDigest: POST.shapeDigest,
        rehearsalReceipt: "not-emitted-integration-evidence-is-never-production-acceptable",
        rollback: "forward repair only: D1 migrations have no down path",
      });
      expect(
        fixture.calls.filter((call) => call.join(" ") === "bun run check:migrations"),
      ).toHaveLength(1);
      const applies = fixture.calls.filter(
        (call) => call.includes("migrations") && call.includes("apply"),
      );
      expect(applies).toHaveLength(1);
      expect(applies[0]).toContain(target.d1.databaseName);
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration D1 dispatch resolves OAuth and leaves Wrangler children token-free", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-oauth-"));
    try {
      const fixture = processFixture("rehearsal");
      const oauthToken = "d1-oauth-token-only-in-process";
      const calls: {
        readonly command: readonly string[];
        readonly env: Readonly<Record<string, string>>;
      }[] = [];
      const run: SchemaProcess = async (command, options) => {
        calls.push({ command: [...command], env: options?.env ?? {} });
        if (command.slice(-3).join(" ") === "auth token --json") {
          return ok(JSON.stringify({ type: "oauth", token: oauthToken }));
        }
        return await fixture.run(command, options);
      };
      const result = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        { ...target, environment: "integration" },
        {
          run,
          reader: readerSequence([PRE, PRE, PRE, POST]),
          migrationDirectory: migrations(root),
          outputDirectory: join(root, "work"),
          receiptPath: join(root, "receipt.json"),
          review: "reviewer@example.test",
          cloudflareEnvironment: {},
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.d1-schema-apply@v3",
        environment: "integration",
      });
      const wranglerCalls = calls.filter((entry) => entry.command[0]?.endsWith("/wrangler"));
      expect(wranglerCalls.length).toBeGreaterThan(0);
      expect(wranglerCalls.every(({ env }) => env.CLOUDFLARE_API_TOKEN === undefined)).toBe(true);
      expect(
        calls.find(({ command }) => command.slice(-3).join(" ") === "auth token --json")?.env,
      ).toEqual({ WRANGLER_WRITE_LOGS: "false" });
      expect(JSON.stringify(wranglerCalls)).not.toContain(oauthToken);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration pending-0043 dispatch passes the OAuth bearer to compatibility reads only", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-oauth-0043-"));
    try {
      const oauthToken = "d1-0043-oauth-token-only-in-process";
      const calls: {
        readonly command: readonly string[];
        readonly env: Readonly<Record<string, string>>;
      }[] = [];
      const compatibilityReads: {
        readonly phase: string;
        readonly bearerToken: string | undefined;
      }[] = [];
      const fixture = processFixture("rehearsal");
      const run: SchemaProcess = async (command, options) => {
        calls.push({ command: [...command], env: options?.env ?? {} });
        if (command.slice(-3).join(" ") === "auth token --json") {
          return ok(JSON.stringify({ type: "oauth", token: oauthToken }));
        }
        return await fixture.run(command, options);
      };
      const pre = migrationStateThrough(36, "oauth-0043-pre");
      const post = migrationStateThrough(46, "oauth-0046-post");
      const result = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        integration0043Target,
        {
          run,
          reader: integration0043Reader([pre, pre, pre, post]),
          migrationDirectory: resolve(import.meta.dir, "../migrations"),
          outputDirectory: join(root, "work"),
          review: "reviewer@example.test",
          artifactBlobIoCompatibilityReader: async (phase, context) => {
            compatibilityReads.push({ phase, bearerToken: context.bearerToken });
            return {
              status: "ready",
              currentCompatibilityDeploymentId: "10000000-0000-4000-8000-000000000043",
              rollbackCompatibilityDeploymentId: "10000000-0000-4000-8000-000000000042",
              currentCompatibilityVersionId: "00000000-0000-4000-8000-000000000043",
              rollbackCompatibilityVersionId: "00000000-0000-4000-8000-000000000042",
              unsafePredecessorInvocations: "drained-or-cancelled",
            };
          },
          cloudflareEnvironment: {},
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.d1-schema-apply@v3",
        environment: "integration",
        pendingMigrations: [
          "0037_worker_runtime_input_preparation_v2.sql",
          "0038_selfhost_edge_kv.sql",
          "0039_takoform_live_native_claim_across_tenants.sql",
          "0040_selfhost_queues_and_schedules.sql",
          "0041_selfhost_object_buckets.sql",
          "0042_worker_endpoint_origin_reservation_space_id.sql",
          "0043_artifact_blob_io_fences.sql",
          "0044_artifact_consumer_resolution_receipts.sql",
          "0045_cloudflare_provider_executor_operations.sql",
          "0046_exact_artifact_recovery_receipts.sql",
        ],
      });
      expect(compatibilityReads).toHaveLength(4);
      expect(compatibilityReads.every(({ bearerToken }) => bearerToken === oauthToken)).toBe(true);

      const wranglerCalls = calls.filter((entry) => entry.command[0]?.endsWith("/wrangler"));
      expect(wranglerCalls.length).toBeGreaterThan(0);
      expect(wranglerCalls.every(({ env }) => env.CLOUDFLARE_API_TOKEN === undefined)).toBe(true);
      expect(JSON.stringify(wranglerCalls)).not.toContain(oauthToken);
      expect(JSON.stringify(result)).not.toContain(oauthToken);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("production requires the exact rehearsal digest and shape before its one apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-production-"));
    try {
      chmodSync(root, 0o700);
      const rehearsal = processFixture("rehearsal");
      const receiptPath = join(root, "receipt.json");
      const pre = {
        ...PRE,
        applied: MIGRATIONS.slice(0, 22).map(({ name }) => name),
      };
      const post = {
        ...POST,
        applied: MIGRATIONS.slice(0, 28).map(({ name }) => name),
      };
      await runD1Schema(
        {
          action: "apply",
          environment: "rehearsal",
          commit: COMMIT,
          throughMigration: "0028",
        },
        target,
        {
          run: rehearsal.run,
          reader: readerSequence([pre, pre, pre, post]),
          outputDirectory: join(root, "rehearsal-work"),
          receiptPath,
          review: "reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      const productionTarget = { ...target, environment: "production" as const };
      const production = processFixture("production");
      const result = await runD1Schema(
        {
          action: "apply",
          environment: "production",
          commit: COMMIT,
          throughMigration: "0028",
        },
        productionTarget,
        {
          run: production.run,
          reader: readerSequence([pre, pre, pre, post]),
          outputDirectory: join(root, "production-work"),
          receiptPath,
          review: "second-reviewer@example.test",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        environment: "production",
        postShapeDigest: post.shapeDigest,
      });
      expect(
        production.calls.filter((call) => call.includes("migrations") && call.includes("apply")),
      ).toHaveLength(1);

      const exactReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      for (const [index, field] of [
        "preShapeDigest",
        "fromMigration",
        "throughMigration",
        "migrationDigest",
        "throughPrefixDigest",
      ].entries()) {
        const malformed = structuredClone(exactReceipt);
        malformed[field] = `drift-${field}`;
        const badReceiptPath = join(root, `bad-receipt-${index}.json`);
        writeFileSync(badReceiptPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
        const refusedProcess = processFixture("production");
        const refused = await runD1Schema(
          {
            action: "apply",
            environment: "production",
            commit: COMMIT,
            throughMigration: "0028",
          },
          productionTarget,
          {
            run: refusedProcess.run,
            reader: readerSequence([pre, pre]),
            outputDirectory: join(root, `refused-work-${index}`),
            receiptPath: badReceiptPath,
            review: "second-reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ).catch((error) => error);
        expect(refused).toBeInstanceOf(DeployError);
        expect(refused.message).toContain("rehearsal receipt");
        expect(refusedProcess.calls.some((call) => call.includes("apply"))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
