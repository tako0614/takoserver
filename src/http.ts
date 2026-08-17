import { AiGatewayError, type AiGatewayModule } from "./ai-gateway.ts";
import type { JsonObject } from "./backends.ts";
import type {
  ApiKeyScope,
  IdentityProvider,
  TakoserverCommand,
  TakoserverModule,
} from "./contracts.ts";
import { TakoserverError } from "./contracts.ts";
import { ObjectStorageError, type ObjectStorageModule } from "./object-storage.ts";
import { openApiDocument } from "./openapi.ts";
import type { ResourceRuntime } from "./resource-runtime.ts";
import { RuntimeExecutionError } from "./resource-runtime.ts";
import { type ExecutionOperation, GrantVerificationError } from "./runtime-grants.ts";
import { type TakoformHost, TakoformHostError } from "./takoform/types.ts";

const TAKOFORM_PROVIDER_V21_VERSION = "v1beta1";
const TAKOFORM_CURRENT_VERSION = "v1alpha3";
const TAKOFORM_PROVIDER_V21_PATH = `/apis/forms.takoform.com/${TAKOFORM_PROVIDER_V21_VERSION}`;
const TAKOFORM_CURRENT_PATH = `/apis/forms.takoform.com/${TAKOFORM_CURRENT_VERSION}`;

export interface HttpHandlerOptions {
  readonly server: TakoserverModule;
  readonly runtime?: ResourceRuntime;
  readonly publicOrigin: string;
  readonly takoformHost?: TakoformHost;
  readonly objectStorage?: ObjectStorageModule;
  readonly aiGateway?: AiGatewayModule;
}

