import type { ProviderMeterDeployment } from "../provider-meter-port.ts";
import { array, ProviderMeterError, record } from "./provider-meter.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const MAX_WINDOW_DAYS = 31;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 262_144;
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
  readonly finality: "unfinalized";
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
  /** Local transport deadline only; it makes no claim about analytics finality. */
  readonly timeoutMs?: number;
}) {
  const accountId = bounded(options.accountId, 1, 128);
  const apiToken = bounded(options.apiToken, 3, 4_096);
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("invalid Cloudflare Actor metric reader configuration");
  }

  return {
    async read(input: {
      readonly deployment: ProviderMeterDeployment;
      readonly from: string;
      readonly until: string;
      readonly signal?: AbortSignal;
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
      const root = record(
        await requestJson({
          body,
          apiToken,
          send,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          timeoutMs,
        }),
      );
      if (Object.hasOwn(root, "errors")) {
        if (root.errors !== null) {
          if (!Array.isArray(root.errors)) throw new ProviderMeterError("upstream_invalid");
          if (root.errors.length > 0) throw new ProviderMeterError("upstream_unavailable");
        }
      }
      const accounts = array(record(record(root.data).viewer).accounts, 1);
      if (accounts.length !== 1) throw new ProviderMeterError("upstream_invalid");
      const account = record(accounts[0]);
      const requests = namespaceGroup(account.durableObjectsInvocationsAdaptiveGroups, namespaceId);
      const periodic = namespaceGroup(account.durableObjectsPeriodicGroups, namespaceId);

      return {
        namespaceId,
        window: { from: input.from, until: input.until },
        finality: "unfinalized",
        requests: {
          value: requests === null ? 0 : safeCount(record(requests.sum).requests),
          unit: "requests",
        },
        duration: {
          value: periodic === null ? 0 : nonnegativeFinite(record(periodic.sum).duration),
          unit: "GB*s",
        },
        rowsRead: {
          value: periodic === null ? 0 : safeCount(record(periodic.sum).rowsRead),
          unit: "rows",
        },
        rowsWritten: {
          value: periodic === null ? 0 : safeCount(record(periodic.sum).rowsWritten),
          unit: "rows",
        },
      };
    },
  };
}

async function requestJson(input: {
  readonly body: ActorAnalyticsRequest;
  readonly apiToken: string;
  readonly send: (request: Request) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<unknown> {
  if (input.signal?.aborted) throw new ProviderMeterError("upstream_unavailable");

  const controller = new AbortController();
  let response: Response | undefined;
  let stopped = false;
  let rejectInterrupted: (error: ProviderMeterError) => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    if (response?.body) void response.body.cancel().catch(() => undefined);
    rejectInterrupted(new ProviderMeterError("upstream_unavailable"));
  };
  const onCallerAbort = () => stop();
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(stop, input.timeoutMs);

  const operation = (async () => {
    try {
      response = await input.send(
        new Request(GRAPHQL_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${input.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input.body),
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) {
        if (response.body) void response.body.cancel().catch(() => undefined);
        throw new ProviderMeterError("upstream_unavailable");
      }
      return await boundedActorJson(response, controller.signal);
    } catch (error) {
      if (error instanceof ProviderMeterError) throw error;
      throw new ProviderMeterError("upstream_unavailable");
    }
  })();

  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}

async function boundedActorJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new ProviderMeterError("upstream_unavailable");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const part = await readActorBodyPart(reader, signal);
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ProviderMeterError("upstream_invalid");
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ProviderMeterError) throw error;
    if (signal.aborted) throw new ProviderMeterError("upstream_unavailable");
    throw new ProviderMeterError("upstream_unavailable");
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A hostile/injected stream may still have a pending read after cancellation.
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ProviderMeterError("upstream_invalid");
  }
}

type ActorBodyPart = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

function readActorBodyPart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ActorBodyPart> {
  if (signal.aborted) {
    void reader.cancel().catch(() => undefined);
    return Promise.reject(new ProviderMeterError("upstream_unavailable"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProviderMeterError("upstream_unavailable"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
      (part) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(part);
      },
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new ProviderMeterError("upstream_unavailable"));
      },
    );
  });
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

function namespaceGroup(value: unknown, namespaceId: string): Record<string, unknown> | null {
  // `Groups` results group by selected dimensions. Filtering and grouping on
  // one namespace must produce at most one row; duplicates are an ambiguity.
  const groups = array(value, 1);
  if (groups.length === 0) return null;
  const group = record(groups[0]);
  if (record(group.dimensions).namespaceId !== namespaceId) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return group;
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
    durableObjectsInvocationsAdaptiveGroups(limit: 2, filter: { namespaceId: $namespaceId, datetime_geq: $start, datetime_lt: $end }) {
      dimensions { namespaceId }
      sum { requests }
    }
    durableObjectsPeriodicGroups(limit: 2, filter: { namespaceId: $namespaceId, datetime_geq: $start, datetime_lt: $end }) {
      dimensions { namespaceId }
      sum { duration rowsRead rowsWritten }
    }
  } }
}`;
