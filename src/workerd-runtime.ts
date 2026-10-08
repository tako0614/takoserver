import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseActorAbiRef } from "./actor-abi-ref.ts";
import { isValidArtifactPath } from "./artifact-path.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import { bytesDigest } from "./json.ts";
import {
  SELFHOST_WORKER_DATA_PLANE_BINDING,
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
} from "./providers/selfhost-data-service.ts";
import { SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE } from "./providers/selfhost-v2-object-bucket-data-service.ts";
import {
  V2_QUEUE_SETTLEMENT_ORIGIN_BINDING,
  V2_QUEUE_SETTLEMENT_SERVICE_BINDING,
  V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
  V2_QUEUE_SETTLEMENT_TOKEN_BINDING,
} from "./providers/selfhost-v2-queue-transport.ts";
import { normalizeWorkflowBindings } from "./providers/selfhost-version-bindings.ts";
import { SELFHOST_WORKER_DATA_TOKEN_BINDING } from "./providers/selfhost-worker-wrapper.ts";
import {
  hasWorkerdV2PrivateBindingProfile,
  isWorkerdV2PrivateServiceBindingName,
  isWorkerdV2PrivateWorkflowBindingName,
  WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING,
  WORKERD_V2_PRIVATE_KV_BINDING,
  WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING,
  WORKERD_V2_PRIVATE_OBJECT_BUCKET_ORIGIN_BINDING,
  WORKERD_V2_PRIVATE_OBJECT_BUCKET_TOKEN_BINDING,
  WORKERD_V2_PRIVATE_QUEUE_PRODUCER_BINDING,
  WORKERD_V2_PRIVATE_QUEUE_SETTLEMENT_BINDING,
  WORKERD_V2_PRIVATE_READINESS_BINDING,
  WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
  workerdV2PrivateActorBindingName,
  workerdV2PrivateWorkflowBindingIndex,
  workerdV2PrivateWorkflowBindingName,
} from "./providers/workerd-v2-private-binding-names.ts";
import {
  canonicalSelfhostWeightedVersions,
  type SelfhostWeightedVersion,
  selectSelfhostWeightedVersion,
} from "./selfhost-weighted-deployment.ts";
import { TAKOFORM_MAXIMUM_STATIC_ASSET_BUNDLE_BYTES } from "./takoform/limits.ts";
import { createWorkerdWorkerModuleInspector } from "./workerd-worker-module-inspector.ts";

/**
 * The files and the configuration workerd runs from.
 *
 * The configuration is generated from what is on disk, every time, rather than
 * edited in place. That is the whole reliability story here: there is no state
 * to keep in step, so a process that dies mid-write leaves a directory that the
 * next reload reads correctly, and an operator who deletes a directory by hand
 * gets exactly what they asked for.
 *
 * Each published script gets a directory holding its modules and a small
 * manifest naming its entry point and hostnames. The manifest is written last,
 * so a directory without one is a half-written script and is skipped rather
 * than served — a script serving somebody's traffic from an incomplete upload
 * is worse than one that is not there yet.
 *
 * Routing is by `Host`, and only to hostnames a script claimed. An unclaimed
 * host gets a refusal rather than whichever script sorted first: answering one
 * customer's address with another customer's site is the failure worth
 * preventing, and it is silent when it happens.
 *
 * A script's environment variables are rendered into this configuration as
 * ordinary capnp bindings, because workerd has no separate notion of a secret:
 * a sensitive value looks exactly like a plain one here. That makes the
 * generated file itself the secret, so it is written `0600` inside a `0700`
 * directory, through a temporary file and a rename — a config half-written when
 * a process died must never be the one workerd picks up.
 */

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

/** Host-owned broker socket for one exact v2 caller Binding router. */
export interface WorkerdV2ServiceBindingBrokerSocket {
  readonly socketPath: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly uid: number;
  };
}

/** Media types workerd can use for a module declaration in this runtime. */
export type WorkerdModuleMediaType =
  | "application/javascript+module"
  | "text/plain"
  | "application/octet-stream"
  | "application/wasm";

interface WorkerdAssetDeclaration {
  readonly notFoundHandling: "none" | "single-page-application";
  readonly runWorkerFirst: boolean;
  /** Explicit v2 code+asset path grammar; omitted for legacy code sites. */
  readonly strictPaths?: true;
  /** Exact normalized media type for every logical asset path. */
  readonly mediaTypes: Readonly<Record<string, string>>;
}

interface WorkerdAssetManifestEntry {
  /** Operator-private flat filename, never a tenant-visible path. */
  readonly key: string;
  readonly mediaType: string;
  readonly size: number;
  readonly digest: `sha256:${string}`;
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

/** One immutable Workflow binding projection requested by the current graph. */
export interface WorkerdWorkflowForwardPublication {
  readonly script: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionResourceUid: string;
  readonly snapshotDigest: `sha256:${string}`;
  readonly bindings: readonly WorkerdWorkflowForwardBinding[];
}

/** Runtime lifecycle lease for the exact complete Workflow forwarding graph. */
export interface WorkerdWorkflowForwardLifecycle {
  reserve(
    publications: readonly WorkerdWorkflowForwardPublication[],
  ): Promise<{ release(): Promise<void> }>;
  /** Returns false unless this exact graph is still reserved and can be admitted. */
  activated(publications: readonly WorkerdWorkflowForwardPublication[]): boolean;
  /** Current factual readiness of the complete Workflow serving authority. */
  isRestored(): boolean;
  /** Revokes Workflow admission after a runtime transition whose result is unknown. */
  uncertain(): void;
}

/** Exact Host-owned broker socket for one immutable Workflow binding. */
export interface WorkerdWorkflowForwardSocket {
  readonly script: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionResourceUid: string;
  readonly snapshotDigest: `sha256:${string}`;
  readonly binding: WorkerdWorkflowForwardBinding;
  readonly socketPath: string;
}

export interface WorkerdActorForwardSocket {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  /** Present for exact per-Version brokers; absent only on legacy static mappings. */
  readonly token?: string;
  readonly httpSocketPath: string;
  readonly upgradeSocketPath: string;
}

/** Exact immutable publication identities handed to the Host-private Actor owner. */
export interface WorkerdActorForwardPublication {
  readonly script: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionResourceUid: string;
  readonly bindings: readonly WorkerdActorForwardBinding[];
}

interface WorkerdAssetManifest {
  readonly storageLayout: typeof WORKERD_ASSET_STORAGE_LAYOUT;
  readonly notFoundHandling: "none" | "single-page-application";
  readonly runWorkerFirst: boolean;
  readonly strictPaths?: true;
  /** Exact logical path to private physical key and declared media. */
  readonly files: Readonly<Record<string, WorkerdAssetManifestEntry>>;
}

interface WorkerdStoredModule {
  readonly name: string;
  /** Operator-private filename; logical module names never become paths. */
  readonly key: string;
  readonly size: number;
  readonly digest: `sha256:${string}`;
}

interface WorkerdModuleStorageManifest {
  readonly application: readonly WorkerdStoredModule[];
  readonly hostPrivate: readonly WorkerdStoredModule[];
}

export interface WorkerdSite {
  readonly kind?: never;
  /** Directory holding this script's modules. */
  readonly directory: string;
  readonly mainModule: string;
  /**
   * Host-private entrypoint that imports the exact application main.
   *
   * Its logical spelling may equal `mainModule`: provenance, not a reserved
   * filename, keeps the two identities distinct.
   */
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
  /**
   * How the Host-owned HTTP router composes this script with its asset lookup.
   * Absent means it declared no assets and public traffic reaches the script
   * directly. Neither service is projected into the tenant environment.
   */
  readonly assets?: WorkerdAssetDeclaration;
  /**
   * Environment entries for this script. Absent and empty both render nothing,
   * so a script that declares none produces the same bytes it always did.
   */
  readonly vars?: readonly WorkerdBinding[];
  /**
   * Modules to declare beside the main one, in order.
   *
   * workerd resolves an import against the module registry the configuration
   * builds, so a module that is on disk but not named here cannot be imported.
   * Absent renders exactly the single-module configuration it always did.
   */
  readonly modules?: readonly string[];
  /**
   * Exact media types for every module in `mainModule` plus `modules`.
   *
   * Absent keeps the historical `esModule` declaration for every module. When
   * present, every declared module must have one entry and every entry must
   * name a declared module; the runtime never guesses from a file extension.
   */
  readonly moduleMediaTypes?: Readonly<Record<string, WorkerdModuleMediaType>>;
  /**
   * The Host-owned facade service this script's generated entrypoint calls.
   *
   * Absent means this script binds no KV namespace and no SQLite database, and
   * renders exactly the configuration it always did. Present renders a second
   * service beside the script — its own module, its own bindings — and gives
   * the script a plain service binding to it. The token and the loopback
   * address are declared there and never on the script, because workerd hands
   * every binding of a service to every module that service runs.
   */
  readonly dataPlane?: WorkerdDataPlane;
  /**
   * The Host-owned gate a queue batch or a cron match reaches this script
   * through.
   *
   * Absent means nothing delivers events to this script, and it renders exactly
   * the configuration it always did. Present renders one more service beside
   * the script — its own module, its own token — and a route on a hostname of
   * this Host's own that reaches the gate and never the script. The gate is the
   * only holder of a binding that names the script's event entrypoint, so a
   * customer request at the script's own hostname reaches `fetch` and nothing
   * else.
   */
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

/** A module-less Worker Version served only by the Host-owned asset router. */
export interface WorkerdStaticSite {
  readonly kind: "static";
  readonly directory: string;
  readonly hostnames: readonly string[];
  readonly generation?: string;
  readonly workerResourceUid: string;
  readonly fetchHandler: false;
  readonly assets: WorkerdAssetDeclaration & { readonly runWorkerFirst: false };
  readonly mainModule?: never;
  readonly hostEntrypoint?: never;
  readonly modules?: never;
  readonly moduleMediaTypes?: never;
  readonly hostModules?: never;
  readonly vars?: never;
  readonly serviceBindings?: never;
  readonly actorForward?: never;
  readonly workflowForward?: never;
  readonly dataPlane?: never;
  readonly events?: never;
  readonly queueSettlement?: never;
  readonly v2ObjectBucketPlane?: never;
  readonly v2KvPlane?: never;
  readonly v2QueueProducerPlane?: never;
}

/** One exact private Version in a single logical Worker publication. */
export interface WorkerdDeploymentVariant<S extends WorkerdSite | WorkerdStaticSite = WorkerdSite>
  extends SelfhostWeightedVersion {
  /** Version-scoped runtime declaration. Its routes and Worker identity are owned above it. */
  readonly site: S;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly assets?: ReadonlyMap<string, Uint8Array>;
  readonly hostModules?: ReadonlyMap<string, Uint8Array>;
}

/** The complete graph a logical Worker activates in one runtime write. */
export interface WorkerdDeploymentPublication<
  S extends WorkerdSite | WorkerdStaticSite = WorkerdSite,
> {
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly hostnames: readonly string[];
  readonly versions: readonly WorkerdDeploymentVariant<S>[];
}

export type WorkerdMixedDeploymentPublication = WorkerdDeploymentPublication<
  WorkerdSite | WorkerdStaticSite
>;

/** The whole logical identity to compare with one proven serving publication. */
export interface WorkerdPublicationIdentity {
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly hostnames: readonly string[];
  readonly versions: readonly SelfhostWeightedVersion[];
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
  /** Present for a directly executing DELETE; background retired groups use SQL's current claim. */
  readonly retirementLeaseToken?: string;
}

/** Exact weighted identity behind the runtime's committed stable pointer. */
export interface WorkerdActiveDeployment {
  readonly generation: string;
  readonly versions: readonly SelfhostWeightedVersion[];
  /** Whether the committed graph contains the one logical event dispatcher. */
  readonly events: boolean;
}

/**
 * One exact Version selected from the active private weighted publication.
 *
 * The returned graph is caller-owned: module and asset bytes, bindings, and
 * every nested declaration are copied out of the operator-private durable
 * tree. No physical storage key or root is exposed to the caller.
 * This includes secrets: never log or persist it, or expose it through a
 * provider/status response. Retain it only for trusted child preparation and
 * release references after disposal; JavaScript strings are not zeroizable.
 */
export interface WorkerdSelectedActiveVersion<
  S extends WorkerdSite | WorkerdStaticSite = WorkerdSite,
> {
  readonly generation: string;
  readonly generationKey: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionUid: string;
  readonly site: S;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly hostModules: ReadonlyMap<string, Uint8Array>;
  readonly assets?: ReadonlyMap<string, Uint8Array>;
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
  /** Module inside the script's directory that implements the gate. */
  readonly module: string;
  /** Bindings for the gate alone; this is where the event token lives. */
  readonly vars: readonly WorkerdBinding[];
}

/** The facade service one script's entrypoint reaches its storage through. */
export interface WorkerdDataPlane {
  /** Loopback address of this Host's KV and SQL planes. */
  readonly address: string;
  /** Module inside the script's directory that implements the facade. */
  readonly module: string;
  /** Bindings for the facade service alone; this is where the token lives. */
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

/** The seam a provider publishes through: files present, config rewritten. */
export interface WorkerdRuntime<S extends WorkerdSite | WorkerdStaticSite = WorkerdSite> {
  /** Load one credential-free module snapshot in a fresh bounded runtime. */
  readonly inspectModule: ReturnType<typeof createWorkerdWorkerModuleInspector>["inspect"];
  /**
   * Pin this incarnation's fresh private Service socket directory before any
   * broker is allowed to create a socket inside it. Implementations without a
   * private Service socket directory may leave this absent.
   */
  preparePrivateServiceBindingSockets?(): Promise<void>;
  /**
   * Atomically activates one complete weighted deployment, or removes its
   * logical routes. Implementations without this capability must leave this
   * absent; a provider may then refuse weighted publication before mutation.
   */
  publish?(name: string, publication: WorkerdDeploymentPublication<S> | null): Promise<void>;
  /**
   * Resolve under this process's activation lock and refuse a lost caller fence.
   * The lock is not an interprocess writer fence; the owning composition must
   * keep one writer or supply its own independently proven exclusion.
   */
  publishFenced?(
    name: string,
    resolvePublication: (
      current: WorkerdPublicationIdentity | null,
    ) => Promise<WorkerdDeploymentPublication<S> | null>,
    isFenceCurrent: () => Promise<boolean>,
  ): Promise<void>;
  /** Atomically reserves Actor capacity, commits Provider state, and publishes. */
  publishActorDeployment?(
    name: string,
    publication: WorkerdDeploymentPublication<S>,
    commitDesiredState: () => Promise<void>,
  ): Promise<void>;
  /** Makes a published script's files present, replacing whatever was there. */
  write(
    name: string,
    site: WorkerdSite,
    modules: ReadonlyMap<string, Uint8Array>,
    assets?: ReadonlyMap<string, Uint8Array>,
    hostModules?: ReadonlyMap<string, Uint8Array>,
  ): Promise<void>;
  /** Forgets a script and its files. */
  remove(name: string): Promise<void>;
  /** Rewrites the configuration from every script currently published. */
  reload(): Promise<void>;
  /** Whether the requested generation is actually activated, for `observe`. */
  has(name: string, generation?: string): Promise<boolean>;
  /**
   * Read-only observation of this incarnation's exact served publication.
   * Unlike has(), a missing readiness marker is never evidence of absence.
   */
  observePublication?(
    name: string,
    subject?:
      | { readonly kind: "version"; readonly versionId: string }
      | { readonly kind: "hostname"; readonly hostname: string },
  ): Promise<"present" | "absent" | "unknown">;
  /** Compare a complete weighted identity, or prove absence when expected is null. */
  observeExactPublication?(
    name: string,
    expected: WorkerdPublicationIdentity | null,
  ): Promise<"matches" | "different" | "unknown">;
  /**
   * Asks one published script a question over the router this runtime serves.
   *
   * `null` means the runtime did not answer at all — it is not running, or it
   * is restarting on the configuration just written — which is a different
   * thing from a script that answered badly and must never be read as one.
   */
  probe?(
    name: string,
    path: string,
    init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      /** The exact body, when the question carries one. */
      readonly body?: string;
      /**
       * Which of this Host's own hostnames to ask on. `internal` reaches the
       * script itself and is what readiness uses; `events` reaches the gate in
       * front of it, which is the only way an event may enter.
       */
      readonly route?: "internal" | "events";
      /** null is reserved for an explicitly execution-scoped trusted invocation. */
      readonly timeoutMillis?: number | null;
      /** Owner cancellation means unknown delivery, never 0083 retirement. */
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<{ readonly status: number; readonly body: string } | null>;
}

/** Exact private selection, not provider desired state or caller-supplied bindings. */
export interface WorkerdSelectedVersionIdentity {
  readonly script: string;
  readonly generation: string;
  readonly generationKey: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionUid: string;
}

/** Secret-bearing execution capability; never log, persist or expose through a provider. */
export interface WorkerdPrivateServiceLease {
  readonly services: readonly {
    readonly name: string;
    readonly upstreamSocket: string;
    readonly unavailableToken: string;
  }[];
  /** Exact selected-incarnation Workflow brokers, pinned until child reap. */
  readonly workflowServices: readonly {
    readonly name: string;
    readonly publicName: string;
    readonly workflowResourceUid: string;
    readonly token: string;
    readonly snapshotDigest: `sha256:${string}`;
    readonly upstreamSocket: string;
  }[];
  /**
   * Release only before a child starts or after child/gateway reap and ingress
   * drain. Artifact removal is an independent cleanup obligation: its failure
   * must not retain an otherwise unused live service lease.
   * Idempotent and retry-safe: even a rejection after release took effect must
   * allow another call without releasing a different holder's pin.
   */
  release(): Promise<void>;
}

/**
 * Composition-owned lifecycle and private execution, not provider authority.
 * The composition restores the process and retains bindings for its children;
 * a provider only publishes through WorkerdRuntime.
 */
export interface HostedWorkerdRuntime extends WorkerdRuntime<WorkerdSite | WorkerdStaticSite> {
  /**
   * Brings the runtime back up for whatever is already published.
   *
   * Answers the names it restored, or nothing when this machine has published
   * no Worker — which is the case a boot must not start a runtime for. The
   * configuration is re-rendered from the durable manifests rather than trusted
   * as it stands, so a machine whose configuration was written by an older
   * build comes back on this one's router.
   */
  restore(): Promise<readonly string[]>;
  /**
   * Pin a captured caller's binding routers while targets follow the current
   * graph. Abort before acquisition rejects without waiting for queued reads;
   * an already acquired lease is returned for the caller's owned cleanup.
   */
  acquirePrivateServiceBindings(
    identity: WorkerdSelectedVersionIdentity,
    signal?: AbortSignal,
  ): Promise<WorkerdPrivateServiceLease>;
}

/**
 * The certificate this runtime's socket serves, when the operator configured
 * one.
 *
 * Both halves are PEM text — the private key and the leaf-first certificate
 * chain — and they are rendered into the generated configuration, which is
 * already written `0600` inside a `0700` directory because it carries every
 * script's environment. workerd terminates the TLS itself; there is no reverse
 * proxy in front of it and nothing else to keep in step.
 */
export interface WorkerdTlsKeypair {
  readonly privateKey: string;
  readonly certificateChain: string;
}

export interface WorkerdRuntimeOptions {
  /** Directory holding scripts and the generated configuration. */
  readonly root: string;
  /** Same binary selected by the serving supervisor; null makes inspection unavailable. */
  readonly binary?: string | null;
  /**
   * Where the generated config is written. Kept beside the scripts by default,
   * because workerd resolves an `embed` relative to the config's own
   * directory — an absolute path is not read, and the failure arrives as a
   * startup error naming a file that plainly exists.
   */
  readonly configPath?: string;
  /** Port the router listens on. */
  readonly port?: number;
  /** Current Host-owned loopback listener; persisted Versions retain their original metadata. */
  readonly dataPlaneAddress?: string;
  /**
   * Opt-in, existing operator-owned 0700 directory for private service sockets.
   * Must be canonical, non-symlinked and short enough for a 64-hex `.sock` name
   * within 100 bytes, outside root. It must be fresh and empty for this runtime
   * incarnation; its lifecycle follows the shared supervisor, not a run.
   * Requires immutable weighted publish(); legacy write()/remove() are refused.
   */
  readonly serviceBindingSocketDirectory?: string;
  /** Per-incarnation target-side proof for routing Service calls via its private alias. */
  readonly v2ServiceBindingDispatch?: {
    readonly token: string;
    readonly internalHostname: string;
  };
  /** Optional private cross-Worker bridge. It is consulted only for v2 Forms. */
  readonly v2ServiceBindingBrokerSocket?: (
    binding: WorkerdServiceBinding,
  ) => WorkerdV2ServiceBindingBrokerSocket | undefined;
  /** Static legacy snapshot or live owner graph, sampled once per render. */
  readonly actorForwardSockets?:
    | readonly WorkerdActorForwardSocket[]
    | (() => readonly WorkerdActorForwardSocket[]);
  /** Prepare sockets against the same closed graph this activation will render. */
  readonly actorForwardLifecycle?: {
    prepare(publications: readonly WorkerdActorForwardPublication[]): Promise<void>;
    reserve?(publications: readonly WorkerdActorForwardPublication[]): Promise<{
      release(): Promise<void>;
    }>;
    /** Called only after the exact activation marker is committed. Must not throw. */
    activated(publications: readonly WorkerdActorForwardPublication[]): void;
    /** An unproved activation cannot authorize any new Actor calls. Must not throw. */
    uncertain(): void;
  };
  /** Current Host-owned Workflow brokers for the exact immutable graph requested. */
  readonly workflowForwardSockets?: (
    publications: readonly WorkerdWorkflowForwardPublication[],
  ) => readonly WorkerdWorkflowForwardSocket[];
  /** Complete-graph admission lifecycle for private Workflow forwarding. */
  readonly workflowForwardLifecycle?: WorkerdWorkflowForwardLifecycle;
  /**
   * Terminates TLS on that port with this keypair. Absent means the socket is
   * plain HTTP, which is what the Host must then publish as the endpoint
   * address: advertising `https` for a socket that speaks `http` gives out an
   * address nothing answers on.
   */
  readonly tls?: WorkerdTlsKeypair;
  /** Refuse an unknown listener before touching any watched runtime file. */
  readonly beforeRender?: () => Promise<void>;
  /** Called after the config is rewritten, to make workerd read it. */
  readonly onReload?: (configPath: string) => Promise<void>;
  /** Runtime liveness/readiness truth for serving observations. */
  readonly isReady?: () => boolean;
}

interface Manifest {
  readonly mainModule: string;
  readonly hostEntrypoint?: string;
  readonly hostModules?: readonly string[];
  readonly moduleStorageLayout: typeof WORKERD_MODULE_STORAGE_LAYOUT;
  readonly moduleFiles: WorkerdModuleStorageManifest;
  readonly hostnames: readonly string[];
  readonly generation?: string;
  readonly workerResourceUid?: string;
  readonly fetchHandler?: boolean;
  readonly serviceBindings?: readonly WorkerdServiceBinding[];
  readonly actorForward?: WorkerdActorForward;
  readonly workflowForward?: WorkerdWorkflowForward;
  readonly assets?: WorkerdAssetManifest;
  readonly vars?: readonly WorkerdBinding[];
  readonly modules?: readonly string[];
  readonly moduleMediaTypes?: Readonly<Record<string, WorkerdModuleMediaType>>;
  readonly dataPlane?: WorkerdDataPlane;
  readonly events?: WorkerdEventGate;
  readonly queueSettlement?: WorkerdQueueSettlement;
  readonly v2ObjectBucketPlane?: WorkerdV2ObjectBucketPlane;
  readonly v2KvPlane?: WorkerdV2KvPlane;
  readonly v2QueueProducerPlane?: WorkerdV2KvPlane;
}

interface StaticManifest {
  readonly kind: "static";
  readonly hostnames: readonly string[];
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly fetchHandler: false;
  readonly assets: WorkerdAssetManifest;
  readonly mainModule?: never;
  readonly hostEntrypoint?: never;
  readonly hostModules?: never;
  readonly moduleStorageLayout?: never;
  readonly moduleFiles?: never;
  readonly serviceBindings?: never;
  readonly actorForward?: never;
  readonly workflowForward?: never;
  readonly vars?: never;
  readonly modules?: never;
  readonly moduleMediaTypes?: never;
  readonly dataPlane?: never;
  readonly events?: never;
  readonly queueSettlement?: never;
  readonly v2ObjectBucketPlane?: never;
  readonly v2KvPlane?: never;
  readonly v2QueueProducerPlane?: never;
}

type StoredManifest = Manifest | StaticManifest;

function isStaticManifest(manifest: StoredManifest): manifest is StaticManifest {
  return "kind" in manifest && manifest.kind === "static";
}

interface WorkerdDeploymentStoredVersion extends SelfhostWeightedVersion {
  readonly storageKey: string;
  readonly manifest: StoredManifest;
}

interface WorkerdDeploymentManifest {
  readonly publicationStorageLayout: typeof WORKERD_DEPLOYMENT_STORAGE_LAYOUT;
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly hostnames: readonly string[];
  readonly versions: readonly WorkerdDeploymentStoredVersion[];
}

interface WorkerdDeploymentPointer {
  readonly publicationStorageLayout: typeof WORKERD_DEPLOYMENT_STORAGE_LAYOUT;
  readonly generation: string;
  readonly generationKey: string;
}

const MANIFEST = "takoserver-site.json";
/**
 * The service binding a generated entrypoint reaches its facade through, and
 * the one the facade reaches the Bun planes through.
 *
 * Kept in step with the provider's own constants by name rather than by import:
 * this module is the runtime, and it must not depend on the provider that
 * publishes into it.
 */
const DATA_SERVICE_BINDING = "__TAKOSERVER_SELFHOST_DATA";
const DATA_PLANE_BINDING = "__TAKOSERVER_SELFHOST_DATA_PLANE";
/**
 * The gate's binding to the script's event entrypoint, and the named export it
 * addresses.
 *
 * Kept in step with the provider's constants by name for the same reason as
 * the two above: this module is the runtime, and it must not depend on the
 * provider that publishes into it.
 */
const EVENT_TARGET_BINDING = "__TAKOSERVER_SELFHOST_EVENT_TARGET";
const EVENT_ENTRYPOINT = "takoserverSelfhostEvents";
const SERVICE_UNAVAILABLE_TOKEN_BINDING = "UNAVAILABLE_TOKEN";
const PRIVATE_SERVICE_BINDING_TOKEN_HEADER = "x-takoserver-private-service-binding-token";
/**
 * Compatibility flags for a script published through a generated entrypoint.
 *
 * The module policy, rather than a source-language subset, decides what an
 * import may resolve. `disallow_importable_env` keeps the handler's bindings
 * out of the ambient cloudflare:workers export. The facade service is what
 * actually keeps Host tokens away from tenant code.
 */
const APPLICATION_COMPATIBILITY_FLAGS = ["disallow_importable_env"] as const;
/**
 * The hostname this Host asks a generated entrypoint its own questions on.
 *
 * A script is reachable through the router by `Host` and by nothing else, so a
 * publication that has not been given a customer hostname yet would be
 * unreachable — including to the readiness probe that decides whether it may be
 * published at all. `.invalid` can never be delegated, and the route is written
 * after the customer routes so a claimed custom domain cannot capture it.
 */
const INTERNAL_ROUTE_SUFFIX = ".selfhost-internal.invalid";
const INTERNAL_HOST_DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/**
 * The hostname this Host delivers a script's events on.
 *
 * Separate from the readiness one because they reach different services: the
 * readiness probe asks the script itself, and an event must never be able to.
 * Written after the customer routes for the same reason.
 */
const EVENT_ROUTE_SUFFIX = ".selfhost-events.invalid";
const CONFIG_PROBE_HOSTNAME = "runtime.selfhost-config.invalid";
const CONFIG_PROBE_PATH = "/.well-known/takoserver/selfhost-runtime-config/v1";
const CONFIG_PROBE_HEADER = "x-takoserver-selfhost-runtime-config";
const CONFIG_IDENTITY_HEADER = "x-takoserver-selfhost-config-identity";
const WORKER_READINESS_PATH = "/.well-known/takoserver/selfhost-worker-readiness/v1";
const WORKER_READINESS_HEADER = "x-takoserver-selfhost-readiness";
const WORKER_READINESS_PROTOCOL = "takoserver.selfhost-worker-readiness@v1";
const INTERNAL_READINESS_CAPABILITY_HEADER = "x-takoserver-selfhost-runtime-readiness";
const INTERNAL_READINESS_CAPABILITY_BINDING = "__TAKOSERVER_SELFHOST_RUNTIME_READINESS";
/** Operator-private sibling tree holding every script's flat static files. */
const ASSETS_ROOT_DIRECTORY = "assets";
/** Exact persisted meaning of the private physical asset keys. */
const WORKERD_ASSET_STORAGE_LAYOUT = "flat-ordinal-v1" as const;
/** Separate physical roots mirror the runtime's two module namespaces. */
const WORKERD_MODULE_STORAGE_LAYOUT = "provenance-v1" as const;
/** One immutable tree plus one stable, atomically replaced pointer. */
const WORKERD_DEPLOYMENT_STORAGE_LAYOUT = "weighted-deployment-v1" as const;
const DEPLOYMENT_MANIFEST = "deployment.json";
const DEPLOYMENT_PUBLICATIONS_DIRECTORY = ".publications";
const APPLICATION_MODULE_DIRECTORY = "application";
const HOST_PRIVATE_MODULE_DIRECTORY = "host-private";
const SERVICE_ROUTER_MODULE = "service-router.js";
const DEPLOYMENT_ROUTER_MODULE = "deployment-router.js";
const STATIC_READINESS_MODULE = "static-readiness.js";
const EVENT_DISPATCHER_MODULE = "event-dispatcher.js";
const SERVICE_UNAVAILABLE_HEADER = "x-takoserver-selfhost-service-unavailable";
/** Host-only Service transport metadata; the trusted router strips both headers. */
export const V2_SERVICE_BINDING_ORIGINAL_URL_HEADER = "x-takoserver-private-service-original-url";
export const V2_SERVICE_BINDING_DISPATCH_TOKEN_HEADER =
  "x-takoserver-private-service-dispatch-token";

function privateRuntimeToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createWorkerdRuntime(options: WorkerdRuntimeOptions): HostedWorkerdRuntime {
  const dynamicActorForwardSockets =
    typeof options.actorForwardSockets === "function" ? options.actorForwardSockets : undefined;
  const staticActorForwardSockets = dynamicActorForwardSockets
    ? undefined
    : validActorForwardSockets(
        options.actorForwardSockets as readonly WorkerdActorForwardSocket[] | undefined,
      );
  const actorForwardSockets = (): ReadonlyMap<string, WorkerdActorForwardSocket> =>
    staticActorForwardSockets ?? validActorForwardSockets(dynamicActorForwardSockets?.());
  const exactActorSockets = dynamicActorForwardSockets !== undefined;
  const serviceSocketDirectory = options.serviceBindingSocketDirectory;
  if (serviceSocketDirectory !== undefined) {
    validPrivateSocketDirectory(serviceSocketDirectory);
    const withinRoot = relative(resolve(options.root), serviceSocketDirectory);
    if (
      withinRoot === "" ||
      (!isAbsolute(withinRoot) && withinRoot !== ".." && !withinRoot.startsWith(`..${sep}`))
    ) {
      throw new Error("private service socket directory must be outside the runtime root");
    }
  }
  const dataPlaneAddress =
    options.dataPlaneAddress === undefined
      ? undefined
      : validDataPlaneAddress(options.dataPlaneAddress);
  const moduleInspector = createWorkerdWorkerModuleInspector({
    binary: options.binary ?? null,
    temporaryRoot: join(options.root, ".workerd-inspection"),
  });
  const scriptsRoot = join(options.root, "workers");
  // A sibling tree, not a reserved child of the tenant module tree: the
  // portable module grammar allows every child name, including `__assets`.
  const assetsRoot = join(options.root, ASSETS_ROOT_DIRECTORY);
  const configPath = options.configPath ?? join(scriptsRoot, "workerd.capnp");
  const port = options.port ?? 8788;
  const activationPath = join(scriptsRoot, ".takoserver-active.json");
  const configProbeToken = options.onReload === undefined ? "" : privateRuntimeToken();
  // Separate from config identity: this capability authorizes only the
  // Host-originated readiness path and is never bound into tenant code.
  const internalReadinessCapability = privateRuntimeToken();
  let activationTail: Promise<void> = Promise.resolve();
  const servicePins = new Map<
    string,
    { readonly binding: WorkerdServiceBinding; readonly v2Private: boolean; count: number }
  >();
  let renderedPrivateRouters = new Set<string>();
  let privateSocketRoot: PrivateSocketIdentity | undefined;
  const ownedPrivateSockets = new Map<string, PrivateSocketIdentity>();
  let pendingPrivateSockets: readonly string[] | undefined;
  let privateSocketTransition = 0;
  let privateSocketUncertain = false;

  const privateServiceGraph = (published: readonly PublishedDeployment[]) =>
    serviceSocketDirectory === undefined
      ? undefined
      : (() => {
          const bindings = collectServiceBindings(
            published,
            [...servicePins.values()].map((pin) => pin.binding),
          );
          const v2Routers = new Set(
            published.flatMap((deployment) =>
              deployment.variants.flatMap((variant) =>
                hasWorkerdV2PrivateBindingProfile(variant.manifest)
                  ? validServiceBindings(variant.manifest.serviceBindings ?? [], true).map(
                      workerdServiceBindingRouterName,
                    )
                  : [],
              ),
            ),
          );
          for (const [router, pin] of servicePins) {
            if (pin.v2Private) v2Routers.add(router);
          }
          const brokerSockets = new Map<string, WorkerdV2ServiceBindingBrokerSocket>();
          for (const [router, binding] of bindings) {
            if (!v2Routers.has(router)) continue;
            const socket = options.v2ServiceBindingBrokerSocket?.(binding);
            if (socket !== undefined) {
              validV2ServiceBindingBrokerSocket(socket);
              brokerSockets.set(router, {
                socketPath: socket.socketPath,
                identity: { ...socket.identity },
              });
            }
          }
          return {
            socketDirectory: serviceSocketDirectory,
            bindings,
            brokerSockets,
            v2PrivateRouters: v2Routers,
          };
        })();
  const retainRenderedRouters = (published: readonly PublishedDeployment[]) => {
    renderedPrivateRouters = new Set(privateServiceGraph(published)?.bindings.keys());
  };

  const requireCertainRuntime = (): void => {
    if (privateSocketUncertain) {
      throw new Error("private service runtime requires a fresh supervised incarnation");
    }
  };

  const clearFailedActivation = async (failure: unknown): Promise<void> => {
    renderedPrivateRouters.clear();
    try {
      await writeActivation(activationPath, {});
    } catch (clearFailure) {
      if (serviceSocketDirectory !== undefined) privateSocketUncertain = true;
      throw new AggregateError(
        [failure, clearFailure],
        "worker runtime activation could not be cleared",
      );
    }
  };

  const clearFailedActorActivation = async (failure: unknown): Promise<void> => {
    // Revoke admission first. Clearing the durable marker may itself fail, and
    // that failure must not leave private Actor brokers accepting old tokens.
    let notificationFailure: unknown;
    try {
      options.actorForwardLifecycle?.uncertain();
    } catch (error) {
      notificationFailure = error;
    }
    try {
      options.workflowForwardLifecycle?.uncertain();
    } catch (error) {
      notificationFailure =
        notificationFailure === undefined
          ? error
          : new AggregateError([notificationFailure, error], "runtime admission revocation failed");
    }
    try {
      await clearFailedActivation(failure);
    } catch (clearFailure) {
      if (notificationFailure !== undefined)
        throw new AggregateError(
          [failure, notificationFailure, clearFailure],
          "worker runtime Actor admission and activation could not be cleared",
        );
      throw clearFailure;
    }
    if (notificationFailure !== undefined)
      throw new AggregateError(
        [failure, notificationFailure],
        "worker runtime Actor admission could not be cleared",
      );
  };

  const requireSocketRoot = async (): Promise<void> => {
    if (serviceSocketDirectory === undefined) return;
    requireCertainRuntime();
    const metadata = await requirePrivateSocketDirectory(serviceSocketDirectory);
    if (privateSocketRoot === undefined) {
      if ((await readdir(serviceSocketDirectory)).length !== 0) {
        throw new Error("private service socket directory must be fresh and empty");
      }
      privateSocketRoot = metadata;
    } else if (!samePrivateSocketIdentity(privateSocketRoot, metadata)) {
      throw new Error("private service socket directory was replaced");
    }
  };

  // Capture only the graph being proved. An unproved reload may still create
  // listeners later: its paths must never be swept by an automatic rollback.
  const capturePrivateSockets = async (): Promise<boolean> => {
    if (pendingPrivateSockets === undefined) return true;
    await requireSocketRoot();
    let complete = true;
    for (const path of pendingPrivateSockets) {
      const metadata = await privateSocketMetadata(path);
      if (metadata === undefined) {
        if (ownedPrivateSockets.has(path)) throw new Error("private service socket disappeared");
        complete = false;
        continue;
      }
      const owned = ownedPrivateSockets.get(path);
      if (owned && !samePrivateSocketIdentity(owned, metadata)) {
        throw new Error("private service socket was replaced");
      }
      ownedPrivateSockets.set(path, metadata);
    }
    if (complete) pendingPrivateSockets = undefined;
    return complete;
  };

  const transitionPrivateSockets = async (published: readonly PublishedDeployment[]) => {
    if (serviceSocketDirectory === undefined) return;
    await requireSocketRoot();
    const next = [...(privateServiceGraph(published)?.bindings.keys() ?? [])].map((router) =>
      privateServiceSocket(serviceSocketDirectory, router),
    );
    // Validate the whole set before disrupting a single old listener. Never
    // adopt a pre-existing path merely because it has the right filename.
    for (const [path, owned] of ownedPrivateSockets) {
      const metadata = await privateSocketMetadata(path);
      if (metadata === undefined || !samePrivateSocketIdentity(owned, metadata)) {
        throw new Error("private service socket was replaced");
      }
    }
    for (const path of next) {
      if (!ownedPrivateSockets.has(path) && (await privateSocketMetadata(path)) !== undefined) {
        throw new Error("private service socket path is already occupied");
      }
    }
    privateSocketTransition += 1;
    for (const [path, owned] of ownedPrivateSockets) {
      // Recheck immediately before unlink; the directory excludes other UIDs.
      const metadata = await privateSocketMetadata(path);
      if (metadata === undefined || !samePrivateSocketIdentity(owned, metadata)) {
        throw new Error("private service socket was replaced");
      }
      await unlink(path);
      ownedPrivateSockets.delete(path);
    }
    pendingPrivateSockets = next;
  };

  /** Shared config and activation truth have one commit order across scripts. */
  const exclusiveActivation = <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = activationTail;
    const next = queued.then(operation, operation);
    activationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const scriptDirectory = (name: string): string => {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(name)) {
      throw new Error(`unusable script name: ${name}`);
    }
    return join(scriptsRoot, name);
  };
  const assetDirectory = (name: string): string => {
    scriptDirectory(name);
    return join(assetsRoot, name);
  };

