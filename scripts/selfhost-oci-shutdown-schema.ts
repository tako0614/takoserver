import { Database } from "bun:sqlite";
import { type BigIntStats, constants, createWriteStream } from "node:fs";
import { link, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { privateDirectoryChainProblem } from "../src/selfhost-data-root.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { inspectV2ConfiguredUpdateDiscardSchema } from "../src/takoform-v2/configured-private-inputs.ts";
import {
  v2ConfiguredUpdateDiscardTransition,
  v2FinalDeleteConfiguredUpdateDiscardTransition,
} from "../src/takoform-v2/configured-update-inputs-schema.ts";
import {
  inspectV2ContainerOwnerApplicationSuccessorSchema,
  inspectV2ContainerOwnerFinalDeleteSchema,
  inspectV2ContainerOwnerShutdownIoSchema,
  V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";

const usage =
  "Usage: bun --no-env-file scripts/selfhost-oci-shutdown-schema.ts <prepare|prepare-successor> <stopped-backup.sqlite> <new-output.sqlite>";

async function prepareSuccessorStatements(sql: Sql): Promise<readonly SqlStatement[]> {
  const statements: SqlStatement[] = [];
  if (!(await inspectV2ContainerOwnerApplicationSuccessorSchema(sql)))
    statements.push(...V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.statements);
  if (!(await inspectV2ConfiguredUpdateDiscardSchema(sql, "final-delete"))) {
    if (!(await inspectV2ConfiguredUpdateDiscardSchema(sql, "retired-update")))
      statements.push(...v2ConfiguredUpdateDiscardTransition());
    statements.push(...v2FinalDeleteConfiguredUpdateDiscardTransition());
  }
  return statements;
}

const preparations = {
  prepare: {
    inspectSource: inspectV2ContainerOwnerFinalDeleteSchema,
    sourceSchema: "Container final-delete",
    statements: () => V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements,
    inspectOutput: inspectV2ContainerOwnerShutdownIoSchema,
    outputSchema: "shutdown",
  },
  "prepare-successor": {
    inspectSource: async (sql: Sql) =>
      (await inspectV2ContainerOwnerShutdownIoSchema(sql)) ||
      ((await inspectV2ContainerOwnerApplicationSuccessorSchema(sql)) &&
        !(await inspectV2ConfiguredUpdateDiscardSchema(sql, "final-delete"))),
    sourceSchema: "Container shutdown evidence or incomplete application successor",
    statements: prepareSuccessorStatements,
    inspectOutput: async (sql: Sql) =>
      (await inspectV2ContainerOwnerApplicationSuccessorSchema(sql)) &&
      (await inspectV2ConfiguredUpdateDiscardSchema(sql, "final-delete")),
    outputSchema: "complete application successor",
  },
} as const;

function privatePath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(`${label} must be an absolute canonical file path`);
  const problem = privateDirectoryChainProblem(dirname(path), label);
  if (problem) throw new Error(problem);
}

async function requireAbsent(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

async function requireStandaloneFile(path: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"])
    await requireAbsent(`${path}${suffix}`, "a SQLite sidecar exists");
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function prepare(
  source: string,
  output: string,
  preparation: (typeof preparations)[keyof typeof preparations],
): Promise<void> {
  privatePath(source, "backup");
  privatePath(output, "output");
  await requireAbsent(output, "output already exists");
  await requireStandaloneFile(source);
  await requireStandaloneFile(output);

  const scratch = await mkdtemp(join(dirname(output), ".oci-shutdown-schema-"));
  const candidate = join(scratch, "candidate.sqlite");
  try {
    const input = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await input.stat({ bigint: true });
      const uid = process.getuid?.();
      if (
        uid === undefined ||
        !before.isFile() ||
        before.uid !== BigInt(uid) ||
        (before.mode & 0o077n) !== 0n ||
        before.nlink !== 1n
      )
        throw new Error("backup must be an owned private single-link regular file");
      await pipeline(
        input.createReadStream({ autoClose: false }),
        createWriteStream(candidate, { flags: "wx", mode: 0o600 }),
      );
      if (!sameFile(before, await lstat(source, { bigint: true })))
        throw new Error("backup changed while preparing its copy");
    } finally {
      await input.close();
    }
    await requireStandaloneFile(source);

    const db = new Database(candidate, { readwrite: true, create: false });
    try {
      const sql = createSqliteSql(db);
      const applied = await sql.query("SELECT name FROM applied_migrations ORDER BY rowid");
      if (
        applied.length !== MIGRATIONS.length ||
        applied.some((row, index) => row.name !== MIGRATIONS[index]?.name)
      )
        throw new Error("backup does not have the exact stock SQLite migration lineage");
      if (!(await preparation.inspectSource(sql)))
        throw new Error(`backup does not have the exact ${preparation.sourceSchema} schema`);
      await sql.batch(await preparation.statements(sql));
    } finally {
      db.close();
    }
    await requireStandaloneFile(candidate);
    const reopened = new Database(candidate, { readonly: true, create: false });
    try {
      const integrity = reopened.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
      if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok")
        throw new Error("prepared copy did not pass the SQLite integrity check");
      if (!(await preparation.inspectOutput(createSqliteSql(reopened))))
        throw new Error(
          `prepared copy does not retain the exact ${preparation.outputSchema} schema`,
        );
    } finally {
      reopened.close();
    }
    await requireStandaloneFile(candidate);
    await requireStandaloneFile(output);
    await link(candidate, output);
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch {
      process.stderr.write(`Could not remove the private working directory ${scratch}.\n`);
    }
  }
}

if (import.meta.main) {
  const [action, source, output, ...rest] = Bun.argv.slice(2);
  if (
    (action !== "prepare" && action !== "prepare-successor") ||
    !source ||
    !output ||
    rest.length > 0
  ) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 1;
  } else {
    const preparation = preparations[action];
    try {
      await prepare(source, output, preparation);
      process.stdout.write(`${JSON.stringify({ status: "prepared", output })}\n`);
    } catch (error) {
      process.stderr.write(
        `Unable to prepare an OCI ${preparation.outputSchema} schema copy. ${String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
