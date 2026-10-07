import { canonicalJson } from "../json.ts";
import type { JsonObject, Sql } from "../ports.ts";
import type { V2QueueProducerBindingGrant } from "../providers/selfhost-v2-queue-producer-broker.ts";
import type { V2SqliteBindingGrant } from "../providers/selfhost-v2-sqlite-binding-broker.ts";
import type { WorkerdRuntime } from "../workerd-runtime.ts";
import {
  AT_LEAST_ONCE_QUEUE_FORM_URL,
  parseAtLeastOnceQueueSpec,
} from "./forms/at-least-once-queue.ts";
import {
  EDGE_KV_NAMESPACE_FORM_URL,
  EDGE_KV_NAMESPACE_LIMITS,
  parseEdgeKVNamespaceSpec,
} from "./forms/edge-kv-namespace.ts";
import { EDGE_KV_NAMESPACE_BACKEND_ID } from "./forms/edge-kv-namespace-backend.ts";
import type { KvWorkerBindingClaim } from "./forms/kv-worker-binding-authority.ts";
import {
  OBJECT_BUCKET_FORM_URL,
  OBJECT_BUCKET_LIMITS,
  parseObjectBucketSpec,
} from "./forms/object-bucket.ts";
import { OBJECT_BUCKET_BACKEND_ID } from "./forms/object-bucket-backend.ts";
import type { ObjectBucketWorkerBindingClaim } from "./forms/object-bucket-worker-binding-authority.ts";
import type { QueueWorkerBindingClaim } from "./forms/queue-worker-binding-authority.ts";
import { parseSQLiteDatabaseSpec, SQLITE_DATABASE_FORM_URL } from "./forms/sqlite-database.ts";
import type { SQLiteWorkerBindingClaim } from "./forms/sqlite-worker-binding-authority.ts";
import { referencesForWorkerVersion } from "./forms/worker-references.ts";
import {
  parseWorkerVersionSpec,
  validateWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
  type WorkerVersionSpec,
} from "./forms/worker-specs.ts";
import {
  currentClaim,
  retired,
  unresolved,
  type V2WorkerRetirementReader,
  validated,
} from "./module-worker-lifecycle-backend.ts";
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "./types.ts";
import { snapshotV2WorkerPrivateInputs } from "./worker-code-eligibility.ts";
import {
  inspectV2WorkerCodeVersionEligibility,
  type V2ResolvedKvBinding,
  type V2ResolvedObjectBucketBinding,
  type V2ResolvedQueueProducerBinding,
  type V2ResolvedSqliteBinding,
} from "./worker-code-runtime.ts";
import type { V2WorkerVersionResolution } from "./worker-publication-state.ts";
import { projectV2ResolvedServiceBindings } from "./worker-service-resolution.ts";
import { projectV2StaticWorkerVersion } from "./worker-static-runtime.ts";

const V2_QUEUE_BACKEND_ID = "selfhost-v2-at-least-once-queue-sql-v1";

import type {
  createV2WorkerVersionConfiguredInputSealer,
  V2WorkerVersionSealedInputs,
} from "./worker-version-configured-inputs.ts";

export {
  createInternalV2ModuleWorkerForm,
  MODULE_WORKER_LIFECYCLE_BACKEND_ID,
  type V2WorkerRetirementProof,
  type V2WorkerRetirementReader,
  type V2WorkerRetirementTarget,
  type V2WorkerServingReader,
} from "./module-worker-lifecycle-backend.ts";

export const WORKER_VERSION_LIFECYCLE_BACKEND_ID = "selfhost-v2-static-worker-version-v1";
export const WORKER_CODE_VERSION_LIFECYCLE_BACKEND_ID = "selfhost-v2-code-worker-version-v1";
export const WORKER_VERSION_UNIFIED_BACKEND_ID = "selfhost-v2-worker-version-v1";

type VersionState = {
  resolveVersion(input: { execution: V2Execution }): Promise<V2WorkerVersionResolution>;
};

function staticOnly(spec: WorkerVersionSpec): WorkerVersionSpec {
  // Keep the existing backend explicitly static-only. Code eligibility has a
  // separate internal constructor and backend identity.
  if (spec.bundle !== undefined) throw new TakoformV2Error("capability_required", 422);
  return spec;
}

function codeOnly(
  spec: WorkerVersionSpec,
  configuredInputs: boolean,
  queueSettlement: V2CodeQueueSettlementBoot | undefined,
  sqliteBinding: V2CodeSqliteBindingBoot | undefined,
  objectBucketBinding: V2CodeObjectBucketBindingBoot | undefined,
  kvBinding: V2CodeKvBindingBoot | undefined,
  queueProducerBinding: V2CodeQueueProducerBindingBoot | undefined,
  actorBinding: V2CodeActorBindingAuthority | undefined,
): WorkerVersionSpec {
  if (
    !spec.bundle ||
    spec.handlers.some(
      (handler) => handler !== "fetch" && handler !== "scheduled" && handler !== "queue",
    ) ||
    (spec.handlers.includes("queue") && !queueSettlement) ||
    (spec.requiredSensitiveVars.length > 0 && !configuredInputs) ||
    (spec.kvBindings.length > 0 && !kvBinding) ||
    (spec.sqliteBindings.length > 0 && !sqliteBinding) ||
    (spec.bucketBindings.length > 0 && !objectBucketBinding) ||
    (spec.queueProducerBindings.length > 0 && !queueProducerBinding) ||
    (spec.actorBindings.length > 0 && !actorBinding) ||
    spec.workflowBindings.length > 0
  ) {
    throw new TakoformV2Error("capability_required", 422);
  }
  return spec;
}

