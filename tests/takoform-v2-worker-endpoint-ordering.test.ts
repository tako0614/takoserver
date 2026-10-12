/**
 * WorkerEndpoint 0.3.0 checks, before any effect, that the Worker's active
 * Deployment answers HTTP (Takoform decisions 0016 rule 3 and 0024 rule 4: an
 * absent Deployment is refused before any mutation). These journeys use the
 * real Deployment and Endpoint backends over the real SQL publication reader;
 * only the native owner and the frontend witness are stand-ins.
 *
 * Before this was enforced, an Endpoint accepted ahead of its Deployment never
 * settled (`worker_endpoint_unconfirmed`), every later Deployment Operation for
 * that Worker queued behind it (`publication_conflict`), and DELETE refused
 * both with `resource_busy`: nothing recovered the Worker through the API.
 */
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
import { referencesForWorkerVersion } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createTakoformV2Routes } from "../src/takoform-v2/routes.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createWorkerCronTriggerAdmissionReader } from "../src/takoform-v2/worker-cron-trigger-backend.ts";
import { createWorkerDeploymentForm } from "../src/takoform-v2/worker-deployment-backend.ts";
import { createWorkerEndpointForm } from "../src/takoform-v2/worker-endpoint-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import type { V2WorkerRuntimeOwnerExecutionResult } from "../src/workerd-worker-runtime-owner.ts";

const TARGET_KEY = "fixture-v2-endpoint-ordering";
const PRINCIPAL = "org-endpoint-ordering";
const SPACE = "prod";
const BASE_URL = "https://host.example/apis/forms.takoform.com/v2";

