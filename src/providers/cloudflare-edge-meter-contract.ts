/**
 * Credential-free retail meter vocabulary shared by supply validation and the
 * private Cloudflare analytics adapter. Keeping these constants separate
 * prevents parsing a public supply contract from importing the parent-account
 * GraphQL transport into the public Worker bundle.
 */
export const CLOUDFLARE_EDGE_METERS = {
  workerRequests: "compute.worker.requests.million",
  kvOperations: "storage.kv.operations.million",
  kvStorage: "storage.kv.gib-hour",
  d1RowsRead: "database.sqlite.rows-read.million",
  d1RowsWritten: "database.sqlite.rows-written.million",
  d1Storage: "database.sqlite.gib-hour",
  queueOperations: "messaging.queue.operations.million",
  queueTransfer: "messaging.queue.transfer.gib",
} as const;

export const CLOUDFLARE_EDGE_METER_SETS = {
  ModuleWorker: [CLOUDFLARE_EDGE_METERS.workerRequests],
  EdgeKVNamespace: [CLOUDFLARE_EDGE_METERS.kvOperations, CLOUDFLARE_EDGE_METERS.kvStorage],
  SQLiteDatabase: [
    CLOUDFLARE_EDGE_METERS.d1RowsRead,
    CLOUDFLARE_EDGE_METERS.d1RowsWritten,
    CLOUDFLARE_EDGE_METERS.d1Storage,
  ],
  AtLeastOnceQueue: [CLOUDFLARE_EDGE_METERS.queueOperations, CLOUDFLARE_EDGE_METERS.queueTransfer],
} as const;

export type CloudflareProviderMeterSourceDescriptor = Omit<MeterSource, "read">;

/**
 * Value-free meter metadata shared by the public catalog proxy and the private
 * analytics adapters. Credentials and GraphQL transport deliberately live in
 * the adapter modules, never in this contract.
 */
export const CLOUDFLARE_PROVIDER_METER_SOURCES = {
  worker: {
    id: "cloudflare-worker-analytics",
    meters: CLOUDFLARE_EDGE_METER_SETS.ModuleWorker,
    settlementDelaySeconds: 900,
    maximumWindowSeconds: 3_600,
    retentionSeconds: 31 * 86_400,
  },
  kv: {
    id: "cloudflare-kv-analytics",
    meters: CLOUDFLARE_EDGE_METER_SETS.EdgeKVNamespace,
    settlementDelaySeconds: 86_400,
    maximumWindowSeconds: 86_400,
    retentionSeconds: 31 * 86_400,
    windowAlignment: "utc-day",
  },
  d1: {
    id: "cloudflare-d1-analytics",
    meters: CLOUDFLARE_EDGE_METER_SETS.SQLiteDatabase,
    settlementDelaySeconds: 86_400,
    maximumWindowSeconds: 86_400,
    retentionSeconds: 31 * 86_400,
    windowAlignment: "utc-day",
  },
  queue: {
    id: "cloudflare-queue-analytics",
    meters: CLOUDFLARE_EDGE_METER_SETS.AtLeastOnceQueue,
    settlementDelaySeconds: 900,
    maximumWindowSeconds: 3_600,
    retentionSeconds: 31 * 86_400,
  },
  r2: {
    id: "cloudflare-r2-analytics",
    meters: [OBJECT_STORAGE_METERS.storage, OBJECT_STORAGE_METERS.requests],
    settlementDelaySeconds: 300,
    maximumWindowSeconds: 86_400,
    retentionSeconds: 31 * 86_400,
  },
} as const satisfies Readonly<
  Record<"worker" | "kv" | "d1" | "queue" | "r2", CloudflareProviderMeterSourceDescriptor>
>;

/** Exact commercial identity Form to one private Cloudflare meter source. */
export function cloudflareProviderMeterSourceForOfferingKind(
  formKind: string,
): CloudflareProviderMeterSourceDescriptor | null {
  switch (formKind) {
    case "ModuleWorker":
      return CLOUDFLARE_PROVIDER_METER_SOURCES.worker;
    case "EdgeKVNamespace":
      return CLOUDFLARE_PROVIDER_METER_SOURCES.kv;
    case "SQLiteDatabase":
      return CLOUDFLARE_PROVIDER_METER_SOURCES.d1;
    case "AtLeastOnceQueue":
      return CLOUDFLARE_PROVIDER_METER_SOURCES.queue;
    case "ObjectBucket":
      return CLOUDFLARE_PROVIDER_METER_SOURCES.r2;
    default:
      return null;
  }
}

import type { MeterSource } from "../provider-meter-port.ts";
import { OBJECT_STORAGE_METERS } from "./provider-meter.ts";
