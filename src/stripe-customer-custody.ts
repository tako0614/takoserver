import { MIGRATIONS } from "./db-schema.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { OrgTopUpError, TOP_UP_UNKNOWN_ACK_CUTOFF_MS } from "./org-top-up.ts";
import type { Clock, Row, Sql } from "./ports.ts";
import { parseStrictJson } from "./strict-json.ts";
import type { StripeBillingClient, StripeBillingObject } from "./stripe-billing-client.ts";

const ORG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CUSTOMER = /^cus_[A-Za-z0-9_]{1,240}$/u;
const MAX_RECOVERY_PAGES = 10;
function fail(code: OrgTopUpError["code"]): never {
  throw new OrgTopUpError(code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("conflict");
  return value as Record<string, unknown>;
}

/** No repair: require the exact owning durable processor-step SQL and proof guards. */
export async function assertStripeCustomerCustodySchema(sql: Sql): Promise<void> {
  const migration = MIGRATIONS.find((item) => item.name === "0099_hosted_billing_extensions.sql");
  if (!migration) fail("unavailable");
  const normalize = (value: string) => value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");
  for (const [type, name] of [
    ["table", "stripe_billing_customer_commands"],
    ["trigger", "stripe_billing_customer_commands_immutable"],
    ["trigger", "stripe_billing_customer_commands_no_delete"],
    ["trigger", "stripe_billing_customer_commands_verified_insert"],
    ["trigger", "stripe_billing_customer_commands_verified_update"],
  ] as const) {
    const pattern =
      type === "table"
        ? `CREATE TABLE ${name}\\s*\\([\\s\\S]*?\\n\\);`
        : `CREATE TRIGGER ${name}\\b[\\s\\S]*?\\bEND\\s*;`;
    const expected = migration.sql.match(new RegExp(pattern, "u"))?.[0];
    const actual = (
      await sql.query("SELECT sql FROM sqlite_schema WHERE type=? AND name=?", [type, name])
    )[0]?.sql;
    if (!expected || typeof actual !== "string" || normalize(actual) !== normalize(expected))
      fail("unavailable");
  }
}

/** Shared customer proof for custody, Checkout and the existing funding verifier. */
export function assertStripeCustomerBinding(
  remote: StripeBillingObject,
  expected: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly realm: HostedBillingFinancialRealm;
  },
): void {
  if (
    !CUSTOMER.test(remote.id) ||
    remote.id !== expected.customerId ||
    remote.object !== "customer" ||
    remote.deleted === true ||
    remote.livemode !== expected.realm.livemode ||
    ["on_behalf_of", "transfer_data", "application", "account"].some((key) => remote[key] != null)
  )
    fail("conflict");
  const metadata = remote.metadata == null ? {} : object(remote.metadata);
  // Unmarked historical customers keep compatibility; a known contradictory
  // marker is evidence against the binding and can never be ignored on replay.
  if (
    (metadata.organizationId != null && metadata.organizationId !== expected.organizationId) ||
    (metadata.takoserverPurpose != null && metadata.takoserverPurpose !== "hosted_subscription") ||
    (metadata.stripeAccountId != null && metadata.stripeAccountId !== expected.realm.accountId) ||
    (metadata.financialRealm != null && metadata.financialRealm !== expected.realm.financialRealm)
  )
    fail("conflict");
}

/** Fresh authenticated read against the sole immutable Org/customer association. */
export async function verifyStripeCustomerBinding(
  context: {
    readonly sql: Sql;
    readonly client: StripeBillingClient;
    readonly realm: HostedBillingFinancialRealm;
  },
  organizationId: string,
  customerId: string,
): Promise<void> {
  const { sql, client, realm } = context;
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
  });
  const bound = async () =>
    (
      await sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [
        organizationId,
      ])
    )[0]?.customer_id;
  if ((await bound()) !== customerId) fail("conflict");
  const remote = await client.get("customers", customerId);
  if (!remote) fail("conflict");
  assertStripeCustomerBinding(remote, { organizationId, customerId, realm });
  if ((await bound()) !== customerId) fail("conflict");
}
interface CustomerCommand {
  readonly organizationId: string;
  readonly realm: {
    readonly accountId: string;
    readonly financialRealm: string;
    readonly livemode: false;
    readonly billingAuthority: string;
  };
  readonly metadata: Readonly<Record<string, string>>;
}
interface Receipt {
  readonly command: CustomerCommand;
  readonly key: string;
  readonly fingerprint: string;
  readonly state: "prepared" | "dispatched" | "verified";
  readonly dispatchedAt: string | null;
  readonly customerId: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
}

