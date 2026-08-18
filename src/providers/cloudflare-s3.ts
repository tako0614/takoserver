import { S3CredentialError, type S3CredentialIssuer, type S3CredentialSet } from "../s3-port.ts";

export interface CloudflareS3CredentialOptions {
  readonly accountId: string;
  readonly providerInstallationRef: string;
  readonly parentAccessKeyId: string;
  readonly parentSecretAccessKey: string;
  readonly clock?: () => Date;
}

/** Cloudflare R2 Temporary Credentials behind Takoserver's standard S3 port. */
export function createCloudflareS3CredentialIssuer(
  options: CloudflareS3CredentialOptions,
): S3CredentialIssuer {
  const accountId = identifier(options.accountId, 128);
  const providerInstallationRef = identifier(options.providerInstallationRef, 255);
  const parentAccessKeyId = identifier(options.parentAccessKeyId, 512);
  const parentSecretAccessKey = parentSecret(options.parentSecretAccessKey);
  const clock = options.clock ?? (() => new Date());
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const audience = new URL(endpoint).host;

  return {
    async issue(input): Promise<S3CredentialSet> {
      if (
        input.providerPackRef !== "cloudflare" ||
        input.providerInstallationRef !== providerInstallationRef
      ) {
        throw new S3CredentialError("upstream_invalid");
      }
      const bucket = r2Bucket(input.nativeId);
      if (
        !Number.isSafeInteger(input.ttlSeconds) ||
        input.ttlSeconds < 60 ||
        input.ttlSeconds > 3_600
      ) {
        throw new S3CredentialError("upstream_invalid");
      }
      const now = clock();
      const issuedAt = Math.floor(now.getTime() / 1_000);
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
        throw new S3CredentialError("backend_unavailable");
      }
      const expiresAtEpochSeconds = issuedAt + input.ttlSeconds;
      const scope = input.access === "read-write" ? "object-read-write" : "object-read-only";
      const jwt = await signedJwt(
        {
          aud: audience,
          bucket,
          exp: expiresAtEpochSeconds,
          iat: issuedAt,
          iss: parentAccessKeyId,
          scope,
          sub: accountId,
        },
        parentSecretAccessKey,
      );
      const secretAccessKey = await sha256Hex(jwt);
      return {
        endpoint,
        region: "auto",
        bucket,
        accessKeyId: parentAccessKeyId,
        secretAccessKey,
        sessionToken: btoa(`jwt/${jwt}`),
        // Stop advertising the credential five seconds before R2 does. A
        // caller that begins a request at our deadline must not lose the race
        // to the signed token's exact expiration.
        expiresAt: new Date((expiresAtEpochSeconds - 5) * 1_000).toISOString(),
      };
    },
  };
}

async function signedJwt(
  claims: Readonly<Record<string, string | number>>,
  secretAccessKey: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secretAccessKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
    return `${input}.${base64Url(new Uint8Array(signature))}`;
  } catch {
    throw new S3CredentialError("backend_unavailable");
  }
}

async function sha256Hex(value: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    throw new S3CredentialError("backend_unavailable");
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function r2Bucket(nativeId: string): string {
  if (!nativeId.startsWith("r2:")) throw new S3CredentialError("upstream_invalid");
  return identifier(nativeId.slice("r2:".length), 255);
}

function identifier(value: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new S3CredentialError("upstream_invalid");
  }
  return value;
}

function parentSecret(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new S3CredentialError("upstream_invalid");
  }
  return value;
}
