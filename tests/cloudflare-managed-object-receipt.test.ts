import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  MANAGED_OBJECT_ACTIVE_RETENTION_MS,
  MANAGED_OBJECT_ALARM_BATCH,
  MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA,
  MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION,
  MANAGED_OBJECT_TERMINAL_RETENTION_MS,
  ManagedObjectReceiptCore,
  type ManagedObjectReceiptState,
  type ManagedObjectReceiptStorage,
  managedObjectReceiptAdminProof,
  managedObjectReceiptInstanceName,
  managedObjectReceiptRuntimeProof,
  verifyManagedObjectReceiptAdminProof,
  verifyManagedObjectReceiptRuntimeProof,
} from "../src/providers/cloudflare-managed-object-receipt.ts";

const AUTHORITY = {
  schema: MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA,
  providerId: "cloudflare.wfp.integration",
  resourceUid: "bucket-media-uid",
  incarnationId: "deployment-bucket-media",
  generation: "7",
} as const;

const OTHER_GENERATION = { ...AUTHORITY, generation: "8" } as const;

class BunObjectReceiptState implements ManagedObjectReceiptState {
  readonly database = new Database(":memory:");
  mutationCount = 0;
  readonly storage = {
    sql: {
      exec: <T extends Record<string, string | number | null>>(
        query: string,
        ...bindings: (string | number | null)[]
      ) => {
        if ((query.match(/\?/gu)?.length ?? 0) !== bindings.length) {
          throw new Error("receipt SQL binding count mismatch");
        }
        if (!/^\s*SELECT\b/iu.test(query)) this.mutationCount += 1;
        const rows = this.database.query(query).all(...bindings) as T[];
        const changed = this.database.query("SELECT changes() AS changes").get() as {
          changes?: unknown;
        } | null;
        return {
          toArray: () => rows,
          rowsWritten: typeof changed?.changes === "number" ? changed.changes : 0,
        };
      },
    } satisfies ManagedObjectReceiptStorage,
    transactionSync: <T>(callback: () => T): T => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const value = callback();
        this.database.exec("COMMIT");
        return value;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const CREATE = {
  authority: AUTHORITY,
  bucketName: "bucket-media",
  key: "media/video.bin",
  contentType: "application/octet-stream",
  receiptId: "receipt-00000000-0000-4000-8000-000000000001",
  marker: "A".repeat(43),
};

function activeUpload(core: ManagedObjectReceiptCore) {
  expect(core.beginCreate(CREATE)).toEqual({ ok: true, value: { state: "preparing" } });
  expect(
    core.grantCreate({
      ...CREATE,
      baselineUploadIds: [],
    }),
  ).toEqual({ ok: true, value: { action: "execute" } });
  expect(
    core.resolveCreate({
      ...CREATE,
      observedUploadIds: ["native-r2-upload-id"],
      acknowledgedUploadId: "native-r2-upload-id",
      recovery: false,
      definitiveFailure: false,
    }),
  ).toEqual({
    ok: true,
    value: { action: "active", nativeUploadId: "native-r2-upload-id" },
  });
}

function readyPart(core: ManagedObjectReceiptCore, partNumber: number, etag: string, size: number) {
  const attemptId = `attempt-${partNumber}-${etag}`;
  expect(
    core.beginPart({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      partNumber,
      size,
      attemptId,
    }),
  ).toEqual({
    ok: true,
    value: { nativeUploadId: "native-r2-upload-id", attemptId },
  });
  expect(
    core.commitPart({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      partNumber,
      size,
      attemptId,
      etag,
    }),
  ).toEqual({ ok: true, value: { etag, partNumber } });
}

test("receipt instance identity is opaque and isolates bucket generations and incarnations", async () => {
  const current = await managedObjectReceiptInstanceName(AUTHORITY);
  expect(current).toMatch(/^tsobj-[A-Za-z0-9_-]{43}$/u);
  expect(current).not.toContain(AUTHORITY.resourceUid);
  expect(await managedObjectReceiptInstanceName(AUTHORITY)).toBe(current);
  expect(await managedObjectReceiptInstanceName(OTHER_GENERATION)).not.toBe(current);
  expect(
    await managedObjectReceiptInstanceName({ ...AUTHORITY, incarnationId: "replacement" }),
  ).not.toBe(current);
});

test("multipart receipts survive a core restart and reject a different authority", () => {
  const state = new BunObjectReceiptState();
  const first = new ManagedObjectReceiptCore(state);
  activeUpload(first);
  readyPart(first, 1, "etag-one", 9);

  const restarted = new ManagedObjectReceiptCore(state);
  expect(
    restarted.beginComplete({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      parts: [{ partNumber: 1, etag: "etag-one" }],
    }),
  ).toEqual({
    ok: true,
    value: {
      action: "execute",
      nativeUploadId: "native-r2-upload-id",
      marker: CREATE.marker,
      expectedSize: 9,
    },
  });
  expect(
    restarted.beginComplete({
      authority: OTHER_GENERATION,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      parts: [{ partNumber: 1, etag: "etag-one" }],
    }),
  ).toEqual({ ok: false, error: { code: "conflict" } });
});

test("a lost complete acknowledgement reconciles but never grants a second execute", () => {
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state);
  activeUpload(core);
  readyPart(core, 1, "etag-one", 9);
  const completion = {
    authority: AUTHORITY,
    key: CREATE.key,
    receiptId: CREATE.receiptId,
    parts: [{ partNumber: 1, etag: "etag-one" }],
  } as const;

  expect(core.beginComplete(completion)).toMatchObject({
    ok: true,
    value: { action: "execute", marker: CREATE.marker, expectedSize: 9 },
  });
  // Recreate the object after the R2 call may have completed but before its
  // response was durably acknowledged. A retry may inspect the private marker;
  // it may not invoke R2 complete again.
  const restarted = new ManagedObjectReceiptCore(state);
  expect(restarted.beginComplete(completion)).toMatchObject({
    ok: true,
    value: { action: "reconcile", marker: CREATE.marker, expectedSize: 9 },
  });
  expect(
    restarted.commitComplete({
      ...completion,
      etag: "completed-etag",
      size: 9,
    }),
  ).toEqual({ ok: true, value: { etag: "completed-etag", size: 9 } });
  expect(restarted.beginComplete(completion)).toEqual({
    ok: true,
    value: { action: "done", etag: "completed-etag", size: 9 },
  });
});

test("duplicate part upload supersedes its old receipt and stale completion is refused", () => {
  const core = new ManagedObjectReceiptCore(new BunObjectReceiptState());
  activeUpload(core);
  readyPart(core, 1, "etag-old", 9);
  readyPart(core, 1, "etag-new", 10);
  expect(
    core.beginComplete({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      parts: [{ partNumber: 1, etag: "etag-old" }],
    }),
  ).toEqual({ ok: false, error: { code: "invalid_part" } });
  expect(
    core.beginComplete({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      parts: [{ partNumber: 1, etag: "etag-new" }],
    }),
  ).toMatchObject({ ok: true, value: { action: "execute", expectedSize: 10 } });
});

test("commitPart rejects a body size that differs from beginPart", () => {
  const core = new ManagedObjectReceiptCore(new BunObjectReceiptState());
  activeUpload(core);
  const attemptId = "attempt-size-mismatch-00000000-0000-4000-8000-000000000001";
  expect(
    core.beginPart({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      partNumber: 1,
      size: 9,
      attemptId,
    }),
  ).toEqual({
    ok: true,
    value: { nativeUploadId: "native-r2-upload-id", attemptId },
  });
  expect(
    core.commitPart({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      partNumber: 1,
      size: 10,
      attemptId,
      etag: "etag-size-mismatch",
    }),
  ).toEqual({ ok: false, error: { code: "conflict" } });
  expect(
    core.commitPart({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      partNumber: 1,
      size: 9,
      attemptId,
      etag: "etag-size-match",
    }),
  ).toEqual({ ok: true, value: { etag: "etag-size-match", partNumber: 1 } });
});

test("a preparing receipt can be durably aborted before the one native grant", () => {
  const failedCreateState = new BunObjectReceiptState();
  const failedCreate = new ManagedObjectReceiptCore(failedCreateState);
  expect(failedCreate.beginCreate(CREATE)).toEqual({ ok: true, value: { state: "preparing" } });
  const identity = {
    authority: AUTHORITY,
    key: CREATE.key,
    receiptId: CREATE.receiptId,
  } as const;
  expect(failedCreate.beginAbort(identity)).toEqual({ ok: true, value: { action: "done" } });
  expect(failedCreate.commitAbort(identity)).toEqual({
    ok: true,
    value: { state: "aborted" },
  });
});

test("a restarted granted create never receives a second grant and alarm recovery aborts one delta", () => {
  const state = new BunObjectReceiptState();
  const first = new ManagedObjectReceiptCore(state);
  expect(first.beginCreate(CREATE)).toEqual({ ok: true, value: { state: "preparing" } });
  expect(first.grantCreate({ ...CREATE, baselineUploadIds: ["older"] })).toEqual({
    ok: true,
    value: { action: "execute" },
  });

  const restarted = new ManagedObjectReceiptCore(state);
  expect(restarted.beginCreate(CREATE)).toEqual({ ok: false, error: { code: "conflict" } });
  expect(restarted.grantCreate({ ...CREATE, baselineUploadIds: ["older"] })).toEqual({
    ok: false,
    error: { code: "conflict" },
  });
  expect(
    restarted.resolveCreate({
      ...CREATE,
      observedUploadIds: ["older", "native-discovered-upload"],
      acknowledgedUploadId: null,
      recovery: true,
      definitiveFailure: false,
    }),
  ).toEqual({
    ok: true,
    value: { action: "abort", nativeUploadId: "native-discovered-upload" },
  });
});

test("zero delta retries without recreate while a multi-delta permanently fences", () => {
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state);
  expect(core.beginCreate(CREATE)).toEqual({ ok: true, value: { state: "preparing" } });
  expect(core.grantCreate({ ...CREATE, baselineUploadIds: ["baseline"] })).toMatchObject({
    ok: true,
    value: { action: "execute" },
  });
  const resolution = {
    ...CREATE,
    acknowledgedUploadId: null,
    recovery: false,
    definitiveFailure: false,
  } as const;
  expect(core.resolveCreate({ ...resolution, observedUploadIds: ["baseline"] })).toEqual({
    ok: true,
    value: { action: "retry" },
  });
  expect(core.beginCreate(CREATE)).toEqual({
    ok: true,
    value: { state: "create_reconciling" },
  });
  expect(
    core.resolveCreate({
      ...resolution,
      observedUploadIds: ["baseline", "delta-one", "delta-two"],
    }),
  ).toEqual({ ok: true, value: { action: "operator_reconciliation_required" } });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { operatorReconciliationRequired: 1, nextActionAt: null },
  });
});

