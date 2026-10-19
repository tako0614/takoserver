-- PRIVATE UNNUMBERED mechanical H1 + D/N candidate only; no issuer/native authority.
-- Existing H0 v2, B v1 and registered 0096-0100 remain exact independent prerequisites.
CREATE TABLE financial_customer_history_coverages (
 history_ref TEXT PRIMARY KEY NOT NULL, coverage_incarnation TEXT NOT NULL UNIQUE,
 attempt_ref TEXT NOT NULL UNIQUE, expected_receipt_ref TEXT NOT NULL UNIQUE,
 coverage_kind TEXT NOT NULL CHECK(coverage_kind='qualified-genesis'),
 original_org_origin TEXT NOT NULL REFERENCES financial_customer_history_birth_observations(birth_ref),
 organization_id TEXT NOT NULL, primary_ref TEXT NOT NULL, enrollment_ref TEXT NOT NULL,
 complete_seal_ref TEXT NOT NULL, seal_kind TEXT NOT NULL CHECK(seal_kind='complete-seal'),
 realm_registration TEXT NOT NULL, realm_incarnation TEXT NOT NULL,
 realm_json TEXT NOT NULL CHECK(json_valid(realm_json) AND json_type(realm_json)='object'),
 required_scopes_json TEXT NOT NULL CHECK(json_valid(required_scopes_json) AND json_type(required_scopes_json)='array' AND json_array_length(required_scopes_json) BETWEEN 1 AND 64),
 writer_epoch TEXT NOT NULL, previous_history_ref TEXT REFERENCES financial_customer_history_coverages(history_ref),
 created_at TEXT NOT NULL,
 FOREIGN KEY(complete_seal_ref,primary_ref,enrollment_ref,seal_kind) REFERENCES financial_history_enrollment_receipts(receipt_ref,primary_ref,enrollment_ref,receipt_kind),
 CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 CHECK(previous_history_ref IS NULL),
 UNIQUE(original_org_origin,realm_registration,realm_incarnation)
);
CREATE TABLE financial_customer_history_scopes (
 scope_ref TEXT PRIMARY KEY NOT NULL, history_ref TEXT NOT NULL REFERENCES financial_customer_history_coverages(history_ref),
 inventory_ref TEXT NOT NULL REFERENCES financial_history_enrollment_inventory(inventory_ref),
 scope_kind TEXT NOT NULL, original_scope_ref TEXT NOT NULL, original_scope_incarnation TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
 UNIQUE(history_ref,inventory_ref), UNIQUE(history_ref,scope_kind,original_scope_ref,original_scope_incarnation)
);
CREATE TABLE financial_customer_dispatch_claims (
 claim_ref TEXT PRIMARY KEY NOT NULL, attempt_ref TEXT NOT NULL UNIQUE,
 admission_ref TEXT NOT NULL UNIQUE REFERENCES financial_customer_admissions(admission_ref),
 org_id TEXT NOT NULL UNIQUE REFERENCES stripe_billing_customer_commands(org_id),
 l1_receipt_ref TEXT NOT NULL REFERENCES financial_customer_admission_receipts(receipt_ref),
 expected_dispatch_receipt_ref TEXT NOT NULL UNIQUE, context_json TEXT NOT NULL,
 history_ref TEXT NOT NULL REFERENCES financial_customer_history_coverages(history_ref), coverage_incarnation TEXT NOT NULL,
 pre_journal_sequence INTEGER NOT NULL CHECK(typeof(pre_journal_sequence)='integer' AND pre_journal_sequence BETWEEN 0 AND 9007199254740990),
 pre_history_receipt_ref TEXT NOT NULL REFERENCES financial_customer_history_receipts(receipt_ref),
 created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)
);
CREATE TABLE financial_customer_dispatch_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, claim_ref TEXT NOT NULL UNIQUE REFERENCES financial_customer_dispatch_claims(claim_ref),
 attempt_ref TEXT NOT NULL UNIQUE, admission_ref TEXT NOT NULL REFERENCES financial_customer_admissions(admission_ref),
 org_id TEXT NOT NULL REFERENCES stripe_billing_customer_commands(org_id), dispatched_at TEXT NOT NULL, created_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1)
);
CREATE TABLE financial_customer_custody_receipts (
 custody_receipt_ref TEXT PRIMARY KEY NOT NULL,
 dispatch_receipt_ref TEXT NOT NULL UNIQUE REFERENCES financial_customer_dispatch_receipts(receipt_ref),
 org_id TEXT NOT NULL REFERENCES stripe_billing_customers(org_id), customer_id TEXT NOT NULL REFERENCES stripe_billing_customers(customer_id),
 binding_created_at TEXT NOT NULL, verified_at TEXT NOT NULL, created_at TEXT NOT NULL,
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1)
);
CREATE TABLE financial_customer_history_entries (
 entry_ref TEXT PRIMARY KEY NOT NULL, history_ref TEXT NOT NULL REFERENCES financial_customer_history_coverages(history_ref),
 journal_sequence INTEGER NOT NULL CHECK(typeof(journal_sequence)='integer' AND journal_sequence BETWEEN 0 AND 9007199254740991),
 ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal=0),
 writer_kind TEXT NOT NULL CHECK(writer_kind='customer-custody'),
 evidence_kind TEXT NOT NULL CHECK(evidence_kind IN('genesis','customer-prepared','customer-first-dispatch','customer-verified-binding')),
 original_command_key TEXT, transition_ref TEXT NOT NULL,
 coupling_attempt_ref TEXT NOT NULL UNIQUE, expected_history_receipt_ref TEXT NOT NULL UNIQUE,
 previous_history_receipt_ref TEXT REFERENCES financial_customer_history_receipts(receipt_ref),
 command_org_id TEXT REFERENCES stripe_billing_customer_commands(org_id),
 admission_ref TEXT REFERENCES financial_customer_admissions(admission_ref),
 creation_link_org_id TEXT REFERENCES stripe_customer_admission_links(org_id),
 l1_receipt_ref TEXT REFERENCES financial_customer_admission_receipts(receipt_ref),
 dispatch_claim_ref TEXT REFERENCES financial_customer_dispatch_claims(claim_ref),
 dispatch_receipt_ref TEXT REFERENCES financial_customer_dispatch_receipts(receipt_ref),
 custody_receipt_ref TEXT REFERENCES financial_customer_custody_receipts(custody_receipt_ref),
 binding_org_id TEXT REFERENCES stripe_billing_customers(org_id), binding_customer_id TEXT REFERENCES stripe_billing_customers(customer_id),
 command_before_exists INTEGER NOT NULL CHECK(command_before_exists IN(0,1)), command_before_state TEXT,
 command_before_dispatched_at TEXT, command_before_customer_id TEXT, command_before_verified_at TEXT,
 command_after_state TEXT, command_after_dispatched_at TEXT, command_after_customer_id TEXT, command_after_verified_at TEXT,
 binding_before_exists INTEGER NOT NULL CHECK(binding_before_exists=0), binding_before_customer_id TEXT, binding_before_created_at TEXT,
 binding_after_exists INTEGER NOT NULL CHECK(binding_after_exists IN(0,1)), binding_after_customer_id TEXT, binding_after_created_at TEXT,
 recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS recorded_at),
 UNIQUE(history_ref,journal_sequence,ordinal), UNIQUE(history_ref,writer_kind,original_command_key,transition_ref),
 CHECK(binding_before_customer_id IS NULL AND binding_before_created_at IS NULL AND command_before_customer_id IS NULL AND command_before_verified_at IS NULL),
 CHECK((evidence_kind='genesis' AND journal_sequence=0 AND previous_history_receipt_ref IS NULL AND original_command_key IS NULL
  AND command_org_id IS NULL AND admission_ref IS NULL AND creation_link_org_id IS NULL AND l1_receipt_ref IS NULL
  AND dispatch_claim_ref IS NULL AND dispatch_receipt_ref IS NULL AND custody_receipt_ref IS NULL AND binding_org_id IS NULL AND binding_customer_id IS NULL
  AND command_before_exists=0 AND command_before_state IS NULL AND command_before_dispatched_at IS NULL
  AND command_after_state IS NULL AND command_after_dispatched_at IS NULL AND command_after_customer_id IS NULL AND command_after_verified_at IS NULL
  AND binding_after_exists=0 AND binding_after_customer_id IS NULL AND binding_after_created_at IS NULL)
 OR (evidence_kind<>'genesis' AND journal_sequence>0 AND previous_history_receipt_ref IS NOT NULL AND original_command_key IS NOT NULL
  AND command_org_id IS NOT NULL AND admission_ref IS NOT NULL AND creation_link_org_id IS NOT NULL AND l1_receipt_ref IS NOT NULL
  AND ((evidence_kind='customer-prepared' AND transition_ref IS l1_receipt_ref AND command_before_exists=0 AND command_before_state IS NULL
    AND command_before_dispatched_at IS NULL AND command_after_state='prepared' AND command_after_dispatched_at IS NULL
    AND command_after_customer_id IS NULL AND command_after_verified_at IS NULL
    AND dispatch_claim_ref IS NULL AND dispatch_receipt_ref IS NULL AND custody_receipt_ref IS NULL AND binding_org_id IS NULL AND binding_customer_id IS NULL
    AND binding_after_exists=0 AND binding_after_customer_id IS NULL AND binding_after_created_at IS NULL)
   OR (evidence_kind='customer-first-dispatch' AND transition_ref IS dispatch_receipt_ref AND command_before_exists=1 AND command_before_state='prepared'
    AND command_before_dispatched_at IS NULL AND command_after_state='dispatched' AND command_after_dispatched_at IS NOT NULL
    AND command_after_customer_id IS NULL AND command_after_verified_at IS NULL
    AND dispatch_claim_ref IS NOT NULL AND dispatch_receipt_ref IS NOT NULL AND custody_receipt_ref IS NULL AND binding_org_id IS NULL AND binding_customer_id IS NULL
    AND binding_after_exists=0 AND binding_after_customer_id IS NULL AND binding_after_created_at IS NULL)
   OR (evidence_kind='customer-verified-binding' AND transition_ref IS custody_receipt_ref AND command_before_exists=1 AND command_before_state='dispatched'
    AND command_before_dispatched_at IS NOT NULL AND command_after_state='verified' AND command_after_dispatched_at IS command_before_dispatched_at
    AND command_after_customer_id IS NOT NULL AND command_after_verified_at IS NOT NULL
    AND dispatch_claim_ref IS NOT NULL AND dispatch_receipt_ref IS NOT NULL AND custody_receipt_ref IS NOT NULL AND binding_org_id IS command_org_id
    AND binding_customer_id IS command_after_customer_id AND binding_after_exists=1
    AND binding_after_customer_id IS command_after_customer_id AND binding_after_created_at IS command_after_verified_at))))
);
CREATE UNIQUE INDEX financial_customer_history_prepared_once ON financial_customer_history_entries(l1_receipt_ref) WHERE evidence_kind='customer-prepared';
CREATE UNIQUE INDEX financial_customer_history_dispatched_once ON financial_customer_history_entries(dispatch_receipt_ref) WHERE evidence_kind='customer-first-dispatch';
CREATE UNIQUE INDEX financial_customer_history_verified_once ON financial_customer_history_entries(custody_receipt_ref) WHERE evidence_kind='customer-verified-binding';
CREATE TABLE financial_customer_history_heads (
 original_org_origin TEXT NOT NULL REFERENCES financial_customer_history_birth_observations(birth_ref),
 realm_registration TEXT NOT NULL, realm_incarnation TEXT NOT NULL,
 history_ref TEXT NOT NULL REFERENCES financial_customer_history_coverages(history_ref),
 journal_sequence INTEGER NOT NULL CHECK(typeof(journal_sequence)='integer' AND journal_sequence BETWEEN 0 AND 9007199254740991),
 last_entry_ref TEXT NOT NULL REFERENCES financial_customer_history_entries(entry_ref), last_expected_receipt_ref TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('active','closed')),
 PRIMARY KEY(original_org_origin,realm_registration,realm_incarnation)
);
CREATE TABLE financial_customer_history_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, attempt_ref TEXT NOT NULL UNIQUE,
 history_ref TEXT NOT NULL REFERENCES financial_customer_history_coverages(history_ref),
 journal_sequence INTEGER NOT NULL CHECK(typeof(journal_sequence)='integer' AND journal_sequence BETWEEN 0 AND 9007199254740991),
 original_org_origin TEXT NOT NULL, realm_registration TEXT NOT NULL, realm_incarnation TEXT NOT NULL,
 previous_journal_sequence INTEGER, previous_entry_ref TEXT REFERENCES financial_customer_history_entries(entry_ref),
 previous_history_receipt_ref TEXT REFERENCES financial_customer_history_receipts(receipt_ref),
 entry_ref TEXT NOT NULL REFERENCES financial_customer_history_entries(entry_ref),
 evidence_kind TEXT NOT NULL, command_org_id TEXT REFERENCES stripe_billing_customer_commands(org_id),
 l1_receipt_ref TEXT REFERENCES financial_customer_admission_receipts(receipt_ref),
 dispatch_receipt_ref TEXT REFERENCES financial_customer_dispatch_receipts(receipt_ref),
 custody_receipt_ref TEXT REFERENCES financial_customer_custody_receipts(custody_receipt_ref),
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1), created_at TEXT NOT NULL,
 FOREIGN KEY(original_org_origin,realm_registration,realm_incarnation) REFERENCES financial_customer_history_heads(original_org_origin,realm_registration,realm_incarnation),
 UNIQUE(history_ref,journal_sequence), UNIQUE(entry_ref),
 CHECK((journal_sequence=0 AND previous_journal_sequence IS NULL AND previous_entry_ref IS NULL AND previous_history_receipt_ref IS NULL AND evidence_kind='genesis')
 OR (journal_sequence>0 AND typeof(previous_journal_sequence)='integer' AND previous_journal_sequence=journal_sequence-1 AND previous_entry_ref IS NOT NULL AND previous_history_receipt_ref IS NOT NULL AND evidence_kind IN('customer-prepared','customer-first-dispatch','customer-verified-binding')))
);
CREATE TRIGGER financial_customer_history_coverages_no_replace BEFORE INSERT ON financial_customer_history_coverages WHEN EXISTS(SELECT 1 FROM financial_customer_history_coverages WHERE (history_ref IS NEW.history_ref) OR (coverage_incarnation IS NEW.coverage_incarnation) OR (attempt_ref IS NEW.attempt_ref) OR (expected_receipt_ref IS NEW.expected_receipt_ref) OR (original_org_origin IS NEW.original_org_origin AND realm_registration IS NEW.realm_registration AND realm_incarnation IS NEW.realm_incarnation)) BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 replacement'); END;
CREATE TRIGGER financial_customer_history_coverages_no_update BEFORE UPDATE ON financial_customer_history_coverages BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_history_coverages_no_delete BEFORE DELETE ON financial_customer_history_coverages BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_history_scopes_no_replace BEFORE INSERT ON financial_customer_history_scopes WHEN EXISTS(SELECT 1 FROM financial_customer_history_scopes WHERE (scope_ref IS NEW.scope_ref) OR (history_ref IS NEW.history_ref AND inventory_ref IS NEW.inventory_ref) OR (history_ref IS NEW.history_ref AND scope_kind IS NEW.scope_kind AND original_scope_ref IS NEW.original_scope_ref AND original_scope_incarnation IS NEW.original_scope_incarnation)) BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 replacement'); END;
CREATE TRIGGER financial_customer_history_scopes_no_update BEFORE UPDATE ON financial_customer_history_scopes BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_history_scopes_no_delete BEFORE DELETE ON financial_customer_history_scopes BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_dispatch_claims_no_replace BEFORE INSERT ON financial_customer_dispatch_claims WHEN EXISTS(SELECT 1 FROM financial_customer_dispatch_claims WHERE (claim_ref IS NEW.claim_ref) OR (attempt_ref IS NEW.attempt_ref) OR (admission_ref IS NEW.admission_ref) OR (org_id IS NEW.org_id) OR (expected_dispatch_receipt_ref IS NEW.expected_dispatch_receipt_ref)) BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 replacement'); END;
CREATE TRIGGER financial_customer_dispatch_claims_no_update BEFORE UPDATE ON financial_customer_dispatch_claims BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_dispatch_claims_no_delete BEFORE DELETE ON financial_customer_dispatch_claims BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_dispatch_receipts_no_replace BEFORE INSERT ON financial_customer_dispatch_receipts WHEN EXISTS(SELECT 1 FROM financial_customer_dispatch_receipts WHERE (receipt_ref IS NEW.receipt_ref) OR (claim_ref IS NEW.claim_ref) OR (attempt_ref IS NEW.attempt_ref)) BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 replacement'); END;
CREATE TRIGGER financial_customer_dispatch_receipts_no_update BEFORE UPDATE ON financial_customer_dispatch_receipts BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_dispatch_receipts_no_delete BEFORE DELETE ON financial_customer_dispatch_receipts BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_custody_receipts_no_replace BEFORE INSERT ON financial_customer_custody_receipts WHEN EXISTS(SELECT 1 FROM financial_customer_custody_receipts WHERE (custody_receipt_ref IS NEW.custody_receipt_ref) OR (dispatch_receipt_ref IS NEW.dispatch_receipt_ref)) BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 replacement'); END;
CREATE TRIGGER financial_customer_custody_receipts_no_update BEFORE UPDATE ON financial_customer_custody_receipts BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_custody_receipts_no_delete BEFORE DELETE ON financial_customer_custody_receipts BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_history_entries_no_replace BEFORE INSERT ON financial_customer_history_entries WHEN EXISTS(SELECT 1 FROM financial_customer_history_entries WHERE (entry_ref IS NEW.entry_ref) OR (coupling_attempt_ref IS NEW.coupling_attempt_ref) OR (expected_history_receipt_ref IS NEW.expected_history_receipt_ref) OR (history_ref IS NEW.history_ref AND journal_sequence IS NEW.journal_sequence AND ordinal IS NEW.ordinal) OR (history_ref IS NEW.history_ref AND writer_kind IS NEW.writer_kind AND original_command_key IS NEW.original_command_key AND transition_ref IS NEW.transition_ref) OR (NEW.evidence_kind='customer-prepared' AND evidence_kind='customer-prepared' AND l1_receipt_ref IS NEW.l1_receipt_ref) OR (NEW.evidence_kind='customer-first-dispatch' AND evidence_kind='customer-first-dispatch' AND dispatch_receipt_ref IS NEW.dispatch_receipt_ref) OR (NEW.evidence_kind='customer-verified-binding' AND evidence_kind='customer-verified-binding' AND custody_receipt_ref IS NEW.custody_receipt_ref)) BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 replacement'); END;
CREATE TRIGGER financial_customer_history_entries_no_update BEFORE UPDATE ON financial_customer_history_entries BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_history_entries_no_delete BEFORE DELETE ON financial_customer_history_entries BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_history_receipts_no_replace BEFORE INSERT ON financial_customer_history_receipts WHEN EXISTS(SELECT 1 FROM financial_customer_history_receipts WHERE (receipt_ref IS NEW.receipt_ref) OR (attempt_ref IS NEW.attempt_ref) OR (history_ref IS NEW.history_ref AND journal_sequence IS NEW.journal_sequence) OR (entry_ref IS NEW.entry_ref)) BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 replacement'); END;
CREATE TRIGGER financial_customer_history_receipts_no_update BEFORE UPDATE ON financial_customer_history_receipts BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_history_receipts_no_delete BEFORE DELETE ON financial_customer_history_receipts BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 mutation'); END;
CREATE TRIGGER financial_customer_history_heads_no_replace BEFORE INSERT ON financial_customer_history_heads
WHEN EXISTS(SELECT 1 FROM financial_customer_history_heads WHERE original_org_origin IS NEW.original_org_origin AND realm_registration IS NEW.realm_registration AND realm_incarnation IS NEW.realm_incarnation)
BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 head replacement'); END;
CREATE TRIGGER financial_customer_history_heads_no_delete BEFORE DELETE ON financial_customer_history_heads BEGIN SELECT RAISE(ABORT,'constraint: retained Customer H1 head deletion'); END;
CREATE TRIGGER financial_customer_history_heads_cas BEFORE UPDATE ON financial_customer_history_heads
WHEN NOT (NEW.original_org_origin IS OLD.original_org_origin AND NEW.realm_registration IS OLD.realm_registration AND NEW.realm_incarnation IS OLD.realm_incarnation
 AND NEW.history_ref IS OLD.history_ref AND NEW.journal_sequence=OLD.journal_sequence+1 AND NEW.state IS OLD.state
 AND EXISTS(SELECT 1 FROM financial_customer_history_entries e WHERE e.entry_ref IS NEW.last_entry_ref AND e.history_ref IS OLD.history_ref
 AND e.journal_sequence IS NEW.journal_sequence AND e.expected_history_receipt_ref IS NEW.last_expected_receipt_ref
 AND e.previous_history_receipt_ref IS OLD.last_expected_receipt_ref
 AND (OLD.state='active' OR (OLD.state='closed' AND e.evidence_kind='customer-verified-binding'))))
