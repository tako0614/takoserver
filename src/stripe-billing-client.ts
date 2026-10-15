import type { StripeMode } from "./stripe-mode-realm.ts";
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

const GET_KINDS = [
  "invoices",
  "subscriptions",
  "charges",
  "refunds",
  "prices",
  "customers",
  "events",
  "subscription_schedules",
  "checkout/sessions",
  "payment_intents",
  "payment_methods",
  "setup_intents",
] as const;
const LIST_KINDS = [
  "customers",
  "invoices",
  "subscriptions",
  "refunds",
  "events",
  "checkout/sessions",
  "payment_intents",
  "payment_methods",
  "setup_intents",
] as const;
const POST_KINDS = [
  "customers",
  "checkout/sessions",
  "subscriptions",
  "subscription_schedules",
  "payment_intents",
] as const;

export type StripeBillingGetKind = (typeof GET_KINDS)[number];
export type StripeBillingListKind = (typeof LIST_KINDS)[number];
export type StripeBillingPostKind = (typeof POST_KINDS)[number];

export type StripeBillingGetOptions<Kind extends StripeBillingGetKind> = {
  readonly expand?: Kind extends "payment_intents"
    ? readonly ["latest_charge"]
    : Kind extends "payment_methods" | "setup_intents"
      ? never
      : readonly ["payment_intent.latest_charge"];
};

interface ListPageInput {
  readonly startingAfter?: string;
  readonly limit?: number;
}
interface LegacyListInput extends ListPageInput {
  readonly charge?: string;
  readonly paymentIntent?: string;
  readonly customer?: string;
  readonly subscription?: string;
  readonly createdGte?: number;
  readonly status?: "open" | "complete" | "expired";
}
export type StripeBillingListInput<Kind extends StripeBillingListKind> =
  Kind extends "payment_methods"
    ? ListPageInput & { readonly customer: string; readonly type: "card" }
    : Kind extends "payment_intents" | "setup_intents"
      ? ListPageInput & {
          readonly customer: string;
          readonly createdGte?: number;
          readonly createdLte?: number;
        }
      : Kind extends "customers" | "checkout/sessions"
        ? LegacyListInput & { readonly createdLte?: number }
        : LegacyListInput;

interface PostFormInput {
  readonly form: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}
export type StripeBillingPostInput<Kind extends StripeBillingPostKind> = PostFormInput &
  (Kind extends "payment_intents"
    ?
        | { readonly id?: never; readonly action?: never }
        | { readonly id: string; readonly action: "cancel" }
    : { readonly id?: string; readonly action?: "release" });

export type StripeBillingClientErrorCode =
  | "invalid_configuration"
  | "invalid_object"
  | "unavailable"
  | "test_mode_required"
  | "wrong_mode";

const ERROR_MESSAGES: Readonly<Record<StripeBillingClientErrorCode, string>> = {
  invalid_configuration: "Invalid Stripe billing client configuration",
  invalid_object: "Invalid Stripe billing object",
  unavailable: "Stripe billing service is unavailable",
  test_mode_required: "Stripe test mode is required",
  wrong_mode: "Stripe object does not match the configured mode",
};

export class StripeBillingClientError extends Error {
  constructor(readonly code: StripeBillingClientErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "StripeBillingClientError";
  }
}

export interface StripeBillingClient {
  /** Account associated with this same authentication, without Connect headers. */
  authenticAccount?(): Promise<StripeBillingObject>;
  /** Mode evidence for this same authenticated account; no money mutation. */
  authenticBalance?(): Promise<Readonly<Record<string, unknown>>>;
  get<Kind extends StripeBillingGetKind>(
    kind: Kind,
    id: string,
    options?: StripeBillingGetOptions<NoInfer<Kind>>,
  ): Promise<StripeBillingObject | null>;
  /** One bounded page. Empty data is not proof that an uncertain effect did not occur. */
  list<Kind extends StripeBillingListKind>(
    kind: Kind,
    input: StripeBillingListInput<NoInfer<Kind>>,
  ): Promise<StripeBillingPage>;
  /** Complete only when hasMore is false; callers must reject extra lines. */
  sessionLineItems?(sessionId: string): Promise<StripeBillingPage>;
  post<Kind extends StripeBillingPostKind>(
    kind: Kind,
    input: StripeBillingPostInput<NoInfer<Kind>>,
  ): Promise<StripeBillingObject>;
}

export interface StripeBillingClientOptions {
  readonly secretKey: string;
  readonly mode?: StripeMode;
  readonly fetch?: (request: Request) => Promise<Response>;
}

