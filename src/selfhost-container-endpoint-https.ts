import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import type { SelfhostContainerEndpointHttpsIngressPort } from "./providers/selfhost-container-endpoint.ts";
import { SELFHOST_CONTAINER_ENDPOINT_HTTPS_INGRESS_BRAND } from "./providers/selfhost-container-endpoint.ts";

export type { SelfhostContainerEndpointHttpsIngressPort } from "./providers/selfhost-container-endpoint.ts";

export const SELFHOST_CONTAINER_ENDPOINT_HTTPS_ENVIRONMENT = Object.freeze({
  suffix: "TAKOSERVER_SELFHOST_CONTAINER_ENDPOINT_SUFFIX",
});

export interface SelfhostContainerEndpointHttpsConfiguration {
  readonly configuredSuffix: string;
  readonly publicOrigin: string;
  readonly port: 443;
}

export interface SelfhostContainerEndpointHttpsListener {
  readonly ingress: SelfhostContainerEndpointHttpsIngressPort;
  installEndpointFetch(fetch: (request: Request) => Response | Promise<Response>): void;
  close(closeActiveConnections?: boolean): Promise<void>;
}

interface ListenerServer {
  readonly port: number | undefined;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface SelfhostContainerEndpointHttpsFactories {
  readonly serve: (options: {
    readonly port: 443;
    readonly hostname: "0.0.0.0";
    readonly tls: { readonly cert: string; readonly key: string };
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => ListenerServer;
  readonly proveSni: (input: {
    readonly host: string;
    readonly port: number;
    readonly suffix: string;
    readonly certificateChain: string;
  }) => Promise<void>;
}

export function createSelfhostContainerEndpointHttpsDispatch(
  endpointFetch: (request: Request) => Promise<Response | null>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await endpointFetch(request);
    return response ?? new Response(null, { status: 404, headers: NO_STORE_HEADERS });
  };
}

const SPECIMEN_LABEL = `ce-${"0".repeat(40)}`;
const NO_STORE_HEADERS = { "cache-control": "no-store" };

function canonicalSuffix(value: string): string {
  const suffix = value.trim().toLowerCase();
  if (!suffix) {
    throw new TypeError(
      `${SELFHOST_CONTAINER_ENDPOINT_HTTPS_ENVIRONMENT.suffix} must be a DNS suffix`,
    );
  }
  if (
    suffix.length > 253 ||
    suffix.endsWith(".") ||
    suffix.includes(":") ||
    suffix.includes("/") ||
    suffix.includes("*") ||
    suffix.includes("_") ||
    suffix === "localhost" ||
    suffix.endsWith(".localhost") ||
    /^\d+(?:\.\d+){3}$/u.test(suffix)
  ) {
    throw new TypeError(
      `${SELFHOST_CONTAINER_ENDPOINT_HTTPS_ENVIRONMENT.suffix} must be a DNS suffix`,
    );
  }
  const labels = suffix.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new TypeError(
      `${SELFHOST_CONTAINER_ENDPOINT_HTTPS_ENVIRONMENT.suffix} must be a DNS suffix`,
    );
  }
  return suffix;
}

export function parseSelfhostContainerEndpointHttpsConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  input: {
    readonly containerRuntimeConfigured: boolean;
    readonly controlPort: number;
    readonly workerdPort: number;
    readonly workerEndpointPort: number;
  },
): SelfhostContainerEndpointHttpsConfiguration | undefined {
  const configured = environment[SELFHOST_CONTAINER_ENDPOINT_HTTPS_ENVIRONMENT.suffix];
  if (configured === undefined) return undefined;
  const suffix = canonicalSuffix(configured);
  if (!input.containerRuntimeConfigured) {
    throw new TypeError("Container Endpoint HTTPS requires the opt-in self-host Container runtime");
  }
  if (input.controlPort === 443 || input.workerdPort === 443 || input.workerEndpointPort === 443) {
    throw new TypeError(
      "Container HTTPS cannot share the Bun control or Workerd listener, or front Worker endpoints on TCP 443",
    );
  }
  return {
    configuredSuffix: suffix,
    publicOrigin: `https://${suffix}`,
    port: 443,
  };
}

function specimenHostname(suffix: string): string {
  return `${SPECIMEN_LABEL}.${suffix}`;
}

