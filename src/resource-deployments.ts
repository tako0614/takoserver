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
  readonly state: ResourceDeploymentState;
  readonly observed: JsonObject;
  readonly outputs: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NewResourceDeployment = Omit<ResourceDeployment, "createdAt" | "updatedAt">;

export interface ResourceDeploymentStore {
  create(input: NewResourceDeployment): Promise<void>;
  find(tenantId: string, deploymentId: string): Promise<ResourceDeployment | null>;
  active(tenantId: string, resourceUid: string): Promise<ResourceDeployment | null>;
  forResource(tenantId: string, resourceUid: string): Promise<readonly ResourceDeployment[]>;
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
            provider_installation_ref, native_id, state, observed_json, outputs_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.tenantId,
          input.id,
          input.resourceUid,
          input.offeringId,
          input.providerPackRef,
          input.providerInstallationRef,
          input.nativeId,
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
