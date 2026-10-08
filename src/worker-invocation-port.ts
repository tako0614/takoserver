/** Host-only handle. The gateway never sends this to a customer Worker. */
export interface V2WorkerInvocationHandle {
  readonly invocationId: string;
  readonly custodyToken: string;
}

/** Fixed when the owning backend atomically admits against its live publication. */
export type V2WorkerInvocationIngress =
  | { readonly kind: "endpoint"; readonly endpointUid: string; readonly endpointGeneration: number }
  | {
      readonly kind: "cron";
      readonly matchId: string;
      readonly triggerOperationId: string;
      readonly leaseToken: string;
      readonly attempt: number;
    }
  | {
      readonly kind: "service";
      readonly callerWorkerUid: string;
      readonly callerVersionUid: string;
      readonly callerVersionGeneration: number;
      readonly callerVersionOperationId: string;
      readonly bindingName: string;
      /** Nonsecret correlation only. Physical caller liveness is provider-owned. */
      readonly callerExecutionRef: string;
    };

export interface V2WorkerInvocationSelection {
  readonly workerUid: string;
  readonly deploymentUid: string;
  readonly deploymentGeneration: number;
  readonly sourceOperationId: string;
  readonly ingress: V2WorkerInvocationIngress;
  readonly versionUid: string;
  readonly versionGeneration: number;
  readonly versionOperationId: string;
  readonly nativeIdentity: string;
  readonly closureDigest: `sha256:${string}`;
  readonly confirmedReceipt: string;
}

export interface V2WorkerInvocationRecord extends V2WorkerInvocationSelection {
  readonly handle: V2WorkerInvocationHandle;
  readonly backendId: string;
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly phase: "admitted" | "send_authorized" | "pre_effect_refused";
  readonly bodyState: "finished" | "canceled" | null;
  /** Trusted owner proved the native fetch was never invoked after beginSend. */
  readonly noNativeDispatchAtMs: number | null;
  /** `unavailable` is an old schema, never evidence of no external use. */
  readonly sqliteDrainState: "unavailable" | "pending" | "drained" | null;
  readonly sqliteDrainReceiptDigest: `sha256:${string}` | null;
  /** Provider-origin terminal execution receipt, never inferred from body EOF. */
  readonly retirement: {
    readonly retiredAtMs: number;
    readonly receiptDigest: `sha256:${string}`;
  } | null;
}

export type V2WorkerInvocationRetirementIdentity = V2WorkerInvocationSelection &
  Pick<V2WorkerInvocationRecord, "backendId" | "targetKey" | "principal" | "space">;

export interface V2WorkerInvocationRetirementInput {
  readonly handle: V2WorkerInvocationHandle;
  /** Snapshot from the trusted native Tail receiver, not customer log fields. */
  readonly expected: V2WorkerInvocationRetirementIdentity;
  /** Stable fingerprint of the verified provider-origin terminal trace. */
  readonly receiptDigest: `sha256:${string}`;
}

export interface V2WorkerSQLiteExternalUseInput {
  readonly handle: V2WorkerInvocationHandle;
  readonly expected: V2WorkerInvocationRetirementIdentity;
}

export interface V2WorkerSQLiteDrainInput extends V2WorkerSQLiteExternalUseInput {
  /** Stable trusted Node close/recovery proof, not a provider Tail digest. */
  readonly receiptDigest: `sha256:${string}`;
}
