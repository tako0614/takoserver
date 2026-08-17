import {
  type CloudflareR2BucketBinding,
  CloudflareR2ObjectStorageAdapter,
  createObjectStorageModule,
  ObjectStorageError,
  type ObjectStorageModule,
} from "./object-storage.ts";
import {
  createRuntimeGrantVerifier,
  type ExecutionGrantClaims,
  GrantVerificationError,
  type RuntimeGrantVerifier,
} from "./runtime-grants.ts";
import {
  type D1DatabasePort,
  D1GrantKeyStore,
  D1GrantReplayStore,
  D1ResourceRegistry,
  DurableStateError,
} from "./state-store.ts";

const MAX_OBJECT_BYTES = 8 * 1_024 * 1_024;
const MAX_LIST_ENTRIES = 100;
const RUNTIME_AUDIENCE = "takoserver.runtime.v1";

export interface WorkerPlatformPorts {
  readonly stateDb: D1DatabasePort;
  readonly objects: CloudflareR2BucketBinding;
}

/**
 * Complete durable slice: signed storage requests consume replay state in D1
 * before accessing the R2 binding. The remaining control plane stays fail-closed.
 */
export async function handleTakoserverWorkerRequest(
  request: Request,
  platform: WorkerPlatformPorts,
  clock: () => Date = () => new Date(),
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/v1/storage/object") {
      if (!isObjectMethod(request.method)) {
        return methodNotAllowed("PUT, GET, HEAD, DELETE");
      }
      if (request.method === "PUT") rejectDeclaredOversize(request);
      const storage = await durableObjectStorage(
        platform,
        publicOrigin(url),
        clock,
        resourceScope(url),
      );
      return await objectResponse(request, url, storage);
    }
    if (url.pathname === "/v1/storage/objects") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const storage = await durableObjectStorage(
        platform,
        publicOrigin(url),
        clock,
        resourceScope(url),
      );
      return await listResponse(request, url, storage);
    }

    return unavailableSurfaceResponse(request, url);
  } catch (error) {
    return workerErrorResponse(error, request, url.pathname);
  }
}

function isObjectMethod(value: string): value is "PUT" | "GET" | "HEAD" | "DELETE" {
  return value === "PUT" || value === "GET" || value === "HEAD" || value === "DELETE";
}

async function durableObjectStorage(
  platform: WorkerPlatformPorts,
  issuer: string,
  clock: () => Date,
  scope: {
    readonly tenantRef: string;
    readonly resourceRef: string;
  },
): Promise<ObjectStorageModule> {
  const verifier = await durableVerifier(platform.stateDb, issuer, clock, scope);
  return createObjectStorageModule({
    verifier,
    adapter: new CloudflareR2ObjectStorageAdapter(platform.objects),
    maxObjectBytes: MAX_OBJECT_BYTES,
    maxListEntries: MAX_LIST_ENTRIES,
  });
}

async function durableVerifier(
  database: D1DatabasePort,
  issuer: string,
  clock: () => Date,
  scope: { readonly tenantRef: string; readonly resourceRef: string },
): Promise<RuntimeGrantVerifier> {
  const publicKeys = await new D1GrantKeyStore(database).loadActiveKeys();
  const registry = new D1ResourceRegistry(database);
  const verifier = createRuntimeGrantVerifier({
    issuer,
    audience: RUNTIME_AUDIENCE,
    publicKeys,
    replayStore: new D1GrantReplayStore(database),
    clock,
  });
  return {
    async verifyAndConsume(token, expected): Promise<ExecutionGrantClaims> {
      const claims = await verifier.verifyAndConsume(token, expected);
      const resource = await registry.lookup({
        securityDomainId: claims.securityDomainId,
        tenantRef: scope.tenantRef,
        resourceRef: scope.resourceRef,
      });
      if (!resource) throw new GrantVerificationError("wrong_intent");
      if (
        claims.tenantRef !== resource.tenantRef ||
        claims.securityDomainId !== resource.securityDomainId ||
        claims.reservationId !== resource.reservationId ||
        claims.offeringId !== resource.offeringId ||
        claims.offeringDigest !== resource.offeringDigest
      ) {
        throw new GrantVerificationError("wrong_intent");
      }
      if (
        resource.backendId !== "cloudflare-r2-binding" ||
        !resource.allowances.some(
          (allowance) =>
            allowance.protocol === "s3" &&
            allowance.mode === "direct" &&
            allowance.authority === "resource_scoped_grant",
        )
      ) {
        throw new GrantVerificationError("wrong_operation");
      }
      return claims;
    },
  };
}

function resourceScope(url: URL): {
  readonly tenantRef: string;
  readonly resourceRef: string;
} {
  return {
    tenantRef: requiredResourceQuery(url, "tenantRef"),
    resourceRef: requiredResourceQuery(url, "resourceRef"),
  };
}