/** The real accepted SQL/physical namespace authority, shared with native publication. */
export interface V2CodeActorBindingAuthority {
  resolveTarget(input: {
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
    readonly workerUid: string;
    readonly namespaceResourceUid: string;
  }): Promise<{ readonly className: string; readonly vector: string } | null>;
}

type ConfiguredInputSealer = ReturnType<typeof createV2WorkerVersionConfiguredInputSealer>;

/** The initialized Host-private Queue plane shared with the native owner. */
export interface V2CodeQueueSettlementBoot {
  readonly address: string;
  queueIdForUid(queueUid: string): string;
  bindingToken(input: {
    readonly workerUid: string;
    readonly versionId: string;
    readonly servingSourceOperationId: string;
  }): string;
}

/** Same private broker and accepted-graph reader used by native publication. */
export interface V2CodeQueueProducerBindingBoot {
  readonly address: string;
  issueGrant(grant: V2QueueProducerBindingGrant): string;
  resolveCurrentBinding(
    claim: QueueWorkerBindingClaim,
    binding: string,
  ): Promise<{
    readonly identity: { readonly resourceUid: string };
    readonly vector: string;
  } | null>;
}

/** The initialized Host-private SQLite broker and current-binding authority. */
export interface V2CodeSqliteBindingBoot {
  readonly address: string;
  issueGrant(grant: V2SqliteBindingGrant): string;
  resolveCurrentBinding(
    claim: SQLiteWorkerBindingClaim,
    binding: string,
  ): Promise<{ readonly resourceUid: string; readonly vector: string } | null>;
}

/**
 * Exact Host-private ObjectBucket broker and Core reader shared with publication.
 * A declaration alone cannot pass WorkerVersion validation without this port.
 */
export interface V2CodeObjectBucketBindingBoot {
  readonly address: string;
  issueGrant(grant: ObjectBucketWorkerBindingClaim): string;
  resolveCurrentBucketBinding(
    claim: ObjectBucketWorkerBindingClaim,
    binding: string,
  ): Promise<{
    readonly identity: {
      readonly targetKey: string;
      readonly principal: string;
      readonly space: string;
      readonly resourceUid: string;
    };
    readonly vector: string;
  } | null>;
}

/** Initialized Host-private KV broker and exact same-target Core reader. */
export interface V2CodeKvBindingBoot {
  readonly address: string;
  issueGrant(grant: KvWorkerBindingClaim): string;
  resolveCurrentBinding(
    claim: KvWorkerBindingClaim,
    binding: string,
  ): Promise<{
    readonly identity: {
      readonly targetKey: string;
      readonly principal: string;
      readonly space: string;
      readonly resourceUid: string;
    };
    readonly vector: string;
  } | null>;
}

function validQueueSettlementBoot(value: V2CodeQueueSettlementBoot): boolean {
  if (!value || typeof value.address !== "string") return false;
  const port = value.address.slice(value.address.lastIndexOf(":") + 1);
  return (
    /^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(value.address) &&
    Number(port) <= 65_535 &&
    typeof value.queueIdForUid === "function" &&
    typeof value.bindingToken === "function"
  );
}

function validSqliteBindingBoot(value: V2CodeSqliteBindingBoot): boolean {
  if (!value || typeof value.address !== "string") return false;
  const port = value.address.slice(value.address.lastIndexOf(":") + 1);
  return (
    /^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(value.address) &&
    Number(port) <= 65_535 &&
    typeof value.issueGrant === "function" &&
    typeof value.resolveCurrentBinding === "function"
  );
}

function validObjectBucketBindingBoot(value: V2CodeObjectBucketBindingBoot): boolean {
  if (!value || typeof value.address !== "string") return false;
  const port = value.address.slice(value.address.lastIndexOf(":") + 1);
  return (
    /^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(value.address) &&
    Number(port) <= 65_535 &&
    typeof value.issueGrant === "function" &&
    typeof value.resolveCurrentBucketBinding === "function"
  );
}

function validKvBindingBoot(value: V2CodeKvBindingBoot): boolean {
  if (!value || typeof value.address !== "string") return false;
  const port = value.address.slice(value.address.lastIndexOf(":") + 1);
  return (
    /^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(value.address) &&
    Number(port) <= 65_535 &&
    typeof value.issueGrant === "function" &&
    typeof value.resolveCurrentBinding === "function"
  );
}

