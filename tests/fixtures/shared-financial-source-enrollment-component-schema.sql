-- PRIVATE UNNUMBERED C0/M component proposal; not public schema or source authority.
CREATE TABLE financial_preproof_challenges (
 challenge_ref TEXT PRIMARY KEY NOT NULL,
 preparation_ref TEXT NOT NULL UNIQUE,
 challenge_json TEXT NOT NULL CHECK(json_valid(challenge_json)),
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 created_at TEXT NOT NULL,
 CHECK(length(CAST(record_json AS BLOB)) BETWEEN 2 AND 32768),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)
);
CREATE TABLE financial_preproof_challenge_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL,
 challenge_ref TEXT NOT NULL UNIQUE,
 preparation_ref TEXT NOT NULL UNIQUE,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 FOREIGN KEY(challenge_ref) REFERENCES financial_preproof_challenges(challenge_ref) ON DELETE RESTRICT
);
CREATE TABLE financial_source_materializations (
 materialization_ref TEXT PRIMARY KEY NOT NULL,
 command_ref TEXT NOT NULL UNIQUE,
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 genesis_qualification_ref TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(registration_ref,incarnation,affected_ref),
 CHECK(length(CAST(record_json AS BLOB)) BETWEEN 2 AND 32768),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)
);
CREATE TABLE financial_source_materialization_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL,
 materialization_ref TEXT NOT NULL UNIQUE,
 command_ref TEXT NOT NULL UNIQUE,
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 FOREIGN KEY(materialization_ref) REFERENCES financial_source_materializations(materialization_ref) ON DELETE RESTRICT,
 FOREIGN KEY(registration_ref,incarnation,affected_ref) REFERENCES financial_source_heads(registration_ref,incarnation,affected_ref) ON DELETE RESTRICT
);
CREATE TRIGGER financial_preproof_challenges_no_replace BEFORE INSERT ON financial_preproof_challenges
WHEN EXISTS(SELECT 1 FROM financial_preproof_challenges WHERE challenge_ref IS NEW.challenge_ref OR preparation_ref IS NEW.preparation_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment replacement');
END;
CREATE TRIGGER financial_preproof_challenges_no_update BEFORE UPDATE ON financial_preproof_challenges BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment original');
END;
CREATE TRIGGER financial_preproof_challenges_no_delete BEFORE DELETE ON financial_preproof_challenges BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment original');
END;
CREATE TRIGGER financial_preproof_challenge_receipts_no_replace BEFORE INSERT ON financial_preproof_challenge_receipts
WHEN EXISTS(SELECT 1 FROM financial_preproof_challenge_receipts WHERE receipt_ref IS NEW.receipt_ref OR challenge_ref IS NEW.challenge_ref OR preparation_ref IS NEW.preparation_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment replacement');
END;
CREATE TRIGGER financial_preproof_challenge_receipts_no_update BEFORE UPDATE ON financial_preproof_challenge_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment original');
END;
CREATE TRIGGER financial_preproof_challenge_receipts_no_delete BEFORE DELETE ON financial_preproof_challenge_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment original');
END;
CREATE TRIGGER financial_source_materializations_no_replace BEFORE INSERT ON financial_source_materializations
WHEN EXISTS(SELECT 1 FROM financial_source_materializations WHERE materialization_ref IS NEW.materialization_ref OR command_ref IS NEW.command_ref OR (registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation AND affected_ref IS NEW.affected_ref)) BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment replacement');
END;
CREATE TRIGGER financial_source_materializations_no_update BEFORE UPDATE ON financial_source_materializations BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment original');
END;
CREATE TRIGGER financial_source_materializations_no_delete BEFORE DELETE ON financial_source_materializations BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment original');
END;
CREATE TRIGGER financial_source_materialization_receipts_no_replace BEFORE INSERT ON financial_source_materialization_receipts
WHEN EXISTS(SELECT 1 FROM financial_source_materialization_receipts WHERE receipt_ref IS NEW.receipt_ref OR materialization_ref IS NEW.materialization_ref OR command_ref IS NEW.command_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment replacement');
END;
CREATE TRIGGER financial_source_materialization_receipts_no_update BEFORE UPDATE ON financial_source_materialization_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment original');
END;
CREATE TRIGGER financial_source_materialization_receipts_no_delete BEFORE DELETE ON financial_source_materialization_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: immutable enrollment original');
END;
CREATE TRIGGER financial_preproof_challenges_shape BEFORE INSERT ON financial_preproof_challenges
WHEN ((json_type(NEW.record_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.record_json))=5
 AND json_extract(NEW.record_json,'$.preparationRef') IS NEW.preparation_ref
 AND json_type(NEW.record_json,'$.receiptRef') IS 'text'
 AND json_extract(NEW.record_json,'$.challenge') IS NEW.challenge_json
 AND json_extract(NEW.record_json,'$.scope') IS NEW.scope_json)
 AND (json_type(NEW.challenge_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.challenge_json))=10
 AND json_extract(NEW.challenge_json,'$.challengeRef') IS NEW.challenge_ref
 AND json_extract(NEW.challenge_json,'$.v') IS 1
 AND json_type(NEW.record_json,'$.selection') IS 'object')) IS NOT 1 BEGIN
 SELECT RAISE(ABORT,'constraint: closed C0 original');
END;
CREATE TRIGGER financial_preproof_challenge_receipts_match BEFORE INSERT ON financial_preproof_challenge_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_preproof_challenges c
 WHERE c.challenge_ref IS NEW.challenge_ref AND c.preparation_ref IS NEW.preparation_ref
 AND c.record_json IS NEW.record_json
 AND json_extract(c.record_json,'$.receiptRef') IS NEW.receipt_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: C0 receipt original');
END;
CREATE TRIGGER financial_source_materializations_shape BEFORE INSERT ON financial_source_materializations
WHEN ((json_type(NEW.record_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.record_json))=7
 AND json_extract(NEW.record_json,'$.materializationRef') IS NEW.materialization_ref
 AND json_extract(NEW.record_json,'$.commandRef') IS NEW.command_ref
 AND json_type(NEW.record_json,'$.receiptRef') IS 'text')
 AND (json_extract(NEW.record_json,'$.source') IS NEW.source_json
 AND json_extract(NEW.record_json,'$.affectedRef') IS NEW.affected_ref
 AND json_extract(NEW.record_json,'$.genesisQualificationRef') IS NEW.genesis_qualification_ref
 AND json_extract(NEW.source_json,'$.registration.registrationRef') IS NEW.registration_ref
 AND json_extract(NEW.source_json,'$.registration.incarnation') IS NEW.incarnation)) IS NOT 1 BEGIN
 SELECT RAISE(ABORT,'constraint: closed M original');
