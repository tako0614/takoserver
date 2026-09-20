import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { resourceDependencyClaimRange } from "../src/takoform/dependency-fence.ts";
import {
  createTakoformStore,
  LEGACY_OPERATION_GENERATION_CONFLICT,
  type ProviderMutationSaga,
} from "../src/takoform/store.ts";
import type { TakoformV1Alpha3FormRef } from "../src/takoform/types.ts";

const OPERATION_GENERATION_MIGRATION = "0060_takoform_operation_generation.sql";
const ACCEPTED_AUTHORITY_MIGRATION = "0061_takoform_accepted_authority_continuity.sql";
const generationIndex = MIGRATIONS.findIndex(({ name }) => name === OPERATION_GENERATION_MIGRATION);
if (generationIndex < 0) throw new Error("operation generation migration is missing");
const generationMigration = MIGRATIONS[generationIndex];
if (!generationMigration) throw new Error("operation generation migration is missing");
const generationSql = generationMigration.sql;
const acceptedAuthorityMigration = MIGRATIONS.find(
  ({ name }) => name === ACCEPTED_AUTHORITY_MIGRATION,
);
if (!acceptedAuthorityMigration) throw new Error("accepted authority migration is missing");
const acceptedAuthoritySql = acceptedAuthorityMigration.sql;

// These are the pinned legacy statement projections from both
// 3b9a4e3036d943c6167d5e16f8eb04df04aa6985 and runtime 532 at 1d3d126; the
// two revisions have the same SQL semantics here. Keeping the corpus proves
// the compatibility triggers against the released columns rather than a
// synthetic reduced INSERT.
const LEGACY_SAGA_INSERT = `INSERT OR IGNORE INTO tf_provider_mutation_sagas
   (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
    target_space, target_api_version, target_kind, target_name,
    accepted_uid, accepted_generation, accepted_revision, phase,
    receipt_json, authority_head_digest, created_at, updated_at, expires_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, ?, ?, ?)`;

const LEGACY_DEFERRED_INSERT = `INSERT OR IGNORE INTO tf_deferred_operations
   (id, tenant_id, principal_id, operation, phase, request_path, request_query,
    request_headers_json, request_body_json, fingerprint, replay_key,
    target_space, target_api_version, target_kind, target_name,
    target_form_ref_json, accepted_uid, accepted_generation, accepted_revision,
    resource_uid, worker_endpoint_origin_reservation_id, polls_remaining,
    lease_token, lease_until, terminal_json,
    committed_uid, created_at, updated_at, expires_at)
 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         NULL, NULL, NULL, NULL, ?, ?, ?)`;

const LEGACY_RESOURCE_EFFECT_INSERT = `INSERT OR IGNORE INTO tf_resource_provider_effects
   (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
    operation_mode, provider_pack_ref, provider_installation_ref,
    native_id, target_json, created_at)
 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
 WHERE EXISTS (
   SELECT 1 FROM tf_resource_deletion_attestations
   WHERE tenant_id = ? AND resource_uid = ? AND state IN ('live', 'pending')
 )`;

const FORM_REF: TakoformV1Alpha3FormRef = {
  apiVersion: "generation.forms.invalid",
  kind: "GenerationThing",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};

function applyBeforeGeneration(database: Database): void {
  for (const migration of MIGRATIONS.slice(0, generationIndex)) database.exec(migration.sql);
}

function applyGeneration(database: Database): void {
  database.exec(generationSql);
}

function applyCurrentGeneration(database: Database): void {
  applyGeneration(database);
  database.exec(acceptedAuthoritySql);
}

function insertLegacySaga(
  database: Database,
  input: {
    readonly operationId: string;
    readonly replayKey: string;
    readonly tenantId?: string;
    readonly fingerprint?: string;
    readonly resourceUid: string;
    readonly targetName: string;
    readonly expiresAt?: number;
  },
): void {
  const timestamp = input.expiresAt ?? 1_000;
  database
    .query(LEGACY_SAGA_INSERT)
    .run(
      input.operationId,
      input.replayKey,
      input.tenantId ?? "tenant-generation",
      input.fingerprint ?? `fingerprint:${input.operationId}`,
      input.resourceUid,
      "main",
      "generation.forms.invalid",
      "GenerationThing",
      input.targetName,
      null,
      null,
      null,
      null,
      timestamp,
      timestamp,
      timestamp,
    );
}

