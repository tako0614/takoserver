import { describe, expect, test } from "bun:test";
import type { AttachmentFactory } from "../src/attachments.ts";
import { createProviderPack, type ProviderPackDefinition } from "../src/provider-pack.ts";
import type { Provider, ProviderOffering } from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";

const FORM = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const OBJECTS = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "object.s3.takoform.com",
  version: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
} as const;

const OFFERING: ProviderOffering = {
  id: "storage.s3.wasabi.ap-northeast",
  kind: "object_bucket",
  displayName: "S3 bucket",
  form: FORM,
  providedInterfaces: [OBJECTS],
  bindingRefs: [],
  regions: ["ap-northeast"],
  capabilities: ["create", "update", "delete", "import", "observe"],
};

function pack(overrides: Partial<ProviderPackDefinition> = {}) {
  const provisioner: Provider = new FakeProvider({ id: "wasabi-s3", offerings: [OFFERING] });
  const attachmentFactory: AttachmentFactory = {
    id: "wasabi-s3-credentials",
    providerPackRef: "wasabi",
    supports: ({ interfaceRef }) => interfaceRef.name === OBJECTS.name,
    resolve: async () => ({ kind: "credential-grant-ref", ref: "grant:s3:test" }),
  };
  return createProviderPack({
    id: "wasabi",
    providerType: "wasabi",
    provisioners: [provisioner],
    attachmentFactories: [attachmentFactory],
    transferEndpoints: [
      {
        id: "wasabi-s3-transfer",
        exportFormats: ["s3.object-set.takoform.com/v1"],
        importFormats: ["s3.object-set.takoform.com/v1"],
        migrationModes: ["offline", "online"],
        startExport: async () => ({ operationRef: "transfer:export:test" }),
        startImport: async () => ({ operationRef: "transfer:import:test" }),
      },
    ],
    credentialIssuers: [
      {
        id: "wasabi-s3-temporary-credential",
        interfaceRefs: [OBJECTS],
        issue: async () => ({ grantRef: "grant:s3:test", expiresAt: "2026-08-18T01:00:00.000Z" }),
      },
    ],
    meterSources: [
      {
        id: "wasabi-storage",
        meters: ["storage.gib-hour", "egress.gib", "requests.million"],
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
    expect(wasabi.provisionerForOffering(OFFERING.id).id).toBe("wasabi-s3");
    expect(JSON.stringify(wasabi)).not.toMatch(/price|supplyContract|credentialValue/u);
  });

  test("fails closed when two provisioners claim one Offering", () => {
    const duplicate = new FakeProvider({ id: "wasabi-shadow", offerings: [OFFERING] });

    expect(() =>
      pack({ provisioners: [new FakeProvider({ offerings: [OFFERING] }), duplicate] }),
    ).toThrow("ambiguous Provider Pack offering");
  });
});
