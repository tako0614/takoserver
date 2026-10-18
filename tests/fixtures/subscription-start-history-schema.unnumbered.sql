-- PRIVATE UNREGISTERED Financial candidate. No numbered migration/Customer H1 table is changed.
-- START's immutable original and its two typed receipts; no NEW/provider permission.
-- Timestamps retain the full Date.toISOString range; predecessor edges, not date ordering, prove causality.
CREATE TABLE financial_subscription_start_admissions (
 admission_ref TEXT PRIMARY KEY NOT NULL,
 intent_id TEXT NOT NULL UNIQUE REFERENCES stripe_subscription_checkout_intents(id),
 org_id TEXT NOT NULL, reference TEXT NOT NULL, request_key_digest TEXT NOT NULL,
 fingerprint TEXT NOT NULL, command_json TEXT NOT NULL CHECK(json_valid(command_json)),
 stripe_key TEXT NOT NULL UNIQUE,
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB)) BETWEEN 2 AND 2097152),
 customer_custody_ref TEXT NOT NULL REFERENCES financial_customer_custody_receipts(custody_receipt_ref),
 customer_history_receipt_ref TEXT NOT NULL REFERENCES financial_customer_history_receipts(receipt_ref),
 r1_ref TEXT NOT NULL REFERENCES financial_retained_r1_originals(r1_ref),
 r1_receipt_ref TEXT NOT NULL REFERENCES financial_retained_r1_receipts(receipt_ref),
 grant_ref TEXT NOT NULL REFERENCES financial_payer_grants(grant_ref),
 consent_receipt_ref TEXT NOT NULL REFERENCES financial_payer_consent_receipts(receipt_ref),
 acceptance_receipt_ref TEXT NOT NULL UNIQUE, dispatch_receipt_ref TEXT NOT NULL UNIQUE,
 writer_epoch TEXT NOT NULL, created_at TEXT NOT NULL, accepted_updated_at TEXT NOT NULL,
 UNIQUE(org_id,reference), UNIQUE(org_id,request_key_digest),
 FOREIGN KEY(org_id,request_key_digest) REFERENCES stripe_subscription_checkout_intents(org_id,request_key_digest),
 CHECK(acceptance_receipt_ref<>dispatch_receipt_ref)
);
CREATE TABLE financial_subscription_start_history_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, attempt_ref TEXT NOT NULL UNIQUE,
 admission_ref TEXT NOT NULL REFERENCES financial_subscription_start_admissions(admission_ref),
 phase TEXT NOT NULL CHECK(phase IN('subscription-start-accepted','subscription-start-first-dispatch')),
 previous_receipt_ref TEXT REFERENCES financial_subscription_start_history_receipts(receipt_ref),
 intent_id TEXT NOT NULL REFERENCES stripe_subscription_checkout_intents(id),
 org_id TEXT NOT NULL, reference TEXT NOT NULL, request_key_digest TEXT NOT NULL,
 fingerprint TEXT NOT NULL, stripe_key TEXT NOT NULL,
 command_json TEXT NOT NULL CHECK(json_valid(command_json)),
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB)) BETWEEN 2 AND 2097152),
 intent_state TEXT NOT NULL CHECK(intent_state IN('prepared','dispatched')),
 command_updated_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 UNIQUE(admission_ref,phase),
 FOREIGN KEY(org_id,request_key_digest) REFERENCES stripe_subscription_checkout_intents(org_id,request_key_digest),
 CHECK((phase='subscription-start-accepted' AND intent_state='prepared' AND previous_receipt_ref IS NULL)
 OR (phase='subscription-start-first-dispatch' AND intent_state='dispatched' AND previous_receipt_ref IS NOT NULL))
);
CREATE TRIGGER financial_subscription_start_admissions_match BEFORE INSERT ON financial_subscription_start_admissions
WHEN NOT EXISTS(
 SELECT 1 FROM stripe_subscription_checkout_intents k
 JOIN financial_customer_custody_receipts n ON n.custody_receipt_ref=NEW.customer_custody_ref
 JOIN financial_customer_history_receipts h ON h.receipt_ref=NEW.customer_history_receipt_ref
 JOIN stripe_billing_customers b ON b.org_id=k.org_id AND b.customer_id=k.customer_id
 WHERE k.id IS NEW.intent_id AND k.org_id IS NEW.org_id AND k.request_key_digest IS NEW.request_key_digest
 AND k.fingerprint IS NEW.fingerprint AND k.created_at IS NEW.created_at AND k.updated_at IS NEW.accepted_updated_at
 AND k.state='prepared' AND k.session_id IS NULL AND k.session_url IS NULL AND k.subscription_id IS NULL
 AND json_extract(NEW.command_json,'$.intentId') IS k.id
 AND json_extract(NEW.command_json,'$.organizationId') IS k.org_id
 AND json_extract(NEW.command_json,'$.reference') IS NEW.reference
 AND json_extract(NEW.command_json,'$.planKey') IS k.plan_key
 AND json_extract(NEW.command_json,'$.pricingRevision') IS k.pricing_revision
 AND json_extract(NEW.command_json,'$.priceId') IS k.price_id
 AND json_extract(NEW.command_json,'$.priceAmountMinor') IS k.price_amount_minor
 AND json_extract(NEW.command_json,'$.includedMinor') IS k.included_minor
 AND json_extract(NEW.command_json,'$.livemode') IS k.livemode
 AND json_extract(NEW.command_json,'$.customerId') IS k.customer_id
 AND NEW.stripe_key IS 'takoserver-subscription-checkout:'||k.id
 AND n.org_id IS k.org_id AND n.customer_id IS k.customer_id AND n.all_rows_match IS 1
 AND h.evidence_kind='customer-verified-binding' AND h.custody_receipt_ref IS n.custody_receipt_ref
 AND h.command_org_id IS k.org_id AND h.all_rows_match IS 1)
