import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bytesDigest } from "../src/json.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2ArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const MANIFEST_URL = "https://artifacts.example.test/assets/manifest.json";
const FILE_URL = "https://artifacts.example.test/assets/site.css";
const CONSUMER_FORM_URL = "https://edge.forms.takoform.com/forms/AssetConsumer/0.2.0/";
const FILE_BYTES = new Uint8Array([0x00, 0xff, 0x20, 0x41]);

async function fixture() {
  const db = new Database(":memory:");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0072_v2_artifact_custody.sql",
    "0073_v2_reference_acceptance.sql",
  ]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = createSqliteSql(db);
  const fileSha256 = (await bytesDigest(FILE_BYTES)).slice("sha256:".length);
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      files: [
        {
          path: "public/site.css",
          url: FILE_URL,
          sha256: fileSha256,
          mediaType: "text/css",
        },
      ],
    }),
  );
  const manifestSha256 = (await bytesDigest(manifestBytes)).slice("sha256:".length);
  const blobs = new Map<string, Uint8Array>([
    [MANIFEST_URL, manifestBytes],
    [FILE_URL, FILE_BYTES],
  ]);
  const reads: string[] = [];
  const source: V2ArtifactSource = {
    async read({ principal, space, url, sha256, maxBytes }) {
      expect(principal).toBe("alice");
      expect(space).toBe("default");
      reads.push(url);
      const bytes = blobs.get(url);
      if (
        !bytes ||
        bytes.byteLength > maxBytes ||
        (await bytesDigest(bytes)) !== `sha256:${sha256}`
      ) {
        throw new Error("source unavailable");
      }
      return bytes;
    },
  };
  const { form } = createStaticAssetBundleHost({
    sql,
    source,
    targetKey: "selfhost-control-sqlite-1",
  });
  const consumer: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    references(spec) {
      return [
        {
          resourceUid: spec.bundleResourceUid as string,
          formUrl: STATIC_ASSET_BUNDLE_FORM_URL,
          readiness: "observed",
        },
      ];
    },
    backend: {
      id: "test-static-asset-consumer-v1",
      targetKey: "selfhost-control-sqlite-1",
      async execute() {
        return { kind: "complete", observed: {}, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const nowMs = Date.parse("2026-10-06T00:00:00.000Z");
  const engine = () =>
    createTakoformV2Engine({
      sql,
      now: () => new Date(nowMs),
      replayWindowSeconds: 3_600,
      leaseMilliseconds: 1_000,
      authorize: async (principal, space) => principal === "alice" && space === "default",
      forms: {
        [STATIC_ASSET_BUNDLE_FORM_URL]: form,
        [CONSUMER_FORM_URL]: consumer,
      },
    });
  const spec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
  return {
    db,
    blobs,
    reads,
    engine,
    spec,
    manifestSha256,
    fileSha256,
  };
}

test("StaticAssetBundle uses shared durable custody through replay, source-gone update, references and release", async () => {
  const f = await fixture();
  try {
    const host = f.engine();
    const created = await host.acceptCreate({
      principal: "alice",
      key: "static-asset-create-0001",
      input: {
        form: STATIC_ASSET_BUNDLE_FORM_URL,
        space: "default",
        name: "site-assets",
        spec: f.spec,
      },
    });
    expect(await host.runNext()).toMatchObject({
      id: created.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(await host.getResource({ principal: "alice", uid: created.resourceUid })).toMatchObject({
      observedGeneration: 1,
      observed: {
        manifestSha256: f.manifestSha256,
        fileCount: 1,
        totalBytes: FILE_BYTES.byteLength,
        files: [
          {
            path: "public/site.css",
            sha256: f.fileSha256,
            mediaType: "text/css",
            byteSize: FILE_BYTES.byteLength,
          },
        ],
      },
      output: {},
    });

    f.blobs.clear();
    const readsBefore = f.reads.length;
    expect(
      await host.acceptCreate({
        principal: "alice",
        key: "static-asset-create-0001",
        input: {
          form: STATIC_ASSET_BUNDLE_FORM_URL,
          space: "default",
          name: "site-assets",
          spec: f.spec,
        },
      }),
    ).toMatchObject({ id: created.id, status: "succeeded", resourceUid: created.resourceUid });
    expect(f.reads).toHaveLength(readsBefore);

    const consumer = await host.acceptCreate({
      principal: "alice",
      key: "static-asset-consumer-0001",
      input: {
        form: CONSUMER_FORM_URL,
        space: "default",
        name: "site",
        spec: { bundleResourceUid: created.resourceUid },
      },
    });
    expect(await host.runNext()).toMatchObject({ id: consumer.id, status: "succeeded" });
    await expect(
      host.acceptDelete({
        principal: "alice",
        key: "static-asset-delete-referenced-0001",
        uid: created.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });

    const consumerDelete = await host.acceptDelete({
      principal: "alice",
      key: "static-asset-consumer-delete-0001",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
    });
    expect(await host.runNext()).toMatchObject({ id: consumerDelete.id, status: "succeeded" });

    const update = await host.acceptUpdate({
      principal: "alice",
      key: "static-asset-update-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: f.spec,
    });
    expect(await f.engine().runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(f.reads).toHaveLength(readsBefore);

    const deletion = await host.acceptDelete({
      principal: "alice",
      key: "static-asset-delete-0001",
      uid: created.resourceUid,
      expectedGeneration: 2,
    });
    expect(await host.runNext()).toMatchObject({ id: deletion.id, status: "succeeded" });
    expect(f.db.query("SELECT * FROM tf_v2_artifact_owners").all()).toHaveLength(0);
    expect(f.db.query("SELECT * FROM tf_v2_artifact_chunks").all()).toHaveLength(0);
  } finally {
    f.db.close();
  }
});
