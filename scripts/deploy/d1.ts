import { DeployError, type DeployPhase } from "./errors.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";

export type D1Process = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

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
// One SELECT and nothing else. PRAGMA statements are excluded: a call form
// such as user_version(5) or journal_mode(WAL) writes. Table-valued pragma_*
// functions inside a SELECT exist only for side-effect-free pragmas.
const READ_ONLY_STATEMENT = /^\s*SELECT\b[^;]*;?\s*$/isu;
/**
 * Wrangler's own top-level report of a client network failure before any D1
 * response, exactly as `--json` prints it. Any other output, including a D1 or
 * SQL error whose text happens to mention a network word, is not transport.
 */
function isWranglerTransportFailure(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return false;
  }
  if (!isRecord(parsed) || JSON.stringify(Object.keys(parsed)) !== '["error"]') return false;
  const error = parsed.error;
  return (
    isRecord(error) &&
    JSON.stringify(Object.keys(error)) === '["text"]' &&
    error.text === "fetch failed"
  );
}
const TRANSPORT_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

export class RemoteD1 {
  readonly #configPath: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #run: D1Process;
  readonly #wranglerCommand: (args: readonly string[]) => readonly string[];
  readonly #transportRetryDelaysMs: readonly number[];

  constructor(
    configPath: string,
    options: {
      readonly environment?: Readonly<Record<string, string>>;
      readonly run?: D1Process;
      readonly wranglerCommand?: (args: readonly string[]) => readonly string[];
      /** Test seam for the bounded read retry; deploy callers keep the default. */
      readonly transportRetryDelaysMs?: readonly number[];
    } = {},
  ) {
    this.#configPath = configPath;
    this.#environment = options.environment ?? cloudflareChildEnvironment();
    this.#run = options.run ?? runCommand;
    this.#wranglerCommand = options.wranglerCommand ?? wranglerCommand;
    this.#transportRetryDelaysMs = options.transportRetryDelaysMs ?? TRANSPORT_RETRY_DELAYS_MS;
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

  /**
   * A read-only statement whose Wrangler process failed before any D1 response
   * (a client network failure) is re-run a bounded number of times: reading
   * again changes nothing. Writes, multi-statement text and every D1 or SQL
   * error fail on the first attempt as before.
   */
  async #execute(
    phase: DeployPhase,
    description: string,
    sql: string,
    json: boolean,
  ): Promise<string> {
    const retryable = json && READ_ONLY_STATEMENT.test(sql);
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.#run(
        this.#wranglerCommand([
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
        { env: this.#environment },
      );
      if (result.exitCode === 0) return result.stdout;
      // Only the classification is kept: provider diagnostics can echo SQL
      // result values, and this transport is shared by sealed-BLOB integrity
      // reads, so raw output is never attached.
      const transport = json && isWranglerTransportFailure(result.stdout);
      const delay = this.#transportRetryDelaysMs[attempt - 1];
      if (retryable && transport && delay !== undefined) {
        await Bun.sleep(delay);
        continue;
      }
      throw new DeployError(phase, `${description} failed (exit ${result.exitCode})`, undefined, {
        code: transport ? "d1-transport" : "d1-command",
        operation: json ? "d1-read" : "d1-statement",
        attempts: attempt,
      });
    }
  }
}

function parseResults(
  phase: DeployPhase,
  description: string,
  raw: string,
): readonly Record<string, unknown>[] {
  const text = raw.trim();
  if (text.length === 0) {
    throw new DeployError(phase, `${description} returned no JSON payload`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DeployError(phase, `${description} returned unparsable JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new DeployError(phase, `${description} returned an unexpected shape`);
  }
  const first = parsed[0];
  if (!isRecord(first) || first.success !== true || !Array.isArray(first.results)) {
    throw new DeployError(phase, `${description} returned an unexpected shape`);
  }
  if (!first.results.every(isRecord)) {
    throw new DeployError(phase, `${description} returned an unexpected shape`);
  }
  const rows = first.results;
  for (const row of rows) {
    if ("Total queries executed" in row) {
      throw new DeployError(
        phase,
        `${description} received an execution summary instead of the selected rows`,
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
