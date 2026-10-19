import type { RpAuthorityRecord } from "../src/credential-authority-class.ts";
import { createSharedAuthFinancialActionConsentOriginalIdentity } from "../src/shared-auth-financial-consent-contract.ts";
import type { SharedAuthFinancialConsentPendingData } from "../src/shared-auth-financial-consent-store.ts";

/** Synthetic DATA only. The real codec must accept every generated original.
 * This never simulates genuine issuer/R1/Clock/human/current admission. These
 * opaque proof/binding metadata have no newly invented Root namespace mapping.
 */
export function syntheticV4Original(
  pending: SharedAuthFinancialConsentPendingData,
  credential: RpAuthorityRecord,
  acceptedVersion: number,
  consentRef: string,
) {
  const action: unknown = JSON.parse(new TextDecoder().decode(pending.action_original_bytes));
  const challenge: unknown = JSON.parse(new TextDecoder().decode(pending.challenge_original_bytes));
  return createSharedAuthFinancialActionConsentOriginalIdentity({
    version: "takoserver-shared-financial-action-consent-v1",
    consentRef,
    actionVersion: "takoserver-shared-financial-action-v1",
    action,
    actionRequestFingerprint: pending.request_fingerprint,
    challenge,
    selectedTerms: {
      ref: "terms_original_ref_not_disclosure_ref",
      digest: pending.terms_digest_original,
    },
    path: {
      organizationId: pending.organization_id,
      workspaceId: pending.workspace_id,
      workspaceRef: pending.workspace_ref,
    },
    financialRealmRef: "synthetic original realm DATA",
    source: {
      ref: "financial_action_original",
      digest: `sha256:${"b".repeat(64)}`,
      registrationRef: "financial_source_registration",
      incarnation: "financial_source_incarnation",
    },
    consentIssuer: {
      registrationRef: pending.registration_ref,
      registrationDigest: "opaque RP registration digest original Ω",
      incarnation: pending.incarnation,
    },
    identityEvidence: {
      kind: "financial-proof",
      proofRef: "opaque_identity_proof_original",
      registrationRef: "financial_challenge_registration",
      identityGeneration: 4,
      sourceParentPins: [],
    },
    rpSession: {
      sessionDigest: credential.rp.sessionDigest,
      acceptedVersion,
      accountId: credential.rp.accountId,
      observedPrincipalId: pending.principal_id,
      identity: {
        issuer: credential.rp.issuer,
        clientId: credential.rp.clientId,
        subject: credential.rp.subject,
        sessionId: credential.rp.issuerSessionId,
        authTime: credential.rp.authTime,
      },
    },
    principalBinding: {
      ref: pending.principal_binding_ref,
      digest: "synthetic original binding digest",
      incarnation: "separate_binding_incarnation_not_principal_incarnation",
    },
    credentialClass: {
      ref: pending.authority_ref,
      digest: "synthetic original credential digest",
      incarnation: pending.credential_incarnation,
    },
    acceptedAt: pending.created_at + 50,
    expiresAt: pending.expires_at - 100,
  });
}
