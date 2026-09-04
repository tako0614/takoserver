import { canonicalDigest, isJsonObject, isSha256Digest } from "./json.ts";
import type { Clock, JsonObject, JsonValue, Sql, SqlStatement } from "./ports.ts";
import { SqlError } from "./ports.ts";

export const ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT =
  "takoserver.artifact-consumer-repair-apply@v1" as const;
export const ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT =
  "takoserver.artifact-consumer-repair-status@v1" as const;
export const ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT =
  "takoserver.artifact-consumer-resolution-receipt@v1" as const;

const PLAN_FORMAT = "takoserver.artifact-consumer-repair-plan@v1" as const;
const SNAPSHOT_FORMAT = "takoserver.artifact-consumer-repair-snapshot@v1" as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type Digest = `sha256:${string}`;
type NonEmptyDigests = readonly [Digest, ...Digest[]];
type RepairPath = "retained-closed" | "retained-historical" | "active-resource";
type RepairAction = "verify-native-absence" | "verify-artifact-consumption";
type ArtifactConsumerResolution =
  | "terminalized_absent"
  | "attributed_manifest"
  | "verified_zero_consumption";

export type ArtifactConsumptionReadback =
  | {
      readonly outcome: "absent";
      readonly evidence: JsonObject;
    }
  | {
      readonly outcome: "present";
      readonly consumption: "none";
      readonly evidence: JsonObject;
    }
  | {
      readonly outcome: "present";
      readonly consumption: "identified";
      /** Non-empty, sorted digests identified by provider-owned state. */
      readonly manifestDigests: NonEmptyDigests;
      readonly evidence: JsonObject;
    }
  | {
      readonly outcome: "indeterminate";
      readonly reason:
        | "unsupported"
        | "unavailable"
        | "transport"
        | "malformed"
        | "authority_unavailable";
      readonly retryable: boolean;
    };

export type ArtifactNativeAbsenceReadback =
  | { readonly outcome: "absent" | "present"; readonly evidence: JsonObject }
  | {
      readonly outcome: "indeterminate";
      readonly reason:
        | "unsupported"
        | "unavailable"
        | "transport"
        | "malformed"
        | "authority_unavailable";
      readonly retryable: boolean;
    };

export interface ArtifactConsumerProviderDeployment {
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly resourceUid: string;
  readonly offeringId: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly nativeId: string;
  readonly state: "active" | "retained";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly observed: JsonObject;
  readonly outputs: JsonObject;
}

/**
 * Fresh, read-only provider evidence used only by the lifecycle owner.
 * Implementations must not cache a prior absence as the answer to either
 * method and must not issue provider mutations.
 */
export interface ArtifactConsumerProviderReader {
  verifyNativeAbsence(input: {
    readonly deployment: ArtifactConsumerProviderDeployment;
    readonly address: {
      readonly space: string;
      readonly apiVersion: string;
      readonly kind: string;
      readonly name: string;
    };
    readonly formRef: JsonObject;
  }): Promise<ArtifactNativeAbsenceReadback>;
  verifyArtifactConsumption(input: {
    readonly deployment: ArtifactConsumerProviderDeployment;
    readonly resource:
      | {
          readonly space: string;
          readonly apiVersion: string;
          readonly kind: string;
          readonly name: string;
          readonly uid: string;
          readonly revision: string;
          readonly formRef: JsonObject;
          readonly relationsDigest: Digest;
          readonly providerOperationIds: readonly string[];
        }
      | undefined;
    readonly candidateManifestDigests: readonly Digest[];
  }): Promise<ArtifactConsumptionReadback>;
}

export interface ArtifactConsumerRepairStatus {
  readonly kind: typeof ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT;
  readonly deploymentId: string;
  readonly state: "actionable" | "blocked" | "resolved";
  readonly planDigest: Digest;
  readonly uncertaintyFence: number;
  readonly candidateManifestCount: number;
  readonly path?: RepairPath;
  readonly action?: RepairAction;
  readonly blocker?: string;
  readonly receipt?: ArtifactConsumerResolutionReceipt;
}

export interface ArtifactConsumerResolutionReceipt {
  readonly kind: typeof ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT;
  readonly receiptId: string;
  readonly deploymentId: string;
  readonly uncertaintyFence: number;
  readonly planDigest: Digest;
  readonly resolution: ArtifactConsumerResolution;
  readonly manifestDigest?: Digest;
  readonly createdAt: string;
}

export interface ArtifactConsumerRepair {
  status(tenantId: string, deploymentId: string): Promise<ArtifactConsumerRepairStatus>;
  apply(input: {
    readonly tenantId: string;
    readonly deploymentId: string;
    readonly idempotencyKey: string;
    readonly planDigest: Digest;
  }): Promise<ArtifactConsumerResolutionReceipt>;
}

export class ArtifactConsumerRepairError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_argument"
      | "repair_blocked"
      | "plan_changed"
      | "idempotency_conflict"
      | "backend_unavailable",
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = "ArtifactConsumerRepairError";
  }
}

interface CreateArtifactConsumerRepairOptions {
  readonly sql: Sql;
  readonly provider: ArtifactConsumerProviderReader;
  readonly clock: Clock;
  readonly randomId: () => string;
}

interface DeploymentSnapshot extends Omit<ArtifactConsumerProviderDeployment, "state"> {
  readonly state:
    | "provisioning"
    | "candidate"
    | "active"
    | "draining"
    | "retained"
    | "deleted"
    | "failed";
  readonly createdAt: number;
}

