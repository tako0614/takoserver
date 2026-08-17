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

const [command, origin, apiKey, kind, space, name, specJson] = process.argv.slice(2);

if (!command || !origin || !apiKey || !kind || !space || !name) {
  process.stderr.write(
    "usage: takoform.ts apply|get|delete <origin> <apiKey> <kind> <space> <name> [specJson]\n",
  );
  process.exit(2);
}

const LANE = "/apis/forms.takoform.com/v1alpha3";

interface FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
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
async function locate(): Promise<{ ref: FormRef; path: string; body: string } | null> {
  for (const ref of definitions) {
    const path = pathFor(ref);
    const response = await call("GET", path);
    if (response.ok) return { ref, path, body: await response.text() };
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
  const generation = String(
    (JSON.parse(found.body) as { metadata: { generation: string } }).metadata.generation,
  );
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
const existing = await call("GET", resourcePath);
const generation = existing.ok
  ? String(((await existing.json()) as { metadata: { generation: string } }).metadata.generation)
  : null;
if (!existing.ok) {
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
