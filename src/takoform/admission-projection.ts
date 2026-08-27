import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import type { AdmissionDigest } from "./admission.ts";
import { validateDigest } from "./admission.ts";
import { validateFormRef } from "./forms.ts";
import type { TakoformOperation } from "./types.ts";

/**
 * Resource lifecycle operations evaluated by the Host projection. Protocol
 * phases and operator activation writes are deliberately outside this
 * vocabulary; a caller prepares by evaluating its eventual create/import or
 * update operation.
 */
export type AdmissionProjectionOperation =
  | "create"
  | "import"
  | "update"
  | "observe"
  | "delete"
  | "evacuate";

export type AdmissionProjectionDigest = AdmissionDigest;

/** The only activation audiences understood by the Host projection. */
export type AdmissionProjectionAudience =
  | { readonly kind: "host"; readonly hostId: string }
  | { readonly kind: "tenant"; readonly tenantId: string }
  | { readonly kind: "space"; readonly tenantId: string; readonly space: string }
  | { readonly kind: "principal"; readonly tenantId: string; readonly principalId: string };

/** Request identity used to resolve an activation audience. */
export interface AdmissionProjectionContext {
  readonly hostId?: string;
  readonly tenantId?: string;
  readonly space?: string;
  readonly principalId?: string;
}

/** One current or historical publisher policy event. */
export interface AdmissionProjectionPublisher {
  readonly publisherKey: string;
  readonly eventType: "allow" | "rotate" | "deny";
  readonly policyDigest: AdmissionProjectionDigest;
  readonly eventDigest: AdmissionProjectionDigest;
}

/** One current or historical revocation checkpoint verification result. */
export interface AdmissionProjectionCheckpoint {
  readonly publisherKey: string;
  readonly policyDigest: AdmissionProjectionDigest;
  readonly policyEventDigest: AdmissionProjectionDigest;
  readonly sequence: number;
  readonly checkpointDigest: AdmissionProjectionDigest;
  readonly eventDigest: AdmissionProjectionDigest;
  readonly verified: boolean;
  readonly stale: boolean;
  readonly revokedPackageDigests: readonly AdmissionProjectionDigest[];
}

/** One append-only install-chain event. */
export interface AdmissionProjectionInstall {
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionProjectionDigest;
  readonly publisherKey: string;
  readonly eventType: "install" | "replace" | "uninstall";
  readonly implementationDigest?: AdmissionProjectionDigest;
}

/** One current or historical implementation support event. */
export interface AdmissionProjectionSupport {
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionProjectionDigest;
  readonly implementationDigest: AdmissionProjectionDigest;
  readonly supported: boolean;
  /** Full lifecycle operations declared by the exact Form support head. */
  readonly operations: readonly TakoformOperation[];
}

/** One current or historical activation head. */
export interface AdmissionProjectionActivation {
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionProjectionDigest;
  readonly implementationDigest: AdmissionProjectionDigest;
  readonly audience: AdmissionProjectionAudience;
  readonly active: boolean;
}

/**
 * Current Host-owned proof that package bytes remain available for a retained
 * historical Resource. Install history alone is insufficient because it can
 * outlive a terminal package purge.
 */
export interface AdmissionProjectionRetention {
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionProjectionDigest;
  readonly implementationDigest: AdmissionProjectionDigest;
  readonly retained: boolean;
}

/** The current heads are intentionally not inferred from history. */
export interface AdmissionProjectionCurrentHeads {
  readonly publisher?: AdmissionProjectionPublisher | null;
  readonly checkpoint?: AdmissionProjectionCheckpoint | null;
  readonly install?: AdmissionProjectionInstall | null;
  readonly support?: AdmissionProjectionSupport | null;
  readonly activations?: readonly AdmissionProjectionActivation[];
  readonly retentions?: readonly AdmissionProjectionRetention[];
}

/** Append-only records retained for cleanup and audit only. */
export interface AdmissionProjectionHistory {
  readonly publishers?: readonly AdmissionProjectionPublisher[];
  readonly checkpoints?: readonly AdmissionProjectionCheckpoint[];
  readonly installs?: readonly AdmissionProjectionInstall[];
  readonly supports?: readonly AdmissionProjectionSupport[];
  readonly activations?: readonly AdmissionProjectionActivation[];
}

/** Exact Resource identity required for retained observe/delete/evacuate. */
export interface AdmissionProjectionResourceIdentity {
  readonly resourceUid: string;
  readonly tenantId: string;
  readonly space: string;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionProjectionDigest;
  readonly implementationDigest: AdmissionProjectionDigest;
}

export interface AdmissionProjectionInput {
  readonly operation: AdmissionProjectionOperation;
  readonly context?: AdmissionProjectionContext;
  readonly formRef?: TakoformV1Alpha3FormRef;
  readonly packageDigest?: AdmissionProjectionDigest;
  readonly implementationDigest?: AdmissionProjectionDigest;
  readonly current?: AdmissionProjectionCurrentHeads;
  readonly history?: AdmissionProjectionHistory;
  readonly resource?: AdmissionProjectionResourceIdentity;
}