BEGIN SELECT RAISE(ABORT,'constraint: exact Customer H1 head CAS'); END;
CREATE TRIGGER financial_customer_history_coverage_origin BEFORE INSERT ON financial_customer_history_coverages
WHEN NOT EXISTS(SELECT 1 FROM financial_customer_history_birth_observations b
 JOIN financial_history_enrollment_receipts seal ON seal.receipt_ref=b.complete_seal_ref AND seal.primary_ref=b.primary_ref AND seal.enrollment_ref=b.enrollment_ref AND seal.receipt_kind='complete-seal' AND seal.all_rows_match=1
 JOIN financial_history_enrollments run ON run.enrollment_ref=seal.enrollment_ref AND run.primary_ref=seal.primary_ref
 WHERE b.birth_ref IS NEW.original_org_origin AND b.org_id IS NEW.organization_id AND b.phase='post-seal'
 AND b.primary_ref IS NEW.primary_ref AND b.enrollment_ref IS NEW.enrollment_ref AND seal.receipt_ref IS NEW.complete_seal_ref
 AND run.required_json IS NEW.required_scopes_json AND run.expected_seal_ref IS seal.receipt_ref
 AND NOT EXISTS(SELECT 1 FROM financial_history_enrollment_roster ro WHERE ro.primary_ref=b.primary_ref AND ro.org_id=b.org_id)
 AND EXISTS(SELECT 1 FROM orgs o WHERE o.id IS b.org_id AND o.owner_principal_id IS b.owner_principal_id AND o.created_at IS b.org_created_at)
 AND NOT EXISTS(SELECT 1 FROM financial_customer_history_org_changes ch WHERE ch.org_id=b.org_id OR ch.new_org_id=b.org_id)
 AND NOT EXISTS(SELECT 1 FROM financial_customer_history_birth_observations old WHERE old.org_id=b.org_id AND old.birth_ref<>b.birth_ref))
