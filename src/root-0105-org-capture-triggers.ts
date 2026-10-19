/** Root-owned migration 0105 (0105 -> 0104): H0 Org history capture on Root's
 * orgs table. DATA only: nothing here registers or applies a migration.
 *
 * The four triggers never RAISE, never use orgs rowids, never write a fenced
 * table and never name a cutover-only money_cutover guard table. They only
 * append Financial 0104's unfenced, append-only observations: a birth on
 * INSERT (raw once per Org id while no capture is open; otherwise once per
 * open capture whose start roster lacks the id, skipped post-seal when the id
 * already has a row in Financial's derived org-keyed trace set), and a change
 * observation (strictly sequential change_seq) on an UPDATE of
 * id/owner/created_at, on a re-insert of an existing id with a different owner
 * (the REPLACE path; a same-owner UPSERT login appends nothing) and on DELETE.
 * Org create, rename, UPSERT, REPLACE, delete and re-create therefore succeed
 * on self-host and pre-cutover primaries that carry no money_cutover table.
 *
 * The trigger SQL is the exact H0 candidate text that Financial pins. The body
 * first adds Root org_id indexes for the Org trace tables that lack one, then
 * the triggers in source order, then a raw-birth backfill of every Org that
 * exists at install. The deploy recipe pins the digest of ROOT_0105_DDL. */

export const ROOT_0105_MIGRATION = "0105_root_org_history_capture.sql";
export const ROOT_0105_PREDECESSOR = "0104_financial_custody.sql";

