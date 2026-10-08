import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type {
  JsonObject,
  ObjectBucketIdentity,
  ObjectBucketStore,
  ObjectBucketWorkerBindingClaim,
  ObjectBucketWorkerBindingResolution,
  QueueWorkerBindingClaim,
  QueueWorkerBindingResolution,
  SQLiteDatabaseNativePort,
  SQLiteWorkerBindingClaim,
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
  WorkerBundleCustody,
} from "@takoserver/core/takoform-v2";
import * as extension from "@takoserver/core/takoform-v2";
import { createV2EdgeKvNativeCustody } from "../src/takoform-v2/edge-kv-native-custody.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import {
  OBJECT_BUCKET_FORM_URL,
  OBJECT_BUCKET_LIMITS,
  ObjectBucketValidationError,
  parseObjectBucketSpec,
  validateObjectBucketUpdate,
} from "../src/takoform-v2/forms/object-bucket.ts";
import {
  createObjectBucketForm,
  OBJECT_BUCKET_BACKEND_ID,
} from "../src/takoform-v2/forms/object-bucket-backend.ts";
import { createObjectBucketWorkerBindingAuthority } from "../src/takoform-v2/forms/object-bucket-worker-binding-authority.ts";
import { createQueueWorkerBindingAuthority } from "../src/takoform-v2/forms/queue-worker-binding-authority.ts";
import {
  parseSQLiteDatabaseSpec,
  SQLITE_DATABASE_FORM_URL,
  validateSQLiteDatabaseUpdate,
} from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import {
  createSQLiteMigrationApplicationForm,
  SQLITE_MIGRATION_APPLICATION_BACKEND_ID,
} from "../src/takoform-v2/forms/sqlite-migration-application-backend.ts";
import { createSQLiteWorkerBindingAuthority } from "../src/takoform-v2/forms/sqlite-worker-binding-authority.ts";
import { createWorkerBundleCustody } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import { referencesForWorkerForm } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createInternalV2ModuleWorkerForm } from "../src/takoform-v2/module-worker-lifecycle-backend.ts";
import { inspectV2WorkerCodeVersionEligibility as portableEligibility } from "../src/takoform-v2/worker-code-eligibility.ts";
import { inspectV2WorkerCodeVersionEligibility } from "../src/takoform-v2/worker-code-runtime.ts";
import { runWorkerCronTriggerTick } from "../src/takoform-v2/worker-cron-trigger-scheduler.ts";
import { createV2NativeDeletionCustody } from "../src/takoform-v2/worker-native-deletions.ts";
import { createV2NativeEffectCustody } from "../src/takoform-v2/worker-native-effects.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import {
  createAtLeastOnceQueueForm,
  V2_QUEUE_BACKEND_ID,
} from "../src/takoform-v2/worker-queue-backend.ts";
import { createV2WorkerVersionConfiguredInputSealer } from "../src/takoform-v2/worker-version-configured-inputs.ts";

