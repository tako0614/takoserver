import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type {
  IntegrationStorageD1Database,
  IntegrationStorageGenerationProcess,
} from "../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape, type D1SchemaState } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  PRODUCTION_D1_FRESH_INIT_SURFACE,
  PRODUCTION_FRESH_D1_PREFIX,
  type ProductionD1FreshInitInvocation,
  type ProductionD1FreshInitOptions,
  type ProductionD1FreshInitProvider,
  runProductionD1FreshInit,
} from "../scripts/deploy/production-d1-fresh-init.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "takoserver-production-d1-tests-"));
const currentMigrations = copyCurrentSchemaFixture(join(fixtureRoot, "current-migrations"));
const expectedApplicationShape = applicationShape(currentMigrations);
const COMMIT = "a".repeat(40);
const GENERATION = "b".repeat(32);
const APPLY_MIGRATIONS = MIGRATIONS.slice(0, 66);
const ACCOUNT_ID = "a10162d23653f1ad1193dabf520a5dd0";
const DATABASE_ID = "00000000-0000-4000-8000-000000000061";
const INCUMBENT_DATABASE = "takoserver-runtime-ga-20260820";
const INCUMBENT_ID = "1d5d828a-8607-41f2-b67e-c1a0cac3c139";
const INCUMBENT_BUCKET = "takoserver-objects-ga-20260820";
const FRESH_NAME = `${PRODUCTION_FRESH_D1_PREFIX}${GENERATION}`;

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "production",
  accountId: ACCOUNT_ID,
  workerName: "takoserver-api",
  d1: { databaseName: INCUMBENT_DATABASE, databaseId: INCUMBENT_ID },
  r2: { bucketName: INCUMBENT_BUCKET },
  publicOrigin: "https://api.example.test",
  signing: { currentKeyId: "production-current" },
} satisfies DeployTarget;

const invocation = {
  action: "apply",
  environment: "production",
  commit: COMMIT,
  generation: GENERATION,
} satisfies ProductionD1FreshInitInvocation;

const emptyState = stateWithShape([], "[]\n");
const completeState = stateWithShape(
  APPLY_MIGRATIONS.map(({ name }) => name),
  expectedApplicationShape,
);

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function stateWithShape(applied: readonly string[], shape: string): D1SchemaState {
  return {
    applied,
    shape,
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
  };
}

function applicationShape(directory: string): string {
  const database = new Database(":memory:");
  try {
    for (const name of readdirSync(directory).sort().slice(0, 66)) {
      database.exec(readFileSync(join(directory, name), "utf8"));
    }
    const rows = database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
          "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[];
    return canonicalSchemaShape(
      rows.filter(
        (row) =>
          row.name !== "d1_migrations" &&
          row.tbl_name !== "d1_migrations" &&
          row.name !== "_cf_KV" &&
          row.tbl_name !== "_cf_KV",
      ),
    );
  } finally {
    database.close();
  }
}

function ok(stdout = ""): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function processFixture(options: { readonly dirty?: boolean } = {}): {
  readonly run: IntegrationStorageGenerationProcess;
  readonly commands: string[][];
} {
  const commands: string[][] = [];
  const run: IntegrationStorageGenerationProcess = async (command) => {
    commands.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("release-candidate\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") {
      return ok(options.dirty === true ? "?? scratch.txt\0" : "");
    }
    if (key === "git fetch --quiet --all --prune") return ok();
    if (key === `git branch -r --contains ${COMMIT}`) return ok("  origin/main\n");
    if (key === "bun run check:migrations") return ok("green\n");
    if (command.includes("execute") && command.includes("--file")) return ok("applied\n");
    throw new Error(`unexpected qualification command ${key}`);
  };
  return { run, commands };
}

function providerFixture(
  input: {
    readonly existing?: IntegrationStorageD1Database;
    readonly created?: IntegrationStorageD1Database;
    readonly failCreate?: boolean;
  } = {},
): {
  readonly provider: ProductionD1FreshInitProvider;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let created = input.created;
  return {
    calls,
    provider: {
      async listD1(name) {
        calls.push(`listD1:${name}`);
        return input.existing === undefined ? [] : [input.existing];
      },
      async createD1(name) {
        calls.push(`createD1:${name}`);
        if (input.failCreate === true) throw new Error("lost create acknowledgement");
        created = input.created ?? { name, uuid: DATABASE_ID };
        return created;
      },
      async getD1(databaseId) {
        calls.push(`getD1:${databaseId}`);
        return created ?? { name: FRESH_NAME, uuid: databaseId };
      },
    },
  };
}

