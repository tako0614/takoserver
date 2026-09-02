import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import type { JsonObject } from "./ports.ts";
import type {
  ProviderRuntimeInputCapabilities,
  ProviderRuntimeInputPublicApply,
} from "./provider-runtime-input-port.ts";

/**
 * The one seam between Takoserver and the clouds it provisions on.
 *
 * Two things about its shape are deliberate.
 *
 * **Completion is a value, not a promise resolution.** `apply` may answer
 * `running` with a handle, and the reconciler drives `poll` until it settles.
 * A backend that finishes inside one call simply never returns `running` and
 * needs no `poll`, so the asynchronous machinery costs a synchronous provider
 * nothing. Without this, anything that takes minutes to create — a database, a
 * cluster, a machine — cannot be represented at all.
 *
 * **Failure is a value too.** A provider reports a classified, sanitized
 * failure rather than throwing whatever its SDK threw. Native error text stops
 * at this boundary; what crosses is a code the product knows how to act on and
 * whether retrying could plausibly help.
 */

export interface ProviderFailure {
  readonly code:
    | "invalid_spec"
    | "conflict"
    /**
     * The target still holds contents this Host will not destroy for the
     * caller — objects in a bucket, rows a customer wrote.
     *
     * Distinct from `conflict`, which is "something else holds this identity"
     * and renders as the automatically retryable `resource_busy`: waiting does
     * not empty a bucket, so telling the operator to "wait and re-run the same
     * apply" was advice that could never work. This is a definitive refusal
     * about facts the caller then changes, and it renders as
     * `dependency_in_use`, which the released provider does not auto-retry.
     */
    | "occupied"
    | "not_found"
    | "denied"
    | "unavailable"
    | "quota"
    | "provider_error"
    | "timeout";
  /** Safe for a customer to read. Never a provider's raw message. */
  readonly message: string;
  readonly retryable: boolean;
}

export interface ProviderResult {
  readonly nativeId: string;
  readonly observed: JsonObject;
  readonly outputs: JsonObject;
  /**
   * Physical disposition after a logical delete. Providers that cannot remove
   * an immutable revision must say so; the Deployment is then retained rather
   * than falsely recorded as deleted.
   */
  readonly disposition?: "deleted" | "retained";
}

export type ProviderTicket =
  | { readonly phase: "succeeded"; readonly result: ProviderResult }
  | {
      readonly phase: "failed";
      readonly failure: ProviderFailure;
      /** Retained opaque handle when polling itself reports a retryable fault. */
      readonly handle?: string;
    }
  | {
      readonly phase: "running";
      readonly handle: string;
      /** Hint for when polling could next be worthwhile. */
      readonly pollAfterMs: number;
    };

export type ProviderCapability = "create" | "update" | "delete" | "import" | "observe";

export interface ProviderOffering {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly form: TakoformV1Alpha3FormRef;
  readonly providedInterfaces: readonly TakoformInterfaceRef[];
  readonly bindingRefs: readonly TakoformBindingRef[];
  readonly regions?: readonly string[];
  readonly capabilities: readonly ProviderCapability[];
}

/** Who the resource belongs to and what it is called, in product terms. */
export interface ResourceIdentity {
  readonly tenantRef: string;
  readonly space: string;
  readonly name: string;
  /** Stable Host Resource UID. Required by adapters that consume one-shot inputs. */
  readonly uid?: string;
}

/**
 * Provider-specific derivation of a future public endpoint from one explicit,
 * provider-neutral reservation request. This is deliberately non-mutating:
 * Takoserver's reservation ledger owns exclusivity, while the adapter owns only
 * its exact naming/suffix rules. ResourceIdentity is intentionally absent;
 * resources do not exist yet and a caller must never invent their names.
 */
