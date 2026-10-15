import { base64UrlDecode, base64UrlEncode } from "./json.ts";
import type { LedgerRefundSource } from "./ledger.ts";
import {
  type OrgUsageSummary,
  orgUsageSummaryReadStatement,
  parseOrgUsageSummaryRows,
} from "./org-usage-summary.ts";
import { type Row, type Sql, SqlError, type SqlParam, type SqlStatement } from "./ports.ts";

export class OrgWorkspaceUsageError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "OrgWorkspaceUsageError";
  }
}

export interface WorkspaceUsageAmounts {
  readonly usedMicros: number;
  readonly heldMicros: number;
  readonly pendingMicros: number;
}
export interface OrgWorkspaceUsagePage {
  readonly organizationId: string;
  readonly snapshotAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly unit: "USD-micros";
  readonly totalsScope: "organization";
  readonly totals: WorkspaceUsageAmounts;
  readonly usageSummary: OrgUsageSummary;
  readonly workspaces: readonly (WorkspaceUsageAmounts & { readonly workspaceRef: string })[];
  readonly unattributed: WorkspaceUsageAmounts;
  readonly cursor: string | null;
}
export interface WorkspaceUsageOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly workspaceRef?: string;
}

const SNAPSHOT_TTL_MS = 600_000;
const SNAPSHOT_WORKSPACES = 10_000;
const SNAPSHOTS_PER_ORG = 8;
function fail(code: string, status: number): never {
  throw new OrgWorkspaceUsageError(code, status);
}
export function validateWorkspaceRef(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))
    fail("invalid_workspace_ref", 400);
}

/** Old, independent wallets can still replay their unattributed inputs without the extension. */
export async function workspaceAttributionSchemaReady(sql: Sql): Promise<boolean> {
  for (const table of ["org_wallet_holds", "org_wallet_usage_records"]) {
    const columns = new Set((await sql.query(`PRAGMA table_info(${table})`)).map((r) => r.name));
    if (
      ["workspace_ref", "attribution_period_start", "attribution_period_end"].some(
        (c) => !columns.has(c),
      )
    )
      return false;
  }
  const rows = await sql.query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('org_wallet_workspace_bindings', 'org_wallet_workspace_snapshots', 'org_wallet_workspace_snapshot_rows')",
  );
  return rows.length === 3;
}

/** Bind inside the same batch as admission, so a failed monetary write creates no binding. */
export function workspaceBindingStatement(
  org: string,
  workspaceRef: string,
  instant: string,
): SqlStatement {
  return {
    sql: "INSERT OR IGNORE INTO org_wallet_workspace_bindings (workspace_ref, org_id, created_at) VALUES (?, ?, ?)",
    params: [workspaceRef, org, instant],
  };
}
export async function assertWorkspaceOwner(
  sql: Sql,
  org: string,
  workspaceRef: string,
): Promise<void> {
  const row = (
    await sql.query("SELECT org_id FROM org_wallet_workspace_bindings WHERE workspace_ref = ?", [
      workspaceRef,
    ])
  )[0];
  if (row && row.org_id !== org) fail("workspace_ref_conflict", 409);
}

/** A reusable read lets the pending INSERT choose its measured interval in its own atomic batch. */
export function measuredAttributionStatement(input: {
  readonly organizationId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly hostedPaidFreeExclusion: boolean;
}): SqlStatement {
  const { organizationId: org, periodStart: start, periodEnd: end } = input;
  const monthStart = `${start.slice(0, 7)}-01T00:00:00.000Z`;
  const next = new Date(monthStart);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const monthEnd = next.toISOString();
  const paid = input.hostedPaidFreeExclusion
    ? `SELECT period_start, period_end FROM stripe_billing_grants
       WHERE org_id = ? AND source_type = 'invoice' AND period_start < ? AND period_end > ?
       ORDER BY period_start, period_end LIMIT 3`
    : `SELECT NULL AS period_start, NULL AS period_end WHERE 0`;
  return {
    sql: `WITH periods AS (${paid}), containing AS (
      SELECT period_start, period_end FROM periods WHERE period_start <= ? AND period_end > ?)
      SELECT COALESCE((SELECT period_start FROM containing LIMIT 1), ?) AS period_start,
        COALESCE((SELECT period_end FROM containing LIMIT 1), ?) AS period_end,
        (SELECT COUNT(*) FROM containing) AS period_count,
        CASE WHEN ? > COALESCE((SELECT period_end FROM containing LIMIT 1), ?) OR EXISTS (
          SELECT 1 FROM periods WHERE (period_start > ? AND period_start < ?)
            OR (period_end > ? AND period_end < ?)) THEN 1 ELSE 0 END AS crosses`,
    params: [
      ...(input.hostedPaidFreeExclusion ? [org, end, start] : []),
      start,
      start,
      monthStart,
      monthEnd,
      end,
      monthEnd,
      start,
      end,
      start,
      end,
    ],
  };
}

