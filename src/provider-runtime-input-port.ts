export const MAX_PROVIDER_RUNTIME_INPUT_BINDINGS = 64;

/** Static truth a provider exposes only when its configured adapter can consume leases. */
export interface ProviderRuntimeInputCapabilities {
  readonly maximumBindings: number;
}

/** Exact logical address of one Worker runtime-input declaration. */
export interface ProviderRuntimeInputTarget {
  readonly space: string;
  readonly workerName: string;
  /** Exact ModuleWorker incarnation re-read at the provider mutation barrier. */
  readonly workerResourceUid: string;
  readonly bundleName: string;
}

export interface ProviderRuntimeInputAcquireInput {
  readonly organizationId: string;
  readonly operationId: string;
  readonly resourceUid: string;
  /** Exact Takoserver-issued handoff reference used as this Host operation's idempotency key. */
  readonly reference: string;
  readonly target: ProviderRuntimeInputTarget;
  readonly bindingNames: readonly string[];
}

export type ProviderRuntimeInputRecoveryInput = ProviderRuntimeInputAcquireInput;

/** Value-free identity bound to the exact encrypted preparation. */
export interface ProviderRuntimeInputPreparationIdentity {
  readonly preparationId: string;
  readonly materialSetId: string;
  readonly originResourceUid: string;
  readonly workerResourceUid: string;
  readonly canonicalPublicOrigin: string;
  /** Digest of every immutable non-secret preparation field, including binding names. */
  readonly commitment: `sha256:${string}`;
}

/**
 * A claimed in-memory lease. Values never cross a provider result, Output, or
 * durable provider state. `dispatch` erases the durable ciphertext before the
 * adapter sends these values to its backend.
 */
export interface ProviderRuntimeInputLease {
  readonly bindings: Readonly<Record<string, string>>;
  readonly preparation: ProviderRuntimeInputPreparationIdentity;
  /** Definitively closes an acquired lease before provider dispatch and erases its ciphertext. */
  abort(): Promise<void>;
  dispatch(): Promise<ProviderRuntimeInputDispatchedLease>;
}

/** The only operation available after durable secret bytes have been erased. */
export interface ProviderRuntimeInputDispatchedLease {
  settle(receiptDigest: `sha256:${string}`): Promise<void>;
}

/** Readback-only recovery view. Secret values are already erased and never return here. */
export interface ProviderRuntimeInputRecoveryLease {
  readonly preparation: ProviderRuntimeInputPreparationIdentity;
  readonly bindingNames: readonly string[];
  settle(receiptDigest: `sha256:${string}`): Promise<void>;
}

/**
 * The provider-neutral seam for one-shot sensitive runtime inputs.
 *
 * Adapters acquire by logical target before their first mutation, dispatch
 * immediately before the request carrying secret values, and settle only from
 * an authoritative provider receipt. Recovery is readback-only and therefore
 * receives no values and cannot redispatch.
 */
export interface ProviderRuntimeInputLeasePort {
  acquire(input: ProviderRuntimeInputAcquireInput): Promise<ProviderRuntimeInputLease>;
  recover(input: ProviderRuntimeInputRecoveryInput): Promise<ProviderRuntimeInputRecoveryLease>;
}
