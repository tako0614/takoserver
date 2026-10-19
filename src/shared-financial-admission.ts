/** PRIVATE UNMOUNTED CUSTOMER-L1 COMPONENT. Input data/SQL labels are not authentication.
 * Original Root depth100 failures and missing enrollment/payer/history writers remain unqualified.
 */

import { assertFinancial0104CustomerWriteShape } from "./financial-0104-customer-schema.ts";
import { isFinancialCustomerMoneyFencedBatch } from "./financial-0104-money-fence.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { assertMoneyCutoverSqlOrigin } from "./money-cutover-sql.ts";
import { type JsonObject, type Sql, SqlError, type SqlParam, type SqlStatement } from "./ports.ts";
import type {
  SharedFinancialAction,
  SharedFinancialActionIdentity,
} from "./shared-financial-action.ts";
import { type ConsentCandidate, consentGuard } from "./shared-financial-consent-data.ts";

export interface SharedCustomerAdmissionInput {
  readonly action: SharedFinancialAction;
  readonly consent: ConsentCandidate;
  /** Already selected original terms, never today's tariff chosen during recovery. */
  readonly selectedTerms: JsonObject;
}
export interface OriginalCustomerDefinition {
  readonly realmJson: string;
  readonly requestJson: string;
  readonly fingerprint: string;
  readonly key: string;
}
export interface CustomerL1Receipt {
  readonly admissionRef: string;
  readonly receiptRef: string;
  readonly organizationId: string;
  readonly challengeRef: string;
  readonly grantRef: string;
  readonly customerKey: string;
  readonly selectedTerms: JsonObject;
}
export class SharedFinancialAdmissionError extends Error {
  constructor(
    readonly code: "conflict" | "l2_unmounted",
    readonly receipt?: CustomerL1Receipt,
  ) {
    super(`shared_financial_admission_${code}`);
    this.name = "SharedFinancialAdmissionError";
  }
}
function conflict(): never {
  throw new SharedFinancialAdmissionError("conflict");
}
export interface CustomerAdmissionCandidate {
  readonly input: SharedCustomerAdmissionInput;
  readonly identity: SharedFinancialActionIdentity;
  readonly original: OriginalCustomerDefinition;
  readonly contextJson: string;
  readonly termsJson: string;
  readonly admissionRef: string;
  readonly receiptRef: string;
  readonly issuanceAttempt: string;
  readonly createdAt: string;
}
/** Data-only internal assembly. Custody owns the original native recipe; no arbitrary SQL port. */
export async function customerAdmissionCandidate(
  input: SharedCustomerAdmissionInput,
  identity: SharedFinancialActionIdentity,
  original: OriginalCustomerDefinition,
  createdAt: string,
): Promise<CustomerAdmissionCandidate> {
  const { consent } = input;
  if (
    identity.action.kind !== consent.actionKind ||
    identity.action.reference !== consent.actionRef ||
    identity.requestFingerprint !== consent.requestFingerprint
  )
    conflict();
  // Exclude only the mutable commit-time Root observation, not stable human/credential origins.
  const contextJson = canonicalJson({
    identity,
    consent: {
      ...consent,
      auth: { human: consent.auth.human, credential: consent.auth.credential },
    },
    original,
    selectedTerms: input.selectedTerms,
  });
  const digest = (
    await canonicalDigest(["private-financial-customer-admission-v1", JSON.parse(contextJson)])
  ).slice(7);
  return Object.freeze({
    input,
    identity,
    original,
    contextJson,
    termsJson: canonicalJson(input.selectedTerms),
    admissionRef: `fca_${digest}`,
    receiptRef: `fcr_${digest}`,
    issuanceAttempt: `fcat_${digest}`,
    createdAt,
  });
}
const COMPLETED = `FROM shared_customer_challenges c
 JOIN financial_payer_grants g ON g.challenge_ref=c.challenge_ref
 JOIN financial_payer_consent_witnesses w ON w.grant_ref=g.grant_ref AND w.challenge_ref=g.challenge_ref
 JOIN financial_payer_consent_receipts cr ON cr.grant_ref=g.grant_ref AND cr.challenge_ref=g.challenge_ref`;
