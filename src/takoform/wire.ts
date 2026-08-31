import { bytesDigest, canonicalJson } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import { parseStrictJson, StrictJsonError } from "../strict-json.ts";
import { DIGEST, isFormGroup, isFormVersion, isKind, validateFormRef } from "./forms.ts";
import { MAXIMUM_REQUEST_BODY_BYTES } from "./limits.ts";
import { TakoformHostError, type TakoformStoredResource } from "./types.ts";

/**
 * The HTTP surface of the Host: how a request becomes a typed command, and how
 * a result becomes bytes.
 *
 * Everything here is pinned by the conformance suite. The replay fingerprint in
 * particular hashes the raw request body rather than its parsed form, so a
 * semantically identical body that was reformatted is a *different* request —
 * that is deliberate, and it is why parsing happens after the digest is taken.
 */

const NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const GENERATION = /^[1-9][0-9]{0,18}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const MAX_COUNTER = 9_223_372_036_854_775_807n;
const RETRYABLE = ["resource_busy", "backend_unavailable", "rate_limited", "deadline_exceeded"];

export interface ParsedResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly form: {
    readonly formRef: ReturnType<typeof formRefOf>;
    readonly packageDigest?: string;
  };
  readonly metadata: { readonly name: string; readonly space: string };
  readonly spec: JsonObject;
}

export interface ParsedApply extends ParsedResource {
  readonly review: {
    readonly prepareDigest: `sha256:${string}`;
    readonly specDigest?: `sha256:${string}`;
  };
  readonly expectedUid?: string;
  readonly expectedGeneration?: string;
}

export interface ParsedImport extends ParsedResource {
  readonly nativeId: string;
}

export interface ResourcePath {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly action?: "import" | "observe";
}

function formRefOf(value: Record<string, unknown>) {
  return {
    apiVersion: string(value.apiVersion),
    kind: string(value.kind),
    definitionVersion: string(value.definitionVersion),
    schemaDigest: digest(string(value.schemaDigest)),
  };
}

// --- request parsing -------------------------------------------------------

export function resourceRequest(input: unknown): ParsedResource {
  const value = record(input);
  exactKeys(value, ["apiVersion", "kind", "form", "metadata", "spec"]);
  const form = record(value.form);
  exactKeys(form, ["formRef", ...(form.packageDigest === undefined ? [] : ["packageDigest"])]);
  const formRef = record(form.formRef);
  exactKeys(formRef, ["apiVersion", "kind", "definitionVersion", "schemaDigest"]);
  const metadata = record(value.metadata);
  exactKeys(metadata, ["name", "space"]);
  const parsed: ParsedResource = {
    apiVersion: string(value.apiVersion),
    kind: string(value.kind),
    form: {
      formRef: formRefOf(formRef),
      ...(form.packageDigest === undefined
        ? {}
        : { packageDigest: digest(string(form.packageDigest)) }),
    },
    metadata: { name: string(metadata.name), space: string(metadata.space) },
    spec: jsonObject(value.spec),
  };
  validateResource(parsed);
  return parsed;
}

export function applyRequest(input: unknown): ParsedApply {
  const value = record(input);
  const baseKeys = ["apiVersion", "kind", "form", "metadata", "spec", "review"];
  const keys = [
    ...baseKeys,
    ...(value.expectedUid === undefined ? [] : ["expectedUid"]),
    ...(value.expectedGeneration === undefined ? [] : ["expectedGeneration"]),
  ];
  exactKeys(value, keys);
  const base = resourceRequest(
    Object.fromEntries(baseKeys.filter((key) => key !== "review").map((key) => [key, value[key]])),
  );
  const review = record(value.review);
  exactKeys(review, ["prepareDigest", ...(review.specDigest === undefined ? [] : ["specDigest"])]);
  return {
    ...base,
    review: {
      prepareDigest: digest(string(review.prepareDigest)),
      ...(review.specDigest === undefined ? {} : { specDigest: digest(string(review.specDigest)) }),
    },
    ...(value.expectedUid === undefined
      ? {}
      : { expectedUid: boundedReference(string(value.expectedUid)) }),
    ...(value.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: generation(string(value.expectedGeneration)) }),
  };
}