interface UncertaintySnapshot {
  readonly state: "active" | "resolved";
  readonly fence: number;
  readonly reason: "historical_deployment_digest_unknown" | "resource_not_yet_observed";
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

interface ResourceSnapshot {
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  readonly generation: string;
  readonly revision: string;
  readonly resourceJson: string;
  readonly relationsJson: string;
  readonly formRef: JsonObject;
  readonly spec: JsonObject;
  readonly updatedAt: number;
}

interface AttestationSnapshot {
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly formRef: JsonObject;
  readonly state: "live" | "pending" | "closed" | "cancelled";
  readonly closureFence: number;
  readonly effectsJson: string;
}

interface RootSnapshot {
  readonly digest: Digest;
  readonly state: "active" | "released";
  readonly fence: number;
}

interface RepairSnapshot {
  readonly identityJson: string;
  readonly digest: Digest;
  readonly deployment: DeploymentSnapshot;
  readonly uncertainty: UncertaintySnapshot;
  readonly resource: ResourceSnapshot | null;
  readonly relatedResources: readonly ResourceSnapshot[];
  readonly attestation: AttestationSnapshot | null;
  readonly effects: readonly EffectSnapshot[];
  readonly holds: readonly { readonly kind: "manifest" | "blob"; readonly digest: Digest }[];
  readonly manifestRows: ReadonlyMap<Digest, string>;
  readonly roots: readonly RootSnapshot[];
  readonly deletingCandidate: boolean;
}

interface EffectSnapshot {
  readonly eventId: string;
  readonly effectId: string;
  readonly effectKind: string;
  readonly phase: "planned" | "dispatched" | "succeeded" | "cancelled";
  readonly createdAt: number;
  readonly identity: readonly JsonValue[];
}

interface RepairPlan {
  readonly snapshot: RepairSnapshot;
  readonly status: ArtifactConsumerRepairStatus;
  readonly path?: RepairPath;
  readonly action?: RepairAction;
  readonly candidateManifestDigests: readonly Digest[];
  readonly effectSetDigest: Digest;
}

/**
 * One canonical value read by status, re-read before provider evidence, and
 * compared byte-for-byte by the final SQL guard. The arrays have explicit
 * ordering, so D1 and bun:sqlite produce the same snapshot without relying on
 * row order or JavaScript number coercion.
 */
const SNAPSHOT_EXPRESSION = `json_object(
  'deployment', COALESCE((
    SELECT json(json_array(
      tenant_id, id, resource_uid, offering_id, provider_pack_ref,
      provider_installation_ref, native_id, native_claimed, state,
      observed_json, outputs_json, created_at, updated_at
    )) FROM target LIMIT 1
  ), json('null')),
  'uncertainty', COALESCE((
    SELECT json(json_array(state, fence, reason, created_at, resolved_at))
    FROM tf_artifact_consumer_uncertainties
    WHERE tenant_id = (SELECT tenant_id FROM target LIMIT 1)
      AND consumer_kind = 'deployment'
      AND consumer_id = (SELECT id FROM target LIMIT 1)
    LIMIT 1
  ), json('null')),
  'resource', COALESCE((
    SELECT json(json_array(
      resource.tenant_id, resource.space, resource.api_version, resource.kind,
      resource.name, resource.uid, resource.generation, resource.revision,
      resource.resource_json, resource.relations_json, resource.package_digest,
      resource.implementation_digest, resource.updated_at
    ))
    FROM tf_resources AS resource
    WHERE resource.tenant_id = (SELECT tenant_id FROM target LIMIT 1)
      AND resource.uid = (SELECT resource_uid FROM target LIMIT 1)
    LIMIT 1
  ), json('null')),
  'relatedResources', json(COALESCE((
    SELECT json_group_array(json(row_identity)) FROM (
      SELECT json_array(
        related.tenant_id, related.space, related.api_version, related.kind,
        related.name, related.uid, related.generation, related.revision,
        related.resource_json, related.relations_json, related.package_digest,
        related.implementation_digest, related.updated_at
      ) AS row_identity
      FROM tf_resources AS primary_resource
      JOIN json_each(primary_resource.relations_json) AS relation
      JOIN tf_resources AS related
        ON related.tenant_id = primary_resource.tenant_id
       AND related.uid = json_extract(relation.value, '$.targetUid')
      WHERE primary_resource.tenant_id = (SELECT tenant_id FROM target LIMIT 1)
        AND primary_resource.uid = (SELECT resource_uid FROM target LIMIT 1)
      ORDER BY related.uid, related.space, related.api_version, related.kind, related.name
    )
  ), '[]')),
  'attestation', COALESCE((
    SELECT json(json_array(
      tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
      state, closure_fence, effects_json, created_at
    ))
    FROM tf_resource_deletion_attestations
    WHERE tenant_id = (SELECT tenant_id FROM target LIMIT 1)
      AND resource_uid = (SELECT resource_uid FROM target LIMIT 1)
    LIMIT 1
  ), json('null')),
  'effects', json(COALESCE((
    SELECT json_group_array(json(row_identity)) FROM (
      SELECT json_array(
        event_id, effect_id, effect_kind, phase, operation_mode,
        provider_pack_ref, provider_installation_ref, native_id, target_json, created_at
      ) AS row_identity
      FROM tf_resource_provider_effects
      WHERE tenant_id = (SELECT tenant_id FROM target LIMIT 1)
        AND resource_uid = (SELECT resource_uid FROM target LIMIT 1)
      ORDER BY created_at, event_id
    )
  ), '[]')),
  'resourceDeployments', json(COALESCE((
    SELECT json_group_array(json(row_identity)) FROM (
      SELECT json_array(
        tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, native_claimed, state,
        observed_json, outputs_json, created_at, updated_at
      ) AS row_identity
      FROM tf_resource_deployments
      WHERE tenant_id = (SELECT tenant_id FROM target LIMIT 1)
        AND resource_uid = (SELECT resource_uid FROM target LIMIT 1)
      ORDER BY id
    )
  ), '[]')),
  'holds', json(COALESCE((
    SELECT json_group_array(json(row_identity)) FROM (
      SELECT json_array(kind, digest) AS row_identity
      FROM tf_artifact_holds
      WHERE tenant_id = (SELECT tenant_id FROM target LIMIT 1)
      ORDER BY kind, digest
    )
  ), '[]')),
  'manifests', json(COALESCE((
    SELECT json_group_array(json(row_identity)) FROM (
      SELECT json_array(manifest.digest, manifest.manifest_json, manifest.created_at) AS row_identity
      FROM tf_artifact_holds AS hold
      JOIN tf_artifact_manifests AS manifest ON manifest.digest = hold.digest
      WHERE hold.tenant_id = (SELECT tenant_id FROM target LIMIT 1)
        AND hold.kind = 'manifest'
      ORDER BY manifest.digest
    )
  ), '[]')),
  'deploymentRoots', json(COALESCE((
    SELECT json_group_array(json(row_identity)) FROM (
      SELECT json_array(
        target_kind, digest, state, fence, expires_at, release_reason,
        created_at, released_at
      ) AS row_identity
      FROM tf_artifact_roots
      WHERE tenant_id = (SELECT tenant_id FROM target LIMIT 1)
        AND root_kind = 'deployment'
        AND root_id = (SELECT id FROM target LIMIT 1)
      ORDER BY target_kind, digest
    )
  ), '[]')),
  'gcCandidates', json(COALESCE((
    SELECT json_group_array(json(row_identity)) FROM (
      SELECT json_array(
        candidate.kind, candidate.digest, candidate.state, candidate.fence,
        candidate.not_before, candidate.expected_etag, candidate.attempts,
        candidate.last_outcome, candidate.created_at, candidate.updated_at,
        candidate.deleted_at
      ) AS row_identity
      FROM tf_artifact_gc_candidates AS candidate
      WHERE EXISTS (
        SELECT 1 FROM tf_artifact_holds AS hold
        WHERE hold.tenant_id = (SELECT tenant_id FROM target LIMIT 1)
          AND hold.kind = candidate.kind AND hold.digest = candidate.digest
      )
      ORDER BY candidate.kind, candidate.digest
    )
  ), '[]'))
)`;

const SNAPSHOT_SQL = `WITH target AS (
  SELECT * FROM tf_resource_deployments WHERE tenant_id = ? AND id = ? LIMIT 2
)
SELECT ${SNAPSHOT_EXPRESSION} AS identity`;

export function createArtifactConsumerRepair(
  options: CreateArtifactConsumerRepairOptions,
): ArtifactConsumerRepair {
  const { sql, provider, clock, randomId } = options;

  return {
    async status(tenantId, deploymentId) {
      validIdentity(tenantId, deploymentId);
      return (await plan(tenantId, deploymentId)).status;
    },

    async apply(input) {
      validIdentity(input.tenantId, input.deploymentId);
      if (!IDEMPOTENCY_KEY.test(input.idempotencyKey) || !isSha256Digest(input.planDigest)) {
        throw new ArtifactConsumerRepairError("invalid_argument", 400);
      }

      const replay = await receiptByIdempotency(input.tenantId, input.idempotencyKey);
      if (replay) {
        if (replay.deploymentId !== input.deploymentId || replay.planDigest !== input.planDigest) {
          throw new ArtifactConsumerRepairError("idempotency_conflict", 409);
        }
        return replay;
      }

      const before = await plan(input.tenantId, input.deploymentId);
      if (before.status.planDigest !== input.planDigest) {
        throw new ArtifactConsumerRepairError("plan_changed", 409);
      }
      if (before.status.state !== "actionable" || !before.path || !before.action) {
        throw new ArtifactConsumerRepairError("repair_blocked", 409);
      }

      const deployment = providerDeployment(before.snapshot.deployment);
      let resolution: ArtifactConsumerResolution;
      let manifestDigest: Digest | undefined;
      let providerEvidence: JsonObject;

      if (before.path === "retained-closed") {
        const attestation = before.snapshot.attestation;
        if (!attestation) throw new ArtifactConsumerRepairError("repair_blocked", 409);
        const readback = await provider.verifyNativeAbsence({
          deployment,
          address: {
            space: attestation.space,
            apiVersion: attestation.apiVersion,
            kind: attestation.kind,
            name: attestation.name,
          },
          formRef: attestation.formRef,
        });
        if (readback.outcome !== "absent") {
          throw new ArtifactConsumerRepairError(
            readback.outcome === "indeterminate" && readback.retryable
              ? "backend_unavailable"
              : "repair_blocked",
            readback.outcome === "indeterminate" && readback.retryable ? 503 : 409,
          );
        }
        resolution = "terminalized_absent";
        providerEvidence = readback.evidence;
      } else {
        const resource = before.snapshot.resource;
        const readback = await provider.verifyArtifactConsumption({
          deployment,
          ...(resource
            ? {
                resource: {
                  space: resource.space,
                  apiVersion: resource.apiVersion,
                  kind: resource.kind,
                  name: resource.name,
                  uid: resource.uid,
                  revision: resource.revision,
                  formRef: resource.formRef,
                  relationsDigest: await canonicalDigest(JSON.parse(resource.relationsJson)),
                  providerOperationIds: before.snapshot.effects
                    .filter(
                      (effect) =>
                        effect.phase === "succeeded" &&
                        (effect.effectKind === "apply" ||
                          effect.effectKind === "import" ||
                          effect.effectKind === "provision") &&
                        (effect.identity[5] === null ||
                          effect.identity[5] === deployment.providerPackRef) &&
                        (effect.identity[6] === null ||
                          effect.identity[6] === deployment.providerInstallationRef) &&
                        (effect.identity[7] === null || effect.identity[7] === deployment.nativeId),
                    )
                    .map((effect) => effect.effectId)
                    .sort(),
                },
              }
            : { resource: undefined }),
          candidateManifestDigests: before.candidateManifestDigests,
        });
        if (readback.outcome === "indeterminate") {
          throw new ArtifactConsumerRepairError(
            readback.retryable ? "backend_unavailable" : "repair_blocked",
            readback.retryable ? 503 : 409,
          );
        }
        if (readback.outcome === "absent") {
          if (before.path === "active-resource") {
            throw new ArtifactConsumerRepairError("repair_blocked", 409);
          }
          resolution = "terminalized_absent";
          providerEvidence = readback.evidence;
        } else if (readback.consumption === "none") {
          if (before.path !== "active-resource") {
            throw new ArtifactConsumerRepairError("repair_blocked", 409);
          }
          resolution = "verified_zero_consumption";
          providerEvidence = readback.evidence;
        } else if (readback.consumption === "identified") {
          const identified = validIdentifiedDigests(readback.manifestDigests);
          const digest = identified[0];
          if (
            identified.length !== 1 ||
            !digest ||
            !before.snapshot.holds.some(
              (hold) => hold.kind === "manifest" && hold.digest === digest,
            ) ||
            !before.snapshot.manifestRows.has(digest)
          ) {
            throw new ArtifactConsumerRepairError("repair_blocked", 409);
          }
          resolution = "attributed_manifest";
          manifestDigest = digest;
          providerEvidence = readback.evidence;
        } else {
          throw new ArtifactConsumerRepairError("repair_blocked", 409);
        }
      }

      // Provider calls are outside SQL. Re-read every bound fact afterwards;
      // a semantically equivalent but differently fenced snapshot is still a
      // changed plan and must be reviewed again.
      const after = await plan(input.tenantId, input.deploymentId);
      if (
        after.status.planDigest !== before.status.planDigest ||
        after.snapshot.identityJson !== before.snapshot.identityJson ||
        after.status.state !== "actionable"
      ) {
        throw new ArtifactConsumerRepairError("plan_changed", 409);
      }

      const providerEvidenceDigest = await canonicalDigest(providerEvidence);
      const now = Math.max(
        clock().getTime(),
        deployment.createdAt,
        deployment.updatedAt,
        before.snapshot.uncertainty.createdAt,
      );
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new ArtifactConsumerRepairError("backend_unavailable", 503);
      }
      const receiptId = await deterministicReceiptId(
        input.tenantId,
        input.deploymentId,
        before.snapshot.uncertainty.fence,
        input.planDigest,
      );
      const guard = randomId();
      if (!IDENTIFIER.test(guard) || guard.length < 3) {
        throw new ArtifactConsumerRepairError("backend_unavailable", 503);
      }
      const statements = commitStatements({
        guard,
        snapshotIdentity: before.snapshot.identityJson,
        tenantId: input.tenantId,
        deploymentId: input.deploymentId,
        deployment,
        uncertainty: before.snapshot.uncertainty,
        receiptId,
        idempotencyKey: input.idempotencyKey,
        planDigest: input.planDigest,
        snapshotDigest: before.snapshot.digest,
        resolution,
        ...(manifestDigest ? { manifestDigest } : {}),
        providerEvidenceDigest,
        now,
      });
      try {
        await sql.batch(statements);
      } catch (error) {
        // D1 may commit a batch and lose only its response. The receipt is the
        // durable readback and is checked before classifying the failure.
        const acknowledged = await receiptByIdempotency(input.tenantId, input.idempotencyKey);
        if (
          acknowledged &&
          acknowledged.deploymentId === input.deploymentId &&
          acknowledged.planDigest === input.planDigest
        ) {
          return acknowledged;
        }
        const byFence = await receiptByFence(
          input.tenantId,
          input.deploymentId,
          before.snapshot.uncertainty.fence,
        );
        if (byFence) {
          if (byFence.planDigest === input.planDigest) return byFence;
          throw new ArtifactConsumerRepairError("plan_changed", 409);
        }
        if (error instanceof SqlError && error.code === "constraint") {
          throw new ArtifactConsumerRepairError("plan_changed", 409);
        }
        throw new ArtifactConsumerRepairError("backend_unavailable", 503);
      }
      const committed = await receiptByIdempotency(input.tenantId, input.idempotencyKey);
      if (!committed) throw new ArtifactConsumerRepairError("backend_unavailable", 503);
      return committed;
    },
  };

