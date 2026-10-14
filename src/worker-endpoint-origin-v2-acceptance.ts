import { canonicalJson } from "./json.ts";
import type { JsonObject, Sql, SqlParam, SqlStatement } from "./ports.ts";
import type { SharedAppAssignment, SharedAppLedger } from "./shared-app-ledger.ts";
import { normalizeSharedAppName } from "./shared-app-name.ts";
import {
  prepareV2HostAcceptance,
  type V2HostAcceptance,
  type V2HostAcceptanceContext,
  type V2HostAcceptanceScope,
  type V2PreparedHostAcceptance,
} from "./takoform-v2/host-acceptance.ts";
import { isV2FormUrl } from "./takoform-v2/identity.ts";

const names = "shared_app_staging_names";
const assignments = "shared_app_staging_assignments";
const bindings = "shared_app_staging_endpoint_bindings";
const constructorKey = Symbol("fixed staging Endpoint binding compiler");

interface Scope {
  readonly formUrl: string;
  readonly backendId: string;
  readonly targetKey: string;
}

function hostname(name: string): string {
  if (normalizeSharedAppName(name) !== name)
    throw new TypeError("shared Endpoint name must already be canonical");
  return `${name}.app-staging.takos.jp`;
}

function address(name: string): JsonObject {
  const selectedHostname = hostname(name);
  return Object.freeze({ hostname: selectedHostname, url: `https://${selectedHostname}/` });
}

function statement(sql: string, params: readonly SqlParam[]): SqlStatement {
  if (params.length > 100) throw new TypeError("Endpoint binding parameter limit");
  return Object.freeze({ sql, params: Object.freeze([...params]) });
}

function current(claim: SharedAppAssignment | null): SqlStatement {
  if (claim === null) return statement("0", []);
  return statement(
    `EXISTS (SELECT 1 FROM ${assignments} a JOIN ${names} n
      ON n.normalized_name = a.name AND n.incarnation = a.incarnation
        AND n.generation = a.generation AND n.state = a.state
      WHERE a.organization_id = ? AND a.product = 'takoserver' AND a.reservation_id = ?
        AND a.name = ? AND a.incarnation = ? AND a.generation = ?
        AND a.state = ? AND a.script IS ? AND a.released_at IS NULL
        AND n.released_at IS NULL)`,
    [
      claim.organizationId,
      claim.reservationId,
      claim.name,
      claim.incarnation,
      claim.generation,
      claim.state,
      claim.script,
    ],
  );
}

function priorBinding(
  context: V2HostAcceptanceContext,
  claim: SharedAppAssignment | null,
): SqlStatement {
  if (claim === null) return statement("0", []);
  if (context.action === "create")
    return statement(`NOT EXISTS (SELECT 1 FROM ${bindings} WHERE incarnation = ?)`, [
      claim.incarnation,
    ]);
  return statement(
    `EXISTS (SELECT 1 FROM ${bindings} b JOIN tf_v2_resources r
      ON r.uid = b.endpoint_uid AND r.generation = b.endpoint_generation
        AND r.last_operation = b.current_operation_id
      WHERE b.incarnation = ? AND b.organization_id = ? AND b.product = 'takoserver'
        AND b.reservation_id = ? AND b.name = ? AND b.endpoint_uid = ?
        AND b.endpoint_generation = ? AND b.form_url = ? AND b.backend_id = ?
        AND b.target_key = ? AND r.principal = ? AND r.space = ?
        AND r.deleted_at IS NULL)`,
    [
      claim.incarnation,
      claim.organizationId,
      claim.reservationId,
      claim.name,
      context.resourceUid,
      context.generation - 1,
      context.form,
      context.backendId,
      context.targetKey,
      context.principal,
      context.space,
    ],
  );
}

