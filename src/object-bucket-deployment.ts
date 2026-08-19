import type { PricePlan, ProviderInstallation, SupplyContract } from "./catalog-compiler.ts";
import {
  type CatalogPlacement,
  compileDeploymentComposition,
  createCatalogCandidate,
  createProvisioningProviderPack,
  type DeploymentComposition,
} from "./deployment-composition.ts";
import { objectBucketProviderOffering } from "./edge-forms.ts";
import type { Provider } from "./provider-port.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";

export type ObjectBucketPlacement = Omit<
  CatalogPlacement,
  | "providerPackRef"
  | "providerInstallationRef"
  | "supplyContractRef"
  | "pricePlanRef"
  | "resourceClass"
>;

/**
 * Compiles one operator-owned ObjectBucket supply into an executable runtime.
 *
 * The Form and Interface remain the exact released Takoform definitions. The
 * provider, installation, supply authority, price and availability are joined
 * only here, at the deployment boundary. The provider must already expose the
 * exact same technical offering; the compiler rejects drift before serving.
 */
export function compileObjectBucketDeployment(input: {
  readonly form: InstalledTakoformForm;
  readonly provider: Provider;
  readonly providerType: string;
  readonly offeringId: string;
  readonly displayName: string;
  readonly regions: readonly string[];
  readonly providerInstallation: ProviderInstallation;
  readonly supplyContract: SupplyContract;
  readonly pricePlan: PricePlan;
  readonly placement: ObjectBucketPlacement;
  readonly now: Date;
}): DeploymentComposition {
  return compileObjectBucketDeployments({ deployments: [input], now: input.now });
}

export type ObjectBucketDeploymentInput = Omit<
  Parameters<typeof compileObjectBucketDeployment>[0],
  "now"
>;

/** Compiles all ObjectBucket supplies together so duplicate or partial catalogs fail as one. */
export function compileObjectBucketDeployments(input: {
  readonly deployments: readonly ObjectBucketDeploymentInput[];
  readonly now: Date;
}): DeploymentComposition {
  const candidates = [];
  const packs = [];
  const providerInstallations = [];
  const supplyContracts = [];
  const pricePlans = [];
  for (const deployment of input.deployments) {
    const technical = objectBucketProviderOffering(deployment.form, {
      id: deployment.offeringId,
      displayName: deployment.displayName,
      regions: deployment.regions,
    });
    const pack = createProvisioningProviderPack({
      provider: deployment.provider,
      providerType: deployment.providerType,
    });
    candidates.push(
      createCatalogCandidate(technical, {
        providerPackRef: pack.id,
        providerInstallationRef: deployment.providerInstallation.id,
        supplyContractRef: deployment.supplyContract.id,
        pricePlanRef: deployment.pricePlan.id,
        resourceClass: "storage.object",
        ...deployment.placement,
      }),
    );
    packs.push(pack);
    providerInstallations.push(deployment.providerInstallation);
    supplyContracts.push(deployment.supplyContract);
    pricePlans.push(deployment.pricePlan);
  }
  return compileDeploymentComposition({
    candidates,
    providerPacks: packs,
    providerInstallations,
    supplyContracts,
    pricePlans,
    now: input.now,
  });
}
