import { describe, expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import {
  createOrgBilling,
  type HoldInput,
  OrgBillingError,
  type UsageInput,
} from "../src/org-billing.ts";
import {
  SHARED_WORKSPACE_REF,
  workspaceBindingCreatable,
  workspaceBindingStatements,
} from "../src/org-workspace-usage.ts";
import type { Sql } from "../src/ports.ts";
import { workspaceBillingOrganizationRef } from "../src/workspace-billing-organization.ts";

const AUTHORITY = "takoserver-staging-billing";
const SHARED_REF = `wrk_${"0123456789abcdef".repeat(2)}`;
const OTHER_SHARED_REF = `wrk_${"fedcba9876543210".repeat(2)}`;
const PERSONAL_ORG = "org_personal_squatter";

function fixture(sharedWorkspaceAuthority?: string, store?: (sql: Sql) => Sql) {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-10-15T00:00:00.000Z");
  const tariff = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "reservation-r1",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86_400,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: { requests: { unit: "request", rate: { numeratorMicros: "1", denominator: "1" } } },
    }),
  );
  if (!tariff) throw new Error("fixture config missing");
  const ledger = createLedger(sql, clock, { hostedPaidFreeExclusion: true });
  const billing = createOrgBilling({
    sql: store ? store(sql) : sql,
    clock,
    ledger,
    config: tariff,
    hostedPaidFreeExclusion: true,
    requireWorkspaceAttribution: sharedWorkspaceAuthority !== undefined,
    ...(sharedWorkspaceAuthority === undefined ? {} : { sharedWorkspaceAuthority }),
  });
  return {
    sql,
    billing,
    hold(organizationId: string, reference: string, workspaceRef: string): HoldInput {
      return {
        organizationId,
        reference,
        amountMicros: 0,
        pricingRevision: tariff.revision,
        measurementFingerprint: "estimate",
        workspaceRef,
      };
    },
    usage(organizationId: string, reference: string, workspaceRef: string): UsageInput {
      return {
        organizationId,
        reference,
        meter: "requests",
        quantity: "0",
        quantityUnit: "request",
        periodStart: "2026-10-14T00:00:00.000Z",
        periodEnd: "2026-10-14T01:00:00.000Z",
        pricingRevision: tariff.revision,
        expectedMicros: 0,
        measurementFingerprint: "closed",
        workspaceRef,
      };
    },
    async rows() {
      return {
        bindings: await sql.query(
          "SELECT workspace_ref, org_id FROM org_wallet_workspace_bindings ORDER BY workspace_ref",
        ),
        holds: await sql.query("SELECT org_id, ref FROM org_wallet_holds ORDER BY ref"),
        usage: await sql.query("SELECT org_id, ref FROM org_wallet_usage_records ORDER BY ref"),
        // The monthly free grant an admission attempt materializes is not a hold write.
        ledger: await sql.query(
          "SELECT org_id, ref FROM ledger WHERE type <> 'grant' AND ref NOT LIKE 'free:%' ORDER BY ref",
        ),
      };
    },
  };
}

async function refused(operation: Promise<unknown>, code: string) {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(OrgBillingError);
    expect(error).toMatchObject({ code, status: 409 });
    return;
  }
  throw new Error("expected refusal");
}

