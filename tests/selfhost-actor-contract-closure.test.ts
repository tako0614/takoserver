import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { resolveSelfhostActorContractClosure } from "../src/selfhost-actor-contract-closure.ts";
import { openSelfhostActorPublicRuntime } from "../src/selfhost-actor-public-runtime.ts";
import {
  createSelfhostComposition,
  hasExactSelfhostActorClosure,
} from "../src/selfhost-composition.ts";
import {
  createSelfhostRuntimeBindingMaterializer,
  SELFHOST_ACTOR_MATERIAL_KIND,
} from "../src/selfhost-runtime-binding-materializer.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { selectTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";
import { fixture, scope } from "./helpers/actor-resource-fixture.ts";

function forwardClosure() {
  const selected = selectTakoformCandidates("actor-forward");
  const actor = selected.forms.find((form) => form.identity.formRef.kind === "ActorNamespace");
  if (!actor?.workerClassRuntime?.runtimeClassRef || !actor.identity.packageDigest)
    throw new Error("exact Actor source missing");
  return {
    stableForms: selected.forms,
    stableBindings: selected.bindings,
    workerClassRuntimeContracts: [
      {
        formRef: actor.identity.formRef,
        packageDigest: actor.identity.packageDigest,
        runtimeClassRef: actor.workerClassRuntime.runtimeClassRef,
      },
    ],
  };
}

test("exact forward Actor declaration requires the complete selected closure and explicit contract", () => {
  // Declaration qualification only: this does not establish inspection,
  // execution, signing, admission, or an available Actor Offering.
  expect(hasExactSelfhostActorClosure(forwardClosure())).toBe(true);
});

test("the verified Actor closure supplies an immutable technical selection without caller aliases", () => {
  const input = forwardClosure();
  const resolved = resolveSelfhostActorContractClosure(input);
  const selection = resolved?.providerBinding;
  expect(selection).toBeDefined();
  if (!selection) throw new Error("verified technical Actor selection missing");
  const saved = structuredClone(selection);
  const worker = input.stableForms.find((form) => form.identity.formRef.kind === "ModuleWorker");
  const contract = input.workerClassRuntimeContracts[0];
  const binding = input.stableBindings.find(
    (item) => item.bindingRef.name === "module-worker.actor",
  );
  if (!worker || !contract || !binding) throw new Error("source closure missing");
  Object.assign(worker.identity.formRef, { schemaDigest: `sha256:${"0".repeat(64)}` });
  Object.assign(contract, { packageDigest: `sha256:${"0".repeat(64)}` });
  Object.assign(binding.bindingRef, { schemaDigest: `sha256:${"0".repeat(64)}` });
  expect(selection).toEqual(saved);
  expect(Object.isFrozen(selection)).toBe(true);
  expect(Object.isFrozen(selection.bindingRef)).toBe(true);
  expect(Object.isFrozen(selection.contract)).toBe(true);
  expect(Object.isFrozen(selection.contract.formRef)).toBe(true);
  expect(Object.isFrozen(selection.contract.runtimeClassRef)).toBe(true);
  expect(Object.isFrozen(selection.workerFormRef)).toBe(true);
  expect(Object.isFrozen(selection.versionFormRef)).toBe(true);
});

test("published Actor declarations remain management-only with an explicit legacy contract", () => {
  const published = currentTakoformCandidates();
  const actor = published.forms.find((form) => form.identity.formRef.kind === "ActorNamespace");
  if (!actor?.workerClassRuntime?.runtimeClassRef || !actor.identity.packageDigest)
    throw new Error("released Actor missing");
  const input = { stableForms: published.forms, stableBindings: published.bindings };
  expect(hasExactSelfhostActorClosure(input)).toBe(true);
  expect(
    hasExactSelfhostActorClosure({
      ...input,
      workerClassRuntimeContracts: [
        {
          formRef: actor.identity.formRef,
          packageDigest: actor.identity.packageDigest,
          runtimeClassRef: actor.workerClassRuntime.runtimeClassRef,
        },
      ],
    }),
  ).toBe(true);
});

test("forward Actor declarations cannot infer or duplicate the class registration", () => {
  const input = forwardClosure();
  expect(hasExactSelfhostActorClosure({ ...input, workerClassRuntimeContracts: [] })).toBe(false);
  expect(
    hasExactSelfhostActorClosure({
      ...input,
      workerClassRuntimeContracts: [
        ...input.workerClassRuntimeContracts,
        ...input.workerClassRuntimeContracts,
      ],
    }),
  ).toBe(false);
});

