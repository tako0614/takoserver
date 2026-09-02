import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonObject, JsonValue } from "../ports.ts";
import {
  type ApplyInput,
  failed,
  PROVIDER_READBACK_API_VERSION,
  type Provider,
  type ProviderNativeAbsence,
  type ProviderNativeAbsenceUnknownReason,
  type ProviderNativeReadbackDescriptor,
  type ProviderNativeReadbackInput,
  type ProviderOffering,
  ProviderReadbackDescriptorError,
  type ProviderRelation,
  type ProviderSqliteMigration,
  type ProviderSqliteMigrationIdentity,
  type ProviderTicket,
  type ProviderValue,
  type ResourceIdentity,
  succeeded,
} from "../provider-port.ts";
import {
  MAX_PROVIDER_RUNTIME_INPUT_BINDINGS,
  type ProviderRuntimeInputDispatchedLease,
  type ProviderRuntimeInputLease,
  type ProviderRuntimeInputLeasePort,
  type ProviderRuntimeInputPublicApply,
  type ProviderRuntimeInputRecoveryLease,
  type ProviderRuntimeInputTarget,
} from "../provider-runtime-input-port.ts";
import {
  canonicalWorkerEndpointOrigin,
  derivedProviderResourceIncarnationName,
  derivedProviderResourceName,
} from "../provider-worker-endpoint-origin.ts";
import type { WorkerdRuntime } from "../workerd-runtime.ts";
import { parseSelfhostCron } from "./selfhost-cron.ts";
import {
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
  selfhostDataServiceSource,
} from "./selfhost-data-service.ts";
import {
  SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND,
  SELFHOST_WORKER_EVENT_SERVICE_MODULE,
  SELFHOST_WORKER_EVENT_TOKEN_BINDING,
  selfhostEventServiceSource,
} from "./selfhost-events.ts";
import {
  createSelfhostScriptStateStore,
  type SelfhostQueueConsumerAttachment,
  type SelfhostQueueTarget,
  type SelfhostScriptState,
  type SelfhostScriptStateSnapshot,
  SelfhostScriptStateStoreError,
} from "./selfhost-script-state.ts";
import {
  createSelfhostVersionBindingStore,
  normalizeSelfhostVersionBindingSet,
  SELFHOST_WORKER_HANDLER_NAMES,
  type SelfhostVersionBinding,
  type SelfhostVersionBindingSet,
  SelfhostVersionBindingStoreError,
  type SelfhostVersionDataBinding,
  type SelfhostVersionQueueSettings,
  type SelfhostWorkerHandlerName,
  type StoredSelfhostVersionBindings,
} from "./selfhost-version-bindings.ts";
import {
  createSelfhostVersionMaterializer,
  SelfhostVersionMaterializationError,
  type SelfhostVersionMaterializationRequest,
} from "./selfhost-version-materialization.ts";
import {
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
  SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  SELFHOST_WORKER_INTERNAL_BINDING_PREFIX,
  SELFHOST_WORKER_READINESS_HEADER,
  SELFHOST_WORKER_READINESS_PATH,
  SELFHOST_WORKER_READINESS_PROTOCOL,
  SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
  selfhostWorkerEntrypointSource,
} from "./selfhost-worker-wrapper.ts";

/**
 * Provisioning the released Takoform Edge Family on the machine this runs on.
 *
 * One provider, deliberately. A Worker Version that binds a KV namespace and a
 * bucket inherits the provider installation of every relation it pins, and the
 * driver refuses to bridge two installations — so a machine that sold its
 * buckets from one provider and its workers from another could never accept a
 * worker that uses both. Everything a self-hosted deployment executes locally
 * therefore lives behind this one id.
 *
 * What each Form honestly is here:
 *
 * - **ObjectBucket / EdgeKVNamespace / AtLeastOnceQueue** are namespaces. The
 *   data planes key their contents by resource uid, so creating one is
 *   agreeing that a name exists — the same promise Cloudflare charges per
 *   bucket for, with less machinery.
 * - **SQLiteDatabase** is a file under the data root. It appears when
 *   something writes to it, and the migration ledger below executes real SQL
 *   against it.
 * - **ModuleWorker / WorkerVersion / WorkerDeployment / WorkerEndpoint /
 *   WorkerCustomDomain** are executed for real: a version materializes its
 *   committed bundle to disk, a deployment publishes the winning version into
 *   the workerd runtime, and the endpoint and domain attachments decide which
 *   hostnames route to it. workerd cannot split traffic by percentage, so a
 *   weighted deployment serves its heaviest version and records the split it
 *   was asked for.
 * - **WorkerCronTrigger / QueueConsumer** are executed when this deployment
 *   composed a pump and a scheduler, and recorded honestly when it did not. An
 *   attachment writes itself into the script's own durable state and
 *   republishes, which is what puts the event gate in front of the Worker;
 *   `delivering` and `scheduled` say `true` only when something on this machine
 *   actually moves the message or fires the minute.
 *
 * A version's `vars` are projected into the workerd configuration as ordinary
 * environment bindings, kept in a `0600` record beside — never inside — the
 * immutable version directory, whose digest means "the bytes the tenant
 * committed" and must not move because a variable did.
 *
 * `requiredSensitiveVars` travel the same last mile, because workerd has no
 * separate notion of a secret: what makes them sensitive here is the file mode
 * and the rule that no value reaches an observation, an output, a native id, or
 * a log line. They arrive through the one-shot lease port, which this provider
 * only has when the operator configured a seal key ring — so a machine with
 * nowhere to keep a secret at rest advertises no capability and the declaration
 * is refused at admission rather than half-executed.
 */

const MAX_WORKER_VERSION_VARS = 64;
const WORKER_VERSION_VAR_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
/** The Form's own grammar and ceiling for a `kvBindings`/`sqliteBindings` name. */
const MAX_WORKER_VERSION_DATA_BINDINGS = 64;
const DATA_BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const SQLITE_MIGRATION_LEDGER = "_takoform_sqlite_migrations";
/**
 * How long a ledger statement waits for a tenant's lock, in milliseconds.
 *
 * Kept in step with the data plane's own `busy_timeout` by value: both open the
 * same file, and one of them failing instantly while the other waits is how a
 * migration reports a conflict that was never real.
 */
