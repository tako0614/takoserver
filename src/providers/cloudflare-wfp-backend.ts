import { isEdgeFormsApiVersion } from "../form-ref.ts";
import type { JsonObject, JsonValue } from "../ports.ts";
import {
  type ApplyInput,
  failed,
  PROVIDER_READBACK_API_VERSION,
  type ProviderArtifactConsumption,
  type ProviderArtifactConsumptionInput,
  type ProviderNativeAbsence,
  type ProviderNativeReadbackDescriptor,
  type ProviderNativeReadbackInput,
  type ProviderOffering,
  ProviderReadbackDescriptorError,
  type ProviderRelation,
  type ProviderSqliteMigration,
  type ProviderSqliteMigrationIdentity,
  type ProviderTicket,
  type ProviderValue,
  type ResourceIdentity,
  succeeded,
} from "../provider-port.ts";
import type {
  ProviderRuntimeInputDispatchedLease,
  ProviderRuntimeInputLease,
  ProviderRuntimeInputLeasePort,
  ProviderRuntimeInputPublicApply,
  ProviderRuntimeInputRecoveryLease,
} from "../provider-runtime-input-port.ts";
import {
  canonicalWorkerEndpointOrigin,
  derivedProviderResourceName,
} from "../provider-worker-endpoint-origin.ts";
import {
  managedWorkerHostRouteKey,
  managedWorkerQueueRouteKey,
  managedWorkerReleaseRouteKey,
  managedWorkerScheduleRouteKey,
  TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS,
} from "./cloudflare-managed-worker-gateway.ts";
import type {
  ManagedWorkerSqliteAdminOperation,
  ManagedWorkerSqliteAdminResult,
  ManagedWorkerSqliteAuthority,
  ManagedWorkerSqliteInspectResult,
} from "./cloudflare-managed-worker-sqlite.ts";
import {
  MANAGED_WORKER_EDGE_OBJECTS_BINDING_KIND,
  MANAGED_WORKER_EDGE_SQL_BINDING_KIND,
  MANAGED_WORKER_HANDLER_NAMES,
  MANAGED_WORKER_INTERNAL_BINDING_PREFIX,
  type ManagedWorkerBindingDescriptor,
  type ManagedWorkerHandlerName,
  managedWorkerEntrypointSource,
} from "./cloudflare-managed-worker-wrapper.ts";
import {
  cloudflareR2EdgeObjectsMaterial,
  EDGE_OBJECTS_BINDING_REF,
} from "./cloudflare-runtime-bindings.ts";
import {
  CloudflareWfpClient,
  type CloudflareWfpClientResult,
  type CloudflareWfpScriptReadback,
} from "./cloudflare-wfp-client.ts";
import type {
  ArtifactBytes,
  CloudflareManagedScheduleOperatorProof,
  CloudflareManagedScheduleReconciliationStatus,
  CloudflareManagedSqliteAdminRequest,
  CloudflareManagedSqliteNamespace,
  CloudflareWorkerBackend,
  CloudflareWorkerDeleteInput,
  CloudflareWorkersForPlatformsBackendOptions,
} from "./cloudflare-worker-backend.ts";
import {
  type ManagedWorkerReceipt,
  type ManagedWorkerRoutePredecessor,
  type ManagedWorkerRouteState,
  ManagedWorkerState,
  ManagedWorkerStateCorruptionError,
} from "./managed-worker-state.ts";

const WORKER_COMPATIBILITY_DATE = "2026-08-19";
/**
 * Compatibility flags every managed tenant user Worker is uploaded with.
 *
 * A binding belongs to the script it is declared on, and the runtime hands
 * every one of them to every module that script runs — including through
 * `import { env } from "cloudflare:workers"`. So the wrapper's projected `env`
 * never hid the raw `__TAKOSERVER_SQLITE_<i>` Durable Object namespace or the
 * `__TAKOSERVER_OBJECTS_<i>` R2 handle: it only declined to hand them over.
 * `disallow_importable_env` makes the importable environment empty while the
 * handler's own `env` argument keeps its bindings, which is what actually
 * closes that door. The self-host backend sets the same flag for the same
 * reason; see `src/workerd-runtime.ts`.
 */
const MANAGED_WORKER_COMPATIBILITY_FLAGS = ["disallow_importable_env"] as const;
const MANAGED_SQLITE_CLASS = "TakoserverManagedWorkerSqlite";
const MAX_MODULES = 512;
const MAX_MODULE_BYTES = 32 * 1024 * 1024;

const MANAGED_FORM_KINDS = new Set([
  "ModuleWorker",
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerEndpoint",
  "WorkerCustomDomain",
  "WorkerCronTrigger",
  "QueueConsumer",
  "SQLiteDatabase",
]);

export interface CloudflareWfpBackendOptions extends CloudflareWorkersForPlatformsBackendOptions {
  readonly providerId: string;
  readonly accountId: string;
  readonly apiOrigin: string;
  readonly authorize: () => Promise<string> | string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly artifacts: ArtifactBytes;
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
  readonly workerCompatibilityDate?: string;
}

interface ManagedBindingClosure {
  readonly metadata: readonly Readonly<Record<string, unknown>>[];
  readonly wrapper: readonly ManagedWorkerBindingDescriptor[];
}

interface ManagedReleaseClosure {
  readonly logicalWorkerId: string;
  readonly resourceUid: string;
  readonly operationId: string;
  readonly descriptorDigest: `sha256:${string}`;
  readonly releaseScript: string;
  readonly nativeId: string;
  readonly declaredHandlers: readonly ManagedWorkerHandlerName[];
  readonly requiredSensitive: readonly string[];
  readonly wrapperModule: string;
  readonly wrapperSource: string;
  readonly uploadMetadata: Readonly<Record<string, unknown>>;
  readonly settingsIdentity: Readonly<Record<string, unknown>>;
  readonly modules: readonly {
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }[];
  readonly manifestDigest: string;
  readonly runtimeInputCommitment?: `sha256:${string}`;
  readonly workerResource: ProviderRelation["resource"];
  readonly bundleResource: ProviderRelation["resource"];
}

interface ManagedScheduleFence {
  readonly generation: number;
  readonly digest: `sha256:${string}`;
  readonly leaseToken: string;
  readonly now: number;
}

/** Complete official Cloudflare Workers-for-Platforms lifecycle owner. */
export class CloudflareWfpBackend implements CloudflareWorkerBackend {
  readonly kind = "workers-for-platforms" as const;
  readonly dispatchNamespace: string;
  readonly gatewayWorkerName: string;
  readonly managedBaseDomain: string;
  readonly #providerId: string;
  readonly #accountId: string;
  readonly #artifacts: ArtifactBytes;
  readonly #runtimeInputs: ProviderRuntimeInputLeasePort | undefined;
  readonly #compatibilityDate: string;
  readonly #state: ManagedWorkerState;
  readonly #client: CloudflareWfpClient;
  readonly #inspectRelease: CloudflareWorkersForPlatformsBackendOptions["inspectRelease"];
  readonly #pendingReleaseReadbackQualified: boolean;
  readonly #deriveSqliteInstanceName: CloudflareWorkersForPlatformsBackendOptions["deriveSqliteInstanceName"];
  readonly #sealSqliteAdminProof: CloudflareWorkersForPlatformsBackendOptions["sealSqliteAdminProof"];
  readonly #sqliteNamespace: CloudflareManagedSqliteNamespace;

