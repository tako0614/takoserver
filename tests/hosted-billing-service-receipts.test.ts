import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusinessInput } from "../scripts/hosted-billing-business-e2e.ts";
import { BillingHttp, runVerify } from "../scripts/hosted-billing-business-e2e.ts";
import { verifyServiceReceiptEvidence } from "../scripts/hosted-billing-service-receipts.ts";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

const NOW = "2026-10-20T00:00:00.000Z";
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const org = "org_original";
const sub = "sub_original";
const customer = "cus_original";
const subSession = "cs_sub_original";
const topSession = "cs_top_original";
const revision = "revision-original";
const price = "price_original";
const amount = 500;
const included = 200;
const topUpCommand = {
  customerId: customer,
  accountId: "acct_original",
  livemode: false,
  financialRealm: "test-original",
  pricingRevision: revision,
  purchaseCreditExpiry: { kind: "none" },
  organizationId: org,
  reference: "top-original",
  amountMinor: amount,
  amountMicros: amount * 10_000,
  currency: "USD",
  purpose: "wallet_funding",
  successUrl: "https://console.staging.example/billing?checkout={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://console.staging.example/billing?checkout=cancelled",
};
const subRef = `sra_${hash(["takoserver-subscription-association-ref:v1", org, sub, customer, false])}`;
const input = {
  kind: "takoserver.hosted-billing-business-e2e-input@v1",
  sourceHead: "a".repeat(40),
  targetSha256: `sha256:${"b".repeat(64)}`,
  usage: {} as BusinessInput["usage"],
  subscription: { reference: "sub-original", planKey: "monthly-original" },
  topup: { reference: "top-original", amountMinor: 500 },
} as BusinessInput;

async function fixture() {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db, { stripeMode: "test" });
    for (const [id, type, objectId, outcome, detail] of [
      ["evt_top_original", "checkout.session.completed", topSession, "credited", "credited"],
      ["evt_invoice_original", "invoice.paid", "in_original", "applied", "invoice_credit_granted"],
    ] as const) {
      db.query(`INSERT INTO stripe_events
        (event_id,type,livemode,object_id,event_created_at,received_at,outcome,outcome_detail,settled_at)
        VALUES (?,?,0,?,?,?,?,?,?)`).run(id, type, objectId, NOW, NOW, outcome, detail, NOW);
    }
    const receipt = (id: string): Record<string, unknown> => {
      const row = db
        .query(`SELECT event_id,type,livemode,object_id,event_created_at,received_at,
        outcome,outcome_detail,settled_at FROM stripe_events WHERE event_id = ?`)
        .get(id);
      if (!row) throw new Error("seeded Stripe event row absent");
      return row as Record<string, unknown>;
    };
    const evidence = {
      kind: "takoserver.hosted-billing-service-receipts@v1",
      sourceHead: input.sourceHead,
      targetSha256: input.targetSha256,
      origin: "https://api.staging.example",
      organizationId: org,
      workerName: "integration-original",
      d1DatabaseId: "11111111-1111-4111-8111-111111111111",
      stripeAccountId: "acct_original",
      subscriptionIntent: {
        id: "sci_original",
        org_id: org,
        request_key_digest: hash([org, input.subscription.reference]),
        fingerprint: hash([
          org,
          input.subscription.planKey,
          revision,
          price,
          amount,
          included,
          false,
          "subscription",
        ]),
        plan_key: input.subscription.planKey,
        pricing_revision: revision,
        price_id: price,
        price_amount_minor: amount,
        included_minor: included,
        livemode: 0,
        customer_id: customer,
        state: "associated",
        session_id: subSession,
        subscription_id: sub,
      },
      subscriptionAssociation: {
        subscription_id: sub,
        org_id: org,
        customer_id: customer,
        livemode: 0,
        plan_key: input.subscription.planKey,
        pricing_revision: revision,
        price_id: price,
        price_amount_minor: amount,
        included_minor: included,
        session_id: subSession,
      },
      topUpCommand: {
        org_id: org,
        reference: input.topup.reference,
        command_json: JSON.stringify(topUpCommand),
        state: "paid",
        session_id: topSession,
        session_url: "https://checkout.stripe.com/c/pay/original",
      },
      topUp: {
        stripeEvent: {
          id: "evt_top_original",
          type: "checkout.session.completed",
          livemode: false,
          created: 1792454400,
          data: {
            object: {
              object: "checkout.session",
              id: topSession,
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
                stripeAccountId: "acct_original",
                takoserverPurpose: "wallet_funding",
                financialRealm: topUpCommand.financialRealm,
                pricingRevision: topUpCommand.pricingRevision,
                purchaseCreditExpiry: JSON.stringify(topUpCommand.purchaseCreditExpiry),
                topUpCommandDigest: `sha256:${hash(topUpCommand)}`,
              },
            },
          },
        },
        serviceReceipt: receipt("evt_top_original"),
      },
      invoice: {
        stripeEvent: {
          id: "evt_invoice_original",
          type: "invoice.paid",
          livemode: false,
          created: 1792454400,
          data: {
            object: {
              object: "invoice",
              id: "in_original",
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
            },
          },
        },
        serviceReceipt: receipt("evt_invoice_original"),
      },
    };
    const context = {
      input,
      targetSha256: input.targetSha256,
      origin: evidence.origin,
      organizationId: org,
      workerName: evidence.workerName,
      d1DatabaseId: evidence.d1DatabaseId,
      stripeAccountId: evidence.stripeAccountId,
      subscriptionCommand: {
        reference: input.subscription.reference,
        organizationId: org,
        planKey: input.subscription.planKey,
        pricingRevision: revision,
        state: "associated",
        subscriptionRef: subRef,
      },
      subscription: {
        organizationId: org,
        subscriptionId: sub,
        subscriptionRef: subRef,
        planKey: input.subscription.planKey,
        pricingRevision: revision,
      },
      topUpReceipt: {
        reference: input.topup.reference,
        state: "paid",
        checkout: { url: evidence.topUpCommand.session_url },
      },
      topUpAmountProven: true,
    };
    return { evidence, context };
  } finally {
    db.close();
  }
}