export type AdmissionProjectionReasonCode =
  | "context_missing"
  | "space_tenant_required"
  | "form_ref_missing"
  | "form_ref_invalid"
  | "package_missing"
  | "digest_invalid"
  | "implementation_missing"
  | "identity_invalid"
  | "fact_invalid"
  | "publisher_missing"
  | "publisher_denied"
  | "publisher_invalid"
  | "publisher_mismatch"
  | "checkpoint_missing"
  | "checkpoint_unverified"
  | "checkpoint_stale"
  | "checkpoint_policy_mismatch"
  | "checkpoint_sequence_invalid"
  | "checkpoint_revocation_unknown"
  | "package_not_current"
  | "package_uninstalled"
  | "package_revoked"
  | "support_missing"
  | "support_package_mismatch"
  | "support_disabled"
  | "support_operations_invalid"
  | "support_operation_unsupported"
  | "implementation_unsupported"
  | "install_implementation_mismatch"
  | "activation_missing"
  | "activation_unknown_audience"
  | "activation_inactive"
  | "activation_implementation_mismatch"
  | "retained_resource_required"
  | "retained_resource_mismatch"
  | "retention_missing"
  | "package_purged"
  | "retained_package_missing"
  | "retained_package_implementation_mismatch"
  | "admitted"
  | "retained_cleanup";

export interface AdmissionProjectionReason {
  readonly code: AdmissionProjectionReasonCode;
  readonly message: string;
}

export interface AdmissionProjectionDecision {
  readonly allowed: boolean;
  readonly mode: "mutation" | "retained-cleanup";
  readonly reasons: readonly AdmissionProjectionReason[];
  readonly effectiveAudience?: AdmissionProjectionAudience;
}

const MUTATION_OPERATIONS = new Set<AdmissionProjectionOperation>(["create", "import", "update"]);

const CLEANUP_OPERATIONS = new Set<AdmissionProjectionOperation>(["observe", "delete", "evacuate"]);

const FORM_OPERATIONS = new Set<TakoformOperation>([
  "create",
  "read",
  "update",
  "delete",
  "import",
  "observe",
]);

const AUDIENCE_RANK: Record<AdmissionProjectionAudience["kind"], number> = {
  host: 1,
  tenant: 2,
  space: 3,
  principal: 4,
};

const MAX_IDENTITY_LENGTH = 255;
const MAX_RESOURCE_UID_LENGTH = 255;

/**
 * Computes current-effective admission from immutable facts supplied by the
 * caller.  No database, clock, package bytes, or mutable registry is read.
 * Current heads are authoritative for new mutations; history is consulted
 * only to prove that an exact retained Resource can still be cleaned up.
 */
export function evaluateAdmissionProjection(
  input: AdmissionProjectionInput,
): AdmissionProjectionDecision {
  validateInputShape(input);
  const operation = input.operation;
  const mode = CLEANUP_OPERATIONS.has(operation) ? "retained-cleanup" : "mutation";
  const reasons: AdmissionProjectionReason[] = [];
  const context = input.context;
  const current = input.current;
  const history = input.history;

  addIdentityReasons(input, context, reasons);
  addRequestFactValidityReasons(input, context, reasons);

  if (mode === "retained-cleanup") {
    addCleanupArrayElementValidityReasons(current, history, reasons);
    const resource = input.resource;
    if (!resource) {
      reasons.push({
        code: "retained_resource_required",
        message: "observe, delete, and evacuate require an exact retained Resource identity",
      });
    } else {
      addRetainedResourceReasons(input, context, resource, reasons);
      addRetentionReasons(current, history, input, resource, reasons);
    }
    if (reasons.length > 0) {
      return { allowed: false, mode, reasons: freezeReasons(reasons) };
    }
    return {
      allowed: true,
      mode,
      reasons: [
        {
          code: "retained_cleanup",
          message: "exact retained Resource identity may be cleaned up",
        },
      ],
    };
  }

  addCurrentFactValidityReasons(current, reasons);
  addActivationArrayElementValidityReasons(current, reasons);

  const publisher = current?.publisher ?? null;
  const checkpoint = current?.checkpoint ?? null;
  const install = current?.install ?? null;
  const support = current?.support ?? null;

  addPublisherReasons(publisher, install, reasons);
  addCheckpointReasons(publisher, checkpoint, input.packageDigest, reasons);
  addInstallReasons(
    install,
    input.formRef,
    input.packageDigest,
    input.implementationDigest,
    reasons,
  );
  addSupportReasons(
    support,
    input.formRef,
    input.packageDigest,
    input.implementationDigest,
    operation,
    reasons,
  );

  const activation = effectiveActivation(
    current?.activations,
    context,
    input.formRef,
    input.packageDigest,
    reasons,
  );
  if (activation) {
    if (activation.active !== true) {
      reasons.push({
        code: "activation_inactive",
        message: "the effective activation is inactive",
      });
    }
    if (
      input.implementationDigest === undefined ||
      activation.implementationDigest !== input.implementationDigest
    ) {
      reasons.push({
        code: "activation_implementation_mismatch",
        message: "the effective activation does not match the requested implementation",
      });
    }
  }

  if (reasons.length > 0) {
    return {
      allowed: false,
      mode,
      reasons: freezeReasons(reasons),
      ...(activation ? { effectiveAudience: cloneAudience(activation.audience) } : {}),
    };
  }
  return {
    allowed: true,
    mode,
    reasons: [
      {
        code: "admitted",
        message: "current publisher, checkpoint, package, support, and activation facts agree",
      },
    ],
    ...(activation ? { effectiveAudience: cloneAudience(activation.audience) } : {}),
  };
}