const SQLITE_LOCK_WAIT_MS = 5_000;
const SQLITE_MIGRATION_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${SQLITE_MIGRATION_LEDGER} (
  sequence INTEGER PRIMARY KEY NOT NULL CHECK (sequence > 0),
  path TEXT NOT NULL UNIQUE CHECK (length(path) BETWEEN 1 AND 255),
  digest TEXT NOT NULL CHECK (
    substr(digest, 1, 7) = 'sha256:' AND length(digest) = 71 AND
    substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
  )
)`;

export interface SelfhostArtifacts {
  /** The committed manifest a tenant holds, or null if it holds none. */
  manifest(
    tenantRef: string,
    digest: string,
  ): Promise<{
    readonly kind: string;
    readonly mainModule?: string;
    readonly modules?: readonly {
      readonly name: string;
      readonly mediaType?: string;
      readonly digest: string;
    }[];
    readonly files?: readonly {
      readonly path: string;
      readonly mediaType?: string;
      readonly digest: string;
    }[];
  } | null>;
  blob(digest: string): Promise<Uint8Array | null>;
}

export interface SelfhostProviderOptions {
  readonly id?: string;
  readonly offerings: readonly ProviderOffering[];
  /** Where databases, materialized versions, and script state live. */
  readonly dataRoot: string;
  /** The runtime deployments publish into. */
  readonly runtime: WorkerdRuntime;
  readonly artifacts: SelfhostArtifacts;
  /**
   * Suffix of the host-assigned Worker endpoint address
   * (`<script>.<suffix>`). `localhost` by default, because that is the one
   * name a self-hosted machine can honestly promise resolves to itself.
   */
  readonly workerEndpointSuffix?: string;
  /** Hostname suffixes custom domains may claim. Empty means any. */
  readonly suffixes?: readonly string[];
  /**
   * The one value-bearing seam for `requiredSensitiveVars`.
   *
   * Absent is a real answer, and the fail-closed one: an operator who has not
   * configured a seal key ring has nowhere to keep a secret at rest, so this
   * provider advertises no runtime-input capability and admission refuses the
   * declaration with `unsupported_capability` before any mutation happens.
   */
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
  /**
   * Loopback address of this Host's KV and SQL data planes.
   *
   * Absent is a real answer and the fail-closed one. A `kvBindings` or
   * `sqliteBindings` declaration is refused at apply on a deployment that
   * serves no plane, rather than published into a Worker whose `env.KV` would
   * throw on the first request — a broken facade is worse than a refusal,
   * because the refusal names the machine's missing half and the facade does
   * not.
   */
  readonly dataPlaneAddress?: string;
  /**
   * The housekeeping half of the data planes, when this deployment serves them.
   *
   * A lifecycle delete is the only thing that knows a namespace or a database
   * has stopped meaning what it meant, and the planes are the only thing
   * holding the rows and the open handle. Absent means this provider does not
   * serve storage, and there is nothing to reclaim.
   */
  readonly dataPlaneMaintenance?: SelfhostDataPlaneMaintenance;
  /**
   * The pump and the scheduler, when this deployment runs them.
   *
   * Absent is a real answer and the honest one: a Consumer or a Trigger is
   * still recorded and still republished — the declaration is desired state
   * either way — but the ticket says `delivering: false` and
   * `scheduled: false`, because nothing on this machine moves the message or
   * fires the minute. Saying otherwise would make a Host's own observation the
   * thing that lies.
   */
  readonly events?: SelfhostEventRuntime;
}

/**
 * The housekeeping a queue and a schedule need from whatever runs them.
 *
 * Declared here rather than imported, because the pump and the scheduler are
 * composed above this provider and this provider must not depend on them.
 */
export interface SelfhostEventRuntime {
  /** Drops every stored message of one queue, when the queue stops existing. */
  deleteQueue(queueId: string): Promise<void>;
  /** Forgets the next-fire state of one script's triggers, or of one trigger. */
  forgetSchedules(script: string, cron?: string): Promise<void>;
}

/**
 * What a Resource lifecycle asks of the running planes.
 *
 * Declared here rather than imported, because the planes are composed above
 * this provider and this provider must not depend on them.
 */
export interface SelfhostDataPlaneMaintenance {
  /** Drops every stored entry of one KV namespace. */
  deleteKvNamespace(namespaceId: string): Promise<void>;
  /** Closes and forgets the cached handle on one SQLite database. */
  forgetDatabase(name: string): void;
  /** Reclaims expired KV rows, bounded, for the maintenance tick. */
  sweepExpiredKv(limit?: number): Promise<number>;
}

/** Where this machine keeps one SQLite database. */
export function selfhostDatabasePath(dataRoot: string, name: string): string {
  return join(dataRoot, "databases", `${name}.sqlite`);
}

/** Where it keeps the runtime bindings of one immutable Worker Version. */
export function selfhostVersionBindingsRoot(dataRoot: string): string {
  return join(dataRoot, "selfhost", "version-bindings");
}

/** What one running Worker Version may reach, resolved from its own record. */
export interface SelfhostVersionDataGrant {
  readonly secret: string;
  readonly kv: Readonly<Record<string, string>>;
  readonly sql: Readonly<Record<string, string>>;
  /** Producer bindings, with the promise each queue makes about its messages. */
  readonly queue: Readonly<Record<string, SelfhostGrantedQueue>>;
}

export interface SelfhostGrantedQueue {
  readonly queueId: string;
  readonly messageRetentionSeconds: number;
  readonly deliveryDelaySeconds: number;
}

/**
 * The read-only half of the data-plane seam, for the composition that serves
 * the planes rather than the provider that publishes into them.
 *
 * It is exported from here because the on-disk layout is this module's, not
 * the entry's: an entry that recomputed the binding root and the database path
 * would be a second definition of where a Worker's data lives, and the two
 * would drift the first time either moved.
 */
export interface SelfhostDataPlaneAccess {
  grant(script: string, versionId: string): Promise<SelfhostVersionDataGrant | null>;
  databasePath(name: string): string;
}

/** Where this machine keeps the durable state of one Worker script. */
export function selfhostScriptStateRoot(dataRoot: string): string {
  return join(dataRoot, "selfhost", "scripts");
}

/**
 * One Worker this machine may have to deliver an event to.
 *
 * `versionId` is the deployment identity carried in the envelope: it names the
 * exact immutable Version the handler will run in, which is the only
 * "deployment" a self-hosted machine has.
 */
export interface SelfhostEventTarget {
  readonly script: string;
  readonly versionId: string;
  /** Presented to the gate in front of the Worker; never logged, never shown. */
  readonly eventToken: string;
  readonly handlers: readonly SelfhostWorkerHandlerName[];
  readonly consumers: readonly SelfhostQueueConsumerAttachment[];
  readonly crons: readonly string[];
}

/**
 * The read-only half of the event seam, for the pump and the scheduler.
 *
 * Exported from here for the same reason the data-plane access is: the on-disk
 * layout is this module's, and a pump that recomputed where a script's state
 * and its Version's token live would be a second definition of it.
 */
export interface SelfhostEventTargets {
  /** Every serving script with at least one Consumer or Trigger attached. */
  list(): Promise<readonly SelfhostEventTarget[]>;
}

export function createSelfhostEventTargets(dataRoot: string): SelfhostEventTargets {
  const scriptStates = createSelfhostScriptStateStore({ root: selfhostScriptStateRoot(dataRoot) });
  const bindings = createSelfhostVersionBindingStore({
    root: selfhostVersionBindingsRoot(dataRoot),
  });
  return {
    async list() {
      const entries = await readdir(selfhostScriptStateRoot(dataRoot)).catch(() => []);
      const targets: SelfhostEventTarget[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const script = entry.slice(0, -".json".length);
        if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(script)) continue;
        let state: SelfhostScriptState;
        try {
          state = (await scriptStates.read(script)).state;
        } catch {
          // A script whose durable state this Host cannot read is not one it
          // can deliver to. The next reconcile is what repairs it.
          continue;
        }
        const consumers = state.consumers ?? [];
        const crons = state.crons ?? [];
        if (!state.activeVersion || (consumers.length === 0 && crons.length === 0)) continue;
        let stored: StoredSelfhostVersionBindings | null;
        try {
          stored = await bindings.read(script, state.activeVersion);
        } catch {
          continue;
        }
        // A Version published before this Host could carry events has neither
        // a token nor a recorded handler list. Nothing is delivered to it, and
        // publishing a new Version is what changes that.
        if (!stored?.eventToken || !stored.handlers) continue;
        targets.push({
          script,
          versionId: state.activeVersion,
          eventToken: stored.eventToken,
          handlers: stored.handlers,
          consumers,
          crons,
        });
      }
      return targets;
    },
  };
}

export function createSelfhostDataPlaneAccess(dataRoot: string): SelfhostDataPlaneAccess {
  const bindings = createSelfhostVersionBindingStore({
    root: selfhostVersionBindingsRoot(dataRoot),
  });
  return {
    databasePath: (name) => selfhostDatabasePath(dataRoot, name),
    async grant(script, versionId) {
      let stored: StoredSelfhostVersionBindings | null;
      try {
        stored = await bindings.read(script, versionId);
      } catch {
        // A record this Host cannot read is not a grant it can honour. The
        // caller answers a presented token the same way it answers an unknown
        // one, so a corrupt file cannot be told apart from a wrong secret.
        return null;
      }
      const plane = stored?.dataPlane;
      if (!stored || !plane || !stored.planeToken) return null;
      // Null prototypes, because these are looked up by a name a tenant chose.
      // On an ordinary object `__proto__` and `constructor` are answers, and a
      // Worker binding under one of those names would resolve to a namespace no
      // record declared — the same one for every Version on the machine.
      const kv: Record<string, string> = Object.create(null) as Record<string, string>;
      const sql: Record<string, string> = Object.create(null) as Record<string, string>;
      const queue: Record<string, SelfhostGrantedQueue> = Object.create(null) as Record<
        string,
        SelfhostGrantedQueue
      >;
      for (const binding of plane.bindings) {
        if (binding.kind === "edge.kv") kv[binding.name] = binding.target;
        else if (binding.kind === "edge.sql") sql[binding.name] = binding.target;
        else if (binding.queue) {
          queue[binding.name] = {
            queueId: binding.target,
            messageRetentionSeconds: binding.queue.messageRetentionSeconds,
            deliveryDelaySeconds: binding.queue.deliveryDelaySeconds,
          };
        }
      }
      return { secret: stored.planeToken, kv, sql, queue };
    },
  };
}

/** The readiness envelope, or null for anything that is not exactly one. */
function readinessAnswer(body: string): { readonly publication: string } | null {
  if (body.length > 8_192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const answer = parsed as Record<string, unknown>;
  if (
    answer.schema !== SELFHOST_WORKER_READINESS_RESULT_SCHEMA ||
    typeof answer.publication !== "string"
  ) {
    return null;
  }
  return { publication: answer.publication };
}

class SelfhostFailure extends Error {
  readonly ticket: ProviderTicket;
  constructor(ticket: ProviderTicket) {
    super("selfhost provider failure");
    this.ticket = ticket;
  }
}

export function createSelfhostProvider(options: SelfhostProviderOptions): Provider {
  const id = options.id ?? "local";
  const { runtime, artifacts, dataRoot } = options;
  const endpointSuffix = (options.workerEndpointSuffix ?? "localhost").toLowerCase();
  const versionsRoot = join(dataRoot, "selfhost", "versions");
  const scriptsRoot = join(dataRoot, "selfhost", "scripts");
  const versionBindingsRoot = selfhostVersionBindingsRoot(dataRoot);
  const scriptStates = createSelfhostScriptStateStore({ root: scriptsRoot });
  const versionBindings = createSelfhostVersionBindingStore({ root: versionBindingsRoot });
  const runtimeInputs = options.runtimeInputs;
  const versionMaterializer = createSelfhostVersionMaterializer({
    root: versionsRoot,
    artifacts,
  });
  const inspectVersion = async (script: string, versionId: string) => {
    try {
      return await versionMaterializer.inspect({ script, versionId });
    } catch (error) {
      if (error instanceof SelfhostVersionMaterializationError) {
        throw new SelfhostFailure(
          failed(error.code, materializationMessage(error), error.code === "unavailable"),
        );
      }
      throw error;
    }
  };

  const serves = (hostname: string): boolean => {
    const suffixes = options.suffixes ?? [];
    if (suffixes.length === 0) return true;
    return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  };

  // Derived from the address, so the same declaration always names the same
  // thing and a retry cannot make a second one. Legacy readable form for the
  // bucket namespace, hash form for everything DNS- or filename-shaped.
  const legacyName = (identity: ResourceIdentity): string =>
    `${identity.tenantRef}-${identity.space}-${identity.name}`.replace(/[^A-Za-z0-9_-]/gu, "_");

  const scriptOf = (
    tenantRef: string,
    resource: { readonly space: string; readonly name: string },
  ): Promise<string> =>
    derivedProviderResourceName("sw", {
      tenantRef,
      space: resource.space,
      name: resource.name,
    });

  const versionIdOf = (
    tenantRef: string,
    resource: { readonly space: string; readonly name: string },
  ): Promise<string> =>
    derivedProviderResourceName("v", {
      tenantRef,
      space: resource.space,
      name: resource.name,
    });

  const databasePath = (name: string): string => selfhostDatabasePath(dataRoot, name);

  const scriptStateOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof SelfhostScriptStateStoreError)) throw error;
      if (error.code === "conflict") {
        throw new SelfhostFailure(
          failed("conflict", "the Worker script state changed concurrently", true),
        );
      }
      if (error.code === "corrupt") {
        throw new SelfhostFailure(
          failed("provider_error", "the durable Worker script state is malformed"),
        );
      }
      throw new SelfhostFailure(
        failed("unavailable", "the durable Worker script state is unavailable", true),
      );
    }
  };

  // Runtime publication is an adapter boundary too. A write or reload that
  // throws is not evidence that the durable desired state was rejected, so
  // surface it as a retryable provider outcome and let the next reconcile
  // replay the publication from script state.
  const runtimeOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SelfhostFailure) throw error;
      throw new SelfhostFailure(failed("unavailable", "the Worker runtime is unavailable", true));
    }
  };

  const bindingStoreOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof SelfhostVersionBindingStoreError)) throw error;
      if (error.code === "corrupt") {
        throw new SelfhostFailure(
          failed("provider_error", "the durable Worker Version bindings are malformed"),
        );
      }
      throw new SelfhostFailure(
        failed("unavailable", "the durable Worker Version bindings are unavailable", true),
      );
    }
  };

  const readVersionBindings = (
    script: string,
    versionId: string,
  ): Promise<StoredSelfhostVersionBindings | null> =>
    bindingStoreOperation(() => versionBindings.read(script, versionId));

  // Runtime activation is identified by the complete desired route set and the
  // exact environment, not merely by the active version. An endpoint/domain
  // write can stage a new manifest while reload still serves the previous route
  // table, and a version whose bindings were written after its first publish
  // would otherwise report a stale environment as serving. A version that
  // declares no binding contributes nothing, so its generation is byte-for-byte
  // what it was before bindings existed.
  const runtimeGeneration = async (script: string, state: SelfhostScriptState): Promise<string> => {
    const bindings = state.activeVersion
      ? await readVersionBindings(script, state.activeVersion)
      : null;
    return JSON.stringify({
      activeVersion: state.activeVersion ?? null,
      endpointHostname: state.endpointHostname ?? null,
      domains: state.domains,
      ...(bindings ? { bindingsDigest: bindings.digest } : {}),
    });
  };

  const readScriptState = (script: string): Promise<SelfhostScriptStateSnapshot> =>
    scriptStateOperation(() => scriptStates.read(script));

  const writeScriptState = (
    script: string,
    current: SelfhostScriptStateSnapshot,
    state: SelfhostScriptState,
  ): Promise<SelfhostScriptStateSnapshot> =>
    scriptStateOperation(() => scriptStates.write(script, current.revision, state));

  const removeScriptState = (script: string): Promise<boolean> =>
    scriptStateOperation(() => scriptStates.remove(script));

  /**
   * The generated entrypoint one publication needs, or null when it needs none.
   *
   * A version that binds no namespace, queue, or database and receives no event
   * is published exactly as it was before this Host could generate anything:
   * same main module, same module list, same bindings, same bytes.
   */
  const wrapperProjection = (
    script: string,
    versionId: string,
    mainModule: string,
    bindings: StoredSelfhostVersionBindings | null,
    events: boolean,
    generation: string,
  ): {
    source: Uint8Array;
    facade: Uint8Array | null;
    gate: Uint8Array | null;
    publication: string;
    token: SelfhostVersionBinding | null;
    eventToken: SelfhostVersionBinding | null;
  } | null => {
    const plane = bindings?.dataPlane;
    if (!bindings || (!plane && !events)) return null;
    if (plane && (!options.dataPlaneAddress || !bindings.planeToken)) {
      throw new SelfhostFailure(
        failed(
          "provider_error",
          "the Worker Version binds a data plane this deployment does not serve",
        ),
      );
    }
    // A Version published before this Host recorded handlers has no way to be
    // wrapped: the wrapper must re-export exactly what the Version declared,
    // and that declaration is not recoverable from the materialized bundle.
    // Refusing beats publishing an entrypoint that drops the event.
    if (!bindings.handlers || (events && !bindings.eventToken)) {
      throw new SelfhostFailure(
        failed(
          "invalid_spec",
          "the active Worker Version predates event delivery on this Host; publish a new Version",
        ),
      );
    }
    for (const generated of [
      SELFHOST_WORKER_ENTRYPOINT_MODULE,
      SELFHOST_WORKER_DATA_SERVICE_MODULE,
      SELFHOST_WORKER_EVENT_SERVICE_MODULE,
    ]) {
      if (mainModule === generated) {
        throw new SelfhostFailure(
          failed("invalid_spec", "the Worker bundle claims this Host's entrypoint module name"),
        );
      }
    }
    // The generation, not the version: two publications of one Version differ
    // when its routes do, and a readiness answer has to be attributable to the
    // exact configuration that asked for it or a stale one passes for it.
    // Hashed because the generation carries customer hostnames and this string
    // is compiled into a module the tenant's own isolate loads.
    const publication = createHash("sha256").update(generation, "utf8").digest("hex");
    let source: string;
    try {
      source = selfhostWorkerEntrypointSource({
        publication,
        originalMainModule: mainModule,
        declaredHandlers: bindings.handlers,
        ...(events ? { events: true } : {}),
        bindings: [
          ...bindings.vars.map((binding) => ({
            name: binding.name,
            type: binding.kind === "json" ? ("json" as const) : ("plain_text" as const),
          })),
          ...bindings.sensitiveVars.map((binding) => ({
            name: binding.name,
            type: "secret_text" as const,
          })),
          ...(plane?.bindings ?? []).map((binding) => ({
            kind:
              binding.kind === "edge.kv"
                ? SELFHOST_WORKER_EDGE_KV_BINDING_KIND
                : binding.kind === "edge.queue"
                  ? SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND
                  : SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
            publicName: binding.name,
          })),
        ],
      });
    } catch {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Worker Version environment cannot be projected"),
      );
    }
    return {
      source: new TextEncoder().encode(source),
      facade: plane ? new TextEncoder().encode(selfhostDataServiceSource()) : null,
      gate: events ? new TextEncoder().encode(selfhostEventServiceSource()) : null,
      publication,
      // The token names the version it was minted for, so the plane resolves
      // one record rather than searching every version for a matching secret.
      // It is declared on the facade service and nowhere else.
      token:
        plane && bindings.planeToken
          ? {
              name: SELFHOST_WORKER_DATA_TOKEN_BINDING,
              value: `${script}.${versionId}.${bindings.planeToken}`,
              kind: "text",
            }
          : null,
      // The event token names nothing: the gate compares it whole, and the
      // script it protects is the one it is declared beside.
      eventToken:
        events && bindings.eventToken
          ? {
              name: SELFHOST_WORKER_EVENT_TOKEN_BINDING,
              value: bindings.eventToken,
              kind: "text",
            }
          : null,
    };
  };

  /**
   * Whether the pair this Host just published actually loads what it declared.
   *
   * The wrapper validates the declared handlers when it first imports the
   * tenant module. Without this, that first import is a customer request, and a
   * Version declaring a handler its module does not export is published — the
   * attachment upstream is gated on the declaration, so the event is accepted
   * and dropped. So the publication asks, over the router this runtime serves,
   * and refuses on a definite bad answer.
   *
   * A runtime that does not answer is not a bad answer. workerd may be
   * restarting on the configuration just written, or not running at all on a
   * machine whose serving half is composed separately, and turning "I could not
   * ask" into "your Worker is broken" would refuse valid publications. The
   * answer carries the publication it came from, so a stale configuration is
   * told apart from the one being published rather than believed.
   */
  const probeReadiness = async (script: string, publication: string): Promise<void> => {
    const probe = runtime.probe;
    if (!probe) return;
    const deadline = Date.now() + 5_000;
    let alive = false;
    for (let attempt = 0; ; attempt += 1) {
      const response = await probe(script, SELFHOST_WORKER_READINESS_PATH, {
        method: "POST",
        headers: { [SELFHOST_WORKER_READINESS_HEADER]: SELFHOST_WORKER_READINESS_PROTOCOL },
      }).catch(() => null);
      if (response) {
        alive = true;
        const parsed = readinessAnswer(response.body);
        if (parsed?.publication === publication) {
          if (response.status === 200) return;
          throw new SelfhostFailure(
            failed(
              "invalid_spec",
              "the Worker Version's module does not export every handler it declares",
            ),
          );
        }
      }
      // Nothing has answered on that address and nothing ever did: this
      // deployment does not run the runtime in this process, so there is
      // nothing to ask and waiting would turn "I could not ask" into a refused
      // publication. Once it has answered once, an answer that is not this
      // publication's is a configuration on its way out, and worth waiting for.
      if (!alive || Date.now() >= deadline) return;
      await new Promise<void>((wake) => setTimeout(wake, attempt === 0 ? 25 : 100));
    }
  };

  /** Whether anything is attached to this script that delivers it an event. */
  const receivesEvents = (state: SelfhostScriptState): boolean =>
    (state.consumers ?? []).length > 0 || (state.crons ?? []).length > 0;

  /** Rewrites what workerd serves for one script from durable state alone. */
  const republish = async (script: string): Promise<void> => {
    const { state } = await readScriptState(script);
    if (!state.activeVersion) {
      await runtimeOperation(() => runtime.remove(script));
      await runtimeOperation(() => runtime.reload());
      return;
    }
    const versionDirectory = join(versionsRoot, script, state.activeVersion);
    const inspected = await inspectVersion(script, state.activeVersion);
    if (inspected.state === "absent" || inspected.state === "corrupt") {
      throw new SelfhostFailure(
        failed("provider_error", "the active Worker Version is not materialized on this machine"),
      );
    }
    const meta = inspected.meta;
    const modules = await readTree(join(versionDirectory, "modules"));
    const assets = meta.assets ? await readTree(join(versionDirectory, "assets")) : undefined;
    const hostnames = [
      ...(state.endpointHostname ? [state.endpointHostname] : []),
      ...state.domains,
    ];
    // Environment comes from the version's own durable record, not from the
    // materialized tree, so a republish projects exactly what its apply
    // recorded and nothing a later edit of the directory could introduce.
    const bindings = await readVersionBindings(script, state.activeVersion);
    const vars = bindings ? [...bindings.vars, ...bindings.sensitiveVars] : [];
    const generation = await runtimeGeneration(script, state);
    const projection = wrapperProjection(
      script,
      state.activeVersion,
      meta.mainModule,
      bindings,
      receivesEvents(state),
      generation,
    );
    if (projection) {
      // Written into the workerd script directory, never into the version
      // directory: `materializationDigest` means "the bytes the tenant
      // committed", and a module this Host generated is not one of them.
      //
      // A tenant module under either generated name would be overwritten here
      // and silently replaced, so the publication stops instead.
      for (const generated of [
        SELFHOST_WORKER_ENTRYPOINT_MODULE,
        SELFHOST_WORKER_DATA_SERVICE_MODULE,
        SELFHOST_WORKER_EVENT_SERVICE_MODULE,
      ]) {
        if (modules.has(generated)) {
          throw new SelfhostFailure(
            failed("invalid_spec", "the Worker bundle claims this Host's entrypoint module name"),
          );
        }
      }
      modules.set(SELFHOST_WORKER_ENTRYPOINT_MODULE, projection.source);
      if (projection.facade) {
        modules.set(SELFHOST_WORKER_DATA_SERVICE_MODULE, projection.facade);
      }
      if (projection.gate) {
        modules.set(SELFHOST_WORKER_EVENT_SERVICE_MODULE, projection.gate);
      }
    }
    await runtimeOperation(() =>
      runtime.write(
        script,
        {
          directory: script,
          mainModule: projection ? SELFHOST_WORKER_ENTRYPOINT_MODULE : meta.mainModule,
          hostnames,
          generation,
          ...(meta.assets ? { assets: { notFoundHandling: meta.assets.notFoundHandling } } : {}),
          ...(vars.length > 0 ? { vars } : {}),
          ...(projection
            ? {
                modules: [meta.mainModule],
                // The token rides on the facade service's own binding list, so
                // it is never a binding of the service that runs tenant code.
                ...(projection.facade && projection.token
                  ? {
                      dataPlane: {
                        address: options.dataPlaneAddress as string,
                        module: SELFHOST_WORKER_DATA_SERVICE_MODULE,
                        vars: [projection.token],
                      },
                    }
                  : {}),
                // Same discipline for the event token, and one more thing: the
                // gate is the only service holding a binding that names this
                // script's event entrypoint.
                ...(projection.gate && projection.eventToken
                  ? {
                      events: {
                        module: SELFHOST_WORKER_EVENT_SERVICE_MODULE,
                        vars: [projection.eventToken],
                      },
                    }
                  : {}),
              }
            : {}),
        },
        modules,
        assets,
      ),
    );
    await runtimeOperation(() => runtime.reload());
    if (projection) await probeReadiness(script, projection.publication);
  };

  const endpointAddress = (
    input: ApplyInput,
  ): { hostname: string; url: string; assignmentDigest: `sha256:${string}` } => {
    const assignment = input.workerEndpointOriginAssignment;
    const origin = assignment?.canonicalPublicOrigin;
    if (!assignment || !origin || origin.length > 2_048) {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Host-assigned Worker endpoint origin is unavailable"),
      );
    }
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== "" ||
        url.origin !== origin ||
        !serves(url.hostname)
      ) {
        throw new TypeError();
      }
      return {
        hostname: url.hostname,
        url: `${origin}/`,
        assignmentDigest: assignment.assignmentDigest,
      };
    } catch {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Host-assigned Worker endpoint origin is invalid"),
      );
    }
  };

  /** The one relation a pointer names, held to the expected target kind. */
  const relationResource = (
    relations: readonly ProviderRelation[] | undefined,
    pointer: string,
    kind: string,
  ): ProviderRelation["resource"] | null => {
    const relation = relations?.find((candidate) => candidate.pointer === pointer);
    return relation?.resource.kind === kind ? relation.resource : null;
  };

  /** A create mints a fresh native identity; an update keeps the recorded one. */
  const nativeId = (input: ApplyInput, base: string): string =>
    input.previous?.nativeId ?? `${base}:${input.operationId}`;

  /**
   * Whether this machine can actually take a sensitive declaration.
   *
   * Every part has to be there: a lease port, the operation key both halves of
   * the handoff are addressed by, a way to revoke one whose values never
   * landed, the Resource UID the claim is fenced to, and the exact logical
   * target. Missing any of them is `denied` before a file exists, not a failure
   * after one does.
   */
  const leasesAvailable = (input: ApplyInput, target: ProviderRuntimeInputTarget | null): boolean =>
    Boolean(runtimeInputs?.abandon && input.operationKey && input.identity.uid && target);

  /**
   * The same question for the apply path, plus the one thing only a claim
   * needs: the exact executing request. Without it the authority cannot
   * recompute the commitment the preparation was made against, so this Host
   * refuses before a file exists rather than spending a handoff unfenced.
   */
  const claimAvailable = (input: ApplyInput, target: ProviderRuntimeInputTarget | null): boolean =>
    leasesAvailable(input, target) && Boolean(input.publicApply);

  /** The exact logical Worker this version's sensitive values belong to. */
  const sensitiveTarget = (input: ApplyInput): ProviderRuntimeInputTarget | null => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const bundle = relationResource(input.relations, "/bundle", "WorkerBundle");
    if (!worker || !bundle) return null;
    return {
      space: input.identity.space,
      workerName: worker.metadata.name,
      workerResourceUid: worker.metadata.uid,
      bundleName: bundle.metadata.name,
    };
  };

  /**
   * The Worker Version's own non-secret environment.
   *
   * A string becomes a `text` binding and anything else a `json` one, which is
   * exactly the split the managed backend makes, so the same declaration means
   * the same thing on both. Names are held to the Form's own grammar rather
   * than rewritten: a mangled variable is one the module cannot find.
   */
  const declaredVars = (spec: JsonObject): readonly SelfhostVersionBinding[] => {
    const declared = spec.vars;
    if (declared === undefined) return [];
    if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
      throw new SelfhostFailure(failed("invalid_spec", "the Worker Version vars are invalid"));
    }
    const entries = Object.entries(declared as JsonObject);
    if (entries.length > MAX_WORKER_VERSION_VARS) {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Worker Version declares too many vars"),
      );
    }
    return entries
      .map(([name, value]) => {
        if (!WORKER_VERSION_VAR_NAME.test(name) || value === undefined) {
          throw new SelfhostFailure(failed("invalid_spec", "the Worker Version vars are invalid"));
        }
        return typeof value === "string"
          ? { name, value, kind: "text" as const }
          : { name, value: JSON.stringify(value), kind: "json" as const };
      })
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  };

  /**
   * The Worker Version's KV, queue, and SQLite bindings, resolved to what they
   * address.
   *
   * Every declaration has to line up with a relation this Host itself
   * provisioned: the related Resource's kind, the native id this provider
   * minted for it, and the output it published all have to name the same
   * namespace or database. A relation another provider deployed produces a
   * native id this parser does not recognize and is refused rather than
   * guessed at, because "which store is `env.DB`" is not a question to answer
   * approximately.
   */
  const declaredDataBindings = (
    input: ApplyInput,
    reserved: ReadonlySet<string>,
  ): readonly SelfhostVersionDataBinding[] => {
    const bindings: SelfhostVersionDataBinding[] = [];
    const names = new Set<string>(reserved);
    const invalid = (): never => {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Worker Version data bindings are invalid"),
      );
    };
    for (const [field, kind, resourceKind, prefix] of [
      ["kvBindings", "edge.kv", "EdgeKVNamespace", "selfhost-kv"],
      ["queueProducerBindings", "edge.queue", "AtLeastOnceQueue", "selfhost-queue"],
      ["sqliteBindings", "edge.sql", "SQLiteDatabase", "selfhost-sqlite"],
    ] as const) {
      const raw = input.spec[field];
      if (raw === undefined) continue;
      if (!Array.isArray(raw)) invalid();
      const declared = raw as readonly JsonValue[];
      if (declared.length > MAX_WORKER_VERSION_DATA_BINDINGS) invalid();
      for (let index = 0; index < declared.length; index += 1) {
        const declaration = isJsonObject(declared[index]) ? (declared[index] as JsonObject) : null;
        const name = typeof declaration?.name === "string" ? declaration.name : null;
        const relation = input.relations?.find(
          (candidate) => candidate.pointer === `/${field}/${index}/resource`,
        );
        const target = selfhostNamespaceTarget(relation, prefix, resourceKind, databasePath);
        if (
          !name ||
          name.length > 64 ||
          !DATA_BINDING_NAME.test(name) ||
          name.startsWith(SELFHOST_WORKER_INTERNAL_BINDING_PREFIX) ||
          names.has(name) ||
          !target
        ) {
          invalid();
        }
        names.add(name as string);
        // A queue's own promise about its messages travels with the binding,
        // because the plane applies it at the moment one is accepted.
        const settings = kind === "edge.queue" ? queueSettings(relation) : undefined;
        if ((settings === undefined) !== (kind !== "edge.queue")) invalid();
        bindings.push({
          kind,
          name: name as string,
          target: target as string,
          ...(settings ? { queue: settings } : {}),
        });
      }
    }
    return bindings;
  };

  /**
   * What a queue promises about the messages put into it, read from the exact
   * Resource the relation names.
   *
   * Both fields come from the queue's own desired state, which is the only
   * place they exist: `messageRetentionSeconds` is required by the Form and
   * `deliveryDelaySeconds` defaults to none.
   */
  const queueSettings = (
    relation: ProviderRelation | undefined,
  ): SelfhostVersionQueueSettings | undefined => {
    const spec = relation?.resource.spec;
    const retention = spec?.messageRetentionSeconds;
    const delay = spec?.deliveryDelaySeconds ?? 0;
    if (
      typeof retention !== "number" ||
      !Number.isSafeInteger(retention) ||
      retention < 60 ||
      retention > 1_209_600 ||
      typeof delay !== "number" ||
      !Number.isSafeInteger(delay) ||
      delay < 0 ||
      delay > 43_200
    ) {
      return undefined;
    }
    return { messageRetentionSeconds: retention, deliveryDelaySeconds: delay };
  };

  /**
   * The events the version says its module answers.
   *
   * Recorded for every Version now, because a Cron Trigger or a Queue Consumer
   * is attached long after the Version was published and the wrapper that
   * receives the event has to re-export exactly these.
   */
  const declaredHandlers = (spec: JsonObject): readonly SelfhostWorkerHandlerName[] => {
    const declared = spec.handlers;
    if (!Array.isArray(declared) || declared.length < 1) {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Worker Version declares no event handlers"),
      );
    }
    const handlers = declared.filter(
      (handler): handler is SelfhostWorkerHandlerName =>
        typeof handler === "string" &&
        (SELFHOST_WORKER_HANDLER_NAMES as readonly string[]).includes(handler),
    );
    if (handlers.length !== declared.length || new Set(handlers).size !== handlers.length) {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Worker Version event handlers are invalid"),
      );
    }
    return [...handlers].sort();
  };

  /**
   * Records the environment and the declared handlers for one immutable
   * version.
   *
   * Written for every version, including one that declares nothing: the
   * handlers and the event token are facts about the Version that a Consumer or
   * a Trigger attached later has no other way to learn. It changes no rendered
   * byte — a version with no binding and no attachment still publishes the
   * exact configuration it published before this Host could project any.
   */
  const writeVersionBindings = async (
    script: string,
    versionId: string,
    set: SelfhostVersionBindingSet,
  ): Promise<void> => {
    await bindingStoreOperation(() => versionBindings.write(script, versionId, set));
  };

  const applyModuleWorker = async (input: ApplyInput): Promise<ProviderTicket> => {
    const script = await scriptOf(input.identity.tenantRef, {
      space: input.identity.space,
      name: input.identity.name,
    });
    return succeeded({
      nativeId: nativeId(input, `selfhost-worker:${script}`),
      observed: { scriptName: script, allocated: true },
      outputs: { scriptName: script },
    });
  };

  const applyWorkerVersion = async (input: ApplyInput): Promise<ProviderTicket> => {
    if (input.previous) return failed("invalid_spec", "Worker Versions are immutable");
    const requiredSensitive = sensitiveBindingNames(input.spec.requiredSensitiveVars);
    if (!requiredSensitive) {
      return failed("invalid_spec", "the sensitive Worker binding declaration is invalid");
    }
    const runtimeInputTarget = sensitiveTarget(input);
    if (requiredSensitive.length > 0 && !claimAvailable(input, runtimeInputTarget)) {
      return failed("denied", "required sensitive Worker runtime inputs are unavailable");
    }
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const bundle = relationResource(input.relations, "/bundle", "WorkerBundle");
    const manifestDigest =
      typeof bundle?.spec.manifestDigest === "string" ? bundle.spec.manifestDigest : null;
    if (!worker || !manifestDigest) {
      return failed("invalid_spec", "the Worker Version is incomplete");
    }
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const versionId = await versionIdOf(input.identity.tenantRef, {
      space: input.identity.space,
      name: input.identity.name,
    });
    const vars = declaredVars(input.spec);
    // Resolved before the lease is acquired, because everything here is a
    // declarative refusal and a refusal after dispatch would strand the
    // operation key with its ciphertext already erased.
    const dataBindings = declaredDataBindings(
      input,
      new Set([...vars.map((binding) => binding.name), ...requiredSensitive]),
    );
    if (dataBindings.length > 0 && !options.dataPlaneAddress) {
      return failed(
        "denied",
        "this deployment serves no data plane, so the Worker Version's bindings cannot be projected",
      );
    }
    const handlers = declaredHandlers(input.spec);
    const dataPlane = dataBindings.length > 0 ? { bindings: dataBindings } : undefined;
    const assetsSpec =
      typeof input.spec.assets === "object" && input.spec.assets !== null
        ? (input.spec.assets as JsonObject)
        : null;
    let assetsInput: SelfhostVersionMaterializationRequest["assets"] | undefined;
    if (assetsSpec) {
      const assetBundle = relationResource(input.relations, "/assets/bundle", "StaticAssetBundle");
      const assetsDigest =
        typeof assetBundle?.spec.manifestDigest === "string"
          ? assetBundle.spec.manifestDigest
          : null;
      if (!assetsDigest) return failed("invalid_spec", "the Static Asset Bundle is unavailable");
      assetsInput = {
        manifestDigest: assetsDigest,
        notFoundHandling:
          assetsSpec.notFoundHandling === "single_page_application"
            ? "single-page-application"
            : "none",
      };
    }

    // The lease is claimed before anything is materialized, so a Worker Version
    // whose secrets this Host cannot obtain leaves nothing behind on disk.
    let lease: ProviderRuntimeInputLease | undefined;
    if (requiredSensitive.length > 0 && runtimeInputTarget) {
      try {
        lease = await (runtimeInputs as ProviderRuntimeInputLeasePort).acquire({
          organizationId: input.identity.tenantRef,
          operationId: input.operationId,
          resourceUid: input.identity.uid as string,
          reference: input.operationKey as string,
          target: runtimeInputTarget,
          bindingNames: requiredSensitive,
          publicApply: input.publicApply as ProviderRuntimeInputPublicApply,
        });
      } catch (error) {
        return runtimeInputFailure(error, "acquire");
      }
      if (!exactRuntimeInputBindings(lease.bindings, requiredSensitive)) {
        const aborted = await abortRuntimeLease(lease);
        return (
          aborted ?? failed("denied", "required sensitive Worker runtime inputs are unavailable")
        );
      }
    }

    const sensitiveVars: readonly SelfhostVersionBinding[] = lease
      ? requiredSensitive.map((name) => ({
          name,
          value: lease.bindings[name] as string,
          kind: "text" as const,
        }))
      : [];
    // Everything the environment can be refused for without touching a disk —
    // shape, grammar, ordering, and a `vars` name colliding with a sensitive one
    // — is decided here, while the lease can still be aborted. A declarative
    // refusal after dispatch would strand the operation key: the ciphertext is
    // gone, the handoff is not replaceable, and the same plan-derived key comes
    // back on every retry.
    let bindingSet: SelfhostVersionBindingSet;
    try {
      bindingSet = normalizeSelfhostVersionBindingSet({
        handlers,
        vars,
        sensitiveVars,
        ...(dataPlane ? { dataPlane } : {}),
      });
    } catch (error) {
      if (!(error instanceof SelfhostVersionBindingStoreError)) throw error;
      const aborted = lease ? await abortRuntimeLease(lease) : null;
      return aborted ?? failed("invalid_spec", "the Worker Version environment is invalid");
    }

    let materialized: Awaited<ReturnType<typeof versionMaterializer.materialize>>;
    try {
      materialized = await versionMaterializer.materialize({
        tenantRef: input.identity.tenantRef,
        script,
        versionId,
        manifestDigest,
        ...(assetsInput ? { assets: assetsInput } : {}),
      });
    } catch (error) {
      const aborted = lease ? await abortRuntimeLease(lease) : null;
      if (aborted) return aborted;
      if (error instanceof SelfhostVersionMaterializationError) {
        return failed(error.code, materializationMessage(error), error.code === "unavailable");
      }
      throw error;
    }

    // On this Host the "provider request" is the write itself: the values reach
    // a durable file and nothing else. Dispatch therefore happens immediately
    // before that write and after everything that could still refuse.
    let dispatched: ProviderRuntimeInputDispatchedLease | undefined;
    if (lease) {
      try {
        dispatched = await lease.dispatch();
      } catch (error) {
        return runtimeInputFailure(error, "dispatch");
      }
    }
    try {
      await writeVersionBindings(script, versionId, bindingSet);
    } catch (error) {
      if (dispatched && error instanceof SelfhostFailure) {
        return failed("unavailable", "the Worker Version environment did not settle", true);
      }
      throw error;
    }

    // Authoritative readback: what this machine will actually serve, re-read
    // from disk rather than assumed from what was just written.
    const recorded = await readVersionBindings(script, versionId);
    const inspected = await inspectVersion(script, versionId);
    if (
      inspected.state !== "present" ||
      inspected.digest !== materialized.materializationDigest ||
      !sameBindingNames(recorded, vars, requiredSensitive, dataBindings)
    ) {
      return failed("unavailable", "the Worker Version did not settle on this machine", true);
    }
    if (dispatched) {
      try {
        await dispatched.settle(
          await versionRuntimeInputReceiptDigest({
            script,
            versionId,
            materializationDigest: inspected.digest,
            bindingsDigest: recorded?.digest ?? null,
            bindingNames: requiredSensitive,
          }),
        );
      } catch (error) {
        return runtimeInputFailure(error, "settle");
      }
    }

    return succeeded({
      nativeId: nativeId(input, `selfhost-version:${script}:${versionId}`),
      observed: {
        scriptName: script,
        versionId,
        materializationDigest: materialized.materializationDigest,
        // Names only, and only when there are any: an environment is not
        // identity, and an empty declaration must observe as it always did.
        ...(vars.length > 0 ? { varNames: vars.map((binding) => binding.name) } : {}),
        ...(requiredSensitive.length > 0 ? { sensitiveVarNames: requiredSensitive } : {}),
        ...(dataBindings.length > 0
          ? { dataBindingNames: dataBindings.map((binding) => binding.name) }
          : {}),
      },
      outputs: {
        scriptName: script,
        versionId,
        materializationDigest: materialized.materializationDigest,
      },
    });
  };

  /**
   * Apply acknowledgement recovery is read-only. Re-resolve the exact
   * artifact closure to derive its expected digest, then inspect the local
   * directory; never route an uncertain recovery back through `apply`.
   */
  const recoverWorkerVersionApply = async (input: ApplyInput): Promise<ProviderTicket> => {
    if (input.previous) return failed("invalid_spec", "Worker Versions are immutable");
    const requiredSensitive = sensitiveBindingNames(input.spec.requiredSensitiveVars);
    if (!requiredSensitive) {
      return failed("invalid_spec", "the sensitive Worker binding declaration is invalid");
    }
    const runtimeInputTarget = sensitiveTarget(input);
    if (requiredSensitive.length > 0 && !leasesAvailable(input, runtimeInputTarget)) {
      return failed("denied", "required sensitive Worker runtime inputs are unavailable");
    }
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const bundle = relationResource(input.relations, "/bundle", "WorkerBundle");
    const manifestDigest =
      typeof bundle?.spec.manifestDigest === "string" ? bundle.spec.manifestDigest : null;
    if (!worker || !manifestDigest) {
      return failed("invalid_spec", "the Worker Version is incomplete");
    }
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const versionId = await versionIdOf(input.identity.tenantRef, {
      space: input.identity.space,
      name: input.identity.name,
    });
    const vars = declaredVars(input.spec);
    // Resolved before the lease is acquired, because everything here is a
    // declarative refusal and a refusal after dispatch would strand the
    // operation key with its ciphertext already erased.
    const dataBindings = declaredDataBindings(
      input,
      new Set([...vars.map((binding) => binding.name), ...requiredSensitive]),
    );
    if (dataBindings.length > 0 && !options.dataPlaneAddress) {
      return failed(
        "denied",
        "this deployment serves no data plane, so the Worker Version's bindings cannot be projected",
      );
    }
    // Read for its refusal only: a Version whose handler declaration is invalid
    // is not one this recovery can confirm.
    declaredHandlers(input.spec);
    const dataPlane = dataBindings.length > 0 ? { bindings: dataBindings } : undefined;
    const assetsSpec =
      typeof input.spec.assets === "object" && input.spec.assets !== null
        ? (input.spec.assets as JsonObject)
        : null;
    let assetsInput: SelfhostVersionMaterializationRequest["assets"] | undefined;
    if (assetsSpec) {
      const assetBundle = relationResource(input.relations, "/assets/bundle", "StaticAssetBundle");
      const assetsDigest =
        typeof assetBundle?.spec.manifestDigest === "string"
          ? assetBundle.spec.manifestDigest
          : null;
      if (!assetsDigest) return failed("invalid_spec", "the Static Asset Bundle is unavailable");
      assetsInput = {
        manifestDigest: assetsDigest,
        notFoundHandling:
          assetsSpec.notFoundHandling === "single_page_application"
            ? "single-page-application"
            : "none",
      };
    }
    let expected: Awaited<ReturnType<typeof versionMaterializer.prepare>>;
    try {
      expected = await versionMaterializer.prepare({
        tenantRef: input.identity.tenantRef,
        script,
        versionId,
        manifestDigest,
        ...(assetsInput ? { assets: assetsInput } : {}),
      });
    } catch (error) {
      if (error instanceof SelfhostVersionMaterializationError) {
        return failed(error.code, materializationMessage(error), error.code === "unavailable");
      }
      throw error;
    }
    // Readback-only from here down. Recovery never materializes, never writes a
    // binding, and never asks for the values again: a dispatched handoff has
    // already erased its ciphertext, and a second dispatch is not a thing this
    // seam can do.
    let recoveryLease: ProviderRuntimeInputRecoveryLease | undefined;
    if (requiredSensitive.length > 0 && runtimeInputTarget) {
      try {
        recoveryLease = await (runtimeInputs as ProviderRuntimeInputLeasePort).recover({
          organizationId: input.identity.tenantRef,
          operationId: input.operationId,
          resourceUid: input.identity.uid as string,
          reference: input.operationKey as string,
          target: runtimeInputTarget,
          bindingNames: requiredSensitive,
        });
      } catch (error) {
        return runtimeInputFailure(error, "recover");
      }
      if (!sameStrings(recoveryLease.bindingNames, requiredSensitive)) {
        return failed("denied", "required sensitive Worker runtime inputs are unavailable");
      }
    }
    const materialized = await inspectVersion(script, versionId);
    const recorded = await readVersionBindings(script, versionId);
    // Proven absence, and the only shape of it this Host can prove: no file on
    // this machine holds these values. The binding record is the only place they
    // ever land here — the version directory is materialized before dispatch and
    // never carries a value — so its absence is the proof, whether or not that
    // directory exists. Requiring both is what used to strand a handoff whose
    // write failed after dispatch: the directory was there, `abandon` was
    // skipped, and the plan-derived operation key could never be prepared again.
    // Revoking the handoff is what lets the ordinary retry re-prepare it.
    const absent = recorded === null;
    if (absent && requiredSensitive.length > 0 && runtimeInputTarget) {
      try {
        await (runtimeInputs as ProviderRuntimeInputLeasePort).abandon?.({
          organizationId: input.identity.tenantRef,
          operationId: input.operationId,
          resourceUid: input.identity.uid as string,
          reference: input.operationKey as string,
          target: runtimeInputTarget,
          bindingNames: requiredSensitive,
        });
      } catch (error) {
        return runtimeInputFailure(error, "abort");
      }
    }
    if (materialized.state === "absent") {
      return failed("not_found", "the Worker Version is not materialized");
    }
    if (materialized.state === "corrupt") {
      return failed("provider_error", "the Worker Version materialization is corrupt");
    }
    if (materialized.digest !== expected.materializationDigest) {
      return failed(
        "conflict",
        "the committed Worker Version materialization conflicts with this recovery",
      );
    }
    if (!sameBindingNames(recorded, vars, requiredSensitive, dataBindings)) {
      return failed("not_found", "the Worker Version environment was not recorded");
    }
    if (recoveryLease) {
      try {
        await recoveryLease.settle(
          await versionRuntimeInputReceiptDigest({
            script,
            versionId,
            materializationDigest: materialized.digest,
            bindingsDigest: recorded?.digest ?? null,
            bindingNames: requiredSensitive,
          }),
        );
      } catch (error) {
        return runtimeInputFailure(error, "settle");
      }
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-version:${script}:${versionId}`),
      observed: {
        scriptName: script,
        versionId,
        materialized: true,
        materializationDigest: materialized.digest,
        ...(vars.length > 0 ? { varNames: vars.map((binding) => binding.name) } : {}),
        ...(requiredSensitive.length > 0 ? { sensitiveVarNames: requiredSensitive } : {}),
        ...(dataBindings.length > 0
          ? { dataBindingNames: dataBindings.map((binding) => binding.name) }
          : {}),
      },
      outputs: {
        scriptName: script,
        versionId,
        materializationDigest: materialized.digest,
      },
    });
  };

  const applyWorkerDeployment = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const declared = Array.isArray(input.spec.versions) ? input.spec.versions : [];
    if (!worker || declared.length === 0) {
      return failed("invalid_spec", "the Worker Deployment is incomplete");
    }
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const weighted: { versionId: string; weight: number }[] = [];
    for (let index = 0; index < declared.length; index += 1) {
      const version = relationResource(
        input.relations,
        `/versions/${index}/workerVersion`,
        "WorkerVersion",
      );
      const entry =
        typeof declared[index] === "object" && declared[index] !== null
          ? (declared[index] as JsonObject)
          : null;
      const weight = Number.isSafeInteger(entry?.weight) ? Number(entry?.weight) : undefined;
      if (!version || weight === undefined) {
        return failed("invalid_spec", "a deployed version does not belong to this Worker");
      }
      weighted.push({
        versionId: await versionIdOf(input.identity.tenantRef, version.metadata),
        weight,
      });
    }
    // workerd routes whole requests, not basis points. The heaviest version
    // serves; the requested split is recorded so what was asked for and what
    // this machine can do are both visible.
    const active = weighted.reduce((best, entry) => (entry.weight > best.weight ? entry : best));
    const current = await readScriptState(script);
    await writeScriptState(script, current, { ...current.state, activeVersion: active.versionId });
    try {
      await republish(script);
    } catch (error) {
      if (error instanceof SelfhostFailure) return error.ticket;
      throw error;
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-deployment:${script}`),
      observed: { scriptName: script, activeVersionId: active.versionId, versions: weighted },
      outputs: {},
    });
  };

  const applyWorkerEndpoint = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    if (!worker) return failed("invalid_spec", "the Worker Endpoint is incomplete");
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const address = endpointAddress(input);
    const current = await readScriptState(script);
    if (current.state.endpointHostname !== address.hostname) {
      await writeScriptState(script, current, {
        ...current.state,
        endpointHostname: address.hostname,
      });
    }
    // Desired state may already contain this endpoint after a process died
    // during the previous republish. Reconcile runtime truth on every retry;
    // checking only the durable value would turn a failed reload into a false
    // success response.
    if (current.state.activeVersion) {
      try {
        await republish(script);
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-endpoint:${script}:${address.hostname}`),
      observed: {
        enabled: true,
        scriptName: script,
        assignmentDigest: address.assignmentDigest,
      },
      outputs: { hostname: address.hostname, url: address.url },
    });
  };

  const applyWorkerCustomDomain = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const hostname =
      typeof input.spec.hostname === "string"
        ? input.spec.hostname.toLowerCase().replace(/\.$/u, "")
        : null;
    if (!worker || !hostname) return failed("invalid_spec", "the custom domain is incomplete");
    if (!serves(hostname)) {
      return failed(
        "invalid_spec",
        `this deployment does not serve ${hostname}; it answers only for the suffixes it was configured with`,
      );
    }
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const current = await readScriptState(script);
    if (!current.state.domains.includes(hostname)) {
      await writeScriptState(script, current, {
        ...current.state,
        domains: [...current.state.domains, hostname],
      });
    }
    // As with endpoint attachment, a committed domain is not proof that the
    // runtime accepted the corresponding route. Always retry publication while
    // a version is active, even when the desired domain list is unchanged.
    if (current.state.activeVersion) {
      try {
        await republish(script);
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-domain:${hostname}`),
      observed: { hostname, scriptName: script },
      outputs: {},
    });
  };

  /**
   * The exact queue one relation names, as this provider deployed it.
   *
   * Resolved through the Deployment rather than derived from the declaration:
   * the native id this provider minted and the output it published both have to
   * name the same queue, so a relation another provider deployed is refused
   * rather than guessed at.
   */
  const attachedQueue = (
    input: { readonly relations?: readonly ProviderRelation[] },
    pointer: string,
  ): SelfhostQueueTarget | null => {
    const relation = input.relations?.find((candidate) => candidate.pointer === pointer);
    const queue = selfhostNamespaceTarget(
      relation,
      "selfhost-queue",
      "AtLeastOnceQueue",
      databasePath,
    );
    const settings = queueSettings(relation);
    return queue && settings ? { queue, ...settings } : null;
  };

  /** One required integer limit of a Queue Consumer, inside its Form's range. */
  const consumerLimit = (spec: JsonObject, field: string, low: number, high: number): number => {
    const value = spec[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) {
      throw new SelfhostFailure(failed("invalid_spec", "the Queue Consumer limits are invalid"));
    }
    return value;
  };

  /** Rewrites one script's attachments and republishes what workerd serves. */
  const rewriteAttachments = async (
    script: string,
    change: (state: SelfhostScriptState) => SelfhostScriptState,
  ): Promise<void> => {
    const current = await readScriptState(script);
    const next = change(current.state);
    if (JSON.stringify(next) !== JSON.stringify(current.state)) {
      await writeScriptState(script, current, next);
    }
    // Always, even when the desired state was already this: a committed
    // attachment is not proof that the runtime accepted the gate it needs, and
    // the publication is what puts that gate in front of the Worker.
    if (next.activeVersion) await republish(script);
  };

  const applyWorkerCronTrigger = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const cron = typeof input.spec.cron === "string" ? input.spec.cron : null;
    if (!worker || !cron) return failed("invalid_spec", "the cron trigger is incomplete");
    // Parsed here rather than at the first tick, because a schedule this Host
    // cannot read is a trigger that would be recorded and never fire.
    if (!parseSelfhostCron(cron)) {
      return failed(
        "invalid_spec",
        "the cron expression is not five UTC fields this Host can read",
      );
    }
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    await rewriteAttachments(script, (state) => ({
      ...state,
      crons: [...new Set([...(state.crons ?? []), cron])].sort(),
    }));
    return succeeded({
      nativeId: nativeId(input, `selfhost-cron:${script}`),
      observed: { cron, scriptName: script, scheduled: Boolean(options.events) },
      outputs: {},
    });
  };

  const applyQueueConsumer = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const queue = attachedQueue(input, "/queue");
    if (!worker || !queue) return failed("invalid_spec", "the Queue Consumer is incomplete");
    const declaredDeadLetter = input.spec.deadLetterQueue !== undefined;
    const deadLetterQueue = declaredDeadLetter ? attachedQueue(input, "/deadLetterQueue") : null;
    if (declaredDeadLetter && !deadLetterQueue) {
      return failed("invalid_spec", "the Queue Consumer's dead-letter queue is unavailable");
    }
    const attachment: SelfhostQueueConsumerAttachment = {
      queue: queue.queue,
      maxBatchSize: consumerLimit(input.spec, "maxBatchSize", 1, 100),
      maxBatchTimeoutSeconds: consumerLimit(input.spec, "maxBatchTimeoutSeconds", 0, 60),
      maxConcurrency: consumerLimit(input.spec, "maxConcurrency", 1, 250),
      maxRetries: consumerLimit(input.spec, "maxRetries", 0, 100),
      retryDelaySeconds: consumerLimit(input.spec, "retryDelaySeconds", 0, 43_200),
      ...(deadLetterQueue ? { deadLetterQueue } : {}),
    };
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    await rewriteAttachments(script, (state) => ({
      ...state,
      consumers: [
        ...(state.consumers ?? []).filter((entry) => entry.queue !== attachment.queue),
        attachment,
      ].sort((left, right) => (left.queue < right.queue ? -1 : 1)),
    }));
    return succeeded({
      nativeId: nativeId(input, `selfhost-consumer:${queue.queue}:${script}`),
      observed: {
        queueName: queue.queue,
        scriptName: script,
        delivering: Boolean(options.events),
      },
      outputs: {},
    });
  };

  const namespaceResult = async (
    kind: string,
    input: { identity: ResourceIdentity },
    /**
     * The native id this Resource already has, when it has one.
     *
     * A namespace's stored rows are keyed by the name inside it, so the name of
     * an existing namespace is read back rather than recomputed: recomputing is
     * how an observation of a namespace made by an earlier build would report a
     * different id than the one its rows are under.
     */
    existingNativeId?: string,
  ): Promise<{ base: string; observed: JsonObject; outputs: JsonObject }> => {
    switch (kind) {
      case "ObjectBucket":
      case "object_bucket": {
        const name = legacyName(input.identity);
        return {
          base: `local-bucket:${name}`,
          observed: { name },
          outputs: { protocol: "s3", bucketName: name },
        };
      }
      case "EdgeKVNamespace": {
        // Keyed by the Resource UID as well as its name, because this is now a
        // store rather than an allocated label: a customer who deletes a
        // namespace and declares one with the same name has asked for an empty
        // namespace, and on Cloudflare that is what they get. Without the uid
        // the derived id is the same one and the old rows come back.
        const name =
          selfhostNamespaceName("selfhost-kv", existingNativeId) ??
          (input.identity.uid
            ? await derivedProviderResourceIncarnationName("tskv", {
                tenantRef: input.identity.tenantRef,
                space: input.identity.space,
                name: input.identity.name,
                uid: input.identity.uid,
              })
            : null);
        if (!name) {
          throw new SelfhostFailure(
            failed("invalid_spec", "the KV namespace declaration carries no Resource identity"),
          );
        }
        return {
          base: `selfhost-kv:${name}`,
          observed: { name },
          outputs: { namespaceId: name },
        };
      }
      case "AtLeastOnceQueue": {
        const name = await derivedProviderResourceName("tsq", input.identity);
        return {
          base: `selfhost-queue:${name}`,
          observed: { queueName: name },
          outputs: { queueId: name, queueName: name },
        };
      }
      case "SQLiteDatabase":
      case "sql_database": {
        const name = await derivedProviderResourceName("tsdb", input.identity);
        return {
          base: `selfhost-sqlite:${name}`,
          // Nothing is created eagerly: the file appears when something
          // writes to it, and reporting a path that does not exist yet would
          // be reporting a thing that is not there.
          observed: { name },
          outputs: { engine: "sqlite", path: databasePath(name) },
        };
      }
      default:
        throw new SelfhostFailure(
          failed("invalid_spec", `${kind} needs a runtime this deployment does not have`),
        );
    }
  };

  const dispatchKind = (offering: ProviderOffering): string => {
    if (
      offering.kind.startsWith("takoform.") &&
      (offering.form.apiVersion === "edge.forms.takoform.com/v1beta1" ||
        offering.form.apiVersion === "edge.forms.takoform.com")
    ) {
      return offering.form.kind;
    }
    return offering.kind;
  };

  return {
    id,
    offerings: structuredClone(options.offerings) as ProviderOffering[],
    // Derived from the lease port's presence, never from a config flag. A
    // machine that advertised a non-zero ceiling without somewhere to seal a
    // value would turn a clean 422 at admission into a failure at apply.
    ...(runtimeInputs
      ? { runtimeInputCapabilities: { maximumBindings: MAX_PROVIDER_RUNTIME_INPUT_BINDINGS } }
      : {}),
    workerEndpointOriginReservations: {
      derive: async ({ requestedSubdomain }) => {
        const canonicalPublicOrigin = canonicalWorkerEndpointOrigin(
          requestedSubdomain,
          endpointSuffix,
        );
        return canonicalPublicOrigin ? { canonicalPublicOrigin } : null;
      },
    },

    /** Capture a pure, redacted descriptor for post-delete readback. */
    createNativeReadbackDescriptor(
      input: ProviderNativeReadbackInput,
    ): ProviderNativeReadbackDescriptor {
      const kind = dispatchKind(input.offering);
      const parsed = parseSelfhostNativeId(kind, input.nativeId, input.spec, input.relations);
      if (!parsed) throw new ProviderReadbackDescriptorError();
      const data =
        kind === "WorkerEndpoint" && parsed.script && parsed.hostname
          ? { ...parsed.data, hostname: parsed.hostname }
          : parsed.data;
      return {
        apiVersion: PROVIDER_READBACK_API_VERSION,
        provider: id,
        kind,
        nativeId: input.nativeId,
        data,
      };
    },

    /**
     * Read only local durable/runtime descriptors. This method deliberately
     * avoids `scriptStates.read` and `runtime.has`: both may clean stale
     * activation files, while an absence proof must have no write/reload path.
     */
    async verifyNativeAbsence(input: {
      offering: ProviderOffering;
      descriptor: ProviderNativeReadbackDescriptor;
    }): Promise<ProviderNativeAbsence> {
      const kind = dispatchKind(input.offering);
      const parsed = validateSelfhostReadbackDescriptor(id, kind, input.descriptor);
      if (!parsed) return selfhostUnknown("malformed", false);
      try {
        switch (kind) {
          case "ModuleWorker":
            if (!parsed.script) return selfhostUnknown("malformed", false);
            return await verifySelfhostWorkerAbsence(
              dataRoot,
              scriptsRoot,
              versionsRoot,
              parsed.script,
              input.descriptor,
              kind,
            );
          case "WorkerVersion":
            if (!parsed.script || !parsed.versionId) return selfhostUnknown("malformed", false);
            return await verifySelfhostVersionAbsence(
              versionMaterializer,
              parsed.script,
              parsed.versionId,
              input.descriptor,
              kind,
            );
          case "WorkerDeployment":
            if (!parsed.script) return selfhostUnknown("malformed", false);
            return await verifySelfhostDeploymentAbsence(
              dataRoot,
              parsed.script,
              input.descriptor,
              kind,
            );
          case "WorkerEndpoint":
          case "WorkerCustomDomain":
            if (!parsed.script) return selfhostUnknown("malformed", false);
            return await verifySelfhostRouteAbsence(
              dataRoot,
              parsed.script,
              parsed.hostname,
              input.descriptor,
              kind,
            );
          // An attachment is durable state now rather than a bare declaration,
          // so its absence is something this Host can read rather than assert.
          case "WorkerCronTrigger": {
            if (!parsed.script) return selfhostUnknown("malformed", false);
            const cron = optionalSafeString(parsed.data.cron);
            if (!cron) return selfhostUnknown("malformed", false);
            const state = await readSelfhostState(selfhostScriptStateRoot(dataRoot), parsed.script);
            return selfhostAbsence(
              state.crons.includes(cron) ? "present" : "absent",
              input.descriptor,
              kind,
              id,
              parsed.data,
            );
          }
          case "QueueConsumer": {
            if (!parsed.script) return selfhostUnknown("malformed", false);
            const queueName = optionalSafeString(parsed.data.queueName);
            if (!queueName) return selfhostUnknown("malformed", false);
            const state = await readSelfhostState(selfhostScriptStateRoot(dataRoot), parsed.script);
            return selfhostAbsence(
              state.consumers.includes(queueName) ? "present" : "absent",
              input.descriptor,
              kind,
              id,
              parsed.data,
            );
          }
          case "SQLiteDatabase":
          case "sql_database":
            return selfhostFileAbsence(
              "SQLiteDatabase",
              databasePath(parsed.databaseName ?? ""),
              input.descriptor,
              id,
            );
          // These declarations have no separate provider-native object on a
          // self-hosted machine. Their descriptor is still captured so the
          // Host can prove that no provider readback is required.
          case "ObjectBucket":
          case "object_bucket":
          case "EdgeKVNamespace":
          case "AtLeastOnceQueue":
            return selfhostAbsence("absent", input.descriptor, kind, id, parsed.data);
          default:
            return selfhostUnknown("unsupported", false);
        }
      } catch (error) {
        // Filesystem errors are bounded to the closed provider vocabulary; no
        // path, credential, or raw diagnostic crosses the provider seam.
        if (error instanceof SelfhostReadbackMalformed) {
          return selfhostUnknown("malformed", false);
        }
        return selfhostUnknown("transport", true);
      }
    },

    async recoverApply(input): Promise<ProviderTicket> {
      if (dispatchKind(input.offering) === "WorkerEndpoint") {
        try {
          const worker = relationResource(input.relations, "/worker", "ModuleWorker");
          if (!worker) return failed("invalid_spec", "the Worker Endpoint is incomplete");
          const address = endpointAddress(input);
          const script = await scriptOf(input.identity.tenantRef, worker.metadata);
          const { state } = await readScriptState(script);
          if (state.endpointHostname !== address.hostname || !state.activeVersion) {
            return failed(
              "unavailable",
              "the Worker Endpoint apply outcome is indeterminate",
              true,
            );
          }
          if (
            !(await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, state)),
            ))
          ) {
            return failed("unavailable", "the Worker runtime is not serving the endpoint", true);
          }
          return succeeded({
            nativeId: nativeId(input, `selfhost-endpoint:${script}:${address.hostname}`),
            observed: {
              enabled: true,
              scriptName: script,
              assignmentDigest: address.assignmentDigest,
            },
            outputs: { hostname: address.hostname, url: address.url },
          });
        } catch (error) {
          if (error instanceof SelfhostFailure) return error.ticket;
          throw error;
        }
      }
      if (dispatchKind(input.offering) !== "WorkerVersion") {
        return failed(
          "unavailable",
          "self-host apply recovery is supported only for Worker Version or Endpoint materialization",
          true,
        );
      }
      try {
        return await recoverWorkerVersionApply(input);
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async convergeApply(input): Promise<ProviderTicket> {
      return await this.apply({ ...input, operationMode: "recovery" });
    },

    async apply(input): Promise<ProviderTicket> {
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker":
            return await applyModuleWorker(input);
          case "WorkerVersion":
            return await applyWorkerVersion(input);
          case "WorkerDeployment":
            return await applyWorkerDeployment(input);
          case "WorkerEndpoint":
            return await applyWorkerEndpoint(input);
          case "WorkerCustomDomain":
            return await applyWorkerCustomDomain(input);
          case "WorkerCronTrigger":
            return await applyWorkerCronTrigger(input);
          case "QueueConsumer":
            return await applyQueueConsumer(input);
          default: {
            // Namespaces have nothing mutable in their backend, so an update
            // confirms rather than changes. Saying so beats pretending work
            // happened.
            const made = await namespaceResult(
              dispatchKind(input.offering),
              input,
              input.previous?.nativeId,
            );
            return succeeded({
              nativeId: nativeId(input, made.base),
              observed: made.observed,
              outputs: made.outputs,
            });
          }
        }
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async observe(input): Promise<ProviderTicket> {
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker": {
            const script = await scriptOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            return succeeded({
              nativeId: input.nativeId,
              observed: { scriptName: script, allocated: true },
              outputs: { scriptName: script },
            });
          }
          case "WorkerVersion": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Version has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const versionId = await versionIdOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            const materialized = await inspectVersion(script, versionId);
            if (materialized.state === "absent") {
              return failed("not_found", "the Worker Version is not materialized");
            }
            if (materialized.state === "corrupt") {
              return failed("provider_error", "the Worker Version materialization is corrupt");
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: {
                scriptName: script,
                versionId,
                materialized: true,
                materializationDigest: materialized.digest,
              },
              outputs: {
                scriptName: script,
                versionId,
                materializationDigest: materialized.digest,
              },
            });
          }
          case "WorkerDeployment": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Deployment has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const { state } = await readScriptState(script);
            const serving = await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, state)),
            );
            if (state.activeVersion && !serving) {
              return failed(
                "unavailable",
                "the Worker runtime is not serving the deployment",
                true,
              );
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: {
                scriptName: script,
                ...(state.activeVersion ? { activeVersionId: state.activeVersion } : {}),
                serving,
              },
              outputs: {},
            });
          }
          case "WorkerEndpoint": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Endpoint has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const { state } = await readScriptState(script);
            if (!state.endpointHostname || !state.activeVersion) {
              return failed("not_found", "the Worker endpoint is not durably attached");
            }
            if (
              !(await runtimeOperation(async () =>
                runtime.has(script, await runtimeGeneration(script, state)),
              ))
            ) {
              return failed("unavailable", "the Worker runtime is not serving the endpoint", true);
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: { enabled: true, scriptName: script, serving: true },
              outputs: {
                hostname: state.endpointHostname,
                url: `https://${state.endpointHostname}/`,
              },
            });
          }
          case "WorkerCustomDomain": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            const hostname =
              typeof input.spec.hostname === "string"
                ? input.spec.hostname.toLowerCase().replace(/\.$/u, "")
                : null;
            if (!hostname) return failed("not_found", "the custom domain records no hostname");
            if (!worker) return failed("not_found", "the custom domain has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const { state } = await readScriptState(script);
            if (!state.domains.includes(hostname) || !state.activeVersion) {
              return failed("not_found", "the custom domain is not durably attached");
            }
            if (
              !(await runtimeOperation(async () =>
                runtime.has(script, await runtimeGeneration(script, state)),
              ))
            ) {
              return failed(
                "unavailable",
                "the Worker runtime is not serving the custom domain",
                true,
              );
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: { hostname, scriptName: script, serving: true },
              outputs: {},
            });
          }
          case "WorkerCronTrigger": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            const cron = typeof input.spec.cron === "string" ? input.spec.cron : null;
            if (!cron) return failed("not_found", "the cron trigger records no expression");
            if (!worker) return failed("not_found", "the cron trigger has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const { state } = await readScriptState(script);
            if (!(state.crons ?? []).includes(cron)) {
              return failed("not_found", "the cron trigger is not durably attached");
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: {
                cron,
                scriptName: script,
                // Attached and, if this deployment runs a scheduler, firing.
                scheduled: Boolean(options.events) && Boolean(state.activeVersion),
              },
              outputs: {},
            });
          }
          case "QueueConsumer": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            const queue = attachedQueue(input, "/queue");
            if (!worker || !queue) {
              return failed("not_found", "the Queue Consumer has no attachment relations");
            }
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const { state } = await readScriptState(script);
            if (!(state.consumers ?? []).some((entry) => entry.queue === queue.queue)) {
              return failed("not_found", "the Queue Consumer is not durably attached");
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: {
                queueName: queue.queue,
                scriptName: script,
                delivering: Boolean(options.events) && Boolean(state.activeVersion),
              },
              outputs: {},
            });
          }
          default: {
            const made = await namespaceResult(dispatchKind(input.offering), input, input.nativeId);
            return succeeded({
              nativeId: input.nativeId,
              observed: made.observed,
              outputs: made.outputs,
            });
          }
        }
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async delete(input): Promise<ProviderTicket> {
      if (input.operationMode === "recovery" && !input.providerHandle) {
        return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
      }
      if (input.providerHandle) {
        return failed("unavailable", "self-host delete recovery cannot poll this handle", true);
      }
      const done = (): ProviderTicket =>
        succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker": {
            const script = await scriptOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            await runtimeOperation(() => runtime.remove(script));
            await rm(join(versionsRoot, script), { recursive: true, force: true });
            await bindingStoreOperation(() => versionBindings.removeScript(script));
            await removeScriptState(script);
            // The next-fire state goes with the Worker. Leaving it would make a
            // Worker declared again under the same name inherit a schedule
            // nobody asked for.
            await options.events?.forgetSchedules(script);
            await runtimeOperation(() => runtime.reload());
            return done();
          }
          case "WorkerVersion": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (worker) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const versionId = await versionIdOf(input.identity.tenantRef, {
                space: input.identity.space,
                name: input.identity.name,
              });
              const current = await readScriptState(script);
              if (current.state.activeVersion === versionId) {
                await writeScriptState(script, current, {
                  domains: current.state.domains,
                  ...(current.state.endpointHostname
                    ? { endpointHostname: current.state.endpointHostname }
                    : {}),
                });
                await rm(join(versionsRoot, script, versionId), { recursive: true, force: true });
                await bindingStoreOperation(() => versionBindings.remove(script, versionId));
                await republish(script);
              } else {
                await rm(join(versionsRoot, script, versionId), { recursive: true, force: true });
                await bindingStoreOperation(() => versionBindings.remove(script, versionId));
              }
            }
            return done();
          }
          case "WorkerDeployment": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (worker) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const current = await readScriptState(script);
              await writeScriptState(script, current, {
                domains: current.state.domains,
                ...(current.state.endpointHostname
                  ? { endpointHostname: current.state.endpointHostname }
                  : {}),
              });
              await republish(script);
            }
            return done();
          }
          case "WorkerEndpoint": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (worker) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const current = await readScriptState(script);
              await writeScriptState(script, current, {
                domains: current.state.domains,
                ...(current.state.activeVersion
                  ? { activeVersion: current.state.activeVersion }
                  : {}),
              });
              if (current.state.activeVersion) await republish(script);
            }
            return done();
          }
          case "WorkerCustomDomain": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            const hostname =
              typeof input.spec?.hostname === "string"
                ? input.spec.hostname.toLowerCase().replace(/\.$/u, "")
                : null;
            if (worker && hostname) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const current = await readScriptState(script);
              await writeScriptState(script, current, {
                ...current.state,
                domains: current.state.domains.filter((entry) => entry !== hostname),
              });
              if (current.state.activeVersion) await republish(script);
            }
            return done();
          }
          case "WorkerCronTrigger": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            const cron = typeof input.spec?.cron === "string" ? input.spec.cron : null;
            if (worker && cron) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              await rewriteAttachments(script, (state) => ({
                ...state,
                crons: (state.crons ?? []).filter((entry) => entry !== cron),
              }));
              await options.events?.forgetSchedules(script, cron);
            }
            return done();
          }
          case "QueueConsumer": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            const parsed = parseSelfhostNativeId(
              "QueueConsumer",
              input.nativeId,
              input.spec,
              input.relations,
            );
            const queueName =
              typeof parsed?.data.queueName === "string" ? parsed.data.queueName : null;
            if (worker && queueName) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              // The messages stay: they belong to the queue, not to the
              // attachment that was draining it, and dropping durable bytes
              // inside an apply is not this seam's job.
              await rewriteAttachments(script, (state) => ({
                ...state,
                consumers: (state.consumers ?? []).filter((entry) => entry.queue !== queueName),
              }));
            }
            return done();
          }
          case "AtLeastOnceQueue": {
            // The messages go with the queue, for the same reason a namespace's
            // rows do: a customer who deleted a queue and declares one with the
            // same name has asked for an empty queue.
            const queueId = selfhostNamespaceName("selfhost-queue", input.nativeId);
            if (queueId && options.events) await options.events.deleteQueue(queueId);
            return done();
          }
          case "EdgeKVNamespace": {
            // The rows go with the namespace. Leaving them was defensible while
            // `EdgeKVNamespace` was a name with nothing behind it; now that it
            // is a store, leaving them means a customer who deleted a namespace
            // still has their data on this machine — and, before the id
            // included the Resource UID, still served from it.
            const namespaceId = selfhostNamespaceName("selfhost-kv", input.nativeId);
            if (namespaceId && options.dataPlaneMaintenance) {
              await options.dataPlaneMaintenance.deleteKvNamespace(namespaceId);
            }
            return done();
          }
          case "SQLiteDatabase":
          case "sql_database": {
            // The file stays — removing durable bytes inside an apply is not
            // this seam's job — but the open handle must not: it names an inode
            // this Host no longer means, and a database declared again under
            // the same name would be served through it.
            const name = selfhostNamespaceName("selfhost-sqlite", input.nativeId);
            if (name) options.dataPlaneMaintenance?.forgetDatabase(name);
            return done();
          }
          default:
            // Buckets and anything else with nothing durable behind it here:
            // the lifecycle delete removes the declaration and there is nothing
            // else on this machine that was the Resource.
            return done();
        }
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    /**
     * Read-only cancellation recovery for the local provider.
     *
     * A process can die after `delete` removed the files but before the Host
     * recorded its receipt. Replaying the local mutation would hide that
     * acknowledgement gap and could also remove a newer incarnation. The
     * recovery seam therefore checks only durable state plus runtime serving
     * truth; it never calls `remove`, rewrites desired state, or reloads.
     */
    async recoverDelete(input): Promise<ProviderTicket> {
      if (input.providerHandle) {
        return failed("unavailable", "self-host delete recovery cannot poll this handle", true);
      }
      const done = (): ProviderTicket =>
        succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
      const uncertain = (): ProviderTicket =>
        failed(
          "unavailable",
          "the local delete outcome is not proven; operator repair is required",
          true,
        );
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker": {
            const script = await scriptOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            const current = await readScriptState(script);
            const serving = await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, current.state)),
            );
            return current.revision === null && !serving ? done() : uncertain();
          }
          case "WorkerVersion": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Version has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const versionId = await versionIdOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            const current = await readScriptState(script);
            // The immutable local Version is gone only when its whole
            // materialization directory is absent and it is no longer the
            // durable active generation. A different active generation may
            // still serve, which is fine for this non-active Version.
            const materialized = existsSync(join(versionsRoot, script, versionId));
            return !materialized && current.state.activeVersion !== versionId
              ? done()
              : uncertain();
          }
          case "WorkerDeployment": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Deployment has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const current = await readScriptState(script);
            const serving = await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, current.state)),
            );
            return current.state.activeVersion === undefined && !serving ? done() : uncertain();
          }
          case "WorkerEndpoint": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker route has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const parsed = parseSelfhostNativeId(
              "WorkerEndpoint",
              input.nativeId,
              input.spec,
              input.relations,
            );
            if (!parsed?.hostname || parsed.script !== script) {
              return failed("not_found", "the Worker Endpoint identity is malformed");
            }
            const current = await readScriptState(script);
            const manifest = await readSelfhostRuntimeManifest(dataRoot, script);
            return current.state.endpointHostname !== parsed.hostname &&
              manifest?.hostnames.includes(parsed.hostname) !== true
              ? done()
              : uncertain();
          }
          case "WorkerCustomDomain": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker route has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const current = await readScriptState(script);
            const serving = await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, current.state)),
            );
            // Workerd's boolean seam reports script activation, not a
            // per-host route. When another route still serves the script we
            // cannot prove this route's absence, so fail closed.
            return !serving && current.state.domains.length === 0 ? done() : uncertain();
          }
          default:
            // Namespace resources have no mutable local object; their delete
            // is a durable declaration transition and has no residual bytes
            // for this provider to read back.
            return done();
        }
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async adopt(input): Promise<ProviderTicket> {
      if (input.operationMode === "recovery" && !input.providerHandle) {
        return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
      }
      if (input.providerHandle) {
        return failed("unavailable", "self-host adopt recovery cannot poll this handle", true);
      }
      // Adoption records a claim on a native identity the caller names. Local
      // resources are namespace agreements keyed by declared identity, so the
      // adopted state is recomputed the same way apply computes it, while the
      // caller's native identity is held verbatim.
      const observed = await this.observe(input);
      if (observed.phase !== "succeeded") return observed;
      return succeeded({ ...observed.result, nativeId: input.nativeId });
    },

    sqliteMigrations: {
      readLedger: async (input: {
        readonly nativeId: string;
      }): Promise<ProviderValue<readonly ProviderSqliteMigrationIdentity[]>> => {
        const path = sqlitePathOf(input.nativeId, databasePath);
        if (!path) {
          return {
            ok: false,
            failure: {
              code: "invalid_spec",
              message: "the database identity is invalid",
              retryable: false,
            },
          };
        }
        if (!existsSync(path)) return { ok: true, value: [] };
        const database = new Database(path);
        try {
          // A running Worker holds its own handle on this same file, so a
          // ledger read can arrive while a statement of the tenant's is
          // writing. SQLite's default is to fail immediately rather than wait,
          // which would report "the ledger is unreadable" for a lock that was
          // about to clear.
          database.exec(`PRAGMA busy_timeout = ${SQLITE_LOCK_WAIT_MS}`);
          const present = database
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .all(SQLITE_MIGRATION_LEDGER);
          if (present.length === 0) return { ok: true, value: [] };
          const rows = database
            .query(
              `SELECT sequence, path, digest FROM ${SQLITE_MIGRATION_LEDGER} ORDER BY sequence`,
            )
            .all() as { sequence: number; path: string; digest: string }[];
          const ledger: ProviderSqliteMigrationIdentity[] = [];
          for (const [index, row] of rows.entries()) {
            if (row.sequence !== index + 1 || !migrationPath(row.path) || !sha256(row.digest)) {
              return {
                ok: false,
                failure: {
                  code: "provider_error",
                  message: "the migration ledger is malformed",
                  retryable: false,
                },
              };
            }
            ledger.push({ path: row.path, digest: row.digest as `sha256:${string}` });
          }
          return { ok: true, value: ledger };
        } finally {
          database.close();
        }
      },
      applySuffix: async (input: {
        readonly nativeId: string;
        readonly expectedPrefix: readonly ProviderSqliteMigrationIdentity[];
        readonly migrations: readonly ProviderSqliteMigration[];
      }): Promise<ProviderValue<undefined>> => {
        const path = sqlitePathOf(input.nativeId, databasePath);
        if (!path) {
          return {
            ok: false,
            failure: {
              code: "invalid_spec",
              message: "the database identity is invalid",
              retryable: false,
            },
          };
        }
        if (input.migrations.length < 1 || input.migrations.length > 100) {
          return {
            ok: false,
            failure: {
              code: "invalid_spec",
              message: "the migration suffix is invalid",
              retryable: false,
            },
          };
        }
        const decoded: { path: string; digest: string; sql: string }[] = [];
        for (const migration of input.migrations) {
          if (!migrationPath(migration.path) || !sha256(migration.digest)) {
            return {
              ok: false,
              failure: {
                code: "invalid_spec",
                message: "a migration identity is invalid",
                retryable: false,
              },
            };
          }
          let sql: string;
          try {
            sql = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(migration.sql);
          } catch {
            return {
              ok: false,
              failure: {
                code: "invalid_spec",
                message: "a migration is not UTF-8 SQL",
                retryable: false,
              },
            };
          }
          if (sql.length === 0 || sql.length > 100_000) {
            return {
              ok: false,
              failure: {
                code: "invalid_spec",
                message: "a migration SQL statement is invalid",
                retryable: false,
              },
            };
          }
          decoded.push({ path: migration.path, digest: migration.digest, sql });
        }
        await mkdir(dirname(path), { recursive: true });
        const database = new Database(path, { create: true });
        try {
          // Same reason as the reader, and more pressing: this one takes a
          // write lock the tenant's own connection may be holding.
          database.exec(`PRAGMA busy_timeout = ${SQLITE_LOCK_WAIT_MS}`);
          database.exec("BEGIN IMMEDIATE");
          try {
            database.exec(SQLITE_MIGRATION_LEDGER_DDL);
            const rows = database
              .query(
                `SELECT sequence, path, digest FROM ${SQLITE_MIGRATION_LEDGER} ORDER BY sequence`,
              )
              .all() as { sequence: number; path: string; digest: string }[];
            const matches =
              rows.length === input.expectedPrefix.length &&
              rows.every(
                (row, index) =>
                  row.sequence === index + 1 &&
                  row.path === input.expectedPrefix[index]?.path &&
                  row.digest === input.expectedPrefix[index]?.digest,
              );
            if (!matches) {
              database.exec("ROLLBACK");
              return {
                ok: false,
                failure: {
                  code: "conflict",
                  message: "the database migration history moved",
                  retryable: false,
                },
              };
            }
            const insert = database.prepare(
              `INSERT INTO ${SQLITE_MIGRATION_LEDGER} (sequence, path, digest) VALUES (?, ?, ?)`,
            );
            for (const [offset, migration] of decoded.entries()) {
              database.exec(migration.sql);
              insert.run(
                input.expectedPrefix.length + offset + 1,
                migration.path,
                migration.digest,
              );
            }
            database.exec("COMMIT");
          } catch (error) {
            try {
              database.exec("ROLLBACK");
            } catch {
              // The transaction may have already been rolled back by SQLite.
            }
            return {
              ok: false,
              failure: {
                code: "provider_error",
                message: `a migration failed to apply: ${error instanceof Error ? error.message : "unknown"}`,
                retryable: false,
              },
            };
          }
          return { ok: true, value: undefined };
        } finally {
          database.close();
        }
      },
    },
  };
}

