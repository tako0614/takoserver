import { expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import {
  parseSQLiteMigrationManifest,
  parseSQLiteMigrationSetSpec,
  SQLITE_MIGRATION_SET_LIMITS,
  type SQLiteMigrationSetErrorCode,
  SQLiteMigrationSetValidationError,
  validateSQLiteMigrationPayload,
  validateSQLiteMigrationSetUpdate,
} from "../src/takoform-v2/forms/sqlite-migration-set.ts";

const encoder = new TextEncoder();
const MANIFEST_URL = "https://Artifacts.Example/migrations/manifest.json";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function sha256(bytes: Uint8Array): Promise<string> {
  return (await bytesDigest(bytes)).slice("sha256:".length);
}

function spec(url = MANIFEST_URL, sha256Value = HASH_A) {
  return { artifact: { url, sha256: sha256Value } };
}

function file(
  path = "migrations/0001-create.sql",
  sha256Value = HASH_A,
  extra: Record<string, unknown> = {},
) {
  return {
    path,
    url: "https://Artifacts.Example/migrations/0001-create.sql",
    sha256: sha256Value,
    mediaType: "application/sql",
    ...extra,
  };
}

function manifest(files: unknown[], extra: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(JSON.stringify({ files, ...extra }));
}

function expectValidationCode(action: () => unknown, code: SQLiteMigrationSetErrorCode): void {
  try {
    action();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteMigrationSetValidationError);
    expect((error as SQLiteMigrationSetValidationError).code).toBe(code);
    expect((error as Error).message).not.toContain(MANIFEST_URL);
  }
}

test("SQLiteMigrationSet spec preserves exact HTTPS identity and rejects unsafe URL structure", () => {
  expect(parseSQLiteMigrationSetSpec(spec())).toEqual(spec());
  expect(parseSQLiteMigrationSetSpec({ artifact: { sha256: HASH_A, url: MANIFEST_URL } })).toEqual(
    spec(),
  );

  const badSpecs: unknown[] = [
    { ...spec(), extra: true },
    { artifact: { ...spec().artifact, extra: true } },
    spec("https://user@artifacts.example/migrations/manifest.json"),
    spec("https://artifacts.example/migrations/manifest.json?"),
    spec("https://artifacts.example/migrations/manifest.json#"),
    spec("https://artifacts.example/migrations/manifest.json", `A${"a".repeat(63)}`),
    spec(`https://artifacts.example/${"x".repeat(8_192)}`),
    spec("https://artifacts.example/migrations/é.json"),
  ];
  for (const bad of badSpecs)
    expectValidationCode(() => parseSQLiteMigrationSetSpec(bad), "invalid_spec");
});

test("SQLiteMigrationSet update allows only the exact artifact URL and digest", () => {
  const previous = spec();
  expect(
    validateSQLiteMigrationSetUpdate(previous, { artifact: { ...previous.artifact } }),
  ).toEqual(previous);
  expectValidationCode(
    () =>
      validateSQLiteMigrationSetUpdate(
        previous,
        spec("https://artifacts.example/migrations/manifest.json"),
      ),
    "invalid_spec",
  );
  expectValidationCode(
    () => validateSQLiteMigrationSetUpdate(previous, spec(MANIFEST_URL, HASH_B)),
    "invalid_spec",
  );
});

test("manifest parsing enforces UTF-8 JSON, exact fields, file count, paths, URLs, and digests", () => {
  const one = file();
  expect(parseSQLiteMigrationManifest(manifest([one]))).toEqual({
    files: [
      {
        path: one.path,
        url: one.url,
        sha256: one.sha256,
        mediaType: "application/sql",
      },
    ],
  });

  const invalidManifests: Uint8Array[] = [
    encoder.encode('{"files":[],"files":[]}'),
    manifest([one], { unknown: true }),
    manifest([file("", HASH_A)]),
    manifest([file("/absolute.sql", HASH_A)]),
    manifest([file("migrations/", HASH_A)]),
    manifest([file("migrations//one.sql", HASH_A)]),
    manifest([file("migrations/./one.sql", HASH_A)]),
    manifest([file("migrations/../one.sql", HASH_A)]),
    manifest([file("migrations\\one.sql", HASH_A)]),
    manifest([file("migrations/one?.sql", HASH_A)]),
    manifest([file("migrations/one#.sql", HASH_A)]),
    manifest([file("migrations/one\u007f.sql", HASH_A)]),
    manifest([file("é".repeat(513), HASH_A)]),
    manifest([file(), file()]),
    manifest([file("migrations/one.sql", HASH_A, { unknown: true })]),
    manifest([file("migrations/one.sql", HASH_A, { mediaType: "text/plain" })]),
    manifest([{ ...one, url: "https://user@artifacts.example/file.sql" }]),
    manifest([{ ...one, url: "https://artifacts.example/file.sql?" }]),
    manifest([{ ...one, url: "https://artifacts.example/file.sql#" }]),
    manifest([{ ...one, sha256: HASH_A.toUpperCase() }]),
    new Uint8Array([0xff, 0xfe]),
    new Uint8Array(SQLITE_MIGRATION_SET_LIMITS.manifestBytes + 1),
  ];
  for (const bytes of invalidManifests) {
    expectValidationCode(() => parseSQLiteMigrationManifest(bytes), "invalid_manifest");
  }
  const tooMany = Array.from({ length: 513 }, (_, index) => file(`migrations/${index}.sql`));
  expectValidationCode(() => parseSQLiteMigrationManifest(manifest(tooMany)), "invalid_manifest");
});

