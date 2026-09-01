import type { PricePlan, ProviderInstallation, SupplyContract } from "./catalog-compiler.ts";
import type { ObjectBucketPlacement } from "./object-bucket-deployment.ts";
import { parseStrictJson } from "./strict-json.ts";

export const HOSTED_OBJECT_BUCKET_SUPPLIES_KIND =
  "takoserver.hosted-object-bucket-supplies@v2" as const;

export type HostedObjectBucketProvider =
  | { readonly kind: "cloudflare" }
  | { readonly kind: "wasabi"; readonly region: string; readonly roleArn: string };

export interface HostedObjectBucketSupply {
  readonly offeringId: string;
  readonly displayName: string;
  readonly provider: HostedObjectBucketProvider;
  readonly providerInstallation: ProviderInstallation;
  readonly supplyContract: SupplyContract;
  readonly pricePlan: PricePlan;
  readonly placement: ObjectBucketPlacement;
}

export interface HostedObjectBucketSupplies {
  readonly kind: typeof HOSTED_OBJECT_BUCKET_SUPPLIES_KIND;
  readonly supplies: readonly HostedObjectBucketSupply[];
}

/** Strict runtime contract emitted by the private operator composition. */
export function parseHostedObjectBucketSupplies(raw: string): HostedObjectBucketSupplies {
  const value = parseStrictJson(new TextEncoder().encode(raw), 262_144);
  const root = record(value);
  exactKeys(root, ["kind", "supplies"]);
  if (root.kind !== HOSTED_OBJECT_BUCKET_SUPPLIES_KIND || !Array.isArray(root.supplies)) invalid();
  if (root.supplies.length < 1 || root.supplies.length > 32) invalid();
  const supplies = root.supplies.map(parseSupply);
  unique(supplies.map((supply) => supply.offeringId));
  unique(supplies.map((supply) => supply.providerInstallation.id));
  unique(supplies.map((supply) => supply.supplyContract.id));
  unique(supplies.map((supply) => supply.pricePlan.id));
  unique(supplies.map((supply) => providerPackRef(supply.provider)));
  return { kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND, supplies };
}

export function hostedObjectBucketSuppliesJson(value: HostedObjectBucketSupplies): string {
  return JSON.stringify(parseHostedObjectBucketSupplies(JSON.stringify(value)));
}

function parseSupply(value: unknown): HostedObjectBucketSupply {
  const item = record(value);
  exactKeys(item, [
    "offeringId",
    "displayName",
    "provider",
    "providerInstallation",
    "supplyContract",
    "pricePlan",
    "placement",
  ]);
  const provider = parseProvider(item.provider);
  const providerPack = providerPackRef(provider);
  const providerInstallation = parseHostedProviderInstallation(item.providerInstallation);
  const supplyContract = parseHostedSupplyContract(item.supplyContract);
  const pricePlan = parseHostedPricePlan(item.pricePlan);
  const placement = parseHostedPlacement(item.placement);
  if (
    pricePlan.provisioning.meter !== "resource.create" ||
    pricePlan.provisioning.amountMinor !== 0 ||
    pricePlan.meters.length === 0 ||
    placement.deliveryMode !== "embedded-binding" ||
    !supplyContract.deliveryModes.includes("embedded-binding") ||
    supplyContract.customerAccess !== "operator-only" ||
    providerInstallation.providerPackRef !== providerPack ||
    providerInstallation.supplyContractRef !== supplyContract.id ||
    supplyContract.providerType !== providerPack ||
    !providerInstallation.regions.every((region) => supplyContract.regions.includes(region.id)) ||
    (provider.kind === "cloudflare" &&
      (providerInstallation.regions.length !== 1 ||
        providerInstallation.regions[0]?.id !== "global")) ||
    (provider.kind === "wasabi" &&
      (providerInstallation.regions.length !== 1 ||
        providerInstallation.regions[0]?.id !== provider.region))
  ) {
    invalid();
  }
  return {
    offeringId: id(item.offeringId),
    displayName: bounded(item.displayName, 1, 128),
    provider,
    providerInstallation,
    supplyContract,
    pricePlan,
    placement,
  };
}

function parseProvider(value: unknown): HostedObjectBucketProvider {
  const provider = record(value);
  if (provider.kind === "cloudflare") {
    exactKeys(provider, ["kind"]);
    return { kind: "cloudflare" };
  }
  if (provider.kind === "wasabi") {
    exactKeys(provider, ["kind", "region", "roleArn"]);
    const region = lowerId(provider.region, 64);
    const roleArn = bounded(provider.roleArn, 20, 600);
    if (!/^arn:aws:iam::[0-9]{1,32}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u.test(roleArn)) {
      invalid();
    }
    return { kind: "wasabi", region, roleArn };
  }
  invalid();
}

export function parseHostedProviderInstallation(value: unknown): ProviderInstallation {
  const installation = record(value);
  exactKeys(installation, ["id", "providerPackRef", "supplyContractRef", "state", "regions"]);
  if (!Array.isArray(installation.regions) || installation.regions.length < 1) invalid();
  return {
    id: id(installation.id),
    providerPackRef: id(installation.providerPackRef),
    supplyContractRef: id(installation.supplyContractRef),
    state: oneOf(installation.state, ["active", "suspended", "retired"]),
    regions: installation.regions.map((value) => {
      const region = record(value);
      exactKeys(region, ["id", "capacity"]);
      return {
        id: lowerId(region.id, 64),
        capacity: oneOf(region.capacity, ["available", "unavailable"]),
      };
    }),
  };
}

