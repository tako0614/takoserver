-- Expand the private receipt kind to distinguish provider-native custom domains.
-- Apply inside the owning migration transaction with writers quiesced. SQLite
-- cannot alter CHECK constraints. Preserve the receipt-coupled 0057 ciphertext
-- tables explicitly before replacing their parent; foreign keys stay enabled.
-- No legacy row, sealed value, index, or trigger changes meaning.

CREATE TABLE migration_0058_cloudflare_managed_worker_receipts AS SELECT * FROM cloudflare_managed_worker_receipts;
CREATE TABLE migration_0058_cloudflare_managed_worker_version_execution_material AS SELECT * FROM cloudflare_managed_worker_version_execution_material;
CREATE TABLE migration_0058_cloudflare_managed_worker_version_execution_secrets AS SELECT * FROM cloudflare_managed_worker_version_execution_secrets;
CREATE TABLE migration_0058_cloudflare_managed_worker_version_execution_provider_proofs AS SELECT * FROM cloudflare_managed_worker_version_execution_provider_proofs;

DROP TRIGGER cloudflare_managed_worker_version_execution_material_insert_once;
DROP TRIGGER cloudflare_managed_worker_version_execution_material_exact_insert;
DROP TRIGGER cloudflare_managed_worker_version_execution_material_name_sets;
DROP TRIGGER cloudflare_managed_worker_version_execution_material_immutable_update;
DROP TRIGGER cloudflare_managed_worker_version_execution_material_receipt_delete_only;
DROP TRIGGER cloudflare_managed_worker_version_execution_secret_exact_insert;
DROP TRIGGER cloudflare_managed_worker_version_execution_proof_exact_insert;
DROP TRIGGER cloudflare_managed_worker_version_execution_receipt_commit_complete;
DROP TRIGGER cloudflare_managed_worker_version_execution_secret_immutable_update;
DROP TRIGGER cloudflare_managed_worker_version_execution_proof_immutable_update;
DROP TRIGGER cloudflare_managed_worker_version_execution_secret_parent_delete_only;
DROP TRIGGER cloudflare_managed_worker_version_execution_proof_parent_delete_only;
DROP TRIGGER cloudflare_managed_worker_version_execution_receipt_replacement_cleanup;
DROP TABLE cloudflare_managed_worker_version_execution_provider_proofs;
DROP TABLE cloudflare_managed_worker_version_execution_secrets;
DROP TABLE cloudflare_managed_worker_version_execution_material;
DROP TABLE cloudflare_managed_worker_receipts;

-- Provider-private authority for the official Cloudflare Workers-for-Platforms
-- lane. These rows are the first-primary gateway authority and the durable
-- receipts that make a lost provider acknowledgement recoverable.
CREATE TABLE cloudflare_managed_worker_receipts (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  resource_uid TEXT NOT NULL CHECK (length(resource_uid) BETWEEN 1 AND 1024),
  native_id TEXT NOT NULL CHECK (length(native_id) BETWEEN 1 AND 1024),
  kind TEXT NOT NULL CHECK (
    kind IN ('worker', 'version', 'deployment', 'endpoint', 'domain', 'cron', 'consumer', 'sqlite')
  ),
  logical_worker_id TEXT NOT NULL CHECK (length(logical_worker_id) BETWEEN 1 AND 1024),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 1024),
  generation INTEGER NOT NULL CHECK (generation > 0),
  descriptor_digest TEXT NOT NULL CHECK (
    substr(descriptor_digest, 1, 7) = 'sha256:' AND length(descriptor_digest) = 71 AND
    substr(descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'deleting', 'deleted')),
  provider_etag TEXT CHECK (
    provider_etag IS NULL OR (
      state IN ('committed', 'deleting') AND length(provider_etag) BETWEEN 1 AND 4096
    )
  ),
  observed_json TEXT NOT NULL DEFAULT '{}' CHECK (
    length(observed_json) BETWEEN 2 AND 1048576 AND
    json_valid(observed_json) AND json_type(observed_json) = 'object'
  ),
  previous_json TEXT CHECK (
    previous_json IS NULL OR (
      length(previous_json) BETWEEN 2 AND 2097152 AND
      json_valid(previous_json) AND json_type(previous_json) = 'object'
    )
  ),
  CHECK (
    state = 'pending' OR
    (state = 'deleting' AND previous_json IS NOT NULL) OR
    (state IN ('committed', 'deleted') AND previous_json IS NULL)
  ),
  PRIMARY KEY (provider_id, resource_uid),
  UNIQUE (provider_id, native_id),
  UNIQUE (provider_id, operation_id)
);

