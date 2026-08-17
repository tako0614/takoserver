import { base64UrlDecode, base64UrlEncode, isSha256Digest } from "./json.ts";
import type { Clock, Sql } from "./ports.ts";

/**
 * Every signed credential Takoserver issues, in one module.
 *
 * Two audiences share one Ed25519 format and one key table:
 *
 * - **data tokens** are resource-scoped and time-bounded. They are reusable
 *   until they expire and verify statelessly, so a data-plane request costs no
 *   control-plane round trip. That is the whole point: one signature check per
 *   `GET`, not one token mint per `GET`.
 * - **provision tokens** are single-use. They hand a reseller's untrusted
 *   runtime the authority to create exactly one resource against exactly one
 *   reservation, and the identifier is consumed atomically on redemption.
 *
 * Revocation has two tiers. Revoking a signing key in `runtime_grant_keys`
 * kills every token it signed; per-resource kill is a caller concern layered on
 * top (the resource row carries an epoch the data plane checks). Key state is
 * cached for {@link CreateTokenServiceOptions.keyCacheSeconds}, which is the
 * upper bound on how long a revoked key keeps verifying.
 */

const TOKEN_TYPE = "takoserver-token+jwt";
const DATA_AUDIENCE = "tako.data";
const PROVISION_AUDIENCE = "tako.provision";
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const ACTIVE_KEY_LIMIT = 32;
const EXPIRED_REPLAY_DELETE_LIMIT = 64;

export type DataProtocol = "s3" | "openai";

export interface DataTokenClaims {
  readonly orgId: string;
  readonly tenantRef: string | null;
  readonly resourceUid: string;
  readonly protocols: readonly DataProtocol[];
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly tokenId: string;
}

export interface ProvisionTokenClaims {
  readonly orgId: string;
  readonly tenantRef: string;
  readonly reservationId: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly tokenId: string;
}

export type TokenErrorCode =
  | "malformed_token"
  | "unknown_key"
  | "invalid_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_resource"
  | "wrong_protocol"
  | "token_not_yet_valid"
  | "token_expired"
  | "token_lifetime_exceeded"
  | "token_replayed"
  | "no_active_keys"
  | "state_unavailable";

export class TokenError extends Error {
  constructor(readonly code: TokenErrorCode) {
    super(code);
    this.name = "TokenError";
  }
}

export interface SigningKey {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}

export interface TokenService {
  issueDataToken(input: {
    readonly orgId: string;
    readonly tenantRef?: string | null;
    readonly resourceUid: string;
    readonly protocols: readonly DataProtocol[];
    readonly ttlSeconds: number;
  }): Promise<{ readonly token: string; readonly expiresAt: string }>;

  /** Stateless: signature, issuer, audience, window, resource, and protocol. */
  verifyDataToken(
    token: string,
    expected: { readonly resourceUid: string; readonly protocol: DataProtocol },
  ): Promise<DataTokenClaims>;

  issueProvisionToken(input: {
    readonly orgId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
    readonly offeringId: string;
    readonly offeringDigest: `sha256:${string}`;
    readonly ttlSeconds: number;
  }): Promise<{ readonly token: string; readonly expiresAt: string }>;

  /** Single-use: the identifier is consumed atomically, so a replay loses. */
  consumeProvisionToken(token: string): Promise<ProvisionTokenClaims>;
}

export interface CreateTokenServiceOptions {
  readonly sql: Sql;
  readonly issuer: string;
  readonly signingKey?: SigningKey;
  readonly clock?: Clock;
  readonly maxDataTokenLifetimeSeconds?: number;
  readonly maxProvisionTokenLifetimeSeconds?: number;
  readonly keyCacheSeconds?: number;
}

