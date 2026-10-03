import { readFileSync, writeFileSync } from "node:fs";

export interface QueueEventTarget {
  readonly origin: string;
  readonly pathname: string;
  readonly method: string;
  readonly host: string | null;
}

export const SELFHOST_QUEUE_EVENT_PATH =
  "/.well-known/takoserver/managed-worker-events/v1" as const;
const WORKER_EVENTS_HOST_SUFFIX = ".selfhost-events.invalid";
// URL.origin omits the explicit default port 443 used by workerd-runtime.
const WORKERD_ORIGIN = "https://127.0.0.1";

function isWorkerEventsHost(host: string | null): host is string {
  return (
    typeof host === "string" &&
    host.endsWith(WORKER_EVENTS_HOST_SUFFIX) &&
    /^[a-z0-9][a-z0-9_-]{0,127}\.selfhost-events\.invalid$/u.test(host)
  );
}

export function shouldInterceptQueueEvent(target: QueueEventTarget): boolean {
  return (
    target.origin === WORKERD_ORIGIN &&
    target.pathname === SELFHOST_QUEUE_EVENT_PATH &&
    target.method === "POST" &&
    isWorkerEventsHost(target.host)
  );
}

export interface QueueEventMessage {
  readonly messageId: string;
  readonly attempts: number;
}

export interface QueueEventProxyObservation {
  readonly messageId: string;
  readonly attempts: number;
  readonly status: number;
  readonly acknowledged: boolean;
  readonly withheld: boolean;
}

export interface QueueEventProxySnapshot {
  readonly receivedCount: number;
  readonly observations: readonly QueueEventProxyObservation[];
}

export interface QueueEventProxyOptions {
  readonly upstreamOrigin: string;
  readonly upstreamCa: string;
  readonly upstreamFetch?: QueueEventProxyFetch;
  readonly withholdFirstAcknowledgement?: boolean;
}

export type QueueEventProxyFetch = (
  input: RequestInfo | URL,
  init?: BunFetchRequestInit,
) => Promise<Response>;

export interface QueueEventProxy {
  handle(request: Request): Promise<Response>;
  snapshot(): QueueEventProxySnapshot;
}

export function readQueueEventMessages(body: string): readonly QueueEventMessage[] {
  if (body.length > 1_048_576) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return [];
  const messages: QueueEventMessage[] = [];
  for (const entry of parsed.messages) {
    if (
      !isRecord(entry) ||
      typeof entry.messageId !== "string" ||
      entry.messageId.length < 1 ||
      entry.messageId.length > 128 ||
      !Number.isSafeInteger(entry.attempts) ||
      (entry.attempts as number) < 1
    ) {
      return [];
    }
    messages.push({ messageId: entry.messageId, attempts: entry.attempts as number });
  }
  return messages;
}

export function isAcknowledgedQueueResponse(
  status: number,
  body: string,
  messageId: string,
): boolean {
  if (status !== 200 || body.length > 65_536) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (
    !isRecord(parsed) ||
    parsed.protocol !== "takoserver.managed-worker-event@v1" ||
    parsed.kind !== "queue" ||
    !Array.isArray(parsed.decisions) ||
    parsed.decisions.length !== 1
  ) {
    return false;
  }
  const [decision] = parsed.decisions;
  return (
    isRecord(decision) &&
    decision.messageId === messageId &&
    decision.outcome === "ack" &&
    Object.keys(decision).length === 2
  );
}

/**
 * The response-loss fixture's exact event forwarding seam.
 *
 * Receipt and completed-response observations are intentionally separate:
 * the former proves the exact route matched, while the latter proves upstream
 * TLS, handler completion, and ACK parsing all returned.
 */
