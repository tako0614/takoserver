import { describe, expect, test } from "bun:test";
import {
  createStripeBillingClient,
  type StripeBillingClient,
  StripeBillingClientError,
} from "../src/stripe-billing-client.ts";
import { STRIPE_API_VERSION } from "../src/stripe-settlement.ts";

const KEY = "sk_test_on_demand_fixture_not_a_credential";
const CUSTOMER = "cus_fixture_owner";
const POST = { form: {}, idempotencyKey: "fixture_original_command" };
const RESOURCES = [
  ["payment_intents", "pi_fixture", "payment_intent"],
  ["payment_methods", "pm_fixture", "payment_method"],
  ["setup_intents", "seti_fixture", "setup_intent"],
] as const;

function native(id: string, object: string, extra: Record<string, unknown> = {}) {
  return { id, object, livemode: false, customer: CUSTOMER, ...extra };
}

function fixture(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const client = createStripeBillingClient({
    secretKey: KEY,
    fetch: async (request) => {
      requests.push(request.clone());
      return await respond(request);
    },
  });
  return { client, requests };
}

// Exercise runtime validation independently of the public TypeScript boundary.
function unchecked(client: StripeBillingClient) {
  return client as unknown as {
    get(kind: string, id: string, options?: unknown): Promise<unknown>;
    list(kind: string, input: unknown): Promise<unknown>;
    post(kind: string, input: unknown): Promise<unknown>;
  };
}

