import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "../interface-ref.ts";
import type { JsonObject } from "../ports.ts";
import type { ResourceDeploymentMutation } from "../resource-deployments.ts";

export type { TakoformBindingRef, TakoformInterfaceRef, TakoformV1Alpha3FormRef };

/**
 * The Takoform Host wire vocabulary.
 *
 * These internal shapes carry both portable contract values and Host-only
 * authority. Public Host API v1 responses are closed by the Takoform schema
 * and must pass through the wire projector; never serialize this model
 * directly or treat an internal field as an additive v1 extension.
 */

export type TakoformOperation = "create" | "read" | "update" | "delete" | "import" | "observe";

export interface InstalledTakoformForm {
  readonly identity: {
    readonly formRef: TakoformV1Alpha3FormRef;
    readonly packageDigest?: `sha256:${string}`;
    /** Exact Host implementation selected by the durable support head. */
    readonly implementationDigest?: `sha256:${string}`;
  };
  readonly displayName?: string;
  readonly description?: string;
  /** Minimum Host lane required by this exact Definition. */
  readonly requiresHostApi?: string;
  /** Portable cross-resource/output constraints owned by the Definition. */
  readonly constraints?: readonly TakoformConstraint[];
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
  /** Explicit family adapter for a Form-provided worker class Interface. */
  readonly workerClassRuntime?: {
    readonly providedInterface: string;
    readonly className: `/${string}`;
    readonly workerRelation: `/${string}`;
    readonly deploymentForm: { readonly apiVersion: string; readonly kind: string };
    readonly deploymentWorkerRelation: `/${string}`;
    readonly deploymentVersionRelation: `/${string}`;
    readonly versionBundleRelation: `/${string}`;
  };
  readonly validateDesired?: (spec: JsonObject) => readonly TakoformDiagnostic[];
}

export type TakoformConstraint =
  | {
      readonly kind: "exclusive";
      readonly reference: `/${string}`;
      readonly keyedBy?: `/${string}`;
    }
  | {
      readonly kind: "sum";
      readonly list: `/${string}`;
      readonly member: string;
      readonly total: number;
    }
  | { readonly kind: "claim"; readonly property: `/${string}` }
  | { readonly kind: "hostAssigned"; readonly output: `/${string}` }
  | {
      readonly kind: "orderedPair" | "distinctPair" | "uniquePair";
      readonly references: readonly [`/${string}`, `/${string}`];
    }
  | { readonly kind: "uniqueBy"; readonly list: `/${string}`; readonly member: string }
  | { readonly kind: "acyclic"; readonly reference: `/${string}` }
  | {
      readonly kind: "sameResolvedTarget";
      readonly anchor: `/${string}`;
      readonly members: `/${string}`;
      readonly through: `/${string}`;
    };

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
   * Resource-plane scopes carried by an organization API key. An omitted
   * value is the legacy/internal Host principal, which retains full access;
   * when present, the router enforces the exact read/write boundary.
   */
  readonly scopes?: readonly TakoformHostResourceScope[];
  /**
   * A reseller-issued run credential may operate only one exact Resource
   * address. Organization sessions/API keys omit this and use the optional
   * resource-plane scopes above (or legacy unrestricted access when omitted).
   */
  readonly scope?:
    | {
        readonly space: string;
        readonly mode: "tenant-run";
      }
    | {
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

export type TakoformHostResourceScope = "resources:read" | "resources:write";

/** Deployment- and principal-specific truth for one installed exact FormRef. */
export interface TakoformFormAvailability {
  readonly executable: boolean;
  readonly activated: boolean;
  readonly availableToPrincipal: boolean;
}

export interface TakoformFormAvailabilityResolver {
  resolve(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly form: InstalledTakoformForm;
  }): Promise<TakoformFormAvailability>;
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
  /** Host-internal provider realization; never rendered into a Resource. */
  readonly deploymentMutation?: ResourceDeploymentMutation;
}

/**
 * Closed, tri-state native-absence attestation.  `source` tells operators
 * whether the proof came from a Host-owned intrinsic resource or from a
 * provider readback; neither path exposes a provider-native identifier.
 */