function validateInputShape(input: AdmissionProjectionInput): void {
  if (!input || typeof input !== "object") {
    throw new TypeError("admission projection input is required");
  }
  if (!MUTATION_OPERATIONS.has(input.operation) && !CLEANUP_OPERATIONS.has(input.operation)) {
    throw new TypeError("admission projection operation is invalid");
  }
  const current = input.current;
  if (current !== undefined && current !== null) {
    if (typeof current !== "object") throw new TypeError("current admission heads are invalid");
    if (current.activations !== undefined && !Array.isArray(current.activations)) {
      throw new TypeError("current activation heads are invalid");
    }
    if (current.retentions !== undefined && !Array.isArray(current.retentions)) {
      throw new TypeError("current retention heads are invalid");
    }
    validateActivationHeadUniqueness(current.activations);
    validateRetentionHeadUniqueness(current.retentions);
  }
  if (input.history !== undefined && input.history !== null) {
    if (typeof input.history !== "object") throw new TypeError("admission history is invalid");
    validateHistoryArrays(input.history);
  }
}

function validateActivationHeadUniqueness(
  activations: readonly AdmissionProjectionActivation[] | undefined,
): void {
  // Sparse arrays are denied by the projection path. Skip duplicate-head
  // reduction here so a hole cannot alter which duplicate is observed (or
  // turn a malformed sparse input into an order-dependent validation throw).
  if (!isDenseArray(activations)) return;
  const seen = new Set<string>();
  for (const activation of activations) {
    const audience = normalizeAudience(activation?.audience);
    if (!audience) continue;
    // Invalid identity/digest facts are denied by the projection path.  Do
    // not dereference them while checking the durable uniqueness key.
    if (!validFormRef(activation?.formRef) || !validDigest(activation?.packageDigest)) continue;
    const key = activationHeadKey(activation, audience);
    if (seen.has(key)) throw new TypeError("duplicate current activation head");
    seen.add(key);
  }
}

function validateRetentionHeadUniqueness(
  retentions: readonly AdmissionProjectionRetention[] | undefined,
): void {
  if (!isDenseArray(retentions)) return;
  const seen = new Set<string>();
  for (const retention of retentions) {
    if (
      !validFormRef(retention?.formRef) ||
      !validDigest(retention?.packageDigest) ||
      !validDigest(retention?.implementationDigest)
    ) {
      continue;
    }
    const key = `${formRefKey(retention?.formRef)}|${retention?.packageDigest}|${retention?.implementationDigest}`;
    if (seen.has(key)) throw new TypeError("duplicate current retention head");
    seen.add(key);
  }
}

function validateHistoryArrays(history: AdmissionProjectionHistory): void {
  for (const [name, value] of Object.entries(history)) {
    if (value !== undefined && !Array.isArray(value)) {
      throw new TypeError(`admission history ${name} must be an array`);
    }
  }
}

function addIdentityReasons(
  input: AdmissionProjectionInput,
  context: AdmissionProjectionContext | undefined,
  reasons: AdmissionProjectionReason[],
): void {
  if (
    !context ||
    !nonEmpty(context.hostId) ||
    !nonEmpty(context.tenantId) ||
    !nonEmpty(context.space)
  ) {
    reasons.push({
      code: "context_missing",
      message: "host, tenant, and space identity are required",
    });
  }
  if (context?.space !== undefined && !nonEmpty(context.tenantId)) {
    reasons.push({
      code: "space_tenant_required",
      message: "a space audience and Resource address must include a tenant identity",
    });
  }
  if (!input.formRef) {
    reasons.push({ code: "form_ref_missing", message: "an exact FormRef is required" });
  }
  if (!nonEmpty(input.packageDigest)) {
    reasons.push({ code: "package_missing", message: "an exact package digest is required" });
  }
  if (!nonEmpty(input.implementationDigest)) {
    reasons.push({
      code: "implementation_missing",
      message: "an exact implementation digest is required",
    });
  }
}

/**
 * TypeScript types describe the durable shape but do not protect a projection
 * boundary fed by JSON or a database adapter.  Validate all request-bound
 * identity and digest values before any fact can authorize an operation.  A
 * malformed fact is a denied projection, not a guessed/coerced identity.
 */