test("one unresolved exact key and one native upload id remain uniquely fenced", () => {
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state);
  activeUpload(core);
  const sameKey = {
    ...CREATE,
    receiptId: "receipt-same-key",
    marker: "S".repeat(43),
  };
  expect(core.beginCreate(sameKey)).toEqual({ ok: false, error: { code: "conflict" } });

  const second = {
    ...CREATE,
    key: "second.bin",
    receiptId: "receipt-second-key",
    marker: "T".repeat(43),
  };
  expect(core.beginCreate(second)).toMatchObject({ ok: true, value: { state: "preparing" } });
  expect(core.grantCreate({ ...second, baselineUploadIds: [] })).toMatchObject({ ok: true });
  expect(
    core.resolveCreate({
      ...second,
      observedUploadIds: ["native-r2-upload-id"],
      acknowledgedUploadId: "native-r2-upload-id",
      recovery: false,
      definitiveFailure: false,
    }),
  ).toEqual({ ok: true, value: { action: "operator_reconciliation_required" } });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { receiptCount: 2, operatorReconciliationRequired: 1 },
  });
});

test("a definitive lost native completion enters reconciliation and remains abortable", () => {
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state);
  activeUpload(core);
  readyPart(core, 1, "etag-one", 9);
  const completion = {
    authority: AUTHORITY,
    key: CREATE.key,
    receiptId: CREATE.receiptId,
    parts: [{ partNumber: 1, etag: "etag-one" }],
  } as const;
  expect(core.beginComplete(completion)).toMatchObject({
    ok: true,
    value: { action: "execute", expectedSize: 9 },
  });
  expect(core.markCompleteLost(completion)).toEqual({
    ok: true,
    value: { state: "completion_reconciling" },
  });
  const restarted = new ManagedObjectReceiptCore(state);
  expect(restarted.beginComplete(completion)).toEqual({
    ok: true,
    value: {
      action: "reconcile",
      nativeUploadId: "native-r2-upload-id",
      marker: CREATE.marker,
      expectedSize: 9,
    },
  });
  expect(
    restarted.commitComplete({
      ...completion,
      etag: "completed-after-reconciliation",
      size: 9,
    }),
  ).toEqual({
    ok: true,
    value: { etag: "completed-after-reconciliation", size: 9 },
  });
  expect(restarted.beginComplete(completion)).toEqual({
    ok: true,
    value: {
      action: "done",
      etag: "completed-after-reconciliation",
      size: 9,
    },
  });

  const abortState = new BunObjectReceiptState();
  const abortCore = new ManagedObjectReceiptCore(abortState);
  activeUpload(abortCore);
  readyPart(abortCore, 1, "etag-one", 9);
  expect(abortCore.beginComplete(completion)).toMatchObject({
    ok: true,
    value: { action: "execute", expectedSize: 9 },
  });
  expect(abortCore.markCompleteLost(completion)).toEqual({
    ok: true,
    value: { state: "completion_reconciling" },
  });
  expect(
    abortCore.beginAbort({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
    }),
  ).toEqual({
    ok: true,
    value: {
      action: "execute",
      nativeUploadId: "native-r2-upload-id",
      marker: CREATE.marker,
    },
  });
  expect(
    abortCore.commitAbort({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
    }),
  ).toEqual({
    ok: true,
    value: { state: "aborted" },
  });
});

