/** PRIVATE Financial-owned 0104 source recipe. Root/Money reserved 0104 for
 * Financial (dependency 0104 -> 0103; source order 0101 -> 0102 -> 0103 -> 0104).
 * Financial authors only this body: the receiver, C0/M/G, R1, five-action
 * consent and Customer admission/history/journal/dispatch/custody tables already
 * defined by existing Financial source and candidates, plus a Financial money
 * fence on every table that a Financial writer writes (and on UPDATE where a table
 * admits one). FINANCIAL_0104_UNFENCED_TABLES names the two exceptions. Root alone registers it into the canonical inventory, native
 * migration list and deploy scripts; nothing here registers, applies or selects
 * a migration, and no SQL label confers caller, payer, source or issuer authority. */

import {
  FINANCIAL_0104_CUSTOMER_H0_SCHEMA,
  FINANCIAL_0104_CUSTOMER_JOURNAL_SCHEMA,
  FINANCIAL_0104_CUSTOMER_L1_SCHEMA,
} from "./financial-0104-customer-schema.ts";
import {
  FINANCIAL_0104_C0_FENCE_SCHEMA,
  FINANCIAL_0104_CONSENT_FENCE_SCHEMA,
  FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA,
  FINANCIAL_0104_RECEIVER_FENCE_SCHEMA,
} from "./financial-0104-money-fence.ts";
import { bytesDigest } from "./json.ts";
import {
  FINANCIAL_R1_ATTEMPT_OBJECTS,
  FINANCIAL_R1_FENCE_SCHEMA,
} from "./shared-financial-retained-r1.ts";
import { FINANCIAL_SOURCE_ENROLLMENT_SCHEMA } from "./shared-financial-source-enrollment.ts";
import { FINANCIAL_GENESIS_SCHEMA } from "./shared-financial-source-genesis-schema.ts";

export const FINANCIAL_0104_MIGRATION = "0104_financial_custody.sql";
export const FINANCIAL_0104_PREDECESSOR = "0103_auth_authority.sql";
export const FINANCIAL_0104_RECIPE_VERSION = "takoserver.financial0104.source-recipe.v1";

/** Exact receiver candidate rows, byte-identical to the unfenced receiver
 * shape whose digest the enrollment and genesis readiness checks pin. */