  /**
   * Rewrites everything derived from the durable manifests, then makes workerd
   * read it.
   *
   * Named because two callers need exactly this and must not diverge: a publish,
   * and a boot bringing an already-published machine back up. A boot that
   * re-rendered by some other route would be the second place the router, the
   * asset shim and the socket are decided.
   */
  const prepareWorkflowForwardGraph = async (
    publications: readonly WorkerdWorkflowForwardPublication[],
    allowUnservedEmpty = false,
  ): Promise<PreparedWorkflowForwardGraph> => {
    const lifecycle = options.workflowForwardLifecycle;
    if (!lifecycle || !options.workflowForwardSockets) {
      throw new Error("Workflow forward lifecycle unavailable");
    }
    if (!allowUnservedEmpty && (options.onReload === undefined || options.isReady === undefined)) {
      throw new Error("Workflow forward serving proof unavailable");
    }
    const requested = Object.freeze([...publications]);
    await options.beforeRender?.();
    const lease = await lifecycle.reserve(requested);
    try {
      const workflowSockets = copyWorkflowForwardSockets(options.workflowForwardSockets(requested));
      validateWorkflowForwardSockets(requested, workflowSockets);
      return { publications: requested, sockets: workflowSockets, lease };
    } catch (failure) {
      await lease.release();
      throw failure;
    }
  };

  const workflowSocketSnapshot = async (
    published: readonly PublishedDeployment[],
    prepared?: PreparedWorkflowForwardGraph,
  ): Promise<WorkflowForwardRuntimeGraph> => {
    if (!prepared) await options.beforeRender?.();
    const publications = workflowForwardPublications(published);
    if (
      prepared !== undefined &&
      workflowForwardPublicationGraphIdentity(publications) !==
        workflowForwardPublicationGraphIdentity(prepared.publications)
    ) {
      throw new Error("Workflow forward publication changed after reservation");
    }
    const workflowSockets =
      prepared !== undefined
        ? prepared.sockets
        : copyWorkflowForwardSockets(options.workflowForwardSockets?.(publications));
    const services = resolveWorkflowForwardServices(published, publications, workflowSockets);
    return { publications, sockets: workflowSockets, services };
  };

  const writeRendered = async (
    published: readonly PublishedDeployment[],
    workflowGraph: WorkflowForwardRuntimeGraph,
    assertFence?: () => Promise<void>,
  ): Promise<void> => {
    await options.actorForwardLifecycle?.prepare(actorForwardPublications(published));
    await assertFence?.();
    const actorSockets = actorForwardSockets();
    if (serviceSocketDirectory !== undefined) {
      await requireSocketRoot();
    }
    await privateDirectory(scriptsRoot);
    for (const entry of published) await privateDirectory(join(scriptsRoot, entry.name));
    const assetPublications = published
      .filter((candidate) => !candidate.weighted)
      .flatMap((candidate) => candidate.variants)
      .filter((candidate) => candidate.manifest.assets);
    if (assetPublications.length > 0) {
      await privateDirectory(assetsRoot);
      for (const entry of assetPublications) await privateDirectory(assetDirectory(entry.name));
    }
    // Materialize the current Host helpers before the config that embeds them.
    // Identical helper writes would trigger --watch before the config/socket
    // transition. These sources are constant for this Host incarnation.
    const immutableHelpers = serviceSocketDirectory !== undefined && privateSocketTransition > 0;
    await writeRuntimeModule(join(scriptsRoot, "router.js"), ROUTER_SOURCE, immutableHelpers);
    await writeRuntimeModule(join(scriptsRoot, "assets.js"), ASSETS_SOURCE, immutableHelpers);
    await writeRuntimeModule(
      join(scriptsRoot, "asset-router.js"),
      ASSET_ROUTER_SOURCE,
      immutableHelpers,
    );
    await writeRuntimeModule(
      join(scriptsRoot, SERVICE_ROUTER_MODULE),
      SERVICE_ROUTER_SOURCE,
      immutableHelpers,
    );
    await writeRuntimeModule(
      join(scriptsRoot, DEPLOYMENT_ROUTER_MODULE),
      DEPLOYMENT_ROUTER_SOURCE,
      immutableHelpers,
    );
    if (
      published.some((entry) =>
        entry.variants.some((variant) => isStaticManifest(variant.manifest)),
      )
    ) {
      await writeRuntimeModule(
        join(scriptsRoot, STATIC_READINESS_MODULE),
        STATIC_READINESS_SOURCE,
        immutableHelpers,
      );
    }
    await writeRuntimeModule(
      join(scriptsRoot, EVENT_DISPATCHER_MODULE),
      EVENT_DISPATCHER_SOURCE,
      immutableHelpers,
    );
    await privateDirectory(dirname(configPath));
    await assertFence?.();
    const privateServices = privateServiceGraph(published);
    await verifyV2ServiceBindingBrokerSockets(privateServices);
    // The rendered configuration contains every binding value, sensitive ones
    // included, so it is created `0600` and moved into place atomically.
    await writePrivate(
      configPath,
      renderConfig(
        published,
        port,
        assetsRoot,
        options.tls,
        configProbeToken,
        internalReadinessCapability,
        dataPlaneAddress,
        privateServices,
        actorSockets,
        exactActorSockets,
        workflowGraph.services,
        options.v2ServiceBindingDispatch,
      ),
      "utf8",
      () => transitionPrivateSockets(published),
    );
    await verifyV2ServiceBindingBrokerSockets(privateServices);
  };

  const activated = (published: readonly PublishedDeployment[]) =>
    Object.fromEntries(published.map((entry) => [entry.name, entry.generation ?? null]));

  const renderedConfirmed = async (
    published: readonly PublishedDeployment[],
    workflowGraph: WorkflowForwardRuntimeGraph,
  ): Promise<boolean> => {
    const actorSockets = actorForwardSockets();
    const privateServices = privateServiceGraph(published);
    const expected = publishedGraphIdentity(
      published,
      privateServices,
      actorSockets,
      exactActorSockets,
      workflowGraph.services,
      options.v2ServiceBindingDispatch,
    );
    let confirmed = false;
    try {
      await verifyV2ServiceBindingBrokerSockets(privateServices);
      const response = await fetch(
        `${options.tls ? "https" : "http"}://127.0.0.1:${port}${CONFIG_PROBE_PATH}`,
        {
          method: "POST",
          headers: {
            host: CONFIG_PROBE_HOSTNAME,
            [CONFIG_PROBE_HEADER]: configProbeToken,
          },
          ...(options.tls ? { tls: { rejectUnauthorized: false } } : {}),
          signal: AbortSignal.timeout(1_000),
        },
      );
      confirmed =
        response.status === 204 && response.headers.get(CONFIG_IDENTITY_HEADER) === expected;
    } catch {
      // The watcher may still be crossing to the atomically replaced file.
    }
    return confirmed && (await capturePrivateSockets());
  };

  const proveRendered = async (
    published: readonly PublishedDeployment[],
    workflowGraph: WorkflowForwardRuntimeGraph,
  ): Promise<void> => {
    // A composition with no process hook intentionally stages files only. It
    // cannot prove serving truth, but `has()` will still fail closed unless its
    // composition supplies a live `isReady` probe.
    if (options.onReload === undefined) return;
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (await renderedConfirmed(published, workflowGraph)) return;
      if (Date.now() >= deadline) {
        throw new Error("worker runtime did not confirm the rendered configuration");
      }
      await new Promise<void>((wake) => setTimeout(wake, 25));
    }
  };

  /**
   * Moves the complete configuration, runtime process, stable publication
   * pointer, and activation truth as one recoverable transaction.
   *
   * `onReload` is an arbitrary process boundary: a throw does not prove that a
   * watching workerd ignored the new config. The default topology restores the
   * prior graph and proves that second crossing. Private Unix listeners instead
   * require a fresh supervised incarnation after an unproved transition: a
   * rollback could race sockets bound late by the first reload. Only a proved
   * private graph may roll back after a later commit failure. Uncertain
   * activation truth is cleared rather than fabricated.
   */
  const activate = async (
    published: readonly PublishedDeployment[],
    previous: readonly PublishedDeployment[],
    pointer?: {
      readonly commit: () => Promise<void>;
      readonly rollback: () => Promise<void>;
      readonly commitAfterActivation?: boolean;
    },
    preparedWorkflow?: PreparedWorkflowForwardGraph,
    assertFence?: () => Promise<void>,
  ): Promise<void> => {
    requireCertainRuntime();
    let workflowGraph: WorkflowForwardRuntimeGraph;
    try {
      // Resolve the complete candidate before changing activation truth. Reuse
      // this exact socket locator result for rendering and readback.
      workflowGraph = await workflowSocketSnapshot(published, preparedWorkflow);
    } catch (failure) {
      // A same-generation restore has no older candidate to preserve. Do not
      // leave a prior process's marker as current truth when its graph cannot
      // be revalidated in this runtime incarnation.
      if (JSON.stringify(activated(previous)) === JSON.stringify(activated(published))) {
        await clearFailedActorActivation(failure);
      }
      throw failure;
    }
    const initialSocketTransition = privateSocketTransition;
    let graphProved = false;
    let workflowAdmissionRejected = false;
    let effectStarted = false;
    try {
      const before = activated(previous);
      const after = activated(published);
      const transitioning = new Set([...Object.keys(before), ...Object.keys(after)]);
      const indeterminate = { ...before };
      let changed = false;
      for (const name of transitioning) {
        if (before[name] === after[name]) continue;
        delete indeterminate[name];
        changed = true;
      }
      // A watcher may begin serving the new config before its stable pointer
      // commits. Clear only the changing scripts first so an external event
      // selector cannot mistake either side of that crossing for committed.
      await assertFence?.();
      effectStarted = true;
      if (changed) await writeActivation(activationPath, indeterminate);
      await assertFence?.();
      await writeRendered(published, workflowGraph, assertFence);
      await assertFence?.();
      await options.onReload?.(configPath);
      await proveRendered(published, workflowGraph);
      graphProved = options.onReload !== undefined;
      if (assertFence && options.isReady?.() !== true) {
        throw new Error("worker runtime is not ready");
      }
      await assertFence?.();
      if (!pointer?.commitAfterActivation) await pointer?.commit();
      await assertFence?.();
      await writeActivation(activationPath, activated(published));
      await assertFence?.();
      // Retiring a validated scalar carrier is the final fallible operation.
      // Its absence must not precede a marker write that could still fail.
      if (pointer?.commitAfterActivation) await pointer.commit();
      await assertFence?.();
      retainRenderedRouters(published);
      options.actorForwardLifecycle?.activated(actorForwardPublications(published));
      if (
        options.workflowForwardLifecycle &&
        options.workflowForwardLifecycle.activated(workflowGraph.publications) !== true
      ) {
        workflowAdmissionRejected = true;
        throw new Error("Workflow forward graph could not be admitted");
      }
      await assertFence?.();
      if (assertFence && options.isReady?.() !== true) {
        throw new Error("worker runtime is not ready");
      }
    } catch (failure) {
      if (!effectStarted) throw failure;
      if (workflowAdmissionRejected) {
        if (serviceSocketDirectory !== undefined) privateSocketUncertain = true;
        await clearFailedActorActivation(failure);
        throw failure;
      }
      if (
        serviceSocketDirectory !== undefined &&
        initialSocketTransition === privateSocketTransition
      ) {
        // Preflight failed before any socket unlink or config rename. Do not
        // disrupt the old listeners by trying a second render of an unknown
        // filesystem. No pointer commit has happened; refuse serving claims.
        await clearFailedActorActivation(failure);
        throw failure;
      }
      if (serviceSocketDirectory !== undefined && !graphProved) {
        // A timed-out/throwing reload can still bind listeners after this
        // catch. Only external stop/reap and a fresh runtime/socket directory
        // can recover it; do not race that process with a rollback sweep.
        privateSocketUncertain = true;
        await clearFailedActorActivation(failure);
        throw failure;
      }
      try {
        await pointer?.rollback();
        // Re-render the exact prior graph with this process's private probe
        // token. A config left by an earlier Host instance contains that
        // instance's token, so restoring its bytes would make an otherwise
        // successful rollback impossible for this process to authenticate.
        const previousPreparedWorkflow = options.workflowForwardLifecycle
          ? await prepareWorkflowForwardGraph(workflowForwardPublications(previous))
          : undefined;
        try {
          const previousWorkflowGraph = await workflowSocketSnapshot(
            previous,
            previousPreparedWorkflow,
          );
          await writeRendered(previous, previousWorkflowGraph);
          await options.onReload?.(configPath);
          await proveRendered(previous, previousWorkflowGraph);
          // The graph just proved is the authority. A marker captured before
          // this call may be stale after a crash between pointer commit and
          // marker commit, especially during boot restore.
          await writeActivation(activationPath, activated(previous));
          retainRenderedRouters(previous);
          options.actorForwardLifecycle?.activated(actorForwardPublications(previous));
          if (
            options.workflowForwardLifecycle &&
            options.workflowForwardLifecycle.activated(previousWorkflowGraph.publications) !== true
          ) {
            throw new Error("prior Workflow forward graph could not be admitted");
          }
        } finally {
          await previousPreparedWorkflow?.lease.release();
        }
      } catch (rollbackFailure) {
        // The child may now be serving either graph. No per-script marker is
        // trustworthy across a failed process boundary, so fail closed for
        // the whole runtime rather than claiming a rollback that was not seen.
        if (serviceSocketDirectory !== undefined) privateSocketUncertain = true;
        const unknownState = new AggregateError(
          [failure, rollbackFailure],
          "worker runtime activation state is unknown",
        );
        await clearFailedActorActivation(unknownState);
        throw unknownState;
      }
      throw failure;
    }
  };

