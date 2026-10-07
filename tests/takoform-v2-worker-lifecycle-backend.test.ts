import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerEndpoint,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  validateWorkerDeploymentUpdate,
  validateWorkerEndpointUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2PrivateInputCustody } from "../src/takoform-v2/private-inputs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { projectV2WorkerCodeVersion } from "../src/takoform-v2/worker-code-runtime.ts";
import {
  createInternalV2CodeWorkerVersionForm,
  createInternalV2ModuleWorkerForm,
  createInternalV2StaticWorkerVersionForm,
  createInternalV2WorkerVersionForm,
  createV2CodeConfiguredInputReader,
  type V2CodeConfiguredInputCustody,
  type V2WorkerRetirementProof,
  type V2WorkerRetirementTarget,
  WORKER_VERSION_UNIFIED_BACKEND_ID,
} from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { createV2WorkerPublication } from "../src/takoform-v2/worker-static-publication.ts";
import { createV2WorkerVersionConfiguredInputSealer } from "../src/takoform-v2/worker-version-configured-inputs.ts";
import type {
  WorkerdDeploymentPublication,
  WorkerdPublicationIdentity,
  WorkerdRuntime,
  WorkerdSite,
  WorkerdStaticSite,
} from "../src/workerd-runtime.ts";

const TARGET_KEY = "internal-static-worker-management";
const MANIFEST_URL = "https://artifacts.example.test/static/manifest.json";
const FILE_URL = "https://artifacts.example.test/static/index.html";
const FILE_BYTES = new TextEncoder().encode("<main>held asset</main>");
const BUNDLE_MANIFEST_URL = "https://artifacts.example.test/code/manifest.json";
const BUNDLE_FILE_URL = "https://artifacts.example.test/code/index.mjs";
const BUNDLE_FILE_BYTES = new TextEncoder().encode("export default { scheduled() {} };\n");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(options?: {
  gateEndpointWithPublicationReader?: boolean;
  codeWorkerVersion?: boolean;
  unifiedWorkerVersion?: boolean;
  configuredInputSealer?: ReturnType<typeof createV2WorkerVersionConfiguredInputSealer>;
  configuredInputCustody?: V2CodeConfiguredInputCustody;
  privateInputCustody?: V2PrivateInputCustody;
  inspectModule?: WorkerdRuntime["inspectModule"];
  backendQueryHook?: (
    statement: string,
    sql: Sql,
    rows: readonly Record<string, unknown>[],
  ) => Promise<void>;
}) {
  const root = mkdtempSync(join(tmpdir(), "v2-worker-lifecycle-"));
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const backendSql: Sql = options?.backendQueryHook
    ? {
        ...sql,
        async query(statement, params) {
          const result = await sql.query(statement, params);
          await options.backendQueryHook?.(statement, sql, result);
          return result;
        },
      }
    : sql;
  let nowMs = Date.now();
  let sourceAvailable = true;
  let sourceReads = 0;
  let retirementMode: "unknown" | "confirmed" | "wrong_identity" = "unknown";
  let retirementCalls = 0;
  let servingMode: "confirmed" | "unknown" | "wrong_identity" = "confirmed";
  let servingCalls = 0;
  let served: {
    kind: "serving";
    workerResourceUid: string;
    targetKey: string;
    sourceOperationId: string;
    generation: string;
    hostnames: string[];
    versions: { workerVersionUid: string; weight: number }[];
  } | null = null;
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
  const bundleManifest = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.mjs",
      files: [
        {
          path: "index.mjs",
          url: BUNDLE_FILE_URL,
          sha256: sha256(BUNDLE_FILE_BYTES),
          mediaType: "application/javascript+module",
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
      if (url === BUNDLE_MANIFEST_URL) return bundleManifest;
      if (url === BUNDLE_FILE_URL) return BUNDLE_FILE_BYTES;
      throw new Error("unrecognized artifact source");
    },
  };
  const assetHost = createStaticAssetBundleHost({ sql, source, targetKey: TARGET_KEY });
  const bundleHost = createWorkerBundleHost({ sql, source, targetKey: TARGET_KEY });
  const publicationState = createV2WorkerPublicationState({
    sql,
    now: () => new Date(nowMs),
    assetCustody: assetHost.custody,
    bundleCustody: bundleHost.custody,
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
  const serving = {
    async observeServing(input: { workerResourceUid: string; targetKey: string }) {
      servingCalls += 1;
      if (
        servingMode === "unknown" ||
        !served ||
        served.workerResourceUid !== input.workerResourceUid ||
        served.targetKey !== input.targetKey
      ) {
        return { kind: "unknown" as const };
      }
      return {
        ...served,
        sourceOperationId:
          servingMode === "wrong_identity" ? "wrong-operation" : served.sourceOperationId,
      };
    },
  };
  const workerForm = createInternalV2ModuleWorkerForm({
    sql: backendSql,
    targetKey: TARGET_KEY,
    retirement,
    serving,
  });
  const configuredInputCustody: V2CodeConfiguredInputCustody = options?.configuredInputCustody ?? {
    read: async (identity) => await readV2ConfiguredPrivateInputs(sql, identity),
  };
  const versionForm = options?.unifiedWorkerVersion
    ? createInternalV2WorkerVersionForm({
        sql: backendSql,
        targetKey: TARGET_KEY,
        publicationState,
        retirement,
        inspectModule:
          options.inspectModule ??
          (async () => ({ outcome: "valid", exportedHandlers: ["scheduled"] })),
        ...(options.configuredInputSealer
          ? { configuredInputSealer: options.configuredInputSealer, configuredInputCustody }
          : {}),
      })
    : options?.codeWorkerVersion
      ? createInternalV2CodeWorkerVersionForm({
          sql: backendSql,
          targetKey: TARGET_KEY,
          publicationState,
          retirement,
          inspectModule:
            options.inspectModule ??
            (async () => ({ outcome: "valid", exportedHandlers: ["scheduled"] })),
          ...(options.configuredInputSealer
            ? { configuredInputSealer: options.configuredInputSealer }
            : {}),
          ...(options.configuredInputSealer ? { configuredInputCustody } : {}),
        })
      : createInternalV2StaticWorkerVersionForm({
          sql: backendSql,
          targetKey: TARGET_KEY,
          publicationState,
          retirement,
        });
  const confirmedDeployment = async (execution: { spec: JsonObject; operationId: string }) => {
    const spec = parseWorkerDeploymentSpec(execution.spec);
    served = {
      kind: "serving",
      workerResourceUid: spec.worker.resourceUid,
      targetKey: TARGET_KEY,
      sourceOperationId: execution.operationId,
      generation: `takoserver-v2-operation:${execution.operationId}`,
      hostnames: [],
      versions: spec.versions.map((version) => ({
        workerVersionUid: version.workerVersion.resourceUid,
        weight: version.weight,
      })),
    };
    return {
      kind: "complete" as const,
      observed: {
        ready: true,
        active: true,
        selectedVersions: spec.versions.map((version) => ({
          resourceUid: version.workerVersion.resourceUid,
          weight: version.weight,
        })),
      },
      output: {},
    };
  };
  const confirmedEndpoint = async (execution: V2Execution) => {
    parseWorkerEndpointSpec(execution.spec);
    if (options?.gateEndpointWithPublicationReader) {
      const resolution = await publicationState.resolve({ execution });
      if (resolution.kind !== "ready" || !(await resolution.stillCurrent())) {
        return { kind: "unknown" as const };
      }
    }
    if (!served) return { kind: "unknown" as const };
    served = {
      ...served,
      sourceOperationId: execution.operationId,
      generation: `takoserver-v2-operation:${execution.operationId}`,
      hostnames: execution.action === "delete" ? [] : ["worker.example.test"],
    };
    return {
      kind: "complete" as const,
      observed:
        execution.action === "delete" ? {} : { tlsReady: true, activeDeploymentRouteReady: true },
      output:
        execution.action === "delete"
          ? {}
          : { hostname: "worker.example.test", url: "https://worker.example.test/" },
    };
  };
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(nowMs),
    replayWindowSeconds: 3_600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    ...(options?.privateInputCustody ? { privateInputCustody: options.privateInputCustody } : {}),
    forms: {
      [MODULE_WORKER_FORM_URL]: workerForm,
      [WORKER_VERSION_FORM_URL]: versionForm,
      [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
      [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
      // A test-only confirmed Deployment observation, not native publication proof.
      [WORKER_DEPLOYMENT_FORM_URL]: {
        validateCreate(spec) {
          parseWorkerDeploymentSpec(spec);
        },
        validateUpdate(previous, spec) {
          validateWorkerDeploymentUpdate(previous, spec);
        },
        references(spec) {
          return referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec));
        },
        rejectDeleteWhileReferenced: true,
        backend: {
          id: "fixture-confirmed-deployment",
          targetKey: TARGET_KEY,
          execute: confirmedDeployment,
          reconcile: confirmedDeployment,
        },
      },
      // Endpoint fixture only supplies a synthetic confirmed attachment.
      [WORKER_ENDPOINT_FORM_URL]: {
        initialOutput() {
          return { hostname: "worker.example.test", url: "https://worker.example.test/" };
        },
        validateCreate(spec) {
          parseWorkerEndpointSpec(spec);
        },
        validateUpdate(previous, spec) {
          validateWorkerEndpointUpdate(previous, spec);
        },
        references(spec) {
          return referencesForWorkerEndpoint(parseWorkerEndpointSpec(spec));
        },
        rejectDeleteWhileReferenced: true,
        backend: {
          id: "fixture-confirmed-endpoint",
          targetKey: TARGET_KEY,
          execute: confirmedEndpoint,
          reconcile: confirmedEndpoint,
        },
      },
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
  async function createWorkerAndBundle(
    handlers: readonly string[] = ["scheduled"],
    withAssets = false,
    suffix = "",
  ) {
    const worker = await create(MODULE_WORKER_FORM_URL, `code-worker${suffix}`, {});
    const bundle = await create(WORKER_BUNDLE_FORM_URL, `code-bundle${suffix}`, {
      artifact: { url: BUNDLE_MANIFEST_URL, sha256: sha256(bundleManifest) },
    });
    const assets = withAssets
      ? await create(STATIC_ASSET_BUNDLE_FORM_URL, `code-assets${suffix}`, {
          artifact: { url: MANIFEST_URL, sha256: sha256(manifest) },
        })
      : undefined;
    const spec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: [...handlers],
      vars: { MODE: "scheduled-eligible" },
      ...(assets
        ? {
            assets: {
              bundle: { resourceUid: assets.resourceUid },
              runWorkerFirst: false,
              notFoundHandling: "none",
            },
          }
        : {}),
    };
    return { worker, bundle, assets, spec };
  }
  return {
    db,
    sql,
    engine,
    workerForm,
    versionForm,
    publicationState,
    configuredInputCustody,
    retirement,
    serving,
    create,
    createWorkerAndAssets,
    createWorkerAndBundle,
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
    get servingCalls() {
      return servingCalls;
    },
    set servingMode(value: typeof servingMode) {
      servingMode = value;
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

test("one internal WorkerVersion Form routes static, code, and code-with-assets through a pinned backend", async () => {
  const f = fixture({ unifiedWorkerVersion: true });
  try {
    const staticVersionSpec = (await f.createWorkerAndAssets()).spec;
    const staticVersion = await f.create(
      WORKER_VERSION_FORM_URL,
      "unified-static",
      staticVersionSpec,
    );
    expect(
      await f.engine.getResource({ principal: "org-1", uid: staticVersion.resourceUid }),
    ).toMatchObject({ observed: { ready: true, resolvedBindings: true } });

    const codeVersionSpec = (await f.createWorkerAndBundle()).spec;
    const codeVersion = await f.create(WORKER_VERSION_FORM_URL, "unified-code", codeVersionSpec);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: codeVersion.resourceUid }),
    ).toMatchObject({ observed: { ready: true, resolvedBindings: true, bundleVerified: true } });

    const mixedVersionSpec = (await f.createWorkerAndBundle(["scheduled"], true, "-mixed")).spec;
    const mixedVersion = await f.create(WORKER_VERSION_FORM_URL, "unified-mixed", mixedVersionSpec);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: mixedVersion.resourceUid }),
    ).toMatchObject({ observed: { ready: true, resolvedBindings: true, bundleVerified: true } });

    const rows = await f.sql.query(
      "SELECT backend_id FROM tf_v2_operations WHERE resource_uid IN (?, ?, ?) ORDER BY resource_uid",
      [staticVersion.resourceUid, codeVersion.resourceUid, mixedVersion.resourceUid],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.backend_id === WORKER_VERSION_UNIFIED_BACKEND_ID)).toBe(true);
    await expect(
      f.engine.acceptCreate({
        principal: "org-1",
        key: "unsupported-unified-handler-key",
        input: {
          form: WORKER_VERSION_FORM_URL,
          space: "prod",
          name: "unsupported-unified-handler",
          spec: { ...codeVersionSpec, handlers: ["queue"] },
        },
      }),
    ).rejects.toMatchObject({ code: "capability_required", status: 422 });
    expect(
      await f.sql.query("SELECT id FROM tf_v2_operations WHERE replay_key = ?", [
        "unsupported-unified-handler-key",
      ]),
    ).toHaveLength(0);

    const staticUpdate = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-unified-static-key",
      uid: staticVersion.resourceUid,
      expectedGeneration: 1,
      spec: staticVersionSpec,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: staticUpdate.id, status: "succeeded" });
    const codeUpdate = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-unified-code-key",
      uid: codeVersion.resourceUid,
      expectedGeneration: 1,
      spec: codeVersionSpec,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: codeUpdate.id, status: "succeeded" });

    f.retirementMode = "confirmed";
    const staticDelete = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-unified-static-key",
      uid: staticVersion.resourceUid,
      expectedGeneration: 2,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: staticDelete.id, status: "succeeded" });
    const mixedDelete = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-unified-mixed-key",
      uid: mixedVersion.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: mixedDelete.id, status: "succeeded" });
  } finally {
    f.close();
  }
});

