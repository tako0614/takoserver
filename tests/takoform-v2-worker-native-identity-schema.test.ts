import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
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
