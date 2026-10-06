import type { JsonObject } from "../ports.ts";
import { parseStrictJson, StrictJsonError } from "../strict-json.ts";
import type { TakoformV2Engine } from "./engine.ts";
import { isV2FormUrl, isV2HttpsUrl, parseV2BaseUrl } from "./identity.ts";
import type { TakoformV2Error, V2Operation } from "./types.ts";

const API = "forms.takoform.com/v2" as const;
const DISCOVERY_PATH = "/.well-known/takoform/v2";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const GENERATION = /^[1-9][0-9]*$/u;

/** Identity and authority of this request's current credential, never shared mutable state. */
export interface TakoformV2HttpPrincipal {
  readonly principal: string;
  readonly access: "read" | "write";
}

export interface TakoformV2HttpOptions {
  baseUrl: string;
  documentation: string;
  authenticationDocumentation: string;
  authenticationSchemes: readonly string[];
  maxRequestBytes: number;
  maxPageSize: number;
  replayWindowSeconds: number;
  /** Stable operator-managed HMAC key for pagination cursor authentication. */
  cursorSigningKey: Uint8Array;
  /** Stable owner identity and current credential rights; write includes read. */
  authenticate(request: Request): Promise<TakoformV2HttpPrincipal | null>;
}

export interface TakoformV2Router {
  fetch(request: Request): Promise<Response | null>;
}

interface HttpConfig {
  base: URL;
  rootPath: string;
  baseUrl: string;
  cursorKey: Promise<CryptoKey>;
}

function validateHttpOptions(options: TakoformV2HttpOptions, engine: TakoformV2Engine): HttpConfig {
  const parsed = parseV2BaseUrl(options.baseUrl);
  const base = parsed.url;
  if (!isV2HttpsUrl(options.documentation) || !isV2HttpsUrl(options.authenticationDocumentation)) {
    throw new TypeError("documentation URLs must be absolute HTTPS URLs");
  }
  if (
    !Number.isSafeInteger(options.maxRequestBytes) ||
    options.maxRequestBytes < 1 ||
    !Number.isSafeInteger(options.maxPageSize) ||
    options.maxPageSize < 1 ||
    !Number.isSafeInteger(options.replayWindowSeconds) ||
    options.replayWindowSeconds < 1 ||
    options.authenticationSchemes.length === 0 ||
    options.authenticationSchemes.some(
      (scheme) => typeof scheme !== "string" || scheme.length === 0,
    ) ||
    !(options.cursorSigningKey instanceof Uint8Array) ||
    options.cursorSigningKey.byteLength < 32
  ) {
    throw new TypeError("invalid Takoform v2 HTTP limits or authentication declaration");
  }
  for (const form of engine.formUrls) {
    if (!isFormUrl(form)) throw new TypeError("Form keys must be exact absolute HTTPS Form URLs");
  }
  const keyMaterial = asArrayBuffer(options.cursorSigningKey);
  const cursorKey = crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return { base, rootPath: parsed.path, baseUrl: options.baseUrl, cursorKey };
}

export function createTakoformV2Routes(
  engine: TakoformV2Engine,
  options: TakoformV2HttpOptions,
): TakoformV2Router {
  const config = validateHttpOptions(options, engine);
  return { fetch: (request) => route(request, engine, options, config) };
}

async function route(
  request: Request,
  engine: TakoformV2Engine,
  options: TakoformV2HttpOptions,
  config: HttpConfig,
): Promise<Response | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.pathname === DISCOVERY_PATH && url.origin === config.base.origin) {
    if (request.method !== "GET") return problem(405, "method_not_allowed", { allow: "GET" });
    if (url.search !== "") return problem(400, "invalid_request");
    return json({
      api: API,
      baseUrl: options.baseUrl,
      documentation: options.documentation,
      authentication: {
        schemes: [...options.authenticationSchemes],
        documentation: options.authenticationDocumentation,
      },
      capabilities: { offerings: false, previews: false, privateInputs: false },
      limits: {
        maxRequestBytes: options.maxRequestBytes,
        maxPageSize: options.maxPageSize,
        replayWindowSeconds: options.replayWindowSeconds,
      },
    });
  }
  if (url.origin !== config.base.origin || !isUnderRoot(url.pathname, config.rootPath)) return null;
  const routePath = url.pathname.slice(config.rootPath.length) || "/";
  if (!isV2Route(routePath)) return null;

  try {
    const identity = await options.authenticate(request);
    if (
      !identity ||
      typeof identity.principal !== "string" ||
      identity.principal.length === 0 ||
      (identity.access !== "read" && identity.access !== "write")
    ) {
      return problem(401, "unauthenticated", {
        wwwAuthenticate: options.authenticationSchemes.join(", "),
      });
    }
    return await authenticatedRoute(request, url, routePath, identity, engine, options, config);
  } catch (error) {
    return asProblem(error, options);
  }
}

