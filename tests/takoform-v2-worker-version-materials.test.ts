import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  createWorkerBundleCustody,
  createWorkerBundleHost,
} from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import { referencesForWorkerVersion } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerVersionSpec,
  validateWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Backend, V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const TARGET_KEY = "version-materials-fixture";
const BUNDLE_MANIFEST_URL = "https://artifacts.example.test/version/bundle.json";
const BUNDLE_FILE_URL = "https://artifacts.example.test/version/index.js";
const ASSET_MANIFEST_URL = "https://artifacts.example.test/version/assets.json";
const ASSET_FILE_URL = "https://artifacts.example.test/version/index.html";
const BUNDLE_FILE = new TextEncoder().encode(
  "export default { fetch() { return new Response('held'); } };",
);
const ASSET_FILE = new TextEncoder().encode("<main>held asset</main>");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(options: { omitBundleReference?: boolean; bundleFile?: Uint8Array } = {}) {
  const root = mkdtempSync(join(tmpdir(), "v2-version-materials-"));
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  // Custody write guards use SQLite's real clock; keep lease tests on that epoch.
  let clockMs = Date.now();
  let sourceAvailable = true;
  let sourceReads = 0;
  const bundleFile = options.bundleFile ?? BUNDLE_FILE;
  const bundleManifest = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.js",
      files: [
        {
          path: "index.js",
          url: BUNDLE_FILE_URL,
          sha256: sha256(bundleFile),
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const assetManifest = new TextEncoder().encode(
    JSON.stringify({
      files: [
        {
          path: "index.html",
          url: ASSET_FILE_URL,
          sha256: sha256(ASSET_FILE),
          mediaType: "text/html",
        },
      ],
    }),
  );
  const source = {
    async read({ url }: { url: string }) {
      sourceReads += 1;
      if (!sourceAvailable) throw new Error("fixture source is gone");
      const bytes = new Map([
        [BUNDLE_MANIFEST_URL, bundleManifest],
        [BUNDLE_FILE_URL, bundleFile],
        [ASSET_MANIFEST_URL, assetManifest],
        [ASSET_FILE_URL, ASSET_FILE],
      ]).get(url);
      if (!bytes) throw new Error("unexpected fixture URL");
      return bytes;
    },
  };
  const bundleHost = createWorkerBundleHost({ sql, source, targetKey: TARGET_KEY });
  const assetHost = createStaticAssetBundleHost({ sql, source, targetKey: TARGET_KEY });
  const backend: V2Backend = {
    id: "fixture-version-materials-backend",
    targetKey: TARGET_KEY,
    async execute(input) {
      return {
        kind: "complete",
        observed:
          input.form === WORKER_VERSION_FORM_URL
            ? { ready: true, resolvedBindings: true, bundleVerified: true }
            : { ready: true },
        output: input.previousOutput,
      };
    },
    async reconcile(input) {
      return this.execute(input);
    },
  };
  const workerForm: V2Form = {
    validateCreate: parseModuleWorkerSpec,
    validateUpdate(_previous, spec) {
      parseModuleWorkerSpec(spec);
    },
    backend,
  };
  const versionForm: V2Form = {
    validateCreate: parseWorkerVersionSpec,
    validateUpdate: validateWorkerVersionUpdate,
    references(spec) {
      const complete = referencesForWorkerVersion(parseWorkerVersionSpec(spec));
      return options.omitBundleReference
        ? complete.filter((ref) => ref.formUrl !== WORKER_BUNDLE_FORM_URL)
        : complete;
    },
    backend,
  };
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(clockMs),
    replayWindowSeconds: 3_600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: workerForm,
      [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
      [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
      [WORKER_VERSION_FORM_URL]: versionForm,
    },
  });
  const store = createV2Store(sql);
  const reader = createV2WorkerPublicationState({
    sql,
    now: () => new Date(clockMs),
    bundleCustody: bundleHost.custody,
    assetCustody: assetHost.custody,
  });
  async function create(form: string, name: string, spec: JsonObject, settle = true) {
    const accepted = await engine.acceptCreate({
      principal: "org-1",
      key: `create-${name}-materials-key`,
      input: { form, space: "prod", name, spec },
    });
    if (settle)
      expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    return accepted;
  }
  async function basics() {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: BUNDLE_MANIFEST_URL, sha256: sha256(bundleManifest) },
    });
    const assets = await create(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
      artifact: { url: ASSET_MANIFEST_URL, sha256: sha256(assetManifest) },
    });
    const spec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      assets: {
        bundle: { resourceUid: assets.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    };
    return { worker, bundle, assets, spec };
  }
  async function claim(operationId: string, token = `lease-${operationId}`): Promise<V2Execution> {
    const op = await store.operation(operationId);
    const resource = op ? await store.resource(op.resource_uid) : null;
    if (!op || !resource) throw new Error("missing accepted operation");
    expect(await store.claim(op.id, token, clockMs, clockMs + 60_000)).toBe(true);
    if (op.dispatch_possible === 0) {
      expect(await store.markDispatch(op.id, token, new Date(clockMs).toISOString())).toBe(true);
    }
    return {
      operationId: op.id,
      leaseToken: token,
      backendKey: op.backend_key,
      backendId: op.backend_id,
      targetKey: op.target_key,
      resourceUid: resource.uid,
      principal: op.principal,
      action: op.action,
      generation: op.generation,
      form: resource.form_url,
      space: resource.space,
      name: resource.name,
      spec: JSON.parse(op.accepted_spec_json),
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
    };
  }
  return {
    db,
    sql,
    engine,
    store,
    reader,
    bundleHost,
    assetHost,
    create,
    basics,
    claim,
    get nowMs() {
      return clockMs;
    },
    set nowMs(value: number) {
      clockMs = value;
    },
    get sourceReads() {
      return sourceReads;
    },
    set sourceAvailable(value: boolean) {
      sourceAvailable = value;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("current accepted Version reads exact held Bundle and Asset bytes without source access", async () => {
  const f = fixture();
  try {
    const { worker, bundle, assets, spec } = await f.basics();
    f.sourceAvailable = false;
    const sourceReads = f.sourceReads;
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec, false);
    const replay = await f.engine.acceptCreate({
      principal: "org-1",
      key: "create-version-materials-key",
      input: { form: WORKER_VERSION_FORM_URL, space: "prod", name: "version", spec },
    });
    expect(replay.id).toBe(version.id);
    const execution = await f.claim(version.id);
    const result = await f.reader.resolveVersion({ execution });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.snapshot).toMatchObject({
      sourceOperationId: version.id,
      worker: { uid: worker.resourceUid, principal: "org-1", space: "prod", generation: 1 },
      version: { uid: version.resourceUid, generation: 1, spec: { handlers: ["fetch"] } },
    });
    expect(Object.isFrozen(result.snapshot.version.spec)).toBe(true);
    const first = await result.readMaterials();
    expect(new TextDecoder().decode(first.bundle?.files[0])).toEqual(
      new TextDecoder().decode(BUNDLE_FILE),
    );
    expect(new TextDecoder().decode(first.assets?.files[0])).toEqual(
      new TextDecoder().decode(ASSET_FILE),
    );
    first.bundle?.files[0]?.fill(0);
    first.assets?.files[0]?.fill(0);
    const second = await result.readMaterials();
    expect(new TextDecoder().decode(second.bundle?.files[0])).toEqual(
      new TextDecoder().decode(BUNDLE_FILE),
    );
    expect(new TextDecoder().decode(second.assets?.files[0])).toEqual(
      new TextDecoder().decode(ASSET_FILE),
    );
    expect(await result.stillCurrent()).toBe(true);
    expect(f.sourceReads).toBe(sourceReads);
    const refs = await f.sql.query(
      "SELECT target_uid FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
      [version.id],
    );
    expect(refs.map((row) => row.target_uid)).toEqual(
      [worker.resourceUid, bundle.resourceUid, assets.resourceUid].sort(),
    );
  } finally {
    f.close();
  }
});