BEGIN SELECT RAISE(ABORT,'constraint: exact H0 post-seal origin; retained adoption is not implemented'); END;
CREATE TRIGGER financial_customer_history_scope_original BEFORE INSERT ON financial_customer_history_scopes
WHEN NOT EXISTS(SELECT 1 FROM financial_customer_history_coverages cv JOIN financial_history_enrollment_inventory i
 ON i.primary_ref=cv.primary_ref AND i.enrollment_ref=cv.enrollment_ref
 WHERE cv.history_ref IS NEW.history_ref AND i.inventory_ref IS NEW.inventory_ref AND i.scope_kind IS NEW.scope_kind
 AND i.original_scope_ref IS NEW.original_scope_ref AND i.original_scope_incarnation IS NEW.original_scope_incarnation AND i.evidence_json IS NEW.evidence_json
 AND EXISTS(SELECT 1 FROM json_each(cv.required_scopes_json) j WHERE json(j.value)=json(i.evidence_json)))
BEGIN SELECT RAISE(ABORT,'constraint: actual retained H0 scope parent'); END;
CREATE TRIGGER financial_customer_history_receipt_parent BEFORE INSERT ON financial_customer_history_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_coverages cv ON cv.history_ref=e.history_ref
 JOIN financial_customer_history_heads h ON h.original_org_origin=cv.original_org_origin AND h.realm_registration=cv.realm_registration AND h.realm_incarnation=cv.realm_incarnation
 LEFT JOIN financial_customer_history_receipts p ON p.receipt_ref=e.previous_history_receipt_ref
 WHERE e.entry_ref IS NEW.entry_ref AND cv.history_ref IS NEW.history_ref AND e.journal_sequence IS NEW.journal_sequence
 AND h.history_ref IS cv.history_ref AND h.journal_sequence IS e.journal_sequence AND h.last_entry_ref IS e.entry_ref
 AND h.last_expected_receipt_ref IS NEW.receipt_ref AND e.expected_history_receipt_ref IS NEW.receipt_ref AND e.coupling_attempt_ref IS NEW.attempt_ref
 AND NEW.original_org_origin IS cv.original_org_origin AND NEW.realm_registration IS cv.realm_registration AND NEW.realm_incarnation IS cv.realm_incarnation
 AND e.evidence_kind IS NEW.evidence_kind AND e.command_org_id IS NEW.command_org_id AND e.l1_receipt_ref IS NEW.l1_receipt_ref
 AND e.dispatch_receipt_ref IS NEW.dispatch_receipt_ref AND e.custody_receipt_ref IS NEW.custody_receipt_ref
 AND ((e.evidence_kind='genesis' AND cv.expected_receipt_ref IS NEW.receipt_ref AND cv.attempt_ref IS NEW.attempt_ref)
 OR (p.receipt_ref IS NEW.previous_history_receipt_ref AND p.entry_ref IS NEW.previous_entry_ref AND p.journal_sequence IS NEW.previous_journal_sequence
 AND p.history_ref IS e.history_ref AND p.journal_sequence=e.journal_sequence-1 AND p.all_rows_match=1)))
BEGIN SELECT RAISE(ABORT,'constraint: exact typed history receipt parent'); END;
