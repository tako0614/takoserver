import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import { canonicalDigest, canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { FormPackageInput } from "./form-packages.ts";
import { isFormGroup, validateFormRef } from "./forms.ts";

export type AdmissionDigest = `sha256:${string}`;

/** The zero predecessor makes the first event in every chain explicit. */
export const ADMISSION_GENESIS_DIGEST = `sha256:${"0".repeat(64)}` as AdmissionDigest;

/** Exact immutable source identity bound into a publisher policy. */
export interface AdmissionSourcePin {
  readonly sourceCommit: string;
  readonly workflowCommit: string;
  readonly repositoryIdentifier: string;
  readonly ownerIdentifier: string;
}

/** A Host-local reverse-DNS grant. It is not a global DNS ownership claim. */
export interface AdmissionNamespaceGrant {
  readonly group: string;
  readonly namespaceGrantDigest: AdmissionDigest;
}

/** Exact policy/signature inputs shared by official-like and external values. */
export interface AdmissionPublisherPin extends AdmissionSourcePin, AdmissionNamespaceGrant {
  readonly publisherKey?: string;
  readonly policyDigest: AdmissionDigest;
  readonly policy?: Record<string, unknown>;
  readonly oidcIssuer: string;
  readonly sourceRepository: string;
  readonly workflow: string;
  readonly ref: string;
  readonly identity: string;
  readonly trustedRootDigest: AdmissionDigest;
}

export interface AdmissionSignaturePin {
  readonly subjectDigest: AdmissionDigest;
  readonly bundleDigest: AdmissionDigest;
  readonly trustedRootDigest: AdmissionDigest;
  readonly tlogThreshold?: number;
}

export interface AdmissionRevocationPin {
  readonly sequence: number;
  readonly checkpointDigest: AdmissionDigest;
  readonly entriesDigest: AdmissionDigest;
  readonly revoked?: boolean;
}

export interface AdmissionPackageReport {
  readonly packageDigest: AdmissionDigest;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly fileCount: number;
  readonly payloadBytes: number;
}

/**
 * The report is evidence, not authority.  In particular, it has no `official`
 * field and cannot be used as an install command after JSON round-tripping.
 */
export interface AdmissionReport {
  readonly status: "admitted" | "denied";
  readonly operation: "install" | "replace";
  readonly package: AdmissionPackageReport;
  readonly publisher: {
    readonly policyDigest: AdmissionDigest;
    readonly oidcIssuer: string;
    readonly sourceRepository: string;
    readonly workflow: string;
    readonly ref: string;
    readonly identity: string;
  };
  readonly source: AdmissionSourcePin;
  readonly namespace: AdmissionNamespaceGrant;
  readonly signature: AdmissionSignaturePin;
  readonly revocation: AdmissionRevocationPin;
  readonly checks: readonly { readonly code: string; readonly passed: boolean }[];
}

/** Claims copied from a successful Core evaluator, never from JSON at commit. */
export interface AdmissionHandleClaims {
  readonly operation: "install" | "replace";
  readonly packageDigest: AdmissionDigest;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly publisherKey: string;
  readonly publisher: AdmissionPublisherPin;
  readonly policyEventDigest: AdmissionDigest;
  readonly checkpointSequence: number;
  readonly checkpointDigest: AdmissionDigest;
  readonly checkpointEventDigest: AdmissionDigest;
  /** The exact evaluator report is part of the opaque claims.  The Host
   * computes its digest from this cloned body when persisting the event; a
   * caller cannot supply a detached digest. */
  readonly report: AdmissionReport;
}

/**
 * Opaque in-process authority issued by the pinned Core adapter.  The private
 * WeakMap below is the runtime check; a report, object spread, or structured
 * clone has no entry and is rejected by the Host store.
 */
export interface AdmissionHandle {
  readonly __admissionHandle?: never;
}

export interface AdmissionHandleIssuer {
  issue(claims: AdmissionHandleClaims): AdmissionHandle;
  inspect(handle: unknown): AdmissionHandleClaims | null;
}

export function createAdmissionHandleIssuer(): AdmissionHandleIssuer {
  const handles = new WeakMap<object, AdmissionHandleClaims>();
  return {
    issue(claims): AdmissionHandle {
      validateHandleClaims(claims);
      const handle = Object.freeze({});
      try {
        handles.set(handle, structuredClone(claims));
      } catch {
        throw new FormAdmissionError("invalid_handle", "handle claims are not cloneable");
      }
      return handle;
    },
    inspect(handle): AdmissionHandleClaims | null {
      if (typeof handle !== "object" || handle === null) return null;
      const claims = handles.get(handle);
      return claims ? structuredClone(claims) : null;
    },
  };
}

export type AdmissionEventState =
  | "allow"
  | "rotate"
  | "deny"
  | "checkpoint"
  | "install"
  | "replace"
  | "uninstall"
  | "purge-pending"
  | "purged"
  | "supported"
  | "unsupported"
  | "active"
  | "inactive"
  | "pending"
  | "settled";

export interface AdmissionCommandMetadata {
  readonly kind?: string;
  readonly type?: string;
  readonly actor: string;
  readonly reason: string;
  /** Optional injected epoch milliseconds; otherwise the Host clock is used. */
  readonly eventAt?: number;
  readonly timestamp?: number;
  readonly predecessorDigest?: AdmissionDigest;
}

export interface AllowPublisher extends AdmissionCommandMetadata {
  readonly kind?: "AllowPublisher";
  readonly type?: "AllowPublisher";
  readonly publisher: AdmissionPublisherPin;
}

export interface RotatePublisher extends AdmissionCommandMetadata {
  readonly kind?: "RotatePublisher";
  readonly type?: "RotatePublisher";
  readonly publisher: AdmissionPublisherPin;
}

export interface DenyPublisher extends AdmissionCommandMetadata {
  readonly kind?: "DenyPublisher";
  readonly type?: "DenyPublisher";
  readonly publisher: AdmissionPublisherPin;
}

export interface AppendCheckpoint extends AdmissionCommandMetadata {
  readonly kind?: "AppendCheckpoint";
  readonly type?: "AppendCheckpoint";
  readonly publisherKey: string;
  readonly policyDigest: AdmissionDigest;
  readonly policyEventDigest: AdmissionDigest;
  readonly sequence: number;
  readonly checkpointDigest: AdmissionDigest;
  readonly entriesDigest: AdmissionDigest;
  readonly previousCheckpointDigest: AdmissionDigest;
  readonly revokedPackageDigests?: readonly AdmissionDigest[];
}

export interface InstallPackage extends AdmissionCommandMetadata {
  readonly kind?: "InstallPackage";
  readonly type?: "InstallPackage";
  readonly package: FormPackageInput;
  readonly handle: AdmissionHandle;
  readonly implementationDigest?: AdmissionDigest;
}

export interface ReplacePackage extends AdmissionCommandMetadata {
  readonly kind?: "ReplacePackage";
  readonly type?: "ReplacePackage";
  readonly package: FormPackageInput;
  readonly handle: AdmissionHandle;
  readonly implementationDigest?: AdmissionDigest;
}

export interface UninstallPackage extends AdmissionCommandMetadata {
  readonly kind?: "UninstallPackage";
  readonly type?: "UninstallPackage";
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionDigest;
}

export interface PurgePackage extends AdmissionCommandMetadata {
  readonly kind?: "PurgePackage";
  readonly type?: "PurgePackage";
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionDigest;
}

export interface SetSupport extends AdmissionCommandMetadata {
  readonly kind?: "SetSupport";
  readonly type?: "SetSupport";
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionDigest;
  readonly supported: boolean;
  readonly profile: Record<string, unknown>;
  readonly operations: readonly string[];
  readonly implementationDigest: AdmissionDigest;
}

export interface SetActivation extends AdmissionCommandMetadata {
  readonly kind?: "SetActivation";
  readonly type?: "SetActivation";
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionDigest;
  readonly active: boolean;
  readonly audience: {
    readonly kind: "host" | "tenant" | "space" | "principal";
    readonly value: string;
  };
  /** Required for both activation and deactivation; an inactive event may not
   * erase the implementation identity it is revoking. */
  readonly implementationDigest: AdmissionDigest;
}

export interface BeginEvacuation extends AdmissionCommandMetadata {
  readonly kind?: "BeginEvacuation";
  readonly type?: "BeginEvacuation";
  readonly resourceUid: string;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: AdmissionDigest;
  readonly implementationDigest: AdmissionDigest;
  readonly claim: string;
  readonly progress?: Record<string, unknown>;
}

export interface SettleEvacuation extends AdmissionCommandMetadata {
  readonly kind?: "SettleEvacuation";
  readonly type?: "SettleEvacuation";
  readonly resourceUid: string;
  readonly state?: "settled";
  readonly receipt?: Record<string, unknown>;
  readonly progress?: Record<string, unknown>;
}

/** Closed command union. Keep additions explicit and reviewable. */
export type AdmissionCommand =
  | AllowPublisher
  | RotatePublisher
  | DenyPublisher
  | AppendCheckpoint
  | InstallPackage
  | ReplacePackage
  | UninstallPackage
  | PurgePackage
  | SetSupport
  | SetActivation
  | BeginEvacuation
  | SettleEvacuation;

export interface AdmissionQuery {
  readonly kind?:
    | "Publisher"
    | "Checkpoint"
    | "Package"
    | "Support"
    | "Activation"
    | "Evacuation"
    | "History";
  readonly type?: AdmissionQuery["kind"];
  readonly publisherKey?: string;
  readonly formRef?: TakoformV1Alpha3FormRef;
  readonly packageDigest?: AdmissionDigest;
  readonly resourceUid?: string;
  readonly limit?: number;
  readonly chain?:
    | "publisher"
    | "checkpoint"
    | "install"
    | "purge"
    | "support"
    | "activation"
    | "evacuation";
}

export interface AdmissionReceipt {
  readonly eventDigest: AdmissionDigest;
  readonly state: AdmissionEventState;
  readonly changed: boolean;
  readonly packageDigest?: AdmissionDigest;
  readonly formRef?: TakoformV1Alpha3FormRef;
}

export interface AdmissionView {
  readonly kind: string;
  readonly publisher?: Record<string, unknown> | null;
  readonly checkpoint?: Record<string, unknown> | null;
  readonly install?: Record<string, unknown> | null;
  readonly support?: Record<string, unknown> | null;
  readonly activations?: readonly Record<string, unknown>[];
  readonly evacuation?: Record<string, unknown> | null;
  readonly events?: readonly Record<string, unknown>[];
}

/** The intentionally small seam used by future private operator composition. */
export interface FormAdmissionHost {
  inspect(query: AdmissionQuery): Promise<AdmissionView>;
  execute(command: AdmissionCommand): Promise<AdmissionReceipt>;
}

export class FormAdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_command"
      | "invalid_handle"
      | "handle_mismatch"
      | "admission_conflict"
      | "admission_missing"
      | "publisher_denied"
      | "checkpoint_invalid"
      | "package_invalid"
      | "package_store_unavailable"
      | "package_references_exist"
      | "evacuation_pending",
    message: string = code,
  ) {
    super(message);
    this.name = "FormAdmissionError";
  }
}

