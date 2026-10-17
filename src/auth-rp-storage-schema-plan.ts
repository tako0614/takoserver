/**
 * Auth-owned storage needed by the unregistered full RP candidate. This is a
 * source component, not a registered migration, fixture, or schema-apply file.
 * The RP5 store remains the consumer and owns its SQL/acknowledgement ABI.
 */
export const authRpStorageLifecycleDDL = String.raw`
-- PRIVATE UNREGISTERED Auth RP storage component. No migration number or apply authority.
-- No RP payload FK to retained Auth class history and no Auth -> Financial dependency.
-- PK conflicts preserve the store's ON CONFLICT DO NOTHING result; consumed attempts,
-- unclassified session cleanup, and deleted outbox rows have no permanent tombstone.
CREATE TABLE shared_auth_attempts (
  digest TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND 9007199254740991),
  CHECK(typeof(digest)='text' AND length(digest)=71 AND substr(digest,1,7)='sha256:'
    AND substr(digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(typeof(payload)='text' AND length(payload) BETWEEN 1 AND 65536),
  CHECK(expires_at>created_at)
);
CREATE INDEX shared_auth_attempts_expiry ON shared_auth_attempts(expires_at,digest);
CREATE TRIGGER shared_auth_attempts_no_replace_before_insert
BEFORE INSERT ON shared_auth_attempts
WHEN EXISTS(SELECT 1 FROM shared_auth_attempts WHERE digest=NEW.digest)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER shared_auth_attempts_no_update BEFORE UPDATE ON shared_auth_attempts
BEGIN SELECT RAISE(ABORT,'Shared auth attempts are immutable'); END;

CREATE TABLE shared_auth_sessions (
  digest TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL CHECK(typeof(account_id)='text' AND length(account_id) BETWEEN 1 AND 512),
  principal_id TEXT NOT NULL CHECK(typeof(principal_id)='text' AND length(principal_id) BETWEEN 1 AND 512),
  workspace_id TEXT NOT NULL CHECK(typeof(workspace_id)='text' AND length(workspace_id) BETWEEN 1 AND 512),
  payload TEXT NOT NULL CHECK(typeof(payload)='text' AND length(payload) BETWEEN 1 AND 65536),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  last_used_at INTEGER NOT NULL CHECK(typeof(last_used_at)='integer' AND last_used_at BETWEEN 0 AND 9007199254740991),
  absolute_expires_at INTEGER NOT NULL CHECK(typeof(absolute_expires_at)='integer' AND absolute_expires_at BETWEEN 0 AND 9007199254740991),
  grant_checked_at INTEGER NOT NULL CHECK(typeof(grant_checked_at)='integer' AND grant_checked_at BETWEEN 0 AND 9007199254740991),
  version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version)='integer' AND version BETWEEN 0 AND 9007199254740990),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','checking','revocation_pending','revoked')),
  CHECK(typeof(digest)='text' AND length(digest)=71 AND substr(digest,1,7)='sha256:'
    AND substr(digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(absolute_expires_at>created_at),
  CHECK(last_used_at>=created_at AND last_used_at<absolute_expires_at),
  CHECK(grant_checked_at>=created_at AND grant_checked_at<=last_used_at)
);
CREATE INDEX shared_auth_sessions_cleanup
  ON shared_auth_sessions(status,absolute_expires_at,digest);
CREATE TRIGGER shared_auth_sessions_no_reuse_before_insert
BEFORE INSERT ON shared_auth_sessions
WHEN EXISTS(SELECT 1 FROM shared_auth_sessions WHERE digest=NEW.digest)
  OR EXISTS(SELECT 1 FROM credential_authority_classes c
    WHERE c.backend='shared-rp-session' AND c.session_digest=NEW.digest)
BEGIN SELECT RAISE(IGNORE); END;

-- Preserve the RP5 store's status/version CAS and mutable fields. Identity and
-- absolute lifetime never change; only completeSession rotates payload/times.
CREATE TRIGGER shared_auth_sessions_update_guard BEFORE UPDATE ON shared_auth_sessions
WHEN NEW.digest IS NOT OLD.digest
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.absolute_expires_at IS NOT OLD.absolute_expires_at
  OR NEW.version<>OLD.version+1
  OR NOT (
    (OLD.status='active' AND NEW.status='active'
      AND NEW.payload IS OLD.payload AND NEW.grant_checked_at=OLD.grant_checked_at
      AND NEW.last_used_at>=OLD.last_used_at)
    OR (OLD.status='active' AND NEW.status='checking'
      AND NEW.payload IS OLD.payload AND NEW.grant_checked_at=OLD.grant_checked_at
      AND NEW.last_used_at=OLD.last_used_at)
    OR (OLD.status='checking' AND NEW.status='active'
      AND NEW.grant_checked_at>=OLD.grant_checked_at
      AND NEW.last_used_at>=OLD.last_used_at)
    OR (OLD.status IN ('active','checking') AND NEW.status='revocation_pending'
      AND NEW.payload IS OLD.payload AND NEW.grant_checked_at=OLD.grant_checked_at
      AND NEW.last_used_at=OLD.last_used_at)
    OR (OLD.status='revocation_pending' AND NEW.status='revoked'
      AND NEW.payload IS OLD.payload AND NEW.grant_checked_at=OLD.grant_checked_at
      AND NEW.last_used_at=OLD.last_used_at)
  )
BEGIN SELECT RAISE(ABORT,'Shared auth session identity or lifecycle changed'); END;

-- A terminal transition fences the retained class by exact session digest and
-- creation time. History is retired in place, never deleted or reopened.
CREATE TRIGGER shared_auth_sessions_retire_class_after_status
AFTER UPDATE OF status ON shared_auth_sessions
WHEN OLD.status IN ('active','checking') AND NEW.status IN ('revocation_pending','revoked')
BEGIN
  UPDATE credential_authority_classes
  SET state='retired', terminal_reason='rp-session-terminal',
      terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      terminal_ref='rp-session-terminal:'||OLD.digest||':'||OLD.created_at
  WHERE backend='shared-rp-session' AND session_digest=OLD.digest
    AND session_created_at=OLD.created_at AND state='active';
END;
CREATE TRIGGER shared_auth_sessions_retire_class_before_delete
BEFORE DELETE ON shared_auth_sessions
BEGIN
  UPDATE credential_authority_classes
  SET state='retired', terminal_reason='rp-session-terminal',
      terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      terminal_ref='rp-session-terminal:'||OLD.digest||':'||OLD.created_at
  WHERE backend='shared-rp-session' AND session_digest=OLD.digest
    AND session_created_at=OLD.created_at AND state='active';
END;

CREATE TABLE shared_auth_revocations (
  id TEXT PRIMARY KEY NOT NULL,
  session_digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  next_attempt_at INTEGER NOT NULL CHECK(typeof(next_attempt_at)='integer' AND next_attempt_at BETWEEN 0 AND 9007199254740991),
  version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version)='integer' AND version BETWEEN 0 AND 9007199254740990),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatching')),
  lease_until INTEGER CHECK(lease_until IS NULL OR
    (typeof(lease_until)='integer' AND lease_until BETWEEN 0 AND 9007199254740991)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts BETWEEN 0 AND 9007199254740991),
  CHECK(typeof(id)='text' AND length(id) BETWEEN 1 AND 256 AND id NOT GLOB '*[^a-zA-Z0-9:_-]*'),
  CHECK(typeof(session_digest)='text' AND length(session_digest)=71 AND substr(session_digest,1,7)='sha256:'
    AND substr(session_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(typeof(payload)='text' AND length(payload) BETWEEN 1 AND 65536),
  CHECK((status='pending' AND lease_until IS NULL)
    OR (status='dispatching' AND lease_until IS NOT NULL))
);
CREATE INDEX shared_auth_revocations_due
  ON shared_auth_revocations(status,next_attempt_at,lease_until,id);
CREATE INDEX shared_auth_revocations_session
  ON shared_auth_revocations(session_digest,id);
CREATE TRIGGER shared_auth_revocations_no_replace_before_insert
BEFORE INSERT ON shared_auth_revocations
WHEN EXISTS(SELECT 1 FROM shared_auth_revocations WHERE id=NEW.id)
BEGIN SELECT RAISE(IGNORE); END;

-- queueRevocation intentionally supports an absent session row, so this outbox
-- has no FK to shared_auth_sessions. Its retry state follows the store's CAS.
CREATE TRIGGER shared_auth_revocations_update_guard BEFORE UPDATE ON shared_auth_revocations
WHEN NEW.id IS NOT OLD.id
  OR NEW.session_digest IS NOT OLD.session_digest
  OR NEW.payload IS NOT OLD.payload
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version<>OLD.version+1
  OR NOT (
    (OLD.status='pending' AND NEW.status='dispatching'
      AND NEW.next_attempt_at=OLD.next_attempt_at
      AND NEW.attempts=OLD.attempts+1 AND NEW.lease_until IS NOT NULL)
    OR (OLD.status='dispatching' AND NEW.status='dispatching'
      AND NEW.next_attempt_at=OLD.next_attempt_at
      AND NEW.attempts=OLD.attempts+1 AND NEW.lease_until IS NOT NULL)
    OR (OLD.status='dispatching' AND NEW.status='pending'
      AND NEW.attempts=OLD.attempts AND NEW.lease_until IS NULL)
  )
BEGIN SELECT RAISE(ABORT,'Shared auth revocation lifecycle changed'); END;
`;
