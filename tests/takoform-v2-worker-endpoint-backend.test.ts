import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSelfhostV2WorkerEndpointFrontend } from "../src/selfhost-v2-worker-endpoint-frontend.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerVersion,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createWorkerEndpointForm } from "../src/takoform-v2/worker-endpoint-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import type { V2WorkerRuntimeOwnerExecutionResult } from "../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-v2-worker-endpoint";
const HOSTNAME = "assigned.example.test";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exerciseEndpoint(deleteDeploymentFirst: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "v2-endpoint-backend-"));
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let clockMs = Date.now();
  const now = () => new Date(clockMs);
  const fileUrl = "https://artifacts.example.test/endpoint/index.html";
  const manifestUrl = "https://artifacts.example.test/endpoint/manifest.json";
  const fileBytes = new TextEncoder().encode("<h1>fixture</h1>");
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      files: [
        { path: "index.html", url: fileUrl, sha256: digest(fileBytes), mediaType: "text/html" },
      ],
    }),
  );
  const assets = createStaticAssetBundleHost({
    sql,
    targetKey: TARGET_KEY,
    source: {
      async read({ url }) {
        if (url === manifestUrl) return manifestBytes;
        if (url === fileUrl) return fileBytes;
        throw new Error("unknown fixture artifact");
      },
    },
  });
  const publicationState = createV2WorkerPublicationState({
    sql,
    now,
    assetCustody: assets.custody,
  });
  let workerUid = "";
  let versionUid = "";
  let allocationCalls = 0;
  const ownerCalls: string[] = [];
  let loseNextOwnerAcknowledgement = true;
  let returnDeploymentDeleteReceipt = false;
  let routeAbsentReceiptReady = false;
  let receiptHostname = HOSTNAME;
  let routeAbsenceReady = false;
  let nativeRouteHostname = HOSTNAME;
  let tlsHostname = HOSTNAME;
  let nativeServing: {
    readonly sourceOperationId: string;
    readonly generation: string;
    readonly hostnames: readonly string[];
    readonly versions: readonly {
      readonly workerVersionUid: string;
      readonly versionId: string;
      readonly weight: number;
    }[];
  } | null = null;
  const tlsReady = true;
  let tlsCalls = 0;
  let routeAbsenceCalls = 0;
  const runtimeOwner = {
    get workerResourceUid() {
      return workerUid;
    },
    async execute(execution: V2Execution): Promise<V2WorkerRuntimeOwnerExecutionResult> {
      ownerCalls.push(execution.operationId);
      if (loseNextOwnerAcknowledgement) {
        loseNextOwnerAcknowledgement = false;
        return { kind: "unknown" };
      }
      if (returnDeploymentDeleteReceipt && execution.action === "delete") {
        return { kind: "confirmed", identity: null };
      }
      if (routeAbsentReceiptReady && execution.action === "delete") {
        nativeServing = null;
        return {
          kind: "confirmed_route_absent",
          sourceOperationId: execution.operationId,
          endpointResourceUid: execution.resourceUid,
          workerResourceUid: execution.principal === "org-endpoint" ? workerUid : "foreign",
          targetKey: execution.targetKey,
          assignedHostname: receiptHostname,
        };
      }
      const versionId = `v2-${digest(new TextEncoder().encode(`${versionUid}\u00001`))}`;
      const identity = {
        generation: `takoserver-v2-operation:${execution.operationId}`,
        workerResourceUid: workerUid,
        hostnames: execution.action === "delete" ? [] : [nativeRouteHostname],
        versions: [{ versionId, workerVersionUid: versionUid, weight: 10_000 }],
      };
      nativeServing = {
        sourceOperationId: execution.operationId,
        generation: identity.generation,
        hostnames: identity.hostnames,
        versions: identity.versions,
      };
      return { kind: "confirmed", deferRetirementUntilDeadline: false, identity };
    },
    async observeServing(input: { workerResourceUid: string; targetKey: string }) {
      if (!nativeServing) return { kind: "unknown" as const };
      return {
        kind: "serving" as const,
        workerResourceUid: input.workerResourceUid,
        targetKey: input.targetKey,
        ...nativeServing,
      };
    },
    async observeRetirement() {
      return routeAbsentReceiptReady
        ? {
            kind: "confirmed_absent" as const,
            workerResourceUid: workerUid,
            targetKey: TARGET_KEY,
            incarnationOperationIds: [],
          }
        : { kind: "unknown" as const };
    },
    async fetch() {
      return new Response("unused");
    },
  };
  const workerEndpointFrontend = createSelfhostV2WorkerEndpointFrontend({
    sql,
    targetKey: TARGET_KEY,
    publicOrigin: "https://api.example.test",
    workerEndpointSuffix: "example.test",
    publicationState,
    ownerForWorkerUid: async (uid) => {
      expect(uid).toBe(workerUid);
      return runtimeOwner as never;
    },
    witness: {
      async observeTls(input) {
        tlsCalls += 1;
        return {
          ...input,
          hostname: tlsHostname,
          ready: tlsReady && input.hostname === HOSTNAME,
        };
      },
      async observeRouteAbsent(input) {
        routeAbsenceCalls += 1;
        return { ...input, absent: routeAbsenceReady };
      },
    },
  });
  const endpointForm = createWorkerEndpointForm({
    targetKey: TARGET_KEY,
    publicationState,
    assignHostname({ resourceUid }) {
      allocationCalls += 1;
      expect(resourceUid).toMatch(/^[0-9a-f-]{36}$/u);
      return HOSTNAME;
    },
    ownerForWorker() {
      return runtimeOwner;
    },
    observeTls: workerEndpointFrontend.observeTls,
    observeRouteAbsent: workerEndpointFrontend.observeRouteAbsent,
  });
  const foundationBackend = {
    id: "fixture-confirmed-foundation",
    targetKey: TARGET_KEY,
    async execute(input: V2Execution) {
      const observed =
        input.form === WORKER_VERSION_FORM_URL
          ? { ready: true, resolvedBindings: true }
          : input.form === WORKER_DEPLOYMENT_FORM_URL
            ? {
                ready: true,
                active: true,
                selectedVersions: [{ resourceUid: versionUid, weight: 10_000 }],
              }
            : { ready: true };
      return { kind: "complete" as const, observed, output: {} };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const forms: Record<string, V2Form> = {
    [MODULE_WORKER_FORM_URL]: {
      validateCreate: parseModuleWorkerSpec,
      validateUpdate: (_previous, next) => {
        parseModuleWorkerSpec(next);
      },
      backend: foundationBackend,
    },
    [STATIC_ASSET_BUNDLE_FORM_URL]: assets.form,
    [WORKER_VERSION_FORM_URL]: {
      validateCreate: parseWorkerVersionSpec,
      validateUpdate: (_previous, next) => {
        parseWorkerVersionSpec(next);
      },
      references: (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
      backend: foundationBackend,
    },
    [WORKER_DEPLOYMENT_FORM_URL]: {
      validateCreate: parseWorkerDeploymentSpec,
      validateUpdate: (_previous, next) => {
        parseWorkerDeploymentSpec(next);
      },
      references: (spec) => referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec)),
      backend: foundationBackend,
    },
    [WORKER_ENDPOINT_FORM_URL]: endpointForm,
  };
  const engine = createTakoformV2Engine({
    sql,
    now,
    leaseMilliseconds: 1_000,
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms,
  });
  const create = async (form: string, name: string, spec: JsonObject) => {
    const accepted = await engine.acceptCreate({
      principal: "org-endpoint",
      key: `create-${name}-key-0001`,
      input: { form, space: "prod", name, spec },
    });
    expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    return accepted;
  };
  try {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    workerUid = worker.resourceUid;
    const asset = await create(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
      artifact: { url: manifestUrl, sha256: digest(manifestBytes) },
    });
    const version = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: workerUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: asset.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    versionUid = version.resourceUid;
    const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: workerUid },
      versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
    });
    const endpointSpec = { worker: { resourceUid: workerUid } };
    const endpoint = await engine.acceptCreate({
      principal: "org-endpoint",
      key: "create-endpoint-key-0001",
      input: {
        form: WORKER_ENDPOINT_FORM_URL,
        space: "prod",
        name: "endpoint",
        spec: endpointSpec,
      },
    });
    expect(allocationCalls).toBe(1);
    expect(
      await engine.getResource({ principal: "org-endpoint", uid: endpoint.resourceUid }),
    ).toMatchObject({
      observed: {},
      output: { hostname: HOSTNAME, url: `https://${HOSTNAME}/` },
    });
    expect(await engine.runNext()).toMatchObject({
      id: endpoint.id,
      status: "reconciling",
      effect: "unknown",
    });
    const replay = await engine.acceptCreate({
      principal: "org-endpoint",
      key: "create-endpoint-key-0001",
      input: {
        form: WORKER_ENDPOINT_FORM_URL,
        space: "prod",
        name: "endpoint",
        spec: endpointSpec,
      },
    });
    expect(replay.id).toBe(endpoint.id);
    expect(allocationCalls).toBe(1);
    clockMs += 2_000;
    expect(await engine.runNext()).toMatchObject({ id: endpoint.id, status: "succeeded" });
    expect(ownerCalls).toEqual([endpoint.id, endpoint.id]);
    expect(
      await engine.getResource({ principal: "org-endpoint", uid: endpoint.resourceUid }),
    ).toMatchObject({
      observed: { tlsReady: true, activeDeploymentRouteReady: true },
      output: { hostname: HOSTNAME, url: `https://${HOSTNAME}/` },
    });
    const update = await engine.acceptUpdate({
      principal: "org-endpoint",
      key: "update-endpoint-key-0001",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
      spec: endpointSpec,
    });
    nativeRouteHostname = "wrong.example.test";
    expect(await engine.runNext()).toMatchObject({
      id: update.id,
      status: "reconciling",
      effect: "unknown",
    });
    nativeRouteHostname = HOSTNAME;
    tlsHostname = "wrong.example.test";
    clockMs += 2_000;
    expect(await engine.runNext()).toMatchObject({
      id: update.id,
      status: "reconciling",
      effect: "unknown",
    });
    tlsHostname = HOSTNAME;
    clockMs += 2_000;
    expect(await engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(allocationCalls).toBe(1);
    expect(
      await engine.getResource({ principal: "org-endpoint", uid: endpoint.resourceUid }),
    ).toMatchObject({
      output: { hostname: HOSTNAME, url: `https://${HOSTNAME}/` },
    });
    if (deleteDeploymentFirst) {
      const deploymentDelete = await engine.acceptDelete({
        principal: "org-endpoint",
        key: "delete-deployment-key-0001",
        uid: deployment.resourceUid,
        expectedGeneration: 1,
      });
      expect(await engine.runNext()).toMatchObject({
        id: deploymentDelete.id,
        status: "succeeded",
      });
      routeAbsentReceiptReady = true;
      receiptHostname = "other.example.test";
    }
    const deleted = await engine.acceptDelete({
      principal: "org-endpoint",
      key: "delete-endpoint-key-0001",
      uid: endpoint.resourceUid,
      expectedGeneration: 2,
    });
    returnDeploymentDeleteReceipt = true;
    expect(await engine.runNext()).toMatchObject({
      id: deleted.id,
      status: "reconciling",
      effect: "unknown",
    });
    returnDeploymentDeleteReceipt = false;
    clockMs += 2_000;
    expect(await engine.runNext()).toMatchObject({
      id: deleted.id,
      status: "reconciling",
      effect: "unknown",
    });
    if (deleteDeploymentFirst) {
      // A native no-publication receipt for a different accepted hostname
      // cannot settle this Endpoint even when the Worker has no Deployment.
      expect(routeAbsenceCalls).toBe(0);
      receiptHostname = HOSTNAME;
    } else {
      expect(routeAbsenceCalls).toBe(1);
    }
    clockMs += 2_000;
    if (deleteDeploymentFirst) {
      expect(await engine.runNext()).toMatchObject({
        id: deleted.id,
        status: "reconciling",
        effect: "unknown",
      });
      expect(routeAbsenceCalls).toBe(1);
      clockMs += 2_000;
    }
    routeAbsenceReady = true;
    expect(await engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
    expect(tlsCalls).toBe(3); // create and both update attempts; delete does not infer TLS absence
    expect(routeAbsenceCalls).toBe(2);
    if (!deleteDeploymentFirst)
      expect(
        await engine.getResource({ principal: "org-endpoint", uid: deployment.resourceUid }),
      ).toMatchObject({ observed: { ready: true, active: true } });
    expect(await engine.getResource({ principal: "org-endpoint", uid: workerUid })).toMatchObject({
      observed: { ready: true },
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepted Endpoint deletes its route with an active Deployment", () =>
  exerciseEndpoint(false));
test("accepted Endpoint deletes its route after Deployment deletion", () => exerciseEndpoint(true));

for (const action of ["create", "update", "delete"] as const) {
  test(`an Endpoint ${action} whose candidate the owner retired before activation settles with no effect`, async () => {
    const operationId = "6e1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c";
    const workerUid = "worker-endpoint-abandoned";
    const endpointUid = "endpoint-backend-abandoned";
    const address = { hostname: HOSTNAME, url: `https://${HOSTNAME}/` };
    const deploymentSpec = parseWorkerDeploymentSpec({
      worker: { resourceUid: workerUid },
      versions: [{ workerVersion: { resourceUid: "version-endpoint-abandoned" }, weight: 10_000 }],
    });
    const execution: V2Execution = {
      operationId,
      leaseToken: "lease-endpoint-abandoned",
      backendKey: "backend-key-endpoint-abandoned",
      backendId: "selfhost-v2-worker-endpoint-owner-v1",
      targetKey: TARGET_KEY,
      resourceUid: endpointUid,
      principal: "org-fixture",
      action,
      generation: action === "create" ? 1 : 2,
      form: WORKER_ENDPOINT_FORM_URL,
      space: "prod",
      name: "endpoint",
      spec: { worker: { resourceUid: workerUid } },
      previousObserved: {},
      previousOutput: address,
    };
    const snapshot = {
      sourceOperationId: operationId,
      acceptedEndpointOutput: address,
      worker: { uid: workerUid, principal: "org-fixture", space: "prod", generation: 1 },
      deployment: {
        uid: "deployment-endpoint-abandoned",
        generation: 1,
        spec: deploymentSpec,
        versions: [],
      },
      endpoint:
        action === "delete"
          ? null
          : {
              uid: endpointUid,
              generation: execution.generation,
              spec: { worker: { resourceUid: workerUid } },
              output: address,
            },
    };
    let fenceCurrent = true;
    let result: V2WorkerRuntimeOwnerExecutionResult = {
      kind: "abandoned_before_activation",
      operationId,
    };
    let tlsReads = 0;
    let routeReads = 0;
    const form = createWorkerEndpointForm({
      targetKey: TARGET_KEY,
      publicationState: {
        resolve: async () =>
          ({
            kind: "ready",
            snapshot,
            sqlGuard: { sql: "1", params: [] },
            stillCurrent: async () => fenceCurrent,
            readVersionMaterials: async () => ({ bundle: null, assets: null }),
          }) as never,
      },
      ownerForWorker: () => ({ workerResourceUid: workerUid, execute: async () => result }),
      assignHostname: () => HOSTNAME,
      observeTls: async (input) => {
        tlsReads += 1;
        return { ...input, ready: true };
      },
      observeRouteAbsent: async (input) => {
        routeReads += 1;
        return { ...input, absent: true };
      },
    });
    expect(await form.backend.reconcile(execution)).toEqual({
      kind: "no_effect",
      code: "worker_incarnation_retired_before_activation",
      message:
        "This publication's Worker incarnation was retired before it was activated; nothing it published served. Re-apply to retry.",
    });
    // The owner's proof settles it: no frontend observation is consulted.
    expect({ tlsReads, routeReads }).toEqual({ tlsReads: 0, routeReads: 0 });
    // The proof must name this exact Operation.
    result = { kind: "abandoned_before_activation", operationId: "other-operation" };
    expect(await form.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
    // A SQL fence lost after the owner answered keeps the outcome unknown.
    result = { kind: "abandoned_before_activation", operationId };
    let checks = 0;
    fenceCurrent = true;
    const losingForm = createWorkerEndpointForm({
      targetKey: TARGET_KEY,
      publicationState: {
        resolve: async () =>
          ({
            kind: "ready",
            snapshot,
            sqlGuard: { sql: "1", params: [] },
            // Current for the checks before the owner call, then lost.
            stillCurrent: async () => {
              checks += 1;
              return checks <= 2;
            },
            readVersionMaterials: async () => ({ bundle: null, assets: null }),
          }) as never,
      },
      ownerForWorker: () => ({ workerResourceUid: workerUid, execute: async () => result }),
      assignHostname: () => HOSTNAME,
      observeTls: async (input) => ({ ...input, ready: true }),
      observeRouteAbsent: async (input) => ({ ...input, absent: true }),
    });
    expect(await losingForm.backend.reconcile(execution)).toMatchObject({ kind: "unknown" });
    expect(checks).toBe(3);
  });
}
