import { objectBucketProviderOffering } from "./edge-forms.ts";
import {
  type HostedObjectBucketSupplies,
  parseHostedObjectBucketSupplies,
} from "./hosted-object-bucket-supplies.ts";
import { compileObjectBucketDeployments } from "./object-bucket-deployment.ts";
import type { Provider } from "./provider-port.ts";
import type { ArtifactBytes, CloudflareZone } from "./providers/cloudflare.ts";
import { CloudflareProvider } from "./providers/cloudflare.ts";
import { createWasabiProvider } from "./providers/wasabi.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";

export interface WorkerObjectBucketCompositionEnv {
  readonly TAKOSERVER_OBJECT_BUCKET_SUPPLIES?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_API_TOKEN?: string;
  readonly TAKOSERVER_ZONES?: string;
  readonly TAKOSERVER_WASABI_ACCESS_KEY_ID?: string;
  readonly TAKOSERVER_WASABI_SECRET_ACCESS_KEY?: string;
}

export interface WorkerObjectBucketComposition {
  readonly supplies: HostedObjectBucketSupplies | null;
  readonly providers: readonly Provider[];
  readonly providerPacks: ReturnType<typeof compileObjectBucketDeployments>["providerPacks"];
  readonly offerings: ReturnType<typeof compileObjectBucketDeployments>["offerings"];
}

/** Composes only supplies declared by the operator's versioned private contract. */
export function createWorkerObjectBucketComposition(input: {
  readonly env: WorkerObjectBucketCompositionEnv;
  readonly form: InstalledTakoformForm;
  readonly artifacts: ArtifactBytes;
  readonly now: Date;
}): WorkerObjectBucketComposition {
  const { env } = input;
  const supplies = env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES
    ? parseHostedObjectBucketSupplies(env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES)
    : null;
  const hasCloudflareCredential = Boolean(env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_API_TOKEN);
  const hasWasabiCredential = Boolean(
    env.TAKOSERVER_WASABI_ACCESS_KEY_ID || env.TAKOSERVER_WASABI_SECRET_ACCESS_KEY,
  );
  if (!supplies) {
    if (hasCloudflareCredential || hasWasabiCredential) {
      throw new TypeError("provider credentials require hosted ObjectBucket supplies");
    }
    return { supplies: null, providers: [], providerPacks: [], offerings: [] };
  }

  const deployments = supplies.supplies.map((supply) => {
    const technical = objectBucketProviderOffering(input.form, {
      id: supply.offeringId,
      displayName: supply.displayName,
      regions: supply.providerInstallation.regions.map((region) => region.id),
    });
    let provider: Provider;
    if (supply.provider.kind === "cloudflare") {
      const accountId = paired(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        "Cloudflare provisioning",
      );
      provider = new CloudflareProvider({
        accountId: accountId.left,
        offerings: [technical],
        authorize: () => `Bearer ${accountId.right}`,
        zones: parseZones(env.TAKOSERVER_ZONES),
        artifacts: input.artifacts,
      });
    } else {
      const credentials = paired(
        env.TAKOSERVER_WASABI_ACCESS_KEY_ID,
        env.TAKOSERVER_WASABI_SECRET_ACCESS_KEY,
        "Wasabi provisioning",
      );
      provider = createWasabiProvider({
        region: supply.provider.region,
        accessKeyId: credentials.left,
        secretAccessKey: credentials.right,
        offerings: [technical],
      });
    }
    return {
      form: input.form,
      provider,
      providerType: supply.provider.kind,
      offeringId: supply.offeringId,
      displayName: supply.displayName,
      regions: supply.providerInstallation.regions.map((region) => region.id),
      providerInstallation: supply.providerInstallation,
      supplyContract: supply.supplyContract,
      pricePlan: supply.pricePlan,
      placement: supply.placement,
    };
  });

  if (
    hasCloudflareCredential !==
      supplies.supplies.some((supply) => supply.provider.kind === "cloudflare") ||
    hasWasabiCredential !== supplies.supplies.some((supply) => supply.provider.kind === "wasabi")
  ) {
    throw new TypeError("provider credentials and hosted supplies do not match");
  }
  const compiled = compileObjectBucketDeployments({ deployments, now: input.now });
  return {
    supplies,
    providers: deployments.map((deployment) => deployment.provider),
    providerPacks: compiled.providerPacks,
    offerings: compiled.offerings,
  };
}

function paired(
  left: string | undefined,
  right: string | undefined,
  label: string,
): { readonly left: string; readonly right: string } {
  if (!left || !right) throw new TypeError(`${label} requires both credentials`);
  return { left, right };
}

function parseZones(raw: string | undefined): readonly CloudflareZone[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("invalid Cloudflare zones");
  }
  if (!Array.isArray(value)) throw new TypeError("invalid Cloudflare zones");
  return value as readonly CloudflareZone[];
}
