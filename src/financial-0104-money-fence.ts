/** Financial-owned 0104 money fences. Every Financial table that a permit-framed
 * Financial batch writes refuses an INSERT while Money is frozen, outside Root's
 * existing same-batch writer permit, or under an epoch that is not authorized and
 * equal to the retained row's own writer epoch. Same shape as the R1 fences in
 * shared-financial-retained-r1.ts. No table, column, permit entry or epoch is
 * minted here; the fences only read Root's existing money_cutover_* rows. */

/** Receiver fences. Receiver rows carry no writer epoch column, so these take the
 * existing R1 registration fence shape: no freeze, and Root's permit joined to the
 * authorized epoch. Heads advance and registrations retire by UPDATE, so those two
 * tables are fenced for UPDATE as well; every other receiver mutation is refused
 * by the existing immutable triggers. */
export const FINANCIAL_0104_RECEIVER_FENCE_SCHEMA: Readonly<Record<string, string>> = Object.freeze(
  {
    financial_source_registrations_money_fence:
      "CREATE TRIGGER financial_source_registrations_money_fence BEFORE INSERT ON financial_source_registrations\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2') BEGIN\n SELECT RAISE(ABORT,'constraint: Financial receiver registration permit required');\nEND",
    financial_source_registrations_money_fence_update:
      "CREATE TRIGGER financial_source_registrations_money_fence_update BEFORE UPDATE ON financial_source_registrations\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2') BEGIN\n SELECT RAISE(ABORT,'constraint: Financial receiver retirement permit required');\nEND",
    financial_source_events_money_fence:
      "CREATE TRIGGER financial_source_events_money_fence BEFORE INSERT ON financial_source_events\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2') BEGIN\n SELECT RAISE(ABORT,'constraint: Financial receiver event permit required');\nEND",
    financial_source_heads_money_fence:
      "CREATE TRIGGER financial_source_heads_money_fence BEFORE INSERT ON financial_source_heads\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2') BEGIN\n SELECT RAISE(ABORT,'constraint: Financial receiver head permit required');\nEND",
    financial_source_heads_money_fence_update:
      "CREATE TRIGGER financial_source_heads_money_fence_update BEFORE UPDATE ON financial_source_heads\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2') BEGIN\n SELECT RAISE(ABORT,'constraint: Financial receiver head advance permit required');\nEND",
    financial_source_receipts_money_fence:
      "CREATE TRIGGER financial_source_receipts_money_fence BEFORE INSERT ON financial_source_receipts\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2') BEGIN\n SELECT RAISE(ABORT,'constraint: Financial receiver receipt permit required');\nEND",
  },
);

/** canonicalDigest of the exact fenced receiver rows (type,name,sql ordered by
 * type,name), as the enrollment and genesis readiness checks project them. The
 * only other accepted receiver shape is the exact unfenced candidate. */
export const FINANCIAL_0104_RECEIVER_FENCED_SCHEMA_DIGEST =
  "sha256:5ddf9c93ca4e4d37456c6ed3895549927aa1ac7d08c0980a1c49a66d5f405047";
/** The exact unfenced receiver candidate digest, accepted only with unfenced C0. */
export const FINANCIAL_RECEIVER_UNFENCED_SCHEMA_DIGEST =
  "sha256:78273f494a3823217edf12e06f06eb4803860452d02278e097a2662befca387b";

/** C0/M enrollment and G genesis fences. Readiness compares these exact rows. */
export const FINANCIAL_0104_C0_FENCE_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  financial_preproof_challenges_money_fence:
    "CREATE TRIGGER financial_preproof_challenges_money_fence BEFORE INSERT ON financial_preproof_challenges\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2'\n AND p.writer_epoch IS json_extract(NEW.scope_json,'$.writerEpoch')) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial C0 challenge permit/epoch required');\nEND",
  financial_preproof_challenge_receipts_money_fence:
    "CREATE TRIGGER financial_preproof_challenge_receipts_money_fence BEFORE INSERT ON financial_preproof_challenge_receipts\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM financial_preproof_challenges c\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE c.challenge_ref IS NEW.challenge_ref AND c.preparation_ref IS NEW.preparation_ref\n AND p.writer_epoch IS json_extract(c.scope_json,'$.writerEpoch')) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial C0 receipt permit/epoch required');\nEND",
  financial_source_materializations_money_fence:
    "CREATE TRIGGER financial_source_materializations_money_fence BEFORE INSERT ON financial_source_materializations\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2'\n AND p.writer_epoch IS json_extract(NEW.source_json,'$.writerEpoch')) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial M original permit/epoch required');\nEND",
  financial_source_materialization_receipts_money_fence:
    "CREATE TRIGGER financial_source_materialization_receipts_money_fence BEFORE INSERT ON financial_source_materialization_receipts\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM financial_source_materializations m\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE m.materialization_ref IS NEW.materialization_ref AND m.command_ref IS NEW.command_ref\n AND p.writer_epoch IS json_extract(m.source_json,'$.writerEpoch')) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial M receipt permit/epoch required');\nEND",
  financial_source_genesis_admissions_money_fence:
    "CREATE TRIGGER financial_source_genesis_admissions_money_fence BEFORE INSERT ON financial_source_genesis_admissions\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2'\n AND p.writer_epoch IS json_extract(NEW.source_json,'$.writerEpoch')) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial G original permit/epoch required');\nEND",
  financial_source_genesis_admission_receipts_money_fence:
    "CREATE TRIGGER financial_source_genesis_admission_receipts_money_fence BEFORE INSERT ON financial_source_genesis_admission_receipts\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM financial_source_genesis_admissions g\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE g.admission_ref IS NEW.admission_ref AND g.command_ref IS NEW.command_ref\n AND p.writer_epoch IS json_extract(g.source_json,'$.writerEpoch')) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial G receipt permit/epoch required');\nEND",
});