  constructor(options: CloudflareWfpBackendOptions) {
    this.#providerId = nativeToken(options.providerId, "provider id");
    this.#accountId = nativeToken(options.accountId, "account id");
    this.dispatchNamespace = nativeToken(options.dispatchNamespace, "dispatch namespace");
    this.gatewayWorkerName = nativeToken(options.gatewayWorkerName, "gateway Worker");
    this.managedBaseDomain = managedBaseDomain(options.managedBaseDomain);
    this.#artifacts = options.artifacts;
    this.#runtimeInputs = options.runtimeInputs;
    this.#compatibilityDate = compatibilityDate(
      options.workerCompatibilityDate ?? WORKER_COMPATIBILITY_DATE,
    );
    this.#state = new ManagedWorkerState(this.#providerId, options.sql);
    this.#client = new CloudflareWfpClient({
      accountId: this.#accountId,
      dispatchNamespace: this.dispatchNamespace,
      apiOrigin: options.apiOrigin,
      authorize: options.authorize,
      fetch: options.fetch,
    });
    this.#inspectRelease = options.inspectRelease;
    const qualification = options.releaseReadbackQualification;
    if (
      qualification !== undefined &&
      (qualification.schema !== "takoserver.cloudflare-wfp-release-readback-qualification@v1" ||
        qualification.dispatchNamespace !== this.dispatchNamespace ||
        !sha256(qualification.rehearsalDigest))
    ) {
      throw new TypeError("invalid managed Worker release readback qualification");
    }
    this.#pendingReleaseReadbackQualified = qualification !== undefined;
    this.#deriveSqliteInstanceName = options.deriveSqliteInstanceName;
    this.#sealSqliteAdminProof = options.sealSqliteAdminProof;
    this.#sqliteNamespace = options.sqliteNamespace;
  }

  async deriveOrigin(input: {
    readonly tenantRef: string;
    readonly requestedSubdomain: string;
  }): Promise<{ readonly canonicalPublicOrigin: string } | null> {
    const canonicalPublicOrigin = canonicalWorkerEndpointOrigin(
      input.requestedSubdomain,
      this.managedBaseDomain,
    );
    return canonicalPublicOrigin ? { canonicalPublicOrigin } : null;
  }

  owns(offering: ProviderOffering): boolean {
    if (offering.kind === "worker_script") return true;
    // Placement mode is an adapter boundary, not a catalog hint. Capture
    // every Worker-shaped Form before API-version validation so a stale or
    // caller-supplied offering can never fall through to ordinary Workers.
    return MANAGED_FORM_KINDS.has(offering.form.kind);
  }

  async apply(input: ApplyInput): Promise<ProviderTicket> {
    if (!this.owns(input.offering)) {
      return failed("invalid_spec", "this resource does not belong to the managed Worker backend");
    }
    if (input.providerHandle) {
      return failed(
        "unavailable",
        "the managed Worker backend has no opaque provider handle",
        true,
      );
    }
    const kind = providerKind(input.offering);
    if (kind === "worker_script" || kind === "WorkerCustomDomain") {
      return failed(
        "denied",
        "ordinary Workers and custom domains are unavailable in this managed provider mode",
      );
    }
    const recovery = input.operationMode !== "initial";
    try {
      switch (kind) {
        case "ModuleWorker":
          return await this.#applyModuleWorker(input);
        case "WorkerVersion":
          return await this.#applyWorkerVersion(input, recovery);
        case "WorkerDeployment":
          return await this.#applyWorkerDeployment(input);
        case "WorkerEndpoint":
          return await this.#applyWorkerEndpoint(input);
        case "WorkerCronTrigger":
          return await this.#applyWorkerCronTrigger(input);
        case "QueueConsumer":
          return await this.#applyQueueConsumer(input, recovery);
        case "SQLiteDatabase":
          return await this.#applySqliteDatabase(input, recovery);
        default:
          return failed("invalid_spec", "the managed Worker resource kind is unavailable");
      }
    } catch (error) {
      return managedStateTicketFailure(error);
    }
  }

  async recoverApply(input: ApplyInput): Promise<ProviderTicket> {
    if (!this.owns(input.offering)) {
      return failed("invalid_spec", "this resource does not belong to the managed Worker backend");
    }
    const kind = providerKind(input.offering);
    if (kind === "worker_script" || kind === "WorkerCustomDomain") {
      return failed(
        "denied",
        "ordinary Workers and custom domains are unavailable in this managed provider mode",
      );
    }
    const resourceUid = input.identity.uid;
    if (!resourceUid) return failed("invalid_spec", "the managed resource UID is missing");
    try {
      const receipt = await this.#state.receiptByResourceUid(resourceUid);
      if (!receipt || receipt.state === "deleted") {
        return failed("not_found", "the managed resource is absent");
      }
      if (receipt.state === "pending" && receipt.kind === "version") {
        const native = parseManagedNativeId(receipt.nativeId);
        if (native?.kind !== "version") {
          return failed("provider_error", "the managed Worker release receipt is malformed");
        }
        const absent = await this.#client.scriptAbsent(native.name);
        if (absent.ok === false) {
          return wfpFailure(absent, "the managed Worker release readback failed");
        }
        return absent.value
          ? failed("not_found", "the managed Worker release upload did not occur")
          : failed(
              "unavailable",
              "the managed resource mutation requires operation-keyed convergence",
              true,
            );
      }
      if (receipt.operationId !== input.operationId || receipt.state !== "committed") {
        return failed(
          "unavailable",
          "the managed resource mutation requires operation-keyed convergence",
          true,
        );
      }
      return await this.observe({
        offering: input.offering,
        nativeId: receipt.nativeId,
        identity: input.identity,
        spec: input.spec,
        ...(input.relations ? { relations: input.relations } : {}),
      });
    } catch (error) {
      return managedStateTicketFailure(error);
    }
  }

  async convergeApply(input: ApplyInput): Promise<ProviderTicket> {
    return await this.apply({ ...input, operationMode: "recovery" });
  }

  async observe(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket> {
    if (!this.owns(input.offering)) {
      return failed("invalid_spec", "this resource does not belong to the managed Worker backend");
    }
    const kind = providerKind(input.offering);
    if (kind === "worker_script" || kind === "WorkerCustomDomain") {
      return failed("not_found", "ordinary Worker placement is absent in managed provider mode");
    }
    if (!input.identity.uid) return failed("invalid_spec", "the managed resource UID is missing");
    try {
      switch (kind) {
        case "WorkerVersion":
          return await this.#observeWorkerVersion(input.identity.uid, input.nativeId, input);
        case "WorkerDeployment":
          return await this.#observeDeployment(input.identity.uid, input.nativeId);
        case "WorkerEndpoint":
          return await this.#observeEndpoint(input.identity.uid, input.nativeId);
        case "WorkerCronTrigger":
          return await this.#observeCron(input.identity.uid, input.nativeId);
        case "QueueConsumer":
          return await this.#observeQueueConsumer(input.identity.uid, input.nativeId);
        case "SQLiteDatabase":
          return await this.#observeSqlite(input.identity.uid, input.nativeId);
        case "ModuleWorker":
          return await this.#observeReceipt(input.identity.uid, input.nativeId, "worker");
        default:
          return failed("not_found", "the managed resource is absent");
      }
    } catch (error) {
      return managedStateTicketFailure(error);
    }
  }

  async delete(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket> {
    if (!this.owns(input.offering)) {
      return failed("invalid_spec", "this resource does not belong to the managed Worker backend");
    }
    const kind = providerKind(input.offering);
    if (kind === "worker_script" || kind === "WorkerCustomDomain") {
      return failed("not_found", "ordinary Worker placement is absent in managed provider mode");
    }
    if (!input.identity.uid) return failed("invalid_spec", "the managed resource UID is missing");
    const recovery = input.operationMode !== "initial";
    try {
      switch (kind) {
        case "WorkerVersion":
          return await this.#deleteWorkerVersion(input, recovery);
        case "WorkerDeployment":
          return await this.#deleteDeployment(input);
        case "WorkerEndpoint":
          return await this.#deleteEndpoint(input);
        case "WorkerCronTrigger":
          return await this.#deleteCron(input);
        case "QueueConsumer":
          return await this.#deleteQueueConsumer(input);
        case "SQLiteDatabase":
          return await this.#deleteSqlite(input);
        case "ModuleWorker":
          return await this.#deleteModuleWorker(input);
        default:
          return failed("not_found", "the managed resource is absent");
      }
    } catch (error) {
      return managedStateTicketFailure(error);
    }
  }

  async recoverDelete(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket> {
    return await this.delete({ ...input, operationMode: "recovery" });
  }

  createNativeReadbackDescriptor(
    input: ProviderNativeReadbackInput,
  ): ProviderNativeReadbackDescriptor {
    if (!this.owns(input.offering) || !input.identity.uid || !managedNativeId(input.nativeId)) {
      throw new ProviderReadbackDescriptorError();
    }
    return {
      apiVersion: PROVIDER_READBACK_API_VERSION,
      provider: this.#providerId,
      kind: providerKind(input.offering),
      nativeId: input.nativeId,
      data: { resourceUid: input.identity.uid },
    };
  }

  async verifyNativeAbsence(input: {
    readonly offering: ProviderOffering;
    readonly descriptor: ProviderNativeReadbackDescriptor;
  }): Promise<ProviderNativeAbsence> {
    const raw = record(input.descriptor);
    const data = record(raw?.data);
    const kind = providerKind(input.offering);
    const native = typeof raw?.nativeId === "string" ? parseManagedNativeId(raw.nativeId) : null;
    if (
      !this.owns(input.offering) ||
      raw?.apiVersion !== PROVIDER_READBACK_API_VERSION ||
      raw.provider !== this.#providerId ||
      raw.kind !== kind ||
      !native ||
      (kind === "WorkerVersion") !== (native.kind === "version") ||
      !data ||
      Object.keys(data).length !== 1 ||
      typeof data.resourceUid !== "string"
    ) {
      return { outcome: "unknown", reason: "malformed", retryable: false };
    }
    if (native.kind === "version") {
      return await this.#verifyWorkerVersionNativeAbsence(native.name, kind);
    }
    let receipt: ManagedWorkerReceipt | null;
    try {
      receipt = await this.#state.receiptByResourceUid(data.resourceUid);
    } catch (error) {
      return error instanceof ManagedWorkerStateCorruptionError
        ? { outcome: "unknown", reason: "malformed", retryable: false }
        : { outcome: "unknown", reason: "transport", retryable: true };
    }
    if (!receipt || receipt.nativeId !== raw.nativeId) {
      return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
    }
    if (receipt.state === "pending" || receipt.state === "deleting") {
      return { outcome: "unknown", reason: "authority_unavailable", retryable: true };
    }
    if (receipt.state === "deleted") {
      return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
    }
    if (receipt.kind === "version") {
      return { outcome: "unknown", reason: "malformed", retryable: false };
    }
    return absence("present", this.#providerId, kind);
  }

  async #verifyWorkerVersionNativeAbsence(
    scriptName: string,
    kind: string,
  ): Promise<ProviderNativeAbsence> {
    const absent = await this.#client.scriptAbsent(scriptName);
    if (absent.ok === false) return absenceFailure(absent);
    return absence(absent.value ? "absent" : "present", this.#providerId, kind);
  }

  async verifyArtifactConsumption(
    input: ProviderArtifactConsumptionInput,
  ): Promise<ProviderArtifactConsumption> {
    const kind = providerKind(input.offering);
    const native = parseManagedNativeId(input.nativeId);
    if (
      !this.owns(input.offering) ||
      !native ||
      (kind === "WorkerVersion") !== (native.kind === "version")
    ) {
      return { outcome: "unknown", reason: "malformed", retryable: false };
    }

    // The receipt is Takoserver's attribution authority, but it is not native
    // absence authority. A WorkerVersion can be terminalized as absent only
    // after a fresh GET of its exact immutable release script returns 404.
    if (native.kind === "version") {
      const nativeAbsence = await this.#verifyWorkerVersionNativeAbsence(native.name, kind);
      if (nativeAbsence.outcome === "unknown") return nativeAbsence;
      if (nativeAbsence.outcome === "absent") {
        return { outcome: "absent", evidence: nativeAbsence.evidence };
      }
    }

    let receipt: ManagedWorkerReceipt | null;
    try {
      receipt = await this.#state.receiptByResourceUid(input.identity.resourceUid);
    } catch (error) {
      return error instanceof ManagedWorkerStateCorruptionError
        ? { outcome: "unknown", reason: "malformed", retryable: false }
        : { outcome: "unknown", reason: "transport", retryable: true };
    }
    if (!receipt || receipt.nativeId !== input.nativeId) {
      return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
    }
    if (receipt.state === "pending" || receipt.state === "deleting") {
      return { outcome: "unknown", reason: "authority_unavailable", retryable: true };
    }
    if (receipt.state === "deleted") {
      return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
    }
    if (native.kind !== "version") {
      if (receipt.kind === "version") {
        return { outcome: "unknown", reason: "malformed", retryable: false };
      }
      return {
        outcome: "present",
        manifestDigests: [],
        evidence: {
          provider: this.#providerId,
          kind,
          state: "non_artifact_consumer",
        },
      };
    }
    if (receipt.kind !== "version") {
      return { outcome: "unknown", reason: "malformed", retryable: false };
    }
    const manifestDigest = receipt.observed.manifestDigest;
    if (typeof manifestDigest !== "string" || !sha256(manifestDigest)) {
      return { outcome: "unknown", reason: "malformed", retryable: false };
    }
    return {
      outcome: "present",
      manifestDigests: [manifestDigest],
      evidence: {
        provider: this.#providerId,
        kind,
        authority: "managed_release_receipt",
      },
    };
  }

  async readSqliteMigrationLedger(input: {
    readonly nativeId: string;
  }): Promise<ProviderValue<readonly ProviderSqliteMigrationIdentity[]>> {
    const native = parseManagedNativeId(input.nativeId);
    if (native?.kind !== "sqlite") {
      return providerValueFailure("invalid_spec", "the managed SQLite identity is invalid");
    }
    try {
      const authority = await this.#sqliteAuthority(input.nativeId);
      if (!authority) {
        return providerValueFailure("not_found", "the managed SQLite authority is absent");
      }
      const result = await this.#sqliteNamespace
        .getByName(native.name)
        .takoserverSqliteReadMigrationLedger(
          await this.#sealedSqliteRequest("read-migration-ledger", authority),
        );
      if (!result.ok) return sqliteProviderFailure(result.error);
      if (!Array.isArray(result.value)) {
        return providerValueFailure("provider_error", "the managed SQLite ledger is malformed");
      }
      const ledger: ProviderSqliteMigrationIdentity[] = [];
      for (const value of result.value) {
        const row = record(value);
        const path = text(row?.path);
        const digest = sha256Value(row?.digest);
        if (
          !path ||
          !digest ||
          Object.keys(row ?? {})
            .sort()
            .join(",") !== "digest,path"
        ) {
          return providerValueFailure("provider_error", "the managed SQLite ledger is malformed");
        }
        ledger.push({ path, digest });
      }
      return { ok: true, value: ledger };
    } catch (error) {
      return managedStateProviderFailure(error);
    }
  }

  async applySqliteMigrationSuffix(input: {
    readonly nativeId: string;
    readonly expectedPrefix: readonly ProviderSqliteMigrationIdentity[];
    readonly migrations: readonly ProviderSqliteMigration[];
  }): Promise<ProviderValue<undefined>> {
    const native = parseManagedNativeId(input.nativeId);
    if (native?.kind !== "sqlite" || input.migrations.length < 1) {
      return providerValueFailure("invalid_spec", "the managed SQLite migration input is invalid");
    }
    try {
      const authority = await this.#sqliteAuthority(input.nativeId);
      if (!authority) {
        return providerValueFailure("not_found", "the managed SQLite authority is absent");
      }
      for (const migration of input.migrations) {
        if (!migrationPath(migration.path) || !sha256(migration.digest)) throw new TypeError();
        // Validate UTF-8 without changing the byte-oriented RPC authority.
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(migration.sql);
      }
      const result = await this.#sqliteNamespace
        .getByName(native.name)
        .takoserverSqliteApplyMigrationSuffix({
          ...(await this.#sealedSqliteRequest("apply-migration-suffix", authority)),
          expectedPrefix: input.expectedPrefix,
          migrations: input.migrations,
        });
      return result.ok ? { ok: true, value: undefined } : sqliteProviderFailure(result.error);
    } catch (error) {
      return managedStateProviderFailure(error);
    }
  }

  async managedScheduleReconciliationStatus(): Promise<
    ProviderValue<CloudflareManagedScheduleReconciliationStatus>
  > {
    try {
      return { ok: true, value: await this.#managedScheduleStatus(Date.now()) };
    } catch (error) {
      return managedScheduleProviderFailure(error);
    }
  }

  async reconcileManagedSchedules(
    proof: CloudflareManagedScheduleOperatorProof,
  ): Promise<ProviderValue<CloudflareManagedScheduleReconciliationStatus>> {
    if (!validScheduleOperatorProof(proof)) {
      return providerValueFailure("invalid_spec", "the schedule reconciliation proof is invalid");
    }
    try {
      const before = await this.#managedScheduleStatus(Date.now());
      if (
        before.state !== "operator_reconciliation_required" ||
        before.leaseToken !== proof.leaseToken ||
        before.ambiguousGeneration !== proof.ambiguousGeneration ||
        before.desiredGeneration !== proof.desiredGeneration ||
        before.actualDigest !== proof.actualDigest
      ) {
        return providerValueFailure(
          "conflict",
          "the schedule reconciliation proof no longer matches provider authority",
        );
      }
      if (proof.action === "accept-provider-state") {
        if (!sameStrings(before.actualSchedules, before.desiredSchedules)) {
          return providerValueFailure(
            "conflict",
            "the provider schedule set does not match current durable authority",
          );
        }
      } else {
        const write = await this.#client.json(
          "PUT",
          this.#gatewaySchedulesPath(),
          JSON.stringify(before.desiredSchedules.map((cron) => ({ cron }))),
          { "content-type": "application/json" },
        );
        if (write.ok === false) {
          return providerValueFailure(
            "unavailable",
            "the explicit schedule reconciliation mutation is indeterminate",
            false,
          );
        }
        const readback = await this.#readGatewaySchedules();
        if ("failure" in readback) return readback;
        if (!sameStrings(readback.value, before.desiredSchedules)) {
          return providerValueFailure(
            "unavailable",
            "the explicit schedule reconciliation readback differs",
          );
        }
      }
      const digest = await managedScheduleDigest(before.desiredSchedules);
      const completed = await this.#state.completeOperatorScheduleReconciliation({
        leaseToken: proof.leaseToken,
        ambiguousGeneration: proof.ambiguousGeneration,
        desiredGeneration: proof.desiredGeneration,
        appliedDigest: digest,
      });
      if (!completed) {
        return providerValueFailure(
          "conflict",
          "the schedule authority changed during operator reconciliation",
        );
      }
      return { ok: true, value: await this.#managedScheduleStatus(Date.now()) };
    } catch (error) {
      return managedScheduleProviderFailure(error);
    }
  }

  async #managedScheduleStatus(
    now: number,
  ): Promise<CloudflareManagedScheduleReconciliationStatus> {
    const [state, routes, actual] = await Promise.all([
      this.#state.scheduleReconciliationStatus(now),
      this.#state.activeRoutes("schedule"),
      this.#readGatewaySchedules(),
    ]);
    if ("failure" in actual) throw new ManagedScheduleProviderReadError(actual.failure.retryable);
    const desired = scheduleCronsFromRoutes(routes);
    if (!desired) throw new ManagedWorkerStateCorruptionError("schedule");
    return {
      state: state?.reconciliationState ?? "absent",
      desiredGeneration: state?.desiredGeneration ?? null,
      appliedGeneration: state?.appliedGeneration ?? null,
      appliedDigest: state?.appliedDigest ?? null,
      desiredSchedules: desired,
      actualSchedules: actual.value,
      actualDigest: await managedScheduleDigest(actual.value),
      leaseToken: state?.leaseToken ?? null,
      leaseUntil: state?.leaseUntil ?? null,
      ambiguousGeneration: state?.ambiguousGeneration ?? null,
      ambiguityReason: state?.ambiguityReason ?? null,
    };
  }

  async #readGatewaySchedules(): Promise<ProviderValue<readonly string[]>> {
    const read = await this.#client.json("GET", this.#gatewaySchedulesPath());
    if (read.ok === false) {
      return providerValueFailure(
        "unavailable",
        "the gateway schedule readback is unavailable",
        read.indeterminate,
      );
    }
    const schedules = scheduleValues(read.value);
    return schedules
      ? { ok: true, value: schedules }
      : providerValueFailure("provider_error", "the gateway schedule readback is malformed");
  }

  #gatewaySchedulesPath(): string {
    return `/accounts/${encodeURIComponent(this.#accountId)}/workers/scripts/${encodeURIComponent(this.gatewayWorkerName)}/schedules`;
  }

  async #applyModuleWorker(input: ApplyInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid;
    if (!resourceUid || input.previous) {
      return failed("invalid_spec", "the managed Module Worker identity is immutable");
    }
    const logicalWorkerId = await derivedProviderResourceName("tsw", input.identity);
    const nativeId = `worker:${logicalWorkerId}`;
    const descriptorDigest = await digestJson({
      schema: "takoserver.cloudflare-wfp-module-worker@v1",
      providerId: this.#providerId,
      resourceUid,
      logicalWorkerId,
    });
    const observed = {
      scriptName: logicalWorkerId,
      allocated: true,
      placement: "workers-for-platforms",
    };
    const claim = await this.#state.claimReceipt({
      resourceUid,
      nativeId,
      kind: "worker",
      logicalWorkerId,
      operationId: input.operationId,
      descriptorDigest,
      observed,
    });
    if (claim.outcome === "conflict") {
      return failed("conflict", "the managed Module Worker identity is already claimed");
    }
    if (
      !(await this.#state.commitReceipt({
        resourceUid,
        operationId: input.operationId,
        descriptorDigest,
        observed,
      }))
    ) {
      return failed("unavailable", "the managed Module Worker receipt is unavailable", true);
    }
    return succeeded({
      nativeId,
      observed,
      outputs: { scriptName: logicalWorkerId },
    });
  }

  async #applyWorkerVersion(input: ApplyInput, recovery: boolean): Promise<ProviderTicket> {
    if (input.previous || !input.identity.uid) {
      return failed("invalid_spec", "managed Worker Versions are immutable");
    }
    const requiredSensitive = sensitiveBindingNames(input.spec.requiredSensitiveVars);
    if (!requiredSensitive) {
      return failed("invalid_spec", "the sensitive Worker binding declaration is invalid");
    }
    const target = runtimeInputTarget(input);
    if (!target) return failed("invalid_spec", "the managed Worker Version is incomplete");
    if (
      requiredSensitive.length > 0 &&
      (!this.#runtimeInputs || !input.operationKey || !this.#runtimeInputs.abandon)
    ) {
      return failed("denied", "required sensitive Worker runtime inputs are unavailable");
    }
    // The claim's own prerequisite: the exact executing apply, which is what
    // the authority recomputes the stored commitment against. Recovery never
    // claims and therefore never needs it.
    if (requiredSensitive.length > 0 && !recovery && !input.publicApply) {
      return failed("denied", "required sensitive Worker runtime inputs are unavailable");
    }
    if (record(input.spec.assets)) {
      // Assets participate in the desired descriptor, but WfP has no
      // provider-authoritative asset hash/readback yet. Initial support stays
      // unavailable rather than making ack-loss adoption unsound.
      return failed(
        "unavailable",
        "managed Worker assets require provider-authoritative qualification",
        true,
      );
    }

    if (recovery) {
      return await this.#recoverWorkerVersion(input, requiredSensitive, target);
    }

    let lease: ProviderRuntimeInputLease | undefined;
    if (requiredSensitive.length > 0) {
      try {
        lease = await (this.#runtimeInputs as ProviderRuntimeInputLeasePort).acquire({
          organizationId: input.identity.tenantRef,
          operationId: input.operationId,
          resourceUid: input.identity.uid,
          reference: input.operationKey as string,
          target,
          bindingNames: requiredSensitive,
          publicApply: input.publicApply as ProviderRuntimeInputPublicApply,
        });
      } catch (error) {
        return runtimeInputFailure(error, "acquire");
      }
      if (!exactRuntimeInputBindings(lease.bindings, requiredSensitive)) {
        const aborted = await abortRuntimeLease(lease);
        return (
          aborted ?? failed("denied", "required sensitive Worker runtime inputs are unavailable")
        );
      }
    }

    let closure: ManagedReleaseClosure | ProviderTicket;
    try {
      closure = await this.#prepareRelease(
        input,
        requiredSensitive,
        lease?.preparation.commitment,
        lease?.bindings,
      );
    } catch {
      closure = failed("provider_error", "the managed Worker release could not be constructed");
    }
    if ("phase" in closure) {
      const aborted = lease ? await abortRuntimeLease(lease) : null;
      return aborted ?? closure;
    }

    const claim = await this.#state.claimReceipt({
      resourceUid: closure.resourceUid,
      nativeId: closure.nativeId,
      kind: "version",
      logicalWorkerId: closure.logicalWorkerId,
      operationId: input.operationId,
      descriptorDigest: closure.descriptorDigest,
    });
    if (claim.outcome === "conflict") {
      const aborted = lease ? await abortRuntimeLease(lease) : null;
      return (
        aborted ?? failed("conflict", "the immutable managed Worker release is already claimed")
      );
    }
    if (claim.outcome === "committed") {
      const aborted = lease ? await abortRuntimeLease(lease) : null;
      if (aborted) return aborted;
      return await this.#readCommittedRelease(closure, claim.receipt);
    }
    if (claim.outcome !== "claimed") {
      return failed("unavailable", "the managed Worker release mutation is already pending", true);
    }

    let form: FormData;
    try {
      form = releaseForm(closure);
    } catch {
      const aborted = lease ? await abortRuntimeLease(lease) : null;
      if (!aborted) {
        await this.#state.abortPendingReceipt({
          resourceUid: closure.resourceUid,
          operationId: input.operationId,
          descriptorDigest: closure.descriptorDigest,
        });
      }
      return aborted ?? failed("provider_error", "the managed Worker upload could not be encoded");
    }

    let dispatched: ProviderRuntimeInputDispatchedLease | undefined;
    if (lease) {
      try {
        dispatched = await lease.dispatch();
      } catch (error) {
        return runtimeInputFailure(error, "dispatch");
      }
    }
    const uploaded = await this.#client.uploadScript(closure.releaseScript, form);
    if (uploaded.ok === false) {
      return await this.#handleReleaseUploadFailure(input, closure, requiredSensitive, uploaded);
    }
    const realized = await this.#readAndInspectRelease(closure, uploaded.value.etag, {
      input,
      requiredSensitive,
    });
    if (realized.phase !== "succeeded")
      return realized.phase === "failed"
        ? realized
        : failed("unavailable", "the managed Worker release did not settle", true);
    const realizedEtag = text(realized.result.observed.providerRevision);
    if (!realizedEtag) {
      return failed("provider_error", "the managed Worker release revision is malformed");
    }
    if (
      !(await this.#state.commitReceipt({
        resourceUid: closure.resourceUid,
        operationId: input.operationId,
        descriptorDigest: closure.descriptorDigest,
        providerEtag: realizedEtag,
        observed: releaseReceiptObserved(closure, realized.result.observed),
      }))
    ) {
      return failed("unavailable", "the managed Worker release receipt is unavailable", true);
    }
    if (dispatched) {
      const receiptDigest = await releaseRuntimeInputReceiptDigest(
        this.#accountId,
        closure,
        requiredSensitive,
        realizedEtag,
      );
      try {
        await dispatched.settle(receiptDigest);
      } catch (error) {
        return runtimeInputFailure(error, "settle");
      }
    }
    return realized;
  }

  async #recoverWorkerVersion(
    input: ApplyInput,
    requiredSensitive: readonly string[],
    target: NonNullable<ReturnType<typeof runtimeInputTarget>>,
  ): Promise<ProviderTicket> {
    let recoveryLease: ProviderRuntimeInputRecoveryLease | undefined;
    if (requiredSensitive.length > 0) {
      try {
        recoveryLease = await (this.#runtimeInputs as ProviderRuntimeInputLeasePort).recover({
          organizationId: input.identity.tenantRef,
          operationId: input.operationId,
          resourceUid: input.identity.uid as string,
          reference: input.operationKey as string,
          target,
          bindingNames: requiredSensitive,
        });
      } catch (error) {
        return runtimeInputFailure(error, "recover");
      }
      if (!sameStrings(recoveryLease.bindingNames, requiredSensitive)) {
        return failed("denied", "required sensitive Worker runtime inputs are unavailable");
      }
    }
    const closure = await this.#prepareRelease(
      input,
      requiredSensitive,
      recoveryLease?.preparation.commitment,
    );
    if ("phase" in closure) return closure;
    const receipt = await this.#state.receiptByResourceUid(closure.resourceUid);
    if (
      receipt?.kind !== "version" ||
      receipt.nativeId !== closure.nativeId ||
      receipt.operationId !== input.operationId ||
      receipt.descriptorDigest !== closure.descriptorDigest
    ) {
      return failed("conflict", "the immutable managed Worker release receipt is unavailable");
    }
    const absent = await this.#client.scriptAbsent(closure.releaseScript);
    if (absent.ok === false)
      return wfpFailure(absent, "the managed Worker release readback failed");
    if (absent.value) {
      if (receipt.state === "committed") {
        return failed("not_found", "the committed managed Worker release is absent");
      }
      if (requiredSensitive.length > 0) {
        try {
          await (this.#runtimeInputs as ProviderRuntimeInputLeasePort).abandon?.({
            organizationId: input.identity.tenantRef,
            operationId: input.operationId,
            resourceUid: input.identity.uid as string,
            reference: input.operationKey as string,
            target,
            bindingNames: requiredSensitive,
          });
        } catch (error) {
          return runtimeInputFailure(error, "abort");
        }
      }
      if (
        !(await this.#state.abortPendingReceipt({
          resourceUid: closure.resourceUid,
          operationId: input.operationId,
          descriptorDigest: closure.descriptorDigest,
        }))
      ) {
        return failed("unavailable", "the managed Worker release receipt is unavailable", true);
      }
      return failed("not_found", "the managed Worker release upload did not occur");
    }
    if (receipt.state === "pending" && !this.#pendingReleaseReadbackQualified) {
      return failed(
        "unavailable",
        "the managed Worker release readback has not been qualified for acknowledgement recovery",
        true,
      );
    }
    const realized = await this.#readAndInspectRelease(
      closure,
      receipt.state === "committed" ? receipt.providerEtag : undefined,
      receipt.state === "pending" ? { input, requiredSensitive } : undefined,
    );
    if (realized.phase !== "succeeded")
      return realized.phase === "failed"
        ? realized
        : failed("unavailable", "the managed Worker release did not settle", true);
    const realizedEtag = text(realized.result.observed.providerRevision);
    if (!realizedEtag) {
      return failed("provider_error", "the managed Worker release revision is malformed");
    }
    if (receipt.state === "pending") {
      if (
        !(await this.#state.commitReceipt({
          resourceUid: closure.resourceUid,
          operationId: input.operationId,
          descriptorDigest: closure.descriptorDigest,
          providerEtag: realizedEtag,
          observed: releaseReceiptObserved(closure, realized.result.observed),
        }))
      ) {
        return failed("unavailable", "the managed Worker release receipt is unavailable", true);
      }
    } else if (receipt.state !== "committed") {
      return failed("conflict", "the managed Worker release receipt is not applicable");
    }
    if (recoveryLease) {
      try {
        await recoveryLease.settle(
          await releaseRuntimeInputReceiptDigest(
            this.#accountId,
            closure,
            requiredSensitive,
            realizedEtag,
          ),
        );
      } catch (error) {
        return runtimeInputFailure(error, "settle");
      }
    }
    return realized;
  }

  async #prepareRelease(
    input: ApplyInput,
    requiredSensitive: readonly string[],
    runtimeInputCommitment?: `sha256:${string}`,
    secretValues?: Readonly<Record<string, string>>,
  ): Promise<ManagedReleaseClosure | ProviderTicket> {
    // ADR 0007. The managed backend projects the `edge.objects` facade over an
    // internal R2 binding, and that facade keeps its multipart validation
    // receipts in isolate memory. An eviction between `createMultipartUpload`
    // and `completeMultipartUpload` is ordinary, not exceptional, so this
    // backend cannot honestly claim a restart-safe ObjectBucket runtime. The
    // ordinary-workers backend has no such problem — a native R2 binding keeps
    // its multipart state provider-side — so the refusal is this backend's, by
    // name, rather than a structural accident of nobody configuring it.
    if (
      (Array.isArray(input.spec.bucketBindings) && input.spec.bucketBindings.length > 0) ||
      (input.runtimeBindings?.length ?? 0) > 0
    ) {
      return failed(
        "invalid_spec",
        "the managed Worker backend does not bind an ObjectBucket: its multipart upload ledger " +
          "is in-isolate and an eviction would lose an upload in flight",
      );
    }
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const workerResource = relationResource(input.relations, "/worker", "ModuleWorker");
    const bundleResource = relationResource(input.relations, "/bundle", "WorkerBundle");
    const manifestDigest = text(bundleResource?.spec.manifestDigest);
    const resourceUid = input.identity.uid;
    if (!worker || !workerResource || !bundleResource || !manifestDigest || !resourceUid) {
      return failed("invalid_spec", "the managed Worker Version is incomplete");
    }
    const manifest = await this.#artifacts.manifest(input.identity.tenantRef, manifestDigest);
    if (
      manifest?.kind !== "WorkerBundle" ||
      !artifactPartName(manifest.mainModule) ||
      !Array.isArray(manifest.modules) ||
      manifest.modules.length < 1 ||
      manifest.modules.length > MAX_MODULES ||
      (manifest.files?.length ?? 0) > 0
    ) {
      return failed("invalid_spec", "the managed Worker Bundle is unavailable");
    }
    const names = new Set<string>();
    const modules: Array<{ name: string; mediaType: string; bytes: Uint8Array }> = [];
    let totalBytes = 0;
    for (const module of manifest.modules) {
      if (
        !artifactPartName(module.name) ||
        names.has(module.name) ||
        !moduleMediaType(module.mediaType) ||
        !sha256(module.digest)
      ) {
        return failed("invalid_spec", "the managed Worker module graph is invalid");
      }
      const bytes = await this.#artifacts.blob(module.digest);
      if (!bytes || bytes.byteLength > MAX_MODULE_BYTES) {
        return failed("invalid_spec", `a declared module is missing: ${module.name}`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_MODULE_BYTES) {
        return failed("invalid_spec", "the managed Worker module graph is too large");
      }
      names.add(module.name);
      modules.push({ name: module.name, mediaType: module.mediaType, bytes });
    }
    if (!names.has(manifest.mainModule)) {
      return failed("invalid_spec", "the managed Worker main module is missing");
    }
    const declaredHandlers = workerHandlers(input.spec.handlers);
    if (!declaredHandlers) {
      return failed("invalid_spec", "the managed Worker handler declaration is invalid");
    }
    const bindings = await this.#bindingClosure(input, requiredSensitive, secretValues);
    if (!bindings) {
      return failed("invalid_spec", "a managed Worker binding is unavailable or unsupported");
    }
    const wrapperModule = managedWrapperModuleName([...names]);
    const wrapperSource = managedWorkerEntrypointSource({
      originalMainModule: manifest.mainModule,
      declaredHandlers,
      bindings: bindings.wrapper,
    });
    const settingsIdentity = {
      main_module: wrapperModule,
      compatibility_date: this.#compatibilityDate,
      compatibility_flags: [...MANAGED_WORKER_COMPATIBILITY_FLAGS],
      bindings: canonicalBindingSettings(bindings.metadata),
    };
    const moduleIdentity = await Promise.all(
      modules.map(async (module) => ({
        name: module.name,
        mediaType: canonicalModuleMediaType(module.mediaType),
        digest: await digestBytes(module.bytes),
      })),
    );
    const descriptorDigest = await digestJson({
      schema: "takoserver.cloudflare-wfp-release-descriptor@v1",
      providerId: this.#providerId,
      dispatchNamespace: this.dispatchNamespace,
      logicalWorkerId: worker.name,
      resourceUid,
      manifestDigest,
      desired: input.spec,
      declaredHandlers,
      runtimeInputCommitment: runtimeInputCommitment ?? null,
      settings: settingsIdentity,
      modules: moduleIdentity,
      wrapper: {
        name: wrapperModule,
        digest: await digestBytes(new TextEncoder().encode(wrapperSource)),
      },
      assetsManifestDigest: null,
    });
    const releaseScript = `tsr-${descriptorDigest.slice("sha256:".length)}`;
    const uploadMetadata = {
      ...settingsIdentity,
      bindings: bindings.metadata,
    };
    return {
      logicalWorkerId: worker.name,
      resourceUid,
      operationId: input.operationId,
      descriptorDigest,
      releaseScript,
      nativeId: `version:${worker.name}:${releaseScript}`,
      declaredHandlers,
      requiredSensitive,
      wrapperModule,
      wrapperSource,
      uploadMetadata,
      settingsIdentity,
      modules,
      manifestDigest,
      ...(runtimeInputCommitment ? { runtimeInputCommitment } : {}),
      workerResource,
      bundleResource,
    };
  }

  async #bindingClosure(
    input: ApplyInput,
    requiredSensitive: readonly string[],
    secretValues?: Readonly<Record<string, string>>,
  ): Promise<ManagedBindingClosure | null> {
    const metadata: Readonly<Record<string, unknown>>[] = [];
    const wrapper: ManagedWorkerBindingDescriptor[] = [];
    const publicNames = new Set<string>();
    const addNative = (
      binding: Readonly<Record<string, unknown>> & { readonly name: string; readonly type: string },
    ): boolean => {
      const validName =
        binding.type === "plain_text" || binding.type === "json"
          ? variableBindingName(binding.name)
          : bindingName(binding.name);
      if (!validName || publicNames.has(binding.name)) return false;
      if (binding.name.startsWith(MANAGED_WORKER_INTERNAL_BINDING_PREFIX)) return false;
      publicNames.add(binding.name);
      metadata.push(binding);
      wrapper.push({
        name: binding.name,
        type: binding.type as Extract<ManagedWorkerBindingDescriptor, { type: string }>["type"],
      });
      return true;
    };

    const vars = record(input.spec.vars) ?? {};
    for (const [name, value] of Object.entries(vars).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (
        !addNative(
          typeof value === "string"
            ? { type: "plain_text", name, text: value }
            : { type: "json", name, json: value },
        )
      ) {
        return null;
      }
    }

    for (const [field, prefix, type, output, targetKey] of [
      ["kvBindings", "/kvBindings", "kv_namespace", "namespaceId", "namespace_id"],
      ["queueProducerBindings", "/queueProducerBindings", "queue", "queueName", "queue_name"],
      ["serviceBindings", "/serviceBindings", "service", "scriptName", "service"],
    ] as const) {
      const declarations = Array.isArray(input.spec[field]) ? input.spec[field] : [];
      for (let index = 0; index < declarations.length; index += 1) {
        const declaration = record(declarations[index]);
        const name = text(declaration?.name);
        const target = relationOutput(input.relations, `${prefix}/${index}/resource`, output);
        if (!name || !target || !addNative({ type, name, [targetKey]: target })) return null;
      }
    }

    const sqliteDeclarations = Array.isArray(input.spec.sqliteBindings)
      ? input.spec.sqliteBindings
      : [];
    for (let index = 0; index < sqliteDeclarations.length; index += 1) {
      const declaration = record(sqliteDeclarations[index]);
      const publicName = text(declaration?.name);
      const relation = relationAt(input.relations, `/sqliteBindings/${index}/resource`);
      const native = relation?.deployment?.nativeId
        ? parseManagedNativeId(relation.deployment.nativeId)
        : null;
      const instanceName = relationOutput(
        input.relations,
        `/sqliteBindings/${index}/resource`,
        "databaseId",
      );
      const nativeName = `${MANAGED_WORKER_INTERNAL_BINDING_PREFIX}SQLITE_${index}`;
      if (
        !publicName ||
        publicNames.has(publicName) ||
        publicName.startsWith(MANAGED_WORKER_INTERNAL_BINDING_PREFIX) ||
        !relation ||
        native?.kind !== "sqlite" ||
        native.name !== instanceName ||
        !instanceName
      ) {
        return null;
      }
      publicNames.add(publicName);
      metadata.push({
        type: "durable_object_namespace",
        name: nativeName,
        class_name: MANAGED_SQLITE_CLASS,
        script_name: this.gatewayWorkerName,
      });
      wrapper.push({
        kind: MANAGED_WORKER_EDGE_SQL_BINDING_KIND,
        publicName,
        nativeName,
        instanceName,
      });
    }

    // Unreachable while `#prepareRelease` refuses `bucketBindings` by name.
    // Kept exact because the facade it feeds is complete and tested against a
    // real R2 (`tests/cloudflare-managed-worker-wrapper.test.ts`); the one
    // thing missing is a durable multipart receipt backend, and the day that
    // exists this is the shape the managed path takes. The refusal above is the
    // single gate, and this remains a structural backstop behind it.
    const bucketDeclarations = Array.isArray(input.spec.bucketBindings)
      ? input.spec.bucketBindings
      : [];
    const runtimeBindings = input.runtimeBindings ?? [];
    if (bucketDeclarations.length !== runtimeBindings.length) return null;
    for (let index = 0; index < runtimeBindings.length; index += 1) {
      const service = runtimeBindings[index];
      const declaration = record(bucketDeclarations[index]);
      const relation = relationAt(input.relations, `/bucketBindings/${index}/resource`);
      const material = cloudflareR2EdgeObjectsMaterial(service?.material);
      const publicName = text(service?.name);
      const nativeName = `${MANAGED_WORKER_INTERNAL_BINDING_PREFIX}OBJECTS_${index}`;
      if (
        !service ||
        service.bindingRef.apiVersion !== EDGE_OBJECTS_BINDING_REF.apiVersion ||
        service.bindingRef.name !== EDGE_OBJECTS_BINDING_REF.name ||
        service.bindingRef.version !== EDGE_OBJECTS_BINDING_REF.version ||
        service.bindingRef.schemaDigest !== EDGE_OBJECTS_BINDING_REF.schemaDigest ||
        !publicName ||
        !bindingName(publicName) ||
        publicName.startsWith(MANAGED_WORKER_INTERNAL_BINDING_PREFIX) ||
        publicNames.has(publicName) ||
        text(declaration?.name) !== publicName ||
        !relation ||
        relation.targetUid !== service.targetUid ||
        !material
      ) {
        return null;
      }
      publicNames.add(publicName);
      metadata.push({
        type: "r2_bucket",
        name: nativeName,
        bucket_name: material.bucketName,
      });
      wrapper.push({
        kind: MANAGED_WORKER_EDGE_OBJECTS_BINDING_KIND,
        publicName,
        nativeName,
      });
    }

    for (const name of requiredSensitive) {
      if (publicNames.has(name)) return null;
      const value = secretValues?.[name];
      if (secretValues && !value) return null;
      publicNames.add(name);
      metadata.push({
        type: "secret_text",
        name,
        ...(value ? { text: value } : {}),
      });
      wrapper.push({ type: "secret_text", name });
    }
    return { metadata, wrapper };
  }

  async #readAndInspectRelease(
    closure: ManagedReleaseClosure,
    expectedEtag?: string,
    rejectionCleanup?: {
      readonly input: ApplyInput;
      readonly requiredSensitive: readonly string[];
    },
  ): Promise<ProviderTicket> {
    const read = await this.#client.readScript(closure.releaseScript);
    if (read.ok === false) return wfpFailure(read, "the managed Worker release readback failed");
    if (
      (expectedEtag !== undefined && read.value.etag !== expectedEtag) ||
      !releaseSettingsMatch(read.value.settings, closure.settingsIdentity) ||
      !releaseSecretNamesMatch(read.value.secrets, closure.requiredSensitive) ||
      !(await releaseContentMatches(read.value, closure))
    ) {
      return failed("provider_error", "the managed Worker release readback closure drifted");
    }
    let inspection: Awaited<
      ReturnType<CloudflareWorkersForPlatformsBackendOptions["inspectRelease"]>
    >;
    try {
      inspection = await this.#inspectRelease({
        scriptName: closure.releaseScript,
        descriptorDigest: closure.descriptorDigest,
        operationId: closure.operationId,
        declaredHandlers: closure.declaredHandlers,
      });
    } catch {
      return failed(
        "unavailable",
        "the managed Worker release readiness check is unavailable",
        true,
      );
    }
    if (!inspection.ok) {
      const rejected = failed(
        inspection.retryable ? "unavailable" : "provider_error",
        "the managed Worker release failed readiness inspection",
        inspection.retryable,
      );
      return !inspection.retryable && rejectionCleanup
        ? await this.#cleanupRejectedRelease(
            rejectionCleanup.input,
            closure,
            rejectionCleanup.requiredSensitive,
            rejected,
          )
        : rejected;
    }
    if (
      inspection.scriptName !== closure.releaseScript ||
      inspection.descriptorDigest !== closure.descriptorDigest ||
      inspection.operationId !== closure.operationId ||
      !sameStrings(inspection.handlers, closure.declaredHandlers)
    ) {
      const rejected = failed(
        "provider_error",
        "the managed Worker release failed readiness inspection",
      );
      return rejectionCleanup
        ? await this.#cleanupRejectedRelease(
            rejectionCleanup.input,
            closure,
            rejectionCleanup.requiredSensitive,
            rejected,
          )
        : rejected;
    }
    const observed = {
      scriptName: closure.logicalWorkerId,
      versionId: closure.releaseScript,
      dispatchScriptName: closure.releaseScript,
      providerRevision: read.value.etag,
      descriptorDigest: closure.descriptorDigest,
      handlers: [...closure.declaredHandlers],
    };
    return succeeded({
      nativeId: closure.nativeId,
      observed,
      outputs: { scriptName: closure.logicalWorkerId, versionId: closure.releaseScript },
    });
  }

  async #readCommittedRelease(
    closure: ManagedReleaseClosure,
    receipt: ManagedWorkerReceipt,
  ): Promise<ProviderTicket> {
    if (!receipt.providerEtag || receipt.descriptorDigest !== closure.descriptorDigest) {
      return failed("provider_error", "the managed Worker release receipt is malformed");
    }
    return await this.#readAndInspectRelease(closure, receipt.providerEtag);
  }

  async #cleanupRejectedRelease(
    input: ApplyInput,
    closure: ManagedReleaseClosure,
    requiredSensitive: readonly string[],
    rejection: ProviderTicket,
  ): Promise<ProviderTicket> {
    const removed = await this.#client.deleteScript(closure.releaseScript);
    if (removed.ok === false) {
      return failed(
        "unavailable",
        "the rejected managed Worker release cleanup is indeterminate",
        true,
      );
    }
    const absent = await this.#client.scriptAbsent(closure.releaseScript);
    if (absent.ok === false || !absent.value) {
      return failed(
        "unavailable",
        "the rejected managed Worker release cleanup is indeterminate",
        true,
      );
    }
    if (requiredSensitive.length > 0) {
      try {
        await (this.#runtimeInputs as ProviderRuntimeInputLeasePort).abandon?.({
          organizationId: input.identity.tenantRef,
          operationId: input.operationId,
          resourceUid: input.identity.uid as string,
          reference: input.operationKey as string,
          target: runtimeInputTarget(input) as NonNullable<ReturnType<typeof runtimeInputTarget>>,
          bindingNames: requiredSensitive,
        });
      } catch (error) {
        return runtimeInputFailure(error, "abort");
      }
    }
    if (
      !(await this.#state.abortPendingReceipt({
        resourceUid: closure.resourceUid,
        operationId: input.operationId,
        descriptorDigest: closure.descriptorDigest,
      }))
    ) {
      return failed(
        "unavailable",
        "the rejected managed Worker release receipt is unavailable",
        true,
      );
    }
    return rejection;
  }

  async #handleReleaseUploadFailure(
    input: ApplyInput,
    closure: ManagedReleaseClosure,
    requiredSensitive: readonly string[],
    upload: Extract<CloudflareWfpClientResult<unknown>, { readonly ok: false }>,
  ): Promise<ProviderTicket> {
    const definitive = upload.status >= 400 && upload.status < 500 && upload.status !== 429;
    if (!definitive) {
      return wfpFailure(upload, "the managed Worker release upload outcome is indeterminate");
    }
    const absent = await this.#client.scriptAbsent(closure.releaseScript);
    if (absent.ok === false || !absent.value) {
      return failed(
        "unavailable",
        "the managed Worker release upload outcome is indeterminate",
        true,
      );
    }
    if (requiredSensitive.length > 0) {
      try {
        await (this.#runtimeInputs as ProviderRuntimeInputLeasePort).abandon?.({
          organizationId: input.identity.tenantRef,
          operationId: input.operationId,
          resourceUid: input.identity.uid as string,
          reference: input.operationKey as string,
          target: runtimeInputTarget(input) as NonNullable<ReturnType<typeof runtimeInputTarget>>,
          bindingNames: requiredSensitive,
        });
      } catch (error) {
        return runtimeInputFailure(error, "abort");
      }
    }
    if (
      !(await this.#state.abortPendingReceipt({
        resourceUid: closure.resourceUid,
        operationId: input.operationId,
        descriptorDigest: closure.descriptorDigest,
      }))
    ) {
      return failed("unavailable", "the managed Worker release receipt is unavailable", true);
    }
    return failed("provider_error", "the managed Worker release was rejected");
  }

  async #applyWorkerDeployment(input: ApplyInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid;
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const versions = Array.isArray(input.spec.versions) ? input.spec.versions : [];
    if (!resourceUid || !worker || versions.length < 1) {
      return failed("invalid_spec", "the managed Worker Deployment is incomplete");
    }
    const releases: Array<{ scriptName: string; percentage: number }> = [];
    for (let index = 0; index < versions.length; index += 1) {
      const relation = relationDeployment(
        input.relations,
        `/versions/${index}/workerVersion`,
        "version",
      );
      const weight = integer(record(versions[index])?.weight);
      if (!relation || relation.parent !== worker.name || !weight) {
        return failed("invalid_spec", "a managed Worker Deployment release is invalid");
      }
      const receipt = await this.#state.receiptByNativeId(
        `version:${relation.parent}:${relation.name}`,
      );
      if (
        receipt?.kind !== "version" ||
        receipt.state !== "committed" ||
        receipt.logicalWorkerId !== worker.name
      ) {
        return failed("conflict", "a managed Worker release is not committed");
      }
      releases.push({ scriptName: relation.name, percentage: weight / 100 });
    }
    if (
      new Set(releases.map(({ scriptName }) => scriptName)).size !== releases.length ||
      releases.some(
        ({ percentage }) =>
          percentage <= 0 || percentage > 100 || !Number.isSafeInteger(percentage * 100),
      ) ||
      releases.reduce((sum, release) => sum + release.percentage * 100, 0) !== 10_000
    ) {
      return failed("invalid_spec", "managed Worker Deployment weights must total 10000");
    }
    const descriptorDigest = await digestJson({
      schema: "takoserver.cloudflare-wfp-deployment@v1",
      providerId: this.#providerId,
      resourceUid,
      logicalWorkerId: worker.name,
      releases,
    });
    const deploymentId = `tsd-${descriptorDigest.slice(7)}`;
    const nativeId = `deployment:${worker.name}:${deploymentId}`;
    const previous = input.previous ? parseManagedNativeId(input.previous.nativeId) : null;
    if (input.previous && (previous?.kind !== "deployment" || previous.parent !== worker.name)) {
      return failed("invalid_spec", "the previous managed Worker Deployment is unusable");
    }
    const claim = await this.#state.claimReceipt({
      resourceUid,
      nativeId,
      kind: "deployment",
      logicalWorkerId: worker.name,
      operationId: input.operationId,
      descriptorDigest,
      ...(input.previous ? { predecessor: { nativeId: input.previous.nativeId } } : {}),
    });
    if (claim.outcome === "conflict") {
      return failed("conflict", "the managed Worker Deployment operation is stale");
    }
    const routeKey = managedWorkerReleaseRouteKey(worker.name);
    const current = await this.#state.route("worker", routeKey);
    let predecessor: ManagedWorkerRoutePredecessor;
    if (input.previous) {
      if (
        current?.state !== "active" ||
        current.ownerNativeId !== `deployment:${resourceUid}` ||
        current.value.deploymentId !== input.previous.nativeId
      ) {
        await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
        return failed("conflict", "the managed Worker Deployment predecessor changed");
      }
      predecessor = { kind: "exact", route: current };
    } else if (!current) {
      predecessor = { kind: "absent" };
    } else if (current.state === "tombstone") {
      predecessor = { kind: "exact", route: current };
    } else if (
      current.operationId === (await routeOperationId(input.operationId, "deployment")) &&
      current.ownerNativeId === `deployment:${resourceUid}`
    ) {
      predecessor = { kind: "exact", route: current };
    } else {
      await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
      return failed("conflict", "another managed Worker Deployment owns traffic");
    }
    const route = await this.#state.putRoute({
      kind: "worker",
      key: routeKey,
      ownerNativeId: `deployment:${resourceUid}`,
      operationId: await routeOperationId(input.operationId, "deployment"),
      predecessor,
      value: {
        schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.worker,
        deploymentId: nativeId,
        releases,
      },
    });
    if (!route) {
      await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
      return failed("conflict", "the managed Worker Deployment route changed");
    }
    const observed = {
      scriptName: worker.name,
      deploymentId,
      versions: releases.map(({ scriptName, percentage }) => ({
        version_id: scriptName,
        percentage,
      })),
      routeKey,
      routeGeneration: route.generation,
    };
    if (
      !(await this.#state.commitReceipt({
        resourceUid,
        operationId: input.operationId,
        descriptorDigest,
        observed,
      }))
    ) {
      return failed("unavailable", "the managed Worker Deployment receipt is unavailable", true);
    }
    return succeeded({ nativeId, observed, outputs: {} });
  }

  async #applyWorkerEndpoint(input: ApplyInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid;
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const assignment = input.workerEndpointOriginAssignment;
    const address = assignment
      ? managedEndpointAddress(assignment.canonicalPublicOrigin, this.managedBaseDomain)
      : null;
    if (!resourceUid || !worker || !assignment || !address) {
      return failed(
        "invalid_spec",
        "the Host-assigned managed Worker endpoint origin is unavailable",
      );
    }
    const nativeId = `endpoint:${resourceUid}`;
    const previous = input.previous ? parseManagedNativeId(input.previous.nativeId) : null;
    if (input.previous && (previous?.kind !== "endpoint" || previous.name !== resourceUid)) {
      return failed("invalid_spec", "the previous managed Worker Endpoint is unusable");
    }
    const routeKey = managedWorkerHostRouteKey(address.hostname);
    const descriptorDigest = await digestJson({
      schema: "takoserver.cloudflare-wfp-endpoint@v1",
      providerId: this.#providerId,
      resourceUid,
      logicalWorkerId: worker.name,
      canonicalPublicOrigin: address.origin,
      assignmentDigest: assignment.assignmentDigest,
    });
    const observed = {
      hostname: address.hostname,
      routeKey,
      logicalWorkerId: worker.name,
      assignmentDigest: assignment.assignmentDigest,
    };
    const claim = await this.#state.claimReceipt({
      resourceUid,
      nativeId,
      kind: "endpoint",
      logicalWorkerId: worker.name,
      operationId: input.operationId,
      descriptorDigest,
      observed,
      ...(input.previous ? { predecessor: { nativeId: input.previous.nativeId } } : {}),
    });
    if (claim.outcome === "conflict") {
      return failed("conflict", "the managed Worker Endpoint operation is stale");
    }
    if (claim.outcome === "committed") {
      return await this.#observeEndpoint(resourceUid, nativeId);
    }
    const current = await this.#state.route("host", routeKey);
    const routeOperation = await routeOperationId(input.operationId, "endpoint");
    const ownerNativeId = `endpoint:${resourceUid}`;
    let predecessor: ManagedWorkerRoutePredecessor;
    if (!current) {
      predecessor = { kind: "absent" };
    } else if (
      current.state === "tombstone" ||
      (current.state === "active" &&
        current.ownerNativeId === ownerNativeId &&
        (input.previous !== undefined || current.operationId === routeOperation))
    ) {
      predecessor = { kind: "exact", route: current };
    } else {
      await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
      return failed("conflict", "another managed Worker Endpoint owns the hostname");
    }
    const route = await this.#state.putRoute({
      kind: "host",
      key: routeKey,
      ownerNativeId,
      operationId: routeOperation,
      predecessor,
      value: {
        schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.host,
        logicalWorkerId: worker.name,
      },
    });
    if (!route) {
      await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
      return failed("conflict", "the managed Worker Endpoint route changed");
    }
    const committedObserved = { ...observed, routeGeneration: route.generation };
    if (
      !(await this.#state.commitReceipt({
        resourceUid,
        operationId: input.operationId,
        descriptorDigest,
        observed: committedObserved,
      }))
    ) {
      return failed("unavailable", "the managed Worker Endpoint receipt is unavailable", true);
    }
    return succeeded({
      nativeId,
      observed: committedObserved,
      outputs: { hostname: address.hostname, url: `${address.origin}/` },
    });
  }

  async #applyWorkerCronTrigger(input: ApplyInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid;
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const cron = text(input.spec.cron);
    if (!resourceUid || !worker || !cron) {
      return failed("invalid_spec", "the managed Worker Cron Trigger is incomplete");
    }
    const triggerId = `tsc-${(await digestText(`${resourceUid}\n${cron}`)).slice(7, 47)}`;
    const nativeId = `cron:${worker.name}:${triggerId}`;
    const descriptorDigest = await digestJson({
      schema: "takoserver.cloudflare-wfp-cron@v1",
      providerId: this.#providerId,
      resourceUid,
      logicalWorkerId: worker.name,
      cron,
    });
    const previousNative = input.previous ? parseManagedNativeId(input.previous.nativeId) : null;
    const previousCron = input.previous ? text(input.previous.spec.cron) : undefined;
    if (
      input.previous &&
      (previousNative?.kind !== "cron" || previousNative.parent !== worker.name || !previousCron)
    ) {
      return failed("invalid_spec", "the previous managed Worker Cron Trigger is unusable");
    }
    const claim = await this.#state.claimReceipt({
      resourceUid,
      nativeId,
      kind: "cron",
      logicalWorkerId: worker.name,
      operationId: input.operationId,
      descriptorDigest,
      observed: { cron, previousCron: previousCron ?? null },
      ...(input.previous ? { predecessor: { nativeId: input.previous.nativeId } } : {}),
    });
    if (claim.outcome === "conflict") {
      return failed("conflict", "the managed Worker Cron Trigger operation is stale");
    }
    if (claim.outcome === "committed") {
      return await this.#observeCron(resourceUid, nativeId);
    }
    if (previousCron && previousCron !== cron) {
      const removed = await this.#writeScheduleMember({
        cron: previousCron,
        logicalWorkerId: worker.name,
        operationId: await routeOperationId(input.operationId, "cron-remove"),
        action: "remove",
      });
      if (!removed) {
        return failed("conflict", "the previous managed Worker schedule changed");
      }
    }
    const route = await this.#writeScheduleMember({
      cron,
      logicalWorkerId: worker.name,
      operationId: await routeOperationId(input.operationId, "cron-add"),
      action: "add",
    });
    if (!route) {
      return failed("conflict", "the managed Worker schedule route changed");
    }
    const routeKey = managedWorkerScheduleRouteKey(cron);
    let observed: JsonObject | undefined;
    const synchronized = await this.#synchronizeGatewaySchedules(async (fence) => {
      observed = {
        cron,
        scriptName: worker.name,
        gatewayWorkerName: this.gatewayWorkerName,
        routeKey,
        routeGeneration: route.generation,
        scheduleGeneration: fence.generation,
        scheduleDigest: fence.digest,
      };
      return await this.#state.commitReceiptAtScheduleFence({
        resourceUid,
        operationId: input.operationId,
        descriptorDigest,
        observed,
        scheduleGeneration: fence.generation,
        scheduleDigest: fence.digest,
        scheduleLeaseToken: fence.leaseToken,
        now: fence.now,
      });
    });
    if ("phase" in synchronized) return synchronized;
    if (!observed) {
      return failed("unavailable", "the managed Worker Cron receipt is unavailable", true);
    }
    return succeeded({ nativeId, observed, outputs: {} });
  }

  async #writeScheduleMember(input: {
    readonly cron: string;
    readonly logicalWorkerId: string;
    readonly operationId: string;
    readonly action: "add" | "remove";
  }): Promise<ManagedWorkerRouteState | null> {
    const key = managedWorkerScheduleRouteKey(input.cron);
    const ownerNativeId = `schedule:${(await digestText(input.cron)).slice(7, 47)}`;
    const current = await this.#state.route("schedule", key);
    const currentIds =
      current?.state === "active" ? stringArray(current.value.logicalWorkerIds) : [];
    if (current?.state === "active" && !currentIds) return null;
    const ids = currentIds ?? [];
    if (input.action === "add" && ids.includes(input.logicalWorkerId)) {
      return current?.operationId === input.operationId ? current : null;
    }
    if (input.action === "remove" && !ids.includes(input.logicalWorkerId)) {
      return current?.operationId === input.operationId ? current : null;
    }
    const next =
      input.action === "add"
        ? [...ids, input.logicalWorkerId].sort()
        : ids.filter((id) => id !== input.logicalWorkerId).sort();
    if (next.length === 0) {
      return current?.state === "active"
        ? await this.#state.tombstoneRoute({
            kind: "schedule",
            key,
            ownerNativeId,
            operationId: input.operationId,
            predecessor: { kind: "exact", route: current },
          })
        : null;
    }
    const predecessor: ManagedWorkerRoutePredecessor = !current
      ? { kind: "absent" }
      : { kind: "exact", route: current };
    return await this.#state.putRoute({
      kind: "schedule",
      key,
      ownerNativeId,
      operationId: input.operationId,
      predecessor,
      value: {
        schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.schedule,
        logicalWorkerIds: next,
      },
    });
  }

  async #synchronizeGatewaySchedules(
    commit?: (fence: ManagedScheduleFence) => Promise<boolean>,
  ): Promise<ManagedScheduleFence | ProviderTicket> {
    const leaseToken = `schedule_${crypto.randomUUID()}`;
    const leaseNow = Date.now();
    const acquired = await this.#state.acquireScheduleReconciliation({
      leaseToken,
      now: leaseNow,
      leaseUntil: leaseNow + 60_000,
    });
    if (acquired.outcome === "operator_reconciliation_required") {
      return failed(
        "unavailable",
        "the gateway schedule set requires explicit operator reconciliation",
      );
    }
    if (acquired.outcome !== "acquired") {
      return failed("unavailable", "the gateway schedule reconciler is busy", true);
    }
    let releaseLease = true;
    let ambiguousGeneration = acquired.state.desiredGeneration;
    try {
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const snapshot = await this.#state.scheduleSnapshot({
          leaseToken,
          now: Date.now(),
        });
        if (!snapshot) {
          if (!releaseLease) {
            await this.#state.markScheduleReconciliationAmbiguous({
              leaseToken,
              desiredGeneration: ambiguousGeneration,
              reason: "lease_expired",
            });
          }
          return failed(
            "unavailable",
            releaseLease
              ? "the gateway schedule lease expired before mutation"
              : "the gateway schedule mutation requires explicit operator reconciliation",
            releaseLease,
          );
        }
        const desired = scheduleCronsFromRoutes(snapshot.routes);
        if (!desired) {
          return failed("provider_error", "the managed Worker schedule authority is malformed");
        }
        const digest = await managedScheduleDigest(desired);
        const read = await this.#client.json("GET", this.#gatewaySchedulesPath());
        if (read.ok === false) return wfpFailure(read, "the gateway schedules are unavailable");
        const actual = scheduleValues(read.value);
        if (!actual) {
          return failed("provider_error", "the gateway schedule readback is malformed");
        }
        if (!sameStrings(actual, desired)) {
          // From this point until a 2xx plus exact readback and the generation
          // fence, process death is ambiguous. Never release this lease on an
          // exception or adopt a later GET after acknowledgement loss.
          releaseLease = false;
          ambiguousGeneration = snapshot.desiredGeneration;
          const write = await this.#client.json(
            "PUT",
            this.#gatewaySchedulesPath(),
            JSON.stringify(desired.map((cron) => ({ cron }))),
            { "content-type": "application/json" },
          );
          if (write.ok === false) {
            await this.#state.markScheduleReconciliationAmbiguous({
              leaseToken,
              desiredGeneration: snapshot.desiredGeneration,
              reason: "mutation_indeterminate",
            });
            return failed(
              "unavailable",
              "the gateway schedule mutation requires explicit operator reconciliation",
            );
          }
          const readback = await this.#client.json("GET", this.#gatewaySchedulesPath());
          if (readback.ok === false) {
            await this.#state.markScheduleReconciliationAmbiguous({
              leaseToken,
              desiredGeneration: snapshot.desiredGeneration,
              reason: "mutation_indeterminate",
            });
            return failed(
              "unavailable",
              "the gateway schedule mutation requires explicit operator reconciliation",
            );
          }
          const realized = scheduleValues(readback.value);
          if (!realized || !sameStrings(realized, desired)) {
            await this.#state.markScheduleReconciliationAmbiguous({
              leaseToken,
              desiredGeneration: snapshot.desiredGeneration,
              reason: "mutation_indeterminate",
            });
            return failed(
              "unavailable",
              "the gateway schedule mutation requires explicit operator reconciliation",
            );
          }
        }
        const completedAt = Date.now();
        const completed = await this.#state.completeScheduleReconciliation({
          leaseToken,
          now: completedAt,
          desiredGeneration: snapshot.desiredGeneration,
          appliedDigest: digest,
        });
        if (!completed) continue;
        releaseLease = true;
        const fence = {
          generation: snapshot.desiredGeneration,
          digest,
          leaseToken,
          now: completedAt,
        };
        if (commit && !(await commit(fence))) continue;
        return fence;
      }
      return failed("unavailable", "the gateway schedule authority kept changing", true);
    } finally {
      if (releaseLease) await this.#state.releaseScheduleReconciliation(leaseToken);
    }
  }

  async #abortClaim(
    claim: Awaited<ReturnType<ManagedWorkerState["claimReceipt"]>>,
    resourceUid: string,
    operationId: string,
    descriptorDigest: `sha256:${string}`,
  ): Promise<void> {
    if (claim.outcome === "claimed" || claim.outcome === "pending") {
      await this.#state.abortPendingReceipt({ resourceUid, operationId, descriptorDigest });
    }
  }

  async #applyQueueConsumer(input: ApplyInput, recovery: boolean): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid;
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const queue = relationDeployment(input.relations, "/queue", "queue");
    const queueName = relationOutput(input.relations, "/queue", "queueName");
    const deadLetter = relationDeployment(input.relations, "/deadLetterQueue", "queue", true);
    const deadLetterName = deadLetter
      ? relationOutput(input.relations, "/deadLetterQueue", "queueName")
      : undefined;
    const settings = consumerSettings(input.spec);
    if (
      !resourceUid ||
      !worker ||
      !queue ||
      !queueName ||
      !settings ||
      (deadLetter && !deadLetterName)
    ) {
      return failed("invalid_spec", "the managed Queue Consumer is incomplete");
    }
    const desired = {
      type: "worker",
      script_name: this.gatewayWorkerName,
      settings,
      ...(deadLetterName ? { dead_letter_queue: deadLetterName } : {}),
    };
    const descriptorDigest = await digestJson({
      schema: "takoserver.cloudflare-wfp-queue-consumer@v1",
      providerId: this.#providerId,
      resourceUid,
      logicalWorkerId: worker.name,
      queueId: queue.name,
      queueName,
      desired,
    });
    const provisionalNativeId = `consumer:${queue.name}:pending-${(await digestText(resourceUid)).slice(7, 47)}`;
    const previous = input.previous ? parseManagedNativeId(input.previous.nativeId) : null;
    if (input.previous && (previous?.kind !== "consumer" || previous.parent !== queue.name)) {
      return failed("invalid_spec", "the previous managed Queue Consumer is unusable");
    }
    const existing = await this.#state.receiptByResourceUid(resourceUid);
    const claimNativeId =
      existing?.kind === "consumer" &&
      existing.operationId === input.operationId &&
      existing.descriptorDigest === descriptorDigest
        ? existing.nativeId
        : (input.previous?.nativeId ?? provisionalNativeId);
    const claim = await this.#state.claimReceipt({
      resourceUid,
      nativeId: claimNativeId,
      kind: "consumer",
      logicalWorkerId: worker.name,
      operationId: input.operationId,
      descriptorDigest,
      observed: { queueId: queue.name, queueName, desired },
      ...(input.previous ? { predecessor: { nativeId: input.previous.nativeId } } : {}),
    });
    if (claim.outcome === "conflict") {
      return failed("conflict", "the managed Queue Consumer operation is stale");
    }
    if (claim.outcome === "committed") {
      return await this.#observeQueueConsumer(resourceUid, claim.receipt.nativeId);
    }
    const path = `/accounts/${encodeURIComponent(this.#accountId)}/queues/${encodeURIComponent(queue.name)}/consumers`;
    const routeKey = managedWorkerQueueRouteKey(queueName);
    const routeOwnerNativeId = `consumer:${resourceUid}`;
    const routeMutationOperationId = await routeOperationId(input.operationId, "consumer");
    const routeBeforeMutation = await this.#state.route("queue", routeKey);
    if (
      !input.previous &&
      claim.outcome === "claimed" &&
      routeBeforeMutation?.state === "active" &&
      (routeBeforeMutation.ownerNativeId !== routeOwnerNativeId ||
        routeBeforeMutation.operationId !== routeMutationOperationId)
    ) {
      await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
      return failed("conflict", "the managed Queue route has another consumer");
    }
    let consumers = await this.#readQueueConsumers(path);
    if ("phase" in consumers) return consumers;
    let realized = consumers.filter((consumer) => consumerClosureMatches(consumer, desired));
    let consumer: Readonly<Record<string, unknown>> | undefined;
    let createdByThisMutation = false;
    if (input.previous) {
      consumer = consumers.find((candidate) => text(candidate.consumer_id) === previous?.name);
      if (!consumer) {
        return failed("not_found", "the managed Queue Consumer is absent");
      }
      if (!consumerClosureMatches(consumer, desired)) {
        if (recovery) {
          return failed("unavailable", "the Queue Consumer update outcome is indeterminate", true);
        }
        const updated = await this.#client.json(
          "PUT",
          `${path}/${encodeURIComponent(previous?.name ?? "")}`,
          JSON.stringify(desired),
          { "content-type": "application/json" },
        );
        if (updated.ok === false) {
          consumers = await this.#readQueueConsumers(path);
          if ("phase" in consumers) return consumers;
          consumer = consumers.find((candidate) => text(candidate.consumer_id) === previous?.name);
          if (!consumer || !consumerClosureMatches(consumer, desired)) {
            return wfpFailure(updated, "the Queue Consumer update outcome is indeterminate");
          }
        } else {
          consumers = await this.#readQueueConsumers(path);
          if ("phase" in consumers) return consumers;
          consumer = consumers.find((candidate) => text(candidate.consumer_id) === previous?.name);
        }
      }
    } else if (claim.outcome === "pending") {
      if (!recovery) {
        return failed(
          "unavailable",
          "the Queue Consumer creation requires provider recovery",
          true,
        );
      }
      if (consumers.length === 0) {
        await this.#state.abortPendingReceipt({
          resourceUid,
          operationId: input.operationId,
          descriptorDigest,
        });
        return failed("not_found", "the managed Queue Consumer creation did not occur");
      }
      if (consumers.length !== 1 || realized.length !== 1) {
        return failed("conflict", "the Queue Consumer creation readback cannot be adopted exactly");
      }
      consumer = realized[0];
    } else {
      if (recovery) {
        await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
        return failed("not_found", "the managed Queue Consumer creation did not occur");
      }
      // A first attempt owns no pre-existing native consumer, even when its
      // visible settings happen to equal the desired closure. Only a pinned
      // pending receipt may adopt an acknowledgement-loss readback.
      if (consumers.length !== 0) {
        await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
        return failed("conflict", "the Queue already has another consumer");
      }
      const created = await this.#client.json("POST", path, JSON.stringify(desired), {
        "content-type": "application/json",
      });
      consumers = await this.#readQueueConsumers(path);
      if ("phase" in consumers) {
        return created.ok === false
          ? wfpFailure(created, "the Queue Consumer creation outcome is indeterminate")
          : consumers;
      }
      realized = consumers.filter((candidate) => consumerClosureMatches(candidate, desired));
      if (consumers.length !== 1 || realized.length !== 1) {
        if (consumers.length === 0) {
          await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
        }
        return created.ok === false
          ? wfpFailure(created, "the Queue Consumer creation outcome is indeterminate")
          : failed("provider_error", "the Queue Consumer readback closure drifted");
      }
      consumer = realized[0];
      if (created.ok === true) {
        const responseConsumerId = text(record(created.value)?.consumer_id);
        const readbackConsumerId = text(consumer?.consumer_id);
        if (responseConsumerId && responseConsumerId !== readbackConsumerId) {
          return failed("provider_error", "the Queue Consumer creation readback changed identity");
        }
        createdByThisMutation = true;
      } else if (!created.indeterminate) {
        await this.#abortClaim(claim, resourceUid, input.operationId, descriptorDigest);
        return wfpFailure(created, "the Queue Consumer creation failed");
      }
    }
    if (!consumer || !consumerClosureMatches(consumer, desired)) {
      return failed("provider_error", "the Queue Consumer readback closure drifted");
    }
    const consumerId = text(consumer.consumer_id);
    if (!consumerId) return failed("provider_error", "the Queue Consumer has no identifier");
    const nativeId = `consumer:${queue.name}:${consumerId}`;
    if (
      claim.receipt.nativeId !== nativeId &&
      !(await this.#state.bindPendingNativeId({
        resourceUid,
        operationId: input.operationId,
        descriptorDigest,
        expectedNativeId: claim.receipt.nativeId,
        nativeId,
      }))
    ) {
      return failed("unavailable", "the Queue Consumer receipt is unavailable", true);
    }
    const current = await this.#state.route("queue", routeKey);
    let route = current;
    if (!input.previous) {
      if (
        current?.state === "active" &&
        (current.ownerNativeId !== routeOwnerNativeId ||
          current.operationId !== routeMutationOperationId)
      ) {
        return await this.#queueRouteConflictAfterCreate({
          resourceUid,
          operationId: input.operationId,
          descriptorDigest,
          path,
          consumerId,
          desired,
          createdByThisMutation,
        });
      }
      route = await this.#state.putRoute({
        kind: "queue",
        key: routeKey,
        ownerNativeId: routeOwnerNativeId,
        operationId: routeMutationOperationId,
        predecessor: current ? { kind: "exact", route: current } : { kind: "absent" },
        value: {
          schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.queue,
          logicalWorkerId: worker.name,
        },
      });
    } else if (
      current?.state !== "active" ||
      current.ownerNativeId !== routeOwnerNativeId ||
      current.value.logicalWorkerId !== worker.name
    ) {
      return failed("conflict", "the managed Queue route changed");
    }
    if (!route) {
      return input.previous
        ? failed("conflict", "the managed Queue route changed")
        : await this.#queueRouteConflictAfterCreate({
            resourceUid,
            operationId: input.operationId,
            descriptorDigest,
            path,
            consumerId,
            desired,
            createdByThisMutation,
          });
    }
    const observed = {
      consumerId,
      queueId: queue.name,
      queueName,
      scriptName: worker.name,
      gatewayWorkerName: this.gatewayWorkerName,
      routeKey,
      routeGeneration: route.generation,
      consumerClosure: desired,
    };
    if (
      !(await this.#state.commitReceipt({
        resourceUid,
        operationId: input.operationId,
        descriptorDigest,
        observed,
      }))
    ) {
      return failed("unavailable", "the Queue Consumer receipt is unavailable", true);
    }
    return succeeded({ nativeId, observed, outputs: {} });
  }

  async #queueRouteConflictAfterCreate(input: {
    readonly resourceUid: string;
    readonly operationId: string;
    readonly descriptorDigest: `sha256:${string}`;
    readonly path: string;
    readonly consumerId: string;
    readonly desired: Readonly<Record<string, unknown>>;
    readonly createdByThisMutation: boolean;
  }): Promise<ProviderTicket> {
    // A transport-lost POST can be adopted by exact closure, but its native
    // ownership cannot be distinguished from a concurrent creator if the
    // route CAS loses. Preserve the pending claim for operator recovery and
    // never delete that ambiguous native consumer.
    if (!input.createdByThisMutation) {
      return failed("unavailable", "the Queue Consumer route outcome is indeterminate", true);
    }
    const cleanup = await this.#removeExactQueueConsumer(
      input.path,
      input.consumerId,
      input.desired,
    );
    if (cleanup) return cleanup;
    if (
      !(await this.#state.abortPendingReceipt({
        resourceUid: input.resourceUid,
        operationId: input.operationId,
        descriptorDigest: input.descriptorDigest,
      }))
    ) {
      return failed("unavailable", "the Queue Consumer receipt cleanup is unavailable", true);
    }
    return failed("conflict", "the managed Queue route has another consumer");
  }

  async #removeExactQueueConsumer(
    path: string,
    consumerId: string,
    desired: Readonly<Record<string, unknown>>,
  ): Promise<ProviderTicket | null> {
    const exactPath = `${path}/${encodeURIComponent(consumerId)}`;
    const before = await this.#client.json("GET", exactPath);
    if (before.ok === false) {
      return before.status === 404
        ? null
        : wfpFailure(before, "the Queue Consumer cleanup readback failed");
    }
    const realized = record(before.value);
    if (
      !realized ||
      text(realized.consumer_id) !== consumerId ||
      !consumerClosureMatches(realized, desired)
    ) {
      return failed("conflict", "the Queue Consumer cleanup closure changed");
    }
    const removed = await this.#client.raw("DELETE", exactPath);
    const after = await this.#client.json("GET", exactPath);
    if (after.ok === false && after.status === 404) return null;
    if (after.ok === false) {
      return wfpFailure(after, "the Queue Consumer cleanup readback failed");
    }
    return removed.ok === false
      ? wfpFailure(removed, "the Queue Consumer cleanup outcome is indeterminate")
      : failed("unavailable", "the Queue Consumer cleanup outcome is indeterminate", true);
  }

  async #readQueueConsumers(
    path: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[] | ProviderTicket> {
    const read = await this.#client.json("GET", path);
    if (read.ok === false) return wfpFailure(read, "the Queue Consumer readback failed");
    const values = providerList(read.value, "consumers");
    if (!values) return failed("provider_error", "the Queue Consumer listing is malformed");
    const consumers = values.map(record);
    return consumers.every((consumer): consumer is Readonly<Record<string, unknown>> => !!consumer)
      ? consumers
      : failed("provider_error", "the Queue Consumer listing is malformed");
  }

  async #applySqliteDatabase(input: ApplyInput, recovery: boolean): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid;
    if (!resourceUid || input.previous) {
      return failed("invalid_spec", "the managed SQLite Database identity is immutable");
    }
    let instanceName: string;
    try {
      instanceName = nativeToken(
        await this.#deriveSqliteInstanceName({
          providerId: this.#providerId,
          resourceUid,
          generation: "1",
        }),
        "SQLite instance",
      );
    } catch {
      return failed("unavailable", "the managed SQLite identity authority is unavailable", true);
    }
    const nativeId = `sqlite:${instanceName}`;
    const descriptorDigest = await digestJson({
      schema: "takoserver.cloudflare-wfp-sqlite@v1",
      providerId: this.#providerId,
      resourceUid,
      generation: "1",
      instanceName,
      spec: input.spec,
    });
    const claim = await this.#state.claimReceipt({
      resourceUid,
      nativeId,
      kind: "sqlite",
      logicalWorkerId: instanceName,
      operationId: input.operationId,
      descriptorDigest,
    });
    if (claim.outcome === "conflict") {
      return failed("conflict", "the managed SQLite identity is already claimed");
    }
    const authority = sqliteAuthority(this.#providerId, resourceUid, descriptorDigest);
    const stub = this.#sqliteNamespace.getByName(instanceName);
    let inspected: Awaited<ReturnType<typeof stub.takoserverSqliteInspect>>;
    let sealedInspect: CloudflareManagedSqliteAdminRequest;
    try {
      sealedInspect = await this.#sealedSqliteRequest("inspect", authority);
      inspected = await stub.takoserverSqliteInspect(sealedInspect);
    } catch {
      return failed("unavailable", "the managed SQLite authority is unavailable", true);
    }
    if (!sqliteInspectionMatches(inspected, authority, "active")) {
      if (sqliteInspectionMatches(inspected, authority, "destroyed")) {
        return failed("conflict", "the managed SQLite identity was already destroyed");
      }
      if (inspected.ok) {
        return failed("provider_error", "the managed SQLite readback closure drifted");
      }
      if (inspected.error.code !== "not_found") {
        return sqliteTicketFailure(inspected.error);
      }
      if (recovery) {
        await this.#state.abortPendingReceipt({
          resourceUid,
          operationId: input.operationId,
          descriptorDigest,
        });
        return failed("not_found", "the managed SQLite initialization did not occur");
      }
      try {
        const initialized = await stub.takoserverSqliteInitialize(
          await this.#sealedSqliteRequest("initialize", authority),
        );
        if (!sqliteInitializationMatches(initialized)) {
          return initialized.ok
            ? failed("provider_error", "the managed SQLite initialization readback is malformed")
            : sqliteTicketFailure(initialized.error);
        }
        inspected = await stub.takoserverSqliteInspect(sealedInspect);
      } catch {
        return failed("unavailable", "the managed SQLite initialization is indeterminate", true);
      }
      if (!sqliteInspectionMatches(inspected, authority, "active")) {
        return failed("provider_error", "the managed SQLite readback closure drifted");
      }
    }
    const databaseName = await derivedProviderResourceName("tsdb", input.identity);
    const observed = {
      instanceName,
      databaseName,
      descriptorDigest,
      state: "active",
    };
    if (
      claim.outcome !== "committed" &&
      !(await this.#state.commitReceipt({
        resourceUid,
        operationId: input.operationId,
        descriptorDigest,
        observed,
      }))
    ) {
      return failed("unavailable", "the managed SQLite receipt is unavailable", true);
    }
    return succeeded({
      nativeId,
      observed,
      outputs: { databaseId: instanceName, databaseName },
    });
  }

  async #observeSqlite(resourceUid: string, nativeId: string): Promise<ProviderTicket> {
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    const native = parseManagedNativeId(nativeId);
    if (
      receipt?.kind !== "sqlite" ||
      receipt.nativeId !== nativeId ||
      receipt.state !== "committed" ||
      native?.kind !== "sqlite"
    ) {
      return failed("not_found", "the managed SQLite Database is absent");
    }
    const authority = sqliteAuthority(this.#providerId, resourceUid, receipt.descriptorDigest);
    try {
      const inspected = await this.#sqliteNamespace
        .getByName(native.name)
        .takoserverSqliteInspect(await this.#sealedSqliteRequest("inspect", authority));
      if (!sqliteInspectionMatches(inspected, authority, "active")) {
        return sqliteInspectionMatches(inspected, authority, "destroyed")
          ? failed("not_found", "the managed SQLite Database is absent")
          : inspected.ok
            ? failed("provider_error", "the managed SQLite readback closure drifted")
            : sqliteTicketFailure(inspected.error);
      }
      return succeeded({
        nativeId,
        observed: receipt.observed as JsonObject,
        outputs: {
          databaseId: native.name,
          ...(text(receipt.observed.databaseName)
            ? { databaseName: text(receipt.observed.databaseName) as string }
            : {}),
        },
      });
    } catch {
      return failed("unavailable", "the managed SQLite authority is unavailable", true);
    }
  }

  async #deleteSqlite(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid as string;
    const native = parseManagedNativeId(input.nativeId);
    if (native?.kind !== "sqlite") {
      return failed("not_found", "the managed SQLite Database is absent");
    }
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (receipt?.state === "deleted" && receipt.nativeId === input.nativeId) {
      return deletedTicket(input.nativeId);
    }
    const deleting = await this.#state.beginReceiptDelete({
      resourceUid,
      nativeId: input.nativeId,
      operationId: input.operationId,
    });
    if (deleting?.kind !== "sqlite") {
      return failed("conflict", "the managed SQLite delete operation is stale");
    }
    const authority = sqliteAuthority(this.#providerId, resourceUid, deleting.descriptorDigest);
    try {
      const destroyed = await this.#sqliteNamespace
        .getByName(native.name)
        .takoserverSqliteDestroy(await this.#sealedSqliteRequest("destroy", authority));
      if (!sqliteDestructionMatches(destroyed)) {
        return destroyed.ok
          ? failed("provider_error", "the managed SQLite destroy readback is malformed")
          : sqliteTicketFailure(destroyed.error);
      }
    } catch {
      return failed("unavailable", "the managed SQLite deletion is indeterminate", true);
    }
    if (
      !(await this.#state.commitReceiptDelete({
        resourceUid,
        nativeId: input.nativeId,
        operationId: input.operationId,
      }))
    ) {
      return failed("unavailable", "the managed SQLite delete receipt is unavailable", true);
    }
    return deletedTicket(input.nativeId);
  }

  async #sqliteAuthority(nativeId: string) {
    const receipt = await this.#state.receiptByNativeId(nativeId);
    return receipt?.kind === "sqlite" && receipt.state === "committed"
      ? sqliteAuthority(this.#providerId, receipt.resourceUid, receipt.descriptorDigest)
      : null;
  }

  /**
   * Seals one admin call. The Durable Object refuses an unsealed one, so a
   * composition whose sealing authority is unavailable fails before it reaches
   * the namespace rather than after.
   */
  async #sealedSqliteRequest(
    operation: ManagedWorkerSqliteAdminOperation,
    authority: ManagedWorkerSqliteAuthority,
  ): Promise<CloudflareManagedSqliteAdminRequest> {
    return { authority, proof: await this.#sealSqliteAdminProof({ operation, authority }) };
  }

  async #observeReceipt(
    resourceUid: string,
    nativeId: string,
    kind: ManagedWorkerReceipt["kind"],
  ): Promise<ProviderTicket> {
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (
      !receipt ||
      receipt.nativeId !== nativeId ||
      receipt.kind !== kind ||
      receipt.state !== "committed"
    ) {
      return failed("not_found", "the managed resource is absent");
    }
    return succeeded({
      nativeId,
      observed: receipt.observed as JsonObject,
      outputs: kind === "worker" ? { scriptName: receipt.logicalWorkerId } : {},
    });
  }

  async #observeWorkerVersion(
    resourceUid: string,
    nativeId: string,
    input: {
      readonly offering: ProviderOffering;
      readonly identity: ResourceIdentity;
      readonly spec: JsonObject;
      readonly relations?: readonly ProviderRelation[];
    },
  ): Promise<ProviderTicket> {
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (
      receipt?.kind !== "version" ||
      receipt.nativeId !== nativeId ||
      receipt.state !== "committed" ||
      !receipt.providerEtag
    ) {
      return failed("not_found", "the managed Worker release is absent");
    }
    const requiredSensitive = sensitiveBindingNames(input.spec.requiredSensitiveVars);
    const commitment = sha256Value(receipt.observed.runtimeInputCommitment);
    const releaseOperationId = text(receipt.observed.releaseOperationId);
    if (
      !requiredSensitive ||
      !releaseOperationId ||
      (requiredSensitive.length > 0 && !commitment)
    ) {
      return failed("provider_error", "the managed Worker release receipt is malformed");
    }
    const closure = await this.#prepareRelease(
      {
        operationId: releaseOperationId,
        operationMode: "recovery",
        offering: input.offering,
        identity: input.identity,
        spec: input.spec,
        ...(input.relations === undefined ? {} : { relations: input.relations }),
      },
      requiredSensitive,
      commitment,
    );
    if ("phase" in closure) return closure;
    if (closure.nativeId !== nativeId || closure.descriptorDigest !== receipt.descriptorDigest) {
      return failed("conflict", "the managed Worker release desired closure changed");
    }
    return await this.#readCommittedRelease(closure, receipt);
  }

  async #observeDeployment(resourceUid: string, nativeId: string): Promise<ProviderTicket> {
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (
      receipt?.kind !== "deployment" ||
      receipt.nativeId !== nativeId ||
      receipt.state !== "committed"
    ) {
      return failed("not_found", "the managed Worker Deployment is absent");
    }
    const routeKey = text(receipt.observed.routeKey);
    if (!routeKey)
      return failed("provider_error", "the managed Worker Deployment receipt is malformed");
    const route = await this.#state.route("worker", routeKey);
    if (
      route?.state !== "active" ||
      route.ownerNativeId !== `deployment:${resourceUid}` ||
      route.value.deploymentId !== nativeId
    ) {
      return failed("not_found", "the managed Worker Deployment is not active");
    }
    return succeeded({ nativeId, observed: receipt.observed as JsonObject, outputs: {} });
  }

  async #observeEndpoint(resourceUid: string, nativeId: string): Promise<ProviderTicket> {
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (
      receipt?.kind !== "endpoint" ||
      receipt.nativeId !== nativeId ||
      receipt.state !== "committed"
    ) {
      return failed("not_found", "the managed Worker Endpoint is absent");
    }
    const routeKey = text(receipt.observed.routeKey);
    const hostname = text(receipt.observed.hostname);
    if (!routeKey || !hostname) {
      return failed("provider_error", "the managed Worker Endpoint receipt is malformed");
    }
    const route = await this.#state.route("host", routeKey);
    if (route?.state !== "active" || route.ownerNativeId !== `endpoint:${resourceUid}`) {
      return failed("not_found", "the managed Worker Endpoint is absent");
    }
    return succeeded({
      nativeId,
      observed: receipt.observed as JsonObject,
      outputs: { hostname, url: `https://${hostname}/` },
    });
  }

  async #observeCron(resourceUid: string, nativeId: string): Promise<ProviderTicket> {
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (
      receipt?.kind !== "cron" ||
      receipt.nativeId !== nativeId ||
      receipt.state !== "committed"
    ) {
      return failed("not_found", "the managed Worker Cron Trigger is absent");
    }
    const routeKey = text(receipt.observed.routeKey);
    if (!routeKey) return failed("provider_error", "the managed Worker Cron receipt is malformed");
    const route = await this.#state.route("schedule", routeKey);
    const ids = route?.state === "active" ? stringArray(route.value.logicalWorkerIds) : null;
    if (!route || !ids?.includes(receipt.logicalWorkerId)) {
      return failed("not_found", "the managed Worker Cron Trigger is absent");
    }
    const cron = text(receipt.observed.cron);
    if (!cron) return failed("provider_error", "the managed Worker Cron receipt is malformed");
    const path = `/accounts/${encodeURIComponent(this.#accountId)}/workers/scripts/${encodeURIComponent(this.gatewayWorkerName)}/schedules`;
    const read = await this.#client.json("GET", path);
    if (read.ok === false) return wfpFailure(read, "the gateway schedules are unavailable");
    const schedules = scheduleValues(read.value);
    if (!schedules) return failed("provider_error", "the gateway schedule readback is malformed");
    if (!schedules.includes(cron)) {
      return failed("not_found", "the managed Worker Cron Trigger is absent");
    }
    return succeeded({ nativeId, observed: receipt.observed as JsonObject, outputs: {} });
  }

  async #observeQueueConsumer(resourceUid: string, nativeId: string): Promise<ProviderTicket> {
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    const native = parseManagedNativeId(nativeId);
    if (
      receipt?.kind !== "consumer" ||
      receipt.nativeId !== nativeId ||
      receipt.state !== "committed" ||
      native?.kind !== "consumer"
    ) {
      return failed("not_found", "the managed Queue Consumer is absent");
    }
    const desired = record(receipt.observed.consumerClosure);
    const routeKey = text(receipt.observed.routeKey);
    if (!desired || !routeKey)
      return failed("provider_error", "the Queue Consumer receipt is malformed");
    const read = await this.#client.json(
      "GET",
      `/accounts/${encodeURIComponent(this.#accountId)}/queues/${encodeURIComponent(native.parent)}/consumers/${encodeURIComponent(native.name)}`,
    );
    if (read.ok === false) {
      return read.status === 404
        ? failed("not_found", "the managed Queue Consumer is absent")
        : wfpFailure(read, "the Queue Consumer readback failed");
    }
    const consumer = record(read.value);
    if (
      !consumer ||
      text(consumer.consumer_id) !== native.name ||
      !consumerClosureMatches(consumer, desired)
    ) {
      return failed("provider_error", "the Queue Consumer readback closure drifted");
    }
    const route = await this.#state.route("queue", routeKey);
    if (
      route?.state !== "active" ||
      route.ownerNativeId !== `consumer:${resourceUid}` ||
      route.value.logicalWorkerId !== receipt.logicalWorkerId
    ) {
      return failed("not_found", "the managed Queue Consumer route is absent");
    }
    return succeeded({ nativeId, observed: receipt.observed as JsonObject, outputs: {} });
  }

  async #deleteModuleWorker(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid as string;
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (receipt?.state === "deleted" && receipt.nativeId === input.nativeId) {
      return deletedTicket(input.nativeId);
    }
    if (
      receipt?.kind !== "worker" ||
      receipt.nativeId !== input.nativeId ||
      receipt.state !== "committed"
    ) {
      return failed("not_found", "the managed Module Worker is absent");
    }
    if (await this.#logicalWorkerHasActiveRoutes(receipt.logicalWorkerId)) {
      return failed("conflict", "the managed Module Worker still has active attachments");
    }
    const deleting = await this.#state.beginReceiptDelete({
      resourceUid,
      nativeId: input.nativeId,
      operationId: input.operationId,
    });
    if (!deleting) return failed("conflict", "the managed Module Worker delete is stale");
    if (
      !(await this.#state.commitReceiptDelete({
        resourceUid,
        nativeId: input.nativeId,
        operationId: input.operationId,
      }))
    ) {
      return failed("unavailable", "the managed Module Worker delete receipt is unavailable", true);
    }
    return deletedTicket(input.nativeId);
  }

  async #logicalWorkerHasActiveRoutes(logicalWorkerId: string): Promise<boolean> {
    for (const kind of ["host", "worker", "queue", "schedule"] as const) {
      const routes = await this.#state.activeRoutes(kind);
      for (const route of routes) {
        if (
          route.key === managedWorkerReleaseRouteKey(logicalWorkerId) ||
          route.value.logicalWorkerId === logicalWorkerId ||
          stringArray(route.value.logicalWorkerIds)?.includes(logicalWorkerId)
        )
          return true;
      }
    }
    return false;
  }

  async #deleteWorkerVersion(
    input: CloudflareWorkerDeleteInput,
    recovery: boolean,
  ): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid as string;
    let receipt = await this.#state.receiptByResourceUid(resourceUid);
    const native = parseManagedNativeId(input.nativeId);
    if (receipt?.state === "deleted" && receipt.nativeId === input.nativeId) {
      return deletedTicket(input.nativeId);
    }
    if (
      receipt?.kind !== "version" ||
      receipt.nativeId !== input.nativeId ||
      native?.kind !== "version"
    ) {
      return failed("not_found", "the managed Worker release is absent");
    }
    const requiredSensitive = sensitiveBindingNames(input.spec?.requiredSensitiveVars);
    const commitment = sha256Value(receipt.observed.runtimeInputCommitment);
    const releaseOperationId = text(receipt.observed.releaseOperationId);
    if (
      !input.spec ||
      !requiredSensitive ||
      !releaseOperationId ||
      (requiredSensitive.length > 0 && !commitment)
    ) {
      return failed("provider_error", "the managed Worker release receipt is malformed");
    }
    const closure = await this.#prepareRelease(
      {
        operationId: releaseOperationId,
        operationMode: "recovery",
        offering: input.offering,
        identity: input.identity,
        spec: input.spec,
        ...(input.relations === undefined ? {} : { relations: input.relations }),
      },
      requiredSensitive,
      commitment,
    );
    if ("phase" in closure) return closure;
    if (
      closure.nativeId !== input.nativeId ||
      closure.descriptorDigest !== receipt.descriptorDigest
    ) {
      return failed("conflict", "the managed Worker release desired closure changed");
    }
    if (receipt.state === "committed") {
      const read = await this.#readCommittedRelease(closure, receipt);
      if (read.phase === "failed" && read.failure.code !== "not_found") return read;
      const deleting = await this.#state.beginReceiptDelete({
        resourceUid,
        nativeId: input.nativeId,
        operationId: input.operationId,
      });
      if (!deleting) return failed("conflict", "the managed Worker release delete is stale");
      receipt = deleting;
    } else if (receipt.state !== "deleting" || receipt.operationId !== input.operationId) {
      return failed("conflict", "the managed Worker release delete is stale");
    }
    const absent = await this.#client.scriptAbsent(native.name);
    if (absent.ok === false)
      return wfpFailure(absent, "the managed Worker release delete readback failed");
    if (!absent.value) {
      if (recovery) {
        return failed(
          "unavailable",
          "the managed Worker release delete outcome is indeterminate",
          true,
        );
      }
      const removed = await this.#client.deleteScript(native.name);
      if (removed.ok === false) {
        return wfpFailure(removed, "the managed Worker release delete outcome is indeterminate");
      }
      const after = await this.#client.scriptAbsent(native.name);
      if (after.ok === false || !after.value) {
        return failed(
          "unavailable",
          "the managed Worker release delete outcome is indeterminate",
          true,
        );
      }
    }
    if (
      !(await this.#state.commitReceiptDelete({
        resourceUid,
        nativeId: input.nativeId,
        operationId: input.operationId,
      }))
    ) {
      return failed(
        "unavailable",
        "the managed Worker release delete receipt is unavailable",
        true,
      );
    }
    return deletedTicket(input.nativeId);
  }

  async #deleteDeployment(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid as string;
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (receipt?.state === "deleted" && receipt.nativeId === input.nativeId)
      return deletedTicket(input.nativeId);
    const deleting = await this.#state.beginReceiptDelete({
      resourceUid,
      nativeId: input.nativeId,
      operationId: input.operationId,
    });
    if (deleting?.kind !== "deployment") {
      return failed("conflict", "the managed Worker Deployment delete is stale");
    }
    const routeKey = text(deleting.observed.routeKey);
    if (!routeKey)
      return failed("provider_error", "the managed Worker Deployment receipt is malformed");
    const current = await this.#state.route("worker", routeKey);
    const operationId = await routeOperationId(input.operationId, "deployment-delete");
    if (
      current?.state === "active" &&
      (current.ownerNativeId !== `deployment:${resourceUid}` ||
        current.value.deploymentId !== input.nativeId)
    ) {
      return failed("conflict", "a newer managed Worker Deployment owns traffic");
    }
    if (current?.state === "active") {
      const tombstone = await this.#state.tombstoneRoute({
        kind: "worker",
        key: routeKey,
        ownerNativeId: `deployment:${resourceUid}`,
        operationId,
        predecessor: { kind: "exact", route: current },
      });
      if (!tombstone) return failed("conflict", "the managed Worker Deployment route changed");
    } else if (
      !current ||
      current.operationId !== operationId ||
      current.ownerNativeId !== `deployment:${resourceUid}` ||
      current.state !== "tombstone"
    ) {
      return failed("conflict", "the managed Worker Deployment route changed");
    }
    if (
      !(await this.#state.commitReceiptDelete({
        resourceUid,
        nativeId: input.nativeId,
        operationId: input.operationId,
      }))
    ) {
      return failed(
        "unavailable",
        "the managed Worker Deployment delete receipt is unavailable",
        true,
      );
    }
    return deletedTicket(input.nativeId);
  }

  async #deleteEndpoint(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid as string;
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (receipt?.state === "deleted" && receipt.nativeId === input.nativeId)
      return deletedTicket(input.nativeId);
    const deleting = await this.#state.beginReceiptDelete({
      resourceUid,
      nativeId: input.nativeId,
      operationId: input.operationId,
    });
    if (deleting?.kind !== "endpoint")
      return failed("conflict", "the managed Worker Endpoint delete is stale");
    const routeKey = text(deleting.observed.routeKey);
    if (!routeKey)
      return failed("provider_error", "the managed Worker Endpoint receipt is malformed");
    const current = await this.#state.route("host", routeKey);
    const operationId = await routeOperationId(input.operationId, "endpoint-delete");
    if (current?.state === "active" && current.ownerNativeId !== `endpoint:${resourceUid}`) {
      return failed("conflict", "a replacement managed Worker Endpoint owns the hostname");
    }
    if (current?.state === "active") {
      if (
        !(await this.#state.tombstoneRoute({
          kind: "host",
          key: routeKey,
          ownerNativeId: `endpoint:${resourceUid}`,
          operationId,
          predecessor: { kind: "exact", route: current },
        }))
      )
        return failed("conflict", "the managed Worker Endpoint route changed");
    } else if (
      !current ||
      current.operationId !== operationId ||
      current.ownerNativeId !== `endpoint:${resourceUid}` ||
      current.state !== "tombstone"
    ) {
      return failed("conflict", "the managed Worker Endpoint route changed");
    }
    if (
      !(await this.#state.commitReceiptDelete({
        resourceUid,
        nativeId: input.nativeId,
        operationId: input.operationId,
      }))
    ) {
      return failed(
        "unavailable",
        "the managed Worker Endpoint delete receipt is unavailable",
        true,
      );
    }
    return deletedTicket(input.nativeId);
  }

  async #deleteCron(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid as string;
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (receipt?.state === "deleted" && receipt.nativeId === input.nativeId)
      return deletedTicket(input.nativeId);
    const deleting = await this.#state.beginReceiptDelete({
      resourceUid,
      nativeId: input.nativeId,
      operationId: input.operationId,
    });
    if (deleting?.kind !== "cron")
      return failed("conflict", "the managed Worker Cron delete is stale");
    const cron = text(deleting.observed.cron) ?? text(input.spec?.cron);
    if (!cron) return failed("provider_error", "the managed Worker Cron receipt is malformed");
    const removed = await this.#writeScheduleMember({
      cron,
      logicalWorkerId: deleting.logicalWorkerId,
      operationId: await routeOperationId(input.operationId, "cron-delete"),
      action: "remove",
    });
    if (!removed) return failed("conflict", "the managed Worker schedule route changed");
    const synchronized = await this.#synchronizeGatewaySchedules(
      async (fence) =>
        await this.#state.commitReceiptDeleteAtScheduleFence({
          resourceUid,
          nativeId: input.nativeId,
          operationId: input.operationId,
          scheduleGeneration: fence.generation,
          scheduleDigest: fence.digest,
          scheduleLeaseToken: fence.leaseToken,
          now: fence.now,
        }),
    );
    if ("phase" in synchronized) return synchronized;
    const deleted = await this.#state.receiptByResourceUid(resourceUid);
    if (deleted?.state !== "deleted" || deleted.operationId !== input.operationId) {
      return failed("unavailable", "the managed Worker Cron delete receipt is unavailable", true);
    }
    return deletedTicket(input.nativeId);
  }

  async #deleteQueueConsumer(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket> {
    const resourceUid = input.identity.uid as string;
    const receipt = await this.#state.receiptByResourceUid(resourceUid);
    if (receipt?.state === "deleted" && receipt.nativeId === input.nativeId)
      return deletedTicket(input.nativeId);
    const native = parseManagedNativeId(input.nativeId);
    if (native?.kind !== "consumer")
      return failed("not_found", "the managed Queue Consumer is absent");
    const deleting = await this.#state.beginReceiptDelete({
      resourceUid,
      nativeId: input.nativeId,
      operationId: input.operationId,
    });
    if (deleting?.kind !== "consumer")
      return failed("conflict", "the managed Queue Consumer delete is stale");
    const desired = record(deleting.observed.consumerClosure);
    const routeKey = text(deleting.observed.routeKey);
    if (!desired || !routeKey)
      return failed("provider_error", "the Queue Consumer receipt is malformed");
    const path = `/accounts/${encodeURIComponent(this.#accountId)}/queues/${encodeURIComponent(native.parent)}/consumers/${encodeURIComponent(native.name)}`;
    const read = await this.#client.json("GET", path);
    if (read.ok === true) {
      const consumer = record(read.value);
      if (
        !consumer ||
        !consumerClosureMatches(consumer, desired) ||
        text(consumer.consumer_id) !== native.name
      ) {
        return failed("conflict", "the Queue Consumer native closure changed");
      }
      const removed = await this.#client.raw("DELETE", path);
      if (removed.ok === false && removed.status !== 404) {
        return wfpFailure(removed, "the Queue Consumer delete outcome is indeterminate");
      }
      const after = await this.#client.json("GET", path);
      if (after.ok || after.status !== 404) {
        return failed("unavailable", "the Queue Consumer delete outcome is indeterminate", true);
      }
    } else if (read.status !== 404) {
      return wfpFailure(read, "the Queue Consumer delete readback failed");
    }
    const current = await this.#state.route("queue", routeKey);
    const operationId = await routeOperationId(input.operationId, "consumer-delete");
    if (current?.state === "active" && current.ownerNativeId !== `consumer:${resourceUid}`) {
      return failed("conflict", "a replacement Queue Consumer owns the route");
    }
    if (current?.state === "active") {
      if (
        !(await this.#state.tombstoneRoute({
          kind: "queue",
          key: routeKey,
          ownerNativeId: `consumer:${resourceUid}`,
          operationId,
          predecessor: { kind: "exact", route: current },
        }))
      )
        return failed("conflict", "the managed Queue route changed");
    } else if (
      !current ||
      current.operationId !== operationId ||
      current.ownerNativeId !== `consumer:${resourceUid}` ||
      current.state !== "tombstone"
    ) {
      return failed("conflict", "the managed Queue route changed");
    }
    if (
      !(await this.#state.commitReceiptDelete({
        resourceUid,
        nativeId: input.nativeId,
        operationId: input.operationId,
      }))
    ) {
      return failed("unavailable", "the Queue Consumer delete receipt is unavailable", true);
    }
    return deletedTicket(input.nativeId);
  }
}

