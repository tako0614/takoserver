-- Additive Organization off-session funding and card-setup custody.
-- The common authenticated financial owner verifies original native objects
-- and persists settlement, exposure, wallet lot and ledger effects atomically.
-- Card setup records identity history; merchant cash consent remains separate.
-- Guard triggers reject conflicting writes and preserve original receipts.
-- Existing applied migrations and legacy duplicate Charge history are retained.

CREATE UNIQUE INDEX stripe_on_demand_exposure_status_parent
  ON org_wallet_cash_exposures(org_id, ref, status);

CREATE TABLE stripe_billing_on_demand_commands (
  org_id TEXT NOT NULL CHECK(length(org_id) BETWEEN 1 AND 128),
  reference TEXT NOT NULL CHECK(length(reference) BETWEEN 1 AND 256),
  admission_json TEXT NOT NULL CHECK(json_valid(admission_json) AND json_type(admission_json)='object'
    AND json_extract(admission_json,'$.organizationId') IS org_id
    AND json_type(admission_json,'$.namespace') IS 'text' AND length(json_extract(admission_json,'$.namespace')) BETWEEN 1 AND 256
    AND json_type(admission_json,'$.reference') IS 'text' AND length(json_extract(admission_json,'$.reference')) BETWEEN 1 AND 256
    AND json_type(admission_json,'$.fingerprint') IS 'text' AND length(json_extract(admission_json,'$.fingerprint')) BETWEEN 1 AND 512),
  exposure_ref TEXT NOT NULL,
  funding_ref TEXT NOT NULL CHECK(length(funding_ref) BETWEEN 1 AND 256),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) BETWEEN 1 AND 512),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  billing_authority TEXT NOT NULL,
  customer_id TEXT NOT NULL CHECK(length(customer_id) BETWEEN 5 AND 255 AND substr(customer_id,1,4)='cus_'),
  payment_method_id TEXT NOT NULL CHECK(length(payment_method_id) BETWEEN 4 AND 255 AND substr(payment_method_id,1,3)='pm_'),
  setup_intent_id TEXT CHECK(setup_intent_id IS NULL OR (length(setup_intent_id) BETWEEN 6 AND 255 AND substr(setup_intent_id,1,5)='seti_')),
  authorized_principal TEXT NOT NULL CHECK(length(authorized_principal) BETWEEN 1 AND 512),
  consent_revision TEXT NOT NULL CHECK(length(consent_revision) BETWEEN 1 AND 256),
  terms_revision TEXT NOT NULL CHECK(length(terms_revision) BETWEEN 1 AND 256),
  terms_json TEXT NOT NULL CHECK(json_valid(terms_json) AND json_type(terms_json)='object'),
  consent_json TEXT NOT NULL CHECK(json_valid(consent_json) AND json_type(consent_json)='object'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
  policy_version INTEGER NOT NULL CHECK(typeof(policy_version)='integer' AND policy_version BETWEEN 1 AND 9007199254740991),
  cap_minor INTEGER NOT NULL CHECK(typeof(cap_minor)='integer' AND cap_minor BETWEEN 0 AND 9007199254740991),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 900719925474),
  credit_expiry_kind TEXT NOT NULL CHECK(credit_expiry_kind IN ('none','fixed-duration')),
  credit_expiry_seconds INTEGER,
  terms_expires_at TEXT NOT NULL,
  stripe_key TEXT NOT NULL UNIQUE CHECK(length(stripe_key) BETWEEN 1 AND 255),
  state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','paid','canceled','abandoned')),
  dispatched_at TEXT,
  payment_intent_id TEXT UNIQUE CHECK(payment_intent_id IS NULL OR (length(payment_intent_id) BETWEEN 4 AND 255 AND substr(payment_intent_id,1,3)='pi_')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,reference), UNIQUE(org_id,exposure_ref), UNIQUE(org_id,funding_ref),
  UNIQUE(org_id,reference,state), UNIQUE(org_id,reference,dispatched_at),
  FOREIGN KEY(org_id,exposure_ref) REFERENCES org_wallet_cash_exposures(org_id,ref),
  CHECK(amount_minor <= cap_minor),
  CHECK(strftime('%Y-%m-01T00:00:00.000Z',period_start) IS period_start),
  CHECK(strftime('%Y-%m-01T00:00:00.000Z',period_start,'+1 month') IS period_end),
  CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  CHECK(created_at >= period_start AND created_at < period_end),
  CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',terms_expires_at) IS terms_expires_at AND terms_expires_at > created_at),
  CHECK((credit_expiry_kind='none' AND credit_expiry_seconds IS NULL) OR
    (credit_expiry_kind='fixed-duration' AND typeof(credit_expiry_seconds)='integer'
     AND credit_expiry_seconds BETWEEN 1 AND 9007199254740
     AND credit_expiry_seconds <= (253402300799000-(unixepoch(created_at)*1000+CAST(substr(created_at,21,3) AS INTEGER)))/1000
     AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+'||credit_expiry_seconds||' seconds') IS NOT NULL)),
  CHECK((state IN ('prepared','abandoned') AND dispatched_at IS NULL AND payment_intent_id IS NULL) OR (state NOT IN ('prepared','abandoned') AND dispatched_at IS NOT NULL)),
  CHECK(dispatched_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ',dispatched_at) IS dispatched_at AND dispatched_at >= created_at)),
  CHECK(state NOT IN ('paid','canceled') OR payment_intent_id IS NOT NULL),
  CHECK(json_extract(request_json,'$.currency') IS 'usd'),
  CHECK(json_extract(request_json,'$.amount') IS amount_minor),
  CHECK(json_extract(request_json,'$.customer') IS customer_id),
  CHECK(json_extract(request_json,'$.payment_method') IS payment_method_id),
  CHECK(json_type(request_json,'$.off_session') IS 'true'),
  CHECK(json_type(request_json,'$.confirm') IS 'true')
);
CREATE TRIGGER stripe_billing_on_demand_commands_prepare BEFORE INSERT ON stripe_billing_on_demand_commands
WHEN NEW.state <> 'prepared'
 OR NOT EXISTS (SELECT 1 FROM stripe_billing_account_realms r JOIN stripe_mode_realm m ON m.singleton=r.singleton
                WHERE r.singleton=1 AND r.account_id=NEW.account_id AND r.mode=NEW.mode
                  AND r.billing_authority=NEW.billing_authority AND m.mode=NEW.mode)
 OR NOT EXISTS (SELECT 1 FROM stripe_billing_customers WHERE org_id=NEW.org_id AND customer_id=NEW.customer_id)
 OR NOT EXISTS (SELECT 1 FROM org_wallet_limit_policies WHERE org_id=NEW.org_id AND on_limit='on-demand'
                AND policy_version=NEW.policy_version AND consent_revision=NEW.consent_revision
                AND authorized_principal=NEW.authorized_principal AND cash_cap_minor=NEW.cap_minor)
 OR NOT EXISTS (SELECT 1 FROM org_wallet_cash_exposures WHERE org_id=NEW.org_id AND ref=NEW.exposure_ref
                AND period_start=NEW.period_start AND period_end=NEW.period_end
                AND policy_version=NEW.policy_version AND consent_revision=NEW.consent_revision
                AND amount_minor=NEW.amount_minor AND status='reserved' AND source_ref IS NULL
                AND created_at=NEW.created_at)
 OR EXISTS (SELECT 1 FROM org_wallet_cash_exposures WHERE org_id=NEW.org_id AND status='reserved' AND ref<>NEW.exposure_ref)
 OR COALESCE((SELECT SUM(amount_minor) FROM org_wallet_cash_exposures WHERE org_id=NEW.org_id
               AND period_start=NEW.period_start AND status IN ('reserved','paid')),0) > NEW.cap_minor
 OR EXISTS (SELECT 1 FROM stripe_billing_grants WHERE org_id=NEW.org_id AND funding_ref=NEW.funding_ref)
BEGIN SELECT RAISE(ABORT,'constraint: exact on-demand prepare realm/policy/cap reservation required');
END;
CREATE TRIGGER stripe_billing_on_demand_commands_no_replace BEFORE INSERT ON stripe_billing_on_demand_commands
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_commands WHERE (org_id=NEW.org_id AND reference=NEW.reference)
 OR (org_id=NEW.org_id AND exposure_ref=NEW.exposure_ref) OR (org_id=NEW.org_id AND funding_ref=NEW.funding_ref)
 OR stripe_key=NEW.stripe_key OR (NEW.payment_intent_id IS NOT NULL AND payment_intent_id=NEW.payment_intent_id))
BEGIN SELECT RAISE(ABORT,'constraint: on-demand command cannot be replaced');
END;
CREATE TRIGGER stripe_billing_on_demand_commands_no_delete BEFORE DELETE ON stripe_billing_on_demand_commands
BEGIN SELECT RAISE(ABORT,'constraint: on-demand command is durable');
END;

CREATE TRIGGER stripe_billing_on_demand_commands_immutable BEFORE UPDATE ON stripe_billing_on_demand_commands
WHEN NEW.org_id IS NOT OLD.org_id
 OR NEW.reference IS NOT OLD.reference
 OR NEW.admission_json IS NOT OLD.admission_json
 OR NEW.exposure_ref IS NOT OLD.exposure_ref
 OR NEW.funding_ref IS NOT OLD.funding_ref
 OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.account_id IS NOT OLD.account_id
 OR NEW.mode IS NOT OLD.mode
 OR NEW.billing_authority IS NOT OLD.billing_authority
 OR NEW.customer_id IS NOT OLD.customer_id
 OR NEW.payment_method_id IS NOT OLD.payment_method_id
 OR NEW.setup_intent_id IS NOT OLD.setup_intent_id
 OR NEW.authorized_principal IS NOT OLD.authorized_principal
 OR NEW.consent_revision IS NOT OLD.consent_revision
 OR NEW.terms_revision IS NOT OLD.terms_revision
 OR NEW.terms_json IS NOT OLD.terms_json
 OR NEW.consent_json IS NOT OLD.consent_json
 OR NEW.request_json IS NOT OLD.request_json
 OR NEW.policy_version IS NOT OLD.policy_version
 OR NEW.cap_minor IS NOT OLD.cap_minor
 OR NEW.period_start IS NOT OLD.period_start
 OR NEW.period_end IS NOT OLD.period_end
 OR NEW.amount_minor IS NOT OLD.amount_minor
 OR NEW.credit_expiry_kind IS NOT OLD.credit_expiry_kind
 OR NEW.credit_expiry_seconds IS NOT OLD.credit_expiry_seconds
 OR NEW.terms_expires_at IS NOT OLD.terms_expires_at
 OR NEW.stripe_key IS NOT OLD.stripe_key
 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
 OR (OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS NOT OLD.payment_intent_id)
 OR EXISTS (SELECT 1 FROM stripe_billing_on_demand_terminals t WHERE t.org_id=NEW.org_id AND t.reference=NEW.reference AND t.payment_intent_id IS NOT NEW.payment_intent_id)
 OR (OLD.state IN ('paid','canceled','abandoned') AND (NEW.state IS NOT OLD.state OR NEW.payment_intent_id IS NOT OLD.payment_intent_id))
 OR (OLD.state='dispatched' AND NEW.state='prepared')
 OR (NEW.state='abandoned' AND (OLD.state<>'prepared' OR NEW.dispatched_at IS NOT NULL OR NEW.payment_intent_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM stripe_billing_on_demand_attempts a WHERE a.org_id=NEW.org_id AND a.reference=NEW.reference)
      OR NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_abandonments a WHERE a.org_id=NEW.org_id AND a.reference=NEW.reference)))
 OR (NEW.state='dispatched' AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_attempts a
      WHERE a.org_id=NEW.org_id AND a.reference=NEW.reference AND a.kind='first-dispatch' AND a.created_at=NEW.dispatched_at))
 OR (NEW.state='paid' AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_funding f WHERE f.org_id=NEW.org_id AND f.reference=NEW.reference AND f.payment_intent_id=NEW.payment_intent_id))
 OR (NEW.state='canceled' AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_terminals t WHERE t.org_id=NEW.org_id AND t.reference=NEW.reference AND t.status='canceled' AND t.payment_intent_id=NEW.payment_intent_id))
