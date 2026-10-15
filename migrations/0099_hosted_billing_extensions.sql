-- PRIVATE DRAFT. Provisional 0099 allocation; not an applied or publishable
-- lineage. The owning 0096-0098 migrations must be genuinely adopted first.
-- Additive extension only: existing money, cutover proof, holds, settlements,
-- processor ownership associations, and migration bytes remain unchanged.

CREATE TABLE personal_organizations (
  principal_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (principal_id) REFERENCES principals(id),
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);
CREATE TRIGGER personal_organizations_owner_insert BEFORE INSERT ON personal_organizations
WHEN NOT EXISTS (
  SELECT 1 FROM principals AS principal
  JOIN orgs AS organization ON organization.id = NEW.org_id
  JOIN org_memberships AS membership ON membership.org_id = organization.id
    AND membership.principal_id = principal.id AND membership.role = 'owner'
  WHERE principal.id = NEW.principal_id AND principal.provider IN ('google', 'github')
    AND organization.owner_principal_id = principal.id)
  OR EXISTS (SELECT 1 FROM org_memberships WHERE org_id = NEW.org_id
             AND role = 'owner' AND principal_id <> NEW.principal_id)
BEGIN
  SELECT RAISE(ABORT, 'constraint: personal Organization owner proof is required');
END;
CREATE TRIGGER personal_organizations_no_update BEFORE UPDATE ON personal_organizations
BEGIN
  SELECT RAISE(ABORT, 'constraint: personal Organization mapping is immutable');
END;
CREATE TRIGGER personal_organizations_no_delete BEFORE DELETE ON personal_organizations
BEGIN
  SELECT RAISE(ABORT, 'constraint: personal Organization mapping is immutable');
END;

-- References are opaque random product aliases. A first binding establishes
-- the owning Org globally; no identifier or ownership is inferred from history.
CREATE TABLE org_wallet_workspace_bindings (
  workspace_ref TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(workspace_ref) BETWEEN 1 AND 256),
  CHECK (length(org_id) BETWEEN 1 AND 128)
);
CREATE INDEX org_wallet_workspace_bindings_org
  ON org_wallet_workspace_bindings (org_id, workspace_ref);
CREATE TRIGGER org_wallet_workspace_bindings_no_update
BEFORE UPDATE ON org_wallet_workspace_bindings
BEGIN
  SELECT RAISE(ABORT, 'constraint: Workspace Organization binding is immutable');
END;
CREATE TRIGGER org_wallet_workspace_bindings_no_delete
BEFORE DELETE ON org_wallet_workspace_bindings
BEGIN
  SELECT RAISE(ABORT, 'constraint: Workspace Organization binding is immutable');
END;

-- Nullable additions preserve legacy rows and their original fingerprints.
-- New admission pins an interval even when independent/self-host usage is
-- unattributed. Runtime proves the interval against immutable period evidence.
ALTER TABLE org_wallet_holds ADD COLUMN workspace_ref TEXT
  CHECK (workspace_ref IS NULL OR length(workspace_ref) BETWEEN 1 AND 256);
ALTER TABLE org_wallet_holds ADD COLUMN attribution_period_start TEXT;
ALTER TABLE org_wallet_holds ADD COLUMN attribution_period_end TEXT;
ALTER TABLE org_wallet_holds ADD COLUMN admission_policy_json TEXT
  CHECK (admission_policy_json IS NULL OR json_valid(admission_policy_json));
ALTER TABLE org_wallet_usage_records ADD COLUMN workspace_ref TEXT
  CHECK (workspace_ref IS NULL OR length(workspace_ref) BETWEEN 1 AND 256);
ALTER TABLE org_wallet_usage_records ADD COLUMN attribution_period_start TEXT;
ALTER TABLE org_wallet_usage_records ADD COLUMN attribution_period_end TEXT;
ALTER TABLE org_wallet_usage_records ADD COLUMN admission_policy_json TEXT
  CHECK (admission_policy_json IS NULL OR json_valid(admission_policy_json));
