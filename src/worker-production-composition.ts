import type { ProviderInstallation, SupplyContract } from "./catalog-compiler.ts";
import {
  compileDeploymentComposition,
  createCatalogCandidate,
  createProvisioningProviderPack,
} from "./deployment-composition.ts";
import { edgeProviderOffering, objectBucketProviderOffering } from "./edge-forms.ts";
import {
  HOSTED_EDGE_IDENTITY_CLASSES,
  type HostedEdgeSupplies,
  parseHostedEdgeSupplies,
} from "./hosted-edge-supplies.ts";
import {
  type HostedObjectBucketSupplies,
  parseHostedObjectBucketSupplies,
} from "./hosted-object-bucket-supplies.ts";
import type { MeterSource, ProviderPack } from "./provider-pack.ts";
import type { Provider, ProviderOffering } from "./provider-port.ts";
import type { ArtifactBytes, CloudflareZone } from "./providers/cloudflare.ts";
import { CloudflareProvider } from "./providers/cloudflare.ts";
import { createCloudflareR2MeterSource } from "./providers/cloudflare-r2-meter.ts";
import { createWasabiProvider } from "./providers/wasabi.ts";
import { createWasabiBucketMeterSource } from "./providers/wasabi-meter.ts";
import { createS3AttachmentFactory } from "./s3-attachment-factory.ts";
import type { S3CredentialIssuer } from "./s3-port.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";

const HOST_INTRINSIC = new Set([
  "WorkerBundle",
  "StaticAssetBundle",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
]);

export interface WorkerProductionCompositionEnv {
  readonly TAKOSERVER_OBJECT_BUCKET_SUPPLIES?: string;
  readonly TAKOSERVER_EDGE_SUPPLIES?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  readonly CLOUDFLARE_API_TOKEN?: string;
  readonly TAKOSERVER_ZONES?: string;
  readonly TAKOSERVER_WORKER_ENDPOINT_SUFFIX?: string;
  readonly TAKOSERVER_WASABI_ACCESS_KEY_ID?: string;
  readonly TAKOSERVER_WASABI_SECRET_ACCESS_KEY?: string;
}

export interface WorkerProductionComposition {
  readonly objectBucketSupplies: HostedObjectBucketSupplies | null;
  readonly edgeSupplies: HostedEdgeSupplies | null;
  readonly providers: readonly Provider[];
  readonly providerPacks: readonly ProviderPack[];
  readonly offerings: ReturnType<typeof compileDeploymentComposition>["offerings"];
}

/**
 * Composes reviewed commercial supplies into one provider-neutral runtime.
 *
 * Cloudflare is one Provider Pack and one installation even when it supplies
 * several identity Forms. That invariant is what lets exact logical relations
 * become native bindings without guessing that two differently named accounts
 * are actually the same account.
 */
