-- Durable Takoform Host authority and exact Resource-incarnation identity.
--
-- Admission and customer Resource rows are protected durable state. Existing
-- checkpoint/install/purge rows predate the stable Core checkpoint profile,
-- so they are preserved explicitly as v1alpha1. Missing build-config and
-- Resource identities remain NULL and fail closed; this migration never
-- derives authority from the generated Form candidate corpus.

ALTER TABLE tf_form_publisher_events
  ADD COLUMN build_config_commit TEXT
  CHECK (build_config_commit IS NULL OR (length(build_config_commit) = 40 AND build_config_commit NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE tf_form_revocation_checkpoints RENAME TO tf_form_revocation_checkpoints_before_profiles;

CREATE TABLE tf_form_revocation_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  publisher_key TEXT NOT NULL,
  checkpoint_api_version TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  entries_digest TEXT NOT NULL,
  previous_checkpoint_digest TEXT,
  revoked_package_digests_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  policy_event_digest TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  event_digest TEXT NOT NULL,
  predecessor_digest TEXT NOT NULL,
  CHECK (length(id) BETWEEN 3 AND 255),
  CHECK (length(publisher_key) BETWEEN 1 AND 255),
  CHECK (checkpoint_api_version IN ('trust.forms.takoform.com/v1alpha1', 'trust.forms.takoform.com/v1')),
  CHECK (
    (checkpoint_api_version = 'trust.forms.takoform.com/v1alpha1' AND sequence = 1) OR
    (checkpoint_api_version = 'trust.forms.takoform.com/v1alpha1' AND sequence > 1 AND previous_checkpoint_digest IS NOT NULL) OR
    (checkpoint_api_version = 'trust.forms.takoform.com/v1' AND sequence > 0 AND previous_checkpoint_digest IS NOT NULL) OR
    (checkpoint_api_version = 'trust.forms.takoform.com/v1' AND sequence = 0
      AND checkpoint_digest = 'sha256:35c5c4cdc6cd6c4beaec8ba273091be10ae02c0d6f49861f97062fd59f9e8f66'
      AND entries_digest = 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
      AND previous_checkpoint_digest IS NULL
      AND json_array_length(revoked_package_digests_json) = 0)
  ),
  CHECK (length(checkpoint_digest) = 71 AND substr(checkpoint_digest, 1, 7) = 'sha256:' AND substr(checkpoint_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(entries_digest) = 71 AND substr(entries_digest, 1, 7) = 'sha256:' AND substr(entries_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (previous_checkpoint_digest IS NULL OR (length(previous_checkpoint_digest) = 71 AND substr(previous_checkpoint_digest, 1, 7) = 'sha256:' AND substr(previous_checkpoint_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (json_valid(revoked_package_digests_json) AND json_type(revoked_package_digests_json) = 'array'),
  CHECK (length(policy_digest) = 71 AND substr(policy_digest, 1, 7) = 'sha256:' AND substr(policy_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(policy_event_digest) = 71 AND substr(policy_event_digest, 1, 7) = 'sha256:' AND substr(policy_event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(actor) BETWEEN 1 AND 255),
  CHECK (length(reason) BETWEEN 1 AND 4096),
  CHECK (event_at >= 0),
  CHECK (length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:' AND substr(event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(predecessor_digest) = 71 AND substr(predecessor_digest, 1, 7) = 'sha256:' AND substr(predecessor_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (publisher_key, checkpoint_api_version, sequence),
  UNIQUE (publisher_key, checkpoint_api_version, event_digest),
  UNIQUE (publisher_key, checkpoint_api_version, predecessor_digest)
);

INSERT INTO tf_form_revocation_checkpoints
  (id, publisher_key, checkpoint_api_version, sequence, checkpoint_digest,
   entries_digest, previous_checkpoint_digest, revoked_package_digests_json,
   policy_digest, policy_event_digest, actor, reason, event_at, event_digest,
   predecessor_digest)
SELECT id, publisher_key, 'trust.forms.takoform.com/v1alpha1', sequence,
       checkpoint_digest, entries_digest, previous_checkpoint_digest,
       revoked_package_digests_json, policy_digest, policy_event_digest, actor,
       reason, event_at, event_digest, predecessor_digest
FROM tf_form_revocation_checkpoints_before_profiles;

DROP TABLE tf_form_revocation_checkpoints_before_profiles;

CREATE INDEX tf_form_revocation_checkpoint_head_lookup
  ON tf_form_revocation_checkpoints (publisher_key, checkpoint_api_version, sequence, event_at, id);

ALTER TABLE tf_form_install_events RENAME TO tf_form_install_events_before_profiles;

CREATE TABLE tf_form_install_events (
  id TEXT PRIMARY KEY NOT NULL,
  form_ref_key TEXT NOT NULL,
  form_ref_json TEXT NOT NULL,
  form_api_version TEXT NOT NULL,
  form_kind TEXT NOT NULL,
  form_definition_version TEXT NOT NULL,
  schema_digest TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  event_type TEXT NOT NULL,
  replaces_package_digest TEXT,
  admission_report_digest TEXT NOT NULL,
  admission_report_json TEXT NOT NULL,
  publisher_key TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  policy_event_digest TEXT NOT NULL,
  checkpoint_api_version TEXT NOT NULL,
  checkpoint_sequence INTEGER NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  checkpoint_event_digest TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  workflow_commit TEXT NOT NULL,
  build_config_commit TEXT,
  repository_identifier TEXT NOT NULL,
  owner_identifier TEXT NOT NULL,
  namespace_group TEXT NOT NULL,
  namespace_grant_digest TEXT NOT NULL,
  implementation_digest TEXT,
  retention_ref TEXT,
  retention_until INTEGER,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  event_digest TEXT NOT NULL,
  predecessor_digest TEXT NOT NULL,
  CHECK (event_type IN ('install', 'replace', 'uninstall')),
  CHECK (length(id) BETWEEN 3 AND 255),
  CHECK (length(form_ref_key) BETWEEN 1 AND 255),
  CHECK (json_valid(form_ref_json)),
  CHECK (length(form_api_version) BETWEEN 1 AND 255),
  CHECK (length(form_kind) BETWEEN 1 AND 255),
  CHECK (length(form_definition_version) BETWEEN 1 AND 255),
  CHECK (length(schema_digest) = 71 AND substr(schema_digest, 1, 7) = 'sha256:' AND substr(schema_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(package_digest) = 71 AND substr(package_digest, 1, 7) = 'sha256:' AND substr(package_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (replaces_package_digest IS NULL OR (length(replaces_package_digest) = 71 AND substr(replaces_package_digest, 1, 7) = 'sha256:' AND substr(replaces_package_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (length(admission_report_digest) = 71 AND substr(admission_report_digest, 1, 7) = 'sha256:' AND substr(admission_report_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(admission_report_json)),
  CHECK (length(publisher_key) BETWEEN 1 AND 255),
  CHECK (length(policy_digest) = 71 AND substr(policy_digest, 1, 7) = 'sha256:' AND substr(policy_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(policy_event_digest) = 71 AND substr(policy_event_digest, 1, 7) = 'sha256:' AND substr(policy_event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (checkpoint_api_version IN ('trust.forms.takoform.com/v1alpha1', 'trust.forms.takoform.com/v1')),
  CHECK (
    (checkpoint_api_version = 'trust.forms.takoform.com/v1alpha1' AND checkpoint_sequence > 0) OR
    (checkpoint_api_version = 'trust.forms.takoform.com/v1' AND checkpoint_sequence > 0) OR
    (checkpoint_api_version = 'trust.forms.takoform.com/v1' AND checkpoint_sequence = 0
      AND checkpoint_digest = 'sha256:35c5c4cdc6cd6c4beaec8ba273091be10ae02c0d6f49861f97062fd59f9e8f66')
  ),
  CHECK (length(checkpoint_digest) = 71 AND substr(checkpoint_digest, 1, 7) = 'sha256:' AND substr(checkpoint_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(checkpoint_event_digest) = 71 AND substr(checkpoint_event_digest, 1, 7) = 'sha256:' AND substr(checkpoint_event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_commit) BETWEEN 1 AND 256),
  CHECK (length(workflow_commit) BETWEEN 1 AND 256),
  CHECK (build_config_commit IS NULL OR (length(build_config_commit) = 40 AND build_config_commit NOT GLOB '*[^0-9a-f]*')),
  CHECK (
    checkpoint_api_version = 'trust.forms.takoform.com/v1alpha1' OR
    (build_config_commit IS NOT NULL
      AND (length(source_commit) = 40 AND source_commit NOT GLOB '*[^0-9a-f]*')
      AND (length(workflow_commit) = 40 AND workflow_commit NOT GLOB '*[^0-9a-f]*')
      AND (length(build_config_commit) = 40 AND build_config_commit NOT GLOB '*[^0-9a-f]*'))
  ),
  CHECK (length(repository_identifier) BETWEEN 1 AND 256),
  CHECK (length(owner_identifier) BETWEEN 1 AND 256),
  CHECK (length(namespace_group) BETWEEN 1 AND 255),
  CHECK (length(namespace_grant_digest) = 71 AND substr(namespace_grant_digest, 1, 7) = 'sha256:' AND substr(namespace_grant_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (implementation_digest IS NULL OR (length(implementation_digest) = 71 AND substr(implementation_digest, 1, 7) = 'sha256:' AND substr(implementation_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (retention_until IS NULL OR retention_until >= 0),
  CHECK (length(actor) BETWEEN 1 AND 255),
  CHECK (length(reason) BETWEEN 1 AND 4096),
  CHECK (event_at >= 0),
  CHECK (length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:' AND substr(event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(predecessor_digest) = 71 AND substr(predecessor_digest, 1, 7) = 'sha256:' AND substr(predecessor_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (form_ref_key, event_digest),
  UNIQUE (form_ref_key, predecessor_digest)
);

INSERT INTO tf_form_install_events
  (id, form_ref_key, form_ref_json, form_api_version, form_kind,
   form_definition_version, schema_digest, package_digest, event_type,
   replaces_package_digest, admission_report_digest, admission_report_json,
   publisher_key, policy_digest, policy_event_digest, checkpoint_api_version,
   checkpoint_sequence, checkpoint_digest, checkpoint_event_digest,
   source_commit, workflow_commit, build_config_commit, repository_identifier,
   owner_identifier, namespace_group, namespace_grant_digest,
   implementation_digest, retention_ref, retention_until, actor, reason,
   event_at, event_digest, predecessor_digest)
SELECT id, form_ref_key, form_ref_json, form_api_version, form_kind,
       form_definition_version, schema_digest, package_digest, event_type,
       replaces_package_digest, admission_report_digest, admission_report_json,
       publisher_key, policy_digest, policy_event_digest,
       'trust.forms.takoform.com/v1alpha1', checkpoint_sequence,
       checkpoint_digest, checkpoint_event_digest, source_commit,
       workflow_commit, NULL, repository_identifier, owner_identifier,
       namespace_group, namespace_grant_digest, implementation_digest,
       retention_ref, retention_until, actor, reason, event_at, event_digest,
       predecessor_digest
FROM tf_form_install_events_before_profiles;

DROP TABLE tf_form_install_events_before_profiles;

CREATE INDEX tf_form_install_package_lookup
  ON tf_form_install_events (package_digest, form_ref_key, event_at, id);

CREATE INDEX tf_form_install_head_lookup
  ON tf_form_install_events (form_ref_key, event_at, id);

ALTER TABLE tf_form_package_purge_events RENAME TO tf_form_package_purge_events_before_profiles;

CREATE TABLE tf_form_package_purge_events (
  id TEXT PRIMARY KEY NOT NULL,
  form_ref_key TEXT NOT NULL,
  form_ref_json TEXT NOT NULL,
  form_api_version TEXT NOT NULL,
  form_kind TEXT NOT NULL,
  form_definition_version TEXT NOT NULL,
  schema_digest TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  implementation_digest TEXT,
  publisher_key TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  policy_event_digest TEXT NOT NULL,
  checkpoint_api_version TEXT NOT NULL,
  checkpoint_sequence INTEGER NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  checkpoint_event_digest TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  workflow_commit TEXT NOT NULL,
  build_config_commit TEXT,
  repository_identifier TEXT NOT NULL,
  owner_identifier TEXT NOT NULL,
  namespace_group TEXT NOT NULL,
  namespace_grant_digest TEXT NOT NULL,
  admission_report_digest TEXT NOT NULL,
  admission_report_json TEXT NOT NULL,
  retention_ref TEXT,
  retention_until INTEGER,
  event_type TEXT NOT NULL,
  source_install_event_digest TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  event_digest TEXT NOT NULL,
  predecessor_digest TEXT NOT NULL,
  CHECK (event_type IN ('purge-pending', 'purged')),
  CHECK (length(id) BETWEEN 3 AND 255),
  CHECK (length(form_ref_key) BETWEEN 1 AND 255),
  CHECK (json_valid(form_ref_json)),
  CHECK (length(form_api_version) BETWEEN 1 AND 255),
  CHECK (length(form_kind) BETWEEN 1 AND 255),
  CHECK (length(form_definition_version) BETWEEN 1 AND 255),
  CHECK (length(schema_digest) = 71 AND substr(schema_digest, 1, 7) = 'sha256:' AND substr(schema_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(package_digest) = 71 AND substr(package_digest, 1, 7) = 'sha256:' AND substr(package_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (implementation_digest IS NULL OR (length(implementation_digest) = 71 AND substr(implementation_digest, 1, 7) = 'sha256:' AND substr(implementation_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (length(publisher_key) BETWEEN 1 AND 255),
  CHECK (length(policy_digest) = 71 AND substr(policy_digest, 1, 7) = 'sha256:' AND substr(policy_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(policy_event_digest) = 71 AND substr(policy_event_digest, 1, 7) = 'sha256:' AND substr(policy_event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (checkpoint_api_version IN ('trust.forms.takoform.com/v1alpha1', 'trust.forms.takoform.com/v1')),
  CHECK (
    (checkpoint_api_version = 'trust.forms.takoform.com/v1alpha1' AND checkpoint_sequence > 0) OR
    (checkpoint_api_version = 'trust.forms.takoform.com/v1' AND checkpoint_sequence > 0) OR
    (checkpoint_api_version = 'trust.forms.takoform.com/v1' AND checkpoint_sequence = 0
      AND checkpoint_digest = 'sha256:35c5c4cdc6cd6c4beaec8ba273091be10ae02c0d6f49861f97062fd59f9e8f66')
  ),
  CHECK (length(checkpoint_digest) = 71 AND substr(checkpoint_digest, 1, 7) = 'sha256:' AND substr(checkpoint_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(checkpoint_event_digest) = 71 AND substr(checkpoint_event_digest, 1, 7) = 'sha256:' AND substr(checkpoint_event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_commit) BETWEEN 1 AND 256),
  CHECK (length(workflow_commit) BETWEEN 1 AND 256),
  CHECK (build_config_commit IS NULL OR (length(build_config_commit) = 40 AND build_config_commit NOT GLOB '*[^0-9a-f]*')),
  CHECK (
    checkpoint_api_version = 'trust.forms.takoform.com/v1alpha1' OR
    (build_config_commit IS NOT NULL
      AND (length(source_commit) = 40 AND source_commit NOT GLOB '*[^0-9a-f]*')
      AND (length(workflow_commit) = 40 AND workflow_commit NOT GLOB '*[^0-9a-f]*')
      AND (length(build_config_commit) = 40 AND build_config_commit NOT GLOB '*[^0-9a-f]*'))
  ),
  CHECK (length(repository_identifier) BETWEEN 1 AND 256),
  CHECK (length(owner_identifier) BETWEEN 1 AND 256),
  CHECK (length(namespace_group) BETWEEN 1 AND 255),
  CHECK (length(namespace_grant_digest) = 71 AND substr(namespace_grant_digest, 1, 7) = 'sha256:' AND substr(namespace_grant_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(admission_report_digest) = 71 AND substr(admission_report_digest, 1, 7) = 'sha256:' AND substr(admission_report_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(admission_report_json)),
  CHECK (retention_until IS NULL OR retention_until >= 0),
  CHECK (length(source_install_event_digest) = 71 AND substr(source_install_event_digest, 1, 7) = 'sha256:' AND substr(source_install_event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(actor) BETWEEN 1 AND 255),
  CHECK (length(reason) BETWEEN 1 AND 4096),
  CHECK (event_at >= 0),
  CHECK (length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:' AND substr(event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(predecessor_digest) = 71 AND substr(predecessor_digest, 1, 7) = 'sha256:' AND substr(predecessor_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (form_ref_key, package_digest, event_digest),
  UNIQUE (form_ref_key, package_digest, predecessor_digest)
);

INSERT INTO tf_form_package_purge_events
  (id, form_ref_key, form_ref_json, form_api_version, form_kind,
   form_definition_version, schema_digest, package_digest,
   implementation_digest, publisher_key, policy_digest, policy_event_digest,
   checkpoint_api_version, checkpoint_sequence, checkpoint_digest,
   checkpoint_event_digest, source_commit, workflow_commit,
   build_config_commit, repository_identifier, owner_identifier,
   namespace_group, namespace_grant_digest, admission_report_digest,
   admission_report_json, retention_ref, retention_until, event_type,
   source_install_event_digest, actor, reason, event_at, event_digest,
   predecessor_digest)
SELECT id, form_ref_key, form_ref_json, form_api_version, form_kind,
       form_definition_version, schema_digest, package_digest,
       implementation_digest, publisher_key, policy_digest,
       policy_event_digest, 'trust.forms.takoform.com/v1alpha1',
       checkpoint_sequence, checkpoint_digest, checkpoint_event_digest,
       source_commit, workflow_commit, NULL, repository_identifier,
       owner_identifier, namespace_group, namespace_grant_digest,
       admission_report_digest, admission_report_json, retention_ref,
       retention_until, event_type, source_install_event_digest, actor, reason,
       event_at, event_digest, predecessor_digest
FROM tf_form_package_purge_events_before_profiles;

DROP TABLE tf_form_package_purge_events_before_profiles;

CREATE INDEX tf_form_package_purge_lookup
  ON tf_form_package_purge_events (form_ref_key, package_digest, event_at, id);

ALTER TABLE tf_resources
  ADD COLUMN package_digest TEXT
  CHECK (package_digest IS NULL OR (length(package_digest) = 71 AND substr(package_digest, 1, 7) = 'sha256:' AND substr(package_digest, 8) NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE tf_resources
  ADD COLUMN implementation_digest TEXT
  CHECK (implementation_digest IS NULL OR (length(implementation_digest) = 71 AND substr(implementation_digest, 1, 7) = 'sha256:' AND substr(implementation_digest, 8) NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE tf_prepares
  ADD COLUMN authority_head_digest TEXT
  CHECK (authority_head_digest IS NULL OR (length(authority_head_digest) = 71 AND substr(authority_head_digest, 1, 7) = 'sha256:' AND substr(authority_head_digest, 8) NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE tf_provider_mutation_sagas
  ADD COLUMN authority_head_digest TEXT
  CHECK (authority_head_digest IS NULL OR (length(authority_head_digest) = 71 AND substr(authority_head_digest, 1, 7) = 'sha256:' AND substr(authority_head_digest, 8) NOT GLOB '*[^0-9a-f]*'));
