import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  TAKOFORM_IMPORT_SELECTION_VERSION,
  type TakoformImportSelection,
} from "../src/takoform/import-selection.ts";
import { createTakoformStore, type ProviderMutationSaga } from "../src/takoform/store.ts";

const saga: ProviderMutationSaga = {
  operationId: "op_import_selection",
  operationKind: "import",
  tenantId: "tenant-import",
  replayKey: "replay-import-selection",
  resourceUid: "uid_import_selection",
  fingerprint: "import-fingerprint",
  target: {
    tenantId: "tenant-import",
    space: "main",
    apiVersion: "example.forms.invalid",
    kind: "Thing",
    name: "imported",
  },
};
const selection: TakoformImportSelection = {
  version: TAKOFORM_IMPORT_SELECTION_VERSION,
  kind: "intrinsic",
  nativeId: "native-import",
};
const identity = {
  tenantId: saga.tenantId,
  operationId: saga.operationId,
  resourceUid: saga.resourceUid,
};
const bind = {
  ...identity,
  fingerprint: saga.fingerprint,
  leaseToken: "lease-import",
  mode: "initial" as const,
  selection,
};

const providerSelection = {
  version: TAKOFORM_IMPORT_SELECTION_VERSION,
  kind: "provider",
  nativeId: "shared-native-import",
  providerPackRef: "provider-import",
  providerInstallationRef: "provider-import.primary",
  technicalOffering: {
    id: "import-offering",
    kind: "Thing",
    displayName: "Thing",
    form: {
      apiVersion: "example.forms.invalid",
      kind: "Thing",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["import"],
  },
  placement: { kind: "catalog", offeringId: "import-offering" },
  relations: [],
} as const satisfies TakoformImportSelection;

test("only one tenant reserves a native import destination through receipt publication", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
    const commands = ["one", "two"].map((suffix) => {
      const tenantId = `tenant-${suffix}`;
      return {
        ...saga,
        tenantId,
        operationId: `op-${suffix}`,
        resourceUid: `uid-${suffix}`,
        replayKey: `replay-${suffix}`,
        target: { ...saga.target, tenantId },
      };
    });
    for (const command of commands) {
      await store.acceptProviderMutationSaga(command);
      expect(
        database
          .query(
            "SELECT import_selection_protocol FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
          )
          .get(command.operationId),
      ).toEqual({ import_selection_protocol: 1 });
      await store.acquireProviderMutationExecution({
        tenantId: command.tenantId,
        operationId: command.operationId,
        resourceUid: command.resourceUid,
        leaseToken: "lease-import",
        leaseUntil: 2_000,
      });
    }
    const inputs = commands.map((command) => ({
      ...bind,
      tenantId: command.tenantId,
      operationId: command.operationId,
      resourceUid: command.resourceUid,
      selection: providerSelection,
    }));
    const result = await Promise.all(
      inputs.map((input) => store.bindProviderMutationImportSelection(input)),
    );
    expect(result.filter(Boolean)).toHaveLength(1);
    const winner = inputs[result.findIndex(Boolean)];
    const loser = inputs[result.indexOf(null)];
    if (!winner || !loser) throw new Error("expected one import reservation winner");
    expect(await store.markProviderMutationDispatch(winner)).toBe(true);
    expect(await store.markProviderMutationDispatch(loser)).toBe(false);
    await store.recordProviderMutationReceipt({ ...winner, receipt: { observed: {} } });
    expect(await store.bindProviderMutationImportSelection(loser)).toBeNull();
    // Even a direct writer bypassing the selector cannot drop the reservation
    // during executed-but-uncommitted receipt retention.
    expect(() =>
      database
        .query(
          `UPDATE tf_provider_mutation_sagas_selection_v1 SET import_selection_json = (SELECT import_selection_json FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?) WHERE operation_id = ?`,
        )
        .run(winner.operationId, loser.operationId),
    ).toThrow("UNIQUE");
    expect(
      await store.bindProviderMutationImportSelection({
        ...loser,
        selection: { ...providerSelection, providerInstallationRef: "provider-import.other" },
      }),
    ).toMatchObject({ providerInstallationRef: "provider-import.other" });
  } finally {
    database.close();
  }
});

