import type { Clock, Row, Sql } from "./ports.ts";
import {
  MAX_PROVIDER_RUNTIME_INPUT_BINDINGS,
  type ProviderRuntimeInputLeasePort,
  type ProviderRuntimeInputPreparationIdentity,
} from "./provider-runtime-input-port.ts";
import type {
  BoundWorkerEndpointOriginReservation,
  WorkerEndpointOriginReservations,
} from "./worker-endpoint-origin-reservations.ts";

export const RUNTIME_INPUT_PREPARATION_FORMAT =
  "takoserver.worker-runtime-input-preparation@v1" as const;

const SEALED_PAYLOAD_FORMAT = "takoserver.worker-runtime-input-sealed-payload@v1" as const;
const AAD_FORMAT = "takoserver.worker-runtime-input-aad@v1" as const;
export const RUNTIME_INPUT_PREFLIGHT_FORMAT =
  "takoserver.worker-runtime-input-preflight.v1" as const;
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
  readonly originReservationId: string;
}

export interface RuntimeInputPreparationInput {
  readonly organizationId: string;
  readonly operationId: string;
  readonly materialSetId: string;
  readonly materialSetNonce: string;
  /** Plan-known commitment recomputed from the reservation and exact values. */
  readonly runtimeInputReference: string;
  readonly target: RuntimeInputPreparationTarget;
  readonly bindings: Readonly<Record<string, string>>;
}

export interface RuntimeInputPreflightDocument {
  readonly format: typeof RUNTIME_INPUT_PREFLIGHT_FORMAT;
  readonly materialSetNonce: string;
  readonly target: {
    readonly space: string;
    readonly workerName: string;
    readonly bundleName: string;
    readonly endpointName: string;
    readonly originReservationId: string;
    readonly canonicalPublicOrigin: string;
  };
  readonly bindings: Readonly<Record<string, string>>;
}

/** Cross-language plan-time reference derivation shared by preflight clients. */
export async function deriveRuntimeInputReference(input: RuntimeInputPreflightDocument): Promise<{
  readonly preparationId: string;
  readonly commitment: `sha256:${string}`;
  readonly runtimeInputReference: string;
}> {
  if (input.format !== RUNTIME_INPUT_PREFLIGHT_FORMAT) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  validateOpaqueId(input.materialSetNonce);
  for (const value of Object.values(input.target)) validateBoundedText(value, 2_048);
  validateCanonicalOrigin(input.target.canonicalPublicOrigin);
  const names = Object.keys(input.bindings).sort();
  if (
    names.length === 0 ||
    names.length > MAX_PROVIDER_RUNTIME_INPUT_BINDINGS ||
    names.some((name) => !bindingName.test(name))
  ) {
    throw new RuntimeInputPreparationError("invalid_argument", 400);
  }
  const bindings: Record<string, string> = {};
  for (const name of names) {
    const value = input.bindings[name];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      hasUnpairedSurrogate(value) ||
      encode(value).byteLength > MAX_VALUE_BYTES
    ) {
      throw new RuntimeInputPreparationError("invalid_argument", 400);
    }
    bindings[name] = value;
  }
  const canonical = crossLanguageJson({
    format: RUNTIME_INPUT_PREFLIGHT_FORMAT,
    materialSetNonce: input.materialSetNonce,
    target: {
      space: input.target.space,
      workerName: input.target.workerName,
      bundleName: input.target.bundleName,
      endpointName: input.target.endpointName,
      originReservationId: input.target.originReservationId,
      canonicalPublicOrigin: input.target.canonicalPublicOrigin,
    },
    bindings,
  });
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encode(canonical) as unknown as BufferSource),
  );
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const preparationId = `prep-${hex.slice(0, 32)}`;
  const commitment = `sha256:${hex}` as const;
  return {
    preparationId,
    commitment,
    runtimeInputReference: runtimeInputReferenceValue(preparationId, commitment),
  };
}

