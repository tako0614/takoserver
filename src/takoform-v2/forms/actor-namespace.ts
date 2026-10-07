import type { V2ReferenceRequirement } from "../types.ts";
import { MODULE_WORKER_FORM_URL } from "./worker-specs.ts";

export const ACTOR_NAMESPACE_FORM_URL =
  "https://edge.forms.takoform.com/forms/ActorNamespace/0.3.0/" as const;

export interface ActorNamespaceSpec {
  readonly worker: { readonly resourceUid: string };
  readonly className: string;
}

export class ActorNamespaceValidationError extends Error {
  constructor() {
    super("invalid_spec");
    this.name = "ActorNamespaceValidationError";
  }
}

const UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ActorNamespaceValidationError();
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new ActorNamespaceValidationError();
  }
}

export function parseActorNamespaceSpec(value: unknown): ActorNamespaceSpec {
  const spec = record(value);
  exact(spec, ["worker", "className"]);
  const worker = record(spec.worker);
  exact(worker, ["resourceUid"]);
  if (
    typeof worker.resourceUid !== "string" ||
    !UID.test(worker.resourceUid) ||
    typeof spec.className !== "string" ||
    !CLASS_NAME.test(spec.className)
  ) {
    throw new ActorNamespaceValidationError();
  }
  return {
    worker: { resourceUid: worker.resourceUid },
    className: spec.className,
  };
}

export function validateActorNamespaceUpdate(previous: unknown, next: unknown): ActorNamespaceSpec {
  const before = parseActorNamespaceSpec(previous);
  const after = parseActorNamespaceSpec(next);
  if (
    before.worker.resourceUid !== after.worker.resourceUid ||
    before.className !== after.className
  ) {
    throw new ActorNamespaceValidationError();
  }
  return after;
}

export function referencesForActorNamespace(value: unknown): readonly V2ReferenceRequirement[] {
  const spec = parseActorNamespaceSpec(value);
  return [
    {
      resourceUid: spec.worker.resourceUid,
      formUrl: MODULE_WORKER_FORM_URL,
      readiness: "observed",
    },
  ];
}
