import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "../src/ports.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import { resolveSelfhostActorContractClosure } from "../src/selfhost-actor-contract-closure.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import type { InstalledTakoformForm, TakoformBindingRef } from "../src/takoform/types.ts";
import type {
  ActorResourceGraph,
  WorkerClassBindingSelection,
} from "../src/worker-class-runtime-port.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const stableForms = currentTakoformCandidates().forms;
const forward = forwardTakoformCandidates();
const stableForm = (kind: string): InstalledTakoformForm => {
  const found = stableForms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!found) throw new Error(`missing released ${kind} Form`);
  return found;
};
const forwardForm = (kind: string): InstalledTakoformForm => {
  const found = forward.forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!found) throw new Error(`missing forward ${kind} Form`);
  return found;
};

const actorForm = forwardForm("ActorNamespace");
const versionForm = forwardForm("WorkerVersion");
const forwardWorkerForm = forwardForm("ModuleWorker");
const legacyWorkerForm = stableForm("ModuleWorker");
const actorBinding = forward.bindings.find(
  (candidate) => candidate.bindingRef.name === "module-worker.actor",
);
if (!actorBinding) throw new Error("forward Actor Binding missing");
const actorRuntimeRef = required(
  actorForm.workerClassRuntime?.runtimeClassRef,
  "forward Actor runtime ref missing",
);
const actorPackageDigest = required(
  actorForm.identity.packageDigest,
  "forward Actor package digest missing",
);

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

