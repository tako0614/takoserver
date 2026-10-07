import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import { createSelfhostScriptStateStore } from "../src/providers/selfhost-script-state.ts";
import {
  deriveSelfhostActorForwardToken,
  type SelfhostVersionActorBinding,
} from "../src/providers/selfhost-version-bindings.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import type { ActorResourceGraph } from "../src/worker-class-runtime-port.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const actorForm = currentTakoformCandidates().forms.find(
  (form) => form.identity.formRef.kind === "ActorNamespace",
);
if (!actorForm) throw new Error("released ActorNamespace Form missing");

const runtime: WorkerdRuntime = {
  async inspectModule() {
    return { outcome: "valid", exportedHandlers: [] };
  },
  // This direct Provider relation test does not publish a Deployment. The
  // qualified callback is a fixture; real capacity is proved separately.
  async publish() {},
  async publishActorDeployment(_name, _publication, commitDesiredState) {
    await commitDesiredState();
  },
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return false;
  },
};

test("self-host Actor identity allocates only for a same-tenant pinned Worker relation", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-public-provider-"));
  const scopes: string[] = [];
  const registrations = new Set<string>();
  const offering = {
    id: "selfhost.edge.actornamespace",
    kind: "takoform.ActorNamespace",
    displayName: "Actor Namespace",
    form: actorForm.identity.formRef,
    providedInterfaces: actorForm.providedInterfaces ?? [],
    bindingRefs: [],
    capabilities: ["create", "delete", "import", "observe"] as const,
  };
  const provider = createSelfhostProvider({
    offerings: [offering],
    dataRoot: root,
    runtime,
    artifacts: {
      async manifest() {
        return null;
      },
      async blob() {
        return null;
      },
    },
    actorNamespace: {
      async readCurrentGraph() {
        return null;
      },
      async registerNamespace(scope) {
        scopes.push(JSON.stringify(scope));
        registrations.add(JSON.stringify(scope));
      },
      async hasNamespace(scope) {
        return registrations.has(JSON.stringify(scope));
      },
      async namespaceAbsent(scope) {
        return !registrations.has(JSON.stringify(scope));
      },
      async forgetNamespace(scope) {
        registrations.delete(JSON.stringify(scope));
      },
    },
  });
  const identity = {
    tenantRef: "tenant-one",
    space: "default",
    name: "counter",
    uid: "uid-actor-counter-one",
  };
  const relation = {
    pointer: "/worker",
    relation: "/worker",
    targetUid: "uid-worker-one",
    resource: {
      apiVersion: "edge.forms.takoform.com",
      kind: "ModuleWorker",
      form: { formRef: { ...actorForm.identity.formRef, kind: "ModuleWorker" } },
      metadata: {
        name: "worker",
        space: "default",
        uid: "uid-worker-one",
        generation: "1",
        revision: "1",
      },
      spec: {},
    },
    deployment: {
      tenantId: "tenant-one",
      id: "dep-worker-one",
      resourceUid: "uid-worker-one",
      offeringId: "selfhost.edge.moduleworker",
      providerPackRef: provider.id,
      providerInstallationRef: "local.primary",
      nativeId: "selfhost-worker:worker:op",
      state: "active" as const,
      observed: {},
      outputs: { scriptName: "worker" },
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    },
  };
  const request = {
    operationId: "op-actor-one",
    offering,
    identity,
    spec: {
      className: "Counter",
      worker: { apiVersion: "edge.forms.takoform.com", kind: "ModuleWorker", name: "worker" },
    },
    relations: [relation],
  };
  try {
    const withoutRuntime = createSelfhostProvider({
      offerings: [offering],
      dataRoot: root,
      runtime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
    });
    expect(await withoutRuntime.apply(request)).toMatchObject({
      phase: "failed",
      failure: { code: "denied" },
    });
    expect(scopes).toHaveLength(0);
    expect(await provider.apply(request)).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "selfhost-actor:uid-actor-counter-one" },
    });
    expect(scopes).toEqual([
      '{"tenantId":"tenant-one","namespaceResourceUid":"uid-actor-counter-one"}',
    ]);
    expect(
      await provider.apply({
        ...request,
        operationId: "op-wrong-tenant",
        relations: [
          { ...relation, deployment: { ...relation.deployment, tenantId: "tenant-two" } },
        ],
      }),
    ).toMatchObject({ phase: "failed" });
    expect(scopes).toHaveLength(1);
    const nativeId = "selfhost-actor:uid-actor-counter-one";
    const descriptor = provider.createNativeReadbackDescriptor?.({
      offering,
      identity,
      nativeId,
      spec: request.spec,
      relations: [relation],
    });
    expect(descriptor?.data).toEqual({ resourceUid: identity.uid });
    expect(JSON.stringify(descriptor)).not.toContain("token");
    expect(JSON.stringify(descriptor)).not.toContain("socket");
    expect(
      await provider.observe({
        offering,
        identity,
        nativeId,
        spec: request.spec,
        relations: [relation],
      }),
    ).toMatchObject({
      phase: "succeeded",
      result: { nativeId, observed: { ready: false } },
    });
    expect(
      await provider.delete({
        operationId: "op-delete-actor",
        offering,
        identity,
        nativeId,
        spec: request.spec,
        relations: [relation],
      }),
    ).toMatchObject({ phase: "succeeded" });
    expect(registrations.size).toBe(0);
    if (!descriptor) throw new Error("Actor readback descriptor missing");
    expect(
      await provider.verifyNativeAbsence?.({
        offering,
        descriptor,
        target: {
          tenantId: identity.tenantRef,
          resourceUid: identity.uid,
          incarnationId: "dep-actor",
          generation: "1",
        },
      }),
    ).toMatchObject({ outcome: "absent", evidence: { kind: "ActorNamespace" } });
    expect(
      await provider.recoverDelete?.({
        operationId: "op-delete-actor",
        offering,
        identity,
        nativeId,
        spec: request.spec,
        relations: [relation],
      }),
    ).toMatchObject({ phase: "succeeded" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker Version pins legacy v8 and refuses unselected forward Actor metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-version-provider-"));
  const candidates = currentTakoformCandidates().forms;
  const form = (kind: string) => {
    const found = candidates.find((candidate) => candidate.identity.formRef.kind === kind);
    if (!found) throw new Error(`missing released ${kind} Form`);
    return found;
  };
  const workerForm = form("ModuleWorker");
  const versionForm = form("WorkerVersion");
  const actorBindingRef = versionForm.acceptedBindings?.find(
    (binding) => binding.name === "module-worker.actor",
  );
  if (!actorBindingRef) throw new Error("released Actor Binding missing");
  const offering = (kind: string) => {
    const selected = form(kind);
    return {
      id: `selfhost.edge.${kind.toLowerCase()}`,
      kind: `takoform.${kind}`,
      displayName: kind,
      form: selected.identity.formRef,
      providedInterfaces: selected.providedInterfaces ?? [],
      bindingRefs: kind === "WorkerVersion" ? [actorBindingRef] : [],
      capabilities: ["create", "delete", "import", "observe"] as const,
    };
  };
  const actorOffering = offering("ActorNamespace");
  const forwardActorForm = forwardTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ActorNamespace",
  );
  if (!forwardActorForm?.workerClassRuntime?.runtimeClassRef)
    throw new Error("forward Actor Form runtime ref missing");
  const forwardActorOffering = {
    ...actorOffering,
    id: "selfhost.edge.actornamespace.forward",
    form: forwardActorForm.identity.formRef,
    providedInterfaces: forwardActorForm.providedInterfaces ?? [],
  };
  const wrongForwardOffering = {
    ...forwardActorOffering,
    id: "selfhost.edge.actornamespace.wrong-interface",
    providedInterfaces: [ACTOR_ABI_INTERFACE_REFS.legacy],
  };
  const versionOffering = offering("WorkerVersion");
  const deploymentOffering = offering("WorkerDeployment");
  const tenantId = "tenant-one";
  const workerUid = "uid-worker-caller-one";
  const actorWorkerUid = "uid-worker-class-holder-one";
  const actorUid = "uid-actor-counter-one";
  const versionUid = "uid-version-caller-one";
  const address = (kind: string, name: string) => ({
    apiVersion: "edge.forms.takoform.com",
    kind,
    name,
    space: "default",
  });
  const metadata = (uid: string, name: string) => ({
    uid,
    name,
    space: "default",
    generation: "1",
    revision: "1",
  });
  const resource = (kind: string, uid: string, name: string, spec: JsonObject = {}) => ({
    apiVersion: "edge.forms.takoform.com",
    kind,
    form: { formRef: form(kind).identity.formRef },
    metadata: metadata(uid, name),
    spec,
  });
  const graph = {
    tenantId,
    namespace: {
      ...metadata(actorUid, "counter"),
      address: address("ActorNamespace", "counter"),
      formRef: actorForm.identity.formRef,
      className: "Counter",
    },
    worker: {
      ...metadata(actorWorkerUid, "class-holder"),
      address: address("ModuleWorker", "class-holder"),
      formRef: workerForm.identity.formRef,
    },
  };
  const deployed = (uid: string, kind: string, nativeId: string, outputs: JsonObject) => ({
    tenantId,
    id: `dep-${uid}`,
    resourceUid: uid,
    offeringId: `selfhost.edge.${kind.toLowerCase()}`,
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
    nativeId,
    state: "active" as const,
    observed: {},
    outputs,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
  let ownerGraph: ActorResourceGraph | null = graph;
  let rejectDeploymentPreflight = false;
  let deploymentPreflightCalls = 0;
  const provider = createSelfhostProvider({
    id: "local.pack",
    offerings: [
      actorOffering,
      forwardActorOffering,
      wrongForwardOffering,
      versionOffering,
      deploymentOffering,
    ],
    dataRoot: root,
    runtime: {
      ...runtime,
      async publishActorDeployment(_name, _publication, commitDesiredState) {
        deploymentPreflightCalls += 1;
        if (rejectDeploymentPreflight) throw new Error("fixture Actor capacity exhausted");
        await commitDesiredState();
      },
    },
    actorNamespace: {
      async readCurrentGraph() {
        return ownerGraph;
      },
      async registerNamespace() {},
      async hasNamespace() {
        return true;
      },
      async namespaceAbsent() {
        return false;
      },
      async forgetNamespace() {},
    },
    artifacts: {
      async manifest(_tenant, digest) {
        return digest === "sha256:worker"
          ? {
              kind: "WorkerBundle",
              mainModule: "index.js",
              modules: [{ name: "index.js", digest: "sha256:index.js" }],
            }
          : null;
      },
      async blob(digest) {
        return digest === "sha256:index.js"
          ? new TextEncoder().encode("export default { fetch() { return new Response('ok') } };")
          : null;
      },
    },
  });
  const worker = await provider.apply({
    operationId: "op-actor-worker",
    offering: offering("ModuleWorker"),
    identity: { tenantRef: tenantId, space: "default", name: "caller", uid: workerUid },
    spec: {},
  });
  if (worker.phase !== "succeeded") throw new Error("Worker creation failed");
  const holder = await provider.apply({
    operationId: "op-actor-class-holder",
    offering: offering("ModuleWorker"),
    identity: { tenantRef: tenantId, space: "default", name: "class-holder", uid: actorWorkerUid },
    spec: {},
  });
  if (holder.phase !== "succeeded") throw new Error("Actor class-holder creation failed");
  const script = String(worker.result.outputs.scriptName);
  const workerRelation = {
    pointer: "/worker",
    relation: "/worker",
    targetUid: workerUid,
    resource: resource("ModuleWorker", workerUid, "caller"),
    deployment: deployed(workerUid, "ModuleWorker", worker.result.nativeId, worker.result.outputs),
  };
  const bundleRelation = {
    pointer: "/bundle",
    relation: "/bundle",
    targetUid: "uid-bundle-caller-one",
    resource: resource("WorkerBundle", "uid-bundle-caller-one", "bundle", {
      manifestDigest: "sha256:worker",
    }),
  };
  const actorRelation = {
    pointer: "/actorBindings/0/resource",
    relation: "/actorBindings/*/resource",
    targetUid: actorUid,
    bindingRef: actorBindingRef,
    resource: resource("ActorNamespace", actorUid, "counter", {
      className: "Counter",
      worker: { apiVersion: "edge.forms.takoform.com", kind: "ModuleWorker", name: "class-holder" },
    }),
    deployment: deployed(actorUid, "ActorNamespace", `selfhost-actor:${actorUid}`, {}),
  };
  const request = {
    operationId: "op-actor-version",
    offering: versionOffering,
    identity: { tenantRef: tenantId, space: "default", name: "caller-v1", uid: versionUid },
    spec: {
      bundle: { apiVersion: "edge.forms.takoform.com", kind: "WorkerBundle", name: "bundle" },
      worker: { apiVersion: "edge.forms.takoform.com", kind: "ModuleWorker", name: "caller" },
      handlers: ["fetch"],
      actorBindings: [
        {
          name: "COUNTER",
          resource: {
            apiVersion: "edge.forms.takoform.com",
            kind: "ActorNamespace",
            name: "counter",
          },
        },
      ],
    },
    relations: [workerRelation, bundleRelation, actorRelation],
  };
  try {
    const bindingPath = join(root, "selfhost", "version-bindings", script);
    ownerGraph = null;
    expect(await provider.apply(request)).toMatchObject({ phase: "failed" });
    expect(await readdir(bindingPath).catch(() => [])).toEqual([]);
    ownerGraph = {
      ...graph,
      namespace: { ...graph.namespace, className: "Other" },
    };
    expect(await provider.apply({ ...request, operationId: "op-wrong-class" })).toMatchObject({
      phase: "failed",
    });
    expect(await readdir(bindingPath).catch(() => [])).toEqual([]);
    ownerGraph = graph;
    expect(
      await provider.apply({
        ...request,
        operationId: "op-wrong-tenant",
        relations: [
          workerRelation,
          bundleRelation,
          {
            ...actorRelation,
            deployment: { ...actorRelation.deployment, tenantId: "tenant-two" },
          },
        ],
      }),
    ).toMatchObject({ phase: "failed" });
    expect(await readdir(bindingPath).catch(() => [])).toEqual([]);
    const applied = await provider.apply(request);
    expect(applied).toMatchObject({ phase: "succeeded" });
    if (applied.phase !== "succeeded") throw new Error("Actor Version did not apply");
    expect(JSON.stringify(applied.result)).not.toMatch(/token|socket|tenant-one/u);
    const versionId = String(applied.result.outputs.versionId);
    const raw = JSON.parse(
      await Bun.file(
        join(root, "selfhost", "version-bindings", script, `${versionId}.json`),
      ).text(),
    ) as Record<string, unknown>;
    expect(raw.format).toBe("takoserver.selfhost-version-bindings@v8");
    expect(raw.actorBindings).toEqual([
      {
        name: "COUNTER",
        tenantId,
        namespaceResourceUid: actorUid,
        workerResourceUid: actorWorkerUid,
        className: "Counter",
      },
    ]);
    expect(raw.workerVersionResourceUid).toBe(versionUid);
    const forwardRef = forwardActorForm.workerClassRuntime.runtimeClassRef;
    const forwardActorRelation = {
      ...actorRelation,
      resource: {
        ...actorRelation.resource,
        form: { formRef: forwardActorForm.identity.formRef },
      },
      deployment: {
        ...actorRelation.deployment,
        offeringId: forwardActorOffering.id,
      },
    };
    const forwardRequest = {
      ...request,
      operationId: "op-forward-actor-version",
      identity: { ...request.identity, name: "caller-v2", uid: "uid-version-caller-v2" },
      relations: [workerRelation, bundleRelation, forwardActorRelation],
    };
    ownerGraph = {
      ...graph,
      namespace: { ...graph.namespace, formRef: forwardActorForm.identity.formRef },
      runtimeClassRef: {
        ...forwardRef,
        schemaDigest: ACTOR_ABI_INTERFACE_REFS.legacy.schemaDigest,
      },
    };
    const beforeForward = await readdir(bindingPath);
    expect(await provider.apply(forwardRequest)).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec" },
    });
    expect(await readdir(bindingPath)).toEqual(beforeForward);
    ownerGraph = {
      ...graph,
      namespace: { ...graph.namespace, formRef: forwardActorForm.identity.formRef },
      runtimeClassRef: forwardRef,
    };
    expect(
      await provider.apply({
        ...forwardRequest,
        operationId: "op-wrong-forward-interface",
        relations: [
          workerRelation,
          bundleRelation,
          {
            ...forwardActorRelation,
            deployment: {
              ...actorRelation.deployment,
              offeringId: wrongForwardOffering.id,
            },
          },
        ],
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(await readdir(bindingPath)).toEqual(beforeForward);
    // A legacy Binding1 offering cannot infer a forward Actor2 registration
    // from Host graph metadata; the exact selected Binding2 path is covered separately.
    expect(await provider.apply(forwardRequest)).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec" },
    });
    expect(await readdir(bindingPath)).toEqual(beforeForward);
    ownerGraph = graph;
    const actorBinding = (raw.actorBindings as SelfhostVersionActorBinding[])[0];
    if (!actorBinding) throw new Error("stored Actor relation missing");
    const token = deriveSelfhostActorForwardToken({
      eventToken: String(raw.eventToken),
      workerVersionResourceUid: versionUid,
      binding: actorBinding,
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(token).not.toBe(raw.eventToken);
    const scriptState = createSelfhostScriptStateStore({ root: join(root, "selfhost", "scripts") });
    const beforeDeployment = await scriptState.read(script);
    rejectDeploymentPreflight = true;
    const deploymentRequest = {
      operationId: "op-actor-deployment-capacity",
      offering: deploymentOffering,
      identity: {
        tenantRef: tenantId,
        space: "default",
        name: "caller-deployment",
        uid: "uid-caller-deployment-one",
      },
      spec: {
        worker: { apiVersion: "edge.forms.takoform.com", kind: "ModuleWorker", name: "caller" },
        versions: [
          {
            workerVersion: {
              apiVersion: "edge.forms.takoform.com",
              kind: "WorkerVersion",
              name: "caller-v1",
            },
            weight: 10000,
          },
        ],
      },
      relations: [
        workerRelation,
        {
          pointer: "/versions/0/workerVersion",
          relation: "/versions/*/workerVersion",
          targetUid: versionUid,
          resource: resource("WorkerVersion", versionUid, "caller-v1", request.spec),
          deployment: deployed(
            versionUid,
            "WorkerVersion",
            applied.result.nativeId,
            applied.result.outputs,
          ),
        },
      ],
    };
    const deploymentTicket = await provider.apply(deploymentRequest);
    expect(deploymentTicket).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    expect(deploymentPreflightCalls).toBe(1);
    expect(await scriptState.read(script)).toEqual(beforeDeployment);
    rejectDeploymentPreflight = false;
    const retryDeployment = await provider.apply({
      ...deploymentRequest,
      operationId: "op-actor-deployment-capacity-retry",
    });
    expect(retryDeployment).toMatchObject({ phase: "succeeded" });
    expect(deploymentPreflightCalls).toBe(2);
    expect((await scriptState.read(script)).state.deployment?.versions).toEqual([
      { versionId, weight: 10000, workerVersionUid: versionUid },
    ]);
    expect(
      deriveSelfhostActorForwardToken({
        eventToken: String(raw.eventToken),
        workerVersionResourceUid: versionUid,
        binding: { ...actorBinding, workerResourceUid: workerUid },
      }),
    ).not.toBe(token);
    expect(
      deriveSelfhostActorForwardToken({
        eventToken: String(raw.eventToken),
        workerVersionResourceUid: versionUid,
        binding: { ...actorBinding, className: "Other" },
      }),
    ).not.toBe(token);
    expect(
      deriveSelfhostActorForwardToken({
        eventToken: String(raw.eventToken),
        workerVersionResourceUid: "uid-version-caller-two",
        binding: actorBinding,
      }),
    ).not.toBe(token);
    expect(
      await provider.apply({
        ...request,
        operationId: "op-reused-version-address",
        identity: { ...request.identity, uid: "uid-version-replacement" },
      }),
    ).toMatchObject({ phase: "failed" });
    expect(
      JSON.parse(
        await Bun.file(
          join(root, "selfhost", "version-bindings", script, `${versionId}.json`),
        ).text(),
      ),
    ).toEqual(raw);
    const publishedBindings = Array.from({ length: 64 }, (_, index) => ({
      name: `COUNTER_${index}`,
      resource: {
        apiVersion: "edge.forms.takoform.com",
        kind: "ActorNamespace",
        name: "counter",
      },
    }));
    const many = {
      ...request,
      operationId: "op-actor-version-sixty-four",
      identity: {
        ...request.identity,
        name: "caller-v64",
        uid: "uid-version-sixty-four",
      },
      spec: { ...request.spec, actorBindings: publishedBindings },
      relations: [
        workerRelation,
        bundleRelation,
        ...publishedBindings.map((_, index) => ({
          ...actorRelation,
          pointer: `/actorBindings/${index}/resource`,
        })),
      ],
    };
    const acceptedBound = await provider.apply(many);
    expect(acceptedBound).toMatchObject({ phase: "succeeded" });
    if (acceptedBound.phase !== "succeeded") throw new Error("64 Actor bindings not materialized");
    const acceptedVersionId = String(acceptedBound.result.outputs.versionId);
    const acceptedBytes = JSON.parse(
      await Bun.file(join(bindingPath, `${acceptedVersionId}.json`)).text(),
    ) as Record<string, unknown>;
    expect((acceptedBytes.actorBindings as unknown[]).length).toBe(64);
    const boundDeployment = await provider.apply({
      ...deploymentRequest,
      operationId: "op-actor-deployment-sixty-four",
      identity: {
        ...deploymentRequest.identity,
        name: "caller-deployment-v64",
        uid: "uid-caller-deployment-sixty-four",
      },
      spec: {
        ...deploymentRequest.spec,
        versions: [
          {
            workerVersion: {
              apiVersion: "edge.forms.takoform.com",
              kind: "WorkerVersion",
              name: "caller-v64",
            },
            weight: 10000,
          },
        ],
      },
      relations: [
        workerRelation,
        {
          pointer: "/versions/0/workerVersion",
          relation: "/versions/*/workerVersion",
          targetUid: many.identity.uid,
          resource: resource("WorkerVersion", many.identity.uid, many.identity.name, many.spec),
          deployment: deployed(
            many.identity.uid,
            "WorkerVersion",
            acceptedBound.result.nativeId,
            acceptedBound.result.outputs,
          ),
        },
      ],
    });
    expect(boundDeployment).toMatchObject({ phase: "succeeded" });
    expect((await scriptState.read(script)).state.deployment?.versions).toEqual([
      { versionId: acceptedVersionId, weight: 10000, workerVersionUid: many.identity.uid },
    ]);
    const beforeOverbound = await readdir(bindingPath);
    expect(
      await provider.apply({
        ...many,
        operationId: "op-actor-version-sixty-five",
        identity: { ...many.identity, name: "caller-v65", uid: "uid-version-sixty-five" },
        spec: {
          ...many.spec,
          actorBindings: [...publishedBindings, { ...publishedBindings[0], name: "COUNTER_64" }],
        },
        relations: [...many.relations, { ...actorRelation, pointer: "/actorBindings/64/resource" }],
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(await readdir(bindingPath)).toEqual(beforeOverbound);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor namespace registration persists its UID and can be revoked without starting an Actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-public-binding-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-counter-one" };
  const otherTenant = { tenantId: "tenant-two", namespaceResourceUid: scope.namespaceResourceUid };
  const options = {
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  } as const;
  const host = createSelfhostActorExecutionHost(options);
  try {
    await host.ready;
    expect(await host.namespaceEmpty(scope)).toBe(false);
    await host.registerNamespace(scope);
    await host.registerNamespace(otherTenant);
    expect(await host.hasNamespace(scope)).toBe(true);
    expect(await host.namespaceEmpty(scope)).toBe(true);
    expect(await host.hasNamespace(otherTenant)).toBe(true);
    await host.close();
    const restored = createSelfhostActorExecutionHost(options);
    try {
      await restored.ready;
      expect(await restored.hasNamespace(scope)).toBe(true);
      expect(await restored.namespaceEmpty(scope)).toBe(true);
      await restored.forgetNamespace(scope);
      expect(await restored.hasNamespace(scope)).toBe(false);
      expect(await restored.namespaceEmpty(scope)).toBe(false);
      expect(await restored.hasNamespace(otherTenant)).toBe(true);
    } finally {
      await restored.close();
    }
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unacknowledged Actor registration is retried from the exact existing record", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-registration-sync-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-sync-one" };
  let interrupt = true;
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
    async afterRegistrationLinkBeforeSync() {
      if (interrupt) {
        interrupt = false;
        throw new Error("interrupted before directory sync");
      }
    },
  });
  try {
    await host.ready;
    await expect(host.registerNamespace(scope)).rejects.toThrow(
      "interrupted before directory sync",
    );
    expect(await host.hasNamespace(scope)).toBe(true);
    await host.registerNamespace(scope);
    expect(await host.hasNamespace(scope)).toBe(true);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained pre-fsync Actor registration can be re-acknowledged without changing identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-legacy-registration-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-legacy-one" };
  const storageRoot = join(root, "actor");
  const registrations = join(storageRoot, "registrations");
  const key = createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.namespaceResourceUid]))
    .digest("hex");
  await mkdir(registrations, { recursive: true });
  await writeFile(join(registrations, `${key}.json`), JSON.stringify(scope));
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot,
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  });
  try {
    await host.ready;
    await host.registerNamespace(scope);
    expect(await host.hasNamespace(scope)).toBe(true);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("revocation fences a pending Actor authority read before native startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-revoke-race-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-race-one" };
  let entered!: () => void;
  const enteredGraph = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const releaseGraph = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () => {
      entered();
      await releaseGraph;
      return null;
    },
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  });
  try {
    await host.ready;
    await host.registerNamespace(scope);
    const fetching = host.fetch({ ...scope, id: "one" }, new Request("http://actor.invalid/"));
    await enteredGraph;
    const forgetting = host.forgetNamespace(scope);
    release();
    await expect(fetching).rejects.toThrow();
    await forgetting;
    expect(await host.hasNamespace(scope)).toBe(false);
    await expect(
      host.fetch({ ...scope, id: "one" }, new Request("http://actor.invalid/")),
    ).rejects.toThrow("revoked");
  } finally {
    release();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deletion retains the exclusive lease until native data is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-delete-lease-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-delete-one" };
  const storageRoot = join(root, "actor");
  const key = createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.namespaceResourceUid]))
    .digest("hex");
  let entered!: () => void;
  const deleting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let proceed!: () => void;
  const resumed = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const options = {
    runtimeRoot: join(root, "runtime"),
    storageRoot,
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  } as const;
  const host = createSelfhostActorExecutionHost({
    ...options,
    async beforeNamespaceStorageDelete() {
      entered();
      await resumed;
    },
  });
  const peer = createSelfhostActorExecutionHost(options);
  try {
    await Promise.all([host.ready, peer.ready]);
    await host.registerNamespace(scope);
    const forget = host.forgetNamespace(scope);
    await deleting;
    expect((await lstat(join(storageRoot, "leases", key))).isDirectory()).toBe(true);
    await expect(
      peer.fetch({ ...scope, id: "one" }, new Request("http://actor.invalid/")),
    ).rejects.toThrow("not registered");
    await expect(peer.forgetNamespace(scope)).rejects.toThrow();
    proceed();
    await forget;
    expect(await host.namespaceAbsent(scope)).toBe(true);
  } finally {
    proceed();
    await Promise.all([host.close(), peer.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("owner refuses to delete a namespace while canonical graph authority remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-live-delete-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-live-one" };
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () =>
      ({ tenantId: scope.tenantId, namespace: { uid: scope.namespaceResourceUid } }) as never,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  });
  try {
    await host.ready;
    await host.registerNamespace(scope);
    await expect(host.forgetNamespace(scope)).rejects.toThrow("Resource authority");
    expect(await host.hasNamespace(scope)).toBe(true);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delete recovery proves a failed lease-unlink ACK durably absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-lease-sync-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-sync-delete" };
  const options = {
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  } as const;
  const first = createSelfhostActorExecutionHost({
    ...options,
    async afterLeaseUnlinkBeforeSync() {
      throw new Error("lease sync interrupted");
    },
  });
  try {
    await first.ready;
    await first.registerNamespace(scope);
    await expect(first.forgetNamespace(scope)).rejects.toThrow("lease sync interrupted");
    expect(await first.namespaceAbsent(scope)).toBe(false);
    await first.close();
    const recovery = createSelfhostActorExecutionHost(options);
    try {
      await recovery.ready;
      expect(await recovery.namespaceAbsent(scope)).toBe(true);
    } finally {
      await recovery.close();
    }
  } finally {
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
});
