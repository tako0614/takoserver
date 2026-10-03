import { expect, test } from "bun:test";
import { projectPublisherWorkerClassRuntime } from "../scripts/publisher-class-runtime-projection.ts";

const actorRef = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.actor",
  version: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};
const workflowRef = { ...actorRef, name: "worker.workflow" };

test("publisher Host projection preserves the unique exact class InterfaceRef", () => {
  expect(
    projectPublisherWorkerClassRuntime("ActorNamespace", { providedInterfaces: [actorRef] }),
  ).toMatchObject({
    workerClassRuntime: { providedInterface: "worker.actor", runtimeClassRef: actorRef },
  });
  expect(
    projectPublisherWorkerClassRuntime("DurableWorkflow", { providedInterfaces: [workflowRef] }),
  ).toMatchObject({
    workerClassRuntime: { providedInterface: "worker.workflow", runtimeClassRef: workflowRef },
  });
  expect(projectPublisherWorkerClassRuntime("ModuleWorker", { providedInterfaces: [] })).toEqual(
    {},
  );
});

test("publisher Host projection rejects missing, duplicate, or malformed class InterfaceRefs", () => {
  for (const providedInterfaces of [
    [],
    [workflowRef],
    [actorRef, actorRef],
    [{ ...actorRef, apiVersion: "interfaces.takoform.com/v1alpha2" }],
    [{ ...actorRef, version: "not-a-version" }],
    [{ ...actorRef, schemaDigest: "sha256:invalid" }],
    [{ ...actorRef, unexpected: true }],
    [{ ...actorRef, schemaDigest: undefined }],
    [null],
  ]) {
    expect(() =>
      projectPublisherWorkerClassRuntime("ActorNamespace", { providedInterfaces }),
    ).toThrow("publisher_set_projection_invalid");
  }
  expect(() => projectPublisherWorkerClassRuntime("ActorNamespace", {})).toThrow(
    "publisher_set_projection_invalid",
  );
});