export function createWorkerProductionComposition(input: {
  readonly env: WorkerProductionCompositionEnv;
  readonly forms: readonly InstalledTakoformForm[];
  readonly artifacts: ArtifactBytes;
  readonly s3CredentialIssuer?: S3CredentialIssuer;
  readonly now: Date;
}): WorkerProductionComposition {
  const { env } = input;
  const objectBucketSupplies = env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES
    ? parseHostedObjectBucketSupplies(env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES)
    : null;
  const edgeSupplies = env.TAKOSERVER_EDGE_SUPPLIES
    ? parseHostedEdgeSupplies(env.TAKOSERVER_EDGE_SUPPLIES)
    : null;
  const cloudflareObjects =
    objectBucketSupplies?.supplies.filter((supply) => supply.provider.kind === "cloudflare") ?? [];
  const wasabiObjects =
    objectBucketSupplies?.supplies.filter((supply) => supply.provider.kind === "wasabi") ?? [];
  const hasCloudflareCredential = Boolean(env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_API_TOKEN);
  const hasWasabiCredential = Boolean(
    env.TAKOSERVER_WASABI_ACCESS_KEY_ID || env.TAKOSERVER_WASABI_SECRET_ACCESS_KEY,
  );
  if (!objectBucketSupplies && !edgeSupplies) {
    if (hasCloudflareCredential || hasWasabiCredential) {
      throw new TypeError("provider credentials require reviewed hosted supplies");
    }
    return {
      objectBucketSupplies: null,
      edgeSupplies: null,
      providers: [],
      providerPacks: [],
      offerings: [],
    };
  }
  if (cloudflareObjects.length > 0 && !input.s3CredentialIssuer) {
    throw new TypeError("hosted ObjectBucket supplies require an S3 credential issuer");
  }
  if (wasabiObjects.length > 0 && !input.s3CredentialIssuer) {
    throw new TypeError("hosted ObjectBucket supplies require an S3 credential issuer");
  }

  const forms = new Map(input.forms.map((form) => [form.identity.formRef.kind, form]));
  const objectBucket = requiredForm(forms, "ObjectBucket");
  const providers: Provider[] = [];
  const packs: ProviderPack[] = [];
  const candidates = [];
  const installations: ProviderInstallation[] = [];
  const contracts: SupplyContract[] = [];
  const prices = [];

  if (cloudflareObjects.length > 0 || edgeSupplies) {
    const credentials = paired(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      "Cloudflare provisioning",
    );
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
      installation.providerPackRef !== "cloudflare" ||
      installation.supplyContractRef !== contract.id
    ) {
      throw new TypeError("Cloudflare supplies do not share one provider authority");
    }

    const technical: ProviderOffering[] = [];
    for (const supply of cloudflareObjects) {
      const offering = objectBucketProviderOffering(objectBucket, {
        id: supply.offeringId,
        displayName: supply.displayName,
        regions: supply.providerInstallation.regions.map((region) => region.id),
      });
      technical.push(offering);
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
    }
    for (const supply of edgeSupplies?.offerings ?? []) {
      const form = requiredForm(forms, supply.formKind);
      if (form.role !== "identity") {
        throw new TypeError("hosted edge supply must name an identity Form");
      }
      const offering = edgeProviderOffering(form, {
        id: supply.offeringId,
        displayName: supply.displayName,
        regions: installation.regions.map((region) => region.id),
      });
      technical.push(offering);
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
    // The relation-owned Forms are provider capabilities, not retail items.
    // There is exactly one technical projection for each exact Form so the
    // provider driver can inherit it from the identity Deployment.
    for (const form of input.forms) {
      if (form.role === "identity" || HOST_INTRINSIC.has(form.identity.formRef.kind)) continue;
      technical.push(
        edgeProviderOffering(form, {
          id: `cloudflare.edge.${form.identity.formRef.kind.toLowerCase()}`,
        }),
      );
    }
    uniqueIds(
      technical.map((offering) => offering.id),
      "Cloudflare technical offering",
    );
    const provider = new CloudflareProvider({
      accountId: credentials.left,
      offerings: technical,
      authorize: () => `Bearer ${credentials.right}`,
      zones: parseZones(env.TAKOSERVER_ZONES),
      ...(env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX
        ? { workerEndpointSuffix: env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX }
        : {}),
      artifacts: input.artifacts,
    });
    const meterSources: MeterSource[] = [];
    if (cloudflareObjects.length > 0) {
      meterSources.push(
        createCloudflareR2MeterSource({
          accountId: credentials.left,
          apiToken: credentials.right,
        }),
      );
    }
    const attachmentFactories =
      cloudflareObjects.length > 0 && input.s3CredentialIssuer
        ? [
            createS3AttachmentFactory({
              providerPackRef: "cloudflare",
              interfaceRef: requiredInterface(
                technical.find((offering) => offering.form.kind === "ObjectBucket"),
              ),
              issuer: input.s3CredentialIssuer,
            }),
          ]
        : [];
    providers.push(provider);
    packs.push(
      createProvisioningProviderPack({
        provider,
        providerType: "cloudflare",
        capabilities: { meterSources, attachmentFactories },
      }),
    );
    installations.push(installation);
    contracts.push(contract);
  } else if (hasCloudflareCredential) {
    throw new TypeError("Cloudflare credentials require a Cloudflare supply");
  }

  for (const supply of wasabiObjects) {
    if (supply.provider.kind !== "wasabi") {
      throw new TypeError("Wasabi supply provider identity drifted");
    }
    const credentials = paired(
      env.TAKOSERVER_WASABI_ACCESS_KEY_ID,
      env.TAKOSERVER_WASABI_SECRET_ACCESS_KEY,
      "Wasabi provisioning",
    );
    const technical = objectBucketProviderOffering(objectBucket, {
      id: supply.offeringId,
      displayName: supply.displayName,
      regions: supply.providerInstallation.regions.map((region) => region.id),
    });
    const provider = createWasabiProvider({
      region: supply.provider.region,
      accessKeyId: credentials.left,
      secretAccessKey: credentials.right,
      offerings: [technical],
    });
    const interfaceRef = requiredInterface(technical);
    providers.push(provider);
    packs.push(
      createProvisioningProviderPack({
        provider,
        providerType: "wasabi",
        capabilities: {
          meterSources: [
            createWasabiBucketMeterSource({
              region: supply.provider.region,
              accessKeyId: credentials.left,
              secretAccessKey: credentials.right,
            }),
          ],
          attachmentFactories: [
            createS3AttachmentFactory({
              providerPackRef: "wasabi",
              interfaceRef,
              issuer: input.s3CredentialIssuer as S3CredentialIssuer,
            }),
          ],
        },
      }),
    );
    candidates.push(
      createCatalogCandidate(technical, {
        providerPackRef: "wasabi",
        providerInstallationRef: supply.providerInstallation.id,
        supplyContractRef: supply.supplyContract.id,
        pricePlanRef: supply.pricePlan.id,
        resourceClass: "storage.object",
        ...supply.placement,
      }),
    );
    installations.push(supply.providerInstallation);
    contracts.push(supply.supplyContract);
    prices.push(supply.pricePlan);
  }
  if (hasWasabiCredential !== wasabiObjects.length > 0) {
    throw new TypeError("Wasabi credentials and hosted supplies do not match");
  }

  const compiled = compileDeploymentComposition({
    candidates,
    providerPacks: packs,
    providerInstallations: uniqueById(installations, "provider installation"),
    supplyContracts: uniqueById(contracts, "supply contract"),
    pricePlans: uniqueById(prices, "price plan"),
    now: input.now,
  });
  return {
    objectBucketSupplies,
    edgeSupplies,
    providers,
    providerPacks: compiled.providerPacks,
    offerings: compiled.offerings,
  };
}

function requiredForm(
  forms: ReadonlyMap<string, InstalledTakoformForm>,
  kind: string,
): InstalledTakoformForm {
  const form = forms.get(kind);
  if (!form || form.identity.formRef.apiVersion !== "edge.forms.takoform.com/v1beta1") {
    throw new TypeError(`released Takoform Form missing: ${kind}`);
  }
  return form;
}

function requiredInterface(offering: ProviderOffering | undefined) {
  const interfaceRef = offering?.providedInterfaces[0];
  if (!interfaceRef) throw new TypeError("ObjectBucket S3 interface is not installed");
  return interfaceRef;
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

function uniqueIds(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} is duplicated`);
}