function isV2Route(path: string): boolean {
  return (
    path === "/support" ||
    path === "/resources" ||
    path === "/offerings" ||
    path === "/previews" ||
    /^\/resources\/[^/]+$/u.test(path) ||
    /^\/operations\/[^/]+$/u.test(path) ||
    /^\/operations\/[^/]+\/private-inputs$/u.test(path)
  );
}

async function authenticatedRoute(
  request: Request,
  url: URL,
  path: string,
  identity: TakoformV2HttpPrincipal,
  engine: TakoformV2Engine,
  options: TakoformV2HttpOptions,
  config: HttpConfig,
): Promise<Response> {
  // Copy the authenticated grant before any body read or asynchronous engine call.
  // The stable owner may have several credentials with different permissions.
  const { principal, access } = identity;
  if (
    path === "/offerings" ||
    path === "/previews" ||
    /^\/operations\/[^/]+\/private-inputs$/u.test(path)
  ) {
    return problem(404, "capability_unavailable");
  }
  if (path === "/support") {
    if (request.method !== "GET") return problem(405, "method_not_allowed", { allow: "GET" });
    const query = strictQuery(url, ["form"]);
    const form = query.get("form");
    if (form === undefined || !isFormUrl(form)) throw invalidRequest();
    const supported = engine.formUrls.includes(form);
    return json({
      form,
      supported,
      operations: supported ? ["create", "read", "update", "delete"] : [],
      privateInputs: false,
    });
  }
  if (path === "/resources" && request.method === "POST") {
    if (access !== "write") return problem(403, "forbidden");
    rejectQuery(url);
    const key = idempotencyKey(request);
    const input = await readJsonObject(request, options.maxRequestBytes);
    if (Object.hasOwn(input, "privateInputs")) throw capabilityRequired();
    if (Object.hasOwn(input, "offering")) throw capabilityRequired();
    exactKeys(input, ["form", "space", "name", "spec"]);
    if (typeof input.form !== "string" || !isFormUrl(input.form)) throw invalidRequest();
    const space = identifier(input.space);
    const name = identifier(input.name);
    const spec = jsonObject(input.spec);
    const operation = await engine.acceptCreate({
      principal,
      key,
      input: { form: input.form, space, name, spec },
    });
    return operationResponse(operation, config);
  }
  if (path === "/resources" && request.method === "GET") {
    const query = strictQuery(url, ["space", "name", "form", "limit", "cursor"]);
    const space = optionalIdentifier(query.get("space"));
    const name = optionalIdentifier(query.get("name"));
    const form = optionalFormUrl(query.get("form"));
    const limit = pageLimit(query.get("limit"), options.maxPageSize);
    const cursor = query.get("cursor");
    const filters = {
      ...(space === undefined ? {} : { space }),
      ...(name === undefined ? {} : { name }),
      ...(form === undefined ? {} : { form }),
    };
    const afterUid =
      cursor === undefined
        ? undefined
        : await decodeCursor(cursor, principal, filters, await config.cursorKey);
    const items = await engine.listResources({
      principal,
      ...(space === undefined ? {} : { space }),
      ...(name === undefined ? {} : { name }),
      ...(form === undefined ? {} : { form }),
      limit: limit + 1,
      ...(afterUid === undefined ? {} : { afterUid }),
    });
    const hasMore = items.length > limit;
    const visible = hasMore ? items.slice(0, limit) : items;
    const last = visible.at(-1);
    const nextCursor =
      hasMore && last
        ? await encodeCursor(principal, filters, last.uid, await config.cursorKey)
        : null;
    return json({ items: visible, nextCursor });
  }
  if (path === "/resources") return problem(405, "method_not_allowed", { allow: "GET, POST" });
  const resourceMatch = /^\/resources\/([^/]+)$/u.exec(path);
  if (resourceMatch) {
    const uid = decodedIdentifier(resourceMatch[1] ?? "");
    if (request.method === "GET") {
      rejectQuery(url);
      return json(await engine.getResource({ principal, uid }));
    }
    if (request.method === "PUT") {
      if (access !== "write") return problem(403, "forbidden");
      rejectQuery(url);
      const key = idempotencyKey(request);
      const expectedGeneration = expectedGenerationHeader(request);
      const body = await readJsonObject(request, options.maxRequestBytes);
      if (Object.hasOwn(body, "privateInputs")) throw capabilityRequired();
      exactKeys(body, ["spec"]);
      const spec = jsonObject(body.spec);
      const operation = await engine.acceptUpdate({
        principal,
        key,
        uid,
        expectedGeneration,
        spec,
      });
      return operationResponse(operation, config);
    }
    if (request.method === "DELETE") {
      if (access !== "write") return problem(403, "forbidden");
      rejectQuery(url);
      await rejectDeleteBody(request);
      const key = idempotencyKey(request);
      const expectedGeneration = expectedGenerationHeader(request);
      return operationResponse(
        await engine.acceptDelete({ principal, key, uid, expectedGeneration }),
        config,
      );
    }
    return problem(405, "method_not_allowed", { allow: "GET, PUT, DELETE" });
  }
  const operationMatch = /^\/operations\/([^/]+)$/u.exec(path);
  if (operationMatch) {
    rejectQuery(url);
    const id = decodedIdentifier(operationMatch[1] ?? "");
    if (request.method !== "GET") return problem(405, "method_not_allowed", { allow: "GET" });
    return json(await engine.getOperation({ principal, id }));
  }
  return problem(404, "not_found");
}

