import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyServiceReceiptEvidence } from "../scripts/hosted-billing-service-receipts.ts";
import {
  type CollectOptions,
  type CollectPorts,
  collectServiceReceipts,
} from "../scripts/hosted-billing-service-receipts-collect.ts";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

const instant = "2026-10-20T00:00:00.000Z";
const created = 1792454400;
const org = "org_original";
const sub = "sub_original";
const customer = "cus_original";
const subSession = "cs_sub_original";
const topSession = "cs_top_original";
const revision = "revision-original";
const price = "price_original";
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "billing-receipt-collect-"));
  chmodSync(dir, 0o700);
  const targetPath = join(dir, "target.json");
  const inputPath = join(dir, "input.json");
  const journalPath = join(dir, "journal.jsonl");
  const outputPath = join(dir, "receipts.json");
  const billingConfig = {
    schemaVersion: 1,
    revision: "deploy-billing-r1",
    effectiveAt: "2026-10-01T00:00:00.000Z",
    currency: "USD",
    holdTtlSeconds: 60,
    freeIncludedMinor: 0,
    purchaseCreditExpiry: { kind: "none" },
    plans: { starter: { includedMinor: 1000, stripePriceId: "price_deployfixture" } },
    meters: { requests: { unit: "request", rate: { numeratorMicros: "10000", denominator: "1" } } },
  };
  const target = {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "a".repeat(32),
    workerName: "takoserver-api-integration",
    d1: {
      databaseName: "takoserver-integration",
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: "takoserver-integration" },
    publicOrigin: "https://api.integration.example.test",
    consoleOrigin: "https://console.example.test",
    signing: { currentKeyId: "integration-fixture" },
    billingConfig,
    hostedPricing: JSON.stringify({
      authoringVersion: 1,
      planIds: { free: "free", subscription: "starter", usage: "usage" },
      billingConfig,
      checkout: { minimumMinor: 50, maximumMinor: 10000 },
      stripeMonthlyReview: {
        starter: { expectedAmountMinor: 1000, currency: "USD", interval: "month" },
      },
    }),
    hostedBilling: {
      selector: "canonical-test",
      stripeMode: "test",
      accountId: "acct_original",
      billingAuthority: "original-authority",
    },
  };
  const targetRaw = `${JSON.stringify(target)}\n`;
  writeFileSync(targetPath, targetRaw, { mode: 0o600 });
  const input = {
    kind: "takoserver.hosted-billing-business-e2e-input@v1" as const,
    sourceHead,
    targetSha256: `sha256:${createHash("sha256").update(targetRaw).digest("hex")}`,
    usage: {
      reference: "usage-original",
      meter: "edge-request",
      quantityUnit: "request",
      quantity: "1",
      periodStart: "2026-10-18T00:00:00.000Z",
      periodEnd: "2026-10-18T01:00:00.000Z",
      pricingRevision: "revision-original",
      expectedMicros: "1",
      measurementFingerprint: "measurement-original",
      workspaceRef: "workspace-original",
    },
    subscription: { reference: "sub-original", planKey: "monthly-original" },
    topup: { reference: "top-original", amountMinor: 500 },
  };
  const inputRaw = JSON.stringify(input);
  writeFileSync(inputPath, inputRaw, { mode: 0o600 });
  const journal = [
    {
      kind: "takoserver.hosted-billing-business-e2e-journal@v1",
      inputSha256: `sha256:${createHash("sha256").update(inputRaw).digest("hex")}`,
      targetSha256: input.targetSha256,
      sourceHead,
      origin: target.publicOrigin,
    },
    { kind: "intent", step: "personal", organizationId: null, body: {} },
    { kind: "ack", step: "personal", organizationId: org },
    { kind: "intent", step: "usage", organizationId: org, body: input.usage },
    { kind: "ack", step: "usage" },
    { kind: "intent", step: "subscription", organizationId: org, body: input.subscription },
    { kind: "ack", step: "subscription" },
    { kind: "intent", step: "topup", organizationId: org, body: input.topup },
    { kind: "ack", step: "topup" },
  ];
  writeFileSync(journalPath, `${journal.map((row) => JSON.stringify(row)).join("\n")}\n`, {
    mode: 0o600,
  });
  const db = new Database(":memory:");
  migrateSqlite(db, { stripeMode: "test" });
  db.exec("PRAGMA foreign_keys=OFF");
  const intentKey = hash([org, input.subscription.reference]);
  const fingerprint = hash([
    org,
    input.subscription.planKey,
    revision,
    price,
    500,
    200,
    false,
    "subscription",
  ]);
  db.query(`INSERT INTO stripe_subscription_checkout_intents
    (id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,
     included_minor,livemode,customer_id,state,session_id,subscription_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,'associated',?,?,?,?)`).run(
    "sci_original",
    org,
    intentKey,
    fingerprint,
    input.subscription.planKey,
    revision,
    price,
    500,
    200,
    customer,
    subSession,
    sub,
    instant,
    instant,
  );
  db.query(`INSERT INTO stripe_billing_associations
    (subscription_id,org_id,customer_id,livemode,plan_key,pricing_revision,price_id,price_amount_minor,
     included_minor,session_id,association_generation,created_at)
    VALUES (?,?,?,0,?,?,?,?,?,?,1,?)`).run(
    sub,
    org,
    customer,
    input.subscription.planKey,
    revision,
    price,
    500,
    200,
    subSession,
    instant,
  );
  const command = {
    customerId: customer,
    accountId: target.hostedBilling.accountId,
    livemode: false,
    financialRealm: "test-original",
    pricingRevision: revision,
    purchaseCreditExpiry: { kind: "none" },
    organizationId: org,
    reference: input.topup.reference,
    amountMinor: 500,
    amountMicros: 5_000_000,
    currency: "USD",
    purpose: "wallet_funding",
    successUrl: `${target.consoleOrigin}/billing?checkout={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${target.consoleOrigin}/billing?checkout=cancelled`,
  };
  db.query(`INSERT INTO stripe_top_up_commands
    (org_id,reference,fingerprint,command_json,stripe_key,state,session_id,session_url,dispatched_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'paid',?,?,?,?,?)`).run(
    org,
    input.topup.reference,
    `sha256:${hash(command)}`,
    JSON.stringify(command),
    "takoserver_topup_fixture",
    topSession,
    "https://checkout.stripe.com/c/pay/original",
    instant,
    instant,
    instant,
  );
  for (const row of [
    ["evt_top_original", "checkout.session.completed", topSession, "credited", "credited"],
    ["evt_invoice_original", "invoice.paid", "in_original", "applied", "invoice_credit_granted"],
  ] as const)
    db.query(`INSERT INTO stripe_events
    (event_id,type,livemode,object_id,event_created_at,received_at,outcome,outcome_detail,settled_at)
    VALUES (?,?,0,?,?,?,?,?,?)`).run(
      row[0],
      row[1],
      row[2],
      instant,
      instant,
      row[3],
      row[4],
      instant,
    );
  const events = {
    evt_top_original: {
      id: "evt_top_original",
      object: "event",
      type: "checkout.session.completed",
      created,
      livemode: false,
      request: { id: "req_top_original" },
      data: {
        object: {
          id: topSession,
          object: "checkout.session",
          livemode: false,
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          currency: "usd",
          amount_total: 500,
          customer,
          metadata: {
            organizationId: org,
            topUpReference: input.topup.reference,
            stripeAccountId: target.hostedBilling.accountId,
            takoserverPurpose: "wallet_funding",
            financialRealm: command.financialRealm,
            pricingRevision: revision,
            purchaseCreditExpiry: canonicalJson(command.purchaseCreditExpiry),
            topUpCommandDigest: `sha256:${hash(command)}`,
          },
          client_secret: "must-not-be-saved",
        },
      },
    },
    evt_invoice_original: {
      id: "evt_invoice_original",
      object: "event",
      type: "invoice.paid",
      created,
      livemode: false,
      request: { id: null },
      data: {
        object: {
          id: "in_original",
          object: "invoice",
          livemode: false,
          status: "paid",
          paid: true,
          subscription: sub,
          customer,
          subscription_details: {
            metadata: {
              takoserverPurpose: "hosted_subscription",
              organizationId: org,
              planKey: input.subscription.planKey,
              pricingRevision: revision,
            },
          },
          client_secret: "must-not-be-saved",
        },
      },
    },
  };
  const d1Commands: string[] = [];
  const stripeRequests: Request[] = [];
  const ports: CollectPorts = {
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "local-d1-test-secret" },
    stripeSecretKey: "sk_test_local_fixture",
    wranglerCommand: (args) => args,
    d1Run: async (args, options) => {
      const commandIndex = args.indexOf("--command");
      const sql = args[commandIndex + 1];
      if (!sql) throw new Error("missing fixed SELECT");
      d1Commands.push(sql);
      expect(args.slice(0, 6)).toEqual([
        "d1",
        "execute",
        "STATE_DB",
        "--remote",
        "--yes",
        "--config",
      ]);
      expect(args).toContain("--json");
      expect(sql).toMatch(/^SELECT\b.* LIMIT 2$/s);
      expect(sql).not.toContain(";");
      expect(options?.env).toEqual({ CLOUDFLARE_API_TOKEN: "local-d1-test-secret" });
      const config = JSON.parse(readFileSync(args[6] ?? "", "utf8"));
      expect(config.account_id).toBe(target.accountId);
      expect(config.name).toBe(target.workerName);
      expect(config.d1_databases).toEqual([
        {
          binding: "STATE_DB",
          database_name: target.d1.databaseName,
          database_id: target.d1.databaseId,
        },
      ]);
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ success: true, results: db.query(sql).all() }]),
        stderr: "",
      };
    },
    stripeFetch: async (request) => {
      stripeRequests.push(request);
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer sk_test_local_fixture");
      if (new URL(request.url).pathname === "/v1/account")
        return Response.json({
          id: target.hostedBilling.accountId,
          object: "account",
          livemode: false,
        });
      const id = new URL(request.url).pathname.split("/").at(-1);
      const event = events[id as keyof typeof events];
      return event ? Response.json(event) : Response.json({ error: "not_found" }, { status: 404 });
    },
  };
  const options: CollectOptions = {
    environment: "integration",
    targetPath,
    inputPath,
    journalPath,
    outputPath,
    topUpEventId: "evt_top_original",
    invoiceEventId: "evt_invoice_original",
  };
  return { dir, db, options, ports, target, input, command, journal, d1Commands, stripeRequests };
}