test("ModuleWorker same-spec PUT keeps the confirmed active Deployment observation", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    const versionOnly = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-version-only-update",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: versionOnly.id, status: "succeeded" });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({ observed: { activeDeploymentUid: null, ready: false } });

    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const active = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-active-deployment-update",
      uid: worker.resourceUid,
      expectedGeneration: 2,
      spec: {},
    });
    f.servingMode = "unknown";
    expect(await f.engine.runNext()).toMatchObject({ id: active.id, status: "reconciling" });
    f.servingMode = "wrong_identity";
    let pending = await f.sql.query(
      "SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id = ?",
      [active.id],
    );
    f.nowMs = Number(pending[0]?.next_attempt_at_ms) + 1;
    expect(await f.engine.runNext()).toMatchObject({ id: active.id, status: "reconciling" });
    f.servingMode = "confirmed";
    pending = await f.sql.query("SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id = ?", [
      active.id,
    ]);
    f.nowMs = Number(pending[0]?.next_attempt_at_ms) + 1;
    expect(await f.engine.runNext()).toMatchObject({ id: active.id, status: "succeeded" });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observedGeneration: 3,
      observed: { activeDeploymentUid: deployment.resourceUid, ready: true },
    });
    expect(f.servingCalls).toBe(3);
  } finally {
    f.close();
  }
});