test("completion enforces order, uniqueness, and minimum non-final part size", () => {
  const core = new ManagedObjectReceiptCore(new BunObjectReceiptState());
  activeUpload(core);
  readyPart(core, 1, "etag-one", 4);
  readyPart(core, 2, "etag-two", 5);
  const base = { authority: AUTHORITY, key: CREATE.key, receiptId: CREATE.receiptId };
  expect(
    core.beginComplete({
      ...base,
      parts: [
        { partNumber: 2, etag: "etag-two" },
        { partNumber: 1, etag: "etag-one" },
      ],
    }),
  ).toEqual({ ok: false, error: { code: "invalid_part" } });
  expect(
    core.beginComplete({
      ...base,
      parts: [
        { partNumber: 1, etag: "etag-one" },
        { partNumber: 1, etag: "etag-one" },
      ],
    }),
  ).toEqual({ ok: false, error: { code: "invalid_part" } });
  expect(
    core.beginComplete({
      ...base,
      parts: [
        { partNumber: 1, etag: "etag-one" },
        { partNumber: 2, etag: "etag-two" },
      ],
    }),
  ).toEqual({ ok: false, error: { code: "invalid_part" } });
});

test("abort is durable and retry-idempotent while later parts and completion are refused", () => {
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state);
  activeUpload(core);
  const abort = { authority: AUTHORITY, key: CREATE.key, receiptId: CREATE.receiptId };
  expect(core.beginAbort(abort)).toEqual({
    ok: true,
    value: {
      action: "execute",
      nativeUploadId: "native-r2-upload-id",
      marker: CREATE.marker,
    },
  });
  expect(core.commitAbort(abort)).toEqual({ ok: true, value: { state: "aborted" } });
  const restarted = new ManagedObjectReceiptCore(state);
  expect(restarted.beginAbort(abort)).toEqual({
    ok: true,
    value: { action: "done" },
  });
  expect(
    restarted.beginPart({
      ...abort,
      partNumber: 1,
      size: 1,
      attemptId: "attempt-after-abort",
    }),
  ).toEqual({ ok: false, error: { code: "not_found" } });
  expect(restarted.beginComplete({ ...abort, parts: [{ partNumber: 1, etag: "etag" }] })).toEqual({
    ok: false,
    error: { code: "not_found" },
  });
});

