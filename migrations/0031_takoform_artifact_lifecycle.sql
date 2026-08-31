-- Artifact uploads are durable owners, not temporary request rows. Existing
-- rows predate an explicit lifecycle and are conservatively classified as
-- committed: leaking old bytes is safer than deleting a possibly published
-- bundle. New runtime code always writes `open` explicitly.

ALTER TABLE tf_artifact_uploads
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'committed'
  CHECK (lifecycle_state IN ('open', 'committed', 'abandoned'));

ALTER TABLE tf_artifact_uploads
  ADD COLUMN lifecycle_fence INTEGER NOT NULL DEFAULT 1
  CHECK (lifecycle_fence >= 1);

ALTER TABLE tf_artifact_uploads
  ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0
  CHECK (updated_at >= 0);

ALTER TABLE tf_artifact_uploads
  ADD COLUMN abandoned_at INTEGER
  CHECK (abandoned_at IS NULL OR abandoned_at >= 0);

UPDATE tf_artifact_uploads SET updated_at = created_at;

-- Manifest membership is immutable content-addressed metadata. Roots point at
-- one manifest; its member rows prove every blob kept alive by that root even
-- when a PUT reached R2 before the tenant hold reached SQL.
CREATE TABLE tf_artifact_manifest_members (
  manifest_digest TEXT NOT NULL,
  blob_digest TEXT NOT NULL,
  PRIMARY KEY (manifest_digest, blob_digest),
  CHECK (
    length(manifest_digest) = 71 AND
    substr(manifest_digest, 1, 7) = 'sha256:' AND
    substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(blob_digest) = 71 AND
    substr(blob_digest, 1, 7) = 'sha256:' AND
    substr(blob_digest, 8) NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX tf_artifact_manifest_members_blob
  ON tf_artifact_manifest_members (blob_digest, manifest_digest);

INSERT OR IGNORE INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
SELECT upload.manifest_digest, json_extract(member.value, '$.digest')
FROM tf_artifact_uploads AS upload, json_each(json_extract(upload.manifest_json, '$.modules')) AS member;

INSERT OR IGNORE INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
SELECT upload.manifest_digest, json_extract(member.value, '$.digest')
FROM tf_artifact_uploads AS upload, json_each(json_extract(upload.manifest_json, '$.files')) AS member;

INSERT OR IGNORE INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
SELECT manifest.digest, json_extract(member.value, '$.digest')
FROM tf_artifact_manifests AS manifest, json_each(json_extract(manifest.manifest_json, '$.modules')) AS member;

INSERT OR IGNORE INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
SELECT manifest.digest, json_extract(member.value, '$.digest')
FROM tf_artifact_manifests AS manifest, json_each(json_extract(manifest.manifest_json, '$.files')) AS member;

-- A root is the normalized liveness authority. Committed upload roots do not
-- expire and generic reconciliation never releases them. Replay roots remain
-- active through their exact expiry even when the upload was abandoned.
CREATE TABLE tf_artifact_roots (
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
  CHECK (root_kind IN ('upload', 'replay', 'legacy-hold', 'legacy-manifest')),
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
    'upload_abandoned', 'replay_expired', 'operator_exact_failed_run'
  )),
  CHECK (
    (state = 'active' AND released_at IS NULL AND release_reason IS NULL) OR
    (state = 'released' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  ),
  CHECK (created_at >= 0),
  CHECK (released_at IS NULL OR released_at >= created_at)
);

CREATE INDEX tf_artifact_roots_live_digest
  ON tf_artifact_roots (target_kind, digest, tenant_id)
  WHERE state = 'active';

CREATE INDEX tf_artifact_roots_expiry
  ON tf_artifact_roots (expires_at, tenant_id, root_id)
  WHERE state = 'active' AND expires_at IS NOT NULL;

INSERT INTO tf_artifact_roots
  (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
   expires_at, release_reason, created_at, released_at)
SELECT tenant_id, 'upload', id, 'manifest', manifest_digest, 'active',
       lifecycle_fence, NULL, NULL, created_at, NULL
FROM tf_artifact_uploads;

-- Historical replay roots use the tenant prefix already present in their
-- canonical replay key. Invalid historical shapes fail closed into the legacy
-- hold roots below rather than fabricating an owner.
INSERT OR IGNORE INTO tf_artifact_roots
  (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
   expires_at, release_reason, created_at, released_at)
SELECT substr(replay_key, 1, instr(replay_key, char(0)) - 1),
       'replay', replay_key, 'manifest', json_extract(body_json, '$.manifestDigest'),
       'active', 1, expires_at, NULL, 0, NULL
FROM tf_artifact_replays
WHERE instr(replay_key, char(0)) > 1
  AND json_type(body_json, '$.manifestDigest') = 'text'
  AND length(json_extract(body_json, '$.manifestDigest')) = 71
  AND substr(json_extract(body_json, '$.manifestDigest'), 1, 7) = 'sha256:'
  AND substr(json_extract(body_json, '$.manifestDigest'), 8) NOT GLOB '*[^0-9a-f]*';

-- Old holds without a provable upload/replay owner become permanent legacy
-- roots. They may leak bytes, but no migration may guess that they are dead.
INSERT INTO tf_artifact_roots
  (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
   expires_at, release_reason, created_at, released_at)
SELECT hold.tenant_id, 'legacy-hold', hold.kind || ':' || hold.digest,
       hold.kind, hold.digest, 'active', 1, NULL, NULL, 0, NULL
FROM tf_artifact_holds AS hold
WHERE NOT EXISTS (
  SELECT 1
  FROM tf_artifact_roots AS root
  WHERE root.tenant_id = hold.tenant_id
    AND root.state = 'active'
    AND (
      (hold.kind = 'manifest' AND root.target_kind = 'manifest' AND root.digest = hold.digest) OR
      (hold.kind = 'blob' AND (
        (root.target_kind = 'blob' AND root.digest = hold.digest) OR
        (root.target_kind = 'manifest' AND EXISTS (
          SELECT 1 FROM tf_artifact_manifest_members AS member
          WHERE member.manifest_digest = root.digest AND member.blob_digest = hold.digest
        ))
      ))
    )
);

-- A manifest row with no tenant hold still predates normalized ownership. It
-- is quarantined globally; the reconciler reports it but never infers death.
INSERT INTO tf_artifact_roots
  (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
   expires_at, release_reason, created_at, released_at)
SELECT '__legacy_global__', 'legacy-manifest', manifest.digest, 'manifest',
       manifest.digest, 'active', 1, NULL, NULL, manifest.created_at, NULL
FROM tf_artifact_manifests AS manifest
WHERE NOT EXISTS (
  SELECT 1 FROM tf_artifact_roots AS root
  WHERE root.target_kind = 'manifest' AND root.digest = manifest.digest AND root.state = 'active'
);

-- A deleting candidate is a database fence around an external object delete.
-- The tombstone remains after success; uncertain external outcomes therefore
-- stay visible and retryable instead of being mistaken for clean state.
CREATE TABLE tf_artifact_gc_candidates (
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  not_before INTEGER NOT NULL,
  expected_etag TEXT,
  attempts INTEGER NOT NULL,
  last_outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (kind, digest),
  CHECK (kind IN ('manifest', 'blob')),
  CHECK (
    length(digest) = 71 AND
    substr(digest, 1, 7) = 'sha256:' AND
    substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (state IN ('pending', 'deleting', 'retry', 'deleted', 'cancelled')),
  CHECK (fence >= 1),
  CHECK (not_before >= 0),
  CHECK (expected_etag IS NULL OR length(expected_etag) BETWEEN 1 AND 512),
  CHECK (attempts >= 0),
  CHECK (last_outcome IN (
    'pending', 'reference_present', 'claimed', 'delete_failed',
    'etag_changed', 'deleted', 'already_absent', 'metadata_deleted'
  )),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE INDEX tf_artifact_gc_candidates_due
  ON tf_artifact_gc_candidates (state, not_before, updated_at, kind, digest);

-- CHECK violations abort the surrounding D1/SQLite batch. Artifact start uses
-- this to prove that no requested digest is inside an external-delete fence.
CREATE TABLE tf_artifact_gc_guards (
  token TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  CHECK (length(token) BETWEEN 3 AND 128)
);
