import { base64UrlEncode } from "./json.ts";
import type { Clock } from "./ports.ts";
import type { SigningKey } from "./token.ts";

const TOKEN_TYPE = "takoserver-token+jwt";
const TAKOFORM_RUN_AUDIENCE = "takoform.run";
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const MAX_CREDENTIAL_LIFETIME_SECONDS = 300;

export interface SponsorshipCredentialIssuer {
  issue(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly spaceRef: string;
    readonly runRef: string;
    readonly workerEndpointOriginReservationId?: string;
    readonly issuedAtEpochSeconds: number;
    readonly tokenId: string;
    readonly ttlSeconds: number;
  }): Promise<{ readonly token: string; readonly expiresAt: string }>;
}

export interface SponsorshipCredentialSigningKey extends SigningKey {
  readonly publicJwk: {
    readonly kty: "OKP";
    readonly crv: "Ed25519";
    readonly x: string;
  };
}

/** Load only the authority-specific private key and retain its pinned public half. */
export async function loadSponsorshipCredentialSigningKey(
  keyId: string | undefined,
  raw: string | undefined,
): Promise<SponsorshipCredentialSigningKey | undefined> {
  if (!keyId || !raw) return undefined;
  if (!KEY_ID.test(keyId)) {
    throw new TypeError("sponsorship credential signing key is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("sponsorship credential signing key is invalid");
  }
  if (
    !record(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["crv", "d", "ext", "key_ops", "kty", "x"]) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    value.ext !== true ||
    !Array.isArray(value.key_ops) ||
    value.key_ops.length !== 1 ||
    value.key_ops[0] !== "sign" ||
    typeof value.x !== "string" ||
    typeof value.d !== "string" ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value.x) ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value.d)
  ) {
    throw new TypeError("sponsorship credential signing key is invalid");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    value as unknown as JsonWebKey,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return {
    keyId,
    privateKey,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: value.x },
  };
}

/**
 * The only tenant-run signer.
 *
 * This module is reachable from the route-less sponsorship entrypoint and is
 * deliberately absent from the public Worker import closure. Ordinary
 * TokenService instances can verify an admitted credential but cannot mint
 * one, even when they hold the public runtime signing key.
 */
export function createSponsorshipCredentialIssuer(options: {
  readonly issuer: string;
  readonly signingKey: SigningKey;
  readonly clock: Clock;
}): SponsorshipCredentialIssuer {
  const issuer = httpsOrigin(options.issuer);
  const key = options.signingKey;
  if (!KEY_ID.test(key.keyId)) throw new TypeError("sponsorship credential key id is invalid");
  if (key.privateKey.type !== "private" || !key.privateKey.usages.includes("sign")) {
    throw new TypeError("an Ed25519 sponsorship credential signing key is required");
  }

  return {
    async issue(input) {
      const ttlSeconds = positiveInteger(input.ttlSeconds);
      if (ttlSeconds > MAX_CREDENTIAL_LIFETIME_SECONDS) {
        throw new TypeError("sponsorship credential lifetime is invalid");
      }
      const now = Math.floor(options.clock().getTime() / 1_000);
      if (
        !Number.isSafeInteger(input.issuedAtEpochSeconds) ||
        input.issuedAtEpochSeconds < 0 ||
        input.issuedAtEpochSeconds > now
      ) {
        throw new TypeError("sponsorship credential issuance instant is invalid");
      }
      const expiresAtEpochSeconds = input.issuedAtEpochSeconds + ttlSeconds;
      const header = encode({ alg: "EdDSA", kid: key.keyId, typ: TOKEN_TYPE });
      const payload = encode({
        aud: TAKOFORM_RUN_AUDIENCE,
        exp: expiresAtEpochSeconds,
        iat: input.issuedAtEpochSeconds,
        iss: issuer,
        jti: reference(input.tokenId),
        mode: "tenant-run",
        nbf: input.issuedAtEpochSeconds,
        organizationId: reference(input.organizationId),
        runRef: reference(input.runRef),
        spaceRef: reference(input.spaceRef),
        tenantRef: reference(input.tenantRef),
        ...(input.workerEndpointOriginReservationId === undefined
          ? {}
          : {
              workerEndpointOriginReservationId: reference(input.workerEndpointOriginReservationId),
            }),
      });
      const signingInput = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        "Ed25519",
        key.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return {
        token: `${signingInput}.${base64UrlEncode(signature)}`,
        expiresAt: new Date(expiresAtEpochSeconds * 1_000).toISOString(),
      };
    },
  };
}

function encode(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw new TypeError("sponsorship credential issuer must be an HTTPS origin");
  }
  return url.origin;
}

function reference(value: string): string {
  if (!REFERENCE.test(value)) throw new TypeError("sponsorship credential reference is invalid");
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("sponsorship credential lifetime is invalid");
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
