import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bytesDigest } from "../src/json.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createSqlArtifactCustody } from "../src/takoform-v2/forms/artifact-custody.ts";

const FORM = "https://forms.example.test/forms/CustodyProbe/0.2.0/source.md";
const MANIFEST_URL = "https://artifacts.example.test/probe/manifest.json";

async function runWithSmallLimits(files: readonly Uint8Array[]) {
  const db = new Database(":memory:");
  try {
    for (const name of [
      "0070_takoform_v2.sql",
      "0071_v2_sqlite_migration_set_custody.sql",
      "0072_v2_artifact_custody.sql",
    ]) {
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    const sql = createSqliteSql(db);
    const fileEntries = await Promise.all(
      files.map(async (bytes, index) => ({
        url: `https://artifacts.example.test/probe/file-${index}`,
        sha256: (await bytesDigest(bytes)).slice(7),
      })),
    );
    const manifestBytes = new TextEncoder().encode(JSON.stringify({ files: fileEntries }));
    const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
    const blobs = new Map<string, Uint8Array>([[MANIFEST_URL, manifestBytes]]);
    for (const [index, bytes] of files.entries()) {
      const entry = fileEntries[index];
      if (entry) blobs.set(entry.url, bytes);
    }
    const reads: { url: string; maxBytes: number }[] = [];
    const apply = createSqlArtifactCustody({
      sql,
      source: {
        async read({ url, maxBytes }) {
          reads.push({ url, maxBytes });
          const bytes = blobs.get(url);
          if (!bytes || bytes.byteLength > maxBytes) throw new Error("source read exceeds cap");
          return bytes;
        },
      },
      layout: "artifact-0072",
      formUrl: FORM,
      limits: { manifestBytes: 1024, fileBytes: 4, aggregateBytes: 4 },
      parseSpec: (spec) =>
        spec as unknown as { readonly artifact: { readonly url: string; readonly sha256: string } },
      parseManifest: (bytes) =>
        JSON.parse(new TextDecoder().decode(bytes)) as {
          files: { url: string; sha256: string }[];
        },
      validatePayload: async ({ fileBytes }) => ({
        observed: { fileCount: fileBytes.length },
        output: {},
      }),
      invalidArtifact: () => new Error("invalid artifact"),
      invalidManifest: () => new Error("invalid manifest"),
      failureNoun: "Probe",
    });
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3600,
      authorize: async () => true,
      forms: {
        [FORM]: {
          validateCreate() {},
          validateUpdate() {},
          backend: {
            id: "test-custody-small-cap-v1",
            targetKey: "test-sqlite",
            execute: apply,
            reconcile: apply,
          },
        },
      },
    });
    await engine.acceptCreate({
      principal: "alice",
      key: "small-custody-budget-0001",
      input: {
        form: FORM,
        space: "default",
        name: "probe",
        spec: { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } },
      },
    });
    const result = await engine.runNext();
    const chunks = db
      .query(
        "SELECT file_index, length(bytes) AS bytes FROM tf_v2_artifact_chunks ORDER BY file_index",
      )
      .all();
    return { result, reads, chunks };
  } finally {
    db.close();
  }
}

test("aggregate byte budget caps each source read before staging, including zero-byte files", async () => {
  const three = new TextEncoder().encode("abc");
  const four = new TextEncoder().encode("abcd");
  const one = new TextEncoder().encode("x");

  const partialBudget = await runWithSmallLimits([three, three]);
  expect(partialBudget.result).toMatchObject({ status: "failed", effect: "none" });
  expect(partialBudget.reads.at(-1)?.maxBytes).toBe(1);
  expect(partialBudget.chunks).toHaveLength(0);

  const exhaustedBudget = await runWithSmallLimits([four, one]);
  expect(exhaustedBudget.result).toMatchObject({ status: "failed", effect: "none" });
  expect(exhaustedBudget.reads.at(-1)?.maxBytes).toBe(0);
  expect(exhaustedBudget.chunks).toHaveLength(0);

  const authorizedEmpty = await runWithSmallLimits([four, new Uint8Array(0)]);
  expect(authorizedEmpty.result).toMatchObject({ status: "succeeded", effect: "complete" });
  expect(authorizedEmpty.reads.at(-1)?.maxBytes).toBe(0);
  expect(authorizedEmpty.chunks).toEqual([
    { file_index: 0, bytes: 4 },
    { file_index: 1, bytes: 0 },
  ]);
});
