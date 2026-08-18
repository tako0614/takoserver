import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

function store() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  return createResourceDeploymentStore(
    createSqliteSql(database),
    () => new Date(1_700_000_000_000),
  );
}

describe("Resource Deployments", () => {
  test("keeps several provider realizations under one logical Resource", async () => {
    const deployments = store();
    await deployments.create({
      tenantId: "org_1",
      id: "dep_d1_primary",
      resourceUid: "uid_main",
      offeringId: "database.sqlite.cloudflare-d1.standard",
      providerPackRef: "cloudflare",
      providerInstallationRef: "cloudflare.primary",
      nativeId: "d1:primary",
      state: "active",
      observed: { location: "WEUR" },
      outputs: {},
    });
    await deployments.create({
      tenantId: "org_1",
      id: "dep_vm_candidate",
      resourceUid: "uid_main",
      offeringId: "database.sqlite.vm-local.standard",
      providerPackRef: "selfhost-sqlite",
      providerInstallationRef: "upcloud.vm-123",
      nativeId: "sqlite:/srv/main.db",
      state: "candidate",
      observed: { host: "vm-123" },
      outputs: {},
    });

    expect((await deployments.forResource("org_1", "uid_main")).map((row) => row.state)).toEqual([
      "active",
      "candidate",
    ]);
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_d1_primary");
  });

  test("cuts over only the exact active and candidate pair", async () => {
    const deployments = store();
    for (const input of [
      {
        id: "dep_source",
        offeringId: "database.sqlite.cloudflare-d1.standard",
        providerPackRef: "cloudflare",
        providerInstallationRef: "cloudflare.primary",
        nativeId: "d1:source",
        state: "active" as const,
      },
      {
        id: "dep_target",
        offeringId: "database.sqlite.vm-local.standard",
        providerPackRef: "selfhost-sqlite",
        providerInstallationRef: "upcloud.vm-123",
        nativeId: "sqlite:/srv/main.db",
        state: "candidate" as const,
      },
    ]) {
      await deployments.create({
        tenantId: "org_1",
        resourceUid: "uid_main",
        observed: {},
        outputs: {},
        ...input,
      });
    }

    expect(await deployments.cutover("org_1", "uid_main", "wrong", "dep_target")).toBe(false);
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
    expect(await deployments.cutover("org_1", "uid_main", "dep_source", "dep_target")).toBe(true);
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_target");
    expect((await deployments.find("org_1", "dep_source"))?.state).toBe("retained");
  });

  test("refuses a second active deployment and duplicate native ownership", async () => {
    const deployments = store();
    const base = {
      tenantId: "org_1",
      resourceUid: "uid_main",
      offeringId: "storage.s3.wasabi.ap-northeast",
      providerPackRef: "wasabi",
      providerInstallationRef: "wasabi.primary",
      nativeId: "bucket:main",
      state: "active" as const,
      observed: {},
      outputs: {},
    };
    await deployments.create({ ...base, id: "dep_one" });
    await expect(
      deployments.create({
        ...base,
        id: "dep_two",
        nativeId: "bucket:other",
      }),
    ).rejects.toThrow();
    await expect(
      deployments.create({
        ...base,
        id: "dep_three",
        resourceUid: "uid_other",
        state: "candidate",
      }),
    ).rejects.toThrow();
  });
});