  async function plan(tenantId: string, deploymentId: string): Promise<RepairPlan> {
    const snapshot = await readSnapshot(sql, tenantId, deploymentId);
    const phasesByEffect = new Map<string, Set<EffectSnapshot["phase"]>>();
    for (const effect of snapshot.effects) {
      const phases = phasesByEffect.get(effect.effectId) ?? new Set<EffectSnapshot["phase"]>();
      phases.add(effect.phase);
      phasesByEffect.set(effect.effectId, phases);
    }
    // Several phases can share one millisecond. Never infer "latest" from
    // row order: an effect is open exactly when it has no terminal event.
    const hasOpenEffects = [...phasesByEffect.values()].some(
      (phases) => !phases.has("succeeded") && !phases.has("cancelled"),
    );
    const effectSetDigest = await canonicalDigest({
      address: snapshot.attestation
        ? {
            space: snapshot.attestation.space,
            apiVersion: snapshot.attestation.apiVersion,
            kind: snapshot.attestation.kind,
            name: snapshot.attestation.name,
          }
        : null,
      formRef: snapshot.attestation?.formRef ?? null,
      effects: snapshot.effects.map((effect) => effect.identity),
    });

    let path: RepairPath | undefined;
    let action: RepairAction | undefined;
    let blocker: string | undefined;
    let candidates: readonly Digest[] = [];

    if (snapshot.uncertainty.state === "resolved") {
      const receipt = await receiptByFence(
        tenantId,
        deploymentId,
        Math.max(1, snapshot.uncertainty.fence - 1),
      );
      const planDigest = await digestPlan(
        snapshot,
        effectSetDigest,
        [],
        undefined,
        undefined,
        "resolved",
      );
      return {
        snapshot,
        effectSetDigest,
        candidateManifestDigests: [],
        status: {
          kind: ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
          deploymentId,
          state: "resolved",
          planDigest,
          uncertaintyFence: snapshot.uncertainty.fence,
          candidateManifestCount: 0,
          ...(receipt ? { receipt } : {}),
        },
      };
    }

    if (hasOpenEffects) blocker = "open_provider_effect";
    else if (snapshot.deletingCandidate) blocker = "artifact_delete_in_progress";
    else if (snapshot.deployment.state === "retained") {
      if (snapshot.attestation?.state === "closed") {
        path = "retained-closed";
        action = "verify-native-absence";
      } else if (snapshot.attestation) {
        blocker = "deletion_attestation_not_closed";
      } else if (snapshot.uncertainty.reason !== "historical_deployment_digest_unknown") {
        blocker = "uncertainty_reason_mismatch";
      } else {
        path = "retained-historical";
        action = "verify-artifact-consumption";
        candidates = historicalCandidates(snapshot);
        if (candidates.length === 0) blocker = "candidate_manifest_set_empty";
      }
    } else if (snapshot.deployment.state === "active") {
      if (!snapshot.resource) blocker = "current_resource_missing";
      else {
        path = "active-resource";
        action = "verify-artifact-consumption";
        const derived = activeCandidates(snapshot);
        candidates = derived.candidates;
        blocker = derived.blocker;
      }
    } else {
      blocker = "deployment_state_not_repairable";
    }

    if (!blocker && action === "verify-artifact-consumption") {
      const activeRoots = snapshot.roots.filter((root) => root.state === "active");
      if (activeRoots.some((root) => !candidates.includes(root.digest))) {
        blocker = "deployment_root_conflict";
      }
    }
    const state = blocker || !path || !action ? "blocked" : "actionable";
    const planDigest = await digestPlan(
      snapshot,
      effectSetDigest,
      candidates,
      path,
      action,
      blocker ?? null,
    );
    return {
      snapshot,
      ...(path ? { path } : {}),
      ...(action ? { action } : {}),
      candidateManifestDigests: candidates,
      effectSetDigest,
      status: {
        kind: ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
        deploymentId,
        state,
        planDigest,
        uncertaintyFence: snapshot.uncertainty.fence,
        candidateManifestCount: candidates.length,
        ...(path ? { path } : {}),
        ...(action ? { action } : {}),
        ...(blocker ? { blocker } : {}),
      },
    };
  }