test("unverified Version scope stages bounded held pages without aggregate reads or source access", async () => {
  const large = new Uint8Array(16 * 65_536 + 23);
  for (let index = 0; index < large.length; index += 1) large[index] = index % 251;
  const f = fixture({ bundleFile: large });
  try {
    const { spec } = await f.basics();
    f.sourceAvailable = false;
    const before = f.sourceReads;
    const version = await f.create(WORKER_VERSION_FORM_URL, "paged-version", spec, false);
    const execution = await f.claim(version.id);
    const reader = createV2WorkerPublicationState({
      sql: f.sql,
      now: () => new Date(f.nowMs),
      bundleCustody: {
        ...f.bundleHost.custody,
        async readHeldVerified() {
          throw new Error("aggregate material read is forbidden");
        },
      },
      assetCustody: f.assetHost.custody,
    });
    const captured = await reader.resolveVersionUnverified({ execution });
    expect(captured.kind).toBe("unverified");
    if (captured.kind !== "unverified") return;
    const scopes = await captured.openMaterialsUnverified();
    expect(scopes.bundle?.fileSizes).toEqual([large.byteLength]);
    const first = await scopes.bundle?.readPage({ fileIndex: 0, nextChunk: 0 });
    expect(first?.chunks).toHaveLength(16);
    expect(first?.nextChunk).toBe(16);
    const last = await scopes.bundle?.readPage({ fileIndex: 0, nextChunk: 16 });
    expect(last?.chunks).toEqual([large.slice(16 * 65_536)]);
    expect(last?.nextChunk).toBeNull();
    scopes.bundle?.manifestBytes.fill(0);
    if (scopes.bundle) (scopes.bundle.fileSizes as number[])[0] = 0;
    const staged: Uint8Array[] = [];
    expect(
      await scopes.bundle?.stageVerifiedFile({
        fileIndex: 0,
        async write(chunk) {
          staged.push(new Uint8Array(chunk));
        },
      }),
    ).toEqual({ sha256: sha256(large), byteSize: large.byteLength });
    expect(staged.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(large.byteLength);
    expect(sha256(Buffer.concat(staged))).toBe(sha256(large));
    expect(await captured.graphStillCurrent()).toBe(true);
    expect(f.sourceReads).toBe(before);
  } finally {
    f.close();
  }
});

test("bounded Version scope rejects stale graph and missing held chunks", async () => {
  const f = fixture();
  try {
    const { bundle, spec } = await f.basics();
    const version = await f.create(WORKER_VERSION_FORM_URL, "bounded-stale", spec, false);
    const execution = await f.claim(version.id);
    const captured = await f.reader.resolveVersionUnverified({ execution });
    expect(captured.kind).toBe("unverified");
    if (captured.kind !== "unverified") return;
    const scopes = await captured.openMaterialsUnverified();
    await f.sql.run("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ?", [
      bundle.resourceUid,
    ]);
    await expect(
      scopes.bundle?.stageVerifiedFile({
        fileIndex: 0,
        async write() {
          throw new Error("no chunk may be staged");
        },
      }),
    ).rejects.toThrow();
    f.nowMs += 60_001;
    await expect(scopes.bundle?.readPage({ fileIndex: 0, nextChunk: 0 })).rejects.toThrow();
    await expect(captured.openMaterialsUnverified()).rejects.toThrow();
  } finally {
    f.close();
  }
});

test("bounded custody accepts an empty held file sentinel and refuses invalid cursors", async () => {
  const f = fixture({ bundleFile: new Uint8Array() });
  try {
    const { bundle } = await f.basics();
    const resource = await f.engine.getResource({ principal: "org-1", uid: bundle.resourceUid });
    if (!resource) throw new Error("missing bundle");
    f.sourceAvailable = false;
    const scope = await f.bundleHost.custody.openHeldUnverified({
      targetResourceUid: bundle.resourceUid,
      principal: "org-1",
      space: "prod",
      expectedSpec: resource.spec,
      expectedObserved: resource.observed,
      stillAuthorized: async () => true,
    });
    expect(scope.fileSizes).toEqual([0]);
    expect(await scope.readPage({ fileIndex: 0, nextChunk: 0 })).toEqual({
      chunks: [new Uint8Array()],
      nextChunk: null,
    });
    expect(await scope.stageVerifiedFile({ fileIndex: 0, async write() {} })).toEqual({
      sha256: sha256(new Uint8Array()),
      byteSize: 0,
    });
    for (const request of [
      { fileIndex: -1, nextChunk: 0 },
      { fileIndex: 1, nextChunk: 0 },
      { fileIndex: 0, nextChunk: -1 },
      { fileIndex: 0, nextChunk: 1 },
      { fileIndex: 0.5, nextChunk: 0 },
    ])
      await expect(scope.readPage(request)).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    f.close();
  }
});

test("bounded custody refuses gap, extra, invalid and corrupt held pages before proof", async () => {
  const f = fixture();
  try {
    const { bundle } = await f.basics();
    const resource = await f.engine.getResource({ principal: "org-1", uid: bundle.resourceUid });
    if (!resource) throw new Error("missing bundle");
    f.sourceAvailable = false;
    const open = async (mode: "gap" | "extra" | "invalid" | "corrupt") => {
      const wrapped: Sql = {
        async query(statement, params) {
          const rows = await f.sql.query(statement, params);
          if (mode === "extra" && statement.includes("SELECT 1 FROM tf_v2_artifact_chunks chunk")) {
            return [{ present: 1 }];
          }
          if (!statement.includes("SELECT chunk.chunk_index, chunk.bytes")) return rows;
          const row = rows[0];
          if (!row) return rows;
          if (mode === "gap") return [{ ...row, chunk_index: 1 }];
          if (mode === "invalid") return [{ ...row, bytes: [256] }];
          if (mode === "corrupt") {
            const bytes = new Uint8Array(row.bytes as Uint8Array);
            bytes[0] = (bytes[0] ?? 0) ^ 1;
            return [{ ...row, bytes }];
          }
          return rows;
        },
        run: f.sql.run,
        batch: f.sql.batch,
      };
      return await createWorkerBundleCustody({
        sql: wrapped,
        source: {
          async read() {
            throw new Error("source must not be read");
          },
        },
      }).openHeldUnverified({
        targetResourceUid: bundle.resourceUid,
        principal: "org-1",
        space: "prod",
        expectedSpec: resource.spec,
        expectedObserved: resource.observed,
        stillAuthorized: async () => true,
      });
    };
    for (const mode of ["gap", "extra", "invalid"] as const) {
      const scope = await open(mode);
      await expect(scope.readPage({ fileIndex: 0, nextChunk: 0 })).rejects.toMatchObject({
        code: "unavailable",
      });
    }
    const corrupt = await open("corrupt");
    expect((await corrupt.readPage({ fileIndex: 0, nextChunk: 0 })).chunks).toHaveLength(1);
    let staged = 0;
    await expect(
      corrupt.stageVerifiedFile({
        fileIndex: 0,
        async write() {
          staged += 1;
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(staged).toBe(1);
  } finally {
    f.close();
  }
});

test("bounded page fences lease, graph and target changes while the SQL read is awaited", async () => {
  for (const drift of ["lease", "graph", "target"] as const) {
    const f = fixture();
    try {
      const { bundle, spec } = await f.basics();
      const version = await f.create(WORKER_VERSION_FORM_URL, `bounded-${drift}`, spec, false);
      const execution = await f.claim(version.id);
      let changed = false;
      const wrapped: Sql = {
        async query(statement, params) {
          const rows = await f.sql.query(statement, params);
          if (!changed && statement.includes("SELECT chunk.chunk_index, chunk.bytes")) {
            changed = true;
            await Promise.resolve();
            if (drift === "lease") f.nowMs += 60_001;
            else if (drift === "graph") {
              await f.sql.run("UPDATE tf_v2_resources SET spec_json = ? WHERE uid = ?", [
                "{}",
                version.resourceUid,
              ]);
            } else
              await f.sql.run("UPDATE tf_v2_resources SET spec_json = ? WHERE uid = ?", [
                '{"artifact":{"url":"https://changed.example.test/","sha256":"bad"}}',
                bundle.resourceUid,
              ]);
          }
          return rows;
        },
        run: f.sql.run,
        batch: f.sql.batch,
      };
      const reader = createV2WorkerPublicationState({
        sql: wrapped,
        now: () => new Date(f.nowMs),
        bundleCustody: createWorkerBundleCustody({
          sql: wrapped,
          source: {
            async read() {
              throw new Error("source must not be read");
            },
          },
        }),
        assetCustody: f.assetHost.custody,
      });
      const captured = await reader.resolveVersionUnverified({ execution });
      expect(captured.kind).toBe("unverified");
      if (captured.kind !== "unverified") continue;
      const scopes = await captured.openMaterialsUnverified();
      await expect(scopes.bundle?.readPage({ fileIndex: 0, nextChunk: 0 })).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(changed).toBe(true);
    } finally {
      f.close();
    }
  }
});

test("bounded file proof refuses a lease lost during awaited private staging", async () => {
  const f = fixture();
  try {
    const { spec } = await f.basics();
    const version = await f.create(WORKER_VERSION_FORM_URL, "bounded-stage-lease", spec, false);
    const captured = await f.reader.resolveVersionUnverified({
      execution: await f.claim(version.id),
    });
    expect(captured.kind).toBe("unverified");
    if (captured.kind !== "unverified") return;
    const scopes = await captured.openMaterialsUnverified();
    let stagingCalls = 0;
    await expect(
      scopes.bundle?.stageVerifiedFile({
        fileIndex: 0,
        async write() {
          stagingCalls += 1;
          await Promise.resolve();
          f.nowMs += 60_001;
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(stagingCalls).toBe(1);
    expect(await captured.graphStillCurrent()).toBe(false);
  } finally {
    f.close();
  }
});

test("static-only Version reads its asset without inventing a code bundle", async () => {
  const f = fixture();
  try {
    const { worker, assets } = await f.basics();
    const spec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: assets.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    };
    const version = await f.create(WORKER_VERSION_FORM_URL, "static-version", spec, false);
    f.sourceAvailable = false;
    const sourceReads = f.sourceReads;
    const ready = await f.reader.resolveVersion({ execution: await f.claim(version.id) });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") return;
    const materials = await ready.readMaterials();
    expect(materials.bundle).toBeNull();
    expect(new TextDecoder().decode(materials.assets?.files[0])).toBe(
      new TextDecoder().decode(ASSET_FILE),
    );
    expect(await ready.stillCurrent()).toBe(true);
    expect(f.sourceReads).toBe(sourceReads);
  } finally {
    f.close();
  }
});

test("Version claim expiry, reclaim, and caller identity changes fence held reads", async () => {
  const f = fixture();
  try {
    const { spec } = await f.basics();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec, false);
    const execution = await f.claim(version.id, "lease-old");
    const ready = await f.reader.resolveVersion({ execution });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") return;
    expect(
      (await f.reader.resolveVersion({ execution: { ...execution, principal: "org-2" } })).kind,
    ).toBe("unresolved");
    expect(
      (await f.reader.resolveVersion({ execution: { ...execution, space: "other" } })).kind,
    ).toBe("unresolved");
    f.nowMs += 60_001;
    expect(await ready.stillCurrent()).toBe(false);
    await expect(ready.readMaterials()).rejects.toThrow();
    expect((await f.reader.resolveVersion({ execution })).kind).toBe("unresolved");
    const reclaimed = await f.claim(version.id, "lease-new");
    expect((await f.reader.resolveVersion({ execution })).kind).toBe("unresolved");
    expect((await f.reader.resolveVersion({ execution: reclaimed })).kind).toBe("ready");
  } finally {
    f.close();
  }
});

test("same-spec Version update uses its own accepted generation and fences owner changes", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.basics();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "same-spec-version-update-materials",
      uid: version.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    const execution = await f.claim(update.id);
    const ready = await f.reader.resolveVersion({ execution });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") return;
    expect(ready.snapshot.sourceOperationId).toBe(update.id);
    expect(ready.snapshot.version.generation).toBe(2);
    expect((await ready.readMaterials()).bundle?.files[0]).toEqual(BUNDLE_FILE);
    const ownerUpdate = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-owner-update-materials",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(ownerUpdate.status).toBe("queued");
    expect(await ready.stillCurrent()).toBe(false);
    await expect(ready.readMaterials()).rejects.toThrow();
  } finally {
    f.close();
  }
});

test("Version resolver refuses incomplete accepted references and cross-owner or Space admission", async () => {
  const f = fixture({ omitBundleReference: true });
  try {
    const { worker, bundle, spec } = await f.basics();
    await expect(
      f.engine.acceptCreate({
        principal: "org-2",
        key: "foreign-version-materials",
        input: { form: WORKER_VERSION_FORM_URL, space: "prod", name: "foreign", spec },
      }),
    ).rejects.toThrow();
    await expect(
      f.engine.acceptCreate({
        principal: "org-1",
        key: "other-space-version-materials",
        input: { form: WORKER_VERSION_FORM_URL, space: "other", name: "other-space", spec },
      }),
    ).rejects.toThrow();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec, false);
    const execution = await f.claim(version.id);
    expect(await f.reader.resolveVersion({ execution })).toMatchObject({
      kind: "unresolved",
      code: "graph_unresolved",
    });
    expect(await f.reader.resolveVersionUnverified({ execution })).toMatchObject({
      kind: "unresolved",
      code: "graph_unresolved",
    });
    expect(worker.resourceUid).toBeDefined();
    expect(bundle.resourceUid).toBeDefined();
  } finally {
    f.close();
  }
});

test("damaged retained bytes and async lease loss fail closed before Version materialization", async () => {
  const f = fixture();
  try {
    const { bundle, spec } = await f.basics();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec, false);
    const execution = await f.claim(version.id);
    const ready = await f.reader.resolveVersion({ execution });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") return;
    await f.sql.run("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ?", [
      bundle.resourceUid,
    ]);
    expect(await ready.stillCurrent()).toBe(false);
    await expect(ready.readMaterials()).rejects.toThrow();
    expect((await f.reader.resolveVersion({ execution })).kind).toBe("unresolved");
  } finally {
    f.close();
  }

  const delayed = fixture();
  try {
    const { spec } = await delayed.basics();
    const version = await delayed.create(WORKER_VERSION_FORM_URL, "version", spec, false);
    const execution = await delayed.claim(version.id);
    let callbacks = 0;
    const reader = createV2WorkerPublicationState({
      sql: delayed.sql,
      now: () => new Date(delayed.nowMs),
      bundleCustody: {
        async readHeldVerified(input) {
          return delayed.bundleHost.custody.readHeldVerified({
            ...input,
            stillAuthorized: async () => {
              const authorized = await input.stillAuthorized();
              if (++callbacks === 1) delayed.nowMs += 60_001;
              return authorized;
            },
          });
        },
      },
      assetCustody: delayed.assetHost.custody,
    });
    expect(await reader.resolveVersion({ execution })).toMatchObject({
      kind: "unresolved",
      code: "stale_claim",
    });
    expect(callbacks).toBeGreaterThanOrEqual(2);
  } finally {
    delayed.close();
  }
});
