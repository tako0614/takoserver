import { expect, test } from "bun:test";
import {
  ACTOR_NAMESPACE_FORM_URL,
  createV2ActorNamespaceFormFrontFace,
  createV2DurableWorkflowFormFrontFace,
  DURABLE_WORKFLOW_BACKEND_ID,
  DURABLE_WORKFLOW_FORM_URL,
  MODULE_WORKER_FORM_URL,
  V2_ACTOR_NAMESPACE_BACKEND_ID,
  type V2FormFrontFace,
} from "@takoserver/core/takoform-v2";
import { TakoformV2Error } from "../src/takoform-v2/types.ts";

const cases = [
  {
    name: "ActorNamespace",
    create: createV2ActorNamespaceFormFrontFace,
    formUrl: ACTOR_NAMESPACE_FORM_URL,
    backendId: V2_ACTOR_NAMESPACE_BACKEND_ID,
    expectedBackendId: "selfhost-v2-actor-namespace-sql-v1",
  },
  {
    name: "DurableWorkflow",
    create: createV2DurableWorkflowFormFrontFace,
    formUrl: DURABLE_WORKFLOW_FORM_URL,
    backendId: DURABLE_WORKFLOW_BACKEND_ID,
    expectedBackendId: "selfhost-v2-durable-workflow-v1",
  },
] as const;

for (const item of cases) {
  test(`${item.name} frontface retains exact validation, immutable update, reference and delete policy`, () => {
    const frontface: V2FormFrontFace = item.create();
    const spec = { worker: { resourceUid: "worker-one" }, className: "ValidClass" };
    expect(Object.keys(frontface).sort()).toEqual([
      "references",
      "rejectDeleteWhileReferenced",
      "validateCreate",
      "validateUpdate",
    ]);
    expect(frontface.rejectDeleteWhileReferenced).toBe(true);
    expect(item.formUrl).toBe(`https://edge.forms.takoform.com/forms/${item.name}/0.3.0/`);
    expect(item.backendId).toBe(item.expectedBackendId);
    expect(frontface.validateCreate(spec)).toBeUndefined();
    expect(frontface.validateUpdate(spec, structuredClone(spec))).toBeUndefined();
    expect(frontface.references(spec)).toEqual([
      { resourceUid: "worker-one", formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
    ]);
    for (const invalid of [
      { ...spec, extra: true },
      { ...spec, className: "bad-class" },
      { ...spec, worker: { resourceUid: "worker-one", extra: true } },
    ]) {
      expect(() => frontface.validateCreate(invalid)).toThrow(TakoformV2Error);
      expect(() => frontface.references(invalid)).toThrow();
    }
    for (const changed of [
      { ...spec, className: "OtherClass" },
      { ...spec, worker: { resourceUid: "worker-two" } },
    ]) {
      expect(() => frontface.validateUpdate(spec, changed)).toThrow(TakoformV2Error);
    }
  });
}
