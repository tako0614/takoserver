-- Wire contract v2 for the one-shot Worker runtime-input handoff.
--
-- v1 bound a preparation to a WorkerEndpointOriginReservation and to a
-- caller-computed `rip1.` preflight reference. The released Takoform provider
-- speaks v2 instead: it addresses the preparation by the exact operation key it
-- will also use as the public apply's Idempotency-Key, sends the Host's own
-- canonical public origin, and commits to the exact public apply request.
-- There is therefore no reservation, no material set, and no preflight
-- reference left to store.
--
-- v1 never shipped in a released provider and every row it could hold is a
-- sealed handoff that expires within an hour, so the forward migration replaces
-- the table rather than rewriting rows that cannot exist in a real deployment.

DROP TABLE IF EXISTS worker_runtime_input_preparations;

CREATE TABLE worker_runtime_input_preparations (
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
  CHECK (space IS NULL OR length(space) BETWEEN 1 AND 128),
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
