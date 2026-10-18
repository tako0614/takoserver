import { expect, test } from "bun:test";
import type { SharedAuthVerifiedPrincipalInput } from "../src/shared-auth-session.ts";
import * as rp from "../src/shared-auth-session.ts";
import type {
  OidcAttempt,
  OidcSessionRecord,
  SharedAuthSessionStore,
} from "../src/shared-auth-session-store.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_ORGANIZATION,
  SESSION_TEST_PERSONAL,
} from "./helpers/shared-auth-session-issuer.ts";

const TIME = 1_800_000_000_000;
const PRINCIPAL = "retained-test-principal";
const COOKIE = "__Host-takoserver_shared_session";
function cookie(response: Response, name: string) {
  const selected = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  if (!selected || selected.startsWith(`${name}=;`)) throw new Error(`missing ${name}`);
  return selected.split(";")[0]!;
}

/** Protocol fixture only: signed synthetic issuer and explicit in-memory store, no Root authority. */
async function fixture(
  unavailableDescriptors?: "owner" | "store" | "property",
  freezeReceiver = false,
  inheritedStore = false,
) {
  let stamp = TIME;
  const issuer = await createSharedSessionTestIssuer(() => stamp);
  const attempts = new Map<string, OidcAttempt>();
  const sessions = new Map<string, OidcSessionRecord>();
  const inputs: {
    capture: SharedAuthVerifiedPrincipalInput;
    input: Parameters<rp.SharedAuthPrincipalProjection["resolve"]>[0];
  }[] = [];
  const calls = { create: 0, queue: 0, revoke: 0 };
  const control: {
    unknownCreate: boolean;
    readAlias: OidcSessionRecord | undefined;
    resolve: ((capture: SharedAuthVerifiedPrincipalInput) => void) | undefined;
  } = { unknownCreate: false, readAlias: undefined, resolve: undefined };
  const store: SharedAuthSessionStore = {
    async putAttempt(input) {
      attempts.set(input.digest, { ...input });
      return true;
    },
    async consumeAttempt(digest, now) {
      const input = attempts.get(digest);
      attempts.delete(digest);
      return input && now < input.expiresAt ? { ...input } : null;
    },
    async createSession(input) {
      calls.create++;
      if (sessions.has(input.digest)) return false;
      sessions.set(input.digest, { ...input });
      if (control.unknownCreate) throw new Error("unknown original create acknowledgement");
      return true;
    },
    async readSession(digest) {
      const row = sessions.get(digest);
      control.readAlias = row ? { ...row } : undefined;
      return control.readAlias ?? null;
    },
    async claimSession(digest, version, now) {
      const row = sessions.get(digest);
      if (!row || row.version !== version || row.status !== "active") return null;
      const next = { ...row, status: "checking" as const, version: version + 1, lastUsedAt: now };
      sessions.set(digest, next);
      return { ...next };
    },
    async completeSession(digest, version, update) {
      const row = sessions.get(digest);
      if (!row || row.version !== version || row.status !== "checking") return false;
      sessions.set(digest, { ...row, ...update, version: version + 1, status: "active" });
      return true;
    },
    async touchSessionAndSelect(digest, version, now) {
      const row = sessions.get(digest);
      if (!row || row.version !== version || row.status !== "active") throw new Error("touch miss");
      const next = { ...row, lastUsedAt: now, version: version + 1 };
      sessions.set(digest, next);
      return { ...next };
    },
    async touchSession(digest, version, now) {
      await store.touchSessionAndSelect(digest, version, now);
      return true;
    },
    async revokeSession(digest) {
      calls.revoke++;
      const row = sessions.get(digest);
      if (row) sessions.set(digest, { ...row, status: "revoked", version: row.version + 1 });
      return true;
    },
    async queueRevocation(input) {
      calls.queue++;
      const row = sessions.get(input.sessionDigest);
      if (row)
        sessions.set(row.digest, {
          ...row,
          status: "revocation_pending",
          version: row.version + 1,
        });
    },
    async listPendingRevocations() {
      return [];
    },
    async claimRevocation() {
      throw new Error("unexpected revocation claim");
    },
    async completeRevocation() {
      throw new Error("unexpected revocation complete");
    },
    async retryRevocation() {
      throw new Error("unexpected revocation retry");
    },
    async cleanupExpiredAttempts() {
      return 0;
    },
    async cleanupRevokedSessions() {
      return 0;
    },
  };
  const options: Parameters<typeof rp.createSharedAuthSession>[0] = {
    config: { ...SESSION_TEST_CONFIG },
    consoleOrigin: SESSION_TEST_CONSOLE,
    encryptionKey: new Uint8Array(32).fill(7),
    now: () => stamp,
    store: () =>
      unavailableDescriptors === "store"
        ? new Proxy(store, {
            ownKeys() {
              throw new Error("ordinary store descriptor enumeration unavailable");
            },
          })
        : inheritedStore
          ? Object.create(store)
          : store,
    finalStore: () => store,
    fetch: issuer.send,
    principals: {
      async resolve(input, capture) {
        inputs.push({ input, capture });
        control.resolve?.(capture);
        return { accountId: SESSION_TEST_ACCOUNT, principalId: PRINCIPAL };
      },
    },
  };
  const runtime = rp.createSharedAuthSession(
    unavailableDescriptors === "owner" || unavailableDescriptors === "property"
      ? new Proxy(options, {
          ownKeys(target) {
            if (unavailableDescriptors === "owner")
              throw new Error("ordinary owner descriptor enumeration unavailable");
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor() {
            throw new Error("ordinary owner property descriptor unavailable");
          },
        })
      : options,
  );
  if (freezeReceiver) Object.freeze(runtime);
  async function start(changeAuthorization?: (url: URL) => void) {
    const response = await runtime.fetch(
      new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/login`),
    );
    if (!response || response.status !== 303) throw new Error("login failed");
    const location = response.headers.get("location");
    if (!location) throw new Error("missing authorize URL");
    const authorization = new URL(location);
    changeAuthorization?.(authorization);
    return {
      browser: cookie(response, "__Host-takoserver_oidc_attempt"),
      callback: issuer.authorize(authorization),
    };
  }
  async function callback(started: Awaited<ReturnType<typeof start>>) {
    const response = await runtime.fetch(
      new Request(started.callback, { headers: { cookie: started.browser } }),
    );
    if (!response) throw new Error("callback unmounted");
    return response;
  }
  async function login() {
    const response = await callback(await start());
    expect(response.status).toBe(303);
    return { response, cookie: cookie(response, COOKIE) };
  }
  function request(value: string) {
    return new Request(`${SESSION_TEST_CONFIG.publicOrigin}/control/resource`, {
      headers: { cookie: value },
    });
  }
  return {
    runtime,
    options,
    issuer,
    sessions,
    inputs,
    store,
    calls,
    control,
    start,
    callback,
    login,
    request,
    time(value: number) {
      stamp = value;
    },
  };
}

// Namespace import makes the baseline RED an actual missing callback input assertion, not a missing named-export load error.
test("verified RP original input reaches the resolver only after signed callback checks", async () => {
  const f = await fixture();
  const started = await f.start();
  expect(f.inputs).toHaveLength(0);
  let beforeCreate = -1;
  let received: unknown;
  f.control.resolve = (capture) => {
    received = capture;
    if (capture === undefined) return;
    expect(capture).toBeDefined();
    beforeCreate = f.sessions.size;
    const data = rp.readSharedAuthVerifiedPrincipalInput(f.runtime, capture);
    expect(data).toEqual({
      phase: "fresh-callback",
      identity: {
        issuer: SESSION_TEST_CONFIG.issuer,
        clientId: SESSION_TEST_CONFIG.clientId,
        subject: SESSION_TEST_ACCOUNT,
        sessionId: f.issuer.sessionId,
        authTime: f.issuer.authTime,
        accountId: SESSION_TEST_ACCOUNT,
      },
      workspace: SESSION_TEST_PERSONAL,
    });
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data?.identity)).toBe(true);
    expect(Object.isFrozen(data?.workspace.roles)).toBe(true);
  };
  const response = await f.callback(started);
  expect(response.status).toBe(303);
  expect(received).toBeDefined();
  expect(beforeCreate).toBe(0);
  expect(f.calls.create).toBe(1);
  expect(f.inputs).toHaveLength(1);
  expect(cookie(response, COOKIE)).toStartWith(`${COOKIE}=`);
  const data = rp.readSharedAuthVerifiedPrincipalInput(f.runtime, f.inputs[0]!.capture);
  for (const issued of f.issuer.issued) {
    expect(JSON.stringify(data)).not.toContain(issued.accessToken);
    expect(JSON.stringify(data)).not.toContain(issued.refreshToken);
  }
  expect(Object.keys(data!).sort()).toEqual(["identity", "phase", "workspace"]);
});

test("unknown cloned inherited and other-factory captures cannot trigger caller getters", async () => {
  const f = await fixture();
  const other = await fixture();
  await f.login();
  const original = f.inputs[0]!.capture;
  let getters = 0;
  const unknown = {
    get identity() {
      getters++;
      throw new Error("caller getter");
    },
  };
  for (const capture of [null, {}, unknown, structuredClone(original), Object.create(original)])
    expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, capture)).toBeNull();
  expect(rp.readSharedAuthVerifiedPrincipalInput(other.runtime, original)).toBeNull();
  expect(rp.readSharedAuthVerifiedPrincipalInput({ ...f.runtime }, original)).toBeNull();
  expect(getters).toBe(0);
});

for (const boundary of ["state", "active", "account", "bootstrap", "owner", "member"] as const) {
  test(`failed ${boundary} check issues no verified Principal input or session`, async () => {
    const f = await fixture();
    const started = await f.start();
    if (boundary === "state") {
      const url = new URL(started.callback);
      url.searchParams.set("state", "wrong");
      started.callback = url.href;
    }
    if (boundary === "active") f.issuer.control.introspectionEnabled = false;
    if (boundary === "account") f.issuer.control.userinfoAccount = "foreign-account";
    if (boundary === "bootstrap") f.issuer.control.bootstrapEnabled = false;
    if (boundary === "owner") f.issuer.control.bootstrapOwner = "foreign-owner";
    if (boundary === "member") f.issuer.control.member = false;
    const response = await f.callback(started);
    expect(response.status).not.toBe(303);
    expect(f.inputs).toHaveLength(0);
    expect(f.calls.create).toBe(0);
    expect(response.headers.getSetCookie().some((value) => value.startsWith(`${COOKIE}=`))).toBe(
      false,
    );
  });
}

test("a signed code exchange with the wrong nonce issues no original input", async () => {
  const f = await fixture();
  const started = await f.start((url) => url.searchParams.set("nonce", "foreign-signed-nonce"));
  const response = await f.callback(started);
  expect(f.issuer.issued).toHaveLength(1);
  expect(response.status).toBe(400);
  expect(f.inputs).toHaveLength(0);
  expect(f.calls.create).toBe(0);
  expect(
    f.issuer.requests.filter((request) => request.url.pathname === "/oauth/introspect"),
  ).toHaveLength(0);
});

for (const boundary of ["receiver", "config", "store", "factory", "resolver", "key"] as const) {
  test(`changed ${boundary} binding refuses the original reader without running accessors`, async () => {
    const f = await fixture();
    await f.login();
    let getters = 0;
    const capture = f.inputs[0]!.capture;
    expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, capture)?.phase).toBe(
      "fresh-callback",
    );
    const target =
      boundary === "receiver"
        ? f.runtime
        : boundary === "config"
          ? f.options.config
          : boundary === "store"
            ? f.store
            : boundary === "resolver"
              ? f.options.principals
              : f.options;
    const key =
      boundary === "receiver"
        ? "fetch"
        : boundary === "config"
          ? "issuer"
          : boundary === "store"
            ? "readSession"
            : boundary === "resolver"
              ? "resolve"
              : "store";
    if (boundary === "key") f.options.encryptionKey[0] = 42;
    else
      Object.defineProperty(target, key, {
        get() {
          getters++;
          throw new Error("substituted getter");
        },
        configurable: true,
      });
    expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, capture)).toBeNull();
    expect(getters).toBe(0);
  });
}

test("resolver DATA mutations cannot change the detached original identity or Workspace", async () => {
  const f = await fixture();
  await f.login();
  const selected = f.inputs[0]!;
  Object.assign(selected.input, { subject: "changed", workspaceId: "changed" });
  const data = rp.readSharedAuthVerifiedPrincipalInput(f.runtime, selected.capture);
  expect(data?.identity.subject).toBe(SESSION_TEST_ACCOUNT);
  expect(data?.workspace.id).toBe(SESSION_TEST_PERSONAL.id);
  expect(f.sessions.values().next().value?.workspaceId).toBe(SESSION_TEST_PERSONAL.id);
});

test("existing observation separates original session Workspace and row versions from selected Org and final touch", async () => {
  const f = await fixture();
  const signed = await f.login();
  const row = [...f.sessions.values()][0]!;
  f.sessions.set(row.digest, { ...row, version: 7 });
  f.time(TIME + 280_000);
  const selected = await f.runtime.observeFinalSession(
    f.request(signed.cookie),
    SESSION_TEST_ORGANIZATION.id,
  );
  expect(selected?.workspace.id).toBe(SESSION_TEST_ORGANIZATION.id);
  expect(f.inputs).toHaveLength(2);
  const data = rp.readSharedAuthVerifiedPrincipalInput(f.runtime, f.inputs[1]!.capture);
  expect(data?.phase).toBe("existing-session");
  if (data?.phase !== "existing-session") throw new Error("missing retained-read observation");
  expect(data.workspace).toEqual(SESSION_TEST_ORGANIZATION);
  expect(data.sessionObservation).toEqual({
    digest: row.digest,
    createdAt: TIME,
    sessionWorkspaceId: SESSION_TEST_PERSONAL.id,
    principalId: PRINCIPAL,
    readVersion: 7,
    resolvedVersion: 9,
  });
  expect(Object.isFrozen(data.sessionObservation)).toBe(true);
  expect(f.runtime.finalSessionSelection(selected)?.sessionVersion).toBe(10);
  expect(f.sessions.get(row.digest)?.workspaceId).toBe(SESSION_TEST_PERSONAL.id);
  expect(f.calls.create).toBe(1);
  expect(JSON.stringify(data)).not.toContain("enrolledSessionVersion");
  expect(JSON.stringify(data)).not.toContain("registrationRef");
});

test("an owner await cannot overwrite the original session tuple through a mutable read copy", async () => {
  const f = await fixture();
  const signed = await f.login();
  const original = [...f.sessions.values()][0]!;
  f.time(TIME + 280_000);
  f.issuer.control.onRefresh = async () => {
    if (!f.control.readAlias) throw new Error("missing selected read copy");
    Object.assign(f.control.readAlias, { workspaceId: "mutated-return-copy", createdAt: TIME - 1 });
  };
  const result = await f.runtime.authenticate(
    f.request(signed.cookie),
    SESSION_TEST_ORGANIZATION.id,
  );
  expect(result?.workspace.id).toBe(SESSION_TEST_ORGANIZATION.id);
  const data = rp.readSharedAuthVerifiedPrincipalInput(f.runtime, f.inputs[1]!.capture);
  if (data?.phase !== "existing-session") throw new Error("missing retained original input");
  expect(data.sessionObservation).toEqual({
    digest: original.digest,
    createdAt: TIME,
    sessionWorkspaceId: SESSION_TEST_PERSONAL.id,
    principalId: PRINCIPAL,
    readVersion: 0,
    resolvedVersion: 2,
  });
  expect(f.sessions.get(original.digest)?.workspaceId).toBe(SESSION_TEST_PERSONAL.id);
  expect(f.calls.create).toBe(1);
});

test("missing retained binding refuses existing observation without fresh enrollment or session creation", async () => {
  const f = await fixture();
  const signed = await f.login();
  f.control.resolve = (capture) => {
    expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, capture)?.phase).toBe(
      "existing-session",
    );
    throw new rp.SharedAuthSessionError("session_unavailable");
  };
  await expect(f.runtime.authenticate(f.request(signed.cookie))).rejects.toThrow(
    "session_unavailable",
  );
  expect(f.calls.create).toBe(1);
  expect(f.inputs).toHaveLength(2);
});

test("unknown create acknowledgement keeps one original attempt and orphan revocation without a cookie", async () => {
  const f = await fixture();
  f.control.unknownCreate = true;
  const response = await f.callback(await f.start());
  expect(response.status).toBe(503);
  expect(f.calls).toEqual({ create: 1, queue: 1, revoke: 1 });
  expect(f.inputs).toHaveLength(1);
  expect([...f.sessions.values()][0]?.status).toBe("revoked");
  expect(response.headers.getSetCookie().some((value) => value.startsWith(`${COOKIE}=`))).toBe(
    false,
  );
  // The reader attests the verified pre-create observation even when session commit acceptance is unknown.
  expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, f.inputs[0]!.capture)?.phase).toBe(
    "fresh-callback",
  );
});

for (const unavailable of ["owner", "store", "property"] as const) {
  test(`ordinary ${unavailable} descriptor unavailability denies the original reader without breaking callback`, async () => {
    const f = await fixture(unavailable);
    const signed = await f.login();
    expect(signed.response.status).toBe(303);
    expect(f.calls.create).toBe(1);
    expect(f.inputs).toHaveLength(1);
    expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, f.inputs[0]!.capture)).toBeNull();
  });
}

test("Root-style freezing preserves the actual RP receiver original input", async () => {
  const f = await fixture(undefined, true);
  await f.login();
  expect(Object.isFrozen(f.runtime)).toBe(true);
  expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, f.inputs[0]!.capture)?.phase).toBe(
    "fresh-callback",
  );
  let getters = 0;
  const unknown = {
    get identity() {
      getters++;
      throw new Error("foreign getter");
    },
  };
  expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, unknown)).toBeNull();
  expect(
    rp.readSharedAuthVerifiedPrincipalInput(f.runtime, structuredClone(f.inputs[0]!.capture)),
  ).toBeNull();
  expect(getters).toBe(0);
});
for (const change of ["value", "accessor", "partial"] as const) {
  test(`receiver freeze exception rejects ${change} descriptor changes`, async () => {
    const f = await fixture();
    await f.login();
    const capture = f.inputs[0]!.capture;
    let getters = 0;
    if (change === "value") f.runtime.fetch = async () => null;
    if (change === "accessor")
      Object.defineProperty(f.runtime, "fetch", {
        get() {
          getters++;
          throw new Error("changed frozen accessor");
        },
        configurable: true,
      });
    if (change === "partial") Object.defineProperty(f.runtime, "fetch", { writable: false });
    else Object.freeze(f.runtime);
    expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, capture)).toBeNull();
    expect(getters).toBe(0);
  });
}

for (const method of ["createSession", "readSession"] as const) {
  test(`inherited ${method} methods keep ordinary behavior but cannot supply original inputs`, async () => {
    const f = await fixture(undefined, false, true);
    let changedCalls = 0;
    let observedBefore: unknown;
    f.control.resolve = (capture) => {
      if (observedBefore === undefined)
        observedBefore = rp.readSharedAuthVerifiedPrincipalInput(f.runtime, capture);
      if (method === "createSession") {
        const original = f.store.createSession;
        f.store.createSession = async (input) => {
          changedCalls++;
          return await Reflect.apply(original, f.store, [input]);
        };
      }
    };
    const signed = await f.login();
    if (method === "readSession") {
      const original = f.store.readSession;
      f.store.readSession = async (digest) => {
        changedCalls++;
        return await Reflect.apply(original, f.store, [digest]);
      };
      const current = await f.runtime.authenticate(f.request(signed.cookie));
      expect(current?.actor.principalId).toBe(PRINCIPAL);
    }
    expect(signed.response.status).toBe(303);
    expect(changedCalls).toBe(1);
    expect(f.calls.create).toBe(1);
    expect(observedBefore).toBeNull();
    expect(rp.readSharedAuthVerifiedPrincipalInput(f.runtime, f.inputs[0]!.capture)).toBeNull();
  });
}
