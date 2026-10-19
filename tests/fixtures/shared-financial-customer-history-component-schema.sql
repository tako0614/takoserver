-- PRIVATE unnumbered H0 component. Labels/JSON are not genuine source authority.
-- No H1/payer/grant/native/money writer. Existing 0096-0100 are unchanged.
-- The three financial_history_capture_org_* triggers on orgs are Root-owned (Root
-- 0105, 0105 -> 0104); every other object here is a Financial 0104 row.
-- Org capture is append-only: Root's Org triggers only append birth and change
-- observations and never update a Financial head. A framed capture start records
-- the orgs rowid and change-observation high-water marks; only orgs above the mark
-- may have a non-raw birth, and seal and coverage refuse after any change.
CREATE TABLE financial_history_primary_roots (
 primary_ref TEXT PRIMARY KEY NOT NULL, primary_incarnation TEXT NOT NULL UNIQUE,
 physical_binding_ref TEXT NOT NULL, physical_binding_incarnation TEXT NOT NULL,
 root_json TEXT NOT NULL CHECK(json_valid(root_json) AND json_type(root_json)='object'),
 CHECK(json_extract(root_json,'$.primaryRef') IS primary_ref AND json_extract(root_json,'$.primaryIncarnation') IS primary_incarnation AND json_extract(root_json,'$.physicalBindingRef') IS physical_binding_ref AND json_extract(root_json,'$.physicalBindingIncarnation') IS physical_binding_incarnation),
 UNIQUE(physical_binding_ref,physical_binding_incarnation)
);
CREATE TABLE financial_history_enrollments (
 enrollment_ref TEXT PRIMARY KEY NOT NULL, enrollment_incarnation TEXT NOT NULL UNIQUE,
 primary_ref TEXT NOT NULL REFERENCES financial_history_primary_roots(primary_ref),
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
 expected_start_receipt_ref TEXT NOT NULL UNIQUE, expected_seal_ref TEXT NOT NULL UNIQUE,
 previous_start_receipt_ref TEXT REFERENCES financial_history_enrollment_receipts(receipt_ref),
 previous_seal_ref TEXT REFERENCES financial_history_enrollment_receipts(receipt_ref),
 required_json TEXT NOT NULL CHECK(json_valid(required_json) AND json_type(required_json)='array' AND json_array_length(required_json) BETWEEN 1 AND 64),
 org_high_water INTEGER NOT NULL CHECK(typeof(org_high_water)='integer' AND org_high_water>=0),
 change_high_water INTEGER NOT NULL CHECK(typeof(change_high_water)='integer' AND change_high_water>=0),
 CHECK((generation=1 AND previous_start_receipt_ref IS NULL AND previous_seal_ref IS NULL) OR (generation>1 AND previous_start_receipt_ref IS NOT NULL)),
 CHECK(expected_start_receipt_ref<>expected_seal_ref),
 UNIQUE(primary_ref,generation), UNIQUE(enrollment_ref,primary_ref)
);
CREATE TABLE financial_history_enrollment_inventory (
 inventory_ref TEXT PRIMARY KEY NOT NULL, enrollment_ref TEXT NOT NULL, primary_ref TEXT NOT NULL,
 scope_kind TEXT NOT NULL CHECK(scope_kind IN('physical-primary','writer','credential-alias','org-namespace','retired-namespace','org-alias')),
 original_scope_ref TEXT NOT NULL, original_scope_incarnation TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
 CHECK(json_extract(evidence_json,'$.scopeKind') IS scope_kind AND json_extract(evidence_json,'$.originalScopeRef') IS original_scope_ref AND json_extract(evidence_json,'$.originalScopeIncarnation') IS original_scope_incarnation),
 FOREIGN KEY(enrollment_ref,primary_ref) REFERENCES financial_history_enrollments(enrollment_ref,primary_ref),
 UNIQUE(enrollment_ref,scope_kind,original_scope_ref,original_scope_incarnation)
);
CREATE TABLE financial_history_enrollment_heads (
 primary_ref TEXT PRIMARY KEY NOT NULL REFERENCES financial_history_primary_roots(primary_ref),
 enrollment_ref TEXT NOT NULL, generation INTEGER NOT NULL,
 capture_sequence INTEGER NOT NULL CHECK(typeof(capture_sequence)='integer' AND capture_sequence BETWEEN 0 AND 9007199254740991),
 state TEXT NOT NULL CHECK(state IN('capturing','sealed','closed')),
 expected_receipt_ref TEXT NOT NULL,
 FOREIGN KEY(enrollment_ref,primary_ref) REFERENCES financial_history_enrollments(enrollment_ref,primary_ref)
);
CREATE TABLE financial_history_enrollment_receipts (
 receipt_ref TEXT PRIMARY KEY NOT NULL, attempt_ref TEXT NOT NULL UNIQUE,
 enrollment_ref TEXT NOT NULL, primary_ref TEXT NOT NULL REFERENCES financial_history_enrollment_heads(primary_ref),
 generation INTEGER NOT NULL, receipt_kind TEXT NOT NULL CHECK(receipt_kind IN('capture-start','complete-seal')),
 capture_sequence INTEGER NOT NULL CHECK(typeof(capture_sequence)='integer' AND capture_sequence BETWEEN 0 AND 9007199254740991),
 all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),
 FOREIGN KEY(enrollment_ref,primary_ref) REFERENCES financial_history_enrollments(enrollment_ref,primary_ref),
 UNIQUE(enrollment_ref,receipt_kind), UNIQUE(primary_ref,generation,receipt_kind),
 UNIQUE(receipt_ref,primary_ref,enrollment_ref,receipt_kind)
);
CREATE TABLE financial_customer_history_birth_observations (
 birth_ref TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL,
 org_rowid INTEGER NOT NULL CHECK(typeof(org_rowid)='integer' AND org_rowid>0),
 owner_principal_id TEXT NOT NULL, org_name TEXT NOT NULL, org_created_at TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN('raw','during-enrollment','post-seal')),
 primary_ref TEXT, enrollment_ref TEXT,
 complete_seal_ref TEXT, seal_kind TEXT,
 CHECK((phase='raw' AND primary_ref IS NULL AND enrollment_ref IS NULL AND complete_seal_ref IS NULL AND seal_kind IS NULL)
 OR (phase='during-enrollment' AND primary_ref IS NOT NULL AND enrollment_ref IS NOT NULL AND complete_seal_ref IS NULL AND seal_kind IS NULL)
 OR (phase='post-seal' AND primary_ref IS NOT NULL AND enrollment_ref IS NOT NULL AND complete_seal_ref IS NOT NULL AND seal_kind IS 'complete-seal')),
 FOREIGN KEY(enrollment_ref,primary_ref) REFERENCES financial_history_enrollments(enrollment_ref,primary_ref),
 FOREIGN KEY(complete_seal_ref,primary_ref,enrollment_ref,seal_kind) REFERENCES financial_history_enrollment_receipts(receipt_ref,primary_ref,enrollment_ref,receipt_kind),
 UNIQUE(org_id,org_rowid,primary_ref,enrollment_ref)
);
CREATE UNIQUE INDEX financial_customer_history_birth_observations_raw_once
 ON financial_customer_history_birth_observations(org_id,org_rowid) WHERE phase='raw';
