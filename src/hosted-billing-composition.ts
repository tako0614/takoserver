import { type BillingConfig, parseBillingConfig } from "./billing-config.ts";
import type {
  Checkout,
  CustodiedSubscriptionPayments,
  SubscriptionPlanPayments,
} from "./control.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import {
  assertHostedPricingMatchesBilling,
  type HostedPricing,
  parseHostedPricing,
} from "./hosted-pricing.ts";
import {
  assertHostedSubscriptionAdapterSchema,
  createHostedSubscriptionAdapter,
} from "./hosted-subscription-adapter.ts";
import { canonicalJson } from "./json.ts";
import type { FundingSettlementVerifier } from "./ledger.ts";
import { assertOrgBillingSchema } from "./org-billing.ts";
import {
  assertOrgLimitPolicySchema,
  createOrgLimitPolicy,
  type OrgLimitPolicy,
  type OrgUsageWarningTransport,
} from "./org-limit-policy.ts";
import { assertOrgTopUpSchema, createOrgTopUps, OrgTopUpError } from "./org-top-up.ts";
import { workspaceAttributionSchemaReady } from "./org-workspace-usage.ts";
import type { PaymentEventContext, PaymentEvents } from "./payment-events.ts";
import {
  type PaymentSettings,
  paymentSettingsFromEnvironment,
  validatePaymentSettings,
} from "./payment-settings.ts";
import type { Clock, Sql } from "./ports.ts";
import { assertStripeBillingSchema, createStripeBilling } from "./stripe-billing.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";
import {
  assertStripeCustomerCustodySchema,
  createStripeCustomerCustody,
} from "./stripe-customer-custody.ts";
import { createStripeEvents } from "./stripe-events.ts";
import {
  checkoutSessionFunding,
  type StripeClient,
  StripeSettlementError,
} from "./stripe-settlement.ts";
import { assertTopUpSessionCommand, createStripeTopUpClient } from "./stripe-top-up-client.ts";
import type { SubscriptionCommandReceipts } from "./subscription-command-receipts.ts";

declare const compositionBrand: unique symbol;

export type HostedWarningDelivery =
  | { readonly state: "unavailable"; readonly reason: "transport-not-composed" }
  | { readonly state: "configured"; readonly transport: OrgUsageWarningTransport };

const PAYMENT_PREREQUISITES = Object.freeze([
  "canonical-subscription-custody",
  "authenticated-account-test-mode",
  "immutable-database-financial-realm",
  "top-up-original-settlement-pin",
  "subscription-service-period-verifier",
] as const);

interface HostedBillingStatusBase {
  readonly launchReady: false;
  readonly warningDelivery: "configured" | "unavailable";
}

export type HostedBillingStatus = HostedBillingStatusBase &
  (
    | {
        /** Local wallet policy is usable; processor authority remains unavailable. */
        readonly state: "wallet-policy-only";
        readonly topUps: false;
        readonly subscriptionStart: false;
        readonly subscriptionCancellation: false;
        readonly subscriptionPlanChange: false;
        readonly paymentPrerequisites: typeof PAYMENT_PREREQUISITES;
      }
    | {
        readonly state: "test-payments-configured";
        readonly topUps: true;
        readonly subscriptionStart: true;
        readonly subscriptionCancellation: true;
        readonly subscriptionPlanChange: true;
        readonly paymentPrerequisites: readonly [];
      }
  );

/** Only the read-only startup resolver below can construct an accepted bundle. */
interface HostedBillingCompositionBase {
  readonly [compositionBrand]: true;
  readonly limitPolicy: OrgLimitPolicy;
  readonly status: HostedBillingStatus;
  dispatchWarnings(limit?: number): Promise<number>;
}

export interface HostedBillingPaymentAssembly {
  readonly events: PaymentEvents;
  readonly subscriptionCustody: CustodiedSubscriptionPayments;
  readonly subscriptionPlans: SubscriptionPlanPayments;
  readonly subscriptionCommandReceipts: SubscriptionCommandReceipts;
}