test("saved TEST events match actual local stripe_events rows and original custody", async () => {
  const { evidence, context } = await fixture();
  expect(verifyServiceReceiptEvidence(JSON.stringify(evidence), context)).toBe(true);
});

test("crossed, unfinished, and unrelated saved receipts cannot match the original journey", async () => {
  const { evidence, context } = await fixture();
  const fail = (mutate: (candidate: typeof evidence) => void) => {
    const candidate = structuredClone(evidence);
    mutate(candidate);
    expect(() => verifyServiceReceiptEvidence(JSON.stringify(candidate), context)).toThrow();
  };
  fail((e) => {
    e.d1DatabaseId = "22222222-2222-4222-8222-222222222222";
  });
  fail((e) => {
    e.subscriptionIntent.request_key_digest = hash([org, "other-start"]);
  });
  fail((e) => {
    e.subscriptionAssociation.subscription_id = "sub_other";
  });
  fail((e) => {
    e.topUpCommand.command_json = JSON.stringify({ ...topUpCommand, reference: "other" });
  });
  fail((e) => {
    e.topUpCommand.command_json = JSON.stringify({ ...topUpCommand, accountId: "acct_other" });
  });
  fail((e) => {
    e.topUpCommand.command_json = JSON.stringify({ ...topUpCommand, amountMicros: 1 });
  });
  fail((e) => {
    e.topUp.stripeEvent.data.object.customer = "cus_other";
  });
  fail((e) => {
    e.topUp.stripeEvent.data.object.metadata.topUpCommandDigest = "sha256:wrong";
  });
  fail((e) => {
    e.subscriptionIntent.customer_id = "cus_other";
  });
  fail((e) => {
    e.subscriptionIntent.livemode = 1;
  });
  fail((e) => {
    e.subscriptionAssociation.price_id = "price_other";
  });
  fail((e) => {
    e.subscriptionAssociation.pricing_revision = "other-revision";
  });
  fail((e) => {
    e.topUp.stripeEvent.data.object.metadata.topUpReference = "other";
  });
  fail((e) => {
    e.topUp.serviceReceipt = { ...e.topUp.serviceReceipt, outcome: "received", settled_at: null };
  });
  fail((e) => {
    e.topUp.serviceReceipt = { ...e.topUp.serviceReceipt, outcome: "deferred" };
  });
  fail((e) => {
    e.invoice.serviceReceipt = { ...e.invoice.serviceReceipt, outcome: "ignored" };
  });
  fail((e) => {
    e.invoice.serviceReceipt = {
      ...e.invoice.serviceReceipt,
      outcome_detail: "subscription_updated",
    };
  });
  fail((e) => {
    e.invoice.stripeEvent.data.object.subscription = "sub_other";
  });
  fail((e) => {
    e.invoice.serviceReceipt = { ...e.invoice.serviceReceipt, object_id: "in_other" };
  });
  expect(() =>
    verifyServiceReceiptEvidence(JSON.stringify(evidence), {
      ...context,
      topUpAmountProven: false,
    }),
  ).toThrow();
});

