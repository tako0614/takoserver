import { bytesDigest, canonicalJson } from "../json.ts";
import type { V2KvBindingGrant } from "../providers/selfhost-v2-kv-binding-broker.ts";
import type {
  V2QueueProducerBindingGrant,
  V2QueueProducerBindingResolution,
} from "../providers/selfhost-v2-queue-producer-broker.ts";
import type { V2SqliteBindingGrant } from "../providers/selfhost-v2-sqlite-binding-broker.ts";
import { SELFHOST_WORKER_EDGE_SQL_BINDING_KIND } from "../providers/selfhost-worker-wrapper.ts";
import { canonicalSelfhostWeightedVersions } from "../selfhost-weighted-deployment.ts";
import type {
  WorkerdActorForwardBinding,
  WorkerdDeploymentPublication,
  WorkerdDeploymentVariant,
  WorkerdPublicationIdentity,
  WorkerdRuntime,
  WorkerdSite,
  WorkerdStaticSite,
} from "../workerd-runtime.ts";
import { internalHostname } from "../workerd-runtime.ts";
import {
  compileWorkerdVersionGraph,
  workerdVersionServiceBindingName,
} from "../workerd-version-graph.ts";
import type { ObjectBucketWorkerBindingClaim } from "./forms/object-bucket-worker-binding-authority.ts";
import type { SQLiteWorkerBindingClaim } from "./forms/sqlite-worker-binding-authority.ts";
import {
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
} from "./forms/worker-specs.ts";
import type { V2Execution } from "./types.ts";
import { projectV2WorkerCodeVersion } from "./worker-code-runtime.ts";
import type { V2CodeConfiguredInputReader } from "./worker-lifecycle-backend.ts";
import type { V2WorkerPublicationResolution } from "./worker-publication-state.ts";
import type { V2ResolvedServiceBinding } from "./worker-service-resolution.ts";
import {
  projectV2ResolvedServiceBindings,
  v2ServiceTargetName,
} from "./worker-service-resolution.ts";
import { projectV2StaticWorkerVersion } from "./worker-static-runtime.ts";
import type { V2WorkflowBindingClaim } from "./workflow-binding-authority.ts";
import { projectV2WorkflowForward } from "./workflow-binding-projection.ts";

const OPERATION_MARKER = "takoserver-v2-operation:";
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type PublicationState = {
  resolve(input: {
    execution: V2Execution;
    incumbentSourceOperationId?: string;
  }): Promise<V2WorkerPublicationResolution>;
};

type WorkerRuntime = Pick<
  WorkerdRuntime<WorkerdSite | WorkerdStaticSite>,
  "inspectModule" | "publishFenced" | "observeExactPublication"
>;

type Candidate = {
  readonly name: string;
  readonly identity: WorkerdPublicationIdentity | null;
  readonly publication: WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null;
  readonly deferRetirementUntilDeadline: boolean;
};

