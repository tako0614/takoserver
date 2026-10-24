import {
  type Api,
  createApi,
  type HostDiscovery,
  type Organization,
  type Principal,
  type SharedAuthSessionStatus,
} from "./api.ts";
import { signal } from "./reactive.ts";

/**
 * What the console remembers between page loads.
 *
 * Session authority is an HttpOnly cookie owned by the API origin. JavaScript
 * stores only a non-authoritative UI marker so a reload can choose the signed-
 * in shell; `/v1/me` clears a stale marker when the cookie has expired.
 */

const SESSION_KEY = "takoserver.session";
const SESSION_KIND_KEY = "takoserver.session-kind";
const ORG_KEY = "takoserver.organization";
const THEME_KEY = "takoserver.theme";
const ORIGIN_KEY = "takoserver.origin";
const SHARED_SESSION_RETURN_KEY = "takoserver.shared-session-return";
const HOSTED_CONTINUATION_PATH = /^\/billing\/hosted-continuations\/([0-9a-f]{64})$/u;
const HOSTED_CONTINUATION_VALUE = /^hosted-continuation:([0-9a-f]{64})$/u;

export type Theme = "system" | "light" | "dark";
export type SessionKind = "shared-auth" | "legacy";

export const session = signal<string | null>(localStorage.getItem(SESSION_KEY));
export const sessionKind = signal<SessionKind | null>(
  session() === null
    ? null
    : localStorage.getItem(SESSION_KIND_KEY) === "shared-auth"
      ? "shared-auth"
      : "legacy",
);
export const sharedAuthAvailable = signal<boolean | null>(null);
let latestSharedAuthAvailabilityProbe = 0;
export const principal = signal<Principal | null>(null);
export const organizations = signal<readonly Organization[]>([]);
export const currentOrganizationId = signal<string | null>(localStorage.getItem(ORG_KEY));

/**
 * Where the API lives.
 *
 * The console is served as static files and may sit on its own hostname, so it
 * cannot assume its own origin serves the API. A build-time default covers the
 * deployed case; an override covers running it against a local server without
 * rebuilding, which is the difference between a console you can develop against
 * and one you cannot.
 */
export const apiOrigin = signal<string>(localStorage.getItem(ORIGIN_KEY) ?? defaultOrigin());

function defaultOrigin(): string {
  const declared = document.documentElement.dataset.apiOrigin;
  if (declared && declared !== "") return declared;
  // Served from the platform's own console host, the API is its sibling.
  const { protocol, hostname, port } = window.location;
  if (hostname.startsWith("console.") || hostname.split(".").length === 2) {
    return `${protocol}//api.${hostname.replace(/^console\./u, "")}${port ? `:${port}` : ""}`;
  }
  return window.location.origin;
}

/**
 * The Host API v2 base to show. The Host names it from its public origin, the
 * only authority v2 answers; the console's own API origin may be a tunnel or
 * an override, so it is used only when the Host named none.
 */
export function hostV2Base(discovery: HostDiscovery | null): string {
  return discovery?.takoform ?? `${apiOrigin()}/apis/forms.takoform.com/v2`;
}

export function setApiOrigin(origin: string): void {
  const trimmed = origin.replace(/\/+$/u, "");
  localStorage.setItem(ORIGIN_KEY, trimmed);
  latestSharedAuthAvailabilityProbe += 1;
  apiOrigin.set(trimmed);
}

/** Only the latest request for the selected API origin may update the sign-in choice. */
export async function refreshSharedAuthAvailability(clearImmediately = false): Promise<void> {
  const probe = ++latestSharedAuthAvailabilityProbe;
  const origin = apiOrigin();
  if (clearImmediately) sharedAuthAvailable.set(null);
  try {
    const available = (await api.sharedAuthSession()).available;
    if (probe === latestSharedAuthAvailabilityProbe && apiOrigin() === origin)
      sharedAuthAvailable.set(available);
  } catch {
    if (probe === latestSharedAuthAvailabilityProbe && apiOrigin() === origin)
      sharedAuthAvailable.set(null);
  }
}

function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KIND_KEY);
  session.set(null);
  sessionKind.set(null);
  principal.set(null);
  organizations.set([]);
}