/** Local observations only: null does not establish complete or clear history. */
export interface StripeCustomerCustodyInspection {
  readonly organizationId: string;
  readonly command: {
    readonly state: Receipt["state"];
    readonly fingerprint: string;
    readonly createdAt: string;
    readonly dispatchedAt: string | null;
    readonly verifiedAt: string | null;
    readonly customerId: string | null;
  } | null;
  readonly binding: {
    readonly customerId: string;
    /** Historical SQL TEXT, observed without imposing command chronology. */
    readonly createdAt: string;
  } | null;
}

function instant(value: unknown): string {
  if (typeof value !== "string") fail("conflict");
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) fail("conflict");
  return value;
}

function storedJson(value: unknown): unknown {
  if (typeof value !== "string") fail("conflict");
  try {
    return parseStrictJson(new TextEncoder().encode(value), 64 * 1024);
  } catch {
    fail("conflict");
  }
}

/** One customer authority, used before both canonical subscription and top-up Checkout. */
export function createStripeCustomerCustody(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
}) {
  const { sql, clock, client, realm } = options;
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
  });
  const now = () => clock().toISOString();
  async function original(org: string) {
    const frozenRealm = Object.freeze({
      accountId: realm.accountId,
      financialRealm: realm.financialRealm,
      livemode: false as const,
      billingAuthority: realm.billingAuthority,
    });
    const digest = await canonicalDigest({
      organizationId: org,
      realm: frozenRealm,
      purpose: "hosted_subscription",
    });
    const key = `takoserver_customer_${digest.slice(7)}`;
    const command: CustomerCommand = Object.freeze({
      organizationId: org,
      realm: frozenRealm,
      metadata: Object.freeze({
        organizationId: org,
        takoserverPurpose: "hosted_subscription",
        stripeAccountId: realm.accountId,
        financialRealm: realm.financialRealm,
        customerCreationCommand: digest,
        customerCreationKey: key,
      }),
    });
    return { command, key, fingerprint: await canonicalDigest(command) };
  }
  async function snapshot(org: string): Promise<{
    readonly receipt: Receipt | null;
    readonly inspection: StripeCustomerCustodyInspection;
  }> {
    assertHostedBillingFinancialRealm(realm, {
      sql,
      client,
      billingAuthority: realm.billingAuthority,
    });
    if (typeof org !== "string" || !ORG.test(org)) fail("invalid_argument");
    const rows = await sql.query(
      `SELECT o.id AS organization_id, c.org_id AS command_org_id,
        c.realm_json, c.request_json, c.fingerprint, c.stripe_key, c.state,
        c.dispatched_at, c.customer_id, c.created_at, c.verified_at,
        b.org_id AS binding_org_id, b.customer_id AS bound_customer_id,
        b.created_at AS binding_created_at
       FROM orgs o
       LEFT JOIN stripe_billing_customer_commands c ON c.org_id = o.id
       LEFT JOIN stripe_billing_customers b ON b.org_id = o.id
       WHERE o.id = ?`,
      [org],
    );
    if (rows.length === 0) fail("invalid_argument");
    const row: Row | undefined = rows[0];
    if (rows.length !== 1 || !row || row.organization_id !== org) fail("conflict");
    let binding: StripeCustomerCustodyInspection["binding"] = null;
    if (row.binding_org_id !== null) {
      if (
        row.binding_org_id !== org ||
        typeof row.bound_customer_id !== "string" ||
        !CUSTOMER.test(row.bound_customer_id) ||
        typeof row.binding_created_at !== "string"
      )
        fail("conflict");
      binding = Object.freeze({
        customerId: row.bound_customer_id,
        createdAt: row.binding_created_at,
      });
    } else if (row.bound_customer_id !== null || row.binding_created_at !== null) fail("conflict");
    let decoded: Receipt | null = null;
    if (row.command_org_id !== null) {
      const expected = await original(org);
      if (
        row.command_org_id !== org ||
        canonicalJson(storedJson(row.realm_json)) !== canonicalJson(expected.command.realm) ||
        canonicalJson(storedJson(row.request_json)) !== canonicalJson(expected.command) ||
        row.fingerprint !== expected.fingerprint ||
        row.stripe_key !== expected.key ||
        (row.state !== "prepared" && row.state !== "dispatched" && row.state !== "verified")
      )
        fail("conflict");
      const state = row.state as Receipt["state"];
      const createdAt = instant(row.created_at);
      const dispatchedAt = row.dispatched_at === null ? null : instant(row.dispatched_at);
      const verifiedAt = row.verified_at === null ? null : instant(row.verified_at);
      const customerId = row.customer_id;
      if (customerId !== null && (typeof customerId !== "string" || !CUSTOMER.test(customerId)))
        fail("conflict");
      // These are wall-clock observations. Durable state, not timestamp order,
      // establishes progress; the owning writer and schema permit clock rollback.
      if (
        (state === "prepared" &&
          (dispatchedAt !== null || customerId !== null || verifiedAt !== null)) ||
        (state !== "prepared" && dispatchedAt === null) ||
        (state === "dispatched" && (customerId !== null || verifiedAt !== null)) ||
        (state === "verified" &&
          (customerId === null ||
            verifiedAt === null ||
            dispatchedAt === null ||
            binding?.customerId !== customerId))
      )
        fail("conflict");
      decoded = Object.freeze({
        ...expected,
        state,
        createdAt,
        dispatchedAt,
        verifiedAt,
        customerId,
      });
    } else if (
      [
        "realm_json",
        "request_json",
        "fingerprint",
        "stripe_key",
        "state",
        "dispatched_at",
        "customer_id",
        "created_at",
        "verified_at",
      ].some((key) => row[key] !== null)
    )
      fail("conflict");
    const command =
      decoded === null
        ? null
        : Object.freeze({
            state: decoded.state,
            fingerprint: decoded.fingerprint,
            createdAt: decoded.createdAt,
            dispatchedAt: decoded.dispatchedAt,
            verifiedAt: decoded.verifiedAt,
            customerId: decoded.customerId,
          });
    return {
      receipt: decoded,
      inspection: Object.freeze({ organizationId: org, command, binding }),
    };
  }
  const read = async (org: string) => (await snapshot(org)).receipt;
  function validate(
    remote: StripeBillingObject,
    org: string,
    metadata?: Readonly<Record<string, string>>,
  ): void {
    assertStripeCustomerBinding(remote, { organizationId: org, customerId: remote.id, realm });
    const actual = remote.metadata == null ? {} : object(remote.metadata);
    if (
      metadata !== undefined &&
      Object.entries(metadata).some(([key, value]) => actual[key] !== value)
    )
      fail("conflict");
  }
  async function verifyBound(org: string, id: string): Promise<string> {
    await verifyStripeCustomerBinding(options, org, id);
    return id;
  }
  async function recover(row: Receipt): Promise<StripeBillingObject | null> {
    let after: string | undefined;
    let match: StripeBillingObject | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_RECOVERY_PAGES; page++) {
      const listed = await client.list("customers", {
        limit: 100,
        ...(after === undefined ? {} : { startingAfter: after }),
      });
      for (const remote of listed.data) {
        if (seen.has(remote.id)) fail("reconciliation_required");
        seen.add(remote.id);
        const metadata = remote.metadata == null ? {} : object(remote.metadata);
        if (
          metadata.customerCreationCommand === row.command.metadata.customerCreationCommand ||
          (metadata.organizationId === row.command.organizationId &&
            metadata.customerCreationKey === row.key)
        ) {
          if (match !== null) fail("reconciliation_required");
          validate(remote, row.command.organizationId, row.command.metadata);
          match = remote;
        }
      }
      if (!listed.hasMore) {
        if (match === null) return null;
        const current = await client.get("customers", match.id);
        if (!current) fail("unavailable");
        validate(current, row.command.organizationId, row.command.metadata);
        return current;
      }
      after = listed.data.at(-1)?.id;
      if (after === undefined) fail("reconciliation_required");
    }
    fail("reconciliation_required");
  }
  async function finalize(row: Receipt, remote: StripeBillingObject): Promise<string> {
    validate(remote, row.command.organizationId, row.command.metadata);
    await sql.batch([
      {
        sql: "INSERT OR IGNORE INTO stripe_billing_customers (org_id,customer_id,created_at) VALUES (?,?,?)",
        params: [row.command.organizationId, remote.id, now()],
      },
      {
        sql: `UPDATE stripe_billing_customer_commands SET state='verified',customer_id=?,verified_at=?
          WHERE org_id=? AND fingerprint=? AND state='dispatched'`,
        params: [remote.id, now(), row.command.organizationId, row.fingerprint],
      },
    ]);
    const snapshotAfter = await snapshot(row.command.organizationId);
    const current = snapshotAfter.receipt;
    if (
      snapshotAfter.inspection.binding?.customerId !== remote.id ||
      current?.state !== "verified" ||
      current.customerId !== remote.id
    )
      fail("conflict");
    return await verifyBound(row.command.organizationId, remote.id);
  }
  return {
    /** SQL-only, redacted local custody; never creates or proves absent history. */
    async inspect(organizationId: string): Promise<StripeCustomerCustodyInspection> {
      return (await snapshot(organizationId)).inspection;
    },
    async ensure(organizationId: string): Promise<string> {
      const initial = await snapshot(organizationId);
      let row = initial.receipt;
      const current = initial.inspection.binding?.customerId ?? null;
      if (current !== null) {
        // A pending local creation command cannot be silently abandoned in favor
        // of another writer's customer; recover its exact original effect first.
        if (row !== null && (row.state !== "verified" || row.customerId !== current))
          fail("reconciliation_required");
        return await verifyBound(organizationId, current);
      }
      if (row === null) {
        const { command, key, fingerprint } = await original(organizationId);
        await sql.run(
          `INSERT OR IGNORE INTO stripe_billing_customer_commands
          (org_id,realm_json,request_json,fingerprint,stripe_key,state,dispatched_at,customer_id,created_at,verified_at)
          VALUES (?,?,?,?,?,'prepared',NULL,NULL,?,NULL)`,
          [
            organizationId,
            canonicalJson(command.realm),
            canonicalJson(command),
            fingerprint,
            key,
            now(),
          ],
        );
        row = await read(organizationId);
      }
      if (row === null) fail("conflict");
      if (row.state === "verified") {
        if (row.customerId === null) fail("conflict");
        return await verifyBound(organizationId, row.customerId);
      }
      if (row.state === "dispatched") {
        const recovered = await recover(row);
        if (recovered !== null) return await finalize(row, recovered);
      } else {
        await sql.run(
          `UPDATE stripe_billing_customer_commands SET state='dispatched',dispatched_at=?
          WHERE org_id=? AND state='prepared' AND NOT EXISTS
            (SELECT 1 FROM stripe_billing_customers WHERE org_id=?)`,
          [now(), organizationId, organizationId],
        );
        row = (await read(organizationId)) ?? fail("unavailable");
        if (row.state === "verified" && row.customerId !== null)
          return await verifyBound(organizationId, row.customerId);
      }
      // Recovery can await the processor. Re-read the same closed custody before
      // another original-key effect, without deriving authority from a read.
      const beforePost = await snapshot(organizationId);
      row = beforePost.receipt ?? fail("conflict");
      if (beforePost.inspection.binding !== null) {
        if (row.state !== "verified" || row.customerId !== beforePost.inspection.binding.customerId)
          fail("reconciliation_required");
        return await verifyBound(organizationId, beforePost.inspection.binding.customerId);
      }
      if (row.state !== "dispatched" || row.dispatchedAt === null) fail("conflict");
      if (Date.parse(now()) - Date.parse(row.dispatchedAt) >= TOP_UP_UNKNOWN_ACK_CUTOFF_MS)
        fail("reconciliation_required");
      const form: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.command.metadata))
        form[`metadata[${key}]`] = value;
      let remote: StripeBillingObject;
      try {
        remote = await client.post("customers", { form, idempotencyKey: row.key });
      } catch {
        fail("unavailable");
      }
      return await finalize(row, remote);
    },
  };
}