BEGIN SELECT RAISE(ABORT,'constraint: original existing Customer START admission'); END;
CREATE TRIGGER financial_subscription_start_history_receipts_match BEFORE INSERT ON financial_subscription_start_history_receipts
WHEN NOT EXISTS(
 SELECT 1 FROM financial_subscription_start_admissions a
 JOIN stripe_subscription_checkout_intents k ON k.id=a.intent_id
 WHERE a.admission_ref IS NEW.admission_ref AND a.intent_id IS NEW.intent_id
 AND a.org_id IS NEW.org_id AND a.reference IS NEW.reference AND a.request_key_digest IS NEW.request_key_digest
 AND a.fingerprint IS NEW.fingerprint AND a.stripe_key IS NEW.stripe_key
 AND a.command_json IS NEW.command_json AND a.context_json IS NEW.context_json
 AND k.org_id IS a.org_id AND k.request_key_digest IS a.request_key_digest AND k.fingerprint IS a.fingerprint
 AND k.updated_at IS NEW.command_updated_at AND k.state IS NEW.intent_state
 AND k.session_id IS NULL AND k.session_url IS NULL AND k.subscription_id IS NULL
 AND ((NEW.phase='subscription-start-accepted' AND NEW.receipt_ref IS a.acceptance_receipt_ref
 AND NEW.recorded_at IS a.accepted_updated_at AND NEW.command_updated_at IS a.accepted_updated_at)
 OR (NEW.phase='subscription-start-first-dispatch' AND NEW.receipt_ref IS a.dispatch_receipt_ref
 AND NEW.recorded_at IS NEW.command_updated_at
 AND EXISTS(SELECT 1 FROM financial_subscription_start_history_receipts previous
 WHERE previous.receipt_ref IS NEW.previous_receipt_ref AND previous.receipt_ref IS a.acceptance_receipt_ref
 AND previous.admission_ref IS a.admission_ref AND previous.intent_id IS a.intent_id
 AND previous.phase='subscription-start-accepted' AND previous.intent_state='prepared'
 AND previous.context_json IS NEW.context_json AND previous.command_json IS NEW.command_json
 AND previous.all_rows_match IS 1))))
BEGIN SELECT RAISE(ABORT,'constraint: mandatory typed START H1 receipt'); END;
CREATE TRIGGER financial_subscription_start_admissions_no_update BEFORE UPDATE ON financial_subscription_start_admissions
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed START custody'); END;
CREATE TRIGGER financial_subscription_start_admissions_no_delete BEFORE DELETE ON financial_subscription_start_admissions
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed START custody'); END;
CREATE TRIGGER financial_subscription_start_admissions_no_replace BEFORE INSERT ON financial_subscription_start_admissions
WHEN EXISTS(SELECT 1 FROM financial_subscription_start_admissions WHERE admission_ref IS NEW.admission_ref OR intent_id IS NEW.intent_id OR (org_id IS NEW.org_id AND (reference IS NEW.reference OR request_key_digest IS NEW.request_key_digest)) OR acceptance_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.dispatch_receipt_ref) OR dispatch_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.dispatch_receipt_ref))
BEGIN SELECT RAISE(ABORT,'constraint: no typed START custody replacement'); END;
CREATE TRIGGER financial_subscription_start_admissions_money_fence BEFORE INSERT ON financial_subscription_start_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(
 SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e
 ON e.singleton=1 AND e.writer_epoch=p.writer_epoch
 WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS NEW.writer_epoch)
BEGIN SELECT RAISE(ABORT,'constraint: typed START permit/epoch required'); END;
CREATE TRIGGER financial_subscription_start_history_receipts_no_update BEFORE UPDATE ON financial_subscription_start_history_receipts
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed START custody'); END;
CREATE TRIGGER financial_subscription_start_history_receipts_no_delete BEFORE DELETE ON financial_subscription_start_history_receipts
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed START custody'); END;
CREATE TRIGGER financial_subscription_start_history_receipts_no_replace BEFORE INSERT ON financial_subscription_start_history_receipts
WHEN EXISTS(SELECT 1 FROM financial_subscription_start_history_receipts WHERE receipt_ref IS NEW.receipt_ref OR attempt_ref IS NEW.attempt_ref OR (admission_ref IS NEW.admission_ref AND phase IS NEW.phase))
BEGIN SELECT RAISE(ABORT,'constraint: no typed START custody replacement'); END;
CREATE TRIGGER financial_subscription_start_history_receipts_money_fence BEFORE INSERT ON financial_subscription_start_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(
 SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e
 ON e.singleton=1 AND e.writer_epoch=p.writer_epoch
 WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_subscription_start_admissions WHERE admission_ref IS NEW.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed START permit/epoch required'); END;