/** Five-action consent fences. The epoch is the retained challenge's own column. */
export const FINANCIAL_0104_CONSENT_FENCE_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  shared_customer_challenges_money_fence:
    "CREATE TRIGGER shared_customer_challenges_money_fence BEFORE INSERT ON shared_customer_challenges\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2'\n AND p.writer_epoch IS NEW.writer_epoch) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial consent challenge permit/epoch required');\nEND",
  financial_payer_challenge_sources_money_fence:
    "CREATE TRIGGER financial_payer_challenge_sources_money_fence BEFORE INSERT ON financial_payer_challenge_sources\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM shared_customer_challenges c\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE c.challenge_ref IS NEW.challenge_ref AND p.writer_epoch IS c.writer_epoch) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial consent source permit/epoch required');\nEND",
  financial_payer_grants_money_fence:
    "CREATE TRIGGER financial_payer_grants_money_fence BEFORE INSERT ON financial_payer_grants\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM shared_customer_challenges c\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE c.challenge_ref IS NEW.challenge_ref AND p.writer_epoch IS c.writer_epoch) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial consent grant permit/epoch required');\nEND",
  financial_payer_consent_witnesses_money_fence:
    "CREATE TRIGGER financial_payer_consent_witnesses_money_fence BEFORE INSERT ON financial_payer_consent_witnesses\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM shared_customer_challenges c\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE c.challenge_ref IS NEW.challenge_ref AND p.writer_epoch IS c.writer_epoch) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial consent witness permit/epoch required');\nEND",
  financial_payer_consent_receipts_money_fence:
    "CREATE TRIGGER financial_payer_consent_receipts_money_fence BEFORE INSERT ON financial_payer_consent_receipts\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM shared_customer_challenges c\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE c.challenge_ref IS NEW.challenge_ref AND p.writer_epoch IS c.writer_epoch) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial consent receipt permit/epoch required');\nEND",
  financial_payer_grant_revocations_money_fence:
    "CREATE TRIGGER financial_payer_grant_revocations_money_fence BEFORE INSERT ON financial_payer_grant_revocations\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM financial_payer_grants g\n JOIN shared_customer_challenges c ON c.challenge_ref=g.challenge_ref\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE g.grant_ref IS NEW.grant_ref AND p.writer_epoch IS c.writer_epoch) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial consent revocation permit/epoch required');\nEND",
});

/** Every table that carries a Financial 0104 money fence. A Financial builder may
 * compile a batch only when each statement writes one of these tables. */
export const FINANCIAL_0104_FENCED_TABLES = Object.freeze([
  "financial_source_registrations",
  "financial_source_events",
  "financial_source_heads",
  "financial_source_receipts",
  "financial_preproof_challenges",
  "financial_preproof_challenge_receipts",
  "financial_source_materializations",
  "financial_source_materialization_receipts",
  "financial_source_genesis_admissions",
  "financial_source_genesis_admission_receipts",
  "financial_action_source_registrations",
  "financial_retained_r1_originals",
  "financial_retained_r1_receipts",
  "financial_r1_preparation_attempts",
  "shared_customer_challenges",
  "financial_payer_challenge_sources",
  "financial_payer_grants",
  "financial_payer_consent_witnesses",
  "financial_payer_consent_receipts",
  "financial_payer_grant_revocations",
] as const);

/** The one INSERT target of a Financial DATA statement, or undefined. */
export function financialStatementWriteTarget(sql: string): string | undefined {
  const targets = [
    ...sql.matchAll(
      /\b(?:INSERT|REPLACE|UPDATE|DELETE)\b(?:\s+OR\s+\w+)?\s+(?:INTO\s+|FROM\s+)?([A-Za-z_][A-Za-z0-9_]*)/giu,
    ),
  ].map((match) => match[1]);
  return targets.length === 1 ? targets[0] : undefined;
}

/** Static builder refusal: a non-empty batch whose every statement writes exactly
 * one fenced Financial table. A batch that writes no fenced table cannot be built. */
export function isFinancialMoneyFencedBatch(
  statements: readonly { readonly sql: string }[],
): boolean {
  return (
    statements.length > 0 &&
    statements.every((statement) => {
      const target = financialStatementWriteTarget(statement.sql);
      return (
        target !== undefined && (FINANCIAL_0104_FENCED_TABLES as readonly string[]).includes(target)
      );
    })
  );
}
