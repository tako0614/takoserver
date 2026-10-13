import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { V2ArtifactSourceError } from "../src/takoform-v2/forms/artifact-source.ts";
import {
  createV2HeldOrPublicArtifactSource,
  createV2PublicHttpsArtifactSource,
  type V2PublicOnlyArtifactFetch,
} from "../src/takoform-v2/forms/public-https-artifact-source.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleForm } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleForm } from "../src/takoform-v2/forms/worker-bundle-backend.ts";

const ARTIFACT_URL = "https://publisher.example.com/bundles/manifest.json";
const bytes = new TextEncoder().encode("public verified artifact");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const claim = {
  principal: "org:alice",
  space: "alice",
  url: ARTIFACT_URL,
  sha256,
  maxBytes: 1_024,
};

async function code(result: Promise<unknown>): Promise<string> {
  try {
    await result;
    return "none";
  } catch (error) {
    return error instanceof V2ArtifactSourceError ? error.code : "unexpected";
  }
}

test("public HTTPS source obtains exact bytes through only an injected public transport", async () => {
  const requests: Request[] = [];
  const fetchPublic: V2PublicOnlyArtifactFetch = async (request) => {
    requests.push(request);
    return new Response(bytes);
  };
  const source = createV2PublicHttpsArtifactSource({ fetchPublic });
  const received = await source.read(claim);
  expect(received).toEqual(bytes);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(ARTIFACT_URL);
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.redirect).toBe("manual");
  // Bun 1.4 reports `include` even for a Request initialized with `omit`.
  // The source creates the Request from a URL, never from caller headers.
  expect(Array.from(requests[0]?.headers ?? [])).toEqual([]);
});

test("public HTTPS source refuses non-public or noncanonical URL before transport", async () => {
  let calls = 0;
  const source = createV2PublicHttpsArtifactSource({
    async fetchPublic() {
      calls++;
      return new Response(bytes);
    },
  });
  for (const url of [
    "https://127.0.0.1/file",
    "https://[::1]/file",
    "https://localhost/file",
    "https://intranet/file",
    "https://service.internal/file",
    "https://publisher.example.com:8443/file",
    "https://publisher.example.com/file?token=secret",
    "https://user:secret@publisher.example.com/file",
    "https://Publisher.example.com/file",
  ]) {
    expect(await code(source.read({ ...claim, url }))).toBe("unavailable");
  }
  expect(calls).toBe(0);
});

test("public HTTPS source requires a code-selected transport and snapshots it", async () => {
  expect(() => Reflect.apply(createV2PublicHttpsArtifactSource, undefined, [{}])).toThrow(
    "public-only artifact transport is required",
  );
  let originalCalls = 0;
  let replacementCalls = 0;
  const selected = {
    async fetchPublic() {
      originalCalls++;
      return new Response(bytes);
    },
    timeoutMilliseconds: 1_000,
  };
  const source = createV2PublicHttpsArtifactSource(selected);
  selected.fetchPublic = async () => {
    replacementCalls++;
    return new Response("replacement");
  };
  selected.timeoutMilliseconds = -1;
  expect(await source.read(claim)).toEqual(bytes);
  expect(originalCalls).toBe(1);
  expect(replacementCalls).toBe(0);
  expect(await code(source.read({ ...claim, maxBytes: 134_217_729 }))).toBe("unavailable");
  expect(await code(source.read({ ...claim, sha256: "NOT-A-DIGEST" }))).toBe("unavailable");
  expect(originalCalls).toBe(1);
});

test("public HTTPS source rejects redirects, non-200 responses, and changed target URLs", async () => {
  let cancelled = 0;
  const response = (status: number) =>
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      }),
      { status },
    );
  const replies = [response(302), response(404), response(200)];
  Object.defineProperty(replies[2], "url", { value: "https://other.example.com/file" });
  const source = createV2PublicHttpsArtifactSource({
    async fetchPublic() {
      return replies.shift() ?? new Response(bytes);
    },
  });
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await code(source.read(claim))).toBe("unavailable");
  expect(cancelled).toBe(3);
});

