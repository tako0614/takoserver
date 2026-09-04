import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA,
  ManagedObjectReceiptCore,
  type ManagedObjectReceiptState,
  type ManagedObjectReceiptStorage,
} from "../src/providers/cloudflare-managed-object-receipt.ts";
import {
  ManagedObjectReceiptCoordinator,
  type ManagedObjectReceiptProvider,
} from "../src/providers/cloudflare-managed-object-receipt-coordinator.ts";

const AUTHORITY = {
  schema: MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA,
  providerId: "cloudflare.wfp.integration",
  resourceUid: "bucket-uid",
  incarnationId: "bucket-incarnation",
  generation: "4",
} as const;

const CREATE = {
  authority: AUTHORITY,
  bucketName: "managed-bucket",
  key: "folder/object.bin",
  contentType: "application/octet-stream",
  receiptId: "receipt-00000000-0000-4000-8000-000000000001",
  marker: "A".repeat(43),
} as const;

class TestState implements ManagedObjectReceiptState {
  readonly database = new Database(":memory:");
  readonly events: string[] = [];
  alarm: number | null = null;
  deleteAllCalls = 0;
  deleteAllMode: "noop" | "remove" | "remove-and-reject" = "noop";
  failAlarm = false;
  readonly storage = {
    sql: {
      exec: <T extends Record<string, string | number | null>>(
        query: string,
        ...bindings: (string | number | null)[]
      ) => {
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
    setAlarm: async (scheduledTime: number | Date) => {
      this.events.push("alarm:set");
      if (this.failAlarm) throw new Error("alarm unavailable");
      this.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    },
    deleteAlarm: async () => {
      this.events.push("alarm:delete");
      this.alarm = null;
    },
    getAlarm: async () => this.alarm,
    deleteAll: async () => {
      this.events.push("storage:deleteAll");
      this.deleteAllCalls += 1;
      if (this.deleteAllMode !== "noop") {
        this.database.exec(`
          DROP TABLE managed_object_parts;
          DROP TABLE managed_object_key_fences;
          DROP TABLE managed_object_native_upload_fences;
          DROP TABLE managed_object_uploads;
          DROP TABLE managed_object_control;
          DROP TABLE managed_object_authority;
          DROP TABLE managed_object_schema_meta;
        `);
      }
      if (this.deleteAllMode === "remove-and-reject") {
        throw new Error("delete acknowledgement lost");
      }
    },
  };
}

class TestProvider implements ManagedObjectReceiptProvider {
  readonly events: string[];
  readonly exactLists: { key: string; uploadId: string }[][] = [];
  readonly pages: { uploads: { key: string; uploadId: string }[]; truncated: boolean }[] = [];
  createCalls = 0;
  aborts: string[] = [];
  createError: unknown = null;
  bucketExists = true;

  constructor(events: string[]) {
    this.events = events;
  }

  async listMultipartUploads() {
    this.events.push("provider:list");
    return this.exactLists.shift() ?? [];
  }

  async listMultipartUploadPage() {
    this.events.push("provider:list-page");
    return this.pages.shift() ?? { uploads: [], truncated: false };
  }

  async createMultipartUpload() {
    this.events.push("provider:create");
    this.createCalls += 1;
    if (this.createError) throw this.createError;
    return { uploadId: "native-created" };
  }

  async abortMultipartUpload(input: { uploadId: string }) {
    this.events.push(`provider:abort:${input.uploadId}`);
    this.aborts.push(input.uploadId);
  }

  async bucketPresent() {
    this.events.push("provider:head-bucket");
    return this.bucketExists;
  }
}

function fixture(now = 10_000) {
  const state = new TestState();
  const provider = new TestProvider(state.events);
  const core = new ManagedObjectReceiptCore(state, { now: () => now });
  const coordinator = new ManagedObjectReceiptCoordinator({
    core,
    provider,
    storage: state.storage,
    now: () => now,
  });
  return { state, provider, core, coordinator };
}

test("native create is granted once only after baseline and a recovery alarm", async () => {
  const { state, provider, coordinator } = fixture();
  provider.exactLists.push(
    [{ key: CREATE.key, uploadId: "native-old" }],
    [
      { key: CREATE.key, uploadId: "native-old" },
      { key: CREATE.key, uploadId: "native-created" },
    ],
  );
  expect(await coordinator.createMultipartUpload(CREATE)).toEqual({
    ok: true,
    value: { state: "active" },
  });
  expect(await coordinator.createMultipartUpload(CREATE)).toEqual({
    ok: true,
    value: { state: "active" },
  });
  expect(provider.createCalls).toBe(1);
  expect(state.events.slice(0, 4)).toEqual([
    "provider:list",
    "alarm:set",
    "provider:create",
    "provider:list",
  ]);
});

test("a lost create acknowledgement adopts one synchronous list delta", async () => {
  const { provider, coordinator } = fixture();
  provider.createError = new Error("lost response");
  provider.exactLists.push([], [{ key: CREATE.key, uploadId: "native-after-lost-ack" }]);
  expect(await coordinator.createMultipartUpload(CREATE)).toEqual({
    ok: true,
    value: { state: "active" },
  });
  expect(provider.createCalls).toBe(1);
});

test("zero delta never recreates and alarm recovery aborts an inaccessible late delta", async () => {
  let now = 20_000;
  const state = new TestState();
  const provider = new TestProvider(state.events);
  const core = new ManagedObjectReceiptCore(state, { now: () => now });
  const coordinator = new ManagedObjectReceiptCoordinator({
    core,
    provider,
    storage: state.storage,
    now: () => now,
  });
  provider.createError = new Error("unknown create outcome");
  provider.exactLists.push([], []);
  expect(await coordinator.createMultipartUpload(CREATE)).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(provider.createCalls).toBe(1);

  now = state.alarm ?? now + 2_000;
  provider.exactLists.push([{ key: CREATE.key, uploadId: "native-late" }]);
  await coordinator.alarm();
  expect(provider.createCalls).toBe(1);
  expect(provider.aborts).toEqual(["native-late"]);
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { receiptCount: 1, operatorReconciliationRequired: 0 },
  });
  expect(
    state.database
      .query("SELECT state FROM managed_object_uploads WHERE receipt_id = ?")
      .get(CREATE.receiptId),
  ).toEqual({ state: "aborted" });
});

