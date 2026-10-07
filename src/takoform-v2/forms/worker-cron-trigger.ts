import { MODULE_WORKER_FORM_URL } from "./worker-specs.ts";

export const WORKER_CRON_TRIGGER_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/" as const;

const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MINUTE_MILLISECONDS = 60_000;
const SEARCH_LIMIT_MILLISECONDS = 4 * 366 * 24 * 60 * MINUTE_MILLISECONDS;

const FIELDS = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12 },
  { minimum: 0, maximum: 6 },
] as const;

export class WorkerCronTriggerValidationError extends TypeError {
  readonly code = "invalid_spec" as const;

  constructor() {
    super("WorkerCronTrigger spec is invalid");
    this.name = "WorkerCronTriggerValidationError";
  }
}

export interface WorkerCronSchedule {
  readonly expression: string;
  matches(timestampMillis: number): boolean;
  nextAfter(timestampMillis: number): number | null;
}

export interface WorkerCronTriggerSpec {
  readonly worker: { readonly resourceUid: string };
  readonly cron: string;
  readonly schedule: WorkerCronSchedule;
}

export function parseWorkerCronTriggerSpec(input: unknown): WorkerCronTriggerSpec {
  if (!recordWithKeys(input, ["worker", "cron"])) throw new WorkerCronTriggerValidationError();
  const worker = (input as Record<string, unknown>).worker;
  const cron = (input as Record<string, unknown>).cron;
  if (
    !recordWithKeys(worker, ["resourceUid"]) ||
    typeof (worker as Record<string, unknown>).resourceUid !== "string" ||
    !RESOURCE_UID.test((worker as Record<string, unknown>).resourceUid as string) ||
    typeof cron !== "string"
  ) {
    throw new WorkerCronTriggerValidationError();
  }
  const schedule = parseCronExpression(cron);
  if (!schedule) throw new WorkerCronTriggerValidationError();
  return {
    worker: { resourceUid: (worker as { resourceUid: string }).resourceUid },
    cron,
    schedule,
  };
}

export function validateWorkerCronTriggerUpdate(
  previousInput: unknown,
  nextInput: unknown,
): WorkerCronTriggerSpec {
  const previous = parseWorkerCronTriggerSpec(previousInput);
  const next = parseWorkerCronTriggerSpec(nextInput);
  if (previous.worker.resourceUid !== next.worker.resourceUid) {
    throw new WorkerCronTriggerValidationError();
  }
  return next;
}

export function workerCronTriggerReferences(
  spec: WorkerCronTriggerSpec,
): readonly [
  {
    readonly resourceUid: string;
    readonly formUrl: typeof MODULE_WORKER_FORM_URL;
    readonly readiness: "observed";
  },
] {
  return [
    {
      resourceUid: spec.worker.resourceUid,
      formUrl: MODULE_WORKER_FORM_URL,
      readiness: "observed",
    },
  ];
}

function parseCronExpression(expression: string): WorkerCronSchedule | null {
  if (expression.length < 9 || expression.length > 64 || /[^\x20-\x7e]/u.test(expression)) {
    return null;
  }
  const parts = expression.split(" ");
  if (parts.length !== FIELDS.length || parts.some((part) => part.length === 0)) return null;
  const fields = parts.map((part, index) =>
    parseField(part, FIELDS[index] as (typeof FIELDS)[number]),
  );
  if (fields.some((field) => field === null)) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    CronField,
    CronField,
    CronField,
    CronField,
    CronField,
  ];
  const dayOfMonthRestricted = parts[2] !== "*";
  const dayOfWeekRestricted = parts[4] !== "*";

  return {
    expression,
    matches(timestampMillis) {
      if (!Number.isFinite(timestampMillis)) return false;
      const date = new Date(
        Math.floor(timestampMillis / MINUTE_MILLISECONDS) * MINUTE_MILLISECONDS,
      );
      return (
        minute.values.has(date.getUTCMinutes()) &&
        hour.values.has(date.getUTCHours()) &&
        month.values.has(date.getUTCMonth() + 1) &&
        dayMatches(date.getUTCDate(), date.getUTCDay())
      );
    },
    nextAfter(timestampMillis) {
      if (!Number.isSafeInteger(timestampMillis)) return null;
      const deadline = timestampMillis + SEARCH_LIMIT_MILLISECONDS;
      let candidate =
        Math.floor(timestampMillis / MINUTE_MILLISECONDS) * MINUTE_MILLISECONDS +
        MINUTE_MILLISECONDS;
      while (candidate <= deadline) {
        const date = new Date(candidate);
        if (!month.values.has(date.getUTCMonth() + 1)) {
          candidate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
          continue;
        }
        if (!dayMatches(date.getUTCDate(), date.getUTCDay())) {
          candidate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
          continue;
        }
        if (!hour.values.has(date.getUTCHours())) {
          candidate = Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            date.getUTCHours() + 1,
          );
          continue;
        }
        if (!minute.values.has(date.getUTCMinutes())) {
          candidate += MINUTE_MILLISECONDS;
          continue;
        }
        return candidate;
      }
      return null;
    },
  };

  function dayMatches(dayOfMonthValue: number, dayOfWeekValue: number): boolean {
    const dom = dayOfMonth.values.has(dayOfMonthValue);
    const dow = dayOfWeek.values.has(dayOfWeekValue);
    if (dayOfMonthRestricted && dayOfWeekRestricted) return dom || dow;
    if (dayOfMonthRestricted) return dom;
    if (dayOfWeekRestricted) return dow;
    return true;
  }
}

interface CronField {
  readonly values: ReadonlySet<number>;
}

function parseField(
  text: string,
  bounds: { readonly minimum: number; readonly maximum: number },
): CronField | null {
  const values = new Set<number>();
  for (const term of text.split(",")) {
    if (term.length === 0) return null;
    const slash = term.indexOf("/");
    if (slash !== term.lastIndexOf("/")) return null;
    const rangeText = slash < 0 ? term : term.slice(0, slash);
    const stepText = slash < 0 ? null : term.slice(slash + 1);
    if (stepText !== null && !decimal(stepText)) return null;
    const step = stepText === null ? 1 : Number(stepText);
    let low: number;
    let high: number;
    if (rangeText === "*") {
      low = bounds.minimum;
      high = bounds.maximum;
    } else {
      const dash = rangeText.indexOf("-");
      if (dash !== rangeText.lastIndexOf("-")) return null;
      if (dash < 0) {
        const value = decimal(rangeText) ? Number(rangeText) : NaN;
        if (
          stepText !== null ||
          !Number.isSafeInteger(value) ||
          value < bounds.minimum ||
          value > bounds.maximum
        ) {
          return null;
        }
        values.add(value);
        continue;
      }
      const startText = rangeText.slice(0, dash);
      const endText = rangeText.slice(dash + 1);
      low = decimal(startText) ? Number(startText) : NaN;
      high = decimal(endText) ? Number(endText) : NaN;
      if (
        !Number.isSafeInteger(low) ||
        !Number.isSafeInteger(high) ||
        low < bounds.minimum ||
        high > bounds.maximum ||
        low > high
      ) {
        return null;
      }
    }
    if (!Number.isSafeInteger(step) || step < 1 || step > bounds.maximum - bounds.minimum + 1)
      return null;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values.size === 0 ? null : { values };
}

function decimal(value: string): boolean {
  return /^[0-9]+$/u.test(value);
}

function recordWithKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    return false;
  }
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && "value" in descriptor);
  });
}
