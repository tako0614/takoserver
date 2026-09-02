-- Where a self-hosted machine keeps what an edge.objects bucket promises.
--
-- Cloudflare sells R2, so the ordinary-workers backend only has to name a
-- bucket. A machine standing on its own has to be the bucket, and until now
-- the current `ObjectBucket` Form was refused at apply here: recording a
-- namespace for storage that does not exist would be a lie a later Worker
-- Version binds to.
--
-- The bytes are files under `<data root>/selfhost/objects/<bucket>/`, because
-- an object is up to 5 GiB and a row is not where 5 GiB belongs. What lives
-- here is everything a lookup needs before it opens one: which key exists,
-- how big it is, what its etag is, and which file under that bucket holds it.
--
-- Buckets are keyed by the id the provider derives from the Resource
-- INCARNATION — tenant, Space, name, and Resource UID — never by a
-- customer-chosen string, for the reason the KV namespace already follows: a
-- customer who destroys a bucket and declares one with the same name has asked
-- for an empty bucket, and recomputing the address alone would hand them the
-- old bytes whenever a destroy did not finish.
CREATE TABLE selfhost_objects (
  bucket_id TEXT NOT NULL CHECK (length(bucket_id) BETWEEN 1 AND 128),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 979),
  -- The file under the bucket directory that holds this exact object body. A
  -- put mints a new one and drops the superseded file after the row that named
  -- it is gone, so a reader that already resolved a row never has its bytes
  -- replaced underneath it.
  storage_id TEXT NOT NULL CHECK (length(storage_id) = 32 AND storage_id NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size BETWEEN 0 AND 5368709120),
  etag TEXT NOT NULL CHECK (length(etag) BETWEEN 1 AND 256),
  content_type TEXT CHECK (content_type IS NULL OR length(content_type) BETWEEN 1 AND 256),
  uploaded_at_ms INTEGER NOT NULL CHECK (uploaded_at_ms > 0),
  PRIMARY KEY (bucket_id, key)
);

-- A list walks one bucket in key order and a cursor resumes after a key, which
-- is exactly the primary key's order, so no second index is needed for it. The
-- delete path asks the other question: which files does this bucket still own.
CREATE INDEX selfhost_objects_storage ON selfhost_objects (bucket_id, storage_id);

-- An unfinished multipart upload is durable state, not isolate memory. That is
-- the whole reason a self-host may serve `bucketBindings` where the managed
-- Cloudflare wrapper may not (ADR 0007): a restart between
-- `createMultipartUpload` and `completeMultipartUpload` loses nothing here, so
-- the part receipts a complete is validated against survive it.
CREATE TABLE selfhost_object_uploads (
  bucket_id TEXT NOT NULL CHECK (length(bucket_id) BETWEEN 1 AND 128),
  upload_id TEXT NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 128),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 979),
  content_type TEXT CHECK (content_type IS NULL OR length(content_type) BETWEEN 1 AND 256),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  PRIMARY KEY (bucket_id, upload_id)
);

CREATE TABLE selfhost_object_upload_parts (
  bucket_id TEXT NOT NULL CHECK (length(bucket_id) BETWEEN 1 AND 128),
  upload_id TEXT NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 128),
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size INTEGER NOT NULL CHECK (size BETWEEN 0 AND 5368709120),
  etag TEXT NOT NULL CHECK (length(etag) BETWEEN 1 AND 256),
  PRIMARY KEY (bucket_id, upload_id, part_number),
  FOREIGN KEY (bucket_id, upload_id)
    REFERENCES selfhost_object_uploads (bucket_id, upload_id) ON DELETE CASCADE
);
