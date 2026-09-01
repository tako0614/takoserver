/** Provider-private runtime surface projected by module-worker.object-bucket. */
export interface EdgeObjects {
  head(key: string): Promise<EdgeObjectMetadata | null>;
  get(key: string, options?: EdgeObjectsGetOptions): Promise<EdgeObjectBody | null>;
  put(
    key: string,
    body: EdgeObjectsBodyInput,
    options?: EdgeObjectsPutOptions,
  ): Promise<{ readonly etag: string; readonly size: number }>;
  delete(key: string): Promise<void>;
  list(options?: EdgeObjectsListOptions): Promise<EdgeObjectsListResult>;
  createMultipartUpload(
    key: string,
    options?: { readonly contentType?: string },
  ): Promise<{ readonly uploadId: string }>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: EdgeObjectsBodyInput,
    options?: EdgeObjectsUploadPartOptions,
  ): Promise<{ readonly etag: string; readonly partNumber: number }>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly { readonly etag: string; readonly partNumber: number }[],
  ): Promise<{ readonly etag: string; readonly size: number }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export type EdgeObjectsBodyInput = ReadableStream<Uint8Array> | ArrayBuffer | string;

export interface EdgeObjectMetadata {
  readonly etag: string;
  readonly size: number;
  readonly contentType?: string;
  readonly uploadedAtMillis?: number;
}

export interface EdgeObjectBody {
  readonly etag: string;
  readonly size: number;
  readonly contentType?: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly partial: boolean;
  readonly range?: { readonly offset: number; readonly length: number };
}

export interface EdgeObjectsGetOptions {
  readonly range?: { readonly offset: number; readonly length?: number };
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
}

export interface EdgeObjectsPutOptions {
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: "*";
}

export interface EdgeObjectsUploadPartOptions {
  readonly contentLength?: number;
}