function addRequestFactValidityReasons(
  input: AdmissionProjectionInput,
  context: AdmissionProjectionContext | undefined,
  reasons: AdmissionProjectionReason[],
): void {
  if (input.formRef !== undefined && !validFormRef(input.formRef)) {
    reasons.push({ code: "form_ref_invalid", message: "the requested FormRef is invalid" });
  }
  if (input.packageDigest !== undefined && !validDigest(input.packageDigest)) {
    reasons.push({ code: "digest_invalid", message: "the requested package digest is invalid" });
  }
  if (input.implementationDigest !== undefined && !validDigest(input.implementationDigest)) {
    reasons.push({
      code: "digest_invalid",
      message: "the requested implementation digest is invalid",
    });
  }
  if (context) {
    if (
      (context.hostId !== undefined && !boundedText(context.hostId, MAX_IDENTITY_LENGTH)) ||
      (context.tenantId !== undefined && !boundedText(context.tenantId, MAX_IDENTITY_LENGTH)) ||
      (context.space !== undefined && !boundedText(context.space, MAX_IDENTITY_LENGTH)) ||
      (context.principalId !== undefined && !boundedText(context.principalId, MAX_IDENTITY_LENGTH))
    ) {
      reasons.push({
        code: "identity_invalid",
        message: "context identity values must be bounded non-empty strings",
      });
    }
  }
}

function addCurrentFactValidityReasons(
  current: AdmissionProjectionCurrentHeads | undefined,
  reasons: AdmissionProjectionReason[],
): void {
  if (!current) return;
  if (current.publisher !== undefined && current.publisher !== null) {
    if (!validPublisherFact(current.publisher)) {
      reasons.push({
        code: "fact_invalid",
        message: "the current publisher head contains malformed identity or digest facts",
      });
    }
  }
  if (current.checkpoint !== undefined && current.checkpoint !== null) {
    if (!validCheckpointFact(current.checkpoint)) {
      reasons.push({
        code: "fact_invalid",
        message: "the current checkpoint contains malformed identity, digest, or sequence facts",
      });
    }
  }
  if (current.install !== undefined && current.install !== null) {
    if (!validInstallFact(current.install)) {
      reasons.push({
        code: "fact_invalid",
        message: "the current install head contains malformed identity or digest facts",
      });
    }
  }
  if (current.support !== undefined && current.support !== null) {
    if (!validSupportFact(current.support)) {
      reasons.push({
        code: "fact_invalid",
        message: "the current support head contains malformed identity, digest, or operation facts",
      });
    }
  }
}

function addActivationArrayElementValidityReasons(
  current: AdmissionProjectionCurrentHeads | undefined,
  reasons: AdmissionProjectionReason[],
): void {
  const activations = current?.activations;
  if (!Array.isArray(activations)) return;
  if (
    !isDenseArray(activations) ||
    activations.some(
      (activation) =>
        !isFactObject(activation) ||
        !validFormRef(activation.formRef) ||
        !validDigest(activation.packageDigest),
    )
  ) {
    reasons.push({
      code: "fact_invalid",
      message: "the current activation head list contains a malformed element",
    });
  }
}

function addCleanupArrayElementValidityReasons(
  current: AdmissionProjectionCurrentHeads | undefined,
  history: AdmissionProjectionHistory | undefined,
  reasons: AdmissionProjectionReason[],
): void {
  const retentions = current?.retentions;
  if (
    retentions !== undefined &&
    (!isDenseArray(retentions) ||
      retentions.some((retention) => !isFactObject(retention) || !validRetentionFact(retention)))
  ) {
    reasons.push({
      code: "fact_invalid",
      message: "the current retained-byte claim list contains a malformed element",
    });
  }
  const installs = history?.installs;
  if (
    installs !== undefined &&
    (!isDenseArray(installs) ||
      installs.some((install) => !isFactObject(install) || !validInstallFact(install)))
  ) {
    reasons.push({
      code: "fact_invalid",
      message: "the retained install history contains a malformed element",
    });
  }
}

function addPublisherReasons(
  publisher: AdmissionProjectionPublisher | null,
  install: AdmissionProjectionInstall | null,
  reasons: AdmissionProjectionReason[],
): void {
  if (!publisher) {
    reasons.push({
      code: "publisher_missing",
      message: "the current publisher policy head is missing",
    });
    return;
  }
  if (publisher.eventType === "deny") {
    reasons.push({
      code: "publisher_denied",
      message: "the current publisher policy denies admission",
    });
  } else if (publisher.eventType !== "allow" && publisher.eventType !== "rotate") {
    reasons.push({
      code: "publisher_invalid",
      message: "the current publisher policy head is invalid",
    });
  }
  if (install && install.publisherKey !== publisher.publisherKey) {
    reasons.push({
      code: "publisher_mismatch",
      message: "the current install head is bound to a different publisher",
    });
  }
}

