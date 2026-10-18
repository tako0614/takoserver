-- PRIVATE unregistered payer-origin component; no genuine issuer/adoption authority.
CREATE TABLE financial_org_payer_origins (origin_ref TEXT NOT NULL,origin_incarnation TEXT NOT NULL,grant_ref TEXT NOT NULL,challenge_ref TEXT NOT NULL,organization_id TEXT NOT NULL,action_kind TEXT NOT NULL,action_ref TEXT NOT NULL,request_fingerprint TEXT NOT NULL,principal_id TEXT NOT NULL,principal_incarnation TEXT NOT NULL,principal_binding_ref TEXT NOT NULL,authority_ref TEXT NOT NULL,credential_incarnation TEXT NOT NULL,account_id TEXT NOT NULL,mode TEXT NOT NULL,billing_authority TEXT NOT NULL,financial_realm TEXT NOT NULL,writer_epoch TEXT NOT NULL,consent_registration_ref TEXT NOT NULL,consent_incarnation TEXT NOT NULL,consent_ref TEXT NOT NULL,consent_proof_ref TEXT NOT NULL,consent_digest TEXT NOT NULL,qualification_kind TEXT NOT NULL,qualification_ref TEXT NOT NULL,qualification_digest TEXT NOT NULL,issued_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 PRIMARY KEY(origin_ref),UNIQUE(origin_incarnation),UNIQUE(grant_ref),
 FOREIGN KEY(grant_ref) REFERENCES financial_payer_grants(grant_ref) ON DELETE RESTRICT,
 CHECK(qualification_kind IN ('genesis','adoption')),
 CHECK(mode IN ('test','live')),
 CHECK(action_kind IN ('topup','subscription-start','card-setup','plan-change','cancel')),
 CHECK(length(issued_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',issued_at) IS issued_at),
 CHECK(length(origin_ref) BETWEEN 1 AND 2048),CHECK(length(origin_incarnation) BETWEEN 1 AND 2048),CHECK(length(grant_ref) BETWEEN 1 AND 2048),CHECK(length(challenge_ref) BETWEEN 1 AND 2048),CHECK(length(organization_id) BETWEEN 1 AND 2048),CHECK(length(action_kind) BETWEEN 1 AND 2048),CHECK(length(action_ref) BETWEEN 1 AND 2048),CHECK(length(request_fingerprint) BETWEEN 1 AND 2048),CHECK(length(principal_id) BETWEEN 1 AND 2048),CHECK(length(principal_incarnation) BETWEEN 1 AND 2048),CHECK(length(principal_binding_ref) BETWEEN 1 AND 2048),CHECK(length(authority_ref) BETWEEN 1 AND 2048),CHECK(length(credential_incarnation) BETWEEN 1 AND 2048),CHECK(length(account_id) BETWEEN 1 AND 2048),CHECK(length(mode) BETWEEN 1 AND 2048),CHECK(length(billing_authority) BETWEEN 1 AND 2048),CHECK(length(financial_realm) BETWEEN 1 AND 2048),CHECK(length(writer_epoch) BETWEEN 1 AND 2048),CHECK(length(consent_registration_ref) BETWEEN 1 AND 2048),CHECK(length(consent_incarnation) BETWEEN 1 AND 2048),CHECK(length(consent_ref) BETWEEN 1 AND 2048),CHECK(length(consent_proof_ref) BETWEEN 1 AND 2048),CHECK(length(consent_digest) BETWEEN 1 AND 2048),CHECK(length(qualification_kind) BETWEEN 1 AND 2048),CHECK(length(qualification_ref) BETWEEN 1 AND 2048),CHECK(length(qualification_digest) BETWEEN 1 AND 2048),CHECK(length(issued_at) BETWEEN 1 AND 2048),
 CHECK(length(request_fingerprint)=71 AND substr(request_fingerprint,1,7)='sha256:' AND substr(request_fingerprint,8) NOT GLOB '*[^0-9a-f]*'),CHECK(length(writer_epoch)=71 AND substr(writer_epoch,1,7)='sha256:' AND substr(writer_epoch,8) NOT GLOB '*[^0-9a-f]*'),CHECK(length(consent_digest)=71 AND substr(consent_digest,1,7)='sha256:' AND substr(consent_digest,8) NOT GLOB '*[^0-9a-f]*'),CHECK(length(qualification_digest)=71 AND substr(qualification_digest,1,7)='sha256:' AND substr(qualification_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX financial_org_payer_origins_org ON financial_org_payer_origins(organization_id,origin_ref);
CREATE TABLE financial_org_payer_origin_closures (
 origin_ref TEXT PRIMARY KEY NOT NULL,
 cause TEXT NOT NULL CHECK(cause IN ('org-delete','owner-or-id-change','org-reinsert','member-delete','member-update','member-insert')),
 old_tuple_json TEXT CHECK(old_tuple_json IS NULL OR json_valid(old_tuple_json)),
 new_tuple_json TEXT CHECK(new_tuple_json IS NULL OR json_valid(new_tuple_json)),
 closed_at TEXT NOT NULL CHECK(length(closed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',closed_at) IS closed_at),
 FOREIGN KEY(origin_ref) REFERENCES financial_org_payer_origins(origin_ref) ON DELETE RESTRICT
);
CREATE TRIGGER financial_org_payer_origins_exact_grant BEFORE INSERT ON financial_org_payer_origins
WHEN NOT EXISTS(SELECT 1 FROM financial_payer_grants g
 JOIN shared_customer_challenges c ON c.challenge_ref=g.challenge_ref
 JOIN financial_payer_consent_witnesses w ON w.challenge_ref=g.challenge_ref AND w.grant_ref=g.grant_ref
 JOIN financial_payer_consent_receipts r ON r.challenge_ref=g.challenge_ref AND r.grant_ref=g.grant_ref
 WHERE g.grant_ref IS NEW.grant_ref AND g.challenge_ref IS NEW.challenge_ref AND g.principal_id IS NEW.principal_id AND g.principal_incarnation IS NEW.principal_incarnation AND g.principal_binding_ref IS NEW.principal_binding_ref AND g.authority_ref IS NEW.authority_ref AND g.credential_incarnation IS NEW.credential_incarnation AND g.consent_registration_ref IS NEW.consent_registration_ref AND g.consent_incarnation IS NEW.consent_incarnation AND g.consent_ref IS NEW.consent_ref AND g.consent_proof_ref IS NEW.consent_proof_ref AND g.consent_digest IS NEW.consent_digest
 AND c.organization_id IS NEW.organization_id AND c.action_kind IS NEW.action_kind AND c.action_ref IS NEW.action_ref AND c.request_fingerprint IS NEW.request_fingerprint AND c.account_id IS NEW.account_id AND c.mode IS NEW.mode AND c.billing_authority IS NEW.billing_authority AND c.financial_realm IS NEW.financial_realm AND c.writer_epoch IS NEW.writer_epoch
 AND g.issued_at IS NEW.issued_at AND r.receipt_ref IS g.expected_receipt_ref AND r.all_rows_match IS 1
 AND w.consent_registration_ref IS g.consent_registration_ref AND w.consent_incarnation IS g.consent_incarnation
 AND w.consent_ref IS g.consent_ref AND w.consent_proof_ref IS g.consent_proof_ref AND w.consent_digest IS g.consent_digest)
BEGIN SELECT RAISE(ABORT,'constraint: payer origin exact completed consent'); END;
CREATE TRIGGER financial_org_payer_origins_replace BEFORE INSERT ON financial_org_payer_origins WHEN EXISTS(SELECT 1 FROM financial_org_payer_origins v WHERE v.origin_ref IS NEW.origin_ref OR v.origin_incarnation IS NEW.origin_incarnation OR v.grant_ref IS NEW.grant_ref) BEGIN SELECT RAISE(ABORT,'constraint: payer origin replacement forbidden'); END;
CREATE TRIGGER financial_org_payer_origins_update BEFORE UPDATE ON financial_org_payer_origins BEGIN SELECT RAISE(ABORT,'constraint: payer origin history immutable'); END;
CREATE TRIGGER financial_org_payer_origins_delete BEFORE DELETE ON financial_org_payer_origins BEGIN SELECT RAISE(ABORT,'constraint: payer origin history immutable'); END;
CREATE TRIGGER financial_org_payer_origin_closures_replace BEFORE INSERT ON financial_org_payer_origin_closures WHEN EXISTS(SELECT 1 FROM financial_org_payer_origin_closures v WHERE v.origin_ref IS NEW.origin_ref) BEGIN SELECT RAISE(ABORT,'constraint: payer origin replacement forbidden'); END;
CREATE TRIGGER financial_org_payer_origin_closures_update BEFORE UPDATE ON financial_org_payer_origin_closures BEGIN SELECT RAISE(ABORT,'constraint: payer origin history immutable'); END;
CREATE TRIGGER financial_org_payer_origin_closures_delete BEFORE DELETE ON financial_org_payer_origin_closures BEGIN SELECT RAISE(ABORT,'constraint: payer origin history immutable'); END;
CREATE TRIGGER financial_payer_origin_OD BEFORE DELETE ON orgs BEGIN
 INSERT INTO financial_org_payer_origin_closures(origin_ref,cause,old_tuple_json,new_tuple_json,closed_at)
 SELECT p.origin_ref,'org-delete',json_object('id',OLD.id,'owner',OLD.owner_principal_id),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM financial_org_payer_origins p WHERE (p.organization_id IS OLD.id) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM financial_org_payer_origins p WHERE (p.organization_id IS OLD.id) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref))
 THEN RAISE(ABORT,'constraint: payer origin closure incomplete') ELSE 1 END;
END;
CREATE TRIGGER financial_payer_origin_OU BEFORE UPDATE ON orgs BEGIN
 INSERT INTO financial_org_payer_origin_closures(origin_ref,cause,old_tuple_json,new_tuple_json,closed_at)
 SELECT p.origin_ref,'owner-or-id-change',json_object('id',OLD.id,'owner',OLD.owner_principal_id),json_object('id',NEW.id,'owner',NEW.owner_principal_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM financial_org_payer_origins p WHERE ((((OLD.id IS NOT NEW.id OR OLD.owner_principal_id IS NOT NEW.owner_principal_id) AND p.organization_id IS OLD.id) OR (OLD.id IS NOT NEW.id AND p.organization_id IS NEW.id AND EXISTS(SELECT 1 FROM orgs v WHERE v.id IS NEW.id)))) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM financial_org_payer_origins p WHERE ((((OLD.id IS NOT NEW.id OR OLD.owner_principal_id IS NOT NEW.owner_principal_id) AND p.organization_id IS OLD.id) OR (OLD.id IS NOT NEW.id AND p.organization_id IS NEW.id AND EXISTS(SELECT 1 FROM orgs v WHERE v.id IS NEW.id)))) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref))
 THEN RAISE(ABORT,'constraint: payer origin closure incomplete') ELSE 1 END;
END;
CREATE TRIGGER financial_payer_origin_OI BEFORE INSERT ON orgs BEGIN
 INSERT INTO financial_org_payer_origin_closures(origin_ref,cause,old_tuple_json,new_tuple_json,closed_at)
 SELECT p.origin_ref,'org-reinsert',NULL,json_object('id',NEW.id,'owner',NEW.owner_principal_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM financial_org_payer_origins p WHERE ((p.organization_id IS NEW.id AND EXISTS(SELECT 1 FROM orgs v WHERE v.id IS NEW.id))) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM financial_org_payer_origins p WHERE ((p.organization_id IS NEW.id AND EXISTS(SELECT 1 FROM orgs v WHERE v.id IS NEW.id))) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref))
 THEN RAISE(ABORT,'constraint: payer origin closure incomplete') ELSE 1 END;
END;
CREATE TRIGGER financial_payer_origin_MD BEFORE DELETE ON org_memberships BEGIN
 INSERT INTO financial_org_payer_origin_closures(origin_ref,cause,old_tuple_json,new_tuple_json,closed_at)
 SELECT p.origin_ref,'member-delete',json_object('organizationId',OLD.org_id,'principalId',OLD.principal_id,'role',OLD.role),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM financial_org_payer_origins p WHERE ((OLD.role IS 'owner' AND p.organization_id IS OLD.org_id)) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM financial_org_payer_origins p WHERE ((OLD.role IS 'owner' AND p.organization_id IS OLD.org_id)) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref))
 THEN RAISE(ABORT,'constraint: payer origin closure incomplete') ELSE 1 END;
END;
CREATE TRIGGER financial_payer_origin_MU BEFORE UPDATE ON org_memberships BEGIN
 INSERT INTO financial_org_payer_origin_closures(origin_ref,cause,old_tuple_json,new_tuple_json,closed_at)
 SELECT p.origin_ref,'member-update',json_object('organizationId',OLD.org_id,'principalId',OLD.principal_id,'role',OLD.role),json_object('organizationId',NEW.org_id,'principalId',NEW.principal_id,'role',NEW.role),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM financial_org_payer_origins p WHERE (((OLD.role IS 'owner' AND p.organization_id IS OLD.org_id) OR (NEW.role IS 'owner' AND p.organization_id IS NEW.org_id) OR (p.organization_id IS NEW.org_id AND EXISTS(SELECT 1 FROM org_memberships v WHERE v.org_id IS NEW.org_id AND v.principal_id IS NEW.principal_id AND v.role IS 'owner')))) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM financial_org_payer_origins p WHERE (((OLD.role IS 'owner' AND p.organization_id IS OLD.org_id) OR (NEW.role IS 'owner' AND p.organization_id IS NEW.org_id) OR (p.organization_id IS NEW.org_id AND EXISTS(SELECT 1 FROM org_memberships v WHERE v.org_id IS NEW.org_id AND v.principal_id IS NEW.principal_id AND v.role IS 'owner')))) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref))
 THEN RAISE(ABORT,'constraint: payer origin closure incomplete') ELSE 1 END;
END;
CREATE TRIGGER financial_payer_origin_MI BEFORE INSERT ON org_memberships BEGIN
 INSERT INTO financial_org_payer_origin_closures(origin_ref,cause,old_tuple_json,new_tuple_json,closed_at)
 SELECT p.origin_ref,'member-insert',NULL,json_object('organizationId',NEW.org_id,'principalId',NEW.principal_id,'role',NEW.role),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM financial_org_payer_origins p WHERE (((NEW.role IS 'owner' AND p.organization_id IS NEW.org_id) OR (p.organization_id IS NEW.org_id AND EXISTS(SELECT 1 FROM org_memberships v WHERE v.org_id IS NEW.org_id AND v.principal_id IS NEW.principal_id AND v.role IS 'owner')))) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM financial_org_payer_origins p WHERE (((NEW.role IS 'owner' AND p.organization_id IS NEW.org_id) OR (p.organization_id IS NEW.org_id AND EXISTS(SELECT 1 FROM org_memberships v WHERE v.org_id IS NEW.org_id AND v.principal_id IS NEW.principal_id AND v.role IS 'owner')))) AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=p.origin_ref))
 THEN RAISE(ABORT,'constraint: payer origin closure incomplete') ELSE 1 END;
END;
