import {
  HOSTED_EDGE_SUPPLIES_KIND,
  type HostedEdgeSupplies,
} from "../../src/hosted-edge-supplies.ts";
import {
  HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
  type HostedObjectBucketSupplies,
} from "../../src/hosted-object-bucket-supplies.ts";

/**
 * The shape the operator's real integration target has: two supply halves that
 * name the *same* Cloudflare `SupplyContract`.
 *
 * `createWorkerProductionComposition` builds one authority list from the edge
 * supply plus every Cloudflare object supply and then requires `uniqueExact`
 * over their contracts, while the object half separately requires
 * `storage.object` in its own contract. So the one contract both halves point
 * at must list every class either half sells. Declaring it twice with different
 * `permittedResourceClasses` parses on both sides and composes on neither —
 * which is exactly how a live Host went to `1101` on every route.
 */

const PORTABILITY = {
  api: "portable",
  exportFormats: [],
  importFormats: [],
  migrationModes: ["offline"],
} as const;

const PLACEMENT = {
  deliveryMode: "embedded-binding",
  supportPolicyRef: "support:hosted:standard",
  abusePolicyRef: "abuse:hosted:standard",
  portability: PORTABILITY,
  isolation: "dedicated-resource",
} as const;

const INSTALLATION = {
  id: "cloudflare.staging",
  providerPackRef: "cloudflare",
  supplyContractRef: "cloudflare.staging-supply",
  state: "active",
  regions: [{ id: "global", capacity: "available" }],
} as const;

/** Every class either half sells, on the one contract both halves name. */
export const SHARED_RESOURCE_CLASSES = [
  "compute.edge",
  "storage.kv",
  "database.sqlite",
  "messaging.queue",
  "storage.object",
] as const;

/** The classes the edge half alone needs — the incident's narrower half. */
export const EDGE_ONLY_RESOURCE_CLASSES = [
  "compute.edge",
  "storage.kv",
  "database.sqlite",
  "messaging.queue",
] as const;

function supplyContract(permittedResourceClasses: readonly string[]) {
  return {
    id: "cloudflare.staging-supply",
    providerType: "cloudflare",
    permittedResourceClasses: [...permittedResourceClasses],
    deliveryModes: ["embedded-binding"],
    customerAccess: "operator-only",
    whiteLabelAllowed: true,
    endUserTermsRequired: true,
    regions: ["global"],
    validFrom: "2026-01-01T00:00:00.000Z",
    evidenceRef: "private:cloudflare:staging-supply",
  };
}

const EDGE_OFFERINGS = [
  {
    formKind: "ModuleWorker",
    offeringId: "compute.edge.cloudflare.global",
    displayName: "Edge Worker",
    meters: ["compute.worker.requests.million"],
  },
  {
    formKind: "EdgeKVNamespace",
    offeringId: "storage.kv.cloudflare.global",
    displayName: "Edge KV",
    meters: ["storage.kv.operations.million", "storage.kv.gib-hour"],
  },
  {
    formKind: "SQLiteDatabase",
    offeringId: "database.sqlite.cloudflare.global",
    displayName: "Edge SQLite",
    meters: [
      "database.sqlite.rows-read.million",
      "database.sqlite.rows-written.million",
      "database.sqlite.gib-hour",
    ],
  },
  {
    formKind: "AtLeastOnceQueue",
    offeringId: "messaging.queue.cloudflare.global",
    displayName: "Edge Queue",
    meters: ["messaging.queue.operations.million", "messaging.queue.transfer.gib"],
  },
] as const;

/** Reviewed Cloudflare edge supplies over one named contract. */
export function edgeSuppliesFixture(
  permittedResourceClasses: readonly string[] = SHARED_RESOURCE_CLASSES,
): HostedEdgeSupplies {
  return {
    kind: HOSTED_EDGE_SUPPLIES_KIND,
    providerInstallation: structuredClone(INSTALLATION),
    supplyContract: supplyContract(permittedResourceClasses),
    offerings: EDGE_OFFERINGS.map((offering) => ({
      formKind: offering.formKind,
      offeringId: offering.offeringId,
      displayName: offering.displayName,
      pricePlan: {
        id: `${offering.offeringId}.price-v1`,
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: offering.meters.map((meter) => ({ meter, amountMinor: 30 })),
      },
      placement: structuredClone(PLACEMENT),
    })),
  } as unknown as HostedEdgeSupplies;
}

/** One Cloudflare object-bucket supply over the same named contract. */
export function objectBucketSuppliesFixture(
  permittedResourceClasses: readonly string[] = SHARED_RESOURCE_CLASSES,
): HostedObjectBucketSupplies {
  return {
    kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
    supplies: [
      {
        offeringId: "storage.object.cloudflare.staging",
        displayName: "Object Storage",
        provider: { kind: "cloudflare" },
        providerInstallation: structuredClone(INSTALLATION),
        supplyContract: supplyContract(permittedResourceClasses),
        pricePlan: {
          id: "storage.object.cloudflare.staging.price-v1",
          currency: "USD",
          provisioning: { meter: "resource.create", amountMinor: 0 },
          meters: [
            { meter: "storage.gib-hour", amountMinor: 2, quantity: 720 },
            { meter: "requests.million", amountMinor: 50 },
          ],
        },
        placement: structuredClone(PLACEMENT),
      },
    ],
  } as unknown as HostedObjectBucketSupplies;
}