function providerKind(offering: ProviderOffering): string {
  return offering.kind.startsWith("takoform.") && isEdgeFormsApiVersion(offering.form.apiVersion)
    ? offering.form.kind
    : offering.kind;
}

function runtimeInputTarget(input: ApplyInput) {
  const worker = relationResource(input.relations, "/worker", "ModuleWorker");
  const bundle = relationResource(input.relations, "/bundle", "WorkerBundle");
  if (!worker || !bundle) return null;
  return {
    space: input.identity.space,
    workerName: worker.metadata.name,
    workerResourceUid: worker.metadata.uid,
    bundleName: bundle.metadata.name,
  };
}

function relationAt(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
): ProviderRelation | undefined {
  return relations?.find((candidate) => candidate.pointer === pointer);
}

function relationResource(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
  kind: string,
): ProviderRelation["resource"] | null {
  const relation = relationAt(relations, pointer);
  return relation?.resource.kind === kind ? relation.resource : null;
}

function relationOutput(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
  output: string,
): string | undefined {
  return text(relationAt(relations, pointer)?.deployment?.outputs[output]);
}

interface RelationNative {
  readonly kind: string;
  readonly name: string;
  readonly parent?: string;
}

function relationDeployment(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
  kind: string,
  optional = false,
): RelationNative | null {
  const nativeId = relationAt(relations, pointer)?.deployment?.nativeId;
  if (!nativeId) return optional ? null : null;
  const parts = nativeId.split(":");
  if (parts[0] !== kind) return null;
  if (parts.length === 2 && nativeSegment(parts[1])) return { kind, name: parts[1] };
  if (parts.length === 3 && nativeSegment(parts[1]) && nativeSegment(parts[2])) {
    return { kind, parent: parts[1], name: parts[2] };
  }
  return null;
}

