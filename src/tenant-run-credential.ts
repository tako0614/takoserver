import { base64UrlEncode } from "./json.ts";
import type { Clock } from "./ports.ts";
import type { SigningKey } from "./token.ts";

const TOKEN_TYPE = "takoserver-token+jwt";
const TAKOFORM_RUN_AUDIENCE = "takoform.run";
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
export const MAX_TENANT_RUN_CREDENTIAL_LIFETIME_SECONDS = 300;

/**
 * Private signer grammar shared by the independent sponsorship and self-host
 * authorities. It has no route, storage decision, or organization-selection
 * policy: each authority must make those decisions before it calls `issue`.
 */
export interface TenantRunCredentialSigner {
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

export function createTenantRunCredentialSigner(options: {
  readonly issuer: string;
  readonly signingKey: SigningKey;
  readonly clock: Clock;
  readonly allowLoopbackHttp?: boolean;
  readonly errorLabel?: string;
}): TenantRunCredentialSigner {
  const errorLabel = options.errorLabel ?? "tenant-run credential";
  const issuer = httpsOrigin(options.issuer, options.allowLoopbackHttp ?? false, errorLabel);
  const key = options.signingKey;
  if (!KEY_ID.test(key.keyId)) throw new TypeError(`${errorLabel} key id is invalid`);
  if (key.privateKey.type !== "private" || !key.privateKey.usages.includes("sign")) {
    throw new TypeError(`an Ed25519 ${errorLabel} signing key is required`);
  }

  return {
    async issue(input) {
      const ttlSeconds = positiveInteger(input.ttlSeconds, errorLabel);
      if (ttlSeconds > MAX_TENANT_RUN_CREDENTIAL_LIFETIME_SECONDS) {
        throw new TypeError(`${errorLabel} lifetime is invalid`);
      }
      const now = Math.floor(options.clock().getTime() / 1_000);
      if (
        !Number.isSafeInteger(input.issuedAtEpochSeconds) ||
        input.issuedAtEpochSeconds < 0 ||
        input.issuedAtEpochSeconds > now
      ) {
        throw new TypeError(`${errorLabel} issuance instant is invalid`);
      }
      const expiresAtEpochSeconds = input.issuedAtEpochSeconds + ttlSeconds;
      const header = encode({ alg: "EdDSA", kid: key.keyId, typ: TOKEN_TYPE });
      const payload = encode({
        aud: TAKOFORM_RUN_AUDIENCE,
        exp: expiresAtEpochSeconds,
        iat: input.issuedAtEpochSeconds,
        iss: issuer,
        jti: reference(input.tokenId, errorLabel),
        mode: "tenant-run",
        nbf: input.issuedAtEpochSeconds,
        organizationId: reference(input.organizationId, errorLabel),
        runRef: reference(input.runRef, errorLabel),
        spaceRef: reference(input.spaceRef, errorLabel),
        tenantRef: reference(input.tenantRef, errorLabel),
        ...(input.workerEndpointOriginReservationId === undefined
          ? {}
          : {
              workerEndpointOriginReservationId: reference(
                input.workerEndpointOriginReservationId,
                errorLabel,
              ),
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

function httpsOrigin(value: string, allowLoopbackHttp: boolean, errorLabel: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new TypeError(`${errorLabel} issuer must be an HTTPS origin`);
  }
  return url.origin;
}

function reference(value: string, errorLabel: string): string {
  if (!REFERENCE.test(value)) throw new TypeError(`${errorLabel} reference is invalid`);
  return value;
}

function positiveInteger(value: number, errorLabel: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${errorLabel} lifetime is invalid`);
  }
  return value;
}
