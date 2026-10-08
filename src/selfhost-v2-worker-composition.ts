import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import type { Clock, ObjectStoreAccess, Sql } from "./ports.ts";
import { createSelfhostV2KvBindingBroker } from "./providers/selfhost-v2-kv-binding-broker.ts";
import type { SelfhostV2KvStore } from "./providers/selfhost-v2-kv-store.ts";
import { createSelfhostV2ObjectBucketBindingBroker } from "./providers/selfhost-v2-object-bucket-binding-broker.ts";
import type { SelfhostV2ObjectBucketStore } from "./providers/selfhost-v2-object-bucket-store.ts";
import {
  createSelfhostV2QueueProducerBroker,
  type SelfhostV2QueueProducerBrokerOptions,
} from "./providers/selfhost-v2-queue-producer-broker.ts";
import {
  createSelfhostV2SqliteBindingBroker,
  type V2SqliteBindingGrant,
} from "./providers/selfhost-v2-sqlite-binding-broker.ts";
import type { SelfhostV2SQLiteStore } from "./providers/selfhost-v2-sqlite-store.ts";
import {
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
  SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH,
} from "./providers/selfhost-worker-wrapper.ts";
import { createSelfhostV2QueueWorkerCapability } from "./selfhost-v2-queue-worker-capability.ts";
import { createSelfhostV2ScheduledComposition } from "./selfhost-v2-scheduled-composition.ts";
import type { V2OperatorFormFactory } from "./takoform-v2/application.ts";
import type { V2ApplicationConfig } from "./takoform-v2/config.ts";
import { readV2ConfiguredPrivateInputs } from "./takoform-v2/configured-private-inputs.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "./takoform-v2/forms/actor-namespace.ts";
import { createV2HeldArtifactSource } from "./takoform-v2/forms/artifact-source.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "./takoform-v2/forms/at-least-once-queue.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "./takoform-v2/forms/durable-workflow.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "./takoform-v2/forms/edge-kv-namespace.ts";
import { createEdgeKVNamespaceForm } from "./takoform-v2/forms/edge-kv-namespace-backend.ts";
import { createKvWorkerBindingAuthority } from "./takoform-v2/forms/kv-worker-binding-authority.ts";
import { OBJECT_BUCKET_FORM_URL } from "./takoform-v2/forms/object-bucket.ts";
import { createObjectBucketForm } from "./takoform-v2/forms/object-bucket-backend.ts";
import { createObjectBucketWorkerBindingAuthority } from "./takoform-v2/forms/object-bucket-worker-binding-authority.ts";
import { QUEUE_CONSUMER_FORM_URL } from "./takoform-v2/forms/queue-consumer.ts";
import { createQueueWorkerBindingAuthority } from "./takoform-v2/forms/queue-worker-binding-authority.ts";
import { SQLITE_DATABASE_FORM_URL } from "./takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "./takoform-v2/forms/sqlite-database-backend.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "./takoform-v2/forms/sqlite-migration-application.ts";
import { createSQLiteMigrationApplicationForm } from "./takoform-v2/forms/sqlite-migration-application-backend.ts";
import { createSQLiteMigrationApplicationNativePort } from "./takoform-v2/forms/sqlite-migration-application-native.ts";
import { createSQLiteMigrationSetCustody } from "./takoform-v2/forms/sqlite-migration-set-backend.ts";
import { createSQLiteWorkerBindingAuthority } from "./takoform-v2/forms/sqlite-worker-binding-authority.ts";
import { createStaticAssetBundleCustody } from "./takoform-v2/forms/static-asset-bundle-backend.ts";
import { createWorkerBundleCustody } from "./takoform-v2/forms/worker-bundle-backend.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "./takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "./takoform-v2/forms/worker-specs.ts";
import type { createSelfhostV2WorkflowComposition } from "./takoform-v2/selfhost-v2-workflow-composition.ts";
import { createV2ServiceBindingAuthority } from "./takoform-v2/service-binding-authority.ts";
import {
  createWorkerCronTriggerAdmissionReader,
  createWorkerCronTriggerForm,
} from "./takoform-v2/worker-cron-trigger-backend.ts";
import type { WorkerCronTriggerTickResult } from "./takoform-v2/worker-cron-trigger-scheduler.ts";
import { createWorkerDeploymentForm } from "./takoform-v2/worker-deployment-backend.ts";
import { createWorkerEndpointForm } from "./takoform-v2/worker-endpoint-backend.ts";
import {
  createInternalV2ModuleWorkerForm,
  createInternalV2WorkerVersionForm,
  createV2CodeConfiguredInputReader,
  MODULE_WORKER_LIFECYCLE_BACKEND_ID,
} from "./takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "./takoform-v2/worker-publication-state.ts";
import { createAtLeastOnceQueueForm } from "./takoform-v2/worker-queue-backend.ts";
import {
  createQueueConsumerForm,
  type V2QueueConsumerCapability,
} from "./takoform-v2/worker-queue-consumer-backend.ts";
import { createV2WorkerdWorkerRuntimeReaders } from "./takoform-v2/worker-runtime-readers.ts";
import type { createV2WorkerVersionConfiguredInputSealer } from "./takoform-v2/worker-version-configured-inputs.ts";
import { spawnWorkerdWithParentDeath } from "./workerd-linux-process.ts";
import type { WorkerdProcess } from "./workerd-supervisor.ts";
import { createWorkerdWorkerModuleInspector } from "./workerd-worker-module-inspector.ts";
import {
  type OpenWorkerdWorkerRuntimeOwnerOptions,
  openWorkerdWorkerRuntimeOwner,
  type WorkerdWorkerRuntimeOwner,
} from "./workerd-worker-runtime-owner.ts";

type EndpointPorts = Pick<
  Parameters<typeof createWorkerEndpointForm>[0],
  "assignHostname" | "observeTls" | "observeRouteAbsent"
>;

type ActorOwnerForward = NonNullable<OpenWorkerdWorkerRuntimeOwnerOptions["v2ActorForward"]>;
type ActorOwnerSource = Parameters<ActorOwnerForward["openIncarnation"]>[0];
type ActorOwnerIncarnation = ReturnType<ActorOwnerForward["openIncarnation"]>;
type WorkflowOwnerForward = NonNullable<OpenWorkerdWorkerRuntimeOwnerOptions["v2WorkflowForward"]>;
type WorkflowRunOnce = ReturnType<typeof createSelfhostV2WorkflowComposition>["runtime"]["runOne"];
type WorkflowDuePoll = {
  readonly examined: number;
  readonly selected: number;
  readonly outcomes: readonly Awaited<ReturnType<WorkflowRunOnce>>[];
};

/** Trusted app-layer boot; portable Worker composition only attaches its explicit ports. */
export interface SelfhostV2ActorBootPort {
  prepare(input: {
    readonly sql: Sql;
    readonly targetKey: string;
    readonly bundleCustody: NonNullable<ReturnType<typeof createWorkerBundleCustody>>;
    readonly inspector: ReturnType<typeof createWorkerdWorkerModuleInspector>;
    readonly ownerForWorker: (uid: string) => Promise<WorkerdWorkerRuntimeOwner | null>;
    /** One global gate for all restored Actor brokers; false until every proof completes. */
    readonly actorInvocationReady: () => boolean;
  }): {
    readonly namespaceForm: ReturnType<V2OperatorFormFactory>[string];
    readonly bindingAuthority: NonNullable<
      Parameters<typeof createInternalV2WorkerVersionForm>[0]["v2ActorBinding"]
    >;
    readonly forwardBoot: {
      openIncarnation(
        identity: ActorOwnerSource & { readonly principal: string; readonly space: string },
      ): ActorOwnerIncarnation;
    };
  };
}