BEGIN SELECT RAISE(ABORT,'constraint: original on-demand command/dispatch/terminal is immutable');
END;

CREATE TABLE stripe_billing_on_demand_attempts (
 org_id TEXT NOT NULL, reference TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
 kind TEXT NOT NULL CHECK(kind IN ('first-dispatch','unknown-ack','readback')),
 detail_json TEXT NOT NULL CHECK(json_valid(detail_json) AND json_type(detail_json)='object'),
 created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 first_dispatch_at TEXT,
 PRIMARY KEY(org_id,reference,sequence),
 CHECK((kind='first-dispatch' AND first_dispatch_at IS created_at) OR (kind<>'first-dispatch' AND first_dispatch_at IS NULL)),
 FOREIGN KEY(org_id,reference) REFERENCES stripe_billing_on_demand_commands(org_id,reference),
 FOREIGN KEY(org_id,reference,first_dispatch_at) REFERENCES stripe_billing_on_demand_commands(org_id,reference,dispatched_at) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX stripe_billing_on_demand_first_dispatch ON stripe_billing_on_demand_attempts(org_id,reference) WHERE kind='first-dispatch';
-- These closed refund-observation labels do not authenticate native Stripe data.
-- The common owner verifies the proof and atomically activates the original fence before append.
CREATE TRIGGER stripe_billing_on_demand_attempts_phase BEFORE INSERT ON stripe_billing_on_demand_attempts
WHEN NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_commands c WHERE c.org_id=NEW.org_id AND c.reference=NEW.reference
 AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_abandonments a WHERE a.org_id=c.org_id AND a.reference=c.reference)
 AND ((NEW.kind='first-dispatch' AND c.state='prepared' AND c.created_at<=NEW.created_at AND NEW.created_at<c.terms_expires_at)
   OR (NEW.kind<>'first-dispatch' AND c.state='dispatched' AND c.dispatched_at<=NEW.created_at)))
 AND NOT EXISTS (
  SELECT 1 FROM stripe_billing_on_demand_commands c
  JOIN stripe_billing_on_demand_funding f ON f.org_id=c.org_id AND f.reference=c.reference
  JOIN stripe_billing_on_demand_terminals t ON t.org_id=c.org_id AND t.reference=c.reference
  JOIN org_wallet_cash_exposures e ON e.org_id=c.org_id AND e.ref=c.exposure_ref
  JOIN stripe_billing_account_realms r ON r.singleton=1 AND r.account_id=c.account_id
    AND r.mode=c.mode AND r.billing_authority=c.billing_authority
  JOIN stripe_mode_realm m ON m.singleton=r.singleton AND m.mode=r.mode
  WHERE NEW.kind='readback' AND c.org_id=NEW.org_id AND c.reference=NEW.reference
    AND c.state='paid' AND c.dispatched_at<=NEW.created_at
    AND f.command_state='paid' AND f.cap_state='paid'
    AND f.funding_ref=c.funding_ref AND f.exposure_ref=c.exposure_ref
    AND f.payment_intent_id=c.payment_intent_id
    AND typeof(c.amount_minor)='integer' AND c.amount_minor BETWEEN 1 AND 900719925474
    AND f.amount_micros=c.amount_minor*10000
    AND t.status='succeeded' AND t.payment_intent_id=f.payment_intent_id AND t.charge_id=f.charge_id
    AND t.exposure_ref=c.exposure_ref AND t.account_id=c.account_id AND t.mode=c.mode
    AND (t.billing_authority=c.billing_authority AND t.customer_id=c.customer_id
    AND t.payment_method_id=c.payment_method_id AND t.currency='usd' AND t.amount_minor=c.amount_minor
    AND e.status='paid' AND e.source_ref=f.payment_intent_id AND e.amount_minor=c.amount_minor
    AND e.period_start=c.period_start AND e.period_end=c.period_end
    AND e.policy_version=c.policy_version AND e.consent_revision=c.consent_revision
    AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_abandonments a WHERE a.org_id=c.org_id AND a.reference=c.reference)
    AND EXISTS (SELECT 1 FROM stripe_billing_fences fence
      WHERE fence.org_id=c.org_id AND fence.funding_ref=f.funding_ref AND fence.active=1
        AND typeof(fence.generation)='integer' AND fence.generation BETWEEN 1 AND 9007199254740991
      )
    AND json_type(NEW.detail_json,'$.kind') IS 'text'
    AND json_extract(NEW.detail_json,'$.kind') IS 'native-refund-observation-v1'
    AND json_type(NEW.detail_json,'$.proof') IS 'object'
    AND (SELECT count(*) FROM json_each(NEW.detail_json))=2
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.detail_json) WHERE key NOT IN ('kind','proof')))
    AND ((SELECT count(*) FROM json_each(NEW.detail_json,'$.proof'))=18
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.detail_json,'$.proof')
      WHERE key NOT IN ('kind','sourceType','organizationId','reference','fingerprint','fundingRef','accountId','mode','financialRealm','billingAuthority','customerId','paymentMethodId','paymentIntentId','chargeId','currency','amountMinor','refundedAmountMinor','observedAt')
        OR (key NOT IN ('amountMinor','refundedAmountMinor') AND type<>'text'))
    AND json_extract(NEW.detail_json,'$.proof.kind') IS 'stripe-on-demand-funding'
    AND json_extract(NEW.detail_json,'$.proof.sourceType') IS 'payment-intent'
    AND json_extract(NEW.detail_json,'$.proof.organizationId') IS c.org_id
    AND json_extract(NEW.detail_json,'$.proof.reference') IS c.reference
    AND json_extract(NEW.detail_json,'$.proof.fingerprint') IS c.fingerprint
    AND json_extract(NEW.detail_json,'$.proof.fundingRef') IS c.funding_ref
    AND json_extract(NEW.detail_json,'$.proof.accountId') IS c.account_id
    AND json_extract(NEW.detail_json,'$.proof.mode') IS 'test' AND c.mode='test'
    AND json_extract(NEW.detail_json,'$.proof.billingAuthority') IS c.billing_authority
    AND json_extract(NEW.detail_json,'$.proof.customerId') IS c.customer_id
    AND json_extract(NEW.detail_json,'$.proof.paymentMethodId') IS c.payment_method_id
    AND json_extract(NEW.detail_json,'$.proof.paymentIntentId') IS f.payment_intent_id
    AND json_extract(NEW.detail_json,'$.proof.chargeId') IS f.charge_id
    AND json_extract(NEW.detail_json,'$.proof.currency') IS 'USD'
    AND json_type(NEW.detail_json,'$.proof.amountMinor') IS 'integer'
    AND json_extract(NEW.detail_json,'$.proof.amountMinor') IS c.amount_minor)
    AND (json_type(NEW.detail_json,'$.proof.refundedAmountMinor') IS 'integer'
    AND json_extract(NEW.detail_json,'$.proof.refundedAmountMinor') BETWEEN 0 AND c.amount_minor
    AND json_type(NEW.detail_json,'$.proof.observedAt') IS 'text'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.detail_json,'$.proof.observedAt')) IS json_extract(NEW.detail_json,'$.proof.observedAt')
    AND json_extract(NEW.detail_json,'$.proof.observedAt')>=c.dispatched_at
    AND json_extract(NEW.detail_json,'$.proof.observedAt')<=NEW.created_at
    AND json_type(c.request_json,'$.metadata') IS 'object'
    AND json_extract(c.request_json,'$.currency') IS 'usd'
    AND json_extract(c.request_json,'$.metadata.organizationId') IS c.org_id
    AND json_extract(c.request_json,'$.metadata.reference') IS c.reference
    AND json_extract(c.request_json,'$.metadata.fingerprint') IS c.fingerprint
    AND json_extract(c.request_json,'$.metadata.fundingRef') IS c.funding_ref
    AND json_extract(c.request_json,'$.metadata.stripeAccountId') IS c.account_id
    AND json_extract(c.request_json,'$.metadata.billingAuthority') IS c.billing_authority
    AND json_type(c.request_json,'$.metadata.financialRealm') IS 'text'
    AND length(json_extract(c.request_json,'$.metadata.financialRealm'))=70
    AND substr(json_extract(c.request_json,'$.metadata.financialRealm'),1,6)='realm:'
    AND substr(json_extract(c.request_json,'$.metadata.financialRealm'),7) NOT GLOB '*[^a-f0-9]*'
    AND json_extract(NEW.detail_json,'$.proof.financialRealm') IS json_extract(c.request_json,'$.metadata.financialRealm'))
 )
