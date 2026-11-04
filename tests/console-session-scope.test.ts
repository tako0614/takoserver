import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
const globals = ["localStorage", "sessionStorage", "document", "window"] as const;
const descriptors = globals.map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
const values = new Map<string, string>();
const location = new URL("https://console.example.test/");
const updatePath = (_state: unknown, _title: string, path: string) => {
  location.href = new URL(path, location.origin).href;
};
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  },
  sessionStorage: {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  },
  document: {
    documentElement: { dataset: { apiOrigin: "https://a.example.test" } },
    getElementById: () => null,
  },
  window: {
    location,
    addEventListener: () => undefined,
    scrollTo: () => undefined,
    history: { replaceState: updatePath, pushState: updatePath },
  },
});
const state = await import("../console/src/state.ts");
let stopObserver: (() => void) | undefined;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function identity(id: string) {
  return {
    principal: { id, provider: "local", email: `${id}@example.test`, displayName: id },
    organizations: [
      { id: `org-${id}`, name: id, ownerPrincipalId: id, createdAt: "2026-11-04T00:00:00Z" },
    ],
  };
}

function transport(reply: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return reply(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
}

function adopt(id: string): void {
  state.adoptSession("shared-auth");
  const me = identity(id);
  state.principal.set(me.principal);
  state.organizations.set(me.organizations);
  state.selectOrganization(`org-${id}`);
}

beforeEach(() => {
  values.clear();
  location.href = "https://console.example.test/";
  state.setApiOrigin("https://a.example.test");
  state.session.set(null);
  state.sessionKind.set(null);
  state.principal.set(null);
  state.organizations.set([]);
  state.currentOrganizationId.set(null);
  state.sharedAuthAvailable.set(null);
});
afterEach(() => {
  stopObserver?.();
  stopObserver = undefined;
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("switching API origin drops identity and selected Org without carrying a cookie marker", () => {
  adopt("old");
  state.setApiOrigin("https://b.example.test/");
  expect(state.apiOrigin()).toBe("https://b.example.test");
  expect(state.session()).toBe(null);
  expect(state.sessionKind()).toBe(null);
  expect(state.principal()).toBe(null);
  expect(state.organizations()).toEqual([]);
  expect(state.currentOrganizationId()).toBe(null);
  expect(values.has("takoserver.session")).toBe(false);
  expect(values.has("takoserver.organization")).toBe(false);
});

test("saving the same normalized API origin preserves the current identity", () => {
  adopt("current");
  state.setApiOrigin("https://a.example.test///");
  expect(state.session()).toBe("cookie");
  expect(state.principal()?.id).toBe("current");
  expect(state.currentOrganizationId()).toBe("org-current");
});

test("an old oracle cannot bootstrap /me on the newly selected API origin", async () => {
  const oracle = deferred<Response>();
  const seen = transport((request) =>
    new URL(request.url).pathname === "/auth/oidc/session"
      ? oracle.promise
      : Response.json(identity("old")),
  );
  const bootstrap = state.bootstrapSharedSession();
  state.setApiOrigin("https://b.example.test");
  oracle.resolve(Response.json({ authenticated: true }));
  expect(await bootstrap).toBe(false);
  expect(seen.map((request) => request.url)).toEqual(["https://a.example.test/auth/oidc/session"]);
  expect(state.session()).toBe(null);
  expect(state.sharedAuthAvailable()).toBe(null);
});

test("old bootstrap identity cannot overwrite a newer same-origin cookie session", async () => {
  const me = deferred<Response>();
  const dispatched = deferred<void>();
  transport((request) => {
    if (new URL(request.url).pathname === "/auth/oidc/session")
      return Response.json({ authenticated: true });
    dispatched.resolve();
    return me.promise;
  });
  const bootstrap = state.bootstrapSharedSession();
  await dispatched.promise;
  adopt("new");
  me.resolve(Response.json(identity("old")));
  expect(await bootstrap).toBe(false);
  expect(state.principal()?.id).toBe("new");
  expect(state.currentOrganization()?.id).toBe("org-new");
});

for (const switchOrigin of [false, true]) {
  test(`an old 401 preserves a newer cookie session (origin switch: ${switchOrigin})`, async () => {
    adopt("old");
    const response = deferred<Response>();
    transport(() => response.promise);
    const request = state.api.me().catch((error: unknown) => error);
    if (switchOrigin) state.setApiOrigin("https://b.example.test");
    adopt("new");
    response.resolve(Response.json({ error: { code: "unauthenticated" } }, { status: 401 }));
    expect(await request).toMatchObject({ status: 401 });
    expect(state.session()).toBe("cookie");
    expect(state.principal()?.id).toBe("new");
    expect(state.currentOrganization()?.id).toBe("org-new");
  });
}

test("a current 401 still invalidates the current identity", async () => {
  adopt("current");
  transport(() => Response.json({ error: { code: "unauthenticated" } }, { status: 401 }));
  await expect(state.api.me()).rejects.toMatchObject({ status: 401 });
  expect(state.session()).toBe(null);
  expect(state.principal()).toBe(null);
});

for (const kind of ["legacy", "shared-auth"] as const) {
  for (const status of [204, 503]) {
    test(`an old ${kind} logout (${status}) agrees with same-host cookie expiry`, async () => {
      state.adoptSession(kind);
      const response = deferred<Response>();
      const seen = transport((request) =>
        new URL(request.url).pathname === "/auth/oidc/session"
          ? Response.json({ authenticated: false }, { status: 401 })
          : response.promise,
      );
      const logout = state.signOut().catch((error: unknown) => error);
      adopt("new");
      response.resolve(
        status === 204
          ? new Response(null, { status })
          : Response.json({ error: { code: "session_unavailable" } }, { status }),
      );
      const result = await logout;
      if (status === 503) expect(result).toMatchObject({ status });
      expect(state.session()).toBe(status === 204 ? null : "cookie");
      expect(state.principal()?.id).toBe(status === 204 ? undefined : "new");
      expect(state.currentOrganization()?.id).toBe(status === 204 ? undefined : "org-new");
      expect(seen).toHaveLength(status === 204 ? 2 : 1);
    });
  }
}

test("a successful old logout on a different cookie host does not clear the selected host", async () => {
  adopt("old");
  const response = deferred<Response>();
  const seen = transport(() => response.promise);
  const logout = state.signOut();
  state.setApiOrigin("https://b.example.test");
  adopt("new");
  response.resolve(new Response(null, { status: 204 }));
  await logout;
  expect(state.principal()?.id).toBe("new");
  expect(seen).toHaveLength(1);
});

test("a successful old logout still expires the same cookie host after a port change", async () => {
  adopt("old");
  const response = deferred<Response>();
  transport((request) =>
    new URL(request.url).pathname === "/auth/oidc/session"
      ? Response.json({ authenticated: false }, { status: 401 })
      : response.promise,
  );
  const logout = state.signOut();
  state.setApiOrigin("https://a.example.test:9443");
  adopt("new");
  response.resolve(new Response(null, { status: 204 }));
  await logout;
  expect(state.session()).toBe(null);
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const oldStatus of [200, 401, 503]) {
  test(`the mounted identity observer ignores an old ${oldStatus} after same-marker readoption`, async () => {
    adopt("old");
    const pending: ReturnType<typeof deferred<Response>>[] = [];
    const seen = transport(() => {
      const next = deferred<Response>();
      pending.push(next);
      return next.promise;
    });
    const errors: unknown[] = [];
    stopObserver = state.observeSessionIdentity((error) => errors.push(error));
    expect(pending).toHaveLength(1);
    adopt("new");
    await flush();
    expect(pending).toHaveLength(2);
    expect(state.principal()?.id).toBe("new");
    pending[1]?.resolve(Response.json(identity("new")));
    await flush();
    pending[0]?.resolve(
      oldStatus === 200
        ? Response.json(identity("old"))
        : Response.json(
            { error: { code: oldStatus === 401 ? "unauthenticated" : "unavailable" } },
            { status: oldStatus },
          ),
    );
    await flush();
    expect(state.principal()?.id).toBe("new");
    expect(state.currentOrganization()?.id).toBe("org-new");
    expect(state.session()).toBe("cookie");
    expect(errors).toEqual([]);
    expect(seen.every((request) => request.url === "https://a.example.test/v1/me")).toBe(true);
  });
}

test("the identity observer does not retain an old endpoint response across an A-B-A switch", async () => {
  adopt("old");
  const pending: ReturnType<typeof deferred<Response>>[] = [];
  transport(() => {
    const next = deferred<Response>();
    pending.push(next);
    return next.promise;
  });
  stopObserver = state.observeSessionIdentity(() => {
    throw new Error("unexpected identity error");
  });
  state.setApiOrigin("https://b.example.test");
  state.setApiOrigin("https://a.example.test");
  adopt("new");
  await flush();
  expect(pending).toHaveLength(2);
  pending[1]?.resolve(Response.json(identity("new")));
  await flush();
  pending[0]?.resolve(Response.json(identity("old")));
  await flush();
  expect(state.principal()?.id).toBe("new");
});

test("the identity observer still reports a current failure and can be disposed with a request pending", async () => {
  adopt("current");
  const pending: ReturnType<typeof deferred<Response>>[] = [];
  transport(() => {
    const next = deferred<Response>();
    pending.push(next);
    return next.promise;
  });
  const errors: unknown[] = [];
  stopObserver = state.observeSessionIdentity((error) => errors.push(error));
  pending[0]?.resolve(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
  await flush();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ status: 503 });
  adopt("new");
  await flush();
  expect(pending).toHaveLength(2);
  stopObserver();
  pending[1]?.resolve(Response.json(identity("retired")));
  await flush();
  expect(state.principal()?.id).toBe("new");
});

for (const provider of ["google", "takos-id"] as const) {
  for (const change of ["none", "other-host", "same-host-port"] as const) {
    test(`${provider} actual callback finishes only in its request scope (${change})`, async () => {
      const main = await import("../console/src/main.ts");
      if (provider === "takos-id") {
        location.href = "https://console.example.test/auth/takos-id?state=synthetic&code=one";
        values.set(
          "takoserver.takos-id.pending",
          JSON.stringify({
            issuer: "https://issuer.example.test",
            clientId: "synthetic-client",
            state: "synthetic",
            verifier: "synthetic-verifier",
            from: "/resources",
          }),
        );
      }
      const response = deferred<Response>();
      const dispatched = deferred<void>();
      const seen = transport((request) => {
        if (request.url === "https://issuer.example.test/oauth/token")
          return Response.json({ id_token: "synthetic-id-token" });
        if (request.url !== "https://a.example.test/v1/sessions")
          throw new Error(`unexpected synthetic callback route: ${request.url}`);
        dispatched.resolve();
        return response.promise;
      });
      let ready = false;
      const callback = main.resolveInitialSession(
        provider === "google"
          ? {
              kind: "ok",
              value: {
                idToken: "synthetic-id-token",
                nonce: "synthetic-nonce",
                from: "/resources",
              },
            }
          : { kind: "none" },
        {
          set: (value) => {
            ready = value;
          },
        },
      );
      await dispatched.promise;
      if (change === "other-host") state.setApiOrigin("https://b.example.test");
      if (change === "same-host-port") state.setApiOrigin("https://a.example.test:9443");
      if (change !== "none") adopt("new");
      response.resolve(Response.json(identity("old")));
      await callback;
      expect(ready).toBe(true);
      expect(state.session()).toBe(change === "same-host-port" ? null : "cookie");
      expect(state.principal()?.id).toBe(change === "other-host" ? "new" : undefined);
      expect(location.pathname).toBe(change === "none" ? "/resources" : "/");
      expect(
        seen.filter((request) => new URL(request.url).pathname === "/v1/sessions"),
      ).toHaveLength(1);
    });
  }
}

for (const provider of ["google", "takos-id"] as const) {
  test(`${provider} callback never sends old credentials to an endpoint selected during return processing`, async () => {
    const main = await import("../console/src/main.ts");
    const token = deferred<Response>();
    if (provider === "takos-id") {
      location.href = "https://console.example.test/auth/takos-id?state=synthetic&code=one";
      values.set(
        "takoserver.takos-id.pending",
        JSON.stringify({
          issuer: "https://issuer.example.test",
          clientId: "synthetic-client",
          state: "synthetic",
          verifier: "synthetic-verifier",
          from: "/resources",
        }),
      );
    }
    const seen = transport((request) =>
      request.url === "https://issuer.example.test/oauth/token"
        ? token.promise
        : Response.json(identity("old")),
    );
    const callback = main.resolveInitialSession(
      provider === "google"
        ? {
            kind: "ok",
            value: { idToken: "synthetic-id-token", nonce: "synthetic-nonce", from: "/resources" },
          }
        : { kind: "none" },
      { set: () => undefined },
    );
    state.setApiOrigin("https://b.example.test");
    token.resolve(Response.json({ id_token: "synthetic-id-token" }));
    await callback;
    expect(seen.map((request) => request.url)).toEqual(
      provider === "google" ? [] : ["https://issuer.example.test/oauth/token"],
    );
    expect(state.session()).toBe(null);
  });
}
