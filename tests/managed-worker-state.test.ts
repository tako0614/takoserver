import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import type { Row, Sql } from "../src/ports.ts";
import {
  ManagedWorkerState,
  ManagedWorkerStateCorruptionError,
} from "../src/providers/managed-worker-state.ts";

const PROVIDER = "cloudflare.wfp.integration";
const DIGEST_1 = `sha256:${"1".repeat(64)}` as const;

test("managed state distinguishes absent rows from malformed durable authority", async () => {
  const absent = new ManagedWorkerState(PROVIDER, readOnlySql([]));
  expect(await absent.route("host", "host/v1/missing.example")).toBeNull();
  expect(await absent.receiptByResourceUid("missing-resource")).toBeNull();

  const malformedRoute = new ManagedWorkerState(
    PROVIDER,
    readOnlySql([
      {
        route_key: "host/v1/broken.example",
        owner_native_id: "endpoint:broken",
        generation: 1,
        operation_id: "route-broken",
        state: "active",
        value_json: "[]",
      },
    ]),
  );
  await expect(malformedRoute.route("host", "host/v1/broken.example")).rejects.toBeInstanceOf(
    ManagedWorkerStateCorruptionError,
  );
  await expect(malformedRoute.activeRoutes("host")).rejects.toBeInstanceOf(
    ManagedWorkerStateCorruptionError,
  );

  const malformedReceipt = new ManagedWorkerState(
    PROVIDER,
    readOnlySql([
      {
        resource_uid: "resource-broken",
        native_id: "worker:broken",
        kind: "worker",
        logical_worker_id: "worker-broken",
        operation_id: "receipt-broken",
        generation: 1,
        descriptor_digest: DIGEST_1,
        state: "committed",
        provider_etag: null,
        observed_json: "[]",
        previous_json: null,
      },
    ]),
  );
  await expect(malformedReceipt.receiptByResourceUid("resource-broken")).rejects.toBeInstanceOf(
    ManagedWorkerStateCorruptionError,
  );
  await expect(malformedReceipt.receiptByNativeId("worker:broken")).rejects.toBeInstanceOf(
    ManagedWorkerStateCorruptionError,
  );
});

test("migration constraints reject malformed JSON and invalid receipt state closures", async () => {
  const sql = createEphemeralSql();
  const state = new ManagedWorkerState(PROVIDER, sql);
  const route = await state.putRoute({
    kind: "host",
    key: "host/v1/valid.example",
    ownerNativeId: "endpoint:valid",
    operationId: "route-create",
    predecessor: { kind: "absent" },
    value: {
      schema: "takoserver.managed-worker-host-route@v1",
      logicalWorkerId: "worker-valid",
    },
  });
  expect(route).not.toBeNull();
  await expect(
    sql.run("UPDATE cloudflare_managed_worker_routes SET value_json = '[]' WHERE provider_id = ?", [
      PROVIDER,
    ]),
  ).rejects.toThrow();

  const claim = await state.claimReceipt({
    resourceUid: "resource-valid",
    nativeId: "worker:valid",
    kind: "worker",
    logicalWorkerId: "worker-valid",
    operationId: "receipt-create",
    descriptorDigest: DIGEST_1,
  });
  expect(claim.outcome).toBe("claimed");
  await expect(
    sql.run(
      "UPDATE cloudflare_managed_worker_receipts SET observed_json = '[]' WHERE provider_id = ?",
      [PROVIDER],
    ),
  ).rejects.toThrow();
  await expect(
    sql.run(
      "UPDATE cloudflare_managed_worker_receipts SET state = 'deleting', previous_json = NULL WHERE provider_id = ?",
      [PROVIDER],
    ),
  ).rejects.toThrow();
  await expect(
    sql.run(
      "UPDATE cloudflare_managed_worker_receipts SET provider_etag = 'etag' WHERE provider_id = ?",
      [PROVIDER],
    ),
  ).rejects.toThrow();
});

