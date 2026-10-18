-- PRIVATE unregistered additive Financial leaf: one fixed topup command's two transitions.
-- No Customer H1 branch/table is changed. These rows are mechanical custody, not NEW authority.
CREATE TABLE financial_top_up_admissions (
 admission_ref TEXT PRIMARY KEY NOT NULL,
 org_id TEXT NOT NULL, reference TEXT NOT NULL,
 fingerprint TEXT NOT NULL, command_json TEXT NOT NULL CHECK(json_valid(command_json)),
 stripe_key TEXT NOT NULL, context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB)) BETWEEN 2 AND 2097152),
 customer_custody_ref TEXT NOT NULL REFERENCES financial_customer_custody_receipts(custody_receipt_ref),
 customer_history_receipt_ref TEXT NOT NULL REFERENCES financial_customer_history_receipts(receipt_ref),
 r1_ref TEXT NOT NULL REFERENCES financial_retained_r1_originals(r1_ref),
 r1_receipt_ref TEXT NOT NULL REFERENCES financial_retained_r1_receipts(receipt_ref),
 grant_ref TEXT NOT NULL REFERENCES financial_payer_grants(grant_ref),
 consent_receipt_ref TEXT NOT NULL REFERENCES financial_payer_consent_receipts(receipt_ref),
 acceptance_receipt_ref TEXT NOT NULL UNIQUE, dispatch_receipt_ref TEXT NOT NULL UNIQUE,
 writer_epoch TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(org_id,reference), FOREIGN KEY(org_id,reference) REFERENCES stripe_top_up_commands(org_id,reference),
 CHECK(acceptance_receipt_ref<>dispatch_receipt_ref)
);
CREATE TABLE financial_top_up_history_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, attempt_ref TEXT NOT NULL UNIQUE,
 admission_ref TEXT NOT NULL REFERENCES financial_top_up_admissions(admission_ref),
 phase TEXT NOT NULL CHECK(phase IN('topup-accepted','topup-first-dispatch')),
 previous_receipt_ref TEXT REFERENCES financial_top_up_history_receipts(receipt_ref),
 org_id TEXT NOT NULL, reference TEXT NOT NULL, fingerprint TEXT NOT NULL, stripe_key TEXT NOT NULL,
 command_json TEXT NOT NULL CHECK(json_valid(command_json)), context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB)) BETWEEN 2 AND 2097152),
 dispatched_at TEXT, command_updated_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 UNIQUE(admission_ref,phase), FOREIGN KEY(org_id,reference) REFERENCES stripe_top_up_commands(org_id,reference),
 CHECK((phase='topup-accepted' AND previous_receipt_ref IS NULL AND dispatched_at IS NULL)
 OR (phase='topup-first-dispatch' AND previous_receipt_ref IS NOT NULL AND dispatched_at IS recorded_at))
);
CREATE TRIGGER financial_top_up_admissions_match BEFORE INSERT ON financial_top_up_admissions
WHEN NOT EXISTS(SELECT 1 FROM stripe_top_up_commands k
 JOIN financial_customer_custody_receipts n ON n.custody_receipt_ref=NEW.customer_custody_ref
 JOIN financial_customer_history_receipts h ON h.receipt_ref=NEW.customer_history_receipt_ref
 JOIN stripe_billing_customers b ON b.org_id=k.org_id AND b.customer_id=n.customer_id
 WHERE k.org_id IS NEW.org_id AND k.reference IS NEW.reference AND k.fingerprint IS NEW.fingerprint
 AND k.command_json IS NEW.command_json AND k.stripe_key IS NEW.stripe_key AND k.created_at IS NEW.created_at
 AND k.state='pending' AND k.dispatched_at IS NULL AND n.org_id IS k.org_id AND n.all_rows_match IS 1
 AND h.evidence_kind='customer-verified-binding' AND h.custody_receipt_ref IS n.custody_receipt_ref
 AND h.command_org_id IS k.org_id AND h.all_rows_match IS 1
 AND json_extract(k.command_json,'$.customerId') IS b.customer_id)