const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function harness() {
  const root = mkdtempSync(join(tmpdir(), "v2-endpoint-order-"));
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let clockMs = Date.now();
  const now = () => new Date(clockMs);
  const fileUrl = "https://artifacts.example.test/ordering/index.html";
  const manifestUrl = "https://artifacts.example.test/ordering/manifest.json";
  const fileBytes = new TextEncoder().encode("<h1>ordering</h1>");
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      files: [{ path: "index.html", url: fileUrl, sha256: hex(fileBytes), mediaType: "text/html" }],
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
  const ownerCalls: string[] = [];
  /**
   * A stand-in for the UID-owned native owner: it publishes exactly the graph
   * the SQL reader resolves for the Operation, and nothing else.
   */
  const owner = {
    get workerResourceUid() {
      return workerUid;
    },
    async execute(execution: V2Execution): Promise<V2WorkerRuntimeOwnerExecutionResult> {
      const form = execution.form === WORKER_ENDPOINT_FORM_URL ? "endpoint" : "deployment";
      ownerCalls.push(`${form}:${execution.action}`);
      if (form === "deployment" && execution.action === "delete")
        return { kind: "confirmed", identity: null };
      const resolved = await publicationState.resolve({ execution });
      if (resolved.kind !== "ready") return { kind: "unknown" };
      const { snapshot } = resolved;
      if (!snapshot.deployment) {
        const hostname = snapshot.acceptedEndpointOutput?.hostname;
        if (form !== "endpoint" || execution.action !== "delete" || !hostname)
          return { kind: "unknown" };
        return {
          kind: "confirmed_route_absent",
          sourceOperationId: execution.operationId,
          endpointResourceUid: execution.resourceUid,
          workerResourceUid: workerUid,
          targetKey: execution.targetKey,
          assignedHostname: hostname,
        };
      }
      return {
        kind: "confirmed",
        deferRetirementUntilDeadline: false,
        identity: {
          generation: `takoserver-v2-operation:${execution.operationId}`,
          workerResourceUid: workerUid,
          hostnames: snapshot.endpoint ? [snapshot.endpoint.output.hostname] : [],
          versions: snapshot.deployment.versions.map((version) => ({
            versionId: `v2-${hex(new TextEncoder().encode(`${version.uid}\u0000${version.generation}`))}`,
            workerVersionUid: version.uid,
            weight: version.weight,
          })),
        },
      };
    },
  };
  const endpointForm = createWorkerEndpointForm({
    targetKey: TARGET_KEY,
    publicationState,
    ownerForWorker: () => owner,
    assignHostname: ({ resourceUid }) => `v2-${resourceUid.replaceAll("-", "")}.apps.example.test`,
    observeTls: async (input) => ({ ...input, ready: true }),
    observeRouteAbsent: async (input) => ({ ...input, absent: true }),
  });
  const deploymentForm = createWorkerDeploymentForm({
    targetKey: TARGET_KEY,
    publicationState,
    scheduledAttachments: createWorkerCronTriggerAdmissionReader({ sql, now }),
    ownerForWorker: () => owner,
  });
  const foundation = {
    id: "fixture-confirmed-foundation",
    targetKey: TARGET_KEY,
    async execute(input: V2Execution) {
      return {
        kind: "complete" as const,
        observed:
          input.form === WORKER_VERSION_FORM_URL
            ? { ready: true, resolvedBindings: true }
            : { ready: true },
        output: {},
      };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const baseForms: Record<string, V2Form> = {
    [MODULE_WORKER_FORM_URL]: {
      validateCreate: parseModuleWorkerSpec,
      validateUpdate: (_previous, next) => {
        parseModuleWorkerSpec(next);
      },
      backend: foundation,
    },
    [STATIC_ASSET_BUNDLE_FORM_URL]: assets.form,
    [WORKER_VERSION_FORM_URL]: {
      validateCreate: parseWorkerVersionSpec,
      validateUpdate: (_previous, next) => {
        parseWorkerVersionSpec(next);
      },
      references: (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
      backend: foundation,
    },
    [WORKER_DEPLOYMENT_FORM_URL]: deploymentForm,
  };
  const engineWith = (endpoint: V2Form) =>
    createTakoformV2Engine({
      sql,
      now,
      leaseMilliseconds: 1_000,
      replayWindowSeconds: 3600,
      authorize: async () => true,
      forms: { ...baseForms, [WORKER_ENDPOINT_FORM_URL]: endpoint },
    });
  const engine = engineWith(endpointForm);
  return {
    db,
    sql,
    engine,
    endpointForm,
    engineWith,
    ownerCalls,
    advance(ms: number) {
      clockMs += ms;
    },
    async foundations(target = engine) {
      const created = async (form: string, name: string, spec: JsonObject) => {
        const accepted = await target.acceptCreate({
          principal: PRINCIPAL,
          key: `create-${name}-key-0001`,
          input: { form, space: SPACE, name, spec },
        });
        expect(await target.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
        return accepted.resourceUid;
      };
      workerUid = await created(MODULE_WORKER_FORM_URL, "worker", {});
      const asset = await created(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
        artifact: { url: manifestUrl, sha256: hex(manifestBytes) },
      });
      const versionUid = await created(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: workerUid },
        handlers: [],
        assets: {
          bundle: { resourceUid: asset },
          runWorkerFirst: false,
          notFoundHandling: "none",
        },
      });
      return {
        workerUid,
        endpointSpec: { worker: { resourceUid: workerUid } },
        deploymentSpec: {
          worker: { resourceUid: workerUid },
          versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
        },
      };
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Harness = ReturnType<typeof harness>;
type Engine = Harness["engine"];

function accept(engine: Engine, form: string, name: string, spec: JsonObject, key?: string) {
  return engine.acceptCreate({
    principal: PRINCIPAL,
    key: key ?? `create-${name}-key-0001`,
    input: { form, space: SPACE, name, spec },
  });
}

async function operation(engine: Engine, id: string) {
  return engine.getOperation({ principal: PRINCIPAL, id });
}

/** Run every runnable Operation, advancing past retry backoff, until all listed are terminal. */
async function settleAll(h: Harness, engine: Engine, ids: readonly string[]) {
  for (let round = 0; round < 20; round += 1) {
    const states = await Promise.all(ids.map((id) => operation(engine, id)));
    if (states.every((state) => state.status === "succeeded" || state.status === "failed"))
      return states;
    h.advance(2_000);
    while ((await engine.runNext()) !== null) {
      // drain
    }
  }
  throw new Error("Operations did not settle");
}

test("self-host admits only one live or pending WorkerDeployment per Worker", async () => {
  const h = harness();
  try {
    const { deploymentSpec } = await h.foundations();
    const first = await accept(h.engine, WORKER_DEPLOYMENT_FORM_URL, "deployment", deploymentSpec);
    const secondRequest = () =>
      accept(h.engine, WORKER_DEPLOYMENT_FORM_URL, "deployment-second", deploymentSpec);

    // The first Operation has not dispatched, but already owns this Worker.
    await expect(secondRequest()).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    expect(
      await h.engine.listResources({ principal: PRINCIPAL, name: "deployment-second", limit: 10 }),
    ).toEqual([]);
    expect(h.ownerCalls).toEqual([]);

    expect(await h.engine.runNext()).toMatchObject({ id: first.id, status: "succeeded" });
    await expect(secondRequest()).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });

    // Replays and a new generation of the same UID retain their existing authority.
    expect(
      await accept(h.engine, WORKER_DEPLOYMENT_FORM_URL, "deployment", deploymentSpec),
    ).toMatchObject({
      id: first.id,
      resourceUid: first.resourceUid,
      status: "succeeded",
    });
    const updated = await h.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "update-deployment-key-0001",
      uid: first.resourceUid,
      expectedGeneration: 1,
      spec: deploymentSpec,
    });
    expect(await h.engine.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });

    const deleting = await h.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "delete-deployment-key-0001",
      uid: first.resourceUid,
      expectedGeneration: 2,
    });
    await expect(secondRequest()).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    expect(await h.engine.runNext()).toMatchObject({ id: deleting.id, status: "succeeded" });
    const replacement = await secondRequest();
    expect(replacement.resourceUid).not.toBe(first.resourceUid);
    expect(await h.engine.runNext()).toMatchObject({ id: replacement.id, status: "succeeded" });
  } finally {
    h.close();
  }
});

