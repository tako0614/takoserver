-- 0007 kept its proof table through the final statement so a failed proof
-- rolled the whole migration back under both D1 and local SQLite execution.
DROP TABLE tf_resource_native_identity_migration_guard;
