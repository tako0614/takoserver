import { describe, expect, test } from "bun:test";
import { HOSTED_OBJECT_BUCKET_SUPPLIES_KIND } from "../src/hosted-object-bucket-supplies.ts";
import { createWorkerDataServices } from "../src/worker-data-services.ts";

const MODELS = JSON.stringify([
  {
    id: "takoserver-text",
    upstreamId: "@cf/meta/llama-3.1-8b-instruct",
    created: 1_787_054_400,
    ownedBy: "takoserver",
    maxInputTokens: 24_000,
    maxOutputTokens: 4_096,
    inputMinorPerMillionTokens: 40,
    outputMinorPerMillionTokens: 300,
  },
]);

describe("Worker data service composition", () => {
  const cloudflareSupply = JSON.stringify({
    kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
    supplies: [
      {
        offeringId: "storage.object.cloudflare",
        displayName: "Object storage",
        provider: { kind: "cloudflare" },
        providerInstallation: {
          id: "cloudflare.primary",
          providerPackRef: "cloudflare",
          supplyContractRef: "cloudflare.contract",
          state: "active",
          regions: [{ id: "global", capacity: "available" }],
        },
        supplyContract: {
          id: "cloudflare.contract",
          providerType: "cloudflare",
          permittedResourceClasses: ["storage.object"],
          deliveryModes: ["native-credentials"],
          customerAccess: "scoped-native-access",
          whiteLabelAllowed: true,
          endUserTermsRequired: false,
          regions: ["global"],
          validFrom: "2026-01-01T00:00:00.000Z",
          evidenceRef: "private:cloudflare",
        },
        pricePlan: {
          id: "storage.object.cloudflare.price-v1",
          currency: "USD",
          provisioning: { meter: "resource.create", amountMinor: 0 },
          meters: [
            { meter: "storage.gib-hour", amountMinor: 2, quantity: 720 },
            { meter: "requests.million", amountMinor: 50 },
          ],
        },
        placement: {
          deliveryMode: "native-credentials",
          supportPolicyRef: "support:hosted:standard",
          abusePolicyRef: "abuse:hosted:standard",
          portability: {
            api: "portable",
            exportFormats: ["s3.object-set.takoform.com/v1"],
            importFormats: ["s3.object-set.takoform.com/v1"],
            migrationModes: ["offline"],
          },
          isolation: "dedicated-resource",
        },
      },
    ],
  });
  test("keeps ordinary AI and S3 absent unless the operator configures them", () => {
    expect(createWorkerDataServices({})).toEqual({});
  });

  test("composes exact public AI models and standard S3 credentials", () => {
    const AI = { async run() {} };
    const services = createWorkerDataServices({
      AI,
      CLOUDFLARE_ACCOUNT_ID: "account_01",
      TAKOSERVER_AI_MODELS: MODELS,
      TAKOSERVER_R2_PARENT_ACCESS_KEY_ID: "parent-key",
      TAKOSERVER_R2_PARENT_TOKEN: "a".repeat(64),
      TAKOSERVER_OBJECT_BUCKET_SUPPLIES: cloudflareSupply,
    });
    expect(services.ai?.models).toEqual([
      {
        id: "takoserver-text",
        created: 1_787_054_400,
        ownedBy: "takoserver",
        limits: { maxInputTokens: 24_000, maxOutputTokens: 4_096 },
        price: { inputMinorPerMillionTokens: 40, outputMinorPerMillionTokens: 300 },
      },
    ]);
    expect(services.s3).toBeDefined();
    expect(JSON.stringify(services)).not.toContain("a".repeat(64));
  });

  test("refuses partial or malformed operator configuration", () => {
    expect(() => createWorkerDataServices({ TAKOSERVER_AI_MODELS: MODELS })).toThrow(
      "AI binding is not configured",
    );
    expect(() =>
      createWorkerDataServices({ TAKOSERVER_OBJECT_BUCKET_SUPPLIES: cloudflareSupply }),
    ).toThrow("S3 credential issuer is not fully configured");
    expect(() =>
      createWorkerDataServices({
        CLOUDFLARE_ACCOUNT_ID: "account_01",
        TAKOSERVER_AI_MODELS: MODELS,
      }),
    ).toThrow("AI binding is not configured");
    expect(() =>
      createWorkerDataServices({
        CLOUDFLARE_ACCOUNT_ID: "account_01",
        TAKOSERVER_R2_PARENT_ACCESS_KEY_ID: "parent-key",
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: cloudflareSupply,
      }),
    ).toThrow("S3 credential issuer is not fully configured");
    expect(() =>
      createWorkerDataServices({
        CLOUDFLARE_ACCOUNT_ID: "account_01",
        TAKOSERVER_R2_PARENT_ACCESS_KEY_ID: "parent-key",
        TAKOSERVER_R2_PARENT_TOKEN: "not-a-parent-secret",
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: cloudflareSupply,
      }),
    ).toThrow();
  });
});