test("payload validation hashes exact manifest and UTF-8 file bytes and returns a URL-free ordered projection", async () => {
  const firstBytes = encoder.encode("CREATE TABLE café (id INTEGER);\n");
  const secondBytes = encoder.encode("INSERT INTO café VALUES (1);\n");
  const manifestBytes = manifest([
    file("migrations/0001-create.sql", await sha256(firstBytes)),
    {
      path: "migrations/日本語/0002-seed.sql",
      url: "https://Artifacts.Example/migrations/0002-seed.sql",
      sha256: await sha256(secondBytes),
      mediaType: "application/sql",
    },
  ]);
  const expectedManifestSha256 = await sha256(manifestBytes);
  const projection = await validateSQLiteMigrationPayload({
    spec: spec(MANIFEST_URL, expectedManifestSha256),
    manifestBytes,
    fileBytes: [firstBytes, secondBytes],
  });
  expect(projection.observed).toEqual({
    manifestSha256: expectedManifestSha256,
    fileCount: 2,
    totalBytes: firstBytes.byteLength + secondBytes.byteLength,
    files: [
      {
        path: "migrations/0001-create.sql",
        sha256: await sha256(firstBytes),
        mediaType: "application/sql",
        byteSize: firstBytes.byteLength,
      },
      {
        path: "migrations/日本語/0002-seed.sql",
        sha256: await sha256(secondBytes),
        mediaType: "application/sql",
        byteSize: secondBytes.byteLength,
      },
    ],
  });
  expect(projection.output).toEqual({});
  expect(JSON.stringify(projection)).not.toContain("Artifacts.Example");
});

test("payload validation rejects changed digests, invalid UTF-8, BOM, missing payloads, and file limit overflow", async () => {
  const validBytes = encoder.encode("SELECT 1;\n");
  const manifestBytes = manifest([file("migrations/one.sql", await sha256(validBytes))]);
  const expectedManifestSha256 = await sha256(manifestBytes);
  const validSpec = spec(MANIFEST_URL, expectedManifestSha256);

  await expect(
    validateSQLiteMigrationPayload({
      spec: validSpec,
      manifestBytes,
      fileBytes: [encoder.encode("SELECT 2;\n")],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(
    validateSQLiteMigrationPayload({
      spec: spec(MANIFEST_URL, HASH_B),
      manifestBytes,
      fileBytes: [validBytes],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(
    validateSQLiteMigrationPayload({
      spec: validSpec,
      manifestBytes,
      fileBytes: [],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });

  const invalidUtf8 = new Uint8Array([0xff]);
  const invalidUtf8Manifest = manifest([file("migrations/invalid.sql", await sha256(invalidUtf8))]);
  await expect(
    validateSQLiteMigrationPayload({
      spec: spec(MANIFEST_URL, await sha256(invalidUtf8Manifest)),
      manifestBytes: invalidUtf8Manifest,
      fileBytes: [invalidUtf8],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });

  const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...validBytes]);
  const bomManifest = manifest([file("migrations/bom.sql", await sha256(bomBytes))]);
  await expect(
    validateSQLiteMigrationPayload({
      spec: spec(MANIFEST_URL, await sha256(bomManifest)),
      manifestBytes: bomManifest,
      fileBytes: [bomBytes],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });

  const oversized = new Uint8Array(SQLITE_MIGRATION_SET_LIMITS.fileBytes + 1);
  const sizeManifest = manifest([file("migrations/oversized.sql", HASH_A)]);
  await expect(
    validateSQLiteMigrationPayload({
      spec: spec(MANIFEST_URL, await sha256(sizeManifest)),
      manifestBytes: sizeManifest,
      fileBytes: [oversized],
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });

  const maxFile = new Uint8Array(SQLITE_MIGRATION_SET_LIMITS.fileBytes);
  const aggregateManifest = manifest(
    Array.from({ length: 9 }, (_, index) => file(`migrations/aggregate-${index}.sql`, HASH_A)),
  );
  await expect(
    validateSQLiteMigrationPayload({
      spec: spec(MANIFEST_URL, await sha256(aggregateManifest)),
      manifestBytes: aggregateManifest,
      fileBytes: Array.from({ length: 9 }, () => maxFile),
    }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
});
