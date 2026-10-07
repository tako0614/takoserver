import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { createV2HeldArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/takoform-v2/forms/durable-workflow.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleCustody } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createSelfhostV2WorkflowComposition } from "../src/takoform-v2/selfhost-v2-workflow-composition.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const ORIGIN = "https://api.example.test";
const API = "/apis/forms.takoform.com/v2";
const TARGET = "selfhost-v2-workflow-native";
const MANIFEST_URL = "https://artifacts.example.test/workflow/manifest.json";
const MODULE_URL = "https://artifacts.example.test/workflow/index.mjs";
const workerd = nativeEvidenceBinary("workerd-artifact");
const guard = nativeEvidenceBinary(
  "workerd-artifact",
  "TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY",
);

// Test-local Form injection proves this accepted native path, not normal Host
// publication or WorkerVersion Workflow Binding support.
test.skipIf(workerd === undefined || guard === undefined)(
  "accepted v2 Workflow runs selected held class and durable steps through pinned native guard",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-v2-workflow-accepted-native-"));
    const database = new Database(join(root, "host.sqlite"));
    let workerComposition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    let workflowComposition: ReturnType<typeof createSelfhostV2WorkflowComposition> | undefined;
    let primaryError: unknown;
    try {
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const objects = createMemoryObjectStore();
      const clock = () => new Date();
      const artifact = await selectClosedGraphWorkerd({
        binary: workerd,
        privateRoot: join(root, "selected-workerd"),
      });
      if (!artifact.binary) throw new Error(artifact.diagnostic ?? "pinned Workerd unavailable");
      const module = new TextEncoder().encode(`
export class ReportWorkflow {
  constructor(env) { this.env = env; }
  async run(event, step) {
    const first = await step.do("memo", () => ({ value: this.env.SETTING, input: event.params.value }));
    await step.sleep("zero", 0);
    const replayed = await step.do("memo", null);
    return { first, replayed, instance: event.instanceId };
  }
}
export default { fetch() { return new Response("worker-serving"); } };
`);
      const moduleSha = (await bytesDigest(module)).slice(7);
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: MODULE_URL,
              sha256: moduleSha,
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const manifestSha = (await bytesDigest(manifest)).slice(7);
      await objects.create("workflow/manifest", manifest);
      await objects.create("workflow/module", module);
      const identity = {
        async verify({ assertion }: { assertion: string }) {
          return {
            providerSubject: assertion,
            email: `${assertion}@example.test`,
            displayName: assertion,
          };
        },
      };
      const accounts = createAccounts({ sql, identity, clock });
      const session = await accounts.signIn({ provider: "google", assertion: "workflow-owner" });
      const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({
        actor,
        name: "Workflow Native Org",
      });
      const apiKey = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Workflow native test key",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      const workerBundleConfig = {
        targetKey: TARGET,
        heldArtifacts: [
          {
            url: MANIFEST_URL,
            sha256: manifestSha,
            objectKey: "workflow/manifest",
            grants: [{ principal: `org:${organization.id}`, space: organization.id }],
          },
          {
            url: MODULE_URL,
            sha256: moduleSha,
            objectKey: "workflow/module",
            grants: [{ principal: `org:${organization.id}`, space: organization.id }],
          },
        ],
      };
      const config = {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: workerBundleConfig,
      };
      workerComposition = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config,
        rootDirectory: join(root, "worker-owners"),
        targetKey: TARGET,
        workerdBinary: artifact.binary,
        spawn: (command) =>
          spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "inherit" }),
        endpoint: {
          assignHostname({ resourceUid }) {
            return `worker-${resourceUid.slice(0, 8)}.example.test`;
          },
          async observeTls(input) {
            const owner = await workerComposition?.ownerForWorkerUid(input.workerUid);
            const serving = await owner?.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              ready: serving?.kind === "serving" && serving.hostnames.includes(input.hostname),
            };
          },
          async observeRouteAbsent(input) {
            const owner = await workerComposition?.ownerForWorkerUid(input.workerUid);
            const serving = await owner?.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              absent: serving?.kind === "serving" && !serving.hostnames.includes(input.hostname),
            };
          },
        },
      });
      const activeWorkerComposition = workerComposition;
      expect(await activeWorkerComposition.restoreOwners()).toEqual([]);
      const bundleCustody = createWorkerBundleCustody({
        sql,
        source: createV2HeldArtifactSource({ objects, entries: workerBundleConfig.heldArtifacts }),
      });
      const inspector = createWorkerdWorkerModuleInspector({ binary: artifact.binary });
      let random = 0;
      workflowComposition = createSelfhostV2WorkflowComposition({
        sql,
        clock,
        randomId: () => `workflow-native-${++random}`,
        waitUntil: async (at, signal) => {
          if (signal.aborted) return;
          await Bun.sleep(Math.max(0, at - Date.now()));
        },
        targetKey: TARGET,
        ownerForWorkerUid: activeWorkerComposition.ownerForWorkerUid,
        bundleCustody,
        inspector,
        guardBinary: guard as string,
        workerdBinary: artifact.binary,
        maximumRegistrations: 4,
        temporaryRoot: root,
      });
      const activeWorkflowComposition = workflowComposition;
      const app = buildApp({
        sql,
        objects,
        clock,
        identity,
        settlement: {
          async verify() {
            throw new Error("not configured");
          },
        },
        publicOrigin: ORIGIN,
        forms: [],
        hostForms: [],
        driver: new InMemoryTakoformResourceDriver(),
        offerings: [],
        v2: config,
        v2FormFactory(context) {
          return {
            ...activeWorkerComposition.internalFormFactory(context),
            [DURABLE_WORKFLOW_FORM_URL]: activeWorkflowComposition.form,
          };
        },
      });
      const request = (
        path: string,
        method = "GET",
        body?: unknown,
        idempotencyKey?: string,
        generation?: number,
      ) =>
        app.fetch(
          new Request(`${ORIGIN}${API}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${apiKey.secret}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
              ...(generation === undefined
                ? {}
                : { "takoform-expected-generation": String(generation) }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const create = async (form: string, name: string, spec: Record<string, unknown>) => {
        const response = await request(
          "/resources",
          "POST",
          { form, space: organization.id, name, spec },
          `create-${name}-workflow-native`,
        );
        if (response.status !== 202)
          throw new Error(`create ${name} failed (${response.status}): ${await response.text()}`);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        return accepted;
      };
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: MANIFEST_URL, sha256: manifestSha },
      });
      const version = await create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
        vars: { SETTING: "selected" },
      });
      await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: worker.resourceUid },
      });
      const workflow = await create(DURABLE_WORKFLOW_FORM_URL, "workflow", {
        worker: { resourceUid: worker.resourceUid },
        className: "ReportWorkflow",
      });
      const scope = {
        tenantId: `org:${organization.id}`,
        workflowResourceUid: workflow.resourceUid,
      };
      await activeWorkflowComposition.runtime.instances.create(scope, {
        id: "native-instance",
        params: { value: 7 },
      });
      expect(await activeWorkflowComposition.runtime.runOne(scope, "native-instance")).toEqual({
        kind: "parked",
      });
      expect(
        await activeWorkflowComposition.runtime.instances.status(scope, "native-instance"),
      ).toMatchObject({
        status: "sleeping",
      });
      expect(
        database
          .query(
            "SELECT name, kind, state, result_json FROM tf_workflow_steps WHERE tenant_id = ? AND workflow_resource_uid = ? ORDER BY name",
          )
          .all(scope.tenantId, scope.workflowResourceUid),
      ).toMatchObject([
        {
          name: "memo",
          kind: "do",
          state: "complete",
          result_json: '{"value":"selected","input":7}',
        },
        { name: "zero", kind: "sleep" },
      ]);
      expect(await activeWorkflowComposition.runtime.runOne(scope, "native-instance")).toEqual({
        kind: "complete",
        output: {
          first: { value: "selected", input: 7 },
          replayed: { value: "selected", input: 7 },
          instance: "native-instance",
        },
      });
      expect(
        database
          .query(
            "SELECT name, kind, state, result_json FROM tf_workflow_steps WHERE tenant_id = ? AND workflow_resource_uid = ? ORDER BY name",
          )
          .all(scope.tenantId, scope.workflowResourceUid),
      ).toEqual([]);
      expect((await request(`/resources/${workflow.resourceUid}`)).status).toBe(200);
      const servingOwner = await activeWorkerComposition.ownerForWorkerUid(worker.resourceUid);
      const servingResponse = await servingOwner.fetch(
        new Request(`https://worker-${endpoint.resourceUid.slice(0, 8)}.example.test/`),
      );
      expect(servingResponse.status).toBe(200);
      expect(await servingResponse.text()).toBe("worker-serving");
      const deleted = await request(
        `/resources/${workflow.resourceUid}`,
        "DELETE",
        undefined,
        "delete-workflow-native",
        1,
      );
      expect(deleted.status).toBe(202);
      expect(await app.tickTakoformV2()).toMatchObject({ status: "succeeded", effect: "complete" });
      expect((await request(`/resources/${workflow.resourceUid}`)).status).toBe(410);
    } catch (error) {
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await workflowComposition?.host.close();
      await workerComposition?.suspendOwnersRetainingCustody();
      await workerComposition?.closePrivateBindingServices();
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError === undefined) {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
    if (primaryError !== undefined && cleanupError !== undefined)
      throw new AggregateError([primaryError, cleanupError], "native Workflow and cleanup failed");
    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
  },
  60_000,
);
