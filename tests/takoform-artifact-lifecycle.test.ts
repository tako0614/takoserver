import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app.ts";
import type { ExternalIdentityVerifier } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { bytesDigest } from "../src/json.ts";
import type { FundingSettlementVerifier } from "../src/ledger.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
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

describe("Takoform artifact lifecycle", () => {
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
    const clock = () => new Date("2026-08-31T01:00:00.000Z");
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
      repairableHolds: 1,
      expiredReplays: 0,
    });
    expect(await reconciler.reconcile({ limit: 16, deleteObjects: false })).toMatchObject({
      repairedHolds: 1,
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

    // Retrying reads the fenced candidate and the now-absent object. It only
    // settles the durable tombstone; it cannot issue a second destructive act.
    const retried = await reconciler.reconcile({ limit: 16, deleteObjects: true });
    expect(retried.deletedObjects).toBe(0);
    expect(retried.retryableObjects).toBe(0);
    expect(
      await durable.query(
        `SELECT state, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [digest],
      ),
    ).toEqual([{ state: "deleted", last_outcome: "already_absent" }]);
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

    expect(await reconciler.status()).toMatchObject(evidence);
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