export const ROOT_0105_ORG_CAPTURE_TRIGGERS: Readonly<Record<string, string>> = Object.freeze({
  financial_history_capture_org_replace:
    "CREATE TRIGGER financial_history_capture_org_replace BEFORE INSERT ON orgs\nWHEN EXISTS(SELECT 1 FROM orgs o WHERE o.id=NEW.id AND o.owner_principal_id IS NOT NEW.owner_principal_id)\nBEGIN\n INSERT INTO financial_customer_history_org_changes(change_ref,change_seq,change_kind,org_id,old_owner_principal_id,old_org_name,old_org_created_at,new_org_id,new_owner_principal_id,new_org_name,new_org_created_at)\n SELECT 'change:'||lower(hex(randomblob(16))),(SELECT COALESCE(max(change_seq),0)+1 FROM financial_customer_history_org_changes),'replace',o.id,o.owner_principal_id,o.name,o.created_at,NEW.id,NEW.owner_principal_id,NEW.name,NEW.created_at\n FROM orgs o WHERE o.id=NEW.id;\nEND",
  financial_history_capture_org_insert:
    "CREATE TRIGGER financial_history_capture_org_insert AFTER INSERT ON orgs\nBEGIN\n INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,owner_principal_id,org_name,org_created_at,phase,primary_ref,enrollment_ref,complete_seal_ref,seal_kind)\n SELECT 'birth:'||lower(hex(randomblob(16))),NEW.id,NEW.owner_principal_id,NEW.name,NEW.created_at,\n CASE WHEN h.state='sealed' AND r.receipt_ref IS NOT NULL THEN 'post-seal' ELSE 'during-enrollment' END,h.primary_ref,h.enrollment_ref,r.receipt_ref,CASE WHEN r.receipt_ref IS NOT NULL THEN 'complete-seal' ELSE NULL END\n FROM financial_history_enrollment_heads h JOIN financial_history_enrollments e ON e.enrollment_ref=h.enrollment_ref AND e.primary_ref=h.primary_ref LEFT JOIN financial_history_enrollment_receipts r ON r.receipt_ref=e.expected_seal_ref AND r.receipt_kind='complete-seal' AND r.enrollment_ref=e.enrollment_ref\n WHERE h.state IN('capturing','sealed')\n AND NOT EXISTS(SELECT 1 FROM financial_history_enrollment_roster ro WHERE ro.enrollment_ref=e.enrollment_ref AND ro.org_id=NEW.id)\n AND NOT EXISTS(SELECT 1 FROM financial_customer_history_birth_observations b WHERE b.org_id=NEW.id AND b.primary_ref=h.primary_ref AND b.enrollment_ref=h.enrollment_ref)\n AND NOT (h.state='sealed' AND r.receipt_ref IS NOT NULL AND (((((EXISTS(SELECT 1 FROM auth_tokens m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM financial_customer_admission_receipts m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM financial_customer_custody_receipts m WHERE m.org_id=NEW.id))) OR (EXISTS(SELECT 1 FROM financial_customer_dispatch_claims m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM financial_customer_dispatch_receipts m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM integration_e2e_credential_pair_operations m WHERE m.org_id=NEW.id)))) OR ((EXISTS(SELECT 1 FROM ledger m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM money_cutover_aggregates m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM org_wallet_cash_cap_buckets m WHERE m.org_id=NEW.id))) OR ((EXISTS(SELECT 1 FROM org_wallet_cash_exposures m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM org_wallet_grant_snapshots m WHERE m.org_id=NEW.id)) OR (EXISTS(SELECT 1 FROM org_wallet_holds m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM org_wallet_limit_policies m WHERE m.org_id=NEW.id))))) OR (((EXISTS(SELECT 1 FROM org_wallet_limit_policy_commands m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM org_wallet_usage_records m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM org_wallet_usage_warnings m WHERE m.org_id=NEW.id))) OR ((EXISTS(SELECT 1 FROM org_wallet_workspace_bindings m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM org_wallet_workspace_snapshots m WHERE m.org_id=NEW.id)) OR (EXISTS(SELECT 1 FROM quotes m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM reseller_settlement_intents m WHERE m.org_id=NEW.id)))) OR ((EXISTS(SELECT 1 FROM reservations m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM sponsorship_credential_issuance_operations m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM sponsorship_tenants m WHERE m.org_id=NEW.id))) OR ((EXISTS(SELECT 1 FROM stripe_billing_associations m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_card_setup_commands m WHERE m.org_id=NEW.id)) OR (EXISTS(SELECT 1 FROM stripe_billing_card_setup_results m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_checkouts m WHERE m.org_id=NEW.id)))))) OR ((((EXISTS(SELECT 1 FROM stripe_billing_commands m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM stripe_billing_customer_commands m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_customers m WHERE m.org_id=NEW.id))) OR (EXISTS(SELECT 1 FROM stripe_billing_fences m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM stripe_billing_grants m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_on_demand_abandonments m WHERE m.org_id=NEW.id)))) OR ((EXISTS(SELECT 1 FROM stripe_billing_on_demand_attempts m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM stripe_billing_on_demand_commands m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_on_demand_funding m WHERE m.org_id=NEW.id))) OR ((EXISTS(SELECT 1 FROM stripe_billing_on_demand_refunds m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_on_demand_terminals m WHERE m.org_id=NEW.id)) OR (EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_plan_change_steps m WHERE m.org_id=NEW.id))))) OR (((EXISTS(SELECT 1 FROM stripe_billing_plan_changes m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM stripe_billing_refunds m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_subscription_term_revocations m WHERE m.org_id=NEW.id))) OR ((EXISTS(SELECT 1 FROM stripe_billing_subscription_terms m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_billing_subscriptions m WHERE m.org_id=NEW.id)) OR (EXISTS(SELECT 1 FROM stripe_customer_admission_links m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents m WHERE m.org_id=NEW.id)))) OR ((EXISTS(SELECT 1 FROM stripe_subscription_checkout_intents m WHERE m.org_id=NEW.id) OR (EXISTS(SELECT 1 FROM stripe_top_up_commands m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM usage_events m WHERE m.org_id=NEW.id))) OR ((EXISTS(SELECT 1 FROM usage_statements m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM wallet_credit_allocations m WHERE m.org_id=NEW.id)) OR (EXISTS(SELECT 1 FROM wallet_credit_lot_classification_proofs m WHERE m.org_id=NEW.id) OR EXISTS(SELECT 1 FROM wallet_credit_lots m WHERE m.org_id=NEW.id))))))));\n INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,owner_principal_id,org_name,org_created_at,phase)\n SELECT 'birth:'||lower(hex(randomblob(16))),NEW.id,NEW.owner_principal_id,NEW.name,NEW.created_at,'raw'\n WHERE NOT EXISTS(SELECT 1 FROM financial_history_enrollment_heads WHERE state IN('capturing','sealed'))\n AND NOT EXISTS(SELECT 1 FROM financial_customer_history_birth_observations b WHERE b.org_id=NEW.id AND b.phase='raw');\nEND",
  financial_history_capture_org_update:
    "CREATE TRIGGER financial_history_capture_org_update AFTER UPDATE ON orgs\nWHEN OLD.id IS NOT NEW.id OR OLD.owner_principal_id IS NOT NEW.owner_principal_id OR OLD.created_at IS NOT NEW.created_at\nBEGIN\n INSERT INTO financial_customer_history_org_changes(change_ref,change_seq,change_kind,org_id,old_owner_principal_id,old_org_name,old_org_created_at,new_org_id,new_owner_principal_id,new_org_name,new_org_created_at)\n VALUES('change:'||lower(hex(randomblob(16))),(SELECT COALESCE(max(change_seq),0)+1 FROM financial_customer_history_org_changes),'update',OLD.id,OLD.owner_principal_id,OLD.name,OLD.created_at,NEW.id,NEW.owner_principal_id,NEW.name,NEW.created_at);\nEND",
  financial_history_capture_org_delete:
    "CREATE TRIGGER financial_history_capture_org_delete AFTER DELETE ON orgs\nBEGIN\n INSERT INTO financial_customer_history_org_changes(change_ref,change_seq,change_kind,org_id,old_owner_principal_id,old_org_name,old_org_created_at)\n VALUES('change:'||lower(hex(randomblob(16))),(SELECT COALESCE(max(change_seq),0)+1 FROM financial_customer_history_org_changes),'delete',OLD.id,OLD.owner_principal_id,OLD.name,OLD.created_at);\nEND",
});

