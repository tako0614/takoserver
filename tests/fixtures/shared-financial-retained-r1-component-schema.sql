-- Unnumbered Financial 0104-owned candidate. This table is data custody, not a source issuer.
CREATE TABLE financial_action_source_registrations (
 registration_ref TEXT NOT NULL,
 incarnation TEXT NOT NULL,
 registration_digest TEXT NOT NULL,
 digest_recipe TEXT NOT NULL CHECK(digest_recipe='financial-action-registration-canonical-v1'),
 registration_json TEXT NOT NULL CHECK(json_valid(registration_json)),
 created_at TEXT NOT NULL,
 PRIMARY KEY(registration_ref,incarnation),
 CHECK(length(CAST(registration_json AS BLOB)) BETWEEN 2 AND 16384)
);
CREATE TABLE financial_retained_r1_originals (
 r1_ref TEXT PRIMARY KEY NOT NULL,
 challenge_ref TEXT NOT NULL UNIQUE,
 preparation_ref TEXT NOT NULL UNIQUE,
 receipt_ref TEXT NOT NULL UNIQUE,
 command_json TEXT NOT NULL CHECK(json_valid(command_json)),
 original_json TEXT NOT NULL CHECK(json_valid(original_json)),
 original_digest TEXT NOT NULL,
 terms_ref TEXT NOT NULL,
 terms_digest TEXT NOT NULL,
 source_registration_ref TEXT NOT NULL,
 source_registration_digest TEXT NOT NULL,
 source_incarnation TEXT NOT NULL,
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
 CHECK(length(CAST(command_json AS BLOB)) BETWEEN 2 AND 98304),
 FOREIGN KEY(source_registration_ref,source_incarnation)
   REFERENCES financial_action_source_registrations(registration_ref,incarnation) ON DELETE RESTRICT
);
CREATE TABLE financial_retained_r1_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL,
 r1_ref TEXT NOT NULL UNIQUE,
 challenge_ref TEXT NOT NULL UNIQUE,
 preparation_ref TEXT NOT NULL UNIQUE,
 command_json TEXT NOT NULL CHECK(json_valid(command_json)),
 original_digest TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 FOREIGN KEY(r1_ref) REFERENCES financial_retained_r1_originals(r1_ref) ON DELETE RESTRICT
);
CREATE TRIGGER financial_action_source_registrations_no_replace BEFORE INSERT ON financial_action_source_registrations
WHEN EXISTS(SELECT 1 FROM financial_action_source_registrations WHERE registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation) BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 registration replacement');
END;
CREATE TRIGGER financial_action_source_registrations_no_update BEFORE UPDATE ON financial_action_source_registrations BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 registration');
END;
CREATE TRIGGER financial_action_source_registrations_no_delete BEFORE DELETE ON financial_action_source_registrations BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 registration');
END;
CREATE TRIGGER financial_retained_r1_originals_no_replace BEFORE INSERT ON financial_retained_r1_originals
WHEN EXISTS(SELECT 1 FROM financial_retained_r1_originals WHERE
 r1_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)
 OR challenge_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)
 OR preparation_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)
 OR receipt_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)) BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 original replacement');
END;
CREATE TRIGGER financial_retained_r1_originals_no_update BEFORE UPDATE ON financial_retained_r1_originals BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 original');
END;
CREATE TRIGGER financial_retained_r1_originals_no_delete BEFORE DELETE ON financial_retained_r1_originals BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 original');
END;
CREATE TRIGGER financial_retained_r1_receipts_no_replace BEFORE INSERT ON financial_retained_r1_receipts
WHEN EXISTS(SELECT 1 FROM financial_retained_r1_receipts WHERE
 r1_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)
 OR challenge_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)
 OR preparation_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)
 OR receipt_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)) BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 receipt replacement');
