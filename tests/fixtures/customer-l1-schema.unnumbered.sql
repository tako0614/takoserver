-- PRIVATE UNNUMBERED B CUSTOMER-L1 COMPONENT ONLY. Synthetic prerequisites are not authority.
-- No published issuer, full current-payer/history writer, L2, business acceptance, or automatic adoption.
-- Acyclic retained references; fixed owning four-statement batch must issue its unconditional receipt.
CREATE TABLE financial_customer_admissions (
 admission_ref TEXT PRIMARY KEY NOT NULL, challenge_ref TEXT NOT NULL UNIQUE,
 grant_ref TEXT NOT NULL, issuance_attempt TEXT NOT NULL UNIQUE, expected_receipt_ref TEXT NOT NULL UNIQUE,
 organization_id TEXT NOT NULL, action_kind TEXT NOT NULL CHECK(action_kind IN('topup','subscription-start','card-setup')),
 action_ref TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
 action_json TEXT NOT NULL CHECK(json_valid(action_json) AND json_type(action_json)='object'),
 selection_json TEXT NOT NULL CHECK(json_valid(selection_json) AND json_type(selection_json)='object'),
 terms_json TEXT NOT NULL CHECK(json_valid(terms_json) AND json_type(terms_json)='object'),
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object'),
 realm_json TEXT NOT NULL CHECK(json_valid(realm_json) AND json_type(realm_json)='object'),
 customer_request_json TEXT NOT NULL CHECK(json_valid(customer_request_json) AND json_type(customer_request_json)='object'),
 customer_fingerprint TEXT NOT NULL, stripe_key TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(grant_ref,challenge_ref) REFERENCES financial_payer_grants(grant_ref,challenge_ref) ON DELETE RESTRICT,
 CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 CHECK(length(CAST(context_json AS BLOB)) BETWEEN 2 AND 65536)
);
CREATE TABLE stripe_customer_admission_links (
 org_id TEXT PRIMARY KEY NOT NULL, admission_ref TEXT NOT NULL UNIQUE,
 customer_fingerprint TEXT NOT NULL, stripe_key TEXT NOT NULL,
 realm_json TEXT NOT NULL, customer_request_json TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(org_id) REFERENCES stripe_billing_customer_commands(org_id) ON DELETE RESTRICT,
 FOREIGN KEY(admission_ref) REFERENCES financial_customer_admissions(admission_ref) ON DELETE RESTRICT
);
CREATE TABLE financial_customer_admission_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, admission_ref TEXT NOT NULL UNIQUE,
 issuance_attempt TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, created_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 FOREIGN KEY(admission_ref) REFERENCES financial_customer_admissions(admission_ref) ON DELETE RESTRICT,
 FOREIGN KEY(org_id) REFERENCES stripe_customer_admission_links(org_id) ON DELETE RESTRICT
);
CREATE INDEX financial_customer_admission_receipts_by_org ON financial_customer_admission_receipts(org_id);
CREATE TRIGGER financial_customer_admission_original BEFORE INSERT ON financial_customer_admissions
WHEN NOT EXISTS(SELECT 1 FROM shared_customer_challenges c
 JOIN financial_payer_grants g ON g.challenge_ref=c.challenge_ref
 JOIN financial_payer_consent_witnesses w ON w.grant_ref=g.grant_ref AND w.challenge_ref=g.challenge_ref
 JOIN financial_payer_consent_receipts r ON r.grant_ref=g.grant_ref AND r.challenge_ref=g.challenge_ref
 WHERE (g.grant_ref IS NEW.grant_ref AND c.challenge_ref IS NEW.challenge_ref
 AND c.organization_id IS NEW.organization_id AND c.action_kind IS NEW.action_kind
 AND c.action_ref IS NEW.action_ref AND c.request_fingerprint IS NEW.request_fingerprint)
 AND (c.action_json IS NEW.action_json AND c.selection_json IS NEW.selection_json
 AND json_extract(c.selection_json,'$.selectedTerms') IS NEW.terms_json
 AND json_extract(c.selection_json,'$.customer.realmJson') IS NEW.realm_json
 AND json_extract(c.selection_json,'$.customer.requestJson') IS NEW.customer_request_json
 AND json_extract(c.selection_json,'$.customer.fingerprint') IS NEW.customer_fingerprint
 AND json_extract(c.selection_json,'$.customer.key') IS NEW.stripe_key)
 AND (w.issuance_attempt IS g.issuance_attempt AND r.issuance_attempt IS g.issuance_attempt
 AND r.receipt_ref IS g.expected_receipt_ref AND r.all_rows_match IS 1)) BEGIN
 SELECT RAISE(ABORT,'constraint: exact completed original consent/customer selection');
