import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectApplyQualifiedMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
} from "../scripts/deploy/schema.ts";
import { MIGRATIONS } from "../src/db-schema.ts";

const PREDECESSOR = "0068_cloudflare_provider_invocation_custody.sql";
const MIGRATION_NAME = "0069_cloudflare_provider_invocation_delete_ack.sql";
const INVOCATIONS = "tf_cloudflare_provider_invocations";
const RECEIPTS = "cloudflare_managed_worker_receipts";
const DELETE_PROOF_SCHEMA = "takoserver.cloudflare-managed-worker-version-delete-proof@v1";
const HOST_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const INTENT_DIGEST = `sha256:${"b".repeat(64)}`;
const DESCRIPTOR_DIGEST = `sha256:${"c".repeat(64)}`;

function migrationSql(): string {
  const migration = MIGRATIONS.find(({ name }) => name === MIGRATION_NAME);
  if (!migration) throw new Error(`migration ${MIGRATION_NAME} is missing`);
  return migration.sql;
}

function applyBeforeDeleteAck(database: Database): void {
  for (const migration of MIGRATIONS) {
    database.exec(migration.sql);
    if (migration.name === PREDECESSOR) return;
  }
  throw new Error(`migration ${PREDECESSOR} is missing`);
}

function openEpoch(database: Database): void {
  database
    .query(
      `UPDATE tf_cloudflare_provider_invocation_epoch
       SET epoch_id = 'epoch-delete-test', state = 'open', opened_at_ms = 50
       WHERE singleton = 1`,
    )
    .run();
}

