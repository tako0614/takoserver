import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { canonicalDigest } from "./json.ts";
import { type Clock, type Sql, SqlError, type SqlParam, type SqlStatement } from "./ports.ts";
import {
  canonicalFinancialSourceJson,
  type FinancialIdentityChallenge,
  type FinancialSourceDigest,
  type FinancialSourceMaterialization,
  type FinancialSourceRegistration,
  financialSourceDigest,
  financialSourceEventDigest,
  financialSourceRef,
  parseFinancialIdentityChallenge,
  parseFinancialSourceMaterialization,
  parseFinancialSourceRegistration,
} from "./shared-financial-source-contract.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";

/** PRIVATE unmounted component. These data parsers do not qualify an issuer, peer,
 * registration origin, caller, payer, role-complete group, or Financial Principal.
 * The missing genuine pre-proof M caller/custody binding must be implemented by
 * Financial's owning composition before this component can be mounted. */
const SCHEMA: Readonly<Record<string, string>> = {
  financial_preproof_challenges:
    "CREATE TABLE financial_preproof_challenges (\n challenge_ref TEXT PRIMARY KEY NOT NULL,\n preparation_ref TEXT NOT NULL UNIQUE,\n challenge_json TEXT NOT NULL CHECK(json_valid(challenge_json)),\n scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),\n record_json TEXT NOT NULL CHECK(json_valid(record_json)),\n created_at TEXT NOT NULL,\n CHECK(length(CAST(record_json AS BLOB)) BETWEEN 2 AND 32768),\n CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)\n)",
  financial_preproof_challenge_receipts:
    "CREATE TABLE financial_preproof_challenge_receipts (\n receipt_ref TEXT PRIMARY KEY NOT NULL,\n challenge_ref TEXT NOT NULL UNIQUE,\n preparation_ref TEXT NOT NULL UNIQUE,\n record_json TEXT NOT NULL CHECK(json_valid(record_json)),\n all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),\n FOREIGN KEY(challenge_ref) REFERENCES financial_preproof_challenges(challenge_ref) ON DELETE RESTRICT\n)",
  financial_source_materializations:
    "CREATE TABLE financial_source_materializations (\n materialization_ref TEXT PRIMARY KEY NOT NULL,\n command_ref TEXT NOT NULL UNIQUE,\n registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,\n source_json TEXT NOT NULL CHECK(json_valid(source_json)),\n record_json TEXT NOT NULL CHECK(json_valid(record_json)),\n genesis_qualification_ref TEXT NOT NULL,\n created_at TEXT NOT NULL,\n UNIQUE(registration_ref,incarnation,affected_ref),\n CHECK(length(CAST(record_json AS BLOB)) BETWEEN 2 AND 32768),\n CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)\n)",
  financial_source_materialization_receipts:
    "CREATE TABLE financial_source_materialization_receipts (\n receipt_ref TEXT PRIMARY KEY NOT NULL,\n materialization_ref TEXT NOT NULL UNIQUE,\n command_ref TEXT NOT NULL UNIQUE,\n registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL, affected_ref TEXT NOT NULL,\n record_json TEXT NOT NULL CHECK(json_valid(record_json)),\n all_rows_match INTEGER NOT NULL CHECK(typeof(all_rows_match)='integer' AND all_rows_match=1),\n FOREIGN KEY(materialization_ref) REFERENCES financial_source_materializations(materialization_ref) ON DELETE RESTRICT,\n FOREIGN KEY(registration_ref,incarnation,affected_ref) REFERENCES financial_source_heads(registration_ref,incarnation,affected_ref) ON DELETE RESTRICT\n)",
  financial_preproof_challenges_no_replace:
    "CREATE TRIGGER financial_preproof_challenges_no_replace BEFORE INSERT ON financial_preproof_challenges\nWHEN EXISTS(SELECT 1 FROM financial_preproof_challenges WHERE challenge_ref IS NEW.challenge_ref OR preparation_ref IS NEW.preparation_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment replacement');\nEND",
  financial_preproof_challenges_no_update:
    "CREATE TRIGGER financial_preproof_challenges_no_update BEFORE UPDATE ON financial_preproof_challenges BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment original');\nEND",
  financial_preproof_challenges_no_delete:
    "CREATE TRIGGER financial_preproof_challenges_no_delete BEFORE DELETE ON financial_preproof_challenges BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment original');\nEND",
  financial_preproof_challenge_receipts_no_replace:
    "CREATE TRIGGER financial_preproof_challenge_receipts_no_replace BEFORE INSERT ON financial_preproof_challenge_receipts\nWHEN EXISTS(SELECT 1 FROM financial_preproof_challenge_receipts WHERE receipt_ref IS NEW.receipt_ref OR challenge_ref IS NEW.challenge_ref OR preparation_ref IS NEW.preparation_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment replacement');\nEND",
  financial_preproof_challenge_receipts_no_update:
    "CREATE TRIGGER financial_preproof_challenge_receipts_no_update BEFORE UPDATE ON financial_preproof_challenge_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment original');\nEND",
  financial_preproof_challenge_receipts_no_delete:
    "CREATE TRIGGER financial_preproof_challenge_receipts_no_delete BEFORE DELETE ON financial_preproof_challenge_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment original');\nEND",
  financial_source_materializations_no_replace:
    "CREATE TRIGGER financial_source_materializations_no_replace BEFORE INSERT ON financial_source_materializations\nWHEN EXISTS(SELECT 1 FROM financial_source_materializations WHERE materialization_ref IS NEW.materialization_ref OR command_ref IS NEW.command_ref OR (registration_ref IS NEW.registration_ref AND incarnation IS NEW.incarnation AND affected_ref IS NEW.affected_ref)) BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment replacement');\nEND",
  financial_source_materializations_no_update:
    "CREATE TRIGGER financial_source_materializations_no_update BEFORE UPDATE ON financial_source_materializations BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment original');\nEND",
  financial_source_materializations_no_delete:
    "CREATE TRIGGER financial_source_materializations_no_delete BEFORE DELETE ON financial_source_materializations BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment original');\nEND",
  financial_source_materialization_receipts_no_replace:
    "CREATE TRIGGER financial_source_materialization_receipts_no_replace BEFORE INSERT ON financial_source_materialization_receipts\nWHEN EXISTS(SELECT 1 FROM financial_source_materialization_receipts WHERE receipt_ref IS NEW.receipt_ref OR materialization_ref IS NEW.materialization_ref OR command_ref IS NEW.command_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment replacement');\nEND",
  financial_source_materialization_receipts_no_update:
    "CREATE TRIGGER financial_source_materialization_receipts_no_update BEFORE UPDATE ON financial_source_materialization_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment original');\nEND",
  financial_source_materialization_receipts_no_delete:
    "CREATE TRIGGER financial_source_materialization_receipts_no_delete BEFORE DELETE ON financial_source_materialization_receipts BEGIN\n SELECT RAISE(ABORT,'constraint: immutable enrollment original');\nEND",
  financial_preproof_challenges_shape:
    "CREATE TRIGGER financial_preproof_challenges_shape BEFORE INSERT ON financial_preproof_challenges\nWHEN ((json_type(NEW.record_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.record_json))=5\n AND json_extract(NEW.record_json,'$.preparationRef') IS NEW.preparation_ref\n AND json_type(NEW.record_json,'$.receiptRef') IS 'text'\n AND json_extract(NEW.record_json,'$.challenge') IS NEW.challenge_json\n AND json_extract(NEW.record_json,'$.scope') IS NEW.scope_json)\n AND (json_type(NEW.challenge_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.challenge_json))=10\n AND json_extract(NEW.challenge_json,'$.challengeRef') IS NEW.challenge_ref\n AND json_extract(NEW.challenge_json,'$.v') IS 1\n AND json_type(NEW.record_json,'$.selection') IS 'object')) IS NOT 1 BEGIN\n SELECT RAISE(ABORT,'constraint: closed C0 original');\nEND",
  financial_preproof_challenge_receipts_match:
    "CREATE TRIGGER financial_preproof_challenge_receipts_match BEFORE INSERT ON financial_preproof_challenge_receipts\nWHEN NOT EXISTS(SELECT 1 FROM financial_preproof_challenges c\n WHERE c.challenge_ref IS NEW.challenge_ref AND c.preparation_ref IS NEW.preparation_ref\n AND c.record_json IS NEW.record_json\n AND json_extract(c.record_json,'$.receiptRef') IS NEW.receipt_ref) BEGIN\n SELECT RAISE(ABORT,'constraint: C0 receipt original');\nEND",
  financial_source_materializations_shape:
    "CREATE TRIGGER financial_source_materializations_shape BEFORE INSERT ON financial_source_materializations\nWHEN ((json_type(NEW.record_json) IS 'object' AND (SELECT count(*) FROM json_each(NEW.record_json))=7\n AND json_extract(NEW.record_json,'$.materializationRef') IS NEW.materialization_ref\n AND json_extract(NEW.record_json,'$.commandRef') IS NEW.command_ref\n AND json_type(NEW.record_json,'$.receiptRef') IS 'text')\n AND (json_extract(NEW.record_json,'$.source') IS NEW.source_json\n AND json_extract(NEW.record_json,'$.affectedRef') IS NEW.affected_ref\n AND json_extract(NEW.record_json,'$.genesisQualificationRef') IS NEW.genesis_qualification_ref\n AND json_extract(NEW.source_json,'$.registration.registrationRef') IS NEW.registration_ref\n AND json_extract(NEW.source_json,'$.registration.incarnation') IS NEW.incarnation)) IS NOT 1 BEGIN\n SELECT RAISE(ABORT,'constraint: closed M original');\nEND",
  financial_source_materialization_receipts_match:
    "CREATE TRIGGER financial_source_materialization_receipts_match BEFORE INSERT ON financial_source_materialization_receipts\nWHEN NOT EXISTS(SELECT 1 FROM financial_source_materializations m\n JOIN financial_source_registrations r ON r.registration_ref=m.registration_ref AND r.incarnation=m.incarnation\n JOIN financial_source_heads h ON h.registration_ref=m.registration_ref AND h.incarnation=m.incarnation AND h.affected_ref=m.affected_ref\n WHERE ((m.materialization_ref IS NEW.materialization_ref AND m.command_ref IS NEW.command_ref\n AND m.registration_ref IS NEW.registration_ref AND m.incarnation IS NEW.incarnation\n AND m.affected_ref IS NEW.affected_ref AND m.record_json IS NEW.record_json)\n AND (json_extract(m.record_json,'$.receiptRef') IS NEW.receipt_ref\n AND r.registration_json IS json_extract(m.source_json,'$.registration')\n AND r.registration_digest IS json_extract(m.source_json,'$.registrationDigest')\n AND r.qualification_ref IS json_extract(m.source_json,'$.qualificationRef') AND r.retired_at IS NULL)\n AND (h.sequence=0 AND h.event_digest IS r.genesis_digest AND h.last_event_ref IS NULL\n AND h.state IS 'active' AND h.genesis_qualification_ref IS m.genesis_qualification_ref\n AND h.created_at IS m.created_at))) BEGIN\n SELECT RAISE(ABORT,'constraint: M receipt original genesis');\nEND",
  financial_preproof_challenges_refs:
    "CREATE TRIGGER financial_preproof_challenges_refs BEFORE INSERT ON financial_preproof_challenges\nWHEN (typeof(NEW.challenge_ref) IS NOT 'text' OR length(NEW.challenge_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.challenge_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.challenge_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.preparation_ref) IS NOT 'text' OR length(NEW.preparation_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.preparation_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.preparation_ref GLOB '*[^A-Za-z0-9._:/-]*') BEGIN\n SELECT RAISE(ABORT,'constraint: enrollment reference');\nEND",
  financial_preproof_challenge_receipts_refs:
    "CREATE TRIGGER financial_preproof_challenge_receipts_refs BEFORE INSERT ON financial_preproof_challenge_receipts\nWHEN (typeof(NEW.receipt_ref) IS NOT 'text' OR length(NEW.receipt_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.receipt_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.receipt_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.challenge_ref) IS NOT 'text' OR length(NEW.challenge_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.challenge_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.challenge_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.preparation_ref) IS NOT 'text' OR length(NEW.preparation_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.preparation_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.preparation_ref GLOB '*[^A-Za-z0-9._:/-]*') BEGIN\n SELECT RAISE(ABORT,'constraint: enrollment reference');\nEND",
  financial_source_materializations_refs:
    "CREATE TRIGGER financial_source_materializations_refs BEFORE INSERT ON financial_source_materializations\nWHEN (typeof(NEW.materialization_ref) IS NOT 'text' OR length(NEW.materialization_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.materialization_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.materialization_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.command_ref) IS NOT 'text' OR length(NEW.command_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.command_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.command_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.registration_ref) IS NOT 'text' OR length(NEW.registration_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.registration_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.registration_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.incarnation) IS NOT 'text' OR length(NEW.incarnation) NOT BETWEEN 1 AND 256 OR substr(NEW.incarnation,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.incarnation GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.affected_ref) IS NOT 'text' OR length(NEW.affected_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.affected_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.affected_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.genesis_qualification_ref) IS NOT 'text' OR length(NEW.genesis_qualification_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.genesis_qualification_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.genesis_qualification_ref GLOB '*[^A-Za-z0-9._:/-]*') BEGIN\n SELECT RAISE(ABORT,'constraint: enrollment reference');\nEND",
  financial_source_materialization_receipts_refs:
    "CREATE TRIGGER financial_source_materialization_receipts_refs BEFORE INSERT ON financial_source_materialization_receipts\nWHEN (typeof(NEW.receipt_ref) IS NOT 'text' OR length(NEW.receipt_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.receipt_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.receipt_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.materialization_ref) IS NOT 'text' OR length(NEW.materialization_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.materialization_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.materialization_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.command_ref) IS NOT 'text' OR length(NEW.command_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.command_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.command_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.registration_ref) IS NOT 'text' OR length(NEW.registration_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.registration_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.registration_ref GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.incarnation) IS NOT 'text' OR length(NEW.incarnation) NOT BETWEEN 1 AND 256 OR substr(NEW.incarnation,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.incarnation GLOB '*[^A-Za-z0-9._:/-]*') OR (typeof(NEW.affected_ref) IS NOT 'text' OR length(NEW.affected_ref) NOT BETWEEN 1 AND 256 OR substr(NEW.affected_ref,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.affected_ref GLOB '*[^A-Za-z0-9._:/-]*') BEGIN\n SELECT RAISE(ABORT,'constraint: enrollment reference');\nEND",
};
const RECEIVER_SCHEMA_DIGEST =
  "sha256:78273f494a3823217edf12e06f06eb4803860452d02278e097a2662befca387b";