export function commandKind(command: { readonly kind?: string; readonly type?: string }): string {
  if (!command || typeof command !== "object") {
    throw new FormAdmissionError("invalid_command", "command must be an object");
  }
  if (command.kind !== undefined && command.type !== undefined && command.kind !== command.type) {
    throw new FormAdmissionError("invalid_command", "command kind and type disagree");
  }
  const value = command.kind ?? command.type;
  if (!value) throw new FormAdmissionError("invalid_command", "command kind is required");
  return value;
}

export function validateDigest(value: unknown, label = "digest"): asserts value is AdmissionDigest {
  if (!isSha256Digest(value)) throw new FormAdmissionError("invalid_command", `invalid ${label}`);
}

export function formRefKeyValue(formRef: TakoformV1Alpha3FormRef): string {
  return canonicalJson(formRef);
}

function validateHandleClaims(claims: AdmissionHandleClaims): void {
  if (!claims || typeof claims !== "object") {
    throw new FormAdmissionError("invalid_handle", "handle claims are missing");
  }
  if (claims.operation !== "install" && claims.operation !== "replace") {
    throw new FormAdmissionError("invalid_handle", "invalid handle operation");
  }
  validateHandleDigest(claims.packageDigest, "package digest");
  validateHandleDigest(claims.policyEventDigest, "policy event digest");
  validateHandleDigest(claims.checkpointDigest, "checkpoint digest");
  validateHandleDigest(claims.checkpointEventDigest, "checkpoint event digest");
  if (!claims.publisher || typeof claims.publisher !== "object") {
    throw new FormAdmissionError("invalid_handle", "publisher claims are missing");
  }
  if (
    typeof claims.publisherKey !== "string" ||
    claims.publisherKey.length === 0 ||
    claims.publisherKey.length > 255 ||
    !Number.isSafeInteger(claims.checkpointSequence)
  ) {
    throw new FormAdmissionError("invalid_handle", "incomplete handle claims");
  }
  validateHandlePublisher(claims.publisher, claims.publisherKey);
  if (claims.checkpointSequence < 1) {
    throw new FormAdmissionError("invalid_handle", "checkpoint sequence must be positive");
  }
  try {
    if (!isJsonObject(claims.formRef) || !sameFormRefKeys(claims.formRef)) {
      throw new TypeError("invalid Form identity");
    }
    validateFormRef(claims.formRef);
  } catch {
    throw new FormAdmissionError("invalid_handle", "invalid FormRef in handle claims");
  }
  const formGroup = claims.formRef.apiVersion.slice(0, claims.formRef.apiVersion.indexOf("/"));
  if (claims.publisher.group !== formGroup) {
    throw new FormAdmissionError("invalid_handle", "publisher namespace does not match Form group");
  }
  if (!isJsonObject(claims.report) || claims.report.status !== "admitted") {
    throw new FormAdmissionError("invalid_handle", "the handle report is not admitted");
  }
  validateAdmissionReportShape(claims.report);
  const packageRef = claims.report.package;
  if (
    !isJsonObject(packageRef) ||
    packageRef.packageDigest !== claims.packageDigest ||
    canonicalJson(packageRef.formRef) !== canonicalJson(claims.formRef) ||
    claims.report.operation !== claims.operation ||
    claims.report.publisher?.policyDigest !== claims.publisher.policyDigest ||
    claims.report.publisher?.oidcIssuer !== claims.publisher.oidcIssuer ||
    claims.report.publisher?.sourceRepository !== claims.publisher.sourceRepository ||
    claims.report.publisher?.workflow !== claims.publisher.workflow ||
    claims.report.publisher?.ref !== claims.publisher.ref ||
    claims.report.publisher?.identity !== claims.publisher.identity ||
    canonicalJson(claims.report.source) !==
      canonicalJson({
        sourceCommit: claims.publisher.sourceCommit,
        workflowCommit: claims.publisher.workflowCommit,
        repositoryIdentifier: claims.publisher.repositoryIdentifier,
        ownerIdentifier: claims.publisher.ownerIdentifier,
      }) ||
    canonicalJson(claims.report.namespace) !==
      canonicalJson({
        group: claims.publisher.group,
        namespaceGrantDigest: claims.publisher.namespaceGrantDigest,
      }) ||
    claims.report.signature.trustedRootDigest !== claims.publisher.trustedRootDigest ||
    claims.report.revocation?.sequence !== claims.checkpointSequence ||
    claims.report.revocation?.checkpointDigest !== claims.checkpointDigest
  ) {
    throw new FormAdmissionError("invalid_handle", "handle report does not match its claims");
  }
}

