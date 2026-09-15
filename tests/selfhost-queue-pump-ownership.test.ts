import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import type { Row, Sql } from "../src/ports.ts";
import type {
  SelfhostEventSelection,
  SelfhostEventTarget,
  SelfhostEventTargets,
} from "../src/providers/selfhost.ts";
import {
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
} from "../src/providers/selfhost-events.ts";
import type { SelfhostQueueConsumerAttachment } from "../src/providers/selfhost-script-state.ts";
import { createSelfhostQueuePump } from "../src/selfhost-queue-pump.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const SOURCE_QUEUE = "queue-ownership-source";
const SOURCE_NAME = "ownership-source";
const DEAD_LETTER_QUEUE = "queue-ownership-dlq";
const DEAD_LETTER_NAME = "ownership-dlq";
const SCRIPT = "ownership-worker";
const VERSION = "ownership-version";
const VERSION_UID = "ownership-version-uid";
const EVENT_TOKEN = "ownership-event-token";
const INITIAL_MILLIS = Date.UTC(2026, 8, 14, 12, 0, 0);
const LEASE_MILLIS = 1_000;
const RETENTION_SECONDS = 3_600;
const RETRY_DELAY_SECONDS = 60;

const BASE_CONSUMER: SelfhostQueueConsumerAttachment = {
  queue: SOURCE_QUEUE,
  queueName: SOURCE_NAME,
  maxBatchSize: 1,
  maxBatchTimeoutSeconds: 0,
  maxConcurrency: 1,
  maxRetries: 2,
  retryDelaySeconds: RETRY_DELAY_SECONDS,
};

interface QueueDeliveryMessage {
  readonly messageId: string;
  readonly attempts: number;
  readonly body: { readonly data: string };
}

interface QueueDelivery {
  readonly path: string;
  readonly event: {
    readonly kind?: string;
    readonly queue?: string;
    readonly messages?: readonly QueueDeliveryMessage[];
  };
}

type DeliveryAnswer = (
  delivery: QueueDelivery,
) => { readonly status: number; readonly body: string } | null;

type Probe = NonNullable<WorkerdRuntime["probe"]>;

function runtimeWithProbe(probe: Probe): WorkerdRuntime {
  return {
    async inspectModule(input) {
      return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
    },
    async write() {},
    async remove() {},
    async reload() {},
    async has() {
      return true;
    },
    probe,
  };
}

function recordingRuntime(answer: DeliveryAnswer): {
  readonly runtime: WorkerdRuntime;
  readonly deliveries: QueueDelivery[];
} {
  const deliveries: QueueDelivery[] = [];
  const runtime = runtimeWithProbe(async (_name, path, init) => {
    const delivery: QueueDelivery = {
      path,
      event: JSON.parse(init.body ?? "{}") as QueueDelivery["event"],
    };
    deliveries.push(delivery);
    return answer(delivery);
  });
  return { runtime, deliveries };
}

function heldRecordingRuntime(answer: DeliveryAnswer): {
  readonly runtime: WorkerdRuntime;
  readonly deliveries: QueueDelivery[];
  readonly entered: Promise<void>;
  readonly release: () => void;
} {
  const deliveries: QueueDelivery[] = [];
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const runtime = runtimeWithProbe(async (_name, path, init) => {
    const delivery: QueueDelivery = {
      path,
      event: JSON.parse(init.body ?? "{}") as QueueDelivery["event"],
    };
    deliveries.push(delivery);
    enteredResolve?.();
    await gate;
    return answer(delivery);
  });
  return {
    runtime,
    deliveries,
    entered,
    release: () => releaseGate?.(),
  };
}

function queueResponse(
  delivery: QueueDelivery,
  outcome: "ack" | "retry",
  delaySeconds?: number,
): { readonly status: number; readonly body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      decisions: (delivery.event.messages ?? []).map((message) => ({
        messageId: message.messageId,
        outcome,
        ...(outcome === "retry" && delaySeconds !== undefined ? { delaySeconds } : {}),
      })),
    }),
  };
}

