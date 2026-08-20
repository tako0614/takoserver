import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "../interface-ref.ts";
import type { JsonObject } from "../ports.ts";

export type { TakoformBindingRef, TakoformInterfaceRef, TakoformV1Alpha3FormRef };

/**
 * The Takoform Host wire vocabulary.
 *
 * These shapes are the product's primary contract. A released Terraform
 * provider pins the exact `formRef` quad and the resource envelope below, so
 * fields may be added but never renamed, reordered in meaning, or removed.
 */

export type TakoformOperation = "create" | "read" | "update" | "delete" | "import" | "observe";

export interface InstalledTakoformForm {
  readonly identity: {
    readonly formRef: TakoformV1Alpha3FormRef;
    readonly packageDigest?: `sha256:${string}`;
  };
  readonly displayName?: string;
  readonly description?: string;
  readonly role?: "identity" | "revision" | "deployment" | "attachment" | "policy";
  readonly providedInterfaces?: readonly TakoformInterfaceRef[];
  readonly acceptedBindings?: readonly TakoformBindingRef[];
  readonly desiredSchema: JsonObject;
  readonly observedSchema?: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly operations: readonly TakoformOperation[];
  readonly artifactRequirement?: {
    /** Spec field containing a committed, tenant-held artifact manifest digest. */
    readonly specField: string;
    readonly kind: "WorkerBundle" | "StaticAssetBundle" | "MigrationBundle";
  };
  readonly validateDesired?: (spec: JsonObject) => readonly TakoformDiagnostic[];
}

/**
 * One installed portable BindingDefinition.
 *
 * Forms only name accepted binding identities. The definition is separate
 * host configuration because it owns the source role, target Interface, and
 * allowed target Form kinds that make a relation safe to project at runtime.
 */
export interface InstalledTakoformBinding {
  readonly bindingRef: TakoformBindingRef;
  readonly sourceRole: NonNullable<InstalledTakoformForm["role"]>;
  readonly targetInterface: TakoformInterfaceRef;
  readonly allowedTargetForms: readonly {
    readonly apiVersion: string;
    readonly kind: string;
  }[];
}

export interface TakoformDiagnostic {
  readonly severity: "error" | "warning";
  readonly field?: string;
  readonly message: string;
}

export interface TakoformHostPrincipal {
  readonly tenantId: string;
  readonly principalId: string;
  /**
   * A reseller-issued run credential may operate only one exact Resource
   * address. Organization sessions/API keys omit this and retain their normal
   * organization-wide authority.
   */
  readonly scope?: {
    readonly space: string;
    readonly formRef: TakoformV1Alpha3FormRef;
    readonly resourceName: string;
    readonly mode: "provision" | "manage";
    readonly expectedResourceUid?: string;
    readonly commercialAuthority?: TakoformCommercialAuthority;
    /** Atomically binds the paid reservation before the first create. */
    readonly claimCreate?: () => Promise<void>;
  };
}

export interface TakoformCommercialAuthority {
  readonly reservationId: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
}

export interface TakoformDriverReceipt {
  readonly observed?: JsonObject;
  readonly outputs?: JsonObject;
  /**
   * The provider's current portable readiness condition. Omitting it means
   * the representation did not move; returning it lets an observe record a
   * host-side status transition without pretending desired state changed.
   */
  readonly conditions?: readonly TakoformCondition[];
}

/**
 * One relation after the Host has resolved and re-read its exact UID target.
 *
 * Provider adapters receive this projection instead of resolving names on
 * their own. The relation pin remains the authority; `resource` is the exact
 * same-tenant, same-space representation observed immediately before the
 * provider mutation.
 */
export interface TakoformDriverRelation {
  readonly pointer: string;
  readonly relation: string;
  readonly targetUid: string;
  readonly resource: TakoformStoredResource;
  readonly bindingRef?: TakoformBindingRef;
}

export interface TakoformResourceDriver {
  apply(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly relations: readonly TakoformDriverRelation[];
    readonly commercialAuthority?: TakoformCommercialAuthority;
    readonly previous?: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt>;
  observe(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly resource: TakoformStoredResource;
    readonly relations: readonly TakoformDriverRelation[];
  }): Promise<TakoformDriverReceipt>;
  delete(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly resource: TakoformStoredResource;
    readonly relations: readonly TakoformDriverRelation[];
  }): Promise<void>;
  import?(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly nativeId: string;
    readonly relations: readonly TakoformDriverRelation[];
    readonly previous?: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt>;
  /**
   * Portable SQLite migration execution against the target database itself.
   * Each suffix item and its ledger row must commit atomically in that
   * database; the Host control database is deliberately not used as a second
   * source of truth for applied schema history.
   */
  sqliteMigrations?: {
    readLedger(input: {
      readonly tenantId: string;
      readonly database: TakoformStoredResource;
    }): Promise<readonly TakoformSqliteMigrationIdentity[]>;
    applySuffix(input: {
      readonly tenantId: string;
      readonly database: TakoformStoredResource;
      readonly expectedPrefix: readonly TakoformSqliteMigrationIdentity[];
      readonly migrations: readonly TakoformSqliteMigration[];
    }): Promise<void>;
  };
}

export interface TakoformSqliteMigrationIdentity {
  readonly path: string;
  readonly digest: `sha256:${string}`;
}

export interface TakoformSqliteMigration extends TakoformSqliteMigrationIdentity {
  readonly sql: Uint8Array;
}

/**
 * A stored resource as it appears on the wire.
 *
 * `conditions` carries a union rather than the single frozen literal it once
 * did. The happy path still emits exactly `Ready/True/Available`, which is what
 * the released provider observes and what the conformance suite asserts; the
 * additional members exist so a resource that failed or is still provisioning
 * can be described truthfully instead of being unrepresentable.
 */
export interface TakoformCondition {
  readonly type: "Ready" | "Reconciling" | "Degraded" | "Drifted" | "Blocked" | "Deleting";
  readonly status: "True" | "False" | "Unknown";
  readonly reason: TakoformConditionReason;
  readonly lastTransitionTime: string;
  readonly hostReason?: string;
  readonly message?: string;
}

export type TakoformConditionReason =
  | "Available"
  | "Provisioning"
  | "Reconciling"
  | "Failed"
  | "BackendUnavailable"
  | "SpecDrift"
  | "ExternalChange"
  | "DependencyMissing"
  | "DependencyInUse"
  | "PolicyDenied"
  | "UnsupportedCapability"
  | "Deleting";

export interface TakoformStoredResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly form: InstalledTakoformForm["identity"];
  readonly metadata: {
    readonly name: string;
    readonly space: string;
    readonly uid: string;
    readonly generation: string;
    readonly revision: string;
  };
  readonly spec: JsonObject;
  readonly status: {
    readonly observedGeneration: string;
    readonly conditions: readonly TakoformCondition[];
    readonly observed?: JsonObject;
    readonly outputs?: JsonObject;
    /** Present while an asynchronous operation is still settling. */
    readonly operationId?: string;
  };
}

export interface TakoformHost {
  handle(request: Request): Promise<Response | null>;
}

/**
 * Every Host failure. `code` is the wire code and `status` the HTTP status; the
 * envelope built from them is pinned by the conformance suite.
 */
export class TakoformHostError extends Error {
  constructor(
    readonly code = "invalid_argument",
    readonly status = 400,
    /** Extra wire detail, such as validation diagnostics. Never driver text. */
    readonly details?: unknown,
  ) {
    super(code.replaceAll("_", " "));
    this.name = "TakoformHostError";
  }
}