CREATE TABLE financial_customer_history_org_changes (
 change_seq INTEGER PRIMARY KEY, change_ref TEXT NOT NULL UNIQUE,
 change_kind TEXT NOT NULL CHECK(change_kind IN('update','delete')),
 org_id TEXT NOT NULL, org_rowid INTEGER NOT NULL CHECK(typeof(org_rowid)='integer' AND org_rowid>0),
 old_owner_principal_id TEXT NOT NULL, old_org_name TEXT NOT NULL, old_org_created_at TEXT NOT NULL,
 new_org_id TEXT, new_owner_principal_id TEXT, new_org_name TEXT, new_org_created_at TEXT,
 CHECK((change_kind='delete' AND new_org_id IS NULL AND new_owner_principal_id IS NULL AND new_org_name IS NULL AND new_org_created_at IS NULL)
 OR (change_kind='update' AND new_org_id IS NOT NULL AND new_owner_principal_id IS NOT NULL AND new_org_name IS NOT NULL AND new_org_created_at IS NOT NULL))
);
CREATE TRIGGER financial_history_primary_roots_no_replace BEFORE INSERT ON financial_history_primary_roots WHEN EXISTS(SELECT 1 FROM financial_history_primary_roots WHERE (primary_ref=NEW.primary_ref) OR (primary_incarnation=NEW.primary_incarnation) OR (physical_binding_ref=NEW.physical_binding_ref AND physical_binding_incarnation=NEW.physical_binding_incarnation)) BEGIN SELECT RAISE(ABORT,'constraint: retained history replacement');
END;
CREATE TRIGGER financial_history_primary_roots_no_delete BEFORE DELETE ON financial_history_primary_roots BEGIN SELECT RAISE(ABORT,'constraint: retained history deletion');
END;
CREATE TRIGGER financial_history_primary_roots_no_update BEFORE UPDATE ON financial_history_primary_roots BEGIN SELECT RAISE(ABORT,'constraint: retained history mutation');
END;
CREATE TRIGGER financial_history_enrollments_no_replace BEFORE INSERT ON financial_history_enrollments WHEN EXISTS(SELECT 1 FROM financial_history_enrollments WHERE (enrollment_ref=NEW.enrollment_ref) OR (enrollment_incarnation=NEW.enrollment_incarnation) OR (primary_ref=NEW.primary_ref AND generation=NEW.generation) OR (expected_start_receipt_ref=NEW.expected_start_receipt_ref) OR (expected_seal_ref=NEW.expected_seal_ref) OR (expected_start_receipt_ref=NEW.expected_seal_ref) OR (expected_seal_ref=NEW.expected_start_receipt_ref)) BEGIN SELECT RAISE(ABORT,'constraint: retained history replacement');
END;
CREATE TRIGGER financial_history_enrollments_no_delete BEFORE DELETE ON financial_history_enrollments BEGIN SELECT RAISE(ABORT,'constraint: retained history deletion');
END;
CREATE TRIGGER financial_history_enrollments_no_update BEFORE UPDATE ON financial_history_enrollments BEGIN SELECT RAISE(ABORT,'constraint: retained history mutation');
END;
CREATE TRIGGER financial_history_enrollment_inventory_no_replace BEFORE INSERT ON financial_history_enrollment_inventory WHEN EXISTS(SELECT 1 FROM financial_history_enrollment_inventory WHERE (inventory_ref=NEW.inventory_ref) OR (enrollment_ref=NEW.enrollment_ref AND scope_kind=NEW.scope_kind AND original_scope_ref=NEW.original_scope_ref AND original_scope_incarnation=NEW.original_scope_incarnation)) BEGIN SELECT RAISE(ABORT,'constraint: retained history replacement');
END;
CREATE TRIGGER financial_history_enrollment_inventory_no_delete BEFORE DELETE ON financial_history_enrollment_inventory BEGIN SELECT RAISE(ABORT,'constraint: retained history deletion');
END;
CREATE TRIGGER financial_history_enrollment_inventory_no_update BEFORE UPDATE ON financial_history_enrollment_inventory BEGIN SELECT RAISE(ABORT,'constraint: retained history mutation');
END;
CREATE TRIGGER financial_history_enrollment_heads_no_replace BEFORE INSERT ON financial_history_enrollment_heads WHEN EXISTS(SELECT 1 FROM financial_history_enrollment_heads WHERE (primary_ref=NEW.primary_ref)) BEGIN SELECT RAISE(ABORT,'constraint: retained history replacement');
END;
CREATE TRIGGER financial_history_enrollment_heads_no_delete BEFORE DELETE ON financial_history_enrollment_heads BEGIN SELECT RAISE(ABORT,'constraint: retained history deletion');
END;
CREATE TRIGGER financial_history_enrollment_receipts_no_replace BEFORE INSERT ON financial_history_enrollment_receipts WHEN EXISTS(SELECT 1 FROM financial_history_enrollment_receipts WHERE (receipt_ref=NEW.receipt_ref) OR (attempt_ref=NEW.attempt_ref) OR (enrollment_ref=NEW.enrollment_ref AND receipt_kind=NEW.receipt_kind) OR (primary_ref=NEW.primary_ref AND generation=NEW.generation AND receipt_kind=NEW.receipt_kind)) BEGIN SELECT RAISE(ABORT,'constraint: retained history replacement');
END;
CREATE TRIGGER financial_history_enrollment_receipts_no_delete BEFORE DELETE ON financial_history_enrollment_receipts BEGIN SELECT RAISE(ABORT,'constraint: retained history deletion');
END;
CREATE TRIGGER financial_history_enrollment_receipts_no_update BEFORE UPDATE ON financial_history_enrollment_receipts BEGIN SELECT RAISE(ABORT,'constraint: retained history mutation');
END;
CREATE TRIGGER financial_customer_history_birth_observations_no_replace BEFORE INSERT ON financial_customer_history_birth_observations WHEN EXISTS(SELECT 1 FROM financial_customer_history_birth_observations WHERE (birth_ref=NEW.birth_ref) OR (org_id=NEW.org_id AND org_rowid=NEW.org_rowid AND primary_ref=NEW.primary_ref AND enrollment_ref=NEW.enrollment_ref) OR (NEW.phase='raw' AND phase='raw' AND org_id=NEW.org_id AND org_rowid=NEW.org_rowid)) BEGIN SELECT RAISE(ABORT,'constraint: retained history replacement');
END;
CREATE TRIGGER financial_customer_history_birth_observations_org_capture BEFORE INSERT ON financial_customer_history_birth_observations
WHEN NOT EXISTS(SELECT 1 FROM orgs o WHERE o.rowid IS NEW.org_rowid AND o.id IS NEW.org_id AND o.owner_principal_id IS NEW.owner_principal_id
 AND o.name IS NEW.org_name AND o.created_at IS NEW.org_created_at)
 OR NOT ((NEW.phase='raw' AND NOT EXISTS(SELECT 1 FROM financial_history_enrollment_heads WHERE state IN('capturing','sealed')))
 OR EXISTS(SELECT 1 FROM financial_history_enrollment_heads h JOIN financial_history_enrollments e ON e.enrollment_ref=h.enrollment_ref AND e.primary_ref=h.primary_ref
 LEFT JOIN financial_history_enrollment_receipts r ON r.receipt_ref=e.expected_seal_ref AND r.receipt_kind='complete-seal' AND r.enrollment_ref=e.enrollment_ref
 WHERE h.state IN('capturing','sealed') AND h.primary_ref IS NEW.primary_ref AND h.enrollment_ref IS NEW.enrollment_ref
 AND NEW.org_rowid>e.org_high_water AND NEW.complete_seal_ref IS r.receipt_ref
 AND NEW.phase IS CASE WHEN h.state='sealed' AND r.receipt_ref IS NOT NULL THEN 'post-seal' ELSE 'during-enrollment' END))