function targets(consumer: SelfhostQueueConsumerAttachment): SelfhostEventTargets {
  const target: SelfhostEventTarget = {
    script: SCRIPT,
    consumers: [consumer],
    crons: [],
  };
  const selection: SelfhostEventSelection = {
    versionId: VERSION,
    workerVersionUid: VERSION_UID,
    eventToken: EVENT_TOKEN,
    handlers: ["queue"],
  };
  return {
    async list() {
      return [target];
    },
    async select() {
      return selection;
    },
  };
}

function randomIds(prefix: string): {
  readonly minted: string[];
  readonly randomId: () => string;
} {
  const minted: string[] = [];
  return {
    minted,
    randomId: () => {
      const id = `${prefix}-${minted.length + 1}`;
      minted.push(id);
      return id;
    },
  };
}

async function enqueue(
  sql: Sql,
  queue: string,
  messageId: string,
  body: Uint8Array,
  millis: number,
): Promise<void> {
  await sql.run(
    "INSERT INTO selfhost_queue_messages " +
      "(queue_id, message_id, body, enqueued_at_ms, visible_at_ms, expires_at_ms, deliveries) " +
      "VALUES (?, ?, ?, ?, ?, ?, 0)",
    [
      queue,
      messageId,
      body.buffer.slice(0) as ArrayBuffer,
      millis,
      millis,
      millis + RETENTION_SECONDS * 1_000,
    ],
  );
}

async function queueRows(sql: Sql, queue: string): Promise<readonly Row[]> {
  return sql.query(
    "SELECT queue_id, message_id, body, enqueued_at_ms, visible_at_ms, expires_at_ms, " +
      "deliveries, lease_token, lease_expires_at_ms " +
      "FROM selfhost_queue_messages WHERE queue_id = ? ORDER BY message_id",
    [queue],
  );
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("queue body was not returned as bytes");
}

function holdFirstSelect(
  base: Sql,
  shouldHold: (statement: string) => boolean = (statement) =>
    /^\s*SELECT message_id, body,/iu.test(statement),
): {
  readonly sql: Sql;
  readonly captured: Promise<readonly Row[]>;
  readonly release: () => void;
} {
  let held = false;
  let capturedResolve: ((rows: readonly Row[]) => void) | undefined;
  const captured = new Promise<readonly Row[]>((resolve) => {
    capturedResolve = resolve;
  });
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const sql: Sql = {
    async query(statement, params) {
      const rows = await base.query(statement, params);
      if (!held && /^\s*SELECT\b/iu.test(statement) && shouldHold(statement)) {
        held = true;
        capturedResolve?.(rows);
        await gate;
      }
      return rows;
    },
    run: (statement, params) => base.run(statement, params),
    batch: (statements) => base.batch(statements),
  };
  return {
    sql,
    captured,
    release: () => releaseGate?.(),
  };
}

function consumerWithDeadLetter(): SelfhostQueueConsumerAttachment {
  return {
    ...BASE_CONSUMER,
    maxRetries: 0,
    deadLetterQueue: {
      queue: DEAD_LETTER_QUEUE,
      queueName: DEAD_LETTER_NAME,
      messageRetentionSeconds: RETENTION_SECONDS,
      deliveryDelaySeconds: 0,
    },
  };
}

async function markExpiredFinal(
  sql: Sql,
  queue: string,
  messageId: string,
  deliveries: number,
  millis: number,
  leaseToken = "expired-final",
): Promise<void> {
  await sql.run(
    "UPDATE selfhost_queue_messages " +
      "SET deliveries = ?, lease_token = ?, lease_expires_at_ms = ?, visible_at_ms = ? " +
      "WHERE queue_id = ? AND message_id = ?",
    [deliveries, leaseToken, millis - 1, millis, queue, messageId],
  );
}