test("verify consumes saved records with GETs only and preserves incomplete webhook status", async () => {
  const { evidence } = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "billing-service-receipts-"));
  chmodSync(dir, 0o700);
  const journalPath = join(dir, "original.jsonl");
  const handoffPath = join(dir, "checkout");
  const inputRaw = JSON.stringify({
    ...input,
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
  });
  const original = JSON.parse(inputRaw) as BusinessInput;
  const events = [
    {
      kind: "takoserver.hosted-billing-business-e2e-journal@v1",
      inputSha256: `sha256:${createHash("sha256").update(inputRaw).digest("hex")}`,
      targetSha256: input.targetSha256,
      sourceHead: input.sourceHead,
      origin: evidence.origin,
    },
    { kind: "intent", step: "personal", organizationId: null, body: {} },
    { kind: "ack", step: "personal", organizationId: org },
    { kind: "intent", step: "usage", organizationId: org, body: original.usage },
    { kind: "ack", step: "usage" },
    { kind: "intent", step: "subscription", organizationId: org, body: original.subscription },
    { kind: "ack", step: "subscription" },
    { kind: "intent", step: "topup", organizationId: org, body: original.topup },
    { kind: "ack", step: "topup" },
  ];
  writeFileSync(journalPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    mode: 0o600,
  });
  const calls: string[] = [];
  const client = new BillingHttp(evidence.origin, "local-session", async (request) => {
    calls.push(request.method);
    const path = new URL(request.url).pathname;
    if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
    if (path.endsWith("/wallet/usage-summary/workspaces"))
      return Response.json({ workspaces: [{ workspaceRef: original.usage.workspaceRef }] });
    if (path.endsWith("/wallet/usage-summary"))
      return Response.json({ usageSummary: { organizationId: org } });
    if (path.endsWith("/wallet/usage-records"))
      return Response.json({
        usageRecords: [
          {
            organizationId: org,
            reference: original.usage.reference,
            workspaceRef: original.usage.workspaceRef,
            meter: original.usage.meter,
            quantityUnit: original.usage.quantityUnit,
            quantity: original.usage.quantity,
            periodStart: original.usage.periodStart,
            periodEnd: original.usage.periodEnd,
            pricingRevision: original.usage.pricingRevision,
            amountMicros: original.usage.expectedMicros,
          },
        ],
        cursor: null,
      });
    if (path.endsWith("/wallet")) return Response.json({ wallet: { organizationId: org } });
    if (path.endsWith("/payments/subscription/commands/start/sub-original"))
      return Response.json({
        receipt: {
          reference: original.subscription.reference,
          organizationId: org,
          planKey: original.subscription.planKey,
          pricingRevision: revision,
          state: "associated",
          subscriptionRef: subRef,
          checkout: { url: "https://checkout.stripe.com/c/pay/sub-original" },
        },
      });
    if (path.endsWith("/payments/subscription"))
      return Response.json({
        subscription: {
          organizationId: org,
          subscriptionId: sub,
          subscriptionRef: subRef,
          planKey: original.subscription.planKey,
          pricingRevision: revision,
        },
        planTable: { plans: [] },
      });
    if (path.endsWith("/wallet/checkout/top-original"))
      return Response.json({
        reference: original.topup.reference,
        state: "paid",
        checkout: { url: evidence.topUpCommand.session_url },
      });
    throw new Error("unexpected GET route");
  });
  const options = {
    journalPath,
    handoffPath,
    inputRaw,
    targetSha256: input.targetSha256,
    origin: evidence.origin,
    client,
    serviceReceipts: {
      raw: JSON.stringify(evidence),
      workerName: evidence.workerName,
      d1DatabaseId: evidence.d1DatabaseId,
      stripeAccountId: evidence.stripeAccountId,
    },
  };
  try {
    expect(await runVerify(options)).toMatchObject({
      state: "readback-incomplete",
      serviceReceiptEvidenceMatched: true,
      webhookProven: false,
    });
    expect(calls.every((method) => method === "GET")).toBe(true);
    const crossed = structuredClone(evidence);
    crossed.invoice.serviceReceipt.outcome_detail = "subscription_updated";
    await expect(
      runVerify({
        ...options,
        serviceReceipts: { ...options.serviceReceipts, raw: JSON.stringify(crossed) },
      }),
    ).rejects.toThrow();
    expect(calls.every((method) => method === "GET")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