-- Raw measured usage may settle later in a rollup. Its original admission
-- policy is a receipt too; later policy changes cannot authorize its debit.
ALTER TABLE usage_events ADD COLUMN admission_policy_json TEXT
  CHECK (admission_policy_json IS NULL OR json_valid(admission_policy_json));
CREATE TRIGGER usage_events_admission_policy_immutable
BEFORE UPDATE OF admission_policy_json ON usage_events
WHEN NEW.admission_policy_json IS NOT OLD.admission_policy_json
BEGIN
  SELECT RAISE(ABORT, 'constraint: measured usage admission policy is immutable');
END;

CREATE TRIGGER org_wallet_holds_attribution_insert BEFORE INSERT ON org_wallet_holds
WHEN ((NEW.attribution_period_start IS NULL) <> (NEW.attribution_period_end IS NULL))
  OR (NEW.attribution_period_start IS NOT NULL AND
      NEW.attribution_period_start >= NEW.attribution_period_end)
  OR (NEW.workspace_ref IS NOT NULL AND
      (NEW.attribution_period_start IS NULL OR NOT EXISTS (
        SELECT 1 FROM org_wallet_workspace_bindings AS binding
        WHERE binding.workspace_ref = NEW.workspace_ref AND binding.org_id = NEW.org_id)))
BEGIN
  SELECT RAISE(ABORT, 'constraint: invalid hold Workspace attribution');
END;
CREATE TRIGGER org_wallet_holds_attribution_immutable
BEFORE UPDATE OF org_id, workspace_ref, attribution_period_start, attribution_period_end ON org_wallet_holds
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.workspace_ref IS NOT OLD.workspace_ref
  OR NEW.attribution_period_start IS NOT OLD.attribution_period_start
  OR NEW.attribution_period_end IS NOT OLD.attribution_period_end
BEGIN
  SELECT RAISE(ABORT, 'constraint: hold Workspace attribution is immutable');
END;
CREATE TRIGGER org_wallet_holds_admission_policy_immutable
BEFORE UPDATE OF admission_policy_json ON org_wallet_holds
WHEN NEW.admission_policy_json IS NOT OLD.admission_policy_json
BEGIN
  SELECT RAISE(ABORT, 'constraint: hold admission policy is immutable');
END;
CREATE TRIGGER org_wallet_usage_attribution_insert BEFORE INSERT ON org_wallet_usage_records
WHEN ((NEW.attribution_period_start IS NULL) <> (NEW.attribution_period_end IS NULL))
  OR (NEW.attribution_period_start IS NOT NULL AND
      NEW.attribution_period_start >= NEW.attribution_period_end)
  OR (NEW.workspace_ref IS NOT NULL AND
      (NEW.attribution_period_start IS NULL OR NOT EXISTS (
        SELECT 1 FROM org_wallet_workspace_bindings AS binding
        WHERE binding.workspace_ref = NEW.workspace_ref AND binding.org_id = NEW.org_id)))
BEGIN
  SELECT RAISE(ABORT, 'constraint: invalid usage Workspace attribution');
END;
CREATE TRIGGER org_wallet_usage_admission_policy_immutable
BEFORE UPDATE OF admission_policy_json ON org_wallet_usage_records
WHEN NEW.admission_policy_json IS NOT OLD.admission_policy_json
BEGIN
  SELECT RAISE(ABORT, 'constraint: usage admission policy is immutable');
END;
CREATE TRIGGER org_wallet_usage_attribution_immutable
BEFORE UPDATE OF org_id, workspace_ref, attribution_period_start, attribution_period_end
ON org_wallet_usage_records
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.workspace_ref IS NOT OLD.workspace_ref
  OR NEW.attribution_period_start IS NOT OLD.attribution_period_start
  OR NEW.attribution_period_end IS NOT OLD.attribution_period_end
BEGIN
  SELECT RAISE(ABORT, 'constraint: usage Workspace attribution is immutable');
END;
CREATE INDEX org_wallet_holds_workspace_period
  ON org_wallet_holds (org_id, attribution_period_start, attribution_period_end, workspace_ref, state);
CREATE INDEX org_wallet_usage_workspace_period
  ON org_wallet_usage_records (org_id, attribution_period_start, attribution_period_end, workspace_ref, state);

