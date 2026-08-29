import { type Catalog, priceProvisioning } from "./catalog.ts";
import { type Ledger, LedgerError } from "./ledger.ts";
import type { Clock, Row, Sql } from "./ports.ts";

/**
 * The reseller lane: quote → reserve → capture or release.
 *
 * A reseller's own customer is named only by an opaque `tenantRef`. Nothing
 * here accepts an upstream user, workspace, or session identity, so Takoserver
 * never becomes a directory of somebody else's customers.
 *
 * Money lives in the ledger; these rows record what was offered and where the
 * reservation stands. The reservation id is the ledger reference that ties the
 * two together, which is what makes every step replay-safe: repeating a capture
 * writes no second ledger entry because the reference already exists.
 *
 * State transitions are guarded in SQL. `active → captured` is an UPDATE whose
 * WHERE names the state it expects, so a capture and a release racing for the
 * same reservation cannot both win.
 */

export interface Quote {
  readonly id: string;
  readonly tenantRef: string;
  readonly offeringId: string;
  readonly quantity: number;
  readonly currency: "USD";
  readonly amountMinor: number;
  /**
   * The usage meter the offering is billed by, baked in at quote time so a
   * reseller can settle a capture even after the offering leaves the catalog.
   */
  readonly meter: string;
  readonly expiresAt: string;
}

export type ReservationStatus = "active" | "captured" | "released" | "expired";

export interface Reservation {
  readonly id: string;
  readonly tenantRef: string;
  readonly quoteId: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
  readonly quantity: number;
  readonly amountMinor: number;
  readonly currency: "USD";
  /** The usage meter carried over from the quote. */
  readonly meter: string;
  readonly status: ReservationStatus;
  readonly expiresAt: string;
}

export interface UsageStatement {
  readonly reservationId: string;
  readonly tenantRef: string;
  readonly offeringId: string;
  readonly currency: "USD";
  readonly amountMinor: number;
  readonly usage: { readonly meter: string; readonly quantity: number };
  readonly capturedAt: string;
}

/** Durable value-only state for a reservation's cross-authority settlement. */
export type SettlementIntentState =
  | "pending"
  | "ready"
  | "captured"
  | "recovery_required"
  | "cancelled";

export type SettlementDirection = "capture" | "cancel";
export type CancellationPhase = "none" | "release_pending" | "release_succeeded" | "finalized";
export type SettlementTerminalStatus = "released" | "expired";

export interface SettlementIntent {
  readonly idempotencyKey: string;
  readonly organizationId: string;
  readonly tenantRef: string;
  readonly reservationId: string;
  /** An external authority such as a resource-migration cutover, if present. */
  readonly authorityRef?: string;
  readonly offeringId: string;
  readonly meter: string;
  readonly quantity: number;
  readonly amountMinor: number;
  readonly state: SettlementIntentState;
  /** The durable side of the value-only intent; cancellation never captures. */
  readonly direction: SettlementDirection;
  readonly cancellationPhase: CancellationPhase;
  /** Terminal reservation status requested by the cancellation owner. */
  readonly desiredTerminalStatus: SettlementTerminalStatus;
  /** Stable ledger reference and receipt for a cancellation release. */
  readonly cancellationReleaseReference?: string;
  readonly cancellationReceipt?: string;
  /** Ledger capture is idempotent; this bit records that its response was seen. */
  readonly ledgerCaptured: boolean;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SettlementAuthorityDecision = "pending" | "ready" | "cancelled";

/** Reads an authoritative non-billing operation before advancing an intent. */
export type SettlementAuthorityResolver = (
  intent: SettlementIntent,
) => Promise<SettlementAuthorityDecision>;

export type ResellerErrorCode =
  | "not_found"
  | "conflict"
  | "expired"
  | "insufficient_funds"
  | "invalid_argument"
  | "offering_unavailable"
  | "unavailable";

export class ResellerError extends Error {
  constructor(
    readonly code: ResellerErrorCode,
    readonly status: number,
  ) {
    super(code);
    this.name = "ResellerError";
  }
}

export const QUOTE_TTL_SECONDS = 15 * 60;
export const RESERVATION_TTL_SECONDS = 60 * 60;
export const SETTLEMENT_LEASE_MILLISECONDS = 30_000;

export interface Reseller {
  quote(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly offeringId: string;
    readonly quantity: number;
  }): Promise<Quote>;
  reserve(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly quoteId: string;
  }): Promise<Reservation>;
  capture(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
    /** `meter` may be omitted; the reservation already knows its meter. */
    readonly usage: { readonly meter?: string; readonly quantity: number };
    /** Internal operation key for a pre-created settlement intent. */
    readonly settlementKey?: string;
  }): Promise<UsageStatement>;
  /** Creates the value-only intent before an external cutover starts. */
  beginSettlement(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
    readonly offeringId: string;
    readonly usage: { readonly meter: string; readonly quantity: number };
    readonly idempotencyKey: string;
    readonly authorityRef?: string;
  }): Promise<SettlementIntent>;
  /** Marks an authoritative operation complete; capture may now proceed. */
  commitSettlement(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
    readonly idempotencyKey: string;
  }): Promise<SettlementIntent>;
  /** Cancels a pre-dispatch intent and compensates its reservation hold. */
  cancelSettlement(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
    readonly idempotencyKey: string;
  }): Promise<SettlementIntent>;
  settlement(input: {
    readonly organizationId: string;
    readonly idempotencyKey: string;
  }): Promise<SettlementIntent | null>;
  /** Drains ready/recovery intents, optionally resolving external authority. */
  reconcileDue(limit: number, resolveAuthority?: SettlementAuthorityResolver): Promise<number>;
  release(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
  }): Promise<Reservation>;
  statement(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
  }): Promise<UsageStatement>;
  reservation(input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
  }): Promise<Reservation>;
  /** Releases the holds of reservations that outlived their window. */
  expireDue(limit: number): Promise<number>;
}

export interface CreateResellerOptions {
  readonly sql: Sql;
  readonly ledger: Ledger;
  readonly catalog: Catalog;
  readonly clock: Clock;
  readonly randomId?: () => string;
  readonly settlementLeaseMilliseconds?: number;
}

