import { describe, expect, test } from "bun:test";
import { edgeProviderOffering } from "../src/edge-forms.ts";
import { parseHostedEdgeSupplies } from "../src/hosted-edge-supplies.ts";
import {
  type CloudflareProviderExecutorRpc,
  CloudflareProviderProxy,
  cloudflareExecutorDirectOwnsOffering,
  cloudflareWfpOwnsOffering,
  createCloudflareNativeReadbackDescriptor,
  createCloudflareProviderSurface,
  validateCloudflareNativeReadbackDescriptor,
} from "../src/provider-extension.ts";
import { parseCloudflareNativeId } from "../src/providers/cloudflare-readback-descriptor.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import { edgeSuppliesFixture } from "./helpers/hosted-supply-fixtures.ts";

const form = stableProductionTakoformCatalog().forms.find(
  (candidate) => candidate.identity.formRef.kind === "ActorNamespace",
);
if (!form) throw new Error("published ActorNamespace Form missing");
const offering = edgeProviderOffering(form, { id: "actor.test" });
const identity = { tenantRef: "tenant-a", space: "main", name: "counter", uid: "actor-uid" };
const providerId = "cloudflare.test";
const namespaceId = "0123456789abcdef0123456789abcdef";
const nativeId = `actor:${namespaceId}`;

function descriptor(id = nativeId) {
  return createCloudflareNativeReadbackDescriptor({
    providerId,
    placement: "workers-for-platforms",
    readback: { offering, identity, nativeId: id },
  });
}

describe("Cloudflare ActorNamespace provider-internal readback", () => {
  test("routes only to the managed backend, with frozen lifecycle meaning", () => {
    expect(cloudflareWfpOwnsOffering(offering)).toBe(true);
    expect(cloudflareExecutorDirectOwnsOffering(offering)).toBe(false);
    expect(parseCloudflareNativeId(nativeId)).toBeNull();
    expect(form.role).toBe("identity");
    expect(offering.capabilities).toEqual(["create", "delete", "import", "observe"]);
  });

  test("roundtrips an exact native namespace and Resource UID without owner metadata", () => {
    const value = descriptor();
    expect(value).toEqual({
      apiVersion: "providers.takoserver.com/readback/v1",
      provider: providerId,
      kind: "ActorNamespace",
      nativeId,
      data: { resourceUid: identity.uid },
    });
    expect(
      validateCloudflareNativeReadbackDescriptor({
        providerId,
        placement: "workers-for-platforms",
        offering,
        descriptor: value,
      }),
    ).toEqual({
      placement: "workers-for-platforms",
      native: { kind: "actor", name: namespaceId },
      resourceUid: identity.uid,
    });
  });

  test("rejects malformed namespace IDs and mismatched or open descriptors", () => {
    const value = descriptor();
    for (const id of [
      "actor:",
      `actor:${"a".repeat(31)}`,
      `actor:${"a".repeat(33)}`,
      `actor:${"A".repeat(32)}`,
      `actor:${"g".repeat(32)}`,
      `actor:${namespaceId}:extra`,
      `actor:${namespaceId}\n`,
      `worker:${namespaceId}`,
    ]) {
      expect(() => descriptor(id)).toThrow();
      expect(
        validateCloudflareNativeReadbackDescriptor({
          providerId,
          placement: "workers-for-platforms",
          offering,
          descriptor: { ...value, nativeId: id },
        }),
      ).toBeNull();
    }
    for (const invalid of [
      { ...value, kind: "ModuleWorker" },
      { ...value, provider: "cloudflare.other" },
      { ...value, data: { resourceUid: "" } },
      { ...value, data: { resourceUid: "x".repeat(129) } },
      { ...value, data: { resourceUid: identity.uid, ownerScript: "untrusted" } },
    ]) {
      expect(
        validateCloudflareNativeReadbackDescriptor({
          providerId,
          placement: "workers-for-platforms",
          offering,
          descriptor: invalid,
        }),
      ).toBeNull();
    }
    expect(() =>
      createCloudflareNativeReadbackDescriptor({
        providerId,
        placement: "ordinary-workers",
        readback: { offering, identity, nativeId },
      }),
    ).toThrow();
    expect(
      validateCloudflareNativeReadbackDescriptor({
        providerId,
        placement: "ordinary-workers",
        offering,
        descriptor: value,
      }),
    ).toBeNull();
  });

  test("public proxy constructs the managed descriptor locally without an executor call", () => {
    const binding = new Proxy({} as CloudflareProviderExecutorRpc, {
      get() {
        throw new Error("descriptor construction must not call the executor");
      },
    });
    const proxy = new CloudflareProviderProxy({
      id: providerId,
      offerings: [],
      providerInstallationId: "cloudflare.installation",
      managedBaseDomain: "workers.example.test",
      binding,
    });
    expect(proxy.createNativeReadbackDescriptor({ offering, identity, nativeId })).toEqual(
      descriptor(),
    );
    expect(proxy.offerings).toEqual([]);
  });

  test("technical routing does not invent a commercial Actor supply or relation offering", () => {
    const supplies = edgeSuppliesFixture();
    const surface = createCloudflareProviderSurface({
      forms: stableProductionTakoformCatalog().forms,
      objectBucketSupplies: null,
      edgeSupplies: supplies,
    });
    expect(surface).not.toBeNull();
    expect(surface?.offerings.map((candidate) => candidate.form.kind)).not.toContain(
      "ActorNamespace",
    );
    expect(() =>
      parseHostedEdgeSupplies(
        JSON.stringify({
          ...supplies,
          offerings: [{ ...supplies.offerings[0], formKind: "ActorNamespace" }],
        }),
      ),
    ).toThrow("invalid hosted edge supplies");
  });
});
