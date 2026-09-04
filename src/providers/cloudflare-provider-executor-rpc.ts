import { bytesDigest, canonicalDigest, canonicalJson } from "../json.ts";
import type { JsonObject, JsonValue, Sql } from "../ports.ts";
import type {
  MeterSource,
  ProviderMeterDeployment,
  ProviderMeterUsage,
} from "../provider-meter-port.ts";
import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderArtifactConsumption,
  type ProviderArtifactConsumptionInput,
  type ProviderExecutionAuthority,
  type ProviderNativeAbsence,
  type ProviderOffering,
  type ProviderRelation,
  type ProviderSqliteMigration,
  type ProviderSqliteMigrationIdentity,
  type ProviderTicket,
  type ProviderValue,
  type ResourceIdentity,
} from "../provider-port.ts";
import {
  type CloudflareProviderMeterSourceDescriptor,
  cloudflareProviderMeterSourceForOfferingKind,
} from "./cloudflare-edge-meter-contract.ts";
import {
  cloudflareWfpOwnsOffering,
  validateCloudflareNativeReadbackDescriptor,
} from "./cloudflare-readback-descriptor.ts";
import { cloudflareR2EdgeObjectsMaterial } from "./cloudflare-runtime-bindings.ts";
import { ProviderMeterError } from "./provider-meter.ts";

export type CloudflareProviderObserveInput = Parameters<Provider["observe"]>[0];
export type CloudflareProviderDeleteInput = Parameters<Provider["delete"]>[0];
export type CloudflareProviderRecoverDeleteInput = Parameters<
  NonNullable<Provider["recoverDelete"]>
>[0];
export type CloudflareProviderAdoptInput = Parameters<NonNullable<Provider["adopt"]>>[0];
export type CloudflareProviderRecoverAdoptInput = Parameters<
  NonNullable<Provider["recoverAdopt"]>
>[0];
export type CloudflareProviderPollInput = Parameters<NonNullable<Provider["poll"]>>[0];
export type CloudflareProviderVerifyNativeAbsenceInput = Parameters<
  NonNullable<Provider["verifyNativeAbsence"]>
>[0];
export type CloudflareProviderVerifyArtifactConsumptionInput = ProviderArtifactConsumptionInput;
export type CloudflareProviderSqliteMigrationReadInput = Parameters<
  NonNullable<Provider["sqliteMigrations"]>["readLedger"]
>[0];
type ProviderSqliteMigrationApplyInput = Parameters<
  NonNullable<Provider["sqliteMigrations"]>["applySuffix"]
>[0];
/** Artifact identities cross RPC; the executor resolves and verifies bytes in its own isolate. */
export type CloudflareProviderSqliteMigrationApplyInput = Omit<
  ProviderSqliteMigrationApplyInput,
  "desired" | "migrations"
> & {
  readonly desired: readonly ProviderSqliteMigrationIdentity[];
  readonly migrations: readonly ProviderSqliteMigrationIdentity[];
};

export interface CloudflareProviderMeterReadInput {
  readonly meterSourceId: string;
  readonly meters: readonly string[];
  readonly offering: ProviderOffering;
  readonly tenantId: string;
  readonly deployment: ProviderMeterDeployment;
  readonly from: string;
  readonly until: string;
}

export type CloudflareProviderMeterReadResult =
  | { readonly ok: true; readonly value: readonly ProviderMeterUsage[] }
  | { readonly ok: false; readonly error: { readonly code: ProviderMeterError["code"] } };

/**
 * The complete service-binding RPC surface. There is deliberately no `fetch`
 * bridge and no general provider escape hatch.
 */
export interface CloudflareProviderExecutorRpc {
  apply(input: ApplyInput): Promise<ProviderTicket>;
  recoverApply(input: ApplyInput): Promise<ProviderTicket>;
  convergeApply(input: ApplyInput): Promise<ProviderTicket>;
  poll(input: CloudflareProviderPollInput): Promise<ProviderTicket>;
  observe(input: CloudflareProviderObserveInput): Promise<ProviderTicket>;
  delete(input: CloudflareProviderDeleteInput): Promise<ProviderTicket>;
  recoverDelete(input: CloudflareProviderRecoverDeleteInput): Promise<ProviderTicket>;
  adopt(input: CloudflareProviderAdoptInput): Promise<ProviderTicket>;
  recoverAdopt(input: CloudflareProviderRecoverAdoptInput): Promise<ProviderTicket>;
  verifyNativeAbsence(
    input: CloudflareProviderVerifyNativeAbsenceInput,
  ): Promise<ProviderNativeAbsence>;
  verifyArtifactConsumption(
    input: CloudflareProviderVerifyArtifactConsumptionInput,
  ): Promise<ProviderArtifactConsumption>;
  readSqliteMigrationLedger(
    input: CloudflareProviderSqliteMigrationReadInput,
  ): Promise<ProviderValue<readonly ProviderSqliteMigrationIdentity[]>>;
  applySqliteMigrationSuffix(
    input: CloudflareProviderSqliteMigrationApplyInput,
  ): Promise<ProviderValue<undefined>>;
  readMeterUsage(
    input: CloudflareProviderMeterReadInput,
  ): Promise<CloudflareProviderMeterReadResult>;
}

export interface CloudflareProviderExecutorOptions {
  /** Lazy so an RPC request never constructs credential-bearing state at module scope. */
  readonly provider: () => Promise<Provider>;
  readonly sql: Sql;
  /** Exact private installation selected by this one route-less Worker. */
  readonly providerInstallationId: string;
  /** Credential-bearing sources constructed only inside this route-less Worker. */
  readonly meterSources?: readonly MeterSource[];
  /** Tenant-held artifact read performed inside the credential-bearing isolate. */
  readonly migrationSql?: (
    tenantId: string,
    digest: `sha256:${string}`,
  ) => Promise<Uint8Array | null>;
  readonly clock?: () => Date;
}

const MUTATION_AUTHORITY_FAILURE = Object.freeze({
  code: "unavailable" as const,
  message: "the Cloudflare provider mutation authority is unavailable",
  retryable: true,
});

/**
 * Testable implementation behind the WorkerEntrypoint.
 *
 * Every provider effect is preceded by one D1 statement that both proves the
 * exact live Host execution lease and inserts the executor-owned logical
 * intent claim. Recovery may reuse only that immutable claim. The claim is
 * deliberately not a provider outcome ledger: the Host saga remains the one
 * authority for handles, receipts, and terminal state.
 */
