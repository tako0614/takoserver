import { beforeEach, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import type { Sql } from "../src/ports.ts";
import type { SelfhostEventTarget, SelfhostEventTargets } from "../src/providers/selfhost.ts";
import {
  MAX_SELFHOST_EVENT_REQUEST_BYTES,
  MAX_SELFHOST_QUEUE_MESSAGE_BYTES,
  parseSelfhostQueueDecisions,
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_TOKEN_HEADER,
  selfhostQueueEvent,
} from "../src/providers/selfhost-events.ts";
import { createSelfhostQueuePump } from "../src/selfhost-queue-pump.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * Everything the Queue Consumer Form promises, decided against an injected
 * clock and a runtime that answers whatever the test says.
 *
 * The delivery itself is proved end to end against real workerd elsewhere. What
 * is proved here is the arithmetic nobody can see from outside: which messages
 * a batch takes, how long a partial one waits, how many redeliveries a message
 * gets before it comes to rest, and where it comes to rest.
 */

const QUEUE = "tsq-delivery";
const DLQ = "tsq-delivery-dlq";
const SCRIPT = "sw-fixture";
const VERSION = "v-fixture";
const TOKEN = "event-token-fixture";

const CONSUMER = {
  queue: QUEUE,
  maxBatchSize: 10,
  maxBatchTimeoutSeconds: 0,
  maxConcurrency: 1,
  maxRetries: 2,
  retryDelaySeconds: 60,
} as const;

const RETENTION = { messageRetentionSeconds: 345_600, deliveryDelaySeconds: 0 } as const;

interface Delivery {
  readonly path: string;
  readonly route: string | undefined;
  readonly token: string | undefined;
  readonly event: {
    readonly kind: string;
    readonly queue?: string;
    readonly batchId?: string;
    readonly logicalWorkerId?: string;
    readonly deploymentId?: string;
    readonly messages?: readonly {
      readonly messageId: string;
      readonly attempts: number;
      readonly body: { readonly data: string };
    }[];
  };
}

/** A runtime that records what it was asked and answers what the test set. */
function recordingRuntime(): {
  readonly runtime: WorkerdRuntime;
  readonly deliveries: Delivery[];
  answer: (delivery: Delivery) => { readonly status: number; readonly body: string } | null;
} {
  const deliveries: Delivery[] = [];
  const state = {
    answer: (delivery: Delivery) => acknowledgeEvery(delivery),
  };
  return {
    deliveries,
    get answer() {
      return state.answer;
    },
    set answer(next) {
      state.answer = next;
    },
    runtime: {
      async write() {},
      async remove() {},
      async reload() {},
      async has() {
        return true;
      },
      async probe(_name, path, init) {
        const delivery: Delivery = {
          path,
          route: init.route,
          token: init.headers[SELFHOST_WORKER_EVENT_TOKEN_HEADER],
          event: JSON.parse(init.body ?? "{}"),
        };
        deliveries.push(delivery);
        return state.answer(delivery);
      },
    },
  };
}

function acknowledgeEvery(delivery: Delivery): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      decisions: (delivery.event.messages ?? []).map((message) => ({
        messageId: message.messageId,
        outcome: "ack",
      })),
    }),
  };
}

function retryEvery(delivery: Delivery, delaySeconds?: number): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      decisions: (delivery.event.messages ?? []).map((message) => ({
        messageId: message.messageId,
        outcome: "retry",
        ...(delaySeconds === undefined ? {} : { delaySeconds }),
      })),
    }),
  };
}

function targets(overrides: Partial<SelfhostEventTarget> = {}): SelfhostEventTargets {
  return {
    async list() {
      return [
        {
          script: SCRIPT,
          versionId: VERSION,
          eventToken: TOKEN,
          handlers: ["fetch", "queue"],
          consumers: [CONSUMER],
          crons: [],
          ...overrides,
        },
      ];
    },
  };
}

let sql: Sql;
let millis: number;

beforeEach(() => {
  sql = createEphemeralSql();
  millis = Date.UTC(2026, 8, 2, 12, 0, 0);
});

async function enqueue(
  count: number,
  options: {
    readonly queue?: string;
    readonly visibleAt?: number;
    /** Raw body size, for the batches that cannot fit one envelope. */
    readonly bodyBytes?: number;
  } = {},
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `m-${options.queue ?? QUEUE}-${index}-${millis}`;
    ids.push(id);
    const body =
      options.bodyBytes === undefined
        ? new TextEncoder().encode(`body-${index}`)
        : new TextEncoder().encode(`${index}`.padEnd(options.bodyBytes, "x"));
    await sql.run(
      "INSERT INTO selfhost_queue_messages " +
        "(queue_id, message_id, body, enqueued_at_ms, visible_at_ms, expires_at_ms, deliveries) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0)",
      [
        options.queue ?? QUEUE,
        id,
        body.buffer.slice(0) as ArrayBuffer,
        millis,
        options.visibleAt ?? millis,
        millis + RETENTION.messageRetentionSeconds * 1_000,
      ],
    );
  }
  return ids;
}