export interface ProviderWorkerEndpointOriginReservationCapability {
  /**
   * The scheme every address this installation derives is published under.
   *
   * The reservation ledger has to know it, because it is the authority that
   * accepts or refuses a derived origin and "an origin" is not a shape with one
   * scheme in it. A managed backend and a TLS-terminating self-host serve
   * `https` and say so by leaving this absent; a self-host whose operator
   * configured no certificate serves plain HTTP and says `http`
   * ([ADR 0009](../docs/adr/0009-a-self-host-publishes-the-scheme-its-socket-serves.md)).
   * Nothing else may relax the rule: an installation that does not declare
   * `http` cannot hand this Host an `http` address.
   */
  readonly publishedScheme?: "https" | "http";
  derive(input: {
    readonly tenantRef: string;
    readonly requestedSubdomain: string;
  }): Promise<{ readonly canonicalPublicOrigin: string } | null>;
  /**
   * The subdomain this installation gives a WorkerEndpoint on this exact
   * Worker, when its own offering derives the hostname instead of taking one
   * from the caller.
   *
   * A reseller lane chooses the label: it sells a name, holds it before the
   * Resource graph exists, and the reservation is the authority for it. An
   * ordinary organization API key has no such input — the released provider's
   * `takoform_worker_endpoint` accepts only `name` and `worker` — and on a Host
   * whose endpoint address is derived anyway (the self-host suffix, the
   * ordinary-workers `workers.dev`/zone suffix) there is no name to choose:
   * the address follows from the Worker. So the Host mints the reservation
   * itself, from this, and the WorkerEndpoint apply consumes it exactly as if
   * a reseller had supplied one.
   *
   * Absent, or `null`, means this installation has no such rule and every
   * reservation must be requested explicitly. The managed
   * (Workers-for-Platforms) backend answers that way: its base domain is sold
   * rather than derived.
   */
  hostMintedSubdomain?(input: {
    readonly tenantRef: string;
    readonly space: string;
    readonly workerName: string;
  }): Promise<string | null>;
}

/**
 * Host-resolved private authority for one exact WorkerEndpoint mutation.
 * The opaque reservation reference deliberately stops at the Host.
 */
export interface ProviderWorkerEndpointOriginAssignment {
  readonly canonicalPublicOrigin: string;
  readonly assignmentDigest: `sha256:${string}`;
}

/** Durable identity and recovery evidence for every provider mutation. */
export interface ProviderMutationInput {
  /** Stable across retries of the same logical operation. */
  readonly operationId: string;
  /** Host idempotency identity. Sensitive-input adapters require the Takoserver-issued form. */
  readonly operationKey?: string;
  /**
   * `initial` is granted only by the durable Host execution lease and may
   * cross the provider mutation boundary once. An absent value is treated as
   * recovery so callers that do not own that lease fail closed.
   */
  readonly operationMode?: "initial" | "recovery";
  /** Opaque provider-owned handle retained by the Host for recovery polling. */
  readonly providerHandle?: string;
}

export interface ApplyInput extends ProviderMutationInput {
  readonly offering: ProviderOffering;
  readonly identity: ResourceIdentity;
  readonly spec: JsonObject;
  readonly region?: string;
  /** Present for an update; absent for a create. */
  readonly previous?: { readonly nativeId: string; readonly spec: JsonObject };
  /** Exact Host-pinned dependencies with any active provider realization. */
  readonly relations?: readonly ProviderRelation[];
  /** Provider-pack materialized bindings. Never portable state or provider output. */
  readonly runtimeBindings?: readonly ProviderRuntimeBinding[];
  /** Exact private origin authority for a reservation-backed WorkerEndpoint. */
  readonly workerEndpointOriginAssignment?: ProviderWorkerEndpointOriginAssignment;
  /**
   * Value-free identity of the ordinary Host apply being executed.
   *
   * Present only where the Host can state it exactly, which is the immutable
   * create a sensitive runtime-input handoff authorizes. An adapter that needs
   * a lease and does not have this fails closed rather than claiming without
   * it: the stored commitment is only a fence if something recomputes it.
   */
  readonly publicApply?: ProviderRuntimeInputPublicApply;
}

export interface ProviderRuntimeBinding {
  readonly name: string;
  readonly targetUid: string;
  readonly bindingRef: TakoformBindingRef;
  /** Opaque to the Host and meaningful only to the selected provider adapter. */
  readonly material: unknown;
}