/** Immutable service-period proofs determine late usage, independently of delivery or payment time. */
export async function measuredAttributionInterval(input: {
  readonly sql: Sql;
  readonly organizationId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly hostedPaidFreeExclusion: boolean;
}): Promise<{ readonly periodStart: string; readonly periodEnd: string }> {
  const statement = measuredAttributionStatement(input);
  const row = (await input.sql.query(statement.sql, statement.params))[0];
  if (!row || (row.period_count !== 0 && row.period_count !== 1)) fail("billing_unavailable", 503);
  if (row.crosses !== 0) fail("usage_period_crosses_entitlement", 409);
  return { periodStart: String(row.period_start), periodEnd: String(row.period_end) };
}

/** Copy the complete raw entitlement read; its existing checked parser remains the authority. */
const SUMMARY_KEYS = [
  "org_id",
  "snapshot_ref",
  "snapshot_amount",
  "snapshot_end",
  "snapshot_policy",
  "tariff_amount",
  "tariff_end",
  "tariff_revision",
  "snapshot_revision",
  "paid_ref",
  "paid_kind",
  "paid_class",
  "paid_amount",
  "paid_start",
  "paid_end",
  "paid_revoked",
  "paid_count",
  "pending_fence",
  "lot_kind",
  "lot_class",
  "lot_amount",
  "lot_end",
  "used_micros",
  "held_micros",
  "purchased_available",
  "direct_available",
  "additional_min",
] as const;

function snapshotHeader(input: {
  readonly organizationId: string;
  readonly instant: string;
  readonly workspaceRef?: string;
  readonly hostedPaidFreeExclusion: boolean;
  readonly hostedCreditProvenance?: boolean;
  readonly refundSource?: LedgerRefundSource | null;
  readonly snapshotRef: string;
}): SqlStatement {
  const summary = orgUsageSummaryReadStatement(input);
  const summaryJson = SUMMARY_KEYS.map((k) => `'${k}', s.${k}`).join(", ");
  return {
    sql: `WITH summary AS (${summary.sql})
      INSERT INTO org_wallet_workspace_snapshots
        (snapshot_ref, org_id, snapshot_at, expires_at, period_start, period_end, workspace_filter, summary_json, status)
      SELECT ?, ?, ?, ?, COALESCE(s.paid_start, ?), COALESCE(s.paid_end, s.snapshot_end), ?,
        json_object(${summaryJson}), 'building' FROM summary s
      WHERE s.paid_count <= 1 AND s.pending_fence = 0
        AND (SELECT COUNT(*) FROM org_wallet_workspace_snapshots WHERE org_id = ? AND expires_at > ?) < ?`,
    params: [
      ...(summary.params ?? []),
      input.snapshotRef,
      input.organizationId,
      input.instant,
      new Date(Date.parse(input.instant) + SNAPSHOT_TTL_MS).toISOString(),
      `${input.instant.slice(0, 7)}-01T00:00:00.000Z`,
      input.workspaceRef ?? null,
      input.organizationId,
      input.instant,
      SNAPSHOTS_PER_ORG,
    ],
  };
}