  const stageDeployment = async (
    name: string,
    publication: WorkerdMixedDeploymentPublication,
  ): Promise<{
    readonly pointer: WorkerdDeploymentPointer;
    readonly deployment: PublishedDeployment;
  }> => {
    scriptDirectory(name);
    if (typeof publication.generation !== "string") {
      throw new Error("unusable worker deployment generation");
    }
    capnpText(publication.generation);
    const workerResourceUid = validWorkerResourceUid(publication.workerResourceUid);
    const hostnames = validDeploymentHostnames(publication.hostnames);
    internalHostname(name);
    eventHostname(name);
    if (!Array.isArray(publication.versions)) {
      throw new Error("unusable weighted worker deployment");
    }
    const canonical = canonicalSelfhostWeightedVersions(
      publication.versions.map(({ versionId, workerVersionUid, weight }) => ({
        versionId,
        workerVersionUid,
        weight,
      })),
    );
    const byUid = new Map(
      publication.versions.map((version) => [version.workerVersionUid, version]),
    );
    const preparedVersions: Array<{
      readonly identity: SelfhostWeightedVersion;
      readonly storageKey: string;
      readonly prepared: PreparedWorkerdSite;
    }> = [];
    // This loop is deliberately complete before the first mkdir/write. A bad
    // second Version must not stage state for the first one.
    for (let index = 0; index < canonical.length; index += 1) {
      const identity = canonical[index] as SelfhostWeightedVersion;
      const variant = byUid.get(identity.workerVersionUid);
      if (
        !variant ||
        variant.versionId !== identity.versionId ||
        variant.weight !== identity.weight
      ) {
        throw new Error("unusable weighted worker deployment");
      }
      if (
        variant.site.hostnames.length !== 0 ||
        (variant.site.generation !== undefined &&
          variant.site.generation !== publication.generation) ||
        (variant.site.workerResourceUid !== undefined &&
          variant.site.workerResourceUid !== workerResourceUid)
      ) {
        throw new Error("unusable private worker Version declaration");
      }
      const prepared = await prepareWorkerdSite(
        {
          ...variant.site,
          hostnames: [],
          generation: publication.generation,
          workerResourceUid,
        },
        variant.modules,
        variant.assets,
        variant.hostModules,
      );
      if (!isStaticManifest(prepared.manifest) && !prepared.manifest.hostEntrypoint) {
        throw new Error("weighted worker Versions require a Host entrypoint");
      }
      preparedVersions.push({
        identity,
        storageKey: `version-${index.toString(10).padStart(5, "0")}`,
        prepared,
      });
    }
    const eventShapes = new Set(
      preparedVersions.map(({ prepared }) => prepared.manifest.events !== undefined),
    );
    if (eventShapes.size > 1) {
      throw new Error("weighted worker Versions require one event capability shape");
    }
    const v2QueueShapes = new Set(
      preparedVersions.map(({ prepared }) => prepared.manifest.queueSettlement !== undefined),
    );
    if (v2QueueShapes.size > 1 || (v2QueueShapes.has(true) && !eventShapes.has(true))) {
      throw new Error("weighted worker Versions require one v2 Queue capability shape");
    }
    const manifest: WorkerdDeploymentManifest = {
      publicationStorageLayout: WORKERD_DEPLOYMENT_STORAGE_LAYOUT,
      generation: publication.generation,
      workerResourceUid,
      hostnames,
      versions: preparedVersions.map(({ identity, storageKey, prepared }) => ({
        ...identity,
        storageKey,
        manifest: prepared.manifest,
      })),
    };
    const manifestJson = JSON.stringify(manifest);
    const generationKey = createHash("sha256").update(manifestJson, "utf8").digest("hex");
    const publicationRoot = join(scriptsRoot, DEPLOYMENT_PUBLICATIONS_DIRECTORY, name);
    const generationRoot = join(publicationRoot, generationKey);
    const existing = await lstat(generationRoot).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("unusable worker deployment snapshot");
      }
      const current = await readFile(join(generationRoot, DEPLOYMENT_MANIFEST), "utf8");
      if (current !== manifestJson) throw new Error("conflicting worker deployment snapshot");
    } else {
      await privateDirectory(join(scriptsRoot, DEPLOYMENT_PUBLICATIONS_DIRECTORY));
      await privateDirectory(publicationRoot);
      const staging = join(publicationRoot, `.tmp-${crypto.randomUUID()}`);
      try {
        await privateDirectory(staging);
        for (const version of preparedVersions) {
          await writePreparedWorkerdSite(join(staging, version.storageKey), version.prepared);
        }
        await writePrivate(join(staging, DEPLOYMENT_MANIFEST), manifestJson, "utf8");
        await rename(staging, generationRoot);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const pointer: WorkerdDeploymentPointer = {
      publicationStorageLayout: WORKERD_DEPLOYMENT_STORAGE_LAYOUT,
      generation: publication.generation,
      generationKey,
    };
    // Re-open every stored byte and manifest through the restart reader before
    // this generation is eligible to enter a config.
    const deployment = await readWeightedDeployment(scriptsRoot, name, pointer);
    return { pointer, deployment };
  };

  return {
    inspectModule: (input) => moduleInspector.inspect(input),
    ...(serviceSocketDirectory === undefined
      ? {}
      : { preparePrivateServiceBindingSockets: async () => await requireSocketRoot() }),
    acquirePrivateServiceBindings(identity, signal) {
      // Copy before entering the queue so a caller cannot change the requested
      // identity while another publication owns the activation lock.
      const requested = { ...identity };
      let leaseAcquired = false;
      const pending = exclusiveActivation(async () => {
        signal?.throwIfAborted();
        const unavailable = () =>
          new Error("private execution service binding bridge is unavailable");
        if (
          serviceSocketDirectory === undefined ||
          options.onReload === undefined ||
          options.isReady?.() !== true
        ) {
          throw unavailable();
        }
        await requireSocketRoot();
        const active = await readWorkerdActiveDeployment(options.root, requested.script);
        if (!active || active.generation !== requested.generation) throw unavailable();
        let basisPoint = 0;
        let found = false;
        for (const version of active.versions) {
          if (
            version.versionId === requested.versionId &&
            version.workerVersionUid === requested.workerVersionUid
          ) {
            found = true;
            break;
          }
          basisPoint += version.weight;
        }
        if (!found) throw unavailable();
        const selected = await readWorkerdSelectedActiveVersion(options.root, requested.script, {
          expectedWorkerResourceUid: requested.workerResourceUid,
          basisPoint,
        });
        if (
          !selected ||
          selected.generation !== requested.generation ||
          selected.generationKey !== requested.generationKey ||
          selected.workerResourceUid !== requested.workerResourceUid ||
          selected.versionId !== requested.versionId ||
          selected.workerVersionUid !== requested.workerVersionUid ||
          options.isReady?.() !== true
        ) {
          throw unavailable();
        }
        // Binding declarations come only from the authenticated immutable
        // manifest. The caller cannot supply a different target or token.
        const bindings = validServiceBindings(
          selected.site.serviceBindings ?? [],
          hasWorkerdV2PrivateBindingProfile(selected.site),
        );
        const routers = bindings.map(workerdServiceBindingRouterName);
        if (routers.some((router) => !renderedPrivateRouters.has(router))) throw unavailable();
        for (const router of routers) {
          const path = privateServiceSocket(serviceSocketDirectory, router);
          const owned = ownedPrivateSockets.get(path);
          const metadata = await privateSocketMetadata(path);
          if (!owned || !metadata || !samePrivateSocketIdentity(owned, metadata)) {
            throw unavailable();
          }
        }
        let workflowReservation: { release(): Promise<void> } | undefined;
        let workflowServices: WorkerdPrivateServiceLease["workflowServices"] = [];
        try {
          if (selected.site.workflowForward?.schema === V2_WORKFLOW_FORWARD_SCHEMA) {
            const lifecycle = options.workflowForwardLifecycle;
            if (!lifecycle || !options.workflowForwardSockets || !lifecycle.isRestored()) {
              throw unavailable();
            }
            const forward = validWorkflowForward(
              selected.site.workflowForward,
              hasWorkerdV2PrivateBindingProfile(selected.site),
              selected.site.hostEntrypoint === WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
            );
            if (forward.schema !== V2_WORKFLOW_FORWARD_SCHEMA) throw unavailable();
            const published = await readPublished(scriptsRoot, assetsRoot);
            const deployment = published.find(
              (entry) =>
                entry.name === requested.script &&
                entry.weighted &&
                entry.generation === requested.generation &&
                entry.workerResourceUid === requested.workerResourceUid,
            );
            const variant = deployment?.variants.find(
              (entry) =>
                entry.versionId === requested.versionId &&
                entry.workerVersionUid === requested.workerVersionUid,
            );
            if (!variant || variant.manifest.workflowForward === undefined) throw unavailable();
            const publications = workflowForwardPublications(published);
            const selectedPublication = publications.find(
              (entry) =>
                entry.script === requested.script &&
                entry.workerResourceUid === requested.workerResourceUid &&
                entry.versionId === requested.versionId &&
                entry.workerVersionResourceUid === requested.workerVersionUid &&
                entry.snapshotDigest === forward.snapshotDigest,
            );
            if (
              !selectedPublication ||
              JSON.stringify(selectedPublication.bindings) !== JSON.stringify(forward.bindings)
            ) {
              throw unavailable();
            }
            workflowReservation = await lifecycle.reserve([selectedPublication]);
            if (!lifecycle.isRestored()) throw unavailable();
            const workflowGraph = await workflowSocketSnapshot(published);
            if (!(await renderedConfirmed(published, workflowGraph))) throw unavailable();
            const sockets = validateWorkflowForwardSockets(
              workflowGraph.publications,
              workflowGraph.sockets,
            );
            const mapped = await Promise.all(
              selectedPublication.bindings.map(async (binding) => {
                if ("workflowFormRef" in binding) throw unavailable();
                const socket = sockets.get(
                  workflowForwardSocketIdentity({ ...selectedPublication, binding }),
                );
                if (!socket) throw unavailable();
                await requirePrivateSocketDirectory(dirname(socket.socketPath));
                const before = await privateSocketMetadata(socket.socketPath);
                if (!before) throw unavailable();
                return {
                  name: binding.serviceName,
                  publicName: binding.publicName,
                  workflowResourceUid: binding.workflowResourceUid,
                  token: binding.token,
                  snapshotDigest: selectedPublication.snapshotDigest,
                  upstreamSocket: socket.socketPath,
                  before,
                };
              }),
            );
            for (const entry of mapped) {
              const after = await privateSocketMetadata(entry.upstreamSocket);
              if (!after || !samePrivateSocketIdentity(entry.before, after)) throw unavailable();
            }
            if (!lifecycle.isRestored() || options.isReady?.() !== true) throw unavailable();
            workflowServices = mapped.map(({ before: _before, ...entry }) => entry);
          }
        } catch (error) {
          await workflowReservation?.release();
          throw error;
        }
        let released = false;
        const lease: WorkerdPrivateServiceLease = {
          services: bindings.map((binding) => ({
            name: binding.name,
            upstreamSocket: privateServiceSocket(
              serviceSocketDirectory,
              workerdServiceBindingRouterName(binding),
            ),
            unavailableToken: binding.unavailableToken,
          })),
          workflowServices,
          release: () =>
            exclusiveActivation(async () => {
              if (released) return;
              await workflowReservation?.release();
              released = true;
              for (const router of routers) {
                const pin = servicePins.get(router);
                if (!pin) continue;
                pin.count -= 1;
                if (pin.count === 0) servicePins.delete(router);
              }
              // No child can hold the socket after this lifecycle barrier. Lazy
              // pruning avoids a shared-graph reload for every completed run.
            }),
        };
        // Build paths and the complete lease before the synchronous pin
        // commit. No fallible service mapping or await can lose a new pin.
        const additions = bindings.map((binding) => ({
          binding,
          router: workerdServiceBindingRouterName(binding),
        }));
        try {
          signal?.throwIfAborted();
        } catch (error) {
          await workflowReservation?.release();
          throw error;
        }
        for (const { binding, router } of additions) {
          const existing = servicePins.get(router);
          if (existing) existing.count += 1;
          else
            servicePins.set(router, {
              binding,
              v2Private: hasWorkerdV2PrivateBindingProfile(selected.site),
              count: 1,
            });
        }
        leaseAcquired = true;
        return lease;
      });
      if (!signal) return pending;
      return new Promise<WorkerdPrivateServiceLease>((resolve, reject) => {
        const onAbort = (): void => {
          if (leaseAcquired) return;
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        // Retain both handlers after an early abort. If the synchronous pin
        // commit already happened, deliver its lease rather than losing it to
        // an abort race; preparation observes abort and owns the release.
        void pending.then(
          (lease) => {
            signal.removeEventListener("abort", onAbort);
            resolve(lease);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    },
    async publish(
      name,
      publication,
      commitDesiredState?: () => Promise<void>,
      fenced?: {
        readonly resolve: (
          current: WorkerdPublicationIdentity | null,
        ) => Promise<WorkerdMixedDeploymentPublication | null>;
        readonly assert: () => Promise<void>;
      },
    ) {
      requireCertainRuntime();
      const directory = scriptDirectory(name);
      if (fenced && (options.onReload === undefined || options.isReady === undefined)) {
        throw new Error("fenced worker publication requires serving proof");
      }
      if (
        commitDesiredState &&
        (publication === null ||
          !publication.versions.some((version) => version.site.actorForward !== undefined))
      )
        throw new Error("Actor-qualified publication has no Actor binding");
      const pointerPath = join(directory, MANIFEST);
      const removePointer = async (): Promise<void> => {
        await rm(pointerPath, { force: true });
        try {
          // An empty carrier is not a partial publication. Remove it without
          // touching retained generations or a nonempty, incomplete script.
          await rmdir(directory);
        } catch (error) {
          const code = (error as { readonly code?: unknown }).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        }
      };
      // Without private sockets, immutable generation staging can proceed in
      // parallel for different Workers. The shared graph snapshot/commit is
      // always serialized so two valid publishes cannot each render a graph
      // missing the other. Private staging also shares the uncertainty fence.
      const concurrentStaged =
        fenced ||
        publication === null ||
        serviceSocketDirectory !== undefined ||
        commitDesiredState ||
        options.workflowForwardLifecycle !== undefined
          ? null
          : await stageDeployment(name, publication);
      await exclusiveActivation(async () => {
        requireCertainRuntime();
        await fenced?.assert();
        const previous = await readPublished(scriptsRoot, assetsRoot);
        if (fenced) {
          await fenced.assert();
          const carrier = await lstat(pointerPath).catch((error: unknown) => {
            if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
            throw error;
          });
          if (carrier && !previous.some((entry) => entry.name === name)) {
            throw new Error("current worker publication cannot be read");
          }
          publication = await fenced.resolve(
            exactPublishedIdentity(previous.find((entry) => entry.name === name)),
          );
          await fenced.assert();
        }
        let reservation: { release(): Promise<void> } | undefined;
        let preparedWorkflow: PreparedWorkflowForwardGraph | undefined;
        try {
          if (options.workflowForwardLifecycle) {
            const targetWorkflowPublications = [
              ...workflowForwardPublications(previous).filter((item) => item.script !== name),
              ...workflowForwardPublicationsForInput(name, publication),
            ].sort((left, right) => left.script.localeCompare(right.script));
            // Workflow capacity and exact sockets are secured against the
            // complete candidate before Actor CAS or any immutable staging.
            preparedWorkflow = await prepareWorkflowForwardGraph(targetWorkflowPublications);
          }
          if (commitDesiredState && publication) {
            const actorPublication = publication;
            if (!options.actorForwardLifecycle?.reserve)
              throw new Error("Actor forward capacity reservation unavailable");
            const proposed = actorPublication.versions.flatMap((version) =>
              version.site.actorForward === undefined
                ? []
                : [
                    {
                      script: name,
                      workerResourceUid: actorPublication.workerResourceUid,
                      versionId: version.versionId,
                      workerVersionResourceUid: version.workerVersionUid,
                      bindings: validActorForward(
                        version.site.actorForward,
                        hasWorkerdV2PrivateBindingProfile(version.site),
                      ).bindings,
                    },
                  ],
            );
            // Keep the existing Actor lease and the Workflow lease together
            // across Provider CAS and exact publication.
            reservation = await options.actorForwardLifecycle.reserve([
              ...actorForwardPublications(previous).filter((item) => item.script !== name),
              ...proposed,
            ]);
          }
          await commitDesiredState?.();
          await fenced?.assert();
          // Private publication staging shares the uncertain-state fence. It
          // cannot keep writing after another activation invalidates this Host.
          const staged =
            (fenced ||
              serviceSocketDirectory !== undefined ||
              commitDesiredState ||
              options.workflowForwardLifecycle !== undefined) &&
            publication !== null
              ? await stageDeployment(name, publication)
              : concurrentStaged;
          const beforePointer = await readFile(pointerPath, "utf8").catch(() => null);
          await fenced?.assert();
          const next = (
            staged === null
              ? previous.filter((entry) => entry.name !== name)
              : [...previous.filter((entry) => entry.name !== name), staged.deployment]
          ).sort((left, right) => left.name.localeCompare(right.name));
          const pointerContents = staged === null ? null : JSON.stringify(staged.pointer);
          const retiringScalar =
            staged === null && previous.some((entry) => entry.name === name && !entry.weighted);
          let retiredCarrier: string | undefined;
          if (retiringScalar) {
            // Only the fully validated runtime publication authorizes this move.
            // Provider desired state may already have cleared its legacy scalar.
            // Retain the modules for recovery; legacy assets keep their old path
            // so an in-flight request can still read them after graph replacement.
            const retainedRoot = join(scriptsRoot, ".retired");
            await privateDirectory(retainedRoot);
            retiredCarrier = join(await mkdtemp(join(retainedRoot, `${name}-`)), "publication");
          }
          let retirementCommitted = false;
          try {
            await activate(
              next,
              previous,
              {
                ...(retiredCarrier === undefined ? {} : { commitAfterActivation: true }),
                commit: async () => {
                  if (retiredCarrier !== undefined) {
                    await rename(directory, retiredCarrier);
                    retirementCommitted = true;
                    return;
                  }
                  if (pointerContents === null) {
                    await removePointer();
                  } else {
                    await privateDirectory(directory);
                    await writePrivate(pointerPath, pointerContents, "utf8");
                  }
                },
                rollback: async () => {
                  // A failed scalar retirement leaves its original carrier in place;
                  // no operation follows a successful rename that could need rollback.
                  if (retiredCarrier !== undefined) return;
                  if (beforePointer === null) {
                    await removePointer();
                  } else {
                    await privateDirectory(directory);
                    await writePrivate(pointerPath, beforePointer, "utf8");
                  }
                },
              },
              preparedWorkflow,
              fenced?.assert,
            );
          } catch (failure) {
            if (retiredCarrier !== undefined && !retirementCommitted) {
              // This operation created the private staging parent. Failed
              // attempts must not accumulate it; committed recovery bytes stay.
              try {
                await rm(dirname(retiredCarrier), { recursive: true, force: true });
              } catch (cleanupFailure) {
                throw new AggregateError(
                  [failure, cleanupFailure],
                  "worker retirement staging cleanup failed",
                );
              }
            }
            throw failure;
          }
        } finally {
          try {
            await reservation?.release();
          } finally {
            await preparedWorkflow?.lease.release();
          }
        }
        // Lease release is awaited after activation. If authority is lost in
        // that tail, the prior pointer cannot be rolled back through activate's
        // transaction. Revoke serving claims and report uncertainty instead.
        if (fenced) {
          try {
            await fenced.assert();
          } catch (failure) {
            await clearFailedActorActivation(failure);
            throw failure;
          }
        }
      });
    },
    async publishFenced(name, resolvePublication, isFenceCurrent) {
      const assert = async (): Promise<void> => {
        if (!(await isFenceCurrent())) throw new Error("worker publication fence lost");
      };
      await (
        this.publish as (
          name: string,
          publication: WorkerdMixedDeploymentPublication | null,
          commit: undefined,
          fenced: {
            readonly resolve: (
              current: WorkerdPublicationIdentity | null,
            ) => Promise<WorkerdMixedDeploymentPublication | null>;
            readonly assert: () => Promise<void>;
          },
        ) => Promise<void>
      )(name, null, undefined, { resolve: resolvePublication, assert });
    },
    async publishActorDeployment(name, publication, commitDesiredState) {
      // The ordinary publish entry remains the same two-argument public port;
      // only this qualified method can supply the private commit callback.
      await (
        this.publish as (
          name: string,
          publication: WorkerdMixedDeploymentPublication,
          commit: () => Promise<void>,
        ) => Promise<void>
      )(name, publication, commitDesiredState);
    },
    async write(name, site, modules, assets, hostModules) {
      requireCertainRuntime();
      if (serviceSocketDirectory !== undefined) {
        throw new Error("private service runtime requires immutable weighted publication");
      }
      const directory = scriptDirectory(name);
      // Validate the declaration before removing the currently serving
      // directory. A bad media map is a rejected publication, not a reason to
      // destroy the last known-good bytes.
      const mainModule = validModules([site.mainModule])[0] as string;
      const declaredModules = validModules(site.modules ?? [], site.mainModule);
      const moduleMediaTypes = validModuleMediaTypes(
        mainModule,
        declaredModules,
        site.moduleMediaTypes,
      );
      const hostEntrypoint =
        site.hostEntrypoint === undefined
          ? undefined
          : (validModules([site.hostEntrypoint])[0] as string);
      const declaredHostModules = validHostModuleNames(site, hostEntrypoint);
      const applicationSnapshot = await snapshotModuleBytes(
        modules,
        [mainModule, ...declaredModules],
        "application",
      );
      const hostSnapshot = await snapshotModuleBytes(
        hostModules ?? new Map(),
        declaredHostModules,
        "Host-private",
      );
      const assetDeclaration = await validAssets(site.assets, assets);
      const workerResourceUid =
        site.workerResourceUid === undefined
          ? undefined
          : validWorkerResourceUid(site.workerResourceUid);
      if (
        (workerResourceUid === undefined) !== (site.fetchHandler === undefined) ||
        (site.fetchHandler !== undefined && typeof site.fetchHandler !== "boolean")
      ) {
        throw new Error("unusable worker service identity");
      }
      const serviceBindings = validServiceBindings(
        site.serviceBindings ?? [],
        hasWorkerdV2PrivateBindingProfile(site),
      );
      if (serviceBindings.length > 0 && workerResourceUid === undefined) {
        throw new Error("unusable worker service binding");
      }
      const actorForward =
        site.actorForward === undefined
          ? undefined
          : validActorForward(site.actorForward, hasWorkerdV2PrivateBindingProfile(site));
      const workflowForward =
        site.workflowForward === undefined
          ? undefined
          : validWorkflowForward(
              site.workflowForward,
              hasWorkerdV2PrivateBindingProfile(site),
              site.hostEntrypoint === WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
            );
      const v2ObjectBucketPlane =
        site.v2ObjectBucketPlane === undefined
          ? undefined
          : validV2ObjectBucketPlane(site.v2ObjectBucketPlane);
      const v2KvPlane = site.v2KvPlane === undefined ? undefined : validV2KvPlane(site.v2KvPlane);
      const v2QueueProducerPlane =
        site.v2QueueProducerPlane === undefined
          ? undefined
          : validV2KvPlane(site.v2QueueProducerPlane);
      if (v2ObjectBucketPlane && !hasWorkerdV2PrivateBindingProfile(site)) {
        throw new Error("v2 ObjectBucket service requires the private v2 Worker profile");
      }
      if (v2KvPlane && !hasWorkerdV2PrivateBindingProfile(site)) {
        throw new Error("v2 KV service requires the private v2 Worker profile");
      }
      if (v2QueueProducerPlane && !hasWorkerdV2PrivateBindingProfile(site)) {
        throw new Error("v2 Queue producer service requires the private v2 Worker profile");
      }
      validActorForwardCollision(
        actorForward,
        validBindings(site.vars ?? []),
        serviceBindings,
        hostEntrypoint,
        hasWorkerdV2PrivateBindingProfile(site),
      );
      validWorkflowForwardCollision(
        workflowForward,
        validBindings(site.vars ?? []),
        serviceBindings,
        actorForward,
        hostEntrypoint,
        hasWorkerdV2PrivateBindingProfile(site),
      );
      if (workflowForward !== undefined) {
        throw new Error("Workflow forward requires an immutable weighted publication");
      }
      // Replaced rather than merged: a module the new bundle does not contain
      // must not survive from the old one, where it would be loadable and
      // wrong.
      await rm(directory, { recursive: true, force: true });
      await rm(assetDirectory(name), { recursive: true, force: true });
      await privateDirectory(scriptsRoot);
      await privateDirectory(directory);
      const applicationDirectory = join(directory, APPLICATION_MODULE_DIRECTORY);
      const hostDirectory = join(directory, HOST_PRIVATE_MODULE_DIRECTORY);
      await privateDirectory(applicationDirectory);
      if (declaredHostModules.length > 0) await privateDirectory(hostDirectory);
      if (assetDeclaration) {
        await privateDirectory(assetsRoot);
        await privateDirectory(assetDirectory(name));
      }

      for (const entry of applicationSnapshot.entries) {
        await writeFile(join(applicationDirectory, entry.key), entry.bytes);
      }
      for (const entry of hostSnapshot.entries) {
        await writeFile(join(hostDirectory, entry.key), entry.bytes);
      }

      for (const [assetName, bytes] of assetDeclaration?.entries ?? []) {
        const path = join(assetDirectory(name), assetName);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }

      // Written last. Until it exists the directory is not a script. It now
      // carries binding values, so it is written with the same `0600` care as
      // the configuration rendered from it.
      await writePrivate(
        join(directory, MANIFEST),
        JSON.stringify({
          mainModule: site.mainModule,
          ...(hostEntrypoint === undefined ? {} : { hostEntrypoint }),
          ...(site.hostModules && site.hostModules.length > 0
            ? { hostModules: [...site.hostModules] }
            : {}),
          moduleStorageLayout: WORKERD_MODULE_STORAGE_LAYOUT,
          moduleFiles: {
            application: applicationSnapshot.manifest,
            hostPrivate: hostSnapshot.manifest,
          },
          hostnames: site.hostnames,
          ...(site.generation === undefined ? {} : { generation: site.generation }),
          ...(workerResourceUid === undefined ? {} : { workerResourceUid }),
          ...(site.fetchHandler === undefined ? {} : { fetchHandler: site.fetchHandler }),
          ...(serviceBindings.length > 0 ? { serviceBindings } : {}),
          ...(actorForward === undefined ? {} : { actorForward }),
          ...(assetDeclaration ? { assets: assetDeclaration.configuration } : {}),
          ...(site.vars && site.vars.length > 0 ? { vars: validBindings(site.vars) } : {}),
          ...(site.modules && site.modules.length > 0 ? { modules: declaredModules } : {}),
          ...(moduleMediaTypes ? { moduleMediaTypes } : {}),
          ...(site.dataPlane ? { dataPlane: validDataPlane(site.dataPlane) } : {}),
          ...(site.events ? { events: validEventGate(site.events) } : {}),
          ...(site.queueSettlement
            ? { queueSettlement: validQueueSettlement(site.queueSettlement) }
            : {}),
          ...(v2ObjectBucketPlane === undefined ? {} : { v2ObjectBucketPlane }),
          ...(v2KvPlane === undefined ? {} : { v2KvPlane }),
          ...(v2QueueProducerPlane === undefined ? {} : { v2QueueProducerPlane }),
        }),
        "utf8",
      );
    },

    async remove(name) {
      requireCertainRuntime();
      if (serviceSocketDirectory !== undefined) {
        throw new Error("private service runtime requires immutable weighted publication");
      }
      await rm(scriptDirectory(name), { recursive: true, force: true });
      await rm(assetDirectory(name), { recursive: true, force: true });
    },

    async has(name, generation) {
      return await exclusiveActivation(async () => {
        if (privateSocketUncertain) return false;
        const active = await readActivation(activationPath);
        if (!(name in active)) return false;
        if (generation !== undefined && active[name] !== generation) return false;
        // A marker only records the generation the last successful reload
        // attempted to activate. Without an explicit process-readiness probe
        // there is no runtime truth to distinguish staged files from serving
        // traffic, so fail closed and discard the marker.
        let workflowRestored = true;
        try {
          workflowRestored =
            options.workflowForwardLifecycle === undefined ||
            options.workflowForwardLifecycle.isRestored() === true;
        } catch {
          workflowRestored = false;
        }
        if (options.isReady === undefined || !options.isReady() || !workflowRestored) {
          // A dead child or failed boot invalidates the activation marker.
          // Serialize this read-modify-write with graph activation so it
          // cannot erase a generation another publication just committed.
          const next = { ...active };
          delete next[name];
          await writeActivation(activationPath, next);
          return false;
        }
        return true;
      });
    },

    async observePublication(name, subject) {
      return await exclusiveActivation(async () => {
        scriptDirectory(name);
        if (
          privateSocketUncertain ||
          options.onReload === undefined ||
          options.isReady === undefined ||
          !options.isReady()
        ) {
          return "unknown";
        }
        try {
          // The private probe token is unique to this runtime incarnation.
          // A stale activation marker, a previous Host process, and a graph
          // still serving after a failed reload cannot answer for it.
          const published = await readPublished(scriptsRoot, assetsRoot);
          const publications = workflowForwardPublications(published);
          const sockets = copyWorkflowForwardSockets(
            options.workflowForwardSockets?.(publications),
          );
          const workflowGraph = {
            publications,
            sockets,
            services: resolveWorkflowForwardServices(published, publications, sockets),
          };
          if (!(await renderedConfirmed(published, workflowGraph))) return "unknown";
          if (privateSocketUncertain || !options.isReady()) return "unknown";
          const entry = published.find((candidate) => candidate.name === name);
          if (!entry) return "absent";
          if (subject?.kind === "hostname") {
            return entry.hostnames.includes(subject.hostname) ? "present" : "absent";
          }
          if (subject?.kind === "version") {
            if (entry.weighted) {
              return entry.variants.some((variant) => variant.versionId === subject.versionId)
                ? "present"
                : "absent";
            }
            // Retained scalar publications have no weighted Version list.
            // Their generated, graph-bound generation records activeVersion;
            // older opaque generations cannot identify a Version safely.
            let scalar: unknown;
            try {
              scalar = JSON.parse(entry.generation ?? "");
            } catch {
              return "unknown";
            }
            if (
              typeof scalar !== "object" ||
              scalar === null ||
              Array.isArray(scalar) ||
              !("activeVersion" in scalar) ||
              (scalar.activeVersion !== null && typeof scalar.activeVersion !== "string")
            ) {
              return "unknown";
            }
            return scalar.activeVersion === subject.versionId ? "present" : "absent";
          }
          return "present";
        } catch {
          return "unknown";
        }
      });
    },

    async observeExactPublication(name, expected) {
      // Validate caller identity before treating any mismatch as factual absence.
      scriptDirectory(name);
      if (expected !== null) capnpText(expected.generation);
      const requested =
        expected === null
          ? null
          : {
              generation: expected.generation,
              workerResourceUid: validWorkerResourceUid(expected.workerResourceUid),
              hostnames: [...validDeploymentHostnames(expected.hostnames)].sort(),
              versions: canonicalSelfhostWeightedVersions(expected.versions),
            };
      return await exclusiveActivation(async () => {
        if (
          privateSocketUncertain ||
          options.onReload === undefined ||
          options.isReady?.() !== true
        ) {
          return "unknown";
        }
        try {
          const published = await readPublished(scriptsRoot, assetsRoot);
          const publications = workflowForwardPublications(published);
          const sockets = copyWorkflowForwardSockets(
            options.workflowForwardSockets?.(publications),
          );
          const workflowGraph = {
            publications,
            sockets,
            services: resolveWorkflowForwardServices(published, publications, sockets),
          };
          if (!(await renderedConfirmed(published, workflowGraph))) return "unknown";
          if (privateSocketUncertain || options.isReady() !== true) return "unknown";
          const entry = published.find((candidate) => candidate.name === name);
          const active = await readActivationStrict(activationPath);
          if (active[name] !== (entry?.generation ?? undefined)) return "unknown";
          if (requested === null) return entry === undefined ? "matches" : "different";
          if (!entry) return "different";
          if (!entry.weighted) return "different";
          const current = exactPublishedIdentity(entry);
          return current?.generation === requested.generation &&
            current.workerResourceUid === requested.workerResourceUid &&
            JSON.stringify(current.hostnames) === JSON.stringify(requested.hostnames) &&
            JSON.stringify(current.versions) === JSON.stringify(requested.versions)
            ? "matches"
            : "different";
        } catch {
          return "unknown";
        }
      });
    },

    async probe(name, path, init) {
      if (privateSocketUncertain) return null;
      let hostname: string;
      try {
        hostname = init.route === "events" ? eventHostname(name) : internalHostname(name);
      } catch {
        return null;
      }
      try {
        const headers = new Headers(init.headers);
        // The public `probe` shape does not grant callers a way to inject this
        // internal capability. Only the exact readiness question on the
        // Host-owned route receives it; event and arbitrary internal probes
        // have any same-named input stripped.
        headers.delete(INTERNAL_READINESS_CAPABILITY_HEADER);
        if (
          init.route !== "events" &&
          init.method === "POST" &&
          path === WORKER_READINESS_PATH &&
          headers.get(WORKER_READINESS_HEADER) === WORKER_READINESS_PROTOCOL
        ) {
          headers.set(INTERNAL_READINESS_CAPABILITY_HEADER, internalReadinessCapability);
        }
        headers.set("host", hostname);
        // This Host asking its own runtime, over loopback, by address. Where the
        // socket terminates TLS the certificate names the endpoint suffix and
        // not `127.0.0.1`, so verifying it here would refuse every publication
        // on a correctly configured machine; the connection never leaves this
        // host and the answer is authenticated by the publication it names.
        const response = await fetch(
          `${options.tls ? "https" : "http"}://127.0.0.1:${port}${path}`,
          {
            method: init.method,
            headers,
            ...(init.body === undefined ? {} : { body: init.body }),
            ...(options.tls ? { tls: { rejectUnauthorized: false } } : {}),
            // Readiness has a 2s default. A trusted Queue invocation may opt
            // into no Host deadline because SQL 0083, not a fetch timeout,
            // owns handler lifetime and maxConcurrency.
            ...(init.timeoutMillis === null
              ? init.abortSignal
                ? { signal: init.abortSignal }
                : {}
              : {
                  signal: init.abortSignal
                    ? AbortSignal.any([
                        init.abortSignal,
                        AbortSignal.timeout(init.timeoutMillis ?? 2_000),
                      ])
                    : AbortSignal.timeout(init.timeoutMillis ?? 2_000),
                }),
          },
        );
        // Bounded because the answer is this Host's own small envelope and the
        // body on the other side of that router is a tenant's Worker.
        const body = (await response.text()).slice(0, 65_536);
        if (privateSocketUncertain) return null;
        return { status: response.status, body };
      } catch {
        return null;
      }
    },

    async restore() {
      // The one question a boot has to ask before starting anything: is there a
      // Worker on this machine at all. Rendering an empty configuration and
      // starting a runtime for it would give every machine a workerd it never
      // asked for, which is exactly what deferring the start to the first
      // publish was avoiding.
      return await exclusiveActivation(async () => {
        try {
          requireCertainRuntime();
          const published = await readPublished(scriptsRoot, assetsRoot);
          if (published.length === 0) {
            // Empty boot has no workerd process, but the owned Actor broker
            // graph has still been reconstructed and proven empty. This is a
            // successful immutable restore, not a serving-readiness signal.
            options.actorForwardLifecycle?.activated([]);
            if (options.workflowForwardLifecycle) {
              const emptyWorkflow = await prepareWorkflowForwardGraph([], true);
              try {
                if (
                  options.workflowForwardLifecycle.activated(emptyWorkflow.publications) !== true
                ) {
                  throw new Error("empty Workflow forward graph could not be admitted");
                }
              } finally {
                await emptyWorkflow.lease.release();
              }
            }
            return [];
          }
          const preparedWorkflow = options.workflowForwardLifecycle
            ? await prepareWorkflowForwardGraph(workflowForwardPublications(published))
            : undefined;
          try {
            await activate(published, published, undefined, preparedWorkflow);
          } finally {
            await preparedWorkflow?.lease.release();
          }
          return published.map((entry) => entry.name);
        } catch (error) {
          options.actorForwardLifecycle?.uncertain();
          options.workflowForwardLifecycle?.uncertain();
          throw error;
        }
      });
    },

    async reload() {
      await exclusiveActivation(async () => {
        requireCertainRuntime();
        const published = await readPublished(scriptsRoot, assetsRoot);
        const preparedWorkflow = options.workflowForwardLifecycle
          ? await prepareWorkflowForwardGraph(workflowForwardPublications(published))
          : undefined;
        try {
          await activate(published, published, undefined, preparedWorkflow);
        } finally {
          await preparedWorkflow?.lease.release();
        }
      });
    },
  };
}

/**
 * Creates a file only this process's user can read, then moves it into place.
 *
 * `O_EXCL` plus `O_NOFOLLOW` means an attacker who can create paths in the
 * directory cannot pre-place a symlink and have the secret written through it,
 * and the rename means a reader never observes a partially written config.
 */
async function writePrivate(
  path: string,
  contents: string,
  encoding: "utf8",
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let closed = false;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, encoding);
    await handle.sync();
    await handle.close();
    closed = true;
    await beforeRename?.();
    await rename(temporary, path);
  } finally {
    if (!closed) await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeRuntimeModule(
  path: string,
  contents: string,
  immutable: boolean,
): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === contents) return;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (immutable)
    throw new Error("private service runtime helpers require a fresh supervised incarnation");
  await writeFile(path, contents, "utf8");
}

/**
 * A directory this process is willing to keep a secret in.
 *
 * `mkdir(mode)` is a no-op on a directory that already exists, so a tree
 * created by an earlier version of this Host — or by an operator's `mkdir -p` —
 * keeps whatever mode it was made with, and the `0o700` above is silently not
 * applied. These directories hold rendered binding values and the manifests
 * they were rendered from, so the mode is tightened and then re-read: a
 * directory this process cannot make private is one it refuses to publish into,
 * rather than one it publishes into and hopes about.
 */
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
  if (((await stat(path)).mode & 0o077) !== 0) {
    throw new Error(`refusing to publish into a group- or world-accessible directory: ${path}`);
  }
}

/**
 * The environment names workerd will accept from here.
 *
 * The union is deliberately the union of what the two declarations upstream can
 * produce: a Worker Version's `vars` keys and the sensitive names a runtime
 * input carries. A name outside it is refused rather than rewritten — a mangled
 * binding is a variable the module silently cannot find, which is worse than a
 * publication that stops and says so.
 */
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,127}$/u;
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u;
const INTERNAL_SERVICE_BINDING = /^__TAKOSERVER_SELFHOST_SERVICE_[0-9]{5}$/u;
const SERVICE_UNAVAILABLE_TOKEN = /^[0-9a-f]{64}$/u;
const ACTOR_FORWARD_SCHEMA = "takoserver.selfhost-actor-forward@v1" as const;
const ACTOR_FORWARD_PUBLIC_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const ACTOR_FORWARD_TOKEN = /^[a-f0-9]{64}$/u;
const WORKFLOW_FORWARD_SCHEMA = "takoserver.selfhost-workflow-binding-forward@v1" as const;
const V2_WORKFLOW_FORWARD_SCHEMA = "takoserver.v2-workflow-binding-forward@1" as const;
const WORKFLOW_FORWARD_PUBLIC_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const WORKFLOW_FORWARD_SERVICE_NAME = /^__TAKOSERVER_WORKFLOW_BINDING_[0-9]{5}$/u;
const WORKFLOW_FORWARD_TOKEN = /^[a-f0-9]{64}$/u;
const ACTOR_FORWARD_MANIFEST_KEYS = new Set([
  "mainModule",
  "hostEntrypoint",
  "hostModules",
  "moduleStorageLayout",
  "moduleFiles",
  "hostnames",
  "generation",
  "workerResourceUid",
  "fetchHandler",
  "serviceBindings",
  "actorForward",
  "workflowForward",
  "assets",
  "vars",
  "modules",
  "moduleMediaTypes",
  "dataPlane",
  "events",
  "queueSettlement",
  "v2ObjectBucketPlane",
  "v2KvPlane",
  "v2QueueProducerPlane",
]);

function actorForwardServiceName(
  kind: "HTTP" | "UPGRADE",
  index: number,
  v2PrivateNames = false,
): string {
  if (v2PrivateNames) return workerdV2PrivateActorBindingName(kind, index);
  return `__TAKOSERVER_ACTOR_${kind}_${index.toString(10).padStart(5, "0")}`;
}

function actorForwardIdentity(
  tenantId: string,
  namespaceResourceUid: string,
  token?: string,
): string {
  return JSON.stringify(
    token === undefined
      ? [tenantId, namespaceResourceUid]
      : [tenantId, namespaceResourceUid, token],
  );
}

function validActorForward(value: unknown, v2PrivateNames = false): WorkerdActorForward {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "bindings,schema"
  )
    throw new Error("unusable Actor forward graph");
  const candidate = value as WorkerdActorForward;
  if (
    candidate.schema !== ACTOR_FORWARD_SCHEMA ||
    !Array.isArray(candidate.bindings) ||
    candidate.bindings.length === 0 ||
    candidate.bindings.length > 64
  )
    throw new Error("unusable Actor forward graph");
  const names = new Set<string>();
  const bindings = candidate.bindings.map((binding, index) => {
    const fields =
      typeof binding === "object" && binding !== null && !Array.isArray(binding)
        ? Object.keys(binding).sort().join(",")
        : "";
    if (
      typeof binding !== "object" ||
      binding === null ||
      Array.isArray(binding) ||
      (fields !== "httpService,namespaceResourceUid,publicName,tenantId,token,upgradeService" &&
        fields !==
          "httpService,namespaceResourceUid,publicName,runtimeClassRef,tenantId,token,upgradeService") ||
      typeof binding.publicName !== "string" ||
      !ACTOR_FORWARD_PUBLIC_NAME.test(binding.publicName) ||
      names.has(binding.publicName) ||
      typeof binding.tenantId !== "string" ||
      binding.tenantId.length === 0 ||
      binding.tenantId.length > 256 ||
      binding.tenantId.includes("\u0000") ||
      typeof binding.namespaceResourceUid !== "string" ||
      !RESOURCE_UID.test(binding.namespaceResourceUid) ||
      binding.httpService !== actorForwardServiceName("HTTP", index, v2PrivateNames) ||
      binding.upgradeService !== actorForwardServiceName("UPGRADE", index, v2PrivateNames) ||
      typeof binding.token !== "string" ||
      !ACTOR_FORWARD_TOKEN.test(binding.token)
    )
      throw new Error("unusable Actor forward graph");
    names.add(binding.publicName);
    capnpText(binding.publicName);
    capnpText(binding.tenantId);
    capnpText(binding.namespaceResourceUid);
    const declaredRef = binding.runtimeClassRef;
    if (fields === "httpService,namespaceResourceUid,publicName,tenantId,token,upgradeService")
      return { ...binding };
    const selected = parseActorAbiRef(declaredRef);
    if (selected?.kind !== "v2") throw new Error("unusable Actor forward graph");
    return {
      ...binding,
      runtimeClassRef: selected.ref,
    };
  });
  return { schema: ACTOR_FORWARD_SCHEMA, bindings };
}

function validActorForwardSockets(
  value: readonly WorkerdActorForwardSocket[] | undefined,
): ReadonlyMap<string, WorkerdActorForwardSocket> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > 128)
    throw new Error("unusable Actor forward socket graph");
  const selected = new Map<string, WorkerdActorForwardSocket>();
  const paths = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      (Object.keys(candidate).sort().join(",") !==
        "httpSocketPath,namespaceResourceUid,tenantId,upgradeSocketPath" &&
        Object.keys(candidate).sort().join(",") !==
          "httpSocketPath,namespaceResourceUid,tenantId,token,upgradeSocketPath") ||
      typeof candidate.tenantId !== "string" ||
      candidate.tenantId.length === 0 ||
      candidate.tenantId.length > 256 ||
      candidate.tenantId.includes("\u0000") ||
      typeof candidate.namespaceResourceUid !== "string" ||
      !RESOURCE_UID.test(candidate.namespaceResourceUid) ||
      (candidate.token !== undefined &&
        (typeof candidate.token !== "string" || !ACTOR_FORWARD_TOKEN.test(candidate.token)))
    )
      throw new Error("unusable Actor forward socket graph");
    for (const path of [candidate.httpSocketPath, candidate.upgradeSocketPath]) {
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        resolve(path) !== path ||
        path.includes("\u0000") ||
        Buffer.byteLength(path) > 100 ||
        paths.has(path)
      )
        throw new Error("unusable Actor forward socket graph");
      paths.add(path);
    }
    const identity = actorForwardIdentity(
      candidate.tenantId,
      candidate.namespaceResourceUid,
      candidate.token,
    );
    if (selected.has(identity)) throw new Error("unusable Actor forward socket graph");
    selected.set(identity, { ...candidate });
  }
  return selected;
}

function validActorForwardCollision(
  actorForward: WorkerdActorForward | undefined,
  vars: readonly WorkerdBinding[],
  serviceBindings: readonly WorkerdServiceBinding[],
  hostEntrypoint: string | undefined,
  v2PrivateNames = false,
): void {
  if (!actorForward) return;
  if (hostEntrypoint === undefined) throw new Error("unusable Actor forward entrypoint");
  const names = new Set([
    v2PrivateNames ? WORKERD_V2_PRIVATE_READINESS_BINDING : INTERNAL_READINESS_CAPABILITY_BINDING,
    v2PrivateNames ? WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING : DATA_SERVICE_BINDING,
    ...vars.map((binding) => binding.name),
    ...serviceBindings.map((binding) => binding.name),
  ]);
  for (const binding of actorForward.bindings) {
    if (
      names.has(binding.publicName) ||
      names.has(binding.httpService) ||
      names.has(binding.upgradeService)
    )
      throw new Error("unusable Actor forward binding collision");
  }
}

function workflowForwardServiceName(index: number, v2PrivateNames = false): string {
  if (v2PrivateNames) return workerdV2PrivateWorkflowBindingName(index);
  return `__TAKOSERVER_WORKFLOW_BINDING_${index.toString(10).padStart(5, "0")}`;
}

function validWorkflowForwardBinding(
  value: unknown,
  index: number,
  v2PrivateNames = false,
): WorkerdLegacyWorkflowForwardBinding {
  const keys =
    "bindingRef,publicName,runtimeClassRef,serviceName,tenantId,token,workflowFormRef,workflowResourceUid";
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys
  ) {
    throw new Error("unusable Workflow forward graph");
  }
  const binding = value as WorkerdLegacyWorkflowForwardBinding;
  if (
    typeof binding.publicName !== "string" ||
    !WORKFLOW_FORWARD_PUBLIC_NAME.test(binding.publicName) ||
    (!v2PrivateNames && binding.publicName.startsWith("__TAKOSERVER_")) ||
    binding.serviceName !== workflowForwardServiceName(index, v2PrivateNames) ||
    typeof binding.tenantId !== "string" ||
    binding.tenantId.length === 0 ||
    binding.tenantId.includes("\u0000") ||
    typeof binding.workflowResourceUid !== "string" ||
    !RESOURCE_UID.test(binding.workflowResourceUid) ||
    typeof binding.token !== "string" ||
    !WORKFLOW_FORWARD_TOKEN.test(binding.token)
  ) {
    throw new Error("unusable Workflow forward graph");
  }
  let normalized: NonNullable<ReturnType<typeof normalizeWorkflowBindings>>[number] | undefined;
  try {
    normalized = normalizeWorkflowBindings([
      {
        name: binding.publicName,
        tenantId: binding.tenantId,
        workflowResourceUid: binding.workflowResourceUid,
        workflowFormRef: binding.workflowFormRef,
        bindingRef: binding.bindingRef,
        runtimeClassRef: binding.runtimeClassRef,
      },
    ])?.[0];
  } catch {
    throw new Error("unusable Workflow forward graph");
  }
  if (!normalized) throw new Error("unusable Workflow forward graph");
  return {
    publicName: normalized.name,
    serviceName: binding.serviceName,
    tenantId: normalized.tenantId,
    workflowResourceUid: normalized.workflowResourceUid,
    workflowFormRef: normalized.workflowFormRef,
    bindingRef: normalized.bindingRef,
    runtimeClassRef: normalized.runtimeClassRef,
    token: binding.token,
  };
}

function validV2WorkflowForwardBinding(
  value: unknown,
  index: number,
): WorkerdV2WorkflowForwardBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "publicName,serviceName,tenantId,token,workflowResourceUid"
  )
    throw new Error("unusable v2 Workflow forward graph");
  const binding = value as WorkerdV2WorkflowForwardBinding;
  if (
    typeof binding.publicName !== "string" ||
    !WORKFLOW_FORWARD_PUBLIC_NAME.test(binding.publicName) ||
    binding.serviceName !== workflowForwardServiceName(index, true) ||
    typeof binding.tenantId !== "string" ||
    binding.tenantId.length === 0 ||
    binding.tenantId.includes("\u0000") ||
    typeof binding.workflowResourceUid !== "string" ||
    !RESOURCE_UID.test(binding.workflowResourceUid) ||
    typeof binding.token !== "string" ||
    !WORKFLOW_FORWARD_TOKEN.test(binding.token)
  )
    throw new Error("unusable v2 Workflow forward graph");
  return { ...binding };
}

function validWorkflowForward(
  value: unknown,
  v2PrivateNames = false,
  activeV2PrivateEntrypoint = false,
): WorkerdWorkflowForward {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "bindings,schema,snapshotDigest"
  ) {
    throw new Error("unusable Workflow forward graph");
  }
  const candidate = value as WorkerdWorkflowForward;
  if (
    (candidate.schema !== WORKFLOW_FORWARD_SCHEMA &&
      candidate.schema !== V2_WORKFLOW_FORWARD_SCHEMA) ||
    (candidate.schema === V2_WORKFLOW_FORWARD_SCHEMA &&
      (!v2PrivateNames || !activeV2PrivateEntrypoint)) ||
    typeof candidate.snapshotDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(candidate.snapshotDigest) ||
    !Array.isArray(candidate.bindings) ||
    candidate.bindings.length === 0 ||
    candidate.bindings.length > 64
  ) {
    throw new Error("unusable Workflow forward graph");
  }
  const names = new Set<string>();
  const check = <T extends WorkerdWorkflowForwardBinding>(bindings: readonly T[]): readonly T[] =>
    bindings.map((binding) => {
      if (names.has(binding.publicName)) throw new Error("unusable Workflow forward graph");
      names.add(binding.publicName);
      capnpText(binding.publicName);
      capnpText(binding.serviceName);
      return binding;
    });
  if (candidate.schema === V2_WORKFLOW_FORWARD_SCHEMA) {
    const bindings = check(
      candidate.bindings.map((binding, index) => validV2WorkflowForwardBinding(binding, index)),
    );
    return {
      schema: V2_WORKFLOW_FORWARD_SCHEMA,
      snapshotDigest: candidate.snapshotDigest,
      bindings,
    };
  }
  const bindings = check(
    candidate.bindings.map((binding, index) =>
      validWorkflowForwardBinding(binding, index, v2PrivateNames),
    ),
  );
  return { schema: WORKFLOW_FORWARD_SCHEMA, snapshotDigest: candidate.snapshotDigest, bindings };
}

function workflowForwardBindingIdentity(binding: WorkerdWorkflowForwardBinding): string {
  if (!("workflowFormRef" in binding)) {
    return JSON.stringify([
      V2_WORKFLOW_FORWARD_SCHEMA,
      binding.publicName,
      binding.serviceName,
      binding.tenantId,
      binding.workflowResourceUid,
      binding.token,
    ]);
  }
  return JSON.stringify([
    binding.publicName,
    binding.serviceName,
    binding.tenantId,
    binding.workflowResourceUid,
    [
      binding.workflowFormRef.apiVersion,
      binding.workflowFormRef.kind,
      binding.workflowFormRef.definitionVersion,
      binding.workflowFormRef.schemaDigest,
    ],
    [
      binding.bindingRef.apiVersion,
      binding.bindingRef.name,
      binding.bindingRef.version,
      binding.bindingRef.schemaDigest,
    ],
    [
      binding.runtimeClassRef.apiVersion,
      binding.runtimeClassRef.name,
      binding.runtimeClassRef.version,
      binding.runtimeClassRef.schemaDigest,
    ],
    binding.token,
  ]);
}

function workflowForwardSocketIdentity(value: {
  readonly script: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionResourceUid: string;
  readonly snapshotDigest: string;
  readonly binding: WorkerdWorkflowForwardBinding;
}): string {
  return JSON.stringify([
    value.script,
    value.workerResourceUid,
    value.versionId,
    value.workerVersionResourceUid,
    value.snapshotDigest,
    workflowForwardBindingIdentity(value.binding),
  ]);
}

function workflowForwardPublicationGraphIdentity(
  publications: readonly WorkerdWorkflowForwardPublication[],
): string {
  return JSON.stringify(
    publications.map((publication) => [
      publication.script,
      publication.workerResourceUid,
      publication.versionId,
      publication.workerVersionResourceUid,
      publication.snapshotDigest,
      publication.bindings.map((binding) => workflowForwardBindingIdentity(binding)),
    ]),
  );
}

