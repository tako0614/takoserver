import {
  type BillingConfig,
  type PurchaseCreditExpiry,
  parseBillingConfig,
} from "./billing-config.ts";
import type {
  Checkout,
  CustodiedSubscriptionPayments,
  SubscriptionPlanPayments,
} from "./control.ts";
import {
  captureFinancialDisplayInput,
  createFinancialDisplayedTermsSource,
  type FinancialDisplayedTermsR1,
} from "./financial-displayed-terms.ts";
import {
  assertHostedBillingFinancialRealm,
  assertHostedBillingFinancialRealmPersisted,
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
  assertOrgPostpaidLaunchGate,
  createOrgLimitPolicy,
  type OrgLimitPolicy,
  type OrgUsageWarningTransport,
} from "./org-limit-policy.ts";
import { type OrgOnDemandTerms, parseOrgOnDemandTerms } from "./org-on-demand-terms.ts";
import { assertOrgTopUpSchema, createOrgTopUps, OrgTopUpError } from "./org-top-up.ts";
import { workspaceAttributionSchemaReady } from "./org-workspace-usage.ts";
import type { PaymentEventContext, PaymentEvents } from "./payment-events.ts";
import {
  type PaymentSettings,
  paymentSettingsFromEnvironment,
  validatePaymentSettings,
} from "./payment-settings.ts";
import type { Clock, Sql } from "./ports.ts";
import type { SelectedSubscriptionStartEconomicR1 } from "./stripe-billing.ts";
import { assertStripeBillingSchema, createStripeBilling } from "./stripe-billing.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";
import { createStripeBillingStore, type StripeBillingStore } from "./stripe-billing-store.ts";
import {
  assertStripeCardSetupSchema,
  createStripeCardSetup,
  StripeCardSetupError,
} from "./stripe-card-setup.ts";
import {
  assertStripeCustomerCustodySchema,
  createStripeCustomerCustody,
} from "./stripe-customer-custody.ts";
import { createStripeEvents } from "./stripe-events.ts";
import {
  assertStripeOnDemandService,
  createStripeOnDemand,
  type StripeOnDemandService,
} from "./stripe-on-demand.ts";
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
  readonly onDemand: boolean;
  readonly cardSetup: boolean;
  readonly postpaid: false;
}

export interface HostedOnDemandConfiguration {
  readonly terms: unknown;
  readonly cardSetupReturnUrls: {
    readonly successUrl: string;
    readonly cancelUrl: string;
  };
  readonly setupDisclosureRevision: string;
}

function resolveOnDemandConfiguration(value: HostedOnDemandConfiguration): {
  readonly terms: OrgOnDemandTerms;
  readonly cardSetupReturnUrls: HostedOnDemandConfiguration["cardSetupReturnUrls"];
  readonly setupDisclosureRevision: string;
} {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== 3 ||
    ["terms", "cardSetupReturnUrls", "setupDisclosureRevision"].some((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return !property || !("value" in property);
    })
  )
    throw new TypeError("Hosted on-demand configuration must be explicit");
  const terms = parseOrgOnDemandTerms(value.terms);
  const urls = value.cardSetupReturnUrls;
  if (
    !urls ||
    typeof urls !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(urls)) ||
    Reflect.ownKeys(urls).length !== 2 ||
    ["successUrl", "cancelUrl"].some((key) => {
      const property = Object.getOwnPropertyDescriptor(urls, key);
      return !property || !("value" in property) || typeof property.value !== "string";
    }) ||
    typeof value.setupDisclosureRevision !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.setupDisclosureRevision)
  )
    throw new TypeError("Hosted card setup disclosure and return URLs must be explicit");
  return Object.freeze({
    terms,
    cardSetupReturnUrls: Object.freeze({ successUrl: urls.successUrl, cancelUrl: urls.cancelUrl }),
    setupDisclosureRevision: value.setupDisclosureRevision,
  });
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
  readonly onDemand?: StripeOnDemandService;
  readonly cardSetup?: ReturnType<typeof createStripeCardSetup>;
  readonly setupDisclosureRevision?: string;
  dispatchWarnings(limit?: number): Promise<number>;
}