async function objectResponse(
  request: Request,
  url: URL,
  storage: ObjectStorageModule,
): Promise<Response> {
  const base = {
    grantToken: bearerToken(request),
    tenantRef: requiredQuery(url, "tenantRef"),
    resourceRef: requiredQuery(url, "resourceRef"),
    key: requiredQuery(url, "key"),
  };
  if (request.method === "PUT") {
    const contentType = request.headers.get("content-type");
    const result = await storage.execute({
      ...base,
      kind: "put",
      body: request.body ?? new ArrayBuffer(0),
      ...(contentType ? { contentType } : {}),
    });
    if (result.kind !== "put") throw new ObjectStorageError("provider_invalid_response");
    return Response.json(result, { status: 201 });
  }
  if (request.method === "GET") {
    const result = await storage.execute({ ...base, kind: "get" });
    if (result.kind !== "get") throw new ObjectStorageError("provider_invalid_response");
    if (!result.object) return objectNotFound();
    assertObjectSize(result.object.size);
    return new Response(result.object.body, {
      headers: objectHeaders(result.object),
    });
  }
  if (request.method === "HEAD") {
    const result = await storage.execute({ ...base, kind: "head" });
    if (result.kind !== "head") throw new ObjectStorageError("provider_invalid_response");
    if (!result.object) return new Response(null, { status: 404 });
    assertObjectSize(result.object.size);
    return new Response(null, { headers: objectHeaders(result.object) });
  }
  const result = await storage.execute({ ...base, kind: "delete" });
  if (result.kind !== "delete") throw new ObjectStorageError("provider_invalid_response");
  return new Response(null, { status: result.deleted ? 204 : 404 });
}

async function listResponse(
  request: Request,
  url: URL,
  storage: ObjectStorageModule,
): Promise<Response> {
  const cursor = url.searchParams.get("cursor");
  const result = await storage.execute({
    kind: "list",
    grantToken: bearerToken(request),
    tenantRef: requiredQuery(url, "tenantRef"),
    resourceRef: requiredQuery(url, "resourceRef"),
    prefix: url.searchParams.get("prefix") ?? "",
    limit: positiveInteger(url.searchParams.get("limit"), MAX_LIST_ENTRIES),
    ...(cursor ? { cursor } : {}),
  });
  if (result.kind !== "list") throw new ObjectStorageError("provider_invalid_response");
  return Response.json(result);
}

function unavailableSurfaceResponse(request: Request, url: URL): Response {
  if (request.method === "GET" && url.pathname === "/.well-known/takoserver") {
    const origin = publicOrigin(url);
    return Response.json({
      product: "takoserver",
      apiVersion: "v1",
      durability: {
        implemented: ["object-storage", "grant-replay", "resource-registry-read"],
        unavailable: ["identity", "organizations", "wallet", "reseller", "resource-runtime"],
      },
      endpoints: {
        api: origin,
        storageObject: `${origin}/v1/storage/object`,
        storageObjects: `${origin}/v1/storage/objects`,
      },
    });
  }
  if (url.pathname.startsWith("/v1/")) {
    return Response.json(
      {
        error: {
          code: "control_plane_unavailable",
          message: "durable control-plane routes are not available in this deployment slice",
        },
      },
      { status: 503 },
    );
  }
  return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ") || value.length <= "Bearer ".length) {
    throw new GrantVerificationError("malformed_grant");
  }
  return value.slice("Bearer ".length);
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) throw new ObjectStorageError("invalid_request");
  return value;
}

function requiredResourceQuery(url: URL, name: string): string {
  const value = requiredQuery(url, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) {
    throw new ObjectStorageError("invalid_request");
  }
  return value;
}

function positiveInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new ObjectStorageError("invalid_request");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LIST_ENTRIES) {
    throw new ObjectStorageError("invalid_request");
  }
  return parsed;
}

function rejectDeclaredOversize(request: Request): void {
  const value = request.headers.get("content-length");
  if (value === null) return;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new ObjectStorageError("invalid_request");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new ObjectStorageError("invalid_request");
  if (length > MAX_OBJECT_BYTES) throw new ObjectStorageError("request_too_large");
}

function assertObjectSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES) {
    throw new ObjectStorageError("provider_invalid_response");
  }
}

function objectHeaders(object: {
  readonly etag: string;
  readonly size: number;
  readonly contentType?: string;
}): Headers {
  const headers = new Headers({
    etag: httpEtag(object.etag),
    "content-length": object.size.toString(),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  if (object.contentType) headers.set("content-type", object.contentType);
  return headers;
}

function httpEtag(value: string): string {
  const opaque = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (
    opaque.length === 0 ||
    [...opaque].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x22 || codePoint === 0x7f;
    })
  ) {
    throw new ObjectStorageError("provider_invalid_response");
  }
  return `"${opaque}"`;
}

function publicOrigin(url: URL): string {
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return `https://${url.host}`;
  }
  throw new ObjectStorageError("invalid_request");
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: { code: "method_not_allowed", message: "method not allowed" } },
    { status: 405, headers: { allow } },
  );
}

function objectNotFound(): Response {
  return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
}

function workerErrorResponse(error: unknown, request: Request, path: string): Response {
  if (error instanceof GrantVerificationError) {
    return Response.json(
      { error: { code: error.code, message: "execution grant rejected" } },
      { status: 401 },
    );
  }
  if (error instanceof ObjectStorageError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof DurableStateError) {
    if (error.code === "resource_not_found") {
      return Response.json(
        { error: { code: "execution_grant_rejected", message: "execution grant rejected" } },
        { status: 401 },
      );
    }
    console.error(
      JSON.stringify({
        event: "takoserver.worker.state_unavailable",
        requestId: crypto.randomUUID(),
        method: request.method,
        path,
        errorKind: error.code,
      }),
    );
    return Response.json(
      { error: { code: "state_unavailable", message: "durable state unavailable" } },
      { status: 503 },
    );
  }
  console.error(
    JSON.stringify({
      event: "takoserver.worker.unhandled_error",
      requestId: crypto.randomUUID(),
      method: request.method,
      path,
      errorKind: error instanceof Error ? error.name : "unknown",
    }),
  );
  return Response.json(
    { error: { code: "internal_error", message: "internal error" } },
    { status: 500 },
  );
}
