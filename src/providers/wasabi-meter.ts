import type { MeterSource, ProviderMeterDeployment } from "../provider-meter-port.ts";
import {
  array,
  boundedJson,
  decimal,
  integrateStorage,
  meterResult,
  meterWindow,
  OBJECT_STORAGE_METERS,
  ProviderMeterError,
  record,
} from "./provider-meter.ts";

const STATS_ORIGIN = "https://stats.wasabisys.com";

export function createWasabiBucketMeterSource(options: {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}): MeterSource {
  const region = identifier(options.region, 64);
  const accessKeyId = secret(options.accessKeyId, 512);
  const secretAccessKey = secret(options.secretAccessKey, 4_096);
  const send = options.fetch ?? ((request: Request) => fetch(request));
  return {
    id: "wasabi-bucket-utilization",
    meters: [
      OBJECT_STORAGE_METERS.storage,
      OBJECT_STORAGE_METERS.requests,
      OBJECT_STORAGE_METERS.egress,
    ],
    settlementDelaySeconds: 36 * 3_600,
    maximumWindowSeconds: 86_400,
    async read({ deployment, from, until }) {
      const bucket = wasabiBucket(deployment, region);
      const window = meterWindow(from, until);
      const url = new URL(
        `/v1/standalone/utilizations/bucket/${encodeURIComponent(bucket)}`,
        STATS_ORIGIN,
      );
      url.searchParams.set("pageNum", "0");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("from", day(window.start));
      url.searchParams.set("to", day(window.end));
      let response: Response;
      try {
        response = await send(
          new Request(url, {
            headers: {
              accept: "application/json",
              authorization: `${accessKeyId}:${secretAccessKey}`,
            },
          }),
        );
      } catch {
        throw new ProviderMeterError("upstream_unavailable");
      }
      const root = record(await boundedJson(response));
      const page = record(root.PageInfo);
      if (decimal(page.PageCount) > 1 || decimal(page.PageSize) > 100) {
        throw new ProviderMeterError("upstream_invalid");
      }
      const records = array(root.Records, 100).map((value) => record(value));
      let requests = 0;
      let egressBytes = 0;
      const samples = records.map((item) => {
        if (item.Bucket !== bucket || item.Region !== region) {
          throw new ProviderMeterError("upstream_invalid");
        }
        const at = Date.parse(text(item.StartTime));
        if (!Number.isFinite(at)) throw new ProviderMeterError("upstream_invalid");
        requests += decimal(item.NumAPICalls);
        egressBytes += decimal(item.DownloadBytes);
        return {
          at,
          bytes:
            decimal(item.RawStorageSizeBytes) +
            decimal(item.MetadataStorageSizeBytes) +
            decimal(item.DeletedStorageSizeBytes),
        };
      });
      return meterResult([
        { meter: OBJECT_STORAGE_METERS.egress, quantity: egressBytes / 1_073_741_824 },
        { meter: OBJECT_STORAGE_METERS.requests, quantity: requests / 1_000_000 },
        {
          meter: OBJECT_STORAGE_METERS.storage,
          quantity: integrateStorage(samples, window.start, window.end),
        },
      ]);
    },
  };
}

function wasabiBucket(deployment: ProviderMeterDeployment, region: string): string {
  const match = /^wasabi:([a-z0-9-]+):(ts-[a-f0-9]{40})$/u.exec(deployment.nativeId);
  if (deployment.providerPackRef !== "wasabi" || match?.[1] !== region || !match[2]) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return match[2];
}

function day(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new ProviderMeterError("upstream_invalid");
  return value;
}

function identifier(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new TypeError("invalid Wasabi meter configuration");
  }
  return value;
}

function secret(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > maximum ||
    /\s/u.test(value)
  ) {
    throw new TypeError("invalid Wasabi meter configuration");
  }
  return value;
}
