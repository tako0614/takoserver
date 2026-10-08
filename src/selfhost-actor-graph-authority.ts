import type { ActorResourceGraph, ActorResourceGraphReader } from "./actor-resource-graph.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import {
  readWorkerdActiveActorGraph,
  readWorkerdSelectedActiveVersion,
  type WorkerdActiveActorGraph,
  type WorkerdActorForwardSocket,
  type WorkerdActorIncarnationRetirement,
  type WorkerdSelectedActiveVersion,
} from "./workerd-runtime.ts";

export interface ActorExecutionScope {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
}

/** An accepted namespace/Worker identity, without a provider-specific Resource shape. */
export interface ActorExecutionGraph {
  readonly scope: ActorExecutionScope;
  readonly workerUid: string;
  readonly className: string;
  readonly runtimeClassRef?: unknown;
  /** Opaque, exact accepted graph identity; not a readiness boolean. */
  readonly authorityKey: string;
}

/** A selected native publication, including all weighted Version bytes. */
export interface ActorExecutionRealization {
  readonly script: string;
  readonly graph: WorkerdActiveActorGraph;
  readonly authorityKey: string;
  /** Current provider Worker incarnation's private broker sockets. V1 has none. */
  readonly actorForwardSockets?: readonly WorkerdActorForwardSocket[];
  /** V2 physical receipt identity, never an independent SQL grant. */
  readonly sourceOperationId?: string;
  readonly incarnationId?: string;
}

export interface ActorVersionPrivateBindingLease {
  readonly versionId: string;
  readonly workerVersionUid: string;
  readonly services: readonly {
    readonly name: string;
    readonly upstreamSocket: string;
    readonly unavailableToken: string;
  }[];
  readonly workflowServices: readonly {
    readonly name: string;
    readonly publicName: string;
    readonly workflowResourceUid: string;
    readonly token: string;
    readonly snapshotDigest: `sha256:${string}`;
    readonly upstreamSocket: string;
  }[];
  release(): Promise<void>;
}

/** Native incarnation being retired by a later accepted Worker publication. */
export type ActorIncarnationRetirement = WorkerdActorIncarnationRetirement;

export type ActorRealizationRead =
  | { readonly kind: "ready"; readonly realization: ActorExecutionRealization }
  | { readonly kind: "native_unavailable" }
  | { readonly kind: "authority_changed" };

/**
 * Privileged source of accepted graph and native publication authority. Each
 * event and upgrade handoff rechecks this port; the physical owner never
 * interprets a particular Form ledger or provider deployment record.
 */
export interface ActorGraphAuthority {
  /** Any remaining canonical namespace authority blocks physical deletion. */
  hasNamespaceAuthority(scope: ActorExecutionScope, signal: AbortSignal): Promise<boolean>;
  readGraph(scope: ActorExecutionScope, signal: AbortSignal): Promise<ActorExecutionGraph | null>;
  hasRealization(graph: ActorExecutionGraph): Promise<boolean>;
  readRealization(graph: ActorExecutionGraph, signal: AbortSignal): Promise<ActorRealizationRead>;
  stillCurrent(
    graph: ActorExecutionGraph,
    realization: ActorExecutionRealization,
    signal: AbortSignal,
  ): Promise<boolean>;
  selectVersion(
    graph: ActorExecutionGraph,
    realization: ActorExecutionRealization,
    basisPoint: number,
  ): Promise<WorkerdSelectedActiveVersion | null>;
  /** Optional v2 physical bridge; caller must fence its own accepted graph before and after. */
  acquireVersionPrivateBindings?(
    graph: ActorExecutionGraph,
    realization: ActorExecutionRealization,
    version: WorkerdActiveActorGraph["versions"][number],
    stillAuthorized: (signal: AbortSignal) => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<ActorVersionPrivateBindingLease | null>;
  /** Compatibility read for the separately owned, retired v1 public path. */
  readLegacyGraph?(
    scope: ActorExecutionScope,
    signal: AbortSignal,
  ): Promise<ActorResourceGraph | null>;
}

/** Explicit v1 adapter; never use this to translate a v2 accepted graph. */
export function createLegacyActorGraphAuthority(options: {
  readonly runtimeRoot: string;
  readonly graph: ActorResourceGraphReader;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
}): ActorGraphAuthority {
  const validDeployment = async (graph: ActorExecutionGraph) => {
    const deployment = await options.deployments.active(graph.scope.tenantId, graph.workerUid);
    const script = deployment?.outputs.scriptName;
    if (
      deployment?.state !== "active" ||
      deployment.tenantId !== graph.scope.tenantId ||
      deployment.resourceUid !== graph.workerUid ||
      deployment.providerPackRef !== options.providerPackRef ||
      deployment.providerInstallationRef !== options.providerInstallationRef ||
      typeof script !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(script) ||
      !deployment.nativeId.startsWith(`selfhost-worker:${script}:`) ||
      deployment.nativeId === `selfhost-worker:${script}:`
    )
      return null;
    return { deployment, script };
  };
  const exactGraph = async (graph: ActorExecutionGraph, signal: AbortSignal): Promise<boolean> => {
    const latest = await options.graph(graph.scope, signal);
    return latest !== null && JSON.stringify(latest) === graph.authorityKey;
  };
  return {
    async hasNamespaceAuthority(scope, signal) {
      return (await options.graph(scope, signal)) !== null;
    },
    async readGraph(scope, signal) {
      const current = await options.graph(scope, signal);
      if (
        !current ||
        current.tenantId !== scope.tenantId ||
        current.namespace?.uid !== scope.namespaceResourceUid ||
        typeof current.namespace.className !== "string" ||
        typeof current.worker?.uid !== "string"
      )
        return null;
      return {
        scope: { ...scope },
        workerUid: current.worker.uid,
        className: current.namespace.className,
        ...(current.runtimeClassRef === undefined
          ? {}
          : { runtimeClassRef: structuredClone(current.runtimeClassRef) }),
        authorityKey: JSON.stringify(current),
      };
    },
    async hasRealization(graph) {
      return (await validDeployment(graph)) !== null;
    },
    async readRealization(graph, signal) {
      signal.throwIfAborted();
      const selected = await validDeployment(graph);
      if (!selected) return { kind: "authority_changed" };
      const native = await readWorkerdActiveActorGraph(
        options.runtimeRoot,
        selected.script,
        graph.workerUid,
      );
      signal.throwIfAborted();
      if (!native) return { kind: "native_unavailable" };
      const again = await options.deployments.active(graph.scope.tenantId, graph.workerUid);
      if (
        !(await exactGraph(graph, signal)) ||
        JSON.stringify(again) !== JSON.stringify(selected.deployment)
      )
        return { kind: "authority_changed" };
      return {
        kind: "ready",
        realization: {
          script: selected.script,
          graph: structuredClone(native),
          authorityKey: JSON.stringify(selected.deployment),
        },
      };
    },
    async stillCurrent(graph, realization, signal) {
      const current = await options.deployments.active(graph.scope.tenantId, graph.workerUid);
      return (
        (await exactGraph(graph, signal)) && JSON.stringify(current) === realization.authorityKey
      );
    },
    selectVersion(graph, realization, basisPoint) {
      return readWorkerdSelectedActiveVersion(options.runtimeRoot, realization.script, {
        expectedWorkerResourceUid: graph.workerUid,
        basisPoint,
      });
    },
    async readLegacyGraph(scope, signal) {
      return options.graph(scope, signal);
    },
  };
}
