import { bytesDigest, canonicalJson } from "../json.ts";
import type { V2SqliteBindingGrant } from "../providers/selfhost-v2-sqlite-binding-broker.ts";
import { SELFHOST_WORKER_EDGE_SQL_BINDING_KIND } from "../providers/selfhost-worker-wrapper.ts";
import { canonicalSelfhostWeightedVersions } from "../selfhost-weighted-deployment.ts";
import type {
  WorkerdDeploymentPublication,
  WorkerdDeploymentVariant,
  WorkerdPublicationIdentity,
  WorkerdRuntime,
  WorkerdSite,
  WorkerdStaticSite,
} from "../workerd-runtime.ts";
import { internalHostname } from "../workerd-runtime.ts";
import { compileWorkerdVersionGraph } from "../workerd-version-graph.ts";
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
import {
  projectV2ResolvedServiceBindings,
  v2ServiceTargetName,
} from "./worker-service-resolution.ts";
import { projectV2StaticWorkerVersion } from "./worker-static-runtime.ts";

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
          ...(sqliteBindings.length > 0 ? { resolvedSqliteBindings: sqliteBindings } : {}),
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
    if (proof !== "matches" || !(await resolution.stillCurrent())) return unknownResult();
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