-- A bounded durable projection pins mutable held/pending state. A building
-- header and all its rows are written in one batch; ready is the publication
-- barrier. Cleanup deletes complete snapshots, never one ready row.
CREATE TABLE org_wallet_workspace_snapshots (
  snapshot_ref TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  workspace_filter TEXT,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  used_micros INTEGER NOT NULL DEFAULT 0 CHECK (typeof(used_micros) = 'integer' AND used_micros BETWEEN 0 AND 9007199254740991),
  held_micros INTEGER NOT NULL DEFAULT 0 CHECK (typeof(held_micros) = 'integer' AND held_micros BETWEEN 0 AND 9007199254740991),
  pending_micros INTEGER NOT NULL DEFAULT 0 CHECK (typeof(pending_micros) = 'integer' AND pending_micros BETWEEN 0 AND 9007199254740991),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready')),
  CHECK (length(snapshot_ref) = 32 AND snapshot_ref NOT GLOB '*[^0-9a-f]*'),
  CHECK (period_start < period_end),
  CHECK (strftime('%s', snapshot_at) IS NOT NULL AND strftime('%s', expires_at) IS NOT NULL),
  CHECK (expires_at > snapshot_at AND
         CAST(strftime('%s', expires_at) AS INTEGER) -
         CAST(strftime('%s', snapshot_at) AS INTEGER) <= 600)
);
CREATE INDEX org_wallet_workspace_snapshots_org_expiry
  ON org_wallet_workspace_snapshots (org_id, expires_at, snapshot_ref);
CREATE TRIGGER org_wallet_workspace_snapshots_bound BEFORE INSERT ON org_wallet_workspace_snapshots
WHEN NEW.status <> 'building'
  OR (SELECT COUNT(*) FROM org_wallet_workspace_snapshots WHERE org_id = NEW.org_id) >= 8
BEGIN
  SELECT RAISE(ABORT, 'constraint: Workspace snapshot capacity exceeded');
END;
CREATE TRIGGER org_wallet_workspace_snapshots_identity_immutable
BEFORE UPDATE ON org_wallet_workspace_snapshots
WHEN OLD.status = 'ready'
  OR NEW.snapshot_ref IS NOT OLD.snapshot_ref OR NEW.org_id IS NOT OLD.org_id
  OR NEW.snapshot_at IS NOT OLD.snapshot_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.period_start IS NOT OLD.period_start OR NEW.period_end IS NOT OLD.period_end
  OR NEW.workspace_filter IS NOT OLD.workspace_filter OR NEW.summary_json IS NOT OLD.summary_json
BEGIN
  SELECT RAISE(ABORT, 'constraint: published Workspace snapshot is immutable');
