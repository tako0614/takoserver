import { Resolver } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";
import { rootCertificates, type TLSSocket } from "node:tls";

export interface DockerRegistryAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
/** Concrete wire headers are rebuilt here; browser Request credential modes are never forwarded. */
export interface DockerRegistryWireHeaders {
  readonly accept: string;
  readonly authorization?: string;
}

/** Capture only own data fields. Cookies, caller auth forwarding, and proxy auth cannot enter this port. */
export function captureDockerRegistryWireHeaders(value: unknown): DockerRegistryWireHeaders {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return registryFailure("invalid_request");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < 1 ||
    keys.length > 2 ||
    !keys.includes("accept") ||
    keys.some((key) => key !== "accept" && key !== "authorization")
  )
    return registryFailure("invalid_request");
  const captured: Record<string, string> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string") return registryFailure("invalid_request");
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (
      field === undefined ||
      !Object.hasOwn(field, "value") ||
      typeof field.value !== "string" ||
      field.value.length === 0 ||
      field.value.length > (key === "accept" ? 2048 : 16384)
    )
      return registryFailure("invalid_request");
    for (const char of field.value) {
      const code = char.charCodeAt(0);
      if (code < 32 || code === 127) return registryFailure("invalid_request");
    }
    captured[key] = field.value;
  }
  if (
    captured.authorization !== undefined &&
    !captured.authorization.startsWith("Basic ") &&
    !captured.authorization.startsWith("Bearer ")
  )
    return registryFailure("invalid_request");
  return Object.freeze({
    accept: captured.accept!,
    ...(captured.authorization === undefined ? {} : { authorization: captured.authorization }),
  });
}

export interface DockerRegistryWireReply {
  readonly response: Response;
  readonly remoteAddress: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
export interface DockerRegistryWire {
  resolve(
    hostname: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<readonly DockerRegistryAddress[]>;
  get(input: {
    readonly url: URL;
    readonly peer: DockerRegistryAddress;
    readonly headers: DockerRegistryWireHeaders;
    readonly signal: AbortSignal;
    readonly deadline: number;
    readonly maxBytes: number;
    readonly maxChunks: number;
    readonly chunkBytes: number;
    readonly guard: () => Promise<void>;
  }): Promise<DockerRegistryWireReply>;
}
export class DockerRegistrySourceError extends Error {
  constructor(readonly code: "invalid_request" | "conflict" | "unavailable") {
    super(code);
    this.name = "DockerRegistrySourceError";
  }
}
export function registryFailure(
  code: "invalid_request" | "conflict" | "unavailable" = "unavailable",
): never {
  throw new DockerRegistrySourceError(code);
}
function v4(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return (octets[0]! * 0x1000000 + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}
function v6(address: string): bigint | null {
  if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return null;
  const parts = address.toLowerCase().split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0) || (parts.length === 2 && missing < 1))
    return null;
  const words = [...left, ...Array<string>(missing).fill("0"), ...right];
  let value = 0n;
  for (const word of words) value = (value << 16n) | BigInt(Number.parseInt(word, 16));
  return value;
}
function inV4(address: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (base & mask) >>> 0;
}
function inV6(address: bigint, base: bigint, bits: bigint): boolean {
  return address >> (128n - bits) === base >> (128n - bits);
}
/** Conservative global-unicast classification. Effective IP is checked again after TLS dial. */
export function isDockerRegistryPublicAddress(address: string): boolean {
  const four = v4(address);
  if (four !== null) {
    const denied: readonly [number, number][] = [
      [0x00000000, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0000000, 24],
      [0xc0000200, 24],
      [0xc0586300, 24],
      [0xc0a80000, 16],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 4],
      [0xf0000000, 4],
    ];
    return !denied.some(([base, bits]) => inV4(four, base, bits));
  }
  const six = v6(address);
  if (six === null) return false; // Includes IPv4-mapped IPv6 and scoped addresses.
  if (!inV6(six, 0x2000n << 112n, 3n)) return false;
  return !(
    [
      [0x2001n << 112n, 23n], // IANA special-purpose space.
      [0x2002n << 112n, 16n], // 6to4 can route to private IPv4.
      [0x20010db8n << 96n, 32n], // Documentation.
      [0x3fffn << 112n, 20n], // Documentation.
    ] as const
  ).some(([base, bits]) => inV6(six, base, bits));
}
function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map((entry) => entry.address),
  );
}
function sameAddress(a: string, b: string): boolean {
  const a4 = v4(a),
    b4 = v4(b);
  if (a4 !== null || b4 !== null) return a4 !== null && a4 === b4;
  const a6 = v6(a),
    b6 = v6(b);
  return a6 !== null && a6 === b6;
}