export async function signOut(): Promise<void> {
  if (sessionKind() === "shared-auth") {
    await api.sharedAuthSignOut();
    clearSession();
  } else {
    try {
      await api.signOut();
    } finally {
      clearSession();
    }
  }
  await refreshSharedAuthAvailability();
}

export function adoptSession(kind: SessionKind = "legacy"): void {
  localStorage.setItem(SESSION_KEY, "cookie");
  localStorage.setItem(SESSION_KIND_KEY, kind);
  sessionKind.set(kind);
  session.set("cookie");
}

/**
 * Adopts the shared-auth browser session only after both the RP oracle and
 * this Host's own principal lookup succeed. The latter remains the source of
 * the Console identity and organizations.
 */
export async function bootstrapSharedSession(): Promise<boolean> {
  const status: SharedAuthSessionStatus = await api.sharedAuthSession();
  sharedAuthAvailable.set(status.available);
  if (!status.available || !status.authenticated) return false;
  const me = await api.me();
  principal.set(me.principal);
  organizations.set(me.organizations);
  adoptSession("shared-auth");
  return true;
}

/** Retain only closed, same-tab destinations across the fixed-root SSO callback. */
export function storeSharedSessionReturnPath(path: string): void {
  const hosted = HOSTED_CONTINUATION_PATH.exec(path);
  const value =
    path === "/billing"
      ? "billing"
      : hosted && hosted[0] === path
        ? `hosted-continuation:${hosted[1]}`
        : null;
  try {
    if (value === null) sessionStorage.removeItem(SHARED_SESSION_RETURN_KEY);
    else sessionStorage.setItem(SHARED_SESSION_RETURN_KEY, value);
  } catch {
    try {
      sessionStorage.removeItem(SHARED_SESSION_RETURN_KEY);
    } catch {
      // Storage denial safely drops the optional return destination.
    }
  }
}

/** Consume a closed same-tab selector, deriving paths only from fixed prefixes. */
export function takeSharedSessionReturnPath(): string {
  let value: string | null = null;
  try {
    value = sessionStorage.getItem(SHARED_SESSION_RETURN_KEY);
    sessionStorage.removeItem(SHARED_SESSION_RETURN_KEY);
  } catch {
    return "/";
  }
  if (value === "billing") return "/billing";
  const hosted = value === null ? null : HOSTED_CONTINUATION_VALUE.exec(value);
  return hosted && hosted[0] === value ? `/billing/hosted-continuations/${hosted[1]}` : "/";
}

/** Preserve a direct selector; only the fixed-root SSO callback may consume a saved return. */
export function resolveSharedSessionReturnPath(currentPath: string): string {
  const direct = HOSTED_CONTINUATION_PATH.exec(currentPath);
  const directPath = direct && direct[0] === currentPath ? currentPath : null;
  let value: string | null;
  try {
    value = sessionStorage.getItem(SHARED_SESSION_RETURN_KEY);
    sessionStorage.removeItem(SHARED_SESSION_RETURN_KEY);
  } catch {
    return directPath ?? "/";
  }
  if (directPath !== null) return directPath;
  if (currentPath !== "/") return "/";
  if (value === "billing") return "/billing";
  const hosted = value === null ? null : HOSTED_CONTINUATION_VALUE.exec(value);
  return hosted && hosted[0] === value ? `/billing/hosted-continuations/${hosted[1]}` : "/";
}

export function selectOrganization(id: string): void {
  localStorage.setItem(ORG_KEY, id);
  currentOrganizationId.set(id);
}

export const api: Api = createApi({
  get origin() {
    return apiOrigin();
  },
  token: () => null,
  onSessionLost: clearSession,
});

/** The organization every screen acts on, or null before one is chosen. */
export function currentOrganization(): Organization | null {
  const id = currentOrganizationId();
  const all = organizations();
  return all.find((organization) => organization.id === id) ?? all[0] ?? null;
}

/* ----------------------------------------------------------------- theme -- */

export const theme = signal<Theme>((localStorage.getItem(THEME_KEY) as Theme | null) ?? "system");

export function applyTheme(next: Theme): void {
  localStorage.setItem(THEME_KEY, next);
  theme.set(next);
  if (next === "system") {
    delete document.documentElement.dataset.theme;
    return;
  }
  document.documentElement.dataset.theme = next;
}

applyTheme(theme());