test("queue ownership: stale retry after winner ACK never creates a dead-letter copy", async () => {
  const sql = createEphemeralSql();
  const body = new TextEncoder().encode("queue ownership ACK bytes");
  const messageId = "ownership-message-ack";
  let millis = INITIAL_MILLIS;
  const oldRuntime = heldRecordingRuntime((delivery) => queueResponse(delivery, "retry"));
  const winnerRuntime = recordingRuntime((delivery) => queueResponse(delivery, "ack"));
  const oldIds = randomIds("old-ack");
  const winnerIds = randomIds("winner-ack");
  const oldConsumer = consumerWithDeadLetter();
  // The successor attachment legitimately gets one redelivery while the old
  // holder is still in flight; the old attachment remains capped at its first
  // delivery. Each attachment's own retry budget is respected.
  const winnerConsumer = { ...oldConsumer, maxRetries: 1 };
  const oldPump = createSelfhostQueuePump({
    sql,
    runtime: oldRuntime.runtime,
    targets: targets(oldConsumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: oldIds.randomId,
  });
  const winnerPump = createSelfhostQueuePump({
    sql,
    runtime: winnerRuntime.runtime,
    targets: targets(winnerConsumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: winnerIds.randomId,
  });
  await enqueue(sql, SOURCE_QUEUE, messageId, body, millis);

  let oldTick: Promise<number> | undefined;
  try {
    oldTick = oldPump.tick();
    await oldRuntime.entered;

    millis += LEASE_MILLIS + 1;
    expect(await winnerPump.tick()).toBe(1);
    expect(winnerRuntime.deliveries).toHaveLength(1);
    expect(winnerRuntime.deliveries[0]?.path).toBe(SELFHOST_WORKER_EVENT_PATH);
    expect(winnerRuntime.deliveries[0]?.event.messages?.map((message) => message.attempts)).toEqual(
      [2],
    );
    expect(await queueRows(sql, SOURCE_QUEUE)).toEqual([]);

    oldRuntime.release();
    const settled = await oldTick;
    expect(oldRuntime.deliveries).toHaveLength(1);
    expect(oldRuntime.deliveries[0]?.event.messages?.map((message) => message.attempts)).toEqual([
      1,
    ]);
    expect(await queueRows(sql, SOURCE_QUEUE)).toEqual([]);
    expect(await queueRows(sql, DEAD_LETTER_QUEUE)).toEqual([]);
    expect(settled).toBe(0);
    expect(new Set([...oldIds.minted, ...winnerIds.minted]).size).toBe(
      oldIds.minted.length + winnerIds.minted.length,
    );
  } finally {
    oldRuntime.release();
    await oldTick?.catch(() => {});
  }
});

test("queue ownership: stale retry after winner DLQ creates no duplicate and preserves winner bytes", async () => {
  const sql = createEphemeralSql();
  const body = new TextEncoder().encode("queue ownership DLQ bytes");
  const messageId = "ownership-message-dlq";
  let millis = INITIAL_MILLIS;
  const oldRuntime = heldRecordingRuntime((delivery) => queueResponse(delivery, "retry"));
  const winnerRuntime = recordingRuntime((delivery) => queueResponse(delivery, "retry"));
  const oldIds = randomIds("old-dlq");
  const winnerIds = randomIds("winner-dlq");
  const oldConsumer = consumerWithDeadLetter();
  // The successor's attempt 2 is the final allowed delivery for the raised
  // attachment limit; the stale old attempt 1 must still be fenced out.
  const winnerConsumer = { ...oldConsumer, maxRetries: 1 };
  const oldPump = createSelfhostQueuePump({
    sql,
    runtime: oldRuntime.runtime,
    targets: targets(oldConsumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: oldIds.randomId,
  });
  const winnerPump = createSelfhostQueuePump({
    sql,
    runtime: winnerRuntime.runtime,
    targets: targets(winnerConsumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: winnerIds.randomId,
  });
  await enqueue(sql, SOURCE_QUEUE, messageId, body, millis);

  let oldTick: Promise<number> | undefined;
  try {
    oldTick = oldPump.tick();
    await oldRuntime.entered;

    millis += LEASE_MILLIS + 1;
    expect(await winnerPump.tick()).toBe(1);
    expect(winnerRuntime.deliveries).toHaveLength(1);
    expect(winnerRuntime.deliveries[0]?.event.messages?.map((message) => message.attempts)).toEqual(
      [2],
    );

    const winnerRows = await queueRows(sql, DEAD_LETTER_QUEUE);
    expect(winnerRows).toHaveLength(1);
    const winnerRow = winnerRows[0];
    expect(winnerRow).toMatchObject({
      queue_id: DEAD_LETTER_QUEUE,
      deliveries: 0,
      enqueued_at_ms: millis,
      visible_at_ms: millis,
    });
    expect(bytes(winnerRow?.body)).toEqual(body);
    expect(winnerIds.minted).toContain(String(winnerRow?.message_id));
    expect(oldIds.minted).not.toContain(String(winnerRow?.message_id));
    expect(await queueRows(sql, SOURCE_QUEUE)).toEqual([]);

    oldRuntime.release();
    const settled = await oldTick;
    expect(oldRuntime.deliveries).toHaveLength(1);
    expect(await queueRows(sql, SOURCE_QUEUE)).toEqual([]);
    const finalRows = await queueRows(sql, DEAD_LETTER_QUEUE);
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]?.message_id).toBe(winnerRow?.message_id);
    expect(bytes(finalRows[0]?.body)).toEqual(body);
    expect(settled).toBe(0);
    expect(new Set([...oldIds.minted, ...winnerIds.minted]).size).toBe(
      oldIds.minted.length + winnerIds.minted.length,
    );
  } finally {
    oldRuntime.release();
    await oldTick?.catch(() => {});
  }
});

test("queue ownership: a stale captured SELECT cannot dispatch a retried message early", async () => {
  const baseSql = createEphemeralSql();
  const heldSelect = holdFirstSelect(baseSql);
  const body = new TextEncoder().encode("queue ownership captured SELECT bytes");
  const messageId = "ownership-message-select";
  const millis = INITIAL_MILLIS;
  const oldRuntime = recordingRuntime((delivery) => queueResponse(delivery, "retry"));
  const winnerRuntime = recordingRuntime((delivery) =>
    queueResponse(delivery, "retry", RETRY_DELAY_SECONDS),
  );
  const oldIds = randomIds("old-select");
  const winnerIds = randomIds("winner-select");
  const consumer: SelfhostQueueConsumerAttachment = {
    ...BASE_CONSUMER,
    maxRetries: 2,
  };
  const oldPump = createSelfhostQueuePump({
    sql: heldSelect.sql,
    runtime: oldRuntime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: oldIds.randomId,
  });
  const winnerPump = createSelfhostQueuePump({
    sql: baseSql,
    runtime: winnerRuntime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: winnerIds.randomId,
  });
  await enqueue(baseSql, SOURCE_QUEUE, messageId, body, millis);

  let oldTick: Promise<number> | undefined;
  try {
    oldTick = oldPump.tick();
    const capturedRows = await heldSelect.captured;
    expect(capturedRows).toHaveLength(1);
    expect(capturedRows[0]).toMatchObject({
      message_id: messageId,
      deliveries: 0,
      visible_at_ms: millis,
    });

    expect(await winnerPump.tick()).toBe(1);
    expect(winnerRuntime.deliveries).toHaveLength(1);
    expect(winnerRuntime.deliveries[0]?.event.messages?.map((message) => message.attempts)).toEqual(
      [1],
    );
    const afterWinner = await queueRows(baseSql, SOURCE_QUEUE);
    expect(afterWinner).toHaveLength(1);
    expect(afterWinner[0]).toMatchObject({
      queue_id: SOURCE_QUEUE,
      message_id: messageId,
      deliveries: 1,
      visible_at_ms: millis + RETRY_DELAY_SECONDS * 1_000,
      lease_token: null,
      lease_expires_at_ms: null,
    });
    expect(bytes(afterWinner[0]?.body)).toEqual(body);

    heldSelect.release();
    expect(await oldTick).toBe(0);
    expect(oldRuntime.deliveries).toEqual([]);
    const finalRows = await queueRows(baseSql, SOURCE_QUEUE);
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]).toMatchObject({
      message_id: messageId,
      deliveries: 1,
      visible_at_ms: millis + RETRY_DELAY_SECONDS * 1_000,
      lease_token: null,
      lease_expires_at_ms: null,
    });
    expect(bytes(finalRows[0]?.body)).toEqual(body);
    expect(new Set([...oldIds.minted, ...winnerIds.minted]).size).toBe(
      oldIds.minted.length + winnerIds.minted.length,
    );
  } finally {
    heldSelect.release();
    await oldTick?.catch(() => {});
  }
});

