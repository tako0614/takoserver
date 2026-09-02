import { beforeEach, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import type { Sql } from "../src/ports.ts";
import type { SelfhostEventTarget, SelfhostEventTargets } from "../src/providers/selfhost.ts";
import { parseSelfhostCron } from "../src/providers/selfhost-cron.ts";
import {
  SELFHOST_WORKER_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_TOKEN_HEADER,
} from "../src/providers/selfhost-events.ts";
import { createSelfhostWorkerScheduler } from "../src/selfhost-scheduler.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * The clock half of the Edge Family, against an injected clock.
 *
 * What is proved here is what the `WorkerCronTrigger` Form states and no
 * observation from outside can show: that a match fires once inside its own
 * minute, that a match this machine slept through is stepped over rather than
 * fired late, that a trigger already running is not started again, and that the
 * next fire survives a restart because it is a row rather than a timer.
 */

const SCRIPT = "sw-fixture";
const VERSION = "v-fixture";
const TOKEN = "event-token-fixture";
const CRON = "0 * * * *";

interface Fire {
  readonly token: string | undefined;
  readonly route: string | undefined;
  readonly event: { readonly kind: string; readonly cron: string; readonly scheduledTime: number };
}

function recordingRuntime(): {
  readonly runtime: WorkerdRuntime;
  readonly fires: Fire[];
  answer: () => { readonly status: number; readonly body: string } | null;
} {
  const fires: Fire[] = [];
  const state = {
    answer: () => ({
      status: 200,
      body: JSON.stringify({
        protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
        kind: "schedule",
        outcome: "ack",
      }),
    }),
  };
  return {
    fires,
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
      async probe(_name, _path, init) {
        fires.push({
          token: init.headers[SELFHOST_WORKER_EVENT_TOKEN_HEADER],
          route: init.route,
          event: JSON.parse(init.body ?? "{}"),
        });
        return state.answer();
      },
    },
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
          handlers: ["fetch", "scheduled"],
          consumers: [],
          crons: [CRON],
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
  millis = Date.UTC(2026, 8, 2, 12, 30, 0);
});

const scheduler = (runtime: WorkerdRuntime, overrides: Partial<SelfhostEventTarget> = {}) =>
  createSelfhostWorkerScheduler({
    sql,
    runtime,
    targets: targets(overrides),
    clock: () => new Date(millis),
  });

const state = () =>
  sql.query(
    "SELECT script, cron, next_fire_at_ms, running_until_ms, last_fired_at_ms " +
      "FROM selfhost_worker_schedules",
    [],
  );

test("a trigger seen for the first time is due at its next match, not a past one", async () => {
  const runtime = recordingRuntime();
  expect(await scheduler(runtime.runtime).tick()).toBe(0);
  expect(runtime.fires).toHaveLength(0);
  // Attached at 12:30, so 13:00 — never the 12:00 that happened before the
  // attachment existed.
  expect(await state()).toMatchObject([
    { script: SCRIPT, cron: CRON, next_fire_at_ms: Date.UTC(2026, 8, 2, 13, 0, 0) },
  ]);
});

test("fires once inside the minute it matched, on the event route with its token", async () => {
  const runtime = recordingRuntime();
  const fire = scheduler(runtime.runtime);
  await fire.tick();
  millis = Date.UTC(2026, 8, 2, 13, 0, 20);
  expect(await fire.tick()).toBe(1);
  expect(runtime.fires).toHaveLength(1);
  expect(runtime.fires[0]?.route).toBe("events");
  expect(runtime.fires[0]?.token).toBe(TOKEN);
  expect(runtime.fires[0]?.event).toMatchObject({
    kind: "schedule",
    cron: CRON,
    // The matched instant, not the instant the pass happened to run.
    scheduledTime: Date.UTC(2026, 8, 2, 13, 0, 0),
  });
  // And once: the same pass repeated inside the same minute finds the next
  // fire already advanced.
  expect(await fire.tick()).toBe(0);
  expect(await state()).toMatchObject([
    {
      next_fire_at_ms: Date.UTC(2026, 8, 2, 14, 0, 0),
      running_until_ms: null,
      last_fired_at_ms: Date.UTC(2026, 8, 2, 13, 0, 0),
    },
  ]);
});

test("a match this machine slept through is stepped over rather than fired late", async () => {
  const runtime = recordingRuntime();
  const fire = scheduler(runtime.runtime);
  await fire.tick();
  // The process was down for three hours. A backlog is exactly what the Form
  // says never to build, so nothing fires and the next future match is what
  // the row records.
  millis = Date.UTC(2026, 8, 2, 16, 5, 0);
  expect(await fire.tick()).toBe(0);
  expect(runtime.fires).toHaveLength(0);
  expect(await state()).toMatchObject([
    { next_fire_at_ms: Date.UTC(2026, 8, 2, 17, 0, 0), last_fired_at_ms: null },
  ]);
  // And the next one, which is on time, does fire.
  millis = Date.UTC(2026, 8, 2, 17, 0, 5);
  expect(await fire.tick()).toBe(1);
});