const RECEIVER_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  financial_source_registrations:
    "CREATE TABLE financial_source_registrations (\n registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL,\n receiver_ref TEXT NOT NULL, target_ref TEXT NOT NULL,\n genesis_digest TEXT NOT NULL, registration_digest TEXT NOT NULL,\n registration_json TEXT NOT NULL CHECK(json_valid(registration_json)),\n qualification_ref TEXT NOT NULL, registered_at TEXT NOT NULL,\n retirement_ref TEXT, retired_at TEXT,\n PRIMARY KEY(registration_ref,incarnation),\n CHECK((retirement_ref IS NULL)=(retired_at IS NULL)),\n CHECK(retirement_ref IS NULL OR (length(retirement_ref) BETWEEN 1 AND 256 AND substr(retirement_ref,1,1) GLOB '[A-Za-z0-9]' AND retirement_ref NOT GLOB '*[^A-Za-z0-9._:/-]*')),\n CHECK(retired_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',retired_at) IS retired_at),\n CHECK(retired_at IS NULL OR retired_at>=registered_at),\n CHECK(length(CAST(registration_json AS BLOB)) BETWEEN 2 AND 16384),\n CHECK(length(registration_ref) BETWEEN 1 AND 256 AND substr(registration_ref,1,1) GLOB '[A-Za-z0-9]' AND registration_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(incarnation) BETWEEN 1 AND 256 AND substr(incarnation,1,1) GLOB '[A-Za-z0-9]' AND incarnation NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(receiver_ref) BETWEEN 1 AND 256 AND substr(receiver_ref,1,1) GLOB '[A-Za-z0-9]' AND receiver_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(target_ref) BETWEEN 1 AND 256 AND substr(target_ref,1,1) GLOB '[A-Za-z0-9]' AND target_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(qualification_ref) BETWEEN 1 AND 256 AND substr(qualification_ref,1,1) GLOB '[A-Za-z0-9]' AND qualification_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(substr(genesis_digest,1,7)='sha256:' AND length(genesis_digest)=71 AND substr(genesis_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(substr(registration_digest,1,7)='sha256:' AND length(registration_digest)=71 AND substr(registration_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',registered_at) IS registered_at)\n)",
  financial_source_events:
    "CREATE TABLE financial_source_events (\n event_ref TEXT PRIMARY KEY NOT NULL,\n registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,\n sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),\n previous_digest TEXT NOT NULL, event_digest TEXT NOT NULL,\n kind TEXT NOT NULL CHECK(kind IN('advance','close')), evidence_ref TEXT NOT NULL,\n event_json TEXT NOT NULL CHECK(json_valid(event_json)), applied_at TEXT NOT NULL,\n UNIQUE(registration_ref,incarnation,affected_ref,sequence),\n FOREIGN KEY(registration_ref,incarnation) REFERENCES financial_source_registrations(registration_ref,incarnation) ON DELETE RESTRICT,\n CHECK(length(CAST(event_json AS BLOB)) BETWEEN 2 AND 16384),\n CHECK(length(event_ref) BETWEEN 1 AND 256 AND substr(event_ref,1,1) GLOB '[A-Za-z0-9]' AND event_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(registration_ref) BETWEEN 1 AND 256 AND substr(registration_ref,1,1) GLOB '[A-Za-z0-9]' AND registration_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(incarnation) BETWEEN 1 AND 256 AND substr(incarnation,1,1) GLOB '[A-Za-z0-9]' AND incarnation NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(affected_ref) BETWEEN 1 AND 256 AND substr(affected_ref,1,1) GLOB '[A-Za-z0-9]' AND affected_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(evidence_ref) BETWEEN 1 AND 256 AND substr(evidence_ref,1,1) GLOB '[A-Za-z0-9]' AND evidence_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(substr(previous_digest,1,7)='sha256:' AND length(previous_digest)=71 AND substr(previous_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(substr(event_digest,1,7)='sha256:' AND length(event_digest)=71 AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',applied_at) IS applied_at)\n)",
  financial_source_heads:
    "CREATE TABLE financial_source_heads (\n registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,\n genesis_qualification_ref TEXT NOT NULL, created_at TEXT NOT NULL,\n sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 0 AND 9007199254740991),\n event_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('active','closed')),\n last_event_ref TEXT, updated_at TEXT NOT NULL,\n PRIMARY KEY(registration_ref,incarnation,affected_ref),\n FOREIGN KEY(registration_ref,incarnation) REFERENCES financial_source_registrations(registration_ref,incarnation) ON DELETE RESTRICT,\n FOREIGN KEY(last_event_ref) REFERENCES financial_source_events(event_ref) ON DELETE RESTRICT,\n CHECK((sequence=0 AND last_event_ref IS NULL AND state='active') OR (sequence>0 AND last_event_ref IS NOT NULL)),\n CHECK(updated_at>=created_at),\n CHECK(length(registration_ref) BETWEEN 1 AND 256 AND substr(registration_ref,1,1) GLOB '[A-Za-z0-9]' AND registration_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(incarnation) BETWEEN 1 AND 256 AND substr(incarnation,1,1) GLOB '[A-Za-z0-9]' AND incarnation NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(affected_ref) BETWEEN 1 AND 256 AND substr(affected_ref,1,1) GLOB '[A-Za-z0-9]' AND affected_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(genesis_qualification_ref) BETWEEN 1 AND 256 AND substr(genesis_qualification_ref,1,1) GLOB '[A-Za-z0-9]' AND genesis_qualification_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(substr(event_digest,1,7)='sha256:' AND length(event_digest)=71 AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),\n CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS updated_at)\n)",
  financial_source_receipts:
    "CREATE TABLE financial_source_receipts (\n event_ref TEXT PRIMARY KEY NOT NULL, receipt_ref TEXT NOT NULL UNIQUE,\n registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,\n receiver_ref TEXT NOT NULL, target_ref TEXT NOT NULL,\n sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),\n event_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('admission-closed','advanced')),\n receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at TEXT NOT NULL,\n all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),\n FOREIGN KEY(event_ref) REFERENCES financial_source_events(event_ref) ON DELETE RESTRICT,\n FOREIGN KEY(registration_ref,incarnation,affected_ref) REFERENCES financial_source_heads(registration_ref,incarnation,affected_ref) ON DELETE RESTRICT,\n FOREIGN KEY(registration_ref,incarnation) REFERENCES financial_source_registrations(registration_ref,incarnation) ON DELETE RESTRICT,\n CHECK(length(receipt_ref)=68 AND substr(receipt_ref,1,4)='fsr_' AND substr(receipt_ref,5) NOT GLOB '*[^0-9a-f]*'),\n CHECK(length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 16384),\n CHECK(length(event_ref) BETWEEN 1 AND 256 AND substr(event_ref,1,1) GLOB '[A-Za-z0-9]' AND event_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(registration_ref) BETWEEN 1 AND 256 AND substr(registration_ref,1,1) GLOB '[A-Za-z0-9]' AND registration_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(incarnation) BETWEEN 1 AND 256 AND substr(incarnation,1,1) GLOB '[A-Za-z0-9]' AND incarnation NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(affected_ref) BETWEEN 1 AND 256 AND substr(affected_ref,1,1) GLOB '[A-Za-z0-9]' AND affected_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(receiver_ref) BETWEEN 1 AND 256 AND substr(receiver_ref,1,1) GLOB '[A-Za-z0-9]' AND receiver_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(length(target_ref) BETWEEN 1 AND 256 AND substr(target_ref,1,1) GLOB '[A-Za-z0-9]' AND target_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'),\n CHECK(substr(event_digest,1,7)='sha256:' AND length(event_digest)=71 AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)\n)",
  financial_source_registration_shape:
    "CREATE TRIGGER financial_source_registration_shape BEFORE INSERT ON financial_source_registrations\nWHEN ((json_type(NEW.registration_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.registration_json))=4 AND json_extract(NEW.registration_json,'$.registrationRef') IS NEW.registration_ref AND json_extract(NEW.registration_json,'$.incarnation') IS NEW.incarnation AND json_extract(NEW.registration_json,'$.genesisDigest') IS NEW.genesis_digest) AND (json_type(NEW.registration_json,'$.receivers') IS 'array' AND json_array_length(NEW.registration_json,'$.receivers') BETWEEN 1 AND 8 AND (SELECT count(DISTINCT json_extract(value,'$.receiverRef')) FROM json_each(NEW.registration_json,'$.receivers'))=json_array_length(NEW.registration_json,'$.receivers') AND NOT EXISTS(SELECT 1 FROM json_each(NEW.registration_json,'$.receivers') AS member WHERE json_type(member.value) IS NOT 'object' OR (SELECT count(*) FROM json_each(member.value))<>2 OR json_type(member.value,'$.receiverRef') IS NOT 'text' OR json_type(member.value,'$.targetRef') IS NOT 'text') AND EXISTS(SELECT 1 FROM json_each(NEW.registration_json,'$.receivers') WHERE json_extract(value,'$.receiverRef') IS NEW.receiver_ref AND json_extract(value,'$.targetRef') IS NEW.target_ref)) AND (json_type(NEW.registration_json,'$.registrationRef') IS 'text' AND json_type(NEW.registration_json,'$.incarnation') IS 'text' AND json_type(NEW.registration_json,'$.genesisDigest') IS 'text' AND NEW.retired_at IS NULL AND NEW.retirement_ref IS NULL)) IS NOT 1 BEGIN\n SELECT RAISE(ABORT,'constraint: source enrollment closed tuple');\nEND",
  financial_source_registration_retire_only:
    "CREATE TRIGGER financial_source_registration_retire_only BEFORE UPDATE ON financial_source_registrations\nWHEN ((NEW.registration_ref IS OLD.registration_ref AND NEW.incarnation IS OLD.incarnation AND NEW.receiver_ref IS OLD.receiver_ref AND NEW.target_ref IS OLD.target_ref AND NEW.genesis_digest IS OLD.genesis_digest) AND (NEW.registration_digest IS OLD.registration_digest AND NEW.registration_json IS OLD.registration_json AND NEW.qualification_ref IS OLD.qualification_ref AND NEW.registered_at IS OLD.registered_at)) IS NOT 1\n OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.retirement_ref IS NULL BEGIN\n SELECT RAISE(ABORT,'constraint: source registration immutable or retirement terminal');\nEND",
  financial_source_head_genesis:
    "CREATE TRIGGER financial_source_head_genesis BEFORE INSERT ON financial_source_heads\nWHEN NEW.sequence<>0 OR NEW.last_event_ref IS NOT NULL OR NEW.state<>'active'\n OR NOT EXISTS(SELECT 1 FROM financial_source_registrations r\n  WHERE r.registration_ref=NEW.registration_ref AND r.incarnation=NEW.incarnation\n   AND r.retired_at IS NULL AND r.genesis_digest=NEW.event_digest) BEGIN\n SELECT RAISE(ABORT,'constraint: explicit enrolled genesis required');\nEND",
  financial_source_event_predecessor:
    "CREATE TRIGGER financial_source_event_predecessor BEFORE INSERT ON financial_source_events\nWHEN NOT EXISTS(SELECT 1 FROM financial_source_registrations r\n JOIN financial_source_heads h ON h.registration_ref=r.registration_ref AND h.incarnation=r.incarnation\n WHERE ((r.registration_ref IS NEW.registration_ref AND r.incarnation IS NEW.incarnation AND r.retired_at IS NULL AND h.affected_ref IS NEW.affected_ref AND h.state IS 'active') AND (h.sequence=NEW.sequence-1 AND h.event_digest IS NEW.previous_digest AND json_type(NEW.event_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.event_json))=9 AND json_extract(NEW.event_json,'$.v') IS 1) AND (json_type(NEW.event_json,'$.v') IS 'integer' AND json_extract(NEW.event_json,'$.eventRef') IS NEW.event_ref AND json_extract(NEW.event_json,'$.registrationRef') IS NEW.registration_ref AND json_extract(NEW.event_json,'$.incarnation') IS NEW.incarnation AND json_extract(NEW.event_json,'$.affectedRef') IS NEW.affected_ref) AND (json_extract(NEW.event_json,'$.sequence') IS NEW.sequence AND json_extract(NEW.event_json,'$.previousDigest') IS NEW.previous_digest AND json_extract(NEW.event_json,'$.kind') IS NEW.kind AND json_extract(NEW.event_json,'$.evidenceRef') IS NEW.evidence_ref AND json_type(NEW.event_json,'$.sequence') IS 'integer') AND (json_type(NEW.event_json,'$.eventRef') IS 'text' AND json_type(NEW.event_json,'$.registrationRef') IS 'text' AND json_type(NEW.event_json,'$.incarnation') IS 'text' AND json_type(NEW.event_json,'$.affectedRef') IS 'text' AND json_type(NEW.event_json,'$.previousDigest') IS 'text') AND (json_type(NEW.event_json,'$.kind') IS 'text' AND json_type(NEW.event_json,'$.evidenceRef') IS 'text'))) BEGIN\n SELECT RAISE(ABORT,'constraint: source event original predecessor or closed tuple');\nEND",
  financial_source_head_advance:
    "CREATE TRIGGER financial_source_head_advance BEFORE UPDATE ON financial_source_heads\nWHEN ((NEW.registration_ref IS OLD.registration_ref AND NEW.incarnation IS OLD.incarnation AND NEW.affected_ref IS OLD.affected_ref AND NEW.genesis_qualification_ref IS OLD.genesis_qualification_ref AND NEW.created_at IS OLD.created_at)) IS NOT 1\n OR OLD.state<>'active' OR NEW.sequence<>OLD.sequence+1\n OR NOT EXISTS(SELECT 1 FROM financial_source_events e JOIN financial_source_registrations r\n  ON r.registration_ref=e.registration_ref AND r.incarnation=e.incarnation\n WHERE ((e.event_ref IS NEW.last_event_ref AND e.registration_ref IS NEW.registration_ref AND e.incarnation IS NEW.incarnation AND e.affected_ref IS NEW.affected_ref AND e.sequence IS NEW.sequence) AND (e.previous_digest IS OLD.event_digest AND e.event_digest IS NEW.event_digest AND r.retired_at IS NULL AND NEW.state IS CASE e.kind WHEN 'close' THEN 'closed' ELSE 'active' END))) BEGIN\n SELECT RAISE(ABORT,'constraint: source head exact one-step monotonic transition');\nEND",
  financial_source_receipt_match:
    "CREATE TRIGGER financial_source_receipt_match BEFORE INSERT ON financial_source_receipts\nWHEN NOT EXISTS(SELECT 1 FROM financial_source_events e\n JOIN financial_source_heads h ON h.registration_ref=e.registration_ref AND h.incarnation=e.incarnation AND h.affected_ref=e.affected_ref\n JOIN financial_source_registrations r ON r.registration_ref=e.registration_ref AND r.incarnation=e.incarnation\n WHERE ((e.event_ref IS NEW.event_ref AND e.registration_ref IS NEW.registration_ref AND e.incarnation IS NEW.incarnation AND e.affected_ref IS NEW.affected_ref AND e.sequence IS NEW.sequence) AND (e.event_digest IS NEW.event_digest AND r.receiver_ref IS NEW.receiver_ref AND r.target_ref IS NEW.target_ref AND r.retired_at IS NULL AND h.sequence IS e.sequence) AND (h.last_event_ref IS e.event_ref AND h.event_digest IS e.event_digest AND h.state IS CASE e.kind WHEN 'close' THEN 'closed' ELSE 'active' END AND NEW.state IS CASE e.kind WHEN 'close' THEN 'admission-closed' ELSE 'advanced' END AND json_type(NEW.receipt_json) IS 'object') AND ((SELECT count(*) FROM json_each(NEW.receipt_json))=7 AND json_extract(NEW.receipt_json,'$.v') IS 1 AND json_type(NEW.receipt_json,'$.v') IS 'integer' AND json_extract(NEW.receipt_json,'$.eventRef') IS NEW.event_ref AND json_extract(NEW.receipt_json,'$.eventDigest') IS NEW.event_digest) AND (json_extract(NEW.receipt_json,'$.receiptRef') IS NEW.receipt_ref AND json_extract(NEW.receipt_json,'$.incarnation') IS NEW.incarnation AND json_extract(NEW.receipt_json,'$.sequence') IS NEW.sequence AND json_extract(NEW.receipt_json,'$.state') IS NEW.state AND json_type(NEW.receipt_json,'$.sequence') IS 'integer') AND (json_type(NEW.receipt_json,'$.eventRef') IS 'text' AND json_type(NEW.receipt_json,'$.eventDigest') IS 'text' AND json_type(NEW.receipt_json,'$.receiptRef') IS 'text' AND json_type(NEW.receipt_json,'$.incarnation') IS 'text' AND json_type(NEW.receipt_json,'$.state') IS 'text'))) BEGIN\n SELECT RAISE(ABORT,'constraint: source receipt exact committed event and head');\nEND",
  financial_source_registrations_no_replace:
    "CREATE TRIGGER financial_source_registrations_no_replace BEFORE INSERT ON financial_source_registrations\nWHEN EXISTS(SELECT 1 FROM financial_source_registrations WHERE registration_ref IS NEW.registration_ref AND (incarnation IS NEW.incarnation OR retired_at IS NULL)) BEGIN\n SELECT RAISE(ABORT,'constraint: retained source row replacement');\nEND",
  financial_source_registrations_no_delete:
    "CREATE TRIGGER financial_source_registrations_no_delete BEFORE DELETE ON financial_source_registrations BEGIN\n SELECT RAISE(ABORT,'constraint: retained source row deletion');\nEND",
  financial_source_heads_no_replace:
    "CREATE TRIGGER financial_source_heads_no_replace BEFORE INSERT ON financial_source_heads\nWHEN EXISTS(SELECT 1 FROM financial_source_heads WHERE registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation AND affected_ref IS NEW.affected_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: retained source row replacement');\nEND",
  financial_source_heads_no_delete:
    "CREATE TRIGGER financial_source_heads_no_delete BEFORE DELETE ON financial_source_heads BEGIN\n SELECT RAISE(ABORT,'constraint: retained source row deletion');\nEND",
  financial_source_events_no_replace:
    "CREATE TRIGGER financial_source_events_no_replace BEFORE INSERT ON financial_source_events\nWHEN EXISTS(SELECT 1 FROM financial_source_events WHERE event_ref IS NEW.event_ref OR (registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation AND affected_ref IS NEW.affected_ref AND sequence IS NEW.sequence)) BEGIN\n SELECT RAISE(ABORT,'constraint: retained source row replacement');\nEND",
  financial_source_events_no_delete:
    "CREATE TRIGGER financial_source_events_no_delete BEFORE DELETE ON financial_source_events BEGIN\n SELECT RAISE(ABORT,'constraint: retained source row deletion');\nEND",
  financial_source_events_no_update:
    "CREATE TRIGGER financial_source_events_no_update BEFORE UPDATE ON financial_source_events BEGIN\n SELECT RAISE(ABORT,'constraint: immutable source event or receipt');\nEND",
  financial_source_receipts_no_replace:
    "CREATE TRIGGER financial_source_receipts_no_replace BEFORE INSERT ON financial_source_receipts\nWHEN EXISTS(SELECT 1 FROM financial_source_receipts WHERE event_ref IS NEW.event_ref OR receipt_ref IS NEW.receipt_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: retained source row replacement');\nEND",
  financial_source_receipts_no_delete:
    "CREATE TRIGGER financial_source_receipts_no_delete BEFORE DELETE ON financial_source_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: retained source row deletion');\nEND",
  financial_source_receipts_no_update:
    "CREATE TRIGGER financial_source_receipts_no_update BEFORE UPDATE ON financial_source_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: immutable source event or receipt');\nEND",
  financial_source_registrations_one_active:
    "CREATE UNIQUE INDEX financial_source_registrations_one_active\n ON financial_source_registrations(registration_ref) WHERE retired_at IS NULL",
});