function validQueueProducerBindingBoot(value: V2CodeQueueProducerBindingBoot): boolean {
  if (!value || typeof value.address !== "string") return false;
  const port = value.address.slice(value.address.lastIndexOf(":") + 1);
  return (
    /^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(value.address) &&
    Number(port) <= 65_535 &&
    typeof value.issueGrant === "function" &&
    typeof value.resolveCurrentBinding === "function"
  );
}

async function resolvedQueueProducerBindings(
  sql: Sql,
  spec: WorkerVersionSpec,
  identity: { readonly principal: string; readonly space: string; readonly targetKey: string },
): Promise<readonly V2ResolvedQueueProducerBinding[] | null> {
  const resolved: V2ResolvedQueueProducerBinding[] = [];
  for (const binding of spec.queueProducerBindings) {
    const rows = await sql.query(
      `SELECT r.spec_json, r.observed_json, r.output_json FROM tf_v2_resources r
       JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND r.backend_id = ? AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.action IN ('create','update')
         AND op.accepted_spec_json = r.spec_json`,
      [
        binding.resource.resourceUid,
        AT_LEAST_ONCE_QUEUE_FORM_URL,
        identity.principal,
        identity.space,
        identity.targetKey,
        V2_QUEUE_BACKEND_ID,
      ],
    );
    const row = rows.length === 1 ? rows[0] : null;
    if (
      !row ||
      typeof row.spec_json !== "string" ||
      typeof row.observed_json !== "string" ||
      typeof row.output_json !== "string"
    )
      return null;
    try {
      parseAtLeastOnceQueueSpec(JSON.parse(row.spec_json));
      if (
        canonicalJson(JSON.parse(row.observed_json)) !== canonicalJson({ queueExists: true }) ||
        canonicalJson(JSON.parse(row.output_json)) !== "{}"
      )
        return null;
    } catch {
      return null;
    }
    resolved.push({ name: binding.name, resourceUid: binding.resource.resourceUid });
  }
  return resolved;
}

async function resolvedSqliteBindings(
  sql: Sql,
  spec: WorkerVersionSpec,
  identity: { readonly principal: string; readonly space: string; readonly targetKey: string },
): Promise<readonly V2ResolvedSqliteBinding[] | null> {
  const resolved: V2ResolvedSqliteBinding[] = [];
  for (const binding of spec.sqliteBindings) {
    const rows = await sql.query(
      `SELECT r.spec_json, r.observed_json FROM tf_v2_resources r
       JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.accepted_spec_json = r.spec_json`,
      [
        binding.resource.resourceUid,
        SQLITE_DATABASE_FORM_URL,
        identity.principal,
        identity.space,
        identity.targetKey,
      ],
    );
    const row = rows.length === 1 ? rows[0] : null;
    if (typeof row?.spec_json !== "string" || typeof row.observed_json !== "string") return null;
    try {
      parseSQLiteDatabaseSpec(JSON.parse(row.spec_json));
      if (JSON.parse(row.observed_json)?.databaseExists !== true) return null;
    } catch {
      return null;
    }
    resolved.push({ name: binding.name, resourceUid: binding.resource.resourceUid });
  }
  return resolved;
}

/**
 * A Bucket declaration is usable only after the exact same-target UID is
 * durably observed by the ObjectBucket Form. The sealed Version references
 * and this observation are then fenced by publicationState.stillCurrent().
 */
async function resolvedObjectBucketBindings(
  sql: Sql,
  spec: WorkerVersionSpec,
  identity: { readonly principal: string; readonly space: string; readonly targetKey: string },
): Promise<readonly V2ResolvedObjectBucketBinding[] | null> {
  const resolved: V2ResolvedObjectBucketBinding[] = [];
  for (const binding of spec.bucketBindings) {
    const rows = await sql.query(
      `SELECT r.spec_json, r.observed_json, r.output_json, r.backend_id
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND r.backend_id = ? AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.action IN ('create', 'update')
         AND op.accepted_spec_json = r.spec_json`,
      [
        binding.resource.resourceUid,
        OBJECT_BUCKET_FORM_URL,
        identity.principal,
        identity.space,
        identity.targetKey,
        OBJECT_BUCKET_BACKEND_ID,
      ],
    );
    const row = rows.length === 1 ? rows[0] : null;
    if (
      typeof row?.spec_json !== "string" ||
      typeof row.observed_json !== "string" ||
      typeof row.output_json !== "string" ||
      row.backend_id !== OBJECT_BUCKET_BACKEND_ID
    ) {
      return null;
    }
    try {
      parseObjectBucketSpec(JSON.parse(row.spec_json));
      if (
        canonicalJson(JSON.parse(row.observed_json)) !==
          canonicalJson({ bucketExists: true, ...OBJECT_BUCKET_LIMITS }) ||
        canonicalJson(JSON.parse(row.output_json)) !== "{}"
      ) {
        return null;
      }
    } catch {
      return null;
    }
    resolved.push({ name: binding.name, resourceUid: binding.resource.resourceUid });
  }
  return resolved;
}

