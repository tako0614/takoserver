/**
 * The five-field cron grammar a `WorkerCronTrigger` is written in.
 *
 * The Form fixes it exactly, and fixing it is the point: "schedules are
 * interpreted in UTC only; there is no timezone field, so two hosts can never
 * fire the same trigger at different instants and no schedule ever skips or
 * repeats an hour for a daylight-saving transition." Everything here is
 * therefore computed in UTC, from `Date.UTC` and the `getUTC*` readers, and a
 * local timezone never enters.
 *
 * The grammar is minute, hour, day-of-month, month, day-of-week separated by
 * single spaces. Each field is a comma-separated list of `*`, a literal, a
 * range `low-high`, `*&#47;step`, or `low-high/step`. Names (`JAN`, `MON`) are
 * not accepted, and neither is a step on a bare literal, a value outside its
 * field's range, an inverted range, or a step outside `1..span`. A parse
 * failure is `null` rather than a thrown error, because every caller here has
 * to refuse a trigger rather than crash on one.
 *
 * When day-of-month and day-of-week are BOTH restricted a day matches if
 * either selects it; when only one is restricted only that one constrains the
 * day. That is the historical crontab rule and the one the Form states, and
 * "restricted" is decided the way Vixie cron decides it: from the field's FIRST
 * CHARACTER. `*&#47;2` is therefore unrestricted -- it is a step through every
 * value of the field, so the field still selects all of them -- while `1-5/2`
 * and a bare literal are restricted. Reading a step as restriction makes
 * `0 0 1 * *&#47;1` fire every day instead of on the 1st of each month.
 */

/** Fields, in order, with the inclusive range each accepts. */
const FIELDS = [
  { name: "minute", low: 0, high: 59 },
  { name: "hour", low: 0, high: 23 },
  { name: "dayOfMonth", low: 1, high: 31 },
  { name: "month", low: 1, high: 12 },
  { name: "dayOfWeek", low: 0, high: 6 },
] as const;

const MINUTE_MS = 60_000;
/**
 * How far ahead a search may look before giving up.
 *
 * Four years covers a leap day under any schedule that has a next match at
 * all; `29 2 * *` on a non-leap-year start is the case that needs it. A
 * schedule with no match — `31 2` in February terms, `0 0 30 2 *` — walks the
 * whole window and answers `null` rather than looping.
 */
const SEARCH_LIMIT_MS = 4 * 366 * 24 * 60 * MINUTE_MS;

export interface SelfhostCronSchedule {
  /** The expression exactly as written; it is the durable identity. */
  readonly expression: string;
  /** Whether the minute containing this instant is a match. */
  matches(millis: number): boolean;
  /**
   * The first matching minute strictly after `millis`, or null when the
   * schedule has none inside the search window.
   */
  nextAfter(millis: number): number | null;
}

interface Field {
  readonly values: ReadonlySet<number>;
  /**
   * Whether this field constrains the day, for the two day fields.
   *
   * Vixie cron sets a field's star flag from its first character and reads that
   * flag as "unrestricted", so anything beginning with `*` -- `*` itself and
   * every `*&#47;step` -- is unrestricted however few values it ends up
   * selecting.
   */
  readonly restricted: boolean;
}

/**
 * Parses one expression, or answers null.
 *
 * The bound on length is deliberate and comes first: this string arrives in a
 * Resource spec, is stored durably, and is compared on every scheduler tick.
 */
