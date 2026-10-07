import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSelfhostV2QueueWorkerCapability } from "../src/selfhost-v2-queue-worker-capability.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

const principal = "queue-adapter-principal";
const space = "default";
const targetKey = "queue-adapter-target";
const BUNDLE_FORM_URL = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";

test("Queue capability joins accepted SQL graph with exact native queue observation and fails closed on drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-queue-capability-"));
  const db = new Database(join(root, "state.sqlite"));
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const bytes = new TextEncoder().encode("export default { fetch() {}, queue() {} };");
    const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const moduleUrl = "https://artifacts.example.test/queue-capability/app.mjs";
    const manifestUrl = "https://artifacts.example.test/queue-capability/manifest.json";
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "app.mjs",
        files: [
          {
            path: "app.mjs",
            url: moduleUrl,
            sha256: digest(bytes),
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    const bundle = createWorkerBundleHost({
      sql,
      targetKey,
      source: {
        async read({ url }) {
          if (url === manifestUrl) return manifest;
          if (url === moduleUrl) return bytes;
          throw new Error("unexpected artifact URL");
        },
      },
    });
    const ordinary: V2Form = {
      validateCreate() {},
      validateUpdate() {},
      backend: {
        id: "queue-adapter-fixture",
        targetKey,
        async execute(input: V2Execution) {
          return {
            kind: "complete" as const,
            observed:
              input.form === WORKER_VERSION_FORM_URL
                ? { ready: true, resolvedBindings: true, bundleVerified: true }
                : input.form === WORKER_DEPLOYMENT_FORM_URL
                  ? { ready: true, active: true, selectedVersions: [] }
                  : input.form === WORKER_ENDPOINT_FORM_URL
                    ? { tlsReady: true, activeDeploymentRouteReady: true }
                    : { ready: true },
            output: input.previousOutput,
          };
        },
        async reconcile() {
          return { kind: "unknown" as const };
        },
      },
    };
    const engine = createTakoformV2Engine({
      sql,
      now: () => new Date(),
      replayWindowSeconds: 3600,
      leaseMilliseconds: 60_000,
      authorize: async () => true,
      forms: {
        [MODULE_WORKER_FORM_URL]: ordinary,
        [BUNDLE_FORM_URL]: bundle.form,
        [WORKER_VERSION_FORM_URL]: {
          ...ordinary,
          references(spec) {
            return [
              {
                resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
                formUrl: MODULE_WORKER_FORM_URL,
                readiness: "observed",
              },
              {
                resourceUid: (spec.bundle as { resourceUid: string }).resourceUid,
                formUrl: BUNDLE_FORM_URL,
                readiness: "observed",
              },
            ];
          },
        },
        [WORKER_DEPLOYMENT_FORM_URL]: {
          ...ordinary,
          references(spec) {
            const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
            const versions = spec.versions as { workerVersion: { resourceUid: string } }[];
            return [
              { resourceUid: workerUid, formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
              ...versions.map((item) => ({
                resourceUid: item.workerVersion.resourceUid,
                formUrl: WORKER_VERSION_FORM_URL,
                readiness: "ready" as const,
                targetSpecMatch: { path: ["worker", "resourceUid"], equals: workerUid },
              })),
            ];
          },
        },
        [WORKER_ENDPOINT_FORM_URL]: {
          ...ordinary,
          references(spec) {
            return [
              {
                resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
                formUrl: MODULE_WORKER_FORM_URL,
                readiness: "observed",
              },
            ];
          },
          initialOutput() {
            return {
              hostname: "queue-adapter.example.test",
              url: "https://queue-adapter.example.test/",
            };
          },
        },
      },
    });
    const create = async (form: string, name: string, spec: JsonObject) => {
      const accepted = await engine.acceptCreate({
        principal,
        key: `queue-adapter-${name}-key-0001`,
        input: { form, space, name, spec },
      });
      expect((await engine.runNext())?.status).toBe("succeeded");
      return accepted;
    };
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const artifact = await create(BUNDLE_FORM_URL, "artifact", {
      artifact: { url: manifestUrl, sha256: digest(manifest) },
    });
    const version = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: artifact.resourceUid },
      handlers: ["fetch", "queue"],
    });
    const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const publicationState = createV2WorkerPublicationState({ sql, bundleCustody: bundle.custody });
    let nativeCurrent = true;
    let ownerRestored = true;
    let observedSource = deployment.id;
    let observedGeneration = 1;
    const owner = {
      async observeQueueServingCapability(input: {
        workerUid: string;
        principal: string;
        space: string;
        targetKey: string;
      }) {
        if (
          !nativeCurrent ||
          input.workerUid !== worker.resourceUid ||
          input.principal !== principal ||
          input.space !== space ||
          input.targetKey !== targetKey
        )
          return { kind: "unknown" as const };
        return {
          kind: "confirmed" as const,
          servingSourceOperationId: observedSource,
          deploymentUid: deployment.resourceUid,
          deploymentGeneration: 1,
          versions: [
            {
              workerVersionUid: version.resourceUid,
              generation: observedGeneration,
              weight: 10_000,
            },
          ],
          stillCurrent: async () => nativeCurrent,
        };
      },
    } satisfies Pick<WorkerdWorkerRuntimeOwner, "observeQueueServingCapability">;
    const capability = createSelfhostV2QueueWorkerCapability({
      sql,
      targetKey,
      publicationState,
      ownerForWorkerUid: async (uid) => {
        if (!ownerRestored || uid !== worker.resourceUid)
          throw new Error("native owner has not restored this Worker UID");
        return owner;
      },
    });
    const scope = { workerUid: worker.resourceUid, principal, space, targetKey };
    expect(await capability.observeQueueServingCapability(scope)).toMatchObject({
      kind: "confirmed",
      servingSourceOperationId: deployment.id,
    });
    const serving = await capability.observeCurrentServing(scope);
    expect(serving).toMatchObject({
      kind: "ready",
      snapshot: { sourceOperationId: deployment.id, deployment: { uid: deployment.resourceUid } },
    });
    if (serving.kind !== "ready") throw new Error("accepted graph did not resolve");
    expect(await serving.stillCurrent()).toBe(true);
    expect(
      await capability.observeCurrentServing({ ...scope, principal: "foreign" }),
    ).toMatchObject({ kind: "unresolved" });
    expect(
      await capability.observeCurrentServing({ ...scope, targetKey: "foreign-target" }),
    ).toMatchObject({ kind: "unresolved" });
    ownerRestored = false;
    expect(await capability.observeQueueServingCapability(scope)).toEqual({ kind: "unknown" });
    expect(await capability.observeCurrentServing(scope)).toMatchObject({ kind: "unresolved" });
    ownerRestored = true;
    observedGeneration = 2;
    expect(await capability.observeCurrentServing(scope)).toMatchObject({ kind: "unresolved" });
    observedGeneration = 1;
    observedSource = worker.id;
    expect(await capability.observeCurrentServing(scope)).toMatchObject({ kind: "unresolved" });
    observedSource = deployment.id;
    nativeCurrent = false;
    expect(await capability.observeQueueServingCapability(scope)).toEqual({ kind: "unknown" });
    expect(await serving.stillCurrent()).toBe(false);
    await expect(serving.readVersionMaterials(version.resourceUid)).rejects.toThrow();
    nativeCurrent = true;
    await sql.run("UPDATE tf_v2_resources SET phase = 'pending' WHERE uid = ?", [
      deployment.resourceUid,
    ]);
    expect(await capability.observeCurrentServing(scope)).toMatchObject({ kind: "unresolved" });
    expect(await serving.stillCurrent()).toBe(false);
    await sql.run("UPDATE tf_v2_resources SET phase = 'idle' WHERE uid = ?", [
      deployment.resourceUid,
    ]);
    const [versionRow] = await sql.query(
      "SELECT observed_json FROM tf_v2_resources WHERE uid = ?",
      [version.resourceUid],
    );
    if (typeof versionRow?.observed_json !== "string")
      throw new Error("missing accepted Version observation");
    await sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      JSON.stringify({ ready: false, resolvedBindings: false, bundleVerified: false }),
      version.resourceUid,
    ]);
    expect(await capability.observeCurrentServing(scope)).toMatchObject({ kind: "unresolved" });
    expect(await serving.stillCurrent()).toBe(false);
    await sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      versionRow.observed_json,
      version.resourceUid,
    ]);
    const reopened = new Database(join(root, "state.sqlite"));
    try {
      const reopenedSql = createSqliteSql(reopened);
      const reopenedCapability = createSelfhostV2QueueWorkerCapability({
        sql: reopenedSql,
        targetKey,
        publicationState: createV2WorkerPublicationState({
          sql: reopenedSql,
          bundleCustody: createWorkerBundleHost({
            sql: reopenedSql,
            targetKey,
            source: {
              async read() {
                throw new Error("artifact origin unavailable after restart");
              },
            },
          }).custody,
        }),
        ownerForWorkerUid: async () => owner,
      });
      expect(await reopenedCapability.observeCurrentServing(scope)).toMatchObject({
        kind: "ready",
        snapshot: { sourceOperationId: deployment.id },
      });
    } finally {
      reopened.close();
    }
    const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
      worker: { resourceUid: worker.resourceUid },
    });
    observedSource = endpoint.id;
    const endpointServing = await capability.observeCurrentServing(scope);
    expect(endpointServing).toMatchObject({
      kind: "ready",
      snapshot: {
        sourceOperationId: endpoint.id,
        endpoint: { output: { hostname: "queue-adapter.example.test" } },
      },
    });
    expect(await serving.stillCurrent()).toBe(false);
    const deletedEndpoint = await engine.acceptDelete({
      principal,
      key: "queue-adapter-delete-endpoint-key-0001",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    observedSource = deletedEndpoint.id;
    expect(await capability.observeCurrentServing(scope)).toMatchObject({
      kind: "ready",
      snapshot: { sourceOperationId: deletedEndpoint.id, endpoint: null },
    });
    if (endpointServing.kind === "ready") expect(await endpointServing.stillCurrent()).toBe(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
