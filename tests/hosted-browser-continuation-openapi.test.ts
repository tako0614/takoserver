import { describe, expect, test } from "bun:test";
import {
  hostedBrowserContinuationMetadata,
  parseHostedBrowserBillingOriginal,
} from "../src/financial-hosted-browser-continuation.ts";
import { openApiDocument } from "../src/openapi.ts";
import { ROUTES } from "../src/route-table.ts";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value as RecordValue;
}

function operation(path: string, method: string): RecordValue {
  return record(record(openApiDocument.paths)[path])[method] as RecordValue;
}

function parameters(path: string, method: string): RecordValue[] {
  return operation(path, method).parameters as RecordValue[];
}

describe("Hosted browser billing continuation OpenAPI", () => {
  test("declares one strict selector route requiring the authenticated shared RP", () => {
    expect(ROUTES).toContainEqual({
      method: "get",
      pattern: "/v1/billing/hosted-continuations/{continuationRef}",
      operation: "readHostedBrowserBillingContinuation",
    });

    const view = operation("/v1/billing/hosted-continuations/{continuationRef}", "get");
    expect(view.security).toEqual([{ serverSharedSession: [] }]);
    expect(parameters("/v1/billing/hosted-continuations/{continuationRef}", "get")).toContainEqual({
      name: "continuationRef",
      in: "path",
      required: true,
      schema: {
        type: "string",
        minLength: 64,
        maxLength: 64,
        pattern: "^[0-9a-f]{64}$",
        description: "Opaque Hosted browser continuation selector.",
      },
    });
    expect(view.description).toContain("exact configured Console Origin");
    expect(view.responses).toMatchObject({
      "503": {
        description:
          "Hosted continuation is unknown, missing, or its supplier/current billing authority or matching account/session/Workspace scope is unavailable",
      },
      "403": {
        description: "Current Workspace or Hosted authorization denies this request",
      },
      "404": { description: "Organization is absent or not currently owned by this user" },
    });
    expect(record(openApiDocument.components.securitySchemes).serverSharedSession).toMatchObject({
      in: "cookie",
      name: "__Host-takoserver_shared_session",
    });
  });

  test("declares preparation as a shared-RP-only closed explicit choice with no effect result", () => {
    expect(ROUTES).toContainEqual({
      method: "post",
      pattern: "/v1/billing/hosted-continuations/{continuationRef}",
      operation: "prepareHostedBrowserBillingContinuation",
    });

    const prepare = operation("/v1/billing/hosted-continuations/{continuationRef}", "post");
    expect(prepare.security).toEqual([{ serverSharedSession: [] }]);
    expect(parameters("/v1/billing/hosted-continuations/{continuationRef}", "post")).toEqual([
      {
        name: "continuationRef",
        in: "path",
        required: true,
        schema: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          pattern: "^[0-9a-f]{64}$",
          description: "Opaque Hosted browser continuation selector.",
        },
      },
    ]);
    expect(prepare.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/PrepareHostedBrowserBillingContinuationRequest" },
        },
      },
    });
    expect(prepare.responses).toMatchObject({
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/HostedBrowserBillingContinuationResponse" },
          },
        },
      },
      "409": {},
      "404": { description: "Organization is absent or not currently owned by this user" },
      "503": {},
    });
  });

  test("publishes only the four closed preparation choices and their explicit consent fields", () => {
    const choiceSchema = record(
      record(openApiDocument.components.schemas).PrepareHostedBrowserBillingContinuationRequest,
    );
    const variants = choiceSchema.oneOf as RecordValue[];
    expect(variants).toHaveLength(4);

    const expected = [
      ["topup", ["kind", "amountMinor", "checkoutConsent"]],
      ["start", ["kind", "planKey", "consent", "reconcileOriginalConsent"]],
      ["cancel", ["kind", "consent"]],
      ["change-plan", ["kind", "planKey", "consent"]],
    ] as const;
    expect(
      variants.map((variant) => {
        const properties = record(variant.properties);
        return [record(properties.kind).const, Object.keys(properties).sort()];
      }),
    ).toEqual(expected.map(([kind, fields]) => [kind, [...fields].sort()]));
    for (const variant of variants) expect(variant.additionalProperties).toBe(false);

    const serialized = JSON.stringify(choiceSchema);
    expect(serialized).toContain('"interactive-checkout"');
    expect(serialized).toContain('"subscription-checkout"');
    expect(serialized).toContain('"cancel-subscription"');
    expect(serialized).toContain('"change-subscription-plan"');
    expect(serialized).toContain('"retry-original-subscription"');
    expect(serialized).toContain('"check-original-subscription"');
    expect(serialized).not.toMatch(
      /accountId|organizationId|workspaceId|expectedSubscriptionRef|reference|operationKey/iu,
    );
  });

  test("publishes a closed view/payment DTO with action-correlated existing operations", () => {
    const schemas = record(openApiDocument.components.schemas);
    const continuationSchema = JSON.stringify(schemas.HostedBrowserBillingContinuation);
    const operationSchema = JSON.stringify(schemas.HostedBrowserBillingContinuationOperation);

    expect(schemas.HostedBrowserBillingContinuationResponse).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["continuation"],
    });
    expect(continuationSchema).toContain('"contractVersion":{"const":"hosted-browser-v1"}');
    expect(continuationSchema).toContain('"kind":{"const":"view"}');
    expect(continuationSchema).toContain('"kind":{"const":"payment"}');
    expect(continuationSchema).toContain('"phase":{"type":"null"}');
    expect(continuationSchema).toContain(
      '"phase":{"type":"string","enum":["prepared","dispatch-started","outcome-recorded"]}',
    );
    expect(continuationSchema).not.toContain('"phase":{"anyOf"');
    expect(continuationSchema).toContain('"prepared"');
    expect(continuationSchema).toContain('"dispatch-started"');
    expect(continuationSchema).toContain('"outcome-recorded"');
    expect(operationSchema).toContain('"action":{"const":"topup"}');
    expect(operationSchema).toContain('"action":{"const":"subscription-start"}');
    expect(operationSchema).toContain('"action":{"const":"cancel"}');
    expect(operationSchema).toContain('"action":{"const":"plan-change"}');
    expect(operationSchema).toContain('"method":{"const":"PATCH"}');
    expect(operationSchema).toContain("#/components/schemas/BeginSubscriptionRequest");
    expect(operationSchema).toContain("#/components/schemas/ChangeSubscriptionRequest");
    expect(operationSchema).toContain("#/components/schemas/SubscriptionPlanChangeRequest");
    expect(continuationSchema + operationSchema).not.toMatch(
      /rawSourceEpoch|historicalOwner|sourceEpoch/iu,
    );
  });

  test("path schemas accept the actual scoped paths emitted by the metadata builder", () => {
    const scope = {
      continuationRef: "a".repeat(64),
      canonicalAccountId: "account-a",
      workspaceId: "workspace-a",
      workspaceRef: "workspace-ref-a",
      organizationId: "org-a",
      billingSourceRef: "source-a",
      sourceEpoch: "epoch-a",
    };
    const reference = `takosumi:topup:${"b".repeat(64)}`;
    const original = parseHostedBrowserBillingOriginal({
      contractVersion: "hosted-browser-v1",
      scope,
      action: {
        family: "topup",
        request: {
          workspaceId: scope.workspaceId,
          operationKey: "operation-a",
          amountMinor: 50,
          checkoutConsent: "interactive-checkout",
        },
        claim: {
          ownerId: "owner-a",
          organizationId: scope.organizationId,
          billingSourceRef: scope.billingSourceRef,
          operationKey: "operation-a",
          reference,
          amountMinor: 50,
        },
      },
    });
    const metadata = hostedBrowserContinuationMetadata({
      kind: "payment",
      original,
      custody: { phase: "prepared" },
    });
    const emittedOperation = metadata.continuation.operation;
    if (!emittedOperation) throw new Error("payment metadata must include its operation");
    expect(emittedOperation.path).toBe("/v1/organizations/org-a/wallet/checkout");

    const operationSchema = record(
      record(openApiDocument.components.schemas).HostedBrowserBillingContinuationOperation,
    );
    const variants = operationSchema.oneOf as RecordValue[];
    const expectedPaths = {
      topup: "^/v1/organizations/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}/wallet/checkout$",
      "subscription-start":
        "^/v1/organizations/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}/payments/subscription$",
      cancel: "^/v1/organizations/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}/payments/subscription$",
      "plan-change": "^/v1/organizations/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}/payments/subscription$",
    } as const;
    for (const variant of variants) {
      const props = record(variant.properties);
      const action = record(props.action).const as keyof typeof expectedPaths;
      expect(props.path).toMatchObject({ type: "string", pattern: expectedPaths[action] });
    }
    const topupVariant = variants.find(
      (variant) => record(record(variant.properties).action).const === "topup",
    );
    expect(topupVariant).toBeDefined();
    const pathSchema = record(record(topupVariant?.properties).path);
    expect(pathSchema).toMatchObject({
      type: "string",
      pattern: "^/v1/organizations/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}/wallet/checkout$",
    });
    expect(new RegExp(pathSchema.pattern as string, "u").test(emittedOperation.path)).toBe(true);
    expect(
      new RegExp(pathSchema.pattern as string, "u").test(
        "/v1/organizations/{organizationId}/wallet/checkout",
      ),
    ).toBe(false);
    expect(
      new RegExp(pathSchema.pattern as string, "u").test(
        "/v1/organizations/org-a/wallet/checkout/extra",
      ),
    ).toBe(false);
  });

  test("adds only the optional selector header to the existing supported billing routes", () => {
    const supported = [
      [
        "/v1/organizations/{organizationId}/wallet/checkout",
        "post",
        "#/components/schemas/BeginWalletCheckoutRequest",
      ],
      ["/v1/organizations/{organizationId}/wallet/checkout/{reference}", "get", undefined],
      ["/v1/organizations/{organizationId}/payments/subscription", "get", undefined],
      [
        "/v1/organizations/{organizationId}/payments/subscription",
        "post",
        "#/components/schemas/BeginSubscriptionRequest",
      ],
      ["/v1/organizations/{organizationId}/payments/subscription", "patch", undefined],
      [
        "/v1/organizations/{organizationId}/payments/subscription/commands/{kind}/{reference}",
        "get",
        undefined,
      ],
    ] as const;

    for (const [path, method, bodySchema] of supported) {
      const matching = parameters(path, method).filter(
        (parameter) => parameter.name === "Takoserver-Billing-Continuation",
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({
        in: "header",
        required: false,
        schema: { type: "string", pattern: "^hosted-browser-v1\\.[0-9a-f]{64}$" },
      });
      expect(operation(path, method).responses).toHaveProperty("400");
      expect(operation(path, method).responses).toHaveProperty("503");
      if (bodySchema) {
        expect(operation(path, method).requestBody).toMatchObject({
          content: { "application/json": { schema: { $ref: bodySchema } } },
        });
      }
    }

    expect(
      parameters("/v1/organizations/{organizationId}/wallet/holds", "post"),
    ).not.toContainEqual(expect.objectContaining({ name: "Takoserver-Billing-Continuation" }));
  });
});
