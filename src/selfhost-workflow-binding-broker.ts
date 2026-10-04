import { timingSafeEqual } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type { SelfhostWorkflowPrivateOwner } from "./selfhost-workflow-private-owner.ts";
import {
  DocumentValidationError,
  encodeDocument,
  inputIdentifier,
  normalizeScope,
} from "./workflow-data.ts";
import { isWorkflowRuntimeError } from "./workflow-driver.ts";
import { WorkflowInstanceError, type WorkflowScope } from "./workflow-instances.ts";

const TOKEN_HEADER = "x-takoserver-private-workflow-binding-token";
const SCHEMA = "takoserver.selfhost-workflow-binding-result@v1";
const ROUTE = "/__takoserver/workflow-binding/v1/";
const MAX_FRAME_BYTES = 1_064_960;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

type Operation = "create" | "get" | "status" | "sendEvent" | "terminate";
type BindingInstances = Pick<
  SelfhostWorkflowPrivateOwner["instances"],
  "create" | "get" | "status" | "sendEvent" | "terminate"
>;

export interface SelfhostWorkflowBindingBrokerOptions {
  /** A caller-owned absent socket path inside an existing private 0700 directory. */
  readonly socketPath: string;
  /** Publication-pinned, per-binding/version token; never projected to app env. */
  readonly token: string;
  /** Already-qualified immutable Resource incarnation, never read from the wire. */
  readonly scope: WorkflowScope;
  readonly instances: BindingInstances;
}

export interface SelfhostWorkflowBindingBroker {
  readonly socketPath: string;
  /** Stop admission and join every accepted operation, including lost replies. */
  retire(): Promise<void>;
  close(): Promise<void>;
}

class ProtocolError extends Error {
  constructor(readonly status: 400 | 413) {
    super("unusable private Workflow binding request");
  }
}

function authenticated(incoming: IncomingMessage, expected: Buffer): boolean {
  let count = 0;
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    if (incoming.rawHeaders[i]?.toLowerCase() === TOKEN_HEADER) count += 1;
  }
  const got = incoming.headers[TOKEN_HEADER];
  return (
    count === 1 &&
    typeof got === "string" &&
    TOKEN_PATTERN.test(got) &&
    timingSafeEqual(Buffer.from(got, "hex"), expected)
  );
}

function sendEmpty(outgoing: ServerResponse, status: number): void {
  if (outgoing.destroyed || outgoing.headersSent) return;
  outgoing.writeHead(status, { connection: "close", "content-length": "0" }).end();
}

function sendResult(
  outgoing: ServerResponse,
  result: { readonly value: unknown } | { readonly error: string },
): void {
  if (outgoing.destroyed || outgoing.headersSent) return;
  const body = JSON.stringify({ schema: SCHEMA, ...result });
  if (Buffer.byteLength(body) > MAX_FRAME_BYTES) {
    sendEmpty(outgoing, 503);
    return;
  }
  outgoing
    .writeHead(200, {
      connection: "close",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    })
    .end(body);
}

function operationFor(incoming: IncomingMessage): Operation {
  if (incoming.method !== "POST" || typeof incoming.url !== "string") throw new ProtocolError(400);
  switch (incoming.url) {
    case `${ROUTE}create`:
      return "create";
    case `${ROUTE}get`:
      return "get";
    case `${ROUTE}status`:
      return "status";
    case `${ROUTE}sendEvent`:
      return "sendEvent";
    case `${ROUTE}terminate`:
      return "terminate";
    default:
      throw new ProtocolError(400);
  }
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.includes(key))
  );
}

async function readBody(incoming: IncomingMessage): Promise<unknown> {
  let contentTypeCount = 0;
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    if (incoming.rawHeaders[i]?.toLowerCase() === "content-type") contentTypeCount += 1;
  }
  if (contentTypeCount !== 1 || incoming.headers["content-type"] !== "application/json") {
    throw new ProtocolError(400);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of incoming) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.byteLength;
      if (length > MAX_FRAME_BYTES) throw new ProtocolError(413);
      chunks.push(bytes);
    }
    if (!incoming.complete) throw new ProtocolError(400);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(400);
  }
}

