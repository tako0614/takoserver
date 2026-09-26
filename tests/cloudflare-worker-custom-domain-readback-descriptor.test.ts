import { describe, expect, test } from "bun:test";
import type {
  ProviderNativeReadbackDescriptor,
  ProviderOffering,
  ResourceIdentity,
} from "../src/provider-port.ts";
import {
  cloudflareExecutorDirectOwnsOffering,
  cloudflareWfpOwnsOffering,
  createCloudflareNativeReadbackDescriptor,
  parseCloudflareNativeId,
  validateCloudflareNativeReadbackDescriptor,
} from "../src/providers/cloudflare-readback-descriptor.ts";

const WORKER_CUSTOM_DOMAIN_FORM = {
  apiVersion: "edge.forms.takoform.com",
  kind: "WorkerCustomDomain",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:1e4ae27dd53dfb8db977e3627e0b14f0d5e284703e9c435f48af31bd8e474110",
} as const;

const WORKER_CUSTOM_DOMAIN_OFFERING: ProviderOffering = {
  id: "cloudflare.edge.stable-v1.workercustomdomain",
  kind: "takoform.WorkerCustomDomain",
  displayName: "Worker Custom Domain",
  form: WORKER_CUSTOM_DOMAIN_FORM,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "delete", "import", "observe"],
};

const IDENTITY = {
  tenantRef: "tenant-a",
  space: "main",
  name: "api-domain",
  uid: "worker-domain-resource-uid",
} as const satisfies ResourceIdentity;

const PROVIDER_ID = "cloudflare.primary";
const NATIVE_ID = "domain:zone-domain-id";

describe("Cloudflare WorkerCustomDomain readback descriptor", () => {
  test("classifies the frozen WorkerCustomDomain as managed rather than direct-owned", () => {
    expect(cloudflareWfpOwnsOffering(WORKER_CUSTOM_DOMAIN_OFFERING)).toBe(true);
    expect(cloudflareExecutorDirectOwnsOffering(WORKER_CUSTOM_DOMAIN_OFFERING)).toBe(false);
    expect(parseCloudflareNativeId(NATIVE_ID)).toEqual({
      kind: "domain",
      name: "zone-domain-id",
    });
  });

  test("constructs and validates the managed domain descriptor with its Resource UID", () => {
    const descriptor = createManagedDescriptor();

    expect(descriptor).toEqual({
      apiVersion: "providers.takoserver.com/readback/v1",
      provider: PROVIDER_ID,
      kind: "WorkerCustomDomain",
      nativeId: NATIVE_ID,
      data: { resourceUid: IDENTITY.uid },
    });
    expect(Object.keys(descriptor.data).sort()).toEqual(["resourceUid"]);
    expect(
      validateCloudflareNativeReadbackDescriptor({
        providerId: PROVIDER_ID,
        placement: "workers-for-platforms",
        offering: WORKER_CUSTOM_DOMAIN_OFFERING,
        descriptor,
      }),
    ).toEqual({
      placement: "workers-for-platforms",
      native: { kind: "domain", name: "zone-domain-id" },
      resourceUid: IDENTITY.uid,
    });
  });

  test("refuses a mismatched native kind, descriptor kind, or open managed data", () => {
    const valid = createManagedDescriptor();

    expect(() => createManagedDescriptor("worker:zone-domain-id")).toThrow();
    for (const descriptor of [
      { ...valid, nativeId: "worker:zone-domain-id" },
      { ...valid, nativeId: "domain:" },
      { ...valid, nativeId: "domain:zone-domain-id:extra" },
      { ...valid, kind: "WorkerEndpoint" },
      { ...valid, data: { resourceUid: IDENTITY.uid, extra: true } },
    ]) {
      expect(
        validateCloudflareNativeReadbackDescriptor({
          providerId: PROVIDER_ID,
          placement: "workers-for-platforms",
          offering: WORKER_CUSTOM_DOMAIN_OFFERING,
          descriptor,
        }),
      ).toBeNull();
    }
  });

  test("keeps ordinary domain descriptors on the domainId data contract", () => {
    const ordinary = createCloudflareNativeReadbackDescriptor({
      providerId: PROVIDER_ID,
      placement: "ordinary-workers",
      readback: {
        offering: WORKER_CUSTOM_DOMAIN_OFFERING,
        nativeId: NATIVE_ID,
        identity: IDENTITY,
      },
    });

    expect(ordinary.data).toEqual({ domainId: "zone-domain-id" });
    expect(
      validateCloudflareNativeReadbackDescriptor({
        providerId: PROVIDER_ID,
        placement: "ordinary-workers",
        offering: WORKER_CUSTOM_DOMAIN_OFFERING,
        descriptor: ordinary,
      }),
    ).toEqual({
      placement: "ordinary-workers",
      native: { kind: "domain", name: "zone-domain-id" },
    });
    expect(
      validateCloudflareNativeReadbackDescriptor({
        providerId: PROVIDER_ID,
        placement: "ordinary-workers",
        offering: WORKER_CUSTOM_DOMAIN_OFFERING,
        descriptor: createManagedDescriptor(),
      }),
    ).toBeNull();
  });
});

function createManagedDescriptor(nativeId = NATIVE_ID): ProviderNativeReadbackDescriptor {
  return createCloudflareNativeReadbackDescriptor({
    providerId: PROVIDER_ID,
    placement: "workers-for-platforms",
    readback: {
      offering: WORKER_CUSTOM_DOMAIN_OFFERING,
      nativeId,
      identity: IDENTITY,
    },
  });
}