/** Every L1/D row is 0104 money-fenced, so the consent currentness guard is the
 * money-free consentGuard(); freeze, permit and epoch are the fences inside Root's
 * Money writer. */
function completeGuard(q: CustomerAdmissionCandidate) {
  const { consent } = q.input;
  const org = q.identity.action.organizationId;
  const g = consentGuard(consent, org);
  return {
    sql: `(${g.sql}
     AND (((((g.grant_ref IS ?
     AND g.grant_incarnation IS ?)
     AND (g.identity_proof_ref IS ?
     AND g.consent_registration_ref IS ?))
     AND ((g.consent_incarnation IS ?
     AND g.consent_ref IS ?)
     AND (g.consent_proof_ref IS ?
     AND g.consent_digest IS ?)))
     AND (((g.issuance_attempt IS ?
     AND g.expected_receipt_ref IS ?)
     AND (g.issued_at IS ?
     AND w.issuance_attempt IS g.issuance_attempt))
     AND ((cr.issuance_attempt IS g.issuance_attempt
     AND cr.receipt_ref IS g.expected_receipt_ref)
     AND (cr.all_rows_match IS 1
     AND w.consent_registration_ref IS g.consent_registration_ref))))
     AND ((((w.consent_incarnation IS g.consent_incarnation
     AND w.consent_ref IS g.consent_ref)
     AND (w.consent_proof_ref IS g.consent_proof_ref
     AND w.consent_digest IS g.consent_digest))
     AND ((w.consumed_at IS g.issued_at
     AND NOT EXISTS(SELECT 1 FROM financial_payer_grant_revocations x WHERE x.grant_ref=g.grant_ref))
     AND (c.action_json IS ?
     AND json_extract(c.selection_json,'$.selectedTerms') IS ?)))
     AND (((json_extract(c.selection_json,'$.customer.realmJson') IS ?
     AND json_extract(c.selection_json,'$.customer.requestJson') IS ?)
     AND (json_extract(c.selection_json,'$.customer.fingerprint') IS ?
     AND json_extract(c.selection_json,'$.customer.key') IS ?))
     AND ((c.financial_realm IS json_extract(?,'$.financialRealm')
     AND c.account_id IS json_extract(?,'$.accountId'))
     AND (c.billing_authority IS json_extract(?,'$.billingAuthority')
     AND c.mode IS 'test'))))))`,
    params: [
      ...g.params,
      consent.grantRef,
      consent.grantIncarnation,
      consent.identityProofRef,
      consent.consentRegistrationRef,
      consent.consentIncarnation,
      consent.consentRef,
      consent.consentProofRef,
      consent.consentDigest,
      consent.issuanceAttempt,
      consent.receiptRef,
      consent.issuedAt,
      canonicalJson(q.identity.action),
      q.termsJson,
      q.original.realmJson,
      q.original.requestJson,
      q.original.fingerprint,
      q.original.key,
      q.original.realmJson,
      q.original.realmJson,
      q.original.realmJson,
    ] as SqlParam[],
  };
}
/** One keyed row at most: challenge PK -> grant/witness/receipt UNIQUE ->
 * admission UNIQUE challenge -> command/link PK organization. All old B S4
 * conditions are retained on the join that first has their aliases in scope.
 * Root's guard text and its parameter order are used without modification, in
 * the money-free consentGuard() form: every row it gates is 0104 money-fenced.
 */
