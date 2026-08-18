import type { AttachmentFactory } from "./attachments.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import type { Provider } from "./provider-port.ts";
import type { ResourceDeployment } from "./resource-deployments.ts";

export type ResourceProvisioner = Provider;

export interface ProviderPackDescriptor {
  readonly id: string;
  readonly providerType: string;
  readonly forms: readonly TakoformV1Alpha3FormRef[];
  readonly providedInterfaces: readonly TakoformInterfaceRef[];
  readonly bindingRefs: readonly TakoformBindingRef[];
  readonly meterSources: readonly string[];
}

export interface TransferEndpoint {
  readonly id: string;
  readonly exportFormats: readonly string[];
  readonly importFormats: readonly string[];
  readonly migrationModes: readonly ("offline" | "online")[];
  export(input: {
    /** Stable across retries of one Migration phase. */
    readonly operationId: string;
    readonly tenantId: string;
    readonly source: ResourceDeployment;
    readonly format: string;
  }): Promise<{ readonly transferRef: string }>;
  import(input: {
    /** Stable across retries of one Migration phase. */
    readonly operationId: string;
    readonly tenantId: string;
    readonly target: ResourceDeployment;
    readonly transferRef: string;
    readonly format: string;
  }): Promise<void>;
  verify(input: {
    /** Stable across retries of one Migration phase. */
    readonly operationId: string;
    readonly tenantId: string;
    readonly source: ResourceDeployment;
    readonly target: ResourceDeployment;
    readonly requirements: {
      readonly schema: boolean;
      readonly rowCounts: boolean;
      readonly checksums: boolean;
    };
  }): Promise<{
    readonly schema: boolean;
    readonly rowCounts: boolean;
    readonly checksums: boolean;
    readonly evidenceDigest: `sha256:${string}`;
  }>;
}

export interface CredentialIssuer {
  readonly id: string;
  readonly interfaceRefs: readonly TakoformInterfaceRef[];
  issue(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly deployment: ResourceDeployment;
    readonly interfaceRef: TakoformInterfaceRef;
    readonly permissions: readonly string[];
  }): Promise<{ readonly grantRef: string; readonly expiresAt: string }>;
}

export interface MeterSource {
  readonly id: string;
  readonly meters: readonly string[];
  read(input: {
    readonly tenantId: string;
    readonly deployment: ResourceDeployment;
    readonly from: string;
    readonly until: string;
  }): Promise<readonly { readonly meter: string; readonly quantity: number }[]>;
}

export interface CostEstimator {
  readonly id: string;
  readonly meters: readonly string[];
  estimate(input: {
    readonly providerInstallationRef: string;
    readonly region: string;
    readonly usage: readonly { readonly meter: string; readonly quantity: number }[];
  }): Promise<{ readonly currency: "USD"; readonly amountMinor: number }>;
}

export interface ProviderPackDefinition {
  readonly id: string;
  readonly providerType: string;
  readonly provisioners: readonly ResourceProvisioner[];
  readonly attachmentFactories: readonly AttachmentFactory[];
  readonly transferEndpoints: readonly TransferEndpoint[];
  readonly credentialIssuers: readonly CredentialIssuer[];
  readonly meterSources: readonly MeterSource[];
  readonly costEstimators: readonly CostEstimator[];
}

export interface ProviderPack extends ProviderPackDefinition {
  readonly descriptor: ProviderPackDescriptor;
  provisionerForOffering(offeringId: string): ResourceProvisioner;
}

export function createProviderPack(definition: ProviderPackDefinition): ProviderPack {
  validateId(definition.id);
  validateId(definition.providerType);
  uniqueIds(definition.provisioners, "ResourceProvisioner");
  uniqueIds(definition.attachmentFactories, "AttachmentFactory");
  uniqueIds(definition.transferEndpoints, "TransferEndpoint");
  uniqueIds(definition.credentialIssuers, "CredentialIssuer");
  uniqueIds(definition.meterSources, "MeterSource");
  uniqueIds(definition.costEstimators, "CostEstimator");
  if (definition.attachmentFactories.some((factory) => factory.providerPackRef !== definition.id)) {
    throw new TypeError("AttachmentFactory belongs to another Provider Pack");
  }

  const provisioners = new Map<string, ResourceProvisioner>();
  for (const provisioner of definition.provisioners) {
    for (const offering of provisioner.offerings) {
      if (provisioners.has(offering.id)) {
        throw new TypeError(`ambiguous Provider Pack offering: ${offering.id}`);
      }
      provisioners.set(offering.id, provisioner);
    }
  }

  const offerings = definition.provisioners.flatMap((provisioner) => provisioner.offerings);
  const descriptor: ProviderPackDescriptor = {
    id: definition.id,
    providerType: definition.providerType,
    forms: uniqueValues(offerings.map((offering) => offering.form)),
    providedInterfaces: uniqueValues(offerings.flatMap((offering) => offering.providedInterfaces)),
    bindingRefs: uniqueValues(offerings.flatMap((offering) => offering.bindingRefs)),
    meterSources: [...new Set(definition.meterSources.flatMap((source) => source.meters))].sort(),
  };

  return {
    ...definition,
    descriptor,
    provisionerForOffering(offeringId): ResourceProvisioner {
      const provisioner = provisioners.get(offeringId);
      if (!provisioner) throw new TypeError(`Provider Pack offering not found: ${offeringId}`);
      return provisioner;
    },
  };
}

function uniqueIds(values: readonly { readonly id: string }[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    validateId(value.id);
    if (seen.has(value.id)) throw new TypeError(`duplicate ${kind} id: ${value.id}`);
    seen.add(value.id);
  }
}

function validateId(value: string): void {
  if (value.length < 1 || value.length > 255 || !/^[a-z0-9][a-z0-9._:-]*$/u.test(value)) {
    throw new TypeError("invalid Provider Pack identifier");
  }
}

function uniqueValues<T extends object>(values: readonly T[]): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(JSON.stringify(value), structuredClone(value));
  return [...result.values()];
}
