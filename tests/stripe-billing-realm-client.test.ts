import { describe, expect, test } from "bun:test";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { STRIPE_API_VERSION } from "../src/stripe-settlement.ts";

describe("same-transport Stripe financial realm reads", () => {
  test("keeps authentication fixed when constructor options change after qualification", async () => {
    const authentication: string[] = [];
    const options = {
      secretKey: "sk_test_fixture_original_not_a_credential",
      async fetch(request: Request) {
        authentication.push(request.headers.get("authorization") ?? "");
        return Response.json({ id: "acct_fixture", object: "account" });
      },
    };
    const client = createStripeBillingClient(options);
    expect(Object.isFrozen(client)).toBe(true);
    await client.authenticAccount?.();
    options.secretKey = "sk_live_fixture_replacement_not_a_credential";
    await client.authenticAccount?.();
    expect(authentication).toEqual([
      "Bearer sk_test_fixture_original_not_a_credential",
      "Bearer sk_test_fixture_original_not_a_credential",
    ]);
  });

  test("reads the authenticated account and TEST balance without account selection or Connect headers", async () => {
    const paths: string[] = [];
    const client = createStripeBillingClient({
      secretKey: "sk_test_fixture_never_a_credential",
      async fetch(request) {
        expect(request.method).toBe("GET");
        expect(request.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
        expect(request.headers.get("stripe-account")).toBeNull();
        const path = new URL(request.url).pathname;
        paths.push(path);
        return Response.json(
          path === "/v1/account"
            ? { id: "acct_fixture", object: "account" }
            : { object: "balance", livemode: false, available: [], pending: [] },
        );
      },
    });
    expect(await client.authenticAccount?.()).toEqual({ id: "acct_fixture", object: "account" });
    expect(await client.authenticBalance?.()).toMatchObject({ livemode: false });
    expect(paths).toEqual(["/v1/account", "/v1/balance"]);
  });

  test.each([
    { object: "balance", livemode: true, available: [], pending: [] },
    { object: "balance", available: [], pending: [] },
    { object: "balance", livemode: false, available: [], pending: null },
  ])("rejects live or malformed authenticated mode evidence", async (balance) => {
    const client = createStripeBillingClient({
      secretKey: "sk_test_fixture_never_a_credential",
      fetch: async () => Response.json(balance),
    });
    await expect(client.authenticBalance?.()).rejects.toBeInstanceOf(Error);
  });

  test("bounds customer creation recovery and Checkout filtering on the same transport", async () => {
    const urls: URL[] = [];
    const client = createStripeBillingClient({
      secretKey: "sk_test_fixture_never_a_credential",
      async fetch(request) {
        urls.push(new URL(request.url));
        return Response.json({ data: [], has_more: false });
      },
    });
    await client.list("customers", { createdGte: 123, limit: 25 });
    await client.list("checkout/sessions", {
      customer: "cus_fixture",
      status: "complete",
      createdGte: 456,
      limit: 20,
    });
    expect(urls[0]?.searchParams.get("created[gte]")).toBe("123");
    expect(urls[1]?.searchParams.get("created[gte]")).toBe("456");
    expect(urls[1]?.searchParams.get("status")).toBe("complete");
    await expect(client.list("invoices", { createdGte: 123 })).rejects.toMatchObject({
      code: "invalid_object",
    });
    await expect(client.list("customers", { status: "complete" })).rejects.toMatchObject({
      code: "invalid_object",
    });
    await expect(client.list("customers", { createdGte: -1 })).rejects.toMatchObject({
      code: "invalid_object",
    });
    expect(urls).toHaveLength(2);
  });
});
