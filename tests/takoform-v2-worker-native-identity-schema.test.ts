import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnregisteredV2WorkerNativeIdentityMigrationCandidate } from "../scripts/deploy/v2-worker-native-identity-migration-candidate.ts";
import { executeSqliteMigrationStatements, migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Row, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  inspectV2WorkerNativeIdentityDomain,
  type V2WorkerNativeIdentityDomain,
  v2WorkerNativeIdentityDomainReady,
} from "../src/takoform-v2/worker-native-identity-schema.ts";

// Synthetic schema component fixtures copied from the allowed 0079/0087/0088
// effective source closure. This is not canonical migration 0102 or a genuine
// accepted operation, effect grant, schema ledger, native target or staging proof.
// The only alternative table delta is the native_identity CHECK.
const FIXTURE_LEGACY_TABLE = `CREATE TABLE tf_v2_worker_native_deletions (
  delete_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  source_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  resource_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  principal TEXT NOT NULL,
  space TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  delete_generation INTEGER NOT NULL CHECK (delete_generation > 0),
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  native_identity TEXT NOT NULL CHECK (
    length(native_identity) = 52 AND substr(native_identity, 1, 4) = 'v2w-' AND
    substr(native_identity, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  closure_digest TEXT NOT NULL CHECK (
    length(closure_digest) = 71 AND substr(closure_digest, 1, 7) = 'sha256:' AND
    substr(closure_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  upload_receipt TEXT CHECK (upload_receipt IS NULL OR length(upload_receipt) BETWEEN 1 AND 255),
  qualified_source_receipt TEXT CHECK (
    qualified_source_receipt IS NULL OR length(qualified_source_receipt) BETWEEN 1 AND 255
  ),
  qualification_lease_token TEXT,
  stage_lease_token TEXT NOT NULL,
  staged_at_ms INTEGER NOT NULL CHECK (staged_at_ms >= 0),
  grant_lease_token TEXT,
  granted_at_ms INTEGER CHECK (granted_at_ms IS NULL OR granted_at_ms >= staged_at_ms),
  predelete_source_receipt TEXT CHECK (
    predelete_source_receipt IS NULL OR length(predelete_source_receipt) BETWEEN 1 AND 255
  ),
  acknowledged_receipt TEXT CHECK (
    acknowledged_receipt IS NULL OR length(acknowledged_receipt) BETWEEN 1 AND 255
  ),
  confirmed_absence_receipt TEXT CHECK (
    confirmed_absence_receipt IS NULL OR length(confirmed_absence_receipt) BETWEEN 1 AND 255
  ),
  absence_lease_token TEXT,
  PRIMARY KEY (delete_operation_id, source_operation_id),
  CHECK ((qualified_source_receipt IS NULL) = (qualification_lease_token IS NULL)),
  CHECK ((grant_lease_token IS NULL) = (granted_at_ms IS NULL)),
  CHECK ((grant_lease_token IS NULL) = (predelete_source_receipt IS NULL)),
  CHECK (confirmed_absence_receipt IS NULL OR grant_lease_token IS NOT NULL OR
    absence_lease_token IS NOT NULL),
  CHECK (acknowledged_receipt IS NULL OR granted_at_ms IS NOT NULL)
)`;

const FIXTURE_OPAQUE_TABLE = `CREATE TABLE tf_v2_worker_native_deletions (
  delete_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  source_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  resource_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  principal TEXT NOT NULL,
  space TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  delete_generation INTEGER NOT NULL CHECK (delete_generation > 0),
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  native_identity TEXT NOT NULL CHECK (
    length(native_identity) BETWEEN 1 AND 255
  ),
  closure_digest TEXT NOT NULL CHECK (
    length(closure_digest) = 71 AND substr(closure_digest, 1, 7) = 'sha256:' AND
    substr(closure_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  upload_receipt TEXT CHECK (upload_receipt IS NULL OR length(upload_receipt) BETWEEN 1 AND 255),
  qualified_source_receipt TEXT CHECK (
    qualified_source_receipt IS NULL OR length(qualified_source_receipt) BETWEEN 1 AND 255
  ),
  qualification_lease_token TEXT,
  stage_lease_token TEXT NOT NULL,
  staged_at_ms INTEGER NOT NULL CHECK (staged_at_ms >= 0),
  grant_lease_token TEXT,
  granted_at_ms INTEGER CHECK (granted_at_ms IS NULL OR granted_at_ms >= staged_at_ms),
  predelete_source_receipt TEXT CHECK (
    predelete_source_receipt IS NULL OR length(predelete_source_receipt) BETWEEN 1 AND 255
  ),
  acknowledged_receipt TEXT CHECK (
    acknowledged_receipt IS NULL OR length(acknowledged_receipt) BETWEEN 1 AND 255
  ),
  confirmed_absence_receipt TEXT CHECK (
    confirmed_absence_receipt IS NULL OR length(confirmed_absence_receipt) BETWEEN 1 AND 255
  ),
  absence_lease_token TEXT,
  PRIMARY KEY (delete_operation_id, source_operation_id),
  CHECK ((qualified_source_receipt IS NULL) = (qualification_lease_token IS NULL)),
  CHECK ((grant_lease_token IS NULL) = (granted_at_ms IS NULL)),
  CHECK ((grant_lease_token IS NULL) = (predelete_source_receipt IS NULL)),
  CHECK (confirmed_absence_receipt IS NULL OR grant_lease_token IS NOT NULL OR
    absence_lease_token IS NOT NULL),
  CHECK (acknowledged_receipt IS NULL OR granted_at_ms IS NOT NULL)
)`;

const FIXTURE_INDEX = `CREATE INDEX tf_v2_worker_native_deletions_next
  ON tf_v2_worker_native_deletions(delete_operation_id, source_generation DESC, source_operation_id)`;