test("ModuleWorker observation follows settled Endpoint publication and removal markers", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
      worker: { resourceUid: worker.resourceUid },
    });
    const afterAttach = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-after-endpoint-attach",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: afterAttach.id, status: "succeeded" });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observed: { activeDeploymentUid: deployment.resourceUid, ready: true },
    });

    const removeEndpoint = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-endpoint-fixture",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: removeEndpoint.id, status: "succeeded" });
    const afterRemoval = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-after-endpoint-removal",
      uid: worker.resourceUid,
      expectedGeneration: 2,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: afterRemoval.id, status: "succeeded" });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observedGeneration: 3,
      observed: { activeDeploymentUid: deployment.resourceUid, ready: true },
    });
  } finally {
    f.close();
  }
});

test("ModuleWorker same-spec PUT follows Endpoint DELETE despite a rolled-back Host clock", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const deploymentOp = await f.sql.query("SELECT created_at FROM tf_v2_operations WHERE id = ?", [
      deployment.id,
    ]);
    await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
      worker: { resourceUid: worker.resourceUid },
    });
    const endpoint = await f.sql.query(
      "SELECT uid FROM tf_v2_resources WHERE form_url = ? AND name = 'endpoint'",
      [WORKER_ENDPOINT_FORM_URL],
    );
    f.nowMs = Date.parse(String(deploymentOp[0]?.created_at)) - 1_000;
    const deleted = await f.engine.acceptDelete({
      principal: "org-1",
      key: "rollback-endpoint-delete",
      uid: String(endpoint[0]?.uid),
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
    const deletedOp = await f.sql.query("SELECT created_at FROM tf_v2_operations WHERE id = ?", [
      deleted.id,
    ]);
    expect(String(deletedOp[0]?.created_at) < String(deploymentOp[0]?.created_at)).toBe(true);
    const workerUpdate = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-after-rollback-delete",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: workerUpdate.id, status: "succeeded" });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observed: { activeDeploymentUid: deployment.resourceUid, ready: true },
    });
  } finally {
    f.close();
  }
});