function insertVersionReceipt(
  database: Database,
  input: {
    readonly providerId: string;
    readonly resourceUid: string;
    readonly operationId: string;
    readonly nativeId: string;
    readonly logicalWorkerId: string;
    readonly providerEtag?: string;
    readonly descriptorDigest?: string;
    readonly state?: "committed" | "deleted";
    readonly observedJson?: string;
  },
): void {
  database
    .query(
      `INSERT INTO ${RECEIPTS} (
        provider_id, resource_uid, native_id, kind, logical_worker_id, operation_id,
        generation, descriptor_digest, state, provider_etag, observed_json
      ) VALUES (?, ?, ?, 'version', ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      input.providerId,
      input.resourceUid,
      input.nativeId,
      input.logicalWorkerId,
      input.operationId,
      input.descriptorDigest ?? DESCRIPTOR_DIGEST,
      input.state ?? "committed",
      input.state === "deleted" ? null : (input.providerEtag ?? '"prior-etag"'),
      input.observedJson ?? "{}",
    );
}

function insertExecutorDeleteClaim(
  database: Database,
  input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly hostFingerprint?: string;
    readonly intentDigest?: string;
  },
): void {
  database
    .query(
      `INSERT INTO tf_cloudflare_provider_executor_operations (
        operation_id, tenant_id, resource_uid, host_fingerprint, mutation_kind,
        logical_intent_digest, created_at
      ) VALUES (?, ?, ?, ?, 'delete', ?, 90)`,
    )
    .run(
      input.operationId,
      input.tenantId,
      input.resourceUid,
      input.hostFingerprint ?? HOST_FINGERPRINT,
      input.intentDigest ?? INTENT_DIGEST,
    );
}

function insertDeleteInvocation(
  database: Database,
  input: {
    readonly invocationId: string;
    readonly operationId: string;
    readonly providerId: string;
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly nativeId: string;
    readonly logicalWorkerId: string;
    readonly priorOperationId: string;
    readonly priorEtag?: string;
    readonly priorDigest?: string;
    readonly hostFingerprint?: string;
    readonly intentDigest?: string;
  },
): void {
  database
    .query(
      `INSERT INTO ${INVOCATIONS} (
        invocation_id, epoch_id, provider_id, installation_id, method, operation_id,
        tenant_id, resource_uid, host_fingerprint, execution_lease_token,
        logical_intent_digest, created_at_ms, delete_native_id,
        prior_release_operation_id, prior_descriptor_digest, prior_provider_etag
      ) VALUES (?, 'epoch-delete-test', ?, 'installation-delete-test', 'delete', ?, ?, ?, ?,
        'lease-delete-test', ?, 100, ?, ?, ?, ?)`,
    )
    .run(
      input.invocationId,
      input.providerId,
      input.operationId,
      input.tenantId,
      input.resourceUid,
      input.hostFingerprint ?? HOST_FINGERPRINT,
      input.intentDigest ?? INTENT_DIGEST,
      input.nativeId,
      input.priorOperationId,
      input.priorDigest ?? DESCRIPTOR_DIGEST,
      input.priorEtag ?? '"prior-etag"',
    );
}

function deleteProof(input: {
  readonly deleteOperationId: string;
  readonly priorOperationId: string;
  readonly nativeId: string;
  readonly scriptName: string;
  readonly schema?: string;
  readonly priorDigest?: string;
  readonly priorEtag?: string;
  readonly status?: number;
  readonly postDeleteAbsent?: boolean;
}): string {
  return JSON.stringify({
    deleted: true,
    workerVersionDeleteProof: {
      schema: input.schema ?? DELETE_PROOF_SCHEMA,
      deleteOperationId: input.deleteOperationId,
      priorReleaseOperationId: input.priorOperationId,
      nativeId: input.nativeId,
      scriptName: input.scriptName,
      priorDescriptorDigest: input.priorDigest ?? DESCRIPTOR_DIGEST,
      priorProviderEtag: input.priorEtag ?? '"prior-etag"',
      nativeDeleteStatus: input.status ?? 200,
      postDeleteAbsent: input.postDeleteAbsent ?? true,
    },
  });
}

function markDeleteReceiptDeleted(
  database: Database,
  input: {
    readonly providerId: string;
    readonly resourceUid: string;
    readonly operationId: string;
    readonly observedJson: string;
  },
): void {
  database
    .query(
      `UPDATE ${RECEIPTS}
       SET operation_id = ?, state = 'deleted', provider_etag = NULL,
           previous_json = NULL, observed_json = ?
       WHERE provider_id = ? AND resource_uid = ?`,
    )
    .run(input.operationId, input.observedJson, input.providerId, input.resourceUid);
}

function startDeleteEffect(database: Database, invocationId: string): void {
  database
    .query(
      `UPDATE ${INVOCATIONS}
       SET phase = 'effect_started', effect_started_at_ms = 110
       WHERE invocation_id = ?`,
    )
    .run(invocationId);
}

function terminalizeDelete(database: Database, invocationId: string): void {
  database
    .query(
      `UPDATE ${INVOCATIONS}
       SET phase = 'terminal', terminal_at_ms = 120,
           terminal_proof = 'version_delete_acknowledged'
       WHERE invocation_id = ?`,
    )
    .run(invocationId);
}

function seedLegacyInvocation(
  database: Database,
  input: {
    readonly invocationId: string;
    readonly method?: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly phase: "admitted" | "effect_started" | "terminal";
    readonly terminalProof?: "pre_effect_refusal" | "version_receipt_committed";
  },
): void {
  database
    .query(
      `INSERT INTO ${INVOCATIONS} (
        invocation_id, epoch_id, provider_id, installation_id, method, operation_id,
        tenant_id, resource_uid, host_fingerprint, execution_lease_token,
        logical_intent_digest, created_at_ms, phase, effect_started_at_ms,
        terminal_at_ms, terminal_proof
      ) VALUES (?, 'epoch-delete-test', 'provider-legacy', 'installation-legacy', ?, ?,
        'tenant-legacy', ?, ?, 'lease-legacy', ?, 100, 'admitted', NULL, NULL, NULL)`,
    )
    .run(
      input.invocationId,
      input.method ?? "applyWithExecutionContextV1",
      input.operationId,
      input.resourceUid,
      HOST_FINGERPRINT,
      INTENT_DIGEST,
    );
  if (input.phase === "effect_started") {
    database
      .query(
        `UPDATE ${INVOCATIONS}
         SET phase = 'effect_started', effect_started_at_ms = 110
         WHERE invocation_id = ?`,
      )
      .run(input.invocationId);
  } else if (input.phase === "terminal") {
    if (input.terminalProof === undefined) {
      throw new Error("terminal legacy invocation requires a proof");
    }
    if (input.terminalProof === "version_receipt_committed") {
      database
        .query(
          `UPDATE ${INVOCATIONS}
           SET phase = 'effect_started', effect_started_at_ms = 110
           WHERE invocation_id = ?`,
        )
        .run(input.invocationId);
    }
    database
      .query(
        `UPDATE ${INVOCATIONS}
         SET phase = 'terminal', terminal_at_ms = 120, terminal_proof = ?
         WHERE invocation_id = ?`,
      )
      .run(input.terminalProof, input.invocationId);
  }
}

test("0069 is source inventory only and leaves the 0066 apply ceiling unchanged", () => {
  const source = readCurrentAuditedMigrationSourceArtifact();
  expect(source.names).toHaveLength(78);
  expect(source.names.at(-11)).toBe(PREDECESSOR);
  expect(source.names.at(-10)).toBe(MIGRATION_NAME);
  expect(source.names.at(-9)).toBe("0070_takoform_v2.sql");
  expect(source.names.at(-8)).toBe("0071_v2_sqlite_migration_set_custody.sql");
  expect(source.names.at(-7)).toBe("0072_v2_artifact_custody.sql");
  expect(source.names.at(-6)).toBe("0073_v2_reference_acceptance.sql");
  expect(source.names.at(-5)).toBe("0074_v2_worker_native_effects.sql");
  expect(source.names.at(-4)).toBe("0075_v2_artifact_progress.sql");
  expect(source.names.at(-3)).toBe("0076_v2_worker_invocation_custody.sql");
  expect(source.names.at(-2)).toBe("0077_v2_operation_acceptance_order.sql");
  expect(source.names.at(-1)).toBe("0078_v2_worker_invocation_retirement.sql");
  const qualified = projectApplyQualifiedMigrationArtifact(source);
  expect(qualified.names).toHaveLength(66);
  expect(qualified.names.at(-1)).toBe("0066_cloudflare_managed_actor_kv_capability_claims.sql");

  const root = mkdtempSync(join(tmpdir(), "takoserver-invocation-delete-ack-tail-"));
  try {
    const migrations = join(root, "migrations");
    mkdirSync(migrations);
    for (const file of source.files) copyFileSync(file.path, join(migrations, file.name));
    const tail = source.files.at(-1);
    if (!tail) throw new Error("audited source is missing its terminal migration");
    copyFileSync(tail.path, join(migrations, "0079_unreviewed.sql"));
    expect(() => readCurrentAuditedMigrationSourceArtifact(migrations)).toThrow(
      "audited migration lineage must contain exactly 0001-0078",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0069 conserves every 0068 invocation row and its existing schema guards", () => {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  try {
    applyBeforeDeleteAck(database);
    openEpoch(database);
    insertVersionReceipt(database, {
      providerId: "provider-legacy",
      resourceUid: "legacy-committed-resource",
      operationId: "legacy-committed-operation",
      nativeId: "version:legacy-worker:legacy-script",
      logicalWorkerId: "legacy-worker",
    });
    insertVersionReceipt(database, {
      providerId: "provider-legacy",
      resourceUid: "legacy-effect-resource",
      operationId: "legacy-effect-operation",
      nativeId: "version:legacy-worker:effect-script",
      logicalWorkerId: "legacy-worker",
    });
    seedLegacyInvocation(database, {
      invocationId: "legacy-admitted",
      operationId: "legacy-admitted-operation",
      resourceUid: "legacy-admitted-resource",
      phase: "admitted",
    });
    seedLegacyInvocation(database, {
      invocationId: "legacy-effect-started",
      operationId: "legacy-effect-operation",
      resourceUid: "legacy-effect-resource",
      phase: "effect_started",
    });
    seedLegacyInvocation(database, {
      invocationId: "legacy-refused",
      operationId: "legacy-refused-operation",
      resourceUid: "legacy-refused-resource",
      phase: "terminal",
      terminalProof: "pre_effect_refusal",
    });
    seedLegacyInvocation(database, {
      invocationId: "legacy-refusal-candidate",
      operationId: "legacy-refusal-candidate-operation",
      resourceUid: "legacy-refusal-candidate-resource",
      phase: "admitted",
    });
    seedLegacyInvocation(database, {
      invocationId: "legacy-version-committed",
      operationId: "legacy-committed-operation",
      resourceUid: "legacy-committed-resource",
      phase: "terminal",
      terminalProof: "version_receipt_committed",
    });
    seedLegacyInvocation(database, {
      invocationId: "legacy-uninstrumented-delete",
      method: "delete",
      operationId: "legacy-delete-operation",
      resourceUid: "legacy-delete-resource",
      phase: "admitted",
    });

    const legacyColumnProjection =
      "invocation_id, epoch_id, provider_id, installation_id, method, operation_id, " +
      "tenant_id, resource_uid, host_fingerprint, execution_lease_token, " +
      "logical_intent_digest, created_at_ms, phase, effect_started_at_ms, " +
      "terminal_at_ms, terminal_proof";
    const rowsBefore = database
      .query(`SELECT ${legacyColumnProjection} FROM ${INVOCATIONS} ORDER BY invocation_id`)
      .all();
    const epochSqlBefore = database
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
          "WHERE tbl_name = 'tf_cloudflare_provider_invocation_epoch' ORDER BY type, name",
      )
      .all();
    const guardNamesBefore = database
      .query(
        `SELECT name FROM sqlite_schema
         WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
      )
      .all(INVOCATIONS)
      .map((row) => (row as { name: string }).name);
    const indexRowsBefore = database
      .query(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'index' AND tbl_name = ?
           AND name = 'tf_cloudflare_provider_invocations_epoch_phase' ORDER BY name`,
      )
      .all(INVOCATIONS);

    database.exec(migrationSql());

    expect(
      database
        .query(`SELECT ${legacyColumnProjection} FROM ${INVOCATIONS} ORDER BY invocation_id`)
        .all(),
    ).toEqual(rowsBefore);
    expect(
      database
        .query(
          `SELECT count(*) AS count FROM ${INVOCATIONS}
           WHERE delete_native_id IS NOT NULL OR prior_release_operation_id IS NOT NULL OR
             prior_descriptor_digest IS NOT NULL OR prior_provider_etag IS NOT NULL`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .query(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
            "WHERE tbl_name = 'tf_cloudflare_provider_invocation_epoch' ORDER BY type, name",
        )
        .all(),
    ).toEqual(epochSqlBefore);
    const guardNamesAfter = database
      .query(
        `SELECT name FROM sqlite_schema
         WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
      )
      .all(INVOCATIONS)
      .map((row) => (row as { name: string }).name);
    for (const name of guardNamesBefore) expect(guardNamesAfter).toContain(name);
    expect(
      database
        .query(
          `SELECT name, sql FROM sqlite_schema
           WHERE type = 'index' AND tbl_name = ? AND name = ? ORDER BY name`,
        )
        .all(INVOCATIONS, "tf_cloudflare_provider_invocations_epoch_phase"),
    ).toEqual(indexRowsBefore);
    expect(database.query(`PRAGMA foreign_key_list(${INVOCATIONS})`).all()).toEqual([]);
    expect(
      database
        .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%forward_0069%'")
        .all(),
    ).toEqual([]);

    database
      .query(
        `UPDATE ${INVOCATIONS}
         SET phase = 'terminal', terminal_at_ms = 120,
             terminal_proof = 'version_receipt_committed'
         WHERE invocation_id = 'legacy-effect-started'`,
      )
      .run();
    database
      .query(
        `UPDATE ${INVOCATIONS}
         SET phase = 'terminal', terminal_at_ms = 120,
             terminal_proof = 'pre_effect_refusal'
         WHERE invocation_id = 'legacy-refusal-candidate'`,
      )
      .run();

    expect(() =>
      database.exec(
        `UPDATE ${INVOCATIONS} SET operation_id = 'rewritten'
         WHERE invocation_id = 'legacy-admitted'`,
      ),
    ).toThrow();
    expect(() =>
      database.exec(`DELETE FROM ${INVOCATIONS} WHERE invocation_id = 'legacy-admitted'`),
    ).toThrow();
    expect(() =>
      database.exec(
        `UPDATE ${INVOCATIONS} SET phase = 'admitted', effect_started_at_ms = NULL
         WHERE invocation_id = 'legacy-effect-started'`,
      ),
    ).toThrow();

    database
      .query(
        `UPDATE tf_cloudflare_provider_invocation_epoch
         SET state = 'closed', closed_at_ms = 150 WHERE singleton = 1`,
      )
      .run();
    expect(() =>
      seedLegacyInvocation(database, {
        invocationId: "closed-epoch-refusal",
        operationId: "closed-epoch-operation",
        resourceUid: "closed-epoch-resource",
        phase: "admitted",
      }),
    ).toThrow(/cloudflare_provider_invocation_epoch_not_open/u);
  } finally {
    database.close();
  }
});

