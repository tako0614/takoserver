import {
  validateWildcardEndpointCertificate,
  verifyLocalEndpointHttpsSni,
} from "./selfhost-endpoint-https-tls.ts";
import type {
  V2EndpointRouteAbsenceObservation,
  V2EndpointTlsObservation,
} from "./takoform-v2/worker-endpoint-backend.ts";

const NO_STORE_HEADERS = { "cache-control": "no-store" };
const HTTPS_PORT = 443;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

export interface SelfhostV2WorkerEndpointHttpsConfiguration {
  readonly workerEndpointSuffix: string;
  readonly port: 443;
}

interface ListenerServer {
  readonly port: number | undefined;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface SelfhostV2WorkerEndpointHttpsFactories {
  readonly serve: (options: {
    readonly port: 443;
    readonly hostname: "0.0.0.0";
    readonly tls: { readonly cert: string; readonly key: string };
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => ListenerServer;
  readonly proveSni: (input: {
    readonly host: string;
    readonly port: number;
    readonly hostname: string;
    readonly certificateChain: string;
  }) => Promise<void>;
}

export interface SelfhostV2WorkerEndpointHttpsListener {
  readonly witness: {
    observeTls(input: WorkerEndpointAddress): Promise<V2EndpointTlsObservation>;
    observeRouteAbsent(input: WorkerEndpointAddress): Promise<V2EndpointRouteAbsenceObservation>;
  };
  close(closeActiveConnections?: boolean): Promise<void>;
}

// Derive the address from the existing exact Endpoint observation contract;
// this listener does not create a second address identity.
type WorkerEndpointAddress = Omit<V2EndpointTlsObservation, "ready">;

function canonicalSuffix(value: string): string {
  if (
    value !== value.toLowerCase() ||
    value.endsWith(".") ||
    value.length > 253 ||
    !HOSTNAME_PATTERN.test(value) ||
    value.split(".").length < 2 ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    /^\d+(?:\.\d+){3}$/u.test(value)
  ) {
    throw new TypeError("Worker Endpoint HTTPS requires a canonical reserved DNS suffix");
  }
  return value;
}

function checkedLeaf(certificateChain: string, privateKey: string, suffix: string) {
  return validateWildcardEndpointCertificate({
    certificateChain,
    privateKey,
    suffix,
    specimenHostname: `tls-probe.${suffix}`,
    errors: {
      certificateInvalid: "Worker Endpoint HTTPS certificate is invalid",
      privateKeyInvalid: "Worker Endpoint HTTPS private key is invalid",
      keyMismatch: "Worker Endpoint HTTPS certificate and private key do not match",
      certificateNotCurrent: "Worker Endpoint HTTPS certificate is not currently valid",
      wildcardRequired: "Worker Endpoint HTTPS certificate must cover the configured wildcard",
    },
  });
}

function certificateIsCurrent(certificate: {
  readonly validFrom: string;
  readonly validTo: string;
}): boolean {
  const now = Date.now();
  const from = Date.parse(certificate.validFrom);
  const to = Date.parse(certificate.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && now >= from && now <= to;
}

function validAddress(
  input: WorkerEndpointAddress,
  suffix: string,
): WorkerEndpointAddress | undefined {
  const address: WorkerEndpointAddress = Object.freeze({
    endpointUid: input.endpointUid,
    workerUid: input.workerUid,
    hostname: input.hostname,
    url: input.url,
  });
  if (
    typeof address.endpointUid !== "string" ||
    !isSafeIdentifier(address.endpointUid) ||
    typeof address.workerUid !== "string" ||
    !isSafeIdentifier(address.workerUid) ||
    typeof address.hostname !== "string" ||
    address.hostname !== address.hostname.toLowerCase() ||
    !HOSTNAME_PATTERN.test(address.hostname) ||
    !address.hostname.endsWith(`.${suffix}`) ||
    address.hostname.slice(0, -(suffix.length + 1)).includes(".") ||
    address.url !== `https://${address.hostname}/`
  ) {
    return undefined;
  }
  return address;
}

function isSafeIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 256 || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function exactHost(request: Request, suffix: string): string | undefined {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  const hostname = url.hostname;
  const authority = request.headers.get("host");
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    hostname !== hostname.toLowerCase() ||
    !hostname.endsWith(`.${suffix}`) ||
    hostname.slice(0, -(suffix.length + 1)).includes(".") ||
    (authority !== hostname && authority !== `${hostname}:443`)
  ) {
    return undefined;
  }
  return hostname;
}

/**
 * Checks the live listener with the exact Endpoint hostname as TLS SNI. TLS
 * verification is intentionally local and self-signed/CA-neutral: this proves
 * only which certificate the configured local listener presents, not DNS,
 * public trust, or external reachability.
 */
export function verifySelfhostV2WorkerEndpointHttpsSni(input: {
  readonly host: string;
  readonly port: number;
  readonly hostname: string;
  readonly certificateChain: string;
}): Promise<void> {
  return verifyLocalEndpointHttpsSni({
    ...input,
    errors: {
      invalidCertificate: "Worker Endpoint HTTPS certificate is invalid",
      certificateMismatch: "Worker Endpoint HTTPS listener served a different certificate",
      handshakeFailed: () => "Worker Endpoint HTTPS local SNI handshake failed",
    },
  });
}

const defaultFactories: SelfhostV2WorkerEndpointHttpsFactories = {
  serve: (options) => Bun.serve(options),
  proveSni: verifySelfhostV2WorkerEndpointHttpsSni,
};

/**
 * Owns the shared self-host Worker Endpoint TLS listener. Routing remains the
 * adapter's stateless SQL-backed `fetch`; this listener never keeps a parallel
 * route registry. Its deletion witness requires the adapter's exact route
 * denial plus drained matching-host response bodies and current local TLS/SNI.
 * The adapter separately proves accepted SQL and native owner state.
 */
export async function createSelfhostV2WorkerEndpointHttpsListener(input: {
  readonly configuration: SelfhostV2WorkerEndpointHttpsConfiguration;
  readonly certificateChain: string;
  readonly privateKey: string;
  readonly fetch: (request: Request) => Promise<Response | null>;
  /** Same stateless SQL decision used by the frontend request dispatcher. */
  readonly routeDenies: (address: WorkerEndpointAddress) => Promise<boolean>;
  readonly factories?: SelfhostV2WorkerEndpointHttpsFactories;
}): Promise<SelfhostV2WorkerEndpointHttpsListener> {
  const suffix = canonicalSuffix(input.configuration.workerEndpointSuffix);
  if (input.configuration.port !== HTTPS_PORT) {
    throw new TypeError("Worker Endpoint HTTPS listener requires fixed TCP port 443");
  }
  const certificate = checkedLeaf(input.certificateChain, input.privateKey, suffix);
  const factories = input.factories ?? defaultFactories;
  let active = false;
  let closed = false;
  let server: ListenerServer;
  const inFlightByHostname = new Map<string, number>();
  const listenerCurrent = () => active && !closed && server.port === HTTPS_PORT;
  const inFlightCount = (hostname: string) => inFlightByHostname.get(hostname) ?? 0;
  const beginRequest = (hostname: string) => {
    inFlightByHostname.set(hostname, inFlightCount(hostname) + 1);
  };
  const finishRequest = (hostname: string) => {
    const remaining = inFlightCount(hostname) - 1;
    if (remaining <= 0) inFlightByHostname.delete(hostname);
    else inFlightByHostname.set(hostname, remaining);
  };

  function trackResponseBody(response: Response, hostname: string): Response {
    const body = response.body;
    if (!body) {
      finishRequest(hostname);
      return response;
    }
    const reader = body.getReader();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      finishRequest(hostname);
    };
    const trackedBody = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              finish();
              reader.releaseLock();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            // An errored read is not a proof that the native response source
            // stopped. Keep the request counted unless cancellation confirms it.
            controller.error(error);
            try {
              await reader.cancel(error);
              finish();
              reader.releaseLock();
            } catch {
              // Fail closed: route retirement remains blocked by this reader.
            }
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          finish();
          reader.releaseLock();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(trackedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  server = factories.serve({
    port: HTTPS_PORT,
    hostname: "0.0.0.0",
    tls: { cert: input.certificateChain, key: input.privateKey },
    fetch: async (request) => {
      if (!listenerCurrent()) return new Response(null, { status: 503, headers: NO_STORE_HEADERS });
      const hostname = exactHost(request, suffix);
      if (!hostname) return new Response(null, { status: 404, headers: NO_STORE_HEADERS });
      beginRequest(hostname);
      try {
        const response = await input.fetch(request);
        if (!response) {
          finishRequest(hostname);
          return new Response(null, { status: 404, headers: NO_STORE_HEADERS });
        }
        return trackResponseBody(response, hostname);
      } catch {
        finishRequest(hostname);
        return new Response(null, { status: 503, headers: NO_STORE_HEADERS });
      }
    },
  });
  if (server.port !== HTTPS_PORT) {
    await server.stop(true);
    throw new TypeError("Worker Endpoint HTTPS listener did not bind fixed TCP port 443");
  }

  async function proveCurrent(address: WorkerEndpointAddress): Promise<boolean> {
    const exact = validAddress(address, suffix);
    const initialServer = server;
    if (
      !exact ||
      !certificate.checkHost(exact.hostname) ||
      !listenerCurrent() ||
      !certificateIsCurrent(certificate)
    )
      return false;
    try {
      await factories.proveSni({
        host: "127.0.0.1",
        port: initialServer.port ?? HTTPS_PORT,
        hostname: exact.hostname,
        certificateChain: input.certificateChain,
      });
    } catch {
      return false;
    }
    return (
      server === initialServer &&
      listenerCurrent() &&
      certificateIsCurrent(certificate) &&
      validAddress(address, suffix) !== undefined &&
      certificate.checkHost(exact.hostname) !== undefined
    );
  }

  try {
    const specimen = `tls-probe.${suffix}`;
    await factories.proveSni({
      host: "127.0.0.1",
      port: server.port,
      hostname: specimen,
      certificateChain: input.certificateChain,
    });
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  active = true;

  let closePromise: Promise<void> | undefined;
  let closeMode: "force" | "graceful" | undefined;
  let closeReject: ((error: unknown) => void) | undefined;
  const stop = (force: boolean) => {
    try {
      return Promise.resolve(server.stop(force));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  return {
    witness: Object.freeze({
      async observeTls(address: WorkerEndpointAddress) {
        const exact = validAddress(address, suffix);
        const ready = exact ? await proveCurrent(exact) : false;
        return { ...(exact ?? address), ready };
      },
      async observeRouteAbsent(address: WorkerEndpointAddress) {
        const exact = validAddress(address, suffix);
        let absent = false;
        if (exact && listenerCurrent() && inFlightCount(exact.hostname) === 0) {
          try {
            const deniedBeforeProof = await input.routeDenies(exact);
            if (deniedBeforeProof === true && inFlightCount(exact.hostname) === 0) {
              const tlsCurrent = await proveCurrent(exact);
              if (tlsCurrent && inFlightCount(exact.hostname) === 0) {
                const deniedAfterProof = await input.routeDenies(exact);
                absent =
                  deniedAfterProof === true &&
                  inFlightCount(exact.hostname) === 0 &&
                  listenerCurrent();
              }
            }
          } catch {
            absent = false;
          }
        }
        return { ...(exact ?? address), absent };
      },
    }),
    close(closeActiveConnections = true) {
      if (closePromise) {
        if (closeActiveConnections && closeMode === "graceful") {
          closeMode = "force";
          void stop(true).catch((error) => closeReject?.(error));
        }
        return closePromise;
      }
      active = false;
      closed = true;
      closeMode = closeActiveConnections ? "force" : "graceful";
      closePromise = new Promise<void>((resolve, reject) => {
        closeReject = reject;
        void stop(closeActiveConnections).then(resolve, reject);
      });
      return closePromise;
    },
  };
}
