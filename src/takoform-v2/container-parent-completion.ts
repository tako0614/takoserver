import { bytesDigest, canonicalJson, isSha256Digest } from "../json.ts";
import type {
  V2WorkerInvocationHandle,
  V2WorkerInvocationRecord,
  V2WorkerInvocationRetirementIdentity,
} from "../worker-invocation-port.ts";

const BINDING_FORMAT = "takoserver.container-parent-io-binding@1";
const ORIGINAL_FORMAT = "takoserver.container-parent-io-original@1";
const VERSION_FORM = "https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/";
const TARGET_FORM = "https://edge.forms.takoform.com/forms/Container/0.1.0/";
const CONSUMER_BINDING_FORMAT = "takoserver.container-parent-io-binding@2";
const CONSUMER_ORIGINAL_FORMAT = "takoserver.container-parent-io-original@2";
const CONSUMER_VERSION_FORM = "https://edge.forms.takoform.com/forms/WorkerVersion/0.8.0/";
const CONTAINER_TWO_FORM = "https://edge.forms.takoform.com/forms/Container/0.2.0/";
type Digest = `sha256:${string}`;

export interface V2ContainerParentIoTarget {
  readonly producerId: string;
  readonly bindingName: string;
  readonly workerVersionFormUrl: typeof VERSION_FORM;
  readonly targetFormUrl: typeof TARGET_FORM;
  readonly targetUid: string;
  readonly targetGeneration: number;
  readonly targetSourceOperationId: string;
  readonly providerInstallationId: string;
  readonly incarnationId: string;
  readonly servingRevision: string;
  readonly ownerId: string;
}
export interface V2ContainerParentIoClaim {
  readonly handle: V2WorkerInvocationHandle;
  readonly expected: V2WorkerInvocationRetirementIdentity;
  readonly target: V2ContainerParentIoTarget;
}
export type V2ContainerParentIoParent = Pick<V2ContainerParentIoClaim, "handle" | "expected">;
/** Canonical Host-private data. Possession of these bytes is not an admission grant. */
export interface V2ContainerParentIoBinding {
  readonly producerId: string;
  readonly canonical: string;
  readonly digest: Digest;
}
/** Content only. These fields neither authenticate an issuer nor admit a send. */
export interface V2ContainerParentIoBindingScope {
  readonly format: typeof BINDING_FORMAT;
  readonly parent: {
    readonly invocationId: string;
    readonly custodyDigest: Digest;
    readonly selectionDigest: Digest;
  };
  readonly target: V2ContainerParentIoTarget;
}
export interface V2ContainerParentIoOriginal {
  readonly format: typeof ORIGINAL_FORMAT;
  readonly bindingDigest: Digest;
  readonly producerId: string;
  readonly ownerEpoch: number;
  readonly completedAtMs: number;
  /** Only this child transport I/O; never parent/context/process retirement. */
  readonly outcome: "transport_io_complete";
  readonly receiptDigest: Digest;
}
export type V2ContainerParentIoReadback =
  | { readonly state: "absent" | "pending" | "unknown" }
  | {
      readonly state: "complete";
      readonly original: V2ContainerParentIoOriginal;
    };

/** Explicit @2 profile; no widening of the WorkerVersion 0.7 / @1 ABI. */
export interface V2ContainerConsumerParentIoTarget
  extends Omit<V2ContainerParentIoTarget, "workerVersionFormUrl" | "targetFormUrl"> {
  readonly workerVersionFormUrl: typeof CONSUMER_VERSION_FORM;
  readonly targetFormUrl: typeof TARGET_FORM | typeof CONTAINER_TWO_FORM;
}
export interface V2ContainerConsumerParentIoClaim extends Omit<V2ContainerParentIoClaim, "target"> {
  readonly target: V2ContainerConsumerParentIoTarget;
}
/** Content only, with the same envelope and disjoint canonical/hash domains. */
export type V2ContainerConsumerParentIoBinding = V2ContainerParentIoBinding;
export interface V2ContainerConsumerParentIoBindingScope
  extends Omit<V2ContainerParentIoBindingScope, "format" | "target"> {
  readonly format: typeof CONSUMER_BINDING_FORMAT;
  readonly target: V2ContainerConsumerParentIoTarget;
}
export interface V2ContainerConsumerParentIoOriginal
  extends Omit<V2ContainerParentIoOriginal, "format"> {
  readonly format: typeof CONSUMER_ORIGINAL_FORMAT;
}
export type V2ContainerConsumerParentIoReadback =
  | { readonly state: "absent" | "pending" | "unknown" }
  | { readonly state: "complete"; readonly original: V2ContainerConsumerParentIoOriginal };