/** Root org_id indexes for the Org trace tables that lack one, so the Org
 * INSERT trigger's trace check searches instead of scanning. Plain CREATE
 * INDEX: a foreign object with the same name refuses the migration. */
export const ROOT_0105_TRACE_INDEXES: Readonly<Record<string, readonly [string, string]>> =
  Object.freeze({
    usage_statements_by_org: [
      "usage_statements",
      "CREATE INDEX usage_statements_by_org ON usage_statements(org_id)",
    ],
    sponsorship_tenants_by_org: [
      "sponsorship_tenants",
      "CREATE INDEX sponsorship_tenants_by_org ON sponsorship_tenants(org_id)",
    ],
    sponsorship_credential_issuance_operations_by_org: [
      "sponsorship_credential_issuance_operations",
      "CREATE INDEX sponsorship_credential_issuance_operations_by_org ON sponsorship_credential_issuance_operations(org_id)",
    ],
    stripe_billing_subscription_term_revocations_by_org: [
      "stripe_billing_subscription_term_revocations",
      "CREATE INDEX stripe_billing_subscription_term_revocations_by_org ON stripe_billing_subscription_term_revocations(org_id)",
    ],
    integration_e2e_credential_pair_operations_by_org: [
      "integration_e2e_credential_pair_operations",
      "CREATE INDEX integration_e2e_credential_pair_operations_by_org ON integration_e2e_credential_pair_operations(org_id)",
    ],
    money_cutover_aggregates_by_org: [
      "money_cutover_aggregates",
      "CREATE INDEX money_cutover_aggregates_by_org ON money_cutover_aggregates(org_id)",
    ],
  });

/** Install-time backfill: one raw birth for every Org existing when 0105 lands
 * (no capture can be open then, so raw is the exact cascade shape). It never
 * duplicates a raw birth and writes nothing while any capture is open. */
export const ROOT_0105_BIRTH_BACKFILL =
  "INSERT INTO financial_customer_history_birth_observations(birth_ref,org_id,owner_principal_id,org_name,org_created_at,phase)\nSELECT 'birth:'||lower(hex(randomblob(16))),o.id,o.owner_principal_id,o.name,o.created_at,'raw' FROM orgs o\nWHERE NOT EXISTS(SELECT 1 FROM financial_history_enrollment_heads WHERE state IN('capturing','sealed'))\n AND NOT EXISTS(SELECT 1 FROM financial_customer_history_birth_observations b WHERE b.org_id=o.id AND b.phase='raw')";

/** The exact migration body: indexes, every trigger in source order, backfill. */
export const ROOT_0105_DDL = `${[
  ...Object.values(ROOT_0105_TRACE_INDEXES).map(([, sql]) => sql),
  ...Object.values(ROOT_0105_ORG_CAPTURE_TRIGGERS),
  ROOT_0105_BIRTH_BACKFILL,
]
  .map((sql) => `${sql};`)
  .join("\n")}\n`;

/** Exact persistent objects 0105 adds (sqlite_schema rows); the backfill adds none. */
export const ROOT_0105_OBJECTS: readonly {
  readonly type: "index" | "trigger";
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}[] = Object.freeze([
  ...Object.entries(ROOT_0105_TRACE_INDEXES).map(([name, [table, sql]]) =>
    Object.freeze({ type: "index" as const, name, tbl_name: table, sql }),
  ),
  ...Object.entries(ROOT_0105_ORG_CAPTURE_TRIGGERS).map(([name, sql]) =>
    Object.freeze({ type: "trigger" as const, name, tbl_name: "orgs", sql }),
  ),
]);