function operationResponse(operation: V2Operation, config: HttpConfig): Response {
  const location = `${config.baseUrl}/operations/${encodeURIComponent(operation.id)}`;
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    location,
  });
  if (!isTerminal(operation)) headers.set("retry-after", "1");
  return new Response(JSON.stringify(operation), {
    status: isTerminal(operation) ? 200 : 202,
    headers,
  });
}

function asProblem(error: unknown, options: TakoformV2HttpOptions): Response {
  if (error instanceof HttpInputError) return problem(error.status, error.code);
  if (error instanceof StrictJsonError) return problem(400, "invalid_request");
  if (error && typeof error === "object" && "code" in error && "status" in error) {
    const candidate = error as TakoformV2Error;
    const status =
      typeof candidate.status === "number" &&
      Number.isInteger(candidate.status) &&
      candidate.status >= 400 &&
      candidate.status <= 599
        ? candidate.status
        : 500;
    const code =
      typeof candidate.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(candidate.code)
        ? candidate.code
        : "internal_error";
    return problem(
      status,
      code,
      status === 401 ? { wwwAuthenticate: options.authenticationSchemes.join(", ") } : {},
    );
  }
  return problem(500, "internal_error");
}

function problem(
  status: number,
  code: string,
  headers: { allow?: string; wwwAuthenticate?: string } = {},
): Response {
  const title = statusTitle(status);
  const responseHeaders = new Headers({
    "content-type": "application/problem+json",
    "cache-control": "no-store",
  });
  if (headers.allow) responseHeaders.set("allow", headers.allow);
  if (headers.wwwAuthenticate) responseHeaders.set("www-authenticate", headers.wwwAuthenticate);
  return new Response(JSON.stringify({ type: "about:blank", title, status, code }), {
    status,
    headers: responseHeaders,
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function strictQuery(url: URL, allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || result.has(key)) throw invalidRequest();
    result.set(key, value);
  }
  return result;
}

function rejectQuery(url: URL): void {
  if (url.search !== "") throw invalidRequest();
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (value === null || !IDEMPOTENCY_KEY.test(value)) throw invalidRequest();
  return value;
}

function expectedGenerationHeader(request: Request): number {
  const value = request.headers.get("takoform-expected-generation");
  if (value === null) throw new HttpInputError(428, "expected_generation_required");
  if (!GENERATION.test(value)) throw invalidRequest();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw invalidRequest();
  return result;
}

async function readJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpInputError(415, "unsupported_media_type");
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/u.test(length)) throw invalidRequest();
    if (Number(length) > maxBytes) throw new HttpInputError(413, "request_too_large");
  }
  if (!request.body) throw invalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpInputError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError();
  }
  assertLosslessJsonNumbers(text);
  const value = parseStrictJson(bytes, maxBytes);
  return asRecord(value);
}

/** Reject numeric JSON tokens whose exact decimal value is changed by JS parsing. */
function assertLosslessJsonNumbers(text: string): void {
  let offset = 0;
  while (offset < text.length) {
    const char = text[offset];
    if (char === '"') {
      offset += 1;
      while (offset < text.length) {
        if (text[offset] === "\\") {
          offset += 2;
          continue;
        }
        if (text[offset] === '"') {
          offset += 1;
          break;
        }
        offset += 1;
      }
      continue;
    }
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
        text.slice(offset),
      );
      if (match) {
        assertLosslessJsonNumber(match[0]);
        offset += match[0].length;
        continue;
      }
    }
    offset += 1;
  }
}

function assertLosslessJsonNumber(token: string): void {
  const parsed = Number(token);
  if (
    !Number.isFinite(parsed) ||
    decimalValueKey(token) !== decimalValueKey(JSON.stringify(parsed))
  ) {
    throw new StrictJsonError();
  }
}