export function importRequest(input: unknown): ParsedImport {
  const value = record(input);
  const baseKeys = ["apiVersion", "kind", "form", "metadata", "spec"];
  exactKeys(value, [...baseKeys, "nativeId"]);
  const base = resourceRequest(Object.fromEntries(baseKeys.map((key) => [key, value[key]])));
  const nativeId = string(value.nativeId);
  if (nativeId.length === 0 || nativeId.length > 4_096) throw new TakoformHostError();
  return { ...base, nativeId };
}

/** The reviewed body without its review block — what a prepare fingerprints. */
export function stripApplyReview(input: ParsedApply): ParsedResource {
  return {
    apiVersion: input.apiVersion,
    kind: input.kind,
    form: structuredClone(input.form),
    metadata: structuredClone(input.metadata),
    spec: structuredClone(input.spec),
  };
}

function validateResource(input: ParsedResource): void {
  validateFormRef(input.form.formRef);
  if (
    input.apiVersion !== input.form.formRef.apiVersion ||
    input.kind !== input.form.formRef.kind ||
    !NAME.test(input.metadata.name) ||
    spaceId(input.metadata.space) !== input.metadata.space
  ) {
    throw new TakoformHostError();
  }
}

export function parsedResourcePath(match: RegExpExecArray): ResourcePath {
  const group = safeSegment(match[1]);
  const version = match[2] === undefined ? undefined : safeSegment(match[2]);
  const kind = safeSegment(match[3]);
  const name = safeSegment(match[4]);
  if (
    !isFormGroup(group) ||
    (version !== undefined && !isFormVersion(version)) ||
    !isKind(kind) ||
    !NAME.test(name)
  ) {
    throw new TakoformHostError();
  }
  const action = match[5];
  return {
    apiVersion: version === undefined ? group : `${group}/${version}`,
    kind,
    name,
    ...(action === "import" || action === "observe" ? { action } : {}),
  };
}

export function samePathResource(resource: ParsedResource, path: ResourcePath): boolean {
  return (
    resource.apiVersion === path.apiVersion &&
    resource.kind === path.kind &&
    resource.metadata.name === path.name
  );
}

// --- fences and fingerprints ----------------------------------------------

/**
 * Identifies a mutation attempt for replay purposes. The raw body digest is
 * part of it, so re-sending the same intent with different bytes is refused
 * rather than silently treated as the original request.
 */
export function mutationFingerprint(request: Request, rawBodyDigest: `sha256:${string}`): string {
  const url = new URL(request.url);
  return canonicalJson({
    method: request.method,
    target: `${url.pathname}${url.search}`,
    preconditions: {
      ifMatch: request.headers.get("if-match"),
      ifNoneMatch: request.headers.get("if-none-match"),
      expectedGeneration: request.headers.get("takoform-expected-generation"),
    },
    rawBodyDigest,
  });
}

export async function requestBodyDigest(request: Request): Promise<`sha256:${string}`> {
  const bytes = await request.clone().arrayBuffer();
  if (bytes.byteLength > MAXIMUM_REQUEST_BODY_BYTES) throw new TakoformHostError();
  return await bytesDigest(bytes);
}

export function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY.test(key)) throw new TakoformHostError();
  return key;
}

export function requiredExpectedGeneration(
  request: Request,
  body?: string,
  allowBodyOnly = false,
): string {
  const header = request.headers.get("takoform-expected-generation");
  if (!header) {
    if (allowBodyOnly && body !== undefined) return generation(body);
    throw new TakoformHostError();
  }
  const parsed = generation(header);
  if (body !== undefined && body !== parsed) throw new TakoformHostError();
  return parsed;
}