/** All rows and the original totals are materialized in one atomic D1 batch, with no per-row binds. */
function snapshotRows(snapshotRef: string, hosted: boolean): SqlStatement {
  const paid = hosted
    ? "SELECT org_id, period_start, period_end, created_at FROM stripe_billing_grants WHERE source_type = 'invoice' AND org_id = (SELECT org_id FROM selected)"
    : "SELECT NULL AS org_id, NULL AS period_start, NULL AS period_end, NULL AS created_at WHERE 0";
  return {
    sql: `WITH selected AS (SELECT * FROM org_wallet_workspace_snapshots WHERE snapshot_ref = ? AND status = 'building'),
      paid AS (${paid}),
      sources AS (
        SELECT h.workspace_ref, h.attribution_period_start, h.attribution_period_end, h.created_at AS original_at,
          h.captured_micros AS used_micros,
          CASE WHEN h.state = 'live' AND h.expires_at > s.snapshot_at THEN h.amount_micros ELSE 0 END AS held_micros,
          0 AS pending_micros, 'hold' AS original_kind
        FROM org_wallet_holds h JOIN selected s ON h.org_id = s.org_id
        WHERE h.captured_micros > 0 OR (h.state = 'live' AND h.expires_at > s.snapshot_at)
        UNION ALL
        SELECT u.workspace_ref, u.attribution_period_start, u.attribution_period_end, u.period_start,
          CASE WHEN u.state = 'paid' THEN u.amount_micros ELSE 0 END, 0,
          CASE WHEN u.state = 'pending' THEN u.amount_micros ELSE 0 END, 'usage'
        FROM org_wallet_usage_records u JOIN selected s ON u.org_id = s.org_id
        UNION ALL
        SELECT NULL, NULL, NULL, l.created_at, -l.settled_delta_micros, 0, 0, 'ledger'
        FROM ledger l JOIN selected s ON l.org_id = s.org_id
        WHERE l.type IN ('capture', 'usage_debit') AND l.settled_delta_micros < 0
          AND (l.type <> 'capture' OR NOT EXISTS (SELECT 1 FROM org_wallet_holds h WHERE h.org_id = l.org_id AND h.ledger_ref = l.ref))
          AND (l.type <> 'usage_debit' OR NOT EXISTS (SELECT 1 FROM org_wallet_usage_records u WHERE u.org_id = l.org_id AND 'org-usage:' || u.ref = l.ref))
      ), attributed AS (
        SELECT *, COALESCE(attribution_period_start,
          (SELECT p.period_start FROM paid p WHERE p.period_start <= original_at AND p.period_end > original_at
            AND (original_kind <> 'hold' OR p.created_at <= original_at) ORDER BY p.period_start DESC LIMIT 1),
          substr(original_at, 1, 7) || '-01T00:00:00.000Z') AS assigned_start,
          COALESCE(attribution_period_end,
          (SELECT p.period_end FROM paid p WHERE p.period_start <= original_at AND p.period_end > original_at
            AND (original_kind <> 'hold' OR p.created_at <= original_at) ORDER BY p.period_start DESC LIMIT 1),
          strftime('%Y-%m-01T00:00:00.000Z', original_at, 'start of month', '+1 month')) AS assigned_end
        FROM sources
      ), grouped AS (
        SELECT COALESCE(workspace_ref, '') AS workspace_ref,
          SUM(a.used_micros) AS used_micros, SUM(a.held_micros) AS held_micros, SUM(a.pending_micros) AS pending_micros
        FROM attributed a JOIN selected s ON a.assigned_start = s.period_start AND a.assigned_end = s.period_end
        GROUP BY COALESCE(workspace_ref, '') ORDER BY workspace_ref LIMIT ${SNAPSHOT_WORKSPACES + 2}
      )
      INSERT INTO org_wallet_workspace_snapshot_rows (snapshot_ref, workspace_ref, used_micros, held_micros, pending_micros)
      SELECT ?, workspace_ref, used_micros, held_micros, pending_micros FROM grouped
      UNION ALL SELECT ?, '', 0, 0, 0 FROM selected WHERE NOT EXISTS (SELECT 1 FROM grouped WHERE workspace_ref = '')`,
    params: [snapshotRef, snapshotRef, snapshotRef],
  };
}

function amounts(row: Row): WorkspaceUsageAmounts {
  const result = { usedMicros: 0, heldMicros: 0, pendingMicros: 0 };
  for (const [field, key] of [
    ["usedMicros", "used_micros"],
    ["heldMicros", "held_micros"],
    ["pendingMicros", "pending_micros"],
  ] as const) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      fail("billing_unavailable", 503);
    result[field] = value;
  }
  // The three disjoint classes must also have a safely representable aggregate.
  if (
    BigInt(result.usedMicros) + BigInt(result.heldMicros) + BigInt(result.pendingMicros) >
    BigInt(Number.MAX_SAFE_INTEGER)
  )
    fail("billing_unavailable", 503);
  return result;
}