test("queue ownership: a captured SELECT cannot reserve a message after it expires", async () => {
  const baseSql = createEphemeralSql();
  const heldSelect = holdFirstSelect(baseSql);
  const body = new TextEncoder().encode("queue ownership expired SELECT bytes");
  const messageId = "ownership-message-expired";
  let millis = INITIAL_MILLIS;
  const runtime = recordingRuntime((delivery) => queueResponse(delivery, "ack"));
  const ids = randomIds("expired-select");
  const consumer: SelfhostQueueConsumerAttachment = {
    ...BASE_CONSUMER,
    maxRetries: 0,
  };
  const pump = createSelfhostQueuePump({
    sql: heldSelect.sql,
    runtime: runtime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: ids.randomId,
  });
  await enqueue(baseSql, SOURCE_QUEUE, messageId, body, millis);

  let tick: Promise<number> | undefined;
  try {
    tick = pump.tick();
    const capturedRows = await heldSelect.captured;
    expect(capturedRows).toHaveLength(1);
    const expiresAt = Number((await queueRows(baseSql, SOURCE_QUEUE))[0]?.expires_at_ms);
    expect(expiresAt).toBeGreaterThan(millis);

    // No sweep or synthetic write: only the injected wall clock advances while
    // the old SELECT is suspended.
    millis = expiresAt + 1;
    heldSelect.release();
    expect(await tick).toBe(0);
    expect(runtime.deliveries).toEqual([]);
    const rows = await queueRows(baseSql, SOURCE_QUEUE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queue_id: SOURCE_QUEUE,
      message_id: messageId,
      deliveries: 0,
      visible_at_ms: INITIAL_MILLIS,
      expires_at_ms: expiresAt,
      lease_token: null,
      lease_expires_at_ms: null,
    });
    expect(bytes(rows[0]?.body)).toEqual(body);
  } finally {
    heldSelect.release();
    await tick?.catch(() => {});
  }
});