/**
 * A KV binding is usable only after the exact same-target namespace Resource
 * has a settled, Form-defined observation and empty output. Native selection
 * and grant authority are rechecked again by the private broker per request.
 */
async function resolvedEdgeKvBindings(
  sql: Sql,
  spec: WorkerVersionSpec,
  identity: { readonly principal: string; readonly space: string; readonly targetKey: string },
): Promise<readonly V2ResolvedKvBinding[] | null> {
  const resolved: V2ResolvedKvBinding[] = [];
  for (const binding of spec.kvBindings) {
    const rows = await sql.query(
      `SELECT r.spec_json, r.observed_json, r.output_json, r.backend_id
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND r.backend_id = ? AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.action IN ('create', 'update')
         AND op.accepted_spec_json = r.spec_json`,
      [
        binding.resource.resourceUid,
        EDGE_KV_NAMESPACE_FORM_URL,
        identity.principal,
        identity.space,
        identity.targetKey,
        EDGE_KV_NAMESPACE_BACKEND_ID,
      ],
    );
    const row = rows.length === 1 ? rows[0] : null;
    if (
      typeof row?.spec_json !== "string" ||
      typeof row.observed_json !== "string" ||
      typeof row.output_json !== "string" ||
      row.backend_id !== EDGE_KV_NAMESPACE_BACKEND_ID
    ) {
      return null;
    }
    try {
      parseEdgeKVNamespaceSpec(JSON.parse(row.spec_json));
      if (
        canonicalJson(JSON.parse(row.observed_json)) !==
          canonicalJson({ namespaceExists: true, ...EDGE_KV_NAMESPACE_LIMITS }) ||
        canonicalJson(JSON.parse(row.output_json)) !== "{}"
      ) {
        return null;
      }
    } catch {
      return null;
    }
    resolved.push({ name: binding.name, resourceUid: binding.resource.resourceUid });
  }
  return resolved;
}

/** Existing Core UID custody is injected; this runtime never reinterprets its row authority. */
export interface V2CodeConfiguredInputCustody {
  read(identity: {
    readonly principal: string;
    readonly space: string;
    readonly name: string;
    readonly form: string;
    readonly resourceUid: string;
  }): Promise<V2WorkerVersionSealedInputs | null>;
}

/** Resource-owned ciphertext read. A publication SQL vector must fence every await. */
export interface V2CodeConfiguredInputReader {
  read(input: {
    readonly resourceUid: string;
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
    readonly spec: WorkerVersionSpec;
    stillCurrent(): Promise<boolean>;
  }): Promise<Readonly<Record<string, string>> | null>;
}

export function createV2CodeConfiguredInputReader(options: {
  readonly sql: Sql;
  readonly sealer: ConfiguredInputSealer;
  readonly custody: V2CodeConfiguredInputCustody;
}): V2CodeConfiguredInputReader {
  if (!options.sealer?.open || !options.custody?.read)
    throw new TypeError("configured input sealer and custody reader are required");
  const { sql } = options;
  const open = options.sealer.open.bind(options.sealer);
  const readConfigured = options.custody.read.bind(options.custody);
  return {
    async read(input) {
      let expected: WorkerVersionSpec;
      const resourceUid = input.resourceUid;
      const principal = input.principal;
      const space = input.space;
      const targetKey = input.targetKey;
      const stillCurrent = input.stillCurrent;
      try {
        expected = parseWorkerVersionSpec(structuredClone(input.spec));
      } catch {
        return null;
      }
      if (expected.requiredSensitiveVars.length === 0 || !(await stillCurrent())) return null;
      const row = (
        await sql.query(
          `SELECT name, spec_json FROM tf_v2_resources
           WHERE uid = ? AND principal = ? AND space = ? AND target_key = ?
             AND form_url = ? AND deleted_at IS NULL`,
          [resourceUid, principal, space, targetKey, WORKER_VERSION_FORM_URL],
        )
      )[0];
      if (typeof row?.name !== "string" || typeof row.spec_json !== "string") return null;
      try {
        if (
          canonicalJson(parseWorkerVersionSpec(JSON.parse(row.spec_json))) !==
          canonicalJson(expected)
        )
          return null;
      } catch {
        return null;
      }
      const identity = {
        principal,
        space,
        name: row.name,
        form: WORKER_VERSION_FORM_URL,
        resourceUid,
        spec: expected,
      };
      const sealed = await readConfigured(identity);
      if (!sealed) return null;
      const opened = await open(identity, sealed);
      const owned = snapshotV2WorkerPrivateInputs(opened);
      if (
        !owned ||
        Object.keys(owned).length !== expected.requiredSensitiveVars.length ||
        !expected.requiredSensitiveVars.every((name) => Object.hasOwn(owned, name))
      )
        return null;
      if (!(await stillCurrent())) return null;
      return owned;
    },
  };
}

/**
 * Internal held-code eligibility for WorkerVersion. This checks whether the
 * exact accepted bundle can support the currently inspected handlers; it does
 * not publish a Deployment or authorize scheduled event delivery.
 */
