-- Takos ID is the legal Organization authority. Takoserver retains only the
-- product-local tenant projection and role required to authorize its own API.

CREATE TABLE principals_next (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject),
  CHECK (provider IN ('takos-id', 'google', 'github'))
);

INSERT INTO principals_next (id, provider, provider_subject, email, display_name, created_at)
SELECT id, provider, provider_subject, email, display_name, created_at FROM principals;

DROP TABLE principals;
ALTER TABLE principals_next RENAME TO principals;

CREATE TABLE org_memberships (
  org_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, principal_id),
  CHECK (role IN ('owner', 'member'))
);

INSERT INTO org_memberships (org_id, principal_id, role, created_at)
SELECT id, owner_principal_id, 'owner', created_at FROM orgs;

CREATE INDEX org_memberships_principal ON org_memberships (principal_id, org_id);