END;
CREATE TRIGGER financial_source_materialization_receipts_match BEFORE INSERT ON financial_source_materialization_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_source_materializations m
 JOIN financial_source_registrations r ON r.registration_ref=m.registration_ref AND r.incarnation=m.incarnation
 JOIN financial_source_heads h ON h.registration_ref=m.registration_ref AND h.incarnation=m.incarnation AND h.affected_ref=m.affected_ref
 WHERE ((m.materialization_ref IS NEW.materialization_ref AND m.command_ref IS NEW.command_ref
 AND m.registration_ref IS NEW.registration_ref AND m.incarnation IS NEW.incarnation
 AND m.affected_ref IS NEW.affected_ref AND m.record_json IS NEW.record_json)
 AND (json_extract(m.record_json,'$.receiptRef') IS NEW.receipt_ref
 AND r.registration_json IS json_extract(m.source_json,'$.registration')
 AND r.registration_digest IS json_extract(m.source_json,'$.registrationDigest')
 AND r.qualification_ref IS json_extract(m.source_json,'$.qualificationRef') AND r.retired_at IS NULL)
 AND (h.sequence=0 AND h.event_digest IS r.genesis_digest AND h.last_event_ref IS NULL
 AND h.state IS 'active' AND h.genesis_qualification_ref IS m.genesis_qualification_ref
 AND h.created_at IS m.created_at))) BEGIN
 SELECT RAISE(ABORT,'constraint: M receipt original genesis');
END;
CREATE TRIGGER financial_preproof_challenges_refs BEFORE INSERT ON financial_preproof_challenges
WHEN (typeof(NEW.challenge_ref) IS NOT 'text' OR length(NEW.challenge_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.challenge_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.challenge_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.preparation_ref) IS NOT 'text' OR length(NEW.preparation_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.preparation_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.preparation_ref GLOB '*[^A-Za-z0-9._:/-]*') BEGIN
 SELECT RAISE(ABORT,'constraint: enrollment reference');
END;
CREATE TRIGGER financial_preproof_challenge_receipts_refs BEFORE INSERT ON financial_preproof_challenge_receipts
WHEN (typeof(NEW.receipt_ref) IS NOT 'text' OR length(NEW.receipt_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.receipt_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.receipt_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.challenge_ref) IS NOT 'text' OR length(NEW.challenge_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.challenge_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.challenge_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.preparation_ref) IS NOT 'text' OR length(NEW.preparation_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.preparation_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.preparation_ref GLOB '*[^A-Za-z0-9._:/-]*') BEGIN
 SELECT RAISE(ABORT,'constraint: enrollment reference');
END;
CREATE TRIGGER financial_source_materializations_refs BEFORE INSERT ON financial_source_materializations
WHEN (typeof(NEW.materialization_ref) IS NOT 'text' OR length(NEW.materialization_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.materialization_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.materialization_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.command_ref) IS NOT 'text' OR length(NEW.command_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.command_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.command_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.registration_ref) IS NOT 'text' OR length(NEW.registration_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.registration_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.registration_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.incarnation) IS NOT 'text' OR length(NEW.incarnation) NOT BETWEEN 1 AND 256 OR substr(NEW.incarnation,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.incarnation GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.affected_ref) IS NOT 'text' OR length(NEW.affected_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.affected_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.affected_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.genesis_qualification_ref) IS NOT 'text' OR length(NEW.genesis_qualification_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.genesis_qualification_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.genesis_qualification_ref GLOB '*[^A-Za-z0-9._:/-]*') BEGIN
 SELECT RAISE(ABORT,'constraint: enrollment reference');
END;
CREATE TRIGGER financial_source_materialization_receipts_refs BEFORE INSERT ON financial_source_materialization_receipts
WHEN (typeof(NEW.receipt_ref) IS NOT 'text' OR length(NEW.receipt_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.receipt_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.receipt_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.materialization_ref) IS NOT 'text' OR length(NEW.materialization_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.materialization_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.materialization_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.command_ref) IS NOT 'text' OR length(NEW.command_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.command_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.command_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.registration_ref) IS NOT 'text' OR length(NEW.registration_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.registration_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.registration_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.incarnation) IS NOT 'text' OR length(NEW.incarnation) NOT BETWEEN 1 AND 256 OR substr(NEW.incarnation,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.incarnation GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.affected_ref) IS NOT 'text' OR length(NEW.affected_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.affected_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.affected_ref GLOB '*[^A-Za-z0-9._:/-]*') BEGIN
 SELECT RAISE(ABORT,'constraint: enrollment reference');
END;
