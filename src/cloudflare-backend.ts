import type {
  BackendAdapter,
  BackendOffering,
  BackendOperation,
  BackendReceipt,
} from "./backends.ts";
import { BackendError } from "./backends.ts";

export interface CloudflareBackendOptions {
  readonly id: string;
  readonly accountId: string;
  readonly apiOrigin?: string;
  readonly offerings: readonly BackendOffering[];
  readonly authorize: (input: {
    readonly backendId: string;
    readonly method: "POST" | "GET" | "DELETE";
    readonly url: URL;
  }) => string | Promise<string>;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/**
 * Cloudflare's private implementation adapter. The public BackendAdapter seam
 * remains provider-neutral; credentials and provider envelopes stop here.
 */
export class CloudflareBackendAdapter implements BackendAdapter {
  readonly id: string;
  readonly #accountId: string;
  readonly #apiOrigin: URL;
  readonly #offerings: readonly BackendOffering[];
  readonly #authorize: CloudflareBackendOptions["authorize"];
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #operations = new Map<
    string,
    { readonly fingerprint: string; readonly receipt: BackendReceipt }
  >();

  constructor(options: CloudflareBackendOptions) {
    this.id = reference(options.id, "backend id");
    this.#accountId = boundedString(options.accountId, "account id", 128);
    this.#apiOrigin = apiOrigin(options.apiOrigin ?? "https://api.cloudflare.com/client/v4");
    if (options.offerings.length === 0) throw new TypeError("Cloudflare offerings are required");
    if (options.offerings.some((offering) => offering.kind !== "object_bucket")) {
      throw new TypeError("this slice supports only Cloudflare object_bucket offerings");
    }
    this.#offerings = structuredClone(options.offerings);
    if (typeof options.authorize !== "function")
      throw new TypeError("Cloudflare authorizer is required");
    this.#authorize = options.authorize;
    this.#fetch = options.fetch ?? fetch;
  }

  async discover(): Promise<readonly BackendOffering[]> {
    return structuredClone(this.#offerings);
  }

  async perform(operation: BackendOperation): Promise<BackendReceipt> {
    const offering = this.#offerings.find((candidate) => candidate.id === operation.offering.id);
    if (!offering || offering.available === false) throw new BackendError("not_found", false);
    const name =
      operation.kind === "provision"
        ? await provisionedBucketName(operation.resource)
        : bucketNameFromNativeId(operation.nativeId);
    const location = bucketLocation(operation.resource.spec.location);
    const fingerprint = JSON.stringify({
      kind: operation.kind,
      offeringId: offering.id,
      name,
      location,
    });
    const replay = this.#operations.get(operation.operationId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new BackendError("conflict", false);
      return structuredClone(replay.receipt);
    }

    const collectionPath = `${this.#apiOrigin.pathname.replace(/\/$/u, "")}/accounts/${encodeURIComponent(this.#accountId)}/r2/buckets`;
    const url = new URL(
      operation.kind === "provision"
        ? collectionPath
        : `${collectionPath}/${encodeURIComponent(name)}`,
      this.#apiOrigin.origin,
    );
    const method =
      operation.kind === "provision" ? "POST" : operation.kind === "observe" ? "GET" : "DELETE";
    let authorization: string;
    try {
      authorization = boundedString(
        await this.#authorize({ backendId: this.id, method, url }),
        "authorization",
        8 * 1_024,
      );
    } catch {
      throw new BackendError("unavailable", false);
    }
    let response: Response;
    try {
      response = await this.#fetch(
        new Request(url, {
          method,
          headers: {
            accept: "application/json",
            authorization,
            "content-type": "application/json; charset=UTF-8",
          },
          ...(operation.kind === "provision"
            ? { body: JSON.stringify({ name, ...(location ? { locationHint: location } : {}) }) }
            : {}),
        }),
      );
    } catch {
      throw new BackendError("unavailable", true);
    }
    if (!response.ok) {
      if (response.status === 409) throw new BackendError("conflict", false);
      throw new BackendError("unavailable", response.status === 429 || response.status >= 500);
    }
    const envelope = await boundedEnvelope(response);
    if (
      envelope.success !== true ||
      !Array.isArray(envelope.errors) ||
      envelope.errors.length !== 0
    ) {
      throw new BackendError("invalid_response", false);
    }
    if (
      operation.kind !== "delete" &&
      (!isRecord(envelope.result) || envelope.result.name !== name)
    ) {
      throw new BackendError("invalid_response", false);
    }
    const receipt: BackendReceipt = {
      nativeId: `r2:${name}`,
      observed:
        operation.kind === "delete"
          ? { deleted: true }
          : {
              name,
              ...(isRecord(envelope.result) && typeof envelope.result.location === "string"
                ? { location: envelope.result.location }
                : location
                  ? { location }
                  : {}),
            },
      output: operation.kind === "delete" ? {} : { protocol: "s3", bucketName: name },
    };
    this.#operations.set(operation.operationId, { fingerprint, receipt });
    return structuredClone(receipt);
  }
}

function bucketNameFromNativeId(value: string): string {
  if (!value.startsWith("r2:")) throw new BackendError("invalid_request", false);
  return bucketName(value.slice("r2:".length));
}

async function provisionedBucketName(resource: BackendOperation["resource"]): Promise<string> {
  const identity = new TextEncoder().encode(
    `${resource.tenantRef}\0${resource.space}\0${resource.name}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", identity));
  return `ts-${[...digest]
    .slice(0, 20)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function boundedEnvelope(response: Response): Promise<Record<string, unknown>> {
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    throw new BackendError("invalid_response", false);
  }
  if (bytes.byteLength > 1_048_576) throw new BackendError("invalid_response", false);
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(value)) throw new BackendError("invalid_response", false);
    return value;
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError("invalid_response", false);
  }
}

function apiOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("Cloudflare API origin must be HTTPS");
  }
  return url;
}

function bucketName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value)) {
    throw new BackendError("invalid_request", false);
  }
  return value;
}

function bucketLocation(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{2,32}$/u.test(value)) {
    throw new BackendError("invalid_request", false);
  }
  return value;
}

function reference(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedString(value: string, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > maxBytes
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