type ManagedNative =
  | { readonly kind: "worker" | "endpoint" | "sqlite"; readonly name: string }
  | {
      readonly kind: "version" | "deployment" | "cron" | "consumer";
      readonly parent: string;
      readonly name: string;
    };

function parseManagedNativeId(value: string): ManagedNative | null {
  const parts = value.split(":");
  const kind = parts[0];
  if (
    (kind === "worker" || kind === "endpoint" || kind === "sqlite") &&
    parts.length === 2 &&
    nativeSegment(parts[1])
  ) {
    return { kind, name: parts[1] };
  }
  if (
    (kind === "version" || kind === "deployment" || kind === "cron" || kind === "consumer") &&
    parts.length === 3 &&
    nativeSegment(parts[1]) &&
    nativeSegment(parts[2])
  ) {
    return { kind, parent: parts[1], name: parts[2] };
  }
  return null;
}

function managedNativeId(value: string): boolean {
  return parseManagedNativeId(value) !== null;
}

function nativeSegment(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(value);
}

function nativeToken(value: string, label: string): string {
  if (!nativeSegment(value)) throw new TypeError(`invalid Cloudflare WfP ${label}`);
  return value;
}

function managedBaseDomain(value: string): string {
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

function managedEndpointAddress(
  canonicalPublicOrigin: string,
  baseDomain: string,
): { readonly origin: string; readonly hostname: string } | null {
  if (canonicalPublicOrigin.length > 2_048) return null;
  try {
    const url = new URL(canonicalPublicOrigin);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin !== canonicalPublicOrigin ||
      !url.hostname.endsWith(`.${baseDomain}`) ||
      url.hostname === baseDomain
    ) {
      return null;
    }
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return null;
  }
}

function compatibilityDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError("invalid compatibility date");
  return value;
}

function workerHandlers(value: JsonValue | undefined): readonly ManagedWorkerHandlerName[] | null {
  if (!Array.isArray(value) || value.length < 1) return null;
  const handlers = value.filter(
    (handler): handler is ManagedWorkerHandlerName =>
      typeof handler === "string" &&
      (MANAGED_WORKER_HANDLER_NAMES as readonly string[]).includes(handler),
  );
  if (handlers.length !== value.length || new Set(handlers).size !== handlers.length) return null;
  return [...handlers].sort();
}

function sensitiveBindingNames(value: JsonValue | undefined): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names = value.filter((entry): entry is string => typeof entry === "string");
  if (
    names.length !== value.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name))
  )
    return null;
  return [...names].sort();
}

function exactRuntimeInputBindings(
  bindings: Readonly<Record<string, string>>,
  expectedNames: readonly string[],
): boolean {
  return (
    sameStrings(Object.keys(bindings), expectedNames) &&
    Object.keys(bindings).every(
      (name) => typeof bindings[name] === "string" && (bindings[name] as string).length > 0,
    )
  );
}

async function abortRuntimeLease(lease: ProviderRuntimeInputLease): Promise<ProviderTicket | null> {
  try {
    await lease.abort();
    return null;
  } catch (error) {
    return runtimeInputFailure(error, "abort");
  }
}

