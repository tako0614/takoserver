-- Migration 0031 was already applied by name before its file was accidentally
-- expanded in a later build. Keep 0031 immutable and converge both realized
-- schemas here. Every transition is forward-only and preserves durable rows
-- and fences.

-- Triggers from the accidentally expanded lineage reference the roots table.
-- Remove every known definition before rebuilding, then recreate one canonical
-- set below. The original lineage has none, so every drop is conditional.
DROP TRIGGER IF EXISTS tf_artifact_owner_closure_receipt_exact_insert;
DROP TRIGGER IF EXISTS tf_artifact_owner_closure_receipt_immutable_update;
DROP TRIGGER IF EXISTS tf_artifact_owner_closure_receipt_durable_delete;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_upload_gc_guard;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_upload_insert;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_abandoned_replay_insert;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_abandoned_replay_update;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_delete_replay_insert;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_delete_replay_update;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_replay_insert;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_replay_update;
DROP TRIGGER IF EXISTS tf_artifact_previous_writer_upload_delete;
DROP TRIGGER IF EXISTS tf_artifact_active_root_insert_guard;
DROP TRIGGER IF EXISTS tf_artifact_active_root_update_guard;
DROP TRIGGER IF EXISTS tf_artifact_resource_root_insert;
DROP TRIGGER IF EXISTS tf_artifact_resource_root_update;
DROP TRIGGER IF EXISTS tf_artifact_resource_root_delete;
DROP TRIGGER IF EXISTS tf_artifact_deployment_root_insert;
DROP TRIGGER IF EXISTS tf_artifact_deployment_root_update;
DROP TRIGGER IF EXISTS tf_artifact_deployment_root_delete;
DROP TRIGGER IF EXISTS tf_artifact_deployment_root_after_delete;

