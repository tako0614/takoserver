export interface SelfhostOperatorSignInInstructions {
  readonly publicOrigin: string;
  readonly consoleOrigin?: string | undefined;
  readonly assertion: string;
  readonly operatorKeyPath: string;
}

/** Render the operator sign-in handoff without implying the Host serves a console. */
export function renderSelfhostOperatorSignInInstructions(
  options: SelfhostOperatorSignInInstructions,
): string {
  const destination = options.consoleOrigin
    ? `open ${options.consoleOrigin} and paste this (valid 10 minutes):\n\n${options.assertion}`
    : `This Host serves its landing page and API, not a console.\n` +
      `Host: ${options.publicOrigin}/\n` +
      `API documentation: ${options.publicOrigin}/openapi.json\n` +
      `For manual onboarding, send POST ${options.publicOrigin}/v1/sessions ` +
      `with provider=google and method=operator-assertion. Use its sessionToken with /v1/me, ` +
      `/v1/organizations, and /v1/organizations/{organizationId}/api-keys.\n` +
      `To seed held artifacts and create v2 Resources, follow "First install and first use" ` +
      `in docs/self-host-operations.md; no publisher admission is needed.\n\n` +
      `Operator sign-in assertion (valid 10 minutes):\n\n${options.assertion}`;

  return (
    `\nno identity provider is configured, so this deployment signs you in as its operator.\n` +
    `${destination}\n\n` +
    `later ones: bun scripts/operator-key.ts sign-in google operator operator@localhost Operator\n` +
    `  (with TAKOSERVER_OPERATOR_KEY=${options.operatorKeyPath})`
  );
}