export function prepareCustomerCompletionProof(
  q: CustomerAdmissionCandidate,
  state: "prepared" | "dispatched",
): { readonly sql: string; readonly params: readonly SqlParam[] } {
  const consent = q.input.consent;
  const root = consentGuard(consent, q.identity.action.organizationId);
  const grantParams: SqlParam[] = [
    consent.grantRef,
    consent.grantIncarnation,
    consent.identityProofRef,
    consent.consentRegistrationRef,
    consent.consentIncarnation,
    consent.consentRef,
    consent.consentProofRef,
    consent.consentDigest,
    consent.issuanceAttempt,
    consent.receiptRef,
    consent.issuedAt,
  ];
  const challengeParams: SqlParam[] = [
    canonicalJson(q.identity.action),
    q.termsJson,
    q.original.realmJson,
    q.original.requestJson,
    q.original.fingerprint,
    q.original.key,
    q.original.realmJson,
    q.original.realmJson,
    q.original.realmJson,
  ];
  const from =
    state === "dispatched"
      ? "FROM v CROSS JOIN shared_customer_challenges c"
      : "FROM shared_customer_challenges c";
  const dispatchedAt = state === "prepared" ? "NULL" : "json_extract(v.data,'$.dispatchedAt')";
  return {
    sql: `EXISTS(SELECT 1 ${from}
 JOIN financial_payer_grants g ON g.challenge_ref=c.challenge_ref AND ${root.sql}
 JOIN financial_payer_consent_witnesses w ON w.grant_ref=g.grant_ref AND w.challenge_ref=g.challenge_ref
 AND g.grant_ref IS ? AND g.grant_incarnation IS ? AND g.identity_proof_ref IS ?
 AND g.consent_registration_ref IS ? AND g.consent_incarnation IS ? AND g.consent_ref IS ?
 AND g.consent_proof_ref IS ? AND g.consent_digest IS ? AND g.issuance_attempt IS ?
 AND g.expected_receipt_ref IS ? AND g.issued_at IS ?
 JOIN financial_payer_consent_receipts cr ON cr.grant_ref=g.grant_ref AND cr.challenge_ref=g.challenge_ref
 AND w.issuance_attempt IS g.issuance_attempt AND cr.issuance_attempt IS g.issuance_attempt
 AND cr.receipt_ref IS g.expected_receipt_ref AND cr.all_rows_match IS 1
 AND w.consent_registration_ref IS g.consent_registration_ref AND w.consent_incarnation IS g.consent_incarnation
 AND w.consent_ref IS g.consent_ref AND w.consent_proof_ref IS g.consent_proof_ref
 AND w.consent_digest IS g.consent_digest AND w.consumed_at IS g.issued_at
 AND NOT EXISTS(SELECT 1 FROM financial_payer_grant_revocations x WHERE x.grant_ref=g.grant_ref)
 AND c.action_json IS ? AND json_extract(c.selection_json,'$.selectedTerms') IS ?
 AND json_extract(c.selection_json,'$.customer.realmJson') IS ?
 AND json_extract(c.selection_json,'$.customer.requestJson') IS ?
 AND json_extract(c.selection_json,'$.customer.fingerprint') IS ?
 AND json_extract(c.selection_json,'$.customer.key') IS ?
 AND c.financial_realm IS json_extract(?,'$.financialRealm')
 AND c.account_id IS json_extract(?,'$.accountId')
 AND c.billing_authority IS json_extract(?,'$.billingAuthority') AND c.mode IS 'test'
 JOIN financial_customer_admissions a ON a.challenge_ref=c.challenge_ref AND a.grant_ref=g.grant_ref
 AND a.admission_ref IS ? AND a.issuance_attempt IS ? AND a.context_json IS ?
 JOIN stripe_billing_customer_commands k ON k.org_id=a.organization_id
 AND k.fingerprint IS a.customer_fingerprint AND k.stripe_key IS a.stripe_key
 AND k.realm_json IS a.realm_json AND k.request_json IS a.customer_request_json
 AND k.created_at IS a.created_at AND k.state IS '${state}' AND k.dispatched_at IS ${dispatchedAt} AND k.customer_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM stripe_billing_customers b WHERE b.org_id=a.organization_id)
 JOIN stripe_customer_admission_links l ON l.org_id=a.organization_id AND l.admission_ref=a.admission_ref
 AND a.expected_receipt_ref IS ? AND l.created_at IS a.created_at
 AND l.customer_fingerprint IS a.customer_fingerprint AND l.stripe_key IS a.stripe_key
 AND l.realm_json IS a.realm_json AND l.customer_request_json IS a.customer_request_json)`,
    params: [
      ...root.params,
      ...grantParams,
      ...challengeParams,
      q.admissionRef,
      q.issuanceAttempt,
      q.contextJson,
      q.receiptRef,
    ],
  };
}
/** Four fixed statements. S4 is unconditional, never conditional INSERT of a success flag. */
export function prepareCustomerAdmissionBatch(
  q: CustomerAdmissionCandidate,
): readonly SqlStatement[] {
  const { consent } = q.input;
  const g = completeGuard(q);
  const a = q.identity.action;
  const winner = `a.admission_ref IS ? AND a.issuance_attempt IS ? AND a.context_json IS ?`;
  const wp = [q.admissionRef, q.issuanceAttempt, q.contextJson];
  const admission = `JOIN financial_customer_admissions a ON a.challenge_ref=c.challenge_ref AND a.grant_ref=g.grant_ref`;
  const first: SqlStatement = {
    sql: `INSERT INTO financial_customer_admissions
    (admission_ref,challenge_ref,grant_ref,issuance_attempt,expected_receipt_ref,organization_id,action_kind,
    action_ref,request_fingerprint,action_json,selection_json,terms_json,context_json,realm_json,
    customer_request_json,customer_fingerprint,stripe_key,created_at)
    SELECT ?,c.challenge_ref,g.grant_ref,?,?,?,?,?,?,?,c.selection_json,?,?,?,?,?,?,? ${COMPLETED}
    WHERE c.challenge_ref=? AND ${g.sql}
    AND NOT EXISTS(SELECT 1 FROM financial_customer_admissions old WHERE old.challenge_ref=c.challenge_ref)
    AND NOT EXISTS(SELECT 1 FROM stripe_billing_customer_commands old WHERE old.org_id=c.organization_id)
    AND NOT EXISTS(SELECT 1 FROM stripe_billing_customers old WHERE old.org_id=c.organization_id)`,
    params: [
      q.admissionRef,
      q.issuanceAttempt,
      q.receiptRef,
      a.organizationId,
      a.kind,
      a.reference,
      q.identity.requestFingerprint,
      canonicalJson(a),
      q.termsJson,
      q.contextJson,
      q.original.realmJson,
      q.original.requestJson,
      q.original.fingerprint,
      q.original.key,
      q.createdAt,
      consent.challengeRef,
      ...g.params,
    ],
  };
  const second: SqlStatement = {
    sql: `INSERT INTO stripe_billing_customer_commands
    (org_id,realm_json,request_json,fingerprint,stripe_key,state,dispatched_at,customer_id,created_at,verified_at)
    SELECT a.organization_id,a.realm_json,a.customer_request_json,a.customer_fingerprint,a.stripe_key,
    'prepared',NULL,NULL,a.created_at,NULL ${COMPLETED} ${admission}
    WHERE (${winner}) AND ${g.sql}
    AND NOT EXISTS(SELECT 1 FROM stripe_billing_customers old WHERE old.org_id=a.organization_id)`,
    params: [...wp, ...g.params],
  };
  const command = `JOIN stripe_billing_customer_commands k ON k.org_id=a.organization_id`;
  const exactCommand = `(k.fingerprint IS a.customer_fingerprint AND k.stripe_key IS a.stripe_key
    AND k.realm_json IS a.realm_json AND k.request_json IS a.customer_request_json
    AND k.created_at IS a.created_at AND k.state IS 'prepared' AND k.dispatched_at IS NULL AND k.customer_id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM stripe_billing_customers b WHERE b.org_id=a.organization_id)`;
  const third: SqlStatement = {
    sql: `INSERT INTO stripe_customer_admission_links
    (org_id,admission_ref,customer_fingerprint,stripe_key,realm_json,customer_request_json,created_at)
    SELECT a.organization_id,a.admission_ref,a.customer_fingerprint,a.stripe_key,a.realm_json,a.customer_request_json,a.created_at
    ${COMPLETED} ${admission} ${command} WHERE (${winner}) AND ${exactCommand} AND ${g.sql}`,
    params: [...wp, ...g.params],
  };
  const completed = prepareCustomerCompletionProof(q, "prepared");
  const last: SqlStatement = {
    sql: `INSERT INTO financial_customer_admission_receipts
    (receipt_ref,admission_ref,issuance_attempt,org_id,created_at,all_rows_match)
    VALUES(?,?,?,?,?,CASE WHEN ${completed.sql} THEN 1 ELSE 0 END)`,
    params: [
      q.receiptRef,
      q.admissionRef,
      q.issuanceAttempt,
      a.organizationId,
      q.createdAt,
      ...completed.params,
    ],
  };
  const statements = [first, second, third, last];
  // Every statement writes a Financial-fenced table or a Root Money-guard Stripe table.
  if (!isFinancialCustomerMoneyFencedBatch(statements))
    throw new SqlError("invalid", "Customer admission batch must write only money-fenced tables");
  return statements;
}
/** Root hands this component only its Money writer, created for exactly the
 * configured writer epoch (as R1 binds its epoch). A raw Sql or a writer for any
 * other epoch is refused before any SQL, and the write requires the exact fenced
 * 0104 Customer shape. */
