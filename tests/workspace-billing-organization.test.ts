import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readFinancial0104CanonicalMigrationSource } from "../scripts/deploy/financial0104-canonical-source.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import {
  isWorkspaceBillingOrganization,
  WorkspaceBillingOrganizationError,
  workspaceBillingOrganizationRef,
  workspaceBillingOrganizationStatements,
} from "../src/workspace-billing-organization.ts";

const ROOT = resolve(import.meta.dir, "..");
const AUTHORITY = "takoserver.hosted.staging-test.v1";
const WORKSPACE = "ws_personal_01";
// Independently computed: sha256 of the compact JSON array, first 32 hex digits.
const VECTOR = "org_wb_66d254b5377f25b587a88e7551d7018c";
const AT = "2026-10-20T06:00:00.000Z";

function materialize(principalId: string, workspaceRef = WORKSPACE, organizationId = VECTOR) {
  return workspaceBillingOrganizationStatements({
    organizationId,
    workspaceRef,
    principalId,
    name: "Personal workspace",
    createdAt: AT,
  });
}

async function tuple(sql: Sql) {
  return {
    orgs: await sql.query("SELECT id, owner_principal_id FROM orgs ORDER BY id"),
    memberships: await sql.query("SELECT org_id, principal_id, role FROM org_memberships"),
    bindings: await sql.query("SELECT workspace_ref, org_id FROM org_wallet_workspace_bindings"),
  };
}

describe("workspace billing Organization derivation", () => {
  test("pins the shared Accounts/Takoserver vectors", async () => {
    expect(await workspaceBillingOrganizationRef(AUTHORITY, WORKSPACE)).toBe(VECTOR);
    expect(await workspaceBillingOrganizationRef("authority.synthetic", "wsr:example-1")).toBe(
      "org_wb_472638c25c95f6bd8d64d08ab89620d9",
    );
  });

  test("accepts only the derivation for the served realm", async () => {
    const accepted = { workspaceRef: WORKSPACE, organizationId: VECTOR };
    expect(await isWorkspaceBillingOrganization(AUTHORITY, accepted)).toBe(true);
    expect(await isWorkspaceBillingOrganization("takoserver.hosted.other", accepted)).toBe(false);
    expect(
      await isWorkspaceBillingOrganization(AUTHORITY, { ...accepted, workspaceRef: "ws_other" }),
    ).toBe(false);
    expect(
      await isWorkspaceBillingOrganization(AUTHORITY, { ...accepted, organizationId: "org_abc" }),
    ).toBe(false);
    expect(
      await isWorkspaceBillingOrganization(AUTHORITY, { ...accepted, workspaceRef: "-bad" }),
    ).toBe(false);
  });

  test("refuses malformed inputs", async () => {
    await expect(workspaceBillingOrganizationRef("", WORKSPACE)).rejects.toBeInstanceOf(
      WorkspaceBillingOrganizationError,
    );
    await expect(
      workspaceBillingOrganizationRef(AUTHORITY, "x".repeat(129)),
    ).rejects.toBeInstanceOf(WorkspaceBillingOrganizationError);
    expect(() => materialize("prn_a", WORKSPACE, "org_abc")).toThrow(
      WorkspaceBillingOrganizationError,
    );
    expect(() =>
      workspaceBillingOrganizationStatements({
        organizationId: VECTOR,
        workspaceRef: WORKSPACE,
        principalId: "prn_a",
        name: "Personal workspace",
        createdAt: AT,
        extra: 1,
      } as never),
    ).toThrow(WorkspaceBillingOrganizationError);
  });
});

describe("workspace billing Organization materialization", () => {
  test("first login creates the owner tuple; a later login by the owner changes nothing", async () => {
    const sql = createEphemeralSql();
    await sql.batch(materialize("prn_owner"));
    const created = await tuple(sql);
    expect(created).toEqual({
      orgs: [{ id: VECTOR, owner_principal_id: "prn_owner" }],
      memberships: [{ org_id: VECTOR, principal_id: "prn_owner", role: "owner" }],
      bindings: [{ workspace_ref: WORKSPACE, org_id: VECTOR }],
    });
    await sql.batch(materialize("prn_owner"));
    expect(await tuple(sql)).toEqual(created);
  });

  test("another principal or a foreign Workspace binding aborts the whole batch", async () => {
    const sql = createEphemeralSql();
    await sql.batch(materialize("prn_owner"));
    const created = await tuple(sql);
    await expect(sql.batch(materialize("prn_other"))).rejects.toBeInstanceOf(SqlError);
    expect(await tuple(sql)).toEqual(created);

    const other = await workspaceBillingOrganizationRef(AUTHORITY, "ws_personal_02");
    await sql.run(
      "INSERT INTO org_wallet_workspace_bindings (workspace_ref, org_id, created_at) VALUES (?, ?, ?)",
      ["ws_personal_02", "org_foreign", AT],
    );
    await expect(sql.batch(materialize("prn_two", "ws_personal_02", other))).rejects.toBeInstanceOf(
      SqlError,
    );
    expect((await sql.query("SELECT id FROM orgs WHERE id = ?", [other])).length).toBe(0);
  });

  test("an Org without its owner membership is not adopted", async () => {
    const sql = createEphemeralSql();
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, 'x', 'prn_owner', ?)",
      [VECTOR, AT],
    );
    await sql.run(
      "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, 'prn_owner', 'member', ?)",
      [VECTOR, AT],
    );
    await expect(sql.batch(materialize("prn_owner"))).rejects.toBeInstanceOf(SqlError);
    expect(
      (
        await sql.query("SELECT 1 FROM org_wallet_workspace_bindings WHERE workspace_ref = ?", [
          WORKSPACE,
        ])
      ).length,
    ).toBe(0);
  });

  test("on the canonical 105 chain the Org birth is captured before its binding", () => {
    const source = readFinancial0104CanonicalMigrationSource(ROOT);
    const database = new Database(":memory:", { strict: true });
    const issue = (principalId: string) =>
      database.transaction(() => {
        for (const statement of materialize(principalId))
          database.query(statement.sql).run(...((statement.params ?? []) as string[]));
      })();
    try {
      database.query("PRAGMA foreign_keys=ON").all();
      for (const file of source.artifactFor(105).files)
        database.exec(readFileSync(file.path, "utf8"));
      issue("prn_owner");
      // A second fresh principal for an already-materialized Workspace (Root's
      // issuance refuses a second active binding first) never adopts the Org,
      // and the refused batch leaves no Org change observation behind.
      expect(() => issue("prn_second")).toThrow();
      expect(
        database.query("SELECT count(*) AS n FROM financial_customer_history_org_changes").all(),
      ).toEqual([{ n: 0 }]);
      expect(
        database
          .query(
            "SELECT org_id, owner_principal_id FROM financial_customer_history_birth_observations",
          )
          .all(),
      ).toEqual([{ org_id: VECTOR, owner_principal_id: "prn_owner" }]);
      expect(database.query("SELECT org_id FROM org_wallet_workspace_bindings").all()).toEqual([
        { org_id: VECTOR },
      ]);
    } finally {
      database.close();
      source.dispose();
    }
  });
});