const FIXTURE_GUARDS = [
  [
    "tf_v2_worker_native_deletion_stage_guard",
    `CREATE TRIGGER tf_v2_worker_native_deletion_stage_guard
BEFORE INSERT ON tf_v2_worker_native_deletions
WHEN NEW.grant_lease_token IS NOT NULL OR NEW.granted_at_ms IS NOT NULL OR
  NEW.qualified_source_receipt IS NOT NULL OR NEW.qualification_lease_token IS NOT NULL OR
  NEW.predelete_source_receipt IS NOT NULL OR NEW.absence_lease_token IS NOT NULL OR
  NEW.acknowledged_receipt IS NOT NULL OR NEW.confirmed_absence_receipt IS NOT NULL OR
  NOT EXISTS (
    SELECT 1 FROM tf_v2_operations deletion
    JOIN tf_v2_resources version ON version.uid = deletion.resource_uid
    JOIN tf_v2_operations source ON source.id = NEW.source_operation_id
    JOIN tf_v2_worker_native_effects effect ON effect.operation_id = source.id
    WHERE deletion.id = NEW.delete_operation_id
      AND deletion.action = 'delete' AND deletion.status = 'reconciling'
      AND deletion.dispatch_possible = 1 AND deletion.lease_token = NEW.stage_lease_token
      AND deletion.lease_until_ms > NEW.staged_at_ms
      AND deletion.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
      AND deletion.resource_uid = NEW.resource_uid
      AND deletion.principal = NEW.principal
      AND deletion.backend_id = NEW.backend_id
      AND deletion.target_key = NEW.target_key
      AND deletion.generation = NEW.delete_generation
      AND version.principal = NEW.principal AND version.space = NEW.space
      AND version.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
      AND version.backend_id = NEW.backend_id AND version.target_key = NEW.target_key
      AND version.generation = NEW.delete_generation
      AND version.last_operation = deletion.id AND version.busy_operation = deletion.id
      AND version.phase = 'deleting' AND version.deleted_at IS NULL
      AND version.spec_json = deletion.accepted_spec_json
      AND source.resource_uid = version.uid AND source.principal = NEW.principal
      AND source.backend_id = NEW.backend_id AND source.target_key = NEW.target_key
      AND source.action IN ('create', 'update')
      AND source.generation = NEW.source_generation
      AND source.generation < NEW.delete_generation
      AND effect.resource_uid = version.uid AND effect.principal = NEW.principal
      AND effect.space = NEW.space AND effect.backend_id = NEW.backend_id
      AND effect.target_key = NEW.target_key AND effect.generation = NEW.source_generation
      AND effect.native_identity = NEW.native_identity
      AND effect.closure_digest = NEW.closure_digest
      AND effect.confirmed_receipt IS NEW.upload_receipt
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_stage_unqualified');
END`,
  ],
  [
    "tf_v2_worker_native_deletion_source_guard",
    `CREATE TRIGGER tf_v2_worker_native_deletion_source_guard
BEFORE UPDATE OF qualified_source_receipt ON tf_v2_worker_native_deletions
WHEN NEW.qualified_source_receipt IS NOT OLD.qualified_source_receipt
BEGIN
  SELECT CASE WHEN OLD.qualified_source_receipt IS NOT NULL OR
    OLD.upload_receipt IS NOT NULL OR
    NEW.qualified_source_receipt IS NULL OR NEW.qualification_lease_token IS NULL OR
    OLD.grant_lease_token IS NOT NULL OR
    NOT EXISTS (
      SELECT 1 FROM tf_v2_operations deletion
      JOIN tf_v2_resources version ON version.uid = deletion.resource_uid
      JOIN tf_v2_worker_native_effects effect
        ON effect.operation_id = OLD.source_operation_id
      WHERE deletion.id = OLD.delete_operation_id
        AND deletion.action = 'delete' AND deletion.status = 'reconciling'
        AND deletion.dispatch_possible = 1
        AND deletion.lease_token = NEW.qualification_lease_token
        AND deletion.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
        AND version.uid = OLD.resource_uid AND version.principal = OLD.principal
        AND version.space = OLD.space AND version.generation = OLD.delete_generation
        AND version.last_operation = deletion.id AND version.busy_operation = deletion.id
        AND version.phase = 'deleting' AND version.deleted_at IS NULL
        AND effect.resource_uid = OLD.resource_uid
        AND effect.native_identity = OLD.native_identity
        AND effect.closure_digest = OLD.closure_digest
        AND (effect.confirmed_receipt IS OLD.upload_receipt OR
          effect.confirmed_receipt = NEW.qualified_source_receipt)
    )
  THEN RAISE(ABORT, 'tf_v2_worker_native_deletion_source_unqualified') END;
END`,
  ],
  [
    "tf_v2_worker_native_deletion_monotonic",
    `CREATE TRIGGER tf_v2_worker_native_deletion_monotonic
BEFORE UPDATE ON tf_v2_worker_native_deletions
WHEN NEW.delete_operation_id IS NOT OLD.delete_operation_id OR
  NEW.source_operation_id IS NOT OLD.source_operation_id OR
  NEW.resource_uid IS NOT OLD.resource_uid OR NEW.principal IS NOT OLD.principal OR
  NEW.space IS NOT OLD.space OR NEW.backend_id IS NOT OLD.backend_id OR
  NEW.target_key IS NOT OLD.target_key OR
  NEW.delete_generation IS NOT OLD.delete_generation OR
  NEW.source_generation IS NOT OLD.source_generation OR
  NEW.native_identity IS NOT OLD.native_identity OR
  NEW.closure_digest IS NOT OLD.closure_digest OR
  NEW.upload_receipt IS NOT OLD.upload_receipt OR
  (OLD.qualified_source_receipt IS NOT NULL AND
    NEW.qualified_source_receipt IS NOT OLD.qualified_source_receipt) OR
  (OLD.qualification_lease_token IS NOT NULL AND
    NEW.qualification_lease_token IS NOT OLD.qualification_lease_token) OR
  NEW.stage_lease_token IS NOT OLD.stage_lease_token OR
  NEW.staged_at_ms IS NOT OLD.staged_at_ms OR
  (OLD.grant_lease_token IS NOT NULL AND NEW.grant_lease_token IS NOT OLD.grant_lease_token) OR
  (OLD.granted_at_ms IS NOT NULL AND NEW.granted_at_ms IS NOT OLD.granted_at_ms) OR
  (OLD.predelete_source_receipt IS NOT NULL AND
    NEW.predelete_source_receipt IS NOT OLD.predelete_source_receipt) OR
  (OLD.acknowledged_receipt IS NOT NULL AND
    NEW.acknowledged_receipt IS NOT OLD.acknowledged_receipt) OR
  (OLD.confirmed_absence_receipt IS NOT NULL AND
    NEW.confirmed_absence_receipt IS NOT OLD.confirmed_absence_receipt) OR
  (OLD.absence_lease_token IS NOT NULL AND
    NEW.absence_lease_token IS NOT OLD.absence_lease_token) OR
  (NEW.acknowledged_receipt IS NOT NULL AND NEW.granted_at_ms IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_immutable');
END`,
  ],
  [
    "tf_v2_worker_native_deletion_no_delete",
    `CREATE TRIGGER tf_v2_worker_native_deletion_no_delete
BEFORE DELETE ON tf_v2_worker_native_deletions
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_immutable');
END`,
  ],
  [
    "tf_v2_worker_native_deletion_send_guard",
    `CREATE TRIGGER tf_v2_worker_native_deletion_send_guard
BEFORE UPDATE OF grant_lease_token, granted_at_ms, predelete_source_receipt
ON tf_v2_worker_native_deletions
WHEN NEW.grant_lease_token IS NOT OLD.grant_lease_token OR
  NEW.granted_at_ms IS NOT OLD.granted_at_ms OR
  NEW.predelete_source_receipt IS NOT OLD.predelete_source_receipt
BEGIN
  SELECT CASE WHEN OLD.grant_lease_token IS NOT NULL OR
    OLD.granted_at_ms IS NOT NULL OR NEW.grant_lease_token IS NULL OR
    NEW.granted_at_ms IS NULL OR OLD.confirmed_absence_receipt IS NOT NULL OR
    NEW.predelete_source_receipt IS NULL OR
    (NEW.predelete_source_receipt IS NOT OLD.upload_receipt AND
      NEW.predelete_source_receipt IS NOT OLD.qualified_source_receipt) OR
    NOT EXISTS (
      SELECT 1 FROM tf_v2_operations deletion
      JOIN tf_v2_resources version ON version.uid = deletion.resource_uid
      WHERE deletion.id = OLD.delete_operation_id
        AND deletion.resource_uid = OLD.resource_uid
        AND deletion.principal = OLD.principal
        AND deletion.backend_id = OLD.backend_id AND deletion.target_key = OLD.target_key
        AND deletion.generation = OLD.delete_generation
        AND deletion.action = 'delete' AND deletion.status = 'reconciling'
        AND deletion.dispatch_possible = 1
        AND deletion.lease_token = NEW.grant_lease_token
        AND deletion.lease_until_ms > NEW.granted_at_ms
        AND deletion.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
        AND version.uid = OLD.resource_uid AND version.principal = OLD.principal
        AND version.space = OLD.space
        AND version.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
        AND version.backend_id = OLD.backend_id AND version.target_key = OLD.target_key
        AND version.generation = OLD.delete_generation
        AND version.last_operation = deletion.id AND version.busy_operation = deletion.id
        AND version.phase = 'deleting' AND version.deleted_at IS NULL
        AND version.spec_json = deletion.accepted_spec_json
    ) OR
    EXISTS (SELECT 1 FROM tf_v2_worker_native_deletions later
      WHERE later.delete_operation_id = OLD.delete_operation_id
        AND later.native_identity = OLD.native_identity
        AND later.source_generation > OLD.source_generation) OR
    EXISTS (SELECT 1 FROM tf_v2_resource_references reference
      JOIN tf_v2_resources referrer ON referrer.uid = reference.referrer_uid
      WHERE reference.target_uid = OLD.resource_uid AND referrer.deleted_at IS NULL) OR
    EXISTS (
      SELECT 1 FROM tf_v2_worker_invocations invocation
      WHERE (invocation.version_uid = OLD.resource_uid OR
        (invocation.ingress_kind = 'service' AND
          invocation.service_caller_version_uid = OLD.resource_uid))
        AND invocation.phase <> 'pre_effect_refused'
        AND invocation.no_native_dispatch_at_ms IS NULL
        AND (invocation.retired_at_ms IS NULL OR invocation.retirement_receipt_digest IS NULL)
    ) OR
    EXISTS (
      SELECT 1 FROM tf_v2_worker_native_effects effect
      WHERE effect.resource_uid = OLD.resource_uid
        AND NOT EXISTS (
          SELECT 1 FROM tf_v2_worker_native_deletions item
          WHERE item.delete_operation_id = OLD.delete_operation_id
            AND item.source_operation_id = effect.operation_id
            AND item.native_identity = effect.native_identity
            AND item.closure_digest = effect.closure_digest
            AND (item.upload_receipt IS effect.confirmed_receipt OR
              item.qualified_source_receipt = effect.confirmed_receipt)
            AND (item.upload_receipt IS NOT NULL OR item.qualified_source_receipt IS NOT NULL)
        )
    ) OR
    EXISTS (
      SELECT 1 FROM tf_v2_operations source
      WHERE source.resource_uid = OLD.resource_uid
        AND source.action IN ('create', 'update')
        AND source.status = 'succeeded' AND source.effect = 'complete'
        AND NOT EXISTS (
          SELECT 1 FROM tf_v2_worker_native_effects effect
          WHERE effect.operation_id = source.id
        )
    )
  THEN RAISE(ABORT, 'tf_v2_worker_native_deletion_send_unqualified') END;
END`,
  ],
  [
    "tf_v2_worker_native_deletion_presend_absence_guard",
    `CREATE TRIGGER tf_v2_worker_native_deletion_presend_absence_guard
BEFORE UPDATE OF confirmed_absence_receipt ON tf_v2_worker_native_deletions
WHEN NEW.confirmed_absence_receipt IS NOT OLD.confirmed_absence_receipt
  AND OLD.grant_lease_token IS NULL
BEGIN
  SELECT CASE WHEN OLD.confirmed_absence_receipt IS NOT NULL OR
    NEW.confirmed_absence_receipt IS NULL OR OLD.upload_receipt IS NULL OR
    NEW.absence_lease_token IS NULL OR
    NOT EXISTS (
      SELECT 1 FROM tf_v2_operations deletion
      JOIN tf_v2_resources version ON version.uid = deletion.resource_uid
      WHERE deletion.id = OLD.delete_operation_id
        AND deletion.resource_uid = OLD.resource_uid
        AND deletion.principal = OLD.principal AND version.principal = OLD.principal
        AND version.space = OLD.space
        AND deletion.backend_id = OLD.backend_id AND version.backend_id = OLD.backend_id
        AND deletion.target_key = OLD.target_key AND version.target_key = OLD.target_key
        AND deletion.generation = OLD.delete_generation
        AND deletion.action = 'delete' AND deletion.status = 'reconciling'
        AND deletion.dispatch_possible = 1
        AND deletion.lease_token = NEW.absence_lease_token
        AND deletion.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
        AND version.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
        AND version.generation = OLD.delete_generation
        AND version.phase = 'deleting' AND version.deleted_at IS NULL
        AND version.last_operation = deletion.id AND version.busy_operation = deletion.id
        AND version.spec_json = deletion.accepted_spec_json
    ) OR
    EXISTS (SELECT 1 FROM tf_v2_resource_references reference
      JOIN tf_v2_resources referrer ON referrer.uid = reference.referrer_uid
      WHERE reference.target_uid = OLD.resource_uid AND referrer.deleted_at IS NULL) OR
    EXISTS (SELECT 1 FROM tf_v2_worker_invocations invocation
      WHERE (invocation.version_uid = OLD.resource_uid OR
        (invocation.ingress_kind = 'service' AND
          invocation.service_caller_version_uid = OLD.resource_uid))
        AND invocation.phase <> 'pre_effect_refused'
        AND invocation.no_native_dispatch_at_ms IS NULL
        AND (invocation.retired_at_ms IS NULL OR invocation.retirement_receipt_digest IS NULL)) OR
    EXISTS (SELECT 1 FROM tf_v2_worker_native_effects effect
      WHERE effect.resource_uid = OLD.resource_uid AND NOT EXISTS (
        SELECT 1 FROM tf_v2_worker_native_deletions item
        WHERE item.delete_operation_id = OLD.delete_operation_id
          AND item.source_operation_id = effect.operation_id
          AND item.native_identity = effect.native_identity
          AND item.closure_digest = effect.closure_digest
          AND (item.upload_receipt IS effect.confirmed_receipt OR
            item.qualified_source_receipt = effect.confirmed_receipt))) OR
    EXISTS (SELECT 1 FROM tf_v2_operations source
      WHERE source.resource_uid = OLD.resource_uid
        AND source.action IN ('create','update')
        AND source.status = 'succeeded' AND source.effect = 'complete'
        AND NOT EXISTS (SELECT 1 FROM tf_v2_worker_native_effects effect
          WHERE effect.operation_id = source.id))
  THEN RAISE(ABORT, 'tf_v2_worker_native_deletion_presend_absence_unqualified') END;
END`,
  ],
  [
    "tf_v2_worker_native_deletion_sqlite_drain_send_guard",
    `CREATE TRIGGER tf_v2_worker_native_deletion_sqlite_drain_send_guard
BEFORE UPDATE OF grant_lease_token, granted_at_ms, predelete_source_receipt
ON tf_v2_worker_native_deletions
WHEN (NEW.grant_lease_token IS NOT OLD.grant_lease_token OR
  NEW.granted_at_ms IS NOT OLD.granted_at_ms OR
  NEW.predelete_source_receipt IS NOT OLD.predelete_source_receipt)
  AND EXISTS (
    SELECT 1 FROM tf_v2_worker_invocations i
    WHERE (i.version_uid = OLD.resource_uid OR
      (i.ingress_kind = 'service' AND i.service_caller_version_uid = OLD.resource_uid))
      AND i.sqlite_drain_state = 'pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_sqlite_drain_pending');
END`,
  ],
  [
    "tf_v2_worker_native_deletion_sqlite_drain_absence_guard",
    `CREATE TRIGGER tf_v2_worker_native_deletion_sqlite_drain_absence_guard
BEFORE UPDATE OF confirmed_absence_receipt ON tf_v2_worker_native_deletions
WHEN NEW.confirmed_absence_receipt IS NOT OLD.confirmed_absence_receipt
  AND EXISTS (
    SELECT 1 FROM tf_v2_worker_invocations i
    WHERE (i.version_uid = OLD.resource_uid OR
      (i.ingress_kind = 'service' AND i.service_caller_version_uid = OLD.resource_uid))
      AND i.sqlite_drain_state = 'pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_sqlite_drain_pending');
END`,
  ],
] as const;

