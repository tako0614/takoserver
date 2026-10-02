import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { SqlParam, SqlStatement } from "./ports.ts";

export const MAX_PROVIDER_RUNTIME_INPUT_BINDINGS = 64;

/**
 * Trusted, internal SQL boolean expression for a composition-owned durable
 * operation fence. This is never parsed from a request or persisted with a
 * preparation. It must be a bound, value-free EXISTS predicate over the same
 * database as the runtime-input authority.
 */
export interface ProviderRuntimeInputSqlPredicate {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

export interface ProviderRuntimeInputLeaseFence {
  /** Authorizes the exact pending operation before plaintext is released. */
  readonly claim: ProviderRuntimeInputSqlPredicate;
  /** Optional default; an exact predicate may be supplied at dispatch time. */
  readonly dispatch?: ProviderRuntimeInputSqlPredicate;
}

/** Static truth a provider exposes only when its configured adapter can consume leases. */
export interface ProviderRuntimeInputCapabilities {
  readonly maximumBindings: number;
  /** Omitted for legacy provider-wide adapters; present means exact Form identities only. */
  readonly forms?: readonly TakoformV1Alpha3FormRef[];
}

/** Exact logical address of one Worker runtime-input declaration. */
export interface ProviderRuntimeInputTarget {
  readonly space: string;
  readonly workerName: string;
  /** Exact ModuleWorker incarnation re-read at the provider mutation barrier. */
  readonly workerResourceUid: string;
  readonly bundleName: string;
}

/**
 * The value-free identity of the ordinary public apply this Host is executing.
 *
 * A preparation commits to exactly one apply — method, path, `If-None-Match`,
 * and body — but a commitment nothing recomputes is a record, not a fence. This
 * is what lets the authority derive the executing request's commitment at the
 * moment of the claim and compare it with the stored one, instead of trusting
 * that whoever spends the handoff is the mutation it was made for.
 *
 * It carries no sealed value: the body is the ordinary portable Resource the
 * caller would have sent with no runtime inputs at all.
 */
export interface ProviderRuntimeInputPublicApply {
  readonly method: string;
  readonly path: string;
  readonly ifNoneMatch: string;
  readonly body: string;
}

export interface ProviderRuntimeInputAcquireInput {
  readonly organizationId: string;
  readonly operationId: string;
  readonly resourceUid: string;
  /** Exact operation key this Host mutation was addressed by, and the handoff with it. */
  readonly reference: string;
  readonly target: ProviderRuntimeInputTarget;
  readonly bindingNames: readonly string[];
  /** The exact apply being executed, recomputed and fenced against the stored commitment. */
  readonly publicApply: ProviderRuntimeInputPublicApply;
  /** Optional internal composition fence; never supplied by a public caller. */
  readonly leaseFence?: ProviderRuntimeInputLeaseFence;
  /** Exact prepared generation pinned before an external preclaim is recorded. */
  readonly expectedGeneration?: string;
}

export interface ProviderRuntimeInputPinnedGeneration {
  /** Opaque, value-free generation token. It is not a bearer credential. */
  readonly generation: string;
}

export interface ProviderRuntimeInputNoEffectInput extends ProviderRuntimeInputRecoveryInput {
  readonly generation: string;
}

/**
 * Recovery and abandonment are readback-only and reach a handoff whose values
 * are already gone, so they carry no apply identity: the row's own claim owner,
 * Resource UID, and logical target are the fences there.
 */
export type ProviderRuntimeInputRecoveryInput = Omit<
  ProviderRuntimeInputAcquireInput,
  "publicApply" | "leaseFence"
>;

/** Value-free identity bound to the exact encrypted preparation. */
export interface ProviderRuntimeInputPreparationIdentity {
  readonly preparationId: string;
  /** Opaque original preparation generation retained through dispatch/settle. */
  readonly generation: string;
  /** The exact operation key both the private handoff and the public apply carry. */
  readonly operationKey: string;
  readonly workerResourceUid: string;
  /** The Host origin the caller addressed; not the future Worker's origin. */
  readonly canonicalPublicOrigin: string;
  /**
   * Commitment to the exact public apply this handoff authorizes. No plaintext
   * binding name or value is embedded in it.
   */
  readonly commitment: `sha256:${string}`;
}

/**
 * A claimed in-memory lease. Values never enter provider results, Outputs,
 * portable Resource state, observations or logs. `dispatch` erases this
 * handoff's durable ciphertext before the adapter sends values to its backend.
 * Backend-native runtime material has a separate provider-owned persistence,
 * access and deletion lifecycle; this one-shot lease is not its storage or
 * recovery interface.
 */
export interface ProviderRuntimeInputLease {
  readonly bindings: Readonly<Record<string, string>>;
  readonly preparation: ProviderRuntimeInputPreparationIdentity;
  /** Definitively closes an acquired lease before provider dispatch and erases its ciphertext. */
  abort(): Promise<void>;
  /** Supply the derived exact pending receipt fence immediately before delivery. */
  dispatch(
    dispatchFence?: ProviderRuntimeInputSqlPredicate,
  ): Promise<ProviderRuntimeInputDispatchedLease>;
}

/** The only operation available after this handoff's durable ciphertext is erased. */
export interface ProviderRuntimeInputDispatchedLease {
  settle(receiptDigest: `sha256:${string}`): Promise<void>;
}

/**
 * Readback-only recovery view. This handoff's durable ciphertext is erased;
 * values never return through recovery.
 */
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
  /** Pin the exact still-prepared handoff before composing a durable preclaim. */
  pinPrepared?(
    input: ProviderRuntimeInputAcquireInput,
  ): Promise<ProviderRuntimeInputPinnedGeneration>;
  /**
   * Build an exact-generation pre-dispatch revocation for the caller's atomic
   * batch with its own operation tombstone. A closed-marker replay must never
   * execute this statement against a newer preparation.
   */
  noEffectRevocation?(input: ProviderRuntimeInputNoEffectInput): Promise<SqlStatement>;
  acquire(input: ProviderRuntimeInputAcquireInput): Promise<ProviderRuntimeInputLease>;
  recover(input: ProviderRuntimeInputRecoveryInput): Promise<ProviderRuntimeInputRecoveryLease>;
  /**
   * Definitively revokes an exact claimed or dispatched handoff after the
   * provider proves that no native object received it. Implementations must
   * erase any still-sealed bytes and be idempotent for the same handoff.
   */
  abandon?(input: ProviderRuntimeInputRecoveryInput): Promise<void>;
}
