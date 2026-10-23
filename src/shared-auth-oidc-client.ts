import { base64UrlDecode, base64UrlEncode } from "./json.ts";
import { parseStrictJson } from "./strict-json.ts";

/** Selected first-party staging profile; aliases never receive RP credentials. */
export const SHARED_AUTH_STAGING_PROFILE = Object.freeze({
  environment: "staging",
  issuer: "https://auth-staging.takos.jp",
  publicOrigin: "https://integration-root-ga-573f46e4.shoutatomiyama0614.workers.dev",
  consoleOrigin: "https://takoserver-console-integration.shoutatomiyama0614.workers.dev",
  clientId: "takoserver-console-staging-v1",
} as const);

/** The first-party HTTP contract, independent of another product's source. */
export interface SharedAuthOidcConfig {
  readonly environment: "staging";
  readonly issuer: string;
  readonly publicOrigin: string;
  readonly clientId: "takoserver-console-staging-v1";
  readonly clientSecret: string;
}

/** Identity only. Product roles, Organizations and email are never authority here. */
export interface SharedAuthIdentity {
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly authTime: number;
}

/** Server-only secrets. Persist encrypted; never return this object to a browser. */
export interface SharedAuthGrant extends SharedAuthIdentity {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly nonce: string;
}

export class SharedAuthOidcError extends Error {
  constructor(readonly code: "oidc_invalid" | "oidc_unavailable") {
    super(code);
    this.name = "SharedAuthOidcError";
  }
}

type ExchangeRequestEndpoint = "token" | "jwks";
type ExchangeRequestFailureReason = "deadline" | "transport" | "aborted" | "http_5xx";

