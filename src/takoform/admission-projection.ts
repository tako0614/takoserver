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
  /**
   * Host adapters must pass bounded plain data deserialized from an immutable
   * record (no accessors, class instances, or live/proxy-backed values).
   * Canonicalize database/JSON results before calling this pure projection.
   */
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
 * Authority arrays are intentionally bounded before any element enumeration.
 * A thousand records is ample for one current-head projection while keeping a
 * hostile sparse length from turning a pure decision into unbounded work.
 */
const MAX_AUTHORITY_ARRAY_LENGTH = 1024;

/** Private validation sentinel; its identity must never depend on an error message. */
class DuplicateActivationHeadError extends TypeError {
  constructor() {
    super("duplicate current activation head");
  }
}

/**
 * Computes current-effective admission from immutable facts supplied by the
 * caller.  No database, clock, package bytes, or mutable registry is read.
 * Current heads are authoritative for new mutations; history is consulted
 * only to prove that an exact retained Resource can still be cleaned up.
 */
export function evaluateAdmissionProjection(
  input: AdmissionProjectionInput,
): AdmissionProjectionDecision {
  // Materialize caller-supplied records exactly once.  Semantic validation and
  // every later helper consume only this owned, recursively checked snapshot;
  // no live caller object is reread after this boundary.
  const facts = materializeAdmissionInput(input);
  if (!facts) {
    return deniedDecision(
      "mutation",
      "fact_invalid",
      "the projection input is not plain bounded data",
    );
  }
  let operation: AdmissionProjectionOperation;
  try {
    operation = facts.operation;
  } catch {
    return deniedDecision("mutation", "fact_invalid", "authority fact inspection failed closed");
  }
  if (!MUTATION_OPERATIONS.has(operation) && !CLEANUP_OPERATIONS.has(operation)) {
    throw new TypeError("admission projection operation is invalid");
  }
  const mode = CLEANUP_OPERATIONS.has(operation) ? "retained-cleanup" : "mutation";

  try {
    const shape = inspectInputShape(facts);
    if (!shape.valid) {
      return deniedDecision(mode, "fact_invalid", "the projection input is not plain bounded data");
    }
    if (!validateInputShape(facts)) {
      return deniedDecision(
        mode,
        "fact_invalid",
        "the projection input contains an invalid authority fact",
      );
    }
    const reasons: AdmissionProjectionReason[] = [];
    const context = facts.context;
    const current = facts.current;
    const history = facts.history;

    addIdentityReasons(facts, context, reasons);
    addRequestFactValidityReasons(facts, context, reasons);

    if (mode === "retained-cleanup") {
      addCleanupArrayElementValidityReasons(current, history, reasons);
      const resource = facts.resource;
      if (!resource) {
        reasons.push({
          code: "retained_resource_required",
          message: "observe, delete, and evacuate require an exact retained Resource identity",
        });
      } else {
        addRetainedResourceReasons(facts, context, resource, reasons);
        addRetentionReasons(current, history, facts, resource, reasons);
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
    addActivationArrayElementValidityReasons(current, facts.formRef, facts.packageDigest, reasons);

    const publisher = current?.publisher ?? null;
    const checkpoint = current?.checkpoint ?? null;
    const install = current?.install ?? null;
    const support = current?.support ?? null;

    addPublisherReasons(publisher, install, reasons);
    addCheckpointReasons(publisher, checkpoint, facts.packageDigest, reasons);
    addInstallReasons(
      install,
      facts.formRef,
      facts.packageDigest,
      facts.implementationDigest,
      reasons,
    );
    addSupportReasons(
      support,
      facts.formRef,
      facts.packageDigest,
      facts.implementationDigest,
      operation,
      reasons,
    );

    const activation = effectiveActivation(
      current?.activations,
      context,
      facts.formRef,
      facts.packageDigest,
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
        facts.implementationDigest === undefined ||
        activation.implementationDigest !== facts.implementationDigest
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
  } catch (error) {
    if (error instanceof DuplicateActivationHeadError) {
      throw error;
    }
    return deniedDecision(mode, "fact_invalid", "authority fact inspection failed closed");
  }
}

function deniedDecision(
  mode: "mutation" | "retained-cleanup",
  code: AdmissionProjectionReasonCode,
  message: string,
): AdmissionProjectionDecision {
  return { allowed: false, mode, reasons: [{ code, message }] };
}

function inspectInputShape(input: AdmissionProjectionInput): { readonly valid: boolean } {
  try {
    if (!isPlainDataObject(input)) return { valid: false };
    const context = input.context;
    const formRef = input.formRef;
    const current = input.current;
    const history = input.history;
    const resource = input.resource;
    const nestedPlain =
      (context === undefined || isPlainDataObject(context)) &&
      (formRef === undefined || isPlainDataObject(formRef)) &&
      (current === undefined || current === null || isPlainDataObject(current)) &&
      (history === undefined || history === null || isPlainDataObject(history)) &&
      (resource === undefined || isPlainDataObject(resource));
    if (!nestedPlain) {
      return { valid: false };
    }
    if (current !== undefined && current !== null) {
      const activations = current.activations;
      const retentions = current.retentions;
      if (
        (activations !== undefined && !isPlainAuthorityArray(activations)) ||
        (retentions !== undefined && !isPlainAuthorityArray(retentions))
      ) {
        return { valid: false };
      }
      for (const value of [
        current.publisher,
        current.checkpoint,
        current.install,
        current.support,
      ]) {
        if (value !== undefined && value !== null && !isPlainDataObject(value)) {
          return { valid: false };
        }
      }
      if (
        (activations !== undefined && !hasPlainFactElements(activations)) ||
        (retentions !== undefined && !hasPlainFactElements(retentions))
      ) {
        return { valid: false };
      }
    }
    if (history !== undefined && history !== null && !validateHistoryArrays(history)) {
      return { valid: false };
    }
    return { valid: true };
  } catch {
    return { valid: false };
  }
}

/**
 * Take one owned snapshot of the complete authority input before semantic
 * validation.  The projection is intentionally not a Proxy sandbox: a
 * transparent Proxy cannot be identified in JavaScript.  Instead, every
 * property/element is inspected through a descriptor once, recursively
 * copied into plain frozen data, and all later consumers read that snapshot.
 * Trap failures, accessors, cycles, unsupported values, and malformed arrays
 * fail closed at this boundary.
 */
function materializeAdmissionInput(value: unknown): AdmissionProjectionInput | null {
  try {
    const snapshots = new WeakMap<object, object>();
    const active = new WeakSet<object>();
    const snapshot = materializeAuthorityValue(value, snapshots, active);
    if (!isPlainDataObject(snapshot)) return null;
    return snapshot as unknown as AdmissionProjectionInput;
  } catch {
    return null;
  }
}

function materializeAuthorityValue(
  value: unknown,
  snapshots: WeakMap<object, object>,
  active: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Number.isFinite(value)) return value;
      throw new TypeError("authority fact number is not finite");
    case "object":
      break;
    default:
      throw new TypeError("authority fact contains an unsupported value");
  }

  const cached = snapshots.get(value);
  if (cached !== undefined) return cached;
  if (active.has(value)) throw new TypeError("cyclic authority fact");
  active.add(value);
  try {
    const snapshot = Array.isArray(value)
      ? materializeAuthorityArray(value, snapshots, active)
      : materializeAuthorityObject(value, snapshots, active);
    snapshots.set(value, snapshot);
    return snapshot;
  } finally {
    active.delete(value);
  }
}

function materializeAuthorityObject(
  value: object,
  snapshots: WeakMap<object, object>,
  active: WeakSet<object>,
): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("authority fact object prototype is not plain");
  }
  const ownKeys = Reflect.ownKeys(value);
  const snapshot = Object.create(prototype === null ? null : Object.prototype) as Record<
    string,
    unknown
  >;
  for (const key of ownKeys) {
    if (typeof key !== "string") throw new TypeError("authority fact contains a symbol key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("authority fact contains an accessor");
    }
    const child = materializeAuthorityValue(descriptor.value, snapshots, active);
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: descriptor.enumerable === true,
      value: child,
      writable: true,
    });
  }
  return Object.freeze(snapshot);
}

