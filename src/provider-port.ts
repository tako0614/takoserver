import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import type { JsonObject } from "./ports.ts";

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
  | { readonly phase: "failed"; readonly failure: ProviderFailure }
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
}

export interface ApplyInput {
  /** Stable across retries of the same logical operation. */
  readonly operationId: string;
  readonly offering: ProviderOffering;
  readonly identity: ResourceIdentity;
  readonly spec: JsonObject;
  readonly region?: string;
  /** Present for an update; absent for a create. */
  readonly previous?: { readonly nativeId: string; readonly spec: JsonObject };
  /** Exact Host-pinned dependencies with any active provider realization. */
  readonly relations?: readonly ProviderRelation[];
  /** Signed, short-lived and opaque to the Provider Pack until materialization. */
  readonly runtimeMaterialization?: JsonObject;
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

export interface Provider {
  readonly id: string;
  /** Static configuration, not a per-request discovery call. */
  readonly offerings: readonly ProviderOffering[];
  apply(input: ApplyInput): Promise<ProviderTicket>;
  poll?(input: { readonly operationId: string; readonly handle: string }): Promise<ProviderTicket>;
  observe(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket>;
  delete(input: {
    readonly operationId: string;
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec?: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket>;
  /** Adopts an existing native resource. Absent when adoption is impossible. */
  adopt?(input: {
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
