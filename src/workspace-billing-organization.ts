import { bytesDigest } from "./json.ts";
import type { SqlStatement } from "./ports.ts";

/**
 * The billing Organization of a shared-auth personal Workspace.
 *
 * Accounts and Takoserver derive the same Organization id from the realm's
 * billing authority and the Workspace reference, so neither side calls the
 * other to "ensure" it: the same intent always names the same Org, and no
 * server-to-server credential or pending table exists. Accounts returns the
 * derived id in its billing-organization tuple. The RP accepts a tuple only
 * when its organizationId equals this derivation for the served realm, then
 * creates the Org, its owner membership and the Workspace binding inside the
 * same fresh principal issuance that mints the owner.
 *
 * The id locates product records. It grants no payment consent.
 *
 * A returning subject keeps its owner: while its binding is active and
 * current, a later login reuses the SAME principal and binding and sends only
 * the owner guard, which writes nothing and aborts unless the same Workspace
 * is bound to the same Org that principal owns.
 *
 * There is no owner transfer and no re-enrollment. A subject whose bindings
 * are all retired is refused before issuance and never receives a fresh
 * principal, so its Org stays owned by the retired principal and no second Org
 * is created (fail-closed). A successor binding is a separate authority action.
 */
export const WORKSPACE_BILLING_ORGANIZATION_CONTRACT =
  "takoserver.workspace-billing-organization@v1";

const AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
// The wallet Workspace attribution grammar (org-workspace-usage.ts).
const WORKSPACE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REF = /^org_wb_[0-9a-f]{32}$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class WorkspaceBillingOrganizationError extends Error {
  constructor() {
    super("invalid workspace billing organization");
    this.name = "WorkspaceBillingOrganizationError";
  }
}

function fail(): never {
  throw new WorkspaceBillingOrganizationError();
}

