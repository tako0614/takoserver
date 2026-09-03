-- A Space is the stable Host API identifier, not a Resource metadata.name.
-- Rebuild the three Host-side tables that persist Space so every accepted
-- 1..255-code-point Space has one canonical width across the boundary. Every
-- other column, check, durable value and index stays the same.

-- The reservation ledger is value-free; only the runtime-input table below
-- contains sealed secret material.
CREATE TABLE worker_endpoint_origin_reservations_forward_space_id (
  organization_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  reservation_format TEXT NOT NULL,
  legacy_space TEXT,
  legacy_worker_name TEXT,
  legacy_endpoint_name TEXT,
  requested_subdomain TEXT,
  canonical_public_origin TEXT NOT NULL,
  provider_pack_ref TEXT NOT NULL,
  provider_installation_ref TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  requested_ttl_seconds INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  bound_space TEXT,
  bound_worker_name TEXT,
  worker_resource_uid TEXT,
  worker_resource_revision TEXT,
  bound_endpoint_name TEXT,
  endpoint_resource_uid TEXT,
  endpoint_resource_revision TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (organization_id, reservation_id),
  CHECK (length(organization_id) BETWEEN 1 AND 128),
  CHECK (length(reservation_id) BETWEEN 1 AND 128),
  CHECK (reservation_format IN (
    'takoserver.worker-endpoint-origin-reservation.v1',
    'takoserver.worker-endpoint-origin-reservation.v2'
  )),
  CHECK (
    (reservation_format = 'takoserver.worker-endpoint-origin-reservation.v1' AND
      legacy_space IS NOT NULL AND legacy_worker_name IS NOT NULL AND
      legacy_endpoint_name IS NOT NULL AND requested_subdomain IS NULL) OR
    (reservation_format = 'takoserver.worker-endpoint-origin-reservation.v2' AND
      legacy_space IS NULL AND legacy_worker_name IS NULL AND
      legacy_endpoint_name IS NULL AND requested_subdomain IS NOT NULL)
  ),
  CHECK (legacy_space IS NULL OR length(legacy_space) BETWEEN 1 AND 255),
  CHECK (legacy_worker_name IS NULL OR length(legacy_worker_name) BETWEEN 1 AND 128),
  CHECK (legacy_endpoint_name IS NULL OR length(legacy_endpoint_name) BETWEEN 1 AND 128),
  CHECK (
    requested_subdomain IS NULL OR (
      length(requested_subdomain) BETWEEN 1 AND 63 AND
      requested_subdomain NOT GLOB '*[^a-z0-9-]*' AND
      substr(requested_subdomain, 1, 1) <> '-' AND
      substr(requested_subdomain, -1, 1) <> '-'
    )
  ),
  CHECK (length(canonical_public_origin) BETWEEN 8 AND 2048),
  CHECK (length(provider_pack_ref) BETWEEN 1 AND 255),
  CHECK (length(provider_installation_ref) BETWEEN 1 AND 255),
  CHECK (length(offering_id) BETWEEN 1 AND 255),
  CHECK (
    substr(offering_digest, 1, 7) = 'sha256:' AND
    length(offering_digest) = 71 AND
    substr(offering_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (requested_ttl_seconds BETWEEN 60 AND 86400),
  CHECK (created_at >= 0),
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (state IN ('prepared', 'bound', 'activated', 'expired', 'released')),
  CHECK (revision >= 1),
  CHECK (
    (bound_space IS NULL AND bound_worker_name IS NULL AND
      worker_resource_uid IS NULL AND worker_resource_revision IS NULL) OR
    (bound_space IS NOT NULL AND bound_worker_name IS NOT NULL AND
      worker_resource_uid IS NOT NULL AND worker_resource_revision IS NOT NULL)
  ),
  CHECK (bound_space IS NULL OR length(bound_space) BETWEEN 1 AND 255),
  CHECK (bound_worker_name IS NULL OR length(bound_worker_name) BETWEEN 1 AND 128),
  CHECK (worker_resource_uid IS NULL OR length(worker_resource_uid) BETWEEN 1 AND 128),
  CHECK (
    worker_resource_revision IS NULL OR
    length(worker_resource_revision) BETWEEN 1 AND 19
  ),
  CHECK (
    (bound_endpoint_name IS NULL AND endpoint_resource_uid IS NULL AND
      endpoint_resource_revision IS NULL) OR
    (bound_endpoint_name IS NOT NULL AND endpoint_resource_uid IS NOT NULL AND
      endpoint_resource_revision IS NOT NULL)
  ),
  CHECK (bound_endpoint_name IS NULL OR length(bound_endpoint_name) BETWEEN 1 AND 128),
  CHECK (endpoint_resource_uid IS NULL OR length(endpoint_resource_uid) BETWEEN 1 AND 128),
  CHECK (
    endpoint_resource_revision IS NULL OR
    length(endpoint_resource_revision) BETWEEN 1 AND 19
  ),
  CHECK (state <> 'prepared' OR worker_resource_uid IS NULL),
  CHECK (state NOT IN ('bound', 'activated') OR worker_resource_uid IS NOT NULL),
  CHECK (state <> 'activated' OR endpoint_resource_uid IS NOT NULL),
  CHECK (
    reservation_format = 'takoserver.worker-endpoint-origin-reservation.v1' OR
    endpoint_resource_uid IS NULL OR worker_resource_uid IS NOT NULL
  ),
  CHECK ((state = 'released') = (released_at IS NOT NULL)),
  CHECK (released_at IS NULL OR released_at >= created_at)
);

INSERT INTO worker_endpoint_origin_reservations_forward_space_id (
  organization_id, reservation_id, reservation_format,
  legacy_space, legacy_worker_name, legacy_endpoint_name, requested_subdomain,
  canonical_public_origin, provider_pack_ref, provider_installation_ref,
  offering_id, offering_digest, requested_ttl_seconds, expires_at,
  state, revision, bound_space, bound_worker_name,
  worker_resource_uid, worker_resource_revision, bound_endpoint_name,
  endpoint_resource_uid, endpoint_resource_revision,
  created_at, updated_at, released_at
)
SELECT
  organization_id, reservation_id, reservation_format,
  legacy_space, legacy_worker_name, legacy_endpoint_name, requested_subdomain,
  canonical_public_origin, provider_pack_ref, provider_installation_ref,
  offering_id, offering_digest, requested_ttl_seconds, expires_at,
  state, revision, bound_space, bound_worker_name,
  worker_resource_uid, worker_resource_revision, bound_endpoint_name,
  endpoint_resource_uid, endpoint_resource_revision,
  created_at, updated_at, released_at
FROM worker_endpoint_origin_reservations;

DROP TABLE worker_endpoint_origin_reservations;

ALTER TABLE worker_endpoint_origin_reservations_forward_space_id
  RENAME TO worker_endpoint_origin_reservations;

CREATE UNIQUE INDEX worker_endpoint_origin_reservations_subdomain_live
  ON worker_endpoint_origin_reservations (requested_subdomain)
  WHERE requested_subdomain IS NOT NULL AND (
    state IN ('prepared', 'bound', 'activated') OR
    (state = 'expired' AND endpoint_resource_uid IS NOT NULL)
  );

CREATE UNIQUE INDEX worker_endpoint_origin_reservations_worker_live
  ON worker_endpoint_origin_reservations (
    organization_id,
    COALESCE(bound_space, legacy_space),
    COALESCE(bound_worker_name, legacy_worker_name)
  )
  WHERE (
    reservation_format = 'takoserver.worker-endpoint-origin-reservation.v1' AND
    state IN ('prepared', 'bound', 'activated')
  ) OR (
    bound_space IS NOT NULL AND bound_worker_name IS NOT NULL AND (
      state IN ('bound', 'activated') OR
      (state = 'expired' AND endpoint_resource_uid IS NOT NULL)
    )
  );

CREATE UNIQUE INDEX worker_endpoint_origin_reservations_origin_live
  ON worker_endpoint_origin_reservations (canonical_public_origin)
  WHERE state IN ('prepared', 'bound', 'activated')
     OR (state = 'expired' AND endpoint_resource_uid IS NOT NULL);

CREATE UNIQUE INDEX worker_endpoint_origin_reservations_endpoint_live
  ON worker_endpoint_origin_reservations (organization_id, endpoint_resource_uid)
  WHERE endpoint_resource_uid IS NOT NULL AND (
    state IN ('bound', 'activated') OR
    (state = 'expired' AND endpoint_resource_uid IS NOT NULL)
  );

CREATE INDEX worker_endpoint_origin_reservations_expiry
  ON worker_endpoint_origin_reservations (state, expires_at, organization_id, reservation_id)
  WHERE state IN ('prepared', 'bound');

CREATE INDEX worker_endpoint_origin_reservations_endpoint
  ON worker_endpoint_origin_reservations (organization_id, endpoint_resource_uid, state)
  WHERE endpoint_resource_uid IS NOT NULL;

-- Provider mutation sagas carry the canonical Space used by the Host target.
-- Keep authority, lease and provider-outcome columns introduced after the
-- original table; this is a width-only expansion of target_space.
CREATE TABLE tf_provider_mutation_sagas_forward_space_id (
  operation_id TEXT PRIMARY KEY NOT NULL,
  replay_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  target_space TEXT NOT NULL,
  target_api_version TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_name TEXT NOT NULL,
  accepted_uid TEXT,
  accepted_generation TEXT,
  accepted_revision TEXT,
  phase TEXT NOT NULL,
  receipt_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  authority_head_digest TEXT
  CHECK (authority_head_digest IS NULL OR (length(authority_head_digest) = 71 AND substr(authority_head_digest, 1, 7) = 'sha256:' AND substr(authority_head_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  execution_lease_token TEXT
  CHECK (
    execution_lease_token IS NULL OR
    length(execution_lease_token) BETWEEN 3 AND 128
  ),
  execution_lease_until INTEGER
  CHECK (execution_lease_until IS NULL OR execution_lease_until >= 0),
  execution_started_at INTEGER
  CHECK (execution_started_at IS NULL OR execution_started_at >= created_at),
  provider_handle TEXT
  CHECK (
    provider_handle IS NULL OR
    length(provider_handle) BETWEEN 1 AND 4096
  ),
  provider_outcome TEXT NOT NULL DEFAULT 'planned'
  CHECK (provider_outcome IN ('planned', 'running', 'indeterminate')),
  CHECK (length(operation_id) BETWEEN 3 AND 128),
  CHECK (length(replay_key) BETWEEN 1 AND 1024),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(fingerprint) BETWEEN 2 AND 8192),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(target_space) BETWEEN 1 AND 255),
  CHECK (length(target_api_version) BETWEEN 1 AND 255),
  CHECK (length(target_kind) BETWEEN 1 AND 128),
  CHECK (length(target_name) BETWEEN 1 AND 128),
  CHECK (
    (accepted_uid IS NULL AND accepted_generation IS NULL AND accepted_revision IS NULL) OR
    (accepted_uid IS NOT NULL AND accepted_generation IS NOT NULL AND accepted_revision IS NOT NULL)
  ),
  CHECK (phase IN ('planned', 'executed')),
  CHECK (
    (phase = 'planned' AND receipt_json IS NULL) OR
    (phase = 'executed' AND receipt_json IS NOT NULL AND length(receipt_json) BETWEEN 2 AND 1048576)
  ),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (
    (phase = 'planned' AND expires_at IS NOT NULL AND expires_at >= updated_at) OR
    (phase = 'executed' AND expires_at IS NULL)
  )
);

INSERT INTO tf_provider_mutation_sagas_forward_space_id (
  operation_id, replay_key, tenant_id, fingerprint, resource_uid, target_space,
  target_api_version, target_kind, target_name, accepted_uid,
  accepted_generation, accepted_revision, phase, receipt_json, created_at,
  updated_at, expires_at, authority_head_digest, execution_lease_token,
  execution_lease_until, execution_started_at, provider_handle, provider_outcome
)
SELECT
  operation_id, replay_key, tenant_id, fingerprint, resource_uid, target_space,
  target_api_version, target_kind, target_name, accepted_uid,
  accepted_generation, accepted_revision, phase, receipt_json, created_at,
  updated_at, expires_at, authority_head_digest, execution_lease_token,
  execution_lease_until, execution_started_at, provider_handle, provider_outcome
FROM tf_provider_mutation_sagas;

DROP TABLE tf_provider_mutation_sagas;

ALTER TABLE tf_provider_mutation_sagas_forward_space_id
  RENAME TO tf_provider_mutation_sagas;

CREATE INDEX tf_provider_mutation_sagas_expiry
  ON tf_provider_mutation_sagas (expires_at) WHERE expires_at IS NOT NULL;

CREATE UNIQUE INDEX tf_provider_mutation_sagas_target
  ON tf_provider_mutation_sagas (
    tenant_id, target_space, target_api_version, target_kind, target_name
  );

CREATE INDEX tf_provider_mutation_sagas_execution_lease
  ON tf_provider_mutation_sagas (phase, execution_lease_until);

CREATE INDEX tf_provider_mutation_sagas_provider_outcome
  ON tf_provider_mutation_sagas (phase, provider_outcome, execution_lease_until);

-- Runtime input preparations contain the sealed handoff and its lifecycle.
-- `space` is nullable while a preparation is still unclaimed, hence the
-- nullable width check is expanded without changing any sealed fields.
CREATE TABLE worker_runtime_input_preparations_forward_space_id (
  organization_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  preparation_id TEXT NOT NULL,
  apply_commitment TEXT NOT NULL,
  canonical_public_origin TEXT NOT NULL,
  binding_names_json TEXT NOT NULL,
  sealed_payload TEXT,
  seal_nonce TEXT,
  seal_key_id TEXT,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  host_operation_id TEXT,
  claim_owner TEXT,
  claim_expires_at INTEGER,
  claimed_resource_uid TEXT,
  space TEXT,
  worker_name TEXT,
  worker_resource_uid TEXT,
  bundle_name TEXT,
  consumed_receipt_digest TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (organization_id, operation_key),
  UNIQUE (organization_id, preparation_id),
  CHECK (length(organization_id) BETWEEN 1 AND 128),
  CHECK (length(operation_key) BETWEEN 8 AND 128),
  CHECK (length(preparation_id) BETWEEN 3 AND 42),
  CHECK (
    substr(apply_commitment, 1, 7) = 'sha256:' AND
    length(apply_commitment) = 71 AND
    substr(apply_commitment, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(canonical_public_origin) BETWEEN 8 AND 2048),
  CHECK (length(binding_names_json) BETWEEN 3 AND 8192),
  CHECK (state IN (
    'prepared', 'claimed', 'dispatched', 'consumed',
    'revoked', 'expired', 'indeterminate'
  )),
  CHECK (fence >= 1),
  CHECK ((sealed_payload IS NULL) = (seal_nonce IS NULL)),
  CHECK ((sealed_payload IS NULL) = (seal_key_id IS NULL)),
  CHECK ((state IN ('prepared', 'claimed')) = (sealed_payload IS NOT NULL)),
  CHECK ((claim_owner IS NULL) = (claim_expires_at IS NULL)),
  CHECK (claim_expires_at IS NULL OR claim_expires_at >= created_at),
  -- A claimed or later handoff names the exact Host operation and logical
  -- Worker target it was claimed for. A prepared row knows neither yet: the
  -- public apply that will consume it has not reached the provider.
  CHECK (state <> 'prepared' OR host_operation_id IS NULL),
  CHECK (
    state NOT IN ('claimed', 'dispatched', 'consumed')
    OR (
      host_operation_id IS NOT NULL AND claimed_resource_uid IS NOT NULL AND
      space IS NOT NULL AND worker_name IS NOT NULL AND
      worker_resource_uid IS NOT NULL AND bundle_name IS NOT NULL
    )
  ),
  CHECK (space IS NULL OR length(space) BETWEEN 1 AND 255),
  CHECK (worker_name IS NULL OR length(worker_name) BETWEEN 1 AND 128),
  CHECK (worker_resource_uid IS NULL OR length(worker_resource_uid) BETWEEN 3 AND 128),
  CHECK (bundle_name IS NULL OR length(bundle_name) BETWEEN 1 AND 128),
  CHECK (host_operation_id IS NULL OR length(host_operation_id) BETWEEN 3 AND 128),
  CHECK (expires_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((state = 'consumed') = (consumed_receipt_digest IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

INSERT INTO worker_runtime_input_preparations_forward_space_id (
  organization_id, operation_key, preparation_id, apply_commitment,
  canonical_public_origin, binding_names_json, sealed_payload, seal_nonce,
  seal_key_id, state, fence, host_operation_id, claim_owner,
  claim_expires_at, claimed_resource_uid, space, worker_name,
  worker_resource_uid, bundle_name, consumed_receipt_digest, expires_at,
  created_at, updated_at, consumed_at, revoked_at
)
SELECT
  organization_id, operation_key, preparation_id, apply_commitment,
  canonical_public_origin, binding_names_json, sealed_payload, seal_nonce,
  seal_key_id, state, fence, host_operation_id, claim_owner,
  claim_expires_at, claimed_resource_uid, space, worker_name,
  worker_resource_uid, bundle_name, consumed_receipt_digest, expires_at,
  created_at, updated_at, consumed_at, revoked_at
FROM worker_runtime_input_preparations;

DROP TABLE worker_runtime_input_preparations;

ALTER TABLE worker_runtime_input_preparations_forward_space_id
  RENAME TO worker_runtime_input_preparations;

CREATE INDEX worker_runtime_input_preparations_expiry
  ON worker_runtime_input_preparations (state, expires_at, organization_id, operation_key)
  WHERE state = 'prepared';

CREATE INDEX worker_runtime_input_preparations_claim
  ON worker_runtime_input_preparations (state, claim_expires_at, organization_id, operation_key)
  WHERE state = 'claimed';

-- ModuleWorker deletion consults this by exact worker uid, so the live-claim
-- fence stays one indexed lookup rather than a scan of every organization.
CREATE INDEX worker_runtime_input_preparations_worker
  ON worker_runtime_input_preparations (organization_id, worker_resource_uid, state)
  WHERE worker_resource_uid IS NOT NULL;
