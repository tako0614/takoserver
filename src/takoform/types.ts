import type { JsonObject } from "../ports.ts";

/**
 * The Takoform Host wire vocabulary.
 *
 * These shapes are the product's primary contract. A released Terraform
 * provider pins the exact `formRef` quad and the resource envelope below, so
 * fields may be added but never renamed, reordered in meaning, or removed.
 */

export interface TakoformV1Alpha3FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: `sha256:${string}`;
}

export interface TakoformInterfaceRef {
  readonly apiVersion: "interfaces.takoform.com/v1alpha1";
  readonly name: string;
  readonly version: string;
  readonly schemaDigest: `sha256:${string}`;
}

export interface TakoformBindingRef {
  readonly apiVersion: "bindings.takoform.com/v1alpha1";
  readonly name: string;
  readonly version: string;
  readonly schemaDigest: `sha256:${string}`;
}

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

export interface TakoformDiagnostic {
  readonly severity: "error" | "warning";
  readonly field?: string;
  readonly message: string;
}

export interface TakoformHostPrincipal {
  readonly tenantId: string;
  readonly principalId: string;
}

export interface TakoformDriverReceipt {
  readonly observed?: JsonObject;
  readonly outputs?: JsonObject;
}

export interface TakoformResourceDriver {
  apply(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly previous?: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt>;
  observe(input: {
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt>;
  delete(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
  }): Promise<void>;
  import?(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly nativeId: string;
    readonly previous?: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt>;
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
  readonly type: "Ready";
  readonly status: "True" | "False" | "Unknown";
  readonly reason: TakoformConditionReason;
  readonly lastTransitionTime: string;
  readonly message?: string;
}

export type TakoformConditionReason =
  | "Available"
  | "Provisioning"
  | "CreateFailed"
  | "UpdateFailed"
  | "DeleteFailed";

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
