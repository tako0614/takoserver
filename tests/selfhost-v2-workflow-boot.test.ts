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
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const TARGET = "selfhost-v2-workflow-boot-test";
const artifactBinary = nativeEvidenceBinary("workerd-artifact");
const guardBinary = nativeEvidenceBinary(
  "workerd-artifact",
  "TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY",
);

test("normal Worker factory mounts Workflow only with the same trusted guarded boot", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-workflow-boot-"));
  const database = new Database(join(root, "host.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    const config = {
      cursorSigningKey: new Uint8Array(32).fill(0x52),
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
      workerBundle: { targetKey: TARGET, heldArtifacts: [] },
    };
    const workerOptions = {
      sql,
      objects,
      clock,
      config,
      rootDirectory: join(root, "worker-owners"),
      targetKey: TARGET,
      // This test exercises composition and Form registration, not native
      // serving. No operation is admitted and no child is spawned.
      workerdBinary: process.execPath,
    };
    const withoutBoot = createSelfhostV2WorkerComposition(workerOptions);
    await withoutBoot.restoreOwners();
    const absent = withoutBoot.internalFormFactory({ sql, objects, clock });
    expect(absent[DURABLE_WORKFLOW_FORM_URL]).toBeUndefined();
    expect(absent[WORKER_VERSION_FORM_URL]).toBeDefined();

    const boot = createSelfhostV2WorkflowBoot({
      sql,
      clock,
      targetKey: TARGET,
      randomId: () => crypto.randomUUID(),
      waitUntil: async () => {},
      guardBinary: process.execPath,
      workerdBinary: process.execPath,
      maximumRegistrations: 2,
      privateSocketDirectory: join(root, "workflow-private-sockets"),
      temporaryRoot: root,
    });
    const withBoot = createSelfhostV2WorkerComposition({
      ...workerOptions,
      rootDirectory: join(root, "workflow-worker-owners"),
      v2Workflow: boot,
    });
    await withBoot.restoreOwners();
    const mounted = withBoot.internalFormFactory({ sql, objects, clock });
    expect(mounted[DURABLE_WORKFLOW_FORM_URL]?.backend.id).toBe("selfhost-v2-durable-workflow-v1");
    expect(mounted[DURABLE_WORKFLOW_FORM_URL]?.backend.targetKey).toBe(TARGET);
    expect(
      mounted[DURABLE_WORKFLOW_FORM_URL]?.references?.({
        worker: { resourceUid: "worker-one" },
        className: "ExampleWorkflow",
      }),
    ).toEqual([
      {
        resourceUid: "worker-one",
        formUrl: MODULE_WORKER_FORM_URL,
        readiness: "observed",
      },
    ]);
    await withBoot.closeWorkflowHost();
    await withBoot.suspendOwnersRetainingCustody();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow boot rejects a mismatched graph or native binary before Form registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-workflow-mismatch-"));
  const database = new Database(join(root, "host.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const clock = () => new Date();
    const boot = createSelfhostV2WorkflowBoot({
      sql,
      clock,
      targetKey: TARGET,
      randomId: () => crypto.randomUUID(),
      waitUntil: async () => {},
      guardBinary: process.execPath,
      workerdBinary: process.execPath,
      maximumRegistrations: 1,
      privateSocketDirectory: join(root, "private-sockets"),
    });
    expect(() =>
      createSelfhostV2WorkerComposition({
        sql,
        objects: createMemoryObjectStore(),
        clock,
        config: {
          cursorSigningKey: new Uint8Array(32).fill(0x52),
          documentation: "https://docs.example.test/v2",
          authenticationDocumentation: "https://docs.example.test/v2/authentication",
          workerBundle: { targetKey: TARGET, heldArtifacts: [] },
        },
        rootDirectory: join(root, "worker-owners"),
        targetKey: TARGET,
        workerdBinary: join(root, "different-binary"),
        v2Workflow: boot,
      }),
    ).toThrow("v2 Workflow boot must use one exact Worker composition");

    let closeAttempts = 0;
    const composition = createSelfhostV2WorkerComposition({
      sql,
      objects: createMemoryObjectStore(),
      clock,
      config: {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: { targetKey: TARGET, heldArtifacts: [] },
      },
      rootDirectory: join(root, "retry-owners"),
      targetKey: TARGET,
      workerdBinary: process.execPath,
      v2Workflow: {
        prepare(input) {
          const prepared = boot.prepare(input);
          return {
            ...prepared,
            async close() {
              closeAttempts++;
              if (closeAttempts === 1) throw new Error("guard stop not proved");
              await prepared.close();
            },
          };
        },
      },
    });
    await composition.restoreOwners();
    await expect(composition.suspendOwnersRetainingCustody()).rejects.toThrow(
      "guard stop not proved",
    );
    await expect(composition.suspendOwnersRetainingCustody()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(artifactBinary === undefined || guardBinary === undefined)(
  "normal org HTTP accepts a Workflow and its sealed WorkerVersion Binding through one boot",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-workflow-boot-http-"));
    const database = new Database(join(root, "host.sqlite"));
    let composition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    try {
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const objects = createMemoryObjectStore();
      const clock = () => new Date();
      const selected = await selectClosedGraphWorkerd({
        binary: artifactBinary,
        privateRoot: join(root, "selected-workerd"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "pinned Workerd unavailable");
      const moduleUrl = "https://artifacts.example.test/workflow-boot/index.mjs";
      const manifestUrl = "https://artifacts.example.test/workflow-boot/manifest.json";
      const module = new TextEncoder().encode(`
export class ExampleWorkflow { async run() { return "ok"; } }
export default { fetch() { return new Response("ok"); } };
`);
      const moduleSha = (await bytesDigest(module)).slice(7);
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: moduleUrl,
              sha256: moduleSha,
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const manifestSha = (await bytesDigest(manifest)).slice(7);
      await objects.create("workflow-boot/module", module);
      await objects.create("workflow-boot/manifest", manifest);
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
        assertion: "workflow-boot-owner",
      });
      const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({ actor, name: "Workflow boot org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "workflow boot writer",
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
              url: manifestUrl,
              sha256: manifestSha,
              objectKey: "workflow-boot/manifest",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
            {
              url: moduleUrl,
              sha256: moduleSha,
              objectKey: "workflow-boot/module",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
          ],
        },
      };
      const boot = createSelfhostV2WorkflowBoot({
        sql,
        clock,
        targetKey: TARGET,
        randomId: () => crypto.randomUUID(),
        waitUntil: async (epochMs, signal) => {
          if (!signal.aborted) await Bun.sleep(Math.max(0, epochMs - Date.now()));
        },
        guardBinary: guardBinary as string,
        workerdBinary: selected.binary,
        maximumRegistrations: 2,
        privateSocketDirectory: join(root, "workflow-private-sockets"),
        temporaryRoot: root,
      });
      composition = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config,
        rootDirectory: join(root, "worker-owners"),
        targetKey: TARGET,
        workerdBinary: selected.binary,
        v2Workflow: boot,
      });
      await composition.restoreOwners();
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
        publicOrigin: "https://api.example.test",
        forms: [],
        hostForms: [],
        driver: new InMemoryTakoformResourceDriver(),
        offerings: [],
        v2: config,
        v2FormFactory: composition.internalFormFactory,
      });
      const create = async (form: string, name: string, spec: Record<string, unknown>) => {
        const response = await app.fetch(
          new Request("https://api.example.test/apis/forms.takoform.com/v2/resources", {
            method: "POST",
            headers: {
              authorization: `Bearer ${key.secret}`,
              "content-type": "application/json",
              "idempotency-key": `workflow-boot-${name}`,
            },
            body: JSON.stringify({ form, space: organization.id, name, spec }),
          }),
        );
        if (response.status !== 202)
          throw new Error(`create ${name} failed (${response.status}): ${await response.text()}`);
        const operation = (await response.json()) as { id: string; resourceUid: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: operation.id,
          status: "succeeded",
          effect: "complete",
        });
        return operation;
      };
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: manifestUrl, sha256: manifestSha },
      });
      const source = {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
      };
      const version = await create(WORKER_VERSION_FORM_URL, "version", source);
      await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      const workflow = await create(DURABLE_WORKFLOW_FORM_URL, "workflow", {
        worker: { resourceUid: worker.resourceUid },
        className: "ExampleWorkflow",
      });
      const bound = await create(WORKER_VERSION_FORM_URL, "bound-version", {
        ...source,
        workflowBindings: [{ name: "FLOW", resource: { resourceUid: workflow.resourceUid } }],
      });
      expect(bound.resourceUid).not.toBe(version.resourceUid);
      expect(
        database
          .query(
            `SELECT refs.target_uid, refs.form_url, refs.readiness, sets.sealed
               FROM tf_v2_operation_references refs
               JOIN tf_v2_operation_reference_sets sets ON sets.operation_id = refs.operation_id
               WHERE refs.operation_id = ? AND refs.target_uid = ?`,
          )
          .get(bound.id, workflow.resourceUid),
      ).toEqual({
        target_uid: workflow.resourceUid,
        form_url: DURABLE_WORKFLOW_FORM_URL,
        readiness: "observed",
        sealed: 1,
      });
    } finally {
      await composition?.closeWorkflowHost();
      await composition?.suspendOwnersRetainingCustody();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