export function parseSelfhostCron(expression: unknown): SelfhostCronSchedule | null {
  if (typeof expression !== "string" || expression.length < 9 || expression.length > 256) {
    return null;
  }
  // Single spaces only. `trim()` plus a split on runs of whitespace would
  // accept two different strings as the same schedule, and the expression is
  // its own durable identity here.
  const parts = expression.split(" ");
  if (parts.length !== FIELDS.length) return null;
  const parsed: Field[] = [];
  for (let index = 0; index < FIELDS.length; index += 1) {
    const field = parseField(parts[index] as string, FIELDS[index] as (typeof FIELDS)[number]);
    if (!field) return null;
    parsed.push(field);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as [
    Field,
    Field,
    Field,
    Field,
    Field,
  ];

  const dayMatches = (date: Date): boolean => {
    const dom = dayOfMonth.values.has(date.getUTCDate());
    const dow = dayOfWeek.values.has(date.getUTCDay());
    if (dayOfMonth.restricted && dayOfWeek.restricted) return dom || dow;
    if (dayOfMonth.restricted) return dom;
    if (dayOfWeek.restricted) return dow;
    return true;
  };

  const matchesMinute = (millis: number): boolean => {
    const date = new Date(millis);
    return (
      month.values.has(date.getUTCMonth() + 1) &&
      dayMatches(date) &&
      hour.values.has(date.getUTCHours()) &&
      minute.values.has(date.getUTCMinutes())
    );
  };

  return {
    expression,
    matches(millis) {
      if (!Number.isFinite(millis)) return false;
      return matchesMinute(Math.floor(millis / MINUTE_MS) * MINUTE_MS);
    },
    nextAfter(millis) {
      if (!Number.isSafeInteger(millis)) return null;
      const deadline = millis + SEARCH_LIMIT_MS;
      // The first whole minute strictly after the instant asked about, so a
      // fire recorded at its own matched minute never returns itself.
      let candidate = Math.floor(millis / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
      while (candidate <= deadline) {
        const date = new Date(candidate);
        if (!month.values.has(date.getUTCMonth() + 1)) {
          candidate = startOfNextMonth(date);
          continue;
        }
        if (!dayMatches(date)) {
          candidate = startOfNextDay(date);
          continue;
        }
        if (!hour.values.has(date.getUTCHours())) {
          candidate = startOfNextHour(date);
          continue;
        }
        if (!minute.values.has(date.getUTCMinutes())) {
          candidate += MINUTE_MS;
          continue;
        }
        return candidate;
      }
      return null;
    },
  };
}

function parseField(text: string, bounds: (typeof FIELDS)[number]): Field | null {
  if (text.length === 0 || text.length > 128) return null;
  const values = new Set<number>();
  // The field's own first character, exactly as the historical implementation
  // reads it. Deriving this from the terms instead made `*/n` a restriction,
  // and a restriction in a day field changes which days match.
  const restricted = !text.startsWith("*");
  for (const term of text.split(",")) {
    const slash = term.indexOf("/");
    const head = slash < 0 ? term : term.slice(0, slash);
    const stepText = slash < 0 ? null : term.slice(slash + 1);
    let low: number;
    let high: number;
    if (head === "*") {
      low = bounds.low;
      high = bounds.high;
    } else {
      const dash = head.indexOf("-");
      if (dash < 0) {
        const single = wholeNumber(head);
        if (single === null || single < bounds.low || single > bounds.high) return null;
        // A step on a bare literal is not a range, so there is nothing to step
        // through; the grammar does not accept it and neither does this.
        if (stepText !== null) return null;
        values.add(single);
        continue;
      }
      const start = wholeNumber(head.slice(0, dash));
      const end = wholeNumber(head.slice(dash + 1));
      if (
        start === null ||
        end === null ||
        start < bounds.low ||
        end > bounds.high ||
        start > end
      ) {
        return null;
      }
      low = start;
      high = end;
    }
    let step = 1;
    if (stepText !== null) {
      const parsedStep = wholeNumber(stepText);
      const span = high - low + 1;
      if (parsedStep === null || parsedStep < 1 || parsedStep > span) return null;
      step = parsedStep;
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values.size === 0 ? null : { values, restricted };
}

/** A decimal whole number with no sign, no space, and no leading `+`. */
function wholeNumber(text: string): number | null {
  if (!/^(?:0|[1-9][0-9]{0,3})$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function startOfNextMonth(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

function startOfNextDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0);
}

function startOfNextHour(date: Date): number {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours() + 1,
    0,
    0,
    0,
  );
}