export interface EdgeObjectsListOptions {
  readonly prefix?: string;
  readonly delimiter?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface EdgeObjectsListResult {
  readonly objects: readonly (Pick<EdgeObjectMetadata, "etag" | "size" | "uploadedAtMillis"> & {
    readonly key: string;
  })[];
  readonly prefixes: readonly string[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface EdgeObjectsR2Object {
  readonly key?: string;
  readonly size: number;
  readonly httpEtag: string;
  readonly uploaded?: Date;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly range?: { readonly offset: number; readonly length: number };
}

export interface EdgeObjectsR2ObjectBody extends EdgeObjectsR2Object {
  readonly body: ReadableStream<Uint8Array>;
}

export interface EdgeObjectsR2MultipartUpload {
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    body: ReadableStream<Uint8Array>,
  ): Promise<{ readonly etag: string }>;
  complete(
    parts: readonly { readonly etag: string; readonly partNumber: number }[],
  ): Promise<EdgeObjectsR2Object>;
  abort(): Promise<void>;
}

export interface EdgeObjectsR2Bucket {
  head(key: string): Promise<EdgeObjectsR2Object | null>;
  get(
    key: string,
    options?: {
      readonly range?: { readonly offset: number; readonly length?: number };
      readonly onlyIf?: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ): Promise<EdgeObjectsR2ObjectBody | EdgeObjectsR2Object | null>;
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly onlyIf?: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ): Promise<EdgeObjectsR2Object | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    readonly prefix?: string;
    readonly delimiter?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<{
    readonly objects: readonly EdgeObjectsR2Object[];
    readonly delimitedPrefixes?: readonly string[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
  createMultipartUpload(
    key: string,
    options?: { readonly httpMetadata?: { readonly contentType?: string } },
  ): Promise<EdgeObjectsR2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): EdgeObjectsR2MultipartUpload;
}

const MAX_KEY_BYTES = 979;
const MAX_OBJECT_BYTES = 5_368_709_120;
const MAX_SINGLE_PUT_BYTES = 314_572_800;
const MAX_PARTS = 10_000;
const MIN_NON_FINAL_PART_BYTES = 5_242_880;

/** Native R2 binding adapter; no bucket name or provider identity crosses it. */
export function createR2EdgeObjects(bucket: EdgeObjectsR2Bucket): EdgeObjects {
  if (!bucket || typeof bucket !== "object") configurationError();
  const multipart = multipartLedger();
  return freeze({
    async head(key, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      try {
        const found = await bucket.head(key);
        return found ? metadata(found) : null;
      } catch (error) {
        const projected = mapped(error, ["invalid_key", "not_found", "backend_unavailable"]);
        if (projected.name === "not_found") return null;
        throw projected;
      }
    },
    async get(key, rawOptions, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      const options = getOptions(rawOptions);
      try {
        if (options.range) {
          const current = await bucket.head(key);
          if (!current) return null;
          if (options.range.offset >= current.size) edgeError("range_not_satisfiable");
        }
        const found = await bucket.get(key, nativeGetOptions(options));
        if (!found) return null;
        if (!("body" in found) || !stream(found.body)) edgeError("precondition_failed");
        const projected = getMetadata(metadata(found));
        const range =
          found.range === undefined
            ? servedRange(options.range, projected.size)
            : providerRange(found.range, projected.size);
        return freeze({
          ...projected,
          body: found.body,
          partial: range !== undefined,
          ...(range ? { range } : {}),
        });
      } catch (error) {
        const projected = mapped(error, [
          "invalid_key",
          "not_found",
          "precondition_failed",
          "range_not_satisfiable",
          "backend_unavailable",
        ]);
        if (projected.name === "not_found") return null;
        throw projected;
      }
    },
    async put(key, body, rawOptions, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      const options = putOptions(rawOptions);
      const source = bodySource(body, MAX_SINGLE_PUT_BYTES, options.contentLength);
      try {
        const written = await bucket.put(key, source.body, {
          ...(options.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
          ...nativeOnlyIf(options),
        });
        if (!written) edgeError("precondition_failed");
        const projected = metadata(written);
        if (projected.size !== source.length) edgeError("invalid_body");
        return freeze({ etag: projected.etag, size: projected.size });
      } catch (error) {
        throw mapped(error, [
          "invalid_key",
          "invalid_body",
          "value_too_large",
          "precondition_failed",
          "backend_unavailable",
        ]);
      }
    },
    async delete(key, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      try {
        await bucket.delete(key);
      } catch (error) {
        throw mapped(error, ["invalid_key", "backend_unavailable"]);
      }
    },
    async list(rawOptions, ...extra: unknown[]) {
      noExtraArguments(extra);
      const options = listOptions(rawOptions);
      try {
        const page = await bucket.list(options);
        if (
          typeof page !== "object" ||
          page === null ||
          !Array.isArray(page.objects) ||
          typeof page.truncated !== "boolean" ||
          (page.delimitedPrefixes !== undefined && !Array.isArray(page.delimitedPrefixes))
        ) {
          edgeError("backend_unavailable");
        }
        const objects = page.objects.map((item) => {
          if (typeof item.key !== "string") edgeError("backend_unavailable");
          providerKey(item.key);
          return freeze({ key: item.key, ...listMetadata(item) });
        });
        if (
          objects.length > (options.limit ?? 1_000) ||
          (page.truncated && !validCursor(page.cursor))
        ) {
          edgeError("backend_unavailable");
        }
        const prefixes =
          page.delimitedPrefixes?.map((value) => {
            if (typeof value !== "string") edgeError("backend_unavailable");
            providerPrefix(value);
            return value;
          }) ?? [];
        const uniquePrefixes = [...new Set(prefixes)];
        if (uniquePrefixes.length > 1_000) edgeError("backend_unavailable");
        return freeze({
          objects,
          prefixes: uniquePrefixes,
          truncated: page.truncated,
          ...(page.truncated ? { cursor: page.cursor as string } : {}),
        });
      } catch (error) {
        throw mapped(error, ["invalid_cursor", "backend_unavailable"]);
      }
    },
    async createMultipartUpload(key, options, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      const contentType = multipartOptions(options);
      try {
        const upload = await bucket.createMultipartUpload(
          key,
          contentType ? { httpMetadata: { contentType } } : undefined,
        );
        if (!validOpaque(upload.uploadId, 256)) edgeError("backend_unavailable");
        multipart.open(key, upload.uploadId);
        return freeze({ uploadId: upload.uploadId });
      } catch (error) {
        throw mapped(error, ["invalid_key", "backend_unavailable"]);
      }
    },
    async uploadPart(key, uploadId, partNumber, body, rawOptions, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      validUpload(uploadId);
      validPartNumber(partNumber);
      const options = uploadPartOptions(rawOptions);
      const source = bodySource(body, MAX_OBJECT_BYTES, options.contentLength, "invalid_body");
      try {
        const part = await bucket
          .resumeMultipartUpload(key, uploadId)
          .uploadPart(partNumber, source.body);
        const etag = validEtag(part.etag);
        multipart.part(key, uploadId, { etag, partNumber, size: source.length });
        return freeze({ etag, partNumber });
      } catch (error) {
        throw mapped(error, [
          "invalid_key",
          "invalid_body",
          "upload_not_found",
          "backend_unavailable",
        ]);
      }
    },
    async completeMultipartUpload(key, uploadId, parts, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      validUpload(uploadId);
      const exact = validParts(parts);
      multipart.complete(key, uploadId, exact);
      try {
        const complete = await bucket.resumeMultipartUpload(key, uploadId).complete(exact);
        const projected = metadata(complete);
        multipart.close(key, uploadId);
        return freeze({ etag: projected.etag, size: projected.size });
      } catch (error) {
        throw mappedComplete(error);
      }
    },
    async abortMultipartUpload(key, uploadId, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      validUpload(uploadId);
      try {
        await bucket.resumeMultipartUpload(key, uploadId).abort();
        multipart.close(key, uploadId);
      } catch (error) {
        throw mapped(error, ["invalid_key", "upload_not_found", "backend_unavailable"]);
      }
    },
  });
}

export interface PrivateS3EdgeObjectsOptions {
  readonly endpoint: string;
  readonly bucketName: string;
  readonly region: string;
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now?: () => Date;
}

/** Private S3 transport adapter. Configuration is sealed and never projected to a Resource. */
export function createPrivateS3EdgeObjects(input: PrivateS3EdgeObjectsOptions): EdgeObjects {
  const backend = sealS3(input);
  const multipart = multipartLedger();
  const call = async (
    method: string,
    key: string | null,
    query: Readonly<Record<string, string>> = {},
    headers: HeadersInit = {},
    body?: ReadableStream<Uint8Array> | string,
    allowedTransportErrors: readonly string[] = [],
  ): Promise<Response> => {
    const target = s3Target(backend, key, query);
    try {
      const signed = await signedS3Request(backend, method, target, headers, body);
      return await backend.fetch(signed);
    } catch (error) {
      const name = providerErrorName(error);
      if (name !== undefined && allowedTransportErrors.includes(name)) throw namedError(name);
      edgeError("backend_unavailable");
    }
  };
  return freeze({
    async head(key, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      const response = await call("HEAD", key);
      if (response.status === 404) return null;
      requireStatus(response, [200]);
      return metadataHeaders(response.headers);
    },
    async get(key, rawOptions, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      const options = getOptions(rawOptions);
      const headers = new Headers();
      if (options.ifMatch) transportHeader(headers, "if-match", options.ifMatch);
      if (options.ifNoneMatch) transportHeader(headers, "if-none-match", options.ifNoneMatch);
      if (options.range) {
        const end = options.range.length
          ? options.range.offset + options.range.length - 1
          : undefined;
        transportHeader(headers, "range", `bytes=${options.range.offset}-${end ?? ""}`);
      }
      const response = await call("GET", key, {}, headers);
      if (response.status === 404) return null;
      if (response.status === 412 || response.status === 304) edgeError("precondition_failed");
      if (response.status === 416) edgeError("range_not_satisfiable");
      requireStatus(response, options.range ? [206] : [200]);
      if (!response.body) edgeError("backend_unavailable");
      const projected = getMetadata(metadataHeaders(response.headers, options.range !== undefined));
      const range =
        response.status === 206 ? contentRange(response.headers, projected.size) : undefined;
      return freeze({
        ...projected,
        body: response.body,
        partial: response.status === 206,
        ...(range ? { range } : {}),
      });
    },
    async put(key, body, rawOptions, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      const options = putOptions(rawOptions);
      const source = bodySource(body, MAX_SINGLE_PUT_BYTES, options.contentLength);
      const headers = new Headers();
      transportHeader(headers, "content-length", String(source.length));
      if (options.contentType) transportHeader(headers, "content-type", options.contentType);
      if (options.ifMatch) transportHeader(headers, "if-match", options.ifMatch);
      if (options.ifNoneMatch) transportHeader(headers, "if-none-match", options.ifNoneMatch);
      const response = await call("PUT", key, {}, headers, source.body, ["invalid_body"]);
      if (response.status === 412) edgeError("precondition_failed");
      requireStatus(response, [200, 201]);
      const etag = validEtag(response.headers.get("etag"));
      await discard(response);
      return freeze({ etag, size: source.length });
    },
    async delete(key, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      const response = await call("DELETE", key);
      requireStatus(response, [200, 204, 404]);
      await discard(response);
    },
    async list(rawOptions, ...extra: unknown[]) {
      noExtraArguments(extra);
      const options = listOptions(rawOptions);
      const response = await call("GET", null, {
        "list-type": "2",
        ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
        ...(options.cursor !== undefined ? { "continuation-token": options.cursor } : {}),
        "max-keys": String(options.limit ?? 1_000),
      });
      if (response.status === 400 && options.cursor) edgeError("invalid_cursor");
      requireStatus(response, [200]);
      return parseListXml(await boundedText(response));
    },
    async createMultipartUpload(key, options, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      const headers = new Headers();
      const contentType = multipartOptions(options);
      if (contentType) transportHeader(headers, "content-type", contentType);
      const response = await call("POST", key, { uploads: "" }, headers);
      requireStatus(response, [200]);
      const uploadId = xmlRequired(await boundedText(response), "UploadId");
      validUpload(uploadId);
      multipart.open(key, uploadId);
      return freeze({ uploadId });
    },
    async uploadPart(key, uploadId, partNumber, body, rawOptions, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      validUpload(uploadId);
      validPartNumber(partNumber);
      const options = uploadPartOptions(rawOptions);
      const source = bodySource(body, MAX_OBJECT_BYTES, options.contentLength, "invalid_body");
      const headers = new Headers();
      transportHeader(headers, "content-length", String(source.length));
      const response = await call(
        "PUT",
        key,
        { partNumber: String(partNumber), uploadId },
        headers,
        source.body,
        ["invalid_body"],
      );
      if (response.status === 404) edgeError("upload_not_found");
      requireStatus(response, [200]);
      const etag = validEtag(response.headers.get("etag"));
      await discard(response);
      multipart.part(key, uploadId, { etag, partNumber, size: source.length });
      return freeze({ etag, partNumber });
    },
    async completeMultipartUpload(key, uploadId, parts, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      validUpload(uploadId);
      const exact = validParts(parts);
      multipart.complete(key, uploadId, exact);
      try {
        const document = `<CompleteMultipartUpload>${exact
          .map(
            (part) =>
              `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
          )
          .join("")}</CompleteMultipartUpload>`;
        const response = await call(
          "POST",
          key,
          { uploadId },
          { "content-type": "application/xml" },
          document,
        );
        if (response.status === 404) edgeError("upload_not_found");
        if (response.status === 400) edgeError("invalid_part");
        requireStatus(response, [200]);
        const bodyText = await boundedText(response);
        const etag = validEtag(xmlRequired(bodyText, "ETag"));
        const head = await call("HEAD", key);
        requireStatus(head, [200]);
        multipart.close(key, uploadId);
        return freeze({ etag, size: metadataHeaders(head.headers).size });
      } catch (error) {
        throw mappedComplete(error);
      }
    },
    async abortMultipartUpload(key, uploadId, ...extra: unknown[]) {
      noExtraArguments(extra);
      validKey(key);
      validUpload(uploadId);
      const response = await call("DELETE", key, { uploadId });
      if (response.status === 404) edgeError("upload_not_found");
      requireStatus(response, [204]);
      await discard(response);
      multipart.close(key, uploadId);
    },
  });
}

interface SealedS3 {
  readonly endpoint: string;
  readonly bucketName: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly now: () => Date;
}

function sealS3(input: PrivateS3EdgeObjectsOptions): SealedS3 {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    configurationError();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    input.endpoint !== endpoint.origin ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(input.bucketName) ||
    input.bucketName.includes("..") ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(input.region) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/u.test(input.credentials.accessKeyId) ||
    !printable(input.credentials.secretAccessKey, 1, 4_096) ||
    (input.credentials.sessionToken !== undefined &&
      !printable(input.credentials.sessionToken, 1, 16_384))
  ) {
    configurationError();
  }
  return freeze({
    endpoint: endpoint.origin,
    bucketName: input.bucketName,
    region: input.region,
    accessKeyId: input.credentials.accessKeyId,
    secretAccessKey: input.credentials.secretAccessKey,
    ...(input.credentials.sessionToken ? { sessionToken: input.credentials.sessionToken } : {}),
    fetch: input.fetch ?? ((request) => fetch(request)),
    now: input.now ?? (() => new Date()),
  });
}

function s3Target(
  backend: SealedS3,
  key: string | null,
  query: Readonly<Record<string, string>>,
): URL {
  const path = `/${awsEncode(backend.bucketName)}${key === null ? "" : `/${key.split("/").map(awsEncode).join("/")}`}`;
  const target = new URL(`${backend.endpoint}${path}`);
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
  return target;
}

async function signedS3Request(
  backend: SealedS3,
  method: string,
  target: URL,
  inputHeaders: HeadersInit,
  body?: ReadableStream<Uint8Array> | string,
): Promise<Request> {
  const now = backend.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) configurationError();
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = timestamp.slice(0, 8);
  const headers = new Headers(inputHeaders);
  headers.set("host", target.host);
  headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
  headers.set("x-amz-date", timestamp);
  if (backend.sessionToken) headers.set("x-amz-security-token", backend.sessionToken);
  const canonicalHeaders = [...headers.entries()]
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/gu, " ")] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");
  const canonicalQuery = [...target.searchParams.entries()]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue.localeCompare(rightValue)
        : leftName.localeCompare(rightName),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    method,
    target.pathname,
    canonicalQuery,
    canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${date}/${backend.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, await sha256Text(canonicalRequest)].join(
    "\n",
  );
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${backend.secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, backend.region);
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${backend.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${hex(await hmac(signingKey, toSign))}`,
  );
  return new Request(target, {
    method,
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
  });
}

function transportHeader(headers: Headers, name: string, value: string): void {
  try {
    headers.set(name, value);
  } catch {
    edgeError("backend_unavailable");
  }
}

function metadata(value: EdgeObjectsR2Object): EdgeObjectMetadata {
  return freeze({
    etag: validEtag(value.httpEtag),
    size: validSize(value.size),
    ...(value.httpMetadata?.contentType
      ? { contentType: optionalContentType(value.httpMetadata.contentType) as string }
      : {}),
    ...(value.uploaded ? { uploadedAtMillis: validUploaded(value.uploaded.getTime()) } : {}),
  });
}

function metadataHeaders(headers: Headers, ranged = false): EdgeObjectMetadata {
  const contentRangeValue = ranged ? headers.get("content-range") : null;
  const size = contentRangeValue
    ? contentRangeSize(contentRangeValue)
    : requiredContentLength(headers);
  const lastModified = headers.get("last-modified");
  const contentType = headers.get("content-type");
  return freeze({
    etag: validEtag(headers.get("etag")),
    size: validSize(size),
    ...(contentType ? { contentType: optionalContentType(contentType) as string } : {}),
    ...(lastModified ? { uploadedAtMillis: validUploaded(Date.parse(lastModified)) } : {}),
  });
}

function requiredContentLength(headers: Headers): number {
  const value = headers.get("content-length");
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    edgeError("backend_unavailable");
  }
  return validSize(Number(value));
}

function contentRangeSize(value: string): number {
  const match = /^bytes \d+-\d+\/(\d+)$/u.exec(value);
  if (!match) edgeError("backend_unavailable");
  return validSize(Number(match[1]));
}

function getMetadata(value: EdgeObjectMetadata): Omit<EdgeObjectMetadata, "uploadedAtMillis"> {
  return freeze({
    etag: value.etag,
    size: value.size,
    ...(value.contentType === undefined ? {} : { contentType: value.contentType }),
  });
}

function listMetadata(
  value: EdgeObjectsR2Object,
): Pick<EdgeObjectMetadata, "etag" | "size" | "uploadedAtMillis"> {
  const projected = metadata(value);
  return freeze({
    etag: projected.etag,
    size: projected.size,
    ...(projected.uploadedAtMillis === undefined
      ? {}
      : { uploadedAtMillis: projected.uploadedAtMillis }),
  });
}

function contentRange(
  headers: Headers,
  expectedSize: number,
): { readonly offset: number; readonly length: number } {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(headers.get("content-range") ?? "");
  if (!match) edgeError("backend_unavailable");
  const offset = Number(match[1]);
  const end = Number(match[2]);
  const size = Number(match[3]);
  const length = end - offset + 1;
  const contentLength = requiredContentLength(headers);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    end < offset ||
    size !== expectedSize ||
    end >= size ||
    contentLength !== length
  ) {
    edgeError("backend_unavailable");
  }
  return freeze({ offset, length });
}

function bodySource(
  value: EdgeObjectsBodyInput,
  maximum: number,
  declaredLength: number | undefined,
  intrinsicTooLargeError: "invalid_body" | "value_too_large" = "value_too_large",
): { readonly body: ReadableStream<Uint8Array>; readonly length: number } {
  let body: ReadableStream<Uint8Array>;
  let known: number | undefined;
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    known = bytes.byteLength;
    body = new Blob([bytes]).stream();
  } else if (value instanceof ArrayBuffer) {
    known = value.byteLength;
    body = new Blob([value]).stream();
  } else if (stream(value)) {
    body = value;
  } else {
    bindingTypeError();
  }
  if (
    declaredLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
  ) {
    edgeError("invalid_body");
  }
  const length = declaredLength ?? known;
  if (length === undefined || (known !== undefined && length !== known)) {
    edgeError("invalid_body");
  }
  if (length > maximum) edgeError(known === undefined ? "value_too_large" : intrinsicTooLargeError);
  return freeze({ body: exactLengthBody(body, length), length });
}

function exactLengthBody(
  body: ReadableStream<Uint8Array>,
  expected: number,
): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) edgeError("invalid_body");
        received += chunk.byteLength;
        if (!Number.isSafeInteger(received) || received > expected) edgeError("invalid_body");
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== expected) edgeError("invalid_body");
      },
    }),
  );
}

