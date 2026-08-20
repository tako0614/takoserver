import type { PricePlan, ProviderInstallation, SupplyContract } from "./catalog-compiler.ts";
import {
  parseHostedPlacement,
  parseHostedPricePlan,
  parseHostedProviderInstallation,
  parseHostedSupplyContract,
} from "./hosted-object-bucket-supplies.ts";
import type { ObjectBucketPlacement } from "./object-bucket-deployment.ts";
import { parseStrictJson } from "./strict-json.ts";

export const HOSTED_EDGE_SUPPLIES_KIND = "takoserver.hosted-edge-supplies@v1" as const;

export const HOSTED_EDGE_IDENTITY_CLASSES = {
  ModuleWorker: "compute.edge",
  EdgeKVNamespace: "storage.kv",
  SQLiteDatabase: "database.sqlite",
  AtLeastOnceQueue: "messaging.queue",
} as const;

export type HostedEdgeIdentityKind = keyof typeof HOSTED_EDGE_IDENTITY_CLASSES;

export interface HostedEdgeOffering {
  readonly formKind: HostedEdgeIdentityKind;
  readonly offeringId: string;
  readonly displayName: string;
  readonly pricePlan: PricePlan;
  readonly placement: ObjectBucketPlacement;
}

/**
 * One reviewed Cloudflare installation may sell several logical identity
 * Forms. Revision, Deployment, and Attachment Forms are intentionally absent:
 * they inherit this installation from their exact logical relations and are
 * never independently selected or priced.
 */
export interface HostedEdgeSupplies {
  readonly kind: typeof HOSTED_EDGE_SUPPLIES_KIND;
  readonly providerInstallation: ProviderInstallation;
  readonly supplyContract: SupplyContract;
  readonly offerings: readonly HostedEdgeOffering[];
}

export function parseHostedEdgeSupplies(raw: string): HostedEdgeSupplies {
  const root = record(parseStrictJson(new TextEncoder().encode(raw), 262_144));
  exactKeys(root, ["kind", "providerInstallation", "supplyContract", "offerings"]);
  if (root.kind !== HOSTED_EDGE_SUPPLIES_KIND || !Array.isArray(root.offerings)) invalid();
  if (root.offerings.length < 1 || root.offerings.length > 32) invalid();
  const offerings = root.offerings.map(parseOffering);
  unique(offerings.map((offering) => offering.formKind));
  unique(offerings.map((offering) => offering.offeringId));
  unique(offerings.map((offering) => offering.pricePlan.id));
  const resourceClasses = [...new Set(offerings.map(resourceClass))].sort();
  const providerInstallation = parseHostedProviderInstallation(root.providerInstallation);
  const supplyContract = parseHostedSupplyContract(root.supplyContract, resourceClasses);
  if (
    providerInstallation.providerPackRef !== "cloudflare" ||
    providerInstallation.supplyContractRef !== supplyContract.id ||
    supplyContract.providerType !== "cloudflare" ||
    !providerInstallation.regions.every((region) => supplyContract.regions.includes(region.id)) ||
    !offerings.every((offering) =>
      supplyContract.deliveryModes.includes(offering.placement.deliveryMode),
    )
  ) {
    invalid();
  }
  return {
    kind: HOSTED_EDGE_SUPPLIES_KIND,
    providerInstallation,
    supplyContract,
    offerings,
  };
}

export function hostedEdgeSuppliesJson(value: HostedEdgeSupplies): string {
  return JSON.stringify(parseHostedEdgeSupplies(JSON.stringify(value)));
}

function parseOffering(value: unknown): HostedEdgeOffering {
  const item = record(value);
  exactKeys(item, ["formKind", "offeringId", "displayName", "pricePlan", "placement"]);
  const formKind = edgeKind(item.formKind);
  const pricePlan = parseHostedPricePlan(item.pricePlan);
  const placement = parseHostedPlacement(item.placement);
  // Meter sources are provider-specific capabilities. They are added only
  // once a production adapter exists; a private price cannot invent one.
  if (pricePlan.meters.length !== 0) invalid();
  return {
    formKind,
    offeringId: id(item.offeringId),
    displayName: bounded(item.displayName, 1, 128),
    pricePlan,
    placement,
  };
}

function resourceClass(offering: HostedEdgeOffering): string {
  return HOSTED_EDGE_IDENTITY_CLASSES[offering.formKind];
}

function edgeKind(value: unknown): HostedEdgeIdentityKind {
  if (typeof value === "string" && value in HOSTED_EDGE_IDENTITY_CLASSES) {
    return value as HostedEdgeIdentityKind;
  }
  invalid();
}

function id(value: unknown): string {
  const result = bounded(value, 1, 255);
  if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(result)) invalid();
  return result;
}

function bounded(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) invalid();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid();
  }
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function invalid(): never {
  throw new TypeError("invalid hosted edge supplies");
}
