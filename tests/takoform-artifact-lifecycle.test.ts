import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app.ts";
import type { ExternalIdentityVerifier } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { bytesDigest } from "../src/json.ts";
import type { FundingSettlementVerifier } from "../src/ledger.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createR2HttpObjectStore } from "../src/objects-r2-http.ts";
import type { ObjectStoreAccess, Sql } from "../src/ports.ts";
import { createTakoformArtifactReconciler } from "../src/takoform/artifact-reconciler.ts";
import {
  createTakoformArtifacts,
  type TakoformArtifactManifest,
  type TakoformArtifactPrincipal,
} from "../src/takoform/artifacts.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";

const PREFIX = "/apis/forms.takoform.com/v1/artifacts";
const PRINCIPAL: TakoformArtifactPrincipal = {
  tenantId: "tenant_a",
  principalId: "run:failed-run-a",
};
const SECOND_PRINCIPAL: TakoformArtifactPrincipal = {
  tenantId: "tenant_b",
  principalId: "run:failed-run-b",
};
const IDENTITY: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
  },
};
const SETTLEMENT: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "funding", amountMinor: 1_000, currency: "USD" };
  },
};

interface ArtifactFixture {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly call: (
    path: string,
    init: RequestInit,
    principal?: TakoformArtifactPrincipal,
  ) => Promise<Response>;
}

interface AckLossSql {
  readonly sql: Sql;
  loseNextAcknowledgement(statementFragment: string): void;
}

function ackLossSql(base: Sql): AckLossSql {
  let fragment: string | null = null;
  const shouldLose = (statements: readonly string[]): boolean => {
    if (!fragment || !statements.some((statement) => statement.includes(fragment as string))) {
      return false;
    }
    fragment = null;
    return true;
  };
  return {
    loseNextAcknowledgement(statementFragment) {
      fragment = statementFragment;
    },
    sql: {
      query: (statement, params) => base.query(statement, params),
      async run(statement, params) {
        const result = await base.run(statement, params);
        if (shouldLose([statement])) throw new Error("simulated lost SQL acknowledgement");
        return result;
      },
      async batch(statements) {
        const result = await base.batch(statements);
        if (shouldLose(statements.map((statement) => statement.sql))) {
          throw new Error("simulated lost SQL acknowledgement");
        }
        return result;
      },
    },
  };
}

function failNextSqlBeforeWrite(base: Sql): AckLossSql {
  let fragment: string | null = null;
  const shouldFail = (statements: readonly string[]): boolean => {
    if (!fragment || !statements.some((statement) => statement.includes(fragment as string))) {
      return false;
    }
    fragment = null;
    return true;
  };
  return {
    loseNextAcknowledgement(statementFragment) {
      fragment = statementFragment;
    },
    sql: {
      query: (statement, params) => base.query(statement, params),
      async run(statement, params) {
        if (shouldFail([statement])) throw new Error("simulated SQL outage before write");
        return await base.run(statement, params);
      },
      async batch(statements) {
        if (shouldFail(statements.map((statement) => statement.sql))) {
          throw new Error("simulated SQL outage before write");
        }
        return await base.batch(statements);
      },
    },
  };
}

function fixture(input?: {
  readonly sql?: Sql;
  readonly objects?: ObjectStoreAccess;
  readonly clock?: () => Date;
}): ArtifactFixture {
  const sql = input?.sql ?? createEphemeralSql();
  const objects = input?.objects ?? createMemoryObjectStore();
  let id = 0;
  const artifacts = createTakoformArtifacts({
    sql,
    objects,
    clock: input?.clock ?? (() => new Date("2026-08-31T00:00:00.000Z")),
    randomId: () => `artifact-${++id}`,
  });
  return {
    sql,
    objects,
    async call(path, init, principal = PRINCIPAL) {
      const response = await artifacts.handle(
        new Request(`https://api.test${PREFIX}/${path}`, init),
        principal,
        (code, status) => Response.json({ error: { code } }, { status }),
      );
      if (!response) throw new Error("artifact path was not handled");
      return response;
    },
  };
}

async function workerManifest(bytes: Uint8Array): Promise<TakoformArtifactManifest> {
  return {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle",
    mainModule: "worker.mjs",
    modules: [
      {
        name: "worker.mjs",
        mediaType: "application/javascript+module",
        size: bytes.byteLength,
        digest: (await bytesDigest(bytes)) as `sha256:${string}`,
      },
    ],
  };
}

async function startUpload(
  target: ArtifactFixture,
  manifest: TakoformArtifactManifest,
  key: string,
  principal = PRINCIPAL,
): Promise<{ readonly response: Response; readonly uploadId: string }> {
  const response = await target.call(
    "uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ manifest }),
    },
    principal,
  );
  const body = (await response.clone().json()) as { uploadId: string };
  return { response, uploadId: body.uploadId };
}