function materializeAuthorityArray(
  value: object,
  snapshots: WeakMap<object, object>,
  active: WeakSet<object>,
): readonly unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("authority fact array prototype is not plain");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    throw new TypeError("authority fact array length is not data");
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_AUTHORITY_ARRAY_LENGTH) {
    throw new TypeError("authority fact array length is out of bounds");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) {
    throw new TypeError("authority fact array is sparse or has extra keys");
  }
  const indexedKeys = new Set<string>();
  for (const key of ownKeys) {
    if (typeof key !== "string") throw new TypeError("authority fact array contains a symbol key");
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
      throw new TypeError("authority fact array contains an invalid key");
    }
    indexedKeys.add(key);
  }
  if (indexedKeys.size !== length) {
    throw new TypeError("authority fact array is sparse");
  }
  const snapshot = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("authority fact array contains an accessor");
    }
    snapshot[index] = materializeAuthorityValue(descriptor.value, snapshots, active);
  }
  return Object.freeze(snapshot);
}

function validateInputShape(input: AdmissionProjectionInput): boolean {
  try {
    const current = input.current;
    if (current !== undefined && current !== null) {
      validateActivationHeadUniqueness(current.activations);
      validateRetentionHeadUniqueness(current.retentions);
    }
    return true;
  } catch (error) {
    if (error instanceof DuplicateActivationHeadError) throw error;
    return false;
  }
}

