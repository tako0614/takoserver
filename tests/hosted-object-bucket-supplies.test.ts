import { describe, expect, test } from "bun:test";
import {
  HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
  parseHostedObjectBucketSupplies,
} from "../src/hosted-object-bucket-supplies.ts";

const SUPPLY = {
  offeringId: "storage.object.wasabi.eu-central-2",
  displayName: "Object storage EU",
  provider: {
    kind: "wasabi",
    region: "eu-central-2",
    roleArn: "arn:aws:iam::1234567890:role/takoserver-bucket-access",
  },
  providerInstallation: {
    id: "wasabi.primary",
    providerPackRef: "wasabi",
    supplyContractRef: "wasabi.reseller-2026",
    state: "active",
    regions: [{ id: "eu-central-2", capacity: "available" }],
  },
  supplyContract: {
    id: "wasabi.reseller-2026",
    providerType: "wasabi",
    permittedResourceClasses: ["storage.object"],
    deliveryModes: ["embedded-binding"],
    customerAccess: "operator-only",
    whiteLabelAllowed: true,
    endUserTermsRequired: true,
    regions: ["eu-central-2"],
    validFrom: "2026-08-01T00:00:00.000Z",
    evidenceRef: "private-contract:wasabi:2026",
  },
  pricePlan: {
    id: "storage.object.wasabi.eu-central-2.price-v1",
    currency: "USD",
    provisioning: { meter: "resource.create", amountMinor: 0 },
    meters: [
      { meter: "storage.gib-hour", amountMinor: 3, quantity: 720 },
      { meter: "requests.million", amountMinor: 60 },
      { meter: "egress.gib", amountMinor: 1 },
    ],
  },
  placement: {
    deliveryMode: "embedded-binding",
    supportPolicyRef: "support:hosted:standard",
    abusePolicyRef: "abuse:hosted:standard",
    portability: {
      api: "portable",
      exportFormats: [],
      importFormats: [],
      migrationModes: [],
    },
    isolation: "dedicated-resource",
  },
} as const;

describe("hosted ObjectBucket supply contract", () => {
  test("accepts private S3 supply only behind the portable object-bucket Binding", () => {
    const parsed = parseHostedObjectBucketSupplies(
      JSON.stringify({ kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND, supplies: [SUPPLY] }),
    );
    expect(parsed.supplies[0]).toEqual(SUPPLY);
    expect(JSON.stringify(parsed)).not.toMatch(/accessKey|secret|token/iu);
  });

  test("does not turn ObjectBucket authority into public native-credential retail", () => {
    expect(() =>
      parseHostedObjectBucketSupplies(
        JSON.stringify({
          kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
          supplies: [
            {
              ...SUPPLY,
              supplyContract: {
                ...SUPPLY.supplyContract,
                deliveryModes: ["native-credentials"],
                customerAccess: "scoped-native-access",
              },
              placement: { ...SUPPLY.placement, deliveryMode: "native-credentials" },
            },
          ],
        }),
      ),
    ).toThrow("invalid hosted ObjectBucket supplies");
  });

  test("rejects provider identity drift and duplicate providers", () => {
    expect(() =>
      parseHostedObjectBucketSupplies(
        JSON.stringify({
          kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
          supplies: [
            {
              ...SUPPLY,
              providerInstallation: {
                ...SUPPLY.providerInstallation,
                providerPackRef: "cloudflare",
              },
            },
          ],
        }),
      ),
    ).toThrow("invalid hosted ObjectBucket supplies");
    expect(() =>
      parseHostedObjectBucketSupplies(
        JSON.stringify({ kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND, supplies: [SUPPLY, SUPPLY] }),
      ),
    ).toThrow("invalid hosted ObjectBucket supplies");
  });

  test("rejects duplicate JSON members before ordinary parsing", () => {
    expect(() =>
      parseHostedObjectBucketSupplies(
        `{"kind":"${HOSTED_OBJECT_BUCKET_SUPPLIES_KIND}","kind":"wrong","supplies":[]}`,
      ),
    ).toThrow();
  });
});
