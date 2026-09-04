import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Accounts } from "../src/auth.ts";
import { createControlRoutes, type ResourceInventory } from "../src/control.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { RESOURCE_EXECUTION_EVIDENCE_FORMAT } from "../src/resource-execution-evidence.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createTakoformStore,
  type DeferredOperationRecord,
  type ResourceMutationCommit,
} from "../src/takoform/store.ts";
import type {
  TakoformDriverReceipt,
  TakoformStoredResource,
  TakoformV1Alpha3FormRef,
} from "../src/takoform/types.ts";

const TENANT_ID = "org_evidence";
const RESOURCE_UID = "uid_resource_evidence";
const FORM_REF: TakoformV1Alpha3FormRef = {
  apiVersion: "example.forms.invalid/v1",
  kind: "EvidenceThing",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};
const ADDRESS = {
  tenantId: TENANT_ID,
  space: "main",
  apiVersion: FORM_REF.apiVersion,
  kind: FORM_REF.kind,
  name: "example",
} as const;

function databaseWithEvidenceMigration(): Database {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const table = database
    .query("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("tf_resource_execution_evidence");
  if (!table) throw new Error("standard Takoserver migration lineage omitted execution evidence");
  return database;
}

function resource(
  revision: string,
  value: string,
  resourceUid = RESOURCE_UID,
  name: string = ADDRESS.name,
): TakoformStoredResource {
  return {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF },
    metadata: {
      name,
      space: ADDRESS.space,
      uid: resourceUid,
      generation: "1",
      revision,
    },
    spec: { value },
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: "2026-09-04T00:00:00.000Z",
        },
      ],
    },
  };
}

function writeMutation(
  stored: TakoformStoredResource,
  expectedRevision: string | null,
  operationId: string,
): ResourceMutationCommit {
  return {
    kind: "write",
    resourceUid: stored.metadata.uid,
    address: {
      ...ADDRESS,
      name: stored.metadata.name,
    },
    expectedRevision,
    resource: stored,
    replayKey: `replay_${operationId}`,
    replay: {
      fingerprint: `fingerprint_${operationId}`,
      status: expectedRevision === null ? 201 : 200,
      resource: stored,
      boundUid: stored.metadata.uid,
    },
  };
}

