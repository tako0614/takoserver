import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "../src/ports.ts";
import { workerdV2PrivateWorkflowBindingName } from "../src/providers/workerd-v2-private-binding-names.ts";
import { createV2WorkflowForwardBoot } from "../src/takoform-v2/workflow-binding-boot.ts";
import { projectV2WorkflowForward } from "../src/takoform-v2/workflow-binding-projection.ts";
import type { WorkerdWorkflowForwardPublication } from "../src/workerd-runtime.ts";
import type { WorkflowRuntime } from "../src/workflow-execution.ts";

const OPERATION = "01234567-89ab-4cde-8f01-23456789abcd";
const VERSION_OPERATION = "11234567-89ab-4cde-8f01-23456789abcd";
const versionUid = "version-one";
const versionId = `v2-${createHash("sha256").update(`${versionUid}\u00001`).digest("hex")}`;
const versionSpec = {
  worker: { resourceUid: "worker-one" },
  bundle: { resourceUid: "bundle-one" },
  handlers: ["fetch"],
  workflowBindings: [{ name: "FLOW", resource: { resourceUid: "workflow-one" } }],
};

function call(socketPath: string, token: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/__takoserver/workflow-binding/v1/create",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-takoserver-private-workflow-binding-token": token,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: bytes ? JSON.parse(bytes) : null });
        });
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