const TABLE = "tf_v2_worker_native_deletions";

function installGuards(db: Database): void {
  for (const [, sql] of FIXTURE_GUARDS) db.exec(sql);
}

function fixture(
  domain: V2WorkerNativeIdentityDomain,
  options: { table?: string; index?: string; guards?: boolean; missing?: boolean } = {},
) {
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    PRAGMA ignore_check_constraints = OFF;
    CREATE TABLE tf_v2_operations(id TEXT PRIMARY KEY);
    CREATE TABLE tf_v2_resources(uid TEXT PRIMARY KEY, other_uid TEXT UNIQUE);`);
  if (!options.missing) {
    db.exec(
      options.table ?? (domain === "opaque255" ? FIXTURE_OPAQUE_TABLE : FIXTURE_LEGACY_TABLE),
    );
    db.exec(options.index ?? FIXTURE_INDEX);
    if (options.guards !== false) installGuards(db);
  }
  const actual = createSqliteSql(db);
  let reads = 0;
  let writes = 0;
  const sql: Sql = {
    async query(statement, params) {
      reads += 1;
      return await actual.query(statement, params);
    },
    async run() {
      writes += 1;
      throw new Error("inspector attempted a write");
    },
    async batch() {
      writes += 1;
      throw new Error("inspector attempted a batch");
    },
  };
  return { db, sql, reads: () => reads, writes: () => writes, close: () => db.close() };
}

function responseSql(rows: readonly Row[]): Sql {
  return {
    async query() {
      return rows;
    },
    async run() {
      throw new Error("unexpected write");
    },
    async batch() {
      throw new Error("unexpected batch");
    },
  };
}

function insertUntriggeredShapeRow(db: Database, identity: string, sequence: number): void {
  const deletion = `component-delete-${sequence}`;
  const source = `component-source-${sequence}`;
  db.query("INSERT INTO tf_v2_operations(id) VALUES (?), (?)").run(deletion, source);
  db.query("INSERT OR IGNORE INTO tf_v2_resources(uid) VALUES ('component-resource')").run();
  db.query(`INSERT INTO tf_v2_worker_native_deletions (
    delete_operation_id, source_operation_id, resource_uid, principal, space,
    backend_id, target_key, delete_generation, source_generation, native_identity,
    closure_digest, stage_lease_token, staged_at_ms
  ) VALUES (?, ?, 'component-resource', 'component-principal', 'component-space',
    'component-backend', 'component-target', 2, 1, ?, ?, 'component-lease', 0)`).run(
    deletion,
    source,
    identity,
    `sha256:${"a".repeat(64)}`,
  );
}

test("native identity domain: exact legacy schema remains legacy and read-only", async () => {
  const f = fixture("legacy_v2w52");
  try {
    expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBe("legacy_v2w52");
    expect(f.reads()).toBe(1);
    expect(f.writes()).toBe(0);
    expect(
      f.db.query(`SELECT 1 WHERE ${v2WorkerNativeIdentityDomainReady("opaque255")}`).all(),
    ).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("native identity domain: synthetic one-CHECK widening preserves the opaque bounds", async () => {
  const f = fixture("opaque255", { guards: false });
  try {
    // These raw rows exercise only the table CHECK before guard installation.
    // Stub rows never represent a Core accepted Operation or a native permission.
    for (const [i, identity] of ["x", "x".repeat(255), `v2w-${"a".repeat(48)}`, "é"].entries()) {
      insertUntriggeredShapeRow(f.db, identity, i);
    }
    expect(() => insertUntriggeredShapeRow(f.db, "", 10)).toThrow();
    expect(() => insertUntriggeredShapeRow(f.db, "x".repeat(256), 11)).toThrow();
    installGuards(f.db);
    expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBe("opaque255");
    expect(f.writes()).toBe(0);
    expect(
      f.db.query(`SELECT 1 WHERE ${v2WorkerNativeIdentityDomainReady("legacy_v2w52")}`).all(),
    ).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("native identity domain: absent or malformed readback fails closed without mutation", async () => {
  const f = fixture("opaque255", { missing: true });
  try {
    expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBeNull();
    expect(f.reads()).toBe(1);
    expect(f.writes()).toBe(0);
  } finally {
    f.close();
  }
  const malformed: readonly (readonly Row[])[] = [
    [],
    [{ domain: "opaque255" }, { domain: "legacy_v2w52" }],
    [{ domain: "unknown" }],
    [{ domain: 1 }],
    [{ domain: "opaque255", ready: true }],
    [
      {
        get domain() {
          return "opaque255";
        },
      },
    ],
  ];
  for (const rows of malformed) {
    expect(await inspectV2WorkerNativeIdentityDomain(responseSql(rows))).toBeNull();
  }
  const unsupported: Sql = {
    ...responseSql([]),
    async query() {
      throw new Error("unsupported introspection");
    },
  };
  expect(await inspectV2WorkerNativeIdentityDomain(unsupported)).toBeNull();
});

test("native identity domain: every guard needs its actual body and table attachment", async () => {
  for (const [name, definition] of FIXTURE_GUARDS) {
    for (const change of ["missing", "weakened", "foreign"] as const) {
      const f = fixture("opaque255");
      try {
        f.db.exec(`DROP TRIGGER ${name}`);
        if (change === "weakened") {
          const weaker = definition.includes("\nWHEN")
            ? definition.replace(/\nWHEN[\s\S]*?\nBEGIN/u, "\nWHEN 0\nBEGIN")
            : definition.replace("\nBEGIN", "\nWHEN 0\nBEGIN");
          expect(weaker).not.toBe(definition);
          f.db.exec(weaker);
        }
        if (change === "foreign") {
          f.db.exec(
            FIXTURE_OPAQUE_TABLE.replace(`CREATE TABLE ${TABLE}`, "CREATE TABLE component_foreign"),
          );
          const foreign = definition.replace(`ON ${TABLE}`, "ON component_foreign");
          expect(foreign).not.toBe(definition);
          f.db.exec(foreign);
        }
        expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBeNull();
        expect(f.writes()).toBe(0);
      } finally {
        f.close();
      }
    }
  }
  const extra = fixture("opaque255");
  try {
    extra.db.exec(`CREATE TRIGGER component_extra BEFORE INSERT ON ${TABLE} BEGIN SELECT 1; END`);
    expect(await inspectV2WorkerNativeIdentityDomain(extra.sql)).toBeNull();
  } finally {
    extra.close();
  }
});

test("native identity domain: opaque CHECK text cannot replace the complete physical shape", async () => {
  const changedTables = [
    FIXTURE_OPAQUE_TABLE.replace("source_generation > 0", "source_generation >= 0"),
    FIXTURE_OPAQUE_TABLE.replace("principal TEXT NOT NULL", "principal BLOB NOT NULL"),
    FIXTURE_OPAQUE_TABLE.replace("principal TEXT NOT NULL", "principal TEXT"),
    FIXTURE_OPAQUE_TABLE.replace(
      "principal TEXT NOT NULL",
      "principal TEXT NOT NULL DEFAULT 'fallback'",
    ),
    FIXTURE_OPAQUE_TABLE.replace(
      "PRIMARY KEY (delete_operation_id, source_operation_id)",
      "PRIMARY KEY (source_operation_id, delete_operation_id)",
    ),
    FIXTURE_OPAQUE_TABLE.replace(
      "REFERENCES tf_v2_resources(uid)",
      "REFERENCES tf_v2_resources(other_uid)",
    ),
    FIXTURE_OPAQUE_TABLE.replace(
      "REFERENCES tf_v2_resources(uid)",
      "REFERENCES tf_v2_resources(uid) ON DELETE CASCADE",
    ),
    FIXTURE_OPAQUE_TABLE.replace("  PRIMARY KEY", "  component_extra TEXT,\n  PRIMARY KEY"),
  ];
  for (const table of changedTables) {
    expect(table).not.toBe(FIXTURE_OPAQUE_TABLE);
    const f = fixture("opaque255", { table });
    try {
      expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBeNull();
    } finally {
      f.close();
    }
  }
  const changedIndex = fixture("opaque255", {
    index: FIXTURE_INDEX.replace("source_generation DESC", "source_generation ASC"),
  });
  try {
    expect(await inspectV2WorkerNativeIdentityDomain(changedIndex.sql)).toBeNull();
  } finally {
    changedIndex.close();
  }
  const incoming = fixture("opaque255");
  try {
    incoming.db.exec(`CREATE TABLE component_incoming (
      deletion TEXT, source TEXT,
      FOREIGN KEY(deletion, source) REFERENCES ${TABLE}(delete_operation_id, source_operation_id))`);
    expect(await inspectV2WorkerNativeIdentityDomain(incoming.sql)).toBeNull();
  } finally {
    incoming.close();
  }
});

test("native identity domain: holding, copy, assertion and temporary shadows refuse", async () => {
  const markers = [
    "_tf_v2_m0102_native_deletions_holding",
    "_tf_v2_m0102_assert",
    "tf_v2_worker_invocations_next",
  ];
  for (const name of markers) {
    for (const temporary of [false, true]) {
      const f = fixture("opaque255");
      try {
        f.db.exec(`CREATE ${temporary ? "TEMP " : ""}TABLE ${name}(component INTEGER)`);
        expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBeNull();
        expect(
          f.db
            .query(
              `SELECT name FROM ${temporary ? "sqlite_temp_schema" : "sqlite_schema"} WHERE name = ?`,
            )
            .all(name),
        ).toHaveLength(1);
      } finally {
        f.close();
      }
    }
  }
  const shadow = fixture("opaque255");
  try {
    shadow.db.exec(`CREATE TEMP TABLE ${TABLE}(component INTEGER)`);
    expect(
      shadow.db.query("SELECT name FROM pragma_table_xinfo(?, 'main')").all(TABLE),
    ).toHaveLength(22);
    expect(
      shadow.db.query("SELECT name FROM pragma_table_xinfo(?, 'temp')").all(TABLE),
    ).toHaveLength(1);
    expect(
      shadow.db.query("SELECT name FROM pragma_index_list(?, 'main')").all(TABLE),
    ).toHaveLength(2);
    expect(
      shadow.db.query("SELECT name FROM pragma_index_list(?, 'temp')").all(TABLE),
    ).toHaveLength(0);
    expect(
      shadow.db.query("SELECT id FROM pragma_foreign_key_list(?, 'main')").all(TABLE),
    ).toHaveLength(3);
    expect(
      shadow.db.query("SELECT id FROM pragma_foreign_key_list(?, 'temp')").all(TABLE),
    ).toHaveLength(0);
    expect(await inspectV2WorkerNativeIdentityDomain(shadow.sql)).toBeNull();
  } finally {
    shadow.close();
  }
  const trigger = fixture("opaque255");
  try {
    trigger.db.exec(
      `CREATE TEMP TRIGGER component_temp BEFORE INSERT ON main.${TABLE} BEGIN SELECT 1; END`,
    );
    expect(await inspectV2WorkerNativeIdentityDomain(trigger.sql)).toBeNull();
  } finally {
    trigger.close();
  }
});

test("native identity domain: enforcement and runtime enum inputs are closed", async () => {
  for (const setting of ["foreign_keys = OFF", "ignore_check_constraints = ON"]) {
    const f = fixture("opaque255");
    try {
      f.db.exec(`PRAGMA ${setting}`);
      expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBeNull();
    } finally {
      f.close();
    }
  }
  for (const domain of ["unknown", "opaque255); SELECT 1;--", null, {}]) {
    expect(() => Reflect.apply(v2WorkerNativeIdentityDomainReady, undefined, [domain])).toThrow();
  }
});

test("native identity domain: one snapshot and the owning statement see fresh schema", async () => {
  const f = fixture("opaque255");
  const first = FIXTURE_GUARDS[0];
  try {
    expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBe("opaque255");
    const selectedBeforeChange = v2WorkerNativeIdentityDomainReady("opaque255");
    f.db.exec("CREATE TABLE component_effect_probe(value INTEGER)");
    let calls = 0;
    const delayed: Sql = {
      ...f.sql,
      async query(statement, params) {
        calls += 1;
        await Promise.resolve();
        f.db.exec(`DROP TRIGGER ${first[0]}`);
        return await f.sql.query(statement, params);
      },
    };
    expect(await inspectV2WorkerNativeIdentityDomain(delayed)).toBeNull();
    expect(calls).toBe(1);
    // A scratch insertion demonstrates statement-time reuse, not a Core grant.
    f.db.exec(`INSERT INTO component_effect_probe SELECT 1 WHERE ${selectedBeforeChange}`);
    expect(f.db.query("SELECT value FROM component_effect_probe").all()).toHaveLength(0);
    f.db.exec(first[1]);
    expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBe("opaque255");
    f.db.exec(`INSERT INTO component_effect_probe SELECT 1 WHERE ${selectedBeforeChange}`);
    expect(f.db.query("SELECT value FROM component_effect_probe").all()).toEqual([{ value: 1 }]);
    expect(f.writes()).toBe(0);
  } finally {
    f.close();
  }
});

test("native identity domain: MAIN incoming FK cannot be hidden by a TEMP referrer shadow", async () => {
  const f = fixture("opaque255");
  try {
    f.db.exec(`CREATE TABLE component_incoming (
      deletion TEXT, source TEXT,
      FOREIGN KEY(deletion, source) REFERENCES ${TABLE}(delete_operation_id, source_operation_id));
      CREATE TEMP TABLE component_incoming(component INTEGER);`);
    expect(
      f.db.query("SELECT id FROM pragma_foreign_key_list('component_incoming', 'main')").all(),
    ).toHaveLength(2);
    expect(
      f.db.query("SELECT id FROM pragma_foreign_key_list('component_incoming', 'temp')").all(),
    ).toHaveLength(0);
    const mainOwnedPredicate = v2WorkerNativeIdentityDomainReady("opaque255");
    expect(f.db.query(`SELECT 1 WHERE ${mainOwnedPredicate}`).all()).toHaveLength(0);
    expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBeNull();
    // This reconstructs the frozen prior unqualified physical predicate only.
    // It is a schema negative control, never a Core/native send authority.
    const unqualified = mainOwnedPredicate.replaceAll(", 'main')", ")");
    expect(unqualified).not.toBe(mainOwnedPredicate);
    expect(f.db.query(`SELECT 1 WHERE ${unqualified}`).all()).toHaveLength(1);
    expect(f.reads()).toBe(1);
    expect(f.writes()).toBe(0);
  } finally {
    f.close();
  }
});

// Legacy component fixtures use the real allowed 0001–0088 schema and owning
// statement executor. Binding actual100 filename/blob metadata cannot make
// those fixtures actual100→102 qualification. The separate current fixture
// below uses normal owning migration machinery, not manually read protected SQL.
// All raw rows remain synthetic: never actual final0101, native permission,
// canonical0102 registration/application, or staging qualification.
function candidateFixture(file = ":memory:"): Database {
  const db = new Database(file);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = OFF;");
    const directory = join(import.meta.dir, "../migrations");
    const names = readdirSync(directory)
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 88)
      .sort();
    expect(names).toHaveLength(88);
    for (const name of names)
      executeSqliteMigrationStatements(db, readFileSync(join(directory, name), "utf8"));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function candidateCurrentFixture(): Database {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = OFF;");
    // Normal own machinery consumes its registered source automatically. No
    // protected SQL is copied/read manually, and no101/102 ledger row is added.
    const report = migrateSqlite(db, { stripeMode: "test" });
    expect(report.applied).toHaveLength(100);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function applyCandidate(
  db: Database,
  statements = buildUnregisteredV2WorkerNativeIdentityMigrationCandidate().statements,
): void {
  try {
    executeSqliteMigrationStatements(db, "BEGIN IMMEDIATE;");
    executeSqliteMigrationStatements(db, statements.join("\n"));
    executeSqliteMigrationStatements(db, "COMMIT;");
  } catch (error) {
    // INSERT OR ROLLBACK may already have ended the transaction. Cleanup must
    // never replace the original owning execution error or continue the unit.
    try {
      executeSqliteMigrationStatements(db, "ROLLBACK;");
    } catch {
      // The original error is rethrown below, including after an ended rollback.
    }
    throw error;
  }
}

function candidateState(db: Database) {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const data = tables.map(({ name }) => {
    const identifier = `"${name.replaceAll('"', '""')}"`;
    const columns = db.query<{ name: string }, []>(`PRAGMA main.table_info(${identifier})`).all();
    const values = columns
      .map(({ name: column }) => {
        const quoted = `"${column.replaceAll('"', '""')}"`;
        return `typeof(${quoted}), quote(${quoted})`;
      })
      .join(", ");
    return {
      name,
      rows: db.query(`SELECT ${values} FROM main.${identifier}`).values(),
    };
  });
  return {
    schema: db
      .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
        "SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name",
      )
      .all(),
    temporary: db
      .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
        "SELECT type, name, tbl_name, sql FROM sqlite_temp_schema ORDER BY type, name",
      )
      .all(),
    rows: db
      .query(`SELECT CAST(rowid AS TEXT), * FROM main.${TABLE} ORDER BY rowid`)
      .values()
      .map((row) =>
        row.map((value) =>
          value instanceof Uint8Array
            ? { blob: Buffer.from(value).toString("hex") }
            : typeof value === "bigint"
              ? { bigint: value.toString() }
              : value,
        ),
      ),
    data,
    foreignKeys: db.query("PRAGMA main.foreign_key_check").all(),
    foreignKeysEnabled: db.query("PRAGMA foreign_keys").all(),
    ignoredChecks: db.query("PRAGMA ignore_check_constraints").all(),
    inTransaction: db.inTransaction,
  };
}

