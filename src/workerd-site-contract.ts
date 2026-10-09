/** Pure native publication shapes shared with accepted Actor graph contracts. */
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import type { SelfhostWeightedVersion } from "./selfhost-weighted-deployment.ts";

/** One environment entry the module sees on `env`. */
export interface WorkerdBinding {
  readonly name: string;
  readonly value: string;
  /** `text` is a string; `json` is parsed by the runtime before the module sees it. */
  readonly kind: "text" | "json";
}

/** One Host-private native service binding on a tenant entrypoint. */
export interface WorkerdServiceBinding {
  readonly name: string;
  readonly target: string;
  readonly targetResourceUid: string;
  /** Per-caller marker used only by the unavailable router. */
  readonly unavailableToken: string;
}

/** Media types workerd can use for a module declaration in this runtime. */
export type WorkerdModuleMediaType =
  | "application/javascript+module"
  | "text/plain"
  | "application/octet-stream"
  | "application/wasm";

export interface WorkerdAssetDeclaration {
  readonly notFoundHandling: "none" | "single-page-application";
  readonly runWorkerFirst: boolean;
  /** Explicit v2 code+asset path grammar; omitted for legacy code sites. */
  readonly strictPaths?: true;
  /** Exact normalized media type for every logical asset path. */
  readonly mediaTypes: Readonly<Record<string, string>>;
}

export interface WorkerdActorForwardBinding {
  readonly publicName: string;
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  readonly httpService: string;
  readonly upgradeService: string;
  /** Host-private bearer already embedded in the generated outer wrapper. */
  readonly token: string;
  /** Host-selected full ABI identity; omission retains the released Actor profile. */
  readonly runtimeClassRef?: TakoformInterfaceRef;
}

export interface WorkerdActorForward {
  readonly schema: "takoserver.selfhost-actor-forward@v1";
  readonly bindings: readonly WorkerdActorForwardBinding[];
}

/** Unpublished Host-only Workflow forward projection from one immutable V10 snapshot. */
export interface WorkerdLegacyWorkflowForwardBinding {
  readonly publicName: string;
  readonly serviceName: string;
  readonly tenantId: string;
  readonly workflowResourceUid: string;
  readonly workflowFormRef: TakoformV1Alpha3FormRef;
  readonly bindingRef: TakoformBindingRef;
  readonly runtimeClassRef: TakoformInterfaceRef;
  /** Host-private bearer already embedded in the generated outer wrapper. */
  readonly token: string;
}

/** Internal v2 SQL-authorized Workflow grant, without legacy digest FormRefs. */
export interface WorkerdV2WorkflowForwardBinding {
  readonly publicName: string;
  readonly serviceName: string;
  readonly tenantId: string;
  readonly workflowResourceUid: string;
  readonly token: string;
}

export type WorkerdWorkflowForwardBinding =
  | WorkerdLegacyWorkflowForwardBinding
  | WorkerdV2WorkflowForwardBinding;

export type WorkerdWorkflowForward =
  | {
      readonly schema: "takoserver.selfhost-workflow-binding-forward@v1";
      readonly snapshotDigest: `sha256:${string}`;
      readonly bindings: readonly WorkerdLegacyWorkflowForwardBinding[];
    }
  | {
      readonly schema: "takoserver.v2-workflow-binding-forward@1";
      readonly snapshotDigest: `sha256:${string}`;
      readonly bindings: readonly WorkerdV2WorkflowForwardBinding[];
    };

export interface WorkerdActorForwardSocket {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  /** Present for exact per-Version brokers; absent only on legacy static mappings. */
  readonly token?: string;
  readonly httpSocketPath: string;
  readonly upgradeSocketPath: string;
}