function addCheckpointReasons(
  publisher: AdmissionProjectionPublisher | null,
  checkpoint: AdmissionProjectionCheckpoint | null,
  packageDigest: AdmissionProjectionDigest | undefined,
  reasons: AdmissionProjectionReason[],
): void {
  if (!checkpoint) {
    reasons.push({
      code: "checkpoint_missing",
      message: "the current revocation checkpoint is missing",
    });
    return;
  }
  if (checkpoint.verified !== true) {
    reasons.push({
      code: "checkpoint_unverified",
      message: "the current revocation checkpoint has not been verified",
    });
  }
  if (checkpoint.stale !== false) {
    reasons.push({
      code: "checkpoint_stale",
      message: "the current revocation checkpoint is stale",
    });
  }
  if (!positiveSequence(checkpoint.sequence)) {
    reasons.push({
      code: "checkpoint_sequence_invalid",
      message: "the current revocation checkpoint sequence is invalid",
    });
  }
  if (
    !publisher ||
    checkpoint.publisherKey !== publisher.publisherKey ||
    checkpoint.policyDigest !== publisher.policyDigest ||
    checkpoint.policyEventDigest !== publisher.eventDigest
  ) {
    reasons.push({
      code: "checkpoint_policy_mismatch",
      message: "the checkpoint is not bound to the current publisher policy head",
    });
  }
  if (!validDenseArray(checkpoint.revokedPackageDigests, validDigest)) {
    reasons.push({
      code: "checkpoint_revocation_unknown",
      message: "the checkpoint does not provide an explicit revocation set",
    });
  } else if (
    packageDigest !== undefined &&
    checkpoint.revokedPackageDigests.includes(packageDigest)
  ) {
    reasons.push({
      code: "package_revoked",
      message: "the package digest is revoked by the checkpoint",
    });
  }
}

function addInstallReasons(
  install: AdmissionProjectionInstall | null,
  formRef: TakoformV1Alpha3FormRef | undefined,
  packageDigest: AdmissionProjectionDigest | undefined,
  implementationDigest: AdmissionProjectionDigest | undefined,
  reasons: AdmissionProjectionReason[],
): void {
  if (!install || !formRef || packageDigest === undefined) {
    reasons.push({
      code: "package_not_current",
      message: "the requested package is not the current install head",
    });
    return;
  }
  if (
    install.eventType === "uninstall" &&
    sameFormRef(install.formRef, formRef) &&
    install.packageDigest === packageDigest
  ) {
    reasons.push({
      code: "package_uninstalled",
      message: "the requested package has been uninstalled",
    });
    return;
  }
  if (
    (install.eventType !== "install" && install.eventType !== "replace") ||
    !sameFormRef(install.formRef, formRef) ||
    install.packageDigest !== packageDigest
  ) {
    reasons.push({
      code: "package_not_current",
      message: "the requested package is not the current install head",
    });
    return;
  }
  if (
    install.implementationDigest !== undefined &&
    implementationDigest !== undefined &&
    install.implementationDigest !== implementationDigest
  ) {
    reasons.push({
      code: "install_implementation_mismatch",
      message: "the current install head is bound to a different implementation",
    });
  }
}

function addSupportReasons(
  support: AdmissionProjectionSupport | null,
  formRef: TakoformV1Alpha3FormRef | undefined,
  packageDigest: AdmissionProjectionDigest | undefined,
  implementationDigest: AdmissionProjectionDigest | undefined,
  operation: AdmissionProjectionOperation,
  reasons: AdmissionProjectionReason[],
): void {
  if (!support) {
    reasons.push({ code: "support_missing", message: "exact implementation support is missing" });
    return;
  }
  if (
    !formRef ||
    packageDigest === undefined ||
    !sameFormRef(support.formRef, formRef) ||
    support.packageDigest !== packageDigest
  ) {
    reasons.push({
      code: "support_package_mismatch",
      message: "support is not for the current Form package",
    });
    return;
  }
  if (support.supported !== true) {
    reasons.push({
      code: "support_disabled",
      message: "the current implementation support head is disabled",
    });
  }
  if (!validDenseArray(support.operations, validFormOperation)) {
    reasons.push({
      code: "support_operations_invalid",
      message: "implementation support does not declare an operation set",
    });
  } else if (!support.operations.includes(operation as TakoformOperation)) {
    reasons.push({
      code: "support_operation_unsupported",
      message: "the implementation support head does not list the requested operation",
    });
  }
  if (implementationDigest !== undefined && support.implementationDigest !== implementationDigest) {
    reasons.push({
      code: "implementation_unsupported",
      message: "the exact requested implementation is not supported",
    });
  }
}