function reportExchangeRequestFailure(
  endpoint: ExchangeRequestEndpoint,
  reason: ExchangeRequestFailureReason,
): void {
  try {
    console.error(
      JSON.stringify({
        marker: "takoserver.shared_auth.oidc.exchange_request.failure.v1",
        endpoint,
        reason,
      }),
    );
  } catch {
    // Diagnostics never affect request cleanup or the original OIDC result.
  }
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const DEADLINE_MILLISECONDS = 5000;
const IDENTITY_SCOPES = new Set(["openid", "email", "profile", "offline_access"]);
const IDENTITY_CLAIMS = new Set([
  "iss",
  "sub",
  "aud",
  "azp",
  "iat",
  "exp",
  "auth_time",
  "sid",
  "nonce",
  "email",
  "email_verified",
  "name",
  "picture",
  "preferred_username",
]);

export function createSharedAuthOidcClient(options: {
  readonly config: SharedAuthOidcConfig;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now?: () => number;
}) {
  const config = { ...options.config };
  if (
    config.environment !== SHARED_AUTH_STAGING_PROFILE.environment ||
    config.clientId !== SHARED_AUTH_STAGING_PROFILE.clientId ||
    config.issuer !== SHARED_AUTH_STAGING_PROFILE.issuer ||
    config.publicOrigin !== SHARED_AUTH_STAGING_PROFILE.publicOrigin ||
    !text(config.clientSecret, 4096)
  )
    throw new TypeError("Shared login requires the exact selected staging profile");
  exactOrigin(config.issuer);
  exactOrigin(config.publicOrigin);
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const now = options.now ?? Date.now;
  const redirectUri = `${config.publicOrigin}/auth/oidc/callback`;
  // RFC 6749 section 2.3.1 requires form encoding before HTTP Basic encoding.
  const encoded = new URLSearchParams({ id: config.clientId, secret: config.clientSecret });
  const fields = encoded
    .toString()
    .split("&")
    .map((part) => part.slice(part.indexOf("=") + 1));
  const authorization = `Basic ${btoa(`${fields[0]}:${fields[1]}`)}`;

  async function request(
    path: string,
    form?: URLSearchParams,
    empty = false,
    bearer?: string,
    exchangeEndpoint?: ExchangeRequestEndpoint,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let failureReason: ExchangeRequestFailureReason | undefined;
    let rejected = false;
    let rejection: unknown;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        failureReason ??= "deadline";
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(new SharedAuthOidcError("oidc_unavailable"));
      }, DEADLINE_MILLISECONDS);
    });
    try {
      return await Promise.race([
        deadline,
        (async () => {
          let response: Response;
          try {
            response = await send(
              new Request(`${config.issuer}${path}`, {
                method: form ? "POST" : "GET",
                // workerd's Request rejects "error" on the pinned runtime.
                // Manual leaves 3xx visible for the !ok refusal below.
                redirect: "manual",
                signal: controller.signal,
                headers: {
                  accept: "application/json",
                  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
                  ...(form
                    ? { authorization, "content-type": "application/x-www-form-urlencoded" }
                    : {}),
                },
                ...(form ? { body: form.toString() } : {}),
              }),
            );
          } catch {
            failureReason ??= "transport";
            throw new SharedAuthOidcError("oidc_unavailable");
          }
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            failureReason ??= "aborted";
            throw new SharedAuthOidcError("oidc_unavailable");
          }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            const unavailable = response.status >= 500;
            if (unavailable) failureReason ??= "http_5xx";
            throw new SharedAuthOidcError(unavailable ? "oidc_unavailable" : "oidc_invalid");
          }
          if (empty) {
            void response.body?.cancel().catch(() => {});
            return {};
          }
          if (
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json"
          ) {
            void response.body?.cancel().catch(() => {});
            throw new SharedAuthOidcError("oidc_invalid");
          }
          reader = response.body?.getReader();
          if (!reader) throw new SharedAuthOidcError("oidc_invalid");
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              length += part.value.byteLength;
              if (length > MAX_RESPONSE_BYTES) throw new SharedAuthOidcError("oidc_invalid");
              chunks.push(part.value);
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const value = parseStrictJson(bytes, MAX_RESPONSE_BYTES);
            if (!record(value)) throw new SharedAuthOidcError("oidc_invalid");
            return value;
          } catch (error) {
            void reader.cancel().catch(() => {});
            throw error instanceof SharedAuthOidcError
              ? error
              : new SharedAuthOidcError("oidc_invalid");
          } finally {
            reader.releaseLock();
          }
        })(),
      ]);
    } catch (error) {
      rejected = true;
      rejection = error;
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (exchangeEndpoint && failureReason && rejected) {
        try {
          if (rejection instanceof SharedAuthOidcError && rejection.code === "oidc_unavailable")
            reportExchangeRequestFailure(exchangeEndpoint, failureReason);
        } catch {
          // A throwing error accessor cannot replace the original rejection.
        }
      }
    }
  }

  async function identity(
    token: unknown,
    nonce: string,
    previous?: SharedAuthGrant,
    freshExchange = false,
  ): Promise<SharedAuthIdentity> {
    if (!text(token, MAX_TOKEN_BYTES)) throw new SharedAuthOidcError("oidc_invalid");
    const segments = token.split(".");
    const [encodedHeader, encodedClaims, encodedSignature] = segments;
    if (segments.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature)
      throw new SharedAuthOidcError("oidc_invalid");
    let header: Record<string, unknown>, claims: Record<string, unknown>, signature: Uint8Array;
    try {
      header = objectSegment(encodedHeader);
      claims = objectSegment(encodedClaims);
      const bytes = base64UrlDecode(encodedSignature);
      if (!bytes) throw new Error("signature");
      signature = bytes;
    } catch {
      throw new SharedAuthOidcError("oidc_invalid");
    }
    const seconds = Math.floor(now() / 1000);
    if (
      header.alg !== "ES256" ||
      header.typ !== "JWT" ||
      !text(header.kid, 256) ||
      Object.keys(header).some((key) => !["alg", "typ", "kid"].includes(key)) ||
      signature.byteLength !== 64 ||
      claims.iss !== config.issuer ||
      claims.aud !== config.clientId ||
      (claims.azp !== undefined && claims.azp !== config.clientId) ||
      !text(claims.sub, 512) ||
      !text(claims.sid, 512) ||
      !integer(claims.iat) ||
      !integer(claims.exp) ||
      !integer(claims.auth_time) ||
      claims.iat > seconds + 30 ||
      claims.exp <= seconds ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 300 ||
      claims.auth_time > claims.iat + 30 ||
      (previous ? claims.nonce !== undefined && claims.nonce !== nonce : claims.nonce !== nonce) ||
      Object.keys(claims).some((key) => !IDENTITY_CLAIMS.has(key)) ||
      (previous &&
        (claims.sub !== previous.subject ||
          claims.sid !== previous.sessionId ||
          claims.auth_time !== previous.authTime))
    )
      throw new SharedAuthOidcError("oidc_invalid");
    const jwks = await request(
      "/oauth/jwks",
      undefined,
      false,
      undefined,
      freshExchange ? "jwks" : undefined,
    );
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 32)
      throw new SharedAuthOidcError("oidc_invalid");
    const candidates = jwks.keys.filter((key: unknown) => record(key) && key.kid === header.kid);
    if (candidates.length !== 1 || !record(candidates[0]))
      throw new SharedAuthOidcError("oidc_invalid");
    const key = candidates[0];
    if (
      key.kty !== "EC" ||
      key.crv !== "P-256" ||
      key.alg !== "ES256" ||
      key.use !== "sig" ||
      !text(key.x, 128) ||
      !text(key.y, 128) ||
      Object.hasOwn(key, "d") ||
      (key.key_ops !== undefined &&
        (!Array.isArray(key.key_ops) || key.key_ops.join() !== "verify"))
    )
      throw new SharedAuthOidcError("oidc_invalid");
    try {
      const imported = await crypto.subtle.importKey(
        "jwk",
        key as unknown as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      if (
        !(await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          imported,
          new Uint8Array(signature).buffer,
          new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
        ))
      )
        throw new Error("signature");
    } catch {
      throw new SharedAuthOidcError("oidc_invalid");
    }
    return {
      issuer: config.issuer,
      clientId: config.clientId,
      subject: claims.sub,
      sessionId: claims.sid,
      authTime: claims.auth_time,
    };
  }

  function previousGrant(value: SharedAuthGrant): void {
    if (
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
      throw new SharedAuthOidcError("oidc_invalid");
  }

  async function grant(
    body: Record<string, unknown>,
    nonce: string,
    previous?: SharedAuthGrant,
    freshExchange = false,
  ): Promise<SharedAuthGrant> {
    if (
      body.token_type !== "Bearer" ||
      !text(body.access_token, 8192) ||
      !text(body.refresh_token, 8192) ||
      !integer(body.expires_in) ||
      body.expires_in < 1 ||
      body.expires_in > 300 ||
      typeof body.scope !== "string" ||
      !identityScopes(body.scope) ||
      (previous && body.refresh_token === previous.refreshToken)
    )
      throw new SharedAuthOidcError("oidc_invalid");
    const verified =
      body.id_token === undefined && previous
        ? previous
        : await identity(body.id_token, nonce, previous, freshExchange);
    return {
      issuer: verified.issuer,
      clientId: verified.clientId,
      subject: verified.subject,
      sessionId: verified.sessionId,
      authTime: verified.authTime,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessExpiresAt: now() + body.expires_in * 1000,
      nonce,
    };
  }

  return {
    config: Object.freeze({
      environment: config.environment,
      issuer: config.issuer,
      publicOrigin: config.publicOrigin,
      clientId: config.clientId,
    }),
    redirectUri,
    async authorizationUrl(input: {
      readonly state: string;
      readonly nonce: string;
      readonly verifier: string;
    }) {
      if (!text(input.state, 512) || !text(input.nonce, 512) || !verifier(input.verifier))
        throw new SharedAuthOidcError("oidc_invalid");
      const challenge = base64UrlEncode(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.verifier)),
      );
      const url = new URL(`${config.issuer}/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email offline_access",
        state: input.state,
        nonce: input.nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "consent",
      }).toString();
      return url.toString();
    },
    async exchange(code: string, codeVerifier: string, nonce: string) {
      if (!text(code, 2048) || !text(nonce, 512) || !verifier(codeVerifier))
        throw new SharedAuthOidcError("oidc_invalid");
      return await grant(
        await request(
          "/oauth/token",
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
          false,
          undefined,
          "token",
        ),
        nonce,
        undefined,
        true,
      );
    },
    async refresh(previous: SharedAuthGrant) {
      previousGrant(previous);
      return await grant(
        await request(
          "/oauth/token",
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: previous.refreshToken,
          }),
        ),
        previous.nonce,
        previous,
      );
    },
    async active(value: SharedAuthGrant): Promise<boolean> {
      previousGrant(value);
      const body = await request(
        "/oauth/introspect",
        new URLSearchParams({ token: value.accessToken, token_type_hint: "access_token" }),
      );
      if (body.active === false) return false;
      return (
        body.active === true &&
        body.token_use === "oauth_access" &&
        body.client_id === config.clientId &&
        body.sub === value.subject &&
        body.aud === config.clientId &&
        integer(body.exp) &&
        body.exp > Math.floor(now() / 1000) &&
        typeof body.scope === "string" &&
        identityScopes(body.scope) &&
        Object.keys(body).every((key) =>
          [
            "active",
            "token_use",
            "client_id",
            "sub",
            "aud",
            "exp",
            "scope",
            "iat",
            "iss",
            "sid",
            "auth_time",
            "token_type",
          ].includes(key),
        ) &&
        (body.iss === undefined || body.iss === config.issuer) &&
        (body.sid === undefined || body.sid === value.sessionId)
      );
    },
    /**
     * Accounts UserInfo resolves only a live canonical root with a current
     * first-party grant. Product access still requires live Workspace membership.
     */
    async canonicalAccount(value: SharedAuthGrant): Promise<{ readonly accountId: string }> {
      previousGrant(value);
      const body = await request("/oauth/userinfo", undefined, false, value.accessToken);
      if (
        body.sub !== value.subject ||
        body.aud !== config.clientId ||
        typeof body.scope !== "string" ||
        !identityScopes(body.scope) ||
        Object.keys(body).some(
          (key) =>
            !["sub", "aud", "scope", "email", "email_verified", "name", "picture"].includes(key),
        )
      )
        throw new SharedAuthOidcError("oidc_invalid");
      return { accountId: value.subject };
    },
    async revoke(value: SharedAuthGrant) {
      previousGrant(value);
      for (const [token, hint] of [
        [value.refreshToken, "refresh_token"],
        [value.accessToken, "access_token"],
      ] as const) {
        await request("/oauth/revoke", new URLSearchParams({ token, token_type_hint: hint }), true);
      }
    },
  };
}

export type SharedAuthOidcClient = ReturnType<typeof createSharedAuthOidcClient>;

function objectSegment(value: string): Record<string, unknown> {
  const bytes = base64UrlDecode(value);
  if (!bytes) throw new Error("base64url");
  const decoded = parseStrictJson(bytes, MAX_TOKEN_BYTES);
  if (!record(decoded)) throw new Error("object");
  return decoded;
}
function text(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return false;
  return [...value].every(
    (character) => character.charCodeAt(0) > 0x20 && character.charCodeAt(0) !== 0x7f,
  );
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function verifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}
function identityScopes(value: string): boolean {
  const scopes = value.split(" ");
  return (
    scopes.includes("openid") &&
    scopes.includes("offline_access") &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope) => IDENTITY_SCOPES.has(scope))
  );
}
function exactOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.endsWith(".") ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError("OIDC requires an exact HTTPS origin");
  return url;
}