  async function receiptByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ArtifactConsumerResolutionReceipt | null> {
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await sql.query(
        `SELECT receipt_id, deployment_id, uncertainty_fence, plan_digest,
                resolution, manifest_digest, created_at
         FROM tf_artifact_consumer_resolution_receipts
         WHERE tenant_id = ? AND idempotency_key = ? LIMIT 2`,
        [tenantId, idempotencyKey],
      );
    } catch {
      throw new ArtifactConsumerRepairError("backend_unavailable", 503);
    }
    return receipt(rows);
  }

  async function receiptByFence(
    tenantId: string,
    deploymentId: string,
    uncertaintyFence: number,
  ): Promise<ArtifactConsumerResolutionReceipt | null> {
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await sql.query(
        `SELECT receipt_id, deployment_id, uncertainty_fence, plan_digest,
                resolution, manifest_digest, created_at
         FROM tf_artifact_consumer_resolution_receipts
         WHERE tenant_id = ? AND deployment_id = ? AND uncertainty_fence = ? LIMIT 2`,
        [tenantId, deploymentId, uncertaintyFence],
      );
    } catch {
      throw new ArtifactConsumerRepairError("backend_unavailable", 503);
    }
    return receipt(rows);
  }
}

async function readSnapshot(
  sql: Sql,
  tenantId: string,
  deploymentId: string,
): Promise<RepairSnapshot> {
  let rows: readonly Record<string, unknown>[];
  try {
    rows = await sql.query(SNAPSHOT_SQL, [tenantId, deploymentId]);
  } catch {
    throw new ArtifactConsumerRepairError("backend_unavailable", 503);
  }
  const identityJson = rows.length === 1 ? rows[0]?.identity : undefined;
  if (typeof identityJson !== "string") {
    throw new ArtifactConsumerRepairError("backend_unavailable", 503);
  }
  let value: unknown;
  try {
    value = JSON.parse(identityJson);
  } catch {
    throw new ArtifactConsumerRepairError("backend_unavailable", 503);
  }
  if (!isJsonObject(value)) throw new ArtifactConsumerRepairError("backend_unavailable", 503);
  const deploymentTuple = tuple(value.deployment);
  if (!deploymentTuple) throw new ArtifactConsumerRepairError("not_found", 404);
  const deployment = deploymentSnapshot(deploymentTuple);
  const uncertaintyTuple = tuple(value.uncertainty);
  if (!uncertaintyTuple) throw new ArtifactConsumerRepairError("not_found", 404);
  const uncertainty = uncertaintySnapshot(uncertaintyTuple);
  const resourceValue = tuple(value.resource);
  const resource = resourceValue ? resourceSnapshot(resourceValue) : null;
  const relatedResources = array(value.relatedResources).map((entry) =>
    resourceSnapshot(requiredTuple(entry)),
  );
  const attestationValue = tuple(value.attestation);
  const attestation = attestationValue ? attestationSnapshot(attestationValue) : null;
  const effects = array(value.effects).map(effectSnapshot);
  const holds: Array<{ readonly kind: "manifest" | "blob"; readonly digest: Digest }> = array(
    value.holds,
  ).map((entry) => {
    const row = requiredTuple(entry);
    const kind = requiredText(row[0]);
    const digest = requiredDigest(row[1]);
    if (kind !== "manifest" && kind !== "blob") invalidSnapshot();
    return { kind: kind as "manifest" | "blob", digest };
  });
  const manifestRows = new Map<Digest, string>();
  for (const entry of array(value.manifests)) {
    const row = requiredTuple(entry);
    const digest = requiredDigest(row[0]);
    const manifestJson = requiredJsonText(row[1]);
    requiredInteger(row[2]);
    if (manifestRows.has(digest)) invalidSnapshot();
    manifestRows.set(digest, manifestJson);
  }
  const roots: RootSnapshot[] = array(value.deploymentRoots).map((entry) => {
    const row = requiredTuple(entry);
    if (requiredText(row[0]) !== "manifest") invalidSnapshot();
    const digest = requiredDigest(row[1]);
    const state = requiredText(row[2]);
    if (state !== "active" && state !== "released") invalidSnapshot();
    return {
      digest,
      state: state as "active" | "released",
      fence: requiredPositiveInteger(row[3]),
    };
  });
  const gcRows = array(value.gcCandidates);
  const deletingCandidate = gcRows.some((entry) => requiredTuple(entry)[2] === "deleting");
  const digest = await canonicalDigest({ format: SNAPSHOT_FORMAT, value });
  return {
    identityJson,
    digest,
    deployment,
    uncertainty,
    resource,
    relatedResources,
    attestation,
    effects,
    holds,
    manifestRows,
    roots,
    deletingCandidate,
  };
}