test("pending Endpoint publishes before a same-spec ModuleWorker PUT retries", async () => {
  const f = fixture({ gateEndpointWithPublicationReader: true });
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const endpoint = await f.engine.acceptCreate({
      principal: "org-1",
      key: "pending-endpoint-fixture",
      input: {
        form: WORKER_ENDPOINT_FORM_URL,
        space: "prod",
        name: "endpoint",
        spec: { worker: { resourceUid: worker.resourceUid } },
      },
    });
    const workerInput = {
      principal: "org-1",
      key: "worker-with-pending-endpoint",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    };
    await expect(f.engine.acceptUpdate(workerInput)).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({ generation: 1, lastOperation: worker.id });
    const endpointOutcome = await f.engine.runNext();
    expect(endpointOutcome).toMatchObject({ id: endpoint.id, status: "succeeded" });
    const workerUpdate = await f.engine.acceptUpdate(workerInput);
    expect(await f.engine.runNext()).toMatchObject({ id: workerUpdate.id, status: "succeeded" });
    expect(await f.engine.acceptUpdate(workerInput)).toMatchObject({ id: workerUpdate.id });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observedGeneration: 2,
      observed: { ready: true },
    });
  } finally {
    f.close();
  }
});

test("a pending ModuleWorker PUT blocks later Endpoint acceptance until Worker settles", async () => {
  const f = fixture({ gateEndpointWithPublicationReader: true });
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const workerUpdate = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-first-pending-update",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    const endpointInput = {
      principal: "org-1",
      key: "endpoint-after-worker-pending",
      input: {
        form: WORKER_ENDPOINT_FORM_URL,
        space: "prod",
        name: "endpoint",
        spec: { worker: { resourceUid: worker.resourceUid } },
      },
    };
    await expect(f.engine.acceptCreate(endpointInput)).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: workerUpdate.id, status: "succeeded" });
    const endpoint = await f.engine.acceptCreate(endpointInput);
    expect(await f.engine.runNext()).toMatchObject({ id: endpoint.id, status: "succeeded" });
  } finally {
    f.close();
  }
});

test("pending Deployment settles before a referenced ModuleWorker PUT is accepted", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    const deployment = await f.engine.acceptCreate({
      principal: "org-1",
      key: "pending-deployment-before-worker",
      input: {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "prod",
        name: "deployment",
        spec: {
          worker: { resourceUid: worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
        },
      },
    });
    const workerInput = {
      principal: "org-1",
      key: "worker-after-pending-deployment",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    };
    await expect(f.engine.acceptUpdate(workerInput)).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: deployment.id, status: "succeeded" });
    const update = await f.engine.acceptUpdate(workerInput);
    expect(await f.engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observedGeneration: 2,
      observed: { activeDeploymentUid: deployment.resourceUid, ready: true },
    });
  } finally {
    f.close();
  }
});

test("other Forms keep their existing update admission while a referrer is pending", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    await f.engine.acceptCreate({
      principal: "org-1",
      key: "pending-deployment-for-version-update",
      input: {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "prod",
        name: "deployment",
        spec: {
          worker: { resourceUid: worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
        },
      },
    });
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "version-update-while-deployment-pending",
      uid: version.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    expect(update).toMatchObject({ action: "update", generation: 2, status: "queued" });
  } finally {
    f.close();
  }
});

test("ModuleWorker PUT will not mint readiness from a damaged selected Version edge", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    await f.sql.run(
      "DELETE FROM tf_v2_resource_references WHERE target_uid = ? AND referrer_uid = ?",
      [version.resourceUid, deployment.resourceUid],
    );
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-with-damaged-deployment-edge",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: update.id, status: "reconciling" });
    expect(f.servingCalls).toBe(0);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observedGeneration: 1,
      observed: { activeDeploymentUid: null, ready: false },
    });
  } finally {
    f.close();
  }
});

test("ModuleWorker observation does not materialize historical publisher Operations", async () => {
  let sourceQueries = 0;
  const f = fixture({
    backendQueryHook: async (statement, _sql, rows) => {
      if (!statement.includes("FROM tf_v2_operations op JOIN tf_v2_resources r")) return;
      sourceQueries += 1;
      if (rows.length > 4) throw new Error("unbounded publisher history read");
    },
  });
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    const deploymentSpec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    };
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", deploymentSpec);
    for (let generation = 1; generation <= 128; generation += 1) {
      f.nowMs += 1;
      const update = await f.engine.acceptUpdate({
        principal: "org-1",
        key: `deployment-history-${generation}`,
        uid: deployment.resourceUid,
        expectedGeneration: generation,
        spec: deploymentSpec,
      });
      expect(await f.engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    }
    const workerUpdate = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-after-deployment-history",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: workerUpdate.id, status: "succeeded" });
    expect(sourceQueries).toBeGreaterThan(0);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observed: { activeDeploymentUid: deployment.resourceUid, ready: true },
    });
  } finally {
    f.close();
  }
});

