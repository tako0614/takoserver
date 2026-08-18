import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import { canonicalDigest } from "./json.ts";

/**
 * What Takoserver sells.
 *
 * An offering is a Takoform Form with a price attached: customers do not buy
 * abstract "resources", they buy the ability to apply one exact Form on one
 * backend. Offerings are static configuration rather than something discovered
 * per request — the previous design re-queried every backend on every
 * provision, which cost a round trip per backend to learn something that only
 * changes at deploy time.
 */

export interface PricePlanCharge {
  readonly meter: string;
  readonly amountMinor: number;
  /** Number of meter units bought by one charge. */
  readonly quantity?: number;
}

export interface PricePlan {
  readonly id: string;
  readonly currency: "USD";
  readonly recurring: PricePlanCharge;
  readonly meters: readonly PricePlanCharge[];
}

export interface PricedUsage {
  readonly amountMinor: number;
  readonly lines: readonly {
    readonly meter: string;
    readonly quantity: number;
    readonly amountMinor: number;
  }[];
}

export function priceRecurring(plan: PricePlan, quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("invalid quantity");
  const amount = plan.recurring.amountMinor * quantity;
  if (!Number.isSafeInteger(amount)) throw new TypeError("price overflow");
  return amount;
}

/** Prices already-aggregated usage; callers must not round each raw event separately. */
export function priceMeteredUsage(
  plan: PricePlan,
  usage: readonly { readonly meter: string; readonly quantity: number }[],
): PricedUsage {
  const quantities = new Map<string, number>();
  for (const item of usage) {
    if (!Number.isFinite(item.quantity) || item.quantity < 0)
      throw new TypeError("invalid quantity");
    quantities.set(item.meter, (quantities.get(item.meter) ?? 0) + item.quantity);
  }
  const rates = new Map(plan.meters.map((charge) => [charge.meter, charge]));
  const lines = [...quantities]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([meter, quantity]) => {
      const rate = rates.get(meter);
      if (!rate) throw new TypeError(`unknown meter: ${meter}`);
      const amountMinor = Math.ceil((quantity * rate.amountMinor) / (rate.quantity ?? 1));
      if (!Number.isSafeInteger(amountMinor)) throw new TypeError("price overflow");
      return { meter, quantity, amountMinor };
    });
  const amountMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (!Number.isSafeInteger(amountMinor)) throw new TypeError("price overflow");
  return { amountMinor, lines };
}

export interface Offering {
  readonly id: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly supplyContractRef: string;
  readonly pricePlanRef: string;
  readonly resourceClass: string;
  readonly deliveryMode:
    | "embedded-binding"
    | "managed-endpoint"
    | "native-credentials"
    | "provider-subaccount"
    | "white-label"
    | "byoc-management";
  readonly supportPolicyRef: string;
  readonly abusePolicyRef: string;
  readonly kind: string;
  readonly displayName: string;
  readonly form: TakoformV1Alpha3FormRef;
  readonly pricePlan: PricePlan;
  readonly providedInterfaces: readonly TakoformInterfaceRef[];
  readonly bindingRefs: readonly TakoformBindingRef[];
  readonly regions: readonly string[];
  readonly portability: {
    readonly api: "native" | "portable";
    readonly exportFormats: readonly string[];
    readonly importFormats: readonly string[];
    readonly migrationModes: readonly ("offline" | "online")[];
  };
  readonly isolation:
    | "shared-resource"
    | "dedicated-resource"
    | "provider-subaccount"
    | "dedicated-project"
    | "customer-byoc";
  readonly available: boolean;
  /**
   * A superseded definition. Still resolvable, so resources created under it
   * remain manageable, but not offered for sale — nobody should newly choose a
   * shape we have already moved on from.
   */
  readonly retired?: boolean;
}

export interface Catalog {
  list(): readonly Offering[];
  findOffering(offeringId: string): Offering | undefined;
  offeringsFor(form: TakoformV1Alpha3FormRef): readonly Offering[];
  /**
   * Pins the commercial terms a caller was quoted. A grant carries this digest
   * so a price or capability change between reservation and execution is
   * detected instead of silently honoured.
   */
  digest(offering: Offering): Promise<`sha256:${string}`>;
}

export function createCatalog(offerings: readonly Offering[]): Catalog {
  const byId = new Map<string, Offering>();
  for (const offering of offerings) {
    if (byId.has(offering.id)) throw new TypeError(`duplicate offering id: ${offering.id}`);
    byId.set(offering.id, structuredClone(offering));
  }

  return {
    list(): readonly Offering[] {
      return [...byId.values()].filter((offering) => offering.available && !offering.retired);
    },

    findOffering(offeringId): Offering | undefined {
      const offering = byId.get(offeringId);
      return offering?.available ? offering : undefined;
    },

    offeringsFor(form): readonly Offering[] {
      return [...byId.values()].filter(
        (offering) =>
          offering.available &&
          !offering.retired &&
          offering.form.apiVersion === form.apiVersion &&
          offering.form.kind === form.kind &&
          offering.form.definitionVersion === form.definitionVersion &&
          offering.form.schemaDigest === form.schemaDigest,
      );
    },

    async digest(offering): Promise<`sha256:${string}`> {
      return await canonicalDigest({
        id: offering.id,
        providerPackRef: offering.providerPackRef,
        providerInstallationRef: offering.providerInstallationRef,
        supplyContractRef: offering.supplyContractRef,
        pricePlanRef: offering.pricePlanRef,
        resourceClass: offering.resourceClass,
        deliveryMode: offering.deliveryMode,
        supportPolicyRef: offering.supportPolicyRef,
        abusePolicyRef: offering.abusePolicyRef,
        kind: offering.kind,
        form: offering.form,
        pricePlan: offering.pricePlan,
        providedInterfaces: offering.providedInterfaces,
        bindingRefs: offering.bindingRefs,
        regions: [...offering.regions].sort(),
        portability: offering.portability,
        isolation: offering.isolation,
      });
    },
  };
}