END;
CREATE TABLE org_wallet_workspace_snapshot_rows (
  snapshot_ref TEXT NOT NULL,
  workspace_ref TEXT NOT NULL,
  used_micros INTEGER NOT NULL CHECK (typeof(used_micros) = 'integer' AND used_micros BETWEEN 0 AND 9007199254740991),
  held_micros INTEGER NOT NULL CHECK (typeof(held_micros) = 'integer' AND held_micros BETWEEN 0 AND 9007199254740991),
  pending_micros INTEGER NOT NULL CHECK (typeof(pending_micros) = 'integer' AND pending_micros BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (snapshot_ref, workspace_ref),
  FOREIGN KEY (snapshot_ref) REFERENCES org_wallet_workspace_snapshots(snapshot_ref) ON DELETE CASCADE,
  CHECK (length(workspace_ref) <= 256)
);
CREATE TRIGGER org_wallet_workspace_snapshot_rows_insert
BEFORE INSERT ON org_wallet_workspace_snapshot_rows
WHEN NOT EXISTS (
  SELECT 1 FROM org_wallet_workspace_snapshots
  WHERE snapshot_ref = NEW.snapshot_ref AND status = 'building')
  OR (SELECT COUNT(*) FROM org_wallet_workspace_snapshot_rows
      WHERE snapshot_ref = NEW.snapshot_ref) >= 10001
  OR (NEW.workspace_ref <> '' AND NOT EXISTS (
    SELECT 1 FROM org_wallet_workspace_snapshots AS snapshot
    JOIN org_wallet_workspace_bindings AS binding ON binding.org_id = snapshot.org_id
      AND binding.workspace_ref = NEW.workspace_ref
    WHERE snapshot.snapshot_ref = NEW.snapshot_ref))
BEGIN
  SELECT RAISE(ABORT, 'constraint: Workspace snapshot rows are frozen or full');
END;
CREATE TRIGGER org_wallet_workspace_snapshot_rows_no_update
BEFORE UPDATE ON org_wallet_workspace_snapshot_rows
BEGIN
  SELECT RAISE(ABORT, 'constraint: Workspace snapshot row is immutable');
END;
CREATE TRIGGER org_wallet_workspace_snapshot_rows_no_partial_delete
BEFORE DELETE ON org_wallet_workspace_snapshot_rows
WHEN EXISTS (SELECT 1 FROM org_wallet_workspace_snapshots
             WHERE snapshot_ref = OLD.snapshot_ref AND status = 'ready')
BEGIN
  SELECT RAISE(ABORT, 'constraint: published Workspace snapshot rows are immutable');
END;
CREATE TRIGGER org_wallet_workspace_snapshots_ready_proof
BEFORE UPDATE OF status ON org_wallet_workspace_snapshots
WHEN NEW.status = 'ready' AND (
  NEW.row_count <> (SELECT COUNT(*) FROM org_wallet_workspace_snapshot_rows
                   WHERE snapshot_ref = NEW.snapshot_ref AND workspace_ref <> '')
  OR NOT EXISTS (SELECT 1 FROM org_wallet_workspace_snapshot_rows
                 WHERE snapshot_ref = NEW.snapshot_ref AND workspace_ref = '')
  OR NEW.used_micros <> (SELECT COALESCE(SUM(used_micros), 0)
                        FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = NEW.snapshot_ref)
  OR NEW.held_micros <> (SELECT COALESCE(SUM(held_micros), 0)
                        FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = NEW.snapshot_ref)
  OR NEW.pending_micros <> (SELECT COALESCE(SUM(pending_micros), 0)
                           FROM org_wallet_workspace_snapshot_rows WHERE snapshot_ref = NEW.snapshot_ref))
BEGIN
  SELECT RAISE(ABORT, 'constraint: Workspace snapshot totals require complete frozen rows');
END;

-- Top-up has one processor effect, Checkout, and only accepts a customer
-- already proven by the owning customer custody. JSON pins realm, revision,
-- cash/expiry, return URLs and the exact request before the first dispatch.
CREATE TABLE stripe_top_up_commands (
  org_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  stripe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'paid', 'expired')),
  session_id TEXT UNIQUE,
  session_url TEXT,
  dispatched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, reference),
  CHECK (state = 'pending' OR session_id IS NOT NULL),
  CHECK (state <> 'ready' OR session_url IS NOT NULL)
);
CREATE UNIQUE INDEX stripe_top_up_pending_org ON stripe_top_up_commands (org_id)
  WHERE state = 'pending';
CREATE TRIGGER stripe_top_up_command_immutable BEFORE UPDATE ON stripe_top_up_commands
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.reference IS NOT OLD.reference
  OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.command_json IS NOT OLD.command_json
  OR NEW.stripe_key IS NOT OLD.stripe_key OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
  OR (OLD.session_url IS NOT NULL AND NEW.session_url IS NOT OLD.session_url)
  OR (OLD.state IN ('paid', 'expired') AND NEW.state IS NOT OLD.state)
  OR (OLD.state = 'ready' AND NEW.state = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'constraint: top-up command proof is immutable');
END;
CREATE TRIGGER stripe_top_up_commands_no_delete BEFORE DELETE ON stripe_top_up_commands
BEGIN
  SELECT RAISE(ABORT, 'constraint: top-up command proof is durable');
END;