test("malformed authority is rejected before receipt storage mutation", () => {
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state);
  const afterSchema = state.mutationCount;
  expect(
    core.beginCreate({
      ...CREATE,
      authority: { ...AUTHORITY, generation: "0" },
    }),
  ).toEqual({ ok: false, error: { code: "invalid_argument" } });
  expect(state.mutationCount).toBe(afterSchema);

  const symbolKeyed = { ...CREATE } as Record<PropertyKey, unknown>;
  symbolKeyed[Symbol("unexpected")] = true;
  expect(core.beginCreate(symbolKeyed)).toEqual({
    ok: false,
    error: { code: "invalid_argument" },
  });
  expect(state.mutationCount).toBe(afterSchema);
});

test("runtime and admin proofs are exact-field and operation scoped", async () => {
  const secret = "synthetic-managed-object-proof-secret";
  const runtime = await managedObjectReceiptRuntimeProof({
    secret,
    authority: AUTHORITY,
    bucketName: CREATE.bucketName,
  });
  expect(runtime).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(
    await verifyManagedObjectReceiptRuntimeProof({
      secret,
      proof: runtime,
      authority: AUTHORITY,
      bucketName: CREATE.bucketName,
    }),
  ).toBe(true);
  for (const mismatch of [
    {
      authority: { ...AUTHORITY, providerId: "cloudflare.wfp.other" },
      bucketName: CREATE.bucketName,
    },
    { authority: { ...AUTHORITY, resourceUid: "bucket-other-uid" }, bucketName: CREATE.bucketName },
    {
      authority: { ...AUTHORITY, incarnationId: "deployment-bucket-other" },
      bucketName: CREATE.bucketName,
    },
    { authority: OTHER_GENERATION, bucketName: CREATE.bucketName },
    { authority: AUTHORITY, bucketName: "bucket-other" },
  ]) {
    expect(
      await verifyManagedObjectReceiptRuntimeProof({ secret, proof: runtime, ...mismatch }),
    ).toBe(false);
  }
  const prepare = await managedObjectReceiptAdminProof({
    secret,
    operation: "prepare-destroy",
    authority: AUTHORITY,
    bucketName: CREATE.bucketName,
  });
  const commit = await managedObjectReceiptAdminProof({
    secret,
    operation: "commit-destroy",
    authority: AUTHORITY,
    bucketName: CREATE.bucketName,
  });
  expect(prepare).not.toBe(commit);
  expect(prepare).not.toBe(runtime);
  expect(
    await verifyManagedObjectReceiptAdminProof({
      secret,
      proof: prepare,
      operation: "prepare-destroy",
      authority: AUTHORITY,
      bucketName: CREATE.bucketName,
    }),
  ).toBe(true);
  expect(
    await verifyManagedObjectReceiptAdminProof({
      secret,
      proof: prepare,
      operation: "commit-destroy",
      authority: AUTHORITY,
      bucketName: CREATE.bucketName,
    }),
  ).toBe(false);
});