END;
CREATE TRIGGER financial_retained_r1_receipts_no_update BEFORE UPDATE ON financial_retained_r1_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 receipt');
END;
CREATE TRIGGER financial_retained_r1_receipts_no_delete BEFORE DELETE ON financial_retained_r1_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: immutable R1 receipt');
END;
CREATE TRIGGER financial_retained_r1_originals_shape BEFORE INSERT ON financial_retained_r1_originals
WHEN NOT (json_type(NEW.command_json) IS 'object'
 AND json_extract(NEW.command_json,'$.key.r1Ref') IS NEW.r1_ref
 AND json_extract(NEW.command_json,'$.key.challengeRef') IS NEW.challenge_ref
 AND json_extract(NEW.command_json,'$.key.preparationRef') IS NEW.preparation_ref
 AND json_extract(NEW.command_json,'$.r1ReceiptRef') IS NEW.receipt_ref
 AND json_extract(NEW.command_json,'$.original') IS NEW.original_json
 AND json_extract(NEW.original_json,'$.r1Ref') IS NEW.r1_ref
 AND json_extract(NEW.original_json,'$.challengeRef') IS NEW.challenge_ref
 AND json_extract(NEW.original_json,'$.preparationRef') IS NEW.preparation_ref
 AND json_extract(NEW.original_json,'$.c0ReceiptRef') IS json_extract(NEW.original_json,'$.c0.receiptRef')
 AND json_extract(NEW.original_json,'$.selectedTerms.ref') IS NEW.terms_ref
 AND json_extract(NEW.original_json,'$.selectedTerms.digest') IS NEW.terms_digest
 AND json_extract(NEW.original_json,'$.actionSource.registrationRef') IS NEW.source_registration_ref
 AND json_extract(NEW.original_json,'$.actionSource.registrationDigest') IS NEW.source_registration_digest
 AND json_extract(NEW.original_json,'$.actionSource.incarnation') IS NEW.source_incarnation
 AND json_extract(NEW.original_json,'$.scopeRealm') IS NEW.scope_json) BEGIN
 SELECT RAISE(ABORT,'constraint: closed R1 original');
END;
CREATE TRIGGER financial_retained_r1_receipts_match BEFORE INSERT ON financial_retained_r1_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_retained_r1_originals o
 WHERE o.r1_ref IS NEW.r1_ref AND o.challenge_ref IS NEW.challenge_ref
 AND o.preparation_ref IS NEW.preparation_ref AND o.receipt_ref IS NEW.receipt_ref
 AND o.command_json IS NEW.command_json AND o.original_digest IS NEW.original_digest
 AND EXISTS(SELECT 1 FROM financial_action_source_registrations s
  WHERE s.registration_ref IS o.source_registration_ref AND s.incarnation IS o.source_incarnation
  AND s.registration_digest IS o.source_registration_digest)) BEGIN
 SELECT RAISE(ABORT,'constraint: mandatory R1 receipt mismatch');
END;
-- These Financial-owned fences consume Root's existing same-primary permit.
-- They do not expand Root's table inventory or make fixture rows qualified sources.
CREATE TRIGGER financial_action_source_registrations_money_fence BEFORE INSERT ON financial_action_source_registrations
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze)
 OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p
 JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch
 WHERE p.singleton=1 AND p.epoch='usd-micros-v2') BEGIN
 SELECT RAISE(ABORT,'constraint: Financial R1 registration permit required');
END;
CREATE TRIGGER financial_retained_r1_originals_money_fence BEFORE INSERT ON financial_retained_r1_originals
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze)
 OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p
 JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch
 WHERE p.singleton=1 AND p.epoch='usd-micros-v2'
 AND p.writer_epoch IS json_extract(NEW.scope_json,'$.writerEpoch')
 AND p.writer_epoch IS json_extract(NEW.original_json,'$.scopeRealm.writerEpoch')) BEGIN
 SELECT RAISE(ABORT,'constraint: Financial R1 original permit/epoch required');
END;
CREATE TRIGGER financial_retained_r1_receipts_money_fence BEFORE INSERT ON financial_retained_r1_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze)
 OR NOT EXISTS(SELECT 1 FROM financial_retained_r1_originals o
 JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'
 JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch
 WHERE o.r1_ref IS NEW.r1_ref AND o.challenge_ref IS NEW.challenge_ref
 AND o.preparation_ref IS NEW.preparation_ref AND o.receipt_ref IS NEW.receipt_ref
 AND o.command_json IS NEW.command_json AND o.original_digest IS NEW.original_digest
 AND p.writer_epoch IS json_extract(o.scope_json,'$.writerEpoch')
 AND p.writer_epoch IS json_extract(o.original_json,'$.scopeRealm.writerEpoch')) BEGIN
 SELECT RAISE(ABORT,'constraint: Financial R1 receipt permit/epoch required');
END;
