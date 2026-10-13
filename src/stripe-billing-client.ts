import { STRIPE_API_VERSION } from "./stripe-settlement.ts";

const STRIPE_API = "https://api.stripe.com/v1";
const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

export type StripeBillingObject = Record<string, unknown> & { readonly id: string };

export interface StripeBillingPage {
  readonly data: readonly StripeBillingObject[];
  readonly hasMore: boolean;
}

export type StripeBillingGetKind =
  | "invoices"
  | "subscriptions"
  | "charges"
  | "refunds"
  | "prices"
  | "customers"
  | "events"
  | "checkout/sessions";

export type StripeBillingListKind =
  | "invoices"
  | "subscriptions"
  | "refunds"
  | "events"
  | "checkout/sessions";

export type StripeBillingPostKind = "customers" | "checkout/sessions" | "subscriptions";

export type StripeBillingClientErrorCode =
  | "invalid_configuration"
  | "invalid_object"
  | "unavailable"
  | "test_mode_required";

const ERROR_MESSAGES: Readonly<Record<StripeBillingClientErrorCode, string>> = {
  invalid_configuration: "Invalid Stripe billing client configuration",
  invalid_object: "Invalid Stripe billing object",
  unavailable: "Stripe billing service is unavailable",
  test_mode_required: "Stripe test mode is required",
};

export class StripeBillingClientError extends Error {
  constructor(readonly code: StripeBillingClientErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "StripeBillingClientError";
  }
}

export interface StripeBillingClient {
  get(
    kind: StripeBillingGetKind,
    id: string,
    options?: { readonly expand?: readonly ["payment_intent.latest_charge"] },
  ): Promise<StripeBillingObject | null>;
  list(
    kind: StripeBillingListKind,
    input: {
      readonly startingAfter?: string;
      readonly charge?: string;
      readonly paymentIntent?: string;
      readonly customer?: string;
      readonly subscription?: string;
      readonly limit?: number;
    },
  ): Promise<StripeBillingPage>;
  post(
    kind: StripeBillingPostKind,
    input: {
      readonly id?: string;
      readonly form: Readonly<Record<string, string>>;
      readonly idempotencyKey: string;
    },
  ): Promise<StripeBillingObject>;
}

export interface StripeBillingClientOptions {
  readonly secretKey: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

const ID_PREFIXES: Readonly<Record<string, string>> = {
  invoices: "in_",
  subscriptions: "sub_",
  charges: "ch_",
  refunds: "re_",
  prices: "price_",
  customers: "cus_",
  "checkout/sessions": "cs_",
  events: "evt_",
  payment_intents: "pi_",
};

function invalidObject(): never {
  throw new StripeBillingClientError("invalid_object");
}

function validateId(kind: string, id: string): void {
  const prefix = ID_PREFIXES[kind];
  if (
    prefix === undefined ||
    typeof id !== "string" ||
    id.length <= prefix.length ||
    id.length > 255 ||
    !id.startsWith(prefix) ||
    !/^[A-Za-z0-9_]+$/u.test(id.slice(prefix.length))
  ) {
    invalidObject();
  }
}

function asObject(value: unknown, kind: string): StripeBillingObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).id !== "string"
  ) {
    return invalidObject();
  }
  const object = value as StripeBillingObject;
  if (object.livemode === true) throw new StripeBillingClientError("test_mode_required");
  if (kind !== "refunds" && object.livemode !== false) {
    return invalidObject();
  }
  if (kind === "refunds" && object.livemode !== undefined && object.livemode !== false)
    return invalidObject();
  return object;
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new StripeBillingClientError("unavailable");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new StripeBillingClientError("unavailable");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function parseResponse(response: Response): Promise<unknown> {
  const bytes = await readLimited(response);
  if (!response.ok) throw new StripeBillingClientError("unavailable");
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw new StripeBillingClientError("unavailable");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidObject();
  return value as Record<string, unknown>;
}

function formRecord(form: Readonly<Record<string, string>>): Record<string, string> {
  if (typeof form !== "object" || form === null || Array.isArray(form)) return invalidObject();
  const entries = Object.entries(form);
  if (entries.some(([key, value]) => key.length === 0 || typeof value !== "string")) {
    return invalidObject();
  }
  return Object.fromEntries(entries);
}

