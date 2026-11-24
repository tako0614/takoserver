import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import { canonicalDigest, canonicalJson, isJsonObject, type JsonObject } from "../json.ts";
import type { Row, Sql, SqlParam, SqlStatement } from "../ports.ts";
import { parseStrictJson } from "../strict-json.ts";
import {
  createV2FinalDeleteConfiguredUpdateDiscard,
  readV2ConfiguredPrivateInputs,
  v2FinalDeleteConfiguredUpdateSchemaFence,
} from "../takoform-v2/configured-private-inputs.ts";
import {
  createV2ContainerHostAcceptance,
  inspectV2ContainerOwnerHistoricalDeleteSchema,
  inspectV2ContainerOwnerSelectedSchema,
  inspectV2ContainerOwnerShutdownIoSchema,
  serializeV2ContainerConfiguredPrivateInputs,
  V2_CONTAINER_APPLICATION_IO_RESERVED,
  V2_CONTAINER_CONTROL_RESERVED,
  V2_CONTAINER_F2_FORM,
  validateV2ContainerF2SensitiveNames,
} from "../takoform-v2/container-owner-schema.ts";
import type {
  V2HostAcceptance,
  V2HostAcceptanceContext,
  V2HostDeleteAcceptanceContext,
} from "../takoform-v2/host-acceptance.ts";
import type { V2Execution } from "../takoform-v2/types.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
  type HostedContainerSecretKeyring,
  isContainerSecretKey,
} from "./container-secret-codec.ts";
import {
  createDockerContainerConfiguredInputs,
  type DockerContainerConfiguredInputs,
  validateDockerContainerSpec,
} from "./docker-container-configured-inputs.ts";
import {
  createDockerContainerCreateCustody,
  type DockerContainerCreateIntent,
  type DockerContainerCreateOwnerPort,
  type DockerContainerCreatePhase,
  type DockerContainerCreateRecord,
} from "./docker-container-create-custody.ts";
import {
  type DockerContainerNativeIdentity,
  type DockerContainerRuntimePolicy,
  DockerContainerRuntimePreparation,
} from "./docker-container-runtime-preparation.ts";
import { LinuxDockerRuntimePreparation } from "./linux-docker-runtime-preparation.ts";
import {
  type LinuxOciHostTopology,
  linuxOciGenerationTopology,
  linuxOciPeerNetworksDisjoint,
  snapshotLinuxOciHostTopology,
  snapshotLinuxOciTopologyPair,
} from "./linux-oci-host-topology.ts";
import {
  advanceOriginalLinuxOciOwnedDisposal,
  createOriginalLinuxOciSealedApplicationCloseResume,
  disposeOriginalLinuxOciAllocation,
  type LinuxOciSealedApplicationCloseResume,
  observeOriginalLinuxOciOwnedInitReaped,
  observeOriginalLinuxOciOwnedNamespaceLifetime,
  observeOriginalLinuxOciOwnedRunning,
  originalLinuxOciHttpRetirementSource,
  originalLinuxOciParentControlSource,
  prepareOriginalLinuxOciAllocationDisposal,
  prepareOriginalLinuxOciApplicationOwnerRead,
  prepareOriginalLinuxOciPeerInit,
  prepareOriginalLinuxOciPeerRead,
  readOriginalLinuxOciControlArtifact,
  readOriginalLinuxOciLiveInit,
  releaseOriginalLinuxOciOwnedNamespace,
  sealOriginalLinuxOciParentControl,
  stopOriginalLinuxOciOwnedInit,
  verifyOriginalLinuxOciParentControl,
} from "./linux-oci-owned-bundle.ts";
import type {
  LinuxOciApplicationOwnerExit,
  LinuxOciDisposedHelperObservation,
  LinuxOciInitReapedObservation,
  LinuxOciNamespaceLifetimeObservation,
  LinuxOciOriginalLiveInit,
  LinuxOciParentHResult,
  LinuxOciPeerInitProgress,
  LinuxOciRetirementObservation,
  LinuxOciStartedObservation,
} from "./linux-oci-physical-session.ts";

/** Original native progress only; no member supplies full lifetime coverage
 * or authority to write a removed claim. */
export type LinuxOciDisposalProgress =
  | LinuxOciNamespaceLifetimeObservation
  | LinuxOciRetirementObservation
  | LinuxOciDisposedHelperObservation;

export interface LinuxOciAllocationDisposalObservation {
  readonly kind: "linux-oci-original-allocation-disposal@1";
  readonly barrier: "unproven";
}

