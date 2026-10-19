/** Plain build/install DATA. Actual selection stays in the owning builder and
 * runtime origin, which compare this tuple with the real code-selected profile. */
export interface Auth103NativeRpProfile {
  readonly environment: string;
  readonly issuer: string;
  readonly publicOrigin: string;
  readonly consoleOrigin: string;
  readonly clientId: string;
}

export interface Auth103NativeRpRegistration {
  readonly registrationRef: string;
  readonly registrationDigest: `sha256:${string}`;
  readonly receiptRef: string;
  readonly issuerSourceRef: string;
  readonly configDigest: string;
  readonly profile: Auth103NativeRpProfile;
}

/** Internal build/install data. Parsing this shape grants no authority. */
export interface Auth103NativeSourceManifest {
  readonly version: 1;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly authSchemaRef: string;
  readonly catalogDigest: string;
  readonly catalogProjection: readonly (readonly [string, string, string])[];
  readonly registrationRef: string;
  readonly recipeDigest: string;
  readonly clockSourceDigest: string;
  readonly clockPolicyRef: string;
  readonly rpRegistration: Auth103NativeRpRegistration;
}

export const AUTH103_NATIVE_DEFINE = "__TAKOSERVER_AUTH103_NATIVE_SOURCE__";
export const AUTH103_NATIVE_PROFILE_DEFINE = "__TAKOSERVER_AUTH103_NATIVE_PROFILE__";
export const AUTH103_NATIVE_PROFILE = "root-shared-auth-staging-v1";
export const AUTH103_NATIVE_MIGRATIONS = Object.freeze([
  "0101_v2_container_owner.sql",
  "0102_v2_worker_native_identity.sql",
  "0103_auth_authority.sql",
]);

/** Same ordered projection in the source compiler and the original primary. */
export const AUTH103_NATIVE_CATALOG_QUERY = `SELECT type, name, tbl_name, sql
FROM main.sqlite_schema WHERE tbl_name IN (
  'principals', 'auth_tokens', 'auth_principal_incarnations',
  'shared_principal_bindings', 'credential_authority_classes',
  'shared_auth_sessions', 'auth103_native_source_registration',
  'auth103_native_deployments', 'auth103_native_deployment_receipts',
  'auth103_native_rp_registrations', 'auth103_native_rp_registration_receipts',
  'tf_v2_container_instances', 'tf_v2_container_acceptances', 'tf_v2_container_revisions',
  'tf_v2_container_create_claims', 'tf_v2_container_start_attempts',
  'tf_v2_worker_native_deletions'
) OR name = 'personal_organizations_owner_insert'
ORDER BY type COLLATE BINARY, name COLLATE BINARY`;

/** Canonical103 table ownership is closed over ALL of each owned table's
 * schema objects. Only unrelated later tables remain outside this identity.
 * The isolated predecessor trigger is still selected by its exact tuple. */
export const AUTH103_NATIVE_PROJECTED_CATALOG_QUERY = `SELECT s.type, s.name, s.tbl_name, s.sql
FROM main.sqlite_schema s
WHERE EXISTS (
  SELECT 1 FROM json_each(?) owned
  WHERE (json_extract(owned.value,'$[0]')='table'
    AND s.tbl_name=json_extract(owned.value,'$[2]'))
    OR (s.type=json_extract(owned.value,'$[0]')
      AND s.name=json_extract(owned.value,'$[1]')
      AND s.tbl_name=json_extract(owned.value,'$[2]'))
)
ORDER BY s.type COLLATE BINARY, s.name COLLATE BINARY`;

export const AUTH103_NATIVE_REGISTRATION_QUERY = `SELECT registration_ref,
recipe_digest, clock_source_digest, clock_policy_ref
FROM main.auth103_native_source_registration ORDER BY registration_ref COLLATE BINARY`;

/** Final same-read catalog+registration check after the digest await. */
export const AUTH103_NATIVE_CURRENT_REGISTRATION_QUERY = `SELECT registration_ref,
recipe_digest, clock_source_digest, clock_policy_ref
FROM main.auth103_native_source_registration
WHERE NOT EXISTS (
  WITH expected AS MATERIALIZED (SELECT value FROM json_each(?))
  SELECT 1 FROM expected LEFT JOIN main.sqlite_schema actual
  ON actual.type=json_extract(expected.value,'$.type')
    AND actual.name=json_extract(expected.value,'$.name')
    AND actual.tbl_name=json_extract(expected.value,'$.tbl_name')
  WHERE actual.name IS NULL OR actual.sql IS NOT json_extract(expected.value,'$.sql')
  UNION ALL
  SELECT 1 FROM main.sqlite_schema actual
  WHERE EXISTS (SELECT 1 FROM expected owner
    WHERE json_extract(owner.value,'$.type')='table'
      AND actual.tbl_name=json_extract(owner.value,'$.tbl_name'))
    AND NOT EXISTS (SELECT 1 FROM expected owned
      WHERE actual.type=json_extract(owned.value,'$.type')
        AND actual.name=json_extract(owned.value,'$.name')
        AND actual.tbl_name=json_extract(owned.value,'$.tbl_name'))
) ORDER BY registration_ref COLLATE BINARY`;