interface SelfhostReadbackParsed {
  readonly data: JsonObject;
  readonly script?: string;
  readonly versionId?: string;
  readonly hostname?: string;
  readonly databaseName?: string;
}

/**
 * Native IDs are opaque outside this adapter, but a descriptor still needs a
 * bounded, path-safe projection so a forged value can never escape dataRoot.
 * Operation suffixes are intentionally ignored after the stable address.
 */
function parseSelfhostNativeId(
  kind: string,
  value: string,
  spec?: JsonObject,
  relations?: readonly ProviderRelation[],
): SelfhostReadbackParsed | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) return null;
  const parts = value.split(":");
  const script = safeSegment(parts[1]) ? parts[1] : undefined;
  const versionId = safeSegment(parts[2]) ? parts[2] : undefined;
  const workerRelation = relations?.find((relation) => relation.pointer === "/worker");
  const relationMeta = workerRelation?.resource.metadata;
  const relationData: JsonObject =
    relationMeta &&
    safeSegment(relationMeta.name) &&
    safeSegment(relationMeta.space) &&
    safeSegment(relationMeta.uid)
      ? {
          workerName: relationMeta.name,
          workerSpace: relationMeta.space,
          workerUid: relationMeta.uid,
        }
      : safeRelationData(spec);
  const relationScript =
    selfhostWorkerScript(relations) ??
    (safeSegment(spec?.scriptName) ? spec.scriptName : undefined) ??
    (safeSegment(spec?.workerScript) ? spec.workerScript : null);
  const endpointHostname = normalizedHostname(parts[2]);
  switch (kind) {
    case "ModuleWorker":
      return parts[0] === "selfhost-worker" && script
        ? { script, data: { scriptName: script } }
        : null;
    case "WorkerVersion":
      return parts[0] === "selfhost-version" && script && versionId
        ? {
            script,
            versionId,
            data: { scriptName: script, versionId, ...relationData },
          }
        : null;
    case "WorkerDeployment":
      return parts[0] === "selfhost-deployment" && script
        ? { script, data: { scriptName: script, ...relationData } }
        : null;
    case "WorkerEndpoint":
      return parts[0] === "selfhost-endpoint" && script && endpointHostname
        ? {
            script,
            hostname: endpointHostname,
            data: { scriptName: script, hostname: endpointHostname },
          }
        : null;
    case "WorkerCustomDomain": {
      const hostname = normalizedHostname(spec?.hostname);
      return parts[0] === "selfhost-domain" && hostname && relationScript && parts[1] === hostname
        ? {
            script: relationScript,
            hostname,
            data: { scriptName: relationScript, hostname, ...relationData },
          }
        : null;
    }
    case "WorkerCronTrigger": {
      const cron = optionalSafeString(spec?.cron);
      return parts[0] === "selfhost-cron" && script && cron
        ? { script, data: { scriptName: script, cron } }
        : null;
    }
    case "QueueConsumer": {
      const queue = safeSegment(parts[1]) ? parts[1] : undefined;
      const consumerScript = safeSegment(parts[2]) ? parts[2] : undefined;
      return parts[0] === "selfhost-consumer" && queue && consumerScript
        ? {
            script: consumerScript,
            data: { queueName: queue, scriptName: consumerScript, ...relationData },
          }
        : null;
    }
    case "ObjectBucket":
    case "object_bucket": {
      const name = parts[0] === "local-bucket" ? parts[1] : null;
      return name && safeSegment(name) ? { data: { bucketName: name } } : null;
    }
    case "EdgeKVNamespace":
      return parts[0] === "selfhost-kv" && safeSegment(parts[1])
        ? { data: { namespaceId: parts[1] as string } }
        : null;
    case "AtLeastOnceQueue":
      return parts[0] === "selfhost-queue" && safeSegment(parts[1])
        ? { data: { queueName: parts[1] as string } }
        : null;
    case "SQLiteDatabase":
    case "sql_database":
      return parts[0] === "selfhost-sqlite" && safeSegment(parts[1])
        ? { databaseName: parts[1] as string, data: { databaseName: parts[1] as string } }
        : null;
    default:
      return null;
  }
}

