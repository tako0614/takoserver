import { afterEach, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
const values = new Map<string, string>();

function installConsoleGlobals() {
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  };
  const location = {
    protocol: "https:",
    hostname: "console.example.test",
    port: "",
    origin: "https://console.example.test",
    pathname: "/",
    search: "",
    hash: "",
    href: "https://console.example.test/",
  };
  Object.assign(globalThis, {
    localStorage: storage,
    sessionStorage: storage,
    document: {
      documentElement: { dataset: {} as Record<string, string> },
      getElementById: (): null => null,
    },
    window: {
      addEventListener: (): void => undefined,
      scrollTo: (): void => undefined,
      history: {
        replaceState: (_state: unknown, _title: string, path: string): void => {
          const url = new URL(path, location.origin);
          location.pathname = url.pathname;
          location.search = url.search;
          location.hash = url.hash;
          location.href = url.toString();
        },
      },
      location,
    },
  });
  return storage;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("failed legacy sign-out clears its local marker while preserving the server error", async () => {
  installConsoleGlobals();
  values.clear();
  const state = await import("../console/src/state.ts");
  state.session.set(null);
  state.sessionKind.set(null);
  state.adoptSession("legacy");
  state.principal.set({
    id: "legacy-principal",
    provider: "local",
    email: "owner@example.test",
    displayName: "Owner",
  });
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({ error: { code: "session_unavailable" } }, { status: 503 });
    },
    { preconnect: originalFetch.preconnect },
  );

  await expect(state.signOut()).rejects.toMatchObject({ status: 503 });
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["DELETE", "/v1/session"],
  ]);
  expect(values.has("takoserver.session")).toBe(false);
  expect(values.has("takoserver.session-kind")).toBe(false);
  expect(state.session()).toBe(null);
  expect(state.sessionKind()).toBe(null);
  expect(state.principal()).toBe(null);
});

