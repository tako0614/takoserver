import type { Offering } from "./catalog.ts";
import {
  type CatalogCandidate,
  compileCatalog,
  type PricePlan,
  type ProviderInstallation,
  type SupplyContract,
} from "./catalog-compiler.ts";
import {
  createProviderPack,
  type ProviderPack,
  type ProviderPackDefinition,
} from "./provider-pack.ts";
import type { Provider } from "./provider-port.ts";

export interface DeploymentComposition {
  readonly offerings: readonly Offering[];
  readonly providerPacks: readonly ProviderPack[];
}

export type CatalogPlacement = Pick<
  CatalogCandidate,
  | "providerPackRef"
  | "providerInstallationRef"
  | "supplyContractRef"
  | "pricePlanRef"
  | "resourceClass"
  | "deliveryMode"
  | "supportPolicyRef"
  | "abusePolicyRef"
  | "portability"
  | "isolation"
>;

/** Joins one technical provider offering to explicit commercial placement. */
export function createCatalogCandidate(
  technical: Provider["offerings"][number],
  placement: CatalogPlacement,
): CatalogCandidate {
  return {
    id: technical.id,
    kind: technical.kind,
    displayName: technical.displayName,
    form: structuredClone(technical.form),
    providedInterfaces: structuredClone(technical.providedInterfaces),
    bindingRefs: structuredClone(technical.bindingRefs),
    regions: [...(technical.regions ?? [])],
    ...structuredClone(placement),
  };
}

/**
 * Turns one concrete provisioner into the smallest honest Provider Pack.
 *
 * Attachment, transfer, credential, meter, and cost capabilities are empty
 * until an adapter really implements them. A runtime entry must never infer
 * those capabilities merely because the provisioner can create a Resource.
 */
export function createProvisioningProviderPack(input: {
  readonly provider: Provider;
  readonly providerType: string;
  readonly capabilities?: Partial<
    Pick<
      ProviderPackDefinition,
      | "attachmentFactories"
      | "transferEndpoints"
      | "credentialIssuers"
      | "meterSources"
      | "costEstimators"
    >
  >;
}): ProviderPack {
  return createProviderPack({
    id: input.provider.id,
    providerType: input.providerType,
    provisioners: [input.provider],
    attachmentFactories: input.capabilities?.attachmentFactories ?? [],
    transferEndpoints: input.capabilities?.transferEndpoints ?? [],
    credentialIssuers: input.capabilities?.credentialIssuers ?? [],
    meterSources: input.capabilities?.meterSources ?? [],
    costEstimators: input.capabilities?.costEstimators ?? [],
  });
}

/**
 * Compiles the complete sellable catalog against the capabilities that are
 * actually present in this process.
 *
 * Partial publication is forbidden. A typo, expired contract, missing meter,
 * or unavailable region invalidates the deployment composition rather than
 * silently presenting a smaller catalog than the operator reviewed.
 */
export function compileDeploymentComposition(input: {
  readonly candidates: readonly CatalogCandidate[];
  readonly providerPacks: readonly ProviderPack[];
  readonly providerInstallations: readonly ProviderInstallation[];
  readonly supplyContracts: readonly SupplyContract[];
  readonly pricePlans: readonly PricePlan[];
  readonly now: Date;
}): DeploymentComposition {
  const packIds = new Set<string>();
  for (const pack of input.providerPacks) {
    if (packIds.has(pack.id)) {
      throw new TypeError(`duplicate runtime Provider Pack id: ${pack.id}`);
    }
    packIds.add(pack.id);
  }

  for (const candidate of input.candidates) {
    const pack = input.providerPacks.find((item) => item.id === candidate.providerPackRef);
    const matches =
      pack?.provisioners.flatMap((provider) =>
        provider.offerings.filter(
          (offering) =>
            offering.id === candidate.id &&
            offering.kind === candidate.kind &&
            sameJson(offering.form, candidate.form) &&
            sameJson(offering.providedInterfaces, candidate.providedInterfaces) &&
            sameJson(offering.bindingRefs, candidate.bindingRefs),
        ),
      ) ?? [];
    if (matches.length !== 1) {
      throw new TypeError(
        `deployment_catalog_invalid:${candidate.id}:provider_offering_${matches.length === 0 ? "missing" : "ambiguous"}`,
      );
    }
  }

  const compiled = compileCatalog({
    candidates: input.candidates,
    providerPacks: input.providerPacks.map((pack) => pack.descriptor),
    providerInstallations: input.providerInstallations,
    supplyContracts: input.supplyContracts,
    pricePlans: input.pricePlans,
    now: input.now,
  });
  if (compiled.diagnostics.length > 0) {
    const failures = compiled.diagnostics
      .map(({ offeringId, code }) => `${offeringId}:${code}`)
      .sort()
      .join(",");
    throw new TypeError(`deployment_catalog_invalid:${failures}`);
  }

  return {
    offerings: compiled.catalog.list(),
    providerPacks: [...input.providerPacks],
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