function sameFormRefKeys(value: object): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === 4 &&
    actual[0] === "apiVersion" &&
    actual[1] === "definitionVersion" &&
    actual[2] === "kind" &&
    actual[3] === "schemaDigest"
  );
}

function validateHandleDigest(value: unknown, label: string): asserts value is AdmissionDigest {
  if (!isSha256Digest(value)) {
    throw new FormAdmissionError("invalid_handle", `invalid ${label}`);
  }
}

function validateAdmissionReportShape(report: AdmissionReport): void {
  exactKeys(report, [
    "status",
    "operation",
    "package",
    "publisher",
    "source",
    "namespace",
    "signature",
    "revocation",
    "checks",
  ]);
  if (
    !isJsonObject(report.package) ||
    !isJsonObject(report.publisher) ||
    !isJsonObject(report.source) ||
    !isJsonObject(report.namespace) ||
    !isJsonObject(report.signature) ||
    !isJsonObject(report.revocation)
  ) {
    throw new FormAdmissionError("invalid_handle", "handle report sections are invalid");
  }
  exactKeys(report.package, ["packageDigest", "formRef", "fileCount", "payloadBytes"]);
  if (!isJsonObject(report.package.formRef)) {
    throw new FormAdmissionError("invalid_handle", "handle report FormRef is invalid");
  }
  exactKeys(report.package.formRef, ["apiVersion", "kind", "definitionVersion", "schemaDigest"]);
  exactKeys(report.publisher, [
    "policyDigest",
    "oidcIssuer",
    "sourceRepository",
    "workflow",
    "ref",
    "identity",
  ]);
  exactKeys(report.source, [
    "sourceCommit",
    "workflowCommit",
    "repositoryIdentifier",
    "ownerIdentifier",
  ]);
  exactKeys(report.namespace, ["group", "namespaceGrantDigest"]);
  exactKeys(report.signature, [
    "subjectDigest",
    "bundleDigest",
    "trustedRootDigest",
    ...(report.signature.tlogThreshold === undefined ? [] : ["tlogThreshold"]),
  ]);
  exactKeys(report.revocation, [
    "sequence",
    "checkpointDigest",
    "entriesDigest",
    ...(report.revocation.revoked === undefined ? [] : ["revoked"]),
  ]);
  if (report.status !== "admitted" && report.status !== "denied") {
    throw new FormAdmissionError("invalid_handle", "handle report status is invalid");
  }
  if (report.operation !== "install" && report.operation !== "replace") {
    throw new FormAdmissionError("invalid_handle", "handle report operation is invalid");
  }
  if (
    !isSha256Digest(report.package.packageDigest) ||
    !isJsonObject(report.package.formRef) ||
    !sameFormRefKeys(report.package.formRef) ||
    typeof report.package.formRef.apiVersion !== "string" ||
    typeof report.package.formRef.kind !== "string" ||
    typeof report.package.formRef.definitionVersion !== "string" ||
    !isSha256Digest(report.package.formRef.schemaDigest) ||
    !Number.isSafeInteger(report.package.fileCount) ||
    report.package.fileCount < 1 ||
    !Number.isSafeInteger(report.package.payloadBytes) ||
    report.package.payloadBytes < 0 ||
    !isSha256Digest(report.publisher.policyDigest) ||
    !isSha256Digest(report.namespace.namespaceGrantDigest) ||
    !isSha256Digest(report.signature.subjectDigest) ||
    !isSha256Digest(report.signature.bundleDigest) ||
    !isSha256Digest(report.signature.trustedRootDigest) ||
    (report.signature.tlogThreshold !== undefined &&
      (!Number.isSafeInteger(report.signature.tlogThreshold) ||
        report.signature.tlogThreshold < 1)) ||
    !Number.isSafeInteger(report.revocation.sequence) ||
    report.revocation.sequence < 1 ||
    !isSha256Digest(report.revocation.checkpointDigest) ||
    !isSha256Digest(report.revocation.entriesDigest) ||
    report.revocation.revoked === true
  ) {
    throw new FormAdmissionError("invalid_handle", "handle report pins are invalid");
  }
  for (const [label, value] of Object.entries(report.publisher)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
      throw new FormAdmissionError("invalid_handle", `handle report publisher ${label} is invalid`);
    }
  }
  for (const [label, value] of Object.entries(report.source)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
      throw new FormAdmissionError("invalid_handle", `handle report source ${label} is invalid`);
    }
  }
  if (!isFormGroup(report.namespace.group) || report.namespace.group.length > 255) {
    throw new FormAdmissionError("invalid_handle", "handle report namespace is invalid");
  }
  if (!Array.isArray(report.checks)) {
    throw new FormAdmissionError("invalid_handle", "handle report checks are invalid");
  }
  for (const check of report.checks) {
    exactKeys(check, ["code", "passed"]);
    if (typeof check.code !== "string" || typeof check.passed !== "boolean") {
      throw new FormAdmissionError("invalid_handle", "handle report check is invalid");
    }
    if (!check.passed) {
      throw new FormAdmissionError("invalid_handle", "an admitted handle contains a failed check");
    }
  }
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (!isJsonObject(value)) {
    throw new FormAdmissionError("invalid_handle", "handle report object is invalid");
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new FormAdmissionError("invalid_handle", "handle report has unsupported fields");
  }
}

