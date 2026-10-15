import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentVariables, expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import { loadTarget } from "../scripts/deploy/target.ts";

const BASE = {
  kind: "takoserver.deploy-target@v2",
  environment: "production",
  accountId: "a10162d23653f1ad1193dabf520a5dd0",
  workerName: "takoserver-api",
  d1: {
    databaseName: "takoserver-runtime",
    databaseId: "85c5a15d-a80f-42fe-a907-7ec0d86e008e",
  },
  r2: { bucketName: "takoserver-objects" },
  publicOrigin: "https://api.takoserver.com",
  signing: { currentKeyId: "takoserver-runtime-2026-08" },
};

function authoring() {
  return {
    authoringVersion: 1,
    planIds: { free: "free", subscription: "starter", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: "candidate-r3",
      effectiveAt: "2026-10-13T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86_400,
      freeIncludedMinor: 300,
      purchaseCreditExpiry: { kind: "none" },
      plans: { starter: { includedMinor: 1200, stripePriceId: "price_month123" } },
      meters: {
        "takosumi.storage.byte-hours": {
          unit: "byte-hour",
          rate: { numeratorMicros: "1", denominator: "1000" },
        },
      },
      history: [],
    },
    checkout: { minimumMinor: 500, maximumMinor: 1_000_000 },
    stripeMonthlyReview: {
      starter: { expectedAmountMinor: 125, currency: "USD", interval: "month" },
    },
  };
}

function withTarget<T>(descriptor: Record<string, unknown>, read: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "takoserver-hosted-pricing-target-"));
  try {
    const path = join(directory, "target.json");
    writeFileSync(path, JSON.stringify({ ...BASE, ...descriptor }));
    return read(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validTarget(hostedPricing = JSON.stringify(authoring())) {
  const input = JSON.parse(hostedPricing) as ReturnType<typeof authoring>;
  return {
    stripeCheckout: true,
    billingConfig: input.billingConfig,
    hostedPricing,
  };
}

function expectSafeRefusal(descriptor: Record<string, unknown>) {
  withTarget(descriptor, (path) => {
    let message = "";
    try {
      loadTarget(path, "production");
      throw new Error("target should have been refused");
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("deploy target hostedPricing is invalid");
    expect(message).not.toContain("price_month123");
    expect(message).not.toContain("operator-secret-plan");
  });
}

describe("deploy target hosted pricing", () => {
  test("preserves exact authored JSON as a Worker variable without adding a secret", () => {
    const raw = JSON.stringify(authoring(), null, 2);
    withTarget(validTarget(raw), (path) => {
      const target = loadTarget(path, "production");
      expect(target.hostedPricing).toBe(raw);
      const realized = deploymentVariables(target) as { vars: Record<string, string> };
      expect(realized.vars.TAKOSERVER_HOSTED_PRICING).toBe(raw);
      expect(expectedWorkerSecrets(target)).toEqual([
        "STRIPE_SECRET_KEY",
        "TAKOSERVER_SIGNING_KEY",
      ]);
    });
  });

  test("omits hosted pricing for the existing self-host target shape", () => {
    withTarget({}, (path) => {
      const target = loadTarget(path, "production");
      const realized = deploymentVariables(target) as { vars: Record<string, string> };
      expect(target.hostedPricing).toBeUndefined();
      expect(realized.vars.TAKOSERVER_HOSTED_PRICING).toBeUndefined();
      expect(expectedWorkerSecrets(target)).toEqual(["TAKOSERVER_SIGNING_KEY"]);
    });
  });

  test("refuses malformed, oversized, or non-string authored configuration safely", () => {
    expectSafeRefusal({
      stripeCheckout: true,
      billingConfig: authoring().billingConfig,
      hostedPricing: '{"invalid":true}',
    });
    const raw = JSON.stringify(authoring());
    expectSafeRefusal({ ...validTarget(`${raw}${" ".repeat(262_145 - raw.length)}`) });
    expectSafeRefusal({ ...validTarget(), hostedPricing: { authored: true } });
  });

  test("requires Checkout and the same active billing tariff", () => {
    expectSafeRefusal({ ...validTarget(), stripeCheckout: false });
    expectSafeRefusal({ stripeCheckout: true, hostedPricing: JSON.stringify(authoring()) });
    const changed = authoring();
    changed.billingConfig.revision = "operator-secret-plan-revision";
    expectSafeRefusal({
      ...validTarget(),
      hostedPricing: JSON.stringify(authoring()),
      billingConfig: changed.billingConfig,
    });
  });

  test("refuses placeholder Price IDs and Checkout bounds that differ from active settings", () => {
    const placeholder = authoring();
    placeholder.billingConfig.plans.starter.stripePriceId = "price_replace_me";
    expectSafeRefusal({ ...validTarget(), hostedPricing: JSON.stringify(placeholder) });
    expectSafeRefusal({
      ...validTarget(),
      stripeSettings: { checkoutMinimumMinor: 1_000 },
    });
  });
});