test.each(["ActorNamespace", "ModuleWorker", "WorkerVersion", "WorkerDeployment"])(
  "forward Actor declaration refuses a missing, duplicate, or altered %s",
  (kind) => {
    const input = forwardClosure();
    const form = input.stableForms.find((candidate) => candidate.identity.formRef.kind === kind);
    if (!form) throw new Error(`missing ${kind}`);
    expect(
      hasExactSelfhostActorClosure({
        ...input,
        stableForms: input.stableForms.filter((candidate) => candidate !== form),
      }),
    ).toBe(false);
    expect(
      hasExactSelfhostActorClosure({ ...input, stableForms: [...input.stableForms, form] }),
    ).toBe(false);
    expect(
      hasExactSelfhostActorClosure({
        ...input,
        stableForms: input.stableForms.map((candidate) =>
          candidate === form
            ? {
                ...form,
                identity: { ...form.identity, packageDigest: `sha256:${"0".repeat(64)}` as const },
              }
            : candidate,
        ),
      }),
    ).toBe(false);
  },
);

test("forward Actor declaration refuses missing, legacy, altered, or duplicate Bindings", () => {
  const input = forwardClosure();
  const binding = input.stableBindings.find(
    (item) => item.bindingRef.name === "module-worker.actor",
  );
  const legacyBinding = currentTakoformCandidates().bindings.find(
    (item) => item.bindingRef.name === "module-worker.actor",
  );
  if (!binding || !legacyBinding) throw new Error("Actor Binding missing");
  const withoutActor = input.stableBindings.filter((item) => item !== binding);
  expect(hasExactSelfhostActorClosure({ ...input, stableBindings: withoutActor })).toBe(false);
  expect(
    hasExactSelfhostActorClosure({ ...input, stableBindings: [...withoutActor, legacyBinding] }),
  ).toBe(false);
  expect(
    hasExactSelfhostActorClosure({ ...input, stableBindings: [...input.stableBindings, binding] }),
  ).toBe(false);
  expect(
    hasExactSelfhostActorClosure({
      ...input,
      stableBindings: [
        ...withoutActor,
        { ...binding, targetInterface: legacyBinding.targetInterface },
      ],
    }),
  ).toBe(false);
});

test("forward Actor registration cannot substitute Form, package, or runtime identity", () => {
  const input = forwardClosure();
  const contract = input.workerClassRuntimeContracts[0];
  if (!contract) throw new Error("Actor contract missing");
  for (const altered of [
    {
      ...contract,
      formRef: { ...contract.formRef, schemaDigest: `sha256:${"0".repeat(64)}` as const },
    },
    { ...contract, packageDigest: `sha256:${"0".repeat(64)}` as const },
    {
      ...contract,
      runtimeClassRef: {
        ...contract.runtimeClassRef,
        schemaDigest: `sha256:${"0".repeat(64)}` as const,
      },
    },
  ]) {
    expect(hasExactSelfhostActorClosure({ ...input, workerClassRuntimeContracts: [altered] })).toBe(
      false,
    );
  }
});

