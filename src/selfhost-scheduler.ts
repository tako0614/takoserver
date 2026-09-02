import type { Sql } from "./ports.ts";
import type { SelfhostEventTarget, SelfhostEventTargets } from "./providers/selfhost.ts";
import { parseSelfhostCron, type SelfhostCronSchedule } from "./providers/selfhost-cron.ts";
import {
  SELFHOST_WORKER_EVENT_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_HEADER,
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_TOKEN_HEADER,
  selfhostScheduleAcknowledged,
  selfhostScheduleEvent,
} from "./providers/selfhost-events.ts";
import type { WorkerdRuntime } from "./workerd-runtime.ts";

/**
 * What fires a `WorkerCronTrigger` on a machine standing on its own.
 *
 * workerd has no scheduler — its configuration has services, sockets, and
 * flags, and nothing that says "at this minute" — so the process that owns the
 * state owns the clock too. The Form fixes the behaviour and this file
 * implements exactly it:
 *
 * - **UTC only.** There is no timezone field, so two hosts can never fire the
 *   same trigger at different instants and no schedule skips or repeats an hour
 *   for a daylight-saving change.
 * - **A missed run is not made up.** A host that could not fire a match —
 *   because it was down, or because the previous invocation was still running —
 *   skips it rather than firing late. So a match is fired only while the minute
 *   it belongs to is still the current one; anything older is stepped over and
 *   the next future match is recorded. A restart after an outage therefore
 *   produces one next fire, never a backlog.
 * - **Single flight per trigger.** A claim writes a lease before the
 *   invocation, and a second pass that finds the lease live skips the match
 *   rather than running the handler twice.
 * - **At-least-once for each match.** A handler may still see one matched
 *   minute twice — a process that died after dispatch and before releasing its
 *   lease leaves the fire recorded but unacknowledged — so the Form requires
 *   the handler to be idempotent and this Host does not pretend otherwise.
 *
 * The next fire is a row rather than a timer, because a timer does not survive
 * a restart and "did I already fire 12:00?" has no answer in memory.
 */

/** How long one invocation owns its trigger before another pass may retry it. */
const DEFAULT_LEASE_MILLIS = 300_000;
/** How long one scheduled invocation may run before the scheduler gives up. */
const DEFAULT_INVOCATION_TIMEOUT_MILLIS = 60_000;
/**
 * How late a match may be fired at all.
 *
 * One minute, which is the minute the match belongs to: the cron grammar's
 * finest field is the minute, so firing inside it is firing on time and firing
 * after it is firing late. Late is what the Form says not to do.
 */
const MATCH_TOLERANCE_MILLIS = 60_000;

export interface SelfhostWorkerSchedulerOptions {
  /** Control storage; the next-fire state lives here under migration 0039. */
  readonly sql: Sql;
  readonly runtime: WorkerdRuntime;
  readonly targets: SelfhostEventTargets;
  readonly clock?: () => Date;
  readonly leaseMillis?: number;
  readonly invocationTimeoutMillis?: number;
}

export interface SelfhostWorkerScheduler {
  /** One pass over every attached trigger. Answers invocations dispatched. */
  tick(): Promise<number>;
  /** Forgets the next-fire state of one script's triggers, or of one trigger. */
  forgetSchedules(script: string, cron?: string): Promise<void>;
}

