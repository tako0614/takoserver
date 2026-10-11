import type { Sql } from "./ports.ts";

/**
 * Set to `1` to print a fresh operator sign-in assertion on every boot, `0` (or
 * unset) to print one only until the operator has signed in.
 */
export const SELFHOST_OPERATOR_ASSERTION_PRINT_VARIABLE = "TAKOSERVER_PRINT_OPERATOR_ASSERTION";

/** The account a self-host's printed first-boot assertion signs in as. */
export const SELFHOST_OPERATOR_SIGN_IN_IDENTITY = Object.freeze({
  provider: "google",
  subject: "operator",
  email: "operator@localhost",
  displayName: "Operator",
} as const);

export function parseSelfhostOperatorAssertionPrint(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new TypeError(
    `${SELFHOST_OPERATOR_ASSERTION_PRINT_VARIABLE} must be 1 or 0; it is ${JSON.stringify(value)}`,
  );
}

/**
 * Whether this boot should mint and print an operator sign-in assertion.
 *
 * The printed assertion is a credential written to wherever stdout goes:
 * journald, container logs, a terminal's scrollback. It is the first-run way
 * in, so it is printed until the operator account exists, which happens on the
 * first session exchange. After that a boot prints only how to mint one, and
 * an operator who wants the old behaviour sets the override explicitly.
 */
export async function selfhostOperatorAssertionDue(input: {
  readonly sql: Pick<Sql, "query">;
  readonly forced: boolean;
}): Promise<boolean> {
  if (input.forced) return true;
  const rows = await input.sql.query(
    "SELECT 1 AS present FROM principals WHERE provider = ? AND provider_subject = ? LIMIT 1",
    [SELFHOST_OPERATOR_SIGN_IN_IDENTITY.provider, SELFHOST_OPERATOR_SIGN_IN_IDENTITY.subject],
  );
  return rows.length === 0;
}

export interface SelfhostOperatorSignInInstructions {
  readonly publicOrigin: string;
  readonly consoleOrigin?: string | undefined;
  /** Absent once the operator has signed in: the boot then prints no credential. */
  readonly assertion?: string | undefined;
  readonly operatorKeyPath: string;
}

/** Render the operator sign-in handoff without implying the Host serves a console. */
export function renderSelfhostOperatorSignInInstructions(
  options: SelfhostOperatorSignInInstructions,
): string {
  const identity = SELFHOST_OPERATOR_SIGN_IN_IDENTITY;
  const later =
    `bun scripts/operator-key.ts sign-in ${identity.provider} ${identity.subject} ` +
    `${identity.email} ${identity.displayName}\n` +
    `  (with TAKOSERVER_OPERATOR_KEY=${options.operatorKeyPath} ` +
    `and TAKOSERVER_PUBLIC_ORIGIN=${options.publicOrigin})`;
  const intro = `\nno identity provider is configured, so this deployment signs you in as its operator.\n`;

  if (options.assertion === undefined) {
    return (
      intro +
      `The operator has already signed in, so this boot prints no sign-in assertion.\n` +
      `mint one: ${later}\n` +
      `or restart with ${SELFHOST_OPERATOR_ASSERTION_PRINT_VARIABLE}=1 to print one at startup.`
    );
  }

  const singleUse =
    `It opens one session and is refused if presented again. ` +
    `Until the operator first signs in, each boot prints a new one.`;
  const destination = options.consoleOrigin
    ? `open ${options.consoleOrigin} and paste this (valid 10 minutes):\n\n${options.assertion}\n\n${singleUse}`
    : `This Host serves its landing page and API, not a console.\n` +
      `Host: ${options.publicOrigin}/\n` +
      `API documentation: ${options.publicOrigin}/openapi.json\n` +
      `For manual onboarding, send POST ${options.publicOrigin}/v1/sessions ` +
      `with provider=google and method=operator-assertion. Use its sessionToken with /v1/me, ` +
      `/v1/organizations, and /v1/organizations/{organizationId}/api-keys.\n` +
      `For publisher admission, follow docs/self-host-operations.md.\n\n` +
      `Operator sign-in assertion (valid 10 minutes):\n\n${options.assertion}\n\n${singleUse}`;

  return `${intro}${destination}\n\nlater ones: ${later}`;
}
