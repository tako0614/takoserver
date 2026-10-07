import { expect, test } from "bun:test";
import {
  WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
  workerdV2PrivateWorkflowBindingName,
} from "../src/providers/workerd-v2-private-binding-names.ts";
import { projectV2WorkflowForward } from "../src/takoform-v2/workflow-binding-projection.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";

const decoder = new TextDecoder();
const workflow = {
  publicName: "FLOW",
  tenantId: "org:workflow",
  workflowResourceUid: "workflow-one",
  token: "a".repeat(64),
};

test("v2 Workflow graph exposes only the declared facade and five-field private descriptor", async () => {
  const forward = await projectV2WorkflowForward({
    workerUid: "worker-one",
    versionUid: "version-one",
    sourceOperationId: "source-one",
    nativeVersionId: "native-one",
    principal: "org:workflow",
    declarations: [{ name: "FLOW", resource: { resourceUid: "workflow-one" } }],
    grants: [workflow],
  });
  const graph = compileWorkerdVersionGraph({
    directory: "site",
    mainModule: "index.js",
    modules: new Map([["index.js", new TextEncoder().encode("export default { fetch() {} };\n")]]),
    moduleMediaTypes: { "index.js": "application/javascript+module" },
    environment: [],
    serviceBindings: [],
    hostnames: [],
    generation: "takoserver-v2-operation:01234567-89ab-4cde-8f01-23456789abcd",
    workerResourceUid: "worker-one",
    declaredHandlers: ["fetch"],
    readiness: { publication: "native-one", probeHostname: "site.internal.invalid" },
    workflowForward: forward,
  });
  expect(graph.site.workflowForward).toEqual({
    ...forward,
    bindings: [{ ...workflow, serviceName: workerdV2PrivateWorkflowBindingName(0) }],
  });
  expect(graph.site.vars).toBeUndefined();
  expect(graph.site.hostEntrypoint).toBe(WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE);
  const serialized = JSON.stringify(graph.site.workflowForward);
  expect(serialized).not.toContain("workflowFormRef");
  expect(serialized).not.toContain("runtimeClassRef");
  if (!graph.site.hostEntrypoint) throw new Error("Workflow entrypoint unavailable");
  const entry = graph.hostModules.get(graph.site.hostEntrypoint);
  expect(entry).toBeDefined();
  expect(decoder.decode(entry)).toContain("FLOW");
});

test("v2 Workflow descriptor refuses a public env collision or a legacy source profile", async () => {
  const forward = await projectV2WorkflowForward({
    workerUid: "worker-one",
    versionUid: "version-one",
    sourceOperationId: "source-one",
    nativeVersionId: "native-one",
    principal: "org:workflow",
    declarations: [{ name: "FLOW", resource: { resourceUid: "workflow-one" } }],
    grants: [workflow],
  });
  const base = {
    directory: "site",
    mainModule: "index.js",
    modules: new Map([["index.js", new TextEncoder().encode("export default { fetch() {} };\n")]]),
    moduleMediaTypes: { "index.js": "application/javascript+module" as const },
    environment: [{ name: "FLOW", value: "bad", type: "plain_text" as const }],
    serviceBindings: [],
    hostnames: [],
    generation: "takoserver-v2-operation:01234567-89ab-4cde-8f01-23456789abcd",
    workerResourceUid: "worker-one",
    declaredHandlers: ["fetch" as const],
    readiness: { publication: "native-one", probeHostname: "site.internal.invalid" },
  };
  expect(() => compileWorkerdVersionGraph({ ...base, workflowForward: forward })).toThrow();
  expect(() =>
    compileWorkerdVersionGraph({
      ...base,
      environment: [],
      generation: "legacy",
      workflowForward: forward,
    }),
  ).toThrow();
});
