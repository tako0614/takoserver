import { timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { Readable } from "node:stream";

const TOKEN_HEADER = "x-takoserver-private-broker-token";
const ACTOR_ID_HEADER = "x-takoserver-private-broker-actor-id";
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export interface SelfhostActorHttpBrokerOptions {
  readonly socketPath: string;
  /** Host-private credential; never project the raw service into tenant env. */
  readonly token: string;
  /** Bind this callback to one exact tenant and Actor Namespace incarnation. */
  readonly fetch: (actorId: string, request: Request) => Promise<Response>;
}

function validToken(got: string | undefined, expected: string): boolean {
  if (got === undefined) return false;
  const left = Buffer.from(got);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function waitForDrainOrClose(outgoing: ServerResponse, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      outgoing.off("drain", onDrain);
      outgoing.off("close", onClose);
      outgoing.off("error", onClose);
      signal.removeEventListener("abort", onClose);
    };
    const finish = (drained: boolean) => {
      cleanup();
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    outgoing.once("drain", onDrain);
    outgoing.once("close", onClose);
    outgoing.once("error", onClose);
    signal.addEventListener("abort", onClose, { once: true });
    if (outgoing.destroyed || signal.aborted) onClose();
  });
}

/** Ordinary streaming Actor calls use the same Host authority owner as upgrades. */
export async function openSelfhostActorHttpBroker(
  options: SelfhostActorHttpBrokerOptions,
): Promise<{
  readonly socketPath: string;
  /** Stop accepting new calls and wait for already accepted bodies to drain. */
  retire(): Promise<void>;
  close(): Promise<void>;
}> {
  if (!isAbsolute(options.socketPath) || !/^[0-9a-f]{64}$/u.test(options.token))
    throw new Error("Actor HTTP broker configuration invalid");
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  const sockets = new Set<Socket>();
  const server = createServer(async (incoming, outgoing) => {
    try {
      let tokenCount = 0;
      let idCount = 0;
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const name = incoming.rawHeaders[i]?.toLowerCase();
        if (name === TOKEN_HEADER) tokenCount += 1;
        if (name === ACTOR_ID_HEADER) idCount += 1;
      }
      const token = incoming.headers[TOKEN_HEADER];
      if (tokenCount !== 1 || typeof token !== "string" || !validToken(token, options.token)) {
        outgoing.writeHead(404).end();
        return;
      }
      const encodedId = incoming.headers[ACTOR_ID_HEADER];
      if (
        idCount !== 1 ||
        typeof encodedId !== "string" ||
        !encodedId ||
        encodedId.length > 2_048
      ) {
        outgoing.writeHead(400).end();
        return;
      }
      if (!incoming.method || !incoming.url) {
        outgoing.writeHead(400).end();
        return;
      }
      const actorId = decodeURIComponent(encodedId);
      const url = new URL(incoming.url, "http://actor.invalid");
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        outgoing.writeHead(400).end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (name === TOKEN_HEADER || name === ACTOR_ID_HEADER || HOP_HEADERS.has(name)) continue;
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      }
      const abort = new AbortController();
      outgoing.once("close", () => abort.abort(new Error("request_aborted")));
      const body =
        incoming.method === "GET" || incoming.method === "HEAD"
          ? undefined
          : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
      const request = new Request(url, {
        method: incoming.method,
        headers,
        body,
        signal: abort.signal,
        redirect: "manual",
        ...(body ? { duplex: "half" as const } : {}),
      } as RequestInit);
      const response = await options.fetch(actorId, request);
      if (response.status === 101) {
        outgoing.writeHead(503).end();
        return;
      }
      const responseHeaders: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name) && name !== "set-cookie") responseHeaders[name] = value;
      });
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) responseHeaders["set-cookie"] = setCookies;
      outgoing.writeHead(response.status, responseHeaders);
      if (!response.body || incoming.method === "HEAD") {
        outgoing.end();
        return;
      }
      const responseBody = Readable.fromWeb(response.body as never);
      const cancelBody = () => responseBody.destroy();
      abort.signal.addEventListener("abort", cancelBody, { once: true });
      if (abort.signal.aborted) cancelBody();
      try {
        for await (const chunk of responseBody) {
          if (outgoing.destroyed || abort.signal.aborted) break;
          if (!outgoing.write(chunk) && !(await waitForDrainOrClose(outgoing, abort.signal))) break;
        }
      } finally {
        abort.signal.removeEventListener("abort", cancelBody);
        if (!responseBody.readableEnded) responseBody.destroy();
      }
      if (!outgoing.destroyed) outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(503);
      outgoing.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let stopping: Promise<void> | undefined;
  const retire = (): Promise<void> => {
    stopping ??= new Promise<void>((resolve) => server.close(() => resolve()));
    return stopping;
  };
  return Object.freeze({
    socketPath: options.socketPath,
    retire,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await retire();
    },
  });
}
