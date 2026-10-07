import { timingSafeEqual } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import type {
  V2ServiceBindingClaim,
  V2ServiceBindingResolution,
} from "./takoform-v2/service-binding-authority.ts";

const TOKEN_HEADER = "x-takoserver-private-service-binding-token";
const UNAVAILABLE_HEADER = "x-takoserver-selfhost-service-unavailable";
const UNAVAILABLE_STATUS = 530;
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

export interface SelfhostV2ServiceBindingCallerLease {
  /** Exact native caller context remains pinned through request/response drain. */
  stillCurrent(): Promise<boolean>;
  release(): Promise<void>;
}

export interface SelfhostV2ServiceBindingTargetOwner {
  readonly workerResourceUid: string;
  /** Dynamically dispatches against the target Worker's current serving Deployment. */
  dispatchServiceBinding(
    request: Request,
  ):
    | { readonly kind: "not_dispatched" }
    | { readonly kind: "dispatched"; readonly response: Promise<Response> };
}

export interface SelfhostV2ServiceBindingBrokerOptions {
  readonly socketPath: string;
  /** Same secret already held by the internal Workerd service router. */
  readonly routerToken: string;
  /** Trusted router metadata carrying the caller's canonical absolute URL. */
  readonly originalUrlHeader: string;
  readonly claim: V2ServiceBindingClaim;
  readonly bindingName: string;
  readonly authority: {
    resolveCurrentBinding(
      claim: V2ServiceBindingClaim,
      bindingName: string,
    ): Promise<V2ServiceBindingResolution | null>;
  };
  /** Pins and rechecks the exact active or draining caller incarnation. */
  readonly acquireCallerLease: (
    claim: V2ServiceBindingClaim,
  ) => Promise<SelfhostV2ServiceBindingCallerLease | null>;
  /** ResourceUID-only lookup; target Deployment selection is always owner-local/current. */
  readonly ownerForResourceUid: (
    resourceUid: string,
  ) => Promise<SelfhostV2ServiceBindingTargetOwner | null>;
}

export interface SelfhostV2ServiceBindingSocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

function copyClaim(input: V2ServiceBindingClaim): V2ServiceBindingClaim {
  if (
    !input ||
    typeof input.principal !== "string" ||
    typeof input.space !== "string" ||
    typeof input.targetKey !== "string" ||
    typeof input.workerUid !== "string" ||
    typeof input.workerVersionUid !== "string" ||
    typeof input.workerVersionOperationId !== "string" ||
    typeof input.nativeVersionId !== "string" ||
    typeof input.incarnationId !== "string" ||
    typeof input.servingSourceOperationId !== "string" ||
    !Array.isArray(input.bindings) ||
    input.bindings.length === 0 ||
    input.bindings.length > 64
  ) {
    throw new TypeError("Worker service binding claim is required");
  }
  const bindings = input.bindings.map((binding) => {
    if (
      !binding ||
      typeof binding.name !== "string" ||
      !binding.name ||
      typeof binding.resourceUid !== "string" ||
      !binding.resourceUid
    ) {
      throw new TypeError("Worker service binding claim is invalid");
    }
    return Object.freeze({ name: binding.name, resourceUid: binding.resourceUid });
  });
  if (new Set(bindings.map((binding) => binding.name)).size !== bindings.length) {
    throw new TypeError("Worker service binding claim is invalid");
  }
  return Object.freeze({
    principal: input.principal,
    space: input.space,
    targetKey: input.targetKey,
    workerUid: input.workerUid,
    workerVersionUid: input.workerVersionUid,
    workerVersionOperationId: input.workerVersionOperationId,
    nativeVersionId: input.nativeVersionId,
    incarnationId: input.incarnationId,
    servingSourceOperationId: input.servingSourceOperationId,
    bindings: Object.freeze(bindings),
  });
}

function sameIdentity(
  left: V2ServiceBindingResolution["identity"],
  right: V2ServiceBindingResolution["identity"],
): boolean {
  return (
    left.targetKey === right.targetKey &&
    left.principal === right.principal &&
    left.space === right.space &&
    left.resourceUid === right.resourceUid
  );
}

function validToken(got: string | undefined, expected: string): boolean {
  if (got === undefined) return false;
  const left = Buffer.from(got);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hostFailure(): Response {
  return new Response(null, { status: 500 });
}

function responseHeaders(response: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name)) headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  return headers;
}