/** The Workflow Host and its forward broker share this composition's accepted SQL graph. */
export interface SelfhostV2WorkflowBootPort {
  prepare(input: {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly targetKey: string;
    readonly workerdBinary: string;
    readonly bundleCustody: NonNullable<ReturnType<typeof createWorkerBundleCustody>>;
    readonly assetCustody?: NonNullable<ReturnType<typeof createStaticAssetBundleCustody>>;
    readonly inspector: ReturnType<typeof createWorkerdWorkerModuleInspector>;
    readonly ownerForWorker: (uid: string) => Promise<WorkerdWorkerRuntimeOwner | null>;
  }): {
    readonly workflowForm: ReturnType<V2OperatorFormFactory>[string];
    readonly bindingAuthority: NonNullable<
      Parameters<typeof createInternalV2WorkerVersionForm>[0]["v2WorkflowBinding"]
    >;
    readonly forwardBoot: WorkflowOwnerForward;
    /** Bounded, exact-v2-target due poll; the runtime owns final execution authority. */
    pollWorkflowDue(): Promise<WorkflowDuePoll>;
    /** One trusted execution call; the runtime retains SQL/native claim authority. */
    readonly runWorkflowOnce: WorkflowRunOnce;
    /** Stop guarded Workflow children and release selected owner leases before owner suspension. */
    close(): Promise<void>;
  };
}

export interface SelfhostV2WorkerCompositionOptions {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly clock: Clock;
  readonly config: V2ApplicationConfig;
  /** Private 0700 root, separate from the legacy shared Workerd graph. */
  readonly rootDirectory: string;
  readonly targetKey: string;
  /** Already selected and pinned by the normal Bun entry. */
  readonly workerdBinary: string | null;
  /** Already-composed private v2 Actor authority, native Host and physical readback. */
  readonly v2Actor?: SelfhostV2ActorBootPort;
  /** Explicitly boot-composed guarded Workflow runtime and accepted Binding authority. */
  readonly v2Workflow?: SelfhostV2WorkflowBootPort;
  /** Explicitly boot-composed Host-private Queue settlement service. */
  readonly queueSettlement?: NonNullable<OpenWorkerdWorkerRuntimeOwnerOptions["v2QueueSettlement"]>;
  /** Already-created operator key authority; absent refuses sensitive Worker Versions. */
  readonly configuredInputSealer?: ReturnType<typeof createV2WorkerVersionConfiguredInputSealer>;
  /** Already-created Resource custody and pre-existing private signing authority. */
  readonly sqliteBinding?: {
    readonly store: SelfhostV2SQLiteStore;
    readonly signingKey: Uint8Array;
    /** Pre-existing operator-private real directory for SQL input staging. */
    readonly stagingRoot: string;
    /** Stable operator-selected loopback port, retained across Host restarts. */
    readonly privatePort: number;
  };
  /** Separately keyed Host-private Worker Binding broker; not public Form registration. */
  readonly v2ObjectBucketBinding?: {
    readonly store: SelfhostV2ObjectBucketStore;
    readonly signingKey: Uint8Array;
    /** Stable loopback port embedded in each exact Version graph. */
    readonly privatePort: number;
  };
  /** Separately keyed Host-private KV binding broker; not public Form registration. */
  readonly v2KvBinding?: {
    readonly store: SelfhostV2KvStore;
    readonly signingKey: Uint8Array;
    /** Stable loopback port embedded in each exact Version graph. */
    readonly privatePort: number;
  };
  /** A separately keyed Producer listener; it never shares settlement authority. */
  readonly v2QueueProducerBinding?: {
    readonly custody: SelfhostV2QueueProducerBrokerOptions["custody"];
    readonly signingKey: Uint8Array;
    readonly privatePort: number;
  };
  /** Exact frontend authority; absent on the ordinary public entry today. */
  readonly endpoint?: EndpointPorts;
  /** Tests may substitute a child, but production uses parent-death-fenced Workerd. */
  readonly spawn?: (command: readonly string[]) => WorkerdProcess;
  readonly listenerPortForOperation?: (operationId: string) => number | Promise<number>;
}

function ownerKey(uid: string): string {
  return createHash("sha256").update(uid, "utf8").digest("hex");
}

async function workerShutdownKind(
  sql: Sql,
  uid: string,
  targetKey: string,
): Promise<"live" | "deleted"> {
  const rows = await sql.query(
    `SELECT r.uid, r.principal, r.form_url, r.backend_id, r.target_key,
       r.generation, r.observed_generation, r.phase, r.spec_json, r.last_operation,
       r.busy_operation, r.deleted_at,
       op.id AS operation_id, op.resource_uid AS operation_resource_uid,
       op.principal AS operation_principal, op.backend_id AS operation_backend_id,
       op.target_key AS operation_target_key, op.generation AS operation_generation,
       op.action AS operation_action, op.status AS operation_status,
       op.effect AS operation_effect, op.accepted_spec_json
     FROM tf_v2_resources r LEFT JOIN tf_v2_operations op ON op.id = r.last_operation
     WHERE r.uid = ? LIMIT 2`,
    [uid],
  );
  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    row?.uid !== uid ||
    typeof row.principal !== "string" ||
    !row.principal ||
    row.form_url !== MODULE_WORKER_FORM_URL ||
    row.backend_id !== MODULE_WORKER_LIFECYCLE_BACKEND_ID ||
    row.target_key !== targetKey ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    row.observed_generation !== row.generation ||
    row.phase !== "idle" ||
    row.busy_operation !== null ||
    typeof row.last_operation !== "string" ||
    row.operation_id !== row.last_operation ||
    row.operation_resource_uid !== uid ||
    row.operation_principal !== row.principal ||
    row.operation_backend_id !== row.backend_id ||
    row.operation_target_key !== targetKey ||
    row.operation_generation !== row.generation ||
    row.operation_status !== "succeeded" ||
    row.operation_effect !== "complete" ||
    typeof row.spec_json !== "string" ||
    row.accepted_spec_json !== row.spec_json
  ) {
    throw new Error("v2 Worker SQL state is not settled for shutdown");
  }
  if (row.deleted_at !== null) {
    if (typeof row.deleted_at !== "string" || row.operation_action !== "delete") {
      throw new Error("v2 Worker deletion is not confirmed by its current Operation");
    }
    return "deleted";
  }
  if (row.operation_action !== "create" && row.operation_action !== "update") {
    throw new Error("v2 Worker current Operation is not a live mutation");
  }
  return "live";
}

async function unusedPrivatePort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const port = Number(reservation.port);
    await reservation.stop(true);
    if (Number.isSafeInteger(port) && port > 0 && !excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error("v2 Worker private listener allocation unavailable");
}

/**
 * One Bun process owns one private owner lock per accepted Worker UID. This
 * composition shares the normal application's SQL and held object store; it
 * neither adds a Resource ledger nor registers incomplete Worker Forms itself.
 */
