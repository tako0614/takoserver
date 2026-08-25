import type { JsonObject } from "../ports.ts";
import {
  type StandardServiceSupply,
  StandardServiceSupplyError,
} from "../standard-service-port.ts";

const API_ORIGIN = "https://api.cloudflare.com/client/v4";

export const AMAZON_S3_STANDARD_SERVICE = {
  apiVersion: "standards.takoform.com/v1",
  protocol: "com.amazonaws.s3",
} as const;
export const CLOUDFLARE_R2_ENDPOINT_KIND = "takoserver.cloudflare-r2-bucket@v1";
export const CLOUDFLARE_R2_CREDENTIAL_KIND = "takoserver.cloudflare-r2-binding@v1";

interface CloudflareR2StandardServiceOptions {
  readonly accountId: string;
  /**
   * Operator-owned identity of this Host supply inside the Cloudflare account.
   * It is sealed configuration, never portable state or returned runtime material.
   */
  readonly supplyNamespace: string;
  readonly authorize: () => Promise<string> | string;
  readonly apiOrigin?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/**
 * Host-owned S3 service backed by one deterministic R2 bucket per
 * tenant/space/slot. Immutable revisions share that service identity. A failed
 * apply may leave the bucket ready for retry; deleting a portable Resource is
 * not authority to delete this out-of-band service.
 */
export function createCloudflareR2StandardServiceSupply(
  options: CloudflareR2StandardServiceOptions,
): StandardServiceSupply {
  const accountId = identifier(options.accountId, 128);
  const supplyNamespace = namespace(options.supplyNamespace);
  const origin = new URL(options.apiOrigin ?? API_ORIGIN);
  const call = options.fetch ?? ((request: Request) => fetch(request));
  // Single-flight only. A successful result is never cached across
  // materializations because an operator may delete the bucket out of band.
  const ensuring = new Map<string, Promise<void>>();

  const ensure = async (bucketName: string): Promise<void> => {
    let pending = ensuring.get(bucketName);
    if (!pending) {
      pending = ensureBucket({
        accountId,
        bucketName,
        origin,
        authorize: options.authorize,
        fetch: call,
      });
      ensuring.set(bucketName, pending);
    }
    try {
      await pending;
    } catch {
      throw new StandardServiceSupplyError();
    } finally {
      if (ensuring.get(bucketName) === pending) ensuring.delete(bucketName);
    }
  };

  return {
    serviceRef: AMAZON_S3_STANDARD_SERVICE,
    async satisfiable(input) {
      return (
        bounded(input.tenantId, 1, 255) &&
        (input.space === undefined || bounded(input.space, 1, 255))
      );
    },
    async materialize(input) {
      if (
        !bounded(input.tenantId, 1, 255) ||
        !bounded(input.space, 1, 255) ||
        !bounded(input.slotName, 1, 64)
      ) {
        return null;
      }
      const bucketName = await derivedBucketName({ ...input, supplyNamespace });
      await ensure(bucketName);
      return {
        endpoint: {
          kind: CLOUDFLARE_R2_ENDPOINT_KIND,
          bucketName,
        } satisfies JsonObject,
        credential: {
          kind: CLOUDFLARE_R2_CREDENTIAL_KIND,
        },
      };
    },
  };
}

async function ensureBucket(input: {
  readonly accountId: string;
  readonly bucketName: string;
  readonly origin: URL;
  readonly authorize: () => Promise<string> | string;
  readonly fetch: (request: Request) => Promise<Response>;
}): Promise<void> {
  const path = `/accounts/${encodeURIComponent(input.accountId)}/r2/buckets/${encodeURIComponent(input.bucketName)}`;
  const current = await cloudflareCall(input, "GET", path);
  if (current.ok) {
    requireExactBucket(current.result, input.bucketName);
    return;
  }
  if (current.status !== 404) throw new Error("R2 supply lookup failed");

  const created = await cloudflareCall(
    input,
    "POST",
    `/accounts/${encodeURIComponent(input.accountId)}/r2/buckets`,
    { name: input.bucketName },
  );
  if (created.ok) {
    requireExactBucket(created.result, input.bucketName);
    return;
  }
  if (created.status !== 409) throw new Error("R2 supply creation failed");

  const raced = await cloudflareCall(input, "GET", path);
  if (!raced.ok) throw new Error("R2 supply race did not settle");
  requireExactBucket(raced.result, input.bucketName);
}

async function cloudflareCall(
  input: {
    readonly origin: URL;
    readonly authorize: () => Promise<string> | string;
    readonly fetch: (request: Request) => Promise<Response>;
  },
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
): Promise<{ readonly ok: boolean; readonly status: number; readonly result: unknown }> {
  const authorization = await input.authorize();
  if (!bounded(authorization, 8, 8_192) || !authorization.startsWith("Bearer ")) {
    throw new Error("R2 supply authorization is unavailable");
  }
  const response = await input.fetch(
    new Request(cloudflareApiUrl(input.origin, path), {
      method,
      headers: {
        authorization,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const text = await response.text();
  if (text.length > 64 * 1_024) throw new Error("R2 supply response is oversized");
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("R2 supply response is malformed");
  }
  const record = object(envelope);
  return {
    ok: response.ok && record?.success === true,
    status: response.status,
    result: record?.result,
  };
}

function cloudflareApiUrl(origin: URL, path: string): URL {
  const basePath = origin.pathname.replace(/\/+$/u, "");
  return new URL(`${basePath}${path}`, origin.origin);
}

function requireExactBucket(result: unknown, expected: string): void {
  if (object(result)?.name !== expected) throw new Error("R2 supply identity is ambiguous");
}

async function derivedBucketName(input: {
  readonly supplyNamespace: string;
  readonly tenantId: string;
  readonly space: string;
  readonly slotName: string;
}): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${input.supplyNamespace}\0${input.tenantId}\0${input.space}\0${input.slotName}`,
      ),
    ),
  );
  const suffix = [...digest.slice(0, 20)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `tss3-${suffix}`;
}

function namespace(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError("invalid Cloudflare R2 standard-service configuration");
  }
  return value;
}

function identifier(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !bounded(value, 1, maximum) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TypeError("invalid Cloudflare R2 standard-service configuration");
  }
  return value;
}

function bounded(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