-- Customer creation is its own processor effect. It must be recovered and
-- verified before a Checkout command can pin the customer. The association in
-- stripe_billing_customers remains the sole Org/customer ownership authority;
-- this table records only the immutable processor command and step custody.
CREATE TABLE stripe_billing_customer_commands (
  org_id TEXT PRIMARY KEY NOT NULL,
  realm_json TEXT NOT NULL CHECK (json_valid(realm_json)),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  fingerprint TEXT NOT NULL,
  stripe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'verified')),
  dispatched_at TEXT,
  customer_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  CHECK (state <> 'verified' OR (customer_id IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE TRIGGER stripe_billing_customer_commands_immutable
BEFORE UPDATE ON stripe_billing_customer_commands
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.realm_json IS NOT OLD.realm_json
  OR NEW.request_json IS NOT OLD.request_json OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.stripe_key IS NOT OLD.stripe_key OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
  OR (OLD.customer_id IS NOT NULL AND NEW.customer_id IS NOT OLD.customer_id)
  OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS NOT OLD.verified_at)
  OR (OLD.state = 'dispatched' AND NEW.state = 'prepared')
  OR (OLD.state = 'verified' AND NEW.state IS NOT OLD.state)
BEGIN
  SELECT RAISE(ABORT, 'constraint: customer processor command is immutable');
END;
CREATE TRIGGER stripe_billing_customer_commands_no_delete
BEFORE DELETE ON stripe_billing_customer_commands
BEGIN
  SELECT RAISE(ABORT, 'constraint: customer processor command custody is durable');
END;
CREATE TRIGGER stripe_billing_customer_commands_verified_insert
BEFORE INSERT ON stripe_billing_customer_commands
WHEN NEW.state = 'verified' AND NOT EXISTS (
  SELECT 1 FROM stripe_billing_customers
  WHERE org_id = NEW.org_id AND customer_id = NEW.customer_id)
BEGIN
  SELECT RAISE(ABORT, 'constraint: verified customer command requires its exact Organization association');
END;
CREATE TRIGGER stripe_billing_customer_commands_verified_update
BEFORE UPDATE ON stripe_billing_customer_commands
WHEN NEW.state = 'verified' AND NOT EXISTS (
  SELECT 1 FROM stripe_billing_customers
  WHERE org_id = NEW.org_id AND customer_id = NEW.customer_id)
BEGIN
  SELECT RAISE(ABORT, 'constraint: verified customer command requires its exact Organization association');
END;

-- Ownership stays in #342's immutable subscription association. These
-- half-open service-period terms extend the selected commercial tuple without
-- mutating it. Invoice selection must prove a complete noncrossing interval.
CREATE TABLE stripe_billing_subscription_terms (
  subscription_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  org_id TEXT NOT NULL,
  terms_json TEXT NOT NULL CHECK (json_valid(terms_json)),
  command_reference TEXT,
  PRIMARY KEY (subscription_id, effective_at)
);
CREATE INDEX stripe_billing_subscription_terms_org
  ON stripe_billing_subscription_terms (org_id, subscription_id, effective_at);
CREATE TRIGGER stripe_billing_subscription_terms_no_update
BEFORE UPDATE ON stripe_billing_subscription_terms
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription phase terms are immutable');
END;
CREATE TRIGGER stripe_billing_subscription_terms_no_delete
BEFORE DELETE ON stripe_billing_subscription_terms
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription phase terms are immutable');
END;
CREATE TRIGGER stripe_billing_subscription_terms_org_insert
BEFORE INSERT ON stripe_billing_subscription_terms
WHEN EXISTS (SELECT 1 FROM stripe_billing_subscription_terms
             WHERE subscription_id = NEW.subscription_id AND org_id <> NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription phase terms must preserve the Organization');
END;

CREATE TABLE stripe_billing_plan_changes (
  org_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plan-change', 'cancel', 'withdraw')),
  expected_subscription_ref TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (typeof(expected_generation) = 'integer' AND expected_generation BETWEEN 0 AND 9007199254740991),
  desired_json TEXT NOT NULL CHECK (json_valid(desired_json)),
  frozen_json TEXT NOT NULL CHECK (json_valid(frozen_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified')),
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, reference),
  CHECK (state <> 'verified' OR receipt_json IS NOT NULL)
);
CREATE TRIGGER stripe_billing_plan_changes_immutable BEFORE UPDATE ON stripe_billing_plan_changes
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.reference IS NOT OLD.reference
  OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.kind IS NOT OLD.kind
  OR NEW.expected_subscription_ref IS NOT OLD.expected_subscription_ref
  OR NEW.subscription_id IS NOT OLD.subscription_id
  OR NEW.expected_generation IS NOT OLD.expected_generation
  OR NEW.desired_json IS NOT OLD.desired_json OR NEW.frozen_json IS NOT OLD.frozen_json
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.state = 'verified' AND
      (NEW.state IS NOT OLD.state OR NEW.receipt_json IS NOT OLD.receipt_json))
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription command proof is immutable');
END;
CREATE TRIGGER stripe_billing_plan_changes_no_delete BEFORE DELETE ON stripe_billing_plan_changes
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription command proof is durable');
END;
CREATE TABLE stripe_billing_plan_change_slots (
  org_id TEXT PRIMARY KEY NOT NULL,
  reference TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (org_id, reference) REFERENCES stripe_billing_plan_changes(org_id, reference)
);
CREATE TABLE stripe_billing_plan_change_steps (
  org_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  step TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'verified')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  remote_id TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  verified_at TEXT,
  PRIMARY KEY (org_id, reference, step),
  FOREIGN KEY (org_id, reference) REFERENCES stripe_billing_plan_changes(org_id, reference),
  CHECK (state <> 'verified' OR response_json IS NOT NULL)
);
CREATE TRIGGER stripe_billing_plan_change_steps_immutable
BEFORE UPDATE ON stripe_billing_plan_change_steps
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.reference IS NOT OLD.reference
  OR NEW.step IS NOT OLD.step OR NEW.request_json IS NOT OLD.request_json
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
  OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS NOT OLD.verified_at)
  OR (OLD.remote_id IS NOT NULL AND NEW.remote_id IS NOT OLD.remote_id)
  OR (OLD.state = 'dispatched' AND NEW.state = 'prepared')
  OR (OLD.state = 'verified' AND
      (NEW.state IS NOT OLD.state OR NEW.response_json IS NOT OLD.response_json))
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription step custody is immutable');
END;
CREATE TRIGGER stripe_billing_plan_change_steps_no_delete
BEFORE DELETE ON stripe_billing_plan_change_steps
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription step custody is durable');
END;

