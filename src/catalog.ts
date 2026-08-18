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

export interface OfferingPrice {
  readonly currency: "USD";
  readonly unit: string;
  readonly unitPriceMinor: number;
}

export interface Offering {
  readonly id: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly supplyContractRef: string;
  readonly pricePlanRef: string;
  readonly kind: string;
  readonly displayName: string;
  readonly form: TakoformV1Alpha3FormRef;
  readonly price: OfferingPrice;
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
        kind: offering.kind,
        form: offering.form,
        price: offering.price,
        providedInterfaces: offering.providedInterfaces,
        bindingRefs: offering.bindingRefs,
        regions: [...offering.regions].sort(),
        portability: offering.portability,
        isolation: offering.isolation,
      });
    },
  };
}