function accepted(context: V2HostAcceptanceContext): SqlStatement {
  const clauses = [
    `r.uid = ? AND r.principal = ? AND r.form_url = ? AND r.space = ? AND r.name = ?
      AND r.generation = ? AND r.backend_id = ? AND r.target_key = ?
      AND r.spec_json = ? AND r.output_json = ? AND r.last_operation = ?
      AND r.busy_operation = ? AND r.deleted_at IS NULL AND r.phase = 'pending'
      AND r.active_name = r.name
      AND o.id = ? AND o.resource_uid = r.uid AND o.principal = r.principal
      AND o.replay_key = ? AND o.request_fingerprint = ? AND o.action = ?
      AND o.generation = r.generation AND o.status = 'queued' AND o.effect = 'none'
      AND o.created_at = ? AND o.updated_at = ? AND o.retain_until = ?
      AND o.backend_id = r.backend_id AND o.target_key = r.target_key
      AND o.backend_key = o.id AND o.accepted_spec_json = r.spec_json
      AND o.private_inputs_present = ?`,
  ];
  const params: SqlParam[] = [
    context.resourceUid,
    context.principal,
    context.form,
    context.space,
    context.name,
    context.generation,
    context.backendId,
    context.targetKey,
    context.specJson,
    context.outputJson,
    context.operationId,
    context.operationId,
    context.operationId,
    context.key,
    context.fingerprint,
    context.action,
    context.at,
    context.at,
    context.retainUntil,
    context.privateInputs ? 1 : 0,
  ];
  const sealed = context.privateInputs;
  if (sealed) {
    clauses.push(`EXISTS (SELECT 1 FROM tf_v2_private_inputs p WHERE p.operation_id = o.id
      AND p.names_json = ? AND p.comparison_key_id = ? AND p.comparison_tag = ?
      AND p.transfer_key_id = ? AND p.transfer_nonce = ? AND p.transfer_ciphertext = ?
      AND p.transfer_expires_at_ms = ?)`);
    params.push(
      sealed.namesJson,
      sealed.comparisonKeyId,
      sealed.comparisonTag,
      sealed.transferKeyId,
      sealed.transferNonce,
      sealed.transferCiphertext,
      sealed.transferExpiresAtMs,
    );
  }
  const configured = context.configuredPrivateInputs;
  if (configured) {
    clauses.push(`EXISTS (SELECT 1 FROM tf_v2_configured_private_inputs p
      WHERE p.resource_uid = r.uid AND p.key_id = ? AND p.nonce = ? AND p.ciphertext = ?)`);
    params.push(configured.keyId, configured.nonce, configured.ciphertext);
  }
  if (context.referencesJson !== null) {
    clauses.push(`EXISTS (SELECT 1 FROM tf_v2_operation_reference_sets s
      WHERE s.operation_id = o.id AND s.sealed = 1)
      AND (SELECT count(*) FROM tf_v2_operation_references WHERE operation_id = o.id)
        = json_array_length(?)
      AND NOT EXISTS (SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
        FROM tf_v2_operation_references WHERE operation_id = o.id
        EXCEPT SELECT json_extract(value, '$.resourceUid'), json_extract(value, '$.formUrl'),
          json_extract(value, '$.readiness'), json_extract(value, '$.targetSpecPath'),
          json_extract(value, '$.targetSpecEquals') FROM json_each(?))`);
    params.push(context.referencesJson, context.referencesJson);
  }
  return statement(
    `SELECT r.uid FROM tf_v2_resources r JOIN tf_v2_operations o ON o.id = r.last_operation
      WHERE ${clauses.join(" AND ")}`,
    params,
  );
}

function compile(
  sql: Sql,
  context: V2HostAcceptanceContext,
  claim: SharedAppAssignment | null,
): V2PreparedHostAcceptance {
  const held = current(claim);
  const prior = priorBinding(context, claim);
  const proof = accepted(context);
  // UPDATE's Resource mutation already advanced its generation/last_operation.
  // Check the prior binding independently here, without rejoining the old Resource.
  const bindingProof =
    context.action === "create"
      ? prior
      : statement(
          `EXISTS (SELECT 1 FROM ${bindings} WHERE incarnation = ? AND endpoint_uid = ?
          AND endpoint_generation = ? AND organization_id = ? AND reservation_id = ?
          AND form_url = ? AND backend_id = ? AND target_key = ?)`,
          [
            claim?.incarnation ?? null,
            context.resourceUid,
            context.generation - 1,
            context.space,
            claim?.reservationId ?? null,
            context.form,
            context.backendId,
            context.targetKey,
          ],
        );
  const originalCreate =
    context.action === "create"
      ? { sql: "?", params: [context.operationId] }
      : {
          sql: `(SELECT create_operation_id FROM ${bindings}
          WHERE incarnation = ? AND endpoint_uid = ? AND endpoint_generation = ?)`,
          params: [claim?.incarnation ?? null, context.resourceUid, context.generation - 1],
        };
  const terminal = statement(
    `INSERT INTO ${bindings}
      (incarnation, organization_id, product, reservation_id, name, endpoint_uid,
       endpoint_generation, form_url, backend_id, target_key, create_operation_id, current_operation_id)
      SELECT ?, ?, 'takoserver', ?, ?,
        (SELECT uid FROM (${proof.sql}) WHERE (${held.sql}) AND (${bindingProof.sql})),
        ?, ?, ?, ?, ${originalCreate.sql}, ?
      WHERE EXISTS (SELECT 1 FROM host_form_admission)
        OR EXISTS (SELECT 1 FROM tf_v2_resources WHERE uid = ?
          AND (last_operation = ? OR busy_operation = ?))
        OR EXISTS (SELECT 1 FROM tf_v2_operations WHERE id = ?)
      ON CONFLICT(incarnation) DO UPDATE SET endpoint_uid = excluded.endpoint_uid,
        endpoint_generation = excluded.endpoint_generation,
        current_operation_id = excluded.current_operation_id`,
    [
      claim?.incarnation ?? null,
      context.space,
      claim?.reservationId ?? null,
      context.name,
      ...(proof.params ?? []),
      ...(held.params ?? []),
      ...(bindingProof.params ?? []),
      context.generation,
      context.form,
      context.backendId,
      context.targetKey,
      ...originalCreate.params,
      context.operationId,
      context.resourceUid,
      context.operationId,
      context.operationId,
      context.operationId,
    ],
  );
  return prepareV2HostAcceptance(
    sql,
    context,
    statement(`(${held.sql}) AND (${prior.sql})`, [
      ...(held.params ?? []),
      ...(prior.params ?? []),
    ]),
    terminal,
  );
}

