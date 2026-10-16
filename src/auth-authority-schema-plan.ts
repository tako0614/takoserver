/** Unregistered, additive Auth103 candidate. Never apply without owner review/enrollment. */
export const additiveAuthDDL = String.raw`
-- PRIVATE UNREGISTERED AUTH0103 ADDITIVE TABLE CANDIDATE.
-- Executed only in synthetic component tests, never registered or applied.
-- Not a runnable migration, enrollment, applied schema or grant.
-- No Auth -> Financial FK. No FK to expirable token/RP payload/Principal rows.
-- Provenance comes from actual Auth issuance/adoption; a row/DTO alone is not proof.
CREATE TABLE auth_principal_incarnations (
  principal_id TEXT NOT NULL,
  principal_incarnation TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK(identity_kind IN ('takos-id','google','github','shared-account')),
  identity_subject TEXT NOT NULL,
  principal_created_at TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('fresh-local','fresh-shared','proved-legacy')),
  origin_ref TEXT NOT NULL,
  origin_digest TEXT NOT NULL,
  identity_authority_body TEXT COLLATE BINARY,
  identity_authority_digest TEXT COLLATE BINARY,
  enrolled_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','retired')),
  terminal_reason TEXT,
  terminal_at TEXT,
  terminal_ref TEXT,
  PRIMARY KEY(principal_id,principal_incarnation),
  UNIQUE(principal_id),
  CHECK(length(principal_id) BETWEEN 1 AND 512),
  CHECK(length(principal_incarnation) BETWEEN 1 AND 256),
  CHECK(length(identity_subject) BETWEEN 1 AND 512),
  CHECK(length(origin_ref) BETWEEN 1 AND 512),
  CHECK(length(origin_digest)=71 AND substr(origin_digest,1,7)='sha256:'
    AND substr(origin_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK ((origin_kind='fresh-local' AND identity_kind IN ('takos-id','google','github')
    AND identity_authority_body IS NOT NULL AND identity_authority_digest IS NOT NULL)
    OR (origin_kind='fresh-shared' AND identity_kind='shared-account'
      AND identity_authority_body IS NULL AND identity_authority_digest IS NULL)
    OR (origin_kind='proved-legacy' AND identity_kind IN ('takos-id','google','github')
      AND identity_authority_body IS NULL AND identity_authority_digest IS NULL)),
  CHECK (identity_authority_digest IS NULL OR
    (length(identity_authority_digest)=71 AND substr(identity_authority_digest,1,7)='sha256:'
      AND substr(identity_authority_digest,8) NOT GLOB '*[^0-9a-f]*')),
  CHECK (identity_authority_body IS NULL OR
    (length(identity_authority_body)<=8192 AND
    CASE WHEN json_valid(identity_authority_body) THEN COALESCE((
      json_type(identity_authority_body)='array'
      AND json_extract(identity_authority_body,'$[0]')='takoserver.identity-verification-domain.v1'
      AND json_extract(identity_authority_body,'$[1]')=identity_kind
      AND ((identity_kind='takos-id' AND json_array_length(identity_authority_body)=5
        AND json_extract(identity_authority_body,'$[2]')='oidc'
        AND json_type(identity_authority_body,'$[3]')='text'
        AND json_type(identity_authority_body,'$[4]')='text')
      OR (identity_kind='google' AND json_array_length(identity_authority_body)=6
        AND json_extract(identity_authority_body,'$[2]')='oidc'
        AND json_extract(identity_authority_body,'$[3]')='accounts.google.com'
        AND json_extract(identity_authority_body,'$[4]')='https://accounts.google.com'
        AND json_type(identity_authority_body,'$[5]')='text')
      OR (identity_kind IN ('google','github') AND json_array_length(identity_authority_body)=7
        AND json_extract(identity_authority_body,'$[2]')='operator-assertion'
        AND json_type(identity_authority_body,'$[3]')='text'
        AND json_extract(identity_authority_body,'$[4]')='OKP'
        AND json_extract(identity_authority_body,'$[5]')='Ed25519'
        AND json_type(identity_authority_body,'$[6]')='text'))),0)
    ELSE 0 END)),
  CHECK((state='active' AND terminal_reason IS NULL AND terminal_at IS NULL AND terminal_ref IS NULL)
    OR (state='retired' AND terminal_reason IS NOT NULL AND terminal_at IS NOT NULL AND terminal_ref IS NOT NULL))
);
CREATE UNIQUE INDEX auth_principal_incarnations_active ON auth_principal_incarnations(principal_id) WHERE state='active';

CREATE TABLE shared_principal_bindings (
  binding_ref TEXT PRIMARY KEY NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  controller_incarnation TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_incarnation TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK(binding_kind IN ('fresh-shared','proved-legacy')),
  evidence_ref TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  previous_binding_ref TEXT,
  enrolled_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','retired')),
  terminal_reason TEXT,
  terminal_at TEXT,
  terminal_ref TEXT,
  UNIQUE(issuer,subject,controller_incarnation),
  UNIQUE(binding_ref,principal_id,principal_incarnation),
  UNIQUE(previous_binding_ref),
  FOREIGN KEY(principal_id,principal_incarnation)
    REFERENCES auth_principal_incarnations(principal_id,principal_incarnation) ON DELETE RESTRICT,
  FOREIGN KEY(previous_binding_ref) REFERENCES shared_principal_bindings(binding_ref) ON DELETE RESTRICT,
  CHECK(length(binding_ref) BETWEEN 1 AND 256),
  CHECK(length(issuer) BETWEEN 1 AND 2048),
  CHECK(length(subject) BETWEEN 1 AND 512),
  CHECK(length(controller_incarnation) BETWEEN 1 AND 256),
  CHECK(length(target_ref) BETWEEN 1 AND 512),
  CHECK(length(evidence_ref) BETWEEN 1 AND 512),
  CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:'
    AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(previous_binding_ref IS NULL OR previous_binding_ref<>binding_ref),
  CHECK((state='active' AND terminal_reason IS NULL AND terminal_at IS NULL AND terminal_ref IS NULL)
    OR (state='retired' AND terminal_reason IS NOT NULL AND terminal_at IS NOT NULL AND terminal_ref IS NOT NULL))
);
CREATE UNIQUE INDEX shared_principal_bindings_identity_active ON shared_principal_bindings(issuer,subject) WHERE state='active';
CREATE INDEX shared_principal_bindings_principal ON shared_principal_bindings(principal_id,principal_incarnation,state);

CREATE TABLE credential_authority_classes (
  authority_ref TEXT PRIMARY KEY NOT NULL,
  credential_incarnation TEXT NOT NULL UNIQUE,
  class TEXT NOT NULL CHECK(class IN ('direct-owner-session','direct-exact-org-key','official-shared-broker','official-shared-rp-session')),
  backend TEXT NOT NULL CHECK(backend IN ('auth-token','shared-rp-session')),
  target_ref TEXT NOT NULL,
  organization_id TEXT,
  principal_id TEXT NOT NULL,
  principal_incarnation TEXT NOT NULL,
  principal_binding_ref TEXT,
  issuance_ref TEXT NOT NULL,
  issuance_digest TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  token_id TEXT,
  token_digest TEXT UNIQUE,
  token_kind TEXT,
  token_scopes_json TEXT,
  token_created_at TEXT,
  rp_registration_ref TEXT,
  rp_registration_digest TEXT,
  session_digest TEXT UNIQUE,
  session_created_at INTEGER,
  session_enrolled_version INTEGER,
  issuer TEXT,
  client_id TEXT,
  subject TEXT,
  issuer_session_id TEXT,
  auth_time INTEGER,
  account_id TEXT,
  workspace_id TEXT,
  workspace_ref TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','retired')),
  terminal_reason TEXT,
  terminal_at TEXT,
  terminal_ref TEXT,
  FOREIGN KEY(principal_id,principal_incarnation)
    REFERENCES auth_principal_incarnations(principal_id,principal_incarnation) ON DELETE RESTRICT,
  FOREIGN KEY(principal_binding_ref,principal_id,principal_incarnation)
    REFERENCES shared_principal_bindings(binding_ref,principal_id,principal_incarnation) ON DELETE RESTRICT,
  CHECK(length(authority_ref) BETWEEN 1 AND 256),
  CHECK(length(credential_incarnation) BETWEEN 1 AND 256),
  CHECK(length(target_ref) BETWEEN 1 AND 512),
  CHECK(length(issuance_ref) BETWEEN 1 AND 512),
  CHECK(length(issuance_digest)=71 AND substr(issuance_digest,1,7)='sha256:'
    AND substr(issuance_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK((state='active' AND terminal_reason IS NULL AND terminal_at IS NULL AND terminal_ref IS NULL)
    OR (state='retired' AND terminal_reason IS NOT NULL AND terminal_at IS NOT NULL AND terminal_ref IS NOT NULL)),
  CHECK((backend='auth-token'
      AND class IN ('direct-owner-session','direct-exact-org-key','official-shared-broker')
      AND token_id IS NOT NULL AND token_digest IS NOT NULL AND token_kind IS NOT NULL
      AND token_scopes_json IS NOT NULL AND token_created_at IS NOT NULL
      AND json_valid(token_scopes_json) AND json_type(token_scopes_json)='array'
      AND principal_binding_ref IS NULL AND rp_registration_ref IS NULL AND rp_registration_digest IS NULL
      AND session_digest IS NULL AND session_created_at IS NULL AND session_enrolled_version IS NULL AND issuer IS NULL AND client_id IS NULL
      AND subject IS NULL AND issuer_session_id IS NULL AND auth_time IS NULL AND account_id IS NULL
      AND workspace_id IS NULL AND workspace_ref IS NULL
      AND ((class='direct-owner-session' AND token_kind='session' AND organization_id IS NULL)
        OR (class IN ('direct-exact-org-key','official-shared-broker') AND token_kind='api_key' AND organization_id IS NOT NULL)))
    OR (backend='shared-rp-session' AND class='official-shared-rp-session'
      AND principal_binding_ref IS NOT NULL AND organization_id IS NOT NULL
      AND rp_registration_ref IS NOT NULL AND rp_registration_digest IS NOT NULL
      AND session_digest IS NOT NULL AND session_created_at IS NOT NULL AND session_enrolled_version IS NOT NULL
      AND issuer IS NOT NULL AND client_id IS NOT NULL AND subject IS NOT NULL
      AND issuer_session_id IS NOT NULL AND auth_time IS NOT NULL AND account_id IS NOT NULL
      AND workspace_id IS NOT NULL AND workspace_ref IS NOT NULL
      AND token_id IS NULL AND token_digest IS NULL AND token_kind IS NULL
      AND token_scopes_json IS NULL AND token_created_at IS NULL)),
  CHECK(token_digest IS NULL OR (length(token_digest)=71 AND substr(token_digest,1,7)='sha256:' AND substr(token_digest,8) NOT GLOB '*[^0-9a-f]*')),
  CHECK(session_digest IS NULL OR (length(session_digest)=71 AND substr(session_digest,1,7)='sha256:' AND substr(session_digest,8) NOT GLOB '*[^0-9a-f]*')),
  CHECK(rp_registration_digest IS NULL OR (length(rp_registration_digest)=71 AND substr(rp_registration_digest,1,7)='sha256:' AND substr(rp_registration_digest,8) NOT GLOB '*[^0-9a-f]*')),
  CHECK(session_created_at IS NULL OR (session_created_at>=0 AND typeof(session_created_at)='integer')),
  CHECK(session_enrolled_version IS NULL OR (session_enrolled_version>=0 AND typeof(session_enrolled_version)='integer')),
  CHECK(auth_time IS NULL OR (auth_time>=0 AND typeof(auth_time)='integer'))
);
CREATE UNIQUE INDEX credential_authority_classes_token_id_active ON credential_authority_classes(token_id) WHERE backend='auth-token' AND state='active';
CREATE INDEX credential_authority_classes_principal ON credential_authority_classes(principal_id,principal_incarnation,state);
CREATE INDEX credential_authority_classes_binding ON credential_authority_classes(principal_binding_ref,state);
-- Candidate lifecycle rules are executed only in synthetic component tests.

CREATE TRIGGER auth_principal_incarnations_no_replace BEFORE INSERT ON auth_principal_incarnations
WHEN EXISTS (SELECT 1 FROM auth_principal_incarnations WHERE principal_id=NEW.principal_id)
BEGIN SELECT RAISE(ABORT,'Auth authority cannot be replaced'); END;
CREATE TRIGGER auth_principal_incarnations_no_delete BEFORE DELETE ON auth_principal_incarnations
BEGIN SELECT RAISE(ABORT,'Auth history is retained'); END;
CREATE TRIGGER auth_principal_incarnations_terminal_only BEFORE UPDATE ON auth_principal_incarnations
WHEN OLD.state<>'active' OR NEW.state<>'retired' OR
 NEW.principal_id IS NOT OLD.principal_id
 OR NEW.principal_incarnation IS NOT OLD.principal_incarnation
 OR NEW.identity_kind IS NOT OLD.identity_kind
 OR NEW.identity_subject IS NOT OLD.identity_subject
 OR NEW.principal_created_at IS NOT OLD.principal_created_at
 OR NEW.origin_kind IS NOT OLD.origin_kind
 OR NEW.origin_ref IS NOT OLD.origin_ref
 OR NEW.origin_digest IS NOT OLD.origin_digest
 OR NEW.identity_authority_body IS NOT OLD.identity_authority_body
 OR NEW.identity_authority_digest IS NOT OLD.identity_authority_digest
 OR NEW.enrolled_at IS NOT OLD.enrolled_at
BEGIN SELECT RAISE(ABORT,'Auth body immutable and retirement terminal'); END;

CREATE TRIGGER shared_principal_bindings_no_replace BEFORE INSERT ON shared_principal_bindings
WHEN EXISTS (SELECT 1 FROM shared_principal_bindings WHERE binding_ref=NEW.binding_ref OR (issuer=NEW.issuer AND subject=NEW.subject AND controller_incarnation=NEW.controller_incarnation) OR (issuer=NEW.issuer AND subject=NEW.subject AND state='active' AND NEW.state='active') OR (NEW.previous_binding_ref IS NOT NULL AND previous_binding_ref=NEW.previous_binding_ref))
BEGIN SELECT RAISE(ABORT,'Auth authority cannot be replaced'); END;
CREATE TRIGGER shared_principal_bindings_no_delete BEFORE DELETE ON shared_principal_bindings
BEGIN SELECT RAISE(ABORT,'Auth history is retained'); END;
CREATE TRIGGER shared_principal_bindings_terminal_only BEFORE UPDATE ON shared_principal_bindings
WHEN OLD.state<>'active' OR NEW.state<>'retired' OR
 NEW.binding_ref IS NOT OLD.binding_ref
 OR NEW.issuer IS NOT OLD.issuer
 OR NEW.subject IS NOT OLD.subject
 OR NEW.controller_incarnation IS NOT OLD.controller_incarnation
 OR NEW.principal_id IS NOT OLD.principal_id
 OR NEW.principal_incarnation IS NOT OLD.principal_incarnation
 OR NEW.target_ref IS NOT OLD.target_ref
 OR NEW.binding_kind IS NOT OLD.binding_kind
 OR NEW.evidence_ref IS NOT OLD.evidence_ref
 OR NEW.evidence_digest IS NOT OLD.evidence_digest
 OR NEW.previous_binding_ref IS NOT OLD.previous_binding_ref
 OR NEW.enrolled_at IS NOT OLD.enrolled_at
BEGIN SELECT RAISE(ABORT,'Auth body immutable and retirement terminal'); END;

CREATE TRIGGER credential_authority_classes_no_replace BEFORE INSERT ON credential_authority_classes
WHEN EXISTS (SELECT 1 FROM credential_authority_classes WHERE authority_ref=NEW.authority_ref OR credential_incarnation=NEW.credential_incarnation OR (NEW.token_digest IS NOT NULL AND token_digest=NEW.token_digest) OR (NEW.session_digest IS NOT NULL AND session_digest=NEW.session_digest) OR (NEW.backend='auth-token' AND backend='auth-token' AND token_id=NEW.token_id AND state='active' AND NEW.state='active'))
BEGIN SELECT RAISE(ABORT,'Auth authority cannot be replaced'); END;
CREATE TRIGGER credential_authority_classes_no_delete BEFORE DELETE ON credential_authority_classes
BEGIN SELECT RAISE(ABORT,'Auth history is retained'); END;
CREATE TRIGGER credential_authority_classes_terminal_only BEFORE UPDATE ON credential_authority_classes
WHEN OLD.state<>'active' OR NEW.state<>'retired' OR
 NEW.authority_ref IS NOT OLD.authority_ref
 OR NEW.credential_incarnation IS NOT OLD.credential_incarnation
 OR NEW.class IS NOT OLD.class
 OR NEW.backend IS NOT OLD.backend
 OR NEW.target_ref IS NOT OLD.target_ref
 OR NEW.organization_id IS NOT OLD.organization_id
 OR NEW.principal_id IS NOT OLD.principal_id
 OR NEW.principal_incarnation IS NOT OLD.principal_incarnation
 OR NEW.principal_binding_ref IS NOT OLD.principal_binding_ref
 OR NEW.issuance_ref IS NOT OLD.issuance_ref
 OR NEW.issuance_digest IS NOT OLD.issuance_digest
 OR NEW.issued_at IS NOT OLD.issued_at
 OR NEW.token_id IS NOT OLD.token_id
 OR NEW.token_digest IS NOT OLD.token_digest
 OR NEW.token_kind IS NOT OLD.token_kind
 OR NEW.token_scopes_json IS NOT OLD.token_scopes_json
 OR NEW.token_created_at IS NOT OLD.token_created_at
 OR NEW.rp_registration_ref IS NOT OLD.rp_registration_ref
 OR NEW.rp_registration_digest IS NOT OLD.rp_registration_digest
 OR NEW.session_digest IS NOT OLD.session_digest
 OR NEW.session_created_at IS NOT OLD.session_created_at
 OR NEW.session_enrolled_version IS NOT OLD.session_enrolled_version
 OR NEW.issuer IS NOT OLD.issuer
 OR NEW.client_id IS NOT OLD.client_id
 OR NEW.subject IS NOT OLD.subject
 OR NEW.issuer_session_id IS NOT OLD.issuer_session_id
 OR NEW.auth_time IS NOT OLD.auth_time
 OR NEW.account_id IS NOT OLD.account_id
 OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.workspace_ref IS NOT OLD.workspace_ref
BEGIN SELECT RAISE(ABORT,'Auth body immutable and retirement terminal'); END;

CREATE TRIGGER auth_principal_incarnations_initial BEFORE INSERT ON auth_principal_incarnations
WHEN NEW.state<>'active' OR NOT EXISTS (
 SELECT 1 FROM principals p WHERE p.id=NEW.principal_id AND p.provider=NEW.identity_kind
   AND p.provider_subject=NEW.identity_subject AND p.created_at=NEW.principal_created_at)
 OR (NEW.origin_kind='fresh-shared' AND NEW.identity_kind<>'shared-account')
 OR (NEW.origin_kind='fresh-local' AND NEW.identity_kind NOT IN ('takos-id','google','github'))
BEGIN SELECT RAISE(ABORT,'Exact current Principal origin required'); END;
CREATE TRIGGER shared_principal_bindings_initial BEFORE INSERT ON shared_principal_bindings
WHEN NEW.state<>'active' OR NOT EXISTS (
 SELECT 1 FROM auth_principal_incarnations i JOIN principals p ON p.id=i.principal_id
 WHERE i.principal_id=NEW.principal_id AND i.principal_incarnation=NEW.principal_incarnation
   AND i.state='active' AND i.origin_kind=NEW.binding_kind
   AND i.identity_authority_body IS NULL AND i.identity_authority_digest IS NULL
   AND p.provider=i.identity_kind AND p.provider_subject=i.identity_subject
   AND p.created_at=i.principal_created_at
   AND ((NEW.binding_kind='fresh-shared' AND p.provider='shared-account'
       AND ((NEW.previous_binding_ref IS NULL AND p.provider_subject=NEW.binding_ref)
         OR (NEW.previous_binding_ref IS NOT NULL AND EXISTS (
           SELECT 1 FROM shared_principal_bindings root
           WHERE root.binding_ref=i.identity_subject AND root.previous_binding_ref IS NULL
             AND root.binding_kind='fresh-shared' AND root.state='retired'
             AND root.principal_id=NEW.principal_id AND root.principal_incarnation=NEW.principal_incarnation
             AND root.issuer=NEW.issuer AND root.subject=NEW.subject AND root.target_ref=NEW.target_ref))))
     OR (NEW.binding_kind='proved-legacy' AND p.provider IN ('takos-id','google','github'))))
 OR (NEW.previous_binding_ref IS NULL AND EXISTS (
 SELECT 1 FROM shared_principal_bindings prior WHERE prior.issuer=NEW.issuer AND prior.subject=NEW.subject))
 OR (NEW.previous_binding_ref IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM shared_principal_bindings old WHERE old.binding_ref=NEW.previous_binding_ref
   AND old.state='retired' AND old.principal_id=NEW.principal_id
   AND old.principal_incarnation=NEW.principal_incarnation
   AND old.binding_kind=NEW.binding_kind AND old.issuer=NEW.issuer AND old.subject=NEW.subject
   AND old.target_ref=NEW.target_ref AND old.controller_incarnation<>NEW.controller_incarnation
   AND old.evidence_ref<>NEW.evidence_ref AND old.evidence_digest<>NEW.evidence_digest))
BEGIN SELECT RAISE(ABORT,'Current proved Principal binding required'); END;
CREATE TRIGGER credential_authority_classes_initial BEFORE INSERT ON credential_authority_classes
WHEN NEW.state<>'active' OR NOT EXISTS (
 SELECT 1 FROM auth_principal_incarnations i JOIN principals p ON p.id=i.principal_id
 WHERE i.principal_id=NEW.principal_id AND i.principal_incarnation=NEW.principal_incarnation
   AND i.state='active' AND p.provider=i.identity_kind AND p.provider_subject=i.identity_subject
   AND p.created_at=i.principal_created_at
   AND ((NEW.class IN ('direct-owner-session','direct-exact-org-key')
     AND i.origin_kind='fresh-local' AND i.identity_kind IN ('takos-id','google','github')
     AND i.identity_authority_body IS NOT NULL AND i.identity_authority_digest IS NOT NULL)
    OR (NEW.class IN ('official-shared-broker','official-shared-rp-session')
     AND i.origin_kind IN ('fresh-shared','proved-legacy')
     AND i.identity_authority_body IS NULL AND i.identity_authority_digest IS NULL)))
 OR (NEW.backend='auth-token' AND NOT EXISTS (
 SELECT 1 FROM auth_tokens t WHERE t.id=NEW.token_id AND t.secret_digest=NEW.token_digest
   AND t.kind=NEW.token_kind AND t.principal_id=NEW.principal_id
   AND t.org_id IS NEW.organization_id AND t.created_at=NEW.token_created_at
   AND t.scopes_json=NEW.token_scopes_json AND t.revoked_at IS NULL
   AND t.created_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 OR (NEW.class='official-shared-broker' AND NOT EXISTS (
 SELECT 1 FROM shared_principal_bindings b
 WHERE b.principal_id=NEW.principal_id AND b.principal_incarnation=NEW.principal_incarnation
   AND b.target_ref=NEW.target_ref AND b.binding_kind IN ('fresh-shared','proved-legacy')
   AND b.state='active'))
 OR (NEW.backend='shared-rp-session' AND NOT EXISTS (
 SELECT 1 FROM shared_principal_bindings b WHERE b.binding_ref=NEW.principal_binding_ref
   AND b.principal_id=NEW.principal_id AND b.principal_incarnation=NEW.principal_incarnation
   AND b.issuer=NEW.issuer AND b.subject=NEW.subject AND b.subject=NEW.account_id
   AND b.target_ref=NEW.target_ref AND b.binding_kind IN ('fresh-shared','proved-legacy')
   AND b.state='active'))
 OR (NEW.backend='shared-rp-session' AND NOT EXISTS (
 SELECT 1 FROM shared_auth_sessions s WHERE s.digest=NEW.session_digest
   AND s.created_at=NEW.session_created_at AND s.version=NEW.session_enrolled_version
   AND s.status='active' AND s.account_id=NEW.account_id
   AND s.principal_id=NEW.principal_id AND s.workspace_id=NEW.workspace_id
   AND s.created_at<=CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)
   AND s.last_used_at<=CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)
   AND s.absolute_expires_at>CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)
   AND s.last_used_at+43200000>CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)))
BEGIN SELECT RAISE(ABORT,'Actual live credential and retained class origin required'); END;
-- This insert fence checks local physical facts, not enrollment/payer/source
-- permission. The genuine Auth issuer still owns actual proof+issuance capture.
-- The exact PR373 shared_auth_sessions row is referenced but not created here.
-- Its owner schema/identity-lifecycle enforcement must be delivered and joined
-- into the eventual Auth103 schema before this candidate can be executable.
-- Genuine RP decrypt/issuer/proof validation and same-batch postcondition remain
-- producer obligations; current row presence alone never mints a class.

-- PRIVATE UNREGISTERED AUTH0103 CANDIDATE, installable only AFTER eventual Principal
-- preservation transition and Auth table creation. Not a schema/apply file.
-- Candidate clock spelling is SQL execution time, not a supplied current-time
-- parameter. Actual D1 clock/precision/limits qualification remains UNRUN.
CREATE TRIGGER auth_principal_id_no_reuse BEFORE INSERT ON principals
WHEN EXISTS(SELECT 1 FROM auth_principal_incarnations WHERE principal_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Enrolled Principal ID cannot be reused or replaced'); END;
CREATE TRIGGER auth_principal_identity_enrolled BEFORE UPDATE ON principals
WHEN (NEW.id IS NOT OLD.id OR NEW.provider IS NOT OLD.provider
  OR NEW.provider_subject IS NOT OLD.provider_subject OR NEW.created_at IS NOT OLD.created_at)
 AND EXISTS(SELECT 1 FROM auth_principal_incarnations WHERE principal_id=OLD.id AND state='active')
BEGIN SELECT RAISE(ABORT,'Enrolled Principal identity is immutable'); END;
CREATE TRIGGER auth_principal_deleted BEFORE DELETE ON principals
BEGIN
 UPDATE auth_principal_incarnations SET state='retired',terminal_reason='principal-deleted',
   terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),terminal_ref='principal-delete:'||principal_incarnation
 WHERE principal_id=OLD.id AND state='active';
END;
CREATE TRIGGER auth_principal_retired AFTER UPDATE OF state ON auth_principal_incarnations
WHEN OLD.state='active' AND NEW.state='retired'
BEGIN
 UPDATE shared_principal_bindings SET state='retired',terminal_reason='principal-retired',
   terminal_at=NEW.terminal_at,terminal_ref=NEW.terminal_ref
 WHERE principal_id=NEW.principal_id AND principal_incarnation=NEW.principal_incarnation AND state='active';
 UPDATE credential_authority_classes SET state='retired',terminal_reason='principal-retired',
   terminal_at=NEW.terminal_at,terminal_ref=NEW.terminal_ref
 WHERE principal_id=NEW.principal_id AND principal_incarnation=NEW.principal_incarnation AND state='active';
END;
CREATE TRIGGER auth_binding_retired AFTER UPDATE OF state ON shared_principal_bindings
WHEN OLD.state='active' AND NEW.state='retired'
BEGIN
 UPDATE credential_authority_classes SET state='retired',terminal_reason='principal-binding-retired',
   terminal_at=NEW.terminal_at,terminal_ref=NEW.terminal_ref
 WHERE principal_binding_ref=NEW.binding_ref AND state='active';
END;
CREATE TRIGGER auth_token_identity_enrolled BEFORE UPDATE ON auth_tokens
WHEN EXISTS(SELECT 1 FROM credential_authority_classes c
   WHERE c.backend='auth-token' AND c.token_id=OLD.id AND c.token_digest=OLD.secret_digest)
 AND (NEW.id IS NOT OLD.id OR NEW.secret_digest IS NOT OLD.secret_digest OR NEW.kind IS NOT OLD.kind
   OR NEW.principal_id IS NOT OLD.principal_id OR NEW.org_id IS NOT OLD.org_id
   OR NEW.scopes_json IS NOT OLD.scopes_json OR NEW.created_at IS NOT OLD.created_at
   OR NEW.expires_at IS NOT OLD.expires_at
   OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at))
BEGIN SELECT RAISE(ABORT,'Enrolled credential identity cannot change or reopen'); END;
CREATE TRIGGER auth_token_revoked AFTER UPDATE OF revoked_at ON auth_tokens
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
 UPDATE credential_authority_classes SET state='retired',terminal_reason='token-revoked',
   terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),terminal_ref='token-revoke:'||authority_ref
 WHERE backend='auth-token' AND token_id=OLD.id AND token_digest=OLD.secret_digest AND state='active';
END;
CREATE TRIGGER auth_token_deleted BEFORE DELETE ON auth_tokens
BEGIN
 UPDATE credential_authority_classes SET state='retired',terminal_reason='token-deleted',
   terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),terminal_ref='token-delete:'||authority_ref
 WHERE backend='auth-token' AND token_id=OLD.id AND token_digest=OLD.secret_digest AND state='active';
END;
-- RP state/delete hooks require owner ACK of the actual integrated RP store
-- schema/transaction. They close exact session_digest + session_created_at class
-- when active/checking -> revocation_pending/revoked, or before payload deletion;
-- they must also preserve Financial-owned source-fence/outbox semantics through
-- the Financial104 producer. No Financial table is referenced by Auth103 DDL.
-- A missing/currently non-active RP row independently fails the final guard.
`;
