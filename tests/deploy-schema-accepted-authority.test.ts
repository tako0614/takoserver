import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RemoteD1 } from "../scripts/deploy/d1.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import { type D1SchemaState, readD1SchemaState } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { runD1Schema, type SchemaProcess } from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const migrationFixtureRoot = mkdtempSync(
  join(process.env.TMPDIR ?? "/tmp", "takoserver-accepted-authority-"),
);
const currentMigrations = copyCurrentSchemaFixture(join(migrationFixtureRoot, "migrations"));
afterAll(() => rmSync(migrationFixtureRoot, { recursive: true, force: true }));

const COMMIT = "a".repeat(40);
const ACCEPTED_AUTHORITY_MIGRATION = "0061_takoform_accepted_authority_continuity.sql";
const OPERATION_GENERATION_MIGRATION = "0060_takoform_operation_generation.sql";
const INTEGRATION_TARGET = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000061",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

type AttestationState = "live" | "pending" | "closed" | "cancelled" | "missing";

interface ProcessOptions {
  readonly failMigration?: string;
  readonly failAcknowledgementAfterCommit?: boolean;
  readonly failReadbackAfterApply?: boolean;
  readonly afterMigrationApply?: (database: Database) => void;
  readonly beforeCanonicalShapeRead?: (read: number, database: Database) => void;
  readonly malformedOrphanCountAt?: number;
}

interface DatabaseProcessFixture {
  readonly run: SchemaProcess;
  readonly calls: string[][];
  readonly migrationApplyCalls: () => number;
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function createDatabaseThrough(count: number, attestation: AttestationState = "live"): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.slice(0, count)) {
    database.exec(readFileSync(join(currentMigrations, migration.name), "utf8"));
    database
      .query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'fixture')")
      .run(migration.name);
  }
  if (count >= 58) seedLegacyRows(database, attestation);
  if (count >= 60) {
    insertCurrentOperation(database, "old-null-apply", "apply");
    insertCurrentOperation(database, "old-null-import", "import");
    insertCurrentOperation(database, "old-null-delete", "delete");
  }
  return database;
}

function seedLegacyRows(database: Database, attestation: AttestationState): void {
  database
    .query(
      `INSERT INTO tf_deferred_operations (
         id, tenant_id, principal_id, operation, phase, request_path, request_query,
         request_headers_json, request_body_json, fingerprint, replay_key,
         target_space, target_api_version, target_kind, target_name, target_form_ref_json,
         accepted_uid, accepted_generation, accepted_revision, resource_uid,
         polls_remaining, lease_token, lease_until, terminal_json, committed_uid,
         created_at, updated_at, expires_at
       ) VALUES (
         'operation-legacy', 'tenant-legacy', 'principal-legacy', 'apply', 'committing',
         '/apis/forms/resources/example/Thing/legacy', '', '{}', '{}', 'fingerprint-legacy',
         'replay-legacy', 'main', 'example.forms.takoform.com/v1', 'Thing', 'legacy', '{}',
         NULL, NULL, NULL, 'resource-legacy', 0, NULL, NULL, NULL, NULL,
         '2026-09-20T00:00:00.000Z', 100, 1000
       )`,
    )
    .run();
  database
    .query(
      `INSERT INTO tf_provider_mutation_sagas (
         operation_id, replay_key, tenant_id, fingerprint, resource_uid,
         target_space, target_api_version, target_kind, target_name,
         accepted_uid, accepted_generation, accepted_revision, phase, receipt_json,
         created_at, updated_at, expires_at, authority_head_digest,
         execution_lease_token, execution_lease_until, execution_started_at,
         provider_handle, provider_outcome
       ) VALUES (
         'operation-legacy', 'replay-legacy', 'tenant-legacy', 'fingerprint-legacy',
         'resource-legacy', 'main', 'example.forms.takoform.com/v1', 'Thing', 'legacy',
         NULL, NULL, NULL, 'planned', NULL, 100, 100, 1000, NULL,
         NULL, NULL, NULL, NULL, 'planned'
       )`,
    )
    .run();
  database
    .query(
      `INSERT INTO tf_resource_provider_effects (
         tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
         operation_mode, provider_pack_ref, provider_installation_ref, native_id,
         target_json, created_at
       ) VALUES (
         'tenant-legacy', 'resource-legacy', 'event-legacy', 'effect-legacy',
         'apply', 'dispatched', 'recovery', 'provider-pack', 'provider-installation',
         'native-legacy', '{}', 100
       )`,
    )
    .run();
  if (attestation === "missing") return;
  database
    .query(
      `INSERT INTO tf_resource_deletion_attestations (
         tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
         state, closure_fence, effects_json, evidence_json, evidence_ref,
         evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at
       ) VALUES (
         'tenant-legacy', 'resource-legacy', 'main', 'example.forms.takoform.com/v1',
         'Thing', 'legacy',
         '{"apiVersion":"example.forms.takoform.com/v1","kind":"Thing","definitionVersion":"1.0.0","schemaDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
         ?, 1, '[]', NULL, NULL, NULL, NULL, NULL, 100, 100
       )`,
    )
    .run(attestation);
}

