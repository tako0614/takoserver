import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type {
  JsonObject,
  Sql,
  V2Backend,
  V2BackendResult,
  V2Execution,
  V2Form,
  V2ReferenceRequirement,
  V2WorkerModuleInspector,
  V2WorkerPublicationResolution,
  V2WorkerPublicationSnapshot,
  V2WorkerVersionMaterials,
} from "@takoserver/core/takoform-v2";
import * as extension from "@takoserver/core/takoform-v2";
import { referencesForWorkerForm } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { inspectV2WorkerCodeVersionEligibility } from "../src/takoform-v2/worker-code-runtime.ts";
import { createV2NativeDeletionCustody } from "../src/takoform-v2/worker-native-deletions.ts";
import { createV2NativeEffectCustody } from "../src/takoform-v2/worker-native-effects.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const RUNTIME_EXPORTS = [
  "MODULE_WORKER_FORM_URL",
  "WORKER_DEPLOYMENT_FORM_URL",
  "WORKER_ENDPOINT_FORM_URL",
  "WORKER_VERSION_FORM_URL",
  "WorkerFormValidationError",
  "createV2NativeEffectCustody",
  "createV2NativeDeletionCustody",
  "createV2WorkerInvocationLifecycle",
  "createV2WorkerPublicationState",
  "inspectV2WorkerCodeVersionEligibility",
  "parseModuleWorkerSpec",
  "parseWorkerDeploymentSpec",
  "parseWorkerEndpointSpec",
  "parseWorkerVersionSpec",
  "referencesForModuleWorker",
  "referencesForWorkerDeployment",
  "referencesForWorkerEndpoint",
  "referencesForWorkerForm",
  "referencesForWorkerVersion",
  "validateModuleWorkerUpdate",
  "validateWorkerDeploymentUpdate",
  "validateWorkerEndpointUpdate",
  "validateWorkerVersionUpdate",
] as const;

test("the v2 package subpath is the existing SQL and Worker Form authority, not a second registry", () => {
  expect(Object.keys(extension).sort()).toEqual([...RUNTIME_EXPORTS].sort());
  expect(extension.createV2WorkerPublicationState).toBe(createV2WorkerPublicationState);
  expect(extension.inspectV2WorkerCodeVersionEligibility).toBe(
    inspectV2WorkerCodeVersionEligibility,
  );
  expect(extension.createV2NativeEffectCustody).toBe(createV2NativeEffectCustody);
  expect(extension.createV2NativeDeletionCustody).toBe(createV2NativeDeletionCustody);
  expect(extension.parseModuleWorkerSpec).toBe(parseModuleWorkerSpec);
  expect(extension.referencesForWorkerForm).toBe(referencesForWorkerForm);
  expect(extension.MODULE_WORKER_FORM_URL).toBe(MODULE_WORKER_FORM_URL);
  expect(extension.referencesForWorkerForm(MODULE_WORKER_FORM_URL, {})).toEqual([]);

  const result: V2BackendResult = { kind: "unknown" };
  const backend: V2Backend = {
    id: "private-wfp",
    targetKey: "one-target",
    execute: async (_input: V2Execution) => result,
    reconcile: async (_input: V2Execution) => result,
  };
  const form: V2Form = {
    backend,
    validateCreate: (_spec: JsonObject) => {},
    validateUpdate: (_previousSpec: JsonObject, _spec: JsonObject) => {},
    references: (_spec: JsonObject): readonly V2ReferenceRequirement[] => [],
  };
  expect(form.backend).toBe(backend);

  // These compile-time assignments verify the resolver's complete public
  // result vocabulary without manufacturing SQL rows or a settled lease.
  const unresolved: V2WorkerPublicationResolution = {
    kind: "unresolved",
    code: "graph_unresolved",
    message: "not ready",
  };
  const snapshotType = (_snapshot: V2WorkerPublicationSnapshot): void => {};
  const materialsType = (_materials: V2WorkerVersionMaterials): void => {};
  const sqlType = (_sql: Sql): void => {};
  const inspectorType = (_inspector: V2WorkerModuleInspector): void => {};
  expect(unresolved.kind).toBe("unresolved");
  expect([snapshotType, materialsType, sqlType, inspectorType]).toHaveLength(4);
});

test("v2 extension entrypoint bundles for a Worker without Node or workerd runtime", async () => {
  const entrypoint = fileURLToPath(import.meta.resolve("@takoserver/core/takoform-v2"));
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    plugins: [
      {
        name: "reject-host-only-imports",
        setup(build) {
          build.onResolve({ filter: /^(?:bun|node):|workerd-runtime/u }, (args) => {
            throw new Error(`v2 extension reaches Host-only import: ${args.path}`);
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  expect(result.outputs).toHaveLength(1);
  const artifact = result.outputs[0];
  if (!artifact) throw new Error("missing v2 extension artifact");
  const source = await artifact.text();
  expect(new Bun.Transpiler({ loader: "js" }).scanImports(source)).toEqual([]);
  expect(source).not.toMatch(/\b(?:Bun|process)\b|\bnode:/u);
});
