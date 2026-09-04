import { createCloudflareProviderSurface } from "./cloudflare-provider-surface.ts";
import { createCloudflareRuntimeBindingMaterializer } from "./cloudflare-runtime-binding-materializer.ts";
import {
  compileDeploymentComposition,
  createCatalogCandidate,
  createProvisioningProviderPack,
  type DeploymentRuntimeBindingRelation,
} from "./deployment-composition.ts";
import {
  HOSTED_EDGE_IDENTITY_CLASSES,
  type HostedEdgeSupplies,
  parseHostedEdgeSupplies,
} from "./hosted-edge-supplies.ts";
import {
  type HostedObjectBucketSupplies,
  parseHostedObjectBucketSupplies,
} from "./hosted-object-bucket-supplies.ts";
import type { ProviderPack } from "./provider-pack.ts";
import type { Provider } from "./provider-port.ts";
import type { CloudflareProviderExecutorRpc } from "./providers/cloudflare-provider-executor-rpc.ts";
import {
  CloudflareProviderProxy,
  createCloudflareProviderMeterProxySources,
} from "./providers/cloudflare-provider-proxy.ts";
import { EDGE_OBJECTS_BINDING_REF } from "./providers/cloudflare-runtime-bindings.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";

export interface WorkerProductionCompositionEnv {
  readonly TAKOSERVER_OBJECT_BUCKET_SUPPLIES?: string;
  readonly TAKOSERVER_EDGE_SUPPLIES?: string;
  /** Non-secret endpoint derivation fact shared with the private executor. */
  readonly TAKOSERVER_MANAGED_BASE_DOMAIN?: string;
  /** Typed, non-HTTP binding to the only isolate that holds parent credentials. */
  readonly CLOUDFLARE_PROVIDER_EXECUTOR?: CloudflareProviderExecutorRpc;
}

export interface WorkerProductionComposition {
  readonly objectBucketSupplies: HostedObjectBucketSupplies | null;
  readonly edgeSupplies: HostedEdgeSupplies | null;
  readonly providers: readonly Provider[];
  readonly providerPacks: readonly ProviderPack[];
  readonly offerings: ReturnType<typeof compileDeploymentComposition>["offerings"];
}

/**
 * Projects reviewed commercial supply into the public Host without importing
 * any credential-bearing provider implementation.
 *
 * Static catalog and runtime-binding facts remain local. Every Cloudflare
 * operation and provider meter read crosses the route-less typed service binding.
 * Wasabi supply is rejected wholesale because it has no private executor yet,
 * including dormant recovery offerings that would otherwise retain keys in
 * the public isolate.
 */
