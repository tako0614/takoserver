import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createProviderPack, type ProviderPackDefinition } from "../src/provider-pack.ts";
import type { ProviderOffering } from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import {
  createResourceMigrationService,
  createResourceMigrationStore,
} from "../src/resource-migrations.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const FORM = {
  apiVersion: "data.forms.takoform.com/v1alpha1",
  kind: "SqliteDatabase",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const FORMAT = "sqlite.sql-dump.takoform.com/v1";

function providerOffering(id: string): ProviderOffering {
  return {
    id,
    kind: "sqlite_database",
    displayName: id,
    form: FORM,
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "update", "delete", "import", "observe"],
  };
}

function sold(id: string, pack: string, installation: string): Offering {
  return {
    id,
    providerPackRef: pack,
    providerInstallationRef: installation,
    supplyContractRef: `${pack}.contract`,
    pricePlanRef: `${id}.price`,
    resourceClass: "database.sqlite",
    deliveryMode: "managed-endpoint",
    supportPolicyRef: "support:test",
    abusePolicyRef: "abuse:test",
    kind: "sqlite_database",
    displayName: id,
    form: FORM,
    pricePlan: {
      id: `${id}.price`,
      currency: "USD",
      recurring: { meter: "database-month", amountMinor: 500 },
      meters: [],
    },
    providedInterfaces: [],
    bindingRefs: [],
    regions: ["test"],
    portability: {
      api: "portable",
      exportFormats: [FORMAT],
      importFormats: [FORMAT],
      migrationModes: ["offline"],
    },
    isolation: "dedicated-resource",
    available: true,
  };
}

function fixture(options: { attachments?: readonly string[]; verifies?: boolean } = {}) {
  let current = 1_700_000_000_000;
  const clock = () => new Date(current);
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const deployments = createResourceDeploymentStore(sql, clock);
  const sourceOffering = providerOffering("database.sqlite.source.standard");
  const targetOffering = providerOffering("database.sqlite.target.standard");
  const calls: string[] = [];
  const pack = (
    id: string,
    offering: ProviderOffering,
    endpoint: Partial<ProviderPackDefinition["transferEndpoints"][number]> = {},
  ) =>
    createProviderPack({
      id,
      providerType: id,
      provisioners: [new FakeProvider({ id, offerings: [offering] })],
      attachmentFactories: [],
      transferEndpoints: [
        {
          id: `${id}-transfer`,
          exportFormats: [FORMAT],
          importFormats: [FORMAT],
          migrationModes: ["offline"],
          export: async () => {
            calls.push(`${id}:export`);
            return { transferRef: "transfer:sqlite:one" };
          },
          import: async ({ transferRef }) => {
            calls.push(`${id}:import:${transferRef}`);
          },
          verify: async () => {
            calls.push(`${id}:verify`);
            return {
              schema: options.verifies ?? true,
              rowCounts: options.verifies ?? true,
              checksums: options.verifies ?? true,
              evidenceDigest: `sha256:${"d".repeat(64)}`,
            };
          },
          ...endpoint,
        },
      ],
      credentialIssuers: [],
      meterSources: [],
      costEstimators: [],
    });
  const sourcePack = pack("source", sourceOffering);
  const targetPack = pack("target", targetOffering);
  const catalog = createCatalog([
    sold(sourceOffering.id, "source", "source.primary"),
    sold(targetOffering.id, "target", "target.primary"),
  ]);
  const store = createResourceMigrationStore(sql, clock);
  const service = createResourceMigrationService({
    store,
    deployments,
    catalog,
    packs: [sourcePack, targetPack],
    resource: async (tenantId, uid) =>
      tenantId === "org_1" && uid === "uid_main"
        ? { uid, form: FORM, space: "default", name: "main", spec: { sizeGiB: 10 } }
        : null,
    blockingAttachments: async () => options.attachments ?? [],
    clock,
    rollbackWindowMilliseconds: 60_000,
    sleep: async () => undefined,
  });
  return {
    service,
    store,
    deployments,
    calls,
    advance(milliseconds: number) {
      current += milliseconds;
    },
  };
}

async function source(deployments: ReturnType<typeof createResourceDeploymentStore>) {
  await deployments.create({
    tenantId: "org_1",
    id: "dep_source",
    resourceUid: "uid_main",
    offeringId: "database.sqlite.source.standard",
    providerPackRef: "source",
    providerInstallationRef: "source.primary",
    nativeId: "source:main",
    state: "active",
    observed: {},
    outputs: {},
  });
}

const PLAN = {
  tenantId: "org_1",
  id: "mig_main_to_target",
  resourceUid: "uid_main",
  targetOfferingId: "database.sqlite.target.standard",
  commercialAuthorizationRef: "reservation_migration_1",
  mode: "offline" as const,
  transferFormat: FORMAT,
};

describe("Resource Migration", () => {
  test("creates a candidate, verifies data, cuts over, and retains the source", async () => {
    const { service, deployments, calls } = fixture();
    await source(deployments);

    expect((await service.plan(PLAN)).state).toBe("planned");
    const verified = await service.execute("org_1", PLAN.id);
    expect(verified.state).toBe("verified");
    expect(verified.verification).toMatchObject({
      schema: true,
      rowCounts: true,
      checksums: true,
    });
    expect(calls).toEqual(["source:export", "target:import:transfer:sqlite:one", "target:verify"]);
    expect((await deployments.find("org_1", verified.targetDeploymentId))?.state).toBe("candidate");

    expect((await service.cutover("org_1", PLAN.id)).state).toBe("completed");
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe(verified.targetDeploymentId);
    expect((await deployments.find("org_1", "dep_source"))?.state).toBe("retained");
  });

  test("rolls back inside the window without changing logical Resource identity", async () => {
    const { service, deployments } = fixture();
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);
    await service.cutover("org_1", PLAN.id);

    expect((await service.rollback("org_1", PLAN.id)).state).toBe("rolled_back");
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("does not cut over attached resources until bindings are re-resolved", async () => {
    const { service, deployments } = fixture({ attachments: ["att_api_main"] });
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);

    await expect(service.cutover("org_1", PLAN.id)).rejects.toMatchObject({
      code: "attachment_rebind_required",
    });
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("keeps the source active when verification fails", async () => {
    const { service, deployments } = fixture({ verifies: false });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "verification_failed",
    });
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });
});