const RUNTIME_EXPORTS = [
  "EDGE_KV_NAMESPACE_BACKEND_ID",
  "EDGE_KV_NAMESPACE_FORM_URL",
  "EDGE_KV_NAMESPACE_LIMITS",
  "EdgeKVNamespaceValidationError",
  "MODULE_WORKER_FORM_URL",
  "OBJECT_BUCKET_FORM_URL",
  "OBJECT_BUCKET_LIMITS",
  "OBJECT_BUCKET_BACKEND_ID",
  "ObjectBucketValidationError",
  "WORKER_DEPLOYMENT_FORM_URL",
  "WORKER_ENDPOINT_FORM_URL",
  "WORKER_VERSION_FORM_URL",
  "AT_LEAST_ONCE_QUEUE_FORM_URL",
  "WorkerFormValidationError",
  "createEdgeKVNamespaceForm",
  "createInternalV2ModuleWorkerForm",
  "createObjectBucketForm",
  "createObjectBucketWorkerBindingAuthority",
  "createV2EdgeKvNativeCustody",
  "createAtLeastOnceQueueForm",
  "createQueueWorkerBindingAuthority",
  "createSQLiteDatabaseForm",
  "createSQLiteMigrationApplicationForm",
  "createSQLiteWorkerBindingAuthority",
  "createWorkerBundleCustody",
  "createV2NativeEffectCustody",
  "createV2NativeDeletionCustody",
  "createV2ServiceBindingAuthority",
  "createV2WorkerInvocationLifecycle",
  "createV2WorkerPublicationState",
  "createV2WorkerVersionConfiguredInputSealer",
  "exactV2ResolvedServiceBindings",
  "inspectV2WorkerCodeVersionEligibility",
  "inspectV2WorkerInvocationSchema",
  "parseEdgeKVNamespaceSpec",
  "parseModuleWorkerSpec",
  "parseObjectBucketSpec",
  "parseSQLiteDatabaseSpec",
  "parseWorkerDeploymentSpec",
  "parseWorkerEndpointSpec",
  "parseWorkerVersionSpec",
  "projectV2ResolvedServiceBindings",
  "readV2ConfiguredPrivateInputs",
  "referencesForModuleWorker",
  "referencesForWorkerDeployment",
  "referencesForWorkerEndpoint",
  "referencesForWorkerForm",
  "referencesForWorkerVersion",
  "runWorkerCronTriggerTick",
  "SQLITE_DATABASE_FORM_URL",
  "SQLITE_MIGRATION_APPLICATION_BACKEND_ID",
  "v2WorkerInvocationSchemaReady",
  "V2_QUEUE_BACKEND_ID",
  "validateEdgeKVNamespaceUpdate",
  "validateModuleWorkerUpdate",
  "validateObjectBucketUpdate",
  "validateSQLiteDatabaseUpdate",
  "validateWorkerDeploymentUpdate",
  "validateWorkerEndpointUpdate",
  "validateWorkerVersionUpdate",
] as const;

