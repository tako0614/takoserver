import type { Clock, Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import { SqlError } from "./ports.ts";
import { normalizeSharedAppName } from "./shared-app-name.ts";

const LEGACY_COLUMNS = [
  "organization_id",
  "reservation_id",
  "reservation_format",
  "legacy_space",
  "legacy_worker_name",
  "legacy_endpoint_name",
  "requested_subdomain",
  "canonical_public_origin",
  "provider_pack_ref",
  "provider_installation_ref",
  "offering_id",
  "offering_digest",
  "requested_ttl_seconds",
  "expires_at",
  "state",
  "revision",
  "bound_space",
  "bound_worker_name",
  "worker_resource_uid",
  "worker_resource_revision",
  "bound_endpoint_name",
  "endpoint_resource_uid",
  "endpoint_resource_revision",
  "created_at",
  "updated_at",
  "released_at",
] as const;
const exactLegacy = (alias: "OLD" | "NEW", json: "before_json" | "after_json") =>
  `json_array(${LEGACY_COLUMNS.map(
    (column) => `json_extract(w.${json},'$.${column}') IS ${alias}.${column}`,
  ).join(",")})='[${LEGACY_COLUMNS.map(() => "1").join(",")}]'`;

// 0035 v1 has no requested_subdomain. Match the exact staging Host authority,
// including the web schemes, ASCII Host case, one root dot and a numeric port.
// A longer hostname or a path is never an alias for this allocated DNS name.
const legacyOriginForName = (origin: string, name: string): string => {
  const source = `lower(${origin})`;
  const host = `(${name} || '.app-staging.takos.jp')`;
  const bases = ["'http://'", "'https://'"].flatMap((scheme) => [
    `(${scheme} || ${host})`,
    `(${scheme} || ${host} || '.')`,
  ]);
  return `(${bases
    .map((base) => {
      const port = `substr(${source},length(${base})+2)`;
      return `(${source}=${base} OR
        (substr(${source},1,length(${base})+1)=${base} || ':'
          AND length(${source})>length(${base})+1
          AND ${port} NOT GLOB '*[^0-9]*'
          AND CAST(${port} AS INTEGER) BETWEEN 0 AND 65535))`;
    })
    .join(" OR ")})`;
};

/** Source candidate for the reserved 0107 slot. It is deliberately unregistered and unapplied. */
export const SHARED_APP_STAGING_PHYSICAL_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE shared_app_staging_assignments (
    incarnation TEXT PRIMARY KEY CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
    organization_id TEXT NOT NULL, product TEXT NOT NULL CHECK(product IN ('takoserver','takosumi-hosted')),
    reservation_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
    state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
    script TEXT, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    binding_kind TEXT, binding_json TEXT,
    UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at),
    CHECK((state='released')=(released_at IS NOT NULL)),
    CHECK(released_at IS NULL OR released_at>=created_at),
    CHECK((binding_kind IS NULL AND binding_json IS NULL
      AND (state<>'reserved' OR script IS NULL) AND (state<>'active' OR script IS NOT NULL))
      OR (binding_kind IS 'form-v2@1' AND script IS NULL
        AND ((state IN ('reserved','released') AND binding_json IS NULL)
          OR (state='active' AND binding_json IS NOT NULL AND json_valid(binding_json)=1))))
  )`,
  `CREATE TABLE shared_app_staging_names (
    normalized_name TEXT PRIMARY KEY CHECK(length(normalized_name) BETWEEN 3 AND 32
      AND normalized_name NOT GLOB '*[^a-z0-9-]*'),
    incarnation TEXT NOT NULL REFERENCES shared_app_staging_assignments(incarnation),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
    state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
    released_at INTEGER, updated_at INTEGER NOT NULL,
    CHECK((state='released')=(released_at IS NOT NULL))
  )`,
  `CREATE TABLE shared_app_staging_route_commands (
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL, name TEXT NOT NULL,
    incarnation TEXT NOT NULL REFERENCES shared_app_staging_assignments(incarnation),
    action TEXT NOT NULL CHECK(action IN ('activate','advance','retire')), command_ref TEXT NOT NULL,
    prior_generation INTEGER NOT NULL, prior_state TEXT NOT NULL, prior_script TEXT, next_script TEXT,
    endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL, worker_uid TEXT NOT NULL,
    deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL, source_operation_id TEXT NOT NULL,
    provider_id TEXT NOT NULL, target_key TEXT NOT NULL, next_generation INTEGER NOT NULL,
    next_state TEXT NOT NULL, created_at INTEGER NOT NULL, form_v2_original_json TEXT,
    PRIMARY KEY(organization_id,command_ref), UNIQUE(incarnation,next_generation),
    CHECK(next_generation=prior_generation+1), CHECK(next_generation BETWEEN 2 AND 9007199254740990),
    CHECK((form_v2_original_json IS NULL
      AND ((action='activate' AND prior_state='reserved' AND prior_script IS NULL)
        OR (action<>'activate' AND prior_state='active' AND prior_script IS NOT NULL))
      AND ((action='retire' AND next_state='reserved' AND next_script IS NULL)
        OR (action<>'retire' AND next_state='active' AND next_script IS NOT NULL)))
      OR (form_v2_original_json IS NOT NULL AND CASE WHEN json_valid(form_v2_original_json)=1 THEN
        json_type(form_v2_original_json) IS 'object'
        AND json_extract(form_v2_original_json,'$.action') IS action
        AND ((action='activate' AND prior_state='reserved') OR (action<>'activate' AND prior_state='active'))
        AND ((json_extract(form_v2_original_json,'$.expected.kind') IS 'scalar'
          AND json_extract(form_v2_original_json,'$.expected.value.script') IS prior_script)
          OR (json_extract(form_v2_original_json,'$.expected.kind') IS 'form-v2@1' AND prior_script IS NULL))
        AND next_script IS NULL
        AND ((action='retire' AND next_state='reserved') OR (action<>'retire' AND next_state='active'))
        ELSE 0 END))
  )`,
  `CREATE TABLE shared_app_staging_batch_assertions (
    witness TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1),
    apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1))
  )`,
  `CREATE TABLE shared_app_staging_carrier_witnesses (
    witness TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('prepare','cancel')),
    organization_id TEXT NOT NULL, reservation_id TEXT NOT NULL, name TEXT NOT NULL,
    incarnation TEXT NOT NULL, generation INTEGER NOT NULL,
    before_json TEXT, after_json TEXT NOT NULL CHECK(json_valid(after_json)=1),
    CHECK(before_json IS NULL OR json_valid(before_json)=1)
  )`,
  `CREATE TABLE shared_app_staging_endpoint_bindings (
    incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL,
    name TEXT NOT NULL, endpoint_uid TEXT NOT NULL UNIQUE REFERENCES tf_v2_resources(uid),
    endpoint_generation INTEGER NOT NULL CHECK(endpoint_generation>=1),
    form_url TEXT NOT NULL, backend_id TEXT NOT NULL, target_key TEXT NOT NULL,
    create_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
    current_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id)
  )`,
  `CREATE TABLE shared_app_staging_adoptions (
    incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
    organization_id TEXT NOT NULL, reservation_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
    legacy_revision INTEGER NOT NULL CHECK(legacy_revision=1),
    legacy_expires_at INTEGER NOT NULL, adopted_at INTEGER NOT NULL,
    UNIQUE(organization_id,reservation_id),
    FOREIGN KEY(organization_id,reservation_id)
      REFERENCES worker_endpoint_origin_reservations(organization_id,reservation_id)
  )`,
  // Every old installed writer reaches the same 0035 table. This physical fence
  // applies even if that writer predates the new constructor or route command.
  `CREATE TRIGGER shared_app_staging_legacy_insert_fence BEFORE INSERT ON worker_endpoint_origin_reservations
    WHEN EXISTS (SELECT 1 FROM shared_app_staging_names n
      WHERE n.normalized_name=NEW.requested_subdomain
        OR ${legacyOriginForName("NEW.canonical_public_origin", "n.normalized_name")})
      AND NOT EXISTS (SELECT 1 FROM shared_app_staging_carrier_witnesses w
        JOIN shared_app_staging_batch_assertions b ON b.witness=w.witness AND b.ok=1 AND b.apply_effects=1
        JOIN shared_app_staging_assignments a ON a.incarnation=w.incarnation
        JOIN shared_app_staging_names n ON n.incarnation=a.incarnation AND n.normalized_name=a.name
        WHERE w.action='prepare' AND w.organization_id=NEW.organization_id
          AND w.reservation_id=NEW.reservation_id AND w.name=NEW.requested_subdomain
          AND w.incarnation=a.incarnation AND w.generation=1 AND a.generation=1 AND n.generation=1
          AND a.organization_id=NEW.organization_id AND a.reservation_id=NEW.reservation_id
          AND a.product='takoserver' AND a.state='reserved' AND n.state='reserved'
          AND a.binding_kind IS NULL AND a.binding_json IS NULL AND a.script IS NULL
          AND w.before_json IS NULL AND ${exactLegacy("NEW", "after_json")}
          AND NOT EXISTS (SELECT 1 FROM shared_app_staging_adoptions d WHERE d.incarnation=a.incarnation))
    BEGIN SELECT RAISE(ABORT,'shared staging name is held'); END`,
  `CREATE TRIGGER shared_app_staging_legacy_update_fence BEFORE UPDATE ON worker_endpoint_origin_reservations
    WHEN EXISTS (SELECT 1 FROM shared_app_staging_names n
      WHERE n.normalized_name IN (OLD.requested_subdomain,NEW.requested_subdomain)
        OR ${legacyOriginForName("OLD.canonical_public_origin", "n.normalized_name")}
        OR ${legacyOriginForName("NEW.canonical_public_origin", "n.normalized_name")})
      AND NOT EXISTS (SELECT 1 FROM shared_app_staging_carrier_witnesses w
        JOIN shared_app_staging_batch_assertions b ON b.witness=w.witness AND b.ok=1 AND b.apply_effects=1
        JOIN shared_app_staging_assignments a ON a.incarnation=w.incarnation
        JOIN shared_app_staging_names n ON n.incarnation=a.incarnation AND n.normalized_name=a.name
        WHERE w.action='cancel' AND w.organization_id=OLD.organization_id
          AND w.reservation_id=OLD.reservation_id AND w.name=OLD.requested_subdomain
          AND w.incarnation=a.incarnation AND w.generation=2 AND a.generation=2 AND n.generation=2
          AND a.organization_id=OLD.organization_id AND a.reservation_id=OLD.reservation_id
          AND a.product='takoserver' AND a.state='released' AND n.state='released'
          AND a.released_at IS NEW.released_at AND n.released_at IS NEW.released_at
          AND a.binding_kind IS NULL AND a.binding_json IS NULL AND a.script IS NULL
          AND OLD.state='prepared' AND OLD.revision=1 AND OLD.released_at IS NULL
          AND NEW.state='released' AND NEW.revision=2 AND NEW.updated_at=NEW.released_at
          AND NEW.released_at IS NOT NULL
          AND ${exactLegacy("OLD", "before_json")} AND ${exactLegacy("NEW", "after_json")}
          AND NOT EXISTS (SELECT 1 FROM shared_app_staging_adoptions d WHERE d.incarnation=a.incarnation)
          AND NOT EXISTS (SELECT 1 FROM shared_app_staging_route_commands c WHERE c.incarnation=a.incarnation)
          AND NOT EXISTS (SELECT 1 FROM shared_app_staging_endpoint_bindings e WHERE e.incarnation=a.incarnation))
    BEGIN SELECT RAISE(ABORT,'shared staging name is held'); END`,
  `CREATE TRIGGER shared_app_staging_legacy_delete_fence BEFORE DELETE ON worker_endpoint_origin_reservations
    WHEN EXISTS (SELECT 1 FROM shared_app_staging_names n
      WHERE n.normalized_name=OLD.requested_subdomain
        OR ${legacyOriginForName("OLD.canonical_public_origin", "n.normalized_name")})
    BEGIN SELECT RAISE(ABORT,'shared staging name is held'); END`,
  // New head creation refuses unadopted or multiply retained 0035 history.
  `CREATE TRIGGER shared_app_staging_name_history_fence BEFORE INSERT ON shared_app_staging_names
    WHEN EXISTS (SELECT 1 FROM worker_endpoint_origin_reservations l
      WHERE (l.requested_subdomain=NEW.normalized_name
        OR ${legacyOriginForName("l.canonical_public_origin", "NEW.normalized_name")})
        AND NOT EXISTS (SELECT 1 FROM shared_app_staging_adoptions a
          WHERE a.incarnation=NEW.incarnation AND a.organization_id=l.organization_id
            AND a.reservation_id=l.reservation_id AND a.name=NEW.normalized_name))
    BEGIN SELECT RAISE(ABORT,'unadopted staging history'); END`,
  `CREATE TRIGGER shared_app_staging_adoption_original_fence BEFORE INSERT ON shared_app_staging_adoptions
    WHEN NOT EXISTS (SELECT 1 FROM worker_endpoint_origin_reservations l
      WHERE l.organization_id=NEW.organization_id AND l.reservation_id=NEW.reservation_id
        AND l.requested_subdomain=NEW.name
        AND l.canonical_public_origin='https://' || NEW.name || '.app-staging.takos.jp'
        AND l.reservation_format='takoserver.worker-endpoint-origin-reservation.v2'
        AND l.state='prepared' AND l.revision=NEW.legacy_revision
        AND l.expires_at=NEW.legacy_expires_at AND l.expires_at>NEW.adopted_at
        AND l.released_at IS NULL AND l.worker_resource_uid IS NULL
        AND l.endpoint_resource_uid IS NULL)
    BEGIN SELECT RAISE(ABORT,'unverified staging original'); END`,
  `CREATE TRIGGER shared_app_staging_assignment_update_fence BEFORE UPDATE ON shared_app_staging_assignments
    WHEN NOT EXISTS (SELECT 1 FROM shared_app_staging_batch_assertions WHERE ok=1 AND apply_effects=1)
    BEGIN SELECT RAISE(ABORT,'staging route command required'); END`,
  `CREATE TRIGGER shared_app_staging_name_update_fence BEFORE UPDATE ON shared_app_staging_names
    WHEN NOT EXISTS (SELECT 1 FROM shared_app_staging_batch_assertions WHERE ok=1 AND apply_effects=1)
    BEGIN SELECT RAISE(ABORT,'staging route command required'); END`,
  `CREATE TRIGGER shared_app_staging_assignment_no_delete BEFORE DELETE ON shared_app_staging_assignments
    BEGIN SELECT RAISE(ABORT,'staging assignment retained'); END`,
  `CREATE TRIGGER shared_app_staging_name_no_delete BEFORE DELETE ON shared_app_staging_names
    BEGIN SELECT RAISE(ABORT,'staging name retained'); END`,
  `CREATE TRIGGER shared_app_staging_adoption_no_update BEFORE UPDATE ON shared_app_staging_adoptions
    BEGIN SELECT RAISE(ABORT,'staging adoption retained'); END`,
  `CREATE TRIGGER shared_app_staging_adoption_no_delete BEFORE DELETE ON shared_app_staging_adoptions
    BEGIN SELECT RAISE(ABORT,'staging adoption retained'); END`,
]);

export interface SharedAppStagingAdoptionOriginal {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly name: string;
  readonly incarnation: string;
  readonly generation: 1;
}

export class SharedAppStagingAdoptionError extends Error {
  constructor(
    readonly code: "conflict" | "unavailable" | "indeterminate",
    readonly original?: SharedAppStagingAdoptionOriginal,
  ) {
    super(code);
    this.name = "SharedAppStagingAdoptionError";
  }
}

function value(row: Row, key: (typeof LEGACY_COLUMNS)[number]): SqlParam {
  const result = row[key];
  if (result === null || typeof result === "string") return result;
  if (typeof result === "number" && Number.isSafeInteger(result)) return result;
  throw new SharedAppStagingAdoptionError("unavailable");
}

function identity(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128)
    throw new SharedAppStagingAdoptionError("conflict");
  return value;
}

/** Staging-only, never a grant or a route publication. Only an untouched original is eligible. */
export function createSharedAppStagingAdoption(options: {
  readonly sql: Sql;
  readonly clock: Clock;
}) {
  const sql = options.sql;
  const clock = options.clock;
  return Object.freeze({
    async adopt(input: { readonly organizationId: string; readonly reservationId: string }) {
      const organizationId = identity(input.organizationId);
      const reservationId = identity(input.reservationId);
      const rows = await sql.query(
        "SELECT * FROM worker_endpoint_origin_reservations WHERE organization_id=? AND reservation_id=? LIMIT 2",
        [organizationId, reservationId],
      );
      if (rows.length !== 1 || !rows[0]) throw new SharedAppStagingAdoptionError("conflict");
      const row = rows[0];
      const name = value(row, "requested_subdomain");
      if (typeof name !== "string") throw new SharedAppStagingAdoptionError("conflict");
      try {
        if (normalizeSharedAppName(name) !== name)
          throw new SharedAppStagingAdoptionError("conflict");
      } catch {
        throw new SharedAppStagingAdoptionError("conflict");
      }
      const now = clock().getTime();
      if (!Number.isSafeInteger(now) || now < 0)
        throw new SharedAppStagingAdoptionError("unavailable");
      const original: SharedAppStagingAdoptionOriginal = Object.freeze({
        organizationId,
        reservationId,
        name,
        incarnation: crypto.randomUUID().replaceAll("-", ""),
        generation: 1,
      });
      const snapshot = LEGACY_COLUMNS.map((column) => value(row, column));
      const matches = LEGACY_COLUMNS.map((column) => `l.${column} IS ?`).join(" AND ");
      const host = `https://${name}.app-staging.takos.jp`;
      const precondition = `l.organization_id=? AND l.reservation_id=? AND ${matches}
        AND l.reservation_format='takoserver.worker-endpoint-origin-reservation.v2'
        AND l.requested_subdomain=? AND l.canonical_public_origin=?
        AND l.state='prepared' AND l.revision=1 AND l.expires_at>?
        AND l.released_at IS NULL AND l.worker_resource_uid IS NULL AND l.endpoint_resource_uid IS NULL
        AND (SELECT count(*) FROM worker_endpoint_origin_reservations h
          WHERE h.requested_subdomain=? OR ${legacyOriginForName("h.canonical_public_origin", "l.requested_subdomain")})=1
        AND NOT EXISTS (SELECT 1 FROM tf_v2_resources r WHERE r.principal=? AND r.space=? AND r.name=?)
        AND NOT EXISTS (SELECT 1 FROM cloudflare_managed_worker_routes r WHERE r.route_kind='host'
          AND (r.route_key=? OR r.route_key=? OR json_extract(r.value_json,'$.hostname')=?))
        AND NOT EXISTS (SELECT 1 FROM shared_app_staging_names WHERE normalized_name=?)`;
      const preconditionParams: readonly SqlParam[] = [
        organizationId,
        reservationId,
        ...snapshot,
        name,
        host,
        now,
        name,
        `org:${organizationId}`,
        organizationId,
        name,
        `host/v2/${name}.app-staging.takos.jp`,
        `host/v1/${name}.app-staging.takos.jp`,
        `${name}.app-staging.takos.jp`,
        name,
      ];
      const exact = `d.incarnation=? AND d.organization_id=? AND d.reservation_id=? AND d.name=?
        AND d.legacy_revision=1 AND d.legacy_expires_at=? AND d.adopted_at=?`;
      const exactParams: readonly SqlParam[] = [
        original.incarnation,
        organizationId,
        reservationId,
        name,
        value(row, "expires_at"),
        now,
      ];
      const statements: readonly SqlStatement[] = [
        {
          sql: `INSERT INTO shared_app_staging_assignments
            (incarnation,name,organization_id,product,reservation_id,generation,state,script,
              released_at,created_at,updated_at,binding_kind,binding_json)
            SELECT ?,l.requested_subdomain,l.organization_id,'takoserver',l.reservation_id,1,
              'reserved',NULL,NULL,l.created_at,l.updated_at,'form-v2@1',NULL
            FROM worker_endpoint_origin_reservations l WHERE ${precondition}`,
          params: [original.incarnation, ...preconditionParams],
        },
        {
          sql: `INSERT INTO shared_app_staging_adoptions
            (incarnation,organization_id,reservation_id,name,legacy_revision,legacy_expires_at,adopted_at)
            SELECT ?,l.organization_id,l.reservation_id,l.requested_subdomain,l.revision,l.expires_at,?
            FROM worker_endpoint_origin_reservations l JOIN shared_app_staging_assignments a
              ON a.incarnation=? AND a.organization_id=l.organization_id
                AND a.reservation_id=l.reservation_id AND a.name=l.requested_subdomain
            WHERE ${precondition}`,
          params: [original.incarnation, now, original.incarnation, ...preconditionParams],
        },
        {
          sql: `INSERT INTO shared_app_staging_names
            (normalized_name,incarnation,generation,state,released_at,updated_at)
            SELECT a.name,a.incarnation,a.generation,a.state,a.released_at,a.updated_at
            FROM shared_app_staging_assignments a JOIN shared_app_staging_adoptions d
              ON d.incarnation=a.incarnation WHERE ${exact}`,
          params: exactParams,
        },
        {
          sql: `INSERT INTO shared_app_staging_batch_assertions (witness,ok,apply_effects)
            SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM shared_app_staging_adoptions d WHERE ${exact})
              AND EXISTS (SELECT 1 FROM shared_app_staging_names n WHERE n.normalized_name=?
                AND n.incarnation=? AND n.generation=1 AND n.state='reserved')
              THEN 1 ELSE 0 END,0`,
          params: [original.incarnation, ...exactParams, name, original.incarnation],
        },
        {
          sql: "DELETE FROM shared_app_staging_batch_assertions WHERE witness=?",
          params: [original.incarnation],
        },
      ];
      try {
        await sql.batch(statements);
      } catch (error) {
        try {
          const settled = await sql.query(
            "SELECT incarnation,name,legacy_revision,legacy_expires_at,adopted_at FROM shared_app_staging_adoptions WHERE organization_id=? AND reservation_id=? LIMIT 2",
            [organizationId, reservationId],
          );
          if (
            settled.length === 1 &&
            settled[0]?.incarnation === original.incarnation &&
            settled[0]?.name === name &&
            settled[0]?.legacy_revision === 1 &&
            settled[0]?.legacy_expires_at === value(row, "expires_at") &&
            settled[0]?.adopted_at === now
          )
            return original;
        } catch {
          throw new SharedAppStagingAdoptionError("indeterminate", original);
        }
        throw new SharedAppStagingAdoptionError(
          error instanceof SqlError && error.code === "constraint" ? "conflict" : "indeterminate",
          original,
        );
      }
      const settled = await sql
        .query(
          "SELECT incarnation,name,legacy_revision,legacy_expires_at,adopted_at FROM shared_app_staging_adoptions WHERE organization_id=? AND reservation_id=? LIMIT 2",
          [organizationId, reservationId],
        )
        .catch(() => {
          throw new SharedAppStagingAdoptionError("indeterminate", original);
        });
      if (
        settled.length !== 1 ||
        settled[0]?.incarnation !== original.incarnation ||
        settled[0]?.name !== name ||
        settled[0]?.legacy_revision !== 1 ||
        settled[0]?.legacy_expires_at !== value(row, "expires_at") ||
        settled[0]?.adopted_at !== now
      )
        throw new SharedAppStagingAdoptionError("indeterminate", original);
      return original;
    },
  });
}
