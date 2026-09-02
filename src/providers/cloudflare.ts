import { isEdgeFormsApiVersion } from "../form-ref.ts";
import type { JsonObject, JsonValue } from "../ports.ts";
import type { ProviderRelation, ProviderRuntimeBinding } from "../provider-port.ts";
import {
  type ApplyInput,
  failed,
  PROVIDER_READBACK_API_VERSION,
  type Provider,
  type ProviderNativeAbsence,
  type ProviderNativeAbsenceUnknownReason,
  type ProviderNativeReadbackDescriptor,
  type ProviderNativeReadbackInput,
  type ProviderOffering,
  ProviderReadbackDescriptorError,
  type ProviderSqliteMigration,
  type ProviderSqliteMigrationIdentity,
  type ProviderTicket,
  type ProviderValue,
  succeeded,
} from "../provider-port.ts";
import type {
  ProviderRuntimeInputDispatchedLease,
  ProviderRuntimeInputLease,
  ProviderRuntimeInputLeasePort,
  ProviderRuntimeInputPublicApply,
} from "../provider-runtime-input-port.ts";
import { MAX_PROVIDER_RUNTIME_INPUT_BINDINGS } from "../provider-runtime-input-port.ts";
import {
  canonicalWorkerEndpointOrigin,
  derivedProviderResourceName,
} from "../provider-worker-endpoint-origin.ts";
import {
  cloudflareR2EdgeObjectsMaterial,
  EDGE_OBJECTS_BINDING_REF,
} from "./cloudflare-runtime-bindings.ts";
import { CloudflareWfpBackend } from "./cloudflare-wfp-backend.ts";
import type {
  ArtifactBytes,
  CloudflareManagedScheduleOperatorProof,
  CloudflareManagedScheduleReconciliationStatus,
  CloudflareWorkerBackend,
  CloudflareWorkerBackendOptions,
} from "./cloudflare-worker-backend.ts";

export type {
  ArtifactBytes,
  CloudflareManagedScheduleOperatorProof,
  CloudflareManagedScheduleReconciliationStatus,
  CloudflareOrdinaryWorkerBackendOptions,
  CloudflareWorkerBackendOptions,
  CloudflareWorkersForPlatformsBackendOptions,
  TakoformBundleManifest,
} from "./cloudflare-worker-backend.ts";

/**
 * Provisioning on Cloudflare through its REST API.
 *
 * This module runs inside the API Worker itself (ADR 0001): customer Workers
 * are separate scripts with separate bundles, so holding a scoped account
 * token here hands reach to nobody else. The token must stay scoped — Workers
 * Scripts, R2, D1, and the configured zones only — because the blast radius
 * of this isolate is exactly what that token can do.
 *
 * Everything Cloudflare-shaped stops here: URLs, envelopes, and error bodies.
 * What crosses back is a classified ticket.
 */

const API_ORIGIN = "https://api.cloudflare.com/client/v4";

/** Same concrete kind set consumed by `apply`'s provider dispatch below. */
export const CLOUDFLARE_TAKOFORM_HANDLER_KINDS = [
  "ModuleWorker",
  "EdgeKVNamespace",
  "SQLiteDatabase",
  "AtLeastOnceQueue",
  "ObjectBucket",
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerEndpoint",
  "WorkerCustomDomain",
  "WorkerCronTrigger",
  "QueueConsumer",
] as const;

const cloudflareTakoformHandlerKinds = new Set<string>(CLOUDFLARE_TAKOFORM_HANDLER_KINDS);

/** The name a script reaches its own static assets by. */
const ASSETS_BINDING = "ASSETS";

/**
 * Cloudflare's Versions API accepts a new version only after the script
 * container exists. A ModuleWorker therefore owns one inert bootstrap module;
 * customer bytes arrive later through WorkerVersion and traffic moves only
 * through WorkerDeployment/WorkerEndpoint.
 */
const BOOTSTRAP_MODULE = "takoserver-bootstrap.mjs";
const BOOTSTRAP_SOURCE =
  'export default { async fetch() { return new Response("Not deployed", { status: 503 }); } };\n';

const WORKER_VERSION_RECOVERY_PAGE_SIZE = 100;
const WORKER_VERSION_RECOVERY_PAGE_LIMIT = 10;
const WORKER_VERSION_OPERATION_ID_BYTE_LIMIT = 512;
const WORKER_VERSION_OPERATION_MARKER_BINDING = "TAKOSERVER_INTERNAL_OPERATION_MARKER";
const WORKER_VERSION_OPERATION_MARKER_PREFIX = "tsop-v1:";
const WORKER_VERSION_RUNTIME_INPUT_COMMITMENT_BINDING =
  "TAKOSERVER_INTERNAL_RUNTIME_INPUT_COMMITMENT";

const SQLITE_MIGRATION_LEDGER = "_takoform_sqlite_migrations";
const SQLITE_MIGRATION_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${SQLITE_MIGRATION_LEDGER} (
  sequence INTEGER PRIMARY KEY NOT NULL CHECK (sequence > 0),
  path TEXT NOT NULL UNIQUE CHECK (length(path) BETWEEN 1 AND 255),
  digest TEXT NOT NULL CHECK (
    substr(digest, 1, 7) = 'sha256:' AND length(digest) = 71 AND
    substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
  )
)`;

/** Cloudflare's code for "that hostname already resolves to something else". */
const DNS_RECORDS_PRESENT = 100_117;

/**
 * A DNS zone this deployment may attach customer Workers to.
 *
 * `suffix` is what a hostname must end with to belong to the zone. A platform
 * zone (`apps.takoserver.com`) is how a tenant gets a free address; a customer
 * zone is one the operator has added after the customer proved they control
 * it. A hostname matching no configured zone is refused — that refusal is the
 * ownership boundary, and it is why a tenant cannot claim somebody else's
 * domain by declaring it.
 */
export interface CloudflareZone {
  readonly suffix: string;
  readonly zoneId: string;
  /** Restricts the zone to one tenant. Absent means any tenant may use it. */
  readonly tenantRef?: string;
  /**
   * Labels the platform keeps for itself. A shared zone hands out first-level
   * names to whoever asks first, so the names the operator needs — and the ones
   * a visitor would read as official — must not be claimable.
   */
  readonly reservedLabels?: readonly string[];
  /**
   * Requires the hostname to sit exactly one label below the suffix. Universal
   * TLS certificates cover one level only, so a deeper name resolves and then
   * fails to negotiate — an address that looks issued and does not work.
   */
  readonly singleLabel?: boolean;
  /**
   * Whether the zone's own name may be served.
   *
   * A customer who brought their own domain needs their apex — `example.com`
   * with nothing in front of it is the address they actually want. A shared
   * platform zone must never offer its apex, because that name *is* the
   * platform, so this defaults to refusing it and is turned on per zone.
   */
  readonly apex?: boolean;
}

export interface CloudflareProviderOptions {
  readonly id?: string;
  readonly accountId: string;
  readonly zones?: readonly CloudflareZone[];
  readonly offerings: readonly ProviderOffering[];
  readonly recoveryOfferings?: readonly ProviderOffering[];
  readonly artifacts: ArtifactBytes;
  /** Returns an `Authorization` header value. Credentials never live here. */
  readonly authorize: () => Promise<string> | string;
  readonly apiOrigin?: string;
  /** Closed placement contract for every Worker-shaped resource. */
  readonly workerBackend?: CloudflareWorkerBackendOptions;
  /** Exact suffix assigned to this account, for example `team.workers.dev`. */
  /** @deprecated Prefer `workerBackend: { kind: "ordinary-workers", ... }`. */
  readonly workerEndpointSuffix?: string;
  readonly workerCompatibilityDate?: string;
  /** Host-owned one-shot runtime input authority; absent disables sensitive bindings. */
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export class CloudflareProvider implements Provider {
  readonly id: string;
  readonly offerings: readonly ProviderOffering[];
  readonly recoveryOfferings?: readonly ProviderOffering[];
  readonly workerEndpointOriginReservations: NonNullable<
    Provider["workerEndpointOriginReservations"]
  >;
  readonly runtimeInputCapabilities?: { readonly maximumBindings: number };
  readonly #accountId: string;
  readonly #origin: string;
  readonly #artifacts: ArtifactBytes;
  readonly #zones: readonly CloudflareZone[];
  readonly #authorize: CloudflareProviderOptions["authorize"];
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #workerEndpointSuffix: string | undefined;
  readonly #workerBackend: CloudflareWorkerBackend | undefined;
  readonly #workerCompatibilityDate: string;
  readonly #runtimeInputs: ProviderRuntimeInputLeasePort | undefined;

  constructor(options: CloudflareProviderOptions) {
    this.id = options.id ?? "cloudflare";
    this.#accountId = options.accountId;
    this.#origin = options.apiOrigin ?? API_ORIGIN;
    this.offerings = structuredClone(options.offerings);
    if (options.recoveryOfferings) {
      this.recoveryOfferings = structuredClone(options.recoveryOfferings);
    }
    this.#artifacts = options.artifacts;
    this.#zones = [...(options.zones ?? [])];
    this.#authorize = options.authorize;
    this.#fetch = options.fetch ?? ((request) => fetch(request));
    this.#workerCompatibilityDate = options.workerCompatibilityDate ?? "2026-08-19";
    this.#runtimeInputs = options.runtimeInputs;
    const workerBackend = options.workerBackend ?? {
      kind: "ordinary-workers" as const,
      ...(options.workerEndpointSuffix === undefined
        ? {}
        : { workerEndpointSuffix: options.workerEndpointSuffix }),
    };
    this.#workerEndpointSuffix =
      workerBackend.kind === "ordinary-workers" ? workerBackend.workerEndpointSuffix : undefined;
    this.#workerBackend =
      workerBackend.kind === "workers-for-platforms"
        ? new CloudflareWfpBackend({
            ...workerBackend,
            providerId: this.id,
            accountId: this.#accountId,
            apiOrigin: this.#origin,
            authorize: this.#authorize,
            fetch: this.#fetch,
            artifacts: this.#artifacts,
            ...(this.#runtimeInputs === undefined ? {} : { runtimeInputs: this.#runtimeInputs }),
            workerCompatibilityDate: this.#workerCompatibilityDate,
          })
        : undefined;
    this.workerEndpointOriginReservations = {
      derive: async (input) => {
        if (this.#workerBackend) return await this.#workerBackend.deriveOrigin(input);
        if (!this.#workerEndpointSuffix) return null;
        const canonicalPublicOrigin = canonicalWorkerEndpointOrigin(
          input.requestedSubdomain,
          this.#workerEndpointSuffix,
        );
        return canonicalPublicOrigin ? { canonicalPublicOrigin } : null;
      },
    };
    if (options.runtimeInputs) {
      this.runtimeInputCapabilities = {
        maximumBindings: MAX_PROVIDER_RUNTIME_INPUT_BINDINGS,
      };
    }
  }

  async managedScheduleReconciliationStatus(): Promise<
    ProviderValue<CloudflareManagedScheduleReconciliationStatus>
  > {
    if (!this.#workerBackend?.managedScheduleReconciliationStatus) {
      return providerValueFailure(
        "invalid_spec",
        "the managed Worker schedule operator is unavailable",
      );
    }
    return await this.#workerBackend.managedScheduleReconciliationStatus();
  }

  async reconcileManagedSchedules(
    proof: CloudflareManagedScheduleOperatorProof,
  ): Promise<ProviderValue<CloudflareManagedScheduleReconciliationStatus>> {
    if (!this.#workerBackend?.reconcileManagedSchedules) {
      return providerValueFailure(
        "invalid_spec",
        "the managed Worker schedule operator is unavailable",
      );
    }
    return await this.#workerBackend.reconcileManagedSchedules(proof);
  }

  readonly sqliteMigrations = {
    readLedger: async (input: {
      readonly nativeId: string;
    }): Promise<ProviderValue<readonly ProviderSqliteMigrationIdentity[]>> => {
      if (this.#workerBackend?.readSqliteMigrationLedger) {
        return await this.#workerBackend.readSqliteMigrationLedger(input);
      }
      const databaseId = d1DatabaseId(input.nativeId);
      if (!databaseId)
        return providerValueFailure("invalid_spec", "the database identity is invalid");
      const exists = await this.#d1Query(databaseId, {
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 2",
        params: [SQLITE_MIGRATION_LEDGER],
      });
      if (!exists.ok) return callFailure(exists);
      const existsRows = d1Rows(exists.result);
      if (!existsRows || existsRows.length > 1) {
        return providerValueFailure("provider_error", "the migration ledger response is invalid");
      }
      if (existsRows.length === 0) return { ok: true, value: [] };

      const read = await this.#d1Query(databaseId, {
        sql: `SELECT sequence, path, digest FROM ${SQLITE_MIGRATION_LEDGER} ORDER BY sequence`,
      });
      if (!read.ok) return callFailure(read);
      const rows = d1Rows(read.result);
      if (!rows) {
        return providerValueFailure("provider_error", "the migration ledger response is invalid");
      }
      const ledger: ProviderSqliteMigrationIdentity[] = [];
      for (const [index, rowValue] of rows.entries()) {
        const row = record(rowValue);
        const sequence = integer(row?.sequence);
        const path = optionalString(row?.path);
        const digest = optionalString(row?.digest);
        if (sequence !== index + 1 || !migrationPath(path) || !sha256Digest(digest)) {
          return providerValueFailure("provider_error", "the migration ledger is malformed");
        }
        ledger.push({ path, digest });
      }
      return { ok: true, value: ledger };
    },
    applySuffix: async (input: {
      readonly nativeId: string;
      readonly expectedPrefix: readonly ProviderSqliteMigrationIdentity[];
      readonly migrations: readonly ProviderSqliteMigration[];
    }): Promise<ProviderValue<undefined>> => {
      if (this.#workerBackend?.applySqliteMigrationSuffix) {
        return await this.#workerBackend.applySqliteMigrationSuffix(input);
      }
      const databaseId = d1DatabaseId(input.nativeId);
      if (!databaseId)
        return providerValueFailure("invalid_spec", "the database identity is invalid");
      if (input.migrations.length < 1 || input.migrations.length > 100) {
        return providerValueFailure("invalid_spec", "the migration suffix is invalid");
      }
      const expected = JSON.stringify(input.expectedPrefix);
      if (expected.length > 64 * 1_024) {
        return providerValueFailure("invalid_spec", "the migration prefix is too large");
      }
      const batch: { sql: string; params?: readonly (string | number)[] }[] = [
        { sql: SQLITE_MIGRATION_LEDGER_DDL },
        {
          sql: `INSERT INTO ${SQLITE_MIGRATION_LEDGER} (sequence, path, digest)
