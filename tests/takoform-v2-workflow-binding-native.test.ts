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
import { createSelfhostV2WorkflowBoot } from "../src/selfhost-v2-workflow-boot.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/takoform-v2/forms/durable-workflow.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const ORIGIN = "https://api.example.test";
const API = "/apis/forms.takoform.com/v2";
const TARGET = "selfhost-v2-workflow-binding-native";
const MANIFEST_URL = "https://artifacts.example.test/workflow-binding/manifest.json";
const MODULE_URL = "https://artifacts.example.test/workflow-binding/index.mjs";
const workerd = nativeEvidenceBinary("workerd-artifact");
const guard = nativeEvidenceBinary(
  "workerd-artifact",
  "TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY",
);

// This exercises a real native guarded class and selected broker, not public
// TLS or an operator deployment. Endpoint observation is fixture-local.
test.skipIf(workerd === undefined || guard === undefined)(
  "accepted v2 Workflow Binding reaches a child from a guarded native class",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-v2-workflow-binding-native-"));
    const database = new Database(join(root, "host.sqlite"));
    let composition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
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
export class ChildWorkflow {
  async run(event) { return { value: event.params.value, origin: "guarded-child" }; }
}
export class ParentWorkflow {
  constructor(env) { this.env = env; }
  async run(event) {
    const id = "child-from-parent";
    const created = await this.env.CHILD.create({ id, params: { value: event.params.value } });
    const fetched = await this.env.CHILD.get(id);
    const status = await fetched.status();
    return { created: created.id, fetched: fetched.id, status: status.status };
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/create") {
      const created = await env.PARENT.create({ id: "parent-from-fetch", params: { value: 42 } });
      return Response.json({ id: created.id, status: (await created.status()).status });
    }
    const fetched = await env.PARENT.get("parent-from-fetch");
    return Response.json({ id: fetched.id, status: (await fetched.status()).status });
  }
};
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
      await objects.create("workflow-binding/manifest", manifest);
      await objects.create("workflow-binding/module", module);
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
      const session = await accounts.signIn({
        provider: "google",
        assertion: "workflow-binding-owner",
      });
      const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({
        actor,
        name: "Workflow binding org",
      });
      const apiKey = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Workflow binding writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      const config = {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: {
          targetKey: TARGET,
          heldArtifacts: [
            {
              url: MANIFEST_URL,
              sha256: manifestSha,
              objectKey: "workflow-binding/manifest",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
            {
              url: MODULE_URL,
              sha256: moduleSha,
              objectKey: "workflow-binding/module",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
          ],
        },
      };
      // The native broker owns a nested w-XXXXXX/22-hex Unix socket; keep the
      // test-local root below the runtime's strict 100-byte path bound.
      const brokerRoot = join(root, "wf");
      expect(
        Buffer.byteLength(join(brokerRoot, "w-XXXXXX", `${"a".repeat(22)}.sock`)),
      ).toBeLessThan(100);
      const boot = createSelfhostV2WorkflowBoot({
        sql,
        clock,
        targetKey: TARGET,
        randomId: () => crypto.randomUUID(),
        waitUntil: async (at, signal) => {
          if (!signal.aborted) await Bun.sleep(Math.max(0, at - Date.now()));
        },
        guardBinary: guard as string,
        workerdBinary: artifact.binary,
        maximumRegistrations: 4,
        privateSocketDirectory: brokerRoot,
        temporaryRoot: root,
      });
      composition = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config,
        rootDirectory: join(root, "worker-owners"),
        targetKey: TARGET,
        workerdBinary: artifact.binary,
        spawn: (command) =>
          spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" }),
        v2Workflow: boot,
        endpoint: {
          assignHostname({ resourceUid }) {
            return `worker-${resourceUid.slice(0, 8)}.example.test`;
          },
          async observeTls(input) {
            const owner = await composition?.ownerForWorkerUid(input.workerUid);
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
            const owner = await composition?.ownerForWorkerUid(input.workerUid);
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
      const active = composition;
      expect(await active.restoreOwners()).toEqual([]);
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
        v2FormFactory: active.internalFormFactory,
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
          `create-${name}-workflow-binding-native`,
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
      const source = {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
      };
      const unbound = await create(WORKER_VERSION_FORM_URL, "unbound-version", source);
      const deploymentSpec = (versionUid: string) => ({
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const deployment = await create(
        WORKER_DEPLOYMENT_FORM_URL,
        "deployment",
        deploymentSpec(unbound.resourceUid),
      );
      const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: worker.resourceUid },
      });
      const child = await create(DURABLE_WORKFLOW_FORM_URL, "child", {
        worker: { resourceUid: worker.resourceUid },
        className: "ChildWorkflow",
      });
      const parent = await create(DURABLE_WORKFLOW_FORM_URL, "parent", {
        worker: { resourceUid: worker.resourceUid },
        className: "ParentWorkflow",
      });
      const bound = await create(WORKER_VERSION_FORM_URL, "bound-version", {
        ...source,
        workflowBindings: [
          { name: "CHILD", resource: { resourceUid: child.resourceUid } },
          { name: "PARENT", resource: { resourceUid: parent.resourceUid } },
        ],
      });
      const sealedWorkflowRefs = database
        .query(
          `SELECT target_uid, readiness, sealed FROM tf_v2_operation_references refs
           JOIN tf_v2_operation_reference_sets sets ON sets.operation_id = refs.operation_id
           WHERE refs.operation_id = ? AND refs.form_url = ?`,
        )
        .all(bound.id, DURABLE_WORKFLOW_FORM_URL);
      expect(sealedWorkflowRefs).toHaveLength(2);
      expect(sealedWorkflowRefs).toEqual(
        expect.arrayContaining([
          { target_uid: child.resourceUid, readiness: "observed", sealed: 1 },
          { target_uid: parent.resourceUid, readiness: "observed", sealed: 1 },
        ]),
      );
      const update = await request(
        `/resources/${deployment.resourceUid}`,
        "PUT",
        { spec: deploymentSpec(bound.resourceUid) },
        "switch-to-bound-version-native",
        1,
      );
      if (update.status !== 202)
        throw new Error(`deployment update failed (${update.status}): ${await update.text()}`);
      const acceptedUpdate = (await update.json()) as { id: string };
      expect(await app.tickTakoformV2()).toMatchObject({
        id: acceptedUpdate.id,
        status: "succeeded",
        effect: "complete",
      });
      const owner = await active.ownerForWorkerUid(worker.resourceUid);
      const hostname = `worker-${endpoint.resourceUid.slice(0, 8)}.example.test`;
      const parentScope = {
        tenantId: `org:${organization.id}`,
        workflowResourceUid: parent.resourceUid,
      };
      const createdResponse = await owner.fetch(new Request(`https://${hostname}/create`));
      const createdBody = await createdResponse.json();
      if (createdResponse.status !== 200) {
        const rows = database
          .query(
            "SELECT instance_id, status FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = ?",
          )
          .all(parentScope.tenantId, parentScope.workflowResourceUid);
        throw new Error(
          `native Workflow Binding fetch refused: ${JSON.stringify({ status: createdResponse.status, body: createdBody, rows })}`,
        );
      }
      expect({ status: createdResponse.status, body: createdBody }).toEqual({
        status: 200,
        body: { id: "parent-from-fetch", status: "queued" },
      });
      const childScope = { ...parentScope, workflowResourceUid: child.resourceUid };
      expect(await active.runWorkflowOnce(parentScope, "parent-from-fetch")).toEqual({
        kind: "complete",
        output: {
          created: "child-from-parent",
          fetched: "child-from-parent",
          status: "queued",
        },
      });
      expect(
        database
          .query(
            "SELECT instance_id, status FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = ?",
          )
          .all(childScope.tenantId, childScope.workflowResourceUid),
      ).toEqual([{ instance_id: "child-from-parent", status: "queued" }]);
      expect(await active.runWorkflowOnce(childScope, "child-from-parent")).toEqual({
        kind: "complete",
        output: { value: 42, origin: "guarded-child" },
      });
      const statusResponse = await owner.fetch(new Request(`https://${hostname}/read`));
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toEqual({ id: "parent-from-fetch", status: "complete" });
    } catch (error) {
      primaryError = error;
    }
    const cleanupErrors: unknown[] = [];
    try {
      await composition?.closeWorkflowHost();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await composition?.suspendOwnersRetainingCustody();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await composition?.closePrivateBindingServices();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      database.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 0) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
        `native Workflow Binding cleanup incomplete; retained ${root}`,
      );
    if (primaryError !== undefined) throw primaryError;
  },
  90_000,
);