function getOptions(value: EdgeObjectsGetOptions | undefined): EdgeObjectsGetOptions {
  if (value === undefined) return freeze({});
  exactOptionKeys(value, ["range", "ifMatch", "ifNoneMatch"]);
  const ifMatch = value.ifMatch === undefined ? undefined : conditionEtag(value.ifMatch);
  const ifNoneMatch =
    value.ifNoneMatch === undefined ? undefined : conditionEtag(value.ifNoneMatch);
  if (ifMatch !== undefined && ifNoneMatch !== undefined) bindingTypeError();
  const range = value.range;
  if (range !== undefined) {
    exactOptionKeys(range, ["offset", "length"]);
    if (
      typeof range.offset !== "number" ||
      (range.length !== undefined && typeof range.length !== "number")
    ) {
      bindingTypeError();
    }
  }
  if (
    range !== undefined &&
    (!Number.isSafeInteger(range.offset) ||
      range.offset < 0 ||
      range.offset > MAX_OBJECT_BYTES ||
      (range.length !== undefined &&
        (!Number.isSafeInteger(range.length) ||
          range.length < 1 ||
          range.length > MAX_OBJECT_BYTES)))
  ) {
    bindingTypeError();
  }
  return freeze({
    ...(range ? { range: freeze({ ...range }) } : {}),
    ...(ifMatch !== undefined ? { ifMatch } : {}),
    ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
  });
}

