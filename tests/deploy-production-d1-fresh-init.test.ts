import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationSchemaMatches } from "../scripts/deploy/application-schema-shape.ts";
import { DEPLOY_CONTRACT } from "../scripts/deploy/contract.ts";
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
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "takoserver-production-d1-tests-"));
const currentMigrations = copyCurrentSchemaFixture(join(fixtureRoot, "current-migrations"));
const APPLY_MIGRATIONS = MIGRATIONS.slice(0, 69);
const expectedApplicationShape = applicationShape(currentMigrations);
const COMMIT = "a".repeat(40);
const GENERATION = "b".repeat(32);
const ACCOUNT_ID = "a10162d23653f1ad1193dabf520a5dd0";
const DATABASE_ID = "00000000-0000-4000-8000-000000000061";
const INCUMBENT_DATABASE = "takoserver-runtime-ga-20260820";
const INCUMBENT_ID = "1d5d828a-8607-41f2-b67e-c1a0cac3c139";
const INCUMBENT_BUCKET = "takoserver-objects-ga-20260820";
const FRESH_NAME = `${PRODUCTION_FRESH_D1_PREFIX}${GENERATION}`;
const newCustodyDirectory = () => mkdtempSync(join(fixtureRoot, "custody-"));

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
    for (const { name } of APPLY_MIGRATIONS) {
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
    readonly onCreate?: () => void;
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
        const observed = input.existing ?? created;
        return observed === undefined ? [] : [observed];
      },
      async createD1(name) {
        calls.push(`createD1:${name}`);
        input.onCreate?.();
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
    custodyDirectory: newCustodyDirectory(),
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
  test("declares the kernel lease tool needed before its create boundary", () => {
    const surface = DEPLOY_CONTRACT.surfaces.find(
      ({ surface }) => surface === PRODUCTION_D1_FRESH_INIT_SURFACE,
    );
    expect(surface?.requiresTools).toContain("flock");
    expect(surface?.covers).toContain("scripts/deploy/wrangler-state.ts");
  });

  test("fresh production stays at 0069 while self-host source bootstraps through 0073", () => {
    const database = new Database(":memory:");
    try {
      const report = migrateSqlite(database);
      expect(report.applied).toEqual(MIGRATIONS.map(({ name }) => name));
      const rows = database
        .query(
          "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
            "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Record<string, unknown>[];
      const selfhostShape = canonicalSchemaShape(
        rows.filter((row) => row.name !== "applied_migrations"),
      );
      expect(
        applicationSchemaMatches(stateWithShape([], selfhostShape), expectedApplicationShape),
      ).toBe(false);
      expect(database.query("SELECT 1 FROM tf_v2_resources LIMIT 1").all()).toEqual([]);
      expect(APPLY_MIGRATIONS.at(-1)?.name).toBe(
        "0069_cloudflare_provider_invocation_delete_ack.sql",
      );
    } finally {
      database.close();
    }
  });
  test("status is the side-effect-free dry run and reports the planned identity", async () => {
    const fixture = providerFixture();
    const result = await runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
      provider: fixture.provider,
      custodyDirectory: newCustodyDirectory(),
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
      custodyDirectory: newCustodyDirectory(),
      migrationDirectory: currentMigrations,
    });
    expect(result).toMatchObject({
      d1: { databaseName: FRESH_NAME, databaseId: DATABASE_ID, present: true },
      readyForApply: false,
    });
    expect(fixture.calls).toEqual([`listD1:${FRESH_NAME}`]);
  });

  test("missing or malformed private attempt custody refuses before provider access", async () => {
    const fixture = providerFixture();
    const missing = join(fixtureRoot, "missing-custody");
    const error = await rejected(
      runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
        provider: fixture.provider,
        migrationDirectory: currentMigrations,
        custodyDirectory: missing,
      }),
    );
    expect(error.phase).toBe("preflight");
    expect(fixture.calls).toEqual([]);

    const nonPrivate = newCustodyDirectory();
    chmodSync(nonPrivate, 0o755);
    const permissions = await rejected(
      runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
        provider: fixture.provider,
        migrationDirectory: currentMigrations,
        custodyDirectory: nonPrivate,
      }),
    );
    expect(permissions.phase).toBe("preflight");
    const alias = join(fixtureRoot, "custody-symlink");
    symlinkSync(newCustodyDirectory(), alias);
    const symlink = await rejected(
      runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
        provider: fixture.provider,
        migrationDirectory: currentMigrations,
        custodyDirectory: alias,
      }),
    );
    expect(symlink.phase).toBe("preflight");
    expect(fixture.calls).toEqual([]);

    const custodyDirectory = newCustodyDirectory();
    const lostCreate = providerFixture({ failCreate: true });
    await rejected(
      runProductionD1FreshInit(invocation, target, {
        ...options(lostCreate.provider),
        custodyDirectory,
      }),
    );
    const intent = readdirSync(custodyDirectory).find((name) => name.endsWith(".intent.json"));
    expect(intent).toBeDefined();
    writeFileSync(join(custodyDirectory, intent as string), '{"bad":true}\n');
    const malformed = await rejected(
      runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
        provider: fixture.provider,
        migrationDirectory: currentMigrations,
        custodyDirectory,
      }),
    );
    expect(malformed.phase).toBe("mutation");
    expect(fixture.calls).toEqual([]);
  });

  test("source-tail drift is refused before production D1 provider access", async () => {
    for (const drift of ["missing", "changed", "extra"] as const) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-fresh-source-${drift}-`));
      try {
        const migrationDirectory = join(root, "migrations");
        cpSync(currentMigrations, migrationDirectory, { recursive: true });
        const tail = join(migrationDirectory, "0073_v2_reference_acceptance.sql");
        if (drift === "missing") rmSync(tail);
        else if (drift === "changed") {
          writeFileSync(tail, `${readFileSync(tail, "utf8")}\n-- changed\n`);
        } else {
          writeFileSync(
            join(migrationDirectory, "0074_unreviewed.sql"),
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
            : "audited migration lineage must contain exactly 0001-0073",
        );
        expect(fixture.calls).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("apply creates one empty production database and applies the exact 0001-0069 lineage", async () => {
    const custodyDirectory = newCustodyDirectory();
    const fixture = providerFixture({
      onCreate() {
        expect(readdirSync(custodyDirectory).some((name) => name.endsWith(".intent.json"))).toBe(
          true,
        );
      },
    });
    const process = processFixture();
    const result = await runProductionD1FreshInit(invocation, target, {
      ...options(fixture.provider, [emptyState, completeState], process),
      custodyDirectory,
    });
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

  test("a completed generation reopens as read-only complete and cannot dispatch again", async () => {
    const fixture = providerFixture();
    const custodyDirectory = newCustodyDirectory();
    await runProductionD1FreshInit(invocation, target, {
      ...options(fixture.provider),
      custodyDirectory,
    });
    const status = await runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
      provider: fixture.provider,
      migrationDirectory: currentMigrations,
      custodyDirectory,
      reader: {
        async read() {
          return completeState;
        },
      },
    });
    expect(status).toMatchObject({
      attemptState: "complete",
      readyForApply: false,
      d1: { databaseId: DATABASE_ID, present: true },
    });
    const calls = [...fixture.calls];
    const repeated = await rejected(
      runProductionD1FreshInit(invocation, target, {
        ...options(fixture.provider),
        custodyDirectory,
      }),
    );
    expect(repeated.message).toContain("retained attempt");
    expect(fixture.calls).toEqual(calls);
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
        custodyDirectory: newCustodyDirectory(),
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
      expect(migrationImport).toContain("0067_takoform_container_endpoint_hostname_index.sql");
      expect(migrationImport).toContain("0068_cloudflare_provider_invocation_custody.sql");
      expect(migrationImport).toContain("0069_cloudflare_provider_invocation_delete_ack.sql");
      expect(migrationImport).not.toContain("0070_takoform_v2.sql");
      expect(migrationImport).not.toContain("0071_v2_sqlite_migration_set_custody.sql");
      expect(migrationImport).not.toContain("0072_v2_artifact_custody.sql");
      expect(migrationImport).not.toContain("0073_v2_reference_acceptance.sql");
      const imported = new Database(":memory:");
      try {
        imported.exec(migrationImport);
        expect(
          (
            imported.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
          ).map(({ name }) => name),
        ).toEqual(APPLY_MIGRATIONS.map(({ name }) => name));
        const importedRows = imported
          .query(
            "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
              "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all() as Record<string, unknown>[];
        const importedShape = canonicalSchemaShape(
          importedRows.filter(
            (row) => row.name !== "d1_migrations" && row.tbl_name !== "d1_migrations",
          ),
        );
        expect(
          applicationSchemaMatches(stateWithShape([], importedShape), expectedApplicationShape),
        ).toBe(true);
      } finally {
        imported.close();
      }
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
        custodyDirectory: newCustodyDirectory(),
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
        custodyDirectory: newCustodyDirectory(),
        migrationDirectory: currentMigrations,
      }),
    );
    expect(error.phase).toBe("preflight");
    expect(fixture.calls).toEqual([]);
  });

  test("a lost create acknowledgement is indeterminate and is never retried", async () => {
    const fixture = providerFixture({ failCreate: true });
    const custodyDirectory = newCustodyDirectory();
    const error = await rejected(
      runProductionD1FreshInit(invocation, target, {
        ...options(fixture.provider),
        custodyDirectory,
      }),
    );
    expect(error.phase).toBe("mutation");
    expect(fixture.calls.filter((call) => call.startsWith("createD1:"))).toHaveLength(1);
    const repeated = await rejected(
      runProductionD1FreshInit(invocation, target, {
        ...options(fixture.provider),
        custodyDirectory,
      }),
    );
    expect(repeated.message).toContain("retained attempt");
    expect(fixture.calls.filter((call) => call.startsWith("createD1:"))).toHaveLength(1);
    const wrongTarget = await rejected(
      runProductionD1FreshInit(
        { ...invocation, action: "status" },
        { ...target, r2: { bucketName: "another-bucket" } },
        { provider: fixture.provider, migrationDirectory: currentMigrations, custodyDirectory },
      ),
    );
    expect(wrongTarget.phase).toBe("mutation");
    const status = await runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
      provider: fixture.provider,
      migrationDirectory: currentMigrations,
      custodyDirectory,
    });
    expect(status).toMatchObject({ attemptState: "pending", readyForApply: false });
    const source = new URL("../scripts/deploy/production-d1-fresh-init.ts", import.meta.url)
      .pathname;
    const reopened = Bun.spawnSync([
      process.execPath,
      "-e",
      `import { runProductionD1FreshInit } from ${JSON.stringify(source)};
       const status = await runProductionD1FreshInit(
         ${JSON.stringify({ ...invocation, action: "status" })},
         ${JSON.stringify(target)},
         {
           provider: { async listD1() { return []; }, async getD1() { throw Error("unused"); }, async createD1() { throw Error("must not create"); } },
           migrationDirectory: ${JSON.stringify(currentMigrations)},
           custodyDirectory: ${JSON.stringify(custodyDirectory)}
         }
       );
       console.log(JSON.stringify({ attemptState: status.attemptState, readyForApply: status.readyForApply }));`,
    ]);
    expect(reopened.exitCode).toBe(0);
    expect(new TextDecoder().decode(reopened.stdout).trim()).toBe(
      JSON.stringify({ attemptState: "pending", readyForApply: false }),
    );
  });

  test("concurrent same-generation applies dispatch at most one create and import", async () => {
    const fixture = providerFixture();
    const custodyDirectory = newCustodyDirectory();
    const runs = await Promise.allSettled([
      runProductionD1FreshInit(invocation, target, {
        ...options(fixture.provider),
        custodyDirectory,
      }),
      runProductionD1FreshInit(invocation, target, {
        ...options(fixture.provider),
        custodyDirectory,
      }),
    ]);
    expect(runs.filter((run) => run.status === "fulfilled")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "rejected")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.startsWith("createD1:"))).toHaveLength(1);
  });

  test("a lost import acknowledgement does not redispatch against a present exact generation", async () => {
    const fixture = providerFixture();
    const process = processFixture();
    const custodyDirectory = newCustodyDirectory();
    let imports = 0;
    const run: IntegrationStorageGenerationProcess = async (command, runOptions) => {
      if (command.includes("execute") && command.includes("--file")) {
        imports += 1;
        throw new Error("lost import acknowledgement");
      }
      return await process.run(command, runOptions);
    };
    const error = await rejected(
      runProductionD1FreshInit(invocation, target, {
        ...options(fixture.provider, [emptyState], process),
        custodyDirectory,
        run,
      }),
    );
    expect(error.phase).toBe("mutation");
    expect(imports).toBe(1);

    const present = providerFixture({ existing: { name: FRESH_NAME, uuid: DATABASE_ID } });
    const repeated = await rejected(
      runProductionD1FreshInit(invocation, target, {
        ...options(present.provider),
        custodyDirectory,
      }),
    );
    expect(repeated.phase).toBe("preflight");
    expect(repeated.message).toContain("retained attempt");
    expect(present.calls).toEqual([]);
    expect(imports).toBe(1);
    const status = await runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
      provider: fixture.provider,
      custodyDirectory,
      migrationDirectory: currentMigrations,
      reader: {
        async read() {
          return completeState;
        },
      },
    });
    expect(status).toMatchObject({ attemptState: "complete", readyForApply: false });
  });

  test("a database that is not exactly empty withholds the migration", async () => {
    const fixture = providerFixture();
    const process = processFixture();
    const custodyDirectory = newCustodyDirectory();
    const notEmpty = stateWithShape(["0001_runtime_storage.sql"], "[]\n");
    const error = await rejected(
      runProductionD1FreshInit(invocation, target, {
        ...options(fixture.provider, [notEmpty, completeState], process),
        custodyDirectory,
      }),
    );
    expect(error.phase).toBe("mutation");
    expect(error.message).toContain("not exactly empty");
    expect(process.commands.some((command) => command.includes("execute"))).toBe(false);
    const status = await runProductionD1FreshInit({ ...invocation, action: "status" }, target, {
      provider: fixture.provider,
      migrationDirectory: currentMigrations,
      custodyDirectory,
    });
    expect(status).toMatchObject({ attemptState: "identified", readyForApply: false });
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
    expect(error.message).toContain("0001-0069");
  });

  test("the complete lineage with a different application shape is not a fresh-init success", async () => {
    const fixture = providerFixture();
    const wrongShape = stateWithShape(
      APPLY_MIGRATIONS.map(({ name }) => name),
      "[]\n",
    );
    const error = await rejected(
      runProductionD1FreshInit(
        invocation,
        target,
        options(fixture.provider, [emptyState, wrongShape]),
      ),
    );
    expect(error.phase).toBe("verification");
    expect(error.message).toContain("exact audited application schema");
    expect(fixture.calls).not.toContain(`getD1:${INCUMBENT_ID}`);
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
        custodyDirectory: newCustodyDirectory(),
        migrationDirectory: currentMigrations,
      }),
    );
    expect(error.phase).toBe("preflight");
    expect(error.message).toContain("CLOUDFLARE_API_TOKEN");
  });
});
