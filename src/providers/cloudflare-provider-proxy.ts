import { canonicalJson } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import type { MeterSource } from "../provider-meter-port.ts";
import type {
  ApplyInput,
  Provider,
  ProviderApplyCompensationInput,
  ProviderApplyCompensationResult,
  ProviderApplyNoEffectConclusionInput,
  ProviderApplyNoEffectConclusionResult,
  ProviderArtifactConsumption,
  ProviderExecutionAuthority,
  ProviderFailure,
  ProviderNativeAbsence,
  ProviderNativeReadbackAuthority,
  ProviderNativeReadbackDescriptor,
  ProviderNativeReadbackInput,
  ProviderOffering,
  ProviderRelation,
  ProviderTicket,
  ResourceIdentity,
} from "../provider-port.ts";
import {
  failed,
  failedAfterProviderOperationCompensation,
  failedWithoutProviderMutation,
  failedWithoutProviderOperationMutation,
} from "../provider-port.ts";
import { MAX_PROVIDER_RUNTIME_INPUT_BINDINGS } from "../provider-runtime-input-port.ts";
import {
  canonicalWorkerEndpointOrigin,
  derivedProviderResourceName,
} from "../provider-worker-endpoint-origin.ts";
import {
  type CloudflareProviderMeterSourceDescriptor,
  cloudflareProviderMeterSourceForOfferingKind,
} from "./cloudflare-edge-meter-contract.ts";
import {
  boundedString,
  isCloudflareProviderArtifactConsumption,
  maybeExactRecord,
} from "./cloudflare-provider-executor-codec.ts";
import {
  CLOUDFLARE_PROVIDER_EXECUTOR_ADOPTION_ABORT_SCHEMA,
  CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_ABORT_SCHEMA,
  CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_COMPENSATION_SCHEMA,
  CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_NO_EFFECT_SCHEMA,
  CLOUDFLARE_PROVIDER_EXECUTOR_NO_MUTATION_SCHEMA,
  type CloudflareProviderExecutorRpc,
} from "./cloudflare-provider-executor-port.ts";
import {
  cloudflareWfpOwnsOffering,
  createCloudflareNativeReadbackDescriptor,
} from "./cloudflare-readback-descriptor.ts";
import { ProviderMeterError } from "./provider-meter.ts";

export interface CloudflareProviderProxyOptions {
  readonly id?: string;
  readonly providerInstallationId: string;
  readonly offerings: readonly ProviderOffering[];
  readonly recoveryOfferings?: readonly ProviderOffering[];
  readonly nativeReadbackAuthorities?: readonly ProviderNativeReadbackAuthority[];
  readonly managedBaseDomain: string;
  /** Static capability projection; no secret or lease value enters this object. */
  readonly runtimeInputs?: boolean;
  readonly binding: CloudflareProviderExecutorRpc;
}

/**
 * Credential-free Provider surface retained in the public API Worker.
 *
 * Static catalog and endpoint facts stay local. Only the explicitly typed
 * provider operations cross the private service binding; artifact bytes and
 * runtime-input plaintext are resolved inside the executor from shared D1/R2.
 */
export class CloudflareProviderProxy implements Provider {
  readonly id: string;
  readonly offerings: readonly ProviderOffering[];
  readonly recoveryOfferings?: readonly ProviderOffering[];
  readonly nativeReadbackAuthorities?: readonly ProviderNativeReadbackAuthority[];
  readonly runtimeInputCapabilities?: { readonly maximumBindings: number };
  readonly workerEndpointOriginReservations: NonNullable<
    Provider["workerEndpointOriginReservations"]
  >;
  readonly #binding: CloudflareProviderExecutorRpc;
  readonly #providerInstallationId: string;

  constructor(options: CloudflareProviderProxyOptions) {
    this.id = options.id ?? "cloudflare";
    this.offerings = structuredClone(options.offerings);
    if (options.recoveryOfferings) {
      this.recoveryOfferings = structuredClone(options.recoveryOfferings);
    }
    if (options.nativeReadbackAuthorities) {
      this.nativeReadbackAuthorities = structuredClone(options.nativeReadbackAuthorities);
    }
    if (options.runtimeInputs) {
      this.runtimeInputCapabilities = {
        maximumBindings: MAX_PROVIDER_RUNTIME_INPUT_BINDINGS,
      };
    }
    this.#binding = options.binding;
    this.#providerInstallationId = options.providerInstallationId;
    const managedBaseDomain = normalizeManagedBaseDomain(options.managedBaseDomain);
    this.workerEndpointOriginReservations = {
      derive: async ({ requestedSubdomain }) => {
        const canonicalPublicOrigin = canonicalWorkerEndpointOrigin(
          requestedSubdomain,
          managedBaseDomain,
        );
        return canonicalPublicOrigin ? { canonicalPublicOrigin } : null;
      },
      // A WfP installation serves managed Workers beneath the managed base
      // domain. Host-minted reservations therefore use a stable opaque label
      // from the logical Worker identity; caller-supplied reservations still
      // take priority in the Host reservation lifecycle.
      hostMintedSubdomain: async ({ tenantRef, space, workerName }) =>
        await derivedProviderResourceName("tsw", {
          tenantRef,
          space,
          name: workerName,
        }),
    };
  }