export function createSharedFinancialAdmissionComponent(
  sql: Sql,
  context: { readonly writerEpoch: string },
) {
  const writerEpoch = context.writerEpoch;
  function framed(): void {
    try {
      assertMoneyCutoverSqlOrigin(sql, { writerEpoch });
    } catch {
      throw new SqlError("unavailable", "Customer admission writer must be Root's Money writer");
    }
  }
  async function read(q: CustomerAdmissionCandidate): Promise<CustomerL1Receipt | null> {
    const rows = await sql.query(
      `SELECT a.*,r.receipt_ref FROM financial_customer_admissions a
      JOIN financial_customer_admission_receipts r ON r.admission_ref=a.admission_ref
      JOIN stripe_customer_admission_links l ON l.admission_ref=a.admission_ref AND l.org_id=a.organization_id
      JOIN stripe_billing_customer_commands k ON k.org_id=l.org_id
      WHERE a.challenge_ref=? AND a.grant_ref=?
      AND (r.receipt_ref=a.expected_receipt_ref AND r.issuance_attempt=a.issuance_attempt AND r.all_rows_match=1)
      AND (k.fingerprint=a.customer_fingerprint AND k.stripe_key=a.stripe_key AND k.realm_json=a.realm_json
      AND k.request_json=a.customer_request_json AND l.customer_fingerprint=a.customer_fingerprint
      AND l.stripe_key=a.stripe_key AND l.realm_json=a.realm_json AND l.customer_request_json=a.customer_request_json)`,
      [q.input.consent.challengeRef, q.input.consent.grantRef],
    );
    if (rows.length === 0) return null;
    if (
      rows.length !== 1 ||
      rows[0]?.context_json !== q.contextJson ||
      rows[0]?.admission_ref !== q.admissionRef ||
      rows[0]?.receipt_ref !== q.receiptRef
    )
      conflict();
    return Object.freeze({
      admissionRef: q.admissionRef,
      receiptRef: q.receiptRef,
      organizationId: q.identity.action.organizationId,
      challengeRef: q.input.consent.challengeRef,
      grantRef: q.input.consent.grantRef,
      customerKey: q.original.key,
      selectedTerms: Object.freeze(JSON.parse(q.termsJson)),
    });
  }
  return {
    readCustomerAdmission: read,
    async acceptCustomerCreation(q: CustomerAdmissionCandidate): Promise<CustomerL1Receipt> {
      framed();
      // Historical exact readback comes first. It confers no current dispatch or business authority.
      const prior = await read(q);
      if (prior) return prior;
      const statements = prepareCustomerAdmissionBatch(q);
      await assertFinancial0104CustomerWriteShape(sql);
      try {
        await sql.batch(statements);
      } catch (error) {
        const committed = await read(q);
        if (committed) return committed;
        throw error;
      }
      return (await read(q)) ?? conflict();
    },
  };
}