export function createSelfhostWorkerScheduler(
  options: SelfhostWorkerSchedulerOptions,
): SelfhostWorkerScheduler {
  const now = options.clock ?? (() => new Date());
  const leaseMillis = options.leaseMillis ?? DEFAULT_LEASE_MILLIS;
  const invocationTimeoutMillis =
    options.invocationTimeoutMillis ?? DEFAULT_INVOCATION_TIMEOUT_MILLIS;
  const { sql, runtime } = options;

  /**
   * The instant this trigger is next due, seeding the row when it has none.
   *
   * A trigger seen for the first time is due at its next future match, never at
   * a past one: attaching a `0 * * * *` at 12:30 asks for 13:00, not for the
   * 12:00 that happened before the attachment existed.
   */
  const due = async (
    script: string,
    schedule: SelfhostCronSchedule,
    millis: number,
  ): Promise<{ readonly nextFireAtMillis: number; readonly running: boolean } | null> => {
    const rows = await sql.query(
      "SELECT next_fire_at_ms, running_until_ms FROM selfhost_worker_schedules " +
        "WHERE script = ? AND cron = ?",
      [script, schedule.expression],
    );
    const row = rows[0];
    if (!row) {
      const next = schedule.nextAfter(millis);
      if (next === null) return null;
      await sql.run(
        "INSERT OR IGNORE INTO selfhost_worker_schedules (script, cron, next_fire_at_ms) " +
          "VALUES (?, ?, ?)",
        [script, schedule.expression, next],
      );
      return { nextFireAtMillis: next, running: false };
    }
    const running = row.running_until_ms !== null && Number(row.running_until_ms) > millis;
    return { nextFireAtMillis: Number(row.next_fire_at_ms), running };
  };

  const invoke = async (
    target: SelfhostEventTarget,
    cron: string,
    scheduledTime: number,
  ): Promise<boolean> => {
    try {
      const event = selfhostScheduleEvent({
        script: target.script,
        publication: target.versionId,
        cron,
        scheduledTime,
      });
      const answer = await runtime.probe?.(target.script, SELFHOST_WORKER_EVENT_PATH, {
        method: "POST",
        route: "events",
        headers: {
          "content-type": SELFHOST_WORKER_EVENT_CONTENT_TYPE,
          accept: SELFHOST_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
          [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_WORKER_EVENT_PROTOCOL,
          [SELFHOST_WORKER_EVENT_TOKEN_HEADER]: target.eventToken,
        },
        body: JSON.stringify(event),
        timeoutMillis: invocationTimeoutMillis,
      });
      // The status and the envelope: a 200 carrying anything but this Host's own
      // acknowledgement is a Worker that did not run the handler.
      return answer?.status === 200 && selfhostScheduleAcknowledged(answer.body);
    } catch {
      return false;
    }
  };

  return {
    async tick() {
      const targets = await options.targets.list();
      let fired = 0;
      for (const target of targets) {
        // A Worker that never declared `scheduled` cannot be handed a match.
        if (!target.handlers.includes("scheduled")) continue;
        for (const cron of target.crons) {
          const schedule = parseSelfhostCron(cron);
          // A recorded expression this Host cannot read fires nothing. The
          // apply refuses one, so reaching here means the record predates that
          // refusal or was edited outside this process.
          if (!schedule) continue;
          const millis = now().getTime();
          const state = await due(target.script, schedule, millis);
          if (!state || state.running || state.nextFireAtMillis > millis) continue;
          const next = schedule.nextAfter(millis);
          if (next === null) continue;
          // Too late to be this match's minute: step over it and record the
          // next one. A backlog is exactly what the Form says never to build.
          if (millis - state.nextFireAtMillis >= MATCH_TOLERANCE_MILLIS) {
            await sql.run(
              "UPDATE selfhost_worker_schedules SET next_fire_at_ms = ? " +
                "WHERE script = ? AND cron = ? AND next_fire_at_ms = ?",
              [next, target.script, cron, state.nextFireAtMillis],
            );
            continue;
          }
          // The claim and the advance are one statement, fenced on the exact
          // instant this pass read: two passes cannot both own the minute, and
          // a lease that is still live is what makes the second one skip.
          const claim = await sql.run(
            "UPDATE selfhost_worker_schedules SET running_until_ms = ?, next_fire_at_ms = ? " +
              "WHERE script = ? AND cron = ? AND next_fire_at_ms = ? " +
              "AND (running_until_ms IS NULL OR running_until_ms <= ?)",
            [millis + leaseMillis, next, target.script, cron, state.nextFireAtMillis, millis],
          );
          if (claim.changes !== 1) continue;
          const acknowledged = await invoke(target, cron, state.nextFireAtMillis);
          await sql.run(
            "UPDATE selfhost_worker_schedules SET running_until_ms = NULL, last_fired_at_ms = ? " +
              "WHERE script = ? AND cron = ?",
            [state.nextFireAtMillis, target.script, cron],
          );
          // A failed invocation is a failed invocation, not a retry: the Form
          // says a match is not retried within its minute.
          if (acknowledged) fired += 1;
        }
      }
      return fired;
    },

    async forgetSchedules(script, cron) {
      if (cron === undefined) {
        await sql.run("DELETE FROM selfhost_worker_schedules WHERE script = ?", [script]);
        return;
      }
      await sql.run("DELETE FROM selfhost_worker_schedules WHERE script = ? AND cron = ?", [
        script,
        cron,
      ]);
    },
  };
}
