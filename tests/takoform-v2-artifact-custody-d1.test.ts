import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  createWorkerBundleCustody,
  createWorkerBundleForm,
} from "../src/takoform-v2/forms/worker-bundle-backend.ts";

const MANIFEST_URL = "https://artifacts.example.test/d1-bundle/manifest.json";
const FILE_URL = "https://artifacts.example.test/d1-bundle/index.mjs";
const FILE_BYTES = new TextEncoder().encode(
  "export default { fetch() { return new Response('D1 custody'); } };",
);

test("native D1 custody verifies its own BLOB readback and survives source removal", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-artifact-custody-d1-test",
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
          env: { STATE_DB: { type: "d1", id: "v2-artifact-custody-d1-test" } },
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
    const sql = createD1Sql(database);
    const fileSha256 = (await bytesDigest(FILE_BYTES)).slice(7);
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "index.mjs",
        files: [
          {
            path: "index.mjs",
            url: FILE_URL,
            sha256: fileSha256,
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
    const available = new Map<string, Uint8Array>([
      [MANIFEST_URL, manifestBytes],
      [FILE_URL, FILE_BYTES],
    ]);
    const form = createWorkerBundleForm({
      sql,
      targetKey: "d1-custody-test-target",
      source: {
        async read({ principal, space, url, sha256, maxBytes }) {
          expect(principal).toBe("alice");
          expect(space).toBe("default");
          const bytes = available.get(url);
          if (
            !bytes ||
            bytes.byteLength > maxBytes ||
            (await bytesDigest(bytes)) !== `sha256:${sha256}`
          ) {
            throw new Error("source unavailable");
          }
          return bytes;
        },
      },
    });
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3_600,
      authorize: async (principal, space) => principal === "alice" && space === "default",
      forms: { [WORKER_BUNDLE_FORM_URL]: form },
    });
    const spec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
    const accepted = await engine.acceptCreate({
      principal: "alice",
      key: "d1-bundle-create-0001",
      input: { form: WORKER_BUNDLE_FORM_URL, space: "default", name: "bundle", spec },
    });
    const settled = await engine.runNext();
    // D1 returns BLOB results as number arrays, unlike Bun's SQLite adapter.
    const stored = await sql.query(
      "SELECT manifest_bytes FROM tf_v2_artifact_owners WHERE resource_uid = ?",
      [accepted.resourceUid],
    );
    expect(stored[0]?.manifest_bytes).toEqual(Array.from(manifestBytes));
    expect(settled).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    const resource = await engine.getResource({ principal: "alice", uid: accepted.resourceUid });
    expect(resource).toMatchObject({
      observedGeneration: 1,
      observed: {
        manifestSha256,
        entrypoint: "index.mjs",
        files: [{ path: "index.mjs", sha256: fileSha256, byteSize: FILE_BYTES.byteLength }],
      },
    });
    const readWithManifestRepresentation = (representation: unknown) => {
      const representedSql: Sql = {
        async query(statement, params) {
          const rows = await sql.query(statement, params);
          return statement.includes("SELECT * FROM tf_v2_artifact_owners")
            ? rows.map((row) => ({ ...row, manifest_bytes: representation }))
            : rows;
        },
        run: sql.run,
        batch: sql.batch,
      };
      return createWorkerBundleCustody({
        sql: representedSql,
        source: {
          async read() {
            throw new Error("source must not be read");
          },
        },
      }).readHeldVerified({
        targetResourceUid: accepted.resourceUid,
        principal: "alice",
        space: "default",
        expectedSpec: resource.spec,
        expectedObserved: resource.observed,
        stillAuthorized: async () => true,
      });
    };
    expect(
      (await readWithManifestRepresentation(new Uint8Array(manifestBytes))).manifestBytes,
    ).toEqual(manifestBytes);
    expect(
      (await readWithManifestRepresentation(manifestBytes.buffer.slice(0))).manifestBytes,
    ).toEqual(manifestBytes);
    const first = manifestBytes[0];
    if (first === undefined) throw new Error("manifest fixture is empty");
    for (const invalid of [first + 256, first + 0.5, String(first), -1, Number.NaN]) {
      await expect(
        readWithManifestRepresentation([invalid, ...Array.from(manifestBytes.slice(1))]),
      ).rejects.toMatchObject({ code: "unavailable" });
    }
    available.clear();
    const bounded = await createWorkerBundleCustody({
      sql,
      source: {
        async read() {
          throw new Error("source must not be read");
        },
      },
    }).openHeldUnverified({
      targetResourceUid: accepted.resourceUid,
      principal: "alice",
      space: "default",
      expectedSpec: resource.spec,
      expectedObserved: resource.observed,
      stillAuthorized: async () => true,
    });
    expect(bounded.fileSizes).toEqual([FILE_BYTES.byteLength]);
    const staged: Uint8Array[] = [];
    expect(
      await bounded.stageVerifiedFile({
        fileIndex: 0,
        async write(chunk) {
          staged.push(new Uint8Array(chunk));
        },
      }),
    ).toEqual({ sha256: fileSha256, byteSize: FILE_BYTES.byteLength });
    expect(staged).toEqual([FILE_BYTES]);
    const update = await engine.acceptUpdate({
      principal: "alice",
      key: "d1-bundle-update-0001",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    expect(await engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(
      await engine.getResource({ principal: "alice", uid: accepted.resourceUid }),
    ).toMatchObject({
      observedGeneration: 2,
    });
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