/** Financial ports come only from a qualified factory, never an independent app override. */
export type HostedBillingComposition = HostedBillingCompositionBase &
  (
    | { readonly paymentActivation: false }
    | {
        readonly paymentActivation: true;
        readonly settlement: FundingSettlementVerifier;
        readonly checkout: Checkout;
        createPayments(context: PaymentEventContext): HostedBillingPaymentAssembly;
      }
  );

const origins = new WeakMap<
  HostedBillingComposition,
  {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly config: string;
  }
>();

/**
 * Prequalifies the local Hosted wallet lane without binding a financial database
 * to a key, registering a tariff, or inventing a processor capability. The
 * canonical custody/realm/settlement adapter is a separate required dependency;
 * this resolver deliberately has no way to declare it activated.
 */
export async function createHostedBillingComposition(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly billingConfig: BillingConfig;
  readonly paymentActivation: false;
  readonly warnings: HostedWarningDelivery;
}): Promise<HostedBillingComposition> {
  if (options.paymentActivation !== false)
    throw new TypeError("Hosted financial capabilities have not been composed");
  const config = parseBillingConfig(canonicalJson(options.billingConfig));
  if (!config) throw new TypeError("Hosted wallet policy requires billing configuration");
  const warnings = options.warnings;
  let transport: OrgUsageWarningTransport | undefined;
  if (warnings?.state === "configured" && typeof warnings.transport?.deliver === "function") {
    transport = Object.freeze({ deliver: warnings.transport.deliver.bind(warnings.transport) });
  } else if (warnings?.state !== "unavailable" || warnings.reason !== "transport-not-composed") {
    throw new TypeError("Hosted warning delivery capability must be resolved at startup");
  }

  // Each owner checks its own persisted inputs. Passing no config keeps this
  // startup check read-only; normal OrgBilling owns immutable tariff registration.
  await assertOrgBillingSchema(options.sql);
  await assertOrgLimitPolicySchema(options.sql);
  if (!(await workspaceAttributionSchemaReady(options.sql)))
    throw new TypeError("Hosted Workspace attribution schema is unavailable");
  for (const table of ["org_wallet_holds", "org_wallet_usage_records", "usage_events"]) {
    const columns = await options.sql.query(`PRAGMA table_info(${table})`);
    if (!columns.some((column) => column.name === "admission_policy_json"))
      throw new TypeError("Hosted wallet admission policy schema is unavailable");
  }
  const limitPolicy = Object.freeze(
    createOrgLimitPolicy({
      sql: options.sql,
      clock: options.clock,
    }),
  );
  const status: HostedBillingStatus = Object.freeze({
    state: "wallet-policy-only",
    launchReady: false,
    topUps: false,
    subscriptionStart: false,
    subscriptionCancellation: false,
    subscriptionPlanChange: false,
    paymentPrerequisites: PAYMENT_PREREQUISITES,
    warningDelivery: transport === undefined ? "unavailable" : "configured",
  });
  const bundle = Object.freeze({
    paymentActivation: false,
    limitPolicy,
    status,
    async dispatchWarnings(limit?: number) {
      if (transport === undefined)
        throw new TypeError("Hosted warning delivery transport is unavailable");
      return await limitPolicy.dispatchWarnings(transport, limit);
    },
  }) as HostedBillingComposition;
  origins.set(bundle, {
    sql: options.sql,
    clock: options.clock,
    config: canonicalJson(config),
  });
  return bundle;
}

/** Refuses object-shaped stubs and bundles qualified against another database. */
export function assertHostedBillingComposition(
  composition: HostedBillingComposition,
  context: { readonly sql: Sql; readonly clock: Clock; readonly billingConfig?: BillingConfig },
): void {
  const origin = origins.get(composition);
  if (
    !origin ||
    origin.sql !== context.sql ||
    origin.clock !== context.clock ||
    context.billingConfig === undefined ||
    origin.config !== canonicalJson(context.billingConfig)
  ) {
    throw new TypeError(
      "Hosted billing composition does not belong to this app SQL, clock and tariff",
    );
  }
}