const CANDIDATE_DIGEST = `sha256:${"a".repeat(64)}`;
const CANDIDATE_IDENTITY = `v2w-${"b".repeat(48)}`;
const CANDIDATE_STAGE = `INSERT INTO ${TABLE}(
  rowid, delete_operation_id, source_operation_id, resource_uid, principal,
  space, backend_id, target_key, delete_generation, source_generation,
  native_identity, closure_digest, upload_receipt, stage_lease_token, staged_at_ms
) VALUES (?, ?, ?, ?, 'synthetic-org', 'integration', 'candidate-backend',
  'integration-candidate', 2, 1, ?, ?, ?, ?, ?)`;

function candidateResource(db: Database, id: string, form = "WorkerVersion/0.5.0") {
  db.query(`INSERT INTO tf_v2_resources(
    uid, principal, form_url, space, name, backend_id, target_key, active_name,
    generation, phase, spec_json, last_operation, busy_operation
  ) VALUES (?, 'synthetic-org', ?, 'integration', ?, 'candidate-backend',
    'integration-candidate', ?, 1, 'pending', '{}', ?, ?)`).run(
    id,
    `https://edge.forms.takoform.com/forms/${form}/`,
    id,
    id,
    `source-${id}`,
    `source-${id}`,
  );
}

function candidateOperation(
  db: Database,
  id: string,
  resource: string,
  action: string,
  generation: number,
  token: string,
) {
  db.query(`INSERT INTO tf_v2_operations(
    id, resource_uid, principal, replay_key, request_fingerprint, action, generation,
    status, effect, created_at, updated_at, retain_until, backend_id, target_key,
    backend_key, accepted_spec_json, dispatch_possible, lease_token, lease_until_ms
  ) VALUES (?, ?, 'synthetic-org', ?, 'candidate-fingerprint', ?, ?, 'reconciling',
    'unknown', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z',
    '2026-10-16T00:00:00Z', 'candidate-backend', 'integration-candidate', ?, '{}', 1, ?, ?)`).run(
    id,
    resource,
    `replay-${id}`,
    action,
    generation,
    `backend-${id}`,
    token,
    Date.now() + 3_600_000,
  );
}

