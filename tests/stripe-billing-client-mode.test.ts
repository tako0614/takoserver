import { describe, expect, test } from "bun:test";
import {
  createStripeBillingClient,
  StripeBillingClientError,
} from "../src/stripe-billing-client.ts";

describe("Stripe billing client mode realm", () => {
  test("requires a key that agrees with the explicitly selected mode", () => {
    for (const [mode, secretKey] of [
      ["test", "sk_live_secret"],
      ["test", "rk_live_secret"],
      ["live", "sk_test_secret"],
      ["live", "rk_test_secret"],
    ] as const) {
      expect(() => createStripeBillingClient({ mode, secretKey })).toThrow(
        StripeBillingClientError,
      );
    }

    expect(() =>
      createStripeBillingClient({ mode: "test", secretKey: "rk_test_secret" }),
    ).not.toThrow();
    expect(() =>
      createStripeBillingClient({ mode: "live", secretKey: "sk_live_secret" }),
    ).not.toThrow();
  });

  test("checks GET, list, and POST native objects against mode without inferring mode from the key", async () => {
    const testClient = createStripeBillingClient({
      secretKey: "sk_test_secret",
      fetch: async () => Response.json({ id: "cus_live", livemode: true }),
    });
    await expect(testClient.get("customers", "cus_live")).rejects.toMatchObject({
      code: "test_mode_required",
    });

    const liveClient = createStripeBillingClient({
      secretKey: "rk_live_secret",
      mode: "live",
      fetch: async () => Response.json({ id: "cus_test", livemode: false }),
    });
    await expect(liveClient.get("customers", "cus_test")).rejects.toMatchObject({
      code: "wrong_mode",
    });

    const liveListClient = createStripeBillingClient({
      secretKey: "sk_live_secret",
      mode: "live",
      fetch: async () =>
        Response.json({ data: [{ id: "evt_test", livemode: false }], has_more: false }),
    });
    await expect(liveListClient.list("events", {})).rejects.toMatchObject({ code: "wrong_mode" });

    const livePostClient = createStripeBillingClient({
      secretKey: "sk_live_secret",
      mode: "live",
      fetch: async () => Response.json({ id: "cus_test", livemode: false }),
    });
    await expect(
      livePostClient.post("customers", { form: {}, idempotencyKey: "intent_1" }),
    ).rejects.toMatchObject({ code: "wrong_mode" });

    const expandedSessionClient = createStripeBillingClient({
      secretKey: "sk_test_secret",
      fetch: async () =>
        Response.json({
          id: "cs_123",
          livemode: false,
          payment_intent: {
            id: "pi_123",
            livemode: true,
            latest_charge: { id: "ch_123", livemode: false },
          },
        }),
    });
    await expect(
      expandedSessionClient.get("checkout/sessions", "cs_123", {
        expand: ["payment_intent.latest_charge"],
      }),
    ).rejects.toMatchObject({ code: "test_mode_required" });
  });

  test("retains refund payloads without inventing livemode", async () => {
    const refund = { id: "re_123", status: "succeeded" };
    const client = createStripeBillingClient({
      secretKey: "sk_test_secret",
      fetch: async () => Response.json(refund),
    });

    await expect(client.get("refunds", "re_123")).resolves.toEqual(refund);
  });

  test("accepts refund event objects without livemode but rejects mismatched event envelopes", async () => {
    const refundEvent = {
      id: "evt_refund_123",
      object: "event",
      livemode: true,
      type: "refund.created",
      data: { object: { id: "re_123", object: "refund", charge: "ch_123" } },
    };
    const client = createStripeBillingClient({
      secretKey: "sk_live_secret",
      mode: "live",
      fetch: async () => Response.json(refundEvent),
    });
    await expect(client.get("events", refundEvent.id)).resolves.toEqual(refundEvent);

    const wrongMode = createStripeBillingClient({
      secretKey: "sk_test_secret",
      fetch: async () => Response.json(refundEvent),
    });
    await expect(wrongMode.get("events", refundEvent.id)).rejects.toMatchObject({
      code: "test_mode_required",
    });
  });
});
