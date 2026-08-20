import { describe, expect, test } from "bun:test";
import type { Offering } from "../console/src/api.ts";
import {
  offeringInterfaceLabels,
  offeringPriceLines,
  recurringPriceSentence,
} from "../console/src/offering-view.ts";

const OFFERING = {
  id: "storage.object.standard",
  kind: "ObjectBucket",
  displayName: "Object storage",
  form: {
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "ObjectBucket",
    definitionVersion: "0.1.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  pricePlan: {
    id: "storage.object.standard.v1",
    currency: "USD",
    recurring: { meter: "resource-month", amountMinor: 500 },
    meters: [
      { meter: "storage.gib-hour", amountMinor: 1 },
      { meter: "requests.million", amountMinor: 30, quantity: 1_000_000 },
    ],
  },
  resourceClass: "storage.object",
  deliveryMode: "native-credentials",
  providedInterfaces: [
    {
      apiVersion: "interfaces.takoform.com/v1alpha1",
      name: "object.s3.takoform.com",
      version: "1.0.0",
      schemaDigest: `sha256:${"b".repeat(64)}`,
    },
  ],
  bindingRefs: [],
  regions: ["global"],
  portability: {
    api: "portable",
    exportFormats: ["s3.object-set.takoform.com/v1"],
    importFormats: ["s3.object-set.takoform.com/v1"],
    migrationModes: ["offline", "online"],
  },
  isolation: "dedicated-resource",
  digest: `sha256:${"c".repeat(64)}`,
} satisfies Offering;

describe("console Offering view", () => {
  test("renders the current multi-meter catalog response without a legacy unit price", () => {
    expect(offeringPriceLines(OFFERING)).toEqual([
      "$5.00 / resource-month",
      "$0.01 / storage.gib-hour",
      "$0.30 / 1,000,000 requests.million",
    ]);
    expect(recurringPriceSentence(OFFERING)).toBe(
      "$5.00 per resource-month — held when you apply, charged when it succeeds.",
    );
  });

  test("labels exact portable Interfaces rather than the removed protocol field", () => {
    expect(offeringInterfaceLabels(OFFERING)).toEqual(["object.s3.takoform.com@1.0.0"]);
  });
});