test("concurrent self-host Deployment creates cannot both own the same Worker", async () => {
  const h = harness();
  try {
    const { deploymentSpec } = await h.foundations();
    const results = await Promise.allSettled([
      accept(h.engine, WORKER_DEPLOYMENT_FORM_URL, "deployment-a", deploymentSpec),
      accept(h.engine, WORKER_DEPLOYMENT_FORM_URL, "deployment-b", deploymentSpec),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "dependency_conflict", status: 409 } },
    ]);
    expect(
      await h.engine.listResources({
        principal: PRINCIPAL,
        form: WORKER_DEPLOYMENT_FORM_URL,
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(h.ownerCalls).toEqual([]);
  } finally {
    h.close();
  }
});

test("a WorkerEndpoint is refused before its Worker has an active Deployment, then accepted after it", async () => {
  const h = harness();
  try {
    const { endpointSpec, deploymentSpec } = await h.foundations();
    const refused = accept(h.engine, WORKER_ENDPOINT_FORM_URL, "endpoint", endpointSpec);
    await expect(refused).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    await expect(refused).rejects.toHaveProperty(
      "detail",
      expect.stringContaining("active WorkerDeployment"),
    );
    // Refused before acceptance: no Resource, no reserved name, no replay key.
    expect(
      await h.engine.listResources({ principal: PRINCIPAL, name: "endpoint", limit: 10 }),
    ).toEqual([]);

    // The same refusal over HTTP is a Problem that names the missing Deployment.
    const router = createTakoformV2Routes(h.engine, {
      baseUrl: BASE_URL,
      documentation: "https://docs.example/takoform-v2",
      authenticationDocumentation: "https://docs.example/takoform-v2/authentication",
      authenticationSchemes: ["Bearer"],
      maxRequestBytes: 4_096,
      maxPageSize: 10,
      replayWindowSeconds: 3600,
      cursorSigningKey: new Uint8Array(32).fill(0x5a),
      authenticate: async () => ({ principal: PRINCIPAL, access: "write" }),
    });
    const response = await router.fetch(
      new Request(`${BASE_URL}/resources`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-endpoint-http-key-0001",
        },
        body: JSON.stringify({
          form: WORKER_ENDPOINT_FORM_URL,
          space: SPACE,
          name: "endpoint",
          spec: endpointSpec,
        }),
      }),
    );
    expect(response?.status).toBe(409);
    const problem = (await response?.json()) as Record<string, unknown>;
    expect(problem).toMatchObject({
      type: "about:blank",
      status: 409,
      code: "dependency_conflict",
    });
    expect(problem.detail).toEqual(expect.stringContaining("active WorkerDeployment"));

    const deployment = await accept(
      h.engine,
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      deploymentSpec,
    );
    expect(await h.engine.runNext()).toMatchObject({ id: deployment.id, status: "succeeded" });

    // The refused request wrote no replay key, so the same key now succeeds.
    const endpoint = await accept(h.engine, WORKER_ENDPOINT_FORM_URL, "endpoint", endpointSpec);
    expect(await h.engine.runNext()).toMatchObject({ id: endpoint.id, status: "succeeded" });
    expect(
      await h.engine.getResource({ principal: PRINCIPAL, uid: endpoint.resourceUid }),
    ).toMatchObject({ observed: { tlsReady: true, activeDeploymentRouteReady: true } });

    // A Worker has at most one Endpoint: a second one is refused the same way.
    await expect(
      accept(h.engine, WORKER_ENDPOINT_FORM_URL, "endpoint-second", endpointSpec),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });

    // Re-applying the Endpoint while its Deployment is being deleted is refused too.
    const deploymentDelete = await h.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "delete-deployment-key-0001",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
    });
    await expect(
      h.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: "update-endpoint-key-0001",
        uid: endpoint.resourceUid,
        expectedGeneration: 1,
        spec: endpointSpec,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    expect(await h.engine.runNext()).toMatchObject({
      id: deploymentDelete.id,
      status: "succeeded",
    });
    // With no Deployment left the Endpoint can still be deleted.
    const endpointDelete = await h.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "delete-endpoint-key-0001",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
    });
    expect(await h.engine.runNext()).toMatchObject({
      id: endpointDelete.id,
      status: "succeeded",
    });
  } finally {
    h.close();
  }
});