function putOptions(value: EdgeObjectsPutOptions | undefined): EdgeObjectsPutOptions {
  if (value === undefined) return freeze({});
  exactOptionKeys(value, ["contentLength", "contentType", "ifMatch", "ifNoneMatch"]);
  const hasContentLength = Object.hasOwn(value, "contentLength");
  const ifMatch = value.ifMatch === undefined ? undefined : conditionEtag(value.ifMatch);
  if (value.ifNoneMatch !== undefined && typeof value.ifNoneMatch !== "string") bindingTypeError();
  const ifNoneMatch = value.ifNoneMatch;
  if (ifMatch !== undefined && ifNoneMatch !== undefined) bindingTypeError();
  if (ifNoneMatch !== undefined && ifNoneMatch !== "*") bindingTypeError();
  return freeze({
    ...(hasContentLength ? { contentLength: validContentLength(value.contentLength) } : {}),
    ...(value.contentType !== undefined
      ? { contentType: inputContentType(value.contentType) }
      : {}),
    ...(ifMatch !== undefined ? { ifMatch } : {}),
    ...(ifNoneMatch !== undefined ? { ifNoneMatch: "*" as const } : {}),
  });
}

function uploadPartOptions(
  value: EdgeObjectsUploadPartOptions | undefined,
): EdgeObjectsUploadPartOptions {
  if (value === undefined) return freeze({});
  exactOptionKeys(value, ["contentLength"]);
  return freeze({
    ...(Object.hasOwn(value, "contentLength")
      ? { contentLength: validContentLength(value.contentLength) }
      : {}),
  });
}

