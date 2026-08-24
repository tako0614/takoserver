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
  await expect(
    validateClassHolderRuntime({
      tenantId: "tenant-a",
      space: "main",
      form,
      spec: {
        owner: { apiVersion: "example.forms.invalid", kind: "Owner", name: "one" },
        key: "A",
      },
      relations: [
        {
          pointer: "/owner",
          relation: "/owner",
          targetApiVersion: "example.forms.invalid",
          targetKind: "Owner",
          targetName: "one",
          targetUid: "uid_owner",
          targetFormRef: {
            apiVersion: "example.forms.invalid",
            kind: "Owner",
            definitionVersion: "1.0.0",
            schemaDigest: `sha256:${"e".repeat(64)}`,
          },
        },
      ],
      store: {
        readResource: async () => {
          throw new Error("generic exclusivity reached worker ABI resource lookup");
        },
        readRelations: async () => {
          throw new Error("generic exclusivity reached worker ABI relation lookup");
        },
        resourcesByRelation: async () => {
          throw new Error("generic exclusivity reached WorkerDeployment lookup");
        },
      },
      artifacts: {
        resolveManifest: async () => null,
        resolveBlob: async () => null,
      },
    }),
  ).resolves.toBeUndefined();
});