BEGIN SELECT RAISE(ABORT,'constraint: exact durable dispatch or unresolved readback phase required');
END;

CREATE TRIGGER stripe_billing_on_demand_attempts_no_replace BEFORE INSERT ON stripe_billing_on_demand_attempts
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_attempts WHERE (org_id IS NEW.org_id AND reference IS NEW.reference AND sequence IS NEW.sequence))
BEGIN SELECT RAISE(ABORT, 'constraint: durable on-demand identity cannot be replaced');
END;

CREATE TRIGGER stripe_billing_on_demand_attempts_no_update BEFORE UPDATE ON stripe_billing_on_demand_attempts
BEGIN SELECT RAISE(ABORT, 'constraint: on-demand receipt is immutable');
END;

CREATE TRIGGER stripe_billing_on_demand_attempts_no_delete BEFORE DELETE ON stripe_billing_on_demand_attempts
BEGIN SELECT RAISE(ABORT, 'constraint: on-demand receipt is immutable');
END;

-- Native labels/data here never authenticate a provider response by themselves.
CREATE TABLE stripe_billing_on_demand_terminals (
 org_id TEXT NOT NULL, reference TEXT NOT NULL,
 payment_intent_id TEXT NOT NULL UNIQUE CHECK(length(payment_intent_id) BETWEEN 4 AND 255 AND substr(payment_intent_id,1,3)='pi_'),
 charge_id TEXT UNIQUE CHECK(charge_id IS NULL OR (length(charge_id) BETWEEN 4 AND 255 AND substr(charge_id,1,3)='ch_')),
 status TEXT NOT NULL CHECK(status IN ('succeeded','canceled')),
 account_id TEXT NOT NULL, mode TEXT NOT NULL, billing_authority TEXT NOT NULL,
 customer_id TEXT NOT NULL, payment_method_id TEXT NOT NULL,
 currency TEXT NOT NULL CHECK(currency='usd'),
 amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 900719925474),
 native_receipt_json TEXT NOT NULL CHECK(json_valid(native_receipt_json) AND json_type(native_receipt_json)='object'),
 observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
 exposure_ref TEXT NOT NULL,
 cap_terminal_state TEXT, command_terminal_state TEXT,
 PRIMARY KEY(org_id,reference),
 FOREIGN KEY(org_id,reference) REFERENCES stripe_billing_on_demand_commands(org_id,reference),
 FOREIGN KEY(org_id,exposure_ref,cap_terminal_state) REFERENCES org_wallet_cash_exposures(org_id,ref,status) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(org_id,reference,command_terminal_state) REFERENCES stripe_billing_on_demand_commands(org_id,reference,state) DEFERRABLE INITIALLY DEFERRED,
 CHECK((status='succeeded' AND charge_id IS NOT NULL AND cap_terminal_state IS NULL AND command_terminal_state IS NULL)
    OR (status='canceled' AND charge_id IS NULL AND cap_terminal_state IS 'released' AND command_terminal_state IS 'canceled'))
);
CREATE TRIGGER stripe_billing_on_demand_terminals_original BEFORE INSERT ON stripe_billing_on_demand_terminals
WHEN NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_commands c JOIN org_wallet_cash_exposures e ON e.org_id=c.org_id AND e.ref=c.exposure_ref
 WHERE c.org_id=NEW.org_id AND c.reference=NEW.reference AND c.state='dispatched'
 AND (c.payment_intent_id IS NULL OR c.payment_intent_id=NEW.payment_intent_id)
 AND c.exposure_ref=NEW.exposure_ref AND c.account_id=NEW.account_id AND c.mode=NEW.mode
 AND c.billing_authority=NEW.billing_authority AND c.customer_id=NEW.customer_id
 AND c.payment_method_id=NEW.payment_method_id AND c.amount_minor=NEW.amount_minor
 AND c.dispatched_at<=NEW.observed_at AND e.status='reserved'
 AND e.period_start=c.period_start AND e.period_end=c.period_end AND e.amount_minor=c.amount_minor
 AND e.policy_version=c.policy_version AND e.consent_revision=c.consent_revision)
 OR (NEW.status='succeeded' AND EXISTS (SELECT 1 FROM stripe_billing_grants WHERE charge_id=NEW.charge_id))