function copyWorkflowForwardSockets(
  value: unknown,
): readonly WorkerdWorkflowForwardSocket[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return value as readonly WorkerdWorkflowForwardSocket[];
  return value.map((entry) => {
    const socket = copyOwnRecord(entry);
    if (!socket) return entry as WorkerdWorkflowForwardSocket;
    const binding = copyOwnRecord(socket.binding);
    if (!binding) return socket as unknown as WorkerdWorkflowForwardSocket;
    return {
      ...socket,
      binding:
        "workflowFormRef" in binding
          ? {
              ...binding,
              workflowFormRef: copyWorkflowForwardValue(binding.workflowFormRef),
              bindingRef: copyWorkflowForwardValue(binding.bindingRef),
              runtimeClassRef: copyWorkflowForwardValue(binding.runtimeClassRef),
            }
          : { ...binding },
    } as unknown as WorkerdWorkflowForwardSocket;
  });
}

function copyOwnRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return { ...value };
}

function copyWorkflowForwardValue(value: unknown): unknown {
  return copyOwnRecord(value) ?? value;
}

function copyWorkflowForward(value: WorkerdWorkflowForward): WorkerdWorkflowForward {
  if (value.schema === V2_WORKFLOW_FORWARD_SCHEMA) {
    return {
      schema: V2_WORKFLOW_FORWARD_SCHEMA,
      snapshotDigest: value.snapshotDigest,
      bindings: value.bindings.map((binding) => ({ ...binding })),
    };
  }
  return {
    schema: WORKFLOW_FORWARD_SCHEMA,
    snapshotDigest: value.snapshotDigest,
    bindings: value.bindings.map((binding) => ({
      ...binding,
      workflowFormRef: { ...binding.workflowFormRef },
      bindingRef: { ...binding.bindingRef },
      runtimeClassRef: { ...binding.runtimeClassRef },
    })),
  };
}

interface ResolvedWorkflowForwardService {
  readonly bindingName: string;
  readonly serviceName: string;
  readonly socketPath: string;
}

interface WorkflowForwardRuntimeGraph {
  readonly publications: readonly WorkerdWorkflowForwardPublication[];
  readonly sockets: readonly WorkerdWorkflowForwardSocket[] | undefined;
  readonly services: ReadonlyMap<string, readonly ResolvedWorkflowForwardService[]>;
}

interface PreparedWorkflowForwardGraph {
  readonly publications: readonly WorkerdWorkflowForwardPublication[];
  readonly sockets: readonly WorkerdWorkflowForwardSocket[] | undefined;
  readonly lease: { release(): Promise<void> };
}

function workflowForwardPublications(
  published: readonly PublishedDeployment[],
): readonly WorkerdWorkflowForwardPublication[] {
  const publications: WorkerdWorkflowForwardPublication[] = [];
  for (const deployment of published) {
    for (const variant of deployment.variants) {
      if (variant.manifest.workflowForward === undefined) continue;
      if (
        !deployment.weighted ||
        !deployment.workerResourceUid ||
        !variant.versionId ||
        !variant.workerVersionUid
      ) {
        throw new Error("Workflow forward requires an immutable weighted Version");
      }
      const forward = validWorkflowForward(
        variant.manifest.workflowForward,
        hasWorkerdV2PrivateBindingProfile(variant.manifest),
        variant.manifest.hostEntrypoint === WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
      );
      const bindings = Object.freeze(
        forward.bindings.map((binding) =>
          Object.freeze(
            "workflowFormRef" in binding
              ? {
                  ...binding,
                  workflowFormRef: Object.freeze({ ...binding.workflowFormRef }),
                  bindingRef: Object.freeze({ ...binding.bindingRef }),
                  runtimeClassRef: Object.freeze({ ...binding.runtimeClassRef }),
                }
              : { ...binding },
          ),
        ),
      );
      publications.push(
        Object.freeze({
          script: deployment.name,
          workerResourceUid: deployment.workerResourceUid,
          versionId: variant.versionId,
          workerVersionResourceUid: variant.workerVersionUid,
          snapshotDigest: forward.snapshotDigest,
          bindings,
        }),
      );
    }
  }
  return Object.freeze(publications);
}

function workflowForwardPublicationsForInput(
  script: string,
  publication: WorkerdMixedDeploymentPublication | null,
): readonly WorkerdWorkflowForwardPublication[] {
  if (publication === null) return [];
  const workerResourceUid = validWorkerResourceUid(publication.workerResourceUid);
  if (!Array.isArray(publication.versions)) {
    throw new Error("unusable weighted worker deployment");
  }
  const canonical = canonicalSelfhostWeightedVersions(
    publication.versions.map(({ versionId, workerVersionUid, weight }) => ({
      versionId,
      workerVersionUid,
      weight,
    })),
  );
  const byUid = new Map(publication.versions.map((version) => [version.workerVersionUid, version]));
  const result: WorkerdWorkflowForwardPublication[] = [];
  for (const identity of canonical) {
    const version = byUid.get(identity.workerVersionUid);
    if (
      !version ||
      version.versionId !== identity.versionId ||
      version.weight !== identity.weight
    ) {
      throw new Error("unusable weighted worker deployment");
    }
    if (version.site.workflowForward === undefined) continue;
    const forward = validWorkflowForward(
      version.site.workflowForward,
      hasWorkerdV2PrivateBindingProfile(version.site),
      version.site.hostEntrypoint === WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
    );
    const bindings = Object.freeze(
      forward.bindings.map((binding) =>
        Object.freeze(
          "workflowFormRef" in binding
            ? {
                ...binding,
                workflowFormRef: Object.freeze({ ...binding.workflowFormRef }),
                bindingRef: Object.freeze({ ...binding.bindingRef }),
                runtimeClassRef: Object.freeze({ ...binding.runtimeClassRef }),
              }
            : { ...binding },
        ),
      ),
    );
    result.push(
      Object.freeze({
        script,
        workerResourceUid,
        versionId: identity.versionId,
        workerVersionResourceUid: identity.workerVersionUid,
        snapshotDigest: forward.snapshotDigest,
        bindings,
      }),
    );
  }
  return Object.freeze(result);
}

function validateWorkflowForwardSockets(
  publications: readonly WorkerdWorkflowForwardPublication[],
  sockets: readonly WorkerdWorkflowForwardSocket[] | undefined,
): ReadonlyMap<string, WorkerdWorkflowForwardSocket> {
  const identities = new Set<string>();
  for (const publication of publications) {
    for (const binding of publication.bindings) {
      const identity = workflowForwardSocketIdentity({ ...publication, binding });
      if (identities.has(identity)) throw new Error("unusable Workflow forward socket graph");
      identities.add(identity);
    }
  }
  if (identities.size === 0) {
    if (sockets !== undefined && (!Array.isArray(sockets) || sockets.length !== 0)) {
      throw new Error("Workflow forward Host socket unavailable");
    }
    return new Map();
  }
  if (!Array.isArray(sockets) || sockets.length < identities.size) {
    throw new Error("Workflow forward Host socket unavailable");
  }
  const resolved = new Map<string, WorkerdWorkflowForwardSocket>();
  const paths = new Set<string>();
  for (const value of sockets) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "binding,script,snapshotDigest,socketPath,versionId,workerResourceUid,workerVersionResourceUid" ||
      typeof value.script !== "string" ||
      !SCRIPT_NAME.test(value.script) ||
      typeof value.workerResourceUid !== "string" ||
      !RESOURCE_UID.test(value.workerResourceUid) ||
      typeof value.versionId !== "string" ||
      value.versionId.length === 0 ||
      value.versionId.length > 256 ||
      value.versionId.includes("\u0000") ||
      typeof value.workerVersionResourceUid !== "string" ||
      !RESOURCE_UID.test(value.workerVersionResourceUid) ||
      typeof value.snapshotDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.snapshotDigest) ||
      typeof value.socketPath !== "string" ||
      !isAbsolute(value.socketPath) ||
      resolve(value.socketPath) !== value.socketPath ||
      value.socketPath.includes("\u0000") ||
      Buffer.byteLength(value.socketPath) > 100 ||
      paths.has(value.socketPath)
    ) {
      throw new Error("unusable Workflow forward socket graph");
    }
    if (
      typeof value.binding !== "object" ||
      value.binding === null ||
      Array.isArray(value.binding) ||
      typeof value.binding.serviceName !== "string" ||
      !(
        WORKFLOW_FORWARD_SERVICE_NAME.test(value.binding.serviceName) ||
        isWorkerdV2PrivateWorkflowBindingName(value.binding.serviceName)
      )
    ) {
      throw new Error("unusable Workflow forward socket graph");
    }
    const v2Index = workerdV2PrivateWorkflowBindingIndex(value.binding.serviceName);
    const binding =
      v2Index !== null &&
      typeof value.binding === "object" &&
      value.binding !== null &&
      Object.keys(value.binding).sort().join(",") ===
        "publicName,serviceName,tenantId,token,workflowResourceUid"
        ? validV2WorkflowForwardBinding(value.binding, v2Index)
        : validWorkflowForwardBinding(
            value.binding,
            v2Index ??
              Number.parseInt(
                value.binding.serviceName.slice("__TAKOSERVER_WORKFLOW_BINDING_".length),
                10,
              ),
            v2Index !== null,
          );
    const identity = workflowForwardSocketIdentity({ ...value, binding });
    if (!identities.has(identity) || resolved.has(identity)) {
      throw new Error("Workflow forward Host socket unavailable");
    }
    paths.add(value.socketPath);
    resolved.set(identity, { ...value, binding });
  }
  if (resolved.size !== identities.size) {
    throw new Error("Workflow forward Host socket unavailable");
  }
  return resolved;
}

function resolveWorkflowForwardServices(
  published: readonly PublishedDeployment[],
  publications: readonly WorkerdWorkflowForwardPublication[],
  sockets: readonly WorkerdWorkflowForwardSocket[] | undefined,
): ReadonlyMap<string, readonly ResolvedWorkflowForwardService[]> {
  const expected = new Map<
    string,
    { readonly binding: WorkerdWorkflowForwardBinding; readonly identity: string }[]
  >();
  for (const publication of publications) {
    const deployment = published.find(
      (candidate) => candidate.name === publication.script && candidate.weighted,
    );
    const variant = deployment?.variants.find(
      (candidate) =>
        candidate.versionId === publication.versionId &&
        candidate.workerVersionUid === publication.workerVersionResourceUid,
    );
    if (
      !deployment ||
      deployment.workerResourceUid !== publication.workerResourceUid ||
      !variant ||
      variant.manifest.workflowForward === undefined
    ) {
      throw new Error("unusable Workflow forward publication graph");
    }
    const entries = publication.bindings.map((binding) => {
      const identity = workflowForwardSocketIdentity({ ...publication, binding });
      return { binding, identity };
    });
    expected.set(variant.name, entries);
  }
  const resolvedByIdentity = validateWorkflowForwardSockets(publications, sockets);
  const resolved = new Map<string, readonly ResolvedWorkflowForwardService[]>();
  for (const [variantName, entries] of expected) {
    resolved.set(
      variantName,
      entries.map(({ binding, identity }, index) => {
        const socket = resolvedByIdentity.get(identity);
        if (!socket) throw new Error("Workflow forward Host socket unavailable");
        return {
          bindingName: binding.serviceName,
          serviceName: `${variantName}-workflow-binding-${index}`,
          socketPath: socket.socketPath,
        };
      }),
    );
  }
  return resolved;
}

function validWorkflowForwardCollision(
  workflowForward: WorkerdWorkflowForward | undefined,
  vars: readonly WorkerdBinding[],
  serviceBindings: readonly WorkerdServiceBinding[],
  actorForward: WorkerdActorForward | undefined,
  hostEntrypoint: string | undefined,
  v2PrivateNames = false,
): void {
  if (!workflowForward) return;
  if (hostEntrypoint === undefined) throw new Error("unusable Workflow forward entrypoint");
  const names = new Set([
    v2PrivateNames ? WORKERD_V2_PRIVATE_READINESS_BINDING : INTERNAL_READINESS_CAPABILITY_BINDING,
    v2PrivateNames ? WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING : DATA_SERVICE_BINDING,
    ...vars.map((binding) => binding.name),
    ...serviceBindings.map((binding) => binding.name),
    ...(actorForward?.bindings.flatMap((binding) => [
      binding.publicName,
      binding.httpService,
      binding.upgradeService,
    ]) ?? []),
  ]);
  for (const binding of workflowForward.bindings) {
    if (names.has(binding.publicName) || names.has(binding.serviceName)) {
      throw new Error("unusable Workflow forward binding collision");
    }
    names.add(binding.publicName);
    names.add(binding.serviceName);
  }
}

function validBindings(bindings: readonly WorkerdBinding[]): readonly WorkerdBinding[] {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (
      typeof binding?.name !== "string" ||
      !BINDING_NAME.test(binding.name) ||
      typeof binding.value !== "string" ||
      (binding.kind !== "text" && binding.kind !== "json")
    ) {
      throw new Error("unusable worker binding");
    }
    if (seen.has(binding.name)) throw new Error("unusable worker binding");
    seen.add(binding.name);
    // Renderability is part of validity. A value capnp Text cannot carry is
    // refused here, where every caller already fails closed, rather than in
    // `renderConfig`, which runs once for the whole machine and would take
    // every other script down with the broken one.
    capnpText(binding.name);
    capnpText(binding.value);
  }
  return bindings;
}

function validWorkerResourceUid(value: unknown): string {
  if (typeof value !== "string" || !RESOURCE_UID.test(value)) {
    throw new Error("unusable worker resource identity");
  }
  return value;
}

function validServiceBindings(
  bindings: readonly WorkerdServiceBinding[],
  v2PrivateNames = false,
): readonly WorkerdServiceBinding[] {
  if (!Array.isArray(bindings) || bindings.length > 64) {
    throw new Error("unusable worker service binding");
  }
  const names = new Set<string>();
  return bindings.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !==
        "name,target,targetResourceUid,unavailableToken" ||
      typeof candidate.name !== "string" ||
      !(v2PrivateNames
        ? isWorkerdV2PrivateServiceBindingName(candidate.name)
        : INTERNAL_SERVICE_BINDING.test(candidate.name)) ||
      names.has(candidate.name) ||
      typeof candidate.target !== "string" ||
      !SCRIPT_NAME.test(candidate.target) ||
      typeof candidate.targetResourceUid !== "string" ||
      !RESOURCE_UID.test(candidate.targetResourceUid) ||
      typeof candidate.unavailableToken !== "string" ||
      !SERVICE_UNAVAILABLE_TOKEN.test(candidate.unavailableToken)
    ) {
      throw new Error("unusable worker service binding");
    }
    names.add(candidate.name);
    capnpText(candidate.name);
    capnpText(candidate.target);
    capnpText(candidate.targetResourceUid);
    capnpText(candidate.unavailableToken);
    return {
      name: candidate.name,
      target: candidate.target,
      targetResourceUid: candidate.targetResourceUid,
      unavailableToken: candidate.unavailableToken,
    };
  });
}

/**
 * Module names this configuration may declare.
 *
 * A module name is a registry identity, not a filesystem path. Physical files
 * use private ordinal keys, so builtin-looking names and names equal to a Host
 * module remain valid. A duplicate within one provenance namespace is refused
 * rather than silently shadowing another declaration.
 */
function validModules(modules: readonly string[], mainModule?: string): readonly string[] {
  const seen = new Set(mainModule === undefined ? [] : [mainModule]);
  for (const name of modules) {
    if (typeof name !== "string" || name.length === 0 || name.length > 1_024 || seen.has(name)) {
      throw new Error("unusable worker module");
    }
    seen.add(name);
    capnpText(name);
  }
  return modules;
}

function validHostModuleNames(
  site: Pick<
    WorkerdSite,
    | "hostModules"
    | "dataPlane"
    | "events"
    | "queueSettlement"
    | "v2ObjectBucketPlane"
    | "v2KvPlane"
    | "v2QueueProducerPlane"
  >,
  hostEntrypoint: string | undefined,
): readonly string[] {
  return validModules([
    ...(hostEntrypoint === undefined ? [] : [hostEntrypoint]),
    ...(site.hostModules ?? []),
    ...(site.dataPlane === undefined &&
    site.v2KvPlane === undefined &&
    site.v2QueueProducerPlane === undefined
      ? []
      : [
          site.dataPlane === undefined
            ? SELFHOST_WORKER_DATA_SERVICE_MODULE
            : validDataPlane(site.dataPlane).module,
        ]),
    ...(site.events === undefined ? [] : [validEventGate(site.events).module]),
    ...(site.queueSettlement === undefined
      ? []
      : [validQueueSettlement(site.queueSettlement).module]),
    ...(site.v2ObjectBucketPlane === undefined
      ? []
      : [SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE]),
  ]);
}

interface SnapshottedModule {
  readonly name: string;
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly digest: `sha256:${string}`;
}

async function snapshotModuleBytes(
  modules: ReadonlyMap<string, Uint8Array>,
  expectedNames: readonly string[],
  provenance: string,
): Promise<{
  readonly entries: readonly SnapshottedModule[];
  readonly manifest: readonly WorkerdStoredModule[];
}> {
  if (modules.size !== expectedNames.length) {
    throw new Error(`unusable ${provenance} worker module snapshot`);
  }
  const expected = new Set(expectedNames);
  for (const [name, bytes] of modules) {
    if (!expected.has(name) || !(bytes instanceof Uint8Array)) {
      throw new Error(`unusable ${provenance} worker module snapshot`);
    }
  }
  const entries: SnapshottedModule[] = [];
  for (const [index, name] of expectedNames.entries()) {
    const source = modules.get(name);
    if (!(source instanceof Uint8Array)) {
      throw new Error(`unusable ${provenance} worker module snapshot`);
    }
    const bytes = new Uint8Array(source);
    const key = `module-${index.toString(10).padStart(5, "0")}`;
    entries.push({
      name,
      key,
      bytes,
      size: bytes.byteLength,
      digest: await bytesDigest(bytes),
    });
  }
  return {
    entries,
    manifest: entries.map(({ name, key, size, digest }) => ({ name, key, size, digest })),
  };
}

const WORKERD_MODULE_MEDIA_TYPES: readonly WorkerdModuleMediaType[] = [
  "application/javascript+module",
  "text/plain",
  "application/octet-stream",
  "application/wasm",
];

function isWorkerdModuleMediaType(value: unknown): value is WorkerdModuleMediaType {
  return (WORKERD_MODULE_MEDIA_TYPES as readonly unknown[]).includes(value);
}

/**
 * Checks the media map against the exact module declaration set.
 *
 * The map is persisted in the site manifest, so this validation is also the
 * readback fence: a tampered or partially written map makes that one site
 * unavailable rather than making the whole machine render an invalid config.
 */
function validModuleMediaTypes(
  mainModule: string,
  modules: readonly string[],
  mediaTypes: unknown,
): Readonly<Record<string, WorkerdModuleMediaType>> | undefined {
  if (mediaTypes === undefined) return undefined;
  if (typeof mediaTypes !== "object" || mediaTypes === null || Array.isArray(mediaTypes)) {
    throw new Error("unusable worker module media types");
  }

  const declared = new Set([mainModule, ...modules]);
  const entries = Object.entries(mediaTypes);
  if (entries.length !== declared.size) {
    throw new Error("unusable worker module media types");
  }

  const normalized: Record<string, WorkerdModuleMediaType> = Object.create(null);
  for (const [name, mediaType] of entries) {
    if (!declared.has(name) || !isWorkerdModuleMediaType(mediaType)) {
      throw new Error("unusable worker module media types");
    }
    normalized[name] = mediaType;
  }
  for (const name of declared) {
    if (!Object.hasOwn(mediaTypes, name)) {
      throw new Error("unusable worker module media types");
    }
  }
  return normalized;
}

const SAFE_ASSET_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u;
const ASSET_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const STATIC_ASSET_MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MAX_ASSET_MEDIA_TYPE_LENGTH = 255;
const MAX_ASSET_ENTRIES = 16_384;
const MAX_ASSET_BYTES = TAKOFORM_MAXIMUM_STATIC_ASSET_BUNDLE_BYTES;
const MAX_STATIC_ASSET_FILE_BYTES = 16_777_216;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

function validAssetPath(value: string, staticOnly = false): boolean {
  if (staticOnly) return isValidArtifactPath(value);
  return (
    value.length > 0 &&
    value.length <= 240 &&
    SAFE_ASSET_PATH.test(value) &&
    value.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

function validAssetMediaType(value: unknown, staticOnly = false): value is string {
  return (
    typeof value === "string" &&
    (staticOnly
      ? STATIC_ASSET_MEDIA_TYPE.test(value)
      : value.length <= MAX_ASSET_MEDIA_TYPE_LENGTH && ASSET_MEDIA_TYPE.test(value))
  );
}

function assetStorageName(index: number): string {
  return `asset-${index.toString(10).padStart(5, "0")}`;
}

function validAssetMediaTypes(
  value: unknown,
  staticOnly = false,
): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("unusable worker asset declaration");
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > (staticOnly ? 512 : MAX_ASSET_ENTRIES)) {
    throw new Error("unusable worker asset declaration");
  }
  const normalized: Record<string, string> = Object.create(null);
  for (const [path, mediaType] of entries) {
    if (!validAssetPath(path, staticOnly) || !validAssetMediaType(mediaType, staticOnly)) {
      throw new Error("unusable worker asset declaration");
    }
    normalized[path] = mediaType;
  }
  return normalized;
}

/**
 * Captures and validates the exact private asset publication before `write`
 * removes the currently serving directory.
 */
async function validAssets(
  configuration: WorkerdSite["assets"] | undefined,
  assets: ReadonlyMap<string, Uint8Array> | undefined,
  staticOnly = false,
): Promise<
  | {
      readonly configuration: WorkerdAssetManifest;
      readonly entries: readonly (readonly [string, Uint8Array])[];
    }
  | undefined
> {
  if (configuration === undefined && assets === undefined) return undefined;
  const normalized = validAssetDeclaration(configuration, staticOnly);
  const strictPaths = staticOnly || normalized?.strictPaths === true;
  if (normalized === undefined || assets === undefined || assets.size < 1) {
    throw new Error("unusable worker asset declaration");
  }
  const logicalEntries: Array<readonly [string, Uint8Array]> = [];
  for (const [name, source] of assets) {
    if (
      typeof name !== "string" ||
      !validAssetPath(name, strictPaths) ||
      !(source instanceof Uint8Array)
    ) {
      throw new Error("unusable worker asset declaration");
    }
    logicalEntries.push([name, new Uint8Array(source)]);
  }
  logicalEntries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    Object.keys(normalized.mediaTypes).length !== logicalEntries.length ||
    logicalEntries.some(([name]) => !Object.hasOwn(normalized.mediaTypes, name))
  ) {
    throw new Error("unusable worker asset declaration");
  }
  if (
    normalized.notFoundHandling === "single-page-application" &&
    !logicalEntries.some(([name]) => name === "index.html")
  ) {
    throw new Error("single-page application assets require index.html");
  }
  const files: Record<string, WorkerdAssetManifestEntry> = Object.create(null);
  let total = 0;
  const entries: Array<readonly [string, Uint8Array]> = [];
  for (const [index, [name, bytes]] of logicalEntries.entries()) {
    const key = assetStorageName(index);
    total += bytes.byteLength;
    if (
      (strictPaths && bytes.byteLength > MAX_STATIC_ASSET_FILE_BYTES) ||
      !Number.isSafeInteger(total) ||
      total > MAX_ASSET_BYTES
    ) {
      throw new Error("unusable worker asset declaration");
    }
    files[name] = {
      key,
      mediaType: normalized.mediaTypes[name] as string,
      size: bytes.byteLength,
      digest: await bytesDigest(bytes),
    };
    entries.push([key, bytes]);
  }
  return {
    configuration: {
      storageLayout: WORKERD_ASSET_STORAGE_LAYOUT,
      notFoundHandling: normalized.notFoundHandling,
      runWorkerFirst: normalized.runWorkerFirst,
      ...(normalized.strictPaths === true ? { strictPaths: true as const } : {}),
      files,
    },
    entries,
  };
}

function validAssetDeclaration(
  value: unknown,
  staticOnly = false,
): WorkerdSite["assets"] | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![
      "mediaTypes,notFoundHandling,runWorkerFirst",
      "mediaTypes,notFoundHandling,runWorkerFirst,strictPaths",
    ].includes(Object.keys(value).sort().join(","))
  ) {
    throw new Error("unusable worker asset declaration");
  }
  const candidate = value as Record<string, unknown>;
  const notFoundHandling = candidate.notFoundHandling;
  const runWorkerFirst = candidate.runWorkerFirst;
  const mediaTypes = candidate.mediaTypes;
  const strictPaths = candidate.strictPaths;
  if (
    (notFoundHandling !== "none" && notFoundHandling !== "single-page-application") ||
    typeof runWorkerFirst !== "boolean" ||
    (strictPaths !== undefined && strictPaths !== true)
  ) {
    throw new Error("unusable worker asset declaration");
  }
  return {
    notFoundHandling,
    runWorkerFirst,
    ...(strictPaths === true ? { strictPaths: true as const } : {}),
    mediaTypes: validAssetMediaTypes(mediaTypes, staticOnly || strictPaths === true),
  };
}

function validAssetManifest(value: unknown, staticOnly = false): WorkerdAssetManifest | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![
      "files,notFoundHandling,runWorkerFirst,storageLayout",
      "files,notFoundHandling,runWorkerFirst,storageLayout,strictPaths",
    ].includes(Object.keys(value).sort().join(","))
  ) {
    throw new Error("unusable worker asset manifest");
  }
  const candidate = value as Record<string, unknown>;
  const storageLayout = candidate.storageLayout;
  const notFoundHandling = candidate.notFoundHandling;
  const runWorkerFirst = candidate.runWorkerFirst;
  const strictPaths = candidate.strictPaths;
  const sourceFiles = candidate.files;
  if (
    storageLayout !== WORKERD_ASSET_STORAGE_LAYOUT ||
    (notFoundHandling !== "none" && notFoundHandling !== "single-page-application") ||
    typeof runWorkerFirst !== "boolean" ||
    (strictPaths !== undefined && strictPaths !== true) ||
    typeof sourceFiles !== "object" ||
    sourceFiles === null ||
    Array.isArray(sourceFiles)
  ) {
    throw new Error("unusable worker asset manifest");
  }
  const filesRecord = sourceFiles as Record<string, unknown>;
  const logicalPaths = Object.keys(filesRecord).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const strictGrammar = staticOnly || strictPaths === true;
  if (logicalPaths.length < 1 || logicalPaths.length > (strictGrammar ? 512 : MAX_ASSET_ENTRIES)) {
    throw new Error("unusable worker asset manifest");
  }
  const files: Record<string, WorkerdAssetManifestEntry> = Object.create(null);
  let total = 0;
  for (const [index, path] of logicalPaths.entries()) {
    const entry = filesRecord[path];
    if (
      !validAssetPath(path, strictGrammar) ||
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "digest,key,mediaType,size"
    ) {
      throw new Error("unusable worker asset manifest");
    }
    const record = entry as Record<string, unknown>;
    if (
      record.key !== assetStorageName(index) ||
      !validAssetMediaType(record.mediaType, strictGrammar) ||
      !Number.isSafeInteger(record.size) ||
      (record.size as number) < 0 ||
      (record.size as number) > (strictGrammar ? MAX_STATIC_ASSET_FILE_BYTES : MAX_ASSET_BYTES) ||
      typeof record.digest !== "string" ||
      !SHA256_DIGEST.test(record.digest)
    ) {
      throw new Error("unusable worker asset manifest");
    }
    total += record.size as number;
    if (!Number.isSafeInteger(total) || total > MAX_ASSET_BYTES) {
      throw new Error("unusable worker asset manifest");
    }
    files[path] = {
      key: record.key,
      mediaType: record.mediaType,
      size: record.size as number,
      digest: record.digest as `sha256:${string}`,
    };
  }
  if (notFoundHandling === "single-page-application" && !Object.hasOwn(files, "index.html")) {
    throw new Error("single-page application assets require index.html");
  }
  return {
    storageLayout,
    notFoundHandling,
    runWorkerFirst,
    ...(strictPaths === true ? { strictPaths: true as const } : {}),
    files,
  };
}

type WorkerdModuleKind = "esModule" | "text" | "data" | "wasm";

function workerdModuleKind(mediaType: WorkerdModuleMediaType): WorkerdModuleKind {
  switch (mediaType) {
    case "application/javascript+module":
      return "esModule";
    case "text/plain":
      return "text";
    case "application/octet-stream":
      return "data";
    case "application/wasm":
      return "wasm";
  }
}

/**
 * The one address a data-plane service may point at.
 *
 * Loopback only, and deliberately: the address is written into a generated
 * `externalServer`, every request the facade service makes on that binding goes
 * to it whatever URL was written, and each of those requests carries the
 * version's plane token. An address off this machine would be somewhere that
 * token could be sent.
 *
 * Two literal addresses, not a name. `localhost` is a resolver answer rather
 * than an address: it may be `::1` where the listener is on `127.0.0.1`, it may
 * be several addresses, and on a machine whose `hosts` file somebody edited it
 * may be neither. A port is a port — `0` is not one, and neither is `99999`.
 */
function validDataPlaneAddress(address: string): string {
  const separator = address.lastIndexOf(":");
  const host = separator < 0 ? "" : address.slice(0, separator);
  const port = separator < 0 ? "" : address.slice(separator + 1);
  const number = /^[1-9][0-9]{0,4}$/u.test(port) ? Number(port) : 0;
  if ((host !== "127.0.0.1" && host !== "[::1]") || number < 1 || number > 65_535) {
    throw new Error("unusable data plane address");
  }
  return address;
}

/** The facade service one script publishes beside itself, checked whole. */
function validDataPlane(plane: WorkerdDataPlane): WorkerdDataPlane {
  if (typeof plane !== "object" || plane === null) throw new Error("unusable data plane");
  validDataPlaneAddress(plane.address);
  validModules([plane.module]);
  validBindings(plane.vars ?? []);
  return plane;
}

/** The event gate one script publishes beside itself, checked whole. */
function validEventGate(gate: WorkerdEventGate): WorkerdEventGate {
  if (typeof gate !== "object" || gate === null) throw new Error("unusable event gate");
  validModules([gate.module]);
  validBindings(gate.vars ?? []);
  return gate;
}

function validQueueSettlement(plane: WorkerdQueueSettlement): WorkerdQueueSettlement {
  if (typeof plane !== "object" || plane === null)
    throw new Error("unusable queue settlement plane");
  validDataPlaneAddress(plane.address);
  if (
    plane.module !== V2_QUEUE_SETTLEMENT_SERVICE_MODULE ||
    !Array.isArray(plane.vars) ||
    plane.vars.length !== 1 ||
    plane.vars[0]?.name !== V2_QUEUE_SETTLEMENT_TOKEN_BINDING ||
    plane.vars[0]?.kind !== "text" ||
    typeof plane.vars[0]?.value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(plane.vars[0].value)
  ) {
    throw new Error("unusable queue settlement plane");
  }
  validModules([plane.module]);
  validBindings(plane.vars);
  return plane;
}

function validV2ObjectBucketPlane(plane: WorkerdV2ObjectBucketPlane): WorkerdV2ObjectBucketPlane {
  if (
    typeof plane !== "object" ||
    plane === null ||
    Object.keys(plane).sort().join(",") !== "address,token" ||
    typeof plane.address !== "string" ||
    typeof plane.token !== "string" ||
    plane.token.length > 32_768 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(plane.token)
  ) {
    throw new Error("unusable v2 ObjectBucket binding plane");
  }
  validDataPlaneAddress(plane.address);
  return { address: plane.address, token: plane.token };
}

function validV2KvPlane(plane: WorkerdV2KvPlane): WorkerdV2KvPlane {
  if (
    typeof plane !== "object" ||
    plane === null ||
    Object.keys(plane).sort().join(",") !== "address,token" ||
    typeof plane.address !== "string" ||
    typeof plane.token !== "string" ||
    plane.token.length > 32_768 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(plane.token)
  ) {
    throw new Error("unusable v2 KV binding plane");
  }
  validDataPlaneAddress(plane.address);
  return { address: plane.address, token: plane.token };
}

interface PreparedWorkerdSite<M extends StoredManifest = StoredManifest> {
  readonly manifest: M;
  readonly application: readonly SnapshottedModule[];
  readonly hostPrivate: readonly SnapshottedModule[];
  readonly assets?: readonly (readonly [string, Uint8Array])[];
}

