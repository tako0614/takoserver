import { base64UrlEncode, canonicalJson } from "./json.ts";

export const SPONSORSHIP_ISSUANCE_RECEIPT_TYPE =
  "takoserver-sponsorship-issuance-receipt+jwt" as const;
export const SPONSORSHIP_ISSUANCE_RECEIPT_AUDIENCE =
  "takosumi-hosted.sponsorship-cutover-proof.v1" as const;

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SponsorshipReceiptSigningKey {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
}

export interface SponsorshipReceiptChannel {
  readonly kind: "takosumi-hosted.sponsorship-authority-rpc@v1";
  readonly hostedVersionId: string;
  readonly issuanceOperationId: `sha256:${string}`;
  readonly requestNonce: string;
  readonly requestSha256: `sha256:${string}`;
}

export interface SponsorshipIssuanceReceiptIssuer {
  issue(input: {
    readonly channel: SponsorshipReceiptChannel;
    readonly token: string;
    readonly issuedAt: Date;
    readonly expiresAt: string;
    readonly credentialPublicJwk: {
      readonly kty: "OKP";
      readonly crv: "Ed25519";
      readonly x: string;
    };
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly spaceRef: string;
    readonly runRef: string;
    readonly requiredAvailableMinor: number;
    readonly workerEndpointOriginReservationId?: string;
  }): Promise<string>;
}

/**
 * Signs a value-free receipt available only from the route-less RPC Worker.
 * The ordinary run-token key remains independently verifiable; its public half
 * is authenticated inside this receipt, while neither bearer nor raw tenant
 * identity is copied into the receipt.
 */
export function createSponsorshipIssuanceReceiptIssuer(options: {
  readonly key: SponsorshipReceiptSigningKey;
  readonly authority: {
    readonly workerName: string;
    readonly versionId: string;
    readonly sourceCommit: string;
    readonly artifactSha256: `sha256:${string}`;
  };
}): SponsorshipIssuanceReceiptIssuer {
  if (
    !KEY_ID.test(options.key.keyId) ||
    options.key.privateKey.type !== "private" ||
    !options.key.privateKey.usages.includes("sign") ||
    !VERSION_ID.test(options.authority.versionId) ||
    !COMMIT.test(options.authority.sourceCommit) ||
    !SHA256.test(options.authority.artifactSha256)
  ) {
    throw new TypeError("sponsorship receipt authority identity is invalid");
  }
  exactPublicJwk(options.key.publicJwk);

  return {
    async issue(input) {
      const issuedAt = Math.floor(input.issuedAt.getTime() / 1_000);
      const expiresAt = Date.parse(input.expiresAt) / 1_000;
      const credentialPublicJwk = exactPublicJwk(input.credentialPublicJwk);
      if (
        input.channel.kind !== "takosumi-hosted.sponsorship-authority-rpc@v1" ||
        !VERSION_ID.test(input.channel.hostedVersionId) ||
        !SHA256.test(input.channel.issuanceOperationId) ||
        !SHA256.test(input.channel.requestSha256) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(input.channel.requestNonce) ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > 300
      ) {
        throw new TypeError("sponsorship receipt input is invalid");
      }
      if (credentialPublicJwk.x === options.key.publicJwk.x) {
        throw new TypeError("sponsorship receipt authority must use a dedicated signing key");
      }
      const payload = {
        aud: SPONSORSHIP_ISSUANCE_RECEIPT_AUDIENCE,
        authority: {
          artifactSha256: options.authority.artifactSha256,
          sourceCommit: options.authority.sourceCommit,
          versionId: options.authority.versionId,
          workerNameSha256: await digestText(options.authority.workerName),
        },
        credential: {
          expiresAtEpochSeconds: expiresAt,
          issuedAtEpochSeconds: issuedAt,
          organizationIdSha256: await digestText(input.organizationId),
          publicJwk: credentialPublicJwk,
          reservationRefSha256:
            input.workerEndpointOriginReservationId === undefined
              ? null
              : await digestText(input.workerEndpointOriginReservationId),
          runRefSha256: await digestText(input.runRef),
          spaceRefSha256: await digestText(input.spaceRef),
          tenantRefSha256: await digestText(input.tenantRef),
          tokenSha256: await digestText(input.token),
        },
        exp: expiresAt,
        hostedVersionId: input.channel.hostedVersionId,
        iat: issuedAt,
        issuanceOperationId: input.channel.issuanceOperationId,
        requestNonceSha256: await digestText(input.channel.requestNonce),
        requestSha256: input.channel.requestSha256,
        requiredAvailableMinor: input.requiredAvailableMinor,
      };
      const header = {
        alg: "EdDSA",
        kid: options.key.keyId,
        typ: SPONSORSHIP_ISSUANCE_RECEIPT_TYPE,
      };
      const signingInput = `${encode(header)}.${encode(payload)}`;
      const signature = await crypto.subtle.sign(
        "Ed25519",
        options.key.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${base64UrlEncode(signature)}`;
    },
  };
}

export async function loadSponsorshipReceiptSigningKey(
  keyId: string | undefined,
  raw: string | undefined,
): Promise<SponsorshipReceiptSigningKey | undefined> {
  if (!keyId || !raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("sponsorship receipt signing key is invalid");
  }
  if (!record(value) || value.kty !== "OKP" || value.crv !== "Ed25519") {
    throw new TypeError("sponsorship receipt signing key is invalid");
  }
  const publicJwk = exactPublicJwk(value);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    value as unknown as JsonWebKey,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { keyId, privateKey, publicJwk };
}

function exactPublicJwk(value: unknown): SponsorshipReceiptSigningKey["publicJwk"] {
  if (
    !record(value) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.x)
  ) {
    throw new TypeError("sponsorship receipt public key is invalid");
  }
  return { kty: "OKP", crv: "Ed25519", x: value.x };
}

function encode(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(canonicalJson(value)));
}

async function digestText(value: string): Promise<`sha256:${string}`> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
