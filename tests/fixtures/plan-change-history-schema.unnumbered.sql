-- PRIVATE UNNUMBERED additive plan-change leaf. No Customer schema/tag, public command or migration is changed.
CREATE TABLE financial_plan_change_admissions (
 admission_ref TEXT PRIMARY KEY NOT NULL,
 org_id TEXT NOT NULL, reference TEXT NOT NULL, fingerprint TEXT NOT NULL,
 desired_json TEXT NOT NULL CHECK(json_valid(desired_json)), frozen_json TEXT NOT NULL CHECK(json_valid(frozen_json)),
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB)) BETWEEN 2 AND 2097152),
 customer_custody_ref TEXT NOT NULL REFERENCES financial_customer_custody_receipts(custody_receipt_ref),
 customer_history_receipt_ref TEXT NOT NULL REFERENCES financial_customer_history_receipts(receipt_ref),
 r1_ref TEXT NOT NULL REFERENCES financial_retained_r1_originals(r1_ref),
 r1_receipt_ref TEXT NOT NULL REFERENCES financial_retained_r1_receipts(receipt_ref),
 grant_ref TEXT NOT NULL REFERENCES financial_payer_grants(grant_ref),
 consent_receipt_ref TEXT NOT NULL REFERENCES financial_payer_consent_receipts(receipt_ref),
 acceptance_receipt_ref TEXT NOT NULL UNIQUE, create_receipt_ref TEXT NOT NULL UNIQUE, schedule_receipt_ref TEXT NOT NULL UNIQUE,
 writer_epoch TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(org_id,reference), FOREIGN KEY(org_id,reference) REFERENCES stripe_billing_plan_changes(org_id,reference),
 CHECK(acceptance_receipt_ref<>create_receipt_ref AND acceptance_receipt_ref<>schedule_receipt_ref AND create_receipt_ref<>schedule_receipt_ref)
);
CREATE TABLE financial_plan_change_history_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, attempt_ref TEXT NOT NULL UNIQUE,
 admission_ref TEXT NOT NULL REFERENCES financial_plan_change_admissions(admission_ref),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 0 AND 2),
 phase TEXT NOT NULL CHECK(phase IN('plan-accepted','plan-create-dispatched','plan-schedule-dispatched')),
 previous_receipt_ref TEXT REFERENCES financial_plan_change_history_receipts(receipt_ref),
 org_id TEXT NOT NULL, reference TEXT NOT NULL, fingerprint TEXT NOT NULL,
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB)) BETWEEN 2 AND 2097152),
 step_json TEXT NOT NULL CHECK(json_valid(step_json) AND length(CAST(step_json AS BLOB)) BETWEEN 2 AND 2097152),
 recorded_at TEXT NOT NULL, all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 UNIQUE(admission_ref,sequence), UNIQUE(admission_ref,phase),
 FOREIGN KEY(org_id,reference) REFERENCES stripe_billing_plan_changes(org_id,reference),
 CHECK((sequence=0 AND phase='plan-accepted' AND previous_receipt_ref IS NULL)
 OR (sequence=1 AND phase='plan-create-dispatched' AND previous_receipt_ref IS NOT NULL)
 OR (sequence=2 AND phase='plan-schedule-dispatched' AND previous_receipt_ref IS NOT NULL))
);
CREATE TRIGGER financial_plan_change_admissions_match BEFORE INSERT ON financial_plan_change_admissions
WHEN NOT EXISTS(SELECT 1 FROM stripe_billing_plan_changes c
 JOIN stripe_billing_plan_change_slots slot ON slot.org_id=c.org_id AND slot.reference=c.reference
 JOIN financial_customer_custody_receipts n ON n.custody_receipt_ref=NEW.customer_custody_ref
 JOIN financial_customer_history_receipts h ON h.receipt_ref=NEW.customer_history_receipt_ref
 JOIN stripe_billing_customers b ON b.org_id=c.org_id AND b.customer_id=n.customer_id
 WHERE c.org_id IS NEW.org_id AND c.reference IS NEW.reference AND c.fingerprint IS NEW.fingerprint
 AND c.kind='plan-change' AND c.desired_json IS NEW.desired_json AND c.frozen_json IS NEW.frozen_json
 AND c.created_at IS NEW.created_at AND c.state='pending' AND c.receipt_json IS NULL AND slot.generation=1
 AND n.org_id=c.org_id AND n.all_rows_match=1 AND h.evidence_kind='customer-verified-binding'
 AND h.custody_receipt_ref=n.custody_receipt_ref AND h.command_org_id=c.org_id AND h.all_rows_match=1
 AND json_extract(c.frozen_json,'$.target.terms.customerId') IS b.customer_id)
