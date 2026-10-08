import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type {
  WorkerdBridgeMessage,
  WorkerdNativeWebSocket,
} from "./workerd-worker-execution-group.ts";

const require = createRequire(import.meta.url);
const FRAME_LIMIT = 33_554_432;
const HEAD_LIMIT = 16 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/u;
const RESERVED = new Set([
  "upgrade",
  "connection",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  "content-length",
  "transfer-encoding",
]);
const REFUSED_HOP = new Set(["proxy-connection", "keep-alive", "te", "trailer"]);

type Upstream = WorkerdNativeWebSocket & {
  on(event: "upgrade", listener: (response: IncomingMessage) => void): void;
  on(event: "error", listener: () => void): void;
};
type UpstreamConstructor = new (
  url: string,
  protocols: string[],
  options: Record<string, unknown>,
) => Upstream;

/** Validate the raw 101 head before exposing only nonreserved response fields. */
export function filterUpstream101Headers(
  raw: readonly string[],
): readonly (readonly [string, string])[] {
  if (raw.length % 2 !== 0 || raw.length > 200) throw new Error("invalid native upgrade head");
  let bytes = 0;
  const seenReserved = new Set<string>();
  const ordinary: (readonly [string, string])[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]?.toLowerCase();
    const value = raw[index + 1];
    if (
      !name ||
      value === undefined ||
      !HEADER_NAME.test(name) ||
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      throw new Error("invalid native upgrade header");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > HEAD_LIMIT || name.startsWith("x-takoserver-private-") || REFUSED_HOP.has(name))
      throw new Error("unsafe native upgrade header");
    if (RESERVED.has(name)) {
      if (seenReserved.has(name)) throw new Error("duplicate reserved upgrade header");
      seenReserved.add(name);
      if (name === "connection" && value.trim().toLowerCase() !== "upgrade")
        throw new Error("unsafe connection upgrade header");
      if (name === "content-length" || name === "transfer-encoding")
        throw new Error("unexpected upgrade body framing");
      continue;
    }
    ordinary.push(Object.freeze([name, value] as const));
  }
  return Object.freeze(ordinary);
}

/** One no-redirect loopback transport for an already-authorized exact child. */
export async function openSelfhostV2WorkerEndpointUpstreamWebSocket(input: {
  readonly url: string;
  readonly headers: Headers;
  readonly protocols: readonly string[];
  readonly signal: AbortSignal;
}): Promise<WorkerdNativeWebSocket> {
  const url = new URL(input.url);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash ||
    input.signal.aborted
  )
    throw new Error("invalid private WebSocket target");
  const Constructor = require("ws") as UpstreamConstructor;
  const socket = new Constructor(input.url, [...input.protocols], {
    headers: Object.fromEntries(input.headers.entries()),
    maxPayload: FRAME_LIMIT,
    perMessageDeflate: false,
    followRedirects: false,
    handshakeTimeout: 10_000,
    maxHeaderSize: HEAD_LIMIT,
  });
  socket.binaryType = "arraybuffer";
  // Retain an error consumer after the handshake so a post-open failure cannot
  // become uncaught before the public listener attaches its own callbacks.
  socket.on("error", () => {});

  const early: WorkerdBridgeMessage[] = [];
  let earlyBytes = 0;
  let forward: ((value: WorkerdBridgeMessage) => void) | undefined;
  let terminalClose: CloseEvent | null = null;
  socket.addEventListener("message", (event) => {
    const value: unknown = event.data;
    if (
      typeof value !== "string" &&
      !(value instanceof ArrayBuffer) &&
      !(value instanceof Uint8Array)
    ) {
      socket.terminate();
      return;
    }
    const size = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    if (size > FRAME_LIMIT || (!forward && earlyBytes + size > FRAME_LIMIT)) {
      socket.terminate();
      return;
    }
    if (forward) forward(value);
    else {
      early.push(value);
      earlyBytes += size;
    }
  });
  socket.addEventListener(
    "close",
    (event) => {
      terminalClose = event;
      // A native close may overtake the public upgrade. Keep the bounded earlier
      // messages until the public socket can receive them in order.
    },
    { once: true },
  );
  Object.defineProperty(socket, "getTerminalClose", {
    value: () => terminalClose,
  });
  Object.defineProperty(socket, "forwardMessages", {
    value(send: (value: WorkerdBridgeMessage) => void) {
      if (forward) throw new Error("native socket already forwarded");
      forward = send;
      for (const value of early) send(value);
      early.length = 0;
      earlyBytes = 0;
    },
  });

  let captured: readonly (readonly [string, string])[] | null = null;
  let invalid = false;
  socket.on("upgrade", (response) => {
    try {
      if (response.statusCode !== 101) throw new Error("native upgrade did not switch protocols");
      captured = filterUpstream101Headers(response.rawHeaders);
    } catch {
      invalid = true;
      socket.terminate();
    }
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", aborted);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
      if (error) {
        socket.terminate();
        reject(error);
      } else resolve();
    };
    const opened = () =>
      settle(invalid || !captured ? new Error("invalid native upgrade") : undefined);
    const failed = () => settle(new Error("native upgrade failed"));
    const aborted = () => settle(new Error("native upgrade aborted"));
    const timer = setTimeout(failed, 10_000);
    input.signal.addEventListener("abort", aborted, { once: true });
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
    if (input.signal.aborted) aborted();
  });
  Object.defineProperty(socket, "handshakeHeaders", { value: captured });
  return socket;
}
