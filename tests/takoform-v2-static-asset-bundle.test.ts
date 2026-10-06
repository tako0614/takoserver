import { expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import {
  parseStaticAssetBundleManifest,
  parseStaticAssetBundleSpec,
  STATIC_ASSET_BUNDLE_LIMITS,
  type StaticAssetBundleErrorCode,
  StaticAssetBundleValidationError,
  validateStaticAssetBundlePayload,
  validateStaticAssetBundleUpdate,
} from "../src/takoform-v2/forms/static-asset-bundle.ts";

const encoder = new TextEncoder();
const MANIFEST_URL = "https://artifacts.example.test/static/manifest.json";
const FILE_URL = "https://artifacts.example.test/static/main.css";
const HASH_A = "a".repeat(64);

async function sha256(bytes: Uint8Array): Promise<string> {
  return (await bytesDigest(bytes)).slice("sha256:".length);
}

function spec(url = MANIFEST_URL, sha256Value = HASH_A) {
  return { artifact: { url, sha256: sha256Value } };
}

function file(path: string, sha256Value = HASH_A, mediaType = "text/css", url = FILE_URL) {
  return { path, url, sha256: sha256Value, mediaType };
}

function manifest(files: unknown[], extra: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(JSON.stringify({ files, ...extra }));
}

function expectValidationCode(action: () => unknown, code: StaticAssetBundleErrorCode): void {
  try {
    action();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(StaticAssetBundleValidationError);
    expect((error as StaticAssetBundleValidationError).code).toBe(code);
    expect((error as Error).message).not.toContain(MANIFEST_URL);
  }
}

test("spec preserves exact artifact identity and updates cannot replace it", () => {
  expect(parseStaticAssetBundleSpec(spec())).toEqual(spec());
  expect(parseStaticAssetBundleSpec({ artifact: { sha256: HASH_A, url: MANIFEST_URL } })).toEqual(
    spec(),
  );
  expect(validateStaticAssetBundleUpdate(spec(), spec())).toEqual(spec());

  const bad: unknown[] = [
    { ...spec(), extra: true },
    { artifact: { ...spec().artifact, extra: true } },
    spec("https://user@artifacts.example.test/manifest.json"),
    spec("https://artifacts.example.test/manifest.json?"),
    spec("https://artifacts.example.test/manifest.json#"),
    spec("https://artifacts.example.test/manifest.json", `A${"a".repeat(63)}`),
    spec(`https://artifacts.example.test/${"x".repeat(8_192)}`),
    spec("https://artifacts.example.test/manifest-é.json"),
  ];
  for (const invalid of bad)
    expectValidationCode(() => parseStaticAssetBundleSpec(invalid), "invalid_spec");
  expectValidationCode(
    () => validateStaticAssetBundleUpdate(spec(), spec("https://artifacts.example.test/other")),
    "invalid_spec",
  );
  expectValidationCode(
    () => validateStaticAssetBundleUpdate(spec(), spec(MANIFEST_URL, "b".repeat(64))),
    "invalid_spec",
  );
});

test("manifest enforces closed strict JSON, paths, URLs, digest, media syntax and limits", () => {
  const one = file("assets/main.css");
  expect(parseStaticAssetBundleManifest(manifest([one]))).toEqual({ files: [one] });

  const bad: Uint8Array[] = [
    encoder.encode('{"files":[],"files":[]}'),
    manifest([one], { unknown: true }),
    manifest([{ ...one, unknown: true }]),
    manifest([{ ...one, path: "" }]),
    manifest([{ ...one, path: "/absolute.css" }]),
    manifest([{ ...one, path: "assets/" }]),
    manifest([{ ...one, path: "assets//main.css" }]),
    manifest([{ ...one, path: "assets/./main.css" }]),
    manifest([{ ...one, path: "assets/../main.css" }]),
    manifest([{ ...one, path: "assets\\main.css" }]),
    manifest([{ ...one, path: "assets/main?.css" }]),
    manifest([{ ...one, path: "assets/main#.css" }]),
    manifest([{ ...one, path: `assets/${"é".repeat(512)}.css` }]),
    manifest([{ ...one, path: "assets/main\u007f.css" }]),
    manifest([one, { ...one }]),
    manifest([{ ...one, url: "https://user@artifacts.example.test/file" }]),
    manifest([{ ...one, url: "https://artifacts.example.test/file?" }]),
    manifest([{ ...one, url: "https://artifacts.example.test/file#" }]),
    manifest([{ ...one, sha256: HASH_A.toUpperCase() }]),
    manifest([{ ...one, mediaType: "text/css; charset=utf-8" }]),
    manifest([{ ...one, mediaType: "text /css" }]),
    manifest([{ ...one, mediaType: "text/" }]),
    manifest([{ ...one, mediaType: "/css" }]),
    manifest([{ ...one, mediaType: "text/cßs" }]),
    manifest([], { ignored: "shape still invalid" }),
    new Uint8Array([0xff, 0xfe]),
    new Uint8Array(STATIC_ASSET_BUNDLE_LIMITS.manifestBytes + 1),
  ];
  for (const bytes of bad)
    expectValidationCode(() => parseStaticAssetBundleManifest(bytes), "invalid_manifest");

  const tooMany = Array.from({ length: STATIC_ASSET_BUNDLE_LIMITS.fileCount + 1 }, (_, index) =>
    file(`assets/${index}.css`),
  );
  expectValidationCode(() => parseStaticAssetBundleManifest(manifest(tooMany)), "invalid_manifest");

  // RFC token syntax is open-ended: the parser does not infer a type from a path or allowlist.
  const unusual = file("assets/no-extension", HASH_A, "application/vnd.example+json");
  expect(parseStaticAssetBundleManifest(manifest([unusual])).files[0]?.mediaType).toBe(
    "application/vnd.example+json",
  );
  expect(
    parseStaticAssetBundleManifest(
      manifest([file("assets/A", HASH_A, "Text/X_custom"), file("assets/a", HASH_A, "image/*")]),
    ).files.map(({ path }) => path),
  ).toEqual(["assets/A", "assets/a"]);
});

test("payload hashes exact ordered bytes and projects no source URLs", async () => {
  const first = new Uint8Array([0, 0xff, 0x42]);
  const second = encoder.encode("plain asset text\n");
  const manifestBytes = manifest([
    file("assets/raw", await sha256(first), "application/octet-stream"),
    file(
      "assets/readme",
      await sha256(second),
      "text/plain",
      "https://artifacts.example.test/readme",
    ),
  ]);
  const manifestSha256 = await sha256(manifestBytes);

  const result = await validateStaticAssetBundlePayload({
    spec: spec(MANIFEST_URL, manifestSha256),
    manifestBytes,
    fileBytes: [first, second],
  });
  expect(result).toEqual({
    observed: {
      manifestSha256,
      fileCount: 2,
      totalBytes: first.byteLength + second.byteLength,
      files: [
        {
          path: "assets/raw",
          sha256: await sha256(first),
          mediaType: "application/octet-stream",
          byteSize: first.byteLength,
        },
        {
          path: "assets/readme",
          sha256: await sha256(second),
          mediaType: "text/plain",
          byteSize: second.byteLength,
        },
      ],
    },
    output: {},
  });
  expect(JSON.stringify(result)).not.toContain("artifacts.example.test");
  await expect(
    validateStaticAssetBundlePayload({
      spec: spec(MANIFEST_URL, manifestSha256),
      manifestBytes,
      fileBytes: [first, encoder.encode("changed")],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(
    validateStaticAssetBundlePayload({
      spec: spec(MANIFEST_URL, HASH_A),
      manifestBytes,
      fileBytes: [first, second],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(
    validateStaticAssetBundlePayload({
      spec: spec(MANIFEST_URL, manifestSha256),
      manifestBytes,
      fileBytes: [first],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
});