const runtime: WorkerdRuntime = {
  async inspectModule() {
    return { outcome: "valid", exportedHandlers: [] };
  },
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

const actorContract = {
  formRef: actorForm.identity.formRef,
  packageDigest: actorPackageDigest,
  runtimeClassRef: actorRuntimeRef,
};
const actorClosure = resolveSelfhostActorContractClosure({
  stableForms: forward.forms,
  stableBindings: forward.bindings,
  workerClassRuntimeContracts: [actorContract],
});
const exactActorSelection = required(
  actorClosure?.providerBinding ?? undefined,
  "forward Actor selection missing",
);

function actorRuntimeConfiguration(binding: WorkerClassBindingSelection = exactActorSelection) {
  return {
    providerInstallationRef: "local.primary",
    binding: structuredClone(binding),
    contracts: structuredClone([actorContract]),
    async inspect() {
      return "valid" as const;
    },
  };
}

test("self-host Version accepts only the exact forward Actor Binding closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-forward-binding-"));
  const tenantId = "tenant-forward-one";
  const space = "default";
  const workerUid = "uid-worker-forward-one";
  const holderUid = "uid-holder-forward-one";
  const actorUid = "uid-actor-forward-one";
  const versionUid = "uid-version-forward-one";
  const address = (kind: string, name: string, inSpace = space) => ({
    apiVersion: "edge.forms.takoform.com",
    kind,
    name,
    space: inSpace,
  });
  const metadata = (uid: string, name: string, inSpace = space) => ({
    uid,
    name,
    space: inSpace,
    generation: "1",
    revision: "1",
  });
  const resource = (
    kind: string,
    uid: string,
    name: string,
    spec: JsonObject = {},
    selectedForm: InstalledTakoformForm = stableForm(kind),
    inSpace = space,
  ) => ({
    apiVersion: "edge.forms.takoform.com",
    kind,
    form: { formRef: selectedForm.identity.formRef },
    metadata: metadata(uid, name, inSpace),
    spec,
  });
  const offering = (
    selected: InstalledTakoformForm,
    id: string,
    bindingRefs: readonly TakoformBindingRef[] = [],
  ) => ({
    id,
    kind: `takoform.${selected.identity.formRef.kind}`,
    displayName: selected.identity.formRef.kind,
    form: selected.identity.formRef,
    providedInterfaces: selected.providedInterfaces ?? [],
    bindingRefs,
    capabilities: ["create", "delete", "import", "observe"] as const,
  });
  const actorOffering = offering(actorForm, "selfhost.edge.actor-forward");
  const versionOffering = offering(
    versionForm,
    "selfhost.edge.version-forward",
    versionForm.acceptedBindings ?? [],
  );
  const workerOffering = offering(forwardWorkerForm, "selfhost.edge.moduleworker-forward");
  const legacyWorkerOffering = offering(legacyWorkerForm, "selfhost.edge.moduleworker-legacy");
  const deploymentOffering = offering(
    stableForm("WorkerDeployment"),
    "selfhost.edge.workerdeployment",
  );
  const graph: ActorResourceGraph = {
    tenantId,
    namespace: {
      ...metadata(actorUid, "counter"),
      address: address("ActorNamespace", "counter"),
      formRef: actorForm.identity.formRef,
      className: "Counter",
    },
    worker: {
      ...metadata(holderUid, "class-holder"),
      address: address("ModuleWorker", "class-holder"),
      formRef: forwardWorkerForm.identity.formRef,
    },
    runtimeClassRef: actorRuntimeRef,
  };
  const deployed = (uid: string, offeringId: string, nativeId: string, outputs: JsonObject) => ({
    tenantId,
    id: `dep-${uid}`,
    resourceUid: uid,
    offeringId,
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
    nativeId,
    state: "active" as const,
    observed: {},
    outputs,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  });
  let ownerGraph: ActorResourceGraph | null = graph;
  const configuredActorRuntime = actorRuntimeConfiguration();
  const provider = createSelfhostProvider({
    id: "local.pack",
    offerings: [
      actorOffering,
      versionOffering,
      workerOffering,
      legacyWorkerOffering,
      deploymentOffering,
    ],
    dataRoot: root,
    runtime,
    actorClassRuntime: configuredActorRuntime,
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
  Object.assign(configuredActorRuntime.binding.contract, {
    packageDigest: `sha256:${"0".repeat(64)}`,
  });
  const configuredContract = required(
    configuredActorRuntime.contracts[0],
    "Actor contract missing",
  );
  configuredContract.packageDigest = `sha256:${"0".repeat(64)}`;

  try {
    const worker = await provider.apply({
      operationId: "op-forward-worker",
      offering: workerOffering,
      identity: { tenantRef: tenantId, space, name: "caller", uid: workerUid },
      spec: {},
    });
    expect(worker).toMatchObject({ phase: "succeeded" });
    if (worker.phase !== "succeeded") throw new Error("Worker creation failed");
    const legacyWorker = await provider.apply({
      operationId: "op-legacy-worker",
      offering: legacyWorkerOffering,
      identity: {
        tenantRef: tenantId,
        space,
        name: "legacy-caller",
        uid: "uid-worker-legacy-caller",
      },
      spec: {},
    });
    expect(legacyWorker).toMatchObject({ phase: "succeeded" });
    if (legacyWorker.phase !== "succeeded") throw new Error("legacy Worker creation failed");

    const workerRelation = {
      pointer: "/worker",
      relation: "/worker",
      targetUid: workerUid,
      resource: resource("ModuleWorker", workerUid, "caller", {}, forwardWorkerForm),
      deployment: deployed(
        workerUid,
        workerOffering.id,
        worker.result.nativeId,
        worker.result.outputs,
      ),
    };
    const legacyWorkerRelation = {
      pointer: "/worker",
      relation: "/worker",
      targetUid: "uid-worker-legacy-caller",
      resource: resource("ModuleWorker", "uid-worker-legacy-caller", "legacy-caller"),
      deployment: deployed(
        "uid-worker-legacy-caller",
        legacyWorkerOffering.id,
        legacyWorker.result.nativeId,
        legacyWorker.result.outputs,
      ),
    };
    const bundleRelation = {
      pointer: "/bundle",
      relation: "/bundle",
      targetUid: "uid-bundle-forward-one",
      resource: resource("WorkerBundle", "uid-bundle-forward-one", "bundle", {
        manifestDigest: "sha256:worker",
      }),
    };
    const actorRelation = {
      pointer: "/actorBindings/0/resource",
      relation: "/actorBindings/*/resource",
      targetUid: actorUid,
      bindingRef: exactActorSelection.bindingRef,
      resource: resource(
        "ActorNamespace",
        actorUid,
        "counter",
        {
          className: "Counter",
          worker: address("ModuleWorker", "class-holder"),
        },
        actorForm,
      ),
      deployment: deployed(actorUid, actorOffering.id, `selfhost-actor:${actorUid}`, {}),
    };
    const request = {
      operationId: "op-forward-version",
      offering: versionOffering,
      identity: { tenantRef: tenantId, space, name: "caller-v2", uid: versionUid },
      spec: {
        bundle: address("WorkerBundle", "bundle"),
        worker: address("ModuleWorker", "caller"),
        handlers: ["fetch"],
        actorBindings: [{ name: "COUNTER", resource: address("ActorNamespace", "counter") }],
      },
      relations: [workerRelation, bundleRelation, actorRelation],
    };
    const applied = await provider.apply(request);
    expect(applied).toMatchObject({ phase: "succeeded" });
    if (applied.phase !== "succeeded") throw new Error("forward Actor Version was not accepted");
    const bindingsPath = join(
      root,
      "selfhost",
      "version-bindings",
      String(worker.result.outputs.scriptName),
    );
    const files = await readdir(bindingsPath);
    expect(files).toHaveLength(1);
    const bindingFile = required(files[0], "forward Actor Version binding file missing");
    const stored = JSON.parse(await Bun.file(join(bindingsPath, bindingFile)).text()) as {
      format?: string;
      actorBindings?: unknown;
    };
    expect(stored.format).toBe("takoserver.selfhost-version-bindings@v9");
    expect(stored.actorBindings).toEqual([
      {
        name: "COUNTER",
        tenantId,
        namespaceResourceUid: actorUid,
        workerResourceUid: holderUid,
        className: "Counter",
        runtimeClassRef: actorRuntimeRef,
      },
    ]);

    const legacyCaller = await provider.apply({
      ...request,
      operationId: "op-forward-version-legacy-caller",
      identity: {
        ...request.identity,
        name: "legacy-caller-version",
        uid: "uid-version-old-caller",
      },
      relations: [legacyWorkerRelation, bundleRelation, actorRelation],
    });
    expect(legacyCaller).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(await readdir(bindingsPath)).toEqual(files);

    ownerGraph = {
      ...graph,
      worker: { ...graph.worker, formRef: legacyWorkerForm.identity.formRef },
    };
    const legacyHolder = await provider.apply({
      ...request,
      operationId: "op-forward-version-legacy-holder",
      identity: {
        ...request.identity,
        name: "legacy-holder-version",
        uid: "uid-version-old-holder",
      },
    });
    expect(legacyHolder).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(await readdir(bindingsPath)).toEqual(files);
    ownerGraph = graph;

    for (const [label, relation] of [
      [
        "wrong-binding",
        { ...actorRelation, bindingRef: { ...exactActorSelection.bindingRef, version: "1.0.0" } },
      ],
      [
        "wrong-tenant",
        { ...actorRelation, deployment: { ...actorRelation.deployment, tenantId: "tenant-other" } },
      ],
      [
        "wrong-space",
        {
          ...actorRelation,
          resource: {
            ...actorRelation.resource,
            metadata: { ...actorRelation.resource.metadata, space: "other" },
          },
        },
      ],
    ] as const) {
      const rejected = await provider.apply({
        ...request,
        operationId: `op-forward-${label}`,
        identity: { ...request.identity, name: label, uid: `uid-version-${label}` },
        relations: [workerRelation, bundleRelation, relation],
      });
      expect(rejected).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
      expect(await readdir(bindingsPath)).toEqual(files);
    }

    const forgedVersionOffering = {
      ...versionOffering,
      form: stableForm("WorkerVersion").identity.formRef,
    };
    const wrongVersionForm = await provider.apply({
      ...request,
      operationId: "op-forward-stable-version-form",
      offering: forgedVersionOffering,
      identity: { ...request.identity, name: "stable-form", uid: "uid-version-stable-form" },
    });
    expect(wrongVersionForm).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec" },
    });
    expect(await readdir(bindingsPath)).toEqual(files);

    ownerGraph = { ...graph, tenantId: "tenant-other" };
    const graphMismatch = await provider.apply({
      ...request,
      operationId: "op-forward-graph-tenant",
      identity: { ...request.identity, name: "graph-other", uid: "uid-version-graph-other" },
    });
    expect(graphMismatch).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    expect(await readdir(bindingsPath)).toEqual(files);
    ownerGraph = graph;

    const runtimeConfiguration = actorRuntimeConfiguration();
    const originalContract = required(runtimeConfiguration.contracts[0], "Actor contract missing");
    const mismatchedContract = (change: "package" | "runtime") => ({
      ...runtimeConfiguration,
      contracts: [
        {
          ...originalContract,
          ...(change === "package"
            ? { packageDigest: `sha256:${"0".repeat(64)}` as const }
            : { runtimeClassRef: { ...actorRuntimeRef, version: "9.0.0" } }),
        },
      ],
    });
    const makeProviderWith = (configuration: ReturnType<typeof actorRuntimeConfiguration>) =>
      createSelfhostProvider({
        id: "local.pack",
        offerings: [actorOffering, versionOffering, workerOffering, deploymentOffering],
        dataRoot: join(root, "wrong-contract"),
        runtime,
        actorClassRuntime: configuration,
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
          async manifest() {
            return null;
          },
          async blob() {
            return null;
          },
        },
      });
    expect(() => makeProviderWith(mismatchedContract("package"))).toThrow();
    expect(() => makeProviderWith(mismatchedContract("runtime"))).toThrow();
    const malformedSelection: WorkerClassBindingSelection = {
      ...exactActorSelection,
      workerFormRef: {
        ...exactActorSelection.workerFormRef,
        kind: "ActorNamespace",
      },
    };
    expect(() => makeProviderWith(actorRuntimeConfiguration(malformedSelection))).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