/** Captures every byte and validates every binding before durable state moves. */
async function prepareWorkerdSite(
  site: WorkerdSite,
  modules: ReadonlyMap<string, Uint8Array>,
  assets: ReadonlyMap<string, Uint8Array> | undefined,
  hostModules: ReadonlyMap<string, Uint8Array> | undefined,
): Promise<PreparedWorkerdSite<Manifest>>;
async function prepareWorkerdSite(
  site: WorkerdStaticSite,
  modules: ReadonlyMap<string, Uint8Array>,
  assets: ReadonlyMap<string, Uint8Array> | undefined,
  hostModules: ReadonlyMap<string, Uint8Array> | undefined,
): Promise<PreparedWorkerdSite<StaticManifest>>;
async function prepareWorkerdSite(
  site: WorkerdSite | WorkerdStaticSite,
  modules: ReadonlyMap<string, Uint8Array>,
  assets: ReadonlyMap<string, Uint8Array> | undefined,
  hostModules: ReadonlyMap<string, Uint8Array> | undefined,
): Promise<PreparedWorkerdSite>;
async function prepareWorkerdSite(
  site: WorkerdSite | WorkerdStaticSite,
  modules: ReadonlyMap<string, Uint8Array>,
  assets: ReadonlyMap<string, Uint8Array> | undefined,
  hostModules: ReadonlyMap<string, Uint8Array> | undefined,
): Promise<PreparedWorkerdSite> {
  if ("kind" in site && site.kind !== "static") {
    throw new Error("unusable worker Version kind");
  }
  if ("kind" in site && site.kind === "static") {
    const keys = Object.keys(site).sort().join(",");
    if (
      keys !== "assets,directory,fetchHandler,generation,hostnames,kind,workerResourceUid" &&
      keys !== "assets,directory,fetchHandler,hostnames,kind,workerResourceUid"
    )
      throw new Error("unusable static Worker Version declaration");
    if (
      typeof site.directory !== "string" ||
      site.fetchHandler !== false ||
      modules.size !== 0 ||
      (hostModules?.size ?? 0) !== 0 ||
      typeof site.generation !== "string"
    )
      throw new Error("unusable static Worker Version declaration");
    capnpText(site.generation);
    const assetDeclaration = await validAssets(site.assets, assets, true);
    if (assetDeclaration?.configuration.runWorkerFirst !== false) {
      throw new Error("unusable static Worker Version assets");
    }
    const manifest: StaticManifest = {
      kind: "static",
      hostnames: validDeploymentHostnames(site.hostnames),
      generation: site.generation,
      workerResourceUid: validWorkerResourceUid(site.workerResourceUid),
      fetchHandler: false,
      assets: assetDeclaration.configuration,
    };
    return { manifest, application: [], hostPrivate: [], assets: assetDeclaration.entries };
  }
  const mainModule = validModules([site.mainModule])[0] as string;
  const declaredModules = validModules(site.modules ?? [], site.mainModule);
  const moduleMediaTypes = validModuleMediaTypes(
    mainModule,
    declaredModules,
    site.moduleMediaTypes,
  );
  const hostEntrypoint =
    site.hostEntrypoint === undefined
      ? undefined
      : (validModules([site.hostEntrypoint])[0] as string);
  const declaredHostModules = validHostModuleNames(site, hostEntrypoint);
  const applicationSnapshot = await snapshotModuleBytes(
    modules,
    [mainModule, ...declaredModules],
    "application",
  );
  const hostSnapshot = await snapshotModuleBytes(
    hostModules ?? new Map(),
    declaredHostModules,
    "Host-private",
  );
  const assetDeclaration = await validAssets(site.assets, assets);
  const workerResourceUid =
    site.workerResourceUid === undefined
      ? undefined
      : validWorkerResourceUid(site.workerResourceUid);
  if (
    (workerResourceUid === undefined) !== (site.fetchHandler === undefined) ||
    (site.fetchHandler !== undefined && typeof site.fetchHandler !== "boolean")
  ) {
    throw new Error("unusable worker service identity");
  }
  const serviceBindings = validServiceBindings(
    site.serviceBindings ?? [],
    hasWorkerdV2PrivateBindingProfile(site),
  );
  if (serviceBindings.length > 0 && workerResourceUid === undefined) {
    throw new Error("unusable worker service binding");
  }
  const actorForward =
    site.actorForward === undefined
      ? undefined
      : validActorForward(site.actorForward, hasWorkerdV2PrivateBindingProfile(site));
  const workflowForward =
    site.workflowForward === undefined
      ? undefined
      : validWorkflowForward(
          site.workflowForward,
          hasWorkerdV2PrivateBindingProfile(site),
          site.hostEntrypoint === WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
        );
  const v2ObjectBucketPlane =
    site.v2ObjectBucketPlane === undefined
      ? undefined
      : validV2ObjectBucketPlane(site.v2ObjectBucketPlane);
  const v2KvPlane = site.v2KvPlane === undefined ? undefined : validV2KvPlane(site.v2KvPlane);
  const v2QueueProducerPlane =
    site.v2QueueProducerPlane === undefined ? undefined : validV2KvPlane(site.v2QueueProducerPlane);
  if (v2ObjectBucketPlane && !hasWorkerdV2PrivateBindingProfile(site)) {
    throw new Error("v2 ObjectBucket service requires the private v2 Worker profile");
  }
  if (v2KvPlane && !hasWorkerdV2PrivateBindingProfile(site)) {
    throw new Error("v2 KV service requires the private v2 Worker profile");
  }
  if (v2QueueProducerPlane && !hasWorkerdV2PrivateBindingProfile(site)) {
    throw new Error("v2 Queue producer service requires the private v2 Worker profile");
  }
  validActorForwardCollision(
    actorForward,
    validBindings(site.vars ?? []),
    serviceBindings,
    hostEntrypoint,
    hasWorkerdV2PrivateBindingProfile(site),
  );
  validWorkflowForwardCollision(
    workflowForward,
    validBindings(site.vars ?? []),
    serviceBindings,
    actorForward,
    hostEntrypoint,
    hasWorkerdV2PrivateBindingProfile(site),
  );
  return {
    manifest: {
      mainModule: site.mainModule,
      ...(hostEntrypoint === undefined ? {} : { hostEntrypoint }),
      ...(site.hostModules && site.hostModules.length > 0
        ? { hostModules: [...site.hostModules] }
        : {}),
      moduleStorageLayout: WORKERD_MODULE_STORAGE_LAYOUT,
      moduleFiles: {
        application: applicationSnapshot.manifest,
        hostPrivate: hostSnapshot.manifest,
      },
      hostnames: validDeploymentHostnames(site.hostnames),
      ...(site.generation === undefined ? {} : { generation: site.generation }),
      ...(workerResourceUid === undefined ? {} : { workerResourceUid }),
      ...(site.fetchHandler === undefined ? {} : { fetchHandler: site.fetchHandler }),
      ...(serviceBindings.length > 0 ? { serviceBindings } : {}),
      ...(actorForward === undefined ? {} : { actorForward }),
      ...(workflowForward === undefined ? {} : { workflowForward }),
      ...(assetDeclaration ? { assets: assetDeclaration.configuration } : {}),
      ...(site.vars && site.vars.length > 0 ? { vars: validBindings(site.vars) } : {}),
      ...(site.modules && site.modules.length > 0 ? { modules: declaredModules } : {}),
      ...(moduleMediaTypes ? { moduleMediaTypes } : {}),
      ...(site.dataPlane ? { dataPlane: validDataPlane(site.dataPlane) } : {}),
      ...(site.events ? { events: validEventGate(site.events) } : {}),
      ...(site.queueSettlement
        ? { queueSettlement: validQueueSettlement(site.queueSettlement) }
        : {}),
      ...(v2ObjectBucketPlane === undefined ? {} : { v2ObjectBucketPlane }),
      ...(v2KvPlane === undefined ? {} : { v2KvPlane }),
      ...(v2QueueProducerPlane === undefined ? {} : { v2QueueProducerPlane }),
    },
    application: applicationSnapshot.entries,
    hostPrivate: hostSnapshot.entries,
    ...(assetDeclaration ? { assets: assetDeclaration.entries } : {}),
  };
}

async function writePreparedWorkerdSite(
  root: string,
  prepared: PreparedWorkerdSite,
): Promise<void> {
  await privateDirectory(root);
  if (!isStaticManifest(prepared.manifest)) {
    await privateDirectory(join(root, APPLICATION_MODULE_DIRECTORY));
  }
  if (prepared.hostPrivate.length > 0) {
    await privateDirectory(join(root, HOST_PRIVATE_MODULE_DIRECTORY));
  }
  if (prepared.assets) await privateDirectory(join(root, ASSETS_ROOT_DIRECTORY));
  for (const entry of prepared.application) {
    await writeFile(join(root, APPLICATION_MODULE_DIRECTORY, entry.key), entry.bytes, {
      mode: 0o600,
    });
  }
  for (const entry of prepared.hostPrivate) {
    await writeFile(join(root, HOST_PRIVATE_MODULE_DIRECTORY, entry.key), entry.bytes, {
      mode: 0o600,
    });
  }
  for (const [assetName, bytes] of prepared.assets ?? []) {
    await writeFile(join(root, ASSETS_ROOT_DIRECTORY, assetName), bytes);
  }
}

/**
 * Private, single-execution materialization. The caller owns a fresh directory
 * and cleanup; this never publishes a route or changes the active graph.
 * Assets/event routers are HTTP delivery services, not class environment
 * bindings. Service bindings require an exact private per-binding gateway
 * mapping acquired from the shared runtime; no target URL is derived here.
 */
function privateClassEventModules(site: WorkerdSite): readonly string[] {
  const eventModules = [
    site.events === undefined ? undefined : validEventGate(site.events).module,
    site.queueSettlement === undefined
      ? undefined
      : validQueueSettlement(site.queueSettlement).module,
  ].filter((name): name is string => name !== undefined);
  if (new Set(eventModules).size !== eventModules.length)
    throw new Error("private event module collision");
  return eventModules;
}

function privateClassHostModuleNames(
  site: WorkerdSite,
  hostModules: readonly string[],
): readonly string[] {
  const removed = new Set(privateClassEventModules(site));
  return hostModules.filter((name) => !removed.has(name));
}

function privateClassHostModules(
  site: WorkerdSite,
  hostModules: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Uint8Array> {
  const eventModules = privateClassEventModules(site);
  if (eventModules.length === 0) return hostModules;
  const selected = new Map(hostModules);
  const removed = new Set(eventModules);
  for (const name of eventModules) {
    // Retained class-only callers may omit bytes for an unused event ingress.
    // If present in a full Version snapshot, they must not enter this class.
    selected.delete(name);
  }
  // The private snapshot must still read each retained byte from the captured
  // source at snapshot time, not an earlier Map copy of those byte references.
  selected.get = (name) => (removed.has(name) ? undefined : hostModules.get(name));
  return selected;
}

export async function writeWorkerdPrivateExecution(options: {
  readonly root: string;
  readonly site: WorkerdSite;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly hostModules: ReadonlyMap<string, Uint8Array>;
  readonly companionAddress?: string;
  /** Internal Actor composition only; never a provider/admission option. */
  readonly actor?: {
    readonly namespaceKey: string;
    readonly storagePath: string;
    readonly ownerModule: string;
    readonly className: string;
    readonly alarmAdmissionAddress: string;
    readonly variants: readonly {
      readonly site: WorkerdSite;
      readonly modules: ReadonlyMap<string, Uint8Array>;
      readonly hostModules: ReadonlyMap<string, Uint8Array>;
      readonly className: string;
      readonly actorForwardSockets?: readonly WorkerdActorForwardSocket[];
      /** Selected v2 outer wrapper before the Host-generated Actor entrypoint. */
      readonly workflowSourceEntrypoint?: string;
      /** Exact pinned broker sockets for this one immutable Version. */
      readonly workflowBindings?: readonly { readonly name: string; readonly socketPath: string }[];
    }[];
  };
  readonly runSocketPath: string;
  /** Separate native duplex lane; the ordinary Bun/HTTP control lane stays unchanged. */
  readonly actorProxySocketPath?: string;
  /** Current Host-owned listener, never the persisted prior-process address. */
  readonly dataPlaneAddress?: string;
  /** Exact child-local guard listeners, not shared sockets or public endpoints. */
  readonly serviceBindings?: readonly { readonly name: string; readonly socketPath: string }[];
  /** The selected Version's active v2 wrapper, before the guarded class entrypoint replaces it. */
  readonly workflowSourceEntrypoint?: string;
  /** Exact selected-incarnation broker UDS mappings, not caller-defined targets. */
  readonly workflowBindings?: readonly { readonly name: string; readonly socketPath: string }[];
}): Promise<string> {
  const { root, site, runSocketPath } = options;
  if (
    !isAbsolute(root) ||
    !isAbsolute(runSocketPath) ||
    runSocketPath.includes("\u0000") ||
    Buffer.byteLength(runSocketPath) > 100 ||
    dirname(runSocketPath) !== root
  ) {
    throw new Error("unusable private execution directory or socket");
  }
  if (!site.hostEntrypoint || site.hostEntrypoint === site.mainModule) {
    throw new Error("private execution requires a distinct Host entrypoint");
  }
  const declaredServices = validServiceBindings(
    site.serviceBindings ?? [],
    hasWorkerdV2PrivateBindingProfile(site),
  );
  const serviceMappings = options.serviceBindings ?? [];
  const serviceNames = new Set(declaredServices.map((binding) => binding.name));
  const servicePaths = new Set<string>();
  if (!Array.isArray(serviceMappings) || serviceMappings.length !== declaredServices.length) {
    throw new Error("private execution service binding bridge is unavailable");
  }
  for (const mapping of serviceMappings) {
    if (
      !mapping ||
      !serviceNames.delete(mapping.name) ||
      typeof mapping.socketPath !== "string" ||
      !isAbsolute(mapping.socketPath) ||
      resolve(mapping.socketPath) !== mapping.socketPath ||
      mapping.socketPath.includes("\u0000") ||
      Buffer.byteLength(mapping.socketPath) > 100 ||
      dirname(mapping.socketPath) !== root ||
      mapping.socketPath === runSocketPath ||
      servicePaths.has(mapping.socketPath)
    ) {
      throw new Error("unusable private execution service binding bridge");
    }
    servicePaths.add(mapping.socketPath);
  }
  const hasV2Workflow = site.workflowForward?.schema === V2_WORKFLOW_FORWARD_SCHEMA;
  const workflowMappings = options.workflowBindings ?? [];
  if (
    !Array.isArray(workflowMappings) ||
    (hasV2Workflow &&
      (options.workflowSourceEntrypoint !== WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE ||
        site.hostEntrypoint === options.workflowSourceEntrypoint ||
        !site.hostModules?.includes(options.workflowSourceEntrypoint) ||
        !options.hostModules.has(options.workflowSourceEntrypoint))) ||
    (!hasV2Workflow &&
      (options.workflowSourceEntrypoint !== undefined || workflowMappings.length !== 0))
  ) {
    throw new Error("unusable private Workflow execution declaration");
  }
  const workflowForward = hasV2Workflow
    ? validWorkflowForward(site.workflowForward, true, true)
    : undefined;
  const workflowNames = new Set(workflowForward?.bindings.map((binding) => binding.serviceName));
  const workflowSocketProofs: { path: string; identity: PrivateSocketIdentity }[] = [];
  if (workflowMappings.length !== workflowNames.size) {
    throw new Error("private Workflow execution broker unavailable");
  }
  for (const mapping of workflowMappings) {
    if (
      !mapping ||
      !workflowNames.delete(mapping.name) ||
      typeof mapping.socketPath !== "string" ||
      !isAbsolute(mapping.socketPath) ||
      resolve(mapping.socketPath) !== mapping.socketPath ||
      mapping.socketPath.includes("\u0000") ||
      Buffer.byteLength(mapping.socketPath) > 100 ||
      !/^[a-f0-9]{22}\.sock$/u.test(
        mapping.socketPath.slice(dirname(mapping.socketPath).length + 1),
      ) ||
      mapping.socketPath === runSocketPath ||
      servicePaths.has(mapping.socketPath)
    ) {
      throw new Error("unusable private Workflow execution broker");
    }
    await requirePrivateSocketDirectory(dirname(mapping.socketPath));
    const identity = await privateSocketMetadata(mapping.socketPath);
    if (!identity) {
      throw new Error("private Workflow execution broker unavailable");
    }
    workflowSocketProofs.push({ path: mapping.socketPath, identity });
    servicePaths.add(mapping.socketPath);
  }
  const actor = options.actor;
  const actorProxySocketPath = options.actorProxySocketPath;
  if (
    (actorProxySocketPath !== undefined && !actor) ||
    (actor &&
      (typeof actorProxySocketPath !== "string" ||
        !isAbsolute(actorProxySocketPath) ||
        actorProxySocketPath.includes("\u0000") ||
        Buffer.byteLength(actorProxySocketPath) > 100 ||
        dirname(actorProxySocketPath) !== root ||
        actorProxySocketPath === runSocketPath ||
        servicePaths.has(actorProxySocketPath)))
  )
    throw new Error("unusable private Actor duplex socket");
  if (
    actor &&
    (!/^[a-f0-9]{64}$/u.test(actor.namespaceKey) ||
      !isAbsolute(actor.storagePath) ||
      actor.storagePath.includes("\u0000") ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(actor.className) ||
      !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(actor.alarmAdmissionAddress))
  ) {
    throw new Error("unusable private Actor execution declaration");
  }
  if (
    actor &&
    (!Array.isArray(actor.variants) || actor.variants.length === 0 || actor.variants.length > 100)
  ) {
    throw new Error("unusable private Actor version graph");
  }
  const companion = actor ? undefined : validDataPlaneAddress(options.companionAddress ?? "");
  const planeAddress =
    options.dataPlaneAddress === undefined
      ? undefined
      : validDataPlaneAddress(options.dataPlaneAddress);
  // Legacy publications retain an old process address and follow the current
  // callback. A v2 private profile (including an Actor's selected Version)
  // must keep its accepted listener exact instead of silently rebinding it.
  const exactV2DataPlane = (declaration: {
    readonly hostEntrypoint?: string;
    readonly hostModules?: readonly string[];
    readonly workflowForward?: WorkerdWorkflowForward;
  }): boolean =>
    hasWorkerdV2PrivateBindingProfile(declaration) ||
    declaration.workflowForward?.schema === V2_WORKFLOW_FORWARD_SCHEMA;
  if (site.dataPlane && !planeAddress) {
    throw new Error(
      exactV2DataPlane(site)
        ? "private data plane listener unavailable"
        : "unusable data plane address",
    );
  }
  // Deliberately select declarations: never carry hostname, assets or event
  // ingress into a guarded class process. Their Host-private module bytes can
  // remain in the exact closed graph without installing their routing services.
  const {
    assets: _assets,
    events: _events,
    queueSettlement: _queueSettlement,
    ...classDeclaration
  } = site;
  const classSite: WorkerdSite = {
    ...classDeclaration,
    ...(site.hostModules === undefined
      ? {}
      : { hostModules: privateClassHostModuleNames(site, site.hostModules) }),
  };
  // Validate the selected v2 outer wrapper as active before replacing only
  // the guarded class entrypoint. Ordinary publication has no such exception.
  const validationSite: WorkerdSite = hasV2Workflow
    ? {
        ...classSite,
        hostnames: [],
        hostEntrypoint: options.workflowSourceEntrypoint as string,
        hostModules: [
          ...(classSite.hostModules ?? []).filter(
            (name) => name !== options.workflowSourceEntrypoint,
          ),
          site.hostEntrypoint,
        ],
      }
    : { ...classSite, hostnames: [] };
  const prepared = await prepareWorkerdSite(
    validationSite,
    options.modules,
    undefined,
    privateClassHostModules(site, options.hostModules),
  );
  const classPrepared: PreparedWorkerdSite<Manifest> = hasV2Workflow
    ? {
        ...prepared,
        manifest: { ...prepared.manifest, hostEntrypoint: site.hostEntrypoint },
      }
    : prepared;
  for (const proof of workflowSocketProofs) {
    await requirePrivateSocketDirectory(dirname(proof.path));
    const current = await privateSocketMetadata(proof.path);
    if (!current || !samePrivateSocketIdentity(proof.identity, current)) {
      throw new Error("private Workflow execution broker changed");
    }
  }
  const bindings = validBindings(prepared.manifest.vars ?? []).map(
    (binding) =>
      `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
  );
  const companionBinding = "__TAKOSERVER_WORKFLOW_COMPANION";
  if (
    prepared.manifest.vars?.some(
      (binding) =>
        binding.name === companionBinding ||
        declaredServices.some((service) => service.name === binding.name) ||
        (prepared.manifest.dataPlane &&
          binding.name ===
            (hasWorkerdV2PrivateBindingProfile(prepared.manifest)
              ? WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING
              : DATA_SERVICE_BINDING)),
    )
  ) {
    throw new Error("private execution internal binding collision");
  }
  if (companion) bindings.push(`(name = ${capnpText(companionBinding)}, service = "companion")`);
  const serviceExternals = serviceMappings
    .map((mapping, index) => {
      const name = `service-${index}`;
      bindings.push(`(name = ${capnpText(mapping.name)}, service = ${capnpText(name)})`);
      return `\n  (name = ${capnpText(name)}, external = (address = ${capnpText(`unix:${mapping.socketPath}`)}, http = (style = proxy))),`;
    })
    .join("");
  const workflowExternals = workflowMappings
    .map((mapping, index) => {
      const name = `workflow-broker-${index}`;
      bindings.push(`(name = ${capnpText(mapping.name)}, service = ${capnpText(name)})`);
      return `\n  (name = ${capnpText(name)}, external = (address = ${capnpText(`unix:${mapping.socketPath}`)}, http = ())),`;
    })
    .join("");
  const privateDataPlane = (
    manifest: Manifest,
    serviceName: string,
    originName: string,
    modulePrefix: string,
  ): { readonly binding: string; readonly services: string } | null => {
    if (!manifest.dataPlane) return null;
    if (!planeAddress) {
      throw new Error(
        exactV2DataPlane(manifest)
          ? "private data plane listener unavailable"
          : "unusable data plane address",
      );
    }
    const plane = validDataPlane(manifest.dataPlane);
    if (exactV2DataPlane(manifest) && plane.address !== planeAddress) {
      throw new Error("private data plane listener changed");
    }
    const module = requiredStoredModule(manifest.moduleFiles.hostPrivate, plane.module);
    const bindingName = hasWorkerdV2PrivateBindingProfile(manifest)
      ? WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING
      : DATA_SERVICE_BINDING;
    if (manifest.vars?.some((entry) => entry.name === bindingName)) {
      throw new Error("private data plane binding collision");
    }
    const facadeBindings = [
      `(name = ${capnpText(DATA_PLANE_BINDING)}, service = ${capnpText(originName)})`,
      ...validBindings(plane.vars).map(
        (binding) =>
          `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
      ),
    ];
    return {
      binding: `(name = ${capnpText(bindingName)}, service = ${capnpText(serviceName)})`,
      services: `
  (name = ${capnpText(serviceName)}, worker = (
    modules = [(name = ${capnpText(plane.module)}, esModule = embed ${capnpText(`${modulePrefix}${HOST_PRIVATE_MODULE_DIRECTORY}/${module.key}`)})],
    bindings = [${facadeBindings.join(", ")}], compatibilityDate = "2026-01-01", globalOutbound = "deny"
  )),
  (name = ${capnpText(originName)}, external = (address = ${capnpText(planeAddress)}, http = ())),`,
    };
  };
  const topLevelDataPlane = privateDataPlane(prepared.manifest, "data", "data-origin", "");
  if (topLevelDataPlane) bindings.push(topLevelDataPlane.binding);
  const dataServices = topLevelDataPlane?.services ?? "";
  let privateQueueProducerServices = "";
  if (!actor && prepared.manifest.v2QueueProducerPlane) {
    const plane = validV2KvPlane(prepared.manifest.v2QueueProducerPlane);
    const module = requiredStoredModule(
      prepared.manifest.moduleFiles.hostPrivate,
      SELFHOST_WORKER_DATA_SERVICE_MODULE,
    );
    bindings.push(
      `(name = ${capnpText(WORKERD_V2_PRIVATE_QUEUE_PRODUCER_BINDING)}, service = "v2-queue-producer")`,
    );
    privateQueueProducerServices = `
  (name = "v2-queue-producer", worker = (
    modules = [(name = ${capnpText(SELFHOST_WORKER_DATA_SERVICE_MODULE)}, esModule = embed ${capnpText(`./${HOST_PRIVATE_MODULE_DIRECTORY}/${module.key}`)})],
    bindings = [
      (name = ${capnpText(SELFHOST_WORKER_DATA_PLANE_BINDING)}, service = "v2-queue-producer-origin"),
      (name = ${capnpText(SELFHOST_WORKER_DATA_TOKEN_BINDING)}, text = ${capnpText(plane.token)})
    ], compatibilityDate = "2026-01-01", globalOutbound = "v2-queue-producer-deny"
  )),
  (name = "v2-queue-producer-origin", external = (address = ${capnpText(plane.address)}, http = ())),
  (name = "v2-queue-producer-deny", network = (allow = [])),`;
  }
  let actorServices = "";
  let actorVersionServices = "";
  let actorVersionExternals = "";
  const actorSocketProofs: { path: string; identity: PrivateSocketIdentity }[] = [];
  const actorSocketOwners = new Map<string, string>();
  const actorPrepared: {
    readonly root: string;
    readonly version: Awaited<ReturnType<typeof prepareWorkerdSite>>;
  }[] = [];
  let actorVersionDataServices = "";
  let actorVersionQueueProducerServices = "";
  if (actor) {
    requiredStoredModule(prepared.manifest.moduleFiles.hostPrivate, actor.ownerModule);
    const actorInternalBindings = new Set([
      "__TAKOSERVER_ACTOR_ALARM_OWNER",
      "NAMESPACE",
      "CLASS",
      "ADMISSION",
      ...actor.variants.map((_, index) => `INSPECT_${index}`),
    ]);
    if (prepared.manifest.vars?.some((binding) => actorInternalBindings.has(binding.name)))
      throw new Error("private Actor alarm binding collision");
    const actorBindings = [
      '(name = "NAMESPACE", durableObjectNamespace = "ActorOwner")',
      '(name = "ADMISSION", service = "actor-alarm-admission")',
    ];
    for (let index = 0; index < actor.variants.length; index += 1) {
      const variant = actor.variants[index];
      if (!variant || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(variant.className)) {
        throw new Error("unusable private Actor class binding");
      }
      const serviceName = `actor-version-${index}`;
      actorBindings.push(
        `(name = ${capnpText(`CLASS_${index}`)}, durableObjectClass = (name = ${capnpText(serviceName)}, entrypoint = ${capnpText(variant.className)}))`,
      );
      actorBindings.push(
        `(name = ${capnpText(`INSPECT_${index}`)}, service = ${capnpText(serviceName)})`,
      );
      // Actor classes have no public asset/event ingress. Those declarations
      // were verified from durable state, but are intentionally not composed
      // into the private class service.
      const {
        assets: _assets,
        events: _events,
        queueSettlement: _queueSettlement,
        ...versionDeclaration
      } = variant.site;
      const versionSite: WorkerdSite = {
        ...versionDeclaration,
        ...(variant.site.hostModules === undefined
          ? {}
          : {
              hostModules: privateClassHostModuleNames(variant.site, variant.site.hostModules),
            }),
      };
      const hasV2ActorWorkflow = versionSite.workflowForward?.schema === V2_WORKFLOW_FORWARD_SCHEMA;
      if (
        (hasV2ActorWorkflow &&
          (variant.workflowSourceEntrypoint !== WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE ||
            versionSite.hostEntrypoint === variant.workflowSourceEntrypoint ||
            !versionSite.hostModules?.includes(variant.workflowSourceEntrypoint) ||
            !variant.hostModules.has(variant.workflowSourceEntrypoint))) ||
        (!hasV2ActorWorkflow &&
          (variant.workflowSourceEntrypoint !== undefined ||
            (variant.workflowBindings?.length ?? 0) !== 0))
      )
        throw new Error("unusable Actor class Workflow source");
      const actorWorkflow = hasV2ActorWorkflow
        ? validWorkflowForward(versionSite.workflowForward, true, true)
        : undefined;
      const actorWorkflowMappings = variant.workflowBindings ?? [];
      const versionBindings: string[] = [];
      if (actorWorkflowMappings.length !== (actorWorkflow?.bindings.length ?? 0))
        throw new Error("Actor class Workflow broker unavailable");
      const mappedWorkflow = new Map(
        actorWorkflowMappings.map((mapping) => [mapping.name, mapping]),
      );
      if (mappedWorkflow.size !== actorWorkflowMappings.length)
        throw new Error("unusable Actor class Workflow broker");
      for (const [bindingIndex, binding] of (actorWorkflow?.bindings ?? []).entries()) {
        const mapping = mappedWorkflow.get(binding.serviceName);
        if (
          !mapping ||
          typeof mapping.socketPath !== "string" ||
          !isAbsolute(mapping.socketPath) ||
          resolve(mapping.socketPath) !== mapping.socketPath ||
          mapping.socketPath.includes("\u0000") ||
          Buffer.byteLength(mapping.socketPath) > 100 ||
          !/^[a-f0-9]{22}\.sock$/u.test(
            mapping.socketPath.slice(dirname(mapping.socketPath).length + 1),
          ) ||
          mapping.socketPath === runSocketPath ||
          mapping.socketPath === actorProxySocketPath ||
          servicePaths.has(mapping.socketPath)
        )
          throw new Error("unusable Actor class Workflow broker");
        await requirePrivateSocketDirectory(dirname(mapping.socketPath));
        const identity = await privateSocketMetadata(mapping.socketPath);
        if (!identity) throw new Error("Actor class Workflow broker unavailable");
        workflowSocketProofs.push({ path: mapping.socketPath, identity });
        servicePaths.add(mapping.socketPath);
        const brokerName = `actor-version-${index}-workflow-${bindingIndex}`;
        versionBindings.push(
          `(name = ${capnpText(binding.serviceName)}, service = ${capnpText(brokerName)})`,
        );
        actorVersionExternals += `\n  (name = ${capnpText(brokerName)}, external = (address = ${capnpText(`unix:${mapping.socketPath}`)}, http = ())),`;
        mappedWorkflow.delete(binding.serviceName);
      }
      const validationVersionSite: WorkerdSite = hasV2ActorWorkflow
        ? {
            ...versionSite,
            hostnames: [],
            hostEntrypoint: variant.workflowSourceEntrypoint as string,
            hostModules: [
              ...(versionSite.hostModules ?? []).filter(
                (name) => name !== variant.workflowSourceEntrypoint,
              ),
              versionSite.hostEntrypoint as string,
            ],
          }
        : { ...versionSite, hostnames: [] };
      const validatedVersion = await prepareWorkerdSite(
        validationVersionSite,
        variant.modules,
        undefined,
        privateClassHostModules(variant.site, variant.hostModules),
      );
      const version: PreparedWorkerdSite<Manifest> = hasV2ActorWorkflow
        ? {
            ...validatedVersion,
            manifest: {
              ...validatedVersion.manifest,
              hostEntrypoint: versionSite.hostEntrypoint as string,
            },
          }
        : validatedVersion;
      const versionRoot = join(root, "actor-versions", String(index));
      const versionPrefix = `./actor-versions/${index}`;
      actorPrepared.push({ root: versionRoot, version });
      versionBindings.unshift(
        ...validBindings(version.manifest.vars ?? []).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      );
      if (version.manifest.dataPlane) {
        if (!hasWorkerdV2PrivateBindingProfile(version.manifest)) {
          throw new Error("Actor retained data plane requires v2 private binding profile");
        }
        const plane = validDataPlane(version.manifest.dataPlane);
        if (
          plane.module !== SELFHOST_WORKER_DATA_SERVICE_MODULE ||
          !Array.isArray(plane.vars) ||
          plane.vars.length !== 1 ||
          plane.vars[0]?.name !== SELFHOST_WORKER_DATA_TOKEN_BINDING ||
          plane.vars[0].kind !== "text" ||
          typeof plane.vars[0].value !== "string" ||
          !plane.vars[0].value
        ) {
          throw new Error("Actor retained v2 data plane is unavailable");
        }
        const retained = privateDataPlane(
          version.manifest,
          `actor-version-${index}-selfhost-data`,
          `actor-version-${index}-selfhost-data-origin`,
          `${versionPrefix}/`,
        );
        if (!retained) throw new Error("Actor retained v2 data plane is unavailable");
        versionBindings.push(retained.binding);
        actorVersionDataServices += retained.services;
      }
      if (version.manifest.v2QueueProducerPlane) {
        if (!hasWorkerdV2PrivateBindingProfile(version.manifest))
          throw new Error("Actor retained Queue producer requires v2 private binding profile");
        const plane = validV2KvPlane(version.manifest.v2QueueProducerPlane);
        const module = requiredStoredModule(
          version.manifest.moduleFiles.hostPrivate,
          SELFHOST_WORKER_DATA_SERVICE_MODULE,
        );
        const producer = `actor-version-${index}-v2-queue-producer`;
        const origin = `${producer}-origin`;
        versionBindings.push(
          `(name = ${capnpText(WORKERD_V2_PRIVATE_QUEUE_PRODUCER_BINDING)}, service = ${capnpText(producer)})`,
        );
        actorVersionQueueProducerServices += `
  (name = ${capnpText(producer)}, worker = (
    modules = [(name = ${capnpText(SELFHOST_WORKER_DATA_SERVICE_MODULE)}, esModule = embed ${capnpText(`${versionPrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${module.key}`)})],
    bindings = [
      (name = ${capnpText(SELFHOST_WORKER_DATA_PLANE_BINDING)}, service = ${capnpText(origin)}),
      (name = ${capnpText(SELFHOST_WORKER_DATA_TOKEN_BINDING)}, text = ${capnpText(plane.token)})
    ], compatibilityDate = "2026-01-01", globalOutbound = "v2-queue-producer-deny"
  )),
  (name = ${capnpText(origin)}, external = (address = ${capnpText(plane.address)}, http = ())),`;
      }
      // The class sees only its own immutable Version's declared bindings.
      // Reuse the provider Worker's exact incumbent brokers; never mint a new
      // token or infer a target from a request URL in the Actor child.
      if (version.manifest.actorForward && hasWorkerdV2PrivateBindingProfile(version.manifest)) {
        const declared = validActorForward(version.manifest.actorForward, true);
        const sockets = validActorForwardSockets(variant.actorForwardSockets);
        for (const [bindingIndex, binding] of declared.bindings.entries()) {
          const socket = sockets.get(
            actorForwardIdentity(binding.tenantId, binding.namespaceResourceUid, binding.token),
          );
          if (!socket || socket.token !== binding.token)
            throw new Error("Actor class forward broker unavailable");
          for (const [kind, path] of [
            ["http", socket.httpSocketPath],
            ["upgrade", socket.upgradeSocketPath],
          ] as const) {
            const socketOwner = `${actorForwardIdentity(binding.tenantId, binding.namespaceResourceUid, binding.token)}:${kind}`;
            const previousOwner = actorSocketOwners.get(path);
            if (
              path === runSocketPath ||
              path === actorProxySocketPath ||
              (servicePaths.has(path) && previousOwner !== socketOwner)
            )
              throw new Error("unusable Actor class forward broker");
            await requirePrivateSocketDirectory(dirname(path));
            const identity = await privateSocketMetadata(path);
            if (!identity) throw new Error("Actor class forward broker unavailable");
            actorSocketProofs.push({ path, identity });
            actorSocketOwners.set(path, socketOwner);
            servicePaths.add(path);
          }
          const httpService = `actor-version-${index}-forward-http-${bindingIndex}`;
          const upgradeService = `actor-version-${index}-forward-upgrade-${bindingIndex}`;
          versionBindings.push(
            `(name = ${capnpText(binding.httpService)}, service = ${capnpText(httpService)})`,
            `(name = ${capnpText(binding.upgradeService)}, service = ${capnpText(upgradeService)})`,
          );
          actorVersionExternals += `
  (name = ${capnpText(httpService)}, external = (address = ${capnpText(`unix:${socket.httpSocketPath}`)}, http = ())),
  (name = ${capnpText(upgradeService)}, external = (address = ${capnpText(`unix:${socket.upgradeSocketPath}`)}, http = (style = proxy))),`;
        }
      }
      if (
        version.manifest.vars?.some((binding) => binding.name === "__TAKOSERVER_ACTOR_ALARM_OWNER")
      ) {
        throw new Error("private Actor internal binding collision");
      }
      versionBindings.push('(name = "__TAKOSERVER_ACTOR_ALARM_OWNER", service = "actor-owner")');
      actorVersionServices += `
  (name = ${capnpText(serviceName)}, worker = (
    modules = [${renderWorkerdModules(version.manifest, versionPrefix)}],
    modulePolicy = (applicationMain = ${capnpText(version.manifest.mainModule)}),
    compatibilityDate = "2026-01-01", compatibilityFlags = [${[...APPLICATION_COMPATIBILITY_FLAGS, "experimental"].map(capnpText).join(", ")}], globalOutbound = "deny",
    bindings = [${versionBindings.join(", ")}]
  )),`;
    }
    actorServices = `
  (name = "actor-owner", worker = (
    modules = [${renderWorkerdModules({ ...prepared.manifest, hostEntrypoint: actor.ownerModule }, ".")}],
    modulePolicy = (applicationMain = ${capnpText(prepared.manifest.mainModule)}),
    compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental", "disallow_importable_env"], globalOutbound = "deny",
    bindings = [${actorBindings.join(", ")}],
    durableObjectNamespaces = [(className = "ActorOwner", uniqueKey = ${capnpText(actor.namespaceKey)}, enableSql = true)],
    durableObjectStorage = (localDisk = "actor-storage")
  )),
  (name = "actor-storage", disk = (path = ${capnpText(actor.storagePath)}, writable = true)),
  (name = "actor-alarm-admission", external = (address = ${capnpText(actor.alarmAdmissionAddress)}, http = ())),`;
  }
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "application", worker = (
    modules = [${renderWorkerdModules(classPrepared.manifest, ".")}],
    bindings = [${[...bindings, ...(actor ? ['(name = "__TAKOSERVER_ACTOR_ALARM_OWNER", service = "actor-owner")'] : [])].join(", ")}],
    modulePolicy = (applicationMain = ${capnpText(prepared.manifest.mainModule)}),
    compatibilityDate = "2026-01-01",
    compatibilityFlags = [${(actor ? [...APPLICATION_COMPATIBILITY_FLAGS, "experimental"] : APPLICATION_COMPATIBILITY_FLAGS).map(capnpText).join(", ")}],
    globalOutbound = "deny"
  )),
  ${companion ? `(name = "companion", external = (address = ${capnpText(companion)}, http = ())),` : ""}${dataServices}${privateQueueProducerServices}${serviceExternals}${workflowExternals}${actorVersionServices}${actorVersionDataServices}${actorVersionQueueProducerServices}${actorVersionQueueProducerServices ? '\n  (name = "v2-queue-producer-deny", network = (allow = [])),' : ""}${actorVersionExternals}${actorServices}
  (name = "deny", network = (allow = []))
 ],
 sockets = [(name = ${capnpText(actor ? "actor" : "workflow")}, address = ${capnpText(`unix:${runSocketPath}`)}, http = (), service = ${capnpText(actor ? "actor-owner" : "application")})${actor ? `, (name = "actor-duplex", address = ${capnpText(`unix:${actorProxySocketPath}`)}, http = (style = proxy), service = "actor-owner")` : ""}]
);`;
  await writePreparedWorkerdSite(root, classPrepared);
  for (const { root: versionRoot, version } of actorPrepared) {
    await writePreparedWorkerdSite(versionRoot, version);
  }
  // Actor Version Workflow brokers were discovered after the top-level
  // pre-render check. Recheck every pinned listener after all class bytes are
  // written, immediately before the native config becomes launchable.
  for (const proof of workflowSocketProofs) {
    await requirePrivateSocketDirectory(dirname(proof.path));
    const current = await privateSocketMetadata(proof.path);
    if (!current || !samePrivateSocketIdentity(proof.identity, current))
      throw new Error("private Workflow execution broker changed");
  }
  for (const proof of actorSocketProofs) {
    await requirePrivateSocketDirectory(dirname(proof.path));
    const current = await privateSocketMetadata(proof.path);
    if (!current || !samePrivateSocketIdentity(proof.identity, current))
      throw new Error("Actor class forward broker changed");
  }
  const configPath = join(root, "workerd.capnp");
  await writeFile(configPath, config, { mode: 0o600, flag: "wx" });
  return configPath;
}

/**
 * The hostname the router answers this Host's own questions about a script on.
 *
 * Derived from the script name rather than stored, so it cannot drift from the
 * service it names and no manifest can claim somebody else's.
 */
export function internalHostname(script: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(script)) {
    throw new Error(`unusable script name: ${script}`);
  }
  if (script.length <= 63 && INTERNAL_HOST_DNS_LABEL.test(script)) {
    return `${script}${INTERNAL_ROUTE_SUFFIX}`;
  }
  const digest = createHash("sha256").update(script, "utf8").digest("hex");
  // Accepted internal script names are single labels. This reserved two-label
  // alias is therefore disjoint from every legacy hostname while remaining
  // stable and collision-resistant without changing the script/path identity.
  return `v2-${digest.slice(0, 32)}.${digest.slice(32)}${INTERNAL_ROUTE_SUFFIX}`;
}

/** The hostname a queue batch or a cron match is delivered on. */
export function eventHostname(script: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(script)) {
    throw new Error(`unusable script name: ${script}`);
  }
  return `${script}${EVENT_ROUTE_SUFFIX}`;
}

/**
 * A capnp text literal.
 *
 * This configuration is assembled by concatenating strings, and the values in
 * it are a tenant's. An unescaped quote would close the literal and let the
 * rest of a value be read as configuration — the next binding, the next
 * service, or the socket. Everything printable stays as itself so the file
 * remains readable by an operator; the rest is escaped, and the two characters
 * capnp Text cannot carry at all are refused.
 */
function capnpText(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) throw new Error("unusable worker binding value");
    if (code >= 0xd800 && code <= 0xdfff) throw new Error("unusable worker binding value");
    switch (character) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\v":
        out += "\\v";
        continue;
      default:
        break;
    }
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    out += character;
  }
  return `${out}"`;
}

