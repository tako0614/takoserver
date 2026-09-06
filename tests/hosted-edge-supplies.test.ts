import { describe, expect, test } from "bun:test";
import { HOSTED_EDGE_SUPPLIES_KIND, parseHostedEdgeSupplies } from "../src/hosted-edge-supplies.ts";
import { edgeSuppliesFixture } from "./helpers/hosted-supply-fixtures.ts";

function rawWithFirstOffering(
  overrides: { readonly offeringId?: string; readonly pricePlanId?: string } = {},
): string {
  const value = edgeSuppliesFixture();
  const first = value.offerings[0];
  if (!first) throw new Error("missing edge fixture offering");
  return JSON.stringify({
    kind: HOSTED_EDGE_SUPPLIES_KIND,
    providerInstallation: value.providerInstallation,
    supplyContract: value.supplyContract,
    offerings: [
      {
        ...first,
        ...(overrides.offeringId === undefined ? {} : { offeringId: overrides.offeringId }),
        pricePlan: {
          ...first.pricePlan,
          ...(overrides.pricePlanId === undefined ? {} : { id: overrides.pricePlanId }),
        },
      },
      ...value.offerings.slice(1),
    ],
  });
}

describe("hosted edge supply contract", () => {
  test("requires Offering IDs to fit the durable catalog identity bounds", () => {
    for (const offeringId of ["a", "ab", "a".repeat(256)]) {
      expect(() => parseHostedEdgeSupplies(rawWithFirstOffering({ offeringId }))).toThrow(
        "invalid hosted edge supplies",
      );
    }

    for (const offeringId of ["abc", `a${"b".repeat(254)}`]) {
      expect(
        parseHostedEdgeSupplies(rawWithFirstOffering({ offeringId })).offerings[0]?.offeringId,
      ).toBe(offeringId);
    }
  });

  test("keeps hosted lowercase Offering grammar and one-character price-plan IDs", () => {
    expect(() =>
      parseHostedEdgeSupplies(rawWithFirstOffering({ offeringId: "Compute/Edge" })),
    ).toThrow("invalid hosted edge supplies");

    const parsed = parseHostedEdgeSupplies(rawWithFirstOffering({ pricePlanId: "x" }));
    expect(parsed.offerings[0]?.pricePlan.id).toBe("x");
  });
});