function validContentLength(value: unknown): number {
  if (typeof value !== "number") bindingTypeError();
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OBJECT_BYTES) {
    edgeError("invalid_body");
  }
  return value as number;
}

function listOptions(value: EdgeObjectsListOptions | undefined): EdgeObjectsListOptions {
  if (value === undefined) return freeze({});
  exactOptionKeys(value, ["prefix", "delimiter", "cursor", "limit"]);
  if (value.prefix !== undefined && typeof value.prefix !== "string") bindingTypeError();
  if (value.prefix !== undefined) validPrefix(value.prefix);
  if (value.delimiter !== undefined && typeof value.delimiter !== "string") bindingTypeError();
  if (
    value.delimiter !== undefined &&
    (codePointLength(value.delimiter) < 1 || codePointLength(value.delimiter) > 16)
  ) {
    bindingTypeError();
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") bindingTypeError();
  if (value.cursor !== undefined && !validCursor(value.cursor)) bindingTypeError();
  if (value.limit !== undefined && typeof value.limit !== "number") bindingTypeError();
  if (
    value.limit !== undefined &&
    (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 1_000)
  ) {
    bindingTypeError();
  }
  return freeze({ ...value });
}

function multipartOptions(
  value: { readonly contentType?: string } | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  exactOptionKeys(value, ["contentType"]);
  if (value.contentType !== undefined && typeof value.contentType !== "string") {
    bindingTypeError();
  }
  return value.contentType === undefined ? undefined : inputContentType(value.contentType);
}

function inputContentType(value: unknown): string {
  if (typeof value !== "string") bindingTypeError();
  if (codePointLength(value) < 1 || codePointLength(value) > 256 || hasControlCharacters(value)) {
    bindingTypeError();
  }
  return value;
}

function conditionEtag(value: unknown): string {
  if (typeof value !== "string") bindingTypeError();
  if (codePointLength(value) < 1 || codePointLength(value) > 256 || hasControlCharacters(value)) {
    bindingTypeError();
  }
  return value;
}

function nativeGetOptions(options: EdgeObjectsGetOptions) {
  return {
    ...(options.range ? { range: options.range } : {}),
    ...(options.ifMatch || options.ifNoneMatch
      ? {
          onlyIf: {
            ...(options.ifMatch ? { etagMatches: options.ifMatch } : {}),
            ...(options.ifNoneMatch ? { etagDoesNotMatch: options.ifNoneMatch } : {}),
          },
        }
      : {}),
  };
}

function nativeOnlyIf(options: EdgeObjectsPutOptions) {
  return options.ifMatch || options.ifNoneMatch
    ? {
        onlyIf: {
          ...(options.ifMatch ? { etagMatches: options.ifMatch } : {}),
          ...(options.ifNoneMatch ? { etagDoesNotMatch: "*" } : {}),
        },
      }
    : {};
}

function servedRange(
  range: EdgeObjectsGetOptions["range"],
  size: number,
): { readonly offset: number; readonly length: number } | undefined {
  if (!range) return undefined;
  return freeze({
    offset: range.offset,
    length: Math.min(range.length ?? size, size - range.offset),
  });
}

function providerRange(
  value: unknown,
  size: number,
): { readonly offset: number; readonly length: number } {
  if (!plainRecord(value)) edgeError("backend_unavailable");
  const keys = Object.keys(value);
  if (
    Reflect.ownKeys(value).length !== 2 ||
    keys.length !== 2 ||
    !keys.includes("offset") ||
    !keys.includes("length") ||
    !Number.isSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.length) ||
    (value.offset as number) < 0 ||
    (value.length as number) < 1 ||
    (value.offset as number) + (value.length as number) > size
  ) {
    edgeError("backend_unavailable");
  }
  return freeze({ offset: value.offset as number, length: value.length as number });
}

