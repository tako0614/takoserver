-- Rows of a v1.0.0 control database that was booted once and stopped: the
-- recorded v1.0.0 migrations and the Host's runtime grant public key. No
-- sign-in, Organization, funding or Resource. See schema.sql for provenance.
INSERT INTO applied_migrations VALUES('0001_runtime_storage.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0002_takoform_state.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0003_control_plane.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0004_commerce.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0005_resource_deployments.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0006_resource_attachments.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0007_logical_resources_drop_native_identity.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0008_remove_native_identity_migration_guard.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0009_resource_migrations.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0010_attachment_target_uniqueness.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0011_resource_migration_attachment_rebindings.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0012_resource_migration_commercial_authority.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0013_provision_token_release_fence.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0014_provider_meter_checkpoints.sql','2026-10-11 02:10:55');
INSERT INTO applied_migrations VALUES('0015_takoform_resource_relations.sql','2026-10-11 02:10:55');
INSERT INTO runtime_grant_keys VALUES('takoserver-local','{"kty":"OKP","crv":"Ed25519","x":"ZGDGTYYYzD7hSEb0mzF9DztLQXvsC45OJcJkfkVPB44"}',1791684655,NULL);