export const FINANCIAL_SOURCE_ENROLLMENT_DDL = `${Object.values(SCHEMA).join(";\n")};\n`;

export class FinancialSourceEnrollmentError extends Error {
  constructor(
    readonly code: "invalid_request" | "conflict" | "unavailable",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "FinancialSourceEnrollmentError";
  }
}
function fail(code: FinancialSourceEnrollmentError["code"], cause?: unknown): never {
  throw new FinancialSourceEnrollmentError(code, cause === undefined ? undefined : { cause });
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("invalid_request");
  return value as Record<string, unknown>;
}
function ref(value: unknown): string {
  if (!financialSourceRef(value)) fail("invalid_request");
  return value;
}
function digest(value: unknown): FinancialSourceDigest {
  if (!financialSourceDigest(value)) fail("invalid_request");
  return value;
}
function iso(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid_request");
  return value;
}
/** Snapshot before any await; includes the frozen codec's accessor/sparse-array rejection. */
function snapshot(value: unknown): unknown {
  try {
    const json = canonicalFinancialSourceJson(value);
    if (new TextEncoder().encode(json).byteLength > 32_768) fail("invalid_request");
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof FinancialSourceEnrollmentError) throw error;
    return fail("invalid_request", error);
  }
}
function json(value: unknown): string {
  return canonicalFinancialSourceJson(value);
}