export interface TakoformNativeAbsenceEvidence {
  readonly status: "absent" | "present" | "indeterminate";
  readonly source: "intrinsic" | "provider";
  readonly evidenceRef?: `sha256:${string}`;
  readonly effectCount: number;
  readonly deploymentCount: number;
  readonly checkedAt: string;
  readonly reason?:
    | "closure_pending"
    | "effect_unresolved"
    | "deployment_active"
    | "deployment_unmarked"
    | "provider_unavailable"
    | "provider_readback_failed"
    | "provider_identity_missing"
    | "legacy_unattested";
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

export interface TakoformStandardServiceSlot {
  readonly name: string;
  readonly required: boolean;
  readonly service: {
    readonly apiVersion: "standards.takoform.com/v1alpha1" | "standards.takoform.com/v1";
    readonly protocol: string;
  };
}

/** Sealed execution material. It is passed to a driver and never stored in a Resource. */
export interface TakoformStandardServiceProjection extends TakoformStandardServiceSlot {
  readonly endpoint: JsonObject;
  readonly credential: JsonObject;
}

export interface TakoformStandardServiceResolver {
  satisfiable(input: {
    readonly tenantId: string;
    /** Absent only on the Host-wide support profile probe. */
    readonly space?: string;
    readonly serviceRef: TakoformStandardServiceSlot["service"];
  }): Promise<boolean>;
  resolve(input: {
    readonly tenantId: string;
    readonly space: string;
    readonly form: InstalledTakoformForm;
    readonly slot: TakoformStandardServiceSlot;
  }): Promise<{
    readonly endpoint: JsonObject;
    readonly credential: JsonObject;
  } | null>;
}

export interface TakoformResourceDriver {
  apply(input: {
    readonly operationId: string;
    /** Durable saga evidence: only `initial` may dispatch a new provider mutation. */
    readonly operationMode?: "initial" | "recovery";
    /** Opaque provider-owned handle retained by the saga for recovery polling. */
    readonly providerHandle?: string;
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly relations: readonly TakoformDriverRelation[];
    readonly commercialAuthority?: TakoformCommercialAuthority;
    readonly standardServices?: readonly TakoformStandardServiceProjection[];
    readonly previous?: TakoformStoredResource;
    /** Commit the Deployment realization with the portable Resource. */
    readonly atomicDeploymentCommit?: true;
  }): Promise<TakoformDriverReceipt>;
  observe(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly resource: TakoformStoredResource;
    readonly relations: readonly TakoformDriverRelation[];
  }): Promise<TakoformDriverReceipt>;
  delete(input: {
    readonly operationId: string;
    /** Durable saga mode; recovery must poll a retained provider handle. */
    readonly operationMode?: "initial" | "recovery";
    /** Opaque provider-owned handle retained by the saga for recovery polling. */
    readonly providerHandle?: string;
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly resource: TakoformStoredResource;
    readonly relations: readonly TakoformDriverRelation[];
    /** Commit the Deployment realization with the portable Resource deletion. */
    readonly atomicDeploymentCommit?: true;
    // biome-ignore lint/suspicious/noConfusingVoidType: intrinsic Resource deletion has no provider receipt
  }): Promise<TakoformDriverReceipt | void>;
  /**
   * Read-only, tombstone-backed native absence attestation.  Implementations
   * must never redispatch a mutation while answering this method.
   */
  verifyNativeAbsence?(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly space: string;
    readonly name: string;
  }): Promise<TakoformNativeAbsenceEvidence>;
  import?(input: {
    readonly operationId: string;
    /** Durable saga evidence: only `initial` may dispatch a new provider mutation. */
    readonly operationMode?: "initial" | "recovery";
    /** Opaque provider-owned handle retained by the saga for recovery polling. */
    readonly providerHandle?: string;
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly nativeId: string;
    readonly relations: readonly TakoformDriverRelation[];
    readonly standardServices?: readonly TakoformStandardServiceProjection[];
    readonly previous?: TakoformStoredResource;
    /** Commit the Deployment realization with the portable Resource. */
    readonly atomicDeploymentCommit?: true;
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