function deploymentSnapshot(row: readonly JsonValue[]): DeploymentSnapshot {
  const state = requiredText(row[8]);
  if (
    state !== "provisioning" &&
    state !== "candidate" &&
    state !== "active" &&
    state !== "draining" &&
    state !== "retained" &&
    state !== "deleted" &&
    state !== "failed"
  ) {
    invalidSnapshot();
  }
  return {
    tenantId: requiredText(row[0]),
    deploymentId: requiredText(row[1]),
    resourceUid: requiredText(row[2]),
    offeringId: requiredText(row[3]),
    providerPackRef: requiredText(row[4]),
    providerInstallationRef: requiredText(row[5]),
    nativeId: requiredText(row[6]),
    state,
    observed: requiredObjectText(row[9]),
    outputs: requiredObjectText(row[10]),
    createdAt: requiredInteger(row[11]),
    updatedAt: requiredInteger(row[12]),
  };
}

function providerDeployment(snapshot: DeploymentSnapshot): ArtifactConsumerProviderDeployment {
  if (snapshot.state !== "active" && snapshot.state !== "retained") {
    throw new ArtifactConsumerRepairError("repair_blocked", 409);
  }
  return { ...snapshot, state: snapshot.state };
}

function uncertaintySnapshot(row: readonly JsonValue[]): UncertaintySnapshot {
  const state = requiredText(row[0]);
  const reason = requiredText(row[2]);
  if (state !== "active" && state !== "resolved") invalidSnapshot();
  if (reason !== "historical_deployment_digest_unknown" && reason !== "resource_not_yet_observed") {
    invalidSnapshot();
  }
  return {
    state,
    fence: requiredPositiveInteger(row[1]),
    reason,
    createdAt: requiredInteger(row[3]),
    resolvedAt: row[4] === null ? null : requiredInteger(row[4]),
  };
}

