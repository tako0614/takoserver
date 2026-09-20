import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  TAKOFORM_APPLY_SELECTION_VERSION,
  type TakoformApplySelection,
} from "../src/takoform/apply-selection.ts";
import { OPERATION_TTL_MILLISECONDS } from "../src/takoform/limits.ts";
import { createTakoformStore, type ProviderMutationSaga } from "../src/takoform/store.ts";

const saga: ProviderMutationSaga = {
  operationId: "op_execution_lease",
  operationKind: "apply",
  replayKey: "replay-execution-lease",
  tenantId: "tenant-a",
  fingerprint: '{"request":"same"}',
  resourceUid: "uid_execution_lease",
  target: {
    tenantId: "tenant-a",
    space: "main",
    apiVersion: "example.forms.invalid",
    kind: "Thing",
    name: "leased",
  },
};

const applySelection: TakoformApplySelection = {
  version: TAKOFORM_APPLY_SELECTION_VERSION,
  kind: "provider",
  providerPackRef: "provider-a",
  providerInstallationRef: "provider-a.primary",
  technicalOffering: {
    id: "provider-a.thing",
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
    capabilities: ["create", "update"],
  },
  relations: [],
};

describe("provider mutation saga execution leases", () => {
  test("retains an accepted selection across the ordinary plan expiry before dispatch", async () => {
    const database = new Database(":memory:");
    try {
      migrateSqlite(database);
      let now = 1_000;
      const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
      const identity = {
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
      };
      await store.acceptProviderMutationSaga(saga);
      await store.acquireProviderMutationExecution({
        ...identity,
        leaseToken: "lease_before_preparation",
        leaseUntil: now + 1_000,
      });
      expect(
        await store.bindProviderMutationApplySelection({
          ...identity,
          fingerprint: saga.fingerprint,
          leaseToken: "lease_before_preparation",
          mode: "initial",
          selection: applySelection,
        }),
      ).toEqual(applySelection);

      // A preparation callback may have started after accepting the selection,
      // even though dispatch has not been marked. Age alone proves no absence.
      now += OPERATION_TTL_MILLISECONDS + 1;
      await store.acceptProviderMutationSaga({
        ...saga,
        operationId: "op_sweep_unrelated",
        replayKey: "replay-sweep-unrelated",
        resourceUid: "uid_sweep_unrelated",
        target: { ...saga.target, name: "sweep-unrelated" },
      });
      expect(
        database
          .query(
            `SELECT selection_json, execution_started_at
             FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
          )
          .get(saga.operationId),
      ).toMatchObject({
        selection_json: expect.any(String),
        execution_started_at: null,
      });
      expect(await store.acceptProviderMutationSaga(saga)).toEqual(saga);
      expect(
        await store.acquireProviderMutationExecution({
          ...identity,
          leaseToken: "lease_after_preparation_timeout",
          leaseUntil: now + 1_000,
        }),
      ).toEqual({ kind: "acquired", mode: "initial", applySelection });
      expect(
        await store.bindProviderMutationApplySelection({
          ...identity,
          fingerprint: saga.fingerprint,
          leaseToken: "lease_after_preparation_timeout",
          mode: "initial",
          selection: { ...applySelection, providerPackRef: "provider-b" },
        }),
      ).toBeNull();
    } finally {
      database.close();
    }
  });

  test("binds one immutable apply selection and requires each recovery lease to verify it", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    let now = 1_000;
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    const selectedSaga = {
      ...saga,
      operationId: "op_selected_apply",
      replayKey: "replay-selected-apply",
      resourceUid: "uid_selected_apply",
      target: { ...saga.target, name: "selected-apply" },
    };
    const identity = {
      tenantId: selectedSaga.tenantId,
      operationId: selectedSaga.operationId,
      resourceUid: selectedSaga.resourceUid,
    };
    await store.acceptProviderMutationSaga(selectedSaga);
    expect(
      await store.acquireProviderMutationExecution({
        ...identity,
        leaseToken: "lease_initial",
        leaseUntil: 2_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial" });
    expect(
      await store.bindProviderMutationApplySelection({
        ...identity,
        fingerprint: selectedSaga.fingerprint,
        leaseToken: "lease_initial",
        mode: "initial",
        selection: applySelection,
      }),
    ).toEqual(applySelection);
    expect(
      await store.bindProviderMutationApplySelection({
        ...identity,
        fingerprint: selectedSaga.fingerprint,
        leaseToken: "lease_stale",
        mode: "initial",
        selection: applySelection,
      }),
    ).toBeNull();
    expect(
      await store.markProviderMutationDispatch({ ...identity, leaseToken: "lease_initial" }),
    ).toBe(true);

    now = 2_001;
    expect(
      await store.acquireProviderMutationExecution({
        ...identity,
        leaseToken: "lease_recovery",
        leaseUntil: 3_000,
      }),
    ).toEqual({
      kind: "acquired",
      mode: "recovery",
      applySelection,
    });
    expect(
      await store.markProviderMutationDispatch({
        ...identity,
        leaseToken: "lease_recovery",
        mode: "recovery",
      }),
    ).toBe(false);
    expect(
      await store.releaseProviderMutationExecution({
        ...identity,
        leaseToken: "lease_recovery",
      }),
    ).toBe(true);
    expect(
      await store.acquireProviderMutationExecution({
        ...identity,
        leaseToken: "lease_verified_recovery",
        leaseUntil: 3_000,
      }),
    ).toMatchObject({ kind: "acquired", mode: "recovery", applySelection });
    expect(
      await store.bindProviderMutationApplySelection({
        ...identity,
        fingerprint: selectedSaga.fingerprint,
        leaseToken: "lease_verified_recovery",
        mode: "recovery",
        selection: { ...applySelection, providerPackRef: "provider-b" },
      }),
    ).toBeNull();
    expect(
      await store.bindProviderMutationApplySelection({
        ...identity,
        fingerprint: selectedSaga.fingerprint,
        leaseToken: "lease_verified_recovery",
        mode: "recovery",
        selection: applySelection,
      }),
    ).toEqual(applySelection);
    expect(
      database
        .query(
          `SELECT execution_lease_token, selection_verified_lease_token,
                  execution_started_at, execution_lease_until
           FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
        )
        .get(selectedSaga.operationId),
    ).toEqual({
      execution_lease_token: "lease_verified_recovery",
      selection_verified_lease_token: "lease_verified_recovery",
      execution_started_at: 1_000,
      execution_lease_until: 3_000,
    });
    expect(
      await store.markProviderMutationDispatch({
        ...identity,
        leaseToken: "lease_verified_recovery",
        mode: "recovery",
      }),
    ).toBe(true);
    database.close();
  });

  test("retains a selected deferred apply atomically without extending either execution lease", async () => {
    const database = new Database(":memory:");
    try {
      migrateSqlite(database);
      const now = 1_000;
      const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
      await store.acceptDeferredOperation({
        id: saga.operationId,
        tenantId: saga.tenantId,
        principalId: "principal-a",
        operation: "apply",
        phase: "pending",
        requestPath: "/resources/Thing/leased",
        requestQuery: "?space=main",
        requestHeaders: {},
        fingerprint: saga.fingerprint,
        replayKey: saga.replayKey,
        target: { ...saga.target, formRef: applySelection.technicalOffering.form },
        resourceUid: saga.resourceUid,
        pollsRemaining: 1,
        createdAt: new Date(now).toISOString(),
      });
      await store.advanceDeferredOperation({
        tenantId: saga.tenantId,
        principalId: "principal-a",
        id: saga.operationId,
        leaseToken: "host_lease",
        leaseUntil: 5_000,
      });
      expect(
        (
          await store.advanceDeferredOperation({
            tenantId: saga.tenantId,
            principalId: "principal-a",
            id: saga.operationId,
            leaseToken: "host_lease",
            leaseUntil: 5_000,
          })
        ).acquired,
      ).toBe(true);
      await store.acceptProviderMutationSaga(saga);
      await store.acquireProviderMutationExecution({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        leaseToken: "provider_lease",
        leaseUntil: 2_000,
      });
      const input = {
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        fingerprint: saga.fingerprint,
        leaseToken: "provider_lease",
        mode: "initial" as const,
        selection: applySelection,
      };
      const state = () => ({
        saga: database
          .query(
            `SELECT expires_at, execution_lease_until, selection_json
             FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id = ?`,
          )
          .get(saga.operationId),
        deferred: database
          .query(
            "SELECT expires_at, lease_until FROM tf_deferred_operations_selection_v1 WHERE id = ?",
          )
          .get(saga.operationId),
      });
      const before = state();
      for (const invalid of [
        { ...input, fingerprint: "different-command" },
        { ...input, leaseToken: "stale_lease" },
        { ...input, mode: "recovery" as const },
      ]) {
        expect(await store.bindProviderMutationApplySelection(invalid)).toBeNull();
        expect(state()).toEqual(before);
      }
      database.exec(`
        CREATE TRIGGER test_reject_deferred_selection_retention
        BEFORE UPDATE OF expires_at ON tf_deferred_operations_selection_v1
        WHEN NEW.expires_at = 253402300799999
        BEGIN
          SELECT RAISE(ABORT, 'selection_retention_constraint');
        END;
      `);
      await expect(store.bindProviderMutationApplySelection(input)).rejects.toThrow(
        "selection_retention_constraint",
      );
      expect(state()).toEqual(before);
      database.exec("DROP TRIGGER test_reject_deferred_selection_retention");

      expect(await store.bindProviderMutationApplySelection(input)).toEqual(applySelection);
      expect(state()).toEqual({
        saga: {
          expires_at: 253402300799999,
          execution_lease_until: 2_000,
          selection_json: expect.any(String),
        },
        deferred: { expires_at: 253402300799999, lease_until: 5_000 },
      });
    } finally {
      database.close();
    }
  });

  test("refuses to dispatch a current apply before its selection is bound", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    let now = 1_000;
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    const historicalSaga = {
      ...saga,
      operationId: "op_historical_unselected_apply",
      replayKey: "replay-historical-unselected-apply",
      resourceUid: "uid_historical_unselected_apply",
      target: { ...saga.target, name: "historical-unselected-apply" },
    };
    const identity = {
      tenantId: historicalSaga.tenantId,
      operationId: historicalSaga.operationId,
      resourceUid: historicalSaga.resourceUid,
    };
    await store.acceptProviderMutationSaga(historicalSaga);
    await store.acquireProviderMutationExecution({
      ...identity,
      leaseToken: "lease_old_binary",
      leaseUntil: 2_000,
    });
    expect(
      await store.markProviderMutationDispatch({ ...identity, leaseToken: "lease_old_binary" }),
    ).toBe(false);
    now = 2_001;
    expect(
      await store.acquireProviderMutationExecution({
        ...identity,
        leaseToken: "lease_current_binary",
        leaseUntil: 3_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial" });
    expect(
      await store.bindProviderMutationApplySelection({
        ...identity,
        fingerprint: historicalSaga.fingerprint,
        leaseToken: "lease_current_binary",
        mode: "recovery",
        selection: applySelection,
      }),
    ).toBeNull();
    database.close();
  });

  test("only explicit whole-operation apply proof and the current lease retire an indeterminate create", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    let now = 1_000;
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    const identity = {
      tenantId: saga.tenantId,
      operationId: saga.operationId,
      resourceUid: saga.resourceUid,
    };
    await store.acceptProviderMutationSaga(saga);
    await store.acquireProviderMutationExecution({
      ...identity,
      leaseToken: "old",
      leaseUntil: 2_000,
    });
    expect(
      await store.bindProviderMutationApplySelection({
        ...identity,
        fingerprint: saga.fingerprint,
        leaseToken: "old",
        mode: "initial",
        selection: applySelection,
      }),
    ).toEqual(applySelection);
    await store.markProviderMutationDispatch({ ...identity, leaseToken: "old" });
    await store.recordProviderMutationOutcome({
      ...identity,
      leaseToken: "old",
      outcome: "indeterminate",
    });
    now = 2_001;
    expect(
      await store.acquireProviderMutationExecution({
        ...identity,
        leaseToken: "current",
        leaseUntil: 3_000,
      }),
    ).toMatchObject({ kind: "acquired", mode: "recovery" });
    expect(
      await store.settleProviderMutationPreconditionFailure({ ...identity, leaseToken: "current" }),
    ).toBe(false);
    expect(
      await store.settleProviderMutationPreconditionFailure({
        ...identity,
        leaseToken: "old",
        recoveryAction: "convergeApply",
      }),
    ).toBe(false);
    await expect(
      store.settleProviderMutationPreconditionFailure({
        ...identity,
        leaseToken: "current",
        recoveryAction: "recoverAdopt" as "convergeApply",
      }),
    ).rejects.toThrow("invalid provider refusal recovery action");
    expect(
      await store.settleProviderMutationPreconditionFailure({
        ...identity,
        leaseToken: "current",
        recoveryAction: "convergeApply",
      }),
    ).toBe(true);
    await expect(
      store.recordProviderMutationReceipt({
        ...identity,
        leaseToken: "old",
        receipt: { observed: { late: true } },
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(
      await store.providerMutationPlanExists(saga.tenantId, saga.operationId, saga.resourceUid),
    ).toBe(false);
    database.close();
  });
  test("fences concurrent and stale executors while preserving one idempotent receipt", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    let now = 1_000;
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    await store.acceptProviderMutationSaga(saga);

    const [first, concurrent] = await Promise.all([
      store.acquireProviderMutationExecution({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        leaseToken: "lease_first",
        leaseUntil: 2_000,
      }),
      store.acquireProviderMutationExecution({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        leaseToken: "lease_concurrent",
        leaseUntil: 2_000,
      }),
    ]);
    expect([first.kind, concurrent.kind].sort()).toEqual(["acquired", "busy"]);
    const firstOwner = first.kind === "acquired" ? first : concurrent;
    expect(firstOwner).toMatchObject({ kind: "acquired", mode: "initial" });
    const firstToken = first === firstOwner ? "lease_first" : "lease_concurrent";
    expect(
      await store.bindProviderMutationApplySelection({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        fingerprint: saga.fingerprint,
        leaseToken: firstToken,
        mode: "initial",
        selection: applySelection,
      }),
    ).toEqual(applySelection);
    expect(
      await store.markProviderMutationDispatch({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        leaseToken: firstToken,
      }),
    ).toBe(true);

    now = 2_001;
    const recovered = await store.acquireProviderMutationExecution({
      tenantId: saga.tenantId,
      operationId: saga.operationId,
      resourceUid: saga.resourceUid,
      leaseToken: "lease_recovered",
      leaseUntil: 3_001,
    });
    expect(recovered).toEqual({ kind: "acquired", mode: "recovery", applySelection });

    database
      .query(
        `INSERT INTO tf_resource_claims
           (claim_key, tenant_id, holder_space, holder_api_version, holder_kind,
            holder_name, holder_uid, owner_operation_id, state, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
      )
      .run(
        "claim:leased",
        saga.tenantId,
        saga.target.space,
        saga.target.apiVersion,
        saga.target.kind,
        saga.target.name,
        saga.resourceUid,
        "outer_stale",
        9_001,
        now,
      );
    database
      .query(
        `INSERT INTO tf_deferred_operations_selection_v1
           (id, protocol_generation, tenant_id, principal_id, operation, phase, request_path, request_query,
            request_headers_json, request_body_json, fingerprint, replay_key,
            target_space, target_api_version, target_kind, target_name,
            target_form_ref_json, accepted_uid, accepted_generation, accepted_revision,
            resource_uid, polls_remaining, lease_token, lease_until, terminal_json,
            committed_uid, created_at, updated_at, expires_at)
         VALUES (?, 1, ?, 'principal-a', 'apply', 'committing', '/', '', '{}', '{}', ?,
                 'deferred-replay-execution-lease', ?, ?, ?, ?, '{}', NULL, NULL, NULL,
                 ?, 0, 'outer_recovered', 3001, NULL, NULL,
                 '2026-08-28T00:00:00.000Z', ?, 9001)`,
      )
      .run(
        saga.operationId,
        saga.tenantId,
        saga.fingerprint,
        saga.target.space,
        saga.target.apiVersion,
        saga.target.kind,
        saga.target.name,
        saga.resourceUid,
        now,
      );

    const receipt = { observed: { providerId: "native-one" } };
    await expect(
      store.recordProviderMutationReceipt({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        leaseToken: firstToken,
        claimOwnerId: "outer_stale",
        receipt,
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(
      database
        .query("SELECT state, expires_at FROM tf_resource_claims WHERE claim_key = ?")
        .get("claim:leased"),
    ).toEqual({ state: "reserved", expires_at: 9_001 });
    expect(
      database
        .query(
          `SELECT lease_token, lease_until, updated_at, expires_at
           FROM tf_deferred_operations_selection_v1 WHERE id = ?`,
        )
        .get(saga.operationId),
    ).toEqual({
      lease_token: "outer_recovered",
      lease_until: 3_001,
      updated_at: 2_001,
      expires_at: 9_001,
    });

    expect(
      await store.releaseProviderMutationExecution({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        leaseToken: "lease_recovered",
      }),
    ).toBe(true);
    const retry = await store.acquireProviderMutationExecution({
      tenantId: saga.tenantId,
      operationId: saga.operationId,
      resourceUid: saga.resourceUid,
      leaseToken: "lease_retry",
      leaseUntil: 3_001,
    });
    expect(retry).toEqual({ kind: "acquired", mode: "recovery", applySelection });
    await store.recordProviderMutationReceipt({
      tenantId: saga.tenantId,
      operationId: saga.operationId,
      resourceUid: saga.resourceUid,
      leaseToken: "lease_retry",
      receipt,
    });

    expect(
      await store.acquireProviderMutationExecution({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        leaseToken: "lease_after_execution",
        leaseUntil: 4_001,
      }),
    ).toEqual({ kind: "executed", receipt });
    await expect(
      store.recordProviderMutationReceipt({
        tenantId: saga.tenantId,
        operationId: saga.operationId,
        resourceUid: saga.resourceUid,
        leaseToken: "lease_stale_but_same_receipt",
        receipt,
      }),
    ).resolves.toBeUndefined();
    database.close();
  });

  test("a lease released before provider dispatch remains an initial execution", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
    await store.acceptProviderMutationSaga({
      ...saga,
      operationId: "op_preflight_retry",
      replayKey: "replay-preflight-retry",
      resourceUid: "uid_preflight_retry",
      target: { ...saga.target, name: "preflight-retry" },
    });

    expect(
      await store.acquireProviderMutationExecution({
        tenantId: saga.tenantId,
        operationId: "op_preflight_retry",
        resourceUid: "uid_preflight_retry",
        leaseToken: "lease_preflight_failure",
        leaseUntil: 2_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial" });
    expect(
      await store.releaseProviderMutationExecution({
        tenantId: saga.tenantId,
        operationId: "op_preflight_retry",
        resourceUid: "uid_preflight_retry",
        leaseToken: "lease_preflight_failure",
      }),
    ).toBe(true);
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: saga.tenantId,
        operationId: "op_preflight_retry",
        resourceUid: "uid_preflight_retry",
        leaseToken: "lease_preflight_retry",
        leaseUntil: 2_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial" });
    database.close();
  });

  test("abandons undispatched apply and delete plans without leaving an immortal target fence", async () => {
    const database = new Database(":memory:");
    try {
      migrateSqlite(database);
      const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
      for (const operationKind of ["apply", "delete"] as const) {
        const candidate: ProviderMutationSaga = {
          ...saga,
          operationKind,
          operationId: `op_abandon_${operationKind}`,
          replayKey: `replay-abandon-${operationKind}`,
          resourceUid: `uid_abandon_${operationKind}`,
          target: { ...saga.target, name: `abandon-${operationKind}` },
          ...(operationKind === "delete"
            ? {
                acceptedUid: `uid_abandon_${operationKind}`,
                acceptedGeneration: "1",
                acceptedRevision: "revision-one",
              }
            : {}),
        };
        await store.acceptProviderMutationSaga(candidate);
        expect(
          await store.abandonProviderMutationPlan({
            tenantId: candidate.tenantId,
            operationId: candidate.operationId,
            replayKey: candidate.replayKey,
            resourceUid: candidate.resourceUid,
          }),
        ).toBe(true);
        expect(
          await store.providerMutationPlanExists(
            candidate.tenantId,
            candidate.operationId,
            candidate.resourceUid,
          ),
        ).toBe(false);
      }
    } finally {
      database.close();
    }
  });

  test("a post-dispatch plan cannot be abandoned back into an initial execution", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
    const postDispatchSaga: ProviderMutationSaga = {
      ...saga,
      operationKind: "import",
      operationId: "op_post_dispatch_preflight",
      replayKey: "replay-post-dispatch-preflight",
      resourceUid: "uid_post_dispatch_preflight",
      target: { ...saga.target, name: "post-dispatch-preflight" },
    };
    await store.acceptProviderMutationSaga(postDispatchSaga);

    expect(
      await store.acquireProviderMutationExecution({
        tenantId: postDispatchSaga.tenantId,
        operationId: postDispatchSaga.operationId,
        resourceUid: postDispatchSaga.resourceUid,
        leaseToken: "lease_post_dispatch",
        leaseUntil: 2_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial" });
    expect(
      await store.markProviderMutationDispatch({
        tenantId: postDispatchSaga.tenantId,
        operationId: postDispatchSaga.operationId,
        resourceUid: postDispatchSaga.resourceUid,
        leaseToken: "lease_post_dispatch",
      }),
    ).toBe(true);
    expect(
      await store.releaseProviderMutationExecution({
        tenantId: postDispatchSaga.tenantId,
        operationId: postDispatchSaga.operationId,
        resourceUid: postDispatchSaga.resourceUid,
        leaseToken: "lease_post_dispatch",
      }),
    ).toBe(true);

    // A later retry can fail during read-only preflight and run the generic
    // cleanup path. That cleanup must preserve evidence of the earlier handoff.
    expect(
      await store.abandonProviderMutationPlan({
        tenantId: postDispatchSaga.tenantId,
        operationId: postDispatchSaga.operationId,
        replayKey: postDispatchSaga.replayKey,
        resourceUid: postDispatchSaga.resourceUid,
      }),
    ).toBe(false);
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: postDispatchSaga.tenantId,
        operationId: postDispatchSaga.operationId,
        resourceUid: postDispatchSaga.resourceUid,
        leaseToken: "lease_after_preflight_failure",
        leaseUntil: 2_000,
      }),
    ).toEqual({ kind: "acquired", mode: "recovery" });
    database.close();
  });

  test("only the current exact lease settles a closed definitive import outcome", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    let now = 1_000;
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    const staleImportSaga: ProviderMutationSaga = {
      ...saga,
      operationKind: "import",
      operationId: "op_stale_import_conflict",
      replayKey: "replay-stale-import-conflict",
      resourceUid: "uid_stale_import_conflict",
      target: { ...saga.target, name: "stale-import-conflict" },
    };
    await store.acceptProviderMutationSaga(staleImportSaga);
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_stale_import",
        leaseUntil: 2_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial" });
    expect(
      await store.markProviderMutationDispatch({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_stale_import",
      }),
    ).toBe(true);

    now = 2_001;
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_recovered_import",
        leaseUntil: 3_001,
      }),
    ).toEqual({ kind: "acquired", mode: "recovery" });
    expect(
      await store.settleDefinitiveProviderImportFailure({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        replayKey: staleImportSaga.replayKey,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_stale_import",
        outcome: "import_conflict",
      }),
    ).toBe(false);
    expect(
      await store.releaseProviderMutationExecution({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_recovered_import",
      }),
    ).toBe(true);
    expect(
      await store.settleDefinitiveProviderImportFailure({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        replayKey: staleImportSaga.replayKey,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_stale_import",
        outcome: "adoption_aborted",
      }),
    ).toBe(false);
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_after_stale_import",
        leaseUntil: 3_001,
      }),
    ).toEqual({ kind: "acquired", mode: "recovery" });
    await expect(
      store.settleDefinitiveProviderImportFailure({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        replayKey: staleImportSaga.replayKey,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_after_stale_import",
        outcome: "not_definitive" as "adoption_aborted",
      }),
    ).rejects.toThrow("provider import outcome must be definitive");
    expect(
      await store.settleDefinitiveProviderImportFailure({
        tenantId: staleImportSaga.tenantId,
        operationId: staleImportSaga.operationId,
        replayKey: staleImportSaga.replayKey,
        resourceUid: staleImportSaga.resourceUid,
        leaseToken: "lease_after_stale_import",
        outcome: "adoption_aborted",
      }),
    ).toBe(true);
    expect(
      await store.providerMutationPlanExists(
        staleImportSaga.tenantId,
        staleImportSaga.operationId,
        staleImportSaga.resourceUid,
      ),
    ).toBe(false);
    database.close();
  });

  test("persists an opaque provider handle and indeterminate outcome across recovery", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    let now = 1_000;
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    const recoverySaga: ProviderMutationSaga = {
      ...saga,
      operationKind: "import",
      operationId: "op_persisted_provider_handle",
      replayKey: "replay-persisted-provider-handle",
      resourceUid: "uid_persisted_provider_handle",
      target: { ...saga.target, name: "persisted-provider-handle" },
    };
    await store.acceptProviderMutationSaga(recoverySaga);
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: recoverySaga.tenantId,
        operationId: recoverySaga.operationId,
        resourceUid: recoverySaga.resourceUid,
        leaseToken: "lease_handle_initial",
        leaseUntil: 2_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial" });
    expect(
      await store.markProviderMutationDispatch({
        tenantId: recoverySaga.tenantId,
        operationId: recoverySaga.operationId,
        resourceUid: recoverySaga.resourceUid,
        leaseToken: "lease_handle_initial",
      }),
    ).toBe(true);
    expect(
      await store.recordProviderMutationOutcome({
        tenantId: recoverySaga.tenantId,
        operationId: recoverySaga.operationId,
        resourceUid: recoverySaga.resourceUid,
        leaseToken: "lease_handle_initial",
        outcome: "running",
        providerHandle: "opaque-provider-handle",
      }),
    ).toBe(true);
    expect(
      await store.releaseProviderMutationExecution({
        tenantId: recoverySaga.tenantId,
        operationId: recoverySaga.operationId,
        resourceUid: recoverySaga.resourceUid,
        leaseToken: "lease_handle_initial",
      }),
    ).toBe(true);

    now = 2_001;
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: recoverySaga.tenantId,
        operationId: recoverySaga.operationId,
        resourceUid: recoverySaga.resourceUid,
        leaseToken: "lease_handle_recovery",
        leaseUntil: 3_001,
      }),
    ).toEqual({
      kind: "acquired",
      mode: "recovery",
      providerHandle: "opaque-provider-handle",
      providerOutcome: "running",
    });
    expect(
      await store.recordProviderMutationOutcome({
        tenantId: recoverySaga.tenantId,
        operationId: recoverySaga.operationId,
        resourceUid: recoverySaga.resourceUid,
        leaseToken: "lease_handle_recovery",
        outcome: "indeterminate",
      }),
    ).toBe(true);
    expect(
      await store.releaseProviderMutationExecution({
        tenantId: recoverySaga.tenantId,
        operationId: recoverySaga.operationId,
        resourceUid: recoverySaga.resourceUid,
        leaseToken: "lease_handle_recovery",
      }),
    ).toBe(true);

    now = 3_002;
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: recoverySaga.tenantId,
        operationId: recoverySaga.operationId,
        resourceUid: recoverySaga.resourceUid,
        leaseToken: "lease_indeterminate_recovery",
        leaseUntil: 4_002,
      }),
    ).toEqual({ kind: "acquired", mode: "recovery", providerOutcome: "indeterminate" });
    database.close();
  });

  test("terminalizes a provider precondition failure without retaining a retryable plan", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
    const failedSaga: ProviderMutationSaga = {
      ...saga,
      operationKind: "import",
      operationId: "op_provider_precondition",
      replayKey: "replay-provider-precondition",
      resourceUid: "uid_provider_precondition",
      target: { ...saga.target, name: "provider-precondition" },
    };
    await store.acceptProviderMutationSaga(failedSaga);
    await store.acquireProviderMutationExecution({
      tenantId: failedSaga.tenantId,
      operationId: failedSaga.operationId,
      resourceUid: failedSaga.resourceUid,
      leaseToken: "lease_precondition",
      leaseUntil: 2_000,
    });
    await store.markProviderMutationDispatch({
      tenantId: failedSaga.tenantId,
      operationId: failedSaga.operationId,
      resourceUid: failedSaga.resourceUid,
      leaseToken: "lease_precondition",
    });
    expect(
      await store.settleProviderMutationPreconditionFailure({
        tenantId: failedSaga.tenantId,
        operationId: failedSaga.operationId,
        resourceUid: failedSaga.resourceUid,
        leaseToken: "lease_precondition",
      }),
    ).toBe(true);
    expect(
      await store.providerMutationPlanExists(
        failedSaga.tenantId,
        failedSaga.operationId,
        failedSaga.resourceUid,
      ),
    ).toBe(false);
    database.close();
  });
});