/** "org_wb_" + the first 32 hex digits of SHA-256(JSON [contract, authority, workspaceRef]). */
export async function workspaceBillingOrganizationRef(
  billingAuthority: string,
  workspaceRef: string,
): Promise<string> {
  if (
    typeof billingAuthority !== "string" ||
    !AUTHORITY.test(billingAuthority) ||
    typeof workspaceRef !== "string" ||
    !WORKSPACE_REF.test(workspaceRef)
  )
    fail();
  const digest = await bytesDigest(
    new TextEncoder().encode(
      JSON.stringify([WORKSPACE_BILLING_ORGANIZATION_CONTRACT, billingAuthority, workspaceRef]),
    ),
  );
  return `org_wb_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

/** True only for the exact derivation; a foreign or malformed tuple is false. */
export async function isWorkspaceBillingOrganization(
  billingAuthority: string,
  tuple: { readonly workspaceRef: string; readonly organizationId: string },
): Promise<boolean> {
  if (typeof tuple?.organizationId !== "string" || !REF.test(tuple.organizationId)) return false;
  try {
    return (
      (await workspaceBillingOrganizationRef(billingAuthority, tuple.workspaceRef)) ===
      tuple.organizationId
    );
  } catch (error) {
    if (error instanceof WorkspaceBillingOrganizationError) return false;
    throw error;
  }
}

export interface WorkspaceBillingOrganizationMaterialization {
  readonly organizationId: string;
  readonly workspaceRef: string;
  readonly principalId: string;
  readonly name: string;
  readonly createdAt: string;
}

/**
 * Batch statements for the issuance that mints the Workspace owner. The caller
 * verifies the derivation first and appends these to its own atomic batch.
 *
 * First login creates the Org, then its owner membership, then the Workspace
 * binding: the Org INSERT comes before any Org-keyed trace row, as Root 0105's
 * birth capture requires. A later login inserts nothing. The final statement
 * aborts the whole batch, through the binding's org_id length CHECK, unless the
 * Org is owned by this principal, holds its owner membership and is the
 * Workspace's binding.
 *
 * The Org INSERT returns its own inserted row. Root 0105's AFTER INSERT capture
 * appends Financial birth observations in the same statement, and D1 counts
 * those trigger rows in the statement's changes, so the returned row (not the
 * change count) is the exact evidence of the Org row this statement wrote.
 */
function materialization(
  input: WorkspaceBillingOrganizationMaterialization,
): WorkspaceBillingOrganizationMaterialization {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).sort().join() !== "createdAt,name,organizationId,principalId,workspaceRef" ||
    typeof input.organizationId !== "string" ||
    !REF.test(input.organizationId) ||
    typeof input.workspaceRef !== "string" ||
    !WORKSPACE_REF.test(input.workspaceRef) ||
    typeof input.principalId !== "string" ||
    input.principalId.length < 1 ||
    input.principalId.length > 128 ||
    typeof input.name !== "string" ||
    input.name.length < 1 ||
    input.name.length > 128 ||
    typeof input.createdAt !== "string" ||
    !TIME.test(input.createdAt)
  )
    fail();
  return input;
}

/** The consistency guard: aborts the batch unless the owner tuple is complete. */
function ownerGuard(input: WorkspaceBillingOrganizationMaterialization): SqlStatement {
  const { organizationId: org, workspaceRef: ref, principalId: owner, createdAt } = input;
  return Object.freeze({
    sql: `INSERT INTO org_wallet_workspace_bindings (workspace_ref, org_id, created_at)
            SELECT ?, '', ? WHERE NOT EXISTS (
              SELECT 1 FROM orgs o
              JOIN org_memberships m ON m.org_id = o.id AND m.principal_id = o.owner_principal_id
                AND m.role = 'owner'
              JOIN org_wallet_workspace_bindings b ON b.workspace_ref = ? AND b.org_id = o.id
              WHERE o.id = ? AND o.owner_principal_id = ?)`,
    params: Object.freeze([ref, createdAt, ref, org, owner]),
  });
}

/**
 * The single statement for a returning owner's later login. It writes no
 * Organization row: it changes nothing and aborts the whole batch, through
 * the binding's org_id length CHECK, unless this exact Org already exists,
 * is owned by this principal, holds its owner membership and is this
 * Workspace's binding. A missing, foreign or differently bound Org is
 * therefore refused, never created or transferred.
 */
export function workspaceBillingOrganizationOwnerGuard(
  input: WorkspaceBillingOrganizationMaterialization,
): SqlStatement {
  return ownerGuard(materialization(input));
}

export function workspaceBillingOrganizationStatements(
  input: WorkspaceBillingOrganizationMaterialization,
): readonly SqlStatement[] {
  const selected = materialization(input);
  const { organizationId: org, workspaceRef: ref, principalId: owner, name, createdAt } = selected;
  return Object.freeze([
    Object.freeze({
      sql: `INSERT INTO orgs (id, name, owner_principal_id, created_at)
            SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM orgs WHERE id = ?)
            RETURNING id, name, owner_principal_id, created_at`,
      params: Object.freeze([org, name, owner, createdAt, org]),
    }),
    Object.freeze({
      sql: `INSERT INTO org_memberships (org_id, principal_id, role, created_at)
            SELECT o.id, o.owner_principal_id, 'owner', ? FROM orgs o
            WHERE o.id = ? AND o.owner_principal_id = ?
              AND NOT EXISTS (SELECT 1 FROM org_memberships m
                WHERE m.org_id = o.id AND m.principal_id = o.owner_principal_id)`,
      params: Object.freeze([createdAt, org, owner]),
    }),
    Object.freeze({
      sql: `INSERT INTO org_wallet_workspace_bindings (workspace_ref, org_id, created_at)
            SELECT ?, o.id, ? FROM orgs o
            WHERE o.id = ? AND o.owner_principal_id = ?
              AND NOT EXISTS (SELECT 1 FROM org_wallet_workspace_bindings WHERE workspace_ref = ?)`,
      params: Object.freeze([ref, createdAt, org, owner, ref]),
    }),
    ownerGuard(selected),
  ]);
}
