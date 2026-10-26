import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonObject, SqlError } from "../src/ports.ts";
import { createSelfhostV2WorkerEndpointFrontend } from "../src/selfhost-v2-worker-endpoint-frontend.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import {
  fixedReferencesForForwardWorkerDeployment,
  prepareForwardWorkerDeploymentReferences,
  referencesForWorkerDeployment,
  referencesForWorkerVersion,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  CONTAINER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_WORKER_VERSION_FORM_URL,
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  parseForwardWorkerDeploymentSpec,
  parseForwardWorkerVersionSpec,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Backend, V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import {
  createForwardWorkerEndpointForm,
  createWorkerEndpointForm,
} from "../src/takoform-v2/worker-endpoint-backend.ts";
import { createWorkerPublicationSqlGuard } from "../src/takoform-v2/worker-publication-sql-guard.ts";
import {
  createV2ForwardWorkerPublicationState,
  createV2WorkerPublicationState,
} from "../src/takoform-v2/worker-publication-state.ts";
import type { V2WorkerRuntimeOwnerExecutionResult } from "../src/workerd-worker-runtime-owner.ts";

import { writeMigrateSqliteFile } from "./helpers/migrated-database.ts";

const TARGET_KEY = "fixture-v2-worker-endpoint";
const HOSTNAME = "assigned.example.test";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function observeAssetExecuteFailure(backend: V2Backend, report: (line: string) => void): void {
  const originalExecute = backend.execute;
  let emitted = false;
  backend.execute = function (this: V2Backend, input) {
    const result = originalExecute.call(this, input);
    void result.catch((error: unknown) => {
      try {
        if (emitted) return;
        emitted = true;
        const errorClass =
          error instanceof SqlError
            ? "SqlError"
            : error instanceof TypeError
              ? "TypeError"
              : error instanceof Error
                ? "Error"
                : "non_error";
        const reason =
          error instanceof SqlError && error.code === "constraint"
            ? error.message.includes("tf_v2_artifact_lease_expired") ||
              error.message.includes("tf_v2_artifact_progress_writer_fenced")
              ? "lease-guard"
              : error.message.includes("tf_v2_artifact_progress_not_monotonic")
                ? "progress-order"
                : "other-constraint"
            : "not-constraint";
        report(
          JSON.stringify({
            marker: "takoform.v2.endpoint_asset_execute.failure.v1",
            stage: "asset-backend-execute",
            class: errorClass,
            code: error instanceof SqlError ? error.code : "unclassified",
            reason,
          }),
        );
      } catch {
        // A hostile rejection or diagnostic sink cannot replace the original ACK.
      }
    });
    return result;
  };
}

test("asset diagnostic retains the exact rejected Promise through a throwing sink or rejection", async () => {
  const execution: V2Execution = {
    operationId: "diagnostic-operation",
    leaseToken: "diagnostic-lease",
    backendKey: "diagnostic-backend",
    backendId: "diagnostic-backend",
    targetKey: TARGET_KEY,
    resourceUid: "diagnostic-resource",
    principal: "org-endpoint",
    action: "create",
    generation: 1,
    form: STATIC_ASSET_BUNDLE_FORM_URL,
    space: "prod",
    name: "diagnostic-asset",
    spec: {},
    previousObserved: {},
    previousOutput: {},
  };
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new TypeError("hostile rejection prototype");
      },
    },
  );
  for (const [error, expectedReports, expectedReason] of [
    [new SqlError("unavailable", "not emitted"), 1, "not-constraint"],
    [new SqlError("constraint", "tf_v2_artifact_lease_expired"), 1, "lease-guard"],
    [new SqlError("constraint", "tf_v2_artifact_progress_not_monotonic"), 1, "progress-order"],
    [new SqlError("constraint", "other constraint"), 1, "other-constraint"],
    [hostile, 0, null],
  ] as const) {
    const originalPromise = Promise.reject(error);
    let receiver: unknown;
    let argument: unknown;
    let calls = 0;
    let reports = 0;
    let reportedLine: string | null = null;
    const backend: V2Backend = {
      id: "diagnostic-backend",
      targetKey: TARGET_KEY,
      execute(input) {
        receiver = this;
        argument = input;
        calls += 1;
        return originalPromise;
      },
      reconcile() {
        return originalPromise;
      },
    };
    observeAssetExecuteFailure(backend, (line) => {
      reports += 1;
      reportedLine = line;
      throw new Error("diagnostic sink failed");
    });
    const result = backend.execute(execution);
    expect(result).toBe(originalPromise);
    expect(
      await result.then(
        () => null,
        (caught) => caught,
      ),
    ).toBe(error);
    expect(receiver).toBe(backend);
    expect(argument).toBe(execution);
    expect(calls).toBe(1);
    expect(reports).toBe(expectedReports);
    expect(
      reportedLine ===
        (expectedReports === 1
          ? JSON.stringify({
              marker: "takoform.v2.endpoint_asset_execute.failure.v1",
              stage: "asset-backend-execute",
              class: "SqlError",
              code: error instanceof SqlError ? error.code : "unclassified",
              reason: expectedReason,
            })
          : null),
    ).toBe(true);
  }
});

