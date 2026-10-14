import { canonicalJson } from "./json.ts";
import type { Clock, Row, Sql, SqlParam } from "./ports.ts";
import {
  type StripeBillingClient,
  StripeBillingClientError,
  type StripeBillingObject,
} from "./stripe-billing-client.ts";
import type { StripeMode } from "./stripe-mode-realm.ts";
import type {
  SubscriptionCancellationCommandDescriptor,
  SubscriptionStartCommandDescriptor,
} from "./subscription-command-receipts.ts";

const PURPOSE = "hosted_subscription";
const SESSION = /^cs_[A-Za-z0-9_]{1,240}$/u;
const SUBSCRIPTION = /^sub_[A-Za-z0-9_]{1,240}$/u;
const CUSTOMER = /^cus_[A-Za-z0-9_]{1,240}$/u;
const PRICE = /^price_[A-Za-z0-9_]{1,240}$/u;
const MAX_PAGES = 10;

export class SubscriptionCustodyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SubscriptionCustodyError";
  }
}
function fail(code: string): never {
  throw new SubscriptionCustodyError(code);
}
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const id = (value: unknown, pattern: RegExp): string | null => {
  const resolved = typeof value === "string" ? value : object(value)?.id;
  return typeof resolved === "string" && pattern.test(resolved) ? resolved : null;
};
const connected = (value: Record<string, unknown>): boolean =>
  value.on_behalf_of != null ||
  value.transfer_data != null ||
  value.application != null ||
  value.account != null;
const instant = (seconds: unknown): string | null =>
  Number.isSafeInteger(seconds) && Number(seconds) > 0 && Number(seconds) <= 253402300799
    ? new Date(Number(seconds) * 1000).toISOString()
    : null;