  async apply(input: ApplyInput): Promise<ProviderTicket> {
    const context = snapshotInitialMutationContext("apply", input, this.#providerInstallationId);
    return restoreInitialMutationResult(
      providerRpcResult(await this.#binding.apply(input)),
      context,
    );
  }

  async recoverApply(input: ApplyInput): Promise<ProviderTicket> {
    return rejectUnexpectedExecutorEvidence(
      providerRpcResult(await this.#binding.recoverApply(input)),
    );
  }

  async convergeApply(input: ApplyInput): Promise<ProviderTicket> {
    const context = {
      ...snapshotAdoptionRecoveryContext(input, this.#providerInstallationId),
      hasPrevious: input.previous !== undefined,
    };
    return restoreApplyConvergenceResult(
      providerRpcResult(await this.#binding.convergeApply(input)),
      context,
    );
  }

  async concludeApplyNoEffect(
    input: ProviderApplyNoEffectConclusionInput,
  ): Promise<ProviderApplyNoEffectConclusionResult> {
    const context = snapshotApplyNoEffectContext(input, this.#providerInstallationId);
    if (!context.selectionMatchesInstallation) {
      return failed("unavailable", "Provider executor placement no longer matches", true);
    }
    const safeOperationId =
      input.operationId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128) || "unknown";
    try {
      const rawResult = await this.#binding.concludeApplyNoEffect(input);
      const result = restoreApplyNoEffectConclusionResult(providerRpcResult(rawResult), context);
      try {
        const rawPhaseValue =
          typeof rawResult === "object" && rawResult !== null
            ? Object.getOwnPropertyDescriptor(rawResult, "phase")?.value
            : undefined;
        const restoredPhaseValue =
          typeof result === "object" && result !== null
            ? (result as { readonly phase?: unknown }).phase
            : undefined;
        const rawPhase =
          rawPhaseValue === "succeeded" ||
          rawPhaseValue === "failed" ||
          rawPhaseValue === "running" ||
          rawPhaseValue === "unsupported"
            ? rawPhaseValue
            : "unknown";
        const restoredPhase =
          restoredPhaseValue === "succeeded" ||
          restoredPhaseValue === "failed" ||
          restoredPhaseValue === "running" ||
          restoredPhaseValue === "unsupported"
            ? restoredPhaseValue
            : "unknown";
        console.error(
          canonicalJson({
            event: "takoform.accepted_apply_recovery",
            operationId: safeOperationId,
            stage: "proxy-conclusion",
            rawPhase,
            restoredPhase,
          }),
        );
      } catch {
        // Recovery diagnostics must not change the provider result.
      }
      return result;
    } catch (error) {
      try {
        console.error(
          canonicalJson({
            event: "takoform.accepted_apply_recovery",
            operationId: safeOperationId,
            stage: "proxy-conclusion-threw",
          }),
        );
      } catch {
        // Recovery diagnostics must not change the provider error.
      }
      throw error;
    }
  }

  async compensateApply(
    input: ProviderApplyCompensationInput,
  ): Promise<ProviderApplyCompensationResult> {
    const context = snapshotApplyConclusionContext(input, this.#providerInstallationId);
    if (!context.selectionMatchesInstallation) {
      return failed("unavailable", "Provider executor placement no longer matches", true);
    }
    return restoreApplyCompensationResult(
      providerRpcResult(await this.#binding.compensateApply(input)),
      context,
    );
  }

  async poll(input: Parameters<NonNullable<Provider["poll"]>>[0]): Promise<ProviderTicket> {
    return rejectUnexpectedExecutorEvidence(providerRpcResult(await this.#binding.poll(input)));
  }

  observe(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: import("../provider-port.ts").ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket> {
    return this.#binding.observe(input);
  }

  async delete(input: Parameters<Provider["delete"]>[0]): Promise<ProviderTicket> {
    const context = snapshotInitialMutationContext("delete", input, this.#providerInstallationId);
    return restoreInitialMutationResult(
      providerRpcResult(await this.#binding.delete(input)),
      context,
    );
  }

  recoverDelete(
    input: Parameters<NonNullable<Provider["recoverDelete"]>>[0],
  ): Promise<ProviderTicket> {
    return this.#binding.recoverDelete(input);
  }

  async adopt(input: Parameters<NonNullable<Provider["adopt"]>>[0]): Promise<ProviderTicket> {
    const context = snapshotInitialMutationContext("adopt", input, this.#providerInstallationId);
    return restoreInitialMutationResult(
      providerRpcResult(await this.#binding.adopt(input)),
      context,
    );
  }

  async recoverAdopt(
    input: Parameters<NonNullable<Provider["recoverAdopt"]>>[0],
  ): Promise<ProviderTicket> {
    const context = snapshotAdoptionRecoveryContext(input, this.#providerInstallationId);
    return restoreAdoptionRecoveryResult(
      providerRpcResult(await this.#binding.recoverAdopt(input)),
      context,
    );
  }

  createNativeReadbackDescriptor(
    input: ProviderNativeReadbackInput,
  ): ProviderNativeReadbackDescriptor {
    return createCloudflareNativeReadbackDescriptor({
      providerId: this.id,
      placement: cloudflareWfpOwnsOffering(input.offering)
        ? "workers-for-platforms"
        : "ordinary-workers",
      readback: input,
    });
  }

  verifyNativeAbsence(
    input: Parameters<NonNullable<Provider["verifyNativeAbsence"]>>[0],
  ): Promise<ProviderNativeAbsence> {
    return this.#binding.verifyNativeAbsence(input);
  }

  async verifyArtifactConsumption(
    input: Parameters<NonNullable<Provider["verifyArtifactConsumption"]>>[0],
  ): Promise<ProviderArtifactConsumption> {
    const result = providerRpcResult(await this.#binding.verifyArtifactConsumption(input));
    return isCloudflareProviderArtifactConsumption(result)
      ? result
      : { outcome: "unknown", reason: "malformed", retryable: false };
  }

  readonly sqliteMigrations = {
    readLedger: (input: Parameters<NonNullable<Provider["sqliteMigrations"]>["readLedger"]>[0]) =>
      this.#binding.readSqliteMigrationLedger(input),
    applySuffix: (input: Parameters<NonNullable<Provider["sqliteMigrations"]>["applySuffix"]>[0]) =>
      this.#binding.applySqliteMigrationSuffix({
        ...input,
        desired: input.desired.map(({ path, digest }) => ({ path, digest })),
        migrations: input.migrations.map(({ path, digest }) => ({ path, digest })),
      }),
  };
}

/** Remove only RPC-owned root disposal metadata, never payload or evidence keys. */
function providerRpcResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  let dispose: ((this: object) => unknown) | undefined;
  const invalid = () => failed("unavailable", "Provider executor returned invalid RPC data", true);
  try {
    const disposer = Object.getOwnPropertyDescriptor(value, Symbol.dispose);
    if (disposer) {
      if (!("value" in disposer) || typeof disposer.value !== "function") return invalid();
      dispose = disposer.value;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const result = Object.create(prototype) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (key === Symbol.dispose) continue;
      if (typeof key !== "string") return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return invalid();
      // Preserve unknown/non-enumerable string keys for the strict decoder to reject.
      // Nested evidence is deliberately left untouched.
      Object.defineProperty(result, key, descriptor);
    }
    return result;
  } catch {
    return invalid();
  } finally {
    if (dispose) {
      try {
        void Promise.resolve(dispose.call(value)).catch(() => undefined);
      } catch {
        // Transport cleanup failure cannot replace the provider's result.
      }
    }
  }
}

/**
 * Value-free catalog MeterSources. Each read crosses only the bounded typed
 * executor RPC; the public Worker never imports Cloudflare analytics transport
 * or holds a parent-account credential.
 */
export function createCloudflareProviderMeterProxySources(input: {
  readonly offerings: readonly ProviderOffering[];
  readonly binding: CloudflareProviderExecutorRpc;
}): readonly MeterSource[] {
  const bySource = new Map<
    string,
    {
      readonly descriptor: CloudflareProviderMeterSourceDescriptor;
      readonly offerings: ProviderOffering[];
    }
  >();
  for (const offering of input.offerings) {
    const descriptor = cloudflareProviderMeterSourceForOfferingKind(offering.form.kind);
    if (!descriptor) continue;
    const current = bySource.get(descriptor.id);
    if (current) {
      current.offerings.push(structuredClone(offering));
    } else {
      bySource.set(descriptor.id, {
        descriptor,
        offerings: [structuredClone(offering)],
      });
    }
  }
  return [...bySource.values()].map(({ descriptor, offerings }) => ({
    ...descriptor,
    meters: [...descriptor.meters],
    async read({ tenantId, deployment, from, until }) {
      const matching = offerings.filter(
        (offering) =>
          offering.id === deployment.offeringId &&
          cloudflareProviderMeterSourceForOfferingKind(offering.form.kind)?.id === descriptor.id,
      );
      if (tenantId !== deployment.tenantId || matching.length !== 1) {
        throw new ProviderMeterError("upstream_invalid");
      }
      const result = await input.binding.readMeterUsage({
        meterSourceId: descriptor.id,
        meters: descriptor.meters,
        offering: matching[0] as ProviderOffering,
        tenantId,
        deployment,
        from,
        until,
      });
      if (!result.ok) throw new ProviderMeterError(result.error.code);
      return result.value;
    },
  }));
}

function normalizeManagedBaseDomain(value: string): string {
  const normalized = value.toLowerCase().replace(/\.$/u, "");
  if (
    normalized.length > 253 ||
    normalized.includes("workers.dev") ||
    !normalized.includes(".") ||
    normalized.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw new TypeError("invalid Cloudflare managed base domain");
  }
  return normalized;
}

interface InitialMutationContext {
  readonly action: "apply" | "delete" | "adopt";
  readonly operationId: string;
  readonly operationMode: "initial" | "recovery" | undefined;
  readonly providerInstallationId: string;
  readonly tenantId: string;
  readonly resourceUid: string | undefined;
  readonly executionAuthority: ProviderExecutionAuthority | undefined;
}

interface InitialMutationInput {
  readonly operationId: string;
  readonly operationMode?: "initial" | "recovery";
  readonly executionAuthority?: ProviderExecutionAuthority;
  readonly identity: ResourceIdentity;
}

const EXECUTION_AUTHORITY_KEYS = ["tenantId", "resourceUid", "leaseToken", "fingerprint"] as const;

function snapshotInitialMutationContext(
  action: InitialMutationContext["action"],
  input: InitialMutationInput,
  providerInstallationId: string,
): InitialMutationContext {
  return {
    action,
    operationId: input.operationId,
    operationMode: input.operationMode,
    providerInstallationId,
    tenantId: input.identity.tenantRef,
    resourceUid: input.identity.uid,
    executionAuthority: snapshotExecutionAuthority(input.executionAuthority),
  };
}

function snapshotExecutionAuthority(value: unknown): ProviderExecutionAuthority | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const authority = value as Record<string, unknown>;
  if (
    !Object.hasOwn(authority, "tenantId") ||
    typeof authority.tenantId !== "string" ||
    !Object.hasOwn(authority, "resourceUid") ||
    typeof authority.resourceUid !== "string" ||
    !Object.hasOwn(authority, "leaseToken") ||
    typeof authority.leaseToken !== "string" ||
    !Object.hasOwn(authority, "fingerprint") ||
    typeof authority.fingerprint !== "string"
  ) {
    return undefined;
  }
  return {
    tenantId: authority.tenantId,
    resourceUid: authority.resourceUid,
    leaseToken: authority.leaseToken,
    fingerprint: authority.fingerprint,
  };
}

function restoreInitialMutationResult(
  value: unknown,
  context: InitialMutationContext,
): ProviderTicket {
  if (typeof value !== "object" || value === null) {
    return value as ProviderTicket;
  }
  const hasInvocationEvidence = Object.hasOwn(value, "executorNoMutation");
  const hasAdoptionAbort = Object.hasOwn(value, "executorAdoptionAbort");
  if (
    Object.hasOwn(value, "executorApplyNoEffect") ||
    Object.hasOwn(value, "executorApplyNoEffectUnsupported") ||
    Object.hasOwn(value, "executorApplyCompensation") ||
    Object.hasOwn(value, "executorApplyCompensationUnsupported") ||
    Object.hasOwn(value, "executorApplyAbort")
  )
    return invalidInitialMutationEvidence();
  if (!hasInvocationEvidence && !hasAdoptionAbort) return value as ProviderTicket;
  if (!hasInvocationEvidence) return invalidInitialMutationEvidence();

  const ticket = maybeExactRecord(value, ["phase", "failure", "executorNoMutation"]);
  const failure = ticket
    ? maybeExactRecord(ticket.failure, ["code", "message", "retryable"])
    : null;
  const evidence = ticket
    ? maybeExactRecord(ticket.executorNoMutation, [
        "schema",
        "action",
        "operationId",
        "providerInstallationRef",
        "executionAuthority",
      ])
    : null;
  const authority = evidence
    ? maybeExactRecord(evidence.executionAuthority, EXECUTION_AUTHORITY_KEYS)
    : null;

  if (
    ticket?.phase !== "failed" ||
    !failure ||
    !isProviderFailureCode(failure.code) ||
    !boundedString(failure.message, 1, 1_024) ||
    failure.retryable !== false ||
    !evidence ||
    evidence.schema !== CLOUDFLARE_PROVIDER_EXECUTOR_NO_MUTATION_SCHEMA ||
    evidence.action !== context.action ||
    evidence.operationId !== context.operationId ||
    evidence.providerInstallationRef !== context.providerInstallationId ||
    context.operationMode !== "initial" ||
    !context.executionAuthority ||
    typeof context.tenantId !== "string" ||
    typeof context.resourceUid !== "string" ||
    context.executionAuthority.tenantId !== context.tenantId ||
    context.executionAuthority.resourceUid !== context.resourceUid ||
    !authority ||
    authority.tenantId !== context.executionAuthority.tenantId ||
    authority.resourceUid !== context.executionAuthority.resourceUid ||
    authority.leaseToken !== context.executionAuthority.leaseToken ||
    authority.fingerprint !== context.executionAuthority.fingerprint
  ) {
    return invalidInitialMutationEvidence();
  }

  return failedWithoutProviderMutation(context.operationId, failure.code, failure.message);
}

interface AdoptionRecoveryContext {
  readonly operationId: string;
  readonly operationMode: "initial" | "recovery" | undefined;
  readonly providerHandle: string | undefined;
  readonly providerInstallationId: string;
  readonly tenantId: string;
  readonly resourceUid: string | undefined;
  readonly executionAuthority: ProviderExecutionAuthority | undefined;
}

interface AdoptionRecoveryInput extends InitialMutationInput {
  readonly providerHandle?: string;
}

function snapshotAdoptionRecoveryContext(
  input: AdoptionRecoveryInput,
  providerInstallationId: string,
): AdoptionRecoveryContext {
  return {
    operationId: input.operationId,
    operationMode: input.operationMode,
    providerHandle: input.providerHandle,
    providerInstallationId,
    tenantId: input.identity.tenantRef,
    resourceUid: input.identity.uid,
    executionAuthority: snapshotExecutionAuthority(input.executionAuthority),
  };
}

function restoreAdoptionRecoveryResult(
  value: unknown,
  context: AdoptionRecoveryContext,
): ProviderTicket {
  if (typeof value !== "object" || value === null) return value as ProviderTicket;
  if (
    Object.hasOwn(value, "executorApplyNoEffect") ||
    Object.hasOwn(value, "executorApplyNoEffectUnsupported") ||
    Object.hasOwn(value, "executorApplyCompensation") ||
    Object.hasOwn(value, "executorApplyCompensationUnsupported") ||
    Object.hasOwn(value, "executorApplyAbort")
  )
    return invalidAdoptionAbortEvidence();
  const hasAdoptionAbort = Object.hasOwn(value, "executorAdoptionAbort");
  const hasInvocationEvidence = Object.hasOwn(value, "executorNoMutation");
  if (!hasAdoptionAbort && !hasInvocationEvidence) return value as ProviderTicket;
  if (!hasAdoptionAbort || hasInvocationEvidence) return invalidAdoptionAbortEvidence();

  const ticket = maybeExactRecord(value, ["phase", "failure", "executorAdoptionAbort"]);
  const failure = ticket
    ? maybeExactRecord(ticket.failure, ["code", "message", "retryable"])
    : null;
  const evidence = ticket
    ? maybeExactRecord(ticket.executorAdoptionAbort, [
        "schema",
        "action",
        "operationId",
        "providerInstallationRef",
        "executionAuthority",
      ])
    : null;
  const authority = evidence
    ? maybeExactRecord(evidence.executionAuthority, EXECUTION_AUTHORITY_KEYS)
    : null;

  if (
    ticket?.phase !== "failed" ||
    !failure ||
    !isProviderFailureCode(failure.code) ||
    !boundedString(failure.message, 1, 1_024) ||
    failure.retryable !== false ||
    !evidence ||
    evidence.schema !== CLOUDFLARE_PROVIDER_EXECUTOR_ADOPTION_ABORT_SCHEMA ||
    evidence.action !== "recoverAdopt" ||
    evidence.operationId !== context.operationId ||
    evidence.providerInstallationRef !== context.providerInstallationId ||
    context.operationMode !== "recovery" ||
    context.providerHandle !== undefined ||
    !context.executionAuthority ||
    typeof context.tenantId !== "string" ||
    typeof context.resourceUid !== "string" ||
    context.executionAuthority.tenantId !== context.tenantId ||
    context.executionAuthority.resourceUid !== context.resourceUid ||
    !authority ||
    authority.tenantId !== context.executionAuthority.tenantId ||
    authority.resourceUid !== context.executionAuthority.resourceUid ||
    authority.leaseToken !== context.executionAuthority.leaseToken ||
    authority.fingerprint !== context.executionAuthority.fingerprint
  ) {
    return invalidAdoptionAbortEvidence();
  }

  return failedWithoutProviderOperationMutation(context.operationId, failure.code, failure.message);
}

function restoreApplyConvergenceResult(
  value: unknown,
  context: AdoptionRecoveryContext & { readonly hasPrevious: boolean },
): ProviderTicket {
  if (typeof value !== "object" || value === null) return value as ProviderTicket;
  if (!Object.hasOwn(value, "executorApplyAbort")) return rejectUnexpectedExecutorEvidence(value);
  const ticket = maybeExactRecord(value, ["phase", "failure", "executorApplyAbort"]);
  const failure = ticket
    ? maybeExactRecord(ticket.failure, ["code", "message", "retryable"])
    : null;
  const evidence = ticket
    ? maybeExactRecord(ticket.executorApplyAbort, [
        "schema",
        "action",
        "operationId",
        "providerInstallationRef",
        "executionAuthority",
      ])
    : null;
  const authority = evidence
    ? maybeExactRecord(evidence.executionAuthority, EXECUTION_AUTHORITY_KEYS)
    : null;
  if (
    ticket?.phase !== "failed" ||
    !failure ||
    !isProviderFailureCode(failure.code) ||
    !boundedString(failure.message, 1, 1_024) ||
    failure.retryable !== false ||
    !evidence ||
    evidence.schema !== CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_ABORT_SCHEMA ||
    evidence.action !== "convergeApply" ||
    evidence.operationId !== context.operationId ||
    evidence.providerInstallationRef !== context.providerInstallationId ||
    context.operationMode !== "recovery" ||
    context.providerHandle !== undefined ||
    context.hasPrevious ||
    !context.executionAuthority ||
    typeof context.tenantId !== "string" ||
    typeof context.resourceUid !== "string" ||
    context.executionAuthority.tenantId !== context.tenantId ||
    context.executionAuthority.resourceUid !== context.resourceUid ||
    !authority ||
    authority.tenantId !== context.executionAuthority.tenantId ||
    authority.resourceUid !== context.executionAuthority.resourceUid ||
    authority.leaseToken !== context.executionAuthority.leaseToken ||
    authority.fingerprint !== context.executionAuthority.fingerprint
  )
    return failed("unavailable", "Provider executor returned invalid apply-abort evidence", true);
  return failedWithoutProviderOperationMutation(context.operationId, failure.code, failure.message);
}

interface ApplyNoEffectContext {
  readonly operationId: string;
  readonly providerInstallationId: string;
  readonly selectionMatchesInstallation: boolean;
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly executionAuthority: ProviderExecutionAuthority | undefined;
}

function snapshotApplyConclusionContext(
  input: ProviderApplyNoEffectConclusionInput | ProviderApplyCompensationInput,
  providerInstallationId: string,
): ApplyNoEffectContext {
  return {
    operationId: input.operationId,
    providerInstallationId,
    selectionMatchesInstallation: input.providerInstallationRef === providerInstallationId,
    tenantId: input.identity.tenantRef,
    resourceUid: input.identity.uid,
    executionAuthority: snapshotExecutionAuthority(input.executionAuthority),
  };
}

function snapshotApplyNoEffectContext(
  input: ProviderApplyNoEffectConclusionInput,
  providerInstallationId: string,
): ApplyNoEffectContext {
  return snapshotApplyConclusionContext(input, providerInstallationId);
}

function restoreApplyNoEffectConclusionResult(
  value: unknown,
  context: ApplyNoEffectContext,
): ProviderApplyNoEffectConclusionResult {
  if (typeof value !== "object" || value === null) return value as ProviderTicket;
  if (Object.hasOwn(value, "executorApplyNoEffectUnsupported")) {
    const unsupported = maybeExactRecord(value, ["phase", "executorApplyNoEffectUnsupported"]);
    const evidence = unsupported
      ? maybeExactRecord(unsupported.executorApplyNoEffectUnsupported, [
          "schema",
          "action",
          "operationId",
          "providerInstallationRef",
          "executionAuthority",
        ])
      : null;
    const authority = evidence
      ? maybeExactRecord(evidence.executionAuthority, EXECUTION_AUTHORITY_KEYS)
      : null;
    if (
      unsupported?.phase === "unsupported" &&
      evidence?.schema === CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_NO_EFFECT_SCHEMA &&
      evidence.action === "unsupported" &&
      evidence.operationId === context.operationId &&
      evidence.providerInstallationRef === context.providerInstallationId &&
      context.selectionMatchesInstallation &&
      context.executionAuthority &&
      context.executionAuthority.tenantId === context.tenantId &&
      context.executionAuthority.resourceUid === context.resourceUid &&
      authority?.tenantId === context.executionAuthority.tenantId &&
      authority.resourceUid === context.executionAuthority.resourceUid &&
      authority.leaseToken === context.executionAuthority.leaseToken &&
      authority.fingerprint === context.executionAuthority.fingerprint
    ) {
      return { phase: "unsupported" };
    }
    return failed(
      "unavailable",
      "Provider executor returned invalid apply no-effect evidence",
      true,
    );
  }
  if (!Object.hasOwn(value, "executorApplyNoEffect")) {
    if (
      Object.hasOwn(value, "phase") &&
      (value as { readonly phase?: unknown }).phase === "unsupported"
    ) {
      return failed(
        "unavailable",
        "Provider executor returned invalid apply no-effect evidence",
        true,
      );
    }
    return rejectUnexpectedExecutorEvidence(value);
  }
  const ticket = maybeExactRecord(value, ["phase", "failure", "executorApplyNoEffect"]);
  const failure = ticket
    ? maybeExactRecord(ticket.failure, ["code", "message", "retryable"])
    : null;
  const evidence = ticket
    ? maybeExactRecord(ticket.executorApplyNoEffect, [
        "schema",
        "action",
        "operationId",
        "providerInstallationRef",
        "executionAuthority",
      ])
    : null;
  const authority = evidence
    ? maybeExactRecord(evidence.executionAuthority, EXECUTION_AUTHORITY_KEYS)
    : null;
  if (
    ticket?.phase !== "failed" ||
    !failure ||
    !isProviderFailureCode(failure.code) ||
    !boundedString(failure.message, 1, 1_024) ||
    failure.retryable !== false ||
    !evidence ||
    evidence.schema !== CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_NO_EFFECT_SCHEMA ||
    evidence.action !== "concludeApplyNoEffect" ||
    evidence.operationId !== context.operationId ||
    evidence.providerInstallationRef !== context.providerInstallationId ||
    !context.selectionMatchesInstallation ||
    !context.executionAuthority ||
    typeof context.tenantId !== "string" ||
    typeof context.resourceUid !== "string" ||
    context.executionAuthority.tenantId !== context.tenantId ||
    context.executionAuthority.resourceUid !== context.resourceUid ||
    !authority ||
    authority.tenantId !== context.executionAuthority.tenantId ||
    authority.resourceUid !== context.executionAuthority.resourceUid ||
    authority.leaseToken !== context.executionAuthority.leaseToken ||
    authority.fingerprint !== context.executionAuthority.fingerprint
  )
    return failed(
      "unavailable",
      "Provider executor returned invalid apply no-effect evidence",
      true,
    );
  return failedWithoutProviderOperationMutation(context.operationId, failure.code, failure.message);
}

function restoreApplyCompensationResult(
  value: unknown,
  context: ApplyNoEffectContext,
): ProviderApplyCompensationResult {
  if (typeof value !== "object" || value === null) return value as ProviderTicket;
  if (Object.hasOwn(value, "executorApplyCompensationUnsupported")) {
    const unsupported = maybeExactRecord(value, ["phase", "executorApplyCompensationUnsupported"]);
    const evidence = unsupported
      ? maybeExactRecord(unsupported.executorApplyCompensationUnsupported, [
          "schema",
          "action",
          "operationId",
          "providerInstallationRef",
          "executionAuthority",
        ])
      : null;
    const authority = evidence
      ? maybeExactRecord(evidence.executionAuthority, EXECUTION_AUTHORITY_KEYS)
      : null;
    if (
      unsupported?.phase === "unsupported" &&
      evidence?.schema === CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_COMPENSATION_SCHEMA &&
      evidence.action === "unsupported" &&
      evidence.operationId === context.operationId &&
      evidence.providerInstallationRef === context.providerInstallationId &&
      context.selectionMatchesInstallation &&
      context.executionAuthority &&
      context.executionAuthority.tenantId === context.tenantId &&
      context.executionAuthority.resourceUid === context.resourceUid &&
      authority?.tenantId === context.executionAuthority.tenantId &&
      authority.resourceUid === context.executionAuthority.resourceUid &&
      authority.leaseToken === context.executionAuthority.leaseToken &&
      authority.fingerprint === context.executionAuthority.fingerprint
    ) {
      return { phase: "unsupported" };
    }
    return failed("unavailable", "Provider executor returned invalid compensation evidence", true);
  }
  if (!Object.hasOwn(value, "executorApplyCompensation")) {
    if (
      Object.hasOwn(value, "phase") &&
      (value as { readonly phase?: unknown }).phase === "unsupported"
    ) {
      return failed(
        "unavailable",
        "Provider executor returned invalid compensation evidence",
        true,
      );
    }
    return rejectUnexpectedExecutorEvidence(value);
  }
  const ticket = maybeExactRecord(value, ["phase", "failure", "executorApplyCompensation"]);
  const failure = ticket
    ? maybeExactRecord(ticket.failure, ["code", "message", "retryable"])
    : null;
  const evidence = ticket
    ? maybeExactRecord(ticket.executorApplyCompensation, [
        "schema",
        "action",
        "operationId",
        "providerInstallationRef",
        "executionAuthority",
      ])
    : null;
  const authority = evidence
    ? maybeExactRecord(evidence.executionAuthority, EXECUTION_AUTHORITY_KEYS)
    : null;
  if (
    ticket?.phase !== "failed" ||
    !failure ||
    !isProviderFailureCode(failure.code) ||
    !boundedString(failure.message, 1, 1_024) ||
    failure.retryable !== false ||
    !evidence ||
    evidence.schema !== CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_COMPENSATION_SCHEMA ||
    evidence.action !== "compensateApply" ||
    evidence.operationId !== context.operationId ||
    evidence.providerInstallationRef !== context.providerInstallationId ||
    !context.selectionMatchesInstallation ||
    !context.executionAuthority ||
    context.executionAuthority.tenantId !== context.tenantId ||
    context.executionAuthority.resourceUid !== context.resourceUid ||
    !authority ||
    authority.tenantId !== context.executionAuthority.tenantId ||
    authority.resourceUid !== context.executionAuthority.resourceUid ||
    authority.leaseToken !== context.executionAuthority.leaseToken ||
    authority.fingerprint !== context.executionAuthority.fingerprint
  ) {
    return failed("unavailable", "Provider executor returned invalid compensation evidence", true);
  }
  return failedAfterProviderOperationCompensation(
    context.operationId,
    failure.code,
    failure.message,
  );
}

function rejectUnexpectedExecutorEvidence(value: unknown): ProviderTicket {
  if (
    typeof value === "object" &&
    value !== null &&
    (Object.hasOwn(value, "executorApplyNoEffect") ||
      Object.hasOwn(value, "executorApplyNoEffectUnsupported") ||
      Object.hasOwn(value, "executorApplyCompensation") ||
      Object.hasOwn(value, "executorApplyCompensationUnsupported") ||
      Object.hasOwn(value, "executorApplyAbort") ||
      Object.hasOwn(value, "executorAdoptionAbort") ||
      Object.hasOwn(value, "executorNoMutation"))
  )
    return failed(
      "unavailable",
      "Provider executor returned evidence on an unauthorized seam",
      true,
    );
  return value as ProviderTicket;
}

function invalidInitialMutationEvidence(): ProviderTicket {
  return failed("unavailable", "Provider executor returned invalid no-mutation evidence", true);
}

function invalidAdoptionAbortEvidence(): ProviderTicket {
  return failed("unavailable", "Provider executor returned invalid adoption-abort evidence", true);
}

function isProviderFailureCode(value: unknown): value is ProviderFailure["code"] {
  return (
    value === "invalid_spec" ||
    value === "conflict" ||
    value === "occupied" ||
    value === "not_found" ||
    value === "denied" ||
    value === "unavailable" ||
    value === "quota" ||
    value === "provider_error" ||
    value === "timeout"
  );
}
