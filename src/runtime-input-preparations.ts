import type { Clock, Row, Sql } from "./ports.ts";
import {
  MAX_PROVIDER_RUNTIME_INPUT_BINDINGS,
  type ProviderRuntimeInputLeasePort,
  type ProviderRuntimeInputPreparationIdentity,
} from "./provider-runtime-input-port.ts";

export const RUNTIME_INPUT_PREPARATION_FORMAT =
  "takoserver.worker-runtime-input-preparation@v1" as const;

const SEALED_PAYLOAD_FORMAT = "takoserver.worker-runtime-input-sealed-payload@v1" as const;
const AAD_FORMAT = "takoserver.worker-runtime-input-aad@v1" as const;
const COMMITMENT_FORMAT = "takoserver.worker-runtime-input-commitment@v1" as const;
const RUNTIME_INPUT_REFERENCE_PREFIX = "rip1";
const PREPARATION_TTL_MILLISECONDS = 60 * 60 * 1_000;
const CLAIM_TTL_MILLISECONDS = 15 * 60 * 1_000;
const MAX_VALUE_BYTES = 32 * 1_024;
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const bindingName = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;

export interface RuntimeInputSealKey {
  readonly keyId: string;
  readonly key: CryptoKey;
}

export interface RuntimeInputPreparationTarget {
  readonly space: string;
  readonly workerName: string;
  readonly workerResourceUid: string;
  readonly bundleName: string;
  readonly originResourceUid: string;
}

export interface RuntimeInputPreparationInput {
  readonly organizationId: string;
  readonly operationId: string;
  readonly materialSetId: string;
  readonly target: RuntimeInputPreparationTarget;
  readonly canonicalPublicOrigin: string;
  readonly bindings: Readonly<Record<string, string>>;
}

export interface RuntimeInputPreparationProjection {
  readonly format: typeof RUNTIME_INPUT_PREPARATION_FORMAT;
  readonly operationId: string;
  readonly preparationId: string;
  /** Opaque value the caller must reuse as the exact Host mutation idempotency key. */
  readonly runtimeInputReference: string;
  readonly status:
    | "prepared"
    | "claimed"
    | "dispatched"
    | "consumed"
    | "revoked"
    | "expired"
    | "indeterminate";
  readonly expiresAt: string;
  readonly target: RuntimeInputPreparationTarget;
  readonly canonicalPublicOrigin: string;
  readonly bindingNames: readonly string[];
}

export interface RuntimeInputClaimInput {
  readonly organizationId: string;
  readonly preparationId: string;
  readonly preparationCommitment: `sha256:${string}`;
  readonly claimOwner: string;
  readonly resourceUid: string;
  readonly target: Pick<
    RuntimeInputPreparationTarget,
    "space" | "workerName" | "workerResourceUid" | "bundleName"
  >;
  readonly bindingNames: readonly string[];
}

/** Independent lookup of the Resource that owns one canonical public origin. */
export interface RuntimeInputOriginAuthority {
  resolve(input: {
    readonly organizationId: string;
    readonly resourceUid: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  }): Promise<{
    readonly canonicalPublicOrigin: string;
    /** Exact Resource representation revision read with the validated origin and relations. */
    readonly resourceRevision: string;
  } | null>;
}

export interface RuntimeInputClaim {
  readonly operationId: string;
  readonly preparationId: string;
  readonly preparationCommitment: `sha256:${string}`;
  readonly fence: number;
  readonly materialSetId: string;
  readonly canonicalPublicOrigin: string;
  readonly originResourceUid: string;
  readonly workerResourceUid: string;
  readonly bindings: Readonly<Record<string, string>>;
}

export type RuntimeInputRecoveryIdentity = Omit<RuntimeInputClaim, "bindings">;

export interface RuntimeInputClaimIdentity {
  readonly organizationId: string;
  readonly preparationId: string;
  readonly claimOwner: string;
  readonly resourceUid: string;
  readonly fence: number;
}

export interface RuntimeInputDispatchIdentity extends RuntimeInputClaimIdentity {
  /** Revision returned by the final origin read and fenced by the dispatch CAS. */
  readonly originResourceRevision: string;
}

export interface RuntimeInputConsumption extends RuntimeInputClaimIdentity {
  readonly receiptDigest: `sha256:${string}`;
}

export interface RuntimeInputRecoveredConsumption {
  readonly organizationId: string;
  readonly preparationId: string;
  readonly preparationCommitment: `sha256:${string}`;
  readonly claimOwner: string;
  readonly resourceUid: string;
  readonly target: Pick<
    RuntimeInputPreparationTarget,
    "space" | "workerName" | "workerResourceUid" | "bundleName"
  >;
  readonly bindingNames: readonly string[];
  readonly receiptDigest: `sha256:${string}`;
}

export class RuntimeInputPreparationError extends Error {
  constructor(
    readonly code: "invalid_argument" | "conflict" | "not_found" | "unavailable",
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = "RuntimeInputPreparationError";
  }
}

export interface RuntimeInputPreparations {
  prepare(input: RuntimeInputPreparationInput): Promise<RuntimeInputPreparationProjection>;
  read(
    organizationId: string,
    operationId: string,
  ): Promise<RuntimeInputPreparationProjection | null>;
  claim(input: RuntimeInputClaimInput): Promise<RuntimeInputClaim>;
  /** Value-free exact-reference validation performed before an external authority lookup. */
  inspect(input: RuntimeInputClaimInput): Promise<RuntimeInputRecoveryIdentity>;
  abort(input: RuntimeInputClaimIdentity): Promise<void>;
  dispatch(input: RuntimeInputDispatchIdentity): Promise<{ readonly fence: number }>;
  consume(input: RuntimeInputConsumption): Promise<void>;
  /** Reads only the value-free identity of one exact dispatched handoff. */
  recover(
    input: Omit<RuntimeInputRecoveredConsumption, "receiptDigest">,
  ): Promise<RuntimeInputRecoveryIdentity>;
  /** Settles the one dispatched handoff after provider acknowledgement recovery. */
  consumeRecovered(input: RuntimeInputRecoveredConsumption): Promise<void>;
  revoke(organizationId: string, operationId: string): Promise<void>;
  expireDue(limit: number): Promise<number>;
}

