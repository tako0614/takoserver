import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMoneyUnitSchema,
  assertOrgBillingSchema,
  MONEY_UNIT_MIGRATION,
  moneyUnitSchemaReady,
  ORG_BILLING_MIGRATION,
  orgBillingSchemaReady,
} from "../scripts/deploy/migrations.ts";
import { deploymentVariables, expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import { loadTarget } from "../scripts/deploy/target.ts";

const BASE = {
  kind: "takoserver.deploy-target@v2",
  environment: "production",
  accountId: "a10162d23653f1ad1193dabf520a5dd0",
  workerName: "takoserver-api",
  d1: {
    databaseName: "takoserver-runtime",
    databaseId: "85c5a15d-a80f-42fe-a907-7ec0d86e008e",
  },
  r2: { bucketName: "takoserver-objects" },
  publicOrigin: "https://api.takoserver.com",
  signing: { currentKeyId: "takoserver-runtime-2026-08" },
};

const BILLING_CONFIG = {
  schemaVersion: 1,
  revision: "2026-10-13.1",
  effectiveAt: "2026-10-13T00:00:00.000Z",
  currency: "USD",
  holdTtlSeconds: 86_400,
  freeIncludedMinor: 0,
  purchaseCreditExpiry: { kind: "none" },
  plans: { starter: { includedMinor: 0, stripePriceId: "price_plan001" } },
  meters: {
    "takosumi.storage.byte-hours": {
      unit: "byte-hour",
      rate: { numeratorMicros: "1", denominator: "1000" },
    },
  },
};

function withTarget<T>(descriptor: Record<string, unknown>, read: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "takoserver-billing-target-"));
  try {
    const path = join(directory, "target.json");
    writeFileSync(path, JSON.stringify({ ...BASE, ...descriptor }));
    return read(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("deploy target Organization billing config", () => {
  test("requires 0094 for every serving Worker, independent of billing opt-in", () => {
    const through0092 = [ORG_BILLING_MIGRATION];
    for (const applied of [[], through0092]) {
      expect(moneyUnitSchemaReady(applied)).toBe(false);
      expect(() => assertMoneyUnitSchema(applied)).toThrow(
        "needs 0094_wallet_usd_micros.sql applied",
      );
    }
    expect(moneyUnitSchemaReady([...through0092, MONEY_UNIT_MIGRATION])).toBe(true);
    expect(() => assertMoneyUnitSchema([...through0092, MONEY_UNIT_MIGRATION])).not.toThrow();
  });

  test("validates and realizes the exact tariff as a public runtime variable", () => {
    withTarget({ billingConfig: BILLING_CONFIG }, (path) => {
      const target = loadTarget(path, "production");
      const realized = deploymentVariables(target) as { vars: Record<string, string> };
      expect(target.billingConfig?.revision).toBe("2026-10-13.1");
      expect(realized.vars.TAKOSERVER_BILLING_CONFIG).toBe(JSON.stringify(target.billingConfig));
      expect(expectedWorkerSecrets(target)).not.toContain("TAKOSERVER_BILLING_CONFIG");
    });
  });

  test("sanitizes invalid tariff diagnostics without echoing operator prices", () => {
    const privateInvalid = {
      ...BILLING_CONFIG,
      plans: { starter: { includedMinor: -1, stripePriceId: "price_PRIVATE_EXAMPLE" } },
    };
    withTarget({ billingConfig: privateInvalid }, (path) => {
      try {
        loadTarget(path, "production");
        throw new Error("expected invalid billing target to be refused");
      } catch (error) {
        expect(String(error)).toContain("deploy target billingConfig is invalid");
        expect(String(error)).not.toContain("price_PRIVATE_EXAMPLE");
        expect(String(error)).not.toContain("-1");
      }
    });
  });

  test("requires migration 0092 only when the target enables Organization billing", () => {
    const through0091 = ["0091_stripe_events.sql"];
    const through0092 = [...through0091, ORG_BILLING_MIGRATION];
    expect(orgBillingSchemaReady({ billingConfig: BILLING_CONFIG }, through0091)).toBe(false);
    expect(() => assertOrgBillingSchema({ billingConfig: BILLING_CONFIG }, through0091)).toThrow(
      "needs 0092_org_wallet_lifecycle.sql applied",
    );
    expect(orgBillingSchemaReady({ billingConfig: BILLING_CONFIG }, through0092)).toBe(true);
    expect(() =>
      assertOrgBillingSchema({ billingConfig: BILLING_CONFIG }, through0092),
    ).not.toThrow();
    expect(orgBillingSchemaReady({}, through0091)).toBe(true);
    expect(() => assertOrgBillingSchema({}, through0091)).not.toThrow();
  });
});