export interface HostedBillingPaymentAssembly {
  readonly events: PaymentEvents;
  readonly subscriptionCustody: CustodiedSubscriptionPayments;
  readonly subscriptionPlans: SubscriptionPlanPayments;
  readonly subscriptionCommandReceipts: SubscriptionCommandReceipts;
  readonly preparePlanChangeEconomicR1: NonNullable<
    ReturnType<typeof createStripeBilling>["subscriptionPlans"]
  >["preparePlanChangeEconomicR1"];
  readonly prepareCancellationEconomicR1: NonNullable<
    ReturnType<typeof createStripeBilling>["prepareCancellationEconomicR1"]
  >;
  selectSubscriptionStartEconomicR1(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly planKey: string;
  }): Promise<SelectedSubscriptionStartEconomicR1>;
  /** NEW display DATA from the exact existing selector; neither consent nor R1.prepare. */
  selectSubscriptionStartDisplayedTermsR1(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly planKey: string;
  }): Promise<FinancialDisplayedTermsR1>;
  preparePlanChangeDisplayedTermsR1(
    input: Parameters<HostedBillingPaymentAssembly["preparePlanChangeEconomicR1"]>[0],
  ): Promise<FinancialDisplayedTermsR1>;
  prepareCancellationDisplayedTermsR1(
    input: Parameters<HostedBillingPaymentAssembly["prepareCancellationEconomicR1"]>[0],
  ): Promise<FinancialDisplayedTermsR1>;
}

/** Data-only pre-C0 economic choice; neither a Customer pin nor displayed terms. */
export interface SelectedTopUpEconomicR1 {
  readonly kind: "topup";
  readonly amountMinor: number;
  readonly currency: "USD";
  readonly pricingRevision: string;
  readonly purchaseCreditExpiry: PurchaseCreditExpiry;
  readonly minimumMinor: number;
  readonly maximumMinor: number;
  readonly accountId: string;
  readonly livemode: false;
  readonly financialRealm: string;
}

/** Data-only disclosure selection; no card, Customer or consent qualification. */
export interface SelectedCardSetupEconomicR1 {
  readonly kind: "card-setup";
  readonly setupDisclosureRevision: string;
  readonly onDemandTermsRevision: string;
}

/** Financial ports come only from a qualified factory, never an independent app override. */
export type HostedBillingComposition = HostedBillingCompositionBase &
  (
    | { readonly paymentActivation: false }
    | {
        readonly paymentActivation: true;
        readonly settlement: FundingSettlementVerifier;
        readonly checkout: Checkout;
        selectTopUpEconomicR1(input: {
          readonly organizationId: string;
          readonly reference: string;
          readonly amountMinor: number;
        }): Promise<SelectedTopUpEconomicR1>;
        selectCardSetupEconomicR1(): Promise<SelectedCardSetupEconomicR1>;
        selectTopUpDisplayedTermsR1(input: {
          readonly organizationId: string;
          readonly reference: string;
          readonly amountMinor: number;
        }): Promise<FinancialDisplayedTermsR1>;
        selectCardSetupDisplayedTermsR1(): Promise<FinancialDisplayedTermsR1>;
        createPayments(context: PaymentEventContext): HostedBillingPaymentAssembly;
      }
  );