/**
 * Go's encoding/json always escapes the two ECMAScript line-separator scalars
 * even with HTML escaping disabled. Preserve that exact wire behavior so a
 * provider-computed plan reference and the server commitment are byte-equal.
 */
function crossLanguageJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

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

export interface RuntimeInputClaim {
  readonly operationId: string;
  readonly preparationId: string;
  readonly preparationCommitment: `sha256:${string}`;
  readonly fence: number;
  readonly materialSetId: string;
  readonly canonicalPublicOrigin: string;
  readonly originReservationId: string;
  readonly workerResourceUid: string;
  readonly workerResourceRevision: string;
  readonly originReservationRevision: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
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

export type RuntimeInputDispatchIdentity = RuntimeInputClaimIdentity;

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
  prepare(input: BoundRuntimeInputPreparationInput): Promise<RuntimeInputPreparationProjection>;
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
  /** Revokes an exact claimed/dispatched handoff after proven provider absence. */
  abandon(input: Omit<RuntimeInputRecoveredConsumption, "receiptDigest">): Promise<void>;
  revoke(organizationId: string, operationId: string): Promise<void>;
  expireDue(limit: number): Promise<number>;
}

export interface RuntimeInputAuthority {
  /** Closed control-plane surface used only by authenticated HTTP routes. */
  readonly preparations: {
    prepare(input: RuntimeInputPreparationInput): Promise<RuntimeInputPreparationProjection>;
    read(
      organizationId: string,
      operationId: string,
    ): Promise<RuntimeInputPreparationProjection | null>;
    revoke(organizationId: string, operationId: string): Promise<void>;
  };
  /** Provider-neutral one-shot lease seam used by concrete provider adapters. */
  readonly leases: ProviderRuntimeInputLeasePort;
  /** Bounded lifecycle cleanup composed into the product scheduler. */
  readonly maintenance: {
    expireDue(limit: number): Promise<number>;
  };
}