test("a claimed candidate bucket lets alarm recovery resume its durable receipts", async () => {
  const now = 30_000;
  const state = new TestState();
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
  const core = new ManagedObjectReceiptCore(state, { initialize: false, now: () => now });
  const provider = new TestProvider(state.events);
  const coordinator = new ManagedObjectReceiptCoordinator({
    core,
    provider,
    storage: state.storage,
    now: () => now,
  });

  expect(core.inspect()).toMatchObject({ ok: true, value: { bucketName: null } });
  expect(core.claimBucket({ authority: AUTHORITY, bucketName: CREATE.bucketName })).toEqual({
    ok: true,
    value: undefined,
  });
  state.database
    .query("UPDATE managed_object_uploads SET next_action_at = ? WHERE receipt_id = ?")
    .run(now, CREATE.receiptId);
  provider.exactLists.push([{ key: CREATE.key, uploadId: "native-candidate-upload" }]);

  await coordinator.alarm();
  expect(provider.aborts).toEqual(["native-candidate-upload"]);
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { bucketName: CREATE.bucketName, receiptCount: 1, operatorReconciliationRequired: 0 },
  });
  expect(
    state.database
      .query("SELECT state FROM managed_object_uploads WHERE receipt_id = ?")
      .get(CREATE.receiptId),
  ).toEqual({ state: "aborted" });
});

test("multi-delta creation fails closed behind the permanent operator fence", async () => {
  const { provider, core, coordinator } = fixture();
  provider.createError = new Error("unknown create outcome");
  provider.exactLists.push(
    [],
    [
      { key: CREATE.key, uploadId: "delta-one" },
      { key: CREATE.key, uploadId: "delta-two" },
    ],
  );
  expect(await coordinator.createMultipartUpload(CREATE)).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { operatorReconciliationRequired: 1, nextActionAt: null },
  });
  expect(provider.aborts).toEqual([]);
});

test("an unavailable alarm aborts preparing without any native create", async () => {
  const { state, provider, coordinator } = fixture();
  state.failAlarm = true;
  provider.exactLists.push([]);
  expect(await coordinator.createMultipartUpload(CREATE)).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(provider.createCalls).toBe(0);
  expect(
    state.database
      .query("SELECT state FROM managed_object_uploads WHERE receipt_id = ?")
      .get(CREATE.receiptId),
  ).toEqual({ state: "aborted" });
});

test("destroy fences creates, drains resumably, and deletes authority only after bucket absence", async () => {
  const { state, provider, coordinator } = fixture();
  provider.pages.push(
    {
      uploads: [{ key: CREATE.key, uploadId: "native-open" }],
      truncated: false,
    },
    { uploads: [], truncated: false },
  );
  expect(
    await coordinator.prepareDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({
    ok: true,
    value: { state: "draining" },
  });
  expect(provider.aborts).toEqual(["native-open"]);
  expect(await coordinator.createMultipartUpload(CREATE)).toEqual({
    ok: false,
    error: { code: "conflict" },
  });
  expect(
    await coordinator.prepareDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({
    ok: true,
    value: { state: "prepared" },
  });
  expect(
    await coordinator.commitDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({
    ok: false,
    error: { code: "conflict" },
  });
  expect(state.deleteAllCalls).toBe(0);
  provider.bucketExists = false;
  expect(
    await coordinator.commitDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({
    ok: true,
    value: { destroyed: true },
  });
  expect(state.events.slice(-3)).toEqual([
    "provider:head-bucket",
    "alarm:delete",
    "storage:deleteAll",
  ]);
});

test("destroy schema is recreated after deleteAll so a same-isolate lost-ack retry converges", async () => {
  const { state, provider, coordinator, core } = fixture();
  provider.pages.push({ uploads: [], truncated: false });
  expect(
    await coordinator.prepareDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({ ok: true, value: { state: "prepared" } });
  provider.bucketExists = false;
  state.deleteAllMode = "remove";
  expect(
    await coordinator.commitDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({ ok: true, value: { destroyed: true } });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { authority: null, bucketName: null, receiptCount: 0 },
  });

  expect(
    await coordinator.commitDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({ ok: true, value: { destroyed: true } });
  expect(state.deleteAllCalls).toBe(2);
});

test("ambiguous deleteAll rejection still revalidates the same-isolate schema", async () => {
  const { state, provider, coordinator, core } = fixture();
  provider.pages.push({ uploads: [], truncated: false });
  expect(
    await coordinator.prepareDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({ ok: true, value: { state: "prepared" } });
  provider.bucketExists = false;
  state.deleteAllMode = "remove-and-reject";
  expect(
    await coordinator.commitDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  expect(core.inspect()).toMatchObject({
    ok: true,
    value: { authority: null, bucketName: null, receiptCount: 0 },
  });

  state.deleteAllMode = "remove";
  expect(
    await coordinator.commitDestroy({ authority: AUTHORITY, bucketName: CREATE.bucketName }),
  ).toEqual({ ok: true, value: { destroyed: true } });
});

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