test("the next fire survives a restart, because it is a row and not a timer", async () => {
  const runtime = recordingRuntime();
  await scheduler(runtime.runtime).tick();
  millis = Date.UTC(2026, 8, 2, 13, 0, 30);
  // A different scheduler instance over the same database: a fresh process.
  const restarted = scheduler(recordingRuntime().runtime);
  expect(await restarted.tick()).toBe(1);
  expect(await state()).toMatchObject([{ next_fire_at_ms: Date.UTC(2026, 8, 2, 14, 0, 0) }]);
});

test("a trigger already running is skipped rather than started twice", async () => {
  const runtime = recordingRuntime();
  const fire = scheduler(runtime.runtime);
  await fire.tick();
  await sql.run("UPDATE selfhost_worker_schedules SET next_fire_at_ms = ?, running_until_ms = ?", [
    Date.UTC(2026, 8, 2, 13, 0, 0),
    Date.UTC(2026, 8, 2, 13, 5, 0),
  ]);
  millis = Date.UTC(2026, 8, 2, 13, 0, 30);
  expect(await fire.tick()).toBe(0);
  expect(runtime.fires).toHaveLength(0);
});

test("a failed invocation is not retried inside its minute, and releases the trigger", async () => {
  const runtime = recordingRuntime();
  runtime.answer = () => null;
  const fire = scheduler(runtime.runtime);
  await fire.tick();
  millis = Date.UTC(2026, 8, 2, 13, 0, 10);
  expect(await fire.tick()).toBe(0);
  expect(runtime.fires).toHaveLength(1);
  expect(await fire.tick()).toBe(0);
  expect(runtime.fires).toHaveLength(1);
  expect(await state()).toMatchObject([{ running_until_ms: null }]);
});

test("never fires at a Worker that declared no scheduled handler", async () => {
  const runtime = recordingRuntime();
  const fire = scheduler(runtime.runtime, { handlers: ["fetch"] });
  await fire.tick();
  millis = Date.UTC(2026, 8, 2, 13, 0, 10);
  expect(await fire.tick()).toBe(0);
  expect(runtime.fires).toHaveLength(0);
  expect(await state()).toEqual([]);
});

test("forgets the next-fire state of one trigger, or of a whole script", async () => {
  const runtime = recordingRuntime();
  const fire = scheduler(runtime.runtime, { crons: [CRON, "*/5 * * * *"] });
  await fire.tick();
  expect(await state()).toHaveLength(2);
  await fire.forgetSchedules(SCRIPT, CRON);
  expect(await state()).toHaveLength(1);
  await fire.forgetSchedules(SCRIPT);
  expect(await state()).toEqual([]);
});

test("reads the five-field UTC grammar the Form fixes, and refuses the rest", () => {
  const next = (expression: string, from: number) =>
    parseSelfhostCron(expression)?.nextAfter(from) ?? null;
  const noon = Date.UTC(2026, 8, 2, 12, 0, 0);
  expect(next("0 * * * *", noon)).toBe(Date.UTC(2026, 8, 2, 13, 0, 0));
  expect(next("*/15 * * * *", noon)).toBe(Date.UTC(2026, 8, 2, 12, 15, 0));
  expect(next("30 2 1 * *", noon)).toBe(Date.UTC(2026, 9, 1, 2, 30, 0));
  // Day-of-month and day-of-week both restricted is a union, which is the
  // historical crontab rule and the one the Form states: the 1st of a month or
  // a Wednesday, whichever comes first from a Wednesday noon.
  expect(next("0 0 1 * 3", noon)).toBe(Date.UTC(2026, 8, 9, 0, 0, 0));
  // Only one restricted constrains the day on its own.
  expect(next("0 0 * * 0", noon)).toBe(Date.UTC(2026, 8, 6, 0, 0, 0));
  // A step is not a restriction. Vixie cron sets a field's star flag from its
  // first character, so `*/1` in day-of-week leaves the day to day-of-month
  // alone: the 1st of each month, not every day.
  expect(next("0 0 1 * */1", noon)).toBe(Date.UTC(2026, 9, 1, 0, 0, 0));
  // And the same the other way round: `*/2` in day-of-month restricts nothing,
  // so this is Mondays -- not Mondays and every other day of the month. From a
  // Wednesday noon that is the following Monday, never tomorrow.
  expect(next("0 0 */2 * 1", noon)).toBe(Date.UTC(2026, 8, 7, 0, 0, 0));
  // A restriction written without a leading star still restricts.
  expect(next("0 0 1-7/2 * 1", noon)).toBe(Date.UTC(2026, 8, 3, 0, 0, 0));
  // Every field is UTC, so a schedule never shifts with a local timezone.
  expect(next("0 0 * * *", noon)).toBe(Date.UTC(2026, 8, 3, 0, 0, 0));
  // A schedule with no match at all answers rather than looping.
  expect(next("0 0 30 2 *", noon)).toBeNull();

  for (const refused of [
    "0 * * *",
    "0 * * * * *",
    "0  * * * *",
    " 0 * * * *",
    "0 * * * MON",
    "60 * * * *",
    "0 24 * * *",
    "5/2 * * * *",
    "10-5 * * * *",
    "*/0 * * * *",
    "*/61 * * * *",
    "-1 * * * *",
    "+1 * * * *",
  ]) {
    expect(parseSelfhostCron(refused)).toBeNull();
  }
});