function domainError(operation: Operation, error: unknown): string | null {
  if (error instanceof WorkflowInstanceError) {
    const allowed =
      operation === "create"
        ? [
            "instance_exists",
            "invalid_params",
            "document_too_large",
            "unsupported_capability",
            "backend_unavailable",
          ]
        : operation === "sendEvent"
          ? [
              "unknown_instance",
              "instance_terminal",
              "document_too_large",
              "event_queue_full",
              "backend_unavailable",
            ]
          : ["unknown_instance", "backend_unavailable"];
    return allowed.includes(error.code) ? error.code : null;
  }
  if (
    isWorkflowRuntimeError(error) &&
    (error.code === "host_unavailable" || error.code === "backend_unavailable")
  ) {
    return "backend_unavailable";
  }
  return null;
}

function validIdentifier(value: unknown, label: string): string {
  try {
    return inputIdentifier(value, label);
  } catch {
    throw new ProtocolError(400);
  }
}

function validErrorMessage(value: unknown): value is string {
  if (value === "") return true;
  try {
    inputIdentifier(value, "workflow error message", 8_192);
    return true;
  } catch {
    return false;
  }
}

function statusValue(
  value: Awaited<ReturnType<BindingInstances["status"]>>,
): Record<string, unknown> {
  const statuses = [
    "queued",
    "running",
    "sleeping",
    "waiting",
    "complete",
    "errored",
    "terminated",
  ];
  if (
    !hasExactKeys(value, ["status"], ["status", "output", "error"]) ||
    typeof value.status !== "string" ||
    !statuses.includes(value.status) ||
    (Object.hasOwn(value, "output") && value.status !== "complete") ||
    (Object.hasOwn(value, "error") && value.status !== "errored")
  ) {
    throw new Error("unusable private Workflow status");
  }
  const result: Record<string, unknown> = { status: value.status };
  if (Object.hasOwn(value, "output")) {
    result.output = JSON.parse(encodeDocument(value.output));
  }
  if (Object.hasOwn(value, "error")) {
    const detail = value.error;
    const reasons = [
      "run_threw",
      "step_failed",
      "step_limit_exceeded",
      "lifetime_exceeded",
      "step_definition_mismatch",
    ];
    if (
      !hasExactKeys(detail, ["reason"], ["reason", "message"]) ||
      typeof detail.reason !== "string" ||
      !reasons.includes(detail.reason) ||
      (Object.hasOwn(detail, "message") && !validErrorMessage(detail.message))
    ) {
      throw new Error("unusable private Workflow status error");
    }
    result.error = Object.hasOwn(detail, "message")
      ? { reason: detail.reason, message: detail.message }
      : { reason: detail.reason };
  }
  return result;
}