export interface FinancialPreproofScope {
  readonly registrationRef: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly workspaceRef: string;
}
function parseScope(value: unknown): FinancialPreproofScope {
  const r = record(value, [
    "registrationRef",
    "clientId",
    "workspaceId",
    "organizationId",
    "workspaceRef",
  ]);
  return {
    registrationRef: ref(r.registrationRef),
    clientId: ref(r.clientId),
    workspaceId: ref(r.workspaceId),
    organizationId: ref(r.organizationId),
    workspaceRef: ref(r.workspaceRef),
  };
}
/** Retained original data only. No fields in this type confer authenticated caller or payer authority. */
export interface FinancialPreproofSelection {
  readonly action: {
    readonly kind: string;
    readonly ref: string;
    readonly body: unknown;
    readonly requestFingerprint: FinancialSourceDigest;
  };
  readonly customer: {
    readonly requestRef: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: FinancialSourceDigest;
    readonly financialRealm: string;
  };
  readonly business: { readonly ref: string; readonly requestFingerprint: FinancialSourceDigest };
  readonly terms: { readonly ref: string; readonly digest: FinancialSourceDigest };
  readonly carrier: {
    readonly issuerRef: string;
    readonly requestRef: string;
    readonly carrierRef: string;
    readonly contextRef: string;
    readonly createdAt: string;
  };
  readonly billingBinding: {
    readonly bindingRef: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly workspaceRef: string;
  };
}
function parseSelection(value: unknown): FinancialPreproofSelection {
  const r = record(value, ["action", "customer", "business", "terms", "carrier", "billingBinding"]);
  const a = record(r.action, ["kind", "ref", "body", "requestFingerprint"]);
  const c = record(r.customer, [
    "requestRef",
    "idempotencyKey",
    "requestFingerprint",
    "financialRealm",
  ]);
  const b = record(r.business, ["ref", "requestFingerprint"]),
    t = record(r.terms, ["ref", "digest"]);
  const h = record(r.carrier, ["issuerRef", "requestRef", "carrierRef", "contextRef", "createdAt"]);
  const w = record(r.billingBinding, [
    "bindingRef",
    "organizationId",
    "workspaceId",
    "workspaceRef",
  ]);
  return {
    action: {
      kind: ref(a.kind),
      ref: ref(a.ref),
      body: a.body,
      requestFingerprint: digest(a.requestFingerprint),
    },
    customer: {
      requestRef: ref(c.requestRef),
      idempotencyKey: ref(c.idempotencyKey),
      requestFingerprint: digest(c.requestFingerprint),
      financialRealm: ref(c.financialRealm),
    },
    business: { ref: ref(b.ref), requestFingerprint: digest(b.requestFingerprint) },
    terms: { ref: ref(t.ref), digest: digest(t.digest) },
    carrier: {
      issuerRef: ref(h.issuerRef),
      requestRef: ref(h.requestRef),
      carrierRef: ref(h.carrierRef),
      contextRef: ref(h.contextRef),
      createdAt: iso(h.createdAt),
    },
    billingBinding: {
      bindingRef: ref(w.bindingRef),
      organizationId: ref(w.organizationId),
      workspaceId: ref(w.workspaceId),
      workspaceRef: ref(w.workspaceRef),
    },
  };
}
export interface FinancialEnrollmentComponentOptions {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly writerEpoch: FinancialSourceDigest;
  readonly receiverRef: string;
  readonly targetRef: string;
}
function component(options: FinancialEnrollmentComponentOptions) {
  const { sql, clock, client, realm } = options;
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
  });
  const writerEpoch = digest(options.writerEpoch),
    receiverRef = ref(options.receiverRef),
    targetRef = ref(options.targetRef);
  if (typeof clock !== "function") fail("unavailable");
  const realmData = Object.freeze({
    accountId: realm.accountId,
    mode: realm.mode,
    billingAuthority: realm.billingAuthority,
    financialRealm: realm.financialRealm,
    writerEpoch,
    receiverRef,
    targetRef,
  });
  const current = `EXISTS (SELECT 1 FROM stripe_mode_realm WHERE singleton=1 AND mode='test')
    AND EXISTS (SELECT 1 FROM stripe_billing_account_realms WHERE singleton=1 AND account_id=? AND mode='test' AND billing_authority=?)
    AND EXISTS (SELECT 1 FROM money_cutover_authorized_epoch WHERE singleton=1 AND writer_epoch=?)
    AND NOT EXISTS (SELECT 1 FROM money_cutover_freeze)`;
  const currentParams: readonly SqlParam[] = [
    realmData.accountId,
    realmData.billingAuthority,
    writerEpoch,
  ];
  const names = [
    "financial_preproof_challenges",
    "financial_preproof_challenge_receipts",
    "financial_source_materializations",
    "financial_source_materialization_receipts",
  ];
  async function ready(receiver = false) {
    try {
      const rows = await sql.query(
        `SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`,
        names,
      );
      if (
        rows.length !== Object.keys(SCHEMA).length ||
        rows.some((row) => typeof row.name !== "string" || row.sql !== SCHEMA[row.name])
      )
        fail("unavailable");
      if (receiver) {
        const receiverRows = await sql.query(
          `SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN ('financial_source_registrations','financial_source_heads','financial_source_events','financial_source_receipts') AND sql IS NOT NULL ORDER BY type,name`,
        );
        if ((await canonicalDigest(receiverRows)) !== RECEIVER_SCHEMA_DIGEST) fail("unavailable");
      }
    } catch (error) {
      if (error instanceof FinancialSourceEnrollmentError) throw error;
      fail("unavailable", error);
    }
  }
  function observed(): string {
    try {
      return iso(clock().toISOString());
    } catch (error) {
      return fail("unavailable", error);
    }
  }
  return { sql, realmData, current, currentParams, ready, observed };
}