/** Exact R1 custody core, byte-identical to the retained R1 candidate rows that
 * readyHistorySchema digests (R1_SCHEMA_DIGEST). */
const R1_CORE_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  financial_action_source_registrations:
    "CREATE TABLE financial_action_source_registrations (\n registration_ref TEXT NOT NULL,\n incarnation TEXT NOT NULL,\n registration_digest TEXT NOT NULL,\n digest_recipe TEXT NOT NULL CHECK(digest_recipe='financial-action-registration-canonical-v1'),\n registration_json TEXT NOT NULL CHECK(json_valid(registration_json)),\n created_at TEXT NOT NULL,\n PRIMARY KEY(registration_ref,incarnation),\n CHECK(length(CAST(registration_json AS BLOB)) BETWEEN 2 AND 16384)\n)",
  financial_retained_r1_originals:
    "CREATE TABLE financial_retained_r1_originals (\n r1_ref TEXT PRIMARY KEY NOT NULL,\n challenge_ref TEXT NOT NULL UNIQUE,\n preparation_ref TEXT NOT NULL UNIQUE,\n receipt_ref TEXT NOT NULL UNIQUE,\n command_json TEXT NOT NULL CHECK(json_valid(command_json)),\n original_json TEXT NOT NULL CHECK(json_valid(original_json)),\n original_digest TEXT NOT NULL,\n terms_ref TEXT NOT NULL,\n terms_digest TEXT NOT NULL,\n source_registration_ref TEXT NOT NULL,\n source_registration_digest TEXT NOT NULL,\n source_incarnation TEXT NOT NULL,\n scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),\n CHECK(length(CAST(command_json AS BLOB)) BETWEEN 2 AND 98304),\n FOREIGN KEY(source_registration_ref,source_incarnation)\n   REFERENCES financial_action_source_registrations(registration_ref,incarnation) ON DELETE RESTRICT\n)",
  financial_retained_r1_receipts:
    "CREATE TABLE financial_retained_r1_receipts (\n receipt_ref TEXT PRIMARY KEY NOT NULL,\n r1_ref TEXT NOT NULL UNIQUE,\n challenge_ref TEXT NOT NULL UNIQUE,\n preparation_ref TEXT NOT NULL UNIQUE,\n command_json TEXT NOT NULL CHECK(json_valid(command_json)),\n original_digest TEXT NOT NULL,\n all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),\n FOREIGN KEY(r1_ref) REFERENCES financial_retained_r1_originals(r1_ref) ON DELETE RESTRICT\n)",
  financial_action_source_registrations_no_replace:
    "CREATE TRIGGER financial_action_source_registrations_no_replace BEFORE INSERT ON financial_action_source_registrations\nWHEN EXISTS(SELECT 1 FROM financial_action_source_registrations WHERE registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation) BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 registration replacement');\nEND",
  financial_action_source_registrations_no_update:
    "CREATE TRIGGER financial_action_source_registrations_no_update BEFORE UPDATE ON financial_action_source_registrations BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 registration');\nEND",
  financial_action_source_registrations_no_delete:
    "CREATE TRIGGER financial_action_source_registrations_no_delete BEFORE DELETE ON financial_action_source_registrations BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 registration');\nEND",
  financial_retained_r1_originals_no_replace:
    "CREATE TRIGGER financial_retained_r1_originals_no_replace BEFORE INSERT ON financial_retained_r1_originals\nWHEN EXISTS(SELECT 1 FROM financial_retained_r1_originals WHERE\n r1_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)\n OR challenge_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)\n OR preparation_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)\n OR receipt_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)) BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 original replacement');\nEND",
  financial_retained_r1_originals_no_update:
    "CREATE TRIGGER financial_retained_r1_originals_no_update BEFORE UPDATE ON financial_retained_r1_originals BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 original');\nEND",
  financial_retained_r1_originals_no_delete:
    "CREATE TRIGGER financial_retained_r1_originals_no_delete BEFORE DELETE ON financial_retained_r1_originals BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 original');\nEND",
  financial_retained_r1_receipts_no_replace:
    "CREATE TRIGGER financial_retained_r1_receipts_no_replace BEFORE INSERT ON financial_retained_r1_receipts\nWHEN EXISTS(SELECT 1 FROM financial_retained_r1_receipts WHERE\n r1_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)\n OR challenge_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)\n OR preparation_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)\n OR receipt_ref IN (NEW.r1_ref,NEW.challenge_ref,NEW.preparation_ref,NEW.receipt_ref)) BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 receipt replacement');\nEND",
  financial_retained_r1_receipts_no_update:
    "CREATE TRIGGER financial_retained_r1_receipts_no_update BEFORE UPDATE ON financial_retained_r1_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 receipt');\nEND",
  financial_retained_r1_receipts_no_delete:
    "CREATE TRIGGER financial_retained_r1_receipts_no_delete BEFORE DELETE ON financial_retained_r1_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: immutable R1 receipt');\nEND",
  financial_retained_r1_originals_shape:
    "CREATE TRIGGER financial_retained_r1_originals_shape BEFORE INSERT ON financial_retained_r1_originals\nWHEN NOT (json_type(NEW.command_json) IS 'object'\n AND json_extract(NEW.command_json,'$.key.r1Ref') IS NEW.r1_ref\n AND json_extract(NEW.command_json,'$.key.challengeRef') IS NEW.challenge_ref\n AND json_extract(NEW.command_json,'$.key.preparationRef') IS NEW.preparation_ref\n AND json_extract(NEW.command_json,'$.r1ReceiptRef') IS NEW.receipt_ref\n AND json_extract(NEW.command_json,'$.original') IS NEW.original_json\n AND json_extract(NEW.original_json,'$.r1Ref') IS NEW.r1_ref\n AND json_extract(NEW.original_json,'$.challengeRef') IS NEW.challenge_ref\n AND json_extract(NEW.original_json,'$.preparationRef') IS NEW.preparation_ref\n AND json_extract(NEW.original_json,'$.c0ReceiptRef') IS json_extract(NEW.original_json,'$.c0.receiptRef')\n AND json_extract(NEW.original_json,'$.selectedTerms.ref') IS NEW.terms_ref\n AND json_extract(NEW.original_json,'$.selectedTerms.digest') IS NEW.terms_digest\n AND json_extract(NEW.original_json,'$.actionSource.registrationRef') IS NEW.source_registration_ref\n AND json_extract(NEW.original_json,'$.actionSource.registrationDigest') IS NEW.source_registration_digest\n AND json_extract(NEW.original_json,'$.actionSource.incarnation') IS NEW.source_incarnation\n AND json_extract(NEW.original_json,'$.scopeRealm') IS NEW.scope_json) BEGIN\n SELECT RAISE(ABORT,'constraint: closed R1 original');\nEND",
  financial_retained_r1_receipts_match:
    "CREATE TRIGGER financial_retained_r1_receipts_match BEFORE INSERT ON financial_retained_r1_receipts\nWHEN NOT EXISTS(SELECT 1 FROM financial_retained_r1_originals o\n WHERE o.r1_ref IS NEW.r1_ref AND o.challenge_ref IS NEW.challenge_ref\n AND o.preparation_ref IS NEW.preparation_ref AND o.receipt_ref IS NEW.receipt_ref\n AND o.command_json IS NEW.command_json AND o.original_digest IS NEW.original_digest\n AND EXISTS(SELECT 1 FROM financial_action_source_registrations s\n  WHERE s.registration_ref IS o.source_registration_ref AND s.incarnation IS o.source_incarnation\n  AND s.registration_digest IS o.source_registration_digest)) BEGIN\n SELECT RAISE(ABORT,'constraint: mandatory R1 receipt mismatch');\nEND",
});

