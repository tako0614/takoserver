import type { Sql } from "../ports.ts";

/** Installed physical shape only; neither a migration receipt nor a native send grant. */
export type V2WorkerNativeIdentityDomain = "legacy_v2w52" | "opaque255";

// Source-owned 0079 table/index and the effective 0079/0087/0088 guard closure.
// The opaque alternative changes only the native_identity CHECK to the 0074 domain.
// No canonical migration 0102 or final 0101 lineage is registered by this module.
const LEGACY_TABLE = `CREATE TABLE tf_v2_worker_native_deletions (
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

const OPAQUE_TABLE = `CREATE TABLE tf_v2_worker_native_deletions (
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

const INDEX = `CREATE INDEX tf_v2_worker_native_deletions_next
  ON tf_v2_worker_native_deletions(delete_operation_id, source_generation DESC, source_operation_id)`;

const GUARDS = [
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
const INDEX_NAME = "tf_v2_worker_native_deletions_next";
const PK_INDEX = "sqlite_autoindex_tf_v2_worker_native_deletions_1";
const MARKERS = [
  "_tf_v2_m0102_native_deletions_holding",
  "_tf_v2_m0102_assert",
  "tf_v2_worker_invocations_next",
] as const;

// cid, name, declared affinity, NOT NULL, composite-PK ordinal.
const COLUMNS = [
  [0, "delete_operation_id", "TEXT", 1, 1],
  [1, "source_operation_id", "TEXT", 1, 2],
  [2, "resource_uid", "TEXT", 1, 0],
  [3, "principal", "TEXT", 1, 0],
  [4, "space", "TEXT", 1, 0],
  [5, "backend_id", "TEXT", 1, 0],
  [6, "target_key", "TEXT", 1, 0],
  [7, "delete_generation", "INTEGER", 1, 0],
  [8, "source_generation", "INTEGER", 1, 0],
  [9, "native_identity", "TEXT", 1, 0],
  [10, "closure_digest", "TEXT", 1, 0],
  [11, "upload_receipt", "TEXT", 0, 0],
  [12, "qualified_source_receipt", "TEXT", 0, 0],
  [13, "qualification_lease_token", "TEXT", 0, 0],
  [14, "stage_lease_token", "TEXT", 1, 0],
  [15, "staged_at_ms", "INTEGER", 1, 0],
  [16, "grant_lease_token", "TEXT", 0, 0],
  [17, "granted_at_ms", "INTEGER", 0, 0],
  [18, "predelete_source_receipt", "TEXT", 0, 0],
  [19, "acknowledged_receipt", "TEXT", 0, 0],
  [20, "confirmed_absence_receipt", "TEXT", 0, 0],
  [21, "absence_lease_token", "TEXT", 0, 0],
] as const;

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const markerNames = MARKERS.map(literal).join(", ");
const columnMatches = COLUMNS.map(
  ([cid, name, type, notnull, pk]) => `(cid = ${cid} AND name = ${literal(name)}
    AND type = ${literal(type)} AND "notnull" = ${notnull} AND pk = ${pk}
    AND dflt_value IS NULL AND hidden = 0)`,
).join(" OR ");
const guardMatches = GUARDS.map(
  ([name, sql]) => `(name = ${literal(name)} AND sql = ${literal(sql)})`,
).join(" OR ");

const COMMON = `(SELECT foreign_keys FROM pragma_foreign_keys) = 1
  AND (SELECT ignore_check_constraints FROM pragma_ignore_check_constraints) = 0
  AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema WHERE name IN (${markerNames}))
  AND NOT EXISTS (SELECT 1 FROM sqlite_temp_schema
    WHERE name IN (${literal(TABLE)}, ${markerNames}) OR tbl_name = ${literal(TABLE)})
  AND (SELECT count(*) FROM pragma_table_xinfo(${literal(TABLE)}, 'main')) = 22
  AND (SELECT count(*) FROM pragma_table_xinfo(${literal(TABLE)}, 'main')
    WHERE ${columnMatches}) = 22
  AND (SELECT count(*) FROM main.sqlite_schema
    WHERE type = 'trigger' AND tbl_name = ${literal(TABLE)}) = 8
  AND (SELECT count(*) FROM main.sqlite_schema
    WHERE type = 'trigger' AND tbl_name = ${literal(TABLE)} AND (${guardMatches})) = 8
  AND (SELECT count(*) FROM main.sqlite_schema
    WHERE type = 'index' AND tbl_name = ${literal(TABLE)}) = 2
  AND (SELECT count(*) FROM main.sqlite_schema
    WHERE type = 'index' AND tbl_name = ${literal(TABLE)}
      AND name = ${literal(INDEX_NAME)} AND sql = ${literal(INDEX)}) = 1
  AND (SELECT count(*) FROM pragma_index_list(${literal(TABLE)}, 'main')) = 2
  AND (SELECT count(*) FROM pragma_index_list(${literal(TABLE)}, 'main')
    WHERE name = ${literal(INDEX_NAME)} AND "unique" = 0 AND origin = 'c' AND partial = 0) = 1
  AND (SELECT count(*) FROM pragma_index_list(${literal(TABLE)}, 'main')
    WHERE name = ${literal(PK_INDEX)} AND "unique" = 1 AND origin = 'pk' AND partial = 0) = 1
  AND (SELECT count(*) FROM pragma_foreign_key_list(${literal(TABLE)}, 'main')) = 3
  AND (SELECT count(*) FROM pragma_foreign_key_list(${literal(TABLE)}, 'main')
    WHERE seq = 0 AND "to" IN ('id', 'uid')
      AND on_update = 'NO ACTION' AND on_delete = 'NO ACTION' AND match = 'NONE'
      AND (("from" = 'delete_operation_id' AND "table" = 'tf_v2_operations' AND "to" = 'id')
        OR ("from" = 'source_operation_id' AND "table" = 'tf_v2_operations' AND "to" = 'id')
        OR ("from" = 'resource_uid' AND "table" = 'tf_v2_resources' AND "to" = 'uid'))) = 3
  AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema source
    WHERE CASE WHEN lower(source.name) IN ('_cf_kv', '_cf_metadata') THEN 0
      ELSE EXISTS (SELECT 1 FROM pragma_foreign_key_list(source.name, 'main') incoming
        WHERE source.type = 'table' AND incoming."table" = ${literal(TABLE)}) END)`;

function predicate(tableSql: string): string {
  return `(${COMMON}
    AND (SELECT count(*) FROM main.sqlite_schema
      WHERE type = 'table' AND name = ${literal(TABLE)} AND sql = ${literal(tableSql)}) = 1)`;
}

const LEGACY_READY = predicate(LEGACY_TABLE);
const OPAQUE_READY = predicate(OPAQUE_TABLE);

/**
 * Closed structural precondition for an owning SQL statement, not supplied SQL.
 * A startup inspection cannot replace repeating this at the existing grant INSERT.
 */
export function v2WorkerNativeIdentityDomainReady(domain: V2WorkerNativeIdentityDomain): string {
  switch (domain) {
    case "legacy_v2w52":
      return LEGACY_READY;
    case "opaque255":
      return OPAQUE_READY;
    default:
      throw new TypeError("unsupported v2 Worker native identity domain");
  }
}

/**
 * One coherent read of the installed contract; unknown/unsupported shape refuses.
 * This does not prove canonical 0102 application, target authority or current
 * accepted execution. The existing native-effect owner remains the send authority.
 */
export async function inspectV2WorkerNativeIdentityDomain(
  sql: Sql,
): Promise<V2WorkerNativeIdentityDomain | null> {
  try {
    const rows = await sql.query(`SELECT CASE
      WHEN ${LEGACY_READY} THEN 'legacy_v2w52'
      WHEN ${OPAQUE_READY} THEN 'opaque255'
      ELSE NULL END AS domain`);
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (!row || Object.keys(row).length !== 1) return null;
    const descriptor = Object.getOwnPropertyDescriptor(row, "domain");
    if (!descriptor || !("value" in descriptor)) return null;
    return descriptor.value === "legacy_v2w52" || descriptor.value === "opaque255"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

/** Internal source recipe only. It neither registers a migration nor executes SQL. */
export function createV2WorkerNativeIdentityMigrationRecipe() {
  const holding = MARKERS[0];
  // This candidate owns one fresh MAIN scratch table only inside the same batch.
  // Its distinct name does not relax the unchanged steady readiness seal.
  const assertion = "_tf_v2_native_identity_candidate_assert";
  const assertionReady = `(SELECT count(*) FROM main.sqlite_schema
  WHERE type = 'table' AND name = ${literal(assertion)} AND tbl_name = ${literal(assertion)}
    AND sql IS NOT NULL) = 1
AND (SELECT count(*) FROM main.sqlite_schema
  WHERE name COLLATE NOCASE = ${literal(assertion)}) = 1
AND (SELECT count(*) FROM main.sqlite_schema WHERE tbl_name = ${literal(assertion)}) = 1
AND (SELECT count(*) FROM pragma_table_xinfo(${literal(assertion)}, 'main')) = 1
AND (SELECT count(*) FROM pragma_table_xinfo(${literal(assertion)}, 'main')
  WHERE cid = 0 AND name = 'ok' AND type = 'INTEGER' AND "notnull" = 0
    AND dflt_value IS NULL AND pk = 1 AND hidden = 0) = 1
AND (SELECT count(*) FROM main.${assertion}) = 1
AND EXISTS (SELECT 1 FROM main.${assertion} WHERE typeof(ok) = 'integer' AND ok = 1)
AND NOT EXISTS (SELECT 1 FROM sqlite_temp_schema
  WHERE name COLLATE NOCASE = ${literal(assertion)}
    OR tbl_name COLLATE NOCASE = ${literal(assertion)})`;
  const columns = COLUMNS.map(([, name]) => name);
  const names = columns.join(", ");
  // SQLite identifiers use ASCII case-insensitive equality, unlike the unchanged
  // legacy inspector's catalog-text comparison. A DROP could otherwise cascade
  // into an unrelated child whose REFERENCES spelling differs only by case.
  const noIncomingReferences = `NOT EXISTS (SELECT 1 FROM main.sqlite_schema source
  WHERE CASE WHEN lower(source.name) IN ('_cf_kv', '_cf_metadata') THEN 0
    ELSE EXISTS (SELECT 1 FROM pragma_foreign_key_list(source.name, 'main') incoming
      WHERE source.type = 'table' AND incoming."table" COLLATE NOCASE = ${literal(TABLE)}) END)`;
  // A duplicate PRIMARY KEY still fails when ignore_check_constraints is ON.
  // Unknown/NULL predicates must fail too, rather than selecting no assertion.
  const check = (condition: string) =>
    `INSERT OR ROLLBACK INTO main.${assertion}(ok)
SELECT 1 WHERE (${condition}) IS NOT 1;`;
  const equal = (left: string, right: string, leftRowid: string, rightRowid: string) => {
    // Preserve every comparison leaf while bounding native expression depth.
    const conjunction = (parts: readonly string[]): string => {
      const first = parts[0];
      if (first === undefined) throw new Error("native identity preservation has no columns");
      if (parts.length === 1) return first;
      const middle = Math.floor(parts.length / 2);
      return `(${conjunction(parts.slice(0, middle))} AND ${conjunction(parts.slice(middle))})`;
    };
    const values = conjunction(
      columns.map((name) => `typeof(l.${name}) = typeof(r.${name}) AND l.${name} IS r.${name}`),
    );
    return `(SELECT count(*) FROM ${left}) = (SELECT count(*) FROM ${right})
AND NOT EXISTS (SELECT 1 FROM ${left} l LEFT JOIN ${right} r
  ON r.${rightRowid} = l.${leftRowid}
  WHERE r.${rightRowid} IS NULL OR NOT (${values}))
AND NOT EXISTS (SELECT 1 FROM ${right} r LEFT JOIN ${left} l
  ON l.${leftRowid} = r.${rightRowid}
  WHERE l.${leftRowid} IS NULL OR NOT (${values}))`;
  };
  const step = (name: string, statements: readonly string[]) =>
    Object.freeze({ name, statements: Object.freeze([...statements]) });
  return Object.freeze({
    transaction: "owning-single-transaction-with-rollback-on-every-error",
    steps: Object.freeze([
      step("precondition", [
        `CREATE TABLE main.${assertion}(ok INTEGER PRIMARY KEY);`,
        `INSERT INTO main.${assertion}(ok) VALUES (1);`,
        check(`${LEGACY_READY}
AND ${noIncomingReferences}
AND ${assertionReady}
AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check(${literal(TABLE)}, 'main'))`),
      ]),
      step("capture", [
        `CREATE TABLE main.${holding}(original_rowid INTEGER PRIMARY KEY, ${names});`,
        `INSERT INTO main.${holding}(original_rowid, ${names})
SELECT rowid, ${names} FROM main.${TABLE};`,
        check(equal(`main.${TABLE}`, `main.${holding}`, "rowid", "original_rowid")),
      ]),
      step("remove", [
        ...GUARDS.map(([name]) => `DROP TRIGGER main.${name};`),
        `DROP TABLE main.${TABLE};`,
      ]),
      step("copy", [
        `${OPAQUE_TABLE};`,
        `INSERT INTO main.${TABLE}(rowid, ${names})
SELECT original_rowid, ${names} FROM main.${holding};`,
      ]),
      step("preservation", [
        check(equal(`main.${TABLE}`, `main.${holding}`, "rowid", "original_rowid")),
      ]),
      step("restore", [`${INDEX};`, ...GUARDS.map(([, sql]) => `${sql};`)]),
      step("postcondition", [
        `DROP TABLE main.${holding};`,
        check(`${OPAQUE_READY}
AND ${noIncomingReferences}
AND ${assertionReady}
AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check(${literal(TABLE)}, 'main'))`),
        `DROP TABLE main.${assertion};`,
      ]),
    ]),
  });
}