export interface FinancialPreproofPreparation {
  readonly preparationRef: string;
  readonly receiptRef: string;
  readonly challenge: FinancialIdentityChallenge;
  readonly selection: FinancialPreproofSelection;
}
export interface FinancialPreproofReceipt {
  readonly preparationRef: string;
  readonly challengeRef: string;
  readonly receiptRef: string;
}
/** Private data-custody store; no route and no challenge/nonce mint are provided. */
export function createFinancialPreproofChallengeStore(
  options: FinancialEnrollmentComponentOptions & {
    readonly scope: FinancialPreproofScope;
  },
) {
  const c = component(options),
    scope = parseScope(snapshot(options.scope)),
    scopeJson = json({ ...scope, ...c.realmData });
  function parse(input: unknown) {
    const r = record(input, ["preparationRef", "receiptRef", "challenge", "selection"]);
    const challenge = parseFinancialIdentityChallenge(r.challenge),
      selection = parseSelection(r.selection);
    if (
      Object.entries(scope).some(
        ([key, value]) => challenge[key as keyof FinancialPreproofScope] !== value,
      ) ||
      selection.action.requestFingerprint !== challenge.requestFingerprint ||
      selection.customer.financialRealm !== c.realmData.financialRealm ||
      selection.billingBinding.organizationId !== scope.organizationId ||
      selection.billingBinding.workspaceId !== scope.workspaceId ||
      selection.billingBinding.workspaceRef !== scope.workspaceRef
    )
      fail("invalid_request");
    return {
      preparationRef: ref(r.preparationRef),
      receiptRef: ref(r.receiptRef),
      challenge,
      selection,
      scope: JSON.parse(scopeJson) as unknown,
    };
  }
  async function original(
    input: ReturnType<typeof parse>,
  ): Promise<FinancialPreproofReceipt | null> {
    const rows = await c.sql.query(
      `SELECT c.*,q.receipt_ref AS retained_receipt,q.preparation_ref AS retained_preparation,
      q.challenge_ref AS retained_challenge,q.record_json AS receipt_record,q.all_rows_match
      FROM financial_preproof_challenges c LEFT JOIN financial_preproof_challenge_receipts q ON q.challenge_ref=c.challenge_ref
      WHERE c.preparation_ref=? OR c.challenge_ref=? OR q.receipt_ref=?`,
      [input.preparationRef, input.challenge.challengeRef, input.receiptRef],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.record_json !== json(input) ||
      row.scope_json !== scopeJson ||
      row.challenge_json !== json(input.challenge)
    )
      fail("conflict");
    if (
      row.retained_receipt !== input.receiptRef ||
      row.retained_preparation !== input.preparationRef ||
      row.retained_challenge !== input.challenge.challengeRef ||
      row.receipt_record !== row.record_json ||
      row.all_rows_match !== 1
    )
      fail("unavailable");
    return {
      preparationRef: input.preparationRef,
      challengeRef: input.challenge.challengeRef,
      receiptRef: input.receiptRef,
    };
  }
  async function prepare(input: FinancialPreproofPreparation): Promise<FinancialPreproofReceipt> {
    let saved: ReturnType<typeof parse>;
    try {
      saved = parse(snapshot(input));
    } catch (error) {
      return fail("invalid_request", error);
    }
    try {
      await c.ready();
      const prior = await original(saved);
      if (prior) return prior;
      const recordJson = json(saved),
        challengeJson = json(saved.challenge),
        at = c.observed();
      const statements: readonly SqlStatement[] = [
        {
          sql: `INSERT INTO financial_preproof_challenges(challenge_ref,preparation_ref,challenge_json,scope_json,record_json,created_at)
          SELECT ?,?,?,?,?,? WHERE ${c.current}`,
          params: [
            saved.challenge.challengeRef,
            saved.preparationRef,
            challengeJson,
            scopeJson,
            recordJson,
            at,
            ...c.currentParams,
          ],
        },
        {
          sql: `INSERT INTO financial_preproof_challenge_receipts(receipt_ref,challenge_ref,preparation_ref,record_json,all_rows_match)
          VALUES(?,?,?,?,CASE WHEN changes()=1 AND EXISTS(SELECT 1 FROM financial_preproof_challenges
          WHERE challenge_ref=? AND preparation_ref=? AND challenge_json=? AND scope_json=? AND record_json=?) AND (${c.current}) THEN 1 ELSE 0 END)`,
          params: [
            saved.receiptRef,
            saved.challenge.challengeRef,
            saved.preparationRef,
            recordJson,
            saved.challenge.challengeRef,
            saved.preparationRef,
            challengeJson,
            scopeJson,
            recordJson,
            ...c.currentParams,
          ],
        },
      ];
      try {
        await c.sql.batch(statements);
      } catch (error) {
        const recovered = await original(saved);
        if (recovered) return recovered;
        if (error instanceof SqlError && error.code === "constraint") fail("conflict", error);
        fail("unavailable", error);
      }
      const committed = await original(saved);
      if (!committed) fail("unavailable");
      return committed;
    } catch (error) {
      if (error instanceof FinancialSourceEnrollmentError) throw error;
      return fail("unavailable", error);
    }
  }
  /** Exact existing Accounts challenges.read seam: bare 10fields or undefined only for positive absence. */
  async function readChallenge(
    challengeRef: string,
  ): Promise<FinancialIdentityChallenge | undefined> {
    ref(challengeRef);
    try {
      await c.ready();
      const rows = await c.sql.query(
        `SELECT c.*,q.receipt_ref AS retained_receipt,q.preparation_ref AS retained_preparation,
        q.record_json AS receipt_record,q.all_rows_match FROM financial_preproof_challenges c
        LEFT JOIN financial_preproof_challenge_receipts q ON q.challenge_ref=c.challenge_ref WHERE c.challenge_ref=?`,
        [challengeRef],
      );
      if (rows.length === 0) {
        const orphan = await c.sql.query(
          "SELECT receipt_ref FROM financial_preproof_challenge_receipts WHERE challenge_ref=?",
          [challengeRef],
        );
        if (orphan.length !== 0) fail("unavailable");
        return undefined;
      }
      const row = rows[0];
      if (rows.length !== 1 || row === undefined || typeof row.record_json !== "string")
        fail("unavailable");
      const decoded = JSON.parse(row.record_json) as Record<string, unknown>;
      const saved = parse({
        preparationRef: decoded.preparationRef,
        receiptRef: decoded.receiptRef,
        challenge: decoded.challenge,
        selection: decoded.selection,
      });
      if (
        json(saved) !== row.record_json ||
        row.scope_json !== scopeJson ||
        row.challenge_json !== json(saved.challenge) ||
        row.challenge_ref !== challengeRef ||
        row.preparation_ref !== saved.preparationRef ||
        row.retained_preparation !== saved.preparationRef ||
        row.retained_receipt !== saved.receiptRef ||
        row.receipt_record !== row.record_json ||
        row.all_rows_match !== 1
      )
        fail("unavailable");
      return saved.challenge;
    } catch (error) {
      if (error instanceof FinancialSourceEnrollmentError && error.code === "unavailable")
        throw error;
      return fail("unavailable", error);
    }
  }
  return Object.freeze({ prepare, readChallenge });
}

