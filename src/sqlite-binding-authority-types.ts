import type {
  V2WorkerInvocationHandle,
  V2WorkerInvocationRetirementIdentity,
} from "./worker-invocation-port.ts";

/** Host-issued, immutable selected-Version identity. DB generation is deliberately absent. */
export interface V2SqliteBindingGrant {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
  /** Host-private WfP selection; absent from the existing self-host grant. */
  readonly invocation?: {
    readonly handle: V2WorkerInvocationHandle;
    readonly expected: V2WorkerInvocationRetirementIdentity;
  };
}

export interface V2SqliteSelectedVersionRequest {
  readonly workerUid: string;
  readonly versionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
}

export interface V2SqliteSelectedVersionObservation extends V2SqliteSelectedVersionRequest {
  readonly kind: "confirmed";
  readonly status: "active" | "draining";
}

export type V2SqliteSelectedVersionObserver = (
  input: V2SqliteSelectedVersionRequest,
) => Promise<V2SqliteSelectedVersionObservation | { readonly kind: "unknown" }>;
