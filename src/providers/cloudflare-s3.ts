import { S3CredentialError, type S3CredentialIssuer, type S3CredentialSet } from "../s3-port.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 64 * 1_024;

export interface CloudflareS3CredentialOptions {
  readonly accountId: string;
  readonly providerInstallationRef: string;
  readonly parentAccessKeyId: string;
  readonly authorize: () => string | Promise<string>;
  readonly clock?: () => Date;
  readonly apiOrigin?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** Cloudflare R2 Temporary Credentials behind Takoserver's standard S3 port. */
export function createCloudflareS3CredentialIssuer(
  options: CloudflareS3CredentialOptions,
): S3CredentialIssuer {
  const accountId = identifier(options.accountId, 128);
  const providerInstallationRef = identifier(options.providerInstallationRef, 255);
  const parentAccessKeyId = identifier(options.parentAccessKeyId, 512);
  const origin = options.apiOrigin ?? CLOUDFLARE_API;
  const fetchRequest = options.fetch ?? ((request: Request) => fetch(request));
  const clock = options.clock ?? (() => new Date());

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
      const authorization = await options.authorize();
      if (!authorization) throw new S3CredentialError("backend_unavailable");

      let response: Response;
      try {
        response = await fetchRequest(
          new Request(`${origin}/accounts/${accountId}/r2/temp-access-credentials`, {
            method: "POST",
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify({
              bucket,
              parentAccessKeyId,
              permission: input.access === "read-write" ? "object-read-write" : "object-read-only",
              ttlSeconds: input.ttlSeconds,
            }),
          }),
        );
      } catch {
        throw new S3CredentialError("backend_unavailable");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new S3CredentialError("backend_unavailable");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new S3CredentialError("upstream_invalid");
      }
      const envelope = parseEnvelope(bytes);
      const now = clock();
      const expiresAt = new Date(now.getTime() + (input.ttlSeconds - 5) * 1_000).toISOString();
      return {
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        region: "auto",
        bucket,
        accessKeyId: envelope.accessKeyId,
        secretAccessKey: envelope.secretAccessKey,
        sessionToken: envelope.sessionToken,
        expiresAt,
      };
    },
  };
}

function parseEnvelope(bytes: Uint8Array): {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new S3CredentialError("upstream_invalid");
  }
  if (!record(value) || value.success !== true || !record(value.result)) {
    throw new S3CredentialError("upstream_invalid");
  }
  return {
    accessKeyId: secret(value.result.accessKeyId, 512),
    secretAccessKey: secret(value.result.secretAccessKey, 4_096),
    sessionToken: secret(value.result.sessionToken, 16_384),
  };
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

function secret(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new S3CredentialError("upstream_invalid");
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