function candidateDeletion(
  db: Database,
  id: string,
  identity = CANDIDATE_IDENTITY,
  receipt: string | null = `upload-${id}`,
) {
  candidateResource(db, id);
  const source = `source-${id}`;
  const deletion = `delete-${id}`;
  const token = `delete-token-${id}`;
  const sourceToken = `source-token-${id}`;
  candidateOperation(db, source, id, "create", 1, sourceToken);
  db.query(`INSERT INTO tf_v2_worker_native_effects(
    operation_id, resource_uid, principal, space, backend_key, backend_id, target_key,
    generation, native_identity, closure_digest, grant_lease_token, granted_at_ms
  ) VALUES (?, ?, 'synthetic-org', 'integration', ?, 'candidate-backend',
    'integration-candidate', 1, ?, ?, ?, 0)`).run(
    source,
    id,
    `backend-${source}`,
    identity,
    CANDIDATE_DIGEST,
    sourceToken,
  );
  if (receipt !== null)
    db.query(
      "UPDATE tf_v2_worker_native_effects SET confirmed_receipt = ? WHERE operation_id = ?",
    ).run(receipt, source);
  db.query(
    "UPDATE tf_v2_operations SET status = 'succeeded', effect = 'complete' WHERE id = ?",
  ).run(source);
  db.query(
    "UPDATE tf_v2_resources SET generation = 2, phase = 'deleting', last_operation = ?, busy_operation = ? WHERE uid = ?",
  ).run(deletion, deletion, id);
  candidateOperation(db, deletion, id, "delete", 2, token);
  return { id, source, deletion, token, identity, receipt };
}