test("the v2 package subpath is the existing SQL and Worker Form authority, not a second registry", async () => {
  expect(Object.keys(extension).sort()).toEqual([...RUNTIME_EXPORTS].sort());
  expect(extension.createV2WorkerPublicationState).toBe(createV2WorkerPublicationState);
  expect(extension.createWorkerBundleCustody).toBe(createWorkerBundleCustody);
  expect(extension.createObjectBucketForm).toBe(createObjectBucketForm);
  expect(extension.createObjectBucketWorkerBindingAuthority).toBe(
    createObjectBucketWorkerBindingAuthority,
  );
  expect(extension.OBJECT_BUCKET_FORM_URL).toBe(OBJECT_BUCKET_FORM_URL);
  expect(extension.OBJECT_BUCKET_LIMITS).toBe(OBJECT_BUCKET_LIMITS);
  expect(extension.OBJECT_BUCKET_BACKEND_ID).toBe(OBJECT_BUCKET_BACKEND_ID);
  expect(extension.ObjectBucketValidationError).toBe(ObjectBucketValidationError);
  expect(extension.parseObjectBucketSpec).toBe(parseObjectBucketSpec);
  expect(extension.validateObjectBucketUpdate).toBe(validateObjectBucketUpdate);
  expect(extension.createSQLiteDatabaseForm).toBe(createSQLiteDatabaseForm);
  expect(extension.createSQLiteMigrationApplicationForm).toBe(createSQLiteMigrationApplicationForm);
  expect(extension.SQLITE_MIGRATION_APPLICATION_BACKEND_ID).toBe(
    SQLITE_MIGRATION_APPLICATION_BACKEND_ID,
  );
  expect(extension.createSQLiteWorkerBindingAuthority).toBe(createSQLiteWorkerBindingAuthority);
  expect(extension.SQLITE_DATABASE_FORM_URL).toBe(SQLITE_DATABASE_FORM_URL);
  expect(extension.parseSQLiteDatabaseSpec).toBe(parseSQLiteDatabaseSpec);
  expect(extension.validateSQLiteDatabaseUpdate).toBe(validateSQLiteDatabaseUpdate);
  expect(extension.runWorkerCronTriggerTick).toBe(runWorkerCronTriggerTick);
  expect(extension.createQueueWorkerBindingAuthority).toBe(createQueueWorkerBindingAuthority);
  expect(extension.createAtLeastOnceQueueForm).toBe(createAtLeastOnceQueueForm);
  expect(extension.V2_QUEUE_BACKEND_ID).toBe(V2_QUEUE_BACKEND_ID);
  expect(extension.AT_LEAST_ONCE_QUEUE_FORM_URL).toBe(AT_LEAST_ONCE_QUEUE_FORM_URL);
  expect(extension.createV2EdgeKvNativeCustody).toBe(createV2EdgeKvNativeCustody);
  expect(extension.createInternalV2ModuleWorkerForm).toBe(createInternalV2ModuleWorkerForm);
  expect(extension.createV2WorkerVersionConfiguredInputSealer).toBe(
    createV2WorkerVersionConfiguredInputSealer,
  );
  expect(extension.inspectV2WorkerCodeVersionEligibility).toBe(
    inspectV2WorkerCodeVersionEligibility,
  );
  expect(inspectV2WorkerCodeVersionEligibility).toBe(portableEligibility);
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
  const sqlitePort: SQLiteDatabaseNativePort = {
    targetKey: "sqlite-target",
    ensureCreated: async () => "present",
    inspect: async () => "present",
    ensureDeleted: async () => "absent",
  };
  const sqliteClaimType = (_claim: SQLiteWorkerBindingClaim): void => {};
  const workerBundleCustodyType = (_custody: WorkerBundleCustody): void => {};
  expect(unresolved.kind).toBe("unresolved");
  expect([
    snapshotType,
    materialsType,
    sqlType,
    inspectorType,
    sqlitePort,
    sqliteClaimType,
    workerBundleCustodyType,
  ]).toHaveLength(7);

  const claim: QueueWorkerBindingClaim = {
    principal: "principal",
    space: "space",
    targetKey: "target",
    workerUid: "worker",
    workerVersionUid: "version",
    workerVersionOperationId: "operation",
    nativeVersionId: "v2-logical-public-identity",
    incarnationId: "incarnation",
    servingSourceOperationId: "serving-operation",
    bindings: [],
  };
  const resolution: QueueWorkerBindingResolution = {
    identity: { principal: "principal", space: "space", targetKey: "target", resourceUid: "queue" },
    target: {
      queueId: "takoform-v2-queue:queue",
      messageRetentionSeconds: 60,
      deliveryDelaySeconds: 0,
    },
    vector: "vector",
  };
  const sql: Sql = {
    query: async () => [],
    run: async () => ({ rows: [], changes: 0 }),
    batch: async () => [],
  };
  const authority = extension.createQueueWorkerBindingAuthority({ sql, targetKey: "target" });
  expect(await authority.resolveCurrentBinding(claim, "QUEUE")).toBeNull();
  const queue = extension.createAtLeastOnceQueueForm({
    sql,
    targetKey: resolution.identity.targetKey,
  });
  expect(queue.backend.id).toBe(V2_QUEUE_BACKEND_ID);
  expect(queue.backend.targetKey).toBe("target");
  queue.validateCreate({ messageRetentionSeconds: resolution.target.messageRetentionSeconds });

  const bucketIdentity: ObjectBucketIdentity = {
    principal: "principal",
    space: "space",
    targetKey: "target",
    resourceUid: "bucket",
  };
  const bucketStore: ObjectBucketStore = {
    create: async () => "ready",
    reconcileCreate: async () => "ready",
    observe: async () => "ready",
    delete: async () => "deleted",
  };
  const bucketClaim: ObjectBucketWorkerBindingClaim = { ...claim, bindings: [] };
  const bucketResolution: ObjectBucketWorkerBindingResolution = {
    identity: bucketIdentity,
    vector: "vector",
  };
  const bucket = extension.createObjectBucketForm({
    store: bucketStore,
    targetKey: bucketResolution.identity.targetKey,
    backendId: "operator-r2-prefix-v1",
  });
  expect(bucket.backend.id).toBe("operator-r2-prefix-v1");
  expect(bucket.backend.targetKey).toBe("target");
  bucket.validateCreate({});
  expect(
    await extension
      .createObjectBucketWorkerBindingAuthority({
        sql,
        targetKey: "target",
        backendId: "operator-r2-prefix-v1",
      })
      .resolveCurrentBucketBinding(bucketClaim, "BUCKET"),
  ).toBeNull();
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
  expect(source).not.toMatch(
    /\bBun\b|(?<![\w.])process\s*(?:\?\.|\.|\?\[|\[)|typeof\s+(?:globalThis\.)?process\b|\b(?:globalThis|self|window)\.process\b|\bnode:/u,
  );
});