/**
 * The one namespace or database a data binding's relation names, or null.
 *
 * Three independent facts have to agree before this returns: the relation
 * points at the expected Form kind, the deployment's native id was minted by
 * this provider for that kind, and the deployment's own published output names
 * the same thing. Any one of them alone can be stale after a reconcile; all
 * three agreeing is what makes the answer this Host's own.
 */
function selfhostNamespaceTarget(
  relation: ProviderRelation | undefined,
  prefix: string,
  resourceKind: string,
  databasePath: (name: string) => string,
): string | null {
  if (!relation || relation.resource.kind !== resourceKind) return null;
  if (relation.targetUid !== relation.resource.metadata.uid) return null;
  const nativeId = relation.deployment?.nativeId;
  if (typeof nativeId !== "string") return null;
  const parts = nativeId.split(":");
  const name = parts[0] === prefix && safeSegment(parts[1]) ? (parts[1] as string) : null;
  if (!name) return null;
  const outputs = relation.deployment?.outputs;
  if (resourceKind === "SQLiteDatabase") {
    return outputs?.engine === "sqlite" && outputs.path === databasePath(name) ? name : null;
  }
  if (resourceKind === "AtLeastOnceQueue") {
    return outputs?.queueId === name && outputs.queueName === name ? name : null;
  }
  return outputs?.namespaceId === name ? name : null;
}

