import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isJsonObject } from "../json.ts";
import type {
  createDockerHttpRevisionRuntime,
  DockerHttpRevision,
  DockerHttpRevisionObservation,
} from "./docker-http-revision.ts";
import {
  createHttpRevisionServing,
  type HttpRevisionBackendObservation,
  type HttpRevisionServingBackend,
  type HttpRevisionServingCoordinator,
  type HttpRevisionServingIdentity,
  type HttpRevisionServingObservation,
  type HttpRevisionServingSnapshot,
  type HttpRevisionServingStatePort,
} from "./http-revision-serving.ts";
import {
  nodeSelfhostScriptStateFileSystem as files,
  type SelfhostScriptStateFileSystem,
} from "./selfhost-script-state.ts";

export interface SelfhostContainerIdentity extends HttpRevisionServingIdentity {}

export interface SelfhostContainerRevision extends DockerHttpRevision {
  readonly generation: number;
}

export interface SelfhostContainerObservation extends HttpRevisionServingObservation {}

export class SelfhostContainerError extends Error {
  constructor(
    readonly code: "invalid_request" | "conflict" | "unavailable" | "corrupt" | "closed",
  ) {
    super(`selfhost_container_${code}`);
    this.name = "SelfhostContainerError";
  }
}

type Snapshot = HttpRevisionServingSnapshot<SelfhostContainerRevision, string>;
type Backend = ReturnType<typeof createDockerHttpRevisionRuntime>;
type ServingBackend = HttpRevisionServingBackend<SelfhostContainerRevision, string, string>;
type ServingCoordinator = HttpRevisionServingCoordinator<SelfhostContainerRevision>;

interface Root {
  path: string;
  backend: Backend;
  drainMs: number;
  transport: (request: Request) => Promise<Response>;
  references: number;
  stopping: boolean;
  files: SelfhostScriptStateFileSystem;
  serving: ServingCoordinator;
}

const roots = new Map<string, Root>();
// A transparent proxy retains the encoded body and its original wire headers.
const nativeFetch = (request: Request) => fetch(request, { decompress: false });
const snapshotLimit = 8 * 1024 * 1024;

/**
 * Provider-private local execution/routing state, not a Form or control-plane
 * Deployment ledger. The caller owns admission and generation authority.
 * One supervisor process owns a dedicated root. Handles in that process share
 * locks and call leases; this does not provide multi-process fencing.
 * Pending intent resumes on reconcile/remove; recorded retirements resume when
 * the exact incarnation is next loaded. No Docker object enumeration occurs.
 */
export async function createSelfhostContainerRuntime(options: {
  readonly root: string;
  readonly backend: Backend;
  readonly drainTimeoutMs: number;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly fileSystem?: SelfhostScriptStateFileSystem;
}) {
  if (!positive(options.drainTimeoutMs) || options.drainTimeoutMs > 60_000) fail("invalid_request");
  const requested = resolve(options.root);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const path = await realpath(requested);
  await chmod(path, 0o700);
  if (((await lstat(path)).mode & 0o077) !== 0) fail("unavailable");
  const transport = options.fetch ?? nativeFetch;
  let root = roots.get(path);
  if (
    root &&
    (root.backend !== options.backend ||
      root.drainMs !== options.drainTimeoutMs ||
      root.transport !== transport ||
      root.stopping ||
      root.files !== (options.fileSystem ?? files))
  )
    fail("conflict");
  if (!root) {
    const next: Omit<Root, "serving"> & { serving?: ServingCoordinator } = {
      path,
      backend: options.backend,
      drainMs: options.drainTimeoutMs,
      transport,
      references: 0,
      stopping: false,
      files: options.fileSystem ?? files,
    };
    const state: HttpRevisionServingStatePort<SelfhostContainerRevision, string> = {
      load(identity) {
        return loadSnapshot(next as Root, identity);
      },
      persist(identity, snapshot) {
        return persistSnapshot(next as Root, identity, snapshot);
      },
    };
    const backend: ServingBackend = {
      async observe(input) {
        return mapObservation(await next.backend.observe(input));
      },
      async reconcile(input) {
        return mapObservation(await next.backend.reconcile(input));
      },
      invoke(input, request, invocation) {
        if (typeof invocation.context !== "string") fail("unavailable");
        return invokeNative(next as Root, input, request, invocation.context, invocation.signal);
      },
      retire(input, nativeId) {
        return next.backend.remove(input, nativeId);
      },
    };
    next.serving = createHttpRevisionServing({
      backend,
      state,
      drainTimeoutMs: options.drainTimeoutMs,
      validateRevision: validateInput,
      validateSnapshot: (snapshot) => {
        const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
        if (bytes.byteLength > snapshotLimit) fail("invalid_request");
      },
      createError: (code) => new SelfhostContainerError(code),
    });
    root = next as Root;
    roots.set(path, root);
  }
  const shared = root;
  shared.references++;
  const handle = shared.serving.open();
  let closing: Promise<void> | undefined;
  return {
    reconcile(input: SelfhostContainerRevision): Promise<SelfhostContainerObservation> {
      return handle.reconcile(input);
    },
    observe(identity: SelfhostContainerIdentity): Promise<SelfhostContainerObservation> {
      return handle.observe(identity);
    },
    fetch(identity: SelfhostContainerIdentity, request: Request): Promise<Response> {
      return handle.invoke(identity, request);
    },
    remove(identity: SelfhostContainerIdentity): Promise<SelfhostContainerObservation> {
      return handle.remove(identity);
    },
    close(): Promise<void> {
      if (closing) return closing;
      shared.references--;
      if (shared.references === 0) shared.stopping = true;
      closing = (async () => {
        await handle.close();
        if (shared.references === 0) roots.delete(path);
      })();
      return closing;
    },
  };
}

