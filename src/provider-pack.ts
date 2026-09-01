import type { AttachmentFactory } from "./attachments.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import type { MeterSource } from "./provider-meter-port.ts";
import type {
  Provider,
  ProviderFailure,
  ProviderRelation,
  ResourceIdentity,
} from "./provider-port.ts";
import type { ResourceDeployment } from "./resource-deployments.ts";

export type { MeterSource } from "./provider-meter-port.ts";

export type ResourceProvisioner = Provider;

export type TransferOperationTicket<Receipt> =
  | { readonly phase: "succeeded"; readonly receipt: Receipt }
  | { readonly phase: "failed"; readonly failure: ProviderFailure }
  | {
      readonly phase: "running";
      readonly handle: string;
      readonly pollAfterMs: number;
    };

export interface TransferImportReceipt {
  /** Optional provider evidence retained only as an opaque recovery reference. */
  readonly receiptRef?: string;
}

export interface TransferExportReceipt {
  readonly transferRef: string;
}

export interface TransferVerificationReceipt {
  readonly schema: boolean;
  readonly rowCounts: boolean;
  readonly checksums: boolean;
  readonly evidenceDigest: `sha256:${string}`;
}

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
    /** Initial may mutate; recovery must only poll, adopt, or read back. */
    readonly operationMode: "initial";
    readonly tenantId: string;
    readonly source: ResourceDeployment;
    readonly format: string;
  }): Promise<TransferExportReceipt | TransferOperationTicket<TransferExportReceipt>>;
  recoverExport?(input: {
    /** The exact identity durably recorded before initial dispatch. */
    readonly operationId: string;
    readonly operationMode: "recovery";
    /** Present after an acknowledged asynchronous response; absent for lost acknowledgement. */
    readonly handle?: string;
    readonly tenantId: string;
    readonly source: ResourceDeployment;
    readonly format: string;
  }): Promise<TransferOperationTicket<TransferExportReceipt>>;
  import(input: {
    /** Stable across retries of one Migration phase. */
    readonly operationId: string;
    /** Initial may mutate; recovery must only poll, adopt, or read back. */
    readonly operationMode: "initial";
    readonly tenantId: string;
    readonly target: ResourceDeployment;
    readonly transferRef: string;
    readonly format: string;
  }): Promise<void> | Promise<TransferOperationTicket<TransferImportReceipt>>;
  recoverImport?(input: {
    /** The exact identity durably recorded before initial dispatch. */
    readonly operationId: string;
    readonly operationMode: "recovery";
    /** Present after an acknowledged asynchronous response; absent for lost acknowledgement. */
    readonly handle?: string;
    readonly tenantId: string;
    readonly target: ResourceDeployment;
    readonly transferRef: string;
    readonly format: string;
  }): Promise<TransferOperationTicket<TransferImportReceipt>>;
  verify(input: {
    /** Stable across retries of one Migration phase. */
    readonly operationId: string;
    /** Initial may start provider work; recovery must only poll, adopt, or read back. */
    readonly operationMode: "initial";
    readonly tenantId: string;
    readonly source: ResourceDeployment;
    readonly target: ResourceDeployment;
    readonly requirements: {
      readonly schema: boolean;
      readonly rowCounts: boolean;
      readonly checksums: boolean;
    };
  }): Promise<TransferVerificationReceipt | TransferOperationTicket<TransferVerificationReceipt>>;
  recoverVerify?(input: {
    /** The exact identity durably recorded before initial dispatch. */
    readonly operationId: string;
    readonly operationMode: "recovery";
    /** Present after an acknowledged asynchronous response; absent for lost acknowledgement. */
    readonly handle?: string;
    readonly tenantId: string;
    readonly source: ResourceDeployment;
    readonly target: ResourceDeployment;
    readonly requirements: {
      readonly schema: boolean;
      readonly rowCounts: boolean;
      readonly checksums: boolean;
    };
  }): Promise<TransferOperationTicket<TransferVerificationReceipt>>;
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

export interface CostEstimator {
  readonly id: string;
  readonly meters: readonly string[];
  estimate(input: {
    readonly providerInstallationRef: string;
    readonly region: string;
    readonly usage: readonly { readonly meter: string; readonly quantity: number }[];
  }): Promise<{ readonly currency: "USD"; readonly amountMinor: number }>;
}

/** One provider-private transport route for one exact portable Binding. */
export interface RuntimeBindingMaterialRoute {
  readonly bindingRef: TakoformBindingRef;
  /** Opaque internal material protocol. Never a public Interface or Resource output. */
  readonly materialKind: string;
}

/** Target-side, read-only export from one already-realized Deployment. */
export interface RuntimeBindingExporter {
  readonly routes: readonly RuntimeBindingMaterialRoute[];
  exportTarget(input: {
    readonly tenantId: string;
    readonly relation: ProviderRelation & { readonly deployment: ResourceDeployment };
    readonly route: RuntimeBindingMaterialRoute;
  }): Promise<unknown | null>;
}