test("0069 admits only receipt-backed delete rows and terminalizes only exact 200/204 ACK proof", () => {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  try {
    applyBeforeDeleteAck(database);
    openEpoch(database);
    database.exec(migrationSql());

    const identity = {
      providerId: "provider-delete",
      tenantId: "tenant-delete",
      resourceUid: "resource-delete",
      operationId: "operation-delete",
      nativeId: "version:worker-delete:script-delete",
      logicalWorkerId: "worker-delete",
      priorOperationId: "operation-release",
    };
    insertVersionReceipt(database, {
      providerId: identity.providerId,
      resourceUid: identity.resourceUid,
      operationId: identity.priorOperationId,
      nativeId: identity.nativeId,
      logicalWorkerId: identity.logicalWorkerId,
    });
    expect(() =>
      insertDeleteInvocation(database, { invocationId: "missing-claim", ...identity }),
    ).toThrow();

    const markedIdentity = {
      ...identity,
      providerId: "provider-marked-delete",
      resourceUid: "resource-marked-delete",
      operationId: "operation-marked-delete",
      nativeId: "version:worker-delete:marked-script",
      priorOperationId: "operation-marked-release",
    };
    insertVersionReceipt(database, {
      providerId: markedIdentity.providerId,
      resourceUid: markedIdentity.resourceUid,
      operationId: markedIdentity.priorOperationId,
      nativeId: markedIdentity.nativeId,
      logicalWorkerId: markedIdentity.logicalWorkerId,
      observedJson: JSON.stringify({ executionMaterial: null }),
    });
    insertExecutorDeleteClaim(database, markedIdentity);
    expect(() =>
      insertDeleteInvocation(database, {
        invocationId: "marked-delete-refused",
        ...markedIdentity,
      }),
    ).toThrow(/cloudflare_provider_delete_invocation_admission_invalid/u);

    const missingReceiptClaim = {
      ...identity,
      operationId: "operation-without-prior-receipt",
      resourceUid: "resource-without-prior-receipt",
    };
    database.exec("BEGIN IMMEDIATE");
    insertExecutorDeleteClaim(database, missingReceiptClaim);
    expect(() =>
      insertDeleteInvocation(database, {
        invocationId: "invocation-without-prior-receipt",
        ...missingReceiptClaim,
      }),
    ).toThrow(/cloudflare_provider_delete_invocation_admission_invalid/u);
    database.exec("ROLLBACK");
    expect(
      database
        .query(
          `SELECT count(*) AS count FROM tf_cloudflare_provider_executor_operations
           WHERE operation_id = 'operation-without-prior-receipt'`,
        )
        .get(),
    ).toEqual({ count: 0 });

    insertExecutorDeleteClaim(database, identity);
    expect(() =>
      insertDeleteInvocation(database, {
        invocationId: "wrong-prior-closure",
        ...identity,
        priorOperationId: "forged-prior-operation",
      }),
    ).toThrow(/cloudflare_provider_delete_invocation_admission_invalid/u);
    expect(() =>
      insertDeleteInvocation(database, {
        invocationId: "wrong-prior-etag",
        ...identity,
        priorEtag: '"other-etag"',
      }),
    ).toThrow(/cloudflare_provider_delete_invocation_admission_invalid/u);
    expect(() =>
      insertDeleteInvocation(database, {
        invocationId: "wrong-native-id",
        ...identity,
        nativeId: "version:worker-delete:other-script",
      }),
    ).toThrow(/cloudflare_provider_delete_invocation_admission_invalid/u);
    insertDeleteInvocation(database, { invocationId: "delete-invocation", ...identity });
    expect(() =>
      database.exec(
        `UPDATE ${INVOCATIONS}
         SET prior_provider_etag = 'rewritten-etag'
         WHERE invocation_id = 'delete-invocation'`,
      ),
    ).toThrow();
    startDeleteEffect(database, "delete-invocation");

    const invalidProofs = [
      deleteProof({
        ...identity,
        deleteOperationId: "operation-invalid-0",
        nativeId: "version:worker-delete:invalid-script-0",
        scriptName: "invalid-script-0",
        status: 202,
      }),
      deleteProof({
        ...identity,
        deleteOperationId: "operation-invalid-1",
        nativeId: "version:worker-delete:invalid-script-1",
        scriptName: "invalid-script-1",
        status: 404,
      }),
      deleteProof({
        ...identity,
        deleteOperationId: "operation-invalid-2",
        nativeId: "version:worker-delete:invalid-script-2",
        scriptName: "invalid-script-2",
        postDeleteAbsent: false,
      }),
      deleteProof({
        ...identity,
        deleteOperationId: "operation-invalid-3",
        nativeId: "version:worker-delete:invalid-script-3",
        priorOperationId: "forged-prior-operation",
        scriptName: "invalid-script-3",
      }),
      deleteProof({
        ...identity,
        deleteOperationId: "operation-invalid-4",
        nativeId: "version:worker-delete:forged-script",
        scriptName: "invalid-script-4",
      }),
      deleteProof({
        ...identity,
        deleteOperationId: "forged-delete-operation",
        nativeId: "version:worker-delete:invalid-script-5",
        scriptName: "invalid-script-5",
      }),
      deleteProof({
        ...identity,
        deleteOperationId: "operation-invalid-6",
        nativeId: "version:worker-delete:invalid-script-6",
        scriptName: "invalid-script-6",
        priorDigest: `sha256:${"d".repeat(64)}`,
      }),
      deleteProof({
        ...identity,
        deleteOperationId: "operation-invalid-7",
        nativeId: "version:worker-delete:invalid-script-7",
        scriptName: "invalid-script-7",
        priorEtag: '"other-etag"',
      }),
      deleteProof({
        ...identity,
        deleteOperationId: "operation-invalid-8",
        nativeId: "version:worker-delete:invalid-script-8",
        scriptName: "invalid-script-8",
        schema: "takoserver.cloudflare-managed-worker-version-delete-proof@v0",
      }),
      JSON.stringify({ deleted: true }),
    ];
    for (const [index, proof] of invalidProofs.entries()) {
      const resourceUid = `resource-invalid-${index}`;
      const operationId = `operation-invalid-${index}`;
      const invalidInvocationId = `invalid-invocation-${index}`;
      const priorOperationId = "operation-release-invalid";
      insertVersionReceipt(database, {
        providerId: identity.providerId,
        resourceUid,
        operationId: priorOperationId,
        nativeId: `version:${identity.logicalWorkerId}:invalid-script-${index}`,
        logicalWorkerId: identity.logicalWorkerId,
      });
      insertExecutorDeleteClaim(database, {
        ...identity,
        operationId,
        resourceUid,
      });
      insertDeleteInvocation(database, {
        invocationId: invalidInvocationId,
        ...identity,
        operationId,
        resourceUid,
        nativeId: `version:${identity.logicalWorkerId}:invalid-script-${index}`,
        priorOperationId,
      });
      startDeleteEffect(database, invalidInvocationId);
      markDeleteReceiptDeleted(database, {
        providerId: identity.providerId,
        resourceUid,
        operationId,
        observedJson: proof,
      });
      expect(() => terminalizeDelete(database, invalidInvocationId)).toThrow();
    }

    markDeleteReceiptDeleted(database, {
      providerId: identity.providerId,
      resourceUid: identity.resourceUid,
      operationId: identity.operationId,
      observedJson: deleteProof({
        ...identity,
        deleteOperationId: identity.operationId,
        scriptName: "script-delete",
        status: 204,
      }),
    });
    terminalizeDelete(database, "delete-invocation");
    expect(
      database
        .query(`SELECT phase, terminal_proof FROM ${INVOCATIONS} WHERE invocation_id = ?`)
        .get("delete-invocation"),
    ).toEqual({ phase: "terminal", terminal_proof: "version_delete_acknowledged" });
  } finally {
    database.close();
  }
});