async function privateSocketPath(path: string): Promise<void> {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.includes("\u0000") ||
    Buffer.byteLength(path) > 100
  ) {
    throw new Error("private Workflow binding socket path is unusable");
  }
  const parent = dirname(path);
  const info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid()) ||
    (await realpath(parent)) !== parent
  ) {
    throw new Error("private Workflow binding socket directory is unusable");
  }
  try {
    await lstat(path);
    throw new Error("private Workflow binding socket path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Dormant Host-private Binding transport. The opener must first authenticate
 * the immutable selected publication/descriptor; this socket binds only its
 * already-qualified scope and never grants public Workflow support.
 */
export async function openSelfhostWorkflowBindingBroker(
  options: SelfhostWorkflowBindingBrokerOptions,
): Promise<SelfhostWorkflowBindingBroker> {
  if (!TOKEN_PATTERN.test(options.token))
    throw new Error("private Workflow binding token is unusable");
  await privateSocketPath(options.socketPath);
  const scope = Object.freeze(normalizeScope(options.scope));
  const expectedToken = Buffer.from(options.token, "hex");
  let accepting = true;
  const requests = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    const request = Promise.resolve().then(async () => {
      if (!accepting) return sendEmpty(outgoing, 503);
      if (!authenticated(incoming, expectedToken)) return sendEmpty(outgoing, 404);
      let operation: Operation;
      let body: unknown;
      try {
        operation = operationFor(incoming);
        body = await readBody(incoming);
      } catch (error) {
        return sendEmpty(outgoing, error instanceof ProtocolError ? error.status : 400);
      }
      if (!accepting) return sendEmpty(outgoing, 503);
      try {
        if (operation === "create") {
          if (!hasExactKeys(body, [], ["id", "params"])) throw new ProtocolError(400);
          const value = await options.instances.create(scope, body);
          if (value.status !== "queued") throw new Error("unusable private Workflow create result");
          return sendResult(outgoing, { value: { id: value.id, status: value.status } });
        }
        if (operation === "sendEvent") {
          if (!hasExactKeys(body, ["id", "type"], ["id", "type", "payload"])) {
            throw new ProtocolError(400);
          }
          const id = validIdentifier(body.id, "instance id");
          const type = validIdentifier(body.type, "event type");
          if (Object.hasOwn(body, "payload")) {
            try {
              encodeDocument(body.payload);
            } catch (error) {
              if (error instanceof DocumentValidationError && error.kind === "too_large") {
                return sendResult(outgoing, { error: "document_too_large" });
              }
              throw new ProtocolError(400);
            }
          }
          await options.instances.sendEvent(
            scope,
            id,
            Object.hasOwn(body, "payload") ? { type, payload: body.payload } : { type },
          );
          return sendResult(outgoing, { value: {} });
        }
        if (!hasExactKeys(body, ["id"], ["id"])) throw new ProtocolError(400);
        const id = validIdentifier(body.id, "instance id");
        if (operation === "get") {
          const value = await options.instances.get(scope, id);
          return sendResult(outgoing, { value: { id: value.id } });
        }
        if (operation === "status") {
          const value = await options.instances.status(scope, id);
          return sendResult(outgoing, { value: statusValue(value) });
        }
        await options.instances.terminate(scope, id);
        return sendResult(outgoing, { value: {} });
      } catch (error) {
        if (error instanceof ProtocolError) return sendEmpty(outgoing, error.status);
        const code = domainError(operation, error);
        if (code !== null) return sendResult(outgoing, { error: code });
        return sendEmpty(outgoing, 503);
      }
    });
    requests.add(request);
    void request.finally(() => requests.delete(request)).catch(() => {});
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
  const socketIdentity = await lstat(options.socketPath);
  if (!socketIdentity.isSocket()) throw new Error("private Workflow binding listener is unusable");
  let retiring: Promise<void> | undefined;
  const retire = (): Promise<void> => {
    if (retiring) return retiring;
    accepting = false;
    retiring = (async () => {
      const listenerClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // Cut partial headers/bodies and idle keep-alive immediately. A request
      // already dispatched to `instances` is deliberately not bound to its
      // client socket: the accepted SQL effect still settles in `requests`.
      for (const socket of sockets) socket.destroy();
      await listenerClosed;
      while (requests.size > 0) await Promise.allSettled([...requests]);
      // Node usually unlinks the UDS itself. Remove only this listener's exact
      // remaining socket inode, never a replacement owned by another process.
      try {
        const current = await lstat(options.socketPath);
        if (
          current.isSocket() &&
          current.dev === socketIdentity.dev &&
          current.ino === socketIdentity.ino
        ) {
          await unlink(options.socketPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    })();
    return retiring;
  };
  return Object.freeze({ socketPath: options.socketPath, retire, close: retire });
}
