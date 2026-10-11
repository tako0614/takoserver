-- Rows of a v1.0.0 control database after operator sign-in, one Organization
-- and one API key, through the v1.0.0 HTTP API. No funding and no Resource.
-- The token rows hold only digests of throwaway secrets from a deleted
-- scratch installation. See schema.sql for provenance.
INSERT INTO applied_migrations VALUES('0001_runtime_storage.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0002_takoform_state.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0003_control_plane.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0004_commerce.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0005_resource_deployments.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0006_resource_attachments.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0007_logical_resources_drop_native_identity.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0008_remove_native_identity_migration_guard.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0009_resource_migrations.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0010_attachment_target_uniqueness.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0011_resource_migration_attachment_rebindings.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0012_resource_migration_commercial_authority.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0013_provision_token_release_fence.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0014_provider_meter_checkpoints.sql','2026-10-11 02:14:20');
INSERT INTO applied_migrations VALUES('0015_takoform_resource_relations.sql','2026-10-11 02:14:20');
INSERT INTO runtime_grant_keys VALUES('takoserver-local','{"kty":"OKP","crv":"Ed25519","x":"adwFlZ8gk7Ya4M4oi9AGf0Gx_WUEfrlmiGdvcDiRSU4"}',1791684861,NULL);
INSERT INTO principals VALUES('prn_1521e96f12df4a60b43f0b7af78c737c','google','operator','operator@localhost','Operator','2026-10-11T02:14:21.019Z');
INSERT INTO orgs VALUES('org_2195ae768f5944f386e4d622f5a4ec3d','Upgrade fixture','prn_1521e96f12df4a60b43f0b7af78c737c','2026-10-11T02:14:21.020Z');
INSERT INTO auth_tokens VALUES('sha256:559125b096a1c3491d9bdb37ab407aa10596c0f108639180805ce481388e3a41','ses_efc94bb535304342b2abc94547578f80','session','prn_1521e96f12df4a60b43f0b7af78c737c',NULL,'session','[]','2026-10-11T02:14:21.019Z','2026-10-11T14:14:21.019Z',NULL);
INSERT INTO auth_tokens VALUES('sha256:e365720e5e639354086db10cfcb502bf2fbd5d3d73f75d5fb57091c532594894','key_ed5c892ee80147ff8f2ea8af38c2fe1f','api_key','prn_1521e96f12df4a60b43f0b7af78c737c','org_2195ae768f5944f386e4d622f5a4ec3d','takoform','["resources:write"]','2026-10-11T02:14:21.021Z','2026-10-11T03:14:21.021Z',NULL);