export function createReseller(options: CreateResellerOptions): Reseller {
  const { sql, ledger, catalog, clock } = options;
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const settlementLeaseMilliseconds =
    options.settlementLeaseMilliseconds ?? SETTLEMENT_LEASE_MILLISECONDS;
  if (
    !Number.isSafeInteger(settlementLeaseMilliseconds) ||
    settlementLeaseMilliseconds < 1 ||
    settlementLeaseMilliseconds > 3_600_000
  ) {
    throw new TypeError("settlementLeaseMilliseconds must be an integer from 1 to 3600000");
  }
  const stamp = (): string => clock().toISOString();
  const now = (): number => clock().getTime();
  const after = (seconds: number): string =>
    new Date(clock().getTime() + seconds * 1_000).toISOString();

  const readReservation = async (
    organizationId: string,
    tenantRef: string,
    reservationId: string,
  ): Promise<Reservation & { readonly quantity: number }> => {
    const rows = await sql.query(
      `SELECT id, tenant_ref, quote_id, offering_id, offering_digest, quantity, amount_minor,
              meter, status, expires_at
       FROM reservations WHERE id = ? AND org_id = ? AND tenant_ref = ?`,
      [reservationId, organizationId, tenantRef],
    );
    const row = rows[0];
    if (!row) throw new ResellerError("not_found", 404);
    return {
      id: String(row.id),
      tenantRef: String(row.tenant_ref),
      quoteId: String(row.quote_id),
      offeringId: String(row.offering_id),
      offeringDigest: String(row.offering_digest) as `sha256:${string}`,
      amountMinor: Number(row.amount_minor),
      currency: "USD",
      status: String(row.status) as ReservationStatus,
      expiresAt: String(row.expires_at),
      meter: String(row.meter),
      quantity: Number(row.quantity),
    };
  };

  type SettlementExecution = {
    readonly intent: SettlementIntent;
    readonly leaseToken: string;
  };

  const readSettlementRow = async (
    organizationId: string,
    idempotencyKey: string,
  ): Promise<SettlementIntent | null> => {
    const rows = await sql.query(
      `SELECT idempotency_key, org_id, tenant_ref, reservation_id, authority_ref,
              offering_id, meter, quantity, amount_minor, state, ledger_captured,
              settlement_direction, cancellation_phase, cancellation_release_reference,
              cancellation_receipt, desired_terminal_status, last_error, created_at, updated_at
       FROM reseller_settlement_intents
       WHERE org_id = ? AND idempotency_key = ? LIMIT 2`,
      [organizationId, idempotencyKey],
    );
    if (rows.length > 1) throw new Error("reseller_settlement_ambiguous");
    return rows[0] ? settlementIntent(rows[0]) : null;
  };

  const readSettlementByReservation = async (
    organizationId: string,
    reservationId: string,
  ): Promise<SettlementIntent | null> => {
    const rows = await sql.query(
      `SELECT idempotency_key, org_id, tenant_ref, reservation_id, authority_ref,
              offering_id, meter, quantity, amount_minor, state, ledger_captured,
              settlement_direction, cancellation_phase, cancellation_release_reference,
              cancellation_receipt, desired_terminal_status, last_error, created_at, updated_at
       FROM reseller_settlement_intents
       WHERE org_id = ? AND reservation_id = ? LIMIT 2`,
      [organizationId, reservationId],
    );
    if (rows.length > 1) throw new Error("reseller_settlement_ambiguous");
    return rows[0] ? settlementIntent(rows[0]) : null;
  };

  /**
   * Creates the cancellation direction before touching the external ledger.
   * A direct release used to mark the reservation terminal first and then call
   * the ledger, which left an active hold permanently stranded when that call
   * failed.  The settlement intent is the durable release outbox; its stable
   * reservation reference makes a retry idempotent even after a lost response.
   */
  const ensureReleaseSettlement = async (
    organizationId: string,
    reservation: Reservation & { readonly quantity: number },
    desiredTerminalStatus: SettlementTerminalStatus = "released",
  ): Promise<SettlementIntent> => {
    const existing = await readSettlementByReservation(organizationId, reservation.id);
    if (existing) return existing;
    const idempotencyKey = `reservation:release:${reservation.id}`;
    const timestamp = now();
    try {
      await sql.run(
        `INSERT INTO reseller_settlement_intents
           (idempotency_key, org_id, tenant_ref, reservation_id, authority_ref,
            offering_id, meter, quantity, amount_minor, state, ledger_captured,
            settlement_direction, cancellation_phase, cancellation_release_reference,
            cancellation_receipt, desired_terminal_status, lease_token, lease_until,
            last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'pending', 0,
                 'cancel', 'release_pending', ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
        [
          idempotencyKey,
          organizationId,
          reservation.tenantRef,
          reservation.id,
          reservation.offeringId,
          reservation.meter,
          reservation.quantity,
          reservation.amountMinor,
          reservation.id,
          desiredTerminalStatus,
          timestamp,
          timestamp,
        ],
      );
    } catch {
      // A concurrent release/capture may have won the unique reservation race.
      // Read it back and let the normal direction/state guards decide whether
      // that operation can be cancelled or must remain authoritative.
      const raced = await readSettlementByReservation(organizationId, reservation.id);
      if (!raced) throw new ResellerError("unavailable", 503);
      return raced;
    }
    const created = await readSettlementRow(organizationId, idempotencyKey);
    if (!created) throw new Error("reseller_release_missing_after_create");
    return created;
  };

  const assertSettlementIdentity = (
    intent: SettlementIntent,
    input: {
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly reservationId: string;
      readonly offeringId: string;
      readonly meter: string;
      readonly quantity: number;
      readonly idempotencyKey: string;
      readonly authorityRef?: string;
    },
  ): void => {
    if (
      intent.organizationId !== input.organizationId ||
      intent.tenantRef !== input.tenantRef ||
      intent.reservationId !== input.reservationId ||
      intent.offeringId !== input.offeringId ||
      intent.meter !== input.meter ||
      intent.quantity !== input.quantity ||
      intent.idempotencyKey !== input.idempotencyKey ||
      (intent.authorityRef ?? undefined) !== (input.authorityRef ?? undefined)
    ) {
      throw new ResellerError("conflict", 409);
    }
  };

  const ensureSettlement = async (input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly reservationId: string;
    readonly offeringId: string;
    readonly meter: string;
    readonly quantity: number;
    readonly idempotencyKey: string;
    readonly authorityRef?: string;
    readonly initialState: "pending" | "ready" | "captured";
  }): Promise<SettlementIntent> => {
    validSettlementKey(input.idempotencyKey);
    const reservation = await readReservation(
      input.organizationId,
      input.tenantRef,
      input.reservationId,
    );
    if (reservation.offeringId !== input.offeringId || reservation.meter !== input.meter) {
      throw new ResellerError("conflict", 409);
    }
    if (reservation.status === "released" || reservation.status === "expired") {
      throw new ResellerError("conflict", 409);
    }
    if (!Number.isFinite(input.quantity) || input.quantity < 0) {
      throw new ResellerError("invalid_argument", 400);
    }

    const existing = await readSettlementByReservation(input.organizationId, input.reservationId);
    if (existing) {
      assertSettlementIdentity(existing, input);
      if (existing.state === "cancelled" && reservation.status === "active") {
        const reopened = await sql.run(
          `UPDATE reseller_settlement_intents
           SET state = ?, ledger_captured = 0, last_error = NULL,
               settlement_direction = 'capture', cancellation_phase = 'none',
               cancellation_release_reference = NULL, cancellation_receipt = NULL,
               desired_terminal_status = 'released',
               lease_token = NULL, lease_until = NULL, updated_at = ?
           WHERE org_id = ? AND idempotency_key = ? AND state = 'cancelled'`,
          [input.initialState, now(), input.organizationId, input.idempotencyKey],
        );
        if (reopened.changes === 1) {
          const restored = await readSettlementRow(input.organizationId, input.idempotencyKey);
          if (!restored) throw new Error("reseller_settlement_missing_after_reopen");
          return restored;
        }
      }
      return existing;
    }

    const byKey = await readSettlementRow(input.organizationId, input.idempotencyKey);
    if (byKey) {
      assertSettlementIdentity(byKey, input);
      return byKey;
    }

    try {
      await sql.run(
        `INSERT INTO reseller_settlement_intents
           (idempotency_key, org_id, tenant_ref, reservation_id, authority_ref,
            offering_id, meter, quantity, amount_minor, state, ledger_captured,
            lease_token, lease_until, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        [
          input.idempotencyKey,
          input.organizationId,
          input.tenantRef,
          input.reservationId,
          input.authorityRef ?? null,
          input.offeringId,
          input.meter,
          input.quantity,
          reservation.amountMinor,
          input.initialState,
          input.initialState === "captured" ? 1 : 0,
          now(),
          now(),
        ],
      );
    } catch {
      // A concurrent begin may have won the unique reservation/key race. Read
      // it back and compare every value before treating that as idempotence.
      const raced = await readSettlementByReservation(input.organizationId, input.reservationId);
      if (!raced) throw new ResellerError("unavailable", 503);
      assertSettlementIdentity(raced, input);
      return raced;
    }
    const created = await readSettlementRow(input.organizationId, input.idempotencyKey);
    if (!created) throw new Error("reseller_settlement_missing_after_create");
    return created;
  };

  const acquireSettlement = async (
    organizationId: string,
    idempotencyKey: string,
  ): Promise<SettlementExecution | null> => {
    const leaseToken = `set_${randomId()}`;
    const timestamp = now();
    const claimed = await sql.run(
      `UPDATE reseller_settlement_intents
       SET lease_token = ?, lease_until = ?, updated_at = ?
       WHERE org_id = ? AND idempotency_key = ?
         AND state IN ('pending', 'ready', 'recovery_required')
         AND (lease_until IS NULL OR lease_until <= ?)`,
      [
        leaseToken,
        timestamp + settlementLeaseMilliseconds,
        timestamp,
        organizationId,
        idempotencyKey,
        timestamp,
      ],
    );
    if (claimed.changes !== 1) return null;
    const intent = await readSettlementRow(organizationId, idempotencyKey);
    if (!intent) throw new Error("reseller_settlement_missing_after_lease");
    return { intent, leaseToken };
  };

  const releaseSettlement = async (
    organizationId: string,
    idempotencyKey: string,
    leaseToken: string,
  ): Promise<void> => {
    await sql.run(
      `UPDATE reseller_settlement_intents
       SET lease_token = NULL, lease_until = NULL, updated_at = ?
       WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?`,
      [now(), organizationId, idempotencyKey, leaseToken],
    );
  };

  const markSettlementRecovery = async (
    organizationId: string,
    idempotencyKey: string,
    leaseToken: string,
    error: unknown,
  ): Promise<void> => {
    await sql.run(
      `UPDATE reseller_settlement_intents
       SET state = 'recovery_required', last_error = ?, updated_at = ?
       WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
         AND state IN ('ready', 'recovery_required')
         AND settlement_direction = 'capture' AND cancellation_phase = 'none'`,
      [settlementError(error), now(), organizationId, idempotencyKey, leaseToken],
    );
  };

  const markCancellationRecovery = async (
    organizationId: string,
    idempotencyKey: string,
    leaseToken: string,
    error: unknown,
  ): Promise<void> => {
    await sql.run(
      `UPDATE reseller_settlement_intents
       SET state = 'recovery_required', last_error = ?, updated_at = ?
       WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
         AND state IN ('pending', 'recovery_required')
         AND settlement_direction = 'cancel' AND cancellation_phase = 'release_pending'`,
      [settlementError(error), now(), organizationId, idempotencyKey, leaseToken],
    );
  };

  const markLedgerCaptured = async (
    organizationId: string,
    idempotencyKey: string,
    leaseToken: string,
  ): Promise<void> => {
    const marked = await sql.run(
      `UPDATE reseller_settlement_intents
       SET ledger_captured = 1, last_error = NULL, updated_at = ?
       WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
         AND state IN ('ready', 'recovery_required')
         AND settlement_direction = 'capture' AND cancellation_phase = 'none'`,
      [now(), organizationId, idempotencyKey, leaseToken],
    );
    if (marked.changes !== 1) throw new ResellerError("conflict", 409);
  };

  const finalizeSettlement = async (execution: SettlementExecution): Promise<UsageStatement> => {
    const { intent, leaseToken } = execution;
    const reservation = await readReservation(
      intent.organizationId,
      intent.tenantRef,
      intent.reservationId,
    );
    if (reservation.amountMinor !== intent.amountMinor || reservation.status === "released") {
      throw new ResellerError("conflict", 409);
    }
    const statementRows = await sql.query(
      `SELECT reservation_id, tenant_ref, offering_id, meter, quantity, amount_minor, captured_at
       FROM usage_statements
       WHERE reservation_id = ? AND org_id = ? AND tenant_ref = ? LIMIT 2`,
      [intent.reservationId, intent.organizationId, intent.tenantRef],
    );
    if (statementRows.length > 1) throw new Error("usage_statement_ambiguous");
    const existing = statementRows[0];
    if (
      existing &&
      (String(existing.offering_id) !== intent.offeringId ||
        String(existing.meter) !== intent.meter ||
        Number(existing.quantity) !== intent.quantity ||
        Number(existing.amount_minor) !== intent.amountMinor)
    ) {
      throw new ResellerError("conflict", 409);
    }
    const capturedAt = stamp();
    const guardToken = `sg_${randomId()}`;
    await sql.batch([
      {
        sql: `INSERT OR IGNORE INTO usage_statements
                (reservation_id, org_id, tenant_ref, offering_id, meter, quantity, amount_minor, captured_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          intent.reservationId,
          intent.organizationId,
          intent.tenantRef,
          intent.offeringId,
          intent.meter,
          intent.quantity,
          intent.amountMinor,
          capturedAt,
        ],
      },
      {
        sql: `UPDATE reservations SET status = 'captured'
              WHERE id = ? AND org_id = ? AND tenant_ref = ? AND status = 'active'`,
        params: [intent.reservationId, intent.organizationId, intent.tenantRef],
      },
      {
        sql: `INSERT INTO reseller_settlement_guards (token, valid)
              VALUES (?, CASE WHEN
                EXISTS (
                  SELECT 1 FROM reseller_settlement_intents
                  WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
                    AND state IN ('ready', 'recovery_required')
                    AND settlement_direction = 'capture' AND cancellation_phase = 'none'
                    AND ledger_captured = 1
                )
                AND EXISTS (
                  SELECT 1 FROM reservations
                  WHERE id = ? AND org_id = ? AND tenant_ref = ? AND status = 'captured'
                )
                AND EXISTS (
                  SELECT 1 FROM usage_statements
                  WHERE reservation_id = ? AND org_id = ? AND tenant_ref = ?
                    AND offering_id = ? AND meter = ? AND quantity = ? AND amount_minor = ?
                ) THEN 1 ELSE 0 END)`,
        params: [
          guardToken,
          intent.organizationId,
          intent.idempotencyKey,
          leaseToken,
          intent.reservationId,
          intent.organizationId,
          intent.tenantRef,
          intent.reservationId,
          intent.organizationId,
          intent.tenantRef,
          intent.offeringId,
          intent.meter,
          intent.quantity,
          intent.amountMinor,
        ],
      },
      {
        sql: `UPDATE reseller_settlement_intents
              SET state = 'captured', lease_token = NULL, lease_until = NULL,
                  last_error = NULL, updated_at = ?
              WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
                AND state IN ('ready', 'recovery_required')
                AND settlement_direction = 'capture' AND cancellation_phase = 'none'
                AND ledger_captured = 1`,
        params: [now(), intent.organizationId, intent.idempotencyKey, leaseToken],
      },
      { sql: "DELETE FROM reseller_settlement_guards WHERE token = ?", params: [guardToken] },
    ]);
    return await readUsageStatement(intent.organizationId, intent.tenantRef, intent.reservationId);
  };

  const settleExecution = async (execution: SettlementExecution): Promise<UsageStatement> => {
    const { intent, leaseToken } = execution;
    if (intent.direction !== "capture" || intent.cancellationPhase !== "none") {
      throw new ResellerError("conflict", 409);
    }
    let leaseHeld = true;
    try {
      if (!intent.ledgerCaptured) {
        if (intent.amountMinor > 0) {
          await ledger.capture({
            organizationId: intent.organizationId,
            reference: intent.reservationId,
            amountMinor: intent.amountMinor,
          });
        }
        await markLedgerCaptured(intent.organizationId, intent.idempotencyKey, leaseToken);
      }
      const statement = await finalizeSettlement(execution);
      leaseHeld = false;
      return statement;
    } catch (error) {
      try {
        await markSettlementRecovery(
          intent.organizationId,
          intent.idempotencyKey,
          leaseToken,
          error,
        );
      } catch {
        // The durable intent remains at its prior state if storage itself is
        // unavailable; a later reconciler will retry the same key.
      }
      throw error;
    } finally {
      if (leaseHeld) {
        try {
          await releaseSettlement(intent.organizationId, intent.idempotencyKey, leaseToken);
        } catch {
          // An expired lease is recoverable; the next executor is fenced by its token.
        }
      }
    }
  };

  const prepareCancellation = async (
    execution: SettlementExecution,
    desiredTerminalStatus: SettlementTerminalStatus,
  ): Promise<SettlementExecution> => {
    const { intent, leaseToken } = execution;
    if (intent.direction === "cancel") return execution;
    if (
      intent.state !== "pending" ||
      intent.ledgerCaptured ||
      intent.cancellationPhase !== "none"
    ) {
      throw new ResellerError("conflict", 409);
    }
    const prepared = await sql.run(
      `UPDATE reseller_settlement_intents
       SET settlement_direction = 'cancel', cancellation_phase = 'release_pending',
           cancellation_release_reference = reservation_id, cancellation_receipt = NULL,
           desired_terminal_status = ?,
           last_error = NULL, updated_at = ?
       WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
         AND state = 'pending' AND ledger_captured = 0
         AND settlement_direction = 'capture' AND cancellation_phase = 'none'`,
      [desiredTerminalStatus, now(), intent.organizationId, intent.idempotencyKey, leaseToken],
    );
    if (prepared.changes !== 1) {
      const current = await readSettlementRow(intent.organizationId, intent.idempotencyKey);
      if (current?.direction !== "cancel" || current.cancellationPhase === "none") {
        throw new ResellerError("conflict", 409);
      }
      return { intent: current, leaseToken };
    }
    const current = await readSettlementRow(intent.organizationId, intent.idempotencyKey);
    if (!current) throw new Error("reseller_settlement_missing_after_cancel_prepare");
    return { intent: current, leaseToken };
  };

  const markCancellationReleaseSucceeded = async (
    execution: SettlementExecution,
  ): Promise<SettlementExecution> => {
    const { intent, leaseToken } = execution;
    const releaseReference = intent.cancellationReleaseReference ?? intent.reservationId;
    const marked = await sql.run(
      `UPDATE reseller_settlement_intents
       SET state = 'recovery_required', cancellation_phase = 'release_succeeded',
           cancellation_release_reference = ?, cancellation_receipt = ?,
           last_error = NULL, updated_at = ?
       WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
         AND state IN ('pending', 'recovery_required')
         AND settlement_direction = 'cancel' AND cancellation_phase = 'release_pending'`,
      [
        releaseReference,
        releaseReference,
        now(),
        intent.organizationId,
        intent.idempotencyKey,
        leaseToken,
      ],
    );
    if (marked.changes !== 1) {
      const current = await readSettlementRow(intent.organizationId, intent.idempotencyKey);
      if (
        current?.direction !== "cancel" ||
        current.cancellationPhase !== "release_succeeded" ||
        current.cancellationReceipt !== releaseReference
      ) {
        throw new ResellerError("conflict", 409);
      }
      return { intent: current, leaseToken };
    }
    const current = await readSettlementRow(intent.organizationId, intent.idempotencyKey);
    if (!current) throw new Error("reseller_settlement_missing_after_cancel_release");
    return { intent: current, leaseToken };
  };

  const finalizeCancellation = async (
    execution: SettlementExecution,
    terminalStatus: "released" | "expired" = "released",
  ): Promise<SettlementIntent> => {
    const { intent, leaseToken } = execution;
    const releaseReference = intent.cancellationReleaseReference ?? intent.reservationId;
    if (
      intent.direction !== "cancel" ||
      intent.cancellationPhase !== "release_succeeded" ||
      intent.cancellationReceipt !== releaseReference
    ) {
      throw new ResellerError("conflict", 409);
    }
    const guardToken = `sg_${randomId()}`;
    await sql.batch([
      {
        sql: `UPDATE reservations SET status = ?
              WHERE id = ? AND org_id = ? AND tenant_ref = ? AND status = 'active'
                AND NOT EXISTS (
                  SELECT 1 FROM provision_token_consumptions
                  WHERE reservation_id = ? AND organization_id = ? AND tenant_ref = ?
                )`,
        params: [
          terminalStatus,
          intent.reservationId,
          intent.organizationId,
          intent.tenantRef,
          intent.reservationId,
          intent.organizationId,
          intent.tenantRef,
        ],
      },
      {
        sql: `INSERT INTO reseller_settlement_guards (token, valid)
              VALUES (?, CASE WHEN
                EXISTS (
                  SELECT 1 FROM reseller_settlement_intents
                  WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
                    AND state = 'recovery_required'
                    AND settlement_direction = 'cancel'
                    AND cancellation_phase = 'release_succeeded'
                    AND cancellation_release_reference = ?
                    AND cancellation_receipt = ?
                )
                AND EXISTS (
                  SELECT 1 FROM reservations
                  WHERE id = ? AND org_id = ? AND tenant_ref = ?
                    AND status IN ('released', 'expired')
                ) THEN 1 ELSE 0 END)`,
        params: [
          guardToken,
          intent.organizationId,
          intent.idempotencyKey,
          leaseToken,
          releaseReference,
          releaseReference,
          intent.reservationId,
          intent.organizationId,
          intent.tenantRef,
        ],
      },
      {
        sql: `UPDATE reseller_settlement_intents
              SET state = 'cancelled', cancellation_phase = 'finalized',
                  lease_token = NULL, lease_until = NULL, last_error = NULL,
                  updated_at = ?
              WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
                AND state = 'recovery_required' AND settlement_direction = 'cancel'
                AND cancellation_phase = 'release_succeeded'
                AND cancellation_release_reference = ? AND cancellation_receipt = ?`,
        params: [
          now(),
          intent.organizationId,
          intent.idempotencyKey,
          leaseToken,
          releaseReference,
          releaseReference,
        ],
      },
      { sql: "DELETE FROM reseller_settlement_guards WHERE token = ?", params: [guardToken] },
    ]);
    const cancelled = await readSettlementRow(intent.organizationId, intent.idempotencyKey);
    if (!cancelled) throw new Error("reseller_settlement_missing_after_cancel_finalize");
    return cancelled;
  };

  const cancelExecution = async (
    execution: SettlementExecution,
    terminalStatus: SettlementTerminalStatus = "released",
  ): Promise<SettlementIntent> => {
    let current = await prepareCancellation(execution, terminalStatus);
    const { intent, leaseToken } = current;
    if (intent.state === "cancelled") return intent;
    if (
      intent.direction !== "cancel" ||
      !["pending", "recovery_required"].includes(intent.state) ||
      !["release_pending", "release_succeeded"].includes(intent.cancellationPhase)
    ) {
      throw new ResellerError("conflict", 409);
    }
    if (intent.cancellationPhase === "release_pending") {
      const reservation = await readReservation(
        intent.organizationId,
        intent.tenantRef,
        intent.reservationId,
      );
      if (reservation.status === "captured") throw new ResellerError("conflict", 409);
      const consumed = await sql.query(
        `SELECT 1 FROM provision_token_consumptions
         WHERE reservation_id = ? AND organization_id = ? AND tenant_ref = ? LIMIT 1`,
        [intent.reservationId, intent.organizationId, intent.tenantRef],
      );
      if (consumed[0]) throw new ResellerError("conflict", 409);
      const releaseReference = intent.cancellationReleaseReference ?? intent.reservationId;
      try {
        if (reservation.status === "active" && reservation.amountMinor > 0) {
          await ledger.release({
            organizationId: intent.organizationId,
            reference: releaseReference,
            amountMinor: reservation.amountMinor,
          });
        }
      } catch (error) {
        await markCancellationRecovery(
          intent.organizationId,
          intent.idempotencyKey,
          leaseToken,
          error,
        );
        throw error;
      }
      current = await markCancellationReleaseSucceeded(current);
    }
    if (current.intent.cancellationPhase !== "release_succeeded") {
      throw new ResellerError("conflict", 409);
    }
    return await finalizeCancellation(current, current.intent.desiredTerminalStatus);
  };

  const runCancellation = async (
    input: {
      readonly organizationId: string;
      readonly tenantRef: string;
      readonly reservationId: string;
      readonly idempotencyKey: string;
    },
    terminalStatus: "released" | "expired" = "released",
  ): Promise<SettlementIntent> => {
    const intent = await readSettlementRow(input.organizationId, input.idempotencyKey);
    if (
      !intent ||
      intent.tenantRef !== input.tenantRef ||
      intent.reservationId !== input.reservationId
    ) {
      throw new ResellerError("not_found", 404);
    }
    if (intent.state === "cancelled") return intent;
    if (
      (intent.direction === "capture" &&
        (intent.state !== "pending" ||
          intent.ledgerCaptured ||
          intent.cancellationPhase !== "none")) ||
      (intent.direction === "cancel" && !["pending", "recovery_required"].includes(intent.state))
    ) {
      throw new ResellerError("conflict", 409);
    }
    const execution = await acquireSettlement(input.organizationId, input.idempotencyKey);
    if (!execution) {
      const current = await readSettlementRow(input.organizationId, input.idempotencyKey);
      if (current?.state === "cancelled") return current;
      throw new ResellerError("unavailable", 503);
    }
    let leaseHeld = true;
    try {
      const cancelled = await cancelExecution(execution, terminalStatus);
      leaseHeld = false;
      return cancelled;
    } finally {
      if (leaseHeld) {
        try {
          await releaseSettlement(input.organizationId, input.idempotencyKey, execution.leaseToken);
        } catch {
          // The lease is fenced; a later cancellation reconciler can retry.
        }
      }
    }
  };

  const readUsageStatement = async (
    organizationId: string,
    tenantRef: string,
    reservationId: string,
  ): Promise<UsageStatement> => {
    const rows = await sql.query(
      `SELECT reservation_id, tenant_ref, offering_id, meter, quantity, amount_minor, captured_at
       FROM usage_statements WHERE reservation_id = ? AND org_id = ? AND tenant_ref = ? LIMIT 2`,
      [reservationId, organizationId, tenantRef],
    );
    if (rows.length > 1) throw new Error("usage_statement_ambiguous");
    const row = rows[0];
    if (!row) throw new ResellerError("not_found", 404);
    return {
      reservationId: String(row.reservation_id),
      tenantRef: String(row.tenant_ref),
      offeringId: String(row.offering_id),
      currency: "USD",
      amountMinor: Number(row.amount_minor),
      usage: { meter: String(row.meter), quantity: Number(row.quantity) },
      capturedAt: String(row.captured_at),
    };
  };

  const reseller: Reseller = {
    async quote({ organizationId, tenantRef, offeringId, quantity }) {
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000) {
        throw new ResellerError("invalid_argument", 400);
      }
      const offering = catalog.findOffering(offeringId);
      if (!offering) throw new ResellerError("offering_unavailable", 503);
      let amountMinor: number;
      try {
        amountMinor = priceProvisioning(offering.pricePlan, quantity);
      } catch {
        throw new ResellerError("invalid_argument", 400);
      }

      const id = `qte_${randomId()}`;
      const expiresAt = after(QUOTE_TTL_SECONDS);
      await sql.run(
        `INSERT INTO quotes (id, org_id, tenant_ref, offering_id, offering_digest, quantity,
                             amount_minor, meter, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          organizationId,
          tenantRef,
          offering.id,
          await catalog.digest(offering),
          quantity,
          amountMinor,
          offering.pricePlan.provisioning.meter,
          expiresAt,
          stamp(),
        ],
      );
      return {
        id,
        tenantRef,
        offeringId: offering.id,
        quantity,
        currency: "USD",
        amountMinor,
        meter: offering.pricePlan.provisioning.meter,
        expiresAt,
      };
    },

    async reserve({ organizationId, tenantRef, quoteId }) {
      const rows = await sql.query(
        `SELECT id, offering_id, offering_digest, quantity, amount_minor, meter, expires_at
         FROM quotes WHERE id = ? AND org_id = ? AND tenant_ref = ?`,
        [quoteId, organizationId, tenantRef],
      );
      const quote = rows[0];
      if (!quote) throw new ResellerError("not_found", 404);
      if (String(quote.expires_at) <= stamp()) throw new ResellerError("expired", 409);

      // A quote may back exactly one reservation; the unique index decides.
      const existing = await sql.query("SELECT id FROM reservations WHERE quote_id = ?", [quoteId]);
      if (existing[0]) {
        return await reseller.reservation({
          organizationId,
          tenantRef,
          reservationId: String(existing[0].id),
        });
      }

      const id = `rsv_${randomId()}`;
      const amountMinor = Number(quote.amount_minor);
      // The hold is taken before the reservation exists, so a reservation is
      // never visible without the funds behind it.
      const held =
        amountMinor === 0 || (await ledger.hold({ organizationId, reference: id, amountMinor }));
      if (!held) throw new ResellerError("insufficient_funds", 402);

      const expiresAt = after(RESERVATION_TTL_SECONDS);
      try {
        await sql.run(
          `INSERT INTO reservations (id, org_id, tenant_ref, quote_id, offering_id, offering_digest,
                                     quantity, amount_minor, meter, status, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [
            id,
            organizationId,
            tenantRef,
            quoteId,
            String(quote.offering_id),
            String(quote.offering_digest),
            Number(quote.quantity),
            amountMinor,
            String(quote.meter),
            expiresAt,
            stamp(),
          ],
        );
      } catch (error) {
        // The row could not be written, so the money must not stay earmarked.
        if (amountMinor > 0) {
          await ledger.release({ organizationId, reference: id, amountMinor });
        }
        throw error;
      }
      return {
        id,
        tenantRef,
        quoteId,
        offeringId: String(quote.offering_id),
        offeringDigest: String(quote.offering_digest) as `sha256:${string}`,
        quantity: Number(quote.quantity),
        amountMinor,
        currency: "USD",
        meter: String(quote.meter),
        status: "active",
        expiresAt,
      };
    },

    async beginSettlement({
      organizationId,
      tenantRef,
      reservationId,
      offeringId,
      usage,
      idempotencyKey,
      authorityRef,
    }) {
      if (!Number.isFinite(usage.quantity) || usage.quantity < 0) {
        throw new ResellerError("invalid_argument", 400);
      }
      const reservation = await readReservation(organizationId, tenantRef, reservationId);
      if (reservation.offeringId !== offeringId || reservation.meter !== usage.meter) {
        throw new ResellerError("conflict", 409);
      }
      const statementRows = await sql.query(
        `SELECT offering_id, meter, quantity, amount_minor
         FROM usage_statements WHERE reservation_id = ? AND org_id = ? AND tenant_ref = ? LIMIT 2`,
        [reservationId, organizationId, tenantRef],
      );
      if (
        reservation.status === "captured" &&
        (!statementRows[0] ||
          String(statementRows[0].offering_id) !== offeringId ||
          String(statementRows[0].meter) !== usage.meter ||
          Number(statementRows[0].quantity) !== usage.quantity ||
          Number(statementRows[0].amount_minor) !== reservation.amountMinor)
      ) {
        throw new ResellerError("conflict", 409);
      }
      const initialState =
        reservation.status === "captured" && statementRows.length === 1
          ? "captured"
          : authorityRef
            ? "pending"
            : "ready";
      return await ensureSettlement({
        organizationId,
        tenantRef,
        reservationId,
        offeringId,
        meter: usage.meter,
        quantity: usage.quantity,
        idempotencyKey,
        ...(authorityRef === undefined ? {} : { authorityRef }),
        initialState,
      });
    },

    async commitSettlement({ organizationId, tenantRef, reservationId, idempotencyKey }) {
      const intent = await readSettlementRow(organizationId, idempotencyKey);
      if (!intent || intent.tenantRef !== tenantRef || intent.reservationId !== reservationId) {
        throw new ResellerError("not_found", 404);
      }
      if (intent.direction !== "capture" || intent.cancellationPhase !== "none") {
        throw new ResellerError("conflict", 409);
      }
      if (
        intent.state === "captured" ||
        intent.state === "ready" ||
        intent.state === "recovery_required"
      ) {
        return intent;
      }
      if (intent.state === "cancelled") throw new ResellerError("conflict", 409);
      const changed = await sql.run(
        `UPDATE reseller_settlement_intents
         SET state = 'ready', updated_at = ?
         WHERE org_id = ? AND idempotency_key = ? AND reservation_id = ? AND tenant_ref = ?
           AND state = 'pending' AND ledger_captured = 0
           AND settlement_direction = 'capture' AND cancellation_phase = 'none'
           AND (lease_token IS NULL OR lease_until <= ?)`,
        [now(), organizationId, idempotencyKey, reservationId, tenantRef, now()],
      );
      if (changed.changes !== 1) {
        const current = await readSettlementRow(organizationId, idempotencyKey);
        if (
          current &&
          current.tenantRef === tenantRef &&
          current.reservationId === reservationId &&
          current.direction === "capture" &&
          current.cancellationPhase === "none" &&
          (current.state === "ready" ||
            current.state === "captured" ||
            current.state === "recovery_required")
        ) {
          return current;
        }
        throw new ResellerError("conflict", 409);
      }
      const committed = await readSettlementRow(organizationId, idempotencyKey);
      if (!committed) throw new Error("reseller_settlement_missing_after_commit");
      return committed;
    },

    async cancelSettlement({ organizationId, tenantRef, reservationId, idempotencyKey }) {
      return await runCancellation({ organizationId, tenantRef, reservationId, idempotencyKey });
    },

    async settlement({ organizationId, idempotencyKey }) {
      return await readSettlementRow(organizationId, idempotencyKey);
    },

    async reconcileDue(limit, resolveAuthority) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new ResellerError("invalid_argument", 400);
      }
      const due = await sql.query(
        `SELECT org_id, idempotency_key FROM reseller_settlement_intents
         WHERE state IN ('pending', 'ready', 'recovery_required')
           AND (lease_until IS NULL OR lease_until <= ?)
         ORDER BY updated_at, idempotency_key LIMIT ?`,
        [now(), limit],
      );
      let settled = 0;
      for (const row of due) {
        const organizationId = String(row.org_id);
        const key = String(row.idempotency_key);
        const execution = await acquireSettlement(organizationId, key);
        if (!execution) continue;
        let leaseHeld = true;
        try {
          let intent = execution.intent;
          if (intent.direction === "cancel") {
            await cancelExecution(execution);
            settled += 1;
            leaseHeld = false;
            continue;
          }
          if (intent.state === "pending") {
            const decision = resolveAuthority ? await resolveAuthority(intent) : "pending";
            if (decision === "pending") continue;
            if (decision === "cancelled") {
              await cancelExecution(execution);
              settled += 1;
              leaseHeld = false;
              continue;
            }
            const committed = await sql.run(
              `UPDATE reseller_settlement_intents
               SET state = 'ready', updated_at = ?
               WHERE org_id = ? AND idempotency_key = ? AND lease_token = ?
                 AND state = 'pending' AND ledger_captured = 0`,
              [now(), organizationId, key, execution.leaseToken],
            );
            if (committed.changes !== 1) continue;
            const refreshed = await readSettlementRow(organizationId, key);
            if (!refreshed) throw new Error("reseller_settlement_missing_after_reconcile_commit");
            intent = refreshed;
          }
          await settleExecution({ intent, leaseToken: execution.leaseToken });
          settled += 1;
          leaseHeld = false;
        } catch {
          // The intent records recovery_required where possible; keep draining
          // unrelated rows and let a later pass retry this stable key.
        } finally {
          if (leaseHeld) {
            try {
              await releaseSettlement(organizationId, key, execution.leaseToken);
            } catch {
              // A stale lease cannot commit a later executor's outcome.
            }
          }
        }
      }
      return settled;
    },

    async capture({ organizationId, tenantRef, reservationId, usage, settlementKey }) {
      if (!Number.isFinite(usage.quantity) || usage.quantity < 0) {
        throw new ResellerError("invalid_argument", 400);
      }
      const reservation = await readReservation(organizationId, tenantRef, reservationId);
      if (reservation.status === "captured") {
        return await readUsageStatement(organizationId, tenantRef, reservationId);
      }
      if (reservation.status !== "active") throw new ResellerError("conflict", 409);
      if (reservation.expiresAt <= stamp()) {
        const consumed = await sql.query(
          `SELECT 1 FROM provision_token_consumptions
           WHERE reservation_id = ? AND organization_id = ? AND tenant_ref = ? LIMIT 1`,
          [reservationId, organizationId, tenantRef],
        );
        // An ordinary expired reservation releases its hold. A redeemed
        // provision token may already have created the paid resource, so its
        // hold remains capturable until an operator reconciles the outcome.
        if (!consumed[0]) throw new ResellerError("expired", 409);
      }
      const meter = usage.meter ?? reservation.meter;
      if (meter !== reservation.meter) throw new ResellerError("invalid_argument", 400);

      const idempotencyKey = settlementKey ?? `reservation:${reservationId}`;
      const existingSettlement = await readSettlementRow(organizationId, idempotencyKey);
      const intent = await ensureSettlement({
        organizationId,
        tenantRef,
        reservationId,
        offeringId: reservation.offeringId,
        meter,
        quantity: usage.quantity,
        idempotencyKey,
        ...(existingSettlement?.authorityRef === undefined
          ? {}
          : { authorityRef: existingSettlement.authorityRef }),
        initialState: "ready",
      });
      if (intent.state === "captured") {
        return await readUsageStatement(organizationId, tenantRef, reservationId);
      }
      if (intent.state === "cancelled" || intent.state === "pending") {
        throw new ResellerError("conflict", 409);
      }
      const execution = await acquireSettlement(organizationId, idempotencyKey);
      if (!execution) {
        const current = await readSettlementRow(organizationId, idempotencyKey);
        if (current?.state === "captured") {
          return await readUsageStatement(organizationId, tenantRef, reservationId);
        }
        throw new ResellerError("unavailable", 503);
      }
      return await settleExecution(execution);
    },

    async release({ organizationId, tenantRef, reservationId }) {
      const reservation = await readReservation(organizationId, tenantRef, reservationId);
      if (reservation.status === "released") return reservation;
      if (reservation.status !== "active") throw new ResellerError("conflict", 409);
      const consumed = await sql.query(
        `SELECT 1 FROM provision_token_consumptions
         WHERE reservation_id = ? AND organization_id = ? AND tenant_ref = ? LIMIT 1`,
        [reservationId, organizationId, tenantRef],
      );
      if (consumed[0]) throw new ResellerError("conflict", 409);

      const intent = await readSettlementByReservation(organizationId, reservationId);
      if (intent && intent.state !== "cancelled") {
        if (
          intent.direction === "cancel" ||
          (intent.direction === "capture" && intent.state === "pending")
        ) {
          await runCancellation({
            organizationId,
            tenantRef,
            reservationId,
            idempotencyKey: intent.idempotencyKey,
          });
          return await readReservation(organizationId, tenantRef, reservationId);
        }
        throw new ResellerError("conflict", 409);
      }
      const releaseIntent = await ensureReleaseSettlement(organizationId, reservation);
      if (releaseIntent.state === "cancelled") {
        throw new ResellerError("conflict", 409);
      }
      await runCancellation({
        organizationId,
        tenantRef,
        reservationId,
        idempotencyKey: releaseIntent.idempotencyKey,
      });
      return await readReservation(organizationId, tenantRef, reservationId);
    },

    async statement({ organizationId, tenantRef, reservationId }) {
      return await readUsageStatement(organizationId, tenantRef, reservationId);
    },

    async reservation({ organizationId, tenantRef, reservationId }) {
      return await readReservation(organizationId, tenantRef, reservationId);
    },

    async expireDue(limit) {
      const due = await sql.query(
        `SELECT id, org_id, tenant_ref, amount_minor FROM reservations
         WHERE status = 'active' AND expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM reseller_settlement_intents
             WHERE reseller_settlement_intents.org_id = reservations.org_id
               AND reseller_settlement_intents.reservation_id = reservations.id
               AND reseller_settlement_intents.settlement_direction = 'capture'
               AND reseller_settlement_intents.state IN ('pending', 'ready', 'recovery_required')
           )
           AND NOT EXISTS (
             SELECT 1 FROM provision_token_consumptions
             WHERE provision_token_consumptions.reservation_id = reservations.id
               AND provision_token_consumptions.organization_id = reservations.org_id
               AND provision_token_consumptions.tenant_ref = reservations.tenant_ref
           )
         ORDER BY expires_at LIMIT ?`,
        [stamp(), limit],
      );
      let expired = 0;
      for (const row of due) {
        const id = String(row.id);
        const organizationId = String(row.org_id);
        const tenantRef = String(row.tenant_ref);
        let reservation: (Reservation & { readonly quantity: number }) | null = null;
        try {
          reservation = await readReservation(organizationId, tenantRef, id);
        } catch (error) {
          if (error instanceof ResellerError && error.code === "not_found") continue;
          throw error;
        }
        if (reservation?.status !== "active") continue;
        try {
          const intent = await ensureReleaseSettlement(organizationId, reservation, "expired");
          if (intent.state === "cancelled") continue;
          await runCancellation(
            {
              organizationId,
              tenantRef,
              reservationId: id,
              idempotencyKey: intent.idempotencyKey,
            },
            "expired",
          );
          expired += 1;
        } catch {
          // The intent remains pending/recovery_required and the reservation
          // stays active until the ledger release is durably evidenced.
        }
      }
      return expired;
    },
  };

  return reseller;
}

function settlementIntent(row: Row): SettlementIntent {
  const idempotencyKey = text(row.idempotency_key);
  const organizationId = text(row.org_id);
  const tenantRef = text(row.tenant_ref);
  const reservationId = text(row.reservation_id);
  const authorityRef = optionalText(row.authority_ref);
  const offeringId = text(row.offering_id);
  const meter = text(row.meter);
  const quantity = finiteNumber(row.quantity);
  const amountMinor = integer(row.amount_minor);
  const state = settlementState(row.state);
  const direction = settlementDirection(row.settlement_direction ?? "capture");
  const cancellationPhase = cancellationPhaseValue(row.cancellation_phase ?? "none");
  const desiredTerminalStatus = settlementTerminalStatus(row.desired_terminal_status ?? "released");
  const cancellationReleaseReference = optionalText(row.cancellation_release_reference);
  const cancellationReceipt = optionalText(row.cancellation_receipt);
  const ledgerCaptured = row.ledger_captured === 1;
  const lastError = optionalText(row.last_error);
  const createdAt = new Date(integer(row.created_at)).toISOString();
  const updatedAt = new Date(integer(row.updated_at)).toISOString();
  return {
    idempotencyKey,
    organizationId,
    tenantRef,
    reservationId,
    ...(authorityRef === undefined ? {} : { authorityRef }),
    offeringId,
    meter,
    quantity,
    amountMinor,
    state,
    direction,
    cancellationPhase,
    desiredTerminalStatus,
    ...(cancellationReleaseReference === undefined ? {} : { cancellationReleaseReference }),
    ...(cancellationReceipt === undefined ? {} : { cancellationReceipt }),
    ledgerCaptured,
    ...(lastError === undefined ? {} : { lastError }),
    createdAt,
    updatedAt,
  };
}

function settlementState(value: unknown): SettlementIntentState {
  if (
    value !== "pending" &&
    value !== "ready" &&
    value !== "captured" &&
    value !== "recovery_required" &&
    value !== "cancelled"
  ) {
    throw new Error("reseller_settlement_state_invalid");
  }
  return value;
}

function settlementDirection(value: unknown): SettlementDirection {
  if (value !== "capture" && value !== "cancel") {
    throw new Error("reseller_settlement_direction_invalid");
  }
  return value;
}

function cancellationPhaseValue(value: unknown): CancellationPhase {
  if (
    value !== "none" &&
    value !== "release_pending" &&
    value !== "release_succeeded" &&
    value !== "finalized"
  ) {
    throw new Error("reseller_settlement_cancellation_phase_invalid");
  }
  return value;
}

function settlementTerminalStatus(value: unknown): SettlementTerminalStatus {
  if (value !== "released" && value !== "expired") {
    throw new Error("reseller_settlement_terminal_status_invalid");
  }
  return value;
}

function validSettlementKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{2,1023}$/u.test(value)) {
    throw new ResellerError("invalid_argument", 400);
  }
}

function settlementError(error: unknown): string {
  if (error instanceof ResellerError) return error.code;
  if (error instanceof LedgerError) return error.code;
  return "unavailable";
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("reseller_row_invalid");
  return value;
}

function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return text(value);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("reseller_row_invalid");
  }
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("reseller_row_invalid");
  }
  return value;
}
