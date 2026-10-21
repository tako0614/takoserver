/** Read-only collection of saved TEST Stripe GET data and selected D1 rows. */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import {
  createStripeBillingClient,
  type StripeBillingClient,
} from "../src/stripe-billing-client.ts";
import { type D1Process, RemoteD1, sqlLiteral } from "./deploy/d1.ts";
import { cloudflareChildEnvironment, requireEnvironment } from "./deploy/process.ts";
import { loadTarget } from "./deploy/target.ts";
import {
  assertBusinessSourceHead,
  assertStagingTarget,
  parseBusinessInput,
  privateEvidenceParent,
  readCompleteBusinessJournalBinding,
  readPrivateFile,
} from "./hosted-billing-business-e2e.ts";

const EVENT = /^evt_[A-Za-z0-9_]{1,240}$/u;
type Row = Record<string, unknown>;

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("collected billing data has invalid object");
  return value as Row;
}

function same(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error("collected billing data differs from selected original");
}

function absent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("private evidence output already exists");
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function one(rows: readonly Row[], name: string): Row {
  if (rows.length !== 1) throw new Error(`selected ${name} read is absent or ambiguous`);
  return record(rows[0]);
}

function canonicalInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("selected Stripe event receipt has invalid timestamp");
  return value;
}

function selectedReceipt(row: Row, event: Row, type: string, outcome: string, detail: string): Row {
  same(row.event_id, event.id);
  same(row.type, type);
  same(row.livemode, 0);
  same(row.outcome, outcome);
  same(row.outcome_detail, detail);
  const object = record(record(event.data).object);
  same(row.object_id, object.id);
  same(row.event_created_at, new Date((event.created as number) * 1000).toISOString());
  const received = canonicalInstant(row.received_at);
  const settled = canonicalInstant(row.settled_at);
  if (settled < received) throw new Error("selected Stripe event receipt has no valid settlement");
  return object;
}

function projectedEvent(
  eventValue: unknown,
  id: string,
  type: "checkout.session.completed" | "invoice.paid",
): Row {
  const event = record(eventValue);
  same(event.id, id);
  same(event.type, type);
  same(event.livemode, false);
  if (event.account !== undefined && event.account !== null)
    throw new Error("connected Stripe event refused");
  if (!Number.isSafeInteger(event.created) || (event.created as number) <= 0)
    throw new Error("invalid Stripe event time");
  const source = record(record(event.data).object);
  same(source.livemode, false);
  const object =
    type === "invoice.paid"
      ? {
          object: source.object,
          id: source.id,
          livemode: source.livemode,
          status: source.status,
          paid: source.paid,
          subscription: source.subscription,
          customer: source.customer,
          subscription_details: {
            metadata: {
              takoserverPurpose: record(record(source.subscription_details).metadata)
                .takoserverPurpose,
              organizationId: record(record(source.subscription_details).metadata).organizationId,
              planKey: record(record(source.subscription_details).metadata).planKey,
              pricingRevision: record(record(source.subscription_details).metadata).pricingRevision,
            },
          },
        }
      : {
          object: source.object,
          id: source.id,
          livemode: source.livemode,
          mode: source.mode,
          status: source.status,
          payment_status: source.payment_status,
          currency: source.currency,
          amount_total: source.amount_total,
          customer: source.customer,
          metadata: {
            organizationId: record(source.metadata).organizationId,
            topUpReference: record(source.metadata).topUpReference,
            stripeAccountId: record(source.metadata).stripeAccountId,
            takoserverPurpose: record(source.metadata).takoserverPurpose,
            financialRealm: record(source.metadata).financialRealm,
            pricingRevision: record(source.metadata).pricingRevision,
            purchaseCreditExpiry: record(source.metadata).purchaseCreditExpiry,
            topUpCommandDigest: record(source.metadata).topUpCommandDigest,
          },
        };
  const nested = record(object).metadata ?? record(record(object).subscription_details).metadata;
  if (
    Object.values(object).some((value) => value === undefined) ||
    Object.values(record(nested)).some((value) => value === undefined)
  )
    throw new Error("Stripe event lacks required projected fields");
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    created: event.created,
    ...(event.account === undefined ? {} : { account: event.account }),
    data: { object },
  };
}

export interface CollectOptions {
  readonly environment: "integration" | "rehearsal";
  readonly targetPath: string;
  readonly inputPath: string;
  readonly journalPath: string;
  readonly outputPath: string;
  readonly topUpEventId: string;
  readonly invoiceEventId: string;
}

/** Injection is only for local DATA tests; ordinary CLI uses existing provider clients. */
export interface CollectPorts {
  readonly d1Run?: D1Process;
  readonly wranglerCommand?: (args: readonly string[]) => readonly string[];
  readonly stripeFetch?: (request: Request) => Promise<Response>;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly stripeSecretKey?: string;
}