export function parseHostedSupplyContract(
  value: unknown,
  requiredResourceClasses: readonly string[] = ["storage.object"],
): SupplyContract {
  const contract = record(value);
  exactKeys(
    contract,
    [
      "id",
      "providerType",
      "permittedResourceClasses",
      "deliveryModes",
      "customerAccess",
      "whiteLabelAllowed",
      "endUserTermsRequired",
      "regions",
      "validFrom",
      "evidenceRef",
    ],
    ["validUntil"],
  );
  const permittedResourceClasses = contract.permittedResourceClasses;
  if (
    !Array.isArray(permittedResourceClasses) ||
    permittedResourceClasses.length < 1 ||
    permittedResourceClasses.length > 64 ||
    !Array.isArray(contract.deliveryModes) ||
    !Array.isArray(contract.regions) ||
    !requiredResourceClasses.every((item) => permittedResourceClasses.includes(item)) ||
    typeof contract.whiteLabelAllowed !== "boolean" ||
    typeof contract.endUserTermsRequired !== "boolean"
  ) {
    invalid();
  }
  const parsedResourceClasses = permittedResourceClasses.map((item) => id(item));
  unique(parsedResourceClasses);
  return {
    id: id(contract.id),
    providerType: lowerId(contract.providerType, 64),
    permittedResourceClasses: parsedResourceClasses,
    deliveryModes: contract.deliveryModes.map((value) =>
      oneOf(value, [
        "embedded-binding",
        "managed-endpoint",
        "native-credentials",
        "provider-subaccount",
        "white-label",
        "byoc-management",
      ]),
    ),
    customerAccess: oneOf(contract.customerAccess, [
      "operator-only",
      "scoped-native-access",
      "subaccount-access",
    ]),
    whiteLabelAllowed: contract.whiteLabelAllowed,
    endUserTermsRequired: contract.endUserTermsRequired,
    regions: contract.regions.map((region) => lowerId(region, 64)),
    validFrom: date(contract.validFrom),
    ...(contract.validUntil === undefined ? {} : { validUntil: date(contract.validUntil) }),
    evidenceRef: bounded(contract.evidenceRef, 3, 512),
  };
}

export function parseHostedPricePlan(value: unknown): PricePlan {
  const plan = record(value);
  exactKeys(plan, ["id", "currency", "provisioning", "meters"]);
  if (plan.currency !== "USD" || !Array.isArray(plan.meters) || plan.meters.length > 64) invalid();
  return {
    id: id(plan.id),
    currency: "USD",
    provisioning: parseCharge(plan.provisioning),
    meters: plan.meters.map(parseCharge),
  };
}

function parseCharge(value: unknown) {
  const charge = record(value);
  exactKeys(charge, ["meter", "amountMinor"], ["quantity"]);
  const amountMinor = integer(charge.amountMinor, 0);
  return {
    meter: id(charge.meter),
    amountMinor,
    ...(charge.quantity === undefined ? {} : { quantity: integer(charge.quantity, 1) }),
  };
}

export function parseHostedPlacement(value: unknown): ObjectBucketPlacement {
  const placement = record(value);
  exactKeys(placement, [
    "deliveryMode",
    "supportPolicyRef",
    "abusePolicyRef",
    "portability",
    "isolation",
  ]);
  const portability = record(placement.portability);
  exactKeys(portability, ["api", "exportFormats", "importFormats", "migrationModes"]);
  if (
    !Array.isArray(portability.exportFormats) ||
    !Array.isArray(portability.importFormats) ||
    !Array.isArray(portability.migrationModes)
  ) {
    invalid();
  }
  return {
    deliveryMode: oneOf(placement.deliveryMode, [
      "embedded-binding",
      "managed-endpoint",
      "native-credentials",
      "provider-subaccount",
      "white-label",
      "byoc-management",
    ]),
    supportPolicyRef: id(placement.supportPolicyRef),
    abusePolicyRef: id(placement.abusePolicyRef),
    portability: {
      api: oneOf(portability.api, ["native", "portable"]),
      exportFormats: portability.exportFormats.map((item) => reference(item)),
      importFormats: portability.importFormats.map((item) => reference(item)),
      migrationModes: portability.migrationModes.map((item) => oneOf(item, ["offline", "online"])),
    },
    isolation: oneOf(placement.isolation, [
      "shared-resource",
      "dedicated-resource",
      "provider-subaccount",
      "dedicated-project",
      "customer-byoc",
    ]),
  };
}

function providerPackRef(provider: HostedObjectBucketProvider): "cloudflare" | "wasabi" {
  return provider.kind;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value);
  if (
    required.some((key) => !actual.includes(key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    invalid();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function oneOf<const T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,254}$/u.test(value)) invalid();
  return value;
}

function reference(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function lowerId(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    invalid();
  }
  return value;
}

function bounded(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) invalid();
  return value;
}

function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}

function date(value: unknown): string {
  const text = bounded(value, 20, 40);
  if (!Number.isFinite(Date.parse(text))) invalid();
  return text;
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function invalid(): never {
  throw new TypeError("invalid hosted ObjectBucket supplies");
}