/** Exact five-action consent candidate rows. */
const CONSENT_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  shared_customer_challenges:
    "CREATE TABLE shared_customer_challenges (\n challenge_ref TEXT PRIMARY KEY NOT NULL,\n organization_id TEXT NOT NULL,\n action_kind TEXT NOT NULL CHECK(action_kind IN('topup','subscription-start','card-setup','plan-change','cancel')),\n action_ref TEXT NOT NULL, request_fingerprint TEXT NOT NULL,\n action_json TEXT NOT NULL CHECK(json_valid(action_json) AND json_type(action_json)='object'),\n selection_json TEXT NOT NULL CHECK(json_valid(selection_json) AND json_type(selection_json)='object'),\n challenge_json TEXT NOT NULL CHECK(json_valid(challenge_json) AND json_type(challenge_json)='object'),\n receiver_ref TEXT NOT NULL, target_ref TEXT NOT NULL,\n account_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN('test','live')),\n billing_authority TEXT NOT NULL, financial_realm TEXT NOT NULL, writer_epoch TEXT NOT NULL,\n history_ref TEXT NOT NULL, history_digest TEXT NOT NULL,\n source_count INTEGER NOT NULL CHECK(typeof(source_count)='integer' AND source_count BETWEEN 1 AND 9007199254740991),\n created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),\n expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms)='integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991),\n CHECK(expires_at_ms>created_at_ms AND expires_at_ms-created_at_ms<=300000),\n CHECK(length(request_fingerprint)=71 AND substr(request_fingerprint,1,7)='sha256:' AND substr(request_fingerprint,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(length(writer_epoch)=71 AND substr(writer_epoch,1,7)='sha256:' AND substr(writer_epoch,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(length(history_digest)=71 AND substr(history_digest,1,7)='sha256:' AND substr(history_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(length(financial_realm)=70 AND substr(financial_realm,1,6)='realm:' AND substr(financial_realm,7) NOT GLOB '*[^0-9a-f]*'),\n CHECK(length(CAST(action_json AS BLOB)) BETWEEN 2 AND 16384),\n CHECK(length(CAST(selection_json AS BLOB)) BETWEEN 2 AND 16384),\n CHECK(length(CAST(challenge_json AS BLOB)) BETWEEN 2 AND 16384)\n)",
  financial_payer_challenge_sources:
    "CREATE TABLE financial_payer_challenge_sources (\n challenge_ref TEXT NOT NULL,\n registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,\n registration_digest TEXT NOT NULL, registration_qualification_ref TEXT NOT NULL,\n genesis_digest TEXT NOT NULL, genesis_qualification_ref TEXT NOT NULL,\n receiver_ref TEXT NOT NULL, target_ref TEXT NOT NULL,\n sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 0 AND 9007199254740991),\n event_digest TEXT NOT NULL, last_event_ref TEXT,\n PRIMARY KEY(challenge_ref,registration_ref,incarnation,affected_ref),\n FOREIGN KEY(challenge_ref) REFERENCES shared_customer_challenges(challenge_ref) ON DELETE RESTRICT,\n FOREIGN KEY(registration_ref,incarnation,affected_ref) REFERENCES financial_source_heads(registration_ref,incarnation,affected_ref) ON DELETE RESTRICT,\n CHECK((sequence=0 AND last_event_ref IS NULL) OR (sequence>0 AND last_event_ref IS NOT NULL)),\n CHECK(length(registration_digest)=71 AND substr(registration_digest,1,7)='sha256:' AND substr(registration_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(length(genesis_digest)=71 AND substr(genesis_digest,1,7)='sha256:' AND substr(genesis_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(length(event_digest)=71 AND substr(event_digest,1,7)='sha256:' AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*')\n)",
  financial_payer_grants:
    "CREATE TABLE financial_payer_grants (\n grant_ref TEXT PRIMARY KEY NOT NULL, grant_incarnation TEXT NOT NULL UNIQUE,\n challenge_ref TEXT NOT NULL UNIQUE,\n principal_id TEXT NOT NULL, principal_incarnation TEXT NOT NULL, principal_binding_ref TEXT NOT NULL,\n authority_ref TEXT NOT NULL, credential_incarnation TEXT NOT NULL,\n auth_snapshot_json TEXT NOT NULL CHECK(json_valid(auth_snapshot_json) AND json_type(auth_snapshot_json)='object'),\n identity_proof_ref TEXT NOT NULL,\n consent_registration_ref TEXT NOT NULL, consent_incarnation TEXT NOT NULL,\n consent_ref TEXT NOT NULL, consent_proof_ref TEXT NOT NULL, consent_digest TEXT NOT NULL,\n issuance_attempt TEXT NOT NULL UNIQUE, expected_receipt_ref TEXT NOT NULL UNIQUE,\n issued_at TEXT NOT NULL,\n UNIQUE(grant_ref,challenge_ref),\n FOREIGN KEY(challenge_ref) REFERENCES shared_customer_challenges(challenge_ref) ON DELETE RESTRICT,\n FOREIGN KEY(principal_id,principal_incarnation) REFERENCES auth_principal_incarnations(principal_id,principal_incarnation) ON DELETE RESTRICT,\n FOREIGN KEY(principal_binding_ref,principal_id,principal_incarnation) REFERENCES shared_principal_bindings(binding_ref,principal_id,principal_incarnation) ON DELETE RESTRICT,\n FOREIGN KEY(authority_ref) REFERENCES credential_authority_classes(authority_ref) ON DELETE RESTRICT,\n CHECK(length(issued_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',issued_at) IS issued_at),\n CHECK(length(consent_digest)=71 AND substr(consent_digest,1,7)='sha256:' AND substr(consent_digest,8) NOT GLOB '*[^0-9a-f]*'),\n CHECK(length(CAST(auth_snapshot_json AS BLOB)) BETWEEN 2 AND 16384)\n)",
  financial_payer_consent_witnesses:
    "CREATE TABLE financial_payer_consent_witnesses (\n challenge_ref TEXT PRIMARY KEY NOT NULL, grant_ref TEXT NOT NULL UNIQUE,\n consent_registration_ref TEXT NOT NULL, consent_incarnation TEXT NOT NULL, consent_ref TEXT NOT NULL,\n consent_proof_ref TEXT NOT NULL, consent_digest TEXT NOT NULL,\n issuance_attempt TEXT NOT NULL UNIQUE, consumed_at TEXT NOT NULL,\n UNIQUE(challenge_ref,grant_ref),\n UNIQUE(consent_registration_ref,consent_incarnation,consent_ref),\n FOREIGN KEY(grant_ref,challenge_ref) REFERENCES financial_payer_grants(grant_ref,challenge_ref) ON DELETE RESTRICT,\n CHECK(length(consumed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',consumed_at) IS consumed_at),\n CHECK(length(consent_digest)=71 AND substr(consent_digest,1,7)='sha256:' AND substr(consent_digest,8) NOT GLOB '*[^0-9a-f]*')\n)",
  financial_payer_consent_receipts:
    "CREATE TABLE financial_payer_consent_receipts (\n receipt_ref TEXT PRIMARY KEY NOT NULL, grant_ref TEXT NOT NULL UNIQUE,\n challenge_ref TEXT NOT NULL UNIQUE, issuance_attempt TEXT NOT NULL UNIQUE,\n created_at TEXT NOT NULL,\n all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),\n FOREIGN KEY(challenge_ref,grant_ref) REFERENCES financial_payer_consent_witnesses(challenge_ref,grant_ref) ON DELETE RESTRICT,\n CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)\n)",
  financial_payer_grant_revocations:
    "CREATE TABLE financial_payer_grant_revocations (\n grant_ref TEXT PRIMARY KEY NOT NULL, revocation_ref TEXT NOT NULL UNIQUE,\n reason TEXT NOT NULL, authority_evidence_ref TEXT NOT NULL, revoked_at TEXT NOT NULL,\n FOREIGN KEY(grant_ref) REFERENCES financial_payer_grants(grant_ref) ON DELETE RESTRICT,\n CHECK(length(reason) BETWEEN 1 AND 256),\n CHECK(length(revoked_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS revoked_at)\n)",
  shared_customer_challenges_closed:
    "CREATE TRIGGER shared_customer_challenges_closed BEFORE INSERT ON shared_customer_challenges\nWHEN ((SELECT count(*) FROM json_each(NEW.challenge_json))=10\n AND json_extract(NEW.challenge_json,'$.v') IS 1 AND json_type(NEW.challenge_json,'$.v') IS 'integer'\n AND json_extract(NEW.challenge_json,'$.challengeRef') IS NEW.challenge_ref\n AND json_extract(NEW.challenge_json,'$.organizationId') IS NEW.organization_id\n AND json_extract(NEW.challenge_json,'$.requestFingerprint') IS NEW.request_fingerprint\n AND json_type(NEW.challenge_json,'$.createdAt') IS 'integer'\n AND json_extract(NEW.challenge_json,'$.createdAt') IS NEW.created_at_ms\n AND json_type(NEW.challenge_json,'$.expiresAt') IS 'integer'\n AND json_extract(NEW.challenge_json,'$.expiresAt') IS NEW.expires_at_ms\n AND json_type(NEW.challenge_json,'$.registrationRef') IS 'text'\n AND json_type(NEW.challenge_json,'$.clientId') IS 'text'\n AND json_type(NEW.challenge_json,'$.workspaceId') IS 'text'\n AND json_type(NEW.challenge_json,'$.workspaceRef') IS 'text'\n AND json_type(NEW.selection_json,'$.auth') IS 'object'\n AND json_type(NEW.selection_json,'$.auth.human') IS 'object'\n AND json_type(NEW.selection_json,'$.auth.credential') IS 'object') IS NOT 1 BEGIN\n SELECT RAISE(ABORT,'constraint: exact original ten-field challenge');\nEND",
  financial_payer_sources_before_grant:
    "CREATE TRIGGER financial_payer_sources_before_grant BEFORE INSERT ON financial_payer_challenge_sources\nWHEN EXISTS(SELECT 1 FROM financial_payer_grants WHERE challenge_ref IS NEW.challenge_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: original source vector sealed by grant');\nEND",
  financial_payer_grants_exact_context:
    "CREATE TRIGGER financial_payer_grants_exact_context BEFORE INSERT ON financial_payer_grants\nWHEN (json_extract(NEW.auth_snapshot_json,'$.human.ref') IS NEW.principal_binding_ref\n AND json_extract(NEW.auth_snapshot_json,'$.human.principalId') IS NEW.principal_id\n AND json_extract(NEW.auth_snapshot_json,'$.human.principalIncarnation') IS NEW.principal_incarnation\n AND json_extract(NEW.auth_snapshot_json,'$.credential.origin.ref') IS NEW.authority_ref\n AND json_extract(NEW.auth_snapshot_json,'$.credential.origin.incarnation') IS NEW.credential_incarnation\n AND json_type(NEW.auth_snapshot_json,'$.human') IS 'object'\n AND json_type(NEW.auth_snapshot_json,'$.credential') IS 'object'\n AND EXISTS(SELECT 1 FROM shared_customer_challenges c WHERE c.challenge_ref IS NEW.challenge_ref\n AND json_extract(c.selection_json,'$.auth.human') IS json_extract(NEW.auth_snapshot_json,'$.human')\n AND json_extract(c.selection_json,'$.auth.credential') IS json_extract(NEW.auth_snapshot_json,'$.credential'))) IS NOT 1 BEGIN\n SELECT RAISE(ABORT,'constraint: retained Auth snapshot exact original tuple');\nEND",
  financial_payer_consent_exact_grant:
    "CREATE TRIGGER financial_payer_consent_exact_grant BEFORE INSERT ON financial_payer_consent_witnesses\nWHEN NOT EXISTS(SELECT 1 FROM financial_payer_grants g WHERE\n (g.grant_ref IS NEW.grant_ref AND g.challenge_ref IS NEW.challenge_ref\n AND g.consent_registration_ref IS NEW.consent_registration_ref AND g.consent_incarnation IS NEW.consent_incarnation)\n AND (g.consent_ref IS NEW.consent_ref AND g.consent_proof_ref IS NEW.consent_proof_ref\n AND g.consent_digest IS NEW.consent_digest AND g.issuance_attempt IS NEW.issuance_attempt AND g.issued_at IS NEW.consumed_at)) BEGIN\n SELECT RAISE(ABORT,'constraint: original consent consumed by exact grant winner');\nEND",
  financial_payer_receipt_exact_winner:
    "CREATE TRIGGER financial_payer_receipt_exact_winner BEFORE INSERT ON financial_payer_consent_receipts\nWHEN NOT EXISTS(SELECT 1 FROM financial_payer_grants g JOIN financial_payer_consent_witnesses w\n ON w.challenge_ref=g.challenge_ref AND w.grant_ref=g.grant_ref WHERE\n (g.grant_ref IS NEW.grant_ref AND g.challenge_ref IS NEW.challenge_ref\n AND g.issuance_attempt IS NEW.issuance_attempt AND g.expected_receipt_ref IS NEW.receipt_ref)\n AND (w.issuance_attempt IS g.issuance_attempt AND g.issued_at IS NEW.created_at\n AND w.consent_registration_ref IS g.consent_registration_ref AND w.consent_incarnation IS g.consent_incarnation\n AND w.consent_ref IS g.consent_ref AND w.consent_proof_ref IS g.consent_proof_ref AND w.consent_digest IS g.consent_digest)) BEGIN\n SELECT RAISE(ABORT,'constraint: mandatory consent receipt exact consumed winner');\nEND",
  financial_payer_revoke_accepted:
    "CREATE TRIGGER financial_payer_revoke_accepted BEFORE INSERT ON financial_payer_grant_revocations\nWHEN NOT EXISTS(SELECT 1 FROM financial_payer_grants g JOIN financial_payer_consent_receipts r\n ON r.grant_ref=g.grant_ref WHERE g.grant_ref IS NEW.grant_ref AND NEW.revoked_at>=g.issued_at) BEGIN\n SELECT RAISE(ABORT,'constraint: revoke only retained accepted grant');\nEND",
  shared_customer_challenges_no_replace:
    "CREATE TRIGGER shared_customer_challenges_no_replace BEFORE INSERT ON shared_customer_challenges\nWHEN EXISTS(SELECT 1 FROM shared_customer_challenges WHERE challenge_ref IS NEW.challenge_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row replacement');\nEND",
  shared_customer_challenges_no_update:
    "CREATE TRIGGER shared_customer_challenges_no_update BEFORE UPDATE ON shared_customer_challenges BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row immutable');\nEND",
  shared_customer_challenges_no_delete:
    "CREATE TRIGGER shared_customer_challenges_no_delete BEFORE DELETE ON shared_customer_challenges BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent history deletion');\nEND",
  financial_payer_challenge_sources_no_replace:
    "CREATE TRIGGER financial_payer_challenge_sources_no_replace BEFORE INSERT ON financial_payer_challenge_sources\nWHEN EXISTS(SELECT 1 FROM financial_payer_challenge_sources WHERE challenge_ref IS NEW.challenge_ref AND registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation AND affected_ref IS NEW.affected_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row replacement');\nEND",
  financial_payer_challenge_sources_no_update:
    "CREATE TRIGGER financial_payer_challenge_sources_no_update BEFORE UPDATE ON financial_payer_challenge_sources BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row immutable');\nEND",
  financial_payer_challenge_sources_no_delete:
    "CREATE TRIGGER financial_payer_challenge_sources_no_delete BEFORE DELETE ON financial_payer_challenge_sources BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent history deletion');\nEND",
  financial_payer_grants_no_replace:
    "CREATE TRIGGER financial_payer_grants_no_replace BEFORE INSERT ON financial_payer_grants\nWHEN EXISTS(SELECT 1 FROM financial_payer_grants WHERE grant_ref IS NEW.grant_ref OR grant_incarnation IS NEW.grant_incarnation OR challenge_ref IS NEW.challenge_ref OR issuance_attempt IS NEW.issuance_attempt OR expected_receipt_ref IS NEW.expected_receipt_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row replacement');\nEND",
  financial_payer_grants_no_update:
    "CREATE TRIGGER financial_payer_grants_no_update BEFORE UPDATE ON financial_payer_grants BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row immutable');\nEND",
  financial_payer_grants_no_delete:
    "CREATE TRIGGER financial_payer_grants_no_delete BEFORE DELETE ON financial_payer_grants BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent history deletion');\nEND",
  financial_payer_consent_witnesses_no_replace:
    "CREATE TRIGGER financial_payer_consent_witnesses_no_replace BEFORE INSERT ON financial_payer_consent_witnesses\nWHEN EXISTS(SELECT 1 FROM financial_payer_consent_witnesses WHERE challenge_ref IS NEW.challenge_ref OR grant_ref IS NEW.grant_ref OR issuance_attempt IS NEW.issuance_attempt OR (consent_registration_ref IS NEW.consent_registration_ref AND consent_incarnation IS NEW.consent_incarnation AND consent_ref IS NEW.consent_ref)) BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row replacement');\nEND",
  financial_payer_consent_witnesses_no_update:
    "CREATE TRIGGER financial_payer_consent_witnesses_no_update BEFORE UPDATE ON financial_payer_consent_witnesses BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row immutable');\nEND",
  financial_payer_consent_witnesses_no_delete:
    "CREATE TRIGGER financial_payer_consent_witnesses_no_delete BEFORE DELETE ON financial_payer_consent_witnesses BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent history deletion');\nEND",
  financial_payer_consent_receipts_no_replace:
    "CREATE TRIGGER financial_payer_consent_receipts_no_replace BEFORE INSERT ON financial_payer_consent_receipts\nWHEN EXISTS(SELECT 1 FROM financial_payer_consent_receipts WHERE receipt_ref IS NEW.receipt_ref OR grant_ref IS NEW.grant_ref OR challenge_ref IS NEW.challenge_ref OR issuance_attempt IS NEW.issuance_attempt) BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row replacement');\nEND",
  financial_payer_consent_receipts_no_update:
    "CREATE TRIGGER financial_payer_consent_receipts_no_update BEFORE UPDATE ON financial_payer_consent_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row immutable');\nEND",
  financial_payer_consent_receipts_no_delete:
    "CREATE TRIGGER financial_payer_consent_receipts_no_delete BEFORE DELETE ON financial_payer_consent_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent history deletion');\nEND",
  financial_payer_grant_revocations_no_replace:
    "CREATE TRIGGER financial_payer_grant_revocations_no_replace BEFORE INSERT ON financial_payer_grant_revocations\nWHEN EXISTS(SELECT 1 FROM financial_payer_grant_revocations WHERE grant_ref IS NEW.grant_ref OR revocation_ref IS NEW.revocation_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row replacement');\nEND",
  financial_payer_grant_revocations_no_update:
    "CREATE TRIGGER financial_payer_grant_revocations_no_update BEFORE UPDATE ON financial_payer_grant_revocations BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent row immutable');\nEND",
  financial_payer_grant_revocations_no_delete:
    "CREATE TRIGGER financial_payer_grant_revocations_no_delete BEFORE DELETE ON financial_payer_grant_revocations BEGIN\n SELECT RAISE(ABORT,'constraint: retained consent history deletion');\nEND",
});