export interface RuntimeInputAuthority {
  /** Closed control-plane surface used only by authenticated HTTP routes. */
  readonly preparations: Pick<RuntimeInputPreparations, "prepare" | "read" | "revoke">;
  /** Provider-neutral one-shot lease seam used by concrete provider adapters. */
  readonly leases: ProviderRuntimeInputLeasePort;
  /** Bounded lifecycle cleanup composed into the product scheduler. */
  readonly maintenance: {
    expireDue(limit: number): Promise<number>;
  };
}

export function createRuntimeInputAuthority(
  options: Parameters<typeof createRuntimeInputPreparations>[0] & {
    readonly origins: RuntimeInputOriginAuthority;
  },
): RuntimeInputAuthority {
  const internals = createRuntimeInputPreparations(options);
  const assertOrigin = async (
    organizationId: string,
    target: Pick<
      RuntimeInputPreparationTarget,
      "space" | "workerName" | "workerResourceUid" | "originResourceUid"
    >,
    canonicalPublicOrigin: string,
  ): Promise<NonNullable<Awaited<ReturnType<RuntimeInputOriginAuthority["resolve"]>>>> => {
    let realized: Awaited<ReturnType<RuntimeInputOriginAuthority["resolve"]>>;
    try {
      realized = await options.origins.resolve({
        organizationId,
        resourceUid: target.originResourceUid,
        space: target.space,
        workerName: target.workerName,
        workerResourceUid: target.workerResourceUid,
      });
    } catch (error) {
      if (error instanceof RuntimeInputPreparationError) throw error;
      throw new RuntimeInputPreparationError("unavailable", 503);
    }
    if (!realized || realized.canonicalPublicOrigin !== canonicalPublicOrigin) {
      throw new RuntimeInputPreparationError("conflict", 409);
    }
    return realized;
  };
  const inspect = async (
    input: Parameters<RuntimeInputPreparations["inspect"]>[0],
  ): Promise<RuntimeInputRecoveryIdentity> => {
    const inspected = await internals.inspect(input);
    await assertOrigin(
      input.organizationId,
      {
        space: input.target.space,
        workerName: input.target.workerName,
        workerResourceUid: inspected.workerResourceUid,
        originResourceUid: inspected.originResourceUid,
      },
      inspected.canonicalPublicOrigin,
    );
    return inspected;
  };
  return {
    preparations: {
      prepare: async (input) => {
        await assertOrigin(input.organizationId, input.target, input.canonicalPublicOrigin);
        return await internals.prepare(input);
      },
      read: (organizationId, operationId) => internals.read(organizationId, operationId),
      revoke: (organizationId, operationId) => internals.revoke(organizationId, operationId),
    },
    leases: {
      async acquire(input) {
        const reference = runtimeInputReference(input.reference);
        const claimInput = {
          organizationId: input.organizationId,
          preparationId: reference.preparationId,
          preparationCommitment: reference.commitment,
          claimOwner: input.operationId,
          resourceUid: input.resourceUid,
          target: input.target,
          bindingNames: input.bindingNames,
        };
        await inspect(claimInput);
        const claim = await internals.claim(claimInput);
        const preparation = preparationIdentity(claim);
        return {
          bindings: claim.bindings,
          preparation,
          abort: async () =>
            await internals.abort({
              organizationId: input.organizationId,
              preparationId: claim.preparationId,
              claimOwner: input.operationId,
              resourceUid: input.resourceUid,
              fence: claim.fence,
            }),
          async dispatch() {
            const origin = await assertOrigin(
              input.organizationId,
              {
                space: input.target.space,
                workerName: input.target.workerName,
                workerResourceUid: claim.workerResourceUid,
                originResourceUid: claim.originResourceUid,
              },
              claim.canonicalPublicOrigin,
            );
            const dispatched = await internals.dispatch({
              organizationId: input.organizationId,
              preparationId: claim.preparationId,
              claimOwner: input.operationId,
              resourceUid: input.resourceUid,
              fence: claim.fence,
              originResourceRevision: origin.resourceRevision,
            });
            return {
              settle: async (providerReceiptDigest) =>
                await internals.consume({
                  organizationId: input.organizationId,
                  preparationId: claim.preparationId,
                  claimOwner: input.operationId,
                  resourceUid: input.resourceUid,
                  fence: dispatched.fence,
                  receiptDigest: await runtimeInputReceiptDigest({
                    preparation,
                    organizationId: input.organizationId,
                    operationId: input.operationId,
                    resourceUid: input.resourceUid,
                    providerReceiptDigest,
                  }),
                }),
            };
          },
        };
      },
      async recover(input) {
        const reference = runtimeInputReference(input.reference);
        const recoveryInput = {
          organizationId: input.organizationId,
          preparationId: reference.preparationId,
          preparationCommitment: reference.commitment,
          claimOwner: input.operationId,
          resourceUid: input.resourceUid,
          target: input.target,
          bindingNames: input.bindingNames,
        };
        await internals.inspect(recoveryInput);
        const recovered = await internals.recover(recoveryInput);
        if (recovered.preparationCommitment !== reference.commitment) {
          throw new RuntimeInputPreparationError("conflict", 409);
        }
        return {
          preparation: preparationIdentity(recovered),
          bindingNames: [...input.bindingNames].sort(),
          settle: async (providerReceiptDigest) =>
            await internals.consumeRecovered({
              organizationId: input.organizationId,
              preparationId: reference.preparationId,
              preparationCommitment: reference.commitment,
              claimOwner: input.operationId,
              resourceUid: input.resourceUid,
              target: input.target,
              bindingNames: input.bindingNames,
              receiptDigest: await runtimeInputReceiptDigest({
                preparation: preparationIdentity(recovered),
                organizationId: input.organizationId,
                operationId: input.operationId,
                resourceUid: input.resourceUid,
                providerReceiptDigest,
              }),
            }),
        };
      },
    },
    maintenance: {
      expireDue: (limit) => internals.expireDue(limit),
    },
  };
}