function candidateStage(
  db: Database,
  item: ReturnType<typeof candidateDeletion>,
  rowid: bigint,
  stagedAt = 0,
) {
  db.query(CANDIDATE_STAGE).run(
    rowid,
    item.deletion,
    item.source,
    item.id,
    item.identity,
    CANDIDATE_DIGEST,
    item.receipt,
    item.token,
    stagedAt,
  );
}

function candidateGrant(db: Database, item: ReturnType<typeof candidateDeletion>) {
  db.query(`UPDATE ${TABLE} SET grant_lease_token = ?, granted_at_ms = 1,
    predelete_source_receipt = ? WHERE delete_operation_id = ?`).run(
    item.token,
    item.receipt,
    item.deletion,
  );
}

function candidateHistory(db: Database) {
  const staged = candidateDeletion(db, "candidate-staged");
  candidateStage(db, staged, -7n, 0.5);
  const qualified = candidateDeletion(db, "candidate-qualified", CANDIDATE_IDENTITY, null);
  candidateStage(db, qualified, 0n);
  db.query(`UPDATE ${TABLE} SET qualified_source_receipt = 'qualified-receipt',
    qualification_lease_token = ? WHERE delete_operation_id = ?`).run(
    qualified.token,
    qualified.deletion,
  );
  const granted = candidateDeletion(db, "candidate-granted");
  candidateStage(db, granted, 42n);
  candidateGrant(db, granted);
  const acknowledged = candidateDeletion(db, "candidate-acknowledged");
  candidateStage(db, acknowledged, 9007199254740993n);
  candidateGrant(db, acknowledged);
  db.query(`UPDATE ${TABLE} SET acknowledged_receipt = X'0010ff',
    confirmed_absence_receipt = X'01aa' WHERE delete_operation_id = ?`).run(acknowledged.deletion);
  const absent = candidateDeletion(db, "candidate-absent");
  candidateStage(db, absent, 77n);
  db.query(`UPDATE ${TABLE} SET confirmed_absence_receipt = 'owned-native-absence',
    absence_lease_token = ? WHERE delete_operation_id = ?`).run(absent.token, absent.deletion);
  const pending = candidateDeletion(db, "candidate-pending");
  candidateStage(db, pending, 78n);
  candidateResource(db, "candidate-caller", "ModuleWorker/0.3.0");
  candidateResource(db, "candidate-deployment", "WorkerDeployment/0.4.0");
  db.query(`INSERT INTO tf_v2_worker_invocations(
    invocation_id, custody_token, backend_id, target_key, principal, space, worker_uid,
    deployment_uid, deployment_generation, source_operation_id, ingress_kind,
    service_caller_worker_uid, service_caller_version_uid, service_caller_version_generation,
    service_caller_version_operation_id, service_binding_name, service_caller_execution_ref,
    version_uid, version_generation, version_operation_id, native_identity, closure_digest,
    confirmed_receipt, admitted_at_ms, phase, send_authorized_at_ms
  ) VALUES ('candidate-pending-sql', 'candidate-custody-token', 'candidate-backend',
    'integration-candidate', 'synthetic-org', 'integration', 'candidate-caller',
    'candidate-deployment', 1, ?, 'service', 'candidate-caller', ?, 1, ?, 'SQL',
    'synthetic-held-context', ?, 1, ?, ?, ?, 'synthetic-native-receipt', 0, 'send_authorized', 1)`).run(
    pending.source,
    pending.id,
    pending.source,
    pending.id,
    pending.source,
    CANDIDATE_IDENTITY,
    CANDIDATE_DIGEST,
  );
  db.query(
    "UPDATE tf_v2_worker_invocations SET sqlite_drain_state = 'pending' WHERE invocation_id = 'candidate-pending-sql'",
  ).run();
  db.query("UPDATE tf_v2_operations SET lease_until_ms = 0 WHERE id = ?").run(staged.deletion);
  db.exec(
    "CREATE TABLE component_unrelated(value); INSERT INTO component_unrelated VALUES (NULL), (42), (1.5), ('text'), (X'00ff');",
  );
  return { staged, qualified, granted, acknowledged, absent, pending };
}