export function createRuntimeInputAuthority(
  options: Parameters<typeof createRuntimeInputPreparations>[0] & {
    readonly originReservations: Pick<WorkerEndpointOriginReservations, "bind" | "inspectBound">;
  },
): RuntimeInputAuthority {
  const internals = createRuntimeInputPreparations(options);
  const assertReservation = async (
    organizationId: string,
    target: RuntimeInputPreparationTarget,
    expected?: RuntimeInputRecoveryIdentity,
  ): Promise<BoundWorkerEndpointOriginReservation> => {
    let reservation: BoundWorkerEndpointOriginReservation;
    try {
      reservation = await options.originReservations.inspectBound({
        organizationId,
        reservationId: target.originReservationId,
        space: target.space,
        workerName: target.workerName,
        workerResourceUid: target.workerResourceUid,
      });
    } catch (error) {
      if (error instanceof RuntimeInputPreparationError) throw error;
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error.status === 404 || error.status === 409)
      ) {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      throw new RuntimeInputPreparationError("unavailable", 503);
    }
    if (
      expected &&
      (expected.originReservationId !== reservation.reservationId ||
        expected.canonicalPublicOrigin !== reservation.canonicalPublicOrigin ||
        expected.workerResourceUid !== reservation.binding.workerResourceUid ||
        expected.workerResourceRevision !== reservation.binding.workerResourceRevision ||
        expected.originReservationRevision !== reservation.revision ||
        expected.providerPackRef !== reservation.providerPackRef ||
        expected.providerInstallationRef !== reservation.providerInstallationRef ||
        expected.offeringId !== reservation.offeringId ||
        expected.offeringDigest !== reservation.offeringDigest)
    ) {
      throw new RuntimeInputPreparationError("conflict", 409);
    }
    return reservation;
  };
  const inspect = async (
    input: Parameters<RuntimeInputPreparations["inspect"]>[0],
  ): Promise<RuntimeInputRecoveryIdentity> => {
    const inspected = await internals.inspect(input);
    await assertReservation(
      input.organizationId,
      {
        ...input.target,
        workerResourceUid: inspected.workerResourceUid,
        originReservationId: inspected.originReservationId,
      },
      inspected,
    );
    return inspected;
  };
  return {
    preparations: {
      prepare: async (input) => {
        let reservation: BoundWorkerEndpointOriginReservation;
        try {
          reservation = await options.originReservations.bind({
            organizationId: input.organizationId,
            reservationId: input.target.originReservationId,
            space: input.target.space,
            workerName: input.target.workerName,
            workerResourceUid: input.target.workerResourceUid,
          });
        } catch (error) {
          if (error instanceof RuntimeInputPreparationError) throw error;
          if (
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            (error.status === 404 || error.status === 409)
          ) {
            throw new RuntimeInputPreparationError("conflict", 409);
          }
          throw new RuntimeInputPreparationError("unavailable", 503);
        }
        return await internals.prepare({ ...input, reservation });
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
            await assertReservation(
              input.organizationId,
              {
                space: input.target.space,
                workerName: input.target.workerName,
                workerResourceUid: claim.workerResourceUid,
                bundleName: input.target.bundleName,
                originReservationId: claim.originReservationId,
              },
              claim,
            );
            const dispatched = await internals.dispatch({
              organizationId: input.organizationId,
              preparationId: claim.preparationId,
              claimOwner: input.operationId,
              resourceUid: input.resourceUid,
              fence: claim.fence,
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
      async abandon(input) {
        const reference = runtimeInputReference(input.reference);
        await internals.abandon({
          organizationId: input.organizationId,
          preparationId: reference.preparationId,
          preparationCommitment: reference.commitment,
          claimOwner: input.operationId,
          resourceUid: input.resourceUid,
          target: input.target,
          bindingNames: input.bindingNames,
        });
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
      const reference = await computeBoundRuntimeInputReference(normalized);
      if (input.runtimeInputReference !== reference.value) {
        throw new RuntimeInputPreparationError("invalid_argument", 400);
      }
      const existing = await readRow(
        options.sql,
        normalized.organizationId,
        normalized.operationId,
      );
      if (existing) return await adoptExisting(existing, normalized, keys, options.clock);

      const preparationId = reference.preparationId;
      const preparationCommitment = reference.commitment;
      const createdAt = options.clock().getTime();
      const expiresAt =
        normalized.reservation.status === "activated"
          ? createdAt + PREPARATION_TTL_MILLISECONDS
          : Math.min(
              createdAt + PREPARATION_TTL_MILLISECONDS,
              normalized.reservation.expiresAtEpochMilliseconds,
            );
      if (expiresAt <= createdAt) throw new RuntimeInputPreparationError("conflict", 409);
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
             (organization_id, operation_id, preparation_id, preparation_commitment,
              material_set_id, material_set_nonce,
              space, worker_name, endpoint_name, worker_resource_uid, worker_resource_revision, bundle_name,
              origin_reservation_id, origin_reservation_revision, canonical_public_origin,
              provider_pack_ref, provider_installation_ref, offering_id, offering_digest,
              binding_names_json,
              sealed_payload, seal_nonce, seal_key_id,
              state, fence, claim_owner, claim_expires_at,
              claimed_resource_uid, dispatched_operation_id, consumed_receipt_digest,
              expires_at, created_at, updated_at, consumed_at, revoked_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  'prepared', 1, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL
           WHERE EXISTS (
             SELECT 1 FROM worker_endpoint_origin_reservations
             WHERE organization_id = ? AND reservation_id = ?
               AND revision = ? AND state IN ('bound', 'activated')
               AND (state = 'activated' OR expires_at > ?)
               AND canonical_public_origin = ? AND worker_resource_uid = ?
               AND worker_resource_revision = ? AND provider_pack_ref = ?
               AND provider_installation_ref = ? AND offering_id = ? AND offering_digest = ?
           ) AND EXISTS (
             SELECT 1 FROM tf_resources
             WHERE tenant_id = ? AND uid = ? AND space = ? AND name = ? AND kind = 'ModuleWorker'
               AND revision = ?
           ) AND EXISTS (
             SELECT 1 FROM tf_resource_deployments
             WHERE tenant_id = ? AND resource_uid = ? AND state = 'active'
               AND offering_id = ? AND provider_pack_ref = ? AND provider_installation_ref = ?
           ) AND EXISTS (
             SELECT 1 FROM tf_resource_deletion_attestations
             WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
           )`,
          [
            normalized.organizationId,
            normalized.operationId,
            preparationId,
            preparationCommitment,
            normalized.materialSetId,
            normalized.materialSetNonce,
            normalized.target.space,
            normalized.target.workerName,
            normalized.reservation.binding.endpointName,
            normalized.target.workerResourceUid,
            normalized.reservation.binding.workerResourceRevision,
            normalized.target.bundleName,
            normalized.target.originReservationId,
            Number(normalized.reservation.revision),
            normalized.canonicalPublicOrigin,
            normalized.reservation.providerPackRef,
            normalized.reservation.providerInstallationRef,
            normalized.reservation.offeringId,
            normalized.reservation.offeringDigest,
            JSON.stringify(normalized.bindingNames),
            base64Url(new Uint8Array(ciphertext)),
            base64Url(nonce),
            key.keyId,
            expiresAt,
            createdAt,
            createdAt,
            normalized.organizationId,
            normalized.target.originReservationId,
            Number(normalized.reservation.revision),
            createdAt,
            normalized.canonicalPublicOrigin,
            normalized.target.workerResourceUid,
            normalized.reservation.binding.workerResourceRevision,
            normalized.reservation.providerPackRef,
            normalized.reservation.providerInstallationRef,
            normalized.reservation.offeringId,
            normalized.reservation.offeringDigest,
            normalized.organizationId,
            normalized.target.workerResourceUid,
            normalized.target.space,
            normalized.target.workerName,
            normalized.reservation.binding.workerResourceRevision,
            normalized.organizationId,
            normalized.target.workerResourceUid,
            normalized.reservation.offeringId,
            normalized.reservation.providerPackRef,
            normalized.reservation.providerInstallationRef,
            normalized.organizationId,
            normalized.target.workerResourceUid,
          ],
        );
        if (inserted.changes !== 1) {
          throw new RuntimeInputPreparationError("conflict", 409);
        }
      } catch {
        const raced = await readRow(options.sql, normalized.organizationId, normalized.operationId);
        if (raced) return await adoptExisting(raced, normalized, keys, options.clock);
        throw new RuntimeInputPreparationError("unavailable", 503);
      }

      return projection({
        organization_id: normalized.organizationId,
        operation_id: normalized.operationId,
        preparation_id: preparationId,
        preparation_commitment: preparationCommitment,
        material_set_id: normalized.materialSetId,
        material_set_nonce: normalized.materialSetNonce,
        space: normalized.target.space,
        worker_name: normalized.target.workerName,
        endpoint_name: normalized.reservation.binding.endpointName,
        worker_resource_uid: normalized.target.workerResourceUid,
        worker_resource_revision: normalized.reservation.binding.workerResourceRevision,
        bundle_name: normalized.target.bundleName,
        origin_reservation_id: normalized.target.originReservationId,
        origin_reservation_revision: Number(normalized.reservation.revision),
        canonical_public_origin: normalized.canonicalPublicOrigin,
        provider_pack_ref: normalized.reservation.providerPackRef,
        provider_installation_ref: normalized.reservation.providerInstallationRef,
        offering_id: normalized.reservation.offeringId,
        offering_digest: normalized.reservation.offeringDigest,
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
      if (candidate.preparation_commitment !== validatedReferenceCommitment(candidate)) {
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
                 AND resource_uid = worker_runtime_input_preparations.worker_resource_uid
                 AND state = 'live'
             )
             AND EXISTS (
               SELECT 1 FROM worker_endpoint_origin_reservations AS reservation
               WHERE reservation.organization_id = ?
                 AND reservation.reservation_id = worker_runtime_input_preparations.origin_reservation_id
                 AND reservation.revision = worker_runtime_input_preparations.origin_reservation_revision
                 AND reservation.state IN ('bound', 'activated')
                 AND (reservation.state = 'activated' OR reservation.expires_at > ?)
                 AND reservation.worker_resource_uid = worker_runtime_input_preparations.worker_resource_uid
                 AND reservation.worker_resource_revision = worker_runtime_input_preparations.worker_resource_revision
                 AND reservation.provider_pack_ref = worker_runtime_input_preparations.provider_pack_ref
                 AND reservation.provider_installation_ref = worker_runtime_input_preparations.provider_installation_ref
                 AND reservation.offering_id = worker_runtime_input_preparations.offering_id
                 AND reservation.offering_digest = worker_runtime_input_preparations.offering_digest
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
            normalized.organizationId,
            now,
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
      if (row.preparation_commitment !== validatedReferenceCommitment(row)) {
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
                 AND resource_uid = worker_runtime_input_preparations.worker_resource_uid
                 AND state = 'live'
             )
             AND EXISTS (
               SELECT 1 FROM worker_endpoint_origin_reservations AS reservation
               WHERE reservation.organization_id = ?
                 AND reservation.reservation_id = worker_runtime_input_preparations.origin_reservation_id
                 AND reservation.revision = worker_runtime_input_preparations.origin_reservation_revision
                 AND reservation.state IN ('bound', 'activated')
                 AND (reservation.state = 'activated' OR reservation.expires_at > ?)
                 AND reservation.canonical_public_origin = worker_runtime_input_preparations.canonical_public_origin
                 AND reservation.worker_resource_uid = worker_runtime_input_preparations.worker_resource_uid
                 AND reservation.worker_resource_revision = worker_runtime_input_preparations.worker_resource_revision
                 AND reservation.provider_pack_ref = worker_runtime_input_preparations.provider_pack_ref
                 AND reservation.provider_installation_ref = worker_runtime_input_preparations.provider_installation_ref
                 AND reservation.offering_id = worker_runtime_input_preparations.offering_id
                 AND reservation.offering_digest = worker_runtime_input_preparations.offering_digest
             )
             AND (
               SELECT COUNT(*) FROM tf_resources AS worker_resource
               WHERE worker_resource.tenant_id = ?
                 AND worker_resource.uid = worker_runtime_input_preparations.worker_resource_uid
                 AND worker_resource.space = worker_runtime_input_preparations.space
                 AND worker_resource.name = worker_runtime_input_preparations.worker_name
                 AND worker_resource.kind = 'ModuleWorker'
                 AND worker_resource.revision = worker_runtime_input_preparations.worker_resource_revision
             ) = 1
             AND EXISTS (
               SELECT 1 FROM tf_resource_deployments AS deployment
               WHERE deployment.tenant_id = ?
                 AND deployment.resource_uid = worker_runtime_input_preparations.worker_resource_uid
                 AND deployment.state = 'active'
                 AND deployment.offering_id = worker_runtime_input_preparations.offering_id
                 AND deployment.provider_pack_ref = worker_runtime_input_preparations.provider_pack_ref
                 AND deployment.provider_installation_ref = worker_runtime_input_preparations.provider_installation_ref
             )`,
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
            now,
            input.organizationId,
            input.organizationId,
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

    async abandon(input) {
      const normalized = normalizeRecoveredInput(input);
      const row = await readByPreparationId(
        options.sql,
        normalized.organizationId,
        normalized.preparationId,
      );
      if (!row) throw new RuntimeInputPreparationError("not_found", 404);
      assertClaimMatches(row, normalized);
      if (
        row.preparation_commitment !== normalized.preparationCommitment ||
        row.preparation_commitment !== validatedReferenceCommitment(row)
      ) {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      const exactClaimed =
        row.state === "claimed" &&
        row.claim_owner === normalized.claimOwner &&
        row.claimed_resource_uid === normalized.resourceUid;
      const exactDispatched =
        row.state === "dispatched" &&
        row.dispatched_operation_id === normalized.claimOwner &&
        row.claimed_resource_uid === normalized.resourceUid;
      if (row.state === "revoked") {
        if (
          row.dispatched_operation_id === normalized.claimOwner &&
          row.claimed_resource_uid === normalized.resourceUid
        ) {
          return;
        }
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      if (!exactClaimed && !exactDispatched) {
        throw new RuntimeInputPreparationError("conflict", 409);
      }
      const now = options.clock().getTime();
      const changed = await options.sql.run(
        `UPDATE worker_runtime_input_preparations
         SET state = 'revoked', sealed_payload = NULL, seal_nonce = NULL, seal_key_id = NULL,
             fence = fence + 1, claim_owner = NULL, claim_expires_at = NULL,
             dispatched_operation_id = ?, updated_at = ?, revoked_at = ?
         WHERE organization_id = ? AND preparation_id = ? AND fence = ?
           AND claimed_resource_uid = ?
           AND (
             (state = 'claimed' AND claim_owner = ?)
             OR (state = 'dispatched' AND dispatched_operation_id = ?)
           )`,
        [
          normalized.claimOwner,
          now,
          now,
          normalized.organizationId,
          normalized.preparationId,
          row.fence,
          normalized.resourceUid,
          normalized.claimOwner,
          normalized.claimOwner,
        ],
      );
      if (changed.changes === 1) return;
      const observed = await readByPreparationId(
        options.sql,
        normalized.organizationId,
        normalized.preparationId,
      );
      if (
        observed?.state === "revoked" &&
        observed.dispatched_operation_id === normalized.claimOwner &&
        observed.claimed_resource_uid === normalized.resourceUid
      ) {
        return;
      }
      throw new RuntimeInputPreparationError("conflict", 409);
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

interface BoundRuntimeInputPreparationInput extends RuntimeInputPreparationInput {
  readonly reservation: BoundWorkerEndpointOriginReservation;
}

interface RuntimeInputBoundReservation extends BoundWorkerEndpointOriginReservation {
  readonly binding: BoundWorkerEndpointOriginReservation["binding"] & {
    readonly endpointName: string;
  };
}

interface NormalizedInput extends Omit<BoundRuntimeInputPreparationInput, "reservation"> {
  readonly reservation: RuntimeInputBoundReservation;
  readonly canonicalPublicOrigin: string;
  readonly bindingNames: readonly string[];
  readonly bindings: Readonly<Record<string, string>>;
}

type PreparationRow = Row & {
  readonly organization_id: string;
  readonly operation_id: string;
  readonly preparation_id: string;
  readonly preparation_commitment: `sha256:${string}`;
  readonly material_set_id: string;
  readonly material_set_nonce: string;
  readonly space: string;
  readonly worker_name: string;
  readonly endpoint_name: string;
  readonly worker_resource_uid: string;
  readonly worker_resource_revision: string;
  readonly bundle_name: string;
  readonly origin_reservation_id: string;
  readonly origin_reservation_revision: number;
  readonly canonical_public_origin: string;
  readonly provider_pack_ref: string;
  readonly provider_installation_ref: string;
  readonly offering_id: string;
  readonly offering_digest: `sha256:${string}`;
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
    `SELECT organization_id, operation_id, preparation_id, preparation_commitment,
            material_set_id, material_set_nonce,
            space, worker_name, endpoint_name, worker_resource_uid, worker_resource_revision,
            bundle_name, origin_reservation_id, origin_reservation_revision,
            canonical_public_origin, provider_pack_ref, provider_installation_ref,
            offering_id, offering_digest, binding_names_json,
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
    `SELECT organization_id, operation_id, preparation_id, preparation_commitment,
            material_set_id, material_set_nonce,
            space, worker_name, endpoint_name, worker_resource_uid, worker_resource_revision,
            bundle_name, origin_reservation_id, origin_reservation_revision,
            canonical_public_origin, provider_pack_ref, provider_installation_ref,
            offering_id, offering_digest, binding_names_json,
            sealed_payload, seal_nonce, seal_key_id, state, fence,
            claim_owner, claim_expires_at, claimed_resource_uid,
            dispatched_operation_id, consumed_receipt_digest, expires_at
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
  if (row.preparation_commitment !== validatedReferenceCommitment(row)) {
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
    originReservationId: row.origin_reservation_id,
    workerResourceUid: row.worker_resource_uid,
    workerResourceRevision: row.worker_resource_revision,
    originReservationRevision: String(row.origin_reservation_revision),
    providerPackRef: row.provider_pack_ref,
    providerInstallationRef: row.provider_installation_ref,
    offeringId: row.offering_id,
    offeringDigest: row.offering_digest,
  };
}

function preparationIdentity(
  claim: RuntimeInputClaim | RuntimeInputRecoveryIdentity,
): ProviderRuntimeInputPreparationIdentity {
  return {
    preparationId: claim.preparationId,
    materialSetId: claim.materialSetId,
    originReservationId: claim.originReservationId,
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
  const reference = await computeBoundRuntimeInputReference(normalized);
  if (
    row.preparation_commitment !== reference.commitment ||
    row.preparation_id !== reference.preparationId ||
    normalized.runtimeInputReference !== reference.value
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
    originReservationId: row.origin_reservation_id,
    workerResourceUid: row.worker_resource_uid,
    workerResourceRevision: row.worker_resource_revision,
    originReservationRevision: String(row.origin_reservation_revision),
    providerPackRef: row.provider_pack_ref,
    providerInstallationRef: row.provider_installation_ref,
    offeringId: row.offering_id,
    offeringDigest: row.offering_digest,
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
      materialSetNonce: row.material_set_nonce,
      runtimeInputReference: runtimeInputReferenceValue(
        row.preparation_id,
        row.preparation_commitment,
      ),
      target: {
        space: row.space,
        workerName: row.worker_name,
        workerResourceUid: row.worker_resource_uid,
        bundleName: row.bundle_name,
        originReservationId: row.origin_reservation_id,
      },
      bindings: payload.values as Readonly<Record<string, string>>,
      reservation: {
        organizationId: row.organization_id,
        reservationId: row.origin_reservation_id,
        canonicalPublicOrigin: row.canonical_public_origin,
        revision: String(row.origin_reservation_revision),
        expiresAtEpochMilliseconds: row.expires_at,
        binding: {
          space: row.space,
          workerName: row.worker_name,
          workerResourceUid: row.worker_resource_uid,
          workerResourceRevision: row.worker_resource_revision,
          endpointName: row.endpoint_name,
        },
        status: "bound",
        providerPackRef: row.provider_pack_ref,
        providerInstallationRef: row.provider_installation_ref,
        offeringId: row.offering_id,
        offeringDigest: row.offering_digest,
      },
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
      originReservationId: row.origin_reservation_id,
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
    row.material_set_nonce !== input.materialSetNonce ||
    row.space !== input.target.space ||
    row.worker_name !== input.target.workerName ||
    row.endpoint_name !== input.reservation.binding.endpointName ||
    row.worker_resource_uid !== input.target.workerResourceUid ||
    row.worker_resource_revision !== input.reservation.binding.workerResourceRevision ||
    row.bundle_name !== input.target.bundleName ||
    row.origin_reservation_id !== input.target.originReservationId ||
    row.origin_reservation_revision !== Number(input.reservation.revision) ||
    row.canonical_public_origin !== input.canonicalPublicOrigin ||
    row.provider_pack_ref !== input.reservation.providerPackRef ||
    row.provider_installation_ref !== input.reservation.providerInstallationRef ||
    row.offering_id !== input.reservation.offeringId ||
    row.offering_digest !== input.reservation.offeringDigest ||
    row.binding_names_json !== JSON.stringify(input.bindingNames)
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
  const reference = await computeBoundRuntimeInputReference(input);
  if (
    row.preparation_commitment !== reference.commitment ||
    row.preparation_id !== reference.preparationId ||
    input.runtimeInputReference !== reference.value
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

function normalizeInput(input: BoundRuntimeInputPreparationInput): NormalizedInput {
  validateOpaqueId(input.organizationId);
  validateOpaqueId(input.operationId);
  validateOpaqueId(input.materialSetId);
  validateOpaqueId(input.materialSetNonce);
  runtimeInputReference(input.runtimeInputReference);
  for (const value of Object.values(input.target)) validateBoundedText(value, 255);
  const reservation = input.reservation;
  if (
    reservation.organizationId !== input.organizationId ||
    reservation.reservationId !== input.target.originReservationId ||
    reservation.binding.space !== input.target.space ||
    reservation.binding.workerName !== input.target.workerName ||
    reservation.binding.workerResourceUid !== input.target.workerResourceUid ||
    reservation.binding.endpointName === undefined ||
    (reservation.status !== "bound" && reservation.status !== "activated") ||
    !Number.isSafeInteger(Number(reservation.revision)) ||
    Number(reservation.revision) < 1 ||
    !digest.test(reservation.offeringDigest)
  ) {
    throw new RuntimeInputPreparationError("conflict", 409);
  }
  validateCanonicalOrigin(reservation.canonicalPublicOrigin);
  for (const value of [
    reservation.binding.endpointName,
    reservation.binding.workerResourceRevision,
    reservation.providerPackRef,
    reservation.providerInstallationRef,
    reservation.offeringId,
  ]) {
    validateBoundedText(value, 255);
  }
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
  const normalizedReservation: RuntimeInputBoundReservation = {
    ...reservation,
    binding: {
      ...reservation.binding,
      endpointName: reservation.binding.endpointName,
    },
  };
  return {
    ...input,
    reservation: normalizedReservation,
    canonicalPublicOrigin: reservation.canonicalPublicOrigin,
    bindings,
    bindingNames,
  };
}

function canonicalSealedPayload(input: NormalizedInput): string {
  return JSON.stringify({
    format: SEALED_PAYLOAD_FORMAT,
    materialSetId: input.materialSetId,
    canonicalPublicOrigin: input.canonicalPublicOrigin,
    values: input.bindings,
  });
}

async function computeBoundRuntimeInputReference(input: NormalizedInput): Promise<{
  readonly preparationId: string;
  readonly commitment: `sha256:${string}`;
  readonly value: string;
}> {
  const derived = await deriveRuntimeInputReference({
    format: RUNTIME_INPUT_PREFLIGHT_FORMAT,
    materialSetNonce: input.materialSetNonce,
    target: {
      space: input.target.space,
      workerName: input.target.workerName,
      bundleName: input.target.bundleName,
      endpointName: input.reservation.binding.endpointName,
      originReservationId: input.target.originReservationId,
      canonicalPublicOrigin: input.canonicalPublicOrigin,
    },
    bindings: input.bindings,
  });
  return {
    preparationId: derived.preparationId,
    commitment: derived.commitment,
    value: derived.runtimeInputReference,
  };
}

/**
 * Validate the durable plan-time reference commitment without pretending it
 * can be recomputed after the secret values have been erased. Worker/resource
 * and material-set identity are fenced by their dedicated columns instead of
 * being overloaded into this commitment.
 */
function validatedReferenceCommitment(row: PreparationRow): `sha256:${string}` {
  bindingNamesFromRow(row);
  if (
    !digest.test(row.preparation_commitment) ||
    row.preparation_id !==
      `prep-${row.preparation_commitment.slice("sha256:".length, "sha256:".length + 32)}`
  ) {
    throw new RuntimeInputPreparationError("unavailable", 503);
  }
  return row.preparation_commitment;
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
  if (match[1] !== `prep-${match[2].slice(0, 32)}`) {
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
      originReservationId: row.origin_reservation_id,
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