test("self-host composition connects only the exact forward Actor contract and Binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-closure-"));
  const runtime: WorkerdRuntime = {
    async inspectModule() {
      throw new Error("declaration must not execute modules");
    },
    async write() {
      throw new Error("declaration must not publish");
    },
    async remove() {},
    async reload() {},
    async has() {
      return false;
    },
  };
  const owner = await openSelfhostActorPublicRuntime({
    dataRoot: root,
    runtimeRoot: root,
    socketParent: join(root, "sockets"),
    binary: "/never-execute",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local",
    providerInstallationRef: "local.primary",
  });
  try {
    const input = forwardClosure();
    const composition = createSelfhostComposition({
      ...input,
      edge: await buildEdgeForms(),
      dataRoot: root,
      runtime,
      actorRuntime: owner,
      artifacts: { manifest: async () => null, blob: async () => null },
      edgeForms: true,
      now: new Date("2026-10-04T00:00:00.000Z"),
    });
    const actor = input.stableForms.find((form) => form.identity.formRef.kind === "ActorNamespace");
    const binding = input.stableBindings.find(
      (item) => item.bindingRef.name === "module-worker.actor",
    );
    if (!actor || !binding) throw new Error("forward Actor declaration missing");
    expect(
      composition.offerings
        .filter((item) => item.form.kind === "ActorNamespace")
        .map((item) => item.form),
    ).toEqual([actor.identity.formRef]);
    expect(composition.provider.workerClassRuntime?.contracts).toEqual(
      input.workerClassRuntimeContracts,
    );
    expect(composition.providerPacks[0]?.descriptor.bindingRefs).toContainEqual(binding.bindingRef);
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("forward Actor Binding materialization preserves its exact runtime and tenant scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-material-"));
  const input = forwardClosure();
  const contract = input.workerClassRuntimeContracts[0];
  const binding = input.stableBindings.find(
    (item) => item.bindingRef.name === "module-worker.actor",
  );
  const worker = input.stableForms.find((form) => form.identity.formRef.kind === "ModuleWorker");
  if (!binding || !contract || !worker) throw new Error("forward Actor closure missing");
  const f = fixture();
  let workerFormRef = worker.identity.formRef;
  const owner = await openSelfhostActorPublicRuntime({
    dataRoot: root,
    runtimeRoot: root,
    socketParent: join(root, "sockets"),
    binary: "/never-execute",
    graph: async (...args) => {
      const graph = await f.read(...args);
      return graph
        ? {
            ...graph,
            namespace: { ...graph.namespace, formRef: contract.formRef },
            worker: { ...graph.worker, formRef: workerFormRef },
            runtimeClassRef: contract.runtimeClassRef,
          }
        : null;
    },
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
  });
  try {
    await f.deployments.create({
      tenantId: scope.tenantId,
      id: "deployment-holder",
      resourceUid: f.target.metadata.uid,
      offeringId: "worker-local",
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
      nativeId: "selfhost-worker:worker:operation-1",
      state: "active",
      observed: {},
      outputs: { scriptName: "worker" },
    });
    await owner.actorNamespace.registerNamespace(scope);
    await f.deployments.create({
      tenantId: scope.tenantId,
      id: "deployment-actor",
      resourceUid: scope.namespaceResourceUid,
      offeringId: "compute.actor.stable-v1.standard",
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
      nativeId: `selfhost-actor:${scope.namespaceResourceUid}`,
      state: "active",
      observed: {},
      outputs: { resourceUid: scope.namespaceResourceUid },
    });
    const deployment = await f.deployments.active(scope.tenantId, scope.namespaceResourceUid);
    if (!deployment) throw new Error("Actor deployment missing");
    const relation = {
      pointer: "/actorBindings/0/resource",
      relation: "/actorBindings/*/resource",
      targetUid: scope.namespaceResourceUid,
      bindingRef: binding.bindingRef,
      resource: {
        ...f.source,
        form: { formRef: contract.formRef, packageDigest: contract.packageDigest },
      },
      deployment,
    };
    const mutableBinding = structuredClone(binding);
    const materializer = createSelfhostRuntimeBindingMaterializer(
      "selfhost",
      owner,
      mutableBinding,
    );
    Object.assign(mutableBinding.bindingRef, { schemaDigest: `sha256:${"0".repeat(64)}` });
    const route = { bindingRef: binding.bindingRef, materialKind: SELFHOST_ACTOR_MATERIAL_KIND };
    expect(materializer.exporter?.routes).toContainEqual(route);
    const exported = await materializer.exporter?.exportTarget({
      tenantId: scope.tenantId,
      relation,
      route,
    });
    expect(exported).not.toBeNull();
    const request = {
      tenantId: scope.tenantId,
      source: {
        tenantRef: scope.tenantId,
        space: "default",
        name: "caller",
        uid: "uid-caller-worker",
      },
      sourceSpec: {},
      name: "COUNTER",
      relation,
      route,
      exported: {
        providerPackRef: "selfhost",
        materialKind: SELFHOST_ACTOR_MATERIAL_KIND,
        material: exported,
      },
    };
    expect(await materializer.importer?.importBinding(request)).toEqual({
      kind: SELFHOST_ACTOR_MATERIAL_KIND,
      tenantId: scope.tenantId,
      namespaceResourceUid: scope.namespaceResourceUid,
      workerResourceUid: f.target.metadata.uid,
      className: "Counter",
    });
    expect(
      await materializer.importer?.importBinding({
        ...request,
        source: { ...request.source, tenantRef: "other-tenant" },
      }),
    ).toBeNull();
    expect(
      await materializer.importer?.importBinding({
        ...request,
        source: { ...request.source, space: "other-space" },
      }),
    ).toBeNull();
    expect(
      await materializer.exporter?.exportTarget({ tenantId: "other-tenant", relation, route }),
    ).toBeNull();
    expect(
      await materializer.exporter?.exportTarget({
        tenantId: scope.tenantId,
        route,
        relation: { ...relation, resource: { ...relation.resource, form: f.source.form } },
      }),
    ).toBeNull();
    expect(() =>
      createSelfhostRuntimeBindingMaterializer("selfhost", owner, mutableBinding),
    ).toThrow("Binding closure");
    workerFormRef = f.target.form.formRef;
    expect(
      await materializer.exporter?.exportTarget({ tenantId: scope.tenantId, relation, route }),
    ).toBeNull();
  } finally {
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});
