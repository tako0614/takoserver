import { expect, test } from "bun:test";
import {
  SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
  selfhostV2QueueCompletionAnswer,
} from "../src/providers/selfhost-events.ts";
import {
  createV2QueueSettlementAuthority,
  createV2QueueSettlementEndpoint,
  V2_QUEUE_SETTLEMENT_CONTENT_TYPE,
  V2_QUEUE_SETTLEMENT_PATH,
  V2_QUEUE_SETTLEMENT_PROTOCOL,
  v2QueueSettlementServiceSource,
} from "../src/providers/selfhost-v2-queue-transport.ts";
import { v2QueueId } from "../src/takoform-v2/worker-queue-delivery.ts";

const grant = {
  batchId: "batch-1",
  messageId: "message-1",
  workerUid: "worker-uid-1",
  versionId: "version-uid-1",
  incarnationId: "owner-incarnation-1",
  servingSourceOperationId: "serving-op-1",
  consumerUid: "consumer-uid-1",
  queueUid: "queue-uid-1",
  generation: 7,
  leaseToken: "lease-1",
};

function request(overrides: Record<string, unknown> = {}, bearer = "owner-version-token"): Request {
  return new Request(`http://private.invalid${V2_QUEUE_SETTLEMENT_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": V2_QUEUE_SETTLEMENT_CONTENT_TYPE,
      "x-takoserver-queue-settlement": V2_QUEUE_SETTLEMENT_PROTOCOL,
    },
    body: JSON.stringify({
      protocol: V2_QUEUE_SETTLEMENT_PROTOCOL,
      invocationCapability: "a".repeat(64),
      batchId: "batch-1",
      messageId: "message-1",
      leaseToken: "lease-1",
      settlementToken: "settlement-1",
      outcome: "ack",
      ...overrides,
    }),
  });
}

test("private settlement derives exact SQL scope from authenticated live grant", async () => {
  const calls: unknown[] = [];
  const endpoint = createV2QueueSettlementEndpoint({
    queueIdForUid: v2QueueId,
    auth: {
      async authenticate(input) {
        return input.bearer === "owner-version-token" &&
          input.invocationCapability === "a".repeat(64)
          ? grant
          : null;
      },
    },
    custody: {
      async settleRegisteredBatchMessage(input) {
        calls.push(input);
        return input.messageId === "message-1" ? "settled" : "unknown_message";
      },
    },
  });
  expect((await endpoint(request())).status).toBe(200);
  expect(calls).toEqual([
    {
      batchId: "batch-1",
      messageId: "message-1",
      expected: {
        queueId: v2QueueId("queue-uid-1"),
        consumerId: "consumer-uid-1",
        generation: 7,
        leaseToken: "lease-1",
      },
      settlementToken: "settlement-1",
      decision: { outcome: "ack" },
    },
  ]);
  expect((await endpoint(request({}, "foreign-token"))).status).toBe(404);
  expect((await endpoint(request({ invocationCapability: "b".repeat(64) }))).status).toBe(404);
  expect((await endpoint(request({ leaseToken: "foreign-lease" }))).status).toBe(404);
  expect((await endpoint(request({ messageId: "foreign-message" }))).status).toBe(404);
  expect(calls).toHaveLength(1);
});

test("private endpoint never confirms an unknown or unavailable SQL effect", async () => {
  let result: "unavailable" | "already_settled" = "unavailable";
  const endpoint = createV2QueueSettlementEndpoint({
    queueIdForUid: v2QueueId,
    auth: {
      async authenticate() {
        return grant;
      },
    },
    custody: {
      async settleRegisteredBatchMessage() {
        return result;
      },
    },
  });
  const unavailable = await endpoint(request());
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  result = "already_settled";
  const settled = await endpoint(request());
  expect(settled.status).toBe(409);
  expect(await settled.json()).toEqual({ ok: false, error: { code: "already_settled" } });
});

test("HMAC invocation proof survives authority recreation but requires live durable scope", async () => {
  const key = new Uint8Array(32).fill(7);
  let live = true;
  const build = () =>
    createV2QueueSettlementAuthority({
      key,
      scope: {
        native: {
          async observeQueueTarget(scope) {
            return live
              ? ({ kind: "confirmed", ...scope, status: "active" } as const)
              : ({ kind: "unknown" } as const);
          },
        },
        core: {
          async verifyV2QueueSettlementScope(scope) {
            return live
              ? ({ kind: "confirmed_live", ...scope } as const)
              : ({ kind: "unknown" } as const);
          },
        },
      },
    });
  const beforeRestart = build();
  const capability = beforeRestart.mint(grant);
  const bearer = beforeRestart.bindingToken(grant);
  const afterRestart = build();
  expect(await afterRestart.authenticate({ bearer, invocationCapability: capability })).toEqual(
    grant,
  );
  expect(
    await afterRestart.authenticate({ bearer: `${bearer}x`, invocationCapability: capability }),
  ).toBeNull();
  expect(
    await afterRestart.authenticate({ bearer, invocationCapability: `${capability}x` }),
  ).toBeNull();
  live = false;
  expect(await afterRestart.authenticate({ bearer, invocationCapability: capability })).toBeNull();
  live = true;
  // The signed proof is scoped to the durable execution, not a fixed wall-clock
  // TTL that can expire while a legitimate native handler is still running.
  expect(await afterRestart.authenticate({ bearer, invocationCapability: capability })).toEqual(
    grant,
  );
});

test("signed capability binds one exact message and both persisted scope readers", async () => {
  const key = new Uint8Array(32).fill(17);
  let nativeStatus: "active" | "draining" | "retired" = "active";
  let coreKind: "confirmed_live" | "confirmed_receipt" | "unknown" = "confirmed_live";
  let wrongCoreQueue = false;
  const authority = createV2QueueSettlementAuthority({
    key,
    scope: {
      native: {
        async observeQueueTarget(scope) {
          return nativeStatus === "retired"
            ? { kind: "unknown" }
            : { kind: "confirmed", ...scope, status: nativeStatus };
        },
      },
      core: {
        async verifyV2QueueSettlementScope(scope) {
          return coreKind === "unknown"
            ? { kind: "unknown" }
            : {
                kind: coreKind,
                ...scope,
                queueUid: wrongCoreQueue ? "foreign-queue" : scope.queueUid,
              };
        },
      },
    },
  });
  const bearer = authority.bindingToken(grant);
  const capability = authority.mint(grant);
  expect(await authority.authenticate({ bearer, invocationCapability: capability })).toEqual(grant);
  const otherMessage = { ...grant, messageId: "message-2", leaseToken: "lease-2" };
  const otherCapability = authority.mint(otherMessage);
  expect(otherCapability).not.toBe(capability);
  expect(await authority.authenticate({ bearer, invocationCapability: otherCapability })).toEqual(
    otherMessage,
  );
  nativeStatus = "draining";
  coreKind = "confirmed_receipt";
  expect(await authority.authenticate({ bearer, invocationCapability: capability })).toEqual(grant);
  wrongCoreQueue = true;
  expect(await authority.authenticate({ bearer, invocationCapability: capability })).toBeNull();
  wrongCoreQueue = false;
  coreKind = "unknown";
  expect(await authority.authenticate({ bearer, invocationCapability: capability })).toBeNull();
  coreKind = "confirmed_live";
  nativeStatus = "retired";
  expect(await authority.authenticate({ bearer, invocationCapability: capability })).toBeNull();
});

test("private facade source owns the bearer and fixes method, path, and origin", () => {
  const source = v2QueueSettlementServiceSource();
  expect(source).toContain('authorization: "Bearer " + token');
  expect(source).toContain('request.method !== "POST"');
  expect(source).toContain(V2_QUEUE_SETTLEMENT_PATH);
  expect(source).not.toContain("worker-uid-1");
});

test("one-shot native delivery only accepts the exact protected handler-and-waitUntil result", () => {
  const body = JSON.stringify({
    protocol: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
    kind: "queue",
    outcome: "resolved",
    completion: "handler_and_wait_until",
  });
  expect(selfhostV2QueueCompletionAnswer({ status: 200, body })).toBe("handler_resolved");
  expect(
    selfhostV2QueueCompletionAnswer({ status: 200, body: body.replace("resolved", "rejected") }),
  ).toBe("handler_rejected");
  expect(selfhostV2QueueCompletionAnswer({ status: 500, body })).toBeNull();
  expect(
    selfhostV2QueueCompletionAnswer({
      status: 200,
      body: body.replace("handler_and_wait_until", "ack"),
    }),
  ).toBeNull();
  expect(
    selfhostV2QueueCompletionAnswer({ status: 200, body: `${body.slice(0, -1)},"extra":true}` }),
  ).toBeNull();
});
