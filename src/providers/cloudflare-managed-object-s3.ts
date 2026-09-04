import { signAwsV4Request } from "./aws-sigv4.ts";

const DEFAULT_MAXIMUM_PAGES = 4;
const DEFAULT_MAXIMUM_CANDIDATES = 256;
const MAXIMUM_RESPONSE_BYTES = 256 * 1024;
const MAXIMUM_UPLOAD_ID_BYTES = 4_096;
const MAXIMUM_OBJECT_KEY_BYTES = 979;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MARKER = /^[A-Za-z0-9_-]{43}$/u;

export type ManagedObjectS3ErrorCode =
  | "invalid_argument"
  | "transport"
  | "rejected"
  | "malformed_response"
  | "bound_exceeded";

/** A deliberately detail-free provider failure; credentials and native bodies never escape. */
export class ManagedObjectS3Error extends Error {
  readonly code: ManagedObjectS3ErrorCode;
  readonly status: number | null;

  constructor(code: ManagedObjectS3ErrorCode, status: number | null = null) {
    super(`managed ObjectBucket S3 ${code}`);
    this.name = "ManagedObjectS3Error";
    this.code = code;
    this.status = status;
  }
}

export interface ManagedObjectMultipartUpload {
  readonly key: string;
  readonly uploadId: string;
}

export interface CloudflareManagedObjectS3Options {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now?: () => Date;
  readonly maximumPages?: number;
  readonly maximumCandidates?: number;
}

/**
 * Provider-private R2 S3 control transport.
 *
 * The tenant receives neither this adapter nor its credentials. It implements
 * only the native multipart operations the receipt authority needs, and every
 * list/body/page is bounded before data is retained.
 */
export class CloudflareManagedObjectS3 {
  readonly #endpoint: string;
  readonly #credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #now: () => Date;
  readonly #maximumPages: number;
  readonly #maximumCandidates: number;