const ID_PREFIXES: Readonly<Record<string, string>> = {
  invoices: "in_",
  subscriptions: "sub_",
  subscription_schedules: "sub_sched_",
  charges: "ch_",
  refunds: "re_",
  prices: "price_",
  customers: "cus_",
  "checkout/sessions": "cs_",
  events: "evt_",
  accounts: "acct_",
  payment_intents: "pi_",
  payment_methods: "pm_",
  setup_intents: "seti_",
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

function asObject(
  value: unknown,
  kind: string,
  mode: StripeMode,
  exactResourceType = false,
): StripeBillingObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).id !== "string"
  ) {
    return invalidObject();
  }
  const object = value as StripeBillingObject;
  const expectedObject =
    kind === "payment_intents"
      ? "payment_intent"
      : kind === "payment_methods"
        ? "payment_method"
        : kind === "setup_intents"
          ? "setup_intent"
          : undefined;
  if (exactResourceType && expectedObject !== undefined && object.object !== expectedObject)
    return invalidObject();
  const expectedLivemode = mode === "live";
  if (object.livemode !== undefined && typeof object.livemode !== "boolean") {
    return invalidObject();
  }
  if (kind !== "refunds" && typeof object.livemode !== "boolean") {
    return invalidObject();
  }
  if (object.livemode !== undefined && object.livemode !== expectedLivemode) {
    throw new StripeBillingClientError(mode === "test" ? "test_mode_required" : "wrong_mode");
  }
  if (
    kind === "checkout/sessions" &&
    typeof object.payment_intent === "object" &&
    object.payment_intent !== null
  ) {
    const intent = asObject(object.payment_intent, "payment_intents", mode);
    if (typeof intent.latest_charge === "object" && intent.latest_charge !== null) {
      asObject(intent.latest_charge, "charges", mode);
    }
  }
  if (
    kind === "payment_intents" &&
    typeof object.latest_charge === "object" &&
    object.latest_charge !== null
  ) {
    const charge = asObject(object.latest_charge, "charges", mode);
    validateId("charges", charge.id);
  }
  if (kind === "events") {
    const eventData = object.data;
    if (typeof eventData === "object" && eventData !== null && !Array.isArray(eventData)) {
      const eventObject = (eventData as Record<string, unknown>).object;
      if (
        typeof eventObject === "object" &&
        eventObject !== null &&
        !Array.isArray(eventObject) &&
        !(
          (eventObject as Record<string, unknown>).object === "refund" &&
          (eventObject as Record<string, unknown>).livemode === undefined
        ) &&
        (eventObject as Record<string, unknown>).livemode !== expectedLivemode
      ) {
        throw new StripeBillingClientError(mode === "test" ? "test_mode_required" : "wrong_mode");
      }
    }
  }
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
  try {
    const bytes = await readLimited(response);
    if (!response.ok) throw new StripeBillingClientError("unavailable");
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
): StripeBillingClient & Required<Pick<StripeBillingClient, "sessionLineItems">> {
  const mode = options.mode ?? "test";
  const secretKey = options.secretKey;
  if (mode !== "test" && mode !== "live") {
    throw new StripeBillingClientError("invalid_configuration");
  }
  const keyPrefix = mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
  if (
    typeof secretKey !== "string" ||
    !keyPrefix.test(secretKey) ||
    secretKey.length <= secretKey.indexOf("_") + 6
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
            authorization: `Bearer ${secretKey}`,
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

  const client: StripeBillingClient & Required<Pick<StripeBillingClient, "sessionLineItems">> = {
    async authenticAccount() {
      const account = record(await request("GET", "/account"));
      if (
        account.object !== "account" ||
        account.deleted === true ||
        typeof account.id !== "string"
      )
        return invalidObject();
      validateId("accounts", account.id);
      return account as StripeBillingObject;
    },
    async authenticBalance() {
      const balance = record(await request("GET", "/balance"));
      if (balance.livemode === true) throw new StripeBillingClientError("test_mode_required");
      if (
        balance.object !== "balance" ||
        balance.livemode !== false ||
        !Array.isArray(balance.available) ||
        !Array.isArray(balance.pending)
      )
        return invalidObject();
      return balance;
    },
    async get(
      kind: StripeBillingGetKind,
      id: string,
      options: { readonly expand?: readonly string[] } = {},
    ) {
      if (!GET_KINDS.includes(kind)) return invalidObject();
      validateId(kind, id);
      if (Object.keys(record(options)).some((key) => key !== "expand")) return invalidObject();
      const expand = options.expand === undefined ? [] : options.expand;
      if (
        !Array.isArray(expand) ||
        expand.length > 1 ||
        Array.from(expand).some(
          (item) =>
            !(
              (kind === "checkout/sessions" && item === "payment_intent.latest_charge") ||
              (kind === "payment_intents" && item === "latest_charge")
            ),
        )
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
      const object = asObject(result, kind, mode, true);
      if (object.id !== id) return invalidObject();
      return object;
    },

    async list(
      kind: StripeBillingListKind,
      input: LegacyListInput & { readonly createdLte?: number; readonly type?: "card" },
    ) {
      if (!LIST_KINDS.includes(kind)) return invalidObject();
      const keys = Object.keys(record(input));
      const scoped =
        kind === "payment_intents" || kind === "payment_methods" || kind === "setup_intents";
      if (scoped) {
        const allowed = ["startingAfter", "limit", "customer"];
        allowed.push(...(kind === "payment_methods" ? ["type"] : ["createdGte", "createdLte"]));
        if (keys.some((key) => !allowed.includes(key))) return invalidObject();
        validateId("customers", input.customer as string);
      }
      if (
        (kind === "payment_methods" && input.type !== "card") ||
        (kind !== "payment_methods" && keys.includes("type"))
      )
        return invalidObject();
      const limit = input.limit === undefined ? DEFAULT_PAGE_SIZE : input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
        return invalidObject();
      if (input.startingAfter !== undefined) validateId(kind, input.startingAfter);
      if (input.charge !== undefined) validateId("charges", input.charge);
      if (input.paymentIntent !== undefined) validateId("payment_intents", input.paymentIntent);
      if (input.customer !== undefined) validateId("customers", input.customer);
      if (input.subscription !== undefined) validateId("subscriptions", input.subscription);
      const createdRange = ["checkout/sessions", "customers", "payment_intents", "setup_intents"];
      if (keys.includes("createdLte") && !createdRange.includes(kind)) return invalidObject();
      for (const time of [input.createdGte, input.createdLte]) {
        if (
          time !== undefined &&
          (!Number.isSafeInteger(time) ||
            time < 0 ||
            time > 253402300799 ||
            !createdRange.includes(kind))
        )
          return invalidObject();
      }
      if (
        input.createdGte !== undefined &&
        input.createdLte !== undefined &&
        input.createdGte > input.createdLte
      )
        return invalidObject();
      if (
        input.status !== undefined &&
        (kind !== "checkout/sessions" || !["open", "complete", "expired"].includes(input.status))
      )
        return invalidObject();

      const query = new URLSearchParams({ limit: String(limit) });
      if (input.startingAfter !== undefined) query.set("starting_after", input.startingAfter);
      if (input.charge !== undefined) query.set("charge", input.charge);
      if (input.paymentIntent !== undefined) query.set("payment_intent", input.paymentIntent);
      if (input.customer !== undefined && kind !== "payment_methods")
        query.set("customer", input.customer);
      if (input.subscription !== undefined) query.set("subscription", input.subscription);
      if (input.createdGte !== undefined) query.set("created[gte]", String(input.createdGte));
      if (input.createdLte !== undefined) query.set("created[lte]", String(input.createdLte));
      if (input.status !== undefined) query.set("status", input.status);
      if (input.type !== undefined) query.set("type", input.type);

      const path =
        kind === "payment_methods"
          ? `/customers/${encodeURIComponent(input.customer as string)}/payment_methods`
          : `/${kind}`;
      const raw = record(await request("GET", `${path}?${query.toString()}`));
      if (
        !Array.isArray(raw.data) ||
        raw.data.length > limit ||
        typeof raw.has_more !== "boolean" ||
        (raw.has_more && raw.data.length === 0)
      ) {
        return invalidObject();
      }
      const data = raw.data.map((item) => {
        const object = asObject(item, kind, mode, true);
        validateId(kind, object.id);
        if (scoped && object.customer !== input.customer) return invalidObject();
        if (kind === "payment_methods" && object.type !== "card") return invalidObject();
        return object;
      });
      return { data, hasMore: raw.has_more };
    },

    async sessionLineItems(sessionId) {
      validateId("checkout/sessions", sessionId);
      // Two items are enough to disprove the only supported one-line shape.
      // The dedicated endpoint is complete when has_more is false; the
      // includable Session field contains only a first handful.
      const raw = record(
        await request(
          "GET",
          `/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=2`,
        ),
      );
      if (
        !Array.isArray(raw.data) ||
        raw.data.length > 2 ||
        typeof raw.has_more !== "boolean" ||
        (raw.has_more && raw.data.length === 0)
      )
        return invalidObject();
      const data = raw.data.map((item) => {
        const line = record(item);
        if (typeof line.id !== "string" || !/^li_[A-Za-z0-9_]{1,240}$/u.test(line.id))
          return invalidObject();
        return line as StripeBillingObject;
      });
      return { data, hasMore: raw.has_more };
    },
    async post(
      kind: StripeBillingPostKind,
      input: PostFormInput & { readonly id?: string; readonly action?: "release" | "cancel" },
    ) {
      if (!POST_KINDS.includes(kind)) return invalidObject();
      record(input);
      if (
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.length === 0 ||
        input.idempotencyKey.length > 255
      ) {
        return invalidObject();
      }
      if (input.id !== undefined) validateId(kind, input.id);
      if (
        input.action !== undefined &&
        !(
          input.id !== undefined &&
          ((kind === "subscription_schedules" && input.action === "release") ||
            (kind === "payment_intents" && input.action === "cancel"))
        )
      )
        return invalidObject();
      if (kind === "payment_intents" && input.id !== undefined && input.action !== "cancel")
        return invalidObject();
      const object = asObject(
        await request(
          "POST",
          `/${kind}${input.id === undefined ? "" : `/${encodeURIComponent(input.id)}`}${input.action === undefined ? "" : `/${input.action}`}`,
          {
            form: input.form,
            idempotencyKey: input.idempotencyKey,
          },
        ),
        kind,
        mode,
        true,
      );
      validateId(kind, object.id);
      if (input.id !== undefined && object.id !== input.id) return invalidObject();
      return object;
    },
  };
  return Object.freeze(client);
}