export function createStripeBillingClient(
  options: StripeBillingClientOptions,
): StripeBillingClient {
  if (
    typeof options.secretKey !== "string" ||
    !(options.secretKey.startsWith("sk_test_") || options.secretKey.startsWith("rk_test_")) ||
    options.secretKey.length <= "sk_test_".length
  ) {
    throw new StripeBillingClientError("invalid_configuration");
  }
  const send = options.fetch ?? ((request: Request) => fetch(request));

  async function request(
    method: "GET" | "POST",
    path: string,
    input?: {
      readonly form?: Readonly<Record<string, string>>;
      readonly idempotencyKey?: string;
      readonly notFoundIsNull?: boolean;
    },
  ): Promise<unknown> {
    const form = input?.form === undefined ? undefined : formRecord(input.form);
    let response: Response;
    try {
      response = await send(
        new Request(`${STRIPE_API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${options.secretKey}`,
            "stripe-version": STRIPE_API_VERSION,
            ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
            ...(input?.idempotencyKey === undefined
              ? {}
              : { "idempotency-key": input.idempotencyKey }),
          },
          ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
        }),
      );
    } catch {
      throw new StripeBillingClientError("unavailable");
    }
    if (method === "GET" && input?.notFoundIsNull === true && response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return await parseResponse(response);
  }

  return {
    async get(kind, id, options = {}) {
      validateId(kind, id);
      const expand = options.expand ?? [];
      if (
        (expand.length > 0 && kind !== "checkout/sessions") ||
        expand.some((item) => item !== "payment_intent.latest_charge")
      ) {
        return invalidObject();
      }
      const query = new URLSearchParams();
      for (const item of expand) query.append("expand[]", item);
      const encodedQuery = query.toString();
      const queryString = encodedQuery.length > 0 ? `?${encodedQuery}` : "";
      const result = await request("GET", `/${kind}/${encodeURIComponent(id)}${queryString}`, {
        notFoundIsNull: true,
      });
      if (result === null) return null;
      const object = asObject(result, kind);
      if (object.id !== id) return invalidObject();
      return object;
    },

    async list(kind, input) {
      const limit = input.limit ?? DEFAULT_PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
        return invalidObject();
      if (input.startingAfter !== undefined) validateId(kind, input.startingAfter);
      if (input.charge !== undefined) validateId("charges", input.charge);
      if (input.paymentIntent !== undefined) validateId("payment_intents", input.paymentIntent);
      if (input.customer !== undefined) validateId("customers", input.customer);
      if (input.subscription !== undefined) validateId("subscriptions", input.subscription);

      const query = new URLSearchParams({ limit: String(limit) });
      if (input.startingAfter !== undefined) query.set("starting_after", input.startingAfter);
      if (input.charge !== undefined) query.set("charge", input.charge);
      if (input.paymentIntent !== undefined) query.set("payment_intent", input.paymentIntent);
      if (input.customer !== undefined) query.set("customer", input.customer);
      if (input.subscription !== undefined) query.set("subscription", input.subscription);

      const raw = record(await request("GET", `/${kind}?${query.toString()}`));
      if (
        !Array.isArray(raw.data) ||
        raw.data.length > limit ||
        typeof raw.has_more !== "boolean" ||
        (raw.has_more && raw.data.length === 0)
      ) {
        return invalidObject();
      }
      const data = raw.data.map((item) => {
        const object = asObject(item, kind);
        validateId(kind, object.id);
        return object;
      });
      return { data, hasMore: raw.has_more };
    },

    async post(kind, input) {
      if (
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.length === 0 ||
        input.idempotencyKey.length > 255
      ) {
        return invalidObject();
      }
      if (input.id !== undefined) validateId(kind, input.id);
      const object = asObject(
        await request(
          "POST",
          `/${kind}${input.id === undefined ? "" : `/${encodeURIComponent(input.id)}`}`,
          {
            form: input.form,
            idempotencyKey: input.idempotencyKey,
          },
        ),
        kind,
      );
      validateId(kind, object.id);
      if (input.id !== undefined && object.id !== input.id) return invalidObject();
      return object;
    },
  };
}
