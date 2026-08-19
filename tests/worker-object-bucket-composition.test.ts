import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { HOSTED_OBJECT_BUCKET_SUPPLIES_KIND } from "../src/hosted-object-bucket-supplies.ts";
import { createWorkerObjectBucketComposition } from "../src/worker-object-bucket-composition.ts";

const s3CredentialIssuer = {
  limits: () => ({ minimumSeconds: 60, maximumSeconds: 3_600, defaultSeconds: 900 }),
  async issue(): Promise<never> {
    throw new Error("not used by composition");
  },
};

const supply = (provider: "cloudflare" | "wasabi") => ({
  offeringId: `storage.object.${provider}`,
  displayName: `${provider} object storage`,
  provider:
    provider === "cloudflare"
      ? { kind: "cloudflare" }
      : {
          kind: "wasabi",
          region: "eu-central-2",
          roleArn: "arn:aws:iam::1234567890:role/takoserver-bucket-access",
        },
  providerInstallation: {
    id: `${provider}.primary`,
    providerPackRef: provider,
    supplyContractRef: `${provider}.contract`,
    state: "active",
    regions: [{ id: provider === "cloudflare" ? "global" : "eu-central-2", capacity: "available" }],
  },
  supplyContract: {
    id: `${provider}.contract`,
    providerType: provider,
    permittedResourceClasses: ["storage.object"],
    deliveryModes: ["native-credentials"],
    customerAccess: "scoped-native-access",
    whiteLabelAllowed: true,
    endUserTermsRequired: true,
    regions: [provider === "cloudflare" ? "global" : "eu-central-2"],
    validFrom: "2026-01-01T00:00:00.000Z",
    evidenceRef: `private:${provider}`,
  },
  pricePlan: {
    id: `storage.object.${provider}.price-v1`,
    currency: "USD",
    recurring: { meter: "bucket-month", amountMinor: 500 },
    meters:
      provider === "cloudflare"
        ? [
            { meter: "storage.gib-hour", amountMinor: 2, quantity: 720 },
            { meter: "requests.million", amountMinor: 50 },
          ]
        : [
            { meter: "storage.gib-hour", amountMinor: 3, quantity: 720 },
            { meter: "requests.million", amountMinor: 60 },
            { meter: "egress.gib", amountMinor: 1 },
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
});

describe("Worker ObjectBucket composition", () => {
  test("compiles Cloudflare and Wasabi supplies from private configuration", async () => {
    const edge = await buildEdgeForms();
    const composed = createWorkerObjectBucketComposition({
      env: {
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify({
          kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
          supplies: [supply("cloudflare"), supply("wasabi")],
        }),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        TAKOSERVER_WASABI_ACCESS_KEY_ID: "wasabi-key",
        TAKOSERVER_WASABI_SECRET_ACCESS_KEY: "wasabi-secret",
      },
      form: edge.objectBucket.form,
      artifacts: { manifest: async () => null, blob: async () => null },
      s3CredentialIssuer,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(composed.offerings.map((offering) => offering.id).sort()).toEqual([
      "storage.object.cloudflare",
      "storage.object.wasabi",
    ]);
    expect(composed.providers.map((provider) => provider.id).sort()).toEqual([
      "cloudflare",
      "wasabi",
    ]);
    expect(composed.providerPacks.map((pack) => pack.descriptor.meterSources)).toEqual([
      ["requests.million", "storage.gib-hour"],
      ["egress.gib", "requests.million", "storage.gib-hour"],
    ]);
    expect(composed.providerPacks.every((pack) => pack.attachmentFactories.length === 1)).toBe(
      true,
    );
  });

  test("never infers a sellable Offering from an ambient credential", async () => {
    const edge = await buildEdgeForms();
    expect(() =>
      createWorkerObjectBucketComposition({
        env: { CLOUDFLARE_ACCOUNT_ID: "account-id", CLOUDFLARE_API_TOKEN: "token" },
        form: edge.objectBucket.form,
        artifacts: { manifest: async () => null, blob: async () => null },
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow("provider credentials require hosted ObjectBucket supplies");
  });

  test("does not publish native-credential storage without the credential broker", async () => {
    const edge = await buildEdgeForms();
    expect(() =>
      createWorkerObjectBucketComposition({
        env: {
          TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify({
            kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
            supplies: [supply("cloudflare")],
          }),
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          CLOUDFLARE_API_TOKEN: "cloudflare-token",
        },
        form: edge.objectBucket.form,
        artifacts: { manifest: async () => null, blob: async () => null },
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow("hosted ObjectBucket supplies require an S3 credential issuer");
  });
});
