import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

/**
 * A self-hosted deployment starts with an empty file. If the first run does
 * not produce a schema, it produces a server that answers every request with
 * "no such table" — which is what it did.
 */
describe("bringing a local database up to date", () => {
  test("creates everything on a fresh file", () => {
    const database = new Database(":memory:");
    const report = migrateSqlite(database);
    expect(report.applied).toEqual(MIGRATIONS.map((migration) => migration.name));

    // The tables the product actually needs on its first request.
    for (const table of [
      "principals",
      "orgs",
      "ledger",
      "integration_e2e_credential_pair_operations",
      "tf_artifact_gc_candidates",
      "tf_artifact_manifest_members",
      "tf_artifact_roots",
      "tf_resources",
      "tf_resource_attachments",
      "tf_resource_deployments",
      "tf_deferred_operations",
      "tf_operation_commit_guards",
      "tf_resource_claims",
      "tf_resource_deletion_attestations",
      "tf_resource_provider_effects",
      "worker_endpoint_origin_reservations",
      "worker_runtime_input_preparations",
      "reservations",
    ]) {
      expect(() => database.query(`SELECT 1 FROM ${table} LIMIT 1`).all()).not.toThrow();
    }
    expect(
      database
        .query("PRAGMA table_info(tf_resources)")
        .all()
        .map((column) => String((column as { name: unknown }).name)),
    ).not.toContain("native_id");
  });

  test("running it again applies nothing", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const second = migrateSqlite(database);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(MIGRATIONS.length);
  });

  test("appends the pair lifecycle without reinterpreting historical single-key rows", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const pairLifecycle = MIGRATIONS.findIndex(
      (migration) => migration.name === "0030_integration_e2e_credential_pairs.sql",
    );
    expect(pairLifecycle).toBe(MIGRATIONS.length - 3);
    expect(MIGRATIONS[pairLifecycle - 1]?.name).toBe("0029_resource_deletion_attestations.sql");
    expect(MIGRATIONS[pairLifecycle + 1]?.name).toBe("0031_takoform_artifact_lifecycle.sql");
    for (const migration of MIGRATIONS.slice(0, pairLifecycle)) {
      expect(migration.sql).not.toContain("integration_e2e_credential_pair_operations");
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database.exec(`
      INSERT INTO principals
        (id, provider, provider_subject, email, display_name, created_at)
      VALUES
        ('principal_legacy', 'takos-id', 'legacy', 'legacy@example.test', 'Legacy',
         '2026-08-30T00:00:00.000Z');
      INSERT INTO orgs (id, name, owner_principal_id, created_at)
      VALUES
        ('org_takosumi_hosted_staging', 'Takosumi Hosted staging', 'principal_legacy',
         '2026-08-30T00:00:00.000Z');
      INSERT INTO auth_tokens
        (secret_digest, id, kind, principal_id, org_id, name, scopes_json,
         created_at, expires_at, revoked_at)
      VALUES
        ('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         'key_ie2e_historical_single', 'api_key', 'principal_legacy',
         'org_takosumi_hosted_staging', 'integration-e2e-api-key',
         '["resources:write"]', '2026-08-30T00:00:00.000Z',
         '2026-08-30T00:15:00.000Z', NULL);
    `);
    const historical = database
      .query("SELECT * FROM auth_tokens WHERE id = 'key_ie2e_historical_single'")
      .get();

    expect(migrateSqlite(database).applied).toEqual([
      "0030_integration_e2e_credential_pairs.sql",
      "0031_takoform_artifact_lifecycle.sql",
      "0032_worker_runtime_input_preparations.sql",
    ]);
    expect(
      database.query("SELECT * FROM auth_tokens WHERE id = 'key_ie2e_historical_single'").get(),
    ).toEqual(historical);
    expect(
      database
        .query("SELECT COUNT(*) AS count FROM integration_e2e_credential_pair_operations")
        .get(),
    ).toEqual({ count: 0 });
  });

  test("backfills historical artifact owners conservatively into normalized roots", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const lifecycle = MIGRATIONS.findIndex(
      (migration) => migration.name === "0031_takoform_artifact_lifecycle.sql",
    );
    expect(lifecycle).toBe(MIGRATIONS.length - 2);
    for (const migration of MIGRATIONS.slice(0, lifecycle)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }

    const manifestDigest = `sha256:${"a".repeat(64)}`;
    const blobDigest = `sha256:${"b".repeat(64)}`;
    const unknownDigest = `sha256:${"c".repeat(64)}`;
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
    database
      .query(
        `INSERT INTO tf_artifact_uploads
           (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("up_legacy_artifact", "tenant_legacy", "run:legacy", manifest, manifestDigest, 10);
    database
      .query(
        `INSERT INTO tf_artifact_manifests (digest, manifest_json, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(manifestDigest, manifest, 10);
    database
      .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)")
      .run("tenant_legacy", manifestDigest, "manifest");
    database
      .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)")
      .run("tenant_legacy", blobDigest, "blob");
    database
      .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)")
      .run("tenant_unknown", unknownDigest, "blob");
    database
      .query(
        `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
         VALUES (?, 201, ?, ?)`,
      )
      .run(
        ["tenant_legacy", "run:legacy", "start", "legacy-key"].join("\u0000"),
        JSON.stringify({ uploadId: "up_legacy_artifact", manifestDigest }),
        100,
      );

    expect(migrateSqlite(database).applied).toEqual([
      "0031_takoform_artifact_lifecycle.sql",
      "0032_worker_runtime_input_preparations.sql",
    ]);
    expect(
      database
        .query(
          `SELECT lifecycle_state, lifecycle_fence, updated_at
           FROM tf_artifact_uploads WHERE id = 'up_legacy_artifact'`,
        )
        .get(),
    ).toEqual({ lifecycle_state: "committed", lifecycle_fence: 1, updated_at: 10 });
    expect(
      database
        .query(
          `SELECT manifest_digest, blob_digest FROM tf_artifact_manifest_members
           ORDER BY manifest_digest, blob_digest`,
        )
        .all(),
    ).toEqual([{ manifest_digest: manifestDigest, blob_digest: blobDigest }]);
    expect(
      database
        .query(
          `SELECT tenant_id, root_kind, target_kind, digest, state
           FROM tf_artifact_roots ORDER BY tenant_id, root_kind, target_kind, digest`,
        )
        .all(),
    ).toEqual([
      {
        tenant_id: "tenant_legacy",
        root_kind: "replay",
        target_kind: "manifest",
        digest: manifestDigest,
        state: "active",
      },
      {
        tenant_id: "tenant_legacy",
        root_kind: "upload",
        target_kind: "manifest",
        digest: manifestDigest,
        state: "active",
      },
      {
        tenant_id: "tenant_unknown",
        root_kind: "legacy-hold",
        target_kind: "blob",
        digest: unknownDigest,
        state: "active",
      },
    ]);
  });

  test("enforces the fixed organization, roles, scopes, TTL, and distinct role ids in 0030", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const insert = database.query(`
      INSERT INTO integration_e2e_credential_pair_operations
        (operation_id, authority_slot, org_id, writer_key_id, evidence_key_id,
         writer_name, evidence_name, writer_scopes_json, evidence_scopes_json,
         ttl_seconds, state, fence, source_commit, artifact_digest,
         authority_worker_version_id, created_at, updated_at, revoked_at)
      VALUES (?, 'integration-e2e-credential-pair', ?, ?, ?, ?, ?, ?, ?, ?,
              'prepared', 1, ?, ?, ?, 1, 1, NULL)
    `);
    const valid = [
      "operation-migration-constraints",
      "org_takosumi_hosted_staging",
      "key_writer",
      "key_evidence",
      "integration-e2e-writer",
      "integration-e2e-evidence",
      '["resources:write"]',
      '["resources:read"]',
      3_600,
      "a".repeat(40),
      `sha256:${"b".repeat(64)}`,
      "00000000-0000-4000-8000-000000000001",
    ] as const;
    for (const [index, replacement] of [
      [1, "org_wrong"],
      [3, "key_writer"],
      [4, "wrong-writer-name"],
      [5, "wrong-evidence-name"],
      [6, '["resources:read"]'],
      [7, '["resources:write"]'],
      [8, 900],
    ] as const) {
      const values: (string | number)[] = [...valid];
      values[0] = `${valid[0]}-${index}`;
      values[index] = replacement;
      expect(() => insert.run(...values)).toThrow();
    }
    expect(() => insert.run(...valid)).not.toThrow();
  });

  test("does not fabricate deletion attestations for pre-0029 deleted deployments", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const deletionAttestation = MIGRATIONS.findIndex(
      (migration) => migration.name === "0029_resource_deletion_attestations.sql",
    );
    expect(deletionAttestation).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, deletionAttestation)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resource_deployments
           (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
            provider_installation_ref, native_id, native_claimed, state,
            observed_json, outputs_json, created_at, updated_at)
         VALUES ('tenant-legacy', 'dep_deleted', 'uid_deleted', 'offering.test',
                 'provider.test', 'provider.test.primary', 'native:test', 0,
                 'deleted', '{}', '{}', 100, 100)`,
      )
      .run();

    const report = migrateSqlite(database);

    expect(report.applied[0]).toBe("0029_resource_deletion_attestations.sql");
    expect(
      database.query("SELECT COUNT(*) AS count FROM tf_resource_deletion_attestations").get(),
    ).toEqual({ count: 0 });
  });

  test("fails closed when live rows cannot be registered as unique incarnations", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const deletionAttestation = MIGRATIONS.findIndex(
      (migration) => migration.name === "0029_resource_deletion_attestations.sql",
    );
    for (const migration of MIGRATIONS.slice(0, deletionAttestation)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    const resource = JSON.stringify({
      form: {
        formRef: {
          apiVersion: "edge.forms.takoform.com",
          kind: "Thing",
          definitionVersion: "v1",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
    });
    for (const name of ["first", "second"]) {
      database
        .query(
          `INSERT INTO tf_resources
             (tenant_id, space, api_version, kind, name, uid, generation, revision,
              resource_json, relations_json, updated_at)
           VALUES ('tenant-duplicate', 'main', 'example.forms.invalid', 'Thing', ?,
                   'uid_duplicate', '1', '1', ?, '[]', 1)`,
        )
        .run(name, resource);
    }

    expect(() => migrateSqlite(database)).toThrow(/0029_resource_deletion_attestations/);
    expect(
      database
        .query(
          "SELECT name FROM applied_migrations WHERE name = '0029_resource_deletion_attestations.sql'",
        )
        .all(),
    ).toEqual([]);
    expect(() => database.query("SELECT 1 FROM tf_resource_deletion_attestations").all()).toThrow();
  });

  test("fails closed when a live row has no FormRef", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const deletionAttestation = MIGRATIONS.findIndex(
      (migration) => migration.name === "0029_resource_deletion_attestations.sql",
    );
    for (const migration of MIGRATIONS.slice(0, deletionAttestation)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, relations_json, updated_at)
         VALUES ('tenant-malformed', 'main', 'example.forms.invalid', 'Thing', 'broken',
                 'uid_broken', '1', '1', '{}', '[]', 1)`,
      )
      .run();

    expect(() => migrateSqlite(database)).toThrow(/0029_resource_deletion_attestations/);
    expect(
      database
        .query(
          "SELECT name FROM applied_migrations WHERE name = '0029_resource_deletion_attestations.sql'",
        )
        .all(),
    ).toEqual([]);
  });

  test("fails closed for every malformed FormRef grammar component", () => {
    const malformed: readonly [string, Record<string, string>][] = [
      ["empty apiVersion", { apiVersion: "" }],
      ["invalid apiVersion version", { apiVersion: "edge.forms.takoform.com/v1gamma1" }],
      ["empty kind", { kind: "" }],
      ["invalid kind case", { kind: "thing" }],
      ["non-semver definitionVersion", { definitionVersion: "latest" }],
      ["bad schema digest", { schemaDigest: "sha256:short" }],
    ];
    const deletionAttestation = MIGRATIONS.findIndex(
      (migration) => migration.name === "0029_resource_deletion_attestations.sql",
    );
    for (const [index, [label, replacement]] of malformed.entries()) {
      const database = new Database(":memory:");
      database.exec(`
        CREATE TABLE applied_migrations (
          name TEXT PRIMARY KEY NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, deletionAttestation)) {
        database.exec(migration.sql);
        database
          .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
          .run(migration.name);
      }
      const formRef = {
        apiVersion: "edge.forms.takoform.com",
        kind: "Thing",
        definitionVersion: "1.0.0",
        schemaDigest: `sha256:${"a".repeat(64)}`,
        ...replacement,
      };
      database
        .query(
          `INSERT INTO tf_resources
             (tenant_id, space, api_version, kind, name, uid, generation, revision,
              resource_json, relations_json, updated_at)
           VALUES ('tenant-malformed-ref', 'main', 'edge.forms.takoform.com', 'Thing', ?, ?,
                   '1', '1', ?, '[]', 1)`,
        )
        .run(`broken-${index}`, `uid_malformed_${index}`, JSON.stringify({ form: { formRef } }));

      expect(() => migrateSqlite(database), label).toThrow(/0029_resource_deletion_attestations/);
      expect(
        database
          .query(
            "SELECT name FROM applied_migrations WHERE name = '0029_resource_deletion_attestations.sql'",
          )
          .all(),
      ).toEqual([]);
      expect(() =>
        database.query("SELECT 1 FROM tf_resource_deletion_attestations").all(),
      ).toThrow();
    }
  });

  test("adds durable operations and claims without rewriting released Takoform rows", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const durableOperations = MIGRATIONS.findIndex(
      (migration) => migration.name === "0020_takoform_deferred_operations.sql",
    );
    expect(durableOperations).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, durableOperations)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, relations_json, updated_at)
         VALUES ('tenant-a', 'main', 'example.forms.invalid', 'Thing', 'existing',
                 'uid_existing', '3', '7', ?, '[]', 42)`,
      )
      .run(
        JSON.stringify({
          existing: true,
          form: {
            formRef: {
              apiVersion: "edge.forms.takoform.com",
              kind: "Thing",
              definitionVersion: "1.0.0",
              schemaDigest: `sha256:${"a".repeat(64)}`,
            },
          },
        }),
      );
    database
      .query(`
      INSERT INTO tf_operations
        (id, tenant_id, operation, state, resource_json, created_at, expires_at)
      VALUES
        ('op_existing', 'tenant-a', 'apply', 'succeeded', ?,
         '2026-08-23T00:00:00.000Z', 9999999999999)
    `)
      .run(
        JSON.stringify({
          existing: true,
          form: {
            formRef: {
              apiVersion: "edge.forms.takoform.com",
              kind: "Thing",
              definitionVersion: "1.0.0",
              schemaDigest: `sha256:${"a".repeat(64)}`,
            },
          },
        }),
      );

    const report = migrateSqlite(database);

    expect(report.applied.slice(0, 5)).toEqual([
      "0020_takoform_deferred_operations.sql",
      "0021_takoform_provider_mutation_sagas.sql",
      "0022_takoform_admission.sql",
      "0023_takoform_host_authority.sql",
      "0024_takoform_provider_execution_leases.sql",
    ]);
    expect(
      database
        .query(
          `SELECT uid, generation, revision, resource_json, relations_json, updated_at
           FROM tf_resources WHERE name = 'existing'`,
        )
        .get(),
    ).toEqual({
      uid: "uid_existing",
      generation: "3",
      revision: "7",
      resource_json: JSON.stringify({
        existing: true,
        form: {
          formRef: {
            apiVersion: "edge.forms.takoform.com",
            kind: "Thing",
            definitionVersion: "1.0.0",
            schemaDigest: `sha256:${"a".repeat(64)}`,
          },
        },
      }),
      relations_json: "[]",
      updated_at: 42,
    });
    expect(
      database
        .query("SELECT id, state, resource_json FROM tf_operations WHERE id = 'op_existing'")
        .get(),
    ).toEqual({
      id: "op_existing",
      state: "succeeded",
      resource_json: JSON.stringify({
        existing: true,
        form: {
          formRef: {
            apiVersion: "edge.forms.takoform.com",
            kind: "Thing",
            definitionVersion: "1.0.0",
            schemaDigest: `sha256:${"a".repeat(64)}`,
          },
        },
      }),
    });
    for (const table of [
      "tf_deferred_operations",
      "tf_operation_commit_guards",
      "tf_resource_claims",
    ]) {
      expect(() => database.query(`SELECT 1 FROM ${table} LIMIT 1`).all()).not.toThrow();
    }
  });

  test("preserves every applied 0022 checkpoint predecessor when adding profile identity", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const authorityMigration = MIGRATIONS.findIndex(
      (migration) => migration.name === "0023_takoform_host_authority.sql",
    );
    expect(authorityMigration).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, authorityMigration)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    const sha = (letter: string) => `sha256:${letter.repeat(64)}`;
    database
      .query(
        `INSERT INTO tf_form_revocation_checkpoints
           (id, publisher_key, sequence, checkpoint_digest, entries_digest,
            previous_checkpoint_digest, revoked_package_digests_json,
            policy_digest, policy_event_digest, actor, reason, event_at,
            event_digest, predecessor_digest)
         VALUES (?, ?, 1, ?, ?, ?, '[]', ?, ?, ?, ?, 7, ?, ?)`,
      )
      .run(
        "checkpoint_legacy",
        "publisher-legacy",
        sha("1"),
        sha("2"),
        sha("f"),
        sha("3"),
        sha("4"),
        "legacy-operator",
        "preserve protected row",
        sha("5"),
        sha("0"),
      );

    const report = migrateSqlite(database);

    expect(report.applied.slice(0, 2)).toEqual([
      "0023_takoform_host_authority.sql",
      "0024_takoform_provider_execution_leases.sql",
    ]);
    expect(
      database
        .query(
          `SELECT checkpoint_api_version, sequence, previous_checkpoint_digest,
                  event_digest
           FROM tf_form_revocation_checkpoints WHERE id = 'checkpoint_legacy'`,
        )
        .get(),
    ).toEqual({
      checkpoint_api_version: "trust.forms.takoform.com/v1alpha1",
      sequence: 1,
      previous_checkpoint_digest: sha("f"),
      event_digest: sha("5"),
    });
    expect(() =>
      database.exec(`
        INSERT INTO tf_form_revocation_checkpoints
          (id, publisher_key, checkpoint_api_version, sequence,
           checkpoint_digest, entries_digest, previous_checkpoint_digest,
           revoked_package_digests_json, policy_digest, policy_event_digest,
           actor, reason, event_at, event_digest, predecessor_digest)
        VALUES
          ('checkpoint_canonical', 'publisher-canonical',
           'trust.forms.takoform.com/v1alpha1', 1,
           '${sha("6")}', '${sha("7")}', NULL, '[]', '${sha("8")}',
           '${sha("9")}', 'legacy-operator', 'canonical legacy genesis', 8,
           '${sha("a")}', '${sha("0")}')
      `),
    ).not.toThrow();
  });

  test("adds provider execution leases without rewriting planned or executed sagas", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const executionLeaseMigration = MIGRATIONS.findIndex(
      (migration) => migration.name === "0024_takoform_provider_execution_leases.sql",
    );
    expect(executionLeaseMigration).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, executionLeaseMigration)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database.exec(`
      INSERT INTO tf_provider_mutation_sagas
        (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
         target_space, target_api_version, target_kind, target_name,
         accepted_uid, accepted_generation, accepted_revision, phase,
         receipt_json, authority_head_digest, created_at, updated_at, expires_at)
      VALUES
        ('op_planned', 'replay-planned', 'tenant-a', '{}', 'uid_planned',
         'main', 'example.forms.invalid', 'Thing', 'planned',
         NULL, NULL, NULL, 'planned', NULL, NULL, 100, 100, 999),
        ('op_executed', 'replay-executed', 'tenant-a', '{}', 'uid_executed',
         'main', 'example.forms.invalid', 'Thing', 'executed',
         NULL, NULL, NULL, 'executed', '{"observed":{}}', NULL, 100, 100, NULL);
    `);

    const report = migrateSqlite(database);

    expect(report.applied.slice(0, 2)).toEqual([
      "0024_takoform_provider_execution_leases.sql",
      "0025_resource_migration_execution.sql",
    ]);
    expect(
      database
        .query(
          `SELECT operation_id, phase, receipt_json, execution_lease_token,
                  execution_lease_until, execution_started_at
           FROM tf_provider_mutation_sagas ORDER BY operation_id`,
        )
        .all(),
    ).toEqual([
      {
        operation_id: "op_executed",
        phase: "executed",
        receipt_json: '{"observed":{}}',
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: null,
      },
      {
        operation_id: "op_planned",
        phase: "planned",
        receipt_json: null,
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: null,
      },
    ]);
  });

  test("makes existing in-flight Resource Migrations recovery-only without changing state", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const executionMigration = MIGRATIONS.findIndex(
      (migration) => migration.name === "0025_resource_migration_execution.sql",
    );
    expect(executionMigration).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, executionMigration)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database.exec(`
      INSERT INTO tf_resource_migrations
        (tenant_id, id, resource_uid, source_deployment_id, target_deployment_id,
         target_offering_id, target_provider_pack_ref, target_provider_installation_ref,
         commercial_authorization_ref, commercial_tenant_ref, mode, transfer_format, state,
         verification_json, rollback_until, attachment_rebindings_json, created_at, updated_at)
      VALUES
        ('tenant-a', 'mig_planned', 'uid_planned', 'dep_source_planned', 'dep_target_planned',
         'offering.target', 'target', 'target.primary', 'reservation_planned', 'commercial-a',
         'offline', 'transfer.example/v1', 'planned', NULL, NULL, NULL, 100, 110),
        ('tenant-a', 'mig_provisioning', 'uid_provisioning', 'dep_source_provisioning',
         'dep_target_provisioning', 'offering.target', 'target', 'target.primary',
         'reservation_provisioning', 'commercial-a', 'offline', 'transfer.example/v1',
         'provisioning', NULL, NULL, NULL, 200, 210),
        ('tenant-a', 'mig_transferring', 'uid_transferring', 'dep_source_transferring',
         'dep_target_transferring', 'offering.target', 'target', 'target.primary',
         'reservation_transferring', 'commercial-a', 'offline', 'transfer.example/v1',
         'transferring', NULL, NULL, NULL, 300, 310);
    `);

    const report = migrateSqlite(database);

    expect(report.applied[0]).toBe("0025_resource_migration_execution.sql");
    expect(
      database
        .query(
          `SELECT id, state, execution_lease_token, execution_lease_until,
                  execution_started_at, execution_json
           FROM tf_resource_migrations ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "mig_planned",
        state: "planned",
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: null,
        execution_json: "{}",
      },
      {
        id: "mig_provisioning",
        state: "provisioning",
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: 210,
        execution_json: "{}",
      },
      {
        id: "mig_transferring",
        state: "transferring",
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: 310,
        execution_json: "{}",
      },
    ]);
    expect(migrateSqlite(database)).toEqual({
      applied: [],
      alreadyApplied: MIGRATIONS.length,
    });
  });

  test("renames fractional usage money without changing its value", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const usageMicros = MIGRATIONS.findIndex((migration) => migration.name.startsWith("0018_"));
    expect(usageMicros).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, usageMicros)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO usage_events
           (request_id, org_id, resource_uid, meter, quantity, amount_minor, created_at)
         VALUES ('request_1', 'org_1', 'resource_1', 'object.get', 1, 123456, 'now')`,
      )
      .run();

    migrateSqlite(database);

    expect(database.query("SELECT amount_micros FROM usage_events").get()).toEqual({
      amount_micros: 123456,
    });
    expect(
      database
        .query("PRAGMA table_info(usage_events)")
        .all()
        .map((column) => String((column as { name: unknown }).name)),
    ).not.toContain("amount_minor");
  });

  test("refuses credit-lot activation until predecessor wallet data was snapshotted and reset", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const creditLots = MIGRATIONS.findIndex((migration) => migration.name.startsWith("0017_"));
    expect(creditLots).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, creditLots)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO ledger
           (id, org_id, type, ref, settled_delta, held_delta, created_at)
         VALUES ('led_old', 'org_old', 'funding', 'old-payment', 100, 0, '2026-08-01T00:00:00.000Z')`,
      )
      .run();

    expect(() => migrateSqlite(database)).toThrow(/0017_wallet_credit_lots\.sql failed/u);
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'wallet_credit_lots'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(database.query("SELECT settled_delta FROM ledger WHERE id = 'led_old'").get()).toEqual({
      settled_delta: 100,
    });
  });

  test("refuses a database written by a newer build", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    database.exec(
      "INSERT INTO applied_migrations (name, applied_at) VALUES ('9999_from_the_future.sql', 'now')",
    );
    // Downgrading by re-running old migrations over a newer schema is how a
    // database gets destroyed by an upgrade tool.
    expect(() => migrateSqlite(database)).toThrow(/newer Takoserver/u);
  });

  test("leaves nothing half applied when a migration fails", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    // A table this build's first migration would create already exists, so a
    // second pass over a wiped record must abort rather than half-apply.
    database.exec("DELETE FROM applied_migrations");
    expect(() => migrateSqlite(database)).toThrow(/migration .* failed/u);
    expect(database.query("SELECT COUNT(*) AS n FROM applied_migrations").all()).toEqual([
      { n: 0 },
    ]);
  });

  test("refuses to discard a legacy native identity that has not been adopted", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const dropNativeIdentity = MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith("0007_"),
    );
    expect(dropNativeIdentity).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, dropNativeIdentity)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, native_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_1",
        "default",
        "forms/v1",
        "Bucket",
        "assets",
        "uid_1",
        "1",
        "1",
        "{}",
        "bucket:assets",
        1,
      );

    expect(() => migrateSqlite(database)).toThrow(
      /0007_logical_resources_drop_native_identity\.sql failed/u,
    );
    expect(database.query("SELECT native_id FROM tf_resources").all()).toEqual([
      { native_id: "bucket:assets" },
    ]);
  });

  test("adopts exact released legacy resources into provider Deployments before dropping native identity", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const dropNativeIdentity = MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith("0007_"),
    );
    for (const migration of MIGRATIONS.slice(0, dropNativeIdentity)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, native_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_1",
        "default",
        "edge.forms.takoform.com/v1beta1",
        "ObjectBucket",
        "assets",
        "uid_legacy_bucket",
        "1",
        "2",
        JSON.stringify({
          form: {
            formRef: {
              apiVersion: "edge.forms.takoform.com/v1beta1",
              kind: "ObjectBucket",
              definitionVersion: "1.0.0",
              schemaDigest: `sha256:${"b".repeat(64)}`,
            },
          },
          status: {
            observed: { region: "global" },
            outputs: { bucket: "opaque" },
          },
        }),
        "r2:opaque-native-id",
        42,
      );

    migrateSqlite(database);
    expect(
      database
        .query(
          `SELECT id, resource_uid, offering_id, provider_pack_ref,
                  provider_installation_ref, native_id, state, observed_json,
                  outputs_json
           FROM tf_resource_deployments`,
        )
        .all(),
    ).toEqual([
      {
        id: "dep_legacy_uid_legacy_bucket",
        resource_uid: "uid_legacy_bucket",
        offering_id: "storage.object.standard",
        provider_pack_ref: "cloudflare",
        provider_installation_ref: "cloudflare.primary",
        native_id: "r2:opaque-native-id",
        state: "active",
        observed_json: '{"region":"global"}',
        outputs_json: '{"bucket":"opaque"}',
      },
    ]);
    expect(
      database
        .query("PRAGMA table_info(tf_resources)")
        .all()
        .map((column) => String((column as { name: unknown }).name)),
    ).not.toContain("native_id");
  });
});
