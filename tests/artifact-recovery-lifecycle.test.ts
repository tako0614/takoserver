import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_RECOVERY_LINEAGE_DIGEST,
  ARTIFACT_RECOVERY_LINEAGE_MIGRATION,
  ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
  ARTIFACT_RECOVERY_REQUEST_FORMAT,
  ARTIFACT_RECOVERY_RETENTION_FORMAT,
  type ArtifactRecovery,
  ArtifactRecoveryError,
  type ArtifactRecoveryExecution,
  type ArtifactRecoveryRequest,
  canonicalArtifactRecoveryRequest,
  createArtifactRecovery,
} from "../src/artifact-recovery.ts";
import {
  EXACT_ARTIFACT_RECOVERY_PURGE_AUTHORIZATION_FORMAT,
  purgeExactArtifactRecoveryDetails,
} from "../src/artifact-recovery-owner-gc.ts";
import { createEphemeralSql } from "../src/compat.ts";
import {
  type ExactArtifactRecoveryGatewayAction,
  signedExactArtifactRecoveryRpcInvocation,
} from "../src/exact-artifact-recovery-operator-proof.ts";
import {
  exactArtifactRecoveryWorkerEnv,
  invokeExactArtifactRecoveryFromWorkerEnv,
} from "../src/exact-artifact-recovery-worker.ts";
import {
  deterministicIntegrationE2eApiKeyIds,
  INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
  INTEGRATION_E2E_EVIDENCE_KEY_NAME,
  INTEGRATION_E2E_EVIDENCE_SCOPES,
  INTEGRATION_E2E_ORGANIZATION_ID,
  INTEGRATION_E2E_WRITER_KEY_NAME,
  INTEGRATION_E2E_WRITER_SCOPES,
} from "../src/integration-e2e-credential-authority.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { R2BucketLike } from "../src/objects-r2.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import type { ObjectStoreAccess, Sql, SqlParam, SqlStatement } from "../src/ports.ts";
import type { D1DatabaseLike, D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { createTakoformArtifactReconciler } from "../src/takoform/artifact-reconciler.ts";
import { createExactArtifactRecoveryCoordinator } from "../src/takoform/exact-artifact-recovery-coordinator.ts";

const FIRST_VERSION = "10000000-0000-4000-8000-000000000001";
const SECOND_VERSION = "20000000-0000-4000-8000-000000000002";
const THIRD_VERSION = "30000000-0000-4000-8000-000000000003";
const QUIESCENCE = `sha256:${"c".repeat(64)}` as const;

describe("exact artifact recovery lifecycle", () => {
  test("prepares atomically and completes only through its dedicated collector", async () => {
    const fixture = await recoveryFixture();
    let status = await fixture.recovery.status(fixture.request);
    expect(status).toMatchObject({ phase: "eligible", action: "prepare" });
    await expect(
      fixture.recovery.apply({
        request: fixture.request,
        planDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toEqual(new ArtifactRecoveryError("state_conflict", 409));

    status = await fixture.recovery.apply({
      request: fixture.request,
      planDigest: status.planDigest,
    });
    expect(status).toMatchObject({
      phase: "prepared",
      action: "wait",
      receiptCount: 5,
      candidates: { pending: 29, deleteStarted: 0, deleted: 0, metadataDeleted: 0 },
      detailState: "active",
      presentBlobs: 28,
    });
    expect(
      await fixture.sql.query(
        `SELECT receipt_kind, state, COUNT(*) AS total
         FROM tf_artifact_owner_closure_receipts
         WHERE recovery_request_digest IS NOT NULL GROUP BY receipt_kind, state`,
      ),
    ).toEqual([{ receipt_kind: "exact_failed_run_recovery", state: "recovery_active", total: 5 }]);
    expect(
      await fixture.sql.query(
        `SELECT state, COUNT(*) AS total FROM tf_artifact_roots
         WHERE tenant_id = ? AND digest = ? AND root_kind IN ('upload', 'replay')
         GROUP BY state`,
        [fixture.request.tenantId, fixture.request.manifestDigest],
      ),
    ).toEqual([{ state: "released", total: 7 }]);

    fixture.advance(2 * 60 * 60_000);
    await fixture.reconciler.reconcile({ limit: 64, deleteObjects: true });
    expect(fixture.deleteCalls()).toBe(0);
    expect(
      await fixture.sql.query(
        `SELECT state, COUNT(*) AS total
         FROM tf_artifact_gc_candidates GROUP BY state ORDER BY state`,
      ),
    ).toEqual([{ state: "pending", total: 29 }]);
    status = await runToCompletion(fixture);
    expect(status).toMatchObject({
      phase: "complete",
      action: "none",
      candidates: { pending: 0, deleteStarted: 0, deleted: 28, metadataDeleted: 1 },
      metadataPresent: false,
      presentBlobs: 0,
      detailState: "active",
    });
    expect(fixture.deleteCalls()).toBe(28);
    expect(
      await fixture.sql.query(
        `SELECT phase, result_set_digest IS NOT NULL AS has_result,
                purge_after > completed_at AS retained FROM tf_artifact_recovery_once`,
      ),
    ).toEqual([{ phase: "complete", has_result: 1, retained: 1 }]);
  });

  test("two applies of one inspected candidate issue one R2 DELETE", async () => {
    const fixture = await recoveryFixture();
    const status = await prepareAndAdvance(fixture);
    await Promise.all([
      fixture.recovery.apply({ request: fixture.request, planDigest: status.planDigest }),
      fixture.recovery.apply({ request: fixture.request, planDigest: status.planDigest }),
    ]);
    const after = await fixture.recovery.status(fixture.request);
    expect(after.candidates.deleted).toBe(1);
    expect(after.nextCandidate?.ordinal).toBe(1);
    expect(fixture.deleteCalls()).toBe(1);
  });

  test("owner GC waits for retention and active Worker authorization, then keeps only the compact receipt", async () => {
    const fixture = await recoveryFixture();
    const externalDigest = `sha256:${"f".repeat(64)}` as const;
    await fixture.objects.put(blobKey(externalDigest), new Uint8Array([9]));
    await fixture.sql.run(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'deleted', 9, ?, NULL, 1, 'already_absent', ?, ?, ?)`,
      [externalDigest, fixture.now(), fixture.now(), fixture.now(), fixture.now()],
    );
    await fixture.sql.run(
      `INSERT INTO tf_artifact_blob_io_results
         (operation_id, digest, operation_kind, lease_fence, candidate_fence,
          tenant_id, principal_id, upload_id, upload_fence, root_fence,
          expected_size, outcome, completed_at)
       VALUES ('external-delete-result', ?, 'delete', 9, 9,
               NULL, NULL, NULL, NULL, NULL, NULL, 'already_absent', ?)`,
      [externalDigest, fixture.now()],
    );
    const externalBefore = await externalStateDigest(fixture.sql, fixture.objects, externalDigest);

    await runToCompletion(fixture);
    const terminalRows = await fixture.sql.query(
      "SELECT completed_at, purge_after FROM tf_artifact_recovery_once WHERE singleton = 1",
    );
    const completedAt = Number(terminalRows[0]?.completed_at);
    const purgeAfter = Number(terminalRows[0]?.purge_after);
    const gc = (authorization = purgeAuthorization(fixture)) =>
      purgeExactArtifactRecoveryDetails(
        {
          sql: fixture.sql,
          objects: fixture.objects,
          authorization,
          clock: fixture.clock,
          randomId: () => "retention-gc",
        },
        fixture.canonical.requestDigest,
      );

    expect(await gc()).toEqual({ outcome: "blocked", blocker: "detail_retention_active" });
    fixture.advance(purgeAfter - fixture.now());
    expect(
      await gc({
        ...purgeAuthorization(fixture),
        requestDigest: `sha256:${"9".repeat(64)}`,
      }),
    ).toEqual({
      outcome: "blocked",
      blocker: "purge_authorization_invalid",
    });
    expect(await count(fixture.sql, "tf_artifact_recovery_details")).toBe(1);
    expect(
      await gc({
        ...purgeAuthorization(fixture),
        workerVersionId: SECOND_VERSION,
      }),
    ).toEqual({
      outcome: "blocked",
      blocker: "purge_authorization_invalid",
    });
    const result = await gc();
    expect(result).toMatchObject({
      outcome: "purged",
      requestDigest: fixture.canonical.requestDigest,
    });
    expect(
      await fixture.sql.query(
        `SELECT phase, detail_state, completed_at, result_set_digest,
                purge_worker_version_id, purge_authorization_digest,
                purge_authorized_at,
                details_purged_at
         FROM tf_artifact_recovery_once`,
      ),
    ).toEqual([
      {
        phase: "complete",
        detail_state: "purged",
        completed_at: completedAt,
        result_set_digest: result.outcome === "purged" ? result.resultSetDigest : "unreachable",
        purge_worker_version_id: FIRST_VERSION,
        purge_authorization_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        purge_authorized_at: purgeAfter,
        details_purged_at: purgeAfter,
      },
    ]);
    expect(await count(fixture.sql, "tf_artifact_recovery_details")).toBe(0);
    expect(await count(fixture.sql, "tf_artifact_recovery_candidates")).toBe(0);
    expect(
      await fixture.sql.query(
        `SELECT COUNT(*) AS total FROM tf_artifact_owner_closure_receipts
         WHERE receipt_kind = 'exact_failed_run_recovery'`,
      ),
    ).toEqual([{ total: 0 }]);
    expect(
      await fixture.sql.query(
        `SELECT COUNT(*) AS total FROM tf_artifact_blob_io_results
         WHERE receipt_kind = 'exact_failed_run_recovery'`,
      ),
    ).toEqual([{ total: 0 }]);
    expect(await gc()).toMatchObject({ outcome: "already_purged" });
    expect(await externalStateDigest(fixture.sql, fixture.objects, externalDigest)).toBe(
      externalBefore,
    );
  });

  test("owner GC batch faults and a last-moment hold preserve every recovery detail", async () => {
    const fixture = await recoveryFixture();
    await runToCompletion(fixture);
    const rows = await fixture.sql.query(
      "SELECT purge_after FROM tf_artifact_recovery_once WHERE singleton = 1",
    );
    fixture.advance(Number(rows[0]?.purge_after) - fixture.now());
    const faulted: Sql = {
      query: (statement, params) => fixture.sql.query(statement, params),
      run: (statement, params) => fixture.sql.run(statement, params),
      batch: (statements) =>
        fixture.sql.batch([
          ...statements.slice(0, 4),
          { sql: "SELECT missing_column FROM tf_artifact_recovery_once" },
          ...statements.slice(4),
        ]),
    };
    await expect(
      purgeExactArtifactRecoveryDetails(
        {
          sql: faulted,
          objects: fixture.objects,
          authorization: purgeAuthorization(fixture),
          clock: fixture.clock,
          randomId: () => "faulted-gc",
        },
        fixture.canonical.requestDigest,
      ),
    ).rejects.toThrow();
    expect(await count(fixture.sql, "tf_artifact_recovery_details")).toBe(1);
    expect(await count(fixture.sql, "tf_artifact_recovery_candidates")).toBe(29);
    expect(await fixture.sql.query("SELECT detail_state FROM tf_artifact_recovery_once")).toEqual([
      { detail_state: "active" },
    ]);

    const first = fixture.request.memberDigests[0];
    if (!first) throw new Error("member fixture missing");
    let injected = false;
    const raced: Sql = {
      query: (statement, params) => fixture.sql.query(statement, params),
      run: (statement, params) => fixture.sql.run(statement, params),
      async batch(statements) {
        if (!injected) {
          injected = true;
          await fixture.sql.run("INSERT INTO tf_artifact_holds VALUES ('racer', ?, 'blob')", [
            first,
          ]);
        }
        return await fixture.sql.batch(statements);
      },
    };
    await expect(
      purgeExactArtifactRecoveryDetails(
        {
          sql: raced,
          objects: fixture.objects,
          authorization: purgeAuthorization(fixture),
          clock: fixture.clock,
          randomId: () => "raced-gc",
        },
        fixture.canonical.requestDigest,
      ),
    ).rejects.toThrow();
    expect(await count(fixture.sql, "tf_artifact_recovery_details")).toBe(1);
    await fixture.sql.run(
      "DELETE FROM tf_artifact_holds WHERE tenant_id = 'racer' AND digest = ?",
      [first],
    );
    expect(
      await purgeExactArtifactRecoveryDetails(
        {
          sql: fixture.sql,
          objects: fixture.objects,
          authorization: purgeAuthorization(fixture),
          clock: fixture.clock,
          randomId: () => "successful-gc",
        },
        fixture.canonical.requestDigest,
      ),
    ).toMatchObject({ outcome: "purged" });
  });

  test("the Worker D1 batch rolls a prefix failure back and retry returns durable purged readback", async () => {
    const fixture = await recoveryFixture();
    await runToCompletion(fixture);
    await advanceToPurge(fixture);
    const fault = { mode: "prefix-failure" as D1BatchFault, batchCalls: 0 };
    const binding = fixtureD1Binding(fixture.sql, fault);
    const worker = await recoveryWorkerBindingFixture(fixture, binding);
    const invocation = await worker.invocation("purge");

    await expect(
      invokeExactArtifactRecoveryFromWorkerEnv(worker.env, "purge", invocation, {
        clock: fixture.clock,
        randomId: () => "worker-prefix-failure",
      }),
    ).rejects.toThrow();
    expect(fault.batchCalls).toBe(1);
    expect(await count(fixture.sql, "tf_artifact_recovery_details")).toBe(1);
    expect(await count(fixture.sql, "tf_artifact_recovery_candidates")).toBe(29);
    expect(await fixture.sql.query("SELECT detail_state FROM tf_artifact_recovery_once")).toEqual([
      { detail_state: "active" },
    ]);

    fault.mode = "none";
    expect(
      await invokeExactArtifactRecoveryFromWorkerEnv(worker.env, "purge", invocation, {
        clock: fixture.clock,
        randomId: () => "worker-prefix-retry",
      }),
    ).toMatchObject({ outcome: "purged", requestDigest: fixture.canonical.requestDigest });
    const status = await invokeExactArtifactRecoveryFromWorkerEnv(
      worker.env,
      "status",
      await worker.invocation("status"),
      { clock: fixture.clock, randomId: () => "worker-purged-readback" },
    );
    expect(status).toMatchObject({
      phase: "complete",
      action: "none",
      detailState: "purged",
      receiptCount: 0,
      candidates: { pending: 0, deleteStarted: 0, deleted: 0, metadataDeleted: 0 },
    });
  });

  test("the Worker treats a committed D1 purge with a lost acknowledgement as success and retry is idempotent", async () => {
    const fixture = await recoveryFixture();
    await runToCompletion(fixture);
    await advanceToPurge(fixture);
    const fault = { mode: "commit-then-throw" as D1BatchFault, batchCalls: 0 };
    const worker = await recoveryWorkerBindingFixture(
      fixture,
      fixtureD1Binding(fixture.sql, fault),
    );
    const invocation = await worker.invocation("purge");

    expect(
      await invokeExactArtifactRecoveryFromWorkerEnv(worker.env, "purge", invocation, {
        clock: fixture.clock,
        randomId: () => "worker-lost-ack",
      }),
    ).toMatchObject({ outcome: "purged", requestDigest: fixture.canonical.requestDigest });
    expect(fault.batchCalls).toBe(1);
    expect(
      await invokeExactArtifactRecoveryFromWorkerEnv(worker.env, "purge", invocation, {
        clock: fixture.clock,
        randomId: () => "worker-lost-ack-retry",
      }),
    ).toMatchObject({ outcome: "already_purged" });
    expect(fault.batchCalls).toBe(1);
    expect(await count(fixture.sql, "tf_artifact_recovery_details")).toBe(0);
    expect(await count(fixture.sql, "tf_artifact_recovery_candidates")).toBe(0);
  });

  test("a failed prepare batch leaves every incident row and root untouched", async () => {
    const fixture = await recoveryFixture({ failPrepareBatch: true });
    const status = await fixture.recovery.status(fixture.request);
    await expect(
      fixture.recovery.apply({ request: fixture.request, planDigest: status.planDigest }),
    ).rejects.toThrow("injected prepare batch failure");
    expect(await count(fixture.sql, "tf_artifact_recovery_once")).toBe(0);
    expect(await count(fixture.sql, "tf_artifact_recovery_candidates")).toBe(0);
    expect(await count(fixture.sql, "tf_artifact_holds")).toBe(29);
    expect(
      await fixture.sql.query(
        "SELECT COUNT(*) AS total FROM tf_artifact_roots WHERE state = 'active'",
      ),
    ).toEqual([{ total: 7 }]);
  });

  test("two distinct descriptors have one winner and retrying the winner is read-only", async () => {
    const fixture = await recoveryFixture();
    const otherRequest: ArtifactRecoveryRequest = {
      ...fixture.request,
      settlementEvidence: {
        ...fixture.request.settlementEvidence,
        digest: `sha256:${"9".repeat(64)}`,
      },
    };
    const otherCanonical = await canonicalArtifactRecoveryRequest(otherRequest);
    const other = fixture.recoveryFor({
      ...fixture.execution,
      pinnedRequestDigest: otherCanonical.requestDigest,
      workerVersionId: SECOND_VERSION,
    });
    const [one, two] = await Promise.all([
      fixture.recovery.status(fixture.request),
      other.status(otherRequest),
    ]);
    const outcomes = await Promise.allSettled([
      fixture.recovery.apply({ request: fixture.request, planDigest: one.planDigest }),
      other.apply({ request: otherRequest, planDigest: two.planDigest }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await count(fixture.sql, "tf_artifact_recovery_once")).toBe(1);
    expect(await count(fixture.sql, "tf_artifact_recovery_details")).toBe(1);
    const winner = await fixture.sql.query("SELECT request_digest FROM tf_artifact_recovery_once");
    const firstWon = winner[0]?.request_digest === fixture.canonical.requestDigest;
    await (firstWon ? fixture.recovery : other).status(firstWon ? fixture.request : otherRequest);
    expect(await count(fixture.sql, "tf_artifact_recovery_details")).toBe(1);
  });

  test("active recovery rejects uncertainty, roots, holds and blob writers", async () => {
    const fixture = await recoveryFixture();
    const status = await fixture.recovery.status(fixture.request);
    await fixture.recovery.apply({ request: fixture.request, planDigest: status.planDigest });
    const first = fixture.request.memberDigests[0];
    if (!first) throw new Error("member fixture missing");
    await expect(
      fixture.sql.run(
        `INSERT INTO tf_artifact_consumer_uncertainties
           (tenant_id, consumer_kind, consumer_id, state, fence, reason, created_at, resolved_at)
         VALUES (?, 'deployment', 'raced', 'active', 1,
                 'historical_deployment_digest_unknown', ?, NULL)`,
        [fixture.request.tenantId, fixture.now()],
      ),
    ).rejects.toThrow("artifact_recovery_active");
    await fixture.sql.run(
      `INSERT INTO tf_artifact_consumer_uncertainties
         (tenant_id, consumer_kind, consumer_id, state, fence, reason, created_at, resolved_at)
       VALUES (?, 'deployment', 'resolved-before-recovery', 'resolved', 1,
               'historical_deployment_digest_unknown', ?, ?)`,
      [fixture.request.tenantId, fixture.now(), fixture.now()],
    );
    await expect(
      fixture.sql.run(
        `UPDATE tf_artifact_consumer_uncertainties
         SET state = 'active', fence = fence + 1, resolved_at = NULL
         WHERE tenant_id = ? AND consumer_id = 'resolved-before-recovery'`,
        [fixture.request.tenantId],
      ),
    ).rejects.toThrow("artifact_recovery_active");
    await expect(
      fixture.sql.run(
        `INSERT INTO tf_artifact_roots
           (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
            expires_at, release_reason, created_at, released_at)
         VALUES ('other', 'legacy-hold', 'raced', 'blob', ?, 'active', 1,
                 NULL, NULL, ?, NULL)`,
        [first, fixture.now()],
      ),
    ).rejects.toThrow("artifact_recovery_active");
    await fixture.sql.run(
      `INSERT INTO tf_artifact_roots
         (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
          expires_at, release_reason, created_at, released_at)
       VALUES ('other', 'legacy-hold', 'reactivated', 'blob', ?, 'released', 1,
               NULL, 'consumer_closed', ?, ?)`,
      [first, fixture.now(), fixture.now()],
    );
    await expect(
      fixture.sql.run(
        `UPDATE tf_artifact_roots
         SET state = 'active', fence = fence + 1, release_reason = NULL, released_at = NULL
         WHERE tenant_id = 'other' AND root_id = 'reactivated'`,
      ),
    ).rejects.toThrow("artifact_recovery_active");
    await expect(
      fixture.sql.run("INSERT INTO tf_artifact_holds VALUES (?, ?, 'blob')", [
        fixture.request.tenantId,
        first,
      ]),
    ).rejects.toThrow("artifact_recovery_active");
    await expect(
      fixture.sql.run(
        `INSERT INTO tf_artifact_blob_io_leases
           (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
            upload_fence, root_fence, expected_size, candidate_fence,
            lease_expires_at, last_outcome, created_at, updated_at)
         VALUES (?, 'writing', 1, 'raced-writer', ?, 'api-key:raced', 'up_raced',
                 1, 1, 1, NULL, ?, 'write_admitted', ?, ?)`,
        [first, fixture.request.tenantId, fixture.now() + 1_000, fixture.now(), fixture.now()],
      ),
    ).rejects.toThrow("artifact_recovery_active");
    await fixture.sql.run(
      `INSERT INTO tf_artifact_blob_io_leases
         (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
          upload_fence, root_fence, expected_size, candidate_fence,
          lease_expires_at, last_outcome, created_at, updated_at)
       VALUES (?, 'available', 1, 'available-before-recovery', NULL, NULL, NULL,
               NULL, NULL, NULL, NULL, NULL, 'already_absent', ?, ?)`,
      [first, fixture.now(), fixture.now()],
    );
    await expect(
      fixture.sql.run(
        `UPDATE tf_artifact_blob_io_leases
         SET state = 'writing', fence = fence + 1, operation_id = 'reactivated-writer',
             tenant_id = ?, principal_id = 'api-key:raced', upload_id = 'up_raced',
             upload_fence = 1, root_fence = 1, expected_size = 1,
             lease_expires_at = ?, last_outcome = 'write_admitted', updated_at = ?
         WHERE digest = ?`,
        [fixture.request.tenantId, fixture.now() + 1_000, fixture.now(), first],
      ),
    ).rejects.toThrow("artifact_recovery_active");

    const otherManifest = `sha256:${"c".repeat(64)}` as const;
    await fixture.sql.run(
      `INSERT INTO tf_artifact_roots
         (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
          expires_at, release_reason, created_at, released_at)
       VALUES ('other', 'legacy-manifest', 'member-race', 'manifest', ?, 'active', 1,
               NULL, NULL, ?, NULL)`,
      [otherManifest, fixture.now()],
    );
    await expect(
      fixture.sql.run(
        `INSERT INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
         VALUES (?, ?)`,
        [otherManifest, first],
      ),
    ).rejects.toThrow("artifact_recovery_active");
  });

  test("an uncertainty winning before prepare causes zero recovery writes", async () => {
    const fixture = await recoveryFixture();
    await fixture.sql.run(
      `INSERT INTO tf_artifact_consumer_uncertainties
         (tenant_id, consumer_kind, consumer_id, state, fence, reason, created_at, resolved_at)
       VALUES (?, 'deployment', 'before', 'active', 1,
               'historical_deployment_digest_unknown', ?, NULL)`,
      [fixture.request.tenantId, fixture.now()],
    );
    expect(await fixture.recovery.status(fixture.request)).toMatchObject({
      phase: "blocked",
      action: "none",
      blocker: "consumer_uncertainty_active",
    });
    expect(await count(fixture.sql, "tf_artifact_recovery_once")).toBe(0);
  });

  test("a successor cannot use lost-ack authority before its exact candidate is indeterminate", async () => {
    const fixture = await recoveryFixture();
    await prepareAndAdvance(fixture);
    const premature = fixture.recoveryFor({
      ...fixture.execution,
      workerVersionId: SECOND_VERSION,
      lostAck: {
        kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
        candidateOrdinal: 5,
        predecessorWorkerVersionId: FIRST_VERSION,
        quiescenceEvidenceDigest: QUIESCENCE,
        resolution: { kind: "confirm-head-absent" },
      },
    });
    expect(await premature.status(fixture.request)).toMatchObject({
      action: "none",
      blocker: "recovery_version_not_authorized",
    });
    expect(fixture.deleteCalls()).toBe(0);
    expect(await count(fixture.sql, "tf_artifact_recovery_execution_handoffs")).toBe(0);
    expect(
      await fixture.sql.query(
        "SELECT active_worker_version_id, execution_handoff_count FROM tf_artifact_recovery_once",
      ),
    ).toEqual([{ active_worker_version_id: FIRST_VERSION, execution_handoff_count: 0 }]);
  });

  test("lost acknowledgement reconciles from absence without a second DELETE", async () => {
    const fixture = await recoveryFixture({ deleteBehavior: "delete-then-throw" });
    let status = await prepareAndAdvance(fixture);
    status = await fixture.recovery.apply({
      request: fixture.request,
      planDigest: status.planDigest,
    });
    expect(status).toMatchObject({ blocker: "recovery_version_not_retired" });
    const successor = fixture.recoveryFor({
      ...fixture.execution,
      workerVersionId: SECOND_VERSION,
      lostAck: {
        kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
        candidateOrdinal: 0,
        predecessorWorkerVersionId: FIRST_VERSION,
        quiescenceEvidenceDigest: QUIESCENCE,
        resolution: { kind: "confirm-head-absent" },
      },
    });
    status = await successor.status(fixture.request);
    expect(status.action).toBe("reconcile_absent");
    status = await successor.apply({ request: fixture.request, planDigest: status.planDigest });
    expect(status.candidates.deleted).toBe(1);
    expect(fixture.deleteCalls()).toBe(1);

    status = await successor.apply({ request: fixture.request, planDigest: status.planDigest });
    expect(status.candidates.deleted).toBe(2);
    expect(status.nextCandidate?.ordinal).toBe(2);
    expect(fixture.deleteCalls()).toBe(2);
    status = await runToCompletion(fixture, successor);
    expect(status.phase).toBe("complete");
    expect(fixture.deleteCalls()).toBe(28);
    expect(
      await fixture.sql.query(
        `SELECT preparing_worker_version_id, active_worker_version_id,
                execution_handoff_count
         FROM tf_artifact_recovery_once`,
      ),
    ).toEqual([
      {
        preparing_worker_version_id: FIRST_VERSION,
        active_worker_version_id: SECOND_VERSION,
        execution_handoff_count: 1,
      },
    ]);
    expect(
      await fixture.sql.query(
        `SELECT sequence, predecessor_worker_version_id, successor_worker_version_id,
                candidate_ordinal, resolution_kind, quiescence_evidence_digest
         FROM tf_artifact_recovery_execution_handoffs`,
      ),
    ).toEqual([
      {
        sequence: 1,
        predecessor_worker_version_id: FIRST_VERSION,
        successor_worker_version_id: SECOND_VERSION,
        candidate_ordinal: 0,
        resolution_kind: "confirm-head-absent",
        quiescence_evidence_digest: QUIESCENCE,
      },
    ]);
  });

  test("two lost-ack successors serialize to one durable active version", async () => {
    const fixture = await recoveryFixture({ deleteBehavior: "delete-then-throw" });
    let status = await prepareAndAdvance(fixture);
    status = await fixture.recovery.apply({
      request: fixture.request,
      planDigest: status.planDigest,
    });
    expect(status.blocker).toBe("recovery_version_not_retired");
    const successorFor = (workerVersionId: string) =>
      fixture.recoveryFor({
        ...fixture.execution,
        workerVersionId,
        lostAck: {
          kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
          candidateOrdinal: 0,
          predecessorWorkerVersionId: FIRST_VERSION,
          quiescenceEvidenceDigest: QUIESCENCE,
          resolution: { kind: "confirm-head-absent" },
        },
      });
    const second = successorFor(SECOND_VERSION);
    const third = successorFor(THIRD_VERSION);
    const [secondStatus, thirdStatus] = await Promise.all([
      second.status(fixture.request),
      third.status(fixture.request),
    ]);
    expect(secondStatus.action).toBe("reconcile_absent");
    expect(thirdStatus.action).toBe("reconcile_absent");
    const outcomes = await Promise.all([
      second.apply({ request: fixture.request, planDigest: secondStatus.planDigest }),
      third.apply({ request: fixture.request, planDigest: thirdStatus.planDigest }),
    ]);
    expect(
      outcomes.filter(({ blocker }) => blocker === "recovery_version_not_authorized"),
    ).toHaveLength(1);
    expect(outcomes.filter(({ action }) => action === "settle")).toHaveLength(1);
    expect(fixture.deleteCalls()).toBe(1);
    expect(
      await fixture.sql.query(
        `SELECT active_worker_version_id, execution_handoff_count,
                (SELECT COUNT(*) FROM tf_artifact_recovery_execution_handoffs) AS handoffs
         FROM tf_artifact_recovery_once`,
      ),
    ).toEqual([
      {
        active_worker_version_id: expect.stringMatching(/^[23]0000000-/u),
        execution_handoff_count: 1,
        handoffs: 1,
      },
    ]);
  });

  test("successive lost acknowledgements advance an ordered execution lineage and complete", async () => {
    const fixture = await recoveryFixture({ deleteThenThrowCalls: [1, 2] });
    let status = await prepareAndAdvance(fixture);
    status = await fixture.recovery.apply({
      request: fixture.request,
      planDigest: status.planDigest,
    });
    expect(status.blocker).toBe("recovery_version_not_retired");

    const second = fixture.recoveryFor({
      ...fixture.execution,
      workerVersionId: SECOND_VERSION,
      lostAck: {
        kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
        candidateOrdinal: 0,
        predecessorWorkerVersionId: FIRST_VERSION,
        quiescenceEvidenceDigest: QUIESCENCE,
        resolution: { kind: "confirm-head-absent" },
      },
    });
    status = await second.status(fixture.request);
    status = await second.apply({ request: fixture.request, planDigest: status.planDigest });
    expect(status.nextCandidate?.ordinal).toBe(1);
    status = await second.apply({ request: fixture.request, planDigest: status.planDigest });
    expect(status.blocker).toBe("recovery_version_not_retired");
    expect(fixture.deleteCalls()).toBe(2);

    const third = fixture.recoveryFor({
      ...fixture.execution,
      workerVersionId: THIRD_VERSION,
      lostAck: {
        kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
        candidateOrdinal: 1,
        predecessorWorkerVersionId: SECOND_VERSION,
        quiescenceEvidenceDigest: `sha256:${"d".repeat(64)}`,
        resolution: { kind: "confirm-head-absent" },
      },
    });
    status = await third.status(fixture.request);
    expect(status.action).toBe("reconcile_absent");
    status = await third.apply({ request: fixture.request, planDigest: status.planDigest });
    expect(status.candidates.deleted).toBe(2);
    status = await runToCompletion(fixture, third);
    expect(status.phase).toBe("complete");
    expect(fixture.deleteCalls()).toBe(28);
    expect(
      await fixture.sql.query(
        `SELECT sequence, candidate_ordinal, predecessor_worker_version_id,
                successor_worker_version_id, purge_after IS NOT NULL AS retained
         FROM tf_artifact_recovery_execution_handoffs ORDER BY sequence`,
      ),
    ).toEqual([
      {
        sequence: 1,
        candidate_ordinal: 0,
        predecessor_worker_version_id: FIRST_VERSION,
        successor_worker_version_id: SECOND_VERSION,
        retained: 1,
      },
      {
        sequence: 2,
        candidate_ordinal: 1,
        predecessor_worker_version_id: SECOND_VERSION,
        successor_worker_version_id: THIRD_VERSION,
        retained: 1,
      },
    ]);

    const retention = await fixture.sql.query(
      "SELECT purge_after FROM tf_artifact_recovery_once WHERE singleton = 1",
    );
    fixture.advance(Number(retention[0]?.purge_after) - fixture.now());
    expect(
      await purgeExactArtifactRecoveryDetails(
        {
          sql: fixture.sql,
          objects: fixture.objects,
          authorization: purgeAuthorization(fixture, THIRD_VERSION),
          clock: fixture.clock,
          randomId: () => "successor-retention-gc",
        },
        fixture.canonical.requestDigest,
      ),
    ).toMatchObject({ outcome: "purged" });
    expect(await count(fixture.sql, "tf_artifact_recovery_execution_handoffs")).toBe(0);
    expect(
      await fixture.sql.query(
        `SELECT active_worker_version_id, purge_worker_version_id, detail_state
         FROM tf_artifact_recovery_once`,
      ),
    ).toEqual([
      {
        active_worker_version_id: THIRD_VERSION,
        purge_worker_version_id: THIRD_VERSION,
        detail_state: "purged",
      },
    ]);
  });

  test("present or drifted bytes need a reviewed operation and new fence", async () => {
    const fixture = await recoveryFixture({ deleteBehavior: "throw" });
    let status = await prepareAndAdvance(fixture);
    status = await fixture.recovery.apply({
      request: fixture.request,
      planDigest: status.planDigest,
    });
    expect(status.blocker).toBe("recovery_version_not_retired");
    const first = fixture.request.memberDigests[0];
    if (!first) throw new Error("member fixture missing");
    const changed = await fixture.objects.put(blobKey(first), new Uint8Array([2]));
    const reviewed = fixture.recoveryFor({
      ...fixture.execution,
      workerVersionId: THIRD_VERSION,
      lostAck: {
        kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
        candidateOrdinal: 0,
        predecessorWorkerVersionId: FIRST_VERSION,
        quiescenceEvidenceDigest: QUIESCENCE,
        resolution: {
          kind: "reviewed-retry",
          observedEtag: changed.etag,
          operationId: "reviewed-delete-operation-0001",
          candidateFence: 4,
          reviewEvidenceDigest: `sha256:${"d".repeat(64)}`,
        },
      },
    });
    status = await reviewed.status(fixture.request);
    if (status.action !== "rearm") {
      throw new Error(`expected reviewed rearm, received ${status.action}:${status.blocker ?? ""}`);
    }
    expect(status).toMatchObject({ action: "rearm", nextCandidate: { fence: 2 } });
    status = await reviewed.apply({ request: fixture.request, planDigest: status.planDigest });
    expect(status).toMatchObject({ action: "wait", nextCandidate: { fence: 3 } });
    fixture.advance(2 * 60 * 60_000);
    status = await reviewed.status(fixture.request);
    status = await reviewed.apply({ request: fixture.request, planDigest: status.planDigest });
    if (status.candidates.deleted !== 1) {
      throw new Error(`reviewed delete did not settle: ${status.action}:${status.blocker ?? ""}`);
    }
    expect(status.candidates.deleted).toBe(1);
    expect(fixture.deleteCalls()).toBe(2);
    expect(
      await fixture.sql.query(
        `SELECT operation_id, candidate_fence, outcome
         FROM tf_artifact_blob_io_results ORDER BY completed_at, operation_id`,
      ),
    ).toContainEqual({
      operation_id: "reviewed-delete-operation-0001",
      candidate_fence: 4,
      outcome: "deleted",
    });
  });

  test("credential drift after inspection is a zero-write conflict", async () => {
    const fixture = await recoveryFixture();
    const status = await fixture.recovery.status(fixture.request);
    const operationId = fixture.request.owners[0]?.operationId;
    if (!operationId) throw new Error("owner fixture missing");
    await fixture.sql.run(
      "UPDATE integration_e2e_credential_pair_operations SET fence = fence + 1 WHERE operation_id = ?",
      [operationId],
    );
    await expect(
      fixture.recovery.apply({ request: fixture.request, planDigest: status.planDigest }),
    ).rejects.toEqual(new ArtifactRecoveryError("state_conflict", 409));
    expect(await count(fixture.sql, "tf_artifact_recovery_once")).toBe(0);
  });

  test("current upload/root fences and prepared object ETags fail with zero recovery writes", async () => {
    const fenceFixture = await recoveryFixture();
    const uploads = fenceFixture.request.uploads.map((upload, index) =>
      index === 0 ? { ...upload, uploadFence: upload.uploadFence + 1 } : upload,
    );
    const fenceRequest = {
      ...fenceFixture.request,
      uploads,
      uploadSetDigest: await canonicalDigest(uploads),
    };
    const fenceCanonical = await canonicalArtifactRecoveryRequest(fenceRequest);
    const fenceRecovery = fenceFixture.recoveryFor({
      ...fenceFixture.execution,
      pinnedRequestDigest: fenceCanonical.requestDigest,
    });
    expect(await fenceRecovery.status(fenceRequest)).toMatchObject({
      phase: "blocked",
      action: "none",
      blocker: "upload_group_mismatch",
    });
    expect(await count(fenceFixture.sql, "tf_artifact_recovery_once")).toBe(0);
    const rootUploads = fenceFixture.request.uploads.map((upload, index) =>
      index === 0 ? { ...upload, rootFence: upload.rootFence + 1 } : upload,
    );
    const rootRequest = {
      ...fenceFixture.request,
      uploads: rootUploads,
      uploadSetDigest: await canonicalDigest(rootUploads),
    };
    const rootCanonical = await canonicalArtifactRecoveryRequest(rootRequest);
    expect(
      await fenceFixture
        .recoveryFor({
          ...fenceFixture.execution,
          pinnedRequestDigest: rootCanonical.requestDigest,
        })
        .status(rootRequest),
    ).toMatchObject({ phase: "blocked", action: "none", blocker: "upload_group_mismatch" });
    expect(await count(fenceFixture.sql, "tf_artifact_recovery_once")).toBe(0);

    const etagFixture = await recoveryFixture();
    const status = await etagFixture.recovery.status(etagFixture.request);
    const first = etagFixture.request.memberDigests[0];
    if (!first) throw new Error("member fixture missing");
    await etagFixture.objects.put(blobKey(first), new Uint8Array([7]));
    await expect(
      etagFixture.recovery.apply({
        request: etagFixture.request,
        planDigest: status.planDigest,
      }),
    ).rejects.toEqual(new ArtifactRecoveryError("state_conflict", 409));
    expect(await count(etagFixture.sql, "tf_artifact_recovery_once")).toBe(0);
    expect(await count(etagFixture.sql, "tf_artifact_recovery_candidates")).toBe(0);
  });
});

async function prepareAndAdvance(fixture: Awaited<ReturnType<typeof recoveryFixture>>) {
  let status = await fixture.recovery.status(fixture.request);
  status = await fixture.recovery.apply({
    request: fixture.request,
    planDigest: status.planDigest,
  });
  fixture.advance(2 * 60 * 60_000);
  return await fixture.recovery.status(fixture.request);
}

async function runToCompletion(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  recovery: ArtifactRecovery = fixture.recovery,
) {
  let status = await recovery.status(fixture.request);
  for (let iteration = 0; iteration < 64 && status.action !== "none"; iteration += 1) {
    if (status.action === "wait") {
      fixture.advance(2 * 60 * 60_000);
      status = await recovery.status(fixture.request);
    } else if (
      status.action === "prepare" ||
      status.action === "settle" ||
      status.action === "complete"
    ) {
      status = await recovery.apply({
        request: fixture.request,
        planDigest: status.planDigest,
      });
    } else {
      throw new Error(`unexpected recovery action ${status.action}:${status.blocker ?? ""}`);
    }
  }
  return status;
}

async function advanceToPurge(fixture: Awaited<ReturnType<typeof recoveryFixture>>): Promise<void> {
  const rows = await fixture.sql.query(
    "SELECT purge_after FROM tf_artifact_recovery_once WHERE singleton = 1",
  );
  fixture.advance(Number(rows[0]?.purge_after) - fixture.now());
}

function purgeAuthorization(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  workerVersionId = FIRST_VERSION,
) {
  return {
    kind: EXACT_ARTIFACT_RECOVERY_PURGE_AUTHORIZATION_FORMAT,
    requestDigest: fixture.canonical.requestDigest,
    workerVersionId,
    invocationDigest: `sha256:${"e".repeat(64)}` as const,
    authorizedAt: fixture.now(),
  };
}

type D1BatchFault = "none" | "prefix-failure" | "commit-then-throw";

class FixtureD1Statement implements D1StatementLike {
  constructor(
    readonly sql: Sql,
    readonly statement: SqlStatement,
  ) {}

  bind(...values: readonly SqlParam[]): D1StatementLike {
    return new FixtureD1Statement(this.sql, { sql: this.statement.sql, params: values });
  }

  async all(): Promise<D1ResultLike> {
    const write = await this.sql.run(this.statement.sql, this.statement.params);
    return { results: write.rows, meta: { changes: write.changes } };
  }
}

function fixtureD1Binding(
  sql: Sql,
  fault: { mode: D1BatchFault; batchCalls: number },
): D1DatabaseLike {
  return {
    prepare(query) {
      return new FixtureD1Statement(sql, { sql: query });
    },
    async batch(statements) {
      fault.batchCalls += 1;
      const batch = statements.map((statement) => {
        if (!(statement instanceof FixtureD1Statement)) {
          throw new Error("unexpected D1 statement implementation");
        }
        return statement.statement;
      });
      if (fault.mode === "prefix-failure") {
        await sql.batch([
          ...batch.slice(0, 4),
          { sql: "SELECT missing_column FROM tf_artifact_recovery_once" },
          ...batch.slice(4),
        ]);
        throw new Error("injected D1 prefix failure did not fail");
      }
      const writes = await sql.batch(batch);
      if (fault.mode === "commit-then-throw") {
        throw new Error("simulated lost D1 batch acknowledgement");
      }
      return writes.map((write) => ({ results: write.rows, meta: { changes: write.changes } }));
    },
  };
}

async function recoveryWorkerBindingFixture(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  database: D1DatabaseLike,
) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (typeof publicJwk.x !== "string") throw new Error("test public key is missing x");
  const live = {
    kind: "takoserver.public-host-identity@v2",
    hostId: "host.integration.test",
    workerVersionId: SECOND_VERSION,
    workerArtifactDigest: `sha256:${"1".repeat(64)}`,
    implementationPayloadDigest: `sha256:${"2".repeat(64)}`,
    capabilityDigest: `sha256:${"3".repeat(64)}`,
    implementationDigest: `sha256:${"4".repeat(64)}`,
  } as const;
  const env = exactArtifactRecoveryWorkerEnv({
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: live.hostId,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: JSON.stringify({
      kty: "OKP",
      crv: "Ed25519",
      x: publicJwk.x,
    }),
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: fixture.canonical.requestDigest,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST: fixture.request.r2.identityDigest,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT: fixture.request.source.commit,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION: fixture.request.source.version,
    WORKER_VERSION: { id: FIRST_VERSION },
    PUBLIC_HOST_IDENTITY: {
      async identity() {
        return live;
      },
    },
    STATE_DB: database,
    OBJECTS: fixtureR2Binding(fixture.objects),
  });
  return {
    env,
    async invocation(action: ExactArtifactRecoveryGatewayAction) {
      const body = fixture.request;
      const assertion = await signOperatorAssertion({
        privateJwk: JSON.stringify(privateJwk),
        nowSeconds: Math.floor(fixture.now() / 1_000),
        lifetimeSeconds: 60,
        claims: {
          purpose: "exact-artifact-recovery",
          action,
          method: "POST",
          path: `/v1/exact-artifact-recovery/${action}`,
          bodyDigest: await canonicalDigest(body),
          environment: "integration",
          hostId: live.hostId,
          workerArtifactDigest: live.workerArtifactDigest,
          publicWorkerVersionId: live.workerVersionId,
          implementationDigest: live.implementationDigest,
          requestDigest: fixture.canonical.requestDigest,
          recoveryWorkerVersionId: FIRST_VERSION,
        },
      });
      return signedExactArtifactRecoveryRpcInvocation({ action, assertion, body });
    },
  };
}

function fixtureR2Binding(objects: ObjectStoreAccess): R2BucketLike {
  return {
    async put() {
      throw new Error("R2 put is outside purge scope");
    },
    async get() {
      throw new Error("R2 get is outside purge scope");
    },
    async head(key) {
      const object = await objects.head(key);
      return object
        ? {
            key: object.key,
            size: object.size,
            etag: object.etag,
            ...(object.contentType ? { httpMetadata: { contentType: object.contentType } } : {}),
          }
        : null;
    },
    async delete() {
      throw new Error("R2 delete is outside purge scope");
    },
    async list() {
      throw new Error("R2 list is outside purge scope");
    },
  };
}

async function recoveryFixture(options?: {
  readonly deleteBehavior?: "normal" | "throw" | "delete-then-throw";
  readonly deleteThenThrowCalls?: readonly number[];
  readonly failPrepareBatch?: boolean;
}) {
  const storageSql = createEphemeralSql();
  const baseObjects = createMemoryObjectStore();
  let deleteCalls = 0;
  const objects: ObjectStoreAccess = {
    writeOperationIdentity: baseObjects.writeOperationIdentity,
    put: (key, body, putOptions) => baseObjects.put(key, body, putOptions),
    get: (key) => baseObjects.get(key),
    head: (key) => baseObjects.head(key),
    list: (input) => baseObjects.list(input),
    async delete(key) {
      deleteCalls += 1;
      if (options?.deleteBehavior === "throw" && deleteCalls === 1) {
        throw new Error("simulated ambiguous delete");
      }
      const deleted = await baseObjects.delete(key);
      if (
        (options?.deleteBehavior === "delete-then-throw" && deleteCalls === 1) ||
        options?.deleteThenThrowCalls?.includes(deleteCalls)
      ) {
        throw new Error("lost delete ack");
      }
      return deleted;
    },
  };
  let timestamp = Date.parse("2026-09-04T12:00:00.000Z");
  const clock = () => new Date(timestamp);
  const request = await exactRequest();
  const canonical = await canonicalArtifactRecoveryRequest(request);
  await seedCredentialClosures(storageSql, request, timestamp);
  await seedArtifacts(storageSql, objects, request, timestamp);
  let batches = 0;
  const sql: Sql = options?.failPrepareBatch
    ? {
        query: (statement, params) => storageSql.query(statement, params),
        run: (statement, params) => storageSql.run(statement, params),
        async batch(statements) {
          if (++batches === 1) throw new Error("injected prepare batch failure");
          return await storageSql.batch(statements);
        },
      }
    : storageSql;
  let random = 0;
  const exactCoordinator = createExactArtifactRecoveryCoordinator({
    sql,
    objects,
    clock,
    randomId: () => `recovery-${++random}`,
  });
  const reconciler = createTakoformArtifactReconciler({
    sql,
    objects,
    clock,
    randomId: () => `ordinary-${++random}`,
  });
  const execution: ArtifactRecoveryExecution = {
    pinnedRequestDigest: canonical.requestDigest,
    workerVersionId: FIRST_VERSION,
    r2IdentityDigest: request.r2.identityDigest,
    sourceCommit: request.source.commit,
    sourceVersion: request.source.version,
  };
  const recoveryFor = (selected: ArtifactRecoveryExecution) =>
    createArtifactRecovery({
      sql,
      objects,
      clock,
      coordinator: exactCoordinator,
      execution: selected,
    });
  return {
    sql,
    objects,
    request,
    canonical,
    execution,
    reconciler,
    recovery: recoveryFor(execution),
    recoveryFor,
    clock,
    advance(milliseconds: number) {
      timestamp += milliseconds;
    },
    now: () => timestamp,
    deleteCalls: () => deleteCalls,
  };
}

async function exactRequest(): Promise<ArtifactRecoveryRequest> {
  const operationIds = ["recovery-op-a", "recovery-op-b", "recovery-op-c", "recovery-op-d"];
  const owners = await Promise.all(
    operationIds.map(async (operationId) => ({
      operationId,
      principalId: `api-key:${(await deterministicIntegrationE2eApiKeyIds(operationId)).writer}`,
    })),
  );
  owners.sort(byPrincipal);
  const memberDigests = Array.from(
    { length: 28 },
    (_, index) => `sha256:${index.toString(16).padStart(64, "0")}` as const,
  );
  const manifest = {
    format: "takoform.artifact-manifest@v1",
    modules: memberDigests.map((digest, index) => ({
      path: `module-${index}.mjs`,
      digest,
      size: 1,
    })),
    files: [],
  };
  const manifestDigest = await canonicalDigest(manifest);
  const memberSetDigest = await canonicalDigest(memberDigests);
  const uploads = owners
    .flatMap((owner, index) => [
      {
        principalId: owner.principalId,
        uploadId: `up_recovery_${index}_a`,
        uploadFence: 2,
        rootFence: 2,
      },
      ...(index === 0
        ? [
            {
              principalId: owner.principalId,
              uploadId: `up_recovery_${index}_b`,
              uploadFence: 2,
              rootFence: 2,
            },
          ]
        : []),
    ])
    .sort((left, right) =>
      `${left.principalId}\u0000${left.uploadId}` < `${right.principalId}\u0000${right.uploadId}`
        ? -1
        : 1,
    );
  const holds = [
    { kind: "manifest" as const, digest: manifestDigest },
    ...memberDigests.map((digest) => ({ kind: "blob" as const, digest })),
  ];
  const replayKeys = [
    `${INTEGRATION_E2E_ORGANIZATION_ID}\u0000${owners[0]?.principalId}\u0000commit-a`,
    `${INTEGRATION_E2E_ORGANIZATION_ID}\u0000${owners[1]?.principalId}\u0000commit-b`,
  ].sort();
  const accountId = "a".repeat(32);
  const bucketName = "takoserver-staging-artifacts";
  return {
    kind: ARTIFACT_RECOVERY_REQUEST_FORMAT,
    tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
    logicalTargetDigest: await canonicalDigest({
      kind: "takoserver.exact-artifact-logical-target@v1",
      tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
      manifestDigest,
      memberSetDigest,
    }),
    owners,
    ownerSetDigest: await canonicalDigest(owners),
    uploads,
    uploadSetDigest: await canonicalDigest(uploads),
    manifestDigest,
    memberDigests,
    memberSetDigest,
    expectedHolds: { entries: holds, count: holds.length, setDigest: await canonicalDigest(holds) },
    expectedReplays: {
      keys: replayKeys,
      count: replayKeys.length,
      setDigest: await canonicalDigest(replayKeys),
    },
    settlementEvidence: {
      kind: "takosumi.apply-run-failure@v1",
      digest: `sha256:${"e".repeat(64)}`,
    },
    lineage: {
      migration: ARTIFACT_RECOVERY_LINEAGE_MIGRATION,
      digest: ARTIFACT_RECOVERY_LINEAGE_DIGEST,
    },
    r2: {
      accountId,
      bucketName,
      identityDigest: await canonicalDigest({
        kind: "takoserver.r2-artifact-target@v1",
        accountId,
        bucketName,
      }),
    },
    source: { repository: "takoserver", commit: "b".repeat(40), version: "exact-recovery-test-v1" },
    retentionPolicy: {
      kind: ARTIFACT_RECOVERY_RETENTION_FORMAT,
      evidenceDigest: `sha256:${"7".repeat(64)}`,
      detailRetentionMilliseconds: 7 * 24 * 60 * 60_000,
    },
  };
}

async function seedCredentialClosures(
  sql: Sql,
  request: ArtifactRecoveryRequest,
  timestamp: number,
): Promise<void> {
  for (let index = 0; index < request.owners.length; index += 1) {
    const owner = request.owners[index];
    if (!owner) throw new Error("owner fixture missing");
    const ids = await deterministicIntegrationE2eApiKeyIds(owner.operationId);
    const createdAt = timestamp - 10_000;
    const revokedAt = timestamp - 1_000;
    const createdIso = new Date(createdAt).toISOString();
    const expiresIso = new Date(
      createdAt + INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS * 1_000,
    ).toISOString();
    const revokedIso = new Date(revokedAt).toISOString();
    for (const [role, id, name, scopes] of [
      ["writer", ids.writer, INTEGRATION_E2E_WRITER_KEY_NAME, INTEGRATION_E2E_WRITER_SCOPES],
      [
        "evidence",
        ids.evidence,
        INTEGRATION_E2E_EVIDENCE_KEY_NAME,
        INTEGRATION_E2E_EVIDENCE_SCOPES,
      ],
    ] as const) {
      await sql.run(
        `INSERT INTO auth_tokens
           (secret_digest, id, kind, principal_id, org_id, name, scopes_json,
            created_at, expires_at, revoked_at)
         VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, ?)`,
        [
          `sha256:${(index * 2 + (role === "writer" ? 0 : 1)).toString(16).padStart(64, "0")}`,
          id,
          `principal-${index}`,
          request.tenantId,
          name,
          JSON.stringify(scopes),
          createdIso,
          expiresIso,
          revokedIso,
        ],
      );
    }
    await sql.run(
      `INSERT INTO integration_e2e_credential_pair_operations
         (operation_id, authority_slot, org_id, writer_key_id, evidence_key_id,
          writer_name, evidence_name, writer_scopes_json, evidence_scopes_json,
          ttl_seconds, state, fence, source_commit, artifact_digest,
          authority_worker_version_id, created_at, updated_at, revoked_at)
       VALUES (?, 'integration-e2e-credential-pair', ?, ?, ?, ?, ?, ?, ?, 3600,
               'revoked', 6, ?, ?, ?, ?, ?, ?)`,
      [
        owner.operationId,
        request.tenantId,
        ids.writer,
        ids.evidence,
        INTEGRATION_E2E_WRITER_KEY_NAME,
        INTEGRATION_E2E_EVIDENCE_KEY_NAME,
        JSON.stringify(INTEGRATION_E2E_WRITER_SCOPES),
        JSON.stringify(INTEGRATION_E2E_EVIDENCE_SCOPES),
        "a".repeat(40),
        `sha256:${"b".repeat(64)}`,
        "11111111-1111-4111-8111-111111111111",
        createdAt,
        revokedAt,
        revokedAt,
      ],
    );
  }
}

async function seedArtifacts(
  sql: Sql,
  objects: ObjectStoreAccess,
  request: ArtifactRecoveryRequest,
  timestamp: number,
): Promise<void> {
  const manifest = {
    format: "takoform.artifact-manifest@v1",
    modules: request.memberDigests.map((digest, index) => ({
      path: `module-${index}.mjs`,
      digest,
      size: 1,
    })),
    files: [],
  };
  const manifestJson = canonicalJson(manifest);
  for (const digest of request.memberDigests) {
    await objects.put(blobKey(digest), new Uint8Array([1]));
    await sql.run("INSERT INTO tf_artifact_manifest_members VALUES (?, ?)", [
      request.manifestDigest,
      digest,
    ]);
  }
  await sql.run("INSERT INTO tf_artifact_manifests VALUES (?, ?, ?)", [
    request.manifestDigest,
    manifestJson,
    timestamp - 5_000,
  ]);
  for (const upload of request.uploads) {
    await sql.run(
      `INSERT INTO tf_artifact_uploads
         (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at,
          lifecycle_state, lifecycle_fence, updated_at, abandoned_at)
       VALUES (?, ?, ?, ?, ?, ?, 'committed', 2, ?, NULL)`,
      [
        upload.uploadId,
        request.tenantId,
        upload.principalId,
        manifestJson,
        request.manifestDigest,
        timestamp - 5_000,
        timestamp - 5_000,
      ],
    );
    await sql.run(
      `INSERT INTO tf_artifact_roots
         (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
          expires_at, release_reason, created_at, released_at)
       VALUES (?, 'upload', ?, 'manifest', ?, 'active', 2, NULL, NULL, ?, NULL)`,
      [request.tenantId, upload.uploadId, request.manifestDigest, timestamp - 5_000],
    );
  }
  for (const hold of request.expectedHolds.entries) {
    await sql.run("INSERT INTO tf_artifact_holds VALUES (?, ?, ?)", [
      request.tenantId,
      hold.digest,
      hold.kind,
    ]);
  }
  for (const replayKey of request.expectedReplays.keys) {
    await sql.run("INSERT INTO tf_artifact_replays VALUES (?, 200, ?, ?)", [
      replayKey,
      JSON.stringify({ manifestDigest: request.manifestDigest }),
      timestamp + 86_400_000,
    ]);
  }
}

async function count(sql: Sql, table: string): Promise<number> {
  const rows = await sql.query(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(rows[0]?.total);
}

async function externalStateDigest(
  sql: Sql,
  objects: ObjectStoreAccess,
  digest: `sha256:${string}`,
): Promise<`sha256:${string}`> {
  return await canonicalDigest({
    kind: "takoserver.exact-recovery-external-state-test@v1",
    candidates: await sql.query(
      "SELECT * FROM tf_artifact_gc_candidates WHERE kind = 'blob' AND digest = ?",
      [digest],
    ),
    results: await sql.query(
      "SELECT * FROM tf_artifact_blob_io_results WHERE digest = ? ORDER BY operation_id",
      [digest],
    ),
    object: await objects.head(blobKey(digest)),
  });
}

function byPrincipal(
  left: { readonly principalId: string },
  right: { readonly principalId: string },
): number {
  return left.principalId < right.principalId ? -1 : left.principalId > right.principalId ? 1 : 0;
}

function blobKey(digest: string): string {
  return `art/${digest.slice("sha256:".length)}`;
}