/** Closed private descriptor data, never a qualification capability minted by this module. */
export interface FinancialMaterializationSource {
  readonly registration: FinancialSourceRegistration;
  readonly registrationDigest: FinancialSourceDigest;
  readonly qualificationRef: string;
  readonly sourceSchemaDigest: FinancialSourceDigest;
  readonly sourceCredentialRef: string;
  readonly clockPolicyRef: string;
  readonly originRef: string;
}
export interface FinancialMaterializationCommand {
  readonly materializationRef: string;
  readonly commandRef: string;
  readonly receiptRef: string;
  readonly materialization: FinancialSourceMaterialization;
}
export interface FinancialMaterializationReceipt {
  readonly materializationRef: string;
  readonly commandRef: string;
  readonly receiptRef: string;
}
/** Explicit individual bootstrap only. Receiver apply/read neither import nor call this writer. */
export function createFinancialSourceMaterializationStore(
  options: FinancialEnrollmentComponentOptions & {
    readonly source: FinancialMaterializationSource;
    readonly affectedRef: string;
    readonly genesisQualificationRef: string;
  },
) {
  const c = component(options),
    descriptor = record(snapshot(options.source), [
      "registration",
      "registrationDigest",
      "qualificationRef",
      "sourceSchemaDigest",
      "sourceCredentialRef",
      "clockPolicyRef",
      "originRef",
    ]);
  const registration = parseFinancialSourceRegistration(descriptor.registration);
  if (
    !registration.receivers.some(
      (p) => p.receiverRef === c.realmData.receiverRef && p.targetRef === c.realmData.targetRef,
    )
  )
    fail("invalid_request");
  const source = {
    registration,
    registrationDigest: digest(descriptor.registrationDigest),
    qualificationRef: ref(descriptor.qualificationRef),
    sourceSchemaDigest: digest(descriptor.sourceSchemaDigest),
    sourceCredentialRef: ref(descriptor.sourceCredentialRef),
    clockPolicyRef: ref(descriptor.clockPolicyRef),
    originRef: ref(descriptor.originRef),
    ...c.realmData,
  };
  const affectedRef = ref(options.affectedRef),
    genesisQualificationRef = ref(options.genesisQualificationRef),
    sourceJson = json(source),
    registrationJson = json(registration);
  const { registrationRef, incarnation, genesisDigest } = registration;
  const regMatch = `r.registration_ref=? AND r.incarnation=? AND r.receiver_ref=? AND r.target_ref=?
    AND r.genesis_digest=? AND r.registration_digest=? AND r.registration_json=? AND r.qualification_ref=?`;
  const regParams: readonly SqlParam[] = [
    registrationRef,
    incarnation,
    c.realmData.receiverRef,
    c.realmData.targetRef,
    genesisDigest,
    source.registrationDigest,
    registrationJson,
    source.qualificationRef,
  ];
  // Reuse requires a completed M's exact original source provenance, not a manually matching row.
  const reusable = `EXISTS(SELECT 1 FROM financial_source_materializations old
    JOIN financial_source_materialization_receipts sealed ON sealed.materialization_ref=old.materialization_ref
    WHERE old.registration_ref=r.registration_ref AND old.incarnation=r.incarnation AND old.source_json=?
      AND sealed.command_ref=old.command_ref AND sealed.record_json=old.record_json AND sealed.all_rows_match=1)`;
  function parse(input: unknown) {
    const r = record(input, ["materializationRef", "commandRef", "receiptRef", "materialization"]),
      materialization = parseFinancialSourceMaterialization(r.materialization);
    const event = materialization.event;
    if (
      event.registrationRef !== registrationRef ||
      event.incarnation !== incarnation ||
      event.affectedRef !== affectedRef ||
      (event.sequence === 1 && event.previousDigest !== genesisDigest)
    )
      fail("invalid_request");
    return {
      materializationRef: ref(r.materializationRef),
      commandRef: ref(r.commandRef),
      receiptRef: ref(r.receiptRef),
      materialization,
      source,
      affectedRef,
      genesisQualificationRef,
    };
  }
  async function original(
    input: ReturnType<typeof parse>,
  ): Promise<FinancialMaterializationReceipt | null> {
    const rows = await c.sql.query(
      `SELECT m.*,q.receipt_ref AS retained_receipt,q.command_ref AS retained_command,
      q.record_json AS receipt_record,q.all_rows_match,h.genesis_qualification_ref AS retained_genesis,h.created_at AS head_created,
      r.registration_json,r.registration_digest,r.qualification_ref,r.receiver_ref,r.target_ref
      FROM financial_source_materializations m LEFT JOIN financial_source_materialization_receipts q ON q.materialization_ref=m.materialization_ref
      LEFT JOIN financial_source_heads h ON h.registration_ref=m.registration_ref AND h.incarnation=m.incarnation AND h.affected_ref=m.affected_ref
      LEFT JOIN financial_source_registrations r ON r.registration_ref=m.registration_ref AND r.incarnation=m.incarnation
      WHERE m.materialization_ref=? OR m.command_ref=? OR q.receipt_ref=? OR (m.registration_ref=? AND m.incarnation=? AND m.affected_ref=?)`,
      [
        input.materializationRef,
        input.commandRef,
        input.receiptRef,
        registrationRef,
        incarnation,
        affectedRef,
      ],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.record_json !== json(input) ||
      row.source_json !== sourceJson
    )
      fail("conflict");
    if (
      row.retained_receipt !== input.receiptRef ||
      row.retained_command !== input.commandRef ||
      row.receipt_record !== row.record_json ||
      row.all_rows_match !== 1 ||
      row.retained_genesis !== genesisQualificationRef ||
      row.head_created !== row.created_at ||
      row.registration_json !== registrationJson ||
      row.registration_digest !== source.registrationDigest ||
      row.qualification_ref !== source.qualificationRef ||
      row.receiver_ref !== c.realmData.receiverRef ||
      row.target_ref !== c.realmData.targetRef
    )
      fail("unavailable");
    return {
      materializationRef: input.materializationRef,
      commandRef: input.commandRef,
      receiptRef: input.receiptRef,
    };
  }
  async function install(
    input: FinancialMaterializationCommand,
  ): Promise<FinancialMaterializationReceipt> {
    let saved: ReturnType<typeof parse>;
    try {
      saved = parse(snapshot(input));
    } catch (error) {
      return fail("invalid_request", error);
    }
    if (
      (await financialSourceEventDigest(saved.materialization.event)) !==
      saved.materialization.eventDigest
    )
      fail("invalid_request");
    try {
      await c.ready(true);
      const prior = await original(saved);
      if (prior) return prior;
      const recordJson = json(saved),
        at = c.observed();
      const params: readonly SqlParam[] = [
        saved.materializationRef,
        saved.commandRef,
        registrationRef,
        incarnation,
        affectedRef,
        sourceJson,
        recordJson,
        genesisQualificationRef,
        at,
        ...c.currentParams,
        ...regParams,
        sourceJson,
        registrationRef,
        incarnation,
      ];
      const statements: readonly SqlStatement[] = [
        {
          sql: `INSERT INTO financial_source_materializations(materialization_ref,command_ref,registration_ref,incarnation,affected_ref,source_json,record_json,genesis_qualification_ref,created_at)
          SELECT ?,?,?,?,?,?,?,?,? WHERE (${c.current}) AND (
          EXISTS(SELECT 1 FROM financial_source_registrations r WHERE ${regMatch} AND r.retired_at IS NULL AND ${reusable})
          OR NOT EXISTS(SELECT 1 FROM financial_source_registrations WHERE registration_ref=? AND incarnation=?))`,
          params,
        },
        {
          sql: `INSERT INTO financial_source_registrations(registration_ref,incarnation,receiver_ref,target_ref,genesis_digest,registration_digest,registration_json,qualification_ref,registered_at)
          SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM financial_source_materializations WHERE materialization_ref=? AND record_json=?)
          AND NOT EXISTS(SELECT 1 FROM financial_source_registrations WHERE registration_ref=? AND incarnation=?)`,
          params: [
            ...regParams,
            at,
            saved.materializationRef,
            recordJson,
            registrationRef,
            incarnation,
          ],
        },
        {
          sql: `INSERT INTO financial_source_heads(registration_ref,incarnation,affected_ref,genesis_qualification_ref,created_at,sequence,event_digest,state,last_event_ref,updated_at)
          SELECT ?,?,?,?,?,0,?,'active',NULL,? WHERE EXISTS(SELECT 1 FROM financial_source_materializations WHERE materialization_ref=? AND record_json=?)
          AND EXISTS(SELECT 1 FROM financial_source_registrations r WHERE ${regMatch} AND r.retired_at IS NULL)`,
          params: [
            registrationRef,
            incarnation,
            affectedRef,
            genesisQualificationRef,
            at,
            genesisDigest,
            at,
            saved.materializationRef,
            recordJson,
            ...regParams,
          ],
        },
        {
          sql: `INSERT INTO financial_source_materialization_receipts(receipt_ref,materialization_ref,command_ref,registration_ref,incarnation,affected_ref,record_json,all_rows_match)
          VALUES(?,?,?,?,?,?,?,CASE WHEN changes()=1 AND (${c.current}) AND EXISTS(
          SELECT 1 FROM financial_source_materializations m JOIN financial_source_registrations r ON r.registration_ref=m.registration_ref AND r.incarnation=m.incarnation
          JOIN financial_source_heads h ON h.registration_ref=m.registration_ref AND h.incarnation=m.incarnation AND h.affected_ref=m.affected_ref
          WHERE m.materialization_ref=? AND m.command_ref=? AND m.record_json=? AND m.source_json=? AND ${regMatch}
          AND r.retired_at IS NULL AND h.affected_ref=? AND h.sequence=0 AND h.event_digest=r.genesis_digest
          AND h.last_event_ref IS NULL AND h.state='active' AND h.genesis_qualification_ref=? AND h.created_at=m.created_at
          ) THEN 1 ELSE 0 END)`,
          params: [
            saved.receiptRef,
            saved.materializationRef,
            saved.commandRef,
            registrationRef,
            incarnation,
            affectedRef,
            recordJson,
            ...c.currentParams,
            saved.materializationRef,
            saved.commandRef,
            recordJson,
            sourceJson,
            ...regParams,
            affectedRef,
            genesisQualificationRef,
          ],
        },
      ];
      try {
        await c.sql.batch(statements);
      } catch (error) {
        const recovered = await original(saved);
        if (recovered) return recovered;
        if (error instanceof SqlError && error.code === "constraint") fail("conflict", error);
        fail("unavailable", error);
      }
      const committed = await original(saved);
      if (!committed) fail("unavailable");
      return committed;
    } catch (error) {
      if (error instanceof FinancialSourceEnrollmentError) throw error;
      return fail("unavailable", error);
    }
  }
  return Object.freeze({ install });
}
