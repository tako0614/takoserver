import type { MeterSource, ProviderMeterDeployment } from "../provider-meter-port.ts";
import {
  array,
  boundedJson,
  finite,
  integrateStorage,
  meterResult,
  meterWindow,
  OBJECT_STORAGE_METERS,
  ProviderMeterError,
  record,
} from "./provider-meter.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export function createCloudflareR2MeterSource(options: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}): MeterSource {
  const accountId = bounded(options.accountId, 1, 128);
  const apiToken = bounded(options.apiToken, 3, 4_096);
  const send = options.fetch ?? ((request: Request) => fetch(request));
  return {
    id: "cloudflare-r2-analytics",
    meters: [OBJECT_STORAGE_METERS.storage, OBJECT_STORAGE_METERS.requests],
    settlementDelaySeconds: 300,
    maximumWindowSeconds: 86_400,
    retentionSeconds: 31 * 86_400,
    async read({ deployment, from, until }) {
      const bucketName = r2Bucket(deployment);
      const window = meterWindow(from, until);
      const request = new Request(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: QUERY,
          variables: { accountTag: accountId, startDate: from, endDate: until, bucketName },
        }),
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
      const account = record(accounts[0]);
      const operations = array(account.r2OperationsAdaptiveGroups);
      const requests = operations.reduce(
        (sum: number, item) => sum + finite(record(record(item).sum).requests),
        0,
      );
      const storage = array(account.r2StorageAdaptiveGroups).map((item) => {
        const group = record(item);
        const maximum = record(group.max);
        const dimensions = record(group.dimensions);
        const at = Date.parse(text(dimensions.datetime));
        if (!Number.isFinite(at)) throw new ProviderMeterError("upstream_invalid");
        return { at, bytes: finite(maximum.payloadSize) + finite(maximum.metadataSize) };
      });
      return meterResult([
        { meter: OBJECT_STORAGE_METERS.requests, quantity: requests / 1_000_000 },
        {
          meter: OBJECT_STORAGE_METERS.storage,
          quantity: integrateStorage(storage, window.start, window.end),
        },
      ]);
    },
  };
}

function r2Bucket(deployment: ProviderMeterDeployment): string {
  if (deployment.providerPackRef !== "cloudflare" || !deployment.nativeId.startsWith("r2:")) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return bounded(deployment.nativeId.slice(3), 1, 255);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new ProviderMeterError("upstream_invalid");
  return value;
}

function bounded(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    throw new TypeError("invalid Cloudflare R2 meter configuration");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const QUERY = `query TakoserverR2Usage($accountTag: string!, $startDate: Time!, $endDate: Time!, $bucketName: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $startDate, datetime_lt: $endDate, bucketName: $bucketName }) {
        sum { requests }
      }
      r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $startDate, datetime_lt: $endDate, bucketName: $bucketName }, orderBy: [datetime_ASC]) {
        max { payloadSize metadataSize }
        dimensions { datetime }
      }
    }
  }
}`;
