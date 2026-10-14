import type { PurchaseCreditExpiry } from "./billing-config.ts";
import { MIGRATIONS } from "./db-schema.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { minorToMicros } from "./money.ts";
import type { Clock, Row, Sql } from "./ports.ts";
import { WALLET_FUNDING_PURPOSE } from "./stripe-settlement.ts";

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SESSION = /^cs_[A-Za-z0-9_]{1,240}$/u;
const CUSTOMER = /^cus_[A-Za-z0-9_]{1,240}$/u;
const ACCOUNT = /^acct_[A-Za-z0-9_]{1,240}$/u;
export const TOP_UP_UNKNOWN_ACK_CUTOFF_MS = 23 * 3600_000;

export class OrgTopUpError extends Error {
  constructor(
    readonly code: "invalid_argument" | "conflict" | "unavailable" | "reconciliation_required",
  ) {
    super(code);
    this.name = "OrgTopUpError";
  }
}

function fail(code: OrgTopUpError["code"]): never {
  throw new OrgTopUpError(code);
}

/** Exact owning command durability, checked read-only before advertising Checkout. */
export async function assertOrgTopUpSchema(sql: Sql): Promise<void> {
  const migration = MIGRATIONS.find((item) => item.name === "0099_hosted_billing_extensions.sql");
  if (!migration) fail("unavailable");
  const normalize = (value: string) => value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");
  for (const [type, name, pattern] of [
    [
      "table",
      "stripe_top_up_commands",
      "CREATE TABLE stripe_top_up_commands\\s*\\([\\s\\S]*?\\n\\);",
    ],
    [
      "index",
      "stripe_top_up_pending_org",
      "CREATE UNIQUE INDEX stripe_top_up_pending_org\\b[\\s\\S]*?;",
    ],
    [
      "trigger",
      "stripe_top_up_command_immutable",
      "CREATE TRIGGER stripe_top_up_command_immutable\\b[\\s\\S]*?\\bEND\\s*;",
    ],
    [
      "trigger",
      "stripe_top_up_commands_no_delete",
      "CREATE TRIGGER stripe_top_up_commands_no_delete\\b[\\s\\S]*?\\bEND\\s*;",
    ],
  ] as const) {
    const expected = migration.sql.match(new RegExp(pattern, "u"))?.[0];
    const actual = (
      await sql.query("SELECT sql FROM sqlite_schema WHERE type=? AND name=?", [type, name])
    )[0]?.sql;
    if (!expected || typeof actual !== "string" || normalize(actual) !== normalize(expected))
      fail("unavailable");
  }
}

/** Supplied only by the owning customer/financial-realm custody composition. */
export interface TopUpPin {
  readonly customerId: string;
  readonly accountId: string;
  readonly livemode: boolean;
  readonly financialRealm: string;
  readonly pricingRevision: string;
  readonly purchaseCreditExpiry: PurchaseCreditExpiry;
}

/** Immutable parameters, retained locally beyond the processor's key retention. */
export interface TopUpCommand extends TopUpPin {
  readonly organizationId: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly amountMicros: number;
  readonly currency: "USD";
  readonly purpose: typeof WALLET_FUNDING_PURPOSE;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface TopUpSession {
  readonly id: string;
  readonly url: string | null;
  readonly status: "open" | "complete" | "expired";
  readonly paymentStatus: "paid" | "unpaid" | "no_payment_required";
  readonly organizationId: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: "USD";
  readonly purpose: typeof WALLET_FUNDING_PURPOSE;
  readonly mode: "payment";
  readonly customerId: string;
  readonly accountId: string;
  readonly livemode: boolean;
  readonly financialRealm: string;
  readonly pricingRevision: string;
  readonly purchaseCreditExpiry: PurchaseCreditExpiry;
}

/**
 * An explicitly injected processor capability, never an inferred key-prefix realm.
 * create must send exactly command under stripeKey. read/recover must authenticate
 * the same account/realm and reject connected-account or ambiguous matches.
 * recover is bounded authoritative readback; null does not prove no effect.
 */
export interface TopUpClient {
  create(command: TopUpCommand, stripeKey: string): Promise<TopUpSession>;
  read(sessionId: string, command: TopUpCommand): Promise<TopUpSession | null>;
  recover(command: TopUpCommand, stripeKey: string): Promise<TopUpSession | null>;
}

export interface TopUpReceipt {
  readonly reference: string;
  readonly state: "pending" | "ready" | "paid" | "expired";
  readonly checkout: { readonly url: string } | null;
}

export interface OrgTopUps {
  readonly referenceRequired: true;
  readonly bounds: { readonly minimumMinor: number; readonly maximumMinor: number };
  begin(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMinor: number;
  }): Promise<{ readonly url: string }>;
  receipt(input: {
    readonly organizationId: string;
    readonly reference: string;
  }): Promise<TopUpReceipt | null>;
  /** Read-only purchase policy for the existing verified settlement writer. */
  commandForSession(sessionId: string): Promise<TopUpCommand | null>;
}