function validateHandlePublisher(publisher: AdmissionPublisherPin, publisherKey: string): void {
  const required = [
    "oidcIssuer",
    "sourceRepository",
    "workflow",
    "ref",
    "identity",
    "trustedRootDigest",
    "sourceCommit",
    "workflowCommit",
    "repositoryIdentifier",
    "ownerIdentifier",
    "group",
    "namespaceGrantDigest",
    "policyDigest",
  ] as const;
  for (const name of required) {
    const value = publisher[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
      throw new FormAdmissionError("invalid_handle", `publisher claim ${name} is invalid`);
    }
  }
  if (publisher.publisherKey !== undefined && publisher.publisherKey !== publisherKey) {
    throw new FormAdmissionError("invalid_handle", "publisher key claims disagree");
  }
  validateHandleDigest(publisher.policyDigest, "policy digest");
  validateHandleDigest(publisher.namespaceGrantDigest, "namespace grant digest");
  validateHandleDigest(publisher.trustedRootDigest, "trusted root digest");
  if (!isFormGroup(publisher.group)) {
    throw new FormAdmissionError("invalid_handle", "publisher namespace group is invalid");
  }
  if (publisher.policy !== undefined) {
    if (!isJsonObject(publisher.policy)) {
      throw new FormAdmissionError("invalid_handle", "publisher policy claim is not a JSON object");
    }
    if (Object.hasOwn(publisher.policy, "official") || Object.hasOwn(publisher.policy, "lane")) {
      throw new FormAdmissionError("invalid_handle", "publisher policy has a reserved field");
    }
  }
}

/** Convenience for adapters to bind a report digest without exposing authority. */
export async function digestAdmissionReport(report: AdmissionReport): Promise<AdmissionDigest> {
  return canonicalDigest(report);
}