export function createCloudflareProviderExecutor(
  options: CloudflareProviderExecutorOptions,
): CloudflareProviderExecutorRpc {
  if (!boundedString(options.providerInstallationId, 1, 255)) {
    throw new TypeError("invalid Cloudflare provider executor installation identity");
  }
  const now = options.clock ?? (() => new Date());
  const meterSources = configuredMeterSources(options.meterSources ?? []);
  const mutationFailure = (): ProviderTicket => ({
    phase: "failed",
    failure: MUTATION_AUTHORITY_FAILURE,
  });
  const migrationMutationFailure = (): ProviderValue<undefined> => ({
    ok: false,
    failure: MUTATION_AUTHORITY_FAILURE,
  });

  return {
    async apply(raw) {
      const input = parseApplyInput(raw);
      if (
        input.operationMode !== "initial" ||
        !(await authorizeApply(options, input, "initial", now().getTime()))
      ) {
        return mutationFailure();
      }
      const provider = await options.provider();
      return providerOwnsOffering(provider, input.offering)
        ? await provider.apply(input)
        : mutationFailure();
    },

    async recoverApply(raw) {
      const input = parseApplyInput(raw);
      if (!(await authorizeApply(options, input, "readback", now().getTime()))) {
        return mutationFailure();
      }
      const provider = await options.provider();
      if (!providerOwnsOffering(provider, input.offering)) return mutationFailure();
      if (objectBucketOffering(input.offering)) {
        return failed(
          "unavailable",
          "managed ObjectBucket apply recovery requires operator reconciliation",
          true,
        );
      }
      return provider.recoverApply
        ? await provider.recoverApply(input)
        : failed("unavailable", "the Cloudflare provider recovery path is unavailable", true);
    },

    async convergeApply(raw) {
      const input = parseApplyInput(raw);
      if (
        input.operationMode !== "recovery" ||
        !(await authorizeApply(options, input, "recovery", now().getTime()))
      ) {
        return mutationFailure();
      }
      const provider = await options.provider();
      if (!providerOwnsOffering(provider, input.offering)) return mutationFailure();
      if (objectBucketOffering(input.offering)) {
        return failed("unavailable", "managed ObjectBucket apply convergence is unavailable", true);
      }
      return provider.convergeApply
        ? await provider.convergeApply(input)
        : failed("unavailable", "the Cloudflare provider convergence path is unavailable", true);
    },

    async poll(raw) {
      const input = parsePollInput(raw);
      if (!(await authorizePoll(options.sql, input, now().getTime()))) return mutationFailure();
      const provider = await options.provider();
      return provider.poll
        ? await provider.poll(input)
        : failed("unavailable", "the Cloudflare provider polling path is unavailable", true);
    },

    async observe(raw) {
      const input = parseObserveInput(raw);
      if (!(await authorizeObserve(options, input))) return mutationFailure();
      const provider = await options.provider();
      if (
        objectBucketOffering(input.offering) &&
        !providerOwnsCurrentOffering(provider, input.offering)
      ) {
        return mutationFailure();
      }
      return providerOwnsOffering(provider, input.offering)
        ? await provider.observe(input)
        : mutationFailure();
    },

    async delete(raw) {
      const input = parseDeleteInput(raw);
      if (
        input.operationMode !== "initial" ||
        !(await authorizeDelete(options, input, "initial", now().getTime()))
      ) {
        return mutationFailure();
      }
      const provider = await options.provider();
      return providerOwnsOffering(provider, input.offering)
        ? await provider.delete(input)
        : mutationFailure();
    },

    async recoverDelete(raw) {
      const input = parseDeleteInput(raw);
      if (
        input.operationMode !== "recovery" ||
        !(await authorizeDelete(options, input, "recovery", now().getTime()))
      ) {
        return mutationFailure();
      }
      const provider = await options.provider();
      if (!providerOwnsOffering(provider, input.offering)) return mutationFailure();
      if (objectBucketOffering(input.offering)) {
        return failed(
          "unavailable",
          "managed ObjectBucket delete recovery requires its retained receipt handle",
          true,
        );
      }
      return provider.recoverDelete
        ? await provider.recoverDelete(input)
        : failed("unavailable", "the Cloudflare delete recovery path is unavailable", true);
    },

    async adopt(raw) {
      const input = parseAdoptInput(raw);
      if (
        input.operationMode !== "initial" ||
        !(await authorizeAdopt(options, input, "initial", now().getTime()))
      ) {
        return mutationFailure();
      }
      const provider = await options.provider();
      if (!providerOwnsOffering(provider, input.offering)) return mutationFailure();
      return provider.adopt
        ? await provider.adopt(input)
        : failed("unavailable", "the Cloudflare provider adoption path is unavailable", true);
    },

    async recoverAdopt(raw) {
      const input = parseAdoptInput(raw);
      if (
        input.operationMode !== "recovery" ||
        !(await authorizeAdopt(options, input, "recovery", now().getTime()))
      ) {
        return mutationFailure();
      }
      const provider = await options.provider();
      if (!providerOwnsOffering(provider, input.offering)) return mutationFailure();
      return provider.recoverAdopt
        ? await provider.recoverAdopt(input)
        : failed("unavailable", "the Cloudflare adoption recovery path is unavailable", true);
    },

    async verifyNativeAbsence(raw) {
      const input = parseVerifyNativeAbsenceInput(raw);
      if (!(await authorizeNativeAbsenceRead(options, input))) {
        return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
      }
      const provider = await options.provider();
      if (!providerOwnsOffering(provider, input.offering)) {
        return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
      }
      if (
        objectBucketOffering(input.offering) &&
        !providerOwnsCurrentOffering(provider, input.offering)
      ) {
        return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
      }
      const verify = provider.verifyNativeAbsence;
      return verify
        ? await verify(input)
        : { outcome: "unknown", reason: "unsupported", retryable: false };
    },

    async verifyArtifactConsumption(raw) {
      const input = parseVerifyArtifactConsumptionInput(raw);
      const provider = await options.provider();
      if (
        !provider.verifyArtifactConsumption ||
        !providerOwnsOffering(provider, input.offering) ||
        !(await authorizeArtifactConsumptionRead(options, input))
      ) {
        return { outcome: "unknown", reason: "authority_unavailable", retryable: false };
      }
      try {
        const result = await provider.verifyArtifactConsumption(input);
        return isCloudflareProviderArtifactConsumption(result)
          ? result
          : { outcome: "unknown", reason: "malformed", retryable: false };
      } catch {
        return { outcome: "unknown", reason: "transport", retryable: true };
      }
    },

    async readSqliteMigrationLedger(raw) {
      const input = parseSqliteReadInput(raw);
      const provider = await options.provider();
      if (!(await authorizeSqliteRead(options, provider, input))) {
        return {
          ok: false,
          failure: MUTATION_AUTHORITY_FAILURE,
        };
      }
      const migrations = provider.sqliteMigrations;
      return migrations
        ? await migrations.readLedger(input)
        : {
            ok: false,
            failure: {
              code: "invalid_spec",
              message: "the Cloudflare SQLite migration reader is unavailable",
              retryable: false,
            },
          };
    },

    async applySqliteMigrationSuffix(raw) {
      const requested = parseSqliteApplyInput(raw);
      const input = await resolveSqliteMigrationInput(options, requested);
      if (!input || !(await authorizeSqliteMigration(options, input, now().getTime()))) {
        return migrationMutationFailure();
      }
      const migrations = (await options.provider()).sqliteMigrations;
      return migrations ? await migrations.applySuffix(input) : migrationMutationFailure();
    },

    async readMeterUsage(raw) {
      const input = parseMeterReadInput(raw);
      const source = meterSources.get(input.meterSourceId);
      const provider = await options.provider();
      if (
        !source ||
        !providerOwnsCurrentOffering(provider, input.offering) ||
        !meterSourceMatchesOffering(source, input.offering) ||
        !sameStrings(source.meters, input.meters) ||
        !(await authorizeMeterRead(options, input))
      ) {
        return { ok: false, error: { code: "upstream_invalid" } };
      }
      try {
        const value = await source.read({
          tenantId: input.tenantId,
          deployment: input.deployment,
          from: input.from,
          until: input.until,
        });
        return validMeterUsage(value, source.meters)
          ? { ok: true, value }
          : { ok: false, error: { code: "upstream_invalid" } };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof ProviderMeterError ? error.code : "upstream_unavailable",
          },
        };
      }
    },
  };
}