test("ModuleWorker PUT refuses a same-millisecond Endpoint source change during graph reread", async () => {
  let endpointUid: string | null = null;
  let endpointReads = 0;
  const f = fixture({
    backendQueryHook: async (statement, sql) => {
      if (
        !endpointUid ||
        !statement.includes("FROM tf_v2_resources r") ||
        !statement.includes("WHERE r.form_url = ? AND r.deleted_at IS NULL")
      ) {
        return;
      }
      endpointReads += 1;
      if (endpointReads !== 2) return;
      const current = await sql.query("SELECT last_operation FROM tf_v2_resources WHERE uid = ?", [
        endpointUid,
      ]);
      const nextOperationId = randomUUID();
      await sql.run(
        `INSERT INTO tf_v2_operations
         (id, resource_uid, principal, replay_key, request_fingerprint, action,
          generation, status, effect, created_at, updated_at, retain_until,
          backend_id, target_key, backend_key, accepted_spec_json)
         SELECT ?, resource_uid, principal, ?, request_fingerprint, 'update',
           generation + 1, 'succeeded', 'complete', created_at, updated_at, retain_until,
           backend_id, target_key, ?, accepted_spec_json
         FROM tf_v2_operations WHERE id = ?`,
        [
          nextOperationId,
          `synthetic-endpoint-source-${nextOperationId}`,
          nextOperationId,
          String(current[0]?.last_operation),
        ],
      );
      await sql.run(
        `UPDATE tf_v2_resources SET generation = generation + 1,
           observed_generation = observed_generation + 1, last_operation = ? WHERE uid = ?`,
        [nextOperationId, endpointUid],
      );
    },
  });
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
      worker: { resourceUid: worker.resourceUid },
    });
    endpointUid = endpoint.resourceUid;
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "worker-endpoint-source-race",
      uid: worker.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: update.id, status: "reconciling" });
    expect(endpointReads).toBe(2);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      observedGeneration: 1,
      observed: { activeDeploymentUid: null, ready: false },
    });
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

test("a retained edge from a tombstoned referrer does not block Worker retirement", async () => {
  const f = fixture();
  try {
    const { worker, spec } = await f.createWorkerAndAssets();
    const version = await f.create(WORKER_VERSION_FORM_URL, "version", spec);
    await expect(
      f.engine.acceptDelete({
        principal: "org-1",
        key: "live-ref-worker-delete-key",
        uid: worker.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });

    // A previous source lineage could retain this legal edge when its
    // referrer became a tombstone. The current core explicitly ignores it.
    await f.sql.run(
      "UPDATE tf_v2_resources SET deleted_at = '2026-10-07T00:00:00Z', active_name = NULL WHERE uid = ?",
      [version.resourceUid],
    );
    expect(
      await f.sql.query(
        "SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?",
        [version.resourceUid, worker.resourceUid],
      ),
    ).toHaveLength(1);

    const deletion = await f.engine.acceptDelete({
      principal: "org-1",
      key: "tombstone-ref-worker-delete-key",
      uid: worker.resourceUid,
      expectedGeneration: 1,
    });
    f.retirementMode = "confirmed";
    const outcome = await f.engine.runNext();
    expect(f.retirementCalls).toBe(1);
    expect(outcome).toMatchObject({ id: deletion.id, status: "succeeded" });
    await expect(
      f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).rejects.toMatchObject({ code: "gone", status: 410 });
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
        serving: f.serving,
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

test("DELETE refuses a claim whose lease expires during its final reference read", async () => {
  let referenceReads = 0;
  let deletionId: string | null = null;
  const f = fixture({
    backendQueryHook: async (statement, sql) => {
      if (!statement.includes("SELECT target_uid FROM tf_v2_resource_references")) return;
      referenceReads += 1;
      if (referenceReads === 2 && deletionId) {
        await sql.run("UPDATE tf_v2_operations SET lease_until_ms = 1 WHERE id = ?", [deletionId]);
      }
    },
  });
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    referenceReads = 0;
    const deletion = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-worker-expired-lease",
      uid: worker.resourceUid,
      expectedGeneration: 1,
    });
    deletionId = deletion.id;
    f.retirementMode = "confirmed";
    expect(await f.engine.runNext()).toMatchObject({ id: deletion.id, status: "reconciling" });
    expect(f.retirementCalls).toBe(1);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: worker.resourceUid }),
    ).toMatchObject({
      phase: "deleting",
      observedGeneration: 1,
    });
  } finally {
    f.close();
  }
});

test("scheduled code WorkerVersion settles from held bundle eligibility without publishing", async () => {
  const inspected: { declaredHandlers: readonly string[]; moduleBytes: Uint8Array }[] = [];
  const f = fixture({
    codeWorkerVersion: true,
    inspectModule: async (input) => {
      inspected.push({
        declaredHandlers: input.declaredHandlers,
        moduleBytes: new Uint8Array(input.modules[0]?.bytes ?? []),
      });
      return { outcome: "valid", exportedHandlers: ["scheduled"] };
    },
  });
  try {
    const { spec } = await f.createWorkerAndBundle(["scheduled"], true);
    f.sourceAvailable = false;
    const readsBeforeVersion = f.sourceReads;
    const accepted = await f.create(WORKER_VERSION_FORM_URL, "scheduled-version", spec);
    expect(f.sourceReads).toBe(readsBeforeVersion);
    expect(inspected).toEqual([
      {
        declaredHandlers: ["scheduled"],
        moduleBytes: BUNDLE_FILE_BYTES,
      },
    ]);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: accepted.resourceUid }),
    ).toMatchObject({
      form: WORKER_VERSION_FORM_URL,
      observed: { ready: true, resolvedBindings: true, bundleVerified: true },
      output: {},
    });
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE form_url = ?", [
        WORKER_DEPLOYMENT_FORM_URL,
      ]),
    ).toHaveLength(0);
    expect(
      await f.engine.acceptCreate({
        principal: "org-1",
        key: "create-scheduled-version-key",
        input: { form: WORKER_VERSION_FORM_URL, space: "prod", name: "scheduled-version", spec },
      }),
    ).toMatchObject({ id: accepted.id, status: "succeeded" });

    f.retirementMode = "confirmed";
    const deletion = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-scheduled-version-key",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: deletion.id,
      status: "succeeded",
      effect: "complete",
    });
  } finally {
    f.close();
  }
});

