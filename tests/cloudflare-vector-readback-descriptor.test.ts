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

/** Synthetic candidate fixture shared with self-host Vector tests; not a published Form identity. */
const VECTOR_FORM = {
  apiVersion: "vector.forms.takoform.com",
  kind: "VectorIndex",
  definitionVersion: "0.1.0-dev.1",
  schemaDigest: `sha256:${"v".repeat(64)}`,
} as const;

const VECTOR_OFFERING: ProviderOffering = {
  id: "candidate.vector-index",
  kind: "takoform.VectorIndex",
  displayName: "Candidate VectorIndex",
  form: VECTOR_FORM,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "delete", "observe"],
};

const IDENTITY = {
  tenantRef: "tenant-a",
  space: "main",
  name: "search",
  uid: "vector-resource-uid",
} as const satisfies ResourceIdentity;

const PROVIDER_ID = "cloudflare.primary";
const NATIVE_ID = "vector:tvi_primary";

describe("Cloudflare WfP VectorIndex readback classification", () => {
  test("routes VectorIndex only as a managed classification, not direct ordinary ownership", () => {
    expect(cloudflareWfpOwnsOffering(VECTOR_OFFERING)).toBe(true);
    expect(cloudflareExecutorDirectOwnsOffering(VECTOR_OFFERING)).toBe(false);
    expect(parseCloudflareNativeId(NATIVE_ID)).toBeNull();
  });

  test("constructs an exact managed Vector descriptor", () => {
    const descriptor = createManagedDescriptor();

    expect(descriptor).toEqual({
      apiVersion: "providers.takoserver.com/readback/v1",
      provider: PROVIDER_ID,
      kind: "takoform.VectorIndex",
      nativeId: NATIVE_ID,
      data: { resourceUid: IDENTITY.uid },
    });
    expect(Object.keys(descriptor).sort()).toEqual([
      "apiVersion",
      "data",
      "kind",
      "nativeId",
      "provider",
    ]);
    expect(Object.keys(descriptor.data).sort()).toEqual(["resourceUid"]);
  });

  test("reads back the exact managed native kind and Resource UID", () => {
    const validated = validateCloudflareNativeReadbackDescriptor({
      providerId: PROVIDER_ID,
      placement: "workers-for-platforms",
      offering: VECTOR_OFFERING,
      descriptor: createManagedDescriptor(),
    });

    expect(validated).toEqual({
      placement: "workers-for-platforms",
      native: { kind: "vector", name: "tvi_primary" },
      resourceUid: IDENTITY.uid,
    });
    if (validated?.placement !== "workers-for-platforms") return;
    expect(Object.keys(validated.native).sort()).toEqual(["kind", "name"]);
    expect(Object.keys(validated).sort()).toEqual(["native", "placement", "resourceUid"]);
  });

  test("rejects malformed, wrong-kind, and open managed descriptors before readback", () => {
    const valid = createManagedDescriptor();
    const invalidNativeIds = [
      "vector:",
      "vector:tvi_primary:extra",
      "vector:-tvi_primary",
      `vector:${"a".repeat(256)}`,
      "worker:tvi_primary",
    ];

    for (const nativeId of invalidNativeIds) {
      expect(() =>
        createCloudflareNativeReadbackDescriptor({
          providerId: PROVIDER_ID,
          placement: "workers-for-platforms",
          readback: { offering: VECTOR_OFFERING, nativeId, identity: IDENTITY },
        }),
      ).toThrow();
      expect(
        validateCloudflareNativeReadbackDescriptor({
          providerId: PROVIDER_ID,
          placement: "workers-for-platforms",
          offering: VECTOR_OFFERING,
          descriptor: { ...valid, nativeId },
        }),
      ).toBeNull();
    }

    expect(
      validateCloudflareNativeReadbackDescriptor({
        providerId: PROVIDER_ID,
        placement: "workers-for-platforms",
        offering: VECTOR_OFFERING,
        descriptor: { ...valid, data: { resourceUid: IDENTITY.uid, extra: true } },
      }),
    ).toBeNull();
    expect(
      validateCloudflareNativeReadbackDescriptor({
        providerId: PROVIDER_ID,
        placement: "workers-for-platforms",
        offering: VECTOR_OFFERING,
        descriptor: { ...valid, kind: "VectorIndex" },
      }),
    ).toBeNull();
  });

  test("ordinary Cloudflare refuses VectorIndex construction and readback", () => {
    expect(() =>
      createCloudflareNativeReadbackDescriptor({
        providerId: PROVIDER_ID,
        placement: "ordinary-workers",
        readback: { offering: VECTOR_OFFERING, nativeId: NATIVE_ID, identity: IDENTITY },
      }),
    ).toThrow();

    const managed = createManagedDescriptor();
    expect(
      validateCloudflareNativeReadbackDescriptor({
        providerId: PROVIDER_ID,
        placement: "ordinary-workers",
        offering: VECTOR_OFFERING,
        descriptor: managed,
      }),
    ).toBeNull();
  });
});

function createManagedDescriptor(): ProviderNativeReadbackDescriptor {
  return createCloudflareNativeReadbackDescriptor({
    providerId: PROVIDER_ID,
    placement: "workers-for-platforms",
    readback: { offering: VECTOR_OFFERING, nativeId: NATIVE_ID, identity: IDENTITY },
  });
}
