import type { PricePlan, ProviderInstallation, SupplyContract } from "./catalog-compiler.ts";
import {
  compileDeploymentComposition,
  createCatalogCandidate,
  createProvisioningProviderPack,
  type DeploymentComposition,
} from "./deployment-composition.ts";
import { type EdgeFormBundle, edgeProviderOffering } from "./edge-forms.ts";
import { HOSTED_EDGE_IDENTITY_CLASSES } from "./hosted-edge-supplies.ts";
import type { Provider, ProviderOffering } from "./provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "./provider-runtime-input-port.ts";
import {
  createSelfhostProvider,
  type SelfhostArtifacts,
  type SelfhostProviderOptions,
} from "./providers/selfhost.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";
import type { WorkerdRuntime } from "./workerd-runtime.ts";

/**
 * Composes what a machine standing on its own can still drain and execute.
 *
 * The whole released Edge Family goes through ONE provider and one
 * installation, for the same reason the Worker entry holds Cloudflare to one:
 * a Worker Version inherits the installation of every relation it binds, and
 * two installations on one machine would refuse the version that uses a bucket
 * and a KV namespace together.
 *
 * Stable Edge identities are the current local execution surface. Released
 * beta identities stay behind the same Provider Pack only so already-recorded
 * Deployments can be observed and deleted. `edgeForms: false` narrows both
 * surfaces to the retained ObjectBucket drain capability.
 */

const SUPPLY_CONTRACT_REF = "local.ownership-contract";
const PROVIDER_INSTALLATION_REF = "local.primary";

/** Forms the Host executes itself; they are never provider capabilities. */
const HOST_INTRINSIC = new Set([
  "WorkerBundle",
  "StaticAssetBundle",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
]);

export interface SelfhostCompositionOptions {
  /** Current stable Definitions; only the exact supported Edge subset executes locally. */
  readonly stableForms: readonly InstalledTakoformForm[];
  /** Retained beta catalog used only for observation/deletion of recorded Deployments. */
  readonly edge: EdgeFormBundle;
  readonly dataRoot: string;
  readonly runtime: WorkerdRuntime;
  readonly artifacts: SelfhostArtifacts;
  /** Whether the released Edge Family is offered. On by default upstream. */
  readonly edgeForms: boolean;
  readonly workerEndpointSuffix?: string;
  readonly suffixes?: readonly string[];
  /**
   * The one-shot seam for `requiredSensitiveVars`. Absent means this machine
   * has no sealed path for a secret, so the provider advertises no capability
   * and admission refuses the declaration before anything is provisioned.
   */
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
  /**
   * Loopback address of this machine's KV and SQL data planes. Absent means it
   * serves none, and a Worker Version that binds one is refused at apply.
   */
  readonly dataPlaneAddress?: string;
  readonly now: Date;
}

export interface SelfhostComposition extends DeploymentComposition {
  readonly provider: Provider;
}