function assertCandidateCustody(db: Database, history: ReturnType<typeof candidateHistory>) {
  expect(() =>
    db
      .query(`UPDATE ${TABLE} SET native_identity = 'forged' WHERE delete_operation_id = ?`)
      .run(history.granted.deletion),
  ).toThrow("immutable");
  expect(() =>
    db.query(`DELETE FROM ${TABLE} WHERE delete_operation_id = ?`).run(history.staged.deletion),
  ).toThrow("immutable");
  expect(() => candidateGrant(db, history.staged)).toThrow("unqualified");
  expect(() => candidateGrant(db, history.pending)).toThrow("sqlite_drain_pending");
  expect(() =>
    db
      .query(`UPDATE ${TABLE} SET confirmed_absence_receipt = 'unproved',
    absence_lease_token = ? WHERE delete_operation_id = ?`)
      .run(history.pending.token, history.pending.deletion),
  ).toThrow("sqlite_drain_pending");
}

test("native identity candidate: only the CHECK changes while historical storage and custody survive", async () => {
  const db = candidateFixture();
  try {
    const candidate = buildUnregisteredV2WorkerNativeIdentityMigrationCandidate();
    expect(candidate.kind).toBe("unregistered-v2-worker-native-identity-candidate");
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(
      candidate.statements.some((statement) => /^\s*(?:BEGIN|COMMIT)\b/iu.test(statement)),
    ).toBe(false);
    const history = candidateHistory(db);
    assertCandidateCustody(db, history);
    expect(
      db
        .query<{ type: string }, []>(`SELECT typeof(native_identity) AS type FROM ${TABLE}
      UNION SELECT typeof(staged_at_ms) FROM ${TABLE}
      UNION SELECT typeof(granted_at_ms) FROM ${TABLE}
      UNION SELECT typeof(acknowledged_receipt) FROM ${TABLE} ORDER BY type`)
        .all(),
    ).toEqual([
      { type: "blob" },
      { type: "integer" },
      { type: "null" },
      { type: "real" },
      { type: "text" },
    ]);
    const scoped = candidateDeletion(db, "candidate-scoped", `integration-${"c".repeat(51)}`);
    const legacyWriter = db.query(CANDIDATE_STAGE);
    expect(() => candidateStage(db, scoped, 90n)).toThrow("CHECK");
    const before = candidateState(db);
    applyCandidate(db);
    const after = candidateState(db);
    expect(after.rows).toEqual(before.rows);
    expect(after.data).toEqual(before.data);
    expect(after.temporary).toEqual(before.temporary);
    expect(after.foreignKeys).toEqual([]);
    expect(after.inTransaction).toBe(false);
    expect(after.schema.filter((row) => row.name !== TABLE)).toEqual(
      before.schema.filter((row) => row.name !== TABLE),
    );
    const changed = db
      .query<{ sql: string }, [string]>("SELECT sql FROM main.sqlite_schema WHERE name = ?")
      .get(TABLE);
    expect(changed?.sql).toBe(FIXTURE_OPAQUE_TABLE);
    expect(await inspectV2WorkerNativeIdentityDomain(createSqliteSql(db))).toBe("opaque255");
    assertCandidateCustody(db, history);
    const legacy = candidateDeletion(db, "candidate-legacy-writer");
    legacyWriter.run(
      91n,
      legacy.deletion,
      legacy.source,
      legacy.id,
      legacy.identity,
      CANDIDATE_DIGEST,
      legacy.receipt,
      legacy.token,
      0,
    );
    candidateStage(db, scoped, 90n);
    for (const [i, identity] of ["x", "x".repeat(255), "統合-prefix"].entries())
      candidateStage(db, candidateDeletion(db, `candidate-bound-${i}`, identity), BigInt(100 + i));
    expect(() => candidateDeletion(db, "candidate-empty", "")).toThrow("CHECK");
    expect(() => candidateDeletion(db, "candidate-oversized", "x".repeat(256))).toThrow("CHECK");
  } finally {
    db.close();
  }
});

test("native identity candidate: normal registered100 component retains every table and original ledger", async () => {
  const db = candidateCurrentFixture();
  try {
    const history = candidateHistory(db);
    const ledger = db.query("SELECT * FROM applied_migrations ORDER BY name").all();
    expect(ledger).toHaveLength(100);
    const before = candidateState(db);
    expect(await inspectV2WorkerNativeIdentityDomain(createSqliteSql(db))).toBe("legacy_v2w52");
    applyCandidate(db);
    const after = candidateState(db);
    expect(after.rows).toEqual(before.rows);
    expect(after.data).toEqual(before.data);
    expect(after.schema.filter((row) => row.name !== TABLE)).toEqual(
      before.schema.filter((row) => row.name !== TABLE),
    );
    expect(after.temporary).toEqual(before.temporary);
    expect(after.foreignKeys).toEqual([]);
    expect(after.inTransaction).toBe(false);
    expect(db.query("SELECT * FROM applied_migrations ORDER BY name").all()).toEqual(ledger);
    expect(await inspectV2WorkerNativeIdentityDomain(createSqliteSql(db))).toBe("opaque255");
    assertCandidateCustody(db, history);
    // This remains local actual100 + unregistered recipe; never final101,
    // registered/applied102, original native import custody or staging proof.
  } finally {
    db.close();
  }
});