type CodeWorkerVersionOptions = {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicationState: VersionState;
  readonly retirement: V2WorkerRetirementReader;
  readonly inspectModule: WorkerdRuntime["inspectModule"];
  /** Actual initialized private Queue settlement plane, also given to the native owner. */
  readonly queueSettlement?: V2CodeQueueSettlementBoot;
  /** Same initialized broker and authority given to the native owner/publication path. */
  readonly v2SqliteBinding?: V2CodeSqliteBindingBoot;
  /** Same private ObjectBucket broker and Core reader used by native publication. */
  readonly v2ObjectBucketBinding?: V2CodeObjectBucketBindingBoot;
  /** Same private KV broker and Core reader used by native publication. */
  readonly v2KvBinding?: V2CodeKvBindingBoot;
  readonly v2QueueProducerBinding?: V2CodeQueueProducerBindingBoot;
  readonly v2ActorBinding?: V2CodeActorBindingAuthority;
  readonly configuredInputSealer?: ConfiguredInputSealer;
  readonly configuredInputCustody?: V2CodeConfiguredInputCustody;
};

export function createInternalV2CodeWorkerVersionForm(options: CodeWorkerVersionOptions): V2Form {
  return codeWorkerVersionForm(options, WORKER_CODE_VERSION_LIFECYCLE_BACKEND_ID);
}

