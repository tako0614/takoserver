import type { Clock } from "./ports.ts";
import {
  createTenantRunCredentialSigner,
  type TenantRunCredentialSigner,
} from "./tenant-run-credential.ts";
import type { SigningKey } from "./token.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;

export interface SponsorshipCredentialIssuer extends TenantRunCredentialSigner {}

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
 * Hosted sponsorship's wrapper over the shared private tenant-run grammar.
 *
 * This module is reachable from the route-less sponsorship entrypoint and is
 * deliberately absent from the public Worker import closure. Its ledger and
 * receipt authority remain in `sponsorship-authority.ts`; sharing the JWT
 * grammar does not share either authority decision.
 */
export function createSponsorshipCredentialIssuer(options: {
  readonly issuer: string;
  readonly signingKey: SigningKey;
  readonly clock: Clock;
}): SponsorshipCredentialIssuer {
  return createTenantRunCredentialSigner({
    ...options,
    errorLabel: "sponsorship credential",
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
