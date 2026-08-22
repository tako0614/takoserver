import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { base64UrlDecode, base64UrlEncode, isSha256Digest } from "./json.ts";
import type { Clock, Sql } from "./ports.ts";
import {
  boundedRuntimeMaterialization,
  type RuntimeMaterializationAuthority,
} from "./runtime-materialization.ts";

/**
 * Every signed credential Takoserver issues, in one module.
 *
 * Provision tokens are single-use. They hand a reseller's untrusted
 *   runtime the authority to create exactly one resource against exactly one
 *   reservation, and the identifier is consumed atomically on redemption.
 *
 * Revoking a signing key in `runtime_grant_keys`
 * kills every token it signed; per-resource kill is a caller concern layered on
 * top (the resource row carries an epoch the data plane checks). Key state is
 * cached for {@link CreateTokenServiceOptions.keyCacheSeconds}, which is the
 * upper bound on how long a revoked key keeps verifying.
 */

const TOKEN_TYPE = "takoserver-token+jwt";
const PROVISION_AUDIENCE = "tako.provision";
const TAKOFORM_RUN_AUDIENCE = "takoform.run";
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const ACTIVE_KEY_LIMIT = 32;
const EXPIRED_REPLAY_DELETE_LIMIT = 64;

export interface ProvisionTokenClaims {
  readonly organizationId: string;
  readonly tenantRef: string;
  readonly reservationId: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly tokenId: string;
}

export interface TakoformRunTokenClaims extends ProvisionTokenClaims {
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly resourceName: string;
  readonly mode: "provision" | "manage";
  readonly resourceUid?: string;
}

/**
 * Short-lived credential for one reseller-owned tenant space.
 *
 * Unlike a reservation token, this is deliberately not tied to one Resource:
 * an ordinary OpenTofu run may create several independent Resources. It is
 * still narrower than an organization API key because every stateful
 * Takoform request is confined to the one opaque tenant space.
 */
export interface TakoformTenantRunTokenClaims {
  readonly organizationId: string;
  readonly tenantRef: string;
  /** Opaque Capsule-scoped Takoform namespace selected by the reseller. */
  readonly spaceRef: string;
  readonly runRef: string;
  readonly mode: "tenant-run";
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly tokenId: string;
  readonly runtimeMaterialization?: RuntimeMaterializationAuthority;
}

export type TokenErrorCode =
  | "malformed_token"
  | "unknown_key"
  | "invalid_signature"
  | "wrong_issuer"
  | "wrong_audience"
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
  issueProvisionToken(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
    readonly offeringId: string;
    readonly offeringDigest: `sha256:${string}`;
    readonly ttlSeconds: number;
  }): Promise<{ readonly token: string; readonly expiresAt: string }>;

  /**
   * Stateless check that leaves the token spendable. The provision lane reads
   * a token several times — validate, prepare — before the one apply that
   * spends it, and only `consumeProvisionToken` burns the identifier.
   */
  verifyProvisionToken(token: string): Promise<ProvisionTokenClaims>;

  /** Single-use: the identifier is consumed atomically, so a replay loses. */
  consumeProvisionToken(token: string): Promise<ProvisionTokenClaims>;

  issueTakoformRunToken(
    input: {
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly reservationId: string;
      readonly offeringId: string;
      readonly offeringDigest: `sha256:${string}`;
      readonly formRef: TakoformV1Alpha3FormRef;
      readonly resourceName: string;
      readonly ttlSeconds: number;
    } & (
      | { readonly mode: "provision"; readonly resourceUid?: never }
      | { readonly mode: "manage"; readonly resourceUid: string }
    ),
  ): Promise<{ readonly token: string; readonly expiresAt: string }>;

  issueTakoformTenantRunToken(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly spaceRef: string;
    readonly runRef: string;
    readonly runtimeMaterialization?: RuntimeMaterializationAuthority;
    readonly ttlSeconds: number;
  }): Promise<{ readonly token: string; readonly expiresAt: string }>;

  verifyTakoformTenantRunToken(token: string): Promise<TakoformTenantRunTokenClaims>;

  /** Reusable only within its short lifetime and exact Resource address. */
  verifyTakoformRunToken(token: string): Promise<TakoformRunTokenClaims>;

  /**
   * Claims the paid reservation before the first provider create. Repeating
   * the same token is accepted so the Host's own idempotency receipt can
   * recover a lost acknowledgement; a different token for the reservation is
   * rejected.
   */
  claimTakoformRunTokenForCreate(token: string): Promise<TakoformRunTokenClaims>;
}

