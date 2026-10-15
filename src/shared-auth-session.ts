import type { Actor } from "./auth.ts";
import { base64UrlDecode, base64UrlEncode, bytesDigest } from "./json.ts";
import {
  createSharedAuthOidcClient,
  SHARED_AUTH_STAGING_PROFILE,
  type SharedAuthGrant,
  type SharedAuthIdentity,
  type SharedAuthOidcConfig,
  SharedAuthOidcError,
} from "./shared-auth-oidc-client.ts";
import type {
  OidcSessionRecord,
  SharedAuthFinalSessionStore,
  SharedAuthSessionStore,
} from "./shared-auth-session-store.ts";
import { parseStrictJson } from "./strict-json.ts";

export interface SharedWorkspaceChoice {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly type: "personal" | "organization";
  readonly roles: readonly ("owner" | "admin" | "member" | "viewer")[];
  readonly owner: boolean;
}

export interface SharedWorkspaceOrganization {
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly organizationId: string;
}

/**
 * The owning Takoserver composition supplies its reviewed local projection.
 * It preserves proved legacy principal references, never resolves by email,
 * and refuses absent/disabled/conflicting bindings. No account registry or
 * provider masquerade is implemented in this protocol/session preparation.
 */
export interface SharedAuthPrincipalProjection {
  resolve(
    input: SharedAuthIdentity & {
      readonly accountId: string;
      readonly workspaceId: string;
    },
  ): Promise<{ readonly accountId: string; readonly principalId: string }>;
}

/** The owner atomically pins an existing Workspace/Organization tuple once. */
export interface SharedAuthOrganizationPins {
  pin(input: SharedWorkspaceOrganization): Promise<SharedWorkspaceOrganization>;
}

/** Server-only provenance. Existing owner rows are not a membership bypass. */
export interface SharedAuthSessionContext {
  readonly actor: Actor;
  readonly accountId: string;
  readonly workspace: SharedWorkspaceChoice;
  readonly provenance: SharedAuthIdentity & { readonly kind: "shared-account-session" };
}

/** Private observation of this factory's own acknowledged final touch. Not an authority grant. */
export interface SharedAuthFinalSessionSelection {
  readonly sessionDigest: string;
  readonly sessionVersion: number;
  readonly accountId: string;
  readonly principalId: string;
  readonly sessionWorkspaceId: string;
  readonly selectedWorkspaceId: string;
  readonly identity: Readonly<SharedAuthIdentity>;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly grantCheckedAt: number;
  readonly absoluteExpiresAt: number;
  readonly observedAt: number;
}

export class SharedAuthSessionError extends Error {
  constructor(readonly code: "session_invalid" | "session_unavailable" | "workspace_forbidden") {
    super(code);
    this.name = "SharedAuthSessionError";
  }
}

const attemptCookie = "__Host-takoserver_oidc_attempt";
const sessionCookie = "__Host-takoserver_shared_session";
const directoryPath = "/api/v1/account/shared-workspaces";
const attemptTtl = 5 * 60 * 1000;
const idleTtl = 12 * 60 * 60 * 1000;
const absoluteTtl = 7 * 24 * 60 * 60 * 1000;
const healthTtl = 4 * 60 * 1000;

/**
 * Unmounted staging runtime. The API owns callback/cookies; the separate static
 * Console is one fixed return/CORS origin. No entry, migration or credentials
 * are installed by this factory. The owning composition must qualify the
 * principal/pin ports and provide fresh primary-consistent Sql per request.
 */