test("queue recovery: cap-101 recovery drains a healthy due message without poison dispatch", async () => {
  const sql = createEphemeralSql();
  const millis = INITIAL_MILLIS;
  const poisonBody = new TextEncoder().encode("queue recovery cap-101 poison bytes");
  const healthyBody = new TextEncoder().encode("queue recovery cap-101 healthy bytes");
  const poisonId = "000-recovery-cap101-poison";
  const healthyId = "001-recovery-cap101-healthy";
  const poisonAcceptedAt = millis - 500;
  await enqueue(sql, SOURCE_QUEUE, poisonId, poisonBody, poisonAcceptedAt);
  await enqueue(sql, SOURCE_QUEUE, healthyId, healthyBody, millis);
  await markExpiredFinal(sql, SOURCE_QUEUE, poisonId, 101, millis, "cap101-expired");

  const ids = randomIds("recovery-cap101");
  const runtime = recordingRuntime((delivery) => queueResponse(delivery, "ack"));
  const consumer: SelfhostQueueConsumerAttachment = {
    ...BASE_CONSUMER,
    maxBatchSize: 1,
    maxRetries: 100,
    deadLetterQueue: {
      queue: DEAD_LETTER_QUEUE,
      queueName: DEAD_LETTER_NAME,
      messageRetentionSeconds: RETENTION_SECONDS,
      deliveryDelaySeconds: 0,
    },
  };
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: ids.randomId,
  });

  const settled = await pump.tick();
  const sourceRows = await queueRows(sql, SOURCE_QUEUE);
  const deadLetterRows = await queueRows(sql, DEAD_LETTER_QUEUE);
  expect(sourceRows).toEqual([]);
  expect(deadLetterRows).toHaveLength(1);
  expect(deadLetterRows[0]).toMatchObject({
    queue_id: DEAD_LETTER_QUEUE,
    deliveries: 0,
    enqueued_at_ms: millis,
    visible_at_ms: millis,
    expires_at_ms: millis + RETENTION_SECONDS * 1_000,
  });
  expect(bytes(deadLetterRows[0]?.body)).toEqual(poisonBody);
  expect(String(deadLetterRows[0]?.message_id)).not.toBe(poisonId);
  expect(ids.minted).toContain(String(deadLetterRows[0]?.message_id));
  expect(runtime.deliveries).toHaveLength(1);
  expect(runtime.deliveries[0]?.event.messages?.map((message) => message.messageId)).toEqual([
    healthyId,
  ]);
  expect(runtime.deliveries[0]?.event.messages?.map((message) => message.attempts)).toEqual([1]);
  expect(settled).toBe(2);
});