function insertLegacyDeferred(
  database: Database,
  input: {
    readonly id: string;
    readonly replayKey: string;
    readonly tenantId?: string;
    readonly resourceUid: string;
    readonly targetName: string;
    readonly expiresAt?: number;
    readonly requestBody?: string;
  },
): void {
  const timestamp = input.expiresAt ?? 1_000;
  database
    .query(LEGACY_DEFERRED_INSERT)
    .run(
      input.id,
      input.tenantId ?? "tenant-generation",
      "principal-generation",
      "import",
      "/v1/resources/import",
      "?space=main",
      "{}",
      input.requestBody ?? '{"nativeId":"legacy"}',
      `fingerprint:${input.id}`,
      input.replayKey,
      "main",
      "generation.forms.invalid",
      "GenerationThing",
      input.targetName,
      JSON.stringify(FORM_REF),
      null,
      null,
      null,
      input.resourceUid,
      null,
      1,
      new Date(timestamp).toISOString(),
      timestamp,
      timestamp,
    );
}

function insertLegacyResourceEffects(
  database: Database,
  input: {
    readonly tenantId?: string;
    readonly resourceUid: string;
    readonly operationId: string;
    readonly targetName: string;
    readonly kind: "apply" | "import" | "delete";
    readonly phases: readonly ("planned" | "dispatched" | "succeeded" | "cancelled")[];
  },
): void {
  const tenantId = input.tenantId ?? "tenant-generation";
  database
    .query(
      `INSERT INTO tf_resource_deletion_attestations
         (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
          state, closure_fence, effects_json, evidence_json, evidence_ref,
          evidence_effect_digest, evidence_checked_at, evidence_status,
          created_at, updated_at)
       VALUES (?, ?, 'main', 'generation.forms.invalid', 'GenerationThing', ?, ?,
               'live', 1, '[]', NULL, NULL, NULL, NULL, NULL, 1, 1)`,
    )
    .run(tenantId, input.resourceUid, input.targetName, JSON.stringify(FORM_REF));
  for (const [index, phase] of input.phases.entries()) {
    const timestamp = index + 2;
    const eventId = `${input.operationId}:${phase}`;
    const recorded = database
      .query(LEGACY_RESOURCE_EFFECT_INSERT)
      .run(
        tenantId,
        input.resourceUid,
        eventId,
        input.operationId,
        input.kind,
        phase,
        "initial",
        null,
        null,
        null,
        null,
        timestamp,
        tenantId,
        input.resourceUid,
      );
    expect(recorded.changes).toBe(1);
    database
      .query(
        `UPDATE tf_resource_deletion_attestations
         SET closure_fence = closure_fence + 1,
             effects_json = json_insert(effects_json, '$[#]', json(?)),
             updated_at = ?
         WHERE tenant_id = ? AND resource_uid = ? AND state IN ('live', 'pending')`,
      )
      .run(
        JSON.stringify({
          eventId,
          operationId: input.operationId,
          kind: input.kind,
          phase,
          operationMode: "initial",
        }),
        timestamp,
        tenantId,
        input.resourceUid,
      );
  }
}

function deferredForSaga(record: ProviderMutationSaga) {
  return {
    id: record.operationId,
    tenantId: record.tenantId,
    principalId: "principal-generation",
    operation: record.operationKind,
    phase: "pending" as const,
    requestPath: "/v1/resources",
    requestQuery: "",
    requestHeaders: {},
    requestBody: "{}",
    fingerprint: record.fingerprint,
    replayKey: `host:${record.replayKey}`,
    target: { ...record.target, formRef: FORM_REF },
    resourceUid: record.resourceUid,
    pollsRemaining: 1,
    createdAt: new Date(10_000).toISOString(),
  };
}

function saga(input: {
  readonly operationId: string;
  readonly replayKey: string;
  readonly resourceUid: string;
  readonly targetName: string;
  readonly tenantId?: string;
  readonly operationKind?: "apply" | "import" | "delete";
}): ProviderMutationSaga {
  return {
    operationId: input.operationId,
    operationKind: input.operationKind ?? "import",
    replayKey: input.replayKey,
    tenantId: input.tenantId ?? "tenant-generation",
    fingerprint: `fingerprint:${input.operationId}`,
    resourceUid: input.resourceUid,
    target: {
      tenantId: input.tenantId ?? "tenant-generation",
      space: "main",
      apiVersion: "generation.forms.invalid",
      kind: "GenerationThing",
      name: input.targetName,
    },
  };
}

