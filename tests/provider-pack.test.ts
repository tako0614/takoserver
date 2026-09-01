import { describe, expect, test } from "bun:test";
import { createProviderPack, type ProviderPackDefinition } from "../src/provider-pack.ts";
import type { Provider, ProviderOffering } from "../src/provider-port.ts";
import { EDGE_OBJECTS_BINDING_REF } from "../src/providers/cloudflare-runtime-bindings.ts";
import { FakeProvider } from "../src/providers/fake.ts";

const FORM = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const OBJECTS = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "edge.objects",
  version: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
} as const;

const OFFERING: ProviderOffering = {
  id: "storage.object.wasabi.ap-northeast",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: FORM,
  providedInterfaces: [OBJECTS],
  bindingRefs: [],
  regions: ["ap-northeast"],
  capabilities: ["create", "update", "delete", "import", "observe"],
};

function pack(overrides: Partial<ProviderPackDefinition> = {}) {
  const provisioner: Provider = new FakeProvider({ id: "wasabi-object", offerings: [OFFERING] });
  return createProviderPack({
    id: "wasabi",
    providerType: "wasabi",
    provisioners: [provisioner],
    attachmentFactories: [],
    transferEndpoints: [],
    credentialIssuers: [],
    meterSources: [
      {
        id: "wasabi-storage",
        meters: ["storage.gib-hour", "egress.gib", "requests.million"],
        settlementDelaySeconds: 0,
        maximumWindowSeconds: 86_400,
        read: async () => [],
      },
    ],
    costEstimators: [
      {
        id: "wasabi-cost",
        meters: ["storage.gib-hour", "egress.gib", "requests.million"],
        estimate: async () => ({ currency: "USD", amountMinor: 0 }),
      },
    ],
    ...overrides,
  });
}

describe("Provider Pack capabilities", () => {
  test("derives technical Catalog capabilities without commercial terms", () => {
    const wasabi = pack();

    expect(wasabi.descriptor).toEqual({
      id: "wasabi",
      providerType: "wasabi",
      forms: [FORM],
      providedInterfaces: [OBJECTS],
      bindingRefs: [],
      meterSources: ["egress.gib", "requests.million", "storage.gib-hour"],
    });
    expect(wasabi.provisionerForOffering(OFFERING.id).id).toBe("wasabi-object");
    expect(JSON.stringify(wasabi)).not.toMatch(/price|supplyContract|credentialValue/u);
  });

  test("fails closed when two provisioners claim one Offering", () => {
    const duplicate = new FakeProvider({ id: "wasabi-shadow", offerings: [OFFERING] });

    expect(() =>
      pack({ provisioners: [new FakeProvider({ offerings: [OFFERING] }), duplicate] }),
    ).toThrow("ambiguous Provider Pack offering");
  });

  test("does not advertise an importer-only Binding before deployment composition proves a target route", () => {
    const consumer: ProviderOffering = {
      ...OFFERING,
      id: "compute.worker-version.consumer",
      kind: "takoform.WorkerVersion",
      form: { ...FORM, kind: "WorkerVersion" },
      providedInterfaces: [],
      bindingRefs: [EDGE_OBJECTS_BINDING_REF],
    };
    const provider = new FakeProvider({ id: "consumer", offerings: [consumer] });
    const incomplete = pack({
      provisioners: [provider],
      runtimeBindingMaterializer: {
        id: "consumer-runtime-bindings",
        importer: {
          routes: [
            {
              bindingRef: EDGE_OBJECTS_BINDING_REF,
              materialKind: "test.object-capability@v1",
            },
          ],
          async importBinding() {
            return { kind: "private-test" };
          },
        },
      },
    });

    expect(incomplete.descriptor.bindingRefs).toEqual([]);
  });
});