test("queue recovery: a lower retry cap never dispatches a fourth attempt", async () => {
  const sql = createEphemeralSql();
  const millis = INITIAL_MILLIS;
  const body = new TextEncoder().encode("queue recovery cap-three bytes");
  const messageId = "recovery-cap-three";
  await enqueue(sql, SOURCE_QUEUE, messageId, body, millis);
  await markExpiredFinal(sql, SOURCE_QUEUE, messageId, 3, millis, "cap-three-expired");

  const runtime = recordingRuntime((delivery) => queueResponse(delivery, "ack"));
  const consumer: SelfhostQueueConsumerAttachment = {
    ...BASE_CONSUMER,
    maxBatchSize: 1,
    maxRetries: 2,
  };
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
  });

  const settled = await pump.tick();
  expect(runtime.deliveries).toEqual([]);
  expect(await queueRows(sql, SOURCE_QUEUE)).toEqual([]);
  expect(settled).toBe(1);
});

test("queue recovery: maxRetries zero drops an expired final lease without a DLQ", async () => {
  const sql = createEphemeralSql();
  const millis = INITIAL_MILLIS;
  const body = new TextEncoder().encode("queue recovery no-DLQ bytes");
  const messageId = "recovery-no-dlq";
  await enqueue(sql, SOURCE_QUEUE, messageId, body, millis);
  await markExpiredFinal(sql, SOURCE_QUEUE, messageId, 1, millis, "no-dlq-expired");

  const runtime = recordingRuntime((delivery) => queueResponse(delivery, "retry"));
  const consumer: SelfhostQueueConsumerAttachment = {
    ...BASE_CONSUMER,
    maxBatchSize: 1,
    maxRetries: 0,
  };
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
  });

  const settled = await pump.tick();
  expect(runtime.deliveries).toEqual([]);
  expect(await queueRows(sql, SOURCE_QUEUE)).toEqual([]);
  expect(await queueRows(sql, DEAD_LETTER_QUEUE)).toEqual([]);
  expect(settled).toBe(1);
});

test("queue recovery: live final and retention-expired rows stay until the right lifecycle", async () => {
  const sql = createEphemeralSql();
  const millis = INITIAL_MILLIS;
  const liveBody = new TextEncoder().encode("queue recovery live final bytes");
  const retainedBody = new TextEncoder().encode("queue recovery retained final bytes");
  const liveId = "recovery-live-final";
  const retainedId = "recovery-retention-final";
  await enqueue(sql, SOURCE_QUEUE, liveId, liveBody, millis);
  await enqueue(
    sql,
    SOURCE_QUEUE,
    retainedId,
    retainedBody,
    millis - RETENTION_SECONDS * 1_000 - 1,
  );
  await sql.run(
    "UPDATE selfhost_queue_messages " +
      "SET deliveries = 1, lease_token = ?, lease_expires_at_ms = ?, visible_at_ms = ? " +
      "WHERE queue_id = ? AND message_id = ?",
    ["live-final", millis + LEASE_MILLIS, millis, SOURCE_QUEUE, liveId],
  );
  await markExpiredFinal(sql, SOURCE_QUEUE, retainedId, 1, millis, "retention-expired");
  const before = await queueRows(sql, SOURCE_QUEUE);

  const runtime = recordingRuntime((delivery) => queueResponse(delivery, "retry"));
  const consumer = consumerWithDeadLetter();
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
  });

  const settled = await pump.tick();
  expect(runtime.deliveries).toEqual([]);
  expect(await queueRows(sql, SOURCE_QUEUE)).toEqual(before);
  expect(await queueRows(sql, DEAD_LETTER_QUEUE)).toEqual([]);
  expect(settled).toBe(0);
  expect(await pump.sweep()).toBe(1);
  const afterSweep = await queueRows(sql, SOURCE_QUEUE);
  expect(afterSweep).toHaveLength(1);
  expect(afterSweep[0]?.message_id).toBe(liveId);
  expect(bytes(afterSweep[0]?.body)).toEqual(liveBody);
});

