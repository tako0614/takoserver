import { type Api, createApi, type Organization, type Principal } from "./api.ts";
import { signal } from "./reactive.ts";

/**
 * What the console remembers between page loads.
 *
 * Session authority is an HttpOnly cookie owned by the API origin. JavaScript
 * stores only a non-authoritative UI marker so a reload can choose the signed-
 * in shell; `/v1/me` clears a stale marker when the cookie has expired.
 */

const SESSION_KEY = "takoserver.session";
const ORG_KEY = "takoserver.organization";
const THEME_KEY = "takoserver.theme";
const ORIGIN_KEY = "takoserver.origin";

export type Theme = "system" | "light" | "dark";

export const session = signal<string | null>(localStorage.getItem(SESSION_KEY));
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

export function setApiOrigin(origin: string): void {
  const trimmed = origin.replace(/\/+$/u, "");
  localStorage.setItem(ORIGIN_KEY, trimmed);
  apiOrigin.set(trimmed);
}

function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  session.set(null);
  principal.set(null);
  organizations.set([]);
}

export function signOut(): void {
  void api.signOut().finally(clearSession);
}

export function adoptSession(): void {
  localStorage.setItem(SESSION_KEY, "cookie");
  session.set("cookie");
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