export function createSharedAuthSession(options: {
  readonly config: SharedAuthOidcConfig;
  readonly consoleOrigin: string;
  readonly encryptionKey: Uint8Array;
  readonly store: () => SharedAuthSessionStore;
  /** Private strict-connected common-primary composition, never a qualification flag. */
  readonly finalStore?: () => SharedAuthFinalSessionStore;
  readonly principals: SharedAuthPrincipalProjection;
  readonly organizations?: SharedAuthOrganizationPins;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now?: () => number;
}) {
  if (
    options.config.environment !== SHARED_AUTH_STAGING_PROFILE.environment ||
    options.config.clientId !== SHARED_AUTH_STAGING_PROFILE.clientId ||
    options.config.issuer !== SHARED_AUTH_STAGING_PROFILE.issuer ||
    options.config.publicOrigin !== SHARED_AUTH_STAGING_PROFILE.publicOrigin ||
    options.consoleOrigin !== SHARED_AUTH_STAGING_PROFILE.consoleOrigin
  )
    throw new TypeError("Shared RP requires the exact selected staging profile");
  const client = createSharedAuthOidcClient(options);
  const config = client.config;
  const consoleOrigin = exactConsoleOrigin(options.consoleOrigin);
  if (
    consoleOrigin === config.issuer ||
    typeof options.store !== "function" ||
    typeof options.principals?.resolve !== "function" ||
    options.encryptionKey.byteLength !== 32
  ) {
    throw new TypeError("Shared RP requires its qualified local projection and session custody");
  }
  const keyBytes = Uint8Array.from(options.encryptionKey);
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const now = options.now ?? Date.now;
  const storeReceiver = options;
  const storeFactory = options.store;
  const finalStoreReceiver = options;
  const finalStoreFactory = options.finalStore;
  if (finalStoreFactory !== undefined && typeof finalStoreFactory !== "function")
    throw new TypeError("Shared RP final observation requires its owning store factory");
  const principalReceiver = options.principals;
  const resolvePrincipal = principalReceiver.resolve;
  const organizationReceiver = options.organizations;
  const pinOrganization = organizationReceiver?.pin;
  if (organizationReceiver !== undefined && typeof pinOrganization !== "function")
    throw new TypeError("Shared RP requires its qualified Organization pin method");
  const selections = new WeakMap<SharedAuthSessionContext, SharedAuthFinalSessionSelection>();

  function createStore(): SharedAuthSessionStore {
    return Reflect.apply(storeFactory, storeReceiver, []);
  }
  function createFinalStore(): SharedAuthFinalSessionStore {
    if (!finalStoreFactory) throw new SharedAuthSessionError("session_unavailable");
    return Reflect.apply(finalStoreFactory, finalStoreReceiver, []);
  }

  function aad(purpose: "attempt" | "grant", digest: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
      JSON.stringify([
        "takoserver-shared-session-staging-v1",
        purpose,
        digest,
        config.issuer,
        config.clientId,
        config.publicOrigin,
        consoleOrigin,
      ]),
    );
  }
  async function seal(
    purpose: "attempt" | "grant",
    digest: string,
    value: unknown,
  ): Promise<string> {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(purpose, digest) },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return `${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
  }
  async function open(
    purpose: "attempt" | "grant",
    digest: string,
    payload: string,
  ): Promise<Record<string, unknown>> {
    try {
      if (payload.length > 65536) throw new Error("size");
      const parts = payload.split(".");
      const iv = parts[0] ? base64UrlDecode(parts[0]) : null;
      const ciphertext = parts[1] ? base64UrlDecode(parts[1]) : null;
      if (parts.length !== 2 || iv?.byteLength !== 12 || !ciphertext) throw new Error("shape");
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv).buffer, additionalData: aad(purpose, digest) },
        key,
        new Uint8Array(ciphertext).buffer,
      );
      const value = parseStrictJson(new Uint8Array(plaintext), 65536);
      if (!record(value)) throw new Error("object");
      return value;
    } catch {
      throw new SharedAuthSessionError("session_invalid");
    }
  }
  async function grant(digest: string, payload: string): Promise<SharedAuthGrant> {
    const value = await open("grant", digest, payload);
    if (
      Object.keys(value).sort().join() !==
        "accessExpiresAt,accessToken,authTime,clientId,issuer,nonce,refreshToken,sessionId,subject" ||
      value.issuer !== config.issuer ||
      value.clientId !== config.clientId ||
      !text(value.subject, 512) ||
      !text(value.sessionId, 512) ||
      !text(value.nonce, 512) ||
      !text(value.accessToken, 8192) ||
      !text(value.refreshToken, 8192) ||
      !integer(value.authTime) ||
      !integer(value.accessExpiresAt)
    )
      throw new SharedAuthSessionError("session_invalid");
    return {
      issuer: value.issuer,
      clientId: value.clientId,
      subject: value.subject,
      sessionId: value.sessionId,
      nonce: value.nonce,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      authTime: value.authTime,
      accessExpiresAt: value.accessExpiresAt,
    };
  }

  async function directory(
    value: SharedAuthGrant,
    path: string,
    post = false,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(new SharedAuthSessionError("session_unavailable"));
      }, 5000);
    });
    try {
      return await Promise.race([
        timeout,
        (async () => {
          let response: Response;
          try {
            response = await send(
              new Request(`${config.issuer}${directoryPath}${path}`, {
                method: post ? "POST" : "GET",
                redirect: "manual",
                signal: controller.signal,
                headers: {
                  accept: "application/json",
                  authorization: `Bearer ${value.accessToken}`,
                  ...(post ? { "content-type": "application/json" } : {}),
                },
                ...(post ? { body: "{}" } : {}),
              }),
            );
          } catch {
            throw new SharedAuthSessionError("session_unavailable");
          }
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new SharedAuthSessionError("session_unavailable");
          }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            throw new SharedAuthSessionError(
              response.status === 401
                ? "session_invalid"
                : response.status === 403 || response.status === 404
                  ? "workspace_forbidden"
                  : "session_unavailable",
            );
          }
          if (
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json"
          ) {
            void response.body?.cancel().catch(() => {});
            throw new SharedAuthSessionError("session_invalid");
          }
          reader = response.body?.getReader();
          if (!reader) throw new SharedAuthSessionError("session_invalid");
          try {
            const chunks: Uint8Array[] = [];
            let length = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              length += part.value.byteLength;
              if (length > 65536) throw new SharedAuthSessionError("session_invalid");
              chunks.push(part.value);
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const body = parseStrictJson(bytes, 65536);
            if (!record(body)) throw new Error("object");
            return body;
          } catch (error) {
            void reader.cancel().catch(() => {});
            throw error instanceof SharedAuthSessionError
              ? error
              : new SharedAuthSessionError("session_invalid");
          } finally {
            reader.releaseLock();
          }
        })(),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function currentWorkspace(
    value: SharedAuthGrant,
    workspaceId: string,
  ): Promise<SharedWorkspaceChoice> {
    if (!text(workspaceId, 256)) throw new SharedAuthSessionError("session_invalid");
    const query = new URLSearchParams({ selectedWorkspaceId: workspaceId, limit: "1" });
    const menu = await directory(value, `?${query}`);
    if (
      menu.accountId !== value.subject ||
      !Array.isArray(menu.choices) ||
      menu.choices.length > 2 ||
      Object.keys(menu).some(
        (key) =>
          ![
            "accountId",
            "personalWorkspaceId",
            "activeWorkspace",
            "choices",
            "nextCursor",
          ].includes(key),
      )
    )
      throw new SharedAuthSessionError("session_invalid");
    const choices = menu.choices.map(choice);
    const selected = choice(menu.activeWorkspace);
    if (
      selected.id !== workspaceId ||
      !choices.some((item) => JSON.stringify(item) === JSON.stringify(selected))
    )
      throw new SharedAuthSessionError("session_invalid");
    return selected;
  }
  async function principal(value: SharedAuthGrant, workspaceId: string): Promise<string> {
    const resolved = await Reflect.apply(resolvePrincipal, principalReceiver, [
      {
        issuer: value.issuer,
        clientId: value.clientId,
        subject: value.subject,
        sessionId: value.sessionId,
        authTime: value.authTime,
        accountId: value.subject,
        workspaceId,
      },
    ]);
    if (
      !resolved ||
      Object.keys(resolved).sort().join() !== "accountId,principalId" ||
      resolved.accountId !== value.subject ||
      !text(resolved.principalId, 512)
    )
      throw new SharedAuthSessionError("session_invalid");
    return resolved.principalId;
  }
  function requestUrl(request: Request): URL {
    const url = new URL(request.url);
    if (
      url.origin !== config.publicOrigin ||
      url.username ||
      url.password ||
      request.headers.has("authorization")
    )
      throw new SharedAuthSessionError("session_invalid");
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== consoleOrigin && origin !== config.publicOrigin)
      throw new SharedAuthSessionError("session_invalid");
    return url;
  }

  function activeAt(row: OidcSessionRecord, digest: string, stamp: number): boolean {
    return (
      integer(stamp) &&
      row.digest === digest &&
      row.status === "active" &&
      text(row.accountId, 512) &&
      text(row.principalId, 512) &&
      text(row.workspaceId, 512) &&
      typeof row.payload === "string" &&
      row.payload.length > 0 &&
      row.payload.length <= 65536 &&
      integer(row.version) &&
      row.version < Number.MAX_SAFE_INTEGER &&
      integer(row.createdAt) &&
      integer(row.lastUsedAt) &&
      integer(row.grantCheckedAt) &&
      integer(row.absoluteExpiresAt) &&
      row.createdAt <= row.grantCheckedAt &&
      row.grantCheckedAt <= row.lastUsedAt &&
      row.lastUsedAt <= stamp &&
      stamp < row.absoluteExpiresAt &&
      stamp - row.lastUsedAt < idleTtl &&
      row.absoluteExpiresAt - row.createdAt <= absoluteTtl
    );
  }

  function sameGrantRow(left: OidcSessionRecord, right: OidcSessionRecord): boolean {
    return (
      left.digest === right.digest &&
      left.accountId === right.accountId &&
      left.principalId === right.principalId &&
      left.workspaceId === right.workspaceId &&
      left.payload === right.payload &&
      left.createdAt === right.createdAt &&
      left.absoluteExpiresAt === right.absoluteExpiresAt &&
      left.grantCheckedAt === right.grantCheckedAt
    );
  }

  async function authenticateWith(
    request: Request,
    store: SharedAuthSessionStore | SharedAuthFinalSessionStore,
    requestedWorkspaceId?: string,
    selectFinal = false,
  ): Promise<SharedAuthSessionContext | null> {
    requestUrl(request);
    const secret = cookie(request, sessionCookie);
    if (!secret) return null;
    const digest = await hash(secret);
    let row = await store.readSession(digest);
    if (!row || row.status === "revoked" || row.status === "revocation_pending") return null;
    const stamp = now();
    if (
      row.absoluteExpiresAt <= stamp ||
      row.lastUsedAt + idleTtl <= stamp ||
      row.createdAt > stamp ||
      row.lastUsedAt > stamp ||
      row.grantCheckedAt > stamp
    ) {
      await store.revokeSession(digest, stamp);
      return null;
    }
    if (row.status === "checking") throw new SharedAuthSessionError("session_unavailable");
    if (!activeAt(row, digest, stamp)) throw new SharedAuthSessionError("session_unavailable");
    let value: SharedAuthGrant;
    try {
      value = await grant(digest, row.payload);
    } catch {
      await store.revokeSession(digest, now());
      return null;
    }
    if (value.subject !== row.accountId) {
      await store.revokeSession(digest, now());
      return null;
    }
    try {
      if (row.grantCheckedAt + healthTtl <= stamp || value.accessExpiresAt <= stamp + 30000) {
        const claimed = await store.claimSession(digest, row.version, stamp);
        if (!claimed) throw new SharedAuthSessionError("session_unavailable");
        try {
          if (value.accessExpiresAt <= stamp + 30000) value = await client.refresh(value);
          if (
            !(await client.active(value)) ||
            (await client.canonicalAccount(value)).accountId !== row.accountId
          )
            throw new SharedAuthSessionError("session_invalid");
          const updated = {
            payload: await seal("grant", digest, value),
            grantCheckedAt: now(),
            lastUsedAt: now(),
          };
          if (!(await store.completeSession(digest, claimed.version, updated)))
            throw new SharedAuthSessionError("session_invalid");
          row = { ...row, ...updated, status: "active", version: claimed.version + 1 };
        } catch (error) {
          // Never retry refresh or completion after an unknown acknowledgement.
          // This fences even a committed completion and durably retains its
          // rotated grant. The store makes custody and denial one transaction.
          await store.queueRevocation({
            id: `uncertain:${digest}:${claimed.version}`,
            sessionDigest: digest,
            payload: await seal("grant", digest, value),
            createdAt: now(),
          });
          await store.revokeSession(digest, now());
          throw error;
        }
      }
      if ((await client.canonicalAccount(value)).accountId !== row.accountId)
        throw new SharedAuthSessionError("session_invalid");
      const workspace = await currentWorkspace(value, requestedWorkspaceId ?? row.workspaceId);
      if ((await principal(value, workspace.id)) !== row.principalId)
        throw new SharedAuthSessionError("session_invalid");
      let selected = row;
      let observedAt = now();
      if (selectFinal) {
        let candidate = row;
        let touchedAt = now();
        if (!activeAt(candidate, digest, touchedAt))
          throw new SharedAuthSessionError("session_unavailable");
        try {
          let touched = await store.touchSessionAndSelect(digest, candidate.version, touchedAt);
          if (touched === null) {
            // Only the dedicated actual strict-connected producer's complete
            // zero-row ACK permits one compatible reload and one retouch.
            const latest = await store.readSession(digest);
            touchedAt = now();
            if (
              !latest ||
              !activeAt(latest, digest, touchedAt) ||
              !sameGrantRow(latest, candidate) ||
              latest.version <= candidate.version ||
              latest.version >= Number.MAX_SAFE_INTEGER - 1 ||
              latest.lastUsedAt < candidate.lastUsedAt
            )
              throw new SharedAuthSessionError("session_unavailable");
            candidate = latest;
            touched = await store.touchSessionAndSelect(digest, candidate.version, touchedAt);
          }
          if (!touched) throw new SharedAuthSessionError("session_unavailable");
          selected = touched;
        } catch {
          // Unknown/malformed/error and a second miss never trigger another
          // read, touch, refresh or substitute selected image.
          throw new SharedAuthSessionError("session_unavailable");
        }
        observedAt = now();
        if (
          !selected ||
          !activeAt(selected, digest, observedAt) ||
          !sameGrantRow(selected, candidate) ||
          selected.version !== candidate.version + 1 ||
          selected.lastUsedAt !== touchedAt ||
          selected.accountId !== value.subject
        )
          throw new SharedAuthSessionError("session_unavailable");
      } else if (!(await store.touchSession(digest, row.version, now()))) {
        // Preserve the existing ordinary RP compatibility path. This produces
        // no final-row selection and cannot authorize the new consumer seam.
        const latest = await store.readSession(digest);
        if (!latest || latest.status === "revoked" || latest.status === "revocation_pending")
          return null;
        if (
          latest.status !== "active" ||
          latest.payload !== row.payload ||
          latest.accountId !== row.accountId ||
          latest.principalId !== row.principalId ||
          latest.workspaceId !== row.workspaceId ||
          !(await store.touchSession(digest, latest.version, now()))
        )
          throw new SharedAuthSessionError("session_unavailable");
      }
      const identity = Object.freeze({
        issuer: value.issuer,
        clientId: value.clientId,
        subject: value.subject,
        sessionId: value.sessionId,
        authTime: value.authTime,
      });
      const context: SharedAuthSessionContext = Object.freeze({
        actor: Object.freeze({
          hostPrincipalId: selected.principalId,
          principalId: selected.principalId,
          kind: "session" as const,
          scopes: Object.freeze([]),
        }),
        accountId: selected.accountId,
        workspace: Object.freeze({ ...workspace, roles: Object.freeze([...workspace.roles]) }),
        provenance: Object.freeze({ kind: "shared-account-session" as const, ...identity }),
      });
      if (selectFinal)
        selections.set(
          context,
          Object.freeze({
            sessionDigest: selected.digest,
            sessionVersion: selected.version,
            accountId: selected.accountId,
            principalId: selected.principalId,
            sessionWorkspaceId: selected.workspaceId,
            selectedWorkspaceId: workspace.id,
            identity,
            createdAt: selected.createdAt,
            lastUsedAt: selected.lastUsedAt,
            grantCheckedAt: selected.grantCheckedAt,
            absoluteExpiresAt: selected.absoluteExpiresAt,
            observedAt,
          }),
        );
      return context;
    } catch (error) {
      if (invalid(error)) {
        await store.revokeSession(digest, now());
        return null;
      }
      throw error;
    }
  }

  async function retryRevocations(
    store: SharedAuthSessionStore,
    limit: number,
  ): Promise<{ completed: number; pending: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2)
      throw new TypeError("Revocation pass is bounded to two grants");
    const rows = await store.listPendingRevocations(now(), limit);
    let completed = 0,
      pending = 0;
    for (const row of rows) {
      const claimed = await store.claimRevocation(row.id, row.version, now());
      if (!claimed) continue;
      try {
        await client.revoke(await grant(claimed.sessionDigest, claimed.payload));
        if (!(await store.completeRevocation(claimed.id, claimed.version)))
          throw new SharedAuthSessionError("session_unavailable");
        completed += 1;
      } catch {
        // Revocation is idempotent and has its own durable lease; this never
        // reuses a refresh grant or reopens an authenticated local session.
        await store.retryRevocation(claimed.id, claimed.version, now() + 30000);
        pending += 1;
      }
    }
    return { completed, pending };
  }

  async function workspaceOrganizationWith(
    request: Request,
    workspaceId: string,
    selectFinal: boolean,
  ): Promise<(SharedAuthSessionContext & SharedWorkspaceOrganization) | null> {
    const captured = snapshotRequest(request);
    const store = selectFinal ? createFinalStore() : createStore();
    const session = await authenticateWith(captured, store, workspaceId, selectFinal);
    if (!session) return null;
    if (!organizationReceiver || !pinOrganization)
      throw new SharedAuthSessionError("session_unavailable");
    const secret = cookie(captured, sessionCookie);
    if (!secret) return null;
    const row = await store.readSession(await hash(secret));
    if (row?.status !== "active") throw new SharedAuthSessionError("session_unavailable");
    const value = await grant(row.digest, row.payload);
    if (value.subject !== session.accountId || row.principalId !== session.actor.principalId)
      throw new SharedAuthSessionError("session_invalid");
    const body = await directory(value, `/${encodeURIComponent(workspaceId)}/billing-organization`);
    if (
      Object.keys(body).sort().join() !== "organizationId,workspaceId,workspaceRef" ||
      body.workspaceId !== workspaceId ||
      !text(body.workspaceRef, 512) ||
      !text(body.organizationId, 128)
    )
      throw new SharedAuthSessionError("session_invalid");
    const binding = Object.freeze({
      workspaceId,
      workspaceRef: body.workspaceRef,
      organizationId: body.organizationId,
    });
    const pinned = await Reflect.apply(pinOrganization, organizationReceiver, [binding]);
    if (
      !pinned ||
      pinned.workspaceId !== workspaceId ||
      pinned.workspaceRef !== binding.workspaceRef ||
      pinned.organizationId !== binding.organizationId
    )
      throw new SharedAuthSessionError("session_invalid");
    // Recheck after an owning pin await: a logout or membership removal must
    // not become a usable context merely because the tuple itself is valid.
    const current = await authenticateWith(captured, store, workspaceId, selectFinal);
    if (
      !current ||
      current.accountId !== session.accountId ||
      current.actor.principalId !== session.actor.principalId
    )
      return null;
    // This tuple locates retained product records. It grants no payment consent.
    const selection = selections.get(current);
    if (selectFinal && !selection) throw new SharedAuthSessionError("session_unavailable");
    const result = Object.freeze({ ...current, ...binding });
    if (selectFinal && selection) selections.set(result, selection);
    return result;
  }

  return {
    /** In-process only: plain records, clones and other factory instances have no provenance. */
    finalSessionSelection(context: unknown): SharedAuthFinalSessionSelection | null {
      return record(context)
        ? (selections.get(context as unknown as SharedAuthSessionContext) ?? null)
        : null;
    },
    async authenticate(request: Request, workspaceId?: string) {
      const captured = snapshotRequest(request);
      return await authenticateWith(captured, createStore(), workspaceId);
    },
    /** Private unmounted observation, separate from ordinary RP/HTTP authentication. */
    async observeFinalSession(request: Request, workspaceId?: string) {
      const captured = snapshotRequest(request);
      return await authenticateWith(captured, createFinalStore(), workspaceId, true);
    },
    async workspaceOrganization(request: Request, workspaceId: string) {
      return await workspaceOrganizationWith(request, workspaceId, false);
    },
    /** Adopted private source ABI; actual strict/common-primary qualification remains pending. */
    async observeFinalWorkspaceOrganization(request: Request, workspaceId: string) {
      return await workspaceOrganizationWith(request, workspaceId, true);
    },
    async retryRevocations(limit = 2) {
      return await retryRevocations(createStore(), limit);
    },
    async fetch(request: Request): Promise<Response | null> {
      request = snapshotRequest(request);
      const initial = new URL(request.url);
      if (
        ![
          "/auth/oidc/login",
          "/auth/oidc/callback",
          "/auth/oidc/logout",
          "/auth/oidc/session",
        ].includes(initial.pathname)
      )
        return null;
      const headers = new Headers({
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        vary: "Origin",
      });
      if (request.headers.get("origin") === consoleOrigin) {
        headers.set("access-control-allow-origin", consoleOrigin);
        headers.set("access-control-allow-credentials", "true");
      }
      try {
        const url = requestUrl(request);
        const store = createStore();
        if (request.method === "OPTIONS") {
          if (
            request.headers.get("origin") !== consoleOrigin ||
            url.search !== "" ||
            !["GET", "POST"].includes(request.headers.get("access-control-request-method") ?? "") ||
            (request.headers.get("access-control-request-headers") ?? "")
              .split(",")
              .some((name) => name.trim() !== "" && name.trim().toLowerCase() !== "content-type")
          )
            throw new SharedAuthSessionError("session_invalid");
          headers.set("access-control-allow-methods", "GET, POST");
          headers.set("access-control-allow-headers", "content-type");
          return new Response(null, { status: 204, headers });
        }
        if (url.pathname === "/auth/oidc/login" && request.method === "GET") {
          if (url.search !== "") throw new SharedAuthSessionError("session_invalid");
          await store.cleanupExpiredAttempts(now(), 32);
          const browser = random(),
            state = random(),
            nonce = random(),
            verifier = random();
          const digest = await hash(browser),
            stamp = now();
          if (
            !(await store.putAttempt({
              digest,
              payload: await seal("attempt", digest, { state, nonce, verifier }),
              createdAt: stamp,
              expiresAt: stamp + attemptTtl,
            }))
          )
            throw new SharedAuthSessionError("session_unavailable");
          headers.set("set-cookie", setCookie(attemptCookie, browser, attemptTtl / 1000));
          headers.set("location", await client.authorizationUrl({ state, nonce, verifier }));
          return new Response(null, { status: 303, headers });
        }
        if (url.pathname === "/auth/oidc/callback" && request.method === "GET") {
          headers.append("set-cookie", setCookie(attemptCookie, "", 0));
          const browser = cookie(request, attemptCookie);
          if (!browser) throw new SharedAuthSessionError("session_invalid");
          const digest = await hash(browser);
          const row = await store.consumeAttempt(digest, now());
          if (!row) throw new SharedAuthSessionError("session_invalid");
          const attempt = await open("attempt", digest, row.payload);
          if (
            Object.keys(attempt).sort().join() !== "nonce,state,verifier" ||
            !text(attempt.state, 512) ||
            !text(attempt.nonce, 512) ||
            !text(attempt.verifier, 512) ||
            [...url.searchParams.keys()].some((name) => !["code", "state", "iss"].includes(name)) ||
            url.searchParams.getAll("code").length !== 1 ||
            url.searchParams.getAll("state").length !== 1 ||
            url.searchParams.getAll("iss").length > 1 ||
            !(await sameSecret(url.searchParams.get("state") ?? "", attempt.state)) ||
            (url.searchParams.has("iss") && url.searchParams.get("iss") !== config.issuer)
          )
            throw new SharedAuthSessionError("session_invalid");
          const code = url.searchParams.get("code");
          if (!text(code, 2048)) throw new SharedAuthSessionError("session_invalid");
          const secret = random(),
            sessionDigest = await hash(secret);
          let value: SharedAuthGrant | undefined;
          try {
            value = await client.exchange(code, attempt.verifier, attempt.nonce);
            if (
              !(await client.active(value)) ||
              (await client.canonicalAccount(value)).accountId !== value.subject
            )
              throw new SharedAuthSessionError("session_invalid");
            // Explicit canonical bootstrap precedes ACTIVE local session creation.
            const bootstrap = await directory(value, "/bootstrap", true);
            const workspace = bootstrap.workspace;
            if (
              !record(workspace) ||
              !text(workspace.id, 256) ||
              workspace.type !== "personal" ||
              workspace.ownerUserId !== value.subject
            )
              throw new SharedAuthSessionError("session_invalid");
            const selected = await currentWorkspace(value, workspace.id);
            if (selected.type !== "personal" || !selected.owner)
              throw new SharedAuthSessionError("workspace_forbidden");
            const principalId = await principal(value, selected.id);
            const oldSecret = cookie(request, sessionCookie);
            if (oldSecret) await store.revokeSession(await hash(oldSecret), now());
            const stamp = now();
            if (
              !(await store.createSession({
                digest: sessionDigest,
                accountId: value.subject,
                principalId,
                workspaceId: selected.id,
                payload: await seal("grant", sessionDigest, value),
                createdAt: stamp,
                lastUsedAt: stamp,
                absoluteExpiresAt: stamp + absoluteTtl,
                grantCheckedAt: stamp,
                version: 0,
                status: "active",
              }))
            )
              throw new SharedAuthSessionError("session_unavailable");
            headers.append("set-cookie", setCookie(sessionCookie, secret, absoluteTtl / 1000));
            headers.set("location", `${consoleOrigin}/`);
            return new Response(null, { status: 303, headers });
          } catch (error) {
            if (value) {
              await store.queueRevocation({
                id: `callback:${crypto.randomUUID()}`,
                sessionDigest,
                payload: await seal("grant", sessionDigest, value),
                createdAt: now(),
              });
              // A lost create acknowledgement must not leave a usable local row.
              await store.revokeSession(sessionDigest, now());
            }
            throw error;
          }
        }
        if (url.pathname === "/auth/oidc/logout" && request.method === "POST") {
          if (url.search !== "" || request.headers.get("origin") !== consoleOrigin)
            throw new SharedAuthSessionError("session_invalid");
          headers.set("set-cookie", setCookie(sessionCookie, "", 0));
          const secret = cookie(request, sessionCookie);
          if (secret) await store.revokeSession(await hash(secret), now());
          // Upstream outages cannot delay the browser's local logout. The
          // owning maintenance entry drains this already durable outbox.
          return new Response(null, { status: 204, headers });
        }
        if (
          url.pathname === "/auth/oidc/session" &&
          request.method === "GET" &&
          url.search === ""
        ) {
          const session = await authenticateWith(request, store);
          return Response.json(
            { authenticated: session !== null },
            { status: session ? 200 : 401, headers },
          );
        }
        return Response.json({ error: { code: "method_not_allowed" } }, { status: 405, headers });
      } catch (error) {
        const forbidden =
          error instanceof SharedAuthSessionError && error.code === "workspace_forbidden";
        const bad = invalid(error);
        return Response.json(
          {
            error: {
              code: forbidden
                ? "workspace_forbidden"
                : bad
                  ? "session_invalid"
                  : "session_unavailable",
            },
          },
          { status: forbidden ? 403 : bad ? 400 : 503, headers },
        );
      }
    },
  };
}

export type SharedAuthSession = ReturnType<typeof createSharedAuthSession>;

function choice(value: unknown): SharedWorkspaceChoice {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== "displayName,handle,id,owner,roles,type" ||
    !text(value.id, 256) ||
    typeof value.handle !== "string" ||
    value.handle.length < 1 ||
    value.handle.length > 256 ||
    typeof value.displayName !== "string" ||
    value.displayName.length < 1 ||
    value.displayName.length > 256 ||
    !["personal", "organization"].includes(String(value.type)) ||
    !Array.isArray(value.roles) ||
    value.roles.length < 1 ||
    value.roles.length > 4 ||
    !value.roles.every((role) => ["owner", "admin", "member", "viewer"].includes(role)) ||
    new Set(value.roles).size !== value.roles.length ||
    typeof value.owner !== "boolean" ||
    value.owner !== value.roles.includes("owner")
  )
    throw new SharedAuthSessionError("session_invalid");
  return {
    id: value.id,
    handle: value.handle,
    displayName: value.displayName,
    type: value.type as "personal" | "organization",
    roles: value.roles as SharedWorkspaceChoice["roles"],
    owner: value.owner,
  };
}
function exactConsoleOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.hostname.endsWith(".") ||
    ["auth.takos.jp", "app.takosumi.com", "console.takoserver.com", "api.takoserver.com"].includes(
      url.hostname,
    )
  )
    throw new TypeError("Shared RP requires an isolated exact staging Console origin");
  return value;
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every(
      (character) => character.charCodeAt(0) > 0x20 && character.charCodeAt(0) !== 0x7f,
    )
  );
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(error: unknown): boolean {
  return (
    (error instanceof SharedAuthSessionError && error.code === "session_invalid") ||
    (error instanceof SharedAuthOidcError && error.code === "oidc_invalid")
  );
}
function random(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
function hash(value: string): Promise<`sha256:${string}`> {
  return bytesDigest(new TextEncoder().encode(value));
}
async function sameSecret(left: string, right: string): Promise<boolean> {
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)));
  let difference = 0;
  for (let index = 0; index < 32; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
function snapshotRequest(request: Request): Request {
  // Capture only invocation metadata. Payment/request bodies are never consumed
  // or forwarded by this private session observation seam.
  const url = request.url;
  const method = request.method;
  const headers = new Headers(request.headers);
  return new Request(url, { method, headers });
}
function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  if (
    header.length > 8192 ||
    [...header].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  )
    throw new SharedAuthSessionError("session_invalid");
  const values = header
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  if (values.length > 1) throw new SharedAuthSessionError("session_invalid");
  if (values.length === 0) return null;
  const value = values[0]?.slice(name.length + 1);
  if (!value || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new SharedAuthSessionError("session_invalid");
  return value;
}
function setCookie(name: string, value: string, maximumAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maximumAge}`;
}
