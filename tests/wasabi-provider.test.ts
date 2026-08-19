import { describe, expect, test } from "bun:test";
import { buildEdgeForms, objectBucketProviderOffering } from "../src/edge-forms.ts";
import { createWasabiProvider } from "../src/providers/wasabi.ts";

async function fixture(statuses: readonly number[] = [200, 200, 204]) {
  const edge = await buildEdgeForms();
  const offering = objectBucketProviderOffering(edge.objectBucket.form, {
    id: "storage.object.wasabi.eu-central-1",
    displayName: "Object bucket in Wasabi EU Central",
    regions: ["eu-central-1"],
  });
  const requests: Request[] = [];
  let response = 0;
  const provider = createWasabiProvider({
    region: "eu-central-1",
    accessKeyId: "wasabi-public-access-key",
    secretAccessKey: "wasabi-private-secret-key",
    offerings: [offering],
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
    fetch: async (request) => {
      requests.push(request.clone());
      return new Response(null, { status: statuses[response++] ?? 500 });
    },
  });
  return { provider, offering, requests };
}

describe("Wasabi ObjectBucket provisioner", () => {
  test("creates, observes, and deletes one deterministic private S3 bucket", async () => {
    const { provider, offering, requests } = await fixture();
    const identity = { tenantRef: "tenant_alpha", space: "default", name: "assets" };
    const applied = await provider.apply({
      operationId: "op_create",
      offering,
      identity,
      spec: {},
      region: "eu-central-1",
    });
    expect(applied.phase).toBe("succeeded");
    if (applied.phase !== "succeeded") throw new Error("expected success");
    expect(applied.result.nativeId).toMatch(/^wasabi:eu-central-1:ts-[a-f0-9]{40}$/u);
    expect(applied.result.outputs).toMatchObject({
      protocol: "s3",
      endpoint: "https://s3.eu-central-1.wasabisys.com",
      region: "eu-central-1",
    });

    expect(
      (
        await provider.observe({
          offering,
          nativeId: applied.result.nativeId,
          identity,
          spec: {},
        })
      ).phase,
    ).toBe("succeeded");
    expect(
      (
        await provider.delete({
          operationId: "op_delete",
          offering,
          nativeId: applied.result.nativeId,
          identity,
        })
      ).phase,
    ).toBe("succeeded");

    expect(requests.map((request) => request.method)).toEqual(["PUT", "HEAD", "DELETE"]);
    for (const request of requests) {
      expect(request.url).toStartWith("https://s3.eu-central-1.wasabisys.com/ts-");
      expect(request.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 ");
      expect(request.headers.get("authorization")).not.toContain("wasabi-private-secret-key");
    }
  });

  test("adopts the deterministic bucket after a lost create acknowledgement", async () => {
    const { provider, offering, requests } = await fixture([409, 200]);
    const applied = await provider.apply({
      operationId: "op_retry",
      offering,
      identity: { tenantRef: "tenant_alpha", space: "default", name: "assets" },
      spec: {},
      region: "eu-central-1",
    });

    expect(applied.phase).toBe("succeeded");
    expect(requests.map((request) => request.method)).toEqual(["PUT", "HEAD"]);
  });

  test("keeps upstream error bodies behind the provider boundary", async () => {
    const edge = await buildEdgeForms();
    const offering = objectBucketProviderOffering(edge.objectBucket.form, {
      id: "storage.object.wasabi.eu-central-1",
      displayName: "Object bucket",
      regions: ["eu-central-1"],
    });
    const provider = createWasabiProvider({
      region: "eu-central-1",
      accessKeyId: "public-key",
      secretAccessKey: "private-key",
      offerings: [offering],
      fetch: async () =>
        new Response("<Error><Message>PRIVATE-UPSTREAM-DETAIL</Message></Error>", { status: 403 }),
    });

    const result = await provider.apply({
      operationId: "op_denied",
      offering,
      identity: { tenantRef: "tenant", space: "default", name: "assets" },
      spec: {},
    });
    expect(result).toEqual({
      phase: "failed",
      failure: { code: "denied", message: "the credential was refused", retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-UPSTREAM-DETAIL");
  });
});
