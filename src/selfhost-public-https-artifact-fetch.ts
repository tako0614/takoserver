import { lookup as systemLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

type Address = { address: string; family: number };

/** Test seams are code-only; the normal entry supplies none of them. */
export interface SelfhostPublicHttpsTransportOptions {
  readonly resolve?: (hostname: string) => Promise<readonly Address[]>;
  readonly port?: number;
  readonly ca?: string;
}

// Conservative special-purpose exclusions from the IANA IPv4/IPv6 registries
// (iana.org/assignments/iana-ipv4-special-registry and -ipv6-special-registry).
// Refuse even their globally reachable exception addresses: this is an artifact
// fetcher, not a general Internet client.
const IPV4_DENIED: readonly [number, number][] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc01fc400, 24],
  [0xc034c100, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc0af3000, 24],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function inIpv4Prefix(value: number, network: number, bits: number): boolean {
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const value =
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0;
  return !IPV4_DENIED.some(([network, bits]) => inIpv4Prefix(value, network, bits));
}

function ipv6Value(address: string): bigint | null {
  if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return null;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.reduce((value: bigint, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv6Prefix(value: bigint, prefix: bigint, bits: bigint): boolean {
  return value >> (128n - bits) === prefix >> (128n - bits);
}

function publicIpv6(address: string): boolean {
  const value = ipv6Value(address);
  if (value === null || !inIpv6Prefix(value, 0x20000000000000000000000000000000n, 3n)) return false;
  // IANA special-purpose ranges; refuse embedded/transition schemes even if
  // some instances are globally reachable. Unknown non-2000::/3 is refused.
  return ![
    [0x20010000000000000000000000000000n, 23n],
    [0x20010db8000000000000000000000000n, 32n],
    [0x20020000000000000000000000000000n, 16n],
    [0x2620004f800000000000000000000000n, 48n],
    [0x3fff0000000000000000000000000000n, 20n],
  ].some(([prefix, bits]) => inIpv6Prefix(value, prefix ?? 0n, bits ?? 0n));
}

/** Every answer must be public. A mixed DNS answer never reaches a socket. */
export function isPublicArtifactAddress(answer: Address): boolean {
  return answer.family === 4
    ? publicIpv4(answer.address)
    : answer.family === 6 && publicIpv6(answer.address);
}

async function resolveWhileNotAborted(
  resolve: (hostname: string) => Promise<readonly Address[]>,
  hostname: string,
  signal: AbortSignal,
): Promise<readonly Address[]> {
  // getaddrinfo itself is not cancelable here. Promise.race observes both its
  // eventual fulfillment and rejection after abort, while rejecting the caller
  // promptly; the caller still checks the signal before it can open a socket.
  const pending = Promise.resolve().then(() => {
    if (signal.aborted) throw new Error("public artifact request aborted");
    return resolve(hostname);
  });
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("public artifact request aborted"));
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** One fresh resolution and one non-pooled, certificate-validated TLS GET. */
export function createSelfhostPublicHttpsArtifactFetch(
  options: SelfhostPublicHttpsTransportOptions = {},
): (request: Request) => Promise<Response> {
  const resolve = options.resolve ?? ((hostname: string) => systemLookup(hostname, { all: true }));
  const port = options.port ?? 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("invalid TLS port");
  return async (request) => {
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      request.method !== "GET" ||
      !request.headers.entries().next().done ||
      request.signal.aborted
    )
      throw new Error("public artifact request refused");
    const answers = await resolveWhileNotAborted(resolve, url.hostname, request.signal);
    if (request.signal.aborted || answers.length === 0 || !answers.every(isPublicArtifactAddress))
      throw new Error("public artifact DNS refused");
    const selected = answers[0];
    if (!selected) throw new Error("public artifact DNS refused");
    return await fetchPinnedArtifact(
      request,
      { address: selected.address, family: selected.family },
      options,
    );
  };
}

/** Transport primitive: caller must have validated every DNS answer first. */
export async function fetchPinnedArtifact(
  request: Request,
  selected: Address,
  options: Pick<SelfhostPublicHttpsTransportOptions, "port" | "ca"> = {},
): Promise<Response> {
  const url = new URL(request.url);
  const port = options.port ?? 443;
  return await new Promise<Response>((resolveResponse, reject) => {
    let settled = false;
    const abort = () => client.destroy(new Error("public artifact request aborted"));
    const client = httpsRequest(
      {
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Host: url.hostname, Connection: "close" },
        servername: url.hostname,
        rejectUnauthorized: true,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        agent: false,
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        },
      },
      (incoming) => {
        settled = true;
        const status = incoming.statusCode ?? 502;
        if (status !== 200) {
          incoming.destroy();
          request.signal.removeEventListener("abort", abort);
          resolveResponse(
            new Response(null, { status: status >= 200 && status <= 599 ? status : 502 }),
          );
          return;
        }
        const body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
        const response = new Response(body, { status });
        // The bounded reader cancels this body on failure. Keep abort live until
        // the socket closes so a stalled body cannot survive its deadline.
        incoming.once("close", () => request.signal.removeEventListener("abort", abort));
        resolveResponse(response);
      },
    );
    client.once("error", (error) => {
      if (!settled) {
        request.signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
    client.once("upgrade", (_incoming, socket) => {
      socket.destroy();
      if (!settled) {
        request.signal.removeEventListener("abort", abort);
        reject(new Error("public artifact protocol upgrade refused"));
      }
    });
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    else client.end();
  });
}
