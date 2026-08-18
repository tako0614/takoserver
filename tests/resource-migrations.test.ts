import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type AttachmentRebinding, createAttachmentStore } from "../src/attachments.ts";
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

function fixture(
  options: {
    attachments?: readonly string[];
    rebindings?: readonly AttachmentRebinding[];
    verifies?: boolean;
  } = {},
) {
  let current = 1_700_000_000_000;
  const clock = () => new Date(current);
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const deployments = createResourceDeploymentStore(sql, clock);
  const attachmentStore = createAttachmentStore(sql, clock);
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
    attachments: {
      blocksDeletion: async (tenantId, uid) => [
        ...(await attachmentStore.blocking(tenantId, uid)),
        ...(options.attachments ?? []),
      ],
      prepareMigrationRebindings: async () => {
        if (options.rebindings) return options.rebindings;
        if ((options.attachments?.length ?? 0) > 0) throw new Error("cannot rebind fixture");
        return [];
      },
    },
    clock,
    rollbackWindowMilliseconds: 60_000,
    sleep: async () => undefined,
  });
  return {
    service,
    store,
    sql,
    deployments,
    attachmentStore,
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
  commercialTenantRef: "tenant_main",
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

  test("atomically re-resolves Attachments at cutover and restores them on rollback", async () => {
    const rebindings: readonly AttachmentRebinding[] = [
      {
        id: "att_api_main_db",
        oldProviderDeploymentId: "dep_source",
        oldConsumerDeploymentId: "dep_api",
        oldResolution: { kind: "endpoint-ref", ref: "endpoint:source" },
        newProviderDeploymentId: "dep_mig_main_to_target_target",
        newConsumerDeploymentId: "dep_api",
        newResolution: { kind: "endpoint-ref", ref: "endpoint:target" },
      },
    ];
    const { service, deployments, attachmentStore } = fixture({ rebindings });
    await source(deployments);
    await deployments.create({
      tenantId: "org_1",
      id: "dep_api",
      resourceUid: "uid_api",
      offeringId: "compute.vm.standard",
      providerPackRef: "compute",
      providerInstallationRef: "compute.primary",
      nativeId: "vm:api",
      state: "active",
      observed: {},
      outputs: {},
    });
    await attachmentStore.create({
      tenantId: "org_1",
      id: "att_api_main_db",
      consumerResourceUid: "uid_api",
      providerResourceUid: "uid_main",
      interfaceRef: {
        apiVersion: "interfaces.takoform.com/v1alpha1",
        name: "sql.sqlite.takoform.com",
        version: "1.0.0",
        schemaDigest: `sha256:${"e".repeat(64)}`,
      },
      target: "DATABASE",
      permissions: ["query"],
      state: "active",
      providerDeploymentId: "dep_source",
      consumerDeploymentId: "dep_api",
      resolution: { kind: "endpoint-ref", ref: "endpoint:source" },
      createdAt: new Date(1_700_000_000_000).toISOString(),
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    });

    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);
    const completed = await service.cutover("org_1", PLAN.id);
    expect(completed.attachmentRebindings).toEqual(rebindings);
    expect(await attachmentStore.read("org_1", "att_api_main_db")).toMatchObject({
      providerDeploymentId: "dep_mig_main_to_target_target",
      resolution: { kind: "endpoint-ref", ref: "endpoint:target" },
    });

    await service.rollback("org_1", PLAN.id);
    expect(await attachmentStore.read("org_1", "att_api_main_db")).toMatchObject({
      providerDeploymentId: "dep_source",
      resolution: { kind: "endpoint-ref", ref: "endpoint:source" },
    });
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

  test("cancels a plan without creating provider capacity", async () => {
    const { service, deployments } = fixture();
    await source(deployments);
    await service.plan(PLAN);

    expect((await service.cancel("org_1", PLAN.id)).state).toBe("failed");
    expect((await service.cancel("org_1", PLAN.id)).state).toBe("failed");
    expect(await deployments.find("org_1", `dep_${PLAN.id}_target`)).toBeNull();
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("deletes a verified candidate before cancelling the Migration", async () => {
    const { service, deployments } = fixture();
    await source(deployments);
    await service.plan(PLAN);
    const verified = await service.execute("org_1", PLAN.id);

    expect((await service.cancel("org_1", PLAN.id)).state).toBe("failed");
    expect((await deployments.find("org_1", verified.targetDeploymentId))?.state).toBe("deleted");
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("does not cancel a Migration after cutover", async () => {
    const { service, deployments } = fixture();
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);
    await service.cutover("org_1", PLAN.id);

    await expect(service.cancel("org_1", PLAN.id)).rejects.toMatchObject({
      code: "migration_conflict",
    });
  });

  test("rejects malformed persisted verification and Attachment rebinding evidence", async () => {
    const { service, deployments, sql } = fixture();
    await source(deployments);
    await service.plan(PLAN);

    await sql.run(
      `UPDATE tf_resource_migrations
       SET verification_json = ?, attachment_rebindings_json = ?
       WHERE tenant_id = ? AND id = ?`,
      [
        JSON.stringify({
          schema: true,
          rowCounts: true,
          checksums: true,
          evidenceDigest: "not-a-digest",
        }),
        JSON.stringify([
          {
            id: "att_main",
            oldProviderDeploymentId: "dep_source",
            oldConsumerDeploymentId: "dep_api",
            oldResolution: { kind: "endpoint-ref", ref: "endpoint:source" },
            newProviderDeploymentId: "dep_target",
            newConsumerDeploymentId: "dep_api",
            newResolution: { kind: "endpoint-ref", ref: "endpoint:target" },
            injected: true,
          },
        ]),
        "org_1",
        PLAN.id,
      ],
    );

    await expect(service.read("org_1", PLAN.id)).rejects.toThrow("resource_migration_row_invalid");
  });
});