function codeWorkerVersionForm(options: CodeWorkerVersionOptions, backendId: string): V2Form {
  if (
    !options.targetKey ||
    !options.publicationState?.resolveVersion ||
    !options.retirement?.observeRetired ||
    typeof options.inspectModule !== "function"
  ) {
    throw new TypeError(
      "Code WorkerVersion requires targetKey, publication state, exact retirement reader and module inspector",
    );
  }
  if (options.queueSettlement && !validQueueSettlementBoot(options.queueSettlement)) {
    throw new TypeError("Code WorkerVersion requires a valid private Queue settlement boot");
  }
  if (options.v2SqliteBinding && !validSqliteBindingBoot(options.v2SqliteBinding)) {
    throw new TypeError("Code WorkerVersion requires a valid private SQLite binding boot");
  }
  if (
    options.v2ObjectBucketBinding &&
    !validObjectBucketBindingBoot(options.v2ObjectBucketBinding)
  ) {
    throw new TypeError("Code WorkerVersion requires a valid private ObjectBucket binding boot");
  }
  if (options.v2KvBinding && !validKvBindingBoot(options.v2KvBinding)) {
    throw new TypeError("Code WorkerVersion requires a valid private KV binding boot");
  }
  if (
    options.v2QueueProducerBinding &&
    !validQueueProducerBindingBoot(options.v2QueueProducerBinding)
  ) {
    throw new TypeError("Code WorkerVersion requires a valid private Queue producer binding boot");
  }
  if (options.v2ActorBinding && typeof options.v2ActorBinding.resolveTarget !== "function") {
    throw new TypeError("Code WorkerVersion requires an Actor namespace authority");
  }
  const { sql, targetKey } = options;
  const queueSettlement = options.queueSettlement;
  const sqliteBinding = options.v2SqliteBinding;
  const objectBucketBinding = options.v2ObjectBucketBinding;
  const kvBinding = options.v2KvBinding;
  const queueProducerBinding = options.v2QueueProducerBinding;
  const actorBinding = options.v2ActorBinding;
  const resolveVersion = options.publicationState.resolveVersion.bind(options.publicationState);
  const observeRetired = options.retirement.observeRetired.bind(options.retirement);
  const inspectModule = options.inspectModule;
  const configuredInputSealer = options.configuredInputSealer;
  if (configuredInputSealer && !options.configuredInputCustody) {
    throw new TypeError("configured input custody reader is required");
  }
  const configuredInputReader = configuredInputSealer
    ? createV2CodeConfiguredInputReader({
        sql,
        sealer: configuredInputSealer,
        custody: options.configuredInputCustody as V2CodeConfiguredInputCustody,
      })
    : null;
  const sealConfigured = configuredInputSealer?.seal.bind(configuredInputSealer);
  const openConfigured = configuredInputSealer?.open.bind(configuredInputSealer);
  const compareConfigured = configuredInputSealer?.compare.bind(configuredInputSealer);

  async function manage(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_VERSION_FORM_URL ||
      execution.targetKey !== targetKey ||
      execution.backendId !== backendId
    ) {
      return unresolved();
    }
    if (execution.action === "delete") {
      try {
        const spec = codeOnly(
          parseWorkerVersionSpec(execution.spec),
          configuredInputSealer !== undefined,
          queueSettlement,
          sqliteBinding,
          objectBucketBinding,
          kvBinding,
          queueProducerBinding,
          actorBinding,
        );
        return (await retired(sql, observeRetired, execution, spec.worker.resourceUid, "version"))
          ? { kind: "complete", observed: {}, output: {} }
          : unresolved();
      } catch {
        return unresolved();
      }
    }
    try {
      const spec = codeOnly(
        parseWorkerVersionSpec(execution.spec),
        configuredInputSealer !== undefined,
        queueSettlement,
        sqliteBinding,
        objectBucketBinding,
        kvBinding,
        queueProducerBinding,
        actorBinding,
      );
      if (!(await currentClaim(sql, execution))) return unresolved();
      const resolution = await resolveVersion({ execution });
      if (resolution.kind !== "ready") return unresolved();
      const { snapshot } = resolution;
      if (
        snapshot.sourceOperationId !== execution.operationId ||
        snapshot.worker.uid !== spec.worker.resourceUid ||
        snapshot.worker.principal !== execution.principal ||
        snapshot.worker.space !== execution.space ||
        snapshot.version.uid !== execution.resourceUid ||
        snapshot.version.generation !== execution.generation ||
        canonicalJson(snapshot.version.spec) !== canonicalJson(spec)
      ) {
        return unresolved();
      }
      const materials = await resolution.readMaterials();
      const configuredPrivateInputs =
        spec.requiredSensitiveVars.length > 0
          ? await configuredInputReader?.read({
              resourceUid: snapshot.version.uid,
              principal: snapshot.worker.principal,
              space: snapshot.worker.space,
              targetKey: execution.targetKey,
              spec: snapshot.version.spec,
              stillCurrent: resolution.stillCurrent,
            })
          : undefined;
      if (spec.requiredSensitiveVars.length > 0 && !configuredPrivateInputs) return unresolved();
      const resolvedServiceBindings = await projectV2ResolvedServiceBindings(
        snapshot.version.spec.serviceBindings,
      );
      const resolvedSQLite =
        spec.sqliteBindings.length > 0
          ? await resolvedSqliteBindings(sql, snapshot.version.spec, {
              principal: execution.principal,
              space: execution.space,
              targetKey: execution.targetKey,
            })
          : [];
      if (resolvedSQLite === null) return unresolved();
      const resolvedBuckets =
        spec.bucketBindings.length > 0
          ? await resolvedObjectBucketBindings(sql, snapshot.version.spec, {
              principal: execution.principal,
              space: execution.space,
              targetKey: execution.targetKey,
            })
          : [];
      if (resolvedBuckets === null) return unresolved();
      const resolvedKv =
        spec.kvBindings.length > 0
          ? await resolvedEdgeKvBindings(sql, snapshot.version.spec, {
              principal: execution.principal,
              space: execution.space,
              targetKey: execution.targetKey,
            })
          : [];
      if (resolvedKv === null) return unresolved();
      const resolvedQueueProducers =
        spec.queueProducerBindings.length > 0
          ? await resolvedQueueProducerBindings(sql, snapshot.version.spec, {
              principal: execution.principal,
              space: execution.space,
              targetKey: execution.targetKey,
            })
          : [];
      if (resolvedQueueProducers === null) return unresolved();
      const resolvedActors = [] as {
        readonly name: string;
        readonly resourceUid: string;
        readonly className: string;
        readonly vector: string;
      }[];
      for (const binding of spec.actorBindings) {
        const target = await actorBinding?.resolveTarget({
          principal: execution.principal,
          space: execution.space,
          targetKey: execution.targetKey,
          workerUid: spec.worker.resourceUid,
          namespaceResourceUid: binding.resource.resourceUid,
        });
        if (!target) return unresolved();
        resolvedActors.push({
          name: binding.name,
          resourceUid: binding.resource.resourceUid,
          className: target.className,
          vector: target.vector,
        });
      }
      await inspectV2WorkerCodeVersionEligibility({
        workerResourceUid: snapshot.worker.uid,
        ...(spec.bundle ? { bundleResourceUid: spec.bundle.resourceUid } : {}),
        ...(spec.assets ? { assetResourceUid: spec.assets.bundle.resourceUid } : {}),
        spec: snapshot.version.spec,
        bundle: materials.bundle,
        assets: materials.assets,
        inspectModule,
        ...(configuredPrivateInputs ? { privateInputs: configuredPrivateInputs } : {}),
        ...(resolvedServiceBindings.length > 0 ? { resolvedServiceBindings } : {}),
        ...(resolvedSQLite.length > 0 ? { resolvedSqliteBindings: resolvedSQLite } : {}),
        ...(resolvedBuckets.length > 0 ? { resolvedObjectBucketBindings: resolvedBuckets } : {}),
        ...(resolvedKv.length > 0 ? { resolvedKvBindings: resolvedKv } : {}),
        ...(resolvedQueueProducers.length > 0
          ? { resolvedQueueProducerBindings: resolvedQueueProducers }
          : {}),
        ...(resolvedActors.length > 0 ? { resolvedActorBindings: resolvedActors } : {}),
      });
      for (const binding of resolvedActors) {
        const target = await actorBinding?.resolveTarget({
          principal: execution.principal,
          space: execution.space,
          targetKey: execution.targetKey,
          workerUid: spec.worker.resourceUid,
          namespaceResourceUid: binding.resourceUid,
        });
        if (!target || target.vector !== binding.vector || target.className !== binding.className)
          return unresolved();
      }
      if (!(await resolution.stillCurrent()) || !(await currentClaim(sql, execution))) {
        return unresolved();
      }
      return {
        kind: "complete",
        observed: { ready: true, resolvedBindings: true, bundleVerified: true },
        output: {},
      };
    } catch {
      return unresolved();
    }
  }

  return {
    validateCreate(spec) {
      codeOnly(
        validated(() => parseWorkerVersionSpec(spec)),
        configuredInputSealer !== undefined,
        queueSettlement,
        sqliteBinding,
        objectBucketBinding,
        kvBinding,
        queueProducerBinding,
        actorBinding,
      );
    },
    validateUpdate(previous, spec) {
      codeOnly(
        validated(() => validateWorkerVersionUpdate(previous, spec)),
        configuredInputSealer !== undefined,
        queueSettlement,
        sqliteBinding,
        objectBucketBinding,
        kvBinding,
        queueProducerBinding,
        actorBinding,
      );
    },
    references(spec) {
      return referencesForWorkerVersion(
        codeOnly(
          validated(() => parseWorkerVersionSpec(spec)),
          configuredInputSealer !== undefined,
          queueSettlement,
          sqliteBinding,
          objectBucketBinding,
          kvBinding,
          queueProducerBinding,
          actorBinding,
        ),
      );
    },
    ...(configuredInputSealer
      ? {
          privateInputs: {
            validateCreate(spec: JsonObject, inputs: Readonly<Record<string, string>> | undefined) {
              const names = parseWorkerVersionSpec(spec).requiredSensitiveVars;
              const owned = snapshotV2WorkerPrivateInputs(inputs);
              if (
                owned === null ||
                (names.length > 0 && !owned) ||
                (owned !== undefined &&
                  (Object.keys(owned).length !== names.length ||
                    !names.every((name) => Object.hasOwn(owned, name))))
              ) {
                throw new TakoformV2Error("invalid_spec", 422);
              }
            },
            validateUpdate(
              _previousSpec: JsonObject,
              spec: JsonObject,
              inputs: Readonly<Record<string, string>> | undefined,
            ) {
              if (inputs === undefined) return;
              const names = parseWorkerVersionSpec(spec).requiredSensitiveVars;
              const owned = snapshotV2WorkerPrivateInputs(inputs);
              if (
                !owned ||
                Object.keys(owned).length !== names.length ||
                !names.every((name) => Object.hasOwn(owned, name))
              ) {
                throw new TakoformV2Error("invalid_spec", 422);
              }
            },
            async prepareCreate(input: {
              readonly principal: string;
              readonly space: string;
              readonly name: string;
              readonly form: string;
              readonly resourceUid: string;
              readonly spec: JsonObject;
              readonly privateInputs: Readonly<Record<string, string>> | undefined;
            }) {
              const spec = parseWorkerVersionSpec(input.spec);
              if (spec.requiredSensitiveVars.length === 0) return null;
              if (!sealConfigured) throw new TypeError("configured input sealer is unavailable");
              return await sealConfigured(
                {
                  principal: input.principal,
                  space: input.space,
                  name: input.name,
                  form: input.form,
                  resourceUid: input.resourceUid,
                  spec,
                },
                input.privateInputs,
              );
            },
            async prepareUpdate(input: {
              readonly principal: string;
              readonly space: string;
              readonly name: string;
              readonly form: string;
              readonly resourceUid: string;
              readonly spec: JsonObject;
              readonly privateInputs: Readonly<Record<string, string>> | undefined;
              readonly configured: {
                readonly keyId: string;
                readonly nonce: string;
                readonly ciphertext: string;
              } | null;
            }) {
              const spec = parseWorkerVersionSpec(input.spec);
              if (spec.requiredSensitiveVars.length === 0) {
                const emptyInputs = snapshotV2WorkerPrivateInputs(input.privateInputs);
                if (
                  input.configured ||
                  emptyInputs === null ||
                  (emptyInputs !== undefined && Object.keys(emptyInputs).length > 0)
                )
                  throw new TakoformV2Error("invalid_spec", 422);
                return;
              }
              if (!input.configured) throw new TakoformV2Error("private_inputs_unverifiable", 409);
              const identity = {
                principal: input.principal,
                space: input.space,
                name: input.name,
                form: input.form,
                resourceUid: input.resourceUid,
                spec,
              };
              if (input.privateInputs === undefined) {
                if (!(await openConfigured?.(identity, input.configured))) {
                  throw new TakoformV2Error("private_inputs_unverifiable", 409);
                }
                return;
              }
              const comparison = await compareConfigured?.(
                identity,
                input.configured,
                input.privateInputs,
              );
              if (comparison === "unavailable")
                throw new TakoformV2Error("private_inputs_unverifiable", 409);
              if (comparison === "mismatched") throw new TakoformV2Error("invalid_spec", 422);
            },
          },
        }
      : {}),
    rejectDeleteWhileReferenced: true,
    backend: {
      id: backendId,
      targetKey,
      execute: manage,
      reconcile: manage,
    },
  };
}