export function createSelfhostV2WorkerComposition(options: SelfhostV2WorkerCompositionOptions): {
  restoreOwners(): Promise<readonly string[]>;
  /** Trusted graph-reader port; never opens an unlisted owner during restoration. */
  actorOwnerForRecovery(uid: string): Promise<WorkerdWorkerRuntimeOwner | null>;
  ownerForWorkerUid(uid: string): Promise<WorkerdWorkerRuntimeOwner>;
  /** Read-only Endpoint routing view; does not register WorkerEndpoint in the normal Host. */
  readonly endpointPublicationState: Pick<
    ReturnType<typeof createV2WorkerPublicationState>,
    "resolve" | "resolveCurrentServing"
  >;
  /** Real SQL publication plus restored native Queue export proof, absent without Queue boot. */
  readonly queueCapability?: V2QueueConsumerCapability;
  /** One tracked durable Cron scan; unavailable before restoration or after close. */
  pollScheduledDue(): Promise<WorkerCronTriggerTickResult>;
  /** Freeze Cron delivery and join its current pass before stopping native owners. */
  closeScheduledHost(): Promise<void>;
  /** Host-private one-shot due scan, unavailable before restore or after shutdown. */
  pollWorkflowDue(): Promise<WorkflowDuePoll>;
  /** Host-private one-shot execution, unavailable before restore or after shutdown. */
  runWorkflowOnce: WorkflowRunOnce;
  /** Close guarded Workflow registrations before stopping selected Worker owners. */
  closeWorkflowHost(): Promise<void>;
  /** Stop exact known children but retain UID owner locks and durable accepted state. */
  suspendOwnersRetainingCustody(): Promise<void>;
  /** Close retired owners, then stop the private broker; active owners refuse. */
  closePrivateBindingServices(): Promise<void>;
  /** Internal acceptance seam only. The normal entry must not register it yet. */
  readonly internalFormFactory: V2OperatorFormFactory;
  /**
   * Bind the existing Form map to the Endpoint ports returned by this
   * composition's restored self-host Endpoint boot.
   */
  internalFormFactoryForEndpoint(endpoint: EndpointPorts): V2OperatorFormFactory;
  /** Complete secret-free public admission; runtime ciphertext recovery remains configured. */
  secretFreeFormFactory(endpoint?: EndpointPorts): V2OperatorFormFactory;
} {
  if (!options.targetKey || !options.rootDirectory || !options.sql || !options.objects) {
    throw new TypeError("v2 Worker composition requires SQL, objects, target and private root");
  }
  const { sql, objects, clock, config, targetKey } = options;
  const configuredEndpoint =
    options.endpoint === undefined ? undefined : Object.freeze({ ...options.endpoint });
  const queueSettlement = options.queueSettlement;
  if (
    queueSettlement &&
    (!/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(queueSettlement.address) ||
      Number(queueSettlement.address.slice(queueSettlement.address.lastIndexOf(":") + 1)) >
        65_535 ||
      typeof queueSettlement.queueIdForUid !== "function" ||
      typeof queueSettlement.bindingToken !== "function")
  ) {
    throw new TypeError("v2 Queue settlement requires an exact private boot binding");
  }
  if (
    options.sqliteBinding &&
    (options.sqliteBinding.store?.targetKey !== targetKey ||
      typeof options.sqliteBinding.store.withAuthorizedDatabase !== "function" ||
      !(options.sqliteBinding.signingKey instanceof Uint8Array) ||
      options.sqliteBinding.signingKey.byteLength < 32 ||
      !Number.isSafeInteger(options.sqliteBinding.privatePort) ||
      options.sqliteBinding.privatePort < 1 ||
      options.sqliteBinding.privatePort > 65_535)
  ) {
    throw new TypeError("v2 SQLite binding requires exact store, private key and fixed port");
  }
  if (
    options.v2ObjectBucketBinding &&
    (!options.v2ObjectBucketBinding.store ||
      typeof options.v2ObjectBucketBinding.store.openBucket !== "function" ||
      typeof options.v2ObjectBucketBinding.store.create !== "function" ||
      typeof options.v2ObjectBucketBinding.store.observe !== "function" ||
      typeof options.v2ObjectBucketBinding.store.delete !== "function" ||
      !(options.v2ObjectBucketBinding.signingKey instanceof Uint8Array) ||
      options.v2ObjectBucketBinding.signingKey.byteLength < 32 ||
      !Number.isSafeInteger(options.v2ObjectBucketBinding.privatePort) ||
      options.v2ObjectBucketBinding.privatePort < 1 ||
      options.v2ObjectBucketBinding.privatePort > 65_535 ||
      options.v2ObjectBucketBinding.privatePort === options.sqliteBinding?.privatePort)
  ) {
    throw new TypeError(
      "v2 ObjectBucket binding requires exact store, separate key and fixed port",
    );
  }
  if (
    options.v2KvBinding &&
    (!options.v2KvBinding.store ||
      typeof options.v2KvBinding.store.openNamespace !== "function" ||
      typeof options.v2KvBinding.store.create !== "function" ||
      typeof options.v2KvBinding.store.reconcileCreate !== "function" ||
      typeof options.v2KvBinding.store.observe !== "function" ||
      typeof options.v2KvBinding.store.delete !== "function" ||
      !(options.v2KvBinding.signingKey instanceof Uint8Array) ||
      options.v2KvBinding.signingKey.byteLength < 32 ||
      !Number.isSafeInteger(options.v2KvBinding.privatePort) ||
      options.v2KvBinding.privatePort < 1 ||
      options.v2KvBinding.privatePort > 65_535 ||
      options.v2KvBinding.privatePort === options.sqliteBinding?.privatePort ||
      options.v2KvBinding.privatePort === options.v2ObjectBucketBinding?.privatePort)
  ) {
    throw new TypeError("v2 KV binding requires exact store, separate key and fixed port");
  }
  if (
    options.v2QueueProducerBinding &&
    (typeof options.v2QueueProducerBinding.custody?.admitV2Batch !== "function" ||
      !(options.v2QueueProducerBinding.signingKey instanceof Uint8Array) ||
      options.v2QueueProducerBinding.signingKey.byteLength < 32 ||
      !Number.isSafeInteger(options.v2QueueProducerBinding.privatePort) ||
      options.v2QueueProducerBinding.privatePort < 1 ||
      options.v2QueueProducerBinding.privatePort > 65_535 ||
      options.v2QueueProducerBinding.privatePort === options.sqliteBinding?.privatePort ||
      options.v2QueueProducerBinding.privatePort === options.v2ObjectBucketBinding?.privatePort ||
      options.v2QueueProducerBinding.privatePort === options.v2KvBinding?.privatePort ||
      queueSettlement?.address.endsWith(`:${options.v2QueueProducerBinding.privatePort}`))
  ) {
    throw new TypeError("v2 Queue producer requires guarded custody, separate key and fixed port");
  }
  // A caller cannot retarget the private listener, signing bytes, or custody
  // methods between factory construction and the first owner restoration.
  const sqliteBinding = options.sqliteBinding
    ? Object.freeze({
        store: Object.freeze({ ...options.sqliteBinding.store }),
        signingKey: new Uint8Array(options.sqliteBinding.signingKey),
        stagingRoot: options.sqliteBinding.stagingRoot,
        privatePort: options.sqliteBinding.privatePort,
      })
    : undefined;
  const v2ObjectBucketBinding = options.v2ObjectBucketBinding
    ? Object.freeze({
        store: Object.freeze({ ...options.v2ObjectBucketBinding.store }),
        signingKey: new Uint8Array(options.v2ObjectBucketBinding.signingKey),
        privatePort: options.v2ObjectBucketBinding.privatePort,
      })
    : undefined;
  const v2KvBinding = options.v2KvBinding
    ? Object.freeze({
        store: Object.freeze({ ...options.v2KvBinding.store }),
        signingKey: new Uint8Array(options.v2KvBinding.signingKey),
        privatePort: options.v2KvBinding.privatePort,
      })
    : undefined;
  const v2QueueProducerBinding = options.v2QueueProducerBinding
    ? Object.freeze({
        custody: Object.freeze({
          admitV2Batch: options.v2QueueProducerBinding.custody.admitV2Batch.bind(
            options.v2QueueProducerBinding.custody,
          ),
        }),
        signingKey: new Uint8Array(options.v2QueueProducerBinding.signingKey),
        privatePort: options.v2QueueProducerBinding.privatePort,
      })
    : undefined;
  const suppliedSealer = options.configuredInputSealer;
  if (
    suppliedSealer &&
    (typeof suppliedSealer.seal !== "function" ||
      typeof suppliedSealer.open !== "function" ||
      typeof suppliedSealer.compare !== "function")
  ) {
    throw new TypeError("v2 Worker configured input sealer is incomplete");
  }
  // Keep admission and runtime on the same methods selected at boot. The
  // sealer's compare() calls this.open(), so bind it to this frozen snapshot.
  const configuredInputSealer = suppliedSealer
    ? Object.freeze({
        seal: suppliedSealer.seal.bind(suppliedSealer),
        open: suppliedSealer.open.bind(suppliedSealer),
        compare: suppliedSealer.compare,
      })
    : undefined;
  const configuredInputCustody = configuredInputSealer
    ? {
        read: (identity: Parameters<typeof readV2ConfiguredPrivateInputs>[1]) =>
          readV2ConfiguredPrivateInputs(sql, identity),
      }
    : undefined;
  const configuredInputs =
    configuredInputSealer && configuredInputCustody
      ? createV2CodeConfiguredInputReader({
          sql,
          sealer: configuredInputSealer,
          custody: configuredInputCustody,
        })
      : undefined;
  const bundleCustody = config.workerBundle
    ? createWorkerBundleCustody({
        sql,
        source: createV2HeldArtifactSource({
          objects,
          entries: config.workerBundle.heldArtifacts,
        }),
      })
    : undefined;
  const assetCustody = config.staticAssetBundle
    ? createStaticAssetBundleCustody({
        sql,
        source: createV2HeldArtifactSource({
          objects,
          entries: config.staticAssetBundle.heldArtifacts,
        }),
      })
    : undefined;
  const publicationState = createV2WorkerPublicationState({
    sql,
    now: clock,
    ...(bundleCustody ? { bundleCustody } : {}),
    ...(assetCustody ? { assetCustody } : {}),
  });
  const moduleInspector = createWorkerdWorkerModuleInspector({
    binary: options.workerdBinary,
  });
  const inspectModule = moduleInspector.inspect;
  const owners = new Map<string, Promise<WorkerdWorkerRuntimeOwner>>();
  let actorRestoreProof = false;
  let workflowHostClosing = false;
  const actor = options.v2Actor
    ? (() => {
        if (
          !bundleCustody ||
          !options.workerdBinary ||
          typeof options.v2Actor?.prepare !== "function" ||
          typeof moduleInspector.inspectActorClass !== "function"
        )
          throw new TypeError("v2 Actor boot requires held bytes, native binary, and inspector");
        const prepared = options.v2Actor.prepare({
          sql,
          targetKey,
          bundleCustody,
          inspector: moduleInspector,
          ownerForWorker: async (uid) => {
            if (actorRestoreProof) return (await owners.get(uid)) ?? null;
            if (!restorationComplete) return null;
            return await openOwner(uid);
          },
          actorInvocationReady: () => restorationComplete && !ownerAdmissionFrozen,
        });
        if (
          typeof prepared?.namespaceForm?.backend?.execute !== "function" ||
          typeof prepared.bindingAuthority?.resolveTarget !== "function" ||
          typeof prepared.forwardBoot?.openIncarnation !== "function"
        )
          throw new TypeError("v2 Actor boot is incomplete");
        return prepared;
      })()
    : undefined;
  const workflow = options.v2Workflow
    ? (() => {
        if (
          !bundleCustody ||
          !options.workerdBinary ||
          typeof options.v2Workflow?.prepare !== "function" ||
          typeof moduleInspector.inspectWorkflowClass !== "function"
        )
          throw new TypeError("v2 Workflow boot requires held bytes, native binary, and inspector");
        const prepared = options.v2Workflow.prepare({
          sql,
          clock,
          targetKey,
          workerdBinary: options.workerdBinary,
          bundleCustody,
          ...(assetCustody ? { assetCustody } : {}),
          inspector: moduleInspector,
          ownerForWorker: async (uid) => {
            if (!restorationComplete) return null;
            return await openOwner(uid);
          },
        });
        if (
          typeof prepared?.workflowForm?.backend?.execute !== "function" ||
          typeof prepared.bindingAuthority?.resolveTarget !== "function" ||
          typeof prepared.forwardBoot?.openIncarnation !== "function" ||
          typeof prepared.pollWorkflowDue !== "function" ||
          typeof prepared.runWorkflowOnce !== "function" ||
          typeof prepared.close !== "function"
        )
          throw new TypeError("v2 Workflow boot is incomplete");
        return prepared;
      })()
    : undefined;
  const sqliteAuthority = sqliteBinding
    ? createSQLiteWorkerBindingAuthority({ sql, targetKey })
    : undefined;
  const objectBucketAuthority = v2ObjectBucketBinding
    ? createObjectBucketWorkerBindingAuthority({ sql, targetKey })
    : undefined;
  const kvAuthority = v2KvBinding ? createKvWorkerBindingAuthority({ sql, targetKey }) : undefined;
  const queueProducerAuthority = v2QueueProducerBinding
    ? createQueueWorkerBindingAuthority({ sql, targetKey })
    : undefined;
  const serviceBindingAuthority = createV2ServiceBindingAuthority({ sql, targetKey });
  const sqliteBroker =
    sqliteBinding && sqliteAuthority
      ? createSelfhostV2SqliteBindingBroker({
          store: sqliteBinding.store,
          signingKey: sqliteBinding.signingKey,
          stagingRoot: sqliteBinding.stagingRoot,
          resolveCurrentBinding: sqliteAuthority.resolveCurrentBinding,
          async observeVersionTarget(input) {
            try {
              if (!restorationComplete) return { kind: "unknown" };
              const owner = await openOwner(input.workerUid);
              return await owner.observeVersionTarget(input);
            } catch {
              return { kind: "unknown" };
            }
          },
          async graphStillCurrent(grant) {
            return await sqliteGrantGraphStillCurrent(grant);
          },
        })
      : undefined;
  const kvBroker =
    v2KvBinding && kvAuthority
      ? createSelfhostV2KvBindingBroker({
          store: v2KvBinding.store,
          targetKey,
          signingKey: v2KvBinding.signingKey,
          async observeVersionTarget(input) {
            try {
              if (!restorationComplete) return { kind: "unknown" };
              const owner = await openOwner(input.workerUid);
              return await owner.observeVersionTarget(input);
            } catch {
              return { kind: "unknown" };
            }
          },
          resolveCurrentBinding: kvAuthority.resolveCurrentBinding,
        })
      : undefined;
  const objectBucketBroker =
    v2ObjectBucketBinding && objectBucketAuthority
      ? createSelfhostV2ObjectBucketBindingBroker({
          store: v2ObjectBucketBinding.store,
          targetKey,
          signingKey: v2ObjectBucketBinding.signingKey,
          async observeVersionTarget(input) {
            try {
              if (!restorationComplete) return { kind: "unknown" };
              const owner = await openOwner(input.workerUid);
              return await owner.observeVersionTarget(input);
            } catch {
              return { kind: "unknown" };
            }
          },
          resolveCurrentBucketBinding: objectBucketAuthority.resolveCurrentBucketBinding,
        })
      : undefined;
  const queueProducerBroker =
    v2QueueProducerBinding && queueProducerAuthority
      ? createSelfhostV2QueueProducerBroker({
          custody: v2QueueProducerBinding.custody,
          targetKey,
          signingKey: v2QueueProducerBinding.signingKey,
          async observeVersionTarget(input) {
            try {
              if (!restorationComplete) return { kind: "unknown" };
              const owner = await openOwner(input.workerUid);
              return await owner.observeVersionTarget(input);
            } catch {
              return { kind: "unknown" };
            }
          },
          resolveCurrentBinding: queueProducerAuthority.resolveCurrentBinding,
        })
      : undefined;
  const kvBoot =
    v2KvBinding && kvBroker && kvAuthority
      ? Object.freeze({
          address: `127.0.0.1:${v2KvBinding.privatePort}`,
          issueGrant: kvBroker.issueGrant,
          resolveCurrentBinding: kvAuthority.resolveCurrentBinding,
        })
      : undefined;
  const sqliteBoot =
    sqliteBinding && sqliteBroker && sqliteAuthority
      ? Object.freeze({
          address: `127.0.0.1:${sqliteBinding.privatePort}`,
          issueGrant: sqliteBroker.issueGrant,
          resolveCurrentBinding: sqliteAuthority.resolveCurrentBinding,
        })
      : undefined;
  const objectBucketBoot =
    v2ObjectBucketBinding && objectBucketBroker && objectBucketAuthority
      ? Object.freeze({
          address: `127.0.0.1:${v2ObjectBucketBinding.privatePort}`,
          issueGrant: objectBucketBroker.issueGrant,
          resolveCurrentBucketBinding: objectBucketAuthority.resolveCurrentBucketBinding,
        })
      : undefined;
  const queueProducerBoot =
    v2QueueProducerBinding && queueProducerBroker && queueProducerAuthority
      ? Object.freeze({
          address: `127.0.0.1:${v2QueueProducerBinding.privatePort}`,
          issueGrant: queueProducerBroker.issueGrant,
          resolveCurrentBinding: queueProducerAuthority.resolveCurrentBinding,
        })
      : undefined;
  let sqliteServer: ReturnType<typeof Bun.serve> | undefined;
  let objectBucketServer: ReturnType<typeof Bun.serve> | undefined;
  let kvServer: ReturnType<typeof Bun.serve> | undefined;
  let queueProducerServer: ReturnType<typeof Bun.serve> | undefined;
  const reservedPorts = new Set<number>();
  const listenerPortForOperation =
    options.listenerPortForOperation ?? (() => unusedPrivatePort(reservedPorts));
  const spawn =
    options.spawn ??
    ((command: readonly string[]) =>
      spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" }));
  let restoration: Promise<readonly string[]> | undefined;
  let restorationComplete = false;
  let ownerAdmissionFrozen = false;
  let suspension: Promise<void> | undefined;
  const endpointPublicationUnavailable = () => ({
    kind: "unresolved" as const,
    code: "graph_unresolved" as const,
    message: "v2 Worker publication reader is unavailable before restore or during shutdown",
  });
  const endpointPublicationAvailable = () => restorationComplete && !ownerAdmissionFrozen;
  const endpointPublicationState: ReturnType<
    typeof createSelfhostV2WorkerComposition
  >["endpointPublicationState"] = Object.freeze({
    async resolve(input) {
      if (!endpointPublicationAvailable()) return endpointPublicationUnavailable();
      const resolution = await publicationState.resolve(input);
      if (!endpointPublicationAvailable()) return endpointPublicationUnavailable();
      if (resolution.kind !== "ready") return resolution;
      return Object.freeze({
        ...resolution,
        async stillCurrent() {
          if (!endpointPublicationAvailable()) return false;
          try {
            return (await resolution.stillCurrent()) && endpointPublicationAvailable();
          } catch {
            return false;
          }
        },
        async readVersionMaterials(versionUid: string) {
          if (!endpointPublicationAvailable()) {
            throw new Error("v2 Worker publication reader is unavailable");
          }
          const materials = await resolution.readVersionMaterials(versionUid);
          if (!endpointPublicationAvailable()) {
            throw new Error("v2 Worker publication reader is unavailable");
          }
          return materials;
        },
        ...(resolution.openVersionMaterialsUnverified
          ? {
              async openVersionMaterialsUnverified(versionUid: string) {
                if (!endpointPublicationAvailable()) {
                  throw new Error("v2 Worker publication reader is unavailable");
                }
                const materials = await resolution.openVersionMaterialsUnverified?.(versionUid);
                if (!endpointPublicationAvailable() || !materials) {
                  throw new Error("v2 Worker publication reader is unavailable");
                }
                return materials;
              },
            }
          : {}),
      });
    },
    async resolveCurrentServing(input) {
      if (!endpointPublicationAvailable()) return endpointPublicationUnavailable();
      const resolution = await publicationState.resolveCurrentServing(input);
      if (!endpointPublicationAvailable()) return endpointPublicationUnavailable();
      if (resolution.kind !== "ready") return resolution;
      return Object.freeze({
        ...resolution,
        async stillCurrent() {
          if (!endpointPublicationAvailable()) return false;
          try {
            return (await resolution.stillCurrent()) && endpointPublicationAvailable();
          } catch {
            return false;
          }
        },
        async readVersionMaterials(versionUid: string) {
          if (!endpointPublicationAvailable()) {
            throw new Error("v2 Worker publication reader is unavailable");
          }
          const materials = await resolution.readVersionMaterials(versionUid);
          if (!endpointPublicationAvailable()) {
            throw new Error("v2 Worker publication reader is unavailable");
          }
          return materials;
        },
      });
    },
  });

  async function sqliteGrantGraphStillCurrent(grant: V2SqliteBindingGrant): Promise<boolean> {
    try {
      if (!restorationComplete || grant.targetKey !== targetKey) return false;
      const owner = await openOwner(grant.workerUid);
      const nativeTarget = {
        workerUid: grant.workerUid,
        versionId: grant.nativeVersionId,
        incarnationId: grant.incarnationId,
        servingSourceOperationId: grant.servingSourceOperationId,
      };
      const observedTarget = await owner.observeVersionTarget(nativeTarget);
      if (
        observedTarget.kind !== "confirmed" ||
        observedTarget.workerUid !== grant.workerUid ||
        observedTarget.versionId !== grant.nativeVersionId ||
        observedTarget.incarnationId !== grant.incarnationId ||
        observedTarget.servingSourceOperationId !== grant.servingSourceOperationId
      )
        return false;
      let beforeServing =
        observedTarget.status === "active"
          ? await owner.observeServing({ workerResourceUid: grant.workerUid, targetKey })
          : null;
      if (
        beforeServing &&
        (beforeServing.kind !== "serving" ||
          beforeServing.sourceOperationId !== grant.servingSourceOperationId ||
          !beforeServing.versions.some(
            (version) => version.workerVersionUid === grant.workerVersionUid,
          ))
      ) {
        const transitioned = await owner.observeVersionTarget(nativeTarget);
        if (
          transitioned.kind !== "confirmed" ||
          transitioned.status !== "draining" ||
          transitioned.workerUid !== grant.workerUid ||
          transitioned.versionId !== grant.nativeVersionId ||
          transitioned.incarnationId !== grant.incarnationId ||
          transitioned.servingSourceOperationId !== grant.servingSourceOperationId
        )
          return false;
        beforeServing = null;
      }

      // The grant is minted only from a preflighted accepted publication and
      // bound to one native owner incarnation. A pending replacement may make
      // current-serving SQL unavailable *before* that old owner drains. Existing
      // contexts still retain their selected Version through both states; this
      // gate cannot admit a new invocation or select a stale Version for one.
      if (!sqliteAuthority || grant.bindings.length === 0) return false;
      const worker = await sql.query(
        `SELECT uid FROM tf_v2_resources
         WHERE uid = ? AND form_url = ? AND principal = ? AND space = ?
           AND target_key = ? AND deleted_at IS NULL`,
        [grant.workerUid, MODULE_WORKER_FORM_URL, grant.principal, grant.space, targetKey],
      );
      if (worker.length !== 1 || worker[0]?.uid !== grant.workerUid) return false;
      for (const binding of grant.bindings) {
        const current = await sqliteAuthority.resolveCurrentBinding(grant, binding.name);
        if (current?.resourceUid !== binding.resourceUid) return false;
      }
      const afterTarget = await owner.observeVersionTarget(nativeTarget);
      if (
        afterTarget.kind !== "confirmed" ||
        (observedTarget.status === "draining" && afterTarget.status !== "draining") ||
        (afterTarget.status !== "active" && afterTarget.status !== "draining") ||
        afterTarget.workerUid !== observedTarget.workerUid ||
        afterTarget.versionId !== observedTarget.versionId ||
        afterTarget.incarnationId !== observedTarget.incarnationId ||
        afterTarget.servingSourceOperationId !== observedTarget.servingSourceOperationId
      )
        return false;
      if (afterTarget.status === "draining") return true;
      if (!beforeServing) return false;
      const afterServing = await owner.observeServing({
        workerResourceUid: grant.workerUid,
        targetKey,
      });
      const finalTarget = await owner.observeVersionTarget(nativeTarget);
      if (
        finalTarget.kind === "confirmed" &&
        finalTarget.status === "draining" &&
        finalTarget.workerUid === grant.workerUid &&
        finalTarget.versionId === grant.nativeVersionId &&
        finalTarget.incarnationId === grant.incarnationId &&
        finalTarget.servingSourceOperationId === grant.servingSourceOperationId
      )
        return true;
      return (
        afterServing.kind === "serving" &&
        JSON.stringify(afterServing) === JSON.stringify(beforeServing) &&
        finalTarget.kind === "confirmed" &&
        finalTarget.status === "active" &&
        finalTarget.workerUid === grant.workerUid &&
        finalTarget.versionId === grant.nativeVersionId &&
        finalTarget.incarnationId === grant.incarnationId &&
        finalTarget.servingSourceOperationId === grant.servingSourceOperationId
      );
    } catch {
      return false;
    }
  }

  async function openOwner(
    uid: string,
    allowRetiredSqlResource = false,
  ): Promise<WorkerdWorkerRuntimeOwner> {
    if (ownerAdmissionFrozen) throw new Error("v2 Worker owner admission is frozen");
    if (!uid || uid.length > 256) throw new TypeError("invalid Worker UID");
    const existing = owners.get(uid);
    if (existing) return await existing;
    const opening = (async () => {
      const rows = await sql.query(
        `SELECT uid, principal, space, backend_id, target_key, deleted_at FROM tf_v2_resources
         WHERE uid = ? AND form_url = ? AND target_key = ?`,
        [uid, MODULE_WORKER_FORM_URL, targetKey],
      );
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row?.uid !== uid ||
        typeof row.principal !== "string" ||
        !row.principal ||
        typeof row.space !== "string" ||
        !row.space ||
        row.backend_id !== MODULE_WORKER_LIFECYCLE_BACKEND_ID ||
        row.target_key !== targetKey ||
        (!allowRetiredSqlResource && row.deleted_at !== null)
      ) {
        throw new Error("v2 Worker UID is not current in this Host target");
      }
      const actorIdentity = Object.freeze({ principal: row.principal, space: row.space });
      return await openWorkerdWorkerRuntimeOwner({
        rootDirectory: options.rootDirectory,
        workerResourceUid: uid,
        targetKey,
        publicationState,
        ...(configuredInputs ? { configuredInputs } : {}),
        ...(queueSettlement ? { v2QueueSettlement: queueSettlement } : {}),
        ...(sqliteBoot ? { v2SqliteBinding: sqliteBoot } : {}),
        ...(objectBucketBoot ? { v2ObjectBucketBinding: objectBucketBoot } : {}),
        ...(kvBoot ? { v2KvBinding: kvBoot } : {}),
        ...(queueProducerBoot ? { v2QueueProducerBinding: queueProducerBoot } : {}),
        v2ServiceBinding: {
          authority: serviceBindingAuthority,
          ownerForResourceUid: async (resourceUid) => {
            if (!restorationComplete) return null;
            try {
              const targetOwner = await openOwner(resourceUid);
              return {
                workerResourceUid: targetOwner.workerResourceUid,
                dispatchServiceBinding: targetOwner.dispatchServiceBinding.bind(targetOwner),
              };
            } catch {
              return null;
            }
          },
        },
        ...(actor && row.deleted_at === null
          ? {
              deferActorRestoreAdmission: !restorationComplete,
              v2ActorForward: {
                openIncarnation(source) {
                  return actor.forwardBoot.openIncarnation({ ...source, ...actorIdentity });
                },
              },
            }
          : {}),
        ...(workflow && row.deleted_at === null ? { v2WorkflowForward: workflow.forwardBoot } : {}),
        workerdBinary: options.workerdBinary,
        inspectModule,
        listenerPortForOperation,
        spawn,
      });
    })();
    owners.set(uid, opening);
    try {
      return await opening;
    } catch (error) {
      if (owners.get(uid) === opening) owners.delete(uid);
      throw error;
    }
  }

  async function restore(): Promise<readonly string[]> {
    await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(options.rootDirectory);
    const canonicalRoot = await realpath(options.rootDirectory);
    const canonicalInfo = await lstat(canonicalRoot);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      (rootInfo.mode & 0o077) !== 0 ||
      !canonicalInfo.isDirectory() ||
      (canonicalInfo.mode & 0o077) !== 0
    ) {
      throw new Error("v2 Worker owner root is not private");
    }
    const workers = await sql.query(
      `SELECT uid, observed_json FROM tf_v2_resources
       WHERE form_url = ? AND target_key = ?`,
      [MODULE_WORKER_FORM_URL, targetKey],
    );
    const byOwnerKey = new Map<string, string>();
    const expectedServing = new Set<string>();
    for (const row of workers) {
      if (typeof row.uid !== "string" || typeof row.observed_json !== "string") {
        throw new Error("v2 Worker inventory is malformed");
      }
      const observed: unknown = JSON.parse(row.observed_json);
      if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
        throw new Error("v2 Worker observation is malformed");
      }
      byOwnerKey.set(ownerKey(row.uid), row.uid);
      if (
        (observed as Record<string, unknown>).activeDeploymentUid !== null &&
        (observed as Record<string, unknown>).activeDeploymentUid !== undefined
      ) {
        expectedServing.add(ownerKey(row.uid));
      }
    }
    const deployments = await sql.query(
      `SELECT spec_json FROM tf_v2_resources
       WHERE form_url = ? AND target_key = ? AND deleted_at IS NULL
         AND json_extract(observed_json, '$.active') = 1`,
      [WORKER_DEPLOYMENT_FORM_URL, targetKey],
    );
    for (const row of deployments) {
      if (typeof row.spec_json !== "string") throw new Error("v2 Deployment inventory malformed");
      const workerUid = parseWorkerDeploymentSpec(JSON.parse(row.spec_json)).worker.resourceUid;
      expectedServing.add(ownerKey(workerUid));
    }
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || !byOwnerKey.has(entry.name)) {
        throw new Error("v2 Worker owner namespace is not explained by current SQL");
      }
    }
    for (const key of expectedServing) {
      if (!names.has(key)) throw new Error("v2 Worker serving owner is missing");
    }
    const restored: string[] = [];
    try {
      if (sqliteBroker && sqliteBinding) {
        sqliteServer = Bun.serve({
          hostname: "127.0.0.1",
          port: sqliteBinding.privatePort,
          async fetch(request) {
            return (await sqliteBroker.handle(request)) ?? new Response(null, { status: 404 });
          },
        });
        if (sqliteServer.port !== sqliteBinding.privatePort) {
          await sqliteServer.stop(true);
          sqliteServer = undefined;
          throw new Error("v2 SQLite private listener address changed");
        }
      }
      if (objectBucketBroker && v2ObjectBucketBinding) {
        objectBucketServer = Bun.serve({
          hostname: "127.0.0.1",
          port: v2ObjectBucketBinding.privatePort,
          async fetch(request) {
            let url: URL;
            try {
              url = new URL(request.url);
            } catch {
              return new Response(null, { status: 404 });
            }
            if (url.pathname !== SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH) {
              return new Response(null, { status: 404 });
            }
            const brokerUrl = new URL(SELFHOST_DATA_PLANE_OBJECTS_PATH, request.url);
            return (
              (await objectBucketBroker.routes(request, brokerUrl)) ??
              new Response(null, { status: 404 })
            );
          },
        });
        if (objectBucketServer.port !== v2ObjectBucketBinding.privatePort) {
          await objectBucketServer.stop(true);
          objectBucketServer = undefined;
          await sqliteServer?.stop(true);
          sqliteServer = undefined;
          throw new Error("v2 ObjectBucket private listener address changed");
        }
      }
      if (kvBroker && v2KvBinding) {
        kvServer = Bun.serve({
          hostname: "127.0.0.1",
          port: v2KvBinding.privatePort,
          async fetch(request) {
            let url: URL;
            try {
              url = new URL(request.url);
            } catch {
              return new Response(null, { status: 404 });
            }
            if (url.pathname !== SELFHOST_DATA_PLANE_KV_PATH) {
              return new Response(null, { status: 404 });
            }
            return (await kvBroker.handle(request)) ?? new Response(null, { status: 404 });
          },
        });
        if (kvServer.port !== v2KvBinding.privatePort) {
          await kvServer.stop(true);
          kvServer = undefined;
          await sqliteServer?.stop(true);
          sqliteServer = undefined;
          await objectBucketServer?.stop(true);
          objectBucketServer = undefined;
          throw new Error("v2 KV private listener address changed");
        }
      }
      if (queueProducerBroker && v2QueueProducerBinding) {
        queueProducerServer = Bun.serve({
          hostname: "127.0.0.1",
          port: v2QueueProducerBinding.privatePort,
          async fetch(request) {
            return (
              (await queueProducerBroker.handle(request)) ?? new Response(null, { status: 404 })
            );
          },
        });
        if (queueProducerServer.port !== v2QueueProducerBinding.privatePort) {
          throw new Error("v2 Queue producer private listener address changed");
        }
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const uid = byOwnerKey.get(entry.name);
        if (!uid) throw new Error("v2 Worker owner inventory changed");
        await openOwner(uid, true);
        restored.push(uid);
      }
      actorRestoreProof = true;
      for (const opening of owners.values()) await (await opening).completeActorRestore();
    } catch (error) {
      actorRestoreProof = false;
      await sqliteServer?.stop(true);
      sqliteServer = undefined;
      await objectBucketServer?.stop(true);
      objectBucketServer = undefined;
      await kvServer?.stop(true);
      kvServer = undefined;
      await queueProducerServer?.stop(true);
      queueProducerServer = undefined;
      throw error;
    }
    restorationComplete = true;
    actorRestoreProof = false;
    return restored;
  }

  const readers = createV2WorkerdWorkerRuntimeReaders({
    ownerForWorkerUid: async (uid) => {
      if (!restoration) return null;
      await restoration;
      return await openOwner(uid);
    },
  });
  const scheduled = createSelfhostV2ScheduledComposition({
    sql,
    targetKey,
    now: clock,
    ownerForWorkerUid: async (uid) => {
      if (!restorationComplete || ownerAdmissionFrozen)
        throw new Error("v2 scheduled Worker owner is unavailable");
      const owner = await openOwner(uid);
      if (!restorationComplete || ownerAdmissionFrozen)
        throw new Error("v2 scheduled Worker owner is unavailable");
      return owner;
    },
  });
  const queueCapability = queueSettlement
    ? createSelfhostV2QueueWorkerCapability({
        sql,
        targetKey,
        publicationState,
        ownerForWorkerUid: async (uid) => {
          if (!restorationComplete) throw new Error("v2 Worker owners have not restored");
          return await openOwner(uid);
        },
      })
    : undefined;
  const createInternalForms = (
    context: Parameters<V2OperatorFormFactory>[0],
    endpoint: EndpointPorts | undefined,
    allowPrivateInputs = true,
  ) => {
    if (context.sql !== sql || context.objects !== objects || context.clock !== clock) {
      throw new TypeError(
        "v2 Worker Forms must use this application's exact SQL, objects and clock",
      );
    }
    if (!restorationComplete || ownerAdmissionFrozen)
      throw new TypeError("v2 Worker owners must restore before Form composition");
    if (
      endpoint !== undefined &&
      (typeof endpoint?.assignHostname !== "function" ||
        typeof endpoint.observeTls !== "function" ||
        typeof endpoint.observeRouteAbsent !== "function")
    ) {
      throw new TypeError("v2 Worker Endpoint frontend proof is not composed");
    }
    const versionOptions = {
      sql,
      targetKey,
      publicationState,
      retirement: readers.retirement,
      inspectModule,
      ...(queueSettlement ? { queueSettlement } : {}),
      ...(sqliteBoot ? { v2SqliteBinding: sqliteBoot } : {}),
      ...(objectBucketBoot ? { v2ObjectBucketBinding: objectBucketBoot } : {}),
      ...(kvBoot ? { v2KvBinding: kvBoot } : {}),
      ...(queueProducerBoot ? { v2QueueProducerBinding: queueProducerBoot } : {}),
      ...(actor ? { v2ActorBinding: actor.bindingAuthority } : {}),
      ...(workflow ? { v2WorkflowBinding: workflow.bindingAuthority } : {}),
    };
    const runtimeVersionForm = createInternalV2WorkerVersionForm({
      ...versionOptions,
      ...(configuredInputSealer && configuredInputCustody
        ? { configuredInputSealer, configuredInputCustody }
        : {}),
    });
    const admissionVersionForm = allowPrivateInputs
      ? runtimeVersionForm
      : createInternalV2WorkerVersionForm(versionOptions);
    const versionForm = allowPrivateInputs
      ? runtimeVersionForm
      : {
          validateCreate: admissionVersionForm.validateCreate,
          validateUpdate: admissionVersionForm.validateUpdate,
          ...(admissionVersionForm.references
            ? { references: admissionVersionForm.references }
            : {}),
          ...(runtimeVersionForm.rejectDeleteWhileReferenced
            ? { rejectDeleteWhileReferenced: true as const }
            : {}),
          backend: runtimeVersionForm.backend,
        };
    return {
      [MODULE_WORKER_FORM_URL]: createInternalV2ModuleWorkerForm({
        sql,
        targetKey,
        ...readers,
      }),
      [WORKER_VERSION_FORM_URL]: versionForm,
      [WORKER_DEPLOYMENT_FORM_URL]: createWorkerDeploymentForm({
        targetKey,
        publicationState,
        scheduledAttachments: createWorkerCronTriggerAdmissionReader({ sql }),
        ownerForWorker: async (uid) => {
          await restoration;
          return await openOwner(uid);
        },
      }),
      [WORKER_CRON_TRIGGER_FORM_URL]: createWorkerCronTriggerForm({
        sql,
        targetKey,
        capability: scheduled.capability,
        now: clock,
      }),
      ...(actor
        ? {
            [ACTOR_NAMESPACE_FORM_URL]: actor.namespaceForm,
          }
        : {}),
      ...(workflow ? { [DURABLE_WORKFLOW_FORM_URL]: workflow.workflowForm } : {}),
      ...(queueProducerBoot && queueSettlement
        ? {
            [AT_LEAST_ONCE_QUEUE_FORM_URL]: createAtLeastOnceQueueForm({ sql, targetKey }),
          }
        : {}),
      ...(queueCapability && queueSettlement
        ? {
            [QUEUE_CONSUMER_FORM_URL]: createQueueConsumerForm({
              sql,
              targetKey,
              capability: queueCapability,
            }),
          }
        : {}),
      ...(endpoint
        ? {
            [WORKER_ENDPOINT_FORM_URL]: createWorkerEndpointForm({
              targetKey,
              publicationState,
              ownerForWorker: async (uid) => {
                await restoration;
                return await openOwner(uid);
              },
              ...endpoint,
            }),
          }
        : {}),
    };
  };
  const internalFormFactory: V2OperatorFormFactory = (context) =>
    createInternalForms(context, configuredEndpoint);
  function internalFormFactoryForEndpoint(endpoint: EndpointPorts): V2OperatorFormFactory {
    if (!restorationComplete || ownerAdmissionFrozen)
      throw new TypeError("v2 Worker owners must restore before Form composition");
    if (
      !endpoint ||
      typeof endpoint.assignHostname !== "function" ||
      typeof endpoint.observeTls !== "function" ||
      typeof endpoint.observeRouteAbsent !== "function"
    ) {
      throw new TypeError("v2 Worker Endpoint frontend proof is not composed");
    }
    const capturedEndpoint = Object.freeze({
      assignHostname: endpoint.assignHostname,
      observeTls: endpoint.observeTls,
      observeRouteAbsent: endpoint.observeRouteAbsent,
    });
    return (context) => createInternalForms(context, capturedEndpoint);
  }
  function secretFreeFormFactory(endpoint?: EndpointPorts): V2OperatorFormFactory {
    if (!restorationComplete || ownerAdmissionFrozen)
      throw new TypeError("v2 Worker owners must restore before Form composition");
    if (
      !options.workerdBinary ||
      config.workerBundle?.targetKey !== targetKey ||
      config.staticAssetBundle?.targetKey !== targetKey ||
      !actor ||
      !workflow ||
      !queueSettlement ||
      !queueProducerBoot ||
      !queueCapability ||
      !sqliteBinding ||
      !options.v2KvBinding ||
      !options.v2ObjectBucketBinding
    ) {
      throw new TypeError("complete secret-free v2 Worker Form dependencies are unavailable");
    }
    const sqliteStore = sqliteBinding.store;
    const kvStore = options.v2KvBinding.store;
    const objectBucketStore = options.v2ObjectBucketBinding.store;
    const migrationCustody = config.sqliteMigrationSet
      ? createSQLiteMigrationSetCustody({
          sql,
          source: createV2HeldArtifactSource({
            objects,
            entries: config.sqliteMigrationSet.heldArtifacts,
          }),
          now: clock,
        })
      : undefined;
    let capturedEndpoint: EndpointPorts | undefined;
    if (endpoint !== undefined) {
      const { assignHostname, observeTls, observeRouteAbsent } = endpoint;
      if (
        typeof assignHostname !== "function" ||
        typeof observeTls !== "function" ||
        typeof observeRouteAbsent !== "function"
      ) {
        throw new TypeError("v2 Worker Endpoint frontend proof is not composed");
      }
      capturedEndpoint = Object.freeze({ assignHostname, observeTls, observeRouteAbsent });
    }
    return (context) => ({
      ...createInternalForms(context, capturedEndpoint, false),
      [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store: sqliteStore }),
      ...(migrationCustody
        ? {
            [SQLITE_MIGRATION_APPLICATION_FORM_URL]: createSQLiteMigrationApplicationForm({
              sql,
              migrationPort: createSQLiteMigrationApplicationNativePort(sqliteStore),
              custody: migrationCustody,
              targetKey,
              now: clock,
            }),
          }
        : {}),
      [EDGE_KV_NAMESPACE_FORM_URL]: createEdgeKVNamespaceForm({
        store: kvStore,
        targetKey,
      }),
      [OBJECT_BUCKET_FORM_URL]: createObjectBucketForm({
        store: objectBucketStore,
        targetKey,
      }),
    });
  }

  return {
    ...(queueCapability ? { queueCapability } : {}),
    endpointPublicationState,
    pollScheduledDue() {
      if (!restorationComplete || ownerAdmissionFrozen)
        return Promise.reject(new Error("v2 scheduled delivery is unavailable"));
      return scheduled.tick();
    },
    async closeScheduledHost() {
      scheduled.close();
      await scheduled.drain();
    },
    restoreOwners() {
      restoration ??= restore();
      return restoration;
    },
    async actorOwnerForRecovery(uid) {
      if (ownerAdmissionFrozen) return null;
      if (actorRestoreProof) return (await owners.get(uid)) ?? null;
      if (!restorationComplete) return null;
      return await openOwner(uid);
    },
    async ownerForWorkerUid(uid) {
      if (!restoration) throw new Error("v2 Worker owners have not restored");
      await restoration;
      return await openOwner(uid);
    },
    pollWorkflowDue() {
      if (!workflow || !restorationComplete || ownerAdmissionFrozen || workflowHostClosing)
        return Promise.reject(new Error("v2 Workflow execution is unavailable"));
      return workflow.pollWorkflowDue();
    },
    async runWorkflowOnce(scope, id) {
      if (!workflow || !restorationComplete || ownerAdmissionFrozen || workflowHostClosing)
        throw new Error("v2 Workflow execution is unavailable");
      return await workflow.runWorkflowOnce(
        { tenantId: scope.tenantId, workflowResourceUid: scope.workflowResourceUid },
        id,
      );
    },
    async closeWorkflowHost() {
      workflowHostClosing = true;
      await workflow?.close();
    },
    suspendOwnersRetainingCustody() {
      if (suspension) return suspension;
      // This synchronous transition closes the only path that creates a new
      // owner before awaiting restore/open work already admitted by this
      // composition. Each owner then proves child exit and listener vacancy
      // while retaining its durable lock/state for a later Host process.
      ownerAdmissionFrozen = true;
      workflowHostClosing = true;
      scheduled.close();
      const attempt = (async () => {
        await scheduled.drain();
        // A guarded Workflow run can hold the selected native owner lease.
        // Reap it before owner suspension; failure retains all owner custody.
        await workflow?.close();
        if (restoration) await restoration;
        const pending = [...owners.entries()];
        const opened = await Promise.all(
          pending.map(async ([uid, opening]) => ({ uid, owner: await opening })),
        );
        await Promise.all(
          opened.map(async ({ uid, owner }) => {
            const kind = await workerShutdownKind(sql, uid, targetKey);
            if (kind === "deleted") {
              // A terminal, exact ModuleWorker DELETE has already retired every
              // native incarnation. close() independently verifies its durable
              // receipts and vacancy before releasing this UID owner lock.
              await owner.close();
            } else {
              const workerRows = await sql.query(
                `SELECT principal, space FROM tf_v2_resources
                 WHERE uid = ? AND form_url = ? AND target_key = ? AND deleted_at IS NULL LIMIT 2`,
                [uid, MODULE_WORKER_FORM_URL, targetKey],
              );
              const workerRow = workerRows.length === 1 ? workerRows[0] : undefined;
              if (typeof workerRow?.principal !== "string" || typeof workerRow.space !== "string") {
                throw new Error("v2 Worker SQL identity is unavailable for shutdown");
              }
              const noServing = await publicationState.observeNoCurrentServing({
                workerUid: uid,
                principal: workerRow.principal,
                space: workerRow.space,
                targetKey,
              });
              if (noServing.kind === "confirmed") {
                // No serving Deployment is positively established in the
                // current SQL graph; close() still refuses any live or
                // unreceipted incarnation, so no child is abandoned here.
                await owner.close();
              } else {
                const serving = await owner.observeServing({
                  workerResourceUid: uid,
                  targetKey,
                });
                if (
                  serving.kind !== "serving" ||
                  serving.workerResourceUid !== uid ||
                  serving.targetKey !== targetKey
                ) {
                  throw new Error("v2 Worker serving state is uncertain during shutdown");
                }
                await owner.suspend();
              }
            }
          }),
        );
        await sqliteServer?.stop(true);
        sqliteServer = undefined;
        await objectBucketServer?.stop(true);
        objectBucketServer = undefined;
        await kvServer?.stop(true);
        kvServer = undefined;
        await queueProducerServer?.stop(true);
        queueProducerServer = undefined;
      })();
      suspension = attempt.catch((error) => {
        // A failed guarded stop retains custody and can be retried; never
        // turn one transient close failure into a permanently cached refusal.
        suspension = undefined;
        throw error;
      });
      return suspension;
    },
    async closePrivateBindingServices() {
      if (!sqliteServer && !objectBucketServer && !kvServer && !queueProducerServer) return;
      // A private companion address is pinned in every live native graph.
      // Refuse to remove it while any owner still has an active/draining copy.
      for (const opening of owners.values()) await (await opening).close();
      await sqliteServer?.stop(true);
      sqliteServer = undefined;
      await objectBucketServer?.stop(true);
      objectBucketServer = undefined;
      await kvServer?.stop(true);
      kvServer = undefined;
      await queueProducerServer?.stop(true);
      queueProducerServer = undefined;
    },
    internalFormFactory,
    internalFormFactoryForEndpoint,
    secretFreeFormFactory,
  };
}
