import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import { canonicalJson, isSha256Digest } from "../json.ts";
import type { TakoformAuthorityFence, TakoformAuthorityGrant } from "./host-authority.ts";

/** Closed identity for the authority accepted by one future deferred apply. */
export const ACCEPTED_AUTHORITY_VERSION = "takoserver.takoform-accepted-authority@v1" as const;

export type AcceptedAuthoritySummary =
  | {
      readonly version: typeof ACCEPTED_AUTHORITY_VERSION;
      readonly protocolGeneration: 1;
      readonly mode: "mutation";
      readonly lifecycleOperation: "create" | "update";
      readonly formRef: TakoformV1Alpha3FormRef;
      readonly packageDigest: `sha256:${string}`;
      readonly implementationDigest: `sha256:${string}`;
      readonly headDigest: `sha256:${string}`;
    }
  | {
      readonly version: typeof ACCEPTED_AUTHORITY_VERSION;
      readonly protocolGeneration: 1;
      readonly mode: "unfenced";
    };

/** New no-authority callers still write a closed, explicit summary. */
export function unfencedAcceptedAuthority(): AcceptedAuthoritySummary {
  return {
    version: ACCEPTED_AUTHORITY_VERSION,
    protocolGeneration: 1,
    mode: "unfenced",
  };
}

export function acceptedAuthorityFromGrant(input: {
  readonly lifecycleOperation: "create" | "update";
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly fence?: TakoformAuthorityFence;
}): AcceptedAuthoritySummary {
  if (input.fence === undefined) return unfencedAcceptedAuthority();
  if (input.fence.mode !== "mutation")
    throw new TypeError("accepted authority needs mutation fence");
  if (
    !isSha256Digest(input.fence.packageDigest) ||
    !isSha256Digest(input.fence.implementationDigest) ||
    !isSha256Digest(input.fence.headDigest)
  ) {
    throw new TypeError("accepted authority has invalid fence digest");
  }
  return {
    version: ACCEPTED_AUTHORITY_VERSION,
    protocolGeneration: 1,
    mode: "mutation",
    lifecycleOperation: input.lifecycleOperation,
    formRef: structuredClone(input.formRef),
    packageDigest: input.fence.packageDigest,
    implementationDigest: input.fence.implementationDigest,
    headDigest: input.fence.headDigest,
  };
}

/** Canonical persistence encoding; callers must not serialize this object directly. */
export function encodeAcceptedAuthority(summary: AcceptedAuthoritySummary): string {
  assertAcceptedAuthorityShape(summary);
  return canonicalJson(summary);
}

/** Strictly parses one stored summary and rejects non-canonical or open shapes. */
export function parseAcceptedAuthority(value: unknown): AcceptedAuthoritySummary {
  if (typeof value !== "string") throw new TypeError("invalid accepted authority summary");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("invalid accepted authority summary");
  }
  assertAcceptedAuthorityShape(parsed);
  if (canonicalJson(parsed) !== value) {
    throw new TypeError("noncanonical accepted authority summary");
  }
  return parsed;
}

/** Validate the persisted row identity and, when present, its ephemeral CAS fence. */
export function assertAcceptedAuthorityRecord(input: {
  readonly summary: AcceptedAuthoritySummary;
  readonly operation: "apply" | "import" | "delete";
  readonly lifecycleOperation?: "create" | "update";
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly acceptedUid?: string;
  readonly fence?: TakoformAuthorityFence;
  readonly requireFence?: boolean;
}): void {
  const { summary } = input;
  if (input.operation !== "apply") {
    throw new TypeError("accepted authority is only valid for apply");
  }
  const lifecycleOperation =
    input.lifecycleOperation ?? (input.acceptedUid === undefined ? "create" : "update");
  if (summary.mode === "unfenced") {
    if (input.fence !== undefined) throw new TypeError("unfenced authority cannot carry a fence");
    return;
  }
  if (
    summary.lifecycleOperation !== lifecycleOperation ||
    canonicalJson(summary.formRef) !== canonicalJson(input.formRef)
  ) {
    throw new TypeError("accepted authority row identity mismatch");
  }
  const fence = input.fence;
  if (
    (input.requireFence === true && fence === undefined) ||
    (fence !== undefined &&
      (fence.mode !== "mutation" ||
        fence.packageDigest !== summary.packageDigest ||
        fence.implementationDigest !== summary.implementationDigest ||
        fence.headDigest !== summary.headDigest))
  ) {
    throw new TypeError("accepted authority fence mismatch");
  }
}

/** Re-authorize a saved deferred apply without requiring its old head to remain current. */
export function assertAcceptedAuthorityGrant(input: {
  readonly summary: AcceptedAuthoritySummary;
  readonly lifecycleOperation: "create" | "update";
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly grant:
    | TakoformAuthorityGrant
    | {
        readonly form: { readonly identity: { readonly packageDigest?: string } };
        readonly fence?: TakoformAuthorityFence;
      };
}): void {
  const { summary, grant } = input;
  if (summary.mode === "unfenced") {
    // A portable/historical row has no saved authority head.  It may resume
    // through the old unfenced path, but must never silently acquire a new
    // mutation fence and thereby become a cross-head continuation.
    if (grant.fence !== undefined) {
      throw new TypeError("unfenced accepted apply cannot gain a mutation fence");
    }
    return;
  }
  if (
    summary.lifecycleOperation !== input.lifecycleOperation ||
    canonicalJson(summary.formRef) !== canonicalJson(input.formRef) ||
    grant.fence === undefined ||
    grant.fence.mode !== "mutation" ||
    grant.fence.packageDigest !== summary.packageDigest ||
    grant.form.identity.packageDigest !== summary.packageDigest
  ) {
    throw new TypeError("fresh authority does not continue accepted apply");
  }
  // A new implementation digest is intentionally allowed. The saved head is
  // the saga/receipt identity; the fresh fence is used only for the final CAS.
}

function assertAcceptedAuthorityShape(value: unknown): asserts value is AcceptedAuthoritySummary {
  if (!isRecord(value)) throw new TypeError("invalid accepted authority summary");
  if (
    value.version !== ACCEPTED_AUTHORITY_VERSION ||
    value.protocolGeneration !== 1 ||
    (value.mode !== "mutation" && value.mode !== "unfenced")
  ) {
    throw new TypeError("invalid accepted authority summary");
  }
  if (value.mode === "unfenced") {
    assertKeys(value, ["mode", "protocolGeneration", "version"]);
    return;
  }
  assertKeys(value, [
    "formRef",
    "headDigest",
    "implementationDigest",
    "lifecycleOperation",
    "mode",
    "packageDigest",
    "protocolGeneration",
    "version",
  ]);
  if (value.lifecycleOperation !== "create" && value.lifecycleOperation !== "update") {
    throw new TypeError("invalid accepted authority lifecycle");
  }
  if (
    !isSha256Digest(value.packageDigest) ||
    !isSha256Digest(value.implementationDigest) ||
    !isSha256Digest(value.headDigest)
  ) {
    throw new TypeError("invalid accepted authority digest");
  }
  if (!isRecord(value.formRef)) throw new TypeError("invalid accepted authority form ref");
  assertKeys(value.formRef, ["apiVersion", "definitionVersion", "kind", "schemaDigest"]);
  if (
    typeof value.formRef.apiVersion !== "string" ||
    typeof value.formRef.kind !== "string" ||
    typeof value.formRef.definitionVersion !== "string" ||
    !isSha256Digest(value.formRef.schemaDigest)
  ) {
    throw new TypeError("invalid accepted authority form ref");
  }
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(sorted)) {
    throw new TypeError("accepted authority summary has unexpected fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
