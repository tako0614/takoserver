import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type {
  D1SchemaState,
  MigrationArtifact,
  MigrationFile,
} from "@takoserver/core/deploy-extension";
import * as deployExtension from "@takoserver/core/deploy-extension";

const REPOSITORY = resolve(import.meta.dir, "..");

describe("curated deploy extension schema readback", () => {
  test("imports without Cloudflare credentials or Wrangler on PATH", async () => {
    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const api = await import("@takoserver/core/deploy-extension"); console.log(JSON.stringify({ read: typeof api.readD1SchemaState, match: typeof api.applicationSchemaMatches, derive: typeof api.deriveExpectedApplicationShape, audit: typeof api.readAuditedMigrationArtifact }));`,
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
    });
    for (const forbidden of [
      "readMigrationArtifact",
      "readOperationGenerationMigrationArtifact",
      "runD1Schema",
      "runD1SchemaRehearsalBaseline",
    ]) {
      expect(forbidden in deployExtension).toBe(false);
    }
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

    const wireRows = [
      {
        type: "table",
        name: "d1_migrations",
        tbl_name: "d1_migrations",
        sql: "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      },
      ...expectedApplicationRows.map(({ type, name, table, sql }) => ({
        type,
        name,
        tbl_name: table,
        sql,
      })),
    ].sort((left, right) =>
      `${left.type}\0${left.name}`.localeCompare(`${right.type}\0${right.name}`),
    );
    const statements: string[] = [];
    const database = new deployExtension.RemoteD1("/unused/wrangler.jsonc", {
      environment: {},
      run: async (command) => {
        const commandIndex = command.indexOf("--command");
        const sql = commandIndex < 0 ? "" : command[commandIndex + 1];
        if (sql === undefined) throw new Error("D1 process omitted its SQL command");
        statements.push(sql);
        const results = sql.includes("SELECT name FROM sqlite_schema")
          ? [{ name: "d1_migrations" }]
          : sql.includes("SELECT name FROM d1_migrations")
            ? [{ name: artifact.names[56] }]
            : wireRows;
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ success: true, results }]),
          stderr: "",
        };
      },
    });

    const state: D1SchemaState = await deployExtension.readD1SchemaState(database);
    expect(state.applied).toEqual([
      "0057_cloudflare_managed_worker_version_execution_material.sql",
    ]);
    expect(state.shapeDigest).toBe(
      `sha256:${createHash("sha256").update(state.shape).digest("hex")}`,
    );
    expect(deployExtension.applicationSchemaMatches(state, expectedApplicationShape)).toBe(true);
    expect(statements).toHaveLength(3);
    expect(statements.every((statement) => /^SELECT\b/u.test(statement))).toBe(true);
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
