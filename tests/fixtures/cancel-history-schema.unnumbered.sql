-- PRIVATE unnumbered additive cancel DATA leaf; not registered Financial104 or live authority.
-- Native cancellation and pending schedule release keep distinct parents, keys and H1 receipts.
CREATE TABLE financial_cancel_admissions (
 admission_ref TEXT PRIMARY KEY NOT NULL,
 org_id TEXT NOT NULL, reference TEXT NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN('native','pending-release')),
 branch TEXT NOT NULL CHECK(branch IN('legacy','pending-plan-change')),
 original_json TEXT NOT NULL CHECK(json_valid(original_json)),
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB)) BETWEEN 2 AND 2097152),
 r1_json TEXT NOT NULL CHECK(json_valid(r1_json)), fingerprint TEXT NOT NULL, stripe_key TEXT NOT NULL, request_key_digest TEXT NOT NULL,
 desired_json TEXT CHECK(desired_json IS NULL OR json_valid(desired_json)),
 frozen_json TEXT CHECK(frozen_json IS NULL OR json_valid(frozen_json)),
 native_intent_id TEXT UNIQUE REFERENCES stripe_subscription_cancellation_intents(id),
 plan_org_id TEXT, plan_reference TEXT,
 customer_custody_ref TEXT NOT NULL REFERENCES financial_customer_custody_receipts(custody_receipt_ref),
 customer_history_receipt_ref TEXT NOT NULL REFERENCES financial_customer_history_receipts(receipt_ref),
 r1_ref TEXT NOT NULL REFERENCES financial_retained_r1_originals(r1_ref),
 r1_receipt_ref TEXT NOT NULL REFERENCES financial_retained_r1_receipts(receipt_ref),
 grant_ref TEXT NOT NULL REFERENCES financial_payer_grants(grant_ref),
 consent_receipt_ref TEXT NOT NULL REFERENCES financial_payer_consent_receipts(receipt_ref),
 acceptance_receipt_ref TEXT NOT NULL UNIQUE, preparation_receipt_ref TEXT UNIQUE, dispatch_receipt_ref TEXT NOT NULL UNIQUE,
 parent_release_ref TEXT REFERENCES financial_cancel_admissions(admission_ref),
 parent_release_receipt_ref TEXT REFERENCES financial_cancel_history_receipts(receipt_ref),
 writer_epoch TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(org_id,reference,stage), FOREIGN KEY(plan_org_id,plan_reference) REFERENCES stripe_billing_plan_changes(org_id,reference),
 CHECK(acceptance_receipt_ref<>dispatch_receipt_ref AND (preparation_receipt_ref IS NULL OR (preparation_receipt_ref<>acceptance_receipt_ref AND preparation_receipt_ref<>dispatch_receipt_ref))),
 CHECK((stage='native' AND native_intent_id IS NOT NULL AND plan_org_id IS NULL AND plan_reference IS NULL AND preparation_receipt_ref IS NULL AND desired_json IS NULL AND frozen_json IS NULL)
 OR (stage='pending-release' AND branch='pending-plan-change' AND native_intent_id IS NULL AND plan_org_id IS org_id AND plan_reference IS reference AND preparation_receipt_ref IS NOT NULL AND desired_json IS NOT NULL AND frozen_json IS NOT NULL)),
 CHECK((stage='pending-release' AND parent_release_ref IS NULL AND parent_release_receipt_ref IS NULL)
 OR (stage='native' AND ((branch='legacy' AND parent_release_ref IS NULL AND parent_release_receipt_ref IS NULL)
 OR (branch='pending-plan-change' AND parent_release_ref IS NOT NULL AND parent_release_receipt_ref IS NOT NULL))))
);
CREATE TABLE financial_cancel_history_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, attempt_ref TEXT NOT NULL UNIQUE,
 admission_ref TEXT NOT NULL REFERENCES financial_cancel_admissions(admission_ref),
 phase TEXT NOT NULL CHECK(phase IN('cancel-native-accepted','cancel-native-first-dispatch','cancel-release-accepted','cancel-release-step-prepared','cancel-release-first-dispatch')),
 previous_receipt_ref TEXT REFERENCES financial_cancel_history_receipts(receipt_ref),
 org_id TEXT NOT NULL, reference TEXT NOT NULL, original_json TEXT NOT NULL CHECK(json_valid(original_json)),
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB)) BETWEEN 2 AND 2097152),
 fingerprint TEXT NOT NULL, stripe_key TEXT NOT NULL, recorded_at TEXT NOT NULL, command_updated_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 UNIQUE(admission_ref,phase),
 CHECK((phase IN('cancel-native-accepted','cancel-release-accepted') AND previous_receipt_ref IS NULL)
 OR (phase IN('cancel-native-first-dispatch','cancel-release-step-prepared','cancel-release-first-dispatch') AND previous_receipt_ref IS NOT NULL))
);
CREATE TRIGGER financial_cancel_admission_match BEFORE INSERT ON financial_cancel_admissions
WHEN NOT EXISTS(SELECT 1 FROM financial_customer_custody_receipts n
 JOIN financial_customer_history_receipts h ON h.custody_receipt_ref=n.custody_receipt_ref
 JOIN stripe_billing_customers b ON b.org_id=n.org_id AND b.customer_id=n.customer_id
 JOIN financial_retained_r1_originals r ON r.r1_ref=NEW.r1_ref AND r.command_json=NEW.r1_json
 JOIN financial_retained_r1_receipts rr ON rr.r1_ref=r.r1_ref AND rr.receipt_ref=NEW.r1_receipt_ref AND rr.command_json=r.command_json AND rr.all_rows_match=1
 JOIN financial_payer_grants g ON g.grant_ref=NEW.grant_ref AND g.challenge_ref=r.challenge_ref
 JOIN financial_payer_consent_receipts cr ON cr.receipt_ref=NEW.consent_receipt_ref AND cr.grant_ref=g.grant_ref AND cr.all_rows_match=1
 WHERE n.custody_receipt_ref IS NEW.customer_custody_ref AND n.org_id IS NEW.org_id AND n.all_rows_match IS 1
 AND h.receipt_ref IS NEW.customer_history_receipt_ref AND h.evidence_kind='customer-verified-binding' AND h.all_rows_match IS 1
 AND NEW.original_json IS json_extract(NEW.context_json,'$.original')
 AND json_extract(NEW.context_json,'$.input.organizationId') IS NEW.org_id AND json_extract(NEW.context_json,'$.input.reference') IS NEW.reference
 AND ((NEW.stage='native' AND EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents k
 WHERE k.id IS NEW.native_intent_id AND k.org_id IS NEW.org_id AND k.customer_id IS n.customer_id AND k.state='prepared'
 AND k.fingerprint IS NEW.fingerprint AND k.request_key_digest IS NEW.request_key_digest AND NEW.stripe_key IS 'takoserver-subscription-cancel:'||k.id
 AND k.created_at IS NEW.created_at AND k.subscription_id IS json_extract(NEW.original_json,'$.association.subscriptionId')
 AND k.customer_id IS json_extract(NEW.original_json,'$.association.customerId') AND k.plan_key IS json_extract(NEW.original_json,'$.association.planKey')
 AND k.pricing_revision IS json_extract(NEW.original_json,'$.association.pricingRevision') AND k.price_id IS json_extract(NEW.original_json,'$.association.priceId')
 AND k.price_amount_minor IS json_extract(NEW.original_json,'$.association.priceAmountMinor') AND k.included_minor IS json_extract(NEW.original_json,'$.association.includedMinor')
 AND k.pre_period_end IS json_extract(NEW.original_json,'$.prePeriodEnd') AND k.updated_at IS json_extract(NEW.original_json,'$.updatedAt')))
 OR (NEW.stage='pending-release' AND EXISTS(SELECT 1 FROM stripe_billing_plan_changes c JOIN stripe_billing_plan_change_slots slot ON slot.org_id=c.org_id AND slot.reference=c.reference
 WHERE c.org_id IS NEW.org_id AND c.reference IS NEW.reference AND c.kind='cancel' AND c.state='pending'
 AND json_extract(c.frozen_json,'$.custodyRequestKeyDigest') IS NEW.request_key_digest AND c.fingerprint IS NEW.fingerprint AND c.desired_json IS NEW.desired_json AND c.frozen_json IS NEW.frozen_json AND c.created_at IS NEW.created_at
 AND c.subscription_id IS json_extract(NEW.original_json,'$.target.terms.subscriptionId') AND c.expected_generation IS json_extract(NEW.original_json,'$.target.generation')
 AND slot.generation=json_extract(NEW.original_json,'$.previousSlotGeneration')+1))))
