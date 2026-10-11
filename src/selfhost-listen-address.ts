import { isIPv4, isIPv6 } from "node:net";

/** The variable an operator sets to choose the API listener's interface. */
export const SELFHOST_LISTEN_HOST_VARIABLE = "TAKOSERVER_LISTEN_HOST";

/**
 * Loopback by default.
 *
 * The API listener speaks plain HTTP, while `TAKOSERVER_PUBLIC_ORIGIN` must be
 * HTTPS, so a TLS-terminating reverse proxy already stands in front of every
 * real deployment. Listening on every interface only added a second, plaintext
 * way in that bypasses that proxy, its TLS and whatever request limits it
 * enforces. A proxy on another machine or in another network namespace names
 * the interface explicitly, for example `0.0.0.0` or `::`.
 */
export const SELFHOST_DEFAULT_LISTEN_HOST = "127.0.0.1";

/**
 * The interface address the API listener binds.
 *
 * Only canonical IP literals are accepted. A name is resolved by the runtime to
 * whichever single address comes first (`localhost` binds only `::1` under
 * Bun), so the interface an operator meant and the one bound would differ
 * silently; a port, brackets or surrounding space is a different setting
 * written into this one.
 */
export function parseSelfhostListenHost(value: string | undefined): string {
  if (value === undefined) return SELFHOST_DEFAULT_LISTEN_HOST;
  // `isIPv4` already refuses leading zeros and short forms; an IPv6 literal
  // additionally has to be in the one spelling a URL would print.
  if (isIPv4(value) || isCanonicalIPv6(value)) return value;
  throw new TypeError(
    `${SELFHOST_LISTEN_HOST_VARIABLE} must be one canonical IPv4 or IPv6 interface address ` +
      `(for example 127.0.0.1, 0.0.0.0, ::1 or ::), without brackets or a port; ` +
      `it is ${JSON.stringify(value)}`,
  );
}

/** `host:port` as a client dials it, bracketing IPv6. */
export function formatSelfhostListenAddress(host: string, port: number): string {
  return isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}

function isCanonicalIPv6(value: string): boolean {
  if (!isIPv6(value)) return false;
  try {
    // WHATWG URL serializes an IPv6 host in its RFC 5952 canonical form.
    return new URL(`http://[${value}]/`).hostname === `[${value}]`;
  } catch {
    return false;
  }
}