-- SQLite cannot widen CHECK constraints in place. Rebuild only the roots table
-- through a next table, copying every column exactly before replacing it.
CREATE TABLE tf_artifact_roots_next (
  tenant_id TEXT NOT NULL,
  root_kind TEXT NOT NULL,
  root_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  expires_at INTEGER,
  release_reason TEXT,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (tenant_id, root_kind, root_id, target_kind, digest),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (root_kind IN (
    'upload', 'replay', 'resource', 'deployment', 'legacy-hold', 'legacy-manifest'
  )),
  CHECK (length(root_id) BETWEEN 1 AND 4096),
  CHECK (target_kind IN ('manifest', 'blob')),
  CHECK (
    length(digest) = 71 AND
    substr(digest, 1, 7) = 'sha256:' AND
    substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (state IN ('active', 'released')),
  CHECK (fence >= 1),
  CHECK ((root_kind = 'replay') = (expires_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at >= 0),
  CHECK (release_reason IS NULL OR release_reason IN (
    'upload_abandoned', 'replay_expired', 'replay_replaced', 'operator_exact_failed_run',
    'consumer_replaced', 'consumer_closed'
  )),
  CHECK (
    (state = 'active' AND released_at IS NULL AND release_reason IS NULL) OR
    (state = 'released' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  ),
  CHECK (created_at >= 0),
  CHECK (released_at IS NULL OR released_at >= created_at)
);

INSERT INTO tf_artifact_roots_next
  (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
   expires_at, release_reason, created_at, released_at)
SELECT tenant_id, root_kind, root_id, target_kind, digest, state, fence,
       expires_at, release_reason, created_at, released_at
FROM tf_artifact_roots;

DROP TABLE tf_artifact_roots;
ALTER TABLE tf_artifact_roots_next RENAME TO tf_artifact_roots;

CREATE INDEX tf_artifact_roots_live_digest
  ON tf_artifact_roots (target_kind, digest, tenant_id)
  WHERE state = 'active';

CREATE INDEX tf_artifact_roots_expiry
  ON tf_artifact_roots (expires_at, tenant_id, root_id)
  WHERE state = 'active' AND expires_at IS NOT NULL;

-- Deployment rows created before this migration do not persist the artifact
-- digest that their native object actually serves. The current Resource may
-- already name a newer digest, so backfill cannot honestly infer the old one.
-- Keep a durable tenant-scoped uncertainty until that Deployment is terminal;
-- exact upload-root release must fail closed while any such row is active.
CREATE TABLE IF NOT EXISTS tf_artifact_consumer_uncertainties (
  tenant_id TEXT NOT NULL,
  consumer_kind TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (tenant_id, consumer_kind, consumer_id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (consumer_kind = 'deployment'),
  CHECK (length(consumer_id) BETWEEN 3 AND 128),
  CHECK (state IN ('active', 'resolved')),
  CHECK (fence >= 1),
  CHECK (reason IN (
    'historical_deployment_digest_unknown', 'resource_not_yet_observed'
  )),
  CHECK (created_at >= 0),
  CHECK (
    (state = 'active' AND resolved_at IS NULL) OR
    (state = 'resolved' AND resolved_at IS NOT NULL)
  ),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE INDEX IF NOT EXISTS tf_artifact_consumer_uncertainties_active
  ON tf_artifact_consumer_uncertainties (tenant_id, consumer_kind, consumer_id)
  WHERE state = 'active';

-- Logical Resources and every non-terminal Deployment are durable consumers.
-- A Deployment keeps its own root because retained/failed provider state can
-- outlive deletion of the logical Resource row. Without these roots an exact
-- failed-run repair could release the upload while a provider still serves it.
INSERT OR IGNORE INTO tf_artifact_roots
  (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
   expires_at, release_reason, created_at, released_at)
SELECT resource.tenant_id, 'resource',
       resource.space || char(0) || resource.api_version || char(0) ||
         resource.kind || char(0) || resource.name,
       'manifest', json_extract(resource.resource_json, '$.spec.manifestDigest'),
       'active', 1, NULL, NULL, resource.updated_at, NULL
FROM tf_resources AS resource
WHERE json_type(resource.resource_json, '$.spec.manifestDigest') = 'text'
  AND length(json_extract(resource.resource_json, '$.spec.manifestDigest')) = 71
  AND substr(json_extract(resource.resource_json, '$.spec.manifestDigest'), 1, 7) = 'sha256:'
  AND substr(json_extract(resource.resource_json, '$.spec.manifestDigest'), 8)
        NOT GLOB '*[^0-9a-f]*';

INSERT OR IGNORE INTO tf_artifact_roots
  (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
   expires_at, release_reason, created_at, released_at)
SELECT deployment.tenant_id, 'deployment', deployment.id, 'manifest',
       json_extract(resource.resource_json, '$.spec.manifestDigest'),
       'active', 1, NULL, NULL, deployment.created_at, NULL
FROM tf_resource_deployments AS deployment
JOIN tf_resources AS resource
  ON resource.tenant_id = deployment.tenant_id
 AND resource.uid = deployment.resource_uid
WHERE deployment.state <> 'deleted'
  AND json_type(resource.resource_json, '$.spec.manifestDigest') = 'text'
  AND length(json_extract(resource.resource_json, '$.spec.manifestDigest')) = 71
  AND substr(json_extract(resource.resource_json, '$.spec.manifestDigest'), 1, 7) = 'sha256:'
  AND substr(json_extract(resource.resource_json, '$.spec.manifestDigest'), 8)
        NOT GLOB '*[^0-9a-f]*';

INSERT OR IGNORE INTO tf_artifact_consumer_uncertainties
  (tenant_id, consumer_kind, consumer_id, state, fence, reason, created_at, resolved_at)
SELECT tenant_id, 'deployment', id, 'active', 1,
       'historical_deployment_digest_unknown', created_at, NULL
FROM tf_resource_deployments
WHERE state <> 'deleted';

-- Exact failed-run release is a separate authority boundary. A caller cannot
-- assert closure with request booleans: it must name a durable receipt bound to
-- the exact upload and upload/root fences observed when the owner was closed.
-- No public route writes this table; until an owning run authority can issue
-- such a receipt, destructive release remains unavailable by construction.
CREATE TABLE IF NOT EXISTS tf_artifact_owner_closure_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  receipt_fence INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  upload_fence INTEGER NOT NULL,
  root_fence INTEGER NOT NULL,
  state TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(receipt_id) BETWEEN 3 AND 128),
  CHECK (receipt_fence >= 1),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(principal_id) BETWEEN 5 AND 255 AND substr(principal_id, 1, 4) = 'run:'),
  CHECK (length(upload_id) BETWEEN 3 AND 128),
  CHECK (
    length(manifest_digest) = 71 AND
    substr(manifest_digest, 1, 7) = 'sha256:' AND
    substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (upload_fence >= 1),
  CHECK (root_fence >= 1),
  CHECK (state IN ('closed', 'revoked')),
  CHECK (closed_at >= 0),
  CHECK (expires_at > closed_at),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS tf_artifact_owner_closure_receipts_exact
  ON tf_artifact_owner_closure_receipts
    (tenant_id, principal_id, upload_id, manifest_digest, upload_fence, root_fence,
     state, expires_at, closed_at);

CREATE TRIGGER tf_artifact_owner_closure_receipt_exact_insert
BEFORE INSERT ON tf_artifact_owner_closure_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM tf_artifact_uploads AS upload
  JOIN tf_artifact_roots AS root
    ON root.tenant_id = upload.tenant_id
   AND root.root_kind = 'upload'
   AND root.root_id = upload.id
   AND root.target_kind = 'manifest'
   AND root.digest = upload.manifest_digest
  WHERE upload.id = NEW.upload_id AND upload.tenant_id = NEW.tenant_id
    AND upload.principal_id = NEW.principal_id
    AND upload.manifest_digest = NEW.manifest_digest
    AND upload.lifecycle_state = 'committed'
    AND upload.lifecycle_fence = NEW.upload_fence
    AND root.state = 'active' AND root.fence = NEW.root_fence
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_owner_closure_receipt_not_exact');
END;

-- Receipts are append-only authority. The only mutation is an exact
-- closed-to-revoked transition; identity, fences, and validity timestamps can
-- never be rewritten into a more permissive receipt after issuance.
CREATE TRIGGER tf_artifact_owner_closure_receipt_immutable_update
BEFORE UPDATE ON tf_artifact_owner_closure_receipts
WHEN NOT (
  OLD.state = 'closed' AND NEW.state = 'revoked'
  AND NEW.receipt_id = OLD.receipt_id
  AND NEW.receipt_fence = OLD.receipt_fence
  AND NEW.tenant_id = OLD.tenant_id
  AND NEW.principal_id = OLD.principal_id
  AND NEW.upload_id = OLD.upload_id
  AND NEW.manifest_digest = OLD.manifest_digest
  AND NEW.upload_fence = OLD.upload_fence
  AND NEW.root_fence = OLD.root_fence
  AND NEW.closed_at = OLD.closed_at
  AND NEW.expires_at = OLD.expires_at
  AND NEW.created_at = OLD.created_at
  AND NEW.updated_at >= OLD.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_owner_closure_receipt_immutable');
END;

CREATE TRIGGER tf_artifact_owner_closure_receipt_durable_delete
BEFORE DELETE ON tf_artifact_owner_closure_receipts
BEGIN
  SELECT RAISE(ABORT, 'artifact_owner_closure_receipt_durable');
END;

-- 0031 is migration-first compatible with the immediately previous Worker.
-- Its six-column upload INSERT omits every lifecycle column, which is
-- distinguishable by the `updated_at = 0` compatibility sentinel. Normalize
-- that row into the same open upload/member/root state written by the new
-- Worker before the old request can return.
CREATE TRIGGER tf_artifact_previous_writer_upload_gc_guard
BEFORE INSERT ON tf_artifact_uploads
WHEN NEW.lifecycle_state = 'committed' AND NEW.updated_at = 0
  AND EXISTS (
    SELECT 1 FROM tf_artifact_gc_candidates AS candidate
    WHERE candidate.state = 'deleting' AND (
      (candidate.kind = 'manifest' AND candidate.digest = NEW.manifest_digest) OR
      (candidate.kind = 'blob' AND (
        EXISTS (
          SELECT 1 FROM json_each(json_extract(NEW.manifest_json, '$.modules')) AS member
          WHERE json_extract(member.value, '$.digest') = candidate.digest
        ) OR EXISTS (
          SELECT 1 FROM json_each(json_extract(NEW.manifest_json, '$.files')) AS member
          WHERE json_extract(member.value, '$.digest') = candidate.digest
        )
      ))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_delete_fenced');
END;

CREATE TRIGGER tf_artifact_previous_writer_upload_insert
AFTER INSERT ON tf_artifact_uploads
WHEN NEW.lifecycle_state = 'committed' AND NEW.updated_at = 0
BEGIN
  UPDATE tf_artifact_uploads
  SET lifecycle_state = 'open', updated_at = NEW.created_at
  WHERE id = NEW.id AND lifecycle_state = 'committed' AND updated_at = 0;

  INSERT OR IGNORE INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
  SELECT NEW.manifest_digest, json_extract(member.value, '$.digest')
  FROM json_each(json_extract(NEW.manifest_json, '$.modules')) AS member;

  INSERT OR IGNORE INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
  SELECT NEW.manifest_digest, json_extract(member.value, '$.digest')
  FROM json_each(json_extract(NEW.manifest_json, '$.files')) AS member;

  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  VALUES
    (NEW.tenant_id, 'upload', NEW.id, 'manifest', NEW.manifest_digest,
     'active', 1, NULL, NULL, NEW.created_at, NULL);
END;

-- A rollback writer can still see an abandoned compatibility tombstone because
-- its six-column SELECT predates lifecycle state. Never let its terminal replay
-- turn a post-delete commit into an apparent success. Earlier manifest/hold
-- writes remain quarantined behind the released upload root and are reconciled
-- after replay expiry; the request itself fails before durable success exists.
CREATE TRIGGER tf_artifact_previous_writer_abandoned_replay_insert
BEFORE INSERT ON tf_artifact_replays
WHEN json_type(NEW.body_json, '$.manifestDigest') = 'text'
  AND EXISTS (
    SELECT 1
    FROM tf_artifact_uploads AS upload
    WHERE upload.lifecycle_state = 'abandoned'
      AND upload.manifest_digest = json_extract(NEW.body_json, '$.manifestDigest')
      AND instr(
        hex(NEW.replay_key),
        hex(upload.tenant_id) || '00' || hex(upload.principal_id) || '00' ||
          hex('POST') || '00'
      ) = 1
      AND instr(
        hex(NEW.replay_key),
        hex('/uploads/' || upload.id || '/commit') || '00'
      ) > 0
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_upload_abandoned');
END;

CREATE TRIGGER tf_artifact_previous_writer_abandoned_replay_update
BEFORE UPDATE OF status, body_json, expires_at ON tf_artifact_replays
WHEN json_type(NEW.body_json, '$.manifestDigest') = 'text'
  AND EXISTS (
    SELECT 1
    FROM tf_artifact_uploads AS upload
    WHERE upload.lifecycle_state = 'abandoned'
      AND upload.manifest_digest = json_extract(NEW.body_json, '$.manifestDigest')
      AND instr(
        hex(NEW.replay_key),
        hex(upload.tenant_id) || '00' || hex(upload.principal_id) || '00' ||
          hex('POST') || '00'
      ) = 1
      AND instr(
        hex(NEW.replay_key),
        hex('/uploads/' || upload.id || '/commit') || '00'
      ) > 0
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_upload_abandoned');
END;

-- The previous DELETE and its replay are separate writes. Keep the upload root
-- active across that gap, then use the exact terminal replay as the durable
-- deletion acknowledgement and timestamp. A crash before replay therefore
-- leaks safely instead of opening an unquarantined delete race.
CREATE TRIGGER tf_artifact_previous_writer_delete_replay_insert
AFTER INSERT ON tf_artifact_replays
WHEN NEW.status = 204 AND NEW.body_json IS NULL
BEGIN
  UPDATE tf_artifact_roots
  SET state = 'released', fence = fence + 1,
      release_reason = 'upload_abandoned',
      released_at = CASE
        WHEN NEW.expires_at - 86400000 < created_at THEN created_at
        ELSE NEW.expires_at - 86400000
      END
  WHERE root_kind = 'upload' AND target_kind = 'manifest' AND state = 'active'
    AND EXISTS (
      SELECT 1 FROM tf_artifact_uploads AS upload
      WHERE upload.tenant_id = tf_artifact_roots.tenant_id
        AND upload.id = tf_artifact_roots.root_id
        AND upload.manifest_digest = tf_artifact_roots.digest
        AND upload.lifecycle_state = 'abandoned'
        AND instr(
          hex(NEW.replay_key),
          hex(upload.tenant_id) || '00' || hex(upload.principal_id) || '00' ||
            hex('DELETE') || '00'
        ) = 1
        AND instr(hex(NEW.replay_key), hex('/uploads/' || upload.id) || '00') > 0
    );

  UPDATE tf_artifact_uploads
  SET updated_at = CASE
        WHEN NEW.expires_at - 86400000 < created_at THEN created_at
        ELSE NEW.expires_at - 86400000
      END,
      abandoned_at = CASE
        WHEN NEW.expires_at - 86400000 < created_at THEN created_at
        ELSE NEW.expires_at - 86400000
      END
  WHERE lifecycle_state = 'abandoned'
    AND instr(
      hex(NEW.replay_key),
      hex(tenant_id) || '00' || hex(principal_id) || '00' || hex('DELETE') || '00'
    ) = 1
    AND instr(hex(NEW.replay_key), hex('/uploads/' || id) || '00') > 0;
END;

CREATE TRIGGER tf_artifact_previous_writer_delete_replay_update
AFTER UPDATE OF status, body_json, expires_at ON tf_artifact_replays
WHEN NEW.status = 204 AND NEW.body_json IS NULL
BEGIN
  UPDATE tf_artifact_roots
  SET state = 'released', fence = fence + 1,
      release_reason = 'upload_abandoned',
      released_at = CASE
        WHEN NEW.expires_at - 86400000 < created_at THEN created_at
        ELSE NEW.expires_at - 86400000
      END
  WHERE root_kind = 'upload' AND target_kind = 'manifest' AND state = 'active'
    AND EXISTS (
      SELECT 1 FROM tf_artifact_uploads AS upload
      WHERE upload.tenant_id = tf_artifact_roots.tenant_id
        AND upload.id = tf_artifact_roots.root_id
        AND upload.manifest_digest = tf_artifact_roots.digest
        AND upload.lifecycle_state = 'abandoned'
        AND instr(
          hex(NEW.replay_key),
          hex(upload.tenant_id) || '00' || hex(upload.principal_id) || '00' ||
            hex('DELETE') || '00'
        ) = 1
        AND instr(hex(NEW.replay_key), hex('/uploads/' || upload.id) || '00') > 0
    );

  UPDATE tf_artifact_uploads
  SET updated_at = CASE
        WHEN NEW.expires_at - 86400000 < created_at THEN created_at
        ELSE NEW.expires_at - 86400000
      END,
      abandoned_at = CASE
        WHEN NEW.expires_at - 86400000 < created_at THEN created_at
        ELSE NEW.expires_at - 86400000
      END
  WHERE lifecycle_state = 'abandoned'
    AND instr(
      hex(NEW.replay_key),
      hex(tenant_id) || '00' || hex(principal_id) || '00' || hex('DELETE') || '00'
    ) = 1
    AND instr(hex(NEW.replay_key), hex('/uploads/' || id) || '00') > 0;
END;

-- The previous Worker commits with manifest/hold writes followed by one exact
-- terminal replay. The NUL-delimited replay key contains tenant, principal,
-- method, request path, and idempotency key, so the upload identity is fully
-- recoverable without timing assumptions. `hex` is intentional: SQLite text
-- length/pattern functions stop at embedded NUL bytes.
CREATE TRIGGER tf_artifact_previous_writer_replay_insert
AFTER INSERT ON tf_artifact_replays
WHEN json_type(NEW.body_json, '$.manifestDigest') = 'text'
  AND length(json_extract(NEW.body_json, '$.manifestDigest')) = 71
  AND substr(json_extract(NEW.body_json, '$.manifestDigest'), 1, 7) = 'sha256:'
  AND substr(json_extract(NEW.body_json, '$.manifestDigest'), 8) NOT GLOB '*[^0-9a-f]*'
BEGIN
  UPDATE tf_artifact_uploads
  SET lifecycle_state = 'committed',
      lifecycle_fence = lifecycle_fence + 1,
      updated_at = CASE
        WHEN NEW.expires_at - 86400000 < tf_artifact_uploads.created_at
          THEN tf_artifact_uploads.created_at
        ELSE NEW.expires_at - 86400000
      END
  WHERE tf_artifact_uploads.lifecycle_state = 'open'
    AND tf_artifact_uploads.manifest_digest = json_extract(NEW.body_json, '$.manifestDigest')
    AND instr(
      hex(NEW.replay_key),
      hex(tf_artifact_uploads.tenant_id) || '00' ||
        hex(tf_artifact_uploads.principal_id) || '00' || hex('POST') || '00'
    ) = 1
    AND instr(
      hex(NEW.replay_key),
      hex('/uploads/' || tf_artifact_uploads.id || '/commit') || '00'
    ) > 0;

  UPDATE tf_artifact_roots
  SET fence = fence + 1
  WHERE tf_artifact_roots.root_kind = 'upload'
    AND tf_artifact_roots.target_kind = 'manifest'
    AND tf_artifact_roots.state = 'active'
    AND EXISTS (
      SELECT 1 FROM tf_artifact_uploads AS upload
      WHERE upload.tenant_id = tf_artifact_roots.tenant_id
        AND upload.id = tf_artifact_roots.root_id
        AND upload.manifest_digest = tf_artifact_roots.digest
        AND upload.lifecycle_state = 'committed'
        AND upload.manifest_digest = json_extract(NEW.body_json, '$.manifestDigest')
        AND instr(
          hex(NEW.replay_key),
          hex(upload.tenant_id) || '00' || hex(upload.principal_id) || '00' ||
            hex('POST') || '00'
        ) = 1
        AND instr(
          hex(NEW.replay_key),
          hex('/uploads/' || upload.id || '/commit') || '00'
        ) > 0
        AND tf_artifact_roots.fence = upload.lifecycle_fence - 1
    );

  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  SELECT substr(NEW.replay_key, 1, instr(NEW.replay_key, char(0)) - 1),
         'replay', NEW.replay_key, 'manifest',
         json_extract(NEW.body_json, '$.manifestDigest'), 'active', 1,
         NEW.expires_at, NULL,
         CASE WHEN NEW.expires_at < 86400000 THEN 0 ELSE NEW.expires_at - 86400000 END,
         NULL
  WHERE instr(NEW.replay_key, char(0)) > 1
    AND NOT EXISTS (
      SELECT 1 FROM tf_artifact_roots AS root
      WHERE root.root_kind = 'replay' AND root.root_id = NEW.replay_key
        AND root.target_kind = 'manifest'
        AND root.digest = json_extract(NEW.body_json, '$.manifestDigest')
    );
END;

-- The previous replay writer uses ON CONFLICT DO UPDATE after an expired key.
-- UPDATE must carry the same normalization as INSERT; otherwise a rollback can
-- commit a new open upload in SQL while leaving its lifecycle/root open.
CREATE TRIGGER tf_artifact_previous_writer_replay_update
AFTER UPDATE OF status, body_json, expires_at ON tf_artifact_replays
WHEN json_type(NEW.body_json, '$.manifestDigest') = 'text'
  AND length(json_extract(NEW.body_json, '$.manifestDigest')) = 71
  AND substr(json_extract(NEW.body_json, '$.manifestDigest'), 1, 7) = 'sha256:'
  AND substr(json_extract(NEW.body_json, '$.manifestDigest'), 8) NOT GLOB '*[^0-9a-f]*'
BEGIN
  UPDATE tf_artifact_uploads
  SET lifecycle_state = 'committed',
      lifecycle_fence = lifecycle_fence + 1,
      updated_at = CASE
        WHEN NEW.expires_at - 86400000 < tf_artifact_uploads.created_at
          THEN tf_artifact_uploads.created_at
        ELSE NEW.expires_at - 86400000
      END
  WHERE tf_artifact_uploads.lifecycle_state = 'open'
    AND tf_artifact_uploads.manifest_digest = json_extract(NEW.body_json, '$.manifestDigest')
    AND instr(
      hex(NEW.replay_key),
      hex(tf_artifact_uploads.tenant_id) || '00' ||
        hex(tf_artifact_uploads.principal_id) || '00' || hex('POST') || '00'
    ) = 1
    AND instr(
      hex(NEW.replay_key),
      hex('/uploads/' || tf_artifact_uploads.id || '/commit') || '00'
    ) > 0;

  UPDATE tf_artifact_roots
  SET fence = fence + 1
  WHERE tf_artifact_roots.root_kind = 'upload'
    AND tf_artifact_roots.target_kind = 'manifest'
    AND tf_artifact_roots.state = 'active'
    AND EXISTS (
      SELECT 1 FROM tf_artifact_uploads AS upload
      WHERE upload.tenant_id = tf_artifact_roots.tenant_id
        AND upload.id = tf_artifact_roots.root_id
        AND upload.manifest_digest = tf_artifact_roots.digest
        AND upload.lifecycle_state = 'committed'
        AND upload.manifest_digest = json_extract(NEW.body_json, '$.manifestDigest')
        AND instr(
          hex(NEW.replay_key),
          hex(upload.tenant_id) || '00' || hex(upload.principal_id) || '00' ||
            hex('POST') || '00'
        ) = 1
        AND instr(
          hex(NEW.replay_key),
          hex('/uploads/' || upload.id || '/commit') || '00'
        ) > 0
        AND tf_artifact_roots.fence = upload.lifecycle_fence - 1
    );

  UPDATE tf_artifact_roots
  SET state = 'released', fence = fence + 1, release_reason = 'replay_replaced',
      released_at = CASE
        WHEN NEW.expires_at - 86400000 < created_at THEN created_at
        ELSE NEW.expires_at - 86400000
      END
  WHERE root_kind = 'replay' AND root_id = NEW.replay_key AND state = 'active'
    AND digest <> json_extract(NEW.body_json, '$.manifestDigest');

  UPDATE tf_artifact_roots
  SET state = 'active', fence = fence + 1, expires_at = NEW.expires_at,
      release_reason = NULL, released_at = NULL
  WHERE root_kind = 'replay' AND root_id = NEW.replay_key
    AND target_kind = 'manifest'
    AND digest = json_extract(NEW.body_json, '$.manifestDigest');

  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  SELECT substr(NEW.replay_key, 1, instr(NEW.replay_key, char(0)) - 1),
         'replay', NEW.replay_key, 'manifest',
         json_extract(NEW.body_json, '$.manifestDigest'), 'active', 1,
         NEW.expires_at, NULL,
         CASE WHEN NEW.expires_at < 86400000 THEN 0 ELSE NEW.expires_at - 86400000 END,
         NULL
  WHERE instr(NEW.replay_key, char(0)) > 1
    AND NOT EXISTS (
      SELECT 1 FROM tf_artifact_roots AS root
      WHERE root.root_kind = 'replay' AND root.root_id = NEW.replay_key
        AND root.target_kind = 'manifest'
        AND root.digest = json_extract(NEW.body_json, '$.manifestDigest')
    );
END;

-- The previous DELETE physically removed the request row. Under 0031 the row
-- is a durable lifecycle tombstone: open becomes abandoned, while committed
-- and already-abandoned rows remain intact. The root stays active until the
-- exact 204 replay above durably acknowledges deletion. RAISE(IGNORE) lets the
-- previous Worker continue to that write without deleting ownership history.
CREATE TRIGGER tf_artifact_previous_writer_upload_delete
BEFORE DELETE ON tf_artifact_uploads
BEGIN
  UPDATE tf_artifact_uploads
  SET lifecycle_state = 'abandoned', lifecycle_fence = lifecycle_fence + 1,
      updated_at = CASE WHEN updated_at < created_at THEN created_at ELSE updated_at END,
      abandoned_at = CASE WHEN updated_at < created_at THEN created_at ELSE updated_at END
  WHERE id = OLD.id AND lifecycle_state = 'open';

  SELECT RAISE(IGNORE);
END;

-- A root cannot be introduced after external deletion has crossed its SQL
-- fence. The caller must retry from artifact resolution after the candidate is
-- settled; allowing a late root would manufacture a live consumer of missing
-- bytes.
CREATE TRIGGER tf_artifact_active_root_insert_guard
BEFORE INSERT ON tf_artifact_roots
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM tf_artifact_gc_candidates AS candidate
  WHERE candidate.kind = NEW.target_kind AND candidate.digest = NEW.digest
    AND candidate.state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_delete_fenced');
END;

CREATE TRIGGER tf_artifact_active_root_update_guard
BEFORE UPDATE OF state, target_kind, digest ON tf_artifact_roots
WHEN NEW.state = 'active' AND OLD.state <> 'active' AND EXISTS (
  SELECT 1 FROM tf_artifact_gc_candidates AS candidate
  WHERE candidate.kind = NEW.target_kind AND candidate.digest = NEW.digest
    AND candidate.state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_delete_fenced');
END;

CREATE TRIGGER tf_artifact_resource_root_insert
AFTER INSERT ON tf_resources
WHEN json_type(NEW.resource_json, '$.spec.manifestDigest') = 'text'
  AND length(json_extract(NEW.resource_json, '$.spec.manifestDigest')) = 71
  AND substr(json_extract(NEW.resource_json, '$.spec.manifestDigest'), 1, 7) = 'sha256:'
  AND substr(json_extract(NEW.resource_json, '$.spec.manifestDigest'), 8)
        NOT GLOB '*[^0-9a-f]*'
BEGIN
  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  VALUES (
    NEW.tenant_id, 'resource',
    NEW.space || char(0) || NEW.api_version || char(0) || NEW.kind || char(0) || NEW.name,
    'manifest', json_extract(NEW.resource_json, '$.spec.manifestDigest'),
    'active', 1, NULL, NULL, NEW.updated_at, NULL
  )
  ON CONFLICT (tenant_id, root_kind, root_id, target_kind, digest) DO UPDATE SET
    state = 'active', fence = tf_artifact_roots.fence + 1,
    expires_at = NULL, release_reason = NULL, created_at = excluded.created_at,
    released_at = NULL
  WHERE tf_artifact_roots.state = 'released';

  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  SELECT deployment.tenant_id, 'deployment', deployment.id, 'manifest',
         json_extract(NEW.resource_json, '$.spec.manifestDigest'),
         'active', 1, NULL, NULL, deployment.created_at, NULL
  FROM tf_resource_deployments AS deployment
  WHERE deployment.tenant_id = NEW.tenant_id
    AND deployment.resource_uid = NEW.uid AND deployment.state <> 'deleted'
  ON CONFLICT (tenant_id, root_kind, root_id, target_kind, digest) DO UPDATE SET
    state = 'active', fence = tf_artifact_roots.fence + 1,
    expires_at = NULL, release_reason = NULL, created_at = excluded.created_at,
    released_at = NULL
  WHERE tf_artifact_roots.state = 'released';

  UPDATE tf_artifact_consumer_uncertainties
  SET state = 'resolved', fence = fence + 1,
      resolved_at = CASE
        WHEN NEW.updated_at < created_at THEN created_at ELSE NEW.updated_at
      END
  WHERE tenant_id = NEW.tenant_id AND consumer_kind = 'deployment'
    AND reason = 'resource_not_yet_observed' AND state = 'active'
    AND EXISTS (
      SELECT 1
      FROM tf_resource_deployments AS deployment
      JOIN tf_artifact_roots AS root
        ON root.tenant_id = deployment.tenant_id
       AND root.root_kind = 'deployment' AND root.root_id = deployment.id
       AND root.target_kind = 'manifest' AND root.state = 'active'
      WHERE deployment.tenant_id = NEW.tenant_id
        AND deployment.id = tf_artifact_consumer_uncertainties.consumer_id
        AND deployment.resource_uid = NEW.uid AND deployment.state <> 'deleted'
    );
END;

CREATE TRIGGER tf_artifact_resource_root_update
AFTER UPDATE OF tenant_id, space, api_version, kind, name, uid, resource_json ON tf_resources
BEGIN
  UPDATE tf_artifact_roots
  SET state = 'released', fence = fence + 1, release_reason = 'consumer_replaced',
      released_at = CASE WHEN NEW.updated_at < created_at THEN created_at ELSE NEW.updated_at END
  WHERE tenant_id = OLD.tenant_id AND root_kind = 'resource'
    AND root_id = OLD.space || char(0) || OLD.api_version || char(0) ||
      OLD.kind || char(0) || OLD.name
    AND state = 'active';

  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  SELECT NEW.tenant_id, 'resource',
         NEW.space || char(0) || NEW.api_version || char(0) || NEW.kind || char(0) || NEW.name,
         'manifest', json_extract(NEW.resource_json, '$.spec.manifestDigest'),
         'active', 1, NULL, NULL, NEW.updated_at, NULL
  WHERE json_type(NEW.resource_json, '$.spec.manifestDigest') = 'text'
    AND length(json_extract(NEW.resource_json, '$.spec.manifestDigest')) = 71
    AND substr(json_extract(NEW.resource_json, '$.spec.manifestDigest'), 1, 7) = 'sha256:'
    AND substr(json_extract(NEW.resource_json, '$.spec.manifestDigest'), 8)
          NOT GLOB '*[^0-9a-f]*'
  ON CONFLICT (tenant_id, root_kind, root_id, target_kind, digest) DO UPDATE SET
    state = 'active', fence = tf_artifact_roots.fence + 1,
    expires_at = NULL, release_reason = NULL, created_at = excluded.created_at,
    released_at = NULL
  WHERE tf_artifact_roots.state = 'released';

  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  SELECT deployment.tenant_id, 'deployment', deployment.id, 'manifest',
         json_extract(NEW.resource_json, '$.spec.manifestDigest'),
         'active', 1, NULL, NULL, deployment.created_at, NULL
  FROM tf_resource_deployments AS deployment
  WHERE deployment.tenant_id = NEW.tenant_id
    AND deployment.resource_uid = NEW.uid AND deployment.state <> 'deleted'
    AND json_type(NEW.resource_json, '$.spec.manifestDigest') = 'text'
    AND length(json_extract(NEW.resource_json, '$.spec.manifestDigest')) = 71
    AND substr(json_extract(NEW.resource_json, '$.spec.manifestDigest'), 1, 7) = 'sha256:'
    AND substr(json_extract(NEW.resource_json, '$.spec.manifestDigest'), 8)
          NOT GLOB '*[^0-9a-f]*'
  ON CONFLICT (tenant_id, root_kind, root_id, target_kind, digest) DO UPDATE SET
    state = 'active', fence = tf_artifact_roots.fence + 1,
    expires_at = NULL, release_reason = NULL, created_at = excluded.created_at,
    released_at = NULL
  WHERE tf_artifact_roots.state = 'released';

  UPDATE tf_artifact_consumer_uncertainties
  SET state = 'resolved', fence = fence + 1,
      resolved_at = CASE
        WHEN NEW.updated_at < created_at THEN created_at ELSE NEW.updated_at
      END
  WHERE tenant_id = NEW.tenant_id AND consumer_kind = 'deployment'
    AND reason = 'resource_not_yet_observed' AND state = 'active'
    AND EXISTS (
      SELECT 1
      FROM tf_resource_deployments AS deployment
      JOIN tf_artifact_roots AS root
        ON root.tenant_id = deployment.tenant_id
       AND root.root_kind = 'deployment' AND root.root_id = deployment.id
       AND root.target_kind = 'manifest' AND root.state = 'active'
      WHERE deployment.tenant_id = NEW.tenant_id
        AND deployment.id = tf_artifact_consumer_uncertainties.consumer_id
        AND deployment.resource_uid = NEW.uid AND deployment.state <> 'deleted'
    );
END;

CREATE TRIGGER tf_artifact_resource_root_delete
AFTER DELETE ON tf_resources
BEGIN
  UPDATE tf_artifact_roots
  SET state = 'released', fence = fence + 1, release_reason = 'consumer_closed',
      released_at = CASE WHEN OLD.updated_at < created_at THEN created_at ELSE OLD.updated_at END
  WHERE tenant_id = OLD.tenant_id AND root_kind = 'resource'
    AND root_id = OLD.space || char(0) || OLD.api_version || char(0) ||
      OLD.kind || char(0) || OLD.name
    AND state = 'active';
END;

CREATE TRIGGER tf_artifact_deployment_root_insert
AFTER INSERT ON tf_resource_deployments
WHEN NEW.state <> 'deleted'
BEGIN
  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  SELECT NEW.tenant_id, 'deployment', NEW.id, 'manifest',
         json_extract(resource.resource_json, '$.spec.manifestDigest'),
         'active', 1, NULL, NULL, NEW.created_at, NULL
  FROM tf_resources AS resource
  WHERE resource.tenant_id = NEW.tenant_id AND resource.uid = NEW.resource_uid
    AND json_type(resource.resource_json, '$.spec.manifestDigest') = 'text'
    AND length(json_extract(resource.resource_json, '$.spec.manifestDigest')) = 71
    AND substr(json_extract(resource.resource_json, '$.spec.manifestDigest'), 1, 7) = 'sha256:'
    AND substr(json_extract(resource.resource_json, '$.spec.manifestDigest'), 8)
          NOT GLOB '*[^0-9a-f]*'
  ON CONFLICT (tenant_id, root_kind, root_id, target_kind, digest) DO UPDATE SET
    state = 'active', fence = tf_artifact_roots.fence + 1,
    expires_at = NULL, release_reason = NULL, created_at = excluded.created_at,
    released_at = NULL
  WHERE tf_artifact_roots.state = 'released';

  INSERT INTO tf_artifact_consumer_uncertainties
    (tenant_id, consumer_kind, consumer_id, state, fence, reason, created_at, resolved_at)
  SELECT NEW.tenant_id, 'deployment', NEW.id, 'active', 1,
         'resource_not_yet_observed', NEW.created_at, NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM tf_artifact_roots AS root
    WHERE root.tenant_id = NEW.tenant_id AND root.root_kind = 'deployment'
      AND root.root_id = NEW.id AND root.target_kind = 'manifest' AND root.state = 'active'
  )
  ON CONFLICT (tenant_id, consumer_kind, consumer_id) DO UPDATE SET
    state = 'active', fence = tf_artifact_consumer_uncertainties.fence + 1,
    reason = 'resource_not_yet_observed', created_at = excluded.created_at,
    resolved_at = NULL
  WHERE tf_artifact_consumer_uncertainties.state = 'resolved';
END;

CREATE TRIGGER tf_artifact_deployment_root_update
AFTER UPDATE OF tenant_id, id, resource_uid, state ON tf_resource_deployments
BEGIN
  UPDATE tf_artifact_roots
  SET state = 'released', fence = fence + 1, release_reason = 'consumer_closed',
      released_at = CASE WHEN NEW.updated_at < created_at THEN created_at ELSE NEW.updated_at END
  WHERE tenant_id = OLD.tenant_id AND root_kind = 'deployment' AND root_id = OLD.id
    AND state = 'active'
    AND (
      NEW.state = 'deleted' OR NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR
      NEW.resource_uid <> OLD.resource_uid
    );

  INSERT INTO tf_artifact_roots
    (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
     expires_at, release_reason, created_at, released_at)
  SELECT NEW.tenant_id, 'deployment', NEW.id, 'manifest',
         json_extract(resource.resource_json, '$.spec.manifestDigest'),
         'active', 1, NULL, NULL, NEW.created_at, NULL
  FROM tf_resources AS resource
  WHERE NEW.state <> 'deleted' AND resource.tenant_id = NEW.tenant_id
    AND resource.uid = NEW.resource_uid
    AND json_type(resource.resource_json, '$.spec.manifestDigest') = 'text'
    AND length(json_extract(resource.resource_json, '$.spec.manifestDigest')) = 71
    AND substr(json_extract(resource.resource_json, '$.spec.manifestDigest'), 1, 7) = 'sha256:'
    AND substr(json_extract(resource.resource_json, '$.spec.manifestDigest'), 8)
          NOT GLOB '*[^0-9a-f]*'
  ON CONFLICT (tenant_id, root_kind, root_id, target_kind, digest) DO UPDATE SET
    state = 'active', fence = tf_artifact_roots.fence + 1,
    expires_at = NULL, release_reason = NULL, created_at = excluded.created_at,
    released_at = NULL
  WHERE tf_artifact_roots.state = 'released';

  INSERT INTO tf_artifact_consumer_uncertainties
    (tenant_id, consumer_kind, consumer_id, state, fence, reason, created_at, resolved_at)
  SELECT NEW.tenant_id, 'deployment', NEW.id, 'active', 1,
         'resource_not_yet_observed', NEW.created_at, NULL
  WHERE NEW.state <> 'deleted' AND NOT EXISTS (
    SELECT 1 FROM tf_artifact_roots AS root
    WHERE root.tenant_id = NEW.tenant_id AND root.root_kind = 'deployment'
      AND root.root_id = NEW.id AND root.target_kind = 'manifest' AND root.state = 'active'
  )
  ON CONFLICT (tenant_id, consumer_kind, consumer_id) DO UPDATE SET
    state = 'active', fence = tf_artifact_consumer_uncertainties.fence + 1,
    reason = 'resource_not_yet_observed', created_at = excluded.created_at,
    resolved_at = NULL
  WHERE tf_artifact_consumer_uncertainties.state = 'resolved';

  UPDATE tf_artifact_consumer_uncertainties
  SET state = 'resolved', fence = fence + 1,
      resolved_at = CASE
        WHEN NEW.updated_at < created_at THEN created_at ELSE NEW.updated_at
      END
  WHERE tenant_id = OLD.tenant_id AND consumer_kind = 'deployment'
    AND consumer_id = OLD.id AND state = 'active'
    AND (
      NEW.state = 'deleted' OR NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR
      NEW.resource_uid <> OLD.resource_uid OR
      (reason = 'resource_not_yet_observed' AND EXISTS (
        SELECT 1 FROM tf_artifact_roots AS root
        WHERE root.tenant_id = NEW.tenant_id AND root.root_kind = 'deployment'
          AND root.root_id = NEW.id AND root.target_kind = 'manifest' AND root.state = 'active'
      ))
    );
END;

CREATE TRIGGER tf_artifact_deployment_root_delete
BEFORE DELETE ON tf_resource_deployments
WHEN OLD.state <> 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'artifact_deployment_requires_terminal_state');
END;

CREATE TRIGGER tf_artifact_deployment_root_after_delete
AFTER DELETE ON tf_resource_deployments
BEGIN
  UPDATE tf_artifact_roots
  SET state = 'released', fence = fence + 1, release_reason = 'consumer_closed',
      released_at = CASE WHEN OLD.updated_at < created_at THEN created_at ELSE OLD.updated_at END
  WHERE tenant_id = OLD.tenant_id AND root_kind = 'deployment' AND root_id = OLD.id
    AND state = 'active';

  UPDATE tf_artifact_consumer_uncertainties
  SET state = 'resolved', fence = fence + 1,
      resolved_at = CASE
        WHEN OLD.updated_at < created_at THEN created_at ELSE OLD.updated_at
      END
  WHERE tenant_id = OLD.tenant_id AND consumer_kind = 'deployment'
    AND consumer_id = OLD.id AND state = 'active';
END;