BEGIN SELECT RAISE(ABORT,'constraint: original existing Customer cancel admission'); END;
CREATE TRIGGER financial_cancel_history_match BEFORE INSERT ON financial_cancel_history_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_cancel_admissions a
 WHERE a.admission_ref IS NEW.admission_ref AND a.org_id IS NEW.org_id AND a.reference IS NEW.reference
 AND a.context_json IS NEW.context_json AND a.original_json IS NEW.original_json AND a.fingerprint IS NEW.fingerprint AND a.stripe_key IS NEW.stripe_key
 AND ((NEW.phase='cancel-native-accepted' AND a.stage='native' AND a.acceptance_receipt_ref IS NEW.receipt_ref AND NEW.attempt_ref IS json_extract(a.context_json,'$.acceptanceAttemptRef')
 AND NEW.recorded_at IS a.created_at AND EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents k WHERE k.id=a.native_intent_id AND k.state='prepared' AND k.updated_at IS NEW.command_updated_at))
 OR (NEW.phase='cancel-native-first-dispatch' AND a.stage='native' AND a.dispatch_receipt_ref IS NEW.receipt_ref AND NEW.attempt_ref IS json_extract(a.context_json,'$.dispatchAttemptRef')
 AND NEW.recorded_at IS NEW.command_updated_at AND EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents k WHERE k.id=a.native_intent_id AND k.state='dispatched' AND k.updated_at IS NEW.recorded_at)
 AND EXISTS(SELECT 1 FROM financial_cancel_history_receipts previous WHERE previous.receipt_ref IS NEW.previous_receipt_ref AND previous.receipt_ref IS a.acceptance_receipt_ref AND previous.admission_ref=a.admission_ref AND previous.phase='cancel-native-accepted' AND previous.context_json=a.context_json AND previous.all_rows_match=1))
 OR (NEW.phase='cancel-release-accepted' AND a.stage='pending-release' AND a.acceptance_receipt_ref IS NEW.receipt_ref AND NEW.attempt_ref IS json_extract(a.context_json,'$.acceptanceAttemptRef')
 AND NEW.recorded_at IS a.created_at AND NEW.command_updated_at IS a.created_at AND EXISTS(SELECT 1 FROM stripe_billing_plan_changes c WHERE c.org_id=a.org_id AND c.reference=a.reference AND c.kind='cancel' AND c.created_at IS NEW.recorded_at))
 OR (NEW.phase='cancel-release-step-prepared' AND a.stage='pending-release' AND a.preparation_receipt_ref IS NEW.receipt_ref AND NEW.attempt_ref IS json_extract(a.context_json,'$.preparationAttemptRef')
 AND NEW.recorded_at IS NEW.command_updated_at AND EXISTS(SELECT 1 FROM stripe_billing_plan_change_steps step WHERE step.org_id=a.org_id AND step.reference=a.reference AND step.step='release' AND step.state='prepared' AND step.idempotency_key=a.stripe_key AND step.request_json='{"preserve_cancel_date":"true"}' AND step.created_at IS NEW.recorded_at)
 AND EXISTS(SELECT 1 FROM financial_cancel_history_receipts previous WHERE previous.receipt_ref IS NEW.previous_receipt_ref AND previous.receipt_ref IS a.acceptance_receipt_ref AND previous.admission_ref=a.admission_ref AND previous.phase='cancel-release-accepted' AND previous.context_json=a.context_json AND previous.all_rows_match=1))
 OR (NEW.phase='cancel-release-first-dispatch' AND a.stage='pending-release' AND a.dispatch_receipt_ref IS NEW.receipt_ref AND NEW.attempt_ref IS json_extract(a.context_json,'$.dispatchAttemptRef')
 AND NEW.recorded_at IS NEW.command_updated_at AND EXISTS(SELECT 1 FROM stripe_billing_plan_change_steps step WHERE step.org_id=a.org_id AND step.reference=a.reference AND step.step='release' AND step.state='dispatched' AND step.idempotency_key=a.stripe_key AND step.request_json='{"preserve_cancel_date":"true"}' AND step.dispatched_at IS NEW.recorded_at)
 AND EXISTS(SELECT 1 FROM financial_cancel_history_receipts previous WHERE previous.receipt_ref IS NEW.previous_receipt_ref AND previous.receipt_ref IS a.preparation_receipt_ref AND previous.admission_ref=a.admission_ref AND previous.phase='cancel-release-step-prepared' AND previous.context_json=a.context_json AND previous.all_rows_match=1))))
