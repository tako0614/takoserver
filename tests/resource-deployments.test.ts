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

  test("records an immutable provider revision as retained instead of pretending deletion", async () => {
    const deployments = store();
    await deployments.create({
      tenantId: "org_1",
      id: "dep_version",
      resourceUid: "uid_version",
      offeringId: "cloudflare.worker-version",
      providerPackRef: "cloudflare",
      providerInstallationRef: "cloudflare.primary",
      nativeId: "version:script-name:version-id",
      state: "active",
      observed: {},
      outputs: {},
    });
    expect(
      await deployments.markRetained(
        "org_1",
        "dep_version",
        "version:script-name:version-id",
        { retained: true },
        { versionId: "version-id" },
      ),
    ).toBe(true);
    expect(await deployments.find("org_1", "dep_version")).toMatchObject({
      state: "retained",
      observed: { retained: true },
      outputs: { versionId: "version-id" },
    });
    expect(await deployments.active("org_1", "uid_version")).toBeNull();
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
  test("a claim belongs to a live deployment, and a minted object is no claim", async () => {
    const deployments = store();
    const base = {
      tenantId: "org_1",
      resourceUid: "uid_created",
      offeringId: "storage.object.standard",
      providerPackRef: "selfhost",
      providerInstallationRef: "selfhost.primary",
      nativeId: "bucket:minted",
      state: "active" as const,
      observed: {},
      outputs: {},
    };
    await deployments.create({ ...base, id: "dep_created" });

    // Creation mints; it adopts nothing.
    const minted = await deployments.active("org_1", "uid_created");
    expect(minted?.nativeClaimed).toBe(false);

    // The first import records the claim and may re-point the deployment,
    // because there was no claim to move.
    expect(
      await deployments.claimNative({
        tenantId: "org_1",
        deploymentId: "dep_created",
        expectedNativeId: "bucket:minted",
        nativeId: "bucket:adopted",
        observed: {},
        outputs: {},
      }),
    ).toBe(true);
    const claimed = await deployments.active("org_1", "uid_created");
    expect(claimed?.nativeClaimed).toBe(true);
    expect(claimed?.nativeId).toBe("bucket:adopted");
    expect(
      (await deployments.findByNative("org_1", "selfhost.primary", "bucket:adopted"))?.id,
    ).toBe("dep_created");

    // From its first claim onwards the claim is immutable.
    expect(
      await deployments.claimNative({
        tenantId: "org_1",
        deploymentId: "dep_created",
        expectedNativeId: "bucket:adopted",
        nativeId: "bucket:moved",
        observed: {},
        outputs: {},
      }),
    ).toBe(false);

    // Destroying the holder releases the object, for every kind, and the
    // released identifier can be claimed again.
    expect(await deployments.markDeleted("org_1", "dep_created", "bucket:adopted")).toBe(true);
    expect(await deployments.findByNative("org_1", "selfhost.primary", "bucket:adopted")).toBe(
      null,
    );
    await deployments.create({
      ...base,
      id: "dep_readopted",
      resourceUid: "uid_other",
      nativeId: "bucket:adopted",
      nativeClaimed: true,
    });
    expect(
      (await deployments.findByNative("org_1", "selfhost.primary", "bucket:adopted"))?.id,
    ).toBe("dep_readopted");
  });
});