export function createTokenService(options: CreateTokenServiceOptions): TokenService {
  const issuer = httpsOrigin(options.issuer);
  const clock = options.clock ?? (() => new Date());
  const maxDataLifetime = positiveInteger(options.maxDataTokenLifetimeSeconds ?? 3_600);
  const maxProvisionLifetime = positiveInteger(options.maxProvisionTokenLifetimeSeconds ?? 300);
  const keyCacheSeconds = options.keyCacheSeconds ?? 10;
  const keys = createKeyCache(options.sql, clock, keyCacheSeconds);

  const sign = async (
    audience: string,
    claims: Record<string, unknown>,
    ttlSeconds: number,
    maxLifetime: number,
  ): Promise<{ token: string; expiresAt: string }> => {
    const key = options.signingKey;
    if (!key) throw new TokenError("no_active_keys");
    if (!KEY_ID.test(key.keyId)) throw new TypeError("signing key id is invalid");
    if (key.privateKey.type !== "private" || !key.privateKey.usages.includes("sign")) {
      throw new TypeError("an Ed25519 signing key is required");
    }
    const lifetime = positiveInteger(ttlSeconds);
    if (lifetime > maxLifetime) throw new TokenError("token_lifetime_exceeded");

    const issuedAt = Math.floor(clock().getTime() / 1_000);
    const expiresAt = issuedAt + lifetime;
    const header = encode({ alg: "EdDSA", kid: key.keyId, typ: TOKEN_TYPE });
    const payload = encode({
      ...claims,
      aud: audience,
      exp: expiresAt,
      iat: issuedAt,
      iss: issuer,
      jti: `tok_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))}`,
      nbf: issuedAt,
    });
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "Ed25519",
      key.privateKey,
      new TextEncoder().encode(signingInput),
    );
    return {
      token: `${signingInput}.${base64UrlEncode(signature)}`,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    };
  };

  const open = async (
    token: string,
    audience: string,
    maxLifetime: number,
  ): Promise<Record<string, unknown>> => {
    if (typeof token !== "string" || token.length > 16_384) fail("malformed_token");
    const parts = token.split(".");
    if (parts.length !== 3) fail("malformed_token");
    const [headerPart, payloadPart, signaturePart] = parts;
    if (!headerPart || !payloadPart || !signaturePart) fail("malformed_token");

    const header = decodeExact(headerPart, ["alg", "kid", "typ"]);
    if (header.alg !== "EdDSA" || header.typ !== TOKEN_TYPE || typeof header.kid !== "string") {
      fail("malformed_token");
    }
    const publicKey = (await keys.active()).get(header.kid);
    if (!publicKey) fail("unknown_key");

    const signature = decodePart(signaturePart);
    const verified = await crypto.subtle
      .verify(
        "Ed25519",
        publicKey,
        signature as unknown as BufferSource,
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      )
      .catch(() => false);
    if (!verified) fail("invalid_signature");

    const payload = decodeRecord(payloadPart);
    if (payload.iss !== issuer) fail("wrong_issuer");
    if (payload.aud !== audience) fail("wrong_audience");

    const issuedAt = epochSeconds(payload.iat);
    const notBefore = epochSeconds(payload.nbf);
    const expiresAt = epochSeconds(payload.exp);
    const now = Math.floor(clock().getTime() / 1_000);
    if (issuedAt > now || notBefore > now) fail("token_not_yet_valid");
    if (now >= expiresAt) fail("token_expired");
    if (expiresAt - issuedAt > maxLifetime) fail("token_lifetime_exceeded");
    if (typeof payload.jti !== "string" || !REFERENCE.test(payload.jti)) fail("malformed_token");
    return payload;
  };

  return {
    async issueDataToken(input) {
      return await sign(
        DATA_AUDIENCE,
        {
          orgId: reference(input.orgId),
          protocols: protocols(input.protocols),
          resourceUid: reference(input.resourceUid),
          tenantRef: input.tenantRef == null ? null : reference(input.tenantRef),
        },
        input.ttlSeconds,
        maxDataLifetime,
      );
    },

    async verifyDataToken(token, expected) {
      const payload = await open(token, DATA_AUDIENCE, maxDataLifetime);
      const claims = dataClaims(payload);
      if (claims.resourceUid !== expected.resourceUid) fail("wrong_resource");
      if (!claims.protocols.includes(expected.protocol)) fail("wrong_protocol");
      return claims;
    },

    async issueProvisionToken(input) {
      if (!isSha256Digest(input.offeringDigest)) throw new TypeError("offering digest is invalid");
      return await sign(
        PROVISION_AUDIENCE,
        {
          offeringDigest: input.offeringDigest,
          offeringId: reference(input.offeringId),
          orgId: reference(input.orgId),
          reservationId: reference(input.reservationId),
          tenantRef: reference(input.tenantRef),
        },
        input.ttlSeconds,
        maxProvisionLifetime,
      );
    },

    async consumeProvisionToken(token) {
      const payload = await open(token, PROVISION_AUDIENCE, maxProvisionLifetime);
      const claims = provisionClaims(payload);
      await consume(options.sql, clock, claims.tokenId, claims.expiresAtEpochSeconds);
      return claims;
    },
  };
}