BEGIN SELECT RAISE(ABORT,'constraint: mandatory typed cancel H1 receipt'); END;
CREATE TRIGGER financial_cancel_admissions_no_update BEFORE UPDATE ON financial_cancel_admissions
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed cancel custody'); END;
CREATE TRIGGER financial_cancel_admissions_no_delete BEFORE DELETE ON financial_cancel_admissions
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed cancel custody'); END;
CREATE TRIGGER financial_cancel_history_receipts_no_update BEFORE UPDATE ON financial_cancel_history_receipts
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed cancel custody'); END;
CREATE TRIGGER financial_cancel_history_receipts_no_delete BEFORE DELETE ON financial_cancel_history_receipts
BEGIN SELECT RAISE(ABORT,'constraint: immutable typed cancel custody'); END;
CREATE TRIGGER financial_cancel_admissions_no_replace BEFORE INSERT ON financial_cancel_admissions
WHEN EXISTS(SELECT 1 FROM financial_cancel_admissions WHERE admission_ref IS NEW.admission_ref OR (org_id IS NEW.org_id AND reference IS NEW.reference AND stage IS NEW.stage)
 OR (NEW.native_intent_id IS NOT NULL AND native_intent_id IS NEW.native_intent_id)
 OR acceptance_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.preparation_receipt_ref,NEW.dispatch_receipt_ref)
 OR preparation_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.preparation_receipt_ref,NEW.dispatch_receipt_ref)
 OR dispatch_receipt_ref IN(NEW.acceptance_receipt_ref,NEW.preparation_receipt_ref,NEW.dispatch_receipt_ref))