BEGIN SELECT RAISE(ABORT,'constraint: original existing Customer topup admission'); END;
CREATE TRIGGER financial_top_up_history_receipts_match BEFORE INSERT ON financial_top_up_history_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_top_up_admissions a
 JOIN stripe_top_up_commands k ON k.org_id=a.org_id AND k.reference=a.reference
 WHERE a.admission_ref IS NEW.admission_ref AND a.org_id IS NEW.org_id AND a.reference IS NEW.reference
 AND a.fingerprint IS NEW.fingerprint AND a.stripe_key IS NEW.stripe_key
 AND a.command_json IS NEW.command_json AND a.context_json IS NEW.context_json
 AND k.fingerprint IS a.fingerprint AND k.command_json IS a.command_json AND k.stripe_key IS a.stripe_key AND k.updated_at IS NEW.command_updated_at
 AND ((NEW.phase='topup-accepted' AND a.acceptance_receipt_ref IS NEW.receipt_ref
 AND k.state='pending' AND k.dispatched_at IS NULL AND NEW.recorded_at IS a.created_at AND NEW.command_updated_at IS a.created_at)
 OR (NEW.phase='topup-first-dispatch' AND a.dispatch_receipt_ref IS NEW.receipt_ref
 AND k.state='pending' AND k.dispatched_at IS NEW.dispatched_at AND k.updated_at IS NEW.command_updated_at
 AND EXISTS(SELECT 1 FROM financial_top_up_history_receipts previous
 WHERE previous.receipt_ref IS NEW.previous_receipt_ref AND previous.receipt_ref IS a.acceptance_receipt_ref
 AND previous.admission_ref IS a.admission_ref AND previous.phase='topup-accepted'
 AND previous.command_json IS NEW.command_json AND previous.context_json IS NEW.context_json
 AND previous.all_rows_match IS 1))))
BEGIN SELECT RAISE(ABORT,'constraint: mandatory typed topup H1 receipt'); END;
CREATE TRIGGER financial_top_up_admissions_no_update BEFORE UPDATE ON financial_top_up_admissions
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed topup custody'); END;
CREATE TRIGGER financial_top_up_admissions_no_delete BEFORE DELETE ON financial_top_up_admissions
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed topup custody'); END;
CREATE TRIGGER financial_top_up_admissions_no_replace BEFORE INSERT ON financial_top_up_admissions
WHEN EXISTS(SELECT 1 FROM financial_top_up_admissions WHERE admission_ref IS NEW.admission_ref OR (org_id IS NEW.org_id AND reference IS NEW.reference) OR acceptance_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.dispatch_receipt_ref) OR dispatch_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.dispatch_receipt_ref))
BEGIN SELECT RAISE(ABORT,'constraint: no typed topup custody replacement'); END;
CREATE TRIGGER financial_top_up_admissions_insert_money_fence BEFORE INSERT ON financial_top_up_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS NEW.writer_epoch)
BEGIN SELECT RAISE(ABORT,'constraint: typed topup permit/epoch required'); END;
CREATE TRIGGER financial_top_up_admissions_update_money_fence BEFORE UPDATE ON financial_top_up_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_top_up_admissions WHERE admission_ref IS NEW.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed topup permit/epoch required'); END;
CREATE TRIGGER financial_top_up_admissions_delete_money_fence BEFORE DELETE ON financial_top_up_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_top_up_admissions WHERE admission_ref IS OLD.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed topup permit/epoch required'); END;
CREATE TRIGGER financial_top_up_history_receipts_no_update BEFORE UPDATE ON financial_top_up_history_receipts
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed topup custody'); END;
CREATE TRIGGER financial_top_up_history_receipts_no_delete BEFORE DELETE ON financial_top_up_history_receipts
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed topup custody'); END;
CREATE TRIGGER financial_top_up_history_receipts_no_replace BEFORE INSERT ON financial_top_up_history_receipts
WHEN EXISTS(SELECT 1 FROM financial_top_up_history_receipts WHERE receipt_ref IS NEW.receipt_ref OR attempt_ref IS NEW.attempt_ref OR (admission_ref IS NEW.admission_ref AND phase IS NEW.phase))
BEGIN SELECT RAISE(ABORT,'constraint: no typed topup custody replacement'); END;
CREATE TRIGGER financial_top_up_history_receipts_insert_money_fence BEFORE INSERT ON financial_top_up_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_top_up_admissions WHERE admission_ref IS NEW.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed topup permit/epoch required'); END;
CREATE TRIGGER financial_top_up_history_receipts_update_money_fence BEFORE UPDATE ON financial_top_up_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_top_up_admissions WHERE admission_ref IS NEW.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed topup permit/epoch required'); END;
CREATE TRIGGER financial_top_up_history_receipts_delete_money_fence BEFORE DELETE ON financial_top_up_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_top_up_admissions WHERE admission_ref IS OLD.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed topup permit/epoch required'); END;