test("queue recovery: a captured recovery SELECT cannot reclaim a newer lease/count/visibility", async () => {
  const baseSql = createEphemeralSql();
  // The first SELECT is the normal reserve on the unfixed pump and the
  // dedicated recovery read on the fixed pump; either way the state race is
  // the assertion, not a projection detail.
  const heldSelect = holdFirstSelect(baseSql, () => true);
  const millis = INITIAL_MILLIS;
  const body = new TextEncoder().encode("queue recovery newer lease bytes");
  const messageId = "recovery-newer-lease";
  await enqueue(baseSql, SOURCE_QUEUE, messageId, body, millis);
  await markExpiredFinal(baseSql, SOURCE_QUEUE, messageId, 1, millis, "old-final");

  const runtime = recordingRuntime((delivery) => queueResponse(delivery, "ack"));
  const consumer: SelfhostQueueConsumerAttachment = {
    ...BASE_CONSUMER,
    maxBatchSize: 1,
    maxRetries: 0,
  };
  const pump = createSelfhostQueuePump({
    sql: heldSelect.sql,
    runtime: runtime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
  });

  let tick: Promise<number> | undefined;
  try {
    tick = pump.tick();
    const capturedRows = await heldSelect.captured;
    expect(capturedRows.length).toBeGreaterThan(0);
    await baseSql.run(
      "UPDATE selfhost_queue_messages " +
        "SET deliveries = ?, lease_token = ?, lease_expires_at_ms = ?, visible_at_ms = ? " +
        "WHERE queue_id = ? AND message_id = ?",
      [
        2,
        "newer-final",
        millis + LEASE_MILLIS,
        millis + RETRY_DELAY_SECONDS * 1_000,
        SOURCE_QUEUE,
        messageId,
      ],
    );
    const expected = await queueRows(baseSql, SOURCE_QUEUE);

    heldSelect.release();
    const settled = await tick;
    expect(runtime.deliveries).toEqual([]);
    expect(await queueRows(baseSql, SOURCE_QUEUE)).toEqual(expected);
    expect(await queueRows(baseSql, DEAD_LETTER_QUEUE)).toEqual([]);
    expect(settled).toBe(0);
  } finally {
    heldSelect.release();
    await tick?.catch(() => {});
  }
});