/**
 * Internal static-only Version eligibility. This does not publish a Deployment
 * or make a Form support claim. The resolver owns accepted SQL references and
 * held-byte custody; the projection checks the asset serving snapshot.
 */
type StaticWorkerVersionOptions = {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicationState: VersionState;
  readonly retirement: V2WorkerRetirementReader;
};

export function createInternalV2StaticWorkerVersionForm(
  options: StaticWorkerVersionOptions,
): V2Form {
  return staticWorkerVersionForm(options, WORKER_VERSION_LIFECYCLE_BACKEND_ID);
}

function staticWorkerVersionForm(options: StaticWorkerVersionOptions, backendId: string): V2Form {
  if (
    !options.targetKey ||
    !options.publicationState?.resolveVersion ||
    !options.retirement?.observeRetired
  ) {
    throw new TypeError(
      "WorkerVersion requires targetKey, publication state and exact retirement reader",
    );
  }
  const { sql, targetKey } = options;
  const resolveVersion = options.publicationState.resolveVersion.bind(options.publicationState);
  const observeRetired = options.retirement.observeRetired.bind(options.retirement);

  async function manage(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_VERSION_FORM_URL ||
      execution.targetKey !== targetKey ||
      execution.backendId !== backendId
    ) {
      return unresolved();
    }
    if (execution.action === "delete") {
      try {
        const spec = parseWorkerVersionSpec(execution.spec);
        return (await retired(sql, observeRetired, execution, spec.worker.resourceUid, "version"))
          ? { kind: "complete", observed: {}, output: {} }
          : unresolved();
      } catch {
        return unresolved();
      }
    }
    try {
      const spec = staticOnly(parseWorkerVersionSpec(execution.spec));
      const resolution = await resolveVersion({ execution });
      if (resolution.kind !== "ready") return unresolved();
      const { snapshot } = resolution;
      if (
        snapshot.sourceOperationId !== execution.operationId ||
        snapshot.worker.uid !== spec.worker.resourceUid ||
        snapshot.worker.principal !== execution.principal ||
        snapshot.worker.space !== execution.space ||
        snapshot.version.uid !== execution.resourceUid ||
        snapshot.version.generation !== execution.generation ||
        canonicalJson(snapshot.version.spec) !== canonicalJson(spec)
      ) {
        return unresolved();
      }
      const readMaterials = resolution.readMaterials.bind(resolution);
      const stillCurrent = resolution.stillCurrent.bind(resolution);
      const materials = await readMaterials();
      await projectV2StaticWorkerVersion({
        identity: {
          directory: snapshot.worker.uid,
          hostnames: [],
          generation: execution.operationId,
          workerResourceUid: snapshot.worker.uid,
          workerVersionUid: snapshot.version.uid,
          versionId: snapshot.version.uid,
          weight: 10_000,
        },
        spec: snapshot.version.spec,
        materials,
      });
      if (!(await stillCurrent())) return unresolved();
      return {
        kind: "complete",
        observed: { ready: true, resolvedBindings: true },
        output: {},
      };
    } catch {
      return unresolved();
    }
  }

  return {
    validateCreate(spec) {
      staticOnly(validated(() => parseWorkerVersionSpec(spec)));
    },
    validateUpdate(previous, spec) {
      staticOnly(validated(() => validateWorkerVersionUpdate(previous, spec)));
    },
    references(spec) {
      return referencesForWorkerVersion(staticOnly(validated(() => parseWorkerVersionSpec(spec))));
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: backendId,
      targetKey,
      execute: manage,
      reconcile: manage,
    },
  };
}

