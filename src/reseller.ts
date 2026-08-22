import { type Catalog, priceProvisioning } from "./catalog.ts";
import type { Ledger } from "./ledger.ts";
import type { Clock, Sql } from "./ports.ts";

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

export type ResellerErrorCode =
  | "not_found"
  | "conflict"
  | "expired"
  | "insufficient_funds"
  | "invalid_argument"
  | "offering_unavailable";

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
  }): Promise<UsageStatement>;
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
}

export function createReseller(options: CreateResellerOptions): Reseller {
  const { sql, ledger, catalog, clock } = options;
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const stamp = (): string => clock().toISOString();
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

    async capture({ organizationId, tenantRef, reservationId, usage }) {
      if (!Number.isFinite(usage.quantity) || usage.quantity < 0) {
        throw new ResellerError("invalid_argument", 400);
      }
      const reservation = await readReservation(organizationId, tenantRef, reservationId);
      if (reservation.status === "captured") {
        return await reseller.statement({ organizationId, tenantRef, reservationId });
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

      const claimed = await sql.run(
        "UPDATE reservations SET status = 'captured' WHERE id = ? AND status = 'active'",
        [reservationId],
      );
      if (claimed.changes !== 1) throw new ResellerError("conflict", 409);

      if (reservation.amountMinor > 0) {
        await ledger.capture({
          organizationId,
          reference: reservationId,
          amountMinor: reservation.amountMinor,
        });
      }
      const capturedAt = stamp();
      await sql.run(
        `INSERT OR IGNORE INTO usage_statements
           (reservation_id, org_id, tenant_ref, offering_id, meter, quantity, amount_minor, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reservationId,
          organizationId,
          tenantRef,
          reservation.offeringId,
          meter,
          usage.quantity,
          reservation.amountMinor,
          capturedAt,
        ],
      );
      return await reseller.statement({ organizationId, tenantRef, reservationId });
    },

    async release({ organizationId, tenantRef, reservationId }) {
      const reservation = await readReservation(organizationId, tenantRef, reservationId);
      if (reservation.status === "released") return reservation;
      if (reservation.status !== "active") throw new ResellerError("conflict", 409);

      const claimed = await sql.run(
        `UPDATE reservations SET status = 'released'
         WHERE id = ? AND org_id = ? AND tenant_ref = ? AND status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM provision_token_consumptions
             WHERE reservation_id = ? AND organization_id = ? AND tenant_ref = ?
           )`,
        [reservationId, organizationId, tenantRef, reservationId, organizationId, tenantRef],
      );
      if (claimed.changes !== 1) throw new ResellerError("conflict", 409);
      if (reservation.amountMinor > 0) {
        await ledger.release({
          organizationId,
          reference: reservationId,
          amountMinor: reservation.amountMinor,
        });
      }
      return { ...reservation, status: "released" };
    },

    async statement({ organizationId, tenantRef, reservationId }) {
      const rows = await sql.query(
        `SELECT reservation_id, tenant_ref, offering_id, meter, quantity, amount_minor, captured_at
         FROM usage_statements WHERE reservation_id = ? AND org_id = ? AND tenant_ref = ?`,
        [reservationId, organizationId, tenantRef],
      );
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
    },

    async reservation({ organizationId, tenantRef, reservationId }) {
      return await readReservation(organizationId, tenantRef, reservationId);
    },

    async expireDue(limit) {
      const due = await sql.query(
        `SELECT id, org_id, amount_minor FROM reservations
         WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at LIMIT ?`,
        [stamp(), limit],
      );
      let expired = 0;
      for (const row of due) {
        const id = String(row.id);
        const claimed = await sql.run(
          `UPDATE reservations SET status = 'expired'
           WHERE id = ? AND status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM provision_token_consumptions
               WHERE reservation_id = ? AND organization_id = reservations.org_id
                 AND tenant_ref = reservations.tenant_ref
             )`,
          [id, id],
        );
        if (claimed.changes !== 1) continue;
        await ledger.release({
          organizationId: String(row.org_id),
          reference: id,
          amountMinor: Number(row.amount_minor),
        });
        expired += 1;
      }
      return expired;
    },
  };

  return reseller;
}
