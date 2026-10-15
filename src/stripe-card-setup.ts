import { MIGRATIONS } from "./db-schema.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { TOP_UP_UNKNOWN_ACK_CUTOFF_MS } from "./org-top-up.ts";
import type { Clock, Row, Sql } from "./ports.ts";
import type { StripeBillingClient, StripeBillingObject } from "./stripe-billing-client.ts";
import {
  createStripeCustomerCustody,
  verifyStripeCustomerBinding,
} from "./stripe-customer-custody.ts";

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SESSION = /^cs_[A-Za-z0-9_]{1,240}$/u;
const INTENT = /^seti_[A-Za-z0-9_]{1,240}$/u;
const PAYMENT_METHOD = /^pm_[A-Za-z0-9_]{1,240}$/u;
const METADATA_KEYS = [
  "organizationId",
  "reference",
  "fingerprint",
  "setupDisclosureRevision",
  "stripeAccountId",
  "financialRealm",
  "billingAuthority",
] as const;

export class StripeCardSetupError extends Error {
  constructor(
    readonly code: "invalid_argument" | "conflict" | "unavailable" | "reconciliation_required",
  ) {
    super(code);
    this.name = "StripeCardSetupError";
  }
}
function fail(code: StripeCardSetupError["code"]): never {
  throw new StripeCardSetupError(code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("conflict");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(result).length !== keys.length ||
    Reflect.ownKeys(result).some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(result, key) ?? {}, "value"))
  )
    fail("invalid_argument");
  return result;
}
const nullable = (value: unknown): string | null => (value == null ? null : String(value));
const id = (value: unknown): unknown =>
  value == null || typeof value === "string" ? value : record(value).id;
function noConnect(remote: Record<string, unknown>): void {
  if (
    ["application", "on_behalf_of", "transfer_data", "account"].some((key) => remote[key] != null)
  )
    fail("conflict");
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("conflict");
  return value;
}

export interface BeginStripeCardSetup {
  readonly organizationId: string;
  readonly reference: string;
  readonly authorizedPrincipal: string;
  readonly setupDisclosureRevision: string;
}
/** Safe for wallet:read. This records setup history, never charging consent. */
export interface StripeCardSetupReceipt {
  readonly reference: string;
  readonly state:
    | "awaiting-customer"
    | "prepared"
    | "pending"
    | "original-known"
    | "succeeded"
    | "canceled"
    | "abandoned";
  readonly setupDisclosureRevision: string;
  readonly sessionExpired: boolean;
  readonly observedAt: string | null;
}
/** Only an authenticated payments:write begin/replay may request this action. */
export interface StripeCardSetupBeginResult {
  readonly receipt: StripeCardSetupReceipt;
  readonly checkout: { readonly url: string } | null;
}
/** A local selector, not a native card qualification or merchant consent proof. */
export interface StripeCardSetupSelection {
  readonly organizationId: string;
  readonly customerId: string;
  readonly setupIntentId: string;
  readonly paymentMethodId: string;
}
export interface StripeCardSetupOptions {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly explicitReturnUrls: {
    readonly successUrl: string;
    readonly cancelUrl: string;
  };
}

/** No repair, DDL execution or inferred compatibility: exact registered owning SQL. */
export async function assertStripeCardSetupSchema(sql: Sql): Promise<void> {
  const migration = MIGRATIONS.find((item) => item.name.startsWith("0100_"));
  if (!migration) fail("unavailable");
  const objects = [
    ["table", "stripe_billing_card_setup_commands"],
    ["table", "stripe_billing_card_setup_results"],
    ["index", "stripe_billing_card_setup_terminal_result"],
    ...[
      "commands_insert",
      "commands_no_replace",
      "commands_no_delete",
      "commands_transition",
      "commands_foreign_pin",
      "results_original",
      "results_no_replace",
      "results_no_update",
      "results_no_delete",
    ].map((suffix) => ["trigger", `stripe_billing_card_setup_${suffix}`]),
  ];
  const normalize = (value: string) => value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");
  for (const [type, name] of objects) {
    const pattern =
      type === "table"
        ? `CREATE TABLE ${name}\\s*\\([\\s\\S]*?\\n\\);`
        : type === "index"
          ? `CREATE UNIQUE INDEX ${name}\\b[^;]*;`
          : `CREATE TRIGGER ${name}\\b[\\s\\S]*?\\bEND\\s*;`;
    const expected = migration.sql.match(new RegExp(pattern, "u"))?.[0];
    const actual = (
      await sql.query("SELECT sql FROM sqlite_schema WHERE type=? AND name=?", [
        type ?? "",
        name ?? "",
      ])
    )[0]?.sql;
    if (!expected || typeof actual !== "string" || normalize(actual) !== normalize(expected))
      fail("unavailable");
  }
}