export interface WorkerdSite {
  readonly kind?: never;
  /** Directory holding this script's modules. */
  readonly directory: string;
  readonly mainModule: string;
  /** Host-private entrypoint that imports the exact application main. */
  readonly hostEntrypoint?: string;
  /** Additional Host-private modules, distinct from the application namespace. */
  readonly hostModules?: readonly string[];
  readonly hostnames: readonly string[];
  /** Durable identity of the desired publication, including its routes. */
  readonly generation?: string;
  /** Exact logical Worker incarnation. Absent only on a retained legacy site. */
  readonly workerResourceUid?: string;
  /** Whether this exact active Version declared the worker.runtime fetch handler. */
  readonly fetchHandler?: boolean;
  /** Logical fetch bindings; target selection never consults a request URL. */
  readonly serviceBindings?: readonly WorkerdServiceBinding[];
  /** Unpublished Host-only Actor forward projection; never a worker.service binding. */
  readonly actorForward?: WorkerdActorForward;
  /** Unpublished Host-only Workflow binding projection; never public support. */
  readonly workflowForward?: WorkerdWorkflowForward;
  /** Host-owned asset-router composition; neither service reaches tenant env. */
  readonly assets?: WorkerdAssetDeclaration;
  /** Environment entries for this script. */
  readonly vars?: readonly WorkerdBinding[];
  /** Extra declared modules beside the main module, in order. */
  readonly modules?: readonly string[];
  /** Exact media types for every declared module. */
  readonly moduleMediaTypes?: Readonly<Record<string, WorkerdModuleMediaType>>;
  /** Host-owned KV/SQL facade service, whose token never reaches tenant env. */
  readonly dataPlane?: WorkerdDataPlane;
  /** Host-owned queue/cron event gate. */
  readonly events?: WorkerdEventGate;
  /** Opt-in v2 Queue private RPC facade; never projected into tenant env. */
  readonly queueSettlement?: WorkerdQueueSettlement;
  /** Opt-in v2 ObjectBucket binding service; grant is never on the tenant service. */
  readonly v2ObjectBucketPlane?: WorkerdV2ObjectBucketPlane;
  /** Opt-in v2 KV binding service; grant is never on the tenant service. */
  readonly v2KvPlane?: WorkerdV2KvPlane;
  /** Opt-in v2 Queue producer service; not the handler settlement service. */
  readonly v2QueueProducerPlane?: WorkerdV2KvPlane;
}

/** One physical incarnation's exact identity for an app-authorized Actor drain. */
export interface WorkerdActorIncarnationRetirement {
  readonly workerResourceUid: string;
  readonly targetKey: string;
  readonly sourceOperationId: string;
  readonly incarnationId: string;
  readonly generation: string;
  readonly versions: readonly SelfhostWeightedVersion[];
  readonly retirementOperationId: string;
  /** Present for a directly executing DELETE; background groups use SQL's claim. */
  readonly retirementLeaseToken?: string;
}

/** The complete, atomically verified graph used by one native Actor owner. */
export interface WorkerdActiveActorGraph {
  readonly generation: string;
  readonly generationKey: string;
  readonly workerResourceUid: string;
  readonly versions: readonly (SelfhostWeightedVersion & {
    readonly variantKey: string;
    readonly site: WorkerdSite;
    readonly modules: ReadonlyMap<string, Uint8Array>;
    readonly hostModules: ReadonlyMap<string, Uint8Array>;
  })[];
}

/** The gate service one script receives its events through. */
export interface WorkerdEventGate {
  readonly module: string;
  readonly vars: readonly WorkerdBinding[];
}

/** The facade service one script's generated entrypoint calls. */
export interface WorkerdDataPlane {
  readonly address: string;
  readonly module: string;
  readonly vars: readonly WorkerdBinding[];
}

export interface WorkerdQueueSettlement {
  readonly address: string;
  readonly module: string;
  readonly vars: readonly WorkerdBinding[];
}

/** A per-Version v2 object service with one exact signed Worker grant. */
export interface WorkerdV2ObjectBucketPlane {
  readonly address: string;
  readonly token: string;
}

/** A per-Version private KV data-service route. */
export interface WorkerdV2KvPlane {
  readonly address: string;
  readonly token: string;
}
