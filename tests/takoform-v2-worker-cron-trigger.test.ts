import { describe, expect, test } from "bun:test";
import { parseWorkerCronTriggerSpec } from "../src/takoform-v2/forms/worker-cron-trigger.ts";

describe("WorkerCronTrigger 0.3", () => {
  test("accepts the exact published attachment shape and preserves its expression", () => {
    const parsed = parseWorkerCronTriggerSpec({
      worker: { resourceUid: "worker-1" },
      cron: "*/5 * * * *",
    });

    expect({ worker: parsed.worker, cron: parsed.cron }).toEqual({
      worker: { resourceUid: "worker-1" },
      cron: "*/5 * * * *",
    });
    expect(parsed.schedule.matches(Date.UTC(2026, 9, 7, 12, 10))).toBe(true);
    expect(parsed.schedule.matches(Date.UTC(2026, 9, 7, 12, 11))).toBe(false);
  });

  test("uses the published DOM/DOW OR rule when both fields are restricted", () => {
    const parsed = parseWorkerCronTriggerSpec({
      worker: { resourceUid: "worker-1" },
      cron: "0 0 */2 1 1",
    });

    // 2024-01-03 is an odd day but Wednesday. The */2 day-of-month field is
    // restricted, so its match is sufficient even though weekday does not match.
    expect(parsed.schedule.matches(Date.UTC(2024, 0, 3, 0, 0))).toBe(true);
    expect(parsed.schedule.matches(Date.UTC(2024, 0, 2, 0, 0))).toBe(false);
  });

  test("calculates the next matching minute strictly after the supplied instant in UTC", () => {
    const parsed = parseWorkerCronTriggerSpec({
      worker: { resourceUid: "worker-1" },
      cron: "0 0 1 1 *",
    });

    expect(parsed.schedule.nextAfter(Date.UTC(2026, 0, 1, 0, 0))).toBe(Date.UTC(2027, 0, 1, 0, 0));
  });

  test("accepts a field-width step even when its explicit range is narrower", () => {
    const parsed = parseWorkerCronTriggerSpec({
      worker: { resourceUid: "worker-1" },
      cron: "0-5/60 * * * *",
    });

    expect(parsed.schedule.matches(Date.UTC(2026, 9, 7, 12, 0))).toBe(true);
    expect(parsed.schedule.matches(Date.UTC(2026, 9, 7, 12, 1))).toBe(false);
  });

  test.each([
    [{ worker: { resourceUid: "worker-1" }, cron: "0  0 * * *" }],
    [{ worker: { resourceUid: "worker-1" }, cron: "0\t0 * * *" }],
    [{ worker: { resourceUid: "worker-1" }, cron: "0 0 * * * trailing" }],
    [{ worker: { resourceUid: "worker-1" }, cron: "0 0 0 * *" }],
    [{ worker: { resourceUid: "worker-1" }, cron: "0 0 */99 * *" }],
    [{ worker: { resourceUid: "worker-1" }, cron: "0 0 3/2 * *" }],
    [{ worker: { resourceUid: "worker-1" }, cron: "0 0 * * 7" }],
    [{ worker: { resourceUid: "worker-1" }, cron: `0 0 * * *${" ".repeat(60)}` }],
    [{ worker: { resourceUid: "worker-1" }, cron: "0 0 * * *", extra: true }],
    [{ worker: { resourceUid: "worker-1", name: "not-a-reference" }, cron: "0 0 * * *" }],
    [{ worker: { resourceUid: "" }, cron: "0 0 * * *" }],
  ])("rejects malformed or unknown fields: %j", (input) => {
    expect(() => parseWorkerCronTriggerSpec(input)).toThrow();
  });
});
