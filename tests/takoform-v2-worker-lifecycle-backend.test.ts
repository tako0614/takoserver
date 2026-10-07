import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  createInternalV2ModuleWorkerForm,
  createInternalV2StaticWorkerVersionForm,
  type V2WorkerRetirementProof,
  type V2WorkerRetirementTarget,
} from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const TARGET_KEY = "internal-static-worker-management";
const MANIFEST_URL = "https://artifacts.example.test/static/manifest.json";
const FILE_URL = "https://artifacts.example.test/static/index.html";
const FILE_BYTES = new TextEncoder().encode("<main>held asset</main>");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v2-worker-lifecycle-"));
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let nowMs = Date.now();
  let sourceAvailable = true;
  let sourceReads = 0;
  let retirementMode: "unknown" | "confirmed" | "wrong_identity" = "unknown";
  let retirementCalls = 0;
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      files: [
        {
          path: "index.html",
          url: FILE_URL,
          sha256: sha256(FILE_BYTES),
          mediaType: "text/html",
        },
      ],
    }),
  );
  const source = {
    async read({ url }: { url: string }) {
      sourceReads += 1;
      if (!sourceAvailable) throw new Error("artifact source is offline");
      if (url === MANIFEST_URL) return manifest;
      if (url === FILE_URL) return FILE_BYTES;
      throw new Error("unrecognized artifact source");
    },
  };
  const assetHost = createStaticAssetBundleHost({ sql, source, targetKey: TARGET_KEY });
  const publicationState = createV2WorkerPublicationState({
    sql,
    now: () => new Date(nowMs),
    assetCustody: assetHost.custody,
  });
  const retirement = {
    async observeRetired(target: V2WorkerRetirementTarget) {
      retirementCalls += 1;
      if (retirementMode === "unknown") return { kind: "unknown" as const };
      const proof: V2WorkerRetirementProof = {
        kind: "retired",
        target:
          retirementMode === "wrong_identity"
            ? { ...target, principal: "another-organization" }
            : target,
        scope: "all_incarnations_and_contexts",
        receipt: "fixture-only-retirement-observation",
      };
      return proof;
    },
  };
  const workerForm = createInternalV2ModuleWorkerForm({ sql, targetKey: TARGET_KEY, retirement });
  const versionForm = createInternalV2StaticWorkerVersionForm({
    sql,
    targetKey: TARGET_KEY,
    publicationState,
    retirement,
  });
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(nowMs),
    replayWindowSeconds: 3_600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: workerForm,
      [WORKER_VERSION_FORM_URL]: versionForm,
      [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
    },
  });
  async function create(form: string, name: string, spec: JsonObject) {
    const accepted = await engine.acceptCreate({
      principal: "org-1",
      key: `create-${name}-key`,
      input: { form, space: "prod", name, spec },
    });
    const outcome = await engine.runNext();
    expect(outcome).toMatchObject({ id: accepted.id, status: "succeeded", effect: "complete" });
    return accepted;
  }
  async function createWorkerAndAssets() {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const assets = await create(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
      artifact: { url: MANIFEST_URL, sha256: sha256(manifest) },
    });
    const spec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: assets.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    };
    return { worker, assets, spec };
  }
  return {
    db,
    sql,
    engine,
    workerForm,
    versionForm,
    retirement,
    create,
    createWorkerAndAssets,
    get nowMs() {
      return nowMs;
    },
    set nowMs(value: number) {
      nowMs = value;
    },
    get sourceReads() {
      return sourceReads;
    },
    set sourceAvailable(value: boolean) {
      sourceAvailable = value;
    },
    get retirementCalls() {
      return retirementCalls;
    },
    set retirementMode(value: typeof retirementMode) {
      retirementMode = value;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("ModuleWorker allocation and isolated same-spec update never claim runtime readiness", async () => {
  const f = fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      spec: {},
      observed: { activeDeploymentUid: null, ready: false },
      output: {},
      observedGeneration: 1,
    });
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-worker-key",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      generation: 2,
      observedGeneration: 2,
      observed: { activeDeploymentUid: null, ready: false },
    });
    const replay = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-worker-key",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(replay.id).toBe(update.id);
    expect(f.retirementCalls).toBe(0);
  } finally {
    f.close();
  }
});

test("static-only Version qualifies exact held bytes without source access or fake bundleVerified", async () => {
  const f = fixture();
  try {
    const { worker, assets, spec } = await f.createWorkerAndAssets();
    const sourceReads = f.sourceReads;
    f.sourceAvailable = false;
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    const observed = await f.engine.getResource({ principal: "org-1", uid: version.resourceUid });
    expect(observed).toMatchObject({
      observed: { ready: true, resolvedBindings: true },
      output: {},
      observedGeneration: 1,
    });
    expect(observed.observed).not.toHaveProperty("bundleVerified");
    expect(f.sourceReads).toBe(sourceReads);
    const references = await f.sql.query(
      "SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ? ORDER BY target_uid",
      [version.resourceUid],
    );
    expect(references.map((row) => row.target_uid)).toEqual(
      [worker.resourceUid, assets.resourceUid].sort(),
    );
    const same: JsonObject = {
      ...spec,
      vars: {},
      requiredSensitiveVars: [],
      kvBindings: [],
    };
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-version-key",
      uid: version.resourceUid,
      expectedGeneration: 1,
      spec: same,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(f.sourceReads).toBe(sourceReads);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: version.resourceUid }),
    ).toMatchObject({ observedGeneration: 2, observed: { ready: true, resolvedBindings: true } });
  } finally {
    f.close();
  }
});

