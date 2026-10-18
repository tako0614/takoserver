-- PRIVATE UNNUMBERED FINANCIAL CONSENT COMPONENT CANDIDATE ONLY.
-- Not a registered migration, public issuer, genuine consent/source/Auth capture or L1/L2.
-- SQL labels/refs/JSON are retained facts supplied by a future qualified owner, never authentication.
-- Six new tables only; no Customer/business/link/L1-consumption/wallet/provider mutation.
-- Acyclic: existing Auth/source + challenge -> grant -> consent witness -> final receipt.
-- No forward receipt FK; the owning fixed 3-statement batch MUST always issue the unconditional receipt.
CREATE TABLE shared_customer_challenges (
 challenge_ref TEXT PRIMARY KEY NOT NULL,
 organization_id TEXT NOT NULL,
 action_kind TEXT NOT NULL CHECK(action_kind IN('topup','subscription-start','card-setup','plan-change','cancel')),
 action_ref TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
 action_json TEXT NOT NULL CHECK(json_valid(action_json) AND json_type(action_json)='object'),
 selection_json TEXT NOT NULL CHECK(json_valid(selection_json) AND json_type(selection_json)='object'),
 challenge_json TEXT NOT NULL CHECK(json_valid(challenge_json) AND json_type(challenge_json)='object'),
 receiver_ref TEXT NOT NULL, target_ref TEXT NOT NULL,
 account_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN('test','live')),
 billing_authority TEXT NOT NULL, financial_realm TEXT NOT NULL, writer_epoch TEXT NOT NULL,
 history_ref TEXT NOT NULL, history_digest TEXT NOT NULL,
 source_count INTEGER NOT NULL CHECK(typeof(source_count)='integer' AND source_count BETWEEN 1 AND 9007199254740991),
 created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
 expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms)='integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991),
 CHECK(expires_at_ms>created_at_ms AND expires_at_ms-created_at_ms<=300000),
 CHECK(length(request_fingerprint)=71 AND substr(request_fingerprint,1,7)='sha256:' AND substr(request_fingerprint,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(writer_epoch)=71 AND substr(writer_epoch,1,7)='sha256:' AND substr(writer_epoch,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(history_digest)=71 AND substr(history_digest,1,7)='sha256:' AND substr(history_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(financial_realm)=70 AND substr(financial_realm,1,6)='realm:' AND substr(financial_realm,7) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(CAST(action_json AS BLOB)) BETWEEN 2 AND 16384),
 CHECK(length(CAST(selection_json AS BLOB)) BETWEEN 2 AND 16384),
 CHECK(length(CAST(challenge_json AS BLOB)) BETWEEN 2 AND 16384)
);
CREATE TABLE financial_payer_challenge_sources (
 challenge_ref TEXT NOT NULL,
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,
 registration_digest TEXT NOT NULL, registration_qualification_ref TEXT NOT NULL,
 genesis_digest TEXT NOT NULL, genesis_qualification_ref TEXT NOT NULL,
 receiver_ref TEXT NOT NULL, target_ref TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 0 AND 9007199254740991),
 event_digest TEXT NOT NULL, last_event_ref TEXT,
 PRIMARY KEY(challenge_ref,registration_ref,incarnation,affected_ref),
 FOREIGN KEY(challenge_ref) REFERENCES shared_customer_challenges(challenge_ref) ON DELETE RESTRICT,
 FOREIGN KEY(registration_ref,incarnation,affected_ref) REFERENCES financial_source_heads(registration_ref,incarnation,affected_ref) ON DELETE RESTRICT,
 CHECK((sequence=0 AND last_event_ref IS NULL) OR (sequence>0 AND last_event_ref IS NOT NULL)),
 CHECK(length(registration_digest)=71 AND substr(registration_digest,1,7)='sha256:' AND substr(registration_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(genesis_digest)=71 AND substr(genesis_digest,1,7)='sha256:' AND substr(genesis_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(event_digest)=71 AND substr(event_digest,1,7)='sha256:' AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE TABLE financial_payer_grants (
 grant_ref TEXT PRIMARY KEY NOT NULL, grant_incarnation TEXT NOT NULL UNIQUE,
 challenge_ref TEXT NOT NULL UNIQUE,
 principal_id TEXT NOT NULL, principal_incarnation TEXT NOT NULL, principal_binding_ref TEXT NOT NULL,
 authority_ref TEXT NOT NULL, credential_incarnation TEXT NOT NULL,
 auth_snapshot_json TEXT NOT NULL CHECK(json_valid(auth_snapshot_json) AND json_type(auth_snapshot_json)='object'),
 identity_proof_ref TEXT NOT NULL,
 consent_registration_ref TEXT NOT NULL, consent_incarnation TEXT NOT NULL,
 consent_ref TEXT NOT NULL, consent_proof_ref TEXT NOT NULL, consent_digest TEXT NOT NULL,
 issuance_attempt TEXT NOT NULL UNIQUE, expected_receipt_ref TEXT NOT NULL UNIQUE,
 issued_at TEXT NOT NULL,
 UNIQUE(grant_ref,challenge_ref),
 FOREIGN KEY(challenge_ref) REFERENCES shared_customer_challenges(challenge_ref) ON DELETE RESTRICT,
 FOREIGN KEY(principal_id,principal_incarnation) REFERENCES auth_principal_incarnations(principal_id,principal_incarnation) ON DELETE RESTRICT,
 FOREIGN KEY(principal_binding_ref,principal_id,principal_incarnation) REFERENCES shared_principal_bindings(binding_ref,principal_id,principal_incarnation) ON DELETE RESTRICT,
 FOREIGN KEY(authority_ref) REFERENCES credential_authority_classes(authority_ref) ON DELETE RESTRICT,
 CHECK(length(issued_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',issued_at) IS issued_at),
 CHECK(length(consent_digest)=71 AND substr(consent_digest,1,7)='sha256:' AND substr(consent_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(CAST(auth_snapshot_json AS BLOB)) BETWEEN 2 AND 16384)
);
CREATE TABLE financial_payer_consent_witnesses (
 challenge_ref TEXT PRIMARY KEY NOT NULL, grant_ref TEXT NOT NULL UNIQUE,
 consent_registration_ref TEXT NOT NULL, consent_incarnation TEXT NOT NULL, consent_ref TEXT NOT NULL,
 consent_proof_ref TEXT NOT NULL, consent_digest TEXT NOT NULL,
 issuance_attempt TEXT NOT NULL UNIQUE, consumed_at TEXT NOT NULL,
 UNIQUE(challenge_ref,grant_ref),
 UNIQUE(consent_registration_ref,consent_incarnation,consent_ref),
 FOREIGN KEY(grant_ref,challenge_ref) REFERENCES financial_payer_grants(grant_ref,challenge_ref) ON DELETE RESTRICT,
 CHECK(length(consumed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',consumed_at) IS consumed_at),
 CHECK(length(consent_digest)=71 AND substr(consent_digest,1,7)='sha256:' AND substr(consent_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE TABLE financial_payer_consent_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, grant_ref TEXT NOT NULL UNIQUE,
 challenge_ref TEXT NOT NULL UNIQUE, issuance_attempt TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 FOREIGN KEY(challenge_ref,grant_ref) REFERENCES financial_payer_consent_witnesses(challenge_ref,grant_ref) ON DELETE RESTRICT,
 CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)
);
CREATE TABLE financial_payer_grant_revocations (
 grant_ref TEXT PRIMARY KEY NOT NULL, revocation_ref TEXT NOT NULL UNIQUE,
 reason TEXT NOT NULL, authority_evidence_ref TEXT NOT NULL, revoked_at TEXT NOT NULL,
 FOREIGN KEY(grant_ref) REFERENCES financial_payer_grants(grant_ref) ON DELETE RESTRICT,
 CHECK(length(reason) BETWEEN 1 AND 256),
 CHECK(length(revoked_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS revoked_at)
);
CREATE TRIGGER shared_customer_challenges_closed BEFORE INSERT ON shared_customer_challenges
WHEN ((SELECT count(*) FROM json_each(NEW.challenge_json))=10
 AND json_extract(NEW.challenge_json,'$.v') IS 1 AND json_type(NEW.challenge_json,'$.v') IS 'integer'
 AND json_extract(NEW.challenge_json,'$.challengeRef') IS NEW.challenge_ref
 AND json_extract(NEW.challenge_json,'$.organizationId') IS NEW.organization_id
 AND json_extract(NEW.challenge_json,'$.requestFingerprint') IS NEW.request_fingerprint
 AND json_type(NEW.challenge_json,'$.createdAt') IS 'integer'
 AND json_extract(NEW.challenge_json,'$.createdAt') IS NEW.created_at_ms
 AND json_type(NEW.challenge_json,'$.expiresAt') IS 'integer'
 AND json_extract(NEW.challenge_json,'$.expiresAt') IS NEW.expires_at_ms
 AND json_type(NEW.challenge_json,'$.registrationRef') IS 'text'
 AND json_type(NEW.challenge_json,'$.clientId') IS 'text'
 AND json_type(NEW.challenge_json,'$.workspaceId') IS 'text'
 AND json_type(NEW.challenge_json,'$.workspaceRef') IS 'text'
 AND json_type(NEW.selection_json,'$.auth') IS 'object'
 AND json_type(NEW.selection_json,'$.auth.human') IS 'object'
 AND json_type(NEW.selection_json,'$.auth.credential') IS 'object') IS NOT 1 BEGIN
 SELECT RAISE(ABORT,'constraint: exact original ten-field challenge');
END;
CREATE TRIGGER financial_payer_sources_before_grant BEFORE INSERT ON financial_payer_challenge_sources
WHEN EXISTS(SELECT 1 FROM financial_payer_grants WHERE challenge_ref IS NEW.challenge_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: original source vector sealed by grant');
END;
CREATE TRIGGER financial_payer_grants_exact_context BEFORE INSERT ON financial_payer_grants
WHEN (json_extract(NEW.auth_snapshot_json,'$.human.ref') IS NEW.principal_binding_ref
 AND json_extract(NEW.auth_snapshot_json,'$.human.principalId') IS NEW.principal_id
 AND json_extract(NEW.auth_snapshot_json,'$.human.principalIncarnation') IS NEW.principal_incarnation
 AND json_extract(NEW.auth_snapshot_json,'$.credential.origin.ref') IS NEW.authority_ref
 AND json_extract(NEW.auth_snapshot_json,'$.credential.origin.incarnation') IS NEW.credential_incarnation
 AND json_type(NEW.auth_snapshot_json,'$.human') IS 'object'
 AND json_type(NEW.auth_snapshot_json,'$.credential') IS 'object'
 AND EXISTS(SELECT 1 FROM shared_customer_challenges c WHERE c.challenge_ref IS NEW.challenge_ref
 AND json_extract(c.selection_json,'$.auth.human') IS json_extract(NEW.auth_snapshot_json,'$.human')
 AND json_extract(c.selection_json,'$.auth.credential') IS json_extract(NEW.auth_snapshot_json,'$.credential'))) IS NOT 1 BEGIN
 SELECT RAISE(ABORT,'constraint: retained Auth snapshot exact original tuple');
END;
CREATE TRIGGER financial_payer_consent_exact_grant BEFORE INSERT ON financial_payer_consent_witnesses
WHEN NOT EXISTS(SELECT 1 FROM financial_payer_grants g WHERE
 (g.grant_ref IS NEW.grant_ref AND g.challenge_ref IS NEW.challenge_ref
 AND g.consent_registration_ref IS NEW.consent_registration_ref AND g.consent_incarnation IS NEW.consent_incarnation)
 AND (g.consent_ref IS NEW.consent_ref AND g.consent_proof_ref IS NEW.consent_proof_ref
 AND g.consent_digest IS NEW.consent_digest AND g.issuance_attempt IS NEW.issuance_attempt AND g.issued_at IS NEW.consumed_at)) BEGIN
 SELECT RAISE(ABORT,'constraint: original consent consumed by exact grant winner');
END;
CREATE TRIGGER financial_payer_receipt_exact_winner BEFORE INSERT ON financial_payer_consent_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_payer_grants g JOIN financial_payer_consent_witnesses w
 ON w.challenge_ref=g.challenge_ref AND w.grant_ref=g.grant_ref WHERE
 (g.grant_ref IS NEW.grant_ref AND g.challenge_ref IS NEW.challenge_ref
 AND g.issuance_attempt IS NEW.issuance_attempt AND g.expected_receipt_ref IS NEW.receipt_ref)
 AND (w.issuance_attempt IS g.issuance_attempt AND g.issued_at IS NEW.created_at
 AND w.consent_registration_ref IS g.consent_registration_ref AND w.consent_incarnation IS g.consent_incarnation
 AND w.consent_ref IS g.consent_ref AND w.consent_proof_ref IS g.consent_proof_ref AND w.consent_digest IS g.consent_digest)) BEGIN
 SELECT RAISE(ABORT,'constraint: mandatory consent receipt exact consumed winner');
END;
CREATE TRIGGER financial_payer_revoke_accepted BEFORE INSERT ON financial_payer_grant_revocations
WHEN NOT EXISTS(SELECT 1 FROM financial_payer_grants g JOIN financial_payer_consent_receipts r
 ON r.grant_ref=g.grant_ref WHERE g.grant_ref IS NEW.grant_ref AND NEW.revoked_at>=g.issued_at) BEGIN
 SELECT RAISE(ABORT,'constraint: revoke only retained accepted grant');
END;

CREATE TRIGGER shared_customer_challenges_no_replace BEFORE INSERT ON shared_customer_challenges
WHEN EXISTS(SELECT 1 FROM shared_customer_challenges WHERE challenge_ref IS NEW.challenge_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row replacement');
END;
CREATE TRIGGER shared_customer_challenges_no_update BEFORE UPDATE ON shared_customer_challenges BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row immutable');
END;
CREATE TRIGGER shared_customer_challenges_no_delete BEFORE DELETE ON shared_customer_challenges BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent history deletion');
END;

CREATE TRIGGER financial_payer_challenge_sources_no_replace BEFORE INSERT ON financial_payer_challenge_sources
WHEN EXISTS(SELECT 1 FROM financial_payer_challenge_sources WHERE challenge_ref IS NEW.challenge_ref AND registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation AND affected_ref IS NEW.affected_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row replacement');
END;
CREATE TRIGGER financial_payer_challenge_sources_no_update BEFORE UPDATE ON financial_payer_challenge_sources BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row immutable');
END;
CREATE TRIGGER financial_payer_challenge_sources_no_delete BEFORE DELETE ON financial_payer_challenge_sources BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent history deletion');
END;

CREATE TRIGGER financial_payer_grants_no_replace BEFORE INSERT ON financial_payer_grants
WHEN EXISTS(SELECT 1 FROM financial_payer_grants WHERE grant_ref IS NEW.grant_ref OR grant_incarnation IS NEW.grant_incarnation OR challenge_ref IS NEW.challenge_ref OR issuance_attempt IS NEW.issuance_attempt OR expected_receipt_ref IS NEW.expected_receipt_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row replacement');
END;
CREATE TRIGGER financial_payer_grants_no_update BEFORE UPDATE ON financial_payer_grants BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row immutable');
END;
CREATE TRIGGER financial_payer_grants_no_delete BEFORE DELETE ON financial_payer_grants BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent history deletion');
END;

CREATE TRIGGER financial_payer_consent_witnesses_no_replace BEFORE INSERT ON financial_payer_consent_witnesses
WHEN EXISTS(SELECT 1 FROM financial_payer_consent_witnesses WHERE challenge_ref IS NEW.challenge_ref OR grant_ref IS NEW.grant_ref OR issuance_attempt IS NEW.issuance_attempt OR (consent_registration_ref IS NEW.consent_registration_ref AND consent_incarnation IS NEW.consent_incarnation AND consent_ref IS NEW.consent_ref)) BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row replacement');
END;
CREATE TRIGGER financial_payer_consent_witnesses_no_update BEFORE UPDATE ON financial_payer_consent_witnesses BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row immutable');
END;
CREATE TRIGGER financial_payer_consent_witnesses_no_delete BEFORE DELETE ON financial_payer_consent_witnesses BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent history deletion');
END;

CREATE TRIGGER financial_payer_consent_receipts_no_replace BEFORE INSERT ON financial_payer_consent_receipts
WHEN EXISTS(SELECT 1 FROM financial_payer_consent_receipts WHERE receipt_ref IS NEW.receipt_ref OR grant_ref IS NEW.grant_ref OR challenge_ref IS NEW.challenge_ref OR issuance_attempt IS NEW.issuance_attempt) BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row replacement');
END;
CREATE TRIGGER financial_payer_consent_receipts_no_update BEFORE UPDATE ON financial_payer_consent_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row immutable');
END;
CREATE TRIGGER financial_payer_consent_receipts_no_delete BEFORE DELETE ON financial_payer_consent_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent history deletion');
END;

CREATE TRIGGER financial_payer_grant_revocations_no_replace BEFORE INSERT ON financial_payer_grant_revocations
WHEN EXISTS(SELECT 1 FROM financial_payer_grant_revocations WHERE grant_ref IS NEW.grant_ref OR revocation_ref IS NEW.revocation_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row replacement');
END;
CREATE TRIGGER financial_payer_grant_revocations_no_update BEFORE UPDATE ON financial_payer_grant_revocations BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent row immutable');
END;
CREATE TRIGGER financial_payer_grant_revocations_no_delete BEFORE DELETE ON financial_payer_grant_revocations BEGIN
 SELECT RAISE(ABORT,'constraint: retained consent history deletion');
END;