/** Immutable accepted caller-Version provenance passed only to the Host broker. */
export interface V2WorkerServiceBindingClaim {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

/** Exact serving-publication evidence, deliberately separate from Form settlement. */
export type V2WorkerPublicationResult =
  | {
      readonly kind: "confirmed";
      readonly identity: WorkerdPublicationIdentity;
      /** Code may keep ctx.waitUntil work alive after its HTTP response body ends. */
      readonly deferRetirementUntilDeadline: boolean;
    }
  | { readonly kind: "confirmed"; readonly identity: null }
  /** This invocation did not dispatch a runtime write; it proves no prior effect absent. */
  | { readonly kind: "not_dispatched"; readonly code: string }
  | { readonly kind: "unknown" };

/** Durable owner receipt for a DELETE when no Worker Deployment is active. */
export interface V2EndpointRouteAbsentReceipt {
  readonly kind: "confirmed_route_absent";
  readonly sourceOperationId: string;
  readonly endpointResourceUid: string;
  readonly workerResourceUid: string;
  readonly targetKey: string;
  readonly assignedHostname: string;
}

export interface V2WorkerPublication {
  publish(execution: V2Execution): Promise<V2WorkerPublicationResult>;
  /** Read-only exact serving check for an accepted Operation. */
  observe(execution: V2Execution): Promise<V2WorkerPublicationResult>;
}

function parseOperationMarker(generation: string): string | null {
  if (!generation.startsWith(OPERATION_MARKER)) return null;
  const operationId = generation.slice(OPERATION_MARKER.length);
  return OPERATION_ID.test(operationId) && `${OPERATION_MARKER}${operationId}` === generation
    ? operationId
    : null;
}

function scriptName(workerUid: string): Promise<string> {
  return v2ServiceTargetName(workerUid);
}

function isCurrentIdentityShape(identity: WorkerdPublicationIdentity): boolean {
  try {
    if (
      typeof identity.generation !== "string" ||
      typeof identity.workerResourceUid !== "string" ||
      !Array.isArray(identity.hostnames) ||
      !identity.hostnames.every((hostname) => typeof hostname === "string") ||
      !Array.isArray(identity.versions)
    ) {
      return false;
    }
    const canonicalVersions = canonicalSelfhostWeightedVersions(identity.versions);
    return (
      canonicalJson(canonicalVersions) === canonicalJson(identity.versions) &&
      canonicalJson([...identity.hostnames].sort()) === canonicalJson(identity.hostnames) &&
      new Set(identity.hostnames).size === identity.hostnames.length
    );
  } catch {
    return false;
  }
}

function expectedIdentity(
  publication: WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null,
): WorkerdPublicationIdentity | null {
  if (publication === null) return null;
  return {
    generation: publication.generation,
    workerResourceUid: publication.workerResourceUid,
    hostnames: [...publication.hostnames].sort(),
    versions: canonicalSelfhostWeightedVersions(
      publication.versions.map(({ versionId, workerVersionUid, weight }) => ({
        versionId,
        workerVersionUid,
        weight,
      })),
    ),
  };
}

function exactIdentity(
  current: WorkerdPublicationIdentity | null,
  expected: WorkerdPublicationIdentity | null,
): boolean {
  return (
    current !== null && expected !== null && canonicalJson(current) === canonicalJson(expected)
  );
}

function notDispatched(code: string): V2WorkerPublicationResult {
  return { kind: "not_dispatched", code };
}

function unknownResult(): V2WorkerPublicationResult {
  return { kind: "unknown" };
}

/**
 * Internal publication proof for accepted v2 Worker Deployments and
 * WorkerEndpoints containing static-only or currently supported fetch+vars
 * code Versions.
 * A Form backend must combine it with the Form's complete lifecycle before
 * settling its Operation; this port proves publication only.
 */
export function createV2WorkerPublication(options: {
  readonly targetKey: string;
  readonly publicationState: PublicationState;
  readonly runtime: WorkerRuntime;
  /** Trusted Resource-owned configured ciphertext reader, absent by default. */
  readonly configuredInputs?: V2CodeConfiguredInputReader;
  /** Incarnation-pinned private gate credential, absent for read-only projections. */
  readonly scheduledEventToken?: string;
  /** Boot-resolved private plane; the tenant Version spec cannot name it. */
  readonly v2QueueSettlement?: {
    readonly address: string;
    bindingToken(input: {
      readonly workerUid: string;
      readonly versionId: string;
      readonly servingSourceOperationId: string;
    }): string;
  };
  /** Fixed Host-private broker, never selected by a Worker Version. */
  readonly v2SqliteBinding?: {
    readonly address: string;
    issueGrant(grant: V2SqliteBindingGrant): string;
    resolveCurrentBinding(
      claim: SQLiteWorkerBindingClaim,
      binding: string,
    ): Promise<{ readonly resourceUid: string; readonly vector: string } | null>;
  };
  /** Fixed Host-private object broker; grants use exact selected Version provenance. */
  readonly v2ObjectBucketBinding?: {
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
  };
  /** Fixed Host-private KV broker; grants use exact selected Version provenance. */
  readonly v2KvBinding?: {
    readonly address: string;
    issueGrant(grant: V2KvBindingGrant): string;
    resolveCurrentBinding(
      claim: V2KvBindingGrant,
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
  };
  /** Fixed private Queue producer broker, separate from the consumer settlement plane. */
  readonly v2QueueProducerBinding?: {
    readonly address: string;
    issueGrant(grant: V2QueueProducerBindingGrant): string;
    resolveCurrentBinding(
      claim: V2QueueProducerBindingGrant,
      binding: string,
    ): Promise<V2QueueProducerBindingResolution | null>;
  };
  /** Per-incarnation Host broker, opened before the native Version is published. */
  readonly v2ServiceBindingForward?: {
    issueBinding(
      claim: V2WorkerServiceBindingClaim,
      binding: V2ResolvedServiceBinding,
    ): Promise<void>;
  };
  /** Same incarnation-scoped Actor grant source used by the native private brokers. */
  readonly v2ActorForward?: {
    issueBinding(
      claim: {
        readonly principal: string;
        readonly space: string;
        readonly targetKey: string;
        readonly workerUid: string;
        readonly workerVersionUid: string;
        readonly workerVersionOperationId: string;
        readonly nativeVersionId: string;
        readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
      },
      bindingName: string,
    ): Promise<{
      readonly publicName: string;
      readonly tenantId: string;
      readonly namespaceResourceUid: string;
      readonly className: string;
      readonly token: string;
      readonly runtimeClassRef: NonNullable<WorkerdActorForwardBinding["runtimeClassRef"]>;
    } | null>;
  };
  /** Incarnation-scoped signed grants from the accepted v2 Workflow authority. */
  readonly v2WorkflowForward?: {
    issueBinding(
      claim: V2WorkflowBindingClaim,
      bindingName: string,
    ): Promise<{
      readonly publicName: string;
      readonly tenantId: string;
      readonly workflowResourceUid: string;
      readonly token: string;
    } | null>;
  };
}): V2WorkerPublication {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const inspectModule = options.runtime.inspectModule;

  async function candidate(
    execution: V2Execution,
    resolution: Extract<V2WorkerPublicationResolution, { kind: "ready" }>,
  ): Promise<Candidate> {
    const snapshot = resolution.snapshot;
    const name = await scriptName(snapshot.worker.uid);
    if (!snapshot.deployment) {
      return {
        name,
        identity: null,
        publication: null,
        deferRetirementUntilDeadline: false,
      };
    }

    const generation = `${OPERATION_MARKER}${execution.operationId}`;
    const versions: WorkerdDeploymentVariant<WorkerdSite | WorkerdStaticSite>[] = [];
    let deferRetirementUntilDeadline = false;
    for (const version of snapshot.deployment.versions) {
      const versionSeed = `${version.uid}\u0000${version.generation}`;
      const versionDigest = await bytesDigest(new TextEncoder().encode(versionSeed));
      const materials = await resolution.readVersionMaterials(version.uid);
      const identity = {
        versionId: `v2-${versionDigest.slice("sha256:".length)}`,
        workerVersionUid: version.uid,
        weight: version.weight,
        workerResourceUid: snapshot.worker.uid,
        generation,
        directory: name,
        // Version variants are private and hostname-free. The outer logical
        // Worker publication owns the active Endpoint route.
        hostnames: [],
      };
      let projection: WorkerdDeploymentVariant<WorkerdSite | WorkerdStaticSite>;
      const versionSpec = parseWorkerVersionSpec(version.spec);
      if (versionSpec.bundle) {
        const actorClaims = versionSpec.actorBindings.map((binding) => ({
          name: binding.name,
          resourceUid: binding.resource.resourceUid,
        }));
        const actorForward = [] as {
          readonly publicName: string;
          readonly tenantId: string;
          readonly namespaceResourceUid: string;
          readonly className: string;
          readonly token: string;
          readonly runtimeClassRef: NonNullable<WorkerdActorForwardBinding["runtimeClassRef"]>;
        }[];
        if (actorClaims.length > 0) {
          const binder = options.v2ActorForward;
          if (!binder) throw new Error("native Actor forwarding is unavailable");
          const claim = {
            principal: snapshot.worker.principal,
            space: snapshot.worker.space,
            targetKey: options.targetKey,
            workerUid: snapshot.worker.uid,
            workerVersionUid: version.uid,
            workerVersionOperationId: version.sourceOperationId,
            nativeVersionId: identity.versionId,
            bindings: actorClaims,
          };
          for (const binding of actorClaims) {
            const issued = await binder.issueBinding(claim, binding.name);
            if (
              !issued ||
              issued.publicName !== binding.name ||
              issued.tenantId !== snapshot.worker.principal ||
              issued.namespaceResourceUid !== binding.resourceUid
            )
              throw new Error("current Actor binding is unavailable");
            actorForward.push(issued);
          }
          if (!(await resolution.stillCurrent())) throw new Error("Actor reference graph changed");
        }
        const workflowClaims = versionSpec.workflowBindings.map((binding) => ({
          name: binding.name,
          resourceUid: binding.resource.resourceUid,
        }));
        const workflowGrants = [] as {
          readonly publicName: string;
          readonly tenantId: string;
          readonly workflowResourceUid: string;
          readonly token: string;
        }[];
        if (workflowClaims.length > 0) {
          const binder = options.v2WorkflowForward;
          if (!binder) throw new Error("native Workflow forwarding is unavailable");
          const claim: V2WorkflowBindingClaim = {
            principal: snapshot.worker.principal,
            space: snapshot.worker.space,
            targetKey: options.targetKey,
            workerUid: snapshot.worker.uid,
            workerVersionUid: version.uid,
            workerVersionOperationId: version.sourceOperationId,
            nativeVersionId: identity.versionId,
            bindings: workflowClaims,
          };
          for (const binding of workflowClaims) {
            const issued = await binder.issueBinding(claim, binding.name);
            if (
              !issued ||
              issued.publicName !== binding.name ||
              issued.tenantId !== claim.principal ||
              issued.workflowResourceUid !== binding.resourceUid
            )
              throw new Error("current Workflow binding is unavailable");
            workflowGrants.push(issued);
          }
          if (!(await resolution.stillCurrent()))
            throw new Error("Workflow reference graph changed");
        }
        const sqliteBindings = versionSpec.sqliteBindings.map((binding) => ({
          name: binding.name,
          resourceUid: binding.resource.resourceUid,
        }));
        let sqliteBoot: { readonly address: string; readonly token: string } | undefined;
        if (sqliteBindings.length > 0) {
          const binder = options.v2SqliteBinding;
          if (!binder) throw new Error("native SQLite binding is unavailable");
          const claim: SQLiteWorkerBindingClaim = {
            principal: snapshot.worker.principal,
            space: snapshot.worker.space,
            targetKey: options.targetKey,
            workerUid: snapshot.worker.uid,
            workerVersionUid: version.uid,
            bindings: sqliteBindings,
          };
          for (const binding of sqliteBindings) {
            const current = await binder.resolveCurrentBinding(claim, binding.name);
            if (current?.resourceUid !== binding.resourceUid) {
              throw new Error("current SQLite binding is unavailable");
            }
          }
          if (!(await resolution.stillCurrent())) {
            throw new Error("SQLite binding reference graph changed");
          }
          const grant: V2SqliteBindingGrant = {
            ...claim,
            nativeVersionId: identity.versionId,
            incarnationId: execution.operationId,
            servingSourceOperationId: execution.operationId,
          };
          sqliteBoot = { address: binder.address, token: binder.issueGrant(grant) };
        }
        const bucketBindings = versionSpec.bucketBindings.map((binding) => ({
          name: binding.name,
          resourceUid: binding.resource.resourceUid,
        }));
        let objectBucketBoot:
          | {
              readonly address: string;
              readonly token: string;
              readonly bindings: readonly { readonly publicName: string }[];
            }
          | undefined;
        if (bucketBindings.length > 0) {
          const binder = options.v2ObjectBucketBinding;
          if (!binder || !OPERATION_ID.test(version.sourceOperationId)) {
            throw new Error("native ObjectBucket binding is unavailable");
          }
          const claim: ObjectBucketWorkerBindingClaim = {
            principal: snapshot.worker.principal,
            space: snapshot.worker.space,
            targetKey: options.targetKey,
            workerUid: snapshot.worker.uid,
            workerVersionUid: version.uid,
            workerVersionOperationId: version.sourceOperationId,
            nativeVersionId: identity.versionId,
            incarnationId: execution.operationId,
            servingSourceOperationId: execution.operationId,
            bindings: bucketBindings,
          };
          for (const binding of bucketBindings) {
            const current = await binder.resolveCurrentBucketBinding(claim, binding.name);
            if (
              !current ||
              current.identity.targetKey !== claim.targetKey ||
              current.identity.principal !== claim.principal ||
              current.identity.space !== claim.space ||
              current.identity.resourceUid !== binding.resourceUid ||
              typeof current.vector !== "string" ||
              current.vector.length === 0
            ) {
              throw new Error("current ObjectBucket binding is unavailable");
            }
          }
          if (!(await resolution.stillCurrent())) {
            throw new Error("ObjectBucket binding reference graph changed");
          }
          objectBucketBoot = {
            address: binder.address,
            token: binder.issueGrant(claim),
            bindings: bucketBindings.map(({ name }) => ({ publicName: name })),
          };
        }
        const codeObjectBucketBoot = bucketBindings.length > 0 ? objectBucketBoot : undefined;
        if (bucketBindings.length > 0 && !codeObjectBucketBoot) {
          throw new Error("native ObjectBucket binding is unavailable");
        }
        const kvBindings = versionSpec.kvBindings.map((binding) => ({
          name: binding.name,
          resourceUid: binding.resource.resourceUid,
        }));
        let kvBoot:
          | {
              readonly address: string;
              readonly token: string;
              readonly bindings: readonly { readonly publicName: string }[];
            }
          | undefined;
        if (kvBindings.length > 0) {
          const binder = options.v2KvBinding;
          if (!binder || !OPERATION_ID.test(version.sourceOperationId)) {
            throw new Error("native KV binding is unavailable");
          }
          const claim: V2KvBindingGrant = {
            principal: snapshot.worker.principal,
            space: snapshot.worker.space,
            targetKey: options.targetKey,
            workerUid: snapshot.worker.uid,
            workerVersionUid: version.uid,
            workerVersionOperationId: version.sourceOperationId,
            nativeVersionId: identity.versionId,
            incarnationId: execution.operationId,
            servingSourceOperationId: execution.operationId,
            bindings: kvBindings,
          };
          for (const binding of kvBindings) {
            const current = await binder.resolveCurrentBinding(claim, binding.name);
            if (
              !current ||
              current.identity.targetKey !== claim.targetKey ||
              current.identity.principal !== claim.principal ||
              current.identity.space !== claim.space ||
              current.identity.resourceUid !== binding.resourceUid ||
              typeof current.vector !== "string" ||
              current.vector.length === 0
            ) {
              throw new Error("current KV binding is unavailable");
            }
          }
          if (!(await resolution.stillCurrent())) {
            throw new Error("KV binding reference graph changed");
          }
          kvBoot = {
            address: binder.address,
            token: binder.issueGrant(claim),
            bindings: kvBindings.map(({ name }) => ({ publicName: name })),
          };
        }
        const codeKvBoot = kvBindings.length > 0 ? kvBoot : undefined;
        if (kvBindings.length > 0 && !codeKvBoot) {
          throw new Error("native KV binding is unavailable");
        }
        const queueProducerBindings = versionSpec.queueProducerBindings.map((binding) => ({
          name: binding.name,
          resourceUid: binding.resource.resourceUid,
        }));
        let queueProducerBoot:
          | {
              readonly address: string;
              readonly token: string;
              readonly bindings: readonly { readonly publicName: string }[];
            }
          | undefined;
        if (queueProducerBindings.length > 0) {
          const binder = options.v2QueueProducerBinding;
          if (!binder || !OPERATION_ID.test(version.sourceOperationId)) {
            throw new Error("native Queue producer binding is unavailable");
          }
          const claim: V2QueueProducerBindingGrant = {
            principal: snapshot.worker.principal,
            space: snapshot.worker.space,
            targetKey: options.targetKey,
            workerUid: snapshot.worker.uid,
            workerVersionUid: version.uid,
            workerVersionOperationId: version.sourceOperationId,
            nativeVersionId: identity.versionId,
            incarnationId: execution.operationId,
            servingSourceOperationId: execution.operationId,
            bindings: queueProducerBindings,
          };
          for (const binding of queueProducerBindings) {
            const current = await binder.resolveCurrentBinding(claim, binding.name);
            if (
              !current ||
              current.identity.targetKey !== claim.targetKey ||
              current.identity.principal !== claim.principal ||
              current.identity.space !== claim.space ||
              current.identity.resourceUid !== binding.resourceUid ||
              current.target.queueId !== `takoform-v2-queue:${binding.resourceUid}` ||
              typeof current.vector !== "string" ||
              current.vector.length === 0
            ) {
              throw new Error("current Queue producer binding is unavailable");
            }
          }
          if (!(await resolution.stillCurrent())) {
            throw new Error("Queue producer reference graph changed");
          }
          queueProducerBoot = {
            address: binder.address,
            token: binder.issueGrant(claim),
            bindings: queueProducerBindings.map(({ name }) => ({ publicName: name })),
          };
        }
        const queueSettlement =
          versionSpec.handlers.includes("queue") && options.v2QueueSettlement !== undefined
            ? {
                address: options.v2QueueSettlement.address,
                token: options.v2QueueSettlement.bindingToken({
                  workerUid: snapshot.worker.uid,
                  versionId: identity.versionId,
                  servingSourceOperationId: execution.operationId,
                }),
              }
            : undefined;
        const configuredPrivateInputs =
          versionSpec.requiredSensitiveVars.length > 0
            ? await options.configuredInputs?.read({
                resourceUid: version.uid,
                principal: snapshot.worker.principal,
                space: snapshot.worker.space,
                targetKey: options.targetKey,
                spec: versionSpec,
                stillCurrent: resolution.stillCurrent,
              })
            : undefined;
        if (versionSpec.requiredSensitiveVars.length > 0 && !configuredPrivateInputs) {
          throw new Error("configured Worker Version input is unavailable");
        }
        const serviceBindings = await projectV2ResolvedServiceBindings(versionSpec.serviceBindings);
        if (serviceBindings.length > 0) {
          const forward = options.v2ServiceBindingForward;
          if (!forward) throw new Error("native ServiceBinding forwarding is unavailable");
          const claim: V2WorkerServiceBindingClaim = Object.freeze({
            principal: snapshot.worker.principal,
            space: snapshot.worker.space,
            targetKey: options.targetKey,
            workerUid: snapshot.worker.uid,
            workerVersionUid: version.uid,
            workerVersionOperationId: version.sourceOperationId,
            nativeVersionId: identity.versionId,
            incarnationId: execution.operationId,
            servingSourceOperationId: execution.operationId,
            bindings: Object.freeze(
              versionSpec.serviceBindings.map((binding) =>
                Object.freeze({
                  name: binding.name,
                  resourceUid: binding.resource.resourceUid,
                }),
              ),
            ),
          });
          for (const [index, binding] of serviceBindings.entries()) {
            await forward.issueBinding(claim, {
              ...binding,
              name: workerdVersionServiceBindingName(index, true),
            });
          }
          if (!(await resolution.stillCurrent()))
            throw new Error("ServiceBinding reference graph changed");
        }
        const codeProjection = await projectV2WorkerCodeVersion({
          identity: {
            ...identity,
            bundleResourceUid: versionSpec.bundle.resourceUid,
            ...(versionSpec.assets
              ? { assetResourceUid: versionSpec.assets.bundle.resourceUid }
              : {}),
          },
          spec: versionSpec,
          bundle: materials.bundle,
          assets: materials.assets,
          inspectModule,
          ...(configuredPrivateInputs ? { configuredPrivateInputs } : {}),
          ...(serviceBindings.length > 0 ? { resolvedServiceBindings: serviceBindings } : {}),
          ...(actorForward.length > 0
            ? {
                resolvedActorBindings: actorForward.map((binding) => ({
                  name: binding.publicName,
                  resourceUid: binding.namespaceResourceUid,
                  className: binding.className,
                })),
                actorForward,
              }
            : {}),
          ...(workflowGrants.length > 0
            ? {
                resolvedWorkflowBindings: workflowClaims,
                workflowForward: workflowGrants,
              }
            : {}),
          ...(sqliteBindings.length > 0 ? { resolvedSqliteBindings: sqliteBindings } : {}),
          ...(codeObjectBucketBoot
            ? {
                resolvedObjectBucketBindings: bucketBindings,
                objectBucketBoot: codeObjectBucketBoot,
              }
            : {}),
          ...(codeKvBoot ? { resolvedKvBindings: kvBindings, kvBoot: codeKvBoot } : {}),
          ...(queueProducerBoot
            ? {
                resolvedQueueProducerBindings: queueProducerBindings,
                queueProducerBoot,
              }
            : {}),
          ...(sqliteBoot === undefined ? {} : { sqliteBoot }),
          ...(options.scheduledEventToken === undefined
            ? {}
            : { eventDelivery: { token: options.scheduledEventToken } }),
          ...(queueSettlement === undefined ? {} : { queueSettlement }),
        });
        const graph = compileWorkerdVersionGraph({
          directory: name,
          mainModule: codeProjection.site.mainModule,
          modules: codeProjection.modules,
          moduleMediaTypes: codeProjection.site.moduleMediaTypes ?? {},
          ...(codeProjection.site.assets && codeProjection.assets
            ? {
                assets: {
                  files: codeProjection.assets,
                  ...codeProjection.site.assets,
                },
              }
            : {}),
          environment: (codeProjection.site.vars ?? []).map((binding) => ({
            name: binding.name,
            value: binding.value,
            type: versionSpec.requiredSensitiveVars.includes(binding.name)
              ? ("secret_text" as const)
              : ("json" as const),
          })),
          serviceBindings: serviceBindings.map((binding) => ({
            publicName: binding.name,
            target: binding.target,
            targetResourceUid: binding.targetResourceUid,
            unavailableToken: binding.unavailableToken,
          })),
          ...(actorForward.length > 0 ? { actorForward } : {}),
          ...(workflowGrants.length > 0
            ? {
                workflowForward: await projectV2WorkflowForward({
                  workerUid: snapshot.worker.uid,
                  versionUid: version.uid,
                  sourceOperationId: version.sourceOperationId,
                  nativeVersionId: identity.versionId,
                  principal: snapshot.worker.principal,
                  declarations: versionSpec.workflowBindings,
                  grants: workflowGrants,
                }),
              }
            : {}),
          ...(sqliteBoot === undefined
            ? {}
            : {
                dataPlane: {
                  address: sqliteBoot.address,
                  token: sqliteBoot.token,
                  bindings: sqliteBindings.map((binding) => ({
                    kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
                    publicName: binding.name,
                  })),
                },
              }),
          ...(objectBucketBoot === undefined ? {} : { v2ObjectBucketBinding: objectBucketBoot }),
          ...(kvBoot === undefined ? {} : { v2KvBinding: kvBoot }),
          ...(queueProducerBoot === undefined ? {} : { v2QueueProducerBinding: queueProducerBoot }),
          hostnames: [],
          generation,
          workerResourceUid: snapshot.worker.uid,
          declaredHandlers: versionSpec.handlers,
          ...(versionSpec.handlers.includes("scheduled") || versionSpec.handlers.includes("queue")
            ? { eventToken: options.scheduledEventToken }
            : {}),
          ...(queueSettlement === undefined ? {} : { v2QueueSettlement: queueSettlement }),
          readiness: {
            publication: codeProjection.versionId,
            probeHostname: internalHostname(name),
          },
        });
        projection = {
          versionId: codeProjection.versionId,
          workerVersionUid: codeProjection.workerVersionUid,
          weight: codeProjection.weight,
          ...graph,
        };
        deferRetirementUntilDeadline = true;
      } else {
        projection = await projectV2StaticWorkerVersion({
          identity,
          spec: versionSpec,
          materials,
        });
      }
      versions.push(projection);
    }
    const publication: WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> = {
      generation,
      workerResourceUid: snapshot.worker.uid,
      hostnames: snapshot.endpoint ? [snapshot.endpoint.output.hostname] : [],
      versions,
    };
    return {
      name,
      identity: expectedIdentity(publication),
      publication,
      deferRetirementUntilDeadline,
    };
  }

  async function resolveInitial(execution: V2Execution) {
    return await options.publicationState.resolve({ execution });
  }

  async function resultFromReadback(
    candidateValue: Candidate,
    resolution: Extract<V2WorkerPublicationResolution, { kind: "ready" }>,
  ): Promise<V2WorkerPublicationResult> {
    const observe = options.runtime.observeExactPublication;
    if (!observe) return unknownResult();
    let proof: "matches" | "different" | "unknown";
    try {
      proof = await observe.call(options.runtime, candidateValue.name, candidateValue.identity);
    } catch {
      return unknownResult();
    }
    if (proof !== "matches") return unknownResult();
    if (!(await resolution.stillCurrent())) return unknownResult();
    if (candidateValue.identity === null) return { kind: "confirmed", identity: null };
    return {
      kind: "confirmed",
      identity: candidateValue.identity,
      deferRetirementUntilDeadline: candidateValue.deferRetirementUntilDeadline,
    };
  }

  return {
    async publish(execution) {
      if (
        (execution.form !== WORKER_DEPLOYMENT_FORM_URL &&
          execution.form !== WORKER_ENDPOINT_FORM_URL) ||
        execution.targetKey !== options.targetKey
      ) {
        return notDispatched("worker_publication_target_mismatch");
      }
      const publishFenced = options.runtime.publishFenced;
      const observe = options.runtime.observeExactPublication;
      if (!publishFenced || !observe) return unknownResult();

      const initial = await resolveInitial(execution);
      if (initial.kind !== "ready") return notDispatched(initial.code);
      let activeResolution = initial;
      let desired: Candidate;
      try {
        desired = await candidate(execution, initial);
      } catch {
        return notDispatched("worker_material_unavailable");
      }
      if (!(await initial.stillCurrent())) return notDispatched("stale_claim");

      // If this exact operation already serves, do not repeat a native write.
      try {
        if (
          (await observe.call(options.runtime, desired.name, desired.identity)) === "matches" &&
          (await initial.stillCurrent())
        ) {
          return await resultFromReadback(desired, initial);
        }
      } catch {
        return unknownResult();
      }

      let currentResult: Candidate | null = desired;
      try {
        await publishFenced.call(
          options.runtime,
          desired.name,
          async (current) => {
            let incumbentSourceOperationId: string | undefined;
            if (current !== null) {
              if (
                !isCurrentIdentityShape(current) ||
                current.workerResourceUid !== initial.snapshot.worker.uid
              ) {
                throw new Error("untrusted Worker incumbent");
              }
              incumbentSourceOperationId = parseOperationMarker(current.generation) ?? undefined;
              if (!incumbentSourceOperationId) throw new Error("untrusted Worker incumbent");
              if (incumbentSourceOperationId === execution.operationId) {
                // This marker can only be accepted when the complete exact identity
                // matches this operation. If the exact readback above did not prove
                // it, preserve uncertainty rather than repeating the native write.
                if (!exactIdentity(current, desired.identity)) {
                  throw new Error("current operation publication differs");
                }
                throw new Error("current operation publication is not proven serving");
              }
            }
            const resolved = await options.publicationState.resolve({
              execution,
              ...(incumbentSourceOperationId === undefined ? {} : { incumbentSourceOperationId }),
            });
            if (resolved.kind !== "ready") throw new Error(resolved.code);
            activeResolution = resolved;
            const fresh = await candidate(execution, resolved);
            if (canonicalJson(fresh.identity) !== canonicalJson(desired.identity)) {
              throw new Error("Worker desired graph changed");
            }
            currentResult = fresh;
            return fresh.publication;
          },
          async () => await activeResolution.stillCurrent(),
        );
      } catch {
        // The write may have reached serving state before an acknowledgement failed.
        // Only the exact readback below can settle it; never retry blindly here.
      }
      return await resultFromReadback(currentResult ?? desired, activeResolution);
    },
    async observe(execution) {
      if (
        (execution.form !== WORKER_DEPLOYMENT_FORM_URL &&
          execution.form !== WORKER_ENDPOINT_FORM_URL) ||
        execution.targetKey !== options.targetKey
      ) {
        return unknownResult();
      }
      const resolution = await resolveInitial(execution);
      if (resolution.kind !== "ready") return unknownResult();
      try {
        const expected = await candidate(execution, resolution);
        // Reconciliation is read-only. A mismatch or missing proof remains unknown.
        return await resultFromReadback(expected, resolution);
      } catch {
        return unknownResult();
      }
    },
  };
}
