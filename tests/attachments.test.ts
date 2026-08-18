import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  type AttachmentFactory,
  createAttachmentService,
  createAttachmentStore,
} from "../src/attachments.ts";
import type { TakoformInterfaceRef } from "../src/interface-ref.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const POSTGRES: TakoformInterfaceRef = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "sql.postgresql.takoform.com",
  version: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};

function fixture() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const deployments = createResourceDeploymentStore(sql, () => new Date(1_700_000_000_000));
  const factory: AttachmentFactory = {
    id: "postgres-dsn",
    providerPackRef: "aiven",
    supports(input) {
      return input.interfaceRef.name === POSTGRES.name;
    },
    async resolve(input) {
      return {
        kind: "credential-grant-ref",
        ref: `grant:${input.attachment.id}:${input.providerDeployment.id}`,
      };
    },
  };
  const service = createAttachmentService({
    store: createAttachmentStore(sql, () => new Date(1_700_000_000_000)),
    deployments,
    factories: [factory],
    clock: () => new Date(1_700_000_000_000),
    resource: async (tenantId, uid) => {
      if (tenantId !== "org_1") return null;
      if (uid === "uid_api") return { uid, providedInterfaces: [] };
      if (uid === "uid_db") return { uid, providedInterfaces: [POSTGRES] };
      return null;
    },
  });
  return { service, deployments };
}

async function activeDeployments(deployments: ReturnType<typeof createResourceDeploymentStore>) {
  await deployments.create({
    tenantId: "org_1",
    id: "dep_api",
    resourceUid: "uid_api",
    offeringId: "compute.vm.upcloud.standard",
    providerPackRef: "upcloud",
    providerInstallationRef: "upcloud.primary",
    nativeId: "vm:123",
    state: "active",
    observed: {},
    outputs: {},
  });
  await deployments.create({
    tenantId: "org_1",
    id: "dep_db",
    resourceUid: "uid_db",
    offeringId: "database.postgresql.aiven.standard",
    providerPackRef: "aiven",
    providerInstallationRef: "aiven.primary",
    nativeId: "service:pg-main",
    state: "active",
    observed: {},
    outputs: {},
  });
}

describe("Resource Attachments", () => {
  test("resolves an exact Interface against active Deployments without storing a secret", async () => {
    const { service, deployments } = fixture();
    await activeDeployments(deployments);
    const attachment = await service.createAndResolve({
      tenantId: "org_1",
      id: "att_api_main_db",
      consumerResourceUid: "uid_api",
      providerResourceUid: "uid_db",
      interfaceRef: POSTGRES,
      target: "DATABASE_URL",
      permissions: ["query", "mutate"],
    });

    expect(attachment.resolution).toEqual({
      kind: "credential-grant-ref",
      ref: "grant:att_api_main_db:dep_db",
    });
    expect(JSON.stringify(attachment)).not.toContain("password");
    expect(JSON.stringify(attachment)).not.toContain("service:pg-main");
  });

  test("rejects an undeclared Interface and a provider with no active Deployment", async () => {
    const { service, deployments } = fixture();
    await deployments.create({
      tenantId: "org_1",
      id: "dep_api",
      resourceUid: "uid_api",
      offeringId: "compute.vm.upcloud.standard",
      providerPackRef: "upcloud",
      providerInstallationRef: "upcloud.primary",
      nativeId: "vm:123",
      state: "active",
      observed: {},
      outputs: {},
    });
    await expect(
      service.createAndResolve({
        tenantId: "org_1",
        id: "att_wrong",
        consumerResourceUid: "uid_api",
        providerResourceUid: "uid_db",
        interfaceRef: { ...POSTGRES, schemaDigest: `sha256:${"b".repeat(64)}` },
        target: "DATABASE_URL",
        permissions: ["query"],
      }),
    ).rejects.toMatchObject({ code: "interface_not_provided" });
    await expect(
      service.createAndResolve({
        tenantId: "org_1",
        id: "att_no_deployment",
        consumerResourceUid: "uid_api",
        providerResourceUid: "uid_db",
        interfaceRef: POSTGRES,
        target: "DATABASE_URL",
        permissions: ["query"],
      }),
    ).rejects.toMatchObject({ code: "deployment_not_ready" });
  });

  test("makes attachment ownership block provider deletion", async () => {
    const { service, deployments } = fixture();
    await activeDeployments(deployments);
    await service.createAndResolve({
      tenantId: "org_1",
      id: "att_api_main_db",
      consumerResourceUid: "uid_api",
      providerResourceUid: "uid_db",
      interfaceRef: POSTGRES,
      target: "DATABASE_URL",
      permissions: ["query"],
    });

    expect(await service.blocksDeletion("org_1", "uid_db")).toEqual(["att_api_main_db"]);
    expect(await service.blocksDeletion("org_1", "uid_api")).toEqual(["att_api_main_db"]);

    expect(await service.list("org_1", { resourceUid: "uid_db", limit: 50 })).toEqual([
      expect.objectContaining({ id: "att_api_main_db", state: "active" }),
    ]);
    expect(await service.read("org_1", "att_api_main_db")).toMatchObject({
      providerDeploymentId: "dep_db",
      consumerDeploymentId: "dep_api",
    });
    await expect(
      service.createAndResolve({
        tenantId: "org_1",
        id: "att_api_main_db",
        consumerResourceUid: "uid_api",
        providerResourceUid: "uid_db",
        interfaceRef: POSTGRES,
        target: "DATABASE_URL",
        permissions: ["query"],
      }),
    ).rejects.toMatchObject({ code: "attachment_conflict" });
    await expect(
      service.createAndResolve({
        tenantId: "org_1",
        id: "att_api_duplicate_target",
        consumerResourceUid: "uid_api",
        providerResourceUid: "uid_db",
        interfaceRef: POSTGRES,
        target: "DATABASE_URL",
        permissions: ["query"],
      }),
    ).rejects.toMatchObject({ code: "attachment_conflict" });

    await service.remove("org_1", "att_api_main_db");
    expect(await service.blocksDeletion("org_1", "uid_db")).toEqual([]);
    expect(await service.read("org_1", "att_api_main_db")).toBeNull();
    await expect(service.remove("org_1", "att_api_main_db")).rejects.toMatchObject({
      code: "resource_not_found",
    });
  });

  test("selects one Interface-specific factory and rejects ambiguous resolution", async () => {
    const { deployments } = fixture();
    await activeDeployments(deployments);
    const matchingFactory = (id: string): AttachmentFactory => ({
      id,
      providerPackRef: "aiven",
      supports: () => true,
      resolve: async () => ({ kind: "endpoint-ref", ref: `endpoint:${id}` }),
    });
    const service = createAttachmentService({
      store: {
        create: async () => undefined,
        read: async () => null,
        list: async () => [],
        remove: async () => false,
        blocking: async () => [],
      },
      deployments,
      factories: [matchingFactory("dsn"), matchingFactory("proxy")],
      clock: () => new Date(1_700_000_000_000),
      resource: async (_tenantId, uid) =>
        uid === "uid_db"
          ? { uid, providedInterfaces: [POSTGRES] }
          : { uid, providedInterfaces: [] },
    });

    await expect(
      service.createAndResolve({
        tenantId: "org_1",
        id: "att_ambiguous",
        consumerResourceUid: "uid_api",
        providerResourceUid: "uid_db",
        interfaceRef: POSTGRES,
        target: "DATABASE_URL",
        permissions: ["query"],
      }),
    ).rejects.toMatchObject({ code: "attachment_unsupported" });
  });
});
