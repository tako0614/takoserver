import { type ClientRequest, type IncomingMessage, request } from "node:http";
import { isIP } from "node:net";
import { isContainerHealthPath } from "../takoform-v2/forms/container.ts";

const failure = (code = "unavailable") => new Error(`linux_oci_http_health_${code}`);

function peerFamily(address: string): 4 | 6 {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [first, second, , last] = octets;
    if (
      first !== undefined &&
      second !== undefined &&
      last !== undefined &&
      (first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)) &&
      last % 2 === 1
    )
      return 4;
  }
  if (
    family === 6 &&
    address.startsWith("fd") &&
    !address.includes("%") &&
    !address.includes(".") &&
    /[13579bdf]$/u.test(address) &&
    new URL(`http://[${address}]/`).hostname === `[${address}]`
  )
    return 6;
  throw failure("invalid_request");
}

/** One real HTTP exchange, not an owned-native or readiness authority.
 * The original creator must separately prove this exact peer/service belongs
 * to its current accepted generation before and after using the status fact.
 * No callback, DNS name, redirect, proxy, header or alternate target is accepted.
 */
export function createLinuxOciHttpHealthProbe(options: {
  readonly address: string;
  readonly httpPort: number;
  readonly healthPath: string;
  readonly timeoutMs?: number;
}) {
  const { address, httpPort, healthPath } = options;
  const family = typeof address === "string" ? peerFamily(address) : undefined;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    family === undefined ||
    !Number.isInteger(httpPort) ||
    httpPort < 1 ||
    httpPort > 65535 ||
    !isContainerHealthPath(healthPath) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw failure("invalid_request");
  let attempted = false,
    active = false,
    closed = false,
    requestClosed = false,
    responseClosed = false,
    requestDestroySent = false,
    responseDestroySent = false;
  let originalRequest: ClientRequest | undefined, originalResponse: IncomingMessage | undefined;
  const joinWaiters = new Set<() => void>();
  const joined = () =>
    originalRequest === undefined ||
    (requestClosed && (originalResponse === undefined || responseClosed));
  const notify = () => {
    for (const check of [...joinWaiters]) check();
  };
  const destroyOriginal = () => {
    if (originalResponse && !responseClosed && !responseDestroySent) {
      responseDestroySent = true;
      originalResponse.destroy();
    }
    if (originalRequest && !requestClosed && !requestDestroySent) {
      requestDestroySent = true;
      originalRequest.destroy();
    }
  };
  function waitOriginal(
    milliseconds: number,
    expired: () => void,
    includeActive = false,
  ): Promise<void> {
    const complete = () => joined() && (!includeActive || !active);
    if (complete()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (!complete()) return;
        clearTimeout(timer);
        joinWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(() => {
        joinWaiters.delete(finish);
        expired();
        reject(failure("custody_retained"));
      }, milliseconds);
      joinWaiters.add(finish);
      notify();
    });
  }
  return Object.freeze({
    async observe(signal: AbortSignal): Promise<{ readonly statusCode: number }> {
      if (attempted || closed) throw failure("already_attempted");
      attempted = true;
      if (signal.aborted) throw failure();
      // Register before the raw constructor; even synchronous reentry into
      // close cannot observe an empty collection and miss this scope.
      active = true;
      let refused = false,
        statusCode: number | undefined;
      const refuse = () => {
        refused = true;
        destroyOriginal();
      };
      try {
        originalRequest = request({
          protocol: "http:",
          hostname: address,
          family,
          port: httpPort,
          path: healthPath,
          method: "GET",
          agent: false,
          maxHeaderSize: 8192,
          headers: { Connection: "close" },
        });
        originalRequest.once("error", refuse);
        originalRequest.once("close", () => {
          requestClosed = true;
          if (!originalResponse) refused = true;
          notify();
        });
        originalRequest.once("response", (response: IncomingMessage) => {
          originalResponse = response;
          response.once("error", refuse);
          response.once("close", () => {
            responseClosed = true;
            notify();
          });
          statusCode = response.statusCode;
          if (statusCode === undefined || statusCode < 200 || statusCode >= 300) refused = true;
          // A status-only probe consumes no body. Success still waits for both
          // actual close events; destroy/timeout is never a joined receipt.
          destroyOriginal();
        });
        signal.addEventListener("abort", refuse, { once: true });
        if (signal.aborted || closed) refuse();
        if (!refused) originalRequest.end();
        await waitOriginal(timeoutMs, refuse);
        if (closed || signal.aborted || refused || statusCode === undefined) throw failure();
        return Object.freeze({ statusCode });
      } catch {
        refuse();
        throw failure();
      } finally {
        signal.removeEventListener("abort", refuse);
        active = false;
        notify();
      }
    },
    async close(): Promise<void> {
      closed = true;
      // A failed bounded join keeps the same original objects. A later close
      // only joins their actual settlement; it never sends another request.
      destroyOriginal();
      await waitOriginal(Math.min(timeoutMs, 1000), () => undefined, true);
    },
  });
}
