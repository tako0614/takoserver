import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  CloudflareIntegrationStorageProvider,
  type IntegrationStorageD1Database,
  type IntegrationStorageGenerationInvocation,
  type IntegrationStorageGenerationOptions,
  type IntegrationStorageGenerationProcess,
  type IntegrationStorageGenerationProvider,
  type IntegrationStorageR2Bucket,
  runIntegrationStorageGeneration,
} from "../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape, type D1SchemaState } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  copyAuditedSchemaFixture,
  copyCurrentSchemaFixture,
} from "./helpers/audited-schema-fixture.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "takoserver-integration-storage-tests-"));
const auditedMigrations = copyAuditedSchemaFixture(join(fixtureRoot, "migrations"));
const currentMigrations = copyCurrentSchemaFixture(join(fixtureRoot, "current-migrations"));
const expectedApplicationShape = applicationShape(currentMigrations);
const COMMIT = "a".repeat(40);
const GENERATION = "b".repeat(32);
const DATABASE_ID = "00000000-0000-4000-8000-000000000051";
const TARGET_DATABASE = "takoserver-runtime-integration";
const TARGET_BUCKET = "takoserver-objects-integration";
const GENERATED_NAME = `takoserver-i-${GENERATION}`;

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "c".repeat(32),
  workerName: "takoserver-api-integration",
  d1: { databaseName: TARGET_DATABASE, databaseId: "00000000-0000-4000-8000-000000000001" },
  r2: { bucketName: TARGET_BUCKET },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "integration-current" },
} satisfies DeployTarget;

const invocation = {
  action: "apply",
  environment: "integration",
  commit: COMMIT,
  generation: GENERATION,
} satisfies IntegrationStorageGenerationInvocation;

