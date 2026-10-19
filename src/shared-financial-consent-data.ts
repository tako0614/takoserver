/** PRIVATE unmounted SQL component: none of these data inputs authenticates a caller. */

import {
  type RpAuthorityRecord,
  sharedBrokerCredentialCurrentness,
  sharedRpCredentialCurrentness,
  type TokenAuthorityRecord,
} from "./credential-authority-class.ts";
import {
  FINANCIAL_0104_CONSENT_FENCE_SCHEMA,
  isFinancialMoneyFencedBatch,
} from "./financial-0104-money-fence.ts";
import type { SqlParam, SqlStatement } from "./ports.ts";
import {
  type SharedPrincipalBinding,
  sharedPrincipalCurrentness,
} from "./shared-principal-authority.ts";

export interface ConsentCandidate {
  readonly challengeRef: string;
  readonly actionKind: string;
  readonly actionRef: string;
  readonly requestFingerprint: string;
  readonly grantRef: string;
  readonly grantIncarnation: string;
  readonly identityProofRef: string;
  readonly consentRegistrationRef: string;
  readonly consentIncarnation: string;
  readonly consentRef: string;
  readonly consentProofRef: string;
  readonly consentDigest: string;
  readonly issuanceAttempt: string;
  readonly receiptRef: string;
  readonly issuedAt: string;
  readonly auth: {
    readonly human: SharedPrincipalBinding;
    readonly credential: TokenAuthorityRecord | RpAuthorityRecord;
    readonly current:
      | string
      | {
          readonly version: number;
          readonly absoluteExpiresAt: number;
          readonly lastUsedAt: number;
        };
  };
}

/** Local SQL time projection only; genuine authority-clock qualification remains absent. */
export const SQL_NOW_MS =
  "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";

/** Compare every retained component with its original enrolled registration and current head.
 * Complete-capture provenance is upstream's responsibility; this rejects missing/extra/stale retained rows.
 */
export const SOURCE_CURRENT = `(
 (SELECT count(*) FROM financial_payer_challenge_sources s WHERE s.challenge_ref=c.challenge_ref)=c.source_count
 AND EXISTS(SELECT 1 FROM financial_payer_challenge_sources s WHERE s.challenge_ref=c.challenge_ref
  AND s.registration_ref IS json_extract(c.challenge_json,'$.registrationRef'))
 AND NOT EXISTS(SELECT 1 FROM financial_payer_challenge_sources s
  LEFT JOIN financial_source_registrations r ON r.registration_ref=s.registration_ref AND r.incarnation=s.incarnation
  LEFT JOIN financial_source_heads h ON h.registration_ref=s.registration_ref AND h.incarnation=s.incarnation AND h.affected_ref=s.affected_ref
  WHERE s.challenge_ref=c.challenge_ref AND (
   ((r.registration_ref IS NOT NULL AND r.retired_at IS NULL AND r.retirement_ref IS NULL
    AND r.registration_digest IS s.registration_digest AND r.qualification_ref IS s.registration_qualification_ref
    ) AND (r.genesis_digest IS s.genesis_digest AND r.receiver_ref IS s.receiver_ref AND r.target_ref IS s.target_ref
    AND s.receiver_ref IS c.receiver_ref AND s.target_ref IS c.target_ref))
   AND ((h.registration_ref IS NOT NULL AND h.state IS 'active' AND h.sequence IS s.sequence)
    AND (h.event_digest IS s.event_digest AND h.last_event_ref IS s.last_event_ref
    AND h.genesis_qualification_ref IS s.genesis_qualification_ref))
  ) IS NOT 1)
)`;

const MONEY_CURRENT = Object.freeze({
  sql: `
 AND EXISTS(SELECT 1 FROM money_cutover_authorized_epoch e WHERE e.singleton=1 AND e.writer_epoch IS c.writer_epoch)
 AND NOT EXISTS(SELECT 1 FROM money_cutover_freeze)`,
  params: Object.freeze([]) as readonly SqlParam[],
});

/** The exact 0104 consent fence rows, as one JSON bind. The consent batch is a
 * DATA compiler with no Sql of its own, so its write readiness is in-statement:
 * unless every consent money fence exists byte-for-byte, S1/S2 select no row
 * and the unconditional S3 receipt CHECK aborts the whole batch. */
const CONSENT_FENCES_JSON = JSON.stringify(
  Object.entries(FINANCIAL_0104_CONSENT_FENCE_SCHEMA).map(([name, sql]) => [
    name,
    /\bON ([a-z_]+)\n/u.exec(sql)?.[1] ?? "",
    sql,
  ]),
);
const CONSENT_FENCED = Object.freeze({
  sql: `
 AND (SELECT count(*) FROM main.sqlite_schema f JOIN json_each(?) e ON f.type='trigger'
  AND f.name=json_extract(e.value,'$[0]') AND f.tbl_name=json_extract(e.value,'$[1]')
  AND f.sql=json_extract(e.value,'$[2]'))=${Object.keys(FINANCIAL_0104_CONSENT_FENCE_SCHEMA).length}`,
  params: Object.freeze([CONSENT_FENCES_JSON]) as readonly SqlParam[],
});