/** Exact logical target projected to a Provider Pack at the mutation barrier. */
export interface ProviderRelation {
  readonly pointer: string;
  readonly relation: string;
  readonly targetUid: string;
  readonly resource: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly form: { readonly formRef: TakoformV1Alpha3FormRef };
    readonly metadata: {
      readonly name: string;
      readonly space: string;
      readonly uid: string;
      readonly generation: string;
      readonly revision: string;
    };
    readonly spec: JsonObject;
  };
  readonly bindingRef?: TakoformBindingRef;
  readonly deployment?: {
    readonly tenantId: string;
    readonly id: string;
    readonly resourceUid: string;
    readonly offeringId: string;
    readonly providerPackRef: string;
    readonly providerInstallationRef: string;
    readonly nativeId: string;
    readonly state:
      | "provisioning"
      | "candidate"
      | "active"
      | "draining"
      | "retained"
      | "failed"
      | "deleted";
    readonly observed: JsonObject;
    readonly outputs: JsonObject;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

export interface ProviderSqliteMigrationIdentity {
  readonly path: string;
  readonly digest: `sha256:${string}`;
}

export interface ProviderSqliteMigration extends ProviderSqliteMigrationIdentity {
  readonly sql: Uint8Array;
}

export type ProviderValue<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ProviderFailure };

/**
 * Versioned, provider-owned readback identity retained by the Host after a
 * logical Resource is deleted.  `nativeId` and `data` are Host-internal: they
 * are never copied to a customer-facing Resource or absence receipt.  The
 * provider is responsible for constructing the descriptor from its own
 * identity rules and for validating it again before a readback.
 */
export const PROVIDER_READBACK_API_VERSION = "providers.takoserver.com/readback/v1" as const;

export interface ProviderNativeReadbackDescriptor {
  readonly apiVersion: typeof PROVIDER_READBACK_API_VERSION;
  readonly provider: string;
  readonly kind: string;
  readonly nativeId: string;
  /** Exact provider address/parent relation, with no credentials or raw body. */
  readonly data: JsonObject;
}

/** Safe construction failure; provider input and upstream diagnostics never escape. */
export class ProviderReadbackDescriptorError extends Error {
  readonly code = "invalid_descriptor" as const;

  constructor() {
    super("the provider readback descriptor is invalid");
    this.name = "ProviderReadbackDescriptorError";
  }
}

export type ProviderNativeAbsenceUnknownReason =
  | "transport"
  | "malformed"
  | "unsupported"
  | "authority_unavailable";

/** Closed tri-state result for a provider-native absence readback. */
export type ProviderNativeAbsence =
  | {
      readonly outcome: "absent" | "present";
      /** Bounded safe descriptor of what was read; never includes nativeId. */
      readonly evidence: JsonObject;
    }
  | {
      readonly outcome: "unknown";
      readonly reason: ProviderNativeAbsenceUnknownReason;
      readonly retryable: boolean;
    };

export interface ProviderNativeReadbackInput {
  readonly offering: ProviderOffering;
  readonly nativeId: string;
  readonly identity: ResourceIdentity;
  readonly spec?: JsonObject;
  readonly relations?: readonly ProviderRelation[];
}