BEGIN SELECT RAISE(ABORT,'constraint: original on-demand terminal/Charge conflicts');
END;

CREATE TRIGGER stripe_billing_on_demand_terminals_no_replace BEFORE INSERT ON stripe_billing_on_demand_terminals
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_terminals WHERE (org_id IS NEW.org_id AND reference IS NEW.reference) OR (payment_intent_id IS NEW.payment_intent_id) OR (NEW.charge_id IS NOT NULL AND charge_id IS NEW.charge_id))
BEGIN SELECT RAISE(ABORT, 'constraint: durable on-demand identity cannot be replaced');
END;

CREATE TRIGGER stripe_billing_on_demand_terminals_no_update BEFORE UPDATE ON stripe_billing_on_demand_terminals
BEGIN SELECT RAISE(ABORT, 'constraint: on-demand receipt is immutable');
END;

CREATE TRIGGER stripe_billing_on_demand_terminals_no_delete BEFORE DELETE ON stripe_billing_on_demand_terminals
BEGIN SELECT RAISE(ABORT, 'constraint: on-demand receipt is immutable');
END;

CREATE TABLE stripe_billing_on_demand_funding (
 org_id TEXT NOT NULL, reference TEXT NOT NULL,
 funding_ref TEXT NOT NULL, exposure_ref TEXT NOT NULL,
 payment_intent_id TEXT NOT NULL UNIQUE,
 charge_id TEXT NOT NULL UNIQUE CHECK(length(charge_id) BETWEEN 4 AND 255 AND substr(charge_id,1,3)='ch_'),
 amount_micros INTEGER NOT NULL CHECK(typeof(amount_micros)='integer' AND amount_micros BETWEEN 10000 AND 9007199254740000 AND amount_micros%10000=0),
 expires_at TEXT,
 created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 cap_state TEXT NOT NULL CHECK(cap_state='paid'),
 command_state TEXT NOT NULL CHECK(command_state='paid'),
 PRIMARY KEY(org_id,reference), UNIQUE(org_id,funding_ref),
 FOREIGN KEY(org_id,reference) REFERENCES stripe_billing_on_demand_terminals(org_id,reference),
 FOREIGN KEY(org_id,funding_ref) REFERENCES wallet_credit_lots(org_id,ref),
 FOREIGN KEY(org_id,exposure_ref,cap_state) REFERENCES org_wallet_cash_exposures(org_id,ref,status) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(org_id,reference,command_state) REFERENCES stripe_billing_on_demand_commands(org_id,reference,state) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER stripe_billing_on_demand_funding_original BEFORE INSERT ON stripe_billing_on_demand_funding
WHEN NOT EXISTS (
 SELECT 1 FROM stripe_billing_on_demand_commands c
 JOIN stripe_billing_on_demand_terminals t ON t.org_id=c.org_id AND t.reference=c.reference
 JOIN org_wallet_cash_exposures e ON e.org_id=c.org_id AND e.ref=c.exposure_ref
 JOIN wallet_credit_lots l ON l.org_id=c.org_id AND l.ref=c.funding_ref
 JOIN ledger d ON d.org_id=l.org_id AND d.ref=l.ref AND d.type='funding'
 WHERE c.org_id=NEW.org_id AND c.reference=NEW.reference AND c.state='dispatched'
 AND t.status='succeeded' AND t.payment_intent_id=NEW.payment_intent_id AND t.charge_id=NEW.charge_id
 AND c.funding_ref=NEW.funding_ref AND c.exposure_ref=NEW.exposure_ref
 AND c.amount_minor*10000=NEW.amount_micros AND NEW.created_at>=t.observed_at
 AND ((c.credit_expiry_kind='none' AND NEW.expires_at IS NULL) OR
      (c.credit_expiry_kind='fixed-duration'
       AND unixepoch(NEW.created_at)*1000+CAST(substr(NEW.created_at,21,3) AS INTEGER) <= 253402300799000-c.credit_expiry_seconds*1000
       AND strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+'||c.credit_expiry_seconds||' seconds') IS NOT NULL
       AND NEW.expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+'||c.credit_expiry_seconds||' seconds')
       AND NEW.expires_at>NEW.created_at))
 AND e.status='reserved' AND e.amount_minor=c.amount_minor AND e.period_start=c.period_start AND e.period_end=c.period_end
 AND e.policy_version=c.policy_version AND e.consent_revision=c.consent_revision
 AND l.kind='purchased' AND l.consumption_class='purchased' AND typeof(l.amount_micros)='integer'
 AND l.amount_micros=NEW.amount_micros AND l.expires_at IS NEW.expires_at AND l.created_at=NEW.created_at
 AND typeof(d.settled_delta_micros)='integer' AND d.settled_delta_micros=NEW.amount_micros
 AND typeof(d.held_delta_micros)='integer' AND d.held_delta_micros=0 AND d.created_at=NEW.created_at)
 OR EXISTS (SELECT 1 FROM stripe_billing_grants WHERE charge_id=NEW.charge_id OR (org_id=NEW.org_id AND funding_ref=NEW.funding_ref))
BEGIN SELECT RAISE(ABORT,'constraint: on-demand funding requires exact original source/lot/ledger/cap');
END;

CREATE TRIGGER stripe_billing_on_demand_funding_no_replace BEFORE INSERT ON stripe_billing_on_demand_funding
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_funding WHERE (org_id IS NEW.org_id AND reference IS NEW.reference) OR (org_id IS NEW.org_id AND funding_ref IS NEW.funding_ref) OR (payment_intent_id IS NEW.payment_intent_id) OR (NEW.charge_id IS NOT NULL AND charge_id IS NEW.charge_id))
BEGIN SELECT RAISE(ABORT, 'constraint: durable on-demand identity cannot be replaced');
END;

CREATE TRIGGER stripe_billing_on_demand_funding_no_update BEFORE UPDATE ON stripe_billing_on_demand_funding
BEGIN SELECT RAISE(ABORT, 'constraint: on-demand receipt is immutable');
END;

CREATE TRIGGER stripe_billing_on_demand_funding_no_delete BEFORE DELETE ON stripe_billing_on_demand_funding
BEGIN SELECT RAISE(ABORT, 'constraint: on-demand receipt is immutable');
END;

CREATE TRIGGER stripe_billing_on_demand_exposure_terminal BEFORE UPDATE OF status,source_ref,closed_at ON org_wallet_cash_exposures
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_commands WHERE org_id=OLD.org_id AND exposure_ref=OLD.ref)
 AND ((NEW.status='paid' AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_funding f
       WHERE f.org_id=NEW.org_id AND f.exposure_ref=NEW.ref AND f.payment_intent_id=NEW.source_ref AND f.created_at=NEW.closed_at))
   OR (NEW.status='released' AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_terminals t
       WHERE t.org_id=NEW.org_id AND t.exposure_ref=NEW.ref AND t.status='canceled'
       AND t.payment_intent_id=NEW.source_ref AND t.observed_at=NEW.closed_at)
       AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_abandonments a
       WHERE a.org_id=NEW.org_id AND a.exposure_ref=NEW.ref AND NEW.source_ref IS NULL AND a.abandoned_at=NEW.closed_at)))
BEGIN SELECT RAISE(ABORT,'constraint: original native terminal is required to close on-demand cap');
END;

-- Cross-source exclusion affects only new colliding writes. Historical
-- multiple old grants for one Charge remain untouched and readable.
CREATE TRIGGER stripe_billing_grants_on_demand_charge_insert BEFORE INSERT ON stripe_billing_grants
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_terminals WHERE status='succeeded' AND charge_id=NEW.charge_id)
 OR EXISTS (SELECT 1 FROM stripe_billing_on_demand_funding WHERE charge_id=NEW.charge_id OR (org_id=NEW.org_id AND funding_ref=NEW.funding_ref))
