/**
 * Applies a Takoform resource against a running Takoserver.
 *
 * The lane is a reviewed, fenced protocol: you prepare desired state, the Host
 * hands back a digest of exactly what it reviewed, and the apply must present
 * that digest. This tool performs both halves so a caller does not have to
 * reimplement the handshake to deploy something.
 *
 *   bun scripts/takoform.ts apply  <origin> <apiKey> <kind> <space> <name> <specJson>
 *   bun scripts/takoform.ts get    <origin> <apiKey> <kind> <space> <name>
 *   bun scripts/takoform.ts delete <origin> <apiKey> <kind> <space> <name>
 *   bun scripts/takoform.ts operation <origin> <apiKey> <operationId> [--wait]
 *
 * The Form is resolved from the server's own catalog, so the exact schema
 * digest never has to be typed by hand — and cannot be typed wrongly.
 */

export {};

const [command, rawOrigin, rawApiKey, rawKind, rawSpace, rawName, specJson] = process.argv.slice(2);
const operationCommand = command === "operation";

if (
  !command ||
  !rawOrigin ||
  !rawApiKey ||
  !rawKind ||
  (operationCommand
    ? (rawSpace !== undefined && rawSpace !== "--wait") ||
      rawName !== undefined ||
      specJson !== undefined
    : !rawSpace || !rawName)
) {
  process.stderr.write(
    "usage: takoform.ts apply|get|delete <origin> <apiKey> <kind> <space> <name> [specJson]\n" +
      "       takoform.ts operation <origin> <apiKey> <operationId> [--wait]\n",
  );
  process.exit(2);
}

// Bound once, so the helpers below see values rather than possibly-absent
// arguments.
const origin: string = rawOrigin;
const apiKey: string = rawApiKey;
const kind: string = rawKind;
const space: string = rawSpace ?? "";
const name: string = rawName ?? "";

const LANE = "/apis/forms.takoform.com/v1";
const conditionTypes = new Set([
  "Ready",
  "Reconciling",
  "Degraded",
  "Drifted",
  "Blocked",
  "Deleting",
]);
const conditionStatuses = new Set(["True", "False", "Unknown"]);
const conditionReasons = new Set([
  "Available",
  "Provisioning",
  "Reconciling",
  "Failed",
  "BackendUnavailable",
  "SpecDrift",
  "ExternalChange",
  "DependencyMissing",
  "DependencyInUse",
  "PolicyDenied",
  "UnsupportedCapability",
  "Deleting",
]);

interface FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

interface ResourceReadback {
  readonly body: string;
  readonly generation: string;
  readonly uid: string;
  readonly document: Record<string, unknown>;
}

interface OperationResult {
  readonly done: boolean;
  readonly result?: Record<string, unknown>;
  readonly errorCode?: string;
}

const OPERATION_API_VERSION = "operations.takoform.com/v1alpha1";
const OPERATION_ID_PATTERN = /^op_[A-Za-z0-9][A-Za-z0-9._-]{0,124}$/u;
const MAX_OPERATION_POLLS = 30;
const MAX_OPERATION_WAIT_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;

if (operationCommand) {
  if (!OPERATION_ID_PATTERN.test(kind)) fail("operation ID is invalid");
  const operation =
    rawSpace === "--wait" ? await waitForOperation(kind, "0") : await readOperationOnce(kind);
  process.stdout.write(`${JSON.stringify(operationStatus(kind, operation))}\n`);
  process.exit(rawSpace === "--wait" && operation.errorCode ? 1 : 0);
}

// A kind usually has several installed definitions: the current one and the
// superseded ones that keep older resources manageable. Newest first.
const definitions = await resolveForms(kind);
const formRef = definitions[0] as FormRef;

function pathFor(ref: FormRef): string {
  const [group, version] = ref.apiVersion.split("/");
  const query = new URLSearchParams({
    space,
    group: ref.apiVersion,
    kind: ref.kind,
    definitionVersion: ref.definitionVersion,
    schemaDigest: ref.schemaDigest,
  });
  return `${LANE}/resources/${group}/${version}/${ref.kind}/${name}?${query}`;
}

/** Finds which installed definition an existing resource was created under. */
async function locate(): Promise<({ ref: FormRef; path: string } & ResourceReadback) | null> {
  for (const ref of definitions) {
    const path = pathFor(ref);
    const resource = await readResource(path, ref);
    if (resource) return { ref, path, ...resource };
  }
  return null;
}