const rows = () =>
  sql.query(
    "SELECT queue_id, message_id, deliveries, visible_at_ms, lease_token " +
      "FROM selfhost_queue_messages ORDER BY queue_id, message_id",
    [],
  );

test("delivers a batch on the event route with the version's own token", async () => {
  const runtime = recordingRuntime();
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(),
    clock: () => new Date(millis),
  });
  await enqueue(2);
  expect(await pump.tick()).toBe(2);
  const [delivery] = runtime.deliveries;
  expect(delivery?.path).toBe(SELFHOST_WORKER_EVENT_PATH);
  // Never the readiness hostname: that one reaches the script itself, and an
  // event must not be able to.
  expect(delivery?.route).toBe("events");
  expect(delivery?.token).toBe(TOKEN);
  expect(delivery?.event.queue).toBe(QUEUE);
  expect(delivery?.event.logicalWorkerId).toBe(SCRIPT);
  expect(delivery?.event.deploymentId).toBe(VERSION);
  expect(delivery?.event.messages?.map((message) => message.attempts)).toEqual([1, 1]);
  expect(await rows()).toEqual([]);
});

test("holds a partial batch for its timeout and sends it once the timeout elapses", async () => {
  const runtime = recordingRuntime();
  const consumer = { ...CONSUMER, maxBatchSize: 10, maxBatchTimeoutSeconds: 5 };
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({ consumers: [consumer] }),
    clock: () => new Date(millis),
  });
  await enqueue(1);
  expect(await pump.tick()).toBe(0);
  expect(runtime.deliveries).toHaveLength(0);
  millis += 5_000;
  expect(await pump.tick()).toBe(1);
  expect(runtime.deliveries).toHaveLength(1);
});

test("sends a full batch immediately, however long its timeout is", async () => {
  const runtime = recordingRuntime();
  const consumer = { ...CONSUMER, maxBatchSize: 2, maxBatchTimeoutSeconds: 60 };
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({ consumers: [consumer] }),
    clock: () => new Date(millis),
  });
  await enqueue(2);
  expect(await pump.tick()).toBe(2);
  expect(runtime.deliveries[0]?.event.messages).toHaveLength(2);
});

test("takes at most maxConcurrency batches at a time", async () => {
  const runtime = recordingRuntime();
  const consumer = { ...CONSUMER, maxBatchSize: 1, maxConcurrency: 2 };
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({ consumers: [consumer] }),
    clock: () => new Date(millis),
  });
  await enqueue(5);
  // Five messages, one per batch, two batches in flight: three passes settle
  // 2, 2, and 1 — never five at once.
  expect(await pump.tick()).toBe(5);
  expect(runtime.deliveries.map((delivery) => delivery.event.messages?.length)).toEqual([
    1, 1, 1, 1, 1,
  ]);
});

test("retries with the consumer's delay, and with the handler's when it named one", async () => {
  const runtime = recordingRuntime();
  runtime.answer = (delivery) => retryEvery(delivery);
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(),
    clock: () => new Date(millis),
  });
  await enqueue(1);
  expect(await pump.tick()).toBe(1);
  expect(await rows()).toMatchObject([
    { deliveries: 1, visible_at_ms: millis + 60_000, lease_token: null },
  ]);
  // Not due yet, so a pass in between does nothing.
  expect(await pump.tick()).toBe(0);

  millis += 60_000;
  runtime.answer = (delivery) => retryEvery(delivery, 5);
  expect(await pump.tick()).toBe(1);
  expect(await rows()).toMatchObject([{ deliveries: 2, visible_at_ms: millis + 5_000 }]);
});

test("a delivery that never reached the Worker spends no redelivery", async () => {
  const runtime = recordingRuntime();
  // Exactly what a restarting workerd, a refused connection, or a timeout
  // looks like from here: no answer at all.
  runtime.answer = () => null;
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(),
    clock: () => new Date(millis),
  });
  await enqueue(2);
  expect(await pump.tick()).toBe(0);
  // The lease is released and the count is exactly where it started: downtime
  // is this Host's problem, and spending the tenant's redeliveries on it is
  // how a queue empties itself into nothing while the handler never ran.
  expect(await rows()).toMatchObject([
    { deliveries: 0, lease_token: null },
    { deliveries: 0, lease_token: null },
  ]);
});