BEGIN SELECT RAISE(ABORT,'constraint: Charge already claimed by original on-demand source');
END;
CREATE TRIGGER stripe_billing_grants_on_demand_charge_update BEFORE UPDATE OF charge_id,org_id,funding_ref ON stripe_billing_grants
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_terminals WHERE status='succeeded' AND charge_id=NEW.charge_id)
 OR EXISTS (SELECT 1 FROM stripe_billing_on_demand_funding WHERE charge_id=NEW.charge_id OR (org_id=NEW.org_id AND funding_ref=NEW.funding_ref))
BEGIN SELECT RAISE(ABORT,'constraint: old grant cannot mutate into on-demand ownership');
END;

-- Separate FK because original 0095 refund FK only accepts old grant sources.
-- This is a source/refund receipt, never a second wallet or ledger.
CREATE TABLE stripe_billing_on_demand_refunds (
 refund_id TEXT PRIMARY KEY NOT NULL CHECK(length(refund_id) BETWEEN 4 AND 255 AND substr(refund_id,1,3)='re_'),
 org_id TEXT NOT NULL, funding_ref TEXT NOT NULL,
 amount_micros INTEGER NOT NULL CHECK(typeof(amount_micros)='integer' AND amount_micros BETWEEN 10000 AND 9007199254740000 AND amount_micros%10000=0),
 cumulative_refunded_micros INTEGER NOT NULL CHECK(typeof(cumulative_refunded_micros)='integer' AND cumulative_refunded_micros BETWEEN 10000 AND 9007199254740000 AND cumulative_refunded_micros%10000=0),
 target_revoked_micros INTEGER NOT NULL CHECK(typeof(target_revoked_micros)='integer' AND target_revoked_micros BETWEEN 10000 AND 9007199254740000),
 debit_micros INTEGER NOT NULL CHECK(typeof(debit_micros)='integer' AND debit_micros BETWEEN 0 AND 9007199254740991),
 receivable_micros INTEGER NOT NULL CHECK(typeof(receivable_micros)='integer' AND receivable_micros BETWEEN 0 AND 9007199254740991),
 expired_micros INTEGER NOT NULL CHECK(typeof(expired_micros)='integer' AND expired_micros BETWEEN 0 AND 9007199254740991),
 fence_generation INTEGER NOT NULL CHECK(typeof(fence_generation)='integer' AND fence_generation BETWEEN 1 AND 9007199254740991),
 native_receipt_json TEXT NOT NULL CHECK(json_valid(native_receipt_json) AND json_type(native_receipt_json)='object'),
 created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 FOREIGN KEY(org_id,funding_ref) REFERENCES stripe_billing_on_demand_funding(org_id,funding_ref),
 CHECK(target_revoked_micros=cumulative_refunded_micros)
);
CREATE INDEX stripe_billing_on_demand_refunds_lot ON stripe_billing_on_demand_refunds(org_id,funding_ref,cumulative_refunded_micros);
CREATE TRIGGER stripe_billing_on_demand_refunds_original BEFORE INSERT ON stripe_billing_on_demand_refunds
WHEN EXISTS (SELECT 1 FROM stripe_billing_refunds WHERE refund_id=NEW.refund_id)
 OR NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_funding f JOIN stripe_billing_fences x ON x.org_id=f.org_id AND x.funding_ref=f.funding_ref
 WHERE f.org_id=NEW.org_id AND f.funding_ref=NEW.funding_ref AND x.active=1 AND x.generation=NEW.fence_generation
 AND NEW.cumulative_refunded_micros<=f.amount_micros
 AND NEW.amount_micros=NEW.cumulative_refunded_micros-COALESCE((SELECT SUM(r.amount_micros) FROM stripe_billing_on_demand_refunds r WHERE r.org_id=f.org_id AND r.funding_ref=f.funding_ref),0)
 AND NEW.debit_micros<=NEW.amount_micros AND NEW.receivable_micros<=NEW.amount_micros-NEW.debit_micros
 AND NEW.expired_micros=NEW.amount_micros-NEW.debit_micros-NEW.receivable_micros)
BEGIN SELECT RAISE(ABORT,'constraint: original on-demand refund/freeze/cumulative allocation required');
END;

CREATE TRIGGER stripe_billing_on_demand_refunds_no_replace BEFORE INSERT ON stripe_billing_on_demand_refunds
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_refunds WHERE (refund_id IS NEW.refund_id))
BEGIN SELECT RAISE(ABORT, 'constraint: durable on-demand identity cannot be replaced');
END;

CREATE TRIGGER stripe_billing_on_demand_refunds_no_update BEFORE UPDATE ON stripe_billing_on_demand_refunds
BEGIN SELECT RAISE(ABORT, 'constraint: on-demand receipt is immutable');
END;

CREATE TRIGGER stripe_billing_on_demand_refunds_no_delete BEFORE DELETE ON stripe_billing_on_demand_refunds
BEGIN SELECT RAISE(ABORT, 'constraint: on-demand receipt is immutable');
END;

CREATE TRIGGER stripe_billing_refunds_on_demand_identity BEFORE INSERT ON stripe_billing_refunds
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_refunds WHERE refund_id=NEW.refund_id)
BEGIN SELECT RAISE(ABORT,'constraint: refund already belongs to on-demand source');
END;

-- Future common owner may use these explicit UNION ALL projections. Existing
-- c84 callers do not read them and cannot safely serve new source funding yet.
CREATE VIEW stripe_billing_funding_sources_all AS
 SELECT org_id,funding_ref,source_type,source_id,charge_id FROM stripe_billing_grants
 UNION ALL SELECT org_id,funding_ref,'payment-intent',payment_intent_id,charge_id FROM stripe_billing_on_demand_funding;
CREATE VIEW stripe_billing_refund_receipts_all AS
 SELECT refund_id,org_id,funding_ref,amount_micros,cumulative_refunded_micros,target_revoked_micros,debit_micros,receivable_micros,expired_micros,created_at FROM stripe_billing_refunds
 UNION ALL SELECT refund_id,org_id,funding_ref,amount_micros,cumulative_refunded_micros,target_revoked_micros,debit_micros,receivable_micros,expired_micros,created_at FROM stripe_billing_on_demand_refunds;

-- First-pin ownership crosses both representations. An own terminal-first
-- readback is valid; a different Org OR a different reference is not its owner.
CREATE TRIGGER stripe_billing_on_demand_commands_global_intent
BEFORE UPDATE OF payment_intent_id ON stripe_billing_on_demand_commands
WHEN NEW.payment_intent_id IS NOT NULL AND EXISTS (
 SELECT 1 FROM stripe_billing_on_demand_terminals t
 WHERE t.payment_intent_id=NEW.payment_intent_id
 AND (t.org_id IS NOT NEW.org_id OR t.reference IS NOT NEW.reference))
BEGIN SELECT RAISE(ABORT,'constraint: PaymentIntent belongs to another original terminal');
END;
CREATE TRIGGER stripe_billing_on_demand_terminals_global_intent
BEFORE INSERT ON stripe_billing_on_demand_terminals
WHEN EXISTS (
 SELECT 1 FROM stripe_billing_on_demand_commands c
 WHERE c.payment_intent_id=NEW.payment_intent_id
 AND (c.org_id IS NOT NEW.org_id OR c.reference IS NOT NEW.reference))
BEGIN SELECT RAISE(ABORT,'constraint: PaymentIntent belongs to another original command');
END;

