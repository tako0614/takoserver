import { describe, expect, test } from "bun:test";
import { createStripeSettlement, StripeSettlementError } from "../src/stripe-settlement.ts";

/**
 * This decides who gets credited and by how much, so every check it makes is
 * worth a test that fails when the check is removed. A verifier that only
 * confirms a session exists is not a weaker verifier — it credits one
 * customer's wallet from another customer's payment, and pays out amounts
 * nobody collected.
 */

const ORG = "org_068e6b5ea58b4f8da5262274f869bce1";

function stripe(session: Record<string, unknown> | null) {
  const calls: string[] = [];
  const verifier = createStripeSettlement({
    secretKey: "sk_test_pretend",
    async fetch(request) {
      calls.push(new URL(request.url).pathname);
      // The secret must travel, and only to Stripe.
      expect(request.headers.get("authorization")).toBe("Bearer sk_test_pretend");
      return session === null
        ? new Response("", { status: 404 })
        : Response.json({ id: "cs_test_123", ...session });
    },
  });
  return { verifier, calls };
}

const paid = {
  payment_status: "paid",
  amount_total: 5_000,
  currency: "usd",
  metadata: { organizationId: ORG },
};

describe("Stripe settlement", () => {
  test("credits exactly what Stripe says it collected", async () => {
    const { verifier } = stripe(paid);
    const settled = await verifier.verify({ organizationId: ORG, settlementProof: "cs_test_123" });
    expect(settled).toEqual({
      amountMinor: 5_000,
      fundingRef: "stripe:cs_test_123",
      currency: "USD",
    });
  });

  test("refuses a session that belongs to another organization", async () => {
    const { verifier } = stripe({ ...paid, metadata: { organizationId: "org_somebody_else" } });
    await expect(
      verifier.verify({ organizationId: ORG, settlementProof: "cs_test_123" }),
    ).rejects.toMatchObject({ code: "wrong_organization" });
  });

  test("refuses a session with no organization at all", async () => {
    const { verifier } = stripe({ ...paid, metadata: null });
    await expect(
      verifier.verify({ organizationId: ORG, settlementProof: "cs_test_123" }),
    ).rejects.toMatchObject({ code: "wrong_organization" });
  });

  test("refuses one that has not been paid", async () => {
    for (const status of ["unpaid", "no_payment_required", "open"]) {
      const { verifier } = stripe({ ...paid, payment_status: status });
      await expect(
        verifier.verify({ organizationId: ORG, settlementProof: "cs_test_123" }),
      ).rejects.toMatchObject({ code: "not_paid" });
    }
  });

  test("refuses another currency rather than crediting it as dollars", async () => {
    const { verifier } = stripe({ ...paid, currency: "jpy" });
    await expect(
      verifier.verify({ organizationId: ORG, settlementProof: "cs_test_123" }),
    ).rejects.toMatchObject({ code: "wrong_currency" });
  });

  test("refuses a session Stripe has never heard of", async () => {
    const { verifier } = stripe(null);
    await expect(
      verifier.verify({ organizationId: ORG, settlementProof: "cs_test_missing" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
  });

  test("never asks Stripe about something that is not a session id", async () => {
    const { verifier, calls } = stripe(paid);
    await expect(
      verifier.verify({ organizationId: ORG, settlementProof: "../../admin" }),
    ).rejects.toBeInstanceOf(StripeSettlementError);
    // A proof that cannot be a session id is refused here, so nothing shaped
    // like a path traversal is ever appended to a URL.
    expect(calls).toEqual([]);
  });

  test("uses the session id as the funding reference, so a replay credits once", async () => {
    const { verifier } = stripe(paid);
    const first = await verifier.verify({ organizationId: ORG, settlementProof: "cs_test_123" });
    const again = await verifier.verify({ organizationId: ORG, settlementProof: "cs_test_123" });
    // Same reference: the ledger's uniqueness does the rest.
    expect(again.fundingRef).toBe(first.fundingRef);
  });
});

describe("payment setup", () => {
  test("offers nothing when no key is configured", async () => {
    const { resolvePayment } = await import("../src/payment-setup.ts");
    expect(resolvePayment({ consoleOrigin: "https://console.example.test" })).toEqual({});
  });

  test("offers nothing without somewhere to return to", async () => {
    const { resolvePayment } = await import("../src/payment-setup.ts");
    // A payment that completes and lands nowhere is worse than no payment.
    expect(resolvePayment({ stripeSecretKey: "sk_test_pretend" })).toEqual({});
  });

  test("sends the payer back to the console with the session id", async () => {
    const { resolvePayment } = await import("../src/payment-setup.ts");
    let sent: URLSearchParams | null = null;
    const payment = resolvePayment({
      stripeSecretKey: "sk_test_pretend",
      consoleOrigin: "https://console.example.test",
      async fetch(request) {
        sent = new URLSearchParams(await request.text());
        return Response.json({
          id: "cs_test_new",
          url: "https://checkout.stripe.com/c/pay/cs_test_new",
        });
      },
    });
    const started = await payment.checkout?.begin({ organizationId: ORG, amountMinor: 5_000 });
    expect(started?.url).toContain("checkout.stripe.com");
    const form = sent as unknown as URLSearchParams;
    expect(form.get("metadata[organizationId]")).toBe(ORG);
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("5000");
    expect(form.get("success_url")).toBe(
      "https://console.example.test/billing?checkout={CHECKOUT_SESSION_ID}",
    );
  });
});