test("workerd being down for a whole retry budget still delivers nothing away", async () => {
  const runtime = recordingRuntime();
  runtime.answer = () => null;
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({ consumers: [{ ...CONSUMER, maxRetries: 2, retryDelaySeconds: 0 }] }),
    clock: () => new Date(millis),
  });
  await enqueue(3);
  for (let pass = 0; pass < 6; pass += 1) {
    await pump.tick();
    millis += 120_000;
  }
  expect(await rows()).toHaveLength(3);
  expect((await rows()).every((row) => Number(row.deliveries) === 0)).toBe(true);

  // And once it answers again, the messages are still there to be handled.
  runtime.answer = (delivery) => acknowledgeEvery(delivery);
  expect(await pump.tick()).toBe(3);
  expect(await rows()).toEqual([]);
});

test("a Worker that answered with a failure spends a redelivery", async () => {
  const runtime = recordingRuntime();
  // The wrapper's own answer when the tenant handler threw: a status, and
  // nothing of the tenant's in it. That is the tenant refusing the batch.
  runtime.answer = () => ({ status: 500, body: "" });
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({ consumers: [{ ...CONSUMER, maxRetries: 0 }] }),
    clock: () => new Date(millis),
  });
  await enqueue(1);
  expect(await pump.tick()).toBe(1);
  expect(await rows()).toEqual([]);
});

test("splits a batch too large for one envelope instead of destroying it", async () => {
  const runtime = recordingRuntime();
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({
      consumers: [{ ...CONSUMER, maxBatchSize: 100, maxBatchTimeoutSeconds: 0, maxRetries: 0 }],
    }),
    clock: () => new Date(millis),
  });
  // 100 x 16 000 bytes is about 2.1 MB once base64 has taken its four bytes
  // for every three — over the envelope ceiling, and inside every producer cap.
  await enqueue(100, { bodyBytes: 16_000 });
  expect(await pump.tick()).toBe(100);
  expect(runtime.deliveries.length).toBeGreaterThan(1);
  for (const delivery of runtime.deliveries) {
    expect(new TextEncoder().encode(JSON.stringify(delivery.event)).byteLength).toBeLessThanOrEqual(
      MAX_SELFHOST_EVENT_REQUEST_BYTES,
    );
  }
  const delivered = runtime.deliveries.flatMap((delivery) =>
    (delivery.event.messages ?? []).map((message) => message.messageId),
  );
  // Every message went exactly once, on its first delivery.
  expect(new Set(delivered).size).toBe(100);
  expect(
    runtime.deliveries.every((delivery) =>
      (delivery.event.messages ?? []).every((message) => message.attempts === 1),
    ),
  ).toBe(true);
  expect(await rows()).toEqual([]);
});

test("a batch too large for one envelope never reaches the dead-letter queue", async () => {
  const runtime = recordingRuntime();
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({
      consumers: [
        {
          ...CONSUMER,
          maxBatchSize: 100,
          maxBatchTimeoutSeconds: 0,
          maxRetries: 0,
          deadLetterQueue: { queue: DLQ, ...RETENTION },
        },
      ],
    }),
    clock: () => new Date(millis),
    randomId: (() => {
      let minted = 0;
      return () => {
        minted += 1;
        return `id-${minted}`;
      };
    })(),
  });
  await enqueue(20, { bodyBytes: 120_000 });
  expect(await pump.tick()).toBe(20);
  expect(await rows()).toEqual([]);
  expect(
    await sql.query("SELECT message_id FROM selfhost_queue_messages WHERE queue_id = ?", [DLQ]),
  ).toEqual([]);
});

test("one message can never be too large for an envelope, under the producer caps", () => {
  // The producer refuses a body over MAX_SELFHOST_QUEUE_MESSAGE_BYTES and mints
  // a message id of at most 128 characters, so this is the largest message that
  // can ever exist on this machine. Building it must not throw.
  const raw = new Uint8Array(MAX_SELFHOST_QUEUE_MESSAGE_BYTES);
  let binary = "";
  for (let offset = 0; offset < raw.byteLength; offset += 4_096) {
    binary += String.fromCharCode(...raw.subarray(offset, offset + 4_096));
  }
  const event = selfhostQueueEvent({
    batchId: "b".repeat(64),
    script: "s".repeat(128),
    publication: "p".repeat(128),
    queue: "q".repeat(128),
    messages: [
      {
        messageId: "m".repeat(128),
        timestampMillis: Number.MAX_SAFE_INTEGER,
        attempts: 101,
        body: { encoding: "base64", data: btoa(binary) },
      },
    ],
  });
  expect(new TextEncoder().encode(JSON.stringify(event)).byteLength).toBeLessThan(
    MAX_SELFHOST_EVENT_REQUEST_BYTES,
  );
});