function resourceSnapshot(row: readonly JsonValue[]): ResourceSnapshot {
  const resourceJson = requiredJsonText(row[8]);
  const relationsJson = requiredJsonText(row[9]);
  let resource: unknown;
  let relations: unknown;
  try {
    resource = JSON.parse(resourceJson);
    relations = JSON.parse(relationsJson);
  } catch {
    invalidSnapshot();
  }
  if (!isJsonObject(resource) || !Array.isArray(relations)) invalidSnapshot();
  const form = isJsonObject(resource.form) ? resource.form : undefined;
  const formRef = form && isJsonObject(form.formRef) ? form.formRef : undefined;
  const spec = isJsonObject(resource.spec) ? resource.spec : undefined;
  if (!formRef || !spec) invalidSnapshot();
  return {
    space: requiredText(row[1]),
    apiVersion: requiredText(row[2]),
    kind: requiredText(row[3]),
    name: requiredText(row[4]),
    uid: requiredText(row[5]),
    generation: requiredText(row[6]),
    revision: requiredText(row[7]),
    resourceJson,
    relationsJson,
    formRef,
    spec,
    updatedAt: requiredInteger(row[12]),
  };
}

function attestationSnapshot(row: readonly JsonValue[]): AttestationSnapshot {
  const state = requiredText(row[7]);
  if (state !== "live" && state !== "pending" && state !== "closed" && state !== "cancelled") {
    invalidSnapshot();
  }
  return {
    space: requiredText(row[2]),
    apiVersion: requiredText(row[3]),
    kind: requiredText(row[4]),
    name: requiredText(row[5]),
    formRef: requiredObjectText(row[6]),
    state,
    closureFence: requiredPositiveInteger(row[8]),
    effectsJson: requiredJsonText(row[9]),
  };
}

function effectSnapshot(value: JsonValue): EffectSnapshot {
  const row = requiredTuple(value);
  const phase = requiredText(row[3]);
  if (
    phase !== "planned" &&
    phase !== "dispatched" &&
    phase !== "succeeded" &&
    phase !== "cancelled"
  ) {
    invalidSnapshot();
  }
  return {
    eventId: requiredText(row[0]),
    effectId: requiredText(row[1]),
    effectKind: requiredText(row[2]),
    phase,
    createdAt: requiredInteger(row[9]),
    identity: row,
  };
}

function historicalCandidates(snapshot: RepairSnapshot): readonly Digest[] {
  const candidates = snapshot.holds
    .filter((hold) => hold.kind === "manifest")
    .map((hold) => hold.digest)
    .sort();
  return candidates.every((digest) => snapshot.manifestRows.has(digest)) ? candidates : [];
}

