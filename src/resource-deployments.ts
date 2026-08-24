import type { Clock, JsonObject, Row, Sql } from "./ports.ts";

export type ResourceDeploymentState =
  | "provisioning"
  | "candidate"
  | "active"
  | "draining"
  | "retained"
  | "failed"
  | "deleted";

export interface ResourceDeployment {
  readonly tenantId: string;
  readonly id: string;
  readonly resourceUid: string;
  readonly offeringId: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly nativeId: string;
  /**
   * Whether an IMPORT named this object. A native id this host minted for a
   * resource it created is not an adoption, so the first import onto such a
   * resource records a claim rather than moving one; from that claim onwards
   * the object is immutable for this deployment.
   */
  readonly nativeClaimed: boolean;
  readonly state: ResourceDeploymentState;
  readonly observed: JsonObject;
  readonly outputs: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NewResourceDeployment = Omit<
  ResourceDeployment,
  "createdAt" | "updatedAt" | "nativeClaimed"
> & {
  /** Absent means unclaimed: only an import adopts, and creation mints. */
  readonly nativeClaimed?: boolean;
};

/**
 * Provider-owned Deployment state to commit with the portable Resource.
 *
 * The provider driver may compute this only after an external mutation, but it
 * must not write it independently. The Takoform store applies this projection
 * in the same D1/SQLite batch as the Resource, replay, claims, and Operation.
 */
export type ResourceDeploymentMutation =
  | { readonly kind: "create"; readonly deployment: NewResourceDeployment }
  | {
      readonly kind: "refresh";
      readonly tenantId: string;
      readonly deploymentId: string;
      readonly expectedNativeId: string;
      readonly observed: JsonObject;
      readonly outputs: JsonObject;
    }
  | {
      readonly kind: "claim";
      readonly tenantId: string;
      readonly deploymentId: string;
      readonly expectedNativeId: string;
      readonly nativeId: string;
      readonly observed: JsonObject;
      readonly outputs: JsonObject;
    }
  | {
      readonly kind: "delete";
      readonly tenantId: string;
      readonly deploymentId: string;
      readonly expectedNativeId: string;
    }
  | {
      readonly kind: "retain";
      readonly tenantId: string;
      readonly deploymentId: string;
      readonly expectedNativeId: string;
      readonly observed: JsonObject;
      readonly outputs: JsonObject;
    };

export interface ResourceDeploymentStore {
  create(input: NewResourceDeployment): Promise<void>;
  find(tenantId: string, deploymentId: string): Promise<ResourceDeployment | null>;
  findByNative(
    tenantId: string,
    providerInstallationRef: string,
    nativeId: string,
  ): Promise<ResourceDeployment | null>;
  active(tenantId: string, resourceUid: string): Promise<ResourceDeployment | null>;
  forResource(tenantId: string, resourceUid: string): Promise<readonly ResourceDeployment[]>;
  meteringCandidates(limit: number): Promise<readonly ResourceDeployment[]>;
  refresh(
    tenantId: string,
    deploymentId: string,
    expectedNativeId: string,
    observed: JsonObject,
    outputs: JsonObject,
  ): Promise<boolean>;
  /**
   * Record the first adoption of one live deployment: point it at the named
   * object and mark it claimed. It applies only while the deployment is
   * active and holds no claim yet, so a claim can never be moved by a later
   * import — that refusal is the caller's, and this is the fence under it.
   */
  claimNative(input: {
    readonly tenantId: string;
    readonly deploymentId: string;
    readonly expectedNativeId: string;
    readonly nativeId: string;
    readonly observed: JsonObject;
    readonly outputs: JsonObject;
  }): Promise<boolean>;
  markDeleted(tenantId: string, deploymentId: string, expectedNativeId: string): Promise<boolean>;
  markRetained(
    tenantId: string,
    deploymentId: string,
    expectedNativeId: string,
    observed: JsonObject,
    outputs: JsonObject,
  ): Promise<boolean>;
  cutover(
    tenantId: string,
    resourceUid: string,
    expectedActiveDeploymentId: string,
    candidateDeploymentId: string,
  ): Promise<boolean>;
}

/** Durable placement state; provider execution stays behind Provider Pack ports. */
export function createResourceDeploymentStore(sql: Sql, clock: Clock): ResourceDeploymentStore {
  const now = () => clock().getTime();

  return {
    async create(input): Promise<void> {
      const timestamp = now();
      const written = await sql.run(
        `INSERT INTO tf_resource_deployments
           (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
            provider_installation_ref, native_id, native_claimed, state, observed_json,
            outputs_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.tenantId,
          input.id,
          input.resourceUid,
          input.offeringId,
          input.providerPackRef,
          input.providerInstallationRef,
          input.nativeId,
          input.nativeClaimed === true ? 1 : 0,
          input.state,
          JSON.stringify(input.observed),
          JSON.stringify(input.outputs),
          timestamp,
          timestamp,
        ],
      );
      if (written.changes !== 1) throw new Error("resource_deployment_create_failed");
    },

    async find(tenantId, deploymentId): Promise<ResourceDeployment | null> {
      const rows = await sql.query(
        `SELECT * FROM tf_resource_deployments WHERE tenant_id = ? AND id = ? LIMIT 2`,
        [tenantId, deploymentId],
      );
      return one(rows);
    },

    async findByNative(tenantId, providerInstallationRef, nativeId) {
      // Only a deployment that still GOVERNS its object holds it. A deleted one
      // released its native resource when it was destroyed, a retained one
      // deliberately stopped managing it, and a failed one never took it up;
      // leaving any of them in the claim lookup would make a
      // destroyed-and-re-created object unmanageable forever, and would hold it
      // against every other Form kind as well as its own.
      const rows = await sql.query(
        `SELECT * FROM tf_resource_deployments
         WHERE tenant_id = ? AND provider_installation_ref = ? AND native_id = ?
           AND state IN ('provisioning', 'candidate', 'active', 'draining') LIMIT 2`,
        [tenantId, providerInstallationRef, nativeId],
      );
      return one(rows);
    },

    async active(tenantId, resourceUid): Promise<ResourceDeployment | null> {
      const rows = await sql.query(
        `SELECT * FROM tf_resource_deployments
         WHERE tenant_id = ? AND resource_uid = ? AND state = 'active' LIMIT 2`,
        [tenantId, resourceUid],
      );
      return one(rows);
    },

    async forResource(tenantId, resourceUid): Promise<readonly ResourceDeployment[]> {
      const rows = await sql.query(
        `SELECT * FROM tf_resource_deployments
         WHERE tenant_id = ? AND resource_uid = ?
         ORDER BY CASE state
           WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 WHEN 'provisioning' THEN 2
           WHEN 'draining' THEN 3 WHEN 'retained' THEN 4 WHEN 'failed' THEN 5 ELSE 6
         END, created_at, id`,
        [tenantId, resourceUid],
      );
      return rows.map(deployment);
    },

    async meteringCandidates(limit): Promise<readonly ResourceDeployment[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("resource_deployment_metering_limit_invalid");
      }
      const timestamp = now();
      const rows = await sql.query(
        `SELECT deployment.* FROM tf_resource_deployments AS deployment
         LEFT JOIN provider_meter_schedule AS schedule
           ON schedule.tenant_id = deployment.tenant_id
          AND schedule.deployment_id = deployment.id
         WHERE deployment.state = 'active'
           AND COALESCE(schedule.lease_until, 0) <= ?
           AND COALESCE(schedule.next_at, deployment.created_at) <= ?
         ORDER BY COALESCE(schedule.next_at, deployment.created_at),
                  deployment.tenant_id, deployment.id
         LIMIT ?`,
        [timestamp, timestamp, limit],
      );
      return rows.map(deployment);
    },

    async refresh(tenantId, deploymentId, expectedNativeId, observed, outputs) {
      const changed = await sql.run(
        `UPDATE tf_resource_deployments
         SET observed_json = ?, outputs_json = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'`,
        [
          JSON.stringify(observed),
          JSON.stringify(outputs),
          now(),
          tenantId,
          deploymentId,
          expectedNativeId,
        ],
      );
      return changed.changes === 1;
    },

    async claimNative(input) {
      const changed = await sql.run(
        `UPDATE tf_resource_deployments
         SET native_id = ?, native_claimed = 1, observed_json = ?, outputs_json = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND native_id = ? AND native_claimed = 0
           AND state = 'active'`,
        [
          input.nativeId,
          JSON.stringify(input.observed),
          JSON.stringify(input.outputs),
          now(),
          input.tenantId,
          input.deploymentId,
          input.expectedNativeId,
        ],
      );
      return changed.changes === 1;
    },

    async markDeleted(tenantId, deploymentId, expectedNativeId) {
      const changed = await sql.run(
        `UPDATE tf_resource_deployments SET state = 'deleted', updated_at = ?
         WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'`,
        [now(), tenantId, deploymentId, expectedNativeId],
      );
      return changed.changes === 1;
    },

    async markRetained(tenantId, deploymentId, expectedNativeId, observed, outputs) {
      const changed = await sql.run(
        `UPDATE tf_resource_deployments
         SET state = 'retained', observed_json = ?, outputs_json = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'`,
        [
          JSON.stringify(observed),
          JSON.stringify(outputs),
          now(),
          tenantId,
          deploymentId,
          expectedNativeId,
        ],
      );
      return changed.changes === 1;
    },

    async cutover(tenantId, resourceUid, expectedActiveDeploymentId, candidateDeploymentId) {
      if (expectedActiveDeploymentId === candidateDeploymentId) return false;
      const changed = await sql.run(
        `UPDATE tf_resource_deployments
         SET state = CASE id WHEN ? THEN 'retained' WHEN ? THEN 'active' ELSE state END,
             updated_at = ?
         WHERE tenant_id = ? AND resource_uid = ?
           AND id IN (?, ?)
           AND 2 = (
             SELECT COUNT(*) FROM tf_resource_deployments
             WHERE tenant_id = ? AND resource_uid = ?
               AND ((id = ? AND state = 'active') OR (id = ? AND state = 'candidate'))
           )`,
        [
          expectedActiveDeploymentId,
          candidateDeploymentId,
          now(),
          tenantId,
          resourceUid,
          expectedActiveDeploymentId,
          candidateDeploymentId,
          tenantId,
          resourceUid,
          expectedActiveDeploymentId,
          candidateDeploymentId,
        ],
      );
      return changed.changes === 2;
    },
  };
}

function one(rows: readonly Row[]): ResourceDeployment | null {
  if (rows.length > 1) throw new Error("resource_deployment_ambiguous");
  return rows[0] ? deployment(rows[0]) : null;
}

function deployment(row: Row): ResourceDeployment {
  return {
    tenantId: text(row.tenant_id),
    id: text(row.id),
    resourceUid: text(row.resource_uid),
    offeringId: text(row.offering_id),
    providerPackRef: text(row.provider_pack_ref),
    providerInstallationRef: text(row.provider_installation_ref),
    nativeId: text(row.native_id),
    nativeClaimed: integer(row.native_claimed) === 1,
    state: state(row.state),
    observed: json(row.observed_json),
    outputs: json(row.outputs_json),
    createdAt: new Date(integer(row.created_at)).toISOString(),
    updatedAt: new Date(integer(row.updated_at)).toISOString(),
  };
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("resource_deployment_row_invalid");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("resource_deployment_row_invalid");
  }
  return value;
}

function json(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(text(value));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("resource_deployment_row_invalid");
  }
  return parsed as JsonObject;
}

function state(value: unknown): ResourceDeploymentState {
  if (
    value !== "provisioning" &&
    value !== "candidate" &&
    value !== "active" &&
    value !== "draining" &&
    value !== "retained" &&
    value !== "failed" &&
    value !== "deleted"
  ) {
    throw new Error("resource_deployment_row_invalid");
  }
  return value;
}