describe("Takoform paired operation generation compatibility", () => {
  test("freezes both pinned legacy writer corpora and hides the new pair from old readers", async () => {
    const database = new Database(":memory:");
    try {
      migrateSqlite(database);
      for (const source of ["3b9a4e", "runtime-532"] as const) {
        const insertedSaga = database
          .query(LEGACY_SAGA_INSERT)
          .run(
            `op-${source}`,
            `replay-${source}`,
            "tenant-generation",
            `fingerprint:${source}`,
            `uid-${source}`,
            "main",
            "generation.forms.invalid",
            "GenerationThing",
            `legacy-${source}`,
            null,
            null,
            null,
            null,
            1_000,
            1_000,
            2_000,
          );
        const insertedDeferred = database
          .query(LEGACY_DEFERRED_INSERT)
          .run(
            `op-deferred-${source}`,
            "tenant-generation",
            "principal-generation",
            "import",
            "/v1/resources/import",
            "",
            "{}",
            "{}",
            `fingerprint:deferred:${source}`,
            `deferred-replay-${source}`,
            "main",
            "generation.forms.invalid",
            "GenerationThing",
            `deferred-${source}`,
            JSON.stringify(FORM_REF),
            null,
            null,
            null,
            `uid-deferred-${source}`,
            null,
            1,
            new Date(1_000).toISOString(),
            1_000,
            2_000,
          );
        expect([insertedSaga.changes, insertedDeferred.changes]).toEqual([0, 0]);
      }

      const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
      const currentSaga = saga({
        operationId: "op-current-pair",
        replayKey: "provider-replay-current-pair",
        resourceUid: "uid-current-pair",
        targetName: "current-pair",
      });
      await store.acceptDeferredOperation({
        id: currentSaga.operationId,
        tenantId: currentSaga.tenantId,
        principalId: "principal-generation",
        operation: "import",
        phase: "pending",
        requestPath: "/v1/resources/import",
        requestQuery: "",
        requestHeaders: {},
        requestBody: "{}",
        fingerprint: currentSaga.fingerprint,
        replayKey: "host-replay-current-pair",
        target: { ...currentSaga.target, formRef: FORM_REF },
        resourceUid: currentSaga.resourceUid,
        pollsRemaining: 1,
        createdAt: new Date(1_000).toISOString(),
      });
      await store.acceptProviderMutationSaga(currentSaga);

      expect(
        database
          .query("SELECT operation_id FROM tf_provider_mutation_sagas WHERE operation_id = ?")
          .all(currentSaga.operationId),
      ).toEqual([]);
      expect(
        database
          .query("SELECT id FROM tf_deferred_operations WHERE replay_key = ? AND expires_at > ?")
          .all("host-replay-current-pair", 0),
      ).toEqual([]);
      expect(
        database
          .query(
            `UPDATE tf_provider_mutation_sagas
             SET execution_lease_token = ?, execution_lease_until = ?, updated_at = ?
             WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
               AND phase = 'planned' AND receipt_json IS NULL AND expires_at > ?`,
          )
          .run(
            "old-lease",
            2_000,
            1_000,
            currentSaga.tenantId,
            currentSaga.operationId,
            currentSaga.resourceUid,
            1_000,
          ).changes,
      ).toBe(0);
      expect(
        database
          .query(
            `SELECT operation.id FROM tf_deferred_operations AS operation
             INNER JOIN tf_provider_mutation_sagas AS saga ON saga.operation_id = operation.id
             WHERE operation.phase = 'committing' AND saga.phase = 'planned'`,
          )
          .all(),
      ).toEqual([]);
      expect(
        database
          .query(
            `DELETE FROM tf_deferred_operations
             WHERE id = ? AND replay_key = ? AND phase IN ('succeeded', 'failed', 'cancelled')`,
          )
          .run(currentSaga.operationId, "host-replay-current-pair").changes,
      ).toBe(0);
      expect(
        database
          .query("SELECT COUNT(*) AS count FROM tf_provider_mutation_sagas_selection_v1")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  test("legacy planned and nonterminal deletion aborts roll back every sibling write", () => {
    const database = new Database(":memory:");
    try {
      applyBeforeGeneration(database);
      insertLegacySaga(database, {
        operationId: "op-legacy-durable",
        replayKey: "replay-legacy-durable",
        resourceUid: "uid-legacy-durable",
        targetName: "legacy-durable",
        expiresAt: 1,
      });
      insertLegacyDeferred(database, {
        id: "op-legacy-durable",
        replayKey: "host-replay-legacy-durable",
        resourceUid: "uid-legacy-durable",
        targetName: "legacy-durable",
        expiresAt: 1,
        requestBody: '{"preserve":true}',
      });
      database.exec(
        `UPDATE tf_deferred_operations
         SET phase = 'committing', polls_remaining = 0,
             lease_token = 'legacy-host-lease', lease_until = 5000
         WHERE id = 'op-legacy-durable'`,
      );
      database.exec(
        `INSERT INTO tf_resource_claims
           (claim_key, tenant_id, holder_space, holder_api_version, holder_kind,
            holder_name, holder_uid, owner_operation_id, state, expires_at, updated_at)
         VALUES ('claim:legacy-sibling', 'tenant-generation', 'main',
                 'generation.forms.invalid', 'GenerationThing', 'legacy-durable',
                 'uid-legacy-durable', 'legacy-host-lease', 'reserved', 5000, 1)`,
      );
      applyGeneration(database);

      const sweepDeferred = database.transaction(() => {
        database.exec(
          "UPDATE tf_resource_claims SET expires_at = 9000 WHERE claim_key = 'claim:legacy-sibling'",
        );
        database
          .query(
            `DELETE FROM tf_deferred_operations WHERE rowid IN (
               SELECT rowid FROM tf_deferred_operations
               WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
             )`,
          )
          .run(10, 128);
      });
      expect(() => sweepDeferred()).toThrow(
        "takoform_legacy_deferred_operation_nonterminal_durable",
      );
      expect(
        database
          .query(
            "SELECT request_body_json, lease_token, lease_until FROM tf_deferred_operations WHERE id = ?",
          )
          .get("op-legacy-durable"),
      ).toEqual({
        request_body_json: '{"preserve":true}',
        lease_token: "legacy-host-lease",
        lease_until: 5_000,
      });
      expect(
        database
          .query("SELECT expires_at FROM tf_resource_claims WHERE claim_key = ?")
          .get("claim:legacy-sibling"),
      ).toEqual({ expires_at: 5_000 });

      const sweepSaga = database.transaction(() => {
        database.exec(
          "UPDATE tf_deferred_operations SET lease_until = 9000 WHERE id = 'op-legacy-durable'",
        );
        database
          .query(
            `DELETE FROM tf_provider_mutation_sagas WHERE rowid IN (
               SELECT rowid FROM tf_provider_mutation_sagas
               WHERE phase = 'planned' AND expires_at <= ? ORDER BY expires_at LIMIT ?
             )`,
          )
          .run(10, 128);
      });
      expect(() => sweepSaga()).toThrow("takoform_legacy_provider_mutation_planned_durable");
      expect(
        database
          .query("SELECT lease_until FROM tf_deferred_operations WHERE id = ?")
          .get("op-legacy-durable"),
      ).toEqual({ lease_until: 5_000 });
    } finally {
      database.close();
    }
  });

  test("a legacy in-flight writer can receipt, commit, and delete its executed saga", () => {
    const database = new Database(":memory:");
    try {
      applyBeforeGeneration(database);
      insertLegacySaga(database, {
        operationId: "op-legacy-inflight",
        replayKey: "replay-legacy-inflight",
        resourceUid: "uid-legacy-inflight",
        targetName: "legacy-inflight",
        expiresAt: 1_000,
      });
      insertLegacyDeferred(database, {
        id: "op-legacy-inflight",
        replayKey: "host-replay-legacy-inflight",
        resourceUid: "uid-legacy-inflight",
        targetName: "legacy-inflight",
        expiresAt: 5_000,
      });
      database.exec(
        `UPDATE tf_provider_mutation_sagas
         SET execution_lease_token = 'legacy-provider-lease', execution_lease_until = 5000,
             execution_started_at = 1000, provider_outcome = 'running', expires_at = 5000
         WHERE operation_id = 'op-legacy-inflight';
         UPDATE tf_deferred_operations
         SET phase = 'committing', polls_remaining = 0,
             lease_token = 'legacy-host-lease', lease_until = 5000
         WHERE id = 'op-legacy-inflight';`,
      );
      applyGeneration(database);

      const finish = database.transaction(() => {
        database.exec(
          `UPDATE tf_provider_mutation_sagas
           SET phase = 'executed', receipt_json = '{"observed":{"legacy":true}}',
               updated_at = 2000, expires_at = NULL,
               execution_lease_token = NULL, execution_lease_until = NULL,
               provider_handle = NULL, provider_outcome = 'planned'
           WHERE operation_id = 'op-legacy-inflight'
             AND phase = 'planned' AND execution_started_at IS NOT NULL;
           UPDATE tf_deferred_operations
           SET phase = 'succeeded', terminal_json = '{"done":true}',
               committed_uid = 'uid-legacy-inflight', lease_token = NULL,
               lease_until = NULL, updated_at = 2000, expires_at = 5000
           WHERE id = 'op-legacy-inflight' AND phase = 'committing';
           DELETE FROM tf_provider_mutation_sagas
           WHERE operation_id = 'op-legacy-inflight' AND phase = 'executed';`,
        );
      });
      expect(() => finish()).not.toThrow();
      expect(
        database
          .query(
            "SELECT operation_id, phase, receipt_json, execution_started_at FROM tf_provider_mutation_sagas",
          )
          .all(),
      ).toEqual([]);
      expect(
        database
          .query("SELECT phase, terminal_json FROM tf_deferred_operations WHERE id = ?")
          .get("op-legacy-inflight"),
      ).toEqual({ phase: "succeeded", terminal_json: '{"done":true}' });
    } finally {
      database.close();
    }
  });

  test("expired legacy identities refuse new acceptance before claims", async () => {
    const database = new Database(":memory:");
    try {
      applyBeforeGeneration(database);
      for (const [suffix, resourceUid, targetName] of [
        ["operation", "uid-legacy-operation", "legacy-operation"],
        ["replay", "uid-legacy-replay", "legacy-replay"],
        ["uid", "uid-legacy-shared", "legacy-uid"],
        ["target", "uid-legacy-target", "legacy-target-shared"],
      ] as const) {
        insertLegacySaga(database, {
          operationId: `op-legacy-${suffix}`,
          replayKey: `replay-legacy-${suffix}`,
          resourceUid,
          targetName,
          expiresAt: 1,
        });
      }
      insertLegacyDeferred(database, {
        id: "op-legacy-deferred",
        replayKey: "replay-legacy-deferred",
        resourceUid: "uid-legacy-deferred",
        targetName: "legacy-deferred",
        expiresAt: 1,
      });
      applyCurrentGeneration(database);
      const store = createTakoformStore(createSqliteSql(database), () => new Date(10_000));
      const conflicts = [
        saga({
          operationId: "op-legacy-operation",
          replayKey: "new-replay-operation",
          resourceUid: "uid-new-operation",
          targetName: "new-operation",
        }),
        saga({
          operationId: "op-new-replay",
          replayKey: "replay-legacy-replay",
          resourceUid: "uid-new-replay",
          targetName: "new-replay",
        }),
        saga({
          operationId: "op-new-uid",
          replayKey: "new-replay-uid",
          resourceUid: "uid-legacy-shared",
          targetName: "new-uid",
        }),
        saga({
          operationId: "op-new-target",
          replayKey: "new-replay-target",
          resourceUid: "uid-new-target",
          targetName: "legacy-target-shared",
        }),
      ];
      for (const conflict of conflicts) {
        await expect(store.acceptProviderMutationSaga(conflict)).rejects.toMatchObject({
          hostCode: LEGACY_OPERATION_GENERATION_CONFLICT,
        });
      }
      await expect(
        store.acceptDeferredOperation({
          id: "op-legacy-deferred",
          tenantId: "tenant-generation",
          principalId: "principal-new",
          operation: "import",
          phase: "pending",
          requestPath: "/v1/resources/import",
          requestQuery: "",
          requestHeaders: {},
          requestBody: "{}",
          fingerprint: "fingerprint:new-deferred",
          replayKey: "new-host-replay-deferred",
          target: {
            space: "main",
            apiVersion: "generation.forms.invalid",
            kind: "GenerationThing",
            name: "new-deferred",
            formRef: FORM_REF,
          },
          resourceUid: "uid-new-deferred",
          pollsRemaining: 1,
          createdAt: new Date(10_000).toISOString(),
        }),
      ).rejects.toMatchObject({ hostCode: LEGACY_OPERATION_GENERATION_CONFLICT });
      expect(database.query("SELECT COUNT(*) AS count FROM tf_resource_claims").get()).toEqual({
        count: 0,
      });
      expect(
        database
          .query("SELECT COUNT(*) AS count FROM tf_provider_mutation_sagas_selection_v1")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.query("SELECT COUNT(*) AS count FROM tf_deferred_operations_selection_v1").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test("retained old effects fence a swept saga without blocking terminal or current work", async () => {
    const database = new Database(":memory:");
    try {
      applyBeforeGeneration(database);
      const open = [
        {
          suffix: "operation",
          resourceUid: "uid-effect-operation",
          targetName: "effect-operation",
          kind: "apply",
          phases: ["planned"],
        },
        {
          suffix: "uid",
          resourceUid: "uid-effect-shared",
          targetName: "effect-uid",
          kind: "import",
          phases: ["planned", "dispatched"],
        },
        {
          suffix: "target",
          resourceUid: "uid-effect-target",
          targetName: "effect-target-shared",
          kind: "delete",
          phases: ["planned", "dispatched"],
        },
      ] as const;
      for (const entry of open) {
        insertLegacySaga(database, {
          operationId: `op-effect-${entry.suffix}`,
          replayKey: `replay-effect-${entry.suffix}`,
          resourceUid: entry.resourceUid,
          targetName: entry.targetName,
          expiresAt: 1,
        });
        insertLegacyResourceEffects(database, {
          resourceUid: entry.resourceUid,
          operationId: `op-effect-${entry.suffix}`,
          targetName: entry.targetName,
          kind: entry.kind,
          phases: entry.phases,
        });
      }
      for (const [suffix, terminal] of [
        ["cancelled", ["planned", "cancelled"]],
        ["succeeded", ["planned", "dispatched", "succeeded"]],
      ] as const) {
        insertLegacySaga(database, {
          operationId: `op-effect-${suffix}`,
          replayKey: `replay-effect-${suffix}`,
          resourceUid: `uid-effect-${suffix}`,
          targetName: `effect-${suffix}`,
          expiresAt: 1,
        });
        insertLegacyResourceEffects(database, {
          resourceUid: `uid-effect-${suffix}`,
          operationId: `op-effect-${suffix}`,
          targetName: `effect-${suffix}`,
          kind: suffix === "cancelled" ? "apply" : "import",
          phases: terminal,
        });
      }

      // This is the released pre-0060 sweep. It can erase a seven-day-old
      // planned saga while the provider's pre-dispatch callback is still live.
      expect(
        database
          .query(
            `DELETE FROM tf_provider_mutation_sagas WHERE rowid IN (
               SELECT rowid FROM tf_provider_mutation_sagas
               WHERE phase = 'planned' AND expires_at <= ? ORDER BY expires_at LIMIT ?
             )`,
          )
          .run(10_000, 128).changes,
      ).toBe(5);
      expect(
        database.query("SELECT COUNT(*) AS count FROM tf_provider_mutation_sagas").get(),
      ).toEqual({ count: 0 });
      applyCurrentGeneration(database);

      const store = createTakoformStore(createSqliteSql(database), () => new Date(10_000));
      const operationConflict = saga({
        operationId: "op-effect-operation",
        replayKey: "new-replay-effect-operation",
        resourceUid: "uid-new-effect-operation",
        targetName: "new-effect-operation",
        operationKind: "apply",
      });
      const conflicts = [
        operationConflict,
        saga({
          operationId: "op-new-effect-uid",
          replayKey: "new-replay-effect-uid",
          resourceUid: "uid-effect-shared",
          targetName: "new-effect-uid",
          operationKind: "import",
        }),
        saga({
          operationId: "op-new-effect-target",
          replayKey: "new-replay-effect-target",
          resourceUid: "uid-new-effect-target",
          targetName: "effect-target-shared",
          operationKind: "delete",
        }),
      ];
      let providerCallbacks = 0;
      for (const conflict of conflicts) {
        await expect(
          (async () => {
            await store.acceptProviderMutationSaga(conflict);
            providerCallbacks += 1;
          })(),
        ).rejects.toMatchObject({ hostCode: LEGACY_OPERATION_GENERATION_CONFLICT });
      }
      await expect(
        store.acceptDeferredOperation(deferredForSaga(operationConflict)),
      ).rejects.toMatchObject({ hostCode: LEGACY_OPERATION_GENERATION_CONFLICT });
      expect(providerCallbacks).toBe(0);
      expect(
        database
          .query("SELECT COUNT(*) AS count FROM tf_provider_mutation_sagas_selection_v1")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.query("SELECT COUNT(*) AS count FROM tf_deferred_operations_selection_v1").get(),
      ).toEqual({ count: 0 });

      for (const suffix of ["cancelled", "succeeded"] as const) {
        await store.acceptProviderMutationSaga(
          saga({
            operationId: `op-new-after-${suffix}`,
            replayKey: `new-replay-after-${suffix}`,
            resourceUid: `uid-effect-${suffix}`,
            targetName: `effect-${suffix}`,
          }),
        );
      }

      const otherTenant = saga({
        operationId: "op-effect-operation",
        replayKey: "other-tenant-replay",
        resourceUid: "uid-effect-operation",
        targetName: "effect-operation",
        tenantId: "unrelated-tenant",
        operationKind: "apply",
      });
      await store.acceptProviderMutationSaga(otherTenant);

      const current = saga({
        operationId: "op-current-generation",
        replayKey: "current-generation-replay",
        resourceUid: "uid-current-generation",
        targetName: "current-generation",
        operationKind: "apply",
      });
      const currentDeferred = deferredForSaga(current);
      const acceptedDeferred = await store.acceptDeferredOperation(currentDeferred);
      const acceptedSaga = await store.acceptProviderMutationSaga(current);
      expect(
        await store.reserveResourceIncarnation({
          tenantId: current.tenantId,
          resourceUid: current.resourceUid,
          address: current.target,
          formRef: FORM_REF,
        }),
      ).toBe(true);
      expect(
        await store.recordResourceEffect({
          tenantId: current.tenantId,
          resourceUid: current.resourceUid,
          effectId: current.operationId,
          kind: "apply",
          phase: "planned",
          operationMode: "initial",
        }),
      ).toBe(true);
      expect(await store.acceptProviderMutationSaga(current)).toEqual(acceptedSaga);
      expect(await store.acceptDeferredOperation(currentDeferred)).toEqual(acceptedDeferred);
    } finally {
      database.close();
    }
  });

  test("new pair identity is immutable and an expired legacy dependency cannot dispatch", async () => {
    const current = new Database(":memory:");
    try {
      migrateSqlite(current);
      const store = createTakoformStore(createSqliteSql(current), () => new Date(1_000));
      for (const operationKind of ["import", "delete"] as const) {
        const currentSaga = saga({
          operationId: `op-typed-${operationKind}`,
          replayKey: `provider-replay-typed-${operationKind}`,
          resourceUid: `uid-typed-${operationKind}`,
          targetName: `typed-${operationKind}`,
          operationKind,
        });
        const accepted =
          operationKind === "delete"
            ? {
                acceptedUid: currentSaga.resourceUid,
                acceptedGeneration: "1",
                acceptedRevision: "revision-one",
              }
            : {};
        await store.acceptDeferredOperation({
          id: currentSaga.operationId,
          tenantId: currentSaga.tenantId,
          principalId: "principal-generation",
          operation: operationKind,
          phase: "pending",
          requestPath: "/v1/resources",
          requestQuery: "",
          requestHeaders: {},
          requestBody: "{}",
          fingerprint: currentSaga.fingerprint,
          replayKey: `host-replay-typed-${operationKind}`,
          target: { ...currentSaga.target, formRef: FORM_REF },
          ...accepted,
          resourceUid: currentSaga.resourceUid,
          pollsRemaining: 1,
          createdAt: new Date(1_000).toISOString(),
        });
        await store.acceptProviderMutationSaga({ ...currentSaga, ...accepted });
      }
      expect(
        current
          .query(
            `SELECT operation_id, operation_kind
             FROM tf_provider_mutation_sagas_selection_v1 ORDER BY operation_id`,
          )
          .all(),
      ).toEqual([
        { operation_id: "op-typed-delete", operation_kind: "delete" },
        { operation_id: "op-typed-import", operation_kind: "import" },
      ]);
      expect(() =>
        current.exec(
          `UPDATE tf_provider_mutation_sagas_selection_v1
           SET operation_kind = 'apply' WHERE operation_id = 'op-typed-import'`,
        ),
      ).toThrow("takoform_operation_generation_identity_immutable");
      expect(() =>
        current.exec(
          `UPDATE tf_deferred_operations_selection_v1
           SET target_name = 'different' WHERE id = 'op-typed-delete'`,
        ),
      ).toThrow("takoform_operation_generation_identity_immutable");
    } finally {
      current.close();
    }

    const legacy = new Database(":memory:");
    try {
      applyBeforeGeneration(legacy);
      insertLegacySaga(legacy, {
        operationId: "op-legacy-dependency",
        replayKey: "replay-legacy-dependency",
        resourceUid: "uid-legacy-dependency",
        targetName: "legacy-dependency",
        expiresAt: 5_000,
      });
      legacy.exec(
        `UPDATE tf_provider_mutation_sagas
         SET execution_lease_token = 'legacy-provider-lease', execution_lease_until = 5000
         WHERE operation_id = 'op-legacy-dependency'`,
      );
      const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
      const dependencyKey = `${dependencyStart}stale`;
      legacy
        .query(
          `INSERT INTO tf_resource_claims
             (claim_key, tenant_id, holder_space, holder_api_version, holder_kind,
              holder_name, holder_uid, owner_operation_id, state, expires_at, updated_at)
           VALUES (?, 'tenant-generation', '@host-dependency', 'host-dependency:internal',
                   'HostDependency', '@host-dependency', 'uid-legacy-dependency',
                   'legacy-dependency-owner', 'reserved', 50, 1)`,
        )
        .run(dependencyKey);
      applyGeneration(legacy);

      const oldDispatch = legacy.transaction(() => {
        legacy
          .query(
            `INSERT INTO tf_operation_commit_guards (token, valid)
             SELECT ?, CASE WHEN EXISTS (
               SELECT 1 FROM tf_provider_mutation_sagas
               WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                 AND phase = 'planned' AND receipt_json IS NULL AND expires_at > ?
                 AND execution_lease_token = ? AND execution_lease_until > ?
                 AND execution_started_at IS NULL
             ) AND (
               SELECT COUNT(*) FROM tf_resource_claims
               WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                 AND claim_key >= ? AND claim_key < ?
                 AND (state = 'committed' OR expires_at > ?)
             ) = json_array_length(?) AND NOT EXISTS (
               SELECT 1 FROM json_each(?) AS expected
               WHERE NOT EXISTS (
                 SELECT 1 FROM tf_resource_claims AS dependency
                 WHERE dependency.claim_key = CAST(expected.value AS TEXT)
                   AND dependency.owner_operation_id = ? AND dependency.tenant_id = ?
                   AND dependency.holder_uid = ?
                   AND (dependency.state = 'committed' OR dependency.expires_at > ?)
               )
             ) THEN 1 ELSE 0 END`,
          )
          .run(
            "legacy-dispatch-guard",
            "tenant-generation",
            "op-legacy-dependency",
            "uid-legacy-dependency",
            100,
            "legacy-provider-lease",
            100,
            "legacy-dependency-owner",
            "tenant-generation",
            "uid-legacy-dependency",
            dependencyStart,
            dependencyEnd,
            100,
            JSON.stringify([dependencyKey]),
            JSON.stringify([dependencyKey]),
            "legacy-dependency-owner",
            "tenant-generation",
            "uid-legacy-dependency",
            100,
          );
        legacy.exec(
          `UPDATE tf_provider_mutation_sagas
           SET execution_started_at = 100, provider_outcome = 'running'
           WHERE operation_id = 'op-legacy-dependency'`,
        );
      });
      expect(() => oldDispatch()).toThrow();
      expect(
        legacy
          .query(
            "SELECT execution_started_at FROM tf_provider_mutation_sagas WHERE operation_id = ?",
          )
          .get("op-legacy-dependency"),
      ).toEqual({ execution_started_at: null });
    } finally {
      legacy.close();
    }
  });
});