test("public HTTPS source bounds streamed bytes and verifies digest without leaking response data", async () => {
  let cancelled = 0;
  let calls = 0;
  const source = createV2PublicHttpsArtifactSource({
    async fetchPublic() {
      if (calls++ > 0) return new Response("private response payload");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("private response payload"));
          },
          cancel() {
            cancelled++;
          },
        }),
      );
    },
  });
  expect(await code(source.read({ ...claim, maxBytes: 3 }))).toBe("too_large");
  expect(cancelled).toBe(1);
  const corrupt = await code(source.read(claim));
  expect(corrupt).toBe("integrity_failure");
  expect(corrupt).not.toContain("private response payload");
});

test("public HTTPS source aborts a stalled fetch and disposes its late response body", async () => {
  let release!: (response: Response) => void;
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const source = createV2PublicHttpsArtifactSource({
    timeoutMilliseconds: 10,
    async fetchPublic(request) {
      signal = request.signal;
      return await pending;
    },
  });
  expect(await code(source.read(claim))).toBe("timeout");
  expect(signal?.aborted).toBe(true);
  release(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(cancelled).toBe(true);
});

test("public HTTPS source times out a stalled body even when cancel never settles", async () => {
  let cancelled = false;
  const source = createV2PublicHttpsArtifactSource({
    timeoutMilliseconds: 10,
    async fetchPublic() {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => undefined);
          },
          cancel() {
            cancelled = true;
            return new Promise<void>(() => undefined);
          },
        }),
      );
    },
  });
  expect(await code(source.read(claim))).toBe("timeout");
  expect(cancelled).toBe(true);
});

test("held URL ownership never falls back to public HTTPS on wrong digest, grant, or bytes", async () => {
  const objects = createMemoryObjectStore();
  await objects.put("held/manifest", bytes, { contentType: "application/octet-stream" });
  const entries = [
    {
      url: ARTIFACT_URL,
      sha256,
      objectKey: "held/manifest",
      grants: [{ principal: claim.principal, space: claim.space }],
    },
  ];
  let publicCalls = 0;
  const source = createV2HeldOrPublicArtifactSource({
    objects,
    entries,
    async fetchPublic() {
      publicCalls++;
      return new Response(bytes);
    },
  });
  entries[0] = {
    url: "https://other.example.com/manifest.json",
    sha256,
    objectKey: "held/manifest",
    grants: [{ principal: claim.principal, space: claim.space }],
  };
  expect(await source.read(claim)).toEqual(bytes);
  expect(await code(source.read({ ...claim, sha256: "0".repeat(64) }))).toBe("unavailable");
  expect(await code(source.read({ ...claim, principal: "org:other" }))).toBe("unavailable");
  await objects.put("held/manifest", new TextEncoder().encode("corrupt"), {
    contentType: "application/octet-stream",
  });
  expect(await code(source.read(claim))).toBe("integrity_failure");
  expect(publicCalls).toBe(0);
  expect(await source.read({ ...claim, url: "https://other.example.com/manifest.json" })).toEqual(
    bytes,
  );
  expect(publicCalls).toBe(1);
});