export function createRuntimeInputPreparations(options: {
  readonly sql: Sql;
  readonly sealKeys: {
    readonly current: RuntimeInputSealKey;
    readonly previous?: readonly RuntimeInputSealKey[];
  };
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly randomBytes?: (length: number) => Uint8Array;
}): RuntimeInputPreparations {
  const keys = new Map<string, CryptoKey>();
  for (const candidate of [options.sealKeys.current, ...(options.sealKeys.previous ?? [])]) {
    validateSealKey(candidate);
    if (keys.has(candidate.keyId)) throw new TypeError("runtime input seal key ids must be unique");
    keys.set(candidate.keyId, candidate.key);
  }
  const randomBytes =
    options.randomBytes ??
    ((length: number) => {
      const value = new Uint8Array(length);
      crypto.getRandomValues(value);
      return value;
    });

  return {
    async prepare(input) {
      const normalized = normalizeInput(input);
      const existing = await readRow(
        options.sql,
        normalized.organizationId,
        normalized.operationId,
      );
      if (existing) return await adoptExisting(existing, normalized, keys, options.clock);

      const preparationId = validateGeneratedId(options.randomId());
      const preparationCommitment = await computePreparationCommitment(normalized, preparationId);
      const createdAt = options.clock().getTime();
      const expiresAt = createdAt + PREPARATION_TTL_MILLISECONDS;
      const key = options.sealKeys.current;
      const nonce = Uint8Array.from(randomBytes(12));
      if (nonce.byteLength !== 12)
        throw new TypeError("runtime input nonce source must return 12 bytes");
      const plaintext = canonicalSealedPayload(normalized);
      const aad = canonicalAad(normalized, preparationId, key.keyId);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: encode(aad), tagLength: 128 },
        key.key,
        encode(plaintext),
      );

      try {
        const inserted = await options.sql.run(
          `INSERT INTO worker_runtime_input_preparations
             (organization_id, operation_id, preparation_id, preparation_commitment, material_set_id,
              space, worker_name, worker_resource_uid, bundle_name, origin_resource_uid,
              canonical_public_origin, binding_names_json,
              sealed_payload, seal_nonce, seal_key_id,
              state, fence, claim_owner, claim_expires_at,
              claimed_resource_uid, dispatched_operation_id, consumed_receipt_digest,
              expires_at, created_at, updated_at, consumed_at, revoked_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  'prepared', 1, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL
           WHERE EXISTS (
             SELECT 1 FROM tf_resource_deletion_attestations
             WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
           )`,
          [
            normalized.organizationId,
            normalized.operationId,
            preparationId,
            preparationCommitment,
            normalized.materialSetId,
            normalized.target.space,
            normalized.target.workerName,
            normalized.target.workerResourceUid,
            normalized.target.bundleName,
            normalized.target.originResourceUid,
            normalized.canonicalPublicOrigin,
            JSON.stringify(normalized.bindingNames),
            base64Url(new Uint8Array(ciphertext)),
            base64Url(nonce),
            key.keyId,
            expiresAt,
            createdAt,
            createdAt,
            normalized.organizationId,
            normalized.target.originResourceUid,
          ],
        );
        if (inserted.changes !== 1) {
          throw new RuntimeInputPreparationError("conflict", 409);
        }
      } catch {
        const raced = await readRow(options.sql, normalized.organizationId, normalized.operationId);
        if (raced) return await adoptExisting(raced, normalized, keys, options.clock);
        const origin = await originLifecycleState(
          options.sql,
          normalized.organizationId,
          normalized.target.originResourceUid,
        );
        throw new RuntimeInputPreparationError(
          origin === "live" ? "unavailable" : "conflict",
          origin === "live" ? 503 : 409,
        );
      }

      return projection({
        organization_id: normalized.organizationId,
        operation_id: normalized.operationId,
        preparation_id: preparationId,
        preparation_commitment: preparationCommitment,
        material_set_id: normalized.materialSetId,
        space: normalized.target.space,
        worker_name: normalized.target.workerName,
        worker_resource_uid: normalized.target.workerResourceUid,
        bundle_name: normalized.target.bundleName,
        origin_resource_uid: normalized.target.originResourceUid,
        canonical_public_origin: normalized.canonicalPublicOrigin,
        binding_names_json: JSON.stringify(normalized.bindingNames),
        sealed_payload: base64Url(new Uint8Array(ciphertext)),
        seal_nonce: base64Url(nonce),
        seal_key_id: key.keyId,
        state: "prepared",
        fence: 1,
        claim_owner: null,
        claim_expires_at: null,
        claimed_resource_uid: null,
        dispatched_operation_id: null,
        consumed_receipt_digest: null,
        expires_at: expiresAt,
      });
    },

    async read(organizationId, operationId) {
      validateOpaqueId(organizationId);
      validateOpaqueId(operationId);
      let row = await readRow(options.sql, organizationId, operationId);
      if (!row) return null;
      const now = options.clock().getTime();
      if (rowExpired(row, now)) {
        await expireExact(options.sql, row, now);
        row = await readRow(options.sql, organizationId, operationId);
        if (!row || rowExpired(row, now)) {
          throw new RuntimeInputPreparationError("unavailable", 503);
        }
      }
      return projection(row);
    },

    async claim(input) {
      const normalized = normalizeClaimInput(input);
      const now = options.clock().getTime();
      let candidate = await readByPreparationId(
        options.sql,
        normalized.organizationId,
        normalized.preparationId,
      );
      if (!candidate) throw new RuntimeInputPreparationError("not_found", 404);
      assertClaimMatches(candidate, normalized);
      if (candidate.preparation_commitment !== normalized.preparationCommitment) {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      if (
        candidate.preparation_commitment !== (await computePreparationCommitmentFromRow(candidate))
      ) {
        throw new RuntimeInputPreparationError("unavailable", 503);
      }
      if (rowExpired(candidate, now)) {
        await expireExact(options.sql, candidate, now);
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      if (candidate.state === "claimed") {
        if (
          candidate.claim_owner !== normalized.claimOwner ||
          candidate.claimed_resource_uid !== normalized.resourceUid
        ) {
          throw new RuntimeInputPreparationError("conflict", 409);
        }
        return await decryptClaim(candidate, keys);
      }
      if (candidate.state !== "prepared") {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      const claimExpiresAt = Math.min(candidate.expires_at, now + CLAIM_TTL_MILLISECONDS);
      try {
        await options.sql.run(
          `UPDATE worker_runtime_input_preparations
           SET state = 'claimed', fence = fence + 1, claim_owner = ?, claim_expires_at = ?,
               claimed_resource_uid = ?, updated_at = ?
           WHERE organization_id = ? AND preparation_id = ? AND state = 'prepared'
             AND fence = ? AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations
               WHERE tenant_id = ?
                 AND resource_uid = worker_runtime_input_preparations.origin_resource_uid
                 AND state = 'live'
             )`,
          [
            normalized.claimOwner,
            claimExpiresAt,
            normalized.resourceUid,
            now,
            normalized.organizationId,
            normalized.preparationId,
            candidate.fence,
            now,
            normalized.organizationId,
          ],
        );
      } catch {
        // An acknowledgement loss is resolved from the exact claim identity below.
      }
      candidate = await readByPreparationId(
        options.sql,
        normalized.organizationId,
        normalized.preparationId,
      );
      if (!candidate) throw new RuntimeInputPreparationError("not_found", 404);
      assertClaimMatches(candidate, normalized);
      if (
        candidate.state !== "claimed" ||
        candidate.claim_owner !== normalized.claimOwner ||
        candidate.claimed_resource_uid !== normalized.resourceUid
      ) {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      if (rowExpired(candidate, now)) {
        await expireExact(options.sql, candidate, now);
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      try {
        return await decryptClaim(candidate, keys);
      } catch (error) {
        await markClaimIndeterminate(options.sql, candidate, now);
        throw error;
      }
    },

    async inspect(input) {
      const normalized = normalizeClaimInput(input);
      const row = await readByPreparationId(
        options.sql,
        normalized.organizationId,
        normalized.preparationId,
      );
      if (!row) throw new RuntimeInputPreparationError("not_found", 404);
      assertClaimMatches(row, normalized);
      if (row.preparation_commitment !== normalized.preparationCommitment) {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      if (row.preparation_commitment !== (await computePreparationCommitmentFromRow(row))) {
        throw new RuntimeInputPreparationError("unavailable", 503);
      }
      if (rowExpired(row, options.clock().getTime())) {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      return recoveryIdentity(row);
    },

    async abort(input) {
      validateClaimIdentity(input);
      const now = options.clock().getTime();
      try {
        const result = await options.sql.run(
          `UPDATE worker_runtime_input_preparations
           SET state = 'revoked', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
               fence = fence + 1, updated_at = ?, revoked_at = ?
           WHERE organization_id = ? AND preparation_id = ? AND state = 'claimed'
             AND fence = ? AND claim_owner = ? AND claimed_resource_uid = ?`,
          [
            now,
            now,
            input.organizationId,
            input.preparationId,
            input.fence,
            input.claimOwner,
            input.resourceUid,
          ],
        );
        if (result.changes === 1) return;
      } catch {
        // Exact readback below distinguishes a committed abort from failure.
      }
      const row = await readByPreparationId(options.sql, input.organizationId, input.preparationId);
      if (!row) throw new RuntimeInputPreparationError("not_found", 404);
      if (
        row.state === "revoked" &&
        row.fence === input.fence + 1 &&
        row.claim_owner === input.claimOwner &&
        row.claimed_resource_uid === input.resourceUid &&
        row.sealed_payload === null &&
        row.seal_nonce === null &&
        row.seal_key_id === null
      ) {
        return;
      }
      throw new RuntimeInputPreparationError("conflict", 409);
    },

    async dispatch(input) {
      validateClaimIdentity(input);
      validateResourceRevision(input.originResourceRevision);
      const now = options.clock().getTime();
      try {
        const result = await options.sql.run(
          `UPDATE worker_runtime_input_preparations
           SET state = 'dispatched', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
               fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL,
               dispatched_operation_id = ?, updated_at = ?
           WHERE organization_id = ? AND preparation_id = ? AND state = 'claimed'
             AND fence = ? AND claim_owner = ? AND claimed_resource_uid = ?
             AND claim_expires_at > ?
             AND EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations
               WHERE tenant_id = ?
                 AND resource_uid = worker_runtime_input_preparations.origin_resource_uid
                 AND state = 'live'
             )
             AND (
               SELECT COUNT(*) FROM tf_resources AS origin_resource
               WHERE origin_resource.tenant_id = ?
                 AND origin_resource.uid = worker_runtime_input_preparations.origin_resource_uid
                 AND origin_resource.revision = ?
             ) = 1`,
          [
            input.claimOwner,
            now,
            input.organizationId,
            input.preparationId,
            input.fence,
            input.claimOwner,
            input.resourceUid,
            now,
            input.organizationId,
            input.organizationId,
            input.originResourceRevision,
          ],
        );
        if (result.changes === 1) return { fence: input.fence + 1 };
      } catch {
        // Exact readback below settles an acknowledgement loss without redispatching.
      }
      const row = await readByPreparationId(options.sql, input.organizationId, input.preparationId);
      if (!row) throw new RuntimeInputPreparationError("not_found", 404);
      if (
        row.state === "dispatched" &&
        row.fence === input.fence + 1 &&
        row.claimed_resource_uid === input.resourceUid &&
        row.dispatched_operation_id === input.claimOwner
      ) {
        return { fence: row.fence };
      }
      if (row.state === "claimed" && rowExpired(row, now)) {
        await expireExact(options.sql, row, now);
      }
      throw new RuntimeInputPreparationError("conflict", 409);
    },

    async consume(input) {
      await consumeDispatched(options.sql, options.clock, input);
    },

    async recover(input) {
      const normalized = normalizeRecoveredInput(input);
      const row = await readRecoveryRow(options.sql, normalized);
      return recoveryIdentity(row);
    },

    async consumeRecovered(input) {
      const normalized = normalizeRecoveredInput(input);
      if (!digest.test(input.receiptDigest)) {
        throw new RuntimeInputPreparationError("invalid_argument", 400);
      }
      const row = await readRecoveryRow(options.sql, normalized);
      if (row.state === "consumed") {
        if (row.consumed_receipt_digest === input.receiptDigest) return;
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      await consumeDispatched(options.sql, options.clock, {
        ...input,
        fence: row.fence,
      });
    },

    async revoke(organizationId, operationId) {
      validateOpaqueId(organizationId);
      validateOpaqueId(operationId);
      const now = options.clock().getTime();
      const result = await options.sql.run(
        `UPDATE worker_runtime_input_preparations
         SET state = 'revoked', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
             fence = fence + 1, updated_at = ?, revoked_at = ?
         WHERE organization_id = ? AND operation_id = ? AND state IN ('prepared', 'claimed')`,
        [now, now, organizationId, operationId],
      );
      if (result.changes === 1) return;
      const row = await readRow(options.sql, organizationId, operationId);
      if (!row || row.state === "revoked" || row.state === "expired" || row.state === "consumed") {
        return;
      }
      throw new RuntimeInputPreparationError("conflict", 409);
    },

    async expireDue(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new TypeError("runtime input expiry limit must be an integer from 1 to 1000");
      }
      const now = options.clock().getTime();
      const result = await options.sql.run(
        `UPDATE worker_runtime_input_preparations
         SET state = 'expired', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
             fence = fence + 1, updated_at = ?
         WHERE rowid IN (
           SELECT rowid FROM worker_runtime_input_preparations
           WHERE (state = 'prepared' AND expires_at <= ?)
              OR (state = 'claimed' AND claim_expires_at <= ?)
           ORDER BY updated_at, rowid
           LIMIT ?
         )`,
        [now, now, now, limit],
      );
      return result.changes;
    },
  };
}

async function consumeDispatched(
  sql: Sql,
  clock: Clock,
  input: RuntimeInputConsumption,
): Promise<void> {
  validateClaimIdentity(input);
  if (!digest.test(input.receiptDigest)) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  const now = clock().getTime();
  try {
    const result = await sql.run(
      `UPDATE worker_runtime_input_preparations
       SET state = 'consumed', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
           fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL,
           dispatched_operation_id = ?, consumed_receipt_digest = ?,
           consumed_at = ?, updated_at = ?
       WHERE organization_id = ? AND preparation_id = ? AND state = 'dispatched'
         AND fence = ? AND dispatched_operation_id = ? AND claimed_resource_uid = ?`,
      [
        input.claimOwner,
        input.receiptDigest,
        now,
        now,
        input.organizationId,
        input.preparationId,
        input.fence,
        input.claimOwner,
        input.resourceUid,
      ],
    );
    if (result.changes === 1) return;
  } catch {
    // Exact readback below distinguishes a committed transition from failure.
  }
  const row = await readByPreparationId(sql, input.organizationId, input.preparationId);
  if (!row) throw new RuntimeInputPreparationError("not_found", 404);
  if (
    row.state === "consumed" &&
    row.claimed_resource_uid === input.resourceUid &&
    row.dispatched_operation_id === input.claimOwner &&
    row.consumed_receipt_digest === input.receiptDigest
  ) {
    return;
  }
  throw new RuntimeInputPreparationError("conflict", 409);
}

interface NormalizedInput extends RuntimeInputPreparationInput {
  readonly bindingNames: readonly string[];
  readonly bindings: Readonly<Record<string, string>>;
}

type PreparationRow = Row & {
  readonly organization_id: string;
  readonly operation_id: string;
  readonly preparation_id: string;
  readonly preparation_commitment: `sha256:${string}`;
  readonly material_set_id: string;
  readonly space: string;
  readonly worker_name: string;
  readonly worker_resource_uid: string;
  readonly bundle_name: string;
  readonly origin_resource_uid: string;
  readonly canonical_public_origin: string;
  readonly binding_names_json: string;
  readonly sealed_payload: string | null;
  readonly seal_nonce: string | null;
  readonly seal_key_id: string | null;
  readonly state: RuntimeInputPreparationProjection["status"];
  readonly fence: number;
  readonly claim_owner: string | null;
  readonly claim_expires_at: number | null;
  readonly claimed_resource_uid: string | null;
  readonly dispatched_operation_id: string | null;
  readonly consumed_receipt_digest: string | null;
  readonly expires_at: number;
};

async function readRow(
  sql: Sql,
  organizationId: string,
  operationId: string,
): Promise<PreparationRow | null> {
  const rows = await sql.query(
    `SELECT organization_id, operation_id, preparation_id, preparation_commitment, material_set_id,
            space, worker_name, worker_resource_uid, bundle_name, origin_resource_uid,
            canonical_public_origin, binding_names_json,
            sealed_payload, seal_nonce, seal_key_id, state, fence,
            claim_owner, claim_expires_at, claimed_resource_uid,
            dispatched_operation_id, consumed_receipt_digest, expires_at
     FROM worker_runtime_input_preparations
     WHERE organization_id = ? AND operation_id = ?`,
    [organizationId, operationId],
  );
  return rows.length === 0 ? null : (rows[0] as PreparationRow);
}

async function readByPreparationId(
  sql: Sql,
  organizationId: string,
  preparationId: string,
): Promise<PreparationRow | null> {
  const rows = await sql.query(
    `SELECT organization_id, operation_id, preparation_id, preparation_commitment, material_set_id,
            space, worker_name, worker_resource_uid, bundle_name, origin_resource_uid,
            canonical_public_origin, binding_names_json,
            sealed_payload, seal_nonce, seal_key_id, state, fence,
            claim_owner, claim_expires_at, claimed_resource_uid,
            dispatched_operation_id, consumed_receipt_digest, expires_at
     FROM worker_runtime_input_preparations
     WHERE organization_id = ? AND preparation_id = ?`,
    [organizationId, preparationId],
  );
  return rows.length === 0 ? null : (rows[0] as PreparationRow);
}

async function originLifecycleState(
  sql: Sql,
  organizationId: string,
  resourceUid: string,
): Promise<string | null> {
  const rows = await sql.query(
    `SELECT state FROM tf_resource_deletion_attestations
     WHERE tenant_id = ? AND resource_uid = ? LIMIT 2`,
    [organizationId, resourceUid],
  );
  return rows.length === 1 && typeof rows[0]?.state === "string" ? rows[0].state : null;
}

interface NormalizedClaimInput extends RuntimeInputClaimInput {
  readonly bindingNames: readonly string[];
}

function validateClaimIdentity(input: RuntimeInputClaimIdentity): void {
  validateOpaqueId(input.organizationId);
  validateOpaqueId(input.preparationId);
  validateOpaqueId(input.claimOwner);
  validateOpaqueId(input.resourceUid);
  if (!Number.isSafeInteger(input.fence) || input.fence < 1) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
}

function validateResourceRevision(value: string): void {
  if (!/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
}

function normalizeClaimInput(input: RuntimeInputClaimInput): NormalizedClaimInput {
  validateOpaqueId(input.organizationId);
  validateOpaqueId(input.preparationId);
  validateOpaqueId(input.claimOwner);
  validateOpaqueId(input.resourceUid);
  if (!digest.test(input.preparationCommitment)) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  validateBoundedText(input.target.space, 255);
  validateBoundedText(input.target.workerName, 255);
  validateBoundedText(input.target.bundleName, 255);
  const bindingNames = [...input.bindingNames].sort();
  if (
    bindingNames.length === 0 ||
    bindingNames.length > MAX_PROVIDER_RUNTIME_INPUT_BINDINGS ||
    new Set(bindingNames).size !== bindingNames.length ||
    bindingNames.some((name) => !bindingName.test(name))
  ) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  return { ...input, bindingNames };
}

function assertClaimMatches(row: PreparationRow, input: NormalizedClaimInput): void {
  if (
    row.organization_id !== input.organizationId ||
    row.preparation_id !== input.preparationId ||
    row.space !== input.target.space ||
    row.worker_name !== input.target.workerName ||
    row.worker_resource_uid !== input.target.workerResourceUid ||
    row.bundle_name !== input.target.bundleName ||
    row.binding_names_json !== JSON.stringify(input.bindingNames)
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
}

type NormalizedRecoveredInput = Omit<RuntimeInputRecoveredConsumption, "receiptDigest"> & {
  readonly bindingNames: readonly string[];
};

function normalizeRecoveredInput(
  input: Omit<RuntimeInputRecoveredConsumption, "receiptDigest">,
): NormalizedRecoveredInput {
  const normalized = normalizeClaimInput({
    organizationId: input.organizationId,
    preparationId: input.preparationId,
    preparationCommitment: input.preparationCommitment,
    claimOwner: input.claimOwner,
    resourceUid: input.resourceUid,
    target: input.target,
    bindingNames: input.bindingNames,
  });
  return { ...input, bindingNames: normalized.bindingNames };
}

async function readRecoveryRow(sql: Sql, input: NormalizedRecoveredInput): Promise<PreparationRow> {
  const row = await readByPreparationId(sql, input.organizationId, input.preparationId);
  if (!row) throw new RuntimeInputPreparationError("not_found", 404);
  assertClaimMatches(row, input);
  if (row.preparation_commitment !== input.preparationCommitment) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
  if (
    (row.state !== "dispatched" && row.state !== "consumed") ||
    row.dispatched_operation_id !== input.claimOwner ||
    row.claimed_resource_uid !== input.resourceUid
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
  if (row.preparation_commitment !== (await computePreparationCommitmentFromRow(row))) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  return row;
}

function recoveryIdentity(row: PreparationRow): RuntimeInputRecoveryIdentity {
  return {
    operationId: row.operation_id,
    preparationId: row.preparation_id,
    preparationCommitment: row.preparation_commitment,
    fence: row.fence,
    materialSetId: row.material_set_id,
    canonicalPublicOrigin: row.canonical_public_origin,
    originResourceUid: row.origin_resource_uid,
    workerResourceUid: row.worker_resource_uid,
  };
}

function preparationIdentity(
  claim: RuntimeInputClaim | RuntimeInputRecoveryIdentity,
): ProviderRuntimeInputPreparationIdentity {
  return {
    preparationId: claim.preparationId,
    materialSetId: claim.materialSetId,
    originResourceUid: claim.originResourceUid,
    workerResourceUid: claim.workerResourceUid,
    canonicalPublicOrigin: claim.canonicalPublicOrigin,
    commitment: claim.preparationCommitment,
  };
}

function rowExpired(row: PreparationRow, now: number): boolean {
  return (
    (row.state === "prepared" && row.expires_at <= now) ||
    (row.state === "claimed" && (row.claim_expires_at ?? 0) <= now)
  );
}

async function expireExact(sql: Sql, row: PreparationRow, now: number): Promise<void> {
  const expiryColumn = row.state === "claimed" ? "claim_expires_at" : "expires_at";
  const expiryValue = row.state === "claimed" ? row.claim_expires_at : row.expires_at;
  if ((row.state !== "prepared" && row.state !== "claimed") || expiryValue === null) return;
  try {
    await sql.run(
      `UPDATE worker_runtime_input_preparations
       SET state = 'expired', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
           fence = fence + 1, updated_at = ?
       WHERE organization_id = ? AND preparation_id = ? AND state = ? AND fence = ?
         AND ${expiryColumn} = ?`,
      [now, row.organization_id, row.preparation_id, row.state, row.fence, expiryValue],
    );
  } catch {
    // Exact callers re-read or fail closed; scheduler retries this bounded cleanup.
  }
}

async function decryptClaim(
  row: PreparationRow,
  keys: ReadonlyMap<string, CryptoKey>,
): Promise<RuntimeInputClaim> {
  if (
    row.state !== "claimed" ||
    !row.sealed_payload ||
    !row.seal_nonce ||
    !row.seal_key_id ||
    !Number.isSafeInteger(row.fence) ||
    row.fence < 1
  ) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  const key = keys.get(row.seal_key_id);
  if (!key) throw new RuntimeInputPreparationError("unavailable", 503);
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64Url(row.seal_nonce),
          additionalData: encode(canonicalAadFromRow(row)),
          tagLength: 128,
        },
        key,
        fromBase64Url(row.sealed_payload),
      ),
    );
  } catch {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  const normalized = parseSealedPayload(row, plaintext);
  if (!constantTimeEqual(plaintext, encode(canonicalSealedPayload(normalized)))) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  if (
    row.preparation_commitment !==
    (await computePreparationCommitment(normalized, row.preparation_id))
  ) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  return {
    operationId: row.operation_id,
    preparationId: row.preparation_id,
    preparationCommitment: row.preparation_commitment,
    fence: row.fence,
    materialSetId: row.material_set_id,
    canonicalPublicOrigin: row.canonical_public_origin,
    originResourceUid: row.origin_resource_uid,
    workerResourceUid: row.worker_resource_uid,
    bindings: { ...normalized.bindings },
  };
}

function parseSealedPayload(row: PreparationRow, bytes: Uint8Array): NormalizedInput {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).sort().join("\0") !==
      ["canonicalPublicOrigin", "format", "materialSetId", "values"].sort().join("\0") ||
    payload.format !== SEALED_PAYLOAD_FORMAT ||
    payload.materialSetId !== row.material_set_id ||
    payload.canonicalPublicOrigin !== row.canonical_public_origin ||
    typeof payload.values !== "object" ||
    payload.values === null ||
    Array.isArray(payload.values)
  ) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  let normalized: NormalizedInput;
  try {
    normalized = normalizeInput({
      organizationId: row.organization_id,
      operationId: row.operation_id,
      materialSetId: row.material_set_id,
      target: {
        space: row.space,
        workerName: row.worker_name,
        workerResourceUid: row.worker_resource_uid,
        bundleName: row.bundle_name,
        originResourceUid: row.origin_resource_uid,
      },
      canonicalPublicOrigin: row.canonical_public_origin,
      bindings: payload.values as Readonly<Record<string, string>>,
    });
  } catch {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  if (JSON.stringify(normalized.bindingNames) !== row.binding_names_json) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  return normalized;
}

function canonicalAadFromRow(row: PreparationRow): string {
  return JSON.stringify({
    format: AAD_FORMAT,
    organizationId: row.organization_id,
    operationId: row.operation_id,
    preparationId: row.preparation_id,
    keyId: row.seal_key_id,
    target: {
      space: row.space,
      workerName: row.worker_name,
      workerResourceUid: row.worker_resource_uid,
      bundleName: row.bundle_name,
      originResourceUid: row.origin_resource_uid,
    },
    canonicalPublicOrigin: row.canonical_public_origin,
    bindingNames: bindingNamesFromRow(row),
  });
}

async function markClaimIndeterminate(sql: Sql, row: PreparationRow, now: number): Promise<void> {
  try {
    await sql.run(
      `UPDATE worker_runtime_input_preparations
       SET state = 'indeterminate', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
           fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
       WHERE organization_id = ? AND operation_id = ? AND state = 'claimed' AND fence = ?`,
      [now, row.organization_id, row.operation_id, row.fence],
    );
  } catch {
    // Best effort only: the caller still fails closed and no second claim is issued.
  }
}

async function adoptExisting(
  row: PreparationRow,
  input: NormalizedInput,
  keys: ReadonlyMap<string, CryptoKey>,
  clock: Clock,
): Promise<RuntimeInputPreparationProjection> {
  if (row.state !== "prepared" || row.expires_at <= clock().getTime()) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
  if (
    row.organization_id !== input.organizationId ||
    row.operation_id !== input.operationId ||
    row.material_set_id !== input.materialSetId ||
    row.space !== input.target.space ||
    row.worker_name !== input.target.workerName ||
    row.worker_resource_uid !== input.target.workerResourceUid ||
    row.bundle_name !== input.target.bundleName ||
    row.origin_resource_uid !== input.target.originResourceUid ||
    row.canonical_public_origin !== input.canonicalPublicOrigin ||
    row.binding_names_json !== JSON.stringify(input.bindingNames)
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
  if (
    row.preparation_commitment !== (await computePreparationCommitment(input, row.preparation_id))
  ) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  if (!row.sealed_payload || !row.seal_nonce || !row.seal_key_id) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  const key = keys.get(row.seal_key_id);
  if (!key) throw new RuntimeInputPreparationError("unavailable", 503);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(row.seal_nonce),
        additionalData: encode(canonicalAad(input, row.preparation_id, row.seal_key_id)),
        tagLength: 128,
      },
      key,
      fromBase64Url(row.sealed_payload),
    );
  } catch {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  if (!constantTimeEqual(new Uint8Array(plaintext), encode(canonicalSealedPayload(input)))) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
  return projection(row);
}

function normalizeInput(input: RuntimeInputPreparationInput): NormalizedInput {
  validateOpaqueId(input.organizationId);
  validateOpaqueId(input.operationId);
  validateOpaqueId(input.materialSetId);
  for (const value of Object.values(input.target)) validateBoundedText(value, 255);
  validateCanonicalOrigin(input.canonicalPublicOrigin);
  const bindingNames = Object.keys(input.bindings).sort();
  if (bindingNames.length === 0 || bindingNames.length > MAX_PROVIDER_RUNTIME_INPUT_BINDINGS) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  const bindings: Record<string, string> = {};
  for (const name of bindingNames) {
    if (!bindingName.test(name)) throw new RuntimeInputPreparationError("invalid_argument", 400);
    const value = input.bindings[name];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      encode(value).byteLength > MAX_VALUE_BYTES
    ) {
      throw new RuntimeInputPreparationError("invalid_argument", 400);
    }
    bindings[name] = value;
  }
  return { ...input, bindings, bindingNames };
}

function canonicalSealedPayload(input: NormalizedInput): string {
  return JSON.stringify({
    format: SEALED_PAYLOAD_FORMAT,
    materialSetId: input.materialSetId,
    canonicalPublicOrigin: input.canonicalPublicOrigin,
    values: input.bindings,
  });
}

async function computePreparationCommitment(
  input: NormalizedInput,
  preparationId: string,
): Promise<`sha256:${string}`> {
  const canonical = JSON.stringify({
    format: COMMITMENT_FORMAT,
    organizationId: input.organizationId,
    preparationOperationId: input.operationId,
    preparationId,
    materialSetId: input.materialSetId,
    target: input.target,
    canonicalPublicOrigin: input.canonicalPublicOrigin,
    bindingNames: input.bindingNames,
  });
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encode(canonical) as unknown as BufferSource),
  );
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function computePreparationCommitmentFromRow(
  row: PreparationRow,
): Promise<`sha256:${string}`> {
  const bindingNames = bindingNamesFromRow(row);
  const canonical = JSON.stringify({
    format: COMMITMENT_FORMAT,
    organizationId: row.organization_id,
    preparationOperationId: row.operation_id,
    preparationId: row.preparation_id,
    materialSetId: row.material_set_id,
    target: {
      space: row.space,
      workerName: row.worker_name,
      workerResourceUid: row.worker_resource_uid,
      bundleName: row.bundle_name,
      originResourceUid: row.origin_resource_uid,
    },
    canonicalPublicOrigin: row.canonical_public_origin,
    bindingNames,
  });
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encode(canonical) as unknown as BufferSource),
  );
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function runtimeInputReceiptDigest(input: {
  readonly preparation: ProviderRuntimeInputPreparationIdentity;
  readonly organizationId: string;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly providerReceiptDigest: `sha256:${string}`;
}): Promise<`sha256:${string}`> {
  if (!digest.test(input.providerReceiptDigest)) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  const canonical = JSON.stringify({
    format: "takoserver.worker-runtime-input-receipt@v1",
    preparationId: input.preparation.preparationId,
    preparationCommitment: input.preparation.commitment,
    organizationId: input.organizationId,
    operationId: input.operationId,
    resourceUid: input.resourceUid,
    providerReceiptDigest: input.providerReceiptDigest,
  });
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encode(canonical) as unknown as BufferSource),
  );
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function runtimeInputReferenceValue(preparationId: string, commitment: `sha256:${string}`): string {
  return `${RUNTIME_INPUT_REFERENCE_PREFIX}.${preparationId}.${commitment.slice("sha256:".length)}`;
}