-- Explicit local no-effect decision for a command that has NEVER dispatched.
-- This is sound only if every native POST is preceded by this same DB's durable
-- first-dispatch protocol. SQL labels/JSON do not authenticate external absence.
CREATE TABLE stripe_billing_on_demand_abandonments (
 org_id TEXT NOT NULL, reference TEXT NOT NULL, exposure_ref TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('expired','consent-withdrawn','not-needed','admission-accepted')),
 observed_policy_version INTEGER,
 decision_context_json TEXT NOT NULL CHECK(json_valid(decision_context_json) AND json_type(decision_context_json)='object'
   AND json_extract(decision_context_json,'$.organizationId') IS org_id
   AND json_extract(decision_context_json,'$.reference') IS reference
   AND json_extract(decision_context_json,'$.decision') IS reason),
 abandoned_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',abandoned_at) IS abandoned_at),
 cap_state TEXT NOT NULL CHECK(cap_state='released'), command_state TEXT NOT NULL CHECK(command_state='abandoned'),
 PRIMARY KEY(org_id,reference), UNIQUE(org_id,exposure_ref),
 CHECK((reason='consent-withdrawn' AND typeof(observed_policy_version)='integer' AND observed_policy_version BETWEEN 1 AND 9007199254740991)
       OR (reason<>'consent-withdrawn' AND observed_policy_version IS NULL)),
 FOREIGN KEY(org_id,reference) REFERENCES stripe_billing_on_demand_commands(org_id,reference),
 FOREIGN KEY(org_id,exposure_ref,cap_state) REFERENCES org_wallet_cash_exposures(org_id,ref,status) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(org_id,reference,command_state) REFERENCES stripe_billing_on_demand_commands(org_id,reference,state) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER stripe_billing_on_demand_abandonments_original BEFORE INSERT ON stripe_billing_on_demand_abandonments
WHEN NOT EXISTS (
 SELECT 1 FROM stripe_billing_on_demand_commands c JOIN org_wallet_cash_exposures e ON e.org_id=c.org_id AND e.ref=c.exposure_ref
 WHERE c.org_id=NEW.org_id AND c.reference=NEW.reference AND c.exposure_ref=NEW.exposure_ref
 AND c.state='prepared' AND c.dispatched_at IS NULL AND c.payment_intent_id IS NULL AND NEW.abandoned_at>=c.created_at
 AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_attempts a WHERE a.org_id=c.org_id AND a.reference=c.reference)
 AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_terminals t WHERE t.org_id=c.org_id AND t.reference=c.reference)
 AND e.status='reserved' AND e.source_ref IS NULL AND e.amount_minor=c.amount_minor
 AND e.period_start=c.period_start AND e.period_end=c.period_end AND e.policy_version=c.policy_version AND e.consent_revision=c.consent_revision
 AND json_extract(NEW.decision_context_json,'$.admissionRef') IS json_extract(c.admission_json,'$.reference')
 AND json_extract(NEW.decision_context_json,'$.admissionNamespace') IS json_extract(c.admission_json,'$.namespace')
 AND json_extract(NEW.decision_context_json,'$.admissionFingerprint') IS json_extract(c.admission_json,'$.fingerprint')
 AND ((NEW.reason='expired' AND NEW.abandoned_at>=c.terms_expires_at)
   OR (NEW.reason='consent-withdrawn' AND EXISTS (SELECT 1 FROM org_wallet_limit_policies p WHERE p.org_id=c.org_id
       AND p.policy_version=NEW.observed_policy_version
       AND (p.on_limit<>'on-demand' OR p.consent_revision IS NOT c.consent_revision OR p.policy_version<>c.policy_version)))
   OR NEW.reason IN ('not-needed','admission-accepted')))
BEGIN SELECT RAISE(ABORT,'constraint: only exact never-dispatched original command can be abandoned');
END;
CREATE TRIGGER stripe_billing_on_demand_abandonments_no_replace BEFORE INSERT ON stripe_billing_on_demand_abandonments
WHEN EXISTS (SELECT 1 FROM stripe_billing_on_demand_abandonments WHERE org_id=NEW.org_id AND (reference=NEW.reference OR exposure_ref=NEW.exposure_ref))
BEGIN SELECT RAISE(ABORT,'constraint: abandonment receipt is durable');
END;
CREATE TRIGGER stripe_billing_on_demand_abandonments_no_update BEFORE UPDATE ON stripe_billing_on_demand_abandonments
BEGIN SELECT RAISE(ABORT,'constraint: abandonment receipt is immutable');
END;
CREATE TRIGGER stripe_billing_on_demand_abandonments_no_delete BEFORE DELETE ON stripe_billing_on_demand_abandonments
BEGIN SELECT RAISE(ABORT,'constraint: abandonment receipt is durable');
END;

-- Card setup commands and sanitized original outcome history.

