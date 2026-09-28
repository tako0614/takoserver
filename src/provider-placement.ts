import type { Catalog, Offering } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { canonicalJson } from "./json.ts";
import type { Provider, ProviderOffering } from "./provider-port.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";
import { TakoformHostError } from "./takoform/types.ts";

export interface NoncommercialPlacementComposition {
  readonly installations: readonly {
    readonly provider: Provider;
    readonly providerInstallationRef: string;
  }[];
  resolve(input: {
    readonly tenantId: string;
    readonly space: string;
    readonly form: InstalledTakoformForm["identity"];
  }): Promise<{
    readonly tenantId: string;
    readonly space: string;
    readonly form: InstalledTakoformForm["identity"];
    readonly providerPackRef: string;
    readonly providerInstallationRef: string;
    readonly offeringId: string;
  } | null>;
}

/** Same exact operator placement validation for Host mutations and Host-owned origin minting. */
export function createNoncommercialProviderPlacementSelector(options: {
  readonly providers: readonly Provider[];
  readonly catalog: Catalog;
  readonly composition: NoncommercialPlacementComposition;
}): {
  select(input: {
    readonly tenantId: string;
    readonly space: string;
    readonly form: InstalledTakoformForm;
  }): Promise<{
    readonly provider: Provider;
    readonly offering: ProviderOffering;
    readonly providerInstallationRef: string;
  }>;
} {
  const byId = new Map(options.providers.map((provider) => [provider.id, provider]));
  return {
    async select(input) {
      const placement = await options.composition.resolve({
        tenantId: input.tenantId,
        space: input.space,
        form: structuredClone(input.form.identity),
      });
      if (!placement) throw new TakoformHostError("unsupported_capability", 422);
      const provider = byId.get(placement.providerPackRef);
      const offerings = provider?.offerings.filter(
        (candidate) =>
          candidate.id === placement.offeringId &&
          sameForm(candidate.form, input.form.identity.formRef),
      );
      if (
        !input.form.identity.packageDigest ||
        placement.tenantId !== input.tenantId ||
        placement.space !== input.space ||
        canonicalJson(placement.form) !== canonicalJson(input.form.identity) ||
        !placement.providerInstallationRef ||
        options.catalog.hasOfferingId(placement.offeringId) ||
        !provider ||
        provider.installedProviderInstallationRef !== placement.providerInstallationRef ||
        offerings?.length !== 1 ||
        !offerings[0]?.capabilities.includes("create") ||
        options.composition.installations.filter(
          (installation) =>
            installation.provider === provider &&
            installation.providerInstallationRef === placement.providerInstallationRef,
        ).length !== 1
      ) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      return {
        provider,
        offering: offerings[0],
        providerInstallationRef: placement.providerInstallationRef,
      };
    },
  };
}

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