const resourcePath = pathFor(formRef);

if (command === "get") {
  const found = await locate();
  if (!found) {
    process.stderr.write(`no resource named ${name} under any installed ${kind} definition\n`);
    process.exit(1);
  }
  process.stdout.write(`${found.body}\n`);
  process.exit(0);
}

if (command === "delete") {
  const found = await locate();
  if (!found) {
    process.stderr.write(`no resource named ${name} under any installed ${kind} definition\n`);
    process.exit(1);
  }
  const generation = found.generation;
  const response = await call("DELETE", found.path, undefined, {
    "idempotency-key": `cli-delete-${name}-${Date.now()}`,
    "takoform-expected-generation": generation,
  });
  if (response.status === 202) {
    const operationId = await acceptedOperationId(response);
    const operation = await waitForOperation(operationId, response.headers.get("retry-after"));
    if (operation.errorCode) fail(`operation ${operationId} failed: ${operation.errorCode}`);
    if (operation.result?.deleted !== true) {
      fail(`operation ${operationId} completed without a delete result`);
    }
    const remaining = await readResource(found.path, found.ref);
    if (remaining) fail(`operation ${operationId} completed but the resource is still present`);
    process.stdout.write(`deleted ${operationId}\n`);
    process.exit(0);
  }
  process.stdout.write(`${response.status} ${await response.text()}\n`);
  process.exit(response.ok ? 0 : 1);
}

if (command !== "apply") {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}

const spec: unknown = JSON.parse(specJson ?? "{}");
const resource = {
  apiVersion: formRef.apiVersion,
  kind: formRef.kind,
  form: { formRef },
  metadata: { name, space },
  spec,
};

// An existing resource must be reviewed against the generation it is at.
const existing = await readResource(resourcePath, formRef);
const generation = existing?.generation ?? null;
if (!existing) {
  // A resource of this name may exist under a superseded definition. Applying
  // the current one would silently create a second resource beside it, so say
  // so rather than doing that.
  const elsewhere = await locate();
  if (elsewhere) {
    process.stderr.write(
      `${name} already exists under ${kind} ${elsewhere.ref.definitionVersion}; ` +
        "delete it first or apply against that definition\n",
    );
    process.exit(1);
  }
}

const prepared = await call(
  "POST",
  `${LANE}/resources/prepare`,
  resource,
  generation ? { "takoform-expected-generation": generation } : {},
);
if (!prepared.ok) {
  process.stderr.write(`prepare failed: ${prepared.status} ${await prepared.text()}\n`);
  process.exit(1);
}
const review = (await prepared.json()) as { review: { prepareDigest: string } };

const applied = await call(
  "PUT",
  resourcePath,
  { ...resource, review: { prepareDigest: review.review.prepareDigest } },
  {
    "idempotency-key": `cli-apply-${name}-${Date.now()}`,
    ...(generation ? { "takoform-expected-generation": generation } : { "if-none-match": "*" }),
  },
);
if (applied.status === 202) {
  const operationId = await acceptedOperationId(applied);
  const operation = await waitForOperation(operationId, applied.headers.get("retry-after"));
  if (operation.errorCode) fail(`operation ${operationId} failed: ${operation.errorCode}`);
  const terminalResource = operation.result?.resource;
  if (!isRecord(terminalResource)) {
    fail(`operation ${operationId} completed without a resource result`);
  }
  const terminalReadback = parseResourceReadback(JSON.stringify(terminalResource), formRef);
  if (!terminalReadback) fail(`operation ${operationId} returned an invalid resource result`);
  if (existing && terminalReadback.uid !== existing.uid) {
    fail(`operation ${operationId} changed the resource UID during update`);
  }

  const current = await readResource(resourcePath, formRef);
  if (!current) fail(`operation ${operationId} completed but the resource is absent`);
  if (
    current.uid !== terminalReadback.uid ||
    current.generation !== terminalReadback.generation ||
    !sameJson(current.document.spec, terminalReadback.document.spec)
  ) {
    fail(`operation ${operationId} result does not match the current resource readback`);
  }
  process.stdout.write(`${current.body}\n`);
  process.exit(0);
}
process.stdout.write(`${applied.status} ${await applied.text()}\n`);
process.exit(applied.ok ? 0 : 1);