function effectiveActivation(
  activations: readonly AdmissionProjectionActivation[] | undefined,
  context: AdmissionProjectionContext | undefined,
  formRef: TakoformV1Alpha3FormRef | undefined,
  packageDigest: AdmissionProjectionDigest | undefined,
  reasons: AdmissionProjectionReason[],
): AdmissionProjectionActivation | null {
  if (
    !activations ||
    activations.length === 0 ||
    !context ||
    !formRef ||
    packageDigest === undefined
  ) {
    reasons.push({
      code: "activation_missing",
      message: "no current activation matches the request",
    });
    return null;
  }
  let unknownAudience = false;
  const matches: Array<{
    readonly activation: AdmissionProjectionActivation;
    readonly rank: number;
  }> = [];
  for (const activation of activations) {
    // Unknown audience values on another Form/package are irrelevant to this
    // request.  Validate/filter the exact identity first so an unrelated
    // corrupt head cannot deny an otherwise eligible Resource.
    if (
      !activation ||
      !sameFormRef(activation.formRef, formRef) ||
      activation.packageDigest !== packageDigest
    ) {
      continue;
    }
    if (!validActivationFact(activation)) {
      reasons.push({
        code: "fact_invalid",
        message: "the relevant activation head contains malformed identity or digest facts",
      });
      continue;
    }
    const audience = normalizeAudience(activation.audience);
    if (!audience) {
      unknownAudience = true;
      continue;
    }
    if (!validAudienceFact(audience)) {
      reasons.push({
        code: "identity_invalid",
        message: "the relevant activation audience contains an unbounded identity",
      });
      continue;
    }
    if (audienceMatches(audience, context)) {
      matches.push({ activation, rank: AUDIENCE_RANK[audience.kind] });
    }
  }
  if (unknownAudience) {
    reasons.push({
      code: "activation_unknown_audience",
      message: "an activation head carries an unknown audience kind",
    });
  }
  if (matches.length === 0) {
    reasons.push({
      code: "activation_missing",
      message: "no current activation matches the request",
    });
    return null;
  }
  matches.sort((left, right) => right.rank - left.rank);
  return matches[0]?.activation ?? null;
}

function addRetainedResourceReasons(
  input: AdmissionProjectionInput,
  context: AdmissionProjectionContext | undefined,
  resource: AdmissionProjectionResourceIdentity,
  reasons: AdmissionProjectionReason[],
): void {
  if (!boundedResourceUid(resource.resourceUid)) {
    reasons.push({
      code: "identity_invalid",
      message: "the retained Resource UID must be a bounded non-empty string",
    });
  }
  if (
    !boundedText(resource.tenantId, MAX_IDENTITY_LENGTH) ||
    !boundedText(resource.space, MAX_IDENTITY_LENGTH)
  ) {
    reasons.push({
      code: "identity_invalid",
      message: "the retained Resource tenant and space must be bounded non-empty strings",
    });
  }
  if (resource.formRef !== undefined && !validFormRef(resource.formRef)) {
    reasons.push({ code: "form_ref_invalid", message: "the retained Resource FormRef is invalid" });
  }
  if (resource.packageDigest !== undefined && !validDigest(resource.packageDigest)) {
    reasons.push({
      code: "digest_invalid",
      message: "the retained Resource package digest is invalid",
    });
  }
  if (resource.implementationDigest !== undefined && !validDigest(resource.implementationDigest)) {
    reasons.push({
      code: "digest_invalid",
      message: "the retained Resource implementation digest is invalid",
    });
  }
  if (
    !boundedResourceUid(resource.resourceUid) ||
    !boundedText(resource.tenantId, MAX_IDENTITY_LENGTH) ||
    !boundedText(resource.space, MAX_IDENTITY_LENGTH) ||
    !resource.formRef ||
    !validFormRef(resource.formRef) ||
    !validDigest(resource.packageDigest) ||
    !validDigest(resource.implementationDigest) ||
    !context ||
    context.tenantId !== resource.tenantId ||
    context.space !== resource.space ||
    !input.formRef ||
    !sameFormRef(resource.formRef, input.formRef) ||
    input.packageDigest !== resource.packageDigest ||
    input.implementationDigest !== resource.implementationDigest
  ) {
    reasons.push({
      code: "retained_resource_mismatch",
      message: "the supplied Resource identity does not exactly match the request context",
    });
  }
}

function addRetentionReasons(
  current: AdmissionProjectionCurrentHeads | undefined,
  history: AdmissionProjectionHistory | undefined,
  input: AdmissionProjectionInput,
  resource: AdmissionProjectionResourceIdentity,
  reasons: AdmissionProjectionReason[],
): void {
  const retentions = current?.retentions;
  if (!isDenseArray(retentions)) {
    reasons.push({
      code: "retention_missing",
      message: "the current retained-byte claim is missing",
    });
  } else {
    const exact = retentions.find(
      (retention) =>
        !!retention &&
        validRetentionFact(retention) &&
        sameFormRef(retention.formRef, resource.formRef) &&
        retention.packageDigest === resource.packageDigest &&
        retention.implementationDigest === resource.implementationDigest,
    );
    if (!exact) {
      const packageClaim = retentions.some(
        (retention) =>
          !!retention &&
          validRetentionFact(retention) &&
          sameFormRef(retention.formRef, resource.formRef) &&
          retention.packageDigest === resource.packageDigest,
      );
      reasons.push({
        code: packageClaim ? "retained_package_implementation_mismatch" : "retention_missing",
        message: packageClaim
          ? "the retained-byte claim does not match the exact Resource implementation"
          : "the current retained-byte claim is missing",
      });
    } else if (exact.retained !== true) {
      reasons.push({
        code: "package_purged",
        message: "the exact historical package bytes are no longer retained",
      });
    }
  }

  const packageStatus = retainedPackageStatus(
    current?.install,
    history?.installs,
    input.formRef,
    input.packageDigest,
    resource,
  );
  if (packageStatus === "missing") {
    reasons.push({
      code: "retained_package_missing",
      message: "the exact Resource package is absent from retained install history",
    });
  } else if (packageStatus === "implementation_mismatch") {
    reasons.push({
      code: "retained_package_implementation_mismatch",
      message: "retained install history does not match the Resource implementation",
    });
  }
}