function mapObservation(
  observation: DockerHttpRevisionObservation,
): HttpRevisionBackendObservation<string, string> {
  if (observation.state === "absent") return { state: "absent" };
  if (observation.state === "ready") {
    return {
      state: "ready",
      nativeId: observation.nativeId,
      context: observation.endpoint,
    };
  }
  return { state: observation.state, nativeId: observation.nativeId };
}

async function loadSnapshot(
  root: Root,
  identity: HttpRevisionServingIdentity,
): Promise<Snapshot | null> {
  const key = identityKey(identity);
  const filename = snapshotPath(root, key);
  try {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
      fail("corrupt");
    const bytes = await root.files.read(filename);
    if (!bytes || bytes.byteLength > snapshotLimit) fail("corrupt");
    return decodeSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), key);
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof SelfhostContainerError) throw error;
    fail("corrupt");
  }
}

async function persistSnapshot(
  root: Root,
  identity: HttpRevisionServingIdentity,
  state: Snapshot,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  const filename = snapshotPath(root, identityKey(identity));
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await root.files.openExclusive(temporary);
  try {
    await file.write(bytes);
    await file.sync();
    await file.close();
    await root.files.replace(temporary, filename);
    await root.files.syncDirectory(join(filename, ".."));
  } catch {
    await file.close().catch(() => undefined);
    fail("unavailable");
  } finally {
    await root.files.remove(temporary).catch(() => undefined);
  }
}

function snapshotPath(root: Root, key: string): string {
  return join(root.path, `${createHash("sha256").update(key).digest("hex")}.json`);
}

async function invokeNative(
  root: Root,
  _revision: SelfhostContainerRevision,
  request: Request,
  endpoint: string,
  signal: AbortSignal,
): Promise<Response> {
  let source: URL;
  let target: URL;
  try {
    source = new URL(request.url);
    target = new URL(endpoint);
  } catch {
    fail("unavailable");
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    fail("unavailable");
  target.pathname = source.pathname;
  target.search = source.search;
  const response = await root.transport(
    new Request(target, {
      method: request.method,
      headers: endToEndHeaders(request.headers),
      body: request.body,
      redirect: "manual",
      signal,
      ...({ duplex: "half" } as { duplex: "half" }),
    }),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: endToEndHeaders(response.headers),
  });
}

function endToEndHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of (headers.get("connection") ?? "").split(","))
    if (name.trim()) headers.delete(name.trim());
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
  ])
    headers.delete(name);
  return headers;
}

function identityKey(identity: HttpRevisionServingIdentity): string {
  if (
    !identity ||
    typeof identity.resourceUid !== "string" ||
    identity.resourceUid.length < 1 ||
    identity.resourceUid.length > 256 ||
    typeof identity.incarnationId !== "string" ||
    identity.incarnationId.length < 1 ||
    identity.incarnationId.length > 256
  )
    fail("invalid_request");
  return JSON.stringify([identity.resourceUid, identity.incarnationId]);
}