for (const recovery of ["delete", "update"] as const) {
  test(`an Endpoint stuck ahead of its Deployment by an earlier Host settles failed and recovers by ${recovery}`, async () => {
    const h = harness();
    try {
      // The earlier Host admitted the Endpoint unconditionally and, for this
      // graph, its backend only ever answered `worker_endpoint_unconfirmed`.
      const { prepareAdmission, ...unadmitted } = h.endpointForm;
      expect(prepareAdmission).toBeDefined();
      const earlier = h.engineWith({
        ...unadmitted,
        backend: {
          ...h.endpointForm.backend,
          execute: async () => ({
            kind: "unknown",
            code: "worker_endpoint_unconfirmed",
            message: "The assigned HTTPS endpoint or route is not yet confirmed",
          }),
          reconcile: async () => ({
            kind: "unknown",
            code: "worker_endpoint_unconfirmed",
            message: "The assigned HTTPS endpoint or route is not yet confirmed",
          }),
        },
      });
      const { endpointSpec, deploymentSpec } = await h.foundations(earlier);
      // Acceptance order is the Worker's publication order (created_at, then id).
      h.advance(10);
      const endpoint = await accept(earlier, WORKER_ENDPOINT_FORM_URL, "endpoint", endpointSpec);
      h.advance(10);
      expect(await earlier.runNext()).toMatchObject({
        id: endpoint.id,
        status: "reconciling",
        effect: "unknown",
        error: { code: "worker_endpoint_unconfirmed" },
      });
      const deployment = await accept(
        earlier,
        WORKER_DEPLOYMENT_FORM_URL,
        "deployment",
        deploymentSpec,
      );
      expect(await earlier.runNext()).toMatchObject({
        id: deployment.id,
        status: "reconciling",
        effect: "unknown",
        error: { code: "worker_publication_unconfirmed" },
      });
      for (const uid of [endpoint.resourceUid, deployment.resourceUid]) {
        await expect(
          earlier.acceptDelete({
            principal: PRINCIPAL,
            key: `delete-${uid}-early`,
            uid,
            expectedGeneration: 1,
          }),
        ).rejects.toMatchObject({ code: "resource_busy", status: 409 });
      }
      expect(h.ownerCalls).toEqual([]);

      // The upgraded Host reconciles the same Operations from the same SQL.
      const [endpointOp, deploymentOp] = await settleAll(h, h.engine, [endpoint.id, deployment.id]);
      expect(endpointOp).toMatchObject({
        status: "failed",
        effect: "none",
        error: { code: "worker_deployment_missing" },
      });
      expect(endpointOp?.error?.message).toContain("WorkerDeployment");
      expect(deploymentOp).toMatchObject({ status: "succeeded", effect: "complete" });
      // Nothing was ever sent to the owner for the Endpoint's create.
      expect(h.ownerCalls).toEqual(["deployment:create"]);
      expect(
        await h.engine.getResource({ principal: PRINCIPAL, uid: endpoint.resourceUid }),
      ).toMatchObject({ phase: "error", observedGeneration: 0, observed: {} });

      if (recovery === "delete") {
        const removed = await h.engine.acceptDelete({
          principal: PRINCIPAL,
          key: "delete-endpoint-key-0001",
          uid: endpoint.resourceUid,
          expectedGeneration: 1,
        });
        expect(await h.engine.runNext()).toMatchObject({ id: removed.id, status: "succeeded" });
        const recreated = await accept(
          h.engine,
          WORKER_ENDPOINT_FORM_URL,
          "endpoint",
          endpointSpec,
          "create-endpoint-key-0002",
        );
        expect(await h.engine.runNext()).toMatchObject({ id: recreated.id, status: "succeeded" });
      } else {
        const reapplied = await h.engine.acceptUpdate({
          principal: PRINCIPAL,
          key: "update-endpoint-key-0001",
          uid: endpoint.resourceUid,
          expectedGeneration: 1,
          spec: endpointSpec,
        });
        expect(await h.engine.runNext()).toMatchObject({ id: reapplied.id, status: "succeeded" });
        expect(
          await h.engine.getResource({ principal: PRINCIPAL, uid: endpoint.resourceUid }),
        ).toMatchObject({
          phase: "idle",
          observedGeneration: 2,
          observed: { tlsReady: true, activeDeploymentRouteReady: true },
        });
      }
    } finally {
      h.close();
    }
  });
}