function options(
  provider: ProductionD1FreshInitProvider,
  states: readonly D1SchemaState[] = [emptyState, completeState],
  process = processFixture(),
): ProductionD1FreshInitOptions {
  let reads = 0;
  return {
    provider,
    run: process.run,
    review: "independent-reviewer",
    migrationDirectory: currentMigrations,
    reader: {
      async read() {
        return states[Math.min(reads++, states.length - 1)] as D1SchemaState;
      },
    },
  };
}

async function rejected(operation: Promise<unknown>): Promise<DeployError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(DeployError);
    if (!(error instanceof DeployError)) throw error;
    return error;
  }
  throw new Error("Expected the operation to reject");
}

describe("production D1 fresh init", () => {
  test("status is the side-effect-free dry run and reports the planned identity", async () => {
    const fixture = providerFixture();
    const result = await runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
      provider: fixture.provider,
      migrationDirectory: currentMigrations,
    });
    expect(result).toMatchObject({
      kind: "takoserver.production-d1-fresh-init-status@v1",
      surface: PRODUCTION_D1_FRESH_INIT_SURFACE,
      environment: "production",
      generation: GENERATION,
      d1: { databaseName: FRESH_NAME, databaseId: null, present: false },
      migrationCount: APPLY_MIGRATIONS.length,
      throughMigration: APPLY_MIGRATIONS[APPLY_MIGRATIONS.length - 1]?.name,
      readyForApply: true,
    });
    expect(result.incumbent).toMatchObject({
      databaseName: INCUMBENT_DATABASE,
      databaseId: INCUMBENT_ID,
    });
    expect(fixture.calls).toEqual([`listD1:${FRESH_NAME}`]);
  });

  test("status never adopts an existing database of the derived name", async () => {
    const fixture = providerFixture({
      existing: { name: FRESH_NAME, uuid: DATABASE_ID },
    });
    const result = await runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
      provider: fixture.provider,
      migrationDirectory: currentMigrations,
    });
    expect(result).toMatchObject({
      d1: { databaseName: FRESH_NAME, databaseId: DATABASE_ID, present: true },
      readyForApply: false,
    });
    expect(fixture.calls).toEqual([`listD1:${FRESH_NAME}`]);
  });

  test("source-tail drift is refused before production D1 provider access", async () => {
    for (const drift of ["missing", "changed", "extra"] as const) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-fresh-source-${drift}-`));
      try {
        const migrationDirectory = join(root, "migrations");
        cpSync(currentMigrations, migrationDirectory, { recursive: true });
        const tail = join(migrationDirectory, "0068_cloudflare_provider_invocation_custody.sql");
        if (drift === "missing") rmSync(tail);
        else if (drift === "changed") {
          writeFileSync(tail, `${readFileSync(tail, "utf8")}\n-- changed\n`);
        } else {
          writeFileSync(
            join(migrationDirectory, "0069_unreviewed.sql"),
            "CREATE TABLE unreviewed (id TEXT);\n",
          );
        }
        const fixture = providerFixture();
        await expect(
          runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
            provider: fixture.provider,
            migrationDirectory,
          }),
        ).rejects.toThrow(
          drift === "changed"
            ? "exact audited migration SHA-256"
            : "audited migration lineage must contain exactly 0001-0068",
        );
        expect(fixture.calls).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("apply creates one empty production database and applies the exact 0001-0066 lineage", async () => {
    const fixture = providerFixture();
    const process = processFixture();
    const result = await runProductionD1FreshInit(
      invocation,
      target,
      options(fixture.provider, [emptyState, completeState], process),
    );
    expect(result).toMatchObject({
      kind: "takoserver.production-d1-fresh-init-apply@v1",
      surface: PRODUCTION_D1_FRESH_INIT_SURFACE,
      environment: "production",
      commit: COMMIT,
      remoteRef: "origin/main",
      reviewer: "independent-reviewer",
      d1: { databaseName: FRESH_NAME, databaseId: DATABASE_ID },
      schemaShapeDigest: completeState.shapeDigest,
      appliedMigrations: APPLY_MIGRATIONS.map(({ name }) => name),
      targetBinding: { status: "not-written" },
    });
    expect(result.incumbent).toMatchObject({ databaseName: INCUMBENT_DATABASE });
    expect(fixture.calls).toEqual([
      `listD1:${FRESH_NAME}`,
      `listD1:${FRESH_NAME}`,
      `createD1:${FRESH_NAME}`,
      `getD1:${DATABASE_ID}`,
      `getD1:${DATABASE_ID}`,
    ]);
    expect(process.commands.some((command) => command.includes("execute"))).toBe(true);
  });

  test("apply carries the explicit production token to the single migration import child", async () => {
    // Regression: the migration import runs as a Wrangler child. If the resolved
    // child environment is lost, that child falls back to Wrangler's stored OAuth
    // profile - exactly the fallback this production surface denies. The provider
    // and reader seams used elsewhere in this file cannot see that, so this case
    // runs the surface with neither and asserts the environment the child receives.
    const commands: Array<{
      readonly command: readonly string[];
      readonly env: Readonly<Record<string, string>> | undefined;
    }> = [];
    const run: IntegrationStorageGenerationProcess = async (command, runOptions) => {
      commands.push({ command: [...command], env: runOptions?.env });
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
      if (key === "git branch --show-current") return ok("release-candidate\n");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok();
      if (key === "git fetch --quiet --all --prune") return ok();
      if (key === `git branch -r --contains ${COMMIT}`) return ok("  origin/main\n");
      if (key === "bun run check:migrations") return ok("green\n");
      if (command.includes("execute") && command.includes("--file")) return ok("applied\n");
      throw new Error(`unexpected qualification command ${key}`);
    };
    const outputDirectory = mkdtempSync(join(tmpdir(), "takoserver-production-token-"));
    let reads = 0;
    try {
      const result = await runProductionD1FreshInit(invocation, target, {
        run,
        review: "independent-reviewer",
        migrationDirectory: currentMigrations,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "production-deploy-token" },
        outputDirectory,
        reader: {
          async read() {
            reads += 1;
            return reads === 1 ? emptyState : completeState;
          },
        },
        fetcher: async (request) => {
          const url = new URL(request.url);
          if (url.pathname.endsWith(`/d1/database/${DATABASE_ID}`)) {
            return jsonResponse({
              success: true,
              result: { uuid: DATABASE_ID, name: FRESH_NAME },
            });
          }
          if (url.pathname.endsWith("/d1/database") && request.method === "POST") {
            return jsonResponse({
              success: true,
              result: { uuid: DATABASE_ID, name: FRESH_NAME },
            });
          }
          if (url.pathname.endsWith("/d1/database")) {
            return jsonResponse({
              success: true,
              result: [],
              result_info: { page: 1, per_page: 100, count: 0, total_count: 0 },
            });
          }
          throw new Error(`unexpected Cloudflare request ${url.pathname}`);
        },
      });
      expect(result.d1).toEqual({ databaseName: FRESH_NAME, databaseId: DATABASE_ID });
      const sealedMigrations = join(outputDirectory, "release", "payload", "migrations");
      expect(readdirSync(sealedMigrations).sort()).toEqual(
        APPLY_MIGRATIONS.map(({ name }) => name),
      );
      const migrationImport = readFileSync(
        join(outputDirectory, "release", "payload", "migration-import.sql"),
        "utf8",
      );
      expect(migrationImport).toContain("0066_cloudflare_managed_actor_kv_capability_claims.sql");
      expect(migrationImport).not.toContain("0067_takoform_container_endpoint_hostname_index.sql");
      expect(migrationImport).not.toContain("0068_cloudflare_provider_invocation_custody.sql");
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
    const imports = commands.filter((entry) => entry.command.includes("execute"));
    expect(imports).toHaveLength(1);
    expect(imports[0]?.env).toEqual({ CLOUDFLARE_API_TOKEN: "production-deploy-token" });
  });

  test("apply refuses without an independent reviewer before any provider access", async () => {
    const fixture = providerFixture();
    const qualification = processFixture();
    const error = await rejected(
      runProductionD1FreshInit(invocation, target, {
        provider: fixture.provider,
        run: qualification.run,
        migrationDirectory: currentMigrations,
      }),
    );
    expect(error.phase).toBe("preflight");
    expect(fixture.calls).toEqual([]);
  });

  test("apply is production-only for both the environment and the target", async () => {
    const fixture = providerFixture();
    const rehearsal = await rejected(
      runProductionD1FreshInit(
        { ...invocation, environment: "rehearsal" },
        target,
        options(fixture.provider),
      ),
    );
    expect(rehearsal.phase).toBe("preflight");
    const integrationTarget = await rejected(
      runProductionD1FreshInit(
        invocation,
        { ...target, environment: "integration" },
        options(fixture.provider),
      ),
    );
    expect(integrationTarget.phase).toBe("preflight");
    expect(fixture.calls).toEqual([]);
  });

  test("apply refuses a derived name that collides with the incumbent storage", async () => {
    const fixture = providerFixture();
    const collidingDatabase = await rejected(
      runProductionD1FreshInit(
        invocation,
        { ...target, d1: { databaseName: FRESH_NAME, databaseId: INCUMBENT_ID } },
        options(fixture.provider),
      ),
    );
    expect(collidingDatabase.message).toContain("collides");
    const collidingBucket = await rejected(
      runProductionD1FreshInit(
        invocation,
        { ...target, r2: { bucketName: FRESH_NAME } },
        options(fixture.provider),
      ),
    );
    expect(collidingBucket.message).toContain("collides");
    expect(fixture.calls).toEqual([]);
  });

  test("apply refuses an existing fresh name and never adopts or resets it", async () => {
    const fixture = providerFixture({ existing: { name: FRESH_NAME, uuid: DATABASE_ID } });
    const error = await rejected(
      runProductionD1FreshInit(invocation, target, options(fixture.provider)),
    );
    expect(error.phase).toBe("preflight");
    expect(fixture.calls).toEqual([`listD1:${FRESH_NAME}`]);
  });

  test("apply refuses a dirty worktree before any provider operation", async () => {
    const fixture = providerFixture();
    const process = processFixture({ dirty: true });
    const error = await rejected(
      runProductionD1FreshInit(
        invocation,
        target,
        options(fixture.provider, [emptyState], process),
      ),
    );
    expect(error.phase).toBe("preflight");
    expect(fixture.calls).toEqual([]);
  });

  test("a failed migration gate refuses before the create", async () => {
    const fixture = providerFixture();
    const gate = async (command: readonly string[]): Promise<CommandResult> => {
      if (command.join(" ") === "bun run check:migrations")
        return { exitCode: 1, stdout: "", stderr: "" };
      return await processFixture().run(command);
    };
    const error = await rejected(
      runProductionD1FreshInit(invocation, target, {
        provider: fixture.provider,
        run: gate,
        review: "independent-reviewer",
        migrationDirectory: currentMigrations,
      }),
    );
    expect(error.phase).toBe("preflight");
    expect(fixture.calls).toEqual([]);
  });

  test("a lost create acknowledgement is indeterminate and is never retried", async () => {
    const fixture = providerFixture({ failCreate: true });
    const error = await rejected(
      runProductionD1FreshInit(invocation, target, options(fixture.provider)),
    );
    expect(error.phase).toBe("mutation");
    expect(fixture.calls.filter((call) => call.startsWith("createD1:"))).toHaveLength(1);
  });

  test("a database that is not exactly empty withholds the migration", async () => {
    const fixture = providerFixture();
    const process = processFixture();
    const notEmpty = stateWithShape(["0001_runtime_storage.sql"], "[]\n");
    const error = await rejected(
      runProductionD1FreshInit(
        invocation,
        target,
        options(fixture.provider, [notEmpty, completeState], process),
      ),
    );
    expect(error.phase).toBe("mutation");
    expect(error.message).toContain("not exactly empty");
    expect(process.commands.some((command) => command.includes("execute"))).toBe(false);
  });

  test("a readback that is not the exact audited lineage fails verification", async () => {
    const fixture = providerFixture();
    const truncated = stateWithShape(
      MIGRATIONS.slice(0, 22).map(({ name }) => name),
      expectedApplicationShape,
    );
    const error = await rejected(
      runProductionD1FreshInit(
        invocation,
        target,
        options(fixture.provider, [emptyState, truncated]),
      ),
    );
    expect(error.phase).toBe("verification");
    expect(error.message).toContain("0001-0066");
  });

  test("apply refuses a malformed generation, commit or account before provider access", async () => {
    const fixture = providerFixture();
    const badGeneration = await rejected(
      runProductionD1FreshInit(
        { ...invocation, generation: "not-hex" },
        target,
        options(fixture.provider),
      ),
    );
    expect(badGeneration.phase).toBe("preflight");
    const badCommit = await rejected(
      runProductionD1FreshInit({ ...invocation, commit: "abc" }, target, options(fixture.provider)),
    );
    expect(badCommit.phase).toBe("preflight");
    const badAccount = await rejected(
      runProductionD1FreshInit(
        invocation,
        { ...target, accountId: "nope" },
        options(fixture.provider),
      ),
    );
    expect(badAccount.phase).toBe("preflight");
    expect(fixture.calls).toEqual([]);
  });

  test("the surface requires an explicit production token when no provider seam is injected", async () => {
    const error = await rejected(
      runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
        cloudflareEnvironment: {},
        migrationDirectory: currentMigrations,
      }),
    );
    expect(error.phase).toBe("preflight");
    expect(error.message).toContain("CLOUDFLARE_API_TOKEN");
  });
});