test("import bind checks existing installation-wide native owners in the same write", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const clock = () => new Date(1_000);
    const store = createTakoformStore(sql, clock);
    const deployments = createResourceDeploymentStore(sql, clock);
    await deployments.create({
      tenantId: "foreign-tenant",
      id: "foreign-deployment",
      resourceUid: "foreign-resource",
      offeringId: "import-offering",
      providerPackRef: providerSelection.providerPackRef,
      providerInstallationRef: providerSelection.providerInstallationRef,
      nativeId: providerSelection.nativeId,
      nativeClaimed: true,
      state: "active",
      observed: {},
      outputs: {},
    });
    await store.acceptProviderMutationSaga(saga);
    await store.acquireProviderMutationExecution({
      ...identity,
      leaseToken: bind.leaseToken,
      leaseUntil: 2_000,
    });
    expect(
      await store.bindProviderMutationImportSelection({ ...bind, selection: providerSelection }),
    ).toBeNull();
    expect(
      database
        .query("SELECT import_selection_json FROM tf_provider_mutation_sagas_selection_v1")
        .get(),
    ).toEqual({ import_selection_json: null });
    const ownNative = "own-minted-native";
    await deployments.create({
      tenantId: saga.tenantId,
      id: "own-deployment",
      resourceUid: saga.resourceUid,
      offeringId: "import-offering",
      providerPackRef: providerSelection.providerPackRef,
      providerInstallationRef: providerSelection.providerInstallationRef,
      nativeId: ownNative,
      nativeClaimed: false,
      state: "active",
      observed: {},
      outputs: {},
    });
    expect(
      await store.bindProviderMutationImportSelection({
        ...bind,
        selection: { ...providerSelection, nativeId: ownNative },
      }),
    ).toBeNull();
    expect(
      await store.bindProviderMutationImportSelection({
        ...bind,
        selection: {
          ...providerSelection,
          nativeId: ownNative,
          incumbent: {
            id: "own-deployment",
            resourceUid: saga.resourceUid,
            offeringId: "import-offering",
            providerPackRef: providerSelection.providerPackRef,
            providerInstallationRef: providerSelection.providerInstallationRef,
            nativeId: ownNative,
            nativeClaimed: false,
            state: "active",
            projectionDigest: `sha256:${"b".repeat(64)}`,
          },
        },
      }),
    ).toMatchObject({ nativeId: ownNative });
  } finally {
    database.close();
  }
});