type ParentIoTarget = V2ContainerParentIoTarget | V2ContainerConsumerParentIoTarget;
type ParentIoClaim<T extends ParentIoTarget> = Omit<V2ContainerParentIoClaim, "target"> & {
  readonly target: T;
};
type ParentIoScope<T extends ParentIoTarget, F extends string> = Omit<
  V2ContainerParentIoBindingScope,
  "format" | "target"
> & { readonly format: F; readonly target: T };
type ParentIoOriginal<F extends string> = Omit<V2ContainerParentIoOriginal, "format"> & {
  readonly format: F;
};
interface ParentIoProfile<T extends ParentIoTarget, B extends string, O extends string> {
  readonly bindingFormat: B;
  readonly originalFormat: O;
  readonly isTarget: (value: unknown) => value is T;
}
interface ParentIoPorts<T extends ParentIoTarget> {
  readonly readParent: (
    handle: V2WorkerInvocationHandle,
  ) => Promise<V2WorkerInvocationRecord | null>;
  readonly authorize: (claim: ParentIoClaim<T>) => Promise<boolean>;
}

type Row = Record<string, unknown>;
function row(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Row {
  return (
    row(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")
  );
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function hash(domain: string, canonical: string): Promise<Digest> {
  return bytesDigest(new TextEncoder().encode(`${domain}\0${canonical}`));
}
const identityText = [
  "backendId",
  "targetKey",
  "principal",
  "space",
  "workerUid",
  "deploymentUid",
  "sourceOperationId",
  "versionUid",
  "versionOperationId",
  "nativeIdentity",
  "confirmedReceipt",
] as const;
const identityNumbers = ["deploymentGeneration", "versionGeneration"] as const;
const identityKeys = [...identityText, ...identityNumbers, "closureDigest", "ingress"];
function identity(value: unknown): value is V2WorkerInvocationRetirementIdentity {
  if (
    !exact(value, identityKeys) ||
    !identityText.every((k) => text(value[k])) ||
    !identityNumbers.every((k) => positive(value[k])) ||
    !isSha256Digest(value.closureDigest)
  )
    return false;
  const i = value.ingress;
  if (!row(i)) return false;
  if (i.kind === "endpoint")
    return (
      exact(i, ["kind", "endpointUid", "endpointGeneration"]) &&
      text(i.endpointUid) &&
      positive(i.endpointGeneration)
    );
  if (i.kind === "cron")
    return (
      exact(i, ["kind", "matchId", "triggerOperationId", "leaseToken", "attempt"]) &&
      isSha256Digest(i.matchId) &&
      text(i.triggerOperationId) &&
      text(i.leaseToken) &&
      positive(i.attempt)
    );
  return (
    i.kind === "service" &&
    exact(i, [
      "kind",
      "callerWorkerUid",
      "callerVersionUid",
      "callerVersionGeneration",
      "callerVersionOperationId",
      "bindingName",
      "callerExecutionRef",
    ]) &&
    [
      i.callerWorkerUid,
      i.callerVersionUid,
      i.callerVersionOperationId,
      i.bindingName,
      i.callerExecutionRef,
    ].every(text) &&
    positive(i.callerVersionGeneration)
  );
}
const targetKeys = [
  "producerId",
  "bindingName",
  "workerVersionFormUrl",
  "targetFormUrl",
  "targetUid",
  "targetGeneration",
  "targetSourceOperationId",
  "providerInstallationId",
  "incarnationId",
  "servingRevision",
  "ownerId",
];
function targetShape(value: unknown, versionForm: string, targetForms: readonly string[]): boolean {
  return (
    exact(value, targetKeys) &&
    value.workerVersionFormUrl === versionForm &&
    typeof value.targetFormUrl === "string" &&
    targetForms.includes(value.targetFormUrl) &&
    positive(value.targetGeneration) &&
    targetKeys.filter((k) => k !== "targetGeneration").every((k) => text(value[k]))
  );
}
function target(value: unknown): value is V2ContainerParentIoTarget {
  return targetShape(value, VERSION_FORM, [TARGET_FORM]);
}
function consumerTarget(value: unknown): value is V2ContainerConsumerParentIoTarget {
  return targetShape(value, CONSUMER_VERSION_FORM, [TARGET_FORM, CONTAINER_TWO_FORM]);
}
const parentProfile = {
  bindingFormat: BINDING_FORMAT,
  originalFormat: ORIGINAL_FORMAT,
  isTarget: target,
} as const;
const consumerProfile = {
  bindingFormat: CONSUMER_BINDING_FORMAT,
  originalFormat: CONSUMER_ORIGINAL_FORMAT,
  isTarget: consumerTarget,
} as const;
function selected(record: V2WorkerInvocationRecord): unknown {
  return Object.fromEntries(
    identityKeys.map((key) => [key, record[key as keyof V2WorkerInvocationRecord]]),
  );
}

/** Internal shared derivation. These digests are data, never custody authority. */
export async function containerParentIoScope(
  input: V2ContainerParentIoParent,
): Promise<V2ContainerParentIoBindingScope["parent"] | null> {
  try {
    const parent = structuredClone(input);
    if (
      !exact(parent, ["handle", "expected"]) ||
      !exact(parent.handle, ["invocationId", "custodyToken"]) ||
      !text(parent.handle.invocationId) ||
      !text(parent.handle.custodyToken) ||
      parent.handle.custodyToken.length < 16 ||
      !identity(parent.expected)
    )
      return null;
    return Object.freeze({
      invocationId: parent.handle.invocationId,
      custodyDigest: await hash(
        "takoserver.container-parent-custody@1",
        canonicalJson(parent.handle),
      ),
      selectionDigest: await hash(
        "takoserver.container-parent-selection@1",
        canonicalJson(parent.expected),
      ),
    });
  } catch {
    return null;
  }
}

/** Internal exact comparison; it does not require fresh-send authority after Tail. */
export function containerParentIoMatchesRecord(
  parent: V2ContainerParentIoParent,
  record: V2WorkerInvocationRecord | null,
): boolean {
  return (
    record !== null &&
    record.handle.invocationId === parent.handle.invocationId &&
    record.handle.custodyToken === parent.handle.custodyToken &&
    canonicalJson(selected(record)) === canonicalJson(parent.expected)
  );
}

export const isContainerParentIoTarget = target;
export const isContainerConsumerParentIoTarget = consumerTarget;

/**
 * Both ports are source-selected Host custody. authorize must compare accepted
 * binding references AND exact physical caller/target/owner currentness. A row,
 * ready DTO or tenant-provided callback is not that authority. The producer must
 * recheck stillCurrent after durable pending admission and before its first send;
 * this helper does not make those separate owner actions atomic. authorize must
 * also verify that producerId was Host-issued for this parent; the private
 * journal enforces one-use by durable CAS. Body and SQLite drain observations
 * do not establish Container admission or retirement. The closure retains raw
 * custody in Host memory only: never log, serialize or expose it through RPC.
 */
export function createV2ContainerParentIoQualifier(options: {
  readonly readParent: (
    handle: V2WorkerInvocationHandle,
  ) => Promise<V2WorkerInvocationRecord | null>;
  readonly authorize: (claim: V2ContainerParentIoClaim) => Promise<boolean>;
}) {
  return createParentIoQualifier(parentProfile, options);
}

/**
 * Explicit WorkerVersion 0.8 profile. The same custody/currentness obligations
 * apply, including the actual accepted 0.8 references and the exact Form's native
 * owner. This does not supply private issuer/inventory/RPC coverage or enable it.
 */
export function createV2ContainerConsumerParentIoQualifier(
  options: ParentIoPorts<V2ContainerConsumerParentIoTarget>,
) {
  return createParentIoQualifier(consumerProfile, options);
}

function createParentIoQualifier<T extends ParentIoTarget, B extends string, O extends string>(
  profile: ParentIoProfile<T, B, O>,
  options: ParentIoPorts<T>,
) {
  const { readParent, authorize } = options;
  if (typeof readParent !== "function" || typeof authorize !== "function")
    throw new TypeError("Container parent custody ports required");
  return async (
    input: ParentIoClaim<T>,
  ): Promise<
    | (V2ContainerParentIoBinding & {
        readonly stillCurrent: () => Promise<boolean>;
      })
    | null
  > => {
    try {
      // Copy before the first await. No caller mutation can retarget later checks.
      const claim = structuredClone(input);
      if (
        !exact(claim, ["handle", "expected", "target"]) ||
        !exact(claim.handle, ["invocationId", "custodyToken"]) ||
        !text(claim.handle.invocationId) ||
        !text(claim.handle.custodyToken) ||
        claim.handle.custodyToken.length < 16 ||
        !identity(claim.expected) ||
        !profile.isTarget(claim.target)
      )
        return null;
      const canonicalExpected = canonicalJson(claim.expected);
      const stillCurrent = async (): Promise<boolean> => {
        try {
          // Give ports detached copies so they cannot rewrite the captured claim.
          const current = await readParent(structuredClone(claim.handle));
          if (
            !current ||
            current.handle.invocationId !== claim.handle.invocationId ||
            current.handle.custodyToken !== claim.handle.custodyToken ||
            current.phase !== "send_authorized" ||
            current.retirement !== null ||
            current.noNativeDispatchAtMs !== null ||
            canonicalJson(selected(current)) !== canonicalExpected
          )
            return false;
          return (await authorize(structuredClone(claim))) === true;
        } catch {
          return false;
        }
      };
      if (!(await stillCurrent())) return null;
      const canonical = canonicalJson({
        format: profile.bindingFormat,
        parent: await containerParentIoScope({
          handle: claim.handle,
          expected: claim.expected,
        }),
        target: claim.target,
      });
      const digest = await hash(profile.bindingFormat, canonical);
      if (!(await stillCurrent())) return null;
      return Object.freeze({
        producerId: claim.target.producerId,
        canonical,
        digest,
        stillCurrent,
      });
    } catch {
      return null;
    }
  };
}

function originalPayload<F extends string>(input: Omit<ParentIoOriginal<F>, "receiptDigest">) {
  return {
    format: input.format,
    bindingDigest: input.bindingDigest,
    producerId: input.producerId,
    ownerEpoch: input.ownerEpoch,
    completedAtMs: input.completedAtMs,
    outcome: input.outcome,
  };
}

/** Content decoder only; it does not verify current parent/target or grant admission. */
export async function decodeV2ContainerParentIoBinding(
  input: V2ContainerParentIoBinding,
): Promise<V2ContainerParentIoBindingScope | null> {
  return decodeParentIoBinding(input, parentProfile);
}

/** Content-only @2 decoder; no issuer authentication or live admission. */
export async function decodeV2ContainerConsumerParentIoBinding(
  input: V2ContainerConsumerParentIoBinding,
): Promise<V2ContainerConsumerParentIoBindingScope | null> {
  return decodeParentIoBinding(input, consumerProfile);
}

async function decodeParentIoBinding<T extends ParentIoTarget, B extends string, O extends string>(
  input: V2ContainerParentIoBinding,
  profile: ParentIoProfile<T, B, O>,
): Promise<ParentIoScope<T, B> | null> {
  try {
    const binding = {
      producerId: input.producerId,
      canonical: input.canonical,
      digest: input.digest,
    };
    if (
      !text(binding.producerId) ||
      typeof binding.canonical !== "string" ||
      binding.canonical.length === 0 ||
      binding.canonical.length > 65536 ||
      !isSha256Digest(binding.digest)
    )
      return null;
    const scope: unknown = JSON.parse(binding.canonical);
    if (
      !exact(scope, ["format", "parent", "target"]) ||
      scope.format !== profile.bindingFormat ||
      !profile.isTarget(scope.target) ||
      scope.target.producerId !== binding.producerId ||
      !exact(scope.parent, ["invocationId", "custodyDigest", "selectionDigest"]) ||
      !text(scope.parent.invocationId) ||
      !isSha256Digest(scope.parent.custodyDigest) ||
      !isSha256Digest(scope.parent.selectionDigest) ||
      canonicalJson(scope) !== binding.canonical ||
      (await hash(profile.bindingFormat, binding.canonical)) !== binding.digest
    )
      return null;
    return Object.freeze({
      format: profile.bindingFormat,
      parent: Object.freeze({
        invocationId: scope.parent.invocationId,
        custodyDigest: scope.parent.custodyDigest,
        selectionDigest: scope.parent.selectionDigest,
      }),
      target: Object.freeze({ ...scope.target }),
    });
  } catch {
    return null;
  }
}
/** Content fingerprint only. Computing it does not attest I/O or authenticate an issuer. */
export function v2ContainerParentIoOriginalDigest(
  input: Omit<V2ContainerParentIoOriginal, "receiptDigest">,
): Promise<Digest> {
  return hash(ORIGINAL_FORMAT, canonicalJson(originalPayload(input)));
}

/** @2 content fingerprint only; self-hashed bytes are never an I/O original. */
export function v2ContainerConsumerParentIoOriginalDigest(
  input: Omit<V2ContainerConsumerParentIoOriginal, "receiptDigest">,
): Promise<Digest> {
  return hash(CONSUMER_ORIGINAL_FORMAT, canonicalJson(originalPayload(input)));
}

/**
 * readOriginal must be the fixed trusted owner durable reader, never tenant JSON.
 * A digest validates content, not origin/durability. No direct complete()/finish()
 * authority is supplied. Every nonpositive or unreadable state remains nonpositive.
 */
export async function readV2ContainerParentIoOriginal(
  input: V2ContainerParentIoBinding,
  readOriginal: (binding: V2ContainerParentIoBinding) => Promise<unknown>,
): Promise<V2ContainerParentIoReadback> {
  return readParentIoOriginal(input, readOriginal, parentProfile);
}

/** Same fixed-owner/durable-original requirements, using only the @2 profile. */
export async function readV2ContainerConsumerParentIoOriginal(
  input: V2ContainerConsumerParentIoBinding,
  readOriginal: (binding: V2ContainerConsumerParentIoBinding) => Promise<unknown>,
): Promise<V2ContainerConsumerParentIoReadback> {
  return readParentIoOriginal(input, readOriginal, consumerProfile);
}

async function readParentIoOriginal<T extends ParentIoTarget, B extends string, O extends string>(
  input: V2ContainerParentIoBinding,
  readOriginal: (binding: V2ContainerParentIoBinding) => Promise<unknown>,
  profile: ParentIoProfile<T, B, O>,
): Promise<
  | { readonly state: "absent" | "pending" | "unknown" }
  | { readonly state: "complete"; readonly original: ParentIoOriginal<O> }
> {
  try {
    const binding = {
      producerId: input.producerId,
      canonical: input.canonical,
      digest: input.digest,
    };
    if (!(await decodeParentIoBinding(binding, profile))) return { state: "unknown" };
    const result: unknown = structuredClone(await readOriginal(Object.freeze({ ...binding })));
    if (
      exact(result, ["state"]) &&
      (result.state === "absent" || result.state === "pending" || result.state === "unknown")
    )
      return { state: result.state as "absent" | "pending" | "unknown" };
    if (!exact(result, ["state", "original"]) || result.state !== "complete")
      return { state: "unknown" };
    const o = result.original;
    if (
      !exact(o, [
        "format",
        "bindingDigest",
        "producerId",
        "ownerEpoch",
        "completedAtMs",
        "outcome",
        "receiptDigest",
      ]) ||
      o.format !== profile.originalFormat ||
      o.bindingDigest !== binding.digest ||
      o.producerId !== binding.producerId ||
      !positive(o.ownerEpoch) ||
      !positive(o.completedAtMs) ||
      o.outcome !== "transport_io_complete" ||
      !isSha256Digest(o.receiptDigest)
    )
      return { state: "unknown" };
    const original = o as unknown as ParentIoOriginal<O>;
    if (
      (await hash(profile.originalFormat, canonicalJson(originalPayload(original)))) !==
      original.receiptDigest
    )
      return { state: "unknown" };
    return { state: "complete", original: Object.freeze({ ...original }) };
  } catch {
    return { state: "unknown" };
  }
}