const AUTHORITY_SUMMARY = JSON.stringify({
  formRef: {
    apiVersion: "edge.forms.takoform.com",
    definitionVersion: "1.0.0",
    kind: "Thing",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  headDigest: `sha256:${"d".repeat(64)}`,
  implementationDigest: `sha256:${"c".repeat(64)}`,
  lifecycleOperation: "create",
  mode: "mutation",
  packageDigest: `sha256:${"b".repeat(64)}`,
  protocolGeneration: 1,
  version: "takoserver.takoform-accepted-authority@v1",
});
const UNFENCED_SUMMARY = JSON.stringify({
  mode: "unfenced",
  protocolGeneration: 1,
  version: "takoserver.takoform-accepted-authority@v1",
});

function insertCurrentOperation(
  database: Database,
  id: string,
  operation: "apply" | "import" | "delete",
  acceptedAuthorityJson?: string,
): void {
  const columns = [
    "id",
    "protocol_generation",
    "tenant_id",
    "principal_id",
    "operation",
    "phase",
    "request_path",
    "request_query",
    "request_headers_json",
    "request_body_json",
    "fingerprint",
    "replay_key",
    "target_space",
    "target_api_version",
    "target_kind",
    "target_name",
    "target_form_ref_json",
    "accepted_uid",
    "accepted_generation",
    "accepted_revision",
    "resource_uid",
    "polls_remaining",
    "lease_token",
    "lease_until",
    "terminal_json",
    "committed_uid",
    "created_at",
    "updated_at",
    "expires_at",
  ];
  const values: SQLQueryBindings[] = [
    id,
    1,
    "tenant-current",
    "principal-current",
    operation,
    "pending",
    "/current",
    "",
    "{}",
    null,
    `fingerprint-${id}`,
    `replay-${id}`,
    "main",
    "edge.forms.takoform.com",
    "Thing",
    id,
    "{}",
    null,
    null,
    null,
    `uid-${id}`,
    0,
    null,
    null,
    null,
    null,
    "2026-09-20T00:00:00.000Z",
    1,
    9999999999,
  ];
  if (acceptedAuthorityJson !== undefined) {
    columns.push("accepted_authority_json");
    values.push(acceptedAuthorityJson);
  }
  database
    .query(
      `INSERT INTO tf_deferred_operations_selection_v1
         (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...values);
}

function legacySnapshot(database: Database): Record<string, unknown[]> {
  return {
    deferred: database
      .query(
        `SELECT id, tenant_id, principal_id, operation, phase, fingerprint, replay_key,
                target_name, resource_uid, created_at, updated_at, expires_at
         FROM tf_deferred_operations ORDER BY id`,
      )
      .all(),
    sagas: database
      .query(
        `SELECT operation_id, replay_key, tenant_id, fingerprint, resource_uid,
                target_name, phase, receipt_json, created_at, updated_at, expires_at
         FROM tf_provider_mutation_sagas ORDER BY operation_id`,
      )
      .all(),
    effects: database
      .query(
        `SELECT tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
                operation_mode, provider_pack_ref, provider_installation_ref, native_id,
                target_json, created_at
         FROM tf_resource_provider_effects ORDER BY effect_id`,
      )
      .all(),
    attestations: database
      .query(
        `SELECT tenant_id, resource_uid, state, closure_fence, effects_json, created_at, updated_at
         FROM tf_resource_deletion_attestations ORDER BY resource_uid`,
      )
      .all(),
  };
}

function selectionProjection(database: Database): unknown[] {
  return database
    .query(
      `SELECT id, protocol_generation, tenant_id, principal_id, operation, phase,
              request_path, request_query, request_headers_json, request_body_json,
              fingerprint, replay_key, target_space, target_api_version, target_kind,
              target_name, target_form_ref_json, accepted_uid, accepted_generation,
              accepted_revision, resource_uid, polls_remaining, lease_token, lease_until,
              terminal_json, committed_uid, created_at, updated_at, expires_at,
              worker_endpoint_origin_reservation_id
       FROM tf_deferred_operations_selection_v1 ORDER BY id`,
    )
    .all();
}

function d1ReadProcess(database: Database): SchemaProcess {
  return async (command): Promise<CommandResult> => {
    const commandIndex = command.indexOf("--command");
    if (commandIndex < 0) throw new Error(`unexpected D1 read command: ${command.join(" ")}`);
    const sql = command[commandIndex + 1];
    if (!sql) throw new Error("D1 read omitted SQL");
    const results = database.query(sql).all() as Record<string, unknown>[];
    return ok(`${JSON.stringify([{ success: true, results }])}\n`);
  };
}

async function canonicalState(database: Database): Promise<D1SchemaState> {
  return await readD1SchemaState(
    new RemoteD1("/unused/wrangler.jsonc", {
      environment: {},
      run: d1ReadProcess(database),
    }),
  );
}

function databaseProcess(database: Database, options: ProcessOptions = {}): DatabaseProcessFixture {
  const calls: string[][] = [];
  let migrationApplyCalls = 0;
  let canonicalShapeReads = 0;
  let orphanCountReads = 0;
  const run: SchemaProcess = async (command): Promise<CommandResult> => {
    calls.push([...command]);
    const key = command.join(" ");
    if (command.includes("--command")) {
      if (options.failReadbackAfterApply && migrationApplyCalls > 0) {
        return { exitCode: 1, stdout: "", stderr: "injected authoritative readback failure" };
      }
      const commandIndex = command.indexOf("--command");
      const sql = command[commandIndex + 1];
      if (!sql) throw new Error("D1 command omitted SQL");
      if (sql.includes("FROM sqlite_schema") && sql.includes("COALESCE(sql, '')")) {
        canonicalShapeReads += 1;
        options.beforeCanonicalShapeRead?.(canonicalShapeReads, database);
      }
      if (sql.includes("FROM tf_resource_provider_effects")) {
        orphanCountReads += 1;
        if (options.malformedOrphanCountAt === orphanCountReads) {
          return ok('[{"success":true,"results":[{"unexpected":0}]}]\n');
        }
      }
      try {
        const results = database.query(sql).all() as Record<string, unknown>[];
        return ok(`${JSON.stringify([{ success: true, results }])}\n`);
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: String(error) };
      }
    }
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("release/schema\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check:migrations") return ok("green\n");
    if (
      key ===
      "bun test tests/deploy-schema-accepted-authority.test.ts tests/takoform-accepted-authority-migration.test.ts"
    ) {
      return ok("green\n");
    }
    if (command.includes("migrations") && command.includes("apply")) {
      migrationApplyCalls += 1;
      const configPath = command[command.indexOf("--config") + 1];
      if (!configPath) throw new Error("migration apply omitted config");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        d1_databases: { migrations_dir: string }[];
      };
      const databaseConfig = config.d1_databases[0];
      if (!databaseConfig) throw new Error("migration apply omitted D1 config");
      const directory = resolve(dirname(configPath), databaseConfig.migrations_dir);
      const names = readdirSync(directory).sort();
      const applied = (
        database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
      ).map(({ name }) => name);
      try {
        for (const name of names.slice(applied.length)) {
          const sql = readFileSync(join(directory, name), "utf8");
          database.transaction(() => {
            database.exec(sql);
            if (options.failMigration === name) {
              throw new Error(`injected migration failure at ${name}`);
            }
            database
              .query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'fixture')")
              .run(name);
          })();
        }
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: String(error) };
      }
      options.afterMigrationApply?.(database);
      if (options.failAcknowledgementAfterCommit) {
        return { exitCode: 1, stdout: "", stderr: "injected migration acknowledgement loss" };
      }
      return ok("applied migrations\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls, migrationApplyCalls: () => migrationApplyCalls };
}

function applyOptions(
  root: string,
  fixture: DatabaseProcessFixture,
  directory = currentMigrations,
) {
  return {
    run: fixture.run,
    migrationDirectory: directory,
    outputDirectory: join(root, "work"),
    leaseRoot: join(root, "leases"),
    review: "reviewer@example.test",
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
  };
}

describe("0061 accepted-authority cutover", () => {
  test("applies exactly 0061, retains legacy rows and NULL history, and fences new admission", async () => {
    const database = createDatabaseThrough(60);
    const before = legacySnapshot(database);
    const beforeSelection = selectionProjection(database);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-apply-"));
    try {
      const fixture = databaseProcess(database);
      const result = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        INTEGRATION_TARGET,
        applyOptions(root, fixture),
      );
      expect(result).toMatchObject({
        pendingMigrations: [ACCEPTED_AUTHORITY_MIGRATION],
        appliedMigrations: MIGRATIONS.map(({ name }) => name),
        applyProviderSelectionCutover: {
          status: "ready",
          orphanOpenProviderEffectCount: 0,
        },
      });
      expect(fixture.migrationApplyCalls()).toBe(1);
      expect(legacySnapshot(database)).toEqual(before);
      expect(selectionProjection(database)).toEqual(beforeSelection);
      expect(
        database
          .query(
            `SELECT id, operation, accepted_authority_json
             FROM tf_deferred_operations_selection_v1 ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "old-null-apply", operation: "apply", accepted_authority_json: null },
        { id: "old-null-delete", operation: "delete", accepted_authority_json: null },
        { id: "old-null-import", operation: "import", accepted_authority_json: null },
      ]);
      expect(() => insertCurrentOperation(database, "old-writer-apply", "apply")).toThrow(
        "takoform_apply_acceptance_requires_authority_summary",
      );
      insertCurrentOperation(database, "new-mutation", "apply", AUTHORITY_SUMMARY);
      insertCurrentOperation(database, "new-unfenced", "apply", UNFENCED_SUMMARY);
      insertCurrentOperation(database, "new-import", "import");
      insertCurrentOperation(database, "new-delete", "delete");
      expect(() =>
        database
          .query(
            `UPDATE tf_deferred_operations_selection_v1
             SET accepted_authority_json = ? WHERE id = 'new-mutation'`,
          )
          .run(UNFENCED_SUMMARY),
      ).toThrow("takoform_accepted_authority_immutable");
      expect(
        database
          .query(
            `SELECT id, operation, accepted_authority_json
             FROM tf_deferred_operations_selection_v1
             WHERE id IN ('new-delete', 'new-import', 'new-mutation', 'new-unfenced') ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "new-delete", operation: "delete", accepted_authority_json: null },
        { id: "new-import", operation: "import", accepted_authority_json: null },
        { id: "new-mutation", operation: "apply", accepted_authority_json: AUTHORITY_SUMMARY },
        { id: "new-unfenced", operation: "apply", accepted_authority_json: UNFENCED_SUMMARY },
      ]);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rolls back one failed 0061 migration transaction and resumes exactly", async () => {
    const database = createDatabaseThrough(60);
    const before = legacySnapshot(database);
    const beforeSelection = selectionProjection(database);
    const failedRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-failed-"));
    const resumedRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-resume-"));
    try {
      const failing = databaseProcess(database, { failMigration: ACCEPTED_AUTHORITY_MIGRATION });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        INTEGRATION_TARGET,
        applyOptions(failedRoot, failing),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(String(failure)).toContain("D1 migration wave partially applied");
      expect(failing.migrationApplyCalls()).toBe(1);
      expect((await canonicalState(database)).applied.at(-1)).toBe(OPERATION_GENERATION_MIGRATION);
      expect(legacySnapshot(database)).toEqual(before);
      expect(
        database
          .query(
            "SELECT name FROM sqlite_schema WHERE name = 'tf_deferred_operations_selection_v1' AND sql LIKE '%accepted_authority_json%'",
          )
          .all(),
      ).toEqual([]);

      const resumed = databaseProcess(database);
      const result = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        INTEGRATION_TARGET,
        applyOptions(resumedRoot, resumed),
      );
      expect(result).toMatchObject({
        pendingMigrations: [ACCEPTED_AUTHORITY_MIGRATION],
        appliedMigrations: MIGRATIONS.map(({ name }) => name),
      });
      expect(resumed.migrationApplyCalls()).toBe(1);
      expect(legacySnapshot(database)).toEqual(before);
      expect(selectionProjection(database)).toEqual(beforeSelection);
      expect(
        database
          .query(
            `SELECT id, operation, accepted_authority_json
             FROM tf_deferred_operations_selection_v1 ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "old-null-apply", operation: "apply", accepted_authority_json: null },
        { id: "old-null-delete", operation: "delete", accepted_authority_json: null },
        { id: "old-null-import", operation: "import", accepted_authority_json: null },
      ]);
    } finally {
      database.close();
      rmSync(failedRoot, { recursive: true, force: true });
      rmSync(resumedRoot, { recursive: true, force: true });
    }
  });

  test("refuses an apply acknowledgement when authoritative readback fails", async () => {
    const database = createDatabaseThrough(60);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-readback-"));
    try {
      const fixture = databaseProcess(database, {
        failMigration: ACCEPTED_AUTHORITY_MIGRATION,
        failReadbackAfterApply: true,
      });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        INTEGRATION_TARGET,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("mutation");
      expect(String(failure)).toContain("authoritative readback also failed");
      expect(fixture.migrationApplyCalls()).toBe(1);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers one committed 0061 migration after a lost acknowledgement", async () => {
    const database = createDatabaseThrough(60);
    const before = legacySnapshot(database);
    const beforeSelection = selectionProjection(database);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-lost-ack-"));
    try {
      const fixture = databaseProcess(database, { failAcknowledgementAfterCommit: true });
      const result = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        INTEGRATION_TARGET,
        applyOptions(root, fixture),
      );
      expect(result).toMatchObject({
        pendingMigrations: [ACCEPTED_AUTHORITY_MIGRATION],
        appliedMigrations: MIGRATIONS.map(({ name }) => name),
        providerAcknowledgement: "provider-error-recovered-by-authoritative-readback",
      });
      expect(fixture.migrationApplyCalls()).toBe(1);
      expect((await canonicalState(database)).applied.at(-1)).toBe(ACCEPTED_AUTHORITY_MIGRATION);
      expect(legacySnapshot(database)).toEqual(before);
      expect(selectionProjection(database)).toEqual(beforeSelection);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const attestation of ["missing", "closed", "cancelled"] as const) {
    test(`uses the real D1 orphan query for ${attestation} attestation state`, async () => {
      const database = createDatabaseThrough(60, attestation);
      const root = mkdtempSync(
        join(process.env.TMPDIR ?? "/tmp", `takoserver-auth-${attestation}-`),
      );
      try {
        const fixture = databaseProcess(database);
        const status = await runD1Schema(
          { action: "status", environment: "integration", commit: COMMIT },
          INTEGRATION_TARGET,
          applyOptions(root, fixture),
        );
        expect(status).toMatchObject({
          applyProviderSelectionCutover: {
            status: "orphan_open_effects_repair_required",
            orphanOpenProviderEffectCount: 1,
          },
          readyForApply: false,
        });
        expect(
          fixture.calls.some((call) => call.join(" ").includes("tf_resource_provider_effects")),
        ).toBe(true);
      } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("fails closed on a malformed orphan count before mutation", async () => {
    const database = createDatabaseThrough(60);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-count-"));
    try {
      const fixture = databaseProcess(database, { malformedOrphanCountAt: 1 });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        INTEGRATION_TARGET,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(String(failure)).toContain("operation-generation retained effect identity");
      expect(fixture.migrationApplyCalls()).toBe(0);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks an orphan that appears at the final mutation fence", async () => {
    const database = createDatabaseThrough(60);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-final-fence-"));
    try {
      const fixture = databaseProcess(database, {
        beforeCanonicalShapeRead(read, current) {
          if (read === 3) {
            current.query("UPDATE tf_resource_deletion_attestations SET state = 'closed'").run();
          }
        },
      });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        INTEGRATION_TARGET,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(String(failure)).toContain("orphan_open_effects_repair_required");
      expect(fixture.migrationApplyCalls()).toBe(0);
      expect((await canonicalState(database)).applied.at(-1)).toBe(OPERATION_GENERATION_MIGRATION);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects bundled predecessors and protected selectors", async () => {
    for (const count of [58, 59] as const) {
      const database = createDatabaseThrough(count);
      const root = mkdtempSync(
        join(process.env.TMPDIR ?? "/tmp", `takoserver-auth-tail-${count}-`),
      );
      try {
        const fixture = databaseProcess(database);
        const status = await runD1Schema(
          { action: "status", environment: "integration", commit: COMMIT },
          INTEGRATION_TARGET,
          applyOptions(root, fixture),
        );
        expect(status).toMatchObject({
          applyProviderSelectionCutover: { status: "accepted_authority_cutover_unqualified" },
          readyForApply: false,
        });
        expect(fixture.migrationApplyCalls()).toBe(0);
      } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
      }
    }

    const database = createDatabaseThrough(60);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-selector-"));
    try {
      const fixture = databaseProcess(database);
      const failure = await runD1Schema(
        {
          action: "status",
          environment: "integration",
          commit: COMMIT,
          throughMigration: "0057",
        },
        INTEGRATION_TARGET,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(String(failure)).toContain("not the exact current wave");
      expect(fixture.migrationApplyCalls()).toBe(0);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses changed, extra, or rogue predecessor migration shapes before mutation", async () => {
    const cases = [
      {
        label: "changed hash",
        mutate(directory: string, database: Database) {
          const source = join(directory, ACCEPTED_AUTHORITY_MIGRATION);
          writeFileSync(source, `${readFileSync(source, "utf8")}\n-- drift\n`);
          void database;
        },
        message: "exact audited migration SHA-256",
      },
      {
        label: "extra source",
        mutate(directory: string, database: Database) {
          writeFileSync(join(directory, "0062_rogue.sql"), "-- rogue\n");
          void database;
        },
        message: "accepted_authority_cutover_unqualified",
      },
      {
        label: "rogue predecessor shape",
        mutate(directory: string, database: Database) {
          database.exec(
            "ALTER TABLE tf_deferred_operations_selection_v1 ADD COLUMN rogue_shape TEXT",
          );
          void directory;
        },
        message: "predecessor_schema_mismatch",
      },
    ] as const;
    for (const entry of cases) {
      const database = createDatabaseThrough(60);
      const root = mkdtempSync(
        join(process.env.TMPDIR ?? "/tmp", `takoserver-auth-${entry.label}-`),
      );
      const directory = join(root, "migrations");
      try {
        cpSync(currentMigrations, directory, { recursive: true });
        entry.mutate(directory, database);
        const fixture = databaseProcess(database);
        const failure = await runD1Schema(
          { action: "apply", environment: "integration", commit: COMMIT },
          INTEGRATION_TARGET,
          applyOptions(root, fixture, directory),
        ).catch((error) => error);
        expect(failure).toBeInstanceOf(DeployError);
        expect(String(failure)).toContain(entry.message);
        expect(fixture.calls.some((call) => call.includes("check:migrations"))).toBe(false);
        expect(fixture.migrationApplyCalls()).toBe(0);
      } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("refuses a post-0061 shape drift after the migration is acknowledged", async () => {
    const database = createDatabaseThrough(60);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-auth-post-shape-"));
    try {
      const fixture = databaseProcess(database, {
        afterMigrationApply(current) {
          current.exec(
            "ALTER TABLE tf_deferred_operations_selection_v1 ADD COLUMN rogue_shape TEXT",
          );
        },
      });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        INTEGRATION_TARGET,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("verification");
      expect(String(failure)).toContain("accepted-authority cutover post-shape differs");
      expect(fixture.migrationApplyCalls()).toBe(1);
      expect((await canonicalState(database)).applied.at(-1)).toBe(ACCEPTED_AUTHORITY_MIGRATION);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