/**
 * Consumes a token identifier exactly once. The insert is the whole decision:
 * whichever caller changes a row owns the token, and every other caller sees
 * zero changes and loses. Expired identifiers are swept in bounded batches so
 * the table cannot grow without limit.
 */
async function consume(
  sql: Sql,
  clock: Clock,
  tokenId: string,
  expiresAtEpochSeconds: number,
): Promise<void> {
  const now = Math.floor(clock().getTime() / 1_000);
  if (expiresAtEpochSeconds <= now) fail("token_expired");
  let claimed: { changes: number };
  try {
    await sql.run(
      `DELETE FROM runtime_grant_replays
       WHERE grant_id IN (
         SELECT grant_id FROM runtime_grant_replays
         WHERE expires_at_epoch_seconds <= ?
         ORDER BY expires_at_epoch_seconds, grant_id
         LIMIT ?
       )`,
      [now, EXPIRED_REPLAY_DELETE_LIMIT],
    );
    claimed = await sql.run(
      `INSERT OR IGNORE INTO runtime_grant_replays
         (grant_id, expires_at_epoch_seconds, consumed_at_epoch_seconds)
       VALUES (?, ?, ?)`,
      [tokenId, expiresAtEpochSeconds, now],
    );
  } catch {
    throw new TokenError("state_unavailable");
  }
  if (claimed.changes !== 1) fail("token_replayed");
}

interface KeyCache {
  active(): Promise<ReadonlyMap<string, CryptoKey>>;
}

function createKeyCache(sql: Sql, clock: Clock, cacheSeconds: number): KeyCache {
  let cached: { readonly at: number; readonly keys: ReadonlyMap<string, CryptoKey> } | null = null;

  return {
    async active(): Promise<ReadonlyMap<string, CryptoKey>> {
      const now = Math.floor(clock().getTime() / 1_000);
      if (cached && now - cached.at < cacheSeconds) return cached.keys;

      let rows: readonly Record<string, unknown>[];
      try {
        rows = await sql.query(
          `SELECT key_id, public_jwk FROM runtime_grant_keys
           WHERE revoked_at_epoch_seconds IS NULL
           ORDER BY key_id LIMIT ?`,
          [ACTIVE_KEY_LIMIT + 1],
        );
      } catch {
        throw new TokenError("state_unavailable");
      }
      if (rows.length === 0) throw new TokenError("no_active_keys");
      if (rows.length > ACTIVE_KEY_LIMIT) throw new TokenError("state_unavailable");

      const keys = new Map<string, CryptoKey>();
      for (const row of rows) {
        const keyId = row.key_id;
        if (typeof keyId !== "string" || !KEY_ID.test(keyId) || keys.has(keyId)) {
          throw new TokenError("state_unavailable");
        }
        keys.set(keyId, await importPublicKey(row.public_jwk));
      }
      cached = { at: now, keys };
      return keys;
    },
  };
}