function runtimeInputReference(value: string): {
  readonly preparationId: string;
  readonly commitment: `sha256:${string}`;
} {
  const match = /^rip1\.([A-Za-z0-9_-]{3,42})\.([0-9a-f]{64})$/u.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  return { preparationId: match[1], commitment: `sha256:${match[2]}` };
}

function canonicalAad(input: NormalizedInput, preparationId: string, keyId: string): string {
  return JSON.stringify({
    format: AAD_FORMAT,
    organizationId: input.organizationId,
    operationId: input.operationId,
    preparationId,
    keyId,
    target: input.target,
    canonicalPublicOrigin: input.canonicalPublicOrigin,
    bindingNames: input.bindingNames,
  });
}

function projection(row: PreparationRow): RuntimeInputPreparationProjection {
  if (!digest.test(row.preparation_commitment)) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  const names = bindingNamesFromRow(row);
  return {
    format: RUNTIME_INPUT_PREPARATION_FORMAT,
    operationId: row.operation_id,
    preparationId: row.preparation_id,
    runtimeInputReference: runtimeInputReferenceValue(
      row.preparation_id,
      row.preparation_commitment,
    ),
    status: row.state,
    expiresAt: new Date(row.expires_at).toISOString(),
    target: {
      space: row.space,
      workerName: row.worker_name,
      workerResourceUid: row.worker_resource_uid,
      bundleName: row.bundle_name,
      originResourceUid: row.origin_resource_uid,
    },
    canonicalPublicOrigin: row.canonical_public_origin,
    bindingNames: names,
  };
}

