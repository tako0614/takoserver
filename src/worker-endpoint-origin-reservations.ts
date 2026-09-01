import type { Catalog } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "./generated/takoform-stable-v1-catalog.ts";
import { canonicalDigest } from "./json.ts";
import type { Clock, JsonObject, Row, Sql, SqlWrite } from "./ports.ts";
import { createSoldProviderPlacementSelector } from "./provider-placement.ts";
import type { Provider } from "./provider-port.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";
import type { ResourceWithRelations, TakoformStore } from "./takoform/store.ts";

export const WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT =
  "takoserver.worker-endpoint-origin-reservation.v2" as const;
export const LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT =
  "takoserver.worker-endpoint-origin-reservation.v1" as const;
export const WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT =
  "takoserver.worker-endpoint-origin-reservation-activation.v2" as const;
export const WORKER_ENDPOINT_ORIGIN_ASSIGNMENT_FORMAT =
  "takoserver.worker-endpoint-origin-assignment.v1" as const;

const MINIMUM_TTL_SECONDS = 60;
const MAXIMUM_TTL_SECONDS = 24 * 60 * 60;
const MAXIMUM_DATE_EPOCH_MILLISECONDS = 8_640_000_000_000_000;
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const resourceName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const requestedSubdomain = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
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

export interface LegacyWorkerEndpointOriginReservationTarget {
  readonly space: string;
  readonly workerName: string;
  readonly endpointName: string;
}

/** Historical name retained for source compatibility with v1 read projections. */
export type WorkerEndpointOriginReservationTarget = LegacyWorkerEndpointOriginReservationTarget;

export interface WorkerEndpointOriginReservationBinding {
  readonly space: string;
  readonly workerName: string;
  readonly workerResourceUid: string;
  readonly workerResourceRevision: string;
  readonly endpointName?: string;
  readonly endpointResourceUid?: string;
  readonly endpointResourceRevision?: string;
}

export interface CurrentWorkerEndpointOriginReservationProjection {
  readonly format: typeof WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT;
  readonly reservationId: string;
  readonly requestedSubdomain: string;
  readonly canonicalPublicOrigin: string;
  readonly revision: string;
  readonly expiresAt: string;
  readonly status: "prepared" | "bound" | "activated";
  readonly binding?: WorkerEndpointOriginReservationBinding;
}

/** Read-only projection for rows durably written by the retired v1 writer. */
export interface LegacyWorkerEndpointOriginReservationProjection {
  readonly format: typeof LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT;
  readonly reservationId: string;
  readonly canonicalPublicOrigin: string;
  readonly revision: string;
  readonly expiresAt: string;
  readonly target: LegacyWorkerEndpointOriginReservationTarget;
  readonly status: "prepared" | "bound" | "activated";
  readonly workerResourceUid?: string;
  readonly endpointResourceUid?: string;
}

export type WorkerEndpointOriginReservationProjection =
  | CurrentWorkerEndpointOriginReservationProjection
  | LegacyWorkerEndpointOriginReservationProjection;

export interface BoundWorkerEndpointOriginReservation {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly canonicalPublicOrigin: string;
  readonly revision: string;
  readonly expiresAtEpochMilliseconds: number;
  readonly requestedSubdomain?: string;
  readonly binding: WorkerEndpointOriginReservationBinding;
  readonly status: "bound" | "activated";
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
}