test("WorkerBundle and StaticAssetBundle acquire a new public origin and replay from custody", async () => {
  const manifestUrl = "https://new-publisher.example.com/worker/manifest.json";
  const fileUrl = "https://new-publisher.example.com/worker/index.mjs";
  const file = new TextEncoder().encode(
    "export default { fetch() { return new Response('ok'); } };",
  );
  const fileDigest = createHash("sha256").update(file).digest("hex");
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.mjs",
      files: [
        {
          path: "index.mjs",
          url: fileUrl,
          sha256: fileDigest,
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const manifestDigest = createHash("sha256").update(manifest).digest("hex");
  const assetManifestUrl = "https://new-publisher.example.com/assets/manifest.json";
  const assetFileUrl = "https://new-publisher.example.com/assets/site.css";
  const assetFile = new TextEncoder().encode("body { color: black; }");
  const assetFileDigest = createHash("sha256").update(assetFile).digest("hex");
  const assetManifest = new TextEncoder().encode(
    JSON.stringify({
      files: [
        { path: "site.css", url: assetFileUrl, sha256: assetFileDigest, mediaType: "text/css" },
      ],
    }),
  );
  const assetManifestDigest = createHash("sha256").update(assetManifest).digest("hex");
  const blobs = new Map([
    [manifestUrl, manifest],
    [fileUrl, file],
    [assetManifestUrl, assetManifest],
    [assetFileUrl, assetFile],
  ]);
  let fetches = 0;
  const source = createV2PublicHttpsArtifactSource({
    async fetchPublic(request) {
      fetches++;
      const found = blobs.get(request.url);
      return found ? new Response(found) : new Response(null, { status: 404 });
    },
  });
  const db = new Database(":memory:");
  try {
    for (const name of [
      "0070_takoform_v2.sql",
      "0071_v2_sqlite_migration_set_custody.sql",
      "0072_v2_artifact_custody.sql",
      "0075_v2_artifact_progress.sql",
      "0081_v2_private_inputs.sql",
    ])
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const sql = createSqliteSql(db);
    const targetKey = "new-public-source-target";
    const bundleForm = createWorkerBundleForm({ sql, source, targetKey });
    const assetForm = createStaticAssetBundleForm({ sql, source, targetKey });
    const host = () =>
      createTakoformV2Engine({
        sql,
        now: () => new Date(),
        replayWindowSeconds: 3_600,
        leaseMilliseconds: 1_000,
        authorize: async (principal, space) => principal === "org:alice" && space === "alice",
        forms: {
          [WORKER_BUNDLE_FORM_URL]: bundleForm,
          [STATIC_ASSET_BUNDLE_FORM_URL]: assetForm,
        },
      });
    const body = {
      form: WORKER_BUNDLE_FORM_URL,
      space: "alice",
      name: "public-origin-bundle",
      spec: { artifact: { url: manifestUrl, sha256: manifestDigest } },
    };
    const first = await host().acceptCreate({
      principal: "org:alice",
      key: "public-origin-create-0001",
      input: body,
    });
    expect(await host().runNext()).toMatchObject({ id: first.id, status: "succeeded" });
    expect(fetches).toBe(2);
    const assetBody = {
      form: STATIC_ASSET_BUNDLE_FORM_URL,
      space: "alice",
      name: "public-origin-assets",
      spec: { artifact: { url: assetManifestUrl, sha256: assetManifestDigest } },
    };
    const acceptedAsset = await host().acceptCreate({
      principal: "org:alice",
      key: "public-origin-assets-0001",
      input: assetBody,
    });
    expect(await host().runNext()).toMatchObject({ id: acceptedAsset.id, status: "succeeded" });
    expect(fetches).toBe(4);
    expect(
      await host().getResource({ principal: "org:alice", uid: first.resourceUid }),
    ).toMatchObject({
      observedGeneration: 1,
      observed: { manifestSha256: manifestDigest, files: [{ sha256: fileDigest }] },
    });
    expect(
      await host().getResource({ principal: "org:alice", uid: acceptedAsset.resourceUid }),
    ).toMatchObject({
      observedGeneration: 1,
      observed: { manifestSha256: assetManifestDigest, files: [{ sha256: assetFileDigest }] },
    });
    blobs.clear();
    const replay = await host().acceptCreate({
      principal: "org:alice",
      key: "public-origin-create-0001",
      input: body,
    });
    expect(replay.id).toBe(first.id);
    expect(replay.resourceUid).toBe(first.resourceUid);
    const assetReplay = await host().acceptCreate({
      principal: "org:alice",
      key: "public-origin-assets-0001",
      input: assetBody,
    });
    expect(assetReplay.id).toBe(acceptedAsset.id);
    expect(assetReplay.resourceUid).toBe(acceptedAsset.resourceUid);
    const update = await host().acceptUpdate({
      principal: "org:alice",
      key: "public-origin-update-0001",
      uid: first.resourceUid,
      expectedGeneration: 1,
      spec: body.spec,
    });
    expect(await host().runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(fetches).toBe(4);
  } finally {
    db.close();
  }
});
