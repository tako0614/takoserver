import type { Catalog } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "./generated/takoform-stable-v1-catalog.ts";
import type { Clock, Row, Sql, SqlWrite } from "./ports.ts";
import { createSoldProviderPlacementSelector } from "./provider-placement.ts";
import type { Provider } from "./provider-port.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";
import type { ResourceWithRelations, TakoformStore } from "./takoform/store.ts";

export const WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT =
  "takoserver.worker-endpoint-origin-reservation.v1" as const;
export const WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT =
  "takoserver.worker-endpoint-origin-reservation-activation.v1" as const;

const MINIMUM_TTL_SECONDS = 60;
const MAXIMUM_TTL_SECONDS = 24 * 60 * 60;
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const resourceName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;

const MODULE_WORKER_FORM_REF: TakoformV1Alpha3FormRef = (() => {
  const formRef = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (form) => form.identity.formRef.kind === "ModuleWorker",
  )?.identity.formRef;
  if (!formRef) throw new TypeError("stable ModuleWorker Form is missing");
  return formRef;
})();
const WORKER_ENDPOINT_FORM_REF: TakoformV1Alpha3FormRef = (() => {
  const formRef = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (form) => form.identity.formRef.kind === "WorkerEndpoint",
  )?.identity.formRef;
  if (!formRef) throw new TypeError("stable WorkerEndpoint Form is missing");
  return formRef;
})();

export interface WorkerEndpointOriginReservationTarget {
  readonly space: string;
  readonly workerName: string;
  readonly endpointName: string;
}

export interface WorkerEndpointOriginReservationProjection {
  readonly format: typeof WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT;
  readonly reservationId: string;
  readonly canonicalPublicOrigin: string;
  readonly revision: string;
  readonly expiresAt: string;
  readonly target: WorkerEndpointOriginReservationTarget;
  readonly status: "prepared" | "bound" | "activated";
  readonly workerResourceUid?: string;
  readonly endpointResourceUid?: string;
}

export interface BoundWorkerEndpointOriginReservation {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly canonicalPublicOrigin: string;
  readonly revision: string;
  readonly expiresAtEpochMilliseconds: number;
  readonly target: WorkerEndpointOriginReservationTarget;
  readonly status: "bound" | "activated";
  readonly workerResourceUid: string;
  readonly workerResourceRevision: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
  readonly endpointResourceUid?: string;
}

export class WorkerEndpointOriginReservationError extends Error {
  constructor(
    readonly code:
      | "invalid_argument"
      | "conflict"
      | "not_found"
      | "unsupported_capability"
      | "backend_unavailable",
    readonly status: 400 | 404 | 409 | 422 | 503,
  ) {
    super(code);
    this.name = "WorkerEndpointOriginReservationError";
  }
}

export interface WorkerEndpointOriginReservations {
  prepare(input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly target: WorkerEndpointOriginReservationTarget;
    readonly offeringId?: string;
    readonly expiresInSeconds: number;
  }): Promise<WorkerEndpointOriginReservationProjection>;
  read(
    organizationId: string,
    reservationId: string,
  ): Promise<WorkerEndpointOriginReservationProjection | null>;
  release(organizationId: string, reservationId: string): Promise<void>;
  bind(input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  }): Promise<BoundWorkerEndpointOriginReservation>;
  inspectBound(input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  }): Promise<BoundWorkerEndpointOriginReservation>;
  activate(input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly endpointResourceUid: string;
  }): Promise<WorkerEndpointOriginReservationProjection>;
  deactivate(input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly endpointResourceUid: string;
  }): Promise<WorkerEndpointOriginReservationProjection>;
}

export type WorkerEndpointOriginReservationBindingPort = Pick<
  WorkerEndpointOriginReservations,
  "bind" | "inspectBound"
>;

/**
 * Closes the provider/runtime construction cycle without granting mutable
 * general authority. Calls fail closed until the one real reservation
 * authority is connected, and a second connection is a composition error.
 */
