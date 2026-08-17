import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError, type DeployPhase } from "./errors.ts";
import { runChecked, wranglerCommand } from "./process.ts";

/**
 * Read and write access to the realized D1 database through Wrangler. SQL is
 * always delivered as a file so no value is ever pasted into a shell argument,
 * and statements stay parameterless by construction.
 */
export class RemoteD1 {
  readonly #configPath: string;

  constructor(configPath: string) {
    this.#configPath = configPath;
  }

  async query(
    phase: DeployPhase,
    description: string,
    sql: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const raw = await this.#execute(phase, description, sql, true);
    return parseResults(phase, description, raw);
  }

  async statement(phase: DeployPhase, description: string, sql: string): Promise<void> {
    await this.#execute(phase, description, sql, false);
  }

  async #execute(
    phase: DeployPhase,
    description: string,
    sql: string,
    json: boolean,
  ): Promise<string> {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-d1-sql-"));
    const file = join(directory, "statement.sql");
    try {
      writeFileSync(file, sql.endsWith(";") ? `${sql}\n` : `${sql};\n`, { mode: 0o600 });
      return await runChecked(
        phase,
        description,
        wranglerCommand([
          "d1",
          "execute",
          "STATE_DB",
          "--remote",
          "--yes",
          "--config",
          this.#configPath,
          ...(json ? ["--json"] : []),
          "--file",
          file,
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function parseResults(
  phase: DeployPhase,
  description: string,
  raw: string,
): readonly Record<string, unknown>[] {
  const start = raw.indexOf("[");
  if (start < 0) {
    throw new DeployError(phase, `${description} returned no JSON payload`, raw);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    throw new DeployError(phase, `${description} returned unparsable JSON`, raw);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new DeployError(phase, `${description} returned an unexpected shape`, raw);
  }
  const first = parsed[0];
  if (!isRecord(first) || !Array.isArray(first.results)) {
    throw new DeployError(phase, `${description} returned an unexpected shape`, raw);
  }
  return first.results.filter(isRecord);
}

/** Escapes a value for a single-quoted SQLite literal. */
export function sqlLiteral(value: string): string {
  if (value.includes("\u0000")) throw new TypeError("SQL literals may not contain NUL");
  return `'${value.replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
