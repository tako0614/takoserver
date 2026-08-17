import type { ExternalIdentityVerifier } from "./auth.ts";
import { base64UrlDecode } from "./json.ts";
import type { Clock } from "./ports.ts";

/**
 * Sign-in with a real identity provider.
 *
 * Google hands the browser an ID token — an RS256 JWT it signed — and this
 * verifies it here rather than trusting anything the browser says about itself.
 * That means the whole check, not a subset: the signature against Google's
 * published keys, the issuer, the audience, and the expiry. Skipping any one of
 * them turns the token into a claim anybody can mint.
 *
 * The audience check is the one that is easy to leave out and the one that
 * matters most. A valid Google ID token issued to *some other application* is
 * still a valid Google ID token; without checking that it was issued to us, any
 * site a person has ever signed into could hand us a token and be believed.
 *
 * No client secret is involved. This is the ID-token half of OAuth, where the
 * browser obtains the token and the server verifies it — there is nothing to
 * exchange, so there is no secret to keep.
 */

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_TOKEN_BYTES = 8 * 1_024;
/** How long a fetched key set is reused before being fetched again. */
const KEY_CACHE_MILLISECONDS = 60 * 60 * 1_000;
/** Tolerance for clock skew between Google and this server. */
const SKEW_SECONDS = 60;

export type GoogleIdentityErrorCode =
  | "malformed"
  | "unknown_key"
  | "invalid_signature"
  | "expired"
  | "wrong_audience"
  | "wrong_issuer"
  | "unverified_email"
  | "keys_unavailable";

export class GoogleIdentityError extends Error {
  constructor(readonly code: GoogleIdentityErrorCode) {
    super(code);
    this.name = "GoogleIdentityError";
  }
}

export interface GoogleIdentityOptions {
  /** The OAuth client id this deployment issues sign-ins for. */
  readonly clientId: string;
  readonly clock?: Clock;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly jwksUrl?: string;
}

interface JsonWebKey {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
}

export function createGoogleIdentity(options: GoogleIdentityOptions): ExternalIdentityVerifier {
  const now = options.clock ?? (() => new Date());
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const jwksUrl = options.jwksUrl ?? GOOGLE_JWKS_URL;

  let keys: { readonly fetchedAt: number; readonly byKid: Map<string, CryptoKey> } | null = null;

  const load = async (force: boolean): Promise<Map<string, CryptoKey>> => {
    const at = now().getTime();
    if (!force && keys && at - keys.fetchedAt < KEY_CACHE_MILLISECONDS) return keys.byKid;
    let response: Response;
    try {
      response = await send(new Request(jwksUrl, { headers: { accept: "application/json" } }));
    } catch {
      throw new GoogleIdentityError("keys_unavailable");
    }
    if (!response.ok) throw new GoogleIdentityError("keys_unavailable");
    const body = (await response.json().catch(() => null)) as {
      keys?: readonly JsonWebKey[];
    } | null;
    if (!body || !Array.isArray(body.keys)) throw new GoogleIdentityError("keys_unavailable");

    const byKid = new Map<string, CryptoKey>();
    for (const key of body.keys) {
      if (key.kty !== "RSA" || typeof key.kid !== "string" || !key.n || !key.e) continue;
      const imported = await crypto.subtle
        .importKey(
          "jwk",
          { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        )
        .catch(() => null);
      if (imported) byKid.set(key.kid, imported);
    }
    if (byKid.size === 0) throw new GoogleIdentityError("keys_unavailable");
    keys = { fetchedAt: at, byKid };
    return byKid;
  };

  return {
    async verify({ provider, assertion }) {
      if (provider !== "google") throw new GoogleIdentityError("wrong_issuer");
      if (assertion.length > MAX_TOKEN_BYTES) throw new GoogleIdentityError("malformed");

      const parts = assertion.split(".");
      if (parts.length !== 3) throw new GoogleIdentityError("malformed");
      const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

      const header = decodeJson(encodedHeader);
      const claims = decodeJson(encodedPayload);
      if (header.alg !== "RS256" || typeof header.kid !== "string") {
        throw new GoogleIdentityError("malformed");
      }

      // Google rotates its keys, so a kid this server has never seen is the
      // ordinary case after a rotation rather than an attack. It is worth one
      // re-fetch, and exactly one: retrying forever on an invented kid would
      // let a caller drive requests to Google at will.
      let byKid = await load(false);
      let key = byKid.get(header.kid);
      if (!key) {
        byKid = await load(true);
        key = byKid.get(header.kid);
      }
      if (!key) throw new GoogleIdentityError("unknown_key");

      const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
      // The decoder is strict: it refuses any encoding that is not the
      // canonical one, so a re-encoded signature is a malformed token rather
      // than a second spelling of a valid one.
      const signature = base64UrlDecode(encodedSignature);
      if (!signature) throw new GoogleIdentityError("malformed");
      const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature as unknown as BufferSource,
        signed as unknown as BufferSource,
      );
      if (!valid) throw new GoogleIdentityError("invalid_signature");

      if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) {
        throw new GoogleIdentityError("wrong_issuer");
      }
      // A token issued to another application is a genuine Google token and
      // says nothing about whether its holder meant to sign in here.
      const audience = claims.aud;
      if (typeof audience !== "string" || audience !== options.clientId) {
        throw new GoogleIdentityError("wrong_audience");
      }
      const seconds = Math.floor(now().getTime() / 1_000);
      if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < seconds) {
        throw new GoogleIdentityError("expired");
      }
      if (typeof claims.iat === "number" && claims.iat - SKEW_SECONDS > seconds) {
        throw new GoogleIdentityError("expired");
      }
      if (typeof claims.sub !== "string" || claims.sub === "") {
        throw new GoogleIdentityError("malformed");
      }
      // An unverified address is a string the account holder typed, and this
      // product keys nothing on it — but it is shown to other people, so a
      // claim Google itself will not stand behind is not accepted.
      if (typeof claims.email !== "string" || claims.email_verified !== true) {
        throw new GoogleIdentityError("unverified_email");
      }

      const name =
        typeof claims.name === "string" && claims.name !== "" ? claims.name : claims.email;
      return {
        providerSubject: claims.sub,
        email: claims.email,
        displayName: name.slice(0, 128),
      };
    },
  };
}

function decodeJson(segment: string): Record<string, unknown> {
  const bytes = base64UrlDecode(segment);
  if (!bytes) throw new GoogleIdentityError("malformed");
  const text = new TextDecoder().decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GoogleIdentityError("malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GoogleIdentityError("malformed");
  }
  return value as Record<string, unknown>;
}