/**
 * One metadata-only setup command. Customer creation belongs to the existing
 * custody; only the acknowledged first-dispatch CAS winner may create a Session.
 */
export function createStripeCardSetup(options: StripeCardSetupOptions) {
  const { sql, clock, client, realm } = options;
  const urls = exact(options.explicitReturnUrls, ["successUrl", "cancelUrl"]);
  const successUrl = returnUrl(urls.successUrl),
    cancelUrl = returnUrl(urls.cancelUrl);
  if (new URL(successUrl).origin !== new URL(cancelUrl).origin) fail("invalid_argument");
  const qualified = () =>
    assertHostedBillingFinancialRealm(realm, {
      sql,
      client,
      billingAuthority: realm.billingAuthority,
    });
  qualified();
  const customerCustody = createStripeCustomerCustody({ sql, clock, client, realm });
  const now = () => instant(clock().toISOString());
  let schema: Promise<void> | undefined;
  const ready = () => (schema ??= assertStripeCardSetupSchema(sql));
  function returnUrl(value: unknown): string {
    if (typeof value !== "string" || value.length > 2048) fail("invalid_argument");
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
        fail("invalid_argument");
      if ([...parsed.searchParams.keys()].some((key) => /secret|token/iu.test(key)))
        fail("invalid_argument");
    } catch {
      fail("invalid_argument");
    }
    return value;
  }
  function scope(org: string, reference: string): void {
    if (
      typeof org !== "string" ||
      !REFERENCE.test(org) ||
      typeof reference !== "string" ||
      !REFERENCE.test(reference)
    )
      fail("invalid_argument");
  }
  function metadata(row: Row): Record<string, string> {
    return {
      organizationId: String(row.org_id),
      reference: String(row.reference),
      fingerprint: String(row.fingerprint),
      setupDisclosureRevision: String(row.disclosure_revision),
      stripeAccountId: String(row.account_id),
      financialRealm: String(row.financial_realm),
      billingAuthority: String(row.billing_authority),
    };
  }
  function template(row: Row) {
    const meta = metadata(row);
    return {
      mode: "setup",
      success_url: String(row.success_return_url),
      cancel_url: String(row.cancel_return_url),
      payment_method_types: ["card"],
      metadata: meta,
      setup_intent_data: { metadata: meta },
    };
  }
  function identity(row: Row) {
    return {
      organizationId: row.org_id,
      reference: row.reference,
      authorizedPrincipal: row.authorized_principal,
      setupDisclosureRevision: row.disclosure_revision,
      accountId: row.account_id,
      mode: row.mode,
      financialRealm: row.financial_realm,
      billingAuthority: row.billing_authority,
      flowKind: row.flow_kind,
      successUrl: row.success_return_url,
      cancelUrl: row.cancel_return_url,
    };
  }
  async function command(org: string, reference: string): Promise<Row | null> {
    const row = (
      await sql.query(
        "SELECT * FROM stripe_billing_card_setup_commands WHERE org_id=? AND reference=?",
        [org, reference],
      )
    )[0];
    if (!row) return null;
    if (
      row.org_id !== org ||
      row.reference !== reference ||
      row.account_id !== realm.accountId ||
      row.mode !== realm.mode ||
      row.financial_realm !== realm.financialRealm ||
      row.billing_authority !== realm.billingAuthority ||
      row.flow_kind !== "checkout-setup" ||
      row.fingerprint !== (await canonicalDigest(identity(row))) ||
      row.stripe_key !== `takos-card-setup-${String(row.fingerprint).slice(7)}` ||
      row.request_json !== canonicalJson(template(row))
    )
      fail("conflict");
    return row;
  }
  async function results(row: Row): Promise<readonly Row[]> {
    return await sql.query(
      "SELECT * FROM stripe_billing_card_setup_results WHERE org_id=? AND reference=? ORDER BY sequence",
      [String(row.org_id), String(row.reference)],
    );
  }
  async function receipt(row: Row): Promise<StripeCardSetupReceipt> {
    const history = await results(row);
    const terminal = history.find((item) => item.kind !== "session-expiry");
    if (
      row.state === "verified" &&
      (!terminal ||
        terminal.sequence !== row.result_sequence ||
        terminal.setup_outcome !== row.native_outcome ||
        terminal.session_id !== row.session_id ||
        terminal.setup_intent_id !== row.setup_intent_id ||
        terminal.customer_id !== row.customer_id ||
        terminal.observed_at !== row.terminal_at)
    )
      fail("conflict");
    return Object.freeze({
      reference: String(row.reference),
      state:
        row.state === "verified"
          ? (row.native_outcome as "succeeded" | "canceled")
          : row.state === "dispatched"
            ? "pending"
            : (row.state as StripeCardSetupReceipt["state"]),
      setupDisclosureRevision: String(row.disclosure_revision),
      sessionExpired: history.some((item) => item.session_expired === 1),
      observedAt: nullable(history.at(-1)?.observed_at),
    });
  }
  function assertMetadata(value: unknown, row: Row): void {
    const actual = record(value),
      expected = metadata(row);
    if (
      Object.keys(actual).length !== METADATA_KEYS.length ||
      METADATA_KEYS.some((key) => actual[key] !== expected[key])
    )
      fail("conflict");
  }
  function assertSession(remote: StripeBillingObject, row: Row): void {
    noConnect(remote);
    assertMetadata(remote.metadata, row);
    if (
      !SESSION.test(remote.id) ||
      (row.session_id !== null && remote.id !== row.session_id) ||
      remote.object !== "checkout.session" ||
      remote.mode !== "setup" ||
      remote.livemode !== realm.livemode ||
      id(remote.customer) !== row.customer_id ||
      remote.success_url !== row.success_return_url ||
      remote.cancel_url !== row.cancel_return_url ||
      canonicalJson(remote.payment_method_types) !== canonicalJson(["card"]) ||
      !["open", "complete", "expired"].includes(String(remote.status)) ||
      remote.payment_intent != null ||
      remote.subscription != null ||
      remote.invoice != null ||
      remote.amount_total != null ||
      remote.amount_subtotal != null ||
      !Number.isSafeInteger(remote.created) ||
      Number(remote.created) < Math.floor(Date.parse(String(row.dispatched_at)) / 1000) - 300 ||
      Number(remote.created) >
        Math.ceil(Date.parse(String(row.dispatched_at)) / 1000) +
          TOP_UP_UNKNOWN_ACK_CUTOFF_MS / 1000 ||
      (remote.setup_intent != null &&
        (typeof id(remote.setup_intent) !== "string" ||
          !INTENT.test(String(id(remote.setup_intent))))) ||
      (row.setup_intent_id !== null && id(remote.setup_intent) !== row.setup_intent_id) ||
      (remote.status === "complete" && remote.setup_intent == null)
    )
      fail("conflict");
  }
  async function pin(row: Row, session: StripeBillingObject): Promise<Row> {
    assertSession(session, row);
    const intentId = nullable(id(session.setup_intent));
    try {
      await sql.run(
        `UPDATE stripe_billing_card_setup_commands SET state='original-known',session_id=?,setup_intent_id=?
        WHERE org_id=? AND reference=? AND state IN ('dispatched','original-known')
        AND (session_id IS NULL OR session_id=?) AND (setup_intent_id IS NULL OR setup_intent_id=?)`,
        [session.id, intentId, String(row.org_id), String(row.reference), session.id, intentId],
      );
    } catch {
      const saved = await command(String(row.org_id), String(row.reference));
      if (!saved || saved.session_id !== session.id || saved.setup_intent_id !== intentId)
        fail("conflict");
    }
    const saved = await command(String(row.org_id), String(row.reference));
    if (!saved || saved.session_id !== session.id || saved.setup_intent_id !== intentId)
      fail("conflict");
    return saved;
  }
  async function observe(row: Row, session: StripeBillingObject): Promise<Row> {
    row = await pin(row, session);
    if (row.state === "verified") return row;
    const observedAt = now();
    const flags = {
      realmMatched: true,
      customerMatched: true,
      originalCommandMatched: true,
      sessionLinkMatched: true,
    };
    let history = await results(row);
    if (session.status === "expired" && !history.some((item) => item.kind === "session-expiry")) {
      try {
        await sql.run(
          `INSERT INTO stripe_billing_card_setup_results
          (org_id,reference,sequence,kind,customer_id,session_id,setup_intent_id,payment_method_id,usage,session_expired,setup_outcome,source_confirmed_json,no_effect_json,observed_at,command_state)
          VALUES (?,?,?,'session-expiry',?,?,?,NULL,NULL,1,NULL,?,NULL,?,NULL)`,
          [
            String(row.org_id),
            String(row.reference),
            history.length + 1,
            String(row.customer_id),
            String(row.session_id),
            nullable(row.setup_intent_id),
            canonicalJson(flags),
            observedAt,
          ],
        );
      } catch {
        history = await results(row);
        if (!history.some((item) => item.kind === "session-expiry")) fail("unavailable");
      }
    }
    if (row.setup_intent_id === null) return row;
    const intent = await client.get("setup_intents", String(row.setup_intent_id));
    if (!intent) return row;
    noConnect(intent);
    assertMetadata(intent.metadata, row);
    if (
      intent.id !== row.setup_intent_id ||
      intent.object !== "setup_intent" ||
      intent.livemode !== realm.livemode ||
      id(intent.customer) !== row.customer_id ||
      intent.usage !== "off_session" ||
      canonicalJson(intent.payment_method_types) !== canonicalJson(["card"]) ||
      ![
        "requires_payment_method",
        "requires_confirmation",
        "requires_action",
        "processing",
        "succeeded",
        "canceled",
      ].includes(String(intent.status))
    )
      fail("conflict");
    if (intent.status !== "succeeded" && intent.status !== "canceled") return row;
    const paymentMethodId = nullable(id(intent.payment_method));
    if (
      (intent.status === "succeeded" && paymentMethodId === null) ||
      (paymentMethodId !== null && !PAYMENT_METHOD.test(paymentMethodId))
    )
      fail("conflict");
    history = await results(row);
    const sequence = history.length + 1;
    try {
      await sql.batch([
        {
          sql: `INSERT INTO stripe_billing_card_setup_results
          (org_id,reference,sequence,kind,customer_id,session_id,setup_intent_id,payment_method_id,usage,session_expired,setup_outcome,source_confirmed_json,no_effect_json,observed_at,command_state)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,'verified')`,
          params: [
            String(row.org_id),
            String(row.reference),
            sequence,
            `setup-${intent.status}`,
            String(row.customer_id),
            String(row.session_id),
            String(row.setup_intent_id),
            paymentMethodId,
            "off_session",
            session.status === "expired" ? 1 : 0,
            intent.status,
            canonicalJson({ ...flags, setupIntentTerminalMatched: true }),
            observedAt,
          ],
        },
        {
          sql: `UPDATE stripe_billing_card_setup_commands SET state='verified',result_sequence=?,native_outcome=?,terminal_at=?
          WHERE org_id=? AND reference=? AND state='original-known' AND session_id=? AND setup_intent_id=?`,
          params: [
            sequence,
            intent.status,
            observedAt,
            String(row.org_id),
            String(row.reference),
            String(row.session_id),
            String(row.setup_intent_id),
          ],
        },
      ]);
    } catch {
      const saved = await command(String(row.org_id), String(row.reference));
      if (saved?.state !== "verified" || saved.native_outcome !== intent.status)
        fail("unavailable");
    }
    return (await command(String(row.org_id), String(row.reference))) ?? fail("unavailable");
  }
  async function recover(row: Row): Promise<Row> {
    if (!["dispatched", "original-known"].includes(String(row.state))) return row;
    await verifyStripeCustomerBinding(
      { sql, client, realm },
      String(row.org_id),
      String(row.customer_id),
    );
    let session: StripeBillingObject | null = null;
    if (row.session_id !== null)
      session = await client.get("checkout/sessions", String(row.session_id));
    else {
      let after: string | undefined;
      let closed = false;
      const seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const listed = await client.list("checkout/sessions", {
          customer: String(row.customer_id),
          createdGte: Math.max(0, Math.floor(Date.parse(String(row.dispatched_at)) / 1000) - 300),
          createdLte:
            Math.ceil(Date.parse(String(row.dispatched_at)) / 1000) +
            TOP_UP_UNKNOWN_ACK_CUTOFF_MS / 1000,
          limit: 100,
          ...(after ? { startingAfter: after } : {}),
        });
        for (const candidate of listed.data) {
          if (!SESSION.test(candidate.id) || seen.has(candidate.id))
            fail("reconciliation_required");
          seen.add(candidate.id);
          const meta = record(candidate.metadata ?? {});
          if (
            meta.fingerprint === row.fingerprint ||
            (meta.organizationId === row.org_id && meta.reference === row.reference)
          ) {
            assertSession(candidate, row);
            if (session !== null) fail("reconciliation_required");
            session = candidate;
          }
        }
        if (!listed.hasMore) {
          closed = true;
          break;
        }
        after = listed.data.at(-1)?.id;
        if (!after) fail("reconciliation_required");
      }
      if (!closed) fail("reconciliation_required");
      if (session !== null) session = await client.get("checkout/sessions", session.id);
    }
    if (session === null) {
      if (Date.parse(now()) - Date.parse(String(row.dispatched_at)) >= TOP_UP_UNKNOWN_ACK_CUTOFF_MS)
        fail("reconciliation_required");
      return row;
    }
    return await observe(row, session);
  }
  async function action(row: Row): Promise<{ readonly url: string } | null> {
    if (row.state !== "original-known" || row.session_id === null) return null;
    await verifyStripeCustomerBinding(
      { sql, client, realm },
      String(row.org_id),
      String(row.customer_id),
    );
    const session = await client.get("checkout/sessions", String(row.session_id));
    if (!session) return null;
    assertSession(session, row);
    if (session.status !== "open" || session.url == null) return null;
    if (typeof session.url !== "string" || session.url.length > 8192) fail("conflict");
    const url = new URL(session.url);
    if (
      url.origin !== "https://checkout.stripe.com" ||
      !url.pathname.startsWith("/c/") ||
      url.username ||
      url.password
    )
      fail("conflict");
    return Object.freeze({ url: session.url });
  }
  async function safe<T>(run: () => Promise<T>): Promise<T> {
    try {
      qualified();
      await ready();
      return await run();
    } catch (error) {
      if (error instanceof StripeCardSetupError) throw error;
      fail("unavailable");
    }
  }
  return Object.freeze({
    async begin(input: BeginStripeCardSetup): Promise<StripeCardSetupBeginResult> {
      return await safe(async () => {
        exact(input, [
          "organizationId",
          "reference",
          "authorizedPrincipal",
          "setupDisclosureRevision",
        ]);
        input = Object.freeze({ ...input });
        scope(input.organizationId, input.reference);
        if (
          typeof input.authorizedPrincipal !== "string" ||
          !PRINCIPAL.test(input.authorizedPrincipal) ||
          typeof input.setupDisclosureRevision !== "string" ||
          !REVISION.test(input.setupDisclosureRevision)
        )
          fail("invalid_argument");
        let row = await command(input.organizationId, input.reference);
        if (!row) {
          if (!(await sql.query("SELECT 1 FROM orgs WHERE id=?", [input.organizationId])).length)
            fail("invalid_argument");
          const proposed: Row = {
            org_id: input.organizationId,
            reference: input.reference,
            authorized_principal: input.authorizedPrincipal,
            disclosure_revision: input.setupDisclosureRevision,
            account_id: realm.accountId,
            mode: realm.mode,
            financial_realm: realm.financialRealm,
            billing_authority: realm.billingAuthority,
            flow_kind: "checkout-setup",
            success_return_url: successUrl,
            cancel_return_url: cancelUrl,
          };
          proposed.fingerprint = await canonicalDigest(identity(proposed));
          try {
            await sql.run(
              `INSERT INTO stripe_billing_card_setup_commands
              (org_id,reference,authorized_principal,fingerprint,disclosure_revision,account_id,mode,financial_realm,billing_authority,flow_kind,success_return_url,cancel_return_url,request_json,stripe_key,created_at,state)
              VALUES(?,?,?,?,?,?,?,?,?,'checkout-setup',?,?,?,?,?,'awaiting-customer')`,
              [
                input.organizationId,
                input.reference,
                input.authorizedPrincipal,
                String(proposed.fingerprint),
                input.setupDisclosureRevision,
                realm.accountId,
                realm.mode,
                realm.financialRealm,
                realm.billingAuthority,
                successUrl,
                cancelUrl,
                canonicalJson(template(proposed)),
                `takos-card-setup-${String(proposed.fingerprint).slice(7)}`,
                now(),
              ],
            );
          } catch {
            if (!(await command(input.organizationId, input.reference))) fail("unavailable");
          }
          row = await command(input.organizationId, input.reference);
        }
        if (!row) fail("unavailable");
        if (
          row.authorized_principal !== input.authorizedPrincipal ||
          row.disclosure_revision !== input.setupDisclosureRevision
        )
          fail("conflict");
        if (row.state === "awaiting-customer") {
          const customerId = await customerCustody.ensure(input.organizationId);
          await sql.run(
            "UPDATE stripe_billing_card_setup_commands SET customer_id=?,state='prepared' WHERE org_id=? AND reference=? AND state='awaiting-customer'",
            [customerId, input.organizationId, input.reference],
          );
          row = (await command(input.organizationId, input.reference)) ?? fail("unavailable");
        }
        if (row.state === "prepared") {
          await verifyStripeCustomerBinding(
            { sql, client, realm },
            input.organizationId,
            String(row.customer_id),
          );
          const nonce = crypto.randomUUID(),
            at = now();
          let won = false;
          try {
            const claim = await sql.run(
              `UPDATE stripe_billing_card_setup_commands SET state='dispatched',dispatch_nonce=?,dispatched_at=?
                WHERE org_id=? AND reference=? AND state='prepared' AND EXISTS
                (SELECT 1 FROM stripe_billing_customers WHERE org_id=? AND customer_id=?)`,
              [
                nonce,
                at,
                input.organizationId,
                input.reference,
                input.organizationId,
                String(row.customer_id),
              ],
            );
            const saved = await command(input.organizationId, input.reference);
            won =
              claim.changes === 1 &&
              saved?.state === "dispatched" &&
              saved.dispatch_nonce === nonce &&
              saved.dispatched_at === at;
          } catch {
            /* Uncertain DB ACK: original GET/list recovery only, never POST. */
          }
          row = (await command(input.organizationId, input.reference)) ?? fail("unavailable");
          if (won) {
            const form: Record<string, string> = {
              mode: "setup",
              customer: String(row.customer_id),
              success_url: String(row.success_return_url),
              cancel_url: String(row.cancel_return_url),
              "payment_method_types[0]": "card",
            };
            for (const [key, value] of Object.entries(metadata(row))) {
              form[`metadata[${key}]`] = value;
              form[`setup_intent_data[metadata][${key}]`] = value;
            }
            let remote: StripeBillingObject | null = null;
            try {
              remote = await client.post("checkout/sessions", {
                form,
                idempotencyKey: String(row.stripe_key),
              });
            } catch {
              /* Preserve dispatched even when no original is immediately discoverable. */
            }
            if (remote) row = await observe(row, remote);
          }
        }
        row = await recover(row);
        return { receipt: await receipt(row), checkout: await action(row) };
      });
    },
    async read(organizationId: string, reference: string): Promise<StripeCardSetupReceipt | null> {
      return await safe(async () => {
        scope(organizationId, reference);
        const row = await command(organizationId, reference);
        return row ? await receipt(row) : null;
      });
    },
    async recoverOriginal(
      organizationId: string,
      reference: string,
    ): Promise<StripeCardSetupReceipt | null> {
      return await safe(async () => {
        scope(organizationId, reference);
        const row = await command(organizationId, reference);
        return row ? await receipt(await recover(row)) : null;
      });
    },
    async readSelection(
      organizationId: string,
      reference: string,
    ): Promise<StripeCardSetupSelection | null> {
      return await safe(async () => {
        scope(organizationId, reference);
        const row = await command(organizationId, reference);
        if (row?.state !== "verified" || row.native_outcome !== "succeeded") return null;
        await receipt(row);
        const result = (await results(row)).find((item) => item.kind === "setup-succeeded");
        if (!result || !PAYMENT_METHOD.test(String(result.payment_method_id))) fail("conflict");
        return Object.freeze({
          organizationId,
          customerId: String(row.customer_id),
          setupIntentId: String(row.setup_intent_id),
          paymentMethodId: String(result.payment_method_id),
        });
      });
    },
  });
}