test("configured code Version seals exact UID inputs, retains them on omitted PUT, and refuses drift before acceptance", async () => {
  const [configuredKey, transferKey, comparisonKey] = await Promise.all([
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  ]);
  const sealer = createV2WorkerVersionConfiguredInputSealer({
    current: { keyId: "test-configured", key: configuredKey },
    keyForDecryption(id) {
      return id === "test-configured" ? configuredKey : undefined;
    },
  });
  const f = fixture({
    unifiedWorkerVersion: true,
    configuredInputSealer: sealer,
    privateInputCustody: {
      transfer: { current: { id: "test-transfer", key: transferKey } },
      comparison: { current: { id: "test-comparison", key: comparisonKey } },
      transferTtlSeconds: 300,
    },
  });
  try {
    const { worker, spec: baseSpec } = await f.createWorkerAndBundle();
    const spec: JsonObject = { ...baseSpec, requiredSensitiveVars: ["TOKEN"] };
    const parsedSpec = parseWorkerVersionSpec(spec);
    if (!parsedSpec.bundle) throw new Error("configured code fixture has no Bundle");
    expect(() => f.versionForm.privateInputs?.validateCreate(baseSpec, null as never)).toThrow();
    const emptyInputsVersion = await f.engine.acceptCreate({
      principal: "org-1",
      key: "create-no-secret-version-empty-inputs",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "prod",
        name: "no-secret-version",
        spec: baseSpec,
        privateInputs: {},
      },
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: emptyInputsVersion.id,
      status: "succeeded",
    });
    const emptyInputsUpdate = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-no-secret-version-empty-inputs",
      uid: emptyInputsVersion.resourceUid,
      expectedGeneration: 1,
      spec: baseSpec,
      privateInputs: {},
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: emptyInputsUpdate.id,
      status: "succeeded",
    });
    const staticSpec = (await f.createWorkerAndAssets()).spec;
    const emptyStatic = await f.engine.acceptCreate({
      principal: "org-1",
      key: "create-static-version-empty-inputs",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "prod",
        name: "empty-static-version",
        spec: staticSpec,
        privateInputs: {},
      },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: emptyStatic.id, status: "succeeded" });
    const emptyStaticUpdate = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-static-version-empty-inputs",
      uid: emptyStatic.resourceUid,
      expectedGeneration: 1,
      spec: staticSpec,
      privateInputs: {},
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: emptyStaticUpdate.id,
      status: "succeeded",
    });
    await expect(
      f.engine.acceptUpdate({
        principal: "org-1",
        key: "update-static-version-nonempty-inputs",
        uid: emptyStatic.resourceUid,
        expectedGeneration: 2,
        spec: staticSpec,
        privateInputs: { TOKEN: "not-declared" },
      }),
    ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
    f.sourceAvailable = false;
    const accepted = await f.engine.acceptCreate({
      principal: "org-1",
      key: "create-configured-version-key",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "prod",
        name: "configured-version",
        spec,
        privateInputs: { TOKEN: "test-only-original-value" },
      },
    });
    const held = await readV2ConfiguredPrivateInputs(f.sql, {
      principal: "org-1",
      space: "prod",
      name: "configured-version",
      form: WORKER_VERSION_FORM_URL,
      resourceUid: accepted.resourceUid,
    });
    expect(held?.ciphertext).toBeString();
    expect(JSON.stringify(held)).not.toContain("test-only-original-value");
    expect(await f.engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    const publicResource = await f.engine.getResource({
      principal: "org-1",
      uid: accepted.resourceUid,
    });
    expect(publicResource).toMatchObject({
      observed: { ready: true, resolvedBindings: true, bundleVerified: true },
    });
    expect(JSON.stringify(publicResource)).not.toContain("test-only-original-value");
    const reader = createV2CodeConfiguredInputReader({
      sql: f.sql,
      sealer,
      custody: f.configuredInputCustody,
    });
    expect(
      await reader.read({
        resourceUid: accepted.resourceUid,
        principal: "org-1",
        space: "prod",
        targetKey: TARGET_KEY,
        spec: parsedSpec,
        stillCurrent: async () => true,
      }),
    ).toEqual({ TOKEN: "test-only-original-value" });
    await expect(
      f.engine.acceptUpdate({
        principal: "org-1",
        key: "changed-configured-value-key",
        uid: accepted.resourceUid,
        expectedGeneration: 1,
        spec,
        privateInputs: { TOKEN: "changed-value" },
      }),
    ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
    expect(
      await f.sql.query("SELECT id FROM tf_v2_operations WHERE replay_key = ?", [
        "changed-configured-value-key",
      ]),
    ).toHaveLength(0);
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "omitted-configured-value-key",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, {
        principal: "org-1",
        space: "prod",
        name: "configured-version",
        form: WORKER_VERSION_FORM_URL,
        resourceUid: accepted.resourceUid,
      }),
    ).toEqual(held);
    const deployment = await f.engine.acceptCreate({
      principal: "org-1",
      key: "configured-deployment-key",
      input: {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "prod",
        name: "configured-deployment",
        spec: {
          worker: { resourceUid: worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: accepted.resourceUid }, weight: 10_000 }],
        },
      },
    });
    const store = createV2Store(f.sql);
    const op = await store.operation(deployment.id);
    const resource = op ? await store.resource(op.resource_uid) : null;
    if (!op || !resource) throw new Error("accepted Deployment is missing");
    const leaseToken = `fixture-lease-${deployment.id}`;
    const claimNow = Date.now();
    expect(await store.claim(op.id, leaseToken, claimNow, claimNow + 60_000)).toBe(true);
    expect(await store.markDispatch(op.id, leaseToken, new Date(claimNow).toISOString())).toBe(
      true,
    );
    const execution: V2Execution = {
      operationId: op.id,
      leaseToken,
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
    let candidate: WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null = null;
    let identity: WorkerdPublicationIdentity | null = null;
    const runtime: Parameters<typeof createV2WorkerPublication>[0]["runtime"] = {
      inspectModule: async () => ({ outcome: "valid", exportedHandlers: ["scheduled"] }),
      async publishFenced(_name, resolve, stillCurrent) {
        expect(await stillCurrent()).toBe(true);
        candidate = await resolve(null);
        expect(await stillCurrent()).toBe(true);
        identity = candidate && {
          generation: candidate.generation,
          workerResourceUid: candidate.workerResourceUid,
          hostnames: [...candidate.hostnames],
          versions: candidate.versions.map((version) => ({
            versionId: version.versionId,
            workerVersionUid: version.workerVersionUid,
            weight: version.weight,
          })),
        };
        // A native write reached the exact graph but its acknowledgement was lost.
        throw new Error("fixture lost native acknowledgement");
      },
      async observeExactPublication(_name, expected) {
        return JSON.stringify(identity) === JSON.stringify(expected) ? "matches" : "different";
      },
    };
    const publication = createV2WorkerPublication({
      targetKey: TARGET_KEY,
      publicationState: f.publicationState,
      runtime,
      configuredInputs: reader,
      scheduledEventToken: "a".repeat(64),
    });
    const resolved = await f.publicationState.resolve({ execution });
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") throw new Error("fixture graph is not ready");
    if (!resolved.snapshot.deployment) throw new Error("fixture Deployment is missing");
    expect(
      (await resolved.readVersionMaterials(accepted.resourceUid)).bundle?.manifest,
    ).toBeTruthy();
    expect(
      await reader.read({
        resourceUid: accepted.resourceUid,
        principal: resolved.snapshot.worker.principal,
        space: resolved.snapshot.worker.space,
        targetKey: TARGET_KEY,
        spec: resolved.snapshot.deployment.versions[0]?.spec as never,
        stillCurrent: resolved.stillCurrent,
      }),
    ).toEqual({ TOKEN: "test-only-original-value" });
    const materials = await resolved.readVersionMaterials(accepted.resourceUid);
    expect(
      await projectV2WorkerCodeVersion({
        identity: {
          versionId: "diagnostic-version",
          workerVersionUid: accepted.resourceUid,
          workerResourceUid: worker.resourceUid,
          bundleResourceUid: parsedSpec.bundle.resourceUid,
          weight: 10_000,
          generation: `takoserver-v2-operation:${deployment.id}`,
          directory: "diagnostic-directory",
          hostnames: [],
        },
        spec,
        bundle: materials.bundle,
        assets: materials.assets,
        inspectModule: async () => ({ outcome: "valid", exportedHandlers: ["scheduled"] }),
        configuredPrivateInputs: { TOKEN: "test-only-original-value" },
        eventDelivery: { token: "a".repeat(64) },
      }),
    ).toBeTruthy();
    const publicationResult = await publication.publish(execution);
    expect(publicationResult).toMatchObject({ kind: "confirmed" });
    expect(JSON.stringify(publicationResult)).not.toContain("test-only-original-value");
    const published = candidate as WorkerdDeploymentPublication<
      WorkerdSite | WorkerdStaticSite
    > | null;
    if (!published) throw new Error("runtime publication was not dispatched");
    expect(published.versions[0]?.site.vars).toContainEqual({
      name: "TOKEN",
      value: "test-only-original-value",
      kind: "text",
    });
    expect(
      [...(published.versions[0]?.hostModules?.values() ?? [])].some((bytes) =>
        new TextDecoder().decode(bytes).includes('"secret_text"'),
      ),
    ).toBe(true);
    expect(
      (
        await f.engine.acceptUpdate({
          principal: "org-1",
          key: "omitted-configured-value-key",
          uid: accepted.resourceUid,
          expectedGeneration: 1,
          spec,
        })
      ).id,
    ).toBe(update.id);
    const sameValues = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "identical-configured-value-key",
      uid: accepted.resourceUid,
      expectedGeneration: 2,
      spec,
      privateInputs: { TOKEN: "test-only-original-value" },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: sameValues.id, status: "succeeded" });
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, {
        principal: "org-1",
        space: "prod",
        name: "configured-version",
        form: WORKER_VERSION_FORM_URL,
        resourceUid: accepted.resourceUid,
      }),
    ).toEqual(held);
    expect(
      await reader.read({
        resourceUid: accepted.resourceUid,
        principal: "org-other",
        space: "prod",
        targetKey: TARGET_KEY,
        spec: parsedSpec,
        stillCurrent: async () => true,
      }),
    ).toBeNull();
    expect(
      await reader.read({
        resourceUid: accepted.resourceUid,
        principal: "org-1",
        space: "prod",
        targetKey: "another-target",
        spec: parsedSpec,
        stillCurrent: async () => true,
      }),
    ).toBeNull();
    const otherKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const otherReader = createV2CodeConfiguredInputReader({
      sql: f.sql,
      sealer: createV2WorkerVersionConfiguredInputSealer({
        current: { keyId: "other-configured", key: otherKey },
        keyForDecryption(id) {
          return id === "other-configured" ? otherKey : undefined;
        },
      }),
      custody: f.configuredInputCustody,
    });
    expect(
      await otherReader.read({
        resourceUid: accepted.resourceUid,
        principal: "org-1",
        space: "prod",
        targetKey: TARGET_KEY,
        spec: parsedSpec,
        stillCurrent: async () => true,
      }),
    ).toBeNull();
    let fenceReads = 0;
    expect(
      await reader.read({
        resourceUid: accepted.resourceUid,
        principal: "org-1",
        space: "prod",
        targetKey: TARGET_KEY,
        spec: parsedSpec,
        stillCurrent: async () => ++fenceReads === 1,
      }),
    ).toBeNull();
    expect(fenceReads).toBe(2);
  } finally {
    f.close();
  }
});