test("immutable Version and unauthorized or unsupported references refuse before effects", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    await expect(
      f.engine.acceptUpdate({
        principal: "org-1",
        key: "different-version-key",
        uid: version.resourceUid,
        expectedGeneration: 1,
        spec: { ...spec, handlers: ["fetch"] },
      }),
    ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
    await expect(
      f.engine.acceptCreate({
        principal: "org-1",
        key: "unsupported-code-version-key",
        input: {
          form: WORKER_VERSION_FORM_URL,
          space: "prod",
          name: "code-version",
          spec: {
            worker: { resourceUid: worker.resourceUid },
            bundle: { resourceUid: "bundle" },
            handlers: ["fetch"],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "capability_required", status: 422 });
    await expect(
      f.engine.acceptCreate({
        principal: "org-1",
        key: "wrong-worker-key",
        input: {
          form: WORKER_VERSION_FORM_URL,
          space: "prod",
          name: "wrong-worker-version",
          spec: { ...spec, worker: { resourceUid: "other-worker" } },
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    expect(f.retirementCalls).toBe(0);
  } finally {
    f.close();
  }
});

test("damaged held asset custody cannot make an accepted Version Ready", async () => {
  const f = fixture();
  try {
    const { assets, spec } = await f.createWorkerAndAssets();
    f.sourceAvailable = false;
    const sourceReads = f.sourceReads;
    await f.sql.run("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ?", [
      assets.resourceUid,
    ]);
    const version = await f.engine.acceptCreate({
      principal: "org-1",
      key: "damaged-assets-version-key",
      input: { form: WORKER_VERSION_FORM_URL, space: "prod", name: "damaged-version", spec },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: version.id, status: "reconciling" });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: version.resourceUid }),
    ).toMatchObject({ observed: {}, observedGeneration: 0 });
    expect(f.sourceReads).toBe(sourceReads);
    expect(f.retirementCalls).toBe(0);
  } finally {
    f.close();
  }
});

test("DELETE keeps references and physical retirement separate, then settles only exact proof", async () => {
  const f = fixture();
  try {
    const { worker, assets, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    await expect(
      f.engine.acceptDelete({
        principal: "org-1",
        key: "delete-worker-while-version-key",
        uid: worker.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });

    const deletion = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-version-key",
      uid: version.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: deletion.id, status: "reconciling" });
    f.retirementMode = "wrong_identity";
    const pending = await f.sql.query(
      "SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id = ?",
      [deletion.id],
    );
    f.nowMs = Number(pending[0]?.next_attempt_at_ms) + 1;
    expect(await f.engine.runNext()).toMatchObject({ id: deletion.id, status: "reconciling" });
    f.retirementMode = "confirmed";
    const retry = await f.sql.query(
      "SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id = ?",
      [deletion.id],
    );
    f.nowMs = Number(retry[0]?.next_attempt_at_ms) + 1;
    expect(await f.engine.runNext()).toMatchObject({ id: deletion.id, status: "succeeded" });
    await expect(
      f.engine.getResource({ principal: "org-1", uid: version.resourceUid }),
    ).rejects.toMatchObject({ code: "gone", status: 410 });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: assets.resourceUid }),
    ).toMatchObject({
      uid: assets.resourceUid,
      observedGeneration: 1,
      phase: "idle",
    });

    const workerDeletion = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-worker-key",
      uid: worker.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: workerDeletion.id, status: "succeeded" });
    await expect(
      f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).rejects.toMatchObject({ code: "gone", status: 410 });
    expect(f.retirementCalls).toBe(4);
  } finally {
    f.close();
  }
});

test("retirement is a required constructor capability, not a default absence claim", () => {
  const f = fixture();
  try {
    expect(() =>
      createInternalV2ModuleWorkerForm({
        sql: f.sql,
        targetKey: TARGET_KEY,
        retirement: null as never,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createInternalV2StaticWorkerVersionForm({
        sql: f.sql,
        targetKey: TARGET_KEY,
        publicationState: createV2WorkerPublicationState({ sql: f.sql }),
        retirement: null as never,
      }),
    ).toThrow(TypeError);
  } finally {
    f.close();
  }
});

test("retirement callback identity is captured at construction, before SQL awaits", async () => {
  const f = fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    const deletion = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-worker-captured-reader-key",
      uid: worker.resourceUid,
      expectedGeneration: 1,
    });
    let replacementCalls = 0;
    f.retirement.observeRetired = async (target) => {
      replacementCalls += 1;
      return {
        kind: "retired",
        target,
        scope: "all_incarnations_and_contexts",
        receipt: "substituted-after-construction",
      };
    };
    expect(await f.engine.runNext()).toMatchObject({ id: deletion.id, status: "reconciling" });
    expect(replacementCalls).toBe(0);
    expect(f.retirementCalls).toBe(1);
  } finally {
    f.close();
  }
});
