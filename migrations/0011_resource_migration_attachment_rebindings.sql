-- A completed Migration keeps the exact Attachment CAS projection needed to
-- roll back within its reviewed window. It contains only opaque references.
ALTER TABLE tf_resource_migrations
  ADD COLUMN attachment_rebindings_json TEXT
  CHECK (
    attachment_rebindings_json IS NULL OR
    length(attachment_rebindings_json) BETWEEN 2 AND 262144
  );
