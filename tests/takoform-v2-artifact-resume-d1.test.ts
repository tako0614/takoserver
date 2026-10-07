import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleForm } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import type { V2Operation } from "../src/takoform-v2/types.ts";

const MANIFEST_URL = "https://artifacts.example.test/resume/manifest.json";
const FILE_URL = "https://artifacts.example.test/resume/large.bin";
const FILE_BYTES = new Uint8Array(8 * 1024 * 1024).fill(0x61);

test("native D1 resumes one accepted artifact Operation within each invocation query budget", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-artifact-resume-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-artifact-resume-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS.filter(({ name }) =>
      [
        "0070_takoform_v2.sql",
        "0071_v2_sqlite_migration_set_custody.sql",
        "0072_v2_artifact_custody.sql",
        "0075_v2_artifact_progress.sql",
        "0081_v2_private_inputs.sql",
      ].includes(name),
    )) {
      for (const statement of splitMigration(migration.sql)) {
        await database.prepare(statement).run();
      }
    }
    const baseSql = createD1Sql(database);
    let counting = false;
    let invocationQueries = 0;
    let loseChunkAck = false;
    const count = (queries = 1) => {
      if (!counting) return;
      invocationQueries += queries;
      if (invocationQueries > 50) {
        throw new SqlError("unavailable", "D1 invocation query budget exceeded");
      }
    };
    const sql: Sql = {
      async query(statement, params) {
        count();
        return await baseSql.query(statement, params);
      },
      async run(statement, params) {
        count();
        const result = await baseSql.run(statement, params);
        if (loseChunkAck && statement.includes("INSERT OR IGNORE INTO tf_v2_artifact_chunks")) {
          loseChunkAck = false;
          throw new SqlError("unavailable", "simulated lost chunk acknowledgement");
        }
        return result;
      },
      async batch(statements) {
        count(statements.length);
        return await baseSql.batch(statements);
      },
    };
    const fileSha256 = (await bytesDigest(FILE_BYTES)).slice(7);
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        files: [
          {
            path: "large.bin",
            url: FILE_URL,
            sha256: fileSha256,
            mediaType: "application/octet-stream",
          },
        ],
      }),
    );
    const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
    const available = new Map<string, Uint8Array>([
      [MANIFEST_URL, manifestBytes],
      [FILE_URL, FILE_BYTES],
    ]);
    const source = {
      async read({ url, sha256, maxBytes }: { url: string; sha256: string; maxBytes: number }) {
        const bytes = available.get(url);
        if (
          !bytes ||
          bytes.byteLength > maxBytes ||
          (await bytesDigest(bytes)) !== `sha256:${sha256}`
        )
          throw new Error("source unavailable");
        return bytes;
      },
    };
    let nowMs = Date.now();
    const form = createStaticAssetBundleForm({ sql, source, targetKey: "resume-d1-target" });
    const engine = () =>
      createTakoformV2Engine({
        sql,
        now: () => new Date(nowMs),
        replayWindowSeconds: 3_600,
        leaseMilliseconds: 30_000,
        authorize: async (principal, space) => principal === "alice" && space === "default",
        forms: { [STATIC_ASSET_BUNDLE_FORM_URL]: form },
      });
    const spec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
    const accepted = await engine().acceptCreate({
      principal: "alice",
      key: "native-d1-artifact-resume-create-0001",
      input: { form: STATIC_ASSET_BUNDLE_FORM_URL, space: "default", name: "assets", spec },
    });
    let reconciles = 0;
    let completed = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      invocationQueries = 0;
      counting = true;
      let outcome: V2Operation | null = null;
      try {
        outcome = await engine().runNext();
      } finally {
        counting = false;
      }
      expect(invocationQueries).toBeLessThanOrEqual(50);
      expect(outcome?.id).toBe(accepted.id);
      if (outcome?.status === "succeeded") {
        completed = true;
        break;
      }
      expect(outcome).toMatchObject({ status: "reconciling", effect: "unknown" });
      expect(
        (await engine().getResource({ principal: "alice", uid: accepted.resourceUid }))
          .observedGeneration,
      ).toBe(0);
      reconciles += 1;
      nowMs += 1_001;
    }
    expect(reconciles).toBeGreaterThan(0);
    expect(completed).toBe(true);
    expect(
      await engine().getResource({ principal: "alice", uid: accepted.resourceUid }),
    ).toMatchObject({
      observedGeneration: 1,
      observed: {
        manifestSha256,
        fileCount: 1,
        totalBytes: FILE_BYTES.byteLength,
        files: [{ path: "large.bin", sha256: fileSha256, byteSize: FILE_BYTES.byteLength }],
      },
    });

    // An exactly full chunk was durably staged, but its acknowledgement was
    // lost before the file cursor advanced. Reconcile from SQL after the
    // authorized source disappears; never fetch it or report early success.
    const exactBytes = new Uint8Array(65_536).fill(0x62);
    const exactSha256 = (await bytesDigest(exactBytes)).slice(7);
    const exactUrl = "https://artifacts.example.test/resume/exact.bin";
    const exactManifestUrl = "https://artifacts.example.test/resume/exact-manifest.json";
    const exactManifestBytes = new TextEncoder().encode(
      JSON.stringify({
        files: [
          {
            path: "exact.bin",
            url: exactUrl,
            sha256: exactSha256,
            mediaType: "application/octet-stream",
          },
        ],
      }),
    );
    const exactManifestSha256 = (await bytesDigest(exactManifestBytes)).slice(7);
    available.set(exactManifestUrl, exactManifestBytes);
    available.set(exactUrl, exactBytes);
    const exactSpec = { artifact: { url: exactManifestUrl, sha256: exactManifestSha256 } };
    const exact = await engine().acceptCreate({
      principal: "alice",
      key: "native-d1-artifact-resume-exact-0001",
      input: {
        form: STATIC_ASSET_BUNDLE_FORM_URL,
        space: "default",
        name: "exact",
        spec: exactSpec,
      },
    });
    const boundedRun = async () => {
      invocationQueries = 0;
      counting = true;
      try {
        const outcome = await engine().runNext();
        expect(invocationQueries).toBeLessThanOrEqual(50);
        return outcome;
      } finally {
        counting = false;
      }
    };
    loseChunkAck = true;
    expect(await boundedRun()).toMatchObject({
      id: exact.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(
      await baseSql.query(
        "SELECT next_file_index, current_file_bytes FROM tf_v2_artifact_progress WHERE operation_id = ?",
        [exact.id],
      ),
    ).toEqual([{ next_file_index: 0, current_file_bytes: exactBytes.byteLength }]);
    expect(
      await baseSql.query(
        "SELECT COUNT(*) AS count FROM tf_v2_artifact_chunks WHERE resource_uid = ?",
        [exact.resourceUid],
      ),
    ).toEqual([{ count: 1 }]);
    available.delete(exactUrl);
    available.delete(exactManifestUrl);
    expect(
      (await engine().getResource({ principal: "alice", uid: exact.resourceUid }))
        .observedGeneration,
    ).toBe(0);
    nowMs += 30_001;
    expect(await boundedRun()).toMatchObject({
      id: exact.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await engine().getResource({ principal: "alice", uid: exact.resourceUid }),
    ).toMatchObject({
      observedGeneration: 1,
      observed: {
        totalBytes: exactBytes.byteLength,
        files: [{ sha256: exactSha256, byteSize: exactBytes.byteLength }],
      },
    });
    const update = await engine().acceptUpdate({
      principal: "alice",
      key: "native-d1-artifact-exact-update-0001",
      uid: exact.resourceUid,
      expectedGeneration: 1,
      spec: exactSpec,
    });
    expect(await boundedRun()).toMatchObject({ id: update.id, status: "succeeded" });
    const deletion = await engine().acceptDelete({
      principal: "alice",
      key: "native-d1-artifact-exact-delete-0001",
      uid: exact.resourceUid,
      expectedGeneration: 2,
    });
    expect(await boundedRun()).toMatchObject({ id: deletion.id, status: "succeeded" });
    expect(
      await baseSql.query(
        "SELECT COUNT(*) AS count FROM tf_v2_artifact_chunks WHERE resource_uid = ?",
        [exact.resourceUid],
      ),
    ).toEqual([{ count: 0 }]);

    available.delete(FILE_URL);
    available.delete(MANIFEST_URL);
    const heldUpdate = await engine().acceptUpdate({
      principal: "alice",
      key: "native-d1-artifact-large-update-0001",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    expect(await boundedRun()).toMatchObject({ id: heldUpdate.id, status: "succeeded" });
    available.set(FILE_URL, FILE_BYTES);
    available.set(MANIFEST_URL, manifestBytes);

    // A source that disappears with only a partial file held cannot be
    // called complete. Terminal no-effect settlement atomically collects the
    // unverified owner, its chunks, and the Operation checkpoint.
    const partial = await engine().acceptCreate({
      principal: "alice",
      key: "native-d1-artifact-partial-0001",
      input: { form: STATIC_ASSET_BUNDLE_FORM_URL, space: "default", name: "partial", spec },
    });
    expect(await boundedRun()).toMatchObject({ id: partial.id, status: "reconciling" });
    available.delete(FILE_URL);
    available.delete(MANIFEST_URL);
    nowMs += 1_001;
    expect(await boundedRun()).toMatchObject({ id: partial.id, status: "failed", effect: "none" });
    expect(
      (await engine().getResource({ principal: "alice", uid: partial.resourceUid }))
        .observedGeneration,
    ).toBe(0);
    for (const table of ["tf_v2_artifact_owners", "tf_v2_artifact_chunks"] as const) {
      expect(
        await baseSql.query(`SELECT COUNT(*) AS count FROM ${table} WHERE resource_uid = ?`, [
          partial.resourceUid,
        ]),
      ).toEqual([{ count: 0 }]);
    }
    expect(
      await baseSql.query(
        "SELECT COUNT(*) AS count FROM tf_v2_artifact_progress WHERE operation_id = ?",
        [partial.id],
      ),
    ).toEqual([{ count: 0 }]);

    const tinyFiles = await Promise.all(
      Array.from({ length: 7 }, async (_, index) => {
        const url = `https://artifacts.example.test/resume/tiny-${index}.bin`;
        const bytes = new Uint8Array([index]);
        available.set(url, bytes);
        return {
          path: `tiny-${index}.bin`,
          url,
          sha256: (await bytesDigest(bytes)).slice(7),
          mediaType: "application/octet-stream",
        };
      }),
    );
    const tinyManifestUrl = "https://artifacts.example.test/resume/tiny-manifest.json";
    const tinyManifestBytes = new TextEncoder().encode(JSON.stringify({ files: tinyFiles }));
    available.set(tinyManifestUrl, tinyManifestBytes);
    const tiny = await engine().acceptCreate({
      principal: "alice",
      key: "native-d1-artifact-tiny-0001",
      input: {
        form: STATIC_ASSET_BUNDLE_FORM_URL,
        space: "default",
        name: "tiny",
        spec: {
          artifact: {
            url: tinyManifestUrl,
            sha256: (await bytesDigest(tinyManifestBytes)).slice(7),
          },
        },
      },
    });
    expect(await boundedRun()).toMatchObject({ id: tiny.id, status: "reconciling" });
    const tinyCursor = await baseSql.query(
      "SELECT next_file_index FROM tf_v2_artifact_progress WHERE operation_id = ?",
      [tiny.id],
    );
    expect(tinyCursor[0]?.next_file_index).toBeGreaterThan(0);
    expect(tinyCursor[0]?.next_file_index).toBeLessThan(7);
    let tinyOutcome: V2Operation | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      nowMs += 1_001;
      tinyOutcome = await boundedRun();
      if (tinyOutcome?.status === "succeeded") break;
    }
    expect(tinyOutcome).toMatchObject({ id: tiny.id, status: "succeeded" });
    expect(await engine().getResource({ principal: "alice", uid: tiny.resourceUid })).toMatchObject(
      {
        observedGeneration: 1,
        observed: { fileCount: 7, totalBytes: 7 },
      },
    );
  } finally {
    await runtime.dispose();
  }
}, 30_000);

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