test("code Version without configured custody never accepts a secret-required Resource", async () => {
  const f = fixture({ unifiedWorkerVersion: true });
  try {
    const { spec: baseSpec } = await f.createWorkerAndBundle();
    const spec: JsonObject = { ...baseSpec, requiredSensitiveVars: ["TOKEN"] };
    await expect(
      f.engine.acceptCreate({
        principal: "org-1",
        key: "no-configured-custody-key",
        input: {
          form: WORKER_VERSION_FORM_URL,
          space: "prod",
          name: "no-configured-custody",
          spec,
        },
      }),
    ).rejects.toMatchObject({ code: "capability_required", status: 422 });
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE name = ?", [
        "no-configured-custody",
      ]),
    ).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("unsupported code handlers refuse before acceptance and never inspect", async () => {
  let inspections = 0;
  const f = fixture({
    codeWorkerVersion: true,
    inspectModule: async () => {
      inspections += 1;
      return { outcome: "valid", exportedHandlers: ["queue"] };
    },
  });
  try {
    const { spec } = await f.createWorkerAndBundle(["queue"]);
    await expect(
      f.engine.acceptCreate({
        principal: "org-1",
        key: "unsupported-queue-code-version",
        input: { form: WORKER_VERSION_FORM_URL, space: "prod", name: "queue-version", spec },
      }),
    ).rejects.toMatchObject({ code: "capability_required", status: 422 });
    expect(inspections).toBe(0);
    expect(
      await f.sql.query("SELECT id FROM tf_v2_operations WHERE replay_key = ?", [
        "unsupported-queue-code-version",
      ]),
    ).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("a scheduled declaration without an exported scheduled handler stays unresolved", async () => {
  const f = fixture({
    codeWorkerVersion: true,
    inspectModule: async () => ({ outcome: "valid", exportedHandlers: ["fetch"] }),
  });
  try {
    const { spec } = await f.createWorkerAndBundle();
    const accepted = await f.engine.acceptCreate({
      principal: "org-1",
      key: "scheduled-handler-mismatch",
      input: { form: WORKER_VERSION_FORM_URL, space: "prod", name: "mismatch-version", spec },
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: accepted.resourceUid }),
    ).toMatchObject({ observedGeneration: 0, observed: {} });
  } finally {
    f.close();
  }
});

test("damaged held WorkerBundle custody cannot make code Version eligible", async () => {
  let inspections = 0;
  const f = fixture({
    codeWorkerVersion: true,
    inspectModule: async () => {
      inspections += 1;
      return { outcome: "valid", exportedHandlers: ["scheduled"] };
    },
  });
  try {
    const { bundle, spec } = await f.createWorkerAndBundle();
    await f.sql.run("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ?", [
      bundle.resourceUid,
    ]);
    const accepted = await f.engine.acceptCreate({
      principal: "org-1",
      key: "damaged-code-version-custody",
      input: { form: WORKER_VERSION_FORM_URL, space: "prod", name: "damaged-version", spec },
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(inspections).toBe(0);
    expect(
      await f.engine.getResource({ principal: "org-1", uid: accepted.resourceUid }),
    ).toMatchObject({ observedGeneration: 0, observed: {} });
  } finally {
    f.close();
  }
});

test("scheduled code inspector cannot settle after its accepted SQL claim expires", async () => {
  let enterInspection!: () => void;
  let releaseInspection!: () => void;
  const inspectionEntered = new Promise<void>((resolve) => {
    enterInspection = resolve;
  });
  const inspectionBlocked = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  const f = fixture({
    codeWorkerVersion: true,
    inspectModule: async () => {
      enterInspection();
      await inspectionBlocked;
      return { outcome: "valid", exportedHandlers: ["scheduled"] };
    },
  });
  try {
    const { spec } = await f.createWorkerAndBundle();
    const accepted = await f.engine.acceptCreate({
      principal: "org-1",
      key: "scheduled-version-expired-inspection",
      input: { form: WORKER_VERSION_FORM_URL, space: "prod", name: "expired-version", spec },
    });
    const processing = f.engine.runNext();
    await inspectionEntered;
    await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = 1 WHERE id = ?", [accepted.id]);
    releaseInspection();
    expect(await processing).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(
      await f.engine.getResource({ principal: "org-1", uid: accepted.resourceUid }),
    ).toMatchObject({ observedGeneration: 0, observed: {} });
  } finally {
    releaseInspection();
    f.close();
  }
});