test("exact populated candidate schema upgrades transactionally and restart is idempotent", () => {
  const state = new BunObjectReceiptState();
  installCandidateSchema(state.database);
  state.database
    .query(
      `INSERT INTO managed_object_authority
       (singleton, provider_id, resource_uid, incarnation_id, resource_generation)
       VALUES (1, ?, ?, ?, ?)`,
    )
    .run(
      AUTHORITY.providerId,
      AUTHORITY.resourceUid,
      AUTHORITY.incarnationId,
      AUTHORITY.generation,
    );
  state.database
    .query(
      `INSERT INTO managed_object_uploads
       (receipt_id, object_key, marker, content_type, native_upload_id, state,
        completion_parts, expected_size, completed_etag, completed_size)
       VALUES (?, ?, ?, NULL, NULL, 'creating', NULL, NULL, NULL, NULL),
              (?, ?, ?, NULL, ?, 'active', NULL, NULL, NULL, NULL),
              (?, ?, ?, NULL, ?, 'completed', '[]', 0, 'etag', 0)`,
    )
    .run(
      "receipt-old-creating",
      "creating.bin",
      "B".repeat(43),
      "receipt-old-active",
      "active.bin",
      "C".repeat(43),
      "native-active",
      "receipt-old-completed",
      "completed.bin",
      "D".repeat(43),
      "native-completed",
    );
  state.database
    .query(
      `INSERT INTO managed_object_parts
       (receipt_id, part_number, state, attempt_id, etag, expected_size, size,
        previous_etag, previous_size)
       VALUES ('receipt-old-active', 1, 'ready', 'attempt-old', 'etag-old', 4, 4, NULL, NULL)`,
    )
    .run();

  const upgradedAt = Date.UTC(2026, 8, 4);
  const first = new ManagedObjectReceiptCore(state, { now: () => upgradedAt });
  expect(first.inspect()).toEqual({
    ok: true,
    value: {
      schemaVersion: MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION,
      lifecycle: "active",
      authority: AUTHORITY,
      bucketName: null,
      receiptCount: 3,
      operatorReconciliationRequired: 1,
      nextActionAt: upgradedAt + MANAGED_OBJECT_ACTIVE_RETENTION_MS,
    },
  });
  const migrated = state.database
    .query(
      `SELECT receipt_id, state, created_at, terminal_at, next_action_at
       FROM managed_object_uploads ORDER BY receipt_id`,
    )
    .all() as {
    receipt_id: string;
    state: string;
    created_at: number;
    terminal_at: number | null;
    next_action_at: number | null;
  }[];
  expect(migrated).toEqual([
    {
      receipt_id: "receipt-old-active",
      state: "active",
      created_at: upgradedAt,
      terminal_at: null,
      next_action_at: upgradedAt + MANAGED_OBJECT_ACTIVE_RETENTION_MS,
    },
    {
      receipt_id: "receipt-old-completed",
      state: "completed",
      created_at: upgradedAt,
      terminal_at: upgradedAt,
      next_action_at: upgradedAt + MANAGED_OBJECT_TERMINAL_RETENTION_MS,
    },
    {
      receipt_id: "receipt-old-creating",
      state: "operator_reconciliation_required",
      created_at: upgradedAt,
      terminal_at: null,
      next_action_at: null,
    },
  ]);
  expect(
    state.database
      .query("SELECT etag FROM managed_object_parts WHERE receipt_id = 'receipt-old-active'")
      .get(),
  ).toEqual({ etag: "etag-old" });
  expect(
    state.database
      .query("SELECT version FROM managed_object_schema_meta WHERE singleton = 1")
      .get(),
  ).toEqual({ version: MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION });

  const beforeRestart = state.database.serialize();
  const restarted = new ManagedObjectReceiptCore(state, { now: () => upgradedAt + 1_000_000 });
  expect(restarted.inspect()).toMatchObject({ ok: true, value: { receiptCount: 3 } });
  expect(state.database.serialize()).toEqual(beforeRestart);
});