BEGIN SELECT RAISE(ABORT,'constraint: birth observation requires its exact Org capture');
END;
CREATE TRIGGER financial_customer_history_org_changes_org_capture BEFORE INSERT ON financial_customer_history_org_changes
WHEN NOT ((NEW.change_kind='update' AND EXISTS(SELECT 1 FROM orgs o WHERE o.rowid IS NEW.org_rowid AND o.id IS NEW.new_org_id
 AND o.owner_principal_id IS NEW.new_owner_principal_id AND o.name IS NEW.new_org_name AND o.created_at IS NEW.new_org_created_at))
 OR (NEW.change_kind='delete' AND NOT EXISTS(SELECT 1 FROM orgs o WHERE o.rowid IS NEW.org_rowid AND o.id IS NEW.org_id)))
BEGIN SELECT RAISE(ABORT,'constraint: change observation requires its exact Org change');
END;
CREATE TRIGGER financial_customer_history_org_changes_no_replace BEFORE INSERT ON financial_customer_history_org_changes WHEN EXISTS(SELECT 1 FROM financial_customer_history_org_changes WHERE (change_seq=NEW.change_seq) OR (change_ref=NEW.change_ref)) BEGIN SELECT RAISE(ABORT,'constraint: retained history replacement');
END;
CREATE TRIGGER financial_customer_history_org_changes_no_delete BEFORE DELETE ON financial_customer_history_org_changes BEGIN SELECT RAISE(ABORT,'constraint: retained history deletion');
END;
CREATE TRIGGER financial_customer_history_org_changes_no_update BEFORE UPDATE ON financial_customer_history_org_changes BEGIN SELECT RAISE(ABORT,'constraint: retained history mutation');
END;
CREATE TRIGGER financial_history_enrollment_watermarks BEFORE INSERT ON financial_history_enrollments
WHEN NEW.org_high_water IS NOT COALESCE((SELECT max(rowid) FROM orgs),0)
 OR NEW.change_high_water IS NOT COALESCE((SELECT max(change_seq) FROM financial_customer_history_org_changes),0)
