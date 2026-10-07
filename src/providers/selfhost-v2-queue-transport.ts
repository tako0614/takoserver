import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/** This is a Host-private invocation plane, not a Host API or producer Binding. */
export const V2_QUEUE_SETTLEMENT_PATH = "/.well-known/takoserver/selfhost-queue-settlement/v2";
export const V2_QUEUE_SETTLEMENT_PROTOCOL = "takoserver.selfhost-queue-settlement@v2";
export const V2_QUEUE_SETTLEMENT_CONTENT_TYPE =
  "application/vnd.takoserver.queue-settlement.v2+json";
export const V2_QUEUE_SETTLEMENT_SERVICE_MODULE = "__takoserver-v2-queue-settlement.js";
export const V2_QUEUE_SETTLEMENT_SERVICE_BINDING = "__TAKOSERVER_V2_QUEUE_SETTLEMENT";
export const V2_QUEUE_SETTLEMENT_ORIGIN_BINDING = "__TAKOSERVER_V2_QUEUE_SETTLEMENT_ORIGIN";
export const V2_QUEUE_SETTLEMENT_TOKEN_BINDING = "__TAKOSERVER_V2_QUEUE_SETTLEMENT_TOKEN";
export const V2_QUEUE_SETTLEMENT_MAX_BYTES = 8192;

/**
 * Runs in its own workerd service. Its bearer and external origin are never
 * declared on the tenant service; the tenant-facing binding is not projected
 * into env. Even if that binding leaked, this service can call only one fixed
 * private path, with a bounded body and no caller-controlled headers.
 */
