import { resolve } from "node:path";
import { DeployError, type DeployPhase } from "./errors.ts";

export const REPOSITORY = resolve(import.meta.dir, "..", "..");
export const WRANGLER = resolve(REPOSITORY, "node_modules/.bin/wrangler");

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const CHILD_SUBSTRATE = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const BUILDX_BUILDER_INPUT = "TAKOSERVER_BUILDX_BUILDER";
const BUILDX_BUILDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Builds the complete environment for a deploy child.
 *
 * A deploy process often holds unrelated operator credentials. Children get
 * only the process substrate needed to execute plus authority the caller names
 * for this exact command; ambient tokens never cross accidentally.
 */
export function sanitizedChildEnvironment(
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const environment: Record<string, string> = { CI: "1", NO_COLOR: "1" };
  for (const name of CHILD_SUBSTRATE) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes("\u0000")) {
      throw new TypeError(`invalid child environment entry ${JSON.stringify(name)}`);
    }
    environment[name] = value;
  }
  return environment;
}

/** Read one exact operator input without ever echoing its value. */
export function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new DeployError("preflight", `${name} is required and must not have outer whitespace`);
  }
  return value;
}

/** The only ambient credential forwarded to Cloudflare commands. */
export function cloudflareChildEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    CLOUDFLARE_API_TOKEN: requireEnvironment("CLOUDFLARE_API_TOKEN"),
  };
  const builder = process.env[BUILDX_BUILDER_INPUT];
  if (builder !== undefined) {
    if (!BUILDX_BUILDER_NAME.test(builder)) {
      throw new DeployError(
        "preflight",
        `${BUILDX_BUILDER_INPUT} must be a 1..128 character Docker builder name`,
      );
    }
    // Wrangler invokes `docker build`; Docker's own buildx selector chooses an
    // already configured builder without granting the child an executable
    // path, Docker host, context, or arbitrary ambient Docker variables.
    environment.BUILDX_BUILDER = builder;
  }
  return environment;
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
    env: sanitizedChildEnvironment(options.env),
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