for (const mutation of [
  "missing",
  "weakened",
  "extra",
  "holding",
  "temp-holding",
  "assertion",
  "temp-shadow",
  "incoming",
  "checks-off",
  "foreign-keys-off",
] as const)
  test(`native identity candidate: ${mutation} predecessor refuses without losing state`, () => {
    const db = candidateFixture();
    try {
      candidateHistory(db);
      if (mutation === "missing" || mutation === "weakened") {
        db.exec("DROP TRIGGER tf_v2_worker_native_deletion_send_guard;");
        if (mutation === "weakened")
          db.exec(
            `CREATE TRIGGER tf_v2_worker_native_deletion_send_guard BEFORE UPDATE ON ${TABLE} BEGIN SELECT 1; END;`,
          );
      }
      if (mutation === "extra")
        db.exec(
          `CREATE TRIGGER component_new_guard BEFORE INSERT ON ${TABLE} BEGIN SELECT 1; END;`,
        );
      if (mutation === "holding")
        db.exec("CREATE TABLE _tf_v2_m0102_native_deletions_holding(value);");
      if (mutation === "temp-holding")
        db.exec("CREATE TEMP TABLE _tf_v2_m0102_native_deletions_holding(value);");
      if (mutation === "assertion")
        db.exec("CREATE TEMP TABLE _tf_v2_native_identity_candidate_assert(value);");
      if (mutation === "temp-shadow") db.exec(`CREATE TEMP TABLE ${TABLE}(value);`);
      if (mutation === "incoming")
        db.exec(
          `CREATE TABLE component_incoming(deletion, source, FOREIGN KEY(deletion, source) REFERENCES ${TABLE}(delete_operation_id, source_operation_id));`,
        );
      if (mutation === "checks-off") db.exec("PRAGMA ignore_check_constraints = ON;");
      if (mutation === "foreign-keys-off") db.exec("PRAGMA foreign_keys = OFF;");
      const before = candidateState(db);
      expect(() => applyCandidate(db)).toThrow();
      const after = candidateState(db);
      expect(after).toEqual(before);
      expect(after.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

for (const fault of ["after-drop", "missing-row", "storageclass"] as const)
  test(`native identity candidate: ${fault} failure rolls back the entire owning unit`, () => {
    const db = candidateFixture();
    try {
      candidateHistory(db);
      const before = candidateState(db);
      const candidate = buildUnregisteredV2WorkerNativeIdentityMigrationCandidate();
      const faulted = candidate.steps.flatMap((step) => [
        ...step.statements,
        ...(fault === "after-drop" && step.name === "remove"
          ? ["SELECT absent_native_identity_candidate_function();"]
          : fault !== "after-drop" && step.name === "copy"
            ? [
                fault === "missing-row"
                  ? `DELETE FROM main.${TABLE} WHERE rowid = -7;`
                  : `UPDATE main.${TABLE} SET stage_lease_token = CAST(stage_lease_token AS BLOB) WHERE rowid = -7;`,
              ]
            : []),
      ]);
      let failure: unknown;
      try {
        applyCandidate(db, faulted);
      } catch (error) {
        failure = error;
      }
      // Read every surface before classifying/asserting the native error.
      const after = candidateState(db);
      expect(after).toEqual(before);
      expect(after.inTransaction).toBe(false);
      expect(failure).toBeInstanceOf(Error);
      if (!failure || typeof failure !== "object" || !("code" in failure))
        throw new Error("missing original owning SQLite failure");
      expect(failure.code).toBe(
        fault === "after-drop" ? "SQLITE_ERROR" : "SQLITE_CONSTRAINT_PRIMARYKEY",
      );
    } finally {
      db.close();
    }
  });

test("native identity candidate: WAL readers see a whole predecessor or whole replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-identity-candidate-"));
  const file = join(directory, "reader.sqlite");
  const writer = candidateFixture(file);
  const reader = new Database(file, { readonly: true });
  const observer = new Database(file);
  try {
    for (const connection of [reader, observer]) {
      connection.exec("PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = OFF;");
      expect(connection.query("PRAGMA foreign_keys").all()).toEqual([{ foreign_keys: 1 }]);
      expect(connection.query("PRAGMA ignore_check_constraints").all()).toEqual([
        { ignore_check_constraints: 0 },
      ]);
    }
    candidateHistory(writer);
    writer.exec("PRAGMA journal_mode = WAL;");
    observer.exec("PRAGMA busy_timeout = 0;");
    const before = candidateState(writer);
    reader.exec("BEGIN;");
    expect(candidateState(reader).rows).toEqual(before.rows);
    const steps = buildUnregisteredV2WorkerNativeIdentityMigrationCandidate().steps;
    const boundary = steps.findIndex((step) => step.name === "remove") + 1;
    expect(boundary).toBeGreaterThan(0);
    executeSqliteMigrationStatements(writer, "BEGIN IMMEDIATE;");
    try {
      executeSqliteMigrationStatements(
        writer,
        steps
          .slice(0, boundary)
          .flatMap((step) => step.statements)
          .join("\n"),
      );
      expect(candidateState(reader).rows).toEqual(before.rows);
      expect(candidateState(observer).rows).toEqual(before.rows);
      expect(candidateState(observer).schema).toEqual(before.schema);
      let busy: unknown;
      try {
        observer.exec("BEGIN IMMEDIATE;");
      } catch (error) {
        busy = error;
      }
      if (!busy || typeof busy !== "object" || !("code" in busy))
        throw new Error("missing concurrent writer refusal");
      expect(busy.code).toBe("SQLITE_BUSY");
      executeSqliteMigrationStatements(
        writer,
        steps
          .slice(boundary)
          .flatMap((step) => step.statements)
          .join("\n"),
      );
      executeSqliteMigrationStatements(writer, "COMMIT;");
    } catch (error) {
      try {
        executeSqliteMigrationStatements(writer, "ROLLBACK;");
      } catch {
        // Preserve the original execution/assertion failure.
      }
      throw error;
    }
    expect(candidateState(reader).rows).toEqual(before.rows);
    reader.exec("COMMIT;");
    expect(candidateState(observer).rows).toEqual(before.rows);
    expect(
      observer.query(`SELECT 1 WHERE ${v2WorkerNativeIdentityDomainReady("opaque255")}`).all(),
    ).toHaveLength(1);
    expect(candidateState(observer).temporary).toEqual([]);
  } finally {
    reader.close();
    observer.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const parentSpelling of ["TF_V2_WORKER_NATIVE_DELETIONS", "Tf_V2_Worker_Native_Deletions"])
  for (const temporaryShadow of [false, true])
    test(`native identity candidate: populated ${parentSpelling} CASCADE child${temporaryShadow ? " with TEMP shadow" : ""} refuses before capture`, () => {
      const db = candidateFixture();
      try {
        const history = candidateHistory(db);
        const child = "component_casefold_incoming";
        db.exec(`CREATE TABLE main.${child}(
          deletion TEXT NOT NULL, source TEXT NOT NULL, payload BLOB NOT NULL,
          FOREIGN KEY(deletion, source) REFERENCES "${parentSpelling}"
            (delete_operation_id, source_operation_id) ON DELETE CASCADE
        );`);
        db.query(
          `INSERT INTO main.${child}(deletion, source, payload) VALUES (?, ?, X'00ff10')`,
        ).run(history.acknowledged.deletion, history.acknowledged.source);
        if (temporaryShadow)
          db.exec(`CREATE TEMP TABLE ${child}(payload TEXT);
            INSERT INTO temp.${child}(payload) VALUES ('retained-temp-shadow');`);
        expect(
          db
            .query<{ table: string; on_delete: string }, []>(
              `SELECT "table", on_delete FROM pragma_foreign_key_list('${child}', 'main') ORDER BY id, seq`,
            )
            .all(),
        ).toEqual([
          { table: parentSpelling, on_delete: "CASCADE" },
          { table: parentSpelling, on_delete: "CASCADE" },
        ]);
        const readChild = () =>
          db
            .query(
              `SELECT deletion, source, typeof(payload), hex(payload) FROM main.${child} ORDER BY deletion, source`,
            )
            .all();
        const readTemporary = () =>
          temporaryShadow ? db.query(`SELECT * FROM temp.${child}`).all() : [];
        const before = candidateState(db);
        const childBefore = readChild();
        const temporaryBefore = readTemporary();
        expect(childBefore).toHaveLength(1);
        const executed: string[] = [];
        const observed: Parameters<typeof executeSqliteMigrationStatements>[0] = {
          exec(statement) {
            executed.push(statement);
            return db.exec(statement);
          },
          query: db.query.bind(db),
        };
        let failure: unknown;
        try {
          executeSqliteMigrationStatements(observed, "BEGIN IMMEDIATE;");
          executeSqliteMigrationStatements(
            observed,
            buildUnregisteredV2WorkerNativeIdentityMigrationCandidate().statements.join("\n"),
          );
          executeSqliteMigrationStatements(observed, "COMMIT;");
        } catch (error) {
          failure = error;
          try {
            executeSqliteMigrationStatements(observed, "ROLLBACK;");
          } catch {
            // The assertion already rolls back; keep the original failure.
          }
        }
        const after = candidateState(db);
        const childAfter = readChild();
        const temporaryAfter = readTemporary();
        expect(after).toEqual(before);
        expect(childAfter).toEqual(childBefore);
        expect(temporaryAfter).toEqual(temporaryBefore);
        expect(after.inTransaction).toBe(false);
        expect(
          executed.some((statement) =>
            /^\s*CREATE TABLE main\._tf_v2_m0102_native_deletions_holding\b/iu.test(statement),
          ),
        ).toBe(false);
        expect(
          executed.some((statement) =>
            /^\s*DROP TABLE main\.tf_v2_worker_native_deletions\b/iu.test(statement),
          ),
        ).toBe(false);
        if (!failure || typeof failure !== "object" || !("code" in failure))
          throw new Error("missing pre-effect incoming CASCADE refusal");
        expect(failure.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
      } finally {
        db.close();
      }
    });