export function createHttpHandler(
  options: HttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const publicOrigin = origin(options.publicOrigin);
  return async (request) => {
    try {
      return await route(options, publicOrigin, request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

async function route(
  options: HttpHandlerOptions,
  publicOrigin: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/") {
    return new Response(CONSOLE_HTML, {
      headers: {
        "content-type": "text/html; charset=UTF-8",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method === "GET" && path === "/openapi.json") return Response.json(openApiDocument);
  if (request.method === "GET" && path === "/v1/identity/providers") {
    return Response.json({ providers: ["google", "github"] });
  }
  if (request.method === "GET" && path === "/.well-known/takoserver") {
    return Response.json({
      product: "takoserver",
      apiVersion: "v1",
      identityProviders: ["google", "github"],
      endpoints: {
        api: publicOrigin,
        console: publicOrigin,
        openapi: `${publicOrigin}/openapi.json`,
        takoform: `${publicOrigin}/.well-known/takoform/${TAKOFORM_PROVIDER_V21_VERSION}`,
        takoformCurrent: `${publicOrigin}/.well-known/takoform/${TAKOFORM_CURRENT_VERSION}`,
      },
    });
  }
  if (
    request.method === "GET" &&
    (path === `/.well-known/takoform/${TAKOFORM_PROVIDER_V21_VERSION}` ||
      path === `/.well-known/takoform/${TAKOFORM_CURRENT_VERSION}`)
  ) {
    if (!options.takoformHost) {
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    }
    const version = path.endsWith(`/${TAKOFORM_PROVIDER_V21_VERSION}`)
      ? TAKOFORM_PROVIDER_V21_VERSION
      : TAKOFORM_CURRENT_VERSION;
    const api = `${publicOrigin}/apis/forms.takoform.com/${version}`;
    return Response.json({
      api_versions: [`forms.takoform.com/${version}`],
      features: {
        service_forms: true,
        exact_form_ref: true,
        optimistic_concurrency: true,
        idempotent_lifecycle: true,
        operations: true,
        artifact_upload: true,
        support_profiles: true,
      },
      endpoints: {
        api,
        artifacts: `${api}/artifacts`,
        operations: `${api}/operations`,
        support: `${api}/support`,
      },
    });
  }
  if (path.startsWith(TAKOFORM_CURRENT_PATH) || path.startsWith(TAKOFORM_PROVIDER_V21_PATH)) {
    try {
      const response = await options.takoformHost?.handle(
        path.startsWith(TAKOFORM_PROVIDER_V21_PATH) ? currentTakoformRequest(request) : request,
      );
      if (response) return response;
      return takoformFailure("backend_unavailable", 503);
    } catch (error) {
      if (error instanceof TakoformHostError) {
        return takoformFailure(error.code, error.status);
      }
      return takoformFailure("internal_error", 500);
    }
  }
  if (request.method === "POST" && path === "/v1/sessions") {
    const body = await requestBody(request, ["provider", "assertion"]);
    return commandResponse(
      options.server,
      {
        kind: "identity.exchange",
        provider: enumValue(body.provider, ["google", "github"]) as IdentityProvider,
        assertion: stringValue(body.assertion),
      },
      200,
    );
  }
  if (request.method === "POST" && path === "/v1/organizations") {
    const body = await requestBody(request, ["name"]);
    return commandResponse(
      options.server,
      {
        kind: "organization.create",
        authorization: authorization(request),
        name: stringValue(body.name),
      },
      201,
    );
  }
  let match = /^\/v1\/organizations\/([^/]+)\/api-keys$/u.exec(path);
  if (request.method === "POST" && match?.[1]) {
    const body = await requestBody(request, ["name", "scopes", "expiresInSeconds"]);
    return commandResponse(
      options.server,
      {
        kind: "api-key.create",
        authorization: authorization(request),
        organizationId: segment(match[1]),
        name: stringValue(body.name),
        scopes: stringArray(body.scopes) as readonly ApiKeyScope[],
        expiresInSeconds: numberValue(body.expiresInSeconds),
      },
      201,
    );
  }
  match = /^\/v1\/organizations\/([^/]+)\/api-keys\/([^/]+)$/u.exec(path);
  if (request.method === "DELETE" && match?.[1] && match[2]) {
    return commandResponse(options.server, {
      kind: "api-key.revoke",
      authorization: authorization(request),
      organizationId: segment(match[1]),
      apiKeyId: segment(match[2]),
    });
  }
  match = /^\/v1\/organizations\/([^/]+)\/wallet$/u.exec(path);
  if (request.method === "GET" && match?.[1]) {
    return commandResponse(options.server, {
      kind: "wallet.get",
      authorization: authorization(request),
      organizationId: segment(match[1]),
    });
  }
  match = /^\/v1\/organizations\/([^/]+)\/wallet\/funding$/u.exec(path);
  if (request.method === "POST" && match?.[1]) {
    const body = await requestBody(request, ["settlementProof"]);
    return commandResponse(options.server, {
      kind: "wallet.fund",
      authorization: authorization(request),
      organizationId: segment(match[1]),
      settlementProof: stringValue(body.settlementProof),
      idempotencyKey: idempotency(request),
    });
  }
  if (request.method === "GET" && path === "/v1/catalog") {
    return commandResponse(options.server, {
      kind: "catalog.list",
      authorization: authorization(request),
      organizationId: requiredQuery(url, "organizationId"),
    });
  }
  if (path === "/v1/storage/object") {
    const storage = requiredObjectStorage(options.objectStorage);
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
        body: await request.arrayBuffer(),
        ...(contentType ? { contentType } : {}),
      });
      if (result.kind !== "put") throw new ObjectStorageError("provider_invalid_response");
      return Response.json(result, { status: 201 });
    }
    if (request.method === "GET") {
      const result = await storage.execute({ ...base, kind: "get" });
      if (result.kind !== "get") throw new ObjectStorageError("provider_invalid_response");
      if (!result.object)
        return Response.json(
          { error: { code: "not_found", message: "not found" } },
          { status: 404 },
        );
      return new Response(result.object.body, {
        headers: {
          etag: result.object.etag,
          "content-length": result.object.size.toString(),
          ...(result.object.contentType ? { "content-type": result.object.contentType } : {}),
        },
      });
    }
    if (request.method === "HEAD") {
      const result = await storage.execute({ ...base, kind: "head" });
      if (result.kind !== "head") throw new ObjectStorageError("provider_invalid_response");
      if (!result.object) return new Response(null, { status: 404 });
      return new Response(null, {
        headers: { etag: result.object.etag, "content-length": result.object.size.toString() },
      });
    }
    if (request.method === "DELETE") {
      const result = await storage.execute({ ...base, kind: "delete" });
      if (result.kind !== "delete") throw new ObjectStorageError("provider_invalid_response");
      return new Response(null, { status: result.deleted ? 204 : 404 });
    }
  }
  if (request.method === "GET" && path === "/v1/storage/objects") {
    const cursor = url.searchParams.get("cursor");
    const result = await requiredObjectStorage(options.objectStorage).execute({
      kind: "list",
      grantToken: bearerToken(request),
      tenantRef: requiredQuery(url, "tenantRef"),
      resourceRef: requiredQuery(url, "resourceRef"),
      prefix: url.searchParams.get("prefix") ?? "",
      limit: optionalPositiveInteger(url.searchParams.get("limit"), 100),
      ...(cursor ? { cursor } : {}),
    });
    if (result.kind !== "list") throw new ObjectStorageError("provider_invalid_response");
    return Response.json(result);
  }
  if (request.method === "GET" && path === "/v1/ai/models") {
    const result = await requiredAiGateway(options.aiGateway).execute({
      kind: "models.list",
      grantToken: bearerToken(request),
      tenantRef: requiredQuery(url, "tenantRef"),
      resourceRef: requiredQuery(url, "resourceRef"),
    });
    if (result.kind !== "models.list") throw new AiGatewayError("invalid_response");
    return Response.json(result.response);
  }
  if (request.method === "POST" && path === "/v1/ai/chat/completions") {
    const body = await requestBodyUnclosed(request);
    const result = await requiredAiGateway(options.aiGateway).execute({
      kind: "chat.completions",
      grantToken: bearerToken(request),
      tenantRef: requiredQuery(url, "tenantRef"),
      resourceRef: requiredQuery(url, "resourceRef"),
      request: body as never,
    });
    if (result.kind !== "chat.completions") throw new AiGatewayError("invalid_response");
    return Response.json(result.response, {
      headers: { "x-takoserver-usage": btoa(JSON.stringify(result.usageReceipt)) },
    });
  }
  if (request.method === "POST" && path === "/v1/reseller/quotes") {
    const body = await requestBody(request, [
      "organizationId",
      "tenantRef",
      "offeringId",
      "quantity",
    ]);
    return commandResponse(
      options.server,
      {
        kind: "reseller.quote",
        authorization: authorization(request),
        organizationId: stringValue(body.organizationId),
        tenantRef: stringValue(body.tenantRef),
        offeringId: stringValue(body.offeringId),
        quantity: numberValue(body.quantity),
        idempotencyKey: idempotency(request),
      },
      201,
    );
  }
  if (request.method === "POST" && path === "/v1/reseller/reservations") {
    const body = await requestBody(request, ["organizationId", "tenantRef", "quoteId"]);
    return commandResponse(
      options.server,
      {
        kind: "reseller.reserve",
        authorization: authorization(request),
        organizationId: stringValue(body.organizationId),
        tenantRef: stringValue(body.tenantRef),
        quoteId: stringValue(body.quoteId),
        idempotencyKey: idempotency(request),
      },
      201,
    );
  }
  match = /^\/v1\/reseller\/reservations\/([^/]+)\/(grants|capture|release)$/u.exec(path);
  if (request.method === "POST" && match?.[1] && match[2]) {
    const reservationId = segment(match[1]);
    if (match[2] === "grants") {
      const body = await requestBody(request, [
        "organizationId",
        "tenantRef",
        "operation",
        "intent",
        "expiresInSeconds",
      ]);
      return commandResponse(
        options.server,
        {
          kind: "reseller.grant",
          authorization: authorization(request),
          organizationId: stringValue(body.organizationId),
          tenantRef: stringValue(body.tenantRef),
          reservationId,
          operation: enumValue(body.operation, [
            "resource.provision",
            "resource.delete",
            "ai.invoke",
            "s3.access",
          ]) as ExecutionOperation,
          intent: recordValue(body.intent) as JsonObject,
          expiresInSeconds: numberValue(body.expiresInSeconds),
          idempotencyKey: idempotency(request),
        },
        201,
      );
    }
    if (match[2] === "capture") {
      const body = await requestBody(request, ["organizationId", "tenantRef", "usage"]);
      const usage = recordValue(body.usage);
      exactKeys(usage, ["meter", "quantity"]);
      return commandResponse(options.server, {
        kind: "reseller.capture",
        authorization: authorization(request),
        organizationId: stringValue(body.organizationId),
        tenantRef: stringValue(body.tenantRef),
        reservationId,
        usage: { meter: stringValue(usage.meter), quantity: numberValue(usage.quantity) },
        idempotencyKey: idempotency(request),
      });
    }
    const body = await requestBody(request, ["organizationId", "tenantRef"]);
    return commandResponse(options.server, {
      kind: "reseller.release",
      authorization: authorization(request),
      organizationId: stringValue(body.organizationId),
      tenantRef: stringValue(body.tenantRef),
      reservationId,
      idempotencyKey: idempotency(request),
    });
  }
  match = /^\/v1\/reseller\/reservations\/([^/]+)\/usage-statement$/u.exec(path);
  if (request.method === "GET" && match?.[1]) {
    return commandResponse(options.server, {
      kind: "usage.get",
      authorization: authorization(request),
      organizationId: requiredQuery(url, "organizationId"),
      tenantRef: requiredQuery(url, "tenantRef"),
      reservationId: segment(match[1]),
    });
  }
  if (request.method === "POST" && path === "/v1/resources") {
    const body = await requestBody(request, ["name", "space", "spec"]);
    const runtime = requiredRuntime(options.runtime);
    const result = await runtime.execute({
      kind: "resource.provision",
      grantToken: bearerToken(request),
      name: stringValue(body.name),
      space: stringValue(body.space),
      spec: recordValue(body.spec) as JsonObject,
      idempotencyKey: idempotency(request),
    });
    return Response.json(result, { status: 201 });
  }
  return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
}

/**
 * Provider v2.1.1 speaks the published v1beta1 Host lane. The current host
 * engine is wire-compatible with that lane and owns one implementation; only
 * the lane's versioned HTTP mount differs. FormRef values are never rewritten.
 */
function currentTakoformRequest(request: Request): Request {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(TAKOFORM_PROVIDER_V21_PATH)) return request;
  url.pathname = `${TAKOFORM_CURRENT_PATH}${url.pathname.slice(TAKOFORM_PROVIDER_V21_PATH.length)}`;
  return new Request(url, request);
}

async function commandResponse(
  server: TakoserverModule,
  command: TakoserverCommand,
  status = 200,
): Promise<Response> {
  return Response.json(await server.execute(command), { status });
}

async function requestBody(
  request: Request,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    invalidRequest();
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 65_536) invalidRequest();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > 65_536) invalidRequest();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    invalidRequest();
  }
  const record = recordValue(value);
  exactKeys(record, keys);
  return record;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) invalidRequest();
}