test("owner-pinned v2 Workflow socket dispatches via existing facade only while the accepted relation is current", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-wfb-"));
  let current = true;
  let creates = 0;
  const sql = {
    async query(query: string) {
      if (query.includes("FROM tf_v2_resources"))
        return [
          {
            spec_json: JSON.stringify(versionSpec),
            backend_id: "test-backend",
            generation: 1,
            principal: "org:one",
            space: "production",
          },
        ];
      if (query.includes("FROM tf_v2_operations"))
        return [{ id: VERSION_OPERATION, generation: 1 }];
      throw new Error("unrecognized SQL");
    },
  } as unknown as Sql;
  const instances = {
    async create(scope: { tenantId: string; workflowResourceUid: string }) {
      expect(scope).toEqual({ tenantId: "org:one", workflowResourceUid: "workflow-one" });
      creates++;
      return { id: `instance-${creates}`, status: "queued" as const };
    },
    async get() {
      throw new Error("unexpected get");
    },
    async status() {
      throw new Error("unexpected status");
    },
    async sendEvent() {
      throw new Error("unexpected sendEvent");
    },
    async terminate() {
      throw new Error("unexpected terminate");
    },
  } as unknown as WorkflowRuntime["instances"];
  try {
    const boot = createV2WorkflowForwardBoot({
      sql,
      targetKey: "target-one",
      privateSocketDirectory: root,
      instances,
      authority: {
        async resolveCurrentBinding(claim, name) {
          return current &&
            name === "FLOW" &&
            claim.principal === "org:one" &&
            claim.workerVersionOperationId === VERSION_OPERATION &&
            claim.nativeVersionId === versionId
            ? {
                tenantId: "org:one",
                workflowResourceUid: "workflow-one",
                workerUid: "worker-one",
                vector: "settled-vector",
              }
            : null;
        },
      },
    });
    const incarnation = boot.openIncarnation({
      workerUid: "worker-one",
      sourceOperationId: OPERATION,
      scriptName: "script-one",
      eventToken: "b".repeat(64),
    });
    try {
      const claim = {
        principal: "org:one",
        space: "production",
        targetKey: "target-one",
        workerUid: "worker-one",
        workerVersionUid: versionUid,
        workerVersionOperationId: VERSION_OPERATION,
        nativeVersionId: versionId,
        bindings: [{ name: "FLOW", resourceUid: "workflow-one" }],
      };
      const grant = await incarnation.issueBinding(claim, "FLOW");
      expect(grant).not.toBeNull();
      if (!grant) throw new Error("grant unavailable");
      const projection = await projectV2WorkflowForward({
        workerUid: "worker-one",
        versionUid,
        sourceOperationId: VERSION_OPERATION,
        nativeVersionId: versionId,
        principal: "org:one",
        declarations: versionSpec.workflowBindings,
        grants: [grant],
      });
      const publication: WorkerdWorkflowForwardPublication = {
        script: "script-one",
        workerResourceUid: "worker-one",
        versionId,
        workerVersionResourceUid: versionUid,
        snapshotDigest: projection.snapshotDigest,
        bindings: [{ ...grant, serviceName: workerdV2PrivateWorkflowBindingName(0) }],
      };
      await expect(
        incarnation.workflowForwardLifecycle.reserve([
          { ...publication, snapshotDigest: `sha256:${"0".repeat(64)}` },
        ]),
      ).rejects.toThrow();
      expect(incarnation.workflowForwardSockets([publication])).toHaveLength(0);
      const lease = await incarnation.workflowForwardLifecycle.reserve([publication]);
      expect(incarnation.workflowForwardSockets([publication])).toHaveLength(1);
      expect(incarnation.workflowForwardLifecycle.activated([publication])).toBe(true);
      expect(incarnation.workflowForwardLifecycle.isRestored()).toBe(true);
      const socket = incarnation.workflowForwardSockets([publication])[0];
      if (!socket) throw new Error("socket unavailable");
      expect(await call(socket.socketPath, grant.token)).toMatchObject({
        status: 200,
        body: { value: { id: "instance-1", status: "queued" } },
      });
      current = false;
      expect(await call(socket.socketPath, grant.token)).toMatchObject({ status: 503 });
      expect(creates).toBe(1);
      incarnation.workflowForwardLifecycle.uncertain();
      expect(incarnation.workflowForwardLifecycle.isRestored()).toBe(false);
      await lease.release();
    } finally {
      await incarnation.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted three-Version graph opens all 192 Workflow brokers, above the former arbitrary cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-wfb-many-"));
  const specifications = new Map<
    string,
    {
      readonly operationId: string;
      readonly spec: typeof versionSpec;
    }
  >();
  for (let version = 1; version <= 3; version++) {
    const uid = `version-${version}`;
    specifications.set(uid, {
      operationId: `${version}1234567-89ab-4cde-8f01-23456789abcd`,
      spec: {
        ...versionSpec,
        workflowBindings: Array.from({ length: 64 }, (_, index) => ({
          name: `FLOW_${index.toString().padStart(2, "0")}`,
          resource: { resourceUid: `workflow-${version}-${index}` },
        })),
      },
    });
  }
  const sql = {
    async query(query: string, params: readonly unknown[]) {
      const uid = params[0];
      const source = typeof uid === "string" ? specifications.get(uid) : undefined;
      if (!source) return [];
      if (query.includes("FROM tf_v2_resources"))
        return [
          {
            spec_json: JSON.stringify(source.spec),
            backend_id: "test-backend",
            generation: 1,
            principal: "org:one",
            space: "production",
          },
        ];
      if (query.includes("FROM tf_v2_operations"))
        return [{ id: source.operationId, generation: 1 }];
      throw new Error("unrecognized SQL");
    },
  } as unknown as Sql;
  const instances = {
    async create() {
      throw new Error("unexpected create");
    },
    async get() {
      throw new Error("unexpected get");
    },
    async status() {
      throw new Error("unexpected status");
    },
    async sendEvent() {
      throw new Error("unexpected sendEvent");
    },
    async terminate() {
      throw new Error("unexpected terminate");
    },
  } as unknown as WorkflowRuntime["instances"];
  try {
    const boot = createV2WorkflowForwardBoot({
      sql,
      targetKey: "target-one",
      privateSocketDirectory: root,
      instances,
      authority: {
        async resolveCurrentBinding(claim, name) {
          const selected = claim.bindings.find((binding) => binding.name === name);
          if (!selected) return null;
          return {
            tenantId: claim.principal,
            workflowResourceUid: selected.resourceUid,
            workerUid: claim.workerUid,
            vector: `current:${selected.resourceUid}`,
          };
        },
      },
    });
    const incarnation = boot.openIncarnation({
      workerUid: "worker-one",
      sourceOperationId: OPERATION,
      scriptName: "script-one",
      eventToken: "c".repeat(64),
    });
    try {
      const publications: WorkerdWorkflowForwardPublication[] = [];
      for (const [uid, source] of specifications) {
        const nativeVersionId = `v2-${createHash("sha256").update(`${uid}\u00001`).digest("hex")}`;
        const declarations = source.spec.workflowBindings;
        const claim = {
          principal: "org:one",
          space: "production",
          targetKey: "target-one",
          workerUid: "worker-one",
          workerVersionUid: uid,
          workerVersionOperationId: source.operationId,
          nativeVersionId,
          bindings: declarations.map((binding) => ({
            name: binding.name,
            resourceUid: binding.resource.resourceUid,
          })),
        };
        const grants = [];
        for (const binding of declarations) {
          const grant = await incarnation.issueBinding(claim, binding.name);
          if (!grant) throw new Error("Workflow grant unavailable");
          grants.push(grant);
        }
        const projection = await projectV2WorkflowForward({
          workerUid: "worker-one",
          versionUid: uid,
          sourceOperationId: source.operationId,
          nativeVersionId,
          principal: "org:one",
          declarations,
          grants,
        });
        publications.push({
          script: "script-one",
          workerResourceUid: "worker-one",
          versionId: nativeVersionId,
          workerVersionResourceUid: uid,
          snapshotDigest: projection.snapshotDigest,
          bindings: grants.map((grant, index) => ({
            ...grant,
            serviceName: workerdV2PrivateWorkflowBindingName(index),
          })),
        });
      }
      const lease = await incarnation.workflowForwardLifecycle.reserve(publications);
      expect(incarnation.workflowForwardSockets(publications)).toHaveLength(192);
      expect(incarnation.workflowForwardLifecycle.activated(publications)).toBe(true);
      await lease.release();
    } finally {
      await incarnation.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