interface StoredCommand {
  readonly command: TopUpCommand;
  readonly fingerprint: string;
  readonly stripeKey: string;
  readonly state: TopUpReceipt["state"];
  readonly sessionId: string | null;
  readonly sessionUrl: string | null;
  readonly dispatchedAt: string | null;
}

function stored(row: Row | undefined): StoredCommand | null {
  if (!row) return null;
  const command = JSON.parse(String(row.command_json)) as TopUpCommand;
  Object.freeze(command.purchaseCreditExpiry);
  Object.freeze(command);
  return {
    command,
    fingerprint: String(row.fingerprint),
    stripeKey: String(row.stripe_key),
    state: row.state as TopUpReceipt["state"],
    sessionId: row.session_id == null ? null : String(row.session_id),
    sessionUrl: row.session_url == null ? null : String(row.session_url),
    dispatchedAt: row.dispatched_at == null ? null : String(row.dispatched_at),
  };
}

function validPin(pin: TopUpPin): void {
  if (
    typeof pin.customerId !== "string" ||
    !CUSTOMER.test(pin.customerId) ||
    typeof pin.accountId !== "string" ||
    !ACCOUNT.test(pin.accountId) ||
    typeof pin.livemode !== "boolean" ||
    typeof pin.financialRealm !== "string" ||
    !REFERENCE.test(pin.financialRealm) ||
    typeof pin.pricingRevision !== "string" ||
    !REFERENCE.test(pin.pricingRevision) ||
    typeof pin.purchaseCreditExpiry !== "object" ||
    pin.purchaseCreditExpiry === null ||
    (pin.purchaseCreditExpiry.kind !== "none" &&
      (pin.purchaseCreditExpiry.kind !== "fixed-duration" ||
        !Number.isSafeInteger(pin.purchaseCreditExpiry.seconds) ||
        pin.purchaseCreditExpiry.seconds <= 0 ||
        pin.purchaseCreditExpiry.seconds > 253402300799))
  )
    fail("unavailable");
}

function wire(row: StoredCommand): TopUpReceipt {
  return {
    reference: row.command.reference,
    state: row.state,
    checkout: row.sessionUrl === null ? null : { url: row.sessionUrl },
  };
}