export function createWorkerEndpointOriginReservationBindingHandle(): {
  readonly port: WorkerEndpointOriginReservationBindingPort;
  connect(authority: WorkerEndpointOriginReservationBindingPort): void;
} {
  let connected: WorkerEndpointOriginReservationBindingPort | null = null;
  const current = (): WorkerEndpointOriginReservationBindingPort => {
    if (!connected) {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    return connected;
  };
  return {
    port: Object.freeze({
      bind: async (...args: Parameters<WorkerEndpointOriginReservations["bind"]>) =>
        await current().bind(...args),
      inspectBound: async (...args: Parameters<WorkerEndpointOriginReservations["inspectBound"]>) =>
        await current().inspectBound(...args),
    }),
    connect(authority) {
      if (connected) throw new TypeError("origin reservation authority is already connected");
      connected = authority;
    },
  };
}

export function createWorkerEndpointOriginReservations(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly catalog: Catalog;
  readonly providers: readonly Provider[];
  readonly resources: Pick<TakoformStore, "resourceWithRelationsByUid">;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
}): WorkerEndpointOriginReservations {
  const placements = createSoldProviderPlacementSelector({
    providers: options.providers,
    catalog: options.catalog,
  });
  const now = (): number => options.clock().getTime();

  const planned = async (input: {
    readonly organizationId: string;
    readonly target: WorkerEndpointOriginReservationTarget;
    readonly offeringId?: string;
  }): Promise<PlannedOrigin> => {
    let selection: ReturnType<typeof placements.select>;
    try {
      selection = placements.select(MODULE_WORKER_FORM_REF, input.offeringId);
    } catch (error) {
      throw reservationPlacementError(error);
    }
    const capability = selection.provider.workerEndpointOriginReservations;
    if (!capability) {
      throw new WorkerEndpointOriginReservationError("unsupported_capability", 422);
    }
    let derived: Awaited<ReturnType<typeof capability.derive>>;
    try {
      derived = await capability.derive({
        identity: {
          tenantRef: input.organizationId,
          space: input.target.space,
          name: input.target.workerName,
        },
      });
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    if (!derived || !canonicalOrigin(derived.canonicalPublicOrigin)) {
      throw new WorkerEndpointOriginReservationError("unsupported_capability", 422);
    }
    let offeringDigest: `sha256:${string}`;
    try {
      offeringDigest = await options.catalog.digest(selection.sold);
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    return {
      canonicalPublicOrigin: derived.canonicalPublicOrigin,
      providerPackRef: selection.sold.providerPackRef,
      providerInstallationRef: selection.sold.providerInstallationRef,
      offeringId: selection.sold.id,
      offeringDigest,
    };
  };

  const expire = async (organizationId: string, reservationId: string): Promise<void> => {
    const timestamp = now();
    try {
      await options.sql.run(
        `UPDATE worker_endpoint_origin_reservations
         SET state = 'expired', revision = revision + 1, updated_at = ?
         WHERE organization_id = ? AND reservation_id = ?
           AND state IN ('prepared', 'bound') AND expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM worker_runtime_input_preparations AS preparation
             WHERE preparation.organization_id = worker_endpoint_origin_reservations.organization_id
               AND preparation.origin_reservation_id = worker_endpoint_origin_reservations.reservation_id
               AND preparation.state = 'claimed' AND preparation.claim_expires_at > ?
           )`,
        [timestamp, organizationId, reservationId, timestamp, timestamp],
      );
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
  };

  const expireConflicts = async (
    organizationId: string,
    target: WorkerEndpointOriginReservationTarget,
    canonicalPublicOrigin: string,
  ): Promise<void> => {
    const timestamp = now();
    try {
      await options.sql.run(
        `UPDATE worker_endpoint_origin_reservations
         SET state = 'expired', revision = revision + 1, updated_at = ?
         WHERE state IN ('prepared', 'bound') AND expires_at <= ?
           AND ((organization_id = ? AND space = ? AND worker_name = ?)
                OR canonical_public_origin = ?)
           AND NOT EXISTS (
             SELECT 1 FROM worker_runtime_input_preparations AS preparation
             WHERE preparation.organization_id = worker_endpoint_origin_reservations.organization_id
               AND preparation.origin_reservation_id = worker_endpoint_origin_reservations.reservation_id
               AND preparation.state = 'claimed' AND preparation.claim_expires_at > ?
           )`,
        [
          timestamp,
          timestamp,
          organizationId,
          target.space,
          target.workerName,
          canonicalPublicOrigin,
          timestamp,
        ],
      );
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
  };

  const liveRow = async (
    organizationId: string,
    reservationId: string,
  ): Promise<ReservationRow | null> => {
    await expire(organizationId, reservationId);
    const row = await readRow(options.sql, organizationId, reservationId);
    return row && liveState(row.state) ? row : null;
  };

  const assertPlacement = async (row: ReservationRow): Promise<void> => {
    const current = await planned({
      organizationId: row.organization_id,
      target: targetOf(row),
      offeringId: row.offering_id,
    });
    if (
      current.canonicalPublicOrigin !== row.canonical_public_origin ||
      current.providerPackRef !== row.provider_pack_ref ||
      current.providerInstallationRef !== row.provider_installation_ref ||
      current.offeringId !== row.offering_id ||
      current.offeringDigest !== row.offering_digest
    ) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
  };

  const validateWorker = async (
    row: ReservationRow,
    workerResourceUid: string,
  ): Promise<{
    readonly snapshot: ResourceWithRelations;
    readonly deployment: ResourceDeployment;
  }> => {
    const snapshot = await resourceSnapshot(
      options.resources,
      row.organization_id,
      workerResourceUid,
    );
    if (
      !snapshot ||
      snapshot.listing.uid !== workerResourceUid ||
      snapshot.listing.space !== row.space ||
      snapshot.listing.name !== row.worker_name ||
      !readyCurrent(snapshot, "ModuleWorker") ||
      !sameForm(snapshot.listing.resource.form.formRef, MODULE_WORKER_FORM_REF)
    ) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    if (!(await liveIncarnation(options.sql, row.organization_id, workerResourceUid))) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    const deployment = await activeDeployment(
      options.deployments,
      row.organization_id,
      workerResourceUid,
    );
    if (
      !deployment ||
      deployment.resourceUid !== workerResourceUid ||
      deployment.offeringId !== row.offering_id ||
      deployment.providerPackRef !== row.provider_pack_ref ||
      deployment.providerInstallationRef !== row.provider_installation_ref
    ) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    return { snapshot, deployment };
  };

  const inspectBound = async (input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  }): Promise<BoundWorkerEndpointOriginReservation> => {
    normalizeIdentity(input.organizationId, input.reservationId);
    validateTargetName(input.space);
    validateTargetName(input.workerName);
    validateOpaque(input.workerResourceUid);
    const row = await liveRow(input.organizationId, input.reservationId);
    if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
    if (
      (row.state !== "bound" && row.state !== "activated") ||
      row.space !== input.space ||
      row.worker_name !== input.workerName ||
      row.worker_resource_uid !== input.workerResourceUid ||
      !row.worker_resource_revision
    ) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    await assertPlacement(row);
    const { snapshot } = await validateWorker(row, input.workerResourceUid);
    if (snapshot.listing.revision !== row.worker_resource_revision) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    return boundProjection(row);
  };

  return {
    async prepare(input) {
      normalizeIdentity(input.organizationId, input.reservationId);
      const target = normalizeTarget(input.target);
      const expiresInSeconds = ttl(input.expiresInSeconds);
      if (input.offeringId !== undefined) validateOpaque(input.offeringId);
      const plan = await planned({
        organizationId: input.organizationId,
        target,
        ...(input.offeringId ? { offeringId: input.offeringId } : {}),
      });
      await expire(input.organizationId, input.reservationId);
      await expireConflicts(input.organizationId, target, plan.canonicalPublicOrigin);
      const existing = await readRow(options.sql, input.organizationId, input.reservationId);
      if (existing) return exactReplay(existing, target, plan, expiresInSeconds);

      const timestamp = now();
      const expiresAt = timestamp + expiresInSeconds * 1_000;
      try {
        const inserted = await options.sql.run(
          `INSERT INTO worker_endpoint_origin_reservations
             (organization_id, reservation_id, space, worker_name, endpoint_name,
              canonical_public_origin, provider_pack_ref, provider_installation_ref,
              offering_id, offering_digest, requested_ttl_seconds, expires_at,
              state, revision, worker_resource_uid, worker_resource_revision,
              endpoint_resource_uid, endpoint_resource_revision,
              created_at, updated_at, released_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1,
                   NULL, NULL, NULL, NULL, ?, ?, NULL)`,
          [
            input.organizationId,
            input.reservationId,
            target.space,
            target.workerName,
            target.endpointName,
            plan.canonicalPublicOrigin,
            plan.providerPackRef,
            plan.providerInstallationRef,
            plan.offeringId,
            plan.offeringDigest,
            expiresInSeconds,
            expiresAt,
            timestamp,
            timestamp,
          ],
        );
        if (inserted.changes !== 1) {
          throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
        }
      } catch (error) {
        const raced = await readRow(options.sql, input.organizationId, input.reservationId);
        if (raced) return exactReplay(raced, target, plan, expiresInSeconds);
        const collision = await liveCollision(
          options.sql,
          input.organizationId,
          target,
          plan.canonicalPublicOrigin,
        );
        if (collision) throw new WorkerEndpointOriginReservationError("conflict", 409);
        if (error instanceof WorkerEndpointOriginReservationError) throw error;
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      const created = await readRow(options.sql, input.organizationId, input.reservationId);
      if (!created) throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      return publicProjection(created);
    },

    async read(organizationId, reservationId) {
      normalizeIdentity(organizationId, reservationId);
      const row = await liveRow(organizationId, reservationId);
      return row ? publicProjection(row) : null;
    },

    async release(organizationId, reservationId) {
      normalizeIdentity(organizationId, reservationId);
      await expire(organizationId, reservationId);
      const row = await readRow(options.sql, organizationId, reservationId);
      if (!row || row.state === "released") return;
      if (row.state === "activated") {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      const timestamp = now();
      let released: SqlWrite;
      try {
        released = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET state = 'released', revision = revision + 1,
               released_at = ?, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND revision = ?
             AND state IN ('prepared', 'bound', 'expired')
             AND NOT EXISTS (
               SELECT 1 FROM worker_runtime_input_preparations AS preparation
               WHERE preparation.organization_id = worker_endpoint_origin_reservations.organization_id
                 AND preparation.origin_reservation_id = worker_endpoint_origin_reservations.reservation_id
                 AND preparation.state = 'claimed' AND preparation.claim_expires_at > ?
             )
             AND (
               endpoint_resource_uid IS NULL OR (
                 NOT EXISTS (
                   SELECT 1 FROM tf_resources AS endpoint_resource
                   WHERE endpoint_resource.tenant_id = worker_endpoint_origin_reservations.organization_id
                     AND endpoint_resource.uid = worker_endpoint_origin_reservations.endpoint_resource_uid
                 )
                 AND EXISTS (
                   SELECT 1 FROM tf_resource_deletion_attestations AS endpoint_deletion
                   WHERE endpoint_deletion.tenant_id = worker_endpoint_origin_reservations.organization_id
                     AND endpoint_deletion.resource_uid = worker_endpoint_origin_reservations.endpoint_resource_uid
                     AND endpoint_deletion.state = 'closed'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM tf_resource_deployments AS endpoint_deployment
                   WHERE endpoint_deployment.tenant_id = worker_endpoint_origin_reservations.organization_id
                     AND endpoint_deployment.resource_uid = worker_endpoint_origin_reservations.endpoint_resource_uid
                     AND endpoint_deployment.state NOT IN ('deleted', 'failed')
                 )
               )
             )`,
          [timestamp, timestamp, organizationId, reservationId, row.revision, timestamp],
        );
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (released.changes !== 1) {
        const current = await readRow(options.sql, organizationId, reservationId);
        if (!current || current.state === "released") return;
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
    },

    async bind(input) {
      normalizeIdentity(input.organizationId, input.reservationId);
      validateTargetName(input.space);
      validateTargetName(input.workerName);
      validateOpaque(input.workerResourceUid);
      const row = await liveRow(input.organizationId, input.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
      if (row.space !== input.space || row.worker_name !== input.workerName) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      await assertPlacement(row);
      const { snapshot } = await validateWorker(row, input.workerResourceUid);
      if (row.state === "bound" || row.state === "activated") {
        if (
          row.worker_resource_uid !== input.workerResourceUid ||
          row.worker_resource_revision !== snapshot.listing.revision
        ) {
          throw new WorkerEndpointOriginReservationError("conflict", 409);
        }
        return boundProjection(row);
      }
      if (row.state !== "prepared") {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      let bound: SqlWrite;
      try {
        bound = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET state = 'bound', revision = revision + 1,
               worker_resource_uid = ?, worker_resource_revision = ?, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND state = 'prepared'
             AND revision = ? AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM tf_resources
               WHERE tenant_id = ? AND uid = ? AND space = ? AND name = ?
                 AND kind = 'ModuleWorker' AND revision = ?
             )
             AND EXISTS (
               SELECT 1 FROM tf_resource_deployments
               WHERE tenant_id = ? AND resource_uid = ? AND state = 'active'
                 AND offering_id = ? AND provider_pack_ref = ?
                 AND provider_installation_ref = ?
             )
             AND EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations
               WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
             )`,
          [
            input.workerResourceUid,
            snapshot.listing.revision,
            now(),
            input.organizationId,
            input.reservationId,
            row.revision,
            now(),
            input.organizationId,
            input.workerResourceUid,
            row.space,
            row.worker_name,
            snapshot.listing.revision,
            input.organizationId,
            input.workerResourceUid,
            row.offering_id,
            row.provider_pack_ref,
            row.provider_installation_ref,
            input.organizationId,
            input.workerResourceUid,
          ],
        );
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (bound.changes !== 1) {
        const raced = await liveRow(input.organizationId, input.reservationId);
        if (
          raced &&
          (raced.state === "bound" || raced.state === "activated") &&
          raced.worker_resource_uid === input.workerResourceUid &&
          raced.worker_resource_revision === snapshot.listing.revision
        ) {
          return await inspectBound(input);
        }
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      const current = await liveRow(input.organizationId, input.reservationId);
      if (!current || current.state === "prepared") {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      return boundProjection(current);
    },

    inspectBound,

    async activate(input) {
      normalizeIdentity(input.organizationId, input.reservationId);
      validateOpaque(input.endpointResourceUid);
      const row = await liveRow(input.organizationId, input.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
      if (!row.worker_resource_uid || !row.worker_resource_revision) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      await assertPlacement(row);
      const { snapshot: worker } = await validateWorker(row, row.worker_resource_uid);
      if (worker.listing.revision !== row.worker_resource_revision) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      const endpoint = await resourceSnapshot(
        options.resources,
        input.organizationId,
        input.endpointResourceUid,
      );
      if (
        !endpoint ||
        endpoint.listing.space !== row.space ||
        endpoint.listing.name !== row.endpoint_name ||
        !readyCurrent(endpoint, "WorkerEndpoint") ||
        !sameForm(endpoint.listing.resource.form.formRef, WORKER_ENDPOINT_FORM_REF) ||
        !endpointOriginEquals(endpoint, row.canonical_public_origin) ||
        !exactWorkerRelation(endpoint, row.worker_resource_uid, row.worker_name)
      ) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      if (!(await liveIncarnation(options.sql, input.organizationId, input.endpointResourceUid))) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      const endpointDeployment = await activeDeployment(
        options.deployments,
        input.organizationId,
        input.endpointResourceUid,
      );
      if (
        !endpointDeployment ||
        endpointDeployment.providerPackRef !== row.provider_pack_ref ||
        endpointDeployment.providerInstallationRef !== row.provider_installation_ref
      ) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      if (row.state === "activated") {
        if (
          row.endpoint_resource_uid !== input.endpointResourceUid ||
          row.endpoint_resource_revision !== endpoint.listing.revision
        ) {
          throw new WorkerEndpointOriginReservationError("conflict", 409);
        }
        return publicProjection(row);
      }
      if (row.state !== "bound") {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      let activated: SqlWrite;
      try {
        activated = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET state = 'activated', revision = revision + 1,
               endpoint_resource_uid = ?, endpoint_resource_revision = ?, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND state = 'bound'
             AND revision = ? AND worker_resource_uid = ? AND worker_resource_revision = ?
             AND EXISTS (
               SELECT 1 FROM tf_resources
               WHERE tenant_id = ? AND uid = ? AND space = ? AND name = ?
                 AND kind = 'WorkerEndpoint' AND revision = ?
             )
             AND EXISTS (
               SELECT 1 FROM tf_resource_deployments
               WHERE tenant_id = ? AND resource_uid = ? AND state = 'active'
                 AND provider_pack_ref = ? AND provider_installation_ref = ?
             )
             AND EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations
               WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
             )
             AND EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations
               WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
             )`,
          [
            input.endpointResourceUid,
            endpoint.listing.revision,
            now(),
            input.organizationId,
            input.reservationId,
            row.revision,
            row.worker_resource_uid,
            row.worker_resource_revision,
            input.organizationId,
            input.endpointResourceUid,
            row.space,
            row.endpoint_name,
            endpoint.listing.revision,
            input.organizationId,
            input.endpointResourceUid,
            row.provider_pack_ref,
            row.provider_installation_ref,
            input.organizationId,
            row.worker_resource_uid,
            input.organizationId,
            input.endpointResourceUid,
          ],
        );
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (activated.changes !== 1) {
        const raced = await liveRow(input.organizationId, input.reservationId);
        if (
          raced?.state === "activated" &&
          raced.endpoint_resource_uid === input.endpointResourceUid &&
          raced.endpoint_resource_revision === endpoint.listing.revision &&
          (await liveIncarnation(options.sql, input.organizationId, input.endpointResourceUid))
        ) {
          return publicProjection(raced);
        }
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      const current = await liveRow(input.organizationId, input.reservationId);
      if (current?.state !== "activated") {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      return publicProjection(current);
    },

    async deactivate(input) {
      normalizeIdentity(input.organizationId, input.reservationId);
      validateOpaque(input.endpointResourceUid);
      const row = await liveRow(input.organizationId, input.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
      if (row.state === "bound" && row.endpoint_resource_uid === input.endpointResourceUid) {
        return publicProjection(row);
      }
      if (row.state !== "activated" || row.endpoint_resource_uid !== input.endpointResourceUid) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      let deactivated: SqlWrite;
      try {
        deactivated = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET state = 'bound', revision = revision + 1, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND state = 'activated'
             AND revision = ? AND endpoint_resource_uid = ?`,
          [
            now(),
            input.organizationId,
            input.reservationId,
            row.revision,
            input.endpointResourceUid,
          ],
        );
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (deactivated.changes !== 1) {
        const current = await liveRow(input.organizationId, input.reservationId);
        if (
          current?.state === "bound" &&
          current.endpoint_resource_uid === input.endpointResourceUid
        ) {
          return publicProjection(current);
        }
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      const current = await readRow(options.sql, input.organizationId, input.reservationId);
      if (current?.state !== "bound") {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      return publicProjection(current);
    },
  };
}

interface PlannedOrigin {
  readonly canonicalPublicOrigin: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
}

type ReservationState = "prepared" | "bound" | "activated" | "expired" | "released";

interface ReservationRow {
  readonly organization_id: string;
  readonly reservation_id: string;
  readonly space: string;
  readonly worker_name: string;
  readonly endpoint_name: string;
  readonly canonical_public_origin: string;
  readonly provider_pack_ref: string;
  readonly provider_installation_ref: string;
  readonly offering_id: string;
  readonly offering_digest: `sha256:${string}`;
  readonly requested_ttl_seconds: number;
  readonly expires_at: number;
  readonly state: ReservationState;
  readonly revision: number;
  readonly worker_resource_uid: string | null;
  readonly worker_resource_revision: string | null;
  readonly endpoint_resource_uid: string | null;
  readonly endpoint_resource_revision: string | null;
}

async function readRow(
  sql: Sql,
  organizationId: string,
  reservationId: string,
): Promise<ReservationRow | null> {
  let rows: readonly Row[];
  try {
    rows = await sql.query(
      `SELECT * FROM worker_endpoint_origin_reservations
       WHERE organization_id = ? AND reservation_id = ? LIMIT 2`,
      [organizationId, reservationId],
    );
  } catch {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return reservationRow(rows[0]);
}

function reservationRow(row: Row): ReservationRow {
  const state = string(row.state);
  const revision = safeInteger(row.revision);
  const expiresAt = safeInteger(row.expires_at);
  const requestedTtl = safeInteger(row.requested_ttl_seconds);
  const offeringDigest = string(row.offering_digest);
  if (
    !liveOrTerminalState(state) ||
    revision < 1 ||
    expiresAt < 0 ||
    requestedTtl < MINIMUM_TTL_SECONDS ||
    requestedTtl > MAXIMUM_TTL_SECONDS ||
    !digest.test(offeringDigest)
  ) {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return {
    organization_id: string(row.organization_id),
    reservation_id: string(row.reservation_id),
    space: string(row.space),
    worker_name: string(row.worker_name),
    endpoint_name: string(row.endpoint_name),
    canonical_public_origin: string(row.canonical_public_origin),
    provider_pack_ref: string(row.provider_pack_ref),
    provider_installation_ref: string(row.provider_installation_ref),
    offering_id: string(row.offering_id),
    offering_digest: offeringDigest as `sha256:${string}`,
    requested_ttl_seconds: requestedTtl,
    expires_at: expiresAt,
    state,
    revision,
    worker_resource_uid: nullableString(row.worker_resource_uid),
    worker_resource_revision: nullableString(row.worker_resource_revision),
    endpoint_resource_uid: nullableString(row.endpoint_resource_uid),
    endpoint_resource_revision: nullableString(row.endpoint_resource_revision),
  };
}

async function liveCollision(
  sql: Sql,
  organizationId: string,
  target: WorkerEndpointOriginReservationTarget,
  canonicalPublicOrigin: string,
): Promise<boolean> {
  let rows: readonly Row[];
  try {
    rows = await sql.query(
      `SELECT reservation_id FROM worker_endpoint_origin_reservations
       WHERE (state IN ('prepared', 'bound', 'activated')
              OR (state = 'expired' AND endpoint_resource_uid IS NOT NULL))
         AND ((organization_id = ? AND space = ? AND worker_name = ?)
              OR canonical_public_origin = ?)
       LIMIT 1`,
      [organizationId, target.space, target.workerName, canonicalPublicOrigin],
    );
  } catch {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return rows.length > 0;
}

function exactReplay(
  row: ReservationRow,
  target: WorkerEndpointOriginReservationTarget,
  plan: PlannedOrigin,
  expiresInSeconds: number,
): WorkerEndpointOriginReservationProjection {
  if (
    !liveState(row.state) ||
    row.space !== target.space ||
    row.worker_name !== target.workerName ||
    row.endpoint_name !== target.endpointName ||
    row.canonical_public_origin !== plan.canonicalPublicOrigin ||
    row.provider_pack_ref !== plan.providerPackRef ||
    row.provider_installation_ref !== plan.providerInstallationRef ||
    row.offering_id !== plan.offeringId ||
    row.offering_digest !== plan.offeringDigest ||
    row.requested_ttl_seconds !== expiresInSeconds
  ) {
    throw new WorkerEndpointOriginReservationError("conflict", 409);
  }
  return publicProjection(row);
}

function publicProjection(row: ReservationRow): WorkerEndpointOriginReservationProjection {
  if (!liveState(row.state)) {
    throw new WorkerEndpointOriginReservationError("not_found", 404);
  }
  return {
    format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
    reservationId: row.reservation_id,
    canonicalPublicOrigin: row.canonical_public_origin,
    revision: String(row.revision),
    expiresAt: new Date(row.expires_at).toISOString(),
    target: targetOf(row),
    status: row.state,
    ...(row.worker_resource_uid ? { workerResourceUid: row.worker_resource_uid } : {}),
    ...(row.endpoint_resource_uid ? { endpointResourceUid: row.endpoint_resource_uid } : {}),
  };
}

function boundProjection(row: ReservationRow): BoundWorkerEndpointOriginReservation {
  if (
    (row.state !== "bound" && row.state !== "activated") ||
    !row.worker_resource_uid ||
    !row.worker_resource_revision
  ) {
    throw new WorkerEndpointOriginReservationError("conflict", 409);
  }
  return {
    organizationId: row.organization_id,
    reservationId: row.reservation_id,
    canonicalPublicOrigin: row.canonical_public_origin,
    revision: String(row.revision),
    expiresAtEpochMilliseconds: row.expires_at,
    target: targetOf(row),
    status: row.state,
    workerResourceUid: row.worker_resource_uid,
    workerResourceRevision: row.worker_resource_revision,
    providerPackRef: row.provider_pack_ref,
    providerInstallationRef: row.provider_installation_ref,
    offeringId: row.offering_id,
    offeringDigest: row.offering_digest,
    ...(row.endpoint_resource_uid ? { endpointResourceUid: row.endpoint_resource_uid } : {}),
  };
}

function targetOf(row: ReservationRow): WorkerEndpointOriginReservationTarget {
  return { space: row.space, workerName: row.worker_name, endpointName: row.endpoint_name };
}

async function resourceSnapshot(
  resources: Pick<TakoformStore, "resourceWithRelationsByUid">,
  organizationId: string,
  resourceUid: string,
): Promise<ResourceWithRelations | null> {
  try {
    return await resources.resourceWithRelationsByUid(organizationId, resourceUid);
  } catch {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
}

async function activeDeployment(
  deployments: Pick<ResourceDeploymentStore, "active">,
  organizationId: string,
  resourceUid: string,
): Promise<ResourceDeployment | null> {
  try {
    return await deployments.active(organizationId, resourceUid);
  } catch {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
}

async function liveIncarnation(
  sql: Sql,
  organizationId: string,
  resourceUid: string,
): Promise<boolean> {
  let rows: readonly Row[];
  try {
    rows = await sql.query(
      `SELECT resource_uid FROM tf_resource_deletion_attestations
       WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
       LIMIT 2`,
      [organizationId, resourceUid],
    );
  } catch {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  if (rows.length > 1) {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return rows.length === 1;
}

function readyCurrent(snapshot: ResourceWithRelations, kind: string): boolean {
  const { listing } = snapshot;
  const resource = listing.resource;
  return (
    listing.kind === kind &&
    resource.kind === kind &&
    resource.apiVersion === listing.apiVersion &&
    resource.metadata.uid === listing.uid &&
    resource.metadata.space === listing.space &&
    resource.metadata.name === listing.name &&
    resource.metadata.generation === listing.generation &&
    resource.metadata.revision === listing.revision &&
    resource.status.observedGeneration === resource.metadata.generation &&
    canonicalRevision(listing.revision) &&
    resource.status.conditions.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    )
  );
}

function endpointOriginEquals(snapshot: ResourceWithRelations, expected: string): boolean {
  const hostname = snapshot.listing.resource.status.outputs?.hostname;
  const url = snapshot.listing.resource.status.outputs?.url;
  if (
    typeof hostname !== "string" ||
    typeof url !== "string" ||
    hostname !== hostname.toLowerCase()
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.hostname === hostname &&
    url === `${parsed.origin}/` &&
    parsed.origin === expected
  );
}

function exactWorkerRelation(
  endpoint: ResourceWithRelations,
  workerResourceUid: string,
  workerName: string,
): boolean {
  const relations = endpoint.relations.filter(
    (relation) => relation.pointer === "/worker" && relation.relation === "/worker",
  );
  return (
    relations.length === 1 &&
    relations[0]?.targetKind === "ModuleWorker" &&
    relations[0].targetUid === workerResourceUid &&
    relations[0].targetName === workerName
  );
}

function sameForm(left: TakoformV1Alpha3FormRef, right: TakoformV1Alpha3FormRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function normalizeIdentity(organizationId: string, reservationId: string): void {
  validateOpaque(organizationId);
  validateOpaque(reservationId);
}

function normalizeTarget(
  target: WorkerEndpointOriginReservationTarget,
): WorkerEndpointOriginReservationTarget {
  validateTargetName(target.space);
  validateTargetName(target.workerName);
  validateTargetName(target.endpointName);
  return { ...target };
}

function validateTargetName(value: string): void {
  if (!resourceName.test(value)) {
    throw new WorkerEndpointOriginReservationError("invalid_argument", 400);
  }
}

function validateOpaque(value: string): void {
  if (!opaqueId.test(value)) {
    throw new WorkerEndpointOriginReservationError("invalid_argument", 400);
  }
}

function ttl(value: number): number {
  if (!Number.isSafeInteger(value) || value < MINIMUM_TTL_SECONDS || value > MAXIMUM_TTL_SECONDS) {
    throw new WorkerEndpointOriginReservationError("invalid_argument", 400);
  }
  return value;
}

function canonicalOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.origin === value
  );
}

function liveState(value: ReservationState): value is "prepared" | "bound" | "activated" {
  return value === "prepared" || value === "bound" || value === "activated";
}

function liveOrTerminalState(value: string): value is ReservationState {
  return liveState(value as ReservationState) || value === "expired" || value === "released";
}

function canonicalRevision(value: string): boolean {
  return /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function reservationPlacementError(error: unknown): WorkerEndpointOriginReservationError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "unsupported_capability"
  ) {
    return new WorkerEndpointOriginReservationError("unsupported_capability", 422);
  }
  return new WorkerEndpointOriginReservationError("backend_unavailable", 503);
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return value;
}