function runtimeInputFailure(
  error: unknown,
  phase: "acquire" | "abort" | "dispatch" | "recover" | "settle",
): ProviderTicket {
  const code = text(record(error)?.code);
  if (phase !== "acquire" || code === "unavailable") {
    return failed(
      "unavailable",
      "the sensitive Worker runtime input outcome is indeterminate",
      true,
    );
  }
  // The handoff exists but it was made for a different mutation. This is a
  // definitive refusal of this apply, never a retry: the values belong to the
  // request the preparation named and to no other.
  if (code === "apply_commitment_mismatch") {
    return failed(
      "denied",
      "the sensitive Worker runtime input handoff does not authorize this apply",
    );
  }
  return code === "conflict"
    ? failed("conflict", "the sensitive Worker runtime input lease conflicts")
    : failed("denied", "required sensitive Worker runtime inputs are unavailable");
}

function releaseForm(closure: ManagedReleaseClosure): FormData {
  const form = new FormData();
  form.set(
    "metadata",
    new Blob([JSON.stringify(closure.uploadMetadata)], { type: "application/json" }),
    "metadata.json",
  );
  for (const module of closure.modules) {
    form.set(
      module.name,
      new Blob([module.bytes.slice().buffer], { type: module.mediaType }),
      module.name,
    );
  }
  form.set(
    closure.wrapperModule,
    new Blob([closure.wrapperSource], { type: "application/javascript+module" }),
    closure.wrapperModule,
  );
  return form;
}

