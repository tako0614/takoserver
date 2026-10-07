import type { V2ReferenceRequirement } from "../types.ts";
import { MODULE_WORKER_FORM_URL } from "./worker-specs.ts";

export { DURABLE_WORKFLOW_FORM_URL } from "../../workflow-v2-resource-authority.ts";

const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface DurableWorkflowSpec {
  readonly worker: { readonly resourceUid: string };
  readonly className: string;
}

export class DurableWorkflowValidationError extends TypeError {
  readonly code = "invalid_spec" as const;
  constructor() {
    super("DurableWorkflow spec is invalid");
    this.name = "DurableWorkflowValidationError";
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    own.every(
      (key) =>
        typeof key === "string" &&
        keys.includes(key) &&
        Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable) &&
        "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}),
    )
  );
}

export function parseDurableWorkflowSpec(input: unknown): DurableWorkflowSpec {
  if (
    !exactRecord(input, ["worker", "className"]) ||
    !exactRecord(input.worker, ["resourceUid"]) ||
    typeof input.worker.resourceUid !== "string" ||
    !RESOURCE_UID.test(input.worker.resourceUid) ||
    typeof input.className !== "string" ||
    !CLASS_NAME.test(input.className)
  ) {
    throw new DurableWorkflowValidationError();
  }
  return {
    worker: { resourceUid: input.worker.resourceUid },
    className: input.className,
  };
}

export function validateDurableWorkflowUpdate(
  previous: unknown,
  next: unknown,
): DurableWorkflowSpec {
  const old = parseDurableWorkflowSpec(previous);
  const current = parseDurableWorkflowSpec(next);
  if (
    old.worker.resourceUid !== current.worker.resourceUid ||
    old.className !== current.className
  ) {
    throw new DurableWorkflowValidationError();
  }
  return current;
}

export function durableWorkflowReferences(
  spec: DurableWorkflowSpec,
): readonly V2ReferenceRequirement[] {
  return [
    {
      resourceUid: spec.worker.resourceUid,
      formUrl: MODULE_WORKER_FORM_URL,
      readiness: "observed",
    },
  ];
}