/** The namespace or database name inside one of this provider's native ids. */
function selfhostNamespaceName(prefix: string, nativeId: string | undefined): string | null {
  if (typeof nativeId !== "string") return null;
  const parts = nativeId.split(":");
  return parts[0] === prefix && safeSegment(parts[1]) ? (parts[1] as string) : null;
}

function selfhostWorkerScript(relations: readonly ProviderRelation[] | undefined): string | null {
  const nativeId = relations?.find((relation) => relation.pointer === "/worker")?.deployment
    ?.nativeId;
  if (typeof nativeId !== "string") return null;
  const parts = nativeId.split(":");
  return parts[0] === "selfhost-worker" && safeSegment(parts[1]) ? parts[1] : null;
}

function safeRelationData(spec: JsonObject | undefined): JsonObject {
  if (
    safeSegment(spec?.workerName) &&
    safeSegment(spec?.workerSpace) &&
    safeSegment(spec?.workerUid)
  ) {
    return {
      workerName: spec.workerName,
      workerSpace: spec.workerSpace,
      workerUid: spec.workerUid,
    };
  }
  return {};
}

function validateSelfhostReadbackDescriptor(
  provider: string,
  kind: string,
  descriptor: ProviderNativeReadbackDescriptor,
): SelfhostReadbackParsed | null {
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
    return null;
  }
  if (
    descriptor.apiVersion !== PROVIDER_READBACK_API_VERSION ||
    descriptor.provider !== provider ||
    descriptor.kind !== kind ||
    typeof descriptor.nativeId !== "string" ||
    descriptor.nativeId.length < 1 ||
    descriptor.nativeId.length > 4_096 ||
    !isJsonObject(descriptor.data)
  ) {
    return null;
  }
  const parsed = parseSelfhostNativeId(kind, descriptor.nativeId, descriptor.data);
  if (!parsed) return null;
  const matches =
    kind === "WorkerEndpoint"
      ? selfhostEndpointDataMatches(parsed, descriptor.data)
      : selfhostDataMatches(parsed.data, descriptor.data);
  if (!matches) return null;
  // The descriptor creator may include safe worker relation metadata. Reject
  // an incomplete relation tuple rather than allowing an ambiguous parent.
  const relationKeys = ["workerName", "workerSpace", "workerUid"];
  const relationPresent = relationKeys.some((key) => key in descriptor.data);
  if (
    relationPresent &&
    (!relationKeys.every((key) => typeof descriptor.data[key] === "string") ||
      relationKeys.some((key) => !safeSegment(String(descriptor.data[key]))))
  ) {
    return null;
  }
  return parsed;
}

