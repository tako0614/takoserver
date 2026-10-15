import {
  AuthError,
  type ExternalIdentityVerifier,
  type IdentityProviderDescriptor,
} from "./auth.ts";
import { createGoogleIdentity, GOOGLE_IDENTITY_ISSUERS } from "./google-identity.ts";
import { createOperatorIdentity, OPERATOR_PROVIDERS } from "./operator-credentials.ts";
import type { Clock } from "./ports.ts";
import { createTakosIdIdentity } from "./takos-id-identity.ts";

/**
 * Which ways in a deployment offers, and the verifiers behind them.
 *
 * A deployment with a Google client verifies Google ID tokens. One without
 * falls back to the operator vouching by signature, which is a real check but
 * is nobody's idea of browser sign-in. Both can be configured at once, and when
 * they are, the caller says which it used rather than the server guessing from
 * the shape of a string: a guess that lands on the wrong verifier reports a
 * failure about the wrong thing, and a person cannot act on that.
 *
 * The advertised list and the verifiers are built together so they cannot
 * disagree. A console offering a button the server will not honour is the exact
 * failure this exists to prevent.
 */

export type IdentityMethod = IdentityProviderDescriptor["method"];

export interface IdentitySetupOptions {
  /** Exact shared Takos ID issuer and this product's public OIDC client id. */
  readonly takosId?: { readonly issuer: string; readonly clientId: string } | undefined;
  /** Public OAuth client id. Its presence is what turns Google sign-in on. */
  readonly googleClientId?: string | undefined;
  /** Public half of the operator key, as an Ed25519 JWK. */
  readonly operatorPublicKeyJwk?:
    | { readonly kty: string; readonly crv: string; readonly x: string }
    | undefined;
  /** Canonical public Host origin bound into every operator sign-in assertion. */
  readonly operatorAudience?: string | undefined;
  readonly clock?: Clock;
}

export interface IdentitySetup {
  readonly verifier: ExternalIdentityVerifier & IdentityVerificationCaptureReader;
  readonly providers: readonly IdentityProviderDescriptor[];
}

type IdentityVerificationInput = Parameters<ExternalIdentityVerifier["verify"]>[0];
type VerifiedIdentity = Awaited<ReturnType<ExternalIdentityVerifier["verify"]>>;

/** The verifier's selected configuration, not claims supplied by a caller. */
export type IdentityVerificationAuthority =
  | { readonly kind: "takos-id-oidc"; readonly issuer: string; readonly clientId: string }
  | {
      readonly kind: "google-oidc";
      readonly acceptedIssuerPolicy: typeof GOOGLE_IDENTITY_ISSUERS;
      readonly clientId: string;
    }
  | {
      readonly kind: "operator-assertion";
      readonly audience: string;
      readonly publicKeyJwk: { readonly kty: string; readonly crv: string; readonly x: string };
    };

/** Historical verification observation, never a human, class or payer grant. */
export interface IdentityVerificationObservation {
  readonly provider: IdentityVerificationInput["provider"];
  readonly method: IdentityMethod;
  readonly verificationAuthority: IdentityVerificationAuthority;
  readonly providerSubject: string;
  readonly email: string;
  readonly displayName: string;
  readonly assertionDigest: `sha256:${string}`;
  readonly verifiedAt: string;
}

export interface IdentityVerificationCaptureReader {
  /** Runs the selected real verifier once; does not consume single-use credentials. */
  captureVerifiedIdentity(input: IdentityVerificationInput): Promise<{
    readonly verified: VerifiedIdentity;
    readonly capture: object;
  }>;
  inspectVerifiedIdentityCapture(capture: unknown): IdentityVerificationObservation | null;
}

const verificationReaders = new WeakMap<
  object,
  {
    readonly verify: ExternalIdentityVerifier["verify"];
    readonly capture: IdentityVerificationCaptureReader["captureVerifiedIdentity"];
    readonly inspect: IdentityVerificationCaptureReader["inspectVerifiedIdentityCapture"];
  }
>();

