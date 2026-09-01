-- Origin reservation v1 guessed future Resource names before Plan. Preserve
-- those rows as read/drain-only history, while making v2's pre-Plan authority
-- depend only on one requested DNS label. Actual Resource identities are
-- nullable until they are CAS-bound from authoritative Host readback.
--
-- No table has a foreign key to this ledger. The forward rebuild is therefore
-- safe on D1 without disabling foreign keys (which D1 does not honor for
-- cascade actions), and it retains every v1 column as explicit legacy data.

CREATE TABLE worker_endpoint_origin_reservations_forward_v2 (
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
  CHECK (legacy_space IS NULL OR length(legacy_space) BETWEEN 1 AND 128),
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
  CHECK (bound_space IS NULL OR length(bound_space) BETWEEN 1 AND 128),
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

INSERT INTO worker_endpoint_origin_reservations_forward_v2 (
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
  organization_id, reservation_id,
  'takoserver.worker-endpoint-origin-reservation.v1',
  space, worker_name, endpoint_name, NULL,
  canonical_public_origin, provider_pack_ref, provider_installation_ref,
  offering_id, offering_digest, requested_ttl_seconds, expires_at,
  state, revision,
  CASE WHEN worker_resource_uid IS NULL THEN NULL ELSE space END,
  CASE WHEN worker_resource_uid IS NULL THEN NULL ELSE worker_name END,
  worker_resource_uid, worker_resource_revision,
  CASE WHEN endpoint_resource_uid IS NULL THEN NULL ELSE endpoint_name END,
  endpoint_resource_uid, endpoint_resource_revision,
  created_at, updated_at, released_at
FROM worker_endpoint_origin_reservations;

DROP TABLE worker_endpoint_origin_reservations;

ALTER TABLE worker_endpoint_origin_reservations_forward_v2
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