export interface Financial0104Object {
  readonly type: "table" | "trigger" | "index";
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

function objects(schema: Readonly<Record<string, string>>): readonly Financial0104Object[] {
  return Object.entries(schema).map(([name, sql]) => {
    const match =
      /^CREATE (TABLE|TRIGGER|UNIQUE INDEX|INDEX) ([A-Za-z0-9_]+)\b(?:[\s\S]*?\bON ([A-Za-z0-9_]+)\b)?/u.exec(
        sql,
      );
    const type =
      match?.[1] === "TABLE"
        ? "table"
        : match?.[1] === "TRIGGER"
          ? "trigger"
          : match?.[1] === "UNIQUE INDEX" || match?.[1] === "INDEX"
            ? "index"
            : undefined;
    const table = type === "table" ? match?.[2] : match?.[3];
    if (!type || match?.[2] !== name || table === undefined)
      throw new TypeError("Financial 0104 object is not one closed table/trigger/index");
    return Object.freeze({ type, name, tbl_name: table, sql });
  });
}

/** Source order: receivers and their fences; C0/M, G, their fences; R1 with its
 * fences; R1 attempt leaf; consent with its fences; Customer L1, H0 and journal
 * with their fences. Each table precedes every trigger or index on it. */
export const FINANCIAL_0104_OBJECTS: readonly Financial0104Object[] = Object.freeze([
  ...objects(RECEIVER_SCHEMA),
  ...objects(FINANCIAL_0104_RECEIVER_FENCE_SCHEMA),
  ...objects(FINANCIAL_SOURCE_ENROLLMENT_SCHEMA),
  ...objects(FINANCIAL_GENESIS_SCHEMA),
  ...objects(FINANCIAL_0104_C0_FENCE_SCHEMA),
  ...objects(R1_CORE_SCHEMA),
  ...objects(FINANCIAL_R1_FENCE_SCHEMA),
  ...objects(Object.fromEntries(FINANCIAL_R1_ATTEMPT_OBJECTS.map((o) => [o.name, o.sql]))),
  ...objects(CONSENT_SCHEMA),
  ...objects(FINANCIAL_0104_CONSENT_FENCE_SCHEMA),
  ...objects(FINANCIAL_0104_CUSTOMER_L1_SCHEMA),
  ...objects(FINANCIAL_0104_CUSTOMER_H0_SCHEMA),
  ...objects(FINANCIAL_0104_CUSTOMER_JOURNAL_SCHEMA),
  ...objects(FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA),
]);

export const FINANCIAL_0104_TABLES: readonly string[] = Object.freeze(
  FINANCIAL_0104_OBJECTS.filter((o) => o.type === "table").map((o) => o.name),
);

/** The INSERT money fence of every fenced 0104 table, keyed by table. */
export const FINANCIAL_0104_MONEY_FENCES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    FINANCIAL_0104_OBJECTS.filter(
      (o) => o.type === "trigger" && o.name === `${o.tbl_name}_money_fence`,
    ).map((o) => [o.tbl_name, o.name]),
  ),
);

