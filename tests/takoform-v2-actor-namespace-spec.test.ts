import { expect, test } from "bun:test";
import {
  ACTOR_NAMESPACE_FORM_URL,
  parseActorNamespaceSpec,
  referencesForActorNamespace,
  validateActorNamespaceUpdate,
} from "../src/takoform-v2/forms/actor-namespace.ts";
import { MODULE_WORKER_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";

test("ActorNamespace v2 accepts only its exact Worker/class pair", () => {
  expect(ACTOR_NAMESPACE_FORM_URL).toBe(
    "https://edge.forms.takoform.com/forms/ActorNamespace/0.3.0/",
  );
  const spec = { worker: { resourceUid: "worker-1" }, className: "CounterActor" };
  expect(parseActorNamespaceSpec(spec)).toEqual(spec);
  expect(validateActorNamespaceUpdate(spec, structuredClone(spec))).toEqual(spec);
  expect(referencesForActorNamespace(spec)).toEqual([
    { resourceUid: "worker-1", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
  ]);
  for (const rejected of [
    null,
    { ...spec, extra: true },
    { ...spec, worker: { ...spec.worker, extra: true } },
    { ...spec, worker: null },
    { ...spec, className: null },
    { ...spec, className: "bad-class" },
  ]) {
    expect(() => parseActorNamespaceSpec(rejected)).toThrow("invalid_spec");
  }
  expect(() =>
    validateActorNamespaceUpdate(spec, {
      ...spec,
      worker: { resourceUid: "worker-2" },
    }),
  ).toThrow("invalid_spec");
  expect(() => validateActorNamespaceUpdate(spec, { ...spec, className: "Other" })).toThrow(
    "invalid_spec",
  );
});