CREATE INDEX cloudflare_managed_worker_receipts_logical
  ON cloudflare_managed_worker_receipts (provider_id, logical_worker_id, kind);


-- Receipt-coupled, provider-private execution material for immutable managed
-- Worker Versions. Artifact/module bytes remain in the existing artifact
-- store; this schema retains only a bounded execution descriptor and sealed
-- values that a selected Version needs after publication.
CREATE TABLE cloudflare_managed_worker_version_execution_material (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  resource_uid TEXT NOT NULL CHECK (length(resource_uid) BETWEEN 1 AND 1024),
  native_id TEXT NOT NULL CHECK (length(native_id) BETWEEN 1 AND 1024),
  provider_installation_id TEXT NOT NULL CHECK (
    length(provider_installation_id) BETWEEN 1 AND 1024
  ),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 1024),
  dispatch_namespace TEXT NOT NULL CHECK (length(dispatch_namespace) BETWEEN 1 AND 1024),
  tenant_ref TEXT NOT NULL CHECK (length(tenant_ref) BETWEEN 1 AND 1024),
  worker_resource_uid TEXT NOT NULL CHECK (length(worker_resource_uid) BETWEEN 1 AND 1024),
  logical_worker_id TEXT NOT NULL CHECK (length(logical_worker_id) BETWEEN 1 AND 1024),
  publication_operation_id TEXT NOT NULL CHECK (
    length(publication_operation_id) BETWEEN 1 AND 1024
  ),
  publication_generation INTEGER NOT NULL CHECK (publication_generation > 0),
  release_protocol TEXT NOT NULL CHECK (length(release_protocol) BETWEEN 1 AND 256),
  descriptor_digest TEXT NOT NULL CHECK (
    substr(descriptor_digest, 1, 7) = 'sha256:' AND length(descriptor_digest) = 71 AND
    substr(descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  execution_descriptor_digest TEXT NOT NULL CHECK (
    substr(execution_descriptor_digest, 1, 7) = 'sha256:' AND
    length(execution_descriptor_digest) = 71 AND
    substr(execution_descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  preparation_kind TEXT NOT NULL CHECK (preparation_kind IN ('none', 'runtime_input')),
  preparation_id TEXT CHECK (
    preparation_id IS NULL OR length(preparation_id) BETWEEN 1 AND 1024
  ),
  preparation_commitment TEXT CHECK (
    preparation_commitment IS NULL OR (
      substr(preparation_commitment, 1, 7) = 'sha256:' AND
      length(preparation_commitment) = 71 AND
      substr(preparation_commitment, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  secret_names_json TEXT NOT NULL CHECK (
    length(CAST(secret_names_json AS BLOB)) BETWEEN 2 AND 65536 AND
    json_valid(secret_names_json) AND json_type(secret_names_json) = 'array' AND
    json_array_length(secret_names_json) BETWEEN 0 AND 64
  ),
  provider_proof_names_json TEXT NOT NULL CHECK (
    length(CAST(provider_proof_names_json AS BLOB)) BETWEEN 2 AND 65536 AND
    json_valid(provider_proof_names_json) AND
    json_type(provider_proof_names_json) = 'array' AND
    json_array_length(provider_proof_names_json) BETWEEN 0 AND 64
  ),
  descriptor_json TEXT NOT NULL CHECK (
    length(CAST(descriptor_json AS BLOB)) BETWEEN 2 AND 1048576 AND
    json_valid(descriptor_json) AND json_type(descriptor_json) = 'object'
  ),
  seal_key_id TEXT NOT NULL CHECK (length(seal_key_id) BETWEEN 1 AND 128),
  CHECK (
    (preparation_kind = 'none' AND preparation_id IS NULL AND
     preparation_commitment IS NULL AND secret_names_json = '[]') OR
    (preparation_kind = 'runtime_input' AND preparation_id IS NOT NULL AND
     preparation_commitment IS NOT NULL AND secret_names_json <> '[]')
  ),
  PRIMARY KEY (provider_id, resource_uid),
  UNIQUE (provider_id, native_id),
  FOREIGN KEY (provider_id, resource_uid)
    REFERENCES cloudflare_managed_worker_receipts(provider_id, resource_uid)
    ON DELETE CASCADE
);

CREATE TABLE cloudflare_managed_worker_version_execution_secrets (
  provider_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 17 AND 32784),
  PRIMARY KEY (provider_id, resource_uid, name),
  FOREIGN KEY (provider_id, resource_uid)
    REFERENCES cloudflare_managed_worker_version_execution_material(provider_id, resource_uid)
    ON DELETE CASCADE
);

CREATE TABLE cloudflare_managed_worker_version_execution_provider_proofs (
  provider_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 17 AND 65552),
  PRIMARY KEY (provider_id, resource_uid, name),
  FOREIGN KEY (provider_id, resource_uid)
    REFERENCES cloudflare_managed_worker_version_execution_material(provider_id, resource_uid)
    ON DELETE CASCADE
);


INSERT INTO cloudflare_managed_worker_receipts SELECT * FROM migration_0058_cloudflare_managed_worker_receipts;
INSERT INTO cloudflare_managed_worker_version_execution_material SELECT * FROM migration_0058_cloudflare_managed_worker_version_execution_material;
INSERT INTO cloudflare_managed_worker_version_execution_secrets SELECT * FROM migration_0058_cloudflare_managed_worker_version_execution_secrets;
INSERT INTO cloudflare_managed_worker_version_execution_provider_proofs SELECT * FROM migration_0058_cloudflare_managed_worker_version_execution_provider_proofs;
DROP TABLE migration_0058_cloudflare_managed_worker_version_execution_provider_proofs;
DROP TABLE migration_0058_cloudflare_managed_worker_version_execution_secrets;
DROP TABLE migration_0058_cloudflare_managed_worker_version_execution_material;
DROP TABLE migration_0058_cloudflare_managed_worker_receipts;

-- Do not let SQLite's INSERT OR REPLACE conflict algorithm turn a second
-- header INSERT into an implicit delete/reinsert. Replacement-delete trigger
-- behavior is connection-sensitive; admission must fail before conflict
-- handling can rotate the descriptor or cascade its ciphertext rows.
CREATE TRIGGER cloudflare_managed_worker_version_execution_material_insert_once
BEFORE INSERT ON cloudflare_managed_worker_version_execution_material
WHEN EXISTS (
  SELECT 1 FROM cloudflare_managed_worker_version_execution_material AS existing
  WHERE (
    existing.provider_id = NEW.provider_id AND
    existing.resource_uid = NEW.resource_uid
  ) OR (
    existing.provider_id = NEW.provider_id AND
    existing.native_id = NEW.native_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_material_already_exists');
END;

-- A material header can be created only while the exact Version publication
-- receipt is pending. Sensitive publications additionally re-prove the
-- existing release-proof/preparation tuple and its unchanged ordered name set.
-- A carrier Version with no tenant secret has no preparation tuple at all;
-- the complete descriptor is still mandatory in the header.
CREATE TRIGGER cloudflare_managed_worker_version_execution_material_exact_insert
BEFORE INSERT ON cloudflare_managed_worker_version_execution_material
WHEN NOT EXISTS (
  SELECT 1
  FROM cloudflare_managed_worker_receipts AS receipt
  WHERE receipt.provider_id = NEW.provider_id
    AND receipt.resource_uid = NEW.resource_uid
    AND receipt.native_id = NEW.native_id
    AND receipt.kind = 'version'
    AND receipt.logical_worker_id = NEW.logical_worker_id
    AND receipt.operation_id = NEW.publication_operation_id
    AND receipt.generation = NEW.publication_generation
    AND receipt.descriptor_digest = NEW.descriptor_digest
    AND receipt.state = 'pending'
    AND receipt.provider_etag IS NULL
    AND json_type(receipt.observed_json, '$.executionMaterial') = 'object'
    AND (
      SELECT count(*) FROM json_each(receipt.observed_json, '$.executionMaterial')
    ) = 2
    AND json_extract(receipt.observed_json, '$.executionMaterial.format') =
      'takoserver.managed-worker-version-execution-material@v1'
    AND json_type(
      receipt.observed_json,
      '$.executionMaterial.publicationGeneration'
    ) = 'integer'
    AND json_extract(
      receipt.observed_json,
      '$.executionMaterial.publicationGeneration'
    ) = NEW.publication_generation
    AND json_extract(receipt.observed_json, '$.releaseProtocol') = NEW.release_protocol
    -- The private writer is scoped by a trusted publisher selection. These
    -- comparisons ensure its bounded descriptor mirrors (rather than selects)
    -- every provider/tenant/Worker identity stored in the header. The receipt
    -- remains lifecycle authority and its release descriptor digest stays a
    -- distinct fence from execution_descriptor_digest.
    AND json_type(NEW.descriptor_json, '$.publication') = 'object'
    AND json_extract(NEW.descriptor_json, '$.publication.providerId') = NEW.provider_id
    AND json_extract(
      NEW.descriptor_json,
      '$.publication.providerInstallationId'
    ) = NEW.provider_installation_id
    AND json_extract(NEW.descriptor_json, '$.publication.accountId') = NEW.account_id
    AND json_extract(
      NEW.descriptor_json,
      '$.publication.dispatchNamespace'
    ) = NEW.dispatch_namespace
    AND json_extract(NEW.descriptor_json, '$.publication.tenantRef') = NEW.tenant_ref
    AND json_extract(
      NEW.descriptor_json,
      '$.publication.workerResourceUid'
    ) = NEW.worker_resource_uid
    AND json_extract(NEW.descriptor_json, '$.publication.resourceUid') = NEW.resource_uid
    AND json_extract(NEW.descriptor_json, '$.publication.nativeId') = NEW.native_id
    AND json_extract(
      NEW.descriptor_json,
      '$.publication.logicalWorkerId'
    ) = NEW.logical_worker_id
    AND json_extract(
      NEW.descriptor_json,
      '$.publication.releaseOperationId'
    ) = NEW.publication_operation_id
    AND json_extract(
      NEW.descriptor_json,
      '$.publication.publicationGeneration'
    ) = NEW.publication_generation
    AND json_extract(
      NEW.descriptor_json,
      '$.publication.releaseProtocol'
    ) = NEW.release_protocol
    AND json_extract(
      NEW.descriptor_json,
      '$.publication.receiptDescriptorDigest'
    ) = NEW.descriptor_digest
    AND (
      (
        NEW.preparation_kind = 'none'
        AND json_type(receipt.observed_json, '$.releaseProof') IS NULL
      ) OR
      (
        NEW.preparation_kind = 'runtime_input'
        AND json_type(receipt.observed_json, '$.releaseProof') = 'object'
        AND json_extract(receipt.observed_json, '$.releaseProof.providerInstallationId') =
          NEW.provider_installation_id
        AND json_extract(receipt.observed_json, '$.releaseProof.accountId') = NEW.account_id
        AND json_extract(receipt.observed_json, '$.releaseProof.dispatchNamespace') =
          NEW.dispatch_namespace
        AND json_extract(receipt.observed_json, '$.releaseProof.tenantRef') = NEW.tenant_ref
        AND json_extract(receipt.observed_json, '$.releaseProof.operationId') =
          NEW.publication_operation_id
        AND json_extract(receipt.observed_json, '$.releaseProof.resourceUid') = NEW.resource_uid
        AND json_extract(receipt.observed_json, '$.releaseProof.preparationId') =
          NEW.preparation_id
        AND json_extract(receipt.observed_json, '$.releaseProof.preparationCommitment') =
          NEW.preparation_commitment
        AND json_extract(receipt.observed_json, '$.releaseProof.logicalWorkerId') =
          NEW.logical_worker_id
        AND json_extract(receipt.observed_json, '$.releaseProof.workerResourceUid') =
          NEW.worker_resource_uid
        AND json_extract(receipt.observed_json, '$.releaseProof.secretNames') =
          NEW.secret_names_json
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_material_receipt_not_exact');
END;

-- Both name lists are canonical sorted sets. The database repeats the bound
-- and uniqueness checks so another private writer cannot smuggle an untracked
-- ciphertext row into a valid header.
CREATE TRIGGER cloudflare_managed_worker_version_execution_material_name_sets
BEFORE INSERT ON cloudflare_managed_worker_version_execution_material
WHEN
  EXISTS (
    SELECT 1 FROM json_each(NEW.secret_names_json)
    WHERE type <> 'text' OR length(value) NOT BETWEEN 1 AND 256
  ) OR
  EXISTS (
    SELECT value FROM json_each(NEW.secret_names_json)
    GROUP BY value HAVING count(*) <> 1
  ) OR
  EXISTS (
    SELECT 1
    FROM json_each(NEW.secret_names_json) AS prior
    JOIN json_each(NEW.secret_names_json) AS later
      ON CAST(later.key AS INTEGER) = CAST(prior.key AS INTEGER) + 1
    WHERE CAST(prior.value AS TEXT) >= CAST(later.value AS TEXT)
  ) OR
  EXISTS (
    SELECT 1 FROM json_each(NEW.provider_proof_names_json)
    WHERE type <> 'text' OR length(value) NOT BETWEEN 1 AND 256
  ) OR
  EXISTS (
    SELECT value FROM json_each(NEW.provider_proof_names_json)
    GROUP BY value HAVING count(*) <> 1
  ) OR
  EXISTS (
    SELECT 1
    FROM json_each(NEW.provider_proof_names_json) AS prior
    JOIN json_each(NEW.provider_proof_names_json) AS later
      ON CAST(later.key AS INTEGER) = CAST(prior.key AS INTEGER) + 1
    WHERE CAST(prior.value AS TEXT) >= CAST(later.value AS TEXT)
  )
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_material_name_set_invalid');
END;

CREATE TRIGGER cloudflare_managed_worker_version_execution_material_immutable_update
BEFORE UPDATE ON cloudflare_managed_worker_version_execution_material
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_material_immutable');
END;

-- The header may disappear only as part of the parent receipt lifecycle. A
-- direct delete while the same publication is still authoritative is refused.
CREATE TRIGGER cloudflare_managed_worker_version_execution_material_receipt_delete_only
BEFORE DELETE ON cloudflare_managed_worker_version_execution_material
WHEN EXISTS (
  SELECT 1
  FROM cloudflare_managed_worker_receipts AS receipt
  WHERE receipt.provider_id = OLD.provider_id
    AND receipt.resource_uid = OLD.resource_uid
    AND (
      (
        receipt.state IN ('pending', 'committed')
        AND receipt.native_id = OLD.native_id
        AND receipt.kind = 'version'
        AND receipt.logical_worker_id = OLD.logical_worker_id
        AND receipt.operation_id = OLD.publication_operation_id
        AND receipt.generation = OLD.publication_generation
        AND receipt.descriptor_digest = OLD.descriptor_digest
      ) OR
      (
        receipt.state = 'deleting'
        AND json_extract(receipt.previous_json, '$.resourceUid') = OLD.resource_uid
        AND json_extract(receipt.previous_json, '$.nativeId') = OLD.native_id
        AND json_extract(receipt.previous_json, '$.kind') = 'version'
        AND json_extract(receipt.previous_json, '$.logicalWorkerId') = OLD.logical_worker_id
        AND json_extract(receipt.previous_json, '$.operationId') =
          OLD.publication_operation_id
        AND json_extract(receipt.previous_json, '$.generation') = OLD.publication_generation
        AND json_extract(receipt.previous_json, '$.descriptorDigest') = OLD.descriptor_digest
        AND json_extract(receipt.previous_json, '$.state') = 'committed'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_material_receipt_required');
END;

CREATE TRIGGER cloudflare_managed_worker_version_execution_secret_exact_insert
BEFORE INSERT ON cloudflare_managed_worker_version_execution_secrets
WHEN NOT EXISTS (
  SELECT 1
  FROM cloudflare_managed_worker_version_execution_material AS material
  JOIN cloudflare_managed_worker_receipts AS receipt
    ON receipt.provider_id = material.provider_id
   AND receipt.resource_uid = material.resource_uid,
       json_each(material.secret_names_json) AS name
  WHERE material.provider_id = NEW.provider_id
    AND material.resource_uid = NEW.resource_uid
    AND receipt.native_id = material.native_id
    AND receipt.kind = 'version'
    AND receipt.logical_worker_id = material.logical_worker_id
    AND receipt.operation_id = material.publication_operation_id
    AND receipt.generation = material.publication_generation
    AND receipt.descriptor_digest = material.descriptor_digest
    AND receipt.state = 'pending'
    AND receipt.provider_etag IS NULL
    AND name.type = 'text'
    AND name.value = NEW.name
    AND NOT EXISTS (
      SELECT 1 FROM cloudflare_managed_worker_version_execution_secrets AS existing
      WHERE existing.provider_id = NEW.provider_id
        AND existing.resource_uid = NEW.resource_uid
        AND existing.name = NEW.name
    )
)
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_secret_not_admissible');
END;

CREATE TRIGGER cloudflare_managed_worker_version_execution_proof_exact_insert
BEFORE INSERT ON cloudflare_managed_worker_version_execution_provider_proofs
WHEN NOT EXISTS (
  SELECT 1
  FROM cloudflare_managed_worker_version_execution_material AS material
  JOIN cloudflare_managed_worker_receipts AS receipt
    ON receipt.provider_id = material.provider_id
   AND receipt.resource_uid = material.resource_uid,
       json_each(material.provider_proof_names_json) AS name
  WHERE material.provider_id = NEW.provider_id
    AND material.resource_uid = NEW.resource_uid
    AND receipt.native_id = material.native_id
    AND receipt.kind = 'version'
    AND receipt.logical_worker_id = material.logical_worker_id
    AND receipt.operation_id = material.publication_operation_id
    AND receipt.generation = material.publication_generation
    AND receipt.descriptor_digest = material.descriptor_digest
    AND receipt.state = 'pending'
    AND receipt.provider_etag IS NULL
    AND name.type = 'text'
    AND name.value = NEW.name
    AND NOT EXISTS (
      SELECT 1
      FROM cloudflare_managed_worker_version_execution_provider_proofs AS existing
      WHERE existing.provider_id = NEW.provider_id
        AND existing.resource_uid = NEW.resource_uid
        AND existing.name = NEW.name
    )
)
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_proof_not_admissible');
END;

-- The receipt commit is the publication boundary. A marked receipt cannot
-- cross it unless its one immutable header is exact and every declared sealed
-- slot exists. Both OLD and NEW are checked so a writer cannot remove the
-- marker in the committing UPDATE. Historical unmarked receipts take no path
-- through this trigger and retain their existing lifecycle.
CREATE TRIGGER cloudflare_managed_worker_version_execution_receipt_commit_complete
BEFORE UPDATE OF state ON cloudflare_managed_worker_receipts
WHEN OLD.state = 'pending' AND NEW.state = 'committed'
  AND NOT COALESCE((
    json_type(OLD.previous_json) = 'object'
    AND json_extract(OLD.previous_json, '$.resourceUid') = NEW.resource_uid
    AND json_extract(OLD.previous_json, '$.nativeId') = NEW.native_id
    AND json_extract(OLD.previous_json, '$.kind') = NEW.kind
    AND json_extract(OLD.previous_json, '$.logicalWorkerId') = NEW.logical_worker_id
    AND json_extract(OLD.previous_json, '$.operationId') = NEW.operation_id
    AND json_extract(OLD.previous_json, '$.generation') = NEW.generation
    AND json_extract(OLD.previous_json, '$.descriptorDigest') = NEW.descriptor_digest
    AND json_extract(OLD.previous_json, '$.state') = NEW.state
    AND (
      (
        json_type(OLD.previous_json, '$.providerEtag') IS NULL
        AND NEW.provider_etag IS NULL
      ) OR
      json_extract(OLD.previous_json, '$.providerEtag') = NEW.provider_etag
    )
    AND json_extract(OLD.previous_json, '$.observed') = NEW.observed_json
  ), 0)
  AND (
    json_type(OLD.observed_json, '$.executionMaterial') IS NOT NULL OR
    json_type(NEW.observed_json, '$.executionMaterial') IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cloudflare_managed_worker_version_execution_material AS material
    WHERE material.provider_id = NEW.provider_id
      AND material.resource_uid = NEW.resource_uid
      AND material.native_id = NEW.native_id
      AND NEW.kind = 'version'
      AND material.logical_worker_id = NEW.logical_worker_id
      AND material.publication_operation_id = NEW.operation_id
      AND material.publication_generation = NEW.generation
      AND material.descriptor_digest = NEW.descriptor_digest
      AND json_type(OLD.observed_json, '$.executionMaterial') = 'object'
      AND json_type(NEW.observed_json, '$.executionMaterial') = 'object'
      AND (
        SELECT count(*) FROM json_each(OLD.observed_json, '$.executionMaterial')
      ) = 2
      AND (
        SELECT count(*) FROM json_each(NEW.observed_json, '$.executionMaterial')
      ) = 2
      AND json_extract(OLD.observed_json, '$.executionMaterial.format') =
        'takoserver.managed-worker-version-execution-material@v1'
      AND json_extract(NEW.observed_json, '$.executionMaterial.format') =
        'takoserver.managed-worker-version-execution-material@v1'
      AND json_extract(
        OLD.observed_json,
        '$.executionMaterial.publicationGeneration'
      ) = material.publication_generation
      AND json_extract(
        NEW.observed_json,
        '$.executionMaterial.publicationGeneration'
      ) = material.publication_generation
      AND json_extract(OLD.observed_json, '$.releaseProtocol') = material.release_protocol
      AND json_extract(NEW.observed_json, '$.releaseProtocol') = material.release_protocol
      AND (
        (
          material.preparation_kind = 'none'
          AND json_type(OLD.observed_json, '$.releaseProof') IS NULL
          AND json_type(NEW.observed_json, '$.releaseProof') IS NULL
        ) OR
        (
          material.preparation_kind = 'runtime_input'
          AND json_extract(OLD.observed_json, '$.releaseProof.providerInstallationId') =
            material.provider_installation_id
          AND json_extract(NEW.observed_json, '$.releaseProof.providerInstallationId') =
            material.provider_installation_id
          AND json_extract(OLD.observed_json, '$.releaseProof.accountId') = material.account_id
          AND json_extract(NEW.observed_json, '$.releaseProof.accountId') = material.account_id
          AND json_extract(OLD.observed_json, '$.releaseProof.dispatchNamespace') =
            material.dispatch_namespace
          AND json_extract(NEW.observed_json, '$.releaseProof.dispatchNamespace') =
            material.dispatch_namespace
          AND json_extract(OLD.observed_json, '$.releaseProof.tenantRef') = material.tenant_ref
          AND json_extract(NEW.observed_json, '$.releaseProof.tenantRef') = material.tenant_ref
          AND json_extract(OLD.observed_json, '$.releaseProof.operationId') =
            material.publication_operation_id
          AND json_extract(NEW.observed_json, '$.releaseProof.operationId') =
            material.publication_operation_id
          AND json_extract(OLD.observed_json, '$.releaseProof.resourceUid') =
            material.resource_uid
          AND json_extract(NEW.observed_json, '$.releaseProof.resourceUid') =
            material.resource_uid
          AND json_extract(OLD.observed_json, '$.releaseProof.preparationId') =
            material.preparation_id
          AND json_extract(NEW.observed_json, '$.releaseProof.preparationId') =
            material.preparation_id
          AND json_extract(OLD.observed_json, '$.releaseProof.preparationCommitment') =
            material.preparation_commitment
          AND json_extract(NEW.observed_json, '$.releaseProof.preparationCommitment') =
            material.preparation_commitment
          AND json_extract(OLD.observed_json, '$.releaseProof.logicalWorkerId') =
            material.logical_worker_id
          AND json_extract(NEW.observed_json, '$.releaseProof.logicalWorkerId') =
            material.logical_worker_id
          AND json_extract(OLD.observed_json, '$.releaseProof.workerResourceUid') =
            material.worker_resource_uid
          AND json_extract(NEW.observed_json, '$.releaseProof.workerResourceUid') =
            material.worker_resource_uid
          AND json_extract(OLD.observed_json, '$.releaseProof.secretNames') =
            material.secret_names_json
          AND json_extract(NEW.observed_json, '$.releaseProof.secretNames') =
            material.secret_names_json
        )
      )
      AND (
        SELECT count(*)
        FROM cloudflare_managed_worker_version_execution_secrets AS secret
        WHERE secret.provider_id = material.provider_id
          AND secret.resource_uid = material.resource_uid
      ) = json_array_length(material.secret_names_json)
      AND (
        SELECT count(*)
        FROM cloudflare_managed_worker_version_execution_provider_proofs AS proof
        WHERE proof.provider_id = material.provider_id
          AND proof.resource_uid = material.resource_uid
      ) = json_array_length(material.provider_proof_names_json)
  )
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_material_incomplete');
END;

CREATE TRIGGER cloudflare_managed_worker_version_execution_secret_immutable_update
BEFORE UPDATE ON cloudflare_managed_worker_version_execution_secrets
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_secret_immutable');
END;

CREATE TRIGGER cloudflare_managed_worker_version_execution_proof_immutable_update
BEFORE UPDATE ON cloudflare_managed_worker_version_execution_provider_proofs
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_proof_immutable');
END;

CREATE TRIGGER cloudflare_managed_worker_version_execution_secret_parent_delete_only
BEFORE DELETE ON cloudflare_managed_worker_version_execution_secrets
WHEN EXISTS (
  SELECT 1 FROM cloudflare_managed_worker_version_execution_material
  WHERE provider_id = OLD.provider_id AND resource_uid = OLD.resource_uid
)
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_secret_durable');
END;

CREATE TRIGGER cloudflare_managed_worker_version_execution_proof_parent_delete_only
BEFORE DELETE ON cloudflare_managed_worker_version_execution_provider_proofs
WHEN EXISTS (
  SELECT 1 FROM cloudflare_managed_worker_version_execution_material
  WHERE provider_id = OLD.provider_id AND resource_uid = OLD.resource_uid
)
BEGIN
  SELECT RAISE(ABORT, 'managed_worker_version_execution_proof_durable');
END;

-- Initial abort deletes the pending receipt and follows the FK cascade. An
-- aborted replacement restores its predecessor with UPDATE, so remove any
-- now-mismatched pending material in that same receipt statement. Beginning a
-- delete deliberately retains the publication material until native absence.
CREATE TRIGGER cloudflare_managed_worker_version_execution_receipt_replacement_cleanup
AFTER UPDATE ON cloudflare_managed_worker_receipts
WHEN NEW.state IN ('pending', 'committed', 'deleted')
BEGIN
  DELETE FROM cloudflare_managed_worker_version_execution_material
  WHERE provider_id = NEW.provider_id
    AND resource_uid = NEW.resource_uid
    AND (
      NEW.state = 'deleted' OR
      NEW.kind <> 'version' OR
      native_id <> NEW.native_id OR
      logical_worker_id <> NEW.logical_worker_id OR
      publication_operation_id <> NEW.operation_id OR
      publication_generation <> NEW.generation OR
      descriptor_digest <> NEW.descriptor_digest
    );
END;