function validParts(
  value: readonly { readonly etag: string; readonly partNumber: number }[],
): readonly { readonly etag: string; readonly partNumber: number }[] {
  if (!Array.isArray(value)) bindingTypeError();
  if (value.length < 1 || value.length > MAX_PARTS) bindingTypeError();
  let previous = 0;
  const result = value.map((part) => {
    exactOptionKeys(part, ["etag", "partNumber"]);
    validPartNumber(part.partNumber);
    if (part.partNumber <= previous) edgeError("invalid_part");
    previous = part.partNumber;
    return freeze({ etag: validPartEtag(part.etag), partNumber: part.partNumber });
  });
  return freeze(result);
}

function parseListXml(value: string): EdgeObjectsListResult {
  rejectUnsafeXml(value);
  const objects = [...value.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)].map((match) => {
    const body = match[1] ?? "";
    const key = xmlRequired(body, "Key");
    providerKey(key);
    return freeze({
      key,
      etag: validEtag(xmlRequired(body, "ETag")),
      size: validSize(Number(xmlRequired(body, "Size"))),
      ...(xmlOptional(body, "LastModified")
        ? {
            uploadedAtMillis: validUploaded(
              Date.parse(xmlOptional(body, "LastModified") as string),
            ),
          }
        : {}),
    });
  });
  const prefixes = [
    ...value.matchAll(
      /<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/gu,
    ),
  ].map((match) => xmlDecode(match[1] ?? ""));
  if (objects.length > 1_000 || prefixes.length > 1_000) edgeError("backend_unavailable");
  for (const prefix of prefixes) providerPrefix(prefix);
  const truncatedValue = xmlRequired(value, "IsTruncated");
  if (truncatedValue !== "true" && truncatedValue !== "false") {
    edgeError("backend_unavailable");
  }
  const truncated = truncatedValue === "true";
  const cursor = xmlOptional(value, "NextContinuationToken");
  if (truncated && !validCursor(cursor)) edgeError("backend_unavailable");
  return freeze({
    objects,
    prefixes: [...new Set(prefixes)],
    truncated,
    ...(truncated ? { cursor: cursor as string } : {}),
  });
}