export function optionalGeneration(value: string | null): string | undefined {
  return value === null ? undefined : generation(value);
}

export function generation(value: string): string {
  if (!GENERATION.test(value) || BigInt(value) > MAX_COUNTER) throw new TakoformHostError();
  return value;
}

/** Counters are unbounded on the wire but bounded in storage; overflow is busy. */
export function increment(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > MAX_COUNTER) throw new TakoformHostError("resource_busy", 409);
  return next.toString();
}

// --- bodies, queries, and identifiers -------------------------------------

export async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new TakoformHostError();
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAXIMUM_REQUEST_BODY_BYTES) throw new TakoformHostError();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_REQUEST_BODY_BYTES) {
    throw new TakoformHostError();
  }
  try {
    return parseStrictJson(new Uint8Array(bytes), MAXIMUM_REQUEST_BODY_BYTES);
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    throw new TakoformHostError();
  }
}

export function requiredQuery(url: URL, key: string): string {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0]) throw new TakoformHostError();
  return values[0];
}

/** Query strings are closed: an unexpected parameter is a different request. */
export function exactQuery(url: URL, expected: readonly string[]): void {
  const actual = [...url.searchParams.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new TakoformHostError();
  }
}

export function spaceId(value: string): string {
  const points = [...value];
  const white = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/u;
  if (
    points.length === 0 ||
    points.length > 255 ||
    white.test(points[0] ?? "") ||
    white.test(points.at(-1) ?? "") ||
    points.some((point) => {
      const code = point.codePointAt(0) ?? 0;
      return point === "/" || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw new TakoformHostError();
  }
  return value;
}

export function safeSegment(value: string | undefined): string {
  if (!value || value.includes("%")) throw new TakoformHostError();
  return value;
}

export function boundedReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new TakoformHostError();
  return value;
}

export function digest(value: string): `sha256:${string}` {
  if (!DIGEST.test(value)) throw new TakoformHostError();
  return value as `sha256:${string}`;
}

export function string(value: unknown): string {
  if (typeof value !== "string") throw new TakoformHostError();
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TakoformHostError();
  return value;
}

export function jsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) throw new TakoformHostError();
  JSON.stringify(value);
  return value as JsonObject;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new TakoformHostError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- responses -------------------------------------------------------------

export function portableResourceView<
  T extends {
    readonly form: {
      readonly formRef: unknown;
      readonly implementationDigest?: string;
    };
    readonly status?: { readonly observed?: JsonObject };
  },
>(resource: T, omitObservedStatus = false): T {
  const copy = structuredClone(resource);
  delete (copy.form as { implementationDigest?: string }).implementationDigest;
  if (omitObservedStatus && copy.status) {
    delete (copy.status as { observed?: JsonObject }).observed;
  }
  return copy;
}

export function resourceResponse(
  resource: TakoformStoredResource,
  status = 200,
  omitObservedStatus = false,
): Response {
  const view = portableResourceView(resource, omitObservedStatus);
  return Response.json(view, { status, headers: etag(view) });
}

export function etag(resource: TakoformStoredResource): HeadersInit {
  // The ETag is the strong revision fence defined by Takoform. Cloudflare may
  // otherwise compress the JSON representation and rewrite it to W/"...",
  // which correctly makes the released provider reject the response as a
  // different representation. Prevent transformations instead of weakening
  // the protocol fence.
  return { etag: `"${resource.metadata.revision}"`, "cache-control": "no-transform" };
}

/**
 * The one error envelope. `requestId` is always fresh and the message is
 * derived from the code, so a driver's own words never reach the caller.
 */
export function failure(code: string, status: number, details?: unknown): Response {
  return Response.json(
    {
      error: {
        code,
        message: code.replaceAll("_", " "),
        requestId: `req_${crypto.randomUUID()}`,
        retryable: RETRYABLE.includes(code),
        ...(details === undefined ? {} : { details }),
      },
    },
    { status },
  );
}
