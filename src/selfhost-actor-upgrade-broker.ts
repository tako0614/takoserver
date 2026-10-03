import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";

const HEAD_LIMIT = 16 * 1024;
const HEAD_MS = 5_000;
const RESERVATION_MS = 30_000;
const MAX_BROKER_PROVISIONAL = 1_024;
const TOKEN_HEADER = "x-takoserver-private-broker-token";
const ACTOR_ID_HEADER = "x-takoserver-private-broker-actor-id";
const RESERVATION_HEADER = "x-takoserver-private-broker-reservation";

export interface SelfhostActorDuplexLease {
  readonly target: {
    readonly socketPath: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  commitTransport(bearer: string): Promise<void>;
  abandonTransport(bearer: string): Promise<void>;
  abandon(): void;
}

export interface SelfhostActorUpgradeBrokerOptions {
  readonly socketPath: string;
  /** Host-private credential embedded only in the generated wrapper module. */
  readonly token: string;
  /** Must perform live tenant/incarnation/deployment and weighted-Version admission. */
  readonly reserve: (actorId: string, request: Request) => Promise<SelfhostActorDuplexLease>;
}

interface Pending {
  readonly client: Socket;
  readonly upstream: Socket;
  readonly lease: SelfhostActorDuplexLease;
  readonly ownerBearer: string;
  readonly clientTail: Buffer;
  readonly upstreamTail: Buffer;
  readonly timer: ReturnType<typeof setTimeout>;
  state: "provisional" | "committing" | "committed" | "abandoned";
}

function reply(socket: Socket, status: number): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${status === 204 ? "No Content" : "Unavailable"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

function readHead(socket: Socket): Promise<{ head: string; tail: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error("Actor broker head timed out")), HEAD_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => fail(new Error("Actor broker peer closed"));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > HEAD_LIMIT) return fail(new Error("Actor broker head too large"));
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.pause();
      cleanup();
      resolve({ head: buffer.subarray(0, end).toString("latin1"), tail: buffer.subarray(end + 4) });
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("close", onClose);
    socket.resume();
  });
}

function parseHead(
  head: string,
  response = false,
): {
  first: string;
  headers: Map<string, string>;
  setCookies: string[];
} {
  const [first, ...lines] = head.split("\r\n");
  if (!first || lines.length > 100) throw new Error("Actor broker head invalid");
  const headers = new Map<string, string>();
  const setCookies: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/u.test(line)) throw new Error("Actor broker folded header refused");
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("Actor broker header invalid");
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    let controls = false;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code < 32 || code === 127) controls = true;
    }
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) || controls)
      throw new Error("Actor broker header invalid");
    // Set-Cookie is not a comma-joinable header. Keep its response field values
    // separately, in order; no request/private/handshake singleton is relaxed.
    if (response && name === "set-cookie") {
      setCookies.push(value);
      continue;
    }
    if (headers.has(name)) throw new Error("Actor broker duplicate header refused");
    headers.set(name, value);
  }
  return { first, headers, setCookies };
}