test("queue recovery: a dead-letter INSERT failure rolls back the recovery claim", async () => {
  const baseSql = createEphemeralSql();
  const millis = INITIAL_MILLIS;
  const body = new TextEncoder().encode("queue recovery atomic DLQ bytes");
  const messageId = "recovery-atomic-dlq";
  await enqueue(baseSql, SOURCE_QUEUE, messageId, body, millis);
  await markExpiredFinal(baseSql, SOURCE_QUEUE, messageId, 1, millis, "atomic-dlq-expired");
  const before = await queueRows(baseSql, SOURCE_QUEUE);
  // Fail inside the actual SQLite transaction, after any recovery claim.
  await baseSql.run(
    "CREATE TRIGGER reject_recovery_dlq BEFORE INSERT ON selfhost_queue_messages " +
      "WHEN NEW.queue_id = 'queue-ownership-dlq' " +
      "BEGIN SELECT RAISE(ABORT, 'injected recovery DLQ failure'); END",
  );

  const ids = randomIds("recovery-atomic-dlq");
  const runtime = recordingRuntime((delivery) => queueResponse(delivery, "retry"));
  const consumer: SelfhostQueueConsumerAttachment = {
    ...BASE_CONSUMER,
    maxBatchSize: 1,
    maxRetries: 0,
    deadLetterQueue: {
      queue: DEAD_LETTER_QUEUE,
      queueName: DEAD_LETTER_NAME,
      messageRetentionSeconds: RETENTION_SECONDS,
      deliveryDelaySeconds: 0,
    },
  };
  const pump = createSelfhostQueuePump({
    sql: baseSql,
    runtime: runtime.runtime,
    targets: targets(consumer),
    clock: () => new Date(millis),
    leaseMillis: LEASE_MILLIS,
    randomId: ids.randomId,
  });

  const failedSettled = await pump.tick();
  expect(await queueRows(baseSql, SOURCE_QUEUE)).toEqual(before);
  expect(await queueRows(baseSql, DEAD_LETTER_QUEUE)).toEqual([]);
  expect(runtime.deliveries).toEqual([]);
  expect(failedSettled).toBe(0);

  await baseSql.run("DROP TRIGGER reject_recovery_dlq");
  const recoveredSettled = await pump.tick();
  expect(runtime.deliveries).toEqual([]);
  expect(await queueRows(baseSql, SOURCE_QUEUE)).toEqual([]);
  const deadLetterRows = await queueRows(baseSql, DEAD_LETTER_QUEUE);
  expect(deadLetterRows).toHaveLength(1);
  expect(deadLetterRows[0]).toMatchObject({
    queue_id: DEAD_LETTER_QUEUE,
    deliveries: 0,
    enqueued_at_ms: millis,
    visible_at_ms: millis,
    expires_at_ms: millis + RETENTION_SECONDS * 1_000,
  });
  expect(bytes(deadLetterRows[0]?.body)).toEqual(body);
  expect(String(deadLetterRows[0]?.message_id)).not.toBe(messageId);
  expect(ids.minted).toContain(String(deadLetterRows[0]?.message_id));
  expect(recoveredSettled).toBe(1);
});

test("queue recovery: a lowered retry limit settles an unleased row only when due", async () => {
  const sql = createEphemeralSql();
  let millis = INITIAL_MILLIS;
  const body = new TextEncoder().encode("queue recovery lowered limit bytes");
  const messageId = "recovery-lowered-limit";
  await enqueue(sql, SOURCE_QUEUE, messageId, body, millis);
  await sql.run(
    "UPDATE selfhost_queue_messages SET deliveries = 1, visible_at_ms = ? " +
      "WHERE queue_id = ? AND message_id = ?",
    [millis + RETRY_DELAY_SECONDS * 1_000, SOURCE_QUEUE, messageId],
  );
  const before = await queueRows(sql, SOURCE_QUEUE);
  const runtime = recordingRuntime((delivery) => queueResponse(delivery, "ack"));
  const pump = createSelfhostQueuePump({
    sql,
    runtime: runtime.runtime,
    targets: targets(consumerWithDeadLetter()),
    clock: () => new Date(millis),
  });

  expect(await pump.tick()).toBe(0);
  expect(await queueRows(sql, SOURCE_QUEUE)).toEqual(before);
  expect(await queueRows(sql, DEAD_LETTER_QUEUE)).toEqual([]);
  millis += RETRY_DELAY_SECONDS * 1_000;
  const settled = await pump.tick();
  expect(runtime.deliveries).toEqual([]);
  expect(await queueRows(sql, SOURCE_QUEUE)).toEqual([]);
  const copies = await queueRows(sql, DEAD_LETTER_QUEUE);
  expect(copies).toHaveLength(1);
  expect(copies[0]?.enqueued_at_ms).toBe(millis);
  expect(copies[0]?.deliveries).toBe(0);
  expect(bytes(copies[0]?.body)).toEqual(body);
  expect(settled).toBe(1);
});