export interface CreateTokenServiceOptions {
  readonly sql: Sql;
  readonly issuer: string;
  readonly signingKey?: SigningKey;
  readonly clock?: Clock;
  readonly maxProvisionTokenLifetimeSeconds?: number;
  readonly maxTakoformRunTokenLifetimeSeconds?: number;
  readonly keyCacheSeconds?: number;
}

export function createTokenService(options: CreateTokenServiceOptions): TokenService {
  const issuer = httpsOrigin(options.issuer);
  const clock = options.clock ?? (() => new Date());
  const maxProvisionLifetime = positiveInteger(options.maxProvisionTokenLifetimeSeconds ?? 300);
  const maxTakoformRunLifetime = positiveInteger(
    options.maxTakoformRunTokenLifetimeSeconds ?? 3_600,
  );
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
    async issueProvisionToken(input) {
      if (!isSha256Digest(input.offeringDigest)) throw new TypeError("offering digest is invalid");
      return await sign(
        PROVISION_AUDIENCE,
        {
          offeringDigest: input.offeringDigest,
          offeringId: reference(input.offeringId),
          organizationId: reference(input.organizationId),
          reservationId: reference(input.reservationId),
          tenantRef: reference(input.tenantRef),
        },
        input.ttlSeconds,
        maxProvisionLifetime,
      );
    },

    async verifyProvisionToken(token) {
      const payload = await open(token, PROVISION_AUDIENCE, maxProvisionLifetime);
      return provisionClaims(payload);
    },

    async consumeProvisionToken(token) {
      const payload = await open(token, PROVISION_AUDIENCE, maxProvisionLifetime);
      const claims = provisionClaims(payload);
      await consume(options.sql, clock, claims);
      return claims;
    },

    async issueTakoformRunToken(input) {
      if (!isSha256Digest(input.offeringDigest)) throw new TypeError("offering digest is invalid");
      const formRef = validatedFormRef(input.formRef);
      if (!RESOURCE_NAME.test(input.resourceName)) {
        throw new TypeError("resource name is invalid");
      }
      if (input.mode === "manage" && !REFERENCE.test(input.resourceUid)) {
        throw new TypeError("resource uid is invalid");
      }
      return await sign(
        TAKOFORM_RUN_AUDIENCE,
        {
          formRef,
          offeringDigest: input.offeringDigest,
          offeringId: reference(input.offeringId),
          organizationId: reference(input.organizationId),
          reservationId: reference(input.reservationId),
          resourceUid: input.mode === "manage" ? input.resourceUid : null,
          resourceName: input.resourceName,
          mode: input.mode,
          tenantRef: reference(input.tenantRef),
        },
        input.ttlSeconds,
        maxTakoformRunLifetime,
      );
    },

    async issueTakoformTenantRunToken(input) {
      return await sign(
        TAKOFORM_RUN_AUDIENCE,
        {
          mode: "tenant-run",
          organizationId: reference(input.organizationId),
          runRef: reference(input.runRef),
          spaceRef: reference(input.spaceRef),
          tenantRef: reference(input.tenantRef),
          ...(input.runtimeMaterialization
            ? {
                runtimeMaterialization: boundedRuntimeMaterialization(input.runtimeMaterialization),
              }
            : {}),
        },
        input.ttlSeconds,
        maxTakoformRunLifetime,
      );
    },

    async verifyTakoformRunToken(token) {
      return takoformRunClaims(await open(token, TAKOFORM_RUN_AUDIENCE, maxTakoformRunLifetime));
    },

    async verifyTakoformTenantRunToken(token) {
      return takoformTenantRunClaims(
        await open(token, TAKOFORM_RUN_AUDIENCE, maxTakoformRunLifetime),
      );
    },

    async claimTakoformRunTokenForCreate(token) {
      const claims = takoformRunClaims(
        await open(token, TAKOFORM_RUN_AUDIENCE, maxTakoformRunLifetime),
      );
      if (claims.mode !== "provision") fail("malformed_token");
      await claimReusableCreate(options.sql, clock, claims);
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
async function consume(sql: Sql, clock: Clock, claims: ProvisionTokenClaims): Promise<void> {
  const now = Math.floor(clock().getTime() / 1_000);
  if (claims.expiresAtEpochSeconds <= now) fail("token_expired");
  let claimed: { changes: number };
  try {
    await sql.run(
      `DELETE FROM provision_token_consumptions
       WHERE token_id IN (
         SELECT consumed.token_id
         FROM provision_token_consumptions AS consumed
         LEFT JOIN reservations AS reservation
           ON reservation.id = consumed.reservation_id
          AND reservation.org_id = consumed.organization_id
          AND reservation.tenant_ref = consumed.tenant_ref
         WHERE consumed.expires_at_epoch_seconds <= ?
           AND (reservation.id IS NULL OR reservation.status <> 'active')
         ORDER BY consumed.expires_at_epoch_seconds, consumed.token_id
         LIMIT ?
       )`,
      [now, EXPIRED_REPLAY_DELETE_LIMIT],
    );
    claimed = await sql.run(
      `INSERT OR IGNORE INTO provision_token_consumptions
         (token_id, organization_id, tenant_ref, reservation_id, offering_id,
          offering_digest, expires_at_epoch_seconds, consumed_at_epoch_seconds)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       FROM reservations
       WHERE id = ? AND org_id = ? AND tenant_ref = ?
         AND offering_id = ? AND offering_digest = ? AND status = 'active'`,
      [
        claims.tokenId,
        claims.organizationId,
        claims.tenantRef,
        claims.reservationId,
        claims.offeringId,
        claims.offeringDigest,
        claims.expiresAtEpochSeconds,
        now,
        claims.reservationId,
        claims.organizationId,
        claims.tenantRef,
        claims.offeringId,
        claims.offeringDigest,
      ],
    );
  } catch {
    throw new TokenError("state_unavailable");
  }
  if (claimed.changes !== 1) fail("token_replayed");
}

async function claimReusableCreate(
  sql: Sql,
  clock: Clock,
  claims: TakoformRunTokenClaims,
): Promise<void> {
  const now = Math.floor(clock().getTime() / 1_000);
  if (claims.expiresAtEpochSeconds <= now) fail("token_expired");
  try {
    const claimed = await sql.run(
      `INSERT OR IGNORE INTO provision_token_consumptions
         (token_id, organization_id, tenant_ref, reservation_id, offering_id,
          offering_digest, expires_at_epoch_seconds, consumed_at_epoch_seconds)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       FROM reservations
       WHERE id = ? AND org_id = ? AND tenant_ref = ?
         AND offering_id = ? AND offering_digest = ? AND status = 'active'`,
      [
        claims.tokenId,
        claims.organizationId,
        claims.tenantRef,
        claims.reservationId,
        claims.offeringId,
        claims.offeringDigest,
        claims.expiresAtEpochSeconds,
        now,
        claims.reservationId,
        claims.organizationId,
        claims.tenantRef,
        claims.offeringId,
        claims.offeringDigest,
      ],
    );
    if (claimed.changes === 1) return;

    const rows = await sql.query(
      `SELECT token_id, organization_id, tenant_ref, reservation_id, offering_id, offering_digest
       FROM provision_token_consumptions
       WHERE reservation_id = ? AND organization_id = ? AND tenant_ref = ? LIMIT 1`,
      [claims.reservationId, claims.organizationId, claims.tenantRef],
    );
    const row = rows[0];
    if (
      row?.token_id === claims.tokenId &&
      row.organization_id === claims.organizationId &&
      row.tenant_ref === claims.tenantRef &&
      row.reservation_id === claims.reservationId &&
      row.offering_id === claims.offeringId &&
      row.offering_digest === claims.offeringDigest
    ) {
      return;
    }
  } catch {
    throw new TokenError("state_unavailable");
  }
  fail("token_replayed");
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
    "organizationId",
    "reservationId",
    "tenantRef",
  ]);
  if (!isSha256Digest(payload.offeringDigest)) fail("malformed_token");
  return {
    organizationId: claimReference(payload.organizationId),
    tenantRef: claimReference(payload.tenantRef),
    reservationId: claimReference(payload.reservationId),
    offeringId: claimReference(payload.offeringId),
    offeringDigest: payload.offeringDigest,
    issuedAtEpochSeconds: epochSeconds(payload.iat),
    expiresAtEpochSeconds: epochSeconds(payload.exp),
    tokenId: claimReference(payload.jti),
  };
}