function validateInput(input: SelfhostContainerRevision): SelfhostContainerRevision {
  identityKey(input);
  if (
    !closedKeys(input, [
      "resourceUid",
      "incarnationId",
      "generation",
      "revision",
      "image",
      "port",
      "healthPath",
      "memoryBytes",
      "nanoCpus",
      "environment",
    ]) ||
    !positive(input.generation) ||
    typeof input.revision !== "string" ||
    !input.revision.length ||
    input.revision.length > 256 ||
    typeof input.image !== "string" ||
    input.image.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(input.image) ||
    !positive(input.port) ||
    input.port > 65535 ||
    !positive(input.memoryBytes) ||
    !positive(input.nanoCpus) ||
    typeof input.healthPath !== "string" ||
    !/^\/(?!\/)[^\s#]*$/u.test(input.healthPath) ||
    input.healthPath.includes("\\") ||
    input.healthPath.length > 1024 ||
    !isJsonObject(input.environment) ||
    Object.keys(input.environment).length > 128 ||
    Object.entries(input.environment).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        value.length > 8192,
    )
  )
    fail("invalid_request");
  return input;
}

function decodeSnapshot(value: unknown, key: string): Snapshot {
  try {
    if (
      !isJsonObject(value) ||
      !closedKeys(value, ["version", "desired", "serving", "deleting", "deleted", "revisions"]) ||
      value.version !== 1 ||
      !positive(value.desired) ||
      (value.serving !== null && !positive(value.serving)) ||
      typeof value.deleting !== "boolean" ||
      typeof value.deleted !== "boolean" ||
      !Array.isArray(value.revisions) ||
      !value.revisions.length
    )
      fail("corrupt");
    const snapshot = value as unknown as Snapshot;
    let generation = 0;
    const names = new Set<string>();
    for (const revision of snapshot.revisions) {
      if (
        !isJsonObject(revision) ||
        !closedKeys(revision, ["input", "nativeId", "retireAt", "absent", "creating"]) ||
        typeof revision.absent !== "boolean" ||
        typeof revision.creating !== "boolean" ||
        (revision.absent && revision.creating) ||
        (revision.nativeId !== null &&
          (typeof revision.nativeId !== "string" || !/^[a-f0-9]{64}$/u.test(revision.nativeId))) ||
        (revision.retireAt !== null &&
          (!Number.isSafeInteger(revision.retireAt) || revision.retireAt < 0))
      )
        fail("corrupt");
      validateInput(revision.input);
      if (
        identityKey(revision.input) !== key ||
        revision.input.generation <= generation ||
        names.has(revision.input.revision)
      )
        fail("corrupt");
      generation = revision.input.generation;
      names.add(revision.input.revision);
    }
    if (
      snapshot.desired !== generation ||
      (snapshot.deleting && snapshot.serving !== null) ||
      (snapshot.deleted &&
        (!snapshot.deleting || snapshot.revisions.some((revision) => !revision.absent)))
    )
      fail("corrupt");
    if (snapshot.serving !== null) {
      const serving = revisionOf(snapshot, snapshot.serving);
      if (serving.absent || serving.nativeId === null || serving.retireAt !== null) fail("corrupt");
    }
    for (const revision of snapshot.revisions) {
      if (
        (revision.absent ||
          snapshot.deleting ||
          (revision.input.generation !== snapshot.desired &&
            revision.input.generation !== snapshot.serving)) &&
        revision.retireAt === null
      )
        fail("corrupt");
    }
    if (!snapshot.deleting) {
      const desired = revisionOf(snapshot, snapshot.desired);
      if (desired.absent || desired.retireAt !== null) fail("corrupt");
    }
    return snapshot;
  } catch {
    fail("corrupt");
  }
}

function revisionOf(snapshot: Snapshot, generation: number): Snapshot["revisions"][number] {
  const revision = snapshot.revisions.find((entry) => entry.input.generation === generation);
  if (!revision) fail("corrupt");
  return revision;
}

function closedKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function fail(code: SelfhostContainerError["code"]): never {
  throw new SelfhostContainerError(code);
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
