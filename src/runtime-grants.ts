export type ExecutionOperation =
  | "resource.provision"
  | "resource.delete"
  | "ai.invoke"
  | "s3.access";

export interface ExecutionGrantClaims {
  readonly issuer: string;
  readonly audience: string;
  readonly securityDomainId: string;
  readonly tenantRef: string;
  readonly reservationId: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
  readonly operation: ExecutionOperation;
  readonly intentDigest: `sha256:${string}`;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly grantId: string;
}

export interface ExecutionGrantSigner {
  issue(input: {
    readonly audience: string;
    readonly securityDomainId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
    readonly offeringId: string;
    readonly offeringDigest: `sha256:${string}`;
    readonly operation: ExecutionOperation;
    readonly intentDigest: `sha256:${string}`;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly grantId: string;
  }): Promise<string>;
}

export interface GrantReplayStore {
  consume(input: {
    readonly grantId: string;
    readonly expiresAtEpochSeconds: number;
    readonly nowEpochSeconds: number;
  }): boolean | Promise<boolean>;
}

export class InMemoryGrantReplayStore implements GrantReplayStore {
  readonly #consumed = new Map<string, number>();

  consume(input: {
    readonly grantId: string;
    readonly expiresAtEpochSeconds: number;
    readonly nowEpochSeconds: number;
  }): boolean {
    for (const [grantId, expiresAt] of this.#consumed) {
      if (expiresAt <= input.nowEpochSeconds) this.#consumed.delete(grantId);
    }
    if (this.#consumed.has(input.grantId)) return false;
    this.#consumed.set(input.grantId, input.expiresAtEpochSeconds);
    return true;
  }
}

export type GrantVerificationErrorCode =
  | "malformed_grant"
  | "unknown_key"
  | "invalid_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_operation"
  | "wrong_intent"
  | "wrong_tenant"
  | "grant_not_yet_valid"
  | "grant_expired"
  | "grant_lifetime_exceeded"
  | "grant_replayed";

export class GrantVerificationError extends Error {
  constructor(readonly code: GrantVerificationErrorCode) {
    super(code);
    this.name = "GrantVerificationError";
  }
}

interface WireClaims {
  readonly iss: string;
  readonly aud: string;
  readonly securityDomainId: string;
  readonly tenantRef: string;
  readonly reservationId: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
  readonly operation: ExecutionOperation;
  readonly intentDigest: `sha256:${string}`;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
}

const GRANT_TYPE = "takoserver-execution-grant+jwt";
const TOKEN_PART = /^[A-Za-z0-9_-]+$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const OPERATIONS: readonly ExecutionOperation[] = [
  "resource.provision",
  "resource.delete",
  "ai.invoke",
  "s3.access",
];

export function createExecutionGrantSigner(options: {
  readonly issuer: string;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly maxLifetimeSeconds?: number;
}): ExecutionGrantSigner {
  const issuer = absoluteOrigin(options.issuer);
  const keyId = reference(options.keyId);
  const maxLifetimeSeconds = positiveInteger(options.maxLifetimeSeconds ?? 300);
  if (options.privateKey.type !== "private" || !options.privateKey.usages.includes("sign")) {
    throw new TypeError("an Ed25519 signing key is required");
  }

  return {
    async issue(input): Promise<string> {
      const issuedAtEpochSeconds = epochSeconds(input.issuedAt);
      const expiresAtEpochSeconds = epochSeconds(input.expiresAt);
      if (
        expiresAtEpochSeconds <= issuedAtEpochSeconds ||
        expiresAtEpochSeconds - issuedAtEpochSeconds > maxLifetimeSeconds
      ) {
        throw new TypeError("grant lifetime is invalid");
      }
      const header = encodeJson({ alg: "EdDSA", kid: keyId, typ: GRANT_TYPE });
      const claims: WireClaims = {
        iss: issuer,
        aud: reference(input.audience),
        securityDomainId: reference(input.securityDomainId),
        tenantRef: reference(input.tenantRef),
        reservationId: reference(input.reservationId),
        offeringId: reference(input.offeringId),
        offeringDigest: sha256Digest(input.offeringDigest),
        operation: operation(input.operation),
        intentDigest: sha256Digest(input.intentDigest),
        iat: issuedAtEpochSeconds,
        nbf: issuedAtEpochSeconds,
        exp: expiresAtEpochSeconds,
        jti: reference(input.grantId),
      };
      const payload = encodeJson(claims);
      const signingInput = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        "Ed25519",
        options.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
    },
  };
}

export interface RuntimeGrantVerifier {
  verifyAndConsume(
    token: string,
    expected?: {
      readonly operation?: ExecutionOperation;
      readonly tenantRef?: string;
      readonly securityDomainId?: string;
      readonly intentDigest?: `sha256:${string}`;
    },
  ): Promise<ExecutionGrantClaims>;
}

export function createRuntimeGrantVerifier(options: {
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeys: ReadonlyMap<string, CryptoKey>;
  readonly replayStore: GrantReplayStore;
  readonly clock?: () => Date;
  readonly maxLifetimeSeconds?: number;
}): RuntimeGrantVerifier {
  const issuer = absoluteOrigin(options.issuer);
  const audience = reference(options.audience);
  const clock = options.clock ?? (() => new Date());
  const maxLifetimeSeconds = positiveInteger(options.maxLifetimeSeconds ?? 300);
  if (options.publicKeys.size === 0)
    throw new TypeError("at least one grant public key is required");
  if (!options.replayStore || typeof options.replayStore.consume !== "function") {
    throw new TypeError("a replay store is required");
  }

  return {
    async verifyAndConsume(token, expected = {}): Promise<ExecutionGrantClaims> {
      if (typeof token !== "string" || token.length > 16_384) fail("malformed_grant");
      const parts = token.split(".");
      if (parts.length !== 3) fail("malformed_grant");
      const [headerPart, payloadPart, signaturePart] = parts;
      if (!headerPart || !payloadPart || !signaturePart) fail("malformed_grant");
      const header = decodeExactRecord(headerPart, ["alg", "kid", "typ"]);
      if (header.alg !== "EdDSA" || header.typ !== GRANT_TYPE || typeof header.kid !== "string") {
        fail("malformed_grant");
      }
      const publicKey = options.publicKeys.get(header.kid);
      if (!publicKey) fail("unknown_key");
      const signature = decodePart(signaturePart);
      const verified = await crypto.subtle
        .verify(
          "Ed25519",
          publicKey,
          signature,
          new TextEncoder().encode(`${headerPart}.${payloadPart}`),
        )
        .catch(() => false);
      if (!verified) fail("invalid_signature");

      const wire = wireClaims(
        decodeExactRecord(payloadPart, [
          "aud",
          "exp",
          "iat",
          "intentDigest",
          "iss",
          "jti",
          "nbf",
          "offeringDigest",
          "offeringId",
          "operation",
          "reservationId",
          "securityDomainId",
          "tenantRef",
        ]),
      );
      if (wire.iss !== issuer) fail("wrong_issuer");
      if (wire.aud !== audience) fail("wrong_audience");
      if (expected.operation !== undefined && wire.operation !== expected.operation) {
        fail("wrong_operation");
      }
      if (expected.intentDigest !== undefined && wire.intentDigest !== expected.intentDigest) {
        fail("wrong_intent");
      }
      if (expected.tenantRef !== undefined && wire.tenantRef !== expected.tenantRef) {
        fail("wrong_tenant");
      }
      if (
        expected.securityDomainId !== undefined &&
        wire.securityDomainId !== expected.securityDomainId
      ) {
        fail("wrong_tenant");
      }
      const now = epochSeconds(clock());
      if (wire.iat > now || wire.nbf > now) fail("grant_not_yet_valid");
      if (now >= wire.exp) fail("grant_expired");
      if (wire.exp - wire.iat > maxLifetimeSeconds) fail("grant_lifetime_exceeded");
      const consumed = await options.replayStore.consume({
        grantId: wire.jti,
        expiresAtEpochSeconds: wire.exp,
        nowEpochSeconds: now,
      });
      if (!consumed) fail("grant_replayed");
      return {
        issuer: wire.iss,
        audience: wire.aud,
        securityDomainId: wire.securityDomainId,
        tenantRef: wire.tenantRef,
        reservationId: wire.reservationId,
        offeringId: wire.offeringId,
        offeringDigest: wire.offeringDigest,
        operation: wire.operation,
        intentDigest: wire.intentDigest,
        issuedAtEpochSeconds: wire.iat,
        expiresAtEpochSeconds: wire.exp,
        grantId: wire.jti,
      };
    },
  };
}

function wireClaims(value: Record<string, unknown>): WireClaims {
  if (
    typeof value.iss !== "string" ||
    typeof value.aud !== "string" ||
    typeof value.securityDomainId !== "string" ||
    typeof value.tenantRef !== "string" ||
    typeof value.reservationId !== "string" ||
    typeof value.offeringId !== "string" ||
    typeof value.offeringDigest !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.intentDigest !== "string" ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.nbf) ||
    !Number.isSafeInteger(value.exp) ||
    typeof value.jti !== "string"
  ) {
    fail("malformed_grant");
  }
  try {
    return {
      iss: absoluteOrigin(value.iss),
      aud: reference(value.aud),
      securityDomainId: reference(value.securityDomainId),
      tenantRef: reference(value.tenantRef),
      reservationId: reference(value.reservationId),
      offeringId: reference(value.offeringId),
      offeringDigest: sha256Digest(value.offeringDigest),
      operation: operation(value.operation),
      intentDigest: sha256Digest(value.intentDigest),
      iat: value.iat as number,
      nbf: value.nbf as number,
      exp: value.exp as number,
      jti: reference(value.jti),
    };
  } catch {
    fail("malformed_grant");
  }
}

export async function executionIntentDigest(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256Digest(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError("invalid intent digest");
  return value as `sha256:${string}`;
}

function decodeExactRecord(part: string, expectedKeys: readonly string[]): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(decodePart(part)).toString("utf8"));
  } catch {
    fail("malformed_grant");
  }
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expectedKeys].sort())
  ) {
    fail("malformed_grant");
  }
  return value;
}

function decodePart(part: string): ArrayBuffer {
  if (!TOKEN_PART.test(part)) fail("malformed_grant");
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) fail("malformed_grant");
  return Uint8Array.from(bytes).buffer;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function absoluteOrigin(value: string): string {
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

function reference(value: string): string {
  if (typeof value !== "string" || !REFERENCE.test(value)) throw new TypeError("invalid reference");
  return value;
}

function operation(value: string): ExecutionOperation {
  if (!OPERATIONS.includes(value as ExecutionOperation)) throw new TypeError("invalid operation");
  return value as ExecutionOperation;
}

function epochSeconds(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("invalid time");
  return Math.floor(milliseconds / 1_000);
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("positive integer required");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: GrantVerificationErrorCode): never {
  throw new GrantVerificationError(code);
}