/**
 * Configures genuine TEST payment ports after authenticated realm qualification.
 * Entry/deployment activation remains an independent owner operation. This
 * factory takes no key, creates no realm pin, and owns no separate funding writer.
 */
export async function createCanonicalHostedBillingComposition(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly billingConfig: BillingConfig;
  readonly pricing: HostedPricing;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly consoleOrigin: string;
  readonly warnings: HostedWarningDelivery;
  readonly webhookSecret: string;
  readonly settings?: PaymentSettings;
}): Promise<HostedBillingComposition> {
  assertHostedPricingMatchesBilling(options.pricing, options.billingConfig);
  const { sql, clock, client, realm, consoleOrigin } = options;
  const pricing = parseHostedPricing(options.pricing.environment.TAKOSERVER_HOSTED_PRICING);
  if (!pricing) throw new TypeError("Hosted pricing is unavailable");
  const billingConfig = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
  if (!billingConfig) throw new TypeError("Hosted billing tariff is unavailable");
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
    prices: pricing.hostedPlanTable.plans
      .filter((plan) => plan.tier === "subscription")
      .map((plan) => ({
        priceId: plan.stripePriceId,
        monthlyAmountMinor: plan.monthlyAmountMinor,
      })),
  });
  const compiledSettings = paymentSettingsFromEnvironment(pricing.environment);
  const settings = Object.freeze(
    validatePaymentSettings({ ...compiledSettings, ...options.settings }),
  );
  if (
    settings.checkoutMinimumMinor !== compiledSettings.checkoutMinimumMinor ||
    settings.checkoutMaximumMinor !== compiledSettings.checkoutMaximumMinor
  )
    throw new TypeError("Hosted Checkout bounds do not match the frozen pricing revision");
  const bounds = {
    minimumMinor: settings.checkoutMinimumMinor,
    maximumMinor: settings.checkoutMaximumMinor,
  };
  if (bounds.minimumMinor === undefined || bounds.maximumMinor === undefined)
    throw new TypeError("Hosted Checkout bounds are unavailable");
  const webhookSecret = options.webhookSecret?.trim();
  if (!webhookSecret?.startsWith("whsec_"))
    throw new TypeError("Hosted Stripe webhook capability is unavailable");
  const local = await createHostedBillingComposition({
    sql,
    clock,
    billingConfig,
    paymentActivation: false,
    warnings: options.warnings,
  });
  await assertStripeBillingSchema(sql);
  await assertHostedSubscriptionAdapterSchema(sql);
  await assertStripeCustomerCustodySchema(sql);
  await assertOrgTopUpSchema(sql);
  const customerCustody = createStripeCustomerCustody({ sql, clock, client, realm });
  const topUps = createOrgTopUps({
    sql,
    clock,
    client: createStripeTopUpClient({ sql, client, realm }),
    bounds: { minimumMinor: bounds.minimumMinor, maximumMinor: bounds.maximumMinor },
    consoleOrigin,
    async pin(organizationId) {
      return {
        customerId: await customerCustody.ensure(organizationId),
        accountId: realm.accountId,
        livemode: realm.livemode,
        financialRealm: realm.financialRealm,
        pricingRevision: billingConfig.revision,
        purchaseCreditExpiry: billingConfig.purchaseCreditExpiry,
      };
    },
  });
  const checkout: Checkout = Object.freeze({
    bounds: topUps.bounds,
    referenceRequired: true,
    receipt: topUps.receipt.bind(topUps),
    async begin({ organizationId, reference, amountMinor }: Parameters<Checkout["begin"]>[0]) {
      if (reference === undefined) throw new OrgTopUpError("invalid_argument");
      return await topUps.begin({ organizationId, reference, amountMinor });
    },
  });
  const settlement: FundingSettlementVerifier = {
    async verify({ organizationId, settlementProof }) {
      const command = await topUps.commandForSession(settlementProof);
      if (!command) throw new StripeSettlementError("unknown_session");
      if (command.organizationId !== organizationId)
        throw new StripeSettlementError("wrong_organization");
      const session = await client.get("checkout/sessions", settlementProof, {
        expand: ["payment_intent.latest_charge"],
      });
      if (!session) throw new StripeSettlementError("unknown_session");
      await assertTopUpSessionCommand({ sql, client, realm }, session, command);
      const funding = checkoutSessionFunding(session, {
        expectedOrganizationId: organizationId,
        requireHostMarker: true,
        mode: "test",
      });
      return {
        amountMinor: funding.amountMinor,
        fundingRef: funding.fundingRef,
        currency: funding.currency,
      };
    },
  };
  // These are the event scheduler's two authenticated reads. No unused fake
  // Checkout creator or independently keyed transport is supplied.
  const eventReader: Pick<StripeClient, "checkoutSession" | "listCheckoutSessions"> = {
    async checkoutSession(id) {
      return await client.get("checkout/sessions", id, {
        expand: ["payment_intent.latest_charge"],
      });
    },
    async listCheckoutSessions({ status, limit, startingAfter }) {
      const result = await client.list("checkout/sessions", {
        status,
        limit,
        ...(startingAfter === undefined ? {} : { startingAfter }),
      });
      return { sessions: result.data, hasMore: result.hasMore };
    },
  };
  const status: HostedBillingStatus = Object.freeze({
    state: "test-payments-configured",
    launchReady: false,
    topUps: true,
    subscriptionStart: true,
    subscriptionCancellation: true,
    subscriptionPlanChange: true,
    paymentPrerequisites: Object.freeze([]) as readonly [],
    warningDelivery: local.status.warningDelivery,
  });
  const bundle = Object.freeze({
    limitPolicy: local.limitPolicy,
    dispatchWarnings: local.dispatchWarnings.bind(local),
    status,
    paymentActivation: true,
    settlement,
    checkout,
    createPayments(context: PaymentEventContext): HostedBillingPaymentAssembly {
      if (context.sql !== sql || context.clock !== clock)
        throw new TypeError("Hosted payment context does not belong to this app SQL and clock");
      const hosted = createStripeBilling({
        client,
        context,
        pricing,
        consoleOrigin,
        mode: "test",
        realm,
        topUpCommandForSession: topUps.commandForSession.bind(topUps),
        ensureCustomer: customerCustody.ensure.bind(customerCustody),
        subscriptionExtensions: (context) => createHostedSubscriptionAdapter({ context, realm }),
      });
      if (!hosted.subscriptionPlans || !hosted.subscriptionCommandReceipts)
        throw new TypeError("Hosted subscription period adapter is unavailable");
      const notifications = createStripeEvents(
        {
          client: eventReader,
          handlers: hosted.handlers,
          handlerVersion: 1,
          ...(settings.reconcileLookbackSeconds === undefined
            ? {}
            : { reconcileLookbackSeconds: settings.reconcileLookbackSeconds }),
          webhook: {
            secret: webhookSecret,
            ...(settings.webhookToleranceSeconds === undefined
              ? {}
              : { toleranceSeconds: settings.webhookToleranceSeconds }),
          },
        },
        { ...context, credit: hosted.creditFunding },
      );
      const events: PaymentEvents = {
        ...notifications,
        subscriptions: hosted.subscriptions,
        creditFunding: hosted.creditFunding,
        async reconcile() {
          const [funding, billing] = await Promise.allSettled([
            notifications.reconcile(),
            hosted.reconcile(),
          ]);
          if (funding.status === "rejected") throw funding.reason;
          if (billing.status === "rejected") throw billing.reason;
          return { ...funding.value, billing: billing.value };
        },
      };
      return {
        events,
        subscriptionCustody: hosted.subscriptions,
        subscriptionPlans: hosted.subscriptionPlans,
        subscriptionCommandReceipts: hosted.subscriptionCommandReceipts,
      };
    },
  }) as HostedBillingComposition;
  origins.set(bundle, {
    sql,
    clock,
    config: canonicalJson(billingConfig),
  });
  return bundle;
}