export function createSelfhostComposition(
  options: SelfhostCompositionOptions,
): SelfhostComposition {
  const objectBucketOffering = edgeProviderOffering(options.edge.objectBucket.form, {
    id: "storage.object.standard",
    displayName: "Object bucket",
    regions: ["global"],
  });

  const identityOfferings: { offering: ProviderOffering; resourceClass: string }[] = [];
  const technicalOfferings: ProviderOffering[] = [objectBucketOffering];

  if (options.edgeForms) {
    for (const form of options.stableForms) {
      if (form.identity.formRef.apiVersion !== "edge.forms.takoform.com") continue;
      const kind = form.identity.formRef.kind;
      if (form.role === "identity") {
        if (!(kind in HOSTED_EDGE_IDENTITY_CLASSES)) continue;
        const resourceClass =
          HOSTED_EDGE_IDENTITY_CLASSES[kind as keyof typeof HOSTED_EDGE_IDENTITY_CLASSES];
        const offering = edgeProviderOffering(form, {
          id: `${resourceClass}.stable-v1.standard`,
          regions: ["global"],
        });
        identityOfferings.push({ offering, resourceClass });
        technicalOfferings.push(offering);
        continue;
      }
      if (HOST_INTRINSIC.has(kind) || !SELFHOST_EDGE_RELATION_KINDS.has(kind)) continue;
      technicalOfferings.push(
        edgeProviderOffering(form, { id: `selfhost.edge.stable-v1.${kind.toLowerCase()}` }),
      );
    }
    for (const form of options.edge.forms) {
      const kind = form.identity.formRef.kind;
      if (form.role === "identity") {
        if (!(kind in HOSTED_EDGE_IDENTITY_CLASSES)) continue;
        const resourceClass =
          HOSTED_EDGE_IDENTITY_CLASSES[kind as keyof typeof HOSTED_EDGE_IDENTITY_CLASSES];
        const offering = edgeProviderOffering(form, {
          id: `${resourceClass}.standard`,
          regions: ["global"],
        });
        technicalOfferings.push(offering);
        continue;
      }
      if (HOST_INTRINSIC.has(kind)) continue;
      // The relation-owned Forms are provider capabilities, not retail items.
      // Exactly one technical projection per exact Form, so the provider
      // driver can inherit it from the identity Deployment.
      technicalOfferings.push(
        edgeProviderOffering(form, { id: `selfhost.edge.${kind.toLowerCase()}` }),
      );
    }
  }

  const provider = createSelfhostProvider({
    offerings: technicalOfferings,
    dataRoot: options.dataRoot,
    runtime: options.runtime,
    artifacts: options.artifacts,
    ...(options.workerEndpointSuffix ? { workerEndpointSuffix: options.workerEndpointSuffix } : {}),
    ...(options.suffixes ? { suffixes: options.suffixes } : {}),
    ...(options.runtimeInputs ? { runtimeInputs: options.runtimeInputs } : {}),
    ...(options.dataPlaneAddress ? { dataPlaneAddress: options.dataPlaneAddress } : {}),
  } satisfies SelfhostProviderOptions);

  const supplyContract: SupplyContract = {
    id: SUPPLY_CONTRACT_REF,
    providerType: "selfhost",
    permittedResourceClasses: [
      // ObjectBucket is retained drain authority, not a current catalog item.
      "storage.object",
      ...new Set(identityOfferings.map((entry) => entry.resourceClass)),
    ].sort(),
    deliveryModes: ["managed-endpoint"],
    customerAccess: "operator-only",
    whiteLabelAllowed: false,
    endUserTermsRequired: false,
    regions: ["global"],
    validFrom: "2026-01-01T00:00:00.000Z",
    evidenceRef: "selfhost-ownership:local",
  };

  const providerInstallation: ProviderInstallation = {
    id: PROVIDER_INSTALLATION_REF,
    providerPackRef: provider.id,
    supplyContractRef: supplyContract.id,
    state: "active",
    regions: [{ id: "global", capacity: "available" }],
  };

  const pack = createProvisioningProviderPack({ provider, providerType: "selfhost" });

  const pricePlans: PricePlan[] = [];
  const candidates = identityOfferings.map(({ offering, resourceClass }) => {
    // Self-host sells to its own operator: creating a resource on a machine
    // they already pay for costs nothing at the catalog.
    const pricePlan: PricePlan = {
      id: `${offering.id}.price-v1`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 0 },
      meters: [],
    };
    pricePlans.push(pricePlan);
    return createCatalogCandidate(offering, {
      providerPackRef: pack.id,
      providerInstallationRef: providerInstallation.id,
      supplyContractRef: supplyContract.id,
      pricePlanRef: pricePlan.id,
      resourceClass,
      deliveryMode: "managed-endpoint",
      supportPolicyRef: "support:operator:standard",
      abusePolicyRef: "abuse:operator:standard",
      portability:
        resourceClass === "storage.object"
          ? {
              api: "portable",
              exportFormats: [],
              importFormats: [],
              migrationModes: [],
            }
          : {
              api: "portable",
              exportFormats: [],
              importFormats: [],
              migrationModes: [],
            },
      isolation: "dedicated-resource",
    });
  });

  const compiled = compileDeploymentComposition({
    candidates,
    providerPacks: [pack],
    providerInstallations: [providerInstallation],
    supplyContracts: [supplyContract],
    pricePlans,
    now: options.now,
  });

  // Only stable identities entered `candidates`; released beta Forms remain
  // technical drain capabilities and therefore cannot appear at `/v1` or
  // `/provision/v1`. This standalone composition exposes no current managed
  // object-storage sale; the retained ObjectBucket is recovery-only.
  return { ...compiled, provider };
}

const SELFHOST_EDGE_RELATION_KINDS = new Set([
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerCustomDomain",
  "WorkerEndpoint",
  "WorkerCronTrigger",
  "QueueConsumer",
]);