function validateActivationHeadUniqueness(
  activations: readonly AdmissionProjectionActivation[] | undefined,
): void {
  const elements = authorityArraySnapshot(activations);
  if (!elements) return;
  const seen = new Set<string>();
  for (const activation of elements) {
    if (!validActivationFact(activation)) continue;
    const audience = normalizeAudience(activation.audience);
    if (!audience) continue;
    const key = activationHeadKey(activation, audience);
    if (seen.has(key)) throw new DuplicateActivationHeadError();
    seen.add(key);
  }
}

function validateRetentionHeadUniqueness(
  retentions: readonly AdmissionProjectionRetention[] | undefined,
): void {
  const elements = authorityArraySnapshot(retentions);
  if (!elements) return;
  const seen = new Set<string>();
  for (const retention of elements) {
    if (!validRetentionFact(retention)) continue;
    const key = `${formRefKey(retention?.formRef)}|${retention?.packageDigest}|${retention?.implementationDigest}`;
    if (seen.has(key)) throw new TypeError("duplicate current retention head");
    seen.add(key);
  }
}

function validateHistoryArrays(history: AdmissionProjectionHistory): boolean {
  const arrays: readonly unknown[] = [
    history.publishers,
    history.checkpoints,
    history.installs,
    history.supports,
    history.activations,
  ];
  let result = false;
  try {
    result = arrays.every(
      (value) => value === undefined || validAuthorityArray(value, isFactObject),
    );
  } catch {
    return false;
  }
  return result;
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
  formRef: TakoformV1Alpha3FormRef | undefined,
  packageDigest: AdmissionProjectionDigest | undefined,
  reasons: AdmissionProjectionReason[],
): void {
  const activations = current?.activations;
  if (activations === undefined) return;
  const elements = authorityArraySnapshot(activations);
  if (
    !elements ||
    elements.some((activation) => {
      if (!isFactObject(activation)) return true;
      const candidate = activation as unknown as AdmissionProjectionActivation;
      // A malformed head on another Form/package cannot affect this
      // request once its exact identity is valid and has been filtered.
      if (!validFormRef(candidate.formRef)) return true;
      if (!formRef || !sameFormRef(candidate.formRef, formRef)) return false;
      if (!validDigest(candidate.packageDigest)) return true;
      if (packageDigest === undefined || candidate.packageDigest !== packageDigest) return false;
      return !validActivationFact(candidate);
    })
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
  const retentionElements =
    retentions === undefined ? undefined : authorityArraySnapshot(retentions);
  if (
    retentions !== undefined &&
    (!retentionElements ||
      retentionElements.some(
        (retention) =>
          !isFactObject(retention) ||
          !validRetentionFact(retention as unknown as AdmissionProjectionRetention),
      ))
  ) {
    reasons.push({
      code: "fact_invalid",
      message: "the current retained-byte claim list contains a malformed element",
    });
  }
  const installs = history?.installs;
  const installElements = installs === undefined ? undefined : authorityArraySnapshot(installs);
  if (
    installs !== undefined &&
    (!installElements ||
      installElements.some(
        (install) =>
          !isFactObject(install) ||
          !validInstallFact(install as unknown as AdmissionProjectionInstall),
      ))
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
  if (!validPublisherFact(publisher)) return;
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
  if (install && validInstallFact(install) && install.publisherKey !== publisher.publisherKey) {
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
  const rawCheckpoint = checkpoint as unknown;
  if (!validCheckpointFact(rawCheckpoint)) {
    if (isPlainDataObject(rawCheckpoint)) {
      const malformed = rawCheckpoint as unknown as AdmissionProjectionCheckpoint;
      if (!positiveSequence(malformed.sequence)) {
        reasons.push({
          code: "checkpoint_sequence_invalid",
          message: "the current revocation checkpoint sequence is invalid",
        });
      }
      const revokedPackageDigests = authorityArraySnapshot(malformed.revokedPackageDigests);
      if (!revokedPackageDigests?.every((digest) => validDigest(digest))) {
        reasons.push({
          code: "checkpoint_revocation_unknown",
          message: "the checkpoint does not provide an explicit revocation set",
        });
      }
    }
    return;
  }
  if (publisher && !validPublisherFact(publisher)) return;
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
  const revokedPackageDigests = authorityArraySnapshot(checkpoint.revokedPackageDigests);
  if (
    !revokedPackageDigests?.every((digest): digest is AdmissionProjectionDigest =>
      validDigest(digest),
    )
  ) {
    reasons.push({
      code: "checkpoint_revocation_unknown",
      message: "the checkpoint does not provide an explicit revocation set",
    });
  } else if (packageDigest !== undefined && revokedPackageDigests.includes(packageDigest)) {
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
  if (!validInstallFact(install)) return;
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
  const rawSupport = support as unknown;
  if (!validSupportFact(rawSupport)) {
    if (isPlainDataObject(rawSupport)) {
      const malformed = rawSupport as unknown as AdmissionProjectionSupport;
      if (!validDenseArray(malformed.operations, validFormOperation)) {
        reasons.push({
          code: "support_operations_invalid",
          message: "implementation support does not declare an operation set",
        });
      }
    }
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
  const operations = authorityArraySnapshot(support.operations);
  if (
    !operations?.every((operation): operation is TakoformOperation => validFormOperation(operation))
  ) {
    reasons.push({
      code: "support_operations_invalid",
      message: "implementation support does not declare an operation set",
    });
  } else if (!operations.includes(operation as TakoformOperation)) {
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
  const elements = authorityArraySnapshot(activations);
  if (!elements || elements.length === 0 || !context || !formRef || packageDigest === undefined) {
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
  // The snapshot above has already bounded/densely inspected the array.  Do
  // not enumerate the caller-owned array itself: a sparse/oversized/proxy
  // array must never reach this reduction path.
  for (const candidate of elements) {
    if (!validActivationFact(candidate)) continue;
    const activation = candidate;
    // Unknown audience values on another Form/package are irrelevant to this
    // request.  Validate/filter the exact identity first so an unrelated
    // corrupt head cannot deny an otherwise eligible Resource.
    if (!sameFormRef(activation.formRef, formRef) || activation.packageDigest !== packageDigest) {
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
  if (!validResourceIdentity(resource)) {
    reasons.push({
      code: "identity_invalid",
      message: "the retained Resource identity contains malformed or accessor-backed facts",
    });
    return;
  }
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

function validResourceIdentity(value: unknown): value is AdmissionProjectionResourceIdentity {
  if (!isPlainDataObject(value)) return false;
  const resource = value as unknown as AdmissionProjectionResourceIdentity;
  return (
    boundedResourceUid(resource.resourceUid) &&
    boundedText(resource.tenantId, MAX_IDENTITY_LENGTH) &&
    boundedText(resource.space, MAX_IDENTITY_LENGTH) &&
    validFormRef(resource.formRef) &&
    validDigest(resource.packageDigest) &&
    validDigest(resource.implementationDigest)
  );
}

function addRetentionReasons(
  current: AdmissionProjectionCurrentHeads | undefined,
  history: AdmissionProjectionHistory | undefined,
  input: AdmissionProjectionInput,
  resource: AdmissionProjectionResourceIdentity,
  reasons: AdmissionProjectionReason[],
): void {
  const retentions = current?.retentions;
  const retentionElements = authorityArraySnapshot(retentions);
  if (!retentionElements) {
    reasons.push({
      code: "retention_missing",
      message: "the current retained-byte claim is missing",
    });
  } else {
    const exact = retentionElements.find((candidate) => {
      if (!validRetentionFact(candidate)) return false;
      const retention = candidate;
      return (
        sameFormRef(retention.formRef, resource.formRef) &&
        retention.packageDigest === resource.packageDigest &&
        retention.implementationDigest === resource.implementationDigest
      );
    });
    if (!exact) {
      const packageClaim = retentionElements.some((candidate) => {
        if (!validRetentionFact(candidate)) return false;
        const retention = candidate;
        return (
          sameFormRef(retention.formRef, resource.formRef) &&
          retention.packageDigest === resource.packageDigest
        );
      });
      reasons.push({
        code: packageClaim ? "retained_package_implementation_mismatch" : "retention_missing",
        message: packageClaim
          ? "the retained-byte claim does not match the exact Resource implementation"
          : "the current retained-byte claim is missing",
      });
    } else if ((exact as AdmissionProjectionRetention).retained !== true) {
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
  // A sparse/oversized/proxy history cannot prove which retained install
  // events existed. The cleanup caller records fact_invalid; keep this helper
  // fail-closed if it is ever reused independently.
  const historyElements = history === undefined ? [] : authorityArraySnapshot(history);
  if (!historyElements) return "missing";
  if (
    currentInstall !== undefined &&
    currentInstall !== null &&
    !validInstallFact(currentInstall)
  ) {
    return "implementation_mismatch";
  }
  const candidates: AdmissionProjectionInstall[] = [];
  for (const event of [
    ...(currentInstall === undefined || currentInstall === null ? [] : [currentInstall]),
    ...historyElements,
  ]) {
    if (!validInstallFact(event)) return "implementation_mismatch";
    if (
      (event.eventType === "install" || event.eventType === "replace") &&
      sameFormRef(event.formRef, formRef) &&
      event.packageDigest === packageDigest
    ) {
      candidates.push(event);
    }
  }
  if (candidates.length === 0) return "missing";
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
  if (!isPlainDataObject(value)) return null;
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
  return isPlainDataObject(value);
}

function boundedResourceUid(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= MAX_RESOURCE_UID_LENGTH;
}

function positiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The projection boundary is a bounded plain-data boundary.  A Host adapter
 * must canonicalize database/JSON values before calling it; accessors and
 * class/proxy-backed records are rejected before any authority field is read.
 * JavaScript cannot reliably identify a transparent Proxy, so this function
 * does not promise to sandbox arbitrary Proxy code: descriptor trap failures
 * are caught and deny, while Host canonicalization remains mandatory.
 */
function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.values(descriptors).every(
      (descriptor) =>
        "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined,
    );
    return result;
  } catch {
    return false;
  }
}

/**
 * Array iteration helpers (`every`, `some`, `find`, and `for...of`) skip holes
 * or materialize them inconsistently. Authority facts must therefore carry
 * an own data element at every index, have no extra properties, and stay below
 * the explicit bound before any reducer can inspect their values.
 */
function authorityArraySnapshot(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype) {
      return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) {
      return null;
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_AUTHORITY_ARRAY_LENGTH) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1) {
      return null;
    }
    const indexedKeys = new Set<string>();
    for (const key of ownKeys) {
      if (typeof key !== "string") return null;
      if (key === "length") continue;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
        return null;
      }
      indexedKeys.add(key);
    }
    if (indexedKeys.size !== length) {
      return null;
    }
    const elements = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!indexedKeys.has(key)) {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        return null;
      }
      elements[index] = descriptor.value;
    }
    return elements;
  } catch {
    return null;
  }
}

function isPlainAuthorityArray(value: unknown): value is readonly unknown[] {
  return authorityArraySnapshot(value) !== null;
}

function hasPlainFactElements(value: unknown): boolean {
  const elements = authorityArraySnapshot(value);
  return elements?.every((element) => isFactObject(element)) ?? false;
}

function validDenseArray<T>(
  value: unknown,
  isElementValid: (element: unknown) => element is T,
): value is readonly T[] {
  const elements = authorityArraySnapshot(value);
  return elements?.every((element) => isElementValid(element)) ?? false;
}

function validAuthorityArray(
  value: unknown,
  isElementValid: (element: unknown) => boolean,
): boolean {
  const elements = authorityArraySnapshot(value);
  return elements?.every((element) => isElementValid(element)) ?? false;
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
  if (!isPlainDataObject(value)) return false;
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
    validateFormRef(value as unknown as TakoformV1Alpha3FormRef);
    return true;
  } catch {
    return false;
  }
}

function validPublisherFact(value: unknown): value is AdmissionProjectionPublisher {
  if (!isPlainDataObject(value)) return false;
  const fact = value as unknown as AdmissionProjectionPublisher;
  return (
    boundedText(fact.publisherKey, MAX_IDENTITY_LENGTH) &&
    (fact.eventType === "allow" || fact.eventType === "rotate" || fact.eventType === "deny") &&
    validDigest(fact.policyDigest) &&
    validDigest(fact.eventDigest)
  );
}

function validCheckpointFact(value: unknown): value is AdmissionProjectionCheckpoint {
  if (!isPlainDataObject(value)) return false;
  const fact = value as unknown as AdmissionProjectionCheckpoint;
  return (
    boundedText(fact.publisherKey, MAX_IDENTITY_LENGTH) &&
    validDigest(fact.policyDigest) &&
    validDigest(fact.policyEventDigest) &&
    positiveSequence(fact.sequence) &&
    validDigest(fact.checkpointDigest) &&
    validDigest(fact.eventDigest) &&
    typeof fact.verified === "boolean" &&
    typeof fact.stale === "boolean" &&
    validDenseArray(fact.revokedPackageDigests, validDigest)
  );
}

function validInstallFact(value: unknown): value is AdmissionProjectionInstall {
  if (!isPlainDataObject(value)) return false;
  const fact = value as unknown as AdmissionProjectionInstall;
  return (
    validFormRef(fact.formRef) &&
    validDigest(fact.packageDigest) &&
    boundedText(fact.publisherKey, MAX_IDENTITY_LENGTH) &&
    (fact.eventType === "install" ||
      fact.eventType === "replace" ||
      fact.eventType === "uninstall") &&
    (fact.implementationDigest === undefined || validDigest(fact.implementationDigest))
  );
}

function validSupportFact(value: unknown): value is AdmissionProjectionSupport {
  if (!isPlainDataObject(value)) return false;
  const fact = value as unknown as AdmissionProjectionSupport;
  return (
    validFormRef(fact.formRef) &&
    validDigest(fact.packageDigest) &&
    validDigest(fact.implementationDigest) &&
    typeof fact.supported === "boolean" &&
    validDenseArray(fact.operations, validFormOperation)
  );
}

function validFormOperation(value: unknown): value is TakoformOperation {
  return typeof value === "string" && FORM_OPERATIONS.has(value as TakoformOperation);
}

function validActivationFact(value: unknown): value is AdmissionProjectionActivation {
  if (!isPlainDataObject(value)) return false;
  const fact = value as unknown as AdmissionProjectionActivation;
  return (
    validFormRef(fact.formRef) &&
    validDigest(fact.packageDigest) &&
    validDigest(fact.implementationDigest) &&
    typeof fact.active === "boolean"
  );
}

function validRetentionFact(value: unknown): value is AdmissionProjectionRetention {
  if (!isPlainDataObject(value)) return false;
  const fact = value as unknown as AdmissionProjectionRetention;
  return (
    validFormRef(fact.formRef) &&
    validDigest(fact.packageDigest) &&
    validDigest(fact.implementationDigest) &&
    typeof fact.retained === "boolean"
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