async function authorizeNativeAbsenceRead(
  options: CloudflareProviderExecutorOptions,
  input: CloudflareProviderVerifyNativeAbsenceInput,
): Promise<boolean> {
  try {
    const validated = validateCloudflareNativeReadbackDescriptor({
      providerId: "cloudflare",
      placement: cloudflareWfpOwnsOffering(input.offering)
        ? "workers-for-platforms"
        : "ordinary-workers",
      offering: input.offering,
      descriptor: input.descriptor,
    });
    if (
      !validated ||
      (validated.placement === "workers-for-platforms" &&
        validated.resourceUid !== input.target.resourceUid)
    ) {
      return false;
    }
    const rows = await options.sql.query(
      `SELECT 1 AS authorized
       FROM tf_resource_deletion_attestations AS attestation
       INNER JOIN tf_resource_deployments AS deployment
         ON deployment.tenant_id = attestation.tenant_id
        AND deployment.resource_uid = attestation.resource_uid
       WHERE attestation.tenant_id = ?
         AND attestation.resource_uid = ?
         AND attestation.state = 'closed'
         AND attestation.api_version = ?
         AND attestation.kind = ?
         AND json_extract(attestation.form_ref_json, '$.definitionVersion') = ?
         AND json_extract(attestation.form_ref_json, '$.schemaDigest') = ?
         AND deployment.id = ?
         AND deployment.offering_id = ?
         AND deployment.provider_pack_ref = 'cloudflare'
         AND deployment.provider_installation_ref = ?
         AND deployment.native_id = ?
         AND deployment.state IN ('retained', 'deleted')
         AND json_extract(deployment.outputs_json, '$.__takoserver.resourceUid') = ?
         AND json_extract(deployment.outputs_json, '$.__takoserver.space') = attestation.space
         AND json_extract(deployment.outputs_json, '$.__takoserver.name') = attestation.name
         AND json_extract(deployment.outputs_json, '$.__takoserver.generation') = ?
       LIMIT 2`,
      [
        input.target.tenantId,
        input.target.resourceUid,
        input.offering.form.apiVersion,
        input.offering.form.kind,
        input.offering.form.definitionVersion,
        input.offering.form.schemaDigest,
        input.target.incarnationId,
        input.offering.id,
        options.providerInstallationId,
        input.descriptor.nativeId,
        input.target.resourceUid,
        input.target.generation,
      ],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function authorizeArtifactConsumptionRead(
  options: CloudflareProviderExecutorOptions,
  input: CloudflareProviderVerifyArtifactConsumptionInput,
): Promise<boolean> {
  try {
    const current = input.currentResource;
    const address = input.identity.address;
    if (
      input.target.tenantId !== input.identity.tenantRef ||
      input.target.resourceUid !== input.identity.resourceUid ||
      (current !== undefined && (input.target.state !== "active" || !address))
    ) {
      return false;
    }
    const currentPredicate = current
      ? `AND EXISTS (
           SELECT 1 FROM tf_resources AS resource
           WHERE resource.tenant_id = deployment.tenant_id
             AND resource.uid = deployment.resource_uid
             AND resource.space = ?
             AND resource.api_version = ?
             AND resource.kind = ?
             AND resource.name = ?
             AND resource.revision = ?
             AND json_extract(deployment.outputs_json, '$.__takoserver.resourceUid') = resource.uid
             AND json_extract(deployment.outputs_json, '$.__takoserver.space') = resource.space
             AND json_extract(deployment.outputs_json, '$.__takoserver.name') = resource.name
             AND json_extract(deployment.outputs_json, '$.__takoserver.generation') = resource.generation
         )`
      : "";
    const rows = await options.sql.query(
      `SELECT 1 AS authorized
       FROM tf_resource_deployments AS deployment
       WHERE deployment.tenant_id = ?
         AND deployment.id = ?
         AND deployment.resource_uid = ?
         AND deployment.offering_id = ?
         AND deployment.provider_pack_ref = 'cloudflare'
         AND deployment.provider_installation_ref = ?
         AND deployment.native_id = ?
         AND deployment.state = ?
         AND deployment.updated_at = ?
         ${currentPredicate}
       LIMIT 2`,
      [
        input.target.tenantId,
        input.target.incarnationId,
        input.target.resourceUid,
        input.offering.id,
        options.providerInstallationId,
        input.nativeId,
        input.target.state,
        input.target.updatedAt,
        ...(current && address
          ? [
              address.space,
              input.offering.form.apiVersion,
              input.offering.form.kind,
              address.name,
              current.revision,
            ]
          : []),
      ],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function authorizeObserve(
  options: CloudflareProviderExecutorOptions,
  input: CloudflareProviderObserveInput,
): Promise<boolean> {
  try {
    const identity = input.identity;
    if (!requiredResourceIdentity(identity)) return false;
    const rows = await options.sql.query(
      `SELECT 1 AS authorized
       FROM tf_resources AS resource
       INNER JOIN tf_resource_deployments AS deployment
         ON deployment.tenant_id = resource.tenant_id
        AND deployment.resource_uid = resource.uid
       WHERE resource.tenant_id = ?
         AND resource.space = ?
         AND resource.api_version = ?
         AND resource.kind = ?
         AND resource.name = ?
         AND resource.uid = ?
         AND resource.generation = ?
         AND deployment.id = ?
         AND deployment.offering_id = ?
         AND deployment.provider_pack_ref = 'cloudflare'
         AND deployment.provider_installation_ref = ?
         AND deployment.native_id = ?
         AND deployment.state = 'active'
       LIMIT 2`,
      [
        identity.tenantRef,
        identity.space,
        input.offering.form.apiVersion,
        input.offering.form.kind,
        identity.name,
        identity.uid,
        identity.generation,
        identity.incarnationId,
        input.offering.id,
        options.providerInstallationId,
        input.nativeId,
      ],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function authorizeSqliteRead(
  options: CloudflareProviderExecutorOptions,
  provider: Provider,
  input: CloudflareProviderSqliteMigrationReadInput,
): Promise<boolean> {
  try {
    const rows = await options.sql.query(
      `SELECT deployment.offering_id
       FROM tf_resources AS resource
       INNER JOIN tf_resource_deployments AS deployment
         ON deployment.tenant_id = resource.tenant_id
        AND deployment.resource_uid = resource.uid
       WHERE resource.tenant_id = ?
         AND resource.uid = ?
         AND resource.generation = ?
         AND resource.kind = 'SQLiteDatabase'
         AND deployment.id = ?
         AND deployment.provider_pack_ref = 'cloudflare'
         AND deployment.provider_installation_ref = ?
         AND deployment.native_id = ?
         AND deployment.state = 'active'
       LIMIT 2`,
      [
        input.target.tenantId,
        input.target.resourceUid,
        input.target.generation,
        input.target.incarnationId,
        options.providerInstallationId,
        input.nativeId,
      ],
    );
    if (rows.length !== 1 || typeof rows[0]?.offering_id !== "string") return false;
    return [...provider.offerings, ...(provider.recoveryOfferings ?? [])].some(
      (offering) => offering.id === rows[0]?.offering_id && offering.form.kind === "SQLiteDatabase",
    );
  } catch {
    return false;
  }
}

type ApplyAuthorizationMode = "initial" | "recovery" | "readback";
type DeleteAuthorizationMode = "initial" | "recovery";
type AdoptAuthorizationMode = "initial" | "recovery";

const EXECUTOR_INTENT_SCHEMA = "takoserver.cloudflare-provider-executor-intent@v1";

async function authorizeApply(
  options: CloudflareProviderExecutorOptions,
  input: ApplyInput,
  mode: ApplyAuthorizationMode,
  timestamp: number,
): Promise<boolean> {
  try {
    const authority = input.executionAuthority;
    if (
      !authority ||
      input.identity.uid !== authority.resourceUid ||
      input.identity.tenantRef !== authority.tenantId ||
      (mode === "initial"
        ? input.operationMode !== "initial"
        : input.operationMode !== "recovery") ||
      (input.previous !== undefined &&
        (!input.identity.incarnationId || !input.identity.generation)) ||
      input.providerHandle !== undefined
    ) {
      return false;
    }
    const digest = await logicalMutationDigest(options, "apply", input);
    const currentPredicate = input.previous
      ? `saga.accepted_uid = saga.resource_uid
         AND saga.accepted_generation IS NOT NULL
         AND saga.accepted_revision IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM tf_resources AS resource
           WHERE resource.tenant_id = saga.tenant_id
             AND resource.space = saga.target_space
             AND resource.api_version = saga.target_api_version
             AND resource.kind = saga.target_kind
             AND resource.name = saga.target_name
             AND resource.uid = saga.resource_uid
             AND resource.uid = saga.accepted_uid
             AND resource.generation = saga.accepted_generation
             AND resource.generation = ?
             AND resource.revision = saga.accepted_revision
         )
         AND EXISTS (
           SELECT 1 FROM tf_resource_deployments AS deployment
           WHERE deployment.tenant_id = saga.tenant_id
             AND deployment.id = ?
             AND deployment.resource_uid = saga.resource_uid
             AND deployment.offering_id = ?
             AND deployment.provider_pack_ref = 'cloudflare'
             AND deployment.provider_installation_ref = ?
             AND deployment.native_id = ?
             AND deployment.state = 'active'
         )`
      : `saga.accepted_uid IS NULL
         AND saga.accepted_generation IS NULL
         AND saga.accepted_revision IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM tf_resources AS resource
           WHERE resource.tenant_id = saga.tenant_id
             AND (
               (resource.space = saga.target_space
                 AND resource.api_version = saga.target_api_version
                 AND resource.kind = saga.target_kind
                 AND resource.name = saga.target_name)
               OR resource.uid = saga.resource_uid
             )
         )`;
    const commonParams = [
      input.operationId,
      authority.tenantId,
      authority.resourceUid,
      authority.fingerprint,
      authority.leaseToken,
      timestamp,
      timestamp,
      input.identity.space,
      input.offering.form.apiVersion,
      input.offering.form.kind,
      input.identity.name,
      ...(input.previous
        ? [
            input.identity.generation as string,
            input.identity.incarnationId as string,
            input.offering.id,
            options.providerInstallationId,
            input.previous.nativeId,
          ]
        : []),
    ] as const;
    const sagaPredicate = `saga.operation_id = ?
       AND saga.tenant_id = ?
       AND saga.resource_uid = ?
       AND saga.fingerprint = ?
       AND saga.phase = 'planned'
       AND saga.receipt_json IS NULL
       AND saga.execution_started_at IS NOT NULL
       AND saga.execution_lease_token = ?
       AND saga.execution_lease_until > ?
       AND saga.expires_at > ?
       AND saga.target_space = ?
       AND saga.target_api_version = ?
       AND saga.target_kind = ?
       AND saga.target_name = ?
       AND saga.provider_outcome ${mode === "initial" ? "= 'running'" : "IN ('running', 'indeterminate')"}
       AND ${currentPredicate}`;

    if (mode === "initial") {
      const claimed = await options.sql.run(
        `INSERT OR IGNORE INTO tf_cloudflare_provider_executor_operations
           (operation_id, tenant_id, resource_uid, host_fingerprint,
            mutation_kind, logical_intent_digest, created_at)
         SELECT ?, ?, ?, ?, 'apply', ?, ?
         FROM tf_provider_mutation_sagas AS saga
         WHERE ${sagaPredicate}`,
        [
          input.operationId,
          authority.tenantId,
          authority.resourceUid,
          authority.fingerprint,
          digest,
          timestamp,
          ...commonParams,
        ],
      );
      return claimed.changes === 1;
    }

    const rows = await options.sql.query(
      `SELECT 1 AS authorized
       FROM tf_provider_mutation_sagas AS saga
       INNER JOIN tf_cloudflare_provider_executor_operations AS claim
         ON claim.operation_id = saga.operation_id
       WHERE ${sagaPredicate}
         AND claim.tenant_id = saga.tenant_id
         AND claim.resource_uid = saga.resource_uid
         AND claim.host_fingerprint = saga.fingerprint
         AND claim.mutation_kind = 'apply'
         AND claim.logical_intent_digest = ?
       LIMIT 2`,
      [...commonParams, digest],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function authorizeDelete(
  options: CloudflareProviderExecutorOptions,
  input: CloudflareProviderDeleteInput,
  mode: DeleteAuthorizationMode,
  timestamp: number,
): Promise<boolean> {
  try {
    const authority = input.executionAuthority;
    if (
      !authority ||
      input.identity.uid !== authority.resourceUid ||
      input.identity.tenantRef !== authority.tenantId ||
      !input.identity.incarnationId ||
      !input.identity.generation ||
      input.operationMode !== mode ||
      input.providerHandle !== undefined
    ) {
      return false;
    }
    const digest = await logicalMutationDigest(options, "delete", input);
    const commonParams = [
      input.operationId,
      authority.tenantId,
      authority.resourceUid,
      authority.fingerprint,
      authority.leaseToken,
      timestamp,
      timestamp,
      input.identity.space,
      input.offering.form.apiVersion,
      input.offering.form.kind,
      input.identity.name,
      input.identity.generation,
      input.identity.incarnationId,
      input.offering.id,
      options.providerInstallationId,
      input.nativeId,
    ] as const;
    const sagaPredicate = `saga.operation_id = ?
       AND saga.tenant_id = ?
       AND saga.resource_uid = ?
       AND saga.fingerprint = ?
       AND saga.phase = 'planned'
       AND saga.receipt_json IS NULL
       AND saga.execution_started_at IS NOT NULL
       AND saga.execution_lease_token = ?
       AND saga.execution_lease_until > ?
       AND saga.expires_at > ?
       AND saga.target_space = ?
       AND saga.target_api_version = ?
       AND saga.target_kind = ?
       AND saga.target_name = ?
       AND saga.provider_outcome ${mode === "initial" ? "= 'running'" : "IN ('running', 'indeterminate')"}
       AND saga.accepted_uid = saga.resource_uid
       AND saga.accepted_generation = ?
       AND saga.accepted_revision IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM tf_resources AS resource
         WHERE resource.tenant_id = saga.tenant_id
           AND resource.space = saga.target_space
           AND resource.api_version = saga.target_api_version
           AND resource.kind = saga.target_kind
           AND resource.name = saga.target_name
           AND resource.uid = saga.resource_uid
           AND resource.uid = saga.accepted_uid
           AND resource.generation = saga.accepted_generation
           AND resource.revision = saga.accepted_revision
       )
       AND EXISTS (
         SELECT 1 FROM tf_resource_deployments AS deployment
         WHERE deployment.tenant_id = saga.tenant_id
           AND deployment.id = ?
           AND deployment.resource_uid = saga.resource_uid
           AND deployment.offering_id = ?
           AND deployment.provider_pack_ref = 'cloudflare'
           AND deployment.provider_installation_ref = ?
           AND deployment.native_id = ?
           AND deployment.state = 'active'
       )`;
    if (mode === "initial") {
      const claimed = await options.sql.run(
        `INSERT OR IGNORE INTO tf_cloudflare_provider_executor_operations
           (operation_id, tenant_id, resource_uid, host_fingerprint,
            mutation_kind, logical_intent_digest, created_at)
         SELECT ?, ?, ?, ?, 'delete', ?, ?
         FROM tf_provider_mutation_sagas AS saga
         WHERE ${sagaPredicate}`,
        [
          input.operationId,
          authority.tenantId,
          authority.resourceUid,
          authority.fingerprint,
          digest,
          timestamp,
          ...commonParams,
        ],
      );
      return claimed.changes === 1;
    }
    const rows = await options.sql.query(
      `SELECT 1 AS authorized
       FROM tf_provider_mutation_sagas AS saga
       INNER JOIN tf_cloudflare_provider_executor_operations AS claim
         ON claim.operation_id = saga.operation_id
       WHERE ${sagaPredicate}
         AND claim.tenant_id = saga.tenant_id
         AND claim.resource_uid = saga.resource_uid
         AND claim.host_fingerprint = saga.fingerprint
         AND claim.mutation_kind = 'delete'
         AND claim.logical_intent_digest = ?
       LIMIT 2`,
      [...commonParams, digest],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function authorizeAdopt(
  options: CloudflareProviderExecutorOptions,
  input: CloudflareProviderAdoptInput,
  mode: AdoptAuthorizationMode,
  timestamp: number,
): Promise<boolean> {
  try {
    const authority = input.executionAuthority;
    const hasIncumbent =
      input.identity.incarnationId !== undefined || input.identity.generation !== undefined;
    if (
      !authority ||
      input.identity.uid !== authority.resourceUid ||
      input.identity.tenantRef !== authority.tenantId ||
      input.operationMode !== mode ||
      input.providerHandle !== undefined ||
      (hasIncumbent && (!input.identity.incarnationId || !input.identity.generation))
    ) {
      return false;
    }
    const digest = await logicalMutationDigest(options, "adopt", input);
    const incumbentPredicate = hasIncumbent
      ? `saga.accepted_uid = saga.resource_uid
         AND saga.accepted_generation = ?
         AND saga.accepted_revision IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM tf_resources AS resource
           WHERE resource.tenant_id = saga.tenant_id
             AND resource.space = saga.target_space
             AND resource.api_version = saga.target_api_version
             AND resource.kind = saga.target_kind
             AND resource.name = saga.target_name
             AND resource.uid = saga.resource_uid
             AND resource.uid = saga.accepted_uid
             AND resource.generation = saga.accepted_generation
             AND resource.revision = saga.accepted_revision
         )
         AND EXISTS (
           SELECT 1 FROM tf_resource_deployments AS deployment
           WHERE deployment.tenant_id = saga.tenant_id
             AND deployment.id = ?
             AND deployment.resource_uid = saga.resource_uid
             AND deployment.offering_id = ?
             AND deployment.provider_pack_ref = 'cloudflare'
             AND deployment.provider_installation_ref = ?
             AND deployment.native_id = ?
             AND deployment.state = 'active'
         )`
      : `saga.accepted_uid IS NULL
         AND saga.accepted_generation IS NULL
         AND saga.accepted_revision IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM tf_resources AS resource
           WHERE resource.tenant_id = saga.tenant_id
             AND (
               (resource.space = saga.target_space
                 AND resource.api_version = saga.target_api_version
                 AND resource.kind = saga.target_kind
                 AND resource.name = saga.target_name)
               OR resource.uid = saga.resource_uid
             )
         )`;
    const commonParams = [
      input.operationId,
      authority.tenantId,
      authority.resourceUid,
      authority.fingerprint,
      authority.leaseToken,
      timestamp,
      timestamp,
      input.identity.space,
      input.offering.form.apiVersion,
      input.offering.form.kind,
      input.identity.name,
      ...(hasIncumbent
        ? [
            input.identity.generation as string,
            input.identity.incarnationId as string,
            input.offering.id,
            options.providerInstallationId,
            input.nativeId,
          ]
        : []),
    ] as const;
    const sagaPredicate = `saga.operation_id = ?
       AND saga.tenant_id = ?
       AND saga.resource_uid = ?
       AND saga.fingerprint = ?
       AND saga.phase = 'planned'
       AND saga.receipt_json IS NULL
       AND saga.execution_started_at IS NOT NULL
       AND saga.execution_lease_token = ?
       AND saga.execution_lease_until > ?
       AND saga.expires_at > ?
       AND saga.target_space = ?
       AND saga.target_api_version = ?
       AND saga.target_kind = ?
       AND saga.target_name = ?
       AND saga.provider_outcome ${mode === "initial" ? "= 'running'" : "IN ('running', 'indeterminate')"}
       AND ${incumbentPredicate}`;
    if (mode === "initial") {
      const claimed = await options.sql.run(
        `INSERT OR IGNORE INTO tf_cloudflare_provider_executor_operations
           (operation_id, tenant_id, resource_uid, host_fingerprint,
            mutation_kind, logical_intent_digest, created_at)
         SELECT ?, ?, ?, ?, 'adopt', ?, ?
         FROM tf_provider_mutation_sagas AS saga
         WHERE ${sagaPredicate}`,
        [
          input.operationId,
          authority.tenantId,
          authority.resourceUid,
          authority.fingerprint,
          digest,
          timestamp,
          ...commonParams,
        ],
      );
      return claimed.changes === 1;
    }
    const rows = await options.sql.query(
      `SELECT 1 AS authorized
       FROM tf_provider_mutation_sagas AS saga
       INNER JOIN tf_cloudflare_provider_executor_operations AS claim
         ON claim.operation_id = saga.operation_id
       WHERE ${sagaPredicate}
         AND claim.tenant_id = saga.tenant_id
         AND claim.resource_uid = saga.resource_uid
         AND claim.host_fingerprint = saga.fingerprint
         AND claim.mutation_kind = 'adopt'
         AND claim.logical_intent_digest = ?
       LIMIT 2`,
      [...commonParams, digest],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function authorizePoll(
  sql: Sql,
  input: CloudflareProviderPollInput,
  timestamp: number,
): Promise<boolean> {
  try {
    const authority = input.executionAuthority;
    if (!authority) return false;
    const rows = await sql.query(
      `SELECT 1 AS authorized
       FROM tf_provider_mutation_sagas AS saga
       INNER JOIN tf_cloudflare_provider_executor_operations AS claim
         ON claim.operation_id = saga.operation_id
       WHERE saga.operation_id = ?
         AND saga.tenant_id = ?
         AND saga.resource_uid = ?
         AND saga.fingerprint = ?
         AND saga.phase = 'planned'
         AND saga.receipt_json IS NULL
         AND saga.execution_started_at IS NOT NULL
         AND saga.execution_lease_token = ?
         AND saga.execution_lease_until > ?
         AND saga.expires_at > ?
         AND saga.provider_outcome IN ('running', 'indeterminate')
         AND saga.provider_handle = ?
         AND claim.tenant_id = saga.tenant_id
         AND claim.resource_uid = saga.resource_uid
         AND claim.host_fingerprint = saga.fingerprint
         AND claim.mutation_kind IN ('apply', 'delete', 'adopt')
       LIMIT 2`,
      [
        input.operationId,
        authority.tenantId,
        authority.resourceUid,
        authority.fingerprint,
        authority.leaseToken,
        timestamp,
        timestamp,
        input.handle,
      ],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function resolveSqliteMigrationInput(
  options: CloudflareProviderExecutorOptions,
  input: CloudflareProviderSqliteMigrationApplyInput,
): Promise<ProviderSqliteMigrationApplyInput | null> {
  try {
    const authority = input.executionAuthority;
    if (!authority || !options.migrationSql) return null;
    if (!sqliteProjectionIsExact(input)) return null;
    const desired: ProviderSqliteMigration[] = [];
    for (const identity of input.desired) {
      const sql = await options.migrationSql(authority.tenantId, identity.digest);
      if (!sql || (await bytesDigest(sql)) !== identity.digest) return null;
      desired.push({ ...identity, sql });
    }
    return {
      ...input,
      desired,
      migrations: desired.slice(input.expectedPrefix.length),
    };
  } catch {
    return null;
  }
}

async function authorizeSqliteMigration(
  options: CloudflareProviderExecutorOptions,
  input: ProviderSqliteMigrationApplyInput,
  timestamp: number,
): Promise<boolean> {
  try {
    const authority = input.executionAuthority;
    if (!authority || input.operationMode === undefined) return false;
    const digest = await sqliteMigrationIntentDigest(options, input);
    const commonParams = [
      input.operationId,
      authority.tenantId,
      authority.resourceUid,
      authority.fingerprint,
      authority.leaseToken,
      timestamp,
      timestamp,
      input.target.resourceUid,
      input.target.generation,
      input.target.incarnationId,
      options.providerInstallationId,
      input.nativeId,
    ] as const;
    const sagaPredicate = `saga.operation_id = ?
       AND saga.tenant_id = ?
       AND saga.resource_uid = ?
       AND saga.fingerprint = ?
       AND saga.phase = 'planned'
       AND saga.receipt_json IS NULL
       AND saga.execution_started_at IS NOT NULL
       AND saga.execution_lease_token = ?
       AND saga.execution_lease_until > ?
       AND saga.expires_at > ?
       AND saga.target_kind = 'SQLiteMigrationApplication'
       AND saga.provider_outcome ${input.operationMode === "initial" ? "= 'running'" : "IN ('running', 'indeterminate')"}
       AND (
         (
           saga.accepted_uid IS NULL
           AND saga.accepted_generation IS NULL
           AND saga.accepted_revision IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM tf_resources AS application
             WHERE application.tenant_id = saga.tenant_id
               AND (
                 (application.space = saga.target_space
                   AND application.api_version = saga.target_api_version
                   AND application.kind = saga.target_kind
                   AND application.name = saga.target_name)
                 OR application.uid = saga.resource_uid
               )
           )
         ) OR (
           saga.accepted_uid = saga.resource_uid
           AND saga.accepted_generation IS NOT NULL
           AND saga.accepted_revision IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM tf_resources AS application
             WHERE application.tenant_id = saga.tenant_id
               AND application.space = saga.target_space
               AND application.api_version = saga.target_api_version
               AND application.kind = saga.target_kind
               AND application.name = saga.target_name
               AND application.uid = saga.resource_uid
               AND application.generation = saga.accepted_generation
               AND application.revision = saga.accepted_revision
           )
         )
       )
       AND EXISTS (
         SELECT 1 FROM tf_resources AS database_resource
         WHERE database_resource.tenant_id = saga.tenant_id
           AND database_resource.uid = ?
           AND database_resource.generation = ?
           AND database_resource.kind = 'SQLiteDatabase'
       )
       AND EXISTS (
         SELECT 1 FROM tf_resource_deployments AS database_deployment
         WHERE database_deployment.tenant_id = saga.tenant_id
           AND database_deployment.id = ?
           AND database_deployment.resource_uid = ?
           AND database_deployment.provider_pack_ref = 'cloudflare'
           AND database_deployment.provider_installation_ref = ?
           AND database_deployment.native_id = ?
           AND database_deployment.state = 'active'
       )`;
    // The deployment predicate names the target resource a second time.
    const params = [
      ...commonParams.slice(0, 10),
      input.target.resourceUid,
      ...commonParams.slice(10),
    ];
    if (input.operationMode === "initial") {
      const claimed = await options.sql.run(
        `INSERT OR IGNORE INTO tf_cloudflare_provider_executor_operations
           (operation_id, tenant_id, resource_uid, host_fingerprint,
            mutation_kind, logical_intent_digest, created_at)
         SELECT ?, ?, ?, ?, 'sqlite-migration', ?, ?
         FROM tf_provider_mutation_sagas AS saga
         WHERE ${sagaPredicate}`,
        [
          input.operationId,
          authority.tenantId,
          authority.resourceUid,
          authority.fingerprint,
          digest,
          timestamp,
          ...params,
        ],
      );
      return claimed.changes === 1;
    }
    const rows = await options.sql.query(
      `SELECT 1 AS authorized
       FROM tf_provider_mutation_sagas AS saga
       INNER JOIN tf_cloudflare_provider_executor_operations AS claim
         ON claim.operation_id = saga.operation_id
       WHERE ${sagaPredicate}
         AND claim.tenant_id = saga.tenant_id
         AND claim.resource_uid = saga.resource_uid
         AND claim.host_fingerprint = saga.fingerprint
         AND claim.mutation_kind = 'sqlite-migration'
         AND claim.logical_intent_digest = ?
       LIMIT 2`,
      [...params, digest],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function logicalMutationDigest(
  options: CloudflareProviderExecutorOptions,
  mutationKind: "apply" | "delete" | "adopt",
  input: ApplyInput | CloudflareProviderDeleteInput | CloudflareProviderAdoptInput,
): Promise<`sha256:${string}`> {
  const command = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        key !== "operationId" &&
        key !== "operationMode" &&
        key !== "providerHandle" &&
        key !== "executionAuthority",
    ),
  );
  return await canonicalDigest({
    schema: EXECUTOR_INTENT_SCHEMA,
    mutationKind,
    providerInstallationId: options.providerInstallationId,
    command,
  });
}

async function authorizeMeterRead(
  options: CloudflareProviderExecutorOptions,
  input: CloudflareProviderMeterReadInput,
): Promise<boolean> {
  try {
    const createdAt = Date.parse(input.deployment.createdAt);
    if (
      !Number.isSafeInteger(createdAt) ||
      new Date(createdAt).toISOString() !== input.deployment.createdAt ||
      input.tenantId !== input.deployment.tenantId ||
      input.deployment.providerPackRef !== "cloudflare" ||
      input.deployment.providerInstallationRef !== options.providerInstallationId ||
      input.deployment.offeringId !== input.offering.id
    ) {
      return false;
    }
    const rows = await options.sql.query(
      `SELECT 1 AS authorized
       FROM tf_resources AS resource
       INNER JOIN tf_resource_deployments AS deployment
         ON deployment.tenant_id = resource.tenant_id
        AND deployment.resource_uid = resource.uid
       WHERE resource.tenant_id = ?
         AND resource.uid = ?
         AND resource.api_version = ?
         AND resource.kind = ?
         AND deployment.id = ?
         AND deployment.offering_id = ?
         AND deployment.provider_pack_ref = 'cloudflare'
         AND deployment.provider_installation_ref = ?
         AND deployment.native_id = ?
         AND deployment.created_at = ?
         AND deployment.state = 'active'
       LIMIT 2`,
      [
        input.tenantId,
        input.deployment.resourceUid,
        input.offering.form.apiVersion,
        input.offering.form.kind,
        input.deployment.id,
        input.offering.id,
        options.providerInstallationId,
        input.deployment.nativeId,
        createdAt,
      ],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}

async function sqliteMigrationIntentDigest(
  options: CloudflareProviderExecutorOptions,
  input: ProviderSqliteMigrationApplyInput,
): Promise<`sha256:${string}`> {
  const authority = input.executionAuthority;
  if (!authority) throw new TypeError("missing SQLite execution authority");
  return await canonicalDigest({
    schema: EXECUTOR_INTENT_SCHEMA,
    mutationKind: "sqlite-migration",
    tenantId: authority.tenantId,
    applicationResourceUid: authority.resourceUid,
    providerInstallationId: options.providerInstallationId,
    database: {
      resourceUid: input.target.resourceUid,
      incarnationId: input.target.incarnationId,
      generation: input.target.generation,
      nativeId: input.nativeId,
    },
    desired: await Promise.all(
      input.desired.map(async (migration) => ({
        path: migration.path,
        digest: migration.digest,
        sqlDigest: await bytesDigest(migration.sql),
      })),
    ),
  });
}

function sqliteProjectionIsExact(input: CloudflareProviderSqliteMigrationApplyInput): boolean {
  if (
    input.expectedPrefix.length > input.desired.length ||
    input.migrations.length !== input.desired.length - input.expectedPrefix.length
  ) {
    return false;
  }
  return (
    input.expectedPrefix.every((migration, index) =>
      sameMigrationIdentity(migration, input.desired[index]),
    ) &&
    input.migrations.every((migration, index) =>
      sameMigrationIdentity(migration, input.desired[input.expectedPrefix.length + index]),
    )
  );
}

function sameMigrationIdentity(
  left: ProviderSqliteMigrationIdentity,
  right: ProviderSqliteMigrationIdentity | undefined,
): boolean {
  return !!right && left.path === right.path && left.digest === right.digest;
}

function providerOwnsOffering(provider: Provider, offering: ProviderOffering): boolean {
  const expected = canonicalJson(offering);
  return [...provider.offerings, ...(provider.recoveryOfferings ?? [])].some(
    (candidate) => canonicalJson(candidate) === expected,
  );
}

function providerOwnsCurrentOffering(provider: Provider, offering: ProviderOffering): boolean {
  const expected = canonicalJson(offering);
  return provider.offerings.some((candidate) => canonicalJson(candidate) === expected);
}

function objectBucketOffering(offering: ProviderOffering): boolean {
  return offering.form.kind === "ObjectBucket" || offering.kind === "object_bucket";
}

function configuredMeterSources(sources: readonly MeterSource[]): ReadonlyMap<string, MeterSource> {
  const result = new Map<string, MeterSource>();
  for (const source of sources) {
    const expected = [
      "ModuleWorker",
      "EdgeKVNamespace",
      "SQLiteDatabase",
      "AtLeastOnceQueue",
      "ObjectBucket",
    ]
      .map(cloudflareProviderMeterSourceForOfferingKind)
      .find((candidate) => candidate?.id === source.id);
    if (
      !expected ||
      result.has(source.id) ||
      !sameMeterSourceDescriptor(source, expected) ||
      typeof source.read !== "function"
    ) {
      throw new TypeError("invalid Cloudflare provider executor MeterSource configuration");
    }
    result.set(source.id, source);
  }
  return result;
}

function meterSourceMatchesOffering(source: MeterSource, offering: ProviderOffering): boolean {
  const expected = cloudflareProviderMeterSourceForOfferingKind(offering.form.kind);
  return !!expected && sameMeterSourceDescriptor(source, expected);
}

function sameMeterSourceDescriptor(
  source: CloudflareProviderMeterSourceDescriptor,
  expected: CloudflareProviderMeterSourceDescriptor,
): boolean {
  return (
    source.id === expected.id &&
    sameStrings(source.meters, expected.meters) &&
    source.settlementDelaySeconds === expected.settlementDelaySeconds &&
    source.maximumWindowSeconds === expected.maximumWindowSeconds &&
    source.retentionSeconds === expected.retentionSeconds &&
    source.windowAlignment === expected.windowAlignment
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validMeterUsage(
  value: unknown,
  allowed: readonly string[],
): value is ProviderMeterUsage[] {
  if (!Array.isArray(value) || value.length > allowed.length) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    const raw = maybeExactRecord(item, ["meter", "quantity"]);
    if (
      !raw ||
      typeof raw.meter !== "string" ||
      !allowed.includes(raw.meter) ||
      seen.has(raw.meter) ||
      typeof raw.quantity !== "number" ||
      !Number.isFinite(raw.quantity) ||
      raw.quantity < 0
    ) {
      return false;
    }
    seen.add(raw.meter);
    return true;
  });
}

function parseApplyInput(value: unknown): ApplyInput {
  const raw = exactRecord(
    value,
    ["operationId", "offering", "identity", "spec"],
    [
      "operationKey",
      "operationMode",
      "providerHandle",
      "executionAuthority",
      "previous",
      "relations",
      "runtimeBindings",
      "workerEndpointOriginAssignment",
      "publicApply",
    ],
  );
  if (
    !boundedString(raw.operationId, 3, 128) ||
    (raw.operationKey !== undefined && !boundedString(raw.operationKey, 1, 1_024)) ||
    (raw.operationMode !== undefined &&
      raw.operationMode !== "initial" &&
      raw.operationMode !== "recovery") ||
    (raw.providerHandle !== undefined && !boundedString(raw.providerHandle, 1, 4_096)) ||
    (raw.executionAuthority !== undefined && !executionAuthority(raw.executionAuthority)) ||
    !providerOffering(raw.offering) ||
    !resourceIdentity(raw.identity) ||
    !jsonObject(raw.spec) ||
    (raw.previous !== undefined && !previousApply(raw.previous)) ||
    (raw.relations !== undefined && !providerRelations(raw.relations)) ||
    (raw.runtimeBindings !== undefined && !runtimeBindings(raw.runtimeBindings)) ||
    (raw.workerEndpointOriginAssignment !== undefined &&
      !endpointOriginAssignment(raw.workerEndpointOriginAssignment)) ||
    (raw.publicApply !== undefined && !publicApply(raw.publicApply))
  ) {
    invalidRpcInput();
  }
  return value as ApplyInput;
}

function parseObserveInput(value: unknown): CloudflareProviderObserveInput {
  const raw = exactRecord(value, ["offering", "nativeId", "identity", "spec"], ["relations"]);
  if (
    !providerOffering(raw.offering) ||
    !boundedString(raw.nativeId, 1, 4_096) ||
    !requiredResourceIdentity(raw.identity) ||
    !jsonObject(raw.spec) ||
    (raw.relations !== undefined && !providerRelations(raw.relations))
  ) {
    invalidRpcInput();
  }
  return value as CloudflareProviderObserveInput;
}

function parseDeleteInput(value: unknown): CloudflareProviderDeleteInput {
  const raw = exactRecord(
    value,
    ["operationId", "offering", "nativeId", "identity"],
    ["operationMode", "providerHandle", "executionAuthority", "spec", "relations"],
  );
  if (
    !boundedString(raw.operationId, 3, 128) ||
    (raw.operationMode !== undefined &&
      raw.operationMode !== "initial" &&
      raw.operationMode !== "recovery") ||
    (raw.providerHandle !== undefined && !boundedString(raw.providerHandle, 1, 4_096)) ||
    (raw.executionAuthority !== undefined && !executionAuthority(raw.executionAuthority)) ||
    !providerOffering(raw.offering) ||
    !boundedString(raw.nativeId, 1, 4_096) ||
    !resourceIdentity(raw.identity) ||
    (raw.spec !== undefined && !jsonObject(raw.spec)) ||
    (raw.relations !== undefined && !providerRelations(raw.relations))
  ) {
    invalidRpcInput();
  }
  return value as CloudflareProviderDeleteInput;
}

function parseAdoptInput(value: unknown): CloudflareProviderAdoptInput {
  const raw = exactRecord(
    value,
    ["operationId", "offering", "nativeId", "identity", "spec"],
    ["operationMode", "providerHandle", "executionAuthority", "relations"],
  );
  if (
    !boundedString(raw.operationId, 3, 128) ||
    (raw.operationMode !== undefined &&
      raw.operationMode !== "initial" &&
      raw.operationMode !== "recovery") ||
    (raw.providerHandle !== undefined && !boundedString(raw.providerHandle, 1, 4_096)) ||
    (raw.executionAuthority !== undefined && !executionAuthority(raw.executionAuthority)) ||
    !providerOffering(raw.offering) ||
    !boundedString(raw.nativeId, 1, 4_096) ||
    !resourceIdentity(raw.identity) ||
    !jsonObject(raw.spec) ||
    (raw.relations !== undefined && !providerRelations(raw.relations))
  ) {
    invalidRpcInput();
  }
  return value as CloudflareProviderAdoptInput;
}

function parsePollInput(value: unknown): CloudflareProviderPollInput {
  const raw = exactRecord(value, ["operationId", "handle"], ["executionAuthority"]);
  if (
    !boundedString(raw.operationId, 3, 128) ||
    !boundedString(raw.handle, 1, 4_096) ||
    (raw.executionAuthority !== undefined && !executionAuthority(raw.executionAuthority))
  ) {
    invalidRpcInput();
  }
  return value as CloudflareProviderPollInput;
}

function parseVerifyNativeAbsenceInput(value: unknown): CloudflareProviderVerifyNativeAbsenceInput {
  const raw = exactRecord(value, ["offering", "descriptor", "target"]);
  const descriptor = exactRecord(raw.descriptor, [
    "apiVersion",
    "provider",
    "kind",
    "nativeId",
    "data",
  ]);
  if (
    !providerOffering(raw.offering) ||
    descriptor.apiVersion !== "providers.takoserver.com/readback/v1" ||
    !boundedString(descriptor.provider, 1, 128) ||
    !boundedString(descriptor.kind, 1, 128) ||
    !boundedString(descriptor.nativeId, 1, 4_096) ||
    !jsonObject(descriptor.data) ||
    !readAuthorityTarget(raw.target)
  ) {
    invalidRpcInput();
  }
  return value as CloudflareProviderVerifyNativeAbsenceInput;
}

function parseVerifyArtifactConsumptionInput(
  value: unknown,
): CloudflareProviderVerifyArtifactConsumptionInput {
  const raw = exactRecord(
    value,
    ["offering", "nativeId", "target", "identity", "candidateManifestDigests"],
    ["currentResource"],
  );
  const identity = maybeExactRecord(raw.identity, ["tenantRef", "resourceUid"], ["address"]);
  const address = identity?.address;
  const parsedAddress =
    address === undefined ? undefined : maybeExactRecord(address, ["space", "name"]);
  const current =
    raw.currentResource === undefined
      ? undefined
      : maybeExactRecord(raw.currentResource, [
          "revision",
          "relationsDigest",
          "providerOperationIds",
        ]);
  if (
    !providerOffering(raw.offering) ||
    !boundedString(raw.nativeId, 1, 4_096) ||
    !artifactReadAuthorityTarget(raw.target) ||
    !identity ||
    !boundedString(identity.tenantRef, 1, 255) ||
    !boundedString(identity.resourceUid, 3, 128) ||
    (address !== undefined &&
      (!parsedAddress ||
        !boundedString(parsedAddress.space, 1, 255) ||
        !boundedString(parsedAddress.name, 1, 255))) ||
    !digestArray(raw.candidateManifestDigests, 16_384) ||
    (raw.currentResource !== undefined &&
      (!current ||
        !boundedString(current.revision, 1, 255) ||
        !digest(current.relationsDigest) ||
        !stringArray(current.providerOperationIds, 0, 16_384)))
  ) {
    invalidRpcInput();
  }
  return value as CloudflareProviderVerifyArtifactConsumptionInput;
}

function parseSqliteReadInput(value: unknown): CloudflareProviderSqliteMigrationReadInput {
  const raw = exactRecord(value, ["nativeId", "target"]);
  if (!boundedString(raw.nativeId, 1, 4_096) || !sqliteMigrationReadTarget(raw.target)) {
    invalidRpcInput();
  }
  return value as CloudflareProviderSqliteMigrationReadInput;
}

function parseSqliteApplyInput(value: unknown): CloudflareProviderSqliteMigrationApplyInput {
  const raw = exactRecord(
    value,
    [
      "operationId",
      "operationMode",
      "nativeId",
      "target",
      "desired",
      "expectedPrefix",
      "migrations",
    ],
    ["executionAuthority"],
  );
  if (
    !boundedString(raw.operationId, 3, 128) ||
    (raw.operationMode !== "initial" && raw.operationMode !== "recovery") ||
    (raw.executionAuthority !== undefined && !executionAuthority(raw.executionAuthority)) ||
    !boundedString(raw.nativeId, 1, 4_096) ||
    !sqliteMigrationTarget(raw.target) ||
    !migrationIdentities(raw.desired, false) ||
    !migrationIdentities(raw.expectedPrefix, true) ||
    !migrationIdentities(raw.migrations, false)
  ) {
    invalidRpcInput();
  }
  return value as CloudflareProviderSqliteMigrationApplyInput;
}

function parseMeterReadInput(value: unknown): CloudflareProviderMeterReadInput {
  const raw = exactRecord(value, [
    "meterSourceId",
    "meters",
    "offering",
    "tenantId",
    "deployment",
    "from",
    "until",
  ]);
  if (
    !boundedString(raw.meterSourceId, 1, 255) ||
    !stringArray(raw.meters, 1, 32) ||
    !providerOffering(raw.offering) ||
    !boundedString(raw.tenantId, 1, 255) ||
    !meterDeployment(raw.deployment) ||
    !boundedString(raw.from, 20, 64) ||
    !boundedString(raw.until, 20, 64)
  ) {
    invalidRpcInput();
  }
  return value as CloudflareProviderMeterReadInput;
}

function providerOffering(value: unknown): value is ProviderOffering {
  const raw = maybeExactRecord(
    value,
    ["id", "kind", "displayName", "form", "providedInterfaces", "bindingRefs", "capabilities"],
    ["regions"],
  );
  if (
    !raw ||
    !boundedString(raw.id, 1, 255) ||
    !boundedString(raw.kind, 1, 255) ||
    !boundedString(raw.displayName, 1, 255)
  ) {
    return false;
  }
  const form = maybeExactRecord(raw.form, [
    "apiVersion",
    "kind",
    "definitionVersion",
    "schemaDigest",
  ]);
  if (
    !form ||
    !boundedString(form.apiVersion, 1, 255) ||
    !boundedString(form.kind, 1, 128) ||
    !boundedString(form.definitionVersion, 1, 128) ||
    !digest(form.schemaDigest)
  ) {
    return false;
  }
  return (
    refArray(raw.providedInterfaces, "interfaces.takoform.com/v1alpha1") &&
    bindingRefArray(raw.bindingRefs) &&
    stringArray(raw.capabilities, 0, 5, ["create", "update", "delete", "import", "observe"]) &&
    (raw.regions === undefined || stringArray(raw.regions, 1, 128))
  );
}

function resourceIdentity(value: unknown): value is ResourceIdentity {
  const raw = maybeExactRecord(
    value,
    ["tenantRef", "space", "name"],
    ["uid", "incarnationId", "generation"],
  );
  return !!raw && Object.values(raw).every((item) => boundedString(item, 1, 255));
}

function requiredResourceIdentity(value: unknown): value is ResourceIdentity & {
  readonly uid: string;
  readonly incarnationId: string;
  readonly generation: string;
} {
  const raw = maybeExactRecord(value, [
    "tenantRef",
    "space",
    "name",
    "uid",
    "incarnationId",
    "generation",
  ]);
  return !!raw && Object.values(raw).every((item) => boundedString(item, 1, 255));
}

function previousApply(value: unknown): boolean {
  const raw = maybeExactRecord(value, ["nativeId", "spec"]);
  return !!raw && boundedString(raw.nativeId, 1, 4_096) && jsonObject(raw.spec);
}

function providerRelations(value: unknown): value is readonly ProviderRelation[] {
  return Array.isArray(value) && value.length <= 256 && value.every(providerRelation);
}

function providerRelation(value: unknown): boolean {
  const raw = maybeExactRecord(
    value,
    ["pointer", "relation", "targetUid", "resource"],
    ["bindingRef", "deployment"],
  );
  if (
    !raw ||
    !boundedString(raw.pointer, 1, 1_024) ||
    !boundedString(raw.relation, 1, 255) ||
    !boundedString(raw.targetUid, 1, 128) ||
    (raw.bindingRef !== undefined && !bindingRef(raw.bindingRef))
  ) {
    return false;
  }
  const resource = maybeExactRecord(raw.resource, [
    "apiVersion",
    "kind",
    "form",
    "metadata",
    "spec",
  ]);
  const form = maybeExactRecord(resource?.form, ["formRef"]);
  const metadata = maybeExactRecord(resource?.metadata, [
    "name",
    "space",
    "uid",
    "generation",
    "revision",
  ]);
  if (
    !resource ||
    !form ||
    !providerFormRef(form.formRef) ||
    !metadata ||
    !boundedString(resource.apiVersion, 1, 255) ||
    !boundedString(resource.kind, 1, 128) ||
    !Object.values(metadata).every((item) => boundedString(item, 1, 255)) ||
    !jsonObject(resource.spec)
  ) {
    return false;
  }
  if (raw.deployment === undefined) return true;
  const deployment = maybeExactRecord(raw.deployment, [
    "tenantId",
    "id",
    "resourceUid",
    "offeringId",
    "providerPackRef",
    "providerInstallationRef",
    "nativeId",
    "state",
    "observed",
    "outputs",
    "createdAt",
    "updatedAt",
  ]);
  return (
    !!deployment &&
    [
      "tenantId",
      "id",
      "resourceUid",
      "offeringId",
      "providerPackRef",
      "providerInstallationRef",
      "nativeId",
      "createdAt",
      "updatedAt",
    ].every((key) => boundedString(deployment[key], 1, 4_096)) &&
    typeof deployment.state === "string" &&
    ["provisioning", "candidate", "active", "draining", "retained", "failed", "deleted"].includes(
      deployment.state,
    ) &&
    jsonObject(deployment.observed) &&
    jsonObject(deployment.outputs)
  );
}

function runtimeBindings(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => {
      const raw = maybeExactRecord(item, ["name", "targetUid", "bindingRef", "material"]);
      return (
        !!raw &&
        boundedString(raw.name, 1, 128) &&
        boundedString(raw.targetUid, 1, 128) &&
        bindingRef(raw.bindingRef) &&
        cloudflareR2EdgeObjectsMaterial(raw.material) !== null
      );
    })
  );
}

function endpointOriginAssignment(value: unknown): boolean {
  const raw = maybeExactRecord(value, ["canonicalPublicOrigin", "assignmentDigest"]);
  return (
    !!raw && boundedString(raw.canonicalPublicOrigin, 1, 2_048) && digest(raw.assignmentDigest)
  );
}

function publicApply(value: unknown): boolean {
  const raw = maybeExactRecord(value, ["method", "path", "ifNoneMatch", "body"]);
  return (
    !!raw &&
    boundedString(raw.method, 1, 16) &&
    boundedString(raw.path, 1, 4_096) &&
    boundedString(raw.ifNoneMatch, 1, 255) &&
    boundedString(raw.body, 2, 1_048_576)
  );
}

function migrationIdentities(value: unknown, emptyAllowed: boolean): boolean {
  return (
    Array.isArray(value) &&
    (emptyAllowed || value.length > 0) &&
    value.length <= 16_384 &&
    new Set(
      value.map((item) =>
        plainRecord(item) && typeof item.path === "string" ? item.path : Symbol("invalid"),
      ),
    ).size === value.length &&
    value.every((item) => {
      const raw = maybeExactRecord(item, ["path", "digest"]);
      return !!raw && migrationPath(raw.path) && digest(raw.digest);
    })
  );
}

function executionAuthority(value: unknown): value is ProviderExecutionAuthority {
  const raw = maybeExactRecord(value, ["tenantId", "resourceUid", "leaseToken", "fingerprint"]);
  return (
    !!raw &&
    boundedString(raw.tenantId, 1, 255) &&
    boundedString(raw.resourceUid, 3, 128) &&
    boundedString(raw.leaseToken, 3, 128) &&
    boundedString(raw.fingerprint, 2, 8_192)
  );
}

function sqliteMigrationTarget(value: unknown): boolean {
  const raw = maybeExactRecord(value, ["resourceUid", "incarnationId", "generation"]);
  return (
    !!raw &&
    boundedString(raw.resourceUid, 3, 128) &&
    boundedString(raw.incarnationId, 3, 128) &&
    boundedString(raw.generation, 1, 255)
  );
}

function sqliteMigrationReadTarget(value: unknown): boolean {
  return readAuthorityTarget(value);
}

function readAuthorityTarget(value: unknown): boolean {
  const raw = maybeExactRecord(value, ["tenantId", "resourceUid", "incarnationId", "generation"]);
  return (
    !!raw &&
    boundedString(raw.tenantId, 1, 255) &&
    boundedString(raw.resourceUid, 3, 128) &&
    boundedString(raw.incarnationId, 3, 128) &&
    boundedString(raw.generation, 1, 255)
  );
}

function artifactReadAuthorityTarget(value: unknown): boolean {
  const raw = maybeExactRecord(value, [
    "tenantId",
    "resourceUid",
    "incarnationId",
    "state",
    "updatedAt",
  ]);
  return (
    !!raw &&
    boundedString(raw.tenantId, 1, 255) &&
    boundedString(raw.resourceUid, 3, 128) &&
    boundedString(raw.incarnationId, 3, 128) &&
    (raw.state === "active" || raw.state === "retained") &&
    typeof raw.updatedAt === "number" &&
    Number.isSafeInteger(raw.updatedAt) &&
    raw.updatedAt >= 0
  );
}

function meterDeployment(value: unknown): value is ProviderMeterDeployment {
  const raw = maybeExactRecord(value, [
    "tenantId",
    "id",
    "resourceUid",
    "offeringId",
    "providerPackRef",
    "providerInstallationRef",
    "nativeId",
    "createdAt",
  ]);
  return (
    !!raw &&
    boundedString(raw.tenantId, 1, 255) &&
    boundedString(raw.id, 3, 128) &&
    boundedString(raw.resourceUid, 3, 128) &&
    boundedString(raw.offeringId, 1, 255) &&
    boundedString(raw.providerPackRef, 1, 255) &&
    boundedString(raw.providerInstallationRef, 1, 255) &&
    boundedString(raw.nativeId, 1, 4_096) &&
    boundedString(raw.createdAt, 20, 64)
  );
}

function providerFormRef(value: unknown): boolean {
  const raw = maybeExactRecord(value, ["apiVersion", "kind", "definitionVersion", "schemaDigest"]);
  return (
    !!raw &&
    boundedString(raw.apiVersion, 1, 255) &&
    boundedString(raw.kind, 1, 128) &&
    boundedString(raw.definitionVersion, 1, 128) &&
    digest(raw.schemaDigest)
  );
}

function refArray(value: unknown, apiVersion: string): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every((item) => {
      const raw = maybeExactRecord(item, ["apiVersion", "name", "version", "schemaDigest"]);
      return (
        !!raw &&
        raw.apiVersion === apiVersion &&
        boundedString(raw.name, 1, 255) &&
        boundedString(raw.version, 1, 128) &&
        digest(raw.schemaDigest)
      );
    })
  );
}

function bindingRefArray(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 128 && value.every(bindingRef);
}

function bindingRef(value: unknown): boolean {
  const raw = maybeExactRecord(value, ["apiVersion", "name", "version", "schemaDigest"]);
  return (
    !!raw &&
    (raw.apiVersion === "bindings.takoform.com/v1alpha1" ||
      raw.apiVersion === "bindings.takoform.com/v1alpha2") &&
    boundedString(raw.name, 1, 255) &&
    boundedString(raw.version, 1, 128) &&
    digest(raw.schemaDigest)
  );
}

function stringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  allowed?: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    new Set(value).size === value.length &&
    value.every(
      (item) => boundedString(item, 1, 255) && (allowed === undefined || allowed.includes(item)),
    )
  );
}

function digestArray(
  value: unknown,
  maximum: number,
  minimum = 0,
): value is readonly `sha256:${string}`[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every(digest) &&
    value.every((item, index) => {
      const previous = value[index - 1];
      return index === 0 || (typeof previous === "string" && previous < item);
    })
  );
}

export function isCloudflareProviderArtifactConsumption(
  value: unknown,
): value is ProviderArtifactConsumption {
  const raw = plainRecord(value) ? value : null;
  if (!raw || typeof raw.outcome !== "string") return false;
  if (raw.outcome === "absent") {
    const exact = maybeExactRecord(raw, ["outcome", "evidence"]);
    return !!exact && jsonObject(exact.evidence);
  }
  if (raw.outcome === "present") {
    if (raw.consumption === "none") {
      const exact = maybeExactRecord(raw, ["outcome", "consumption", "evidence"]);
      return !!exact && jsonObject(exact.evidence);
    }
    if (raw.consumption === "identified") {
      const exact = maybeExactRecord(raw, [
        "outcome",
        "consumption",
        "manifestDigests",
        "evidence",
      ]);
      return !!exact && digestArray(exact.manifestDigests, 16_384, 1) && jsonObject(exact.evidence);
    }
    return false;
  }
  if (raw.outcome === "unknown") {
    const exact = maybeExactRecord(raw, ["outcome", "reason", "retryable"]);
    return (
      !!exact &&
      (exact.reason === "transport" ||
        exact.reason === "malformed" ||
        exact.reason === "unsupported" ||
        exact.reason === "authority_unavailable") &&
      typeof exact.retryable === "boolean"
    );
  }
  return false;
}

function jsonObject(value: unknown): value is JsonObject {
  if (!jsonValue(value, 0) || Array.isArray(value) || value === null) return false;
  try {
    return JSON.stringify(value).length <= 1_048_576;
  } catch {
    return false;
  }
}

function jsonValue(value: unknown, depth: number): value is JsonValue {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length <= 10_000 && value.every((item) => jsonValue(item, depth + 1));
  }
  if (!plainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => key.length > 0 && key.length <= 1_024 && jsonValue(item, depth + 1),
  );
}

function migrationPath(value: unknown): value is string {
  return (
    boundedString(value, 1, 255) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = maybeExactRecord(value, required, optional);
  if (!record) invalidRpcInput();
  return record;
}

function maybeExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!plainRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return null;
  const names = keys as string[];
  const accepted = new Set([...required, ...optional]);
  if (
    names.length < required.length ||
    names.some((key) => !accepted.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    return null;
  }
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidRpcInput(): never {
  throw new TypeError("invalid Cloudflare provider executor RPC input");
}