function validToken(got: string | undefined, expected: string): boolean {
  if (got === undefined) return false;
  const left = Buffer.from(got);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function writeHead(
  first: string,
  headers: Map<string, string>,
  setCookies: readonly string[] = [],
): Buffer {
  const lines = [first];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  for (const value of setCookies) lines.push(`set-cookie: ${value}`);
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

/** A private Unix hop; the untrusted Worker receives neither target nor lease. */
export async function openSelfhostActorUpgradeBroker(
  options: SelfhostActorUpgradeBrokerOptions,
): Promise<{
  readonly socketPath: string;
  /** Keep provisional commit/abandon ingress until those leases settle. */
  retire(): Promise<void>;
  close(): Promise<void>;
}> {
  if (!isAbsolute(options.socketPath) || !/^[0-9a-f]{64}$/u.test(options.token))
    throw new Error("Actor broker configuration invalid");
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  const pending = new Map<string, Pending>();
  const sockets = new Set<Socket>();
  const settling = new Set<Promise<void>>();
  let admitting = 0;
  let retiring = false;
  let settlementFailed = false;
  let stopping = false;
  let resolveRetirement: (() => void) | undefined;
  let rejectRetirement: ((error: Error) => void) | undefined;
  let retirement: Promise<void> | undefined;
  const stopAccepting = (): void => {
    if (stopping) return;
    stopping = true;
    server.close((error) => {
      if (error || settlementFailed)
        rejectRetirement?.(new Error("Actor broker provisional settlement unproved"));
      else resolveRetirement?.();
    });
  };
  const maybeStopAccepting = (): void => {
    if (retiring && pending.size === 0 && admitting === 0 && settling.size === 0) stopAccepting();
  };
  const abandon = (id: string): void => {
    const entry = pending.get(id);
    if (!entry || entry.state === "committed" || entry.state === "abandoned") return;
    entry.state = "abandoned";
    clearTimeout(entry.timer);
    pending.delete(id);
    let settlement!: Promise<void>;
    settlement = (async () => {
      try {
        await Promise.resolve().then(() => entry.lease.abandonTransport(entry.ownerBearer));
      } catch {
        // A local lease release is not proof that the native provisional
        // transport settled. Do not report this broker as cleanly retired.
        settlementFailed = true;
        try {
          entry.lease.abandon();
        } catch {
          /* The Host lease also expires independently. */
        }
      } finally {
        settling.delete(settlement);
        maybeStopAccepting();
      }
    })();
    settling.add(settlement);
    entry.upstream.destroy();
    entry.client.destroy();
    maybeStopAccepting();
  };
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    void (async () => {
      let lease: SelfhostActorDuplexLease | undefined;
      let id: string | undefined;
      let ownerBearer: string | undefined;
      let counted = false;
      const callerAbort = new AbortController();
      client.once("close", () => callerAbort.abort(new Error("request_aborted")));
      try {
        const incoming = await readHead(client);
        const parsed = parseHead(incoming.head);
        if (!validToken(parsed.headers.get(TOKEN_HEADER), options.token)) {
          reply(client, 404);
          return;
        }
        const controlTarget = /^POST (\S+) HTTP\/1\.1$/u.exec(parsed.first);
        const control = controlTarget
          ? /^\/__broker\/(commit|abandon)\/([0-9a-f-]{36})$/u.exec(
              new URL(controlTarget[1] as string, "http://actor.invalid").pathname,
            )
          : null;
        if (control) {
          const reservationId = control[2] as string;
          if (
            incoming.tail.length ||
            parsed.headers.has("transfer-encoding") ||
            (parsed.headers.get("content-length") ?? "0") !== "0"
          ) {
            reply(client, 400);
            return;
          }
          const record = pending.get(reservationId);
          if (record?.state !== "provisional") {
            reply(client, 404);
            return;
          }
          if (control[1] === "abandon") {
            abandon(reservationId);
            reply(client, 204);
            return;
          }
          record.state = "committing";
          try {
            await record.lease.commitTransport(record.ownerBearer);
            if (record.client.destroyed || record.upstream.destroyed)
              throw new Error("Actor socket transport closed before commit");
            record.state = "committed";
            clearTimeout(record.timer);
            pending.delete(reservationId);
            maybeStopAccepting();
            if (record.upstreamTail.length) record.client.write(record.upstreamTail);
            if (record.clientTail.length) record.upstream.write(record.clientTail);
            record.client.pipe(record.upstream);
            record.upstream.pipe(record.client);
            record.client.resume();
            record.upstream.resume();
            reply(client, 204);
          } catch {
            record.state = "provisional";
            abandon(reservationId);
            reply(client, 503);
          }
          return;
        }
        if (retiring) {
          reply(client, 503);
          return;
        }
        const match = /^GET (\S+) HTTP\/1\.1$/u.exec(parsed.first);
        if (
          !match ||
          parsed.headers.has("content-length") ||
          parsed.headers.has("transfer-encoding") ||
          parsed.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          !parsed.headers
            .get("connection")
            ?.toLowerCase()
            .split(",")
            .some((part) => part.trim() === "upgrade") ||
          !parsed.headers.get("sec-websocket-key") ||
          parsed.headers.get("sec-websocket-version") !== "13"
        ) {
          reply(client, 400);
          return;
        }
        const encodedId = parsed.headers.get(ACTOR_ID_HEADER);
        if (!encodedId || encodedId.length > 2_048) {
          reply(client, 400);
          return;
        }
        const actorId = decodeURIComponent(encodedId);
        if (pending.size + admitting >= MAX_BROKER_PROVISIONAL) {
          reply(client, 429);
          return;
        }
        admitting += 1;
        counted = true;
        parsed.headers.delete(TOKEN_HEADER);
        parsed.headers.delete(ACTOR_ID_HEADER);
        parsed.headers.delete(RESERVATION_HEADER);
        const targetUrl = new URL(match[1] as string, "http://actor.invalid");
        if (
          !["http:", "https:"].includes(targetUrl.protocol) ||
          targetUrl.username ||
          targetUrl.password
        )
          throw new Error("Actor broker request target invalid");
        const request = new Request(targetUrl, {
          headers: Array.from(parsed.headers),
          signal: callerAbort.signal,
        });
        lease = await options.reserve(actorId, request);
        if (client.destroyed) throw new Error("Actor broker caller disconnected");
        for (const [name, value] of Object.entries(lease.target.headers))
          parsed.headers.set(name.toLowerCase(), value);
        const upstream = createConnection({ path: lease.target.socketPath });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        await new Promise<void>((resolve, reject) => {
          upstream.once("connect", resolve);
          upstream.once("error", reject);
        });
        upstream.write(writeHead(parsed.first, parsed.headers));
        const response = await readHead(upstream);
        const upstreamHead = parseHead(response.head, true);
        if (
          !/^HTTP\/1\.[01] 101(?: |$)/u.test(upstreamHead.first) ||
          upstreamHead.headers.has(RESERVATION_HEADER)
        )
          throw new Error("Actor broker upstream did not accept WebSocket");
        ownerBearer = upstreamHead.headers.get("x-takoserver-private-actor-reservation");
        if (!ownerBearer || !/^[a-f0-9]{64}$/u.test(ownerBearer))
          throw new Error("Actor owner reservation unavailable");
        upstreamHead.headers.delete("x-takoserver-private-actor-reservation");
        const selected = upstreamHead.headers.get("sec-websocket-protocol");
        if (
          selected &&
          !parsed.headers
            .get("sec-websocket-protocol")
            ?.split(",")
            .some((part) => part.trim() === selected)
        )
          throw new Error("Actor broker selected an unoffered protocol");
        id = randomUUID();
        upstreamHead.headers.set(RESERVATION_HEADER, id);
        const entry: Pending = {
          client,
          upstream,
          lease,
          ownerBearer,
          clientTail: incoming.tail,
          upstreamTail: response.tail,
          timer: setTimeout(() => abandon(id as string), RESERVATION_MS),
          state: "provisional",
        };
        pending.set(id, entry);
        client.once("close", () => abandon(id as string));
        upstream.once("close", () => abandon(id as string));
        client.write(writeHead(upstreamHead.first, upstreamHead.headers, upstreamHead.setCookies));
      } catch {
        if (id) abandon(id);
        else {
          try {
            if (lease && ownerBearer) {
              try {
                await lease.abandonTransport(ownerBearer);
              } catch {
                settlementFailed = true;
                lease.abandon();
              }
            } else lease?.abandon();
          } catch {
            /* Broker expiry and caller disconnect remain independent. */
          }
        }
        reply(client, 503);
      } finally {
        if (counted) admitting -= 1;
        maybeStopAccepting();
      }
    })();
  });
  const beginRetirement = (): Promise<void> => {
    if (!retirement)
      retirement = new Promise<void>((resolve, reject) => {
        resolveRetirement = resolve;
        rejectRetirement = reject;
      });
    retiring = true;
    maybeStopAccepting();
    return retirement;
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return Object.freeze({
    socketPath: options.socketPath,
    retire: beginRetirement,
    async close(): Promise<void> {
      const drained = beginRetirement();
      for (const id of pending.keys()) abandon(id);
      for (const socket of sockets) socket.destroy();
      await drained;
    },
  });
}