-- A released future schedule invalidates its future term without deleting
-- historical pricing proof. A release after activation cannot revoke history.
CREATE TABLE stripe_billing_subscription_term_revocations (
  subscription_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  org_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  released_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, effective_at, reference),
  FOREIGN KEY (subscription_id, effective_at)
    REFERENCES stripe_billing_subscription_terms(subscription_id, effective_at),
  FOREIGN KEY (org_id, reference) REFERENCES stripe_billing_plan_changes(org_id, reference),
  CHECK (released_at < effective_at)
);
CREATE TRIGGER stripe_billing_subscription_term_revocations_no_update
BEFORE UPDATE ON stripe_billing_subscription_term_revocations
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription term release proof is immutable');
END;
CREATE TRIGGER stripe_billing_subscription_term_revocations_no_delete
BEFORE DELETE ON stripe_billing_subscription_term_revocations
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription term release proof is immutable');
END;
CREATE TRIGGER stripe_billing_subscription_term_revocations_owner_insert
BEFORE INSERT ON stripe_billing_subscription_term_revocations
WHEN NOT EXISTS (SELECT 1 FROM stripe_billing_subscription_terms
                 WHERE subscription_id = NEW.subscription_id AND effective_at = NEW.effective_at
                   AND org_id = NEW.org_id)
  OR NOT EXISTS (SELECT 1 FROM stripe_billing_plan_changes
                 WHERE org_id = NEW.org_id AND reference = NEW.reference
                   AND subscription_id = NEW.subscription_id)
BEGIN
  SELECT RAISE(ABORT, 'constraint: subscription term release must preserve the Organization and target');
END;

