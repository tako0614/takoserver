import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Uploads a Worker bundle into Takoserver and prints its manifest digest.
 *
 * The protocol is deliberately three-legged: declare what you are about to
 * upload, upload each blob so the server can verify its size and digest
 * itself, then commit. Nothing is addressable until the commit, and the commit
 * refuses unless every declared blob is present and matches — so a Form can
 * name a bundle knowing the bytes behind it were checked, not merely claimed.
 *
 *   bun scripts/takoform-bundle.ts <origin> <apiKey> <mainModule> <file...>
 *
 * The digest it prints is what a WorkerScript's `bundle` field takes.
 */

const [origin, apiKey, mainModule, ...files] = process.argv.slice(2);

if (!origin || !apiKey || !mainModule || files.length === 0) {
  process.stderr.write("usage: takoform-bundle.ts <origin> <apiKey> <mainModule> <file...>\n");
  process.exit(2);
}

const LANE = "/apis/forms.takoform.com/v1alpha3/artifacts";

interface Blob {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly mediaType: string;
}

const blobs: Blob[] = [];
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  blobs.push({
    name: basename(file),
    bytes,
    digest: await digestOf(bytes),
    mediaType: mediaTypeOf(file),
  });
}
if (!blobs.some((blob) => blob.name === mainModule)) {
  process.stderr.write(`the main module ${mainModule} is not among the uploaded files\n`);
  process.exit(2);
}

const manifest = {
  apiVersion: "artifacts.takoform.com/v1alpha1",
  kind: "WorkerBundle",
  mainModule,
  modules: blobs.map((blob) => ({
    name: blob.name,
    mediaType: blob.mediaType,
    size: blob.bytes.byteLength,
    digest: blob.digest,
  })),
};

const started = await call("POST", `${LANE}/uploads`, JSON.stringify({ manifest }), {
  "content-type": "application/json",
  "idempotency-key":
    `bundle-${await digestOf(new TextEncoder().encode(JSON.stringify(manifest)))}`.slice(0, 120),
});
if (!started.ok) {
  process.stderr.write(`upload start failed: ${started.status} ${await started.text()}\n`);
  process.exit(1);
}
const { uploadId, missingBlobs } = (await started.json()) as {
  uploadId: string;
  missingBlobs: string[];
};
process.stderr.write(`upload ${uploadId}: ${missingBlobs.length} blob(s) to send\n`);

for (const blob of blobs) {
  // Blobs already held by this tenant are skipped: content addressing means an
  // unchanged module never travels twice.
  if (!missingBlobs.includes(blob.digest)) continue;
  const sent = await call(
    "PUT",
    `${LANE}/uploads/${uploadId}/blobs/${blob.digest}`,
    blob.bytes as unknown as BodyInit,
  );
  if (!sent.ok) {
    process.stderr.write(`blob ${blob.name} failed: ${sent.status} ${await sent.text()}\n`);
    process.exit(1);
  }
  process.stderr.write(`sent ${blob.name} (${blob.bytes.byteLength} bytes)\n`);
}

const committed = await call("POST", `${LANE}/uploads/${uploadId}/commit`, undefined, {
  "idempotency-key": `commit-${uploadId}`,
});
if (!committed.ok) {
  process.stderr.write(`commit failed: ${committed.status} ${await committed.text()}\n`);
  process.exit(1);
}
const { manifestDigest } = (await committed.json()) as { manifestDigest: string };
process.stdout.write(`${manifestDigest}\n`);

async function call(
  method: string,
  path: string,
  body?: BodyInit,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function mediaTypeOf(file: string): string {
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".map")) return "application/source-map+json";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "application/javascript+module";
  return "application/octet-stream";
}
