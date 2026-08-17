import { DeployError, type DeployPhase } from "./errors.ts";
import { runChecked, wranglerCommand } from "./process.ts";

/**
 * Read and write access to the realized D1 database through Wrangler.
 *
 * SQL is passed as a single `--command` argument. Wrangler is spawned directly
 * with an argv array and never through a shell, so the statement text reaches
 * SQLite exactly as written; `sqlLiteral` is what keeps values inside their
 * quotes. `--file` is deliberately not used: with `--file` Wrangler's `--json`
 * output is an execution summary rather than the selected rows, which silently
 * turns every read into an empty result.
 */
export class RemoteD1 {
  readonly #configPath: string;

  constructor(configPath: string) {
    this.#configPath = configPath;
  }

  /**
   * Runs a single-column SELECT and returns that column. A returned row that
   * does not carry the requested column is a protocol failure, not an empty
   * read, so a shape change can never be mistaken for absent state.
   */
  async column(
    phase: DeployPhase,
    description: string,
    sql: string,
    name: string,
  ): Promise<readonly string[]> {
    const rows = await this.query(phase, description, sql);
    return rows.map((row) => {
      const value = row[name];
      if (typeof value !== "string") {
        throw new DeployError(
          phase,
          `${description} returned a row without a string \`${name}\` column`,
          JSON.stringify(row),
        );
      }
      return value;
    });
  }

  async query(
    phase: DeployPhase,
    description: string,
    sql: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return parseResults(phase, description, await this.#execute(phase, description, sql, true));
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
        "--command",
        sql,
      ]),
    );
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
  const rows = first.results.filter(isRecord);
  for (const row of rows) {
    if ("Total queries executed" in row) {
      throw new DeployError(
        phase,
        `${description} received an execution summary instead of the selected rows`,
        JSON.stringify(row),
      );
    }
  }
  return rows;
}

/** Escapes a value for a single-quoted SQLite literal. */
export function sqlLiteral(value: string): string {
  if (value.includes("\u0000")) throw new TypeError("SQL literals may not contain NUL");
  return `'${value.replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
