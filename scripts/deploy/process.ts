import { resolve } from "node:path";
import { DeployError, type DeployPhase } from "./errors.ts";

export const REPOSITORY = resolve(import.meta.dir, "..", "..");
export const WRANGLER = resolve(REPOSITORY, "node_modules/.bin/wrangler");

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CloudflareDeployEnvironment = "integration" | "rehearsal" | "production";

export type DeployProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

/**
 * The credential used by a Cloudflare deploy invocation.
 *
 * `token` is intentionally kept separate from `childEnvironment`: direct REST
 * readers need the bearer, while Wrangler must either receive an explicit API
 * token or use its stored OAuth profile without a token in its environment.
 */
export interface CloudflareCredential {
  readonly token: string;
  readonly childEnvironment: Readonly<Record<string, string>>;
  readonly source: "api-token" | "oauth";
}

/** Wrangler behavior allowed alongside the credential boundary. */
const WRANGLER_OAUTH_CHILD_ENVIRONMENT = Object.freeze({
  WRANGLER_WRITE_LOGS: "false",
});

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

/** The explicit API token forwarded to a Wrangler child when one is supplied. */
export function cloudflareChildEnvironment(): Readonly<Record<string, string>> {
  return { CLOUDFLARE_API_TOKEN: requireEnvironment("CLOUDFLARE_API_TOKEN") };
}

/**
 * Parse the only OAuth credential shape accepted from Wrangler.
 *
 * The raw output is deliberately never included in an error: the command's
 * stdout may contain the bearer itself, and malformed output is still a
 * credential-handling failure rather than useful deploy diagnostics.
 */
export function parseWranglerAuthToken(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new DeployError("preflight", "Wrangler OAuth token response is malformed");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    (value as Record<string, unknown>).type !== "oauth" ||
    typeof (value as Record<string, unknown>).token !== "string"
  ) {
    throw new DeployError("preflight", "Wrangler OAuth token response is malformed");
  }
  const token = (value as Record<string, unknown>).token as string;
  if (!isExactCredentialToken(token)) {
    throw new DeployError("preflight", "Wrangler OAuth token response is malformed");
  }
  return token;
}

/**
 * Resolve one Cloudflare credential for a deploy surface.
 *
 * An explicit `CLOUDFLARE_API_TOKEN` always wins (and malformed explicit
 * input is rejected rather than falling through to OAuth). Only integration
 * may ask Wrangler for its stored OAuth token; rehearsal and production stay
 * explicit-token-only. The OAuth bearer is returned for in-process REST
 * requests but is never placed in a child environment.
 */
export async function resolveCloudflareCredential(
  deploymentEnvironment: CloudflareDeployEnvironment,
  options: {
    readonly cloudflareEnvironment?: Readonly<Record<string, string>> | undefined;
    readonly run?: DeployProcess;
  } = {},
): Promise<CloudflareCredential> {
  const explicitToken =
    options.cloudflareEnvironment === undefined
      ? process.env.CLOUDFLARE_API_TOKEN
      : options.cloudflareEnvironment.CLOUDFLARE_API_TOKEN;
  if (explicitToken !== undefined) {
    if (!isExactCredentialToken(explicitToken)) {
      throw new DeployError(
        "preflight",
        "CLOUDFLARE_API_TOKEN is required and must not have outer whitespace",
      );
    }
    return {
      token: explicitToken,
      childEnvironment: { CLOUDFLARE_API_TOKEN: explicitToken },
      source: "api-token",
    };
  }
  if (deploymentEnvironment !== "integration") {
    throw new DeployError(
      "preflight",
      "CLOUDFLARE_API_TOKEN is required for rehearsal and production",
    );
  }
  const run = options.run ?? runCommand;
  let result: CommandResult;
  try {
    // Keep Wrangler's debug logger off: auth --json intentionally writes the
    // returned bearer to stdout, and Wrangler's default 0644 debug log would
    // otherwise persist that bearer on disk. The OAuth token must remain inside
    // Wrangler's stored profile rather than entering this child environment.
    result = await run(wranglerCommand(["auth", "token", "--json"]), {
      env: { ...WRANGLER_OAUTH_CHILD_ENVIRONMENT },
    });
  } catch {
    throw new DeployError("preflight", "Wrangler OAuth token could not be read");
  }
  if (result.exitCode !== 0) {
    throw new DeployError("preflight", "Wrangler OAuth token command failed");
  }
  const token = parseWranglerAuthToken(result.stdout);
  return {
    token,
    childEnvironment: { ...WRANGLER_OAUTH_CHILD_ENVIRONMENT },
    source: "oauth",
  };
}

function isExactCredentialToken(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
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
