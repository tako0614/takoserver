import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  type IntegrationStorageTargetReadProvider,
  integrationStorageGenerationName,
  runIntegrationStorageGeneration,
  verifyFreshV2ArtifactIntegrationStorageTarget,
  verifyFreshV2IntegrationStorageTarget,
  verifyIntegrationStorageGenerationTarget,
} from "../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape, type D1SchemaState } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { unsealDirectory } from "../scripts/deploy/qualification.ts";
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
const expectedV2ArtifactShape = applicationShape(currentMigrations, 75);
const COMMIT = "a".repeat(40);
const GENERATION = "b".repeat(32);
const APPLY_MIGRATIONS = MIGRATIONS.slice(0, 66);
const FRESH_V2_MIGRATIONS = MIGRATIONS.slice(0, 75);
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
  APPLY_MIGRATIONS.map(({ name }) => name),
  expectedApplicationShape,
);
const completeV2ArtifactState = stateWithShape(
  FRESH_V2_MIGRATIONS.map(({ name }) => name),
  expectedV2ArtifactShape,
);

afterAll(() => {
  unsealDirectory(fixtureRoot);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

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

interface TestSchemaRow {
  type: string;
  name: string;
  table: string;
  sql: string;
}

function schemaRows(value: D1SchemaState): TestSchemaRow[] {
  return JSON.parse(value.shape) as TestSchemaRow[];
}

function stateWithSchemaRows(base: D1SchemaState, rows: readonly TestSchemaRow[]): D1SchemaState {
  const canonicalRows = [...rows].sort((left, right) =>
    `${left.type}\0${left.name}`.localeCompare(`${right.type}\0${right.name}`),
  );
  const shape = canonicalSchemaShape(
    canonicalRows.map(({ type, name, table, sql }) => ({ type, name, tbl_name: table, sql })),
  );
  return stateWithShape(base.applied, shape);
}

function editedTriggerState(base: D1SchemaState, edit: (sql: string) => string): D1SchemaState {
  return editedSchemaSqlState(
    base,
    "cloudflare_managed_worker_version_execution_material_exact_insert",
    edit,
  );
}

function editedSchemaSqlState(
  base: D1SchemaState,
  name: string,
  edit: (sql: string) => string,
): D1SchemaState {
  let changed = false;
  const rows = schemaRows(base).map((row) => {
    if (row.name !== name) return row;
    const sql = edit(row.sql);
    changed = sql !== row.sql;
    return { ...row, sql };
  });
  if (!changed) throw new Error(`schema test edit did not change ${name}`);
  return stateWithSchemaRows(base, rows);
}

function applicationShape(directory: string, count = 66): string {
  const database = new Database(":memory:");
  try {
    for (const name of readdirSync(directory).sort().slice(0, count)) {
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
  test("storage rebind verifier proves the exact generated D1/R2 target and audited schema read-only", async () => {
    const generatedTarget = {
      ...target,
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
      r2: { bucketName: GENERATED_NAME },
    } satisfies DeployTarget;
    const calls: string[] = [];
    const provider: IntegrationStorageTargetReadProvider = {
      async getD1(databaseId) {
        calls.push(`getD1:${databaseId}`);
        return { uuid: DATABASE_ID, name: GENERATED_NAME };
      },
      async getR2(name) {
        calls.push(`getR2:${name}`);
        return { name };
      },
    };
    const proof = await verifyIntegrationStorageGenerationTarget(generatedTarget, "integration", {
      provider,
      reader: {
        async read() {
          return completeState;
        },
      },
      migrationDirectory: currentMigrations,
    });
    expect(proof).toMatchObject({
      generation: GENERATION,
      d1: { databaseId: DATABASE_ID, databaseName: GENERATED_NAME },
      r2: { bucketName: GENERATED_NAME },
      appliedMigrations: APPLY_MIGRATIONS.map(({ name }) => name),
    });
    expect(proof.migrationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(proof.schemaShapeDigest).toBe(completeState.shapeDigest);
    expect(calls).toEqual([`getD1:${DATABASE_ID}`, `getR2:${GENERATED_NAME}`]);
  });

  test("generated application schema comparison ignores only SQL trivia and keeps raw digests", async () => {
    const generatedTarget = {
      ...target,
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
      r2: { bucketName: GENERATED_NAME },
    } satisfies DeployTarget;
    const triviaState = editedTriggerState(completeState, (sql) =>
      `-- readback-only comment\n${sql}`
        .replace("CREATE TRIGGER", "CREATE/* harmless block comment */TRIGGER")
        .replace("BEFORE INSERT", "BEFORE\t \nINSERT"),
    );
    expect(triviaState.shapeDigest).not.toBe(completeState.shapeDigest);

    const readProvider: IntegrationStorageTargetReadProvider = {
      async getD1(databaseId) {
        return { uuid: databaseId, name: GENERATED_NAME };
      },
      async getR2(name) {
        return { name };
      },
    };
    const proof = await verifyIntegrationStorageGenerationTarget(generatedTarget, "integration", {
      provider: readProvider,
      reader: {
        async read() {
          return triviaState;
        },
      },
      migrationDirectory: currentMigrations,
    });
    expect(proof.schemaShapeDigest).toBe(triviaState.shapeDigest);
    expect(proof.schemaShapeDigest).not.toBe(completeState.shapeDigest);

    const fresh = providerFixture();
    const process = processFixture();
    const result = await runIntegrationStorageGeneration(
      invocation,
      target,
      options(fresh.provider, [emptyState, triviaState], process),
    );
    expect(result.schemaShapeDigest).toBe(triviaState.shapeDigest);
    expect(result.schemaShapeDigest).not.toBe(completeState.shapeDigest);
    expect(fresh.calls).toContain(`createR2:${GENERATED_NAME}`);
  });

  test("generated schema proof rejects semantic, structural, malformed, and raw-digest drift", async () => {
    const generatedTarget = {
      ...target,
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
      r2: { bucketName: GENERATED_NAME },
    } satisfies DeployTarget;
    const provider: IntegrationStorageTargetReadProvider = {
      async getD1(databaseId) {
        return { uuid: databaseId, name: GENERATED_NAME };
      },
      async getR2(name) {
        return { name };
      },
    };
    const verify = async (readState: D1SchemaState): Promise<Error> =>
      await rejectedError(
        verifyIntegrationStorageGenerationTarget(generatedTarget, "integration", {
          provider,
          reader: {
            async read() {
              return readState;
            },
          },
          migrationDirectory: currentMigrations,
        }),
      );
    const expectPreflight = async (readState: D1SchemaState): Promise<void> => {
      const error = await verify(readState);
      expect(error).toBeInstanceOf(DeployError);
      if (!(error instanceof DeployError)) throw error;
      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("Existing generated D1 schema readback");
    };

    const semanticChanges: readonly [string, (sql: string) => string][] = [
      ["literal", (sql) => sql.replace("'version'", "'versions'")],
      ["identifier", (sql) => sql.replace("NEW.provider_id", "NEW.providerId")],
      ["operator", (sql) => sql.replace(") = 2", ") != 2")],
      ["predicate", (sql) => sql.replace("WHEN NOT EXISTS", "WHEN EXISTS")],
      ["action", (sql) => sql.replace("RAISE(ABORT", "RAISE(FAIL")],
      ["quoted literal bytes", (sql) => sql.replace("'version'", "'ver sion'")],
      [
        "comment token inside a literal",
        (sql) =>
          sql.replace(
            "'managed_worker_version_execution_material_receipt_not_exact'",
            "'managed_worker_version_execution_material_receipt/*note*/_not_exact'",
          ),
      ],
    ];
    for (const [, edit] of semanticChanges)
      await expectPreflight(editedTriggerState(completeState, edit));

    const quotedIdentifierChanges: readonly [string, (sql: string) => string][] = [
      ["double-quoted identifier", (sql) => sql.replace('"principals"', '"principals--marker"')],
      [
        "backtick-quoted identifier",
        (sql) => sql.replace('"principals"', "`principals/*marker*/`"),
      ],
      ["bracket-quoted identifier", (sql) => sql.replace('"principals"', "[principals--marker]")],
    ];
    for (const [, edit] of quotedIdentifierChanges) {
      await expectPreflight(editedSchemaSqlState(completeState, "principals", edit));
    }

    const malformedSql: readonly [string, (sql: string) => string][] = [
      ["single quote", (sql) => `${sql} 'unterminated`],
      ["double quote", (sql) => `${sql} "unterminated`],
      ["backtick", (sql) => `${sql} \`unterminated`],
      ["bracket identifier", (sql) => `${sql} [unterminated`],
      ["block comment", (sql) => `${sql} /* unterminated`],
    ];
    for (const [, edit] of malformedSql)
      await expectPreflight(editedTriggerState(completeState, edit));

    const rowCases: readonly [string, (rows: TestSchemaRow[]) => TestSchemaRow[]][] = [
      ["inventory", (rows) => rows.slice(1)],
      ["type", (rows) => rows.map((row, index) => (index === 0 ? { ...row, type: "view" } : row))],
      [
        "name",
        (rows) =>
          rows.map((row, index) => (index === 0 ? { ...row, name: `${row.name}-changed` } : row)),
      ],
      [
        "table",
        (rows) =>
          rows.map((row, index) => (index === 0 ? { ...row, table: `${row.table}-changed` } : row)),
      ],
    ];
    for (const [, change] of rowCases) {
      await expectPreflight(stateWithSchemaRows(completeState, change(schemaRows(completeState))));
    }

    await expectPreflight({ ...completeState, shapeDigest: `sha256:${"0".repeat(64)}` });
  });

  test("storage rebind verifier uses the composing owner's Wrangler for OAuth and D1 readback", async () => {
    const generatedTarget = {
      ...target,
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
      r2: { bucketName: GENERATED_NAME },
    } satisfies DeployTarget;
    const privateWrangler = "/private/runtime/node_modules/.bin/wrangler";
    const commands: string[][] = [];
    const requestPaths: string[] = [];
    const applicationRows = JSON.parse(completeState.shape) as {
      readonly type: string;
      readonly name: string;
      readonly table: string;
      readonly sql: string;
    }[];
    const schemaRows = [
      ...applicationRows.map(({ table, ...row }) => ({ ...row, tbl_name: table })),
      {
        type: "table",
        name: "d1_migrations",
        tbl_name: "d1_migrations",
        sql: "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      },
    ].sort((left, right) =>
      `${left.type}\0${left.name}`.localeCompare(`${right.type}\0${right.name}`),
    );
    const run: IntegrationStorageGenerationProcess = async (command) => {
      commands.push([...command]);
      if (command[0] === privateWrangler && command[1] === "auth") {
        return ok(JSON.stringify({ type: "oauth", token: "private-oauth-token" }));
      }
      if (command[0] !== privateWrangler) {
        throw new Error(`unexpected Wrangler executable ${command[0] ?? "<missing>"}`);
      }
      const sql = command[command.indexOf("--command") + 1];
      if (sql === undefined) throw new Error("D1 command omitted SQL");
      const results = sql.startsWith("SELECT name FROM sqlite_schema")
        ? schemaRows.filter(({ type }) => type === "table").map(({ name }) => ({ name }))
        : sql.includes("FROM d1_migrations ORDER BY id")
          ? APPLY_MIGRATIONS.map(({ name }) => ({ name }))
          : sql.startsWith("SELECT type, name, tbl_name, COALESCE(sql, '') AS sql")
            ? schemaRows
            : null;
      if (results === null) throw new Error(`unexpected D1 query ${sql}`);
      return ok(JSON.stringify([{ success: true, results }]));
    };
    const proof = await verifyIntegrationStorageGenerationTarget(generatedTarget, "integration", {
      run,
      wranglerPath: privateWrangler,
      cloudflareEnvironment: {},
      migrationDirectory: currentMigrations,
      fetcher: async (request) => {
        const url = new URL(request.url);
        requestPaths.push(url.pathname);
        if (url.pathname.endsWith(`/d1/database/${DATABASE_ID}`)) {
          return jsonResponse({
            success: true,
            result: { uuid: DATABASE_ID, name: GENERATED_NAME },
          });
        }
        if (url.pathname.endsWith(`/r2/buckets/${GENERATED_NAME}`)) {
          return jsonResponse({ success: true, result: { name: GENERATED_NAME } });
        }
        throw new Error(`unexpected Cloudflare request ${url.pathname}`);
      },
    });

    expect(proof.d1).toEqual({ databaseId: DATABASE_ID, databaseName: GENERATED_NAME });
    expect(commands[0]).toEqual([privateWrangler, "auth", "token", "--json"]);
    expect(commands.length).toBe(4);
    expect(
      commands
        .slice(1)
        .every(
          (command) =>
            command[0] === privateWrangler && command[1] === "d1" && command[2] === "execute",
        ),
    ).toBe(true);
    expect(requestPaths).toEqual([
      `/client/v4/accounts/${target.accountId}/d1/database/${DATABASE_ID}`,
      `/client/v4/accounts/${target.accountId}/r2/buckets/${GENERATED_NAME}`,
    ]);
  });

  test("storage rebind verifier rejects arbitrary or mismatched generated targets before provider reads", async () => {
    let reads = 0;
    const provider: IntegrationStorageTargetReadProvider = {
      async getD1() {
        reads += 1;
        return { uuid: DATABASE_ID, name: GENERATED_NAME };
      },
      async getR2(name) {
        reads += 1;
        return { name };
      },
    };
    for (const invalidTarget of [
      {
        ...target,
        d1: { databaseName: TARGET_DATABASE, databaseId: DATABASE_ID },
        r2: { bucketName: TARGET_BUCKET },
      },
      {
        ...target,
        d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
        r2: { bucketName: `${GENERATED_NAME}-other` },
      },
      {
        ...target,
        d1: { databaseName: GENERATED_NAME, databaseId: "not-a-uuid" },
        r2: { bucketName: GENERATED_NAME },
      },
    ] as unknown as DeployTarget[]) {
      await expect(
        verifyIntegrationStorageGenerationTarget(invalidTarget, "integration", { provider }),
      ).rejects.toThrow("exact matching generated D1/R2 storage pair");
    }
    expect(reads).toBe(0);
  });

  test("read-only storage proof classifies a schema mismatch as preflight", async () => {
    const generatedTarget = {
      ...target,
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
      r2: { bucketName: GENERATED_NAME },
    } satisfies DeployTarget;
    const wrongD1: IntegrationStorageTargetReadProvider = {
      async getD1() {
        return { uuid: DATABASE_ID, name: `${GENERATED_NAME}-other` };
      },
      async getR2(name) {
        return { name };
      },
    };
    await expect(
      verifyIntegrationStorageGenerationTarget(generatedTarget, "integration", {
        provider: wrongD1,
        reader: {
          async read() {
            return completeState;
          },
        },
        migrationDirectory: currentMigrations,
      }),
    ).rejects.toThrow("D1 identity readback does not match");

    const reads: string[] = [];
    const exactProvider: IntegrationStorageTargetReadProvider = {
      async getD1() {
        reads.push("D1");
        return { uuid: DATABASE_ID, name: GENERATED_NAME };
      },
      async getR2(name) {
        reads.push("R2");
        return { name };
      },
    };
    const incomplete = state(
      MIGRATIONS.slice(0, 56).map(({ name }) => name),
      [],
    );
    const mismatch = await rejectedError(
      verifyIntegrationStorageGenerationTarget(generatedTarget, "integration", {
        provider: exactProvider,
        reader: {
          async read(phase) {
            reads.push(`schema:${phase}`);
            return incomplete;
          },
        },
        migrationDirectory: currentMigrations,
      }),
    );
    expect(mismatch).toBeInstanceOf(DeployError);
    if (!(mismatch instanceof DeployError)) throw mismatch;
    expect(mismatch.phase).toBe("preflight");
    expect(mismatch.message).toContain("exact audited 0001-0066 lineage");
    expect(mismatch.message).not.toContain("R2 creation is withheld");
    expect(reads).toEqual(["D1", "R2", "schema:preflight"]);
  });

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

  test("source-tail drift is refused before integration storage provider access", async () => {
    for (const drift of ["missing", "changed", "extra"] as const) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-storage-source-${drift}-`));
      try {
        const migrationDirectory = join(root, "migrations");
        cpSync(currentMigrations, migrationDirectory, { recursive: true });
        const tail = join(migrationDirectory, "0094_wallet_usd_micros.sql");
        if (drift === "missing") rmSync(join(migrationDirectory, "0095_stripe_billing.sql"));
        else if (drift === "changed") {
          writeFileSync(tail, `${readFileSync(tail, "utf8")}\n-- changed\n`);
        } else {
          writeFileSync(
            join(migrationDirectory, "0096_unreviewed.sql"),
            "CREATE TABLE unreviewed (id TEXT);\n",
          );
        }
        const fixture = providerFixture();
        for (const selected of [
          invocation,
          { ...invocation, freshLineage: "v2-artifacts-0075" } as const,
        ]) {
          await expect(
            runIntegrationStorageGeneration(selected, target, {
              ...options(fixture.provider),
              migrationDirectory,
            }),
          ).rejects.toThrow(
            drift === "changed"
              ? "exact audited migration SHA-256"
              : "audited migration lineage must contain exactly 0001-0095",
          );
        }
        expect(fixture.calls).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
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
      appliedMigrations: APPLY_MIGRATIONS.map(({ name }) => name),
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

  test("the generated storage payload seals only the apply-qualified 0001-0066 prefix", async () => {
    const fixture = providerFixture();
    const outputDirectory = mkdtempSync(join(tmpdir(), "takoserver-storage-payload-"));
    try {
      const result = await runIntegrationStorageGeneration(invocation, target, {
        ...options(fixture.provider),
        outputDirectory,
      });
      expect(result.appliedMigrations).toEqual(APPLY_MIGRATIONS.map(({ name }) => name));
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
  });

  test("explicit fresh-v2 selector seals and imports exact 0075 before R2, while the default stays 0066", async () => {
    const fixture = providerFixture();
    const process = processFixture();
    const outputDirectory = mkdtempSync(join(tmpdir(), "takoserver-v2-fresh-payload-"));
    try {
      const result = await runIntegrationStorageGeneration(
        { ...invocation, freshLineage: "v2-artifacts-0075" },
        target,
        {
          ...options(fixture.provider, [emptyState, completeV2ArtifactState], process),
          outputDirectory,
        },
      );
      expect(result).toMatchObject({
        freshLineage: "v2-artifacts-0075",
        appliedMigrations: FRESH_V2_MIGRATIONS.map(({ name }) => name),
      });
      const sealedMigrations = join(outputDirectory, "release", "payload", "migrations");
      expect(readdirSync(sealedMigrations).sort()).toEqual(
        FRESH_V2_MIGRATIONS.map(({ name }) => name),
      );
      const importSql = readFileSync(
        join(outputDirectory, "release", "payload", "migration-import.sql"),
        "utf8",
      );
      expect(importSql).toContain("0075_v2_artifact_progress.sql");
      expect(result.migrationImportDigest).toBe(process.importDigests[0]);
      expect(fixture.calls.at(-2)).toBe(`createR2:${GENERATED_NAME}`);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  test("fresh-v2 read-only proof requires exact generated identity and every 0075 schema object", async () => {
    const generatedTarget = {
      ...target,
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
      r2: { bucketName: GENERATED_NAME },
    } satisfies DeployTarget;
    const provider: IntegrationStorageTargetReadProvider = {
      async getD1(databaseId) {
        return { uuid: databaseId, name: GENERATED_NAME };
      },
      async getR2(name) {
        return { name };
      },
    };
    const reader = {
      async read() {
        return completeV2ArtifactState;
      },
    };
    const proof = await verifyFreshV2ArtifactIntegrationStorageTarget(
      generatedTarget,
      "integration",
      { provider, reader, migrationDirectory: currentMigrations },
    );
    expect(proof).toMatchObject({
      freshLineage: "v2-artifacts-0075",
      appliedMigrations: FRESH_V2_MIGRATIONS.map(({ name }) => name),
      d1: { databaseId: DATABASE_ID, databaseName: GENERATED_NAME },
    });
    await expect(
      verifyIntegrationStorageGenerationTarget(generatedTarget, "integration", {
        provider,
        reader,
        migrationDirectory: currentMigrations,
      }),
    ).rejects.toThrow("does not contain the exact audited 0001-0066 lineage");
    const progressTrigger = schemaRows(completeV2ArtifactState).find(
      (row) => row.name === "tf_v2_artifact_progress_monotonic",
    );
    if (!progressTrigger) throw new Error("missing 0075 trigger fixture");
    const missingTrigger = stateWithSchemaRows(
      completeV2ArtifactState,
      schemaRows(completeV2ArtifactState).filter((row) => row.name !== progressTrigger.name),
    );
    await expect(
      verifyFreshV2ArtifactIntegrationStorageTarget(generatedTarget, "integration", {
        provider,
        reader: {
          async read() {
            return missingTrigger;
          },
        },
        migrationDirectory: currentMigrations,
      }),
    ).rejects.toThrow("differs from the exact audited application schema");
  });

  test("fresh-v2 status diagnoses an exact completed or partial prior D1 without re-import or adoption", async () => {
    const fixture = providerFixture({
      existingD1: { name: GENERATED_NAME, uuid: DATABASE_ID },
    });
    for (const [state, schemaReadback] of [
      [completeV2ArtifactState, "complete-0075"],
      [completeState, "incomplete-or-divergent"],
    ] as const) {
      const process = processFixture();
      const status = await runIntegrationStorageGeneration(
        { ...invocation, action: "status", freshLineage: "v2-artifacts-0075" },
        target,
        options(fixture.provider, [state], process),
      );
      expect(status).toMatchObject({
        presence: "d1-only",
        readyForApply: false,
        schemaReadback,
      });
      expect(String(status.resume).toLowerCase()).toContain("no sql re-import");
      expect(process.commands.some((command) => command.includes("execute"))).toBe(false);
    }
    expect(fixture.calls.some((call) => call.startsWith("create"))).toBe(false);
  });

  test("status reads a generation the target already selects; apply still refuses the collision", async () => {
    // After apply the runbook points the target at the new pair; `--status`
    // must keep diagnosing it instead of refusing it as a name collision.
    const selectingTarget = {
      ...target,
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID },
      r2: { bucketName: GENERATED_NAME },
    } satisfies DeployTarget;
    const fixture = providerFixture({
      existingD1: { name: GENERATED_NAME, uuid: DATABASE_ID },
      existingR2: { name: GENERATED_NAME },
    });
    const process = processFixture();
    const status = await runIntegrationStorageGeneration(
      { ...invocation, action: "status", freshLineage: "v2-artifacts-0075" },
      selectingTarget,
      options(fixture.provider, [completeV2ArtifactState], process),
    );
    expect(status).toMatchObject({
      presence: "both",
      d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID, present: true },
      r2: { bucketName: GENERATED_NAME, present: true },
      targetSelection: { d1: true, r2: true, databaseIdExact: true },
      readyForApply: false,
      schemaReadback: "complete-0075",
    });
    const foreignId = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      {
        ...selectingTarget,
        d1: { databaseName: GENERATED_NAME, databaseId: target.d1.databaseId },
      },
      options(fixture.provider),
    );
    expect(foreignId).toMatchObject({
      targetSelection: { d1: true, r2: true, databaseIdExact: false },
      readyForApply: false,
    });
    expect(process.commands.some((command) => command.includes("execute"))).toBe(false);
    expect(fixture.calls.some((call) => call.startsWith("create"))).toBe(false);

    const unselected = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      target,
      options(providerFixture().provider),
    );
    expect(unselected).toMatchObject({
      targetSelection: { d1: false, r2: false, databaseIdExact: null },
      readyForApply: true,
    });

    for (const colliding of [
      selectingTarget,
      { ...target, d1: { databaseName: GENERATED_NAME, databaseId: DATABASE_ID } },
      { ...target, r2: { bucketName: GENERATED_NAME } },
    ]) {
      const refused = providerFixture();
      const applyProcess = processFixture();
      await expect(
        runIntegrationStorageGeneration(
          invocation,
          colliding,
          options(refused.provider, [emptyState], applyProcess),
        ),
      ).rejects.toThrow("collides with the selected target");
      expect(refused.calls).toEqual([]);
      expect(applyProcess.commands).toEqual([]);
    }
  });

  test("fresh-v2 unknown or partial import halts with exact generation evidence and no R2", async () => {
    const process = processFixture({ exitCode: 1, stdout: "private", stderr: "private" });
    const fixture = providerFixture();
    const error = await rejectedError(
      runIntegrationStorageGeneration(
        { ...invocation, freshLineage: "v2-artifacts-0075" },
        target,
        options(fixture.provider, [emptyState, state(["0001_runtime_storage.sql"], [])], process),
      ),
    );
    expect(error).toBeInstanceOf(DeployError);
    expect(error.message).toContain("not retried or adopted");
    expect(String(error)).not.toContain("private");
    expect(fixture.calls.filter((call) => call.startsWith("createD1:"))).toHaveLength(1);
    expect(fixture.calls.some((call) => call.startsWith("createR2:"))).toBe(false);
    await expect(
      runIntegrationStorageGeneration(
        { ...invocation, freshLineage: "v2-artifacts-0075" },
        target,
        options(
          providerFixture({ existingD1: { name: GENERATED_NAME, uuid: DATABASE_ID } }).provider,
        ),
      ),
    ).rejects.toThrow("never adopted");
  });

  test("fresh-v2 sealed source drift at the immediate create fence refuses before provider mutation", async () => {
    const fixture = providerFixture();
    const outputDirectory = mkdtempSync(join(tmpdir(), "takoserver-v2-fresh-seal-"));
    let changed = false;
    const provider: IntegrationStorageGenerationProvider = {
      ...fixture.provider,
      async listD1(name) {
        const rows = await fixture.provider.listD1(name);
        if (!changed) {
          changed = true;
          const tail = join(
            outputDirectory,
            "release",
            "payload",
            "migrations",
            "0075_v2_artifact_progress.sql",
          );
          writeFileSync(tail, `${readFileSync(tail, "utf8")}\n-- raced source change\n`);
        }
        return rows;
      },
    };
    try {
      await expect(
        runIntegrationStorageGeneration(
          { ...invocation, freshLineage: "v2-artifacts-0075" },
          target,
          {
            ...options(provider, [emptyState, completeV2ArtifactState]),
            outputDirectory,
          },
        ),
      ).rejects.toThrow();
      expect(fixture.calls.some((call) => call.startsWith("createD1:"))).toBe(false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
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
    const wrongError = await rejectedError(
      runIntegrationStorageGeneration(
        invocation,
        target,
        options(wrong.provider, [emptyState, state(["0001_runtime_storage.sql"], [])]),
      ),
    );
    expect(wrongError).toBeInstanceOf(DeployError);
    if (!(wrongError instanceof DeployError)) throw wrongError;
    expect(wrongError.phase).toBe("verification");
    expect(wrongError.message).toContain("exact audited 0001-0066 lineage");
    expect(wrong.calls.some((call) => call.startsWith("createR2:"))).toBe(false);

    const wrongShape = providerFixture();
    const wrongShapeError = await rejectedError(
      runIntegrationStorageGeneration(
        invocation,
        target,
        options(wrongShape.provider, [
          emptyState,
          stateWithShape(
            APPLY_MIGRATIONS.map(({ name }) => name),
            "[]\n",
          ),
        ]),
      ),
    );
    expect(wrongShapeError).toBeInstanceOf(DeployError);
    if (!(wrongShapeError instanceof DeployError)) throw wrongShapeError;
    expect(wrongShapeError.phase).toBe("verification");
    expect(wrongShapeError.message).toContain("differs from the exact audited application schema");
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
    writeFileSync(join(tail, "0096_unreviewed.sql"), "CREATE TABLE unreviewed (id TEXT);\n");
    for (const migrationDirectory of [auditedMigrations, tail]) {
      const refusedProvider = providerFixture();
      await expect(
        runIntegrationStorageGeneration(invocation, target, {
          ...options(refusedProvider.provider),
          migrationDirectory,
        }),
      ).rejects.toThrow("exactly 0001-0095");
      expect(refusedProvider.calls).toEqual([]);
    }
  });
});

// The actual owner executes its fixed import into SQLite. Only provider/command boundaries
// are substituted; resulting custody must therefore remain component-simulation-only.
const originalDatabases = new Set<Database>();
afterEach(() => {
  for (const database of originalDatabases) database.close();
  originalDatabases.clear();
});

function originalCreationFixture() {
  const database = new Database(":memory:");
  originalDatabases.add(database);
  const custodyDirectory = mkdtempSync(join(fixtureRoot, "original-custody-"));
  // A new local fixture's provisioning-time metadata, captured before creator invocation.
  const custodyStat = lstatSync(custodyDirectory, { bigint: true });
  const custodyIdentity = { device: String(custodyStat.dev), inode: String(custodyStat.ino) };
  const prefixedName = `integration-ts-${GENERATION}`;
  const selected = { ...target, d1: { ...target.d1 }, r2: { ...target.r2 } };
  const selectedInvocation: IntegrationStorageGenerationInvocation = {
    ...invocation,
    namespace: "integration-ts",
    freshLineage: "v2-0092",
  };
  const calls: string[] = [];
  const process = processFixture();
  let createdD1: IntegrationStorageD1Database | null = null;
  let createdR2: IntegrationStorageR2Bucket | null = null;
  let imports = 0;
  const provider: IntegrationStorageGenerationProvider = {
    async listD1(name) {
      calls.push(`listD1:${name}`);
      return createdD1 === null ? [] : [createdD1];
    },
    async listR2(name) {
      calls.push(`listR2:${name}`);
      return createdR2 === null ? [] : [createdR2];
    },
    async createD1(name) {
      calls.push(`createD1:${name}`);
      createdD1 = { name, uuid: DATABASE_ID };
      return createdD1;
    },
    async getD1(id) {
      calls.push(`getD1:${id}`);
      if (createdD1 === null) throw new Error("D1 not created");
      return { ...createdD1 };
    },
    async createR2(name) {
      calls.push(`createR2:${name}`);
      createdR2 = { name };
      return createdR2;
    },
    async getR2(name) {
      calls.push(`getR2:${name}`);
      if (createdR2 === null) throw new Error("R2 not created");
      return { ...createdR2 };
    },
  };
  const readState = (): D1SchemaState => {
    const rows = database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[];
    const ledgerPresent = rows.some((row) => row.name === "d1_migrations");
    const shape = canonicalSchemaShape(
      rows.filter((row) => row.name !== "d1_migrations" && row.tbl_name !== "d1_migrations"),
    );
    return stateWithShape(
      ledgerPresent
        ? (
            database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
          ).map((row) => row.name)
        : [],
      shape,
    );
  };
  const opts: IntegrationStorageGenerationOptions = {
    provider,
    review: "independent-original-create-review",
    migrationDirectory: currentMigrations,
    originalCreate: { kind: "positive-fresh-0092", custodyDirectory, custodyIdentity },
    run: async (command, runOptions) => {
      const result = await process.run(command, runOptions);
      if (command.includes("execute") && command.includes("--file")) {
        const importPath = command[command.indexOf("--file") + 1];
        if (importPath === undefined) throw new Error("missing import");
        database.exec(readFileSync(importPath, "utf8"));
        imports += 1;
      }
      return result;
    },
    reader: {
      async read() {
        return readState();
      },
    },
    freshV2DataReader: {
      async read() {
        const tables = schemaRows(readState())
          .filter((row) => row.type === "table")
          .map((row) => row.name);
        const tableCounts = Object.fromEntries(
          tables.map((name) => [
            name,
            (database.query(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number })
              .count,
          ]),
        );
        return {
          tableCounts,
          ledgerRows: (
            database.query("SELECT COUNT(*) AS count FROM d1_migrations").get() as { count: number }
          ).count,
          foreignKeyViolations: database.query("PRAGMA foreign_key_check").all().length,
          invocationEpoch: database
            .query("SELECT * FROM tf_cloudflare_provider_invocation_epoch")
            .all() as Record<string, unknown>[],
          acceptanceCounter: database
            .query("SELECT * FROM tf_v2_operation_acceptance_counter")
            .all() as Record<string, unknown>[],
        };
      },
    },
  };
  const records = () =>
    readdirSync(custodyDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({
        path: join(custodyDirectory, name),
        value: JSON.parse(readFileSync(join(custodyDirectory, name), "utf8")) as Record<
          string,
          unknown
        >,
      }));
  return {
    database,
    custodyDirectory,
    custodyIdentity,
    prefixedName,
    selected,
    invocation: selectedInvocation,
    provider,
    options: opts,
    calls,
    process,
    records,
    readState,
    imports: () => imports,
    apply: (overrides: Partial<IntegrationStorageGenerationOptions> = {}) =>
      runIntegrationStorageGeneration(selectedInvocation, selected, { ...opts, ...overrides }),
    status: () =>
      runIntegrationStorageGeneration({ ...selectedInvocation, action: "status" }, selected, opts),
  };
}

describe("original integration-ts fresh0092 creator", () => {
  test("namespace is closed and legacy formatting is unchanged", () => {
    expect(integrationStorageGenerationName(GENERATION)).toBe(GENERATED_NAME);
    expect(integrationStorageGenerationName(GENERATION, "integration-ts")).toBe(
      `integration-ts-${GENERATION}`,
    );
    expect(integrationStorageGenerationName(GENERATION, "integration-ts")).toHaveLength(47);
    for (const [generation, namespace] of [
      [GENERATION.toUpperCase(), "integration-ts"],
      ["a".repeat(31), "integration-ts"],
      [GENERATION, "staging"],
      [GENERATION, "integration-ts-"],
      [GENERATION, "takoserver-i"],
    ]) {
      expect(() =>
        integrationStorageGenerationName(generation as string, namespace as "integration-ts"),
      ).toThrow("closed namespace");
    }
  });

  test("actual fixed92 import issues only component evidence and retains a protected original chain", async () => {
    const f = originalCreationFixture();
    const result = await f.apply();
    expect(f.readState().applied).toEqual(MIGRATIONS.slice(0, 92).map((row) => row.name));
    expect(f.imports()).toBe(1);
    expect(result).toMatchObject({
      namespace: "integration-ts",
      freshLineage: "v2-0092",
      d1: { databaseName: f.prefixedName, databaseId: DATABASE_ID },
      r2: { bucketName: f.prefixedName },
    });
    expect(result.productionD1Guard).toBeUndefined();
    expect(result.originalCreate).toMatchObject({
      kind: "takoserver.integration-fresh-0092-component-result@v1",
      authority: "component-simulation",
      qualification: "component-simulation-only",
      commandPort: "composing-source-owned",
      namespace: "integration-ts",
      sourceCommit: COMMIT,
      migrationDigest: "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2",
      schemaShapeDigest: f.readState().shapeDigest,
    });
    const records = f.records();
    expect(records.map((row) => row.value.stage).sort()).toEqual([
      "create-dispatched",
      "identified",
      "import-dispatched",
      "r2-dispatched",
      "terminal",
    ]);
    for (const record of records) {
      expect(lstatSync(record.path).mode & 0o777).toBe(0o600);
      expect(lstatSync(record.path).nlink).toBe(1);
      expect(record.value.kind).toBe("takoserver.integration-fresh-0092-create-custody@v1");
    }
    const dispatched = records.find((row) => row.value.stage === "create-dispatched");
    expect(dispatched?.value.previousDigest).toBeNull();
    expect(dispatched?.value.binding).toMatchObject({
      namespace: "integration-ts",
      generation: GENERATION,
      authority: "component-simulation",
    });
    expect(f.calls).toEqual([
      `listD1:${f.prefixedName}`,
      `listR2:${f.prefixedName}`,
      `listD1:${f.prefixedName}`,
      `listR2:${f.prefixedName}`,
      `createD1:${f.prefixedName}`,
      `getD1:${DATABASE_ID}`,
      `getD1:${DATABASE_ID}`,
      `listR2:${f.prefixedName}`,
      `createR2:${f.prefixedName}`,
      `getR2:${f.prefixedName}`,
    ]);
    expect(
      f.process.commands.some((command) => command.some((arg) => /production/iu.test(arg))),
    ).toBe(false);
    const retainedPayload = readdirSync(f.custodyDirectory).find((name) =>
      name.endsWith(".artifact"),
    );
    expect(retainedPayload).toBeDefined();
    expect(
      readdirSync(
        join(f.custodyDirectory, retainedPayload as string, "release/payload/migrations"),
      ),
    ).toHaveLength(92);
    expect(
      readFileSync(
        join(f.custodyDirectory, retainedPayload as string, "release/payload/migration-import.sql"),
        "utf8",
      ),
    ).toContain("0092_org_wallet_lifecycle.sql");
  });

  test("terminal and unknown status remain read-only diagnosis and can never reissue original proof", async () => {
    const f = originalCreationFixture();
    await f.apply();
    const prior = f.records().map((row) => readFileSync(row.path, "utf8"));
    const status = await f.status();
    expect(status.originalCreate).toBeUndefined();
    expect(status.productionD1Guard).toBeUndefined();
    expect(status.originalCreateCustody).toMatchObject({
      state: "terminal",
      qualification: "diagnostic-only",
    });
    expect(status.readyForApply).toBe(false);
    expect(f.records().map((row) => readFileSync(row.path, "utf8"))).toEqual(prior);
    const creates = f.calls.filter((call) => call.startsWith("create")).length;
    await expect(f.apply()).rejects.toThrow("prior or uncertain custody");
    expect(f.calls.filter((call) => call.startsWith("create"))).toHaveLength(creates);
    expect(f.imports()).toBe(1);
  });

  test("new namespace requires original custody and refuses mixing, known UUID or ready/proof input before effects", async () => {
    const f = originalCreationFixture();
    for (const invalid of [
      { ...f.invocation, freshLineage: "v2-0088" },
      { ...f.invocation, databaseId: DATABASE_ID },
      { ...f.invocation, ready: true },
      { ...f.invocation, proof: { state: "terminal" } },
      { ...f.invocation, namespace: "STAGING" },
    ]) {
      await expect(
        runIntegrationStorageGeneration(
          invalid as IntegrationStorageGenerationInvocation,
          f.selected,
          f.options,
        ),
      ).rejects.toThrow();
    }
    const optionsWithoutOriginalCreate = { ...f.options };
    delete optionsWithoutOriginalCreate.originalCreate;
    await expect(
      runIntegrationStorageGeneration(f.invocation, f.selected, optionsWithoutOriginalCreate),
    ).rejects.toThrow("original creation requires");
    await expect(
      f.apply({ productionD1: { databaseName: "takoserver-runtime", databaseId: DATABASE_ID } }),
    ).rejects.toThrow("original creation requires");
    await expect(f.apply({ outputDirectory: join(fixtureRoot, "not-custody") })).rejects.toThrow(
      "original creation requires",
    );
    await expect(
      f.apply({
        originalCreate: {
          ...f.options.originalCreate,
          kind: "positive-fresh-0092",
          custodyDirectory: f.custodyDirectory,
          proof: true,
        } as NonNullable<IntegrationStorageGenerationOptions["originalCreate"]>,
      }),
    ).rejects.toThrow("original creation requires");
    expect(f.calls).toEqual([]);
    expect(f.records()).toEqual([]);
  });

  test("legacy fresh92 still requires the production tuple and does not silently select the new namespace", async () => {
    const f = originalCreationFixture();
    const optionsWithoutOriginalCreate = { ...f.options };
    delete optionsWithoutOriginalCreate.originalCreate;
    await expect(
      runIntegrationStorageGeneration(
        { ...invocation, freshLineage: "v2-0092" },
        f.selected,
        optionsWithoutOriginalCreate,
      ),
    ).rejects.toThrow("requires TAKOSERVER_DEPLOY_TARGET_PRODUCTION");
    const legacy = await runIntegrationStorageGeneration(
      { ...invocation, action: "status" },
      f.selected,
      optionsWithoutOriginalCreate,
    );
    expect(legacy.namespace).toBeUndefined();
    expect(legacy.originalCreateCustody).toBeUndefined();
    expect(legacy.productionD1Guard).toEqual({ compared: "naming-only" });
    expect(f.calls).toEqual([`listD1:${GENERATED_NAME}`, `listR2:${GENERATED_NAME}`]);
  });

  test("selected names, preexisting resources and either absence fence never become fresh origin", async () => {
    for (const mode of [
      "selected-d1",
      "selected-r2",
      "existing-d1",
      "existing-r2",
      "second-d1",
      "second-r2",
    ] as const) {
      const f = originalCreationFixture();
      if (mode === "selected-d1") f.selected.d1.databaseName = f.prefixedName;
      if (mode === "selected-r2") f.selected.r2.bucketName = f.prefixedName;
      let reads = 0;
      if (mode.includes("d1") && mode !== "selected-d1")
        f.provider.listD1 = async () => {
          reads += 1;
          return mode === "existing-d1" || reads === 2
            ? [{ name: f.prefixedName, uuid: DATABASE_ID }]
            : [];
        };
      if (mode.includes("r2") && mode !== "selected-r2")
        f.provider.listR2 = async () => {
          reads += 1;
          return mode === "existing-r2" || reads === 2 ? [{ name: f.prefixedName }] : [];
        };
      await expect(f.apply()).rejects.toThrow();
      expect(f.imports()).toBe(0);
      expect(f.calls.some((call) => call.startsWith("create"))).toBe(false);
      expect(f.records()).toEqual([]);
    }
  });

  test("original create dispatch exists before provider entry and lost ACK stays UNKNOWN after reopen", async () => {
    const f = originalCreationFixture();
    f.provider.createD1 = async () => {
      expect(f.records().some((row) => row.value.stage === "create-dispatched")).toBe(true);
      throw new Error("lost ACK confidential response");
    };
    const error = await rejectedError(f.apply());
    expect(error.message).not.toContain("confidential");
    expect(f.records().some((row) => row.value.stage === "unknown")).toBe(true);
    const count = f.records().length;
    await expect(f.apply()).rejects.toThrow("prior or uncertain custody");
    expect(f.records()).toHaveLength(count);
    const status = await f.status();
    expect(status.originalCreateCustody).toMatchObject({
      state: "unknown",
      qualification: "diagnostic-only",
    });
    expect(status.originalCreate).toBeUndefined();
    expect(status.readyForApply).toBe(false);
    expect(f.imports()).toBe(0);
  });

  test("wrong original create identity or GET and incumbent UUID cannot reach SQL or R2", async () => {
    for (const mode of [
      "create-name",
      "create-uuid",
      "get-name",
      "get-uuid",
      "incumbent-uuid",
    ] as const) {
      const f = originalCreationFixture();
      if (mode === "create-name")
        f.provider.createD1 = async () => ({ name: GENERATED_NAME, uuid: DATABASE_ID });
      if (mode === "create-uuid")
        f.provider.createD1 = async (name) => ({ name, uuid: "not-an-id" });
      if (mode === "get-name")
        f.provider.getD1 = async () => ({ name: GENERATED_NAME, uuid: DATABASE_ID });
      if (mode === "get-uuid")
        f.provider.getD1 = async () => ({
          name: f.prefixedName,
          uuid: "00000000-0000-4000-8000-000000000099",
        });
      if (mode === "incumbent-uuid")
        f.provider.createD1 = async (name) => ({ name, uuid: f.selected.d1.databaseId });
      await expect(f.apply()).rejects.toThrow();
      expect(f.imports()).toBe(0);
      expect(f.records().some((row) => row.value.stage === "unknown")).toBe(true);
      expect(f.calls.some((call) => call.startsWith("createR2"))).toBe(false);
    }
  });

  test("nonempty new D1 is never migrated or promoted", async () => {
    const f = originalCreationFixture();
    f.database.exec(
      "CREATE TABLE protected_row(id INTEGER PRIMARY KEY, amount INTEGER); INSERT INTO protected_row VALUES(1, 7)",
    );
    await expect(f.apply()).rejects.toThrow();
    expect(f.imports()).toBe(0);
    expect(f.database.query("SELECT amount FROM protected_row").get()).toEqual({ amount: 7 });
    expect(f.calls.some((call) => call.startsWith("createR2"))).toBe(false);
    expect(f.records().some((row) => row.value.stage === "unknown")).toBe(true);
  });

  test("actual application/seed data drift after fixed92 import withholds R2 and terminal", async () => {
    for (const mode of ["missing-seed", "application-row"] as const) {
      const f = originalCreationFixture();
      const readFresh = f.options.freshV2DataReader?.read;
      if (readFresh === undefined) throw new Error("fresh reader missing");
      await expect(
        f.apply({
          freshV2DataReader: {
            async read(phase, configPath) {
              if (mode === "missing-seed") {
                f.database.exec("DELETE FROM tf_v2_operation_acceptance_counter");
              } else {
                f.database.exec(
                  "INSERT INTO stripe_events(event_id,type,livemode,event_created_at,received_at,outcome) VALUES('evt_fixture','fixture',0,'2026-10-01','2026-10-01','received')",
                );
              }
              return await readFresh(phase, configPath);
            },
          },
        }),
      ).rejects.toThrow("exact empty 0092");
      expect(f.imports()).toBe(1);
      expect(f.calls.some((call) => call.startsWith("createR2"))).toBe(false);
      expect(f.records().some((row) => row.value.stage === "terminal")).toBe(false);
    }
  });

  test("import lost ACK retains its original SQL dispatch and status cannot adopt complete92", async () => {
    const f = originalCreationFixture();
    const execute = f.options.run;
    if (execute === undefined) throw new Error("run missing");
    const opts = {
      ...f.options,
      run: async (command: readonly string[], runOptions?: Parameters<typeof execute>[1]) => {
        const result = await execute(command, runOptions);
        if (command.includes("--file")) throw new Error("lost import ACK");
        return result;
      },
    };
    await expect(runIntegrationStorageGeneration(f.invocation, f.selected, opts)).rejects.toThrow(
      "indeterminate",
    );
    expect(f.readState().applied).toHaveLength(92);
    expect(f.records().some((row) => row.value.stage === "import-dispatched")).toBe(true);
    const before = f.records().map((row) => readFileSync(row.path, "utf8"));
    const status = await runIntegrationStorageGeneration(
      { ...f.invocation, action: "status" },
      f.selected,
      opts,
    );
    expect(status.schemaReadback).toBe("complete-0092");
    expect(status.originalCreateCustody).toMatchObject({ state: "unknown" });
    expect(status.originalCreate).toBeUndefined();
    expect(f.records().map((row) => readFileSync(row.path, "utf8"))).toEqual(before);
    await expect(runIntegrationStorageGeneration(f.invocation, f.selected, opts)).rejects.toThrow(
      "prior or uncertain custody",
    );
    expect(f.imports()).toBe(1);
  });

  test("partial actual migration failure stays UNKNOWN with exactly one SQL dispatch", async () => {
    const f = originalCreationFixture();
    const execute = f.options.run;
    if (execute === undefined) throw new Error("run missing");
    let dispatches = 0;
    const opts = {
      ...f.options,
      run: async (command: readonly string[], runOptions?: Parameters<typeof execute>[1]) => {
        if (command.includes("--file")) {
          dispatches += 1;
          f.database.exec(MIGRATIONS[0]?.sql ?? "");
          return { exitCode: 1, stdout: "", stderr: "confidential raw provider response" };
        }
        return await execute(command, runOptions);
      },
    };
    const error = await rejectedError(
      runIntegrationStorageGeneration(f.invocation, f.selected, opts),
    );
    expect(error.message).not.toContain("confidential");
    expect(f.readState().shape).not.toBe(emptyState.shape);
    expect(f.records().some((row) => row.value.stage === "unknown")).toBe(true);
    await expect(runIntegrationStorageGeneration(f.invocation, f.selected, opts)).rejects.toThrow(
      "prior or uncertain custody",
    );
    expect(dispatches).toBe(1);
    expect(f.calls.some((call) => call.startsWith("createR2"))).toBe(false);
  });

  test("changed fixed source or sealed SQL cannot cross the original create boundary", async () => {
    const f = originalCreationFixture();
    const corruptSource = join(fixtureRoot, "corrupt-original-source");
    cpSync(currentMigrations, corruptSource, { recursive: true });
    const last = MIGRATIONS[91]?.name;
    if (last === undefined) throw new Error("0092 missing");
    writeFileSync(
      join(corruptSource, last),
      `${readFileSync(join(corruptSource, last), "utf8")}\n-- changed bytes\n`,
    );
    await expect(f.apply({ migrationDirectory: corruptSource })).rejects.toThrow();
    expect(f.calls).toEqual([]);
    let reads = 0;
    f.provider.listD1 = async () => {
      if (++reads === 2) {
        const artifact = readdirSync(f.custodyDirectory).find((name) => name.endsWith(".artifact"));
        if (artifact === undefined) throw new Error("artifact missing");
        const path = join(f.custodyDirectory, artifact, "release/payload/migration-import.sql");
        chmodSync(path, 0o600);
        writeFileSync(path, `${readFileSync(path, "utf8")}\n-- changed sealed SQL\n`);
      }
      return [];
    };
    await expect(f.apply()).rejects.toThrow("changed after it was sealed");
    expect(f.calls.some((call) => call.startsWith("create"))).toBe(false);
    expect(f.records()).toEqual([]);
    expect(f.imports()).toBe(0);
  });

  test("R2 race, lost ACK and GET drift preserve one-shot UNKNOWN without terminal", async () => {
    for (const mode of ["race", "lost-ack", "get-drift"] as const) {
      const f = originalCreationFixture();
      if (mode === "race") {
        let reads = 0;
        f.provider.listR2 = async (name) => (++reads === 3 ? [{ name }] : []);
      }
      if (mode === "lost-ack")
        f.provider.createR2 = async () => {
          throw new Error("lost R2 ACK");
        };
      if (mode === "get-drift") f.provider.getR2 = async () => ({ name: GENERATED_NAME });
      await expect(f.apply()).rejects.toThrow();
      expect(f.imports()).toBe(1);
      expect(f.records().some((row) => row.value.stage === "unknown")).toBe(true);
      expect(f.records().some((row) => row.value.stage === "terminal")).toBe(false);
      await expect(f.apply()).rejects.toThrow("prior or uncertain custody");
      expect(f.imports()).toBe(1);
    }
  });

  test("mutated caller binding at an async fence cannot select another account or mint evidence", async () => {
    const f = originalCreationFixture();
    f.provider.listD1 = async () => {
      f.selected.accountId = "d".repeat(32);
      return [];
    };
    await expect(f.apply()).rejects.toThrow("binding or custody root changed");
    expect(f.calls.some((call) => call.startsWith("create"))).toBe(false);
    expect(f.records()).toEqual([]);
  });

  test("custody aliases, unsafe roots and tampered original bytes never authorize another attempt", async () => {
    const f = originalCreationFixture();
    const alias = `${f.custodyDirectory}-alias`;
    symlinkSync(f.custodyDirectory, alias);
    await expect(
      f.apply({
        originalCreate: {
          kind: "positive-fresh-0092",
          custodyDirectory: alias,
          custodyIdentity: f.custodyIdentity,
        },
      }),
    ).rejects.toThrow("0700 custody root");
    chmodSync(f.custodyDirectory, 0o755);
    await expect(f.apply()).rejects.toThrow("0700 custody root");
    chmodSync(f.custodyDirectory, 0o700);
    await f.apply();
    const dispatch = f.records().find((row) => row.value.stage === "create-dispatched");
    if (dispatch === undefined) throw new Error("dispatch missing");
    writeFileSync(
      dispatch.path,
      JSON.stringify({ ...dispatch.value, binding: { namespace: "takoserver-i" } }),
    );
    await expect(f.status()).rejects.toThrow("retained operation");
    await expect(f.apply()).rejects.toThrow("retained operation");
    expect(f.imports()).toBe(1);
  });

  test("reopen refuses a replaced custody root before credentials or effects and never repins it", async () => {
    const f = originalCreationFixture();
    await f.apply();
    const calls = f.calls.length;
    renameSync(f.custodyDirectory, `${f.custodyDirectory}-original-retained`);
    mkdirSync(f.custodyDirectory, { mode: 0o700 });
    await expect(f.apply()).rejects.toThrow("provisioning-time device/inode pin");
    await expect(f.status()).rejects.toThrow("provisioning-time device/inode pin");
    expect(f.calls).toHaveLength(calls);
    expect(f.imports()).toBe(1);
    expect(readdirSync(f.custodyDirectory)).toEqual([]);
  });

  test("stable generation lock fences concurrent original calls even before first provider ACK", async () => {
    const f = originalCreationFixture();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const create = f.provider.createD1;
    f.provider.createD1 = async (name) => {
      entered?.();
      await blocked;
      return await create(name);
    };
    const first = f.apply();
    await reached;
    await expect(f.apply()).rejects.toThrow("prior or uncertain custody");
    release?.();
    await first;
    expect(f.imports()).toBe(1);
    expect(f.calls.filter((call) => call.startsWith("createD1"))).toHaveLength(1);
  });

  test("new native storage proof binds namespace/name/UUID and rejects mixed lineage without granting origin", async () => {
    const f = originalCreationFixture();
    await f.apply();
    const selected = {
      ...f.selected,
      d1: { databaseName: f.prefixedName, databaseId: DATABASE_ID },
      r2: { bucketName: f.prefixedName },
      takoformV2: { config: "{}", storageLineage: "v2-0092" as const },
    };
    const proof = await verifyFreshV2IntegrationStorageTarget(selected, "integration", "v2-0092", {
      provider: f.provider,
      ...(f.options.reader === undefined ? {} : { reader: f.options.reader }),
      migrationDirectory: currentMigrations,
    });
    expect(proof).toMatchObject({
      namespace: "integration-ts",
      generation: GENERATION,
      freshLineage: "v2-0092",
      d1: { databaseName: f.prefixedName, databaseId: DATABASE_ID },
    });
    expect((proof as unknown as Record<string, unknown>).originalCreate).toBeUndefined();
    await expect(
      verifyFreshV2IntegrationStorageTarget(
        { ...selected, takoformV2: { config: "{}", storageLineage: "v2-0088" } },
        "integration",
        "v2-0088",
        { provider: f.provider },
      ),
    ).rejects.toThrow("explicit fresh v2-0092 origin");
    await expect(
      verifyFreshV2IntegrationStorageTarget(
        { ...selected, r2: { bucketName: GENERATED_NAME } },
        "integration",
        "v2-0092",
        { provider: f.provider },
      ),
    ).rejects.toThrow("exact matching");
  });
});

interface BoundedCustodyProbeResult {
  readonly mode: string;
  readonly pid: number;
  readonly message: string;
  readonly mutations: number;
  readonly wholeFdReads: number;
  readonly requestedBytes: number;
  readonly injected: boolean;
  readonly timedOut: boolean;
}

/** Isolated instrumentation changes real local files; it does not simulate a native race. */
async function boundedCustodyProbe(mode: string): Promise<BoundedCustodyProbeResult> {
  const f = originalCreationFixture();
  const moduleUrl = new URL("../scripts/deploy/integration-storage-generation.ts", import.meta.url)
    .href;
  const stem = `integration-create-${createHash("sha256")
    .update(
      JSON.stringify({
        accountId: f.selected.accountId,
        namespace: "integration-ts",
        generation: GENERATION,
      }),
    )
    .digest("hex")}`;
  const entry = join(f.custodyDirectory, `${stem}.create-dispatched.json`);
  const artifactEntry = join(f.custodyDirectory, `${stem}.artifact`, "probe-original-entry");
  const script = `
    import * as nativeFs from "node:fs";
    import { mock } from "bun:test";
    const fs = { ...nativeFs };
    const mode = ${JSON.stringify(mode)};
    const entry = ${JSON.stringify(entry)};
    const artifactEntry = ${JSON.stringify(artifactEntry)};
    const input = ${JSON.stringify({ invocation: f.invocation, target: f.selected, originalCreate: f.options.originalCreate })};
    let watchedFd = -1, mutations = 0, wholeFdReads = 0, requestedBytes = 0, injected = false;
    const fifo = (path) => {
      const result = Bun.spawnSync(["mkfifo", "--mode=600", path]);
      if (result.exitCode !== 0) throw new Error("local FIFO creation failed");
    };
    if (!mode.startsWith("sync-")) {
      if (mode === "fifo") fifo(entry);
      else fs.writeFileSync(entry, mode === "oversize" ? Buffer.alloc(32 * 1024 + 1) : "{}", { mode: 0o600 });
    }
    mock.module("node:fs", () => ({
      ...fs,
      openSync(path, flags, ...rest) {
        const watched = path === entry || path === artifactEntry;
        if (watched && mode === "fifo-swap" && !injected) {
          fs.unlinkSync(path); fifo(path); injected = true;
        }
        const fd = fs.openSync(path, flags, ...rest);
        if (watched) {
          watchedFd = fd;
          if (mode === "sync-replaced" && !injected) {
            fs.renameSync(path, path + ".held"); fs.writeFileSync(path, "{}", { mode: 0o600 }); injected = true;
          }
        }
        return fd;
      },
      readFileSync(path, ...args) {
        if (typeof path === "number" && path === watchedFd) wholeFdReads += 1;
        return fs.readFileSync(path, ...args);
      },
      readSync(fd, buffer, offset, length, position) {
        if (fd === watchedFd) {
          requestedBytes += length;
          if (!injected && mode === "growth") {
            fs.appendFileSync(entry, Buffer.alloc(32 * 1024 + 1)); injected = true;
          } else if (!injected && mode === "replaced") {
            fs.renameSync(entry, entry + ".held"); fs.writeFileSync(entry, "{}", { mode: 0o600 }); injected = true;
          }
        }
        return fs.readSync(fd, buffer, offset, length, position);
      },
    }));
    const { runIntegrationStorageGeneration } = await import(${JSON.stringify(moduleUrl)});
    let lists = 0;
    const provider = {
      async listD1() {
        if (++lists === 2 && mode.startsWith("sync-")) {
          if (mode === "sync-fifo") fifo(artifactEntry);
          else fs.writeFileSync(artifactEntry, "{}", { mode: 0o600 });
        }
        return [];
      },
      async listR2() { return []; },
      async createD1() { mutations += 1; throw new Error("unexpected provider mutation"); },
      async createR2() { mutations += 1; throw new Error("unexpected provider mutation"); },
      async getD1() { throw new Error("unexpected provider read"); },
      async getR2() { throw new Error("unexpected provider read"); },
    };
    const run = async command => {
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return { exitCode: 0, stdout: ${JSON.stringify(COMMIT + "\n")}, stderr: "" };
      if (key === "git branch --show-current") return { exitCode: 0, stdout: "component-local\\n", stderr: "" };
      if (key === "git status --porcelain=v1 -z --untracked-files=all" || key === "bun run check:migrations") return { exitCode: 0, stdout: "", stderr: "" };
      throw new Error("unexpected command");
    };
    let message = "";
    try {
      await runIntegrationStorageGeneration(input.invocation, input.target, { provider, run,
        review: "independent-component-custody-read", originalCreate: input.originalCreate,
        migrationDirectory: ${JSON.stringify(currentMigrations)},
        reader: { async read() { throw new Error("unexpected schema read"); } },
      });
    } catch (error) { message = error.message; }
    console.log(JSON.stringify({ mode, pid: process.pid, message, mutations, wholeFdReads, requestedBytes, injected }));
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 1500);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    console.info(
      `bounded-custody-child mode=${mode} pid=${child.pid} exit=${code} timedOut=${timedOut}`,
    );
    expect(timedOut).toBe(false);
    expect(code).toBe(0);
    if (code !== 0) throw new Error(stderr);
    return { ...JSON.parse(stdout.trim()), timedOut } as BoundedCustodyProbeResult;
  } finally {
    clearTimeout(timeout);
  }
}

describe("bounded original custody retained-file I/O", () => {
  test("bounded custody read refuses FIFO/oversize and controlled real growth or replacement", async () => {
    for (const mode of ["fifo", "fifo-swap", "oversize", "growth", "replaced"]) {
      const result = await boundedCustodyProbe(mode);
      expect(result.message).toContain("UNKNOWN");
      expect(result.mutations).toBe(0);
      expect(result.wholeFdReads).toBe(0);
      expect(result.requestedBytes).toBeLessThanOrEqual(3);
      if (["fifo-swap", "growth", "replaced"].includes(mode)) expect(result.injected).toBe(true);
    }
  });

  test("bounded custody artifact fsync refuses FIFO and a replaced held/path entry before create", async () => {
    for (const mode of ["sync-fifo", "sync-replaced"]) {
      const result = await boundedCustodyProbe(mode);
      expect(result.message).toContain("UNKNOWN");
      expect(result.mutations).toBe(0);
      expect(result.wholeFdReads).toBe(0);
      if (mode === "sync-replaced") expect(result.injected).toBe(true);
    }
  });
});