function retainedPackageStatus(
  currentInstall: AdmissionProjectionInstall | null | undefined,
  history: readonly AdmissionProjectionInstall[] | undefined,
  formRef: TakoformV1Alpha3FormRef | undefined,
  packageDigest: AdmissionProjectionDigest | undefined,
  resource: AdmissionProjectionResourceIdentity,
): "matched" | "missing" | "implementation_mismatch" {
  if (!formRef || packageDigest === undefined || packageDigest !== resource.packageDigest)
    return "missing";
  // A sparse history cannot prove which retained install events existed. The
  // cleanup caller also records a fact_invalid reason, but keep this helper
  // fail-closed if it is ever reused independently.
  if (history !== undefined && !isDenseArray(history)) return "missing";
  const candidates = [...(currentInstall ? [currentInstall] : []), ...(history ?? [])].filter(
    (event) =>
      !!event &&
      (event.eventType === "install" || event.eventType === "replace") &&
      sameFormRef(event.formRef, formRef) &&
      event.packageDigest === packageDigest,
  );
  if (candidates.length === 0) return "missing";
  if (candidates.some((event) => !validInstallFact(event))) return "implementation_mismatch";
  if (
    candidates.some(
      (event) =>
        event.implementationDigest === undefined ||
        event.implementationDigest === resource.implementationDigest,
    )
  ) {
    return "matched";
  }
  return "implementation_mismatch";
}

function normalizeAudience(value: unknown): AdmissionProjectionAudience | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "host" && nonEmpty(candidate.hostId)) {
    return { kind: "host", hostId: candidate.hostId };
  }
  if (candidate.kind === "tenant" && nonEmpty(candidate.tenantId)) {
    return { kind: "tenant", tenantId: candidate.tenantId };
  }
  if (candidate.kind === "space" && nonEmpty(candidate.tenantId) && nonEmpty(candidate.space)) {
    return { kind: "space", tenantId: candidate.tenantId, space: candidate.space };
  }
  if (
    candidate.kind === "principal" &&
    nonEmpty(candidate.tenantId) &&
    nonEmpty(candidate.principalId)
  ) {
    return { kind: "principal", tenantId: candidate.tenantId, principalId: candidate.principalId };
  }
  return null;
}

function audienceMatches(
  audience: AdmissionProjectionAudience,
  context: AdmissionProjectionContext,
): boolean {
  switch (audience.kind) {
    case "host":
      return context.hostId === audience.hostId;
    case "tenant":
      return context.tenantId === audience.tenantId;
    case "space":
      return context.tenantId === audience.tenantId && context.space === audience.space;
    case "principal":
      return context.tenantId === audience.tenantId && context.principalId === audience.principalId;
  }
}

function activationHeadKey(
  activation: AdmissionProjectionActivation,
  audience: AdmissionProjectionAudience,
): string {
  // The durable activation chain is keyed by FormRef + package + audience;
  // implementation is payload, not part of head identity.  Two equal keys
  // therefore indicate a corrupt/ambiguous current head regardless of input
  // ordering (including when only implementation differs).
  return JSON.stringify([
    activation.formRef.apiVersion,
    activation.formRef.kind,
    activation.formRef.definitionVersion,
    activation.formRef.schemaDigest,
    activation.packageDigest,
    audience.kind,
    audience.kind === "host"
      ? audience.hostId
      : audience.kind === "tenant"
        ? audience.tenantId
        : audience.kind === "space"
          ? audience.tenantId
          : audience.tenantId,
    audience.kind === "space"
      ? audience.space
      : audience.kind === "principal"
        ? audience.principalId
        : undefined,
  ]);
}

function formRefKey(formRef: TakoformV1Alpha3FormRef | undefined): string {
  if (!formRef) return "<missing-form-ref>";
  return `${formRef.apiVersion}|${formRef.kind}|${formRef.definitionVersion}|${formRef.schemaDigest}`;
}

function cloneAudience(audience: AdmissionProjectionAudience): AdmissionProjectionAudience {
  switch (audience.kind) {
    case "host":
      return { kind: "host", hostId: audience.hostId };
    case "tenant":
      return { kind: "tenant", tenantId: audience.tenantId };
    case "space":
      return { kind: "space", tenantId: audience.tenantId, space: audience.space };
    case "principal":
      return { kind: "principal", tenantId: audience.tenantId, principalId: audience.principalId };
  }
}

