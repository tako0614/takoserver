import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { TAKOFORM_APPLY_SELECTION_VERSION } from "../src/takoform/apply-selection.ts";
import { createTakoformArtifacts } from "../src/takoform/artifacts.ts";
import { installedBindings } from "../src/takoform/bindings.ts";
import { createTakoformEngine, type EngineContext } from "../src/takoform/engine.ts";
import { installedForms } from "../src/takoform/forms.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import type { TakoformResourceDriver } from "../src/takoform/types.ts";
import {
  actorForm,
  fixture,
  insert,
  resource,
  scope,
  workerForm,
} from "./helpers/actor-resource-fixture.ts";

const tenantId = scope.tenantId;
const siblingUid = "namespace-uid-sibling";
const foreignTenant = "tenant-actor-foreign";
const allForms = stableProductionTakoformCatalog().forms;
const forms = installedForms(
  allForms.filter((form) =>
    ["ActorNamespace", "ModuleWorker"].includes(form.identity.formRef.kind),
  ),
  "forms.takoform.com/v1",
);
const offering: ProviderOffering = {
  id: "selfhost.edge.actornamespace",
  kind: "takoform.ActorNamespace",
  displayName: "Actor Namespace",
  form: actorForm.identity.formRef,
  providedInterfaces: actorForm.providedInterfaces ?? [],
  bindingRefs: [],
  capabilities: ["create", "delete", "import", "observe"],
};

function actorIdentity(name: string, uid: string) {
  return { tenantRef: tenantId, space: "default", name, uid };
}

function namespaceKey(tenant: string, uid: string): string {
  return createHash("sha256")
    .update(JSON.stringify([tenant, uid]))
    .digest("hex");
}

async function seedOpaqueNamespaceBytes(storageRoot: string, tenant: string, uid: string) {
  const directory = join(storageRoot, "namespaces", namespaceKey(tenant, uid));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "fixture-private-bytes.bin"), "local deletion fixture", {
    mode: 0o600,
  });
  return directory;
}

