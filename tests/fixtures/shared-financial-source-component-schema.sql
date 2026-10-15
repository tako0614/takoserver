-- PRIVATE UNNUMBERED SOURCE-ONLY RECEIVER CANDIDATE. NOT REGISTERED/APPLIED/COMPILED.
-- No genuine caller/source/payer authority is minted by SQL labels or JSON.
-- Schema only; enrollment/retirement is owning qualified composition, never apply(event).
-- Sequence is per (registration_ref,incarnation,affected_ref), confirmed against frozen producer.
-- Acyclic FK edges: event->registration; head->registration/event; receipt->event/head/registration.
CREATE TABLE financial_source_registrations (
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL,
 receiver_ref TEXT NOT NULL, target_ref TEXT NOT NULL,
 genesis_digest TEXT NOT NULL, registration_digest TEXT NOT NULL,
 registration_json TEXT NOT NULL CHECK(json_valid(registration_json)),
 qualification_ref TEXT NOT NULL, registered_at TEXT NOT NULL,
 retirement_ref TEXT, retired_at TEXT,
 PRIMARY KEY(registration_ref,incarnation),
 CHECK((retirement_ref IS NULL)=(retired_at IS NULL)),
 CHECK(retirement_ref IS NULL OR (length(retirement_ref) BETWEEN 1 AND 256 AND substr(retirement_ref,1,1) GLOB '[A-Za-z0-9]' AND retirement_ref NOT GLOB '*[^A-Za-z0-9._:/-]*')),
 CHECK(retired_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',retired_at) IS retired_at),
 CHECK(retired_at IS NULL OR retired_at>=registered_at),
 CHECK(length(CAST(registration_json AS BLOB)) BETWEEN 2 AND 16384),
 CHECK(length(registration_ref) BETWEEN 1 AND 256 AND substr(registration_ref,1,1) GLOB '[A-Za-z0-9]' AND registration_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(incarnation) BETWEEN 1 AND 256 AND substr(incarnation,1,1) GLOB '[A-Za-z0-9]' AND incarnation NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(receiver_ref) BETWEEN 1 AND 256 AND substr(receiver_ref,1,1) GLOB '[A-Za-z0-9]' AND receiver_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(target_ref) BETWEEN 1 AND 256 AND substr(target_ref,1,1) GLOB '[A-Za-z0-9]' AND target_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(qualification_ref) BETWEEN 1 AND 256 AND substr(qualification_ref,1,1) GLOB '[A-Za-z0-9]' AND qualification_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(substr(genesis_digest,1,7)='sha256:' AND length(genesis_digest)=71 AND substr(genesis_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(substr(registration_digest,1,7)='sha256:' AND length(registration_digest)=71 AND substr(registration_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',registered_at) IS registered_at)
);
CREATE TABLE financial_source_events (
 event_ref TEXT PRIMARY KEY NOT NULL,
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
 previous_digest TEXT NOT NULL, event_digest TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('advance','close')), evidence_ref TEXT NOT NULL,
 event_json TEXT NOT NULL CHECK(json_valid(event_json)), applied_at TEXT NOT NULL,
 UNIQUE(registration_ref,incarnation,affected_ref,sequence),
 FOREIGN KEY(registration_ref,incarnation) REFERENCES financial_source_registrations(registration_ref,incarnation) ON DELETE RESTRICT,
 CHECK(length(CAST(event_json AS BLOB)) BETWEEN 2 AND 16384),
 CHECK(length(event_ref) BETWEEN 1 AND 256 AND substr(event_ref,1,1) GLOB '[A-Za-z0-9]' AND event_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(registration_ref) BETWEEN 1 AND 256 AND substr(registration_ref,1,1) GLOB '[A-Za-z0-9]' AND registration_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(incarnation) BETWEEN 1 AND 256 AND substr(incarnation,1,1) GLOB '[A-Za-z0-9]' AND incarnation NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(affected_ref) BETWEEN 1 AND 256 AND substr(affected_ref,1,1) GLOB '[A-Za-z0-9]' AND affected_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(evidence_ref) BETWEEN 1 AND 256 AND substr(evidence_ref,1,1) GLOB '[A-Za-z0-9]' AND evidence_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(substr(previous_digest,1,7)='sha256:' AND length(previous_digest)=71 AND substr(previous_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(substr(event_digest,1,7)='sha256:' AND length(event_digest)=71 AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',applied_at) IS applied_at)
);
CREATE TABLE financial_source_heads (
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,
 genesis_qualification_ref TEXT NOT NULL, created_at TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 0 AND 9007199254740991),
 event_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('active','closed')),
 last_event_ref TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(registration_ref,incarnation,affected_ref),
 FOREIGN KEY(registration_ref,incarnation) REFERENCES financial_source_registrations(registration_ref,incarnation) ON DELETE RESTRICT,
 FOREIGN KEY(last_event_ref) REFERENCES financial_source_events(event_ref) ON DELETE RESTRICT,
 CHECK((sequence=0 AND last_event_ref IS NULL AND state='active') OR (sequence>0 AND last_event_ref IS NOT NULL)),
 CHECK(updated_at>=created_at),
 CHECK(length(registration_ref) BETWEEN 1 AND 256 AND substr(registration_ref,1,1) GLOB '[A-Za-z0-9]' AND registration_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(incarnation) BETWEEN 1 AND 256 AND substr(incarnation,1,1) GLOB '[A-Za-z0-9]' AND incarnation NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(affected_ref) BETWEEN 1 AND 256 AND substr(affected_ref,1,1) GLOB '[A-Za-z0-9]' AND affected_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(genesis_qualification_ref) BETWEEN 1 AND 256 AND substr(genesis_qualification_ref,1,1) GLOB '[A-Za-z0-9]' AND genesis_qualification_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(substr(event_digest,1,7)='sha256:' AND length(event_digest)=71 AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS updated_at)
);
CREATE TABLE financial_source_receipts (
 event_ref TEXT PRIMARY KEY NOT NULL, receipt_ref TEXT NOT NULL UNIQUE,
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,
 receiver_ref TEXT NOT NULL, target_ref TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
 event_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('admission-closed','advanced')),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 FOREIGN KEY(event_ref) REFERENCES financial_source_events(event_ref) ON DELETE RESTRICT,
 FOREIGN KEY(registration_ref,incarnation,affected_ref) REFERENCES financial_source_heads(registration_ref,incarnation,affected_ref) ON DELETE RESTRICT,
 FOREIGN KEY(registration_ref,incarnation) REFERENCES financial_source_registrations(registration_ref,incarnation) ON DELETE RESTRICT,
 CHECK(length(receipt_ref)=68 AND substr(receipt_ref,1,4)='fsr_' AND substr(receipt_ref,5) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 16384),
 CHECK(length(event_ref) BETWEEN 1 AND 256 AND substr(event_ref,1,1) GLOB '[A-Za-z0-9]' AND event_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(registration_ref) BETWEEN 1 AND 256 AND substr(registration_ref,1,1) GLOB '[A-Za-z0-9]' AND registration_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(incarnation) BETWEEN 1 AND 256 AND substr(incarnation,1,1) GLOB '[A-Za-z0-9]' AND incarnation NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(affected_ref) BETWEEN 1 AND 256 AND substr(affected_ref,1,1) GLOB '[A-Za-z0-9]' AND affected_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(receiver_ref) BETWEEN 1 AND 256 AND substr(receiver_ref,1,1) GLOB '[A-Za-z0-9]' AND receiver_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(length(target_ref) BETWEEN 1 AND 256 AND substr(target_ref,1,1) GLOB '[A-Za-z0-9]' AND target_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),
 CHECK(substr(event_digest,1,7)='sha256:' AND length(event_digest)=71 AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)
);
CREATE TRIGGER financial_source_registration_shape BEFORE INSERT ON financial_source_registrations
WHEN ((json_type(NEW.registration_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.registration_json))=4 AND json_extract(NEW.registration_json,'$.registrationRef') IS NEW.registration_ref AND json_extract(NEW.registration_json,'$.incarnation') IS NEW.incarnation AND json_extract(NEW.registration_json,'$.genesisDigest') IS NEW.genesis_digest) AND (json_type(NEW.registration_json,'$.receivers') IS 'array' AND json_array_length(NEW.registration_json,'$.receivers') BETWEEN 1 AND 8 AND (SELECT count(DISTINCT json_extract(value,'$.receiverRef')) FROM json_each(NEW.registration_json,'$.receivers'))=json_array_length(NEW.registration_json,'$.receivers') AND NOT EXISTS(SELECT 1 FROM json_each(NEW.registration_json,'$.receivers') AS member WHERE json_type(member.value) IS NOT 'object' OR (SELECT count(*) FROM json_each(member.value))<>2 OR json_type(member.value,'$.receiverRef') IS NOT 'text' OR json_type(member.value,'$.targetRef') IS NOT 'text') AND EXISTS(SELECT 1 FROM json_each(NEW.registration_json,'$.receivers') WHERE json_extract(value,'$.receiverRef') IS NEW.receiver_ref AND json_extract(value,'$.targetRef') IS NEW.target_ref)) AND (json_type(NEW.registration_json,'$.registrationRef') IS 'text' AND json_type(NEW.registration_json,'$.incarnation') IS 'text' AND json_type(NEW.registration_json,'$.genesisDigest') IS 'text' AND NEW.retired_at IS NULL AND NEW.retirement_ref IS NULL)) IS NOT 1 BEGIN
 SELECT RAISE(ABORT,'constraint: source enrollment closed tuple');
END;
CREATE TRIGGER financial_source_registration_retire_only BEFORE UPDATE ON financial_source_registrations
WHEN ((NEW.registration_ref IS OLD.registration_ref AND NEW.incarnation IS OLD.incarnation AND NEW.receiver_ref IS OLD.receiver_ref AND NEW.target_ref IS OLD.target_ref AND NEW.genesis_digest IS OLD.genesis_digest) AND (NEW.registration_digest IS OLD.registration_digest AND NEW.registration_json IS OLD.registration_json AND NEW.qualification_ref IS OLD.qualification_ref AND NEW.registered_at IS OLD.registered_at)) IS NOT 1
 OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.retirement_ref IS NULL BEGIN
 SELECT RAISE(ABORT,'constraint: source registration immutable or retirement terminal');
END;
CREATE TRIGGER financial_source_head_genesis BEFORE INSERT ON financial_source_heads
WHEN NEW.sequence<>0 OR NEW.last_event_ref IS NOT NULL OR NEW.state<>'active'
 OR NOT EXISTS(SELECT 1 FROM financial_source_registrations r
  WHERE r.registration_ref=NEW.registration_ref AND r.incarnation=NEW.incarnation
   AND r.retired_at IS NULL AND r.genesis_digest=NEW.event_digest) BEGIN
 SELECT RAISE(ABORT,'constraint: explicit enrolled genesis required');
END;
CREATE TRIGGER financial_source_event_predecessor BEFORE INSERT ON financial_source_events
WHEN NOT EXISTS(SELECT 1 FROM financial_source_registrations r
 JOIN financial_source_heads h ON h.registration_ref=r.registration_ref AND h.incarnation=r.incarnation
 WHERE ((r.registration_ref IS NEW.registration_ref AND r.incarnation IS NEW.incarnation AND r.retired_at IS NULL AND h.affected_ref IS NEW.affected_ref AND h.state IS 'active') AND (h.sequence=NEW.sequence-1 AND h.event_digest IS NEW.previous_digest AND json_type(NEW.event_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.event_json))=9 AND json_extract(NEW.event_json,'$.v') IS 1) AND (json_type(NEW.event_json,'$.v') IS 'integer' AND json_extract(NEW.event_json,'$.eventRef') IS NEW.event_ref AND json_extract(NEW.event_json,'$.registrationRef') IS NEW.registration_ref AND json_extract(NEW.event_json,'$.incarnation') IS NEW.incarnation AND json_extract(NEW.event_json,'$.affectedRef') IS NEW.affected_ref) AND (json_extract(NEW.event_json,'$.sequence') IS NEW.sequence AND json_extract(NEW.event_json,'$.previousDigest') IS NEW.previous_digest AND json_extract(NEW.event_json,'$.kind') IS NEW.kind AND json_extract(NEW.event_json,'$.evidenceRef') IS NEW.evidence_ref AND json_type(NEW.event_json,'$.sequence') IS 'integer') AND (json_type(NEW.event_json,'$.eventRef') IS 'text' AND json_type(NEW.event_json,'$.registrationRef') IS 'text' AND json_type(NEW.event_json,'$.incarnation') IS 'text' AND json_type(NEW.event_json,'$.affectedRef') IS 'text' AND json_type(NEW.event_json,'$.previousDigest') IS 'text') AND (json_type(NEW.event_json,'$.kind') IS 'text' AND json_type(NEW.event_json,'$.evidenceRef') IS 'text'))) BEGIN
 SELECT RAISE(ABORT,'constraint: source event original predecessor or closed tuple');
END;
CREATE TRIGGER financial_source_head_advance BEFORE UPDATE ON financial_source_heads
WHEN ((NEW.registration_ref IS OLD.registration_ref AND NEW.incarnation IS OLD.incarnation AND NEW.affected_ref IS OLD.affected_ref AND NEW.genesis_qualification_ref IS OLD.genesis_qualification_ref AND NEW.created_at IS OLD.created_at)) IS NOT 1
 OR OLD.state<>'active' OR NEW.sequence<>OLD.sequence+1
 OR NOT EXISTS(SELECT 1 FROM financial_source_events e JOIN financial_source_registrations r
  ON r.registration_ref=e.registration_ref AND r.incarnation=e.incarnation
 WHERE ((e.event_ref IS NEW.last_event_ref AND e.registration_ref IS NEW.registration_ref AND e.incarnation IS NEW.incarnation AND e.affected_ref IS NEW.affected_ref AND e.sequence IS NEW.sequence) AND (e.previous_digest IS OLD.event_digest AND e.event_digest IS NEW.event_digest AND r.retired_at IS NULL AND NEW.state IS CASE e.kind WHEN 'close' THEN 'closed' ELSE 'active' END))) BEGIN
 SELECT RAISE(ABORT,'constraint: source head exact one-step monotonic transition');
END;
CREATE TRIGGER financial_source_receipt_match BEFORE INSERT ON financial_source_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_source_events e
 JOIN financial_source_heads h ON h.registration_ref=e.registration_ref AND h.incarnation=e.incarnation AND h.affected_ref=e.affected_ref
 JOIN financial_source_registrations r ON r.registration_ref=e.registration_ref AND r.incarnation=e.incarnation
 WHERE ((e.event_ref IS NEW.event_ref AND e.registration_ref IS NEW.registration_ref AND e.incarnation IS NEW.incarnation AND e.affected_ref IS NEW.affected_ref AND e.sequence IS NEW.sequence) AND (e.event_digest IS NEW.event_digest AND r.receiver_ref IS NEW.receiver_ref AND r.target_ref IS NEW.target_ref AND r.retired_at IS NULL AND h.sequence IS e.sequence) AND (h.last_event_ref IS e.event_ref AND h.event_digest IS e.event_digest AND h.state IS CASE e.kind WHEN 'close' THEN 'closed' ELSE 'active' END AND NEW.state IS CASE e.kind WHEN 'close' THEN 'admission-closed' ELSE 'advanced' END AND json_type(NEW.receipt_json) IS 'object') AND ((SELECT count(*) FROM json_each(NEW.receipt_json))=7 AND json_extract(NEW.receipt_json,'$.v') IS 1 AND json_type(NEW.receipt_json,'$.v') IS 'integer' AND json_extract(NEW.receipt_json,'$.eventRef') IS NEW.event_ref AND json_extract(NEW.receipt_json,'$.eventDigest') IS NEW.event_digest) AND (json_extract(NEW.receipt_json,'$.receiptRef') IS NEW.receipt_ref AND json_extract(NEW.receipt_json,'$.incarnation') IS NEW.incarnation AND json_extract(NEW.receipt_json,'$.sequence') IS NEW.sequence AND json_extract(NEW.receipt_json,'$.state') IS NEW.state AND json_type(NEW.receipt_json,'$.sequence') IS 'integer') AND (json_type(NEW.receipt_json,'$.eventRef') IS 'text' AND json_type(NEW.receipt_json,'$.eventDigest') IS 'text' AND json_type(NEW.receipt_json,'$.receiptRef') IS 'text' AND json_type(NEW.receipt_json,'$.incarnation') IS 'text' AND json_type(NEW.receipt_json,'$.state') IS 'text'))) BEGIN
 SELECT RAISE(ABORT,'constraint: source receipt exact committed event and head');
END;
CREATE TRIGGER financial_source_registrations_no_replace BEFORE INSERT ON financial_source_registrations
WHEN EXISTS(SELECT 1 FROM financial_source_registrations WHERE registration_ref IS NEW.registration_ref AND (incarnation IS NEW.incarnation OR retired_at IS NULL)) BEGIN
 SELECT RAISE(ABORT,'constraint: retained source row replacement');
END;
CREATE TRIGGER financial_source_registrations_no_delete BEFORE DELETE ON financial_source_registrations BEGIN
 SELECT RAISE(ABORT,'constraint: retained source row deletion');
END;
CREATE TRIGGER financial_source_heads_no_replace BEFORE INSERT ON financial_source_heads
WHEN EXISTS(SELECT 1 FROM financial_source_heads WHERE registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation AND affected_ref IS NEW.affected_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: retained source row replacement');
END;
CREATE TRIGGER financial_source_heads_no_delete BEFORE DELETE ON financial_source_heads BEGIN
 SELECT RAISE(ABORT,'constraint: retained source row deletion');
END;
CREATE TRIGGER financial_source_events_no_replace BEFORE INSERT ON financial_source_events
WHEN EXISTS(SELECT 1 FROM financial_source_events WHERE event_ref IS NEW.event_ref OR (registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation AND affected_ref IS NEW.affected_ref AND sequence IS NEW.sequence)) BEGIN
 SELECT RAISE(ABORT,'constraint: retained source row replacement');
END;
CREATE TRIGGER financial_source_events_no_delete BEFORE DELETE ON financial_source_events BEGIN
 SELECT RAISE(ABORT,'constraint: retained source row deletion');
END;
CREATE TRIGGER financial_source_events_no_update BEFORE UPDATE ON financial_source_events BEGIN
 SELECT RAISE(ABORT,'constraint: immutable source event or receipt');
END;
CREATE TRIGGER financial_source_receipts_no_replace BEFORE INSERT ON financial_source_receipts
WHEN EXISTS(SELECT 1 FROM financial_source_receipts WHERE event_ref IS NEW.event_ref OR receipt_ref IS NEW.receipt_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: retained source row replacement');
END;
CREATE TRIGGER financial_source_receipts_no_delete BEFORE DELETE ON financial_source_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: retained source row deletion');
END;
CREATE TRIGGER financial_source_receipts_no_update BEFORE UPDATE ON financial_source_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: immutable source event or receipt');
END;

CREATE UNIQUE INDEX financial_source_registrations_one_active
 ON financial_source_registrations(registration_ref) WHERE retired_at IS NULL;