BEGIN SELECT RAISE(ABORT,'constraint: no typed cancel admission replacement'); END;
CREATE TRIGGER financial_cancel_history_no_replace BEFORE INSERT ON financial_cancel_history_receipts
WHEN EXISTS(SELECT 1 FROM financial_cancel_history_receipts WHERE receipt_ref IS NEW.receipt_ref OR attempt_ref IS NEW.attempt_ref OR (admission_ref IS NEW.admission_ref AND phase IS NEW.phase))
BEGIN SELECT RAISE(ABORT,'constraint: no typed cancel history replacement'); END;
CREATE TRIGGER financial_cancel_admissions_insert_money_fence BEFORE INSERT ON financial_cancel_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS NEW.writer_epoch)
BEGIN SELECT RAISE(ABORT,'constraint: typed cancel permit/epoch required'); END;
CREATE TRIGGER financial_cancel_admissions_update_money_fence BEFORE UPDATE ON financial_cancel_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS NEW.writer_epoch)
BEGIN SELECT RAISE(ABORT,'constraint: typed cancel permit/epoch required'); END;
CREATE TRIGGER financial_cancel_admissions_delete_money_fence BEFORE DELETE ON financial_cancel_admissions
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS OLD.writer_epoch)
BEGIN SELECT RAISE(ABORT,'constraint: typed cancel permit/epoch required'); END;
CREATE TRIGGER financial_cancel_history_receipts_insert_money_fence BEFORE INSERT ON financial_cancel_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_cancel_admissions WHERE admission_ref IS NEW.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed cancel permit/epoch required'); END;
CREATE TRIGGER financial_cancel_history_receipts_update_money_fence BEFORE UPDATE ON financial_cancel_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_cancel_admissions WHERE admission_ref IS NEW.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed cancel permit/epoch required'); END;
CREATE TRIGGER financial_cancel_history_receipts_delete_money_fence BEFORE DELETE ON financial_cancel_history_receipts
WHEN EXISTS(SELECT 1 FROM money_cutover_freeze) OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p JOIN money_cutover_authorized_epoch e ON e.singleton=1 AND e.writer_epoch=p.writer_epoch WHERE p.singleton=1 AND p.epoch='usd-micros-v2' AND p.writer_epoch IS (SELECT writer_epoch FROM financial_cancel_admissions WHERE admission_ref IS OLD.admission_ref))
BEGIN SELECT RAISE(ABORT,'constraint: typed cancel permit/epoch required'); END;
