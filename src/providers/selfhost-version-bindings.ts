import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { existsSync, constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseActorAbiRef } from "../actor-abi-ref.ts";
import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "../interface-ref.ts";
import { isJsonObject } from "../json.ts";
import { isStableStandardServiceProtocol } from "../standard-service-port.ts";
import { parseStrictJson } from "../strict-json.ts";

/**
 * Durable runtime bindings for one immutable Worker Version.
 *
 * These live outside the version directory on purpose. That directory's
 * `materializationDigest` means "the bytes the tenant committed", and its
 * `meta.json` is a closed shape whose reader rejects unknown keys and unknown
 * entries — so a binding written into it would turn every already-materialized
 * version corrupt. Bindings are a create-time fact about the same version, kept
 * beside it rather than inside it.
 *
 * The file is `0600` under a `0700` root, because a sensitive var is a value in
 * it. Nothing here is ever logged, and the only thing this module hands to a
 * caller that may travel further is `digest`: a salted commitment, so a short
 * secret cannot be recovered from the runtime generation string that carries it.
 */

const MAX_BYTES = 4 * 1_024 * 1_024;
const SALT_BYTES = 32;
const PLANE_TOKEN_BYTES = 32;
const EVENT_TOKEN_BYTES = 32;
/** The Form's own `maxItems` for `kvBindings` and for `sqliteBindings`. */
const MAX_DATA_BINDINGS = 64;
const MUTEXES = new Map<string, Promise<void>>();

/** The record shape a version that declares no data plane still writes. */
const FORMAT_V1 = "takoserver.selfhost-version-bindings@v1";
/** The shape that also carries the KV/SQL projection and its plane secret. */
const FORMAT_V2 = "takoserver.selfhost-version-bindings@v2";
/**
 * The historical shape that moved handlers to the top level rather than
 * keeping them inside the data plane, and added an event token beside the
 * plane token.
 *
 * Handlers moved because a Cron Trigger or a Queue Consumer is attached long
 * after the Version that answers it was published, and the wrapper that
 * receives the event has to re-export exactly the handlers the Version
 * declared. Keeping them inside the data plane made them a fact only a Version
 * with KV or SQL had.
 *
 * The event token is minted with the record for the same reason. A Worker
 * Version is immutable, so there is no later moment at which one could be
 * added: by the time a Consumer exists, the record it would have to go in is
 * already written.
 */
const FORMAT_V3 = "takoserver.selfhost-version-bindings@v3";
/**
 * Adds the logical Worker identity and its worker.service projections.
 *
 * Both identities are Host Resource UIDs. A script name is derived from a
 * logical address and is therefore reused after delete/recreate; retaining the
 * UID beside it is what prevents an immutable caller Version from silently
 * acquiring authority over the replacement Resource.
 */
const FORMAT_V4 = "takoserver.selfhost-version-bindings@v4";
/**
 * Adds Host-owned, runtime-only material for stable external standard services.
 * The declaration is retained beside the optional JSON binding so recovery can
 * prove the exact slot set without resolving current operator integrations.
 */
const FORMAT_V5 = "takoserver.selfhost-version-bindings@v5";
/**
 * Adds an explicitly scoped Vector binding. The generic target field is not
 * reused: a Vector index is addressed by the tenant and Resource UID together,
 * and the immutable record must retain both values.
 */
const FORMAT_V6 = "takoserver.selfhost-version-bindings@v6";
/** Adds the original one-shot lease generation to the native receipt. */
const FORMAT_V7 = "takoserver.selfhost-version-bindings@v7";
/** Adds exact Actor relation metadata only to Versions that declare Actor bindings. */
const FORMAT_V8 = "takoserver.selfhost-version-bindings@v8";
/** Adds the exact selected Actor runtime InterfaceRef to selected bindings. */
const FORMAT_V9 = "takoserver.selfhost-version-bindings@v9";
/** Adds exact Workflow authority snapshots to immutable Worker Versions. */
const FORMAT_V10 = "takoserver.selfhost-version-bindings@v10";
const WORKFLOW_FORM_REF: TakoformV1Alpha3FormRef = {
  apiVersion: "edge.forms.takoform.com",
  kind: "DurableWorkflow",
  definitionVersion: "0.2.0",
  schemaDigest: "sha256:a58c885bed4431fbdc6b923059fe3b3bf98f7727578914d2d212552ae97fdc65",
};
const WORKFLOW_BINDING_REF: TakoformBindingRef = {
  apiVersion: "bindings.takoform.com/v1alpha2",
  name: "module-worker.workflow",
  version: "3.0.0",
  schemaDigest: "sha256:2b8df3ba036b2781ee3ea8af6603b3de5f09226f4eb1f3385565211cdacc854b",
};
const WORKFLOW_RUNTIME_CLASS_REF: TakoformInterfaceRef = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.workflow",
  version: "3.0.0",
  schemaDigest: "sha256:2584721b4bc9f5feef94b272337c348fb67130de57317afaf84aa7ca55246f69",
};
const LEASE_GENERATION = /^[A-Za-z0-9_-]{16}$/u;

export const SELFHOST_VERSION_DATA_BINDING_KINDS = [
  "edge.kv",
  "edge.objects",
  "edge.queue",
  "edge.sql",
  "edge.vector",
] as const;
export type SelfhostVersionDataBindingKind = (typeof SELFHOST_VERSION_DATA_BINDING_KINDS)[number];
type SelfhostVersionNonVectorDataBindingKind = Exclude<
  SelfhostVersionDataBindingKind,
  "edge.vector"
>;

export const SELFHOST_WORKER_HANDLER_NAMES = ["fetch", "queue", "scheduled"] as const;
export type SelfhostWorkerHandlerName = (typeof SELFHOST_WORKER_HANDLER_NAMES)[number];

const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u;

export interface SelfhostVersionBinding {
  readonly name: string;
  /** Rendered exactly as the module environment must see it. */
  readonly value: string;
  /** `text` is a string binding; `json` is parsed by the runtime before use. */
  readonly kind: "text" | "json";
}

/**
 * One `kvBindings`, `bucketBindings`, `queueProducerBindings`, or
 * `sqliteBindings` entry, resolved to what it addresses.
 *
 * `target` is the namespace id, bucket incarnation, queue id, or database name
 * this Host derived for the related Resource, never a customer string and never
 * a filesystem path. The
 * Worker never sees it: it addresses its own binding by name and the data plane
 * resolves the name through this record, so a Worker cannot reach a namespace
 * its Version did not declare.
 */
export type SelfhostVersionDataBinding =
  | {
      readonly kind: SelfhostVersionNonVectorDataBindingKind;
      readonly name: string;
      readonly target: string;
      /**
       * Only for `edge.queue`: the retention and default delay the queue itself
       * promises, recorded with the binding because the plane has to apply them at
       * the moment a message is accepted.
       *
       * Recorded rather than looked up, for the same reason `vars` are: a
       * publication projects exactly what its apply resolved. The cost is that
       * raising a queue's retention reaches a Worker on its next published Version,
       * not immediately.
       */
      readonly queue?: SelfhostVersionQueueSettings;
    }
  | {
      /** A Vector index is addressed by its complete tenant/Resource scope. */
      readonly kind: "edge.vector";
      readonly name: string;
      readonly scope: {
        readonly tenantId: string;
        readonly resourceUid: string;
      };
    };

export interface SelfhostVersionQueueSettings {
  readonly messageRetentionSeconds: number;
  readonly deliveryDelaySeconds: number;
}

/** One fetch-only worker.service projection pinned to one logical Worker. */
export interface SelfhostVersionServiceBinding {
  readonly name: string;
  /** Stable provider script address; never a URL or public endpoint. */
  readonly target: string;
  /** Exact Resource incarnation the resolved relation pinned. */
  readonly targetResourceUid: string;
}

/** Host-private immutable Actor target; never projected into tenant env or outputs. */
export interface SelfhostVersionActorBinding {
  readonly name: string;
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  readonly workerResourceUid: string;
  readonly className: string;
  /** Exact installed Actor runtime contract selected for this immutable binding. */
  readonly runtimeClassRef?: TakoformInterfaceRef;
}

/** Exact private snapshot of one selected module-worker.workflow relation. */
export interface SelfhostVersionWorkflowBinding {
  readonly name: string;
  readonly tenantId: string;
  readonly workflowResourceUid: string;
  readonly workflowFormRef: TakoformV1Alpha3FormRef;
  readonly bindingRef: TakoformBindingRef;
  readonly runtimeClassRef: TakoformInterfaceRef;
}

