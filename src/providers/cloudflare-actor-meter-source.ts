import type { ProviderMeterDeployment } from "../provider-meter-port.ts";
import { array, boundedJson, ProviderMeterError, record } from "./provider-meter.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const MAX_WINDOW_DAYS = 31;
const MAX_GROUPS = 10_000;
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

interface ActorAnalyticsRequest {
  readonly query: string;
  readonly variables: {
    readonly accountTag: string;
    readonly namespaceId: string;
    readonly start: string;
    readonly end: string;
  };
}

/**
 * Windowed Cloudflare Analytics observations for one Durable Object namespace.
 * These values preserve upstream units and are not asserted final or billable.
 */
export interface CloudflareActorNamespaceObservation {
  readonly namespaceId: string;
  readonly window: { readonly from: string; readonly until: string };
  readonly requests: { readonly value: number; readonly unit: "requests" };
  readonly duration: { readonly value: number; readonly unit: "GB*s" };
  readonly rowsRead: { readonly value: number; readonly unit: "rows" };
  readonly rowsWritten: { readonly value: number; readonly unit: "rows" };
}

/**
 * Reads namespace-scoped, time-windowed Durable Object analytics. This is an
 * observation adapter, not the settled `MeterSource` consumed by retail billing.
 */
export function createCloudflareActorNamespaceMetricsReader(options: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}) {
  const accountId = bounded(options.accountId, 1, 128);
  const apiToken = bounded(options.apiToken, 3, 4_096);
  const send = options.fetch ?? ((request: Request) => fetch(request));

  return {
    async read(input: {
      readonly deployment: ProviderMeterDeployment;
      readonly from: string;
      readonly until: string;
    }): Promise<CloudflareActorNamespaceObservation> {
      const namespaceId = actorNamespace(input.deployment);
      boundedWindow(input.from, input.until);
      const body: ActorAnalyticsRequest = {
        query: QUERY,
        variables: {
          accountTag: accountId,
          namespaceId,
          start: input.from,
          end: input.until,
        },
      };
      const request = new Request(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      let response: Response;
      try {
        response = await send(request);
      } catch {
        throw new ProviderMeterError("upstream_unavailable");
      }
      const root = record(await boundedJson(response));
      if (Object.hasOwn(root, "errors")) {
        if (!Array.isArray(root.errors)) throw new ProviderMeterError("upstream_invalid");
        if (root.errors.length > 0) throw new ProviderMeterError("upstream_unavailable");
      }
      const accounts = array(record(record(root.data).viewer).accounts, 1);
      if (accounts.length !== 1) throw new ProviderMeterError("upstream_invalid");
      const account = record(accounts[0]);

      return {
        namespaceId,
        window: { from: input.from, until: input.until },
        requests: {
          value: sumGroups(
            account.durableObjectsInvocationsAdaptiveGroups,
            namespaceId,
            "requests",
          ),
          unit: "requests",
        },
        duration: {
          value: sumGroups(account.durableObjectsPeriodicGroups, namespaceId, "duration"),
          unit: "GB*s",
        },
        rowsRead: {
          value: sumGroups(account.durableObjectsPeriodicGroups, namespaceId, "rowsRead"),
          unit: "rows",
        },
        rowsWritten: {
          value: sumGroups(account.durableObjectsPeriodicGroups, namespaceId, "rowsWritten"),
          unit: "rows",
        },
      };
    },
  };
}

function actorNamespace(deployment: ProviderMeterDeployment): string {
  const match = /^actor:([a-f0-9]{32})$/u.exec(deployment.nativeId);
  if (deployment.providerPackRef !== "cloudflare" || !match?.[1]) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return match[1];
}

function boundedWindow(from: string, until: string): void {
  const start = Date.parse(from);
  const end = Date.parse(until);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString() !== from ||
    new Date(end).toISOString() !== until ||
    end <= start ||
    end - start > MAX_WINDOW_DAYS * 86_400_000
  ) {
    throw new ProviderMeterError("window_invalid");
  }
}

function sumGroups(value: unknown, namespaceId: string, field: string): number {
  const groups = array(value, MAX_GROUPS);
  // Reaching the API limit could mean the returned sum is incomplete.
  if (groups.length === MAX_GROUPS) throw new ProviderMeterError("upstream_invalid");
  return groups.reduce<number>((total, candidate) => {
    const group = record(candidate);
    if (record(group.dimensions).namespaceId !== namespaceId) {
      throw new ProviderMeterError("upstream_invalid");
    }
    const sum = record(group.sum);
    const quantity = field === "duration" ? nonnegativeFinite(sum[field]) : safeCount(sum[field]);
    const next = total + quantity;
    if (!Number.isFinite(next) || (field !== "duration" && !Number.isSafeInteger(next))) {
      throw new ProviderMeterError("upstream_invalid");
    }
    return next;
  }, 0);
}

function safeCount(value: unknown): number {
  const parsed =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SAFE_COUNT) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return parsed;
}

function nonnegativeFinite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return value;
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
    throw new TypeError("invalid Cloudflare Actor metric reader configuration");
  }
  return value;
}

const QUERY = `query TakoserverActorNamespaceMetrics($accountTag: string!, $namespaceId: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { namespaceId: $namespaceId, datetime_geq: $start, datetime_lt: $end }) {
      dimensions { namespaceId }
      sum { requests }
    }
    durableObjectsPeriodicGroups(limit: 10000, filter: { namespaceId: $namespaceId, datetime_geq: $start, datetime_lt: $end }) {
      dimensions { namespaceId }
      sum { duration rowsRead rowsWritten }
    }
  } }
}`;
