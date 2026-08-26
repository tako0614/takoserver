import { preflightError } from "./errors.ts";
import { type CommandResult, runCommand, wranglerCommand } from "./process.ts";

type CommandRunner = (command: readonly string[]) => Promise<CommandResult>;

export interface CloudflareRouteTokenOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: CommandRunner;
}

/**
 * Resolves the bearer needed for read-only Worker route inventory.
 *
 * Wrangler owns its OAuth credential store. This module only asks Wrangler for
 * the active credential, holds the returned value in memory, and never puts it
 * in argv, a file, or a diagnostic.
 */
export async function resolveCloudflareRouteToken(
  options: CloudflareRouteTokenOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const configured = env.CLOUDFLARE_API_TOKEN?.trim();
  if (configured) return configured;

  const result = await (options.run ?? runCommand)(wranglerCommand(["auth", "token", "--json"]));
  if (result.exitCode !== 0) {
    throw preflightError(
      "Wrangler authentication is required for web route authority",
      "Authenticate the active Wrangler profile and retry; no separate site token is required.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw preflightError("Wrangler returned invalid authentication metadata");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== "string" ||
    (parsed as { type: string }).type.trim() === "" ||
    typeof (parsed as { token?: unknown }).token !== "string" ||
    !nonEmptyBearer((parsed as { token: string }).token)
  ) {
    throw preflightError("Wrangler returned invalid authentication metadata");
  }
  return (parsed as { token: string }).token.trim();
}

function nonEmptyBearer(value: string): boolean {
  const token = value.trim();
  return token.length >= 16 && token.length <= 8192 && !/\s/u.test(token);
}