/** Derives the caller-facing credential for one exact Workflow relation. */
export function deriveSelfhostWorkflowBindingToken(input: {
  readonly eventToken: string;
  readonly workerVersionResourceUid: string;
  readonly binding: SelfhostVersionWorkflowBinding;
}): string {
  const key = Buffer.from(input.eventToken, "base64url");
  if (
    key.length !== EVENT_TOKEN_BYTES ||
    key.toString("base64url") !== input.eventToken ||
    !RESOURCE_UID.test(input.workerVersionResourceUid)
  ) {
    throw new Error("Workflow Version credential unavailable");
  }
  const binding = normalizeWorkflowBindings([input.binding])?.[0];
  if (!binding) throw new Error("Workflow Version relation unavailable");
  const message = JSON.stringify([
    "takoserver.selfhost-workflow-binding-token@v1",
    binding.tenantId,
    input.workerVersionResourceUid,
    binding.workflowResourceUid,
    binding.name,
    binding.workflowFormRef.apiVersion,
    binding.workflowFormRef.kind,
    binding.workflowFormRef.definitionVersion,
    binding.workflowFormRef.schemaDigest,
    binding.bindingRef.apiVersion,
    binding.bindingRef.name,
    binding.bindingRef.version,
    binding.bindingRef.schemaDigest,
    binding.runtimeClassRef.apiVersion,
    binding.runtimeClassRef.name,
    binding.runtimeClassRef.version,
    binding.runtimeClassRef.schemaDigest,
  ]);
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

/** Derives one private facade credential from an immutable Version secret. */
export function deriveSelfhostActorForwardToken(input: {
  readonly eventToken: string;
  readonly workerVersionResourceUid: string;
  readonly binding: SelfhostVersionActorBinding;
}): string {
  const key = Buffer.from(input.eventToken, "base64url");
  if (
    key.length !== 32 ||
    key.toString("base64url") !== input.eventToken ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u.test(input.workerVersionResourceUid)
  )
    throw new Error("Actor Version credential unavailable");
  const binding = input.binding;
  if (
    !binding ||
    typeof binding.name !== "string" ||
    typeof binding.tenantId !== "string" ||
    typeof binding.namespaceResourceUid !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u.test(binding.workerResourceUid) ||
    typeof binding.className !== "string" ||
    binding.className.length === 0 ||
    binding.className.length > 255 ||
    binding.className.includes("\0")
  )
    throw new Error("Actor Version relation unavailable");
  // JSON arrays are length-delimited by the encoding and preserve field
  // boundaries even when tenant or binding names contain punctuation.
  const message = JSON.stringify([
    "takoserver.selfhost-actor-forward-token@v1",
    binding.tenantId,
    input.workerVersionResourceUid,
    binding.namespaceResourceUid,
    binding.name,
    binding.workerResourceUid,
    binding.className,
  ]);
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

/** One stable external service slot and its optional runtime-only JSON value. */
export interface SelfhostVersionExternalService {
  readonly name: string;
  readonly required: boolean;
  readonly service: {
    readonly apiVersion: "standards.takoform.com/v1";
    readonly protocol: string;
  };
  readonly binding?: {
    readonly kind: "json";
    readonly value: string;
  };
}

/**
 * The half of a version's environment that needs a data plane behind it.
 *
 * A KV, queue, or SQL binding is not a value workerd can carry — there is no
 * such binding type — so the version is published through a generated
 * entrypoint that projects the exact `edge.kv` / `edge.queue` / `edge.sql`
 * facades over this Host's data planes.
 */
export interface SelfhostVersionDataPlane {
  readonly bindings: readonly SelfhostVersionDataBinding[];
}

export interface SelfhostVersionBindingSet {
  /** Original one-shot lease generation; never inferred from a later row. */
  readonly runtimeInputGeneration?: string;
  /** Exact ModuleWorker Resource this immutable Version revises. */
  readonly workerResourceUid: string;
  /**
   * The events the Version says its module answers.
   *
   * Recorded for every Version, with or without a binding, because the wrapper
   * that receives a queue batch or a cron match has to re-export exactly them
   * and is generated long after the apply that read the declaration.
   */
  readonly handlers: readonly SelfhostWorkerHandlerName[];
  /** Non-secret configuration from the Worker Version's own `vars`. */
  readonly vars: readonly SelfhostVersionBinding[];
  /** Values delivered through the runtime-input lease, never from portable state. */
  readonly sensitiveVars: readonly SelfhostVersionBinding[];
  /** Fetch-only projections to other logical ModuleWorkers. */
  readonly serviceBindings: readonly SelfhostVersionServiceBinding[];
  readonly workerVersionResourceUid?: string;
  readonly actorBindings?: readonly SelfhostVersionActorBinding[];
  /** Absent when the Version declares no typed Workflow consumer bindings. */
  readonly workflowBindings?: readonly SelfhostVersionWorkflowBinding[];
  /** Stable external service declarations and optional runtime JSON values. */
  readonly externalServices?: readonly SelfhostVersionExternalService[];
  /** Absent when the version binds no namespace, queue, or database. */
  readonly dataPlane?: SelfhostVersionDataPlane;
}

/** Value-free custody of one accepted sensitive Worker Version operation. */
export interface SelfhostRuntimeInputMarkerIdentity {
  readonly tenantId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly resourceUid: string;
  readonly workerResourceUid: string;
  readonly space: string;
  readonly workerName: string;
  readonly bundleName: string;
}

export interface SelfhostRuntimeInputMarker extends SelfhostRuntimeInputMarkerIdentity {
  readonly generation: string;
}

export interface StoredSelfhostVersionBindings {
  /** Absent on historical records, which cannot settle a sensitive recovery. */
  readonly runtimeInputGeneration?: string;
  /** Absent only on a retained @v1-@v3 record; it is never inferred. */
  readonly workerResourceUid?: string;
  /**
   * Absent on a record an earlier build wrote with no data plane. Such a
   * Version publishes exactly as it did; it simply cannot be given a wrapper,
   * so attaching an event to it is refused rather than half-served.
   */
  readonly handlers?: readonly SelfhostWorkerHandlerName[];
  readonly vars: readonly SelfhostVersionBinding[];
  readonly sensitiveVars: readonly SelfhostVersionBinding[];
  /** Absent only on a retained @v1-@v3 record. */
  readonly serviceBindings?: readonly SelfhostVersionServiceBinding[];
  readonly workerVersionResourceUid?: string;
  readonly actorBindings?: readonly SelfhostVersionActorBinding[];
  readonly workflowBindings?: readonly SelfhostVersionWorkflowBinding[];
  /** Absent on @v1-@v4 records and on versions with no external services. */
  readonly externalServices?: readonly SelfhostVersionExternalService[];
  readonly dataPlane?: SelfhostVersionDataPlane;
  /** Salted commitment to this exact binding set; safe to place in a generation. */
  readonly digest: `sha256:${string}`;
  /**
   * The per-version secret the generated entrypoint presents to the data
   * planes. Minted once and kept across a retry, exactly like the salt, because
   * a Worker Version is immutable and a second token would leave the serving
   * script authenticating with one this Host no longer holds. Never logged,
   * never observed, never projected into the module environment.
   */
  readonly planeToken?: string;
  /**
   * The per-version secret this Host presents to the event gate in front of the
   * Worker. Declared on the gate service and nowhere else, so tenant code
   * cannot read it and cannot forge a delivery to its own handlers — or, more
   * to the point, to another script's.
   */
  readonly eventToken?: string;
}

export class SelfhostVersionBindingStoreError extends Error {
  constructor(readonly code: "corrupt" | "unavailable") {
    super(`selfhost_version_bindings_${code}`);
    this.name = "SelfhostVersionBindingStoreError";
  }
}

export interface SelfhostVersionBindingStore {
  /** The stored set, or null when this version declared none. */
  read(script: string, versionId: string): Promise<StoredSelfhostVersionBindings | null>;
  /**
   * Writes the set for one version.
   *
   * A Worker Version is immutable, so a retry that presents the same bindings
   * adopts the stored record -- salt, plane token, and event token included --
   * rather than minting a generation the runtime would then have to chase.
   *
   * "The same bindings" normally means the record already carries everything
   * the current format carries. A legacy record that predates logical Worker
   * identity may still be adopted when it declares no service binding, so an
   * unrelated reconcile does not rotate a token used by the serving runtime.
   * Its missing identity is never inferred: a newly published Version is what
   * makes that logical Worker eligible as a worker.service target.
   *
   * A `@v1` record also predates the handler list. It cannot be adopted for a
   * set that declares handlers and is rewritten, which costs a new salt but no
   * plane token because `@v1` has no data plane. `@v2` and `@v3` records carry
   * serving tokens and remain byte-for-byte stable when their declarations are
   * otherwise unchanged and no service binding was added.
   */
  write(
    script: string,
    versionId: string,
    set: SelfhostVersionBindingSet,
    marker?: SelfhostRuntimeInputMarker,
  ): Promise<StoredSelfhostVersionBindings>;
  /** Durable, exact operation custody before the one-shot lease is dispatched. */
  pinRuntimeInput(
    script: string,
    versionId: string,
    marker: SelfhostRuntimeInputMarker,
  ): Promise<void>;
  /** Never derives a generation from the current public preparation row. */
  readRuntimeInput(
    script: string,
    versionId: string,
    identity: SelfhostRuntimeInputMarkerIdentity,
  ): Promise<{
    readonly generation: string;
    readonly state: "active" | "written" | "closed";
  } | null>;
  /** Fences every late native writer before proving the sensitive file absent. */
  closeAbsentRuntimeInput(
    script: string,
    versionId: string,
    marker: SelfhostRuntimeInputMarker,
  ): Promise<boolean>;
  remove(script: string, versionId: string): Promise<boolean>;
  /** Forgets every version of one script. */
  removeScript(script: string): Promise<void>;
}

export function createSelfhostVersionBindingStore(options: {
  readonly root: string;
  readonly randomBytes?: (length: number) => Uint8Array;
  /** Fault-injection seam for crash tests; never supplied by provider composition. */
  readonly afterNativeWriteBeforeCommit?: () => Promise<void>;
}): SelfhostVersionBindingStore {
  const root = resolve(options.root);
  const randomBytes = options.randomBytes ?? ((length: number) => nodeRandomBytes(length));

  const directoryFor = (script: string): string => {
    if (!SCRIPT_NAME.test(script)) throw new SelfhostVersionBindingStoreError("corrupt");
    return join(root, script);
  };
  const pathFor = (script: string, versionId: string): string => {
    if (!VERSION_ID.test(versionId)) throw new SelfhostVersionBindingStoreError("corrupt");
    return join(directoryFor(script), `${versionId}.json`);
  };

  const readCurrent = async (
    script: string,
    versionId: string,
  ): Promise<StoredSelfhostVersionBindings | null> => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(pathFor(script, versionId)));
    } catch (error) {
      if (error instanceof SelfhostVersionBindingStoreError) throw error;
      if (errorCode(error) === "ENOENT") return null;
      throw new SelfhostVersionBindingStoreError("unavailable");
    }
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_BYTES) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    return parseStored(bytes);
  };

  const markerPath = join(root, "runtime-input-custody.sqlite");
  const withMarkerTransaction = async <T>(operation: (db: Database) => Promise<T>): Promise<T> => {
    let db: Database | undefined;
    let begun = false;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      const handle = await open(
        markerPath,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.close();
      await chmod(markerPath, 0o600);
      await syncDirectory(root);
      db = new Database(markerPath);
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA synchronous = FULL");
      db.exec(`CREATE TABLE IF NOT EXISTS runtime_input_custody (
        script TEXT NOT NULL,
        version_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        generation TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'written', 'closed')),
        PRIMARY KEY (script, version_id)
      )`);
      db.exec("BEGIN IMMEDIATE");
      begun = true;
      const result = await operation(db);
      db.exec("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try {
          db?.exec("ROLLBACK");
        } catch {
          // The original refusal remains authoritative.
        }
      }
      if (error instanceof SelfhostVersionBindingStoreError) throw error;
      throw new SelfhostVersionBindingStoreError("unavailable");
    } finally {
      db?.close();
    }
  };

  const markerRow = (db: Database, script: string, versionId: string) =>
    db
      .query(
        "SELECT operation_id, identity_json, generation, state FROM runtime_input_custody WHERE script = ? AND version_id = ?",
      )
      .get(script, versionId) as {
      operation_id: string;
      identity_json: string;
      generation: string;
      state: string;
    } | null;

  const markerIdentity = (marker: SelfhostRuntimeInputMarkerIdentity): string => {
    const fields = [
      marker.tenantId,
      marker.operationId,
      marker.operationKey,
      marker.resourceUid,
      marker.workerResourceUid,
      marker.space,
      marker.workerName,
      marker.bundleName,
    ];
    if (
      fields.some((value) => typeof value !== "string" || value.length < 1 || value.length > 512)
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    const identity = JSON.stringify({
      tenantId: marker.tenantId,
      operationId: marker.operationId,
      operationKey: marker.operationKey,
      resourceUid: marker.resourceUid,
      workerResourceUid: marker.workerResourceUid,
      space: marker.space,
      workerName: marker.workerName,
      bundleName: marker.bundleName,
    });
    if (identity.length > 4_096) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    return identity;
  };

  const assertMarker = (
    row: ReturnType<typeof markerRow>,
    marker: SelfhostRuntimeInputMarker,
    state: "active" | "written" | "closed",
  ): void => {
    if (
      !row ||
      row.identity_json !== markerIdentity(marker) ||
      row.generation !== marker.generation ||
      row.state !== state
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
  };

  return {
    async read(script, versionId) {
      return await locked(`${root}\u0000${script}\u0000${versionId}`, async () => {
        pathFor(script, versionId);
        // A sensitive writer creates the custody DB before any native temp
        // file. Without it, do not unlink a temp that could be about to enter
        // that cross-process critical section.
        if (!existsSync(markerPath)) return await readCurrent(script, versionId);
        return await withMarkerTransaction(async () => {
          await cleanAbandonedWrite(pathFor(script, versionId));
          return await readCurrent(script, versionId);
        });
      });
    },

    async pinRuntimeInput(script, versionId, marker) {
      pathFor(script, versionId);
      if (!LEASE_GENERATION.test(marker.generation)) {
        throw new SelfhostVersionBindingStoreError("corrupt");
      }
      const identity = markerIdentity(marker);
      await locked(`${root}\u0000${script}\u0000${versionId}`, async () => {
        await withMarkerTransaction(async (db) => {
          const row = markerRow(db, script, versionId);
          if (!row) {
            db.query(`INSERT INTO runtime_input_custody
                (script, version_id, operation_id, identity_json, generation, state)
                VALUES (?, ?, ?, ?, ?, 'active')`).run(
              script,
              versionId,
              marker.operationId,
              identity,
              marker.generation,
            );
            return;
          }
          if (
            row.state === "active" &&
            row.identity_json === identity &&
            row.generation === marker.generation
          )
            return;
          if (
            row.state !== "closed" ||
            row.operation_id === marker.operationId ||
            row.generation === marker.generation ||
            (await readCurrent(script, versionId))
          ) {
            throw new SelfhostVersionBindingStoreError("corrupt");
          }
          db.query(`UPDATE runtime_input_custody SET operation_id = ?, identity_json = ?, generation = ?, state = 'active'
            WHERE script = ? AND version_id = ? AND state = 'closed'`).run(
            marker.operationId,
            identity,
            marker.generation,
            script,
            versionId,
          );
        });
      });
    },

    async readRuntimeInput(script, versionId, identity) {
      pathFor(script, versionId);
      const expected = markerIdentity(identity);
      return await locked(
        `${root}\u0000${script}\u0000${versionId}`,
        async () =>
          await withMarkerTransaction(async (db) => {
            const row = markerRow(db, script, versionId);
            if (!row) return null;
            if (
              row.identity_json !== expected ||
              !LEASE_GENERATION.test(row.generation) ||
              (row.state !== "active" && row.state !== "written" && row.state !== "closed")
            ) {
              throw new SelfhostVersionBindingStoreError("corrupt");
            }
            return { generation: row.generation, state: row.state };
          }),
      );
    },

    async closeAbsentRuntimeInput(script, versionId, marker) {
      pathFor(script, versionId);
      return await locked(
        `${root}\u0000${script}\u0000${versionId}`,
        async () =>
          await withMarkerTransaction(async (db) => {
            const row = markerRow(db, script, versionId);
            if (
              !row ||
              row.identity_json !== markerIdentity(marker) ||
              row.generation !== marker.generation
            ) {
              throw new SelfhostVersionBindingStoreError("corrupt");
            }
            await cleanAbandonedWrite(pathFor(script, versionId));
            if (await readCurrent(script, versionId)) return false;
            // The binding once reached disk, even if it disappeared later.
            // Absence now cannot prove that the handoff had no effect.
            if (row.state === "written") throw new SelfhostVersionBindingStoreError("corrupt");
            if (row.state === "closed") return true;
            assertMarker(row, marker, "active");
            db.query(`UPDATE runtime_input_custody SET state = 'closed'
            WHERE script = ? AND version_id = ? AND identity_json = ? AND generation = ? AND state = 'active'`).run(
              script,
              versionId,
              row.identity_json,
              marker.generation,
            );
            return true;
          }),
      );
    },

    async write(script, versionId, set, marker) {
      const normalized = normalizeSet(set);
      if (
        normalized.runtimeInputGeneration &&
        (!marker || marker.generation !== normalized.runtimeInputGeneration)
      ) {
        throw new SelfhostVersionBindingStoreError("corrupt");
      }
      return await locked(`${root}\u0000${script}\u0000${versionId}`, async () => {
        const performWrite = async (): Promise<StoredSelfhostVersionBindings> => {
          const path = pathFor(script, versionId);
          await cleanAbandonedWrite(path);
          const current = await readCurrent(script, versionId);
          // A native record with sensitive values belongs to one exact handoff.
          // Neither a new generation nor a missing legacy marker can adopt it.
          if (
            current?.sensitiveVars.length &&
            current.runtimeInputGeneration !== normalized.runtimeInputGeneration
          ) {
            throw new SelfhostVersionBindingStoreError("corrupt");
          }
          if (current && sameBindings(current, normalized)) return current;
          // Workflow authority is a fact of the immutable Version. A retry may
          // adopt the exact snapshot above, but neither adding nor removing a
          // binding may reinterpret an already-written event token.
          if (current && (normalized.workflowBindings || current.workflowBindings)) {
            throw new SelfhostVersionBindingStoreError("corrupt");
          }
          // A historical Version's serving token is immutable. Adding Actor
          // authority to that Version would either rotate it or reinterpret a
          // token that never committed to this relation.
          if (current && (normalized.actorBindings || current.actorBindings)) {
            throw new SelfhostVersionBindingStoreError("corrupt");
          }
          try {
            // 0700 so a second account on the machine cannot even enumerate which
            // versions carry which binding names.
            await mkdir(directoryFor(script), { recursive: true, mode: 0o700 });
          } catch {
            throw new SelfhostVersionBindingStoreError("unavailable");
          }
          const salt = base64Url(Uint8Array.from(randomBytes(SALT_BYTES)));
          const planeToken = normalized.dataPlane
            ? base64Url(Uint8Array.from(randomBytes(PLANE_TOKEN_BYTES)))
            : undefined;
          // Minted for every Version, because a Worker Version is immutable and
          // the Consumer or Trigger that needs it is attached after this record
          // is the only one there will ever be.
          const eventToken = base64Url(Uint8Array.from(randomBytes(EVENT_TOKEN_BYTES)));
          if (
            decodedLength(salt) !== SALT_BYTES ||
            decodedLength(eventToken) !== EVENT_TOKEN_BYTES ||
            (planeToken !== undefined && decodedLength(planeToken) !== PLANE_TOKEN_BYTES)
          ) {
            throw new SelfhostVersionBindingStoreError("unavailable");
          }
          const format = formatForSet(normalized);
          const raw = canonicalRecord(format, salt, normalized, planeToken, eventToken);
          const bytes = new TextEncoder().encode(raw);
          if (bytes.byteLength > MAX_BYTES) throw new SelfhostVersionBindingStoreError("corrupt");
          const temporary = `${path}.tmp`;
          let handle: Awaited<ReturnType<typeof open>> | undefined;
          let closed = false;
          try {
            handle = await open(
              temporary,
              fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_WRONLY |
                fsConstants.O_NOFOLLOW,
              0o600,
            );
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            closed = true;
            await rename(temporary, path);
            await syncDirectory(directoryFor(script));
          } catch {
            if (!closed) await handle?.close().catch(() => undefined);
            throw new SelfhostVersionBindingStoreError("unavailable");
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
          return {
            ...normalized,
            digest: digestOf(format, salt, normalized, planeToken, eventToken),
            ...(planeToken === undefined ? {} : { planeToken }),
            eventToken,
          };
        };
        if (!marker) return await performWrite();
        return await withMarkerTransaction(async (db) => {
          const row = markerRow(db, script, versionId);
          if (row?.state === "written") {
            assertMarker(row, marker, "written");
            const current = await readCurrent(script, versionId);
            if (current && sameBindings(current, normalized)) return current;
            throw new SelfhostVersionBindingStoreError("corrupt");
          }
          assertMarker(row, marker, "active");
          const written = await performWrite();
          db.query(`UPDATE runtime_input_custody SET state = 'written'
            WHERE script = ? AND version_id = ? AND identity_json = ? AND generation = ? AND state = 'active'`).run(
            script,
            versionId,
            markerIdentity(marker),
            marker.generation,
          );
          await options.afterNativeWriteBeforeCommit?.();
          return written;
        });
      });
    },

    async remove(script, versionId) {
      return await locked(`${root}\u0000${script}\u0000${versionId}`, async () => {
        return await withMarkerTransaction(async (db) => {
          const path = pathFor(script, versionId);
          await cleanAbandonedWrite(path);
          let removed = false;
          try {
            await rm(path);
            await syncDirectory(directoryFor(script));
            removed = true;
          } catch (error) {
            if (errorCode(error) !== "ENOENT") {
              throw new SelfhostVersionBindingStoreError("unavailable");
            }
          }
          db.query("DELETE FROM runtime_input_custody WHERE script = ? AND version_id = ?").run(
            script,
            versionId,
          );
          return removed;
        });
      });
    },

    async removeScript(script) {
      await withMarkerTransaction(async (db) => {
        try {
          await rm(directoryFor(script), { recursive: true, force: true });
        } catch (error) {
          if (error instanceof SelfhostVersionBindingStoreError) throw error;
          throw new SelfhostVersionBindingStoreError("unavailable");
        }
        db.query("DELETE FROM runtime_input_custody WHERE script = ?").run(script);
      });
    },
  };
}

async function cleanAbandonedWrite(path: string): Promise<void> {
  try {
    await rm(`${path}.tmp`, { force: true });
  } catch {
    throw new SelfhostVersionBindingStoreError("unavailable");
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = MUTEXES.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  MUTEXES.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (MUTEXES.get(key) === current) MUTEXES.delete(key);
  }
}

/**
 * The purely declarative half of `write`: shape, grammar, ordering, and the
 * rule that a `vars` name and a sensitive name cannot collide.
 *
 * It is exported because the caller must be able to run it *before* it spends a
 * one-shot runtime-input lease. A refusal that needs no disk is a refusal that
 * must not happen after the ciphertext has been erased.
 */
export function normalizeSelfhostVersionBindingSet(
  set: SelfhostVersionBindingSet,
): SelfhostVersionBindingSet {
  const normalized = normalizeSet(set);
  // Check the complete envelope before materialization or a one-shot secret
  // dispatch, not only in write(). Tokens and salt have fixed encoded lengths.
  const placeholder = "A".repeat(43);
  const raw = canonicalRecord(
    formatForSet(normalized),
    placeholder,
    normalized,
    normalized.dataPlane ? placeholder : undefined,
    placeholder,
  );
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return normalized;
}

function normalizeSet(set: SelfhostVersionBindingSet): SelfhostVersionBindingSet {
  if (
    set.runtimeInputGeneration !== undefined &&
    (typeof set.runtimeInputGeneration !== "string" ||
      !LEASE_GENERATION.test(set.runtimeInputGeneration))
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (typeof set.workerResourceUid !== "string" || !RESOURCE_UID.test(set.workerResourceUid)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const handlers = normalizeHandlers(set.handlers);
  const vars = normalizeBindings(set.vars);
  const sensitiveVars = normalizeBindings(set.sensitiveVars);
  if (set.runtimeInputGeneration && sensitiveVars.length === 0) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const dataPlane = set.dataPlane === undefined ? undefined : normalizeDataPlane(set.dataPlane);
  const serviceBindings = normalizeServiceBindings(set.serviceBindings);
  const externalServices = normalizeExternalServices(set.externalServices);
  const workflowBindings = normalizeWorkflowBindings(set.workflowBindings);
  if (
    set.workerVersionResourceUid !== undefined &&
    (typeof set.workerVersionResourceUid !== "string" ||
      !RESOURCE_UID.test(set.workerVersionResourceUid))
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (
    workflowBindings &&
    (typeof set.workerVersionResourceUid !== "string" ||
      !RESOURCE_UID.test(set.workerVersionResourceUid))
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (
    !workflowBindings &&
    set.actorBindings === undefined &&
    set.workerVersionResourceUid !== undefined
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const actorBindings = normalizeActorBindings(
    set.actorBindings,
    set.actorBindings === undefined ? undefined : set.workerVersionResourceUid,
  );
  if (actorBindings && sensitiveVars.length > 0 && !set.runtimeInputGeneration) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const names = new Set<string>();
  for (const name of [
    ...vars.map((binding) => binding.name),
    ...sensitiveVars.map((binding) => binding.name),
    ...(dataPlane?.bindings ?? []).map((binding) => binding.name),
    ...serviceBindings.map((binding) => binding.name),
    ...(actorBindings ?? []).map((binding) => binding.name),
    ...(workflowBindings ?? []).map((binding) => binding.name),
    ...(externalServices ?? []).map((binding) => binding.name),
  ]) {
    if (names.has(name)) throw new SelfhostVersionBindingStoreError("corrupt");
    names.add(name);
  }
  return {
    workerResourceUid: set.workerResourceUid,
    handlers,
    vars,
    sensitiveVars,
    ...(set.runtimeInputGeneration ? { runtimeInputGeneration: set.runtimeInputGeneration } : {}),
    serviceBindings,
    ...(actorBindings
      ? { workerVersionResourceUid: set.workerVersionResourceUid, actorBindings }
      : {}),
    ...(workflowBindings
      ? { workerVersionResourceUid: set.workerVersionResourceUid, workflowBindings }
      : {}),
    ...(externalServices ? { externalServices } : {}),
    ...(dataPlane ? { dataPlane } : {}),
  };
}

export function normalizeWorkflowBindings(
  bindings: readonly SelfhostVersionWorkflowBinding[] | undefined,
): readonly SelfhostVersionWorkflowBinding[] | undefined {
  if (bindings === undefined) return undefined;
  if (!Array.isArray(bindings)) throw new SelfhostVersionBindingStoreError("corrupt");
  if (bindings.length === 0) return undefined;
  if (bindings.length > 64) throw new SelfhostVersionBindingStoreError("corrupt");
  const normalized = bindings
    .map((candidate) => {
      const binding = ownDataRecord(candidate, [
        "bindingRef",
        "name",
        "runtimeClassRef",
        "tenantId",
        "workflowFormRef",
        "workflowResourceUid",
      ]);
      if (
        !binding ||
        typeof binding.name !== "string" ||
        binding.name.length > 64 ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(binding.name) ||
        typeof binding.tenantId !== "string" ||
        !boundedCodePointString(binding.tenantId, 1, 255) ||
        binding.tenantId.includes("\u0000") ||
        typeof binding.workflowResourceUid !== "string" ||
        !RESOURCE_UID.test(binding.workflowResourceUid)
      ) {
        throw new SelfhostVersionBindingStoreError("corrupt");
      }
      const workflowFormRef = exactWorkflowFormRef(binding.workflowFormRef);
      const bindingRef = exactWorkflowBindingRef(binding.bindingRef);
      const runtimeClassRef = exactWorkflowRuntimeClassRef(binding.runtimeClassRef);
      return {
        name: binding.name,
        tenantId: binding.tenantId,
        workflowResourceUid: binding.workflowResourceUid,
        workflowFormRef,
        bindingRef,
        runtimeClassRef,
      } satisfies SelfhostVersionWorkflowBinding;
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.name === normalized[index]?.name) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
  }
  return normalized;
}

function exactWorkflowFormRef(value: unknown): TakoformV1Alpha3FormRef {
  const ref = ownDataRecord(value, ["apiVersion", "definitionVersion", "kind", "schemaDigest"]);
  if (
    !ref ||
    ref.apiVersion !== WORKFLOW_FORM_REF.apiVersion ||
    ref.kind !== WORKFLOW_FORM_REF.kind ||
    ref.definitionVersion !== WORKFLOW_FORM_REF.definitionVersion ||
    ref.schemaDigest !== WORKFLOW_FORM_REF.schemaDigest
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return Object.freeze({ ...WORKFLOW_FORM_REF });
}

function exactWorkflowBindingRef(value: unknown): TakoformBindingRef {
  const ref = ownDataRecord(value, ["apiVersion", "name", "schemaDigest", "version"]);
  if (
    !ref ||
    ref.apiVersion !== WORKFLOW_BINDING_REF.apiVersion ||
    ref.name !== WORKFLOW_BINDING_REF.name ||
    ref.version !== WORKFLOW_BINDING_REF.version ||
    ref.schemaDigest !== WORKFLOW_BINDING_REF.schemaDigest
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return Object.freeze({ ...WORKFLOW_BINDING_REF });
}

function exactWorkflowRuntimeClassRef(value: unknown): TakoformInterfaceRef {
  const ref = ownDataRecord(value, ["apiVersion", "name", "schemaDigest", "version"]);
  if (
    !ref ||
    ref.apiVersion !== WORKFLOW_RUNTIME_CLASS_REF.apiVersion ||
    ref.name !== WORKFLOW_RUNTIME_CLASS_REF.name ||
    ref.version !== WORKFLOW_RUNTIME_CLASS_REF.version ||
    ref.schemaDigest !== WORKFLOW_RUNTIME_CLASS_REF.schemaDigest
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return Object.freeze({ ...WORKFLOW_RUNTIME_CLASS_REF });
}

/**
 * Stable external services are a closed declaration list. An empty list is
 * normalized to absence so the historical @v1-@v4 bytes remain unchanged.
 */
function normalizeExternalServices(
  services: readonly SelfhostVersionExternalService[] | undefined,
): readonly SelfhostVersionExternalService[] | undefined {
  if (services === undefined) return undefined;
  if (!Array.isArray(services)) throw new SelfhostVersionBindingStoreError("corrupt");
  if (services.length === 0) return undefined;
  if (services.length > 16) throw new SelfhostVersionBindingStoreError("corrupt");
  const sorted = [...services].sort((left, right) => {
    const leftName =
      typeof left === "object" &&
      left !== null &&
      !Array.isArray(left) &&
      typeof left.name === "string"
        ? left.name
        : "";
    const rightName =
      typeof right === "object" &&
      right !== null &&
      !Array.isArray(right) &&
      typeof right.name === "string"
        ? right.name
        : "";
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  return sorted.map((service) => {
    if (
      typeof service !== "object" ||
      service === null ||
      Array.isArray(service) ||
      (Object.keys(service).sort().join(",") !== "name,required,service" &&
        Object.keys(service).sort().join(",") !== "binding,name,required,service") ||
      typeof service.name !== "string" ||
      service.name.length === 0 ||
      service.name.length > 64 ||
      !/^[A-Z][A-Z0-9_]*$/u.test(service.name) ||
      typeof service.required !== "boolean" ||
      typeof service.service !== "object" ||
      service.service === null ||
      Array.isArray(service.service) ||
      Object.keys(service.service).sort().join(",") !== "apiVersion,protocol" ||
      service.service.apiVersion !== "standards.takoform.com/v1" ||
      typeof service.service.protocol !== "string" ||
      !isStableStandardServiceProtocol(service.service.protocol)
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    const hasBinding = Object.hasOwn(service, "binding");
    if (service.required && !hasBinding) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    let binding: SelfhostVersionExternalService["binding"];
    if (hasBinding) {
      if (
        typeof service.binding !== "object" ||
        service.binding === null ||
        Array.isArray(service.binding) ||
        Object.keys(service.binding).sort().join(",") !== "kind,value" ||
        service.binding.kind !== "json" ||
        typeof service.binding.value !== "string"
      ) {
        throw new SelfhostVersionBindingStoreError("corrupt");
      }
      validateExternalServiceJsonValue(service.binding.value);
      binding = { kind: "json", value: service.binding.value };
    }
    return {
      name: service.name,
      required: service.required,
      service: {
        apiVersion: "standards.takoform.com/v1" as const,
        protocol: service.service.protocol,
      },
      ...(binding === undefined ? {} : { binding }),
    };
  });
}

function normalizeActorBindings(
  bindings: readonly SelfhostVersionActorBinding[] | undefined,
  versionUid: string | undefined,
): readonly SelfhostVersionActorBinding[] | undefined {
  if (bindings === undefined && versionUid === undefined) return undefined;
  if (
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    bindings.length > 64 ||
    typeof versionUid !== "string" ||
    !RESOURCE_UID.test(versionUid)
  )
    throw new SelfhostVersionBindingStoreError("corrupt");
  const baseKeys = [
    "className",
    "name",
    "namespaceResourceUid",
    "tenantId",
    "workerResourceUid",
  ] as const;
  const sorted = bindings
    .map((candidate) => {
      const base = ownDataRecord(candidate, baseKeys);
      const withRuntimeClassRef = base
        ? undefined
        : ownDataRecord(candidate, [...baseKeys, "runtimeClassRef"]);
      const binding = base ?? withRuntimeClassRef;
      if (!binding) throw new SelfhostVersionBindingStoreError("corrupt");
      const runtimeClassRef = withRuntimeClassRef
        ? normalizeActorRuntimeClassRef(withRuntimeClassRef.runtimeClassRef)
        : undefined;
      if (
        typeof binding.name !== "string" ||
        binding.name.length > 64 ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(binding.name) ||
        typeof binding.tenantId !== "string" ||
        binding.tenantId.length === 0 ||
        binding.tenantId.length > 256 ||
        binding.tenantId.includes("\u0000") ||
        typeof binding.namespaceResourceUid !== "string" ||
        !RESOURCE_UID.test(binding.namespaceResourceUid) ||
        typeof binding.workerResourceUid !== "string" ||
        !RESOURCE_UID.test(binding.workerResourceUid) ||
        typeof binding.className !== "string" ||
        binding.className.length > 64 ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(binding.className)
      ) {
        throw new SelfhostVersionBindingStoreError("corrupt");
      }
      return {
        name: binding.name,
        tenantId: binding.tenantId,
        namespaceResourceUid: binding.namespaceResourceUid,
        workerResourceUid: binding.workerResourceUid,
        className: binding.className,
        ...(runtimeClassRef ? { runtimeClassRef } : {}),
      } satisfies SelfhostVersionActorBinding;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const names = new Set<string>();
  for (const binding of sorted) {
    if (names.has(binding.name)) throw new SelfhostVersionBindingStoreError("corrupt");
    names.add(binding.name);
  }
  return sorted;
}

/** Reads a closed own-data-property record without invoking input accessors. */
function ownDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    (ownKeys as string[]).sort().join(",") !== [...expectedKeys].sort().join(",")
  ) {
    return null;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function normalizeActorRuntimeClassRef(value: unknown): TakoformInterfaceRef {
  const record = ownDataRecord(value, ["apiVersion", "name", "schemaDigest", "version"]);
  if (
    !record ||
    typeof record.apiVersion !== "string" ||
    typeof record.name !== "string" ||
    typeof record.version !== "string" ||
    typeof record.schemaDigest !== "string"
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const parsed = parseActorAbiRef(record);
  if (!parsed) throw new SelfhostVersionBindingStoreError("corrupt");
  return parsed.ref;
}

function validateExternalServiceJsonValue(value: string): void {
  let parsed: unknown;
  try {
    const bytes = new TextEncoder().encode(value);
    // TextEncoder replaces lone UTF-16 surrogates; reject that lossy path so
    // the strict parser validates the exact string retained in the sidecar.
    if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) !== value) {
      throw new Error("external_service_json_not_unicode_scalar");
    }
    parsed = parseStrictJson(bytes, MAX_BYTES);
  } catch {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (!isJsonObject(parsed)) throw new SelfhostVersionBindingStoreError("corrupt");
}

function normalizeServiceBindings(
  bindings: readonly SelfhostVersionServiceBinding[],
): readonly SelfhostVersionServiceBinding[] {
  if (!Array.isArray(bindings)) throw new SelfhostVersionBindingStoreError("corrupt");
  const sorted = [...bindings].sort((left, right) => (left?.name < right?.name ? -1 : 1));
  if (sorted.length > 64) throw new SelfhostVersionBindingStoreError("corrupt");
  for (const binding of sorted) {
    if (
      typeof binding?.name !== "string" ||
      binding.name.length === 0 ||
      binding.name.length > 64 ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(binding.name) ||
      typeof binding.target !== "string" ||
      !SCRIPT_NAME.test(binding.target) ||
      typeof binding.targetResourceUid !== "string" ||
      !RESOURCE_UID.test(binding.targetResourceUid)
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
  }
  return sorted.map((binding) => ({
    name: binding.name,
    target: binding.target,
    targetResourceUid: binding.targetResourceUid,
  }));
}

/** The closed handler vocabulary, sorted, non-empty, without a duplicate. */
function normalizeHandlers(
  handlers: readonly SelfhostWorkerHandlerName[],
): readonly SelfhostWorkerHandlerName[] {
  if (!Array.isArray(handlers)) throw new SelfhostVersionBindingStoreError("corrupt");
  const sorted = [...handlers].sort();
  if (
    sorted.length === 0 ||
    sorted.length > SELFHOST_WORKER_HANDLER_NAMES.length ||
    new Set(sorted).size !== sorted.length ||
    sorted.some(
      (handler) => !(SELFHOST_WORKER_HANDLER_NAMES as readonly string[]).includes(handler),
    )
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return sorted;
}

/**
 * A data plane is present or it is not; an empty one is a contradiction.
 *
 * The wrapper module exists only to carry these bindings, so a version that
 * declares none must publish the same bytes it published before this Host could
 * project any. Refusing the empty shape here is what keeps that true.
 */
function normalizeDataPlane(plane: SelfhostVersionDataPlane): SelfhostVersionDataPlane {
  if (typeof plane !== "object" || plane === null || Array.isArray(plane)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (!Array.isArray(plane.bindings)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const bindings = [...plane.bindings].sort((left, right) => (left?.name < right?.name ? -1 : 1));
  if (
    bindings.length === 0 ||
    bindings.length > SELFHOST_VERSION_DATA_BINDING_KINDS.length * MAX_DATA_BINDINGS
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  for (const binding of bindings) {
    if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    if (
      typeof binding.name !== "string" ||
      binding.name.length === 0 ||
      binding.name.length > 64 ||
      !(SELFHOST_VERSION_DATA_BINDING_KINDS as readonly string[]).includes(binding.kind)
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    if (binding.kind === "edge.vector") {
      if (Object.keys(binding).sort().join(",") !== "kind,name,scope") {
        throw new SelfhostVersionBindingStoreError("corrupt");
      }
      normalizeVectorScope(binding.scope);
      continue;
    }
    if (
      typeof binding.target !== "string" ||
      binding.target.length === 0 ||
      binding.target.length > 512
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    // A queue binding carries its queue's promise; nothing else may.
    if ((binding.queue !== undefined) !== (binding.kind === "edge.queue")) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    if (binding.queue !== undefined) normalizeQueueSettings(binding.queue);
  }
  return {
    bindings: bindings.map((binding) => ({
      ...(binding.kind === "edge.vector"
        ? {
            kind: binding.kind,
            name: binding.name,
            scope: normalizeVectorScope(binding.scope),
          }
        : {
            kind: binding.kind,
            name: binding.name,
            target: binding.target,
            ...(binding.queue ? { queue: normalizeQueueSettings(binding.queue) } : {}),
          }),
    })),
  };
}

interface SelfhostVectorScope {
  readonly tenantId: string;
  readonly resourceUid: string;
}

const MAX_VECTOR_TENANT_ID_LENGTH = 255;
const MAX_VECTOR_RESOURCE_UID_LENGTH = 128;

/**
 * Vector storage scopes use the same bounded opaque strings as
 * `VectorIndexStore`. They are not parsed as script names or native IDs.
 */
function normalizeVectorScope(value: unknown): SelfhostVectorScope {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "resourceUid,tenantId"
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const scope = value as Record<string, unknown>;
  const tenantId = scope.tenantId;
  const resourceUid = scope.resourceUid;
  if (
    typeof tenantId !== "string" ||
    typeof resourceUid !== "string" ||
    !boundedCodePointString(tenantId, 1, MAX_VECTOR_TENANT_ID_LENGTH) ||
    !boundedCodePointString(resourceUid, 3, MAX_VECTOR_RESOURCE_UID_LENGTH) ||
    tenantId.includes("\u0000") ||
    resourceUid.includes("\u0000")
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return { tenantId, resourceUid };
}

function boundedCodePointString(value: string, minimum: number, maximum: number): boolean {
  const length = [...value].length;
  return length >= minimum && length <= maximum;
}

function normalizeQueueSettings(
  settings: SelfhostVersionQueueSettings,
): SelfhostVersionQueueSettings {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (Object.keys(settings).sort().join(",") !== "deliveryDelaySeconds,messageRetentionSeconds") {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const { messageRetentionSeconds, deliveryDelaySeconds } = settings;
  if (
    !Number.isSafeInteger(messageRetentionSeconds) ||
    messageRetentionSeconds < 60 ||
    messageRetentionSeconds > 1_209_600 ||
    !Number.isSafeInteger(deliveryDelaySeconds) ||
    deliveryDelaySeconds < 0 ||
    deliveryDelaySeconds > 43_200
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return { messageRetentionSeconds, deliveryDelaySeconds };
}

function normalizeBindings(
  bindings: readonly SelfhostVersionBinding[],
): readonly SelfhostVersionBinding[] {
  if (!Array.isArray(bindings)) throw new SelfhostVersionBindingStoreError("corrupt");
  const sorted = [...bindings].sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const binding of sorted) {
    if (
      typeof binding?.name !== "string" ||
      binding.name.length === 0 ||
      typeof binding.value !== "string" ||
      (binding.kind !== "text" && binding.kind !== "json")
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
  }
  return sorted.map((binding) => ({
    name: binding.name,
    value: binding.value,
    kind: binding.kind,
  }));
}

/**
 * Whether the stored record already IS the record for this set.
 *
 * `left.handlers === undefined` is a `@v1` record. It has no handler list, so
 * it cannot have committed to the one presented here; answering false rewrites
 * it in the current format and gives a Version with declared handlers the
 * event token an attachment needs.
 */
function sameBindings(
  left: StoredSelfhostVersionBindings,
  right: SelfhostVersionBindingSet,
): boolean {
  if (left.runtimeInputGeneration !== right.runtimeInputGeneration) return false;
  if (
    left.workerVersionResourceUid !== right.workerVersionResourceUid ||
    JSON.stringify(left.actorBindings ?? null) !== JSON.stringify(right.actorBindings ?? null) ||
    JSON.stringify(left.workflowBindings ?? null) !== JSON.stringify(right.workflowBindings ?? null)
  )
    return false;
  // A retained pre-v4 record stays byte-for-byte valid for a Version that did
  // not declare a service binding. Its owner UID is deliberately not inferred,
  // so it cannot become a worker.service target until a new Version is
  // published, but an unrelated reconcile must not rotate its tokens.
  if (left.workerResourceUid === undefined || left.serviceBindings === undefined) {
    return (
      right.serviceBindings.length === 0 &&
      left.handlers !== undefined &&
      JSON.stringify({
        handlers: left.handlers,
        vars: left.vars,
        sensitiveVars: left.sensitiveVars,
        externalServices: left.externalServices ?? null,
        dataPlane: left.dataPlane ?? null,
      }) ===
        JSON.stringify({
          handlers: right.handlers,
          vars: right.vars,
          sensitiveVars: right.sensitiveVars,
          externalServices: right.externalServices ?? null,
          dataPlane: right.dataPlane ?? null,
        })
    );
  }
  return (
    left.handlers !== undefined &&
    canonicalBindings({
      workerResourceUid: left.workerResourceUid,
      handlers: left.handlers,
      vars: left.vars,
      sensitiveVars: left.sensitiveVars,
      ...(left.runtimeInputGeneration
        ? { runtimeInputGeneration: left.runtimeInputGeneration }
        : {}),
      serviceBindings: left.serviceBindings,
      ...(left.workerVersionResourceUid
        ? { workerVersionResourceUid: left.workerVersionResourceUid }
        : {}),
      ...(left.actorBindings ? { actorBindings: left.actorBindings } : {}),
      ...(left.workflowBindings ? { workflowBindings: left.workflowBindings } : {}),
      ...(left.externalServices ? { externalServices: left.externalServices } : {}),
      ...(left.dataPlane ? { dataPlane: left.dataPlane } : {}),
    }) === canonicalBindings(right)
  );
}

function canonicalBindings(set: SelfhostVersionBindingSet): string {
  return JSON.stringify({
    workerResourceUid: set.workerResourceUid,
    handlers: set.handlers,
    vars: set.vars,
    sensitiveVars: set.sensitiveVars,
    ...(set.runtimeInputGeneration ? { runtimeInputGeneration: set.runtimeInputGeneration } : {}),
    serviceBindings: set.serviceBindings,
    workerVersionResourceUid: set.workerVersionResourceUid ?? null,
    actorBindings: set.actorBindings ?? null,
    ...(set.workflowBindings ? { workflowBindings: set.workflowBindings } : {}),
    externalServices: set.externalServices ?? null,
    dataPlane: set.dataPlane ?? null,
  });
}

type SelfhostVersionBindingFormat =
  | typeof FORMAT_V1
  | typeof FORMAT_V2
  | typeof FORMAT_V3
  | typeof FORMAT_V4
  | typeof FORMAT_V5
  | typeof FORMAT_V6
  | typeof FORMAT_V7
  | typeof FORMAT_V8
  | typeof FORMAT_V9
  | typeof FORMAT_V10;

function formatForSet(
  set: SelfhostVersionBindingSet,
):
  | typeof FORMAT_V4
  | typeof FORMAT_V5
  | typeof FORMAT_V6
  | typeof FORMAT_V7
  | typeof FORMAT_V8
  | typeof FORMAT_V9
  | typeof FORMAT_V10 {
  if (set.workflowBindings?.length) return FORMAT_V10;
  if (set.actorBindings?.some((binding) => binding.runtimeClassRef !== undefined)) return FORMAT_V9;
  if (set.actorBindings?.length) return FORMAT_V8;
  if (set.runtimeInputGeneration) return FORMAT_V7;
  if (hasVectorDataBinding(set)) return FORMAT_V6;
  return set.externalServices ? FORMAT_V5 : FORMAT_V4;
}

function hasVectorDataBinding(set: LegacySet | SelfhostVersionBindingSet): boolean {
  return set.dataPlane?.bindings.some((binding) => binding.kind === "edge.vector") ?? false;
}

/**
 * The exact bytes on disk, in one place, so `parseStored` can prove a record it
 * read back is the record this function would have written.
 *
 * Every format this Host has ever written is reproducible here, because that
 * proof is what tells a torn or tampered file from a good one. `@v1` and `@v2`
 * are read, never written: a machine published by an earlier build keeps
 * serving, and the next Version it publishes is written at `@v4`, `@v5`, or
 * `@v6` depending on whether it declares external services or a Vector scope.
 */
function canonicalRecord(
  format: SelfhostVersionBindingFormat,
  salt: string,
  set: SelfhostVersionBindingSet | LegacySet,
  planeToken: string | undefined,
  eventToken: string | undefined,
): string {
  const plane = set.dataPlane
    ? {
        bindings: set.dataPlane.bindings.map((binding) => {
          if (binding.kind === "edge.vector") {
            if (
              format !== FORMAT_V6 &&
              format !== FORMAT_V7 &&
              format !== FORMAT_V8 &&
              format !== FORMAT_V9 &&
              format !== FORMAT_V10
            ) {
              throw new SelfhostVersionBindingStoreError("corrupt");
            }
            return {
              kind: binding.kind,
              name: binding.name,
              scope: {
                tenantId: binding.scope.tenantId,
                resourceUid: binding.scope.resourceUid,
              },
            };
          }
          return {
            kind: binding.kind,
            name: binding.name,
            target: binding.target,
            ...(binding.queue
              ? {
                  queue: {
                    messageRetentionSeconds: binding.queue.messageRetentionSeconds,
                    deliveryDelaySeconds: binding.queue.deliveryDelaySeconds,
                  },
                }
              : {}),
          };
        }),
      }
    : undefined;
  if (format === FORMAT_V1) {
    return JSON.stringify({
      format: FORMAT_V1,
      salt,
      vars: set.vars,
      sensitiveVars: set.sensitiveVars,
    });
  }
  if (format === FORMAT_V2) {
    return JSON.stringify({
      format: FORMAT_V2,
      salt,
      vars: set.vars,
      sensitiveVars: set.sensitiveVars,
      dataPlane: { handlers: set.handlers, bindings: plane?.bindings },
      planeToken,
    });
  }
  if (format === FORMAT_V3) {
    return JSON.stringify({
      format: FORMAT_V3,
      salt,
      handlers: set.handlers,
      vars: set.vars,
      sensitiveVars: set.sensitiveVars,
      ...(plane ? { dataPlane: plane } : {}),
      ...(planeToken === undefined ? {} : { planeToken }),
      eventToken,
    });
  }
  const current = set as SelfhostVersionBindingSet;
  if (format === FORMAT_V4) {
    return JSON.stringify({
      format: FORMAT_V4,
      salt,
      workerResourceUid: current.workerResourceUid,
      handlers: current.handlers,
      vars: current.vars,
      sensitiveVars: current.sensitiveVars,
      serviceBindings: current.serviceBindings,
      ...(plane ? { dataPlane: plane } : {}),
      ...(planeToken === undefined ? {} : { planeToken }),
      eventToken,
    });
  }
  if (format === FORMAT_V5) {
    return JSON.stringify({
      format: FORMAT_V5,
      salt,
      workerResourceUid: current.workerResourceUid,
      handlers: current.handlers,
      vars: current.vars,
      sensitiveVars: current.sensitiveVars,
      serviceBindings: current.serviceBindings,
      externalServices: current.externalServices,
      ...(plane ? { dataPlane: plane } : {}),
      ...(planeToken === undefined ? {} : { planeToken }),
      eventToken,
    });
  }
  if (format === FORMAT_V10) {
    return JSON.stringify({
      format: FORMAT_V10,
      salt,
      ...(current.runtimeInputGeneration
        ? { runtimeInputGeneration: current.runtimeInputGeneration }
        : {}),
      workerResourceUid: current.workerResourceUid,
      workerVersionResourceUid: current.workerVersionResourceUid,
      ...(current.actorBindings ? { actorBindings: current.actorBindings } : {}),
      workflowBindings: current.workflowBindings,
      handlers: current.handlers,
      vars: current.vars,
      sensitiveVars: current.sensitiveVars,
      serviceBindings: current.serviceBindings,
      externalServices: current.externalServices ?? [],
      ...(plane ? { dataPlane: plane } : {}),
      ...(planeToken === undefined ? {} : { planeToken }),
      eventToken,
    });
  }
  return JSON.stringify({
    format,
    salt,
    ...(format === FORMAT_V7 ||
    ((format === FORMAT_V8 || format === FORMAT_V9) && current.runtimeInputGeneration)
      ? { runtimeInputGeneration: current.runtimeInputGeneration }
      : {}),
    workerResourceUid: current.workerResourceUid,
    ...(format === FORMAT_V8 || format === FORMAT_V9
      ? {
          workerVersionResourceUid: current.workerVersionResourceUid,
          actorBindings: current.actorBindings,
        }
      : {}),
    handlers: current.handlers,
    vars: current.vars,
    sensitiveVars: current.sensitiveVars,
    serviceBindings: current.serviceBindings,
    externalServices: current.externalServices ?? [],
    ...(plane ? { dataPlane: plane } : {}),
    ...(planeToken === undefined ? {} : { planeToken }),
    eventToken,
  });
}

/** What a record read back carries, before it is proved to be one. */
interface LegacySet {
  readonly runtimeInputGeneration?: string;
  readonly workerResourceUid?: string;
  readonly workerVersionResourceUid?: string;
  readonly actorBindings?: readonly SelfhostVersionActorBinding[];
  readonly workflowBindings?: readonly SelfhostVersionWorkflowBinding[];
  readonly handlers?: readonly SelfhostWorkerHandlerName[];
  readonly vars: readonly SelfhostVersionBinding[];
  readonly sensitiveVars: readonly SelfhostVersionBinding[];
  readonly serviceBindings?: readonly SelfhostVersionServiceBinding[];
  readonly externalServices?: readonly SelfhostVersionExternalService[];
  readonly dataPlane?: SelfhostVersionDataPlane;
}

/**
 * A salted commitment rather than a plain hash of the values. The digest is
 * placed in the runtime generation, which is written to a manifest a workerd
 * reload reads; an unsalted SHA-256 of a short secret is guessable, and a
 * generation string is not a place to put one.
 */
function digestOf(
  format: SelfhostVersionBindingFormat,
  salt: string,
  set: SelfhostVersionBindingSet | LegacySet,
  planeToken: string | undefined,
  eventToken: string | undefined,
): `sha256:${string}` {
  const record = canonicalRecord(format, salt, set, planeToken, eventToken);
  return `sha256:${createHash("sha256").update(record, "utf8").digest("hex")}`;
}

function parseStored(bytes: Uint8Array): StoredSelfhostVersionBindings {
  // The file has no independently pinned expected digest. Canonical parsing
  // rejects malformed or unselected refs, while a valid scope substitution
  // necessarily produces a new digest and derived relation token; this is not
  // an authentication check for canonical file tampering.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  const format =
    record.format === FORMAT_V1 && keys === "format,salt,sensitiveVars,vars"
      ? FORMAT_V1
      : record.format === FORMAT_V2 &&
          keys === "dataPlane,format,planeToken,salt,sensitiveVars,vars"
        ? FORMAT_V2
        : record.format === FORMAT_V3 && isVersion3Keys(keys)
          ? FORMAT_V3
          : record.format === FORMAT_V4 && isVersion4Keys(keys)
            ? FORMAT_V4
            : record.format === FORMAT_V5 && isVersion5Keys(keys)
              ? FORMAT_V5
              : record.format === FORMAT_V6 && isVersion6Keys(keys)
                ? FORMAT_V6
                : record.format === FORMAT_V7 && isVersion7Keys(keys)
                  ? FORMAT_V7
                  : record.format === FORMAT_V8 && isVersion8Keys(keys)
                    ? FORMAT_V8
                    : record.format === FORMAT_V9 && isVersion9Keys(keys)
                      ? FORMAT_V9
                      : record.format === FORMAT_V10 && isVersion10Keys(keys)
                        ? FORMAT_V10
                        : null;
  if (
    format === null ||
    typeof record.salt !== "string" ||
    decodedLength(record.salt) !== SALT_BYTES
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const hasPlane =
    format === FORMAT_V2 ||
    ((format === FORMAT_V3 ||
      format === FORMAT_V4 ||
      format === FORMAT_V5 ||
      format === FORMAT_V6 ||
      format === FORMAT_V7 ||
      format === FORMAT_V8 ||
      format === FORMAT_V9 ||
      format === FORMAT_V10) &&
      "dataPlane" in record);
  const planeToken = format === FORMAT_V1 ? undefined : (record.planeToken as unknown);
  if (
    hasPlane &&
    (typeof planeToken !== "string" || decodedLength(planeToken) !== PLANE_TOKEN_BYTES)
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const eventToken =
    format === FORMAT_V3 ||
    format === FORMAT_V4 ||
    format === FORMAT_V5 ||
    format === FORMAT_V6 ||
    format === FORMAT_V7 ||
    format === FORMAT_V8 ||
    format === FORMAT_V9 ||
    format === FORMAT_V10
      ? record.eventToken
      : undefined;
  if (
    (format === FORMAT_V3 ||
      format === FORMAT_V4 ||
      format === FORMAT_V5 ||
      format === FORMAT_V6 ||
      format === FORMAT_V7 ||
      format === FORMAT_V8 ||
      format === FORMAT_V9 ||
      format === FORMAT_V10) &&
    (typeof eventToken !== "string" || decodedLength(eventToken) !== EVENT_TOKEN_BYTES)
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  // `@v2` kept the handlers inside the data plane; `@v3` keeps them beside it,
  // because a Version with no binding declares them too.
  const legacyPlane = format === FORMAT_V2 ? parsedLegacyDataPlane(record.dataPlane) : null;
  const handlers =
    format === FORMAT_V3 ||
    format === FORMAT_V4 ||
    format === FORMAT_V5 ||
    format === FORMAT_V6 ||
    format === FORMAT_V7 ||
    format === FORMAT_V8 ||
    format === FORMAT_V9 ||
    format === FORMAT_V10
      ? normalizeHandlers(parsedHandlers(record.handlers))
      : legacyPlane
        ? normalizeHandlers(legacyPlane.handlers)
        : undefined;
  const set = normalizeSetOrLegacy({
    ...(format === FORMAT_V4 ||
    format === FORMAT_V5 ||
    format === FORMAT_V6 ||
    format === FORMAT_V7 ||
    format === FORMAT_V8 ||
    format === FORMAT_V9 ||
    format === FORMAT_V10
      ? {
          workerResourceUid: parsedResourceUid(record.workerResourceUid),
          serviceBindings: parsedServiceBindings(record.serviceBindings),
        }
      : {}),
    ...(format === FORMAT_V8 || format === FORMAT_V9
      ? {
          workerVersionResourceUid: parsedResourceUid(record.workerVersionResourceUid),
          actorBindings: parsedActorBindings(record.actorBindings, format === FORMAT_V9),
        }
      : {}),
    ...(format === FORMAT_V10
      ? {
          workerVersionResourceUid: parsedResourceUid(record.workerVersionResourceUid),
          ...(record.actorBindings === undefined
            ? {}
            : { actorBindings: parsedActorBindings(record.actorBindings, true) }),
          workflowBindings: parsedWorkflowBindings(record.workflowBindings),
        }
      : {}),
    ...(handlers ? { handlers } : {}),
    vars: parsedBindings(record.vars),
    sensitiveVars: parsedBindings(record.sensitiveVars),
    ...((format === FORMAT_V7 ||
      format === FORMAT_V8 ||
      format === FORMAT_V9 ||
      format === FORMAT_V10) &&
    record.runtimeInputGeneration !== undefined
      ? { runtimeInputGeneration: parsedRuntimeInputGeneration(record.runtimeInputGeneration) }
      : {}),
    ...(hasPlane
      ? {
          dataPlane: parsedDataPlane(
            format === FORMAT_V2 ? { bindings: legacyPlane?.bindings } : record.dataPlane,
            format === FORMAT_V6 ||
              format === FORMAT_V7 ||
              format === FORMAT_V8 ||
              format === FORMAT_V9 ||
              format === FORMAT_V10,
          ),
        }
      : {}),
    ...(format === FORMAT_V5 ||
    format === FORMAT_V6 ||
    format === FORMAT_V7 ||
    format === FORMAT_V8 ||
    format === FORMAT_V9 ||
    format === FORMAT_V10
      ? { externalServices: parsedExternalServices(record.externalServices) }
      : {}),
  });
  // `@v6` is reserved for the new scoped Vector entry. A record that claims
  // the format without one is neither a v5 record nor a valid v6 record.
  if (format === FORMAT_V6 && !hasVectorDataBinding(set)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (format === FORMAT_V7 && set.sensitiveVars.length === 0) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (
    (format === FORMAT_V8 || format === FORMAT_V9) &&
    set.sensitiveVars.length > 0 !== Boolean(set.runtimeInputGeneration)
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (
    (format === FORMAT_V8 && set.actorBindings?.some((binding) => binding.runtimeClassRef)) ||
    (format === FORMAT_V9 && !set.actorBindings?.some((binding) => binding.runtimeClassRef))
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (
    canonicalRecord(
      format,
      record.salt,
      set,
      planeToken as string | undefined,
      eventToken as string | undefined,
    ) !== decodeUtf8(bytes)
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return {
    ...set,
    digest: digestOf(
      format,
      record.salt,
      set,
      planeToken as string | undefined,
      eventToken as string | undefined,
    ),
    ...(typeof planeToken === "string" ? { planeToken } : {}),
    ...(typeof eventToken === "string" ? { eventToken } : {}),
  };
}

/** A `@v3` record with or without its optional data plane and plane token. */
function isVersion3Keys(keys: string): boolean {
  return (
    keys === "eventToken,format,handlers,salt,sensitiveVars,vars" ||
    keys === "dataPlane,eventToken,format,handlers,planeToken,salt,sensitiveVars,vars"
  );
}

/** A `@v4` record always states identity and the complete service list. */
function isVersion4Keys(keys: string): boolean {
  return (
    keys ===
      "eventToken,format,handlers,salt,sensitiveVars,serviceBindings,vars,workerResourceUid" ||
    keys ===
      "dataPlane,eventToken,format,handlers,planeToken,salt,sensitiveVars,serviceBindings,vars,workerResourceUid"
  );
}

/** A `@v5` record always carries at least one external service declaration. */
function isVersion5Keys(keys: string): boolean {
  return (
    keys ===
      "eventToken,externalServices,format,handlers,salt,sensitiveVars,serviceBindings,vars,workerResourceUid" ||
    keys ===
      "dataPlane,eventToken,externalServices,format,handlers,planeToken,salt,sensitiveVars,serviceBindings,vars,workerResourceUid"
  );
}

/** A `@v6` record carries the v5 fields and always serializes services as an array. */
function isVersion6Keys(keys: string): boolean {
  return (
    keys ===
      "eventToken,externalServices,format,handlers,salt,sensitiveVars,serviceBindings,vars,workerResourceUid" ||
    keys ===
      "dataPlane,eventToken,externalServices,format,handlers,planeToken,salt,sensitiveVars,serviceBindings,vars,workerResourceUid"
  );
}

function isVersion7Keys(keys: string): boolean {
  return (
    keys ===
      "eventToken,externalServices,format,handlers,runtimeInputGeneration,salt,sensitiveVars,serviceBindings,vars,workerResourceUid" ||
    keys ===
      "dataPlane,eventToken,externalServices,format,handlers,planeToken,runtimeInputGeneration,salt,sensitiveVars,serviceBindings,vars,workerResourceUid"
  );
}

function isVersion8Keys(keys: string): boolean {
  const required = [
    "actorBindings",
    "eventToken",
    "externalServices",
    "format",
    "handlers",
    "salt",
    "sensitiveVars",
    "serviceBindings",
    "vars",
    "workerResourceUid",
    "workerVersionResourceUid",
  ];
  for (const runtimeInput of [false, true]) {
    for (const plane of [false, true]) {
      const expected = [
        ...required,
        ...(runtimeInput ? ["runtimeInputGeneration"] : []),
        ...(plane ? ["dataPlane", "planeToken"] : []),
      ];
      if (keys === expected.sort().join(",")) return true;
    }
  }
  return false;
}

/** `@v9` keeps the V8 envelope and adds the ref only inside selected Actor entries. */
function isVersion9Keys(keys: string): boolean {
  return isVersion8Keys(keys);
}

function isVersion10Keys(keys: string): boolean {
  const required = [
    "eventToken",
    "externalServices",
    "format",
    "handlers",
    "salt",
    "sensitiveVars",
    "serviceBindings",
    "vars",
    "workerResourceUid",
    "workerVersionResourceUid",
    "workflowBindings",
  ];
  for (const runtimeInput of [false, true]) {
    for (const actorBindings of [false, true]) {
      for (const plane of [false, true]) {
        const expected = [
          ...required,
          ...(runtimeInput ? ["runtimeInputGeneration"] : []),
          ...(actorBindings ? ["actorBindings"] : []),
          ...(plane ? ["dataPlane", "planeToken"] : []),
        ];
        if (keys === expected.sort().join(",")) return true;
      }
    }
  }
  return false;
}

function parsedRuntimeInputGeneration(value: unknown): string {
  if (typeof value !== "string" || !LEASE_GENERATION.test(value)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return value;
}

function parsedResourceUid(value: unknown): string {
  if (typeof value !== "string" || !RESOURCE_UID.test(value)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return value;
}

function parsedServiceBindings(value: unknown): readonly SelfhostVersionServiceBinding[] {
  if (!Array.isArray(value)) throw new SelfhostVersionBindingStoreError("corrupt");
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "name,target,targetResourceUid"
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    return entry as unknown as SelfhostVersionServiceBinding;
  });
}

function parsedActorBindings(
  value: unknown,
  allowRuntimeClassRef: boolean,
): readonly SelfhostVersionActorBinding[] {
  if (!Array.isArray(value)) throw new SelfhostVersionBindingStoreError("corrupt");
  const baseKeys = [
    "className",
    "name",
    "namespaceResourceUid",
    "tenantId",
    "workerResourceUid",
  ] as const;
  for (const entry of value) {
    const base = ownDataRecord(entry, baseKeys);
    const withRuntimeClassRef = allowRuntimeClassRef
      ? ownDataRecord(entry, [...baseKeys, "runtimeClassRef"])
      : null;
    if (!base && !withRuntimeClassRef) throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return value as readonly SelfhostVersionActorBinding[];
}

function parsedWorkflowBindings(value: unknown): readonly SelfhostVersionWorkflowBinding[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return value as readonly SelfhostVersionWorkflowBinding[];
}

function parsedExternalServices(value: unknown): readonly SelfhostVersionExternalService[] {
  if (!Array.isArray(value)) throw new SelfhostVersionBindingStoreError("corrupt");
  return value as readonly SelfhostVersionExternalService[];
}

function parsedHandlers(value: unknown): readonly SelfhostWorkerHandlerName[] {
  if (!Array.isArray(value)) throw new SelfhostVersionBindingStoreError("corrupt");
  for (const entry of value) {
    if (typeof entry !== "string") throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return value as readonly SelfhostWorkerHandlerName[];
}

/** Normalizes a set that may predate handlers, without inventing any. */
function normalizeSetOrLegacy(set: LegacySet): LegacySet {
  const handlers = normalizeHandlers(set.handlers ?? ["fetch"]);
  const vars = normalizeBindings(set.vars);
  const sensitiveVars = normalizeBindings(set.sensitiveVars);
  const dataPlane = set.dataPlane === undefined ? undefined : normalizeDataPlane(set.dataPlane);
  const serviceBindings =
    set.serviceBindings === undefined ? undefined : normalizeServiceBindings(set.serviceBindings);
  const workflowBindings = normalizeWorkflowBindings(set.workflowBindings);
  if (
    set.workerVersionResourceUid !== undefined &&
    (typeof set.workerVersionResourceUid !== "string" ||
      !RESOURCE_UID.test(set.workerVersionResourceUid))
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (workflowBindings && !set.workerVersionResourceUid) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const actorBindings = normalizeActorBindings(
    set.actorBindings,
    set.actorBindings === undefined ? undefined : set.workerVersionResourceUid,
  );
  const externalServices = normalizeExternalServices(set.externalServices);
  if (
    set.workerResourceUid !== undefined &&
    (typeof set.workerResourceUid !== "string" || !RESOURCE_UID.test(set.workerResourceUid))
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const names = new Set<string>();
  for (const name of [
    ...vars.map((binding) => binding.name),
    ...sensitiveVars.map((binding) => binding.name),
    ...(dataPlane?.bindings ?? []).map((binding) => binding.name),
    ...(serviceBindings ?? []).map((binding) => binding.name),
    ...(actorBindings ?? []).map((binding) => binding.name),
    ...(workflowBindings ?? []).map((binding) => binding.name),
    ...(externalServices ?? []).map((binding) => binding.name),
  ]) {
    if (names.has(name)) throw new SelfhostVersionBindingStoreError("corrupt");
    names.add(name);
  }
  return {
    ...(set.runtimeInputGeneration
      ? { runtimeInputGeneration: parsedRuntimeInputGeneration(set.runtimeInputGeneration) }
      : {}),
    ...(set.workerResourceUid ? { workerResourceUid: set.workerResourceUid } : {}),
    ...(set.handlers ? { handlers } : {}),
    vars,
    sensitiveVars,
    ...(serviceBindings ? { serviceBindings } : {}),
    ...(actorBindings
      ? { workerVersionResourceUid: set.workerVersionResourceUid, actorBindings }
      : {}),
    ...(workflowBindings
      ? { workerVersionResourceUid: set.workerVersionResourceUid, workflowBindings }
      : {}),
    ...(externalServices ? { externalServices } : {}),
    ...(dataPlane ? { dataPlane } : {}),
  };
}

/** The `@v2` data plane, whose handlers travelled inside it. */
function parsedLegacyDataPlane(value: unknown): {
  readonly handlers: readonly SelfhostWorkerHandlerName[];
  readonly bindings: readonly SelfhostVersionDataBinding[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const plane = value as Record<string, unknown>;
  if (Object.keys(plane).sort().join(",") !== "bindings,handlers") {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return {
    handlers: parsedHandlers(plane.handlers),
    bindings: parsedDataPlane({ bindings: plane.bindings }).bindings,
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function parsedDataPlane(value: unknown, allowVector = false): SelfhostVersionDataPlane {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const plane = value as Record<string, unknown>;
  if (Object.keys(plane).sort().join(",") !== "bindings") {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (!Array.isArray(plane.bindings)) throw new SelfhostVersionBindingStoreError("corrupt");
  for (const entry of plane.bindings) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    const keys = Object.keys(entry as Record<string, unknown>)
      .sort()
      .join(",");
    const isLegacyEntry = keys === "kind,name,target" || keys === "kind,name,queue,target";
    const isVectorEntry = allowVector && keys === "kind,name,scope" && entry.kind === "edge.vector";
    if (!isLegacyEntry && !isVectorEntry) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
  }
  return plane as unknown as SelfhostVersionDataPlane;
}

function parsedBindings(value: unknown): readonly SelfhostVersionBinding[] {
  if (!Array.isArray(value)) throw new SelfhostVersionBindingStoreError("corrupt");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    const binding = entry as Record<string, unknown>;
    if (Object.keys(binding).sort().join(",") !== "kind,name,value") {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    return binding as unknown as SelfhostVersionBinding;
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodedLength(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return -1;
  const remainder = value.length % 4;
  if (remainder === 1) return -1;
  return Math.floor((value.length * 3) / 4);
}

function directorySyncUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "ENOSYS" ||
    (process.platform === "win32" && (code === "EPERM" || code === "EISDIR"))
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