/** One internal Form identity for static, code, and code-plus-assets Versions. */
export function createInternalV2WorkerVersionForm(options: CodeWorkerVersionOptions): V2Form {
  const staticForm = staticWorkerVersionForm(options, WORKER_VERSION_UNIFIED_BACKEND_ID);
  const codeForm = codeWorkerVersionForm(options, WORKER_VERSION_UNIFIED_BACKEND_ID);
  const selected = (spec: JsonObject): V2Form =>
    Object.hasOwn(spec, "bundle") ? codeForm : staticForm;
  return {
    validateCreate(spec) {
      selected(spec).validateCreate(spec);
    },
    validateUpdate(previous, spec) {
      selected(spec).validateUpdate(previous, spec);
    },
    references(spec) {
      const form = selected(spec);
      if (!form.references) throw new TypeError("WorkerVersion references are required");
      return form.references(spec);
    },
    ...(codeForm.privateInputs ? { privateInputs: codeForm.privateInputs } : {}),
    rejectDeleteWhileReferenced: true,
    backend: {
      id: WORKER_VERSION_UNIFIED_BACKEND_ID,
      targetKey: options.targetKey,
      async execute(execution) {
        return await selected(execution.spec).backend.execute(execution);
      },
      async reconcile(execution) {
        return await selected(execution.spec).backend.reconcile(execution);
      },
    },
  };
}
