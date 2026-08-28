import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformStore, type ProviderMutationSaga } from "../src/takoform/store.ts";

const saga: ProviderMutationSaga = {
  operationId: "op_execution_lease",
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

describe("provider mutation saga execution leases", () => {
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
    expect(recovered).toEqual({ kind: "acquired", mode: "recovery" });

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
        `INSERT INTO tf_deferred_operations
           (id, tenant_id, principal_id, operation, phase, request_path, request_query,
            request_headers_json, request_body_json, fingerprint, replay_key,
            target_space, target_api_version, target_kind, target_name,
            target_form_ref_json, accepted_uid, accepted_generation, accepted_revision,
            resource_uid, polls_remaining, lease_token, lease_until, terminal_json,
            committed_uid, created_at, updated_at, expires_at)
         VALUES (?, ?, 'principal-a', 'apply', 'committing', '/', '', '{}', '{}', '{}',
                 'deferred-replay-execution-lease', ?, ?, ?, ?, '{}', NULL, NULL, NULL,
                 ?, 0, 'outer_recovered', 3001, NULL, NULL,
                 '2026-08-28T00:00:00.000Z', ?, 9001)`,
      )
      .run(
        saga.operationId,
        saga.tenantId,
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
           FROM tf_deferred_operations WHERE id = ?`,
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
    expect(retry).toEqual({ kind: "acquired", mode: "recovery" });
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

  test("a post-dispatch plan cannot be abandoned back into an initial execution", async () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
    const postDispatchSaga: ProviderMutationSaga = {
      ...saga,
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
});