function selfhostEndpointDataMatches(parsed: SelfhostReadbackParsed, actual: JsonObject): boolean {
  if (!parsed.script || !parsed.hostname || !normalizedHostname(actual.hostname)) return false;
  const keys = Object.keys(actual).sort();
  return (
    keys.length === 2 &&
    keys[0] === "hostname" &&
    keys[1] === "scriptName" &&
    actual.scriptName === parsed.script &&
    typeof actual.hostname === "string" &&
    actual.hostname === parsed.hostname
  );
}

function selfhostDataMatches(expected: JsonObject, actual: JsonObject): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    !expectedKeys.every((key, i) => key === actualKeys[i])
  ) {
    return false;
  }
  return expectedKeys.every((key) => actual[key] === expected[key]);
}

class SelfhostReadbackMalformed extends Error {}

interface ReadonlyScriptState {
  readonly exists: boolean;
  readonly activeVersion?: string;
  readonly endpointHostname?: string;
  readonly domains: readonly string[];
  /** Native queue ids this script drains, in whatever order it was written. */
  readonly consumers: readonly string[];
  readonly crons: readonly string[];
}

async function readSelfhostState(root: string, script: string): Promise<ReadonlyScriptState> {
  const path = join(root, `${script}.json`);
  const temporary = await readFile(`${path}.tmp`).catch(() => null);
  const bytes = await readFile(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (temporary !== null) throw new SelfhostReadbackMalformed();
  if (bytes === null) return { exists: false, domains: [], consumers: [], crons: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SelfhostReadbackMalformed();
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.domains)) {
    throw new SelfhostReadbackMalformed();
  }
  const activeVersion = parsed.activeVersion;
  const endpointHostname = parsed.endpointHostname;
  const domains = parsed.domains;
  const consumers = parsed.consumers ?? [];
  const crons = parsed.crons ?? [];
  if (
    (activeVersion !== undefined && !safeSegment(activeVersion)) ||
    (endpointHostname !== undefined && !normalizedHostname(endpointHostname)) ||
    domains.some((value) => !normalizedHostname(value)) ||
    !Array.isArray(consumers) ||
    !Array.isArray(crons) ||
    crons.some((value) => !optionalSafeString(value)) ||
    consumers.some((value) => !isJsonObject(value) || !safeSegment(value.queue)) ||
    Object.keys(parsed).some(
      (key) =>
        key !== "activeVersion" &&
        key !== "endpointHostname" &&
        key !== "domains" &&
        key !== "consumers" &&
        key !== "crons",
    )
  ) {
    throw new SelfhostReadbackMalformed();
  }
  return {
    exists: true,
    ...(typeof activeVersion === "string" ? { activeVersion } : {}),
    ...(typeof endpointHostname === "string" ? { endpointHostname } : {}),
    domains: domains.filter((value): value is string => typeof value === "string"),
    // Only the queue each consumer drains: the limits are the pump's business,
    // and a readback answers "is this attachment there", not "what is it".
    consumers: consumers.map((value) => String((value as JsonObject).queue)),
    crons: crons.filter((value): value is string => typeof value === "string"),
  };
}

