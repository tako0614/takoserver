import { CONTAINER_CONTRACT as C } from "../../container-contract.ts";
import { canonicalJson } from "../../json.ts";
import type { V2ReferenceRequirement } from "../types.ts";
import { containerRecord } from "./container.ts";
import { referencesForWorkerVersion } from "./worker-references.ts";
import {
  parseWorkerVersionSpec,
  WorkerFormValidationError,
  type WorkerVersionBinding,
  type WorkerVersionSpec,
} from "./worker-specs.ts";

const F = C.fields;
export type ContainerWorkerVersionSpec = WorkerVersionSpec & {
  readonly [F.containerBindings]: readonly WorkerVersionBinding[];
};

/** A successor parser; the frozen predecessor still rejects this new field. */
export function parseContainerWorkerVersionSpec(input: unknown): ContainerWorkerVersionSpec {
  const value = containerRecord(input);
  const previous = { ...value };
  delete previous[F.containerBindings];
  const spec = parseWorkerVersionSpec(previous);
  const entries = Object.hasOwn(value, F.containerBindings) ? value[F.containerBindings] : [];
  if (
    !Array.isArray(entries) ||
    entries.length > 64 ||
    Reflect.ownKeys(entries).length !== entries.length + 1
  )
    throw new WorkerFormValidationError();
  const names = new Set([
    ...Object.keys(spec.vars),
    ...spec.requiredSensitiveVars,
    ...[
      spec.kvBindings,
      spec.sqliteBindings,
      spec.bucketBindings,
      spec.queueProducerBindings,
      spec.serviceBindings,
      spec.actorBindings,
      spec.workflowBindings,
    ]
      .flat()
      .map((binding) => binding.name),
  ]);
  const bindings: WorkerVersionBinding[] = entries.map((entry) => {
    const binding = containerRecord(entry);
    const resource = containerRecord(binding[F.resource]);
    const name = binding[F.name];
    const uid = resource[F.resourceUid];
    if (
      Object.keys(binding).length !== 2 ||
      Object.keys(binding).some((key) => ![F.name, F.resource].includes(key as typeof F.name)) ||
      Object.keys(resource).length !== 1 ||
      typeof name !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(name) ||
      names.has(name) ||
      typeof uid !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(uid)
    )
      throw new WorkerFormValidationError();
    names.add(name);
    return { [F.name]: name, [F.resource]: { [F.resourceUid]: uid } };
  });
  if (bindings.length && !spec.bundle) throw new WorkerFormValidationError();
  return {
    ...spec,
    [F.containerBindings]: bindings.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
  };
}

export function validateContainerWorkerVersionUpdate(previous: unknown, next: unknown): void {
  if (
    canonicalJson(parseContainerWorkerVersionSpec(previous)) !==
    canonicalJson(parseContainerWorkerVersionSpec(next))
  )
    throw new WorkerFormValidationError();
}

export function referencesForContainerWorkerVersion(
  spec: ContainerWorkerVersionSpec,
): readonly V2ReferenceRequirement[] {
  const requirements = [
    ...referencesForWorkerVersion(spec),
    ...spec[F.containerBindings].map((binding) => ({
      resourceUid: binding.resource.resourceUid,
      formUrl: C.formUrl,
      readiness: "observed" as const,
    })),
  ];
  const byUid = new Map<string, V2ReferenceRequirement>();
  for (const requirement of requirements) {
    const previous = byUid.get(requirement.resourceUid);
    if (previous && previous.formUrl !== requirement.formUrl) throw new WorkerFormValidationError();
    byUid.set(requirement.resourceUid, requirement);
  }
  return [...byUid.values()].sort((a, b) => a.resourceUid.localeCompare(b.resourceUid));
}
