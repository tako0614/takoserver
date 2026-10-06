import { expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import {
  parseWorkerBundleManifest,
  parseWorkerBundleSpec,
  validateWorkerBundlePayload,
  validateWorkerBundleUpdate,
  WORKER_BUNDLE_LIMITS,
  type WorkerBundleErrorCode,
  type WorkerBundleMediaType,
  WorkerBundleValidationError,
} from "../src/takoform-v2/forms/worker-bundle.ts";

const encoder = new TextEncoder();
const MANIFEST_URL = "https://artifacts.example.test/build/manifest.json";
const MODULE_URL = "https://artifacts.example.test/build/main.mjs";
const HASH_A = "a".repeat(64);

async function sha256(bytes: Uint8Array): Promise<string> {
  return (await bytesDigest(bytes)).slice("sha256:".length);
}

function spec(url = MANIFEST_URL, sha256Value = HASH_A) {
  return { artifact: { url, sha256: sha256Value } };
}

function file(
  path: string,
  sha256Value = HASH_A,
  mediaType: WorkerBundleMediaType = "application/javascript+module",
  url = MODULE_URL,
) {
  return { path, url, sha256: sha256Value, mediaType };
}

function manifest(
  files: unknown[],
  entrypoint = "src/main.mjs",
  extra: Record<string, unknown> = {},
): Uint8Array {
  return encoder.encode(JSON.stringify({ entrypoint, files, ...extra }));
}

function expectValidationCode(action: () => unknown, code: WorkerBundleErrorCode): void {
  try {
    action();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerBundleValidationError);
    expect((error as WorkerBundleValidationError).code).toBe(code);
    expect((error as Error).message).not.toContain(MANIFEST_URL);
  }
}

test("spec preserves exact artifact identity and updates cannot replace it", () => {
  expect(parseWorkerBundleSpec(spec())).toEqual(spec());
  expect(parseWorkerBundleSpec({ artifact: { sha256: HASH_A, url: MANIFEST_URL } })).toEqual(
    spec(),
  );
  expect(validateWorkerBundleUpdate(spec(), { artifact: { ...spec().artifact } })).toEqual(spec());

  const invalidSpecs: unknown[] = [
    { ...spec(), extra: true },
    { artifact: { ...spec().artifact, extra: true } },
    spec("https://user@artifacts.example.test/manifest.json"),
    spec("https://artifacts.example.test/manifest.json?"),
    spec("https://artifacts.example.test/manifest.json#"),
    spec("https://artifacts.example.test/manifest.json", `A${"a".repeat(63)}`),
    spec(`https://artifacts.example.test/${"x".repeat(8_192)}`),
    spec("https://artifacts.example.test/manifest-é.json"),
  ];
  for (const bad of invalidSpecs)
    expectValidationCode(() => parseWorkerBundleSpec(bad), "invalid_spec");
  expectValidationCode(
    () => validateWorkerBundleUpdate(spec(), spec("https://artifacts.example.test/new.json")),
    "invalid_spec",
  );
  expectValidationCode(
    () => validateWorkerBundleUpdate(spec(), spec(MANIFEST_URL, "b".repeat(64))),
    "invalid_spec",
  );
});

test("manifest enforces its closed shape, duplicate-free strict JSON, paths, URLs and media types", () => {
  const one = file("src/main.mjs");
  expect(parseWorkerBundleManifest(manifest([one]))).toEqual({
    entrypoint: "src/main.mjs",
    files: [one],
  });

  const bad: Uint8Array[] = [
    encoder.encode('{"entrypoint":"src/main.mjs","entrypoint":"src/main.mjs","files":[]}'),
    manifest([one], "src/main.mjs", { unknown: true }),
    manifest([{ ...one, unknown: true }]),
    manifest([{ ...one, path: "" }]),
    manifest([{ ...one, path: "/absolute.mjs" }]),
    manifest([{ ...one, path: "src/" }]),
    manifest([{ ...one, path: "src//main.mjs" }]),
    manifest([{ ...one, path: "src/./main.mjs" }]),
    manifest([{ ...one, path: "src/../main.mjs" }]),
    manifest([{ ...one, path: "src\\main.mjs" }]),
    manifest([{ ...one, path: "src/main?.mjs" }]),
    manifest([{ ...one, path: "src/main#.mjs" }]),
    manifest([{ ...one, path: `src/${"é".repeat(512)}.mjs` }]),
    manifest([{ ...one, path: "src/main\u007f.mjs" }]),
    manifest([one, { ...one }]),
    manifest([{ ...one, url: "https://user@artifacts.example.test/main.mjs" }]),
    manifest([{ ...one, url: "https://artifacts.example.test/main.mjs?" }]),
    manifest([{ ...one, url: "https://artifacts.example.test/main.mjs#" }]),
    manifest([{ ...one, sha256: HASH_A.toUpperCase() }]),
    manifest([{ ...one, mediaType: "application/source-map+json" }]),
    manifest([{ ...one, mediaType: "application/json" }]),
    manifest([file("src/main.mjs", HASH_A, "text/plain")]),
    manifest([file("src/entry.mjs"), file("src/main.mjs", HASH_A, "text/plain")]),
    manifest([], "src/main.mjs"),
    manifest([one], "src/absent.mjs"),
    new Uint8Array([0xff, 0xfe]),
    new Uint8Array(WORKER_BUNDLE_LIMITS.manifestBytes + 1),
  ];
  for (const bytes of bad)
    expectValidationCode(() => parseWorkerBundleManifest(bytes), "invalid_manifest");

  const tooMany = Array.from({ length: WORKER_BUNDLE_LIMITS.fileCount + 1 }, (_, index) =>
    file(`src/${index}.mjs`),
  );
  expectValidationCode(() => parseWorkerBundleManifest(manifest(tooMany)), "invalid_manifest");

  // Paths compare by exact string, with case kept distinct and no normalization.
  expect(
    parseWorkerBundleManifest(
      manifest([file("src/main.mjs"), file("src/Main.mjs", HASH_A, "text/plain")]),
    ).files.map(({ path }) => path),
  ).toEqual(["src/main.mjs", "src/Main.mjs"]);
});