function takoformRunClaims(payload: Record<string, unknown>): TakoformRunTokenClaims {
  exactKeys(payload, [
    "aud",
    "exp",
    "formRef",
    "iat",
    "iss",
    "jti",
    "mode",
    "nbf",
    "offeringDigest",
    "offeringId",
    "organizationId",
    "reservationId",
    "resourceName",
    "resourceUid",
    "tenantRef",
  ]);
  if (!isSha256Digest(payload.offeringDigest)) fail("malformed_token");
  if (payload.mode !== "provision" && payload.mode !== "manage") fail("malformed_token");
  if (typeof payload.resourceName !== "string" || !RESOURCE_NAME.test(payload.resourceName)) {
    fail("malformed_token");
  }
  const resourceUid =
    payload.resourceUid === null
      ? undefined
      : typeof payload.resourceUid === "string" && REFERENCE.test(payload.resourceUid)
        ? payload.resourceUid
        : fail("malformed_token");
  if (
    (payload.mode === "provision" && resourceUid !== undefined) ||
    (payload.mode === "manage" && resourceUid === undefined)
  ) {
    fail("malformed_token");
  }
  return {
    organizationId: claimReference(payload.organizationId),
    tenantRef: claimReference(payload.tenantRef),
    reservationId: claimReference(payload.reservationId),
    offeringId: claimReference(payload.offeringId),
    offeringDigest: payload.offeringDigest,
    formRef: claimedFormRef(payload.formRef),
    resourceName: payload.resourceName,
    mode: payload.mode,
    ...(resourceUid === undefined ? {} : { resourceUid }),
    issuedAtEpochSeconds: epochSeconds(payload.iat),
    expiresAtEpochSeconds: epochSeconds(payload.exp),
    tokenId: claimReference(payload.jti),
  };
}