  constructor(options: CloudflareManagedObjectS3Options) {
    if (!ACCOUNT.test(options.accountId)) {
      throw new TypeError("managed ObjectBucket S3 account is unavailable");
    }
    if (!secret(options.accessKeyId, 512) || !secret(options.secretAccessKey, 4_096)) {
      throw new TypeError("managed ObjectBucket S3 credentials are unavailable");
    }
    this.#endpoint = `https://${options.accountId}.r2.cloudflarestorage.com`;
    this.#credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    };
    this.#fetch = options.fetch ?? ((request) => fetch(request));
    this.#now = options.now ?? (() => new Date());
    this.#maximumPages = positiveBound(options.maximumPages ?? DEFAULT_MAXIMUM_PAGES, 16, "page");
    this.#maximumCandidates = positiveBound(
      options.maximumCandidates ?? DEFAULT_MAXIMUM_CANDIDATES,
      1_024,
      "candidate",
    );
  }

  async listMultipartUploads(input: {
    readonly bucketName: string;
    readonly key?: string;
  }): Promise<readonly ManagedObjectMultipartUpload[]> {
    const bucketName = bucket(input.bucketName);
    const exactKey = input.key === undefined ? undefined : objectKey(input.key);
    const uploads: ManagedObjectMultipartUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (let page = 0; page < this.#maximumPages; page += 1) {
      const parsed = await this.#listPage({
        bucketName,
        ...(exactKey === undefined ? {} : { key: exactKey }),
        ...(keyMarker === undefined ? {} : { keyMarker }),
        ...(uploadIdMarker === undefined ? {} : { uploadIdMarker }),
      });
      for (const candidate of parsed.uploads) {
        if (exactKey !== undefined && candidate.key !== exactKey) continue;
        if (uploads.some((existing) => existing.uploadId === candidate.uploadId)) {
          throw new ManagedObjectS3Error("malformed_response");
        }
        uploads.push(candidate);
        if (uploads.length > this.#maximumCandidates) {
          throw new ManagedObjectS3Error("bound_exceeded");
        }
      }
      if (!parsed.truncated) return uploads;
      if (
        parsed.nextKeyMarker === undefined ||
        parsed.nextUploadIdMarker === undefined ||
        (parsed.nextKeyMarker === keyMarker && parsed.nextUploadIdMarker === uploadIdMarker)
      ) {
        throw new ManagedObjectS3Error("malformed_response");
      }
      keyMarker = parsed.nextKeyMarker;
      uploadIdMarker = parsed.nextUploadIdMarker;
    }
    throw new ManagedObjectS3Error("bound_exceeded");
  }

  /** One bounded first page, used by resumable bucket destruction. */
  async listMultipartUploadPage(input: { readonly bucketName: string }): Promise<{
    readonly uploads: readonly ManagedObjectMultipartUpload[];
    readonly truncated: boolean;
  }> {
    const parsed = await this.#listPage({ bucketName: bucket(input.bucketName) });
    if (parsed.uploads.length > this.#maximumCandidates) {
      throw new ManagedObjectS3Error("bound_exceeded");
    }
    return { uploads: parsed.uploads, truncated: parsed.truncated };
  }

  async createMultipartUpload(input: {
    readonly bucketName: string;
    readonly key: string;
    readonly contentType: string | null;
    readonly marker: string;
  }): Promise<{ readonly uploadId: string }> {
    const bucketName = bucket(input.bucketName);
    const key = objectKey(input.key);
    if (input.contentType !== null && !plainText(input.contentType, 256)) {
      throw new ManagedObjectS3Error("invalid_argument");
    }
    if (!MARKER.test(input.marker)) throw new ManagedObjectS3Error("invalid_argument");
    const url = new URL(`${this.#endpoint}/${bucketName}/${objectPath(key)}`);
    url.searchParams.set("uploads", "");
    const headers: Record<string, string> = {
      "x-amz-meta-takoserver-multipart-receipt-v1": input.marker,
    };
    if (input.contentType !== null) headers["content-type"] = input.contentType;
    const response = await this.#send("POST", url, headers);
    if (!response.ok) throw rejected(response.status);
    const parsed = parseCreateMultipartUpload(await boundedText(response));
    if (parsed.bucket !== bucketName || parsed.key !== key) {
      throw new ManagedObjectS3Error("malformed_response");
    }
    return { uploadId: parsed.uploadId };
  }

  async abortMultipartUpload(input: {
    readonly bucketName: string;
    readonly key: string;
    readonly uploadId: string;
  }): Promise<void> {
    const bucketName = bucket(input.bucketName);
    const key = objectKey(input.key);
    const uploadId = uploadIdValue(input.uploadId);
    const url = new URL(`${this.#endpoint}/${bucketName}/${objectPath(key)}`);
    url.searchParams.set("uploadId", uploadId);
    const response = await this.#send("DELETE", url);
    if (!response.ok && response.status !== 404) throw rejected(response.status);
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {}
    }
  }

  /** Authoritative S3 read used by commitDestroy; true means deletion must stop. */
  async bucketPresent(bucketNameInput: string): Promise<boolean> {
    const bucketName = bucket(bucketNameInput);
    const response = await this.#send("HEAD", new URL(`${this.#endpoint}/${bucketName}`));
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw rejected(response.status);
  }

  async #send(
    method: "GET" | "POST" | "DELETE" | "HEAD",
    url: URL,
    headers?: Readonly<Record<string, string>>,
  ): Promise<Response> {
    let request: Request;
    try {
      request = await signAwsV4Request({
        method,
        url: url.href,
        region: "auto",
        service: "s3",
        credentials: this.#credentials,
        ...(headers === undefined ? {} : { headers }),
        now: this.#now(),
      });
    } catch {
      throw new ManagedObjectS3Error("invalid_argument");
    }
    try {
      return await this.#fetch(request);
    } catch {
      throw new ManagedObjectS3Error("transport");
    }
  }

  async #listPage(input: {
    readonly bucketName: string;
    readonly key?: string;
    readonly keyMarker?: string;
    readonly uploadIdMarker?: string;
  }): Promise<ReturnType<typeof parseListMultipartUploads>> {
    const url = new URL(`${this.#endpoint}/${input.bucketName}`);
    url.searchParams.set("uploads", "");
    url.searchParams.set("max-uploads", String(Math.min(100, this.#maximumCandidates)));
    if (input.key !== undefined) url.searchParams.set("prefix", input.key);
    if (input.keyMarker !== undefined) url.searchParams.set("key-marker", input.keyMarker);
    if (input.uploadIdMarker !== undefined)
      url.searchParams.set("upload-id-marker", input.uploadIdMarker);
    const response = await this.#send("GET", url);
    if (!response.ok) throw rejected(response.status);
    return parseListMultipartUploads(await boundedText(response));
  }
}

function parseListMultipartUploads(xml: string): {
  readonly uploads: readonly ManagedObjectMultipartUpload[];
  readonly truncated: boolean;
  readonly nextKeyMarker?: string;
  readonly nextUploadIdMarker?: string;
} {
  if (
    !/^\s*(?:<\?xml[^>]*>\s*)?<ListMultipartUploadsResult(?:\s[^>]*)?>[\s\S]*<\/ListMultipartUploadsResult>\s*$/u.test(
      xml,
    )
  ) {
    throw new ManagedObjectS3Error("malformed_response");
  }
  const truncatedText = singleElement(xml, "IsTruncated");
  if (truncatedText !== "true" && truncatedText !== "false") {
    throw new ManagedObjectS3Error("malformed_response");
  }
  const uploads: ManagedObjectMultipartUpload[] = [];
  const blocks = xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/gu);
  for (const match of blocks) {
    const block = match[1];
    if (block === undefined) throw new ManagedObjectS3Error("malformed_response");
    const key = decodeXml(singleElement(block, "Key"));
    const uploadId = decodeXml(singleElement(block, "UploadId"));
    objectKey(key);
    uploadIdValue(uploadId);
    uploads.push({ key, uploadId });
  }
  const nextKeyMarker = optionalElement(xml, "NextKeyMarker");
  const nextUploadIdMarker = optionalElement(xml, "NextUploadIdMarker");
  return {
    uploads,
    truncated: truncatedText === "true",
    ...(nextKeyMarker === undefined ? {} : { nextKeyMarker: decodeXml(nextKeyMarker) }),
    ...(nextUploadIdMarker === undefined
      ? {}
      : { nextUploadIdMarker: decodeXml(nextUploadIdMarker) }),
  };
}

function parseCreateMultipartUpload(xml: string): {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
} {
  if (
    !/^\s*(?:<\?xml[^>]*>\s*)?<InitiateMultipartUploadResult(?:\s[^>]*)?>[\s\S]*<\/InitiateMultipartUploadResult>\s*$/u.test(
      xml,
    )
  ) {
    throw new ManagedObjectS3Error("malformed_response");
  }
  const parsed = {
    bucket: decodeXml(singleElement(xml, "Bucket")),
    key: decodeXml(singleElement(xml, "Key")),
    uploadId: decodeXml(singleElement(xml, "UploadId")),
  };
  bucket(parsed.bucket);
  objectKey(parsed.key);
  uploadIdValue(parsed.uploadId);
  return parsed;
}

function singleElement(xml: string, name: string): string {
  const matches = [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "gu"))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new ManagedObjectS3Error("malformed_response");
  }
  return matches[0][1];
}

