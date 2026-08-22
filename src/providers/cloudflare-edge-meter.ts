import type { MeterSource, ProviderMeterDeployment } from "../provider-meter-port.ts";
import {
  array,
  boundedJson,
  finite,
  integrateStorage,
  meterResult,
  meterWindow,
  ProviderMeterError,
  record,
} from "./provider-meter.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const GIBIBYTE = 1_073_741_824;

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

/**
 * Exact per-resource readers for Cloudflare-hosted edge identities.
 *
 * These are retail measurement facts, not a claim that Cloudflare's Analytics
 * API is its invoice ledger. Upstream invoice reconciliation remains a
 * separate operator concern.
 */
export function createCloudflareEdgeMeterSources(options: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}): readonly MeterSource[] {
  const accountId = bounded(options.accountId, 1, 128);
  const apiToken = bounded(options.apiToken, 3, 4_096);
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const query = async (document: string, variables: Record<string, string>) => {
    const request = new Request(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: document, variables: { accountTag: accountId, ...variables } }),
    });
    let response: Response;
    try {
      response = await send(request);
    } catch {
      throw new ProviderMeterError("upstream_unavailable");
    }
    const root = record(await boundedJson(response));
    if (Array.isArray(root.errors) && root.errors.length > 0) {
      throw new ProviderMeterError("upstream_unavailable");
    }
    const accounts = array(record(record(root.data).viewer).accounts, 1);
    if (accounts.length !== 1) throw new ProviderMeterError("upstream_invalid");
    return record(accounts[0]);
  };

  return [
    {
      id: "cloudflare-worker-analytics",
      meters: [CLOUDFLARE_EDGE_METERS.workerRequests],
      settlementDelaySeconds: 900,
      maximumWindowSeconds: 3_600,
      retentionSeconds: 31 * 86_400,
      async read({ deployment, from, until }) {
        meterWindow(from, until);
        const scriptName = native(deployment, "worker:");
        const account = await query(WORKER_QUERY, {
          start: from,
          end: until,
          scriptName,
        });
        const requests = array(account.workersInvocationsAdaptive).reduce(
          (sum: number, item) => sum + finite(record(record(item).sum).requests),
          0,
        );
        return meterResult([
          { meter: CLOUDFLARE_EDGE_METERS.workerRequests, quantity: requests / 1_000_000 },
        ]);
      },
    },
    {
      id: "cloudflare-kv-analytics",
      meters: [CLOUDFLARE_EDGE_METERS.kvOperations, CLOUDFLARE_EDGE_METERS.kvStorage],
      settlementDelaySeconds: 86_400,
      maximumWindowSeconds: 86_400,
      retentionSeconds: 31 * 86_400,
      windowAlignment: "utc-day",
      async read({ deployment, from, until }) {
        const window = dailyWindow(from, until);
        const namespaceId = native(deployment, "kv:");
        const account = await query(KV_QUERY, {
          start: day(from),
          end: day(until),
          namespaceId,
        });
        const operations = array(account.kvOperationsAdaptiveGroups).reduce(
          (sum: number, item) => sum + finite(record(record(item).sum).requests),
          0,
        );
        const storage = storageSamples(account.kvStorageAdaptiveGroups, "byteCount");
        return meterResult([
          { meter: CLOUDFLARE_EDGE_METERS.kvOperations, quantity: operations / 1_000_000 },
          {
            meter: CLOUDFLARE_EDGE_METERS.kvStorage,
            quantity: integrateStorage(storage, window.start, window.end),
          },
        ]);
      },
    },
    {
      id: "cloudflare-d1-analytics",
      meters: [
        CLOUDFLARE_EDGE_METERS.d1RowsRead,
        CLOUDFLARE_EDGE_METERS.d1RowsWritten,
        CLOUDFLARE_EDGE_METERS.d1Storage,
      ],
      settlementDelaySeconds: 86_400,
      maximumWindowSeconds: 86_400,
      retentionSeconds: 31 * 86_400,
      windowAlignment: "utc-day",
      async read({ deployment, from, until }) {
        const window = dailyWindow(from, until);
        const databaseId = native(deployment, "d1:");
        const account = await query(D1_QUERY, {
          start: day(from),
          end: day(until),
          databaseId,
        });
        const analytics = array(account.d1AnalyticsAdaptiveGroups);
        const rowsRead = analytics.reduce(
          (sum: number, item) => sum + finite(record(record(item).sum).rowsRead),
          0,
        );
        const rowsWritten = analytics.reduce(
          (sum: number, item) => sum + finite(record(record(item).sum).rowsWritten),
          0,
        );
        const storage = storageSamples(account.d1StorageAdaptiveGroups, "databaseSizeBytes");
        return meterResult([
          { meter: CLOUDFLARE_EDGE_METERS.d1RowsRead, quantity: rowsRead / 1_000_000 },
          { meter: CLOUDFLARE_EDGE_METERS.d1RowsWritten, quantity: rowsWritten / 1_000_000 },
          {
            meter: CLOUDFLARE_EDGE_METERS.d1Storage,
            quantity: integrateStorage(storage, window.start, window.end),
          },
        ]);
      },
    },
    {
      id: "cloudflare-queue-analytics",
      meters: [CLOUDFLARE_EDGE_METERS.queueOperations, CLOUDFLARE_EDGE_METERS.queueTransfer],
      settlementDelaySeconds: 900,
      maximumWindowSeconds: 3_600,
      retentionSeconds: 31 * 86_400,
      async read({ deployment, from, until }) {
        meterWindow(from, until);
        const queueId = native(deployment, "queue:");
        const account = await query(QUEUE_QUERY, { start: from, end: until, queueId });
        const groups = array(account.queueMessageOperationsAdaptiveGroups);
        const operations = groups.reduce(
          (sum: number, item) => sum + finite(record(record(item).sum).billableOperations),
          0,
        );
        const bytes = groups.reduce(
          (sum: number, item) => sum + finite(record(record(item).sum).bytes),
          0,
        );
        return meterResult([
          { meter: CLOUDFLARE_EDGE_METERS.queueOperations, quantity: operations / 1_000_000 },
          { meter: CLOUDFLARE_EDGE_METERS.queueTransfer, quantity: bytes / GIBIBYTE },
        ]);
      },
    },
  ];
}

