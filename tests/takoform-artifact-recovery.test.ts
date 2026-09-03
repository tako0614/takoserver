import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { canonicalDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { ObjectStoreAccess, Sql } from "../src/ports.ts";
import { createTakoformArtifactReconciler } from "../src/takoform/artifact-reconciler.ts";
import {
  type ArtifactRecoveryRequest,
  canonicalArtifactRecoveryRequest,
  createArtifactRecovery,
} from "../src/takoform/artifact-recovery.ts";

const digest = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;

async function exactRequest(): Promise<ArtifactRecoveryRequest> {
  const memberDigests = Array.from(
    { length: 28 },
    (_, index) => `sha256:${index.toString(16).padStart(64, "0")}` as `sha256:${string}`,
  );
  const manifestDigest = digest("f");
  const holds = [
    { kind: "manifest" as const, digest: manifestDigest },
    ...memberDigests.map((memberDigest) => ({ kind: "blob" as const, digest: memberDigest })),
  ];
  const replayKeys = ["tenant_a\0run:failed-a\0commit", "tenant_a\0run:failed-a\0start"];
  return {
    kind: "takoserver.exact-failed-run-artifact-recovery-request@v1",
    tenantId: "tenant_a",
    principalId: "run:failed-a",
    uploadId: "up_failed_a",
    manifestDigest,
    uploadFence: 2,
    rootFence: 2,
    memberDigests,
    memberSetDigest: await canonicalDigest(memberDigests),
    expectedHolds: {
      entries: holds,
      count: holds.length,
      setDigest: await canonicalDigest(holds),
    },
    expectedReplays: {
      keys: replayKeys,
      count: replayKeys.length,
      setDigest: await canonicalDigest(replayKeys),
    },
    failedRunEvidence: {
      kind: "takosumi.apply-run-failure@v1",
      sha256: digest("e"),
    },
    closedAt: Date.parse("2026-09-08T00:00:00.000Z"),
  };
}

interface RecoveryFixture {
  readonly durable: Sql;
  readonly request: ArtifactRecoveryRequest;
  readonly recovery: ReturnType<typeof createArtifactRecovery>;
  readonly reconciler: ReturnType<typeof createTakoformArtifactReconciler>;
  readonly objects: ObjectStoreAccess;
  readonly deletedKeys: string[];
  advance(milliseconds: number): void;
}

async function recoveryFixture(input?: {
  readonly wrapSql?: (durable: Sql) => Sql;
}): Promise<RecoveryFixture> {
  const durable = createEphemeralSql();
  const template = await exactRequest();
  const baseObjects = createMemoryObjectStore();
  const deletedKeys: string[] = [];
  const objects: ObjectStoreAccess = {
    ...baseObjects,
    async delete(key) {
      deletedKeys.push(key);
      return await baseObjects.delete(key);
    },
  };
  let timestamp = template.closedAt + 5 * 60_000;
  const clock = () => new Date(timestamp);
  const manifest = {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle",
    mainModule: "worker-00.mjs",
    modules: template.memberDigests.map((memberDigest, index) => ({
      name: `worker-${index.toString().padStart(2, "0")}.mjs`,
      mediaType: "application/javascript+module",
      size: 1,
      digest: memberDigest,
    })),
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestDigest = await canonicalDigest(manifest);
  const holds = [
    { kind: "manifest" as const, digest: manifestDigest },
    ...template.memberDigests.map((memberDigest) => ({
      kind: "blob" as const,
      digest: memberDigest,
    })),
  ];
  const request: ArtifactRecoveryRequest = {
    ...template,
    manifestDigest,
    expectedHolds: {
      entries: holds,
      count: holds.length,
      setDigest: await canonicalDigest(holds),
    },
  };
  await durable.run(
    `INSERT INTO tf_artifact_uploads
       (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at,
        lifecycle_state, lifecycle_fence, updated_at, abandoned_at)
     VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, NULL)`,
    [
      request.uploadId,
      request.tenantId,
      request.principalId,
      manifestJson,
      request.manifestDigest,
      request.closedAt - 60_000,
      request.uploadFence,
      request.closedAt - 30_000,
    ],
  );
  await durable.run(
    `INSERT INTO tf_artifact_manifests (digest, manifest_json, created_at)
     VALUES (?, ?, ?)`,
    [request.manifestDigest, manifestJson, request.closedAt - 30_000],
  );
  for (const memberDigest of request.memberDigests) {
    await durable.run(
      `INSERT INTO tf_artifact_manifest_members (manifest_digest, blob_digest) VALUES (?, ?)`,
      [request.manifestDigest, memberDigest],
    );
    await objects.put(`art/${memberDigest.slice("sha256:".length)}`, new Uint8Array([1]));
  }
  for (const hold of request.expectedHolds.entries) {
    await durable.run(`INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)`, [
      request.tenantId,
      hold.digest,
      hold.kind,
    ]);
  }
  await durable.run(
    `INSERT INTO tf_artifact_roots
       (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
        expires_at, release_reason, created_at, released_at)
     VALUES (?, 'upload', ?, 'manifest', ?, 'active', ?, NULL, NULL, ?, NULL)`,
    [
      request.tenantId,
      request.uploadId,
      request.manifestDigest,
      request.rootFence,
      request.closedAt - 60_000,
    ],
  );
  for (const replayKey of request.expectedReplays.keys) {
    await durable.run(
      `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
       VALUES (?, 201, ?, ?)`,
      [
        replayKey,
        JSON.stringify({ manifestDigest: request.manifestDigest }),
        request.closedAt + 24 * 60 * 60_000,
      ],
    );
  }
  const sql = input?.wrapSql?.(durable) ?? durable;
  const reconciler = createTakoformArtifactReconciler({
    sql,
    objects,
    clock,
    randomId: () => "exact-recovery-guard",
  });
  return {
    durable,
    request,
    objects,
    deletedKeys,
    reconciler,
    recovery: createArtifactRecovery({ sql, objects, clock, reconciler }),
    advance(milliseconds) {
      timestamp += milliseconds;
    },
  };
}

interface FaultSql {
  readonly sql: Sql;
  loseAfter(statementFragment: string): void;
  failBefore(statementFragment: string): void;
}

function faultSql(base: Sql): FaultSql {
  let after: string | null = null;
  let before: string | null = null;
  const matches = (fragment: string | null, statements: readonly string[]): boolean =>
    fragment !== null && statements.some((statement) => statement.includes(fragment));
  return {
    loseAfter(statementFragment) {
      after = statementFragment;
    },
    failBefore(statementFragment) {
      before = statementFragment;
    },
    sql: {
      query: (statement, params) => base.query(statement, params),
      async run(statement, params) {
        if (matches(before, [statement])) {
          before = null;
          throw new Error("simulated SQL failure before write");
        }
        const result = await base.run(statement, params);
        if (matches(after, [statement])) {
          after = null;
          throw new Error("simulated lost SQL acknowledgement");
        }
        return result;
      },
      async batch(statements) {
        const sql = statements.map((statement) => statement.sql);
        if (matches(before, sql)) {
          before = null;
          throw new Error("simulated SQL failure before write");
        }
        const result = await base.batch(statements);
        if (matches(after, sql)) {
          after = null;
          throw new Error("simulated lost SQL acknowledgement");
        }
        return result;
      },
    },
  };
}

function interceptBatch(
  base: Sql,
  fragment: string,
  mutate: () => Promise<void>,
  armed: () => boolean = () => true,
): Sql {
  let injected = false;
  return {
    query: (statement, params) => base.query(statement, params),
    run: (statement, params) => base.run(statement, params),
    async batch(statements) {
      if (
        !injected &&
        armed() &&
        statements.some((statement) => statement.sql.includes(fragment))
      ) {
        injected = true;
        await mutate();
      }
      return await base.batch(statements);
    },
  };
}

describe("exact failed-run artifact recovery", () => {
  test("status derives the exact phase without any durable or object mutation", async () => {
    let writes = 0;
    const target = await recoveryFixture({
      wrapSql(durable) {
        return {
          query: durable.query.bind(durable),
          async run(statement, params) {
            writes += 1;
            return await durable.run(statement, params);
          },
          async batch(statements) {
            writes += 1;
            return await durable.batch(statements);
          },
        };
      },
    });
    expect((await target.recovery.status(target.request)).phase).toBe("eligible");
    expect(writes).toBe(0);
    expect(target.deletedKeys).toEqual([]);
  });

  test("canonicalizes one exact 28-member request and derives its receipt identity", async () => {
    const request = await exactRequest();
    const canonical = await canonicalArtifactRecoveryRequest(request);

    expect(canonical.request).toEqual(request);
    expect(canonical.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(canonical.receiptId).toBe(`afr_${canonical.requestDigest.slice("sha256:".length)}`);

    await expect(
      canonicalArtifactRecoveryRequest({
        ...request,
        memberDigests: request.memberDigests.slice(1),
      }),
    ).rejects.toThrow("exactly 28");
    await expect(
      canonicalArtifactRecoveryRequest({
        ...request,
        memberSetDigest: digest("a"),
      }),
    ).rejects.toThrow("member set digest");
  });

  test("quarantines only the exact 29 objects and settles them after one hour", async () => {
    const target = await recoveryFixture();
    const unrelatedDigest = digest("d");
    await target.durable.run(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'pending', 1, 0, 'unrelated-etag', 0,
               'pending', 0, 0, NULL)`,
      [unrelatedDigest],
    );

    expect((await target.recovery.status(target.request)).phase).toBe("eligible");
    const prepared = await target.recovery.apply(target.request);
    expect(prepared.readback.phase).toBe("quarantined");
    expect(prepared.readback.candidates).toEqual({
      pending: 29,
      deleting: 0,
      retry: 0,
      deleted: 0,
    });
    expect(target.deletedKeys).toEqual([]);

    expect((await target.recovery.apply(target.request)).readback.phase).toBe("quarantined");
    expect(target.deletedKeys).toEqual([]);
    target.advance(60 * 60_000);
    const settled = await target.recovery.apply(target.request);
    expect(settled.readback).toMatchObject({
      phase: "complete",
      upload: { lifecycle: "committed", fence: 3 },
      candidates: { pending: 0, deleting: 0, retry: 0, deleted: 29 },
      quarantineNotBefore: null,
      metadataPresent: false,
      presentBlobs: 0,
      absentBlobs: 28,
    });
    expect(target.deletedKeys).toHaveLength(28);
    expect(
      await target.durable.query(
        `SELECT lifecycle_state, lifecycle_fence FROM tf_artifact_uploads WHERE id = ?`,
        [target.request.uploadId],
      ),
    ).toEqual([{ lifecycle_state: "committed", lifecycle_fence: 3 }]);
    expect(
      await target.durable.query(
        `SELECT COUNT(*) AS total FROM tf_artifact_owner_closure_receipts
         WHERE receipt_id GLOB 'afr_*'`,
      ),
    ).toEqual([{ total: 1 }]);
    expect(
      await target.durable.query(
        `SELECT COUNT(*) AS total FROM tf_artifact_gc_candidates
         WHERE state = 'deleted' AND (
           (kind = 'manifest' AND digest = ?) OR
           (kind = 'blob' AND digest IN
             (SELECT CAST(value AS TEXT) FROM json_each(?)))
         )`,
        [target.request.manifestDigest, JSON.stringify(target.request.memberDigests)],
      ),
    ).toEqual([{ total: 29 }]);
    expect(
      await target.durable.query(
        `SELECT state, expected_etag FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
        [unrelatedDigest],
      ),
    ).toEqual([{ state: "pending", expected_etag: "unrelated-etag" }]);
    expect(
      await target.durable.query(
        `SELECT COUNT(*) AS total FROM tf_artifact_manifests WHERE digest = ?`,
        [target.request.manifestDigest],
      ),
    ).toEqual([{ total: 0 }]);
    expect(
      await target.durable.query(
        `SELECT COUNT(*) AS total FROM tf_artifact_manifest_members WHERE manifest_digest = ?`,
        [target.request.manifestDigest],
      ),
    ).toEqual([{ total: 0 }]);
    expect(
      await target.durable.query(
        `SELECT COUNT(*) AS total FROM tf_artifact_holds WHERE tenant_id = ?`,
        [target.request.tenantId],
      ),
    ).toEqual([{ total: 0 }]);
    expect(
      await target.durable.query(
        `SELECT COUNT(*) AS total FROM tf_artifact_replays
         WHERE replay_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
        [JSON.stringify(target.request.expectedReplays.keys)],
      ),
    ).toEqual([{ total: 0 }]);
    for (const memberDigest of target.request.memberDigests) {
      expect(await target.objects.head(`art/${memberDigest.slice("sha256:".length)}`)).toBeNull();
    }
  });

  test("keeps the exact set outside global object reconciliation", async () => {
    const target = await recoveryFixture();
    await target.recovery.apply(target.request);
    target.advance(60 * 60_000);

    expect(await target.reconciler.reconcile({ limit: 64, deleteObjects: true })).toMatchObject({
      candidatesCreated: 0,
      deletedObjects: 0,
    });
    expect(target.deletedKeys).toEqual([]);
    expect((await target.recovery.status(target.request)).candidates).toEqual({
      pending: 29,
      deleting: 0,
      retry: 0,
      deleted: 0,
    });
  });

  test("refuses every exact identity, fence, hold, replay, and member drift", async () => {
    for (const mutate of [
      (request: ArtifactRecoveryRequest) => ({ ...request, tenantId: "tenant_other" }),
      (request: ArtifactRecoveryRequest) => ({ ...request, principalId: "run:other" }),
      (request: ArtifactRecoveryRequest) => ({ ...request, uploadId: "up_other" }),
      (request: ArtifactRecoveryRequest) => ({ ...request, manifestDigest: digest("c") }),
      (request: ArtifactRecoveryRequest) => ({ ...request, uploadFence: request.uploadFence + 1 }),
      (request: ArtifactRecoveryRequest) => ({ ...request, rootFence: request.rootFence + 1 }),
    ] as const) {
      const target = await recoveryFixture();
      await expect(target.recovery.status(mutate(target.request))).rejects.toThrow();
    }

    const memberTarget = await recoveryFixture();
    const changedMembers = [...memberTarget.request.memberDigests];
    changedMembers[0] = digest("b");
    changedMembers.sort();
    const changedHolds = [
      { kind: "manifest" as const, digest: memberTarget.request.manifestDigest },
      ...changedMembers.map((memberDigest) => ({ kind: "blob" as const, digest: memberDigest })),
    ];
    await expect(
      memberTarget.recovery.status({
        ...memberTarget.request,
        memberDigests: changedMembers,
        memberSetDigest: await canonicalDigest(changedMembers),
        expectedHolds: {
          entries: changedHolds,
          count: changedHolds.length,
          setDigest: await canonicalDigest(changedHolds),
        },
      }),
    ).rejects.toThrow("member identity drifted");

    const holdTarget = await recoveryFixture();
    await holdTarget.durable.run(
      `DELETE FROM tf_artifact_holds WHERE tenant_id = ? AND kind = 'blob' AND digest = ?`,
      [holdTarget.request.tenantId, holdTarget.request.memberDigests[0] as string],
    );
    await expect(holdTarget.recovery.status(holdTarget.request)).rejects.toThrow(
      "hold set drifted",
    );

    const wrongHoldKindTarget = await recoveryFixture();
    await wrongHoldKindTarget.durable.run(
      `INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, 'manifest')`,
      [
        wrongHoldKindTarget.request.tenantId,
        wrongHoldKindTarget.request.memberDigests[0] as string,
      ],
    );
    await expect(wrongHoldKindTarget.recovery.status(wrongHoldKindTarget.request)).rejects.toThrow(
      "hold set drifted",
    );

    const replayTarget = await recoveryFixture();
    await replayTarget.durable.run("DELETE FROM tf_artifact_replays WHERE replay_key = ?", [
      replayTarget.request.expectedReplays.keys[0] as string,
    ]);
    await expect(replayTarget.recovery.status(replayTarget.request)).rejects.toThrow(
      "replay set drifted",
    );

    const replayFenceTarget = await recoveryFixture();
    await replayFenceTarget.durable.run(
      `UPDATE tf_artifact_roots SET fence = fence + 1
       WHERE root_kind = 'replay' AND root_id = ?`,
      [replayFenceTarget.request.expectedReplays.keys[0] as string],
    );
    await expect(replayFenceTarget.recovery.status(replayFenceTarget.request)).rejects.toThrow(
      "replay-root set drifted",
    );

    const candidateFenceTarget = await recoveryFixture();
    await candidateFenceTarget.recovery.apply(candidateFenceTarget.request);
    await candidateFenceTarget.durable.run(
      `UPDATE tf_artifact_gc_candidates SET fence = 99
       WHERE kind = 'blob' AND digest = ?`,
      [candidateFenceTarget.request.memberDigests[0] as string],
    );
    await expect(
      candidateFenceTarget.recovery.status(candidateFenceTarget.request),
    ).rejects.toThrow("candidate fence");

    const digestTarget = await recoveryFixture();
    await expect(
      digestTarget.recovery.status({
        ...digestTarget.request,
        expectedHolds: { ...digestTarget.request.expectedHolds, setDigest: digest("a") },
      }),
    ).rejects.toThrow("hold set digest");
    await expect(
      digestTarget.recovery.status({
        ...digestTarget.request,
        expectedReplays: { ...digestTarget.request.expectedReplays, setDigest: digest("a") },
      }),
    ).rejects.toThrow("replay set digest");
  });

  test("refuses consumer uncertainty and live consumer, foreign, or shared roots", async () => {
    const uncertainty = await recoveryFixture();
    await uncertainty.durable.run(
      `INSERT INTO tf_artifact_consumer_uncertainties
         (tenant_id, consumer_kind, consumer_id, state, fence, reason, created_at, resolved_at)
       VALUES (?, 'deployment', 'dep_uncertain', 'active', 1,
               'historical_deployment_digest_unknown', ?, NULL)`,
      [uncertainty.request.tenantId, uncertainty.request.closedAt],
    );
    await expect(uncertainty.recovery.status(uncertainty.request)).rejects.toThrow(
      "consumer uncertainty",
    );

    for (const root of [
      { tenant: "tenant_other", kind: "legacy-hold", id: "foreign-root", message: "foreign root" },
      { tenant: "tenant_a", kind: "legacy-hold", id: "shared-root", message: "shared root" },
      { tenant: "tenant_a", kind: "resource", id: "resource-live", message: "live consumer root" },
    ] as const) {
      const target = await recoveryFixture();
      await target.durable.run(
        `INSERT INTO tf_artifact_roots
           (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
            expires_at, release_reason, created_at, released_at)
         VALUES (?, ?, ?, 'blob', ?, 'active', 1, NULL, NULL, ?, NULL)`,
        [
          root.tenant,
          root.kind,
          root.id,
          target.request.memberDigests[0] as string,
          target.request.closedAt,
        ],
      );
      await expect(target.recovery.status(target.request)).rejects.toThrow(root.message);
    }
  });

  test("refuses reuse of an exact replay key after its reviewed replay was released", async () => {
    const target = await recoveryFixture();
    await target.recovery.apply(target.request);
    await target.durable.run(
      `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
       VALUES (?, 201, ?, ?)`,
      [
        target.request.expectedReplays.keys[0] as string,
        JSON.stringify({ manifestDigest: digest("d") }),
        target.request.closedAt + 48 * 60 * 60_000,
      ],
    );

    await expect(target.recovery.status(target.request)).rejects.toThrow("replay");
    target.advance(60 * 60_000);
    await expect(target.recovery.apply(target.request)).rejects.toThrow("replay");
    expect(target.deletedKeys).toEqual([]);
  });

  test("derives receipt and quarantine phases after lost acknowledgements", async () => {
    let receiptFault: FaultSql | undefined;
    const receiptTarget = await recoveryFixture({
      wrapSql(durable) {
        receiptFault = faultSql(durable);
        return receiptFault.sql;
      },
    });
    receiptFault?.loseAfter("INSERT INTO tf_artifact_owner_closure_receipts");
    await expect(receiptTarget.recovery.apply(receiptTarget.request)).rejects.toThrow(
      "lost SQL acknowledgement",
    );
    expect((await receiptTarget.recovery.status(receiptTarget.request)).phase).toBe(
      "receipt-issued",
    );
    expect((await receiptTarget.recovery.apply(receiptTarget.request)).readback.phase).toBe(
      "quarantined",
    );

    let rootFault: FaultSql | undefined;
    const rootTarget = await recoveryFixture({
      wrapSql(durable) {
        rootFault = faultSql(durable);
        return rootFault.sql;
      },
    });
    rootFault?.loseAfter("SET state = 'released'");
    await expect(rootTarget.recovery.apply(rootTarget.request)).rejects.toThrow(
      "lost SQL acknowledgement",
    );
    expect((await rootTarget.recovery.status(rootTarget.request)).phase).toBe("quarantined");
    expect(rootTarget.deletedKeys).toEqual([]);
  });

  test("re-fences receipt, member, and hold identity inside the atomic prepare batch", async () => {
    for (const drift of ["receipt", "member", "hold"] as const) {
      let target: RecoveryFixture;
      target = await recoveryFixture({
        wrapSql(durable) {
          return interceptBatch(durable, "operator_exact_failed_run", async () => {
            if (drift === "receipt") {
              await durable.run(
                "UPDATE tf_artifact_owner_closure_receipts SET closed_at = closed_at + 1",
              );
              return;
            }
            if (drift === "member") {
              await durable.run(
                "DELETE FROM tf_artifact_manifest_members WHERE manifest_digest = ? AND blob_digest = ?",
                [target.request.manifestDigest, target.request.memberDigests[0] as string],
              );
              return;
            }
            await durable.run(
              `INSERT INTO tf_artifact_holds (tenant_id, digest, kind)
               VALUES (?, ?, 'manifest')`,
              [target.request.tenantId, target.request.memberDigests[0] as string],
            );
          });
        },
      });
      await expect(target.recovery.apply(target.request)).rejects.toThrow();
      expect(
        await target.durable.query(
          `SELECT state, fence FROM tf_artifact_roots
           WHERE root_kind = 'upload' AND root_id = ?`,
          [target.request.uploadId],
        ),
      ).toEqual([{ state: "active", fence: target.request.rootFence }]);
      expect(
        await target.durable.query("SELECT COUNT(*) AS total FROM tf_artifact_gc_candidates"),
      ).toEqual([{ total: 0 }]);
    }
  });

  test("re-fences upload state and released metadata before every external delete", async () => {
    let armed = false;
    let target: RecoveryFixture;
    target = await recoveryFixture({
      wrapSql(durable) {
        return interceptBatch(
          durable,
          "SET state = 'deleting'",
          async () => {
            await durable.run(
              "UPDATE tf_artifact_uploads SET lifecycle_fence = lifecycle_fence + 1 WHERE id = ?",
              [target.request.uploadId],
            );
          },
          () => armed,
        );
      },
    });
    await target.recovery.apply(target.request);
    target.advance(60 * 60_000);
    armed = true;
    await expect(target.recovery.apply(target.request)).rejects.toThrow();
    expect(target.deletedKeys).toEqual([]);
  });

  test("re-fences every hold role before an external delete", async () => {
    let armed = false;
    let target: RecoveryFixture;
    target = await recoveryFixture({
      wrapSql(durable) {
        return interceptBatch(
          durable,
          "SET state = 'deleting'",
          async () => {
            await durable.run(
              `INSERT INTO tf_artifact_holds (tenant_id, digest, kind)
               VALUES (?, ?, 'manifest')`,
              [target.request.tenantId, target.request.memberDigests[0] as string],
            );
          },
          () => armed,
        );
      },
    });
    await target.recovery.apply(target.request);
    target.advance(60 * 60_000);
    armed = true;
    await expect(target.recovery.apply(target.request)).rejects.toThrow();
    expect(target.deletedKeys).toEqual([]);
  });

  test("re-quarantines ETag drift and never deletes it before a fresh hour", async () => {
    const target = await recoveryFixture();
    await target.recovery.apply(target.request);
    const changed = target.request.memberDigests[0] as `sha256:${string}`;
    const key = `art/${changed.slice("sha256:".length)}`;
    await target.objects.put(key, new Uint8Array([9]));
    target.advance(60 * 60_000);

    const drifted = await target.recovery.apply(target.request);
    expect(drifted.readback.phase).toBe("requarantined");
    expect(target.deletedKeys).not.toContain(key);
    const deletesAfterDrift = target.deletedKeys.length;
    const waiting = await target.recovery.apply(target.request);
    expect(waiting.plan.action).toBe("wait");
    expect(target.deletedKeys).toHaveLength(deletesAfterDrift);

    target.advance(60 * 60_000);
    expect((await target.recovery.apply(target.request)).readback.phase).toBe("complete");
    expect(target.deletedKeys.filter((deleted) => deleted === key)).toHaveLength(1);
  });

  test("settles R2 absence after failed SQL settlement without repeating DELETE", async () => {
    let fault: FaultSql | undefined;
    const target = await recoveryFixture({
      wrapSql(durable) {
        fault = faultSql(durable);
        return fault.sql;
      },
    });
    await target.recovery.apply(target.request);
    target.advance(60 * 60_000);
    fault?.failBefore("SET state = 'deleted'");
    await expect(target.recovery.apply(target.request)).rejects.toThrow("failure before write");
    expect(target.deletedKeys).toHaveLength(1);
    const deletedKey = target.deletedKeys[0] as string;
    expect(await target.objects.head(deletedKey)).toBeNull();

    expect((await target.recovery.apply(target.request)).readback.phase).toBe("complete");
    expect(target.deletedKeys.filter((key) => key === deletedKey)).toHaveLength(1);
  });

  test("derives deleted tombstones after a lost SQL settlement acknowledgement", async () => {
    let fault: FaultSql | undefined;
    const target = await recoveryFixture({
      wrapSql(durable) {
        fault = faultSql(durable);
        return fault.sql;
      },
    });
    await target.recovery.apply(target.request);
    target.advance(60 * 60_000);
    fault?.loseAfter("SET state = 'deleted'");
    await expect(target.recovery.apply(target.request)).rejects.toThrow("lost SQL acknowledgement");
    expect(target.deletedKeys).toHaveLength(1);
    const deletedKey = target.deletedKeys[0] as string;
    expect(await target.objects.head(deletedKey)).toBeNull();
    expect((await target.recovery.status(target.request)).phase).toBe("settling");

    expect((await target.recovery.apply(target.request)).readback.phase).toBe("complete");
    expect(target.deletedKeys.filter((key) => key === deletedKey)).toHaveLength(1);
  });

  test("refuses a deterministic receipt id already bound to different content", async () => {
    const target = await recoveryFixture();
    const canonical = await canonicalArtifactRecoveryRequest(target.request);
    await target.durable.run(
      `INSERT INTO tf_artifact_owner_closure_receipts
         (receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
          manifest_digest, upload_fence, root_fence, state, closed_at,
          expires_at, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?)`,
      [
        canonical.receiptId,
        target.request.tenantId,
        target.request.principalId,
        target.request.uploadId,
        target.request.manifestDigest,
        target.request.uploadFence,
        target.request.rootFence,
        target.request.closedAt + 1,
        8_640_000_000_000_000,
        target.request.closedAt + 1,
        target.request.closedAt + 1,
      ],
    );
    await expect(target.recovery.status(target.request)).rejects.toThrow("different content");

    const expiryTarget = await recoveryFixture();
    const expiryCanonical = await canonicalArtifactRecoveryRequest(expiryTarget.request);
    await expiryTarget.durable.run(
      `INSERT INTO tf_artifact_owner_closure_receipts
         (receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
          manifest_digest, upload_fence, root_fence, state, closed_at,
          expires_at, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?)`,
      [
        expiryCanonical.receiptId,
        expiryTarget.request.tenantId,
        expiryTarget.request.principalId,
        expiryTarget.request.uploadId,
        expiryTarget.request.manifestDigest,
        expiryTarget.request.uploadFence,
        expiryTarget.request.rootFence,
        expiryTarget.request.closedAt,
        expiryTarget.request.closedAt + 24 * 60 * 60_000,
        expiryTarget.request.closedAt,
        expiryTarget.request.closedAt,
      ],
    );
    await expect(expiryTarget.recovery.status(expiryTarget.request)).rejects.toThrow(
      "different content",
    );
  });
});