-- Retail capability qualification is separate. Storing the policy vocabulary
-- does not enable postpaid or on-demand, nor authorize an external charge.
CREATE TABLE org_wallet_limit_policies (
  org_id TEXT PRIMARY KEY NOT NULL,
  on_limit TEXT NOT NULL CHECK (on_limit IN ('stop', 'prepaid', 'postpaid', 'on-demand')),
  policy_version INTEGER NOT NULL CHECK (typeof(policy_version) = 'integer' AND policy_version BETWEEN 1 AND 9007199254740991),
  consent_revision TEXT,
  cash_cap_minor INTEGER CHECK (cash_cap_minor IS NULL OR (typeof(cash_cap_minor) = 'integer' AND cash_cap_minor BETWEEN 0 AND 9007199254740991)),
  authorized_principal TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER org_wallet_limit_policy_version BEFORE UPDATE ON org_wallet_limit_policies
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.policy_version <> OLD.policy_version + 1
BEGIN
  SELECT RAISE(ABORT, 'constraint: limit policy requires the next version');
END;
CREATE TRIGGER org_wallet_limit_policies_no_delete BEFORE DELETE ON org_wallet_limit_policies
BEGIN
  SELECT RAISE(ABORT, 'constraint: limit policy version history is durable');
END;
CREATE TABLE org_wallet_limit_policy_commands (
  org_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  authorized_principal TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, ref)
);
CREATE TRIGGER org_wallet_limit_policy_commands_no_update
BEFORE UPDATE ON org_wallet_limit_policy_commands
BEGIN
  SELECT RAISE(ABORT, 'constraint: limit policy command receipt is immutable');
END;
CREATE TRIGGER org_wallet_limit_policy_commands_no_delete
BEFORE DELETE ON org_wallet_limit_policy_commands
BEGIN
  SELECT RAISE(ABORT, 'constraint: limit policy command receipt is durable');
END;
CREATE TABLE org_wallet_cash_cap_buckets (
  org_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  PRIMARY KEY (org_id, period_start),
  CHECK (period_start < period_end)
);
CREATE TRIGGER org_wallet_cash_cap_buckets_no_update BEFORE UPDATE ON org_wallet_cash_cap_buckets
BEGIN
  SELECT RAISE(ABORT, 'constraint: cash cap period is immutable');
END;
CREATE TRIGGER org_wallet_cash_cap_buckets_no_delete BEFORE DELETE ON org_wallet_cash_cap_buckets
BEGIN
  SELECT RAISE(ABORT, 'constraint: cash cap period is durable');
END;
CREATE TABLE org_wallet_cash_exposures (
  org_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (typeof(policy_version) = 'integer' AND policy_version BETWEEN 1 AND 9007199254740991),
  consent_revision TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'paid', 'released')),
  source_ref TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (org_id, ref),
  FOREIGN KEY (org_id, period_start) REFERENCES org_wallet_cash_cap_buckets(org_id, period_start),
  CHECK (period_start < period_end),
  CHECK ((status = 'reserved' AND closed_at IS NULL) OR (status <> 'reserved' AND closed_at IS NOT NULL)),
  CHECK (status <> 'reserved' OR source_ref IS NULL),
  CHECK (status <> 'paid' OR source_ref IS NOT NULL)
);
CREATE UNIQUE INDEX org_wallet_cash_exposures_paid_source
  ON org_wallet_cash_exposures (org_id, source_ref) WHERE status = 'paid';
CREATE INDEX org_wallet_cash_exposures_bucket
  ON org_wallet_cash_exposures (org_id, period_start, status, ref);
CREATE TRIGGER org_wallet_cash_exposures_bucket_insert BEFORE INSERT ON org_wallet_cash_exposures
WHEN NOT EXISTS (SELECT 1 FROM org_wallet_cash_cap_buckets
                 WHERE org_id = NEW.org_id AND period_start = NEW.period_start
                   AND period_end = NEW.period_end)
BEGIN
  SELECT RAISE(ABORT, 'constraint: cash exposure period must match its frozen bucket');
