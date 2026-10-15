/** Name policy for the operator-selected shared app dispatcher. */
export const SHARED_APP_STAGING_SUFFIX = "app-staging.takos.jp" as const;

const RESERVED_NAMES = new Set([
  "www",
  "api",
  "app",
  "apps",
  "admin",
  "root",
  "auth",
  "login",
  "oauth",
  "sso",
  "account",
  "accounts",
  "billing",
  "pay",
  "status",
  "docs",
  "help",
  "support",
  "mail",
  "smtp",
  "imap",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "cdn",
  "static",
  "assets",
  "staging",
  "stage",
  "dev",
  "test",
  "prod",
  "internal",
  "control",
  "dashboard",
  "console",
  "takos",
  "takosumi",
  "takoserver",
  "yurucommu",
  "deckide",
  "security",
  "abuse",
  "postmaster",
  "hostmaster",
  "webmaster",
  "null",
  "undefined",
]);

/** Canonical allocation input; never trim, strip dots, truncate or convert IDNs. */
export function normalizeSharedAppName(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) {
    throw new TypeError("shared app name is invalid");
  }
  const name = value.normalize("NFKC").toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u.test(name) ||
    name.includes("--") ||
    name.startsWith("xn--") ||
    name.endsWith("-staging") ||
    RESERVED_NAMES.has(name)
  ) {
    throw new TypeError("shared app name is invalid");
  }
  return name;
}

/** Exact staging projection, suitable for comparing a provider's public origin. */
export function sharedAppStagingOrigin(name: unknown): string {
  return `https://${normalizeSharedAppName(name)}.${SHARED_APP_STAGING_SUFFIX}`;
}

/**
 * Parse the raw Host authority before URL/IDNA processing. A single DNS root dot
 * and ASCII case aliases are accepted; ports and every non-ASCII byte refuse.
 * Null deliberately combines malformed, reserved and outside-suffix inputs.
 * Allocation status and permanent released-name tombstones still require
 * the authoritative ledger read.
 */
export function sharedAppStagingNameFromHost(host: unknown): string | null {
  if (typeof host !== "string" || !/^[A-Za-z0-9.-]+$/u.test(host)) return null;
  const hostname = (host.endsWith(".") ? host.slice(0, -1) : host).toLowerCase();
  const suffix = `.${SHARED_APP_STAGING_SUFFIX}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  try {
    return normalizeSharedAppName(label);
  } catch {
    return null;
  }
}
