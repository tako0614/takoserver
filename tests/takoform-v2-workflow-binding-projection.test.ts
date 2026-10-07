import { expect, test } from "bun:test";
import { projectV2WorkflowForward } from "../src/takoform-v2/workflow-binding-projection.ts";

const identity = {
  workerUid: "worker-one",
  versionUid: "version-one",
  sourceOperationId: "operation-one",
  nativeVersionId: "v2-native-one",
};
const declarations = [{ name: "FLOW", resource: { resourceUid: "workflow-one" } }];
const grants = [
  {
    publicName: "FLOW",
    tenantId: "org:one",
    workflowResourceUid: "workflow-one",
    token: "a".repeat(64),
  },
];

test("v2 Workflow projection binds only the declared name and accepted target without old digests", async () => {
  const projected = await projectV2WorkflowForward({
    ...identity,
    principal: "org:one",
    declarations,
    grants,
  });
  expect(projected).toMatchObject({
    schema: "takoserver.v2-workflow-binding-forward@1",
    bindings: grants,
  });
  expect(projected.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(JSON.stringify(projected)).not.toContain("schemaDigest");
  expect(JSON.stringify(projected)).not.toContain("bindingRef");
  expect(JSON.stringify(projected)).not.toContain("runtimeClassRef");
});

test("v2 Workflow projection refuses a grant for another UID or an undeclared env name", async () => {
  const firstGrant = grants[0];
  if (!firstGrant) throw new Error("Workflow grant unavailable");
  await expect(
    projectV2WorkflowForward({
      ...identity,
      principal: "org:one",
      declarations,
      grants: [{ ...firstGrant, workflowResourceUid: "workflow-other" }],
    }),
  ).rejects.toThrow();
  await expect(
    projectV2WorkflowForward({
      ...identity,
      principal: "org:one",
      declarations,
      grants: [{ ...firstGrant, publicName: "EXTRA" }],
    }),
  ).rejects.toThrow();
});
