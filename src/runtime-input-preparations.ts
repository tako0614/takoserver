import type { Clock, Row, Sql } from "./ports.ts";
import {
  MAX_PROVIDER_RUNTIME_INPUT_BINDINGS,
  type ProviderRuntimeInputLeasePort,
  type ProviderRuntimeInputPreparationIdentity,
} from "./provider-runtime-input-port.ts";

/**
 * The one-shot Worker runtime-input handoff, wire contract v2.
 *
 * A provider that must deliver `requiredSensitiveVars` sends the values once,
 * privately, addressed by the exact operation key it will also use as the
 * public apply's `Idempotency-Key`. The same request commits to the exact
 * public apply it authorizes — method, path, `If-None-Match`, and body — so a
 * preparation can never be spent by a different mutation, and the caller can
 * prove the Host echoed the commitment it computed itself.
 *
 * Everything else about the handoff is value-free. The durable row holds only
 * sealed ciphertext, binding names, the commitment, and the identity of the
 * operation that claimed it; the projection returned to the caller holds no
 * values at all, so a lost acknowledgement is recovered by reading rather than
 * by sending the secrets a second time.
 */

export const RUNTIME_INPUT_PREPARATION_FORMAT =
  "takoserver.worker-runtime-input-preparation@v2" as const;

/**
 * Label of the cross-implementation public-apply commitment. The framing is
 * length-prefixed on purpose: concatenating a path and a body without one lets
 * two different requests hash the same.
 */
export const RUNTIME_INPUT_PUBLIC_APPLY_COMMITMENT_LABEL =
  "takoserver.worker-runtime-input-public-apply@v1" as const;

const SEALED_PAYLOAD_FORMAT = "takoserver.worker-runtime-input-sealed-payload@v2" as const;
const AAD_FORMAT = "takoserver.worker-runtime-input-aad@v2" as const;
const PREPARATION_ID_FORMAT = "takoserver.worker-runtime-input-preparation-id@v2" as const;
const RECEIPT_FORMAT = "takoserver.worker-runtime-input-receipt@v2" as const;

const PREPARATION_TTL_MILLISECONDS = 60 * 60 * 1_000;
const CLAIM_TTL_MILLISECONDS = 15 * 60 * 1_000;
const MAX_VALUE_BYTES = 32 * 1_024;
const MAX_PUBLIC_APPLY_PATH_BYTES = 8 * 1_024;
const MAX_PUBLIC_APPLY_BODY_BYTES = 1 * 1_024 * 1_024;

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** Exactly the grammar the stable Host requires of a mutation Idempotency-Key. */
const operationKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const bindingName = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;

export interface RuntimeInputSealKey {
  readonly keyId: string;
  readonly key: CryptoKey;
}

/** The exact ordinary public apply one preparation authorizes. */
export interface RuntimeInputPublicApply {
  readonly method: string;
  readonly path: string;
  readonly fences: { readonly ifNoneMatch: string };
  readonly body: string;
}

export interface RuntimeInputPreparationInput {
  readonly organizationId: string;
  readonly operationKey: string;
  /** This Host's own canonical public origin, as the caller addressed it. */
  readonly canonicalPublicOrigin: string;
  readonly publicApply: RuntimeInputPublicApply;
  readonly bindings: Readonly<Record<string, string>>;
}

export type RuntimeInputPreparationStatus = "prepared" | "accepted" | "dispatched" | "consumed";

export interface RuntimeInputPreparationProjection {
  readonly format: typeof RUNTIME_INPUT_PREPARATION_FORMAT;
  readonly status: RuntimeInputPreparationStatus;
  readonly operationKey: string;
  readonly applyCommitment: `sha256:${string}`;
  readonly canonicalPublicOrigin: string;
  readonly bindingNames: readonly string[];
  /** Present exactly when the handoff has been claimed by a Host operation. */
  readonly hostOperationId?: string;
}

/**
 * The cross-implementation commitment to one exact public apply request.
 *
 * Each field in `[label, method, path, ifNoneMatch, body]` is UTF-8 preceded by
 * its unsigned 64-bit big-endian byte length; the SHA-256 is lowercase hex.
 * This is byte-for-byte the framing the released Takoform provider computes, so
 * the two sides compare one string instead of trusting each other's
 * canonicalization.
 */
export async function runtimeInputPublicApplyCommitment(
  apply: RuntimeInputPublicApply,
): Promise<`sha256:${string}`> {
  if (apply.method !== "PUT") throw new RuntimeInputPreparationError("invalid_argument", 400);
  if (apply.fences?.ifNoneMatch !== "*") {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  const path = utf8(apply.path, MAX_PUBLIC_APPLY_PATH_BYTES);
  if (path.byteLength < 1 || !apply.path.startsWith("/")) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  const body = utf8(apply.body, MAX_PUBLIC_APPLY_BODY_BYTES);
  if (body.byteLength < 1) throw new RuntimeInputPreparationError("invalid_argument", 400);
  const fields = [
    encode(RUNTIME_INPUT_PUBLIC_APPLY_COMMITMENT_LABEL),
    encode(apply.method),
    path,
    encode(apply.fences.ifNoneMatch),
    body,
  ];
  let total = 0;
  for (const field of fields) total += 8 + field.byteLength;
  const framed = new Uint8Array(total);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setBigUint64(offset, BigInt(field.byteLength), false);
    offset += 8;
    framed.set(field, offset);
    offset += field.byteLength;
  }
  return await sha256(framed);
}