test("shared-auth bootstrap adopts only after the oracle and /v1/me succeed", async () => {
  installConsoleGlobals();
  const state = await import("../console/src/state.ts");
  const reset = (): void => {
    values.clear();
    state.session.set(null);
    state.principal.set(null);
    state.organizations.set([]);
  };
  reset();

  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request.clone());
      return new URL(request.url).pathname === "/auth/oidc/session"
        ? Response.json({ authenticated: true })
        : Response.json({
            principal: {
              id: "host-principal",
              provider: "local",
              email: "owner@example.test",
              displayName: "Owner",
            },
            organizations: [
              {
                id: "org-one",
                name: "One",
                ownerPrincipalId: "another-principal",
                createdAt: "2026-10-20T00:00:00.000Z",
              },
            ],
          });
    },
    { preconnect: originalFetch.preconnect },
  );
  expect(await state.bootstrapSharedSession()).toBe(true);
  expect(values.get("takoserver.session")).toBe("cookie");
  expect(values.get("takoserver.session-kind")).toBe("shared-auth");
  expect(state.sharedAuthAvailable()).toBe(true);
  expect(state.principal()?.id).toBe("host-principal");
  expect(state.organizations().map((organization) => organization.ownerPrincipalId)).toEqual([
    "another-principal",
  ]);
  expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
    "/auth/oidc/session",
    "/v1/me",
  ]);
  expect(seen.every((request) => request.credentials === "include")).toBe(true);
  expect(seen[0]?.headers.has("authorization")).toBe(false);

  reset();
  globalThis.fetch = Object.assign(
    async () => Response.json({ authenticated: false }, { status: 401 }),
    { preconnect: originalFetch.preconnect },
  );
  expect(await state.bootstrapSharedSession()).toBe(false);
  expect(values.has("takoserver.session")).toBe(false);
  expect(state.sharedAuthAvailable()).toBe(true);

  reset();
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: { code: "not_found" } }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
  expect(await state.bootstrapSharedSession()).toBe(false);
  expect(state.sharedAuthAvailable()).toBe(false);
  expect(values.has("takoserver.session")).toBe(false);

  for (const [status, code] of [
    [400, "session_invalid"],
    [503, "session_unavailable"],
  ] as const) {
    reset();
    globalThis.fetch = Object.assign(async () => Response.json({ error: { code } }, { status }), {
      preconnect: originalFetch.preconnect,
    });
    await expect(state.bootstrapSharedSession()).rejects.toMatchObject({ code, status });
    expect(values.has("takoserver.session")).toBe(false);
  }

  reset();
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ authenticated: true })
        : Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
    },
    { preconnect: originalFetch.preconnect },
  );
  await expect(state.bootstrapSharedSession()).rejects.toMatchObject({ status: 401 });
  expect(values.has("takoserver.session")).toBe(false);

  reset();
  calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ authenticated: true })
        : Response.json({ principal: { id: "principal-only" }, organizations: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
  await expect(state.bootstrapSharedSession()).rejects.toMatchObject({ code: "invalid_response" });
  expect(values.has("takoserver.session")).toBe(false);

  reset();
  state.adoptSession("shared-auth");
  const logoutRequests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      logoutRequests.push(request);
      return new URL(request.url).pathname === "/auth/oidc/logout"
        ? new Response(null, { status: 204 })
        : Response.json({ authenticated: false }, { status: 401 });
    },
    { preconnect: originalFetch.preconnect },
  );
  await state.signOut();
  expect(new URL(logoutRequests[0]?.url ?? "https://api.example.test").pathname).toBe(
    "/auth/oidc/logout",
  );
  expect(logoutRequests[0]?.method).toBe("POST");
  expect(new URL(logoutRequests[1]?.url ?? "https://api.example.test").pathname).toBe(
    "/auth/oidc/session",
  );
  expect(state.sharedAuthAvailable()).toBe(true);
  expect(values.has("takoserver.session")).toBe(false);

  reset();
  state.adoptSession("shared-auth");
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: { code: "session_unavailable" } }, { status: 503 }),
    { preconnect: originalFetch.preconnect },
  );
  await expect(state.signOut()).rejects.toMatchObject({ status: 503 });
  expect(values.get("takoserver.session")).toBe("cookie");
  expect(state.sessionKind()).toBe("shared-auth");

  reset();
  state.adoptSession();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request.clone());
      return new URL(request.url).pathname === "/v1/session"
        ? new Response(null, { status: 204 })
        : Response.json({ authenticated: false }, { status: 401 });
    },
    { preconnect: originalFetch.preconnect },
  );
  await state.signOut();
  expect(new URL(seen.at(-2)?.url ?? "https://api.example.test").pathname).toBe("/v1/session");
  expect(seen.at(-2)?.method).toBe("DELETE");
  expect(new URL(seen.at(-1)?.url ?? "https://api.example.test").pathname).toBe(
    "/auth/oidc/session",
  );

  reset();
  state.adoptSession("legacy");
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: { code: "unauthenticated" } }, { status: 401 }),
    { preconnect: originalFetch.preconnect },
  );
  await expect(state.signOut()).rejects.toMatchObject({ status: 401 });
  expect(values.has("takoserver.session")).toBe(false);
  expect(state.session()).toBe(null);
  expect(state.sessionKind()).toBe(null);

  values.set("takoserver.shared-session-return", "billing");
  expect(state.takeSharedSessionReturnPath()).toBe("/billing");
  expect(values.has("takoserver.shared-session-return")).toBe(false);
  values.set("takoserver.shared-session-return", "https://outside.example/");
  expect(state.takeSharedSessionReturnPath()).toBe("/");
  expect(values.has("takoserver.shared-session-return")).toBe(false);
});

test("Console callback startup suppresses shared probing and always releases its loading gate", async () => {
  const storage = installConsoleGlobals();
  values.clear();
  const state = await import("../console/src/state.ts");
  state.session.set(null);
  const main = await import("../console/src/main.ts");
  const location = (globalThis as { window: { location: Location } }).window.location;
  location.pathname = "/auth/takos-id";
  location.search = "?error=access_denied";
  location.hash = "";
  location.href = `${location.origin}${location.pathname}${location.search}`;

  let fetches = 0;
  globalThis.fetch = Object.assign(
    async () => {
      fetches += 1;
      return Response.json({ authenticated: false }, { status: 401 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const callbackReady = {
    value: false,
    set(value: boolean) {
      this.value = value;
    },
  };
  await main.resolveInitialSession({ kind: "none" }, callbackReady);
  expect(callbackReady.value).toBe(true);
  expect(fetches).toBe(0);
  expect(values.has("takoserver.session")).toBe(false);

  Object.assign(globalThis, {
    sessionStorage: {
      getItem: (): never => {
        throw new Error("broken pending state");
      },
      removeItem: (): void => undefined,
    },
  });
  location.pathname = "/auth/takos-id";
  location.search = "";
  location.href = `${location.origin}${location.pathname}`;
  const brokenCallbackReady = {
    value: false,
    set(value: boolean) {
      this.value = value;
    },
  };
  await main.resolveInitialSession({ kind: "none" }, brokenCallbackReady);
  expect(brokenCallbackReady.value).toBe(true);
  expect(fetches).toBe(0);
  expect(values.has("takoserver.session")).toBe(false);
  Object.assign(globalThis, { sessionStorage: storage });
});