/** Canonical exact decimal representation: sign, integer coefficient, base-10 exponent. */
function decimalValueKey(value: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(value);
  if (!match) throw new StrictJsonError();
  const fraction = match[3] ?? "";
  const digits = `${match[2]}${fraction}`;
  let firstSignificant = 0;
  while (firstSignificant < digits.length && digits[firstSignificant] === "0") {
    firstSignificant += 1;
  }
  if (firstSignificant === digits.length) return "0:0:0";
  let endSignificant = digits.length;
  while (endSignificant > firstSignificant && digits[endSignificant - 1] === "0") {
    endSignificant -= 1;
  }
  const normalized = digits.length - endSignificant;
  const coefficient = digits.slice(firstSignificant, endSignificant);
  const exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length) + BigInt(normalized);
  return `${match[1] === "-" ? "-" : "+"}:${coefficient}:${exponent}`;
}

async function rejectDeleteBody(request: Request): Promise<void> {
  const length = request.headers.get("content-length");
  if (length !== null && length !== "0") throw invalidRequest();
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    const { done, value } = await reader.read();
    if (!done && value.byteLength > 0) throw invalidRequest();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidRequest();
  if (allowed.some((key) => !Object.hasOwn(value, key))) throw invalidRequest();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown): JsonObject {
  const record = asRecord(value);
  return record as JsonObject;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw invalidRequest();
  return value;
}

function decodedIdentifier(value: string): string {
  try {
    return identifier(decodeURIComponent(value));
  } catch {
    throw invalidRequest();
  }
}

function optionalIdentifier(value: string | undefined): string | undefined {
  return value === undefined ? undefined : identifier(value);
}

function optionalFormUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isFormUrl(value)) throw invalidRequest();
  return value;
}

function isFormUrl(value: string): boolean {
  return isV2FormUrl(value);
}

function isUnderRoot(path: string, rootPath: string): boolean {
  return rootPath === ""
    ? path.startsWith("/")
    : path === rootPath || path.startsWith(`${rootPath}/`);
}

function pageLimit(value: string | undefined, max: number): number {
  if (value === undefined) return max;
  if (!/^[1-9][0-9]*$/u.test(value)) throw invalidRequest();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > max) throw invalidRequest();
  return result;
}

interface Filters {
  space?: string;
  name?: string;
  form?: string;
}
interface CursorPayload extends Filters {
  v: 1;
  after: string;
}

async function encodeCursor(
  principal: string,
  filters: Filters,
  after: string,
  key: CryptoKey,
): Promise<string> {
  const payload: CursorPayload = { v: 1, after, ...filters };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const encodedPayload = base64UrlEncode(payloadBytes);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    asArrayBuffer(cursorSigningBytes(principal, encodedPayload)),
  );
  return `v1.${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function decodeCursor(
  value: string,
  principal: string,
  filters: Filters,
  key: CryptoKey,
): Promise<string> {
  if (value.length > 4096) throw invalidRequest();
  const [version, encodedPayload, encodedSignature, extra] = value.split(".");
  if (version !== "v1" || !encodedPayload || !encodedSignature || extra !== undefined) {
    throw invalidRequest();
  }
  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  try {
    payloadBytes = base64UrlDecode(encodedPayload);
    signature = base64UrlDecode(encodedSignature);
  } catch {
    throw invalidRequest();
  }
  const authenticated = await crypto.subtle.verify(
    "HMAC",
    key,
    asArrayBuffer(signature),
    asArrayBuffer(cursorSigningBytes(principal, encodedPayload)),
  );
  if (!authenticated) throw invalidRequest();
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    throw invalidRequest();
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw invalidRequest();
  const cursor = payload as Partial<CursorPayload>;
  if (
    cursor.v !== 1 ||
    typeof cursor.after !== "string" ||
    !ID.test(cursor.after) ||
    cursor.space !== filters.space ||
    cursor.name !== filters.name ||
    cursor.form !== filters.form ||
    Object.keys(cursor).some((key) => !["v", "after", "space", "name", "form"].includes(key))
  )
    throw invalidRequest();
  return cursor.after;
}

function cursorSigningBytes(principal: string, encodedPayload: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([API, principal, encodedPayload]));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidRequest();
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isTerminal(operation: V2Operation): boolean {
  return operation.status === "succeeded" || operation.status === "failed";
}

function statusTitle(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 409:
      return "Conflict";
    case 410:
      return "Gone";
    case 413:
      return "Content Too Large";
    case 415:
      return "Unsupported Media Type";
    case 422:
      return "Unprocessable Content";
    case 428:
      return "Precondition Required";
    case 429:
      return "Too Many Requests";
    case 503:
      return "Service Unavailable";
    default:
      return status >= 500 ? "Internal Server Error" : "Request Rejected";
  }
}

class HttpInputError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function invalidRequest(): HttpInputError {
  return new HttpInputError(400, "invalid_request");
}
function capabilityRequired(): HttpInputError {
  return new HttpInputError(422, "capability_required");
}
