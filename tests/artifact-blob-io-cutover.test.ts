import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { ObjectStoreAccess, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformArtifactReconciler } from "../src/takoform/artifact-reconciler.ts";
import {
  createTakoformArtifacts,
  type TakoformArtifactManifest,
  type TakoformArtifactPrincipal,
} from "../src/takoform/artifacts.ts";

const MIGRATION = "0043_artifact_blob_io_fences.sql";
const PRINCIPAL: TakoformArtifactPrincipal = {
  tenantId: "tenant_cutover",
  principalId: "run:cutover",
};

function migrationIndex(): number {
  const index = MIGRATIONS.findIndex(({ name }) => name === MIGRATION);
  expect(index).toBe(42);
  return index;
}

function databaseBefore0043(): Database {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS.slice(0, migrationIndex())) database.exec(migration.sql);
  return database;
}

function apply0043(database: Database): void {
  database.exec(MIGRATIONS[migrationIndex()]?.sql ?? "");
}

function pausePoint(): {
  readonly entered: Promise<void>;
  readonly enter: () => Promise<void>;
  readonly release: () => void;
} {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    async enter() {
      markEntered();
      await released;
    },
    release,
  };
}

class HistoricalInvocationDrain {
  #active = 0;

  get receiptEligible(): boolean {
    return this.#active === 0;
  }

  async track<T>(operation: () => Promise<T>): Promise<T> {
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
    }
  }
}

/**
 * Frozen from the pre-0043 public PUT path at this branch's parent commit.
 * It deliberately has no blob-I/O lease: validate upload/declaration, PUT,
 * then grant the hold in a later SQL statement.
 */
async function historicalArtifactPut(input: {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly drain: HistoricalInvocationDrain;
  readonly uploadId: string;
  readonly digest: string;
  readonly bytes: Uint8Array;
  readonly beforeExternalPut: () => Promise<void>;
}): Promise<Response> {
  return await input.drain.track(async () => {
    const rows = await input.sql.query(
      `SELECT manifest_json, lifecycle_state
       FROM tf_artifact_uploads
       WHERE id = ? AND tenant_id = ? AND principal_id = ?`,
      [input.uploadId, PRINCIPAL.tenantId, PRINCIPAL.principalId],
    );
    const row = rows[0];
    if (row?.lifecycle_state !== "open") return new Response(null, { status: 409 });
    const manifest = JSON.parse(String(row.manifest_json)) as TakoformArtifactManifest;
    const declaration = manifest.modules?.find((entry) => entry.digest === input.digest);
    if (
      !declaration ||
      input.bytes.byteLength !== declaration.size ||
      (await bytesDigest(input.bytes)) !== input.digest
    ) {
      return new Response(null, { status: 400 });
    }
    await input.beforeExternalPut();
    await input.objects.put(`art/${input.digest.slice("sha256:".length)}`, input.bytes, {
      contentType: declaration.mediaType,
    });
    await input.sql.run(
      "INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, 'blob')",
      [PRINCIPAL.tenantId, input.digest],
    );
    return new Response(null, { status: 201 });
  });
}

/**
 * Frozen from the pre-0043 collector path for a row already in `deleting`.
 * The old collector reuses the SQL claim, performs HEAD/DELETE without an
 * object-I/O owner, and only then records the terminal candidate state.
 */