function takoformTenantRunClaims(payload: Record<string, unknown>): TakoformTenantRunTokenClaims {
  exactKeys(payload, [
    "aud",
    "exp",
    "iat",
    "iss",
    "jti",
    "mode",
    "nbf",
    "organizationId",
    "runRef",
    "spaceRef",
    "tenantRef",
    ...(payload.runtimeMaterialization === undefined ? [] : ["runtimeMaterialization"]),
  ]);
  if (payload.mode !== "tenant-run") fail("malformed_token");
  return {
    organizationId: claimReference(payload.organizationId),
    tenantRef: claimReference(payload.tenantRef),
    spaceRef: claimReference(payload.spaceRef),
    runRef: claimReference(payload.runRef),
    mode: "tenant-run",
    issuedAtEpochSeconds: epochSeconds(payload.iat),
    expiresAtEpochSeconds: epochSeconds(payload.exp),
    tokenId: claimReference(payload.jti),
    ...(payload.runtimeMaterialization === undefined
      ? {}
      : {
          runtimeMaterialization: boundedRuntimeMaterialization(payload.runtimeMaterialization),
        }),
  };
}

function validatedFormRef(value: TakoformV1Alpha3FormRef): TakoformV1Alpha3FormRef {
  return claimedFormRef(value);
}

function claimedFormRef(value: unknown): TakoformV1Alpha3FormRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("malformed_token");
  }
  const formRef = value as Record<string, unknown>;
  exactKeys(formRef, ["apiVersion", "kind", "definitionVersion", "schemaDigest"]);
  if (
    typeof formRef.apiVersion !== "string" ||
    !REFERENCE.test(formRef.apiVersion) ||
    typeof formRef.kind !== "string" ||
    !RESOURCE_NAME.test(formRef.kind) ||
    typeof formRef.definitionVersion !== "string" ||
    !REFERENCE.test(formRef.definitionVersion) ||
    !isSha256Digest(formRef.schemaDigest)
  ) {
    fail("malformed_token");
  }
  return {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    definitionVersion: formRef.definitionVersion,
    schemaDigest: formRef.schemaDigest,
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
  // Loopback over http is permitted so a self-hosted server can be developed
  // against without a certificate. Everything else must be real HTTPS, because
  // the issuer is baked into every token and checked on the way back in.
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
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