function managedWrapperModuleName(moduleNames: readonly string[]): string {
  const occupied = new Set(moduleNames);
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const name = `__takoserver_managed_worker_entrypoint${suffix === 1 ? "" : `_${suffix}`}.mjs`;
    if (!occupied.has(name)) return name;
  }
  throw new TypeError("managed Worker wrapper module name is unavailable");
}

function artifactPartName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$/u.test(value) &&
    !value.split("/").includes("..")
  );
}

function bindingName(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(value);
}

function variableBindingName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function moduleMediaType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [
      "application/javascript+module",
      "application/javascript",
      "text/javascript",
      "application/wasm",
      "text/plain",
      "application/octet-stream",
    ].includes(value.split(";", 1)[0]?.trim().toLowerCase() ?? "")
  );
}

function canonicalModuleMediaType(value: string): string {
  const type = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "application/javascript+module" ||
    type === "application/javascript" ||
    type === "text/javascript"
    ? "application/javascript+module"
    : type;
}

function canonicalBindingSettings(
  bindings: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  return bindings
    .map((binding) => {
      const copy = { ...binding };
      if (copy.type === "secret_text") delete copy.text;
      return sortJson(copy) as Readonly<Record<string, unknown>>;
    })
    .sort((left, right) =>
      `${String(left.name)}\0${String(left.type)}`.localeCompare(
        `${String(right.name)}\0${String(right.type)}`,
      ),
    );
}