async function historicalDeletingBlobGc(input: {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly drain: HistoricalInvocationDrain;
  readonly digest: string;
  readonly timestamp: number;
  readonly beforeExternalDelete: () => Promise<void>;
}): Promise<"deleted" | "absent" | "retry" | "skipped"> {
  return await input.drain.track(async () => {
    const rows = await input.sql.query(
      `SELECT kind, digest, state, fence, expected_etag
       FROM tf_artifact_gc_candidates
       WHERE kind = 'blob' AND digest = ? AND state = 'deleting'`,
      [input.digest],
    );
    const row = rows[0];
    if (!row) return "skipped";
    const fence = Number(row.fence);
    const live = await input.sql.query(
      `SELECT 1 AS live
       FROM tf_artifact_roots AS root
       WHERE root.state = 'active' AND (
         (root.target_kind = 'blob' AND root.digest = ?) OR
         (root.target_kind = 'manifest' AND EXISTS (
           SELECT 1 FROM tf_artifact_manifest_members AS member
           WHERE member.manifest_digest = root.digest AND member.blob_digest = ?
         ))
       ) LIMIT 1`,
      [input.digest, input.digest],
    );
    if (live.length > 0) return "skipped";
    const key = `art/${input.digest.slice("sha256:".length)}`;
    const current = await input.objects.head(key);
    if (!current) {
      await settleHistoricalDelete(
        input.sql,
        input.digest,
        fence,
        "already_absent",
        input.timestamp,
      );
      return "absent";
    }
    const expectedEtag = row.expected_etag === null ? null : String(row.expected_etag);
    if (expectedEtag !== null && current.etag !== expectedEtag) return "retry";
    await input.beforeExternalDelete();
    const deleted = await input.objects.delete(key);
    await settleHistoricalDelete(
      input.sql,
      input.digest,
      fence,
      deleted ? "deleted" : "already_absent",
      input.timestamp,
    );
    return deleted ? "deleted" : "absent";
  });
}

async function settleHistoricalDelete(
  sql: Sql,
  digest: string,
  fence: number,
  outcome: "deleted" | "already_absent",
  timestamp: number,
): Promise<void> {
  const settled = await sql.run(
    `UPDATE tf_artifact_gc_candidates
     SET state = 'deleted', expected_etag = NULL, last_outcome = ?,
         updated_at = ?, deleted_at = ?
     WHERE kind = 'blob' AND digest = ? AND state = 'deleting' AND fence = ?`,
    [outcome, timestamp, timestamp, digest, fence],
  );
  if (settled.changes !== 1) throw new Error("historical delete lost its candidate fence");
}

async function manifestFor(blobs: readonly Uint8Array[]): Promise<TakoformArtifactManifest> {
  return {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle",
    mainModule: "module-0.mjs",
    modules: await Promise.all(
      blobs.map(async (bytes, index) => ({
        name: `module-${index}.mjs`,
        mediaType: "application/javascript+module" as const,
        size: bytes.byteLength,
        digest: (await bytesDigest(bytes)) as `sha256:${string}`,
      })),
    ),
  };
}

function seedOpenUpload(database: Database, manifest: TakoformArtifactManifest): string {
  const uploadId = "up_cutover";
  const manifestDigest = `sha256:${"f".repeat(64)}`;
  database
    .query(
      `INSERT INTO tf_artifact_uploads
         (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at,
          lifecycle_state, lifecycle_fence, updated_at, abandoned_at)
       VALUES (?, ?, ?, ?, ?, 10, 'open', 1, 10, NULL)`,
    )
    .run(
      uploadId,
      PRINCIPAL.tenantId,
      PRINCIPAL.principalId,
      JSON.stringify(manifest),
      manifestDigest,
    );
  for (const module of manifest.modules ?? []) {
    database
      .query(
        "INSERT INTO tf_artifact_manifest_members (manifest_digest, blob_digest) VALUES (?, ?)",
      )
      .run(manifestDigest, module.digest);
  }
  database
    .query(
      `INSERT INTO tf_artifact_roots
         (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
          expires_at, release_reason, created_at, released_at)
       VALUES (?, 'upload', ?, 'manifest', ?, 'active', 1, NULL, NULL, 10, NULL)`,
    )
    .run(PRINCIPAL.tenantId, uploadId, manifestDigest);
  return uploadId;
}