/** Exact observed Root helper SQL/params, not a substitute for missing Root private-origin assertion/readers.
 * Kept byte-identical. No 0104 writer uses it: consent and Customer admission
 * writes are all 0104 money-fenced and use consentGuard(). */
export function guard(input: ConsentCandidate, organizationId: string) {
  return guardWith(input, organizationId, MONEY_CURRENT);
}

/** The same guard for the consent batch itself. Every table it writes carries a
 * Financial 0104 money fence, so freeze, permit and epoch are enforced inside
 * Root's permit-framed Money writer and no money_cutover_* table is named here;
 * the batch requires those exact fences to exist (CONSENT_FENCED). */
export function consentGuard(input: ConsentCandidate, organizationId: string) {
  return guardWith(input, organizationId, CONSENT_FENCED);
}

function guardWith(
  input: ConsentCandidate,
  organizationId: string,
  money: { readonly sql: string; readonly params: readonly SqlParam[] },
) {
  const principal = sharedPrincipalCurrentness(input.auth.human);
  const credential = input.auth.credential;
  const transport =
    credential.backend === "auth-token"
      ? sharedBrokerCredentialCurrentness(credential, input.auth.current as string, organizationId)
      : sharedRpCredentialCurrentness(
          credential,
          input.auth.current as { version: number; absoluteExpiresAt: number; lastUsedAt: number },
          organizationId,
        );
  const human = input.auth.human;
  const relation =
    credential.backend === "shared-rp-session"
      ? `(json_extract(?,'$.credential.origin.principalId') IS ?
     AND json_extract(?,'$.credential.origin.principalIncarnation') IS ?
     AND json_extract(?,'$.credential.rp.principalBindingRef') IS ?
     AND json_extract(?,'$.credential.rp.clientId') IS json_extract(c.challenge_json,'$.clientId')
     AND json_extract(?,'$.credential.rp.workspaceId') IS json_extract(c.challenge_json,'$.workspaceId')
     AND json_extract(?,'$.credential.rp.workspaceRef') IS json_extract(c.challenge_json,'$.workspaceRef'))`
      : `1`;
  const raw = JSON.stringify(input.auth);
  const stable = JSON.stringify({ human: input.auth.human, credential: input.auth.credential });
  const relationParams: SqlParam[] =
    credential.backend === "shared-rp-session"
      ? [raw, human.principalId, raw, human.principalIncarnation, raw, human.ref, raw, raw, raw]
      : [];
  const sql = `(
 ((c.organization_id IS ? AND c.action_kind IS ? AND c.action_ref IS ? AND c.request_fingerprint IS ?
  AND c.created_at_ms<=${SQL_NOW_MS} AND c.expires_at_ms>${SQL_NOW_MS})
 AND json_extract(c.selection_json,'$.auth') IS ?
 AND EXISTS(SELECT 1 FROM orgs o JOIN org_memberships m ON m.org_id=o.id
  WHERE o.id=c.organization_id AND o.owner_principal_id=? AND m.principal_id=o.owner_principal_id AND m.role='owner'))
 AND (EXISTS(SELECT 1 FROM stripe_billing_account_realms r JOIN stripe_mode_realm sm ON sm.singleton=r.singleton
  WHERE r.singleton=1 AND r.account_id IS c.account_id AND r.mode IS c.mode
  AND r.billing_authority IS c.billing_authority AND sm.mode IS c.mode)${money.sql})
 AND (${SOURCE_CURRENT}
 AND (${principal.sql})) AND ((${transport.sql}) AND (${relation}))
 )`;
  return {
    sql,
    params: [
      organizationId,
      input.actionKind,
      input.actionRef,
      input.requestFingerprint,
      stable,
      human.principalId,
      ...money.params,
      ...principal.params,
      ...transport.params,
      ...relationParams,
    ] as SqlParam[],
    authBinds: principal.params.length + transport.params.length,
  };
}