export function createWorkerProductionComposition(input: {
  readonly env: WorkerProductionCompositionEnv;
  readonly forms: readonly InstalledTakoformForm[];
  readonly retainedForms?: readonly InstalledTakoformForm[];
  /** Retained for call-site compatibility; never sent across provider RPC. */
  readonly artifacts?: unknown;
  /** Retained for call-site compatibility; plaintext stays in the Host. */
  readonly runtimeInputs?: unknown;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now: Date;
}): WorkerProductionComposition {
  const objectBucketSupplies = input.env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES
    ? parseHostedObjectBucketSupplies(input.env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES)
    : null;
  const edgeSupplies = input.env.TAKOSERVER_EDGE_SUPPLIES
    ? parseHostedEdgeSupplies(input.env.TAKOSERVER_EDGE_SUPPLIES)
    : null;
  const cloudflareObjects =
    objectBucketSupplies?.supplies.filter((supply) => supply.provider.kind === "cloudflare") ?? [];
  const wasabiObjects =
    objectBucketSupplies?.supplies.filter((supply) => supply.provider.kind === "wasabi") ?? [];

  if (wasabiObjects.length > 0) {
    throw new TypeError("Wasabi supplies require a separate route-less provider executor");
  }
  const hasCloudflareSupply = cloudflareObjects.length > 0 || edgeSupplies !== null;
  if (!hasCloudflareSupply) {
    if (
      input.env.CLOUDFLARE_PROVIDER_EXECUTOR !== undefined ||
      input.env.TAKOSERVER_MANAGED_BASE_DOMAIN !== undefined
    ) {
      throw new TypeError("Cloudflare provider executor requires reviewed Cloudflare supplies");
    }
    return {
      objectBucketSupplies,
      edgeSupplies,
      providers: [],
      providerPacks: [],
      offerings: [],
    };
  }
  const binding = input.env.CLOUDFLARE_PROVIDER_EXECUTOR;
  const managedBaseDomain = input.env.TAKOSERVER_MANAGED_BASE_DOMAIN;
  if (!binding || !managedBaseDomain) {
    throw new TypeError("reviewed Cloudflare supplies require the route-less provider executor");
  }

  const surface = createCloudflareProviderSurface({
    forms: input.forms,
    ...(input.retainedForms ? { retainedForms: input.retainedForms } : {}),
    objectBucketSupplies,
    edgeSupplies,
  });
  if (!surface) throw new TypeError("Cloudflare provider executor surface is unavailable");
  const provider = new CloudflareProviderProxy({
    offerings: surface.offerings,
    recoveryOfferings: surface.recoveryOfferings,
    managedBaseDomain,
    runtimeInputs: surface.runtimeInputs,
    binding,
  });

  const authorities = [
    ...cloudflareObjects.map((supply) => ({
      installation: supply.providerInstallation,
      contract: supply.supplyContract,
    })),
    ...(edgeSupplies
      ? [
          {
            installation: edgeSupplies.providerInstallation,
            contract: edgeSupplies.supplyContract,
          },
        ]
      : []),
  ];
  const installation = uniqueExact(
    authorities.map((authority) => authority.installation),
    "Cloudflare provider installation",
  );
  const contract = uniqueExact(
    authorities.map((authority) => authority.contract),
    "Cloudflare supply contract",
  );
  if (
    installation.id !== surface.providerInstallationId ||
    installation.providerPackRef !== "cloudflare" ||
    installation.supplyContractRef !== contract.id ||
    contract.providerType !== "cloudflare"
  ) {
    throw new TypeError("Cloudflare supplies do not share one provider authority");
  }

  const offeringsById = new Map(surface.offerings.map((offering) => [offering.id, offering]));
  const candidates = [];
  const prices = [];
  const runtimeBindingRelations: DeploymentRuntimeBindingRelation[] = [];
  // ObjectBucket is current only when this installation also realizes the
  // Worker consumer. Without an edge supply it remains recovery-only.
  if (edgeSupplies) {
    for (const supply of cloudflareObjects) {
      const offering = offeringsById.get(supply.offeringId);
      if (!offering) throw new TypeError("Cloudflare ObjectBucket offering is unavailable");
      candidates.push(
        createCatalogCandidate(offering, {
          providerPackRef: "cloudflare",
          providerInstallationRef: installation.id,
          supplyContractRef: contract.id,
          pricePlanRef: supply.pricePlan.id,
          resourceClass: "storage.object",
          ...supply.placement,
        }),
      );
      prices.push(supply.pricePlan);
      runtimeBindingRelations.push({
        targetOfferingId: offering.id,
        consumerProviderPackRef: "cloudflare",
        bindingRef: EDGE_OBJECTS_BINDING_REF,
      });
    }
    for (const supply of edgeSupplies.offerings) {
      const offering = offeringsById.get(supply.offeringId);
      if (!offering) throw new TypeError("Cloudflare edge offering is unavailable");
      candidates.push(
        createCatalogCandidate(offering, {
          providerPackRef: "cloudflare",
          providerInstallationRef: installation.id,
          supplyContractRef: contract.id,
          pricePlanRef: supply.pricePlan.id,
          resourceClass: HOSTED_EDGE_IDENTITY_CLASSES[supply.formKind],
          ...supply.placement,
        }),
      );
      prices.push(supply.pricePlan);
    }
  }

  const pack = createProvisioningProviderPack({
    provider,
    providerType: "cloudflare",
    capabilities: {
      meterSources: createCloudflareProviderMeterProxySources({
        offerings: surface.offerings,
        binding,
      }),
      runtimeBindingMaterializer: createCloudflareRuntimeBindingMaterializer("cloudflare"),
    },
  });
  const compiled = compileDeploymentComposition({
    candidates,
    providerPacks: [pack],
    providerInstallations: [installation],
    supplyContracts: [contract],
    pricePlans: uniqueById(prices, "price plan"),
    runtimeBindingRelations,
    now: input.now,
  });
  return {
    objectBucketSupplies,
    edgeSupplies,
    providers: [provider],
    providerPacks: compiled.providerPacks,
    offerings: compiled.offerings.filter(
      (offering) => offering.form.apiVersion === "edge.forms.takoform.com",
    ),
  };
}

function uniqueExact<T>(values: readonly T[], label: string): T {
  const first = values[0];
  if (
    first === undefined ||
    values.some((value) => JSON.stringify(value) !== JSON.stringify(first))
  ) {
    throw new TypeError(`${label} is ambiguous`);
  }
  return structuredClone(first);
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[], label: string): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const previous = result.get(value.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) {
      throw new TypeError(`${label} identity is ambiguous: ${value.id}`);
    }
    result.set(value.id, structuredClone(value));
  }
  return [...result.values()];
}