/** Host-private exact assignment. Only `provider` is projected across the Provider port. */
export interface WorkerEndpointOriginAssignment {
  readonly format: typeof WORKER_ENDPOINT_ORIGIN_ASSIGNMENT_FORMAT;
  readonly organizationId: string;
  readonly reservationId: string;
  /** Current CAS revision, used only for proof-backed pre-dispatch cancellation. */
  readonly reservationRevision: string;
  readonly canonicalPublicOrigin: string;
  readonly assignmentDigest: `sha256:${string}`;
  readonly endpoint: {
    readonly space: string;
    readonly name: string;
    readonly uid: string;
    readonly revision: string;
  };
  readonly worker: {
    readonly name: string;
    readonly uid: string;
    readonly revision: string;
  };
  readonly placement: {
    readonly providerPackRef: string;
    readonly providerInstallationRef: string;
  };
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
    readonly requestedSubdomain: string;
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
  /** CAS-pins a future endpoint before the Provider mutation boundary. */
  assignEndpoint(input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly space: string;
    readonly endpointName: string;
    readonly endpointResourceUid: string;
    readonly endpointResourceRevision: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
    readonly providerPackRef: string;
    readonly providerInstallationRef: string;
  }): Promise<WorkerEndpointOriginAssignment>;
  /** Clears only an exact assignment proven not to have crossed the Provider boundary. */
  cancelEndpointAssignment(assignment: WorkerEndpointOriginAssignment): Promise<void>;
  /** Activates exact provider output before a Ready Host commit is allowed. */
  activateEndpointAssignment(input: {
    readonly assignment: WorkerEndpointOriginAssignment;
    readonly providerOutputs: JsonObject;
  }): Promise<WorkerEndpointOriginAssignment>;
  /** Finds the durable assignment used to order delete -> deactivate -> Host closure. */
  endpointAssignment(
    organizationId: string,
    endpointResourceUid: string,
  ): Promise<WorkerEndpointOriginAssignment | null>;
  deactivateEndpointAssignment(assignment: WorkerEndpointOriginAssignment): Promise<void>;
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

  const selectedPlacement = async (offeringId?: string): Promise<PlannedPlacement> => {
    let selection: ReturnType<typeof placements.select>;
    try {
      selection = placements.select(MODULE_WORKER_FORM_REF, offeringId);
    } catch (error) {
      throw reservationPlacementError(error);
    }
    let offeringDigest: `sha256:${string}`;
    try {
      offeringDigest = await options.catalog.digest(selection.sold);
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    return {
      provider: selection.provider,
      providerPackRef: selection.sold.providerPackRef,
      providerInstallationRef: selection.sold.providerInstallationRef,
      offeringId: selection.sold.id,
      offeringDigest,
    };
  };

  const planned = async (input: {
    readonly organizationId: string;
    readonly requestedSubdomain: string;
    readonly offeringId?: string;
  }): Promise<PlannedOrigin> => {
    const selection = await selectedPlacement(input.offeringId);
    const capability = selection.provider.workerEndpointOriginReservations;
    if (!capability) {
      throw new WorkerEndpointOriginReservationError("unsupported_capability", 422);
    }
    let derived: Awaited<ReturnType<typeof capability.derive>>;
    try {
      derived = await capability.derive({
        tenantRef: input.organizationId,
        requestedSubdomain: input.requestedSubdomain,
      });
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    if (!derived || !canonicalOrigin(derived.canonicalPublicOrigin)) {
      throw new WorkerEndpointOriginReservationError("unsupported_capability", 422);
    }
    return {
      canonicalPublicOrigin: derived.canonicalPublicOrigin,
      providerPackRef: selection.providerPackRef,
      providerInstallationRef: selection.providerInstallationRef,
      offeringId: selection.offeringId,
      offeringDigest: selection.offeringDigest,
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
    requestedSubdomain: string,
    canonicalPublicOrigin: string,
  ): Promise<void> => {
    const timestamp = now();
    try {
      await options.sql.run(
        `UPDATE worker_endpoint_origin_reservations
         SET state = 'expired', revision = revision + 1, updated_at = ?
         WHERE state IN ('prepared', 'bound') AND expires_at <= ?
           AND (requested_subdomain = ? OR canonical_public_origin = ?)
           AND NOT EXISTS (
             SELECT 1 FROM worker_runtime_input_preparations AS preparation
             WHERE preparation.organization_id = worker_endpoint_origin_reservations.organization_id
               AND preparation.origin_reservation_id = worker_endpoint_origin_reservations.reservation_id
               AND preparation.state = 'claimed' AND preparation.claim_expires_at > ?
           )`,
        [timestamp, timestamp, requestedSubdomain, canonicalPublicOrigin, timestamp],
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
    const selected = await selectedPlacement(row.offering_id);
    if (
      selected.providerPackRef !== row.provider_pack_ref ||
      selected.providerInstallationRef !== row.provider_installation_ref ||
      selected.offeringId !== row.offering_id ||
      selected.offeringDigest !== row.offering_digest
    ) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    if (row.reservation_format === LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT) return;
    if (!row.requested_subdomain) {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    const current = await planned({
      organizationId: row.organization_id,
      requestedSubdomain: row.requested_subdomain,
      offeringId: row.offering_id,
    });
    if (current.canonicalPublicOrigin !== row.canonical_public_origin) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
  };

  const validateWorker = async (
    row: ReservationRow,
    identity: {
      readonly space: string;
      readonly workerName: string;
      readonly workerResourceUid: string;
    },
  ): Promise<{
    readonly snapshot: ResourceWithRelations;
    readonly deployment: ResourceDeployment;
  }> => {
    const snapshot = await resourceSnapshot(
      options.resources,
      row.organization_id,
      identity.workerResourceUid,
    );
    if (
      !snapshot ||
      snapshot.listing.uid !== identity.workerResourceUid ||
      snapshot.listing.space !== identity.space ||
      snapshot.listing.name !== identity.workerName ||
      !readyCurrent(snapshot, "ModuleWorker") ||
      !sameForm(snapshot.listing.resource.form.formRef, MODULE_WORKER_FORM_REF)
    ) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    if (!(await liveIncarnation(options.sql, row.organization_id, identity.workerResourceUid))) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    const deployment = await activeDeployment(
      options.deployments,
      row.organization_id,
      identity.workerResourceUid,
    );
    if (
      !deployment ||
      deployment.resourceUid !== identity.workerResourceUid ||
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
      row.bound_space !== input.space ||
      row.bound_worker_name !== input.workerName ||
      row.worker_resource_uid !== input.workerResourceUid ||
      !row.worker_resource_revision
    ) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    await assertPlacement(row);
    const { snapshot } = await validateWorker(row, input);
    if (snapshot.listing.revision !== row.worker_resource_revision) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    return boundProjection(row);
  };

  return {
    async prepare(input) {
      normalizeIdentity(input.organizationId, input.reservationId);
      validateRequestedSubdomain(input.requestedSubdomain);
      const expiresInSeconds = ttl(input.expiresInSeconds);
      if (input.offeringId !== undefined) validateOpaque(input.offeringId);
      const plan = await planned({
        organizationId: input.organizationId,
        requestedSubdomain: input.requestedSubdomain,
        ...(input.offeringId ? { offeringId: input.offeringId } : {}),
      });
      await expire(input.organizationId, input.reservationId);
      await expireConflicts(input.requestedSubdomain, plan.canonicalPublicOrigin);
      const existing = await readRow(options.sql, input.organizationId, input.reservationId);
      if (existing) {
        return exactReplay(existing, input.requestedSubdomain, plan, expiresInSeconds);
      }

      const timestamp = now();
      const expiresAt = timestamp + expiresInSeconds * 1_000;
      try {
        const inserted = await options.sql.run(
          `INSERT INTO worker_endpoint_origin_reservations
             (organization_id, reservation_id, reservation_format,
              legacy_space, legacy_worker_name, legacy_endpoint_name, requested_subdomain,
              canonical_public_origin, provider_pack_ref, provider_installation_ref,
              offering_id, offering_digest, requested_ttl_seconds, expires_at,
              state, revision, bound_space, bound_worker_name,
              worker_resource_uid, worker_resource_revision, bound_endpoint_name,
              endpoint_resource_uid, endpoint_resource_revision,
              created_at, updated_at, released_at)
           VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1,
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
          [
            input.organizationId,
            input.reservationId,
            WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
            input.requestedSubdomain,
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
        if (raced) {
          return exactReplay(raced, input.requestedSubdomain, plan, expiresInSeconds);
        }
        const collision = await liveCollision(
          options.sql,
          input.requestedSubdomain,
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
      if (
        row.reservation_format === LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT &&
        (row.legacy_space !== input.space || row.legacy_worker_name !== input.workerName)
      ) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      await assertPlacement(row);
      const { snapshot } = await validateWorker(row, input);
      if (row.state === "bound" || row.state === "activated") {
        if (
          row.bound_space !== input.space ||
          row.bound_worker_name !== input.workerName ||
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
               bound_space = ?, bound_worker_name = ?,
               worker_resource_uid = ?, worker_resource_revision = ?, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND state = 'prepared'
             AND revision = ? AND expires_at > ?
             AND bound_space IS NULL AND bound_worker_name IS NULL
             AND worker_resource_uid IS NULL AND worker_resource_revision IS NULL
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
            input.space,
            input.workerName,
            input.workerResourceUid,
            snapshot.listing.revision,
            now(),
            input.organizationId,
            input.reservationId,
            row.revision,
            now(),
            input.organizationId,
            input.workerResourceUid,
            input.space,
            input.workerName,
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
        if (
          await liveWorkerCollision(
            options.sql,
            input.organizationId,
            input.space,
            input.workerName,
            input.reservationId,
          )
        ) {
          throw new WorkerEndpointOriginReservationError("conflict", 409);
        }
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (bound.changes !== 1) {
        const raced = await liveRow(input.organizationId, input.reservationId);
        if (
          raced &&
          (raced.state === "bound" || raced.state === "activated") &&
          raced.bound_space === input.space &&
          raced.bound_worker_name === input.workerName &&
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
      if (
        !row.bound_space ||
        !row.bound_worker_name ||
        !row.worker_resource_uid ||
        !row.worker_resource_revision
      ) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      await assertPlacement(row);
      const { snapshot: worker } = await validateWorker(row, {
        space: row.bound_space,
        workerName: row.bound_worker_name,
        workerResourceUid: row.worker_resource_uid,
      });
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
        endpoint.listing.uid !== input.endpointResourceUid ||
        endpoint.listing.space !== row.bound_space ||
        (row.reservation_format === LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT &&
          endpoint.listing.name !== row.legacy_endpoint_name) ||
        !readyCurrent(endpoint, "WorkerEndpoint") ||
        !sameForm(endpoint.listing.resource.form.formRef, WORKER_ENDPOINT_FORM_REF) ||
        !endpointOriginEquals(endpoint, row.canonical_public_origin) ||
        !exactWorkerRelation(endpoint, row.worker_resource_uid, row.bound_worker_name)
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
          row.bound_endpoint_name !== endpoint.listing.name ||
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
      if (
        row.endpoint_resource_uid !== null &&
        (row.bound_endpoint_name !== endpoint.listing.name ||
          row.endpoint_resource_uid !== input.endpointResourceUid ||
          row.endpoint_resource_revision !== endpoint.listing.revision)
      ) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      let activated: SqlWrite;
      try {
        activated = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET state = 'activated', revision = revision + 1,
               bound_endpoint_name = ?, endpoint_resource_uid = ?,
               endpoint_resource_revision = ?, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND state = 'bound'
             AND revision = ? AND bound_space = ? AND bound_worker_name = ?
             AND worker_resource_uid = ? AND worker_resource_revision = ?
             AND (
               (bound_endpoint_name IS NULL AND endpoint_resource_uid IS NULL
                 AND endpoint_resource_revision IS NULL)
               OR (bound_endpoint_name = ? AND endpoint_resource_uid = ?
                 AND endpoint_resource_revision = ?)
             )
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
            endpoint.listing.name,
            input.endpointResourceUid,
            endpoint.listing.revision,
            now(),
            input.organizationId,
            input.reservationId,
            row.revision,
            row.bound_space,
            row.bound_worker_name,
            row.worker_resource_uid,
            row.worker_resource_revision,
            endpoint.listing.name,
            input.endpointResourceUid,
            endpoint.listing.revision,
            input.organizationId,
            input.endpointResourceUid,
            row.bound_space,
            endpoint.listing.name,
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
        if (
          await liveEndpointCollision(
            options.sql,
            input.organizationId,
            input.endpointResourceUid,
            input.reservationId,
          )
        ) {
          throw new WorkerEndpointOriginReservationError("conflict", 409);
        }
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (activated.changes !== 1) {
        const raced = await liveRow(input.organizationId, input.reservationId);
        if (
          raced?.state === "activated" &&
          raced.bound_endpoint_name === endpoint.listing.name &&
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

    async assignEndpoint(input) {
      normalizeIdentity(input.organizationId, input.reservationId);
      validateTargetName(input.space);
      validateTargetName(input.endpointName);
      validateTargetName(input.workerName);
      validateOpaque(input.endpointResourceUid);
      validateOpaque(input.workerResourceUid);
      validateOpaque(input.providerPackRef);
      validateOpaque(input.providerInstallationRef);
      if (!canonicalRevision(input.endpointResourceRevision)) {
        throw new WorkerEndpointOriginReservationError("invalid_argument", 400);
      }
      await expire(input.organizationId, input.reservationId);
      let row = await readRow(options.sql, input.organizationId, input.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
      if (row.reservation_format !== WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      await assertPlacement(row);
      const { snapshot } = await validateWorker(row, {
        space: input.space,
        workerName: input.workerName,
        workerResourceUid: input.workerResourceUid,
      });
      if (
        row.bound_space !== input.space ||
        row.bound_worker_name !== input.workerName ||
        row.worker_resource_uid !== input.workerResourceUid ||
        row.worker_resource_revision !== snapshot.listing.revision ||
        row.provider_pack_ref !== input.providerPackRef ||
        row.provider_installation_ref !== input.providerInstallationRef
      ) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      if (row.endpoint_resource_uid !== null) {
        return await exactEndpointAssignment(row, input);
      }
      if (row.state !== "bound") {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      try {
        const assigned = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET bound_endpoint_name = ?, endpoint_resource_uid = ?,
               endpoint_resource_revision = ?, revision = revision + 1, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND state = 'bound'
             AND revision = ? AND endpoint_resource_uid IS NULL
             AND bound_endpoint_name IS NULL AND endpoint_resource_revision IS NULL
             AND bound_space = ? AND bound_worker_name = ?
             AND worker_resource_uid = ? AND worker_resource_revision = ?
             AND provider_pack_ref = ? AND provider_installation_ref = ?`,
          [
            input.endpointName,
            input.endpointResourceUid,
            input.endpointResourceRevision,
            now(),
            input.organizationId,
            input.reservationId,
            row.revision,
            input.space,
            input.workerName,
            input.workerResourceUid,
            snapshot.listing.revision,
            input.providerPackRef,
            input.providerInstallationRef,
          ],
        );
        if (assigned.changes !== 1) {
          row = await readRow(options.sql, input.organizationId, input.reservationId);
          if (row && row.endpoint_resource_uid !== null) {
            return await exactEndpointAssignment(row, input);
          }
          throw new WorkerEndpointOriginReservationError("conflict", 409);
        }
      } catch (error) {
        const raced = await readRow(options.sql, input.organizationId, input.reservationId);
        if (raced && raced.endpoint_resource_uid !== null) {
          return await exactEndpointAssignment(raced, input);
        }
        if (
          await liveEndpointCollision(
            options.sql,
            input.organizationId,
            input.endpointResourceUid,
            input.reservationId,
          )
        ) {
          throw new WorkerEndpointOriginReservationError("conflict", 409);
        }
        if (error instanceof WorkerEndpointOriginReservationError) throw error;
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      row = await readRow(options.sql, input.organizationId, input.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      return await exactEndpointAssignment(row, input);
    },

    async cancelEndpointAssignment(assignment) {
      normalizeIdentity(assignment.organizationId, assignment.reservationId);
      const row = await readRow(options.sql, assignment.organizationId, assignment.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
      if (
        row.endpoint_resource_uid === null &&
        (row.state === "bound" || row.state === "expired")
      ) {
        return;
      }
      await assertExactAssignment(row, assignment);
      if (assignment.reservationRevision !== String(row.revision)) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      if (row.state !== "bound" && row.state !== "expired") {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      let cancelled: SqlWrite;
      try {
        cancelled = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET bound_endpoint_name = NULL, endpoint_resource_uid = NULL,
               endpoint_resource_revision = NULL, revision = revision + 1, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND revision = ?
             AND state IN ('bound', 'expired')
             AND bound_endpoint_name = ? AND endpoint_resource_uid = ?
             AND endpoint_resource_revision = ?`,
          [
            now(),
            assignment.organizationId,
            assignment.reservationId,
            row.revision,
            assignment.endpoint.name,
            assignment.endpoint.uid,
            assignment.endpoint.revision,
          ],
        );
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (cancelled.changes !== 1) {
        const current = await readRow(
          options.sql,
          assignment.organizationId,
          assignment.reservationId,
        );
        if (
          current?.endpoint_resource_uid === null &&
          (current.state === "bound" || current.state === "expired")
        ) {
          return;
        }
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
    },

    async activateEndpointAssignment(input) {
      const { assignment } = input;
      normalizeIdentity(assignment.organizationId, assignment.reservationId);
      const row = await readRow(options.sql, assignment.organizationId, assignment.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
      await assertExactAssignment(row, assignment);
      if (providerOutputOrigin(input.providerOutputs) !== assignment.canonicalPublicOrigin) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      if (row.state === "activated") return await assignmentProjection(row);
      if (row.state !== "bound" && row.state !== "expired") {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      let activated: SqlWrite;
      try {
        activated = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET state = 'activated', revision = revision + 1, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND revision = ?
             AND state IN ('bound', 'expired') AND bound_endpoint_name = ?
             AND endpoint_resource_uid = ? AND endpoint_resource_revision = ?`,
          [
            now(),
            assignment.organizationId,
            assignment.reservationId,
            row.revision,
            assignment.endpoint.name,
            assignment.endpoint.uid,
            assignment.endpoint.revision,
          ],
        );
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (activated.changes !== 1) {
        const current = await readRow(
          options.sql,
          assignment.organizationId,
          assignment.reservationId,
        );
        if (current?.state === "activated") {
          await assertExactAssignment(current, assignment);
          return await assignmentProjection(current);
        }
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      const current = await readRow(
        options.sql,
        assignment.organizationId,
        assignment.reservationId,
      );
      if (current?.state !== "activated") {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      return await assignmentProjection(current);
    },

    async endpointAssignment(organizationId, endpointResourceUid) {
      validateOpaque(organizationId);
      validateOpaque(endpointResourceUid);
      let rows: readonly Row[];
      try {
        rows = await options.sql.query(
          `SELECT * FROM worker_endpoint_origin_reservations
           WHERE organization_id = ? AND endpoint_resource_uid = ?
             AND state IN ('bound', 'activated', 'expired') LIMIT 2`,
          [organizationId, endpointResourceUid],
        );
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (rows.length === 0) return null;
      if (rows.length !== 1 || !rows[0]) {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      const row = reservationRow(rows[0]);
      // Delete/recovery needs the immutable assignment even when its Worker is
      // degraded, deleting, or no longer present in the current sales catalog.
      // Mutation callers independently revalidate the exact live relation and
      // placement before they cross the Provider boundary.
      return await assignmentProjection(row);
    },

    async deactivateEndpointAssignment(assignment) {
      normalizeIdentity(assignment.organizationId, assignment.reservationId);
      const row = await readRow(options.sql, assignment.organizationId, assignment.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
      await assertExactAssignment(row, assignment);
      if (row.state === "bound" || row.state === "expired") return;
      if (row.state !== "activated") {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      let deactivated: SqlWrite;
      try {
        deactivated = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'bound' END,
               revision = revision + 1, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND revision = ?
             AND state = 'activated' AND bound_endpoint_name = ?
             AND endpoint_resource_uid = ? AND endpoint_resource_revision = ?`,
          [
            now(),
            now(),
            assignment.organizationId,
            assignment.reservationId,
            row.revision,
            assignment.endpoint.name,
            assignment.endpoint.uid,
            assignment.endpoint.revision,
          ],
        );
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (deactivated.changes !== 1) {
        const current = await readRow(
          options.sql,
          assignment.organizationId,
          assignment.reservationId,
        );
        if (current?.state === "bound" || current?.state === "expired") {
          await assertExactAssignment(current, assignment);
          return;
        }
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
    },
  };
}

interface PlannedPlacement {
  readonly provider: Provider;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
}

interface PlannedOrigin extends Omit<PlannedPlacement, "provider"> {
  readonly canonicalPublicOrigin: string;
}

type ReservationState = "prepared" | "bound" | "activated" | "expired" | "released";
type ReservationFormat =
  | typeof LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT
  | typeof WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT;

interface ReservationRow {
  readonly organization_id: string;
  readonly reservation_id: string;
  readonly reservation_format: ReservationFormat;
  readonly legacy_space: string | null;
  readonly legacy_worker_name: string | null;
  readonly legacy_endpoint_name: string | null;
  readonly requested_subdomain: string | null;
  readonly canonical_public_origin: string;
  readonly provider_pack_ref: string;
  readonly provider_installation_ref: string;
  readonly offering_id: string;
  readonly offering_digest: `sha256:${string}`;
  readonly requested_ttl_seconds: number;
  readonly expires_at: number;
  readonly state: ReservationState;
  readonly revision: number;
  readonly bound_space: string | null;
  readonly bound_worker_name: string | null;
  readonly worker_resource_uid: string | null;
  readonly worker_resource_revision: string | null;
  readonly bound_endpoint_name: string | null;
  readonly endpoint_resource_uid: string | null;
  readonly endpoint_resource_revision: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly released_at: number | null;
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
  const organizationId = string(row.organization_id);
  const reservationId = string(row.reservation_id);
  const reservationFormat = string(row.reservation_format);
  const legacySpace = nullableString(row.legacy_space);
  const legacyWorkerName = nullableString(row.legacy_worker_name);
  const legacyEndpointName = nullableString(row.legacy_endpoint_name);
  const requested = nullableString(row.requested_subdomain);
  const canonicalPublicOrigin = string(row.canonical_public_origin);
  const providerPackRef = string(row.provider_pack_ref);
  const providerInstallationRef = string(row.provider_installation_ref);
  const offeringId = string(row.offering_id);
  const state = string(row.state);
  const revision = safeInteger(row.revision);
  const expiresAt = safeInteger(row.expires_at);
  const requestedTtl = safeInteger(row.requested_ttl_seconds);
  const offeringDigest = string(row.offering_digest);
  const boundSpace = nullableString(row.bound_space);
  const boundWorkerName = nullableString(row.bound_worker_name);
  const workerResourceUid = nullableString(row.worker_resource_uid);
  const workerResourceRevision = nullableString(row.worker_resource_revision);
  const boundEndpointName = nullableString(row.bound_endpoint_name);
  const endpointResourceUid = nullableString(row.endpoint_resource_uid);
  const endpointResourceRevision = nullableString(row.endpoint_resource_revision);
  const createdAt = safeInteger(row.created_at);
  const updatedAt = safeInteger(row.updated_at);
  const releasedAt = nullableSafeInteger(row.released_at);
  const legacyShape =
    reservationFormat === LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT &&
    requested === null &&
    validResourceName(legacySpace) &&
    validResourceName(legacyWorkerName) &&
    validResourceName(legacyEndpointName);
  const currentShape =
    reservationFormat === WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT &&
    requested !== null &&
    requestedSubdomain.test(requested) &&
    legacySpace === null &&
    legacyWorkerName === null &&
    legacyEndpointName === null;
  const unboundWorker =
    boundSpace === null &&
    boundWorkerName === null &&
    workerResourceUid === null &&
    workerResourceRevision === null;
  const boundWorker =
    validResourceName(boundSpace) &&
    validResourceName(boundWorkerName) &&
    validOpaque(workerResourceUid) &&
    workerResourceRevision !== null &&
    canonicalRevision(workerResourceRevision);
  const unboundEndpoint =
    boundEndpointName === null && endpointResourceUid === null && endpointResourceRevision === null;
  const boundEndpoint =
    validResourceName(boundEndpointName) &&
    validOpaque(endpointResourceUid) &&
    endpointResourceRevision !== null &&
    canonicalRevision(endpointResourceRevision);
  if (
    !validOpaque(organizationId) ||
    !validOpaque(reservationId) ||
    (!legacyShape && !currentShape) ||
    !liveOrTerminalState(state) ||
    revision < 1 ||
    !dateEpochMilliseconds(createdAt) ||
    !dateEpochMilliseconds(expiresAt) ||
    !dateEpochMilliseconds(updatedAt) ||
    expiresAt <= createdAt ||
    updatedAt < createdAt ||
    requestedTtl < MINIMUM_TTL_SECONDS ||
    requestedTtl > MAXIMUM_TTL_SECONDS ||
    !canonicalOrigin(canonicalPublicOrigin) ||
    canonicalPublicOrigin.length > 2_048 ||
    !boundedText(providerPackRef, 255) ||
    !boundedText(providerInstallationRef, 255) ||
    !boundedText(offeringId, 255) ||
    !digest.test(offeringDigest) ||
    (!unboundWorker && !boundWorker) ||
    (!unboundEndpoint && !boundEndpoint) ||
    (boundEndpoint && !boundWorker) ||
    (state === "prepared" && (!unboundWorker || !unboundEndpoint)) ||
    ((state === "bound" || state === "activated") && !boundWorker) ||
    (state === "activated" && !boundEndpoint) ||
    (state === "released") !== (releasedAt !== null) ||
    (releasedAt !== null && (!dateEpochMilliseconds(releasedAt) || releasedAt < createdAt))
  ) {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return {
    organization_id: organizationId,
    reservation_id: reservationId,
    reservation_format: reservationFormat as ReservationFormat,
    legacy_space: legacySpace,
    legacy_worker_name: legacyWorkerName,
    legacy_endpoint_name: legacyEndpointName,
    requested_subdomain: requested,
    canonical_public_origin: canonicalPublicOrigin,
    provider_pack_ref: providerPackRef,
    provider_installation_ref: providerInstallationRef,
    offering_id: offeringId,
    offering_digest: offeringDigest as `sha256:${string}`,
    requested_ttl_seconds: requestedTtl,
    expires_at: expiresAt,
    state,
    revision,
    bound_space: boundSpace,
    bound_worker_name: boundWorkerName,
    worker_resource_uid: workerResourceUid,
    worker_resource_revision: workerResourceRevision,
    bound_endpoint_name: boundEndpointName,
    endpoint_resource_uid: endpointResourceUid,
    endpoint_resource_revision: endpointResourceRevision,
    created_at: createdAt,
    updated_at: updatedAt,
    released_at: releasedAt,
  };
}

async function liveCollision(
  sql: Sql,
  requested: string,
  canonicalPublicOrigin: string,
): Promise<boolean> {
  let rows: readonly Row[];
  try {
    rows = await sql.query(
      `SELECT reservation_id FROM worker_endpoint_origin_reservations
       WHERE (state IN ('prepared', 'bound', 'activated')
              OR (state = 'expired' AND endpoint_resource_uid IS NOT NULL))
         AND (requested_subdomain = ? OR canonical_public_origin = ?)
       LIMIT 1`,
      [requested, canonicalPublicOrigin],
    );
  } catch {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return rows.length > 0;
}

async function liveWorkerCollision(
  sql: Sql,
  organizationId: string,
  space: string,
  workerName: string,
  exceptReservationId: string,
): Promise<boolean> {
  let rows: readonly Row[];
  try {
    rows = await sql.query(
      `SELECT reservation_id FROM worker_endpoint_origin_reservations
       WHERE organization_id = ?
         AND (
           (bound_space = ? AND bound_worker_name = ?) OR
           (reservation_format = ? AND legacy_space = ? AND legacy_worker_name = ?)
         )
         AND reservation_id <> ?
         AND (
           (reservation_format = ? AND state IN ('prepared', 'bound', 'activated')) OR
           (bound_space IS NOT NULL AND bound_worker_name IS NOT NULL AND (
             state IN ('bound', 'activated') OR
             (state = 'expired' AND endpoint_resource_uid IS NOT NULL)
           ))
         )
       LIMIT 1`,
      [
        organizationId,
        space,
        workerName,
        LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
        space,
        workerName,
        exceptReservationId,
        LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      ],
    );
  } catch {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return rows.length > 0;
}

async function liveEndpointCollision(
  sql: Sql,
  organizationId: string,
  endpointResourceUid: string,
  exceptReservationId: string,
): Promise<boolean> {
  let rows: readonly Row[];
  try {
    rows = await sql.query(
      `SELECT reservation_id FROM worker_endpoint_origin_reservations
       WHERE organization_id = ? AND endpoint_resource_uid = ? AND reservation_id <> ?
         AND (state IN ('bound', 'activated')
              OR (state = 'expired' AND endpoint_resource_uid IS NOT NULL))
       LIMIT 1`,
      [organizationId, endpointResourceUid, exceptReservationId],
    );
  } catch {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return rows.length > 0;
}

function exactReplay(
  row: ReservationRow,
  requested: string,
  plan: PlannedOrigin,
  expiresInSeconds: number,
): WorkerEndpointOriginReservationProjection {
  if (
    !liveState(row.state) ||
    row.reservation_format !== WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT ||
    row.requested_subdomain !== requested ||
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
  const base = {
    reservationId: row.reservation_id,
    canonicalPublicOrigin: row.canonical_public_origin,
    revision: String(row.revision),
    expiresAt: new Date(row.expires_at).toISOString(),
    status: row.state,
  };
  if (row.reservation_format === LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT) {
    if (!row.legacy_space || !row.legacy_worker_name || !row.legacy_endpoint_name) {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    return {
      format: LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      ...base,
      target: {
        space: row.legacy_space,
        workerName: row.legacy_worker_name,
        endpointName: row.legacy_endpoint_name,
      },
      ...(row.worker_resource_uid ? { workerResourceUid: row.worker_resource_uid } : {}),
      ...(row.endpoint_resource_uid ? { endpointResourceUid: row.endpoint_resource_uid } : {}),
    };
  }
  if (!row.requested_subdomain) {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return {
    format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
    ...base,
    requestedSubdomain: row.requested_subdomain,
    ...(row.worker_resource_uid ? { binding: bindingProjection(row) } : {}),
  };
}

function boundProjection(row: ReservationRow): BoundWorkerEndpointOriginReservation {
  if (
    (row.state !== "bound" && row.state !== "activated") ||
    !row.bound_space ||
    !row.bound_worker_name ||
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
    ...(row.requested_subdomain ? { requestedSubdomain: row.requested_subdomain } : {}),
    binding: bindingProjection(row),
    status: row.state,
    providerPackRef: row.provider_pack_ref,
    providerInstallationRef: row.provider_installation_ref,
    offeringId: row.offering_id,
    offeringDigest: row.offering_digest,
  };
}

async function exactEndpointAssignment(
  row: ReservationRow,
  input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly space: string;
    readonly endpointName: string;
    readonly endpointResourceUid: string;
    readonly endpointResourceRevision: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
    readonly providerPackRef: string;
    readonly providerInstallationRef: string;
  },
): Promise<WorkerEndpointOriginAssignment> {
  if (
    row.organization_id !== input.organizationId ||
    row.reservation_id !== input.reservationId ||
    row.bound_space !== input.space ||
    row.bound_worker_name !== input.workerName ||
    row.worker_resource_uid !== input.workerResourceUid ||
    row.bound_endpoint_name !== input.endpointName ||
    row.endpoint_resource_uid !== input.endpointResourceUid ||
    row.endpoint_resource_revision !== input.endpointResourceRevision ||
    row.provider_pack_ref !== input.providerPackRef ||
    row.provider_installation_ref !== input.providerInstallationRef
  ) {
    throw new WorkerEndpointOriginReservationError("conflict", 409);
  }
  return await assignmentProjection(row);
}

async function assignmentProjection(row: ReservationRow): Promise<WorkerEndpointOriginAssignment> {
  const reservationIdentity =
    row.reservation_format === WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT && row.requested_subdomain
      ? { requestedSubdomain: row.requested_subdomain }
      : row.reservation_format === LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT &&
          row.legacy_space &&
          row.legacy_worker_name &&
          row.legacy_endpoint_name
        ? {
            legacyTarget: {
              space: row.legacy_space,
              workerName: row.legacy_worker_name,
              endpointName: row.legacy_endpoint_name,
            },
          }
        : null;
  if (
    !reservationIdentity ||
    !row.bound_space ||
    !row.bound_worker_name ||
    !row.worker_resource_uid ||
    !row.worker_resource_revision ||
    !row.bound_endpoint_name ||
    !row.endpoint_resource_uid ||
    !row.endpoint_resource_revision
  ) {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  const exact = {
    format: WORKER_ENDPOINT_ORIGIN_ASSIGNMENT_FORMAT,
    organizationId: row.organization_id,
    reservationId: row.reservation_id,
    canonicalPublicOrigin: row.canonical_public_origin,
    ...reservationIdentity,
    endpoint: {
      space: row.bound_space,
      name: row.bound_endpoint_name,
      uid: row.endpoint_resource_uid,
      revision: row.endpoint_resource_revision,
    },
    worker: {
      name: row.bound_worker_name,
      uid: row.worker_resource_uid,
      revision: row.worker_resource_revision,
    },
    placement: {
      providerPackRef: row.provider_pack_ref,
      providerInstallationRef: row.provider_installation_ref,
      offeringId: row.offering_id,
      offeringDigest: row.offering_digest,
    },
  } as const;
  return {
    format: exact.format,
    organizationId: exact.organizationId,
    reservationId: exact.reservationId,
    reservationRevision: String(row.revision),
    canonicalPublicOrigin: exact.canonicalPublicOrigin,
    assignmentDigest: await canonicalDigest(exact),
    endpoint: exact.endpoint,
    worker: exact.worker,
    placement: {
      providerPackRef: exact.placement.providerPackRef,
      providerInstallationRef: exact.placement.providerInstallationRef,
    },
  };
}

async function assertExactAssignment(
  row: ReservationRow,
  expected: WorkerEndpointOriginAssignment,
): Promise<void> {
  const current = await assignmentProjection(row);
  if (
    current.organizationId !== expected.organizationId ||
    current.reservationId !== expected.reservationId ||
    current.canonicalPublicOrigin !== expected.canonicalPublicOrigin ||
    current.assignmentDigest !== expected.assignmentDigest ||
    current.endpoint.space !== expected.endpoint.space ||
    current.endpoint.name !== expected.endpoint.name ||
    current.endpoint.uid !== expected.endpoint.uid ||
    current.endpoint.revision !== expected.endpoint.revision ||
    current.worker.name !== expected.worker.name ||
    current.worker.uid !== expected.worker.uid ||
    current.worker.revision !== expected.worker.revision ||
    current.placement.providerPackRef !== expected.placement.providerPackRef ||
    current.placement.providerInstallationRef !== expected.placement.providerInstallationRef
  ) {
    throw new WorkerEndpointOriginReservationError("conflict", 409);
  }
}

function providerOutputOrigin(outputs: JsonObject): string | null {
  if (typeof outputs.url !== "string" || outputs.url.length > 2_048) return null;
  try {
    const url = new URL(outputs.url);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      (outputs.hostname !== undefined && outputs.hostname !== url.hostname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function bindingProjection(row: ReservationRow): WorkerEndpointOriginReservationBinding {
  if (
    !row.bound_space ||
    !row.bound_worker_name ||
    !row.worker_resource_uid ||
    !row.worker_resource_revision
  ) {
    throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
  }
  return {
    space: row.bound_space,
    workerName: row.bound_worker_name,
    workerResourceUid: row.worker_resource_uid,
    workerResourceRevision: row.worker_resource_revision,
    ...(row.bound_endpoint_name ? { endpointName: row.bound_endpoint_name } : {}),
    ...(row.endpoint_resource_uid ? { endpointResourceUid: row.endpoint_resource_uid } : {}),
    ...(row.endpoint_resource_revision
      ? { endpointResourceRevision: row.endpoint_resource_revision }
      : {}),
  };
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
  const desiredWorker = endpoint.listing.resource.spec.worker;
  if (
    !isRecord(desiredWorker) ||
    desiredWorker.apiVersion !== MODULE_WORKER_FORM_REF.apiVersion ||
    desiredWorker.kind !== "ModuleWorker" ||
    desiredWorker.name !== workerName
  ) {
    return false;
  }
  const relations = endpoint.relations.filter(
    (relation) => relation.pointer === "/worker" && relation.relation === "/worker",
  );
  return (
    relations.length === 1 &&
    relations[0]?.targetKind === "ModuleWorker" &&
    relations[0].targetApiVersion === MODULE_WORKER_FORM_REF.apiVersion &&
    relations[0].targetUid === workerResourceUid &&
    relations[0].targetName === workerName &&
    sameForm(relations[0].targetFormRef, MODULE_WORKER_FORM_REF)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function validateRequestedSubdomain(value: string): void {
  if (!requestedSubdomain.test(value)) {
    throw new WorkerEndpointOriginReservationError("invalid_argument", 400);
  }
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

function validResourceName(value: string | null): value is string {
  return value !== null && resourceName.test(value);
}

function validOpaque(value: string | null): value is string {
  return value !== null && opaqueId.test(value);
}

function boundedText(value: string, maximumLength: number): boolean {
  return value.length >= 1 && value.length <= maximumLength;
}

function dateEpochMilliseconds(value: number): boolean {
  return value >= 0 && value <= MAXIMUM_DATE_EPOCH_MILLISECONDS;
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

function nullableSafeInteger(value: unknown): number | null {
  if (value === null) return null;
  return safeInteger(value);
}
