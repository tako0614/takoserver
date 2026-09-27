import { expect, test } from "bun:test";
import { createCloudflareProviderSurface } from "../src/cloudflare-provider-surface.ts";
import { buildEdgeForms, edgeProviderOffering } from "../src/edge-forms.ts";
import { canonicalJson } from "../src/json.ts";
import { failed } from "../src/provider-port.ts";
import {
  deriveRuntimeImplementationCatalog,
  type PublicFormImplementationConfiguration,
  publicFormCapabilityManifest,
} from "../src/public-worker-implementation.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { selectTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import { deriveImplementationCatalog } from "../src/takoform/implementation-catalog.ts";
import {
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

const implementationPayloadDigest = `sha256:${"a".repeat(64)}` as const;

function explicitActorSupply(): NonNullable<
  PublicFormImplementationConfiguration["actorProvider"]
> {
  const actor = selectTakoformCandidates("actor-forward").forms.find(
    ({ identity }) => identity.formRef.kind === "ActorNamespace",
  );
  if (!actor?.identity.packageDigest || !actor.workerClassRuntime?.runtimeClassRef)
    throw new Error("exact Actor contract missing");
  // This is a software-composition fixture, not provider execution evidence.
  const unavailable = async () => failed("unavailable", "fixture does not execute customer code");
  return {
    offerings: [edgeProviderOffering(actor, { id: "test.actor.supply" })],
    workerClassRuntime: {
      contracts: [
        {
          formRef: actor.identity.formRef,
          packageDigest: actor.identity.packageDigest,
          runtimeClassRef: actor.workerClassRuntime.runtimeClassRef,
        },
      ],
      inspect: async () => "valid",
    },
    apply: unavailable,
    delete: unavailable,
    observe: unavailable,
    adopt: unavailable,
  };
}

test("default runtime catalog remains the published fifteen, without Actor or Workflow", async () => {
  const catalog = await deriveRuntimeImplementationCatalog({
    implementationPayloadDigest,
    capabilities: publicFormCapabilityManifest(),
  });
  expect(catalog.entries).toHaveLength(15);
  expect(catalog.entries.map(({ formRef }) => formRef.kind)).not.toContain("ActorNamespace");
  expect(catalog.entries.map(({ formRef }) => formRef.kind)).not.toContain("DurableWorkflow");
  for (const entry of catalog.entries) {
    expect(
      currentTakoformCandidates().forms.some(
        (form) =>
          canonicalJson(form.identity.formRef) === canonicalJson(entry.formRef) &&
          form.identity.packageDigest === entry.packageDigest,
      ),
    ).toBe(true);
  }
});

test("explicit forward software supports only exact new Actor and keeps old management refs", async () => {
  const selected = selectTakoformCandidates("actor-forward");
  const catalog = await deriveRuntimeImplementationCatalog({
    implementationPayloadDigest,
    candidate: "actor-forward",
    capabilities: publicFormCapabilityManifest("actor-forward"),
    actorProvider: explicitActorSupply(),
  });
  const actors = catalog.entries.filter(({ formRef }) => formRef.kind === "ActorNamespace");
  expect(actors).toHaveLength(1);
  const actor = selected.forms.find(({ identity }) => identity.formRef.kind === "ActorNamespace");
  expect(actors[0]?.formRef).toEqual(actor?.identity.formRef);
  expect(actors[0]?.operations).toContain("create");
  expect(catalog.entries.some(({ formRef }) => formRef.kind === "DurableWorkflow")).toBe(false);
  for (const old of selected.retainedForms.filter(
    ({ identity }) => !["ActorNamespace", "DurableWorkflow"].includes(identity.formRef.kind),
  )) {
    const entry = catalog.entries.find(
      ({ formRef }) => canonicalJson(formRef) === canonicalJson(old.identity.formRef),
    );
    expect(entry?.packageDigest).toBe(old.identity.packageDigest);
    expect(entry?.operations).toContain("read");
    expect(entry?.operations).toContain("delete");
    expect(entry?.operations).not.toContain("create");
    expect(entry?.operations).not.toContain("import");
    if (old.operations.includes("update")) expect(entry?.operations).toContain("update");
  }
});

test("candidate bytes and handler declarations do not confer Actor supply or runtime", async () => {
  const configuration = {
    implementationPayloadDigest,
    candidate: "actor-forward" as const,
    capabilities: publicFormCapabilityManifest("actor-forward"),
  };
  const missing = await deriveRuntimeImplementationCatalog(configuration);
  expect(missing.entries.some(({ formRef }) => formRef.kind === "ActorNamespace")).toBe(false);
  const provider = explicitActorSupply();
  if (!provider.workerClassRuntime) throw new Error("fixture runtime missing");
  const withoutSupply = await deriveRuntimeImplementationCatalog({
    ...configuration,
    actorProvider: { ...provider, offerings: [] },
  });
  expect(withoutSupply.entries.some(({ formRef }) => formRef.kind === "ActorNamespace")).toBe(
    false,
  );
  const { workerClassRuntime: _runtime, ...withoutRuntime } = provider;
  const unregistered = await deriveRuntimeImplementationCatalog({
    ...configuration,
    actorProvider: withoutRuntime,
  });
  expect(unregistered.entries.some(({ formRef }) => formRef.kind === "ActorNamespace")).toBe(false);
  const wrongRuntime = await deriveRuntimeImplementationCatalog({
    ...configuration,
    actorProvider: {
      ...provider,
      workerClassRuntime: {
        contracts: provider.workerClassRuntime.contracts.map((contract) => ({
          ...contract,
          packageDigest: `sha256:${"b".repeat(64)}` as const,
        })),
        inspect: async () => "valid",
      },
    },
  });
  expect(wrongRuntime.entries.some(({ formRef }) => formRef.kind === "ActorNamespace")).toBe(false);
  const readOnlySupply = await deriveRuntimeImplementationCatalog({
    ...configuration,
    actorProvider: {
      ...provider,
      offerings: provider.offerings.map((offering) => ({ ...offering, capabilities: ["observe"] })),
    },
  });
  expect(
    readOnlySupply.entries.find(({ formRef }) => formRef.kind === "ActorNamespace")?.operations,
  ).toEqual(["read", "observe"]);
  const old = currentTakoformCandidates().forms.find(
    ({ identity }) => identity.formRef.kind === "ActorNamespace",
  );
  if (!old) throw new Error("old Actor missing");
  const wrongExactSupply = await deriveRuntimeImplementationCatalog({
    ...configuration,
    actorProvider: {
      ...provider,
      offerings: [edgeProviderOffering(old, { id: "test.actor.supply" })],
    },
  });
  expect(wrongExactSupply.entries.some(({ formRef }) => formRef.kind === "ActorNamespace")).toBe(
    false,
  );
});

test("exact handler sets are exhaustive and never fall back to the kind", async () => {
  const selection = selectTakoformCandidates("actor-forward");
  const actor = selection.forms.find(({ identity }) => identity.formRef.kind === "ActorNamespace");
  const old = selection.retainedForms.find(
    ({ identity }) => identity.formRef.kind === "ActorNamespace",
  );
  if (!actor?.identity.packageDigest || !old) throw new Error("candidate Actor closure missing");
  const catalog = await deriveImplementationCatalog({
    forms: [actor, old],
    capabilities: publicFormCapabilityManifest("actor-forward"),
    handlers: {
      apiVersion: "takoserver.form-handlers@v1",
      artifact: "test",
      forms: { ActorNamespace: ["create", "read", "delete"] },
    },
    exactHandlers: [
      {
        formRef: actor.identity.formRef,
        packageDigest: actor.identity.packageDigest,
        operations: ["create", "read", "delete"],
      },
    ],
  });
  expect(catalog.entries).toHaveLength(1);
  expect(catalog.entries[0]?.formRef).toEqual(actor.identity.formRef);
});

test("forward surface retains old exact stable offering ids beside legacy recovery identities", async () => {
  const selection = selectTakoformCandidates("actor-forward");
  const legacy = await buildEdgeForms();
  const surface = createCloudflareProviderSurface({
    forms: selection.forms,
    retainedForms: [...legacy.forms, ...selection.retainedForms],
    edgeSupplies: edgeSuppliesFixture(),
    objectBucketSupplies: objectBucketSuppliesFixture(),
  });
  expect(surface).not.toBeNull();
  const oldVersion = selection.retainedForms.find(
    ({ identity }) => identity.formRef.kind === "WorkerVersion",
  );
  const recovered = surface?.recoveryOfferings.find(
    ({ form }) => canonicalJson(form) === canonicalJson(oldVersion?.identity.formRef),
  );
  expect(recovered?.id).toBe("cloudflare.edge.stable-v1.workerversion");
  expect(surface?.offerings.find(({ form }) => form.kind === "WorkerVersion")?.id).toBe(
    recovered?.id,
  );
  expect(
    surface?.recoveryOfferings.some(
      ({ form }) =>
        form.kind === "WorkerVersion" && form.apiVersion === "edge.forms.takoform.com/v1beta1",
    ),
  ).toBe(true);
  // Technical runtime presence does not manufacture commercial Actor supply.
  expect(surface?.offerings.some(({ form }) => form.kind === "ActorNamespace")).toBe(false);
});