function activeCandidates(snapshot: RepairSnapshot): {
  readonly candidates: readonly Digest[];
  readonly blocker?: string;
} {
  const resource = snapshot.resource;
  if (!resource) return { candidates: [], blocker: "current_resource_missing" };
  const digests = new Set<Digest>();
  for (const candidate of [resource, ...snapshot.relatedResources]) {
    const value = candidate.spec.manifestDigest;
    if (value !== undefined) {
      if (!isSha256Digest(value)) return { candidates: [], blocker: "resource_manifest_invalid" };
      digests.add(value);
    }
  }
  const candidates = [...digests].sort();
  if (candidates.length === 0) return { candidates };
  const held = new Set(
    snapshot.holds.filter((hold) => hold.kind === "manifest").map((hold) => hold.digest),
  );
  if (candidates.some((digest) => !held.has(digest) || !snapshot.manifestRows.has(digest))) {
    return { candidates, blocker: "resource_manifest_not_held" };
  }
  return { candidates };
}

async function digestPlan(
  snapshot: RepairSnapshot,
  effectSetDigest: Digest,
  candidates: readonly Digest[],
  path: RepairPath | undefined,
  action: RepairAction | undefined,
  disposition: string | null,
): Promise<Digest> {
  return await canonicalDigest({
    kind: PLAN_FORMAT,
    snapshotDigest: snapshot.digest,
    tenantId: snapshot.deployment.tenantId,
    deploymentId: snapshot.deployment.deploymentId,
    uncertaintyFence: snapshot.uncertainty.fence,
    path: path ?? null,
    action: action ?? null,
    candidateManifestDigests: candidates,
    candidateSetDigest: await canonicalDigest(candidates),
    allTenantHoldsDigest: await canonicalDigest(snapshot.holds),
    effectSetDigest,
    disposition,
  });
}

function commitStatements(input: {
  readonly guard: string;
  readonly snapshotIdentity: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly deployment: ArtifactConsumerProviderDeployment;
  readonly uncertainty: UncertaintySnapshot;
  readonly receiptId: string;
  readonly idempotencyKey: string;
  readonly planDigest: Digest;
  readonly snapshotDigest: Digest;
  readonly resolution: ArtifactConsumerResolution;
  readonly manifestDigest?: Digest;
  readonly providerEvidenceDigest: Digest;
  readonly now: number;
}): readonly SqlStatement[] {
  const snapshotGuard: SqlStatement = {
    sql: `WITH target AS (
            SELECT * FROM tf_resource_deployments WHERE tenant_id = ? AND id = ? LIMIT 2
          )
          INSERT INTO tf_artifact_gc_guards (token, valid)
          SELECT ?, CASE WHEN ${SNAPSHOT_EXPRESSION} = ? THEN 1 ELSE 0 END`,
    params: [input.tenantId, input.deploymentId, input.guard, input.snapshotIdentity],
  };
  const mutations: SqlStatement[] = [snapshotGuard];
  if (input.resolution === "terminalized_absent") {
    mutations.push({
      sql: `UPDATE tf_resource_deployments
            SET state = 'deleted', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND resource_uid = ?
              AND offering_id = ? AND provider_pack_ref = ?
              AND provider_installation_ref = ? AND native_id = ?
              AND state = 'retained' AND updated_at = ?`,
      params: [
        input.now,
        input.tenantId,
        input.deploymentId,
        input.deployment.resourceUid,
        input.deployment.offeringId,
        input.deployment.providerPackRef,
        input.deployment.providerInstallationRef,
        input.deployment.nativeId,
        input.deployment.updatedAt,
      ],
    });
  } else if (input.resolution === "attributed_manifest") {
    mutations.push({
      sql: `INSERT INTO tf_artifact_roots
              (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
               expires_at, release_reason, created_at, released_at)
            SELECT ?, 'deployment', ?, 'manifest', hold.digest, 'active', 1,
                   NULL, NULL, ?, NULL
            FROM tf_artifact_holds AS hold
            JOIN tf_artifact_manifests AS manifest ON manifest.digest = hold.digest
            WHERE hold.tenant_id = ? AND hold.kind = 'manifest' AND hold.digest = ?
            ON CONFLICT (tenant_id, root_kind, root_id, target_kind, digest) DO UPDATE SET
              state = 'active', fence = tf_artifact_roots.fence + 1,
              expires_at = NULL, release_reason = NULL, created_at = excluded.created_at,
              released_at = NULL
            WHERE tf_artifact_roots.state = 'released'`,
      params: [
        input.tenantId,
        input.deploymentId,
        input.deployment.createdAt,
        input.tenantId,
        input.manifestDigest as Digest,
      ],
    });
    mutations.push({
      sql: `UPDATE tf_artifact_consumer_uncertainties
            SET state = 'resolved', fence = fence + 1, resolved_at = ?
            WHERE tenant_id = ? AND consumer_kind = 'deployment'
              AND consumer_id = ? AND state = 'active' AND fence = ? AND reason = ?
              AND EXISTS (
                SELECT 1 FROM tf_artifact_roots
                WHERE tenant_id = ? AND root_kind = 'deployment' AND root_id = ?
                  AND target_kind = 'manifest' AND digest = ? AND state = 'active'
              )`,
      params: [
        input.now,
        input.tenantId,
        input.deploymentId,
        input.uncertainty.fence,
        input.uncertainty.reason,
        input.tenantId,
        input.deploymentId,
        input.manifestDigest as Digest,
      ],
    });
  } else {
    mutations.push({
      sql: `UPDATE tf_artifact_consumer_uncertainties
            SET state = 'resolved', fence = fence + 1, resolved_at = ?
            WHERE tenant_id = ? AND consumer_kind = 'deployment'
              AND consumer_id = ? AND state = 'active' AND fence = ? AND reason = ?`,
      params: [
        input.now,
        input.tenantId,
        input.deploymentId,
        input.uncertainty.fence,
        input.uncertainty.reason,
      ],
    });
  }
  mutations.push({
    sql: `INSERT INTO tf_artifact_consumer_resolution_receipts
            (receipt_id, tenant_id, deployment_id, uncertainty_fence,
             idempotency_key, plan_digest, snapshot_digest, resolution,
             manifest_digest, provider_evidence_digest, deployment_state_before,
             deployment_updated_at_before, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM tf_artifact_consumer_uncertainties
            WHERE tenant_id = ? AND consumer_kind = 'deployment' AND consumer_id = ?
              AND state = 'resolved' AND fence = ?
          )`,
    params: [
      input.receiptId,
      input.tenantId,
      input.deploymentId,
      input.uncertainty.fence,
      input.idempotencyKey,
      input.planDigest,
      input.snapshotDigest,
      input.resolution,
      input.manifestDigest ?? null,
      input.providerEvidenceDigest,
      input.deployment.state,
      input.deployment.updatedAt,
      input.now,
      input.tenantId,
      input.deploymentId,
      input.uncertainty.fence + 1,
    ],
  });
  mutations.push({
    sql: `UPDATE tf_artifact_gc_guards
          SET valid = CASE WHEN EXISTS (
            SELECT 1 FROM tf_artifact_consumer_resolution_receipts
            WHERE receipt_id = ? AND tenant_id = ? AND deployment_id = ?
              AND uncertainty_fence = ? AND idempotency_key = ?
              AND plan_digest = ? AND snapshot_digest = ?
              AND resolution = ? AND manifest_digest IS ?
              AND provider_evidence_digest = ?
              AND deployment_state_before = ?
              AND deployment_updated_at_before = ? AND created_at = ?
          ) THEN 1 ELSE 0 END
          WHERE token = ?`,
    params: [
      input.receiptId,
      input.tenantId,
      input.deploymentId,
      input.uncertainty.fence,
      input.idempotencyKey,
      input.planDigest,
      input.snapshotDigest,
      input.resolution,
      input.manifestDigest ?? null,
      input.providerEvidenceDigest,
      input.deployment.state,
      input.deployment.updatedAt,
      input.now,
      input.guard,
    ],
  });
  mutations.push({
    sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?",
    params: [input.guard],
  });
  return mutations;
}