END;
CREATE TRIGGER org_wallet_cash_exposures_immutable BEFORE UPDATE ON org_wallet_cash_exposures
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.ref IS NOT OLD.ref
  OR NEW.period_start IS NOT OLD.period_start OR NEW.period_end IS NOT OLD.period_end
  OR NEW.policy_version IS NOT OLD.policy_version OR NEW.consent_revision IS NOT OLD.consent_revision
  OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status <> 'reserved' AND
      (NEW.status IS NOT OLD.status OR NEW.source_ref IS NOT OLD.source_ref OR NEW.closed_at IS NOT OLD.closed_at))
BEGIN
  SELECT RAISE(ABORT, 'constraint: cash exposure proof is immutable');
END;
CREATE TRIGGER org_wallet_cash_exposures_no_delete BEFORE DELETE ON org_wallet_cash_exposures
BEGIN
  SELECT RAISE(ABORT, 'constraint: cash exposure proof is durable');
END;
CREATE TABLE org_wallet_usage_warnings (
  org_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  threshold_basis_points INTEGER NOT NULL CHECK (threshold_basis_points IN (8000, 9500)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'delivered')),
  claim_token TEXT,
  claim_until TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (org_id, period_start, period_end, threshold_basis_points),
  CHECK (period_start < period_end),
  CHECK ((claim_token IS NULL) = (claim_until IS NULL)),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK (state <> 'dispatching' OR claim_token IS NOT NULL),
  CHECK (state <> 'pending' OR claim_token IS NULL),
  CHECK (state <> 'delivered' OR claim_token IS NULL)
);
CREATE INDEX org_wallet_usage_warnings_dispatch
  ON org_wallet_usage_warnings (state, claim_until, created_at, org_id);
CREATE TRIGGER org_wallet_usage_warnings_immutable BEFORE UPDATE ON org_wallet_usage_warnings
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.period_start IS NOT OLD.period_start
  OR NEW.period_end IS NOT OLD.period_end OR NEW.threshold_basis_points IS NOT OLD.threshold_basis_points
  OR NEW.payload_json IS NOT OLD.payload_json OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.state = 'delivered' AND
      (NEW.state IS NOT OLD.state OR NEW.delivered_at IS NOT OLD.delivered_at))
BEGIN
  SELECT RAISE(ABORT, 'constraint: usage warning proof is immutable');
END;
CREATE TRIGGER org_wallet_usage_warnings_no_delete BEFORE DELETE ON org_wallet_usage_warnings
BEGIN
  SELECT RAISE(ABORT, 'constraint: usage warning proof is durable');
END;

-- This table is intentionally empty after migration. The authenticated
-- processor account, selected mode, and deployment billing authority may only
-- be bound by a separate explicit reviewed owner transition. Startup reads
-- the pin; it must never infer or automatically insert one from a key or data.
-- The schema retains both selected-mode values. The current Hosted bootstrap
-- and runtime qualification are TEST-only and also require the existing 0098
-- test pin. Populated financial history requires an owner-reviewed transition.
CREATE TABLE stripe_billing_account_realms (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  billing_authority TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(account_id) BETWEEN 6 AND 255 AND substr(account_id, 1, 5) = 'acct_'
         AND substr(account_id, 6) NOT GLOB '*[^A-Za-z0-9]*'),
  CHECK (length(billing_authority) BETWEEN 1 AND 256
         AND billing_authority GLOB '[A-Za-z0-9]*'
         AND billing_authority NOT GLOB '*[^A-Za-z0-9._:-]*'),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
         AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);
CREATE TRIGGER stripe_billing_account_realms_no_replace
BEFORE INSERT ON stripe_billing_account_realms
WHEN EXISTS (SELECT 1 FROM stripe_billing_account_realms)
BEGIN
  SELECT RAISE(ABORT, 'constraint: authenticated Stripe financial realm is immutable');
END;
CREATE TRIGGER stripe_billing_account_realms_no_update
BEFORE UPDATE ON stripe_billing_account_realms
BEGIN
  SELECT RAISE(ABORT, 'constraint: authenticated Stripe financial realm is immutable');
END;
CREATE TRIGGER stripe_billing_account_realms_no_delete
BEFORE DELETE ON stripe_billing_account_realms
BEGIN
  SELECT RAISE(ABORT, 'constraint: authenticated Stripe financial realm is immutable');
END;