SELECT 0, '__takoform_guard__', 'sha256:${"0".repeat(64)}'
WHERE (SELECT COUNT(*) FROM ${SQLITE_MIGRATION_LEDGER}) != ?
   OR EXISTS (
     SELECT 1 FROM json_each(?) AS expected
     LEFT JOIN ${SQLITE_MIGRATION_LEDGER} AS actual
       ON actual.sequence = CAST(expected.key AS INTEGER) + 1
     WHERE actual.path IS NULL
        OR actual.path != json_extract(expected.value, '$.path')
        OR actual.digest != json_extract(expected.value, '$.digest')
   )`,
          params: [input.expectedPrefix.length, expected],
        },
      ];
      for (const [offset, migration] of input.migrations.entries()) {
        if (!migrationPath(migration.path) || !sha256Digest(migration.digest)) {
          return providerValueFailure("invalid_spec", "a migration identity is invalid");
        }
        let sql: string;
        try {
          sql = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          }).decode(migration.sql);
        } catch {
          return providerValueFailure("invalid_spec", "a migration is not UTF-8 SQL");
        }
        if (sql.length === 0 || sql.length > 100_000) {
          return providerValueFailure("invalid_spec", "a migration SQL statement is invalid");
        }
        batch.push(
          { sql },
          {
            sql: `INSERT INTO ${SQLITE_MIGRATION_LEDGER} (sequence, path, digest) VALUES (?, ?, ?)`,
            params: [input.expectedPrefix.length + offset + 1, migration.path, migration.digest],
          },
        );
      }
      const applied = await this.#d1Query(databaseId, { batch });
      if (!applied.ok) return callFailure(applied);
      const results = d1Results(applied.result);
      if (
        !results ||
        results.length !== batch.length ||
        results.some((result) => result.success !== true)
      ) {
        return providerValueFailure("provider_error", "the migration batch result is invalid");
      }
      return { ok: true, value: undefined };
    },
  };

  async apply(input: ApplyInput): Promise<ProviderTicket> {
    if (this.#workerBackend?.owns(input.offering)) {
      return await this.#workerBackend.apply(input);
    }
    const canRecoverWorkerVersion =
      input.offering.kind.startsWith("takoform.") &&
      isEdgeFormsApiVersion(input.offering.form.apiVersion) &&
      input.offering.form.kind === "WorkerVersion";
    if (input.operationMode === "recovery" && !canRecoverWorkerVersion) {
      // The request may have crossed a mutating Cloudflare endpoint before its
      // response was lost. Unless this operation has a deterministic recovery
      // identity, a second POST/PUT would be an unbounded duplicate mutation.
      // Leave the durable Host saga in its repair state instead.
      return failed(
        "unavailable",
        "the provider mutation outcome is indeterminate; operator repair is required",
        true,
      );
    }
    if (
      input.offering.kind.startsWith("takoform.") &&
      isEdgeFormsApiVersion(input.offering.form.apiVersion) &&
      cloudflareTakoformHandlerKinds.has(input.offering.form.kind)
    ) {
      switch (input.offering.form.kind) {
        case "ModuleWorker":
          return await this.#applyModuleWorker(input);
        case "EdgeKVNamespace":
          return await this.#applyKvNamespace(input);
        case "SQLiteDatabase":
          return await this.#applyDatabase(input);
        case "AtLeastOnceQueue":
          return await this.#applyQueue(input);
        case "ObjectBucket":
          return await this.#applyBucket(input);
        case "WorkerVersion":
          return await this.#applyWorkerVersion(input);
        case "WorkerDeployment":
          return await this.#applyWorkerDeployment(input);
        case "WorkerEndpoint":
          return await this.#applyWorkerEndpoint(input);
        case "WorkerCustomDomain":
          return await this.#applyWorkerCustomDomain(input);
        case "WorkerCronTrigger":
          return await this.#applyWorkerCronTrigger(input);
        case "QueueConsumer":
          return await this.#applyQueueConsumer(input);
      }
    }
    switch (input.offering.kind) {
      case "object_bucket":
        return await this.#applyBucket(input);
      case "sql_database":
        return await this.#applyDatabase(input);
      case "worker_script":
        return await this.#applyWorker(input);
      default:
        return failed("invalid_spec", "this offering kind is not provisionable here");
    }
  }

  /**
   * Recovery is deliberately a separate capability from `apply`: Cloudflare
   * resource POST/PUT calls are not generally safe to replay after a lost
   * response. The Worker Version endpoint carries a deterministic operation
   * marker, so its recovery path only lists and reads matching versions.
   */
  async recoverApply(input: ApplyInput): Promise<ProviderTicket> {
    if (this.#workerBackend?.owns(input.offering)) {
      return await this.#workerBackend.recoverApply(input);
    }
    const deterministicWorkerVersion =
      input.offering.kind.startsWith("takoform.") &&
      isEdgeFormsApiVersion(input.offering.form.apiVersion) &&
      input.offering.form.kind === "WorkerVersion";
    if (!deterministicWorkerVersion) {
      return failed(
        "unavailable",
        "the provider mutation outcome is indeterminate; operator repair is required",
        true,
      );
    }
    return await this.#applyWorkerVersion({ ...input, operationMode: "recovery" });
  }

  /** Resume one exact Host-owned command; never inferred from read-only recovery. */
  async convergeApply(input: ApplyInput): Promise<ProviderTicket> {
    if (this.#workerBackend?.owns(input.offering)) {
      return await this.#workerBackend.convergeApply({ ...input, operationMode: "recovery" });
    }
    const deterministicWorkerVersion =
      input.offering.kind.startsWith("takoform.") &&
      isEdgeFormsApiVersion(input.offering.form.apiVersion) &&
      input.offering.form.kind === "WorkerVersion";
    if (!deterministicWorkerVersion) {
      return failed(
        "unavailable",
        "the provider mutation cannot be converged without an operation-keyed backend",
        true,
      );
    }
    return await this.#applyWorkerVersion({ ...input, operationMode: "recovery" });
  }

  /**
   * Capture only the exact Cloudflare address needed for a later readback.
   * This intentionally performs no API call: the Host records this descriptor
   * before removing its logical Resource row, and the provider validates it
   * again when it is used.
   */
  createNativeReadbackDescriptor(
    input: ProviderNativeReadbackInput,
  ): ProviderNativeReadbackDescriptor {
    if (this.#workerBackend?.owns(input.offering)) {
      return this.#workerBackend.createNativeReadbackDescriptor(input);
    }
    const native = parseNativeId(input.nativeId);
    if (!native || !cloudflareKindMatches(providerKind(input.offering), native.kind)) {
      throw new ProviderReadbackDescriptorError();
    }
    const data = cloudflareReadbackData(native, input.spec);
    if (!data) throw new ProviderReadbackDescriptorError();
    return {
      apiVersion: PROVIDER_READBACK_API_VERSION,
      provider: this.id,
      kind: providerKind(input.offering),
      nativeId: input.nativeId,
      data,
    };
  }

  /**
   * Read Cloudflare's exact native identity and return a closed tri-state
   * result.  This path is intentionally independent of `recoverDelete`: it
   * never issues DELETE/PUT/POST, retries, or mutates any local/provider state.
   */
  async verifyNativeAbsence(input: {
    offering: ProviderOffering;
    descriptor: ProviderNativeReadbackDescriptor;
  }): Promise<ProviderNativeAbsence> {
    if (this.#workerBackend?.owns(input.offering)) {
      return await this.#workerBackend.verifyNativeAbsence(input);
    }
    const native = validateCloudflareReadbackDescriptor(this.id, input.offering, input.descriptor);
    if (!native) return unknownAbsence("malformed", false);
    const path = cloudflareReadbackPath(this.#accountId, native);
    if (!path) return unknownAbsence("unsupported", false);
    const read = await this.#call("GET", path);
    if (!read.ok) {
      if (read.status === 404) return absenceResult("absent", input.descriptor);
      if (read.status === 0 || read.status >= 500 || read.status === 429) {
        return unknownAbsence("transport", true);
      }
      if (read.status === 401 || read.status === 403) {
        return unknownAbsence("authority_unavailable", false);
      }
      // A successful HTTP status with no valid provider envelope is a
      // malformed readback, not proof that the native object is absent.
      if (read.status >= 200 && read.status < 300) {
        return unknownAbsence("malformed", false);
      }
      return unknownAbsence("authority_unavailable", false);
    }
    const state = cloudflareReadbackState(
      native,
      read.result,
      typeof input.descriptor.data.cron === "string" ? input.descriptor.data.cron : undefined,
    );
    if (state === "malformed") return unknownAbsence("malformed", false);
    if (state === "absent") return absenceResult("absent", input.descriptor);
    return absenceResult("present", input.descriptor);
  }

  async observe(input: {
    offering: ProviderOffering;
    nativeId: string;
    identity?: import("../provider-port.ts").ResourceIdentity;
    spec: JsonObject;
    relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket> {
    if (this.#workerBackend?.owns(input.offering)) {
      if (!input.identity) {
        return failed("invalid_spec", "the managed resource identity is missing");
      }
      return await this.#workerBackend.observe({
        offering: input.offering,
        nativeId: input.nativeId,
        identity: input.identity,
        spec: input.spec,
        ...(input.relations === undefined ? {} : { relations: input.relations }),
      });
    }
    const native = parseNativeId(input.nativeId);
    if (!native) return failed("not_found", "unrecognised native identity");
    if (native.kind === "worker" && input.offering.form.kind === "ModuleWorker") {
      return succeeded({
        nativeId: input.nativeId,
        observed: { scriptName: native.name, allocated: true },
        outputs: { scriptName: native.name },
      });
    }
    if (native.kind === "version") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/versions/${encodeURIComponent(native.name)}`,
      );
      if (!read.ok) return read.ticket;
      return succeeded({
        nativeId: input.nativeId,
        observed: {
          scriptName: native.parent,
          versionId: native.name,
          ...(record(read.result) ?? {}),
        },
        outputs: { scriptName: native.parent, versionId: native.name },
      });
    }
    if (native.kind === "deployment") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/deployments/${encodeURIComponent(native.name)}`,
      );
      if (!read.ok) return read.ticket;
      return succeeded({
        nativeId: input.nativeId,
        observed: {
          scriptName: native.parent,
          deploymentId: native.name,
          ...(record(read.result) ?? {}),
        },
        outputs: {},
      });
    }
    if (native.kind === "endpoint") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}/subdomain`,
      );
      if (!read.ok) return read.ticket;
      if (record(read.result)?.enabled !== true || !this.#workerEndpointSuffix) {
        return failed("not_found", "the Worker endpoint is not active");
      }
      const hostname = `${native.name}.${this.#workerEndpointSuffix}`.toLowerCase();
      return succeeded({
        nativeId: input.nativeId,
        observed: { enabled: true, scriptName: native.name },
        outputs: { hostname, url: `https://${hostname}/` },
      });
    }
    if (native.kind === "domain") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/domains/${encodeURIComponent(native.name)}`,
      );
      if (!read.ok) return read.ticket;
      const domain = record(read.result);
      return succeeded({
        nativeId: input.nativeId,
        observed: {
          domainId: native.name,
          ...(optionalString(domain?.hostname) ? { hostname: domain?.hostname as string } : {}),
          ...(optionalString(domain?.service) ? { scriptName: domain?.service as string } : {}),
        },
        outputs: {},
      });
    }
    if (native.kind === "cron") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/schedules`,
      );
      if (!read.ok) return read.ticket;
      const cron = optionalString(input.spec?.cron);
      if (!cron || !scheduleValues(read.result).includes(cron)) {
        return failed("not_found", "the Worker schedule does not exist");
      }
      return succeeded({
        nativeId: input.nativeId,
        observed: { cron, scriptName: native.parent },
        outputs: {},
      });
    }
    if (native.kind === "consumer") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/queues/${encodeURIComponent(native.parent)}/consumers/${encodeURIComponent(native.name)}`,
      );
      if (!read.ok) return read.ticket;
      const consumer = record(read.result);
      return succeeded({
        nativeId: input.nativeId,
        observed: {
          queueId: native.parent,
          consumerId: native.name,
          ...(optionalString(consumer?.script_name)
            ? { scriptName: consumer?.script_name as string }
            : {}),
        },
        outputs: {},
      });
    }
    const path =
      native.kind === "r2"
        ? `/accounts/${this.#accountId}/r2/buckets/${encodeURIComponent(native.name)}`
        : native.kind === "d1"
          ? `/accounts/${this.#accountId}/d1/database/${encodeURIComponent(native.name)}`
          : native.kind === "kv"
            ? `/accounts/${this.#accountId}/storage/kv/namespaces/${encodeURIComponent(native.name)}`
            : native.kind === "queue"
              ? `/accounts/${this.#accountId}/queues/${encodeURIComponent(native.name)}`
              : `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}`;
    const read = await this.#call("GET", path);
    if (!read.ok) return read.ticket;
    return succeeded({
      nativeId: input.nativeId,
      observed: {
        name: native.name,
        present: true,
        ...(record(read.result) ?? {}),
      },
      outputs: outputsFor(native, record(read.result)),
    });
  }

  async delete(input: {
    operationId: string;
    operationMode?: "initial" | "recovery";
    providerHandle?: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: import("../provider-port.ts").ResourceIdentity;
    spec?: JsonObject;
    relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket> {
    if (this.#workerBackend?.owns(input.offering)) {
      return await this.#workerBackend.delete(input);
    }
    if (input.operationMode === "recovery" && !input.providerHandle) {
      // Cloudflare exposes no opaque delete handle. A transport close after a
      // DELETE therefore cannot be safely replayed; leave recovery to an
      // operator/readback path rather than sending the mutation twice.
      return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
    }
    if (input.providerHandle) {
      return failed("unavailable", "Cloudflare delete recovery cannot poll this handle", true);
    }
    const native = parseNativeId(input.nativeId);
    if (!native) return failed("not_found", "unrecognised native identity");
    if (native.kind === "version") {
      // The stable Workers Scripts Versions API has no delete method. Preserve
      // the immutable provider revision and record that truth in Deployment
      // state; deleting the ModuleWorker later removes the script and all of
      // its versions.
      return succeeded({
        nativeId: input.nativeId,
        disposition: "retained",
        observed: {
          scriptName: native.parent,
          versionId: native.name,
          retained: true,
        },
        outputs: { scriptName: native.parent, versionId: native.name },
      });
    }
    if (native.kind === "cron") {
      const path = `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/schedules`;
      const read = await this.#call("GET", path);
      if (!read.ok && read.status !== 404) return read.ticket;
      if (read.ok) {
        const cron = optionalString(input.spec?.cron);
        if (!cron) return failed("invalid_spec", "the Worker schedule is incomplete");
        const schedules = scheduleValues(read.result)
          .filter((value) => value !== cron)
          .map((value) => ({ cron: value }));
        const updated = await this.#call("PUT", path, schedules);
        if (!updated.ok) return updated.ticket;
      }
      return succeeded({
        nativeId: input.nativeId,
        observed: { deleted: true },
        outputs: {},
      });
    }
    const path =
      native.kind === "deployment"
        ? `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/deployments/${encodeURIComponent(native.name)}`
        : native.kind === "endpoint"
          ? `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}/subdomain`
          : native.kind === "domain"
            ? `/accounts/${this.#accountId}/workers/domains/${encodeURIComponent(native.name)}`
            : native.kind === "consumer"
              ? `/accounts/${this.#accountId}/queues/${encodeURIComponent(native.parent)}/consumers/${encodeURIComponent(native.name)}`
              : native.kind === "r2"
                ? `/accounts/${this.#accountId}/r2/buckets/${encodeURIComponent(native.name)}`
                : native.kind === "d1"
                  ? `/accounts/${this.#accountId}/d1/database/${encodeURIComponent(native.name)}`
                  : native.kind === "kv"
                    ? `/accounts/${this.#accountId}/storage/kv/namespaces/${encodeURIComponent(native.name)}`
                    : native.kind === "queue"
                      ? `/accounts/${this.#accountId}/queues/${encodeURIComponent(native.name)}`
                      : `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}`;
    const removed = await this.#call("DELETE", path);
    // A resource that is already gone is a successful delete, not a failure.
    if (!removed.ok && removed.status !== 404) return removed.ticket;
    return succeeded({
      nativeId: input.nativeId,
      observed: { deleted: true },
      outputs: {},
    });
  }

  /** Read-only delete recovery for resources with an authoritative GET path. */
  async recoverDelete(input: {
    operationId: string;
    operationMode?: "initial" | "recovery";
    providerHandle?: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: import("../provider-port.ts").ResourceIdentity;
    spec?: JsonObject;
    relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket> {
    if (this.#workerBackend?.owns(input.offering)) {
      return await this.#workerBackend.recoverDelete(input);
    }
    if (input.providerHandle) {
      return failed("unavailable", "Cloudflare delete recovery cannot poll this handle", true);
    }
    const observed = await this.observe({
      offering: input.offering,
      nativeId: input.nativeId,
      identity: input.identity,
      spec: input.spec ?? {},
      ...(input.relations === undefined ? {} : { relations: input.relations }),
    });
    if (observed.phase === "failed" && observed.failure.code === "not_found") {
      return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
    }
    if (observed.phase === "succeeded") {
      return failed(
        "unavailable",
        "the delete outcome is not proven; operator repair is required",
        true,
      );
    }
    return observed;
  }

  async adopt(input: {
    operationId: string;
    operationMode?: "initial" | "recovery";
    providerHandle?: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
    spec: JsonObject;
    relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket> {
    if (input.operationMode === "recovery" && !input.providerHandle) {
      return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
    }
    if (input.providerHandle) {
      return failed("unavailable", "Cloudflare adopt recovery cannot poll this handle", true);
    }
    return await this.observe(input);
  }

  /** Read-only adoption recovery through the provider's observe path. */
  async recoverAdopt(input: {
    operationId: string;
    operationMode?: "initial" | "recovery";
    providerHandle?: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
    spec: JsonObject;
    relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket> {
    if (input.providerHandle) {
      return failed("unavailable", "Cloudflare adoption recovery cannot poll this handle", true);
    }
    return await this.observe(input);
  }

  // --- object storage -------------------------------------------------------

  // --- edge identity --------------------------------------------------------

  async #applyModuleWorker(input: ApplyInput): Promise<ProviderTicket> {
    const name = input.previous
      ? (parseNativeId(input.previous.nativeId)?.name ?? "")
      : await derivedProviderResourceName("tsw", input.identity);
    if (!name) return failed("invalid_spec", "the previous native identity is unusable");
    if (!input.previous) {
      const form = new FormData();
      form.set(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              main_module: BOOTSTRAP_MODULE,
              compatibility_date: this.#workerCompatibilityDate,
            }),
          ],
          { type: "application/json" },
        ),
      );
      form.set(
        BOOTSTRAP_MODULE,
        new Blob([BOOTSTRAP_SOURCE], { type: "application/javascript+module" }),
        BOOTSTRAP_MODULE,
      );
      const created = await this.#callForm(
        "PUT",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(name)}`,
        form,
      );
      if (!created.ok) return created.ticket;
    }
    return succeeded({
      nativeId: `worker:${name}`,
      observed: { scriptName: name, allocated: true },
      outputs: { scriptName: name },
    });
  }

  async #applyKvNamespace(input: ApplyInput): Promise<ProviderTicket> {
    if (input.previous) {
      return await this.observe({
        ...input,
        nativeId: input.previous.nativeId,
      });
    }
    const title = await derivedProviderResourceName("tskv", input.identity);
    const created = await this.#call("POST", `/accounts/${this.#accountId}/storage/kv/namespaces`, {
      title,
    });
    if (!created.ok) return created.ticket;
    const id = optionalString(record(created.result)?.id);
    if (!id) return failed("provider_error", "the namespace was created without an identifier");
    return succeeded({
      nativeId: `kv:${id}`,
      observed: { title, id },
      outputs: { namespaceId: id },
    });
  }

  async #applyQueue(input: ApplyInput): Promise<ProviderTicket> {
    if (input.previous) {
      return await this.observe({
        ...input,
        nativeId: input.previous.nativeId,
      });
    }
    const queueName = await derivedProviderResourceName("tsq", input.identity);
    const created = await this.#call("POST", `/accounts/${this.#accountId}/queues`, {
      queue_name: queueName,
      settings: {
        delivery_delay: integer(input.spec.deliveryDelaySeconds) ?? 0,
        message_retention_period: integer(input.spec.messageRetentionSeconds),
      },
    });
    if (!created.ok) return created.ticket;
    const result = record(created.result);
    const id = optionalString(result?.queue_id);
    if (!id) return failed("provider_error", "the queue was created without an identifier");
    return succeeded({
      nativeId: `queue:${id}`,
      observed: { queueId: id, queueName },
      outputs: { queueId: id, queueName },
    });
  }

  async #applyWorkerVersion(input: ApplyInput): Promise<ProviderTicket> {
    if (input.previous) return failed("invalid_spec", "Worker Versions are immutable");
    const operationMarker = await workerVersionOperationMarker(input.operationId);
    if (!operationMarker) {
      return failed("invalid_spec", "the Worker Version operation identity is invalid");
    }
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const workerResource = relationResource(input.relations, "/worker", "ModuleWorker");
    const bundle = relationResource(input.relations, "/bundle", "WorkerBundle");
    const manifestDigest = optionalString(bundle?.spec.manifestDigest);
    if (!worker || !workerResource || !bundle || !manifestDigest)
      return failed("invalid_spec", "the Worker Version is incomplete");
    const scriptName = worker.name;
    const workerResourceName = workerResource.metadata.name;
    const bundleResourceName = bundle.metadata.name;
    const manifest = await this.#artifacts.manifest(input.identity.tenantRef, manifestDigest);
    if (!manifest) {
      return failed("invalid_spec", "the Worker Bundle is not available");
    }
    if (manifest.kind !== "WorkerBundle" || !manifest.mainModule) {
      return failed("invalid_spec", "the Worker Bundle is not available");
    }
    const modules = manifest.modules ?? [];
    if (modules.length === 0) return failed("invalid_spec", "the Worker Bundle has no modules");

    const bindings = edgeBindings(input.spec, input.relations, input.runtimeBindings);
    if (!bindings) return failed("invalid_spec", "a Worker binding has no provider deployment");
    const requiredSensitive = sensitiveBindingNames(input.spec.requiredSensitiveVars);
    if (!requiredSensitive) {
      return failed("invalid_spec", "the sensitive Worker binding declaration is invalid");
    }
    if (
      requiredSensitive.length > 0 &&
      (!this.#runtimeInputs || !input.identity.uid || !input.operationKey)
    ) {
      return failed("denied", "required sensitive Worker runtime inputs are unavailable");
    }
    // A claim also needs the exact executing apply. Without it the authority
    // cannot recompute the commitment the preparation named, so an initial
    // mutation is refused rather than spending a handoff unfenced; recovery,
    // which never claims, is unaffected.
    if (requiredSensitive.length > 0 && input.operationMode === "initial" && !input.publicApply) {
      return failed("denied", "required sensitive Worker runtime inputs are unavailable");
    }
    if (
      bindings.some(
        (binding) =>
          binding.name === WORKER_VERSION_OPERATION_MARKER_BINDING ||
          binding.name === WORKER_VERSION_RUNTIME_INPUT_COMMITMENT_BINDING,
      )
    ) {
      return failed("invalid_spec", "an internal Worker Version binding is reserved");
    }
    const occupiedNames = new Set(
      bindings.map((binding) => optionalString(binding.name)).filter(isString),
    );
    if (requiredSensitive.some((name) => occupiedNames.has(name))) {
      return failed("invalid_spec", "a sensitive Worker binding collides with another binding");
    }
    const assetsSpec = record(input.spec.assets);
    let assetsDigest: string | undefined;
    if (assetsSpec) {
      const assetsResource = relationResource(
        input.relations,
        "/assets/bundle",
        "StaticAssetBundle",
      );
      assetsDigest = optionalString(assetsResource?.spec.manifestDigest);
      if (!assetsDigest) return failed("invalid_spec", "the Static Asset Bundle is unavailable");
    }

    if (input.operationMode !== "initial") {
      let runtimeInputRecovery:
        | Awaited<ReturnType<ProviderRuntimeInputLeasePort["recover"]>>
        | undefined;
      if (requiredSensitive.length > 0) {
        try {
          runtimeInputRecovery = await (
            this.#runtimeInputs as ProviderRuntimeInputLeasePort
          ).recover({
            organizationId: input.identity.tenantRef,
            operationId: input.operationId,
            resourceUid: input.identity.uid as string,
            reference: input.operationKey as string,
            target: {
              space: input.identity.space,
              workerName: workerResourceName,
              workerResourceUid: workerResource.metadata.uid,
              bundleName: bundleResourceName,
            },
            bindingNames: requiredSensitive,
          });
        } catch (error) {
          return runtimeInputFailure(error, "recover");
        }
        if (!sameStrings(runtimeInputRecovery.bindingNames, requiredSensitive)) {
          return failed("denied", "required sensitive Worker runtime inputs are unavailable");
        }
      }
      const recovered = await this.#recoverWorkerVersion(
        scriptName,
        operationMarker,
        requiredSensitive,
        runtimeInputRecovery?.preparation.commitment,
      );
      if (!recovered.ok) return { phase: "failed", failure: recovered.failure };
      if (runtimeInputRecovery) {
        const receiptDigest = await workerVersionReceiptDigest(
          this.#accountId,
          operationMarker,
          scriptName,
          recovered.value,
          requiredSensitive,
          runtimeInputRecovery.preparation.commitment,
        );
        try {
          await runtimeInputRecovery.settle(receiptDigest);
        } catch (error) {
          return runtimeInputFailure(error, "settle");
        }
      }
      return succeeded({
        nativeId: `version:${scriptName}:${recovered.value}`,
        observed: { scriptName, versionId: recovered.value },
        outputs: { scriptName, versionId: recovered.value },
      });
    }

    const modulePayloads: Array<{
      readonly module: (typeof modules)[number];
      readonly bytes: Uint8Array;
    }> = [];
    for (const module of modules) {
      const bytes = await this.#artifacts.blob(module.digest);
      if (!bytes) return failed("invalid_spec", `a declared module is missing: ${module.name}`);
      modulePayloads.push({ module, bytes });
    }
    let runtimeInputLease: ProviderRuntimeInputLease | undefined;
    const abortRuntimeInputLease = async (): Promise<ProviderTicket | null> => {
      if (!runtimeInputLease) return null;
      try {
        await runtimeInputLease.abort();
        return null;
      } catch (error) {
        return runtimeInputFailure(error, "abort");
      }
    };
    if (requiredSensitive.length > 0) {
      try {
        runtimeInputLease = await (this.#runtimeInputs as ProviderRuntimeInputLeasePort).acquire({
          organizationId: input.identity.tenantRef,
          operationId: input.operationId,
          resourceUid: input.identity.uid as string,
          reference: input.operationKey as string,
          target: {
            space: input.identity.space,
            workerName: workerResourceName,
            workerResourceUid: workerResource.metadata.uid,
            bundleName: bundleResourceName,
          },
          bindingNames: requiredSensitive,
          publicApply: input.publicApply as ProviderRuntimeInputPublicApply,
        });
      } catch (error) {
        return runtimeInputFailure(error, "acquire");
      }
      if (!exactRuntimeInputBindings(runtimeInputLease.bindings, requiredSensitive)) {
        const abortFailure = await abortRuntimeInputLease();
        if (abortFailure) return abortFailure;
        return failed("denied", "required sensitive Worker runtime inputs are unavailable");
      }
    }
    let assetToken: string | null = null;
    if (assetsDigest) {
      const uploaded = await this.#uploadAssets(scriptName, input.identity.tenantRef, {
        bundle: assetsDigest,
      });
      if (typeof uploaded !== "string") {
        const abortFailure = await abortRuntimeInputLease();
        return abortFailure ?? uploaded;
      }
      assetToken = uploaded;
    }
    let form: FormData;
    try {
      const sensitiveBindings = runtimeInputLease
        ? requiredSensitive.map((name) => ({
            type: "secret_text",
            name,
            text: runtimeInputLease?.bindings[name] as string,
          }))
        : [];
      form = new FormData();
      form.set(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              main_module: manifest.mainModule,
              compatibility_date: this.#workerCompatibilityDate,
              bindings: [
                ...bindings,
                ...sensitiveBindings,
                ...(runtimeInputLease
                  ? [
                      {
                        type: "plain_text",
                        name: WORKER_VERSION_RUNTIME_INPUT_COMMITMENT_BINDING,
                        text: runtimeInputLease.preparation.commitment,
                      },
                    ]
                  : []),
                {
                  type: "plain_text",
                  name: WORKER_VERSION_OPERATION_MARKER_BINDING,
                  text: operationMarker,
                },
                ...(assetToken ? [{ type: "assets", name: ASSETS_BINDING }] : []),
              ],
              ...(assetToken
                ? {
                    assets: {
                      jwt: assetToken,
                      config: {
                        html_handling: "auto-trailing-slash",
                        not_found_handling:
                          assetsSpec?.notFoundHandling === "single_page_application"
                            ? "single-page-application"
                            : "none",
                        run_worker_first: assetsSpec?.runWorkerFirst === true,
                      },
                    },
                  }
                : {}),
            }),
          ],
          { type: "application/json" },
        ),
        "metadata.json",
      );
      for (const { module, bytes } of modulePayloads) {
        form.set(
          module.name,
          new Blob([bytes.buffer as ArrayBuffer], { type: module.mediaType }),
          module.name,
        );
      }
    } catch {
      const abortFailure = await abortRuntimeInputLease();
      if (abortFailure) return abortFailure;
      return failed("provider_error", "the Worker Version upload could not be constructed");
    }
    let dispatchedLease: ProviderRuntimeInputDispatchedLease | undefined;
    if (runtimeInputLease) {
      try {
        dispatchedLease = await runtimeInputLease.dispatch();
      } catch (error) {
        return runtimeInputFailure(error, "dispatch");
      }
    }
    const uploaded = await this.#callForm(
      "POST",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions`,
      form,
      { sensitive: requiredSensitive.length > 0 },
    );
    if (!uploaded.ok) {
      if (uploaded.indeterminate === true) {
        return failed("unavailable", "the Worker Version upload outcome is indeterminate", true);
      }
      return uploaded.ticket;
    }
    const versionId = workerVersionId(record(uploaded.result)?.id);
    if (!versionId) {
      return failed("unavailable", "the Worker Version upload outcome is indeterminate", true);
    }
    if (dispatchedLease) {
      const receiptDigest = await workerVersionReceiptDigest(
        this.#accountId,
        operationMarker,
        scriptName,
        versionId,
        requiredSensitive,
        runtimeInputLease?.preparation.commitment,
      );
      try {
        await dispatchedLease.settle(receiptDigest);
      } catch (error) {
        return runtimeInputFailure(error, "settle");
      }
    }
    return succeeded({
      nativeId: `version:${scriptName}:${versionId}`,
      observed: { scriptName, versionId },
      outputs: { scriptName, versionId },
    });
  }

  async #recoverWorkerVersion(
    scriptName: string,
    operationMarker: string,
    expectedSecretTextNames: readonly string[],
    expectedRuntimeInputCommitment?: `sha256:${string}`,
  ): Promise<ProviderValue<string>> {
    const versionPath = `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions`;
    const seen = new Set<string>();
    let recovered: string | null = null;
    for (let page = 1; page <= WORKER_VERSION_RECOVERY_PAGE_LIMIT; page += 1) {
      const listed = await this.#call(
        "GET",
        `${versionPath}?page=${page}&per_page=${WORKER_VERSION_RECOVERY_PAGE_SIZE}`,
      );
      if (!listed.ok) return callFailure(listed);
      const resultInfoValue = listed.resultInfo;
      const resultInfo = resultInfoValue === undefined ? undefined : record(resultInfoValue);
      const reportedPage = resultInfo ? integer(resultInfo.page) : undefined;
      const reportedPageSize = resultInfo ? integer(resultInfo.per_page) : undefined;
      if (
        (resultInfoValue !== undefined && !resultInfo) ||
        (resultInfo?.page !== undefined && reportedPage !== page) ||
        (resultInfo?.per_page !== undefined &&
          (reportedPageSize === undefined ||
            reportedPageSize < 1 ||
            reportedPageSize > WORKER_VERSION_RECOVERY_PAGE_SIZE))
      ) {
        return providerValueFailure(
          "provider_error",
          "the Worker Version recovery pagination is mismatched",
        );
      }
      const items = record(listed.result)?.items;
      if (
        !Array.isArray(items) ||
        items.length > (reportedPageSize ?? WORKER_VERSION_RECOVERY_PAGE_SIZE)
      ) {
        return providerValueFailure(
          "provider_error",
          "the Worker Version recovery listing is malformed",
        );
      }
      if (items.length === 0) {
        return recovered
          ? { ok: true, value: recovered }
          : providerValueFailure(
              "unavailable",
              "the Worker Version upload outcome is indeterminate",
              true,
            );
      }
      for (const item of items) {
        const versionId = workerVersionId(record(item)?.id);
        if (!versionId || seen.has(versionId)) {
          return providerValueFailure(
            "provider_error",
            "the Worker Version recovery listing is ambiguous",
          );
        }
        seen.add(versionId);
        const read = await this.#call("GET", `${versionPath}/${encodeURIComponent(versionId)}`);
        if (!read.ok) return callFailure(read);
        const detail = record(read.result);
        if (workerVersionId(detail?.id) !== versionId) {
          return providerValueFailure(
            "provider_error",
            "the Worker Version recovery detail is mismatched",
          );
        }
        const resources = record(detail?.resources);
        const bindingsValue = resources?.bindings;
        if (!resources || (bindingsValue !== undefined && !Array.isArray(bindingsValue))) {
          return providerValueFailure(
            "provider_error",
            "the Worker Version recovery resources are malformed",
          );
        }
        const markerBindings = (bindingsValue ?? []).filter(
          (binding) => record(binding)?.name === WORKER_VERSION_OPERATION_MARKER_BINDING,
        );
        if (markerBindings.length > 1) {
          return providerValueFailure(
            "provider_error",
            "the Worker Version recovery marker is ambiguous",
          );
        }
        if (markerBindings.length === 0) continue;
        const markerBinding = record(markerBindings[0]);
        const marker = markerBinding?.text;
        if (
          markerBinding?.type !== "plain_text" ||
          typeof marker !== "string" ||
          !workerVersionOperationMarkerValue(marker)
        ) {
          return providerValueFailure(
            "provider_error",
            "the Worker Version recovery marker is malformed",
          );
        }
        if (marker !== operationMarker) continue;
        const runtimeCommitmentBindings = (bindingsValue ?? []).filter(
          (binding) => record(binding)?.name === WORKER_VERSION_RUNTIME_INPUT_COMMITMENT_BINDING,
        );
        if (
          expectedRuntimeInputCommitment === undefined
            ? runtimeCommitmentBindings.length !== 0
            : runtimeCommitmentBindings.length !== 1 ||
              record(runtimeCommitmentBindings[0])?.type !== "plain_text" ||
              record(runtimeCommitmentBindings[0])?.text !== expectedRuntimeInputCommitment
        ) {
          return providerValueFailure(
            "provider_error",
            "the Worker Version recovery runtime-input commitment is mismatched",
          );
        }
        const recoveredSecretNames = (bindingsValue ?? [])
          .filter((binding) => record(binding)?.type === "secret_text")
          .map((binding) => optionalString(record(binding)?.name))
          .filter(isString)
          .sort();
        if (!sameStrings(recoveredSecretNames, expectedSecretTextNames)) {
          return providerValueFailure(
            "provider_error",
            "the Worker Version recovery sensitive binding closure is mismatched",
          );
        }
        if (recovered) {
          return providerValueFailure(
            "provider_error",
            "the Worker Version recovery marker is ambiguous",
          );
        }
        recovered = versionId;
      }
    }
    return recovered
      ? { ok: true, value: recovered }
      : providerValueFailure(
          "unavailable",
          "the Worker Version upload outcome is indeterminate",
          true,
        );
  }

  async #applyWorkerDeployment(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const versions = Array.isArray(input.spec.versions) ? input.spec.versions : [];
    if (!worker || versions.length === 0) {
      return failed("invalid_spec", "the Worker Deployment is incomplete");
    }
    const weighted: { version_id: string; percentage: number }[] = [];
    for (let index = 0; index < versions.length; index += 1) {
      const relation = relationDeployment(
        input.relations,
        `/versions/${index}/workerVersion`,
        "version",
      );
      const declared = record(versions[index]);
      const weight = integer(declared?.weight);
      if (!relation || relation.parent !== worker.name || weight === undefined) {
        return failed("invalid_spec", "a deployed version does not belong to this Worker");
      }
      weighted.push({ version_id: relation.name, percentage: weight / 100 });
    }
    const deployed = await this.#call(
      "POST",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(worker.name)}/deployments`,
      { strategy: "percentage", versions: weighted },
    );
    if (!deployed.ok) return deployed.ticket;
    const id = optionalString(record(deployed.result)?.id);
    if (!id) return failed("provider_error", "the Worker Deployment has no identifier");
    return succeeded({
      nativeId: `deployment:${worker.name}:${id}`,
      observed: {
        scriptName: worker.name,
        deploymentId: id,
        versions: weighted,
      },
      outputs: {},
    });
  }

  async #applyWorkerEndpoint(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    if (!worker || !this.#workerEndpointSuffix) {
      return failed("invalid_spec", "this provider installation offers no Worker endpoint suffix");
    }
    const enabled = await this.#call(
      "POST",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(worker.name)}/subdomain`,
      { enabled: true, previews_enabled: false },
    );
    if (!enabled.ok) return enabled.ticket;
    const hostname = `${worker.name}.${this.#workerEndpointSuffix}`.toLowerCase();
    return succeeded({
      nativeId: `endpoint:${worker.name}`,
      observed: { enabled: true },
      outputs: { hostname, url: `https://${hostname}/` },
    });
  }

  async #applyWorkerCustomDomain(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const hostname = optionalString(input.spec.hostname)?.toLowerCase().replace(/\.$/u, "");
    if (!worker || !hostname) return failed("invalid_spec", "the custom domain is incomplete");
    const zone = this.#zoneFor(hostname, input.identity.tenantRef);
    if (!zone) return failed("invalid_spec", "no configured zone serves this hostname");
    const attached = await this.#attach(zone, hostname, worker.name);
    if (!attached.ok) return attached.ticket;
    const domainId = optionalString(record(attached.result)?.id);
    if (!domainId) return failed("provider_error", "the Worker domain has no identifier");
    return succeeded({
      nativeId: `domain:${domainId}`,
      observed: { domainId, hostname, scriptName: worker.name },
      outputs: {},
    });
  }

  async #applyWorkerCronTrigger(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const cron = optionalString(input.spec.cron);
    if (!worker || !cron) return failed("invalid_spec", "the cron trigger is incomplete");
    const read = await this.#call(
      "GET",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(worker.name)}/schedules`,
    );
    if (!read.ok) return read.ticket;
    const existing = scheduleValues(read.result);
    const schedules = [...new Set([...existing, cron])].sort().map((value) => ({ cron: value }));
    const updated = await this.#call(
      "PUT",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(worker.name)}/schedules`,
      schedules,
    );
    if (!updated.ok) return updated.ticket;
    return succeeded({
      nativeId: `cron:${worker.name}:${await shortDigest(cron)}`,
      observed: { cron, scriptName: worker.name },
      outputs: {},
    });
  }

  async #applyQueueConsumer(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const queue = relationDeployment(input.relations, "/queue", "queue");
    const deadLetter = relationDeployment(input.relations, "/deadLetterQueue", "queue", true);
    if (!worker || !queue) return failed("invalid_spec", "the Queue Consumer is incomplete");
    const body = {
      type: "worker",
      script_name: worker.name,
      settings: {
        batch_size: integer(input.spec.maxBatchSize),
        max_wait_time_ms: (integer(input.spec.maxBatchTimeoutSeconds) ?? 0) * 1_000,
        max_retries: integer(input.spec.maxRetries),
        retry_delay: integer(input.spec.retryDelaySeconds),
        max_concurrency: integer(input.spec.maxConcurrency),
      },
      ...(deadLetter
        ? {
            dead_letter_queue: relationOutputName(input.relations, "/deadLetterQueue", "queueName"),
          }
        : {}),
    };
    const created = await this.#call(
      "POST",
      `/accounts/${this.#accountId}/queues/${encodeURIComponent(queue.name)}/consumers`,
      body,
    );
    if (!created.ok) return created.ticket;
    const id = optionalString(record(created.result)?.consumer_id);
    if (!id) return failed("provider_error", "the Queue Consumer has no identifier");
    return succeeded({
      nativeId: `consumer:${queue.name}:${id}`,
      observed: {
        consumerId: id,
        queueId: queue.name,
        scriptName: worker.name,
      },
      outputs: {},
    });
  }

  async #applyBucket(input: ApplyInput): Promise<ProviderTicket> {
    const name = input.previous
      ? (parseNativeId(input.previous.nativeId)?.name ?? "")
      : await derivedProviderResourceName("ts", input.identity);
    if (!name) return failed("invalid_spec", "the previous native identity is unusable");
    if (input.previous) {
      // A bucket has nothing mutable in this Form; the update is a no-op that
      // still confirms the resource is there.
      return await this.observe({ ...input, nativeId: `r2:${name}` });
    }
    const location = optionalString(input.spec.location);
    const created = await this.#call("POST", `/accounts/${this.#accountId}/r2/buckets`, {
      name,
      ...(location ? { locationHint: location } : {}),
    });
    if (!created.ok) return created.ticket;
    return succeeded({
      nativeId: `r2:${name}`,
      observed: { name, ...(location ? { location } : {}) },
      outputs: { protocol: "s3", bucketName: name },
    });
  }

  // --- relational database --------------------------------------------------

  async #applyDatabase(input: ApplyInput): Promise<ProviderTicket> {
    if (input.previous) {
      return await this.observe({
        ...input,
        nativeId: input.previous.nativeId,
      });
    }
    const name = await derivedProviderResourceName("tsdb", input.identity);
    const created = await this.#call("POST", `/accounts/${this.#accountId}/d1/database`, {
      name,
      ...(input.region ? { primary_location_hint: input.region } : {}),
    });
    if (!created.ok) return created.ticket;
    const uuid = optionalString(record(created.result)?.uuid);
    if (!uuid) return failed("provider_error", "the database was created without an identifier");
    return succeeded({
      nativeId: `d1:${uuid}`,
      observed: { name, uuid },
      outputs: { databaseId: uuid, databaseName: name },
    });
  }

  // --- worker ---------------------------------------------------------------

  /**
   * Publishes a Worker from a committed bundle the tenant holds. The modules
   * are uploaded as a multipart script upload; bindings and routes come from
   * the declared spec, never from anything the bundle itself asks for.
   */
  async #applyWorker(input: ApplyInput): Promise<ProviderTicket> {
    const bundleDigest = optionalString(input.spec.bundle);
    if (!bundleDigest) return failed("invalid_spec", "a bundle digest is required");
    const manifest = await this.#artifacts.manifest(input.identity.tenantRef, bundleDigest);
    if (!manifest) {
      return failed("invalid_spec", "the declared bundle is not a committed WorkerBundle");
    }
    if (manifest.kind !== "WorkerBundle") {
      return failed("invalid_spec", "the declared bundle is not a committed WorkerBundle");
    }
    const mainModule = manifest.mainModule;
    const modules = manifest.modules ?? [];
    if (!mainModule || modules.length === 0) {
      return failed("invalid_spec", "the bundle declares no modules");
    }

    const name = input.previous
      ? (parseNativeId(input.previous.nativeId)?.name ?? "")
      : await derivedProviderResourceName("tsw", input.identity);
    if (!name) return failed("invalid_spec", "the previous native identity is unusable");

    // Durable Object classes must be created by a migration in the same upload
    // that binds them; Cloudflare treats the two as one operation, and a script
    // whose bindings name classes that do not exist is rejected outright.
    const durableObjects = durableObjectsOf(input.spec.durableObjects);
    const previouslyDeclared = previousDurableClasses(input.previous?.spec);
    const migration = migrationFor(durableObjects, previouslyDeclared);

    // Assets are uploaded before the script, because the script's metadata
    // must carry the completion token the asset upload returns.
    const assets = record(input.spec.assets);
    // A script that declares assets is given a binding to them. Without one the
    // asset layer only answers requests that match a file exactly: anything
    // else reaches the Worker, and `notFoundHandling` — the whole reason an
    // application with client-side routing survives a reload — never applies.
    // The Worker has to be able to ask, so it is always handed the means.
    if (
      assets &&
      bindingsOf(input.spec.bindings).some((binding) => binding.name === ASSETS_BINDING)
    ) {
      return failed(
        "invalid_spec",
        `a script that declares assets is given a binding named ${ASSETS_BINDING}; ` +
          "declare your own binding under a different name",
      );
    }
    let assetToken: string | null = null;
    if (assets) {
      const uploaded = await this.#uploadAssets(name, input.identity.tenantRef, assets);
      if (typeof uploaded !== "string") return uploaded;
      assetToken = uploaded;
    }

    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: mainModule,
            compatibility_date: optionalString(input.spec.compatibilityDate) ?? "2026-01-01",
            compatibility_flags: stringList(input.spec.compatibilityFlags),
            bindings: [
              ...bindingsOf(input.spec.bindings),
              ...durableObjects.map((entry) => ({
                type: "durable_object_namespace",
                name: entry.name,
                class_name: entry.className,
              })),
              ...(assetToken ? [{ type: "assets", name: ASSETS_BINDING }] : []),
            ],
            // A single-script upload carries one migration object, not a list
            // of them; the list form belongs to the multi-script API.
            // A script upload replaces the whole binding set, which would
            // silently delete every secret the operator had set. Secrets are
            // deliberately not declarable in a Form — a declaration is stored,
            // readable, and versioned, which is everything a secret must not
            // be — so they are operator-managed and preserved across applies.
            keep_bindings: ["secret_text"],
            ...(assetToken
              ? {
                  assets: {
                    jwt: assetToken,
                    config: {
                      html_handling: "auto-trailing-slash",
                      not_found_handling:
                        optionalString(assets?.notFoundHandling) ?? "single-page-application",
                    },
                  },
                }
              : {}),
            ...(migration ? { migrations: migration } : {}),
          }),
        ],
        { type: "application/json" },
      ),
      "metadata.json",
    );
    for (const module of modules) {
      const bytes = await this.#artifacts.blob(module.digest);
      if (!bytes) return failed("invalid_spec", `a declared module is missing: ${module.name}`);
      form.set(
        module.name,
        // The Workers and Bun lib types disagree about what a Blob part is.
        // Both accept the bytes; only the declarations differ.
        new Blob([bytes.buffer as ArrayBuffer], { type: module.mediaType }),
        module.name,
      );
    }

    const published = await this.#callForm(
      "PUT",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(name)}`,
      form,
    );
    if (!published.ok) return published.ticket;

    // Uploading a script does not put it on the internet. A declared hostname
    // is a request to serve it there, so the route and its DNS record are
    // attached here rather than leaving an output URL that answers nothing.
    const hostnames = stringList(input.spec.hostnames);
    for (const hostname of hostnames) {
      const zone = this.#zoneFor(hostname, input.identity.tenantRef);
      if (!zone) {
        return failed(
          "invalid_spec",
          `no configured zone serves ${hostname}; a domain must be one this deployment offers ` +
            "or one the operator has added for this tenant",
        );
      }
      const replaceable = new Set(stringList(input.spec.replaceExistingRecords));
      let attached = await this.#attach(zone, hostname, name);
      if (
        !attached.ok &&
        attached.codes.includes(DNS_RECORDS_PRESENT) &&
        replaceable.has(hostname)
      ) {
        // The declaration asked for this hostname by name, knowing it points
        // somewhere. Clearing the records is destructive and one-way, which is
        // exactly why it happens only when it was asked for.
        const cleared = await this.#clearRecords(zone, hostname);
        if (!cleared.ok) return cleared.ticket;
        attached = await this.#attach(zone, hostname, name);
      }
      if (!attached.ok) {
        // Cloudflare refuses to attach a Worker to a hostname that already has
        // DNS records, which is the ordinary state of a domain somebody brought
        // with them. Reported as "the resource is busy" it reads as a transient
        // fault worth retrying; it is neither, and only the customer can clear
        // it.
        if (attached.codes.includes(DNS_RECORDS_PRESENT)) {
          return failed(
            "invalid_spec",
            `${hostname} already has DNS records of its own; remove them in the zone and apply ` +
              "again, and this deployment will create the record it needs",
          );
        }
        return attached.ticket;
      }
    }

    return succeeded({
      nativeId: `worker:${name}`,
      observed: { name, mainModule, moduleCount: modules.length, hostnames },
      outputs: {
        scriptName: name,
        hostnames,
        ...(hostnames[0] ? { url: `https://${hostnames[0]}` } : {}),
      },
    });
  }

  /**
   * Uploads a committed asset bundle and returns the completion token the
   * script upload must carry.
   *
   * Cloudflare asks first which files it does not already hold, so an unchanged
   * asset never travels twice — the same content-addressed idea the artifact
   * store already uses, one layer down.
   */
  async #uploadAssets(
    scriptName: string,
    tenantRef: string,
    assets: Record<string, unknown>,
  ): Promise<string | ProviderTicket> {
    const digest = optionalString(assets.bundle);
    if (!digest) return failed("invalid_spec", "an asset bundle digest is required");
    const manifest = await this.#artifacts.manifest(tenantRef, digest);
    if (!manifest) {
      return failed("invalid_spec", "the declared assets are not a committed StaticAssetBundle");
    }
    if (manifest.kind !== "StaticAssetBundle") {
      return failed("invalid_spec", "the declared assets are not a committed StaticAssetBundle");
    }
    const files = manifest.files ?? [];
    if (files.length === 0) return failed("invalid_spec", "the asset bundle declares no files");

    const declared: Record<string, { hash: string; size: number }> = {};
    const byHash = new Map<string, { name: string; digest: string; mediaType: string }>();
    for (const file of files) {
      // Cloudflare identifies an asset by a 32-hex-character hash, not by the
      // full digest, so the digest is truncated consistently on both sides.
      const hash = file.digest.slice("sha256:".length, "sha256:".length + 32);
      declared[`/${file.path}`] = { hash, size: file.size };
      byHash.set(hash, {
        name: file.path,
        digest: file.digest,
        mediaType: file.mediaType,
      });
    }

    const started = await this.#call(
      "POST",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`,
      { manifest: declared },
    );
    if (!started.ok) return started.ticket;
    const session = record(started.result);
    const token = optionalString(session?.jwt);
    const buckets = Array.isArray(session?.buckets) ? (session.buckets as string[][]) : [];
    // No buckets means every file was already held; the token alone completes.
    if (buckets.length === 0) return token ?? failed("provider_error", "no asset upload token");

    let completion = token;
    for (const bucket of buckets) {
      const payload = new FormData();
      for (const hash of bucket) {
        const file = byHash.get(hash);
        const bytes = file ? await this.#artifacts.blob(file.digest) : null;
        if (!file || !bytes) return failed("invalid_spec", "a declared asset is missing");
        payload.set(
          hash,
          new File([base64(bytes)], hash, {
            type: file.mediaType || "application/octet-stream",
          }),
          hash,
        );
      }
      const sent = await this.#sendAssets(completion ?? "", payload);
      if (!sent.ok) return sent.ticket;
      const result = record(sent.result);
      completion = optionalString(result?.jwt) ?? completion;
    }
    return completion ?? failed("provider_error", "asset upload did not complete");
  }

  async #sendAssets(token: string, payload: FormData): Promise<CallResult> {
    let response: Response;
    try {
      response = await this.#fetch(
        new Request(
          `${this.#origin}/accounts/${this.#accountId}/workers/assets/upload?base64=true`,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
            },
            body: payload,
          },
        ),
      );
    } catch (error) {
      const transportError = sanitizedTransportError(error, `Bearer ${token}`);
      console.error(
        JSON.stringify({
          event: "takoserver.provider.fetch_failed",
          provider: this.id,
          method: "POST",
          path: "/workers/assets/upload",
          ...transportError,
        }).slice(0, 4_096),
      );
      return {
        ok: false,
        status: 0,
        ticket: failed("unavailable", "asset upload unreachable", true),
        codes: [],
      };
    }
    const envelope = await readEnvelope(response);
    if (response.ok && envelope?.success === true) {
      return { ok: true, status: response.status, result: envelope.result };
    }
    console.error(
      JSON.stringify({
        event: "takoserver.provider.refused",
        provider: this.id,
        method: "POST",
        path: "/workers/assets/upload",
        status: response.status,
        errors: Array.isArray(envelope?.errors) ? envelope.errors : undefined,
      }).slice(0, 4_096),
    );
    return {
      ok: false,
      status: response.status,
      ticket: classify(response.status),
      codes: errorCodes(envelope?.errors),
    };
  }

  /** Points a hostname at a script. */
  async #attach(zone: CloudflareZone, hostname: string, script: string): Promise<CallResult> {
    return await this.#call("PUT", `/accounts/${this.#accountId}/workers/domains`, {
      zone_id: zone.zoneId,
      hostname,
      service: script,
      environment: "production",
    });
  }

  /**
   * Removes the records standing where a hostname is about to be served.
   *
   * Only the records for that exact name: a zone holds other people's names
   * too, and a delete that reached one of those would take a service down that
   * nobody was talking about.
   */
  async #clearRecords(zone: CloudflareZone, hostname: string): Promise<CallResult> {
    const listed = await this.#call(
      "GET",
      `/zones/${zone.zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
    );
    if (!listed.ok) return listed;
    const records = Array.isArray(listed.result) ? listed.result : [];
    for (const record of records) {
      const id = (record as { id?: unknown })?.id;
      const type = (record as { type?: unknown })?.type;
      // Only the kinds that stand in the way. A TXT record proving domain
      // ownership somewhere else is not in the way, and deleting it would
      // break something invisible from here.
      if (typeof id !== "string" || (type !== "A" && type !== "AAAA" && type !== "CNAME")) {
        continue;
      }
      const removed = await this.#call("DELETE", `/zones/${zone.zoneId}/dns_records/${id}`);
      if (!removed.ok && removed.status !== 404) return removed;
    }
    return { ok: true, status: 200 };
  }

  /** The zone that may serve a hostname, if this deployment offers one. */
  #zoneFor(hostname: string, tenantRef: string): CloudflareZone | undefined {
    const eligible = this.#zones.filter(
      (zone) =>
        (zone.tenantRef === undefined || zone.tenantRef === tenantRef) &&
        (hostname === zone.suffix
          ? zone.apex === true
          : hostname.endsWith(`.${zone.suffix}`) && this.#labelAllowed(zone, hostname)),
    );
    // The most specific zone wins, so a tenant zone nested inside a platform
    // zone is not shadowed by it. Where two zones cover the same suffix — the
    // usual shape for an operator holding back names it needs from a zone it
    // also offers to customers — the one granted to a named tenant is the more
    // specific of the two. Deciding this by rule rather than by the order the
    // zones happen to be configured in is what keeps the grant from depending
    // on where somebody put a line in a list.
    return eligible.sort(
      (left, right) =>
        right.suffix.length - left.suffix.length ||
        Number(right.tenantRef !== undefined) - Number(left.tenantRef !== undefined),
    )[0];
  }

  #labelAllowed(zone: CloudflareZone, hostname: string): boolean {
    const prefix = hostname.slice(0, -(zone.suffix.length + 1));
    if (prefix.length === 0) return false;
    if (zone.singleLabel && prefix.includes(".")) return false;
    const label = prefix.split(".").at(-1) ?? "";
    return !(zone.reservedLabels ?? []).includes(label);
  }

  // --- transport ------------------------------------------------------------

  async #call(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<CallResult> {
    return await this.#send(
      method,
      path,
      body === undefined
        ? undefined
        : {
            body: JSON.stringify(body),
            type: "application/json; charset=UTF-8",
          },
    );
  }

  async #callForm(
    method: "POST" | "PUT",
    path: string,
    form: FormData,
    options: { readonly sensitive?: boolean } = {},
  ): Promise<CallResult> {
    return await this.#send(method, path, { body: form }, options);
  }

  async #d1Query(
    databaseId: string,
    body:
      | { readonly sql: string; readonly params?: readonly (string | number)[] }
      | {
          readonly batch: readonly {
            readonly sql: string;
            readonly params?: readonly (string | number)[];
          }[];
        },
  ): Promise<CallResult> {
    return await this.#call(
      "POST",
      `/accounts/${this.#accountId}/d1/database/${encodeURIComponent(databaseId)}/query`,
      body,
    );
  }

  async #send(
    method: string,
    path: string,
    payload?: { body: BodyInit; type?: string },
    options: { readonly sensitive?: boolean } = {},
  ): Promise<CallResult> {
    let authorization: string;
    try {
      authorization = await this.#authorize();
    } catch {
      return {
        ok: false,
        status: 0,
        ticket: failed("denied", "no usable credential"),
        codes: [],
      };
    }
    let response: Response;
    try {
      response = await this.#fetch(
        new Request(`${this.#origin}${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization,
            ...(payload?.type ? { "content-type": payload.type } : {}),
          },
          ...(payload ? { body: payload.body } : {}),
        }),
      );
    } catch (error) {
      const transportError = options.sensitive
        ? { errorName: error instanceof Error ? error.name : "UnknownError" }
        : sanitizedTransportError(error, authorization);
      console.error(
        JSON.stringify({
          event: "takoserver.provider.fetch_failed",
          provider: this.id,
          method,
          path,
          ...transportError,
        }).slice(0, 4_096),
      );
      return {
        ok: false,
        status: 0,
        ticket: failed("unavailable", "the backend is unreachable", true),
        codes: [],
        ...(method === "GET" ? {} : { indeterminate: true }),
      };
    }
    const envelope = await readEnvelope(response);
    if (response.ok && envelope?.success === true) {
      return {
        ok: true,
        status: response.status,
        result: envelope.result,
        resultInfo: envelope.result_info,
      };
    }
    // The backend's own words are written for an operator of that cloud, not
    // for our customer, so they never cross back in the ticket. They are
    // exactly what an operator of *this* platform needs, though, so they are
    // logged rather than discarded.
    console.error(
      JSON.stringify({
        event: "takoserver.provider.refused",
        provider: this.id,
        method,
        path,
        status: response.status,
        errors: options.sensitive || !Array.isArray(envelope?.errors) ? undefined : envelope.errors,
      }).slice(0, 4_096),
    );
    return {
      ok: false,
      status: response.status,
      ticket: classify(response.status),
      codes: errorCodes(envelope?.errors),
      ...(method !== "GET" && response.ok && envelope?.success !== false
        ? { indeterminate: true }
        : {}),
    };
  }
}

function sanitizedTransportError(
  error: unknown,
  authorization: string,
): { readonly errorName: string; readonly message: string } {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : "non-Error transport failure";
  const secrets = [authorization, authorization.replace(/^Bearer\s+/u, "")]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  let message = rawMessage;
  for (const secret of secrets) message = message.replaceAll(secret, "[REDACTED]");
  message = [...message.replace(/Bearer\s+[^\s]+/giu, "[REDACTED]")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .slice(0, 512);
  return { errorName, message };
}

type CallResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly result?: unknown;
      readonly resultInfo?: unknown;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly ticket: ProviderTicket;
      /**
       * The backend's own error codes. Its *words* are written for an operator
       * of that cloud and never cross back, but a few of its codes describe
       * something only our customer can fix, and those deserve a message in our
       * vocabulary rather than a generic refusal.
       */
      readonly codes: readonly number[];
      /** The request may have reached a mutating provider endpoint. */
      readonly indeterminate?: true;
    };

type CloudflareReadbackState = "absent" | "present" | "malformed";

function unknownAbsence(
  reason: ProviderNativeAbsenceUnknownReason,
  retryable: boolean,
): ProviderNativeAbsence {
  return { outcome: "unknown", reason, retryable };
}

function absenceResult(
  outcome: "absent" | "present",
  descriptor: ProviderNativeReadbackDescriptor,
): ProviderNativeAbsence {
  // `nativeId` is deliberately omitted. The descriptor itself remains
  // Host-private, while this evidence is safe to aggregate into a public
  // absence receipt.
  return {
    outcome,
    evidence: {
      provider: descriptor.provider,
      kind: descriptor.kind,
      state: outcome,
    },
  };
}

function providerKind(offering: ProviderOffering): string {
  return offering.kind.startsWith("takoform.") && isEdgeFormsApiVersion(offering.form.apiVersion)
    ? offering.form.kind
    : offering.kind;
}

function cloudflareKindMatches(kind: string, nativeKind: NativeId["kind"]): boolean {
  switch (nativeKind) {
    case "r2":
      return kind === "ObjectBucket" || kind === "object_bucket";
    case "d1":
      return kind === "SQLiteDatabase" || kind === "sql_database";
    case "kv":
      return kind === "EdgeKVNamespace";
    case "queue":
      return kind === "AtLeastOnceQueue";
    case "worker":
      return kind === "ModuleWorker" || kind === "worker_script";
    case "version":
      return kind === "WorkerVersion";
    case "deployment":
      return kind === "WorkerDeployment";
    case "endpoint":
      return kind === "WorkerEndpoint";
    case "domain":
      return kind === "WorkerCustomDomain";
    case "cron":
      return kind === "WorkerCronTrigger";
    case "consumer":
      return kind === "QueueConsumer";
  }
}

function cloudflareReadbackData(native: NativeId, spec?: JsonObject): JsonObject | null {
  switch (native.kind) {
    case "r2":
      return { bucketName: native.name };
    case "d1":
      return { databaseId: native.name };
    case "kv":
      return { namespaceId: native.name };
    case "queue":
      return { queueId: native.name };
    case "worker":
      return { scriptName: native.name };
    case "version":
      return { scriptName: native.parent, versionId: native.name };
    case "deployment":
      return { scriptName: native.parent, deploymentId: native.name };
    case "endpoint":
      return { scriptName: native.name };
    case "domain":
      return { domainId: native.name };
    case "cron": {
      const cron = optionalString(spec?.cron);
      return cron ? { scriptName: native.parent, cron } : null;
    }
    case "consumer":
      return { queueId: native.parent, consumerId: native.name };
  }
}

function validateCloudflareReadbackDescriptor(
  provider: string,
  offering: ProviderOffering,
  descriptor: ProviderNativeReadbackDescriptor,
): NativeId | null {
  const raw = record(descriptor);
  if (!raw) return null;
  if (
    raw.apiVersion !== PROVIDER_READBACK_API_VERSION ||
    raw.provider !== provider ||
    raw.kind !== providerKind(offering) ||
    typeof raw.nativeId !== "string" ||
    raw.nativeId.length < 1 ||
    raw.nativeId.length > 4_096
  ) {
    // The parser below enforces the exact native kind/parent shape; this
    // branch only bounds the opaque descriptor value before parsing it.
    return null;
  }
  const native = parseNativeId(raw.nativeId);
  if (!native || !cloudflareKindMatches(providerKind(offering), native.kind)) return null;
  const data = record(raw.data);
  if (!data || !cloudflareReadbackDataMatches(native, data)) return null;
  return native;
}

function cloudflareReadbackDataMatches(native: NativeId, data: Record<string, unknown>): boolean {
  switch (native.kind) {
    case "r2":
      return exactData(data, { bucketName: native.name });
    case "d1":
      return exactData(data, { databaseId: native.name });
    case "kv":
      return exactData(data, { namespaceId: native.name });
    case "queue":
      return exactData(data, { queueId: native.name });
    case "worker":
      return exactData(data, { scriptName: native.name });
    case "version":
      return exactData(data, { scriptName: native.parent, versionId: native.name });
    case "deployment":
      return exactData(data, { scriptName: native.parent, deploymentId: native.name });
    case "endpoint":
      return exactData(data, { scriptName: native.name });
    case "domain":
      return exactData(data, { domainId: native.name });
    case "cron":
      return (
        exactKeys(data, ["scriptName", "cron"]) &&
        data.scriptName === native.parent &&
        typeof data.cron === "string" &&
        data.cron.length > 0 &&
        data.cron.length <= 4_096
      );
    case "consumer":
      return exactData(data, { queueId: native.parent, consumerId: native.name });
  }
}

function exactData(data: Record<string, unknown>, expected: Record<string, string>): boolean {
  return (
    exactKeys(data, Object.keys(expected)) &&
    Object.entries(expected).every(([key, value]) => data[key] === value)
  );
}

function exactKeys(data: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(data).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function cloudflareReadbackPath(accountId: string, native: NativeId): string | null {
  const account = `/accounts/${accountId}`;
  switch (native.kind) {
    case "r2":
      return `${account}/r2/buckets/${encodeURIComponent(native.name)}`;
    case "d1":
      return `${account}/d1/database/${encodeURIComponent(native.name)}`;
    case "kv":
      return `${account}/storage/kv/namespaces/${encodeURIComponent(native.name)}`;
    case "queue":
      return `${account}/queues/${encodeURIComponent(native.name)}`;
    case "worker":
      return `${account}/workers/scripts/${encodeURIComponent(native.name)}`;
    case "version":
      return `${account}/workers/scripts/${encodeURIComponent(native.parent)}/versions/${encodeURIComponent(native.name)}`;
    case "deployment":
      return `${account}/workers/scripts/${encodeURIComponent(native.parent)}/deployments/${encodeURIComponent(native.name)}`;
    case "endpoint":
      return `${account}/workers/scripts/${encodeURIComponent(native.name)}/subdomain`;
    case "domain":
      return `${account}/workers/domains/${encodeURIComponent(native.name)}`;
    case "cron":
      return `${account}/workers/scripts/${encodeURIComponent(native.parent)}/schedules`;
    case "consumer":
      return `${account}/queues/${encodeURIComponent(native.parent)}/consumers/${encodeURIComponent(native.name)}`;
  }
}

function cloudflareReadbackState(
  native: NativeId,
  value: unknown,
  expectedCron?: string,
): CloudflareReadbackState {
  if (native.kind === "endpoint") {
    const result = record(value);
    if (!result || typeof result.enabled !== "boolean") return "malformed";
    return result.enabled ? "present" : "absent";
  }
  if (native.kind === "cron") {
    const values = strictScheduleValues(value);
    if (!values) return "malformed";
    return expectedCron !== undefined && values.includes(expectedCron) ? "present" : "absent";
  }
  const result = record(value);
  if (!result) return "malformed";
  const identityChecks: readonly [string, string][] =
    native.kind === "worker"
      ? [
          ["id", native.name],
          ["name", native.name],
          ["script_name", native.name],
        ]
      : native.kind === "version"
        ? [["id", native.name]]
        : native.kind === "deployment"
          ? [["id", native.name]]
          : native.kind === "domain"
            ? [["id", native.name]]
            : native.kind === "consumer"
              ? [["consumer_id", native.name]]
              : native.kind === "r2"
                ? [["name", native.name]]
                : native.kind === "d1"
                  ? [
                      ["uuid", native.name],
                      ["id", native.name],
                    ]
                  : native.kind === "kv"
                    ? [["id", native.name]]
                    : native.kind === "queue"
                      ? [
                          ["queue_id", native.name],
                          ["id", native.name],
                        ]
                      : [];
  for (const [field, expected] of identityChecks) {
    if (field in result && result[field] !== expected) return "malformed";
    if (field in result && typeof result[field] !== "string") return "malformed";
  }
  return "present";
}

function strictScheduleValues(value: unknown): readonly string[] | null {
  const result = record(value);
  const list = Array.isArray(value) ? value : result?.schedules;
  if (!Array.isArray(list)) return null;
  const values: string[] = [];
  for (const item of list) {
    const cron = optionalString(record(item)?.cron);
    if (!cron) return null;
    values.push(cron);
  }
  return [...new Set(values)].sort();
}

/** The numeric codes in a Cloudflare error envelope, if it carried any. */
function errorCodes(errors: unknown): readonly number[] {
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry) => (entry as { code?: unknown } | null)?.code)
    .filter((code): code is number => typeof code === "number");
}

function classify(status: number): ProviderTicket {
  if (status === 400 || status === 422)
    return failed("invalid_spec", "the backend rejected the request");
  if (status === 401 || status === 403) return failed("denied", "the credential was refused");
  if (status === 404) return failed("not_found", "the resource does not exist");
  if (status === 409) return failed("conflict", "the resource already exists");
  if (status === 429) return failed("quota", "the backend is rate limiting", true);
  return failed("unavailable", "the backend could not serve the request", status >= 500);
}

async function readEnvelope(response: Response): Promise<{
  success?: unknown;
  result?: unknown;
  result_info?: unknown;
  errors?: unknown;
} | null> {
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    return null;
  }
  if (bytes.byteLength > 4 * 1_048_576) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return record(value) ?? null;
  } catch {
    return null;
  }
}

function providerValueFailure<T>(
  code: Parameters<typeof failed>[0],
  message: string,
  retryable = false,
): ProviderValue<T> {
  return { ok: false, failure: { code, message, retryable } };
}

function callFailure<T>(call: Extract<CallResult, { readonly ok: false }>): ProviderValue<T> {
  return call.ticket.phase === "failed"
    ? { ok: false, failure: call.ticket.failure }
    : providerValueFailure("unavailable", "the backend did not settle", true);
}

function d1Results(value: unknown): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const results = value.map(record);
  return results.every((result): result is Record<string, unknown> => result !== undefined)
    ? results
    : null;
}

function d1Rows(value: unknown): readonly unknown[] | null {
  const results = d1Results(value);
  if (!results) return null;
  if (results.length !== 1 || results[0]?.success !== true) return null;
  return Array.isArray(results[0].results) ? results[0].results : null;
}

function d1DatabaseId(nativeId: string): string | null {
  const native = parseNativeId(nativeId);
  return native?.kind === "d1" ? native.name : null;
}

function migrationPath(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function sha256Digest(value: string | undefined): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

type NativeId =
  | {
      readonly kind: "r2" | "d1" | "kv" | "queue" | "worker" | "endpoint" | "domain";
      readonly name: string;
    }
  | {
      readonly kind: "version" | "deployment" | "cron" | "consumer";
      readonly parent: string;
      readonly name: string;
    };

function parseNativeId(value: string): NativeId | null {
  const parts = value.split(":");
  const kind = parts[0];
  if (
    (kind === "r2" ||
      kind === "d1" ||
      kind === "kv" ||
      kind === "queue" ||
      kind === "worker" ||
      kind === "endpoint" ||
      kind === "domain") &&
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

function outputsFor(native: NativeId, result?: Record<string, unknown>): JsonObject {
  if (native.kind === "r2") return { protocol: "s3", bucketName: native.name };
  if (native.kind === "d1") {
    const databaseName = optionalString(result?.name);
    return {
      databaseId: native.name,
      ...(databaseName ? { databaseName } : {}),
    };
  }
  if (native.kind === "kv") return { namespaceId: native.name };
  if (native.kind === "queue") {
    const queueName = optionalString(result?.queue_name);
    return {
      queueId: native.name,
      ...(queueName ? { queueName } : {}),
    };
  }
  if (native.kind === "worker") return { scriptName: native.name };
  return {};
}

function nativeSegment(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(value);
}

function scheduleValues(value: unknown): string[] {
  const result = record(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(result?.schedules)
      ? result.schedules
      : [];
  return [
    ...new Set(list.map((item) => optionalString(record(item)?.cron)).filter(isString)),
  ].sort();
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
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
  const relation = relations?.find((candidate) => candidate.pointer === pointer);
  const nativeId = relation?.deployment?.nativeId;
  if (!nativeId) return optional ? null : null;
  const parts = nativeId.split(":");
  if (parts[0] !== kind) return null;
  if (parts.length === 2 && parts[1]) return { kind, name: parts[1] };
  if (parts.length === 3 && parts[1] && parts[2]) {
    return { kind, parent: parts[1], name: parts[2] };
  }
  return null;
}

function relationResource(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
  kind: string,
): ProviderRelation["resource"] | null {
  const relation = relations?.find((candidate) => candidate.pointer === pointer);
  return relation?.resource.kind === kind ? relation.resource : null;
}

function relationOutputName(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
  output: string,
): string | undefined {
  const relation = relations?.find((candidate) => candidate.pointer === pointer);
  return optionalString(relation?.deployment?.outputs[output]);
}

/**
 * Native bindings for one Worker Version.
 *
 * `bucketBindings` is different in kind from the others: the Provider Pack has
 * already materialized it into an opaque capability before this adapter runs,
 * so the declaration is validated against that result rather than read from
 * the spec. A missing, extra, misnamed, or foreign entry returns `null`, which
 * the caller turns into `invalid_spec` before any Cloudflare mutation.
 */
function edgeBindings(
  spec: JsonObject,
  relations: readonly ProviderRelation[] | undefined,
  runtimeBindings: readonly ProviderRuntimeBinding[] | undefined,
): readonly JsonObject[] | null {
  const result: JsonObject[] = [];
  const vars = (record(spec.vars) ?? {}) as Readonly<Record<string, JsonValue>>;
  for (const [name, value] of Object.entries(vars).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    // Cloudflare's plain_text binding exposes its text byte-for-byte. Preserve
    // strings and use a JSON binding for every other portable JsonValue.
    result.push(
      typeof value === "string"
        ? { type: "plain_text", name, text: value }
        : { type: "json", name, json: value },
    );
  }
  for (const [field, relationPrefix, type, output, targetKey] of [
    ["kvBindings", "/kvBindings", "kv_namespace", "namespaceId", "namespace_id"],
    ["sqliteBindings", "/sqliteBindings", "d1", "databaseId", "id"],
    ["queueProducerBindings", "/queueProducerBindings", "queue", "queueName", "queue_name"],
    ["serviceBindings", "/serviceBindings", "service", "scriptName", "service"],
  ] as const) {
    const declarations = Array.isArray(spec[field]) ? spec[field] : [];
    for (let index = 0; index < declarations.length; index += 1) {
      const declaration = record(declarations[index]);
      const name = optionalString(declaration?.name);
      const target = relationOutputName(relations, `${relationPrefix}/${index}/resource`, output);
      if (!name || !target) return null;
      result.push({ type, name, [targetKey]: target });
    }
  }

  // A Worker Version inherits its placement from the ModuleWorker it revises.
  // A bucket realized under a different installation is a different Cloudflare
  // account, which this adapter's credential cannot reach, so it is refused
  // here rather than uploaded and discovered at runtime.
  const installationRef = relations?.find((candidate) => candidate.pointer === "/worker")
    ?.deployment?.providerInstallationRef;
  const bucketDeclarations = Array.isArray(spec.bucketBindings) ? spec.bucketBindings : [];
  const materialized = runtimeBindings ?? [];
  if (bucketDeclarations.length !== materialized.length) return null;
  for (let index = 0; index < materialized.length; index += 1) {
    const service = materialized[index];
    const declaration = record(bucketDeclarations[index]);
    const relation = relations?.find(
      (candidate) => candidate.pointer === `/bucketBindings/${index}/resource`,
    );
    const material = cloudflareR2EdgeObjectsMaterial(service?.material);
    const name = optionalString(service?.name);
    if (
      !service ||
      service.bindingRef.apiVersion !== EDGE_OBJECTS_BINDING_REF.apiVersion ||
      service.bindingRef.name !== EDGE_OBJECTS_BINDING_REF.name ||
      service.bindingRef.version !== EDGE_OBJECTS_BINDING_REF.version ||
      service.bindingRef.schemaDigest !== EDGE_OBJECTS_BINDING_REF.schemaDigest ||
      !name ||
      !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(name) ||
      optionalString(declaration?.name) !== name ||
      !relation ||
      relation.resource.kind !== "ObjectBucket" ||
      relation.targetUid !== service.targetUid ||
      relation.deployment?.state !== "active" ||
      !installationRef ||
      relation.deployment.providerInstallationRef !== installationRef ||
      !material
    ) {
      return null;
    }
    result.push({ type: "r2_bucket", name, bucket_name: material.bucketName });
  }
  return result;
}

async function shortDigest(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value) as unknown as BufferSource,
    ),
  );
  return [...digest.slice(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Bindings the customer declared. Only kinds Takoserver understands are passed
 * through, so a bundle cannot ask for reach its Form never offered.
 */
function bindingsOf(value: JsonValue | undefined): readonly JsonObject[] {
  if (!Array.isArray(value)) return [];
  const bindings: JsonObject[] = [];
  for (const entry of value) {
    const binding = record(entry);
    const name = optionalString(binding?.name);
    const type = optionalString(binding?.type);
    if (!name || !type) continue;
    if (type === "d1") {
      const id = optionalString(binding?.databaseId);
      if (id) bindings.push({ type: "d1", name, id });
    } else if (type === "r2_bucket") {
      const bucket = optionalString(binding?.bucketName);
      if (bucket) bindings.push({ type: "r2_bucket", name, bucket_name: bucket });
    } else if (type === "kv_namespace") {
      const namespace = optionalString(binding?.namespaceId);
      if (namespace) bindings.push({ type: "kv_namespace", name, namespace_id: namespace });
    } else if (type === "queue") {
      const queue = optionalString(binding?.queueName);
      if (queue) bindings.push({ type: "queue", name, queue_name: queue });
    } else if (type === "service") {
      const service = optionalString(binding?.service);
      if (service) bindings.push({ type: "service", name, service });
    } else if (type === "plain_text") {
      const text = optionalString(binding?.text);
      if (text !== undefined) bindings.push({ type: "plain_text", name, text });
    }
  }
  return bindings;
}

interface DurableObjectDeclaration {
  readonly name: string;
  readonly className: string;
  readonly storage: "sqlite" | "key-value";
}

function durableObjectsOf(value: JsonValue | undefined): readonly DurableObjectDeclaration[] {
  if (!Array.isArray(value)) return [];
  const declared: DurableObjectDeclaration[] = [];
  for (const entry of value) {
    const record_ = record(entry);
    const name = optionalString(record_?.name);
    const className = optionalString(record_?.className);
    if (!name || !className) continue;
    declared.push({
      name,
      className,
      storage: optionalString(record_?.storage) === "key-value" ? "key-value" : "sqlite",
    });
  }
  return declared;
}

function previousDurableClasses(spec: JsonObject | undefined): ReadonlySet<string> {
  return new Set(durableObjectsOf(spec?.durableObjects).map((entry) => entry.className));
}

/**
 * The migration that introduces classes this upload declares for the first
 * time. Classes already present are left alone: re-declaring one as new would
 * ask Cloudflare to create something that exists, and dropping the ones no
 * longer declared would destroy their stored state, which is never a safe
 * inference from an absent line in a spec.
 */
function migrationFor(
  declared: readonly DurableObjectDeclaration[],
  existing: ReadonlySet<string>,
): JsonObject | null {
  const fresh = declared.filter((entry) => !existing.has(entry.className));
  if (fresh.length === 0) return null;
  const sqlite = fresh.filter((entry) => entry.storage === "sqlite").map((e) => e.className);
  const keyValue = fresh.filter((entry) => entry.storage !== "sqlite").map((e) => e.className);
  return {
    tag: `v${existing.size + fresh.length}`,
    ...(sqlite.length > 0 ? { new_sqlite_classes: sqlite } : {}),
    ...(keyValue.length > 0 ? { new_classes: keyValue } : {}),
  };
}

function stringList(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sensitiveBindingNames(value: JsonValue | undefined): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names = value.filter((entry): entry is string => typeof entry === "string");
  if (
    names.length !== value.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name))
  ) {
    return null;
  }
  return names;
}

function exactRuntimeInputBindings(
  bindings: Readonly<Record<string, string>>,
  expectedNames: readonly string[],
): boolean {
  const names = Object.keys(bindings).sort();
  const expected = [...expectedNames].sort();
  return (
    JSON.stringify(names) === JSON.stringify(expected) &&
    names.every(
      (name) => typeof bindings[name] === "string" && (bindings[name] as string).length > 0,
    )
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function runtimeInputFailure(
  error: unknown,
  phase: "acquire" | "abort" | "dispatch" | "recover" | "settle",
): ProviderTicket {
  const code = optionalString(record(error)?.code);
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
  if (code === "conflict") {
    return failed("conflict", "the sensitive Worker runtime input lease conflicts");
  }
  return failed("denied", "required sensitive Worker runtime inputs are unavailable");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
}

async function workerVersionOperationMarker(value: unknown): Promise<string | null> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return null;
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > WORKER_VERSION_OPERATION_ID_BYTE_LIMIT) return null;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  return `${WORKER_VERSION_OPERATION_MARKER_PREFIX}${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function workerVersionReceiptDigest(
  accountId: string,
  operationMarker: string,
  scriptName: string,
  versionId: string,
  secretTextNames: readonly string[],
  runtimeInputCommitment?: `sha256:${string}`,
): Promise<`sha256:${string}`> {
  const canonical = JSON.stringify({
    format: "takoserver.cloudflare-worker-version-receipt@v2",
    accountId,
    operationMarker,
    scriptName,
    versionId,
    secretTextNames: [...secretTextNames].sort(),
    runtimeInputCommitment: runtimeInputCommitment ?? null,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical) as unknown as BufferSource,
    ),
  );
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function workerVersionOperationMarkerValue(value: string): boolean {
  return new RegExp(`^${WORKER_VERSION_OPERATION_MARKER_PREFIX}[0-9a-f]{64}$`, "u").test(value);
}

function workerVersionId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
    ? value
    : null;
}