/** Five fixed binds; the origin owner supplies them from its validated original. */
export const AUTH103_NATIVE_CURRENT_PREDICATE = `EXISTS (
SELECT 1 FROM main.auth103_native_source_registration registration
WHERE registration.registration_ref=? AND registration.recipe_digest=?
  AND registration.clock_source_digest=? AND registration.clock_policy_ref=?
  AND (SELECT count(*) FROM main.auth103_native_source_registration)=1
  AND NOT EXISTS (
    WITH expected AS MATERIALIZED (SELECT value FROM json_each(?))
    SELECT 1 FROM expected LEFT JOIN main.sqlite_schema actual
    ON actual.type=json_extract(expected.value,'$.type')
      AND actual.name=json_extract(expected.value,'$.name')
      AND actual.tbl_name=json_extract(expected.value,'$.tbl_name')
    WHERE actual.name IS NULL OR actual.sql IS NOT json_extract(expected.value,'$.sql')
    UNION ALL
    SELECT 1 FROM main.sqlite_schema actual
    WHERE EXISTS (SELECT 1 FROM expected owner
      WHERE json_extract(owner.value,'$.type')='table'
        AND actual.tbl_name=json_extract(owner.value,'$.tbl_name'))
      AND NOT EXISTS (SELECT 1 FROM expected owned
        WHERE actual.type=json_extract(owned.value,'$.type')
          AND actual.name=json_extract(owned.value,'$.name')
          AND actual.tbl_name=json_extract(owned.value,'$.tbl_name'))
  )
)`;

export const AUTH103_NATIVE_REGISTRATION_DDL = `
CREATE TABLE auth103_native_source_registration (
  registration_ref TEXT PRIMARY KEY NOT NULL,
  recipe_digest TEXT NOT NULL,
  clock_source_digest TEXT NOT NULL,
  clock_policy_ref TEXT NOT NULL,
  CHECK(length(registration_ref)=71 AND substr(registration_ref,1,7)='sha256:'
    AND substr(registration_ref,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(recipe_digest)=71 AND substr(recipe_digest,1,7)='sha256:'
    AND substr(recipe_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(clock_source_digest)=71 AND substr(clock_source_digest,1,7)='sha256:'
    AND substr(clock_source_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(clock_policy_ref)=71 AND substr(clock_policy_ref,1,7)='sha256:'
    AND substr(clock_policy_ref,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER auth103_native_source_registration_no_replace
BEFORE INSERT ON auth103_native_source_registration
WHEN EXISTS(SELECT 1 FROM auth103_native_source_registration)
BEGIN SELECT RAISE(ABORT, 'immutable Auth103 source registration'); END;
CREATE TRIGGER auth103_native_source_registration_no_update
BEFORE UPDATE ON auth103_native_source_registration
BEGIN SELECT RAISE(ABORT, 'immutable Auth103 source registration'); END;
CREATE TRIGGER auth103_native_source_registration_no_delete
BEFORE DELETE ON auth103_native_source_registration
BEGIN SELECT RAISE(ABORT, 'immutable Auth103 source registration'); END;
`;

/** Environment-scoped originals are installed from the sealed owning build,
 * never embedded as an environment-specific canonical migration. */
const deploymentTables = `
CREATE TABLE auth103_native_deployments (
  deployment_ref TEXT PRIMARY KEY NOT NULL,
  target_ref TEXT NOT NULL, source_ref TEXT NOT NULL, artifact_digest TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  UNIQUE(target_ref,source_ref,artifact_digest),
  CHECK(json_type(record_json)='object'),
  CHECK(json_extract(record_json,'$.manifest.targetRef') IS target_ref),
  CHECK(json_extract(record_json,'$.manifest.sourceRef') IS source_ref),
  CHECK(json_extract(record_json,'$.artifactDigest') IS artifact_digest)
);
CREATE TABLE auth103_native_deployment_receipts (
  receipt_ref TEXT PRIMARY KEY NOT NULL,
  deployment_ref TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(deployment_ref) REFERENCES auth103_native_deployments(deployment_ref) ON DELETE RESTRICT
);
CREATE TABLE auth103_native_rp_registrations (
  registration_ref TEXT PRIMARY KEY NOT NULL,
  registration_digest TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  CHECK(json_extract(record_json,'$.registrationRef') IS registration_ref),
  CHECK(json_extract(record_json,'$.registrationDigest') IS registration_digest)
);
CREATE TABLE auth103_native_rp_registration_receipts (
  receipt_ref TEXT PRIMARY KEY NOT NULL,
  registration_ref TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(registration_ref) REFERENCES auth103_native_rp_registrations(registration_ref) ON DELETE RESTRICT
);
`;
const immutable = [
  ["auth103_native_deployments", "deployment_ref"],
  ["auth103_native_deployment_receipts", "receipt_ref"],
  ["auth103_native_rp_registrations", "registration_ref"],
  ["auth103_native_rp_registration_receipts", "receipt_ref"],
] as const;
export const AUTH103_NATIVE_INSTALL_DDL =
  deploymentTables +
  immutable
    .map(
      ([table, key]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${key}=NEW.${key})
BEGIN SELECT RAISE(ABORT,'immutable Auth103 installation original'); END;
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT,'immutable Auth103 installation original'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT,'immutable Auth103 installation original'); END;
`,
    )
    .join("") +
  `
