import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import {
  ArtifactInputError,
  createTakoformArtifacts,
  type TakoformArtifactPrincipal,
} from "../src/takoform/artifacts.ts";
import { MAXIMUM_REQUEST_BODY_BYTES } from "../src/takoform/limits.ts";
import { instrumentedBodyStream } from "./helpers/instrumented-body-stream.ts";

// Artifact uploads already know how many bytes they accept: the manifest JSON
// is held to the Host request budget and each blob to its declared size. Both
// must hold while reading, not after buffering whatever the caller streamed.

const PREFIX = "/apis/forms.takoform.com/v1/artifacts";
const PRINCIPAL: TakoformArtifactPrincipal = { tenantId: "tenant_a", principalId: "run:a" };
const CHUNK_BYTES = 4 * 1_024;
const TOTAL_CHUNKS = 1_024;

function overBudgetStream() {
  return instrumentedBodyStream({ chunkBytes: CHUNK_BYTES, totalChunks: TOTAL_CHUNKS });
}

function fixture() {
  let id = 0;
  const artifacts = createTakoformArtifacts({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    clock: () => new Date("2026-10-27T00:00:00.000Z"),
    randomId: () => `artifact-${++id}`,
  });
  return async (path: string, init: RequestInit): Promise<Response> => {
    const response = await artifacts.handle(
      new Request(`https://api.test${PREFIX}/${path}`, init),
      PRINCIPAL,
      (code, status) => Response.json({ error: { code } }, { status }),
    );
    if (!response) throw new Error("artifact path was not handled");
    return response;
  };
}

test("an over-budget upload manifest is refused without being drained", async () => {
  const call = fixture();
  const { stream, counters, totalBytes } = overBudgetStream();
  expect(totalBytes).toBeGreaterThan(2 * MAXIMUM_REQUEST_BODY_BYTES);
  await Bun.sleep(0);
  const before = counters.pulls;

  // The Host route maps this refusal to its `artifact_invalid` envelope.
  await expect(
    call("uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "manifest-over-budget" },
      body: stream,
      duplex: "half",
    } as RequestInit),
  ).rejects.toThrow(ArtifactInputError);
  expect((counters.pulls - before) * CHUNK_BYTES).toBeLessThanOrEqual(
    MAXIMUM_REQUEST_BODY_BYTES + 2 * CHUNK_BYTES,
  );
});

async function startUpload(
  call: ReturnType<typeof fixture>,
  declared: Uint8Array,
  key: string,
): Promise<{ readonly uploadId: string; readonly digest: string }> {
  const digest = await bytesDigest(declared);
  const started = await call("uploads", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      manifest: {
        apiVersion: "artifacts.takoform.com/v1alpha1",
        kind: "WorkerBundle",
        mainModule: "worker.mjs",
        modules: [
          {
            name: "worker.mjs",
            mediaType: "application/javascript+module",
            size: declared.byteLength,
            digest,
          },
        ],
      },
    }),
  });
  expect(started.status).toBe(201);
  const { uploadId } = (await started.json()) as { uploadId: string };
  return { uploadId, digest };
}

test("a blob longer than its declared size is refused without being drained", async () => {
  const call = fixture();
  const declared = new Uint8Array(3 * CHUNK_BYTES).fill(0x20);
  const { uploadId, digest } = await startUpload(call, declared, "blob-over-declared");
  const { stream, counters, totalBytes } = overBudgetStream();
  expect(totalBytes).toBeGreaterThan(2 * declared.byteLength);
  await Bun.sleep(0);
  const before = counters.pulls;

  const response = await call(`uploads/${uploadId}/blobs/${digest}`, {
    method: "PUT",
    body: stream,
    duplex: "half",
  } as RequestInit);

  expect(response.status).toBe(400);
  expect(((await response.json()) as { error?: { code?: unknown } }).error?.code).toBe(
    "artifact_invalid",
  );
  // Reading stops at the first chunk past the declared size.
  expect((counters.pulls - before) * CHUNK_BYTES).toBeLessThanOrEqual(
    declared.byteLength + 2 * CHUNK_BYTES,
  );
});

test("a streamed blob of exactly its declared size is accepted", async () => {
  const call = fixture();
  const declared = new Uint8Array(3 * CHUNK_BYTES).fill(0x20);
  const { uploadId, digest } = await startUpload(call, declared, "blob-exact");
  const { stream } = instrumentedBodyStream({ chunkBytes: CHUNK_BYTES, totalChunks: 3 });

  const response = await call(`uploads/${uploadId}/blobs/${digest}`, {
    method: "PUT",
    body: stream,
    duplex: "half",
  } as RequestInit);

  expect(response.status).toBe(201);
});