BEGIN SELECT RAISE(ABORT,'constraint: exact existing Customer plan-change admission'); END;
CREATE TRIGGER financial_plan_change_history_receipts_match BEFORE INSERT ON financial_plan_change_history_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_plan_change_admissions a
 JOIN stripe_billing_plan_changes c ON c.org_id=a.org_id AND c.reference=a.reference
 JOIN stripe_billing_plan_change_slots slot ON slot.org_id=c.org_id AND slot.reference=c.reference
 WHERE a.admission_ref IS NEW.admission_ref AND a.org_id IS NEW.org_id AND a.reference IS NEW.reference
 AND a.fingerprint IS NEW.fingerprint AND a.context_json IS NEW.context_json AND c.fingerprint IS a.fingerprint
 AND c.desired_json IS a.desired_json AND c.frozen_json IS a.frozen_json AND c.kind='plan-change'
 AND c.state='pending' AND c.receipt_json IS NULL AND slot.generation=1
 AND ((NEW.phase='plan-accepted' AND NEW.receipt_ref IS a.acceptance_receipt_ref
 AND NEW.recorded_at IS a.created_at AND json_extract(NEW.step_json,'$.name') IS NULL)
 OR (NEW.phase IN('plan-create-dispatched','plan-schedule-dispatched')
 AND NEW.receipt_ref IS CASE WHEN NEW.phase='plan-create-dispatched' THEN a.create_receipt_ref ELSE a.schedule_receipt_ref END
 AND EXISTS(SELECT 1 FROM financial_plan_change_history_receipts previous
  WHERE previous.receipt_ref IS NEW.previous_receipt_ref AND previous.admission_ref IS a.admission_ref
  AND previous.sequence=NEW.sequence-1 AND previous.context_json IS NEW.context_json AND previous.all_rows_match=1
  AND previous.receipt_ref IS CASE WHEN NEW.phase='plan-create-dispatched' THEN a.acceptance_receipt_ref ELSE a.create_receipt_ref END)
 AND EXISTS(SELECT 1 FROM stripe_billing_plan_change_steps step WHERE step.org_id=c.org_id AND step.reference=c.reference
  AND step.step IS CASE WHEN NEW.phase='plan-create-dispatched' THEN 'create' ELSE 'schedule' END
  AND step.state='dispatched' AND step.request_json IS json_extract(NEW.step_json,'$.form')
  AND step.idempotency_key IS json_extract(NEW.step_json,'$.key')
  AND step.created_at IS json_extract(NEW.step_json,'$.clock.createdAt')
  AND step.dispatched_at IS NEW.recorded_at AND NEW.recorded_at IS json_extract(NEW.step_json,'$.clock.dispatchedAt')))))
BEGIN SELECT RAISE(ABORT,'constraint: mandatory typed plan-change H1 receipt'); END;
CREATE TRIGGER financial_plan_change_admissions_no_update BEFORE UPDATE ON financial_plan_change_admissions
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed plan-change custody'); END;
CREATE TRIGGER financial_plan_change_admissions_no_delete BEFORE DELETE ON financial_plan_change_admissions
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed plan-change custody'); END;
CREATE TRIGGER financial_plan_change_admissions_no_replace BEFORE INSERT ON financial_plan_change_admissions
WHEN EXISTS(SELECT 1 FROM financial_plan_change_admissions WHERE admission_ref IS NEW.admission_ref OR (org_id IS NEW.org_id AND reference IS NEW.reference) OR acceptance_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.create_receipt_ref,NEW.schedule_receipt_ref) OR create_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.create_receipt_ref,NEW.schedule_receipt_ref) OR schedule_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.create_receipt_ref,NEW.schedule_receipt_ref))
BEGIN SELECT RAISE(ABORT,'constraint: no typed plan-change replacement'); END;
CREATE TRIGGER financial_plan_change_admissions_insert_money_fence BEFORE INSERT ON financial_plan_change_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS NEW.writer_epoch)
BEGIN SELECT RAISE(ABORT,'constraint: typed plan-change permit/epoch required'); END;
CREATE TRIGGER financial_plan_change_admissions_update_money_fence BEFORE UPDATE ON financial_plan_change_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS NEW.writer_epoch)
BEGIN SELECT RAISE(ABORT,'constraint: typed plan-change permit/epoch required'); END;
CREATE TRIGGER financial_plan_change_admissions_delete_money_fence BEFORE DELETE ON financial_plan_change_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS OLD.writer_epoch)
BEGIN SELECT RAISE(ABORT,'constraint: typed plan-change permit/epoch required'); END;
CREATE TRIGGER financial_plan_change_history_receipts_no_update BEFORE UPDATE ON financial_plan_change_history_receipts
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed plan-change custody'); END;
CREATE TRIGGER financial_plan_change_history_receipts_no_delete BEFORE DELETE ON financial_plan_change_history_receipts
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed plan-change custody'); END;
CREATE TRIGGER financial_plan_change_history_receipts_no_replace BEFORE INSERT ON financial_plan_change_history_receipts
WHEN EXISTS(SELECT 1 FROM financial_plan_change_history_receipts WHERE receipt_ref IS NEW.receipt_ref OR attempt_ref IS NEW.attempt_ref OR (admission_ref IS NEW.admission_ref AND (phase IS NEW.phase OR sequence IS NEW.sequence)))
BEGIN SELECT RAISE(ABORT,'constraint: no typed plan-change replacement'); END;
CREATE TRIGGER financial_plan_change_history_receipts_insert_money_fence BEFORE INSERT ON financial_plan_change_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_plan_change_admissions WHERE admission_ref IS NEW.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed plan-change permit/epoch required'); END;
CREATE TRIGGER financial_plan_change_history_receipts_update_money_fence BEFORE UPDATE ON financial_plan_change_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_plan_change_admissions WHERE admission_ref IS NEW.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed plan-change permit/epoch required'); END;
CREATE TRIGGER financial_plan_change_history_receipts_delete_money_fence BEFORE DELETE ON financial_plan_change_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_plan_change_admissions WHERE admission_ref IS OLD.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed plan-change permit/epoch required'); END;