function bindingNamesFromRow(row: PreparationRow): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(row.binding_names_json);
  } catch {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_RUNTIME_INPUT_BINDINGS ||
    value.some((name) => typeof name !== "string" || !bindingName.test(name)) ||
    new Set(value).size !== value.length ||
    JSON.stringify([...value].sort()) !== row.binding_names_json
  ) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  return value as readonly string[];
}

function validateSealKey(candidate: RuntimeInputSealKey): void {
  if (!opaqueId.test(candidate.keyId) || candidate.key.algorithm.name !== "AES-GCM") {
    throw new TypeError("runtime input seal keys must be named AES-GCM keys");
  }
  const algorithm = candidate.key.algorithm as { readonly name: string; readonly length?: number };
  if (
    algorithm.length !== 256 ||
    !candidate.key.usages.includes("encrypt") ||
    !candidate.key.usages.includes("decrypt")
  ) {
    throw new TypeError(
      "runtime input seal keys must be non-extractable AES-256-GCM encrypt/decrypt keys",
    );
  }
  if (candidate.key.extractable) {
    throw new TypeError(
      "runtime input seal keys must be non-extractable AES-256-GCM encrypt/decrypt keys",
    );
  }
}

function validateOpaqueId(value: string): void {
  if (!opaqueId.test(value)) throw new RuntimeInputPreparationError("invalid_argument", 400);
}

function validateGeneratedId(value: string): string {
  if (!/^[A-Za-z0-9_-]{3,42}$/u.test(value)) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  return value;
}

function validateBoundedText(value: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
}

function validateCanonicalOrigin(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
}

function encode(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(value));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new RuntimeInputPreparationError("unavailable", 503);
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