async function exerciseEndpoint(
  deleteDeploymentFirst: boolean,
  preCreateDelayMs = 0,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "v2-endpoint-backend-"));
  const databasePath = join(root, "state.sqlite");
  writeMigrateSqliteFile(databasePath);
  const db = new Database(databasePath);
  // Keep per-commit durability without rollback-journal metadata churn in this
  // short-lease file fixture. The one-second SQL lease guards remain active.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  const sql = createSqliteSql(db);
  let clockMs = Date.now();
  const now = () => {
    clockMs = Math.max(clockMs, Date.now());
    return new Date(clockMs);
  };
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
  // Keep the same accepted backend object and Promise while classifying only
  // an otherwise-hidden execution throw. No dispatch or retry is added.
  observeAssetExecuteFailure(assets.form.backend, (line) => console.error(line));
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
    if (preCreateDelayMs > 0) await Bun.sleep(preCreateDelayMs);
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
test("accepted Endpoint retains its route outcome when setup precedes a delayed first create", () =>
  exerciseEndpoint(false, 1_100));

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

test("an Endpoint create or update the reader refuses for its Deployment settles with no effect; DELETE never does", async () => {
  const workerUid = "worker-endpoint-refused";
  const address = { hostname: HOSTNAME, url: `https://${HOSTNAME}/` };
  let ownerCalls = 0;
  let code = "deployment_missing";
  const form = createWorkerEndpointForm({
    targetKey: TARGET_KEY,
    publicationState: {
      resolve: async () => ({ kind: "unresolved", code, message: "fixture" }) as never,
    },
    ownerForWorker: () => ({
      workerResourceUid: workerUid,
      execute: async () => {
        ownerCalls += 1;
        return { kind: "unknown" };
      },
    }),
    assignHostname: () => HOSTNAME,
    observeTls: async (input) => ({ ...input, ready: true }),
    observeRouteAbsent: async (input) => ({ ...input, absent: true }),
  });
  const execution = (action: "create" | "update" | "delete"): V2Execution => ({
    operationId: "7e1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c",
    leaseToken: "lease-endpoint-refused",
    backendKey: "backend-key-endpoint-refused",
    backendId: "selfhost-v2-worker-endpoint-owner-v1",
    targetKey: TARGET_KEY,
    resourceUid: "endpoint-backend-refused",
    principal: "org-fixture",
    action,
    generation: action === "create" ? 1 : 2,
    form: WORKER_ENDPOINT_FORM_URL,
    space: "prod",
    name: "endpoint",
    spec: { worker: { resourceUid: workerUid } },
    previousObserved: {},
    previousOutput: address,
  });
  for (const action of ["create", "update"] as const) {
    code = "deployment_missing";
    expect(await form.backend.execute(execution(action))).toMatchObject({
      kind: "no_effect",
      code: "worker_deployment_missing",
    });
    expect(await form.backend.reconcile(execution(action))).toMatchObject({
      kind: "no_effect",
      code: "worker_deployment_missing",
    });
    code = "fetch_unavailable";
    expect(await form.backend.reconcile(execution(action))).toMatchObject({
      kind: "no_effect",
      code: "worker_fetch_handler_missing",
    });
    // A transient or ordering refusal is not a precondition: keep reconciling.
    for (const transient of ["graph_unresolved", "publication_conflict", "stale_claim"]) {
      code = transient;
      expect(await form.backend.reconcile(execution(action))).toMatchObject({ kind: "unknown" });
    }
  }
  for (const refused of ["deployment_missing", "fetch_unavailable"]) {
    code = refused;
    expect(await form.backend.reconcile(execution("delete"))).toMatchObject({ kind: "unknown" });
  }
  expect(ownerCalls).toBe(0);
});

