import { describe, expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { createMetering } from "../src/metering.ts";
import { createProviderMetering } from "../src/provider-metering.ts";
import { createProviderPack, type MeterSource } from "../src/provider-pack.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";

const FORM = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const OFFERING: Offering = {
  id: "storage.object.test",
  providerPackRef: "test-provider",
  providerInstallationRef: "test-provider.production",
  supplyContractRef: "test-provider.contract",
  pricePlanRef: "storage.object.test.price-v1",
  resourceClass: "storage.object",
  deliveryMode: "native-credentials",
  supportPolicyRef: "support:test",
  abusePolicyRef: "abuse:test",
  kind: "object_bucket",
  displayName: "Object storage",
  form: FORM,
  pricePlan: {
    id: "storage.object.test.price-v1",
    currency: "USD",
    provisioning: { meter: "resource.create", amountMinor: 0 },
    meters: [
      { meter: "storage.gib-hour", amountMinor: 10 },
      { meter: "requests.million", amountMinor: 2 },
    ],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: ["test"],
  portability: {
    api: "portable",
    exportFormats: ["s3.object-set.takoform.com/v1"],
    importFormats: ["s3.object-set.takoform.com/v1"],
    migrationModes: ["offline"],
  },
  isolation: "dedicated-resource",
  available: true,
};

describe("provider usage reconciliation", () => {
  test("claims one window, prices it once, then advances the durable checkpoint", async () => {
    const sql = createEphemeralSql();
    const now = new Date("2026-08-19T02:00:00.000Z");
    const clock = () => now;
    const deployments = createResourceDeploymentStore(sql, clock);
    await deployments.create({
      tenantId: "org_1",
      id: "dep_bucket",
      resourceUid: "uid_bucket",
      offeringId: OFFERING.id,
      providerPackRef: "test-provider",
      providerInstallationRef: "test-provider.production",
      nativeId: "test:bucket",
      state: "active",
      observed: {},
      outputs: {},
    });
    await sql.run(
      "UPDATE tf_resource_deployments SET created_at = ?, updated_at = ? WHERE id = ?",
      [now.getTime() - 7_200_000, now.getTime() - 7_200_000, "dep_bucket"],
    );
    let reads = 0;
    let unrelatedReads = 0;
    const source: MeterSource = {
      id: "test-meter",
      meters: ["storage.gib-hour", "requests.million"],
      settlementDelaySeconds: 0,
      maximumWindowSeconds: 3_600,
      read: async () => {
        reads += 1;
        return [
          { meter: "storage.gib-hour", quantity: 2 },
          { meter: "requests.million", quantity: 3 },
        ];
      },
    };
    const unrelated: MeterSource = {
      id: "worker-meter",
      meters: ["worker.requests.million"],
      settlementDelaySeconds: 0,
      maximumWindowSeconds: 3_600,
      read: async () => {
        unrelatedReads += 1;
        return [{ meter: "worker.requests.million", quantity: 999 }];
      },
    };
    const pack = createProviderPack({
      id: "test-provider",
      providerType: "test-provider",
      provisioners: [new FakeProvider({ id: "test-provider", offerings: [] })],
      attachmentFactories: [],
      transferEndpoints: [],
      credentialIssuers: [],
      meterSources: [source, unrelated],
      costEstimators: [],
    });
    const ledger = createLedger(sql, clock);
    await ledger.fund({ organizationId: "org_1", fundingRef: "seed", amountMinor: 1_000 });
    const metering = createMetering({ sql, ledger, clock, randomId: () => "rollup" });
    const providerMetering = createProviderMetering({
      sql,
      deployments,
      catalog: createCatalog([OFFERING]),
      packs: [pack],
      metering,
      clock,
    });

    const reports = await Promise.all([
      providerMetering.reconcile(10),
      providerMetering.reconcile(10),
    ]);
    expect(reports.reduce((sum, report) => sum + report.windows, 0)).toBe(1);
    expect(reads).toBe(1);
    expect(unrelatedReads).toBe(0);
    expect(await sql.query("SELECT meter, quantity FROM usage_events ORDER BY meter")).toEqual([
      { meter: "requests.million", quantity: 3 },
      { meter: "storage.gib-hour", quantity: 2 },
    ]);
    expect(await metering.rollUp(100)).toBe(2);
    expect((await ledger.wallet("org_1")).availableMinor).toBe(974);
    expect(await sql.query("SELECT cursor_at FROM provider_meter_checkpoints")).toEqual([
      { cursor_at: now.getTime() - 3_600_000 },
    ]);
  });

  test("does not advance or reveal an upstream failure", async () => {
    const sql = createEphemeralSql();
    const now = new Date("2026-08-19T02:00:00.000Z");
    const clock = () => now;
    const deployments = createResourceDeploymentStore(sql, clock);
    await deployments.create({
      tenantId: "org_1",
      id: "dep_failed",
      resourceUid: "uid_failed",
      offeringId: OFFERING.id,
      providerPackRef: "test-provider",
      providerInstallationRef: "test-provider.production",
      nativeId: "test:failed",
      state: "active",
      observed: {},
      outputs: {},
    });
    await sql.run("UPDATE tf_resource_deployments SET created_at = ? WHERE id = ?", [
      now.getTime() - 3_600_000,
      "dep_failed",
    ]);
    const source: MeterSource = {
      id: "test-meter",
      meters: ["storage.gib-hour", "requests.million"],
      settlementDelaySeconds: 0,
      maximumWindowSeconds: 3_600,
      read: async () => {
        throw new Error("provider-token-should-never-leak");
      },
    };
    const pack = createProviderPack({
      id: "test-provider",
      providerType: "test-provider",
      provisioners: [new FakeProvider({ id: "test-provider", offerings: [] })],
      attachmentFactories: [],
      transferEndpoints: [],
      credentialIssuers: [],
      meterSources: [source],
      costEstimators: [],
    });
    const metering = createMetering({
      sql,
      ledger: createLedger(sql, clock),
      clock,
      randomId: () => "unused",
    });
    const report = await createProviderMetering({
      sql,
      deployments,
      catalog: createCatalog([OFFERING]),
      packs: [pack],
      metering,
      clock,
    }).reconcile(10);

    expect(report).toEqual({ windows: 0, deferred: 0, failures: ["dep_failed"] });
    expect(JSON.stringify(report)).not.toContain("provider-token");
    expect(await sql.query("SELECT * FROM provider_meter_checkpoints")).toEqual([]);
    expect(await sql.query("SELECT * FROM usage_events")).toEqual([]);
  });
});