const emptyState = state([], []);
const completeState = stateWithShape(
  MIGRATIONS.slice(0, 51).map(({ name }) => name),
  expectedApplicationShape,
);

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function state(applied: readonly string[], rows: readonly Record<string, string>[]): D1SchemaState {
  const shape = `${JSON.stringify(rows)}\n`;
  return stateWithShape(applied, shape);
}

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
    for (const name of readdirSync(directory).sort()) {
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function ok(stdout = ""): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function processFixture(migrationResult: CommandResult = ok("applied\n")): {
  readonly run: IntegrationStorageGenerationProcess;
  readonly commands: string[][];
  readonly importDigests: string[];
} {
  const commands: string[][] = [];
  const importDigests: string[] = [];
  const run: IntegrationStorageGenerationProcess = async (command) => {
    commands.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("integration-storage\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check:migrations") return ok("green\n");
    if (command.includes("execute") && command.includes("--file")) {
      const path = command[command.indexOf("--file") + 1];
      if (path === undefined) throw new Error("migration import file was not supplied");
      importDigests.push(`sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      return migrationResult;
    }
    throw new Error(`unexpected command ${key}`);
  };
  return { run, commands, importDigests };
}

interface ProviderOptions {
  readonly existingD1?: IntegrationStorageD1Database;
  readonly existingR2?: IntegrationStorageR2Bucket;
  readonly secondD1?: IntegrationStorageD1Database;
  readonly secondR2?: IntegrationStorageR2Bucket;
  readonly createdD1?: IntegrationStorageD1Database;
  readonly createdR2?: IntegrationStorageR2Bucket;
  readonly failCreateD1?: boolean;
  readonly failCreateR2?: boolean;
}

function providerFixture(options: ProviderOptions = {}): {
  readonly provider: IntegrationStorageGenerationProvider;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let d1ListReads = 0;
  let r2ListReads = 0;
  let createdD1 = options.createdD1;
  let createdR2 = options.createdR2;
  const provider: IntegrationStorageGenerationProvider = {
    async listD1(name) {
      calls.push(`listD1:${name}`);
      d1ListReads += 1;
      const value = d1ListReads === 2 && options.secondD1 ? options.secondD1 : options.existingD1;
      return value === undefined ? [] : [value];
    },
    async getD1(databaseId) {
      calls.push(`getD1:${databaseId}`);
      return createdD1 ?? { name: GENERATED_NAME, uuid: databaseId };
    },
    async createD1(name) {
      calls.push(`createD1:${name}`);
      if (options.failCreateD1) throw new Error("secret should not escape");
      createdD1 = options.createdD1 ?? { name, uuid: DATABASE_ID };
      return createdD1;
    },
    async listR2(name) {
      calls.push(`listR2:${name}`);
      r2ListReads += 1;
      const value = r2ListReads === 3 && options.secondR2 ? options.secondR2 : options.existingR2;
      return value === undefined ? [] : [value];
    },
    async getR2(name) {
      calls.push(`getR2:${name}`);
      return createdR2 ?? { name };
    },
    async createR2(name) {
      calls.push(`createR2:${name}`);
      if (options.failCreateR2) throw new Error("secret should not escape");
      createdR2 = options.createdR2 ?? { name };
      return createdR2;
    },
  };
  return { provider, calls };
}

function options(
  provider: IntegrationStorageGenerationProvider,
  states: readonly D1SchemaState[] = [emptyState, completeState],
  process = processFixture(),
): IntegrationStorageGenerationOptions & { readonly process: ReturnType<typeof processFixture> } {
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
    process,
  };
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected the operation to reject");
}

describe("integration storage generation bootstrap", () => {
  test("D1 filtered inventory ignores account-wide total_count and closes on a short page", async () => {
    const requests: Request[] = [];
    const provider = new CloudflareIntegrationStorageProvider(target.accountId, "bearer-secret", {
      fetcher: async (request) => {
        requests.push(request);
        const page = new URL(request.url).searchParams.get("page");
        if (page === "1") {
          return jsonResponse({
            success: true,
            result: [],
            result_info: { page: 1, per_page: 100, count: 0, total_count: 87 },
          });
        }
        throw new Error("unexpected extra D1 request");
      },
    });
    await expect(provider.listD1(GENERATED_NAME)).resolves.toEqual([]);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "https://invalid").searchParams.get("name")).toBe(
      GENERATED_NAME,
    );

    const pages: IntegrationStorageD1Database[][] = [
      Array.from({ length: 100 }, (_, index) => ({
        name: `other-${index.toString().padStart(3, "0")}`,
        uuid: `00000000-0000-4000-8000-${(index + 100).toString().padStart(12, "0")}`,
      })),
      [{ name: GENERATED_NAME, uuid: DATABASE_ID }],
    ];
    const pageRequests: Request[] = [];
    const pagedProvider = new CloudflareIntegrationStorageProvider(
      target.accountId,
      "bearer-secret",
      {
        fetcher: async (request) => {
          pageRequests.push(request);
          const page = Number(new URL(request.url).searchParams.get("page"));
          return jsonResponse({
            success: true,
            result: pages[page - 1] ?? [],
            result_info: {
              page,
              per_page: 100,
              count: (pages[page - 1] ?? []).length,
              total_count: 999,
            },
          });
        },
      },
    );
    await expect(pagedProvider.listD1(GENERATED_NAME)).resolves.toHaveLength(101);
    expect(pageRequests).toHaveLength(2);
    expect(new URL(pageRequests[1]?.url ?? "https://invalid").searchParams.get("page")).toBe("2");
  });

  test("R2 rejects malformed pagination metadata and never exposes bearer or response body", async () => {
    const malformed = new CloudflareIntegrationStorageProvider(target.accountId, "bearer-secret", {
      fetcher: async () =>
        jsonResponse({
          success: true,
          result: { buckets: [] },
          result_info: 7,
        }),
    });
    const malformedError = await rejectedError(malformed.listR2(GENERATED_NAME));
    expect(malformedError.message).toContain("pagination metadata");
    expect(malformedError.stack).not.toContain("bearer-secret");

    const failed = new CloudflareIntegrationStorageProvider(target.accountId, "bearer-secret", {
      fetcher: async () => new Response("raw-provider-body bearer-secret", { status: 500 }),
    });
    const failedError = await rejectedError(failed.listR2(GENERATED_NAME));
    expect(failedError.stack).not.toContain("raw-provider-body");
    expect(failedError.stack).not.toContain("bearer-secret");
  });

  test("R2 requires pagination closure for full pages and follows continuation cursors", async () => {
    const buckets = Array.from({ length: 100 }, (_, index) => ({ name: `other-${index}` }));
    const providerFor = (result: unknown, resultInfo?: unknown) =>
      new CloudflareIntegrationStorageProvider(target.accountId, "bearer-secret", {
        fetcher: async () =>
          jsonResponse({
            success: true,
            result,
            ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
          }),
      });
    await expect(providerFor({ buckets }).listR2(GENERATED_NAME)).rejects.toThrow(
      "absence is unproved",
    );
    await expect(
      providerFor({ buckets: buckets.slice(0, 99) }).listR2(GENERATED_NAME),
    ).resolves.toHaveLength(99);
    await expect(providerFor({ buckets: [] }).listR2(GENERATED_NAME)).resolves.toEqual([]);
    await expect(
      providerFor({ buckets: [] }, { per_page: 99 }).listR2(GENERATED_NAME),
    ).rejects.toThrow("page size differs");

    const cursors: (string | null)[] = [];
    const paginated = new CloudflareIntegrationStorageProvider(target.accountId, "bearer-secret", {
      fetcher: async (request) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return jsonResponse(
          cursor === null
            ? {
                success: true,
                result: { buckets },
                result_info: { cursor: "next-page", per_page: 100 },
              }
            : { success: true, result: { buckets: [{ name: GENERATED_NAME }] } },
        );
      },
    });
    await expect(paginated.listR2(GENERATED_NAME)).resolves.toHaveLength(101);
    expect(cursors).toEqual([null, "next-page"]);
  });

  test("rejects production and rehearsal before credentials or provider effects", async () => {
    const { provider, calls } = providerFixture();
    for (const environment of ["production", "rehearsal"] as const) {
      await expect(
        runIntegrationStorageGeneration(
          { ...invocation, environment },
          { ...target, environment },
          { provider },
        ),
      ).rejects.toMatchObject({ phase: "preflight" });
    }
    expect(calls).toEqual([]);
  });

  test("status inventories only the generated names and never mutates or adopts", async () => {
    const { provider, calls } = providerFixture();
    const result = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      target,
      { provider },
    );
    expect(result).toMatchObject({
      generation: GENERATION,
      readyForApply: true,
      presence: "absent",
      d1: { databaseName: GENERATED_NAME, databaseId: null, present: false },
      r2: { bucketName: GENERATED_NAME, present: false },
    });
    expect(calls).toEqual([`listD1:${GENERATED_NAME}`, `listR2:${GENERATED_NAME}`]);
    expect(
      calls.some((call) => call.includes(TARGET_DATABASE) || call.includes(TARGET_BUCKET)),
    ).toBe(false);
  });

  test("refuses preexisting names and a repeated absence-fence race before D1 create", async () => {
    const existing = providerFixture({ existingD1: { name: GENERATED_NAME, uuid: DATABASE_ID } });
    await expect(
      runIntegrationStorageGeneration(invocation, target, options(existing.provider)),
    ).rejects.toThrow("never adopted");
    expect(existing.calls.some((call) => call.startsWith("createD1:"))).toBe(false);

    const raced = providerFixture({
      secondD1: { name: GENERATED_NAME, uuid: DATABASE_ID },
    });
    await expect(
      runIntegrationStorageGeneration(invocation, target, options(raced.provider)),
    ).rejects.toThrow("never adopted");
    expect(raced.calls.some((call) => call.startsWith("createD1:"))).toBe(false);
  });

  test("uses fixed generation names and creates exactly one D1 then one R2 after lineage readback", async () => {
    const fixture = providerFixture();
    const process = processFixture();
    const result = await runIntegrationStorageGeneration(
      invocation,
      target,
      options(fixture.provider, [emptyState, completeState], process),
    );
    expect(result).toMatchObject({
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
      r2: { bucketName: GENERATED_NAME },
      appliedMigrations: MIGRATIONS.slice(0, 51).map(({ name }) => name),
      generation: GENERATION,
      commit: COMMIT,
    });
    expect(fixture.calls).toEqual([
      `listD1:${GENERATED_NAME}`,
      `listR2:${GENERATED_NAME}`,
      `listD1:${GENERATED_NAME}`,
      `listR2:${GENERATED_NAME}`,
      `createD1:${GENERATED_NAME}`,
      `getD1:${DATABASE_ID}`,
      `getD1:${DATABASE_ID}`,
      `listR2:${GENERATED_NAME}`,
      `createR2:${GENERATED_NAME}`,
      `getR2:${GENERATED_NAME}`,
    ]);
    expect(
      process.commands.filter(
        (command) => command.includes("execute") && command.includes("--file"),
      ),
    ).toHaveLength(1);
    expect(process.commands.some((command) => command.includes("--command"))).toBe(false);
    expect(process.commands.some((command) => command.includes("apply"))).toBe(false);
    expect(process.importDigests).toHaveLength(1);
    expect(result.migrationImportDigest).toBe(process.importDigests[0]);
  });

  test("refuses malformed create identity and nonempty new D1 without R2", async () => {
    const malformed = providerFixture({ createdD1: { name: GENERATED_NAME, uuid: "bad" } });
    await expect(
      runIntegrationStorageGeneration(invocation, target, options(malformed.provider)),
    ).rejects.toMatchObject({ phase: "mutation" });
    expect(malformed.calls.some((call) => call.startsWith("getD1:"))).toBe(false);
    expect(malformed.calls.some((call) => call.startsWith("createR2:"))).toBe(false);

    const nonempty = providerFixture();
    await expect(
      runIntegrationStorageGeneration(
        invocation,
        target,
        options(nonempty.provider, [state(["0001_runtime_storage.sql"], []), completeState]),
      ),
    ).rejects.toThrow("not exactly empty");
    expect(nonempty.calls.some((call) => call.startsWith("createR2:"))).toBe(false);
  });

  test("migration failure, wrong readback, and post-migration R2 race never retry or adopt", async () => {
    const failedProcess = processFixture({
      exitCode: 1,
      stdout: "provider secret",
      stderr: "raw",
    });
    const failed = providerFixture();
    await expect(
      runIntegrationStorageGeneration(
        invocation,
        target,
        options(failed.provider, [emptyState, completeState], failedProcess),
      ),
    ).rejects.toMatchObject({ phase: "mutation" });
    expect(failed.calls.filter((call) => call.startsWith("createD1:")).length).toBe(1);
    expect(failed.calls.some((call) => call.startsWith("createR2:"))).toBe(false);

    const wrong = providerFixture();
    await expect(
      runIntegrationStorageGeneration(
        invocation,
        target,
        options(wrong.provider, [emptyState, state(["0001_runtime_storage.sql"], [])]),
      ),
    ).rejects.toThrow("exact audited 0001-0051 lineage");
    expect(wrong.calls.some((call) => call.startsWith("createR2:"))).toBe(false);

    const wrongShape = providerFixture();
    await expect(
      runIntegrationStorageGeneration(
        invocation,
        target,
        options(wrongShape.provider, [
          emptyState,
          stateWithShape(
            MIGRATIONS.slice(0, 51).map(({ name }) => name),
            "[]\n",
          ),
        ]),
      ),
    ).rejects.toThrow("differs from the exact audited application schema");
    expect(wrongShape.calls.some((call) => call.startsWith("createR2:"))).toBe(false);

    const raced = providerFixture({ secondR2: { name: GENERATED_NAME } });
    await expect(
      runIntegrationStorageGeneration(invocation, target, options(raced.provider)),
    ).rejects.toThrow("do not adopt");
    expect(raced.calls.filter((call) => call.startsWith("createR2:")).length).toBe(0);
  });

  test("preserves bounded migration failure evidence after D1 creation without raw CLI output", async () => {
    const partialApplied = completeState.applied.slice(0, 1);
    const failedProcess = processFixture({
      exitCode: 7,
      stdout: "secret migration output must stay private",
      stderr: "raw provider response must stay private",
    });
    const failed = providerFixture();
    const error = await rejectedError(
      runIntegrationStorageGeneration(
        invocation,
        target,
        options(failed.provider, [emptyState, state(partialApplied, [])], failedProcess),
      ),
    );
    expect(error).toBeInstanceOf(DeployError);
    if (!(error instanceof DeployError)) throw error;
    expect(error.phase).toBe("mutation");
    expect(error.detail).toContain(`databaseId=${DATABASE_ID}`);
    expect(error.detail).toContain("exitCode=7");
    expect(error.detail).toContain(JSON.stringify(partialApplied));
    expect(error.detail).not.toContain("secret migration output");
    expect(error.detail).not.toContain("raw provider response");
    expect(error.stack).not.toContain("secret migration output");
    expect(error.stack).not.toContain("raw provider response");
    expect(failed.calls.filter((call) => call.startsWith("createD1:"))).toHaveLength(1);
    expect(failed.calls.some((call) => call.startsWith("createR2:"))).toBe(false);
  });

  test("does not leak provider diagnostics and rejects obsolete or unreviewed source inventories", async () => {
    const leaked = providerFixture({ failCreateD1: true });
    const process = processFixture();
    const error = await rejectedError(
      runIntegrationStorageGeneration(
        invocation,
        target,
        options(leaked.provider, [emptyState, completeState], process),
      ),
    );
    expect(error.stack).not.toContain("secret should not escape");
    const tail = join(fixtureRoot, "tail-migrations");
    copyCurrentSchemaFixture(tail);
    writeFileSync(join(tail, "0052_unreviewed.sql"), "CREATE TABLE unreviewed (id TEXT);\n");
    for (const migrationDirectory of [auditedMigrations, tail]) {
      const refusedProvider = providerFixture();
      await expect(
        runIntegrationStorageGeneration(invocation, target, {
          ...options(refusedProvider.provider),
          migrationDirectory,
        }),
      ).rejects.toThrow("exactly 0001-0051");
      expect(refusedProvider.calls).toEqual([]);
    }
  });
});