test("Endpoint admission is one SQL predicate with a Problem detail naming the Deployment", async () => {
  const form = createWorkerEndpointForm({
    targetKey: TARGET_KEY,
    publicationState: { resolve: async () => ({ kind: "unresolved" }) as never },
    ownerForWorker: () => ({ workerResourceUid: "w", execute: async () => ({ kind: "unknown" }) }),
    assignHostname: () => HOSTNAME,
    observeTls: async (input) => ({ ...input, ready: true }),
  });
  const admission = await form.prepareAdmission?.({
    action: "create",
    principal: "org-fixture",
    space: "prod",
    form: WORKER_ENDPOINT_FORM_URL,
    resourceUid: "endpoint-uid",
    spec: { worker: { resourceUid: "worker-uid" } },
  });
  expect(admission?.sql).not.toContain(";");
  expect(admission?.params).toContain("worker-uid");
  expect(admission?.params).toContain("endpoint-uid");
  expect(admission?.conflictCode).toBeUndefined();
  expect(admission?.detail).toContain("active WorkerDeployment");
  await expect(
    form.prepareAdmission?.({
      action: "create",
      principal: "org-fixture",
      space: "prod",
      form: WORKER_ENDPOINT_FORM_URL,
      resourceUid: "endpoint-uid",
      spec: { worker: { resourceUid: "worker-uid" }, extra: true },
    }) ?? Promise.resolve(null),
  ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
});

function endpointAdmissionFixtureOptions() {
  return {
    targetKey: TARGET_KEY,
    publicationState: {
      resolve: async () => ({
        kind: "unresolved" as const,
        code: "graph_unresolved" as const,
        message: "admission fixture does not publish",
      }),
    },
    ownerForWorker: () => ({
      workerResourceUid: "unused",
      execute: async () => ({ kind: "unknown" as const }),
    }),
    assignHostname: () => HOSTNAME,
    observeTls: async (input: {
      endpointUid: string;
      workerUid: string;
      hostname: string;
      url: string;
    }) => ({ ...input, ready: false }),
  };
}

test("forward Endpoint preserves retained predicate bytes and exact parameters", async () => {
  const old = createWorkerEndpointForm(endpointAdmissionFixtureOptions());
  const admission = await old.prepareAdmission?.({
    action: "create",
    principal: "org-fixture",
    space: "prod",
    form: WORKER_ENDPOINT_FORM_URL,
    resourceUid: "endpoint-uid",
    spec: { worker: { resourceUid: "worker-uid" } },
  });
  if (!admission) throw new Error("missing retained admission predicate");
  expect(Buffer.byteLength(admission.sql)).toBe(3967);
  expect(createHash("sha256").update(admission.sql).digest("hex")).toBe(
    "5afb98efe56748a54b71e6eedd6f915356941dcccaf271cd11211579bf1d0675",
  );
  expect(admission.params).toEqual([
    WORKER_DEPLOYMENT_FORM_URL,
    "org-fixture",
    "prod",
    "worker-uid",
    WORKER_VERSION_FORM_URL,
    WORKER_ENDPOINT_FORM_URL,
    "org-fixture",
    "prod",
    "endpoint-uid",
    "worker-uid",
  ]);
  expect(createForwardWorkerEndpointForm(endpointAdmissionFixtureOptions()).backend.id).toBe(
    old.backend.id,
  );
});

test("forward Endpoint real Core capture and SQL guard close04/05 and06/05/07 without Container serving", async () => {
  const root = mkdtempSync(join(tmpdir(), "forward-endpoint-admission-"));
  const databasePath = join(root, "state.sqlite");
  writeMigrateSqliteFile(databasePath);
  const db = new Database(databasePath);
  const sql = createSqliteSql(db);
  const principal = "org-forward-endpoint";
  const now = () => new Date();
  let serial = 0;
  // These completed foundation rows are Core/SQL admission fixtures, not a
  // native publication receipt. The separate actual-owner tests own that proof.
  const foundation = {
    id: "fixture-endpoint-admission-foundation",
    targetKey: TARGET_KEY,
    async execute(execution: V2Execution) {
      const deployment =
        execution.form === WORKER_DEPLOYMENT_FORM_URL ||
        execution.form === FORWARD_WORKER_DEPLOYMENT_FORM_URL ||
        execution.form === CONTAINER_WORKER_DEPLOYMENT_FORM_URL;
      const observed: JsonObject = deployment
        ? {
            ready: true,
            active: true,
            selectedVersions: parseWorkerDeploymentSpec(execution.spec).versions.map((v) => ({
              resourceUid: v.workerVersion.resourceUid,
              weight: v.weight,
            })),
          }
        : { ready: true, resolvedBindings: true };
      return { kind: "complete" as const, observed, output: {} };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const file = new TextEncoder().encode("verified-static-fixture");
  const fileUrl = "https://artifacts.example.test/forward-endpoint/index.html";
  const manifestUrl = "https://artifacts.example.test/forward-endpoint/manifest.json";
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      files: [{ path: "index.html", url: fileUrl, sha256: digest(file), mediaType: "text/html" }],
    }),
  );
  const assets = createStaticAssetBundleHost({
    sql,
    targetKey: TARGET_KEY,
    source: {
      async read({ url }) {
        if (url === fileUrl) return file;
        if (url === manifestUrl) return manifest;
        throw new Error("unexpected fixture URL");
      },
    },
  });
  const deployment04: V2Form = {
    validateCreate: parseWorkerDeploymentSpec,
    validateUpdate: (_previous, next) => {
      parseWorkerDeploymentSpec(next);
    },
    references: (spec) => referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec)),
    backend: foundation,
  };
  const endpointForm = createForwardWorkerEndpointForm(endpointAdmissionFixtureOptions());
  const captureState = createV2ForwardWorkerPublicationState({
    sql,
    now,
    assetCustody: assets.custody,
  });
  db.exec("CREATE TABLE endpoint_test_routes (route_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("INSERT INTO endpoint_test_routes VALUES ('route', 'original')");
  const probes: {
    resolution: Awaited<ReturnType<typeof captureState.resolve>>;
    liveChanges?: number;
    wrongWorker?: string;
    staleClaim?: string;
    sourceRefusals?: number;
  }[] = [];
  // This backend settles only this admission fixture with no effect. It never
  // invokes a sender, returns a serving ACK, or substitutes native evidence.
  const admissionOnlyEndpoint: V2Form = {
    ...endpointForm,
    backend: {
      ...endpointForm.backend,
      async execute(execution) {
        const resolution = await captureState.resolve({ execution });
        const probe: (typeof probes)[number] = { resolution };
        probes.push(probe);
        if (resolution.kind === "ready") {
          probe.liveChanges = (
            await sql.run(
              `UPDATE endpoint_test_routes SET value = 'captured' WHERE route_id = 'route' AND (${resolution.sqlGuard.sql})`,
              resolution.sqlGuard.params,
            )
          ).changes;
          probe.wrongWorker = (
            await captureState.resolve({
              execution: { ...execution, spec: { worker: { resourceUid: "foreign-worker" } } },
            })
          ).kind;
          probe.staleClaim = (
            await captureState.resolve({ execution: { ...execution, leaseToken: "foreign-lease" } })
          ).kind;
          const deployment = resolution.snapshot.deployment;
          const resources = await sql.query(
            "SELECT * FROM tf_v2_resources WHERE principal = ? AND space = ?",
            [principal, "prod"],
          );
          const operations = await sql.query("SELECT * FROM tf_v2_operations WHERE principal = ?", [
            principal,
          ]);
          const selected = resources.find((row) => row.uid === deployment?.uid);
          if (selected?.form_url === FORWARD_WORKER_DEPLOYMENT_FORM_URL) {
            if (!deployment) throw new Error("missing captured Deployment");
            if (typeof selected.last_operation !== "string")
              throw new Error("missing captured source Operation");
            const base = {
              execution,
              workerUid: resolution.snapshot.worker.uid,
              principal,
              space: "prod",
              pendingIds: [execution.operationId],
              deploymentIds: [deployment.uid],
              endpointIds: [execution.resourceUid],
              inboundTargetIds: [],
              inboundEdges: [],
              referenceSetIds: [],
              evidence: { resources, operations },
              forwardEndpointDeployment: {
                resourceUid: deployment.uid,
                sourceOperationId: selected.last_operation,
              },
            };
            const { forwardEndpointDeployment: _capturedDeployment, ...legacyBase } = base;
            const wrong = [
              {
                ...base,
                forwardEndpointDeployment: {
                  ...base.forwardEndpointDeployment,
                  resourceUid: execution.resourceUid,
                },
              },
              {
                ...base,
                forwardEndpointDeployment: {
                  ...base.forwardEndpointDeployment,
                  sourceOperationId: execution.operationId,
                },
              },
              { ...base, workerUid: "foreign-worker" },
              { ...legacyBase, forwardDeployment: true as const },
            ];
            probe.sourceRefusals = 0;
            for (const input of wrong) {
              try {
                createWorkerPublicationSqlGuard(input);
              } catch {
                probe.sourceRefusals += 1;
              }
            }
          }
        }
        return {
          kind: "no_effect",
          code: "fixture_admission_only",
          message: "No external effect in admission fixture",
        };
      },
      async reconcile() {
        return {
          kind: "no_effect",
          code: "fixture_admission_only",
          message: "No external effect in admission fixture",
        };
      },
    },
  };
  const version05: V2Form = {
    validateCreate: parseWorkerVersionSpec,
    validateUpdate: (_p, n) => {
      parseWorkerVersionSpec(n);
    },
    references: (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
    backend: foundation,
  };
  const version07: V2Form = {
    ...version05,
    validateCreate: parseForwardWorkerVersionSpec,
    references: (spec) => referencesForWorkerVersion(parseForwardWorkerVersionSpec(spec)),
  };
  const forms: Record<string, V2Form> = {
    [MODULE_WORKER_FORM_URL]: {
      validateCreate: parseModuleWorkerSpec,
      validateUpdate: (_p, n) => {
        parseModuleWorkerSpec(n);
      },
      backend: foundation,
    },
    [STATIC_ASSET_BUNDLE_FORM_URL]: assets.form,
    [WORKER_VERSION_FORM_URL]: version05,
    [FORWARD_WORKER_VERSION_FORM_URL]: version07,
    // Adverse accepted state from another family only, not support registration.
    [CONTAINER_WORKER_VERSION_FORM_URL]: version07,
    [WORKER_DEPLOYMENT_FORM_URL]: deployment04,
    [CONTAINER_WORKER_DEPLOYMENT_FORM_URL]: deployment04,
    [FORWARD_WORKER_DEPLOYMENT_FORM_URL]: {
      ...deployment04,
      validateCreate: parseForwardWorkerDeploymentSpec,
      references: (spec) =>
        fixedReferencesForForwardWorkerDeployment(parseForwardWorkerDeploymentSpec(spec)),
      prepareAdmission: (input) =>
        prepareForwardWorkerDeploymentReferences(input, { sql: "1", params: [] }),
    },
    [WORKER_ENDPOINT_FORM_URL]: admissionOnlyEndpoint,
  };
  const engine = createTakoformV2Engine({
    sql,
    now,
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms,
  });
  async function create(form: string, spec: JsonObject, settle = true) {
    const op = await engine.acceptCreate({
      principal,
      key: `forward-endpoint-fixture-${++serial}-key`,
      input: { form, space: "prod", name: `fixture-${serial}`, spec },
    });
    if (settle)
      expect(await engine.runNext()).toMatchObject({
        id: op.id,
        status: "succeeded",
        effect: "complete",
      });
    return op;
  }
  async function image() {
    const tables = await sql.query(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'tf_v2_*' ORDER BY name",
    );
    return Promise.all(
      tables.map(async (row) => {
        if (typeof row.name !== "string" || !/^tf_v2_[a-z0-9_]+$/u.test(row.name))
          throw new Error("unexpected Core table");
        return [row.name, await sql.query(`SELECT * FROM ${row.name} ORDER BY rowid`)];
      }),
    );
  }
  const refuse = async (workerUid: string) => {
    const before = await image();
    await expect(
      create(WORKER_ENDPOINT_FORM_URL, { worker: { resourceUid: workerUid } }, false),
    ).rejects.toMatchObject({ status: 409, code: "dependency_conflict" });
    expect(await image()).toEqual(before);
  };
  const accept = async (workerUid: string) => {
    const endpoint = await create(
      WORKER_ENDPOINT_FORM_URL,
      { worker: { resourceUid: workerUid } },
      false,
    );
    expect(endpoint.status).toBe("queued");
    expect(
      (
        await sql.query("SELECT output_json FROM tf_v2_resources WHERE uid = ?", [
          endpoint.resourceUid,
        ])
      )[0]?.output_json,
    ).toBe(JSON.stringify({ hostname: HOSTNAME, url: `https://${HOSTNAME}/` }));
    const settled = await engine.runNext();
    const probe = probes.at(-1);
    if (!probe) throw new Error("actual Core Endpoint backend was not entered");
    if (probe.resolution.kind !== "ready")
      throw new Error(
        `actual captured Endpoint source: ${probe.resolution.code}: ${probe.resolution.message}`,
      );
    expect(settled).toMatchObject({
      id: endpoint.id,
      status: "failed",
      effect: "none",
      error: { code: "fixture_admission_only" },
    });
    expect(probe.liveChanges).toBe(1);
    expect(probe.wrongWorker).toBe("unresolved");
    expect(probe.staleClaim).toBe("unresolved");
    if (probe.sourceRefusals !== undefined) expect(probe.sourceRefusals).toBe(4);
    // The real Core terminal projection closes the original claim. Its earlier
    // exact guard must now refuse a write and preserve the actual prior winner.
    expect(
      (
        await sql.run(
          `UPDATE endpoint_test_routes SET value = 'stale' WHERE route_id = 'route' AND (${probe.resolution.sqlGuard.sql})`,
          probe.resolution.sqlGuard.params,
        )
      ).changes,
    ).toBe(0);
    expect(
      await sql.query("SELECT value FROM endpoint_test_routes WHERE route_id = 'route'"),
    ).toEqual([{ value: "captured" }]);
    return endpoint;
  };
  try {
    const asset = await create(STATIC_ASSET_BUNDLE_FORM_URL, {
      artifact: { url: manifestUrl, sha256: digest(manifest) },
    });
    const staticSpec = (worker: string): JsonObject => ({
      worker: { resourceUid: worker },
      handlers: [],
      assets: {
        bundle: { resourceUid: asset.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    for (const [deploymentForm, versionForm, supported] of [
      [WORKER_DEPLOYMENT_FORM_URL, WORKER_VERSION_FORM_URL, true],
      [FORWARD_WORKER_DEPLOYMENT_FORM_URL, WORKER_VERSION_FORM_URL, true],
      [FORWARD_WORKER_DEPLOYMENT_FORM_URL, FORWARD_WORKER_VERSION_FORM_URL, true],
      [CONTAINER_WORKER_DEPLOYMENT_FORM_URL, WORKER_VERSION_FORM_URL, false],
      [FORWARD_WORKER_DEPLOYMENT_FORM_URL, CONTAINER_WORKER_VERSION_FORM_URL, false],
    ] as const) {
      const worker = await create(MODULE_WORKER_FORM_URL, {});
      const version = await create(versionForm, staticSpec(worker.resourceUid));
      const selectedDeployment = await create(deploymentForm, {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10000 }],
      });
      if (supported) {
        const acceptedEndpoint = await accept(worker.resourceUid);
        // Even a failed/no-effect Endpoint retains its same-Worker UID slot.
        await refuse(worker.resourceUid);
        if (
          deploymentForm === FORWARD_WORKER_DEPLOYMENT_FORM_URL &&
          versionForm === FORWARD_WORKER_VERSION_FORM_URL
        ) {
          const deleteDeployment = await engine.acceptDelete({
            principal,
            key: `forward-source-delete-${++serial}-key`,
            uid: selectedDeployment.resourceUid,
            expectedGeneration: 1,
          });
          expect(await engine.runNext()).toMatchObject({
            id: deleteDeployment.id,
            status: "succeeded",
          });
          const deleteEndpoint = await engine.acceptDelete({
            principal,
            key: `forward-endpoint-delete-${++serial}-key`,
            uid: acceptedEndpoint.resourceUid,
            expectedGeneration: 1,
          });
          expect(await engine.runNext()).toMatchObject({
            id: deleteEndpoint.id,
            status: "failed",
            effect: "none",
            error: { code: "fixture_admission_only" },
          });
          const probe = probes.at(-1);
          if (probe?.resolution.kind !== "ready")
            throw new Error("captured Endpoint DELETE without Deployment was refused");
          expect(probe.resolution.snapshot.deployment).toBe(null);
          expect(probe.liveChanges).toBe(1);
          expect(
            (
              await sql.run(
                `UPDATE endpoint_test_routes SET value = 'stale-delete' WHERE route_id = 'route' AND (${probe.resolution.sqlGuard.sql})`,
                probe.resolution.sqlGuard.params,
              )
            ).changes,
          ).toBe(0);
        }
      } else await refuse(worker.resourceUid);
    }
    for (const otherForm of [
      WORKER_DEPLOYMENT_FORM_URL,
      CONTAINER_WORKER_DEPLOYMENT_FORM_URL,
      FORWARD_WORKER_DEPLOYMENT_FORM_URL,
    ]) {
      const worker = await create(MODULE_WORKER_FORM_URL, {});
      const version = await create(WORKER_VERSION_FORM_URL, staticSpec(worker.resourceUid));
      const deploymentSpec = {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10000 }],
      };
      await create(WORKER_DEPLOYMENT_FORM_URL, deploymentSpec);
      const predicate = await endpointForm.prepareAdmission?.({
        action: "create",
        principal,
        space: "prod",
        form: WORKER_ENDPOINT_FORM_URL,
        resourceUid: `future-endpoint-${serial}`,
        spec: { worker: { resourceUid: worker.resourceUid } },
      });
      if (!predicate) throw new Error("missing forward predicate");
      expect(await sql.query(`SELECT 1 AS ready WHERE ${predicate.sql}`, predicate.params)).toEqual(
        [{ ready: 1 }],
      );
      const competitor = await create(otherForm, deploymentSpec, false);
      // An actually accepted pending competing slot makes this same predicate
      // false, before any competing backend dispatch or Endpoint acceptance.
      expect(await sql.query(`SELECT 1 AS ready WHERE ${predicate.sql}`, predicate.params)).toEqual(
        [],
      );
      await refuse(worker.resourceUid);
      expect(await engine.runNext()).toMatchObject({ id: competitor.id, status: "succeeded" });
      const deletion = await engine.acceptDelete({
        principal,
        key: `forward-endpoint-delete-${++serial}-key`,
        uid: competitor.resourceUid,
        expectedGeneration: 1,
      });
      expect(await engine.runNext()).toMatchObject({
        id: deletion.id,
        status: "succeeded",
        effect: "complete",
      });
      expect(await sql.query(`SELECT 1 AS ready WHERE ${predicate.sql}`, predicate.params)).toEqual(
        [{ ready: 1 }],
      );
      await accept(worker.resourceUid);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
