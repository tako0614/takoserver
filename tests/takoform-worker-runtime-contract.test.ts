import { expect, test } from "bun:test";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import { validateClassHolderRuntime } from "../src/takoform/worker-runtime-contract.ts";

test("a generic keyed exclusive constraint does not activate the worker class-holder ABI", async () => {
  const form: InstalledTakoformForm = {
    identity: {
      formRef: {
        apiVersion: "example.forms.invalid",
        kind: "ExclusiveLease",
        definitionVersion: "1.0.0",
        schemaDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    constraints: [{ kind: "exclusive", reference: "/owner", keyedBy: "/key" }],
    desiredSchema: {
      type: "object",
      properties: {
        owner: {
          type: "object",
          properties: {
            apiVersion: { const: "example.forms.invalid" },
            kind: { const: "Owner" },
            name: { type: "string" },
          },
          "x-takoform-target-formrefs": [
            {
              apiVersion: "example.forms.invalid",
              kind: "Owner",
              definitionVersion: "1.0.0",
              schemaDigest: `sha256:${"e".repeat(64)}`,
            },
          ],
        },
        key: { type: "string" },
      },
      required: ["owner", "key"],
    },
    operations: ["create", "read", "delete"],
  };
  expect(() => validateClassHolderRuntime(form)).not.toThrow();
});

test("a class holder with no deployment is refused by the apply guard", () => {
  const form: InstalledTakoformForm = {
    identity: {
      formRef: {
        apiVersion: "edge.forms.takoform.com",
        kind: "ActorNamespace",
        definitionVersion: "0.1.0",
        schemaDigest: `sha256:${"a".repeat(64)}`,
      },
    },
    role: "identity",
    providedInterfaces: [
      {
        apiVersion: "interfaces.takoform.com/v1alpha1",
        name: "worker.actor",
        version: "1.0.0",
        schemaDigest: `sha256:${"b".repeat(64)}`,
      },
    ],
    workerClassRuntime: {
      providedInterface: "worker.actor",
      className: "/className",
      workerRelation: "/worker",
      deploymentForm: {
        apiVersion: "edge.forms.takoform.com",
        kind: "WorkerDeployment",
      },
      deploymentWorkerRelation: "/worker",
      deploymentVersionRelation: "/versions/*/workerVersion",
      versionBundleRelation: "/bundle",
    },
    desiredSchema: {
      type: "object",
      properties: {
        className: { type: "string" },
        worker: { type: "object" },
      },
      required: ["className", "worker"],
    },
    operations: ["create", "read", "delete"],
  };

  expect(() => validateClassHolderRuntime(form)).toThrow(
    expect.objectContaining({ code: "unsupported_capability", status: 422 }),
  );
});