CREATE TABLE stripe_billing_card_setup_commands (
 org_id TEXT NOT NULL CHECK(length(org_id) BETWEEN 1 AND 128),
 reference TEXT NOT NULL CHECK(length(reference) BETWEEN 1 AND 256),
 authorized_principal TEXT NOT NULL CHECK(length(authorized_principal) BETWEEN 1 AND 512),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint) BETWEEN 1 AND 512),
 disclosure_revision TEXT NOT NULL CHECK(length(disclosure_revision) BETWEEN 1 AND 256),
 account_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 financial_realm TEXT NOT NULL CHECK(length(financial_realm)=70 AND substr(financial_realm,1,6)='realm:' AND substr(financial_realm,7) NOT GLOB '*[^a-f0-9]*'),
 billing_authority TEXT NOT NULL,
 flow_kind TEXT NOT NULL CHECK(flow_kind='checkout-setup'),
 success_return_url TEXT NOT NULL CHECK(length(success_return_url) BETWEEN 1 AND 2048),
 cancel_return_url TEXT NOT NULL CHECK(length(cancel_return_url) BETWEEN 1 AND 2048),
 request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'
   AND json_extract(request_json,'$.mode') IS 'setup'
   AND json_extract(request_json,'$.success_url') IS success_return_url
   AND json_extract(request_json,'$.cancel_url') IS cancel_return_url
   AND json_type(request_json,'$.payment_method_types') IS 'array'
   AND json_array_length(request_json,'$.payment_method_types')=1
   AND json_extract(request_json,'$.payment_method_types[0]') IS 'card'
   AND json_type(request_json,'$.metadata') IS 'object'
   AND json_extract(request_json,'$.metadata.organizationId') IS org_id
   AND json_extract(request_json,'$.metadata.reference') IS reference
   AND json_extract(request_json,'$.metadata.fingerprint') IS fingerprint
   AND json_extract(request_json,'$.metadata.setupDisclosureRevision') IS disclosure_revision
   AND json_extract(request_json,'$.metadata.stripeAccountId') IS account_id
   AND json_extract(request_json,'$.metadata.financialRealm') IS financial_realm
   AND json_extract(request_json,'$.metadata.billingAuthority') IS billing_authority
   AND json_type(request_json,'$.setup_intent_data') IS 'object'
   AND json_type(request_json,'$.setup_intent_data.metadata') IS 'object'
   AND json_extract(request_json,'$.setup_intent_data.metadata.organizationId') IS json_extract(request_json,'$.metadata.organizationId')
   AND json_extract(request_json,'$.setup_intent_data.metadata.reference') IS json_extract(request_json,'$.metadata.reference')
   AND json_extract(request_json,'$.setup_intent_data.metadata.fingerprint') IS json_extract(request_json,'$.metadata.fingerprint')
   AND json_extract(request_json,'$.setup_intent_data.metadata.setupDisclosureRevision') IS json_extract(request_json,'$.metadata.setupDisclosureRevision')
   AND json_extract(request_json,'$.setup_intent_data.metadata.stripeAccountId') IS json_extract(request_json,'$.metadata.stripeAccountId')
   AND json_extract(request_json,'$.setup_intent_data.metadata.financialRealm') IS json_extract(request_json,'$.metadata.financialRealm')
   AND json_extract(request_json,'$.setup_intent_data.metadata.billingAuthority') IS json_extract(request_json,'$.metadata.billingAuthority')),
 stripe_key TEXT NOT NULL UNIQUE CHECK(length(stripe_key) BETWEEN 1 AND 255),
 created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
 customer_id TEXT CHECK(customer_id IS NULL OR (length(customer_id) BETWEEN 5 AND 255 AND substr(customer_id,1,4)='cus_')),
 state TEXT NOT NULL CHECK(state IN ('awaiting-customer','prepared','dispatched','original-known','verified','abandoned')),
 dispatch_nonce TEXT UNIQUE CHECK(dispatch_nonce IS NULL OR length(dispatch_nonce) BETWEEN 16 AND 128),
 dispatched_at TEXT CHECK(dispatched_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ',dispatched_at) IS dispatched_at AND dispatched_at>=created_at)),
 session_id TEXT UNIQUE CHECK(session_id IS NULL OR (length(session_id) BETWEEN 4 AND 255 AND substr(session_id,1,3)='cs_')),
 setup_intent_id TEXT UNIQUE CHECK(setup_intent_id IS NULL OR (length(setup_intent_id) BETWEEN 6 AND 255 AND substr(setup_intent_id,1,5)='seti_')),
 result_sequence INTEGER CHECK(result_sequence IS NULL OR (typeof(result_sequence)='integer' AND result_sequence BETWEEN 1 AND 9007199254740991)),
 native_outcome TEXT CHECK(native_outcome IS NULL OR native_outcome IN ('succeeded','canceled')),
 terminal_at TEXT CHECK(terminal_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ',terminal_at) IS terminal_at AND terminal_at>=created_at)),
 PRIMARY KEY(org_id,reference), UNIQUE(org_id,reference,state), UNIQUE(org_id,reference,session_id,setup_intent_id),
 FOREIGN KEY(org_id,reference,result_sequence) REFERENCES stripe_billing_card_setup_results(org_id,reference,sequence) DEFERRABLE INITIALLY DEFERRED,
 CHECK((state='awaiting-customer' AND customer_id IS NULL) OR (state NOT IN ('awaiting-customer','abandoned') AND customer_id IS NOT NULL) OR state='abandoned'),
 CHECK((state IN ('awaiting-customer','prepared','abandoned') AND dispatch_nonce IS NULL AND dispatched_at IS NULL AND session_id IS NULL AND setup_intent_id IS NULL)
    OR (state IN ('dispatched','original-known','verified') AND dispatch_nonce IS NOT NULL AND dispatched_at IS NOT NULL)),
 CHECK(state<>'dispatched' OR (session_id IS NULL AND setup_intent_id IS NULL)),
 CHECK(state<>'original-known' OR session_id IS NOT NULL OR setup_intent_id IS NOT NULL),
 CHECK((state='verified' AND session_id IS NOT NULL AND setup_intent_id IS NOT NULL AND result_sequence IS NOT NULL AND native_outcome IS NOT NULL AND terminal_at IS NOT NULL)
    OR (state='abandoned' AND result_sequence IS NOT NULL AND native_outcome IS NULL AND terminal_at IS NOT NULL)
    OR (state NOT IN ('verified','abandoned') AND result_sequence IS NULL AND native_outcome IS NULL AND terminal_at IS NULL))
);
CREATE TRIGGER stripe_billing_card_setup_commands_insert BEFORE INSERT ON stripe_billing_card_setup_commands
WHEN NEW.state<>'awaiting-customer'
 OR NOT EXISTS (SELECT 1 FROM stripe_billing_account_realms r JOIN stripe_mode_realm m ON m.singleton=r.singleton
   WHERE r.singleton=1 AND r.account_id=NEW.account_id AND r.mode=NEW.mode AND r.billing_authority=NEW.billing_authority AND m.mode=NEW.mode)
 OR EXISTS (SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN ('mode','success_url','cancel_url','payment_method_types','metadata','setup_intent_data'))
 OR EXISTS (SELECT 1 FROM json_each(NEW.request_json,'$.metadata') WHERE key NOT IN ('organizationId','reference','fingerprint','setupDisclosureRevision','stripeAccountId','financialRealm','billingAuthority') OR type<>'text')
 OR (SELECT count(*) FROM json_each(NEW.request_json))<>6
 OR (SELECT count(*) FROM json_each(NEW.request_json,'$.metadata'))<>7
 OR (SELECT count(*) FROM json_each(NEW.request_json,'$.setup_intent_data'))<>1
 OR (SELECT count(*) FROM json_each(NEW.request_json,'$.setup_intent_data.metadata'))<>7
 OR EXISTS (SELECT 1 FROM json_each(NEW.request_json,'$.setup_intent_data') WHERE key<>'metadata' OR type<>'object')
 OR EXISTS (SELECT 1 FROM json_each(NEW.request_json,'$.setup_intent_data.metadata') WHERE key NOT IN ('organizationId','reference','fingerprint','setupDisclosureRevision','stripeAccountId','financialRealm','billingAuthority') OR type<>'text')
BEGIN SELECT RAISE(ABORT,'constraint: exact original card setup request/realm required');
END;
CREATE TRIGGER stripe_billing_card_setup_commands_no_replace BEFORE INSERT ON stripe_billing_card_setup_commands
WHEN EXISTS (SELECT 1 FROM stripe_billing_card_setup_commands WHERE (org_id=NEW.org_id AND reference=NEW.reference) OR stripe_key=NEW.stripe_key
 OR (NEW.session_id IS NOT NULL AND session_id=NEW.session_id) OR (NEW.setup_intent_id IS NOT NULL AND setup_intent_id=NEW.setup_intent_id))
BEGIN SELECT RAISE(ABORT,'constraint: original card setup cannot be replaced');
END;
CREATE TRIGGER stripe_billing_card_setup_commands_no_delete BEFORE DELETE ON stripe_billing_card_setup_commands
BEGIN SELECT RAISE(ABORT,'constraint: card setup custody is durable');
END;

CREATE TRIGGER stripe_billing_card_setup_commands_transition BEFORE UPDATE ON stripe_billing_card_setup_commands
WHEN NEW.org_id IS NOT OLD.org_id
 OR NEW.reference IS NOT OLD.reference
 OR NEW.authorized_principal IS NOT OLD.authorized_principal
 OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.disclosure_revision IS NOT OLD.disclosure_revision
 OR NEW.account_id IS NOT OLD.account_id
 OR NEW.mode IS NOT OLD.mode
 OR NEW.financial_realm IS NOT OLD.financial_realm
 OR NEW.billing_authority IS NOT OLD.billing_authority
 OR NEW.flow_kind IS NOT OLD.flow_kind
 OR NEW.success_return_url IS NOT OLD.success_return_url
 OR NEW.cancel_return_url IS NOT OLD.cancel_return_url
 OR NEW.request_json IS NOT OLD.request_json
 OR NEW.stripe_key IS NOT OLD.stripe_key
 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.customer_id IS NOT NULL AND NEW.customer_id IS NOT OLD.customer_id)
 OR (NEW.customer_id IS NOT NULL AND OLD.customer_id IS NULL AND
     (OLD.state<>'awaiting-customer' OR NEW.state<>'prepared' OR NOT EXISTS (SELECT 1 FROM stripe_billing_customers WHERE org_id=NEW.org_id AND customer_id=NEW.customer_id)))
 OR (OLD.dispatch_nonce IS NOT NULL AND NEW.dispatch_nonce IS NOT OLD.dispatch_nonce)
 OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
 OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
 OR (OLD.setup_intent_id IS NOT NULL AND NEW.setup_intent_id IS NOT OLD.setup_intent_id)
 OR (OLD.state IN ('verified','abandoned') AND
     (NEW.state IS NOT OLD.state OR NEW.result_sequence IS NOT OLD.result_sequence OR NEW.native_outcome IS NOT OLD.native_outcome OR NEW.terminal_at IS NOT OLD.terminal_at))
 OR (NEW.state='awaiting-customer' AND OLD.state<>'awaiting-customer')
 OR (NEW.state='prepared' AND OLD.state NOT IN ('awaiting-customer','prepared'))
 OR (NEW.state='dispatched' AND OLD.state NOT IN ('prepared','dispatched'))
 OR (NEW.state='original-known' AND OLD.state NOT IN ('dispatched','original-known'))
 OR (OLD.state='prepared' AND NEW.state='dispatched' AND (NEW.session_id IS NOT NULL OR NEW.setup_intent_id IS NOT NULL))
 OR (NEW.state='verified' AND (OLD.state<>'original-known' OR NOT EXISTS (
    SELECT 1 FROM stripe_billing_card_setup_results r WHERE r.org_id=NEW.org_id AND r.reference=NEW.reference AND r.sequence=NEW.result_sequence
    AND r.kind IN ('setup-succeeded','setup-canceled') AND r.setup_outcome=NEW.native_outcome AND r.observed_at=NEW.terminal_at
    AND r.session_id=NEW.session_id AND r.setup_intent_id=NEW.setup_intent_id AND r.customer_id=NEW.customer_id)))
 OR (NEW.state='abandoned' AND (OLD.state NOT IN ('awaiting-customer','prepared') OR OLD.dispatched_at IS NOT NULL OR OLD.dispatch_nonce IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM stripe_billing_card_setup_results r WHERE r.org_id=NEW.org_id AND r.reference=NEW.reference AND r.sequence=NEW.result_sequence
    AND r.kind='abandoned' AND r.observed_at=NEW.terminal_at)))