BEGIN SELECT RAISE(ABORT,'constraint: capture watermarks must be the current Org and change high-water marks');
END;
CREATE TRIGGER financial_customer_history_birth_observations_no_delete BEFORE DELETE ON financial_customer_history_birth_observations BEGIN SELECT RAISE(ABORT,'constraint: retained history deletion');
END;
CREATE TRIGGER financial_customer_history_birth_observations_no_update BEFORE UPDATE ON financial_customer_history_birth_observations BEGIN SELECT RAISE(ABORT,'constraint: retained history mutation');
END;
CREATE TRIGGER financial_history_enrollment_predecessor BEFORE INSERT ON financial_history_enrollments
WHEN NEW.generation>1 AND NOT EXISTS(
 SELECT 1 FROM financial_history_enrollment_heads h JOIN financial_history_enrollments e ON e.enrollment_ref=h.enrollment_ref AND e.primary_ref=h.primary_ref
 JOIN financial_history_enrollment_receipts start ON start.receipt_ref=e.expected_start_receipt_ref AND start.enrollment_ref=e.enrollment_ref AND start.primary_ref=e.primary_ref AND start.generation=e.generation AND start.receipt_kind='capture-start' AND start.all_rows_match=1
 LEFT JOIN financial_history_enrollment_receipts seal ON seal.receipt_ref=e.expected_seal_ref AND seal.enrollment_ref=e.enrollment_ref AND seal.primary_ref=e.primary_ref AND seal.generation=e.generation AND seal.receipt_kind='complete-seal' AND seal.all_rows_match=1
 WHERE h.primary_ref=NEW.primary_ref AND h.state='closed' AND h.generation=NEW.generation-1 AND e.generation=h.generation AND start.receipt_ref IS NEW.previous_start_receipt_ref AND seal.receipt_ref IS NEW.previous_seal_ref
) BEGIN SELECT RAISE(ABORT,'constraint: exact closed predecessor required');
END;
CREATE TRIGGER financial_history_heads_cas BEFORE UPDATE ON financial_history_enrollment_heads
WHEN NEW.primary_ref IS NOT OLD.primary_ref OR NOT (
 (NEW.enrollment_ref IS OLD.enrollment_ref AND NEW.generation IS OLD.generation AND
  ((NEW.capture_sequence=OLD.capture_sequence+1 AND NEW.state IS OLD.state AND OLD.state IN('capturing','sealed') AND NEW.expected_receipt_ref IS OLD.expected_receipt_ref)
   OR (NEW.capture_sequence IS OLD.capture_sequence AND OLD.state='capturing' AND NEW.state='sealed' AND NEW.expected_receipt_ref IS (SELECT expected_seal_ref FROM financial_history_enrollments WHERE enrollment_ref=OLD.enrollment_ref))
   OR (NEW.capture_sequence=OLD.capture_sequence+1 AND NEW.state='closed' AND OLD.state IN('capturing','sealed') AND NEW.expected_receipt_ref IS OLD.expected_receipt_ref)))
 OR (OLD.state='closed' AND NEW.state='capturing' AND NEW.generation=OLD.generation+1 AND NEW.capture_sequence IS OLD.capture_sequence AND EXISTS(SELECT 1 FROM financial_history_enrollments e WHERE e.enrollment_ref=NEW.enrollment_ref AND e.primary_ref=NEW.primary_ref AND e.generation=NEW.generation AND e.expected_start_receipt_ref IS NEW.expected_receipt_ref))
) BEGIN SELECT RAISE(ABORT,'constraint: history head CAS');
END;
CREATE TRIGGER financial_history_inventory_phase BEFORE INSERT ON financial_history_enrollment_inventory
WHEN NOT EXISTS(SELECT 1 FROM financial_history_enrollment_heads h JOIN financial_history_enrollments e ON e.enrollment_ref=h.enrollment_ref WHERE h.primary_ref=NEW.primary_ref AND h.enrollment_ref=NEW.enrollment_ref AND h.state='capturing' AND EXISTS(SELECT 1 FROM financial_history_enrollment_receipts r WHERE r.receipt_ref=e.expected_start_receipt_ref AND r.receipt_kind='capture-start') AND EXISTS(SELECT 1 FROM json_each(e.required_json) j WHERE json(j.value)=json(NEW.evidence_json)))
BEGIN SELECT RAISE(ABORT,'constraint: inventory original/phase mismatch');
END;
CREATE TRIGGER financial_history_receipt_match BEFORE INSERT ON financial_history_enrollment_receipts
WHEN NOT EXISTS(SELECT 1 FROM financial_history_enrollment_heads h JOIN financial_history_enrollments e ON e.enrollment_ref=h.enrollment_ref AND e.primary_ref=h.primary_ref
 WHERE h.primary_ref=NEW.primary_ref AND h.enrollment_ref=NEW.enrollment_ref AND h.generation=NEW.generation AND e.generation=NEW.generation AND h.capture_sequence=NEW.capture_sequence AND h.expected_receipt_ref IS NEW.receipt_ref AND
 ((NEW.receipt_kind='capture-start' AND h.state='capturing' AND e.expected_start_receipt_ref IS NEW.receipt_ref)
 OR (NEW.receipt_kind='complete-seal' AND h.state='sealed' AND e.expected_seal_ref IS NEW.receipt_ref
 AND EXISTS(SELECT 1 FROM financial_history_enrollment_receipts r WHERE r.receipt_ref=e.expected_start_receipt_ref AND r.enrollment_ref=e.enrollment_ref AND r.receipt_kind='capture-start')
 AND NOT EXISTS(SELECT 1 FROM json_each(e.required_json) j WHERE NOT EXISTS(SELECT 1 FROM financial_history_enrollment_inventory i WHERE i.enrollment_ref=e.enrollment_ref AND json(i.evidence_json)=json(j.value)))
 AND NOT EXISTS(SELECT 1 FROM financial_history_enrollment_inventory i WHERE i.enrollment_ref=e.enrollment_ref AND NOT EXISTS(SELECT 1 FROM json_each(e.required_json) j WHERE json(i.evidence_json)=json(j.value)))
 AND NOT EXISTS(SELECT 1 FROM orgs o WHERE (o.rowid<=e.org_high_water AND NOT EXISTS(SELECT 1 FROM financial_history_enrollment_inventory i WHERE i.enrollment_ref=e.enrollment_ref AND i.scope_kind='org-namespace' AND i.original_scope_ref=o.id AND json_extract(i.evidence_json,'$.ownerPrincipalId') IS o.owner_principal_id AND json_extract(i.evidence_json,'$.orgCreatedAt') IS o.created_at)) OR (o.rowid>e.org_high_water AND NOT EXISTS(SELECT 1 FROM financial_customer_history_birth_observations b WHERE b.org_id=o.id AND b.org_rowid=o.rowid AND b.owner_principal_id=o.owner_principal_id AND b.org_created_at=o.created_at AND b.primary_ref=e.primary_ref AND b.enrollment_ref=e.enrollment_ref AND b.phase='during-enrollment')))
 AND NOT EXISTS(SELECT 1 FROM financial_customer_history_org_changes ch WHERE ch.change_seq>e.change_high_water))))
