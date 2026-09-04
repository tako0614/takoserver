-- Active Deployments whose current Resource no longer names an artifact can
-- still be resolved by fresh provider-owned evidence.  Rebuild the durable
-- receipt table forward-only so the new zero-consumption result is explicit;
-- every receipt admitted by 0044 remains byte-for-byte representable.

CREATE TABLE tf_artifact_consumer_resolution_receipts_forward_0049 (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  uncertainty_fence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  resolution TEXT NOT NULL,
  manifest_digest TEXT,
  provider_evidence_digest TEXT NOT NULL,
  deployment_state_before TEXT NOT NULL,
  deployment_updated_at_before INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, deployment_id, uncertainty_fence),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (length(receipt_id) BETWEEN 3 AND 128),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(deployment_id) BETWEEN 3 AND 128),
  CHECK (uncertainty_fence >= 1),
  CHECK (
    length(idempotency_key) BETWEEN 8 AND 128 AND
    substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    length(plan_digest) = 71 AND substr(plan_digest, 1, 7) = 'sha256:' AND
    substr(plan_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(snapshot_digest) = 71 AND substr(snapshot_digest, 1, 7) = 'sha256:' AND
    substr(snapshot_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (resolution IN (
    'terminalized_absent', 'attributed_manifest', 'verified_zero_consumption'
  )),
  CHECK (
    (resolution = 'terminalized_absent' AND manifest_digest IS NULL) OR
    (resolution = 'verified_zero_consumption' AND manifest_digest IS NULL) OR
    (resolution = 'attributed_manifest' AND
      length(manifest_digest) = 71 AND substr(manifest_digest, 1, 7) = 'sha256:' AND
      substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (
    resolution <> 'verified_zero_consumption' OR deployment_state_before = 'active'
  ),
  CHECK (
    length(provider_evidence_digest) = 71 AND
    substr(provider_evidence_digest, 1, 7) = 'sha256:' AND
    substr(provider_evidence_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (deployment_state_before IN ('active', 'retained')),
  CHECK (deployment_updated_at_before >= 0),
  CHECK (created_at >= 0)
);

INSERT INTO tf_artifact_consumer_resolution_receipts_forward_0049
  (receipt_id, tenant_id, deployment_id, uncertainty_fence,
   idempotency_key, plan_digest, snapshot_digest, resolution,
   manifest_digest, provider_evidence_digest, deployment_state_before,
   deployment_updated_at_before, created_at)
SELECT receipt_id, tenant_id, deployment_id, uncertainty_fence,
       idempotency_key, plan_digest, snapshot_digest, resolution,
       manifest_digest, provider_evidence_digest, deployment_state_before,
       deployment_updated_at_before, created_at
FROM tf_artifact_consumer_resolution_receipts;

DROP TABLE tf_artifact_consumer_resolution_receipts;

ALTER TABLE tf_artifact_consumer_resolution_receipts_forward_0049
  RENAME TO tf_artifact_consumer_resolution_receipts;

CREATE INDEX tf_artifact_consumer_resolution_receipts_deployment
  ON tf_artifact_consumer_resolution_receipts
    (tenant_id, deployment_id, uncertainty_fence, created_at);

CREATE TRIGGER tf_artifact_consumer_resolution_receipt_immutable_update
BEFORE UPDATE ON tf_artifact_consumer_resolution_receipts
BEGIN
  SELECT RAISE(ABORT, 'artifact_consumer_resolution_receipt_immutable');
END;

CREATE TRIGGER tf_artifact_consumer_resolution_receipt_durable_delete
BEFORE DELETE ON tf_artifact_consumer_resolution_receipts
BEGIN
  SELECT RAISE(ABORT, 'artifact_consumer_resolution_receipt_durable');
END;