test("a candidate authority claims its exact bucket before resumed receipt RPCs", () => {
  const state = new BunObjectReceiptState();
  installCandidateSchema(state.database);
  state.database
    .query(
      `INSERT INTO managed_object_authority
       (singleton, provider_id, resource_uid, incarnation_id, resource_generation)
       VALUES (1, ?, ?, ?, ?)`,
    )
    .run(
      AUTHORITY.providerId,
      AUTHORITY.resourceUid,
      AUTHORITY.incarnationId,
      AUTHORITY.generation,
    );
  state.database
    .query(
      `INSERT INTO managed_object_uploads
       (receipt_id, object_key, marker, content_type, native_upload_id, state,
        completion_parts, expected_size, completed_etag, completed_size)
       VALUES (?, ?, ?, NULL, ?, 'active', NULL, NULL, NULL, NULL)`,
    )
    .run(CREATE.receiptId, CREATE.key, CREATE.marker, "native-candidate-upload");

  const core = new ManagedObjectReceiptCore(state, { initialize: false });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { authority: AUTHORITY, bucketName: null },
  });
  expect(core.claimBucket({ authority: AUTHORITY, bucketName: CREATE.bucketName })).toEqual({
    ok: true,
    value: undefined,
  });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { authority: AUTHORITY, bucketName: CREATE.bucketName },
  });
  expect(
    core.beginPart({
      authority: AUTHORITY,
      key: CREATE.key,
      receiptId: CREATE.receiptId,
      partNumber: 1,
      size: 4,
      attemptId: "attempt-candidate-resume",
    }),
  ).toEqual({
    ok: true,
    value: {
      nativeUploadId: "native-candidate-upload",
      attemptId: "attempt-candidate-resume",
    },
  });
  expect(core.claimBucket({ authority: AUTHORITY, bucketName: "bucket-other" })).toEqual({
    ok: false,
    error: { code: "conflict" },
  });
});

