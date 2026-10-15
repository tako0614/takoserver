import { describe, expect, test } from "bun:test";
import {
  createStripeBillingClient,
  StripeBillingClientError,
} from "../src/stripe-billing-client.ts";

const KEY = "sk_test_example_key_123";

function object(id: string, extra: Record<string, unknown> = {}) {
  return { id, livemode: false, ...extra };
}

describe("Stripe billing HTTP client", () => {
  test("reads the complete dedicated Checkout line-item page without widening generic expansions", async () => {
    const seen: Request[] = [];
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async (request) => {
        seen.push(request.clone());
        return Response.json({
          object: "list",
          data: [{ id: "li_one", price: { id: "price_one" }, quantity: 1 }],
          has_more: false,
        });
      },
    });
    expect(await client.sessionLineItems("cs_one")).toMatchObject({
      hasMore: false,
      data: [{ id: "li_one" }],
    });
    expect(seen[0]?.url).toBe(
      "https://api.stripe.com/v1/checkout/sessions/cs_one/line_items?limit=2",
    );
    expect(seen[0]?.headers.get("stripe-version")).toBe("2024-06-20");
    await expect(client.sessionLineItems("bad")).rejects.toMatchObject({ code: "invalid_object" });
    await expect(
      client.get("checkout/sessions", "cs_one", {
        expand: ["line_items" as "payment_intent.latest_charge"],
      }),
    ).rejects.toMatchObject({ code: "invalid_object" });
    const truncated = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () => Response.json({ object: "list", data: [], has_more: true }),
    });
    await expect(truncated.sessionLineItems("cs_one")).rejects.toMatchObject({
      code: "invalid_object",
    });
  });
  test("requires a test-mode key and pins the API version on every request", async () => {
    for (const secretKey of ["sk_live_secret", "rk_live_secret", "", "sk_test_"]) {
      expect(() =>
        createStripeBillingClient({ secretKey, fetch: async () => Response.json({}) }),
      ).toThrowError(StripeBillingClientError);
      expect(() =>
        createStripeBillingClient({ secretKey, fetch: async () => Response.json({}) }),
      ).toThrow("Invalid Stripe billing client configuration");
    }

    const requests: Request[] = [];
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async (request) => {
        requests.push(request);
        return Response.json(object("cus_example"));
      },
    });
    await client.get("customers", "cus_example");
    expect(requests[0]?.url).toBe("https://api.stripe.com/v1/customers/cus_example");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(requests[0]?.headers.get("stripe-version")).toBe("2024-06-20");
    expect(requests[0]?.headers.get("cookie")).toBeNull();
  });

  test("validates IDs and retrieved object identity, and maps a missing object to null", async () => {
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () => Response.json(object("in_someone_else")),
    });
    await expect(client.get("invoices", "bad_id")).rejects.toMatchObject({
      code: "invalid_object",
    });
    await expect(client.get("invoices", "in_expected")).rejects.toMatchObject({
      code: "invalid_object",
    });

    const missing = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () => new Response("", { status: 404 }),
    });
    await expect(missing.get("invoices", "in_missing")).resolves.toBeNull();
  });

  test("rejects live-mode objects and requires explicit test mode", async () => {
    for (const live of [
      Response.json({ id: "in_live", livemode: true }),
      Response.json({ data: [{ id: "evt_live", livemode: true }], has_more: false }),
    ]) {
      const client = createStripeBillingClient({ secretKey: KEY, fetch: async () => live });
      const result = live.headers.get("content-type")?.includes("application/json")
        ? await live.clone().json()
        : null;
      if (Array.isArray((result as { data?: unknown[] } | null)?.data)) {
        await expect(client.list("events", {})).rejects.toMatchObject({
          code: "test_mode_required",
        });
      } else {
        await expect(client.get("invoices", "in_live")).rejects.toMatchObject({
          code: "test_mode_required",
        });
      }
    }
    const absentMode = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () => Response.json({ id: "in_no_mode" }),
    });
    await expect(absentMode.get("invoices", "in_no_mode")).rejects.toMatchObject({
      code: "invalid_object",
    });

    const refundWithoutMode = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () => Response.json({ id: "re_1", status: "succeeded" }),
    });
    await expect(refundWithoutMode.get("refunds", "re_1")).resolves.toMatchObject({ id: "re_1" });
    const liveRefund = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () => Response.json({ id: "re_1", livemode: true }),
    });
    await expect(liveRefund.get("refunds", "re_1")).rejects.toMatchObject({
      code: "test_mode_required",
    });
  });

  test("reads events and only permits the known Checkout expansion", async () => {
    const urls: string[] = [];
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async (request) => {
        urls.push(request.url);
        return Response.json(
          object(
            new URL(request.url).pathname.includes("/events/") ? "evt_expected" : "cs_expected",
          ),
        );
      },
    });
    await client.get("events", "evt_expected");
    await client.get("checkout/sessions", "cs_expected", {
      expand: ["payment_intent.latest_charge"],
    });
    expect(new URL(urls[0] as string).pathname).toBe("/v1/events/evt_expected");
    expect(new URL(urls[1] as string).searchParams.getAll("expand[]")).toEqual([
      "payment_intent.latest_charge",
    ]);
    await expect(
      client.get("invoices", "in_expected", {
        expand: ["payment_intent.latest_charge"],
      }),
    ).rejects.toMatchObject({ code: "invalid_object" });
  });

  test("encodes list cursor and supported filters without losing pagination", async () => {
    let captured: URL | undefined;
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async (request) => {
        captured = new URL(request.url);
        return Response.json({ data: [object("in_page_2")], has_more: true });
      },
    });
    const page = await client.list("invoices", {
      startingAfter: "in_page_1",
      charge: "ch_charge_1",
      paymentIntent: "pi_payment_1",
      customer: "cus_customer_1",
      subscription: "sub_subscription_1",
      limit: 1,
    });
    const listUrl = captured as URL;
    expect(listUrl.origin + listUrl.pathname).toBe("https://api.stripe.com/v1/invoices");
    expect(listUrl.searchParams.get("starting_after")).toBe("in_page_1");
    expect(listUrl.searchParams.get("charge")).toBe("ch_charge_1");
    expect(listUrl.searchParams.get("payment_intent")).toBe("pi_payment_1");
    expect(listUrl.searchParams.get("customer")).toBe("cus_customer_1");
    expect(listUrl.searchParams.get("subscription")).toBe("sub_subscription_1");
    expect(listUrl.searchParams.get("limit")).toBe("1");
    expect(page).toEqual({ data: [object("in_page_2")], hasMore: true });
    await expect(client.list("invoices", { limit: 101 })).rejects.toMatchObject({
      code: "invalid_object",
    });
    await expect(
      client.list("invoices", { startingAfter: "sub_wrong_prefix" }),
    ).rejects.toMatchObject({ code: "invalid_object" });
  });

  test("rejects malformed or inconsistent pagination and wrong resource IDs", async () => {
    for (const body of [
      { data: "not-an-array", has_more: false },
      { data: [object("sub_wrong")], has_more: false },
      { data: [], has_more: "false" },
      { data: [], has_more: true },
      { data: [object("in_1"), object("in_2")], has_more: false },
    ]) {
      const client = createStripeBillingClient({
        secretKey: KEY,
        fetch: async () => Response.json(body),
      });
      await expect(client.list("invoices", { limit: 1 })).rejects.toMatchObject({
        code: "invalid_object",
      });
    }
  });

  test("posts URL-encoded forms with a stable idempotency key and no automatic retry", async () => {
    const requests: Request[] = [];
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async (request) => {
        requests.push(request);
        return Response.json(object("cs_created"));
      },
    });
    const input = {
      form: { mode: "subscription", "metadata[organizationId]": "org 1" },
      idempotencyKey: "sub-create:org-1",
    };
    await client.post("checkout/sessions", input);
    await client.post("checkout/sessions", input);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/v1/checkout/sessions");
      expect(request.headers.get("idempotency-key")).toBe("sub-create:org-1");
      expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
      const body = new URLSearchParams(await request.clone().text());
      expect(body.get("mode")).toBe("subscription");
      expect(body.get("metadata[organizationId]")).toBe("org 1");
    }
  });

  test("rejects mismatched create IDs and redacts Stripe errors without retrying", async () => {
    let calls = 0;
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () => {
        calls += 1;
        return Response.json(object("cus_other"));
      },
    });
    await expect(
      client.post("customers", {
        id: "cus_expected",
        form: {},
        idempotencyKey: "customer-create",
      }),
    ).rejects.toMatchObject({ code: "invalid_object" });
    expect(calls).toBe(1);

    const refused = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () =>
        Response.json({ error: { message: "sensitive Stripe diagnostic" } }, { status: 402 }),
    });
    const failure = await refused
      .post("customers", { form: {}, idempotencyKey: "customer-create" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StripeBillingClientError);
    expect((failure as Error).message).toBe("Stripe billing service is unavailable");
    expect((failure as Error).message).not.toContain("sensitive");
  });

  test("updates a subscription at its object endpoint with an idempotency key", async () => {
    let requested: Request | undefined;
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async (request) => {
        requested = request;
        return Response.json(object("sub_current"));
      },
    });
    await client.post("subscriptions", {
      id: "sub_current",
      form: { cancel_at_period_end: "true" },
      idempotencyKey: "cancel-current",
    });
    expect(requested?.url).toBe("https://api.stripe.com/v1/subscriptions/sub_current");
    expect(requested?.headers.get("idempotency-key")).toBe("cancel-current");
  });

  test("bounds streamed response reads to one MiB", async () => {
    let cancelled = false;
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(512 * 1_024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const client = createStripeBillingClient({ secretKey: KEY, fetch: async () => oversized });
    await expect(client.get("invoices", "in_large")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(cancelled).toBe(true);
  });

  test("maps fetch failures to a fixed unavailable error", async () => {
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async () => {
        throw new Error("secret-bearing transport diagnostic");
      },
    });
    const failure = await client.get("invoices", "in_network").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect((failure as Error).message).toBe("Stripe billing service is unavailable");
  });
});