/** The UPDATE money fence of each 0104 table that admits an UPDATE at all. */
export const FINANCIAL_0104_MONEY_UPDATE_FENCES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    FINANCIAL_0104_OBJECTS.filter(
      (o) => o.type === "trigger" && o.name === `${o.tbl_name}_money_fence_update`,
    ).map((o) => [o.tbl_name, o.name]),
  ),
);

/** The exact migration body, one statement per object, in source order. */
export const FINANCIAL_0104_DDL = `${FINANCIAL_0104_OBJECTS.map((o) => `${o.sql};`).join("\n")}\n`;

/** Read-only catalog projection over every 0104-owned table's schema objects. */
export const FINANCIAL_0104_CATALOG_QUERY = `SELECT type, name, tbl_name, sql
FROM main.sqlite_schema WHERE sql IS NOT NULL AND tbl_name IN (${FINANCIAL_0104_TABLES.map((t) => `'${t}'`).join(", ")})
ORDER BY type COLLATE BINARY, name COLLATE BINARY`;

export interface Financial0104SourceRecipe {
  readonly version: typeof FINANCIAL_0104_RECIPE_VERSION;
  readonly name: typeof FINANCIAL_0104_MIGRATION;
  readonly predecessor: typeof FINANCIAL_0104_PREDECESSOR;
  readonly sql: string;
  readonly recipeDigest: `sha256:${string}`;
  readonly catalogProjection: readonly (readonly [string, string, string])[];
}

/** sha256 over the exact UTF-8 migration body, as Auth103 digests its 0103 body. */
export async function financial0104RecipeDigest(): Promise<`sha256:${string}`> {
  return bytesDigest(new TextEncoder().encode(FINANCIAL_0104_DDL));
}

/** Fixed owner recipe DATA for Root's later registration; it applies nothing. */
export async function createFinancial0104SourceRecipe(): Promise<Financial0104SourceRecipe> {
  return Object.freeze({
    version: FINANCIAL_0104_RECIPE_VERSION,
    name: FINANCIAL_0104_MIGRATION,
    predecessor: FINANCIAL_0104_PREDECESSOR,
    sql: FINANCIAL_0104_DDL,
    recipeDigest: await financial0104RecipeDigest(),
    catalogProjection: Object.freeze(
      FINANCIAL_0104_OBJECTS.map((o) => Object.freeze([o.type, o.name, o.tbl_name] as const)),
    ),
  });
}