/** Consumer-side import into the exact selected provider runtime. */
export interface RuntimeBindingImporter {
  readonly routes: readonly RuntimeBindingMaterialRoute[];
  importBinding(input: {
    readonly tenantId: string;
    readonly source: ResourceIdentity;
    readonly sourceSpec: Readonly<Record<string, unknown>>;
    readonly name: string;
    readonly relation: ProviderRelation & { readonly deployment: ResourceDeployment };
    readonly route: RuntimeBindingMaterialRoute;
    readonly exported: {
      readonly providerPackRef: string;
      readonly materialKind: string;
      readonly material: unknown;
    };
  }): Promise<unknown | null>;
}

/**
 * Provider-private, directional materialization of an exact portable Binding.
 *
 * Export and import are deliberately independent. A pack may safely expose a
 * target exporter without claiming that its runtime can consume the material.
 * A complete capability exists only where one exporter route and one importer
 * route agree on the exact Binding and material kind, including within one
 * Provider Pack.
 */
export interface RuntimeBindingMaterializer {
  readonly id: string;
  readonly exporter?: RuntimeBindingExporter;
  readonly importer?: RuntimeBindingImporter;
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
  readonly runtimeBindingMaterializer?: RuntimeBindingMaterializer;
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
  if (definition.runtimeBindingMaterializer) {
    validateId(definition.runtimeBindingMaterializer.id);
    const { exporter, importer } = definition.runtimeBindingMaterializer;
    if (!exporter && !importer) {
      throw new TypeError("runtime Binding materializer has no directional route");
    }
    if (exporter) {
      uniqueRuntimeBindingRoutes(exporter.routes, "export");
      if (typeof exporter.exportTarget !== "function") {
        throw new TypeError("runtime Binding exporter is unavailable");
      }
    }
    if (importer) {
      uniqueRuntimeBindingRoutes(importer.routes, "import");
      if (typeof importer.importBinding !== "function") {
        throw new TypeError("runtime Binding importer is unavailable");
      }
    }
  }
  if (definition.attachmentFactories.some((factory) => factory.providerPackRef !== definition.id)) {
    throw new TypeError("AttachmentFactory belongs to another Provider Pack");
  }
  const ownedMeters = new Set<string>();
  for (const source of definition.meterSources) {
    positiveSeconds(source.settlementDelaySeconds, true);
    positiveSeconds(source.maximumWindowSeconds, false);
    if (source.retentionSeconds !== undefined) positiveSeconds(source.retentionSeconds, false);
    if (
      source.windowAlignment !== undefined &&
      (source.windowAlignment !== "utc-day" || source.maximumWindowSeconds % 86_400 !== 0)
    ) {
      throw new TypeError("invalid MeterSource window");
    }
    for (const meter of source.meters) {
      validateId(meter);
      if (ownedMeters.has(meter)) throw new TypeError(`ambiguous MeterSource meter: ${meter}`);
      ownedMeters.add(meter);
    }
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
    // A local importer is only one direction. The deployment compiler projects
    // Binding advertisements after an explicit target exporter relation proves
    // the complete route; a standalone Provider Pack therefore advertises none.
    bindingRefs: [],
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

function uniqueRuntimeBindingRoutes(
  values: readonly RuntimeBindingMaterialRoute[],
  direction: "export" | "import",
): void {
  if (values.length < 1) {
    throw new TypeError(`runtime Binding ${direction} routes are empty`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    const { bindingRef } = value;
    if (
      bindingRef.apiVersion.length < 1 ||
      bindingRef.name.length < 1 ||
      bindingRef.version.length < 1 ||
      !/^sha256:[0-9a-f]{64}$/u.test(bindingRef.schemaDigest)
    ) {
      throw new TypeError(`invalid runtime Binding ${direction} route`);
    }
    validateMaterialKind(value.materialKind);
    const key = [
      bindingRef.apiVersion,
      bindingRef.name,
      bindingRef.version,
      bindingRef.schemaDigest,
      value.materialKind,
    ].join("\0");
    if (seen.has(key)) {
      throw new TypeError(
        `duplicate runtime Binding ${direction} route: ${bindingRef.name}@${bindingRef.version}`,
      );
    }
    seen.add(key);
  }
}

function validateMaterialKind(value: string): void {
  if (value.length < 1 || value.length > 255 || !/^[a-z0-9][a-z0-9._:/@-]*$/u.test(value)) {
    throw new TypeError("invalid runtime Binding material kind");
  }
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

function positiveSeconds(value: number, zeroAllowed: boolean): void {
  if (!Number.isSafeInteger(value) || value < (zeroAllowed ? 0 : 1) || value > 3_155_760_000) {
    throw new TypeError("invalid MeterSource window");
  }
}

function uniqueValues<T extends object>(values: readonly T[]): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(JSON.stringify(value), structuredClone(value));
  return [...result.values()];
}
