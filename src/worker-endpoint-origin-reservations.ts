import type { Catalog } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "./generated/takoform-stable-v1-catalog.ts";
import { canonicalDigest } from "./json.ts";
import type { Clock, JsonObject, Row, Sql, SqlWrite } from "./ports.ts";
import { createSoldProviderPlacementSelector } from "./provider-placement.ts";
import type { Provider } from "./provider-port.ts";
import {
  derivedProviderResourceIncarnationName,
  workerEndpointPublicationDefect,
  workerEndpointPublicationRemedy,
} from "./provider-worker-endpoint-origin.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";
import type { ResourceWithRelations, TakoformStore } from "./takoform/store.ts";
import { workerServiceCondition } from "./takoform/worker-aggregate.ts";

export const WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT =
  "takoserver.worker-endpoint-origin-reservation.v2" as const;
export const LEGACY_WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT =
  "takoserver.worker-endpoint-origin-reservation.v1" as const;
export const WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT =
  "takoserver.worker-endpoint-origin-reservation-activation.v2" as const;
export const WORKER_ENDPOINT_ORIGIN_ASSIGNMENT_FORMAT =
  "takoserver.worker-endpoint-origin-assignment.v1" as const;

/**
 * The reservation-id namespace this Host mints in, and no caller may write to.
 *
 * A Host-minted reservation is derived, not requested, and the live-uniqueness
 * ADR 0004 states is unchanged: one live reservation per organization, Space
 * and logical Worker. The prefix is the fence — the public control route
 * refuses it, so a reservation in this namespace is always one this Host made,
 * and `mintForWorker` never adopts, or releases, a row a caller wrote.
 */
