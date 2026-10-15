// Test-only HTTP host: production app/router, persistent SQLite, and the real
// payment composition. Every Stripe request is fenced to the parent loopback fake.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compilePricingAuthoring } from "../../scripts/pricing/compile.ts";
import { buildApp } from "../../src/app.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import { createOperatorPaymentsReconcileVerifier } from "../../src/operator-credentials.ts";
import { parseOperatorPublicKey } from "../../src/operator-key.ts";
import { resolvePayment } from "../../src/payment-setup.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "../helpers/takoform-v2-config.ts";

const [root, stripeOrigin, publicJwkText] = process.argv.slice(2);
if (!root || !stripeOrigin || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(stripeOrigin) || !publicJwkText)
  throw new Error("test-only root, loopback Stripe origin, and operator public key required");
const publicOrigin = "https://api.example.test";
const operatorPublicKeyJwk = parseOperatorPublicKey(publicJwkText);
const now = () => new Date("2026-10-14T12:00:00.000Z");
const database = new Database(join(root, "control.sqlite"));
migrateSqlite(database, { stripeMode: "test" });
const sql = createSqliteSql(database);
const shared = JSON.parse(
  readFileSync(new URL("../../config/shared-hosted-pricing.json", import.meta.url), "utf8"),
);
shared.plans[0].stripePriceId = "price_hosted10";
shared.plans[1].stripePriceId = "price_hosted50";
const meters = Object.fromEntries(
  Object.entries(
    shared.meters as Record<
      string,
      { unit: string; cloudflareCostMicros: string; quantity: string }
    >,
  )
    .filter(([, meter]) => meter.cloudflareCostMicros !== "0")
    .map(([key, meter]) => [
      key,
      {
        unit: meter.unit,
        rate: {
          numeratorMicros: (BigInt(meter.cloudflareCostMicros) * 3n).toString(),
          denominator: meter.quantity,
        },
      },
    ]),
);
const pricing = compilePricingAuthoring({
  authoringVersion: 2,
  sharedPricing: shared,
  planIds: { free: "free", usage: "usage" },
  billingConfig: {
    schemaVersion: 1,
    revision: shared.revision,
    effectiveAt: "2026-10-01T00:00:00.000Z",
    currency: "USD",
    holdTtlSeconds: 86_400,
    freeIncludedMinor: 150,
    purchaseCreditExpiry: { kind: "none" },
    plans: {
      "hosted-10": { includedMinor: 2000, stripePriceId: "price_hosted10" },
      "hosted-50": { includedMinor: 10000, stripePriceId: "price_hosted50" },
    },
    meters,
  },
  checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
});
const fakeFetch = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.origin !== "https://api.stripe.com" || !url.pathname.startsWith("/v1/"))
    throw new Error(`refused non-Stripe fixture request: ${url.origin}`);
  const redirected = new Request(`${stripeOrigin}${url.pathname}${url.search}`, request);
  redirected.headers.delete("authorization");
  return await fetch(redirected);
};
const setup = resolvePayment({
  hostedPricing: pricing,
  stripeMode: "test",
  stripeSecretKey: "sk_test_process_fixture_only",
  stripeWebhookSecret: "whsec_process_fixture_only",
  consoleOrigin: "https://console.example.test",
  fetch: fakeFetch,
});
if (!setup.events || !setup.settlement) throw new Error("billing fixture disabled");
const app = buildApp({
  v2: TEST_TAKOFORM_V2_CONFIG,
  sql,
  objects: createFileObjectStore({ root: join(root, "objects") }),
  identity: {
    async verify() {
      throw new Error("test fixture has no external identity provider");
    },
  },
  settlement: setup.settlement,
  ...(setup.checkout ? { checkout: setup.checkout } : {}),
  paymentEvents: setup.events,
  operatorPaymentsReconcile: createOperatorPaymentsReconcileVerifier({
    publicKeyJwk: operatorPublicKeyJwk,
    audience: publicOrigin,
    clock: now,
  }),
  shareReconcilePass: true,
  publicOrigin,
  forms: [],
  hostForms: [],
  driver: new InMemoryTakoformResourceDriver(),
  offerings: [],
  clock: now,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    return await app.fetch(new Request(`${publicOrigin}${url.pathname}${url.search}`, request));
  },
});
process.stdout.write(
  `${JSON.stringify({ stage: "listening", port: server.port, pid: process.pid })}\n`,
);