export interface DockerPhysicalCoreOwnerPort extends DockerContainerCreateOwnerPort {
  publishServing(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    runtime: DockerContainerRuntimePreparation | LinuxDockerRuntimePreparation,
  ): Promise<void>;
  readStartClaim(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<"unclaimed" | "claimed" | "unknown">;
  claimStart(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<"claimed" | "already-claimed" | "unknown">;
  assertNetworkAllocation(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    phase?: "remove",
  ): Promise<void>;
  readNetworkMemberRecords(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    observedIds: readonly string[],
  ): Promise<readonly DockerContainerCreateRecord[]>;
  assertNetworkMembers(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    observedIds: readonly string[],
  ): Promise<void>;
}
const verifyOriginalRuntime = DockerContainerRuntimePreparation.prototype.verifyExisting;
const verifyLinuxRuntime = LinuxDockerRuntimePreparation.prototype.verifyExisting;
type Context = V2HostAcceptanceContext | V2HostDeleteAcceptanceContext;
type Proof = Record<string, string | number | null>;
// Private negative SQL fence from a close already authenticated by this owner.
type RetiredCurrent = (() => Promise<() => void>) & { readonly snapshot: SqlStatement };
type ServingPublication = { readonly finished: Promise<void>; pending: boolean };
type Lease = {
  readonly record: DockerContainerCreateRecord;
  readonly phase: DockerContainerCreatePhase;
  proof: Proof;
  readonly controller: AbortController;
  active: boolean;
  servingPublication?: ServingPublication;
};

export interface DockerContainerCoreOwnerOptions {
  readonly hostTopology?: LinuxOciHostTopology;
  readonly alternateHostTopology?: LinuxOciHostTopology;
  readonly sql: Sql;
  readonly clock: () => Date;
  readonly installationId: string;
  readonly backendId: string;
  readonly targetKey: string;
  /** Explicit qualified Native build output, independent of OCI image digests.
   * Selects a producer; it never supplies a termination observation. */
  readonly qualifiedPhysicalDigest?: string;
  /** Explicit private mode, never selected by a request or old claim. */
  readonly ociParentControl?:
    | "sealed-original@1"
    | "sealed-peer@1"
    | "sealed-peer-runtime@1"
    | "sealed-peer-local-cleanup@1"
    | "sealed-peer-application-owner@1"
    | "sealed-peer-runtime-application-owner@1";
  readonly configuredInputs?: {
    readonly keyring: HostedContainerSecretKeyring;
    readonly maxSecretBytes: number;
  };
}
export interface DockerContainerCoreOwner {
  readonly acceptance: V2HostAcceptance;
  readonly owner: DockerPhysicalCoreOwnerPort;
  saveAcceptedParentControl(
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<void>;
  saveOriginalShutdownIoClose(
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<void>;
  /** Final storage consumer after this owning Core's genuine Native removal.
   * It authenticates original control and same-operation close; no DTO grants retirement. */
  finalizeAcceptedDelete(
    execution: V2Execution,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<void>;
  /** Data readback against the SAME original P. Missing original custody refuses. */
  readAcceptedParentControl(
    execution: V2Execution,
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<undefined | LinuxOciParentHResult>;
  readAcceptedApplicationRecovery(
    execution: V2Execution,
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciApplicationOwnerExit | LinuxOciParentHResult | LinuxOciPeerInitProgress>;
  manageAcceptedPeerInit(
    execution: V2Execution,
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciPeerInitProgress | LinuxOciParentHResult>;
  createCustody(
    policy: DockerContainerRuntimePolicy,
    requiredSecretNames: readonly string[],
  ): ReturnType<typeof createDockerContainerCreateCustody>;
  readAcceptedExecution(original: V2Execution): Promise<DockerContainerAcceptedExecution>;
  /** Claim once under the ORIGINAL accepted execution, then refuse a singleton
   * topology when any other same-target claim lacks proven released coordinates.
   * This is a negative collision fence, never an allocation/native permission. */
  claimAcceptedTopology(
    execution: V2Execution,
    intent: DockerContainerCreateIntent,
    originalCustody: object,
    signal: AbortSignal,
  ): ReturnType<DockerContainerCreateOwnerPort["claim"]>;

  /** Consume the ORIGINAL one-use START ledger for an already bound accepted
   * record under this owner's live reconcile authority. This records only the
   * attempt; it grants no admission, physical result, running or serving state.
   */
  claimAcceptedStart(
    record: DockerContainerCreateRecord,
  ): Promise<"claimed" | "already-claimed" | "unknown">;
  /** Record running only through the ORIGINAL creator's private custody of
   * this owner's bound CREATE/session, under its current accepted execution.
   * An initialized session or bound record alone supplies no such custody. */
  confirmAcceptedRunning(
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciStartedObservation>;
  /** Internal original OCI creator publisher. The private creator completes
   * its own fixed HTTP exchange before invoking this source; no returned status,
   * runtime DTO, verification callback or arbitrary session is accepted. */
  publishAcceptedOciServing(
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<void>;
  /** Internal keyed read of the original running init through its fixed peer
   * connector. Sealed control bytes stay in owning Core and creator code. */
  readCurrentOciInit(
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciOriginalLiveInit>;
  /** Original creator's live serving read, independent of a completed
   * management execution lease. It grants neither caller authorization nor
   * removal; the binding owner must authorize each application invocation. */
  observeServingOciHttp(
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<{ readonly native: LinuxOciStartedObservation; readonly httpPort: number }>;
  /** Stop/reap only an original retained init under the accepted UPDATE/DELETE
   * and original remove lease; records exit, never network terminal/deletion. */
  stopRetainedInit(
    execution: V2Execution,
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciInitReapedObservation>;
  /** Same original retained custody only; a genuine running attempt is first
   * reaped through stopRetainedInit. Exited attempts never repeat task IO. */
  releaseRetainedNamespace(
    execution: V2Execution,
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciNamespaceLifetimeObservation>;
  /** Read-only observation requires that exact original attempt already exited. */
  observeRetainedNamespaceLifetime(
    execution: V2Execution,
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciNamespaceLifetimeObservation>;
  advanceRetainedBornDisposal(
    execution: V2Execution,
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciDisposalProgress>;
  disposeRetainedAllocation(
    execution: V2Execution,
    record: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
  ): Promise<LinuxOciAllocationDisposalObservation>;
  withExecution<T>(execution: V2Execution, work: () => Promise<T>): Promise<T>;
}
export interface DockerContainerAcceptedExecution {
  readonly installationId: string;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly principal: string;
  readonly space: string;
  readonly name: string;
  readonly form: string;
  readonly backendId: string;
  readonly targetKey: string;
  readonly action: V2Execution["action"];
  readonly generation: number;
  readonly revision: string;
  readonly spec: JsonObject;
  readonly requiredSecretNames: readonly string[];
  readonly outboundInternet: boolean;
  readonly retained: readonly {
    readonly record: DockerContainerCreateRecord;
    readonly spec: JsonObject;
    readonly removedAtMs: number | null;
  }[];
  readonly servingConfirmedAtMs: number | null;
}
type ExecutionScope = {
  readonly execution: V2Execution;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly action: V2Execution["action"];
};

const columns = {
  i: [
    "resource_uid",
    "installation_id",
    "principal",
    "space",
    "name",
    "form_url",
    "backend_id",
    "target_key",
    "incarnation_id",
    "create_operation_id",
    "desired_generation",
    "management_epoch",
    "serving_generation",
    "runtime_epoch",
    "retire_operation_id",
    "retired_at_ms",
    "created_at",
  ],
  v: [
    "resource_uid",
    "generation",
    "operation_id",
    "revision",
    "intent_json",
    "native_name",
    "retention",
  ],
  a: [
    "operation_id",
    "resource_uid",
    "installation_id",
    "incarnation_id",
    "principal",
    "space",
    "name",
    "form_url",
    "backend_id",
    "target_key",
    "action",
    "generation",
    "backend_key",
    "replay_key",
    "fingerprint",
    "accepted_spec_json",
    "accepted_output_json",
    "references_json",
    "configured_private_inputs_json",
    "accepted_at",
    "retain_until",
    "revision",
  ],
  o: [
    "id",
    "resource_uid",
    "principal",
    "replay_key",
    "request_fingerprint",
    "action",
    "generation",
    "created_at",
    "retain_until",
    "backend_id",
    "target_key",
    "backend_key",
    "accepted_spec_json",
    "private_inputs_present",
    "status",
  ],
  r: [
    "uid",
    "principal",
    "form_url",
    "space",
    "name",
    "backend_id",
    "target_key",
    "active_name",
    "generation",
    "phase",
    "spec_json",
    "last_operation",
    "deleted_at",
  ],
  la: [
    "operation_id",
    "resource_uid",
    "installation_id",
    "incarnation_id",
    "principal",
    "space",
    "name",
    "form_url",
    "backend_id",
    "target_key",
    "action",
    "generation",
    "backend_key",
    "replay_key",
    "fingerprint",
    "accepted_spec_json",
    "accepted_output_json",
    "references_json",
    "configured_private_inputs_json",
    "accepted_at",
    "retain_until",
    "revision",
  ],
  lo: [
    "id",
    "resource_uid",
    "principal",
    "replay_key",
    "request_fingerprint",
    "action",
    "generation",
    "created_at",
    "retain_until",
    "backend_id",
    "target_key",
    "backend_key",
    "accepted_spec_json",
    "private_inputs_present",
    "status",
  ],
  q: [
    "resource_uid",
    "generation",
    "installation_id",
    "claim_id",
    "state",
    "native_id",
    "claimed_at_ms",
    "bound_at_ms",
    "removed_at_ms",
  ],
} as const;
const fields = Object.entries(columns).flatMap(([alias, names]) =>
  names.map((name) => ({ column: alias + "." + name, key: alias + "_" + name })),
);
const from =
  " FROM tf_v2_container_instances i JOIN tf_v2_container_revisions v ON v.resource_uid=i.resource_uid JOIN tf_v2_container_acceptances a ON a.operation_id=v.operation_id JOIN tf_v2_operations o ON o.id=a.operation_id JOIN tf_v2_resources r ON r.uid=i.resource_uid JOIN tf_v2_container_acceptances la ON la.operation_id=r.last_operation JOIN tf_v2_operations lo ON lo.id=la.operation_id LEFT JOIN tf_v2_container_create_claims q ON q.resource_uid=v.resource_uid AND q.generation=v.generation";
const select = "SELECT " + fields.map(({ column, key }) => column + " AS " + key).join(",") + from;
const fail: () => never = (): never => {
  throw new TypeError("Docker Core owner authority refused");
};

async function waitForOriginalApplicationClose(
  close: Promise<void>,
  finished: AbortSignal,
  signal: AbortSignal,
) {
  if (!finished.aborted && !signal.aborted) {
    let onChange!: () => void;
    try {
      await new Promise<void>((resolve) => {
        onChange = () => {
          if (finished.aborted || signal.aborted) resolve();
        };
        finished.addEventListener("abort", onChange);
        signal.addEventListener("abort", onChange);
        onChange();
      });
    } finally {
      finished.removeEventListener("abort", onChange);
      signal.removeEventListener("abort", onChange);
    }
  }
  if (signal.aborted) return fail();
  await close;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2048;
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const own = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return !!d && Object.hasOwn(d, "value");
  });
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const encodedRevision = (value: unknown, generation: unknown): value is string =>
  typeof value === "string" &&
  Number.isSafeInteger(generation) &&
  Number(generation) > 0 &&
  value.startsWith(`${generation}-`) &&
  hex(value.slice(String(generation).length + 1));

const intentKeys = [
  "installationId",
  "resourceUid",
  "incarnationId",
  "revision",
  "nativeName",
  "identityLabel",
  "revisionLabel",
  "policy",
  "requiredSecretNames",
];
const policyKeys = ["tenantRef", "generation", "policyDigest", "outboundInternet"];

function intentSnapshot(value: DockerContainerCreateIntent): DockerContainerCreateIntent {
  if (
    !own(value, intentKeys) ||
    !own(value.policy, policyKeys) ||
    !Array.isArray(value.requiredSecretNames)
  )
    return fail();
  if (
    !intentKeys.slice(0, 7).every((key) => text(value[key])) ||
    !encodedRevision(value.revision, value.policy.generation) ||
    !digest(value.identityLabel) ||
    !digest(value.revisionLabel) ||
    !text(value.policy.tenantRef) ||
    !digest(value.policy.policyDigest) ||
    !Number.isSafeInteger(value.policy.generation) ||
    Number(value.policy.generation) < 1 ||
    typeof value.policy.outboundInternet !== "boolean"
  )
    return fail();
  return Object.freeze({
    installationId: value.installationId as string,
    resourceUid: value.resourceUid as string,
    incarnationId: value.incarnationId as string,
    revision: value.revision as string,
    nativeName: value.nativeName as string,
    identityLabel: value.identityLabel as string,
    revisionLabel: value.revisionLabel as string,
    policy: Object.freeze({
      tenantRef: value.policy.tenantRef,
      generation: value.policy.generation as number,
      policyDigest: value.policy.policyDigest,
      outboundInternet: value.policy.outboundInternet,
    }),
    requiredSecretNames: validateV2ContainerF2SensitiveNames(value.requiredSecretNames),
  });
}
function intentJson(value: DockerContainerCreateIntent): string {
  return JSON.stringify(intentSnapshot(value));
}
function rowProof(row: Row): Proof {
  const proof: Proof = {};
  for (const { key } of fields) {
    const value = row[key];
    if (
      value !== null &&
      typeof value !== "string" &&
      (typeof value !== "number" || !Number.isSafeInteger(value))
    )
      return fail();
    proof[key] = value as string | number | null;
  }
  return Object.freeze(proof);
}
function fence(proof: Proof): { sql: string; params: SqlParam[] } {
  return {
    sql:
      "EXISTS (SELECT 1" +
      from +
      " WHERE " +
      fields.map(({ column }) => column + " IS ?").join(" AND ") +
      ")",
    params: fields.map(({ key }) => proof[key]!),
  };
}

function peerArtifact(scope: unknown, record: DockerContainerCreateRecord) {
  if (
    !isJsonObject(scope) ||
    !own(scope.artifact, [
      "kind",
      "claimId",
      "installationId",
      "resourceUid",
      "incarnationId",
      "generation",
      "revision",
      "sourceDigest",
      "manifestDigest",
      "configDigest",
      "archiveDigest",
    ])
  )
    return fail();
  const a = scope.artifact;
  if (
    a.kind !== "linux-oci-owned-artifact@1" ||
    a.claimId !== record.claimId ||
    a.installationId !== record.intent.installationId ||
    a.resourceUid !== record.intent.resourceUid ||
    a.incarnationId !== record.intent.incarnationId ||
    a.generation !== record.intent.policy.generation ||
    a.revision !== record.intent.revision ||
    ![a.sourceDigest, a.manifestDigest, a.configDigest, a.archiveDigest].every(
      (v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v),
    )
  )
    return fail();
  return a;
}

/** Must be installed into actual Core through AppPorts.v2ContainerHostAcceptance. */
export function createDockerContainerCoreOwner(
  options: DockerContainerCoreOwnerOptions,
): DockerContainerCoreOwner {
  const { sql, clock, installationId, backendId, targetKey } = options;
  const parentMode = options.ociParentControl;
  const qualifiedPhysicalDigest = options.qualifiedPhysicalDigest;
  const runtimeApplicationOwner = parentMode === "sealed-peer-runtime-application-owner@1";
  const trackedPeer = parentMode === "sealed-peer-runtime@1" || runtimeApplicationOwner;
  const applicationOwnerPeer =
    parentMode === "sealed-peer-application-owner@1" || runtimeApplicationOwner;
  const topologies = snapshotLinuxOciTopologyPair(
    options.hostTopology,
    options.alternateHostTopology,
  );
  if (
    topologies?.alternate !== undefined &&
    (parentMode !== "sealed-peer-runtime@1" || qualifiedPhysicalDigest === undefined)
  )
    return fail();
  if (
    (runtimeApplicationOwner && qualifiedPhysicalDigest === undefined) ||
    (qualifiedPhysicalDigest !== undefined &&
      !/^sha256:[a-f0-9]{64}$/u.test(qualifiedPhysicalDigest))
  )
    return fail();
  const peerMode =
    parentMode === "sealed-peer@1" ||
    trackedPeer ||
    parentMode === "sealed-peer-local-cleanup@1" ||
    applicationOwnerPeer;
  // Keep the existing durable peer domain/shape. The authenticated inner
  // purpose below fixes the original pre-CREATE profile without DDL retrofit.
  const peerPurpose = "takoserver.linux-oci-parent-peer-control@1";
  const peerReconstructionPurpose = runtimeApplicationOwner
    ? "takoserver.linux-oci-peer-runtime-application-owner-reconstruction@1"
    : parentMode === "sealed-peer-application-owner@1"
      ? "takoserver.linux-oci-peer-application-owner-reconstruction@1"
      : parentMode === "sealed-peer-local-cleanup@1"
        ? "takoserver.linux-oci-peer-local-cleanup-reconstruction@1"
        : parentMode === "sealed-peer-runtime@1"
          ? "takoserver.linux-oci-peer-runtime-reconstruction@1"
          : "takoserver.linux-oci-peer-reconstruction@1";
  if (parentMode !== undefined && parentMode !== "sealed-original@1" && !peerMode) return fail();
  const original = createV2ContainerHostAcceptance({
    sql,
    installationId,
    backendId,
    targetKey,
    ...(parentMode === undefined ? {} : { ociParentControl: "sealed-original@1" as const }),
  });
  const freshControlClaims = new WeakSet<DockerContainerCreateRecord>();
  const controlKeyring = parentMode !== undefined ? options.configuredInputs?.keyring : undefined;
  const controlDecryptionKey = controlKeyring?.keyForDecryption.bind(controlKeyring);
  if (typeof clock !== "function") return fail();
  const executions = new Set<ExecutionScope>();
  const deleteExecutions = new Set<ExecutionScope>();
  let configuredInputs: DockerContainerConfiguredInputs | undefined;
  const contexts = new Map<string, Context>();
  const closedContextAdmission = new Set<string>();
  const leases = new Set<Lease>();
  const now = () => {
    const value = clock();
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0)
      return fail();
    return value.getTime();
  };
  const capture = (context: Context) => {
    if (
      !Object.isFrozen(context) ||
      !Object.keys(context).every((key) => {
        const d = Object.getOwnPropertyDescriptor(context, key);
        return !!d && Object.hasOwn(d, "value");
      })
    )
      return fail();
    // An already-retired Resource may still have an earlier prepare in flight.
    // Keep its original SQL admission result without retaining its payload or
    // letting that late capture cancel the current DELETE lease.
    if (closedContextAdmission.has(context.resourceUid)) return;
    for (const lease of leases)
      if (
        lease.record.intent.resourceUid === context.resourceUid &&
        !(context.action === "update" && retainedServing(lease, lease.proof))
      )
        lease.controller.abort();
    contexts.set(context.operationId, context);
  };
  const acceptance: V2HostAcceptance = Object.freeze<V2HostAcceptance>({
    assertSql(candidate) {
      original.assertSql(candidate);
    },
    initialOutput(scope) {
      return original.initialOutput(scope);
    },
    prepare(context) {
      const prepared = original.prepare(context);
      if (prepared === undefined) return undefined;
      return prepared.then((value) => {
        capture(context);
        return value;
      });
    },
    prepareDelete(context) {
      const prepared = original.prepareDelete!(context);
      if (prepared === undefined) return undefined;
      return prepared.then((value) => {
        capture(context);
        return value;
      });
    },
  });
  function acceptedLegacy(
    proof: Proof,
    acceptanceAlias: "a" | "la",
    operationAlias: "o" | "lo",
  ): void {
    const a = (key: string) => proof[acceptanceAlias + "_" + key];
    const o = (key: string) => proof[operationAlias + "_" + key];
    const requiredText = [
      "operation_id",
      "resource_uid",
      "installation_id",
      "incarnation_id",
      "principal",
      "space",
      "name",
      "form_url",
      "backend_id",
      "target_key",
      "backend_key",
      "replay_key",
      "fingerprint",
      "accepted_at",
      "retain_until",
    ];
    if (
      !requiredText.every((key) => text(a(key))) ||
      !["create", "update", "delete"].includes(String(a("action"))) ||
      typeof a("generation") !== "number" ||
      Number(a("generation")) < 1 ||
      (a("action") === "create" ? a("generation") !== 1 : Number(a("generation")) < 2)
    )
      fail();
    const scope: readonly [string, unknown][] = [
      ["resource_uid", proof.i_resource_uid],
      ["installation_id", installationId],
      ["incarnation_id", proof.i_incarnation_id],
      ["principal", proof.i_principal],
      ["space", proof.i_space],
      ["name", proof.i_name],
      ["form_url", C.formUrl],
      ["backend_id", backendId],
      ["target_key", targetKey],
      ["configured_private_inputs_json", null],
    ];
    if (
      !scope.every(([key, value]) => a(key) === value) ||
      (a("action") === "delete" && a("references_json") !== null)
    )
      fail();
    const operationPairs: readonly [string, string][] = [
      ["id", "operation_id"],
      ["resource_uid", "resource_uid"],
      ["principal", "principal"],
      ["replay_key", "replay_key"],
      ["request_fingerprint", "fingerprint"],
      ["action", "action"],
      ["generation", "generation"],
      ["created_at", "accepted_at"],
      ["backend_id", "backend_id"],
      ["target_key", "target_key"],
      ["accepted_spec_json", "accepted_spec_json"],
      ["backend_key", "backend_key"],
    ];
    if (
      !operationPairs.every(([key, acceptedKey]) => o(key) === a(acceptedKey)) ||
      o("private_inputs_present") !== 0
    )
      fail();
    const acceptedUntil = Date.parse(String(a("retain_until")));
    const currentUntil = Date.parse(String(o("retain_until")));
    if (
      !Number.isFinite(acceptedUntil) ||
      !Number.isFinite(currentUntil) ||
      currentUntil < acceptedUntil
    )
      fail();
    for (const key of ["accepted_spec_json", "accepted_output_json", "references_json"]) {
      const value = a(key);
      if (value === null && key === "references_json") continue;
      if (typeof value !== "string") fail();
      const parsed = parseStrictJson(new TextEncoder().encode(value), 1048576);
      if (key === "references_json" ? !Array.isArray(parsed) : !isJsonObject(parsed)) fail();
    }
    const spec = parseStrictJson(
      new TextEncoder().encode(String(a("accepted_spec_json"))),
      1048576,
    );
    if (
      !isJsonObject(spec) ||
      !hex(spec[C.fields.workloadRevision]) ||
      (a("action") !== "delete" &&
        `${a("generation")}-${spec[C.fields.workloadRevision]}` !== a("revision")) ||
      (spec[C.fields.requiredSensitiveVars] !== undefined &&
        (!Array.isArray(spec[C.fields.requiredSensitiveVars]) ||
          (spec[C.fields.requiredSensitiveVars] as unknown[]).length !== 0))
    )
      fail();
    // A live preparation keeps its exact original identity; durable recovery
    // verifies existing rows without reconstructing any Core context/prepared.
    const context = contexts.get(String(a("operation_id")));
    if (context) {
      if (!Object.isFrozen(context)) fail();
      const originalPairs: readonly [string, unknown][] = [
        ["operation_id", context.operationId],
        ["resource_uid", context.resourceUid],
        ["principal", context.principal],
        ["space", context.space],
        ["name", context.name],
        ["form_url", context.form],
        ["backend_id", context.backendId],
        ["target_key", context.targetKey],
        ["action", context.action],
        ["generation", context.generation],
        ["replay_key", context.key],
        ["fingerprint", context.fingerprint],
        ["accepted_spec_json", context.specJson],
        ["accepted_output_json", context.outputJson],
        ["references_json", context.referencesJson],
        ["accepted_at", context.at],
        ["retain_until", context.retainUntil],
      ];
      if (
        !originalPairs.every(([key, value]) => a(key) === value) ||
        context.privateInputs !== undefined ||
        context.configuredPrivateInputs !== undefined
      )
        fail();
    }
  }
  // Removed is the existing owning Native CAS, never inferred from absent
  // material. This permits only historical reads while the SAME DELETE still
  // owns the Resource; active/bound snapshots retain their original checks.
  function retiredDeleteProof(proof: Proof, alias: "a" | "la"): boolean {
    return (
      alias === "a" &&
      trackedPeer &&
      proof.q_state === "removed" &&
      proof.la_action === "delete" &&
      proof.i_retire_operation_id === proof.la_operation_id &&
      proof.r_last_operation === proof.la_operation_id &&
      proof.r_phase === "deleting" &&
      proof.r_deleted_at === null &&
      Number(proof.a_generation) < Number(proof.la_generation)
    );
  }
  function acceptedF2(proof: Proof, acceptanceAlias: "a" | "la", operationAlias: "o" | "lo"): void {
    const a = (key: string) => proof[acceptanceAlias + "_" + key];
    const o = (key: string) => proof[operationAlias + "_" + key];
    const requiredText = [
      "operation_id",
      "resource_uid",
      "installation_id",
      "incarnation_id",
      "principal",
      "space",
      "name",
      "form_url",
      "backend_id",
      "target_key",
      "backend_key",
      "replay_key",
      "fingerprint",
      "accepted_at",
      "retain_until",
    ];
    if (
      !requiredText.every((key) => text(a(key))) ||
      !["create", "update", "delete"].includes(String(a("action"))) ||
      typeof a("generation") !== "number" ||
      Number(a("generation")) < 1 ||
      (a("action") === "create" ? a("generation") !== 1 : Number(a("generation")) < 2)
    )
      fail();
    const scope: readonly [string, unknown][] = [
      ["resource_uid", proof.i_resource_uid],
      ["installation_id", installationId],
      ["incarnation_id", proof.i_incarnation_id],
      ["principal", proof.i_principal],
      ["space", proof.i_space],
      ["name", proof.i_name],
      ["form_url", V2_CONTAINER_F2_FORM],
      ["backend_id", backendId],
      ["target_key", targetKey],
    ];
    if (
      !scope.every(([key, value]) => a(key) === value) ||
      (a("action") === "delete" && a("references_json") !== null)
    )
      fail();
    const operationPairs: readonly [string, string][] = [
      ["id", "operation_id"],
      ["resource_uid", "resource_uid"],
      ["principal", "principal"],
      ["replay_key", "replay_key"],
      ["request_fingerprint", "fingerprint"],
      ["action", "action"],
      ["generation", "generation"],
      ["created_at", "accepted_at"],
      ["backend_id", "backend_id"],
      ["target_key", "target_key"],
      ["accepted_spec_json", "accepted_spec_json"],
      ["backend_key", "backend_key"],
    ];
    if (
      !operationPairs.every(([key, acceptedKey]) => o(key) === a(acceptedKey)) ||
      (o("private_inputs_present") !== 0 && o("private_inputs_present") !== 1)
    )
      fail();
    const acceptedUntil = Date.parse(String(a("retain_until")));
    const currentUntil = Date.parse(String(o("retain_until")));
    if (
      !Number.isFinite(acceptedUntil) ||
      !Number.isFinite(currentUntil) ||
      currentUntil < acceptedUntil
    )
      fail();
    for (const key of ["accepted_spec_json", "accepted_output_json", "references_json"]) {
      const value = a(key);
      if (value === null && key === "references_json") continue;
      if (typeof value !== "string") fail();
      const parsed = parseStrictJson(new TextEncoder().encode(value), 1048576);
      if (key === "references_json" ? !Array.isArray(parsed) : !isJsonObject(parsed)) fail();
    }
    const spec = parseStrictJson(
      new TextEncoder().encode(String(a("accepted_spec_json"))),
      1048576,
    );
    if (
      !isJsonObject(spec) ||
      !hex(spec[C.fields.workloadRevision]) ||
      (a("action") !== "delete" &&
        `${a("generation")}-${spec[C.fields.workloadRevision]}` !== a("revision"))
    )
      fail();
    const environment = spec[C.fields.environment];
    if (environment !== undefined && !isJsonObject(environment)) fail();
    const names = validateV2ContainerF2SensitiveNames(
      spec[C.fields.requiredSensitiveVars] === undefined
        ? []
        : spec[C.fields.requiredSensitiveVars],
      environment === undefined ? [] : Object.keys(environment),
    );
    if (
      spec[C.fields.outboundInternet] !== undefined &&
      typeof spec[C.fields.outboundInternet] !== "boolean"
    )
      fail();
    const rawConfigured = a("configured_private_inputs_json");
    if (rawConfigured !== null && typeof rawConfigured !== "string") fail();
    const configured =
      rawConfigured === null
        ? null
        : serializeV2ContainerConfiguredPrivateInputs(
            parseStrictJson(new TextEncoder().encode(rawConfigured as string), 1048576),
          );
    if (
      (a("action") === "delete" && (configured !== null || o("private_inputs_present") !== 0)) ||
      (a("action") === "create" &&
        names.length > 0 &&
        ((configured === null && !retiredDeleteProof(proof, acceptanceAlias)) ||
          o("private_inputs_present") !== 1)) ||
      // An explicit map that declares names must carry its own sealed envelope. An UPDATE
      // without a map keeps what Core captured at admission, which is null when the CREATE
      // had no envelope; its retained source is proved separately at admission.
      (a("action") === "update" &&
        configured === null &&
        names.length > 0 &&
        o("private_inputs_present") === 1 &&
        !retiredDeleteProof(proof, acceptanceAlias))
    )
      fail();
    // A live preparation keeps its exact original identity; durable recovery
    // verifies existing rows without reconstructing any Core context/prepared.
    const context = contexts.get(String(a("operation_id")));
    if (context) {
      if (!Object.isFrozen(context)) fail();
      const originalPairs: readonly [string, unknown][] = [
        ["operation_id", context.operationId],
        ["resource_uid", context.resourceUid],
        ["principal", context.principal],
        ["space", context.space],
        ["name", context.name],
        ["form_url", context.form],
        ["backend_id", context.backendId],
        ["target_key", context.targetKey],
        ["action", context.action],
        ["generation", context.generation],
        ["replay_key", context.key],
        ["fingerprint", context.fingerprint],
        ["accepted_spec_json", context.specJson],
        ["accepted_output_json", context.outputJson],
        ["references_json", context.referencesJson],
        ["accepted_at", context.at],
        ["retain_until", context.retainUntil],
      ];
      if (
        !originalPairs.every(([key, value]) => a(key) === value) ||
        (context.privateInputs === undefined ? 0 : 1) !== o("private_inputs_present") ||
        (serializeV2ContainerConfiguredPrivateInputs(context.configuredPrivateInputs) !==
          configured &&
          !(configured === null && retiredDeleteProof(proof, acceptanceAlias)))
      )
        fail();
    }
  }
  function accepted(proof: Proof, acceptanceAlias: "a" | "la", operationAlias: "o" | "lo"): void {
    if (proof.i_form_url === C.formUrl) {
      acceptedLegacy(proof, acceptanceAlias, operationAlias);
      return;
    }
    if (proof.i_form_url === V2_CONTAINER_F2_FORM) {
      acceptedF2(proof, acceptanceAlias, operationAlias);
      return;
    }
    fail();
  }
  function ownsAcceptedUpdateMaterial(proof: Proof, alias: "a" | "la"): boolean {
    const a = (key: string) => proof[alias + "_" + key];
    const o = (key: string) => proof[(alias === "a" ? "o" : "lo") + "_" + key];
    if (a("action") !== "update" || o("private_inputs_present") !== 1) return false;
    const spec = parseStrictJson(
      new TextEncoder().encode(String(a("accepted_spec_json"))),
      1048576,
    );
    if (!isJsonObject(spec)) return fail();
    const environment = spec[C.fields.environment];
    if (environment !== undefined && !isJsonObject(environment)) return fail();
    return (
      validateV2ContainerF2SensitiveNames(
        spec[C.fields.requiredSensitiveVars] === undefined
          ? []
          : spec[C.fields.requiredSensitiveVars],
        environment === undefined ? [] : Object.keys(environment),
      ).length > 0
    );
  }
  async function configuredSnapshot(proof: Proof, alias: "a" | "la"): Promise<void> {
    const a = (key: string) => proof[alias + "_" + key];
    if (proof.i_form_url !== V2_CONTAINER_F2_FORM || a("action") === "delete") return;
    if (retiredDeleteProof(proof, alias)) return; // Native receipt precedes final map purge.
    const value = await readV2ConfiguredPrivateInputs(
      sql,
      {
        resourceUid: String(a("resource_uid")),
        principal: String(a("principal")),
        space: String(a("space")),
        name: String(a("name")),
        form: String(a("form_url")),
      },
      // Only an UPDATE that carries its own map with declared names owns an accepted-UPDATE
      // row. A CREATE, an omitted PUT, an explicit empty map and a name removal captured the
      // Resource-owned CREATE envelope (or null) at admission. The shape is decided from the
      // accepted evidence, never from whether a row can be read, so a missing own map still
      // fails closed and never falls back to the CREATE anchor.
      ownsAcceptedUpdateMaterial(proof, alias)
        ? { operationId: String(a("operation_id")), generation: Number(a("generation")) }
        : undefined,
    );
    const raw = a("configured_private_inputs_json");
    const captured =
      raw === null
        ? null
        : serializeV2ContainerConfiguredPrivateInputs(
            parseStrictJson(new TextEncoder().encode(String(raw)), 1048576),
          );
    if (serializeV2ContainerConfiguredPrivateInputs(value) !== captured) return fail();
  }

  function validate(proof: Proof, intent: DockerContainerCreateIntent) {
    if (proof.i_form_url !== C.formUrl && proof.i_form_url !== V2_CONTAINER_F2_FORM) return fail();
    accepted(proof, "a", "o");
    accepted(proof, "la", "lo");
    const latest = (key: string) => proof["la_" + key];
    if (
      proof.a_action === "delete" ||
      proof.a_resource_uid !== intent.resourceUid ||
      proof.a_generation !== intent.policy.generation ||
      proof.v_revision !== intent.revision ||
      proof.v_operation_id !== proof.a_operation_id ||
      proof.i_installation_id !== installationId ||
      intent.installationId !== installationId ||
      proof.i_incarnation_id !== intent.incarnationId ||
      proof.i_backend_id !== backendId ||
      proof.i_target_key !== targetKey ||
      proof.i_desired_generation !== latest("generation") ||
      typeof proof.i_management_epoch !== "number" ||
      proof.i_management_epoch < 1 ||
      typeof proof.i_runtime_epoch !== "number" ||
      proof.i_runtime_epoch < 0
    )
      return fail();
    const resourcePairs: readonly [string, unknown][] = [
      ["uid", latest("resource_uid")],
      ["principal", latest("principal")],
      ["space", latest("space")],
      ["name", latest("name")],
      ["form_url", proof.i_form_url],
      ["backend_id", backendId],
      ["target_key", targetKey],
      ["generation", latest("generation")],
      ["last_operation", latest("operation_id")],
      ["spec_json", latest("accepted_spec_json")],
    ];
    if (!resourcePairs.every(([key, value]) => proof["r_" + key] === value)) return fail();
    if (latest("action") === "delete") {
      if (
        proof.i_retire_operation_id !== latest("operation_id") ||
        typeof proof.i_retired_at_ms !== "number"
      )
        return fail();
      if (proof.r_deleted_at === null) {
        if (
          proof.r_active_name !== latest("name") ||
          !(
            proof.r_phase === "deleting" ||
            (proof.r_phase === "error" && proof.lo_status === "failed")
          )
        )
          return fail();
      } else if (
        typeof proof.r_deleted_at !== "string" ||
        proof.r_active_name !== null ||
        proof.r_phase !== "idle" ||
        proof.lo_status !== "succeeded"
      )
        return fail();
    } else if (
      proof.i_retired_at_ms !== null ||
      proof.i_retire_operation_id !== null ||
      proof.r_deleted_at !== null ||
      proof.r_active_name !== latest("name")
    )
      return fail();
    const spec = parseStrictJson(
      new TextEncoder().encode(String(proof.a_accepted_spec_json)),
      1048576,
    );
    if (
      !isJsonObject(spec) ||
      `${intent.policy.generation}-${spec[C.fields.workloadRevision]}` !== intent.revision ||
      (spec[C.fields.outboundInternet] ?? false) !== intent.policy.outboundInternet
    )
      return fail();
    const acceptedEnvironment = spec[C.fields.environment];
    const expectedNames =
      proof.i_form_url === C.formUrl
        ? []
        : validateV2ContainerF2SensitiveNames(
            spec[C.fields.requiredSensitiveVars] === undefined
              ? []
              : spec[C.fields.requiredSensitiveVars],
            isJsonObject(acceptedEnvironment) ? Object.keys(acceptedEnvironment) : [],
          );
    if (JSON.stringify(expectedNames) !== JSON.stringify(intent.requiredSecretNames)) return fail();
    if (
      proof.v_intent_json !== null &&
      (proof.v_intent_json !== intentJson(intent) || proof.v_native_name !== intent.nativeName)
    )
      return fail();
    if (
      proof.q_claim_id !== null &&
      (proof.q_resource_uid !== intent.resourceUid ||
        proof.q_generation !== intent.policy.generation ||
        proof.q_installation_id !== installationId ||
        !hex(proof.q_claim_id))
    )
      return fail();
  }
  function executionScope(execution: V2Execution): ExecutionScope {
    const matching = [...executions, ...deleteExecutions].filter(
      (scope) => scope.execution === execution,
    );
    if (
      matching.length !== 1 ||
      !execution ||
      typeof execution !== "object" ||
      (Object.getPrototypeOf(execution) !== Object.prototype &&
        Object.getPrototypeOf(execution) !== null) ||
      ![
        "form",
        "backendId",
        "targetKey",
        "operationId",
        "resourceUid",
        "generation",
        "leaseToken",
        "action",
      ].every((key) =>
        Object.hasOwn(Object.getOwnPropertyDescriptor(execution, key) ?? {}, "value"),
      ) ||
      !Reflect.ownKeys(execution).every(
        (key) =>
          typeof key === "string" &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(execution, key) ?? {}, "value"),
      )
    )
      return fail();
    const scope = matching[0]!;
    if (
      scope.operationId !== execution.operationId ||
      scope.resourceUid !== execution.resourceUid ||
      scope.generation !== execution.generation ||
      scope.leaseToken !== execution.leaseToken ||
      scope.action !== execution.action ||
      execution.form !== V2_CONTAINER_F2_FORM ||
      execution.backendId !== backendId ||
      execution.targetKey !== targetKey
    )
      return fail();
    return scope;
  }
  async function assertExecution(execution: V2Execution): Promise<void> {
    executionScope(execution);
    const rows = await sql.query(
      execution.action === "delete"
        ? `SELECT op.accepted_spec_json FROM tf_v2_operations op
            JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
            WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ? AND op.action = ?
              AND op.generation = ? AND op.backend_id = ? AND op.target_key = ? AND op.backend_key = ?
              AND op.lease_token = ? AND op.lease_until_ms > (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000
              AND op.status = 'reconciling' AND op.effect = 'unknown' AND op.dispatch_possible = 1
              AND resource.principal = op.principal AND resource.form_url = ? AND resource.space = ?
              AND resource.name = ? AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
              AND resource.generation = op.generation AND resource.last_operation = op.id AND resource.busy_operation = op.id
              AND resource.phase='deleting' AND resource.deleted_at IS NULL AND resource.spec_json = op.accepted_spec_json LIMIT 2`
        : `SELECT op.accepted_spec_json FROM tf_v2_operations op
            JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
            WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ? AND op.action = ?
              AND op.generation = ? AND op.backend_id = ? AND op.target_key = ? AND op.backend_key = ?
              AND op.lease_token = ? AND op.lease_until_ms > (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000
              AND op.status = 'reconciling' AND op.effect = 'unknown' AND op.dispatch_possible = 1
              AND resource.principal = op.principal AND resource.form_url = ? AND resource.space = ?
              AND resource.name = ? AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
              AND resource.generation = op.generation AND resource.last_operation = op.id AND resource.busy_operation = op.id
              AND resource.phase = 'pending' AND resource.deleted_at IS NULL AND resource.spec_json = op.accepted_spec_json LIMIT 2`,
      [
        execution.operationId,
        execution.resourceUid,
        execution.principal,
        execution.action,
        execution.generation,
        execution.backendId,
        execution.targetKey,
        execution.backendKey,
        execution.leaseToken,
        execution.form,
        execution.space,
        execution.name,
      ],
    );
    executionScope(execution);
    if (
      rows.length !== 1 ||
      typeof rows[0]?.accepted_spec_json !== "string" ||
      canonicalJson(JSON.parse(rows[0].accepted_spec_json)) !== canonicalJson(execution.spec)
    )
      fail();
  }
  function freezeJson(value: unknown): void {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freezeJson(child);
      Object.freeze(value);
    }
  }
  function publicSpec(raw: unknown): JsonObject {
    if (typeof raw !== "string") return fail();
    const parsed = parseStrictJson(new TextEncoder().encode(raw), 1048576);
    if (!isJsonObject(parsed)) return fail();
    validateDockerContainerSpec(parsed);
    freezeJson(parsed);
    return parsed;
  }
  async function assertSnapshot(proof: Proof): Promise<void> {
    const guard = fence(proof);
    const rows = await sql.query("SELECT 1 AS owner_current WHERE " + guard.sql, guard.params);
    if (rows.length !== 1 || rows[0]?.owner_current !== 1) return fail();
  }
  async function load(input: DockerContainerCreateIntent) {
    const intent = intentSnapshot(input);
    const identity = await canonicalDigest({
      installation: installationId,
      resource: intent.resourceUid,
      incarnation: intent.incarnationId,
      revision: intent.revision,
    });
    const nativeName = `takoserver-${identity.slice(7)}`;
    if (intent.identityLabel !== identity || intent.nativeName !== nativeName) return fail();
    const rows = await sql.query(select + " WHERE i.resource_uid=? AND v.generation=?", [
      intent.resourceUid,
      intent.policy.generation,
    ]);
    if (rows.length !== 1) return fail();
    const proof = rowProof(rows[0]!);
    validate(proof, intent);
    await configuredSnapshot(proof, "a");
    await configuredSnapshot(proof, "la");
    return { intent, proof };
  }
  const usable = (proof: Proof, phase: DockerContainerCreatePhase) =>
    phase === "remove"
      ? proof.i_retired_at_ms !== null ||
        (proof.i_serving_generation !== proof.v_generation &&
          proof.i_desired_generation !== proof.v_generation &&
          (proof.v_retention === "draining" || proof.v_retention === "retired"))
      : proof.i_retired_at_ms === null &&
        (proof.v_retention === "accepted" || proof.v_retention === "serving") &&
        (proof.i_desired_generation === proof.v_generation ||
          proof.i_serving_generation === proof.v_generation);
  function record(
    intent: DockerContainerCreateIntent,
    proof: Proof,
  ): DockerContainerCreateRecord | null {
    if (proof.q_claim_id === null) return null;
    if (
      !(
        (proof.q_state === "pending" && proof.q_native_id === null) ||
        ((proof.q_state === "bound" || proof.q_state === "removed") && hex(proof.q_native_id))
      )
    )
      return fail();
    return Object.freeze({
      claimId: proof.q_claim_id as string,
      intent,
      nativeId: proof.q_native_id as string | null,
      state: proof.q_state as DockerContainerCreateRecord["state"],
    });
  }
  function sameRecord(
    input: DockerContainerCreateRecord,
    saved: DockerContainerCreateRecord | null,
  ) {
    if (
      !saved ||
      input.claimId !== saved.claimId ||
      intentJson(input.intent) !== intentJson(saved.intent) ||
      (input.nativeId !== null && input.nativeId !== saved.nativeId) ||
      (input.state === "removed" && saved.state !== "removed")
    )
      return fail();
    return saved;
  }
  function retainedServing(lease: Lease, proof: Proof): boolean {
    const previous = lease.proof;
    return (
      lease.active &&
      !lease.controller.signal.aborted &&
      lease.phase !== "remove" &&
      lease.record.state === "bound" &&
      lease.record.nativeId !== null &&
      previous.q_state === "bound" &&
      proof.q_state === "bound" &&
      previous.q_claim_id === lease.record.claimId &&
      proof.q_claim_id === lease.record.claimId &&
      previous.q_native_id === lease.record.nativeId &&
      proof.q_native_id === lease.record.nativeId &&
      previous.i_retired_at_ms === null &&
      proof.i_retired_at_ms === null &&
      previous.i_serving_generation === lease.record.intent.policy.generation &&
      proof.i_serving_generation === lease.record.intent.policy.generation &&
      proof.v_retention === previous.v_retention &&
      [
        "i_resource_uid",
        "i_installation_id",
        "i_incarnation_id",
        "i_runtime_epoch",
        "i_retired_at_ms",
        "v_generation",
        "v_operation_id",
        "v_revision",
        "v_intent_json",
        "v_native_name",
      ].every((key) => proof[key] === previous[key]) &&
      Object.keys(previous)
        .filter((key) => key.startsWith("a_"))
        .every((key) => proof[key] === previous[key]) &&
      typeof proof.i_management_epoch === "number" &&
      typeof previous.i_management_epoch === "number" &&
      proof.i_management_epoch >= previous.i_management_epoch
    );
  }
  async function current(lease: Lease): Promise<boolean> {
    try {
      while (lease.active && !lease.controller.signal.aborted) {
        const publication = lease.servingPublication;
        if (publication?.pending) {
          await publication.finished;
          continue;
        }
        const loaded = await load(lease.record.intent);
        // A read already under way at publication can return either side of the
        // SQL commit. Re-read after the same owner finishes the handoff.
        if (publication !== lease.servingPublication) continue;
        const { intent, proof } = loaded;
        sameRecord(lease.record, record(intent, proof));
        if (
          !usable(proof, lease.phase) ||
          ["i_runtime_epoch", "i_incarnation_id", "i_retired_at_ms"].some(
            (key) => proof[key] !== lease.proof[key],
          )
        )
          throw new Error();
        if (
          ["i_management_epoch", "r_last_operation"].some((key) => proof[key] !== lease.proof[key])
        ) {
          if (!retainedServing(lease, proof)) throw new Error();
          lease.proof = proof;
        }
        return lease.active && !lease.controller.signal.aborted;
      }
    } catch {
      lease.controller.abort();
    }
    return false;
  }
  async function activeRecord(
    input: DockerContainerCreateRecord,
    phase?: DockerContainerCreatePhase,
  ) {
    const lease = [...leases].find(
      (item) =>
        item.active &&
        !item.controller.signal.aborted &&
        item.record.claimId === input.claimId &&
        intentJson(item.record.intent) === intentJson(input.intent) &&
        (phase === undefined || item.phase === phase),
    );
    if (!lease || !(await current(lease))) return fail();
    return lease;
  }

  const nativeKeys = [
    "backend",
    "installationId",
    "resourceUid",
    "incarnationId",
    "revision",
    "nativeId",
    "network",
    "networkId",
    "image",
    "imageId",
    "identityLabel",
    "revisionLabel",
  ] as const;
  const snapshotNative = (value: DockerContainerNativeIdentity) => {
    if (
      !own(value, nativeKeys) ||
      value.backend !== "docker" ||
      value.installationId !== installationId ||
      !nativeKeys.slice(1).every((key) => text(value[key])) ||
      !hex(value.nativeId) ||
      !hex(value.networkId) ||
      !encodedRevision(value.revision, Number(value.revision.split("-")[0])) ||
      !digest(value.imageId) ||
      !digest(value.identityLabel) ||
      !digest(value.revisionLabel)
    )
      return fail();
    return Object.freeze({ ...value });
  };
  async function boundNative(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    phase: "observe" | "remove" = "observe",
  ) {
    const captured = snapshotNative(native);
    if (!own(policy, policyKeys)) return fail();
    const selectedPolicy = Object.freeze({
      tenantRef: policy.tenantRef,
      generation: policy.generation,
      policyDigest: policy.policyDigest,
      outboundInternet: policy.outboundInternet,
    });
    if (
      !text(selectedPolicy.tenantRef) ||
      !digest(selectedPolicy.policyDigest) ||
      !Number.isSafeInteger(selectedPolicy.generation) ||
      selectedPolicy.generation < 1 ||
      typeof selectedPolicy.outboundInternet !== "boolean"
    )
      return fail();
    const rows = await sql.query(select + " WHERE i.resource_uid=? AND v.generation=?", [
      captured.resourceUid,
      selectedPolicy.generation,
    ]);
    if (rows.length !== 1 || typeof rows[0]?.v_intent_json !== "string") return fail();
    const parsed = parseStrictJson(new TextEncoder().encode(rows[0].v_intent_json), 1048576);
    if (!isJsonObject(parsed)) return fail();
    const loaded = await load(intentSnapshot(parsed as unknown as DockerContainerCreateIntent));
    const saved = record(loaded.intent, loaded.proof);
    if (
      !saved ||
      saved.state !== "bound" ||
      saved.nativeId !== captured.nativeId ||
      !usable(loaded.proof, phase) ||
      loaded.intent.installationId !== captured.installationId ||
      loaded.intent.resourceUid !== captured.resourceUid ||
      loaded.intent.incarnationId !== captured.incarnationId ||
      loaded.intent.revision !== captured.revision ||
      loaded.intent.identityLabel !== captured.identityLabel ||
      loaded.intent.revisionLabel !== captured.revisionLabel ||
      loaded.intent.policy.tenantRef !== selectedPolicy.tenantRef ||
      loaded.intent.policy.generation !== selectedPolicy.generation ||
      loaded.intent.policy.policyDigest !== selectedPolicy.policyDigest ||
      loaded.intent.policy.outboundInternet !== selectedPolicy.outboundInternet
    )
      return fail();
    return { native: captured, ...loaded, record: saved };
  }
  async function allocation(
    input: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    phase?: "remove",
  ) {
    if (phase !== undefined && phase !== "remove") return fail();
    const lease = await activeRecord(input, phase);
    const loaded = await boundNative(native, policy, phase ?? "observe");
    sameRecord(input, loaded.record);
    if (!(await current(lease))) return fail();
    return { ...loaded, lease };
  }
  type BoundStart = Pick<Awaited<ReturnType<typeof boundNative>>, "intent" | "proof" | "record">;
  async function boundStartRecord(input: DockerContainerCreateRecord): Promise<BoundStart> {
    if (input.state !== "bound" || !hex(input.nativeId)) return fail();
    const loaded = await load(input.intent);
    const saved = sameRecord(input, record(loaded.intent, loaded.proof));
    if (saved.state !== "bound" || saved.nativeId !== input.nativeId) return fail();
    return { ...loaded, record: saved };
  }
  async function boundInitPhase(loaded: BoundStart, guard?: ReturnType<typeof fence>) {
    const rows = await sql.query(
      "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?" +
        (guard === undefined ? "" : " AND " + guard.sql),
      [loaded.intent.resourceUid, loaded.intent.policy.generation, ...(guard?.params ?? [])],
    );
    if (rows.length === 0) return "unclaimed";
    const row = rows[0];
    if (rows.length !== 1 || !row) return fail();
    const claimed = row.claimed_at_ms,
      running = row.confirmed_running_at_ms,
      exited = row.confirmed_exited_at_ms;
    if (
      row.attempt !== 1 ||
      row.create_claim_id !== loaded.record.claimId ||
      row.native_id !== loaded.record.nativeId ||
      typeof claimed !== "number" ||
      !Number.isSafeInteger(claimed) ||
      claimed < 0 ||
      typeof running !== "number" ||
      !Number.isSafeInteger(running) ||
      running < claimed
    )
      return fail();
    if (row.state === "running" && exited === null) return "running";
    if (
      row.state === "exited" &&
      typeof exited === "number" &&
      Number.isSafeInteger(exited) &&
      exited >= running
    )
      return "exited";
    return fail();
  }
  async function loadServingOci(input: DockerContainerCreateRecord, signal: AbortSignal) {
    if (
      !own(input, ["claimId", "intent", "nativeId", "state"]) ||
      !hex(input.claimId) ||
      !hex(input.nativeId) ||
      input.state !== "bound" ||
      !(signal instanceof AbortSignal) ||
      signal.aborted
    )
      return fail();
    const captured = Object.freeze({
      claimId: input.claimId,
      intent: intentSnapshot(input.intent),
      nativeId: input.nativeId,
      state: "bound" as const,
    });
    const loaded = await boundStartRecord(captured);
    if (
      !usable(loaded.proof, "reconcile") ||
      loaded.proof.i_serving_generation !== captured.intent.policy.generation ||
      loaded.proof.v_retention !== "serving" ||
      loaded.proof.i_retired_at_ms !== null
    )
      return fail();
    return { captured, loaded };
  }
  async function startState(loaded: BoundStart) {
    const rows = await sql.query(
      "SELECT resource_uid,generation,attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?",
      [loaded.intent.resourceUid, loaded.intent.policy.generation],
    );
    if (rows.length === 0) return "unclaimed" as const;
    if (rows.length !== 1) return "unknown" as const;
    const row = rows[0]!;
    const claimedAt = row.claimed_at_ms;
    if (
      row.resource_uid !== loaded.intent.resourceUid ||
      row.generation !== loaded.intent.policy.generation ||
      row.attempt !== 1 ||
      row.create_claim_id !== loaded.record.claimId ||
      row.native_id !== loaded.record.nativeId ||
      typeof claimedAt !== "number" ||
      !Number.isSafeInteger(claimedAt) ||
      claimedAt < 0
    )
      return "unknown" as const;
    if (
      row.state === "pending" &&
      row.confirmed_running_at_ms === null &&
      row.confirmed_exited_at_ms === null
    )
      return "unknown" as const;
    const timestamp = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= claimedAt;
    if (
      row.state === "running" &&
      timestamp(row.confirmed_running_at_ms) &&
      row.confirmed_exited_at_ms === null
    )
      return "claimed" as const;
    if (
      row.state === "exited" &&
      timestamp(row.confirmed_exited_at_ms) &&
      (row.confirmed_running_at_ms === null ||
        (timestamp(row.confirmed_running_at_ms) &&
          row.confirmed_exited_at_ms >= row.confirmed_running_at_ms))
    )
      return "claimed" as const;
    return "unknown" as const;
  }
  async function samePendingAnchor(loaded: BoundStart, claimedAt: number) {
    const rows = await sql.query(
      "SELECT attempt FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=? AND attempt=1 AND create_claim_id=? AND native_id=? AND state='pending' AND claimed_at_ms=? AND confirmed_running_at_ms IS NULL AND confirmed_exited_at_ms IS NULL",
      [
        loaded.intent.resourceUid,
        loaded.intent.policy.generation,
        loaded.record.claimId,
        loaded.record.nativeId,
        claimedAt,
      ],
    );
    return rows.length === 1 && rows[0]?.attempt === 1;
  }
  async function claimBoundStart(
    loaded: BoundStart,
    lease: Lease,
  ): Promise<"claimed" | "already-claimed" | "unknown"> {
    if (
      !usable(loaded.proof, "reconcile") ||
      loaded.proof.i_desired_generation !== loaded.intent.policy.generation
    )
      return fail();
    const previous = await startState(loaded);
    if (previous !== "unclaimed") return previous === "claimed" ? "already-claimed" : "unknown";
    const guard = fence(loaded.proof);
    const claimedAt = now();
    if (!(await current(lease))) return fail();
    const write = await sql.run(
      "INSERT INTO tf_v2_container_start_attempts(resource_uid,generation,attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms) SELECT ?,?,1,?,?,'pending',?,NULL,NULL WHERE " +
        guard.sql +
        " AND NOT EXISTS (SELECT 1 FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?)",
      [
        loaded.intent.resourceUid,
        loaded.intent.policy.generation,
        loaded.record.claimId,
        loaded.record.nativeId,
        claimedAt,
        ...guard.params,
        loaded.intent.resourceUid,
        loaded.intent.policy.generation,
      ],
    );
    if (write.changes !== 0 && write.changes !== 1) return fail();
    if (!(await current(lease))) return fail();
    const after = await boundStartRecord(loaded.record);
    if (
      write.changes !== 1 ||
      !(await samePendingAnchor(after, claimedAt)) ||
      !(await current(lease))
    )
      return "unknown";
    // Pending is the durable, consumed pipeline anchor. This result authorizes
    // only this successful insertion's one pipeline; recovery never repeats it.
    return "claimed";
  }

  async function confirmBoundRunning(
    loaded: BoundStart,
    lease: Lease,
  ): Promise<"unclaimed" | "confirmed"> {
    const { intent, proof, record: saved } = loaded;
    const nativeId = saved.nativeId;
    if (!hex(nativeId)) return fail();
    const attemptSql =
      "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?";
    const attemptParams = [intent.resourceUid, intent.policy.generation];
    const attempts = await sql.query(attemptSql, attemptParams);
    // A running object with no START claim at all: there is no attempt to confirm.
    if (attempts.length === 0) return "unclaimed";
    const attempt = attempts[0];
    if (attempts.length !== 1 || !attempt) return fail();
    const claimedAt = attempt.claimed_at_ms;
    const confirmedRunningAt = attempt.confirmed_running_at_ms;
    const confirmedExitedAt = attempt.confirmed_exited_at_ms;
    if (
      attempt.attempt !== 1 ||
      attempt.create_claim_id !== saved.claimId ||
      attempt.native_id !== nativeId ||
      typeof claimedAt !== "number" ||
      !Number.isSafeInteger(claimedAt) ||
      claimedAt < 0
    )
      return fail();
    if (attempt.state === "running" || attempt.state === "exited") {
      // Already confirmed running (publishServing, or an earlier observation) or already
      // ended: idempotent, no write. An exited attempt is never un-exited: a running object
      // after the recorded exit is a restart, which is not this attempt's fact, and the
      // removal that follows stops it and finds the exit already recorded.
      if (
        typeof confirmedRunningAt !== "number" ||
        !Number.isSafeInteger(confirmedRunningAt) ||
        confirmedRunningAt < claimedAt ||
        (attempt.state === "running"
          ? confirmedExitedAt !== null
          : typeof confirmedExitedAt !== "number" ||
            !Number.isSafeInteger(confirmedExitedAt) ||
            confirmedExitedAt < confirmedRunningAt)
      )
        return fail();
      return "confirmed";
    }
    if (attempt.state !== "pending" || confirmedRunningAt !== null || confirmedExitedAt !== null)
      return fail();
    // now() is a non-negative safe integer; the schema needs running >= claimed.
    const runningAt = Math.max(claimedAt, now());
    const guard = fence(proof);
    if (!lease.active || lease.controller.signal.aborted) return fail();
    const write = await sql.run(
      "UPDATE tf_v2_container_start_attempts SET state='running',confirmed_running_at_ms=? WHERE resource_uid=? AND generation=? AND attempt=1 AND create_claim_id=? AND native_id=? AND state='pending' AND claimed_at_ms=? AND confirmed_running_at_ms IS NULL AND confirmed_exited_at_ms IS NULL AND " +
        guard.sql,
      [
        runningAt,
        intent.resourceUid,
        intent.policy.generation,
        saved.claimId,
        nativeId,
        claimedAt,
        ...guard.params,
      ],
    );
    if (write.changes !== 1) return fail();
    const after = await load(intent);
    const still = sameRecord(saved, record(after.intent, after.proof));
    const rows = await sql.query(attemptSql, attemptParams);
    const written = rows[0];
    if (
      still.nativeId !== nativeId ||
      still.state !== "bound" ||
      rows.length !== 1 ||
      !written ||
      written.attempt !== 1 ||
      written.create_claim_id !== saved.claimId ||
      written.state !== "running" ||
      written.native_id !== nativeId ||
      written.claimed_at_ms !== claimedAt ||
      written.confirmed_running_at_ms !== runningAt ||
      written.confirmed_exited_at_ms !== null ||
      !(await current(lease))
    )
      return fail();
    return "confirmed";
  }

  async function confirmBoundStopped(
    loaded: BoundStart,
    lease: Lease,
    local?: () => void,
  ): Promise<"unclaimed" | "confirmed"> {
    const { intent, proof, record: saved } = loaded;
    const nativeId = saved.nativeId;
    if (!hex(nativeId)) return fail();
    const attemptSql =
      "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?";
    const attemptParams = [intent.resourceUid, intent.policy.generation];
    const attempts = await sql.query(attemptSql, attemptParams);
    // Optional original Core lexical assertion, never caller-supplied facts.
    local?.();
    // Never started: there is no attempt to end, and confirmRemoved's own fence applies.
    if (attempts.length === 0) return "unclaimed";
    const attempt = attempts[0];
    if (attempts.length !== 1 || !attempt) return fail();
    const claimedAt = attempt.claimed_at_ms;
    const runningAt = attempt.confirmed_running_at_ms;
    if (
      attempt.attempt !== 1 ||
      attempt.create_claim_id !== saved.claimId ||
      attempt.native_id !== nativeId ||
      typeof claimedAt !== "number" ||
      !Number.isSafeInteger(claimedAt) ||
      claimedAt < 0
    )
      return fail();
    if (attempt.state === "exited") {
      // A previously recorded exit of this exact attempt: idempotent, no write.
      const exitedAt = attempt.confirmed_exited_at_ms;
      if (
        typeof runningAt !== "number" ||
        typeof exitedAt !== "number" ||
        !Number.isSafeInteger(runningAt) ||
        !Number.isSafeInteger(exitedAt) ||
        runningAt < claimedAt ||
        exitedAt < runningAt
      )
        return fail();
      return "confirmed";
    }
    // A never-confirmed (pending) attempt has no schema-legal exit: it stays refused.
    if (
      attempt.state !== "running" ||
      typeof runningAt !== "number" ||
      !Number.isSafeInteger(runningAt) ||
      runningAt < claimedAt ||
      attempt.confirmed_exited_at_ms !== null
    )
      return fail();
    const exitedAt = Math.max(runningAt, now());
    const guard = fence(proof);
    if (!lease.active || lease.controller.signal.aborted) return fail();
    local?.(); // no await between actual source/current assertion and SQL dispatch
    const write = await sql.run(
      "UPDATE tf_v2_container_start_attempts SET state='exited',confirmed_exited_at_ms=? WHERE resource_uid=? AND generation=? AND attempt=1 AND create_claim_id=? AND native_id=? AND state='running' AND claimed_at_ms=? AND confirmed_running_at_ms=? AND confirmed_exited_at_ms IS NULL AND " +
        guard.sql,
      [
        exitedAt,
        intent.resourceUid,
        intent.policy.generation,
        saved.claimId,
        nativeId,
        claimedAt,
        runningAt,
        ...guard.params,
      ],
    );
    if (write.changes !== 1) return fail();
    const after = await load(intent);
    const still = sameRecord(saved, record(after.intent, after.proof));
    const rows = await sql.query(attemptSql, attemptParams);
    const written = rows[0];
    if (
      still.nativeId !== nativeId ||
      still.state !== "bound" ||
      rows.length !== 1 ||
      !written ||
      written.state !== "exited" ||
      written.native_id !== nativeId ||
      written.confirmed_running_at_ms !== runningAt ||
      written.confirmed_exited_at_ms !== exitedAt ||
      !(await current(lease))
    )
      return fail();
    return "confirmed";
  }

  async function memberRecords(
    input: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    observedIds: readonly string[],
  ) {
    if (
      !Array.isArray(observedIds) ||
      observedIds.length > 4096 ||
      Object.keys(observedIds).length !== observedIds.length
    )
      return fail();
    const ids: string[] = [];
    for (let index = 0; index < observedIds.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(observedIds, String(index));
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !hex(descriptor.value) ||
        ids.includes(descriptor.value)
      )
        return fail();
      ids.push(descriptor.value);
    }
    const selected = await allocation(input, native, policy);
    const records: DockerContainerCreateRecord[] = [];
    for (const id of ids) {
      if (!(await current(selected.lease))) return fail();
      const rows = await sql.query(select + " WHERE q.installation_id=? AND q.native_id=?", [
        installationId,
        id,
      ]);
      if (rows.length !== 1 || typeof rows[0]?.v_intent_json !== "string") return fail();
      const parsed = parseStrictJson(new TextEncoder().encode(rows[0].v_intent_json), 1048576);
      if (!isJsonObject(parsed)) return fail();
      const loaded = await load(intentSnapshot(parsed as unknown as DockerContainerCreateIntent));
      const saved = record(loaded.intent, loaded.proof);
      if (
        !saved ||
        saved.state !== "bound" ||
        saved.nativeId !== id ||
        !(usable(loaded.proof, "observe") || usable(loaded.proof, "remove"))
      )
        return fail();
      records.push(saved);
    }
    if (!(await current(selected.lease))) return fail();
    // These are current SQL facts. Callers must enter the original observe authority
    // for each record and verify its actual native/kernel state before attachment.
    return Object.freeze(records);
  }

  // Internal continuations come only from the two original producers below.
  // They are never supplied through a public owner port or registration API.
  async function publishBoundServing(
    lease: Lease,
    verify: () => Promise<void>,
    reload: () => Promise<BoundStart>,
    beforePublish?: () => void,
  ): Promise<void> {
    await verify();
    if (!(await current(lease))) return fail();
    const before = await reload();
    const nativeId = before.record.nativeId;
    if (!hex(nativeId)) return fail();
    const attempts = await sql.query(
      "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?",
      [before.intent.resourceUid, before.intent.policy.generation],
    );
    if (attempts.length !== 1) return fail();
    const attempt = attempts[0]!;
    const claimedAt = attempt.claimed_at_ms;
    if (
      attempt.attempt !== 1 ||
      attempt.create_claim_id !== before.record.claimId ||
      attempt.native_id !== nativeId ||
      typeof claimedAt !== "number" ||
      !Number.isSafeInteger(claimedAt) ||
      claimedAt < 0 ||
      attempt.confirmed_exited_at_ms !== null ||
      (attempt.state !== "pending" && attempt.state !== "running")
    )
      return fail();
    const runningAt = attempt.state === "pending" ? now() : attempt.confirmed_running_at_ms;
    if (
      typeof runningAt !== "number" ||
      !Number.isSafeInteger(runningAt) ||
      runningAt < claimedAt ||
      (attempt.state === "pending" && attempt.confirmed_running_at_ms !== null)
    )
      return fail();
    if (before.proof.i_serving_generation === before.intent.policy.generation) {
      if (before.proof.v_retention !== "serving" || attempt.state !== "running") return fail();
      await verify();
      if (!(await current(lease))) return fail();
      return;
    }
    const oldEpoch = before.proof.i_runtime_epoch;
    if (typeof oldEpoch !== "number" || !Number.isSafeInteger(oldEpoch + 1)) return fail();
    await verify();
    if (!(await current(lease))) return fail();
    const guard = fence(before.proof);
    const statements: SqlStatement[] = [];
    if (attempt.state === "pending")
      statements.push({
        sql:
          "UPDATE tf_v2_container_start_attempts SET state='running',confirmed_running_at_ms=? WHERE resource_uid=? AND generation=? AND attempt=1 AND create_claim_id=? AND native_id=? AND state='pending' AND claimed_at_ms=? AND confirmed_running_at_ms IS NULL AND confirmed_exited_at_ms IS NULL AND " +
          guard.sql,
        params: [
          runningAt,
          before.intent.resourceUid,
          before.intent.policy.generation,
          before.record.claimId,
          nativeId,
          claimedAt,
          ...guard.params,
        ],
      });
    statements.push({
      sql:
        "UPDATE tf_v2_container_instances SET serving_generation=?,runtime_epoch=runtime_epoch+1 WHERE resource_uid=? AND " +
        guard.sql +
        " AND EXISTS (SELECT 1 FROM tf_v2_container_start_attempts s WHERE s.resource_uid=? AND s.generation=? AND s.attempt=1 AND s.create_claim_id=? AND s.native_id=? AND s.state='running' AND s.claimed_at_ms=? AND s.confirmed_running_at_ms=? AND s.confirmed_exited_at_ms IS NULL)",
      params: [
        before.intent.policy.generation,
        before.intent.resourceUid,
        ...guard.params,
        before.intent.resourceUid,
        before.intent.policy.generation,
        before.record.claimId,
        nativeId,
        claimedAt,
        runningAt,
      ],
    });
    const intentKey = intentJson(before.intent);
    const matched = [...leases].filter(
      (held) =>
        held.active &&
        !held.controller.signal.aborted &&
        held.phase !== "remove" &&
        held.record.state === "bound" &&
        held.record.claimId === before.record.claimId &&
        held.record.nativeId === nativeId &&
        intentJson(held.record.intent) === intentKey &&
        [
          "i_management_epoch",
          "i_runtime_epoch",
          "i_desired_generation",
          "i_serving_generation",
          "r_last_operation",
          "v_operation_id",
          "v_retention",
          "q_claim_id",
          "q_native_id",
        ].every((key) => held.proof[key] === before.proof[key]),
    );
    if (!matched.includes(lease) || matched.some((held) => held.servingPublication?.pending))
      return fail();
    let finish = () => {};
    const publication: ServingPublication = {
      pending: true,
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    // The OCI loan can revoke during the final current/load SQL await.
    // Its original lexical fence still precedes the write synchronously.
    beforePublish?.();
    for (const held of matched) held.servingPublication = publication;
    try {
      const writes = await sql.batch(statements);
      if (writes.length !== statements.length || writes.some((write) => write.changes !== 1))
        return fail();
      const after = await reload();
      if (
        after.proof.i_serving_generation !== before.intent.policy.generation ||
        after.proof.i_runtime_epoch !== oldEpoch + 1 ||
        after.proof.i_management_epoch !== before.proof.i_management_epoch ||
        after.proof.i_desired_generation !== before.proof.i_desired_generation ||
        after.proof.r_last_operation !== before.proof.r_last_operation ||
        after.proof.v_operation_id !== before.proof.v_operation_id ||
        after.proof.v_retention !== "serving" ||
        intentJson(after.intent) !== intentKey ||
        after.record.claimId !== before.record.claimId ||
        after.record.nativeId !== nativeId ||
        !lease.active ||
        lease.controller.signal.aborted
      )
        return fail();
      for (const held of matched) {
        if (held.active && !held.controller.signal.aborted) held.proof = after.proof;
      }
    } catch (error) {
      for (const held of matched) held.controller.abort();
      throw error;
    } finally {
      publication.pending = false;
      finish();
    }
    // These full checks may themselves read one of the advanced leases.
    await verify();
    if (!(await current(lease))) return fail();
  }

  const owner: DockerPhysicalCoreOwnerPort = Object.freeze<DockerPhysicalCoreOwnerPort>({
    async publishServing(input, native, policy, runtime) {
      const selected = await allocation(input, native, policy);
      const lease = await activeRecord(input, "reconcile");
      if (
        selected.proof.i_desired_generation !== selected.intent.policy.generation ||
        selected.proof.i_retired_at_ms !== null ||
        (!(runtime instanceof DockerContainerRuntimePreparation) &&
          !(runtime instanceof LinuxDockerRuntimePreparation)) ||
        !Object.isFrozen(runtime)
      )
        return fail();
      const descriptor = Object.getOwnPropertyDescriptor(runtime, "policy");
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !own(descriptor.value, policyKeys) ||
        !Object.isFrozen(descriptor.value) ||
        descriptor.value.tenantRef !== selected.intent.policy.tenantRef ||
        descriptor.value.generation !== selected.intent.policy.generation ||
        descriptor.value.policyDigest !== selected.intent.policy.policyDigest ||
        descriptor.value.outboundInternet !== selected.intent.policy.outboundInternet
      )
        return fail();
      // The original runtime instance obtains the verification guard itself.
      // No caller-supplied callback, receipt DTO, or readiness flag grants cutover.
      const runtimeGuard =
        runtime instanceof LinuxDockerRuntimePreparation
          ? await verifyLinuxRuntime.call(runtime, selected.native)
          : await verifyOriginalRuntime.call(runtime, selected.native);
      await publishBoundServing(lease, runtimeGuard, () =>
        boundNative(selected.native, selected.intent.policy),
      );
    },

    async readStartClaim(native, policy) {
      return startState(await boundNative(native, policy));
    },
    async claimStart(native, policy) {
      const loaded = await boundNative(native, policy);
      const lease = await activeRecord(loaded.record, "reconcile");
      return claimBoundStart(loaded, lease);
    },
    async assertNetworkAllocation(input, native, policy, phase) {
      await allocation(input, native, policy, phase);
    },
    async readNetworkMemberRecords(input, native, policy, observedIds) {
      return memberRecords(input, native, policy, observedIds);
    },
    async assertNetworkMembers(input, native, policy, observedIds) {
      await memberRecords(input, native, policy, observedIds);
    },

    async read(input) {
      const { intent, proof } = await load(input);
      return record(intent, proof);
    },
    async claim(input) {
      const { intent, proof } = await load(input);
      if (!usable(proof, "reconcile") || proof.i_desired_generation !== intent.policy.generation)
        return fail();
      const previous = record(intent, proof);
      if (previous)
        return { status: previous.state === "pending" ? "unknown" : "existing", record: previous };
      const serialized = intentJson(intent);
      const expected = { ...proof, v_intent_json: serialized, v_native_name: intent.nativeName };
      const statements: SqlStatement[] = [];
      if (proof.v_intent_json === null) {
        const guard = fence(proof);
        statements.push({
          sql:
            "UPDATE tf_v2_container_revisions SET intent_json=?,native_name=? WHERE resource_uid=? AND generation=? AND intent_json IS NULL AND native_name IS NULL AND " +
            guard.sql,
          params: [
            serialized,
            intent.nativeName,
            intent.resourceUid,
            intent.policy.generation,
            ...guard.params,
          ],
        });
      }
      const claimId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const guard = fence(expected);
      statements.push({
        sql:
          (parentMode !== undefined
            ? "INSERT INTO tf_v2_container_create_claims(resource_uid,generation,installation_id,claim_id,state,native_id,claimed_at_ms,bound_at_ms,removed_at_ms,native_control) SELECT ?,?,?,?,'pending',NULL,?,NULL,NULL,'" +
              V2_CONTAINER_CONTROL_RESERVED +
              "' WHERE "
            : "INSERT INTO tf_v2_container_create_claims(resource_uid,generation,installation_id,claim_id,state,native_id,claimed_at_ms,bound_at_ms,removed_at_ms) SELECT ?,?,?,?,'pending',NULL,?,NULL,NULL WHERE ") +
          guard.sql +
          " ON CONFLICT(resource_uid,generation) DO NOTHING",
        params: [
          intent.resourceUid,
          intent.policy.generation,
          installationId,
          claimId,
          now(),
          ...guard.params,
        ],
      });
      const writes = await sql.batch(statements);
      if (
        writes.length !== statements.length ||
        writes.some((write) => write.changes !== 0 && write.changes !== 1)
      )
        return fail();
      const after = await load(intent);
      const saved = record(after.intent, after.proof);
      if (!saved) return fail();
      const status =
        saved.claimId === claimId && writes.at(-1)!.changes === 1
          ? "won"
          : saved.state === "pending"
            ? "unknown"
            : "existing";
      if (status === "won" && parentMode !== undefined) freshControlClaims.add(saved);
      return { status, record: saved };
    },
    async withAuthority(input, phase, use) {
      if (!["reconcile", "observe", "remove"].includes(phase) || typeof use !== "function")
        return fail();
      const { intent, proof } = await load(input.intent);
      const saved = sameRecord(input, record(intent, proof));
      if (!usable(proof, phase) || (saved.state === "removed" && phase !== "remove")) return fail();
      const lease: Lease = {
        record: saved,
        phase,
        proof,
        controller: new AbortController(),
        active: true,
      };
      leases.add(lease);
      const guard = async () => {
        if (!(await current(lease))) return fail();
      };
      try {
        await guard();
        let environmentCurrent: (() => Promise<void>) | undefined;
        const secretCurrent = async () => {
          if (!(await current(lease))) return false;
          try {
            if (environmentCurrent) await environmentCurrent();
            return lease.active && !lease.controller.signal.aborted;
          } catch {
            lease.controller.abort();
            return false;
          }
        };
        const held = Object.freeze({
          revocation: lease.controller.signal,
          stillCurrent: lease.proof.i_form_url === C.formUrl ? () => current(lease) : secretCurrent,
          async withEnvironment<T>(
            useEnvironment: (
              values: Readonly<Record<string, string>>,
              signal: AbortSignal,
            ) => Promise<T>,
          ): Promise<T> {
            await guard();
            if (lease.proof.i_form_url === V2_CONTAINER_F2_FORM) {
              if (
                !configuredInputs ||
                lease.phase !== "reconcile" ||
                typeof useEnvironment !== "function"
              )
                return fail();
              const selected = [...executions].filter(
                (scope) =>
                  scope.operationId === lease.proof.a_operation_id &&
                  scope.resourceUid === saved.intent.resourceUid &&
                  scope.generation === saved.intent.policy.generation &&
                  scope.execution.operationId === scope.operationId &&
                  scope.execution.resourceUid === scope.resourceUid &&
                  scope.execution.generation === scope.generation &&
                  scope.execution.leaseToken === scope.leaseToken,
              );
              if (selected.length !== 1) return fail();
              const scope = selected[0]!;
              let result: T | undefined;
              await configuredInputs.withAcceptedInputs(
                { execution: scope.execution, record: saved },
                async (values, signal, assertCurrent) => {
                  if (environmentCurrent) return fail();
                  environmentCurrent = assertCurrent;
                  const loan = new AbortController();
                  const revoke = () => loan.abort();
                  lease.controller.signal.addEventListener("abort", revoke, { once: true });
                  signal.addEventListener("abort", revoke, { once: true });
                  if (lease.controller.signal.aborted || signal.aborted) loan.abort();
                  const check = async () => {
                    if (!executions.has(scope) || loan.signal.aborted) return fail();
                    await guard();
                    await assertCurrent();
                    if (!executions.has(scope) || loan.signal.aborted) return fail();
                  };
                  try {
                    await check();
                    result = await useEnvironment(values, loan.signal);
                    await check();
                  } finally {
                    environmentCurrent = undefined;
                    loan.abort();
                    signal.removeEventListener("abort", revoke);
                    lease.controller.signal.removeEventListener("abort", revoke);
                  }
                },
              );
              await guard();
              return result as T;
            }

            if (
              saved.intent.requiredSecretNames.length !== 0 ||
              typeof useEnvironment !== "function"
            )
              return fail();
            const loan = new AbortController();
            const revoke = () => loan.abort();
            lease.controller.signal.addEventListener("abort", revoke, { once: true });
            if (lease.controller.signal.aborted) loan.abort();
            try {
              await guard();
              const value = await useEnvironment(
                Object.freeze(Object.create(null) as Record<string, string>),
                loan.signal,
              );
              await guard();
              if (loan.signal.aborted) return fail();
              return value;
            } finally {
              loan.abort();
              lease.controller.signal.removeEventListener("abort", revoke);
            }
          },
        });
        const result = await use(held);
        await guard();
        return result;
      } finally {
        lease.active = false;
        lease.controller.abort();
        leases.delete(lease);
      }
    },
    async bindNative(input, nativeId) {
      if (!hex(nativeId)) return fail();
      const lease = await activeRecord(input);
      const { intent, proof } = await load(input.intent);
      const saved = sameRecord(input, record(intent, proof));
      if (saved.nativeId === nativeId && saved.state === "bound") return;
      if (
        saved.state !== "pending" ||
        saved.nativeId !== null ||
        !(lease.phase === "remove" ? usable(proof, "remove") : usable(proof, "reconcile"))
      )
        return fail();
      const guard = fence(proof);
      if (!lease.active || lease.controller.signal.aborted) return fail();
      const write = await sql.run(
        "UPDATE tf_v2_container_create_claims SET state='bound',native_id=?,bound_at_ms=? WHERE resource_uid=? AND generation=? AND claim_id=? AND state='pending' AND native_id IS NULL AND " +
          guard.sql,
        [
          nativeId,
          now(),
          intent.resourceUid,
          intent.policy.generation,
          saved.claimId,
          ...guard.params,
        ],
      );
      if (write.changes !== 1) return fail();
      const after = await load(intent);
      const bound = sameRecord(input, record(after.intent, after.proof));
      if (bound.nativeId !== nativeId || bound.state !== "bound") return fail();
    },
    async confirmRunning(input, observation) {
      const lease = await activeRecord(input, "remove");
      // The custody names the exact native object it just inspected and the positive Running=true
      // it saw; like confirmStopped, the owner cannot see Docker and trusts the custody that
      // holds a live remove lease for this claim. This records ONLY the schema's own
      // pending -> running of the exact start attempt, at the owner time of the observation:
      // "observed running no later than then", not the native START time, not health and not
      // serving. It never writes the instance, the serving generation or the retention. What keeps
      // such a running attempt from ever meeting the schema's serving precondition (a running
      // attempt of an accepted/serving revision of a non-retired instance) is that a remove
      // authority exists only for a retired instance (frozen by instance_transition) or for a
      // draining/retired revision (retention only moves forward), and that publishServing needs
      // the desired, non-retired generation. If a future change ever lets either be undone, this
      // running would satisfy that precondition without any health check.
      // The owner compares the claim's native ID and the stored intent's identity; network,
      // networkId, image and imageId are format-checked only, because the owner cannot see Docker.
      if (!own(observation, ["native", "state"]) || observation.state !== "running") return fail();
      const native = snapshotNative(observation.native as DockerContainerNativeIdentity);
      const { intent, proof } = await load(input.intent);
      const saved = sameRecord(input, record(intent, proof));
      if (
        saved.state !== "bound" ||
        saved.nativeId !== native.nativeId ||
        !usable(proof, "remove") ||
        native.installationId !== intent.installationId ||
        native.resourceUid !== intent.resourceUid ||
        native.incarnationId !== intent.incarnationId ||
        native.revision !== intent.revision ||
        native.identityLabel !== intent.identityLabel ||
        native.revisionLabel !== intent.revisionLabel
      )
        return fail();
      await confirmBoundRunning({ intent, proof, record: saved }, lease);
    },
    async confirmStopped(input, observation) {
      const lease = await activeRecord(input, "remove");
      // The custody names the exact native object it inspected and the positive state it
      // saw. The owner cannot see Docker: like bindNative and confirmRemoved, it trusts the
      // custody that holds a live remove lease for this claim, so that observation is part of
      // the trust boundary. What the owner does check: the identity against the stored intent
      // and the bound native ID, and that the exit is written for the exact running attempt
      // under the same accepted-state fence as every other transition.
      if (!own(observation, ["native", "state"]) || observation.state !== "stopped") return fail();
      const native = snapshotNative(observation.native as DockerContainerNativeIdentity);
      const { intent, proof } = await load(input.intent);
      const saved = sameRecord(input, record(intent, proof));
      if (
        saved.state !== "bound" ||
        saved.nativeId !== native.nativeId ||
        !usable(proof, "remove") ||
        native.installationId !== intent.installationId ||
        native.resourceUid !== intent.resourceUid ||
        native.incarnationId !== intent.incarnationId ||
        native.revision !== intent.revision ||
        native.identityLabel !== intent.identityLabel ||
        native.revisionLabel !== intent.revisionLabel
      )
        return fail();
      await confirmBoundStopped({ intent, proof, record: saved }, lease);
    },
    async confirmRemoved(input, nativeId) {
      return confirmRemoved(input, nativeId);
    },
  });
  async function confirmRemoved(
    input: DockerContainerCreateRecord,
    nativeId: string,
    local?: () => void,
    execution?: V2Execution,
  ) {
    if (!hex(nativeId)) return fail();
    const lease = await activeRecord(input, "remove");
    const { intent, proof } = await load(input.intent);
    const saved = sameRecord(input, record(intent, proof));
    if (saved.nativeId !== nativeId || !usable(proof, "remove")) return fail();
    if (saved.state === "removed") return;
    if (saved.state !== "bound") return fail();
    const guard = fence(proof);
    if (execution) await assertExecution(execution);
    if (!lease.active || lease.controller.signal.aborted) return fail();
    local?.();
    if (execution) executionScope(execution);
    const write = await sql.run(
      "UPDATE tf_v2_container_create_claims SET state='removed',removed_at_ms=? WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND " +
        guard.sql +
        (execution
          ? " AND EXISTS (SELECT 1 FROM tf_v2_operations op WHERE op.id=? AND op.resource_uid=? AND op.lease_token=? AND op.lease_until_ms>(CAST(strftime('%s','now') AS INTEGER)+1)*1000 AND op.status='reconciling' AND op.effect='unknown' AND op.dispatch_possible=1)"
          : ""),
      [
        now(),
        intent.resourceUid,
        intent.policy.generation,
        saved.claimId,
        nativeId,
        ...guard.params,
        ...(execution ? [execution.operationId, execution.resourceUid, execution.leaseToken] : []),
      ],
    );
    if (write.changes !== 1) return fail();
    const after = await load(intent);
    const removed = sameRecord(input, record(after.intent, after.proof));
    if (removed.nativeId !== nativeId || removed.state !== "removed") return fail();
    if (execution) {
      await assertExecution(execution);
      executionScope(execution);
    }
    local?.();
  }
  function retainedNamespace(
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
    mode: "release" | "observe",
  ): Promise<LinuxOciNamespaceLifetimeObservation>;
  function retainedNamespace(
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
    mode: "dispose",
  ): Promise<LinuxOciDisposalProgress>;
  function retainedNamespace(
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
    mode: "allocation",
  ): Promise<LinuxOciAllocationDisposalObservation>;
  async function retainedNamespace(
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
    mode: "release" | "observe" | "dispose" | "allocation",
  ): Promise<LinuxOciDisposalProgress | LinuxOciAllocationDisposalObservation> {
    if (
      !own(input, ["claimId", "intent", "nativeId", "state"]) ||
      !hex(input.claimId) ||
      !hex(input.nativeId) ||
      input.state !== "bound" ||
      signal.aborted
    )
      return fail();
    const captured = Object.freeze({
      claimId: input.claimId,
      intent: intentSnapshot(input.intent),
      nativeId: input.nativeId,
      state: "bound" as const,
    });
    const accepted = await result.readAcceptedExecution(execution);
    if (accepted.action !== "update" && accepted.action !== "delete") return fail();
    const retained = accepted.retained.find(({ record }) => record.claimId === captured.claimId);
    if (
      !retained ||
      retained.removedAtMs !== null ||
      captured.intent.policy.generation >= accepted.generation ||
      canonicalJson(retained.record) !== canonicalJson(captured)
    )
      return fail();
    const lease = await activeRecord(captured, "remove");
    let loaded = await boundStartRecord(captured);
    if (!usable(loaded.proof, "remove")) return fail();
    const guard = async () => {
      await assertExecution(execution);
      if (
        signal.aborted ||
        !(await current(lease)) ||
        !lease.active ||
        lease.controller.signal.aborted ||
        !leases.has(lease)
      )
        return fail();
      executionScope(execution);
    };
    const startPhase = async () => {
      const phase = await boundInitPhase(loaded);
      return phase === "unclaimed" ? fail() : phase;
    };
    await guard();
    const phase = await startPhase();
    await guard();
    if (phase === "running") {
      if (mode === "observe" || mode === "allocation") return fail();
      // The existing original reap producer owns STOP/JOIN and the exit CAS.
      // Neither this read nor a namespace snapshot can manufacture an exit.
      await result.stopRetainedInit(execution, captured, originalCustody, signal);
      loaded = await boundStartRecord(captured);
      if ((await startPhase()) !== "exited") return fail();
      await guard();
    }
    let observation: LinuxOciDisposalProgress | LinuxOciAllocationDisposalObservation;
    if (mode === "allocation") {
      await prepareOriginalLinuxOciAllocationDisposal(originalCustody, result, captured, signal);
      await guard();
      // A delayed remove-current read may have started before a new Engine
      // lease replaced this execution. Reread the original execution itself.
      await assertExecution(execution);
      // No await from this actual Core fence through the original class's
      // synchronous private-fact check and the first filesystem dispatch.
      if (signal.aborted || !lease.active || lease.controller.signal.aborted || !leases.has(lease))
        return fail();
      executionScope(execution);
      observation = await disposeOriginalLinuxOciAllocation(
        originalCustody,
        result,
        captured,
        signal,
      );
    } else
      observation = await (mode === "dispose"
        ? advanceOriginalLinuxOciOwnedDisposal(originalCustody, result, captured, signal)
        : mode === "release"
          ? releaseOriginalLinuxOciOwnedNamespace(originalCustody, result, captured, signal)
          : observeOriginalLinuxOciOwnedNamespaceLifetime(
              originalCustody,
              result,
              captured,
              signal,
            ));
    await guard();
    // No final await after the local execution/lease/cancel fence.
    if (signal.aborted || !lease.active || lease.controller.signal.aborted || !leases.has(lease))
      return fail();
    executionScope(execution);
    return observation;
  }
  async function applicationCloseScope(
    original: unknown,
    proof: Proof,
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    raw: string,
  ) {
    const operation = Object.freeze({
      operationId: execution.operationId,
      action: execution.action,
      generation: execution.generation,
      resourceUid: execution.resourceUid,
      principal: proof.la_principal,
      space: proof.la_space,
      name: proof.la_name,
      form: proof.la_form_url,
      backendId: proof.la_backend_id,
      targetKey: proof.la_target_key,
      backendKey: proof.la_backend_key,
      acceptedFingerprint: proof.la_fingerprint,
      revision: proof.la_revision,
    });
    return Object.freeze({
      purpose: "takoserver.linux-oci-application-io-close@1",
      original,
      nativeId: input.nativeId,
      controlDigest: await canonicalDigest(raw),
      operation,
    });
  }
  const applicationCloseKind = "linux-oci-sealed-application-io-close@1";
  const shutdownIoCloseKind = "linux-oci-sealed-host-shutdown-io-close@1";
  const reconcilerLeaseSql =
    " AND EXISTS (SELECT 1 FROM tf_v2_operations WHERE id=? AND resource_uid=? AND lease_token=? AND lease_until_ms > (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000 AND status='reconciling' AND effect='unknown' AND dispatch_possible=1)";
  type ApplicationCloseKind = typeof applicationCloseKind | typeof shutdownIoCloseKind;
  async function shutdownIoScope(input: DockerContainerCreateRecord, raw: string) {
    return {
      purpose: "takoserver.linux-oci-host-shutdown-io-close@1",
      resourceUid: input.intent.resourceUid,
      incarnationId: input.intent.incarnationId,
      installationId,
      generation: input.intent.policy.generation,
      claimId: input.claimId,
      nativeId: input.nativeId,
      controlDigest: await canonicalDigest(raw),
    };
  }
  async function sealApplicationCloseFact(ioScope: unknown, kind: ApplicationCloseKind) {
    const selection = controlKeyring?.current;
    if (!selection || !controlDecryptionKey) return fail();
    const { id: keyId, key } = selection;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(keyId) || !isContainerSecretKey(key))
      return fail();
    const assertCurrent = () => {
      if (controlDecryptionKey(keyId) !== key) return fail();
    };
    assertCurrent();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const closed = new TextEncoder().encode(
      '{"kind":"linux-oci-original-application-io-closed@1"}',
    );
    try {
      const ciphertext = new Uint8Array(
        await encryptContainerSecretBytes(
          key,
          nonce,
          closed,
          new TextEncoder().encode(canonicalJson(ioScope)),
        ),
      );
      assertCurrent();
      return {
        document: canonicalJson({
          kind,
          scope: ioScope,
          keyId,
          nonce: encodeContainerSecretBytes(nonce),
          ciphertext: encodeContainerSecretBytes(ciphertext),
        }),
        assertCurrent,
      };
    } finally {
      closed.fill(0);
    }
  }
  async function readApplicationCloseFact(
    document: unknown,
    ioScope: unknown,
    kind: ApplicationCloseKind = applicationCloseKind,
  ) {
    if (
      !controlDecryptionKey ||
      typeof document !== "string" ||
      document === V2_CONTAINER_APPLICATION_IO_RESERVED ||
      document.length > 65536
    )
      return fail();
    const lookup = controlDecryptionKey;
    const sealed = parseStrictJson(new TextEncoder().encode(document), 65536);
    if (
      !own(sealed, ["kind", "scope", "keyId", "nonce", "ciphertext"]) ||
      sealed.kind !== kind ||
      canonicalJson(sealed) !== document ||
      canonicalJson(sealed.scope) !== canonicalJson(ioScope) ||
      typeof sealed.keyId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sealed.keyId) ||
      typeof sealed.nonce !== "string" ||
      typeof sealed.ciphertext !== "string"
    )
      return fail();
    const keyId = sealed.keyId,
      key = lookup(keyId),
      nonce = decodeContainerSecretBytes(sealed.nonce),
      encrypted = decodeContainerSecretBytes(sealed.ciphertext);
    if (
      !isContainerSecretKey(key) ||
      nonce.length !== 12 ||
      encrypted.length < 16 ||
      encrypted.length > 65536
    )
      return fail();
    const closed = await decryptContainerSecretBytes(
      key,
      nonce,
      encrypted,
      new TextEncoder().encode(canonicalJson(ioScope)),
    );
    try {
      if (
        new TextDecoder("utf-8", { fatal: true }).decode(closed) !==
        '{"kind":"linux-oci-original-application-io-closed@1"}'
      )
        return fail();
    } finally {
      closed.fill(0);
    }
    return () => {
      if (lookup(keyId) !== key) return fail();
    };
  }
  async function retiredApplicationFact(
    document: unknown,
    original: unknown,
    proof: Proof,
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    raw: string,
  ) {
    if (typeof document !== "string" || document.length > 65536) return fail();
    const sealed = parseStrictJson(new TextEncoder().encode(document), 65536);
    if (
      !isJsonObject(sealed) ||
      !isJsonObject(sealed.scope) ||
      !isJsonObject(sealed.scope.operation)
    )
      return fail();
    const id = sealed.scope.operation.operationId;
    if (id === execution.operationId) {
      const local = await readApplicationCloseFact(
        document,
        await applicationCloseScope(original, proof, execution, input, raw),
      );
      return {
        local,
        refresh: async () => {
          local();
        },
        snapshot: { sql: "1", params: [] } satisfies SqlStatement,
      };
    }
    // Untrusted envelope selects a historical row only. A pending accepted
    // UPDATE may reuse a genuinely removed old slot; its own authority stays
    // current independently of that historical close and its old lease.
    const currentUpdate =
      execution.action === "update" &&
      proof.la_operation_id === execution.operationId &&
      proof.la_action === "update" &&
      proof.la_generation === execution.generation &&
      proof.r_last_operation === execution.operationId &&
      proof.r_phase === "pending" &&
      proof.i_desired_generation === execution.generation &&
      proof.i_retire_operation_id === null &&
      proof.i_retired_at_ms === null &&
      proof.q_state === "removed" &&
      usable(proof, "remove");
    if (
      !text(id) ||
      (execution.action !== "delete" && !currentUpdate) ||
      !(await inspectV2ContainerOwnerHistoricalDeleteSchema(sql))
    )
      return fail();
    const historyFields = [
      ...columns.a
        .filter((name) => name !== "configured_private_inputs_json")
        .map((name) => ({ column: "ha." + name, key: "a_" + name })),
      ...columns.o.map((name) => ({ column: "ho." + name, key: "o_" + name })),
      { column: "ho.effect", key: "o_effect" },
    ];
    const historyFrom =
      " FROM tf_v2_container_acceptances ha JOIN tf_v2_operations ho ON ho.id=ha.operation_id JOIN tf_v2_container_revisions hv ON hv.operation_id=ha.operation_id AND hv.resource_uid=ha.resource_uid AND hv.generation=ha.generation AND hv.revision=ha.revision" +
      " WHERE ha.operation_id=? AND ha.resource_uid=? AND ha.installation_id=? AND ha.incarnation_id=? AND ha.principal=? AND ha.space=? AND ha.name=? AND ha.form_url=? AND ha.backend_id=? AND ha.target_key=?" +
      " AND ha.action='update' AND ha.generation>? AND ha.generation<? AND ho.status='succeeded' AND ho.effect='complete'" +
      " AND ho.resource_uid=ha.resource_uid AND ho.principal=ha.principal AND ho.action=ha.action AND ho.generation=ha.generation AND ho.backend_id=ha.backend_id AND ho.target_key=ha.target_key AND ho.backend_key=ha.backend_key AND ho.replay_key=ha.replay_key AND ho.request_fingerprint=ha.fingerprint AND ho.accepted_spec_json=ha.accepted_spec_json AND ho.created_at=ha.accepted_at";
    const identity = ["principal", "space", "name", "form_url"].map((name) => {
      const value = proof["i_" + name];
      if (!text(value)) return fail();
      return value;
    });
    const params: SqlParam[] = [
      id,
      input.intent.resourceUid,
      installationId,
      input.intent.incarnationId,
      ...identity,
      backendId,
      targetKey,
      input.intent.policy.generation,
      execution.generation,
    ];
    const query =
      "SELECT " +
      historyFields.map((field) => field.column + " AS " + field.key).join(",") +
      historyFrom +
      " LIMIT 2";
    const rows = await sql.query(query, params),
      row = rows[0];
    if (rows.length !== 1 || !row) return fail();
    const history: Record<string, SqlParam> = {};
    for (const field of historyFields) {
      const value = row[field.key];
      if (
        value !== null &&
        typeof value !== "string" &&
        (typeof value !== "number" || !Number.isSafeInteger(value))
      )
        return fail();
      history[field.key] = value;
    }
    const spec = publicSpec(history.a_accepted_spec_json);
    if (
      typeof history.a_generation !== "number" ||
      history.a_revision !== `${history.a_generation}-${spec[C.fields.workloadRevision]}` ||
      !text(history.a_retain_until) ||
      !text(history.o_retain_until) ||
      !Number.isFinite(Date.parse(history.a_retain_until)) ||
      !Number.isFinite(Date.parse(history.o_retain_until)) ||
      Date.parse(history.o_retain_until) < Date.parse(history.a_retain_until)
    )
      return fail();
    const operation = Object.freeze({
      operationId: history.a_operation_id,
      action: history.a_action,
      generation: history.a_generation,
      resourceUid: history.a_resource_uid,
      principal: history.a_principal,
      space: history.a_space,
      name: history.a_name,
      form: history.a_form_url,
      backendId: history.a_backend_id,
      targetKey: history.a_target_key,
      backendKey: history.a_backend_key,
      acceptedFingerprint: history.a_fingerprint,
      revision: history.a_revision,
    });
    const expected = Object.freeze({
      purpose: "takoserver.linux-oci-application-io-close@1",
      original,
      nativeId: input.nativeId,
      controlDigest: await canonicalDigest(raw),
      operation,
    });
    const local = await readApplicationCloseFact(document, expected);
    const values = historyFields.map((field) => {
      const value = history[field.key];
      if (value === undefined) return fail();
      return value;
    });
    const snapshot: SqlStatement = {
      sql:
        "EXISTS (SELECT 1" +
        historyFrom +
        " AND " +
        historyFields.map((field) => field.column + " IS ?").join(" AND ") +
        ")",
      params: [...params, ...values],
    };
    const refresh = async () => {
      const exact = await sql.query(query, params);
      if (exact.length !== 1 || canonicalJson(exact[0]) !== canonicalJson(history)) return fail();
      local();
    };
    await refresh();
    return { local, refresh, snapshot };
  }
  async function openOriginalParentControl(
    input: DockerContainerCreateRecord,
    originalCustody: object,
    proof: Proof,
    raw: string,
    signal: AbortSignal,
    stillCurrent: () => Promise<boolean>,
  ) {
    if (
      !controlDecryptionKey ||
      signal.aborted ||
      raw.length > 65536 ||
      raw === V2_CONTAINER_CONTROL_RESERVED
    )
      return fail();
    const envelope = parseStrictJson(new TextEncoder().encode(raw), 65536);
    if (
      !own(envelope, ["kind", "scope", "keyId", "nonce", "ciphertext"]) ||
      envelope.kind !== "linux-oci-sealed-control@1" ||
      !text(envelope.keyId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(envelope.keyId) ||
      typeof envelope.nonce !== "string" ||
      typeof envelope.ciphertext !== "string" ||
      canonicalJson(envelope) !== raw
    )
      return fail();
    const artifact = peerMode
      ? peerArtifact(envelope.scope, input)
      : await readOriginalLinuxOciControlArtifact(originalCustody, result, input, signal);
    // a/o describe the ORIGINAL accepted CREATE/UPDATE for this generation.
    // la/lo describe today's operation, which may be DELETE; never substitute it.
    const scope = Object.freeze({
      purpose: peerMode ? peerPurpose : "takoserver.linux-oci-parent-control@1",
      claimId: input.claimId,
      installationId,
      resourceUid: input.intent.resourceUid,
      incarnationId: input.intent.incarnationId,
      generation: input.intent.policy.generation,
      revision: input.intent.revision,
      operationId: proof.a_operation_id,
      principal: proof.i_principal,
      space: proof.i_space,
      form: proof.i_form_url,
      backendId,
      targetKey,
      action: proof.a_action,
      acceptedFingerprint: proof.a_fingerprint,
      policyDigest: input.intent.policy.policyDigest,
      artifact,
    });
    if (
      canonicalJson(envelope.scope) !== canonicalJson(scope) ||
      !(await stillCurrent()) ||
      signal.aborted
    )
      return fail();
    const originalControlKeyId = envelope.keyId,
      key = controlDecryptionKey(originalControlKeyId),
      nonce = decodeContainerSecretBytes(envelope.nonce),
      ciphertext = decodeContainerSecretBytes(envelope.ciphertext);
    if (
      !isContainerSecretKey(key) ||
      nonce.length !== 12 ||
      ciphertext.length < 16 ||
      ciphertext.length > 65536
    )
      return fail();
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
      plaintext = await decryptContainerSecretBytes(
        key,
        nonce,
        ciphertext,
        new TextEncoder().encode(canonicalJson(scope)),
      );
      const binding = parseStrictJson(plaintext, 65536);
      if (peerMode && (!isJsonObject(binding) || binding.purpose !== peerReconstructionPurpose))
        return fail();
      const finalProducer =
        trackedPeer &&
        qualifiedPhysicalDigest !== undefined &&
        isJsonObject(binding) &&
        own(binding.retirementProducer, ["revision", "digest"]) &&
        binding.retirementProducer.revision === "NCLOSE01" &&
        binding.retirementProducer.digest === qualifiedPhysicalDigest;
      if (runtimeApplicationOwner && !finalProducer) return fail();
      if (JSON.stringify(binding) !== new TextDecoder("utf-8", { fatal: true }).decode(plaintext))
        return fail();
      return { artifact, scope, binding, originalControlKeyId, key, finalProducer };
    } finally {
      plaintext?.fill(0);
    }
  }
  async function acceptedParentControl(
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
    management: "retired",
  ): Promise<RetiredCurrent>;
  function acceptedParentControl(
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
    management: "coordinates",
  ): Promise<() => Promise<() => void>>;
  async function acceptedParentControl(
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
    management?: boolean | "application-recovery",
  ): Promise<
    LinuxOciParentHResult | LinuxOciPeerInitProgress | LinuxOciApplicationOwnerExit | undefined
  >;
  async function acceptedParentControl(
    execution: V2Execution,
    input: DockerContainerCreateRecord,
    originalCustody: object,
    signal: AbortSignal,
    management: boolean | "application-recovery" | "retired" | "coordinates" = false,
  ): Promise<
    | LinuxOciParentHResult
    | LinuxOciPeerInitProgress
    | LinuxOciApplicationOwnerExit
    | (() => Promise<() => void>)
    | undefined
  > {
    if (parentMode === undefined || !controlDecryptionKey || signal.aborted) return fail();
    await assertExecution(execution);
    if (management) {
      if (
        !peerMode ||
        (management === "coordinates"
          ? !["bound", "removed"].includes(input.state)
          : input.state !== (management === "retired" ? "removed" : "bound")) ||
        !hex(input.nativeId)
      )
        return fail();
      const accepted = await result.readAcceptedExecution(execution);
      const retained = accepted.retained.find((item) => item.record.claimId === input.claimId);
      if (
        (accepted.action !== "delete" && accepted.action !== "update") ||
        !retained ||
        (management === "retired" || (management === "coordinates" && input.state === "removed")
          ? retained.removedAtMs === null
          : retained.removedAtMs !== null) ||
        input.intent.policy.generation >= accepted.generation ||
        canonicalJson(retained.record) !== canonicalJson(input)
      )
        return fail();
    }
    const phase =
      management === "coordinates" && input.state === "bound"
        ? "observe"
        : execution.action === "delete" || input.intent.policy.generation < execution.generation
          ? "remove"
          : "reconcile";
    const lease = await activeRecord(input, phase),
      loaded = await load(input.intent);
    sameRecord(input, record(loaded.intent, loaded.proof));
    if (
      !usable(loaded.proof, phase) ||
      !(await inspectV2ContainerOwnerSelectedSchema(sql, "control"))
    )
      return fail();
    const rows = await sql.query(
      "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=?",
      [input.intent.resourceUid, input.intent.policy.generation, input.claimId],
    );
    const raw = rows[0]?.native_control;
    if (rows.length !== 1 || typeof raw !== "string") return fail();
    return openOriginalParentControl(input, originalCustody, loaded.proof, raw, signal, () =>
      current(lease),
    ).then(async ({ artifact, scope, binding, originalControlKeyId, key, finalProducer }) => {
      await assertSnapshot(loaded.proof);
      await assertExecution(execution);
      if (!(await current(lease)) || signal.aborted) return fail();
      const fresh = await sql.query(
        "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=?",
        [input.intent.resourceUid, input.intent.policy.generation, input.claimId],
      );
      if (fresh.length !== 1 || fresh[0]?.native_control !== raw || signal.aborted) return fail();
      if (management === "coordinates") {
        if (
          !finalProducer ||
          topologies?.alternate === undefined ||
          !isJsonObject(binding) ||
          !isJsonObject(binding.allocation) ||
          !Object.hasOwn(binding.allocation, "topology") ||
          canonicalJson(snapshotLinuxOciHostTopology(binding.allocation.topology)) !==
            canonicalJson(linuxOciGenerationTopology(topologies, input.intent.policy.generation))
        )
          return fail();
        const local = () => {
          if (
            !controlDecryptionKey ||
            controlDecryptionKey(originalControlKeyId) !== key ||
            signal.aborted ||
            !lease.active ||
            lease.controller.signal.aborted ||
            !leases.has(lease)
          )
            return fail();
          executionScope(execution);
        };
        const refresh = async () => {
          await assertSnapshot(loaded.proof);
          const exact = await sql.query(
            "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state=? AND native_id=?",
            [
              input.intent.resourceUid,
              input.intent.policy.generation,
              input.claimId,
              input.state,
              input.nativeId,
            ],
          );
          if (exact.length !== 1 || exact[0]?.native_control !== raw || !(await current(lease)))
            return fail();
          await assertExecution(execution);
          local();
          return local;
        };
        await refresh();
        return refresh;
      }
      if (management === "retired") {
        if (
          !finalProducer ||
          (execution.action === "delete"
            ? !retiredDeleteProof(loaded.proof, "a")
            : execution.action !== "update") ||
          !(await inspectV2ContainerOwnerSelectedSchema(sql, "final-delete"))
        )
          return fail();
        const rows = await sql.query(
          "SELECT allocation_cleanup,application_io_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='removed' AND native_id=? AND native_control=?",
          [
            input.intent.resourceUid,
            input.intent.policy.generation,
            input.claimId,
            input.nativeId,
            raw,
          ],
        );
        if (rows.length !== 1 || rows[0]?.allocation_cleanup !== "closed") return fail();
        const document = rows[0]?.application_io_cleanup;
        const applicationFact = await retiredApplicationFact(
          document,
          scope,
          loaded.proof,
          execution,
          input,
          raw,
        );
        const factCurrent = applicationFact.local;
        // Cipherpayload alone may move monotonically to NULL in this explicit
        // successor. Pin all nonsecret original fields and actual control/close.
        const nonsecret = fields.filter(
          (field) => field.key !== "a_configured_private_inputs_json",
        );
        const snapshotSql =
          "EXISTS (SELECT 1" +
          from +
          " WHERE " +
          nonsecret.map((field) => field.column + " IS ?").join(" AND ") +
          ")";
        const snapshotParams = nonsecret.map((field) => loaded.proof[field.key]!);
        const localRetired = () => {
          if (
            !controlDecryptionKey ||
            controlDecryptionKey(originalControlKeyId) !== key ||
            signal.aborted ||
            !lease.active ||
            lease.controller.signal.aborted ||
            !leases.has(lease)
          )
            return fail();
          factCurrent();
          executionScope(execution);
        };
        const currentRetired = async () => {
          const exact = await sql.query(
            "SELECT 1 AS owner_current WHERE " + snapshotSql,
            snapshotParams,
          );
          if (exact.length !== 1 || exact[0]?.owner_current !== 1) return fail();
          const row = await sql.query(
            "SELECT native_control,allocation_cleanup,application_io_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='removed' AND native_id=?",
            [
              input.intent.resourceUid,
              input.intent.policy.generation,
              input.claimId,
              input.nativeId,
            ],
          );
          if (
            row.length !== 1 ||
            row[0]?.native_control !== raw ||
            row[0]?.allocation_cleanup !== "closed" ||
            row[0]?.application_io_cleanup !== document ||
            !(await current(lease))
          )
            return fail();
          await applicationFact.refresh();
          await assertExecution(execution);
          localRetired();
          return localRetired;
        };
        await currentRetired();
        return Object.freeze(Object.assign(currentRetired, { snapshot: applicationFact.snapshot })); // negative currentness only
      }
      let missingApplicationDocument: string | null | undefined;
      let sealedCloseResume: LinuxOciSealedApplicationCloseResume | undefined;
      if (
        (trackedPeer || parentMode === "sealed-peer-local-cleanup@1" || applicationOwnerPeer) &&
        phase === "remove" &&
        (await inspectV2ContainerOwnerSelectedSchema(sql, "application-io"))
      ) {
        const closed = await sql.query(
          "SELECT allocation_cleanup,application_io_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND native_control=?",
          [
            input.intent.resourceUid,
            input.intent.policy.generation,
            input.claimId,
            input.nativeId,
            raw,
          ],
        );
        if (closed.length !== 1) return fail();
        if (management === "application-recovery" || management === true) {
          let document = closed[0]?.application_io_cleanup;
          if (
            management === "application-recovery" &&
            runtimeApplicationOwner &&
            execution.action === "delete" &&
            document === V2_CONTAINER_APPLICATION_IO_RESERVED &&
            closed[0]?.allocation_cleanup === "untouched" &&
            (await inspectV2ContainerOwnerShutdownIoSchema(sql))
          ) {
            const coordinates = [
              input.intent.resourceUid,
              input.intent.policy.generation,
              input.claimId,
              input.nativeId,
            ];
            const shutdown = await sql.query(
              "SELECT close_document FROM tf_v2_container_shutdown_io_closes WHERE resource_uid=? AND generation=? AND claim_id=? AND native_id=?",
              coordinates,
            );
            if (shutdown.length > 1) return fail();
            if (shutdown.length === 1) {
              const receipt = shutdown[0]?.close_document;
              if (typeof receipt !== "string") return fail();
              const shutdownCurrent = await readApplicationCloseFact(
                receipt,
                await shutdownIoScope(input, raw),
                shutdownIoCloseKind,
              );
              // Carry the genuine original terminal fact into this operation's
              // existing one-use close slot. No mutation of the prior receipt
              // and no native request until the same DELETE verifies its seal.
              const selected = await sealApplicationCloseFact(
                await applicationCloseScope(scope, loaded.proof, execution, input, raw),
                applicationCloseKind,
              );
              await assertExecution(execution);
              if (
                !(await current(lease)) ||
                signal.aborted ||
                !lease.active ||
                lease.controller.signal.aborted ||
                !leases.has(lease) ||
                controlDecryptionKey(originalControlKeyId) !== key
              )
                return fail();
              executionScope(execution);
              shutdownCurrent();
              selected.assertCurrent();
              const guard = fence(loaded.proof);
              const saved = await sql.run(
                "UPDATE tf_v2_container_create_claims SET application_io_cleanup=? WHERE resource_uid=? AND generation=? AND claim_id=? AND native_id=? AND state='bound' AND allocation_cleanup='untouched' AND native_control=? AND application_io_cleanup=? AND " +
                  guard.sql +
                  reconcilerLeaseSql +
                  " AND EXISTS (SELECT 1 FROM tf_v2_container_shutdown_io_closes WHERE resource_uid=? AND generation=? AND claim_id=? AND native_id=? AND close_document=?)",
                [
                  selected.document,
                  ...coordinates,
                  raw,
                  V2_CONTAINER_APPLICATION_IO_RESERVED,
                  ...guard.params,
                  execution.operationId,
                  execution.resourceUid,
                  execution.leaseToken,
                  ...coordinates,
                  receipt,
                ],
              );
              if (saved.changes !== 1) return fail();
              shutdownCurrent();
              selected.assertCurrent();
              document = selected.document;
            }
          }
          if (document === null || document === V2_CONTAINER_APPLICATION_IO_RESERVED) {
            if (management === "application-recovery") missingApplicationDocument = document;
          } else if (trackedPeer && closed[0]?.allocation_cleanup === "untouched") {
            // A previously sealed close can resume the exact original P only
            // after fresh same-operation, key, lease, row, and AEAD checks.
            // P still independently refuses an attached frontend or foreign
            // process and reports its exact native stage before any command.
            let factCurrent: (() => void) | undefined;
            const guard = async () => {
              await assertSnapshot(loaded.proof);
              await assertExecution(execution);
              if (!(await current(lease))) return fail();
              if (!factCurrent) return fail();
              const currentProof = fence(loaded.proof);
              const row = await sql.query(
                "SELECT native_control,allocation_cleanup,application_io_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND native_control=? AND " +
                  currentProof.sql +
                  " AND EXISTS (SELECT 1 FROM tf_v2_operations WHERE id=? AND resource_uid=? AND lease_token=? AND lease_until_ms > (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000 AND status='reconciling' AND effect='unknown' AND dispatch_possible=1)",
                [
                  input.intent.resourceUid,
                  input.intent.policy.generation,
                  input.claimId,
                  input.nativeId,
                  raw,
                  ...currentProof.params,
                  execution.operationId,
                  execution.resourceUid,
                  execution.leaseToken,
                ],
              );
              if (
                row.length !== 1 ||
                row[0]?.native_control !== raw ||
                row[0]?.allocation_cleanup !== "untouched" ||
                row[0]?.application_io_cleanup !== document
              )
                return fail();
              if (!controlDecryptionKey || controlDecryptionKey(originalControlKeyId) !== key)
                return fail();
              factCurrent();
              if (
                signal.aborted ||
                !lease.active ||
                lease.controller.signal.aborted ||
                !leases.has(lease)
              )
                return fail();
              executionScope(execution);
            };
            const resume = createOriginalLinuxOciSealedApplicationCloseResume(
              originalCustody,
              result,
              input,
              signal,
              guard,
            );
            if (resume) {
              const ioScope = await applicationCloseScope(
                scope,
                loaded.proof,
                execution,
                input,
                raw,
              );
              factCurrent = await readApplicationCloseFact(document, ioScope);
              await guard();
              sealedCloseResume = resume;
            }
          } else if (
            management === "application-recovery" &&
            closed[0]?.allocation_cleanup !== "closed"
          )
            return fail();
          // A present/invalid/foreign saved fact cannot fall back to process exit.
          // The closed branch below authenticates the full same-operation AEAD.
        }
        if (closed[0]?.allocation_cleanup === "closed") {
          // Historical same-operation facts select a read-only transport, not
          // a replacement allocation/session or permission to repeat cleanup.
          const document = closed[0]?.application_io_cleanup;
          const ioScope = await applicationCloseScope(scope, loaded.proof, execution, input, raw);
          const factCurrent = await readApplicationCloseFact(document, ioScope);
          const guard = async () => {
            await assertSnapshot(loaded.proof);
            const row = await sql.query(
              "SELECT native_control,allocation_cleanup,application_io_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=?",
              [
                input.intent.resourceUid,
                input.intent.policy.generation,
                input.claimId,
                input.nativeId,
              ],
            );
            if (
              row.length !== 1 ||
              row[0]?.native_control !== raw ||
              row[0]?.allocation_cleanup !== "closed" ||
              row[0]?.application_io_cleanup !== document ||
              !(await current(lease))
            )
              return fail();
            await assertExecution(execution);
            if (!controlDecryptionKey || controlDecryptionKey(originalControlKeyId) !== key)
              return fail();
            factCurrent();
            if (
              signal.aborted ||
              !lease.active ||
              lease.controller.signal.aborted ||
              !leases.has(lease)
            )
              return fail();
            executionScope(execution);
          };
          await guard();
          const read = await prepareOriginalLinuxOciPeerRead(
            originalCustody,
            result,
            input,
            artifact,
            binding,
            signal,
            "closed",
          );
          await guard(); // last await before the original one-use reader starts
          const observation = await read(signal);
          if (observation.kind !== "linux-oci-parent-h-exited@1" || observation.error !== 0)
            return fail();
          await guard();
          if (
            management &&
            finalProducer &&
            (execution.action === "delete" || execution.action === "update") &&
            (await inspectV2ContainerOwnerSelectedSchema(sql, "final-delete"))
          ) {
            await guard();
            await confirmRemoved(
              input,
              input.nativeId ?? fail(),
              () => {
                if (
                  signal.aborted ||
                  !lease.active ||
                  lease.controller.signal.aborted ||
                  !leases.has(lease) ||
                  !controlDecryptionKey ||
                  controlDecryptionKey(originalControlKeyId) !== key
                )
                  return fail();
                executionScope(execution);
                factCurrent();
              },
              execution,
            );
          }
          return observation; // same original readonly P/H result; optional owning CAS above
        }
      }
      if (management === "application-recovery" && !sealedCloseResume) {
        if (
          !applicationOwnerPeer ||
          phase !== "remove" ||
          missingApplicationDocument === undefined ||
          !(await inspectV2ContainerOwnerSelectedSchema(sql, "allocation"))
        )
          return fail();
        // Only the successful exact schema+row read above proves missing.
        // Inspector false (old shape or query failure) is UNKNOWN here.
        const missingDocument = missingApplicationDocument;
        // No application_io_closed is inferred or written. This is the fresh
        // owner's missing-before-save input; all original files must still match.
        const currentOwner = async () => {
          await assertSnapshot(loaded.proof);
          await assertExecution(execution);
          const row = await sql.query(
            "SELECT native_control,allocation_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND application_io_cleanup IS ?",
            [
              input.intent.resourceUid,
              input.intent.policy.generation,
              input.claimId,
              input.nativeId,
              missingDocument,
            ],
          );
          if (
            row.length !== 1 ||
            row[0]?.native_control !== raw ||
            row[0]?.allocation_cleanup !== "untouched" ||
            !(await current(lease))
          )
            return fail();
          await assertExecution(execution);
          if (
            !controlDecryptionKey ||
            controlDecryptionKey(originalControlKeyId) !== key ||
            signal.aborted ||
            !lease.active ||
            lease.controller.signal.aborted ||
            !leases.has(lease)
          )
            return fail();
          executionScope(execution);
        };
        await currentOwner();
        const read = await prepareOriginalLinuxOciApplicationOwnerRead(
          originalCustody,
          result,
          input,
          artifact,
          binding,
          signal,
        );
        await currentOwner();
        const observation = await read(signal);
        await currentOwner();
        return observation; // nonconsuming original process exit; no H/I/O/removed grant
      }
      let observation: LinuxOciParentHResult | LinuxOciPeerInitProgress | undefined;
      if (peerMode) {
        const read = management
          ? await prepareOriginalLinuxOciPeerInit(
              originalCustody,
              result,
              input,
              artifact,
              binding,
              signal,
              sealedCloseResume,
            )
          : await prepareOriginalLinuxOciPeerRead(
              originalCustody,
              result,
              input,
              artifact,
              binding,
              signal,
            );
        try {
          await assertSnapshot(loaded.proof);
          await assertExecution(execution);
          const before = await sql.query(
            "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=?",
            [input.intent.resourceUid, input.intent.policy.generation, input.claimId],
          );
          if (
            before.length !== 1 ||
            before[0]?.native_control !== raw ||
            !(await current(lease)) ||
            signal.aborted
          )
            return fail();
          if (management) {
            if (typeof read === "function") return fail();
            let complete = false;
            const applicationSchema = await inspectV2ContainerOwnerSelectedSchema(
              sql,
              "application-io",
            );
            // The expanded schema persists the original close before helper
            // completion. Legacy schemas keep the historical H-gated lookup.
            let application = applicationSchema
              ? originalLinuxOciHttpRetirementSource(originalCustody, result, input, signal)
              : undefined;
            let applicationFactCurrent: (() => void) | undefined;
            const applicationLeaseSql = applicationSchema ? reconcilerLeaseSql : "";
            const applicationLeaseParams = applicationSchema
              ? [execution.operationId, execution.resourceUid, execution.leaseToken]
              : [];
            const localIo = () => {
              if (
                !controlDecryptionKey ||
                controlDecryptionKey(originalControlKeyId) !== key ||
                signal.aborted ||
                !lease.active ||
                lease.controller.signal.aborted ||
                !leases.has(lease)
              )
                return fail();
              executionScope(execution);
              if (
                originalLinuxOciHttpRetirementSource(originalCustody, result, input, signal) !==
                application
              )
                return fail();
            };
            const currentApplication = async (expected?: string) => {
              await assertSnapshot(loaded.proof);
              await assertExecution(execution);
              const row = await sql.query(
                "SELECT native_control" +
                  (applicationSchema ? ",application_io_cleanup" : "") +
                  " FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=?",
                [
                  input.intent.resourceUid,
                  input.intent.policy.generation,
                  input.claimId,
                  input.nativeId,
                ],
              );
              if (
                row.length !== 1 ||
                row[0]?.native_control !== raw ||
                (expected !== undefined && row[0]?.application_io_cleanup !== expected) ||
                !(await current(lease))
              )
                return fail();
              localIo();
              return row[0]?.application_io_cleanup;
            };
            let helper: ReturnType<typeof read.observeHelperExited> | undefined;
            const localApplication = () => {
              localIo();
              if (helper === undefined || read.observeHelperExited(signal) !== helper)
                return fail();
            };
            const persistApplication = async () => {
              if (applicationSchema) {
                // Original a/o identity is already authenticated above. Today's
                // accepted operation is separate; leaseToken is checked live.
                localIo();
                const ioScope = await applicationCloseScope(
                  scope,
                  loaded.proof,
                  execution,
                  input,
                  raw,
                );
                let document = await currentApplication();
                if (document === V2_CONTAINER_APPLICATION_IO_RESERVED) {
                  // An absent/fresh runtime never initializes a missing fact.
                  if (!application || !controlKeyring) return fail();
                  localIo();
                  await application.close(); // exact original irreversible cached Promise
                  await currentApplication(V2_CONTAINER_APPLICATION_IO_RESERVED);
                  const selected = await sealApplicationCloseFact(ioScope, applicationCloseKind);
                  await currentApplication(V2_CONTAINER_APPLICATION_IO_RESERVED);
                  selected.assertCurrent();
                  const sealedDocument = selected.document;
                  document = sealedDocument;
                  const beforeSave = await boundStartRecord(input);
                  if (!usable(beforeSave.proof, "remove") || !(await current(lease))) return fail();
                  const saveGuard = fence(beforeSave.proof);
                  selected.assertCurrent();
                  localIo(); // no await between the original local fence and CAS
                  const saved = await sql.run(
                    "UPDATE tf_v2_container_create_claims SET application_io_cleanup=? WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND native_control=? AND application_io_cleanup=? AND " +
                      saveGuard.sql +
                      applicationLeaseSql,
                    [
                      sealedDocument,
                      input.intent.resourceUid,
                      input.intent.policy.generation,
                      input.claimId,
                      input.nativeId,
                      raw,
                      V2_CONTAINER_APPLICATION_IO_RESERVED,
                      ...saveGuard.params,
                      ...applicationLeaseParams,
                    ],
                  );
                  if (saved.changes !== 1) return fail(); // lost ACK never advances this caller
                  await currentApplication(sealedDocument); // consume only the actual committed bytes
                }
                const factCurrent = await readApplicationCloseFact(document, ioScope);
                await currentApplication(typeof document === "string" ? document : fail());
                factCurrent();
                applicationFactCurrent = () => {
                  localIo();
                  factCurrent();
                };
                applicationFactCurrent();
              } else if (application) {
                // Exact old schema behavior; absence remains no new fact.
                await currentApplication();
                localIo();
                await application.close();
                await currentApplication();
                localIo();
              }
              return applicationFactCurrent;
            };
            let applicationSave: ReturnType<typeof persistApplication> | undefined;
            const beginApplicationSave = () => {
              if (!applicationSave) {
                applicationSave = persistApplication();
                void applicationSave.catch(() => undefined);
              }
              return applicationSave;
            };
            let watchingClose = false;
            let detachCloseListener: (() => void) | undefined;
            try {
              const originalOutcome = await read.begin(signal); // authenticated P outcome; H writes still zero
              const stopIssued = (originalOutcome.effects & (1 << 6)) !== 0;
              if (sealedCloseResume) {
                // Older profiles continue a known STOP only. The tracked
                // owner can start this DELETE from a known START and its
                // genuinely saved close. The original P owns the effect latch.
                const knownStart =
                  runtimeApplicationOwner &&
                  execution.action === "delete" &&
                  originalOutcome.effects === ((1 << 1) | (1 << 4)) &&
                  [4, 5].includes(originalOutcome.requestKind);
                if (
                  originalOutcome.requestBytes === "0" ||
                  originalOutcome.requestBytes !== originalOutcome.issuedBytes ||
                  originalOutcome.replyBytes === "0" ||
                  (!stopIssued && !knownStart)
                )
                  return fail();
              }
              await assertSnapshot(loaded.proof);
              await assertExecution(execution);
              const boundPhase = await boundInitPhase(await boundStartRecord(input));
              if (sealedCloseResume && !stopIssued && boundPhase !== "running") return fail();
              const guarded = await sql.query(
                "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=?",
                [input.intent.resourceUid, input.intent.policy.generation, input.claimId],
              );
              if (
                guarded.length !== 1 ||
                guarded[0]?.native_control !== raw ||
                !(await current(lease)) ||
                signal.aborted ||
                !hex(input.nativeId)
              )
                return fail();
              if (!lease.active || lease.controller.signal.aborted || !leases.has(lease))
                return fail();
              executionScope(execution);
              read.assertCurrent();
              // This stage owns only the save begun after actual cached close
              // fulfillment. Pending close never delays STOP/JOIN advancement.
              watchingClose = true;
              const terminal = application?.close();
              const closeFinished = application?.closeFinished;
              if (terminal && closeFinished) {
                // A stage can be retried indefinitely while the same close is
                // pending. Subscribe to a removable notification until it settles.
                const onCloseFinished = () => {
                  if (!closeFinished.aborted) return;
                  void terminal.then(
                    () => {
                      if (watchingClose && !signal.aborted) beginApplicationSave();
                    },
                    () => undefined,
                  );
                };
                if (closeFinished.aborted) onCloseFinished();
                else {
                  closeFinished.addEventListener("abort", onCloseFinished);
                  detachCloseListener = () =>
                    closeFinished.removeEventListener("abort", onCloseFinished);
                }
                if (
                  applicationSchema &&
                  runtimeApplicationOwner &&
                  execution.action === "delete" &&
                  !stopIssued &&
                  boundPhase === "running" &&
                  closeFinished.aborted &&
                  (await terminal.then(
                    () => true,
                    () => false,
                  ))
                ) {
                  // The real close already settled. Save it before the first
                  // STOP so a lost CAS acknowledgement can be reconciled.
                  const closedCurrent = await beginApplicationSave();
                  if (!closedCurrent) return fail();
                  const startGuard = fence(loaded.proof);
                  const stillAuthorized = await sql.query(
                    "SELECT 1 FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND native_control=? AND " +
                      startGuard.sql +
                      applicationLeaseSql +
                      " AND EXISTS (SELECT 1 FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=? AND create_claim_id=? AND native_id=? AND state='running' AND confirmed_exited_at_ms IS NULL)",
                    [
                      input.intent.resourceUid,
                      input.intent.policy.generation,
                      input.claimId,
                      input.nativeId,
                      raw,
                      ...startGuard.params,
                      ...applicationLeaseParams,
                      input.intent.resourceUid,
                      input.intent.policy.generation,
                      input.claimId,
                      input.nativeId,
                    ],
                  );
                  if (stillAuthorized.length !== 1) return fail();
                  closedCurrent();
                  read.assertCurrent();
                }
              }
              if (sealedCloseResume) {
                await sealedCloseResume.assertCurrent(signal);
                if (
                  signal.aborted ||
                  !lease.active ||
                  lease.controller.signal.aborted ||
                  !leases.has(lease)
                )
                  return fail();
                executionScope(execution);
                read.assertCurrent();
              }
              observation = await (boundPhase === "exited"
                ? read.advanceNamespace(input.nativeId, signal)
                : read.advance(
                    input.nativeId,
                    signal,
                    sealedCloseResume && !stopIssued
                      ? originalOutcome.requestKind === 4
                        ? "linux-oci-started@1"
                        : "linux-oci-started-observation@1"
                      : undefined,
                  ));
              if (observation.operation === "read-helper-result") {
                // Exact original P's H join/EOF record only; no removed CAS or
                // allocation cleanup is authorized by this private handoff.
                helper = read.observeHelperExited(signal);
                if (!applicationSchema)
                  application = originalLinuxOciHttpRetirementSource(
                    originalCustody,
                    result,
                    input,
                    signal,
                  );
                // H result remains separate from the I/O-only saved fact.
                // Revocation ends this stage's wait, not the original close.
                if (terminal && closeFinished)
                  await waitForOriginalApplicationClose(terminal, closeFinished, signal);
                applicationFactCurrent = await beginApplicationSave();
                localApplication();
                if (await inspectV2ContainerOwnerSelectedSchema(sql, "allocation")) {
                  const cleanup = await sql.query(
                    "SELECT allocation_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND native_control=?",
                    [
                      input.intent.resourceUid,
                      input.intent.policy.generation,
                      input.claimId,
                      input.nativeId,
                      raw,
                    ],
                  );
                  if (cleanup.length !== 1) return fail();
                  if (cleanup[0]?.allocation_cleanup === "untouched") {
                    await read.prepareAllocationDisposal(signal);
                    await assertExecution(execution);
                    const beforeCleanup = await boundStartRecord(input);
                    if (!usable(beforeCleanup.proof, "remove") || !(await current(lease)))
                      return fail();
                    const cleanupGuard = fence(beforeCleanup.proof);
                    if (
                      signal.aborted ||
                      !lease.active ||
                      lease.controller.signal.aborted ||
                      !leases.has(lease)
                    )
                      return fail();
                    executionScope(execution);
                    read.assertCurrent();
                    read.observeHelperExited(signal);
                    applicationFactCurrent?.();
                    const consume = await sql.run(
                      "UPDATE tf_v2_container_create_claims SET allocation_cleanup='consumed' WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND native_control=? AND allocation_cleanup='untouched' AND " +
                        cleanupGuard.sql +
                        applicationLeaseSql,
                      [
                        input.intent.resourceUid,
                        input.intent.policy.generation,
                        input.claimId,
                        input.nativeId,
                        raw,
                        ...cleanupGuard.params,
                        ...applicationLeaseParams,
                      ],
                    );
                    if (consume.changes !== 1) return fail(); // lost receipt never dispatches rm
                    await assertExecution(execution);
                    if (!(await current(lease))) return fail();
                    if (
                      signal.aborted ||
                      !lease.active ||
                      lease.controller.signal.aborted ||
                      !leases.has(lease)
                    )
                      return fail();
                    executionScope(execution);
                    read.assertCurrent();
                    read.observeHelperExited(signal);
                    applicationFactCurrent?.();
                    await read.disposeAllocation(signal); // first destructive await consumes private slot too
                    await assertExecution(execution);
                    if (!(await current(lease))) return fail();
                    if (
                      signal.aborted ||
                      !lease.active ||
                      lease.controller.signal.aborted ||
                      !leases.has(lease)
                    )
                      return fail();
                    executionScope(execution);
                    read.assertCurrent();
                    read.observeHelperExited(signal);
                    applicationFactCurrent?.();
                    const completed = await sql.run(
                      "UPDATE tf_v2_container_create_claims SET allocation_cleanup='closed' WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND native_control=? AND allocation_cleanup='consumed' AND " +
                        cleanupGuard.sql +
                        applicationLeaseSql,
                      [
                        input.intent.resourceUid,
                        input.intent.policy.generation,
                        input.claimId,
                        input.nativeId,
                        raw,
                        ...cleanupGuard.params,
                        ...applicationLeaseParams,
                      ],
                    );
                    if (completed.changes !== 1) return fail();
                  } else {
                    const state = cleanup[0]?.allocation_cleanup;
                    if (state !== null && state !== "consumed" && state !== "closed") return fail();
                  }
                  // Historical NULL and consumed UNKNOWN never acquire untouched
                  // from this fresh creator or from a path/absence observation.
                }
                if (
                  finalProducer &&
                  (execution.action === "delete" || execution.action === "update") &&
                  applicationFactCurrent &&
                  (await inspectV2ContainerOwnerSelectedSchema(sql, "final-delete"))
                ) {
                  const factCurrent = applicationFactCurrent;
                  await currentApplication();
                  const terminal = await sql.query(
                    "SELECT allocation_cleanup FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND native_control=?",
                    [
                      input.intent.resourceUid,
                      input.intent.policy.generation,
                      input.claimId,
                      input.nativeId,
                      raw,
                    ],
                  );
                  if (terminal.length !== 1 || terminal[0]?.allocation_cleanup !== "closed")
                    return fail();
                  await assertExecution(execution);
                  const local = () => {
                    localApplication();
                    factCurrent();
                    if (!controlDecryptionKey || controlDecryptionKey(originalControlKeyId) !== key)
                      return fail();
                  };
                  local();
                  await confirmRemoved(input, input.nativeId, local, execution);
                  complete = true;
                  return observation; // no stale bound-snapshot check after the real owning CAS
                }
              }
              if (observation.operation === "join-init") {
                // Only the same actual private connector can supply this original
                // consuming JOIN observation. The public progress is not a witness.
                const joined = read.observeJoined(signal);
                const local = () => {
                  if (
                    signal.aborted ||
                    !lease.active ||
                    lease.controller.signal.aborted ||
                    !leases.has(lease)
                  )
                    return fail();
                  executionScope(execution);
                  if (read.observeJoined(signal) !== joined || joined.nativeId !== input.nativeId)
                    return fail();
                };
                await assertExecution(execution);
                const stopped = await boundStartRecord(input);
                const bound = await sql.query(
                  "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=?",
                  [input.intent.resourceUid, input.intent.policy.generation, input.claimId],
                );
                if (
                  bound.length !== 1 ||
                  bound[0]?.native_control !== raw ||
                  !usable(stopped.proof, "remove") ||
                  !(await current(lease))
                )
                  return fail();
                local();
                if ((await confirmBoundStopped(stopped, lease, local)) !== "confirmed")
                  return fail();
                local();
              }
              complete = true;
            } finally {
              watchingClose = false;
              detachCloseListener?.();
              try {
                // No detached SQL: only work that already started is joined.
                // An unresolved close is rearmed by the next legitimate stage.
                if (applicationSave) await applicationSave;
              } finally {
                if (!complete) read.cancel();
              }
            }
          } else {
            if (typeof read !== "function") return fail();
            observation = await read(signal);
          }
          await assertSnapshot(loaded.proof);
          const after = await sql.query(
            "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=?",
            [input.intent.resourceUid, input.intent.policy.generation, input.claimId],
          );
          if (after.length !== 1 || after[0]?.native_control !== raw || !(await current(lease)))
            return fail();
        } catch (error) {
          if (typeof read !== "function") read.cancel();
          throw error;
        }
      } else verifyOriginalLinuxOciParentControl(originalCustody, result, input, binding, signal);
      await assertExecution(execution);
      if (signal.aborted || !lease.active || lease.controller.signal.aborted || !leases.has(lease))
        return fail();
      executionScope(execution);
      return observation;
    });
  }
  const result: DockerContainerCoreOwner = Object.freeze<DockerContainerCoreOwner>({
    async saveOriginalShutdownIoClose(input, originalCustody, signal) {
      if (!runtimeApplicationOwner || signal.aborted) return fail();
      const application = originalLinuxOciHttpRetirementSource(
        originalCustody,
        result,
        input,
        signal,
      );
      if (!application) return fail();
      const appCurrent = () => {
        if (
          signal.aborted ||
          originalLinuxOciHttpRetirementSource(originalCustody, result, input, signal) !==
            application
        )
          return fail();
      };
      await application.close();
      appCurrent();
      const loaded = await boundStartRecord(input);
      if (
        !usable(loaded.proof, "observe") ||
        loaded.proof.i_serving_generation !== input.intent.policy.generation ||
        (await boundInitPhase(loaded)) !== "running" ||
        !(await inspectV2ContainerOwnerShutdownIoSchema(sql))
      )
        return fail();
      const coordinates = [
        input.intent.resourceUid,
        input.intent.policy.generation,
        input.claimId,
        input.nativeId,
      ];
      const control = await sql.query(
        "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND native_id=? AND state='bound' AND allocation_cleanup='untouched'",
        coordinates,
      );
      const raw = control[0]?.native_control;
      if (
        control.length !== 1 ||
        typeof raw !== "string" ||
        raw.length > 65536 ||
        raw === V2_CONTAINER_CONTROL_RESERVED
      )
        return fail();
      const scope = await shutdownIoScope(input, raw);
      const previous = await sql.query(
        "SELECT close_document FROM tf_v2_container_shutdown_io_closes WHERE resource_uid=? AND generation=? AND claim_id=? AND native_id=?",
        coordinates,
      );
      if (previous.length > 1) return fail();
      if (previous.length === 1) {
        const currentReceipt = await readApplicationCloseFact(
          previous[0]?.close_document,
          scope,
          shutdownIoCloseKind,
        );
        await assertSnapshot(loaded.proof);
        appCurrent();
        currentReceipt();
        return;
      }
      const selected = await sealApplicationCloseFact(scope, shutdownIoCloseKind);
      const guard = fence(loaded.proof);
      appCurrent();
      selected.assertCurrent();
      const saved = await sql.run(
        "INSERT INTO tf_v2_container_shutdown_io_closes (resource_uid,generation,claim_id,native_id,close_document) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND native_id=? AND state='bound' AND allocation_cleanup='untouched' AND native_control=?) AND " +
          guard.sql,
        [...coordinates, selected.document, ...coordinates, raw, ...guard.params],
      );
      if (saved.changes !== 1) return fail();
      const confirmed = await sql.query(
        "SELECT close_document FROM tf_v2_container_shutdown_io_closes WHERE resource_uid=? AND generation=? AND claim_id=? AND native_id=?",
        coordinates,
      );
      if (confirmed.length !== 1 || confirmed[0]?.close_document !== selected.document)
        return fail();
      appCurrent();
      selected.assertCurrent();
    },
    async saveAcceptedParentControl(input, originalCustody, signal) {
      if (
        parentMode === undefined ||
        !freshControlClaims.has(input) ||
        !options.configuredInputs ||
        signal.aborted
      )
        return fail();
      const lease = await activeRecord(input, "reconcile");
      if (!(await current(lease)) || !(await inspectV2ContainerOwnerSelectedSchema(sql, "control")))
        return fail();
      const entry = originalLinuxOciParentControlSource(originalCustody, result, input, signal);
      const loaded = await load(input.intent),
        saved = sameRecord(input, record(loaded.intent, loaded.proof));
      if (
        saved.state !== "pending" ||
        saved.nativeId !== null ||
        !usable(loaded.proof, "reconcile")
      )
        return fail();
      const scope = Object.freeze({
        purpose: peerMode ? peerPurpose : "takoserver.linux-oci-parent-control@1",
        claimId: input.claimId,
        installationId,
        resourceUid: input.intent.resourceUid,
        incarnationId: input.intent.incarnationId,
        generation: input.intent.policy.generation,
        revision: input.intent.revision,
        operationId: loaded.proof.a_operation_id,
        principal: loaded.proof.i_principal,
        space: loaded.proof.i_space,
        form: loaded.proof.i_form_url,
        backendId,
        targetKey,
        action: loaded.proof.a_action,
        acceptedFingerprint: loaded.proof.a_fingerprint,
        policyDigest: input.intent.policy.policyDigest,
        artifact: entry.receipt,
      });
      const initializeAllocation =
        peerMode && (await inspectV2ContainerOwnerSelectedSchema(sql, "allocation"));
      const initializeApplicationIo =
        peerMode && (await inspectV2ContainerOwnerSelectedSchema(sql, "application-io"));
      freshControlClaims.delete(input); // consumed before async sealing/save, never a retry grant
      const sealed = await sealOriginalLinuxOciParentControl(
        originalCustody,
        result,
        input,
        options.configuredInputs.keyring.current,
        canonicalJson(scope),
        signal,
        peerMode,
      );
      if (
        !(await current(lease)) ||
        signal.aborted ||
        originalLinuxOciParentControlSource(originalCustody, result, input, signal) !== entry
      )
        return fail();
      const fresh = await load(input.intent),
        guard = fence(fresh.proof);
      sameRecord(input, record(fresh.intent, fresh.proof));
      const document = canonicalJson({
        kind: "linux-oci-sealed-control@1",
        scope,
        ...sealed,
      });
      if (!lease.active || lease.controller.signal.aborted || signal.aborted) return fail();
      const write = await sql.run(
        "UPDATE tf_v2_container_create_claims SET native_control=?" +
          (initializeAllocation ? ",allocation_cleanup='untouched'" : "") +
          (initializeApplicationIo
            ? ",application_io_cleanup=" + "'" + V2_CONTAINER_APPLICATION_IO_RESERVED + "'"
            : "") +
          " WHERE resource_uid=? AND generation=? AND claim_id=? AND state='pending' AND native_id IS NULL AND native_control=? AND " +
          guard.sql,
        [
          document,
          input.intent.resourceUid,
          input.intent.policy.generation,
          input.claimId,
          V2_CONTAINER_CONTROL_RESERVED,
          ...guard.params,
        ],
      );
      if (write.changes !== 1 || !(await current(lease)) || signal.aborted) return fail();
      const rows = await sql.query(
        "SELECT native_control FROM tf_v2_container_create_claims WHERE resource_uid=? AND generation=? AND claim_id=? AND state='pending' AND native_id IS NULL",
        [input.intent.resourceUid, input.intent.policy.generation, input.claimId],
      );
      if (
        rows.length !== 1 ||
        rows[0]?.native_control !== document ||
        originalLinuxOciParentControlSource(originalCustody, result, input, signal) !== entry ||
        !(await current(lease))
      )
        return fail();
    },
    async readAcceptedParentControl(execution, input, originalCustody, signal) {
      const observation = await acceptedParentControl(execution, input, originalCustody, signal);
      if (
        observation &&
        observation.kind !== "linux-oci-parent-h-exited@1" &&
        observation.kind !== "linux-oci-parent-h-result-refused@1"
      )
        return fail();
      return observation;
    },
    async readAcceptedApplicationRecovery(execution, input, originalCustody, signal) {
      const observation = await acceptedParentControl(
        execution,
        input,
        originalCustody,
        signal,
        "application-recovery",
      );
      if (
        !observation ||
        (observation.kind !== "linux-oci-parent-application-owner-exited@1" &&
          (observation.kind !== "linux-oci-parent-h-exited@1" || observation.error !== 0) &&
          !(runtimeApplicationOwner && observation.kind === "linux-oci-peer-init-progress@1"))
      )
        return fail();
      return observation;
    },
    async manageAcceptedPeerInit(execution, input, originalCustody, signal) {
      const observation = await acceptedParentControl(
        execution,
        input,
        originalCustody,
        signal,
        true,
      );
      if (
        !observation ||
        (observation.kind !== "linux-oci-peer-init-progress@1" &&
          (observation.kind !== "linux-oci-parent-h-exited@1" || observation.error !== 0))
      )
        return fail();
      return observation;
    },
    async finalizeAcceptedDelete(execution, originalCustody, signal) {
      if (
        !trackedPeer ||
        execution.action !== "delete" ||
        signal.aborted ||
        !(await inspectV2ContainerOwnerSelectedSchema(sql, "final-delete"))
      )
        return fail();
      const accepted = await result.readAcceptedExecution(execution);
      if (
        !accepted.retained.length ||
        accepted.retained.some(
          (item) =>
            item.record.state !== "removed" ||
            item.record.nativeId === null ||
            item.removedAtMs === null,
        )
      )
        return fail();
      // Keep the actual original remove leases and decrypted same-operation
      // control/close facts alive through final material disposal. A removed
      // string or missing map alone cannot enter this owning closure.
      const sources: { refresh: RetiredCurrent; proof: Proof }[] = [];
      let localFences: (() => void)[] = [];
      const local = () => {
        if (signal.aborted || localFences.length !== sources.length) return fail();
        executionScope(execution);
        for (const fence of localFences) fence();
      };
      const refresh = async () => {
        const fences: (() => void)[] = [];
        for (const source of sources) fences.push(await source.refresh());
        localFences = fences;
        local();
      };
      const finish = async (index: number): Promise<void> => {
        const item = accepted.retained[index];
        if (item) {
          return owner.withAuthority(item.record, "remove", async () => {
            const current = await acceptedParentControl(
              execution,
              item.record,
              originalCustody,
              signal,
              "retired",
            );
            const loaded = await load(item.record.intent);
            sameRecord(item.record, record(loaded.intent, loaded.proof));
            if (!retiredDeleteProof(loaded.proof, "a")) return fail();
            sources.push({ refresh: current, proof: loaded.proof });
            await finish(index + 1);
          });
        }
        await refresh();
        const materials = await sql.query(
          "SELECT operation_id,generation FROM tf_v2_operation_configured_private_inputs WHERE resource_uid=? LIMIT 4097",
          [accepted.resourceUid],
        );
        if (materials.length > 4096) return fail();
        for (const material of materials) {
          const source = sources.find(
            (source) =>
              source.proof.a_operation_id === material.operation_id &&
              source.proof.a_generation === material.generation,
          );
          if (
            !source ||
            typeof material.operation_id !== "string" ||
            typeof material.generation !== "number" ||
            material.generation < 2
          )
            return fail();
          const input = Object.freeze({
            principal: accepted.principal,
            space: accepted.space,
            name: accepted.name,
            form: accepted.form,
            resourceUid: accepted.resourceUid,
            backendId,
            targetKey,
            operationId: material.operation_id,
            generation: material.generation,
            deleteOperationId: execution.operationId,
            deleteGeneration: execution.generation,
            leaseToken: execution.leaseToken,
          });
          const discard = createV2FinalDeleteConfiguredUpdateDiscard({
            sql,
            assertCurrent: local,
            async assertRetired(candidate, candidateSignal) {
              if (candidateSignal !== signal || canonicalJson(candidate) !== canonicalJson(input))
                return fail();
              await refresh();
            },
          });
          await discard.discard(input, signal);
        }
        await refresh();
        const snapshots = sources.map(({ proof }) => {
          const nonsecret = fields.filter(
            (field) => field.key !== "a_configured_private_inputs_json",
          );
          return {
            sql:
              "EXISTS (SELECT 1" +
              from +
              " WHERE " +
              nonsecret.map((field) => field.column + " IS ?").join(" AND ") +
              ")",
            params: nonsecret.map((field) => proof[field.key]!),
          };
        });
        const shape = v2FinalDeleteConfiguredUpdateSchemaFence();
        const guard = {
          sql:
            snapshots.map((value) => value.sql).join(" AND ") +
            " AND " +
            sources.map((source) => source.refresh.snapshot.sql).join(" AND ") +
            " AND EXISTS (SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources resource ON resource.uid=op.resource_uid WHERE op.id=? AND op.resource_uid=? AND op.lease_token=? AND op.lease_until_ms>(CAST(strftime('%s','now') AS INTEGER)+1)*1000 AND op.action='delete' AND op.generation=? AND op.status='reconciling' AND op.effect='unknown' AND op.dispatch_possible=1 AND resource.last_operation=op.id AND resource.busy_operation=op.id AND resource.generation=op.generation AND resource.phase='deleting' AND resource.deleted_at IS NULL AND resource.spec_json=op.accepted_spec_json)" +
            " AND (SELECT count(*) FROM tf_v2_container_create_claims WHERE resource_uid=?)=?" +
            " AND NOT EXISTS (SELECT 1 FROM tf_v2_operation_configured_private_inputs WHERE resource_uid=?) AND " +
            shape.sql,
          params: [
            ...snapshots.flatMap((value) => value.params),
            ...sources.flatMap((source) => source.refresh.snapshot.params ?? []),
            execution.operationId,
            execution.resourceUid,
            execution.leaseToken,
            execution.generation,
            accepted.resourceUid,
            sources.length,
            accepted.resourceUid,
            ...(shape.params ?? []),
          ],
        };
        const assertion = {
          sql:
            "INSERT INTO tf_v2_configured_update_discard_gate(operation_id) SELECT NULL WHERE NOT (" +
            guard.sql +
            ")",
          params: guard.params,
        };
        // Native retirement and all original facts are already authenticated.
        // Release this owner's redundant cipherpayload cache before the final
        // batch, including a lost-ACK exit. This never grants SQL completion:
        // durable payload erasure/currentness below must still succeed.
        local();
        closedContextAdmission.add(accepted.resourceUid);
        for (const [operationId, context] of contexts)
          if (context.resourceUid === accepted.resourceUid) contexts.delete(operationId);
        local(); // no await before the actual atomic batch dispatch
        const writes = await sql.batch([
          assertion,
          {
            sql:
              "UPDATE tf_v2_container_acceptances SET configured_private_inputs_json=NULL WHERE resource_uid=? AND configured_private_inputs_json IS NOT NULL AND " +
              guard.sql,
            params: [accepted.resourceUid, ...guard.params],
          },
          {
            sql:
              assertion.sql +
              " OR EXISTS (SELECT 1 FROM tf_v2_container_acceptances WHERE resource_uid=? AND configured_private_inputs_json IS NOT NULL)",
            params: [...guard.params, accepted.resourceUid],
          },
        ]);
        if (writes.length !== 3 || writes[0]?.changes !== 0 || writes[2]?.changes !== 0)
          return fail();
        await refresh();
        local();
        // Engine's existing deleted_at settlement/0081 trigger destroys the
        // Resource-owned CREATE map; this consumer does not duplicate it.
      };
      await finish(0);
    },
    async claimAcceptedTopology(execution, input, originalCustody, signal) {
      const intent = intentSnapshot(input);
      const accepted = await result.readAcceptedExecution(execution);
      if (
        accepted.action === "delete" ||
        accepted.resourceUid !== intent.resourceUid ||
        accepted.generation !== intent.policy.generation ||
        accepted.incarnationId !== intent.incarnationId ||
        accepted.revision !== intent.revision
      )
        return fail();
      // Preserve the original durable random one-use claim. No new constructor
      // can replace a pending/unknown claim, even if there is only one SQL row.
      const claimed = await owner.claim(intent);
      if (claimed.status !== "won") return fail();
      const captured = claimed.record;
      const rows = await sql.query(
        "SELECT q.resource_uid,q.generation,q.installation_id,q.claim_id,q.state,q.native_id,q.claimed_at_ms,q.bound_at_ms,q.removed_at_ms,i.target_key FROM main.tf_v2_container_create_claims q LEFT JOIN main.tf_v2_container_instances i ON i.resource_uid=q.resource_uid WHERE i.target_key=? OR i.resource_uid IS NULL LIMIT 4097",
        [targetKey],
      );
      if (rows.length < 1 || rows.length > 4096) return fail();
      let foundOriginal = false;
      const previous: DockerContainerCreateRecord[] = [];
      for (const row of rows) {
        const claimedAt = row.claimed_at_ms,
          boundAt = row.bound_at_ms,
          removedAt = row.removed_at_ms;
        if (
          !text(row.resource_uid) ||
          typeof row.generation !== "number" ||
          !Number.isSafeInteger(row.generation) ||
          row.generation < 1 ||
          !text(row.installation_id) ||
          !hex(row.claim_id) ||
          row.target_key !== targetKey ||
          typeof claimedAt !== "number" ||
          !Number.isSafeInteger(claimedAt) ||
          claimedAt < 0 ||
          !(
            (row.state === "pending" &&
              row.native_id === null &&
              boundAt === null &&
              removedAt === null) ||
            ((row.state === "bound" || row.state === "removed") &&
              hex(row.native_id) &&
              typeof boundAt === "number" &&
              Number.isSafeInteger(boundAt) &&
              boundAt >= claimedAt &&
              (row.state === "bound"
                ? removedAt === null
                : typeof removedAt === "number" &&
                  Number.isSafeInteger(removedAt) &&
                  removedAt >= boundAt))
          )
        )
          return fail();
        if (
          row.claim_id === captured.claimId &&
          row.resource_uid === captured.intent.resourceUid &&
          row.generation === captured.intent.policy.generation &&
          row.installation_id === captured.intent.installationId &&
          row.state === "pending" &&
          row.native_id === null
        ) {
          if (foundOriginal) return fail();
          foundOriginal = true;
          continue;
        }
        // The optional two-tuple source permits only this same Resource's
        // original generations. Missing old AEAD coordinates never come from
        // today's configuration; another Resource remains a hard collision.
        if (
          topologies?.alternate === undefined ||
          row.resource_uid !== captured.intent.resourceUid ||
          row.installation_id !== captured.intent.installationId ||
          row.state === "pending" ||
          Number(row.generation) >= captured.intent.policy.generation
        )
          return fail();
        const old = accepted.retained.find(
          (item) =>
            item.record.claimId === row.claim_id &&
            item.record.intent.policy.generation === row.generation,
        );
        if (
          !old ||
          old.record.state !== row.state ||
          old.record.nativeId !== row.native_id ||
          old.removedAtMs !== row.removed_at_ms
        )
          return fail();
        if (
          old.record.state !== "removed" &&
          !linuxOciPeerNetworksDisjoint(
            linuxOciGenerationTopology(topologies, old.record.intent.policy.generation),
            linuxOciGenerationTopology(topologies, captured.intent.policy.generation),
          )
        )
          return fail();
        previous.push(old.record);
      }
      if (!foundOriginal) return fail();
      const held: (() => void)[] = [];
      const check = async (index: number): Promise<Awaited<ReturnType<typeof owner.claim>>> => {
        const old = previous[index];
        if (old)
          return owner.withAuthority(
            old,
            old.state === "removed" ? "remove" : "observe",
            async () => {
              const coordinates = await acceptedParentControl(
                execution,
                old,
                originalCustody,
                signal,
                "coordinates",
              );
              const localCoordinates = await coordinates();
              held.push(localCoordinates);
              if (old.state === "removed") {
                const retired = await acceptedParentControl(
                  execution,
                  old,
                  originalCustody,
                  signal,
                  "retired",
                );
                held.push(await retired());
              }
              return check(index + 1);
            },
          );
        const fresh = await result.readAcceptedExecution(execution);
        const saved = fresh.retained.find(({ record }) => record.claimId === captured.claimId);
        if (
          fresh.action === "delete" ||
          fresh.resourceUid !== captured.intent.resourceUid ||
          fresh.generation !== captured.intent.policy.generation ||
          !saved ||
          saved.removedAtMs !== null ||
          canonicalJson(saved.record) !== canonicalJson(captured)
        )
          return fail();
        await assertExecution(execution);
        if (signal.aborted) return fail();
        for (const local of held) local();
        executionScope(execution);
        return claimed;
      };
      return check(0);
    },

    releaseRetainedNamespace(execution, record, originalCustody, signal) {
      return retainedNamespace(execution, record, originalCustody, signal, "release");
    },
    observeRetainedNamespaceLifetime(execution, record, originalCustody, signal) {
      return retainedNamespace(execution, record, originalCustody, signal, "observe");
    },
    advanceRetainedBornDisposal(execution, record, originalCustody, signal) {
      return retainedNamespace(execution, record, originalCustody, signal, "dispose");
    },
    disposeRetainedAllocation(execution, record, originalCustody, signal) {
      return retainedNamespace(execution, record, originalCustody, signal, "allocation");
    },
    async claimAcceptedStart(input: DockerContainerCreateRecord) {
      // Snapshot data before the first await. Accessors or a later caller edit
      // cannot switch the record between the original lease and Sql checks.
      if (
        !own(input, ["claimId", "intent", "nativeId", "state"]) ||
        !hex(input.claimId) ||
        !hex(input.nativeId) ||
        input.state !== "bound"
      )
        return fail();
      const captured = Object.freeze({
        claimId: input.claimId,
        intent: intentSnapshot(input.intent),
        nativeId: input.nativeId,
        state: "bound" as const,
      });
      // A bound DTO is insufficient: the SAME original owner must currently hold
      // this accepted claim's reconcile lease and its current Sql snapshot.
      const lease = await activeRecord(captured, "reconcile");
      const loaded = await boundStartRecord(captured);
      const selected = [...executions].filter(
        (scope) =>
          scope.operationId === loaded.proof.a_operation_id &&
          scope.resourceUid === loaded.intent.resourceUid &&
          scope.generation === loaded.intent.policy.generation,
      );
      if (selected.length !== 1) return fail();
      const scope = selected[0];
      if (!scope) return fail();
      // This API is for the accepted execution path. A durable record/fresh
      // authority lease alone cannot consume START outside its real execution.
      await assertExecution(scope.execution);
      const result = await claimBoundStart(loaded, lease);
      await assertExecution(scope.execution);
      // The final Sql await can outlive the original authority callback.
      // Recheck local ownership synchronously; no further await opens a gap.
      if (!lease.active || lease.controller.signal.aborted || !leases.has(lease)) return fail();
      executionScope(scope.execution);
      return result;
    },
    async confirmAcceptedRunning(input, originalCustody, signal) {
      if (
        !own(input, ["claimId", "intent", "nativeId", "state"]) ||
        !hex(input.claimId) ||
        !hex(input.nativeId) ||
        input.state !== "bound" ||
        signal.aborted
      )
        return fail();
      const captured = Object.freeze({
        claimId: input.claimId,
        intent: intentSnapshot(input.intent),
        nativeId: input.nativeId,
        state: "bound" as const,
      });
      const lease = await activeRecord(captured, "reconcile");
      const loaded = await boundStartRecord(captured);
      if (
        !usable(loaded.proof, "reconcile") ||
        loaded.proof.i_desired_generation !== loaded.intent.policy.generation
      )
        return fail();
      const selected = [...executions].filter(
        (scope) =>
          scope.operationId === loaded.proof.a_operation_id &&
          scope.resourceUid === loaded.intent.resourceUid &&
          scope.generation === loaded.intent.policy.generation,
      );
      if (selected.length !== 1) return fail();
      const scope = selected[0];
      if (!scope) return fail();
      await assertExecution(scope.execution);
      if (signal.aborted || !(await current(lease))) return fail();
      // Only the original creator can name its private same-Core CREATE/bind
      // custody. An arbitrary initialized session with the same claim is not it.
      const observation = await observeOriginalLinuxOciOwnedRunning(
        originalCustody,
        result,
        captured,
        signal,
      );
      if (observation.nativeId !== captured.nativeId || signal.aborted) return fail();
      await assertExecution(scope.execution);
      if (signal.aborted || !(await current(lease))) return fail();
      if ((await confirmBoundRunning(loaded, lease)) !== "confirmed") return fail();
      await assertExecution(scope.execution);
      if (signal.aborted || !lease.active || lease.controller.signal.aborted || !leases.has(lease))
        return fail();
      executionScope(scope.execution);
      return observation;
    },
    async publishAcceptedOciServing(input, originalCustody, signal) {
      if (
        !own(input, ["claimId", "intent", "nativeId", "state"]) ||
        !hex(input.claimId) ||
        !hex(input.nativeId) ||
        input.state !== "bound" ||
        !(signal instanceof AbortSignal) ||
        signal.aborted
      )
        return fail();
      const captured = Object.freeze({
        claimId: input.claimId,
        intent: intentSnapshot(input.intent),
        nativeId: input.nativeId,
        state: "bound" as const,
      });
      const lease = await activeRecord(captured, "reconcile");
      const loaded = await boundStartRecord(captured);
      if (
        !usable(loaded.proof, "reconcile") ||
        loaded.proof.i_desired_generation !== loaded.intent.policy.generation ||
        loaded.proof.i_retired_at_ms !== null
      )
        return fail();
      const selected = [...executions].filter(
        (scope) =>
          scope.operationId === loaded.proof.a_operation_id &&
          scope.resourceUid === loaded.intent.resourceUid &&
          scope.generation === loaded.intent.policy.generation,
      );
      const scope = selected.length === 1 ? selected[0] : undefined;
      if (!scope) return fail();
      const local = () => {
        if (
          signal.aborted ||
          !lease.active ||
          lease.controller.signal.aborted ||
          !leases.has(lease)
        )
          return fail();
        executionScope(scope.execution);
      };
      let identity: LinuxOciStartedObservation | undefined;
      const verify = async () => {
        local();
        await assertExecution(scope.execution);
        if (!(await current(lease))) return fail();
        local();
        const observation = await observeOriginalLinuxOciOwnedRunning(
          originalCustody,
          result,
          captured,
          signal,
        );
        if (
          observation.nativeId !== captured.nativeId ||
          (identity !== undefined &&
            (observation.namespaceDevice !== identity.namespaceDevice ||
              observation.namespaceInode !== identity.namespaceInode))
        )
          return fail();
        identity = observation;
        // This publisher never promotes pending to running. Only the original
        // completed START confirmation may have established this exact row.
        const attempts = await sql.query(
          "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?",
          [captured.intent.resourceUid, captured.intent.policy.generation],
        );
        const attempt = attempts[0];
        if (
          attempts.length !== 1 ||
          !attempt ||
          attempt.attempt !== 1 ||
          attempt.create_claim_id !== captured.claimId ||
          attempt.native_id !== captured.nativeId ||
          attempt.state !== "running" ||
          attempt.confirmed_exited_at_ms !== null ||
          typeof attempt.claimed_at_ms !== "number" ||
          !Number.isSafeInteger(attempt.claimed_at_ms) ||
          attempt.claimed_at_ms < 0 ||
          typeof attempt.confirmed_running_at_ms !== "number" ||
          !Number.isSafeInteger(attempt.confirmed_running_at_ms) ||
          attempt.confirmed_running_at_ms < attempt.claimed_at_ms
        )
          return fail();
        await assertExecution(scope.execution);
        if (!(await current(lease))) return fail();
        local();
      };
      await publishBoundServing(lease, verify, () => boundStartRecord(captured), local);
      // SQL may already have published when cancellation wins. Keep that
      // actual fact; no rollback, START/OPEN replay or manufactured completion.
      local();
    },
    async readCurrentOciInit(input, originalCustody, signal) {
      if (!runtimeApplicationOwner || !(signal instanceof AbortSignal) || signal.aborted)
        return fail();
      const { captured, loaded } = await loadServingOci(input, signal);
      if (
        loaded.proof.r_phase === "deleting" ||
        !(await inspectV2ContainerOwnerSelectedSchema(sql, "allocation"))
      )
        return fail();
      const coordinates = [
        captured.intent.resourceUid,
        captured.intent.policy.generation,
        captured.claimId,
        captured.nativeId,
      ];
      const allocationPredicate =
        "resource_uid=? AND generation=? AND claim_id=? AND native_id=? AND state='bound' AND allocation_cleanup='untouched'";
      const rows = await sql.query(
        "SELECT native_control FROM tf_v2_container_create_claims WHERE " + allocationPredicate,
        coordinates,
      );
      const raw = rows[0]?.native_control;
      if (rows.length !== 1 || typeof raw !== "string") return fail();
      const snapshot = fence(loaded.proof);
      const guard = {
        sql:
          snapshot.sql +
          " AND EXISTS (SELECT 1 FROM tf_v2_container_create_claims WHERE " +
          allocationPredicate +
          " AND native_control=?)",
        params: [...snapshot.params, ...coordinates, raw],
      };
      const currentRunning = async () =>
        !signal.aborted && (await boundInitPhase(loaded, guard)) === "running" && !signal.aborted;
      const { artifact, binding, originalControlKeyId, key } = await openOriginalParentControl(
        captured,
        originalCustody,
        loaded.proof,
        raw,
        signal,
        currentRunning,
      );
      freezeJson(artifact);
      freezeJson(binding);
      let active = true;
      const assertLocal = () => {
        if (!active || signal.aborted || controlDecryptionKey?.(originalControlKeyId) !== key)
          return fail();
      };
      const assertCurrent = async () => {
        assertLocal();
        if (!(await currentRunning())) return fail();
        assertLocal();
      };
      try {
        await assertCurrent();
        assertLocal();
        const observed = await readOriginalLinuxOciLiveInit(
          originalCustody,
          result,
          captured,
          artifact,
          binding,
          signal,
          assertCurrent,
        );
        await assertCurrent();
        assertLocal();
        if (observed.nativeId !== captured.nativeId) return fail();
        return observed;
      } finally {
        active = false;
      }
    },
    async observeServingOciHttp(input, originalCustody, signal) {
      const { captured, loaded } = await loadServingOci(input, signal);
      const spec = publicSpec(loaded.proof.a_accepted_spec_json);
      const port = spec[C.fields.httpPort];
      if (typeof port !== "number") return fail();
      if ((await boundInitPhase(loaded)) !== "running") return fail();
      const native = await observeOriginalLinuxOciOwnedRunning(
        originalCustody,
        result,
        captured,
        signal,
      );
      await assertSnapshot(loaded.proof);
      if (signal.aborted || native.nativeId !== captured.nativeId) return fail();
      return Object.freeze({ native, httpPort: port });
    },
    async stopRetainedInit(execution, input, originalCustody, signal) {
      if (
        !own(input, ["claimId", "intent", "nativeId", "state"]) ||
        !hex(input.claimId) ||
        !hex(input.nativeId) ||
        input.state !== "bound" ||
        signal.aborted
      )
        return fail();
      const captured = Object.freeze({
        claimId: input.claimId,
        intent: intentSnapshot(input.intent),
        nativeId: input.nativeId,
        state: "bound" as const,
      });
      const accepted = await result.readAcceptedExecution(execution);
      if (accepted.action !== "update" && accepted.action !== "delete") return fail();
      const retained = accepted.retained.find(
        ({ record: saved }) => saved.claimId === captured.claimId,
      );
      if (
        !retained ||
        retained.removedAtMs !== null ||
        captured.intent.policy.generation >= accepted.generation ||
        canonicalJson(retained.record) !== canonicalJson(captured)
      )
        return fail();
      // A current desired/serving generation is not removable. Keep the exact
      // original remove eligibility and accepted-state fence before any STOP.
      const lease = await activeRecord(captured, "remove");
      const loaded = await boundStartRecord(captured);
      if (!usable(loaded.proof, "remove")) return fail();
      const guard = async () => {
        await assertExecution(execution);
        if (
          signal.aborted ||
          !(await current(lease)) ||
          !lease.active ||
          lease.controller.signal.aborted ||
          !leases.has(lease)
        )
          return fail();
        executionScope(execution);
      };
      await guard();
      await stopOriginalLinuxOciOwnedInit(originalCustody, result, captured, signal);
      await guard();
      // A STOP reply alone is not the observation recorded below. JOIN reads
      // the SAME original consuming-reap fact, without another signal/effect.
      const observation = await observeOriginalLinuxOciOwnedInitReaped(
        originalCustody,
        result,
        captured,
        signal,
      );
      await guard();
      if ((await confirmBoundStopped(loaded, lease)) !== "confirmed") return fail();
      await assertExecution(execution);
      if (signal.aborted || !lease.active || lease.controller.signal.aborted || !leases.has(lease))
        return fail();
      executionScope(execution);
      return observation;
    },
    async readAcceptedExecution(execution: V2Execution): Promise<DockerContainerAcceptedExecution> {
      await assertExecution(execution);
      const deleting = execution.action === "delete";
      const rows = await sql.query(
        select +
          (deleting
            ? " WHERE i.resource_uid=? LIMIT 4097"
            : " WHERE i.resource_uid=? AND v.generation <= ? ORDER BY v.generation DESC LIMIT 4097"),
        deleting ? [execution.resourceUid] : [execution.resourceUid, execution.generation],
      );
      if (rows.length < 1 || rows.length > 4096) return fail();
      const proofs = rows.map(rowProof);
      const first = proofs[0]!;
      if (!deleting && first.v_generation !== execution.generation) return fail();
      const alias = "la";
      const current = (proof: Proof, key: string) => proof[alias + "_" + key];
      const retained: {
        readonly record: DockerContainerCreateRecord;
        readonly spec: JsonObject;
        readonly removedAtMs: number | null;
      }[] = [];
      for (const proof of proofs) {
        accepted(proof, "a", "o");
        accepted(proof, "la", "lo");
        const expected: readonly [string, unknown][] = [
          ["operation_id", execution.operationId],
          ["resource_uid", execution.resourceUid],
          ["principal", execution.principal],
          ["space", execution.space],
          ["name", execution.name],
          ["form_url", V2_CONTAINER_F2_FORM],
          ["backend_id", backendId],
          ["target_key", targetKey],
          ["action", execution.action],
          ["generation", execution.generation],
          ["backend_key", execution.backendKey],
        ];
        if (
          !expected.every(([key, value]) => current(proof, key) === value) ||
          proof.i_resource_uid !== execution.resourceUid ||
          proof.i_installation_id !== installationId ||
          proof.i_form_url !== V2_CONTAINER_F2_FORM ||
          proof.i_backend_id !== backendId ||
          proof.i_target_key !== targetKey ||
          !hex(proof.i_incarnation_id) ||
          proof.i_incarnation_id !== first.i_incarnation_id ||
          proof.i_desired_generation !== execution.generation ||
          proof.la_operation_id !== execution.operationId ||
          proof.r_uid !== execution.resourceUid ||
          proof.r_principal !== execution.principal ||
          proof.r_form_url !== V2_CONTAINER_F2_FORM ||
          proof.r_space !== execution.space ||
          proof.r_name !== execution.name ||
          proof.r_backend_id !== backendId ||
          proof.r_target_key !== targetKey ||
          proof.r_generation !== execution.generation ||
          proof.r_active_name !== execution.name ||
          proof.r_deleted_at !== null ||
          proof.r_last_operation !== execution.operationId ||
          proof.v_operation_id !== proof.a_operation_id ||
          proof.v_generation !== proof.a_generation ||
          proof.v_revision !== proof.a_revision
        )
          return fail();
        if (
          deleting
            ? proof.i_retire_operation_id !== execution.operationId ||
              typeof proof.i_retired_at_ms !== "number" ||
              Number(proof.v_generation) >= execution.generation
            : proof.i_retire_operation_id !== null ||
              proof.i_retired_at_ms !== null ||
              !Number.isSafeInteger(proof.v_generation) ||
              Number(proof.v_generation) < 1 ||
              Number(proof.v_generation) > execution.generation
        )
          return fail();
        const selectedSpec = publicSpec(current(proof, "accepted_spec_json"));
        if (
          canonicalJson(selectedSpec) !== canonicalJson(execution.spec) ||
          canonicalJson(publicSpec(proof.r_spec_json)) !== canonicalJson(selectedSpec)
        )
          return fail();
        await configuredSnapshot(proof, "a");
        await configuredSnapshot(proof, "la");
        if (proof.q_claim_id === null) {
          if (proof.v_intent_json !== null) return fail();
        } else {
          if (typeof proof.v_intent_json !== "string") return fail();
          const parsed = parseStrictJson(new TextEncoder().encode(proof.v_intent_json), 1048576);
          if (!isJsonObject(parsed)) return fail();
          const loaded = await load(
            intentSnapshot(parsed as unknown as DockerContainerCreateIntent),
          );
          const saved = record(loaded.intent, loaded.proof);
          if (
            !saved ||
            !(
              usable(loaded.proof, deleting ? "remove" : "observe") ||
              (!deleting && usable(loaded.proof, "remove"))
            )
          )
            return fail();
          const removedAtMs = loaded.proof.q_removed_at_ms;
          if (
            saved.state === "removed"
              ? typeof removedAtMs !== "number" ||
                !Number.isSafeInteger(removedAtMs) ||
                removedAtMs < Number(loaded.proof.q_claimed_at_ms)
              : removedAtMs !== null
          )
            return fail();
          retained.push(
            Object.freeze({
              record: saved,
              spec: publicSpec(proof.a_accepted_spec_json),
              removedAtMs: removedAtMs as number | null,
            }),
          );
        }
        await assertSnapshot(proof);
        await assertExecution(execution);
      }
      {
        const claims = await sql.query(
          "SELECT generation,claim_id FROM main.tf_v2_container_create_claims WHERE resource_uid=? LIMIT 4097",
          [execution.resourceUid],
        );
        if (
          claims.length > 4096 ||
          claims.length !== retained.length ||
          !claims.every((row) =>
            retained.some(
              ({ record }) =>
                record.intent.policy.generation === row.generation &&
                record.claimId === row.claim_id,
            ),
          )
        )
          return fail();
      }
      let servingConfirmedAtMs: number | null = null;
      if (!deleting && first.i_serving_generation === execution.generation) {
        const serving = retained.find(
          ({ record }) => record.intent.policy.generation === execution.generation,
        )?.record;
        if (
          !serving ||
          serving.state !== "bound" ||
          serving.nativeId === null ||
          first.q_claim_id !== serving.claimId ||
          first.q_native_id !== serving.nativeId
        )
          return fail();
        const attempts = await sql.query(
          "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?",
          [execution.resourceUid, execution.generation],
        );
        if (attempts.length !== 1) return fail();
        const attempt = attempts[0]!;
        const claimedAt = attempt.claimed_at_ms;
        const confirmedAt = attempt.confirmed_running_at_ms;
        if (
          attempt.attempt !== 1 ||
          attempt.state !== "running" ||
          attempt.create_claim_id !== serving.claimId ||
          attempt.native_id !== serving.nativeId ||
          attempt.confirmed_exited_at_ms !== null ||
          typeof claimedAt !== "number" ||
          !Number.isSafeInteger(claimedAt) ||
          claimedAt < 0 ||
          typeof confirmedAt !== "number" ||
          !Number.isSafeInteger(confirmedAt) ||
          confirmedAt < claimedAt
        )
          return fail();
        servingConfirmedAtMs = confirmedAt;
        await assertSnapshot(first);
      }
      const spec = publicSpec(current(first, "accepted_spec_json"));
      const names = validateDockerContainerSpec(spec).requiredSensitiveVars;
      await assertExecution(execution);
      return Object.freeze({
        installationId,
        operationId: execution.operationId,
        resourceUid: execution.resourceUid,
        incarnationId: first.i_incarnation_id as string,
        principal: execution.principal,
        space: execution.space,
        name: execution.name,
        form: execution.form,
        backendId,
        targetKey,
        action: execution.action,
        generation: execution.generation,
        revision: current(first, "revision") as string,
        spec,
        requiredSecretNames: names,
        outboundInternet: (spec[C.fields.outboundInternet] ?? false) as boolean,
        retained: Object.freeze(retained),
        servingConfirmedAtMs,
      });
    },
    async withExecution<T>(execution: V2Execution, work: () => Promise<T>): Promise<T> {
      if (
        !execution ||
        typeof execution !== "object" ||
        typeof work !== "function" ||
        (Object.getPrototypeOf(execution) !== Object.prototype &&
          Object.getPrototypeOf(execution) !== null) ||
        ![
          "form",
          "backendId",
          "targetKey",
          "operationId",
          "resourceUid",
          "generation",
          "leaseToken",
          "action",
        ].every((key) =>
          Object.hasOwn(Object.getOwnPropertyDescriptor(execution, key) ?? {}, "value"),
        ) ||
        !Reflect.ownKeys(execution).every(
          (key) =>
            typeof key === "string" &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(execution, key) ?? {}, "value"),
        )
      )
        return fail();
      if (execution.form === C.formUrl) return work();
      if (
        execution.form !== V2_CONTAINER_F2_FORM ||
        execution.backendId !== backendId ||
        execution.targetKey !== targetKey ||
        !text(execution.operationId) ||
        !text(execution.resourceUid) ||
        !text(execution.leaseToken) ||
        !Number.isSafeInteger(execution.generation) ||
        execution.generation < 1 ||
        (execution.action !== "create" &&
          execution.action !== "update" &&
          execution.action !== "delete")
      )
        return fail();
      const scope = Object.freeze({
        execution,
        operationId: execution.operationId,
        resourceUid: execution.resourceUid,
        generation: execution.generation,
        leaseToken: execution.leaseToken,
        action: execution.action,
      });
      const scopes = execution.action === "delete" ? deleteExecutions : executions;
      scopes.add(scope);
      try {
        return await work();
      } finally {
        scopes.delete(scope);
      }
    },
    acceptance,
    owner,
    createCustody(policy: DockerContainerRuntimePolicy, requiredSecretNames: readonly string[]) {
      const names = validateV2ContainerF2SensitiveNames(requiredSecretNames);
      if (names.length > 0 && !configuredInputs) return fail();
      return createDockerContainerCreateCustody({ policy, requiredSecretNames: names, owner });
    },
  });
  if (options.configuredInputs)
    configuredInputs = createDockerContainerConfiguredInputs({
      sql,
      selection: { targetKey, providerInstallationId: installationId, backendId },
      owner: result,
      keyring: options.configuredInputs.keyring,
      maxSecretBytes: options.configuredInputs.maxSecretBytes,
    });
  return result;
}
