import type { ExternalIdentityVerifier } from "./auth.ts";
import { base64UrlDecode } from "./json.ts";
import type { Clock } from "./ports.ts";

const MAX_TOKEN_BYTES = 16 * 1_024;
const CACHE_MILLISECONDS = 60 * 60 * 1_000;
const SKEW_SECONDS = 60;

export type TakosIdIdentityErrorCode =
  | "malformed"
  | "discovery_unavailable"
  | "keys_unavailable"
  | "unknown_key"
  | "invalid_signature"
  | "expired"
  | "wrong_audience"
  | "wrong_issuer"
  | "unverified_email";

export class TakosIdIdentityError extends Error {
  constructor(readonly code: TakosIdIdentityErrorCode) {
    super(code);
    this.name = "TakosIdIdentityError";
  }
}

export interface TakosIdIdentityOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clock?: Clock;
  readonly fetch?: (request: Request) => Promise<Response>;
}

interface CachedKeys {
  readonly fetchedAt: number;
  readonly byKid: ReadonlyMap<string, CryptoKey>;
}

export function createTakosIdIdentity(options: TakosIdIdentityOptions): ExternalIdentityVerifier {
  const issuer = exactIssuer(options.issuer);
  const clientId = boundedString(options.clientId, 1, 128);
  const clock = options.clock ?? (() => new Date());
  const send = options.fetch ?? ((request: Request) => fetch(request));
  let cached: CachedKeys | null = null;

  const keys = async (force: boolean): Promise<ReadonlyMap<string, CryptoKey>> => {
    const at = clock().getTime();
    if (!force && cached && at - cached.fetchedAt < CACHE_MILLISECONDS) return cached.byKid;
    let discoveryResponse: Response;
    try {
      discoveryResponse = await send(
        new Request(`${issuer}/.well-known/openid-configuration`, {
          headers: { accept: "application/json" },
        }),
      );
    } catch {
      throw new TakosIdIdentityError("discovery_unavailable");
    }
    if (!discoveryResponse.ok) throw new TakosIdIdentityError("discovery_unavailable");
    const discovery = (await discoveryResponse.json().catch(() => null)) as {
      readonly issuer?: unknown;
      readonly jwks_uri?: unknown;
    } | null;
    if (discovery?.issuer !== issuer || discovery.jwks_uri !== `${issuer}/.well-known/jwks.json`) {
      throw new TakosIdIdentityError("wrong_issuer");
    }

    let jwksResponse: Response;
    try {
      jwksResponse = await send(
        new Request(discovery.jwks_uri, { headers: { accept: "application/json" } }),
      );
    } catch {
      throw new TakosIdIdentityError("keys_unavailable");
    }
    if (!jwksResponse.ok) throw new TakosIdIdentityError("keys_unavailable");
    const body = (await jwksResponse.json().catch(() => null)) as {
      readonly keys?: readonly JsonWebKey[];
    } | null;
    if (!body || !Array.isArray(body.keys)) throw new TakosIdIdentityError("keys_unavailable");

    const byKid = new Map<string, CryptoKey>();
    for (const jwk of body.keys) {
      if (
        jwk.kty !== "EC" ||
        jwk.crv !== "P-256" ||
        jwk.alg !== "ES256" ||
        jwk.use !== "sig" ||
        typeof jwk.kid !== "string" ||
        !jwk.x ||
        !jwk.y
      ) {
        continue;
      }
      const key = await crypto.subtle
        .importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
        .catch(() => null);
      if (key) byKid.set(jwk.kid, key);
    }
    if (byKid.size === 0) throw new TakosIdIdentityError("keys_unavailable");
    cached = { fetchedAt: at, byKid };
    return byKid;
  };

  return {
    async verify(input) {
      if (input.provider !== "takos-id" || input.method !== "oidc") {
        throw new TakosIdIdentityError("wrong_issuer");
      }
      if (input.assertion.length === 0 || input.assertion.length > MAX_TOKEN_BYTES) {
        throw new TakosIdIdentityError("malformed");
      }
      const segments = input.assertion.split(".");
      if (segments.length !== 3) throw new TakosIdIdentityError("malformed");
      const [encodedHeader, encodedPayload, encodedSignature] = segments as [
        string,
        string,
        string,
      ];
      const header = decodedObject(encodedHeader);
      const claims = decodedObject(encodedPayload);
      if (header.alg !== "ES256" || typeof header.kid !== "string") {
        throw new TakosIdIdentityError("malformed");
      }
      let byKid = await keys(false);
      let key = byKid.get(header.kid);
      if (!key) {
        byKid = await keys(true);
        key = byKid.get(header.kid);
      }
      if (!key) throw new TakosIdIdentityError("unknown_key");
      const signature = base64UrlDecode(encodedSignature);
      if (!signature) throw new TakosIdIdentityError("malformed");
      const verified = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature as unknown as BufferSource,
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      );
      if (!verified) throw new TakosIdIdentityError("invalid_signature");
      if (claims.iss !== issuer) throw new TakosIdIdentityError("wrong_issuer");
      if (claims.aud !== clientId) throw new TakosIdIdentityError("wrong_audience");
      const now = Math.floor(clock().getTime() / 1_000);
      if (
        typeof claims.exp !== "number" ||
        claims.exp + SKEW_SECONDS < now ||
        (typeof claims.iat === "number" && claims.iat - SKEW_SECONDS > now)
      ) {
        throw new TakosIdIdentityError("expired");
      }
      if (
        typeof claims.sub !== "string" ||
        claims.sub.length === 0 ||
        typeof claims.email !== "string" ||
        claims.email_verified !== true
      ) {
        throw new TakosIdIdentityError(
          claims.email_verified === false ? "unverified_email" : "malformed",
        );
      }
      return {
        providerSubject: boundedString(claims.sub, 1, 256),
        email: boundedString(claims.email, 3, 320),
        displayName:
          typeof claims.name === "string" && claims.name.length > 0
            ? boundedString(claims.name, 1, 128)
            : claims.email,
        ...(claims.organizations === undefined
          ? {}
          : { organizations: organizationClaims(claims.organizations) }),
      };
    },
  };
}

function decodedObject(segment: string): Record<string, unknown> {
  const bytes = base64UrlDecode(segment);
  if (!bytes) throw new TakosIdIdentityError("malformed");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new TakosIdIdentityError("malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TakosIdIdentityError("malformed");
  }
  return value as Record<string, unknown>;
}

function organizationClaims(
  value: unknown,
): readonly { id: string; name: string; role: "owner" | "member" }[] {
  if (!Array.isArray(value) || value.length > 100) throw new TakosIdIdentityError("malformed");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TakosIdIdentityError("malformed");
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["id", "name", "role"].includes(key))) {
      throw new TakosIdIdentityError("malformed");
    }
    if (record.role !== "owner" && record.role !== "member") {
      throw new TakosIdIdentityError("malformed");
    }
    return {
      id: boundedString(record.id, 1, 128),
      name: boundedString(record.name, 1, 128),
      role: record.role,
    };
  });
}

function exactIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new TypeError("invalid issuer");
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TakosIdIdentityError("malformed");
  }
  return value;
}