interface ReadonlyActivation {
  readonly present: boolean;
}

async function readSelfhostActivation(root: string, script: string): Promise<ReadonlyActivation> {
  const path = join(root, "workers", ".takoserver-active.json");
  const bytes = await readFile(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) return { present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SelfhostReadbackMalformed();
  }
  if (!isJsonObject(parsed)) throw new SelfhostReadbackMalformed();
  for (const generation of Object.values(parsed)) {
    if (generation !== null && typeof generation !== "string") {
      throw new SelfhostReadbackMalformed();
    }
  }
  return { present: Object.hasOwn(parsed, script) };
}

interface ReadonlyRuntimeManifest {
  readonly hostnames: readonly string[];
}

async function readSelfhostRuntimeManifest(
  root: string,
  script: string,
): Promise<ReadonlyRuntimeManifest | null> {
  const directory = join(root, "workers", script);
  const path = join(directory, "takoserver-site.json");
  const bytes = await readFile(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) {
    if (existsSync(directory)) throw new SelfhostReadbackMalformed();
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SelfhostReadbackMalformed();
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.hostnames)) {
    throw new SelfhostReadbackMalformed();
  }
  if (parsed.hostnames.some((hostname) => !normalizedHostname(hostname))) {
    throw new SelfhostReadbackMalformed();
  }
  return {
    hostnames: parsed.hostnames.filter(
      (hostname): hostname is string => typeof hostname === "string",
    ),
  };
}