export interface Provider {
  readonly id: string;
  /** Static configuration, not a per-request discovery call. */
  readonly offerings: readonly ProviderOffering[];
  /** Exact historical capabilities usable only for recorded Deployment recovery. */
  readonly recoveryOfferings?: readonly ProviderOffering[];
  /** Exact future WorkerEndpoint derivation; never creates a Resource or provider object. */
  readonly workerEndpointOriginReservations?: ProviderWorkerEndpointOriginReservationCapability;
  /** Present only when this configured adapter can durably receive one-shot runtime inputs. */
  readonly runtimeInputCapabilities?: ProviderRuntimeInputCapabilities;
  apply(input: ApplyInput): Promise<ProviderTicket>;
  /**
   * Captures an opaque, versioned provider readback descriptor before the
   * logical Resource row disappears. This method is pure and synchronous:
   * descriptor creation never calls the provider or mutates local state.
   */
  createNativeReadbackDescriptor?(
    input: ProviderNativeReadbackInput,
  ): ProviderNativeReadbackDescriptor;
  /**
   * Strictly read-only native absence verification. Implementations may issue
   * GET/HEAD/list/read calls only; they must never replay delete/apply or
   * trigger retries, writes, reloads, or other mutation side effects.
   */
  verifyNativeAbsence?(input: {
    readonly offering: ProviderOffering;
    readonly descriptor: ProviderNativeReadbackDescriptor;
  }): Promise<ProviderNativeAbsence>;
  /**
   * Deterministic, non-mutating recovery for an apply whose acknowledgement
   * was lost. Implementations must read/adopt an existing native identity (or
   * fail closed); this seam is intentionally separate from `apply` so a
   * recovery retry can never accidentally issue a second write.
   */
  recoverApply?(input: ApplyInput): Promise<ProviderTicket>;
  /**
   * Mutating convergence for an apply command whose durable Host dispatch may
   * already have crossed the provider boundary. The Host calls this only while
   * holding the exact operation lease. Implementations must key every effect
   * by `operationId` (and `operationKey` where supplied), adopt the same
   * realized closure after acknowledgement loss, and never create a second
   * logical native resource for the command.
   *
   * This is deliberately distinct from `recoverApply`, which remains a
   * strictly read-only inspection seam.
   */
  convergeApply?(input: ApplyInput): Promise<ProviderTicket>;
  poll?(input: { readonly operationId: string; readonly handle: string }): Promise<ProviderTicket>;
  observe(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket>;
  delete(input: {
    /** Stable identity and recovery evidence for this delete. */
    readonly operationId: string;
    /** Only `initial` may issue a new delete; recovery must poll/observe. */
    readonly operationMode?: "initial" | "recovery";
    /** Opaque provider-owned handle retained by the Host for polling. */
    readonly providerHandle?: string;
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec?: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket>;
  /**
   * Deterministic, non-mutating delete recovery. Providers without a
   * readback/adoption path must omit this capability and leave the Host in an
   * explicit recovery-required state instead of replaying DELETE.
   */
  recoverDelete?(input: {
    readonly operationId: string;
    readonly operationMode?: "initial" | "recovery";
    readonly providerHandle?: string;
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec?: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket>;
  /** Adopts an existing native resource. Absent when adoption is impossible. */
  adopt?(input: {
    /** Stable identity and recovery evidence for this adoption. */
    readonly operationId: string;
    /** Only `initial` may issue a new adoption; recovery must poll/observe. */
    readonly operationMode?: "initial" | "recovery";
    /** Opaque provider-owned handle retained by the Host for polling. */
    readonly providerHandle?: string;
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket>;
  /** Deterministic, non-mutating adoption recovery (observe/readback only). */
  recoverAdopt?(input: {
    readonly operationId: string;
    readonly operationMode?: "initial" | "recovery";
    readonly providerHandle?: string;
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket>;
  /** Administrative SQLite history, separate from the runtime SQL Interface. */
  readonly sqliteMigrations?: {
    readLedger(input: {
      readonly nativeId: string;
    }): Promise<ProviderValue<readonly ProviderSqliteMigrationIdentity[]>>;
    applySuffix(input: {
      readonly nativeId: string;
      readonly expectedPrefix: readonly ProviderSqliteMigrationIdentity[];
      readonly migrations: readonly ProviderSqliteMigration[];
    }): Promise<ProviderValue<undefined>>;
  };
}

export function succeeded(result: ProviderResult): ProviderTicket {
  return { phase: "succeeded", result };
}

export function failed(
  code: ProviderFailure["code"],
  message: string,
  retryable = false,
): ProviderTicket {
  return { phase: "failed", failure: { code, message, retryable } };
}

export function running(handle: string, pollAfterMs = 2_000): ProviderTicket {
  return { phase: "running", handle, pollAfterMs };
}