test("0069 shadow-copy failure rolls back to the exact 0068 table and rows in SQLite", () => {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  try {
    applyBeforeDeleteAck(database);
    openEpoch(database);
    seedLegacyInvocation(database, {
      invocationId: "rollback-preserved-row",
      operationId: "rollback-preserved-operation",
      resourceUid: "rollback-preserved-resource",
      phase: "effect_started",
    });

    const tableSqlBefore = database
      .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(INVOCATIONS) as { sql: string };
    const rowsBefore = database.query(`SELECT * FROM ${INVOCATIONS} ORDER BY invocation_id`).all();
    const schemaBefore = database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema " +
          "WHERE tbl_name = ? AND type IN ('index', 'trigger') ORDER BY type, name",
      )
      .all(INVOCATIONS);

    database.exec("BEGIN IMMEDIATE");
    expect(() =>
      database.exec(`${migrationSql()}\nINSERT INTO __injected_0069_failure__ VALUES (1);`),
    ).toThrow();
    database.exec("ROLLBACK");

    expect(
      database
        .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(INVOCATIONS),
    ).toEqual(tableSqlBefore);
    expect(database.query(`SELECT * FROM ${INVOCATIONS} ORDER BY invocation_id`).all()).toEqual(
      rowsBefore,
    );
    expect(
      database
        .query(
          "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema " +
            "WHERE tbl_name = ? AND type IN ('index', 'trigger') ORDER BY type, name",
        )
        .all(INVOCATIONS),
    ).toEqual(schemaBefore);
    expect(
      database
        .query(
          "SELECT name FROM sqlite_schema " +
            "WHERE name = 'tf_cloudflare_provider_invocations_forward_0069'",
        )
        .all(),
    ).toEqual([]);
  } finally {
    database.close();
  }
});