async function verifySelfhostWorkerAbsence(
  root: string,
  scriptsRoot: string,
  versionsRoot: string,
  script: string,
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
): Promise<ProviderNativeAbsence> {
  const state = await readSelfhostState(scriptsRoot, script);
  const activation = await readSelfhostActivation(root, script);
  const runtimeManifest = await readSelfhostRuntimeManifest(root, script);
  const versions = existsSync(join(versionsRoot, script));
  if (state.exists || activation.present || runtimeManifest !== null || versions) {
    return selfhostAbsence("present", descriptor, kind);
  }
  return selfhostAbsence("absent", descriptor, kind);
}

async function verifySelfhostVersionAbsence(
  versionMaterializer: ReturnType<typeof createSelfhostVersionMaterializer>,
  script: string,
  versionId: string | undefined,
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
): Promise<ProviderNativeAbsence> {
  if (!versionId) return selfhostUnknown("malformed", false);
  const inspected = await versionMaterializer.inspect({ script, versionId });
  if (inspected.state === "absent") return selfhostAbsence("absent", descriptor, kind);
  if (inspected.state === "corrupt") return selfhostUnknown("malformed", false);
  return selfhostAbsence("present", descriptor, kind);
}

async function verifySelfhostDeploymentAbsence(
  root: string,
  script: string,
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
): Promise<ProviderNativeAbsence> {
  const state = await readSelfhostState(join(root, "selfhost", "scripts"), script);
  const activation = await readSelfhostActivation(root, script);
  const manifest = await readSelfhostRuntimeManifest(root, script);
  return state.activeVersion || activation.present || manifest !== null
    ? selfhostAbsence("present", descriptor, kind)
    : selfhostAbsence("absent", descriptor, kind);
}

async function verifySelfhostRouteAbsence(
  root: string,
  script: string,
  hostname: string | undefined,
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
): Promise<ProviderNativeAbsence> {
  if (!hostname) return selfhostUnknown("malformed", false);
  const state = await readSelfhostState(join(root, "selfhost", "scripts"), script);
  const manifest = await readSelfhostRuntimeManifest(root, script);
  const durable =
    kind === "WorkerEndpoint"
      ? state.endpointHostname === hostname
      : state.domains.includes(hostname);
  const serving = manifest?.hostnames.includes(hostname) === true;
  return durable || serving
    ? selfhostAbsence("present", descriptor, kind)
    : selfhostAbsence("absent", descriptor, kind);
}

function selfhostFileAbsence(
  kind: string,
  path: string,
  descriptor: ProviderNativeReadbackDescriptor,
  provider: string,
): ProviderNativeAbsence {
  return selfhostAbsence(existsSync(path) ? "present" : "absent", descriptor, kind, provider);
}

function selfhostAbsence(
  outcome: "absent" | "present",
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
  provider = descriptor.provider,
  data: JsonObject = descriptor.data,
): ProviderNativeAbsence {
  // Descriptor data (script/version/bucket identifiers and parent relation)
  // remains Host-private. Public evidence is intentionally identifier-free.
  void data;
  return { outcome, evidence: { provider, kind, state: outcome } };
}

function selfhostUnknown(
  reason: ProviderNativeAbsenceUnknownReason,
  retryable: boolean,
): ProviderNativeAbsence {
  return { outcome: "unknown", reason, retryable };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSegment(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(value);
}

function optionalSafeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
}

function normalizedHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) return undefined;
  const hostname = value.toLowerCase().replace(/\.$/u, "");
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname) ? hostname : undefined;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * The closed sensitive declaration, sorted, or null when it is not one.
 *
 * The grammar is the superset of the Form's own and the runtime-input
 * authority's, so a name either arrives from both or from neither.
 */
function sensitiveBindingNames(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names = value.filter((entry): entry is string => typeof entry === "string");
  if (
    names.length !== value.length ||
    names.length > MAX_PROVIDER_RUNTIME_INPUT_BINDINGS ||
    new Set(names).size !== names.length ||
    names.some((name) => !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)) ||
    // The one declaration whose grammar admits this Host's own prefix. `vars`
    // names must start with a letter and data-binding names are checked
    // explicitly, so without this the reserved namespace is not reserved: a
    // tenant could name a sensitive var after the data service binding and
    // shadow it.
    names.some((name) => name.startsWith(SELFHOST_WORKER_INTERNAL_BINDING_PREFIX))
  ) {
    return null;
  }
  return [...names].sort();
}

function exactRuntimeInputBindings(
  bindings: Readonly<Record<string, string>>,
  expectedNames: readonly string[],
): boolean {
  return (
    sameStrings(Object.keys(bindings), expectedNames) &&
    expectedNames.every((name) => typeof bindings[name] === "string" && bindings[name].length > 0)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

async function abortRuntimeLease(lease: ProviderRuntimeInputLease): Promise<ProviderTicket | null> {
  try {
    await lease.abort();
    return null;
  } catch (error) {
    return runtimeInputFailure(error, "abort");
  }
}

/**
 * A closed provider outcome for a lease that did not go the way it had to.
 *
 * Nothing about the failure escapes beyond its phase: the message never names
 * a binding, and never carries a Host diagnostic that might quote one.
 */
function runtimeInputFailure(
  error: unknown,
  phase: "acquire" | "abort" | "dispatch" | "recover" | "settle",
): ProviderTicket {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (phase !== "acquire" || code === "unavailable") {
    return failed(
      "unavailable",
      "the sensitive Worker runtime input outcome is indeterminate",
      true,
    );
  }
  // The handoff exists but it was made for a different mutation. This is a
  // definitive refusal of this apply, never a retry: the values belong to the
  // request the preparation named and to no other.
  if (code === "apply_commitment_mismatch") {
    return failed(
      "denied",
      "the sensitive Worker runtime input handoff does not authorize this apply",
    );
  }
  return code === "conflict"
    ? failed("conflict", "the sensitive Worker runtime input lease conflicts")
    : failed("denied", "required sensitive Worker runtime inputs are unavailable");
}

/**
 * The authoritative receipt for one settled handoff.
 *
 * Every field is something this machine read back after the write, and none of
 * them is a value: names, the materialization digest, and the salted commitment
 * to the binding record.
 */
async function versionRuntimeInputReceiptDigest(input: {
  readonly script: string;
  readonly versionId: string;
  readonly materializationDigest: string;
  readonly bindingsDigest: string | null;
  readonly bindingNames: readonly string[];
}): Promise<`sha256:${string}`> {
  const canonical = JSON.stringify({
    format: "takoserver.selfhost-worker-version-runtime-input-receipt@v1",
    script: input.script,
    versionId: input.versionId,
    materializationDigest: input.materializationDigest,
    bindingsDigest: input.bindingsDigest,
    bindingNames: [...input.bindingNames].sort(),
  });
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Whether the recorded environment is exactly the one this apply declares.
 *
 * Names only. A recovery compares what it can prove from durable state against
 * what the desired spec asks for; it never opens a value to do it.
 */
function sameBindingNames(
  recorded: StoredSelfhostVersionBindings | null,
  vars: readonly SelfhostVersionBinding[],
  sensitiveNames: readonly string[],
  dataBindings: readonly SelfhostVersionDataBinding[],
): boolean {
  const expectedVars = vars.map((binding) => binding.name).sort();
  const expectedSensitive = [...sensitiveNames].sort();
  const observedVars = (recorded?.vars ?? []).map((binding) => binding.name).sort();
  const observedSensitive = (recorded?.sensitiveVars ?? []).map((binding) => binding.name).sort();
  // A data binding's target is compared too, not merely its name: an `env.DB`
  // pointed at a different database is the same environment by name and a
  // different one by every meaning that matters.
  const canonicalData = (bindings: readonly SelfhostVersionDataBinding[]): string =>
    JSON.stringify(
      [...bindings]
        .sort((left, right) => (left.name < right.name ? -1 : 1))
        .map((binding) => [
          binding.kind,
          binding.name,
          binding.target,
          binding.queue?.messageRetentionSeconds ?? null,
          binding.queue?.deliveryDelaySeconds ?? null,
        ]),
    );
  return (
    JSON.stringify(expectedVars) === JSON.stringify(observedVars) &&
    JSON.stringify(expectedSensitive) === JSON.stringify(observedSensitive) &&
    canonicalData(dataBindings) === canonicalData(recorded?.dataPlane?.bindings ?? [])
  );
}

function materializationMessage(error: SelfhostVersionMaterializationError): string {
  switch (error.code) {
    case "invalid_spec":
      return "the Worker Version artifacts are invalid";
    case "conflict":
      return "the committed Worker Version materialization conflicts with this apply";
    case "unavailable":
      return "the Worker Version materialization is unavailable";
  }
}

/** Reads every file under a directory into module-name → bytes. */
async function readTree(root: string): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = join(entry.parentPath ?? root);
    const path = join(parent, entry.name);
    const name = path
      .slice(root.length + 1)
      .split("\\")
      .join("/");
    result.set(name, new Uint8Array(await readFile(path)));
  }
  return result;
}

function sqlitePathOf(nativeId: string, databasePath: (name: string) => string): string | null {
  const parts = nativeId.split(":");
  if (parts[0] !== "selfhost-sqlite" || !parts[1] || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) {
    return null;
  }
  return databasePath(parts[1]);
}

function migrationPath(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
