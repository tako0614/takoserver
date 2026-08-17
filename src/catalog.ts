import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { canonicalDigest } from "./json.ts";
import type { DataProtocol } from "./ports.ts";

export type { DataProtocol };

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
  readonly providerId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly form: TakoformV1Alpha3FormRef;
  readonly price: OfferingPrice;
  /** Direct data-plane protocols this offering exposes, if any. */
  readonly protocols: readonly DataProtocol[];
  readonly regions?: readonly string[];
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
  find(offeringId: string): Offering | undefined;
  /** The offering that serves an exact Form, when exactly one does. */
  forForm(form: TakoformV1Alpha3FormRef): Offering | undefined;
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

    find(offeringId): Offering | undefined {
      const offering = byId.get(offeringId);
      return offering?.available ? offering : undefined;
    },

    forForm(form): Offering | undefined {
      const matches = [...byId.values()].filter(
        (offering) =>
          offering.available &&
          offering.form.apiVersion === form.apiVersion &&
          offering.form.kind === form.kind &&
          offering.form.definitionVersion === form.definitionVersion &&
          offering.form.schemaDigest === form.schemaDigest,
      );
      // Two offerings for one Form is a configuration error, not a choice the
      // Host is entitled to make on the customer's behalf.
      return matches.length === 1 ? matches[0] : undefined;
    },

    async digest(offering): Promise<`sha256:${string}`> {
      return await canonicalDigest({
        id: offering.id,
        providerId: offering.providerId,
        kind: offering.kind,
        form: offering.form,
        price: offering.price,
        protocols: [...offering.protocols].sort(),
      });
    },
  };
}