/** Local constructor/original-method identity only; no SQL or enrollment proof. */
export function assertIdentityVerificationCaptureReader(reader: unknown): void {
  if (!reader || typeof reader !== "object") throw new AuthError("invalid");
  const origin = verificationReaders.get(reader);
  if (!origin) throw new AuthError("invalid");
  for (const [name, expected] of [
    ["verify", origin.verify],
    ["captureVerifiedIdentity", origin.capture],
    ["inspectVerifiedIdentityCapture", origin.inspect],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(reader, name);
    if (!descriptor || !("value" in descriptor) || descriptor.value !== expected)
      throw new AuthError("invalid");
  }
}

export function resolveIdentity(options: IdentitySetupOptions): IdentitySetup {
  // Read each option once. The same detached values must configure the actual
  // verifier and describe the authority retained by a successful capture.
  const takosIdOption = options.takosId;
  const googleClientId = options.googleClientId;
  const operatorKeyOption = options.operatorPublicKeyJwk;
  const operatorAudience = options.operatorAudience;
  const clock = options.clock;
  if (takosIdOption && googleClientId) {
    throw new TypeError("Takos ID and direct Google sign-in cannot both be configured");
  }
  const byProviderMethod = new Map<string, ExternalIdentityVerifier>();
  const authorityByProviderMethod = new Map<string, IdentityVerificationAuthority>();
  const providers: IdentityProviderDescriptor[] = [];

  if (takosIdOption) {
    const issuer = takosIdOption.issuer;
    const clientId = takosIdOption.clientId;
    byProviderMethod.set(
      "takos-id:oidc",
      createTakosIdIdentity({
        issuer,
        clientId,
        ...(clock ? { clock } : {}),
      }),
    );
    authorityByProviderMethod.set(
      "takos-id:oidc",
      Object.freeze({
        kind: "takos-id-oidc",
        issuer,
        clientId,
      }),
    );
    providers.push({
      id: "takos-id",
      displayName: "Takos ID",
      method: "oidc",
      issuer,
      clientId,
    });
  }

  if (googleClientId) {
    byProviderMethod.set(
      "google:oidc",
      createGoogleIdentity({
        clientId: googleClientId,
        ...(clock ? { clock } : {}),
      }),
    );
    authorityByProviderMethod.set(
      "google:oidc",
      Object.freeze({
        kind: "google-oidc",
        acceptedIssuerPolicy: GOOGLE_IDENTITY_ISSUERS,
        clientId: googleClientId,
      }),
    );
    providers.push({
      id: "google",
      displayName: "Google",
      method: "oidc",
      clientId: googleClientId,
    });
  }

  if (operatorKeyOption) {
    if (!operatorAudience) {
      throw new TypeError("operator identity public JWK requires its canonical Host audience");
    }
    // createOperatorIdentity imports its key lazily. Detach the JWK now so a
    // caller cannot change the key between construction and first verify.
    // The operator verifier imports an Ed25519 OKP key from x; its input
    // kty/crv fields are not consulted. Record the effective import policy.
    const publicKeyJwk = Object.freeze({
      kty: "OKP",
      crv: "Ed25519",
      x: operatorKeyOption.x,
    });
    const authority = Object.freeze({
      kind: "operator-assertion" as const,
      audience: operatorAudience,
      publicKeyJwk,
    });
    const operator = createOperatorIdentity({
      publicKeyJwk,
      audience: operatorAudience,
      ...(clock ? { clock } : {}),
    });
    // One registration per provider an operator assertion may vouch for, read
    // from the single declaration of that set rather than written out here.
    // The assertion itself names its provider and is refused when it does not
    // match the one the caller asked for, so registering the whole set widens
    // which accounts can be reached, not what any one assertion can claim.
    for (const provider of OPERATOR_PROVIDERS) {
      byProviderMethod.set(`${provider}:operator-assertion`, operator);
      authorityByProviderMethod.set(`${provider}:operator-assertion`, authority);
    }
    // Advertised only when there is no real provider, because it is not
    // sign-in — it is the operator vouching by signature, and it asks a person
    // to paste a token they had to generate elsewhere. Once Google is
    // configured, one button is the whole of the way in.
    //
    // It keeps working on the wire either way, named explicitly. That is
    // deliberate: it is how the operator gets in when the identity provider is
    // misconfigured, which is exactly when nobody can sign in the normal way.
    if (!googleClientId && !takosIdOption) {
      for (const provider of OPERATOR_PROVIDERS) {
        providers.push({
          id: provider,
          displayName: "Operator assertion",
          method: "operator-assertion",
        });
      }
    }
  }

  const fallback = providers[0]?.method;

  const captures = new WeakMap<object, IdentityVerificationObservation>();
  const observationClock = clock ?? (() => new Date());
  const verifier: ExternalIdentityVerifier & IdentityVerificationCaptureReader = {
    async verify(input) {
      const method = input.method ?? fallback;
      const verifier =
        method === undefined ? undefined : byProviderMethod.get(`${input.provider}:${method}`);
      // A provider or method this deployment does not verify is something
      // the caller can correct. Thrown as an AuthError so it lands as a
      // stable 4xx: an unhandled throw here reached the router's
      // catch-all and answered `internal_error` with status 500, which
      // reads as an outage and tells nobody what to fix.
      if (!verifier) throw new AuthError("invalid");
      return await verifier.verify(input);
    },
    async captureVerifiedIdentity(input) {
      assertIdentityVerificationCaptureReader(verifier);
      // Freeze this invocation's original inputs before any await. Retain no
      // assertion, nonce, bearer or single-use credential in the observation.
      const captured = Object.freeze({
        provider: input.provider,
        assertion: input.assertion,
        method: input.method,
        nonce: input.nonce,
        audience: input.audience,
      });
      const method = captured.method ?? fallback;
      if (method === undefined) throw new AuthError("invalid");
      const verificationAuthority = authorityByProviderMethod.get(`${captured.provider}:${method}`);
      if (!verificationAuthority) throw new AuthError("invalid");
      // Never dispatch through a public method reread after caller getters.
      const verify = verificationReaders.get(verifier)?.verify;
      if (!verify) throw new AuthError("invalid");
      assertIdentityVerificationCaptureReader(verifier);
      const verified = await Reflect.apply(verify, verifier, [captured]);
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(captured.assertion)),
      );
      const assertionDigest: `sha256:${string}` = `sha256:${Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`;
      const verifiedAt = observationClock().toISOString();
      const observation = Object.freeze({
        provider: captured.provider,
        method,
        verificationAuthority,
        providerSubject: verified.providerSubject,
        email: verified.email,
        displayName: verified.displayName,
        assertionDigest,
        verifiedAt,
      });
      // Recheck after verification, hashing and the supplied clock callback.
      assertIdentityVerificationCaptureReader(verifier);
      const capture = Object.freeze(Object.create(null) as object);
      captures.set(capture, observation);
      return Object.freeze({ verified, capture });
    },
    inspectVerifiedIdentityCapture(capture) {
      assertIdentityVerificationCaptureReader(verifier);
      return capture && typeof capture === "object" ? (captures.get(capture) ?? null) : null;
    },
  };
  verificationReaders.set(verifier, {
    verify: verifier.verify,
    capture: verifier.captureVerifiedIdentity,
    inspect: verifier.inspectVerifiedIdentityCapture,
  });
  return { providers, verifier };
}