describe("0043 external blob I/O cutover", () => {
  test("drains the actual historical PUT before admitting one leased PUT", async () => {
    const database = databaseBefore0043();
    const sql = createSqliteSql(database);
    const baseObjects = createMemoryObjectStore();
    const oldBytes = new TextEncoder().encode("historical put");
    const newBytes = new TextEncoder().encode("leased put");
    const manifest = await manifestFor([oldBytes, newBytes]);
    const oldDigest = manifest.modules?.[0]?.digest;
    const newDigest = manifest.modules?.[1]?.digest;
    if (!oldDigest || !newDigest) throw new Error("cutover digest fixture is missing");
    const uploadId = seedOpenUpload(database, manifest);
    const drain = new HistoricalInvocationDrain();
    const pause = pausePoint();
    const externalPuts: Array<string | null> = [];
    const observedNewLeaseStates: string[] = [];
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async put(key, body, options) {
        externalPuts.push(options?.writeOperationId ?? null);
        if (options?.writeOperationId) {
          const lease = await sql.query(
            `SELECT state, last_outcome FROM tf_artifact_blob_io_leases
             WHERE digest = ? AND operation_id = ?`,
            [newDigest, options.writeOperationId],
          );
          observedNewLeaseStates.push(`${lease[0]?.state}:${lease[0]?.last_outcome}`);
        }
        return await baseObjects.put(key, body, options);
      },
    };

    const historical = historicalArtifactPut({
      sql,
      objects,
      drain,
      uploadId,
      digest: oldDigest,
      bytes: oldBytes,
      beforeExternalPut: pause.enter,
    });
    await pause.entered;
    expect(drain.receiptEligible).toBe(false);
    expect(externalPuts).toEqual([]);

    pause.release();
    expect((await historical).status).toBe(201);
    expect(drain.receiptEligible).toBe(true);
    expect(externalPuts).toEqual([null]);
    apply0043(database);

    let random = 0;
    const artifacts = createTakoformArtifacts({
      sql,
      objects,
      clock: () => new Date(1_000),
      randomId: () => `cutover-put-${++random}`,
    });
    const current = await artifacts.handle(
      new Request(
        `https://api.test/apis/forms.takoform.com/v1/artifacts/uploads/${uploadId}/blobs/${newDigest}`,
        { method: "PUT", body: newBytes as unknown as BodyInit },
      ),
      PRINCIPAL,
      (code, status) => Response.json({ error: { code } }, { status }),
    );
    expect(current?.status).toBe(201);
    expect(externalPuts).toHaveLength(2);
    expect(externalPuts[1]).toMatch(/^abw_/u);
    expect(observedNewLeaseStates).toEqual(["writing:write_admitted"]);
    expect(
      await sql.query(
        `SELECT digest, state, last_outcome FROM tf_artifact_blob_io_leases
         WHERE digest = ?`,
        [newDigest],
      ),
    ).toEqual([{ digest: newDigest, state: "available", last_outcome: "write_committed" }]);
    expect(
      await sql.query(
        `SELECT digest, operation_kind, outcome FROM tf_artifact_blob_io_results
         WHERE digest = ?`,
        [newDigest],
      ),
    ).toEqual([{ digest: newDigest, operation_kind: "write", outcome: "write_committed" }]);
    expect(
      await sql.query(
        `SELECT digest FROM tf_artifact_holds
         WHERE tenant_id = ? AND kind = 'blob' ORDER BY digest`,
        [PRINCIPAL.tenantId],
      ),
    ).toEqual(
      [{ digest: oldDigest }, { digest: newDigest }].sort((a, b) =>
        a.digest.localeCompare(b.digest),
      ),
    );
    expect(await baseObjects.head(`art/${oldDigest.slice("sha256:".length)}`)).not.toBeNull();
    expect(await baseObjects.head(`art/${newDigest.slice("sha256:".length)}`)).not.toBeNull();
  });

  test("drains an already-deleting historical GC before one claimed and started delete", async () => {
    const database = databaseBefore0043();
    const baseSql = createSqliteSql(database);
    const baseObjects = createMemoryObjectStore();
    const oldBytes = new TextEncoder().encode("historical delete");
    const oldDigest = (await bytesDigest(oldBytes)) as `sha256:${string}`;
    const oldKey = `art/${oldDigest.slice("sha256:".length)}`;
    const oldStored = await baseObjects.put(oldKey, oldBytes);
    database
      .query(
        `INSERT INTO tf_artifact_gc_candidates
           (kind, digest, state, fence, not_before, expected_etag, attempts,
            last_outcome, created_at, updated_at, deleted_at)
         VALUES ('blob', ?, 'deleting', 2, 1, ?, 1, 'claimed', 1, 2, NULL)`,
      )
      .run(oldDigest, oldStored.etag);

    const drain = new HistoricalInvocationDrain();
    const pause = pausePoint();
    let oldExternalDeletes = 0;
    const historicalObjects: ObjectStoreAccess = {
      ...baseObjects,
      async delete(key) {
        oldExternalDeletes += 1;
        return await baseObjects.delete(key);
      },
    };
    const historical = historicalDeletingBlobGc({
      sql: baseSql,
      objects: historicalObjects,
      drain,
      digest: oldDigest,
      timestamp: 20,
      beforeExternalDelete: pause.enter,
    });
    await pause.entered;
    expect(drain.receiptEligible).toBe(false);
    expect(oldExternalDeletes).toBe(0);
    pause.release();
    expect(await historical).toBe("deleted");
    expect(drain.receiptEligible).toBe(true);
    expect(oldExternalDeletes).toBe(1);
    expect(await baseObjects.head(oldKey)).toBeNull();
    expect(
      await baseSql.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [oldDigest],
      ),
    ).toEqual([{ state: "deleted", last_outcome: "deleted" }]);
    apply0043(database);
    expect(
      await baseSql.query("SELECT digest FROM tf_artifact_blob_io_leases WHERE digest = ?", [
        oldDigest,
      ]),
    ).toEqual([]);

    const newBytes = new TextEncoder().encode("leased delete");
    const newDigest = (await bytesDigest(newBytes)) as `sha256:${string}`;
    const newKey = `art/${newDigest.slice("sha256:".length)}`;
    await baseObjects.put(newKey, newBytes);
    database
      .query(
        `INSERT INTO tf_artifact_gc_candidates
           (kind, digest, state, fence, not_before, expected_etag, attempts,
            last_outcome, created_at, updated_at, deleted_at)
         VALUES ('blob', ?, 'pending', 1, 1, NULL, 0, 'pending', 1, 1, NULL)`,
      )
      .run(newDigest);

    const observedLeaseStates: string[] = [];
    const tracingSql: Sql = {
      query: (statement, params) => baseSql.query(statement, params),
      run: (statement, params) => baseSql.run(statement, params),
      async batch(statements) {
        const result = await baseSql.batch(statements);
        if (
          statements.some(
            ({ sql }) => sql.includes("VALUES (?, 'deleting'") && sql.includes("'delete_claimed'"),
          )
        ) {
          const lease = await baseSql.query(
            "SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?",
            [newDigest],
          );
          observedLeaseStates.push(`${lease[0]?.state}:${lease[0]?.last_outcome}`);
        }
        return result;
      },
    };
    let newExternalDeletes = 0;
    const currentObjects: ObjectStoreAccess = {
      ...baseObjects,
      async delete(key) {
        const lease = await baseSql.query(
          "SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?",
          [newDigest],
        );
        observedLeaseStates.push(`${lease[0]?.state}:${lease[0]?.last_outcome}`);
        newExternalDeletes += 1;
        return await baseObjects.delete(key);
      },
    };
    let random = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql: tracingSql,
      objects: currentObjects,
      clock: () => new Date(100),
      randomId: () => `cutover-delete-${++random}`,
    });
    const report = await reconciler.reconcile({ limit: 16, deleteObjects: true });
    expect(report.deletedObjects).toBe(1);
    expect(newExternalDeletes).toBe(1);
    expect(observedLeaseStates).toEqual(["deleting:delete_claimed", "deleting:delete_started"]);
    expect(
      await baseSql.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [newDigest],
      ),
    ).toEqual([{ state: "deleted", last_outcome: "deleted" }]);
    expect(
      await baseSql.query(
        `SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?`,
        [newDigest],
      ),
    ).toEqual([{ state: "available", last_outcome: "deleted" }]);
    expect(
      await baseSql.query(
        `SELECT operation_kind, outcome FROM tf_artifact_blob_io_results WHERE digest = ?`,
        [newDigest],
      ),
    ).toEqual([{ operation_kind: "delete", outcome: "deleted" }]);
    expect(await baseObjects.head(newKey)).toBeNull();
  });
});