export function sameDockerRegistryAddress(a: string, b: string): boolean {
  return sameAddress(a, b);
}
export function dockerRegistryLocalAddresses(): readonly string[] {
  return localAddresses();
}

/** One fresh numeric-peer dial. HTTP headers are sent only after both peer and
 * native certificate/hostname verification. No ambient proxy, shared agent,
 * cookies, redirect, session cache or alternate DNS fallback is used. */
export const nodeDockerRegistryWire: DockerRegistryWire = Object.freeze({
  async resolve(hostname: string, signal: AbortSignal, deadline: number) {
    const remaining = Math.floor(deadline - performance.now());
    if (signal.aborted || !Number.isSafeInteger(remaining) || remaining < 1)
      return registryFailure();
    if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
    const resolver = new Resolver({ timeout: Math.min(remaining, 2_147_483_647), tries: 1 });
    const abort = () => resolver.cancel();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.min(remaining, 2_147_483_647));
    try {
      const results = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      if (signal.aborted || performance.now() >= deadline) return registryFailure();
      const addresses: DockerRegistryAddress[] = [];
      for (let n = 0; n < results.length; n++) {
        const result = results[n]!;
        if (result.status === "fulfilled")
          for (const address of result.value) addresses.push({ address, family: n === 0 ? 4 : 6 });
        else if (!result.reason || !["ENODATA", "ENOTFOUND"].includes(result.reason.code))
          return registryFailure();
      }
      return addresses;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  },
  async get(input: Parameters<DockerRegistryWire["get"]>[0]) {
    const headers = captureDockerRegistryWireHeaders(input.headers);
    if (
      ![input.maxBytes, input.maxChunks, input.chunkBytes].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      input.chunkBytes > 65536 ||
      input.url.protocol !== "https:" ||
      input.url.username ||
      input.url.password ||
      input.url.hash
    )
      return registryFailure("invalid_request");
    await input.guard();
    const host = input.url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
    const remaining = Math.floor(input.deadline - performance.now());
    if (
      input.signal.aborted ||
      !Number.isSafeInteger(remaining) ||
      remaining < 1 ||
      remaining > 2_147_483_647
    )
      return registryFailure();
    return await new Promise<DockerRegistryWireReply>((resolve, reject) => {
      let settled = false,
        requestClosed = false,
        responseClosed = true,
        incoming: IncomingMessage | undefined;
      let endObserved = false,
        total = 0,
        chunks = 0,
        failed = false;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((done) => {
        resolveClosed = done;
      });
      const finish = () => {
        if (requestClosed && responseClosed) {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", abort);
          resolveClosed();
        }
      };
      const check = () => {
        if (input.signal.aborted || performance.now() >= input.deadline || failed)
          return registryFailure();
      };
      const pinned: LookupFunction = (hostname, options, callback) => {
        if (hostname !== host) {
          callback(new DockerRegistrySourceError("unavailable"), "", 0);
          return;
        }
        if (options.all) callback(null, [input.peer]);
        else callback(null, input.peer.address, input.peer.family);
      };
      const agentOptions = {
        keepAlive: false,
        maxSockets: 1,
        maxCachedSessions: 0,
        ca: [...rootCertificates],
        lookup: pinned,
        autoSelectFamily: false,
      };
      const agent = new HttpsAgent(agentOptions);
      const requestOptions = {
        method: "GET",
        agent,
        lookup: pinned,
        autoSelectFamily: false,
        maxHeaderSize: 16384,
        rejectUnauthorized: true,
        servername: isIP(host) ? "" : host,
        headers: {
          ...headers,
          Host: input.url.host,
          Connection: "close",
          "accept-encoding": "identity",
        },
      };
      const req = httpsRequest(input.url, requestOptions, (response) => {
        incoming = response;
        responseClosed = false;
        response.once("close", () => {
          responseClosed = true;
          finish();
        });
        response.once("end", () => {
          endObserved = true;
        });
        const remote = response.socket.remoteAddress ?? "";
        if (
          !sameAddress(remote, input.peer.address) ||
          !isDockerRegistryPublicAddress(remote) ||
          !(response.socket as TLSSocket).encrypted ||
          !(response.socket as TLSSocket).authorized
        ) {
          abort();
          return;
        }
        const status = response.statusCode ?? 0;
        if (status < 200 || status > 599) {
          abort();
          return;
        }
        const headers = new Headers();
        for (const name of [
          "content-type",
          "content-length",
          "content-encoding",
          "content-range",
          "docker-content-digest",
          "location",
          "www-authenticate",
        ]) {
          const value = response.headers[name];
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(", "));
        }
        const length = headers.get("content-length");
        if (
          (length !== null &&
            (!/^[0-9]+$/u.test(length) ||
              !Number.isSafeInteger(Number(length)) ||
              Number(length) > input.maxBytes)) ||
          headers.has("content-range") ||
          (headers.has("content-encoding") && headers.get("content-encoding") !== "identity")
        ) {
          abort();
          return;
        }
        const iterator = response[Symbol.asyncIterator]();
        let pending: Uint8Array | undefined,
          at = 0;
        const stop = async () => {
          req.destroy();
          response.destroy();
          agent.destroy();
          await closed;
        };
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                check();
                await input.guard();
                check();
                if (!pending || at === pending.byteLength) {
                  const next = await iterator.next();
                  check();
                  await input.guard();
                  check();
                  if (next.done) {
                    if (!endObserved || !response.complete) return registryFailure();
                    await closed;
                    controller.close();
                    return;
                  }
                  const chunk = next.value as Uint8Array;
                  if (!(chunk instanceof Uint8Array)) return registryFailure();
                  if (chunk.byteLength > input.maxBytes - total || ++chunks > input.maxChunks)
                    return registryFailure("conflict");
                  total += chunk.byteLength;
                  pending = chunk;
                  at = 0;
                  if (chunk.byteLength === 0) return registryFailure();
                }
                const end = Math.min(pending.byteLength, at + input.chunkBytes);
                controller.enqueue(pending.subarray(at, end));
                at = end;
              } catch (error) {
                failed = true;
                await stop();
                controller.error(
                  error instanceof DockerRegistrySourceError
                    ? error
                    : new DockerRegistrySourceError("unavailable"),
                );
              }
            },
            async cancel() {
              pending = undefined;
              await stop();
            },
          },
          { highWaterMark: 0 },
        );
        const result = new Response([204, 205, 304].includes(status) ? null : body, {
          status,
          headers,
        });
        Object.defineProperty(result, "url", { value: input.url.href });
        settled = true;
        resolve({ response: result, remoteAddress: remote, closed, close: stop });
        if (result.body === null) void stop();
      });
      const abort = () => {
        failed = true;
        req.destroy(new DockerRegistrySourceError("unavailable"));
        incoming?.destroy();
        agent.destroy();
        if (!settled) {
          settled = true;
          void closed.then(() => reject(new DockerRegistrySourceError("unavailable")));
        }
      };
      const timer = setTimeout(abort, remaining);
      input.signal.addEventListener("abort", abort, { once: true });
      req.once("error", abort);
      req.once("close", () => {
        requestClosed = true;
        finish();
      });
      req.once("socket", (base) => {
        const socket = base as TLSSocket;
        socket.once("secureConnect", () => {
          try {
            check();
            if (
              !sameAddress(socket.remoteAddress ?? "", input.peer.address) ||
              !isDockerRegistryPublicAddress(socket.remoteAddress ?? "") ||
              !socket.encrypted ||
              !socket.authorized
            )
              return abort();
            req.end();
          } catch {
            abort();
          }
        });
      });
      if (input.signal.aborted) abort();
    });
  },
});