function authorization(request: Request): string {
  const value = request.headers.get("authorization");
  if (!value) throw new TakoserverError("unauthenticated", 401);
  return value;
}

function bearerToken(request: Request): string {
  const match = /^Bearer ([^\s]+)$/u.exec(authorization(request));
  if (!match?.[1]) throw new TakoserverError("unauthenticated", 401);
  return match[1];
}

function idempotency(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value) invalidRequest();
  return value;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) invalidRequest();
  return value;
}

function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    invalidRequest();
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidRequest();
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") invalidRequest();
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number") invalidRequest();
  return value;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) invalidRequest();
  return value;
}

function enumValue(value: unknown, allowed: readonly string[]): string {
  const found = stringValue(value);
  if (!allowed.includes(found)) invalidRequest();
  return found;
}

function requiredRuntime(runtime: ResourceRuntime | undefined): ResourceRuntime {
  if (!runtime) throw new RuntimeExecutionError("backend_unavailable", 503);
  return runtime;
}

function requiredObjectStorage(storage: ObjectStorageModule | undefined): ObjectStorageModule {
  if (!storage) throw new ObjectStorageError("provider_unavailable");
  return storage;
}

function requiredAiGateway(gateway: AiGatewayModule | undefined): AiGatewayModule {
  if (!gateway) throw new AiGatewayError("upstream_unavailable");
  return gateway;
}

function optionalPositiveInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) invalidRequest();
  return Number(value);
}

async function requestBodyUnclosed(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    invalidRequest();
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > 131_072) invalidRequest();
  try {
    return recordValue(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    invalidRequest();
  }
}

function invalidRequest(): never {
  throw new TakoserverError("invalid_argument", 400);
}

function errorResponse(error: unknown): Response {
  if (error instanceof TakoformHostError) {
    return takoformFailure(error.code, error.status);
  }
  if (error instanceof TakoserverError || error instanceof RuntimeExecutionError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof ObjectStorageError || error instanceof AiGatewayError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof GrantVerificationError) {
    return Response.json(
      { error: { code: error.code, message: "execution grant rejected" } },
      { status: 401 },
    );
  }
  return Response.json(
    { error: { code: "internal_error", message: "internal error" } },
    { status: 500 },
  );
}

function takoformFailure(code: string, status: number): Response {
  return Response.json(
    {
      error: {
        code,
        message: code.replaceAll("_", " "),
        requestId: `req_${crypto.randomUUID()}`,
        retryable: [
          "resource_busy",
          "backend_unavailable",
          "rate_limited",
          "deadline_exceeded",
        ].includes(code),
      },
    },
    { status },
  );
}

function origin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("publicOrigin must be HTTPS unless it is loopback");
  }
  return url.origin;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Takoserver Console</title>
<style>body{font-family:ui-sans-serif,system-ui;max-width:42rem;margin:12vh auto;padding:0 1.5rem;background:#faf8f3;color:#17211c}h1{font-size:3rem;margin-bottom:.25rem}p{line-height:1.6}.providers{display:flex;gap:.75rem;margin-top:2rem}.providers span{border:1px solid #8b978f;border-radius:999px;padding:.6rem 1rem}</style>
<main><h1>Takoserver</h1><p>Independent compute, storage, and AI resources with prepaid billing.</p><p>Sign in directly with an identity you already use.</p><div class="providers"><span>Google</span><span>GitHub</span></div></main>
</html>`;