function checkedLeaf(
  certificateChain: string,
  privateKey: string,
  suffix: string,
): X509Certificate {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificateChain);
  } catch {
    throw new TypeError("Container HTTPS certificate is invalid");
  }
  let keyPublic: string;
  try {
    keyPublic = createPublicKey(createPrivateKey(privateKey))
      .export({ type: "spki", format: "der" })
      .toString("base64");
  } catch {
    throw new TypeError("Container HTTPS private key is invalid");
  }
  const certificatePublic = certificate.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  if (certificatePublic !== keyPublic)
    throw new TypeError("Container HTTPS certificate and private key do not match");
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new TypeError("Container HTTPS certificate is not currently valid");
  }
  const wildcardSan = certificate.subjectAltName
    ?.split(/,\s*/u)
    .some((entry) => entry.toLowerCase() === `dns:*.${suffix}`);
  if (!wildcardSan || !certificate.checkHost(specimenHostname(suffix))) {
    throw new TypeError(
      "Container HTTPS certificate must cover the one-label Endpoint hostname wildcard",
    );
  }
  return certificate;
}

export function validateSelfhostContainerEndpointHttpsCertificate(input: {
  readonly configuredSuffix: string;
  readonly certificateChain: string;
  readonly privateKey: string;
}): void {
  const suffix = canonicalSuffix(input.configuredSuffix);
  checkedLeaf(input.certificateChain, input.privateKey, suffix);
}

/**
 * Performs the local SNI handshake used by the listener owner. It checks the
 * presented leaf against the operator-supplied chain; this proves neither DNS
 * ownership nor public trust or reachability.
 */
export function verifySelfhostContainerEndpointHttpsHandshake(input: {
  readonly host: string;
  readonly port: number;
  readonly suffix: string;
  readonly certificateChain: string;
}): Promise<void> {
  const suffix = canonicalSuffix(input.suffix);
  const expected = new X509Certificate(input.certificateChain).fingerprint256;
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: input.host,
      port: input.port,
      servername: specimenHostname(suffix),
      rejectUnauthorized: false,
    });
    socket.setTimeout(2_000, () => socket.destroy(new Error("TLS handshake timed out")));
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate(true).raw;
      const fingerprint = peer ? new X509Certificate(peer).fingerprint256 : undefined;
      socket.end();
      if (fingerprint !== expected)
        reject(new TypeError("Container HTTPS listener did not serve the configured certificate"));
      else resolve();
    });
    socket.once("error", (error) =>
      reject(new TypeError(`Container HTTPS local TLS handshake failed: ${error.message}`)),
    );
  });
}

const defaultFactories: SelfhostContainerEndpointHttpsFactories = {
  serve: (options) => Bun.serve(options),
  proveSni: verifySelfhostContainerEndpointHttpsHandshake,
};