export const HOST_MINTED_RESERVATION_PREFIX = "hostmint-";
/** Long enough to outlive an apply, short enough that an abandoned one ages out. */
const HOST_MINTED_TTL_SECONDS = 24 * 60 * 60;

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
    /**
     * One sanitized sentence the caller reads instead of the code-derived one.
     *
     * A refusal about *this deployment's configuration* is the caller's to act
     * on but not the caller's to have caused, so the code alone tells them
     * nothing they can use. Only text this module composes reaches here.
     */
    readonly publicMessage?: string,
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
  /**
   * Reserves this Host's own derived origin for one exact Ready ModuleWorker,
   * on behalf of a caller that has no reservation input at all.
   *
   * `null` means the selected installation does not derive its own endpoint
   * address, so there is nothing to mint and the caller must supply one. The
   * returned reservation is `bound` to the exact Worker and is ready for
   * `assignEndpoint`.
   *
   * There is deliberately no `offeringId` input. A reservation is placed on
   * the **ModuleWorker's** Offering — everything downstream compares it with
   * the Worker's active provider Deployment — and the only caller is a
   * `WorkerEndpoint` mutation, which holds the WorkerEndpoint's Offering. A
   * WorkerEndpoint Offering id is never in the ModuleWorker candidate list, so
   * passing one refused every mint with `unsupported_capability`. The
   * authority therefore reads the placement off the exact Worker itself.
   */
  mintForWorker(input: {
    readonly organizationId: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  }): Promise<BoundWorkerEndpointOriginReservation | null>;
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
  /**
   * Lets go of an exact assignment whose mutation failed *after* activation.
   *
   * `cancelEndpointAssignment` is the pre-dispatch one and pins the revision it
   * was handed, which activation has already moved. This one takes the
   * activated assignment, deactivates and drops the witness in a single CAS,
   * and is fenced on the endpoint incarnation itself rather than on a revision:
   * the exact assignment identity, no `tf_resources` row for that endpoint UID,
   * and no provider Deployment outside `deleted`/`failed`. Without it, a
   * refusal raised after the endpoint was activated left the reservation
   * pinned to an address it could never publish, and that space could never
   * create the endpoint again.
   */
  releaseEndpointAssignment(assignment: WorkerEndpointOriginAssignment): Promise<void>;
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
  /**
   * `resourcesByRelation` and `readResource` are here because a Worker's
   * readiness is *derived*, and this authority derives it rather than reading
   * the cached condition on the row. See `workerReady`.
   */
  readonly resources: Pick<
    TakoformStore,
    "resourceWithRelationsByUid" | "resourcesByRelation" | "readResource"
  >;
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
    // The installation states which scheme it serves; this ledger holds it to
    // that one and to nothing else. An installation that declares nothing is
    // https, so the managed and ordinary-workers lanes are unchanged.
    if (
      !derived ||
      !canonicalOrigin(derived.canonicalPublicOrigin, capability.publishedScheme ?? "https")
    ) {
      throw new WorkerEndpointOriginReservationError("unsupported_capability", 422);
    }
    // And whether the published Form can carry it at all, decided here because
    // here is before any mutation. `WorkerEndpoint@0.1.0` publishes
    // `^https://<dotted-name>/$`, so an address that is honest about a
    // plain-HTTP socket or a non-default port is one no receipt could ever
    // project — and discovering that after the provider had created the
    // endpoint is what left a space wedged with an activated reservation and no
    // Resource. The installation still serves that address; it simply cannot
    // publish it as a WorkerEndpoint.
    const defect = workerEndpointPublicationDefect(derived.canonicalPublicOrigin);
    if (defect) {
      throw new WorkerEndpointOriginReservationError(
        "unsupported_capability",
        422,
        workerEndpointPublicationRemedy(defect),
      );
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
           AND state IN ('prepared', 'bound') AND expires_at <= ?`,
        [timestamp, organizationId, reservationId, timestamp],
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
           AND (requested_subdomain = ? OR canonical_public_origin = ?)`,
        [timestamp, timestamp, requestedSubdomain, canonicalPublicOrigin],
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

  /**
   * Whether this ModuleWorker is serving *now*, derived rather than read.
   *
   * A ModuleWorker's `Ready` condition is a projection of its WorkerDeployment
   * graph that the Host refreshes lazily — on a read of the Worker, or on its
   * own apply. Nothing re-renders it when a *dependent* is created, so through
   * the whole of a first `tofu apply` the row still says "has no active
   * WorkerDeployment" from the moment it was created: the deployment lands, the
   * endpoint is created a moment later, and the reservation refused a Worker
   * that had been serving for a second. The apply failed `resource_busy` 409
   * once, and the next run — which reads the Worker during refresh, and so
   * re-renders it — succeeded with no change at all.
   *
   * So readiness is asked of the same authority the engine's own attachment
   * rule asks, and the stored condition is left as what it is: a cache.
   */
  const workerReady = async (
    organizationId: string,
    snapshot: ResourceWithRelations,
  ): Promise<boolean> => {
    let condition: Awaited<ReturnType<typeof workerServiceCondition>>;
    try {
      condition = await workerServiceCondition({
        tenantId: organizationId,
        resource: snapshot.listing.resource,
        store: options.resources,
      });
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    return condition?.status === "True";
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
      !currentIncarnation(snapshot, "ModuleWorker") ||
      !sameForm(snapshot.listing.resource.form.formRef, MODULE_WORKER_FORM_REF) ||
      !(await workerReady(row.organization_id, snapshot))
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

  /**
   * Lets go of a reservation, under the four fences ADR 0004 states.
   *
   * Named rather than inline because the Host-minted lane needs it too: a
   * reservation this Host derived for a logical Worker is reclaimed by the
   * same rule a caller's explicit DELETE goes through, never by a shortcut.
   */
  const releaseReservation = async (
    organizationId: string,
    reservationId: string,
  ): Promise<void> => {
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
        [timestamp, timestamp, organizationId, reservationId, row.revision],
      );
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    if (released.changes !== 1) {
      const current = await readRow(options.sql, organizationId, reservationId);
      if (!current || current.state === "released") return;
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
  };

  /**
   * Frees a Host-minted reservation that describes a Worker incarnation which
   * is gone.
   *
   * The id names a Worker incarnation, so a destroy followed by a re-apply
   * asks for a different reservation on the same address — and the previous
   * one still owns that address until it is let go of.
   * Release is the one fenced way to do that: ADR 0004 requires the
   * retained endpoint Resource to be absent, its deletion attestation closed,
   * and no provider deployment outside `deleted`/`failed`. If those do not
   * hold, the old endpoint may still be serving on that origin and the mint
   * fails rather than reallocating it.
   */
  const releaseSupersededHostMint = async (input: {
    readonly organizationId: string;
    readonly requestedSubdomain: string;
    readonly reservationId: string;
  }): Promise<void> => {
    let rows: readonly Row[];
    try {
      rows = await options.sql.query(
        `SELECT reservation_id, state, endpoint_resource_uid
         FROM worker_endpoint_origin_reservations
         WHERE organization_id = ? AND requested_subdomain = ?
         LIMIT 8`,
        [input.organizationId, input.requestedSubdomain],
      );
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    for (const row of rows) {
      const reservationId = String(row.reservation_id);
      // Never a reservation a caller made. One that owns this address is the
      // caller's authority over it, and the mint below fails on the live
      // uniqueness constraint rather than taking it away.
      if (!reservationId.startsWith(HOST_MINTED_RESERVATION_PREFIX)) continue;
      if (String(row.state) === "released") continue;
      // And never the one about to be prepared. Its id is derived, so a
      // released row can never be re-minted: releasing it here would refuse
      // this Worker an endpoint for good. What that row has to let go of is
      // its endpoint witness, not itself.
      if (reservationId === input.reservationId) continue;
      // A superseded row may still be `activated`, and release refuses one
      // outright — which is right while an endpoint is answering on that
      // address, and wrong when the endpoint it names was never committed. So
      // the witness is offered the same in-place clear a live mint gets, under
      // the same four fences; if it takes, the row is `bound` with nothing
      // retained and the release below is the ordinary one. If it does not, the
      // release refuses and the mint fails rather than reallocating an origin
      // something may still be answering on.
      await clearSettledHostMintWitness({
        organizationId: input.organizationId,
        reservationId,
        strict: false,
      });
      await releaseReservation(input.organizationId, reservationId);
    }
  };

  /**
   * Takes back a Host-minted reservation that aged out without ever publishing.
   *
   * A mint is `bound` from the moment the Worker is Ready and holds its address
   * until the endpoint Resource is created. Nothing bounds how long that takes:
   * an operator pauses, an unrelated resource in the same graph fails, and the
   * apply is resumed the next morning. Past the 24 h TTL the sweep moves the
   * row to `expired`, and from there the lane had no way back — `prepare`
   * refuses to replay a terminal row, the superseded-release deliberately skips
   * the reservation it is about to prepare, and the witness clear wants an
   * endpoint that is not there. Since the id is a digest of the Worker
   * identity, there was no second id to mint: that Worker could never be given
   * an endpoint again.
   *
   * An expired reservation with no endpoint witness is a witness to nothing.
   * Nothing was published, so no address is answering, and the address is a
   * pure function of the same tenant/Space/Worker identity that derives the id
   * (ADR 0004) — so re-deriving it yields the same origin and `prepare` replays
   * it exactly. The row is therefore handed back to the state it was swept
   * from, on a fresh TTL, and the mint continues.
   *
   * Fenced the way the witness clear is: on identity and on incarnation state —
   * the Host-minted namespace, `expired`, no endpoint witness at all, and the
   * bound Worker being this exact one — never on a revision, which moves under
   * an apply for reasons that have nothing to do with whether the address is
   * free. A reservation that *did* publish is not reached here: its witness is
   * retained, ADR 0004 keeps it inside both uniqueness constraints, and only
   * the four absence fences let go of it.
   *
   * It runs the sweep itself, because this lane's sweep is lazy. Nothing ages a
   * reservation on a timer: a row past its TTL is still `bound` in the table
   * until some call reads it through `expire`, and inside a mint the only such
   * call is `prepare` — which runs *after* this one. So a revival that only
   * read the row saw `bound`, declined it for not being `expired`, and watched
   * `prepare` sweep it one statement later and refuse to replay a terminal row.
   * The state this repair exists for was unreachable from the only caller that
   * has it.
   */
  const reviveExpiredHostMint = async (input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  }): Promise<void> => {
    if (!input.reservationId.startsWith(HOST_MINTED_RESERVATION_PREFIX)) return;
    await expire(input.organizationId, input.reservationId);
    const row = await readRow(options.sql, input.organizationId, input.reservationId);
    if (
      !row ||
      row.state !== "expired" ||
      row.reservation_format !== WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT ||
      row.endpoint_resource_uid !== null ||
      // A bound row names the Worker it is a reservation *of*; one swept before
      // it bound names none yet. Neither is ever another Worker's.
      (row.worker_resource_uid !== null &&
        (row.bound_space !== input.space ||
          row.bound_worker_name !== input.workerName ||
          row.worker_resource_uid !== input.workerResourceUid))
    ) {
      return;
    }
    const timestamp = now();
    let revived: SqlWrite;
    try {
      revived = await options.sql.run(
        `UPDATE worker_endpoint_origin_reservations
         SET state = CASE WHEN worker_resource_uid IS NULL THEN 'prepared' ELSE 'bound' END,
             expires_at = ? + requested_ttl_seconds * 1000,
             revision = revision + 1, updated_at = ?
         WHERE organization_id = ? AND reservation_id = ? AND revision = ?
           AND state = 'expired' AND endpoint_resource_uid IS NULL`,
        [timestamp, timestamp, input.organizationId, input.reservationId, row.revision],
      );
    } catch {
      // Coming back makes the row live for the uniqueness constraints again.
      // Something else holding the address or the logical Worker is a
      // reservation this lane does not take away — most likely a caller's.
      if (
        (row.requested_subdomain !== null &&
          (await liveCollision(
            options.sql,
            row.requested_subdomain,
            row.canonical_public_origin,
          ))) ||
        (row.bound_space !== null &&
          row.bound_worker_name !== null &&
          (await liveWorkerCollision(
            options.sql,
            input.organizationId,
            row.bound_space,
            row.bound_worker_name,
            input.reservationId,
          )))
      ) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    if (revived.changes !== 1) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
  };

  /**
   * Lets a Host-minted reservation let go of an endpoint that is provably gone.
   *
   * Deactivation retains the endpoint UID as a deletion witness, and while it
   * is retained the reservation cannot take a new endpoint. For a caller's
   * reservation the answer is to release it and reserve again; for a derived
   * one there is no "again" — the id is a digest of the address, so a released
   * row ends that Worker's endpoint story permanently. So the witness is
   * dropped in place, under exactly the fences release uses: the endpoint
   * Resource absent, its deletion attestation closed, and no provider
   * deployment outside `deleted` or `failed`. While any of those is unmet the
   * old endpoint may still be serving, the witness stays, and the apply is
   * refused rather than pointed at an origin somebody else answers on.
   *
   * One incarnation can never satisfy "attestation closed", and it is the one a
   * failed create leaves behind. `reserveResourceIncarnation` opens the record
   * `live` before the Resource is committed, and a create that fails commits
   * nothing — so the record stays `live` for an incarnation that never existed,
   * a deletion that never happened can never close it, and the witness stood
   * forever. That shape is therefore released too: `live` with no Resource row
   * is an incarnation that was reserved and never committed. It is fenced on
   * identity and on the incarnation's own state — the endpoint UID, its
   * attestation, its deployments, and no provider effect still open on it —
   * never on a revision, which moves under an apply for reasons that have
   * nothing to do with whether the endpoint is there. A refusal now drops that
   * record outright rather than leaving it `live`, so an endpoint UID with no
   * attestation at all reads the same way: nothing was ever committed under it.
   *
   * **What "still open" means is the ledger's answer, not the effect row's.** An
   * effect goes `planned`, then `dispatched`, and its terminal event is written
   * by the commit — so a create refused *after* dispatch left an `apply` effect
   * with no terminal event, and the clause read that as a create that might
   * still land. It could not: the Host itself had refused the command and
   * recorded that refusal in the operation ledger. An effect whose operation is
   * recorded there as refused is settled, whatever its own last event says. One
   * whose operation is still running is not touched — that is a create this
   * mint would be robbing, and it is exactly what this fence is for.
   *
   * An **activated** row is repaired the same way, and it has to be. A refusal
   * raised after the Host had activated the assignment left exactly that shape
   * behind — reservation `activated`, deletion attestation `live`, no
   * `tf_resources` row, no open provider effect — and the release path could
   * not touch it, so the space could never create that endpoint again even
   * after the Host was rebooted into a configuration where every other space
   * succeeded on the first attempt. The refusal that produced it cannot happen
   * any more, but a database that already holds one has to come back on
   * upgrade, so the same fences let go of an activated witness and hand the row
   * back as `bound`.
   *
   * The expiry is restarted with it, because the only caller is a mint that is
   * happening right now: a row handed back with a spent clock would be expired
   * by `prepare`'s own sweep one statement later and refuse the mint it was
   * just repaired for.
   *
   * An **expired** row is repaired the same way, and for the same reason. A
   * deactivated reservation is swept like any other once its TTL runs out, and
   * ADR 0004 keeps it inside both uniqueness constraints while it still holds
   * the witness — so waiting does not free the address, and `prepare` refuses a
   * terminal row. The fences are the ones that matter here: whether that
   * endpoint is provably gone, never how long the row has been sitting there.
   */
  const clearSettledHostMintWitness = async (input: {
    readonly organizationId: string;
    readonly reservationId: string;
    /**
     * Whether a witness this could not drop is the answer.
     *
     * For the reservation a mint is about to prepare it is: the row cannot take
     * a new endpoint while it holds one, so refusing here is the refusal. For a
     * superseded row it is not — the release that follows asks the same
     * question and gives the refusal that names it.
     */
    readonly strict?: boolean;
  }): Promise<void> => {
    if (!input.reservationId.startsWith(HOST_MINTED_RESERVATION_PREFIX)) return;
    const row = await readRow(options.sql, input.organizationId, input.reservationId);
    if (
      !row ||
      (row.state !== "bound" && row.state !== "activated" && row.state !== "expired") ||
      row.endpoint_resource_uid === null
    ) {
      return;
    }
    const timestamp = now();
    let cleared: SqlWrite;
    try {
      cleared = await options.sql.run(
        `UPDATE worker_endpoint_origin_reservations
         SET state = 'bound',
             expires_at = ? + requested_ttl_seconds * 1000,
             bound_endpoint_name = NULL, endpoint_resource_uid = NULL,
             endpoint_resource_revision = NULL, revision = revision + 1, updated_at = ?
         WHERE organization_id = ? AND reservation_id = ? AND revision = ?
           AND state IN ('bound', 'activated', 'expired')
           AND endpoint_resource_uid IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM tf_resources AS endpoint_resource
             WHERE endpoint_resource.tenant_id = worker_endpoint_origin_reservations.organization_id
               AND endpoint_resource.uid = worker_endpoint_origin_reservations.endpoint_resource_uid
           )
           AND (
             EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations AS endpoint_deletion
               WHERE endpoint_deletion.tenant_id = worker_endpoint_origin_reservations.organization_id
                 AND endpoint_deletion.resource_uid = worker_endpoint_origin_reservations.endpoint_resource_uid
                 AND endpoint_deletion.state = 'closed'
             )
             OR NOT EXISTS (
               SELECT 1 FROM tf_resource_deletion_attestations AS endpoint_record
               WHERE endpoint_record.tenant_id = worker_endpoint_origin_reservations.organization_id
                 AND endpoint_record.resource_uid = worker_endpoint_origin_reservations.endpoint_resource_uid
             )
             OR (
               EXISTS (
                 SELECT 1 FROM tf_resource_deletion_attestations AS endpoint_reservation
                 WHERE endpoint_reservation.tenant_id = worker_endpoint_origin_reservations.organization_id
                   AND endpoint_reservation.resource_uid = worker_endpoint_origin_reservations.endpoint_resource_uid
                   AND endpoint_reservation.state = 'live'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM tf_resource_provider_effects AS open_effect
                 WHERE open_effect.tenant_id = worker_endpoint_origin_reservations.organization_id
                   AND open_effect.resource_uid = worker_endpoint_origin_reservations.endpoint_resource_uid
                   AND open_effect.phase IN ('planned', 'dispatched')
                   AND NOT EXISTS (
                     SELECT 1 FROM tf_resource_provider_effects AS terminal_effect
                     WHERE terminal_effect.tenant_id = open_effect.tenant_id
                       AND terminal_effect.resource_uid = open_effect.resource_uid
                       AND terminal_effect.effect_id = open_effect.effect_id
                       AND terminal_effect.phase IN ('succeeded', 'cancelled')
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM tf_deferred_operations AS refused_command
                     WHERE refused_command.id = open_effect.effect_id
                       AND refused_command.tenant_id = open_effect.tenant_id
                       AND refused_command.phase IN ('failed', 'cancelled')
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM tf_operations AS refused_operation
                     WHERE refused_operation.id = open_effect.effect_id
                       AND refused_operation.tenant_id = open_effect.tenant_id
                       AND refused_operation.state = 'failed'
                   )
               )
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM tf_resource_deployments AS endpoint_deployment
             WHERE endpoint_deployment.tenant_id = worker_endpoint_origin_reservations.organization_id
               AND endpoint_deployment.resource_uid = worker_endpoint_origin_reservations.endpoint_resource_uid
               AND endpoint_deployment.state NOT IN ('deleted', 'failed')
           )`,
        [timestamp, timestamp, input.organizationId, input.reservationId, row.revision],
      );
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    if (cleared.changes !== 1 && input.strict !== false) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
  };

  /**
   * Advances a Host-minted reservation to the Worker's current revision.
   *
   * A binding records the revision it was made at, and `bind` and
   * `assignEndpoint` both re-prove it. A ModuleWorker's revision moves on its
   * own — `withDerivedRendering` re-renders it whenever a dependent appears or
   * becomes Ready — so between a failed endpoint apply and its retry the
   * recorded revision is routinely stale, and every later attempt was refused
   * until the reservation aged out a day later.
   *
   * The reservation is still bound to the same Worker incarnation, which is
   * what it is a reservation *of*. `validateWorker` re-proves that incarnation
   * is the Ready, current-generation, actively deployed one at this exact
   * placement, and the CAS re-proves the revision it is moving to, so this
   * advances a binding rather than inventing one. Nothing here touches a
   * reservation a caller made: those keep the exact-replay semantics they had.
   */
  /**
   * The Offering a Host-minted reservation is placed on: the ModuleWorker's.
   *
   * A reservation's placement is compared, everywhere downstream, against the
   * Worker's **active provider Deployment** — `validateWorker` refuses a row
   * whose `offering_id` is not that Deployment's. So the one authoritative
   * answer to "which Offering is this reservation on" is the Deployment's own,
   * and reading it here means the mint can never prepare a row `bind` will
   * then refuse.
   *
   * The alternative — letting the WorkerEndpoint mutation name the Offering —
   * is what broke: the only Offering that mutation holds is the endpoint's,
   * and looking an endpoint Offering up in the ModuleWorker candidate list can
   * never match, so every Host-minted reservation was refused 422. Omitting it
   * instead would silently work only where exactly one ModuleWorker Offering
   * is sold, which is a property of the catalog rather than of this Worker.
   */
  const hostMintedWorkerOfferingId = async (identity: {
    readonly organizationId: string;
    readonly workerResourceUid: string;
  }): Promise<string> => {
    const deployment = await activeDeployment(
      options.deployments,
      identity.organizationId,
      identity.workerResourceUid,
    );
    // No active Deployment is not a placement problem: it means this is not
    // the Ready, deployed Worker a reservation can be made for, which is the
    // same refusal `validateWorker` gives one moment later.
    if (!deployment || deployment.resourceUid !== identity.workerResourceUid) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
    validateOpaque(deployment.offeringId);
    return deployment.offeringId;
  };

  const advanceHostMintToCurrentRevision = async (input: {
    readonly organizationId: string;
    readonly reservationId: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  }): Promise<void> => {
    if (!input.reservationId.startsWith(HOST_MINTED_RESERVATION_PREFIX)) return;
    const row = await readRow(options.sql, input.organizationId, input.reservationId);
    if (
      !row ||
      row.state !== "bound" ||
      row.endpoint_resource_uid !== null ||
      row.bound_space !== input.space ||
      row.bound_worker_name !== input.workerName ||
      row.worker_resource_uid !== input.workerResourceUid
    ) {
      return;
    }
    await assertPlacement(row);
    const { snapshot } = await validateWorker(row, input);
    if (row.worker_resource_revision === snapshot.listing.revision) return;
    let advanced: SqlWrite;
    try {
      advanced = await options.sql.run(
        `UPDATE worker_endpoint_origin_reservations
         SET worker_resource_revision = ?, revision = revision + 1, updated_at = ?
         WHERE organization_id = ? AND reservation_id = ? AND revision = ?
           AND state = 'bound' AND endpoint_resource_uid IS NULL
           AND bound_space = ? AND bound_worker_name = ? AND worker_resource_uid = ?
           AND EXISTS (
             SELECT 1 FROM tf_resources
             WHERE tenant_id = ? AND uid = ? AND space = ? AND name = ?
               AND kind = 'ModuleWorker' AND revision = ?
           )`,
        [
          snapshot.listing.revision,
          now(),
          input.organizationId,
          input.reservationId,
          row.revision,
          input.space,
          input.workerName,
          input.workerResourceUid,
          input.organizationId,
          input.workerResourceUid,
          input.space,
          input.workerName,
          snapshot.listing.revision,
        ],
      );
    } catch {
      throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
    }
    if (advanced.changes !== 1) {
      throw new WorkerEndpointOriginReservationError("conflict", 409);
    }
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

  const authority: WorkerEndpointOriginReservations = {
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

    release: releaseReservation,

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

    async mintForWorker(input) {
      normalizeIdentity(input.organizationId, input.workerResourceUid);
      validateTargetName(input.space);
      validateTargetName(input.workerName);
      const offeringId = await hostMintedWorkerOfferingId(input);
      const selection = await selectedPlacement(offeringId);
      const derive = selection.provider.workerEndpointOriginReservations?.hostMintedSubdomain;
      if (!derive) return null;
      let subdomain: string | null;
      try {
        subdomain = await derive({
          tenantRef: input.organizationId,
          space: input.space,
          workerName: input.workerName,
        });
      } catch {
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      if (subdomain === null) return null;
      if (!requestedSubdomain.test(subdomain)) {
        // The installation derived a label this contract cannot hold. That is
        // a composition defect, not a caller error, and it must not become a
        // reservation on some other origin.
        throw new WorkerEndpointOriginReservationError("unsupported_capability", 422);
      }
      const reservationId = await hostMintedReservationId(input);
      // In this order: let go of a *different* derived reservation on this
      // address, then take this one back if it aged out with nothing published,
      // then let it let go of an endpoint that is gone, then bring its binding
      // up to the Worker's current revision. Only after all four is the row in
      // a state `prepare` and `bind` will replay. The revive follows the
      // release because coming back re-enters the uniqueness constraints, and
      // it precedes the witness clear because that one wants a live row.
      await releaseSupersededHostMint({
        organizationId: input.organizationId,
        requestedSubdomain: subdomain,
        reservationId,
      });
      await reviveExpiredHostMint({
        organizationId: input.organizationId,
        reservationId,
        space: input.space,
        workerName: input.workerName,
        workerResourceUid: input.workerResourceUid,
      });
      await clearSettledHostMintWitness({
        organizationId: input.organizationId,
        reservationId,
      });
      await advanceHostMintToCurrentRevision({
        organizationId: input.organizationId,
        reservationId,
        space: input.space,
        workerName: input.workerName,
        workerResourceUid: input.workerResourceUid,
      });
      await authority.prepare({
        organizationId: input.organizationId,
        reservationId,
        requestedSubdomain: subdomain,
        offeringId,
        expiresInSeconds: HOST_MINTED_TTL_SECONDS,
      });
      return await authority.bind({
        organizationId: input.organizationId,
        reservationId,
        space: input.space,
        workerName: input.workerName,
        workerResourceUid: input.workerResourceUid,
      });
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

    async releaseEndpointAssignment(assignment) {
      normalizeIdentity(assignment.organizationId, assignment.reservationId);
      const row = await readRow(options.sql, assignment.organizationId, assignment.reservationId);
      if (!row) throw new WorkerEndpointOriginReservationError("not_found", 404);
      if (
        row.endpoint_resource_uid === null &&
        (row.state === "bound" || row.state === "expired")
      ) {
        return;
      }
      // Identity first, and the whole of it: organization, reservation, origin,
      // assignment digest, the endpoint's own name/UID/revision, the Worker
      // incarnation and revision, and the placement. Nothing here is fenced on
      // the reservation revision, which activation itself moved.
      await assertExactAssignment(row, assignment);
      if (row.state !== "activated" && row.state !== "bound" && row.state !== "expired") {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      let released: SqlWrite;
      try {
        released = await options.sql.run(
          `UPDATE worker_endpoint_origin_reservations
           SET state = CASE
                         WHEN state = 'activated' AND expires_at <= ? THEN 'expired'
                         WHEN state = 'activated' THEN 'bound'
                         ELSE state
                       END,
               bound_endpoint_name = NULL, endpoint_resource_uid = NULL,
               endpoint_resource_revision = NULL, revision = revision + 1, updated_at = ?
           WHERE organization_id = ? AND reservation_id = ? AND revision = ?
             AND state IN ('activated', 'bound', 'expired')
             AND bound_endpoint_name = ? AND endpoint_resource_uid = ?
             AND endpoint_resource_revision = ?
             AND NOT EXISTS (
               SELECT 1 FROM tf_resources AS endpoint_resource
               WHERE endpoint_resource.tenant_id = worker_endpoint_origin_reservations.organization_id
                 AND endpoint_resource.uid = worker_endpoint_origin_reservations.endpoint_resource_uid
             )
             AND NOT EXISTS (
               SELECT 1 FROM tf_resource_deployments AS endpoint_deployment
               WHERE endpoint_deployment.tenant_id = worker_endpoint_origin_reservations.organization_id
                 AND endpoint_deployment.resource_uid = worker_endpoint_origin_reservations.endpoint_resource_uid
                 AND endpoint_deployment.state NOT IN ('deleted', 'failed')
             )`,
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
      if (released.changes !== 1) {
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

  return authority;
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

/**
 * The origin a provider's own `url` output names, or nothing this can compare.
 *
 * Both web schemes are read here because the answer is only ever compared with
 * the origin the reservation already holds, and that one was accepted under the
 * scheme its installation declared. Pinning `https` here refused the address a
 * certificate-less self-host had just been reserved one step earlier.
 */
function providerOutputOrigin(outputs: JsonObject): string | null {
  if (typeof outputs.url !== "string" || outputs.url.length > 2_048) return null;
  try {
    const url = new URL(outputs.url);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
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

function currentIncarnation(snapshot: ResourceWithRelations, kind: string): boolean {
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
    canonicalRevision(listing.revision)
  );
}

function readyCurrent(snapshot: ResourceWithRelations, kind: string): boolean {
  return (
    currentIncarnation(snapshot, kind) &&
    snapshot.listing.resource.status.conditions.some(
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
  // Scheme and port are both settled by the last line: `expected` is the origin
  // this reservation owns, accepted under the scheme its installation declared,
  // and an origin comparison is exact about both. Requiring `https` and no port
  // here as well refused the address the same authority had just minted.
  return (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.username === "" &&
    parsed.password === "" &&
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

/**
 * The one Host-minted reservation id for a Worker incarnation.
 *
 * A retry of the same apply asks for the same reservation — that is the whole
 * point of deriving it — and a Worker destroyed and declared again asks for a
 * different one. Because the id can never be re-minted once its row is
 * *released*, nothing in this lane may release a row it is about to prepare: a
 * reservation whose endpoint went away is advanced in place, one the sweep took
 * while it held no endpoint is revived in place, and only a *different*
 * reservation on the same address is released.
 */
async function hostMintedReservationId(target: {
  readonly organizationId: string;
  readonly space: string;
  readonly workerName: string;
  readonly workerResourceUid: string;
}): Promise<string> {
  return await derivedProviderResourceIncarnationName("hostmint", {
    tenantRef: target.organizationId,
    space: target.space,
    name: target.workerName,
    uid: target.workerResourceUid,
  });
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

/**
 * Whether a derived address is one this ledger can own.
 *
 * With a `scheme`, that exact one: the scheme is a fact about the runtime that
 * serves the address ([ADR 0009](../docs/adr/0009-a-self-host-publishes-the-scheme-its-socket-serves.md)),
 * so the caller takes it from the installation that derived the address and
 * never from a request. Hard-coding `https` here is what made a
 * certificate-less self-host unable to create a `WorkerEndpoint` at all: the
 * provider derived the `http://` address its socket serves, this function
 * refused it, and the mint answered `unsupported_capability` 422 before
 * anything was reserved.
 *
 * Without one, either web scheme — which is what reading a durable row needs,
 * since the row was written under whichever scheme its own installation
 * declared and placement drift is fenced by re-deriving the address, not by
 * re-guessing its scheme here.
 *
 * A port is allowed, and `URL` normalizes the scheme's default away — so a
 * portless address stays portless and `…:28988` is held exactly as derived.
 */
function canonicalOrigin(value: string, scheme?: "https" | "http"): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (scheme === undefined
      ? parsed.protocol === "https:" || parsed.protocol === "http:"
      : parsed.protocol === `${scheme}:`) &&
    parsed.username === "" &&
    parsed.password === "" &&
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