function xmlRequired(value: string, name: string): string {
  rejectUnsafeXml(value);
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u").exec(value)?.[1];
  if (found === undefined) edgeError("backend_unavailable");
  return xmlDecode(found);
}

function xmlOptional(value: string, name: string): string | null {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u").exec(value)?.[1];
  return found === undefined ? null : xmlDecode(found);
}

function rejectUnsafeXml(value: string): void {
  if (/<!DOCTYPE|<!ENTITY/iu.test(value)) edgeError("backend_unavailable");
}

function xmlDecode(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/u.test(value)) edgeError("backend_unavailable");
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function boundedText(response: Response): Promise<string> {
  const value = await response.text();
  if (new TextEncoder().encode(value).byteLength > 2 * 1024 * 1024)
    edgeError("backend_unavailable");
  return value;
}

function requireStatus(response: Response, expected: readonly number[]): void {
  if (!expected.includes(response.status)) edgeError("backend_unavailable");
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Discarding a provider response cannot change the completed operation.
  }
}

function validKey(value: unknown): asserts value is string {
  if (typeof value !== "string") bindingTypeError();
  if (
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES ||
    hasControlCharacters(value)
  ) {
    edgeError("invalid_key");
  }
}

function validPrefix(value: unknown): asserts value is string {
  if (typeof value !== "string") bindingTypeError();
  if (new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES || hasControlCharacters(value)) {
    bindingTypeError();
  }
}

function validSize(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_OBJECT_BYTES
  ) {
    edgeError("backend_unavailable");
  }
  return value as number;
}

function validUploaded(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) edgeError("backend_unavailable");
  return value as number;
}