/** Exactly three ordered statements. S3 is unconditional; no caller-provided SQL/ready flag. */
export function prepareConsentBatch(
  input: ConsentCandidate,
  organizationId: string,
): readonly SqlStatement[] {
  const g = consentGuard(input, organizationId);
  const h = input.auth.human;
  const a = input.auth.credential.origin;
  const authJson = JSON.stringify(input.auth);
  const columns = `grant_ref,grant_incarnation,challenge_ref,principal_id,principal_incarnation,principal_binding_ref,
 authority_ref,credential_incarnation,auth_snapshot_json,identity_proof_ref,consent_registration_ref,consent_incarnation,
 consent_ref,consent_proof_ref,consent_digest,issuance_attempt,expected_receipt_ref,issued_at`;
  const values = [
    input.grantRef,
    input.grantIncarnation,
    h.principalId,
    h.principalIncarnation,
    h.ref,
    a.ref,
    a.incarnation,
    authJson,
    input.identityProofRef,
    input.consentRegistrationRef,
    input.consentIncarnation,
    input.consentRef,
    input.consentProofRef,
    input.consentDigest,
    input.issuanceAttempt,
    input.receiptRef,
    input.issuedAt,
  ];
  const first: SqlStatement = {
    sql: `INSERT INTO financial_payer_grants (${columns})
 SELECT ?,?,c.challenge_ref,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM shared_customer_challenges c
 WHERE c.challenge_ref=? AND ${g.sql}
 AND NOT EXISTS(SELECT 1 FROM financial_payer_grants old WHERE old.challenge_ref=c.challenge_ref)
 AND NOT EXISTS(SELECT 1 FROM financial_payer_consent_witnesses old
  WHERE old.consent_registration_ref=? AND old.consent_incarnation=? AND old.consent_ref=?)`,
    params: [
      ...values,
      input.challengeRef,
      ...g.params,
      input.consentRegistrationRef,
      input.consentIncarnation,
      input.consentRef,
    ],
  };
  const winner = `g.grant_ref IS ? AND g.challenge_ref IS ? AND g.issuance_attempt IS ?
 AND g.expected_receipt_ref IS ? AND g.auth_snapshot_json IS ?
 AND NOT EXISTS(SELECT 1 FROM financial_payer_grant_revocations x WHERE x.grant_ref=g.grant_ref)`;
  const winnerParams = [
    input.grantRef,
    input.challengeRef,
    input.issuanceAttempt,
    input.receiptRef,
    authJson,
  ];
  const second: SqlStatement = {
    sql: `INSERT INTO financial_payer_consent_witnesses
 (challenge_ref,grant_ref,consent_registration_ref,consent_incarnation,consent_ref,consent_proof_ref,consent_digest,issuance_attempt,consumed_at)
 SELECT g.challenge_ref,g.grant_ref,g.consent_registration_ref,g.consent_incarnation,g.consent_ref,g.consent_proof_ref,g.consent_digest,g.issuance_attempt,g.issued_at
 FROM financial_payer_grants g JOIN shared_customer_challenges c ON c.challenge_ref=g.challenge_ref
 WHERE (${winner}) AND ${g.sql}`,
    params: [...winnerParams, ...g.params],
  };
  const last: SqlStatement = {
    sql: `INSERT INTO financial_payer_consent_receipts
 (receipt_ref,grant_ref,challenge_ref,issuance_attempt,created_at,all_rows_match)
 VALUES(?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM financial_payer_grants g
 JOIN shared_customer_challenges c ON c.challenge_ref=g.challenge_ref
 JOIN financial_payer_consent_witnesses w ON w.challenge_ref=g.challenge_ref AND w.grant_ref=g.grant_ref
 WHERE (${winner}) AND ${g.sql}
 AND (w.consent_registration_ref IS g.consent_registration_ref AND w.consent_incarnation IS g.consent_incarnation
 AND w.consent_ref IS g.consent_ref AND w.consent_proof_ref IS g.consent_proof_ref AND w.consent_digest IS g.consent_digest
 AND w.issuance_attempt IS g.issuance_attempt AND w.consumed_at IS g.issued_at)) THEN 1 ELSE 0 END)`,
    params: [
      input.receiptRef,
      input.grantRef,
      input.challengeRef,
      input.issuanceAttempt,
      input.issuedAt,
      ...winnerParams,
      ...g.params,
    ],
  };
  const statements = [first, second, last];
  // Every statement writes a 0104 money-fenced consent table; nothing else is built.
  if (!isFinancialMoneyFencedBatch(statements))
    throw new TypeError("Financial consent batch must write only money-fenced tables");
  return statements;
}

/** Historical exact readback only; a returned receipt never bypasses fresh L1/L2 currentness. */
export const READ_ORIGINAL = `SELECT g.*,w.consumed_at,r.receipt_ref,r.created_at,r.all_rows_match
 FROM financial_payer_grants g JOIN financial_payer_consent_witnesses w ON w.grant_ref=g.grant_ref AND w.challenge_ref=g.challenge_ref
 JOIN financial_payer_consent_receipts r ON r.grant_ref=g.grant_ref AND r.challenge_ref=g.challenge_ref
 WHERE g.challenge_ref=? AND g.grant_ref=?`;
