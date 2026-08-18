import { type Catalog, createCatalog, type Offering, type PricePlan } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import type { ProviderPackDescriptor } from "./provider-pack.ts";

export type { PricePlan } from "./catalog.ts";

export type DeliveryMode = Offering["deliveryMode"];

export interface SupplyContract {
  readonly id: string;
  readonly providerType: string;
  readonly permittedResourceClasses: readonly string[];
  readonly deliveryModes: readonly DeliveryMode[];
  readonly customerAccess: "operator-only" | "scoped-native-access" | "subaccount-access";
  readonly whiteLabelAllowed: boolean;
  readonly endUserTermsRequired: boolean;
  readonly regions: readonly string[];
  readonly validFrom: string;
  readonly validUntil?: string;
  /** Private composition resolves this reference; the public catalog never exposes its contents. */
  readonly evidenceRef: string;
}

export interface ProviderInstallation {
  readonly id: string;
  readonly providerPackRef: string;
  readonly supplyContractRef: string;
  readonly state: "active" | "suspended" | "retired";
  readonly regions: readonly {
    readonly id: string;
    readonly capacity: "available" | "unavailable";
  }[];
}

export type CatalogCandidate = Omit<Offering, "available" | "pricePlan">;

export type CatalogDiagnosticCode =
  | "provider_pack_missing"
  | "form_not_implemented"
  | "interface_not_implemented"
  | "binding_not_implemented"
  | "provider_installation_inactive"
  | "supply_contract_inactive"
  | "resource_class_not_permitted"
  | "delivery_mode_not_permitted"
  | "region_not_permitted"
  | "capacity_unavailable"
  | "price_plan_missing"
  | "meter_source_missing"
  | "operations_owner_missing";

export interface CatalogCompilation {
  readonly catalog: Catalog;
  readonly diagnostics: readonly {
    readonly offeringId: string;
    readonly code: CatalogDiagnosticCode;
  }[];
}

export function compileCatalog(input: {
  readonly candidates: readonly CatalogCandidate[];
  readonly providerPacks: readonly ProviderPackDescriptor[];
  readonly providerInstallations: readonly ProviderInstallation[];
  readonly supplyContracts: readonly SupplyContract[];
  readonly pricePlans: readonly PricePlan[];
  readonly now: Date;
}): CatalogCompilation {
  const packs = unique(input.providerPacks, "Provider Pack");
  const installations = unique(input.providerInstallations, "Provider Installation");
  const contracts = unique(input.supplyContracts, "Supply Contract");
  const prices = unique(input.pricePlans, "Price Plan");
  const offerings: Offering[] = [];
  const diagnostics: { offeringId: string; code: CatalogDiagnosticCode }[] = [];

  for (const candidate of input.candidates) {
    const pack = packs.get(candidate.providerPackRef);
    const installation = installations.get(candidate.providerInstallationRef);
    const contract = contracts.get(candidate.supplyContractRef);
    const pricePlan = prices.get(candidate.pricePlanRef);
    const code = firstProblem({
      candidate,
      pack,
      installation,
      contract,
      pricePlan,
      now: input.now,
    });
    if (code) {
      diagnostics.push({ offeringId: candidate.id, code });
      continue;
    }
    if (!pricePlan) throw new Error("catalog_compiler_invariant_failed");
    offerings.push({
      ...structuredClone(candidate),
      pricePlan: structuredClone(pricePlan),
      available: true,
    });
  }

  return { catalog: createCatalog(offerings), diagnostics };
}

function firstProblem(input: {
  readonly candidate: CatalogCandidate;
  readonly pack: ProviderPackDescriptor | undefined;
  readonly installation: ProviderInstallation | undefined;
  readonly contract: SupplyContract | undefined;
  readonly pricePlan: PricePlan | undefined;
  readonly now: Date;
}): CatalogDiagnosticCode | undefined {
  const { candidate, pack, installation, contract, pricePlan, now } = input;
  if (!pack) return "provider_pack_missing";
  if (!pack.forms.some((form) => sameForm(form, candidate.form))) return "form_not_implemented";
  if (
    !candidate.providedInterfaces.every((ref) =>
      pack.providedInterfaces.some((item) => sameInterface(item, ref)),
    )
  ) {
    return "interface_not_implemented";
  }
  if (
    !candidate.bindingRefs.every((ref) => pack.bindingRefs.some((item) => sameBinding(item, ref)))
  ) {
    return "binding_not_implemented";
  }
  if (
    !installation ||
    installation.state !== "active" ||
    installation.providerPackRef !== pack.id ||
    installation.supplyContractRef !== candidate.supplyContractRef
  ) {
    return "provider_installation_inactive";
  }
  if (
    !contract ||
    contract.providerType !== pack.providerType ||
    !activeAt(contract, now) ||
    contract.evidenceRef.length < 3
  ) {
    return "supply_contract_inactive";
  }
  if (!contract.permittedResourceClasses.includes(candidate.resourceClass)) {
    return "resource_class_not_permitted";
  }
  if (!contract.deliveryModes.includes(candidate.deliveryMode)) {
    return "delivery_mode_not_permitted";
  }
  if (!candidate.regions.every((region) => contract.regions.includes(region))) {
    return "region_not_permitted";
  }
  if (
    !candidate.regions.every((region) =>
      installation.regions.some((entry) => entry.id === region && entry.capacity === "available"),
    )
  ) {
    return "capacity_unavailable";
  }
  if (!pricePlan || pricePlan.id !== candidate.pricePlanRef || !validPricePlan(pricePlan)) {
    return "price_plan_missing";
  }
  if (!pricePlan.meters.every((meter) => pack.meterSources.includes(meter.meter))) {
    return "meter_source_missing";
  }
  if (candidate.supportPolicyRef.length < 3 || candidate.abusePolicyRef.length < 3) {
    return "operations_owner_missing";
  }
  return undefined;
}

function unique<T extends { readonly id: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) throw new TypeError(`duplicate ${label} id: ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

function activeAt(contract: SupplyContract, now: Date): boolean {
  const current = now.getTime();
  const from = Date.parse(contract.validFrom);
  const until =
    contract.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(contract.validUntil);
  return Number.isFinite(current) && Number.isFinite(from) && current >= from && current < until;
}

function validPricePlan(plan: PricePlan): boolean {
  const charges = [plan.recurring, ...plan.meters];
  return (
    charges.length <= 65 &&
    new Set(charges.map((charge) => charge.meter)).size === charges.length &&
    charges.every(
      (charge) =>
        charge.meter.length >= 1 &&
        charge.meter.length <= 128 &&
        Number.isSafeInteger(charge.amountMinor) &&
        charge.amountMinor >= 0 &&
        (charge.quantity === undefined ||
          (Number.isSafeInteger(charge.quantity) && charge.quantity > 0)),
    )
  );
}

function sameForm(left: TakoformV1Alpha3FormRef, right: TakoformV1Alpha3FormRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function sameInterface(left: TakoformInterfaceRef, right: TakoformInterfaceRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}

function sameBinding(left: TakoformBindingRef, right: TakoformBindingRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}
