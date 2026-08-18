-- One consumer target resolves to one live provider Resource. Callers must
-- remove the old Attachment before pointing the target somewhere else.
CREATE UNIQUE INDEX tf_resource_attachments_live_consumer_target
  ON tf_resource_attachments (tenant_id, consumer_resource_uid, target)
  WHERE state <> 'deleted';
