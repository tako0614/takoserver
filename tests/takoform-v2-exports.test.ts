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
  StaticAssetBundleCustody,
  V2ActorNamespacePhysicalPort,
  V2Backend,
  V2BackendResult,
  V2Execution,
  V2Form,
  V2HeldArtifactSourceOptions,
  V2QueueConsumerCapability,
  V2ReferenceRequirement,
  V2WorkerModuleInspector,
  V2WorkerPublicationResolution,
  V2WorkerPublicationSnapshot,
  V2WorkerVersionMaterials,
  V2WorkflowClassAdmission,
  WorkerBundleCustody,
} from "@takoserver/core/takoform-v2";
import * as extension from "@takoserver/core/takoform-v2";
import type { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { createV2ActorBindingAuthority } from "../src/takoform-v2/actor-binding-authority.ts";
import {
  createV2ActorNamespaceForm,
  createV2ActorNamespaceFormFrontFace,
  V2_ACTOR_NAMESPACE_BACKEND_ID,
} from "../src/takoform-v2/actor-namespace-backend.ts";
import { createV2ActorNamespaceSqlGraphReader } from "../src/takoform-v2/actor-namespace-sql-graph.ts";
import { parseTakoformV2PublicConfig } from "../src/takoform-v2/config.ts";
import { createV2EdgeKvNativeCustody } from "../src/takoform-v2/edge-kv-native-custody.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/actor-namespace.ts";
import { createV2HeldArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/takoform-v2/forms/durable-workflow.ts";
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
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
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
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleCustody } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import {
  createWorkerBundleCustody,
  createWorkerBundleHost,
} from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import { referencesForWorkerForm } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createInternalV2ModuleWorkerForm } from "../src/takoform-v2/module-worker-lifecycle-backend.ts";
import { TakoformV2Error } from "../src/takoform-v2/types.ts";
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
import {
  createQueueConsumerForm,
  V2_QUEUE_CONSUMER_BACKEND_ID,
} from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import { createV2WorkerVersionConfiguredInputSealer } from "../src/takoform-v2/worker-version-configured-inputs.ts";
import {
  createDurableWorkflowForm,
  createV2DurableWorkflowFormFrontFace,
  DURABLE_WORKFLOW_BACKEND_ID,
} from "../src/takoform-v2/workflow-backend.ts";
import { createV2WorkflowBindingAuthority } from "../src/takoform-v2/workflow-binding-authority.ts";
import { createV2WorkflowClassAdmission } from "../src/takoform-v2/workflow-class-admission.ts";
import { createV2WorkflowSelectedMaterials } from "../src/takoform-v2/workflow-selected-materials.ts";