async function prepareDueBlobCandidate(input: {
  readonly target: ArtifactFixture;
  readonly reconciler: ReturnType<typeof createTakoformArtifactReconciler>;
  readonly advance: (milliseconds: number) => void;
  readonly bytes: Uint8Array;
  readonly manifest: TakoformArtifactManifest;
  readonly digest: string;
  readonly key: string;
}): Promise<void> {
  const started = await startUpload(input.target, input.manifest, `${input.key}-start`);
  expect(
    (
      await input.target.call(`uploads/${started.uploadId}/blobs/${input.digest}`, {
        method: "PUT",
        body: input.bytes as unknown as BodyInit,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await input.target.call(`uploads/${started.uploadId}`, {
        method: "DELETE",
        headers: { "idempotency-key": `${input.key}-delete` },
      })
    ).status,
  ).toBe(204);
  input.advance(25 * 60 * 60_000);
  await input.reconciler.reconcile({ limit: 16, deleteObjects: false });
  input.advance(2 * 60 * 60_000);
}

describe("Takoform artifact lifecycle", () => {
  test("an object transport without exact write identity is rejected at composition", async () => {
    const sql = createEphemeralSql();
    let objectRequests = 0;
    const objects = createR2HttpObjectStore({
      accountId: "account",
      bucketName: "bucket",
      authorize: () => "Bearer test",
      apiOrigin: "https://r2.test",
      fetch: async () => {
        objectRequests += 1;
        return new Response(null, { status: 500 });
      },
    });
    expect(() => fixture({ sql, objects })).toThrow("exact write operation identity");
    expect(objectRequests).toBe(0);
    expect(await sql.query("SELECT * FROM tf_artifact_blob_io_leases")).toEqual([]);
  });

  test("a committed upload cannot be abandoned through the public DELETE", async () => {
    const target = fixture();
    const bytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('ok') } }",
    );
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");

    const { uploadId } = await startUpload(target, manifest, "start-committed-upload");
    expect(
      (
        await target.call(`uploads/${uploadId}/blobs/${digest}`, {
          method: "PUT",
          body: bytes,
        })
      ).status,
    ).toBe(201);
    const committed = await target.call(`uploads/${uploadId}/commit`, {
      method: "POST",
      headers: { "idempotency-key": "commit-committed-upload" },
    });
    expect(committed.status).toBe(201);
    const { manifestDigest } = (await committed.json()) as { manifestDigest: string };

    const abandoned = await target.call(`uploads/${uploadId}`, {
      method: "DELETE",
      headers: { "idempotency-key": "delete-committed-upload" },
    });
    expect(abandoned.status).toBe(409);
    expect(await abandoned.json()).toEqual({ error: { code: "artifact_committed" } });

    expect((await target.call(manifestDigest, { method: "GET" })).status).toBe(200);
    expect((await target.call(`blobs/${digest}`, { method: "HEAD" })).status).toBe(200);
  });

  test("an upload abandoned while its body is arriving cannot publish bytes or a hold", async () => {
    const durable = createEphemeralSql();
    let uploadRead!: () => void;
    const uploadWasRead = new Promise<void>((resolve) => {
      uploadRead = resolve;
    });
    let observeOwnedUpload = false;
    const sql: Sql = {
      async query(statement, params) {
        const rows = await durable.query(statement, params);
        if (observeOwnedUpload && statement.includes("FROM tf_artifact_uploads")) {
          observeOwnedUpload = false;
          uploadRead();
        }
        return rows;
      },
      run: (statement, params) => durable.run(statement, params),
      batch: (statements) => durable.batch(statements),
    };
    const objects = createMemoryObjectStore();
    let timestamp = Date.parse("2026-09-08T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "body-arrival-race",
    });
    const bytes = new TextEncoder().encode("export default 'late body'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const started = await startUpload(target, manifest, "start-late-body");

    let releaseBody!: () => void;
    const bodyReleased = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await bodyReleased;
        controller.enqueue(bytes);
        controller.close();
      },
    });
    observeOwnedUpload = true;
    const put = target.call(`uploads/${started.uploadId}/blobs/${digest}`, {
      method: "PUT",
      body,
    });
    await uploadWasRead;
    expect(
      (
        await target.call(`uploads/${started.uploadId}`, {
          method: "DELETE",
          headers: { "idempotency-key": "delete-before-body" },
        })
      ).status,
    ).toBe(204);
    timestamp += 25 * 60 * 60_000;
    await reconciler.reconcile({ limit: 16, deleteObjects: false });

    releaseBody();
    const response = await put;
    expect(response.status).toBe(409);
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).toBeNull();
    expect(
      await durable.query(
        `SELECT 1 AS held FROM tf_artifact_holds
         WHERE tenant_id = ? AND digest = ? AND kind = 'blob'`,
        [PRINCIPAL.tenantId, digest],
      ),
    ).toEqual([]);
  });

  test("a writer CAS atomically revives a pending digest before collection", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    let timestamp = Date.parse("2026-09-09T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "writer-revives-candidate",
    });
    const bytes = new TextEncoder().encode("export default 'revive'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const original = await startUpload(target, manifest, "start-revive-original");
    expect(
      (
        await target.call(`uploads/${original.uploadId}/blobs/${digest}`, {
          method: "PUT",
          body: bytes,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await target.call(`uploads/${original.uploadId}`, {
          method: "DELETE",
          headers: { "idempotency-key": "delete-revive-original" },
        })
      ).status,
    ).toBe(204);
    timestamp += 25 * 60 * 60_000;
    await reconciler.reconcile({ limit: 16, deleteObjects: false });
    expect(
      await sql.query(
        `SELECT state FROM tf_artifact_gc_candidates WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "pending" }]);

    const replacement = await startUpload(
      target,
      manifest,
      "start-revive-replacement",
      SECOND_PRINCIPAL,
    );
    expect(
      (
        await target.call(
          `uploads/${replacement.uploadId}/blobs/${digest}`,
          { method: "PUT", body: bytes },
          SECOND_PRINCIPAL,
        )
      ).status,
    ).toBe(201);
    expect(
      await sql.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "cancelled", last_outcome: "reference_present" }]);
    expect(
      await sql.query(
        `SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "available", last_outcome: "write_committed" }]);

    timestamp += 2 * 60 * 60_000;
    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(0);
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).not.toBeNull();
  });

  test("lost R2 PUT acknowledgement recovers only through exact operation metadata", async () => {
    const sql = createEphemeralSql();
    const baseObjects = createMemoryObjectStore();
    let loseAcknowledgement = true;
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async put(key, body, options) {
        const written = await baseObjects.put(key, body, options);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("simulated lost R2 PUT acknowledgement");
        }
        return written;
      },
    };
    let timestamp = Date.parse("2026-09-10T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "recover-r2-put-ack",
    });
    const bytes = new TextEncoder().encode("export default 'R2 ack'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const started = await startUpload(target, manifest, "start-r2-put-ack");

    await expect(
      target.call(`uploads/${started.uploadId}/blobs/${digest}`, {
        method: "PUT",
        body: bytes,
      }),
    ).rejects.toThrow("lost R2 PUT acknowledgement");
    expect(
      (
        await target.call(`uploads/${started.uploadId}`, {
          method: "DELETE",
          headers: { "idempotency-key": "delete-r2-put-ack-blocked" },
        })
      ).status,
    ).toBe(409);
    timestamp += 5 * 60_000;
    await reconciler.reconcile({ limit: 16, deleteObjects: false });
    expect(
      await sql.query(
        `SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "available", last_outcome: "write_committed" }]);
    expect((await target.call(`blobs/${digest}`, { method: "HEAD" })).status).toBe(200);
  });

  test("lost writer settlement acknowledgement survives immediate lease reuse", async () => {
    const durable = createEphemeralSql();
    let loseSettlement = true;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        const result = await durable.batch(statements);
        if (
          loseSettlement &&
          statements.some(({ sql }) => sql.includes("INSERT INTO tf_artifact_blob_io_results"))
        ) {
          loseSettlement = false;
          await durable.run(
            `UPDATE tf_artifact_blob_io_leases
             SET operation_id = 'abw_later_reuse', fence = fence + 1, updated_at = updated_at + 1
             WHERE state = 'available'`,
          );
          throw new Error("simulated lost writer settlement acknowledgement");
        }
        return result;
      },
    };
    const target = fixture({ sql });
    const bytes = new TextEncoder().encode("export default 'writer result reuse'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const started = await startUpload(target, manifest, "start-writer-result-reuse");

    expect(
      (
        await target.call(`uploads/${started.uploadId}/blobs/${digest}`, {
          method: "PUT",
          body: bytes,
        })
      ).status,
    ).toBe(201);
    expect(
      await durable.query(
        `SELECT operation_kind, digest, outcome FROM tf_artifact_blob_io_results
         WHERE operation_kind = 'write'`,
      ),
    ).toEqual([{ operation_kind: "write", digest, outcome: "write_committed" }]);
  });

  test("an expired writer never adopts pre-existing identical bytes", async () => {
    const sql = createEphemeralSql();
    const baseObjects = createMemoryObjectStore();
    let putEntered!: () => void;
    const putWasEntered = new Promise<void>((resolve) => {
      putEntered = resolve;
    });
    let releasePut!: () => void;
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let pausePut = false;
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async put(key, body, options) {
        if (pausePut) {
          pausePut = false;
          putEntered();
          await putReleased;
        }
        return await baseObjects.put(key, body, options);
      },
    };
    let timestamp = Date.parse("2026-09-10T12:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "reject-preexisting-identical",
    });
    const bytes = new TextEncoder().encode("export default 'pre-existing exact bytes'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const objectKey = `art/${digest.slice("sha256:".length)}`;
    await baseObjects.put(objectKey, bytes);
    const started = await startUpload(target, manifest, "start-preexisting-identical");
    pausePut = true;
    const put = target.call(`uploads/${started.uploadId}/blobs/${digest}`, {
      method: "PUT",
      body: bytes,
    });
    await putWasEntered;

    timestamp += 5 * 60_000;
    await reconciler.reconcile({ limit: 16, deleteObjects: false });
    expect(
      await sql.query(
        `SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "writing", last_outcome: "write_admitted" }]);
    expect(
      await sql.query(
        `SELECT 1 AS held FROM tf_artifact_holds
         WHERE tenant_id = ? AND kind = 'blob' AND digest = ?`,
        [PRINCIPAL.tenantId, digest],
      ),
    ).toEqual([]);

    releasePut();
    expect((await put).status).toBe(201);
    expect((await baseObjects.head(objectKey))?.writeOperationId).toMatch(/^abw_/u);
  });

  test("an expired writer never adopts corrupt bytes tagged with its operation", async () => {
    const sql = createEphemeralSql();
    const baseObjects = createMemoryObjectStore();
    const corrupt = new TextEncoder().encode("export default 'bad bytes'");
    let loseAcknowledgement = true;
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async put(key, _body, options) {
        const written = await baseObjects.put(key, corrupt, options);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("simulated corrupt R2 PUT acknowledgement loss");
        }
        return written;
      },
    };
    let timestamp = Date.parse("2026-09-10T18:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "reject-corrupt-operation-bytes",
    });
    const expected = new TextEncoder().encode("export default 'ok! bytes'");
    expect(corrupt.byteLength).toBe(expected.byteLength);
    const manifest = await workerManifest(expected);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const started = await startUpload(target, manifest, "start-corrupt-operation-bytes");

    await expect(
      target.call(`uploads/${started.uploadId}/blobs/${digest}`, {
        method: "PUT",
        body: expected,
      }),
    ).rejects.toThrow("corrupt R2 PUT acknowledgement loss");
    timestamp += 5 * 60_000;
    await reconciler.reconcile({ limit: 16, deleteObjects: false });

    expect(
      await sql.query(
        `SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "writing", last_outcome: "write_admitted" }]);
    expect(
      await sql.query(
        `SELECT 1 AS held FROM tf_artifact_holds
         WHERE tenant_id = ? AND kind = 'blob' AND digest = ?`,
        [PRINCIPAL.tenantId, digest],
      ),
    ).toEqual([]);
  });

  test("start, commit, and abandon read back their atomic result after acknowledgement loss", async () => {
    const durable = createEphemeralSql();
    const fault = ackLossSql(durable);
    const target = fixture({ sql: fault.sql });
    const bytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('ack') } }",
    );
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");

    fault.loseNextAcknowledgement("INSERT INTO tf_artifact_uploads");
    const recoveredStart = await startUpload(target, manifest, "start-ack-loss");
    expect(recoveredStart.response.status).toBe(201);
    const started = await startUpload(target, manifest, "start-ack-loss");
    expect(started.response.status).toBe(201);
    expect(started.uploadId).toBe(recoveredStart.uploadId);
    expect(
      await durable.query(
        "SELECT id, lifecycle_state FROM tf_artifact_uploads WHERE tenant_id = ? ORDER BY id",
        [PRINCIPAL.tenantId],
      ),
    ).toEqual([{ id: started.uploadId, lifecycle_state: "open" }]);

    expect(
      (
        await target.call(`uploads/${started.uploadId}/blobs/${digest}`, {
          method: "PUT",
          body: bytes,
        })
      ).status,
    ).toBe(201);
    fault.loseNextAcknowledgement("INSERT OR IGNORE INTO tf_artifact_manifests");
    const recoveredCommit = await target.call(`uploads/${started.uploadId}/commit`, {
      method: "POST",
      headers: { "idempotency-key": "commit-ack-loss" },
    });
    expect(recoveredCommit.status).toBe(201);
    const committed = await target.call(`uploads/${started.uploadId}/commit`, {
      method: "POST",
      headers: { "idempotency-key": "commit-ack-loss" },
    });
    expect(committed.status).toBe(201);
    expect(await committed.json()).toEqual({ manifestDigest: expect.any(String) });

    const second = await startUpload(target, manifest, "start-delete-ack-loss");
    fault.loseNextAcknowledgement("lifecycle_state = 'abandoned'");
    const recoveredDelete = await target.call(`uploads/${second.uploadId}`, {
      method: "DELETE",
      headers: { "idempotency-key": "delete-ack-loss" },
    });
    expect(recoveredDelete.status).toBe(204);
    expect(
      (
        await target.call(`uploads/${second.uploadId}`, {
          method: "DELETE",
          headers: { "idempotency-key": "delete-ack-loss" },
        })
      ).status,
    ).toBe(204);
    expect(
      await durable.query("SELECT lifecycle_state FROM tf_artifact_uploads WHERE id = ?", [
        second.uploadId,
      ]),
    ).toEqual([{ lifecycle_state: "abandoned" }]);
  });

  test("a previous writer can commit an upload started by the new writer after migration", async () => {
    const sql = createEphemeralSql();
    const target = fixture({ sql });
    const bytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('mixed writer') } }",
    );
    const manifest = await workerManifest(bytes);
    const blobDigest = manifest.modules?.[0]?.digest;
    if (!blobDigest) throw new Error("fixture digest is missing");
    const started = await startUpload(target, manifest, "start-new-commit-previous");
    expect(
      (
        await target.call(`uploads/${started.uploadId}/blobs/${blobDigest}`, {
          method: "PUT",
          body: bytes,
        })
      ).status,
    ).toBe(201);
    const rows = await sql.query(
      `SELECT manifest_json, manifest_digest FROM tf_artifact_uploads
       WHERE id = ? AND tenant_id = ? AND principal_id = ?`,
      [started.uploadId, PRINCIPAL.tenantId, PRINCIPAL.principalId],
    );
    const manifestJson = String(rows[0]?.manifest_json);
    const manifestDigest = String(rows[0]?.manifest_digest);

    // Exact SQL sequence emitted by the previous Worker after it reads the
    // new writer's six durable upload columns.
    await sql.run(
      `INSERT OR IGNORE INTO tf_artifact_manifests (digest, manifest_json, created_at)
       VALUES (?, ?, ?)`,
      [manifestDigest, manifestJson, Date.parse("2026-08-31T00:01:00.000Z")],
    );
    await sql.run(
      `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
       VALUES (?, ?, 'manifest')`,
      [PRINCIPAL.tenantId, manifestDigest],
    );
    await sql.run(
      `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
       VALUES (?, ?, 'blob')`,
      [PRINCIPAL.tenantId, blobDigest],
    );
    const replayKey = [
      PRINCIPAL.tenantId,
      PRINCIPAL.principalId,
      "POST",
      `${PREFIX}/uploads/${started.uploadId}/commit`,
      "commit-by-previous",
    ].join("\u0000");
    await sql.run(
      `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
       VALUES (?, 201, ?, ?)`,
      [replayKey, JSON.stringify({ manifestDigest }), Date.parse("2026-09-01T00:01:00.000Z")],
    );

    expect(
      await sql.query(
        `SELECT lifecycle_state, lifecycle_fence FROM tf_artifact_uploads WHERE id = ?`,
        [started.uploadId],
      ),
    ).toEqual([{ lifecycle_state: "committed", lifecycle_fence: 2 }]);
    expect(
      await sql.query(
        `SELECT state, fence FROM tf_artifact_roots
         WHERE tenant_id = ? AND root_kind = 'upload' AND root_id = ?`,
        [PRINCIPAL.tenantId, started.uploadId],
      ),
    ).toEqual([{ state: "active", fence: 2 }]);
    expect((await target.call(manifestDigest, { method: "GET" })).status).toBe(200);
    expect(
      (
        await createTakoformArtifactReconciler({
          sql,
          objects: target.objects,
          clock: () => new Date("2026-08-31T00:02:00.000Z"),
          randomId: () => "mixed-writer-readback",
        }).status()
      ).danglingCommittedUploads,
    ).toBe(0);
  });

  test("repairs a blob whose R2 write succeeded before its tenant hold failed", async () => {
    const durable = createEphemeralSql();
    const fault = failNextSqlBeforeWrite(durable);
    const objects = createMemoryObjectStore();
    let timestamp = Date.parse("2026-08-31T01:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql: fault.sql, objects, clock });
    const bytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('repair') } }",
    );
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const { uploadId } = await startUpload(target, manifest, "start-partial-put");

    fault.loseNextAcknowledgement("INSERT OR IGNORE INTO tf_artifact_holds");
    await expect(
      target.call(`uploads/${uploadId}/blobs/${digest}`, { method: "PUT", body: bytes }),
    ).rejects.toThrow("simulated SQL outage before write");
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).not.toBeNull();
    expect((await target.call(`blobs/${digest}`, { method: "HEAD" })).status).toBe(404);

    const reconciler = createTakoformArtifactReconciler({
      sql: durable,
      objects,
      clock,
      randomId: () => "repair-partial-put",
    });
    expect(await reconciler.dryRun({ limit: 16 })).toMatchObject({
      repairableHolds: 0,
      expiredReplays: 0,
    });
    timestamp += 5 * 60_000;
    expect(await reconciler.reconcile({ limit: 16, deleteObjects: false })).toMatchObject({
      repairedHolds: 0,
      deletedObjects: 0,
    });
    expect((await target.call(`blobs/${digest}`, { method: "HEAD" })).status).toBe(200);
  });

  test("finds a repairable missing hold beyond a full page of absent R2 blobs", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    const clock = () => new Date("2026-09-01T00:00:00.000Z");
    let finalBlobDigest = "";
    for (let index = 0; index < 66; index += 1) {
      const blobDigest = `sha256:${index.toString(16).padStart(64, "0")}`;
      const manifestDigest = `sha256:${(10_000 + index).toString(16).padStart(64, "0")}`;
      const manifest = JSON.stringify({
        apiVersion: "artifacts.takoform.com/v1alpha1",
        kind: "WorkerBundle",
        mainModule: "worker.mjs",
        modules: [
          {
            name: "worker.mjs",
            mediaType: "application/javascript+module",
            size: 1,
            digest: blobDigest,
          },
        ],
      });
      await sql.run(
        `INSERT INTO tf_artifact_uploads
           (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
         VALUES (?, 'tenant_page', 'run:page', ?, ?, ?)`,
        [`up_page_${index}`, manifest, manifestDigest, index + 1],
      );
      if (index === 65) finalBlobDigest = blobDigest;
    }
    await objects.put(`art/${finalBlobDigest.slice("sha256:".length)}`, new Uint8Array([1]));
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "missing-hold-page",
    });

    expect(await reconciler.dryRun({ limit: 1 })).toMatchObject({
      repairableHolds: 1,
      missingHolds: 66,
    });
    expect(await reconciler.reconcile({ limit: 1, deleteObjects: false })).toMatchObject({
      repairedHolds: 1,
    });
  });

  test("keeps a shared digest while any tenant or unexpired replay still roots it", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    let timestamp = Date.parse("2026-08-31T02:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "shared-digest-reconcile",
    });
    const bytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('shared') } }",
    );
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");

    const first = await startUpload(target, manifest, "start-shared-first", PRINCIPAL);
    const second = await startUpload(target, manifest, "start-shared-second", SECOND_PRINCIPAL);
    for (const [upload, principal] of [
      [first, PRINCIPAL],
      [second, SECOND_PRINCIPAL],
    ] as const) {
      expect(
        (
          await target.call(
            `uploads/${upload.uploadId}/blobs/${digest}`,
            { method: "PUT", body: bytes },
            principal,
          )
        ).status,
      ).toBe(201);
    }

    expect(
      (
        await target.call(
          `uploads/${first.uploadId}`,
          { method: "DELETE", headers: { "idempotency-key": "delete-shared-first" } },
          PRINCIPAL,
        )
      ).status,
    ).toBe(204);
    expect(await reconciler.reconcile({ limit: 32, deleteObjects: true })).toMatchObject({
      candidatesCreated: 0,
      deletedObjects: 0,
    });
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).not.toBeNull();
    timestamp += 25 * 60 * 60_000;
    expect(await reconciler.reconcile({ limit: 32, deleteObjects: true })).toMatchObject({
      deletedObjects: 0,
    });
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).not.toBeNull();
    expect(
      (await target.call(`blobs/${digest}`, { method: "HEAD" }, SECOND_PRINCIPAL)).status,
    ).toBe(200);

    expect(
      (
        await target.call(
          `uploads/${second.uploadId}`,
          { method: "DELETE", headers: { "idempotency-key": "delete-shared-second" } },
          SECOND_PRINCIPAL,
        )
      ).status,
    ).toBe(204);
    // The start replay remains an independent root through its exact expiry.
    const fenced = await reconciler.reconcile({ limit: 32, deleteObjects: true });
    expect(fenced.candidatesCreated).toBeGreaterThanOrEqual(1);
    expect(fenced.deletedObjects).toBe(0);
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).not.toBeNull();

    // Candidate quarantine is deliberate; deletion happens only on a later,
    // fenced pass after another full zero-reference read.
    timestamp += 2 * 60 * 60_000;
    const collected = await reconciler.reconcile({ limit: 32, deleteObjects: true });
    expect(collected.deletedObjects).toBe(1);
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).toBeNull();
  });

  test("a new root that races a due candidate wins before external deletion", async () => {
    const sql = createEphemeralSql();
    const baseObjects = createMemoryObjectStore();
    let onHead: (() => Promise<void>) | null = null;
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async head(key) {
        const callback = onHead;
        onHead = null;
        if (callback) await callback();
        return await baseObjects.head(key);
      },
    };
    let timestamp = Date.parse("2026-09-02T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "new-root-race",
    });
    const bytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('race') } }",
    );
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const original = await startUpload(target, manifest, "start-race-original");
    expect(
      (
        await target.call(`uploads/${original.uploadId}/blobs/${digest}`, {
          method: "PUT",
          body: bytes,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await target.call(`uploads/${original.uploadId}`, {
          method: "DELETE",
          headers: { "idempotency-key": "delete-race-original" },
        })
      ).status,
    ).toBe(204);

    timestamp += 25 * 60 * 60_000;
    expect(
      (await reconciler.reconcile({ limit: 16, deleteObjects: false })).candidatesCreated,
    ).toBeGreaterThanOrEqual(1);
    timestamp += 2 * 60 * 60_000;
    let racedUploadId = "";
    onHead = async () => {
      const raced = await startUpload(target, manifest, "start-race-winner", SECOND_PRINCIPAL);
      expect(raced.response.status).toBe(201);
      racedUploadId = raced.uploadId;
    };
    const result = await reconciler.reconcile({ limit: 16, deleteObjects: true });
    expect(racedUploadId).not.toBe("");
    expect(result.deletedObjects).toBe(0);
    expect(await baseObjects.head(`art/${digest.slice("sha256:".length)}`)).not.toBeNull();
    expect(
      await sql.query(
        `SELECT state FROM tf_artifact_roots
         WHERE tenant_id = ? AND root_kind = 'upload' AND root_id = ?`,
        [SECOND_PRINCIPAL.tenantId, racedUploadId],
      ),
    ).toEqual([{ state: "active" }]);
  });

  test("two collectors cannot share one delete claim", async () => {
    const durable = createEphemeralSql();
    let claimed = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        const result = await durable.batch(statements);
        if (statements.some(({ sql }) => sql.includes("'delete_claimed'"))) claimed = true;
        return result;
      },
    };
    const baseObjects = createMemoryObjectStore();
    let postClaimHead!: () => void;
    const postClaimHeadEntered = new Promise<void>((resolve) => {
      postClaimHead = resolve;
    });
    let releaseHead!: () => void;
    const headReleased = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let paused = false;
    let deleteCalls = 0;
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async head(key) {
        if (claimed && !paused) {
          paused = true;
          postClaimHead();
          await headReleased;
        }
        return await baseObjects.head(key);
      },
      async delete(key) {
        deleteCalls += 1;
        return await baseObjects.delete(key);
      },
    };
    let timestamp = Date.parse("2026-09-13T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    let sequence = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => `overlap-${++sequence}`,
    });
    const bytes = new TextEncoder().encode("export default 'overlap'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    await prepareDueBlobCandidate({
      target,
      reconciler,
      advance(milliseconds) {
        timestamp += milliseconds;
      },
      bytes,
      manifest,
      digest,
      key: "overlap",
    });

    const owner = reconciler.reconcile({ limit: 16, deleteObjects: true });
    await postClaimHeadEntered;
    const observer = await reconciler.reconcile({ limit: 16, deleteObjects: true });
    expect(observer.deletedObjects).toBe(0);
    expect(deleteCalls).toBe(0);
    releaseHead();
    expect((await owner).deletedObjects).toBe(1);
    expect(deleteCalls).toBe(1);
  });

  test("an expired pre-delete claimant is fenced and reclaimed before external deletion", async () => {
    const durable = createEphemeralSql();
    let claimed = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        const result = await durable.batch(statements);
        if (statements.some(({ sql }) => sql.includes("'delete_claimed'"))) claimed = true;
        return result;
      },
    };
    const baseObjects = createMemoryObjectStore();
    let failPostClaimHead = true;
    let deleteCalls = 0;
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async head(key) {
        if (claimed && failPostClaimHead) {
          failPostClaimHead = false;
          throw new Error("simulated collector crash before delete start");
        }
        return await baseObjects.head(key);
      },
      async delete(key) {
        deleteCalls += 1;
        return await baseObjects.delete(key);
      },
    };
    let timestamp = Date.parse("2026-09-14T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    let sequence = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => `reclaim-${++sequence}`,
    });
    const bytes = new TextEncoder().encode("export default 'reclaim'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    await prepareDueBlobCandidate({
      target,
      reconciler,
      advance(milliseconds) {
        timestamp += milliseconds;
      },
      bytes,
      manifest,
      digest,
      key: "reclaim",
    });

    await expect(reconciler.reconcile({ limit: 16, deleteObjects: true })).rejects.toThrow(
      "collector crash before delete start",
    );
    expect(deleteCalls).toBe(0);
    timestamp += 5 * 60_000;
    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(1);
    expect(deleteCalls).toBe(1);
    expect(
      await durable.query(
        `SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "available", last_outcome: "deleted" }]);
  });

  test("an expired pre-delete owner resumes as an observer after its claim is reclaimed", async () => {
    const durable = createEphemeralSql();
    let firstClaimed = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        const result = await durable.batch(statements);
        if (statements.some(({ sql }) => sql.includes("'delete_claimed'"))) firstClaimed = true;
        return result;
      },
    };
    const baseObjects = createMemoryObjectStore();
    let firstHeadEntered!: () => void;
    const firstHeadWasEntered = new Promise<void>((resolve) => {
      firstHeadEntered = resolve;
    });
    let releaseFirstHead!: () => void;
    const firstHeadReleased = new Promise<void>((resolve) => {
      releaseFirstHead = resolve;
    });
    let paused = false;
    let deleteCalls = 0;
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async head(key) {
        if (firstClaimed && !paused) {
          paused = true;
          firstHeadEntered();
          await firstHeadReleased;
        }
        return await baseObjects.head(key);
      },
      async delete(key) {
        deleteCalls += 1;
        return await baseObjects.delete(key);
      },
    };
    let timestamp = Date.parse("2026-09-14T12:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    let sequence = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => `resume-after-reclaim-${++sequence}`,
    });
    const bytes = new TextEncoder().encode("export default 'resume after reclaim'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    await prepareDueBlobCandidate({
      target,
      reconciler,
      advance(milliseconds) {
        timestamp += milliseconds;
      },
      bytes,
      manifest,
      digest,
      key: "resume-after-reclaim",
    });

    const staleOwner = reconciler.reconcile({ limit: 16, deleteObjects: true });
    await firstHeadWasEntered;
    timestamp += 5 * 60_000;
    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(1);
    expect(deleteCalls).toBe(1);

    releaseFirstHead();
    expect((await staleOwner).deletedObjects).toBe(0);
    expect(deleteCalls).toBe(1);
    expect(
      await durable.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "deleted", last_outcome: "deleted" }]);
  });

  test("a stale pre-delete owner cannot overwrite its successor's ETag retry", async () => {
    const durable = createEphemeralSql();
    let firstClaimed = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        const result = await durable.batch(statements);
        if (statements.some(({ sql }) => sql.includes("'delete_claimed'"))) firstClaimed = true;
        return result;
      },
    };
    const baseObjects = createMemoryObjectStore();
    let firstHeadEntered!: () => void;
    const firstHeadWasEntered = new Promise<void>((resolve) => {
      firstHeadEntered = resolve;
    });
    let releaseFirstHead!: () => void;
    const firstHeadReleased = new Promise<void>((resolve) => {
      releaseFirstHead = resolve;
    });
    let paused = false;
    let deleteCalls = 0;
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async head(key) {
        if (firstClaimed && !paused) {
          paused = true;
          firstHeadEntered();
          await firstHeadReleased;
        }
        return await baseObjects.head(key);
      },
      async delete(key) {
        deleteCalls += 1;
        return await baseObjects.delete(key);
      },
    };
    let timestamp = Date.parse("2026-09-14T18:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    let sequence = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => `stale-etag-retry-${++sequence}`,
    });
    const bytes = new TextEncoder().encode("export default 'stale etag original'");
    const replacement = new TextEncoder().encode("export default 'stale etag replaced'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const key = `art/${digest.slice("sha256:".length)}`;
    await prepareDueBlobCandidate({
      target,
      reconciler,
      advance(milliseconds) {
        timestamp += milliseconds;
      },
      bytes,
      manifest,
      digest,
      key: "stale-etag-retry",
    });

    const staleOwner = reconciler.reconcile({ limit: 16, deleteObjects: true });
    await firstHeadWasEntered;
    await baseObjects.put(key, replacement);
    timestamp += 5 * 60_000;
    const successor = await reconciler.reconcile({ limit: 16, deleteObjects: true });
    expect(successor.retryableObjects).toBe(1);
    expect(deleteCalls).toBe(0);

    releaseFirstHead();
    const stale = await staleOwner;
    expect(stale.retryableObjects).toBe(0);
    expect(stale.deletedObjects).toBe(0);
    expect(deleteCalls).toBe(0);
    expect(
      await durable.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "retry", last_outcome: "etag_changed" }]);
    expect(await baseObjects.head(key)).not.toBeNull();
  });

  test("a started delete never gains a second claimant and does not block another digest", async () => {
    const sql = createEphemeralSql();
    const baseObjects = createMemoryObjectStore();
    let deleteEntered!: () => void;
    const firstDeleteEntered = new Promise<void>((resolve) => {
      deleteEntered = resolve;
    });
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let paused = false;
    const deleteCalls: string[] = [];
    const objects: ObjectStoreAccess = {
      ...baseObjects,
      async delete(key) {
        deleteCalls.push(key);
        if (!paused) {
          paused = true;
          deleteEntered();
          await deleteReleased;
        }
        return await baseObjects.delete(key);
      },
    };
    let timestamp = Date.parse("2026-09-15T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    let sequence = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => `started-${++sequence}`,
    });
    const firstBytes = new TextEncoder().encode("export default 'started first'");
    const secondBytes = new TextEncoder().encode("export default 'started second'");
    const firstManifest = await workerManifest(firstBytes);
    const secondManifest = await workerManifest(secondBytes);
    const firstDigest = firstManifest.modules?.[0]?.digest;
    const secondDigest = secondManifest.modules?.[0]?.digest;
    if (!firstDigest || !secondDigest) throw new Error("fixture digest is missing");
    for (const [bytes, manifest, digest, key] of [
      [firstBytes, firstManifest, firstDigest, "started-first"],
      [secondBytes, secondManifest, secondDigest, "started-second"],
    ] as const) {
      await prepareDueBlobCandidate({
        target,
        reconciler,
        advance(milliseconds) {
          timestamp += milliseconds;
        },
        bytes,
        manifest,
        digest,
        key,
      });
    }

    const owner = reconciler.reconcile({ limit: 16, deleteObjects: true });
    await firstDeleteEntered;
    const pausedKey = deleteCalls[0];
    timestamp += 10 * 60_000;
    const observer = await reconciler.reconcile({ limit: 16, deleteObjects: true });
    expect(observer.deletedObjects).toBe(1);
    expect(deleteCalls).toHaveLength(2);
    expect(new Set(deleteCalls).size).toBe(2);
    expect(await baseObjects.head(pausedKey ?? "missing")).not.toBeNull();

    releaseDelete();
    expect((await owner).deletedObjects).toBe(1);
    expect(deleteCalls).toHaveLength(2);
    expect(await baseObjects.head(pausedKey ?? "missing")).toBeNull();
  });

  test("an out-of-protocol unleased PUT before collector DELETE is removed and its hold is fenced", async () => {
    const durable = createEphemeralSql();
    const baseObjects = createMemoryObjectStore();
    let digest = "";
    let legacyHoldFenced = false;
    const replacement = new TextEncoder().encode("legacy late replacement");
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        const result = await durable.batch(statements);
        if (
          digest &&
          statements.some(({ sql }) => sql.includes("SET fence = fence + 1, lease_expires_at = ?"))
        ) {
          await baseObjects.put(`art/${digest.slice("sha256:".length)}`, replacement);
          try {
            await durable.run(
              `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
               VALUES (?, ?, 'blob')`,
              [PRINCIPAL.tenantId, digest],
            );
          } catch {
            legacyHoldFenced = true;
          }
        }
        return result;
      },
    };
    let timestamp = Date.parse("2026-09-16T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects: baseObjects, clock });
    let sequence = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects: baseObjects,
      clock,
      randomId: () => `late-put-${++sequence}`,
    });
    const bytes = new TextEncoder().encode("export default 'late put target'");
    const manifest = await workerManifest(bytes);
    digest = manifest.modules?.[0]?.digest ?? "";
    if (!digest) throw new Error("fixture digest is missing");
    await prepareDueBlobCandidate({
      target,
      reconciler,
      advance(milliseconds) {
        timestamp += milliseconds;
      },
      bytes,
      manifest,
      digest,
      key: "late-put",
    });

    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(1);
    expect(legacyHoldFenced).toBe(true);
    expect(await baseObjects.head(`art/${digest.slice("sha256:".length)}`)).toBeNull();
  });

  test("a lost SQL acknowledgement after delete settlement reads back the exact owner", async () => {
    const durable = createEphemeralSql();
    let loseSettlement = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        const result = await durable.batch(statements);
        if (loseSettlement && statements.some(({ sql }) => sql.includes("SET state = 'deleted'"))) {
          loseSettlement = false;
          await durable.run(
            `UPDATE tf_artifact_blob_io_leases
             SET operation_id = 'abd_later_reuse', fence = fence + 1, updated_at = updated_at + 1
             WHERE state = 'available'`,
          );
          throw new Error("simulated lost delete settlement acknowledgement");
        }
        return result;
      },
    };
    const objects = createMemoryObjectStore();
    let timestamp = Date.parse("2026-09-17T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    let sequence = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => `settle-ack-${++sequence}`,
    });
    const bytes = new TextEncoder().encode("export default 'settle ack'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    await prepareDueBlobCandidate({
      target,
      reconciler,
      advance(milliseconds) {
        timestamp += milliseconds;
      },
      bytes,
      manifest,
      digest,
      key: "settle-ack",
    });

    loseSettlement = true;
    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(1);
    expect(
      await durable.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "deleted", last_outcome: "deleted" }]);
  });

  test("an out-of-protocol unleased write is persistently re-quarantined from its released root", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    let timestamp = Date.parse("2026-09-18T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    let sequence = 0;
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => `legacy-rearm-${++sequence}`,
    });
    const bytes = new TextEncoder().encode("export default 'legacy rearm'");
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    await prepareDueBlobCandidate({
      target,
      reconciler,
      advance(milliseconds) {
        timestamp += milliseconds;
      },
      bytes,
      manifest,
      digest,
      key: "legacy-rearm",
    });
    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(1);

    const key = `art/${digest.slice("sha256:".length)}`;
    await objects.put(key, bytes);
    await sql.run(
      `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
       VALUES (?, ?, 'blob')`,
      [PRINCIPAL.tenantId, digest],
    );
    await reconciler.reconcile({ limit: 16, deleteObjects: false });
    expect(
      await sql.query(
        `SELECT state, not_before FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "pending", not_before: timestamp + 60 * 60_000 }]);
    expect(
      await sql.query(
        `SELECT 1 AS held FROM tf_artifact_holds
         WHERE tenant_id = ? AND kind = 'blob' AND digest = ?`,
        [PRINCIPAL.tenantId, digest],
      ),
    ).toEqual([]);
    expect(await objects.head(key)).not.toBeNull();

    timestamp += 2 * 60 * 60_000;
    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(1);
    expect(await objects.head(key)).toBeNull();
  });

  test("keeps an honest deleting tombstone when SQL settlement fails after object deletion", async () => {
    const durable = createEphemeralSql();
    const fault = failNextSqlBeforeWrite(durable);
    const objects = createMemoryObjectStore();
    let timestamp = Date.parse("2026-09-04T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql: fault.sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql: fault.sql,
      objects,
      clock,
      randomId: () => "partial-delete-settlement",
    });
    const bytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('partial') } }",
    );
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const started = await startUpload(target, manifest, "start-partial-delete");
    await target.call(`uploads/${started.uploadId}/blobs/${digest}`, {
      method: "PUT",
      body: bytes,
    });
    await target.call(`uploads/${started.uploadId}`, {
      method: "DELETE",
      headers: { "idempotency-key": "delete-partial-delete" },
    });
    timestamp += 25 * 60 * 60_000;
    await reconciler.reconcile({ limit: 16, deleteObjects: false });
    timestamp += 2 * 60 * 60_000;

    fault.loseNextAcknowledgement("SET state = 'deleted'");
    await expect(reconciler.reconcile({ limit: 16, deleteObjects: true })).rejects.toThrow(
      "simulated SQL outage before write",
    );
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).toBeNull();
    expect(
      await durable.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "deleting", last_outcome: "claimed" }]);

    // A pre-write SQL outage after the external delete is not an
    // acknowledgement: the original invocation may still resume. Absence and
    // elapsed time cannot release that started owner or authorize reuse.
    const retried = await reconciler.reconcile({ limit: 16, deleteObjects: true });
    expect(retried.deletedObjects).toBe(0);
    expect(retried.retryableObjects).toBe(0);
    expect(
      await durable.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "deleting", last_outcome: "claimed" }]);
    expect(
      await durable.query(
        `SELECT state, last_outcome FROM tf_artifact_blob_io_leases WHERE digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "deleting", last_outcome: "delete_started" }]);
  });

  test("cleans an exact failed-run upload only with a durable closure receipt and no live Resource", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    let timestamp = Date.parse("2026-09-06T00:00:00.000Z");
    const clock = () => new Date(timestamp);
    const target = fixture({ sql, objects, clock });
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "exact-failed-run-repair",
    });
    const bytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('failed run') } }",
    );
    const manifest = await workerManifest(bytes);
    const digest = manifest.modules?.[0]?.digest;
    if (!digest) throw new Error("fixture digest is missing");
    const started = await startUpload(target, manifest, "start-exact-failed-run");
    await target.call(`uploads/${started.uploadId}/blobs/${digest}`, {
      method: "PUT",
      body: bytes,
    });
    const committed = await target.call(`uploads/${started.uploadId}/commit`, {
      method: "POST",
      headers: { "idempotency-key": "commit-exact-failed-run" },
    });
    const { manifestDigest } = (await committed.json()) as { manifestDigest: string };
    const identity = {
      tenantId: PRINCIPAL.tenantId,
      principalId: PRINCIPAL.principalId,
      uploadId: started.uploadId,
      manifestDigest,
    };

    const blocked = await reconciler.repairExactFailedRun({
      ...identity,
      mode: "dry-run",
    });
    expect(blocked).toMatchObject({
      outcome: "blocked_receipt",
      lifecycle: "committed",
      externalDeleteIssued: false,
    });
    expect(JSON.stringify(blocked)).not.toContain(PRINCIPAL.tenantId);
    expect(JSON.stringify(blocked)).not.toContain(PRINCIPAL.principalId);
    expect(JSON.stringify(blocked)).not.toContain(manifestDigest);

    const [uploadFenceRow] = await sql.query(
      `SELECT upload.lifecycle_fence AS upload_fence, root.fence AS root_fence
       FROM tf_artifact_uploads AS upload
       JOIN tf_artifact_roots AS root
         ON root.tenant_id = upload.tenant_id AND root.root_kind = 'upload'
        AND root.root_id = upload.id AND root.target_kind = 'manifest'
        AND root.digest = upload.manifest_digest
       WHERE upload.id = ?`,
      [started.uploadId],
    );
    const uploadFence = Number(uploadFenceRow?.upload_fence);
    const rootFence = Number(uploadFenceRow?.root_fence);
    expect({ uploadFence, rootFence }).toEqual({ uploadFence: 2, rootFence: 2 });
    const insertReceipt = async (input: {
      readonly receiptId: string;
      readonly receiptFence: number;
      readonly closedAt: number;
      readonly expiresAt: number;
      readonly uploadId?: string;
    }): Promise<void> => {
      await sql.run(
        `INSERT INTO tf_artifact_owner_closure_receipts
           (receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
            manifest_digest, upload_fence, root_fence, state, closed_at,
            expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?)`,
        [
          input.receiptId,
          input.receiptFence,
          identity.tenantId,
          identity.principalId,
          input.uploadId ?? identity.uploadId,
          identity.manifestDigest,
          uploadFence,
          rootFence,
          input.closedAt,
          input.expiresAt,
          timestamp - 1_000,
          timestamp - 1_000,
        ],
      );
    };
    await insertReceipt({
      receiptId: "closure-valid",
      receiptFence: 7,
      closedAt: timestamp - 1_000,
      expiresAt: timestamp + 7 * 24 * 60 * 60_000,
    });
    await insertReceipt({
      receiptId: "closure-stale",
      receiptFence: 8,
      closedAt: timestamp - 2_000,
      expiresAt: timestamp,
    });
    await insertReceipt({
      receiptId: "closure-future",
      receiptFence: 9,
      closedAt: timestamp + 1,
      expiresAt: timestamp + 7 * 24 * 60 * 60_000,
    });
    await expect(
      sql.run(
        `UPDATE tf_artifact_owner_closure_receipts
         SET upload_fence = upload_fence + 1, updated_at = updated_at + 1
         WHERE receipt_id = 'closure-valid'`,
      ),
    ).rejects.toThrow();
    const closureReceipt = { receiptId: "closure-valid", receiptFence: 7 } as const;

    await sql.run(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, relations_json, package_digest, implementation_digest, updated_at)
       VALUES (?, 'default', 'edge.forms.takoform.com/v1beta1', 'WorkerBundle',
               'live-consumer', 'uid_live_consumer', '1', 'revision-live-consumer',
               ?, '[]', NULL, NULL, ?)`,
      [
        identity.tenantId,
        JSON.stringify({
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "WorkerBundle",
          metadata: { space: "default", name: "live-consumer", uid: "uid_live_consumer" },
          spec: { manifestDigest },
        }),
        timestamp,
      ],
    );
    await sql.run(
      `INSERT INTO tf_resource_deployments
         (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
          provider_installation_ref, native_id, native_claimed, state,
          observed_json, outputs_json, created_at, updated_at)
       VALUES (?, 'dep_live_consumer', 'uid_live_consumer', 'offering.test',
               'provider.test', 'installation.test', 'native-live-consumer', 0,
               'active', '{}', '{}', ?, ?)`,
      [identity.tenantId, timestamp, timestamp],
    );
    await expect(
      sql.run(
        `DELETE FROM tf_resource_deployments
         WHERE tenant_id = ? AND id = 'dep_live_consumer'`,
        [identity.tenantId],
      ),
    ).rejects.toThrow("artifact_deployment_requires_terminal_state");
    expect(
      await sql.query(
        `SELECT root_kind, state FROM tf_artifact_roots
         WHERE tenant_id = ? AND root_kind IN ('resource', 'deployment') AND digest = ?
         ORDER BY root_kind`,
        [identity.tenantId, manifestDigest],
      ),
    ).toEqual([
      { root_kind: "deployment", state: "active" },
      { root_kind: "resource", state: "active" },
    ]);
    expect(
      await reconciler.repairExactFailedRun({
        ...identity,
        mode: "dry-run",
        closureReceipt,
      }),
    ).toMatchObject({ outcome: "blocked_consumer", liveConsumerRoots: 2 });
    await sql.run(
      `DELETE FROM tf_resources
       WHERE tenant_id = ? AND uid = 'uid_live_consumer'`,
      [identity.tenantId],
    );
    expect(
      await reconciler.repairExactFailedRun({
        ...identity,
        mode: "dry-run",
        closureReceipt,
      }),
    ).toMatchObject({ outcome: "blocked_consumer", liveConsumerRoots: 1 });
    await sql.run(
      `UPDATE tf_resource_deployments SET state = 'deleted', updated_at = ?
       WHERE tenant_id = ? AND id = 'dep_live_consumer'`,
      [timestamp + 1, identity.tenantId],
    );
    await sql.run(
      `INSERT INTO tf_resource_deployments
         (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
          provider_installation_ref, native_id, native_claimed, state,
          observed_json, outputs_json, created_at, updated_at)
       VALUES (?, 'dep_unresolved_consumer', 'uid_missing_consumer', 'offering.test',
               'provider.test', 'installation.test', 'native-unresolved-consumer', 0,
               'retained', '{}', '{}', ?, ?)`,
      [identity.tenantId, timestamp, timestamp],
    );
    expect(
      await reconciler.repairExactFailedRun({
        ...identity,
        mode: "dry-run",
        closureReceipt,
      }),
    ).toMatchObject({
      outcome: "blocked_consumer",
      liveConsumerRoots: 0,
      unresolvedConsumers: 1,
    });
    await sql.run(
      `UPDATE tf_resource_deployments SET state = 'deleted', updated_at = ?
       WHERE tenant_id = ? AND id = 'dep_unresolved_consumer'`,
      [timestamp + 1, identity.tenantId],
    );

    for (const invalidReceipt of [
      { receiptId: "closure-missing", receiptFence: 7 },
      { receiptId: "closure-stale", receiptFence: 8 },
      { receiptId: "closure-future", receiptFence: 9 },
      { receiptId: "closure-valid", receiptFence: 8 },
    ] as const) {
      expect(
        await reconciler.repairExactFailedRun({
          ...identity,
          mode: "dry-run",
          closureReceipt: invalidReceipt,
        }),
      ).toMatchObject({ outcome: "blocked_receipt" });
    }
    expect(
      await reconciler.repairExactFailedRun({
        ...identity,
        mode: "dry-run",
        closureReceipt,
      }),
    ).toMatchObject({ outcome: "ready", activeReplayRoots: 2 });
    const released = await reconciler.repairExactFailedRun({
      ...identity,
      mode: "execute",
      closureReceipt,
    });
    expect(released).toMatchObject({
      outcome: "released",
      lifecycle: "committed",
      activeReplayRoots: 2,
      externalDeleteIssued: false,
    });
    expect(
      await sql.query("SELECT lifecycle_state FROM tf_artifact_uploads WHERE id = ?", [
        started.uploadId,
      ]),
    ).toEqual([{ lifecycle_state: "committed" }]);
    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(0);
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).not.toBeNull();

    timestamp += 25 * 60 * 60_000;
    await reconciler.reconcile({ limit: 16, deleteObjects: true });
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).not.toBeNull();
    timestamp += 2 * 60 * 60_000;
    expect((await reconciler.reconcile({ limit: 16, deleteObjects: true })).deletedObjects).toBe(1);
    expect(await objects.head(`art/${digest.slice("sha256:".length)}`)).toBeNull();
    expect(
      await reconciler.repairExactFailedRun({
        ...identity,
        mode: "execute",
        closureReceipt,
      }),
    ).toMatchObject({ outcome: "already_released" });
  });

  test("reports legacy, dangling, hold, candidate, and untracked object evidence", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    const clock = () => new Date("2026-09-08T00:00:00.000Z");
    const manifestDigest = `sha256:${"1".repeat(64)}`;
    const blobDigest = `sha256:${"2".repeat(64)}`;
    const danglingManifestDigest = `sha256:${"3".repeat(64)}`;
    const staleDigest = `sha256:${"4".repeat(64)}`;
    const legacyBlobDigest = `sha256:${"5".repeat(64)}`;
    const legacyManifestDigest = `sha256:${"6".repeat(64)}`;
    const candidateDigest = `sha256:${"7".repeat(64)}`;
    const untrackedDigest = `sha256:${"8".repeat(64)}`;
    const resurrectedDeletedDigest = `sha256:${"9".repeat(64)}`;
    const permanentlyFencedDigest = `sha256:${"a".repeat(64)}`;
    const completedResultDigest = `sha256:${"b".repeat(64)}`;
    const manifest = JSON.stringify({
      apiVersion: "artifacts.takoform.com/v1alpha1",
      kind: "WorkerBundle",
      mainModule: "worker.mjs",
      modules: [
        {
          name: "worker.mjs",
          mediaType: "application/javascript+module",
          size: 1,
          digest: blobDigest,
        },
      ],
    });
    await sql.run(
      `INSERT INTO tf_artifact_uploads
         (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
       VALUES ('up_missing_status', 'tenant_status', 'run:status', ?, ?, 1)`,
      [manifest, manifestDigest],
    );
    await sql.run(
      `INSERT INTO tf_artifact_uploads
         (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at,
          lifecycle_state, lifecycle_fence, updated_at)
       VALUES ('up_dangling_status', 'tenant_status', 'run:status', ?, ?, 2,
               'committed', 1, 2)`,
      [manifest, danglingManifestDigest],
    );
    await sql.run(
      `INSERT INTO tf_artifact_holds (tenant_id, digest, kind)
       VALUES ('tenant_status', ?, 'blob')`,
      [staleDigest],
    );
    for (const [rootKind, targetKind, digest] of [
      ["legacy-hold", "blob", legacyBlobDigest],
      ["legacy-manifest", "manifest", legacyManifestDigest],
    ] as const) {
      await sql.run(
        `INSERT INTO tf_artifact_roots
           (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
            expires_at, release_reason, created_at, released_at)
         VALUES ('tenant_status', ?, ?, ?, ?, 'active', 1, NULL, NULL, 1, NULL)`,
        [rootKind, `${rootKind}:${digest}`, targetKind, digest],
      );
    }
    await sql.run(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'pending', 1, 20, NULL, 0, 'pending', 10, 10, NULL)`,
      [candidateDigest],
    );
    await sql.run(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'deleted', 2, 21, NULL, 1, 'deleted', 11, 12, 12)`,
      [resurrectedDeletedDigest],
    );
    await sql.run(
      `INSERT INTO tf_artifact_blob_io_leases
         (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
          upload_fence, root_fence, expected_size, candidate_fence,
          lease_expires_at, last_outcome, created_at, updated_at)
       VALUES (?, 'deleting', 1, 'legacy-delete-status',
               NULL, NULL, NULL, NULL, NULL, NULL, 2, 12,
               'delete_started', 11, 12)`,
      [permanentlyFencedDigest],
    );
    await sql.run(
      `INSERT INTO tf_artifact_blob_io_results
         (operation_id, digest, operation_kind, lease_fence, candidate_fence,
          tenant_id, principal_id, upload_id, upload_fence, root_fence,
          expected_size, outcome, completed_at)
       VALUES ('abd_completed_status', ?, 'delete', 1, 1,
               NULL, NULL, NULL, NULL, NULL, NULL, 'deleted', 12)`,
      [completedResultDigest],
    );
    await objects.put(`art/${untrackedDigest.slice("sha256:".length)}`, new Uint8Array([8]));
    await objects.put(
      `art/${resurrectedDeletedDigest.slice("sha256:".length)}`,
      new Uint8Array([9]),
    );
    const reconciler = createTakoformArtifactReconciler({
      sql,
      objects,
      clock,
      randomId: () => "status-evidence",
    });
    const evidence = {
      legacyHoldRoots: 1,
      legacyManifestRoots: 1,
      danglingCommittedUploads: 1,
      unresolvedConsumers: 0,
      missingHolds: 1,
      staleHolds: 1,
      oldestCandidate: {
        kind: "blob",
        digest: candidateDigest,
        state: "pending",
        notBefore: 20,
        createdAt: 10,
      },
      objectInventory: {
        availability: "complete",
        scannedObjects: 2,
        untrackedObjects: 2,
      },
    } as const;

    expect(await reconciler.status()).toMatchObject({
      ...evidence,
      permanentlyFencedBlobDeletes: 1,
      completedBlobIoResults: 1,
    });
    expect(await reconciler.dryRun({ limit: 16 })).toMatchObject(evidence);
  });

  test("reports unavailable object inventory without claiming zero untracked bytes", async () => {
    const base = createMemoryObjectStore();
    const objects: ObjectStoreAccess = {
      ...base,
      async list() {
        throw new Error("simulated inventory outage");
      },
    };
    const reconciler = createTakoformArtifactReconciler({
      sql: createEphemeralSql(),
      objects,
      clock: () => new Date("2026-09-08T00:00:00.000Z"),
      randomId: () => "unavailable-inventory",
    });

    expect((await reconciler.status()).objectInventory).toEqual({
      availability: "unavailable",
      scannedObjects: 0,
      untrackedObjects: null,
    });
  });

  test("counts untracked objects through every object-store cursor page", async () => {
    const objects = createMemoryObjectStore();
    for (let index = 0; index < 66; index += 1) {
      const digest = index.toString(16).padStart(64, "0");
      await objects.put(`art/${digest}`, new Uint8Array([index]));
    }
    const reconciler = createTakoformArtifactReconciler({
      sql: createEphemeralSql(),
      objects,
      clock: () => new Date("2026-09-08T00:00:00.000Z"),
      randomId: () => "paged-inventory",
    });

    expect((await reconciler.status()).objectInventory).toEqual({
      availability: "complete",
      scannedObjects: 66,
      untrackedObjects: 66,
    });
  });

  test("composes typed maintenance without mounting a public repair route", async () => {
    const app = buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      identity: IDENTITY,
      settlement: SETTLEMENT,
      publicOrigin: "https://api.test",
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
    });
    expect(await app.maintenance.artifacts.status()).toEqual({
      uploads: { open: 0, committed: 0, abandoned: 0 },
      activeRoots: 0,
      pendingCandidates: 0,
      retryableCandidates: 0,
      deletingCandidates: 0,
      deletedTombstones: 0,
      permanentlyFencedBlobDeletes: 0,
      completedBlobIoResults: 0,
      legacyHoldRoots: 0,
      legacyManifestRoots: 0,
      danglingCommittedUploads: 0,
      unresolvedConsumers: 0,
      missingHolds: 0,
      staleHolds: 0,
      oldestCandidate: null,
      objectInventory: {
        availability: "complete",
        scannedObjects: 0,
        untrackedObjects: 0,
      },
    });
    const response = await app.fetch(
      new Request("https://api.test/__maintenance/artifacts/reconcile", { method: "POST" }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });
});
