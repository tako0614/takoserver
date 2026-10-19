import type { Clock } from "./ports.ts";

/** Source definition only. Enrollment/source qualification binds its real artifact. */
export const AUTH103_CLOCK_RECIPE = Object.freeze({
  implementation: "root-system-date-unix-milliseconds-v1",
  unit: "unix-milliseconds",
} as const);

export interface Auth103SourceClockOriginal {
  readonly clock: Clock;
  readonly recipe: typeof AUTH103_CLOCK_RECIPE;
}

export class Auth103SourceClockUnavailable extends Error {
  readonly code = "unavailable" as const;
  constructor() {
    super("auth103_source_clock_unavailable");
    this.name = "Auth103SourceClockUnavailable";
  }
}

const sourceClocks = new WeakMap<Clock, Auth103SourceClockOriginal>();
const SystemDate = Date;
const systemNow = SystemDate.now;

/**
 * One Root-owned implementation, no caller callback/time/ref or qualification
 * claim. Native/source admission must bind this source to its actual enrolled
 * policy before the selected original can become a qualified policy Clock.
 */
export function createAuth103SourceClock(): Clock {
  const clock: Clock = () => {
    const milliseconds: unknown = Reflect.apply(systemNow, SystemDate, []);
    if (
      typeof milliseconds !== "number" ||
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 8640000000000000
    )
      throw new Auth103SourceClockUnavailable();
    return new SystemDate(milliseconds);
  };
  Object.freeze(clock);
  sourceClocks.set(clock, Object.freeze({ clock, recipe: AUTH103_CLOCK_RECIPE }));
  return clock;
}

/** Original source constructor only; no callback/getter is invoked by inspection. */
export function readAuth103SourceClock(clock: unknown): Auth103SourceClockOriginal | null {
  if (typeof clock !== "function") return null;
  return sourceClocks.get(clock as Clock) ?? null;
}
