import { describe, expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import { type Provider, type ProviderOffering, succeeded } from "../src/provider-port.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import type {
  InstalledTakoformForm,
  TakoformResourceDriver,
  TakoformStoredResource,
} from "../src/takoform/types.ts";

const tenantId = "tenant-provider-import-selection";
const formRef = {
  apiVersion: "example.forms.invalid",
  kind: "ImportedThing",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};
const form: InstalledTakoformForm = {
  identity: { formRef },
  role: "identity",
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "read", "delete", "import", "observe"],
};
const technicalOffering: ProviderOffering = {
  id: "imported-thing",
  kind: "imported_thing",
  displayName: "Imported thing",
  form: formRef,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["import", "observe", "delete"],
};
const soldOffering: Offering = {
  id: technicalOffering.id,
  providerPackRef: "import-provider",
  providerInstallationRef: "import-provider.primary",
  supplyContractRef: "import-provider.supply",
  pricePlanRef: "import-provider.price",
  resourceClass: "imported-thing",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "import-provider.support",
  abusePolicyRef: "import-provider.abuse",
  kind: technicalOffering.kind,
  displayName: technicalOffering.displayName,
  form: formRef,
  pricePlan: {
    id: "import-provider.price",
    currency: "USD",
    provisioning: { meter: "resource.import", amountMinor: 0 },
    meters: [],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: [],
  portability: {
    api: "portable",
    exportFormats: [],
    importFormats: [],
    migrationModes: [],
  },
  isolation: "dedicated-resource",
  available: true,
};

type ImportInput = Parameters<NonNullable<TakoformResourceDriver["import"]>>[0];
type ImportSelectionInput = Omit<ImportInput, "selection" | "operationId" | "operationMode">;

describe("provider-driver import selection", () => {
  test("persists and executes the exact catalog destination", async () => {
    const context = createContext();
    const base = importInput();
    const selection = await context.driver.selectImport?.(base);
    expect(selection).toMatchObject({
      kind: "provider",
      nativeId: "native-imported",
      providerPackRef: soldOffering.providerPackRef,
      providerInstallationRef: soldOffering.providerInstallationRef,
      placement: { kind: "catalog", offeringId: soldOffering.id },
    });
    if (selection?.kind !== "provider") {
      throw new Error("provider import selection was not returned");
    }

    await context.driver.import?.({
      ...base,
      operationId: "import-selection-exact",
      operationMode: "initial",
      selection,
      atomicDeploymentCommit: true,
    });
    expect(context.adoptCalls).toHaveLength(1);
    expect(context.adoptCalls[0]?.offering).toEqual(selection.technicalOffering);
    expect(context.adoptCalls[0]?.nativeId).toBe(selection.nativeId);
  });

  test("rejects native, provider, relation, and claim drift before adoption", async () => {
    const context = createContext();
    const base = importInput();
    const selection = await context.driver.selectImport?.(base);
    if (selection?.kind !== "provider") throw new Error("provider selection expected");

    await expect(
      context.driver.import?.({
        ...base,
        nativeId: "native-drift",
        operationId: "import-native-drift",
        selection,
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(context.adoptCalls).toHaveLength(0);

    context.offerings[0] = { ...technicalOffering, displayName: "Rotated provider offering" };
    await expect(
      context.driver.import?.({
        ...base,
        operationId: "import-provider-drift",
        selection,
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(context.adoptCalls).toHaveLength(0);

    const relationResource = resource("RelationTarget", "target", "target-uid");
    await context.deployments.create({
      tenantId,
      id: "target-deployment",
      resourceUid: relationResource.metadata.uid,
      offeringId: soldOffering.id,
      providerPackRef: soldOffering.providerPackRef,
      providerInstallationRef: soldOffering.providerInstallationRef,
      nativeId: "native-target",
      state: "active",
      observed: { value: "before" },
      outputs: {},
    });
    const related = importInput({
      relations: [
        {
          pointer: "/target",
          relation: "/target",
          targetUid: relationResource.metadata.uid,
          resource: relationResource,
        },
      ],
    });
    const relatedSelection = await context.driver.selectImport?.(related);
    if (relatedSelection?.kind !== "provider") {
      throw new Error("related provider selection expected");
    }
    expect(
      await context.deployments.refresh(
        tenantId,
        "target-deployment",
        "native-target",
        { value: "after" },
        {},
      ),
    ).toBe(true);
    await expect(
      context.driver.import?.({
        ...related,
        operationId: "import-relation-drift",
        selection: relatedSelection,
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(context.adoptCalls).toHaveLength(0);

    const claim = createContext();
    const claimSelection = await claim.driver.selectImport?.(base);
    if (!claimSelection) throw new Error("claim selection expected");
    await claim.deployments.create({
      tenantId,
      id: "other-deployment",
      resourceUid: "other-resource",
      offeringId: soldOffering.id,
      providerPackRef: soldOffering.providerPackRef,
      providerInstallationRef: soldOffering.providerInstallationRef,
      nativeId: "native-imported",
      state: "active",
      observed: {},
      outputs: {},
    });
    await expect(
      claim.driver.import?.({
        ...base,
        operationId: "import-claim-drift",
        selection: claimSelection,
      }),
    ).rejects.toMatchObject({ code: "import_conflict" });
    expect(claim.adoptCalls).toHaveLength(0);
  });

  test("recovery never reroutes after the pinned provider changes", async () => {
    const context = createContext();
    const base = importInput();
    const selection = await context.driver.selectImport?.(base);
    if (!selection) throw new Error("provider selection expected");
    context.offerings.splice(0, 1);

    await expect(
      context.driver.import?.({
        ...base,
        operationId: "import-selection-recovery",
        operationMode: "recovery",
        providerHandle: "retained-provider-handle",
        selection,
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(context.adoptCalls).toHaveLength(0);
    expect(context.pollCalls).toHaveLength(0);
  });

  test("rejects an installation-wide native claim before cross-tenant adoption", async () => {
    const context = createContext();
    await context.deployments.create({
      tenantId,
      id: "owned-deployment",
      resourceUid: "owned-resource",
      offeringId: soldOffering.id,
      providerPackRef: soldOffering.providerPackRef,
      providerInstallationRef: soldOffering.providerInstallationRef,
      nativeId: "native-imported",
      nativeClaimed: true,
      state: "active",
      observed: {},
      outputs: {},
    });
    const owned = importInput({ resourceUid: "owned-resource" });
    const selection = await context.driver.selectImport?.(owned);
    if (selection?.kind !== "provider") throw new Error("provider selection expected");

    const otherTenant = importInput({
      tenantId: "tenant-other",
      resourceUid: "other-resource",
    });
    await expect(
      context.driver.import?.({
        ...otherTenant,
        operationId: "cross-tenant-import",
        operationMode: "initial",
        selection,
      }),
    ).rejects.toMatchObject({ code: "import_conflict", status: 409 });
    expect(context.adoptCalls).toHaveLength(0);

    const differentInstallation = createContext();
    await differentInstallation.deployments.create({
      tenantId,
      id: "other-installation-deployment",
      resourceUid: "other-installation-resource",
      offeringId: soldOffering.id,
      providerPackRef: soldOffering.providerPackRef,
      providerInstallationRef: "import-provider.secondary",
      nativeId: "native-imported",
      nativeClaimed: true,
      state: "active",
      observed: {},
      outputs: {},
    });
    const independent = importInput({ resourceUid: "independent-resource" });
    const independentSelection = await differentInstallation.driver.selectImport?.(independent);
    if (independentSelection?.kind !== "provider") {
      throw new Error("provider selection expected for independent installation");
    }
    await differentInstallation.driver.import?.({
      ...independent,
      operationId: "independent-installation-import",
      operationMode: "initial",
      selection: independentSelection,
    });
    expect(differentInstallation.adoptCalls).toHaveLength(1);
  });

  test("rejects a same-resource candidate owner before provider callbacks", async () => {
    const context = createContext();
    await context.deployments.create({
      tenantId,
      id: "current-minted-deployment",
      resourceUid: "candidate-resource",
      offeringId: soldOffering.id,
      providerPackRef: soldOffering.providerPackRef,
      providerInstallationRef: soldOffering.providerInstallationRef,
      nativeId: "native-minted",
      state: "active",
      observed: {},
      outputs: {},
    });
    await context.deployments.create({
      tenantId,
      id: "candidate-owner-deployment",
      resourceUid: "candidate-resource",
      offeringId: soldOffering.id,
      providerPackRef: soldOffering.providerPackRef,
      providerInstallationRef: soldOffering.providerInstallationRef,
      nativeId: "native-imported",
      state: "candidate",
      observed: {},
      outputs: {},
    });

    await expect(
      context.driver.selectImport?.(importInput({ resourceUid: "candidate-resource" })),
    ).rejects.toMatchObject({ code: "import_conflict", status: 409 });
    expect(context.adoptCalls).toHaveLength(0);
  });

  test("SQLite import pins its saved database before ledger or suffix effects", async () => {
    const sql = createEphemeralSql();
    const sqliteTenantId = "tenant-sqlite-import-selection";
    const sqliteDatabaseFormRef = {
      apiVersion: "edge.forms.takoform.com/v1beta1",
      kind: "SQLiteDatabase",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"d".repeat(64)}` as const,
    };
    const sqliteApplicationForm: InstalledTakoformForm = {
      identity: {
        formRef: {
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "SQLiteMigrationApplication",
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"e".repeat(64)}` as const,
        },
      },
      role: "attachment",
      desiredSchema: { type: "object", additionalProperties: false },
      operations: ["create", "read", "delete", "import", "observe"],
    };
    const database = sqliteResource(sqliteDatabaseFormRef, "database", "sqlite-database");
    const relation = {
      pointer: "/database",
      relation: "/database",
      targetUid: database.metadata.uid,
      resource: database,
    };
    let readCalls = 0;
    let applyCalls = 0;
    const databaseOffering: ProviderOffering = {
      id: "sqlite-database",
      kind: "sqlite_database",
      displayName: "SQLite database",
      form: sqliteDatabaseFormRef,
      providedInterfaces: [],
      bindingRefs: [],
      capabilities: ["create", "delete", "import", "observe"],
    };
    const provider: Provider = {
      id: "sqlite-import-provider",
      offerings: [databaseOffering],
      async apply() {
        return succeeded({ nativeId: "unused", observed: {}, outputs: {} });
      },
      async observe(input) {
        return succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
      },
      async delete(input) {
        return succeeded({ nativeId: input.nativeId, observed: input.spec ?? {}, outputs: {} });
      },
      sqliteMigrations: {
        async readLedger() {
          readCalls += 1;
          return { ok: true, value: [] };
        },
        async applySuffix() {
          applyCalls += 1;
          return { ok: true, value: undefined };
        },
      },
    };
    const deployments = createResourceDeploymentStore(
      sql,
      () => new Date("2026-09-21T00:00:00.000Z"),
    );
    await deployments.create({
      tenantId: sqliteTenantId,
      id: "sqlite-database-deployment-a",
      resourceUid: database.metadata.uid,
      offeringId: databaseOffering.id,
      providerPackRef: provider.id,
      providerInstallationRef: "sqlite-import-provider.primary",
      nativeId: "sqlite-native-a",
      state: "active",
      observed: {},
      outputs: {},
    });
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([]),
      ledger: createLedger(sql, () => new Date("2026-09-21T00:00:00.000Z")),
      deployments,
    });
    const importInput = {
      executionAuthority: {
        tenantId: sqliteTenantId,
        resourceUid: "sqlite-application",
        leaseToken: "sqlite-import-lease",
        fingerprint: "sqlite-import-fingerprint",
      },
      tenantId: sqliteTenantId,
      resourceUid: "sqlite-application",
      form: sqliteApplicationForm,
      name: "application",
      space: "main",
      spec: { migration: "existing" },
      nativeId: "sqlite-application-native",
      relations: [relation],
    };
    const selection = await driver.selectImport?.(importInput);
    if (selection?.kind !== "sqlite-migration") {
      throw new Error("SQLite import selection was not returned");
    }

    // The import branch proves the saved snapshot and returns without asking
    // the provider to execute a migration itself.
    await expect(
      driver.import?.({
        ...importInput,
        operationId: "sqlite-import",
        operationMode: "initial",
        selection,
      }),
    ).resolves.toMatchObject({ observed: importInput.spec });

    const sqlite = driver.sqliteMigrations;
    if (!sqlite) throw new Error("Provider driver must expose SQLite migrations");
    await expect(
      sqlite.readLedger({ tenantId: sqliteTenantId, database, selection }),
    ).resolves.toEqual([]);
    await expect(
      sqlite.applySuffix({
        operationId: "sqlite-import",
        operationMode: "recovery",
        executionAuthority: importInput.executionAuthority,
        tenantId: sqliteTenantId,
        database,
        selection,
        desired: [],
        expectedPrefix: [],
        migrations: [],
      }),
    ).resolves.toBeUndefined();
    expect(readCalls).toBe(1);
    expect(applyCalls).toBe(1);

    await deployments.create({
      tenantId: sqliteTenantId,
      id: "sqlite-database-deployment-b",
      resourceUid: database.metadata.uid,
      offeringId: databaseOffering.id,
      providerPackRef: provider.id,
      providerInstallationRef: "sqlite-import-provider.primary",
      nativeId: "sqlite-native-b",
      state: "candidate",
      observed: {},
      outputs: {},
    });
    expect(
      await deployments.cutover(
        sqliteTenantId,
        database.metadata.uid,
        "sqlite-database-deployment-a",
        "sqlite-database-deployment-b",
      ),
    ).toBe(true);

    await expect(
      sqlite.readLedger({ tenantId: sqliteTenantId, database, selection }),
    ).rejects.toMatchObject({ code: "backend_unavailable", status: 503 });
    await expect(
      sqlite.applySuffix({
        operationId: "sqlite-import",
        operationMode: "recovery",
        executionAuthority: {
          ...importInput.executionAuthority,
          leaseToken: "sqlite-import-retry",
        },
        tenantId: sqliteTenantId,
        database,
        selection,
        desired: [],
        expectedPrefix: [],
        migrations: [],
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable", status: 503 });
    expect(readCalls).toBe(1);
    expect(applyCalls).toBe(1);
  });
});

function createContext() {
  const sql = createEphemeralSql();
  const deployments = createResourceDeploymentStore(
    sql,
    () => new Date("2026-09-21T00:00:00.000Z"),
  );
  const offerings = [technicalOffering];
  const adoptCalls: Parameters<NonNullable<Provider["adopt"]>>[0][] = [];
  const pollCalls: Parameters<NonNullable<Provider["poll"]>>[0][] = [];
  const provider: Provider = {
    id: soldOffering.providerPackRef,
    offerings,
    async apply() {
      return succeeded({ nativeId: "unused", observed: {}, outputs: {} });
    },
    async observe(input) {
      return succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
    },
    async delete(input) {
      return succeeded({ nativeId: input.nativeId, observed: input.spec ?? {}, outputs: {} });
    },
    async adopt(input) {
      adoptCalls.push(input);
      return succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
    },
    async poll(input) {
      pollCalls.push(input);
      return succeeded({ nativeId: "native-imported", observed: {}, outputs: {} });
    },
  };
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog([soldOffering]),
    ledger: createLedger(sql, () => new Date("2026-09-21T00:00:00.000Z")),
    deployments,
  });
  return { driver, deployments, offerings, adoptCalls, pollCalls };
}

function importInput(overrides: Partial<ImportSelectionInput> = {}): ImportSelectionInput {
  const base = {
    executionAuthority: {
      tenantId,
      resourceUid: "import-resource",
      leaseToken: "import-lease",
      fingerprint: "import-fingerprint",
    },
    tenantId,
    resourceUid: "import-resource",
    form,
    name: "imported",
    space: "main",
    spec: { value: "existing" },
    nativeId: "native-imported",
    relations: [],
  } satisfies ImportSelectionInput;
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    executionAuthority: {
      ...base.executionAuthority,
      ...(overrides.executionAuthority ?? {}),
      tenantId: overrides.executionAuthority?.tenantId ?? merged.tenantId,
      resourceUid: overrides.executionAuthority?.resourceUid ?? merged.resourceUid,
    },
  };
}

function resource(kind: string, name: string, uid: string): TakoformStoredResource {
  return {
    apiVersion: formRef.apiVersion,
    kind,
    form: {
      formRef: {
        ...formRef,
        kind,
      },
    },
    metadata: {
      name,
      space: "main",
      uid,
      generation: "1",
      revision: "1",
    },
    spec: {},
    status: {
      observedGeneration: "1",
      conditions: [],
    },
  };
}

function sqliteResource(
  formRef: InstalledTakoformForm["identity"]["formRef"],
  name: string,
  uid: string,
): TakoformStoredResource {
  return {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: { formRef },
    metadata: {
      name,
      space: "main",
      uid,
      generation: "1",
      revision: "1",
    },
    spec: {},
    status: {
      observedGeneration: "1",
      conditions: [],
    },
  };
}
