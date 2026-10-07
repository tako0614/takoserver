import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerEndpoint,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  validateWorkerDeploymentUpdate,
  validateWorkerEndpointUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
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

function fixture(options?: {
  gateEndpointWithPublicationReader?: boolean;
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
  const versionForm = createInternalV2StaticWorkerVersionForm({
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
    forms: {
      [MODULE_WORKER_FORM_URL]: workerForm,
      [WORKER_VERSION_FORM_URL]: versionForm,
      [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
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
  return {
    db,
    sql,
    engine,
    workerForm,
    versionForm,
    retirement,
    serving,
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