BEGIN SELECT RAISE(ABORT,'constraint: card setup original custody/state transition required');
END;

CREATE TABLE stripe_billing_card_setup_results (
 org_id TEXT NOT NULL, reference TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
 kind TEXT NOT NULL CHECK(kind IN ('session-expiry','setup-succeeded','setup-canceled','abandoned')),
 customer_id TEXT, session_id TEXT, setup_intent_id TEXT,
 payment_method_id TEXT CHECK(payment_method_id IS NULL OR (length(payment_method_id) BETWEEN 4 AND 255 AND substr(payment_method_id,1,3)='pm_')),
 usage TEXT CHECK(usage IS NULL OR usage='off_session'),
 session_expired INTEGER NOT NULL CHECK(session_expired IN (0,1)),
 setup_outcome TEXT CHECK(setup_outcome IS NULL OR setup_outcome IN ('succeeded','canceled')),
 source_confirmed_json TEXT CHECK(source_confirmed_json IS NULL OR (json_valid(source_confirmed_json) AND json_type(source_confirmed_json)='object')),
 no_effect_json TEXT CHECK(no_effect_json IS NULL OR (json_valid(no_effect_json) AND json_type(no_effect_json)='object'
    AND json_extract(no_effect_json,'$.organizationId') IS org_id AND json_extract(no_effect_json,'$.reference') IS reference
    AND json_extract(no_effect_json,'$.decision') IS 'before-dispatch')),
 observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
 command_state TEXT CHECK(command_state IS NULL OR command_state IN ('verified','abandoned')),
 PRIMARY KEY(org_id,reference,sequence),
 FOREIGN KEY(org_id,reference) REFERENCES stripe_billing_card_setup_commands(org_id,reference),
 FOREIGN KEY(org_id,reference,session_id,setup_intent_id) REFERENCES stripe_billing_card_setup_commands(org_id,reference,session_id,setup_intent_id),
 FOREIGN KEY(org_id,reference,command_state) REFERENCES stripe_billing_card_setup_commands(org_id,reference,state) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='session-expiry' AND customer_id IS NOT NULL AND session_id IS NOT NULL AND payment_method_id IS NULL AND usage IS NULL
       AND session_expired=1 AND setup_outcome IS NULL AND source_confirmed_json IS NOT NULL AND no_effect_json IS NULL AND command_state IS NULL)
   OR (kind='setup-succeeded' AND customer_id IS NOT NULL AND session_id IS NOT NULL AND setup_intent_id IS NOT NULL AND payment_method_id IS NOT NULL
       AND usage IS 'off_session' AND setup_outcome IS 'succeeded' AND source_confirmed_json IS NOT NULL AND no_effect_json IS NULL AND command_state IS 'verified')
   OR (kind='setup-canceled' AND customer_id IS NOT NULL AND session_id IS NOT NULL AND setup_intent_id IS NOT NULL
       AND setup_outcome IS 'canceled' AND source_confirmed_json IS NOT NULL AND no_effect_json IS NULL AND command_state IS 'verified')
   OR (kind='abandoned' AND session_id IS NULL AND setup_intent_id IS NULL AND payment_method_id IS NULL AND usage IS NULL
       AND session_expired=0 AND setup_outcome IS NULL AND source_confirmed_json IS NULL AND no_effect_json IS NOT NULL AND command_state IS 'abandoned'))
);
CREATE UNIQUE INDEX stripe_billing_card_setup_terminal_result ON stripe_billing_card_setup_results(org_id,reference) WHERE kind<>'session-expiry';
CREATE TRIGGER stripe_billing_card_setup_results_original BEFORE INSERT ON stripe_billing_card_setup_results
WHEN NOT EXISTS (SELECT 1 FROM stripe_billing_card_setup_commands c WHERE c.org_id=NEW.org_id AND c.reference=NEW.reference
 AND c.customer_id IS NEW.customer_id AND NEW.observed_at>=c.created_at
 AND ((NEW.kind='abandoned' AND c.state IN ('awaiting-customer','prepared') AND c.dispatched_at IS NULL AND c.dispatch_nonce IS NULL)
   OR (NEW.kind<>'abandoned' AND c.state IN ('original-known','verified') AND c.dispatched_at<=NEW.observed_at
       AND c.session_id=NEW.session_id AND c.setup_intent_id IS NEW.setup_intent_id)))
 OR (NEW.kind<>'abandoned' AND (
      json_extract(NEW.source_confirmed_json,'$.realmMatched') IS NOT 1
   OR json_extract(NEW.source_confirmed_json,'$.customerMatched') IS NOT 1
   OR json_extract(NEW.source_confirmed_json,'$.originalCommandMatched') IS NOT 1
   OR json_extract(NEW.source_confirmed_json,'$.sessionLinkMatched') IS NOT 1
   OR EXISTS (SELECT 1 FROM json_each(NEW.source_confirmed_json) WHERE key NOT IN ('realmMatched','customerMatched','originalCommandMatched','sessionLinkMatched','setupIntentTerminalMatched') OR type<>'true')
   OR (NEW.kind IN ('setup-succeeded','setup-canceled') AND json_extract(NEW.source_confirmed_json,'$.setupIntentTerminalMatched') IS NOT 1)
   OR (NEW.kind='session-expiry' AND json_extract(NEW.source_confirmed_json,'$.setupIntentTerminalMatched') IS NOT NULL)))
 OR (NEW.kind='abandoned' AND EXISTS (SELECT 1 FROM json_each(NEW.no_effect_json) WHERE key NOT IN ('organizationId','reference','decision') OR type<>'text'))
BEGIN SELECT RAISE(ABORT,'constraint: exact original setup observation/result required');
END;
CREATE TRIGGER stripe_billing_card_setup_results_no_replace BEFORE INSERT ON stripe_billing_card_setup_results
WHEN EXISTS (SELECT 1 FROM stripe_billing_card_setup_results WHERE org_id=NEW.org_id AND reference=NEW.reference
  AND (sequence=NEW.sequence OR (kind<>'session-expiry' AND NEW.kind<>'session-expiry')))
BEGIN SELECT RAISE(ABORT,'constraint: original card setup result cannot be replaced');
END;
CREATE TRIGGER stripe_billing_card_setup_results_no_update BEFORE UPDATE ON stripe_billing_card_setup_results
BEGIN SELECT RAISE(ABORT,'constraint: card setup history is immutable');
END;
CREATE TRIGGER stripe_billing_card_setup_results_no_delete BEFORE DELETE ON stripe_billing_card_setup_results
BEGIN SELECT RAISE(ABORT,'constraint: card setup history is durable');
END;

-- BEFORE UPDATE must reject foreign ownership BEFORE UNIQUE OR REPLACE can
-- implicitly delete an unresolved command while recursive_triggers is OFF.
CREATE TRIGGER stripe_billing_card_setup_commands_foreign_pin
BEFORE UPDATE OF dispatch_nonce,session_id,setup_intent_id ON stripe_billing_card_setup_commands
WHEN EXISTS (SELECT 1 FROM stripe_billing_card_setup_commands other
 WHERE (other.org_id IS NOT NEW.org_id OR other.reference IS NOT NEW.reference)
 AND ((NEW.dispatch_nonce IS NOT NULL AND other.dispatch_nonce=NEW.dispatch_nonce)
   OR (NEW.session_id IS NOT NULL AND other.session_id=NEW.session_id)
   OR (NEW.setup_intent_id IS NOT NULL AND other.setup_intent_id=NEW.setup_intent_id)))
BEGIN SELECT RAISE(ABORT,'constraint: native setup identity belongs to another original command');
END;