/** Durable Checkout orchestration only. This module never writes a wallet or grant. */
export function createOrgTopUps(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly client: TopUpClient;
  readonly pin: (organizationId: string) => Promise<TopUpPin>;
  readonly bounds: OrgTopUps["bounds"];
  readonly consoleOrigin: string;
}): OrgTopUps {
  const { sql, clock, client } = options;
  const bounds = Object.freeze({ ...options.bounds });
  const origin = new URL(options.consoleOrigin);
  if (
    origin.origin !== options.consoleOrigin ||
    origin.username ||
    origin.password ||
    !["https:", "http:"].includes(origin.protocol) ||
    !Number.isSafeInteger(bounds.minimumMinor) ||
    bounds.minimumMinor <= 0 ||
    !Number.isSafeInteger(bounds.maximumMinor) ||
    bounds.maximumMinor < bounds.minimumMinor
  ) {
    throw new TypeError("Invalid top-up configuration");
  }
  // A purchase must always have a representable face-value ledger amount.
  minorToMicros(bounds.maximumMinor);
  const now = () => clock().toISOString();
  const byReference = async (organizationId: string, reference: string) =>
    stored(
      (
        await sql.query("SELECT * FROM stripe_top_up_commands WHERE org_id = ? AND reference = ?", [
          organizationId,
          reference,
        ])
      )[0],
    );
  function identity(organizationId: string, reference: string): void {
    if (
      typeof organizationId !== "string" ||
      !REFERENCE.test(organizationId) ||
      typeof reference !== "string" ||
      !REFERENCE.test(reference)
    )
      fail("invalid_argument");
  }
  async function acknowledge(row: StoredCommand, session: TopUpSession): Promise<StoredCommand> {
    const command = row.command;
    if (
      !SESSION.test(session.id) ||
      (row.sessionId !== null && row.sessionId !== session.id) ||
      session.organizationId !== command.organizationId ||
      session.reference !== command.reference ||
      session.amountMinor !== command.amountMinor ||
      session.currency !== command.currency ||
      session.purpose !== command.purpose ||
      session.mode !== "payment" ||
      session.customerId !== command.customerId ||
      session.accountId !== command.accountId ||
      session.livemode !== command.livemode ||
      session.financialRealm !== command.financialRealm ||
      session.pricingRevision !== command.pricingRevision ||
      canonicalJson(session.purchaseCreditExpiry) !== canonicalJson(command.purchaseCreditExpiry) ||
      !["open", "complete", "expired"].includes(session.status) ||
      !["paid", "unpaid", "no_payment_required"].includes(session.paymentStatus)
    )
      fail("conflict");
    const state =
      session.status === "expired"
        ? "expired"
        : session.status === "complete" && session.paymentStatus === "paid"
          ? "paid"
          : "ready";
    if (
      state === "ready" &&
      row.sessionUrl === null &&
      (typeof session.url !== "string" || !session.url)
    )
      fail("unavailable");
    if (session.url !== null) {
      try {
        const url = new URL(session.url);
        if (
          url.origin !== "https://checkout.stripe.com" ||
          !url.pathname.startsWith("/c/pay/") ||
          url.username ||
          url.password
        )
          fail("unavailable");
      } catch {
        fail("unavailable");
      }
    }
    // A stale read cannot regress a paid/expired receipt. Concurrent same-key
    // acknowledgements must also prove the same processor object and URL.
    await sql.run(
      `UPDATE stripe_top_up_commands SET state = ?, session_id = ?, session_url = COALESCE(session_url, ?), updated_at = ?
       WHERE org_id = ? AND reference = ? AND fingerprint = ?
         AND state IN ('pending','ready') AND (session_id IS NULL OR session_id = ?)
         AND (session_url IS NULL OR ? IS NULL OR session_url = ?)`,
      [
        state,
        session.id,
        session.url,
        now(),
        command.organizationId,
        command.reference,
        row.fingerprint,
        session.id,
        session.url,
        session.url,
      ],
    );
    const acknowledged = await byReference(command.organizationId, command.reference);
    if (
      !acknowledged ||
      acknowledged.sessionId !== session.id ||
      (session.url !== null && acknowledged.sessionUrl !== session.url)
    )
      fail("conflict");
    return acknowledged;
  }
  async function readback(row: StoredCommand): Promise<StoredCommand> {
    let session: TopUpSession | null;
    try {
      session =
        row.sessionId === null
          ? await client.recover(row.command, row.stripeKey)
          : await client.read(row.sessionId, row.command);
    } catch (error) {
      if (error instanceof OrgTopUpError) throw error;
      fail("unavailable");
    }
    return session === null ? row : await acknowledge(row, session);
  }
  async function resume(row: StoredCommand): Promise<{ readonly url: string }> {
    if (row.state === "expired") fail("conflict");
    if (row.state === "paid")
      return row.sessionUrl === null ? fail("unavailable") : { url: row.sessionUrl };
    if (row.dispatchedAt !== null) {
      row = await readback(row);
      if (row.state === "expired") fail("conflict");
      if ((row.state === "ready" || row.state === "paid") && row.sessionUrl !== null)
        return { url: row.sessionUrl };
      if (row.state === "paid") fail("unavailable");
    } else {
      await sql.run(
        `UPDATE stripe_top_up_commands SET dispatched_at = ?, updated_at = ?
         WHERE org_id = ? AND reference = ? AND dispatched_at IS NULL AND state = 'pending'`,
        [now(), now(), row.command.organizationId, row.command.reference],
      );
      row =
        (await byReference(row.command.organizationId, row.command.reference)) ??
        fail("unavailable");
      if (row.state === "ready" && row.sessionUrl !== null) return { url: row.sessionUrl };
      if (row.state !== "pending" || row.dispatchedAt === null) fail("conflict");
    }
    // Recheck even after losing the first-dispatch CAS to another process.
    if (row.dispatchedAt === null || !Number.isFinite(Date.parse(row.dispatchedAt)))
      fail("unavailable");
    if (Date.parse(now()) - Date.parse(row.dispatchedAt) >= TOP_UP_UNKNOWN_ACK_CUTOFF_MS)
      fail("reconciliation_required");
    // Unknown responses leave the already-dispatched durable command intact.
    let session: TopUpSession;
    try {
      session = await client.create(row.command, row.stripeKey);
    } catch {
      fail("unavailable");
    }
    const acknowledged = await acknowledge(row, session);
    if (acknowledged.state === "expired" || acknowledged.sessionUrl === null) fail("conflict");
    return { url: acknowledged.sessionUrl };
  }
  return {
    referenceRequired: true,
    bounds,
    async begin({ organizationId, reference, amountMinor }) {
      identity(organizationId, reference);
      if (
        !Number.isSafeInteger(amountMinor) ||
        amountMinor < bounds.minimumMinor ||
        amountMinor > bounds.maximumMinor
      )
        fail("invalid_argument");
      const existing = await byReference(organizationId, reference);
      if (existing) {
        if (existing.command.amountMinor !== amountMinor) fail("conflict");
        return await resume(existing);
      }
      // A new reference may proceed only after authoritative recovery of an
      // earlier unknown Checkout. A null read never clears its pending Org slot.
      const unresolved = stored(
        (
          await sql.query(
            "SELECT * FROM stripe_top_up_commands WHERE org_id = ? AND state = 'pending'",
            [organizationId],
          )
        )[0],
      );
      if (unresolved !== null && (await readback(unresolved)).state === "pending") fail("conflict");
      let pin: TopUpPin;
      try {
        pin = await options.pin(organizationId);
      } catch {
        fail("unavailable");
      }
      validPin(pin);
      const command: TopUpCommand = {
        customerId: pin.customerId,
        accountId: pin.accountId,
        livemode: pin.livemode,
        financialRealm: pin.financialRealm,
        pricingRevision: pin.pricingRevision,
        purchaseCreditExpiry: Object.freeze({ ...pin.purchaseCreditExpiry }),
        organizationId,
        reference,
        amountMinor,
        amountMicros: minorToMicros(amountMinor),
        currency: "USD",
        purpose: WALLET_FUNDING_PURPOSE,
        successUrl: `${origin.origin}/billing?checkout={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin.origin}/billing?checkout=cancelled`,
      };
      const fingerprint = await canonicalDigest(command);
      const stripeKey = `takoserver_topup_${(await canonicalDigest([organizationId, reference])).slice(7)}`;
      const createdAt = now();
      await sql.run(
        `INSERT OR IGNORE INTO stripe_top_up_commands
         (org_id, reference, fingerprint, command_json, stripe_key, state, session_id, session_url, dispatched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
        [
          organizationId,
          reference,
          fingerprint,
          canonicalJson(command),
          stripeKey,
          createdAt,
          createdAt,
        ],
      );
      const persisted = await byReference(organizationId, reference);
      if (!persisted) fail("conflict");
      // Concurrent tariff rotation elects one frozen command. The accepted public
      // request is only Org/reference/amount; retries use the winner's tariff.
      if (persisted.command.amountMinor !== amountMinor) fail("conflict");
      return await resume(persisted);
    },
    async receipt({ organizationId, reference }) {
      identity(organizationId, reference);
      const row = await byReference(organizationId, reference);
      if (!row) return null;
      return wire(row.state === "pending" || row.state === "ready" ? await readback(row) : row);
    },
    async commandForSession(sessionId) {
      if (!SESSION.test(sessionId)) return null;
      return (
        stored(
          (
            await sql.query("SELECT * FROM stripe_top_up_commands WHERE session_id = ?", [
              sessionId,
            ])
          )[0],
        )?.command ?? null
      );
    },
  };
}
