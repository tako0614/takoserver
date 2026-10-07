import type { V2ReferenceRequirement } from "../types.ts";
import {
  AT_LEAST_ONCE_QUEUE_FORM_URL,
  boundedInteger,
  closedRecord,
} from "./at-least-once-queue.ts";
import { MODULE_WORKER_FORM_URL } from "./worker-specs.ts";

export const QUEUE_CONSUMER_FORM_URL =
  "https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/" as const;
const UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface QueueConsumerSpec {
  readonly queue: { readonly resourceUid: string };
  readonly worker: { readonly resourceUid: string };
  readonly maxBatchSize: number;
  readonly maxBatchTimeoutSeconds: number;
  readonly maxConcurrency: number;
  readonly maxRetries: number;
  readonly retryDelaySeconds: number;
  readonly deadLetterQueue?: { readonly resourceUid: string };
}

export class QueueConsumerValidationError extends TypeError {
  readonly code = "invalid_spec" as const;
  constructor() {
    super("QueueConsumer spec is invalid");
    this.name = "QueueConsumerValidationError";
  }
}

function ref(value: unknown): { readonly resourceUid: string } {
  if (
    !closedRecord(value, ["resourceUid"]) ||
    typeof value.resourceUid !== "string" ||
    !UID.test(value.resourceUid)
  ) {
    throw new QueueConsumerValidationError();
  }
  return { resourceUid: value.resourceUid };
}

export function parseQueueConsumerSpec(input: unknown): QueueConsumerSpec {
  if (
    !closedRecord(
      input,
      [
        "queue",
        "worker",
        "maxBatchSize",
        "maxBatchTimeoutSeconds",
        "maxConcurrency",
        "maxRetries",
        "retryDelaySeconds",
      ],
      ["deadLetterQueue"],
    )
  ) {
    throw new QueueConsumerValidationError();
  }
  const queue = ref(input.queue);
  const worker = ref(input.worker);
  const deadLetterQueue =
    input.deadLetterQueue === undefined ? undefined : ref(input.deadLetterQueue);
  if (
    !boundedInteger(input.maxBatchSize, 1, 100) ||
    !boundedInteger(input.maxBatchTimeoutSeconds, 0, 60) ||
    !boundedInteger(input.maxConcurrency, 1, 250) ||
    !boundedInteger(input.maxRetries, 0, 100) ||
    !boundedInteger(input.retryDelaySeconds, 0, 43_200) ||
    deadLetterQueue?.resourceUid === queue.resourceUid
  ) {
    throw new QueueConsumerValidationError();
  }
  return {
    queue,
    worker,
    maxBatchSize: input.maxBatchSize,
    maxBatchTimeoutSeconds: input.maxBatchTimeoutSeconds,
    maxConcurrency: input.maxConcurrency,
    maxRetries: input.maxRetries,
    retryDelaySeconds: input.retryDelaySeconds,
    ...(deadLetterQueue ? { deadLetterQueue } : {}),
  };
}

export function validateQueueConsumerUpdate(
  previousInput: unknown,
  nextInput: unknown,
): QueueConsumerSpec {
  const previous = parseQueueConsumerSpec(previousInput);
  const next = parseQueueConsumerSpec(nextInput);
  if (
    previous.queue.resourceUid !== next.queue.resourceUid ||
    previous.worker.resourceUid !== next.worker.resourceUid
  ) {
    throw new QueueConsumerValidationError();
  }
  return next;
}

export function queueConsumerReferences(
  spec: QueueConsumerSpec,
): readonly V2ReferenceRequirement[] {
  const refs: V2ReferenceRequirement[] = [
    {
      resourceUid: spec.queue.resourceUid,
      formUrl: AT_LEAST_ONCE_QUEUE_FORM_URL,
      readiness: "observed",
    },
    {
      resourceUid: spec.worker.resourceUid,
      formUrl: MODULE_WORKER_FORM_URL,
      readiness: "observed",
    },
  ];
  if (spec.deadLetterQueue)
    refs.push({
      resourceUid: spec.deadLetterQueue.resourceUid,
      formUrl: AT_LEAST_ONCE_QUEUE_FORM_URL,
      readiness: "observed",
    });
  return refs.sort((a, b) => a.resourceUid.localeCompare(b.resourceUid));
}