test("validates exact raw bytes into an ordered projection with no artifact URLs", async () => {
  // Deliberately invalid JS syntax: validation hashes and inventories bytes, it does not evaluate them.
  const moduleBytes = encoder.encode("this is not valid JavaScript {{{\n");
  const textBytes = encoder.encode("plain text\n");
  const manifestBytes = manifest([
    file("src/main.mjs", await sha256(moduleBytes)),
    file(
      "assets/readme.txt",
      await sha256(textBytes),
      "text/plain",
      "https://artifacts.example.test/readme.txt",
    ),
  ]);
  const expectedManifestSha256 = await sha256(manifestBytes);
  const result = await validateWorkerBundlePayload({
    spec: spec(MANIFEST_URL, expectedManifestSha256),
    manifestBytes,
    fileBytes: [moduleBytes, textBytes],
  });

  expect(result).toEqual({
    observed: {
      manifestSha256: expectedManifestSha256,
      fileCount: 2,
      totalBytes: moduleBytes.byteLength + textBytes.byteLength,
      entrypoint: "src/main.mjs",
      files: [
        {
          path: "src/main.mjs",
          sha256: await sha256(moduleBytes),
          mediaType: "application/javascript+module",
          byteSize: moduleBytes.byteLength,
        },
        {
          path: "assets/readme.txt",
          sha256: await sha256(textBytes),
          mediaType: "text/plain",
          byteSize: textBytes.byteLength,
        },
      ],
    },
    output: {},
  });
  expect(JSON.stringify(result)).not.toContain("artifacts.example.test");
});

test("accepts all and only the four ModuleWorker media types without filename inference", () => {
  const supported = [
    "application/javascript+module",
    "text/plain",
    "application/octet-stream",
    "application/wasm",
  ] as const;
  for (const [index, mediaType] of supported.entries()) {
    const files = [file("bundle/main", HASH_A, "application/javascript+module")];
    if (index > 0) files.push(file(`bundle/asset-${index}.wasm`, HASH_A, mediaType));
    expect(
      parseWorkerBundleManifest(manifest(files, "bundle/main")).files[index > 0 ? 1 : 0]?.mediaType,
    ).toBe(index > 0 ? mediaType : "application/javascript+module");
  }
  expect(
    parseWorkerBundleManifest(
      manifest(
        [file("bundle/main.mjs"), file("bundle/misleading.wasm", HASH_A, "text/plain")],
        "bundle/main.mjs",
      ),
    ).files[1]?.mediaType,
  ).toBe("text/plain");
});

test("payload validation rejects digest mismatch, mismatched file count, and byte limits", async () => {
  const bytes = encoder.encode("export default {};");
  const manifestBytes = manifest([file("src/main.mjs", await sha256(bytes))]);
  const validSpec = spec(MANIFEST_URL, await sha256(manifestBytes));
  await expect(
    validateWorkerBundlePayload({
      spec: validSpec,
      manifestBytes,
      fileBytes: [encoder.encode("changed")],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(
    validateWorkerBundlePayload({
      spec: spec(MANIFEST_URL, HASH_A),
      manifestBytes,
      fileBytes: [bytes],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(
    validateWorkerBundlePayload({ spec: validSpec, manifestBytes, fileBytes: [] }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });

  const oversized = new Uint8Array(WORKER_BUNDLE_LIMITS.fileBytes + 1);
  const oversizedManifest = manifest([file("src/main.mjs", await sha256(oversized))]);
  await expect(
    validateWorkerBundlePayload({
      spec: spec(MANIFEST_URL, await sha256(oversizedManifest)),
      manifestBytes: oversizedManifest,
      fileBytes: [oversized],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });

  // Reuse one backing buffer; the validator must reject aggregate size before hashing file payloads.
  const maxFile = new Uint8Array(WORKER_BUNDLE_LIMITS.fileBytes);
  const maxFileDigest = await sha256(maxFile);
  const aggregateManifest = manifest(
    Array.from({ length: 9 }, (_, index) =>
      file(
        `src/${index}.mjs`,
        maxFileDigest,
        index === 0 ? "application/javascript+module" : "text/plain",
      ),
    ),
    "src/0.mjs",
  );
  await expect(
    validateWorkerBundlePayload({
      spec: spec(MANIFEST_URL, await sha256(aggregateManifest)),
      manifestBytes: aggregateManifest,
      fileBytes: Array.from({ length: 9 }, () => maxFile),
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
});