async function deterministicReceiptId(
  tenantId: string,
  deploymentId: string,
  uncertaintyFence: number,
  planDigest: Digest,
): Promise<string> {
  const digest = await canonicalDigest({
    kind: ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT,
    tenantId,
    deploymentId,
    uncertaintyFence,
    planDigest,
  });
  return `acr_${digest.slice("sha256:".length)}`;
}

function receipt(
  rows: readonly Record<string, unknown>[],
): ArtifactConsumerResolutionReceipt | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new ArtifactConsumerRepairError("backend_unavailable", 503);
  const row = rows[0] as Record<string, unknown>;
  const resolution = requiredText(row.resolution as JsonValue);
  if (
    resolution !== "terminalized_absent" &&
    resolution !== "attributed_manifest" &&
    resolution !== "verified_zero_consumption"
  ) {
    invalidSnapshot();
  }
  const manifestDigest =
    row.manifest_digest === null ? undefined : requiredDigest(row.manifest_digest);
  if ((resolution === "attributed_manifest") !== (manifestDigest !== undefined)) invalidSnapshot();
  return {
    kind: ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT,
    receiptId: requiredText(row.receipt_id as JsonValue),
    deploymentId: requiredText(row.deployment_id as JsonValue),
    uncertaintyFence: requiredPositiveInteger(row.uncertainty_fence as JsonValue),
    planDigest: requiredDigest(row.plan_digest),
    resolution,
    ...(manifestDigest ? { manifestDigest } : {}),
    createdAt: new Date(requiredInteger(row.created_at as JsonValue)).toISOString(),
  };
}

function validIdentifiedDigests(value: unknown): readonly Digest[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isSha256Digest)) return [];
  if (
    value.some((digest, index) => {
      const previous = value[index - 1];
      return index > 0 && (previous === undefined || previous >= digest);
    })
  ) {
    return [];
  }
  return value;
}

function validIdentity(tenantId: string, deploymentId: string): void {
  if (
    tenantId.length < 1 ||
    tenantId.length > 255 ||
    deploymentId.length < 3 ||
    deploymentId.length > 128 ||
    [...tenantId, ...deploymentId].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new ArtifactConsumerRepairError("invalid_argument", 400);
  }
}

function tuple(value: JsonValue | undefined): readonly JsonValue[] | null {
  return value === null || value === undefined ? null : requiredTuple(value);
}

function requiredTuple(value: JsonValue): readonly JsonValue[] {
  if (!Array.isArray(value)) invalidSnapshot();
  return value;
}

function array(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) invalidSnapshot();
  return value;
}

function requiredText(value: JsonValue | unknown): string {
  if (typeof value !== "string" || value.length === 0) invalidSnapshot();
  return value;
}

function requiredInteger(value: JsonValue | unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidSnapshot();
  return value;
}

function requiredPositiveInteger(value: JsonValue | unknown): number {
  const result = requiredInteger(value);
  if (result < 1) invalidSnapshot();
  return result;
}

function requiredDigest(value: JsonValue | unknown): Digest {
  if (!isSha256Digest(value)) invalidSnapshot();
  return value;
}

function requiredJsonText(value: JsonValue | unknown): string {
  const text = requiredText(value);
  try {
    JSON.parse(text);
  } catch {
    invalidSnapshot();
  }
  return text;
}

function requiredObjectText(value: JsonValue | unknown): JsonObject {
  const text = requiredJsonText(value);
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) invalidSnapshot();
  return parsed;
}

function invalidSnapshot(): never {
  throw new ArtifactConsumerRepairError("backend_unavailable", 503);
}