interface SnapshotCursor {
  readonly snapshot: string;
  readonly organizationId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly workspaceRef: string | null;
  readonly after: string;
}
function decodeCursor(value: string): SnapshotCursor {
  if (typeof value !== "string" || value.length > 1024) fail("invalid_cursor", 400);
  const bytes = base64UrlDecode(value);
  if (!bytes) fail("invalid_cursor", 400);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    fail("invalid_cursor", 400);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    fail("invalid_cursor", 400);
  const c = decoded as Record<string, unknown>;
  if (
    Object.keys(c).sort().join() !==
      "after,organizationId,periodEnd,periodStart,snapshot,workspaceRef" ||
    typeof c.snapshot !== "string" ||
    !/^[a-f0-9]{32}$/u.test(c.snapshot) ||
    typeof c.organizationId !== "string" ||
    typeof c.periodStart !== "string" ||
    typeof c.periodEnd !== "string" ||
    typeof c.after !== "string" ||
    (c.workspaceRef !== null && typeof c.workspaceRef !== "string")
  )
    fail("invalid_cursor", 400);
  validateWorkspaceRef(c.after);
  if (typeof c.workspaceRef === "string") validateWorkspaceRef(c.workspaceRef);
  return c as unknown as SnapshotCursor;
}

export async function readOrgWorkspaceUsage(input: {
  readonly sql: Sql;
  readonly organizationId: string;
  readonly instant: string;
  readonly hostedPaidFreeExclusion: boolean;
  readonly hostedCreditProvenance?: boolean;
  readonly refundSource?: LedgerRefundSource | null;
  readonly options?: WorkspaceUsageOptions;
}): Promise<OrgWorkspaceUsagePage> {
  const { sql, organizationId: org, instant } = input;
  const options = input.options ?? {};
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_limit", 400);
  if (options.workspaceRef !== undefined) validateWorkspaceRef(options.workspaceRef);
  if (!(await workspaceAttributionSchemaReady(sql))) fail("billing_schema_not_ready", 503);
  const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  let snapshotRef = after?.snapshot;
  try {
    if (!after) {
      if (
        options.workspaceRef !== undefined &&
        !(
          await sql.query(
            "SELECT 1 FROM org_wallet_workspace_bindings WHERE org_id = ? AND workspace_ref = ?",
            [org, options.workspaceRef],
          )
        ).length
      )
        fail("workspace_not_found", 404);
      // Bounded cleanup uses SELECT rather than generating an IN bind for every expired snapshot.
      await sql.run(
        `DELETE FROM org_wallet_workspace_snapshots WHERE snapshot_ref IN
         (SELECT snapshot_ref FROM org_wallet_workspace_snapshots WHERE org_id = ? AND expires_at <= ? ORDER BY expires_at, snapshot_ref LIMIT 8)`,
        [org, instant],
      );
      snapshotRef = crypto.randomUUID().replaceAll("-", "");
      const headerInput = {
        organizationId: org,
        instant,
        hostedPaidFreeExclusion: input.hostedPaidFreeExclusion,
        snapshotRef,
        hostedCreditProvenance: input.hostedCreditProvenance === true,
        ...(input.refundSource === undefined ? {} : { refundSource: input.refundSource }),
        ...(options.workspaceRef === undefined ? {} : { workspaceRef: options.workspaceRef }),
      };
      const guardRef = `workspace_snapshot_${snapshotRef}`;
      await sql.batch([
        snapshotHeader(headerInput),
        {
          sql: "INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)",
          params: [guardRef],
        },
        snapshotRows(snapshotRef, input.hostedPaidFreeExclusion),
        {
          sql: `UPDATE org_wallet_workspace_snapshots SET
            used_micros = (SELECT COALESCE(SUM(used_micros), 0) FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = ?),
            held_micros = (SELECT COALESCE(SUM(held_micros), 0) FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = ?),
            pending_micros = (SELECT COALESCE(SUM(pending_micros), 0) FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = ?),
            row_count = (SELECT COUNT(*) FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = ? AND workspace_ref <> ''),
            status = 'building' WHERE snapshot_ref = ? AND status = 'building'`,
          params: [snapshotRef, snapshotRef, snapshotRef, snapshotRef, snapshotRef],
        },
        {
          sql: `INSERT INTO wallet_allocation_guards (id, valid)
            SELECT ?, CASE WHEN row_count <= ${SNAPSHOT_WORKSPACES}
              AND used_micros <= 9007199254740991 AND held_micros <= 9007199254740991
              AND pending_micros <= 9007199254740991
              AND used_micros + held_micros + pending_micros <= 9007199254740991
              THEN 1 ELSE 0 END FROM org_wallet_workspace_snapshots WHERE snapshot_ref = ?`,
          params: [`${guardRef}_totals`, snapshotRef],
        },
        {
          sql: "UPDATE org_wallet_workspace_snapshots SET status = 'ready' WHERE snapshot_ref = ? AND status = 'building'",
          params: [snapshotRef],
        },
        {
          sql: "DELETE FROM wallet_allocation_guards WHERE id IN (?, ?)",
          params: [guardRef, `${guardRef}_totals`],
        },
      ]);
    }
    if (after && after.organizationId !== org) fail("invalid_cursor", 400);
    const header = (
      await sql.query(
        "SELECT * FROM org_wallet_workspace_snapshots WHERE snapshot_ref = ? AND org_id = ? AND status = 'ready'",
        [snapshotRef ?? null, org],
      )
    )[0];
    if (!header)
      fail(after ? "workspace_snapshot_expired" : "billing_unavailable", after ? 409 : 503);
    if (String(header.expires_at) <= instant) fail("workspace_snapshot_expired", 409);
    if (
      after &&
      (after.organizationId !== org ||
        after.periodStart !== header.period_start ||
        after.periodEnd !== header.period_end ||
        after.workspaceRef !== header.workspace_filter ||
        (options.workspaceRef !== undefined && options.workspaceRef !== header.workspace_filter))
    )
      fail("invalid_cursor", 400);
    let rawSummary: unknown;
    try {
      rawSummary = JSON.parse(String(header.summary_json));
    } catch {
      fail("billing_unavailable", 503);
    }
    if (!rawSummary || typeof rawSummary !== "object" || Array.isArray(rawSummary))
      fail("billing_unavailable", 503);
    const summary = parseOrgUsageSummaryRows([rawSummary as Row], {
      organizationId: org,
      instant: String(header.snapshot_at),
      hostedPaidFreeExclusion: input.hostedPaidFreeExclusion,
    });
    if (summary.periodStart !== header.period_start || summary.periodEnd !== header.period_end)
      fail("billing_unavailable", 503);
    if (
      typeof header.row_count !== "number" ||
      !Number.isSafeInteger(header.row_count) ||
      header.row_count < 0 ||
      header.row_count > SNAPSHOT_WORKSPACES
    )
      fail("billing_unavailable", 503);
    const totals = amounts(header);
    const filter = header.workspace_filter == null ? null : String(header.workspace_filter);
    const params: SqlParam[] = [snapshotRef ?? null];
    if (filter !== null) params.push(filter);
    if (after) params.push(after.after);
    params.push(limit + 1);
    const rows = await sql.query(
      `SELECT * FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = ? AND workspace_ref <> ''
        ${filter === null ? "" : "AND workspace_ref = ?"} ${after ? "AND workspace_ref > ?" : ""}
        ORDER BY workspace_ref LIMIT ?`,
      params,
    );
    if (
      after &&
      !(
        await sql.query(
          "SELECT 1 FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = ? AND workspace_ref = ?",
          [snapshotRef ?? null, after.after],
        )
      ).length
    )
      fail("invalid_cursor", 400);
    const unattributed = (
      await sql.query(
        "SELECT * FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = ? AND workspace_ref = ''",
        [snapshotRef ?? null],
      )
    )[0];
    if (!unattributed) fail("billing_unavailable", 503);
    const page = rows
      .slice(0, limit)
      .map((r) => ({ workspaceRef: String(r.workspace_ref), ...amounts(r) }));
    const last = page[page.length - 1];
    const cursor: SnapshotCursor | null =
      rows.length > limit && last
        ? {
            snapshot: String(header.snapshot_ref),
            organizationId: org,
            periodStart: summary.periodStart,
            periodEnd: summary.periodEnd,
            workspaceRef: filter,
            after: last.workspaceRef,
          }
        : null;
    return {
      organizationId: org,
      snapshotAt: String(header.snapshot_at),
      periodStart: summary.periodStart,
      periodEnd: summary.periodEnd,
      unit: "USD-micros",
      totalsScope: "organization",
      totals,
      usageSummary: summary,
      workspaces: page,
      unattributed: amounts(unattributed),
      cursor: cursor ? base64UrlEncode(new TextEncoder().encode(JSON.stringify(cursor))) : null,
    };
  } catch (error) {
    if (error instanceof SqlError) fail("billing_unavailable", 503);
    throw error;
  }
}