async function readActivation(path: string): Promise<Record<string, string | null>> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record: Record<string, string | null> = {};
    for (const [name, generation] of Object.entries(parsed)) {
      if (generation !== null && typeof generation !== "string") return {};
      record[name] = generation;
    }
    return record;
  } catch {
    return {};
  }
}

async function writeActivation(path: string, active: Record<string, string | null>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(active), "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

interface PublishedVariant {
  /** Runtime-private service name; equal to the script only for legacy sites. */
  readonly name: string;
  readonly logicalName: string;
  /** Path relative to the generated config for module embeds. */
  readonly storagePrefix: string;
  /** Absolute immutable asset directory used by workerd's disk service. */
  readonly assetRoot: string;
  readonly manifest: StoredManifest;
  readonly versionId?: string;
  readonly workerVersionUid?: string;
  readonly weight?: number;
}

interface PublishedDeployment {
  readonly name: string;
  readonly generation?: string;
  readonly workerResourceUid?: string;
  readonly hostnames: readonly string[];
  readonly weighted: boolean;
  readonly variants: readonly PublishedVariant[];
}

function exactPublishedIdentity(
  entry: PublishedDeployment | undefined,
): WorkerdPublicationIdentity | null {
  if (entry === undefined) return null;
  if (!entry.weighted || entry.generation === undefined || entry.workerResourceUid === undefined) {
    throw new Error("current worker publication has no weighted identity");
  }
  capnpText(entry.generation);
  return {
    generation: entry.generation,
    workerResourceUid: validWorkerResourceUid(entry.workerResourceUid),
    hostnames: [...validDeploymentHostnames(entry.hostnames)].sort(),
    versions: canonicalSelfhostWeightedVersions(
      entry.variants.map((variant) => ({
        versionId: variant.versionId,
        workerVersionUid: variant.workerVersionUid,
        weight: variant.weight,
      })),
    ),
  };
}

/**
 * Optional byte collectors used by the active-version reader.
 *
 * The collectors are fed by the same reads that verify each durable digest;
 * there is intentionally no verify-then-reread path for snapshot material.
 */
interface ReadbackCapture {
  readonly application?: Map<string, Uint8Array>;
  readonly hostPrivate?: Map<string, Uint8Array>;
  readonly assets?: Map<string, Uint8Array>;
}

/**
 * Whether this publication runs through a generated entrypoint.
 *
 * The entrypoint identity is explicit. A retained manifest from the former
 * flat registry has no provenance layout and is rejected by readback rather
 * than silently serving with an open graph.
 */
function hasHostEntrypoint(entry: PublishedVariant): boolean {
  return entry.manifest.hostEntrypoint !== undefined;
}

function hasHostReadiness(entry: PublishedVariant): boolean {
  return isStaticManifest(entry.manifest) || hasHostEntrypoint(entry);
}

/** Exact private asset readback used before restart or configuration reload. */
async function readPublishedAssetSnapshot(
  root: string,
  value: unknown,
  capture?: Map<string, Uint8Array>,
  staticOnly = false,
): Promise<WorkerdAssetManifest | undefined> {
  const manifest = validAssetManifest(value, staticOnly);
  if (!manifest) return undefined;
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("unusable worker asset snapshot");
  }
  const entries = await readdir(root, { withFileTypes: true });
  const expected = new Set(Object.values(manifest.files).map((entry) => entry.key));
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))
  ) {
    throw new Error("unusable worker asset snapshot");
  }
  for (const [logicalPath, entry] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(root, entry.key));
    if (bytes.byteLength !== entry.size || (await bytesDigest(bytes)) !== entry.digest) {
      throw new Error("unusable worker asset snapshot");
    }
    // Capture the logical path, never the operator-private flat key. The
    // caller owns a copy, and this is the same read that just passed the
    // size/digest fence above.
    capture?.set(logicalPath, new Uint8Array(bytes));
  }
  return manifest;
}

function validStoredModuleInventory(
  value: unknown,
  expectedNames: readonly string[],
): readonly WorkerdStoredModule[] {
  if (!Array.isArray(value) || value.length !== expectedNames.length) {
    throw new Error("unusable worker module storage manifest");
  }
  let total = 0;
  return value.map((candidate, index) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "digest,key,name,size"
    ) {
      throw new Error("unusable worker module storage manifest");
    }
    const record = candidate as Record<string, unknown>;
    const expectedKey = `module-${index.toString(10).padStart(5, "0")}`;
    if (
      record.name !== expectedNames[index] ||
      record.key !== expectedKey ||
      !Number.isSafeInteger(record.size) ||
      (record.size as number) < 0 ||
      typeof record.digest !== "string" ||
      !SHA256_DIGEST.test(record.digest)
    ) {
      throw new Error("unusable worker module storage manifest");
    }
    total += record.size as number;
    if (!Number.isSafeInteger(total) || total > 268_435_456) {
      throw new Error("unusable worker module storage manifest");
    }
    return {
      name: record.name as string,
      key: record.key,
      size: record.size as number,
      digest: record.digest as `sha256:${string}`,
    };
  });
}

async function verifyStoredModuleDirectory(
  root: string,
  inventory: readonly WorkerdStoredModule[],
  capture?: Map<string, Uint8Array>,
): Promise<void> {
  const rootStat = await lstat(root).catch(() => null);
  if (inventory.length === 0) {
    if (rootStat === null) return;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("unusable worker module storage snapshot");
    }
  } else if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("unusable worker module storage snapshot");
  }
  const entries = await readdir(root, { withFileTypes: true });
  const expected = new Set(inventory.map((entry) => entry.key));
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))
  ) {
    throw new Error("unusable worker module storage snapshot");
  }
  for (const entry of inventory) {
    const bytes = await readFile(join(root, entry.key));
    if (bytes.byteLength !== entry.size || (await bytesDigest(bytes)) !== entry.digest) {
      throw new Error("unusable worker module storage snapshot");
    }
    // The digest fence and the returned bytes come from one read. Keys exposed
    // to callers are logical module names, never private ordinal filenames.
    capture?.set(entry.name, new Uint8Array(bytes));
  }
}

async function readPublishedModuleSnapshot(
  root: string,
  manifest: Manifest,
  capture?: Pick<ReadbackCapture, "application" | "hostPrivate">,
): Promise<WorkerdModuleStorageManifest> {
  if (
    manifest.moduleStorageLayout !== WORKERD_MODULE_STORAGE_LAYOUT ||
    typeof manifest.moduleFiles !== "object" ||
    manifest.moduleFiles === null ||
    Array.isArray(manifest.moduleFiles) ||
    Object.keys(manifest.moduleFiles).sort().join(",") !== "application,hostPrivate"
  ) {
    throw new Error("unusable worker module storage manifest");
  }
  const applicationNames = [manifest.mainModule, ...(manifest.modules ?? [])];
  const hostNames = validHostModuleNames(manifest, manifest.hostEntrypoint);
  const application = validStoredModuleInventory(
    (manifest.moduleFiles as unknown as Record<string, unknown>).application,
    applicationNames,
  );
  const hostPrivate = validStoredModuleInventory(
    (manifest.moduleFiles as unknown as Record<string, unknown>).hostPrivate,
    hostNames,
  );
  await verifyStoredModuleDirectory(
    join(root, APPLICATION_MODULE_DIRECTORY),
    application,
    capture?.application,
  );
  await verifyStoredModuleDirectory(
    join(root, HOST_PRIVATE_MODULE_DIRECTORY),
    hostPrivate,
    capture?.hostPrivate,
  );
  return { application, hostPrivate };
}

async function readValidatedManifest(
  moduleRoot: string,
  assetRoot: string,
  value: unknown,
  capture?: ReadbackCapture,
): Promise<StoredManifest> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("unusable worker runtime manifest");
  }
  const candidate = value as Record<string, unknown>;
  if ("kind" in candidate) {
    if (
      Object.keys(candidate).sort().join(",") !==
        "assets,fetchHandler,generation,hostnames,kind,workerResourceUid" ||
      candidate.kind !== "static" ||
      candidate.fetchHandler !== false ||
      typeof candidate.generation !== "string" ||
      typeof candidate.workerResourceUid !== "string"
    )
      throw new Error("unusable static Worker Version manifest");
    capnpText(candidate.generation);
    validWorkerResourceUid(candidate.workerResourceUid);
    const hostnames = validDeploymentHostnames(candidate.hostnames);
    await verifyStoredModuleDirectory(
      join(moduleRoot, APPLICATION_MODULE_DIRECTORY),
      [],
      capture?.application,
    );
    await verifyStoredModuleDirectory(
      join(moduleRoot, HOST_PRIVATE_MODULE_DIRECTORY),
      [],
      capture?.hostPrivate,
    );
    const assets = await readPublishedAssetSnapshot(
      assetRoot,
      candidate.assets,
      capture?.assets,
      true,
    );
    if (assets?.runWorkerFirst !== false) {
      throw new Error("unusable static Worker Version manifest");
    }
    return {
      kind: "static",
      hostnames,
      generation: candidate.generation,
      workerResourceUid: candidate.workerResourceUid,
      fetchHandler: false,
      assets,
    };
  }
  // The legacy schema is the same known field set without optional forward
  // projections. Never reinterpret an unknown old field as a capability.
  if (Object.keys(value).some((key) => !ACTOR_FORWARD_MANIFEST_KEYS.has(key)))
    throw new Error("unusable worker runtime manifest");
  let manifest = value as Manifest;
  if (
    typeof manifest.mainModule !== "string" ||
    (manifest.generation !== undefined && typeof manifest.generation !== "string")
  ) {
    throw new Error("unusable worker runtime manifest");
  }
  validModules([manifest.mainModule]);
  const declaredModules = validModules(manifest.modules ?? [], manifest.mainModule);
  validModuleMediaTypes(manifest.mainModule, declaredModules, manifest.moduleMediaTypes);
  const moduleFiles = await readPublishedModuleSnapshot(moduleRoot, manifest, capture);
  manifest = { ...manifest, moduleFiles };
  const assets = await readPublishedAssetSnapshot(assetRoot, manifest.assets, capture?.assets);
  if (assets) manifest = { ...manifest, assets };
  const vars = validBindings(manifest.vars ?? []);
  if (manifest.workerResourceUid !== undefined) {
    validWorkerResourceUid(manifest.workerResourceUid);
  }
  if (
    (manifest.workerResourceUid === undefined) !== (manifest.fetchHandler === undefined) ||
    (manifest.fetchHandler !== undefined && typeof manifest.fetchHandler !== "boolean")
  ) {
    throw new Error("unusable worker service identity");
  }
  const serviceBindings = validServiceBindings(
    manifest.serviceBindings ?? [],
    hasWorkerdV2PrivateBindingProfile(manifest),
  );
  if (serviceBindings.length > 0 && manifest.workerResourceUid === undefined) {
    throw new Error("unusable worker service binding");
  }
  const actorForward =
    manifest.actorForward === undefined
      ? undefined
      : validActorForward(manifest.actorForward, hasWorkerdV2PrivateBindingProfile(manifest));
  const workflowForward =
    manifest.workflowForward === undefined
      ? undefined
      : validWorkflowForward(
          manifest.workflowForward,
          hasWorkerdV2PrivateBindingProfile(manifest),
          manifest.hostEntrypoint === WORKERD_V2_PRIVATE_WORKFLOW_ENTRYPOINT_MODULE,
        );
  validActorForwardCollision(
    actorForward,
    vars,
    serviceBindings,
    manifest.hostEntrypoint,
    hasWorkerdV2PrivateBindingProfile(manifest),
  );
  validWorkflowForwardCollision(
    workflowForward,
    vars,
    serviceBindings,
    actorForward,
    manifest.hostEntrypoint,
    hasWorkerdV2PrivateBindingProfile(manifest),
  );
  if (actorForward) manifest = { ...manifest, actorForward };
  if (workflowForward) manifest = { ...manifest, workflowForward };
  if (manifest.dataPlane !== undefined) validDataPlane(manifest.dataPlane);
  if (manifest.events !== undefined) validEventGate(manifest.events);
  if (manifest.queueSettlement !== undefined) validQueueSettlement(manifest.queueSettlement);
  if (manifest.v2ObjectBucketPlane !== undefined) {
    validV2ObjectBucketPlane(manifest.v2ObjectBucketPlane);
    if (!hasWorkerdV2PrivateBindingProfile(manifest)) {
      throw new Error("v2 ObjectBucket service requires the private v2 Worker profile");
    }
  }
  if (manifest.v2KvPlane !== undefined) {
    validV2KvPlane(manifest.v2KvPlane);
    if (!hasWorkerdV2PrivateBindingProfile(manifest)) {
      throw new Error("v2 KV service requires the private v2 Worker profile");
    }
  }
  if (manifest.v2QueueProducerPlane !== undefined) {
    validV2KvPlane(manifest.v2QueueProducerPlane);
    if (!hasWorkerdV2PrivateBindingProfile(manifest)) {
      throw new Error("v2 Queue producer service requires the private v2 Worker profile");
    }
  }
  return manifest;
}

function validDeploymentHostnames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("unusable worker deployment hostnames");
  }
  const hostnames = value as readonly string[];
  if (new Set(hostnames).size !== hostnames.length) {
    throw new Error("unusable worker deployment hostnames");
  }
  for (const hostname of hostnames) capnpText(hostname);
  return [...hostnames];
}

function privateVariantServiceName(
  script: string,
  generationKey: string,
  workerVersionUid: string,
): string {
  const digest = createHash("sha256")
    .update("takoserver.selfhost-private-version@v1\u0000", "utf8")
    .update(script, "utf8")
    .update("\u0000", "utf8")
    .update(generationKey, "utf8")
    .update("\u0000", "utf8")
    .update(workerVersionUid, "utf8")
    .digest("hex");
  return `selfhost-version-${digest}`;
}

interface WeightedDeploymentSnapshot {
  readonly pointer: WorkerdDeploymentPointer;
  readonly deployment: WorkerdDeploymentManifest;
  readonly generationRoot: string;
  readonly hostnames: readonly string[];
  readonly canonical: readonly SelfhostWeightedVersion[];
}

async function readWeightedDeploymentSnapshot(
  scriptsRoot: string,
  script: string,
  pointerValue: unknown,
): Promise<WeightedDeploymentSnapshot> {
  if (
    typeof pointerValue !== "object" ||
    pointerValue === null ||
    Array.isArray(pointerValue) ||
    Object.keys(pointerValue).sort().join(",") !==
      "generation,generationKey,publicationStorageLayout"
  ) {
    throw new Error("unusable worker deployment pointer");
  }
  const pointer = pointerValue as WorkerdDeploymentPointer;
  if (
    pointer.publicationStorageLayout !== WORKERD_DEPLOYMENT_STORAGE_LAYOUT ||
    typeof pointer.generation !== "string" ||
    typeof pointer.generationKey !== "string" ||
    !/^[0-9a-f]{64}$/u.test(pointer.generationKey)
  ) {
    throw new Error("unusable worker deployment pointer");
  }
  const generationRoot = join(
    scriptsRoot,
    DEPLOYMENT_PUBLICATIONS_DIRECTORY,
    script,
    pointer.generationKey,
  );
  const raw = await readFile(join(generationRoot, DEPLOYMENT_MANIFEST), "utf8");
  if (createHash("sha256").update(raw, "utf8").digest("hex") !== pointer.generationKey) {
    throw new Error("unusable worker deployment snapshot");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("unusable worker deployment manifest");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "generation,hostnames,publicationStorageLayout,versions,workerResourceUid"
  ) {
    throw new Error("unusable worker deployment manifest");
  }
  const deployment = parsed as WorkerdDeploymentManifest;
  if (
    deployment.publicationStorageLayout !== WORKERD_DEPLOYMENT_STORAGE_LAYOUT ||
    deployment.generation !== pointer.generation ||
    typeof deployment.workerResourceUid !== "string" ||
    !Array.isArray(deployment.versions)
  ) {
    throw new Error("unusable worker deployment manifest");
  }
  validWorkerResourceUid(deployment.workerResourceUid);
  const hostnames = validDeploymentHostnames(deployment.hostnames);
  for (let index = 0; index < deployment.versions.length; index += 1) {
    const stored = deployment.versions[index];
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      Object.keys(stored).sort().join(",") !==
        "manifest,storageKey,versionId,weight,workerVersionUid" ||
      stored.storageKey !== `version-${index.toString(10).padStart(5, "0")}`
    ) {
      throw new Error("unusable worker deployment manifest");
    }
  }
  const canonical = canonicalSelfhostWeightedVersions(
    deployment.versions.map((version) => ({
      versionId: version.versionId,
      workerVersionUid: version.workerVersionUid,
      weight: version.weight,
    })),
  );
  for (let index = 0; index < deployment.versions.length; index += 1) {
    const stored = deployment.versions[index] as WorkerdDeploymentStoredVersion;
    const identity = canonical[index];
    if (
      !identity ||
      stored.versionId !== identity.versionId ||
      stored.workerVersionUid !== identity.workerVersionUid ||
      stored.weight !== identity.weight
    ) {
      throw new Error("unusable worker deployment manifest");
    }
  }
  return { pointer, deployment, generationRoot, hostnames, canonical };
}

async function readWeightedDeployment(
  scriptsRoot: string,
  script: string,
  pointerValue: unknown,
): Promise<PublishedDeployment> {
  const { pointer, deployment, generationRoot, hostnames, canonical } =
    await readWeightedDeploymentSnapshot(scriptsRoot, script, pointerValue);
  const variants: PublishedVariant[] = [];
  for (let index = 0; index < deployment.versions.length; index += 1) {
    const stored = deployment.versions[index] as WorkerdDeploymentStoredVersion;
    const identity = canonical[index];
    if (
      !identity ||
      stored.versionId !== identity.versionId ||
      stored.workerVersionUid !== identity.workerVersionUid ||
      stored.weight !== identity.weight
    ) {
      throw new Error("unusable worker deployment manifest");
    }
    const moduleRoot = join(generationRoot, stored.storageKey);
    const manifest = await readValidatedManifest(
      moduleRoot,
      join(moduleRoot, ASSETS_ROOT_DIRECTORY),
      stored.manifest,
    );
    if (
      manifest.generation !== deployment.generation ||
      manifest.workerResourceUid !== deployment.workerResourceUid ||
      manifest.hostnames.length !== 0
    ) {
      throw new Error("unusable worker deployment Version");
    }
    variants.push({
      name: privateVariantServiceName(script, pointer.generationKey, stored.workerVersionUid),
      logicalName: script,
      storagePrefix: `${DEPLOYMENT_PUBLICATIONS_DIRECTORY}/${script}/${pointer.generationKey}/${stored.storageKey}`,
      assetRoot: join(moduleRoot, ASSETS_ROOT_DIRECTORY),
      manifest,
      versionId: stored.versionId,
      workerVersionUid: stored.workerVersionUid,
      weight: stored.weight,
    });
  }
  return {
    name: script,
    generation: deployment.generation,
    workerResourceUid: deployment.workerResourceUid,
    hostnames,
    weighted: true,
    variants,
  };
}

async function readActivationStrict(path: string): Promise<Record<string, string | null>> {
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("unusable worker activation marker");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("unusable worker activation marker");
  }
  const active: Record<string, string | null> = {};
  for (const [name, generation] of Object.entries(parsed)) {
    if (!SCRIPT_NAME.test(name) || (generation !== null && typeof generation !== "string")) {
      throw new Error("unusable worker activation marker");
    }
    active[name] = generation;
  }
  return active;
}

/**
 * Reads the immutable weighted identity that both the stable pointer and the
 * last proven activation marker name. This is the event selector's serving
 * authority: provider desired state may legitimately be one reconcile ahead
 * after a failed activation, but it must never select an unserved Version.
 */
export async function readWorkerdActiveDeployment(
  root: string,
  script: string,
): Promise<WorkerdActiveDeployment | null> {
  if (!SCRIPT_NAME.test(script)) throw new Error("unusable script name");
  const scriptsRoot = join(root, "workers");
  const activationPath = join(scriptsRoot, ".takoserver-active.json");
  const before = await readActivationStrict(activationPath);
  const activeGeneration = before[script];
  if (typeof activeGeneration !== "string") return null;
  const pointerRaw = await readFile(join(scriptsRoot, script, MANIFEST), "utf8").catch(
    (error: unknown) => {
      if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
      throw error;
    },
  );
  if (pointerRaw === null) return null;
  let pointer: unknown;
  try {
    pointer = JSON.parse(pointerRaw);
  } catch {
    throw new Error("unusable worker deployment pointer");
  }
  const snapshot = await readWeightedDeploymentSnapshot(scriptsRoot, script, pointer);
  const eventShapes = new Set<boolean>();
  const v2QueueShapes = new Set<boolean>();
  for (const stored of snapshot.deployment.versions) {
    const manifest: unknown = stored.manifest;
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error("unusable worker deployment Version");
    }
    const identity = manifest as Partial<Manifest>;
    if (
      identity.generation !== snapshot.deployment.generation ||
      identity.workerResourceUid !== snapshot.deployment.workerResourceUid ||
      !Array.isArray(identity.hostnames) ||
      identity.hostnames.length !== 0
    ) {
      throw new Error("unusable worker deployment Version");
    }
    if (identity.events !== undefined) validEventGate(identity.events);
    if (identity.queueSettlement !== undefined) validQueueSettlement(identity.queueSettlement);
    eventShapes.add(identity.events !== undefined);
    v2QueueShapes.add(identity.queueSettlement !== undefined);
  }
  if (eventShapes.size !== 1) throw new Error("unusable worker deployment event graph");
  if (v2QueueShapes.size !== 1 || (v2QueueShapes.has(true) && !eventShapes.has(true))) {
    throw new Error("unusable worker deployment v2 Queue graph");
  }
  const after = await readActivationStrict(activationPath);
  if (after[script] !== activeGeneration || snapshot.deployment.generation !== activeGeneration) {
    return null;
  }
  return {
    generation: activeGeneration,
    versions: snapshot.canonical,
    events: eventShapes.has(true),
  };
}

/**
 * Reads one caller-owned Version snapshot from the active private publication.
 *
 * This is deliberately a Host-private seam rather than a provider API. It
 * authenticates the active marker, stable pointer, immutable deployment
 * manifest, and selected module/asset bytes, then fences the result with an
 * exact final marker/pointer reread. A crossing or stale expected Worker UID
 * returns `null`; malformed or tampered durable state throws one generic error
 * without exposing bindings or operator-private paths.
 */
interface SelectedActiveVersionOptions {
  readonly expectedWorkerResourceUid: string;
  readonly basisPoint: number;
}

export async function readWorkerdSelectedActiveVersion(
  root: string,
  script: string,
  options: SelectedActiveVersionOptions & { readonly includeStatic: true },
): Promise<WorkerdSelectedActiveVersion<WorkerdSite | WorkerdStaticSite> | null>;
export async function readWorkerdSelectedActiveVersion(
  root: string,
  script: string,
  options: SelectedActiveVersionOptions & { readonly includeStatic?: false },
): Promise<WorkerdSelectedActiveVersion | null>;
export async function readWorkerdSelectedActiveVersion(
  root: string,
  script: string,
  options: SelectedActiveVersionOptions & { readonly includeStatic?: boolean },
): Promise<WorkerdSelectedActiveVersion<WorkerdSite | WorkerdStaticSite> | null> {
  return await readWorkerdSelectedVersion(root, script, options, { kind: "active" });
}

/**
 * Recovery-only immutable weighted-pointer read. A failed native activation
 * can clear the active marker while leaving the accepted pointer intact. This
 * read never claims the Version is serving: its caller must hold owner custody,
 * compare the accepted SQL graph, then prove native activation separately.
 */
export async function readWorkerdSelectedPinnedVersionForRecovery(
  root: string,
  script: string,
  options: SelectedActiveVersionOptions & { readonly expectedGeneration: string },
): Promise<WorkerdSelectedActiveVersion<WorkerdSite | WorkerdStaticSite> | null> {
  if (typeof options?.expectedGeneration !== "string" || options.expectedGeneration.length === 0) {
    throw new Error("unusable worker recovery version options");
  }
  return await readWorkerdSelectedVersion(
    root,
    script,
    { ...options, includeStatic: true },
    {
      kind: "pinned",
      expectedGeneration: options.expectedGeneration,
    },
  );
}

