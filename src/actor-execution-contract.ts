/** Pure accepted/native identity shapes; neither SQL nor physical admission. */
import type {
  WorkerdActiveActorGraph,
  WorkerdActorForwardSocket,
  WorkerdActorIncarnationRetirement,
} from "./workerd-site-contract.ts";

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

/** Native incarnation being retired by a later accepted Worker publication. */
export type ActorIncarnationRetirement = WorkerdActorIncarnationRetirement;
