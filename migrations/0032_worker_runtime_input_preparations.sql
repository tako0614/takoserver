-- Future Worker endpoint origins are reserved by Takoserver before either the
-- ModuleWorker or WorkerEndpoint exists. This ledger is value-free; only the
-- runtime-input table below contains sealed secret material.

CREATE TABLE worker_endpoint_origin_reservations (
  organization_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  space TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  endpoint_name TEXT NOT NULL,
  canonical_public_origin TEXT NOT NULL,
  provider_pack_ref TEXT NOT NULL,
  provider_installation_ref TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  requested_ttl_seconds INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  worker_resource_uid TEXT,
  worker_resource_revision TEXT,
  endpoint_resource_uid TEXT,
  endpoint_resource_revision TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (organization_id, reservation_id),
  CHECK (length(organization_id) BETWEEN 1 AND 128),
  CHECK (length(reservation_id) BETWEEN 1 AND 128),
  CHECK (length(space) BETWEEN 1 AND 128),
  CHECK (length(worker_name) BETWEEN 1 AND 128),
  CHECK (length(endpoint_name) BETWEEN 1 AND 128),
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
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (state IN ('prepared', 'bound', 'activated', 'expired', 'released')),
  CHECK (revision >= 1),
  CHECK ((worker_resource_uid IS NULL) = (worker_resource_revision IS NULL)),
  CHECK (state <> 'prepared' OR worker_resource_uid IS NULL),
  CHECK (state NOT IN ('bound', 'activated') OR worker_resource_uid IS NOT NULL),
  CHECK ((endpoint_resource_uid IS NULL) = (endpoint_resource_revision IS NULL)),
  CHECK (state <> 'activated' OR endpoint_resource_uid IS NOT NULL),
  CHECK ((state = 'released') = (released_at IS NOT NULL)),
  CHECK (released_at IS NULL OR released_at >= created_at)
);

CREATE UNIQUE INDEX worker_endpoint_origin_reservations_worker_live
  ON worker_endpoint_origin_reservations (organization_id, space, worker_name)
  WHERE state IN ('prepared', 'bound', 'activated')
     OR (state = 'expired' AND endpoint_resource_uid IS NOT NULL);

CREATE UNIQUE INDEX worker_endpoint_origin_reservations_origin_live
  ON worker_endpoint_origin_reservations (canonical_public_origin)
  WHERE state IN ('prepared', 'bound', 'activated')
     OR (state = 'expired' AND endpoint_resource_uid IS NOT NULL);

CREATE INDEX worker_endpoint_origin_reservations_expiry
  ON worker_endpoint_origin_reservations (state, expires_at, organization_id, reservation_id)
  WHERE state IN ('prepared', 'bound');

CREATE INDEX worker_endpoint_origin_reservations_endpoint
  ON worker_endpoint_origin_reservations (organization_id, endpoint_resource_uid, state)
  WHERE endpoint_resource_uid IS NOT NULL;

-- Worker runtime inputs are a Takoserver control-plane operation, not part of
-- the stable Takoform Host API. Secret values are sealed before persistence;
-- every public projection contains names and target identity only.

CREATE TABLE worker_runtime_input_preparations (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  preparation_id TEXT NOT NULL,
  preparation_commitment TEXT NOT NULL,
  material_set_id TEXT NOT NULL,
  material_set_nonce TEXT NOT NULL,
  space TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  endpoint_name TEXT NOT NULL,
  worker_resource_uid TEXT NOT NULL,
  worker_resource_revision TEXT NOT NULL,
  bundle_name TEXT NOT NULL,
  origin_reservation_id TEXT NOT NULL,
  origin_reservation_revision INTEGER NOT NULL,
  canonical_public_origin TEXT NOT NULL,
  provider_pack_ref TEXT NOT NULL,
  provider_installation_ref TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  binding_names_json TEXT NOT NULL,
  sealed_payload TEXT,
  seal_nonce TEXT,
  seal_key_id TEXT,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  claim_owner TEXT,
  claim_expires_at INTEGER,
  claimed_resource_uid TEXT,
  dispatched_operation_id TEXT,
  consumed_receipt_digest TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, preparation_id),
  CHECK (length(organization_id) BETWEEN 1 AND 128),
  CHECK (length(operation_id) BETWEEN 3 AND 128),
  CHECK (length(preparation_id) BETWEEN 3 AND 42),
  CHECK (
    substr(preparation_commitment, 1, 7) = 'sha256:' AND
    length(preparation_commitment) = 71 AND
    substr(preparation_commitment, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(material_set_id) BETWEEN 1 AND 128),
  CHECK (length(material_set_nonce) BETWEEN 1 AND 128),
  CHECK (length(space) BETWEEN 1 AND 128),
  CHECK (length(worker_name) BETWEEN 1 AND 128),
  CHECK (length(endpoint_name) BETWEEN 1 AND 128),
  CHECK (length(worker_resource_uid) BETWEEN 3 AND 128),
  CHECK (length(worker_resource_revision) BETWEEN 1 AND 19),
  CHECK (length(bundle_name) BETWEEN 1 AND 128),
  CHECK (length(origin_reservation_id) BETWEEN 1 AND 128),
  CHECK (origin_reservation_revision >= 1),
  CHECK (length(canonical_public_origin) BETWEEN 8 AND 2048),
  CHECK (length(provider_pack_ref) BETWEEN 1 AND 255),
  CHECK (length(provider_installation_ref) BETWEEN 1 AND 255),
  CHECK (length(offering_id) BETWEEN 1 AND 255),
  CHECK (
    substr(offering_digest, 1, 7) = 'sha256:' AND
    length(offering_digest) = 71 AND
    substr(offering_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
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
  CHECK (expires_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX worker_runtime_input_preparations_expiry
  ON worker_runtime_input_preparations (state, expires_at, organization_id, operation_id)
  WHERE state = 'prepared';

CREATE INDEX worker_runtime_input_preparations_claim
  ON worker_runtime_input_preparations (state, claim_expires_at, organization_id, operation_id)
  WHERE state = 'claimed';

CREATE INDEX worker_runtime_input_preparations_target
  ON worker_runtime_input_preparations (
    organization_id, space, worker_resource_uid, bundle_name, origin_reservation_id, state
  );
