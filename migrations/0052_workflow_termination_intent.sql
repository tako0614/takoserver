-- Durable cancellation intent for one workflow execution incarnation.
--
-- The bit is written before a controller asks the host to stop.  It fences
-- claims, step writes and normal terminal publication without pretending that
-- a SQL status change stopped application code.  A later coordinator recovery
-- performs the exact stop/reap proof and only then clears this bit while
-- terminalizing the same execution fence.

ALTER TABLE tf_workflow_instances
  ADD COLUMN termination_requested INTEGER NOT NULL DEFAULT 0
  CHECK (termination_requested IN (0, 1));