export function v2QueueSettlementServiceSource(): string {
  return `const PATH = ${JSON.stringify(V2_QUEUE_SETTLEMENT_PATH)};
const TARGET_URL = ${JSON.stringify(`http://takoserver-selfhost-queue.invalid${V2_QUEUE_SETTLEMENT_PATH}`)};
const PROTOCOL = ${JSON.stringify(V2_QUEUE_SETTLEMENT_PROTOCOL)};
const CONTENT_TYPE = ${JSON.stringify(V2_QUEUE_SETTLEMENT_CONTENT_TYPE)};
const ORIGIN = ${JSON.stringify(V2_QUEUE_SETTLEMENT_ORIGIN_BINDING)};
const TOKEN = ${JSON.stringify(V2_QUEUE_SETTLEMENT_TOKEN_BINDING)};
const MAX_BYTES = ${V2_QUEUE_SETTLEMENT_MAX_BYTES};
function unavailable(status) {
  return new Response('{"ok":false,"error":{"code":"backend_unavailable"}}', {
    status, headers: { "content-type": "application/json" },
  });
}
export default {
  async fetch(request, env) {
    let path;
    try { path = new URL(request.url).pathname; } catch { return unavailable(404); }
    if (path !== PATH || request.method !== "POST" ||
        request.headers.get("content-type") !== CONTENT_TYPE ||
        request.headers.get("x-takoserver-queue-settlement") !== PROTOCOL) return unavailable(404);
    const origin = env[ORIGIN], token = env[TOKEN];
    if (!origin || typeof token !== "string" || token.length === 0) return unavailable(503);
    let body;
    try { body = await request.arrayBuffer(); } catch { return unavailable(400); }
    if (body.byteLength > MAX_BYTES) return unavailable(413);
    let response;
    try {
      response = await origin.fetch(TARGET_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": CONTENT_TYPE,
          "x-takoserver-queue-settlement": PROTOCOL,
        },
        body,
      });
    } catch { return unavailable(502); }
    let answer;
    try { answer = await response.text(); } catch { return unavailable(502); }
    if (answer.length > MAX_BYTES) return unavailable(502);
    return new Response(answer, {
      status: response.status, headers: { "content-type": "application/json" },
    });
  },
};
`;
}

export interface V2QueueDispatchGrant {
  readonly batchId: string;
  readonly messageId: string;
  readonly workerUid: string;
  readonly versionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly consumerUid: string;
  readonly queueUid: string;
  readonly generation: number;
  /** Exact per-message lease token from the registered 0082 receipt. */
  readonly leaseToken: string;
  readonly expiresAtMillis: number;
}

export interface V2QueueSettlementAuth {
  /** Resolve a live, exact owner/Version/Consumer/Queue invocation; never infer it from the body. */
  authenticate(input: {
    readonly bearer: string;
    readonly invocationCapability: string;
  }): Promise<V2QueueDispatchGrant | null>;
}

/** Owner proof is read from the exact native incarnation, never from a caller DTO. */
export interface V2QueueNativeTargetReader {
  observeQueueTarget(input: {
    readonly workerUid: string;
    readonly versionId: string;
    readonly incarnationId: string;
    readonly servingSourceOperationId: string;
  }): Promise<
    | {
        readonly kind: "confirmed";
        readonly workerUid: string;
        readonly versionId: string;
        readonly incarnationId: string;
        readonly servingSourceOperationId: string;
        readonly status: "active" | "draining";
      }
    | { readonly kind: "unknown" }
  >;
}

/** SQL proof is derived from accepted Core rows and the 0082 receipt. */
export interface V2QueueCoreScopeReader {
  verifyV2QueueSettlementScope(input: {
    readonly batchId: string;
    readonly messageId: string;
    readonly leaseToken: string;
    readonly consumerUid: string;
    readonly queueUid: string;
    readonly workerUid: string;
    readonly generation: number;
    readonly servingSourceOperationId: string;
  }): Promise<
    | {
        readonly kind: "confirmed_live" | "confirmed_receipt";
        readonly batchId: string;
        readonly messageId: string;
        readonly leaseToken: string;
        readonly consumerUid: string;
        readonly queueUid: string;
        readonly workerUid: string;
        readonly generation: number;
        readonly servingSourceOperationId: string;
      }
    | { readonly kind: "unknown" }
  >;
}

/**
 * The mandatory production verifier. Neither a caller-supplied boolean nor a
 * process Map can certify settlement: both independent owners must read back
 * their persisted scope on every request. A terminal 0082 receipt permits
 * idempotent readback, but custody alone decides whether the decision matches.
 */
export function createV2QueueSettlementScopeVerifier(input: {
  readonly native: V2QueueNativeTargetReader;
  readonly core: V2QueueCoreScopeReader;
}): (grant: V2QueueDispatchGrant) => Promise<boolean> {
  if (
    typeof input.native?.observeQueueTarget !== "function" ||
    typeof input.core?.verifyV2QueueSettlementScope !== "function"
  ) {
    throw new TypeError("v2 Queue settlement requires native and Core scope readers");
  }
  return async (grant) => {
    const native = await input.native.observeQueueTarget({
      workerUid: grant.workerUid,
      versionId: grant.versionId,
      incarnationId: grant.incarnationId,
      servingSourceOperationId: grant.servingSourceOperationId,
    });
    if (
      native.kind !== "confirmed" ||
      native.workerUid !== grant.workerUid ||
      native.versionId !== grant.versionId ||
      native.incarnationId !== grant.incarnationId ||
      native.servingSourceOperationId !== grant.servingSourceOperationId ||
      (native.status !== "active" && native.status !== "draining")
    )
      return false;
    const core = await input.core.verifyV2QueueSettlementScope({
      batchId: grant.batchId,
      messageId: grant.messageId,
      leaseToken: grant.leaseToken,
      consumerUid: grant.consumerUid,
      queueUid: grant.queueUid,
      workerUid: grant.workerUid,
      generation: grant.generation,
      servingSourceOperationId: grant.servingSourceOperationId,
    });
    return (
      (core.kind === "confirmed_live" || core.kind === "confirmed_receipt") &&
      core.batchId === grant.batchId &&
      core.messageId === grant.messageId &&
      core.leaseToken === grant.leaseToken &&
      core.consumerUid === grant.consumerUid &&
      core.queueUid === grant.queueUid &&
      core.workerUid === grant.workerUid &&
      core.generation === grant.generation &&
      core.servingSourceOperationId === grant.servingSourceOperationId
    );
  };
}

/**
 * Stateless short-lived invocation proof, backed by a boot-required private
 * key. It is not the durable authority: the required native and Core readers
 * prove the exact owner/Version/Consumer/Queue scope, and SQL checks the
 * registered 0082 receipt plus live lease on every new decision. A Host
 * restart can verify the same proof with its persisted private key; no
 * process Map becomes a ledger.
 */
export function createV2QueueSettlementAuthority(input: {
  readonly key: Uint8Array;
  readonly now: () => number;
  readonly scope: {
    readonly native: V2QueueNativeTargetReader;
    readonly core: V2QueueCoreScopeReader;
  };
}): V2QueueSettlementAuth & {
  mint(grant: V2QueueDispatchGrant): string;
  bindingToken(
    grant: Pick<V2QueueDispatchGrant, "workerUid" | "versionId" | "incarnationId">,
  ): string;
} {
  if (
    !(input.key instanceof Uint8Array) ||
    input.key.byteLength < 32 ||
    typeof input.now !== "function"
  ) {
    throw new TypeError(
      "v2 Queue settlement authority requires a private key, clock, and durable scope reader",
    );
  }
  const isLiveScope = createV2QueueSettlementScopeVerifier(input.scope);
  const key = Buffer.from(input.key);
  const mac = (domain: string, value: string): Buffer =>
    createHmac("sha256", key).update(domain, "utf8").update("\0").update(value, "utf8").digest();
  const bindingToken = (
    grant: Pick<V2QueueDispatchGrant, "workerUid" | "versionId" | "incarnationId">,
  ) => {
    if (
      [grant.workerUid, grant.versionId, grant.incarnationId].some(
        (value) => typeof value !== "string" || value.length < 1 || value.length > 256,
      )
    )
      throw new TypeError("v2 Queue binding scope is invalid");
    return mac(
      "binding/v2",
      JSON.stringify([grant.workerUid, grant.versionId, grant.incarnationId]),
    ).toString("base64url");
  };
  const validGrant = (grant: V2QueueDispatchGrant): boolean =>
    [
      grant.batchId,
      grant.messageId,
      grant.workerUid,
      grant.versionId,
      grant.incarnationId,
      grant.servingSourceOperationId,
      grant.consumerUid,
      grant.queueUid,
      grant.leaseToken,
    ].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256) &&
    Number.isSafeInteger(grant.generation) &&
    grant.generation >= 1 &&
    Number.isSafeInteger(grant.expiresAtMillis);
  return {
    bindingToken,
    mint(grant) {
      const now = input.now();
      if (
        !validGrant(grant) ||
        !Number.isSafeInteger(now) ||
        grant.expiresAtMillis <= now ||
        grant.expiresAtMillis > now + 300_000
      ) {
        throw new TypeError("v2 Queue invocation scope is invalid or expired");
      }
      const payload = Buffer.from(JSON.stringify(grant), "utf8").toString("base64url");
      return `${payload}.${mac("invocation/v2", payload).toString("base64url")}`;
    },
    async authenticate({ bearer, invocationCapability }) {
      if (
        typeof bearer !== "string" ||
        typeof invocationCapability !== "string" ||
        invocationCapability.length > 4096
      )
        return null;
      const pieces = invocationCapability.split(".");
      if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;
      const [payload, signature] = pieces as [string, string];
      let supplied: Buffer;
      let grant: V2QueueDispatchGrant;
      try {
        supplied = Buffer.from(signature, "base64url");
        grant = JSON.parse(
          Buffer.from(payload, "base64url").toString("utf8"),
        ) as V2QueueDispatchGrant;
      } catch {
        return null;
      }
      const expected = mac("invocation/v2", payload);
      if (
        supplied.byteLength !== expected.byteLength ||
        !timingSafeEqual(supplied, expected) ||
        !isRecord(grant) ||
        Object.keys(grant).length !== 11 ||
        ![
          "batchId",
          "messageId",
          "workerUid",
          "versionId",
          "incarnationId",
          "servingSourceOperationId",
          "consumerUid",
          "queueUid",
          "generation",
          "leaseToken",
          "expiresAtMillis",
        ].every((name) => Object.hasOwn(grant, name)) ||
        !validGrant(grant)
      )
        return null;
      const now = input.now();
      if (!Number.isSafeInteger(now) || grant.expiresAtMillis <= now) return null;
      const expectedBearer = Buffer.from(bindingToken(grant), "utf8");
      const suppliedBearer = Buffer.from(bearer, "utf8");
      if (
        suppliedBearer.byteLength !== expectedBearer.byteLength ||
        !timingSafeEqual(suppliedBearer, expectedBearer)
      )
        return null;
      if (!(await isLiveScope(grant))) return null;
      return grant;
    },
  };
}

/** Structural port implemented by QueueCustody once registered-receipt restore lands. */
export interface RegisteredSettlement {
  settleRegisteredBatchMessage(input: {
    readonly batchId: string;
    readonly messageId: string;
    readonly expected: {
      readonly queueId: string;
      readonly consumerId: string;
      readonly generation: number;
      readonly leaseToken: string;
    };
    readonly settlementToken: string;
    readonly decision: { readonly outcome: "ack" | "retry"; readonly delaySeconds?: number };
  }): Promise<"settled" | "already_settled" | "unknown_batch" | "unknown_message" | "unavailable">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelope(code: string, status: number): Response {
  return Response.json({ ok: false, error: { code } }, { status });
}

/**
 * The private Bun endpoint. Authentication yields a live dispatch grant; only
 * that grant supplies SQL scope. Request fields are selectors, never authority.
 */
export function createV2QueueSettlementEndpoint(input: {
  readonly custody: RegisteredSettlement;
  readonly auth: V2QueueSettlementAuth;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return envelope("backend_unavailable", 404);
    }
    if (
      request.method !== "POST" ||
      url.pathname !== V2_QUEUE_SETTLEMENT_PATH ||
      request.headers.get("content-type") !== V2_QUEUE_SETTLEMENT_CONTENT_TYPE ||
      request.headers.get("x-takoserver-queue-settlement") !== V2_QUEUE_SETTLEMENT_PROTOCOL
    )
      return envelope("backend_unavailable", 404);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return envelope("backend_unavailable", 404);
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > V2_QUEUE_SETTLEMENT_MAX_BYTES) {
      return envelope("backend_unavailable", 413);
    }
    let body: unknown;
    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > V2_QUEUE_SETTLEMENT_MAX_BYTES)
        return envelope("backend_unavailable", 413);
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return envelope("backend_unavailable", 400);
    }
    if (!isRecord(body)) return envelope("backend_unavailable", 400);
    const keys = Object.keys(body);
    if (
      (keys.length !== 7 && keys.length !== 8) ||
      ![
        "protocol",
        "invocationCapability",
        "batchId",
        "messageId",
        "leaseToken",
        "settlementToken",
        "outcome",
      ].every((key) => Object.hasOwn(body, key)) ||
      (keys.length === 8 && !Object.hasOwn(body, "delaySeconds")) ||
      body.protocol !== V2_QUEUE_SETTLEMENT_PROTOCOL ||
      typeof body.invocationCapability !== "string" ||
      body.invocationCapability.length < 32 ||
      body.invocationCapability.length > 4096 ||
      typeof body.batchId !== "string" ||
      body.batchId.length < 1 ||
      body.batchId.length > 256 ||
      typeof body.messageId !== "string" ||
      body.messageId.length < 1 ||
      body.messageId.length > 256 ||
      typeof body.leaseToken !== "string" ||
      body.leaseToken.length < 1 ||
      body.leaseToken.length > 256 ||
      typeof body.settlementToken !== "string" ||
      body.settlementToken.length < 1 ||
      body.settlementToken.length > 256 ||
      (body.outcome !== "ack" && body.outcome !== "retry") ||
      (body.delaySeconds !== undefined &&
        (!Number.isInteger(body.delaySeconds) ||
          (body.delaySeconds as number) < 0 ||
          (body.delaySeconds as number) > 43_200)) ||
      (body.outcome === "ack" && Object.hasOwn(body, "delaySeconds"))
    )
      return envelope("backend_unavailable", 400);
    let grant: V2QueueDispatchGrant | null;
    try {
      grant = await input.auth.authenticate({
        bearer: authorization.slice("Bearer ".length),
        invocationCapability: body.invocationCapability,
      });
    } catch {
      return envelope("backend_unavailable", 503);
    }
    if (!grant || grant.batchId !== body.batchId) return envelope("unknown_batch", 404);
    if (grant.messageId !== body.messageId || grant.leaseToken !== body.leaseToken)
      return envelope("unknown_message", 404);
    let result: Awaited<ReturnType<RegisteredSettlement["settleRegisteredBatchMessage"]>>;
    try {
      result = await input.custody.settleRegisteredBatchMessage({
        batchId: grant.batchId,
        messageId: body.messageId,
        expected: {
          queueId: grant.queueUid,
          consumerId: grant.consumerUid,
          generation: grant.generation,
          leaseToken: grant.leaseToken,
        },
        settlementToken: body.settlementToken,
        decision: {
          outcome: body.outcome,
          ...(body.delaySeconds === undefined ? {} : { delaySeconds: body.delaySeconds as number }),
        },
      });
    } catch {
      return envelope("backend_unavailable", 503);
    }
    if (result === "settled") return Response.json({ ok: true, value: null });
    return envelope(
      result === "unavailable" ? "backend_unavailable" : result,
      result === "unavailable" ? 503 : 409,
    );
  };
}
