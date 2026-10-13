import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStripeWebhookSchema } from "../scripts/deploy/migrations.ts";
import { deploymentVariables, expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import { loadTarget } from "../scripts/deploy/target.ts";

/**
 * A hosted deployment exposes the Stripe webhook only when its private target
 * says so and the Worker holds the signing secret, exactly as Checkout is
 * gated. Payment amounts and windows are target configuration that reaches
 * the Worker as plain variables, validated before anything is deployed.
 */

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

function withTarget<T>(descriptor: Record<string, unknown>, read: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "takoserver-stripe-target-"));
  try {
    const path = join(directory, "target.json");
    writeFileSync(path, JSON.stringify({ ...BASE, ...descriptor }));
    return read(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("deploy target Stripe webhook and settings", () => {
  test("names the webhook secret and its enabling variable, never a value", () => {
    withTarget(
      {
        stripeCheckout: true,
        stripeWebhook: true,
        stripeSettings: {
          checkoutMinimumMinor: 1_000,
          checkoutMaximumMinor: 250_000,
          webhookToleranceSeconds: 120,
          reconcileLookbackSeconds: 86_400,
        },
      },
      (path) => {
        const target = loadTarget(path, "production");
        expect(expectedWorkerSecrets(target)).toEqual([
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "TAKOSERVER_SIGNING_KEY",
        ]);
        const realized = deploymentVariables(target) as { vars: Record<string, string> };
        expect(realized.vars).toMatchObject({
          TAKOSERVER_STRIPE_CHECKOUT_ENABLED: "1",
          TAKOSERVER_STRIPE_WEBHOOK_ENABLED: "1",
          TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR: "1000",
          TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR: "250000",
          TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS: "120",
          TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS: "86400",
        });
        expect(JSON.stringify(realized)).not.toContain("whsec_");
      },
    );
  });

  test("adds nothing for a deployment that only takes Checkout", () => {
    withTarget({ stripeCheckout: true }, (path) => {
      const target = loadTarget(path, "production");
      expect(expectedWorkerSecrets(target)).toEqual([
        "STRIPE_SECRET_KEY",
        "TAKOSERVER_SIGNING_KEY",
      ]);
      const realized = deploymentVariables(target) as { vars: Record<string, string> };
      expect(
        Object.keys(realized.vars).filter((name) => name.startsWith("TAKOSERVER_STRIPE_")),
      ).toEqual(["TAKOSERVER_STRIPE_CHECKOUT_ENABLED"]);
    });
  });

  test("refuses a webhook or settings on a deployment that takes no payment", () => {
    for (const descriptor of [
      { stripeWebhook: true },
      { stripeCheckout: false, stripeWebhook: true },
      { stripeSettings: { checkoutMinimumMinor: 1_000 } },
    ]) {
      withTarget(descriptor, (path) => {
        expect(() => loadTarget(path, "production")).toThrow("require `stripeCheckout`");
      });
    }
  });

  test("refuses a setting outside its bounds, of the wrong type, or unknown", () => {
    for (const [stripeSettings, message] of [
      [{ checkoutMinimumMinor: 10 }, "stripeSettings.checkoutMinimumMinor"],
      [{ checkoutMaximumMinor: 1.5 }, "stripeSettings.checkoutMaximumMinor"],
      [
        { checkoutMinimumMinor: 9_000, checkoutMaximumMinor: 8_000 },
        "stripeSettings.checkoutMinimumMinor",
      ],
      [{ webhookToleranceSeconds: "300" }, "stripeSettings.webhookToleranceSeconds"],
      [{ reconcileLookbackSeconds: 60 }, "stripeSettings.reconcileLookbackSeconds"],
      [{ checkoutPriceMinor: 500 }, "unexpected keys"],
    ] as const) {
      withTarget({ stripeCheckout: true, stripeSettings }, (path) => {
        expect(() => loadTarget(path, "production")).toThrow(message);
      });
    }
  });

  test("refuses to publish a webhook onto a D1 without stripe_events", () => {
    const through0090 = [
      "0089_v2_worker_cron_match_guard_depth.sql",
      "0090_v2_queue_sqlite_external_drain.sql",
    ];
    expect(() => assertStripeWebhookSchema({ stripeWebhook: true }, through0090)).toThrow(
      "needs 0091_stripe_events.sql applied",
    );
    expect(() =>
      assertStripeWebhookSchema({ stripeWebhook: true }, [
        ...through0090,
        "0091_stripe_events.sql",
      ]),
    ).not.toThrow();
    expect(() => assertStripeWebhookSchema({ stripeWebhook: false }, through0090)).not.toThrow();
    expect(() => assertStripeWebhookSchema({}, through0090)).not.toThrow();
  });
});
