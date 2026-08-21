import { resolve } from "node:path";
import { DeployError, type DeployPhase } from "./errors.ts";

export const REPOSITORY = resolve(import.meta.dir, "..", "..");
export const WRANGLER = resolve(REPOSITORY, "node_modules/.bin/wrangler");

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command to completion, capturing both streams and never inheriting stdin. */
export async function runCommand(
  command: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    /** Exact bytes written to the child without ever placing them in argv. */
    readonly input?: string;
  } = {},
): Promise<CommandResult> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new TypeError("a command is required");
  const child = Bun.spawn([executable, ...args], {
    cwd: REPOSITORY,
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1", ...options.env },
  });
  if (options.input !== undefined) {
    const stdin = child.stdin;
    if (!stdin) throw new TypeError("the child process did not expose the requested stdin pipe");
    stdin.write(options.input);
    stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Runs a command and raises a phase-classified failure with the raw diagnostics
 * attached. Callers never retry blindly: the phase decides what a retry means.
 */
export async function runChecked(
  phase: DeployPhase,
  description: string,
  command: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: string;
  } = {},
): Promise<string> {
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new DeployError(
      phase,
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}

export function wranglerCommand(args: readonly string[]): readonly string[] {
  return [WRANGLER, ...args];
}