function optionalElement(xml: string, name: string): string | undefined {
  const matches = [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "gu"))];
  if (matches.length > 1 || (matches.length === 1 && matches[0]?.[1] === undefined)) {
    throw new ManagedObjectS3Error("malformed_response");
  }
  return matches[0]?.[1];
}

function decodeXml(value: string): string {
  if (/<|>/u.test(value)) throw new ManagedObjectS3Error("malformed_response");
  const entityPattern = /&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/gu;
  if (value.replace(entityPattern, "").includes("&")) {
    throw new ManagedObjectS3Error("malformed_response");
  }
  return value.replace(entityPattern, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";
    const code = entity.startsWith("&#x")
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number.parseInt(entity.slice(2, -1), 10);
    if (
      !Number.isSafeInteger(code) ||
      code < 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      throw new ManagedObjectS3Error("malformed_response");
    }
    return String.fromCodePoint(code);
  });
}

async function boundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES) {
      throw new ManagedObjectS3Error("bound_exceeded");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        throw new ManagedObjectS3Error("bound_exceeded");
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ManagedObjectS3Error("malformed_response");
  }
}

function rejected(status: number): ManagedObjectS3Error {
  return new ManagedObjectS3Error("rejected", Number.isInteger(status) ? status : null);
}

function bucket(value: string): string {
  if (!BUCKET.test(value) || value.includes("..") || /^\d+(?:\.\d+){3}$/u.test(value)) {
    throw new ManagedObjectS3Error("invalid_argument");
  }
  return value;
}

function objectKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > MAXIMUM_OBJECT_KEY_BYTES ||
    control(value)
  ) {
    throw new ManagedObjectS3Error("invalid_argument");
  }
  return value;
}

function uploadIdValue(value: string): string {
  if (!plainText(value, MAXIMUM_UPLOAD_ID_BYTES)) {
    throw new ManagedObjectS3Error("malformed_response");
  }
  return value;
}

function objectPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function plainText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && !control(value)
  );
}

function secret(value: unknown, maximum: number): value is string {
  return plainText(value, maximum);
}

function control(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function positiveBound(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`invalid managed ObjectBucket S3 ${label} bound`);
  }
  return value;
}