function native(deployment: ProviderMeterDeployment, prefix: string): string {
  if (deployment.providerPackRef !== "cloudflare" || !deployment.nativeId.startsWith(prefix)) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return bounded(deployment.nativeId.slice(prefix.length), 1, 255);
}

function dailyWindow(from: string, until: string) {
  const window = meterWindow(from, until, 1);
  if (
    window.start % 86_400_000 !== 0 ||
    window.end % 86_400_000 !== 0 ||
    window.end - window.start !== 86_400_000
  ) {
    throw new ProviderMeterError("window_invalid");
  }
  return window;
}

function day(value: string): string {
  return value.slice(0, 10);
}

function storageSamples(value: unknown, field: string) {
  return array(value).map((item) => {
    const group = record(item);
    const date = record(group.dimensions).date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      throw new ProviderMeterError("upstream_invalid");
    }
    return {
      at: Date.parse(`${date}T00:00:00.000Z`),
      bytes: finite(record(group.max)[field]),
    };
  });
}

function bounded(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new TypeError("invalid Cloudflare edge meter configuration");
  }
  return value;
}

const WORKER_QUERY = `query TakoserverWorkerUsage($accountTag: string!, $start: Time!, $end: Time!, $scriptName: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $scriptName, datetime_geq: $start, datetime_lt: $end }) { sum { requests } }
  } }
}`;

const KV_QUERY = `query TakoserverKvUsage($accountTag: string!, $start: Date!, $end: Date!, $namespaceId: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    kvOperationsAdaptiveGroups(limit: 10000, filter: { namespaceId: $namespaceId, date_geq: $start, date_lt: $end }) { sum { requests } }
    kvStorageAdaptiveGroups(limit: 10000, filter: { namespaceId: $namespaceId, date_geq: $start, date_lt: $end }, orderBy: [date_ASC]) { max { byteCount } dimensions { date } }
  } }
}`;

const D1_QUERY = `query TakoserverD1Usage($accountTag: string!, $start: Date!, $end: Date!, $databaseId: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: { databaseId: $databaseId, date_geq: $start, date_lt: $end }) { sum { rowsRead rowsWritten } }
    d1StorageAdaptiveGroups(limit: 10000, filter: { databaseId: $databaseId, date_geq: $start, date_lt: $end }, orderBy: [date_ASC]) { max { databaseSizeBytes } dimensions { date } }
  } }
}`;

const QUEUE_QUERY = `query TakoserverQueueUsage($accountTag: string!, $start: Time!, $end: Time!, $queueId: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { queueId: $queueId, datetime_geq: $start, datetime_lt: $end }) { sum { billableOperations bytes } }
  } }
}`;