CREATE TRIGGER auth103_native_deployment_receipts_match
BEFORE INSERT ON auth103_native_deployment_receipts
WHEN NOT EXISTS(SELECT 1 FROM auth103_native_deployments original
 WHERE original.deployment_ref=NEW.deployment_ref AND original.record_json=NEW.record_json
 AND json_extract(original.record_json,'$.receiptRef')=NEW.receipt_ref
 AND EXISTS(SELECT 1 FROM auth103_native_rp_registrations rp
 JOIN auth103_native_rp_registration_receipts receipt
 ON receipt.registration_ref=rp.registration_ref AND receipt.record_json=rp.record_json
 AND receipt.receipt_ref=json_extract(rp.record_json,'$.receiptRef')
 WHERE rp.registration_ref=json_extract(original.record_json,'$.manifest.rpRegistration.registrationRef')
 AND rp.registration_digest=json_extract(original.record_json,'$.manifest.rpRegistration.registrationDigest')
 AND rp.record_json=json_extract(original.record_json,'$.rpRecordJson')))
BEGIN SELECT RAISE(ABORT,'Auth103 deployment receipt mismatch'); END;
CREATE TRIGGER auth103_native_rp_registration_receipts_match
BEFORE INSERT ON auth103_native_rp_registration_receipts
WHEN NOT EXISTS(SELECT 1 FROM auth103_native_rp_registrations original
 WHERE original.registration_ref=NEW.registration_ref AND original.record_json=NEW.record_json
 AND json_extract(original.record_json,'$.receiptRef')=NEW.receipt_ref)
BEGIN SELECT RAISE(ABORT,'Auth103 RP registration receipt mismatch'); END;
`;

export const AUTH103_NATIVE_DEPLOYMENT_QUERY = `SELECT original.deployment_ref,
original.target_ref, original.source_ref, original.artifact_digest, original.record_json,
receipt.receipt_ref FROM auth103_native_deployments original
JOIN auth103_native_deployment_receipts receipt ON receipt.deployment_ref=original.deployment_ref
 AND receipt.record_json=original.record_json
 AND receipt.receipt_ref=json_extract(original.record_json,'$.receiptRef')
WHERE original.target_ref=? AND original.source_ref=? AND original.artifact_digest=?`;

export const AUTH103_NATIVE_RP_REGISTRATION_QUERY = `SELECT original.registration_ref,
original.registration_digest, original.record_json, receipt.receipt_ref
FROM auth103_native_rp_registrations original
JOIN auth103_native_rp_registration_receipts receipt ON receipt.registration_ref=original.registration_ref
 AND receipt.record_json=original.record_json
 AND receipt.receipt_ref=json_extract(original.record_json,'$.receiptRef')
WHERE original.registration_ref=? AND original.registration_digest=?`;

/** Appended to the same mandatory native predicate; five additional fixed binds. */
export const AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE = `EXISTS (
SELECT 1 FROM auth103_native_deployments original
JOIN auth103_native_deployment_receipts receipt ON receipt.deployment_ref=original.deployment_ref
 AND receipt.record_json=original.record_json
 AND receipt.receipt_ref=json_extract(original.record_json,'$.receiptRef')
WHERE original.deployment_ref=? AND original.record_json=?
) AND EXISTS (
SELECT 1 FROM auth103_native_rp_registrations original
JOIN auth103_native_rp_registration_receipts receipt ON receipt.registration_ref=original.registration_ref
 AND receipt.record_json=original.record_json
 AND receipt.receipt_ref=json_extract(original.record_json,'$.receiptRef')
WHERE original.registration_ref=? AND original.registration_digest=? AND original.record_json=?
)`;

/** Stable internal row encoding; this data helper is not a registration factory. */
export function auth103RpRegistrationRecord(manifest: Auth103NativeSourceManifest) {
  return {
    ...manifest.rpRegistration,
    targetRef: manifest.targetRef,
    authSchemaRef: manifest.authSchemaRef,
    clockPolicyRef: manifest.clockPolicyRef,
  };
}
