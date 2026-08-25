import {
  createProvisioningProviderPack,
  type DeploymentComposition,
} from "./deployment-composition.ts";
import { type EdgeFormBundle, objectBucketProviderOffering } from "./edge-forms.ts";
import type { ProviderPack } from "./provider-pack.ts";
import type { Provider } from "./provider-port.ts";
import { CloudflareProvider, type CloudflareProviderOptions } from "./providers/cloudflare.ts";
import type { SelfhostArtifacts } from "./providers/selfhost.ts";
import { createSelfhostComposition } from "./selfhost-composition.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";
import type { WorkerdRuntime } from "./workerd-runtime.ts";

export const RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN = "cloudflare-object-bucket-drain" as const;

export type StandaloneProviderMode =
  | "stable-selfhost"
  | typeof RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN;

export interface StandaloneProviderEnvironment {
  readonly retiredProviderMode?: string | undefined;
  readonly cloudflareAccountId?: string | undefined;
  /** Whether an env token or rotatable token-file path was configured. */
  readonly cloudflareCredentialConfigured?: boolean | undefined;
  /** Whether the private provisioner endpoint has its shared credential. */
  readonly provisionerCredentialConfigured?: boolean | undefined;
  /** DNS authority belongs to the stable production Worker entry, not this lane. */
  readonly cloudflareZones?: string | undefined;
  /** Retired implicit provider switch; every value is now refused. */
  readonly legacyEdgeForms?: string | undefined;
  readonly workerEndpointSuffix?: string | undefined;
  readonly suffixes?: string | undefined;
  readonly workerdPort?: string | undefined;
}

/**
 * Selects the ordinary Bun execution provider without inferring authority from
 * generic account/storage credentials.
 *
 * D1, R2, and standard-service adapters may use a Cloudflare account while the
 * Provider3 execution pack remains self-hosted. The old Cloudflare
 * ObjectBucket provider is available only as an explicitly named, closed
 * recovery mode for observing and deleting already-recorded beta Deployments.
 */
export function resolveStandaloneProviderMode(
  environment: StandaloneProviderEnvironment,
): StandaloneProviderMode {
  if (environment.legacyEdgeForms !== undefined) {
    throw new TypeError(
      "TAKOSERVER_EDGE_FORMS is retired; ordinary Bun always enables the stable self-host provider",
    );
  }
  if (environment.cloudflareZones !== undefined) {
    throw new TypeError(
      "TAKOSERVER_ZONES is not accepted by Bun; production Cloudflare zones belong to the Worker entry",
    );
  }

  const requested = environment.retiredProviderMode;
  if (requested === undefined) {
    return "stable-selfhost";
  }
  if (requested !== RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN) {
    throw new TypeError(
      "TAKOSERVER_RETIRED_PROVIDER_MODE must be cloudflare-object-bucket-drain when set",
    );
  }
  if (!environment.cloudflareAccountId?.trim()) {
    throw new TypeError(
      "CLOUDFLARE_ACCOUNT_ID is required for the retired Cloudflare ObjectBucket drain",
    );
  }
  if (!environment.cloudflareCredentialConfigured) {
    throw new TypeError(
      "CLOUDFLARE_API_TOKEN or TAKOSERVER_CF_TOKEN_FILE is required for the retired Cloudflare ObjectBucket drain",
    );
  }
  if (!environment.provisionerCredentialConfigured) {
    throw new TypeError(
      "TAKOSERVER_PROVISIONER_TOKEN is required for the retired Cloudflare ObjectBucket drain",
    );
  }
  if (
    environment.workerEndpointSuffix !== undefined ||
    environment.suffixes !== undefined ||
    environment.workerdPort !== undefined
  ) {
    throw new TypeError(
      "the retired Cloudflare ObjectBucket drain cannot be mixed with stable self-host provider settings",
    );
  }
  return RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN;
}

export interface StandaloneProviderComposition {
  readonly mode: StandaloneProviderMode;
  readonly providers: readonly Provider[];
  readonly providerPacks: readonly ProviderPack[];
  readonly offerings: DeploymentComposition["offerings"];
}

export function createStandaloneProviderComposition(input: {
  readonly mode: StandaloneProviderMode;
  readonly stableForms: readonly InstalledTakoformForm[];
  readonly edge: EdgeFormBundle;
  readonly dataRoot: string;
  readonly runtime: WorkerdRuntime;
  readonly artifacts: SelfhostArtifacts;
  readonly workerEndpointSuffix?: string;
  readonly suffixes?: readonly string[];
  readonly now: Date;
  readonly retiredCloudflare?: Omit<CloudflareProviderOptions, "offerings">;
}): StandaloneProviderComposition {
  if (input.mode === "stable-selfhost") {
    if (input.retiredCloudflare) {
      throw new TypeError(
        "stable self-host provider cannot be mixed with retired Cloudflare drain configuration",
      );
    }
    const composition = createSelfhostComposition({
      stableForms: input.stableForms,
      edge: input.edge,
      dataRoot: input.dataRoot,
      runtime: input.runtime,
      artifacts: input.artifacts,
      edgeForms: true,
      ...(input.workerEndpointSuffix ? { workerEndpointSuffix: input.workerEndpointSuffix } : {}),
      ...(input.suffixes ? { suffixes: input.suffixes } : {}),
      now: input.now,
    });
    return {
      mode: input.mode,
      providers: [composition.provider],
      providerPacks: composition.providerPacks,
      offerings: composition.offerings,
    };
  }

  if (!input.retiredCloudflare) {
    throw new TypeError("retired Cloudflare ObjectBucket drain configuration is required");
  }
  if (input.workerEndpointSuffix !== undefined || input.suffixes !== undefined) {
    throw new TypeError(
      "retired Cloudflare ObjectBucket drain cannot be mixed with stable self-host provider settings",
    );
  }
  const objectBucketOffering = objectBucketProviderOffering(input.edge.objectBucket.form, {
    id: "storage.object.standard",
    displayName: "Object bucket",
    regions: ["global"],
  });
  const provider = new CloudflareProvider({
    ...input.retiredCloudflare,
    offerings: [objectBucketOffering],
  });
  const pack = createProvisioningProviderPack({ provider, providerType: "cloudflare" });

  // Reconstruct only the historical technical Provider Pack. A commercial
  // candidate is deliberately never created: doing so, even to discard it,
  // would give a recovery adapter a sale-authority shape it does not own.
  return {
    mode: input.mode,
    providers: [provider],
    providerPacks: [pack],
    offerings: [],
  };
}
