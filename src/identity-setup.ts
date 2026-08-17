import type { ExternalIdentityVerifier, IdentityProviderDescriptor } from "./auth.ts";
import { createGoogleIdentity } from "./google-identity.ts";
import { createOperatorIdentity } from "./operator-credentials.ts";
import type { Clock } from "./ports.ts";

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
  /** Public OAuth client id. Its presence is what turns Google sign-in on. */
  readonly googleClientId?: string | undefined;
  /** Public half of the operator key, as an Ed25519 JWK. */
  readonly operatorPublicKeyJwk?:
    | { readonly kty: string; readonly crv: string; readonly x: string }
    | undefined;
  readonly clock?: Clock;
}

export interface IdentitySetup {
  readonly verifier: ExternalIdentityVerifier;
  readonly providers: readonly IdentityProviderDescriptor[];
}

export function resolveIdentity(options: IdentitySetupOptions): IdentitySetup {
  const byMethod = new Map<IdentityMethod, ExternalIdentityVerifier>();
  const providers: IdentityProviderDescriptor[] = [];

  if (options.googleClientId) {
    byMethod.set(
      "oidc",
      createGoogleIdentity({
        clientId: options.googleClientId,
        ...(options.clock ? { clock: options.clock } : {}),
      }),
    );
    providers.push({
      id: "google",
      displayName: "Google",
      method: "oidc",
      clientId: options.googleClientId,
    });
  }

  if (options.operatorPublicKeyJwk) {
    byMethod.set(
      "operator-assertion",
      createOperatorIdentity({
        publicKeyJwk: options.operatorPublicKeyJwk,
        ...(options.clock ? { clock: options.clock } : {}),
      }),
    );
    // Advertised only when there is no real provider, because it is not
    // sign-in — it is the operator vouching by signature, and it asks a person
    // to paste a token they had to generate elsewhere. Once Google is
    // configured, one button is the whole of the way in.
    //
    // It keeps working on the wire either way, named explicitly. That is
    // deliberate: it is how the operator gets in when the identity provider is
    // misconfigured, which is exactly when nobody can sign in the normal way.
    if (!options.googleClientId) {
      providers.push({
        id: "google",
        displayName: "Operator assertion",
        method: "operator-assertion",
      });
    }
  }

  const fallback = providers[0]?.method;

  return {
    providers,
    verifier: {
      async verify(input) {
        const method = input.method ?? fallback;
        const verifier = method === undefined ? undefined : byMethod.get(method);
        if (!verifier) throw new Error("no identity provider is configured for that method");
        return await verifier.verify(input);
      },
    },
  };
}