test("a fresh receipt schema remains claimable after schema recreation", () => {
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state);
  state.database.exec(`
    DROP TABLE managed_object_parts;
    DROP TABLE managed_object_key_fences;
    DROP TABLE managed_object_native_upload_fences;
    DROP TABLE managed_object_uploads;
    DROP TABLE managed_object_control;
    DROP TABLE managed_object_authority;
    DROP TABLE managed_object_schema_meta;
  `);

  expect(core.revalidateSchemaAfterDeleteAll()).toEqual({ ok: true, value: undefined });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: {
      authority: null,
      bucketName: null,
      receiptCount: 0,
      lifecycle: "active",
    },
  });
  expect(core.beginCreate(CREATE)).toEqual({ ok: true, value: { state: "preparing" } });
});

test("a fresh claim fails closed when any orphan receipt or fence row remains", () => {
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state);
  state.database
    .query(
      `INSERT INTO managed_object_uploads
       (receipt_id, object_key, marker, state, create_granted, created_at, updated_at, attempts)
       VALUES (?, ?, ?, 'active', 0, 0, 0, 0)`,
    )
    .run("orphan-receipt", "orphan.bin", "O".repeat(43));
  state.database
    .query(
      `INSERT INTO managed_object_parts
       (receipt_id, part_number, state, attempt_id, etag, expected_size, size,
        previous_etag, previous_size)
       VALUES (?, 1, 'ready', ?, ?, 1, 1, NULL, NULL)`,
    )
    .run("orphan-receipt", "orphan-attempt", "orphan-etag");
  state.database
    .query("INSERT INTO managed_object_key_fences (object_key, receipt_id) VALUES (?, ?)")
    .run("orphan.bin", "orphan-receipt");
  state.database
    .query(
      "INSERT INTO managed_object_native_upload_fences (native_upload_id, receipt_id) VALUES (?, ?)",
    )
    .run("orphan-native-upload", "orphan-receipt");

  expect(core.claimBucket({ authority: AUTHORITY, bucketName: CREATE.bucketName })).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: {
      authority: null,
      bucketName: null,
      receiptCount: 1,
    },
  });
});

test("a latest schema marker without its required authority index fails closed", () => {
  const state = new BunObjectReceiptState();
  const installed = new ManagedObjectReceiptCore(state);
  expect(installed.inspect()).toMatchObject({ ok: true, value: { schemaVersion: 2 } });
  state.database.exec("DROP INDEX managed_object_upload_due");

  expect(new ManagedObjectReceiptCore(state, { initialize: false }).inspect()).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
});

test("receipt timestamps are monotonic and terminal retention is immutable on retry", () => {
  let now = 1_000;
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state, { now: () => now });
  expect(core.beginCreate(CREATE)).toMatchObject({ ok: true });
  expect(uploadTimes(state, CREATE.receiptId)).toEqual({
    created_at: 1_000,
    updated_at: 1_000,
    terminal_at: null,
    next_action_at: 2_000,
    attempts: 0,
  });
  now = 2_000;
  expect(core.grantCreate({ ...CREATE, baselineUploadIds: [] })).toMatchObject({ ok: true });
  now = 3_000;
  expect(
    core.resolveCreate({
      ...CREATE,
      observedUploadIds: ["native-timestamp-upload"],
      acknowledgedUploadId: "native-timestamp-upload",
      recovery: false,
      definitiveFailure: false,
    }),
  ).toMatchObject({ ok: true, value: { action: "active" } });
  expect(uploadTimes(state, CREATE.receiptId)).toEqual({
    created_at: 1_000,
    updated_at: 3_000,
    terminal_at: null,
    next_action_at: 1_000 + MANAGED_OBJECT_ACTIVE_RETENTION_MS,
    attempts: 2,
  });
  const identity = { authority: AUTHORITY, key: CREATE.key, receiptId: CREATE.receiptId };
  now = 4_000;
  expect(core.beginAbort(identity)).toMatchObject({ ok: true, value: { action: "execute" } });
  now = 5_000;
  expect(core.commitAbort(identity)).toMatchObject({ ok: true });
  const terminal = uploadTimes(state, CREATE.receiptId);
  expect(terminal).toEqual({
    created_at: 1_000,
    updated_at: 5_000,
    terminal_at: 5_000,
    next_action_at: 5_000 + MANAGED_OBJECT_TERMINAL_RETENTION_MS,
    attempts: 2,
  });
  now = 6_000;
  expect(core.commitAbort(identity)).toMatchObject({ ok: true });
  expect(uploadTimes(state, CREATE.receiptId)).toEqual(terminal);
});