const RUNTIME_EXPORTS = [
  "ACTOR_NAMESPACE_FORM_URL",
  "EDGE_KV_NAMESPACE_BACKEND_ID",
  "EDGE_KV_NAMESPACE_FORM_URL",
  "EDGE_KV_NAMESPACE_LIMITS",
  "DURABLE_WORKFLOW_BACKEND_ID",
  "DURABLE_WORKFLOW_FORM_URL",
  "EdgeKVNamespaceValidationError",
  "MODULE_WORKER_FORM_URL",
  "OBJECT_BUCKET_FORM_URL",
  "OBJECT_BUCKET_LIMITS",
  "OBJECT_BUCKET_BACKEND_ID",
  "QUEUE_CONSUMER_FORM_URL",
  "ObjectBucketValidationError",
  "WORKER_CRON_TRIGGER_FORM_URL",
  "WORKER_DEPLOYMENT_FORM_URL",
  "WORKER_ENDPOINT_FORM_URL",
  "WORKER_VERSION_FORM_URL",
  "AT_LEAST_ONCE_QUEUE_FORM_URL",
  "WorkerFormValidationError",
  "createEdgeKVNamespaceForm",
  "createDurableWorkflowForm",
  "createV2DurableWorkflowFormFrontFace",
  "createInternalV2ModuleWorkerForm",
  "createObjectBucketForm",
  "createObjectBucketWorkerBindingAuthority",
  "createV2EdgeKvNativeCustody",
  "createV2ActorNamespaceSqlGraphReader",
  "createV2ActorNamespaceForm",
  "createV2ActorNamespaceFormFrontFace",
  "createV2ActorBindingAuthority",
  "createV2WorkflowBindingAuthority",
  "createV2WorkflowClassAdmission",
  "createAtLeastOnceQueueForm",
  "createQueueWorkerBindingAuthority",
  "createQueueConsumerForm",
  "createSQLiteDatabaseForm",
  "createSQLiteMigrationApplicationForm",
  "createSQLiteWorkerBindingAuthority",
  "createStaticAssetBundleCustody",
  "createWorkerBundleCustody",
  "createWorkerBundleHost",
  "createWorkerCronTriggerAdmissionReader",
  "createWorkerCronTriggerForm",
  "createV2HeldArtifactSource",
  "createV2NativeEffectCustody",
  "createV2NativeDeletionCustody",
  "createV2ServiceBindingAuthority",
  "createV2WorkerInvocationLifecycle",
  "createV2WorkerPublicationState",
  "createV2WorkerVersionConfiguredInputSealer",
  "createV2WorkflowSelectedMaterials",
  "exactV2ResolvedServiceBindings",
  "inspectV2WorkerCodeVersionEligibility",
  "inspectV2WorkerInvocationDrainSchema",
  "inspectV2WorkerInvocationSchema",
  "parseEdgeKVNamespaceSpec",
  "parseModuleWorkerSpec",
  "parseObjectBucketSpec",
  "parseSQLiteDatabaseSpec",
  "parseTakoformV2PublicConfig",
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
  "STATIC_ASSET_BUNDLE_FORM_URL",
  "TakoformV2Error",
  "v2WorkerInvocationSchemaReady",
  "V2_QUEUE_BACKEND_ID",
  "V2_ACTOR_NAMESPACE_BACKEND_ID",
  "V2_QUEUE_CONSUMER_BACKEND_ID",
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
  expect(extension.createV2WorkflowSelectedMaterials).toBe(createV2WorkflowSelectedMaterials);
  expect(extension.createWorkerBundleCustody).toBe(createWorkerBundleCustody);
  expect(extension.createStaticAssetBundleCustody).toBe(createStaticAssetBundleCustody);
  expect(extension.STATIC_ASSET_BUNDLE_FORM_URL).toBe(STATIC_ASSET_BUNDLE_FORM_URL);
  expect(extension.parseTakoformV2PublicConfig).toBe(parseTakoformV2PublicConfig);
  const publicConfigInput = {
    documentation: "https://docs.example.invalid/takoform-v2",
    authenticationDocumentation: "https://docs.example.invalid/authentication",
    staticAssetBundle: {
      targetKey: "assets-target",
      heldArtifacts: [
        {
          url: "https://artifacts.example.invalid/asset-manifest",
          sha256: "a".repeat(64),
          objectKey: "held/asset-manifest",
          grants: [{ principal: "org:asset-owner", space: "production" }],
        },
      ],
    },
  };
  const parsedConfig: ReturnType<typeof parseTakoformV2PublicConfig> =
    extension.parseTakoformV2PublicConfig(JSON.stringify(publicConfigInput));
  expect(parsedConfig.staticAssetBundle).toEqual(publicConfigInput.staticAssetBundle);
  expect(parsedConfig).not.toHaveProperty("cursorSigningKey");
  expect(() =>
    extension.parseTakoformV2PublicConfig(
      JSON.stringify({
        ...publicConfigInput,
        staticAssetBundle: {
          ...publicConfigInput.staticAssetBundle,
          heldArtifacts: [
            {
              ...publicConfigInput.staticAssetBundle.heldArtifacts[0],
              grants: [{ principal: "", space: "production" }],
            },
          ],
        },
      }),
    ),
  ).toThrow("invalid_configuration");
  expect(extension.createWorkerBundleHost).toBe(createWorkerBundleHost);
  expect(extension.createV2HeldArtifactSource).toBe(createV2HeldArtifactSource);
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
  expect(extension.createQueueConsumerForm).toBe(createQueueConsumerForm);
  expect(extension.V2_QUEUE_CONSUMER_BACKEND_ID).toBe(V2_QUEUE_CONSUMER_BACKEND_ID);
  expect(extension.QUEUE_CONSUMER_FORM_URL).toBe(QUEUE_CONSUMER_FORM_URL);
  expect(extension.createAtLeastOnceQueueForm).toBe(createAtLeastOnceQueueForm);
  expect(extension.V2_QUEUE_BACKEND_ID).toBe(V2_QUEUE_BACKEND_ID);
  expect(extension.AT_LEAST_ONCE_QUEUE_FORM_URL).toBe(AT_LEAST_ONCE_QUEUE_FORM_URL);
  expect(extension.createV2EdgeKvNativeCustody).toBe(createV2EdgeKvNativeCustody);
  expect(extension.createV2ActorNamespaceSqlGraphReader).toBe(createV2ActorNamespaceSqlGraphReader);
  expect(extension.createV2ActorNamespaceForm).toBe(createV2ActorNamespaceForm);
  expect(extension.createV2ActorNamespaceFormFrontFace).toBe(createV2ActorNamespaceFormFrontFace);
  expect(extension.ACTOR_NAMESPACE_FORM_URL).toBe(ACTOR_NAMESPACE_FORM_URL);
  expect(extension.V2_ACTOR_NAMESPACE_BACKEND_ID).toBe(V2_ACTOR_NAMESPACE_BACKEND_ID);
  expect(extension.createV2ActorBindingAuthority).toBe(createV2ActorBindingAuthority);
  expect(extension.createV2WorkflowBindingAuthority).toBe(createV2WorkflowBindingAuthority);
  expect(extension.createDurableWorkflowForm).toBe(createDurableWorkflowForm);
  expect(extension.createV2DurableWorkflowFormFrontFace).toBe(createV2DurableWorkflowFormFrontFace);
  expect(extension.DURABLE_WORKFLOW_BACKEND_ID).toBe(DURABLE_WORKFLOW_BACKEND_ID);
  expect(extension.DURABLE_WORKFLOW_FORM_URL).toBe(DURABLE_WORKFLOW_FORM_URL);
  expect(extension.TakoformV2Error).toBe(TakoformV2Error);
  expect(new extension.TakoformV2Error("resource_busy", 409)).toMatchObject({
    code: "resource_busy",
    status: 409,
  });
  expect(extension.createV2WorkflowClassAdmission).toBe(createV2WorkflowClassAdmission);
  const workflowFormFactory: (options: Parameters<typeof createDurableWorkflowForm>[0]) => V2Form =
    extension.createDurableWorkflowForm;
  const workflowAdmissionFactory: (
    options: Parameters<typeof createV2WorkflowClassAdmission>[0],
  ) => V2WorkflowClassAdmission = extension.createV2WorkflowClassAdmission;
  expect(typeof workflowFormFactory).toBe("function");
  expect(typeof workflowAdmissionFactory).toBe("function");
  const acceptsPhysicalPort = (_physical: V2ActorNamespacePhysicalPort): void => {};
  const existingSelfhostPort = (
    physical: ReturnType<typeof createSelfhostActorExecutionHost>,
  ): void => acceptsPhysicalPort(physical);
  expect(typeof existingSelfhostPort).toBe("function");
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
  const staticAssetCustodyType = (_custody: StaticAssetBundleCustody): void => {};
  const staticAssetCustodyFactory: (
    options: Parameters<typeof createStaticAssetBundleCustody>[0],
  ) => StaticAssetBundleCustody = extension.createStaticAssetBundleCustody;
  const heldArtifactSourceOptionsType = (_options: V2HeldArtifactSourceOptions): void => {};
  const queueConsumerCapabilityType = (_capability: V2QueueConsumerCapability): void => {};
  expect(unresolved.kind).toBe("unresolved");
  expect([
    snapshotType,
    materialsType,
    sqlType,
    inspectorType,
    sqlitePort,
    sqliteClaimType,
    workerBundleCustodyType,
    staticAssetCustodyType,
    staticAssetCustodyFactory,
    heldArtifactSourceOptionsType,
    queueConsumerCapabilityType,
  ]).toHaveLength(11);

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
