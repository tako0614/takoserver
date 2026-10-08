import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type {
  D1SchemaState,
  MigrationArtifact,
  MigrationFile,
  SchemaInvocation,
  SchemaOptions,
} from "@takoserver/core/deploy-extension";
import * as deployExtension from "@takoserver/core/deploy-extension";

const REPOSITORY = resolve(import.meta.dir, "..");

describe("curated deploy extension schema readback", () => {
  test("imports without Cloudflare credentials or Wrangler on PATH", async () => {
    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const api = await import("@takoserver/core/deploy-extension"); console.log(JSON.stringify({ read: typeof api.readD1SchemaState, match: typeof api.applicationSchemaMatches, derive: typeof api.deriveExpectedApplicationShape, audit: typeof api.readAuditedMigrationArtifact, currentSource: typeof api.readCurrentAuditedMigrationSourceArtifact, writer: typeof api.runD1Schema }));`,
      ],
      {
        cwd: REPOSITORY,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { HOME: process.env.HOME ?? "/tmp", PATH: dirname(process.execPath) },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout.trim())).toEqual({
      read: "function",
      match: "function",
      derive: "function",
      audit: "function",
      currentSource: "function",
      writer: "function",
    });
    for (const forbidden of [
      "readMigrationArtifact",
      "readOperationGenerationMigrationArtifact",
      "runD1SchemaRehearsalBaseline",
    ]) {
      expect(forbidden in deployExtension).toBe(false);
    }
  });

  test("exports the existing D1 writer and its invocation/options types without a second implementation", () => {
    const invocation: SchemaInvocation = {
      action: "status",
      environment: "integration",
      commit: "a".repeat(40),
      throughMigration: "0088",
    };
    const options: SchemaOptions = {
      v2ExistingMaintenance: {
        historicalSourceRoot: "/fixture/historical",
        providerExecutorQualification: {
          read: async () => {
            throw new Error("unused fixture");
          },
        },
      },
    };
    expect(invocation.throughMigration).toBe("0088");
    expect(options.v2ExistingMaintenance?.historicalSourceRoot).toBe("/fixture/historical");
    expect(deployExtension.runD1Schema).toBeDefined();
  });

  test("exposes the audited current source without widening the legacy artifact", () => {
    const legacy = deployExtension.readAuditedMigrationArtifact();
    const current = deployExtension.readCurrentAuditedMigrationSourceArtifact();
    expect(legacy.names).toHaveLength(66);
    expect(current.names).toHaveLength(88);
    expect(current.names.slice(0, legacy.names.length)).toEqual([...legacy.names]);
    expect(current.files.at(-1)?.name).toBe("0088_v2_worker_sqlite_external_drain.sql");
  });

  test("reads a 0057 schema through the curated read-only database port", async () => {
    const artifact: MigrationArtifact = deployExtension.readAuditedMigrationArtifact();
    const firstFile: MigrationFile | undefined = artifact.files[0];
    expect(firstFile?.name).toBe("0001_runtime_storage.sql");
    const expectedApplicationShape = deployExtension.deriveExpectedApplicationShape(
      artifact.files.slice(0, 57),
    );
    const expectedApplicationRows = JSON.parse(expectedApplicationShape) as {
      readonly type: string;
      readonly name: string;
      readonly table: string;
      readonly sql: string;
    }[];
    expect(
      expectedApplicationRows.some(
        ({ name }) => name === "cloudflare_managed_worker_version_execution_material",
      ),
    ).toBe(true);
    expect(expectedApplicationRows.some(({ name }) => name.startsWith("migration_0058_"))).toBe(
      false,
    );

    const sqlite = new Database(":memory:");
    try {
      sqlite.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      for (const file of artifact.files.slice(0, 57)) {
        sqlite.exec(await Bun.file(file.path).text());
      }
      sqlite.exec(
        "INSERT INTO d1_migrations (id, name) VALUES (57, '0057_cloudflare_managed_worker_version_execution_material.sql')",
      );
      const internalIndexNames = sqlite
        .query("SELECT name FROM sqlite_schema WHERE name GLOB 'sqlite_autoindex_*'")
        .all() as { readonly name: string }[];
      expect(internalIndexNames.length).toBeGreaterThan(0);

      const statements: string[] = [];
      const database = new deployExtension.RemoteD1("/unused/wrangler.jsonc", {
        environment: {},
        run: async (command) => {
          const commandIndex = command.indexOf("--command");
          const sql = commandIndex < 0 ? "" : command[commandIndex + 1];
          if (sql === undefined) throw new Error("D1 process omitted its SQL command");
          statements.push(sql);
          const results = sqlite.query(sql).all() as Record<string, unknown>[];
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ success: true, results }]),
            stderr: "",
          };
        },
      });

      const baseline: D1SchemaState = await deployExtension.readD1SchemaState(database);
      expect(baseline.applied).toEqual([
        "0057_cloudflare_managed_worker_version_execution_material.sql",
      ]);
      const baselineRows = JSON.parse(baseline.shape) as { readonly name: string }[];
      expect(baselineRows.some(({ name }) => name === "sqliteXrogue")).toBe(false);
      expect(baselineRows.some(({ name }) => name.startsWith("sqlite_autoindex_"))).toBe(false);
      expect(deployExtension.applicationSchemaMatches(baseline, expectedApplicationShape)).toBe(
        true,
      );

      sqlite.exec("CREATE TABLE sqliteXrogue (value TEXT)");
      const state: D1SchemaState = await deployExtension.readD1SchemaState(database);
      expect(state.applied).toEqual([
        "0057_cloudflare_managed_worker_version_execution_material.sql",
      ]);
      expect(state.shapeDigest).toBe(
        `sha256:${createHash("sha256").update(state.shape).digest("hex")}`,
      );
      const actualRows = JSON.parse(state.shape) as { readonly name: string }[];
      expect(actualRows.some(({ name }) => name === "sqliteXrogue")).toBe(true);
      expect(actualRows.some(({ name }) => name.startsWith("sqlite_autoindex_"))).toBe(false);
      expect(deployExtension.applicationSchemaMatches(state, expectedApplicationShape)).toBe(false);
      expect(statements.length).toBeGreaterThan(3);
      expect(statements.every((statement) => /^SELECT\b/u.test(statement))).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("classifies schema-shape failures in the requested D1 read phase", async () => {
    const validRows = [
      { type: "table", name: "items", tbl_name: "items", sql: "CREATE TABLE items" },
      { type: "table", name: "other", tbl_name: "other", sql: "CREATE TABLE other" },
    ];
    const malformedRows = [{ type: "table", name: "items" }];
    const cases = [
      {
        name: "malformed schema row",
        rows: malformedRows,
        message: "D1 schema shape row has no string tbl_name",
        detail: '{"keys":["name","type"]}',
      },
      {
        name: "non-canonical schema ordering",
        rows: [...validRows].reverse(),
        message: "D1 schema shape readback is not canonically ordered",
      },
    ] as const;

    for (const phase of ["preflight", "verification", "mutation", undefined] as const) {
      for (const scenario of cases) {
        const database = new deployExtension.RemoteD1("/unused/wrangler.jsonc", {
          environment: {},
          run: async (command) => {
            const commandIndex = command.indexOf("--command");
            const sql = commandIndex < 0 ? "" : command[commandIndex + 1];
            if (sql === undefined) throw new Error("D1 process omitted its SQL command");
            const results = sql.includes("SELECT name FROM sqlite_schema")
              ? [{ name: "items" }]
              : sql.includes("SELECT name FROM d1_migrations")
                ? []
                : scenario.rows;
            return {
              exitCode: 0,
              stdout: JSON.stringify([{ success: true, results }]),
              stderr: "",
            };
          },
        });

        const expectedPhase = phase ?? "preflight";
        const state =
          phase === undefined
            ? deployExtension.readD1SchemaState(database)
            : deployExtension.readD1SchemaState(database, phase);
        await expect(state).rejects.toMatchObject({
          name: "DeployError",
          phase: expectedPhase,
          message: scenario.message,
          ...("detail" in scenario ? { detail: scenario.detail } : {}),
        });
      }
    }
  });

  test("keeps D1 transport failures in the phase assigned by the database port", async () => {
    for (const phase of ["verification", "mutation"] as const) {
      const database = new deployExtension.RemoteD1("/unused/wrangler.jsonc", {
        environment: {},
        run: async (command) => {
          const commandIndex = command.indexOf("--command");
          const sql = commandIndex < 0 ? "" : command[commandIndex + 1];
          if (sql === undefined) throw new Error("D1 process omitted its SQL command");
          if (sql.includes("SELECT type, name, tbl_name")) {
            return { exitCode: 9, stdout: "", stderr: "redacted provider output" };
          }
          const results = sql.includes("SELECT name FROM sqlite_schema") ? [{ name: "items" }] : [];
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ success: true, results }]),
            stderr: "",
          };
        },
      });

      await expect(deployExtension.readD1SchemaState(database, phase)).rejects.toMatchObject({
        name: "DeployError",
        phase,
        message: "D1 canonical schema shape failed (exit 9)",
      });
    }
  });
});