export interface RuntimeInputClaimTarget {
  readonly space: string;
  readonly workerName: string;
  /** Exact ModuleWorker incarnation re-read at the provider mutation barrier. */
  readonly workerResourceUid: string;
  readonly bundleName: string;
}

export interface RuntimeInputClaimInput {
  readonly organizationId: string;
  readonly operationKey: string;
  /** The exact Host operation the claim belongs to. */
  readonly claimOwner: string;
  /** The WorkerVersion Resource being created by that operation. */
  readonly resourceUid: string;
  readonly target: RuntimeInputClaimTarget;
  readonly bindingNames: readonly string[];
}

export interface RuntimeInputClaim {
  readonly operationKey: string;
  readonly preparationId: string;
  readonly applyCommitment: `sha256:${string}`;
  readonly canonicalPublicOrigin: string;
  readonly workerResourceUid: string;
  readonly hostOperationId: string;
  readonly fence: number;
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

export interface RuntimeInputConsumption extends RuntimeInputClaimIdentity {
  readonly receiptDigest: `sha256:${string}`;
}

export class RuntimeInputPreparationError extends Error {
  constructor(
    readonly code: "invalid_argument" | "conflict" | "operation_not_found" | "unavailable",
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
    operationKey: string,
  ): Promise<RuntimeInputPreparationProjection | null>;
  claim(input: RuntimeInputClaimInput): Promise<RuntimeInputClaim>;
  abort(input: RuntimeInputClaimIdentity): Promise<void>;
  dispatch(input: RuntimeInputClaimIdentity): Promise<{ readonly fence: number }>;
  consume(input: RuntimeInputConsumption): Promise<void>;
  /** Reads only the value-free identity of one exact dispatched handoff. */
  recover(input: RuntimeInputClaimInput): Promise<RuntimeInputRecoveryIdentity>;
  /** Settles the one dispatched handoff after provider acknowledgement recovery. */
  consumeRecovered(
    input: RuntimeInputClaimInput & { readonly receiptDigest: `sha256:${string}` },
  ): Promise<void>;
  /** Revokes an exact claimed/dispatched handoff after proven provider absence. */
  abandon(input: RuntimeInputClaimInput): Promise<void>;
  revoke(organizationId: string, operationKey: string): Promise<void>;
  expireDue(limit: number): Promise<number>;
}

export interface RuntimeInputAuthority {
  /** Closed control-plane surface used only by authenticated HTTP routes. */
  readonly preparations: {
    prepare(input: RuntimeInputPreparationInput): Promise<RuntimeInputPreparationProjection>;
    read(
      organizationId: string,
      operationKey: string,
    ): Promise<RuntimeInputPreparationProjection | null>;
    revoke(organizationId: string, operationKey: string): Promise<void>;
  };
  /** Provider-neutral one-shot lease seam used by concrete provider adapters. */
  readonly leases: ProviderRuntimeInputLeasePort;
  /** Bounded lifecycle cleanup composed into the product scheduler. */
  readonly maintenance: {
    expireDue(limit: number): Promise<number>;
  };
}

export interface CreateRuntimeInputPreparationsOptions {
  readonly sql: Sql;
  readonly sealKeys: {
    readonly current: RuntimeInputSealKey;
    readonly previous?: readonly RuntimeInputSealKey[];
  };
  readonly clock: Clock;
  /**
   * This deployment's own canonical public origin. A preparation addressed to a
   * different origin is refused before anything is sealed: the caller is either
   * misconfigured or talking to a Host it did not mean to trust.
   */
  readonly canonicalPublicOrigin: string;
  readonly randomBytes?: (length: number) => Uint8Array;
}

export function createRuntimeInputAuthority(
  options: CreateRuntimeInputPreparationsOptions,
): RuntimeInputAuthority {
  const internals = createRuntimeInputPreparations(options);
  const claimInputFor = (input: {
    readonly organizationId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly reference: string;
    readonly target: RuntimeInputClaimTarget;
    readonly bindingNames: readonly string[];
  }): RuntimeInputClaimInput => ({
    organizationId: input.organizationId,
    operationKey: input.reference,
    claimOwner: input.operationId,
    resourceUid: input.resourceUid,
    target: input.target,
    bindingNames: input.bindingNames,
  });

  return {
    preparations: {
      prepare: (input) => internals.prepare(input),
      read: (organizationId, operationKey) => internals.read(organizationId, operationKey),
      revoke: (organizationId, operationKey) => internals.revoke(organizationId, operationKey),
    },
    leases: {
      async acquire(input) {
        const claim = await internals.claim(claimInputFor(input));
        const preparation = preparationIdentity(claim);
        const identity: RuntimeInputClaimIdentity = {
          organizationId: input.organizationId,
          preparationId: claim.preparationId,
          claimOwner: input.operationId,
          resourceUid: input.resourceUid,
          fence: claim.fence,
        };
        return {
          bindings: claim.bindings,
          preparation,
          abort: async () => await internals.abort(identity),
          async dispatch() {
            const dispatched = await internals.dispatch(identity);
            return {
              settle: async (providerReceiptDigest) =>
                await internals.consume({
                  ...identity,
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
        const claimInput = claimInputFor(input);
        const recovered = await internals.recover(claimInput);
        const preparation = preparationIdentity(recovered);
        return {
          preparation,
          bindingNames: [...input.bindingNames].sort(),
          settle: async (providerReceiptDigest) =>
            await internals.consumeRecovered({
              ...claimInput,
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
      async abandon(input) {
        await internals.abandon(claimInputFor(input));
      },
    },
    maintenance: {
      expireDue: (limit) => internals.expireDue(limit),
    },
  };
}

export function createRuntimeInputPreparations(
  options: CreateRuntimeInputPreparationsOptions,
): RuntimeInputPreparations {
  const keys = new Map<string, CryptoKey>();
  for (const candidate of [options.sealKeys.current, ...(options.sealKeys.previous ?? [])]) {
    validateSealKey(candidate);
    if (keys.has(candidate.keyId)) throw new TypeError("runtime input seal key ids must be unique");
    keys.set(candidate.keyId, candidate.key);
  }
  const hostOrigin = options.canonicalPublicOrigin;
  validateBareOrigin(hostOrigin);
  const randomBytes =
    options.randomBytes ??
    ((length: number) => {
      const value = new Uint8Array(length);
      crypto.getRandomValues(value);
      return value;
    });

  const seal = async (
    normalized: NormalizedPreparation,
    preparationId: string,
  ): Promise<{ readonly ciphertext: string; readonly nonce: string; readonly keyId: string }> => {
    const key = options.sealKeys.current;
    const nonce = Uint8Array.from(randomBytes(12));
    if (nonce.byteLength !== 12) {
      throw new TypeError("runtime input nonce source must return 12 bytes");
    }
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: encode(canonicalAad(normalized, preparationId, key.keyId)),
        tagLength: 128,
      },
      key.key,
      encode(canonicalSealedPayload(normalized)),
    );
    return {
      ciphertext: base64Url(new Uint8Array(ciphertext)),
      nonce: base64Url(nonce),
      keyId: key.keyId,
    };
  };

  return {
    async prepare(input) {
      const normalized = await normalizePreparation(input, hostOrigin);
      const preparationId = await derivePreparationId(
        normalized.organizationId,
        normalized.operationKey,
      );
      const now = options.clock().getTime();
      const existing = await readRow(
        options.sql,
        normalized.organizationId,
        normalized.operationKey,
      );
      if (existing) {
        if (existing.state === "prepared" && existing.expires_at > now) {
          return await adoptExisting(existing, normalized, keys);
        }
        if (!replaceablePreparation(existing, now)) {
          throw new RuntimeInputPreparationError("conflict", 409);
        }
        await discardReplaceable(options.sql, existing);
      }

      const sealed = await seal(normalized, preparationId);
      const expiresAt = now + PREPARATION_TTL_MILLISECONDS;
      try {
        const inserted = await options.sql.run(
          `INSERT INTO worker_runtime_input_preparations
             (organization_id, operation_key, preparation_id, apply_commitment,
              canonical_public_origin, binding_names_json,
              sealed_payload, seal_nonce, seal_key_id,
              state, fence, host_operation_id, claim_owner, claim_expires_at,
              claimed_resource_uid, space, worker_name, worker_resource_uid, bundle_name,
              consumed_receipt_digest, expires_at, created_at, updated_at, consumed_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1,
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
          [
            normalized.organizationId,
            normalized.operationKey,
            preparationId,
            normalized.applyCommitment,
            normalized.canonicalPublicOrigin,
            JSON.stringify(normalized.bindingNames),
            sealed.ciphertext,
            sealed.nonce,
            sealed.keyId,
            expiresAt,
            now,
            now,
          ],
        );
        if (inserted.changes !== 1) throw new RuntimeInputPreparationError("conflict", 409);
      } catch (error) {
        if (error instanceof RuntimeInputPreparationError) throw error;
        const raced = await readRow(
          options.sql,
          normalized.organizationId,
          normalized.operationKey,
        );
        if (raced?.state === "prepared" && raced.expires_at > now) {
          return await adoptExisting(raced, normalized, keys);
        }
        throw new RuntimeInputPreparationError("unavailable", 503);
      }
      return projection({
        organization_id: normalized.organizationId,
        operation_key: normalized.operationKey,
        preparation_id: preparationId,
        apply_commitment: normalized.applyCommitment,
        canonical_public_origin: normalized.canonicalPublicOrigin,
        binding_names_json: JSON.stringify(normalized.bindingNames),
        sealed_payload: sealed.ciphertext,
        seal_nonce: sealed.nonce,
        seal_key_id: sealed.keyId,
        state: "prepared",
        fence: 1,
        host_operation_id: null,
        claim_owner: null,
        claim_expires_at: null,
        claimed_resource_uid: null,
        space: null,
        worker_name: null,
        worker_resource_uid: null,
        bundle_name: null,
        consumed_receipt_digest: null,
        expires_at: expiresAt,
      });
    },

    async read(organizationId, operationKey) {
      validateOpaqueId(organizationId);
      validateOperationKey(operationKey);
      const row = await readRow(options.sql, organizationId, operationKey);
      if (!row) return null;
      const now = options.clock().getTime();
      if (rowExpired(row, now)) {
        await expireExact(options.sql, row, now);
        return null;
      }
      // Revoked, expired, and indeterminate handoffs carry no live authority
      // and no material. Reporting them as a fifth wire status would invent a
      // vocabulary the contract does not have; absence is the honest answer,
      // and it is also what lets a retry prepare the same operation key again.
      if (!wireStatus(row.state)) return null;
      return projection(row);
    },

    async claim(input) {
      const normalized = normalizeClaimInput(input);
      const now = options.clock().getTime();
      let candidate = await readRow(
        options.sql,
        normalized.organizationId,
        normalized.operationKey,
      );
      if (!candidate) throw new RuntimeInputPreparationError("operation_not_found", 404);
      assertNames(candidate, normalized);
      if (
        candidate.preparation_id !==
        (await derivePreparationId(normalized.organizationId, normalized.operationKey))
      ) {
        throw new RuntimeInputPreparationError("unavailable", 503);
      }
      if (rowExpired(candidate, now)) {
        await expireExact(options.sql, candidate, now);
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      if (candidate.state === "claimed") {
        assertClaimedTarget(candidate, normalized);
        return await decryptClaim(candidate, keys);
      }
      if (candidate.state !== "prepared") {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      const claimExpiresAt = Math.min(candidate.expires_at, now + CLAIM_TTL_MILLISECONDS);
      try {
        await options.sql.run(
          `UPDATE worker_runtime_input_preparations
           SET state = 'claimed', fence = fence + 1,
               host_operation_id = ?, claim_owner = ?, claim_expires_at = ?,
               claimed_resource_uid = ?, space = ?, worker_name = ?,
               worker_resource_uid = ?, bundle_name = ?, updated_at = ?
           WHERE organization_id = ? AND operation_key = ? AND state = 'prepared'
             AND fence = ? AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations
               WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
             )`,
          [
            normalized.claimOwner,
            normalized.claimOwner,
            claimExpiresAt,
            normalized.resourceUid,
            normalized.target.space,
            normalized.target.workerName,
            normalized.target.workerResourceUid,
            normalized.target.bundleName,
            now,
            normalized.organizationId,
            normalized.operationKey,
            candidate.fence,
            now,
            normalized.organizationId,
            normalized.target.workerResourceUid,
          ],
        );
      } catch {
        // An acknowledgement loss is resolved from the exact claim identity below.
      }
      candidate = await readRow(options.sql, normalized.organizationId, normalized.operationKey);
      if (!candidate) throw new RuntimeInputPreparationError("operation_not_found", 404);
      assertNames(candidate, normalized);
      if (candidate.state !== "claimed") throw new RuntimeInputPreparationError("conflict", 409);
      assertClaimedTarget(candidate, normalized);
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

    async abort(input) {
      validateClaimIdentity(input);
      const now = options.clock().getTime();
      try {
        const result = await options.sql.run(
          `UPDATE worker_runtime_input_preparations
           SET state = 'revoked', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
               fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL,
               updated_at = ?, revoked_at = ?
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
      if (!row) throw new RuntimeInputPreparationError("operation_not_found", 404);
      if (
        row.state === "revoked" &&
        row.fence === input.fence + 1 &&
        row.host_operation_id === input.claimOwner &&
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
      const now = options.clock().getTime();
      try {
        const result = await options.sql.run(
          `UPDATE worker_runtime_input_preparations
           SET state = 'dispatched', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
               fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
           WHERE organization_id = ? AND preparation_id = ? AND state = 'claimed'
             AND fence = ? AND claim_owner = ? AND claimed_resource_uid = ?
             AND claim_expires_at > ?
             AND EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations
               WHERE tenant_id = ?
                 AND resource_uid = worker_runtime_input_preparations.worker_resource_uid
                 AND state = 'live'
             )
             AND (
               SELECT COUNT(*) FROM tf_resources AS worker_resource
               WHERE worker_resource.tenant_id = ?
                 AND worker_resource.uid = worker_runtime_input_preparations.worker_resource_uid
                 AND worker_resource.space = worker_runtime_input_preparations.space
                 AND worker_resource.name = worker_runtime_input_preparations.worker_name
                 AND worker_resource.kind = 'ModuleWorker'
             ) = 1
             AND EXISTS (
               SELECT 1 FROM tf_resource_deployments AS deployment
               WHERE deployment.tenant_id = ?
                 AND deployment.resource_uid = worker_runtime_input_preparations.worker_resource_uid
                 AND deployment.state = 'active'
             )`,
          [
            now,
            input.organizationId,
            input.preparationId,
            input.fence,
            input.claimOwner,
            input.resourceUid,
            now,
            input.organizationId,
            input.organizationId,
            input.organizationId,
          ],
        );
        if (result.changes === 1) return { fence: input.fence + 1 };
      } catch {
        // Exact readback below settles an acknowledgement loss without redispatching.
      }
      const row = await readByPreparationId(options.sql, input.organizationId, input.preparationId);
      if (!row) throw new RuntimeInputPreparationError("operation_not_found", 404);
      if (
        row.state === "dispatched" &&
        row.fence === input.fence + 1 &&
        row.claimed_resource_uid === input.resourceUid &&
        row.host_operation_id === input.claimOwner
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
      return recoveryIdentity(await readRecoveryRow(options.sql, normalizeClaimInput(input)));
    },

    async consumeRecovered(input) {
      const normalized = normalizeClaimInput(input);
      if (!digest.test(input.receiptDigest)) {
        throw new RuntimeInputPreparationError("invalid_argument", 400);
      }
      const row = await readRecoveryRow(options.sql, normalized);
      if (row.state === "consumed") {
        if (row.consumed_receipt_digest === input.receiptDigest) return;
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      await consumeDispatched(options.sql, options.clock, {
        organizationId: normalized.organizationId,
        preparationId: row.preparation_id,
        claimOwner: normalized.claimOwner,
        resourceUid: normalized.resourceUid,
        fence: row.fence,
        receiptDigest: input.receiptDigest,
      });
    },

    async abandon(input) {
      const normalized = normalizeClaimInput(input);
      const row = await readRow(options.sql, normalized.organizationId, normalized.operationKey);
      if (!row) throw new RuntimeInputPreparationError("operation_not_found", 404);
      assertNames(row, normalized);
      if (row.state === "revoked") {
        if (
          row.host_operation_id === normalized.claimOwner &&
          row.claimed_resource_uid === normalized.resourceUid
        ) {
          return;
        }
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      const exactClaimed =
        row.state === "claimed" &&
        row.claim_owner === normalized.claimOwner &&
        row.claimed_resource_uid === normalized.resourceUid;
      const exactDispatched =
        row.state === "dispatched" &&
        row.host_operation_id === normalized.claimOwner &&
        row.claimed_resource_uid === normalized.resourceUid;
      if (!exactClaimed && !exactDispatched) {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      const now = options.clock().getTime();
      const changed = await options.sql.run(
        `UPDATE worker_runtime_input_preparations
         SET state = 'revoked', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
             fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL,
             updated_at = ?, revoked_at = ?
         WHERE organization_id = ? AND preparation_id = ? AND fence = ?
           AND claimed_resource_uid = ? AND host_operation_id = ?
           AND state IN ('claimed', 'dispatched')`,
        [
          now,
          now,
          normalized.organizationId,
          row.preparation_id,
          row.fence,
          normalized.resourceUid,
          normalized.claimOwner,
        ],
      );
      if (changed.changes === 1) return;
      const observed = await readByPreparationId(
        options.sql,
        normalized.organizationId,
        row.preparation_id,
      );
      if (
        observed?.state === "revoked" &&
        observed.host_operation_id === normalized.claimOwner &&
        observed.claimed_resource_uid === normalized.resourceUid
      ) {
        return;
      }
      throw new RuntimeInputPreparationError("conflict", 409);
    },

    async revoke(organizationId, operationKey) {
      validateOpaqueId(organizationId);
      validateOperationKey(operationKey);
      const now = options.clock().getTime();
      const result = await options.sql.run(
        `UPDATE worker_runtime_input_preparations
         SET state = 'revoked', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
             fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL,
             updated_at = ?, revoked_at = ?
         WHERE organization_id = ? AND operation_key = ? AND state IN ('prepared', 'claimed')`,
        [now, now, organizationId, operationKey],
      );
      if (result.changes === 1) return;
      const row = await readRow(options.sql, organizationId, operationKey);
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
             fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
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
           consumed_receipt_digest = ?, consumed_at = ?, updated_at = ?
       WHERE organization_id = ? AND preparation_id = ? AND state = 'dispatched'
         AND fence = ? AND host_operation_id = ? AND claimed_resource_uid = ?`,
      [
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
  if (!row) throw new RuntimeInputPreparationError("operation_not_found", 404);
  if (
    row.state === "consumed" &&
    row.claimed_resource_uid === input.resourceUid &&
    row.host_operation_id === input.claimOwner &&
    row.consumed_receipt_digest === input.receiptDigest
  ) {
    return;
  }
  throw new RuntimeInputPreparationError("conflict", 409);
}

interface NormalizedPreparation {
  readonly organizationId: string;
  readonly operationKey: string;
  readonly canonicalPublicOrigin: string;
  readonly applyCommitment: `sha256:${string}`;
  readonly bindingNames: readonly string[];
  readonly bindings: Readonly<Record<string, string>>;
}

type PreparationRow = Row & {
  readonly organization_id: string;
  readonly operation_key: string;
  readonly preparation_id: string;
  readonly apply_commitment: `sha256:${string}`;
  readonly canonical_public_origin: string;
  readonly binding_names_json: string;
  readonly sealed_payload: string | null;
  readonly seal_nonce: string | null;
  readonly seal_key_id: string | null;
  readonly state:
    | "prepared"
    | "claimed"
    | "dispatched"
    | "consumed"
    | "revoked"
    | "expired"
    | "indeterminate";
  readonly fence: number;
  readonly host_operation_id: string | null;
  readonly claim_owner: string | null;
  readonly claim_expires_at: number | null;
  readonly claimed_resource_uid: string | null;
  readonly space: string | null;
  readonly worker_name: string | null;
  readonly worker_resource_uid: string | null;
  readonly bundle_name: string | null;
  readonly consumed_receipt_digest: string | null;
  readonly expires_at: number;
};

const ROW_COLUMNS = `organization_id, operation_key, preparation_id, apply_commitment,
            canonical_public_origin, binding_names_json,
            sealed_payload, seal_nonce, seal_key_id, state, fence,
            host_operation_id, claim_owner, claim_expires_at, claimed_resource_uid,
            space, worker_name, worker_resource_uid, bundle_name,
            consumed_receipt_digest, expires_at`;

async function readRow(
  sql: Sql,
  organizationId: string,
  operationKey: string,
): Promise<PreparationRow | null> {
  const rows = await sql.query(
    `SELECT ${ROW_COLUMNS}
     FROM worker_runtime_input_preparations
     WHERE organization_id = ? AND operation_key = ?`,
    [organizationId, operationKey],
  );
  return rows.length === 0 ? null : (rows[0] as PreparationRow);
}

async function readByPreparationId(
  sql: Sql,
  organizationId: string,
  preparationId: string,
): Promise<PreparationRow | null> {
  const rows = await sql.query(
    `SELECT ${ROW_COLUMNS}
     FROM worker_runtime_input_preparations
     WHERE organization_id = ? AND preparation_id = ?`,
    [organizationId, preparationId],
  );
  return rows.length === 0 ? null : (rows[0] as PreparationRow);
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

function normalizeClaimInput(input: RuntimeInputClaimInput): NormalizedClaimInput {
  validateOpaqueId(input.organizationId);
  validateOperationKey(input.operationKey);
  validateOpaqueId(input.claimOwner);
  validateOpaqueId(input.resourceUid);
  validateBoundedText(input.target.space, 128);
  validateBoundedText(input.target.workerName, 128);
  validateBoundedText(input.target.bundleName, 128);
  validateOpaqueId(input.target.workerResourceUid);
  return { ...input, bindingNames: validatedBindingNames(input.bindingNames) };
}

function validatedBindingNames(names: readonly string[]): readonly string[] {
  const sorted = [...names].sort();
  if (
    sorted.length === 0 ||
    sorted.length > MAX_PROVIDER_RUNTIME_INPUT_BINDINGS ||
    new Set(sorted).size !== sorted.length ||
    sorted.some((name) => !bindingName.test(name))
  ) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  return sorted;
}

function assertNames(row: PreparationRow, input: NormalizedClaimInput): void {
  if (
    row.organization_id !== input.organizationId ||
    row.operation_key !== input.operationKey ||
    row.binding_names_json !== JSON.stringify(input.bindingNames)
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
}

function assertClaimedTarget(row: PreparationRow, input: NormalizedClaimInput): void {
  if (
    row.claim_owner !== input.claimOwner ||
    row.host_operation_id !== input.claimOwner ||
    row.claimed_resource_uid !== input.resourceUid ||
    row.space !== input.target.space ||
    row.worker_name !== input.target.workerName ||
    row.worker_resource_uid !== input.target.workerResourceUid ||
    row.bundle_name !== input.target.bundleName
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
}

async function readRecoveryRow(sql: Sql, input: NormalizedClaimInput): Promise<PreparationRow> {
  const row = await readRow(sql, input.organizationId, input.operationKey);
  if (!row) throw new RuntimeInputPreparationError("operation_not_found", 404);
  assertNames(row, input);
  if (
    (row.state !== "dispatched" && row.state !== "consumed") ||
    row.host_operation_id !== input.claimOwner ||
    row.claimed_resource_uid !== input.resourceUid ||
    row.space !== input.target.space ||
    row.worker_name !== input.target.workerName ||
    row.worker_resource_uid !== input.target.workerResourceUid ||
    row.bundle_name !== input.target.bundleName
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
  return row;
}

function recoveryIdentity(row: PreparationRow): RuntimeInputRecoveryIdentity {
  if (!digest.test(row.apply_commitment) || !row.worker_resource_uid || !row.host_operation_id) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  return {
    operationKey: row.operation_key,
    preparationId: row.preparation_id,
    applyCommitment: row.apply_commitment,
    canonicalPublicOrigin: row.canonical_public_origin,
    workerResourceUid: row.worker_resource_uid,
    hostOperationId: row.host_operation_id,
    fence: row.fence,
  };
}

function preparationIdentity(
  claim: RuntimeInputClaim | RuntimeInputRecoveryIdentity,
): ProviderRuntimeInputPreparationIdentity {
  return {
    preparationId: claim.preparationId,
    operationKey: claim.operationKey,
    workerResourceUid: claim.workerResourceUid,
    canonicalPublicOrigin: claim.canonicalPublicOrigin,
    commitment: claim.applyCommitment,
  };
}

function rowExpired(row: PreparationRow, now: number): boolean {
  return (
    (row.state === "prepared" && row.expires_at <= now) ||
    (row.state === "claimed" && (row.claim_expires_at ?? 0) <= now)
  );
}

/**
 * A handoff that never left this Host may be prepared again under the same
 * operation key: a Terraform retry recomputes the same plan-derived key, and
 * refusing it would strand the resource behind an aborted lease. A dispatched
 * or consumed handoff is never replaceable — its values already reached a
 * provider, and the object they configured may exist.
 */
function replaceablePreparation(row: PreparationRow, now: number): boolean {
  if (row.state === "revoked" || row.state === "expired" || row.state === "indeterminate") {
    return true;
  }
  return (row.state === "prepared" || row.state === "claimed") && rowExpired(row, now);
}

async function discardReplaceable(sql: Sql, row: PreparationRow): Promise<void> {
  const removed = await sql.run(
    `DELETE FROM worker_runtime_input_preparations
     WHERE organization_id = ? AND operation_key = ? AND fence = ?
       AND state NOT IN ('dispatched', 'consumed')`,
    [row.organization_id, row.operation_key, row.fence],
  );
  if (removed.changes !== 1) throw new RuntimeInputPreparationError("conflict", 409);
}

async function expireExact(sql: Sql, row: PreparationRow, now: number): Promise<void> {
  if (row.state !== "prepared" && row.state !== "claimed") return;
  const expiryColumn = row.state === "claimed" ? "claim_expires_at" : "expires_at";
  const expiryValue = row.state === "claimed" ? row.claim_expires_at : row.expires_at;
  if (expiryValue === null) return;
  try {
    await sql.run(
      `UPDATE worker_runtime_input_preparations
       SET state = 'expired', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
           fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
       WHERE organization_id = ? AND preparation_id = ? AND state = ? AND fence = ?
         AND ${expiryColumn} = ?`,
      [now, row.organization_id, row.preparation_id, row.state, row.fence, expiryValue],
    );
  } catch {
    // Exact callers re-read or fail closed; the scheduler retries this cleanup.
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
    !row.host_operation_id ||
    !row.worker_resource_uid ||
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
  return {
    operationKey: row.operation_key,
    preparationId: row.preparation_id,
    applyCommitment: row.apply_commitment,
    canonicalPublicOrigin: row.canonical_public_origin,
    workerResourceUid: row.worker_resource_uid,
    hostOperationId: row.host_operation_id,
    fence: row.fence,
    bindings: parseSealedPayload(row, plaintext),
  };
}

function parseSealedPayload(
  row: PreparationRow,
  bytes: Uint8Array,
): Readonly<Record<string, string>> {
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
    Object.keys(payload).sort().join(",") !==
      "applyCommitment,canonicalPublicOrigin,format,values" ||
    payload.format !== SEALED_PAYLOAD_FORMAT ||
    payload.applyCommitment !== row.apply_commitment ||
    payload.canonicalPublicOrigin !== row.canonical_public_origin ||
    typeof payload.values !== "object" ||
    payload.values === null ||
    Array.isArray(payload.values)
  ) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  let parsed: {
    readonly bindings: Readonly<Record<string, string>>;
    readonly names: readonly string[];
  };
  try {
    parsed = validatedBindings(payload.values as Record<string, unknown>);
  } catch {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  if (JSON.stringify(parsed.names) !== row.binding_names_json) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  return parsed.bindings;
}

function canonicalAadFromRow(row: PreparationRow): string {
  return JSON.stringify({
    format: AAD_FORMAT,
    organizationId: row.organization_id,
    operationKey: row.operation_key,
    preparationId: row.preparation_id,
    keyId: row.seal_key_id,
    canonicalPublicOrigin: row.canonical_public_origin,
    applyCommitment: row.apply_commitment,
    bindingNames: bindingNamesFromRow(row),
  });
}

async function markClaimIndeterminate(sql: Sql, row: PreparationRow, now: number): Promise<void> {
  try {
    await sql.run(
      `UPDATE worker_runtime_input_preparations
       SET state = 'indeterminate', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
           fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
       WHERE organization_id = ? AND preparation_id = ? AND state = 'claimed' AND fence = ?`,
      [now, row.organization_id, row.preparation_id, row.fence],
    );
  } catch {
    // Best effort only: the caller still fails closed and no second claim is issued.
  }
}

/**
 * A replay of the one private PUT. The stored ciphertext is opened and compared
 * against the resubmitted values, so a second request that reuses an operation
 * key with different secrets is a conflict rather than a silent overwrite.
 */
async function adoptExisting(
  row: PreparationRow,
  input: NormalizedPreparation,
  keys: ReadonlyMap<string, CryptoKey>,
): Promise<RuntimeInputPreparationProjection> {
  if (
    row.organization_id !== input.organizationId ||
    row.operation_key !== input.operationKey ||
    row.canonical_public_origin !== input.canonicalPublicOrigin ||
    row.apply_commitment !== input.applyCommitment ||
    row.binding_names_json !== JSON.stringify(input.bindingNames)
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
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

async function normalizePreparation(
  input: RuntimeInputPreparationInput,
  hostOrigin: string,
): Promise<NormalizedPreparation> {
  validateOpaqueId(input.organizationId);
  validateOperationKey(input.operationKey);
  if (input.canonicalPublicOrigin !== hostOrigin) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  const applyCommitment = await runtimeInputPublicApplyCommitment(input.publicApply);
  const { bindings, names } = validatedBindings(input.bindings);
  return {
    organizationId: input.organizationId,
    operationKey: input.operationKey,
    canonicalPublicOrigin: input.canonicalPublicOrigin,
    applyCommitment,
    bindingNames: names,
    bindings,
  };
}

function validatedBindings(value: Record<string, unknown>): {
  readonly bindings: Readonly<Record<string, string>>;
  readonly names: readonly string[];
} {
  const names = validatedBindingNames(Object.keys(value));
  const bindings: Record<string, string> = {};
  for (const name of names) {
    const item = value[name];
    // NUL is refused rather than stored: the provider will not send one, and a
    // value carrying it cannot be projected into a runtime binding intact.
    if (typeof item !== "string" || item.includes("\u0000") || hasUnpairedSurrogate(item)) {
      throw new RuntimeInputPreparationError("invalid_argument", 400);
    }
    const bytes = encode(item);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_VALUE_BYTES) {
      throw new RuntimeInputPreparationError("invalid_argument", 400);
    }
    bindings[name] = item;
  }
  return { bindings, names };
}

function canonicalSealedPayload(input: NormalizedPreparation): string {
  return JSON.stringify({
    format: SEALED_PAYLOAD_FORMAT,
    applyCommitment: input.applyCommitment,
    canonicalPublicOrigin: input.canonicalPublicOrigin,
    values: input.bindings,
  });
}

function canonicalAad(input: NormalizedPreparation, preparationId: string, keyId: string): string {
  return JSON.stringify({
    format: AAD_FORMAT,
    organizationId: input.organizationId,
    operationKey: input.operationKey,
    preparationId,
    keyId,
    canonicalPublicOrigin: input.canonicalPublicOrigin,
    applyCommitment: input.applyCommitment,
    bindingNames: input.bindingNames,
  });
}

/**
 * The durable handle is derived rather than taken from the caller: an operation
 * key is chosen by a provider and is not this Host's internal identity for the
 * sealed row.
 */
async function derivePreparationId(organizationId: string, operationKey: string): Promise<string> {
  const commitment = await sha256(
    encode(JSON.stringify({ format: PREPARATION_ID_FORMAT, organizationId, operationKey })),
  );
  return `prep-${commitment.slice("sha256:".length, "sha256:".length + 32)}`;
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
  return await sha256(
    encode(
      JSON.stringify({
        format: RECEIPT_FORMAT,
        preparationId: input.preparation.preparationId,
        applyCommitment: input.preparation.commitment,
        organizationId: input.organizationId,
        operationId: input.operationId,
        resourceUid: input.resourceUid,
        providerReceiptDigest: input.providerReceiptDigest,
      }),
    ),
  );
}

function wireStatus(state: PreparationRow["state"]): RuntimeInputPreparationStatus | null {
  switch (state) {
    case "prepared":
      return "prepared";
    case "claimed":
      return "accepted";
    case "dispatched":
      return "dispatched";
    case "consumed":
      return "consumed";
    default:
      return null;
  }
}

function projection(row: PreparationRow): RuntimeInputPreparationProjection {
  if (!digest.test(row.apply_commitment)) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  const status = wireStatus(row.state);
  if (!status) throw new RuntimeInputPreparationError("conflict", 409);
  return {
    format: RUNTIME_INPUT_PREPARATION_FORMAT,
    status,
    operationKey: row.operation_key,
    applyCommitment: row.apply_commitment,
    canonicalPublicOrigin: row.canonical_public_origin,
    bindingNames: bindingNamesFromRow(row),
    ...(row.host_operation_id ? { hostOperationId: row.host_operation_id } : {}),
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
  if (typeof value !== "string" || !opaqueId.test(value)) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
}

function validateOperationKey(value: string): void {
  if (typeof value !== "string" || !operationKeyPattern.test(value)) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
}

function validateBoundedText(value: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
}

/**
 * A bare origin this deployment can honestly be addressed as. HTTPS everywhere
 * except loopback, which is the one name a machine developing against itself
 * can produce without inventing a certificate.
 */
function validateBareOrigin(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("canonical public origin must be a bare origin");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("canonical public origin must be a bare origin");
  }
}

function utf8(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  const bytes = encode(value);
  if (bytes.byteLength > maximum) throw new RuntimeInputPreparationError("invalid_argument", 400);
  return bytes;
}

/**
 * A lone UTF-16 surrogate encodes as U+FFFD, which would make this Host commit
 * to bytes the caller never sent. Refuse instead of silently substituting.
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const hashed = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  return `sha256:${[...hashed].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