test("collector preserves a modern original invoice snapshot for the receipt matcher", async () => {
  const f = fixture();
  try {
    const stripeFetch = f.ports.stripeFetch;
    if (!stripeFetch) throw new Error("missing Stripe fake");
    await collectServiceReceipts(f.options, {
      ...f.ports,
      stripeFetch: async (request) => {
        const response = await stripeFetch(request);
        if (new URL(request.url).pathname !== "/v1/events/evt_invoice_original") return response;
        const event = (await response.json()) as Record<string, unknown>;
        event.api_version = "2026-05-27.dahlia";
        const data = event.data as Record<string, unknown>;
        const object = data.object as Record<string, unknown>;
        delete object.paid;
        delete object.subscription;
        delete object.subscription_details;
        Object.assign(object, {
          amount_paid: 1000,
          amount_remaining: 0,
          currency: "usd",
          status_transitions: { paid_at: created - 1 },
          parent: {
            type: "subscription_details",
            subscription_details: {
              subscription: sub,
              metadata: {
                takoserverPurpose: "hosted_subscription",
                organizationId: org,
                planKey: f.input.subscription.planKey,
                pricingRevision: revision,
                subscriptionCheckoutIntentId: "sci_original",
              },
            },
          },
        });
        return Response.json(event);
      },
    });
    const raw = readFileSync(f.options.outputPath, "utf8");
    const evidence = JSON.parse(raw);
    expect(evidence.invoice.stripeEvent.api_version).toBe("2026-05-27.dahlia");
    expect(evidence.invoice.stripeEvent.data.object.parent.type).toBe("subscription_details");
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("collector refuses a modern invoice crossed to another checkout intent", async () => {
  const f = fixture();
  try {
    const stripeFetch = f.ports.stripeFetch;
    if (!stripeFetch) throw new Error("missing Stripe fake");
    await expect(
      collectServiceReceipts(f.options, {
        ...f.ports,
        stripeFetch: async (request) => {
          const response = await stripeFetch(request);
          if (new URL(request.url).pathname !== "/v1/events/evt_invoice_original") return response;
          const event = (await response.json()) as Record<string, unknown>;
          event.api_version = "2026-05-27.dahlia";
          const data = event.data as Record<string, unknown>;
          const object = data.object as Record<string, unknown>;
          delete object.paid;
          delete object.subscription;
          delete object.subscription_details;
          Object.assign(object, {
            amount_paid: 1000,
            amount_remaining: 0,
            currency: "usd",
            status_transitions: { paid_at: created - 1 },
            parent: {
              type: "subscription_details",
              subscription_details: {
                subscription: sub,
                metadata: {
                  takoserverPurpose: "hosted_subscription",
                  organizationId: org,
                  planKey: f.input.subscription.planKey,
                  pricingRevision: revision,
                  subscriptionCheckoutIntentId: "sci_other",
                },
              },
            },
          });
          return Response.json(event);
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(f.options.outputPath)).toBe(false);
    expect(existsSync(`${f.options.outputPath}.metadata.json`)).toBe(false);
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("collector reads five actual SQLite SELECTs and two parsed Stripe GETs into private matcher data", async () => {
  const f = fixture();
  try {
    await collectServiceReceipts(f.options, f.ports);
    expect(f.d1Commands).toHaveLength(5);
    expect(f.stripeRequests).toHaveLength(3);
    const raw = readFileSync(f.options.outputPath, "utf8");
    const metadata = readFileSync(`${f.options.outputPath}.metadata.json`, "utf8");
    expect(raw).not.toContain("must-not-be-saved");
    expect(raw).not.toContain("sk_test_local_fixture");
    expect(raw).not.toContain("local-d1-test-secret");
    expect(metadata).not.toContain("sk_test_local_fixture");
    expect(statSync(f.options.outputPath).mode & 0o077).toBe(0);
    expect(statSync(`${f.options.outputPath}.metadata.json`).mode & 0o077).toBe(0);
    const subRef = `sra_${hash(["takoserver-subscription-association-ref:v1", org, sub, customer, false])}`;
    expect(
      verifyServiceReceiptEvidence(raw, {
        input: f.input,
        targetSha256: f.input.targetSha256,
        origin: f.target.publicOrigin,
        organizationId: org,
        workerName: f.target.workerName,
        d1DatabaseId: f.target.d1.databaseId,
        stripeAccountId: f.target.hostedBilling.accountId,
        subscriptionCommand: {
          reference: f.input.subscription.reference,
          organizationId: org,
          planKey: f.input.subscription.planKey,
          pricingRevision: revision,
          state: "associated",
          subscriptionRef: subRef,
        },
        subscription: {
          organizationId: org,
          subscriptionId: sub,
          subscriptionRef: subRef,
          planKey: f.input.subscription.planKey,
          pricingRevision: revision,
        },
        topUpReceipt: {
          reference: f.input.topup.reference,
          state: "paid",
          checkout: { url: "https://checkout.stripe.com/c/pay/original" },
        },
        topUpAmountProven: true,
      }),
    ).toBe(true);
    expect(JSON.parse(metadata).scope).toContain("delivery-and-serving-provenance-unverified");
    expect(JSON.parse(metadata).authenticatedStripeAccountId).toBe(
      f.target.hostedBilling.accountId,
    );
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("collector refuses a different Stripe account, credited session, or applied subscription without publishing", async () => {
  const f = fixture();
  try {
    const stripeFetch = f.ports.stripeFetch;
    if (!stripeFetch) throw new Error("missing Stripe fake");
    const wrongAccountPaths: string[] = [];
    await expect(
      collectServiceReceipts(f.options, {
        ...f.ports,
        stripeFetch: async (request) => {
          wrongAccountPaths.push(new URL(request.url).pathname);
          return new URL(request.url).pathname === "/v1/account"
            ? Response.json({ id: "acct_unrelated", object: "account", livemode: false })
            : await stripeFetch(request);
        },
      }),
    ).rejects.toThrow();
    expect(wrongAccountPaths).toEqual(["/v1/account"]);
    expect(existsSync(f.options.outputPath)).toBe(false);
    expect(existsSync(`${f.options.outputPath}.metadata.json`)).toBe(false);

    await expect(
      collectServiceReceipts(f.options, {
        ...f.ports,
        stripeFetch: async (request) => {
          const response = await stripeFetch(request);
          if (new URL(request.url).pathname !== "/v1/events/evt_top_original") return response;
          const unrelated = (await response.json()) as Record<string, unknown>;
          const data = unrelated.data as Record<string, unknown>;
          unrelated.data = {
            ...data,
            object: { ...(data.object as Record<string, unknown>), id: "cs_unrelated" },
          };
          return Response.json(unrelated);
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(f.options.outputPath)).toBe(false);
    expect(existsSync(`${f.options.outputPath}.metadata.json`)).toBe(false);

    await expect(
      collectServiceReceipts(f.options, {
        ...f.ports,
        stripeFetch: async (request) => {
          const response = await stripeFetch(request);
          if (new URL(request.url).pathname !== "/v1/events/evt_invoice_original") return response;
          const unrelated = (await response.json()) as Record<string, unknown>;
          const data = unrelated.data as Record<string, unknown>;
          unrelated.data = {
            ...data,
            object: { ...(data.object as Record<string, unknown>), subscription: "sub_unrelated" },
          };
          return Response.json(unrelated);
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(f.options.outputPath)).toBe(false);
    expect(existsSync(`${f.options.outputPath}.metadata.json`)).toBe(false);
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("collector refuses old output, incomplete journal, source pin, and observed input drift before publication", async () => {
  const f = fixture();
  try {
    writeFileSync(f.options.outputPath, "old", { mode: 0o600 });
    await expect(collectServiceReceipts(f.options, f.ports)).rejects.toThrow();
    expect(readFileSync(f.options.outputPath, "utf8")).toBe("old");
    expect(f.d1Commands).toHaveLength(0);
    rmSync(f.options.outputPath);
    writeFileSync(`${f.options.outputPath}.metadata.json`, "old metadata", { mode: 0o600 });
    await expect(collectServiceReceipts(f.options, f.ports)).rejects.toThrow();
    expect(readFileSync(`${f.options.outputPath}.metadata.json`, "utf8")).toBe("old metadata");
    expect(f.d1Commands).toHaveLength(0);
    rmSync(`${f.options.outputPath}.metadata.json`);

    writeFileSync(
      f.options.journalPath,
      `${f.journal
        .slice(0, -1)
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    await expect(collectServiceReceipts(f.options, f.ports)).rejects.toThrow("incomplete");
    expect(f.d1Commands).toHaveLength(0);
    writeFileSync(
      f.options.journalPath,
      `${f.journal.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { mode: 0o600 },
    );

    const raw = readFileSync(f.options.inputPath, "utf8");
    writeFileSync(f.options.inputPath, raw.replace(sourceHead, "f".repeat(40)), { mode: 0o600 });
    await expect(collectServiceReceipts(f.options, f.ports)).rejects.toThrow("source HEAD");
    expect(f.d1Commands).toHaveLength(0);
    writeFileSync(f.options.inputPath, raw, { mode: 0o600 });

    const originalRun = f.ports.d1Run;
    const driftPorts = {
      ...f.ports,
      d1Run: async (...args: Parameters<NonNullable<CollectPorts["d1Run"]>>) => {
        const result = await originalRun?.(...args);
        writeFileSync(f.options.inputPath, `${raw} `, { mode: 0o600 });
        if (!result) throw new Error("missing D1 fake");
        return result;
      },
    };
    await expect(collectServiceReceipts(f.options, driftPorts)).rejects.toThrow();
    expect(existsSync(f.options.outputPath)).toBe(false);
    expect(existsSync(`${f.options.outputPath}.metadata.json`)).toBe(false);
    expect(f.stripeRequests).toHaveLength(0);

    writeFileSync(f.options.inputPath, raw, { mode: 0o600 });
    const originalTarget = readFileSync(f.options.targetPath, "utf8");
    await expect(
      collectServiceReceipts(f.options, {
        ...f.ports,
        d1Run: async (...args) => {
          const result = await originalRun?.(...args);
          writeFileSync(f.options.targetPath, `${originalTarget} `, { mode: 0o600 });
          if (!result) throw new Error("missing D1 fake");
          return result;
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(f.options.outputPath)).toBe(false);
    writeFileSync(f.options.targetPath, originalTarget, { mode: 0o600 });

    await expect(
      collectServiceReceipts(f.options, {
        ...f.ports,
        d1Run: async (...args) => {
          const result = await originalRun?.(...args);
          const config = args[0][args[0].indexOf("--config") + 1];
          if (!config) throw new Error("missing D1 config");
          writeFileSync(config, `${readFileSync(config, "utf8")} `, { mode: 0o600 });
          if (!result) throw new Error("missing D1 fake");
          return result;
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(f.options.outputPath)).toBe(false);
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