async function readWorkerdSelectedVersion(
  root: string,
  script: string,
  options: SelectedActiveVersionOptions & { readonly includeStatic?: boolean },
  mode:
    | { readonly kind: "active" }
    | { readonly kind: "pinned"; readonly expectedGeneration: string },
): Promise<WorkerdSelectedActiveVersion<WorkerdSite | WorkerdStaticSite> | null> {
  if (!SCRIPT_NAME.test(script)) throw new Error("unusable script name");
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("unusable worker active version options");
  }
  const expectedWorkerResourceUid = validWorkerResourceUid(options.expectedWorkerResourceUid);
  const scriptsRoot = join(root, "workers");
  const activationPath = join(scriptsRoot, ".takoserver-active.json");

  let before: Record<string, string | null>;
  try {
    before = await readActivationStrict(activationPath);
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  const beforeMarker = before[script];
  const expectedGeneration = mode.kind === "active" ? beforeMarker : mode.expectedGeneration;
  if (typeof expectedGeneration !== "string") return null;
  if (mode.kind === "pinned" && beforeMarker != null && beforeMarker !== expectedGeneration) {
    return null;
  }

  const pointerPath = join(scriptsRoot, script, MANIFEST);
  const pointerRaw = await readFile(pointerPath, "utf8").catch((error: unknown) => {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw new Error("unusable worker active version snapshot");
  });
  if (pointerRaw === null) return null;

  let pointerValue: unknown;
  try {
    pointerValue = JSON.parse(pointerRaw);
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  let deployment: WeightedDeploymentSnapshot;
  try {
    deployment = await readWeightedDeploymentSnapshot(scriptsRoot, script, pointerValue);
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  if (
    deployment.deployment.generation !== expectedGeneration ||
    deployment.deployment.workerResourceUid !== expectedWorkerResourceUid
  ) {
    return null;
  }

  // This is the sole selection call. A graph crossing discovered by the final
  // fence below returns null; it never causes a second sample. Invalid caller
  // entropy retains the selector's range/type error for the caller.
  const selected = selectSelfhostWeightedVersion(deployment.canonical, options.basisPoint);

  const selectedIndex = deployment.deployment.versions.findIndex(
    (version) =>
      version.workerVersionUid === selected.workerVersionUid &&
      version.versionId === selected.versionId &&
      version.weight === selected.weight,
  );
  if (selectedIndex < 0) throw new Error("unusable worker active version snapshot");
  const stored = deployment.deployment.versions[selectedIndex];
  if (!stored) throw new Error("unusable worker active version snapshot");

  // Check the selected Version's identity before opening its module or asset
  // files. The top-level Worker UID check above already rejects a stale caller
  // expectation before any secret-bearing Version material is read.
  const selectedManifest = stored.manifest;
  // Class/event callers use the historical module-only read. Static bytes may
  // be selected only by an explicit Host caller, never cast into class work.
  if (isStaticManifest(selectedManifest) && options.includeStatic !== true) return null;
  if (
    typeof selectedManifest !== "object" ||
    selectedManifest === null ||
    Array.isArray(selectedManifest) ||
    selectedManifest.generation !== deployment.deployment.generation ||
    selectedManifest.workerResourceUid !== deployment.deployment.workerResourceUid ||
    !Array.isArray(selectedManifest.hostnames) ||
    selectedManifest.hostnames.length !== 0
  ) {
    throw new Error("unusable worker active version snapshot");
  }

  const capture: Required<ReadbackCapture> = {
    application: new Map(),
    hostPrivate: new Map(),
    assets: new Map(),
  };
  let manifest: StoredManifest;
  try {
    const moduleRoot = join(deployment.generationRoot, stored.storageKey);
    manifest = await readValidatedManifest(
      moduleRoot,
      join(moduleRoot, ASSETS_ROOT_DIRECTORY),
      selectedManifest,
      capture,
    );
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  if (
    manifest.generation !== deployment.deployment.generation ||
    manifest.workerResourceUid !== deployment.deployment.workerResourceUid ||
    manifest.hostnames.length !== 0
  ) {
    throw new Error("unusable worker active version snapshot");
  }

  let site: WorkerdSite | WorkerdStaticSite;
  try {
    site = isStaticManifest(manifest)
      ? {
          kind: "static",
          directory: script,
          hostnames: [...manifest.hostnames],
          generation: manifest.generation,
          workerResourceUid: manifest.workerResourceUid,
          fetchHandler: false,
          assets: {
            notFoundHandling: manifest.assets.notFoundHandling,
            runWorkerFirst: false,
            mediaTypes: Object.fromEntries(
              Object.entries(manifest.assets.files).map(([path, entry]) => [path, entry.mediaType]),
            ),
          },
        }
      : {
          directory: script,
          mainModule: manifest.mainModule,
          ...(manifest.hostEntrypoint === undefined
            ? {}
            : { hostEntrypoint: manifest.hostEntrypoint }),
          ...(manifest.hostModules === undefined ? {} : { hostModules: [...manifest.hostModules] }),
          hostnames: [...manifest.hostnames],
          ...(manifest.generation === undefined ? {} : { generation: manifest.generation }),
          ...(manifest.workerResourceUid === undefined
            ? {}
            : { workerResourceUid: manifest.workerResourceUid }),
          ...(manifest.fetchHandler === undefined ? {} : { fetchHandler: manifest.fetchHandler }),
          ...(manifest.serviceBindings === undefined
            ? {}
            : {
                serviceBindings: manifest.serviceBindings.map((binding) => ({
                  name: binding.name,
                  target: binding.target,
                  targetResourceUid: binding.targetResourceUid,
                  unavailableToken: binding.unavailableToken,
                })),
              }),
          ...(manifest.actorForward === undefined
            ? {}
            : {
                actorForward: {
                  schema: manifest.actorForward.schema,
                  bindings: manifest.actorForward.bindings.map((binding) => ({ ...binding })),
                },
              }),
          ...(manifest.workflowForward === undefined
            ? {}
            : { workflowForward: copyWorkflowForward(manifest.workflowForward) }),
          ...(manifest.assets === undefined
            ? {}
            : {
                assets: {
                  notFoundHandling: manifest.assets.notFoundHandling,
                  runWorkerFirst: manifest.assets.runWorkerFirst,
                  ...(manifest.assets.strictPaths === true ? { strictPaths: true as const } : {}),
                  mediaTypes: Object.fromEntries(
                    Object.entries(manifest.assets.files).map(([path, entry]) => [
                      path,
                      entry.mediaType,
                    ]),
                  ),
                },
              }),
          ...(manifest.vars === undefined
            ? {}
            : { vars: manifest.vars.map((binding) => ({ ...binding })) }),
          ...(manifest.modules === undefined ? {} : { modules: [...manifest.modules] }),
          ...(manifest.moduleMediaTypes === undefined
            ? {}
            : { moduleMediaTypes: { ...manifest.moduleMediaTypes } }),
          ...(manifest.dataPlane === undefined
            ? {}
            : {
                dataPlane: {
                  address: manifest.dataPlane.address,
                  module: manifest.dataPlane.module,
                  vars: manifest.dataPlane.vars.map((binding) => ({ ...binding })),
                },
              }),
          ...(manifest.events === undefined
            ? {}
            : {
                events: {
                  module: manifest.events.module,
                  vars: manifest.events.vars.map((binding) => ({ ...binding })),
                },
              }),
          ...(manifest.queueSettlement === undefined
            ? {}
            : {
                queueSettlement: {
                  address: manifest.queueSettlement.address,
                  module: manifest.queueSettlement.module,
                  vars: manifest.queueSettlement.vars.map((binding) => ({ ...binding })),
                },
              }),
          ...(manifest.v2ObjectBucketPlane === undefined
            ? {}
            : { v2ObjectBucketPlane: { ...manifest.v2ObjectBucketPlane } }),
          ...(manifest.v2KvPlane === undefined ? {} : { v2KvPlane: { ...manifest.v2KvPlane } }),
          ...(manifest.v2QueueProducerPlane === undefined
            ? {}
            : { v2QueueProducerPlane: { ...manifest.v2QueueProducerPlane } }),
        };
  } catch {
    // Validators normally reject these shapes earlier. Keep the reader's
    // public failure generic even for legacy manifests with missing nested
    // arrays that older validators treated as empty.
    throw new Error("unusable worker active version snapshot");
  }

  // Each collector was allocated for this call and receives a fresh byte copy
  // from the digest-verified read, so returning it directly gives ownership to
  // the caller without a second full copy of potentially large modules/assets.
  const modules = capture.application;
  const hostModules = capture.hostPrivate;
  const assets = manifest.assets === undefined ? undefined : capture.assets;

  let after: Record<string, string | null>;
  try {
    after = await readActivationStrict(activationPath);
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  const finalPointerRaw = await readFile(pointerPath, "utf8").catch((error: unknown) => {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw new Error("unusable worker active version snapshot");
  });
  if (
    finalPointerRaw === null ||
    (mode.kind === "active"
      ? after[script] !== expectedGeneration
      : after[script] !== beforeMarker) ||
    finalPointerRaw !== pointerRaw
  ) {
    return null;
  }

  return {
    generation: deployment.deployment.generation,
    generationKey: deployment.pointer.generationKey,
    workerResourceUid: deployment.deployment.workerResourceUid,
    versionId: selected.versionId,
    workerVersionUid: selected.workerVersionUid,
    site,
    modules,
    hostModules,
    ...(assets === undefined ? {} : { assets }),
  };
}

/**
 * Reads every Version in the active private publication without sampling the
 * weighted selector. All module bytes are verified before the active marker
 * and stable pointer are reread, so callers receive one closed graph or null.
 */
export async function readWorkerdActiveActorGraph(
  root: string,
  script: string,
  expectedWorkerResourceUid: string,
): Promise<WorkerdActiveActorGraph | null> {
  if (!SCRIPT_NAME.test(script)) throw new Error("unusable script name");
  expectedWorkerResourceUid = validWorkerResourceUid(expectedWorkerResourceUid);
  const scriptsRoot = join(root, "workers");
  const activationPath = join(scriptsRoot, ".takoserver-active.json");
  let before: Record<string, string | null>;
  try {
    before = await readActivationStrict(activationPath);
  } catch {
    throw new Error("unusable worker active Actor graph");
  }
  const activeGeneration = before[script];
  if (typeof activeGeneration !== "string") return null;
  const pointerPath = join(scriptsRoot, script, MANIFEST);
  const pointerRaw = await readFile(pointerPath, "utf8").catch((error: unknown) => {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw new Error("unusable worker active Actor graph");
  });
  if (pointerRaw === null) return null;
  let pointerValue: unknown;
  try {
    pointerValue = JSON.parse(pointerRaw);
  } catch {
    throw new Error("unusable worker active Actor graph");
  }
  let deployment: WeightedDeploymentSnapshot;
  try {
    deployment = await readWeightedDeploymentSnapshot(scriptsRoot, script, pointerValue);
  } catch {
    throw new Error("unusable worker active Actor graph");
  }
  if (
    deployment.deployment.generation !== activeGeneration ||
    deployment.deployment.workerResourceUid !== expectedWorkerResourceUid
  )
    return null;

  const versions: WorkerdActiveActorGraph["versions"][number][] = [];
  for (let index = 0; index < deployment.deployment.versions.length; index += 1) {
    const stored = deployment.deployment.versions[index];
    const weighted = deployment.canonical[index];
    if (!stored || !weighted) throw new Error("unusable worker active Actor graph");
    const identity = stored.manifest;
    if (
      typeof identity !== "object" ||
      identity === null ||
      Array.isArray(identity) ||
      identity.generation !== deployment.deployment.generation ||
      identity.workerResourceUid !== deployment.deployment.workerResourceUid ||
      !Array.isArray(identity.hostnames) ||
      identity.hostnames.length !== 0
    )
      throw new Error("unusable worker active Actor graph");

    const capture: Required<ReadbackCapture> = {
      application: new Map(),
      hostPrivate: new Map(),
      assets: new Map(),
    };
    let manifest: Manifest;
    try {
      const moduleRoot = join(deployment.generationRoot, stored.storageKey);
      const validated = await readValidatedManifest(
        moduleRoot,
        join(moduleRoot, ASSETS_ROOT_DIRECTORY),
        identity,
        capture,
      );
      if (isStaticManifest(validated)) throw new Error("static Version has no Actor class");
      manifest = validated;
    } catch {
      throw new Error("unusable worker active Actor graph");
    }
    if (
      manifest.generation !== deployment.deployment.generation ||
      manifest.workerResourceUid !== deployment.deployment.workerResourceUid ||
      manifest.hostnames.length !== 0
    )
      throw new Error("unusable worker active Actor graph");

    let site: WorkerdSite;
    try {
      site = {
        directory: script,
        mainModule: manifest.mainModule,
        ...(manifest.hostEntrypoint === undefined
          ? {}
          : { hostEntrypoint: manifest.hostEntrypoint }),
        ...(manifest.hostModules === undefined ? {} : { hostModules: [...manifest.hostModules] }),
        hostnames: [...manifest.hostnames],
        ...(manifest.generation === undefined ? {} : { generation: manifest.generation }),
        ...(manifest.workerResourceUid === undefined
          ? {}
          : { workerResourceUid: manifest.workerResourceUid }),
        ...(manifest.fetchHandler === undefined ? {} : { fetchHandler: manifest.fetchHandler }),
        ...(manifest.serviceBindings === undefined
          ? {}
          : { serviceBindings: manifest.serviceBindings.map((binding) => ({ ...binding })) }),
        ...(manifest.actorForward === undefined
          ? {}
          : {
              actorForward: {
                schema: manifest.actorForward.schema,
                bindings: manifest.actorForward.bindings.map((binding) => ({ ...binding })),
              },
            }),
        ...(manifest.workflowForward === undefined
          ? {}
          : { workflowForward: copyWorkflowForward(manifest.workflowForward) }),
        ...(manifest.vars === undefined
          ? {}
          : { vars: manifest.vars.map((binding) => ({ ...binding })) }),
        ...(manifest.modules === undefined ? {} : { modules: [...manifest.modules] }),
        ...(manifest.moduleMediaTypes === undefined
          ? {}
          : { moduleMediaTypes: { ...manifest.moduleMediaTypes } }),
        ...(manifest.dataPlane === undefined
          ? {}
          : {
              dataPlane: {
                ...manifest.dataPlane,
                vars: manifest.dataPlane.vars.map((binding) => ({ ...binding })),
              },
            }),
        ...(manifest.events === undefined
          ? {}
          : {
              events: {
                ...manifest.events,
                vars: manifest.events.vars.map((binding) => ({ ...binding })),
              },
            }),
        ...(manifest.queueSettlement === undefined
          ? {}
          : {
              queueSettlement: {
                ...manifest.queueSettlement,
                vars: manifest.queueSettlement.vars.map((binding) => ({ ...binding })),
              },
            }),
        ...(manifest.v2ObjectBucketPlane === undefined
          ? {}
          : { v2ObjectBucketPlane: { ...manifest.v2ObjectBucketPlane } }),
        ...(manifest.v2KvPlane === undefined ? {} : { v2KvPlane: { ...manifest.v2KvPlane } }),
        ...(manifest.v2QueueProducerPlane === undefined
          ? {}
          : { v2QueueProducerPlane: { ...manifest.v2QueueProducerPlane } }),
        ...(manifest.assets === undefined
          ? {}
          : {
              assets: {
                notFoundHandling: manifest.assets.notFoundHandling,
                runWorkerFirst: manifest.assets.runWorkerFirst,
                ...(manifest.assets.strictPaths === true ? { strictPaths: true as const } : {}),
                mediaTypes: Object.fromEntries(
                  Object.entries(manifest.assets.files).map(([path, entry]) => [
                    path,
                    entry.mediaType,
                  ]),
                ),
              },
            }),
      };
    } catch {
      throw new Error("unusable worker active Actor graph");
    }
    versions.push({
      ...weighted,
      variantKey: weighted.workerVersionUid,
      site,
      modules: capture.application,
      hostModules: capture.hostPrivate,
    });
  }

  let after: Record<string, string | null>;
  const finalPointerRaw = await readFile(pointerPath, "utf8").catch((error: unknown) => {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw new Error("unusable worker active Actor graph");
  });
  try {
    after = await readActivationStrict(activationPath);
  } catch {
    throw new Error("unusable worker active Actor graph");
  }
  if (
    finalPointerRaw === null ||
    after[script] !== activeGeneration ||
    finalPointerRaw !== pointerRaw
  )
    return null;
  return {
    generation: deployment.deployment.generation,
    generationKey: deployment.pointer.generationKey,
    workerResourceUid: deployment.deployment.workerResourceUid,
    versions,
  };
}

async function readPublished(
  scriptsRoot: string,
  assetsRoot: string,
): Promise<readonly PublishedDeployment[]> {
  const entries = await readdir(scriptsRoot, { withFileTypes: true }).catch(() => []);
  const published: PublishedDeployment[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SCRIPT_NAME.test(entry.name)) continue;
    const raw = await readFile(join(scriptsRoot, entry.name, MANIFEST), "utf8").catch(() => null);
    if (raw === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      if (raw.includes("publicationStorageLayout")) {
        throw new Error("unusable worker deployment pointer");
      }
      continue;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "publicationStorageLayout" in value
    ) {
      published.push(await readWeightedDeployment(scriptsRoot, entry.name, value));
      continue;
    }
    // A manifest whose bindings cannot be rendered is not a script this process
    // will serve. Skipping it keeps one broken directory from taking every
    // other customer's site down with it on the next reload. Renderability is
    // proved here, not merely name validity: `capnpText` refuses a NUL or a
    // lone surrogate, and it is the only thing that stands between a torn or
    // tampered manifest and a `renderConfig` that throws for everyone.
    let manifest: Manifest;
    try {
      const validated = await readValidatedManifest(
        join(scriptsRoot, entry.name),
        join(assetsRoot, entry.name),
        value,
      );
      if (isStaticManifest(validated)) {
        throw new Error("static Version requires an immutable weighted publication");
      }
      manifest = validated;
      if (manifest.workflowForward !== undefined) {
        throw new Error("Workflow forward requires an immutable weighted Version");
      }
      internalHostname(entry.name);
      eventHostname(entry.name);
    } catch {
      continue;
    }
    published.push({
      name: entry.name,
      ...(manifest.generation === undefined ? {} : { generation: manifest.generation }),
      ...(manifest.workerResourceUid === undefined
        ? {}
        : { workerResourceUid: manifest.workerResourceUid }),
      hostnames: validDeploymentHostnames(manifest.hostnames),
      weighted: false,
      variants: [
        {
          name: entry.name,
          logicalName: entry.name,
          storagePrefix: entry.name,
          assetRoot: join(assetsRoot, entry.name),
          manifest,
        },
      ],
    });
  }
  return published.sort((left, right) => left.name.localeCompare(right.name));
}

function requiredStoredModule(
  inventory: readonly WorkerdStoredModule[],
  name: string,
): WorkerdStoredModule {
  const match = inventory.find((entry) => entry.name === name);
  if (!match) throw new Error("unusable worker module storage manifest");
  return match;
}

export function workerdServiceBindingRouterName(binding: WorkerdServiceBinding): string {
  const digest = createHash("sha256")
    .update("takoserver.selfhost-service-router@v1\u0000", "utf8")
    .update(binding.target, "utf8")
    .update("\u0000", "utf8")
    .update(binding.targetResourceUid, "utf8")
    .update("\u0000", "utf8")
    .update(binding.unavailableToken, "utf8")
    .digest("hex");
  return `selfhost-service-${digest}`;
}

/** Socket path for the Host-owned v2 broker behind one private Service router. */
export function workerdV2ServiceBindingBrokerSocketPath(
  directory: string,
  binding: WorkerdServiceBinding,
): string {
  const router = workerdServiceBindingRouterName(binding);
  const digest = createHash("sha256")
    .update("takoserver.v2-service-binding-broker-socket@1\u0000", "utf8")
    .update(router, "utf8")
    .digest("hex");
  return join(directory, `${digest}.sock`);
}

function serviceBindingBrokerTargetName(router: string): string {
  const digest = createHash("sha256")
    .update("takoserver.v2-service-binding-broker-target@1\u0000", "utf8")
    .update(router, "utf8")
    .digest("hex");
  return `selfhost-service-target-${digest}`;
}

function validPrivateSocketDirectory(path: string): void {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.includes("\u0000") ||
    Buffer.byteLength(join(path, `${"0".repeat(64)}.sock`)) > 100
  ) {
    throw new Error("unusable private service socket directory");
  }
}

interface PrivateSocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

function validV2ServiceBindingBrokerSocket(value: WorkerdV2ServiceBindingBrokerSocket): void {
  if (
    !value ||
    typeof value !== "object" ||
    !isAbsolute(value.socketPath) ||
    resolve(value.socketPath) !== value.socketPath ||
    value.socketPath.includes("\u0000") ||
    Buffer.byteLength(value.socketPath) > 100 ||
    !value.identity ||
    !Number.isSafeInteger(value.identity.dev) ||
    !Number.isSafeInteger(value.identity.ino) ||
    !Number.isSafeInteger(value.identity.uid) ||
    value.identity.dev < 0 ||
    value.identity.ino < 1 ||
    value.identity.uid < 0
  ) {
    throw new Error("unusable v2 ServiceBinding broker socket");
  }
}

function samePrivateSocketIdentity(
  left: PrivateSocketIdentity,
  right: PrivateSocketIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function privateSocketMetadata(path: string): Promise<PrivateSocketIdentity | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket() || metadata.uid !== process.getuid?.()) {
      throw new Error("private service socket path is not an owned socket");
    }
    return metadata;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function verifyV2ServiceBindingBrokerSockets(
  graph: PrivateServiceGraph | undefined,
): Promise<void> {
  if (!graph) return;
  for (const socket of graph.brokerSockets.values()) {
    await requirePrivateSocketDirectory(dirname(socket.socketPath));
    const metadata = await privateSocketMetadata(socket.socketPath);
    if (!metadata || !samePrivateSocketIdentity(metadata, socket.identity)) {
      throw new Error("v2 ServiceBinding broker socket changed");
    }
  }
}

async function requirePrivateSocketDirectory(path: string): Promise<PrivateSocketIdentity> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== 0o700 ||
    metadata.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  ) {
    throw new Error("unusable private service socket directory");
  }
  return metadata;
}

function privateServiceSocket(directory: string, router: string): string {
  return join(directory, `${router.slice("selfhost-service-".length)}.sock`);
}

interface PrivateServiceGraph {
  readonly socketDirectory: string;
  readonly bindings: ReadonlyMap<string, WorkerdServiceBinding>;
  readonly brokerSockets: ReadonlyMap<string, WorkerdV2ServiceBindingBrokerSocket>;
  readonly v2PrivateRouters: ReadonlySet<string>;
}

function collectServiceBindings(
  published: readonly PublishedDeployment[],
  retained: readonly WorkerdServiceBinding[] = [],
): ReadonlyMap<string, WorkerdServiceBinding> {
  const bindings = new Map<string, WorkerdServiceBinding>();
  for (const deployment of published) {
    for (const entry of deployment.variants) {
      for (const binding of validServiceBindings(
        entry.manifest.serviceBindings ?? [],
        hasWorkerdV2PrivateBindingProfile(entry.manifest),
      )) {
        bindings.set(workerdServiceBindingRouterName(binding), binding);
      }
    }
  }
  for (const binding of retained) bindings.set(workerdServiceBindingRouterName(binding), binding);
  return new Map([...bindings].sort(([left], [right]) => left.localeCompare(right)));
}

function variantFetchService(entry: PublishedVariant): string {
  return entry.manifest.assets ? `${entry.name}-asset-router` : entry.name;
}

function logicalFetchService(entry: PublishedDeployment): string {
  return entry.weighted
    ? `${entry.name}-selfhost-deployment`
    : variantFetchService(entry.variants[0] as PublishedVariant);
}

function logicalEventService(entry: PublishedDeployment): string | null {
  if (entry.weighted) {
    return entry.variants.every((variant) => variant.manifest.events !== undefined)
      ? `${entry.name}-selfhost-events`
      : null;
  }
  const variant = entry.variants[0];
  return variant?.manifest.events ? `${variant.name}-selfhost-events` : null;
}

interface ResolvedActorForwardService {
  readonly httpBinding: string;
  readonly upgradeBinding: string;
  readonly httpService: string;
  readonly upgradeService: string;
  readonly httpSocketPath: string;
  readonly upgradeSocketPath: string;
}

function actorForwardPublications(
  published: readonly PublishedDeployment[],
): readonly WorkerdActorForwardPublication[] {
  return published.flatMap((deployment) =>
    deployment.variants.flatMap((variant) => {
      if (variant.manifest.actorForward === undefined) return [];
      if (
        !deployment.weighted ||
        !deployment.workerResourceUid ||
        !variant.versionId ||
        !variant.workerVersionUid
      )
        throw new Error("Actor forward requires an immutable weighted Version");
      return [
        {
          script: deployment.name,
          workerResourceUid: deployment.workerResourceUid,
          versionId: variant.versionId,
          workerVersionResourceUid: variant.workerVersionUid,
          bindings: validActorForward(
            variant.manifest.actorForward,
            hasWorkerdV2PrivateBindingProfile(variant.manifest),
          ).bindings,
        },
      ];
    }),
  );
}

function resolveActorForwardServices(
  published: readonly PublishedDeployment[],
  sockets: ReadonlyMap<string, WorkerdActorForwardSocket>,
  exactSockets = false,
): ReadonlyMap<string, readonly ResolvedActorForwardService[]> {
  const resolved = new Map<string, readonly ResolvedActorForwardService[]>();
  for (const variant of published.flatMap((deployment) => deployment.variants)) {
    if (variant.manifest.actorForward === undefined) continue;
    const actorForward = validActorForward(
      variant.manifest.actorForward,
      hasWorkerdV2PrivateBindingProfile(variant.manifest),
    );
    const services = actorForward.bindings.map((binding, index) => {
      const current =
        sockets.get(
          actorForwardIdentity(binding.tenantId, binding.namespaceResourceUid, binding.token),
        ) ??
        (exactSockets
          ? undefined
          : sockets.get(actorForwardIdentity(binding.tenantId, binding.namespaceResourceUid)));
      if (!current) throw new Error("Actor forward Host socket unavailable");
      return {
        httpBinding: binding.httpService,
        upgradeBinding: binding.upgradeService,
        httpService: `${variant.name}-actor-http-${index}`,
        upgradeService: `${variant.name}-actor-upgrade-${index}`,
        httpSocketPath: current.httpSocketPath,
        upgradeSocketPath: current.upgradeSocketPath,
      };
    });
    resolved.set(variant.name, services);
  }
  return resolved;
}

function publishedGraphIdentity(
  published: readonly PublishedDeployment[],
  privateServices?: PrivateServiceGraph,
  actorForwardSockets: ReadonlyMap<string, WorkerdActorForwardSocket> = new Map(),
  exactActorSockets = false,
  workflowForwardServices: ReadonlyMap<
    string,
    readonly ResolvedWorkflowForwardService[]
  > = new Map(),
  serviceBindingDispatch?: WorkerdRuntimeOptions["v2ServiceBindingDispatch"],
): string {
  const hash = createHash("sha256").update(
    JSON.stringify(
      published.map((deployment) => ({
        name: deployment.name,
        generation: deployment.generation ?? null,
        workerResourceUid: deployment.workerResourceUid ?? null,
        hostnames: deployment.hostnames,
        weighted: deployment.weighted,
        variants: deployment.variants.map((variant) => ({
          name: variant.name,
          storagePrefix: variant.storagePrefix,
          assetRoot: variant.assetRoot,
          versionId: variant.versionId ?? null,
          workerVersionUid: variant.workerVersionUid ?? null,
          weight: variant.weight ?? null,
          manifest: variant.manifest,
        })),
      })),
    ),
    "utf8",
  );
  if (privateServices) {
    // A reload that only prunes retired callers must not be acknowledged by
    // the prior graph's probe. Private topology is part of config identity.
    hash.update("\u0000private-services\u0000").update(
      JSON.stringify({
        directory: privateServices.socketDirectory,
        routers: [...privateServices.bindings.keys()],
        brokerSockets: [...privateServices.brokerSockets.entries()],
        v2PrivateRouters: [...privateServices.v2PrivateRouters].sort(),
      }),
    );
  }
  if (serviceBindingDispatch) {
    hash
      .update("\u0000private-service-dispatch\u0000")
      .update(serviceBindingDispatch.internalHostname)
      .update("\u0000")
      .update(serviceBindingDispatch.token);
  }
  const actorServices = resolveActorForwardServices(
    published,
    actorForwardSockets,
    exactActorSockets,
  );
  if (actorServices.size > 0) {
    hash
      .update("\u0000actor-forward-sockets\u0000")
      .update(JSON.stringify([...actorServices.entries()]));
  }
  if (workflowForwardServices.size > 0) {
    hash
      .update("\u0000workflow-forward-sockets\u0000")
      .update(JSON.stringify([...workflowForwardServices.entries()]));
  }
  return hash.digest("hex");
}

/**
 * The configuration, rendered whole.
 *
 * A router service in front, because workerd binds a socket to one service and
 * a platform needs many. The router holds a service binding per script and
 * picks by `Host`; anything unclaimed gets a 404 that says so, which is the
 * only honest answer when nobody has asked for that name.
 */
function renderWorkerdModules(manifest: Manifest, storagePrefix: string): string {
  const mainModule = validModules([manifest.mainModule])[0] as string;
  const declaredModules = validModules(manifest.modules ?? [], manifest.mainModule);
  const moduleMediaTypes = validModuleMediaTypes(
    mainModule,
    declaredModules,
    manifest.moduleMediaTypes,
  );
  const applicationModules = manifest.moduleFiles.application;
  const hostModules = manifest.moduleFiles.hostPrivate;
  const hostEntrypoint = manifest.hostEntrypoint;
  const orderedHostModules =
    hostEntrypoint === undefined
      ? hostModules
      : [
          requiredStoredModule(hostModules, hostEntrypoint),
          ...hostModules.filter((module) => module.name !== hostEntrypoint),
        ];
  const application = applicationModules.map((module) => ({
    module,
    role: "application" as const,
  }));
  const host = orderedHostModules.map((module) => ({ module, role: "hostPrivate" as const }));
  return (hostEntrypoint === undefined ? [...application, ...host] : [...host, ...application])
    .map(({ module, role }) => {
      const mediaType =
        role === "application"
          ? (moduleMediaTypes?.[module.name] ?? "application/javascript+module")
          : "application/javascript+module";
      const directory =
        role === "application" ? APPLICATION_MODULE_DIRECTORY : HOST_PRIVATE_MODULE_DIRECTORY;
      return `(name = ${capnpText(module.name)}, ${workerdModuleKind(mediaType)} = embed ${capnpText(`${storagePrefix}/${directory}/${module.key}`)}, role = ${role})`;
    })
    .join(", ");
}