async function hash(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface Association {
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly livemode: boolean;
  readonly planKey: string;
  readonly pricingRevision: string;
  readonly priceId: string;
  readonly priceAmountMinor: number;
  readonly includedMinor: number;
  readonly sessionId: string;
}
export interface SubscriptionManagementContext {
  readonly organizationId: string;
  readonly operation: "begin" | "cancel";
  readonly requestKeyDigest: string;
  readonly intentId?: string;
  readonly subscriptionId?: string;
}
export interface SubscriptionManagementPredicate {
  readonly condition: string;
  readonly params: readonly SqlParam[];
}
interface CheckoutIntent {
  readonly id: string;
  readonly org: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly planKey: string;
  readonly revision: string;
  readonly priceId: string;
  readonly amount: number;
  readonly included: number;
  readonly livemode: boolean;
  readonly customerId: string | null;
  readonly state:
    | "prepared"
    | "dispatched"
    | "session_known"
    | "associated"
    | "expired"
    | "invalidated";
  readonly sessionId: string | null;
  readonly sessionUrl: string | null;
  readonly subscriptionId: string | null;
  readonly phase: "tail" | "prefix_head" | "prefix";
  readonly after: string | null;
  readonly scanHead: string | null;
  readonly prefixHead: string | null;
  readonly match: string | null;
  readonly conflict: boolean;
  readonly version: number;
}
function checkoutRow(row: Row | undefined): CheckoutIntent | null {
  if (!row) return null;
  return {
    id: String(row.id),
    org: String(row.org_id),
    key: String(row.request_key_digest),
    fingerprint: String(row.fingerprint),
    planKey: String(row.plan_key),
    revision: String(row.pricing_revision),
    priceId: String(row.price_id),
    amount: Number(row.price_amount_minor),
    included: Number(row.included_minor),
    livemode: row.livemode === 1,
    customerId: row.customer_id == null ? null : String(row.customer_id),
    state: row.state as CheckoutIntent["state"],
    sessionId: row.session_id == null ? null : String(row.session_id),
    sessionUrl: row.session_url == null ? null : String(row.session_url),
    subscriptionId: row.subscription_id == null ? null : String(row.subscription_id),
    phase: row.recovery_phase as CheckoutIntent["phase"],
    after: row.recovery_after_id == null ? null : String(row.recovery_after_id),
    scanHead: row.recovery_scan_head_id == null ? null : String(row.recovery_scan_head_id),
    prefixHead: row.recovery_prefix_head_id == null ? null : String(row.recovery_prefix_head_id),
    match: row.recovery_match_id == null ? null : String(row.recovery_match_id),
    conflict: row.recovery_conflict === 1,
    version: Number(row.recovery_version),
  };
}
function associationRow(row: Row | undefined): Association | null {
  if (!row) return null;
  return {
    organizationId: String(row.org_id),
    subscriptionId: String(row.subscription_id),
    customerId: String(row.customer_id),
    livemode: row.livemode === 1,
    planKey: String(row.plan_key),
    pricingRevision: String(row.pricing_revision),
    priceId: String(row.price_id),
    priceAmountMinor: Number(row.price_amount_minor),
    includedMinor: Number(row.included_minor),
    sessionId: String(row.session_id),
  };
}
interface CancelIntent {
  readonly id: string;
  readonly org: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly livemode: boolean;
  readonly planKey: string;
  readonly revision: string;
  readonly priceId: string;
  readonly amount: number;
  readonly included: number;
  readonly prePeriodEnd: string;
  readonly state: "prepared" | "dispatched" | "verified";
  readonly effectiveAt: string | null;
  readonly createdAt: string;
}
function cancelRow(row: Row | undefined): CancelIntent | null {
  if (!row) return null;
  return {
    id: String(row.id),
    org: String(row.org_id),
    key: String(row.request_key_digest),
    fingerprint: String(row.fingerprint),
    subscriptionId: String(row.subscription_id),
    customerId: String(row.customer_id),
    livemode: row.livemode === 1,
    planKey: String(row.plan_key),
    revision: String(row.pricing_revision),
    priceId: String(row.price_id),
    amount: Number(row.price_amount_minor),
    included: Number(row.included_minor),
    prePeriodEnd: String(row.pre_period_end),
    state: row.state as CancelIntent["state"],
    effectiveAt: row.effective_at == null ? null : String(row.effective_at),
    createdAt: String(row.created_at),
  };
}

export type CheckoutReceipt =
  | { readonly state: "open"; readonly id: string; readonly url: string }
  | {
      readonly state: "associated";
      readonly id: string;
      readonly subscriptionRef: string;
      readonly url?: string;
    }
  | { readonly state: "expired"; readonly id: string }
  | { readonly state: "pending"; readonly id: string };
export type CancellationReceipt =
  | { readonly state: "pending"; readonly subscriptionRef: string }
  | { readonly state: "verified"; readonly subscriptionRef: string; readonly effectiveAt: string };

export function createSubscriptionCustody(options: {
  readonly sql: Sql;
  readonly mode?: StripeMode;
  readonly client: StripeBillingClient;
  readonly clock: Clock;
  readonly consoleOrigin: string;
  readonly plans: readonly {
    readonly planId: string;
    readonly stripePriceId: string;
    readonly monthlyAmountMinor: number;
    readonly includedCreditMinor: number;
  }[];
  readonly pricingRevision: string;
  readonly effectiveAt: string;
  readonly validatePrice: (
    priceId: string,
    revision: string,
    requireActive: boolean,
  ) => Promise<void>;
  readonly validateCustomer: (org: string, customerId: string) => Promise<void>;
  readonly isConclusivePreflightFailure: (error: unknown) => boolean;
  readonly ensureCustomer?: (organizationId: string) => Promise<string>;
  readonly requireBoundCustomer?: boolean;
  readonly managementGuard?: (
    context: SubscriptionManagementContext,
  ) => SubscriptionManagementPredicate;
  readonly resolveCurrentTerms?: (input: {
    readonly association: Association;
    readonly subscription: StripeBillingObject;
    readonly periodStart: string;
    readonly periodEnd: string;
  }) => Promise<
    Pick<
      Association,
      "planKey" | "pricingRevision" | "priceId" | "priceAmountMinor" | "includedMinor"
    >
  >;
}) {
  const { sql, client, clock } = options;
  const plans = new Map(options.plans.map((plan) => [plan.planId, plan] as const));
  if (plans.size !== options.plans.length || plans.size === 0) fail("invalid_plan_configuration");
  const livemode = (options.mode ?? "test") === "live";
  const now = () => clock().toISOString();
  const managementGuard = (
    input: SubscriptionManagementContext,
  ): SubscriptionManagementPredicate => {
    const predicate = options.managementGuard?.(input) ?? { condition: "1", params: [] };
    if (!predicate.condition) fail("subscription_management_unavailable");
    return predicate;
  };
  async function managementPreflight(input: SubscriptionManagementContext): Promise<void> {
    const predicate = managementGuard(input);
    const row = (
      await sql.query(
        `SELECT CASE WHEN ${predicate.condition} THEN 1 ELSE 0 END AS allowed`,
        predicate.params,
      )
    )[0];
    if (row?.allowed !== 1) fail("subscription_management_conflict");
  }
  const byCheckoutId = async (value: string) => {
    const row = checkoutRow(
      (
        await sql.query("SELECT * FROM stripe_subscription_checkout_intents WHERE id = ?", [value])
      )[0],
    );
    if (row && row.livemode !== livemode) fail("subscription_checkout_mismatch");
    return row;
  };
  const byCheckoutKey = async (org: string, key: string) => {
    const row = checkoutRow(
      (
        await sql.query(
          "SELECT * FROM stripe_subscription_checkout_intents WHERE org_id = ? AND request_key_digest = ?",
          [org, key],
        )
      )[0],
    );
    if (row && row.livemode !== livemode) fail("subscription_checkout_mismatch");
    return row;
  };
  const byCancelId = async (value: string) => {
    const row = cancelRow(
      (
        await sql.query("SELECT * FROM stripe_subscription_cancellation_intents WHERE id = ?", [
          value,
        ])
      )[0],
    );
    if (row && row.livemode !== livemode) fail("subscription_management_conflict");
    return row;
  };
  const byCancelKey = async (org: string, key: string) => {
    const row = cancelRow(
      (
        await sql.query(
          "SELECT * FROM stripe_subscription_cancellation_intents WHERE org_id = ? AND request_key_digest = ?",
          [org, key],
        )
      )[0],
    );
    if (row && row.livemode !== livemode) fail("subscription_management_conflict");
    return row;
  };
  const association = async (sub: string) => {
    const row = associationRow(
      (
        await sql.query("SELECT * FROM stripe_billing_associations WHERE subscription_id = ?", [
          sub,
        ])
      )[0],
    );
    if (row && row.livemode !== livemode) fail("subscription_management_conflict");
    return row;
  };

  async function subscriptionRef(bound: Association): Promise<string> {
    return `sra_${await hash(["takoserver-subscription-association-ref:v1", bound.organizationId, bound.subscriptionId, bound.customerId, bound.livemode])}`;
  }
  async function bindSession(
    intent: CheckoutIntent,
    session: StripeBillingObject,
  ): Promise<CheckoutIntent> {
    if (!SESSION.test(session.id) || (intent.sessionId && intent.sessionId !== session.id))
      fail("subscription_checkout_mismatch");
    const url =
      typeof session.url === "string" && session.url.startsWith("https://checkout.stripe.com/")
        ? session.url
        : null;
    const changed = await sql.run(
      `UPDATE stripe_subscription_checkout_intents SET session_id = ?, session_url = COALESCE(session_url, ?), state = 'session_known', updated_at = ?
       WHERE id = ? AND state = 'dispatched' AND (session_id IS NULL OR session_id = ?)`,
      [session.id, url, now(), intent.id, session.id],
    );
    const recorded = await byCheckoutId(intent.id);
    if ((changed.changes !== 1 && recorded?.sessionId !== session.id) || !recorded)
      fail("subscription_checkout_unresolved");
    return recorded;
  }
  function sessionMatches(intent: CheckoutIntent, session: StripeBillingObject): boolean {
    const meta = object(session.metadata);
    return (
      session.object === "checkout.session" &&
      session.livemode === intent.livemode &&
      !connected(session) &&
      session.recovered_from == null &&
      session.after_expiration == null &&
      session.mode === "subscription" &&
      session.client_reference_id === intent.id &&
      meta?.subscriptionCheckoutIntentId === intent.id &&
      meta.organizationId === intent.org &&
      meta.takoserverPurpose === PURPOSE &&
      meta.planKey === intent.planKey &&
      meta.pricingRevision === intent.revision &&
      session.currency === "usd" &&
      session.amount_subtotal === intent.amount &&
      session.amount_total === intent.amount &&
      (intent.customerId === null || id(session.customer, CUSTOMER) === intent.customerId)
    );
  }
  async function exactLines(intent: CheckoutIntent, sessionId: string): Promise<void> {
    if (typeof client.sessionLineItems !== "function") fail("subscription_checkout_unresolved");
    const lines = await client.sessionLineItems(sessionId);
    if (
      lines.hasMore ||
      lines.data.length !== 1 ||
      id(lines.data[0]?.price, PRICE) !== intent.priceId ||
      lines.data[0]?.quantity !== 1
    )
      fail("subscription_checkout_mismatch");
  }
  async function expireKnown(intent: CheckoutIntent, session: StripeBillingObject): Promise<void> {
    if (
      intent.state !== "session_known" ||
      intent.sessionId !== session.id ||
      !sessionMatches(intent, session) ||
      session.status !== "expired" ||
      session.payment_status !== "unpaid" ||
      session.subscription !== null ||
      session.invoice !== null ||
      session.after_expiration !== null ||
      session.recovered_from !== null ||
      intent.conflict
    )
      fail("subscription_checkout_mismatch");
    await exactLines(intent, session.id);
    const changed = await sql.run(
      `UPDATE stripe_subscription_checkout_intents SET state = 'expired', updated_at = ?
       WHERE id = ? AND state = 'session_known' AND session_id = ? AND subscription_id IS NULL AND recovery_conflict = 0`,
      [now(), intent.id, session.id],
    );
    if (changed.changes !== 1) fail("subscription_checkout_unresolved");
  }
  async function verifySubscription(
    intent: CheckoutIntent,
    session: StripeBillingObject,
  ): Promise<Association> {
    if (
      intent.fingerprint !==
      (await hash([
        intent.org,
        intent.planKey,
        intent.revision,
        intent.priceId,
        intent.amount,
        intent.included,
        intent.livemode,
        "subscription",
      ]))
    )
      fail("subscription_checkout_mismatch");
    if (
      !sessionMatches(intent, session) ||
      session.status !== "complete" ||
      session.payment_status !== "paid"
    )
      fail("subscription_checkout_mismatch");
    await exactLines(intent, session.id);
    const customerId = id(session.customer, CUSTOMER),
      subscriptionId = id(session.subscription, SUBSCRIPTION);
    if (!customerId || !subscriptionId || intent.conflict) fail("subscription_checkout_mismatch");
    const sub = await client.get("subscriptions", subscriptionId);
    const meta = object(sub?.metadata);
    const items = object(sub?.items);
    if (
      sub?.object !== "subscription" ||
      sub.livemode !== intent.livemode ||
      connected(sub) ||
      id(sub.customer, CUSTOMER) !== customerId ||
      meta?.organizationId !== intent.org ||
      meta.takoserverPurpose !== PURPOSE ||
      meta.planKey !== intent.planKey ||
      meta.pricingRevision !== intent.revision ||
      items?.has_more !== false ||
      !Array.isArray(items.data) ||
      items.data.length !== 1 ||
      object(items.data[0])?.quantity !== 1 ||
      id(object(items.data[0])?.price, PRICE) !== intent.priceId
    )
      fail("subscription_checkout_mismatch");
    await options.validatePrice(intent.priceId, intent.revision, false);
    return {
      organizationId: intent.org,
      subscriptionId,
      customerId,
      livemode: intent.livemode,
      planKey: intent.planKey,
      pricingRevision: intent.revision,
      priceId: intent.priceId,
      priceAmountMinor: intent.amount,
      includedMinor: intent.included,
      sessionId: session.id,
    };
  }
  async function associate(
    intent: CheckoutIntent,
    session: StripeBillingObject,
  ): Promise<Association> {
    const binding = await verifySubscription(intent, session);
    const customer = await client.get("customers", binding.customerId);
    const customerMeta = object(customer?.metadata);
    if (
      customer?.object !== "customer" ||
      customer.livemode !== binding.livemode ||
      (customerMeta?.organizationId != null &&
        customerMeta.organizationId !== binding.organizationId) ||
      (customerMeta?.takoserverPurpose != null && customerMeta.takoserverPurpose !== PURPOSE) ||
      connected(customer)
    )
      fail("subscription_customer_conflict");
    const priorCustomer = (
      await sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [
        intent.org,
      ])
    )[0];
    if (priorCustomer && priorCustomer.customer_id !== binding.customerId)
      fail("subscription_customer_conflict");
    if (options.requireBoundCustomer && !priorCustomer) fail("subscription_customer_conflict");
    if (priorCustomer) await options.validateCustomer(binding.organizationId, binding.customerId);
    const priorAssociation = await association(binding.subscriptionId);
    if (priorAssociation && canonicalJson(priorAssociation) !== canonicalJson(binding))
      fail("subscription_association_conflict");
    await sql.batch([
      {
        sql: "INSERT OR IGNORE INTO stripe_billing_customers (org_id, customer_id, created_at) VALUES (?, ?, ?)",
        params: [intent.org, binding.customerId, now()],
      },
      {
        sql: `INSERT OR IGNORE INTO stripe_billing_associations
        (subscription_id, org_id, customer_id, livemode, plan_key, pricing_revision, price_id, price_amount_minor, included_minor, session_id, association_generation, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          (SELECT COALESCE(MAX(association_generation), 0) + 1 FROM stripe_billing_associations WHERE org_id = ?), ?
        WHERE EXISTS (SELECT 1 FROM stripe_billing_customers WHERE org_id = ? AND customer_id = ?)`,
        params: [
          binding.subscriptionId,
          intent.org,
          binding.customerId,
          Number(binding.livemode),
          binding.planKey,
          binding.pricingRevision,
          binding.priceId,
          binding.priceAmountMinor,
          binding.includedMinor,
          binding.sessionId,
          intent.org,
          now(),
          intent.org,
          binding.customerId,
        ],
      },
      {
        sql: `UPDATE stripe_subscription_checkout_intents SET state = 'associated', customer_id = ?, subscription_id = ?, updated_at = ?
        WHERE id = ? AND session_id = ? AND state IN ('session_known','associated') AND (subscription_id IS NULL OR subscription_id = ?)`,
        params: [
          binding.customerId,
          binding.subscriptionId,
          now(),
          intent.id,
          binding.sessionId,
          binding.subscriptionId,
        ],
      },
      {
        sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN
          EXISTS (SELECT 1 FROM stripe_billing_customers WHERE org_id = ? AND customer_id = ?)
          AND EXISTS (SELECT 1 FROM stripe_billing_associations WHERE subscription_id = ? AND org_id = ?
            AND customer_id = ? AND livemode = ? AND plan_key = ? AND pricing_revision = ?
            AND price_id = ? AND price_amount_minor = ? AND included_minor = ? AND session_id = ?)
          AND EXISTS (SELECT 1 FROM stripe_subscription_checkout_intents WHERE id = ? AND state = 'associated'
            AND session_id = ? AND subscription_id = ? AND customer_id = ?)
          THEN 1 ELSE 0 END)`,
        params: [
          `guard_${crypto.randomUUID()}`,
          intent.org,
          binding.customerId,
          binding.subscriptionId,
          intent.org,
          binding.customerId,
          Number(binding.livemode),
          binding.planKey,
          binding.pricingRevision,
          binding.priceId,
          binding.priceAmountMinor,
          binding.includedMinor,
          binding.sessionId,
          intent.id,
          binding.sessionId,
          binding.subscriptionId,
          binding.customerId,
        ],
      },
    ]);
    const persisted = await association(binding.subscriptionId);
    const recorded = await byCheckoutId(intent.id);
    if (
      !persisted ||
      canonicalJson(persisted) !== canonicalJson(binding) ||
      recorded?.state !== "associated" ||
      recorded.subscriptionId !== binding.subscriptionId
    )
      fail("subscription_association_conflict");
    return binding;
  }
  async function exactSession(sessionId: string): Promise<StripeBillingObject | null> {
    return await client.get("checkout/sessions", sessionId);
  }
  async function recover(initial: CheckoutIntent): Promise<CheckoutIntent> {
    // A durable tail walk followed by a fixed head-prefix walk accounts for
    // Sessions that became visible ahead of the original head during paging.
    let current = initial;
    const persist = async (
      next: Partial<
        Pick<CheckoutIntent, "phase" | "after" | "scanHead" | "prefixHead" | "match" | "conflict">
      >,
    ) => {
      const phase = next.phase ?? current.phase,
        after = next.after === undefined ? current.after : next.after;
      const scanHead = next.scanHead === undefined ? current.scanHead : next.scanHead;
      const prefixHead = next.prefixHead === undefined ? current.prefixHead : next.prefixHead;
      const match = next.match === undefined ? current.match : next.match;
      const conflict = next.conflict === undefined ? current.conflict : next.conflict;
      const written = await sql.run(
        `UPDATE stripe_subscription_checkout_intents SET recovery_phase = ?, recovery_after_id = ?, recovery_scan_head_id = ?,
           recovery_prefix_head_id = ?, recovery_match_id = ?, recovery_conflict = ?, recovery_version = recovery_version + 1, updated_at = ?
         WHERE id = ? AND state = 'dispatched' AND session_id IS NULL AND recovery_version = ?`,
        [
          phase,
          after,
          scanHead,
          prefixHead,
          match,
          Number(conflict),
          now(),
          current.id,
          current.version,
        ],
      );
      if (written.changes !== 1) fail("subscription_checkout_unresolved");
      current = (await byCheckoutId(current.id)) ?? fail("subscription_checkout_unresolved");
    };
    const tally = (rows: readonly StripeBillingObject[]) => {
      let match = current.match,
        conflict = current.conflict;
      for (const row of rows) {
        if (!SESSION.test(row.id)) fail("subscription_checkout_unresolved");
        const meta = object(row.metadata);
        if (
          row.client_reference_id === current.id ||
          meta?.subscriptionCheckoutIntentId === current.id
        ) {
          if (match && match !== row.id) conflict = true;
          else match = row.id;
        }
      }
      return { match, conflict };
    };
    const finish = async (match: string | null, conflict: boolean) => {
      await persist({
        phase: "tail",
        after: null,
        scanHead: null,
        prefixHead: null,
        match,
        conflict,
      });
      if (!match || conflict) fail("subscription_checkout_unresolved");
      const exact = await exactSession(match);
      if (!exact || !sessionMatches(current, exact)) fail("subscription_checkout_unresolved");
      await exactLines(current, exact.id);
      return await bindSession(current, exact);
    };
    for (let page = 0; page < MAX_PAGES; page++) {
      if (
        (current.phase === "tail" && current.after && !current.scanHead) ||
        (current.phase === "prefix" &&
          (!current.scanHead || !current.prefixHead || !current.after)) ||
        (current.phase === "prefix_head" && (!current.scanHead || current.after))
      )
        fail("subscription_checkout_unresolved");
      const listed = await client.list("checkout/sessions", {
        limit: current.phase === "prefix_head" ? 1 : 100,
        ...(current.phase !== "prefix_head" && current.after
          ? { startingAfter: current.after }
          : {}),
      });
      if (current.phase === "prefix_head") {
        const head = listed.data[0]?.id;
        if (!head || !SESSION.test(head)) fail("subscription_checkout_unresolved");
        const seen = tally([listed.data[0] as StripeBillingObject]);
        if (head === current.scanHead) return await finish(seen.match, seen.conflict);
        await persist({ phase: "prefix", after: head, prefixHead: head, ...seen });
        continue;
      }
      const boundary =
        current.phase === "prefix"
          ? listed.data.findIndex((row) => row.id === current.scanHead)
          : -1;
      const seen = tally(boundary < 0 ? listed.data : listed.data.slice(0, boundary));
      if (boundary >= 0) return await finish(seen.match, seen.conflict);
      const last = listed.data.at(-1)?.id ?? null;
      if (listed.hasMore && (!last || !SESSION.test(last) || last === current.after))
        fail("subscription_checkout_unresolved");
      if (current.phase === "prefix") {
        if (!listed.hasMore) fail("subscription_checkout_unresolved");
        await persist({ after: last, ...seen });
      } else {
        const head = current.scanHead ?? listed.data[0]?.id ?? null;
        if (!head && !listed.hasMore) return await finish(seen.match, seen.conflict);
        if (!head || !SESSION.test(head)) fail("subscription_checkout_unresolved");
        await persist({
          phase: listed.hasMore ? "tail" : "prefix_head",
          after: listed.hasMore ? last : null,
          scanHead: head,
          ...seen,
        });
      }
    }
    return fail("subscription_checkout_unresolved");
  }
  async function assertCheckoutFingerprint(intent: CheckoutIntent): Promise<void> {
    if (
      intent.fingerprint !==
      (await hash([
        intent.org,
        intent.planKey,
        intent.revision,
        intent.priceId,
        intent.amount,
        intent.included,
        intent.livemode,
        "subscription",
      ]))
    )
      fail("subscription_checkout_mismatch");
  }
  async function retainedStartAssociation(intent: CheckoutIntent): Promise<Association> {
    if (!intent.sessionId || !SESSION.test(intent.sessionId) || !intent.subscriptionId)
      fail("subscription_checkout_unresolved");
    const bound = await association(intent.subscriptionId);
    if (
      !bound ||
      bound.organizationId !== intent.org ||
      bound.sessionId !== intent.sessionId ||
      bound.customerId !== intent.customerId ||
      bound.livemode !== intent.livemode ||
      bound.planKey !== intent.planKey ||
      bound.pricingRevision !== intent.revision ||
      bound.priceId !== intent.priceId ||
      bound.priceAmountMinor !== intent.amount ||
      bound.includedMinor !== intent.included
    )
      fail("subscription_checkout_unresolved");
    return bound;
  }
  function originalCommandKey(org: string, reference: string): Promise<string> {
    const valid = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
    if (
      typeof org !== "string" ||
      typeof reference !== "string" ||
      !valid.test(org) ||
      !valid.test(reference)
    )
      fail("invalid_argument");
    return hash([org, reference]);
  }
  /** Retained local proof only: never advance custody or call the processor. */
  async function readStartCommand(
    org: string,
    reference: string,
  ): Promise<SubscriptionStartCommandDescriptor | null> {
    const key = await originalCommandKey(org, reference);
    const intent = await byCheckoutKey(org, key);
    if (!intent) return null;
    if (intent.org !== org || intent.key !== key) fail("subscription_checkout_mismatch");
    await assertCheckoutFingerprint(intent);
    const base = {
      organizationId: org,
      reference,
      kind: "start" as const,
      planKey: intent.planKey,
      pricingRevision: intent.revision,
    };
    const url = intent.sessionUrl?.startsWith("https://checkout.stripe.com/")
      ? intent.sessionUrl
      : null;
    if (intent.state === "associated") {
      const bound = await retainedStartAssociation(intent);
      return {
        ...base,
        state: "associated" as const,
        subscriptionRef: await subscriptionRef(bound),
        checkout: url ? { url } : null,
      };
    }
    if (intent.state === "expired") {
      if (
        !intent.sessionId ||
        !SESSION.test(intent.sessionId) ||
        intent.subscriptionId ||
        intent.conflict
      )
        fail("subscription_checkout_unresolved");
      return { ...base, state: "expired" as const, subscriptionRef: null, checkout: null };
    }
    if (intent.state === "invalidated")
      return { ...base, state: "invalidated" as const, subscriptionRef: null, checkout: null };
    if (
      intent.state === "session_known" &&
      intent.sessionId &&
      SESSION.test(intent.sessionId) &&
      url &&
      !intent.conflict
    )
      return { ...base, state: "open" as const, subscriptionRef: null, checkout: { url } };
    if (!["prepared", "dispatched", "session_known"].includes(intent.state))
      fail("subscription_checkout_unresolved");
    return { ...base, state: "pending" as const, subscriptionRef: null, checkout: null };
  }
  /** A historical verified cancellation means scheduled, never target ended. */
  async function readCancelCommand(
    org: string,
    reference: string,
  ): Promise<SubscriptionCancellationCommandDescriptor | null> {
    const key = await originalCommandKey(org, reference);
    const intent = await byCancelKey(org, key);
    if (!intent) return null;
    const bound = await association(intent.subscriptionId);
    if (
      intent.org !== org ||
      intent.key !== key ||
      !bound ||
      bound.organizationId !== intent.org ||
      bound.customerId !== intent.customerId ||
      bound.livemode !== intent.livemode ||
      bound.planKey !== intent.planKey ||
      bound.pricingRevision !== intent.revision ||
      bound.priceId !== intent.priceId ||
      bound.priceAmountMinor !== intent.amount ||
      bound.includedMinor !== intent.included ||
      intent.fingerprint !==
        (await hash([
          intent.org,
          intent.subscriptionId,
          intent.customerId,
          intent.livemode,
          intent.planKey,
          intent.revision,
          intent.priceId,
          intent.amount,
          intent.included,
          intent.prePeriodEnd,
          "cancel_at_period_end",
        ]))
    )
      fail("subscription_management_conflict");
    const base = {
      organizationId: org,
      reference,
      kind: "cancel" as const,
      subscriptionRef: await subscriptionRef(bound),
      planKey: intent.planKey,
      pricingRevision: intent.revision,
    };
    if (intent.state === "verified") {
      if (!intent.effectiveAt) fail("subscription_management_unavailable");
      return {
        ...base,
        state: "verified" as const,
        effectiveAt: intent.effectiveAt,
        lifecycle: "scheduled" as const,
      };
    }
    if (!["prepared", "dispatched"].includes(intent.state) || intent.effectiveAt !== null)
      fail("subscription_management_unavailable");
    return { ...base, state: "pending" as const, effectiveAt: null, lifecycle: "pending" as const };
  }
  async function checkoutReceipt(intent: CheckoutIntent): Promise<CheckoutReceipt> {
    await assertCheckoutFingerprint(intent);
    if (intent.state === "associated") {
      const bound = await retainedStartAssociation(intent);
      return {
        id: bound.sessionId,
        state: "associated",
        subscriptionRef: await subscriptionRef(bound),
        ...(intent.sessionUrl?.startsWith("https://checkout.stripe.com/")
          ? { url: intent.sessionUrl }
          : {}),
      };
    }
    if (intent.state === "invalidated") fail("subscription_checkout_invalidated");
    if (intent.state === "expired") {
      if (!intent.sessionId || !SESSION.test(intent.sessionId))
        fail("subscription_checkout_unresolved");
      return { id: intent.sessionId, state: "expired" };
    }
    if (intent.state === "dispatched" && !intent.sessionId) {
      try {
        intent = await recover(intent);
      } catch (error) {
        if (
          !(error instanceof SubscriptionCustodyError || error instanceof StripeBillingClientError)
        )
          throw error;
        return { id: intent.id, state: "pending" };
      }
    }
    if (intent.state === "prepared") {
      const plan = plans.get(intent.planKey);
      async function invalidate(): Promise<CheckoutReceipt> {
        const changed = await sql.run(
          "UPDATE stripe_subscription_checkout_intents SET state = 'invalidated', updated_at = ? WHERE id = ? AND state = 'prepared'",
          [now(), intent.id],
        );
        if (changed.changes !== 1) {
          const latest =
            (await byCheckoutId(intent.id)) ?? fail("subscription_checkout_unresolved");
          if (latest.state !== "prepared") return await checkoutReceipt(latest);
          fail("subscription_checkout_pending");
        }
        fail("subscription_checkout_invalidated");
      }
      // A prepared row is not authority to dispatch yesterday's catalog or
      // customer. Re-evaluate at the exact external-effect boundary.
      if (
        !plan ||
        intent.revision !== options.pricingRevision ||
        intent.priceId !== plan.stripePriceId ||
        intent.amount !== plan.monthlyAmountMinor ||
        intent.included !== plan.includedCreditMinor ||
        intent.livemode !== livemode ||
        options.effectiveAt > now()
      )
        return await invalidate();
      try {
        await options.validatePrice(intent.priceId, intent.revision, true);
      } catch (error) {
        if (options.isConclusivePreflightFailure(error)) return await invalidate();
        throw error;
      }
      const currentCustomer = (
        await sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [
          intent.org,
        ])
      )[0];
      if ((currentCustomer?.customer_id ?? null) !== intent.customerId) return await invalidate();
      if (intent.customerId) {
        try {
          await options.validateCustomer(intent.org, intent.customerId);
        } catch (error) {
          if (options.isConclusivePreflightFailure(error)) return await invalidate();
          throw error;
        }
      }
      const competingState = await sql.query(
        `SELECT 1 AS blocked WHERE EXISTS
           (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND status NOT IN ('canceled','incomplete_expired'))
         OR EXISTS (SELECT 1 FROM stripe_billing_associations a WHERE a.org_id = ?
           AND a.association_generation = (SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id = ?)
           AND NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions s WHERE s.org_id = a.org_id AND s.subscription_id = a.subscription_id))`,
        [intent.org, intent.org, intent.org],
      );
      if (competingState.length) return await invalidate();
      const shared = managementGuard({
        organizationId: intent.org,
        operation: "begin",
        requestKeyDigest: intent.key,
        intentId: intent.id,
      });
      const claim = await sql.run(
        `UPDATE stripe_subscription_checkout_intents SET state = 'dispatched', updated_at = ?
         WHERE id = ? AND state = 'prepared' AND org_id = ? AND pricing_revision = ? AND price_id = ?
           AND price_amount_minor = ? AND included_minor = ? AND customer_id IS ?
           AND (SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?) IS ?
           AND NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND status NOT IN ('canceled','incomplete_expired'))
           AND NOT EXISTS (SELECT 1 FROM stripe_billing_associations a WHERE a.org_id = ?
             AND a.association_generation = (SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id = ?)
             AND NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions s WHERE s.org_id = a.org_id AND s.subscription_id = a.subscription_id))
           AND (${shared.condition})`,
        [
          now(),
          intent.id,
          intent.org,
          intent.revision,
          intent.priceId,
          intent.amount,
          intent.included,
          intent.customerId,
          intent.org,
          intent.customerId,
          intent.org,
          intent.org,
          intent.org,
          ...shared.params,
        ],
      );
      if (claim.changes !== 1) {
        const recorded =
          (await byCheckoutId(intent.id)) ?? fail("subscription_checkout_unresolved");
        if (recorded.state === "prepared") fail("subscription_checkout_pending");
        return await checkoutReceipt(recorded);
      }
      // This is the only Checkout POST site. Dispatched never returns to prepared.
      try {
        const form: Record<string, string> = {
          mode: "subscription",
          client_reference_id: intent.id,
          "line_items[0][price]": intent.priceId,
          "line_items[0][quantity]": "1",
          success_url: `${options.consoleOrigin}/billing?subscription={CHECKOUT_SESSION_ID}`,
          cancel_url: `${options.consoleOrigin}/billing?subscription=cancelled`,
        };
        if (intent.customerId) form.customer = intent.customerId;
        for (const [key, value] of Object.entries({
          organizationId: intent.org,
          takoserverPurpose: PURPOSE,
          subscriptionCheckoutIntentId: intent.id,
          planKey: intent.planKey,
          pricingRevision: intent.revision,
        })) {
          form[`metadata[${key}]`] = value;
          form[`subscription_data[metadata][${key}]`] = value;
        }
        const created = await client.post("checkout/sessions", {
          form,
          idempotencyKey: `takoserver-subscription-checkout:${intent.id}`,
        });
        if (!SESSION.test(created.id)) fail("subscription_checkout_unresolved");
        const exact = await exactSession(created.id);
        if (!exact || !sessionMatches(intent, exact)) fail("subscription_checkout_unresolved");
        await exactLines(intent, exact.id);
        intent = await bindSession(intent, exact);
      } catch {
        return { id: intent.id, state: "pending" };
      }
    }
    if (!intent.sessionId) return { id: intent.id, state: "pending" };
    try {
      const session = await exactSession(intent.sessionId);
      if (!session || !sessionMatches(intent, session)) fail("subscription_checkout_unresolved");
      await exactLines(intent, session.id);
      if (session.status === "expired") {
        await expireKnown(intent, session);
        return { id: session.id, state: "expired" };
      }
      if (session.status === "complete" && session.payment_status === "paid") {
        const bound = await associate(intent, session);
        return {
          id: session.id,
          state: "associated",
          subscriptionRef: await subscriptionRef(bound),
          ...(intent.sessionUrl ? { url: intent.sessionUrl } : {}),
        };
      }
      if (
        session.status === "open" &&
        intent.sessionUrl?.startsWith("https://checkout.stripe.com/")
      )
        return { id: session.id, state: "open", url: intent.sessionUrl };
    } catch (error) {
      if (!(error instanceof SubscriptionCustodyError || error instanceof StripeBillingClientError))
        throw error;
    }
    return { id: intent.id, state: "pending" };
  }
  async function associateSession(sessionId: string): Promise<Association> {
    if (!SESSION.test(sessionId)) fail("subscription_checkout_mismatch");
    const session = await exactSession(sessionId);
    const intentId = object(session?.metadata)?.subscriptionCheckoutIntentId;
    if (!session || typeof intentId !== "string") fail("subscription_checkout_mismatch");
    let intent = await byCheckoutId(intentId);
    if (!intent) fail("subscription_checkout_mismatch");
    if (intent.state === "dispatched" && !intent.sessionId) intent = await recover(intent);
    if (intent.sessionId !== sessionId) fail("subscription_checkout_mismatch");
    await exactLines(intent, session.id);
    return await associate(intent, session);
  }
  async function begin(org: string, requestKey: string, planKey: string): Promise<CheckoutReceipt> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestKey)) fail("invalid_argument");
    const replay = async (intent: CheckoutIntent): Promise<CheckoutReceipt> => {
      if (intent.planKey !== planKey) fail("reference_conflict");
      return await checkoutReceipt(intent);
    };
    const key = await hash([org, requestKey]);
    const existing = await byCheckoutKey(org, key);
    if (existing) return await replay(existing);
    const plan = plans.get(planKey);
    if (!plan) fail("unknown_plan");
    if (typeof client.sessionLineItems !== "function") fail("subscription_checkout_unresolved");
    if (options.effectiveAt > now()) fail("pricing_not_effective");
    const active = checkoutRow(
      (
        await sql.query(
          "SELECT * FROM stripe_subscription_checkout_intents WHERE org_id = ? AND state IN ('prepared','dispatched','session_known')",
          [org],
        )
      )[0],
    );
    if (active && active.livemode !== livemode) fail("subscription_checkout_mismatch");
    if (active) {
      try {
        await checkoutReceipt(active);
      } catch (error) {
        if (
          !(
            error instanceof SubscriptionCustodyError &&
            error.code === "subscription_checkout_invalidated"
          )
        )
          throw error;
      }
    }
    await managementPreflight({ organizationId: org, operation: "begin", requestKeyDigest: key });
    await options.validatePrice(plan.stripePriceId, options.pricingRevision, true);
    const ensuredCustomer = options.ensureCustomer ? await options.ensureCustomer(org) : null;
    const customer = (
      await sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [org])
    )[0];
    const customerId = customer ? String(customer.customer_id) : null;
    if (ensuredCustomer !== null && ensuredCustomer !== customerId)
      fail("subscription_checkout_mismatch");
    if (customerId) await options.validateCustomer(org, customerId);
    const intentId = `sci_${crypto.randomUUID()}`;
    const terms = [
      org,
      planKey,
      options.pricingRevision,
      plan.stripePriceId,
      plan.monthlyAmountMinor,
      plan.includedCreditMinor,
      livemode,
      "subscription",
    ];
    const shared = managementGuard({
      organizationId: org,
      operation: "begin",
      requestKeyDigest: key,
      intentId,
    });
    const inserted = await sql.run(
      `INSERT OR IGNORE INTO stripe_subscription_checkout_intents
       (id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?
       WHERE NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND status NOT IN ('canceled','incomplete_expired'))
         AND NOT EXISTS (SELECT 1 FROM stripe_subscription_checkout_intents WHERE org_id = ? AND state IN ('prepared','dispatched','session_known'))
         AND NOT EXISTS (SELECT 1 FROM stripe_billing_associations a
           WHERE a.org_id = ? AND a.association_generation =
             (SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id = ?)
             AND NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions s WHERE s.org_id = a.org_id AND s.subscription_id = a.subscription_id))
         AND (${shared.condition})`,
      [
        intentId,
        org,
        key,
        await hash(terms),
        planKey,
        options.pricingRevision,
        plan.stripePriceId,
        plan.monthlyAmountMinor,
        plan.includedCreditMinor,
        Number(livemode),
        customerId,
        now(),
        now(),
        org,
        org,
        org,
        org,
        ...shared.params,
      ],
    );
    if (inserted.changes !== 1) {
      const duplicate = await byCheckoutKey(org, key);
      if (duplicate) return await replay(duplicate);
      fail("subscription_checkout_pending");
    }
    return await checkoutReceipt(
      (await byCheckoutId(intentId)) ?? fail("subscription_checkout_unresolved"),
    );
  }

  async function readVerifiedSubscription(bound: Association, intent?: CancelIntent) {
    await options.validateCustomer(bound.organizationId, bound.customerId);
    const sub = await client.get("subscriptions", bound.subscriptionId);
    const meta = object(sub?.metadata),
      items = object(sub?.items);
    const item =
      Array.isArray(items?.data) && items?.data.length === 1 ? object(items.data[0]) : null;
    const start = instant(sub?.current_period_start),
      end = instant(sub?.current_period_end);
    if (
      sub?.object !== "subscription" ||
      sub.livemode !== bound.livemode ||
      connected(sub) ||
      id(sub.customer, CUSTOMER) !== bound.customerId ||
      meta?.organizationId !== bound.organizationId ||
      meta.takoserverPurpose !== PURPOSE ||
      sub.currency !== "usd" ||
      items?.has_more !== false ||
      !item ||
      item.quantity !== 1 ||
      !start ||
      !end ||
      start >= end ||
      typeof sub.cancel_at_period_end !== "boolean" ||
      !["active", "past_due", "trialing", "unpaid", "paused", "incomplete", "canceled"].includes(
        String(sub.status),
      ) ||
      (sub.schedule !== null && sub.schedule !== undefined)
    )
      fail("subscription_management_unavailable");
    const terms = options.resolveCurrentTerms
      ? await options.resolveCurrentTerms({
          association: bound,
          subscription: sub,
          periodStart: start,
          periodEnd: end,
        })
      : bound;
    if (
      meta.planKey !== terms.planKey ||
      meta.pricingRevision !== terms.pricingRevision ||
      id(item.price, PRICE) !== terms.priceId
    )
      fail("subscription_management_unavailable");
    await options.validatePrice(terms.priceId, terms.pricingRevision, false);
    if (intent && end < intent.prePeriodEnd) fail("subscription_management_unavailable");
    if (sub.status === "canceled") {
      const ended = instant(sub.ended_at),
        canceled = instant(sub.canceled_at);
      if (
        intent?.state !== "dispatched" ||
        sub.cancel_at_period_end !== true ||
        ended !== end ||
        !canceled ||
        Number(sub.canceled_at) < Math.floor(Date.parse(intent.createdAt) / 1000) ||
        Date.parse(canceled) > Date.parse(end) ||
        Date.parse(end) > clock().getTime()
      )
        fail("subscription_management_unavailable");
    } else if (Date.parse(end) <= clock().getTime()) fail("subscription_management_unavailable");
    if (
      (sub.cancel_at_period_end === false && sub.cancel_at != null) ||
      (sub.cancel_at_period_end === true &&
        sub.cancel_at != null &&
        sub.cancel_at !== sub.current_period_end)
    )
      fail("subscription_management_unavailable");
    return { sub, periodEnd: end, cancelAtPeriodEnd: sub.cancel_at_period_end };
  }
  async function cancelReceipt(intent: CancelIntent): Promise<CancellationReceipt> {
    const bound = await association(intent.subscriptionId);
    if (
      !bound ||
      bound.organizationId !== intent.org ||
      bound.customerId !== intent.customerId ||
      bound.livemode !== intent.livemode
    )
      fail("subscription_management_conflict");
    const ref = await subscriptionRef(bound);
    if (intent.state === "verified") {
      if (!intent.effectiveAt) fail("subscription_management_unavailable");
      return { state: "verified", subscriptionRef: ref, effectiveAt: intent.effectiveAt };
    }
    return { state: "pending", subscriptionRef: ref };
  }
  async function resumeCancel(intent: CancelIntent): Promise<CancellationReceipt> {
    const bound = await association(intent.subscriptionId);
    if (
      !bound ||
      bound.organizationId !== intent.org ||
      bound.customerId !== intent.customerId ||
      bound.priceId !== intent.priceId ||
      bound.priceAmountMinor !== intent.amount ||
      bound.pricingRevision !== intent.revision ||
      bound.includedMinor !== intent.included ||
      intent.fingerprint !==
        (await hash([
          intent.org,
          intent.subscriptionId,
          intent.customerId,
          intent.livemode,
          intent.planKey,
          intent.revision,
          intent.priceId,
          intent.amount,
          intent.included,
          intent.prePeriodEnd,
          "cancel_at_period_end",
        ]))
    )
      fail("subscription_management_conflict");
    if (intent.state === "verified") return await cancelReceipt(intent);
    if (intent.state === "dispatched") {
      try {
        const observed = await readVerifiedSubscription(bound, intent);
        if (observed.cancelAtPeriodEnd) {
          await sql.run(
            "UPDATE stripe_subscription_cancellation_intents SET state = 'verified', effective_at = ?, updated_at = ? WHERE id = ? AND state = 'dispatched' AND effective_at IS NULL",
            [observed.periodEnd, now(), intent.id],
          );
          return await cancelReceipt(
            (await byCancelId(intent.id)) ?? fail("subscription_management_unavailable"),
          );
        }
      } catch {
        /* A lost ACK only permits GET-only reconciliation. */
      }
      return await cancelReceipt(intent);
    }
    if (intent.state !== "prepared") fail("subscription_management_unavailable");
    const current = (
      await sql.query(
        "SELECT subscription_id, customer_id, cancel_at_period_end FROM stripe_billing_subscriptions WHERE org_id = ?",
        [intent.org],
      )
    )[0];
    if (
      current?.subscription_id !== intent.subscriptionId ||
      current.customer_id !== intent.customerId ||
      current.cancel_at_period_end !== 0
    )
      fail("subscription_management_conflict");
    const fresh = await readVerifiedSubscription(bound, intent);
    if (fresh.cancelAtPeriodEnd) fail("subscription_management_conflict");
    const shared = managementGuard({
      organizationId: intent.org,
      operation: "cancel",
      requestKeyDigest: intent.key,
      intentId: intent.id,
      subscriptionId: intent.subscriptionId,
    });
    const claimed = await sql.run(
      `UPDATE stripe_subscription_cancellation_intents SET state = 'dispatched', updated_at = ?
       WHERE id = ? AND state = 'prepared' AND EXISTS
         (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND subscription_id = ?
            AND customer_id = ? AND cancel_at_period_end = 0 AND status NOT IN ('canceled','incomplete_expired'))
         AND (${shared.condition})`,
      [now(), intent.id, intent.org, intent.subscriptionId, intent.customerId, ...shared.params],
    );
    if (claimed.changes !== 1) {
      const latest = await byCancelId(intent.id);
      if (latest?.state === "dispatched" || latest?.state === "verified")
        return await resumeCancel(latest);
      fail("subscription_management_conflict");
    }
    // This is the only cancellation POST site. Lost ACK never reopens it.
    try {
      await client.post("subscriptions", {
        id: intent.subscriptionId,
        form: { cancel_at_period_end: "true" },
        idempotencyKey: `takoserver-subscription-cancel:${intent.id}`,
      });
    } catch {
      /* GET-only recovery below. */
    }
    return await resumeCancel(
      (await byCancelId(intent.id)) ?? fail("subscription_management_unavailable"),
    );
  }
  async function cancel(
    org: string,
    requestKey: string,
    expectedSubscriptionRef: string,
  ): Promise<CancellationReceipt> {
    async function replay(intent: CancelIntent): Promise<CancellationReceipt> {
      const bound = await association(intent.subscriptionId);
      if (!bound || (await subscriptionRef(bound)) !== expectedSubscriptionRef)
        fail("subscription_management_conflict");
      const current = (
        await sql.query(
          "SELECT subscription_id FROM stripe_billing_subscriptions WHERE org_id = ?",
          [org],
        )
      )[0];
      if (current?.subscription_id !== intent.subscriptionId)
        fail("subscription_management_conflict");
      return await resumeCancel(intent);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestKey)) fail("invalid_argument");
    const key = await hash([org, requestKey]);
    const existing = await byCancelKey(org, key);
    if (existing) return await replay(existing);
    const current = (
      await sql.query("SELECT * FROM stripe_billing_subscriptions WHERE org_id = ?", [org])
    )[0];
    if (!current) fail("subscription_management_not_found");
    const bound = await association(String(current.subscription_id));
    if (
      !bound ||
      bound.organizationId !== org ||
      bound.customerId !== current.customer_id ||
      (await subscriptionRef(bound)) !== expectedSubscriptionRef
    )
      fail("subscription_management_conflict");
    if (
      current.cancel_at_period_end !== 0 ||
      ["canceled", "incomplete_expired"].includes(String(current.status))
    )
      fail("subscription_management_conflict");
    await managementPreflight({
      organizationId: org,
      operation: "cancel",
      requestKeyDigest: key,
      subscriptionId: bound.subscriptionId,
    });
    const verified = await readVerifiedSubscription(bound);
    if (verified.cancelAtPeriodEnd) fail("subscription_management_conflict");
    const intentId = `smc_${crypto.randomUUID()}`;
    const terms = [
      org,
      bound.subscriptionId,
      bound.customerId,
      bound.livemode,
      bound.planKey,
      bound.pricingRevision,
      bound.priceId,
      bound.priceAmountMinor,
      bound.includedMinor,
      verified.periodEnd,
      "cancel_at_period_end",
    ];
    const shared = managementGuard({
      organizationId: org,
      operation: "cancel",
      requestKeyDigest: key,
      intentId,
      subscriptionId: bound.subscriptionId,
    });
    const inserted = await sql.run(
      `INSERT OR IGNORE INTO stripe_subscription_cancellation_intents
       (id,org_id,request_key_digest,fingerprint,subscription_id,customer_id,livemode,plan_key,
        pricing_revision,price_id,price_amount_minor,included_minor,pre_period_end,state,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?
       WHERE EXISTS (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND subscription_id = ?
         AND customer_id = ? AND cancel_at_period_end = 0 AND status NOT IN ('canceled','incomplete_expired'))
       AND NOT EXISTS (SELECT 1 FROM stripe_subscription_cancellation_intents WHERE subscription_id = ? AND state IN ('prepared','dispatched'))
       AND (${shared.condition})`,
      [
        intentId,
        org,
        key,
        await hash(terms),
        bound.subscriptionId,
        bound.customerId,
        Number(bound.livemode),
        bound.planKey,
        bound.pricingRevision,
        bound.priceId,
        bound.priceAmountMinor,
        bound.includedMinor,
        verified.periodEnd,
        now(),
        now(),
        org,
        bound.subscriptionId,
        bound.customerId,
        bound.subscriptionId,
        ...shared.params,
      ],
    );
    if (inserted.changes !== 1) {
      const duplicate = await byCancelKey(org, key);
      if (duplicate) return await replay(duplicate);
      fail("subscription_management_conflict");
    }
    return await resumeCancel(
      (await byCancelId(intentId)) ?? fail("subscription_management_unavailable"),
    );
  }
  async function reconcilePending(): Promise<{
    examined: number;
    applied: number;
    unresolved: number;
    truncated: boolean;
  }> {
    let examined = 0,
      applied = 0,
      unresolved = 0,
      truncated = false;
    for (const stream of ["checkout", "cancellation"] as const) {
      await sql.run(
        "INSERT OR IGNORE INTO stripe_subscription_custody_reconcile (stream) VALUES (?)",
        [stream],
      );
      const checkpoint = (
        await sql.query(
          "SELECT cursor,generation FROM stripe_subscription_custody_reconcile WHERE stream = ?",
          [stream],
        )
      )[0];
      const cursor = checkpoint?.cursor == null ? null : String(checkpoint.cursor);
      const rows = await sql.query(
        stream === "checkout"
          ? `SELECT id FROM stripe_subscription_checkout_intents
             WHERE state IN ('dispatched','session_known') AND (? IS NULL OR id > ?) ORDER BY id LIMIT 100`
          : `SELECT id FROM stripe_subscription_cancellation_intents
             WHERE state = 'dispatched' AND (? IS NULL OR id > ?) ORDER BY id LIMIT 100`,
        [cursor, cursor],
      );
      for (const row of rows) {
        examined++;
        try {
          if (stream === "checkout") {
            const intent = await byCheckoutId(String(row.id));
            if (!intent || !["dispatched", "session_known"].includes(intent.state)) continue;
            const receipt = await checkoutReceipt(intent);
            if (receipt.state === "associated" || receipt.state === "expired") applied++;
            else unresolved++;
          } else {
            const intent = await byCancelId(String(row.id));
            if (intent?.state !== "dispatched") continue;
            const receipt = await resumeCancel(intent);
            if (receipt.state === "verified") applied++;
            else unresolved++;
          }
        } catch {
          unresolved++;
        }
      }
      const more = rows.length === 100;
      const next = more ? String(rows.at(-1)?.id) : null;
      const changed = await sql.run(
        `UPDATE stripe_subscription_custody_reconcile SET cursor = ?, generation = generation + 1
         WHERE stream = ? AND cursor IS ? AND generation = ?`,
        [next, stream, cursor, Number(checkpoint?.generation)],
      );
      if (changed.changes !== 1)
        throw new SubscriptionCustodyError("subscription_custody_reconcile_conflict");
      truncated ||= more;
    }
    const outstanding = (
      await sql.query(
        `SELECT
           (SELECT COUNT(*) FROM stripe_subscription_checkout_intents WHERE state IN ('dispatched','session_known')) +
           (SELECT COUNT(*) FROM stripe_subscription_cancellation_intents WHERE state = 'dispatched') AS count`,
      )
    )[0];
    unresolved = Number(outstanding?.count ?? 0);
    return { examined, applied, unresolved, truncated };
  }
  return {
    begin,
    cancel,
    association,
    associateSession,
    subscriptionRef,
    reconcilePending,
    readStartCommand,
    readCancelCommand,
  };
}
