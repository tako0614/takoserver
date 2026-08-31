import type { Catalog, Offering } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { Provider, ProviderOffering } from "./provider-port.ts";
import { TakoformHostError } from "./takoform/types.ts";

export interface SoldProviderPlacement {
  readonly provider: Provider;
  readonly offering: ProviderOffering;
  readonly sold: Offering;
}

/**
 * The shared commercial-to-technical placement authority used by normal Host
 * identity mutations and by pre-mutation endpoint origin reservations.
 */
export function createSoldProviderPlacementSelector(options: {
  readonly providers: readonly Provider[];
  readonly catalog: Catalog;
}): {
  select(formRef: TakoformV1Alpha3FormRef, offeringId?: string): SoldProviderPlacement;
} {
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  if (providers.size !== options.providers.length) {
    throw new TypeError("duplicate provider pack id");
  }
  return {
    select(formRef, offeringId) {
      const candidates = options.catalog.offeringsFor(formRef);
      const sold = offeringId
        ? candidates.find((candidate) => candidate.id === offeringId)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (!sold) throw new TakoformHostError("unsupported_capability", 422);
      const provider = providers.get(sold.providerPackRef);
      const technical = provider?.offerings.filter(
        (candidate) => candidate.id === sold.id && sameForm(candidate.form, formRef),
      );
      if (!provider || technical?.length !== 1 || !technical[0]) {
        throw new TakoformHostError("backend_unavailable", 503);
      }
      return { provider, offering: technical[0], sold };
    },
  };
}

function sameForm(left: TakoformV1Alpha3FormRef, right: TakoformV1Alpha3FormRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}
