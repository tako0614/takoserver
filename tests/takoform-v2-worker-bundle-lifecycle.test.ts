import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bytesDigest } from "../src/json.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2ArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleForm } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const MANIFEST_URL = "https://artifacts.example.test/bundle/manifest.json";
const FILE_URL = "https://artifacts.example.test/bundle/index.mjs";
const FILE_BYTES = new TextEncoder().encode(
  "export default {fetch() { return new Response('held'); }};",
);

async function fixture(input?: {
  fileBytes?: Uint8Array;
  customizeSource?: (source: V2ArtifactSource, blobs: Map<string, Uint8Array>) => V2ArtifactSource;
  customizeForm?: (form: V2Form) => V2Form;
}) {
  const db = new Database(":memory:");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0072_v2_artifact_custody.sql",
  ]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = createSqliteSql(db);
  const fileBytes = input?.fileBytes ?? FILE_BYTES;
  const fileSha256 = (await bytesDigest(fileBytes)).slice(7);
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "src/index.mjs",
      files: [
        {
          path: "src/index.mjs",
          url: FILE_URL,
          sha256: fileSha256,
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
  const blobs = new Map<string, Uint8Array>([
    [MANIFEST_URL, manifestBytes],
    [FILE_URL, fileBytes],
  ]);
  const reads: string[] = [];
  const plainSource: V2ArtifactSource = {
    async read({ principal, space, url, sha256, maxBytes }) {
      expect(principal).toBe("alice");
      expect(space).toBe("default");
      reads.push(url);
      const bytes = blobs.get(url);
      if (
        !bytes ||
        bytes.byteLength > maxBytes ||
        (await bytesDigest(bytes)) !== `sha256:${sha256}`
      )
        throw new Error("source unavailable");
      return bytes;
    },
  };
  const source = input?.customizeSource?.(plainSource, blobs) ?? plainSource;
  const rawForm = createWorkerBundleForm({ sql, source, targetKey: "selfhost-control-sqlite-1" });
  const form = input?.customizeForm?.(rawForm) ?? rawForm;
  let nowMs = Date.parse("2026-10-06T00:00:00.000Z");
  const engine = () =>
    createTakoformV2Engine({
      sql,
      now: () => new Date(nowMs),
      replayWindowSeconds: 3_600,
      leaseMilliseconds: 1_000,
      authorize: async (principal, space) => principal === "alice" && space === "default",
      forms: { [WORKER_BUNDLE_FORM_URL]: form },
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
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

test("WorkerBundle holds exact bytes; source-gone read, same-spec update, and delete use custody", async () => {
  const f = await fixture();
  const host = f.engine();
  const created = await host.acceptCreate({
    principal: "alice",
    key: "worker-bundle-create-0001",
    input: { form: WORKER_BUNDLE_FORM_URL, space: "default", name: "bundle", spec: f.spec },
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
      entrypoint: "src/index.mjs",
      files: [{ path: "src/index.mjs", sha256: f.fileSha256, byteSize: FILE_BYTES.byteLength }],
    },
    output: {},
  });
  f.blobs.clear();
  const readsBefore = f.reads.length;
  const update = await host.acceptUpdate({
    principal: "alice",
    key: "worker-bundle-update-0001",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: f.spec,
  });
  expect(await f.engine().runNext()).toMatchObject({ id: update.id, status: "succeeded" });
  expect(f.reads).toHaveLength(readsBefore);
  const deletion = await host.acceptDelete({
    principal: "alice",
    key: "worker-bundle-delete-0001",
    uid: created.resourceUid,
    expectedGeneration: 2,
  });
  expect(await f.engine().runNext()).toMatchObject({ id: deletion.id, status: "succeeded" });
  expect(f.db.query("SELECT * FROM tf_v2_artifact_owners").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM tf_v2_artifact_chunks").all()).toHaveLength(0);
});

test("an empty bundle file still requires an authorized source read and durable sentinel", async () => {
  const f = await fixture({ fileBytes: new Uint8Array(0) });
  f.blobs.delete(FILE_URL);
  const host = f.engine();
  const created = await host.acceptCreate({
    principal: "alice",
    key: "worker-bundle-empty-0001",
    input: { form: WORKER_BUNDLE_FORM_URL, space: "default", name: "empty", spec: f.spec },
  });
  expect(await host.runNext()).toMatchObject({ id: created.id, status: "failed", effect: "none" });
  expect(f.reads).toContain(FILE_URL);
  expect(f.db.query("SELECT * FROM tf_v2_artifact_owners").all()).toHaveLength(0);
  f.blobs.set(FILE_URL, new Uint8Array(0));
  const retry = await host.acceptUpdate({
    principal: "alice",
    key: "worker-bundle-empty-retry-0001",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: f.spec,
  });
  expect(await host.runNext()).toMatchObject({ id: retry.id, status: "succeeded" });
  expect(f.db.query("SELECT length(bytes) AS n FROM tf_v2_artifact_chunks").get()).toEqual({
    n: 0,
  });
});

test("a lost create acknowledgement reconciles verified custody without source", async () => {
  let lost = false;
  const f = await fixture({
    customizeForm(form) {
      return {
        ...form,
        backend: {
          ...form.backend,
          async execute(input) {
            const result = await form.backend.execute(input);
            if (!lost) {
              lost = true;
              throw new Error("lost acknowledgement");
            }
            return result;
          },
        },
      };
    },
  });
  const first = f.engine();
  const created = await first.acceptCreate({
    principal: "alice",
    key: "worker-bundle-lost-ack-0001",
    input: { form: WORKER_BUNDLE_FORM_URL, space: "default", name: "bundle", spec: f.spec },
  });
  expect(await first.runNext()).toMatchObject({
    id: created.id,
    status: "reconciling",
    effect: "unknown",
  });
  f.blobs.clear();
  f.advance(1_001);
  expect(await f.engine().runNext()).toMatchObject({ id: created.id, status: "succeeded" });
  expect(
    (await first.getResource({ principal: "alice", uid: created.resourceUid })).observedGeneration,
  ).toBe(1);
  expect(
    await first.acceptCreate({
      principal: "alice",
      key: "worker-bundle-lost-ack-0001",
      input: { form: WORKER_BUNDLE_FORM_URL, space: "default", name: "bundle", spec: f.spec },
    }),
  ).toMatchObject({ id: created.id, status: "succeeded" });
});

test("a late old create writer cannot resurrect WorkerBundle bytes after delete", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  const f = await fixture({
    customizeSource(source) {
      return {
        async read(input) {
          if (input.url === FILE_URL && !held) {
            held = true;
            entered();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return source.read(input);
        },
      };
    },
  });
  const old = f.engine();
  const created = await old.acceptCreate({
    principal: "alice",
    key: "worker-bundle-stale-create-0001",
    input: { form: WORKER_BUNDLE_FORM_URL, space: "default", name: "bundle", spec: f.spec },
  });
  const oldRun = old.runNext();
  await waiting;
  f.advance(1_001);
  const resumed = f.engine();
  expect(await resumed.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
  const deletion = await resumed.acceptDelete({
    principal: "alice",
    key: "worker-bundle-stale-delete-0001",
    uid: created.resourceUid,
    expectedGeneration: 1,
  });
  expect(await resumed.runNext()).toMatchObject({ id: deletion.id, status: "succeeded" });
  release();
  await oldRun;
  expect(f.db.query("SELECT * FROM tf_v2_artifact_owners").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM tf_v2_artifact_chunks").all()).toHaveLength(0);
});

test("verified custody damage is partial and never replaced from source", async () => {
  const f = await fixture();
  const host = f.engine();
  const created = await host.acceptCreate({
    principal: "alice",
    key: "worker-bundle-damage-create-0001",
    input: { form: WORKER_BUNDLE_FORM_URL, space: "default", name: "bundle", spec: f.spec },
  });
  expect(await host.runNext()).toMatchObject({ status: "succeeded" });
  f.db.query("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ?").run(created.resourceUid);
  f.blobs.clear();
  const readsBefore = f.reads.length;
  const update = await host.acceptUpdate({
    principal: "alice",
    key: "worker-bundle-damage-update-0001",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: f.spec,
  });
  expect(await host.runNext()).toMatchObject({
    id: update.id,
    status: "failed",
    effect: "partial",
  });
  expect(f.reads).toHaveLength(readsBefore);
  expect(
    (await host.getResource({ principal: "alice", uid: created.resourceUid })).observedGeneration,
  ).toBe(1);
});
