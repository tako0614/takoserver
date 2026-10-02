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
 *
 * The Form is resolved from the server's own catalog, so the exact schema
 * digest never has to be typed by hand — and cannot be typed wrongly.
 */

export {};

const [command, rawOrigin, rawApiKey, rawKind, rawSpace, rawName, specJson] = process.argv.slice(2);

if (!command || !rawOrigin || !rawApiKey || !rawKind || !rawSpace || !rawName) {
  process.stderr.write(
    "usage: takoform.ts apply|get|delete <origin> <apiKey> <kind> <space> <name> [specJson]\n",
  );
  process.exit(2);
}

// Bound once, so the helpers below see values rather than possibly-absent
// arguments.
const origin: string = rawOrigin;
const apiKey: string = rawApiKey;
const kind: string = rawKind;
const space: string = rawSpace;
const name: string = rawName;

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
process.stdout.write(`${applied.status} ${await applied.text()}\n`);
process.exit(applied.ok ? 0 : 1);

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Reads a resource, treating only its authoritative not-found envelope as absence. */
async function readResource(path: string, ref: FormRef): Promise<ResourceReadback | null> {
  const response = await call("GET", path);
  const body = await response.text();
  if (response.ok) {
    const resource = parseResourceReadback(body, ref);
    if (resource) return { body, generation: resource.generation };
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
function parseResourceReadback(body: string, ref: FormRef): { readonly generation: string } | null {
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
  return { generation: metadata.generation };
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