test("alarm reads and terminal collection stop at the explicit 64-receipt batch", () => {
  let now = 10_000;
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state, { now: () => now });
  const creates = Array.from({ length: MANAGED_OBJECT_ALARM_BATCH + 1 }, (_, index) => ({
    ...CREATE,
    key: `batch-${index}.bin`,
    receiptId: `receipt-batch-${index}`,
    marker: index.toString(36).padStart(43, "A"),
  }));
  for (const create of creates) expect(core.beginCreate(create)).toMatchObject({ ok: true });
  expect(core.dueReceipts(now + 1_000)).toMatchObject({
    ok: true,
    value: { length: MANAGED_OBJECT_ALARM_BATCH },
  });
  for (const create of creates) {
    expect(
      core.beginAbort({ authority: AUTHORITY, key: create.key, receiptId: create.receiptId }),
    ).toMatchObject({ ok: true, value: { action: "done" } });
  }
  now += MANAGED_OBJECT_TERMINAL_RETENTION_MS + 1;
  expect(core.gcTerminal()).toEqual({
    ok: true,
    value: { deleted: MANAGED_OBJECT_ALARM_BATCH },
  });
  expect(core.gcTerminal()).toEqual({ ok: true, value: { deleted: 1 } });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { authority: AUTHORITY, receiptCount: 0 },
  });
});

test("terminal GC is bounded and never deletes authority or permanent ambiguity fences", () => {
  let now = Date.UTC(2026, 8, 4);
  const state = new BunObjectReceiptState();
  const core = new ManagedObjectReceiptCore(state, { now: () => now });
  expect(core.beginCreate(CREATE)).toMatchObject({ ok: true });
  expect(
    core.resolveCreate({
      ...CREATE,
      observedUploadIds: [],
      acknowledgedUploadId: null,
      recovery: false,
      definitiveFailure: true,
    }),
  ).toMatchObject({ ok: false });
  // A definitive pre-grant failure is aborted through the explicit abort path.
  expect(
    core.beginAbort({ authority: AUTHORITY, key: CREATE.key, receiptId: CREATE.receiptId }),
  ).toMatchObject({ ok: true, value: { action: "done" } });
  const ambiguous = {
    ...CREATE,
    key: "ambiguous.bin",
    receiptId: "receipt-ambiguous",
    marker: "E".repeat(43),
  };
  expect(core.beginCreate(ambiguous)).toMatchObject({ ok: true });
  expect(core.requireOperator(ambiguous.receiptId)).toMatchObject({ ok: true });
  now += MANAGED_OBJECT_TERMINAL_RETENTION_MS + 1;
  expect(core.gcTerminal()).toEqual({ ok: true, value: { deleted: 1 } });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: {
      authority: AUTHORITY,
      receiptCount: 1,
      operatorReconciliationRequired: 1,
    },
  });
});

function uploadTimes(state: BunObjectReceiptState, receiptId: string) {
  return state.database
    .query(
      `SELECT created_at, updated_at, terminal_at, next_action_at, attempts
       FROM managed_object_uploads WHERE receipt_id = ?`,
    )
    .get(receiptId);
}

function installCandidateSchema(database: Database): void {
  database.exec(`CREATE TABLE managed_object_authority (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    provider_id TEXT NOT NULL,
    resource_uid TEXT NOT NULL,
    incarnation_id TEXT NOT NULL,
    resource_generation TEXT NOT NULL
  );
  CREATE TABLE managed_object_uploads (
    receipt_id TEXT PRIMARY KEY,
    object_key TEXT NOT NULL,
    marker TEXT NOT NULL UNIQUE,
    content_type TEXT,
    native_upload_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('creating','active','completing','reconciliation_required','completed','aborting','aborted')),
    completion_parts TEXT,
    expected_size INTEGER,
    completed_etag TEXT,
    completed_size INTEGER
  );
  CREATE TABLE managed_object_parts (
    receipt_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('uploading','ready')),
    attempt_id TEXT NOT NULL,
    etag TEXT,
    expected_size INTEGER,
    size INTEGER,
    previous_etag TEXT,
    previous_size INTEGER,
    PRIMARY KEY (receipt_id, part_number),
    FOREIGN KEY (receipt_id) REFERENCES managed_object_uploads(receipt_id) ON DELETE CASCADE
  );`);
}
