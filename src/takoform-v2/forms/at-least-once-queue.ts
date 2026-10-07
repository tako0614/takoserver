export const AT_LEAST_ONCE_QUEUE_FORM_URL =
  "https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/" as const;

export interface AtLeastOnceQueueSpec {
  readonly deliveryDelaySeconds: number;
  readonly messageRetentionSeconds: number;
}

export class AtLeastOnceQueueValidationError extends TypeError {
  readonly code = "invalid_spec" as const;
  constructor() {
    super("AtLeastOnceQueue spec is invalid");
    this.name = "AtLeastOnceQueueValidationError";
  }
}

export function parseAtLeastOnceQueueSpec(input: unknown): AtLeastOnceQueueSpec {
  if (!closedRecord(input, ["messageRetentionSeconds"], ["deliveryDelaySeconds"])) {
    throw new AtLeastOnceQueueValidationError();
  }
  const retention = input.messageRetentionSeconds;
  const delay = input.deliveryDelaySeconds ?? 0;
  if (!boundedInteger(retention, 60, 1_209_600) || !boundedInteger(delay, 0, 43_200)) {
    throw new AtLeastOnceQueueValidationError();
  }
  return { deliveryDelaySeconds: delay, messageRetentionSeconds: retention };
}

export function validateAtLeastOnceQueueUpdate(
  previous: unknown,
  next: unknown,
): AtLeastOnceQueueSpec {
  parseAtLeastOnceQueueSpec(previous);
  return parseAtLeastOnceQueueSpec(next);
}

export function boundedInteger(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;
}

/** Reject inherited, accessor, symbol, and unknown input fields. */
export function closedRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
    required.some((key) => !Object.hasOwn(input, key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return Boolean(descriptor?.enumerable && "value" in descriptor);
  });
}
