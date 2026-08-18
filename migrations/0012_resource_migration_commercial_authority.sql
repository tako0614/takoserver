-- A migration's target Deployment consumes one exact commercial reservation.
-- The downstream tenant reference is needed to re-read that authority without
-- weakening the reseller tenant boundary.
ALTER TABLE tf_resource_migrations
  ADD COLUMN commercial_tenant_ref TEXT
  CHECK (
    commercial_tenant_ref IS NULL OR
    length(commercial_tenant_ref) BETWEEN 3 AND 128
  );

CREATE UNIQUE INDEX tf_resource_migrations_commercial_authority
  ON tf_resource_migrations (tenant_id, commercial_authorization_ref);