function evidenceCursor(input: {
  readonly organizationId?: string;
  readonly resourceUid: string;
  readonly snapshotFence: number;
  readonly beforeSequence: number;
}): string {
  return btoa(
    JSON.stringify({
      kind: "takoserver.resource-execution-evidence-cursor/v1",
      organizationId: input.organizationId ?? TENANT_ID,
      ...input,
    }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

describe("Takoserver Resource execution evidence", () => {
  test("commits a value-free Resource lifecycle atomically and keeps cursor pages on one snapshot", async () => {
    const database = databaseWithEvidenceMigration();
    let currentTime = Date.parse("2026-09-04T00:00:00.000Z");
    const store = createTakoformStore(createSqliteSql(database), () => new Date(currentTime));
    expect(
      await store.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        address: ADDRESS,
        formRef: FORM_REF,
      }),
    ).toBe(true);

    const created = resource("1", "credential-must-never-appear");
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_create_evidence",
      operation: "create",
      createdAt: new Date(currentTime).toISOString(),
      mutation: writeMutation(created, null, "op_create_evidence"),
    });

    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_create_evidence",
        operation: "update",
        createdAt: new Date(currentTime).toISOString(),
        mutation: {
          ...writeMutation(created, "1", "op_create_evidence"),
          preserveClaims: true,
        },
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });

    const changedWithoutVersion = resource("1", "changed-without-version");
    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_false_noop_evidence",
        operation: "update",
        createdAt: new Date(currentTime).toISOString(),
        mutation: {
          ...writeMutation(changedWithoutVersion, "1", "op_false_noop_evidence"),
          preserveClaims: true,
        },
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_stale_update_evidence",
        operation: "update",
        createdAt: new Date(currentTime).toISOString(),
        mutation: writeMutation(resource("2", "stale-write"), "0", "op_stale_update_evidence"),
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect((await store.resourceByUid(TENANT_ID, RESOURCE_UID))?.resource.spec).toEqual({
      value: "credential-must-never-appear",
    });

    currentTime += 1_000;
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_identity_noop",
      operation: "update",
      createdAt: new Date(currentTime).toISOString(),
      mutation: {
        ...writeMutation(created, "1", "op_identity_noop"),
        preserveClaims: true,
      },
    });

    currentTime += 1_000;
    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_identity_noop",
        operation: "update",
        createdAt: new Date(currentTime).toISOString(),
        mutation: writeMutation(
          resource("2", "must-not-borrow-noop-operation"),
          "1",
          "op_identity_noop",
        ),
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect((await store.resourceByUid(TENANT_ID, RESOURCE_UID))?.revision).toBe("1");

    const second = resource("2", "second-secret-value");
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_update_evidence_2",
      operation: "update",
      createdAt: new Date(currentTime).toISOString(),
      mutation: writeMutation(second, "1", "op_update_evidence_2"),
    });
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_update_evidence_2",
      operation: "update",
      createdAt: new Date(currentTime).toISOString(),
      mutation: writeMutation(second, "1", "op_update_evidence_2"),
    });

    const firstPage = await store.readResourceExecutionEvidence({
      tenantId: TENANT_ID,
      resourceUid: RESOURCE_UID,
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      executionEvidence: {
        format: RESOURCE_EXECUTION_EVIDENCE_FORMAT,
        organizationId: TENANT_ID,
        resource: {
          uid: RESOURCE_UID,
          address: {
            space: ADDRESS.space,
            apiVersion: ADDRESS.apiVersion,
            kind: ADDRESS.kind,
            name: ADDRESS.name,
          },
          formRef: FORM_REF,
        },
        coverage: "complete",
        snapshotFence: 2,
        commits: [
          {
            sequence: 2,
            operationId: "op_update_evidence_2",
            action: "update",
            outcome: "committed",
            resourceVersion: { generation: "1", revision: "2" },
            committedAt: "2026-09-04T00:00:02.000Z",
          },
        ],
      },
    });
    expect(firstPage?.cursor).toBeString();

    const otherTenantId = "org_other_evidence";
    const otherTenantAddress = { ...ADDRESS, tenantId: otherTenantId };
    expect(
      await store.reserveResourceIncarnation({
        tenantId: otherTenantId,
        resourceUid: RESOURCE_UID,
        address: otherTenantAddress,
        formRef: FORM_REF,
      }),
    ).toBe(true);
    const otherTenantCreated = resource("1", "other-tenant-secret");
    await store.commitImmediateMutation({
      tenantId: otherTenantId,
      operationId: "op_other_tenant_create",
      operation: "create",
      createdAt: new Date(currentTime).toISOString(),
      mutation: {
        ...writeMutation(otherTenantCreated, null, "op_other_tenant_create"),
        address: otherTenantAddress,
      },
    });
    const otherTenantUpdated = resource("2", "other-tenant-updated-secret");
    await store.commitImmediateMutation({
      tenantId: otherTenantId,
      operationId: "op_other_tenant_update",
      operation: "update",
      createdAt: new Date(currentTime).toISOString(),
      mutation: {
        ...writeMutation(otherTenantUpdated, "1", "op_other_tenant_update"),
        address: otherTenantAddress,
      },
    });
    await expect(
      store.readResourceExecutionEvidence({
        tenantId: otherTenantId,
        resourceUid: RESOURCE_UID,
        limit: 1,
        ...(firstPage?.cursor === undefined ? {} : { cursor: firstPage.cursor }),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    await expect(
      store.readResourceExecutionEvidence({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        limit: 1,
        cursor: evidenceCursor({
          resourceUid: RESOURCE_UID,
          snapshotFence: 3,
          beforeSequence: 2,
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      store.readResourceExecutionEvidence({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        limit: 1,
        cursor: evidenceCursor({
          resourceUid: RESOURCE_UID,
          snapshotFence: 2,
          beforeSequence: 1,
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    const otherUid = "uid_other_cursor_evidence";
    const otherAddress = { ...ADDRESS, name: "other-cursor" };
    expect(
      await store.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid: otherUid,
        address: otherAddress,
        formRef: FORM_REF,
      }),
    ).toBe(true);
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_other_cursor_evidence",
      operation: "create",
      createdAt: new Date(currentTime).toISOString(),
      mutation: writeMutation(
        resource("1", "other-private-value", otherUid, otherAddress.name),
        null,
        "op_other_cursor_evidence",
      ),
    });
    await expect(
      store.readResourceExecutionEvidence({
        tenantId: TENANT_ID,
        resourceUid: otherUid,
        limit: 1,
        cursor: evidenceCursor({
          resourceUid: RESOURCE_UID,
          snapshotFence: 1,
          beforeSequence: 1,
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    currentTime += 1_000;
    const third = resource("3", "third-secret-value");
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_update_evidence_3",
      operation: "update",
      createdAt: new Date(currentTime).toISOString(),
      mutation: writeMutation(third, "2", "op_update_evidence_3"),
    });

    const secondPage = await store.readResourceExecutionEvidence({
      tenantId: TENANT_ID,
      resourceUid: RESOURCE_UID,
      limit: 10,
      ...(firstPage?.cursor === undefined ? {} : { cursor: firstPage.cursor }),
    });
    expect(secondPage).toEqual({
      executionEvidence: {
        format: RESOURCE_EXECUTION_EVIDENCE_FORMAT,
        organizationId: TENANT_ID,
        resource: {
          uid: RESOURCE_UID,
          address: {
            space: ADDRESS.space,
            apiVersion: ADDRESS.apiVersion,
            kind: ADDRESS.kind,
            name: ADDRESS.name,
          },
          formRef: FORM_REF,
        },
        coverage: "complete",
        snapshotFence: 2,
        commits: [
          {
            sequence: 1,
            operationId: "op_create_evidence",
            action: "create",
            outcome: "committed",
            resourceVersion: { generation: "1", revision: "1" },
            committedAt: "2026-09-04T00:00:00.000Z",
          },
        ],
      },
    });

    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_stale_delete_evidence",
        operation: "delete",
        createdAt: new Date(currentTime).toISOString(),
        mutation: {
          kind: "delete",
          resourceUid: RESOURCE_UID,
          address: ADDRESS,
          expectedRevision: "0",
          replayKey: "replay_op_stale_delete_evidence",
          replay: { fingerprint: "fingerprint_op_stale_delete_evidence", status: 204 },
        },
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect((await store.resourceByUid(TENANT_ID, RESOURCE_UID))?.revision).toBe("3");

    currentTime += 1_000;
    await store.prepareResourceDeletion({
      tenantId: TENANT_ID,
      resourceUid: RESOURCE_UID,
      address: ADDRESS,
      formRef: FORM_REF,
      operationId: "op_delete_evidence",
    });
    expect(
      await store.markResourceDeletionDispatch({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        operationId: "op_delete_evidence",
      }),
    ).toBe(true);
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_delete_evidence",
      operation: "delete",
      createdAt: new Date(currentTime).toISOString(),
      mutation: {
        kind: "delete",
        resourceUid: RESOURCE_UID,
        address: ADDRESS,
        expectedRevision: "3",
        replayKey: "replay_op_delete_evidence",
        replay: { fingerprint: "fingerprint_op_delete_evidence", status: 204 },
        providerEffect: { effectId: "op_delete_evidence", kind: "delete" },
        deletionTombstone: { operationId: "op_delete_evidence" },
      },
    });

    const finalEvidence = await store.readResourceExecutionEvidence({
      tenantId: TENANT_ID,
      resourceUid: RESOURCE_UID,
      limit: 200,
    });
    expect(
      finalEvidence?.executionEvidence.commits.map(({ sequence, action }) => [sequence, action]),
    ).toEqual([
      [4, "delete"],
      [3, "update"],
      [2, "update"],
      [1, "create"],
    ]);
    const encoded = JSON.stringify(finalEvidence);
    expect(encoded).not.toContain("credential-must-never-appear");
    expect(encoded).not.toContain("second-secret-value");
    expect(encoded).not.toContain("third-secret-value");
    expect(await store.resourceByUid(TENANT_ID, RESOURCE_UID)).toBeNull();
    database.exec("DROP TRIGGER tf_resource_execution_evidence_durable_delete");
    database
      .query(
        "DELETE FROM tf_resource_execution_evidence WHERE tenant_id = ? AND resource_uid = ? AND sequence = 2",
      )
      .run(TENANT_ID, RESOURCE_UID);
    await expect(
      store.readResourceExecutionEvidence({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        limit: 200,
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    database.close();
  });

  test("accepts only an exact committed-operation replay and never rewrites its durable answer", async () => {
    const database = databaseWithEvidenceMigration();
    const now = Date.parse("2026-09-04T00:30:00.000Z");
    const createdAt = new Date(now).toISOString();
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    expect(
      await store.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        address: ADDRESS,
        formRef: FORM_REF,
      }),
    ).toBe(true);
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_exact_replay_create",
      operation: "create",
      createdAt,
      mutation: writeMutation(resource("1", "created"), null, "op_exact_replay_create"),
    });

    const operationId = "op_exact_replay_update";
    const committed = resource("2", "committed");
    const exactMutation = writeMutation(committed, "1", operationId);
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId,
      operation: "update",
      createdAt,
      mutation: exactMutation,
    });
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId,
      operation: "update",
      createdAt,
      mutation: exactMutation,
    });

    const operationBefore = database
      .query("SELECT * FROM tf_operations WHERE id = ?")
      .get(operationId);
    const replayBefore = database
      .query("SELECT * FROM tf_replays WHERE replay_key = ?")
      .get(exactMutation.replayKey);
    const evidenceBefore = database
      .query("SELECT * FROM tf_resource_execution_evidence WHERE operation_id = ?")
      .get(operationId);

    const mismatches = [
      {
        operation: "update" as const,
        mutation: writeMutation(resource("2", "FORGED"), "1", operationId),
      },
      {
        operation: "update" as const,
        mutation: {
          ...exactMutation,
          replay: { ...exactMutation.replay, fingerprint: "fingerprint_forged" },
        },
      },
      {
        operation: "update" as const,
        mutation: { ...exactMutation, replayKey: "replay_forged" },
      },
      { operation: "import" as const, mutation: exactMutation },
    ];
    for (const mismatch of mismatches) {
      await expect(
        store.commitImmediateMutation({
          tenantId: TENANT_ID,
          operationId,
          operation: mismatch.operation,
          createdAt,
          mutation: mismatch.mutation,
        }),
      ).rejects.toMatchObject({ code: "resource_busy" });
    }

    expect(database.query("SELECT * FROM tf_operations WHERE id = ?").get(operationId)).toEqual(
      operationBefore,
    );
    expect(
      database.query("SELECT * FROM tf_replays WHERE replay_key = ?").get(exactMutation.replayKey),
    ).toEqual(replayBefore);
    expect(
      database.query("SELECT * FROM tf_replays WHERE replay_key = 'replay_forged'").get(),
    ).toBe(null);
    expect(
      database
        .query("SELECT * FROM tf_resource_execution_evidence WHERE operation_id = ?")
        .get(operationId),
    ).toEqual(evidenceBefore);
    expect((await store.resourceByUid(TENANT_ID, RESOURCE_UID))?.resource.spec).toEqual({
      value: "committed",
    });
    database.close();
  });

  test("records a deferred commit and rolls evidence back when the Resource commit fails", async () => {
    const database = databaseWithEvidenceMigration();
    const now = Date.parse("2026-09-04T01:00:00.000Z");
    const store = createTakoformStore(createSqliteSql(database), () => new Date(now));
    const resourceUid = "uid_deferred_evidence";
    const deferredAddress = { ...ADDRESS, name: "deferred" };
    expect(
      await store.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid,
        address: deferredAddress,
        formRef: FORM_REF,
      }),
    ).toBe(true);
    const accepted = await store.acceptDeferredOperation({
      id: "op_deferred_evidence",
      tenantId: TENANT_ID,
      principalId: "principal_evidence",
      operation: "apply",
      phase: "pending",
      requestPath: "/resource",
      requestQuery: "",
      requestHeaders: {},
      requestBody: "{}",
      fingerprint: "fingerprint_deferred_evidence",
      replayKey: "replay_deferred_evidence",
      target: { ...deferredAddress, formRef: FORM_REF },
      resourceUid,
      pollsRemaining: 1,
      createdAt: new Date(now).toISOString(),
    });
    expect(accepted.phase).toBe("pending");
    const leaseToken = "lease_deferred_evidence";
    expect(
      await store.advanceDeferredOperation({
        tenantId: TENANT_ID,
        principalId: accepted.principalId,
        id: accepted.id,
        leaseToken,
        leaseUntil: now + 60_000,
      }),
    ).toMatchObject({ acquired: false, operation: { phase: "committing" } });
    const acquired = await store.advanceDeferredOperation({
      tenantId: TENANT_ID,
      principalId: accepted.principalId,
      id: accepted.id,
      leaseToken,
      leaseUntil: now + 60_000,
    });
    expect(acquired).toMatchObject({ acquired: true, operation: { phase: "committing" } });
    const operation = acquired.operation as DeferredOperationRecord;
    const wrongDeferredResource = resource(
      "1",
      "must-not-commit",
      "uid_wrong_deferred_evidence",
      "deferred",
    );
    await expect(
      store.commitDeferredMutation({
        operation,
        leaseToken,
        mutation: {
          ...writeMutation(wrongDeferredResource, null, operation.id),
          terminalJson: JSON.stringify({ done: true }),
        },
      }),
    ).rejects.toThrow("resource mutation identity mismatch");
    const deferredResource = resource("1", "deferred-private-value", resourceUid, "deferred");
    const deferredMutation = {
      ...writeMutation(deferredResource, null, operation.id),
      terminalJson: JSON.stringify({ done: true }),
    };
    await expect(
      store.commitDeferredMutation({
        operation: { ...operation, operation: "delete" },
        leaseToken,
        mutation: deferredMutation,
      }),
    ).rejects.toThrow("resource mutation operation mismatch");
    await store.commitDeferredMutation({
      operation,
      leaseToken,
      mutation: deferredMutation,
    });
    await store.commitDeferredMutation({ operation, leaseToken, mutation: deferredMutation });
    const deferredOperationBefore = database
      .query("SELECT * FROM tf_operations WHERE id = ?")
      .get(operation.id);
    const deferredReplayBefore = database
      .query("SELECT * FROM tf_replays WHERE replay_key = ?")
      .get(deferredMutation.replayKey);
    await expect(
      store.commitDeferredMutation({
        operation,
        leaseToken,
        mutation: {
          ...deferredMutation,
          replay: { ...deferredMutation.replay, fingerprint: "forged_deferred_fingerprint" },
        },
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(database.query("SELECT * FROM tf_operations WHERE id = ?").get(operation.id)).toEqual(
      deferredOperationBefore,
    );
    expect(
      database
        .query("SELECT * FROM tf_replays WHERE replay_key = ?")
        .get(deferredMutation.replayKey),
    ).toEqual(deferredReplayBefore);
    expect(
      (
        await store.readResourceExecutionEvidence({
          tenantId: TENANT_ID,
          resourceUid,
          limit: 10,
        })
      )?.executionEvidence.commits,
    ).toMatchObject([{ sequence: 1, operationId: operation.id, action: "create" }]);

    const collidedUid = "uid_collided_evidence";
    expect(
      await store.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid: collidedUid,
        address: deferredAddress,
        formRef: FORM_REF,
      }),
    ).toBe(true);
    const collided = resource("1", "must-rollback", collidedUid, "deferred");
    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_collided_evidence",
        operation: "create",
        createdAt: new Date(now).toISOString(),
        mutation: writeMutation(collided, null, "op_collided_evidence"),
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM tf_resource_execution_evidence WHERE resource_uid = ?",
        )
        .get(collidedUid),
    ).toEqual({ count: 0 });
    database.close();
  });

  test("fails closed before serving a high page when the first evidence row is missing", async () => {
    const database = databaseWithEvidenceMigration();
    let currentTime = Date.parse("2026-09-04T00:30:00.000Z");
    const store = createTakoformStore(createSqliteSql(database), () => new Date(currentTime));
    expect(
      await store.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        address: ADDRESS,
        formRef: FORM_REF,
      }),
    ).toBe(true);
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: "op_missing_first_create",
      operation: "create",
      createdAt: new Date(currentTime).toISOString(),
      mutation: writeMutation(resource("1", "private-create"), null, "op_missing_first_create"),
    });
    for (const revision of ["2", "3"] as const) {
      currentTime += 1_000;
      await store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: `op_missing_first_update_${revision}`,
        operation: "update",
        createdAt: new Date(currentTime).toISOString(),
        mutation: writeMutation(
          resource(revision, `private-update-${revision}`),
          String(Number(revision) - 1),
          `op_missing_first_update_${revision}`,
        ),
      });
    }
    database.exec("DROP TRIGGER tf_resource_execution_evidence_durable_delete");
    database
      .query(
        "DELETE FROM tf_resource_execution_evidence WHERE tenant_id = ? AND resource_uid = ? AND sequence = 1",
      )
      .run(TENANT_ID, RESOURCE_UID);

    await expect(
      store.readResourceExecutionEvidence({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    database.close();
  });

  test("binds evidence to the canonical tenant, address, FormRef, and Resource UID", async () => {
    const database = databaseWithEvidenceMigration();
    const store = createTakoformStore(createSqliteSql(database), () => new Date(0));
    const attestedUid = "uid_attested_identity";
    const attestedAddress = { ...ADDRESS, name: "attested" };
    expect(
      await store.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid: attestedUid,
        address: attestedAddress,
        formRef: FORM_REF,
      }),
    ).toBe(true);

    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_mismatched_operation_evidence",
        operation: "delete",
        createdAt: new Date(0).toISOString(),
        mutation: writeMutation(
          resource("1", "must-not-commit", attestedUid, attestedAddress.name),
          null,
          "op_mismatched_operation_evidence",
        ),
      }),
    ).rejects.toThrow("resource mutation operation mismatch");

    const mismatchedUid = resource("1", "must-not-commit", "uid_actual_identity", "actual");
    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_mismatched_uid_evidence",
        operation: "create",
        createdAt: new Date(0).toISOString(),
        mutation: {
          ...writeMutation(mismatchedUid, null, "op_mismatched_uid_evidence"),
          resourceUid: attestedUid,
        },
      }),
    ).rejects.toThrow("resource mutation identity mismatch");

    const mismatchedAddress = resource("1", "must-not-commit", attestedUid, "actual");
    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId: "op_mismatched_address_evidence",
        operation: "create",
        createdAt: new Date(0).toISOString(),
        mutation: writeMutation(mismatchedAddress, null, "op_mismatched_address_evidence"),
      }),
    ).rejects.toMatchObject({ code: "resource_busy" });

    expect(await store.resourceByUid(TENANT_ID, attestedUid)).toBeNull();
    expect(await store.resourceByUid(TENANT_ID, mismatchedUid.metadata.uid)).toBeNull();
    expect(
      await store.readResourceExecutionEvidence({
        tenantId: TENANT_ID,
        resourceUid: attestedUid,
        limit: 50,
      }),
    ).toMatchObject({ executionEvidence: { coverage: "partial", commits: [] } });
    database.close();
  });

  test("keeps the evidence proof in a separate D1-safe parameter budget", async () => {
    const captured: SqlStatement[][] = [];
    const stopped = new Error("batch captured");
    const sql: Sql = {
      async query() {
        throw new Error("unexpected query");
      },
      async run() {
        throw new Error("unexpected run");
      },
      async batch(statements) {
        captured.push([...statements]);
        throw stopped;
      },
    };
    const store = createTakoformStore(sql, () => new Date(0));
    const operationId = "o".repeat(128);
    const stored = resource("1", "value-free-budget");
    const receipt: TakoformDriverReceipt = {
      observed: {},
      outputs: {},
      deploymentMutation: {
        kind: "create",
        deployment: {
          tenantId: TENANT_ID,
          id: "dep_parameter_budget_evidence",
          resourceUid: RESOURCE_UID,
          offeringId: "offering_parameter_budget",
          providerPackRef: "provider_parameter_budget",
          providerInstallationRef: "installation_parameter_budget",
          nativeId: "native_parameter_budget",
          state: "active",
          observed: {},
          outputs: {},
        },
      },
    };
    await expect(
      store.commitImmediateMutation({
        tenantId: TENANT_ID,
        operationId,
        operation: "create",
        createdAt: new Date(0).toISOString(),
        mutation: {
          ...writeMutation(stored, null, operationId),
          providerReceipt: receipt,
          providerEffect: { effectId: operationId, kind: "apply" },
          claimKeys: Array.from({ length: 52 }, (_, index) => `claim_${index}`),
        },
      }),
    ).rejects.toBe(stopped);

    expect(captured).toHaveLength(1);
    const statements = captured[0] ?? [];
    expect(Math.max(...statements.map((statement) => statement.params?.length ?? 0))).toBeLessThan(
      101,
    );
    const guards = statements.filter((statement) =>
      statement.sql.startsWith("INSERT INTO tf_operation_commit_guards"),
    );
    expect(guards).toHaveLength(2);
    expect(new Set(guards.map((statement) => statement.params?.[0])).size).toBe(2);
    expect(
      guards.find((statement) => statement.sql.includes("tf_resource_execution_evidence"))?.params
        ?.length,
    ).toBeLessThan(100);
  });

  test("the migration enforces append-only contiguous and terminal evidence", async () => {
    const database = databaseWithEvidenceMigration();
    const store = createTakoformStore(createSqliteSql(database), () => new Date(0));
    expect(
      await store.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        address: ADDRESS,
        formRef: FORM_REF,
      }),
    ).toBe(true);
    const insert = database.query(
      `INSERT INTO tf_resource_execution_evidence
         (tenant_id, resource_uid, operation_id, sequence, action,
          resource_generation, resource_revision, committed_at)
       VALUES (?, ?, ?, ?, ?, '1', ?, 0)`,
    );
    database
      .query(
        `INSERT INTO tf_operations
           (id, tenant_id, operation, state, resource_json, created_at, expires_at)
         VALUES ('op_raw_claimed', ?, 'create', 'succeeded', NULL,
                 '2026-09-04T00:00:00.000Z', 1)`,
      )
      .run(TENANT_ID);
    expect(() => insert.run(TENANT_ID, RESOURCE_UID, "op_raw_claimed", 1, "create", "1")).toThrow(
      "resource_execution_evidence_operation_claimed",
    );
    insert.run(TENANT_ID, RESOURCE_UID, "op_raw_create", 1, "create", "1");
    expect(() =>
      database.query("UPDATE tf_resource_execution_evidence SET action = 'update'").run(),
    ).toThrow("resource_execution_evidence_immutable");
    expect(() => database.query("DELETE FROM tf_resource_execution_evidence").run()).toThrow(
      "resource_execution_evidence_durable",
    );
    expect(() => insert.run(TENANT_ID, RESOURCE_UID, "op_raw_gap", 3, "update", "2")).toThrow(
      "resource_execution_evidence_noncontiguous",
    );
    expect(() =>
      insert.run(TENANT_ID, RESOURCE_UID, "op_raw_second_create", 2, "create", "2"),
    ).toThrow("resource_execution_evidence_create_not_first");
    insert.run(TENANT_ID, RESOURCE_UID, "op_raw_delete", 2, "delete", "1");
    expect(() =>
      insert.run(TENANT_ID, RESOURCE_UID, "op_raw_after_delete", 3, "update", "3"),
    ).toThrow("resource_execution_evidence_deleted");
    database.close();
  });

  test("returns legacy partial coverage and authenticates before Resource existence", async () => {
    const database = databaseWithEvidenceMigration();
    const legacyStore = createTakoformStore(createSqliteSql(database), () => new Date(0));
    expect(
      await legacyStore.reserveResourceIncarnation({
        tenantId: TENANT_ID,
        resourceUid: RESOURCE_UID,
        address: ADDRESS,
        formRef: FORM_REF,
      }),
    ).toBe(true);
    const evidence = await legacyStore.readResourceExecutionEvidence({
      tenantId: TENANT_ID,
      resourceUid: RESOURCE_UID,
      limit: 50,
    });
    expect(evidence).toEqual({
      executionEvidence: {
        format: RESOURCE_EXECUTION_EVIDENCE_FORMAT,
        organizationId: TENANT_ID,
        resource: {
          uid: RESOURCE_UID,
          address: {
            space: ADDRESS.space,
            apiVersion: ADDRESS.apiVersion,
            kind: ADDRESS.kind,
            name: ADDRESS.name,
          },
          formRef: FORM_REF,
        },
        coverage: "partial" as const,
        snapshotFence: 0,
        commits: [],
      },
    });
    if (!evidence) throw new TypeError("legacy evidence was not returned");
    let reads = 0;
    let available = true;
    const inventory: ResourceInventory = {
      async listResources() {
        return { resources: [], cursor: null };
      },
      async resourceByUid() {
        return null;
      },
      async readResourceExecutionEvidence(input) {
        reads += 1;
        expect(input).toEqual({
          tenantId: TENANT_ID,
          resourceUid: RESOURCE_UID,
          limit: 50,
        });
        return available ? evidence : null;
      },
      async listOperations() {
        return [];
      },
    };
    const accounts = {
      async authenticate(authorization: string | null) {
        if (authorization !== "Bearer reader") return null;
        return {
          hostPrincipalId: "host_principal_evidence",
          principalId: "principal_evidence",
          organizationId: TENANT_ID,
          scopes: ["resources:read"],
          kind: "api_key",
        } as const;
      },
    } as Pick<Accounts, "authenticate"> as Accounts;
    const route = createControlRoutes({
      accounts,
      inventory,
      deployments: {} as never,
      attachments: {} as never,
      migrations: {} as never,
      forms: [],
      identityProviders: [],
      ledger: {} as never,
      catalog: {} as never,
      reseller: {} as never,
      tokens: {} as never,
      settlement: {} as never,
      clock: () => new Date("2026-09-04T00:00:00.000Z"),
    });
    const url = new URL(
      `https://api.takoserver.test/v1/organizations/${TENANT_ID}/resources/${RESOURCE_UID}/execution-evidence`,
    );
    const unauthenticated = await route(new Request(url), url);
    expect(unauthenticated?.status).toBe(401);
    expect(unauthenticated?.headers.get("cache-control")).toBe("private, no-store");
    expect(unauthenticated?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reads).toBe(0);

    const unknownQuery = new URL(url);
    unknownQuery.searchParams.set("providerReceipt", "leak");
    const invalid = await route(
      new Request(unknownQuery, { headers: { authorization: "Bearer reader" } }),
      unknownQuery,
    );
    expect(invalid?.status).toBe(400);
    expect(reads).toBe(0);

    for (const query of ["limit=1e2", "limit=1&limit=2", "cursor=one&cursor=two"]) {
      const malformed = new URL(url);
      malformed.search = query;
      const refused = await route(
        new Request(malformed, { headers: { authorization: "Bearer reader" } }),
        malformed,
      );
      expect(refused?.status).toBe(400);
      expect(refused?.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(reads).toBe(0);

    const response = await route(
      new Request(url, { headers: { authorization: "Bearer reader" } }),
      url,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response?.json()).toEqual(evidence);
    expect(reads).toBe(1);

    available = false;
    const missing = await route(
      new Request(url, { headers: { authorization: "Bearer reader" } }),
      url,
    );
    expect(missing?.status).toBe(404);
    expect(missing?.headers.get("cache-control")).toBe("private, no-store");
    expect(missing?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reads).toBe(2);
    database.close();
  });
});