function validEtag(value: unknown): string {
  if (
    typeof value !== "string" ||
    codePointLength(value) < 1 ||
    codePointLength(value) > 256 ||
    hasControlCharacters(value)
  ) {
    edgeError("backend_unavailable");
  }
  return value;
}

function optionalContentType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    codePointLength(value) < 1 ||
    codePointLength(value) > 256 ||
    hasControlCharacters(value)
  ) {
    edgeError("backend_unavailable");
  }
  return value;
}

function validCursor(value: unknown): value is string {
  return (
    typeof value === "string" && codePointLength(value) >= 1 && codePointLength(value) <= 4_096
  );
}

function validUpload(value: unknown): asserts value is string {
  if (typeof value !== "string") bindingTypeError();
  if (!validOpaque(value, 256)) bindingTypeError();
}

function validOpaque(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !hasControlCharacters(value)
  );
}

function validPartNumber(value: unknown): asserts value is number {
  if (typeof value !== "number") bindingTypeError();
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PARTS) bindingTypeError();
}

function validPartEtag(value: unknown): string {
  if (typeof value !== "string") bindingTypeError();
  if (codePointLength(value) < 1 || codePointLength(value) > 256 || hasControlCharacters(value)) {
    bindingTypeError();
  }
  return value;
}

function multipartLedger(): {
  readonly open: (key: string, uploadId: string) => void;
  readonly part: (
    key: string,
    uploadId: string,
    part: { readonly etag: string; readonly partNumber: number; readonly size: number },
  ) => void;
  readonly complete: (
    key: string,
    uploadId: string,
    parts: readonly { readonly etag: string; readonly partNumber: number }[],
  ) => void;
  readonly close: (key: string, uploadId: string) => void;
} {
  const uploads = new Map<string, Map<number, { readonly etag: string; readonly size: number }>>();
  const identity = (key: string, uploadId: string): string => `${key}\0${uploadId}`;
  return freeze({
    open(key, uploadId) {
      uploads.set(identity(key, uploadId), new Map());
    },
    part(key, uploadId, part) {
      uploads
        .get(identity(key, uploadId))
        ?.set(part.partNumber, freeze({ etag: part.etag, size: part.size }));
    },
    complete(key, uploadId, parts) {
      const known = uploads.get(identity(key, uploadId));
      if (!known) return;
      let total = 0;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index] as { readonly etag: string; readonly partNumber: number };
        const recorded = known.get(part.partNumber);
        if (
          !recorded ||
          recorded.etag !== part.etag ||
          (index < parts.length - 1 && recorded.size < MIN_NON_FINAL_PART_BYTES)
        ) {
          edgeError("invalid_part");
        }
        if (
          !Number.isSafeInteger(total) ||
          !Number.isSafeInteger(recorded.size) ||
          recorded.size > MAX_OBJECT_BYTES - total
        ) {
          edgeError("value_too_large");
        }
        total += recorded.size;
      }
    },
    close(key, uploadId) {
      uploads.delete(identity(key, uploadId));
    },
  });
}

function providerKey(value: string): void {
  if (
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES ||
    hasControlCharacters(value)
  ) {
    edgeError("backend_unavailable");
  }
}

function providerPrefix(value: string): void {
  if (
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES ||
    hasControlCharacters(value)
  ) {
    edgeError("backend_unavailable");
  }
}

function exactOptionKeys(value: unknown, allowed: readonly string[]): void {
  if (!plainRecord(value)) bindingTypeError();
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !allowed.includes(key))) {
    bindingTypeError();
  }
}

function noExtraArguments(extra: readonly unknown[]): void {
  if (extra.length > 0) bindingTypeError();
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) index += 1;
    }
    length += 1;
  }
  return length;
}

function mapped(error: unknown, allowed: readonly string[]): Error {
  const name = providerErrorName(error);
  if (name !== undefined && allowed.includes(name)) return namedError(name);
  return namedError("backend_unavailable");
}

function mappedComplete(error: unknown): Error {
  const name = providerErrorName(error);
  if (
    name !== undefined &&
    ["invalid_part", "upload_not_found", "value_too_large", "backend_unavailable"].includes(name)
  ) {
    return namedError(name);
  }
  return namedError("backend_unavailable");
}

function providerErrorName(error: unknown): string | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  try {
    const name = (error as { readonly name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function edgeError(name: string): never {
  throw namedError(name);
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function configurationError(): never {
  throw new TypeError("invalid private edge.objects adapter configuration");
}

function bindingTypeError(): never {
  throw new TypeError("invalid module-worker.object-bucket arguments");
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!record(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stream(value: unknown): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream;
}

function printable(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function awsEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(
      /[!'()*]/gu,
      (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .replace(/%[0-9a-f]{2}/gu, (part) => part.toUpperCase());
}

async function sha256Text(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)),
  );
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}
