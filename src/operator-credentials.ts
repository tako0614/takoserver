import type { ExternalIdentityVerifier, IdentityProvider } from "./auth.ts";
import { base64UrlDecode } from "./json.ts";
import type { FundingSettlementVerifier } from "./ledger.ts";
import type { Clock } from "./ports.ts";

/**
 * Sign-in and funding, backed by the operator's own signature.
 *
 * Takoserver needs two facts it cannot determine for itself: who a caller is,
 * and how much money arrived. In a finished product those come from an identity
 * provider and a payment provider. Neither is configured yet, and inventing a
 * stub that answers "yes" would be worse than having nothing — it would look
 * like a working product while accepting anyone and crediting any amount.
 *
 * These verifiers are the honest interim: the operator signs an assertion
 * offline with a key whose public half is configured here, and Takoserver
 * accepts exactly what that signature says. It is not an identity provider and
 * it is not a payment provider; it is the operator vouching, in a form the
 * server can check and a third party cannot forge.
 *
 * Assertions are short-lived and single-purpose. A funding assertion names its
 * organization, so one cannot be replayed against another, and its funding
 * reference makes the ledger credit it exactly once no matter how many times it
 * is presented.
 */

const MAX_ASSERTION_BYTES = 8 * 1_024;

export interface OperatorCredentialOptions {
  /** Public half of the operator key, as an Ed25519 JWK. */
  readonly publicKeyJwk: { readonly kty: string; readonly crv: string; readonly x: string };
  readonly clock?: Clock;
  /** Longest an assertion may remain valid after it was issued. */
  readonly maxLifetimeSeconds?: number;
}

export class OperatorAssertionError extends Error {
  constructor(readonly code: "malformed" | "invalid_signature" | "expired" | "wrong_purpose") {
    super(code);
    this.name = "OperatorAssertionError";
  }
}

interface Verified {
  readonly purpose: string;
  readonly claims: Record<string, unknown>;
}

export interface OperatorPurposeVerifier {
  verify(assertion: string, purpose: string): Promise<Readonly<Record<string, unknown>>>;
}

/** Verifies one bounded offline operator assertion without granting product sign-in/funding. */
export function createOperatorPurposeVerifier(
  options: OperatorCredentialOptions,
): OperatorPurposeVerifier {
  const verify = createVerifier(options);
  return {
    async verify(assertion, purpose) {
      return structuredClone((await verify(assertion, purpose)).claims);
    },
  };
}

function createVerifier(options: OperatorCredentialOptions) {
  const clock = options.clock ?? (() => new Date());
  const maxLifetime = options.maxLifetimeSeconds ?? 900;
  let imported: Promise<CryptoKey> | null = null;

  const key = (): Promise<CryptoKey> => {
    imported ??= crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: options.publicKeyJwk.x, key_ops: ["verify"], ext: true },
      "Ed25519",
      false,
      ["verify"],
    );
    return imported;
  };

  return async function verify(assertion: string, purpose: string): Promise<Verified> {
    if (typeof assertion !== "string" || assertion.length > MAX_ASSERTION_BYTES) {
      throw new OperatorAssertionError("malformed");
    }
    const [payloadPart, signaturePart, ...rest] = assertion.split(".");
    if (!payloadPart || !signaturePart || rest.length > 0) {
      throw new OperatorAssertionError("malformed");
    }
    const payloadBytes = base64UrlDecode(payloadPart);
    const signature = base64UrlDecode(signaturePart);
    if (!payloadBytes || !signature) throw new OperatorAssertionError("malformed");

    const verified = await crypto.subtle
      .verify(
        "Ed25519",
        await key(),
        signature as unknown as BufferSource,
        new TextEncoder().encode(payloadPart),
      )
      .catch(() => false);
    if (!verified) throw new OperatorAssertionError("invalid_signature");

    let claims: unknown;
    try {
      claims = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      throw new OperatorAssertionError("malformed");
    }
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
      throw new OperatorAssertionError("malformed");
    }
    const record = claims as Record<string, unknown>;
    if (record.purpose !== purpose) throw new OperatorAssertionError("wrong_purpose");

    const issuedAt = record.iat;
    const expiresAt = record.exp;
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
      throw new OperatorAssertionError("malformed");
    }
    const now = Math.floor(clock().getTime() / 1_000);
    if (
      (expiresAt as number) <= now ||
      (issuedAt as number) > now + 30 ||
      (expiresAt as number) <= (issuedAt as number) ||
      (expiresAt as number) - (issuedAt as number) > maxLifetime
    ) {
      throw new OperatorAssertionError("expired");
    }
    return { purpose, claims: record };
  };
}

/** Accepts a sign-in the operator vouched for. */
export function createOperatorIdentity(
  options: OperatorCredentialOptions,
): ExternalIdentityVerifier {
  const verify = createVerifier(options);
  return {
    async verify({ provider, assertion }) {
      const { claims } = await verify(assertion, "sign-in");
      if (claims.provider !== provider) throw new OperatorAssertionError("wrong_purpose");
      const providerSubject = claims.subject;
      const email = claims.email;
      const displayName = claims.displayName;
      if (
        typeof providerSubject !== "string" ||
        typeof email !== "string" ||
        typeof displayName !== "string"
      ) {
        throw new OperatorAssertionError("malformed");
      }
      return { providerSubject, email, displayName };
    },
  };
}

/** Accepts a wallet credit the operator vouched for. */
export function createOperatorSettlement(
  options: OperatorCredentialOptions,
): FundingSettlementVerifier {
  const verify = createVerifier(options);
  return {
    async verify({ organizationId, settlementProof }) {
      const { claims } = await verify(settlementProof, "funding");
      // The assertion names the organization it credits, so one cannot be
      // redirected at another wallet.
      if (claims.organizationId !== organizationId) {
        throw new OperatorAssertionError("wrong_purpose");
      }
      const fundingRef = claims.fundingRef;
      const amountMinor = claims.amountMinor;
      if (
        typeof fundingRef !== "string" ||
        fundingRef.length === 0 ||
        !Number.isSafeInteger(amountMinor) ||
        (amountMinor as number) <= 0 ||
        claims.currency !== "USD"
      ) {
        throw new OperatorAssertionError("malformed");
      }
      return { fundingRef, amountMinor: amountMinor as number, currency: "USD" };
    },
  };
}

export const OPERATOR_PROVIDERS: readonly IdentityProvider[] = ["google", "github"];