function sameFormRef(
  left: TakoformV1Alpha3FormRef | undefined,
  right: TakoformV1Alpha3FormRef | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isFactObject<T>(value: T): value is T & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedResourceUid(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= MAX_RESOURCE_UID_LENGTH;
}

function positiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Array iteration helpers (`every`, `some`, `find`, and `for...of`) skip holes
 * or materialize them inconsistently. Authority facts must therefore carry
 * an own element at every index before any reducer can inspect their values.
 */
function isDenseArray<T = unknown>(value: unknown): value is readonly T[] {
  if (!Array.isArray(value)) return false;
  // Count and validate own indexed properties rather than probing every index:
  // a hostile sparse array may advertise a huge length with only one element.
  const ownElementNames = Object.getOwnPropertyNames(value).filter((name) => name !== "length");
  if (ownElementNames.length !== value.length) return false;
  return ownElementNames.every((name) => {
    const index = Number(name);
    return (
      Number.isSafeInteger(index) && index >= 0 && index < value.length && String(index) === name
    );
  });
}

function validDenseArray<T>(
  value: unknown,
  isElementValid: (element: unknown) => element is T,
): value is readonly T[] {
  return isDenseArray(value) && value.every((element) => isElementValid(element));
}

function validDigest(value: unknown): value is AdmissionProjectionDigest {
  try {
    validateDigest(value);
    return true;
  } catch {
    return false;
  }
}

function validFormRef(value: unknown): value is TakoformV1Alpha3FormRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "apiVersion" ||
    keys[1] !== "definitionVersion" ||
    keys[2] !== "kind" ||
    keys[3] !== "schemaDigest"
  ) {
    return false;
  }
  try {
    validateFormRef(value as TakoformV1Alpha3FormRef);
    return true;
  } catch {
    return false;
  }
}

function validPublisherFact(value: AdmissionProjectionPublisher): boolean {
  return (
    boundedText(value.publisherKey, MAX_IDENTITY_LENGTH) &&
    (value.eventType === "allow" || value.eventType === "rotate" || value.eventType === "deny") &&
    validDigest(value.policyDigest) &&
    validDigest(value.eventDigest)
  );
}

function validCheckpointFact(value: AdmissionProjectionCheckpoint): boolean {
  return (
    boundedText(value.publisherKey, MAX_IDENTITY_LENGTH) &&
    validDigest(value.policyDigest) &&
    validDigest(value.policyEventDigest) &&
    positiveSequence(value.sequence) &&
    validDigest(value.checkpointDigest) &&
    validDigest(value.eventDigest) &&
    typeof value.verified === "boolean" &&
    typeof value.stale === "boolean" &&
    validDenseArray(value.revokedPackageDigests, validDigest)
  );
}

function validInstallFact(value: AdmissionProjectionInstall): boolean {
  return (
    validFormRef(value.formRef) &&
    validDigest(value.packageDigest) &&
    boundedText(value.publisherKey, MAX_IDENTITY_LENGTH) &&
    (value.eventType === "install" ||
      value.eventType === "replace" ||
      value.eventType === "uninstall") &&
    (value.implementationDigest === undefined || validDigest(value.implementationDigest))
  );
}

function validSupportFact(value: AdmissionProjectionSupport): boolean {
  return (
    validFormRef(value.formRef) &&
    validDigest(value.packageDigest) &&
    validDigest(value.implementationDigest) &&
    typeof value.supported === "boolean" &&
    validDenseArray(value.operations, validFormOperation)
  );
}

function validFormOperation(value: unknown): value is TakoformOperation {
  return typeof value === "string" && FORM_OPERATIONS.has(value as TakoformOperation);
}

function validActivationFact(value: AdmissionProjectionActivation): boolean {
  return (
    validFormRef(value.formRef) &&
    validDigest(value.packageDigest) &&
    validDigest(value.implementationDigest) &&
    typeof value.active === "boolean"
  );
}

function validRetentionFact(value: AdmissionProjectionRetention): boolean {
  return (
    validFormRef(value.formRef) &&
    validDigest(value.packageDigest) &&
    validDigest(value.implementationDigest) &&
    typeof value.retained === "boolean"
  );
}

function validAudienceFact(value: AdmissionProjectionAudience): boolean {
  switch (value.kind) {
    case "host":
      return boundedText(value.hostId, MAX_IDENTITY_LENGTH);
    case "tenant":
      return boundedText(value.tenantId, MAX_IDENTITY_LENGTH);
    case "space":
      return (
        boundedText(value.tenantId, MAX_IDENTITY_LENGTH) &&
        boundedText(value.space, MAX_IDENTITY_LENGTH)
      );
    case "principal":
      return (
        boundedText(value.tenantId, MAX_IDENTITY_LENGTH) &&
        boundedText(value.principalId, MAX_IDENTITY_LENGTH)
      );
  }
}

function freezeReasons(
  reasons: readonly AdmissionProjectionReason[],
): readonly AdmissionProjectionReason[] {
  return reasons.map((reason) => ({ code: reason.code, message: reason.message }));
}