test("Store deletion tombstone gates Provider cleanup and preserves exact Actor custody", async () => {
  let root: string | undefined;
  let ownedDatabase: ReturnType<typeof fixture>["database"] | undefined;
  let ownedOwner: ReturnType<typeof createSelfhostActorExecutionHost> | undefined;
  try {
    const f = fixture();
    ownedDatabase = f.database;
    const fixtureRoot = await mkdtemp(join(tmpdir(), "actor-store-provider-delete-"));
    root = fixtureRoot;
    const storageRoot = join(fixtureRoot, "actor-state");
    let failBeforeStorageDelete = false;
    const deletionTransitions: string[] = [];
    const providerDeleteCalls: string[] = [];

    await f.deployments.create({
      tenantId,
      id: "deployment-worker",
      resourceUid: f.target.metadata.uid,
      offeringId: "worker-local",
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
      nativeId: "selfhost-worker:worker:operation-1",
      state: "active",
      observed: {},
      outputs: { scriptName: "worker" },
    });
    const sibling = resource(actorForm, "counter-sibling", siblingUid);
    insert(f.database, sibling, [f.relation]);
    for (const uid of [scope.namespaceResourceUid, siblingUid]) {
      f.database
        .query(
          `UPDATE tf_resource_deletion_attestations
         SET form_ref_json = ? WHERE tenant_id = ? AND resource_uid = ?`,
        )
        .run(canonicalJson(actorForm.identity.formRef), tenantId, uid);
    }

    const owner = createSelfhostActorExecutionHost({
      runtimeRoot: join(fixtureRoot, "runtime"),
      storageRoot,
      binary: "/unused-workerd-for-registration-only",
      graph: f.read,
      deployments: f.deployments,
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
      async beforeNamespaceStorageDelete() {
        if (failBeforeStorageDelete) {
          failBeforeStorageDelete = false;
          throw new Error("injected local storage cleanup refusal");
        }
      },
    });
    ownedOwner = owner;
    const nativeRuntime = {
      async inspectModule() {
        return { outcome: "valid" as const, exportedHandlers: [] };
      },
      async write() {},
      async remove() {},
      async reload() {},
      async has() {
        return false;
      },
    };
    const provider = createSelfhostProvider({
      id: "selfhost",
      offerings: [offering],
      dataRoot: join(fixtureRoot, "provider-data"),
      runtime: nativeRuntime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
      actorNamespace: owner,
    });

    const providerRelations = async (
      storedRelations: readonly {
        pointer: string;
        relation: string;
        targetUid: string;
        targetApiVersion: string;
        targetKind: string;
        targetName: string;
        targetFormRef: typeof workerForm.identity.formRef;
      }[],
    ): Promise<ProviderRelation[]> =>
      await Promise.all(
        storedRelations.map(async (relation) => {
          const worker = await f.store.readResource({
            tenantId,
            space: "default",
            apiVersion: relation.targetApiVersion,
            kind: relation.targetKind,
            name: relation.targetName,
          });
          const deployment = await f.deployments.active(tenantId, relation.targetUid);
          if (!worker || !deployment) throw new Error("test Worker relation is not deployed");
          return {
            pointer: relation.pointer,
            relation: relation.relation,
            targetUid: relation.targetUid,
            resource: {
              apiVersion: worker.apiVersion,
              kind: worker.kind,
              form: { formRef: structuredClone(worker.form.formRef) },
              metadata: {
                name: worker.metadata.name,
                space: worker.metadata.space,
                uid: worker.metadata.uid,
                generation: worker.metadata.generation,
                revision: worker.metadata.revision,
              },
              spec: structuredClone(worker.spec),
            },
            deployment: {
              tenantId: deployment.tenantId,
              id: deployment.id,
              resourceUid: deployment.resourceUid,
              offeringId: deployment.offeringId,
              providerPackRef: deployment.providerPackRef,
              providerInstallationRef: deployment.providerInstallationRef,
              nativeId: deployment.nativeId,
              state: deployment.state,
              observed: structuredClone(deployment.observed),
              outputs: structuredClone(deployment.outputs),
              createdAt: deployment.createdAt,
              updatedAt: deployment.updatedAt,
            },
          };
        }),
      );

    const register = async (name: string, uid: string) => {
      const identity = actorIdentity(name, uid);
      const storedRelations = await f.store.readRelations({
        tenantId,
        space: identity.space,
        apiVersion: actorForm.identity.formRef.apiVersion,
        kind: "ActorNamespace",
        name,
      });
      const ticket = await provider.apply({
        operationId: `register-${uid}`,
        operationMode: "initial",
        offering,
        identity,
        spec: {
          className: "Counter",
          worker: {
            apiVersion: workerForm.identity.formRef.apiVersion,
            kind: "ModuleWorker",
            name: "worker",
          },
        },
        relations: await providerRelations(storedRelations),
      });
      expect(ticket.phase).toBe("succeeded");
      return identity;
    };

    const engineDriver: TakoformResourceDriver = {
      async selectApply() {
        return { version: TAKOFORM_APPLY_SELECTION_VERSION, kind: "intrinsic" };
      },
      async apply() {
        return {};
      },
      async observe() {
        return {};
      },
      async delete(input) {
        const tombstone = await f.store.readResourceDeletion(input.tenantId, input.resourceUid);
        deletionTransitions.push(tombstone?.state ?? "missing");
        expect(tombstone?.state).toBe("pending");
        expect(tombstone?.effects.some((effect) => effect.phase === "dispatched")).toBe(true);
        expect(
          await owner.readCurrentGraph(
            { tenantId: input.tenantId, namespaceResourceUid: input.resourceUid },
            AbortSignal.timeout(1_000),
          ),
        ).toBeNull();
        const identity = {
          tenantRef: input.tenantId,
          space: input.resource.metadata.space,
          name: input.resource.metadata.name,
          uid: input.resourceUid,
        };
        providerDeleteCalls.push(`${identity.tenantRef}:${identity.uid}`);
        const ticket = await provider.delete({
          operationId: input.operationId,
          ...(input.operationMode ? { operationMode: input.operationMode } : {}),
          offering,
          nativeId: `selfhost-actor:${input.resourceUid}`,
          identity,
          spec: input.resource.spec,
          relations: await providerRelations(
            input.relations.map((relation) => ({
              pointer: relation.pointer,
              relation: relation.relation,
              targetUid: relation.targetUid,
              targetApiVersion: relation.resource.apiVersion,
              targetKind: relation.resource.kind,
              targetName: relation.resource.metadata.name,
              targetFormRef: relation.resource.form.formRef,
            })),
          ),
        });
        if (ticket.phase !== "succeeded") {
          throw new Error("Actor owner cleanup was not acknowledged");
        }
        return { observed: { deleted: true } };
      },
    };
    const engine = createTakoformEngine({
      store: f.store,
      forms,
      bindings: installedBindings([]),
      driver: engineDriver,
      artifacts: createTakoformArtifacts({
        sql: (await import("../src/sql-sqlite.ts")).createSqliteSql(f.database),
        objects: createMemoryObjectStore(),
        clock: () => new Date(),
        randomId: () => "artifact-op",
      }),
      clock: () => new Date(),
      randomId: (() => {
        let sequence = 0;
        return () => `operation-${++sequence}`;
      })(),
    });

    const remove = async (name: string, uid: string, key: string) => {
      const request = new Request(
        `https://host.test/apis/forms.takoform.com/v1/resources/${actorForm.identity.formRef.apiVersion}/ActorNamespace/${name}?space=default&definitionVersion=${actorForm.identity.formRef.definitionVersion}&schemaDigest=${actorForm.identity.formRef.schemaDigest}`,
        {
          method: "DELETE",
          headers: {
            "idempotency-key": key,
            "takoform-expected-generation": "3",
          },
        },
      );
      const context: EngineContext = {
        request,
        url: new URL(request.url),
        tenantId,
        principalId: "principal-local-test",
        expectedResourceUid: uid,
      };
      return await engine.remove(context, {
        apiVersion: actorForm.identity.formRef.apiVersion,
        kind: "ActorNamespace",
        name,
      });
    };

    const actorStorage = await seedOpaqueNamespaceBytes(
      storageRoot,
      tenantId,
      scope.namespaceResourceUid,
    );
    const siblingStorage = await seedOpaqueNamespaceBytes(storageRoot, tenantId, siblingUid);
    const foreignStorage = await seedOpaqueNamespaceBytes(
      storageRoot,
      foreignTenant,
      scope.namespaceResourceUid,
    );
    const ownerScopeForForeignTenant = {
      tenantId: foreignTenant,
      namespaceResourceUid: scope.namespaceResourceUid,
    };
    await owner.ready;
    await register("counter", scope.namespaceResourceUid);
    await register("counter-sibling", siblingUid);
    await owner.registerNamespace(ownerScopeForForeignTenant);
    const actorDescriptor = provider.createNativeReadbackDescriptor?.({
      offering,
      identity: actorIdentity("counter", scope.namespaceResourceUid),
      nativeId: `selfhost-actor:${scope.namespaceResourceUid}`,
      spec: {
        className: "Counter",
        worker: {
          apiVersion: workerForm.identity.formRef.apiVersion,
          kind: "ModuleWorker",
          name: "worker",
        },
      },
    });
    const siblingDescriptor = provider.createNativeReadbackDescriptor?.({
      offering,
      identity: actorIdentity("counter-sibling", siblingUid),
      nativeId: `selfhost-actor:${siblingUid}`,
      spec: {
        className: "Counter",
        worker: {
          apiVersion: workerForm.identity.formRef.apiVersion,
          kind: "ModuleWorker",
          name: "worker",
        },
      },
    });
    if (!actorDescriptor || !siblingDescriptor) {
      throw new Error("Actor Provider readback descriptor unavailable");
    }
    expect(
      await owner.hasNamespace({ tenantId, namespaceResourceUid: scope.namespaceResourceUid }),
    ).toBe(true);
    expect(
      await owner.namespaceAbsent({ tenantId, namespaceResourceUid: scope.namespaceResourceUid }),
    ).toBe(false);
    expect(
      await owner.readCurrentGraph(
        { tenantId, namespaceResourceUid: scope.namespaceResourceUid },
        AbortSignal.timeout(1_000),
      ),
    ).not.toBeNull();

    const first = await remove("counter", scope.namespaceResourceUid, "delete-counter-1");
    expect(first).toEqual({ kind: "deleted" });
    expect(deletionTransitions).toEqual(["pending"]);
    expect(providerDeleteCalls).toEqual([`${tenantId}:${scope.namespaceResourceUid}`]);
    expect(
      await f.store.readResource({
        tenantId,
        space: "default",
        apiVersion: actorForm.identity.formRef.apiVersion,
        kind: "ActorNamespace",
        name: "counter",
      }),
    ).toBeNull();
    expect((await f.store.readResourceDeletion(tenantId, scope.namespaceResourceUid))?.state).toBe(
      "closed",
    );
    expect(
      await owner.namespaceAbsent({ tenantId, namespaceResourceUid: scope.namespaceResourceUid }),
    ).toBe(true);
    expect(
      await provider.verifyNativeAbsence?.({
        offering,
        descriptor: actorDescriptor,
        target: {
          tenantId,
          resourceUid: scope.namespaceResourceUid,
          incarnationId: "actor-delete-incarnation",
          generation: "3",
        },
      }),
    ).toMatchObject({ outcome: "absent", evidence: { kind: "ActorNamespace" } });
    await expect(readdir(actorStorage)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await owner.hasNamespace({ tenantId, namespaceResourceUid: siblingUid })).toBe(true);
    expect(await readdir(siblingStorage)).toEqual(["fixture-private-bytes.bin"]);
    expect(await owner.hasNamespace(ownerScopeForForeignTenant)).toBe(true);
    expect(await readdir(foreignStorage)).toEqual(["fixture-private-bytes.bin"]);

    expect(await remove("counter", scope.namespaceResourceUid, "delete-counter-1")).toEqual({
      kind: "deleted",
    });
    expect(providerDeleteCalls).toHaveLength(1);
    expect(
      await owner.namespaceAbsent({ tenantId, namespaceResourceUid: scope.namespaceResourceUid }),
    ).toBe(true);
    expect(await owner.hasNamespace({ tenantId, namespaceResourceUid: siblingUid })).toBe(true);
    expect(await owner.hasNamespace(ownerScopeForForeignTenant)).toBe(true);
    expect(await readdir(foreignStorage)).toEqual(["fixture-private-bytes.bin"]);

    failBeforeStorageDelete = true;
    await expect(
      remove("counter-sibling", siblingUid, "delete-counter-sibling-1"),
    ).rejects.toThrow();
    expect(deletionTransitions).toEqual(["pending", "pending"]);
    expect(
      await f.store.readResource({
        tenantId,
        space: "default",
        apiVersion: actorForm.identity.formRef.apiVersion,
        kind: "ActorNamespace",
        name: "counter-sibling",
      }),
    ).not.toBeNull();
    expect((await f.store.readResourceDeletion(tenantId, siblingUid))?.state).toBe("pending");
    expect(await owner.namespaceAbsent({ tenantId, namespaceResourceUid: siblingUid })).toBe(false);
    expect(await readdir(siblingStorage)).toEqual(["fixture-private-bytes.bin"]);
    expect(
      (await lstat(join(storageRoot, "leases", namespaceKey(tenantId, siblingUid)))).isDirectory(),
    ).toBe(true);
    expect(
      await provider.verifyNativeAbsence?.({
        offering,
        descriptor: siblingDescriptor,
        target: {
          tenantId,
          resourceUid: siblingUid,
          incarnationId: "actor-sibling-delete-incarnation",
          generation: "3",
        },
      }),
    ).toMatchObject({ outcome: "present", evidence: { kind: "ActorNamespace" } });
  } finally {
    await ownedOwner?.close();
    ownedDatabase?.close();
    if (root) await rm(root, { recursive: true, force: true });
  }
});