export async function createSelfhostContainerEndpointHttpsListener(input: {
  readonly configuration: SelfhostContainerEndpointHttpsConfiguration;
  readonly certificateChain: string;
  readonly privateKey: string;
  readonly factories?: SelfhostContainerEndpointHttpsFactories;
}): Promise<SelfhostContainerEndpointHttpsListener> {
  const suffix = canonicalSuffix(input.configuration.configuredSuffix);
  if (
    input.configuration.port !== 443 ||
    input.configuration.publicOrigin !== `https://${suffix}`
  ) {
    throw new TypeError("Container HTTPS listener requires its canonical fixed-443 configuration");
  }
  checkedLeaf(input.certificateChain, input.privateKey, suffix);
  const factories = input.factories ?? defaultFactories;
  let endpointFetch: ((request: Request) => Response | Promise<Response>) | undefined;
  let active = false;
  let inFlightResponses = 0;
  const drainWaiters = new Set<() => void>();
  const responseDrained = () => {
    inFlightResponses--;
    if (inFlightResponses === 0) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    }
  };
  const waitForResponsesToDrain = () =>
    inFlightResponses === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => drainWaiters.add(resolve));
  const server = factories.serve({
    port: 443,
    hostname: "0.0.0.0",
    tls: { cert: input.certificateChain, key: input.privateKey },
    fetch: async (request) => {
      if (!active || !endpointFetch)
        return new Response(null, { status: 503, headers: NO_STORE_HEADERS });
      inFlightResponses++;
      let responseReleased = false;
      const releaseResponse = () => {
        if (responseReleased) return;
        responseReleased = true;
        responseDrained();
      };
      try {
        const response = await endpointFetch(request);
        if (!response.body) {
          releaseResponse();
          return response;
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read();
              if (result.done) {
                controller.close();
                releaseResponse();
              } else {
                controller.enqueue(result.value);
              }
            } catch {
              controller.error(new Error("Container HTTPS response body failed"));
              releaseResponse();
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              releaseResponse();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        releaseResponse();
        return new Response(null, { status: 503, headers: NO_STORE_HEADERS });
      }
    },
  });
  if (server.port !== 443) {
    await server.stop(true);
    throw new TypeError("Container HTTPS listener did not bind the required TCP port 443");
  }

  try {
    await factories.proveSni({
      host: "127.0.0.1",
      port: server.port,
      suffix,
      certificateChain: input.certificateChain,
    });
  } catch (error) {
    await server.stop(true);
    throw error;
  }

  active = true;
  const ingress = Object.freeze({
    [SELFHOST_CONTAINER_ENDPOINT_HTTPS_INGRESS_BRAND]: true,
    configuredSuffix: suffix,
    publicOrigin: `https://${suffix}`,
    port: 443,
    assertServing() {
      if (!active || server.port !== 443)
        throw new Error("Container Endpoint HTTPS ingress is not serving");
    },
  } satisfies SelfhostContainerEndpointHttpsIngressPort);
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let closeResolve: (() => void) | undefined;
  let closeReject: ((error: unknown) => void) | undefined;
  let closeMode: "force" | "graceful" | undefined;
  let gracefulStopCompleted = false;
  let closeCompletionRequested = false;
  let closeSettled = false;

  const beginClose = (closeActiveConnections: boolean) => {
    gracefulStopCompleted = false;
    closeCompletionRequested = false;
    closeSettled = false;
    closeMode = closeActiveConnections ? "force" : "graceful";
    const completion = new Promise<void>((resolve, reject) => {
      closeResolve = resolve;
      closeReject = reject;
    });
    closePromise = completion;
    void completion.then(
      () => {
        if (closePromise === completion) closeSettled = true;
      },
      () => {
        if (closePromise !== completion) return;
        closePromise = undefined;
        closeResolve = undefined;
        closeReject = undefined;
        closeMode = undefined;
        gracefulStopCompleted = false;
        closeCompletionRequested = false;
        closeSettled = false;
      },
    );
    return completion;
  };

  const stop = (closeActiveConnections: boolean) => {
    try {
      return Promise.resolve(server.stop(closeActiveConnections));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const finishGracefulClose = () => {
    if (closeMode !== "graceful" || !gracefulStopCompleted || inFlightResponses !== 0) return;
    closeCompletionRequested = true;
    closeResolve?.();
  };

  return {
    ingress,
    installEndpointFetch(fetch) {
      if (!active || closed) throw new Error("Container Endpoint HTTPS listener is closed");
      if (endpointFetch)
        throw new Error("Container Endpoint HTTPS fetch handler is already installed");
      endpointFetch = fetch;
    },
    close(closeActiveConnections = true) {
      closed = true;
      active = false;
      if (closePromise) {
        if (
          closeActiveConnections &&
          closeMode === "graceful" &&
          !closeSettled &&
          !closeCompletionRequested
        ) {
          closeMode = "force";
          void stop(true).then(
            () => {
              closeCompletionRequested = true;
              closeResolve?.();
            },
            (error) => closeReject?.(error),
          );
        }
        return closePromise;
      }

      const completion = beginClose(closeActiveConnections);
      if (closeActiveConnections) {
        void stop(true).then(
          () => {
            closeCompletionRequested = true;
            closeResolve?.();
          },
          (error) => closeReject?.(error),
        );
      } else {
        void stop(false).then(
          () => {
            if (closeMode !== "graceful") return;
            gracefulStopCompleted = true;
            void waitForResponsesToDrain().then(finishGracefulClose, (error) =>
              closeReject?.(error),
            );
          },
          (error) => {
            if (closeMode === "graceful") closeReject?.(error);
          },
        );
      }
      return completion;
    },
  };
}

/**
 * Bind only when entry preflight has found the exact supported Form pair.
 * Missing Form support is an unavailable capability, not a reason to open an
 * unrelated public listener.
 */
export async function createSelfhostContainerEndpointHttpsListenerIfSupported(input: {
  readonly configuration: SelfhostContainerEndpointHttpsConfiguration | undefined;
  readonly containerRuntimeConfigured: boolean;
  readonly exactCandidatePair: boolean;
  readonly certificateChain?: string;
  readonly privateKey?: string;
  readonly factories?: SelfhostContainerEndpointHttpsFactories;
}): Promise<SelfhostContainerEndpointHttpsListener | undefined> {
  if (!input.configuration) return undefined;
  if (!input.containerRuntimeConfigured) {
    throw new TypeError("Container Endpoint HTTPS requires the opt-in self-host Container runtime");
  }
  if (!input.exactCandidatePair) return undefined;
  if (!input.certificateChain || !input.privateKey) {
    throw new TypeError(
      "Container Endpoint HTTPS requires the existing Worker TLS certificate and key material",
    );
  }
  return createSelfhostContainerEndpointHttpsListener({
    configuration: input.configuration,
    certificateChain: input.certificateChain,
    privateKey: input.privateKey,
    ...(input.factories ? { factories: input.factories } : {}),
  });
}
