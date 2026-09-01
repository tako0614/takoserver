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
import { canMaterializeAcrossProviderPacks } from "./provider-runtime-bindings.ts";
import { EDGE_OBJECTS_BINDING_REF } from "./providers/cloudflare-runtime-bindings.ts";
import type { TakoformBindingRef } from "./takoform/types.ts";

export interface DeploymentComposition {
  readonly offerings: readonly Offering[];
  readonly providerPacks: readonly ProviderPack[];
}

/**
 * Explicit composition evidence joining one target Offering to one concrete
 * consumer Provider Pack through an exact portable Binding.
 *
 * The compiler never guesses the consumer from a shared provider name or from
 * a provisioner's ability to create the target Resource.
 */
export interface DeploymentRuntimeBindingRelation {
  readonly targetOfferingId: string;
  readonly consumerProviderPackRef: string;
  readonly bindingRef: TakoformBindingRef;
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
      | "runtimeBindingMaterializer"
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
    ...(input.capabilities?.runtimeBindingMaterializer
      ? { runtimeBindingMaterializer: input.capabilities.runtimeBindingMaterializer }
      : {}),
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
  readonly runtimeBindingRelations?: readonly DeploymentRuntimeBindingRelation[];
  readonly now: Date;
}): DeploymentComposition {
  const packsById = new Map<string, ProviderPack>();
  for (const pack of input.providerPacks) {
    if (packsById.has(pack.id)) {
      throw new TypeError(`duplicate runtime Provider Pack id: ${pack.id}`);
    }
    packsById.set(pack.id, pack);
  }

  validateRuntimeBindingRelations({
    candidates: input.candidates,
    packsById,
    relations: input.runtimeBindingRelations ?? [],
  });
  const providerPacks = projectRuntimeBindingAdvertisements(
    input.providerPacks,
    input.runtimeBindingRelations ?? [],
  );
  const advertisedPacksById = new Map(providerPacks.map((pack) => [pack.id, pack]));

  for (const candidate of input.candidates) {
    const pack = advertisedPacksById.get(candidate.providerPackRef);
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
    providerPacks: providerPacks.map((pack) => pack.descriptor),
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
    providerPacks,
  };
}

function projectRuntimeBindingAdvertisements(
  packs: readonly ProviderPack[],
  relations: readonly DeploymentRuntimeBindingRelation[],
): ProviderPack[] {
  return packs.map((pack) => {
    const proven = relations
      .filter((relation) => relation.consumerProviderPackRef === pack.id)
      .map((relation) => relation.bindingRef);
    const bindingRefs: TakoformBindingRef[] = [];
    for (const bindingRef of pack.provisioners.flatMap((provider) =>
      provider.offerings.flatMap((offering) => offering.bindingRefs),
    )) {
      if (
        proven.some((candidate) => sameBinding(candidate, bindingRef)) &&
        !bindingRefs.some((candidate) => sameBinding(candidate, bindingRef))
      ) {
        bindingRefs.push(structuredClone(bindingRef));
      }
    }
    return {
      ...pack,
      descriptor: {
        ...pack.descriptor,
        bindingRefs,
      },
    };
  });
}

function validateRuntimeBindingRelations(input: {
  readonly candidates: readonly CatalogCandidate[];
  readonly packsById: ReadonlyMap<string, ProviderPack>;
  readonly relations: readonly DeploymentRuntimeBindingRelation[];
}): void {
  const seen = new Set<string>();
  for (const relation of input.relations) {
    const key = [
      relation.targetOfferingId,
      relation.consumerProviderPackRef,
      relation.bindingRef.apiVersion,
      relation.bindingRef.name,
      relation.bindingRef.version,
      relation.bindingRef.schemaDigest,
    ].join("\0");
    if (seen.has(key)) {
      invalidRuntimeBindingRelation(relation.targetOfferingId, "ambiguous");
    }
    seen.add(key);

    const targets = input.candidates.filter(
      (candidate) => candidate.id === relation.targetOfferingId,
    );
    const target = targets.length === 1 ? targets[0] : undefined;
    const targetPack = target ? input.packsById.get(target.providerPackRef) : undefined;
    const consumerPack = input.packsById.get(relation.consumerProviderPackRef);
    const consumerDeclaresBinding = consumerPack?.provisioners.some((provider) =>
      provider.offerings.some((offering) =>
        offering.bindingRefs.some((bindingRef) => sameBinding(bindingRef, relation.bindingRef)),
      ),
    );
    if (targets.length > 1) {
      invalidRuntimeBindingRelation(relation.targetOfferingId, "ambiguous");
    }
    if (
      !target ||
      !consumerDeclaresBinding ||
      (sameBinding(relation.bindingRef, EDGE_OBJECTS_BINDING_REF) &&
        !providesObjectBucket(target)) ||
      !canMaterializeAcrossProviderPacks({
        bindingRef: relation.bindingRef,
        consumerPack,
        targetPack,
      })
    ) {
      invalidRuntimeBindingRelation(relation.targetOfferingId, "incomplete");
    }
  }

  for (const candidate of input.candidates) {
    if (providesObjectBucket(candidate)) {
      const consumers = input.relations.filter(
        (relation) =>
          relation.targetOfferingId === candidate.id &&
          sameBinding(relation.bindingRef, EDGE_OBJECTS_BINDING_REF),
      );
      if (consumers.length < 1) {
        invalidRuntimeBindingRelation(candidate.id, "missing");
      }
    }

    for (const bindingRef of candidate.bindingRefs.filter(requiresObjectBucket)) {
      const targets = input.relations.filter(
        (relation) =>
          relation.consumerProviderPackRef === candidate.providerPackRef &&
          sameBinding(relation.bindingRef, bindingRef),
      );
      if (targets.length < 1) {
        invalidRuntimeBindingRelation(candidate.id, "missing");
      }
    }
  }
}

function providesObjectBucket(candidate: CatalogCandidate): boolean {
  return (
    candidate.form.kind === "ObjectBucket" ||
    candidate.providedInterfaces.some((provided) => provided.name === "edge.objects")
  );
}

function requiresObjectBucket(bindingRef: TakoformBindingRef): boolean {
  return bindingRef.name === EDGE_OBJECTS_BINDING_REF.name;
}

function sameBinding(left: TakoformBindingRef, right: TakoformBindingRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}

function invalidRuntimeBindingRelation(
  offeringId: string,
  reason: "missing" | "incomplete" | "ambiguous",
): never {
  throw new TypeError(
    `deployment_catalog_invalid:${offeringId}:runtime_binding_relation_${reason}`,
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