const origins = new WeakMap<
  HostedBillingComposition,
  {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly config: string;
    readonly onDemand?: StripeOnDemandService;
    readonly cardSetup?: ReturnType<typeof createStripeCardSetup>;
    readonly setupDisclosureRevision?: string;
    readonly onDemandConfiguration?: string;
    readonly client?: StripeBillingClient;
    readonly realm?: HostedBillingFinancialRealm;
    readonly store?: StripeBillingStore;
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
  /** Operator launch flag; defaults off until owner approval and qualified execution. */
  readonly postpaidEnabled?: boolean | undefined;
}): Promise<HostedBillingComposition> {
  const postpaidEnabled = options.postpaidEnabled;
  assertOrgPostpaidLaunchGate(postpaidEnabled);
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
      postpaidEnabled,
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
    onDemand: false,
    cardSetup: false,
    postpaid: false,
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
    origin.config !== canonicalJson(context.billingConfig) ||
    origin.onDemand !== composition.onDemand ||
    origin.cardSetup !== composition.cardSetup ||
    origin.setupDisclosureRevision !== composition.setupDisclosureRevision
  ) {
    throw new TypeError(
      "Hosted billing composition does not belong to this app SQL, clock and tariff",
    );
  }
  if (composition.onDemand) {
    if (!origin.client || !origin.realm || !origin.store || !origin.onDemandConfiguration)
      throw new TypeError("Hosted on-demand origin is unavailable");
    assertStripeOnDemandService(composition.onDemand, {
      sql: context.sql,
      clock: context.clock,
      billingConfig: context.billingConfig,
      client: origin.client,
      realm: origin.realm,
      store: origin.store,
    });
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
  /** Operator launch flag; defaults off until owner approval and qualified execution. */
  readonly postpaidEnabled?: boolean | undefined;
  /** Explicit operator terms and card return flow; absence keeps fresh charging disabled. */
  readonly onDemand?: HostedOnDemandConfiguration;
}): Promise<HostedBillingComposition> {
  const postpaidEnabled = options.postpaidEnabled;
  assertOrgPostpaidLaunchGate(postpaidEnabled);
  const onDemandConfiguration =
    options.onDemand === undefined ? undefined : resolveOnDemandConfiguration(options.onDemand);
  assertHostedPricingMatchesBilling(options.pricing, options.billingConfig);
  const { sql, clock, client, realm, consoleOrigin } = options;
  const pricing = parseHostedPricing(options.pricing.environment.TAKOSERVER_HOSTED_PRICING);
  if (!pricing) throw new TypeError("Hosted pricing is unavailable");
  const billingConfig = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
  if (!billingConfig) throw new TypeError("Hosted billing tariff is unavailable");
  const realmPriceProofs = pricing.hostedPlanTable.plans
    .filter((plan) => plan.tier === "subscription")
    .map((plan) => ({
      priceId: plan.stripePriceId,
      monthlyAmountMinor: plan.monthlyAmountMinor,
    }));
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
    prices: realmPriceProofs,
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
  const minimumMinor = settings.checkoutMinimumMinor;
  const maximumMinor = settings.checkoutMaximumMinor;
  if (minimumMinor === undefined || maximumMinor === undefined)
    throw new TypeError("Hosted Checkout bounds are unavailable");
  const bounds = { minimumMinor, maximumMinor };
  const webhookSecret = options.webhookSecret?.trim();
  if (!webhookSecret?.startsWith("whsec_"))
    throw new TypeError("Hosted Stripe webhook capability is unavailable");
  const local = await createHostedBillingComposition({
    sql,
    clock,
    billingConfig,
    paymentActivation: false,
    warnings: options.warnings,
    postpaidEnabled,
  });
  await assertStripeBillingSchema(sql);
  await assertHostedSubscriptionAdapterSchema(sql);
  await assertStripeCustomerCustodySchema(sql);
  await assertOrgTopUpSchema(sql);
  const store = createStripeBillingStore({ sql, clock });
  const cardSetup =
    onDemandConfiguration === undefined
      ? undefined
      : createStripeCardSetup({
          sql,
          clock,
          client,
          realm,
          explicitReturnUrls: onDemandConfiguration.cardSetupReturnUrls,
        });
  if (cardSetup) await assertStripeCardSetupSchema(sql);
  const onDemand =
    onDemandConfiguration === undefined
      ? undefined
      : await createStripeOnDemand({
          sql,
          clock,
          client,
          realm,
          store,
          billingConfig,
          terms: onDemandConfiguration.terms,
        });
  const limitPolicy =
    onDemand === undefined
      ? local.limitPolicy
      : Object.freeze(
          createOrgLimitPolicy({
            sql,
            clock,
            postpaidEnabled,
            onDemand,
          }),
        );
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
    onDemand: onDemand !== undefined,
    cardSetup: cardSetup !== undefined,
    postpaid: false,
  });
  const economicSelections = Object.freeze({
    async selectCardSetupEconomicR1(): Promise<SelectedCardSetupEconomicR1> {
      if (onDemandConfiguration === undefined) throw new StripeCardSetupError("unavailable");
      // Read only the original constructor-owned values. A later service facade or
      // caller-owned configuration cannot replace the selected disclosure/terms.
      const selected = Object.freeze({
        kind: "card-setup" as const,
        setupDisclosureRevision: onDemandConfiguration.setupDisclosureRevision,
        onDemandTermsRevision: onDemandConfiguration.terms.termsRevision,
      });
      try {
        await assertHostedBillingFinancialRealmPersisted(realm, {
          sql,
          client,
          billingAuthority: realm.billingAuthority,
          prices: realmPriceProofs,
        });
      } catch {
        throw new StripeCardSetupError("unavailable");
      }
      return selected;
    },
    async selectTopUpEconomicR1({
      organizationId,
      reference,
      amountMinor,
    }: {
      readonly organizationId: string;
      readonly reference: string;
      readonly amountMinor: number;
    }): Promise<SelectedTopUpEconomicR1> {
      const validRef = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
      if (
        typeof organizationId !== "string" ||
        !validRef.test(organizationId) ||
        typeof reference !== "string" ||
        !validRef.test(reference) ||
        !Number.isSafeInteger(amountMinor) ||
        amountMinor <= 0 ||
        amountMinor < bounds.minimumMinor ||
        amountMinor > bounds.maximumMinor
      )
        throw new OrgTopUpError("invalid_argument");
      try {
        await assertHostedBillingFinancialRealmPersisted(realm, {
          sql,
          client,
          billingAuthority: realm.billingAuthority,
          prices: realmPriceProofs,
        });
      } catch {
        throw new OrgTopUpError("unavailable");
      }
      return Object.freeze({
        kind: "topup",
        amountMinor,
        currency: "USD",
        pricingRevision: billingConfig.revision,
        purchaseCreditExpiry: Object.freeze({ ...billingConfig.purchaseCreditExpiry }),
        minimumMinor: bounds.minimumMinor,
        maximumMinor: bounds.maximumMinor,
        accountId: realm.accountId,
        livemode: false,
        financialRealm: realm.financialRealm,
      });
    },
  });
  const topUpEconomicSelector = economicSelections.selectTopUpEconomicR1;
  const cardSetupEconomicSelector = economicSelections.selectCardSetupEconomicR1;
  const displayedTerms = createFinancialDisplayedTermsSource({
    billingConfig,
    plans: pricing.hostedPlanTable.plans.flatMap((plan) =>
      plan.tier === "subscription"
        ? [
            {
              planKey: plan.planId,
              priceId: plan.stripePriceId,
              priceAmountMinor: plan.monthlyAmountMinor,
              includedMinor: plan.includedCreditMinor,
            },
          ]
        : [],
    ),
    checkoutBounds: { minimumMinor, maximumMinor },
    onDemand:
      onDemandConfiguration === undefined
        ? null
        : {
            setupDisclosureRevision: onDemandConfiguration.setupDisclosureRevision,
            terms: onDemandConfiguration.terms,
          },
    postpaidEnabled: false,
  });
  const bundle = Object.freeze({
    limitPolicy,
    dispatchWarnings: local.dispatchWarnings.bind(local),
    ...(onDemand === undefined ? {} : { onDemand }),
    ...(cardSetup === undefined ? {} : { cardSetup }),
    ...(onDemandConfiguration === undefined
      ? {}
      : {
          setupDisclosureRevision: onDemandConfiguration.setupDisclosureRevision,
        }),
    status,
    paymentActivation: true,
    settlement,
    checkout,
    selectTopUpEconomicR1: topUpEconomicSelector,
    selectCardSetupEconomicR1: cardSetupEconomicSelector,
    async selectTopUpDisplayedTermsR1(input: {
      readonly organizationId: string;
      readonly reference: string;
      readonly amountMinor: number;
    }): Promise<FinancialDisplayedTermsR1> {
      const selected = captureFinancialDisplayInput(input, [
        "organizationId",
        "reference",
        "amountMinor",
      ]);
      const economic = await topUpEconomicSelector.call(economicSelections, selected);
      return displayedTerms.fromEconomic(economic);
    },
    async selectCardSetupDisplayedTermsR1(): Promise<FinancialDisplayedTermsR1> {
      const economic = await cardSetupEconomicSelector.call(economicSelections);
      return displayedTerms.fromEconomic(economic);
    },
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
        store,
        ...(onDemand === undefined ? {} : { onDemand }),
        ...(cardSetup === undefined ? {} : { cardSetup }),
        topUpCommandForSession: topUps.commandForSession.bind(topUps),
        ensureCustomer: customerCustody.ensure.bind(customerCustody),
        subscriptionExtensions: (context) => createHostedSubscriptionAdapter({ context, realm }),
      });
      if (
        !hosted.subscriptionPlans ||
        !hosted.subscriptionCommandReceipts ||
        !hosted.prepareCancellationEconomicR1
      )
        throw new TypeError("Hosted subscription period adapter is unavailable");
      // Save the actual callable and its original receiver once. A later mutable
      // assembly facade cannot replace the source used by these display methods.
      const subscriptionStartSelector = hosted.selectSubscriptionStartEconomicR1;
      const planChangeReceiver = hosted.subscriptionPlans;
      const planChangeSelector = planChangeReceiver.preparePlanChangeEconomicR1;
      const cancellationSelector = hosted.prepareCancellationEconomicR1;
      if (
        typeof subscriptionStartSelector !== "function" ||
        typeof planChangeSelector !== "function" ||
        typeof cancellationSelector !== "function"
      )
        throw new TypeError("Hosted economic selection source is unavailable");
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
        selectSubscriptionStartEconomicR1: hosted.selectSubscriptionStartEconomicR1,
        preparePlanChangeEconomicR1: hosted.subscriptionPlans.preparePlanChangeEconomicR1,
        prepareCancellationEconomicR1: hosted.prepareCancellationEconomicR1,
        async selectSubscriptionStartDisplayedTermsR1(input): Promise<FinancialDisplayedTermsR1> {
          const selected = captureFinancialDisplayInput(input, [
            "organizationId",
            "reference",
            "planKey",
          ]);
          const economic = await subscriptionStartSelector.call(hosted, selected);
          return displayedTerms.fromEconomic(economic);
        },
        async preparePlanChangeDisplayedTermsR1(input): Promise<FinancialDisplayedTermsR1> {
          const selected = captureFinancialDisplayInput(input, [
            "organizationId",
            "reference",
            "expectedSubscriptionRef",
            "planKey",
          ]);
          const economic = await planChangeSelector.call(planChangeReceiver, selected);
          return displayedTerms.fromEconomic(economic);
        },
        async prepareCancellationDisplayedTermsR1(input): Promise<FinancialDisplayedTermsR1> {
          const selected = captureFinancialDisplayInput(input, [
            "organizationId",
            "reference",
            "expectedSubscriptionRef",
          ]);
          const economic = await cancellationSelector.call(hosted, selected);
          return displayedTerms.fromEconomic(economic);
        },
      };
    },
  }) as HostedBillingComposition;
  origins.set(bundle, {
    sql,
    clock,
    config: canonicalJson(billingConfig),
    ...(onDemand === undefined ? {} : { onDemand }),
    ...(cardSetup === undefined ? {} : { cardSetup }),
    ...(onDemandConfiguration === undefined
      ? {}
      : {
          setupDisclosureRevision: onDemandConfiguration.setupDisclosureRevision,
          onDemandConfiguration: canonicalJson(onDemandConfiguration),
        }),
    client,
    realm,
    store,
  });
  return bundle;
}
