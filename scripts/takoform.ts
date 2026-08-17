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

const formRef = await resolveForm(kind);
const [group, version] = formRef.apiVersion.split("/");
const query = new URLSearchParams({
  space,
  group: formRef.apiVersion,
  kind: formRef.kind,
  definitionVersion: formRef.definitionVersion,
  schemaDigest: formRef.schemaDigest,
});
const resourcePath = `${LANE}/resources/${group}/${version}/${formRef.kind}/${name}?${query}`;

if (command === "get") {
  const response = await call("GET", resourcePath);
  process.stdout.write(`${await response.text()}\n`);
  process.exit(response.ok ? 0 : 1);
}

if (command === "delete") {
  const current = await (await call("GET", resourcePath)).json();
  const generation = String(
    (current as { metadata?: { generation?: string } }).metadata?.generation ?? "1",
  );
  const response = await call("DELETE", resourcePath, undefined, {
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

/** Finds the Form a kind names, from what the server actually offers. */
async function resolveForm(wanted: string): Promise<FormRef> {
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
  const match = profiles.filter((profile) => profile.formRef.kind === wanted);
  if (match.length !== 1) {
    process.stderr.write(
      `expected exactly one Form named ${wanted}, found ${match.length}: ` +
        `${profiles.map((profile) => profile.formRef.kind).join(", ")}\n`,
    );
    process.exit(1);
  }
  return (match[0] as { formRef: FormRef }).formRef;
}
