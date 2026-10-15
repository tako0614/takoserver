import { canonicalJson } from "./json.ts";
import type { JsonObject, Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import type {
  SharedAppAssignment,
  SharedAppLedger,
  SharedAppRouteEffects,
  SharedAppRouteOriginal,
} from "./shared-app-ledger.ts";
import { normalizeSharedAppName, sharedAppStagingNameFromHost } from "./shared-app-name.ts";
import {
  prepareV2HostAcceptance,
  type V2HostAcceptance,
  type V2HostAcceptanceContext,
  type V2HostAcceptanceScope,
  type V2PreparedHostAcceptance,
} from "./takoform-v2/host-acceptance.ts";
import { isV2FormUrl } from "./takoform-v2/identity.ts";
import type { V2Execution } from "./takoform-v2/types.ts";

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

interface FailedDeleteAcceptanceGap {
  readonly admission: SqlStatement;
  readonly bindingProof: SqlStatement;
  readonly originalCreate: { readonly sql: string; readonly params: readonly SqlParam[] };
}

/** Own-row capture only; the normal adjacent binding keeps its existing compiler bytes. */
async function failedDeleteAcceptanceGap(
  sql: Sql,
  context: V2HostAcceptanceContext,
  claim: SharedAppAssignment,
): Promise<FailedDeleteAcceptanceGap | undefined> {
  const binding = await onePublicationRow(sql, `SELECT * FROM ${bindings} WHERE endpoint_uid = ?`, [
    context.resourceUid,
  ]);
  if (!binding || binding.endpoint_generation === context.generation - 1) return undefined;
  const boundGeneration = Number(binding.endpoint_generation);
  if (
    !Number.isSafeInteger(binding.endpoint_generation) ||
    boundGeneration < 1 ||
    boundGeneration >= context.generation - 1 ||
    binding.incarnation !== claim.incarnation ||
    binding.organization_id !== context.space ||
    binding.product !== "takoserver" ||
    binding.reservation_id !== claim.reservationId ||
    binding.name !== context.name ||
    binding.form_url !== context.form ||
    binding.backend_id !== context.backendId ||
    binding.target_key !== context.targetKey ||
    typeof binding.current_operation_id !== "string" ||
    typeof binding.create_operation_id !== "string"
  )
    return undefined;
  const resource = await onePublicationRow(sql, "SELECT * FROM tf_v2_resources WHERE uid = ?", [
    context.resourceUid,
  ]);
  const bound = await onePublicationRow(sql, "SELECT * FROM tf_v2_operations WHERE id = ?", [
    binding.current_operation_id,
  ]);
  if (
    !resource ||
    !bound ||
    resource.uid !== context.resourceUid ||
    resource.principal !== context.principal ||
    resource.space !== context.space ||
    resource.name !== context.name ||
    resource.form_url !== context.form ||
    resource.backend_id !== context.backendId ||
    resource.target_key !== context.targetKey ||
    resource.generation !== context.generation - 1 ||
    resource.busy_operation !== null ||
    resource.deleted_at !== null ||
    resource.phase !== "error" ||
    resource.output_json !== context.outputJson ||
    typeof resource.spec_json !== "string" ||
    typeof resource.last_operation !== "string" ||
    bound.resource_uid !== context.resourceUid ||
    bound.principal !== context.principal ||
    bound.generation !== boundGeneration ||
    bound.backend_id !== context.backendId ||
    bound.target_key !== context.targetKey ||
    bound.backend_key !== bound.id ||
    bound.accepted_spec_json !== resource.spec_json ||
    (boundGeneration === 1
      ? bound.action !== "create" || bound.id !== binding.create_operation_id
      : bound.action !== "update") ||
    (bound.status !== "succeeded" && bound.status !== "failed")
  )
    return undefined;
  const last = await onePublicationRow(sql, "SELECT * FROM tf_v2_operations WHERE id = ?", [
    resource.last_operation,
  ]);
  if (
    !last ||
    last.resource_uid !== context.resourceUid ||
    last.principal !== context.principal ||
    last.generation !== resource.generation ||
    last.action !== "delete" ||
    last.status !== "failed" ||
    last.effect !== "none" ||
    last.backend_id !== context.backendId ||
    last.target_key !== context.targetKey ||
    last.backend_key !== last.id ||
    last.accepted_spec_json !== resource.spec_json
  )
    return undefined;
  const deletions = failedEndpointOperations(
    { ...context, specJson: resource.spec_json },
    boundGeneration,
    context.generation - 1,
    "delete",
  );
  const rows = await sql.query(`SELECT 1 AS current WHERE (${deletions.sql})`, deletions.params);
  if (rows.length !== 1) return undefined;
  const immutablePrior = [
    exactPublicationRow(bindings, binding),
    exactPublicationRow("tf_v2_operations", bound),
    exactPublicationRow("tf_v2_operations", last),
    deletions,
  ];
  return Object.freeze({
    admission: conjunction([...immutablePrior, exactPublicationRow("tf_v2_resources", resource)]),
    bindingProof: conjunction(immutablePrior),
    originalCreate: Object.freeze({
      sql: `(SELECT create_operation_id FROM ${bindings}
        WHERE incarnation = ? AND endpoint_uid = ? AND endpoint_generation = ?
          AND current_operation_id = ?)`,
      params: Object.freeze([
        claim.incarnation,
        context.resourceUid,
        boundGeneration,
        binding.current_operation_id,
      ]),
    }),
  });
}

function compile(
  sql: Sql,
  context: V2HostAcceptanceContext,
  claim: SharedAppAssignment | null,
  gap?: FailedDeleteAcceptanceGap,
): V2PreparedHostAcceptance {
  const held = current(claim);
  const prior = gap?.admission ?? priorBinding(context, claim);
  const proof = accepted(context);
  // UPDATE's Resource mutation already advanced its generation/last_operation.
  // Check the prior binding independently here, without rejoining the old Resource.
  const bindingProof =
    gap?.bindingProof ??
    (context.action === "create"
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
        ));
  const originalCreate =
    gap?.originalCreate ??
    (context.action === "create"
      ? { sql: "?", params: [context.operationId] }
      : {
          sql: `(SELECT create_operation_id FROM ${bindings}
          WHERE incarnation = ? AND endpoint_uid = ? AND endpoint_generation = ?)`,
          params: [claim?.incarnation ?? null, context.resourceUid, context.generation - 1],
        });
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
    const gap =
      claim && context.action === "update"
        ? await failedDeleteAcceptanceGap(this.#sql, context, claim)
        : undefined;
    return compile(this.#sql, context, claim, gap);
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

const publicationKey = Symbol("fixed staging Endpoint publication receiver");
const nativeRoutes = "cloudflare_managed_worker_routes";
const routeHistory = "shared_app_staging_route_commands";
const hostSchema = "takoserver.v2-wfp-host-route@v1";
const workerSchema = "takoserver.v2-wfp-worker-route@v1";
const tombstoneSchema = "takoserver.managed-worker-route-tombstone@v1";
const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface PublicationScope extends Scope {
  readonly providerId: string;
}

interface PublicationExecution {
  readonly operationId: string;
  readonly resourceUid: string;
  readonly principal: string;
  readonly space: string;
  readonly name: string;
  readonly form: string;
  readonly backendId: string;
  readonly backendKey: string;
  readonly targetKey: string;
  readonly leaseToken: string;
  readonly action: V2Execution["action"];
  readonly generation: number;
  readonly specJson: string;
  readonly outputJson: string;
}

type PublicationTable =
  | "tf_v2_resources"
  | "tf_v2_operations"
  | typeof bindings
  | typeof nativeRoutes
  | typeof routeHistory;
type PublicationOwner = Pick<
  ReturnType<SharedAppLedger["forTrustedOwner"]>,
  | "readOriginal"
  | "readRouteCommand"
  | "settleRoute"
  | "prepareActivate"
  | "prepareAdvance"
  | "prepareRetire"
>;

function conjunction(parts: readonly SqlStatement[]): {
  readonly sql: string;
  readonly params: readonly (string | number | null)[];
} {
  const params = parts
    .flatMap((part) => [...(part.params ?? [])])
    .map((value) => {
      if (
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        return value;
      throw new TypeError("invalid Endpoint publication parameter");
    });
  if (params.length > 90) throw new TypeError("Endpoint publication parameter limit");
  return Object.freeze({
    sql: parts.map((part) => `(${part.sql})`).join(" AND "),
    params: Object.freeze(params),
  });
}

/** Only this receiver's own fixed-table reads reach this private compiler. */
function exactPublicationRow(table: PublicationTable, row: Row): SqlStatement {
  const columns = Object.keys(row);
  if (columns.length === 0 || columns.some((column) => !/^[a-z_][a-z_0-9]*$/u.test(column)))
    throw new TypeError("invalid Endpoint publication projection");
  return statement(
    `EXISTS (SELECT 1 FROM ${table} actual, json_each(?) expected WHERE ${columns
      .map((column) => `actual.${column} IS json_extract(expected.value, '$.${column}')`)
      .join(" AND ")})`,
    [JSON.stringify([row])],
  );
}

async function onePublicationRow(
  sql: Pick<Sql, "query">,
  query: string,
  params: readonly SqlParam[],
): Promise<Row | null> {
  const rows = await sql.query(query, params);
  if (rows.length > 1) throw new TypeError("ambiguous Endpoint publication projection");
  const row = rows[0];
  return row ? Object.freeze({ ...row }) : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nativeValue(row: Row | null): Record<string, unknown> | null {
  if (
    !row ||
    !Number.isSafeInteger(row.generation) ||
    Number(row.generation) < 1 ||
    typeof row.value_json !== "string"
  )
    return null;
  const value = object(JSON.parse(row.value_json));
  return value?.generation === row.generation ? value : null;
}

function capturePublicationExecution(execution: Readonly<V2Execution>): PublicationExecution {
  return Object.freeze({
    operationId: execution.operationId,
    resourceUid: execution.resourceUid,
    principal: execution.principal,
    space: execution.space,
    name: execution.name,
    form: execution.form,
    backendId: execution.backendId,
    backendKey: execution.backendKey,
    targetKey: execution.targetKey,
    leaseToken: execution.leaseToken,
    action: execution.action,
    generation: execution.generation,
    specJson: canonicalJson(execution.spec),
    outputJson: canonicalJson(execution.previousOutput),
  });
}

function ownsPublication(
  execution: PublicationExecution,
  resource: Row | null,
  operation: Row | null,
): resource is Row {
  return Boolean(
    resource &&
      operation &&
      resource.uid === execution.resourceUid &&
      resource.principal === execution.principal &&
      resource.space === execution.space &&
      resource.name === execution.name &&
      resource.form_url === execution.form &&
      resource.backend_id === execution.backendId &&
      resource.target_key === execution.targetKey &&
      resource.generation === execution.generation &&
      resource.last_operation === execution.operationId &&
      resource.busy_operation === execution.operationId &&
      resource.deleted_at === null &&
      resource.phase === (execution.action === "delete" ? "deleting" : "pending") &&
      resource.spec_json === execution.specJson &&
      resource.output_json === execution.outputJson &&
      operation.id === execution.operationId &&
      operation.resource_uid === execution.resourceUid &&
      operation.principal === execution.principal &&
      operation.action === execution.action &&
      operation.generation === execution.generation &&
      operation.backend_id === execution.backendId &&
      operation.target_key === execution.targetKey &&
      operation.backend_key === execution.backendKey &&
      execution.backendKey === execution.operationId &&
      operation.accepted_spec_json === execution.specJson &&
      operation.lease_token === execution.leaseToken &&
      typeof execution.leaseToken === "string" &&
      execution.leaseToken.length > 0 &&
      (operation.status === "running" || operation.status === "reconciling"),
  );
}

function sameAssignment(left: SharedAppAssignment, right: SharedAppAssignment): boolean {
  return (
    left.environment === right.environment &&
    left.organizationId === right.organizationId &&
    left.product === right.product &&
    left.reservationId === right.reservationId &&
    left.name === right.name &&
    left.incarnation === right.incarnation &&
    left.generation === right.generation &&
    left.state === right.state &&
    left.script === right.script &&
    left.releasedAt === right.releasedAt
  );
}

/** Exact accepted generations, not a guessed last-live binding or retry reference. */
function failedEndpointOperations(
  execution: Pick<
    PublicationExecution,
    "resourceUid" | "principal" | "backendId" | "targetKey" | "specJson"
  >,
  after: number,
  through: number,
  action: "update" | "delete" | "update-or-delete",
): SqlStatement {
  const count = through - after;
  if (!Number.isSafeInteger(after) || after < 1 || !Number.isSafeInteger(count) || count < 0)
    return statement("0", []);
  const range = "resource_uid = ? AND generation > ? AND generation <= ?";
  const pins = [execution.resourceUid, after, through];
  const actionPredicate =
    action === "update-or-delete" ? "action IN ('update', 'delete')" : "action = ?";
  return statement(
    `(SELECT count(*) FROM tf_v2_operations WHERE ${range}) = ?
      AND (SELECT count(DISTINCT generation) FROM tf_v2_operations WHERE ${range}) = ?
      AND NOT EXISTS (SELECT 1 FROM tf_v2_operations WHERE ${range} AND NOT (
        typeof(generation) = 'integer' AND principal = ? AND ${actionPredicate}
        AND status = 'failed' AND effect = 'none' AND backend_id = ? AND target_key = ?
        AND backend_key = id AND accepted_spec_json = ?))`,
    [
      ...pins,
      count,
      ...pins,
      count,
      ...pins,
      execution.principal,
      ...(action === "update-or-delete" ? [] : [action]),
      execution.backendId,
      execution.targetKey,
      execution.specJson,
    ],
  );
}

class OriginPublicationPreparation {
  readonly effects: SharedAppRouteEffects | undefined;
  readonly #sql: Pick<Sql, "query">;
  readonly #owner: PublicationOwner;
  readonly #claim: SharedAppAssignment;
  readonly #original: SharedAppRouteOriginal | null;
  readonly #readback: SqlStatement;
  readonly #removing: boolean;

  constructor(
    key: symbol,
    input: {
      sql: Pick<Sql, "query">;
      owner: PublicationOwner;
      claim: SharedAppAssignment;
      original: SharedAppRouteOriginal | null;
      effects?: SharedAppRouteEffects;
      readback: SqlStatement;
      removing: boolean;
    },
  ) {
    if (key !== publicationKey) throw new TypeError("invalid Endpoint publication preparation");
    this.#sql = input.sql;
    this.#owner = input.owner;
    this.#claim = input.claim;
    this.#original = input.original;
    this.#readback = input.readback;
    this.#removing = input.removing;
    this.effects = input.effects;
    Object.freeze(this);
  }

  /** Readback only, including after an unknown ACK. This method never retries a write. */
  async observe(): Promise<"confirmed" | "retired" | "unknown"> {
    try {
      const expected = this.#original
        ? (await this.#owner.settleRoute(this.#original, "unknown")).assignment
        : this.#claim;
      const now = await this.#owner.readOriginal(expected.reservationId);
      if (!now || !sameAssignment(now, expected)) return "unknown";
      const check = conjunction([current(now), this.#readback]);
      const rows = await this.#sql.query(`SELECT 1 AS current WHERE (${check.sql})`, check.params);
      return rows.length === 1 ? (this.#removing ? "retired" : "confirmed") : "unknown";
    } catch {
      return "unknown";
    }
  }
}

/** Opaque, fixed compiler output. It conveys no native send or business grant. */
export type WorkerEndpointOriginV2PublicationPreparation = OriginPublicationPreparation;

class OriginPublication {
  readonly #sql: Sql;
  readonly #reads: Pick<Sql, "query">;
  readonly #scope: PublicationScope;
  readonly #owner: SharedAppLedger["forTrustedOwner"];

  constructor(
    key: symbol,
    options: PublicationScope & { readonly sql: Sql; readonly ledger: SharedAppLedger },
  ) {
    if (key !== publicationKey) throw new TypeError("invalid Endpoint publication receiver");
    const { sql, ledger, formUrl, backendId, targetKey, providerId } = options;
    const query = sql?.query;
    const run = sql?.run;
    const batch = sql?.batch;
    const forOwner = ledger?.forTrustedOwner;
    if (
      !isV2FormUrl(formUrl) ||
      typeof backendId !== "string" ||
      !backendId ||
      typeof targetKey !== "string" ||
      !targetKey ||
      targetKey.length > 255 ||
      typeof providerId !== "string" ||
      !providerId ||
      !sql ||
      typeof query !== "function" ||
      typeof run !== "function" ||
      typeof batch !== "function" ||
      !ledger ||
      typeof forOwner !== "function"
    )
      throw new TypeError("invalid exact Endpoint publication scope");
    this.#sql = sql;
    this.#reads = Object.freeze({ query: query.bind(sql) });
    this.#scope = Object.freeze({ formUrl, backendId, targetKey, providerId });
    this.#owner = forOwner.bind(ledger);
    Object.freeze(this);
  }

  assertSql(sql: Sql): void {
    if (sql !== this.#sql) throw new TypeError("Endpoint publication requires the same atomic Sql");
  }

  /** No allocation, activation or mutation; all authority is read from the owning rows. */
  async prepare(execution: Readonly<V2Execution>): Promise<
    | { readonly kind: "ordinary" }
    | { readonly kind: "refused" }
    | {
        readonly kind: "shared";
        readonly preparation: WorkerEndpointOriginV2PublicationPreparation;
      }
  > {
    // Capture all caller-owned bytes before the first await; no supplied SQL or witness is accepted.
    const captured = capturePublicationExecution(execution);
    const scope = this.#scope;
    const sql = this.#reads;
    const binding = await onePublicationRow(
      sql,
      `SELECT * FROM ${bindings} WHERE endpoint_uid = ?`,
      [captured.resourceUid],
    );
    if (!binding) {
      const output = object(JSON.parse(captured.outputJson));
      return {
        kind: sharedAppStagingNameFromHost(output?.hostname) === null ? "ordinary" : "refused",
      };
    }
    const organizationId = captured.principal.startsWith("org:") ? captured.principal.slice(4) : "";
    const removing = captured.action === "delete";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(organizationId) ||
      captured.space !== organizationId ||
      captured.form !== scope.formUrl ||
      captured.backendId !== scope.backendId ||
      captured.targetKey !== scope.targetKey ||
      !operationIdPattern.test(captured.operationId) ||
      !Number.isSafeInteger(captured.generation) ||
      captured.generation < 1 ||
      binding.organization_id !== organizationId ||
      binding.product !== "takoserver" ||
      binding.name !== captured.name ||
      binding.form_url !== scope.formUrl ||
      binding.backend_id !== scope.backendId ||
      binding.target_key !== scope.targetKey ||
      !Number.isSafeInteger(binding.endpoint_generation) ||
      Number(binding.endpoint_generation) < 1 ||
      (removing
        ? Number(binding.endpoint_generation) >= captured.generation
        : binding.endpoint_generation !== captured.generation) ||
      (!removing && binding.current_operation_id !== captured.operationId) ||
      captured.outputJson !== canonicalJson(address(captured.name)) ||
      typeof binding.reservation_id !== "string" ||
      typeof binding.create_operation_id !== "string" ||
      typeof binding.current_operation_id !== "string"
    )
      return { kind: "refused" };
    const resource = await onePublicationRow(sql, "SELECT * FROM tf_v2_resources WHERE uid = ?", [
      captured.resourceUid,
    ]);
    const operation = await onePublicationRow(sql, "SELECT * FROM tf_v2_operations WHERE id = ?", [
      captured.operationId,
    ]);
    if (!ownsPublication(captured, resource, operation) || !operation) return { kind: "refused" };
    const proofs = [
      exactPublicationRow(bindings, binding),
      exactPublicationRow("tf_v2_resources", resource),
      exactPublicationRow("tf_v2_operations", operation),
    ];
    const created =
      binding.create_operation_id === captured.operationId
        ? operation
        : await onePublicationRow(sql, "SELECT * FROM tf_v2_operations WHERE id = ?", [
            binding.create_operation_id,
          ]);
    if (
      !created ||
      created.resource_uid !== captured.resourceUid ||
      created.principal !== captured.principal ||
      created.generation !== 1 ||
      created.action !== "create" ||
      created.backend_id !== scope.backendId ||
      created.target_key !== scope.targetKey ||
      created.backend_key !== created.id ||
      created.accepted_spec_json !== captured.specJson ||
      (captured.action !== "create" &&
        !(
          (created.status === "succeeded" && created.effect === "complete") ||
          (created.status === "failed" && created.effect === "none")
        )) ||
      (captured.action === "create" && binding.create_operation_id !== captured.operationId)
    )
      return { kind: "refused" };
    if (created !== operation) proofs.push(exactPublicationRow("tf_v2_operations", created));
    let boundPrevious: Row | null = null;
    if (removing) {
      const live = await onePublicationRow(sql, "SELECT * FROM tf_v2_operations WHERE id = ?", [
        binding.current_operation_id,
      ]);
      if (
        !live ||
        live.resource_uid !== captured.resourceUid ||
        live.principal !== captured.principal ||
        live.generation !== binding.endpoint_generation ||
        live.backend_id !== scope.backendId ||
        live.target_key !== scope.targetKey ||
        live.backend_key !== live.id ||
        live.accepted_spec_json !== captured.specJson ||
        !(
          (live.status === "succeeded" && live.effect === "complete") ||
          (live.status === "failed" && live.effect === "none")
        ) ||
        (live.action !== "create" && live.action !== "update")
      )
        return { kind: "refused" };
      boundPrevious = live;
      proofs.push(exactPublicationRow("tf_v2_operations", live));
      // DELETE does not rewrite the last accepted CREATE/UPDATE binding. Every
      // later accepted generation must therefore be its own terminal no-effect
      // DELETE, proved again inside the eventual publication transaction.
      const deletions = failedEndpointOperations(
        captured,
        Number(binding.endpoint_generation),
        captured.generation - 1,
        "delete",
      );
      const valid = await sql.query(
        `SELECT 1 AS current WHERE (${deletions.sql})`,
        deletions.params,
      );
      if (valid.length !== 1) return { kind: "refused" };
      proofs.push(deletions);
    }
    const owned = this.#owner({ organizationId, product: "takoserver" });
    const owner: PublicationOwner = Object.freeze({
      prepareActivate: owned.prepareActivate.bind(owned),
      prepareAdvance: owned.prepareAdvance.bind(owned),
      prepareRetire: owned.prepareRetire.bind(owned),
      readOriginal: owned.readOriginal.bind(owned),
      readRouteCommand: owned.readRouteCommand.bind(owned),
      settleRoute: owned.settleRoute.bind(owned),
    });
    const original = await owner.readOriginal(binding.reservation_id);
    if (
      !original ||
      original.environment !== "staging" ||
      original.organizationId !== organizationId ||
      original.product !== "takoserver" ||
      original.reservationId !== binding.reservation_id ||
      original.name !== captured.name ||
      original.incarnation !== binding.incarnation ||
      original.releasedAt !== null ||
      original.state === "released"
    )
      return { kind: "refused" };
    const claim = Object.freeze({ ...original });
    const held = current(claim);
    const authoritative = await sql.query(`SELECT 1 AS current WHERE (${held.sql})`, held.params);
    if (authoritative.length !== 1) return { kind: "refused" };
    const selectedHostname = hostname(captured.name);
    // Existing v2RouteOperationId accepted-Operation encoding; native route IDs stay unchanged.
    const commandRef = `v2-host:${captured.operationId}:${selectedHostname}`;
    const receipt = await owner.readRouteCommand(commandRef);
    const hostKey = `host/v2/${selectedHostname}`;
    const before = await this.#route("host", hostKey);
    const beforeValue = nativeValue(before);
    const spec = object(JSON.parse(captured.specJson));
    const workerUid = object(spec?.worker)?.resourceUid;
    if (typeof workerUid !== "string" || workerUid.length === 0) return { kind: "refused" };
    const nativeOwner = `v2-worker:${workerUid}`;
    if (before && before.owner_native_id !== nativeOwner) return { kind: "refused" };
    const absentHost = statement(
      `NOT EXISTS (SELECT 1 FROM ${nativeRoutes}
        WHERE provider_id = ? AND route_kind = 'host' AND route_key = ?)`,
      [scope.providerId, hostKey],
    );
    if (removing && !receipt && !before && claim.state === "reserved") {
      if (
        !(
          (created.status === "succeeded" && created.effect === "complete") ||
          (created.status === "failed" && created.effect === "none")
        ) ||
        created.accepted_spec_json !== captured.specJson
      )
        return { kind: "refused" };
      const noHistory = statement(
        `NOT EXISTS (SELECT 1 FROM ${routeHistory} WHERE incarnation = ?)`,
        [claim.incarnation],
      );
      const readback = conjunction([
        ...proofs,
        absentHost,
        noHistory,
        failedEndpointOperations(
          captured,
          1,
          Number(binding.endpoint_generation),
          "update-or-delete",
        ),
      ]);
      const rows = await sql.query(`SELECT 1 AS current WHERE (${readback.sql})`, readback.params);
      return rows.length === 1
        ? {
            kind: "shared",
            preparation: new OriginPublicationPreparation(publicationKey, {
              sql,
              owner,
              claim,
              original: null,
              readback,
              removing,
            }),
          }
        : { kind: "refused" };
    }
    let deploymentUid: string;
    let deploymentGeneration: number;
    let nativeSource: string;
    let script: string | null = null;
    if (removing) {
      const source = receipt?.original ?? beforeValue;
      if (
        !source ||
        typeof source.deploymentUid !== "string" ||
        !Number.isSafeInteger(source.deploymentGeneration) ||
        Number(source.deploymentGeneration) < 1
      )
        return { kind: "refused" };
      deploymentUid = source.deploymentUid;
      deploymentGeneration = Number(source.deploymentGeneration);
      nativeSource = captured.operationId;
      if (!receipt && (!before || before.state !== "active")) return { kind: "refused" };
    } else {
      const worker = await this.#route("worker", `worker/v2/${workerUid}`);
      const value = nativeValue(worker);
      const releases = value?.releases;
      const release = Array.isArray(releases) && releases.length === 1 ? object(releases[0]) : null;
      if (
        !worker ||
        worker.owner_native_id !== nativeOwner ||
        worker.state !== "active" ||
        value?.schema !== workerSchema ||
        value.targetKey !== scope.targetKey ||
        value.workerUid !== workerUid ||
        typeof value.deploymentUid !== "string" ||
        !Number.isSafeInteger(value.deploymentGeneration) ||
        Number(value.deploymentGeneration) < 1 ||
        typeof value.sourceOperationId !== "string" ||
        !operationIdPattern.test(value.sourceOperationId) ||
        release?.weight !== 10_000 ||
        typeof release.scriptName !== "string" ||
        release.scriptName.length === 0
      )
        return { kind: "refused" };
      deploymentUid = value.deploymentUid;
      deploymentGeneration = Number(value.deploymentGeneration);
      nativeSource = value.sourceOperationId;
      script = release.scriptName;
      const workerResource = await onePublicationRow(
        sql,
        "SELECT * FROM tf_v2_resources WHERE uid = ?",
        [workerUid],
      );
      const deploymentResource = await onePublicationRow(
        sql,
        "SELECT * FROM tf_v2_resources WHERE uid = ?",
        [deploymentUid],
      );
      const deploymentOperation = await onePublicationRow(
        sql,
        "SELECT * FROM tf_v2_operations WHERE id = ?",
        [nativeSource],
      );
      if (
        !workerResource ||
        !deploymentResource ||
        !deploymentOperation ||
        workerResource.principal !== captured.principal ||
        workerResource.space !== captured.space ||
        workerResource.deleted_at !== null ||
        deploymentResource.principal !== captured.principal ||
        deploymentResource.space !== captured.space ||
        deploymentResource.deleted_at !== null ||
        deploymentResource.generation !== deploymentGeneration ||
        deploymentResource.last_operation !== nativeSource ||
        deploymentOperation.resource_uid !== deploymentUid ||
        deploymentOperation.principal !== captured.principal ||
        deploymentOperation.generation !== deploymentGeneration ||
        deploymentOperation.status !== "succeeded" ||
        worker.operation_id !== `v2-worker:${nativeSource}`
      )
        return { kind: "refused" };
      proofs.push(
        exactPublicationRow("tf_v2_resources", workerResource),
        exactPublicationRow("tf_v2_resources", deploymentResource),
        exactPublicationRow("tf_v2_operations", deploymentOperation),
      );
      proofs.push(exactPublicationRow(nativeRoutes, worker));
    }
    const expectedValue: JsonObject = removing
      ? { schema: tombstoneSchema }
      : {
          schema: hostSchema,
          targetKey: scope.targetKey,
          hostname: selectedHostname,
          workerUid,
          deploymentUid,
          deploymentGeneration,
          endpointUid: captured.resourceUid,
          endpointGeneration: captured.generation,
          sourceOperationId: nativeSource,
        };
    if (
      before &&
      !receipt &&
      (before.state !== "active" ||
        beforeValue?.schema !== hostSchema ||
        beforeValue.hostname !== selectedHostname ||
        beforeValue.endpointUid !== captured.resourceUid ||
        beforeValue.workerUid !== workerUid ||
        beforeValue.targetKey !== scope.targetKey ||
        before.operation_id !==
          `v2-host:${String(beforeValue.sourceOperationId)}:${selectedHostname}`)
    )
      return { kind: "refused" };
    const activating =
      captured.action === "create" ||
      (captured.action === "update" &&
        (receipt ? receipt.original.action === "activate" : !before && claim.state === "reserved"));
    const admissionOnly: SqlStatement[] = [];
    if (activating) {
      if (captured.action === "update") {
        // A failed/no-effect initial CREATE can be reapplied through a genuine
        // UPDATE. This is the first route of the unchanged reserved incarnation.
        if (
          created.status !== "failed" ||
          created.effect !== "none" ||
          (receipt
            ? receipt.original.expectedGeneration !== 1 ||
              receipt.original.expectedState !== "reserved" ||
              receipt.original.expectedScript !== null
            : claim.generation !== 1)
        )
          return { kind: "refused" };
        const lineage = failedEndpointOperations(
          captured,
          1,
          captured.generation - 1,
          "update-or-delete",
        );
        const rows = await sql.query(`SELECT 1 AS current WHERE (${lineage.sql})`, lineage.params);
        if (rows.length !== 1) return { kind: "refused" };
        proofs.push(lineage);
      }
      if (!receipt) {
        if (before || claim.state !== "reserved") return { kind: "refused" };
        const noHistory = statement(
          `NOT EXISTS (SELECT 1 FROM ${routeHistory} WHERE incarnation = ?)`,
          [claim.incarnation],
        );
        const rows = await sql.query(
          `SELECT 1 AS current WHERE (${noHistory.sql})`,
          noHistory.params,
        );
        if (rows.length !== 1) return { kind: "refused" };
        // Admission only: the new history row must exist after the same batch.
        admissionOnly.push(noHistory);
      } else if (captured.action === "update") {
        proofs.push(
          statement(
            `NOT EXISTS (SELECT 1 FROM ${routeHistory} WHERE incarnation = ? AND command_ref <> ?)`,
            [claim.incarnation, commandRef],
          ),
        );
      }
    } else {
      const previous = await onePublicationRow(
        sql,
        `SELECT * FROM ${routeHistory} WHERE incarnation = ? AND next_generation = ?`,
        [claim.incarnation, receipt?.original.expectedGeneration ?? claim.generation],
      );
      const through = removing ? Number(binding.endpoint_generation) : captured.generation - 1;
      if (
        !previous ||
        previous.organization_id !== organizationId ||
        previous.product !== "takoserver" ||
        previous.reservation_id !== claim.reservationId ||
        previous.name !== claim.name ||
        previous.next_state !== "active" ||
        previous.next_script !== (receipt ? receipt.original.expectedScript : claim.script) ||
        previous.endpoint_uid !== captured.resourceUid ||
        previous.worker_uid !== workerUid ||
        previous.provider_id !== scope.providerId ||
        previous.target_key !== scope.targetKey ||
        !Number.isSafeInteger(previous.endpoint_generation) ||
        Number(previous.endpoint_generation) < 1 ||
        Number(previous.endpoint_generation) > through ||
        typeof previous.source_operation_id !== "string" ||
        previous.command_ref !== `v2-host:${previous.source_operation_id}:${selectedHostname}` ||
        (removing &&
          (previous.deployment_uid !== deploymentUid ||
            previous.deployment_generation !== deploymentGeneration)) ||
        (!receipt &&
          (!before ||
            claim.state !== "active" ||
            previous.endpoint_generation !== beforeValue?.endpointGeneration ||
            previous.deployment_uid !== beforeValue?.deploymentUid ||
            previous.deployment_generation !== beforeValue?.deploymentGeneration))
      )
        return { kind: "refused" };
      const confirmed = await onePublicationRow(
        sql,
        "SELECT * FROM tf_v2_operations WHERE id = ?",
        [previous.source_operation_id],
      );
      if (
        !confirmed ||
        confirmed.resource_uid !== captured.resourceUid ||
        confirmed.principal !== captured.principal ||
        confirmed.generation !== previous.endpoint_generation ||
        confirmed.backend_id !== scope.backendId ||
        confirmed.target_key !== scope.targetKey ||
        confirmed.backend_key !== confirmed.id ||
        confirmed.status !== "succeeded" ||
        confirmed.effect !== "complete" ||
        (confirmed.action !== "create" && confirmed.action !== "update") ||
        confirmed.accepted_spec_json !== captured.specJson ||
        (confirmed.generation === 1 && confirmed.id !== binding.create_operation_id) ||
        (removing &&
          confirmed.generation === binding.endpoint_generation &&
          confirmed.id !== boundPrevious?.id)
      )
        return { kind: "refused" };
      const lineage = failedEndpointOperations(
        captured,
        Number(previous.endpoint_generation),
        through,
        "update-or-delete",
      );
      const rows = await sql.query(`SELECT 1 AS current WHERE (${lineage.sql})`, lineage.params);
      if (rows.length !== 1) return { kind: "refused" };
      proofs.push(
        exactPublicationRow(routeHistory, previous),
        exactPublicationRow("tf_v2_operations", confirmed),
        lineage,
      );
    }
    const nativeOperation = `v2-host:${nativeSource}:${selectedHostname}`;
    const post = (generation: number | null): SqlStatement =>
      statement(
        `EXISTS (SELECT 1 FROM ${nativeRoutes} h WHERE h.provider_id = ?
          AND h.route_kind = 'host' AND h.route_key = ? AND h.owner_native_id = ?
          AND h.operation_id = ? AND h.state = ? AND h.generation >= 1
          ${generation === null ? "" : "AND h.generation = ?"}
          AND json_extract(h.value_json, '$.generation') = h.generation
          AND (SELECT count(*) FROM json_each(h.value_json)) = json_array_length(?) + 1
          AND NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE
            json_extract(h.value_json, '$.' || expected.key) IS NOT expected.value))`,
        [
          scope.providerId,
          hostKey,
          nativeOwner,
          nativeOperation,
          removing ? "tombstone" : "active",
          ...(generation === null ? [] : [generation]),
          JSON.stringify(Object.keys(expectedValue)),
          JSON.stringify(expectedValue),
        ],
      );
    const identity = {
      principal: captured.principal,
      space: captured.space,
      endpointUid: captured.resourceUid,
      endpointGeneration: captured.generation,
      workerUid,
      deploymentUid,
      deploymentGeneration,
      sourceOperationId: captured.operationId,
      providerId: scope.providerId,
      targetKey: scope.targetKey,
      script,
    };
    const readback = conjunction([...proofs, post(null)]);
    if (receipt) {
      const recorded = receipt.original;
      if (
        recorded.incarnation !== claim.incarnation ||
        recorded.name !== claim.name ||
        recorded.reservationId !== claim.reservationId ||
        recorded.action !== (removing ? "retire" : activating ? "activate" : "advance") ||
        recorded.acceptedScript !== script ||
        recorded.endpointUid !== identity.endpointUid ||
        recorded.endpointGeneration !== identity.endpointGeneration ||
        recorded.workerUid !== identity.workerUid ||
        recorded.deploymentUid !== identity.deploymentUid ||
        recorded.deploymentGeneration !== identity.deploymentGeneration ||
        recorded.sourceOperationId !== identity.sourceOperationId ||
        recorded.providerId !== identity.providerId ||
        recorded.targetKey !== identity.targetKey
      )
        return { kind: "refused" };
      return {
        kind: "shared",
        preparation: new OriginPublicationPreparation(publicationKey, {
          sql,
          owner,
          claim,
          original: recorded,
          readback,
          removing,
        }),
      };
    }
    const nativeBefore = before ? exactPublicationRow(nativeRoutes, before) : absentHost;
    const guards = {
      admission: conjunction([...proofs, ...admissionOnly, nativeBefore]),
      publication: conjunction([...proofs, post(Number(before?.generation ?? 0) + 1)]),
    };
    const input = { commandRef, expected: claim, accepted: identity };
    const effects = removing
      ? owner.prepareRetire(input, guards)
      : activating
        ? owner.prepareActivate(input, guards)
        : owner.prepareAdvance(input, guards);
    return {
      kind: "shared",
      preparation: new OriginPublicationPreparation(publicationKey, {
        sql,
        owner,
        claim,
        original: effects.original,
        effects,
        readback,
        removing,
      }),
    };
  }

  #route(kind: "host" | "worker", key: string): Promise<Row | null> {
    return onePublicationRow(
      this.#reads,
      `SELECT * FROM ${nativeRoutes} WHERE provider_id = ? AND route_kind = ? AND route_key = ?`,
      [this.#scope.providerId, kind, key],
    );
  }
}

Object.freeze(OriginPublicationPreparation.prototype);
Object.freeze(OriginPublicationPreparation);
Object.freeze(OriginPublication.prototype);
Object.freeze(OriginPublication);

/** Closed receiver, selected only by trusted construction; not a shared-intent or native grant. */
export type WorkerEndpointOriginV2Publication = OriginPublication;

/** Unmounted scalar STAGING component; weighted routes, schema and business adoption remain separate. */
export function createWorkerEndpointOriginV2Publication(
  options: PublicationScope & { readonly sql: Sql; readonly ledger: SharedAppLedger },
): WorkerEndpointOriginV2Publication {
  return new OriginPublication(publicationKey, options);
}