describe("Stripe on-demand transport ports", () => {
  test.each(RESOURCES)(
    "reads %s on the captured authentication without Connect or API drift",
    async (kind, id, object) => {
      const requests: Request[] = [];
      const options = {
        secretKey: KEY,
        fetch: async (request: Request) => {
          requests.push(request);
          return Response.json(native(id, object));
        },
      };
      const client = createStripeBillingClient(options);
      options.secretKey = "sk_live_replacement_fixture_not_a_credential";
      options.fetch = async () => {
        throw new Error("Constructor transport must remain captured");
      };
      expect(await client.get(kind, id)).toEqual(native(id, object));
      expect(Object.isFrozen(client)).toBe(true);
      expect(requests).toHaveLength(1);
      const request = requests[0] as Request;
      expect(request.url).toBe(`https://api.stripe.com/v1/${kind}/${id}`);
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(request.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
      for (const header of ["stripe-account", "stripe-context", "cookie", "idempotency-key"])
        expect(request.headers.get(header)).toBeNull();
    },
  );

  test("accepts missing objects and empty pages as transport data without a POST or retry", async () => {
    const { client, requests } = fixture((request) =>
      new URL(request.url).pathname.endsWith("pi_missing")
        ? new Response("", { status: 404 })
        : Response.json({ data: [], has_more: false }),
    );
    expect(await client.get("payment_intents", "pi_missing")).toBeNull();
    expect(await client.list("payment_intents", { customer: CUSTOMER })).toEqual({
      data: [],
      hasMore: false,
    });
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
  });

  test("bounds PI and SI lists by customer, original time interval and resource cursor", async () => {
    for (const [kind, id, object] of [RESOURCES[0], RESOURCES[2]]) {
      const { client, requests } = fixture(() =>
        Response.json({ data: [native(id, object)], has_more: true }),
      );
      expect(
        await client.list(kind, {
          customer: CUSTOMER,
          createdGte: 0,
          createdLte: 253402300799,
          startingAfter: `${id}_previous`,
          limit: 1,
        }),
      ).toEqual({ data: [native(id, object)], hasMore: true });
      const url = new URL((requests[0] as Request).url);
      expect(url.pathname).toBe(`/v1/${kind}`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        customer: CUSTOMER,
        "created[gte]": "0",
        "created[lte]": "253402300799",
        starting_after: `${id}_previous`,
        limit: "1",
      });
      expect(requests).toHaveLength(1);
    }
  });

  test("lists only card PMs at the documented customer endpoint without duplicating the customer query", async () => {
    const card = native("pm_card", "payment_method", { type: "card" });
    const { client, requests } = fixture(() => Response.json({ data: [card], has_more: false }));
    expect(
      await client.list("payment_methods", {
        customer: CUSTOMER,
        type: "card",
        startingAfter: "pm_previous_fixture",
        limit: 2,
      }),
    ).toEqual({ data: [card], hasMore: false });
    const url = new URL((requests[0] as Request).url);
    expect(url.pathname).toBe(`/v1/customers/${CUSTOMER}/payment_methods`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: "card",
      starting_after: "pm_previous_fixture",
      limit: "2",
    });
  });

  test("adds only supported upper created bounds to existing customer and Checkout lists", async () => {
    const { client, requests } = fixture(() => Response.json({ data: [], has_more: false }));
    await client.list("customers", { createdGte: 123, createdLte: 456 });
    await client.list("checkout/sessions", {
      customer: CUSTOMER,
      createdGte: 123,
      createdLte: 123,
      status: "complete",
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const query = new URL(request.url).searchParams;
      expect(query.get("created[gte]")).toBe("123");
      expect(query.has("created[lte]")).toBe(true);
    }
  });

  test("rejects wrong-kind filters, malformed ranges, cursors and URL injection before fetching", async () => {
    const { client, requests } = fixture(() => {
      throw new Error("Invalid inputs must not reach the transport");
    });
    const unsafe = unchecked(client);
    const invalidLists: [string, unknown][] = [
      ["payment_intents", {}],
      ["setup_intents", { customer: "cus_/../other" }],
      ["payment_methods", { customer: CUSTOMER }],
      ["payment_methods", { customer: CUSTOMER, type: "sepa_debit" }],
      ["payment_methods", { customer: CUSTOMER, type: "card", createdGte: 0 }],
      ["payment_methods", { customer: CUSTOMER, type: "card", createdLte: 1 }],
      ["payment_methods", { customer: CUSTOMER, type: "card", startingAfter: "seti_other" }],
      ["payment_intents", { customer: CUSTOMER, type: "card" }],
      ["setup_intents", { customer: CUSTOMER, charge: "ch_other" }],
      ["payment_intents", { customer: CUSTOMER, paymentIntent: "pi_other" }],
      ["setup_intents", { customer: CUSTOMER, subscription: "sub_other" }],
      ["payment_intents", { customer: CUSTOMER, status: "complete" }],
      ["payment_intents", { customer: CUSTOMER, expand: ["customer"] }],
      ["setup_intents", { customer: CUSTOMER, createdGte: 10, createdLte: 9 }],
      ["payment_intents", { customer: CUSTOMER, createdGte: -1 }],
      ["setup_intents", { customer: CUSTOMER, createdLte: 253402300800 }],
      ["payment_intents", { customer: CUSTOMER, createdGte: 0.5 }],
      ["setup_intents", { customer: CUSTOMER, createdLte: "1" }],
      ["payment_intents", { customer: CUSTOMER, createdGte: Number.NaN }],
      ["payment_intents", { customer: CUSTOMER, startingAfter: "pm_wrong" }],
      ["setup_intents", { customer: CUSTOMER, startingAfter: "seti_a?x=y" }],
      ["payment_methods", { customer: "cus_a?x=y", type: "card" }],
      ["payment_intents", { customer: CUSTOMER, limit: 101 }],
      ["setup_intents", { customer: CUSTOMER, limit: 0 }],
      ["payment_intents", { customer: CUSTOMER, limit: 1.5 }],
      ["payment_intents", { customer: CUSTOMER, limit: null }],
      ["invoices", { createdLte: 1 }],
      ["invoices", { createdLte: undefined }],
      ["events", { type: "card" }],
      ["events", { type: undefined }],
      ["payment_intents/search", { customer: CUSTOMER }],
      ["https://other.example/steal", {}],
    ];
    for (const [kind, input] of invalidLists)
      await expect(unsafe.list(kind, input)).rejects.toMatchObject({ code: "invalid_object" });
    for (const [kind, id] of [
      ["payment_intents", "pi_a/../../customers"],
      ["payment_methods", "seti_wrong"],
      ["setup_intents", "seti_a#fragment"],
      ["accounts", "acct_not_an_allowed_resource"],
      ["payment_intents/../customers", "pi_a"],
    ])
      await expect(unsafe.get(kind as string, id as string)).rejects.toMatchObject({
        code: "invalid_object",
      });
    expect(requests).toHaveLength(0);
  });

  test("keeps kind-specific filters, expansions and original cancel inputs typed", async () => {
    const { client, requests } = fixture(() => Response.json({}));
    // @ts-expect-error PM lists require an explicit card filter.
    await expect(client.list("payment_methods", { customer: CUSTOMER })).rejects.toBeInstanceOf(
      Error,
    );
    await expect(
      // @ts-expect-error Another PM type is outside this transport capability.
      client.list("payment_methods", { customer: CUSTOMER, type: "bank" }),
    ).rejects.toBeInstanceOf(Error);
    // @ts-expect-error PI updates are not part of the original cancel port.
    await expect(client.post("payment_intents", { ...POST, id: "pi_one" })).rejects.toBeInstanceOf(
      Error,
    );
    // @ts-expect-error Upper created bounds are not added to the legacy invoice contract.
    await expect(client.list("invoices", { createdLte: 1 })).rejects.toBeInstanceOf(Error);
    await expect(
      // @ts-expect-error PI uses its own expansion, not the Checkout expansion.
      client.get("payment_intents", "pi_one", { expand: ["payment_intent.latest_charge"] }),
    ).rejects.toBeInstanceOf(Error);
    expect(requests).toHaveLength(0);
  });

  test("permits exactly one kind-specific PI or Checkout expansion", async () => {
    const { client, requests } = fixture((request) => {
      if (new URL(request.url).pathname.includes("/checkout/"))
        return Response.json({ id: "cs_one", livemode: false });
      return Response.json(
        native("pi_one", "payment_intent", { latest_charge: { id: "ch_one", livemode: false } }),
      );
    });
    await client.get("payment_intents", "pi_one", { expand: ["latest_charge"] });
    await client.get("checkout/sessions", "cs_one", { expand: ["payment_intent.latest_charge"] });
    expect(new URL((requests[0] as Request).url).searchParams.getAll("expand[]")).toEqual([
      "latest_charge",
    ]);
    expect(new URL((requests[1] as Request).url).searchParams.getAll("expand[]")).toEqual([
      "payment_intent.latest_charge",
    ]);
    const unsafe = unchecked(client);
    for (const [kind, id, expand] of [
      ["payment_methods", "pm_one", ["latest_charge"]],
      ["setup_intents", "seti_one", ["payment_method"]],
      ["checkout/sessions", "cs_one", ["latest_charge"]],
      ["payment_intents", "pi_one", ["customer"]],
      ["payment_intents", "pi_one", ["latest_charge", "latest_charge"]],
      ["payment_intents", "pi_one", "latest_charge"],
      ["payment_intents", "pi_one", null],
      ["payment_intents", "pi_one", new Array<string>(1)],
    ] as const)
      await expect(unsafe.get(kind, id, { expand })).rejects.toMatchObject({
        code: "invalid_object",
      });
    expect(requests).toHaveLength(2);
  });

  test.each(RESOURCES)(
    "rejects malformed, mismatched or wrong-mode %s objects",
    async (kind, id, object) => {
      for (const extra of [
        { id: `${id}_different` },
        { object: "wrong_resource" },
        { livemode: undefined },
        { livemode: "false" },
      ]) {
        const { client } = fixture(() => Response.json(native(id, object, extra)));
        await expect(client.get(kind, id)).rejects.toMatchObject({ code: "invalid_object" });
      }
      const { client } = fixture(() => Response.json(native(id, object, { livemode: true })));
      await expect(client.get(kind, id)).rejects.toMatchObject({ code: "test_mode_required" });
      const live = createStripeBillingClient({
        mode: "live",
        secretKey: "rk_live_fixture_not_a_credential",
        fetch: async () => Response.json(native(id, object)),
      });
      await expect(live.get(kind, id)).rejects.toMatchObject({ code: "wrong_mode" });
    },
  );

  test("checks expanded PI charge mode and prefix without accepting a wrong nested source", async () => {
    for (const [charge, code] of [
      [{ id: "ch_live", livemode: true }, "test_mode_required"],
      [{ id: "pm_wrong", livemode: false }, "invalid_object"],
      [{ id: "ch_missing_mode" }, "invalid_object"],
    ] as const) {
      const { client } = fixture(() =>
        Response.json(native("pi_one", "payment_intent", { latest_charge: charge })),
      );
      await expect(
        client.get("payment_intents", "pi_one", { expand: ["latest_charge"] }),
      ).rejects.toMatchObject({ code });
    }
  });

  test("rejects inconsistent new-resource pages and card filter responses", async () => {
    const pi = native("pi_one", "payment_intent");
    for (const page of [
      { data: [], has_more: true },
      { data: [pi], has_more: "false" },
      { data: [pi, pi], has_more: false },
      { data: [native("pm_wrong", "payment_intent")], has_more: false },
      { data: [native("pi_one", "payment_intent", { livemode: true })], has_more: false },
      { data: [native("pi_one", "payment_intent", { customer: "cus_other" })], has_more: false },
    ]) {
      const { client } = fixture(() => Response.json(page));
      await expect(
        client.list("payment_intents", { customer: CUSTOMER, limit: 1 }),
      ).rejects.toBeInstanceOf(StripeBillingClientError);
    }
    for (const extra of [{ type: "sepa_debit" }, { type: "card", customer: "cus_other" }]) {
      const { client } = fixture(() =>
        Response.json({ data: [native("pm_one", "payment_method", extra)], has_more: false }),
      );
      await expect(
        client.list("payment_methods", { customer: CUSTOMER, type: "card" }),
      ).rejects.toMatchObject({ code: "invalid_object" });
    }
  });

  test("creates one PI or cancels the exact original PI with the captured API contract", async () => {
    const { client, requests } = fixture(() =>
      Response.json(native("pi_original", "payment_intent")),
    );
    await client.post("payment_intents", {
      idempotencyKey: "fixture_cash_original",
      form: {
        customer: CUSTOMER,
        payment_method: "pm_one",
        off_session: "true",
        confirm: "true",
        "metadata[command]": "literal & ? / value",
      },
    });
    await client.post("payment_intents", {
      id: "pi_original",
      action: "cancel",
      idempotencyKey: "fixture_cancel_original",
      form: { cancellation_reason: "abandoned" },
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/payment_intents",
      "/v1/payment_intents/pi_original/cancel",
    ]);
    expect(requests.map((request) => request.headers.get("idempotency-key"))).toEqual([
      "fixture_cash_original",
      "fixture_cancel_original",
    ]);
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(request.headers.get("stripe-account")).toBeNull();
      expect(request.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
      expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    }
    expect(
      new URLSearchParams(await (requests[0] as Request).text()).get("metadata[command]"),
    ).toBe("literal & ? / value");
  });

  test("keeps legacy POST create, update and release and Checkout setup transport intact", async () => {
    const requests: Request[] = [];
    const client = createStripeBillingClient({
      secretKey: KEY,
      fetch: async (request) => {
        requests.push(request.clone());
        const path = new URL(request.url).pathname;
        const id = path.includes("checkout")
          ? "cs_setup"
          : path.includes("subscription_schedules")
            ? "sub_sched_original"
            : "sub_original";
        return Response.json({ id, livemode: false });
      },
    });
    await client.post("checkout/sessions", {
      ...POST,
      form: { mode: "setup", customer: CUSTOMER },
    });
    await client.post("subscriptions", { ...POST, id: "sub_original" });
    await client.post("subscription_schedules", { ...POST, id: "sub_sched_original" });
    await client.post("subscription_schedules", {
      ...POST,
      id: "sub_sched_original",
      action: "release",
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/checkout/sessions",
      "/v1/subscriptions/sub_original",
      "/v1/subscription_schedules/sub_sched_original",
      "/v1/subscription_schedules/sub_sched_original/release",
    ]);
    expect(new URLSearchParams(await (requests[0] as Request).text()).get("mode")).toBe("setup");
  });

  test("rejects arbitrary POST paths/actions and malformed original IDs without dispatching", async () => {
    const { client, requests } = fixture(() => Response.json({}));
    const unsafe = unchecked(client);
    for (const [kind, fields] of [
      ["setup_intents", {}],
      ["payment_methods", {}],
      ["payment_intents/search", {}],
      ["../payment_intents", {}],
      ["payment_intents", { action: "cancel" }],
      ["payment_intents", { id: "pi_one" }],
      ["payment_intents", { id: "pi_one", action: "confirm" }],
      ["payment_intents", { id: "pi_one", action: "release" }],
      ["payment_intents", { id: "pm_other", action: "cancel" }],
      ["payment_intents", { id: "pi_a/cancel?x=y", action: "cancel" }],
      ["subscriptions", { id: "sub_one", action: "cancel" }],
      ["subscription_schedules", { id: "sub_sched_one", action: "cancel" }],
      ["payment_intents", { idempotencyKey: "" }],
      ["payment_intents", { idempotencyKey: "x".repeat(256) }],
    ] as const)
      await expect(unsafe.post(kind, { ...POST, ...fields })).rejects.toMatchObject({
        code: "invalid_object",
      });
    expect(requests).toHaveLength(0);
  });

  test("checks PI cancel response identity and mode instead of trusting a successful HTTP status", async () => {
    for (const extra of [{ id: "pi_other" }, { object: "setup_intent" }, { livemode: true }]) {
      const { client, requests } = fixture(() =>
        Response.json(native("pi_original", "payment_intent", extra)),
      );
      await expect(
        client.post("payment_intents", { ...POST, id: "pi_original", action: "cancel" }),
      ).rejects.toBeInstanceOf(StripeBillingClientError);
      expect(requests).toHaveLength(1);
    }
  });

  test("redacts native errors, unreadable streams and unknown ACKs without retries", async () => {
    const diagnostic = "fixture_sensitive_native_diagnostic";
    const responses = [
      () =>
        Response.json(
          { error: { message: diagnostic, client_secret: diagnostic } },
          { status: 402 },
        ),
      () => new Response(`not JSON: ${diagnostic}`),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(diagnostic));
            },
          }),
        ),
      () => {
        throw new Error(diagnostic);
      },
    ];
    for (const respond of responses) {
      const { client, requests } = fixture(respond);
      const error: unknown = await client
        .post("payment_intents", POST)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(StripeBillingClientError);
      expect(error).toMatchObject({
        code: "unavailable",
        message: "Stripe billing service is unavailable",
      });
      expect(String(error)).not.toContain(diagnostic);
      expect(JSON.stringify(error)).not.toContain(diagnostic);
      expect(requests).toHaveLength(1);
    }
  });
});