END;
CREATE TRIGGER stripe_customer_admission_link_original BEFORE INSERT ON stripe_customer_admission_links
WHEN NOT EXISTS(SELECT 1 FROM financial_customer_admissions a
 JOIN stripe_billing_customer_commands k ON k.org_id=a.organization_id
 WHERE (a.admission_ref IS NEW.admission_ref AND a.organization_id IS NEW.org_id
 AND a.customer_fingerprint IS NEW.customer_fingerprint AND a.stripe_key IS NEW.stripe_key)
 AND (a.realm_json IS NEW.realm_json AND a.customer_request_json IS NEW.customer_request_json
 AND k.fingerprint IS a.customer_fingerprint AND k.stripe_key IS a.stripe_key
 AND k.realm_json IS a.realm_json AND k.request_json IS a.customer_request_json
 AND k.state IS 'prepared' AND k.dispatched_at IS NULL AND k.customer_id IS NULL)
 AND (NEW.created_at IS a.created_at AND k.created_at IS a.created_at)) BEGIN
 SELECT RAISE(ABORT,'constraint: exact original customer creation link');
END;
CREATE TRIGGER financial_customer_admission_receipt_original BEFORE INSERT ON financial_customer_admission_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_customer_admissions a JOIN stripe_customer_admission_links l
 ON l.admission_ref=a.admission_ref AND l.org_id=a.organization_id
 WHERE (a.admission_ref IS NEW.admission_ref AND a.expected_receipt_ref IS NEW.receipt_ref
 AND a.issuance_attempt IS NEW.issuance_attempt AND a.organization_id IS NEW.org_id
 AND a.created_at IS NEW.created_at AND l.created_at IS a.created_at)) BEGIN
 SELECT RAISE(ABORT,'constraint: mandatory receipt exact L1 consumed winner');
END;
CREATE TRIGGER financial_customer_admissions_no_replace BEFORE INSERT ON financial_customer_admissions
WHEN EXISTS(SELECT 1 FROM financial_customer_admissions WHERE admission_ref IS NEW.admission_ref OR challenge_ref IS NEW.challenge_ref OR issuance_attempt IS NEW.issuance_attempt OR expected_receipt_ref IS NEW.expected_receipt_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 row replacement');
END;
CREATE TRIGGER financial_customer_admissions_no_update BEFORE UPDATE ON financial_customer_admissions BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 row immutable');
END;
CREATE TRIGGER financial_customer_admissions_no_delete BEFORE DELETE ON financial_customer_admissions BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 history deletion');
END;
CREATE TRIGGER stripe_customer_admission_links_no_replace BEFORE INSERT ON stripe_customer_admission_links
WHEN EXISTS(SELECT 1 FROM stripe_customer_admission_links WHERE org_id IS NEW.org_id OR admission_ref IS NEW.admission_ref) BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 row replacement');
END;
CREATE TRIGGER stripe_customer_admission_links_no_update BEFORE UPDATE ON stripe_customer_admission_links BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 row immutable');
END;
CREATE TRIGGER stripe_customer_admission_links_no_delete BEFORE DELETE ON stripe_customer_admission_links BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 history deletion');
END;
CREATE TRIGGER financial_customer_admission_receipts_no_replace BEFORE INSERT ON financial_customer_admission_receipts
WHEN EXISTS(SELECT 1 FROM financial_customer_admission_receipts WHERE receipt_ref IS NEW.receipt_ref OR admission_ref IS NEW.admission_ref OR issuance_attempt IS NEW.issuance_attempt) BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 row replacement');
END;
CREATE TRIGGER financial_customer_admission_receipts_no_update BEFORE UPDATE ON financial_customer_admission_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 row immutable');
END;
CREATE TRIGGER financial_customer_admission_receipts_no_delete BEFORE DELETE ON financial_customer_admission_receipts BEGIN
 SELECT RAISE(ABORT,'constraint: retained L1 history deletion');
END;