test("import bind fences command identity and preserves selection across lease rotation", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    let now = 1_000;
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    await store.acceptProviderMutationSaga(saga);
    await store.acquireProviderMutationExecution({
      ...identity,
      leaseToken: bind.leaseToken,
      leaseUntil: 2_000,
    });
    for (const invalid of [
      { ...bind, tenantId: "wrong-tenant" },
      { ...bind, resourceUid: "wrong-resource" },
      { ...bind, operationId: "wrong-operation" },
      { ...bind, fingerprint: "wrong-fingerprint" },
      { ...bind, leaseToken: "stale-lease" },
      { ...bind, mode: "recovery" as const },
    ])
      expect(await store.bindProviderMutationImportSelection(invalid)).toBeNull();
    expect(await store.bindProviderMutationImportSelection(bind)).toEqual(selection);
    expect(await store.bindProviderMutationImportSelection(bind)).toEqual(selection);
    expect(
      await store.bindProviderMutationImportSelection({
        ...bind,
        selection: { ...selection, nativeId: "other-native" },
      }),
    ).toBeNull();
    await store.releaseProviderMutationExecution({ ...identity, leaseToken: bind.leaseToken });
    expect(
      await store.abandonProviderMutationPlan({ ...identity, replayKey: saga.replayKey }),
    ).toBe(false);
    expect(
      await store.acquireProviderMutationExecution({
        ...identity,
        leaseToken: "lease-next",
        leaseUntil: 2_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial", importSelection: selection });
    // A snapshot verified for the old lease cannot authorize the new dispatch.
    expect(
      await store.markProviderMutationDispatch({ ...identity, leaseToken: "lease-next" }),
    ).toBe(false);
    expect(
      await store.bindProviderMutationImportSelection({ ...bind, leaseToken: "lease-next" }),
    ).toEqual(selection);
    expect(
      await store.markProviderMutationDispatch({ ...identity, leaseToken: "lease-next" }),
    ).toBe(true);
    now = 2_001;
    expect(
      await store.acquireProviderMutationExecution({
        ...identity,
        leaseToken: "lease-recovery",
        leaseUntil: 3_000,
      }),
    ).toEqual({ kind: "acquired", mode: "recovery", importSelection: selection });
    expect(
      await store.bindProviderMutationImportSelection({
        ...bind,
        leaseToken: "lease-recovery",
        mode: "initial",
      }),
    ).toBeNull();
    expect(
      await store.bindProviderMutationImportSelection({
        ...bind,
        leaseToken: "lease-recovery",
        mode: "recovery",
      }),
    ).toEqual(selection);
    now = 3_000;
    expect(
      await store.bindProviderMutationImportSelection({
        ...bind,
        leaseToken: "lease-recovery",
        mode: "recovery",
      }),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test("import selection and deferred retention commit atomically without extending leases", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
    await store.acceptDeferredOperation({
      id: saga.operationId,
      tenantId: saga.tenantId,
      principalId: "principal-import",
      operation: "import",
      phase: "pending",
      requestPath: "/resources/Thing/imported/import",
      requestQuery: "",
      requestHeaders: {},
      fingerprint: saga.fingerprint,
      replayKey: saga.replayKey,
      target: {
        ...saga.target,
        formRef: {
          apiVersion: saga.target.apiVersion,
          kind: saga.target.kind,
          definitionVersion: "1.0.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      resourceUid: saga.resourceUid,
      pollsRemaining: 1,
      createdAt: new Date(1_000).toISOString(),
    });
    const hostLease = {
      tenantId: saga.tenantId,
      principalId: "principal-import",
      id: saga.operationId,
      leaseToken: "lease-host",
      leaseUntil: 5_000,
    };
    await store.advanceDeferredOperation(hostLease);
    expect((await store.advanceDeferredOperation(hostLease)).acquired).toBe(true);
    await store.acceptProviderMutationSaga(saga);
    await store.acquireProviderMutationExecution({
      ...identity,
      leaseToken: bind.leaseToken,
      leaseUntil: 2_000,
    });
    const state = () => ({
      saga: database
        .query(
          "SELECT import_selection_json, expires_at, execution_lease_until FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?",
        )
        .get(saga.operationId),
      deferred: database
        .query(
          "SELECT expires_at, lease_until FROM tf_deferred_operations_selection_v1 WHERE id = ?",
        )
        .get(saga.operationId),
    });
    const before = state();
    database.exec(
      `CREATE TRIGGER reject_import_retention BEFORE UPDATE OF expires_at ON tf_deferred_operations_selection_v1 WHEN NEW.expires_at = 253402300799999 BEGIN SELECT RAISE(ABORT, 'retention_constraint'); END;`,
    );
    await expect(store.bindProviderMutationImportSelection(bind)).rejects.toThrow(
      "retention_constraint",
    );
    expect(state()).toEqual(before);
    database.exec("DROP TRIGGER reject_import_retention");
    expect(await store.bindProviderMutationImportSelection(bind)).toEqual(selection);
    expect(state()).toEqual({
      saga: {
        import_selection_json: expect.any(String),
        expires_at: 253402300799999,
        execution_lease_until: 2_000,
      },
      deferred: { expires_at: 253402300799999, lease_until: 5_000 },
    });
  } finally {
    database.close();
  }
});
