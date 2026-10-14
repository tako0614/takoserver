import { expect, test } from "bun:test";
import { openApiDocument } from "../src/openapi.ts";

type Operation = {
  responses: Record<string, { content: { "application/json": { schema: unknown } } }>;
};
const path = openApiDocument.paths[
  "/v1/organizations/{organizationId}/payments/subscription"
] as unknown as { post: Operation; patch: Operation };

function responseContract(component: string, field: string, states: readonly string[]) {
  return {
    allOf: [
      { $ref: `#/components/schemas/${component}` },
      {
        type: "object",
        properties: {
          [field]: { type: "object", properties: { state: { enum: states } } },
        },
      },
    ],
  };
}

test("subscription Checkout schemas constrain receipt state to its HTTP status", () => {
  for (const [status, states] of [
    ["200", ["associated", "expired"]],
    ["201", ["open"]],
    ["202", ["pending"]],
  ] as const) {
    expect(path.post.responses[status]?.content["application/json"].schema).toEqual(
      responseContract("SubscriptionCheckoutResponse", "checkout", states),
    );
  }
});

test("only an associated Checkout receipt requires its exact opaque subscription reference", () => {
  const receipt = openApiDocument.components.schemas.SubscriptionCheckoutReceipt as {
    oneOf: readonly {
      required: readonly string[];
      properties: Record<string, { const?: string; pattern?: string }>;
    }[];
  };
  const associated = receipt.oneOf.find(
    (branch) => branch.properties.state?.const === "associated",
  );
  expect(associated?.required).toEqual(["state", "id", "subscriptionRef"]);
  expect(associated?.properties.subscriptionRef?.pattern).toBe("^sra_[0-9a-f]{64}$");
  for (const branch of receipt.oneOf.filter(
    (item) => item.properties.state?.const !== "associated",
  )) {
    expect(branch.required).not.toContain("subscriptionRef");
  }
});

test("subscription cancellation schemas cannot describe a pending result as verified", () => {
  for (const [status, states] of [
    ["200", ["verified"]],
    ["202", ["pending"]],
  ] as const) {
    expect(path.patch.responses[status]?.content["application/json"].schema).toEqual(
      responseContract("SubscriptionCancellationResponse", "cancellation", states),
    );
  }
});