async function importPublicKey(value: unknown): Promise<CryptoKey> {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new TokenError("state_unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TokenError("state_unavailable");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    "d" in (parsed as Record<string, unknown>)
  ) {
    throw new TokenError("state_unavailable");
  }
  const jwk = parsed as Record<string, unknown>;
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)
  ) {
    throw new TokenError("state_unavailable");
  }
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: jwk.x, key_ops: ["verify"], ext: true },
      "Ed25519",
      false,
      ["verify"],
    );
    if (key.type !== "public") throw new TokenError("state_unavailable");
    return key;
  } catch {
    throw new TokenError("state_unavailable");
  }
}

function dataClaims(payload: Record<string, unknown>): DataTokenClaims {
  exactKeys(payload, [
    "aud",
    "exp",
    "iat",
    "iss",
    "jti",
    "nbf",
    "orgId",
    "protocols",
    "resourceUid",
    "tenantRef",
  ]);
  const tenantRef = payload.tenantRef;
  return {
    orgId: claimReference(payload.orgId),
    tenantRef: tenantRef === null ? null : claimReference(tenantRef),
    resourceUid: claimReference(payload.resourceUid),
    protocols: claimProtocols(payload.protocols),
    issuedAtEpochSeconds: epochSeconds(payload.iat),
    expiresAtEpochSeconds: epochSeconds(payload.exp),
    tokenId: claimReference(payload.jti),
  };
}

function provisionClaims(payload: Record<string, unknown>): ProvisionTokenClaims {
  exactKeys(payload, [
    "aud",
    "exp",
    "iat",
    "iss",
    "jti",
    "nbf",
    "offeringDigest",
    "offeringId",
    "orgId",
    "reservationId",
    "tenantRef",
  ]);
  if (!isSha256Digest(payload.offeringDigest)) fail("malformed_token");
  return {
    orgId: claimReference(payload.orgId),
    tenantRef: claimReference(payload.tenantRef),
    reservationId: claimReference(payload.reservationId),
    offeringId: claimReference(payload.offeringId),
    offeringDigest: payload.offeringDigest,
    issuedAtEpochSeconds: epochSeconds(payload.iat),
    expiresAtEpochSeconds: epochSeconds(payload.exp),
    tokenId: claimReference(payload.jti),
  };
}

function encode(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodePart(part: string): Uint8Array {
  const bytes = base64UrlDecode(part);
  if (!bytes) fail("malformed_token");
  return bytes;
}

function decodeRecord(part: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(decodePart(part)));
  } catch {
    fail("malformed_token");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("malformed_token");
  return value as Record<string, unknown>;
}

function decodeExact(part: string, expected: readonly string[]): Record<string, unknown> {
  const value = decodeRecord(part);
  exactKeys(value, expected);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail("malformed_token");
  }
}

function protocols(value: readonly DataProtocol[]): readonly DataProtocol[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 2 ||
    new Set(value).size !== value.length ||
    value.some((entry) => entry !== "s3" && entry !== "openai")
  ) {
    throw new TypeError("data token protocols are invalid");
  }
  return [...value].sort();
}

function claimProtocols(value: unknown): readonly DataProtocol[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 2 ||
    new Set(value).size !== value.length ||
    value.some((entry) => entry !== "s3" && entry !== "openai")
  ) {
    fail("malformed_token");
  }
  return value as readonly DataProtocol[];
}

function reference(value: string): string {
  if (typeof value !== "string" || !REFERENCE.test(value)) {
    throw new TypeError("token reference is invalid");
  }
  return value;
}

function claimReference(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE.test(value)) fail("malformed_token");
  return value;
}

function epochSeconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("malformed_token");
  return value as number;
}

function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("issuer must be an HTTPS origin");
  }
  return url.origin;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("positive integer required");
  return value;
}

function fail(code: TokenErrorCode): never {
  throw new TokenError(code);
}