export async function collectServiceReceipts(
  options: CollectOptions,
  ports: CollectPorts = {},
): Promise<void> {
  if (options.environment !== "integration" && options.environment !== "rehearsal")
    throw new Error("production collection refused");
  if (
    !EVENT.test(options.topUpEventId) ||
    !EVENT.test(options.invoiceEventId) ||
    options.topUpEventId === options.invoiceEventId
  )
    throw new Error("two distinct original Stripe event IDs are required");
  const parent = privateEvidenceParent(options.outputPath);
  const metadataPath = `${options.outputPath}.metadata.json`;
  privateEvidenceParent(metadataPath);
  absent(options.outputPath);
  absent(metadataPath);
  const targetRaw = readPrivateFile(options.targetPath);
  const target = loadTarget(options.targetPath, options.environment);
  same(readPrivateFile(options.targetPath), targetRaw);
  const origin = assertStagingTarget(target);
  const stripeAccountId = target.hostedBilling?.accountId;
  if (!stripeAccountId) throw new Error("selected Stripe TEST account missing");
  const inputRaw = readPrivateFile(options.inputPath);
  const input = parseBusinessInput(inputRaw);
  const targetSha256 = `sha256:${sha(targetRaw)}`;
  same(input.targetSha256, targetSha256);
  assertBusinessSourceHead(input);
  const journalRaw = readPrivateFile(options.journalPath);
  const organizationId = readCompleteBusinessJournalBinding({
    journalPath: options.journalPath,
    inputRaw,
    targetSha256,
    origin,
  });
  same(readPrivateFile(options.journalPath), journalRaw);
  if (existsSync(`${options.journalPath}.lock`)) throw new Error("original journal is in use");
  const temporary = mkdtempSync(join(parent, ".billing-collect-"));
  let linkedMetadata = false;
  let linkedEvidence = false;
  try {
    const configPath = join(temporary, "wrangler.jsonc");
    const configRaw = `${JSON.stringify(
      {
        name: target.workerName,
        account_id: target.accountId,
        compatibility_date: "2026-08-17",
        d1_databases: [
          {
            binding: "STATE_DB",
            database_name: target.d1.databaseName,
            database_id: target.d1.databaseId,
          },
        ],
      },
      null,
      2,
    )}\n`;
    writeFileSync(configPath, configRaw, { flag: "wx", mode: 0o600 });
    syncFile(configPath);
    const unchanged = (): void => {
      same(readPrivateFile(options.targetPath), targetRaw);
      same(readPrivateFile(options.inputPath), inputRaw);
      same(readPrivateFile(options.journalPath), journalRaw);
      same(readPrivateFile(configPath), configRaw);
      assertBusinessSourceHead(input);
      absent(options.outputPath);
      absent(metadataPath);
    };
    const database = new RemoteD1(configPath, {
      environment: ports.cloudflareEnvironment ?? cloudflareChildEnvironment(),
      ...(ports.d1Run ? { run: ports.d1Run } : {}),
      ...(ports.wranglerCommand ? { wranglerCommand: ports.wranglerCommand } : {}),
    });
    const stripe: StripeBillingClient = createStripeBillingClient({
      secretKey: ports.stripeSecretKey ?? requireEnvironment("STRIPE_SECRET_KEY"),
      mode: "test",
      ...(ports.stripeFetch ? { fetch: ports.stripeFetch } : {}),
    });
    const query = async (name: string, sql: string): Promise<Row> => {
      unchanged();
      const row = one(await database.query("verification", name, sql), name);
      unchanged();
      return row;
    };
    const intentKey = sha(canonicalJson([organizationId, input.subscription.reference]));
    const subscriptionIntent = await query(
      "original subscription intent",
      `SELECT id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,session_id,subscription_id FROM stripe_subscription_checkout_intents WHERE org_id = ${sqlLiteral(organizationId)} AND request_key_digest = ${sqlLiteral(intentKey)} LIMIT 2`,
    );
    same(subscriptionIntent.state, "associated");
    const subscriptionId = subscriptionIntent.subscription_id;
    if (typeof subscriptionId !== "string" || !/^sub_[A-Za-z0-9_]{1,240}$/u.test(subscriptionId))
      throw new Error("original subscription association is unresolved");
    const subscriptionAssociation = await query(
      "original subscription association",
      `SELECT subscription_id,org_id,customer_id,livemode,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,session_id FROM stripe_billing_associations WHERE subscription_id = ${sqlLiteral(subscriptionId)} LIMIT 2`,
    );
    same(subscriptionAssociation.session_id, subscriptionIntent.session_id);
    same(subscriptionAssociation.org_id, organizationId);
    const topUpCommand = await query(
      "original top-up command",
      `SELECT org_id,reference,command_json,state,session_id,session_url FROM stripe_top_up_commands WHERE org_id = ${sqlLiteral(organizationId)} AND reference = ${sqlLiteral(input.topup.reference)} LIMIT 2`,
    );
    same(topUpCommand.state, "paid");
    const eventRow = async (id: string, name: string): Promise<Row> =>
      await query(
        name,
        `SELECT event_id,type,livemode,object_id,event_created_at,received_at,outcome,outcome_detail,settled_at FROM stripe_events WHERE event_id = ${sqlLiteral(id)} LIMIT 2`,
      );
    const topUpServiceReceipt = await eventRow(options.topUpEventId, "top-up Stripe event receipt");
    const invoiceServiceReceipt = await eventRow(
      options.invoiceEventId,
      "invoice Stripe event receipt",
    );
    unchanged();
    const authenticatedStripeAccount = await stripe.authenticAccount?.();
    if (!authenticatedStripeAccount) throw new Error("Stripe TEST account read unavailable");
    same(authenticatedStripeAccount.id, stripeAccountId);
    if (authenticatedStripeAccount.livemode !== undefined)
      same(authenticatedStripeAccount.livemode, false);
    unchanged();
    const retrieve = async (
      id: string,
      type: "checkout.session.completed" | "invoice.paid",
    ): Promise<{ event: Row; requestId: string | null }> => {
      unchanged();
      const got = await stripe.get("events", id);
      if (!got) throw new Error("original Stripe TEST event absent");
      const event = projectedEvent(got, id, type);
      unchanged();
      const requestId = record(got.request ?? {}).id;
      return { event, requestId: typeof requestId === "string" ? requestId : null };
    };
    const topUp = await retrieve(options.topUpEventId, "checkout.session.completed");
    const invoice = await retrieve(options.invoiceEventId, "invoice.paid");
    same(subscriptionIntent.org_id, organizationId);
    same(subscriptionIntent.request_key_digest, intentKey);
    same(subscriptionIntent.plan_key, input.subscription.planKey);
    same(subscriptionIntent.livemode, 0);
    same(
      subscriptionIntent.fingerprint,
      sha(
        canonicalJson([
          organizationId,
          input.subscription.planKey,
          subscriptionIntent.pricing_revision,
          subscriptionIntent.price_id,
          subscriptionIntent.price_amount_minor,
          subscriptionIntent.included_minor,
          false,
          "subscription",
        ]),
      ),
    );
    for (const field of [
      "customer_id",
      "livemode",
      "plan_key",
      "pricing_revision",
      "price_id",
      "price_amount_minor",
      "included_minor",
      "session_id",
    ])
      same(subscriptionAssociation[field], subscriptionIntent[field]);
    same(subscriptionAssociation.subscription_id, subscriptionId);
    const originalTopUp = record(JSON.parse(String(topUpCommand.command_json)));
    same(topUpCommand.org_id, organizationId);
    same(topUpCommand.reference, input.topup.reference);
    same(originalTopUp.organizationId, organizationId);
    same(originalTopUp.reference, input.topup.reference);
    same(originalTopUp.amountMinor, input.topup.amountMinor);
    same(originalTopUp.accountId, stripeAccountId);
    same(originalTopUp.livemode, false);
    same(originalTopUp.amountMicros, input.topup.amountMinor * 10_000);
    same(originalTopUp.currency, "USD");
    same(originalTopUp.purpose, "wallet_funding");
    const topUpObject = selectedReceipt(
      topUpServiceReceipt,
      topUp.event,
      "checkout.session.completed",
      "credited",
      "credited",
    );
    same(topUpObject.object, "checkout.session");
    same(topUpObject.id, topUpCommand.session_id);
    same(topUpObject.customer, originalTopUp.customerId);
    same(topUpObject.amount_total, originalTopUp.amountMinor);
    same(topUpObject.currency, "usd");
    same(topUpObject.mode, "payment");
    same(topUpObject.status, "complete");
    same(topUpObject.payment_status, "paid");
    const topUpMetadata = record(topUpObject.metadata);
    same(topUpMetadata.organizationId, organizationId);
    same(topUpMetadata.topUpReference, input.topup.reference);
    same(topUpMetadata.stripeAccountId, originalTopUp.accountId);
    same(topUpMetadata.takoserverPurpose, originalTopUp.purpose);
    same(topUpMetadata.financialRealm, originalTopUp.financialRealm);
    same(topUpMetadata.pricingRevision, originalTopUp.pricingRevision);
    same(topUpMetadata.purchaseCreditExpiry, canonicalJson(originalTopUp.purchaseCreditExpiry));
    same(topUpMetadata.topUpCommandDigest, `sha256:${sha(canonicalJson(originalTopUp))}`);
    const invoiceObject = selectedReceipt(
      invoiceServiceReceipt,
      invoice.event,
      "invoice.paid",
      "applied",
      "invoice_credit_granted",
    );
    same(invoiceObject.object, "invoice");
    same(invoiceObject.status, "paid");
    same(invoiceObject.paid, true);
    same(invoiceObject.subscription, subscriptionId);
    same(invoiceObject.customer, subscriptionIntent.customer_id);
    const invoiceMetadata = record(record(invoiceObject.subscription_details).metadata);
    same(invoiceMetadata.takoserverPurpose, "hosted_subscription");
    same(invoiceMetadata.organizationId, organizationId);
    same(invoiceMetadata.planKey, input.subscription.planKey);
    same(invoiceMetadata.pricingRevision, subscriptionIntent.pricing_revision);
    const evidence = {
      kind: "takoserver.hosted-billing-service-receipts@v1",
      sourceHead: input.sourceHead,
      targetSha256,
      origin,
      organizationId,
      workerName: target.workerName,
      d1DatabaseId: target.d1.databaseId,
      stripeAccountId,
      subscriptionIntent,
      subscriptionAssociation,
      topUpCommand,
      topUp: { stripeEvent: topUp.event, serviceReceipt: topUpServiceReceipt },
      invoice: { stripeEvent: invoice.event, serviceReceipt: invoiceServiceReceipt },
    };
    const metadata = {
      kind: "takoserver.hosted-billing-service-receipts-collection-metadata@v1",
      scope: "parsed-stripe-GET-and-selected-D1-rows; delivery-and-serving-provenance-unverified",
      observedAt: new Date().toISOString(),
      sourceHead: input.sourceHead,
      targetSha256,
      origin,
      organizationId,
      accountId: target.accountId,
      workerName: target.workerName,
      d1DatabaseName: target.d1.databaseName,
      d1DatabaseId: target.d1.databaseId,
      configSha256: `sha256:${sha(configRaw)}`,
      stripeAccountId,
      authenticatedStripeAccountId: authenticatedStripeAccount.id,
      requestedEventIds: { topUp: options.topUpEventId, invoice: options.invoiceEventId },
      stripeEventCreationRequestIds: { topUp: topUp.requestId, invoice: invoice.requestId },
      credentialEnvironmentNames: ["CLOUDFLARE_API_TOKEN", "STRIPE_SECRET_KEY"],
    };
    unchanged();
    const stagedEvidence = join(temporary, "evidence.json");
    const stagedMetadata = join(temporary, "metadata.json");
    writeFileSync(stagedEvidence, `${JSON.stringify(evidence)}\n`, { flag: "wx", mode: 0o600 });
    writeFileSync(stagedMetadata, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
    syncFile(stagedEvidence);
    syncFile(stagedMetadata);
    unchanged();
    linkSync(stagedMetadata, metadataPath);
    linkedMetadata = true;
    linkSync(stagedEvidence, options.outputPath);
    linkedEvidence = true;
    syncFile(parent);
  } catch (error) {
    if (linkedMetadata && !linkedEvidence) rmSync(metadataPath, { force: true });
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function flags(argv: readonly string[]): Record<string, string> {
  const names = [
    "--environment",
    "--target",
    "--input",
    "--journal",
    "--topup-event",
    "--invoice-event",
    "--output",
  ];
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i],
      value = argv[i + 1];
    if (!name || !names.includes(name) || !value || result[name] !== undefined)
      throw new Error("invalid collector arguments");
    result[name] = value;
  }
  if (Object.keys(result).sort().join("\0") !== [...names].sort().join("\0"))
    throw new Error("collector arguments incomplete");
  return result;
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(
      "bun --no-env-file scripts/hosted-billing-service-receipts-collect.ts --environment integration|rehearsal --target ABS --input ABS --journal ABS --topup-event evt_ID --invoice-event evt_ID --output ABS\n",
    );
    return;
  }
  const args = flags(argv);
  const environment = args["--environment"];
  if (environment !== "integration" && environment !== "rehearsal")
    throw new Error("production collection refused");
  await collectServiceReceipts({
    environment,
    targetPath: args["--target"] ?? "",
    inputPath: args["--input"] ?? "",
    journalPath: args["--journal"] ?? "",
    topUpEventId: args["--topup-event"] ?? "",
    invoiceEventId: args["--invoice-event"] ?? "",
    outputPath: args["--output"] ?? "",
  });
  process.stdout.write(
    "Saved private collected data and metadata beside the selected output locator.\n",
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Billing service receipt collection refused or outcome unknown. No provider mutation was requested.\n",
    );
    process.exitCode = 1;
  });
}