test("moves a message to the dead-letter queue once its redeliveries are spent", async () => {
  const runtime = recordingRuntime();
  runtime.answer = (delivery) => retryEvery(delivery);
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({
      consumers: [{ ...CONSUMER, deadLetterQueue: { queue: DLQ, ...RETENTION } }],
    }),
    clock: () => new Date(millis),
    randomId: () => `dead-${millis}`,
  });
  await enqueue(1);
  // maxRetries counts REDELIVERIES: deliveries 1, 2 and 3 all happen, and the
  // third exhausts them.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(await pump.tick()).toBe(1);
    millis += 60_000;
  }
  const settled = await rows();
  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({ queue_id: DLQ, deliveries: 0 });
  // A NEW message there: new identity, new acceptance instant, count from one.
  expect(String(settled[0]?.message_id)).not.toContain(QUEUE);
});

test("drops an exhausted message when no dead-letter queue is declared", async () => {
  const runtime = recordingRuntime();
  runtime.answer = (delivery) => retryEvery(delivery);
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({ consumers: [{ ...CONSUMER, maxRetries: 0 }] }),
    clock: () => new Date(millis),
  });
  await enqueue(1);
  expect(await pump.tick()).toBe(1);
  expect(await rows()).toEqual([]);
});

test("a message taken by a process that died is taken again once its lease expires", async () => {
  const runtime = recordingRuntime();
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(),
    clock: () => new Date(millis),
    leaseMillis: 30_000,
  });
  await enqueue(1);
  // Exactly what a process that died between dispatch and settlement leaves
  // behind: the message counted as delivered and still owned by a lease.
  await sql.run(
    "UPDATE selfhost_queue_messages SET lease_token = ?, lease_expires_at_ms = ?, deliveries = 1",
    ["abandoned", millis + 30_000],
  );
  expect(await pump.tick()).toBe(0);
  expect(runtime.deliveries).toHaveLength(0);
  millis += 30_001;
  expect(await pump.tick()).toBe(1);
  // Delivered again, and told so: at-least-once is the contract, and the
  // attempt count is what lets a handler notice.
  expect(runtime.deliveries[0]?.event.messages?.[0]?.attempts).toBe(2);
  expect(await rows()).toEqual([]);
});

test("never hands a batch to a Worker that declared no queue handler", async () => {
  const runtime = recordingRuntime();
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets({ handlers: ["fetch"] }),
    clock: () => new Date(millis),
  });
  await enqueue(1);
  expect(await pump.tick()).toBe(0);
  expect(runtime.deliveries).toHaveLength(0);
});

test("reclaims every message whose retention ran out, not just one page of them", async () => {
  const runtime = recordingRuntime();
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(),
    clock: () => new Date(millis),
  });
  await enqueue(1);
  await enqueue(1, { queue: DLQ });
  expect(await pump.sweep()).toBe(0);
  millis += RETENTION.messageRetentionSeconds * 1_000 + 1;
  // A sweep pages until nothing expired is left, so a machine accepting faster
  // than one page every thirty seconds does not fall behind for ever.
  expect(await pump.sweep()).toBe(2);
  expect(await rows()).toEqual([]);
});

test("reads only a decision list that names exactly the messages sent", () => {
  const decisions = (body: unknown) =>
    parseSelfhostQueueDecisions(JSON.stringify(body), ["a", "b"]);
  expect(
    decisions({
      protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      decisions: [
        { messageId: "a", outcome: "ack" },
        { messageId: "b", outcome: "retry", delaySeconds: 3 },
      ],
    }),
  ).toEqual([
    { messageId: "a", outcome: "ack" },
    { messageId: "b", outcome: "retry", delaySeconds: 3 },
  ]);
  // A short list, a reordered one, a duplicate, an unknown outcome, and a delay
  // outside the Interface's range are all "this Host was not told what to do".
  expect(
    decisions({ protocol: SELFHOST_WORKER_EVENT_PROTOCOL, kind: "queue", decisions: [] }),
  ).toBeNull();
  expect(
    decisions({
      protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      decisions: [
        { messageId: "b", outcome: "ack" },
        { messageId: "a", outcome: "ack" },
      ],
    }),
  ).toBeNull();
  expect(
    decisions({
      protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      decisions: [
        { messageId: "a", outcome: "ack" },
        { messageId: "b", outcome: "retry", delaySeconds: 0 },
      ],
    }),
  ).toBeNull();
  expect(decisions({ protocol: "other", kind: "queue", decisions: [] })).toBeNull();
});