export function createQueueEventProxy(options: QueueEventProxyOptions): QueueEventProxy {
  const upstreamFetch =
    options.upstreamFetch ?? (globalThis.fetch.bind(globalThis) as QueueEventProxyFetch);
  const upstreamServerName = new URL(options.upstreamOrigin).hostname;
  const withholdFirstAcknowledgement = options.withholdFirstAcknowledgement !== false;
  const observations: QueueEventProxyObservation[] = [];
  let receivedCount = 0;
  let firstAcknowledgementWithheld = false;

  return {
    async handle(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/__test/status") {
        return Response.json({ receivedCount, observations });
      }
      if (
        request.method !== "POST" ||
        url.pathname !== SELFHOST_QUEUE_EVENT_PATH ||
        !isWorkerEventsHost(request.headers.get("host"))
      ) {
        return new Response(null, { status: 404 });
      }
      receivedCount += 1;
      const bodyBytes = await request.arrayBuffer();
      const body = new TextDecoder().decode(bodyBytes);
      const [message] = readQueueEventMessages(body);
      if (!message) return new Response(null, { status: 400 });
      const response = await upstreamFetch(
        `${options.upstreamOrigin}${url.pathname}${url.search}`,
        {
          method: "POST",
          headers: request.headers,
          body: bodyBytes,
          tls: {
            ca: options.upstreamCa,
            rejectUnauthorized: true,
            serverName: upstreamServerName,
          },
        },
      );
      const responseBody = await response.text();
      const acknowledged = isAcknowledgedQueueResponse(
        response.status,
        responseBody,
        message.messageId,
      );
      const withheld =
        withholdFirstAcknowledgement && acknowledged && !firstAcknowledgementWithheld;
      observations.push({
        messageId: message.messageId,
        attempts: message.attempts,
        status: response.status,
        acknowledged,
        withheld,
      });
      if (withheld) {
        firstAcknowledgementWithheld = true;
        // The test stops the Host process while its HTTP response is still
        // pending. It never fabricates an ACK or writes queue state itself.
        await new Promise<void>(() => {});
      }
      return new Response(responseBody, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      });
    },
    snapshot() {
      return {
        receivedCount,
        observations: observations.map((observation) => ({ ...observation })),
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const mode = process.env.TAKOSERVER_QUEUE_RESTART_FIXTURE_MODE;

if (mode === "preload") {
  const proxyOrigin = process.env.TAKOSERVER_QUEUE_RESTART_PROXY_ORIGIN;
  if (!proxyOrigin || new URL(proxyOrigin).origin !== proxyOrigin) {
    throw new Error("queue response-loss proxy origin is not configured");
  }
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let target: URL;
    try {
      target = new URL(input instanceof Request ? input.url : input.toString());
    } catch {
      return originalFetch(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, name) => {
        headers.set(name, value);
      });
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      !shouldInterceptQueueEvent({
        origin: target.origin,
        pathname: target.pathname,
        method: method.toUpperCase(),
        host: headers.get("host"),
      })
    ) {
      return originalFetch(input, init);
    }
    if (input instanceof Request && init?.body === undefined) {
      throw new Error("queue response-loss proxy requires the original request body in init");
    }
    const proxyUrl = new URL(`${target.pathname}${target.search}`, proxyOrigin);
    return originalFetch(proxyUrl, init);
  }) as typeof fetch;
}

if (mode === "proxy") {
  const readyFile = process.env.TAKOSERVER_QUEUE_RESTART_PROXY_READY_FILE;
  const upstreamOrigin = process.env.TAKOSERVER_QUEUE_RESTART_UPSTREAM_ORIGIN;
  const upstreamCaFile = process.env.TAKOSERVER_QUEUE_RESTART_UPSTREAM_CA_FILE;
  if (
    !readyFile ||
    !upstreamCaFile ||
    upstreamOrigin !== WORKERD_ORIGIN ||
    new URL(upstreamOrigin).origin !== upstreamOrigin
  ) {
    throw new Error("queue response-loss proxy fixture configuration is invalid");
  }
  const proxy = createQueueEventProxy({
    upstreamOrigin,
    upstreamCa: readFileSync(upstreamCaFile, "utf8"),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => proxy.handle(request),
  });
  writeFileSync(readyFile, String(server.port), { mode: 0o600 });
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
}