BEGIN SELECT RAISE(ABORT,'constraint: mandatory receipt mismatch');
END;
CREATE TRIGGER financial_history_capture_org_insert AFTER INSERT ON orgs
BEGIN
 INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,org_rowid,owner_principal_id,org_name,org_created_at,phase,primary_ref,enrollment_ref,complete_seal_ref,seal_kind)
 SELECT 'birth:'||lower(hex(randomblob(16))),NEW.id,NEW.rowid,NEW.owner_principal_id,NEW.name,NEW.created_at,
 CASE WHEN h.state='sealed' AND r.receipt_ref IS NOT NULL THEN 'post-seal' ELSE 'during-enrollment' END,h.primary_ref,h.enrollment_ref,r.receipt_ref,CASE WHEN r.receipt_ref IS NOT NULL THEN 'complete-seal' ELSE NULL END
 FROM financial_history_enrollment_heads h JOIN financial_history_enrollments e ON e.enrollment_ref=h.enrollment_ref AND e.primary_ref=h.primary_ref LEFT JOIN financial_history_enrollment_receipts r ON r.receipt_ref=e.expected_seal_ref AND r.receipt_kind='complete-seal' AND r.enrollment_ref=e.enrollment_ref
 WHERE h.state IN('capturing','sealed') AND NEW.rowid>e.org_high_water;
 INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,org_rowid,owner_principal_id,org_name,org_created_at,phase)
 SELECT 'birth:'||lower(hex(randomblob(16))),NEW.id,NEW.rowid,NEW.owner_principal_id,NEW.name,NEW.created_at,'raw'
 WHERE NOT EXISTS(SELECT 1 FROM financial_history_enrollment_heads WHERE state IN('capturing','sealed'));
END;
CREATE TRIGGER financial_history_capture_org_update AFTER UPDATE ON orgs
BEGIN
 INSERT INTO financial_customer_history_org_changes(change_ref,change_kind,org_id,org_rowid,old_owner_principal_id,old_org_name,old_org_created_at,new_org_id,new_owner_principal_id,new_org_name,new_org_created_at)
 VALUES('change:'||lower(hex(randomblob(16))),'update',OLD.id,NEW.rowid,OLD.owner_principal_id,OLD.name,OLD.created_at,NEW.id,NEW.owner_principal_id,NEW.name,NEW.created_at);
END;
CREATE TRIGGER financial_history_capture_org_delete AFTER DELETE ON orgs
BEGIN
 INSERT INTO financial_customer_history_org_changes(change_ref,change_kind,org_id,org_rowid,old_owner_principal_id,old_org_name,old_org_created_at)
 VALUES('change:'||lower(hex(randomblob(16))),'delete',OLD.id,OLD.rowid,OLD.owner_principal_id,OLD.name,OLD.created_at);
END;
