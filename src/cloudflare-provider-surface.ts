import { edgeProviderOffering, objectBucketProviderOffering } from "./edge-forms.ts";
import type { HostedEdgeSupplies } from "./hosted-edge-supplies.ts";
import type { HostedObjectBucketSupplies } from "./hosted-object-bucket-supplies.ts";
import type { ProviderOffering } from "./provider-port.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";

export interface CloudflareProviderSurface {
  readonly providerInstallationId: string;
  readonly offerings: readonly ProviderOffering[];
  readonly recoveryOfferings: readonly ProviderOffering[];
  readonly runtimeInputs: boolean;
}

const HOST_INTRINSIC_FORM_KINDS = new Set([
  "WorkerBundle",
  "StaticAssetBundle",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
]);

const CLOUDFLARE_RELATION_FORM_KINDS = new Set([
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerCustomDomain",
  "WorkerEndpoint",
  "WorkerCronTrigger",
  "QueueConsumer",
]);

/**
 * Credential-free technical capability projection shared by both isolates.
 * Commercial price/placement stays in the public Catalog Compiler.
 */
export function createCloudflareProviderSurface(input: {
  readonly forms: readonly InstalledTakoformForm[];
  readonly retainedForms?: readonly InstalledTakoformForm[];
  readonly objectBucketSupplies: HostedObjectBucketSupplies | null;
  readonly edgeSupplies: HostedEdgeSupplies | null;
}): CloudflareProviderSurface | null {
  const cloudflareObjects =
    input.objectBucketSupplies?.supplies.filter(
      (supply) => supply.provider.kind === "cloudflare",
    ) ?? [];
  if (cloudflareObjects.length === 0 && !input.edgeSupplies) return null;

  const authorities = [
    ...cloudflareObjects.map((supply) => ({
      installation: supply.providerInstallation,
      contract: supply.supplyContract,
    })),
    ...(input.edgeSupplies
      ? [
          {
            installation: input.edgeSupplies.providerInstallation,
            contract: input.edgeSupplies.supplyContract,
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
    installation.supplyContractRef !== contract.id ||
    contract.providerType !== "cloudflare"
  ) {
    throw new TypeError("Cloudflare supplies do not share one provider authority");
  }

  const forms = edgeFormMap(input.forms);
  const retained = edgeFormMap(input.retainedForms ?? []);
  const offerings: ProviderOffering[] = [];
  const recoveryOfferings: ProviderOffering[] = [];
  const retainedObjectBucket = retained.get("ObjectBucket");
  for (const supply of cloudflareObjects) {
    if (input.edgeSupplies) {
      const objectBucket = requiredForm(forms, "ObjectBucket", "edge.forms.takoform.com");
      offerings.push(
        objectBucketProviderOffering(objectBucket, {
          id: supply.offeringId,
          displayName: supply.displayName,
          regions: installation.regions.map((region) => region.id),
        }),
      );
    }
    if (retainedObjectBucket) {
      recoveryOfferings.push(
        edgeProviderOffering(retainedObjectBucket, {
          id: supply.offeringId,
          displayName: supply.displayName,
          regions: installation.regions.map((region) => region.id),
        }),
      );
    }
  }

  for (const supply of input.edgeSupplies?.offerings ?? []) {
    const form = requiredForm(forms, supply.formKind);
    if (form.role !== "identity") {
      throw new TypeError("hosted edge supply must name an identity Form");
    }
    offerings.push(
      edgeProviderOffering(form, {
        id: supply.offeringId,
        displayName: supply.displayName,
        regions: installation.regions.map((region) => region.id),
      }),
    );
    const retainedForm = retained.get(supply.formKind);
    if (retainedForm) {
      recoveryOfferings.push(
        edgeProviderOffering(retainedForm, {
          id: supply.offeringId,
          displayName: supply.displayName,
          regions: installation.regions.map((region) => region.id),
        }),
      );
    }
  }

  if (input.edgeSupplies) {
    for (const form of forms.values()) {
      if (
        form.role === "identity" ||
        HOST_INTRINSIC_FORM_KINDS.has(form.identity.formRef.kind) ||
        !CLOUDFLARE_RELATION_FORM_KINDS.has(form.identity.formRef.kind)
      ) {
        continue;
      }
      offerings.push(
        edgeProviderOffering(form, {
          id: `cloudflare.edge.stable-v1.${form.identity.formRef.kind.toLowerCase()}`,
        }),
      );
    }
    for (const form of retained.values()) {
      const kind = form.identity.formRef.kind;
      if (HOST_INTRINSIC_FORM_KINDS.has(kind) || kind === "ObjectBucket") continue;
      // Identity offerings above retain the exact commercial offering id.
      // This second pass is only for relation Forms that inherit placement;
      // adding identities again would create two recovery capabilities with
      // the same authority id.
      if (!CLOUDFLARE_RELATION_FORM_KINDS.has(kind)) continue;
      recoveryOfferings.push(
        edgeProviderOffering(form, {
          id: `cloudflare.edge.${kind.toLowerCase()}`,
        }),
      );
    }
  }

  uniqueIds(offerings, "Cloudflare technical offering");
  uniqueIds(recoveryOfferings, "Cloudflare recovery offering");
  return {
    providerInstallationId: installation.id,
    offerings,
    recoveryOfferings,
    runtimeInputs: input.edgeSupplies !== null,
  };
}

function requiredForm(
  forms: ReadonlyMap<string, InstalledTakoformForm>,
  kind: string,
  apiVersion?: string,
): InstalledTakoformForm {
  const form = forms.get(kind);
  if (!form || (apiVersion !== undefined && form.identity.formRef.apiVersion !== apiVersion)) {
    throw new TypeError(`mapped Takoform Edge Form missing: ${kind}`);
  }
  return form;
}

function edgeFormMap(
  forms: readonly InstalledTakoformForm[],
): ReadonlyMap<string, InstalledTakoformForm> {
  const result = new Map<string, InstalledTakoformForm>();
  for (const form of forms) {
    if (
      form.identity.formRef.apiVersion !== "edge.forms.takoform.com" &&
      form.identity.formRef.apiVersion !== "edge.forms.takoform.com/v1beta1"
    ) {
      continue;
    }
    if (result.has(form.identity.formRef.kind)) {
      throw new TypeError(`mapped Takoform Edge Form is ambiguous: ${form.identity.formRef.kind}`);
    }
    result.set(form.identity.formRef.kind, form);
  }
  return result;
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

function uniqueIds(offerings: readonly ProviderOffering[], label: string): void {
  const ids = offerings.map((offering) => offering.id);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} ids must be unique`);
}