test("route CAS prevents delayed apply and stale delete from replacing a new owner", async () => {
  const state = new ManagedWorkerState(PROVIDER, createEphemeralSql());
  const first = await state.putRoute({
    kind: "host",
    key: "host/v1/official.example",
    ownerNativeId: "endpoint:resource-old",
    operationId: "old-apply",
    predecessor: { kind: "absent" },
    value: {
      schema: "takoserver.managed-worker-host-route@v1",
      logicalWorkerId: "worker-old",
    },
  });
  expect(first).not.toBeNull();
  if (!first) throw new Error("first route is missing");
  const tombstone = await state.tombstoneRoute({
    kind: "host",
    key: first.key,
    ownerNativeId: first.ownerNativeId,
    operationId: "old-delete",
    predecessor: { kind: "exact", route: first },
  });
  expect(tombstone).not.toBeNull();
  if (!tombstone) throw new Error("route tombstone is missing");
  const replacement = await state.putRoute({
    kind: "host",
    key: first.key,
    ownerNativeId: "endpoint:resource-new",
    operationId: "new-apply",
    predecessor: { kind: "exact", route: tombstone },
    value: {
      schema: "takoserver.managed-worker-host-route@v1",
      logicalWorkerId: "worker-new",
    },
  });
  expect(replacement).not.toBeNull();

  expect(
    await state.tombstoneRoute({
      kind: "host",
      key: first.key,
      ownerNativeId: first.ownerNativeId,
      operationId: "stale-delete",
      predecessor: { kind: "exact", route: first },
    }),
  ).toBeNull();
  expect(
    await state.putRoute({
      kind: "host",
      key: first.key,
      ownerNativeId: first.ownerNativeId,
      operationId: "delayed-old-apply",
      predecessor: { kind: "exact", route: first },
      value: first.value,
    }),
  ).toBeNull();
  expect(await state.route("host", first.key)).toEqual(replacement);
});

test("schedule leases renew only inside one bounded owner window and expire to ambiguity", async () => {
  const sql = createEphemeralSql();
  const state = new ManagedWorkerState(PROVIDER, sql);
  expect(
    await state.putRoute({
      kind: "schedule",
      key: "schedule/v1/1%20*%20*%20*%20*",
      ownerNativeId: "schedule:one",
      operationId: "schedule-route-one",
      predecessor: { kind: "absent" },
      value: {
        schema: "takoserver.managed-worker-schedule-route@v1",
        logicalWorkerIds: ["worker-one"],
      },
    }),
  ).not.toBeNull();

  expect(
    await state.acquireScheduleReconciliation({
      leaseToken: "schedule_owner_a",
      now: 1_000,
      leaseUntil: 31_000,
    }),
  ).toMatchObject({ outcome: "acquired", state: { leaseStartedAt: 1_000 } });
  expect(
    await state.acquireScheduleReconciliation({
      leaseToken: "schedule_owner_a",
      now: 2_000,
      leaseUntil: 61_000,
    }),
  ).toMatchObject({ outcome: "acquired", state: { leaseStartedAt: 1_000 } });
  expect(
    await state.acquireScheduleReconciliation({
      leaseToken: "schedule_owner_a",
      now: 2_001,
      leaseUntil: 61_001,
    }),
  ).toMatchObject({ outcome: "busy" });
  expect(
    await state.acquireScheduleReconciliation({
      leaseToken: "schedule_owner_b",
      now: 30_000,
      leaseUntil: 60_000,
    }),
  ).toMatchObject({ outcome: "busy" });
  expect(
    await state.acquireScheduleReconciliation({
      leaseToken: "schedule_owner_b",
      now: 61_001,
      leaseUntil: 91_001,
    }),
  ).toMatchObject({
    outcome: "operator_reconciliation_required",
    state: {
      reconciliationState: "operator_reconciliation_required",
      leaseToken: "schedule_owner_a",
      ambiguityReason: "lease_expired",
    },
  });
  expect(await state.releaseScheduleReconciliation("schedule_owner_a")).toBe(false);
  expect(await state.scheduleReconciliationStatus(1_000_000)).toMatchObject({
    reconciliationState: "operator_reconciliation_required",
    leaseToken: "schedule_owner_a",
  });
});

function readOnlySql(rows: readonly Row[]): Sql {
  return {
    async query() {
      return rows;
    },
    async run() {
      throw new Error("unexpected write");
    },
    async batch() {
      throw new Error("unexpected batch");
    },
  };
}