function renderConfig(
  published: readonly PublishedDeployment[],
  port: number,
  _assetsRoot: string,
  tls?: WorkerdTlsKeypair,
  configProbeToken?: string,
  internalReadinessCapability = "",
  dataPlaneAddress?: string,
  privateServices?: PrivateServiceGraph,
  actorForwardSockets: ReadonlyMap<string, WorkerdActorForwardSocket> = new Map(),
  exactActorSockets = false,
  workflowForwardServices: ReadonlyMap<
    string,
    readonly ResolvedWorkflowForwardService[]
  > = new Map(),
  serviceBindingDispatch?: WorkerdRuntimeOptions["v2ServiceBindingDispatch"],
): string {
  const variants = published.flatMap((deployment) => deployment.variants);
  const actorServices = resolveActorForwardServices(
    published,
    actorForwardSockets,
    exactActorSockets,
  );
  const graphIdentity = publishedGraphIdentity(
    published,
    privateServices,
    actorForwardSockets,
    exactActorSockets,
    workflowForwardServices,
    serviceBindingDispatch,
  );
  const services = variants
    .map((entry) => {
      if (isStaticManifest(entry.manifest)) {
        if (!entry.versionId) throw new Error("static Version lacks a publication identity");
        return `  ( name = ${capnpText(entry.name)},
    worker = (
      modules = [ (name = ${capnpText(STATIC_READINESS_MODULE)}, esModule = embed ${capnpText(STATIC_READINESS_MODULE)}) ],
      bindings = [
        (name = "PUBLICATION", text = ${capnpText(entry.versionId)}),
        (name = "INTERNAL_HOSTNAME", text = ${capnpText(internalHostname(entry.logicalName))}),
        (name = "INTERNAL_READINESS_CAPABILITY", text = ${capnpText(internalReadinessCapability)})
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
      }
      const bindings = [
        ...(hasHostEntrypoint(entry)
          ? [
              `(name = ${capnpText(hasWorkerdV2PrivateBindingProfile(entry.manifest) ? WORKERD_V2_PRIVATE_READINESS_BINDING : INTERNAL_READINESS_CAPABILITY_BINDING)}, text = ${capnpText(internalReadinessCapability)})`,
            ]
          : []),
        ...(entry.manifest.dataPlane
          ? [
              `(name = "${hasWorkerdV2PrivateBindingProfile(entry.manifest) ? WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING : DATA_SERVICE_BINDING}", service = "${entry.name}-selfhost-data")`,
            ]
          : []),
        ...(entry.manifest.queueSettlement
          ? [
              `(name = ${capnpText(hasWorkerdV2PrivateBindingProfile(entry.manifest) ? WORKERD_V2_PRIVATE_QUEUE_SETTLEMENT_BINDING : V2_QUEUE_SETTLEMENT_SERVICE_BINDING)}, service = ${capnpText(`${entry.name}-v2-queue-settlement`)})`,
            ]
          : []),
        ...(entry.manifest.v2ObjectBucketPlane
          ? [
              `(name = ${capnpText(WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING)}, service = ${capnpText(`${entry.name}-v2-object-bucket`)})`,
            ]
          : []),
        ...(entry.manifest.v2KvPlane
          ? [
              `(name = ${capnpText(WORKERD_V2_PRIVATE_KV_BINDING)}, service = ${capnpText(`${entry.name}-v2-kv`)})`,
            ]
          : []),
        ...(entry.manifest.v2QueueProducerPlane
          ? [
              `(name = ${capnpText(WORKERD_V2_PRIVATE_QUEUE_PRODUCER_BINDING)}, service = ${capnpText(`${entry.name}-v2-queue-producer`)})`,
            ]
          : []),
        ...validServiceBindings(
          entry.manifest.serviceBindings ?? [],
          hasWorkerdV2PrivateBindingProfile(entry.manifest),
        ).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, service = ${capnpText(workerdServiceBindingRouterName(binding))})`,
        ),
        ...(actorServices.get(entry.name) ?? []).flatMap((binding) => [
          `(name = ${capnpText(binding.httpBinding)}, service = ${capnpText(binding.httpService)})`,
          `(name = ${capnpText(binding.upgradeBinding)}, service = ${capnpText(binding.upgradeService)})`,
        ]),
        ...(workflowForwardServices.get(entry.name) ?? []).map(
          (binding) =>
            `(name = ${capnpText(binding.bindingName)}, service = ${capnpText(binding.serviceName)})`,
        ),
        ...validBindings(entry.manifest.vars ?? []).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ];
      const bindingList =
        bindings.length === 0 ? "" : `\n      bindings = [ ${bindings.join(", ")} ],`;
      // The configured entrypoint comes first. Host-private and application
      // modules retain separate registry identities even when their logical
      // names are equal; only the Host entrypoint has the explicit bridge to
      // this publication's exact application main.
      const mainModule = validModules([entry.manifest.mainModule])[0] as string;
      const moduleList = renderWorkerdModules(entry.manifest, entry.storagePrefix);
      // Rendered only for a script published through a generated entrypoint, so
      // a script that binds no data plane produces the bytes it always did.
      const flagList = hasHostEntrypoint(entry)
        ? `\n      compatibilityFlags = [ ${APPLICATION_COMPATIBILITY_FLAGS.map((flag) => capnpText(flag)).join(", ")} ],`
        : "";
      return `  ( name = "${entry.name}",
    worker = (
      modules = [ ${moduleList} ],${bindingList}
      modulePolicy = (applicationMain = ${capnpText(mainModule)}),
      compatibilityDate = "2026-01-01",${flagList}
    )
  ),`;
    })
    .join("\n");

  const actorExternalServices = [...actorServices.values()]
    .flatMap((bindings) =>
      bindings.flatMap((binding) => [
        `  (name = ${capnpText(binding.httpService)}, external = (address = ${capnpText(`unix:${binding.httpSocketPath}`)}, http = ())),`,
        `  (name = ${capnpText(binding.upgradeService)}, external = (address = ${capnpText(`unix:${binding.upgradeSocketPath}`)}, http = (style = proxy))),`,
      ]),
    )
    .join("\n");
  const workflowExternalServices = [...workflowForwardServices.values()]
    .flatMap((bindings) =>
      bindings.map(
        (binding) =>
          `  (name = ${capnpText(binding.serviceName)}, external = (address = ${capnpText(`unix:${binding.socketPath}`)}, http = ())),`,
      ),
    )
    .join("\n");

  // Absolute, because a `disk` path is resolved against the process's working
  // directory while an `embed` is resolved against this file — the same config
  // read from two directories would otherwise find its modules and lose its
  // files. The failure names the directory it could not find, which reads like
  // the files are missing rather than like the path is relative.
  //
  // Files come off the disk through workerd's own directory service. A private
  // lookup service validates the portable path grammar and applies SPA miss
  // behavior; a second Host-owned service composes that lookup with the tenant
  // worker in the exact declared order. Neither binding is on the tenant
  // service, so `env.ASSETS` is never invented by this Host.
  const assetServices = variants
    .filter((entry) => entry.manifest.assets)
    .map((entry) => {
      const assets = validAssetManifest(entry.manifest.assets, isStaticManifest(entry.manifest));
      if (!assets) throw new Error("unusable worker asset manifest");
      return `  ( name = "${entry.name}-assets-files",
    disk = ( path = ${capnpText(entry.assetRoot)}, writable = false )
  ),
  ( name = "${entry.name}-assets",
    worker = (
      modules = [ (name = "assets.js", esModule = embed "assets.js") ],
      bindings = [
        (name = "FILES", service = "${entry.name}-assets-files"),
        (name = "NOT_FOUND", text = "${assets.notFoundHandling}"),
        ${isStaticManifest(entry.manifest) || assets.strictPaths === true ? '(name = "STRICT_PATHS", text = "true"),' : ""}
        (name = "ASSET_MANIFEST", json = ${capnpText(JSON.stringify(assets.files))}),
      ],
      compatibilityDate = "2026-01-01",
    )
  ),
  ( name = "${entry.name}-asset-router",
    worker = (
      modules = [ (name = "asset-router.js", esModule = embed "asset-router.js") ],
      bindings = [
        ${isStaticManifest(entry.manifest) ? '(name = "STATIC_ONLY", text = "true"),' : `(name = "WORKER", service = "${entry.name}"),`}
        (name = "ASSETS", service = "${entry.name}-assets"),
        (name = "RUN_WORKER_FIRST", text = "${assets.runWorkerFirst ? "true" : "false"}"),
        ${!isStaticManifest(entry.manifest) && assets.strictPaths === true && entry.manifest.fetchHandler === false ? '(name = "FETCH_HANDLER", text = "false"),' : ""}
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  // One private router per immutable caller binding. Its per-Version token is
  // what makes the unavailable signal unforgeable by the target while letting
  // an active response pass through byte-for-byte, headers and body stream
  // included. Target selection is only the persisted script + Resource UID;
  // the request URL and Host header are never consulted.
  const publishedByName = new Map(published.map((entry) => [entry.name, entry] as const));
  const routedBindings = privateServices?.bindings ?? collectServiceBindings(published);
  const v2PrivateServiceRouters = new Set(
    published.flatMap((deployment) =>
      deployment.variants.flatMap((variant) =>
        hasWorkerdV2PrivateBindingProfile(variant.manifest)
          ? validServiceBindings(variant.manifest.serviceBindings ?? [], true).map(
              workerdServiceBindingRouterName,
            )
          : [],
      ),
    ),
  );
  for (const router of privateServices?.v2PrivateRouters ?? []) {
    v2PrivateServiceRouters.add(router);
  }
  const v2BrokerExternalServices: string[] = [];
  const serviceBindingServices = [...routedBindings]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, binding]) => {
      const v2Private = v2PrivateServiceRouters.has(name);
      const target = publishedByName.get(binding.target);
      const active =
        target?.workerResourceUid === binding.targetResourceUid &&
        target.variants.every(
          (variant) => variant.manifest.fetchHandler === true || isStaticManifest(variant.manifest),
        );
      // A v2-private router without its exact Host broker must stay unbound:
      // the logical in-process route would bypass Core and native ownership.
      const brokerSocket = privateServices?.brokerSockets.get(name);
      const brokerTargetService = brokerSocket ? serviceBindingBrokerTargetName(name) : undefined;
      if (brokerSocket && brokerTargetService) {
        v2BrokerExternalServices.push(
          `  (name = ${capnpText(brokerTargetService)}, external = (address = ${capnpText(`unix:${brokerSocket.socketPath}`)}, http = ())),`,
        );
      }
      const targetService =
        brokerTargetService ??
        (v2Private ? undefined : target ? logicalFetchService(target) : binding.target);
      return `  ( name = ${capnpText(name)},
    worker = (
      modules = [ (name = ${capnpText(SERVICE_ROUTER_MODULE)}, esModule = embed ${capnpText(SERVICE_ROUTER_MODULE)}) ],
      bindings = [
        (name = "${SERVICE_UNAVAILABLE_TOKEN_BINDING}", text = ${capnpText(binding.unavailableToken)}),${
          brokerSocket && targetService
            ? `\n        (name = "BROKER_TOKEN", text = ${capnpText(binding.unavailableToken)}),\n        (name = "TARGET", service = ${capnpText(targetService)}),`
            : !v2Private && active && targetService
              ? `\n        (name = "TARGET", service = ${capnpText(targetService)}),`
              : ""
        }
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");
  const v2BrokerExternalServiceConfig = v2BrokerExternalServices.join("\n");

  // Each script contributes its own service pair. Service membership derives
  // from manifests on disk: a script that binds no data plane contributes
  // neither service, and removing it removes both. The origin listener comes
  // from current Host-owned transport so restart never rewrites the manifest.
  //
  // The token is declared here and only here. The script's own service holds a
  // binding to this one and nothing else, so tenant code — by `env`, by
  // `cloudflare:workers`, or by any other route into its own isolate — has
  // nothing to find.
  const dataServices = variants
    .filter((entry) => entry.manifest.dataPlane)
    .map((entry) => {
      if (isStaticManifest(entry.manifest)) throw new Error("static Version cannot bind data");
      const plane = validDataPlane(entry.manifest.dataPlane as WorkerdDataPlane);
      const planeModule = requiredStoredModule(
        entry.manifest.moduleFiles.hostPrivate,
        plane.module,
      );
      const facadeBindings = [
        `(name = "${DATA_PLANE_BINDING}", service = "${entry.name}-selfhost-data-origin")`,
        ...validBindings(plane.vars).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ].join(", ");
      return `  ( name = "${entry.name}-selfhost-data",
    worker = (
      modules = [ (name = ${capnpText(plane.module)}, esModule = embed ${capnpText(`${entry.storagePrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${planeModule.key}`)}) ],
      bindings = [ ${facadeBindings} ],
      compatibilityDate = "2026-01-01",
    )
  ),
  ( name = "${entry.name}-selfhost-data-origin",
    external = ( address = ${capnpText(dataPlaneAddress ?? plane.address)}, http = () )
  ),`;
    })
    .join("\n");

  const queueSettlementServices = variants
    .filter((entry) => entry.manifest.queueSettlement)
    .map((entry) => {
      if (isStaticManifest(entry.manifest))
        throw new Error("static Version cannot bind queue settlement");
      const plane = validQueueSettlement(entry.manifest.queueSettlement as WorkerdQueueSettlement);
      const module = requiredStoredModule(entry.manifest.moduleFiles.hostPrivate, plane.module);
      const bindings = [
        `(name = ${capnpText(V2_QUEUE_SETTLEMENT_ORIGIN_BINDING)}, service = ${capnpText(`${entry.name}-v2-queue-settlement-origin`)})`,
        ...validBindings(plane.vars).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ].join(", ");
      return `  ( name = ${capnpText(`${entry.name}-v2-queue-settlement`)},
    worker = (
      modules = [ (name = ${capnpText(plane.module)}, esModule = embed ${capnpText(`${entry.storagePrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${module.key}`)}) ],
      bindings = [ ${bindings} ], compatibilityDate = "2026-01-01", globalOutbound = "queue-settlement-deny"
    )
  ),
  ( name = ${capnpText(`${entry.name}-v2-queue-settlement-origin`)},
    external = ( address = ${capnpText(plane.address)}, http = () )
  ),`;
    })
    .join("\n");

  const v2ObjectBucketServices = variants
    .filter((entry) => entry.manifest.v2ObjectBucketPlane)
    .map((entry) => {
      if (isStaticManifest(entry.manifest)) {
        throw new Error("static Version cannot bind a v2 ObjectBucket");
      }
      const plane = validV2ObjectBucketPlane(
        entry.manifest.v2ObjectBucketPlane as WorkerdV2ObjectBucketPlane,
      );
      const module = requiredStoredModule(
        entry.manifest.moduleFiles.hostPrivate,
        SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE,
      );
      return `  ( name = ${capnpText(`${entry.name}-v2-object-bucket`)},
    worker = (
      modules = [ (name = ${capnpText(SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE)}, esModule = embed ${capnpText(`${entry.storagePrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${module.key}`)}) ],
      bindings = [
        (name = ${capnpText(WORKERD_V2_PRIVATE_OBJECT_BUCKET_ORIGIN_BINDING)}, service = ${capnpText(`${entry.name}-v2-object-bucket-origin`)}),
        (name = ${capnpText(WORKERD_V2_PRIVATE_OBJECT_BUCKET_TOKEN_BINDING)}, text = ${capnpText(plane.token)})
      ],
      compatibilityDate = "2026-01-01", globalOutbound = "object-bucket-deny"
    )
  ),
  ( name = ${capnpText(`${entry.name}-v2-object-bucket-origin`)},
    external = ( address = ${capnpText(plane.address)}, http = () )
  ),`;
    })
    .join("\n");

  const v2KvServices = variants
    .filter((entry) => entry.manifest.v2KvPlane)
    .map((entry) => {
      if (isStaticManifest(entry.manifest)) throw new Error("static Version cannot bind v2 KV");
      const plane = validV2KvPlane(entry.manifest.v2KvPlane as WorkerdV2KvPlane);
      const module = requiredStoredModule(
        entry.manifest.moduleFiles.hostPrivate,
        SELFHOST_WORKER_DATA_SERVICE_MODULE,
      );
      return `  ( name = ${capnpText(`${entry.name}-v2-kv`)},
    worker = (
      modules = [ (name = ${capnpText(SELFHOST_WORKER_DATA_SERVICE_MODULE)}, esModule = embed ${capnpText(`${entry.storagePrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${module.key}`)}) ],
      bindings = [
        (name = ${capnpText(SELFHOST_WORKER_DATA_PLANE_BINDING)}, service = ${capnpText(`${entry.name}-v2-kv-origin`)}),
        (name = ${capnpText(SELFHOST_WORKER_DATA_TOKEN_BINDING)}, text = ${capnpText(plane.token)})
      ],
      compatibilityDate = "2026-01-01", globalOutbound = "v2-kv-deny"
    )
  ),
  ( name = ${capnpText(`${entry.name}-v2-kv-origin`)},
    external = ( address = ${capnpText(plane.address)}, http = () )
  ),`;
    })
    .join("\n");

  const v2QueueProducerServices = variants
    .filter((entry) => entry.manifest.v2QueueProducerPlane)
    .map((entry) => {
      if (isStaticManifest(entry.manifest))
        throw new Error("static Version cannot bind v2 Queue producer");
      const plane = validV2KvPlane(entry.manifest.v2QueueProducerPlane as WorkerdV2KvPlane);
      const module = requiredStoredModule(
        entry.manifest.moduleFiles.hostPrivate,
        SELFHOST_WORKER_DATA_SERVICE_MODULE,
      );
      return `  ( name = ${capnpText(`${entry.name}-v2-queue-producer`)},
    worker = (
      modules = [ (name = ${capnpText(SELFHOST_WORKER_DATA_SERVICE_MODULE)}, esModule = embed ${capnpText(`${entry.storagePrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${module.key}`)}) ],
      bindings = [
        (name = ${capnpText(SELFHOST_WORKER_DATA_PLANE_BINDING)}, service = ${capnpText(`${entry.name}-v2-queue-producer-origin`)}),
        (name = ${capnpText(SELFHOST_WORKER_DATA_TOKEN_BINDING)}, text = ${capnpText(plane.token)})
      ],
      compatibilityDate = "2026-01-01", globalOutbound = "v2-queue-producer-deny"
    )
  ),
  ( name = ${capnpText(`${entry.name}-v2-queue-producer-origin`)},
    external = ( address = ${capnpText(plane.address)}, http = () )
  ),`;
    })
    .join("\n");

  // One gate per script that receives events. It holds the token and the only
  // binding on this machine that names the script's event entrypoint; the
  // script itself is not reachable on the event hostname at all, and the
  // entrypoint the gate calls is a named export the router never addresses.
  const eventGateServices = variants
    .filter((entry) => entry.manifest.events)
    .map((entry) => {
      if (isStaticManifest(entry.manifest)) throw new Error("static Version cannot bind events");
      const gate = validEventGate(entry.manifest.events as WorkerdEventGate);
      const gateModule = requiredStoredModule(entry.manifest.moduleFiles.hostPrivate, gate.module);
      const gateBindings = [
        `(name = "${EVENT_TARGET_BINDING}", service = (name = ${capnpText(entry.name)}, entrypoint = "${EVENT_ENTRYPOINT}"))`,
        ...validBindings(gate.vars).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ].join(", ");
      return `  ( name = "${entry.name}-selfhost-events",
    worker = (
      modules = [ (name = ${capnpText(gate.module)}, esModule = embed ${capnpText(`${entry.storagePrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${gateModule.key}`)}) ],
      bindings = [ ${gateBindings} ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  // One stable logical fetch service owns the weighted choice. Private
  // variants are bound only here (and to their per-Version event gates), so
  // they have no hostname, router binding, or service-binding identity of
  // their own. Ordinary fetch forwards the original Request and returns the
  // original Response; readiness alone fans out to prove the complete graph.
  const deploymentRouterServices = published
    .filter((entry) => entry.weighted)
    .map((entry) => {
      const table = entry.variants.map((variant, index) => ({
        binding: `VERSION_${index.toString(10).padStart(5, "0")}`,
        readinessBinding: `READINESS_${index.toString(10).padStart(5, "0")}`,
        versionId: variant.versionId as string,
        weight: variant.weight as number,
      }));
      const versionBindings = entry.variants.flatMap((variant, index) => [
        `(name = ${capnpText(table[index]?.binding as string)}, service = ${capnpText(variantFetchService(variant))})`,
        `(name = ${capnpText(table[index]?.readinessBinding as string)}, service = ${capnpText(variant.name)})`,
      ]);
      return `  ( name = ${capnpText(logicalFetchService(entry))},
    worker = (
      modules = [ (name = ${capnpText(DEPLOYMENT_ROUTER_MODULE)}, esModule = embed ${capnpText(DEPLOYMENT_ROUTER_MODULE)}) ],
      bindings = [
        (name = "VERSIONS", json = ${capnpText(JSON.stringify(table))}),
        (name = "PUBLICATION", text = ${capnpText(
          createHash("sha256")
            .update(entry.generation as string, "utf8")
            .digest("hex"),
        )}),
        (name = "INTERNAL_HOSTNAME", text = ${capnpText(internalHostname(entry.name))}),
        (name = "INTERNAL_READINESS_CAPABILITY", text = ${capnpText(internalReadinessCapability)}),
        ${versionBindings.join(",\n        ")}
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  // The public event hostname reaches one stable dispatcher. It reads only a
  // bounded clone of the existing private envelope, requires this exact
  // logical script and a currently weighted deployment id, then forwards the
  // untouched original request to that Version's private token gate.
  const eventDispatcherServices = published
    .filter((entry) => entry.weighted && logicalEventService(entry) !== null)
    .map((entry) => {
      const table = entry.variants.map((variant, index) => ({
        binding: `VERSION_${index.toString(10).padStart(5, "0")}`,
        versionId: variant.versionId as string,
      }));
      const gateBindings = entry.variants.map(
        (variant, index) =>
          `(name = ${capnpText(table[index]?.binding as string)}, service = ${capnpText(`${variant.name}-selfhost-events`)})`,
      );
      return `  ( name = ${capnpText(logicalEventService(entry) as string)},
    worker = (
      modules = [ (name = ${capnpText(EVENT_DISPATCHER_MODULE)}, esModule = embed ${capnpText(EVENT_DISPATCHER_MODULE)}) ],
      bindings = [
        (name = "LOGICAL_WORKER", text = ${capnpText(entry.name)}),
        (name = "VERSIONS", json = ${capnpText(JSON.stringify(table))}),
        ${gateBindings.join(",\n        ")}
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  const routes = [
    ...published.flatMap((entry) =>
      entry.hostnames.map((hostname) => ({
        hostname,
        service: logicalFetchService(entry),
      })),
    ),
    // Last, so a customer domain that happens to claim one of these names
    // cannot capture this Host's own probe for another script.
    // Every script published through a generated entrypoint, not only the ones
    // that bind a data plane: the entrypoint answers the readiness question and
    // a script this Host cannot ask is one it publishes without checking.
    ...published
      .filter((entry) => entry.variants.every((variant) => hasHostReadiness(variant)))
      .map((entry) => ({
        hostname: internalHostname(entry.name),
        service: logicalFetchService(entry),
      })),
    ...published
      .filter((entry) => logicalEventService(entry) !== null)
      .map((entry) => ({
        hostname: eventHostname(entry.name),
        service: logicalEventService(entry) as string,
      })),
  ];
  const routeTable = JSON.stringify(Object.fromEntries(routes.map((r) => [r.hostname, r.service])));
  const internalReadinessRoutes = JSON.stringify(
    Object.fromEntries(
      published
        .filter((entry) => entry.variants.every((variant) => hasHostReadiness(variant)))
        .map((entry) => [internalHostname(entry.name), logicalFetchService(entry)]),
    ),
  );
  const bindings = [
    ...published.map((entry) => {
      const service = logicalFetchService(entry);
      return `      (name = ${capnpText(service)}, service = ${capnpText(service)}),`;
    }),
    ...published
      .map((entry) => logicalEventService(entry))
      .filter((entry): entry is string => entry !== null)
      .map((entry) => `      (name = ${capnpText(entry)}, service = ${capnpText(entry)}),`),
  ].join("\n");

  const privateSockets = privateServices
    ? [...privateServices.bindings.keys()].map(
        (router) =>
          `( name = ${capnpText(router)}, address = ${capnpText(`unix:${privateServiceSocket(privateServices.socketDirectory, router)}`)}, http = (style = proxy), service = ${capnpText(router)} )`,
      )
    : [];

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${services}
${assetServices}${serviceBindingServices === "" ? "" : `\n${serviceBindingServices}`}${v2BrokerExternalServiceConfig === "" ? "" : `\n${v2BrokerExternalServiceConfig}`}${dataServices === "" ? "" : `\n${dataServices}`}${queueSettlementServices === "" ? "" : `\n${queueSettlementServices}\n  (name = "queue-settlement-deny", network = (allow = [])),`}${v2ObjectBucketServices === "" ? "" : `\n${v2ObjectBucketServices}\n  (name = "object-bucket-deny", network = (allow = [])),`}${v2KvServices === "" ? "" : `\n${v2KvServices}\n  (name = "v2-kv-deny", network = (allow = [])),`}${v2QueueProducerServices === "" ? "" : `\n${v2QueueProducerServices}\n  (name = "v2-queue-producer-deny", network = (allow = [])),`}${actorExternalServices === "" ? "" : `\n${actorExternalServices}`}${workflowExternalServices === "" ? "" : `\n${workflowExternalServices}`}${eventGateServices === "" ? "" : `\n${eventGateServices}`}${deploymentRouterServices === "" ? "" : `\n${deploymentRouterServices}`}${eventDispatcherServices === "" ? "" : `\n${eventDispatcherServices}`}
  ( name = "router",
    worker = (
      modules = [ (name = "router.js", esModule = embed "router.js") ],
      bindings = [
        (name = "ROUTES", text = ${JSON.stringify(routeTable)}),
        (name = "INTERNAL_READINESS_ROUTES", text = ${capnpText(internalReadinessRoutes)}),
        (name = "INTERNAL_READINESS_CAPABILITY", text = ${capnpText(internalReadinessCapability)}),
        (name = "CONFIG_IDENTITY", text = ${capnpText(graphIdentity)}),
        (name = "CONFIG_PROBE_TOKEN", text = ${capnpText(configProbeToken ?? "")}),
        (name = "V2_SERVICE_DISPATCH_HOST", text = ${capnpText(serviceBindingDispatch?.internalHostname ?? "")}),
        (name = "V2_SERVICE_DISPATCH_TOKEN", text = ${capnpText(serviceBindingDispatch?.token ?? "")}),
${bindings}
      ],
      compatibilityDate = "2026-01-01",
    )
  ),
  ],
  sockets = [ ${[socket(port, tls), ...privateSockets].join(", ")} ]
);
`;
}

/**
 * The one socket the router answers on, and the only place a scheme is decided.
 *
 * With a keypair, workerd terminates TLS itself — `https` in workerd's own
 * schema, with the PEM text inline, which is why the generated configuration is
 * a `0600` file. Without one the socket is plain HTTP, and the Host publishes
 * `http://` for it rather than an `https://` address the socket cannot serve.
 */
function socket(port: number, tls?: WorkerdTlsKeypair): string {
  if (!tls) {
    return `( name = "http", address = "*:${port}", http = (), service = "router" )`;
  }
  const keypair = `keypair = ( privateKey = ${capnpText(tls.privateKey)}, certificateChain = ${capnpText(tls.certificateChain)} )`;
  return `( name = "https", address = "*:${port}", https = ( options = (), tlsOptions = ( ${keypair} ) ), service = "router" )`;
}

/**
 * The router, written beside the scripts so the config can embed it.
 *
 * Small on purpose: it reads a host, finds a binding, and forwards. Everything
 * it does not know about is a 404 naming the host, because the alternative —
 * falling back to some script — is how one customer's traffic reaches another
 * customer's code without anybody noticing.
 */
export const ROUTER_SOURCE = `const CONFIG_PROBE_HOSTNAME = ${JSON.stringify(CONFIG_PROBE_HOSTNAME)};
const CONFIG_PROBE_PATH = ${JSON.stringify(CONFIG_PROBE_PATH)};
const CONFIG_PROBE_HEADER = ${JSON.stringify(CONFIG_PROBE_HEADER)};
const CONFIG_IDENTITY_HEADER = ${JSON.stringify(CONFIG_IDENTITY_HEADER)};
const INTERNAL_READINESS_CAPABILITY_HEADER = ${JSON.stringify(INTERNAL_READINESS_CAPABILITY_HEADER)};
const SERVICE_ORIGINAL_URL_HEADER = ${JSON.stringify(V2_SERVICE_BINDING_ORIGINAL_URL_HEADER)};
const SERVICE_DISPATCH_TOKEN_HEADER = ${JSON.stringify(V2_SERVICE_BINDING_DISPATCH_TOKEN_HEADER)};

function restoreServiceRequest(request, original) {
  const headers = new Headers(request.headers);
  headers.delete(SERVICE_ORIGINAL_URL_HEADER);
  headers.delete(SERVICE_DISPATCH_TOKEN_HEADER);
  headers.set("host", original.host);
  const init = { method: request.method, headers, redirect: request.redirect };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(original.href, init);
}

function refuse() {
  return new Response(null, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    if (
      request.method === "POST" &&
      host === CONFIG_PROBE_HOSTNAME &&
      url.pathname === CONFIG_PROBE_PATH &&
      env.CONFIG_PROBE_TOKEN.length === 64 &&
      request.headers.get(CONFIG_PROBE_HEADER) === env.CONFIG_PROBE_TOKEN
    ) {
      return new Response(null, {
        status: 204,
        headers: { [CONFIG_IDENTITY_HEADER]: env.CONFIG_IDENTITY },
      });
    }
    const routes = JSON.parse(env.ROUTES);
    const service = routes[host];
    if (!service || !env[service]) {
      return new Response("no worker is published for " + host + "\\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const suppliedOriginal = request.headers.get(SERVICE_ORIGINAL_URL_HEADER);
    const suppliedDispatchToken = request.headers.get(SERVICE_DISPATCH_TOKEN_HEADER);
    if (suppliedOriginal !== null || suppliedDispatchToken !== null) {
      if (
        url.protocol !== "http:" ||
        url.host !== env.V2_SERVICE_DISPATCH_HOST ||
        request.headers.get("host") !== env.V2_SERVICE_DISPATCH_HOST ||
        !/^[0-9a-f]{64}$/u.test(env.V2_SERVICE_DISPATCH_TOKEN) ||
        suppliedDispatchToken !== env.V2_SERVICE_DISPATCH_TOKEN ||
        suppliedOriginal === null ||
        suppliedOriginal.length > 8192
      ) return refuse();
      let original;
      try {
        original = new URL(suppliedOriginal);
      } catch {
        return refuse();
      }
      if (
        original.href !== suppliedOriginal ||
        (original.protocol !== "http:" && original.protocol !== "https:") ||
        !original.hostname ||
        original.username ||
        original.password ||
        original.hash ||
        original.pathname !== url.pathname ||
        original.search !== url.search
      ) return refuse();
      return env[service].fetch(restoreServiceRequest(request, original));
    }
    const capability = request.headers.get(INTERNAL_READINESS_CAPABILITY_HEADER);
    if (capability !== null) {
      const internal = JSON.parse(env.INTERNAL_READINESS_ROUTES);
      if (
        capability !== env.INTERNAL_READINESS_CAPABILITY ||
        internal[host] !== service
      ) return refuse();
    }
    return env[service].fetch(request);
  },
};
`;

/** Host-only readiness for a module-less static Version; never serves public traffic. */
export const STATIC_READINESS_SOURCE = `const READINESS_PATH = ${JSON.stringify(WORKER_READINESS_PATH)};
const READINESS_HEADER = ${JSON.stringify(WORKER_READINESS_HEADER)};
const READINESS_PROTOCOL = ${JSON.stringify(WORKER_READINESS_PROTOCOL)};
const INTERNAL_READINESS_CAPABILITY_HEADER = ${JSON.stringify(INTERNAL_READINESS_CAPABILITY_HEADER)};
const READINESS_SCHEMA = "takoserver.selfhost-worker-readiness-result@v1";

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.hostname !== env.INTERNAL_HOSTNAME ||
        url.pathname !== READINESS_PATH ||
        request.headers.get(READINESS_HEADER) !== READINESS_PROTOCOL ||
        request.headers.get(INTERNAL_READINESS_CAPABILITY_HEADER) !== env.INTERNAL_READINESS_CAPABILITY) {
      return new Response(null, { status: 404 });
    }
    return new Response(JSON.stringify({ schema: READINESS_SCHEMA, publication: env.PUBLICATION }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
`;

/** Stable private entropy router for one complete weighted deployment. */
export const DEPLOYMENT_ROUTER_SOURCE = `const READINESS_PATH = ${JSON.stringify(WORKER_READINESS_PATH)};
const READINESS_HEADER = ${JSON.stringify(WORKER_READINESS_HEADER)};
const READINESS_PROTOCOL = ${JSON.stringify(WORKER_READINESS_PROTOCOL)};
const READINESS_SCHEMA = "takoserver.selfhost-worker-readiness-result@v1";
const INTERNAL_READINESS_CAPABILITY_HEADER = ${JSON.stringify(INTERNAL_READINESS_CAPABILITY_HEADER)};
const UINT32_RANGE = 0x1_0000_0000;
const RANDOM_LIMIT = UINT32_RANGE - (UINT32_RANGE % 10000);

function basisPoint() {
  const words = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(words);
    const value = words[0];
    if (value < RANDOM_LIMIT) return value % 10000;
  }
}

function selected(versions) {
  const point = basisPoint();
  let upper = 0;
  for (const version of versions) {
    upper += version.weight;
    if (point < upper) return version;
  }
  throw new Error("invalid weighted deployment");
}

function readinessAnswer(publication, status, failure) {
  return new Response(JSON.stringify({
    schema: READINESS_SCHEMA,
    publication,
    ...(failure ? { failure } : {}),
  }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readiness(request, env) {
  for (const version of env.VERSIONS) {
    const response = await env[version.readinessBinding].fetch(request.clone());
    const body = await response.text();
    let answer;
    try {
      answer = body.length <= 8192 ? JSON.parse(body) : null;
    } catch {
      answer = null;
    }
    if (
      !answer ||
      answer.schema !== READINESS_SCHEMA ||
      answer.publication !== version.versionId
    ) {
      return readinessAnswer(env.PUBLICATION, 503, { reason: "module" });
    }
    if (response.status !== 200) {
      return readinessAnswer(env.PUBLICATION, response.status, answer.failure ?? { reason: "module" });
    }
  }
  return readinessAnswer(env.PUBLICATION, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const capability = request.headers.get(INTERNAL_READINESS_CAPABILITY_HEADER);
    const internalReadiness =
      request.method === "POST" &&
      url.hostname === env.INTERNAL_HOSTNAME &&
      url.pathname === READINESS_PATH &&
      request.headers.get(READINESS_HEADER) === READINESS_PROTOCOL &&
      capability === env.INTERNAL_READINESS_CAPABILITY;
    if (internalReadiness) {
      return await readiness(request, env);
    }
    // A same-named header is Host-private. Never expose even an incorrect
    // guess to tenant code, and never treat it as authority on another shape.
    if (capability !== null) return new Response(null, { status: 404 });
    const version = selected(env.VERSIONS);
    // Selection is final. Transport failure propagates; no second Version is
    // sampled and the original Request/Response streams are never rebuilt.
    return await env[version.binding].fetch(request);
  },
};
`;

/** Stable dispatcher from one logical event route to one private Version gate. */
export const EVENT_DISPATCHER_SOURCE = `const EVENT_PATH = "/.well-known/takoserver/managed-worker-events/v1";
const V2_QUEUE_PATH = "/.well-known/takoserver/managed-worker-queue/v2";
const EVENT_HEADER = "x-takoserver-managed-worker-event";
const EVENT_PROTOCOL = "takoserver.managed-worker-event@v1";
const EVENT_CONTENT_TYPE = "application/vnd.takoserver.managed-worker-event.v1+json";
const V2_QUEUE_PROTOCOL = "takoserver.managed-worker-queue@v2";
const V2_QUEUE_CONTENT_TYPE = "application/vnd.takoserver.managed-worker-queue.v2+json";
const MAX_REQUEST_BYTES = ${2 * 1024 * 1024};

function refuse() {
  return new Response(null, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const v1 = url.pathname === EVENT_PATH;
    const v2Queue = url.pathname === V2_QUEUE_PATH;
    if (
      request.method !== "POST" ||
      (!v1 && !v2Queue) ||
      request.headers.get(EVENT_HEADER) !== (v1 ? EVENT_PROTOCOL : V2_QUEUE_PROTOCOL) ||
      request.headers.get("content-type") !== (v1 ? EVENT_CONTENT_TYPE : V2_QUEUE_CONTENT_TYPE)
    ) return refuse();
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_REQUEST_BYTES) return refuse();
    let bytes;
    let event;
    try {
      bytes = await request.clone().arrayBuffer();
      if (bytes.byteLength > MAX_REQUEST_BYTES) return refuse();
      event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return refuse();
    }
    if (
      !event ||
      typeof event !== "object" ||
      event.logicalWorkerId !== env.LOGICAL_WORKER ||
      typeof event.deploymentId !== "string"
    ) return refuse();
    const version = env.VERSIONS.find((candidate) => candidate.versionId === event.deploymentId);
    if (!version || !env[version.binding]) return refuse();
    // The selected private gate validates the original per-Version token and
    // the full existing envelope. Unknown or no-longer-weighted ids stop here.
    return await env[version.binding].fetch(request);
  },
};
`;

/**
 * Private logical-worker router for one immutable caller binding.
 *
 * An active native response is returned without reconstruction, which is what
 * preserves its stream and every response field. The token exists only on
 * this Host-owned service and in the caller's Host-private wrapper. A target
 * cannot manufacture the exact unavailable signal, even if it returns the
 * same status and header name intentionally.
 */
export const SERVICE_ROUTER_SOURCE = `const HEADER = ${JSON.stringify(SERVICE_UNAVAILABLE_HEADER)};
const BROKER_TOKEN_HEADER = ${JSON.stringify(PRIVATE_SERVICE_BINDING_TOKEN_HEADER)};
const ORIGINAL_URL_HEADER = ${JSON.stringify(V2_SERVICE_BINDING_ORIGINAL_URL_HEADER)};

function unavailable(env) {
  return new Response(null, {
    status: 530,
    headers: { [HEADER]: env.${SERVICE_UNAVAILABLE_TOKEN_BINDING} },
  });
}

export default {
  async fetch(request, env) {
    if (!env.TARGET || typeof env.TARGET.fetch !== "function") return unavailable(env);
    if (typeof env.BROKER_TOKEN === "string") {
      const headers = new Headers(request.headers);
      headers.set(BROKER_TOKEN_HEADER, env.BROKER_TOKEN);
      headers.set(ORIGINAL_URL_HEADER, request.url);
      const response = await env.TARGET.fetch(new Request(request, { headers }));
      if (response.status === 530 && response.headers.get(HEADER) === env.BROKER_TOKEN) {
        await response.body?.cancel();
        throw new Error("backend_unavailable");
      }
      return response;
    }
    // Native cancellation and request/response stream aborts are transport
    // outcomes, not evidence that target selection failed. Let them propagate;
    // the target wrapper has already converted an actual handler throw to 500.
    return await env.TARGET.fetch(request);
  },
};
`;

/**
 * The Host-owned HTTP composition layer for one Worker Version with assets.
 *
 * Only its service receives `WORKER` and `ASSETS`. The tenant service receives
 * neither, and the public router reaches this service only for customer
 * hostnames; the provider's readiness hostname still reaches the Worker
 * directly.
 */
export const ASSET_ROUTER_SOURCE = `const MISS_HEADER = "x-takoserver-selfhost-asset-miss";

function isAssetMiss(response) {
  return response.status === 404 && response.headers.get(MISS_HEADER) === "1";
}

function assetMethod(request) {
  return request.method === "GET" || request.method === "HEAD";
}

function finalStaticMiss(request) {
  return new Response(request.method === "HEAD" ? null : "not found\\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    // Bundle-backed Versions may declare no fetch handler. Asset hits still
    // serve, but misses and other HTTP methods must not dispatch Worker fetch.
    // Retained v1 code sites omit FETCH_HANDLER and keep their existing path.
    if (env.STATIC_ONLY === "true" || env.FETCH_HANDLER === "false") {
      if (!assetMethod(request)) return finalStaticMiss(request);
      const asset = await env.ASSETS.fetch(request);
      if (isAssetMiss(asset)) return finalStaticMiss(request);
      // Service Binding fetch can observe a HEAD response before HTTP ingress
      // strips a body. This also covers final malformed-path 404 responses.
      return request.method === "HEAD"
        ? new Response(null, { status: asset.status, statusText: asset.statusText, headers: asset.headers })
        : asset;
    }
    // A request body must cross exactly one service boundary. Static lookup is
    // not meaningful for another method and must not consume a body before the
    // application sees it.
    if (!assetMethod(request)) return env.WORKER.fetch(request);

    if (env.RUN_WORKER_FIRST === "true") {
      const worker = await env.WORKER.fetch(request);
      if (worker.status !== 404) return worker;
      const asset = await env.ASSETS.fetch(request);
      return isAssetMiss(asset) ? worker : asset;
    }

    const asset = await env.ASSETS.fetch(request);
    if (!isAssetMiss(asset)) return asset;
    return env.WORKER.fetch(request);
  },
};
`;

/**
 * The asset layer, written beside the scripts so the config can embed it.
 *
 * workerd's directory service answers with a file or with nothing. What a site
 * needs on top of that is small and entirely about exact path admission and
 * what a miss means. An application that routes on the client needs its shell
 * served for a valid path no file matches; malformed and ambiguous paths fail
 * closed before that fallback. Cloudflare's asset layer decides the former
 * from `notFoundHandling`, and the bounded URL safety rules decide the latter;
 * the manifest filename grammar is not an application URL allowlist.
 */
export const ASSETS_SOURCE = `const MISS_HEADER = "x-takoserver-selfhost-asset-miss";

async function file(env, entry) {
  // Logical manifest paths never become filesystem paths. The private
  // manifest maps each one to a Host-generated flat key, so two valid names
  // such as foo and foo/bar.txt cannot collide on disk.
  const response = await env.FILES.fetch("http://assets/" + entry.key, { method: "GET" });
  if (response.status === 404) return null;
  if (response.status !== 200) return response;
  // A directory answers 200 with a JSON listing of itself. That is exactly
  // distinguishable from a file, because the service never sniffs a type and
  // hands back every real file — .json included — as octet-stream. Serving
  // the listing would put the names of a customer's files on their homepage.
  if ((response.headers.get("content-type") ?? "").startsWith("application/json")) return null;
  return response;
}

function miss() {
  return new Response("not found\\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [MISS_HEADER]: "1",
    },
  });
}

function invalidPath() {
  // Retained v1 code+asset behavior: without the private miss marker, the
  // composition service treats this as final rather than entering a later
  // Worker stage or SPA fallback. V2 strict paths use miss() instead.
  return new Response("not found\\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function pathOf(request, strictPaths) {
  const rawUrl = typeof request.url === "string" ? request.url : "";
  const rawPath = rawUrl.split(/[?#]/u, 1)[0] ?? "";
  // Some URL implementations normalize encoded dot segments while parsing;
  // inspect the wire spelling first so traversal never becomes a native key.
  const rawLower = rawPath.toLowerCase();
  if (
    rawPath.split("/").some((segment) =>
      [".", "..", "%2e", "%2e%2e", "%2e.", ".%2e"].includes(segment.toLowerCase()),
    ) ||
    rawLower.includes("%2f") ||
    rawLower.includes("%5c")
  ) return null;
  let pathname;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  // Separators encoded into a segment must not turn into routing structure.
  if (/%(?:2f|5c)/i.test(pathname)) return null;
  let decoded;
  try {
    // decodeURIComponent is strict UTF-8 and throws on malformed escapes,
    // invalid sequences, and lone encoded surrogates. It is called once.
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\\\")) return null;
  for (const symbol of decoded) {
    const point = symbol.codePointAt(0);
    if (
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      (!strictPaths && point >= 0xfdd0 && point <= 0xfdef) ||
      (!strictPaths && (point & 0xffff) === 0xfffe) ||
      (!strictPaths && (point & 0xffff) === 0xffff)
    ) return null;
  }
  const path = decoded.slice(1);
  // Legacy application asset routes retain their existing treatment of root
  // and repeated slashes. A static-only Version follows the Form's stricter
  // path grammar and resolves root/trailing slash to an index lookup.
  if (path === "") return strictPaths ? "index.html" : path;
  const segments = path.split("/");
  const checkedSegments = segments.at(-1) === "" ? segments.slice(0, -1) : segments;
  if (checkedSegments.some((segment) =>
    segment === "." || segment === ".." || (strictPaths && segment === "")
  )) return null;
  if (strictPaths && segments.at(-1) === "") return path + "index.html";
  // URL paths are not constrained by the manifest filename grammar. A valid
  // Unicode, extensionless, or trailing-slash path can simply miss the
  // inventory and then follow the declared none/SPA fallback policy.
  return path;
}

function served(response, mediaType, status, head) {
  const headers = new Headers(response.headers);
  // Artifact evidence, not a filename table, is the meaning of these bytes.
  headers.set("content-type", mediaType);
  return new Response(head ? null : response.body, { status, headers });
}

function manifestEntry(env, path) {
  return Object.prototype.hasOwnProperty.call(env.ASSET_MANIFEST, path)
    ? env.ASSET_MANIFEST[path]
    : null;
}

export default {
  async fetch(request, env) {
    const assetPath = pathOf(request, env.STRICT_PATHS === "true");
    // V2 code+assets treats an unsearchable path as an asset miss, so an
    // asset-first Version can still dispatch its declared fetch handler.
    // Retained v1 code keeps the historical terminal invalid-path response.
    // A static-only Version turns the marked miss into its ordinary final 404.
    if (assetPath === null) return env.STRICT_PATHS === "true" ? miss() : invalidPath();

    const directEntry = assetPath === "" ? null : manifestEntry(env, assetPath);
    const direct = directEntry ? await file(env, directEntry) : null;
    if (direct) return direct.status === 200 ? served(direct, directEntry.mediaType, 200, request.method === "HEAD") : direct;

    if (env.NOT_FOUND === "single-page-application") {
      const shellEntry = manifestEntry(env, "index.html");
      const shell = shellEntry ? await file(env, shellEntry) : null;
      // Status 200, because the application is what was found and it will
      // route the path itself. A 200 is what Cloudflare's asset layer returns
      // here, and a client router behind a 404 is a different product.
      if (shell) return shell.status === 200 ? served(shell, shellEntry.mediaType, 200, request.method === "HEAD") : shell;
    }
    return miss();
  },
};
`;