function releaseSettingsMatch(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  const actualBindings = Array.isArray(actual.bindings) ? actual.bindings.map(record) : null;
  if (!actualBindings || actualBindings.some((binding) => !binding)) return false;
  const normalized = {
    main_module: actual.main_module,
    compatibility_date: actual.compatibility_date,
    compatibility_flags: actual.compatibility_flags,
    bindings: canonicalBindingSettings(
      actualBindings as readonly Readonly<Record<string, unknown>>[],
    ),
  };
  return (
    canonicalJson(normalized) === canonicalJson(expected) &&
    Object.keys(actual).every(
      (key) =>
        key === "main_module" ||
        key === "compatibility_date" ||
        key === "compatibility_flags" ||
        key === "bindings",
    )
  );
}

function releaseSecretNamesMatch(
  secrets: readonly Readonly<Record<string, unknown>>[],
  expected: readonly string[],
): boolean {
  const names = secrets.map((secret) => text(secret.name));
  return (
    names.every((name): name is string => !!name) &&
    new Set(names).size === names.length &&
    sameStrings(names, expected)
  );
}

async function releaseContentMatches(
  readback: CloudflareWfpScriptReadback,
  closure: ManagedReleaseClosure,
): Promise<boolean> {
  if (!readback.contentType.toLowerCase().startsWith("multipart/form-data")) return false;
  const expected = new Map<string, { readonly mediaType: string; readonly bytes: Uint8Array }>();
  for (const module of closure.modules) {
    expected.set(module.name, { mediaType: module.mediaType, bytes: module.bytes });
  }
  expected.set(closure.wrapperModule, {
    mediaType: "application/javascript+module",
    bytes: new TextEncoder().encode(closure.wrapperSource),
  });
  let content: FormData;
  try {
    content = await new Response(readback.content.slice().buffer, {
      headers: { "content-type": readback.contentType },
    }).formData();
  } catch {
    return false;
  }
  const seen = new Set<string>();
  let sawMetadata = false;
  for (const [name, value] of content.entries()) {
    if (name === "metadata") {
      if (sawMetadata) return false;
      sawMetadata = true;
      continue;
    }
    const wanted = expected.get(name);
    if (!wanted || typeof value === "string" || seen.has(name)) return false;
    const blob = value as Blob;
    if (
      blob.type &&
      canonicalModuleMediaType(blob.type) !== canonicalModuleMediaType(wanted.mediaType)
    ) {
      return false;
    }
    const actual = new Uint8Array(await blob.arrayBuffer());
    if (!sameBytes(actual, wanted.bytes)) return false;
    seen.add(name);
  }
  return sawMetadata && seen.size === expected.size;
}

function releaseReceiptObserved(
  closure: ManagedReleaseClosure,
  observed: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, unknown>> {
  return {
    ...observed,
    releaseOperationId: closure.operationId,
    runtimeInputCommitment: closure.runtimeInputCommitment ?? null,
    manifestDigest: closure.manifestDigest,
  };
}

async function releaseRuntimeInputReceiptDigest(
  accountId: string,
  closure: ManagedReleaseClosure,
  secretNames: readonly string[],
  providerEtag: string,
): Promise<`sha256:${string}`> {
  return await digestJson({
    schema: "takoserver.cloudflare-wfp-release-receipt@v1",
    accountId,
    nativeId: closure.nativeId,
    descriptorDigest: closure.descriptorDigest,
    providerEtag,
    secretNames: [...secretNames].sort(),
    runtimeInputCommitment: closure.runtimeInputCommitment ?? null,
  });
}

function consumerSettings(spec: JsonObject): Readonly<Record<string, number>> | null {
  const maxBatchSize = integer(spec.maxBatchSize);
  const maxBatchTimeoutSeconds = integer(spec.maxBatchTimeoutSeconds);
  const maxRetries = integer(spec.maxRetries);
  const retryDelaySeconds = integer(spec.retryDelaySeconds);
  const maxConcurrency = integer(spec.maxConcurrency);
  if (
    maxBatchSize === undefined ||
    maxBatchTimeoutSeconds === undefined ||
    maxRetries === undefined ||
    retryDelaySeconds === undefined ||
    maxConcurrency === undefined
  )
    return null;
  return {
    batch_size: maxBatchSize,
    max_wait_time_ms: maxBatchTimeoutSeconds * 1_000,
    max_retries: maxRetries,
    retry_delay: retryDelaySeconds,
    max_concurrency: maxConcurrency,
  };
}

function consumerClosureMatches(
  actual: Readonly<Record<string, unknown>>,
  desired: Readonly<Record<string, unknown>>,
): boolean {
  const actualSettings = record(actual.settings);
  const desiredSettings = record(desired.settings);
  if (!actualSettings || !desiredSettings) return false;
  if (
    Object.keys(actualSettings).sort().join(",") !== Object.keys(desiredSettings).sort().join(",")
  )
    return false;
  const normalized = {
    type: actual.type,
    script_name: actual.script_name,
    settings: Object.fromEntries(
      Object.keys(desiredSettings).map((key) => [key, actualSettings[key]]),
    ),
    ...(actual.dead_letter_queue === undefined
      ? {}
      : { dead_letter_queue: actual.dead_letter_queue }),
  };
  return canonicalJson(normalized) === canonicalJson(desired);
}

function providerList(value: unknown, key: string): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  const parent = record(value);
  return Array.isArray(parent?.[key]) ? (parent[key] as readonly unknown[]) : null;
}

function scheduleValues(value: unknown): readonly string[] | null {
  const list = providerList(value, "schedules");
  if (!list) return null;
  const crons = list.map((entry) => text(record(entry)?.cron));
  return crons.every((cron): cron is string => !!cron) ? [...new Set(crons)].sort() : null;
}

function scheduleCronsFromRoutes(
  routes: readonly ManagedWorkerRouteState[],
): readonly string[] | null {
  const prefix = "schedule/v1/";
  const schedules: string[] = [];
  try {
    for (const route of routes) {
      if (!route.key.startsWith(prefix)) return null;
      schedules.push(decodeURIComponent(route.key.slice(prefix.length)));
    }
  } catch {
    return null;
  }
  return [...new Set(schedules)].sort();
}

async function managedScheduleDigest(schedules: readonly string[]): Promise<`sha256:${string}`> {
  return await digestJson({
    schema: "takoserver.managed-worker-schedules@v1",
    schedules: [...schedules].sort(),
  });
}

function validScheduleOperatorProof(value: CloudflareManagedScheduleOperatorProof): boolean {
  const raw = record(value);
  return (
    !!raw &&
    Object.keys(raw).sort().join(",") ===
      "action,actualDigest,ambiguousGeneration,desiredGeneration,leaseToken,operatorAcknowledgement" &&
    (raw.action === "accept-provider-state" || raw.action === "replace-with-desired") &&
    typeof raw.operatorAcknowledgement === "string" &&
    raw.operatorAcknowledgement.length >= 8 &&
    raw.operatorAcknowledgement.length <= 512 &&
    noControlCharacters(raw.operatorAcknowledgement) &&
    typeof raw.leaseToken === "string" &&
    raw.leaseToken.length >= 3 &&
    raw.leaseToken.length <= 128 &&
    Number.isSafeInteger(raw.ambiguousGeneration) &&
    Number(raw.ambiguousGeneration) > 0 &&
    Number.isSafeInteger(raw.desiredGeneration) &&
    Number(raw.desiredGeneration) > 0 &&
    sha256(raw.actualDigest)
  );
}

function noControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? value
    : null;
}

function sqliteAuthority(
  providerId: string,
  resourceUid: string,
  descriptorDigest: `sha256:${string}`,
): ManagedWorkerSqliteAuthority {
  return {
    providerId,
    resourceUid,
    generation: "1",
    operationId: `sqlite-${descriptorDigest.slice("sha256:".length)}`,
    descriptorDigest,
  };
}

function sqliteInspectionMatches(
  result: ManagedWorkerSqliteAdminResult<ManagedWorkerSqliteInspectResult>,
  authority: ManagedWorkerSqliteAuthority,
  state: "active" | "destroyed",
): boolean {
  if (!result.ok) return false;
  const value = record(result.value);
  const actualAuthority = record(value?.authority);
  const migrations = Array.isArray(value?.migrations) ? value.migrations : null;
  return (
    !!value &&
    value.state === state &&
    Object.keys(value).sort().join(",") === "authority,migrations,state" &&
    !!actualAuthority &&
    Object.keys(actualAuthority).sort().join(",") ===
      "descriptorDigest,generation,operationId,providerId,resourceUid" &&
    actualAuthority.providerId === authority.providerId &&
    actualAuthority.resourceUid === authority.resourceUid &&
    actualAuthority.generation === authority.generation &&
    actualAuthority.operationId === authority.operationId &&
    actualAuthority.descriptorDigest === authority.descriptorDigest &&
    !!migrations &&
    migrations.every((entry) => {
      const migration = record(entry);
      return (
        !!migration &&
        Object.keys(migration).sort().join(",") === "digest,path" &&
        typeof migration.path === "string" &&
        migrationPath(migration.path) &&
        sha256(migration.digest)
      );
    })
  );
}

function sqliteInitializationMatches(
  result: ManagedWorkerSqliteAdminResult<{ readonly state: "active" }>,
): boolean {
  if (!result.ok) return false;
  const value = record(result.value);
  return !!value && value.state === "active" && Object.keys(value).join(",") === "state";
}

function sqliteDestructionMatches(
  result: ManagedWorkerSqliteAdminResult<{ readonly destroyed: true }>,
): boolean {
  if (!result.ok) return false;
  const value = record(result.value);
  return !!value && value.destroyed === true && Object.keys(value).join(",") === "destroyed";
}

function sqliteTicketFailure(error: { readonly code: string } | undefined): ProviderTicket {
  return error?.code === "conflict"
    ? failed("conflict", "the managed SQLite authority conflicts")
    : error?.code === "not_found"
      ? failed("not_found", "the managed SQLite authority is absent")
      : failed("unavailable", "the managed SQLite authority is unavailable", true);
}

function sqliteProviderFailure<T>(error: { readonly code: string } | undefined): ProviderValue<T> {
  return error?.code === "conflict"
    ? providerValueFailure("conflict", "the managed SQLite authority conflicts")
    : error?.code === "not_found"
      ? providerValueFailure("not_found", "the managed SQLite authority is absent")
      : providerValueFailure("unavailable", "the managed SQLite authority is unavailable", true);
}

function managedStateTicketFailure(error: unknown): ProviderTicket {
  return error instanceof ManagedWorkerStateCorruptionError
    ? failed("provider_error", error.message)
    : failed("unavailable", "the managed Worker authority is unavailable", true);
}

function managedStateProviderFailure<T>(error: unknown): ProviderValue<T> {
  return error instanceof ManagedWorkerStateCorruptionError
    ? providerValueFailure("provider_error", error.message)
    : providerValueFailure("unavailable", "the managed SQLite authority is unavailable", true);
}

class ManagedScheduleProviderReadError extends Error {
  constructor(readonly retryable: boolean) {
    super("the gateway schedule readback is unavailable");
    this.name = "ManagedScheduleProviderReadError";
  }
}

function managedScheduleProviderFailure<T>(error: unknown): ProviderValue<T> {
  return error instanceof ManagedWorkerStateCorruptionError
    ? providerValueFailure("provider_error", error.message)
    : error instanceof ManagedScheduleProviderReadError
      ? providerValueFailure("unavailable", error.message, error.retryable)
      : providerValueFailure("unavailable", "the managed schedule authority is unavailable", true);
}

function deletedTicket(nativeId: string): ProviderTicket {
  return succeeded({
    nativeId,
    disposition: "deleted",
    observed: { deleted: true },
    outputs: {},
  });
}

function absence(
  outcome: "absent" | "present",
  provider: string,
  kind: string,
): ProviderNativeAbsence {
  return { outcome, evidence: { provider, kind, state: outcome } };
}

function absenceFailure(
  result: Extract<CloudflareWfpClientResult<unknown>, { readonly ok: false }>,
): ProviderNativeAbsence {
  if (result.status === 401 || result.status === 403) {
    return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
  }
  if (result.malformed) return { outcome: "unknown", reason: "malformed", retryable: false };
  return {
    outcome: "unknown",
    reason: "transport",
    retryable:
      result.indeterminate || result.status === 0 || result.status === 429 || result.status >= 500,
  };
}

function wfpFailure(
  result: Extract<CloudflareWfpClientResult<unknown>, { readonly ok: false }>,
  message: string,
): ProviderTicket {
  if (result.status === 400 || result.status === 422) return failed("invalid_spec", message);
  if (result.status === 401 || result.status === 403) return failed("denied", message);
  if (result.status === 404) return failed("not_found", message);
  if (result.status === 409) return failed("conflict", message);
  if (result.status === 429) return failed("quota", message, true);
  return failed(
    result.malformed ? "provider_error" : "unavailable",
    message,
    result.indeterminate || result.status === 0 || result.status >= 500,
  );
}

function providerValueFailure<T>(
  code: Parameters<typeof failed>[0],
  message: string,
  retryable = false,
): ProviderValue<T> {
  return { ok: false, failure: { code, message, retryable } };
}

function migrationPath(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 255 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function sha256Value(value: unknown): `sha256:${string}` | undefined {
  return sha256(value) ? value : undefined;
}

async function digestText(value: string): Promise<`sha256:${string}`> {
  return await digestBytes(new TextEncoder().encode(value));
}

async function digestJson(value: unknown): Promise<`sha256:${string}`> {
  return await digestText(canonicalJson(value));
}

async function digestBytes(value: Uint8Array): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", value as unknown as BufferSource),
  );
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function routeOperationId(operationId: string, action: string): Promise<string> {
  return `route-${(await digestText(`${action}\n${operationId}`)).slice(7)}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
