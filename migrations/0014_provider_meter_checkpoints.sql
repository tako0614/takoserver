-- Provider usage is read in bounded windows. The checkpoint advances only
-- after every priced measurement row for that exact window is durable.
CREATE TABLE provider_meter_checkpoints (
  tenant_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  meter_source_id TEXT NOT NULL,
  cursor_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, deployment_id, meter_source_id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(deployment_id) BETWEEN 3 AND 128),
  CHECK (length(meter_source_id) BETWEEN 1 AND 255),
  CHECK (cursor_at >= 0),
  CHECK (updated_at >= 0)
);

-- The schedule is separate from the source checkpoints so a newly added
-- source cannot starve behind the first page of active Deployments. lease_until
-- is a bounded distributed claim; no external call occurs while holding SQL.
CREATE TABLE provider_meter_schedule (
  tenant_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  next_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  lease_token TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, deployment_id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(deployment_id) BETWEEN 3 AND 128),
  CHECK (next_at >= 0),
  CHECK (lease_until >= 0),
  CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 8 AND 128),
  CHECK (updated_at >= 0)
);

CREATE INDEX provider_meter_schedule_due
  ON provider_meter_schedule (next_at, lease_until, tenant_id, deployment_id);