async function acceptedOperationId(response: Response): Promise<string> {
  const body = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    fail("Host accepted an operation without a valid operation handle");
  }
  const operation = isRecord(value) ? value.operation : undefined;
  if (
    !isRecord(operation) ||
    operation.apiVersion !== OPERATION_API_VERSION ||
    operation.kind !== "Operation" ||
    typeof operation.id !== "string" ||
    !OPERATION_ID_PATTERN.test(operation.id) ||
    operation.done !== false ||
    "result" in operation ||
    "error" in operation
  ) {
    fail("Host accepted an operation with an invalid operation handle");
  }
  return operation.id;
}

async function waitForOperation(
  operationId: string,
  initialRetryAfter: string | null,
): Promise<OperationResult> {
  const deadline = performance.now() + MAX_OPERATION_WAIT_MS;
  let retryAfter = retryAfterMilliseconds(initialRetryAfter);
  const operationPath = `${LANE}/operations/${operationId}`;

  for (let attempt = 0; attempt < MAX_OPERATION_POLLS; attempt += 1) {
    let remaining = deadline - performance.now();
    if (remaining <= 0) break;
    if (retryAfter > 0) await sleep(Math.min(retryAfter, remaining));
    remaining = deadline - performance.now();
    if (remaining <= 0) break;

    const controller = new AbortController();
    const pollTimeout = setTimeout(() => controller.abort(), Math.max(1, remaining));
    let response: Response | undefined;
    let body: string | undefined;
    let readFailed = false;
    try {
      response = await call("GET", operationPath, undefined, {}, controller.signal);
      if (response.status === 200) body = await response.text();
    } catch {
      readFailed = true;
    } finally {
      clearTimeout(pollTimeout);
    }
    if (controller.signal.aborted || performance.now() >= deadline) {
      fail(
        `operation ${operationId} did not finish within the CLI polling budget; outcome unresolved`,
      );
    }
    if (readFailed || !response) {
      fail(`could not read operation ${operationId}; its outcome remains unresolved`);
    }
    if (response.status !== 200) {
      fail(`operation ${operationId} read failed: ${response.status}`);
    }
    if (body === undefined) {
      fail(`could not read operation ${operationId}; its outcome remains unresolved`);
    }
    const operation = parseOperation(body, operationId);
    if (!operation) fail(`operation ${operationId} returned an invalid response`);
    if (operation.done) {
      if (operation.errorCode) return { done: true, errorCode: operation.errorCode };
      if (operation.result) return { done: true, result: operation.result };
      fail(`operation ${operationId} completed without a result`);
    }
    retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
  }
  fail(`operation ${operationId} did not finish within the CLI polling budget`);
}

async function readOperationOnce(operationId: string): Promise<OperationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_OPERATION_WAIT_MS);
  let response: Response | undefined;
  let body: string | undefined;
  let readFailed = false;
  try {
    response = await call(
      "GET",
      `${LANE}/operations/${operationId}`,
      undefined,
      {},
      controller.signal,
    );
    if (response.status === 200) body = await response.text();
  } catch {
    readFailed = true;
  } finally {
    clearTimeout(timeout);
  }
  if (controller.signal.aborted) {
    fail(`operation ${operationId} read exceeded the CLI request budget`);
  }
  if (readFailed || !response) fail(`could not read operation ${operationId}`);
  if (response.status !== 200) fail(`operation ${operationId} read failed: ${response.status}`);
  if (body === undefined) fail(`could not read operation ${operationId}`);
  const operation = parseOperation(body, operationId);
  if (!operation) fail(`operation ${operationId} returned an invalid response`);
  return operation;
}

function operationStatus(operationId: string, operation: OperationResult): Record<string, unknown> {
  return {
    apiVersion: OPERATION_API_VERSION,
    kind: "Operation",
    id: operationId,
    done: operation.done,
    ...(operation.errorCode === undefined
      ? operation.result === undefined
        ? {}
        : { result: operation.result }
      : { error: { code: operation.errorCode } }),
  };
}

