import { beforeEach, describe, expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger, type Ledger } from "../src/ledger.ts";
import type { Sql } from "../src/ports.ts";
import { createReseller, type Reseller } from "../src/reseller.ts";

const OFFERING: Offering = {
  id: "storage.object.standard",
  providerId: "cloudflare",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: {
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "ObjectBucket",
    definitionVersion: "0.1.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  price: { currency: "USD", unit: "bucket-month", unitPriceMinor: 500 },
  protocols: ["s3"],
  available: true,
};

let sql: Sql;
let ledger: Ledger;
let reseller: Reseller;
let now: number;

beforeEach(() => {
  sql = createEphemeralSql();
  now = Date.UTC(2026, 7, 17, 12, 0, 0);
  const clock = () => new Date(now);
  ledger = createLedger(sql, clock);
  reseller = createReseller({ sql, ledger, catalog: createCatalog([OFFERING]), clock });
});

async function funded(amountMinor: number): Promise<void> {
  await ledger.fund({ organizationId: "org_a", fundingRef: "pay_1", amountMinor });
}

async function activeReservation() {
  const quote = await reseller.quote({
    organizationId: "org_a",
    tenantRef: "tenant_x",
    offeringId: OFFERING.id,
    quantity: 2,
  });
  const reservation = await reseller.reserve({
    organizationId: "org_a",
    tenantRef: "tenant_x",
    quoteId: quote.id,
  });
  return { quote, reservation };
}

describe("reseller lane", () => {
  test("prices a quote from the catalog and holds exactly that much", async () => {
    await funded(10_000);
    const { quote, reservation } = await activeReservation();
    expect(quote.amountMinor).toBe(1_000);
    expect(reservation).toMatchObject({ status: "active", amountMinor: 1_000 });
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMinor: 1_000, availableMinor: 9_000 });
  });

  test("captures once, and a repeat returns the same statement", async () => {
    await funded(10_000);
    const { reservation } = await activeReservation();
    const usage = { meter: "bucket-month", quantity: 2 };

    const statement = await reseller.capture({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      reservationId: reservation.id,
      usage,
    });
    expect(statement).toMatchObject({ amountMinor: 1_000, usage });
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMinor: 9_000, heldMinor: 0 });

    const again = await reseller.capture({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      reservationId: reservation.id,
      usage,
    });
    // The money must not move a second time.
    expect(again).toEqual(statement);
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMinor: 9_000, heldMinor: 0 });
  });

  test("releases a hold back to the balance, once", async () => {
    await funded(10_000);
    const { reservation } = await activeReservation();

    const released = await reseller.release({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      reservationId: reservation.id,
    });
    expect(released.status).toBe("released");
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMinor: 10_000, heldMinor: 0 });

    await reseller.release({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      reservationId: reservation.id,
    });
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMinor: 10_000, heldMinor: 0 });
  });

  test("refuses to capture a reservation that was already released", async () => {
    await funded(10_000);
    const { reservation } = await activeReservation();
    await reseller.release({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      reservationId: reservation.id,
    });
    await expect(
      reseller.capture({
        organizationId: "org_a",
        tenantRef: "tenant_x",
        reservationId: reservation.id,
        usage: { meter: "bucket-month", quantity: 1 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("refuses a reservation the balance cannot cover, before writing one", async () => {
    await funded(500);
    const quote = await reseller.quote({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      offeringId: OFFERING.id,
      quantity: 2,
    });
    await expect(
      reseller.reserve({ organizationId: "org_a", tenantRef: "tenant_x", quoteId: quote.id }),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMinor: 0, availableMinor: 500 });
    expect(await sql.query("SELECT COUNT(*) AS total FROM reservations")).toEqual([{ total: 0 }]);
  });

  test("hides another tenant's reservation entirely", async () => {
    await funded(10_000);
    const { reservation } = await activeReservation();
    await expect(
      reseller.reservation({
        organizationId: "org_a",
        tenantRef: "tenant_other",
        reservationId: reservation.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      reseller.reservation({
        organizationId: "org_b",
        tenantRef: "tenant_x",
        reservationId: reservation.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("returns the hold when a reservation outlives its window", async () => {
    await funded(10_000);
    const { reservation } = await activeReservation();

    now += 61 * 60_000;
    expect(await reseller.expireDue(16)).toBe(1);
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMinor: 10_000, heldMinor: 0 });
    // Expiry is terminal, so a late capture cannot resurrect the reservation.
    await expect(
      reseller.capture({
        organizationId: "org_a",
        tenantRef: "tenant_x",
        reservationId: reservation.id,
        usage: { meter: "bucket-month", quantity: 1 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await reseller.expireDue(16)).toBe(0);
  });

  test("redeems one quote exactly once", async () => {
    await funded(10_000);
    const quote = await reseller.quote({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      offeringId: OFFERING.id,
      quantity: 1,
    });
    const first = await reseller.reserve({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      quoteId: quote.id,
    });
    const second = await reseller.reserve({
      organizationId: "org_a",
      tenantRef: "tenant_x",
      quoteId: quote.id,
    });
    expect(second.id).toBe(first.id);
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMinor: 500 });
  });
});