describe("shared-auth Workspace reference reservation", () => {
  test("the reserved namespace is exactly wrk_ plus 32 lowercase hex", () => {
    expect(SHARED_WORKSPACE_REF.test(SHARED_REF)).toBe(true);
    for (const ref of [
      `wrk_${"0".repeat(31)}`,
      `wrk_${"0".repeat(33)}`,
      `wrk_${"A".repeat(32)}`,
      `WRK_${"0".repeat(32)}`,
      `xwrk_${"0".repeat(32)}`,
      "workspace_route",
      "ws_random_a",
    ])
      expect(SHARED_WORKSPACE_REF.test(ref)).toBe(false);
  });

  test("a non-derived Org cannot create a wrk_ binding by hold or usage, and writes no row", async () => {
    const f = fixture(AUTHORITY);
    const empty = await f.rows();
    await refused(
      f.billing.hold(f.hold(PERSONAL_ORG, "squat_hold", SHARED_REF)),
      "workspace_ref_reserved",
    );
    await refused(
      f.billing.usage(f.usage(PERSONAL_ORG, "squat_usage", SHARED_REF)),
      "workspace_ref_reserved",
    );
    // Another shared-auth Workspace's derived Org is not this Workspace's Org either.
    const neighbour = await workspaceBillingOrganizationRef(AUTHORITY, OTHER_SHARED_REF);
    await refused(
      f.billing.hold(f.hold(neighbour, "neighbour_hold", SHARED_REF)),
      "workspace_ref_reserved",
    );
    expect(await f.rows()).toEqual(empty);
    expect(empty.bindings).toEqual([]);
  });

  test("the derived Org binds normally, and the binding then excludes every other Org", async () => {
    const f = fixture(AUTHORITY);
    const derived = await workspaceBillingOrganizationRef(AUTHORITY, SHARED_REF);
    const receipt = await f.billing.hold(f.hold(derived, "owner_hold", SHARED_REF));
    expect(receipt.workspaceRef).toBe(SHARED_REF);
    await f.billing.usage(f.usage(derived, "owner_usage", SHARED_REF));
    expect((await f.rows()).bindings).toEqual([{ workspace_ref: SHARED_REF, org_id: derived }]);
    await refused(
      f.billing.hold(f.hold(PERSONAL_ORG, "late_squat", SHARED_REF)),
      "workspace_ref_conflict",
    );
  });

  test("non-wrk_ opaque references keep lazy first binding for personal and created Orgs", async () => {
    const f = fixture(AUTHORITY);
    await f.billing.hold(f.hold(PERSONAL_ORG, "personal_hold", "workspace_route"));
    await f.billing.usage(f.usage("org_created", "created_usage", "ws_random_a"));
    expect((await f.rows()).bindings).toEqual([
      { workspace_ref: "workspace_route", org_id: PERSONAL_ORG },
      { workspace_ref: "ws_random_a", org_id: "org_created" },
    ]);
    await refused(
      f.billing.hold(f.hold("org_created", "other_hold", "workspace_route")),
      "workspace_ref_conflict",
    );
  });

  test("an existing wrk_ binding keeps same-Org admission and different-Org conflict", async () => {
    const f = fixture(AUTHORITY);
    // A binding made before the reservation existed is honoured as it stands.
    await f.sql.run(
      "INSERT INTO org_wallet_workspace_bindings (workspace_ref, org_id, created_at) VALUES (?, ?, ?)",
      [SHARED_REF, PERSONAL_ORG, "2026-10-01T00:00:00.000Z"],
    );
    await f.billing.hold(f.hold(PERSONAL_ORG, "legacy_hold", SHARED_REF));
    await f.billing.usage(f.usage(PERSONAL_ORG, "legacy_usage", SHARED_REF));
    const derived = await workspaceBillingOrganizationRef(AUTHORITY, SHARED_REF);
    await refused(
      f.billing.hold(f.hold(derived, "derived_hold", SHARED_REF)),
      "workspace_ref_conflict",
    );
    expect((await f.rows()).holds).toEqual([{ org_id: PERSONAL_ORG, ref: "legacy_hold" }]);
  });

  test("without a shared Workspace authority (self-host) wrk_ references bind lazily as before", async () => {
    const f = fixture();
    await f.billing.hold(f.hold(PERSONAL_ORG, "selfhost_hold", SHARED_REF));
    expect((await f.rows()).bindings).toEqual([
      { workspace_ref: SHARED_REF, org_id: PERSONAL_ORG },
    ]);
    expect(await workspaceBindingCreatable(PERSONAL_ORG, OTHER_SHARED_REF, undefined)).toBe(true);
  });

  test("the admission batch itself refuses a reserved binding even if the pre-check is bypassed", async () => {
    let lied = false;
    // The first binding read pretends the squatter already owns the reference.
    const f = fixture(AUTHORITY, (sql) => ({
      async query(statement, params) {
        if (
          !lied &&
          statement.startsWith(
            "SELECT org_id FROM org_wallet_workspace_bindings WHERE workspace_ref",
          )
        ) {
          lied = true;
          return [{ org_id: PERSONAL_ORG }];
        }
        return await sql.query(statement, params);
      },
      run: (statement, params) => sql.run(statement, params),
      batch: (statements) => sql.batch(statements),
    }));
    await refused(
      f.billing.hold(f.hold(PERSONAL_ORG, "bypass_hold", SHARED_REF)),
      "workspace_ref_reserved",
    );
    expect(lied).toBe(true);
    const rows = await f.rows();
    expect(rows.bindings).toEqual([]);
    expect(rows.holds).toEqual([]);
    expect(rows.ledger).toEqual([]);
    expect(
      workspaceBindingStatements(PERSONAL_ORG, SHARED_REF, "2026-10-15T00:00:00.000Z", false),
    ).toEqual([]);
  });
});
