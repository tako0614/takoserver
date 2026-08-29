-- Every logical Resource incarnation gets an append-only Host-owned registry.
-- The logical row is removed only in the same commit that closes its record;
-- unresolved provider work therefore cannot disappear with the Resource.

CREATE TABLE tf_resource_deletion_attestations (
  tenant_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  space TEXT NOT NULL,
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  form_ref_json TEXT NOT NULL,
  state TEXT NOT NULL,
  closure_fence INTEGER NOT NULL,
  effects_json TEXT NOT NULL,
  evidence_json TEXT,
  evidence_ref TEXT,
  evidence_effect_digest TEXT,
  evidence_checked_at INTEGER,
  evidence_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, resource_uid),
  UNIQUE (tenant_id, space, api_version, kind, name, resource_uid),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(space) BETWEEN 1 AND 255),
  CHECK (length(api_version) BETWEEN 1 AND 320),
  CHECK (length(kind) BETWEEN 1 AND 128),
  CHECK (length(name) BETWEEN 1 AND 128),
  CHECK (length(form_ref_json) BETWEEN 2 AND 4096 AND json_valid(form_ref_json)),
  CHECK (state IN ('live', 'pending', 'closed', 'cancelled')),
  CHECK (closure_fence >= 1),
  CHECK (length(effects_json) BETWEEN 2 AND 1048576 AND json_valid(effects_json) AND json_type(effects_json) = 'array'),
  CHECK (evidence_json IS NULL OR (length(evidence_json) BETWEEN 2 AND 1048576 AND json_valid(evidence_json))),
  CHECK (evidence_ref IS NULL OR (length(evidence_ref) = 71 AND substr(evidence_ref, 1, 7) = 'sha256:' AND substr(evidence_ref, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (evidence_effect_digest IS NULL OR (length(evidence_effect_digest) = 71 AND substr(evidence_effect_digest, 1, 7) = 'sha256:' AND substr(evidence_effect_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (evidence_checked_at IS NULL OR evidence_checked_at >= 0),
  CHECK (evidence_status IS NULL OR evidence_status IN ('absent', 'present', 'indeterminate')),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);

CREATE INDEX tf_resource_deletion_attestations_address
  ON tf_resource_deletion_attestations (tenant_id, space, name, updated_at);

-- Provider/migration effects are an append-only event ledger.  Each effect is
-- identified by its stable operation id; phase transitions append a new row
-- instead of rewriting history, so a lost acknowledgement remains visible.
CREATE TABLE tf_resource_provider_effects (
  tenant_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  event_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  operation_mode TEXT NOT NULL,
  provider_pack_ref TEXT,
  provider_installation_ref TEXT,
  native_id TEXT,
  target_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, resource_uid, event_id),
  UNIQUE (tenant_id, resource_uid, effect_id, phase),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(event_id) BETWEEN 3 AND 512),
  CHECK (length(effect_id) BETWEEN 3 AND 255),
  CHECK (effect_kind IN ('apply', 'import', 'provision', 'transfer-export', 'transfer-import', 'verify', 'cancel-delete', 'delete')),
  CHECK (phase IN ('planned', 'dispatched', 'succeeded', 'cancelled')),
  CHECK (operation_mode IN ('initial', 'recovery')),
  CHECK (provider_pack_ref IS NULL OR length(provider_pack_ref) BETWEEN 1 AND 255),
  CHECK (provider_installation_ref IS NULL OR length(provider_installation_ref) BETWEEN 1 AND 255),
  CHECK (native_id IS NULL OR length(native_id) BETWEEN 1 AND 4096),
  CHECK (target_json IS NULL OR (length(target_json) BETWEEN 2 AND 1048576 AND json_valid(target_json))),
  CHECK (created_at >= 0)
);

CREATE INDEX tf_resource_provider_effects_resource
  ON tf_resource_provider_effects (tenant_id, resource_uid, effect_id, created_at);

-- A Resource UID is an incarnation identity, not a recyclable row id.  The
-- registry row is inserted in the same commit as a create/import Resource and
-- retained after delete, so a reused UID fails closed even after the logical
-- resource row is gone.  Existing live rows are registered below.
CREATE UNIQUE INDEX tf_resource_deletion_attestations_uid
  ON tf_resource_deletion_attestations (tenant_id, resource_uid);

-- Validate the entire live inventory before writing any registry row.  A
-- malformed/missing FormRef or duplicate UID must abort this migration rather
-- than be silently omitted and later reported as a fabricated clean delete.
-- D1 does not permit TEMP tables, so the guard is an ordinary value-only table
-- dropped after the check (the same forward-only fail-closed pattern used by
-- the earlier migration guards).
CREATE TABLE tf_resource_deletion_attestation_backfill_guard (
  singleton INTEGER PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO tf_resource_deletion_attestation_backfill_guard (singleton, valid)
WITH RECURSIVE refs AS (
  SELECT
    rowid AS row_id,
    tenant_id,
    uid,
    json_extract(resource_json, '$.form.formRef.apiVersion') AS api_version,
    json_extract(resource_json, '$.form.formRef.kind') AS kind,
    json_extract(resource_json, '$.form.formRef.definitionVersion') AS definition_version,
    json_extract(resource_json, '$.form.formRef.schemaDigest') AS schema_digest,
    json_type(resource_json, '$.form.formRef') AS form_ref_type,
    json_type(resource_json, '$.form.formRef.apiVersion') AS api_version_type,
    json_type(resource_json, '$.form.formRef.kind') AS kind_type,
    json_type(resource_json, '$.form.formRef.definitionVersion') AS definition_version_type,
    json_type(resource_json, '$.form.formRef.schemaDigest') AS schema_digest_type
  FROM tf_resources
),
parts AS (
  SELECT
    row_id,
    tenant_id,
    uid,
    api_version,
    kind,
    definition_version,
    schema_digest,
    form_ref_type,
    api_version_type,
    kind_type,
    definition_version_type,
    schema_digest_type,
    CASE
      WHEN instr(api_version, '/') > 0 THEN substr(api_version, 1, instr(api_version, '/') - 1)
      ELSE api_version
    END AS group_name,
    CASE
      WHEN instr(api_version, '/') > 0 THEN substr(api_version, instr(api_version, '/') + 1)
      ELSE ''
    END AS version
  FROM refs
), semver AS (
  SELECT
    row_id,
    tenant_id,
    uid,
    api_version,
    kind,
    definition_version,
    schema_digest,
    form_ref_type,
    api_version_type,
    kind_type,
    definition_version_type,
    schema_digest_type,
    group_name,
    version,
    CASE
      WHEN instr(definition_version, '-') > 0 THEN substr(definition_version, 1, instr(definition_version, '-') - 1)
      ELSE definition_version
    END AS core_version,
    CASE
      WHEN instr(definition_version, '-') > 0 THEN substr(definition_version, instr(definition_version, '-') + 1)
      ELSE ''
    END AS pre_release
  FROM parts
), semver_parts AS (
  SELECT
    semver.*,
    instr(core_version, '.') AS first_dot,
    substr(core_version, 1, instr(core_version, '.') - 1) AS major,
    substr(core_version, instr(core_version, '.') + 1) AS minor_patch
  FROM semver
), version_parts AS (
  SELECT
    semver_parts.*,
    instr(minor_patch, '.') AS second_dot,
    substr(minor_patch, 1, instr(minor_patch, '.') - 1) AS minor,
    substr(minor_patch, instr(minor_patch, '.') + 1) AS patch
  FROM semver_parts
), api_segments(row_id, segment, remainder) AS (
  SELECT
    row_id,
    CASE
      WHEN instr(group_name, '.') = 0 THEN group_name
      ELSE substr(group_name, 1, instr(group_name, '.') - 1)
    END,
    CASE
      WHEN instr(group_name, '.') = 0 THEN ''
      ELSE substr(group_name, instr(group_name, '.') + 1)
    END
  FROM version_parts
  UNION ALL
  SELECT
    row_id,
    CASE
      WHEN instr(remainder, '.') = 0 THEN remainder
      ELSE substr(remainder, 1, instr(remainder, '.') - 1)
    END,
    CASE
      WHEN instr(remainder, '.') = 0 THEN ''
      ELSE substr(remainder, instr(remainder, '.') + 1)
    END
  FROM api_segments
  WHERE remainder <> ''
), invalid AS (
  SELECT row_id
  FROM version_parts
  WHERE
    form_ref_type <> 'object'
    OR api_version_type <> 'text'
    OR kind_type <> 'text'
    OR definition_version_type <> 'text'
    OR schema_digest_type <> 'text'
    OR api_version IS NULL OR kind IS NULL OR definition_version IS NULL OR schema_digest IS NULL
    OR length(api_version) < 1 OR length(api_version) > 320
    OR api_version GLOB '*[^a-z0-9./-]*'
    OR api_version LIKE '%/%/%'
    OR length(group_name) < 3 OR group_name NOT LIKE '%.%'
    OR group_name GLOB '*[^a-z0-9.-]*'
    OR group_name GLOB '[-.]*' OR group_name GLOB '*[-.]'
    OR group_name LIKE '%..%' OR group_name LIKE '%.-%' OR group_name LIKE '%-.'
    OR group_name IN ('forms.takoform.com', 'packages.forms.takoform.com', 'trust.forms.takoform.com')
    OR EXISTS (
      SELECT 1
      FROM api_segments
      WHERE api_segments.row_id = version_parts.row_id
        AND (
          length(api_segments.segment) < 1
          OR length(api_segments.segment) > 63
          OR api_segments.segment GLOB '*[^a-z0-9-]*'
          OR substr(api_segments.segment, 1, 1) GLOB '[^a-z0-9]'
          OR substr(api_segments.segment, -1, 1) GLOB '[^a-z0-9]'
        )
    )
    OR (
      version <> '' AND (
        length(version) < 2 OR substr(version, 1, 1) <> 'v'
        OR NOT (
          (substr(version, 2) NOT GLOB '*[^0-9]*')
          OR (
            instr(version, 'alpha') > 2
            AND instr(version, 'alpha') = length(version) - length(substr(version, instr(version, 'alpha') + 5)) - 4
            AND substr(version, 2, instr(version, 'alpha') - 2) NOT GLOB '*[^0-9]*'
            AND length(substr(version, 2, instr(version, 'alpha') - 2)) > 0
            AND substr(version, instr(version, 'alpha') + 5) NOT GLOB '*[^0-9]*'
            AND length(substr(version, instr(version, 'alpha') + 5)) > 0
          )
          OR (
            instr(version, 'beta') > 2
            AND instr(version, 'beta') = length(version) - length(substr(version, instr(version, 'beta') + 4)) - 3
            AND substr(version, 2, instr(version, 'beta') - 2) NOT GLOB '*[^0-9]*'
            AND length(substr(version, 2, instr(version, 'beta') - 2)) > 0
            AND substr(version, instr(version, 'beta') + 4) NOT GLOB '*[^0-9]*'
            AND length(substr(version, instr(version, 'beta') + 4)) > 0
          )
        )
      )
    )
    OR length(kind) < 1 OR length(kind) > 64
    OR substr(kind, 1, 1) NOT GLOB '[A-Z]'
    OR kind GLOB '*[^A-Za-z0-9]*'
    OR length(core_version) < 5
    OR length(core_version) - length(replace(core_version, '.', '')) <> 2
    OR core_version GLOB '*[^0-9.]*'
    OR length(major) < 1 OR major GLOB '*[^0-9]*'
    OR length(minor) < 1 OR minor GLOB '*[^0-9]*'
    OR length(patch) < 1 OR patch GLOB '*[^0-9]*'
    OR (length(major) > 1 AND substr(major, 1, 1) = '0')
    OR (length(minor) > 1 AND substr(minor, 1, 1) = '0')
    OR (length(patch) > 1 AND substr(patch, 1, 1) = '0')
    OR (
      pre_release <> '' AND (
        pre_release GLOB '*[^0-9A-Za-z.-]*'
        OR length(pre_release) = 0
      )
    )
    OR length(schema_digest) <> 71
    OR substr(schema_digest, 1, 7) <> 'sha256:'
    OR substr(schema_digest, 8) GLOB '*[^0-9a-f]*'
    OR (
      (SELECT COUNT(*) FROM json_each(json_extract((SELECT resource_json FROM tf_resources WHERE rowid = version_parts.row_id), '$.form.formRef'))) <> 4
      OR EXISTS (
        SELECT 1
        FROM json_each(json_extract((SELECT resource_json FROM tf_resources WHERE rowid = version_parts.row_id), '$.form.formRef')) AS field
        WHERE field.key NOT IN ('apiVersion', 'kind', 'definitionVersion', 'schemaDigest')
      )
    )
)
SELECT 1,
       CASE
         WHEN EXISTS (SELECT 1 FROM invalid)
           OR EXISTS (
             SELECT 1
             FROM tf_resources AS first
             JOIN tf_resources AS second
               ON second.tenant_id = first.tenant_id
              AND second.uid = first.uid
              AND second.rowid <> first.rowid
           )
         THEN 0
         ELSE 1
       END;

INSERT INTO tf_resource_deletion_attestations
  (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
   state, closure_fence, effects_json, evidence_json, evidence_ref,
   evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
SELECT tenant_id, uid, space, api_version, kind, name,
       json_extract(resource_json, '$.form.formRef'),
       'live', 1, '[]', NULL, NULL, NULL, NULL, NULL, updated_at, updated_at
FROM tf_resources;

DROP TABLE tf_resource_deletion_attestation_backfill_guard;

-- No pre-0029 row can be reconstructed safely: old deleted Deployments have
-- no durable FormRef/closure identity. They remain absent from this table and
-- the read path reports indeterminate rather than fabricating an attestation.