function waitForDrainOrClose(outgoing: ServerResponse, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolveDrain) => {
    const cleanup = () => {
      outgoing.off("drain", onDrain);
      outgoing.off("close", onClose);
      outgoing.off("error", onClose);
      signal.removeEventListener("abort", onClose);
    };
    const finish = (drained: boolean) => {
      cleanup();
      resolveDrain(drained);
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

function drainIncomingRequest(incoming: IncomingMessage): Promise<void> {
  if (incoming.complete || incoming.readableEnded || incoming.destroyed) return Promise.resolve();
  return new Promise((resolveDrain) => {
    const finish = () => {
      incoming.off("end", finish);
      incoming.off("close", finish);
      incoming.off("aborted", finish);
      incoming.off("error", finish);
      resolveDrain();
    };
    incoming.once("end", finish);
    incoming.once("close", finish);
    incoming.once("aborted", finish);
    incoming.once("error", finish);
    incoming.resume();
    if (incoming.complete || incoming.readableEnded || incoming.destroyed) finish();
  });
}

/**
 * One Host-private UDS for one immutable caller Version/service Binding.
 * It contains no public route and never selects a target from URL/Host data.
 */
export async function openSelfhostV2ServiceBindingBroker(
  options: SelfhostV2ServiceBindingBrokerOptions,
): Promise<{
  readonly socketPath: string;
  readonly identity: SelfhostV2ServiceBindingSocketIdentity;
  close(): Promise<void>;
}> {
  const claim = copyClaim(options.claim);
  const socketPath = options.socketPath;
  const routerToken = options.routerToken;
  const originalUrlHeader = options.originalUrlHeader.toLowerCase();
  const bindingName = options.bindingName;
  const resolveCurrentBinding = options.authority.resolveCurrentBinding.bind(options.authority);
  const acquireCallerLease = options.acquireCallerLease;
  const ownerForResourceUid = options.ownerForResourceUid;
  const binding = claim.bindings.find((item) => item.name === bindingName);
  if (
    !binding ||
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    socketPath.includes("\u0000") ||
    Buffer.byteLength(socketPath) > 100 ||
    typeof routerToken !== "string" ||
    !/^[0-9a-f]{64}$/u.test(routerToken) ||
    typeof originalUrlHeader !== "string" ||
    !/^[a-z0-9-]{1,128}$/u.test(originalUrlHeader) ||
    originalUrlHeader === TOKEN_HEADER
  ) {
    throw new TypeError("Worker service binding broker configuration is invalid");
  }
  const parent = dirname(socketPath);
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() ||
    (parentMetadata.mode & 0o777) !== 0o700 ||
    parentMetadata.uid !== process.getuid?.() ||
    (await realpath(parent)) !== parent
  ) {
    throw new Error("Worker service binding broker directory is unavailable");
  }
  const callerBindings = claim.bindings.filter((item) => item.name === bindingName);
  if (callerBindings.length !== 1 || callerBindings[0]?.resourceUid !== binding.resourceUid) {
    throw new TypeError("Worker service binding broker configuration is invalid");
  }

  const sockets = new Set<Socket>();
  const active = new Set<Promise<void>>();
  let closing = false;
  let uncertain = false;
  let closed: Promise<void> | undefined;
  let serverIdentity: SelfhostV2ServiceBindingSocketIdentity | undefined;

  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const task = (async () => {
      try {
        let tokenCount = 0;
        let originalUrlCount = 0;
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          if (incoming.rawHeaders[index]?.toLowerCase() === TOKEN_HEADER) tokenCount += 1;
          if (incoming.rawHeaders[index]?.toLowerCase() === originalUrlHeader)
            originalUrlCount += 1;
        }
        const offered = incoming.headers[TOKEN_HEADER];
        const suppliedOriginalUrl = incoming.headers[originalUrlHeader];
        if (
          closing ||
          uncertain ||
          tokenCount !== 1 ||
          originalUrlCount !== 1 ||
          typeof offered !== "string" ||
          !validToken(offered, routerToken) ||
          typeof suppliedOriginalUrl !== "string" ||
          suppliedOriginalUrl.length > 8192
        ) {
          outgoing.writeHead(404).end();
          return;
        }
        if (incoming.headers.upgrade || !incoming.method || !incoming.url) {
          outgoing.writeHead(501).end();
          return;
        }
        let originalUrl: URL;
        let requestUrl: URL;
        try {
          originalUrl = new URL(suppliedOriginalUrl);
          if (!incoming.url.startsWith("/") || incoming.url.startsWith("//")) {
            outgoing.writeHead(400).end();
            return;
          }
          requestUrl = new URL(incoming.url, originalUrl);
        } catch {
          outgoing.writeHead(404).end();
          return;
        }
        const requestHost = incoming.headers.host;
        if (
          originalUrl.href !== suppliedOriginalUrl ||
          (originalUrl.protocol !== "http:" && originalUrl.protocol !== "https:") ||
          !originalUrl.hostname ||
          originalUrl.username ||
          originalUrl.password ||
          originalUrl.hash ||
          requestUrl.pathname !== originalUrl.pathname ||
          requestUrl.search !== originalUrl.search ||
          typeof requestHost !== "string" ||
          requestHost.toLowerCase() !== originalUrl.host.toLowerCase()
        ) {
          outgoing.writeHead(400).end();
          return;
        }

        const abort = new AbortController();
        outgoing.once("close", () => abort.abort(new Error("service_binding_client_closed")));
        const callerLease = await acquireCallerLease(claim).catch(() => null);
        if (!callerLease) {
          outgoing.writeHead(UNAVAILABLE_STATUS, { [UNAVAILABLE_HEADER]: routerToken }).end();
          return;
        }
        try {
          const resolved = await resolveCurrentBinding(claim, bindingName).catch(() => null);
          if (
            !resolved ||
            !sameIdentity(resolved.identity, {
              targetKey: claim.targetKey,
              principal: claim.principal,
              space: claim.space,
              resourceUid: binding.resourceUid,
            }) ||
            abort.signal.aborted ||
            !(await callerLease.stillCurrent().catch(() => false)) ||
            !(await resolved.stillCurrent().catch(() => false))
          ) {
            outgoing.writeHead(UNAVAILABLE_STATUS, { [UNAVAILABLE_HEADER]: routerToken }).end();
            return;
          }

          const target = await ownerForResourceUid(binding.resourceUid).catch(() => null);
          if (
            !target ||
            target.workerResourceUid !== binding.resourceUid ||
            abort.signal.aborted ||
            !(await callerLease.stillCurrent().catch(() => false)) ||
            !(await resolved.stillCurrent().catch(() => false))
          ) {
            outgoing.writeHead(UNAVAILABLE_STATUS, { [UNAVAILABLE_HEADER]: routerToken }).end();
            return;
          }

          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index]?.toLowerCase();
            const value = incoming.rawHeaders[index + 1];
            if (
              !name ||
              value === undefined ||
              name === TOKEN_HEADER ||
              name === originalUrlHeader ||
              HOP_HEADERS.has(name)
            )
              continue;
            headers.append(name, value);
          }
          const body =
            incoming.method === "GET" || incoming.method === "HEAD"
              ? undefined
              : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
          const request = new Request(originalUrl, {
            method: incoming.method,
            headers,
            signal: abort.signal,
            redirect: "manual",
            ...(body ? { body, duplex: "half" as const } : {}),
          } as RequestInit);

          const dispatch = target.dispatchServiceBinding(request);
          if (dispatch.kind === "not_dispatched") {
            outgoing.writeHead(UNAVAILABLE_STATUS, { [UNAVAILABLE_HEADER]: routerToken }).end();
            return;
          }

          let response: Response;
          try {
            response = await dispatch.response;
          } catch {
            // The call crossed the dispatch boundary; uncertainty must not be
            // signalled as backend_unavailable, which callers may retry.
            response = hostFailure();
          }
          if (response.status === 101) {
            outgoing.writeHead(501).end();
            return;
          }
          outgoing.writeHead(response.status, responseHeaders(response));
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
              if (!outgoing.write(chunk) && !(await waitForDrainOrClose(outgoing, abort.signal)))
                break;
            }
          } finally {
            abort.signal.removeEventListener("abort", cancelBody);
            if (!responseBody.readableEnded) responseBody.destroy();
          }
          if (!outgoing.destroyed) outgoing.end();
        } finally {
          await drainIncomingRequest(incoming);
          try {
            await callerLease.release();
          } catch {
            // Never accept another call after a caller pin may have leaked.
            uncertain = true;
          }
        }
      } catch {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      }
    })();
    active.add(task);
    void task.finally(() => active.delete(task));
    await task;
  };

  const server = createServer((incoming, outgoing) => void handle(incoming, outgoing));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_incoming, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const metadata = await lstat(socketPath);
  if (!metadata.isSocket() || metadata.uid !== process.getuid?.()) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("Worker service binding broker socket ownership is invalid");
  }
  serverIdentity = { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid };

  return Object.freeze({
    socketPath,
    identity: Object.freeze({ ...serverIdentity }),
    close(): Promise<void> {
      closed ??= (async () => {
        closing = true;
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        });
        await Promise.all([...active]);
        if (sockets.size !== 0) {
          for (const socket of sockets) socket.destroy();
          await Promise.all([...active]);
        }
        const current = await lstat(socketPath).catch((error: unknown) => {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        });
        if (current && serverIdentity) {
          if (
            !current.isSocket() ||
            current.uid !== serverIdentity.uid ||
            current.dev !== serverIdentity.dev ||
            current.ino !== serverIdentity.ino
          ) {
            throw new Error("Worker service binding broker socket was replaced");
          }
          await unlink(socketPath);
        }
      })();
      return closed;
    },
  });
}