class OriginAcceptance implements V2HostAcceptance {
  readonly #sql: Sql;
  readonly #ledger: SharedAppLedger;
  readonly #scope: Scope;

  constructor(key: symbol, options: Scope & { sql: Sql; ledger: SharedAppLedger }) {
    if (key !== constructorKey) throw new TypeError("invalid Endpoint acceptance issuer");
    const { sql, ledger, formUrl, backendId, targetKey } = options;
    if (
      !isV2FormUrl(formUrl) ||
      typeof backendId !== "string" ||
      !backendId ||
      typeof targetKey !== "string" ||
      !targetKey ||
      targetKey.length > 255 ||
      !sql ||
      typeof sql.query !== "function" ||
      typeof sql.run !== "function" ||
      typeof sql.batch !== "function" ||
      !ledger ||
      typeof ledger.forTrustedOwner !== "function"
    )
      throw new TypeError("invalid exact Endpoint acceptance scope");
    this.#sql = sql;
    this.#ledger = ledger;
    this.#scope = Object.freeze({ formUrl, backendId, targetKey });
    Object.freeze(this);
  }

  assertSql(sql: Sql): void {
    if (sql !== this.#sql) throw new TypeError("Endpoint acceptance requires the same atomic Sql");
  }

  #selected(scope: V2HostAcceptanceScope): boolean {
    return (
      scope.form === this.#scope.formUrl &&
      scope.backendId === this.#scope.backendId &&
      scope.targetKey === this.#scope.targetKey
    );
  }

  initialOutput(scope: V2HostAcceptanceScope): JsonObject | undefined {
    return this.#selected(scope) ? address(scope.name) : undefined;
  }

  prepare(context: V2HostAcceptanceContext): Promise<V2PreparedHostAcceptance> | undefined {
    if (!this.#selected(context)) return undefined;
    return this.#prepare(context);
  }

  async #prepare(context: V2HostAcceptanceContext): Promise<V2PreparedHostAcceptance> {
    const organizationId = context.principal.startsWith("org:") ? context.principal.slice(4) : "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(organizationId) ||
      context.space !== organizationId ||
      context.outputJson !== canonicalJson(address(context.name))
    )
      throw new TypeError("Endpoint acceptance requires exact direct Organization context");
    // Only lookup an already held original. This receiver never allocates or changes route generation.
    const rows = await this.#sql.query(
      `SELECT a.reservation_id FROM ${assignments} a JOIN ${names} n
        ON n.normalized_name = a.name AND n.incarnation = a.incarnation
          AND n.generation = a.generation AND n.state = a.state
        WHERE a.organization_id = ? AND a.product = 'takoserver' AND a.name = ?
          AND a.state IN ('reserved', 'active') AND a.released_at IS NULL
          AND n.released_at IS NULL LIMIT 2`,
      [organizationId, context.name],
    );
    if (rows.length > 1) throw new TypeError("ambiguous original Endpoint reservation");
    const reservationId = rows[0]?.reservation_id;
    const owner = this.#ledger.forTrustedOwner({ organizationId, product: "takoserver" });
    const original =
      typeof reservationId === "string" ? await owner.readOriginal(reservationId) : null;
    const claim =
      original &&
      original.environment === "staging" &&
      original.organizationId === organizationId &&
      original.product === "takoserver" &&
      original.reservationId === reservationId &&
      original.name === context.name &&
      original.releasedAt === null &&
      (context.action === "create" ? original.state === "reserved" : original.state !== "released")
        ? Object.freeze({ ...original })
        : null;
    return compile(this.#sql, context, claim);
  }
}

Object.freeze(OriginAcceptance.prototype);
Object.freeze(OriginAcceptance);

/** Fixed, unmounted STAGING/direct-Organization compiler; no wire/TTL adoption or allocator. */
export function createWorkerEndpointOriginV2Acceptance(
  options: Scope & { readonly sql: Sql; readonly ledger: SharedAppLedger },
): V2HostAcceptance {
  return new OriginAcceptance(constructorKey, options);
}