function parseOperation(
  body: string,
  expectedId: string,
): {
  readonly done: boolean;
  readonly result?: Record<string, unknown>;
  readonly errorCode?: string;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.apiVersion !== OPERATION_API_VERSION ||
    value.kind !== "Operation" ||
    value.id !== expectedId ||
    typeof value.done !== "boolean"
  ) {
    return null;
  }
  if (!value.done) {
    return "result" in value || "error" in value ? null : { done: false };
  }

  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (hasResult === hasError) return null;
  if (hasResult) return isRecord(value.result) ? { done: true, result: value.result } : null;

  if (
    !isRecord(value.error) ||
    typeof value.error.code !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(value.error.code) ||
    typeof value.error.retryable !== "boolean" ||
    typeof value.error.requestId !== "string"
  ) {
    return null;
  }
  return { done: true, errorCode: value.error.code };
}

function retryAfterMilliseconds(value: string | null): number {
  if (value === null || !/^(0|[1-9][0-9]{0,3})$/u.test(value)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Number(value) * 1_000, MAX_OPERATION_WAIT_MS);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameJson(left: unknown, right: unknown): boolean {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sort(value[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Reads a resource, treating only its authoritative not-found envelope as absence. */
async function readResource(path: string, ref: FormRef): Promise<ResourceReadback | null> {
  const response = await call("GET", path);
  const body = await response.text();
  if (response.ok) {
    const resource = parseResourceReadback(body, ref);
    if (resource) {
      return {
        body,
        generation: resource.generation,
        uid: resource.uid,
        document: resource.document,
      };
    }
    process.stderr.write(
      `resource read returned an invalid Takoform resource: ${response.status}\n`,
    );
    process.exit(1);
  }
  if (response.status === 404) {
    try {
      const envelope = JSON.parse(body) as { error?: { code?: unknown } };
      if (envelope.error?.code === "resource_not_found") return null;
    } catch {
      // A malformed or non-envelope 404 is not evidence that a resource is absent.
    }
  }

  process.stderr.write(`resource read failed: ${response.status} ${body}\n`);
  process.exit(1);
}

/** Validates the stored-resource envelope and fences before accepting a readback. */
function parseResourceReadback(
  body: string,
  ref: FormRef,
): {
  readonly generation: string;
  readonly uid: string;
  readonly document: Record<string, unknown>;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const form = value.form;
  const formRef = isRecord(form) ? form.formRef : undefined;
  const metadata = value.metadata;
  const status = value.status;
  const spec = value.spec;
  if (
    value.apiVersion !== ref.apiVersion ||
    value.kind !== ref.kind ||
    !isRecord(formRef) ||
    formRef.apiVersion !== ref.apiVersion ||
    formRef.kind !== ref.kind ||
    formRef.definitionVersion !== ref.definitionVersion ||
    formRef.schemaDigest !== ref.schemaDigest ||
    !isRecord(metadata) ||
    metadata.name !== name ||
    metadata.space !== space ||
    typeof metadata.uid !== "string" ||
    metadata.uid.length === 0 ||
    !isPositiveCounter(metadata.generation) ||
    !isPositiveCounter(metadata.revision) ||
    !isRecord(spec) ||
    !isRecord(status) ||
    !isPositiveCounter(status.observedGeneration) ||
    !Array.isArray(status.conditions) ||
    !status.conditions.every(isTakoformCondition)
  ) {
    return null;
  }
  return { generation: metadata.generation, uid: metadata.uid, document: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTakoformCondition(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    conditionTypes.has(value.type) &&
    typeof value.status === "string" &&
    conditionStatuses.has(value.status) &&
    typeof value.reason === "string" &&
    conditionReasons.has(value.reason) &&
    typeof value.lastTransitionTime === "string" &&
    (value.hostReason === undefined || typeof value.hostReason === "string") &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isPositiveCounter(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n
  );
}

/** Every installed definition of a kind, newest first. */
async function resolveForms(wanted: string): Promise<readonly FormRef[]> {
  const response = await fetch(`${origin}${LANE}/support/forms`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    process.stderr.write(`could not read support profiles: ${response.status}\n`);
    process.exit(1);
  }
  const { profiles } = (await response.json()) as {
    profiles: { formRef: FormRef }[];
  };
  const match = profiles
    .filter((profile) => profile.formRef.kind === wanted)
    .map((profile) => profile.formRef)
    .sort((left, right) => compareVersions(right.definitionVersion, left.definitionVersion));
  if (match.length === 0) {
    process.stderr.write(
      `no Form named ${wanted}; the server offers ` +
        `${[...new Set(profiles.map((profile) => profile.formRef.kind))].join(", ")}\n`,
    );
    process.exit(1);
  }
  return match;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number(part) || 0);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
