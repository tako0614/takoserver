import { canonicalJson } from "./json.ts";
import type { JsonObject, Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import type {
  SharedAppAssignment,
  SharedAppFormV2AcceptedCommand,
  SharedAppFormV2Binding,
  SharedAppFormV2EndpointBindingPin,
  SharedAppFormV2ReleasePin,
  SharedAppFormV2RouteEffects,
  SharedAppFormV2RouteOriginal,
  SharedAppFormV2RouteReceipt,
  SharedAppLedger,
  SharedAppNativeRouteRowPin,
  SharedAppNativeRouteSnapshot,
  SharedAppPin,
  SharedAppRouteAssignment,
  SharedAppRouteEffects,
  SharedAppRouteOriginal,
} from "./shared-app-ledger.ts";
import { normalizeSharedAppName, sharedAppStagingNameFromHost } from "./shared-app-name.ts";
import {
  parseWorkerDeploymentSpec,
  WorkerFormValidationError,
} from "./takoform-v2/forms/worker-specs.ts";
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
  claim: Pick<SharedAppAssignment, "incarnation" | "reservationId">,
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

// The additive Form-v2 compiler is deliberately separate from the scalar SQL
// above. It never decodes a tagged assignment through readOriginal().
const formRouteKey = Symbol("fixed staging Form-v2 route receiver");
const formRouteTag = "form-v2@1" as const;
const formUid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const formDigest = /^sha256:[0-9a-f]{64}$/u;
const rawRouteBytes = 65_536;
const utf8 = new TextEncoder();

type FormRouteOwner = Pick<
  ReturnType<SharedAppLedger["forTrustedOwner"]>,
  | "readOriginalRoute"
  | "readRouteCommand"
  | "prepareFormV2Route"
  | "readFormV2RouteCommand"
  | "settleFormV2Route"
>;

type FormRouteTable =
  | PublicationTable
  | "tf_v2_worker_native_effects"
  | "tf_v2_operation_reference_sets"
  | "tf_v2_operation_references"
  | "tf_v2_resource_references";

function formPin(claim: SharedAppRouteAssignment): SharedAppPin {
  return claim.kind === "scalar" ? claim.value : claim.pin;
}

function formState(claim: SharedAppRouteAssignment): SharedAppAssignment["state"] {
  return claim.kind === "scalar" ? claim.value.state : claim.state;
}

function formReleasedAt(claim: SharedAppRouteAssignment): number | null {
  return claim.kind === "scalar" ? claim.value.releasedAt : claim.releasedAt;
}

function formJson(value: unknown): string {
  return canonicalJson(value);
}

function formEqual(left: unknown, right: unknown): boolean {
  return formJson(left) === formJson(right);
}

function formCurrent(claim: SharedAppRouteAssignment | null): SqlStatement {
  if (!claim) return statement("0", []);
  const pin = formPin(claim);
  const scalar = claim.kind === "scalar";
  const captured = {
    ...pin,
    state: formState(claim),
    script: scalar ? claim.value.script : null,
    releasedAt: formReleasedAt(claim),
    bindingKind: scalar ? null : formRouteTag,
    bindingJson: !scalar && claim.state === "active" ? formJson(claim.binding) : null,
  };
  return statement(
    `EXISTS (SELECT 1 FROM ${assignments} a JOIN ${names} n
      ON n.normalized_name = a.name AND n.incarnation = a.incarnation
        AND n.generation = a.generation AND n.state = a.state,
      json_each(?) captured WHERE a.organization_id = json_extract(captured.value,'$.organizationId')
      AND a.product = json_extract(captured.value,'$.product')
      AND a.reservation_id = json_extract(captured.value,'$.reservationId')
      AND a.name = json_extract(captured.value,'$.name')
      AND a.incarnation = json_extract(captured.value,'$.incarnation')
      AND a.generation = json_extract(captured.value,'$.generation')
      AND a.state = json_extract(captured.value,'$.state')
      AND a.script IS json_extract(captured.value,'$.script')
      AND a.released_at IS json_extract(captured.value,'$.releasedAt')
      AND n.released_at IS a.released_at
      AND a.binding_kind IS json_extract(captured.value,'$.bindingKind')
      AND a.binding_json IS json_extract(captured.value,'$.bindingJson'))`,
    [JSON.stringify([captured])],
  );
}

function formPriorAcceptance(
  context: V2HostAcceptanceContext,
  claim: SharedAppRouteAssignment | null,
): SqlStatement {
  if (!claim) return statement("0", []);
  const pin = formPin(claim);
  if (context.action === "create")
    return statement(`NOT EXISTS (SELECT 1 FROM ${bindings} WHERE incarnation = ?)`, [
      pin.incarnation,
    ]);
  return statement(
    `EXISTS (SELECT 1 FROM ${bindings} b JOIN tf_v2_resources r
      ON r.uid = b.endpoint_uid AND r.generation = b.endpoint_generation
        AND r.last_operation = b.current_operation_id
      WHERE b.incarnation = ? AND b.organization_id = ? AND b.product = 'takoserver'
        AND b.reservation_id = ? AND b.name = ? AND b.endpoint_uid = ?
        AND b.endpoint_generation = ? AND b.form_url = ? AND b.backend_id = ?
        AND b.target_key = ? AND r.principal = ? AND r.space = ? AND r.deleted_at IS NULL)`,
    [
      pin.incarnation,
      pin.organizationId,
      pin.reservationId,
      pin.name,
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

function compileFormAcceptance(
  sql: Sql,
  context: V2HostAcceptanceContext,
  claim: SharedAppRouteAssignment | null,
  gap?: FailedDeleteAcceptanceGap,
): V2PreparedHostAcceptance {
  const pin = claim ? formPin(claim) : null;
  const held = formCurrent(claim);
  const prior = gap?.admission ?? formPriorAcceptance(context, claim);
  const proof = accepted(context);
  const bindingProof =
    gap?.bindingProof ??
    (context.action === "create"
      ? prior
      : statement(
          `EXISTS (SELECT 1 FROM ${bindings} WHERE incarnation = ? AND endpoint_uid = ?
      AND endpoint_generation = ? AND organization_id = ? AND reservation_id = ?
      AND form_url = ? AND backend_id = ? AND target_key = ?)`,
          [
            pin?.incarnation ?? null,
            context.resourceUid,
            context.generation - 1,
            context.space,
            pin?.reservationId ?? null,
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
          params: [pin?.incarnation ?? null, context.resourceUid, context.generation - 1],
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
      pin?.incarnation ?? null,
      context.space,
      pin?.reservationId ?? null,
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

class FormRouteAcceptance implements V2HostAcceptance {
  readonly #sql: Sql;
  readonly #ledger: SharedAppLedger;
  readonly #scope: Scope;

  constructor(
    key: symbol,
    options: Scope & { readonly sql: Sql; readonly ledger: SharedAppLedger },
  ) {
    if (key !== formRouteKey) throw new TypeError("invalid Form-v2 Endpoint acceptance issuer");
    // Reuse construction validation, not the scalar claim decoder/compiler.
    new OriginAcceptance(constructorKey, options);
    this.#sql = options.sql;
    this.#ledger = options.ledger;
    this.#scope = Object.freeze({
      formUrl: options.formUrl,
      backendId: options.backendId,
      targetKey: options.targetKey,
    });
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
    return this.#selected(context) ? this.#prepare(context) : undefined;
  }

  async #prepare(context: V2HostAcceptanceContext): Promise<V2PreparedHostAcceptance> {
    const organizationId = context.principal.startsWith("org:") ? context.principal.slice(4) : "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(organizationId) ||
      context.space !== organizationId ||
      context.outputJson !== formJson(address(context.name))
    )
      throw new TypeError("Endpoint acceptance requires exact direct Organization context");
    const rows = await this.#sql.query(
      `SELECT a.reservation_id FROM ${assignments} a JOIN ${names} n
        ON n.normalized_name = a.name AND n.incarnation = a.incarnation
          AND n.generation = a.generation AND n.state = a.state
        WHERE a.organization_id = ? AND a.product = 'takoserver' AND a.name = ?
          AND a.state IN ('reserved','active') AND a.released_at IS NULL
          AND n.released_at IS NULL LIMIT 2`,
      [organizationId, context.name],
    );
    if (rows.length > 1) throw new TypeError("ambiguous original Endpoint reservation");
    const reservationId = rows[0]?.reservation_id;
    const owner = this.#ledger.forTrustedOwner({ organizationId, product: "takoserver" });
    const original =
      typeof reservationId === "string" ? await owner.readOriginalRoute(reservationId) : null;
    const pin = original ? formPin(original) : null;
    const claim =
      original &&
      pin &&
      pin.environment === "staging" &&
      pin.organizationId === organizationId &&
      pin.product === "takoserver" &&
      pin.reservationId === reservationId &&
      pin.name === context.name &&
      formReleasedAt(original) === null &&
      (context.action === "create"
        ? formState(original) === "reserved"
        : formState(original) !== "released")
        ? original
        : null;
    const gap =
      claim && context.action === "update"
        ? await failedDeleteAcceptanceGap(this.#sql, context, formPin(claim))
        : undefined;
    return compileFormAcceptance(this.#sql, context, claim, gap);
  }
}

/** Explicit typed construction; the default scalar acceptance remains unchanged. */
export function createWorkerEndpointOriginV2FormRouteAcceptance(
  options: Scope & { readonly sql: Sql; readonly ledger: SharedAppLedger },
): V2HostAcceptance {
  return new FormRouteAcceptance(formRouteKey, options);
}

/** The same complete failed-none interval as the scalar helper, with one JSON parameter. */
function formFailedEndpointOperations(
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
  const range = `o.resource_uid=json_extract(c.value,'$.uid')
    AND o.generation>json_extract(c.value,'$.after') AND o.generation<=json_extract(c.value,'$.through')`;
  return statement(
    `EXISTS (SELECT 1 FROM json_each(?) c WHERE
    (SELECT count(*) FROM tf_v2_operations o WHERE ${range})=json_extract(c.value,'$.count')
    AND (SELECT count(DISTINCT o.generation) FROM tf_v2_operations o WHERE ${range})=json_extract(c.value,'$.count')
    AND NOT EXISTS (SELECT 1 FROM tf_v2_operations o WHERE ${range} AND NOT (
      typeof(o.generation)='integer' AND o.principal=json_extract(c.value,'$.principal')
      AND ${action === "update-or-delete" ? "o.action IN ('update','delete')" : "o.action=json_extract(c.value,'$.action')"}
      AND o.status='failed' AND o.effect='none' AND o.backend_id=json_extract(c.value,'$.backendId')
      AND o.target_key=json_extract(c.value,'$.targetKey') AND o.backend_key=o.id
      AND o.accepted_spec_json=json_extract(c.value,'$.specJson'))))`,
    [
      JSON.stringify([
        {
          uid: execution.resourceUid,
          principal: execution.principal,
          backendId: execution.backendId,
          targetKey: execution.targetKey,
          specJson: execution.specJson,
          after,
          through,
          count,
          action,
        },
      ]),
    ],
  );
}

function formText(value: unknown, maximum = 255): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function formPositive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

/** Data properties only: prospective rows cannot smuggle executable accessors or extra authority. */
function formRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const raw = object(value);
  if (
    !raw ||
    Object.getOwnPropertySymbols(raw).length !== 0 ||
    Object.keys(raw).sort().join("\0") !== [...keys].sort().join("\0")
  )
    throw new TypeError("invalid Form-v2 route data keys");
  const captured: Record<string, unknown> = Object.create(null);
  for (const name of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (!descriptor || !("value" in descriptor))
      throw new TypeError("Form-v2 route data must be values");
    captured[name] = descriptor.value;
  }
  return captured;
}

function captureFormNativeRow(input: unknown, providerId: string): SharedAppNativeRouteRowPin {
  const row = formRecord(input, [
    "providerId",
    "routeKind",
    "routeKey",
    "ownerNativeId",
    "generation",
    "operationId",
    "state",
    "valueJson",
  ]);
  if (
    row.providerId !== providerId ||
    (row.routeKind !== "host" && row.routeKind !== "worker") ||
    !formText(row.routeKey, row.routeKind === "host" ? 261 : 138) ||
    !formText(row.ownerNativeId, 138) ||
    !formPositive(row.generation) ||
    !formText(row.operationId, row.routeKind === "host" ? 298 : 46) ||
    (row.state !== "active" && row.state !== "tombstone") ||
    typeof row.valueJson !== "string" ||
    utf8.encode(row.valueJson).byteLength > rawRouteBytes
  )
    throw new TypeError("invalid bounded Form-v2 native row");
  return Object.freeze(row) as unknown as SharedAppNativeRouteRowPin;
}

function nativeTuple(row: Pick<SharedAppNativeRouteRowPin, "routeKind" | "routeKey">): string {
  return `${row.routeKind}\0${row.routeKey}`;
}

function captureFormNativeRows(
  input: WorkerEndpointOriginV2FormRouteNativeRows,
  providerId: string,
): readonly SharedAppNativeRouteRowPin[] {
  if (!Array.isArray(input) || input.length > 3)
    throw new TypeError("invalid native row cardinality");
  const rows: SharedAppNativeRouteRowPin[] = [];
  let previous = "";
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor)) throw new TypeError("invalid native row vector");
    const row = captureFormNativeRow(descriptor.value, providerId);
    const tuple = nativeTuple(row);
    if (tuple <= previous) throw new TypeError("native row vector must be unique and ordered");
    previous = tuple;
    rows.push(row);
  }
  return Object.freeze(rows);
}

function formRow(row: Row, providerId: string): SharedAppNativeRouteRowPin {
  return captureFormNativeRow(
    {
      providerId: row.provider_id,
      routeKind: row.route_kind,
      routeKey: row.route_key,
      ownerNativeId: row.owner_native_id,
      generation: row.generation,
      operationId: row.operation_id,
      state: row.state,
      valueJson: row.value_json,
    },
    providerId,
  );
}

function formNativeValue(row: SharedAppNativeRouteRowPin): Record<string, unknown> {
  const value = object(JSON.parse(row.valueJson));
  if (!value || value.generation !== row.generation)
    throw new TypeError("native generation mismatch");
  return value;
}

function formReleases(value: unknown): readonly SharedAppFormV2ReleasePin[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8)
    throw new TypeError("invalid release cardinality");
  let previous = "";
  let total = 0;
  const releases = value.map((input) => {
    const pin = formRecord(input, [
      "versionUid",
      "versionGeneration",
      "scriptName",
      "weight",
      "descriptorDigest",
      "providerEtag",
    ]);
    if (
      typeof pin.versionUid !== "string" ||
      !formUid.test(pin.versionUid) ||
      pin.versionUid <= previous ||
      !formPositive(pin.versionGeneration) ||
      !formText(pin.scriptName) ||
      !formPositive(pin.weight) ||
      pin.weight > 10_000 ||
      typeof pin.descriptorDigest !== "string" ||
      !formDigest.test(pin.descriptorDigest) ||
      !formText(pin.providerEtag)
    )
      throw new TypeError("invalid complete release pin");
    previous = pin.versionUid;
    total += pin.weight;
    return Object.freeze(pin) as unknown as SharedAppFormV2ReleasePin;
  });
  if (total !== 10_000) throw new TypeError("invalid release weights");
  return Object.freeze(releases);
}

function formWorkerValue(row: SharedAppNativeRouteRowPin, targetKey: string) {
  const value = formRecord(formNativeValue(row), [
    "schema",
    "generation",
    "targetKey",
    "workerUid",
    "deploymentUid",
    "deploymentGeneration",
    "sourceOperationId",
    "releases",
  ]);
  if (
    row.routeKind !== "worker" ||
    row.state !== "active" ||
    value.schema !== workerSchema ||
    value.targetKey !== targetKey ||
    typeof value.workerUid !== "string" ||
    !formUid.test(value.workerUid) ||
    typeof value.deploymentUid !== "string" ||
    !formUid.test(value.deploymentUid) ||
    !formPositive(value.deploymentGeneration) ||
    typeof value.sourceOperationId !== "string" ||
    !operationIdPattern.test(value.sourceOperationId) ||
    row.routeKey !== `worker/v2/${value.workerUid}` ||
    row.ownerNativeId !== `v2-worker:${value.workerUid}` ||
    row.operationId !== `v2-worker:${value.sourceOperationId}`
  )
    throw new TypeError("invalid native Worker identity");
  return Object.freeze({
    workerUid: value.workerUid,
    deploymentUid: value.deploymentUid,
    deploymentGeneration: value.deploymentGeneration,
    sourceOperationId: value.sourceOperationId,
    releases: formReleases(value.releases),
  });
}

function formHostValue(row: SharedAppNativeRouteRowPin, targetKey: string) {
  const value = formRecord(formNativeValue(row), [
    "schema",
    "generation",
    "targetKey",
    "hostname",
    "workerUid",
    "deploymentUid",
    "deploymentGeneration",
    "endpointUid",
    "endpointGeneration",
    "sourceOperationId",
  ]);
  const host = value.hostname;
  if (
    row.routeKind !== "host" ||
    row.state !== "active" ||
    value.schema !== hostSchema ||
    value.targetKey !== targetKey ||
    typeof host !== "string" ||
    host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      host,
    ) ||
    typeof value.workerUid !== "string" ||
    !formUid.test(value.workerUid) ||
    typeof value.deploymentUid !== "string" ||
    !formUid.test(value.deploymentUid) ||
    !formPositive(value.deploymentGeneration) ||
    typeof value.endpointUid !== "string" ||
    !formUid.test(value.endpointUid) ||
    !formPositive(value.endpointGeneration) ||
    typeof value.sourceOperationId !== "string" ||
    !operationIdPattern.test(value.sourceOperationId) ||
    row.routeKey !== `host/v2/${host}` ||
    row.ownerNativeId !== `v2-worker:${value.workerUid}` ||
    row.operationId !== `v2-host:${value.sourceOperationId}:${host}`
  )
    throw new TypeError("invalid native Endpoint identity");
  return Object.freeze({
    hostname: host,
    workerUid: value.workerUid,
    deploymentUid: value.deploymentUid,
    deploymentGeneration: value.deploymentGeneration,
    endpointUid: value.endpointUid,
    endpointGeneration: value.endpointGeneration,
    sourceOperationId: value.sourceOperationId,
  });
}

function formTombstone(row: SharedAppNativeRouteRowPin): void {
  const value = formRecord(formNativeValue(row), ["schema", "generation"]);
  if (row.state !== "tombstone" || value.schema !== tombstoneSchema)
    throw new TypeError("invalid native tombstone");
}

/** Bound fixed-table witnesses together, without8x positional pin placeholders. */
class FormRouteEvidence {
  readonly #rows = new Map<FormRouteTable, Map<string, Row>>();
  readonly #extra: SqlStatement[] = [];
  readonly #admission: SqlStatement[] = [];

  add(table: FormRouteTable, row: Row): void {
    const columns = Object.keys(row).sort();
    if (columns.length === 0 || columns.some((column) => !/^[a-z_][a-z_0-9]*$/u.test(column)))
      throw new TypeError("invalid fixed route projection");
    const data = JSON.stringify(row);
    if (utf8.encode(data).byteLength > 2_000_000) throw new TypeError("route witness row limit");
    const rows = this.#rows.get(table) ?? new Map<string, Row>();
    rows.set(data, Object.freeze({ ...row }));
    this.#rows.set(table, rows);
  }

  require(proof: SqlStatement): void {
    if (!this.#extra.some((held) => held.sql === proof.sql && formEqual(held.params, proof.params)))
      this.#extra.push(proof);
  }

  admit(proof: SqlStatement): void {
    this.#admission.push(proof);
  }

  guard(admission = false): SqlStatement {
    const parts: SqlStatement[] = [...this.#extra, ...(admission ? this.#admission : [])];
    for (const [table, rows] of this.#rows) {
      const values = [...rows.values()];
      const columns = Object.keys(values[0] ?? {}).sort();
      if (values.some((row) => Object.keys(row).sort().join("\0") !== columns.join("\0")))
        throw new TypeError("inconsistent fixed route projection");
      const chunks: Row[][] = [];
      let chunk: Row[] = [];
      let bytes = 2;
      for (const row of values) {
        const size = utf8.encode(JSON.stringify(row)).byteLength + 1;
        if (bytes + size > 2_000_000 && chunk.length) {
          chunks.push(chunk);
          chunk = [];
          bytes = 2;
        }
        if (size + 2 > 2_000_000) throw new TypeError("route witness string limit");
        chunk.push(row);
        bytes += size;
      }
      if (chunk.length) chunks.push(chunk);
      for (const rows of chunks)
        parts.push(
          statement(
            `NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS
          (SELECT 1 FROM ${table} actual WHERE ${columns
            .map((column) => `actual.${column} IS json_extract(expected.value,'$.${column}')`)
            .join(" AND ")}))`,
            [JSON.stringify(rows)],
          ),
        );
    }
    const result = conjunction(parts.length ? parts : [statement("1", [])]);
    if (utf8.encode(result.sql).byteLength > 90_000) throw new TypeError("route SQL byte budget");
    return result;
  }
}

function formSnapshot(
  row: SharedAppNativeRouteRowPin | null,
  key: Pick<SharedAppNativeRouteRowPin, "providerId" | "routeKind" | "routeKey">,
): SharedAppNativeRouteSnapshot {
  return Object.freeze({
    providerId: key.providerId,
    routeKind: key.routeKind,
    routeKey: key.routeKey,
    row,
  });
}

function formNativeGuard(snapshots: readonly SharedAppNativeRouteSnapshot[]): SqlStatement {
  return statement(
    `NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE
    CASE WHEN json_type(expected.value,'$.row') = 'null' THEN EXISTS
      (SELECT 1 FROM ${nativeRoutes} actual
       WHERE actual.provider_id=json_extract(expected.value,'$.providerId')
         AND actual.route_kind=json_extract(expected.value,'$.routeKind')
         AND actual.route_key=json_extract(expected.value,'$.routeKey'))
    ELSE NOT EXISTS (SELECT 1 FROM ${nativeRoutes} actual
      WHERE actual.provider_id=json_extract(expected.value,'$.providerId')
        AND actual.route_kind=json_extract(expected.value,'$.routeKind')
        AND actual.route_key=json_extract(expected.value,'$.routeKey')
        AND actual.owner_native_id=json_extract(expected.value,'$.row.ownerNativeId')
        AND actual.generation=json_extract(expected.value,'$.row.generation')
        AND actual.operation_id=json_extract(expected.value,'$.row.operationId')
        AND actual.state=json_extract(expected.value,'$.row.state')
        AND actual.value_json=json_extract(expected.value,'$.row.valueJson')) END)`,
    [JSON.stringify(snapshots)],
  );
}

/** Fixed adoption inventory, independent of live attachments and native row presence. */
function formAdoptionInventorySql(): string {
  const worker = `(SELECT json_extract(value,'$.workerUid') FROM form_route_inventory_context)`;
  return `WITH form_route_inventory_context AS (SELECT value FROM json_each(?)),
    form_route_inventory AS (
      SELECT b.incarnation, b.endpoint_uid FROM ${bindings} b JOIN tf_v2_resources endpoint
        ON endpoint.uid=b.endpoint_uid WHERE json_extract(endpoint.spec_json,'$.worker.resourceUid')=${worker}
      UNION SELECT incarnation, endpoint_uid FROM ${routeHistory} WHERE worker_uid=${worker}
      UNION SELECT incarnation, json_extract(binding_json,'$.endpoint.uid') AS endpoint_uid
        FROM ${assignments} WHERE binding_json IS NOT NULL AND CASE WHEN json_valid(binding_json)=1
          THEN json_extract(binding_json,'$.workerUid')=${worker} ELSE 0 END)`;
}

interface FormRouteScope {
  readonly providerId: string;
  readonly targetKey: string;
  readonly endpoint: Readonly<{ formUrl: string; backendId: string }>;
  readonly worker: Readonly<{ formUrl: string; backendId: string }>;
  readonly deployment: Readonly<{ formUrl: string; backendId: string }>;
  readonly version: Readonly<{ formUrl: string; backendId: string }>;
}

interface FormEndpointBinding {
  readonly row: Row;
  readonly pin: SharedAppFormV2EndpointBindingPin;
  readonly owner: FormRouteOwner;
  readonly claim: SharedAppRouteAssignment;
}

interface FormSource {
  readonly resource: Row;
  readonly operation: Row;
  readonly spec: Record<string, unknown>;
}

export type WorkerEndpointOriginV2FormRouteNativeRows = readonly SharedAppNativeRouteRowPin[];
export type WorkerEndpointOriginV2FormRouteEndpointResult =
  | { readonly kind: "ordinary" }
  | { readonly kind: "refused" }
  | { readonly kind: "shared"; readonly preparation: WorkerEndpointOriginV2FormRoutePreparation };
export type WorkerEndpointOriginV2FormRouteDeploymentResult =
  | { readonly kind: "ordinary" }
  | { readonly kind: "refused" }
  | {
      readonly kind: "shared";
      readonly preparations: readonly WorkerEndpointOriginV2FormRoutePreparation[];
    };

class FormRoutePreparation {
  readonly effects: SharedAppFormV2RouteEffects | undefined;
  readonly #owner: FormRouteOwner;
  readonly #original: SharedAppFormV2RouteOriginal | null;
  readonly #readback: () => Promise<"confirmed" | "retired" | "unknown">;

  constructor(
    key: symbol,
    owner: FormRouteOwner,
    original: SharedAppFormV2RouteOriginal | null,
    effects: SharedAppFormV2RouteEffects | undefined,
    readback: () => Promise<"confirmed" | "retired" | "unknown">,
  ) {
    if (key !== formRouteKey) throw new TypeError("invalid Form-v2 route preparation");
    this.#owner = owner;
    this.#original = original;
    this.effects = effects;
    this.#readback = readback;
    Object.freeze(this);
  }

  /** Historical settlement has no currentness prerequisite and never retries native writes. */
  async settleOriginal(): Promise<SharedAppFormV2RouteReceipt | null> {
    if (this.#original) return this.#owner.settleFormV2Route(this.#original, "unknown");
    if ((await this.#readback()) !== "retired")
      throw new TypeError("never-live Endpoint removal is no longer verifiable");
    return null;
  }

  async observe(): Promise<"confirmed" | "retired" | "unknown"> {
    try {
      return await this.#readback();
    } catch {
      return "unknown";
    }
  }
}

/** Opaque closed preparation; serializing it creates neither native authority nor a new issuer. */
export type WorkerEndpointOriginV2FormRoutePreparation = FormRoutePreparation;

class FormRoutePublication {
  readonly #sql: Sql;
  readonly #reads: Pick<Sql, "query">;
  readonly #scope: FormRouteScope;
  readonly #forOwner: SharedAppLedger["forTrustedOwner"];

  constructor(
    key: symbol,
    options: FormRouteScope & { readonly sql: Sql; readonly ledger: SharedAppLedger },
  ) {
    if (key !== formRouteKey) throw new TypeError("invalid Form-v2 route issuer");
    const { sql, ledger, providerId, targetKey } = options;
    const query = sql?.query;
    const forOwner = ledger?.forTrustedOwner;
    if (
      !sql ||
      typeof query !== "function" ||
      typeof sql.run !== "function" ||
      typeof sql.batch !== "function" ||
      !ledger ||
      typeof forOwner !== "function" ||
      !formText(providerId) ||
      !formText(targetKey)
    )
      throw new TypeError("invalid Form-v2 route construction");
    const captureScope = (value: FormRouteScope["endpoint"]) => {
      const { formUrl, backendId } = value;
      if (!isV2FormUrl(formUrl) || !formText(backendId))
        throw new TypeError("invalid fixed owning Form scope");
      return Object.freeze({ formUrl, backendId });
    };
    this.#scope = Object.freeze({
      providerId,
      targetKey,
      endpoint: captureScope(options.endpoint),
      worker: captureScope(options.worker),
      deployment: captureScope(options.deployment),
      version: captureScope(options.version),
    });
    this.#sql = sql;
    this.#reads = Object.freeze({ query: query.bind(sql) });
    this.#forOwner = forOwner.bind(ledger);
    Object.freeze(this);
  }

  assertSql(sql: Sql): void {
    if (sql !== this.#sql) throw new TypeError("Form-v2 publication requires the same atomic Sql");
  }

  #owner(organizationId: string): FormRouteOwner {
    const actual = this.#forOwner({ organizationId, product: "takoserver" });
    return Object.freeze({
      readOriginalRoute: actual.readOriginalRoute.bind(actual),
      readRouteCommand: actual.readRouteCommand.bind(actual),
      prepareFormV2Route: actual.prepareFormV2Route.bind(actual),
      readFormV2RouteCommand: actual.readFormV2RouteCommand.bind(actual),
      settleFormV2Route: actual.settleFormV2Route.bind(actual),
    });
  }

  #organization(execution: PublicationExecution, kind: "endpoint" | "deployment"): string {
    const organizationId = execution.principal.startsWith("org:")
      ? execution.principal.slice(4)
      : "";
    const scope = this.#scope[kind];
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(organizationId) ||
      execution.space !== organizationId ||
      execution.form !== scope.formUrl ||
      execution.backendId !== scope.backendId ||
      execution.targetKey !== this.#scope.targetKey ||
      !formUid.test(execution.resourceUid) ||
      !operationIdPattern.test(execution.operationId) ||
      execution.backendKey !== execution.operationId ||
      !formPositive(execution.generation) ||
      !formText(execution.leaseToken, 512) ||
      !["create", "update", "delete"].includes(execution.action)
    )
      throw new TypeError("invalid exact accepted Form-v2 execution");
    return organizationId;
  }

  #one(table: FormRouteTable, key: string, value: string): Promise<Row | null> {
    // All table/key arguments are literals in this closed module.
    if (!/^[a-z_]+$/u.test(key)) throw new TypeError("invalid fixed lookup");
    return onePublicationRow(this.#reads, `SELECT * FROM ${table} WHERE ${key} = ?`, [value]);
  }

  async #route(kind: "host" | "worker", key: string): Promise<SharedAppNativeRouteRowPin | null> {
    const row = await onePublicationRow(
      this.#reads,
      `SELECT * FROM ${nativeRoutes} WHERE provider_id = ? AND route_kind = ? AND route_key = ?`,
      [this.#scope.providerId, kind, key],
    );
    return row ? formRow(row, this.#scope.providerId) : null;
  }

  async #owns(execution: PublicationExecution, evidence: FormRouteEvidence): Promise<void> {
    const resource = await this.#one("tf_v2_resources", "uid", execution.resourceUid);
    const operation = await this.#one("tf_v2_operations", "id", execution.operationId);
    if (!ownsPublication(execution, resource, operation) || !operation)
      throw new TypeError("accepted Form-v2 claim changed");
    evidence.add("tf_v2_resources", resource);
    evidence.add("tf_v2_operations", operation);
  }

  async #source(
    uid: string,
    scope: FormRouteScope["worker"],
    execution: PublicationExecution,
    evidence: FormRouteEvidence,
    options: {
      operationId?: string;
      generation?: number;
      historical?: boolean;
      claimed?: boolean;
    } = {},
  ): Promise<FormSource> {
    const resource = await this.#one("tf_v2_resources", "uid", uid);
    const operationId = options.operationId ?? resource?.last_operation;
    const operation =
      typeof operationId === "string"
        ? await this.#one("tf_v2_operations", "id", operationId)
        : null;
    const own = options.claimed && operationId === execution.operationId;
    const spec =
      typeof operation?.accepted_spec_json === "string"
        ? object(JSON.parse(operation.accepted_spec_json))
        : null;
    if (
      !resource ||
      !operation ||
      !spec ||
      !formUid.test(uid) ||
      resource.uid !== uid ||
      resource.form_url !== scope.formUrl ||
      resource.backend_id !== scope.backendId ||
      resource.target_key !== this.#scope.targetKey ||
      resource.principal !== execution.principal ||
      resource.space !== execution.space ||
      (!options.historical && resource.deleted_at !== null) ||
      !formPositive(operation.generation) ||
      (options.generation !== undefined && operation.generation !== options.generation) ||
      operation.resource_uid !== uid ||
      operation.principal !== execution.principal ||
      operation.backend_id !== scope.backendId ||
      operation.target_key !== this.#scope.targetKey ||
      operation.backend_key !== operation.id ||
      !operationIdPattern.test(String(operation.id)) ||
      (operation.action !== "create" && operation.action !== "update") ||
      (!options.historical &&
        (resource.generation !== operation.generation ||
          resource.last_operation !== operation.id ||
          resource.spec_json !== operation.accepted_spec_json)) ||
      (own
        ? !ownsPublication(execution, resource, operation)
        : operation.status !== "succeeded" || operation.effect !== "complete") ||
      (!own &&
        !options.historical &&
        (resource.phase !== "idle" ||
          resource.busy_operation !== null ||
          resource.observed_generation !== resource.generation ||
          (scope.formUrl === this.#scope.endpoint.formUrl
            ? object(JSON.parse(String(resource.observed_json)))?.tlsReady !== true ||
              object(JSON.parse(String(resource.observed_json)))?.activeDeploymentRouteReady !==
                true
            : object(JSON.parse(String(resource.observed_json)))?.ready !== true)))
    )
      throw new TypeError("actual owning source is not confirmed/current");
    evidence.add("tf_v2_resources", resource);
    evidence.add("tf_v2_operations", operation);
    return Object.freeze({ resource, operation, spec });
  }

  async #references(
    source: FormSource,
    required: readonly Readonly<{
      uid: string;
      formUrl: string;
      readiness: "observed" | "ready";
      workerUid?: string;
    }>[],
    evidence: FormRouteEvidence,
    exact = false,
  ): Promise<void> {
    const operationId = String(source.operation.id);
    const sealed = await this.#one("tf_v2_operation_reference_sets", "operation_id", operationId);
    const refs = await this.#reads.query(
      "SELECT * FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
      [operationId],
    );
    const edges = await this.#reads.query(
      "SELECT * FROM tf_v2_resource_references WHERE referrer_uid = ? ORDER BY target_uid",
      [String(source.resource.uid)],
    );
    if (
      !sealed ||
      sealed.sealed !== 1 ||
      (exact && refs.length !== required.length) ||
      required.some(
        (expected) =>
          !refs.some(
            (ref) =>
              ref.target_uid === expected.uid &&
              ref.form_url === expected.formUrl &&
              ref.readiness === expected.readiness &&
              ref.target_spec_path === (expected.workerUid ? "$.worker.resourceUid" : null) &&
              ref.target_spec_equals === (expected.workerUid ?? null),
          ),
      ) ||
      refs.some((ref) => !edges.some((edge) => edge.target_uid === ref.target_uid))
    )
      throw new TypeError("sealed/active source reference set changed");
    evidence.add("tf_v2_operation_reference_sets", sealed);
    for (const ref of refs) evidence.add("tf_v2_operation_references", ref);
    for (const edge of edges) evidence.add("tf_v2_resource_references", edge);
    evidence.require(
      statement(
        `EXISTS (SELECT 1 FROM json_each(?) captured WHERE
      (SELECT count(*) FROM tf_v2_operation_references
        WHERE operation_id = json_extract(captured.value,'$.operationId')) = json_extract(captured.value,'$.refs')
      AND (SELECT count(*) FROM tf_v2_resource_references
        WHERE referrer_uid = json_extract(captured.value,'$.resourceUid')) = json_extract(captured.value,'$.edges'))`,
        [
          JSON.stringify([
            {
              operationId,
              resourceUid: source.resource.uid,
              refs: refs.length,
              edges: edges.length,
            },
          ]),
        ],
      ),
    );
  }

  async #releases(
    worker: ReturnType<typeof formWorkerValue>,
    execution: PublicationExecution,
    evidence: FormRouteEvidence,
    options: { prospective?: boolean; historical?: boolean; http?: boolean } = {},
  ): Promise<void> {
    if (!options.historical) {
      const attachments = await this.#attachments(
        worker.workerUid,
        this.#scope.deployment,
        execution,
        evidence,
      );
      if (attachments.length !== 1 || attachments[0]?.uid !== worker.deploymentUid)
        throw new TypeError("native Worker has no unique actual Deployment attachment");
    }
    const module = await this.#source(worker.workerUid, this.#scope.worker, execution, evidence);
    await this.#references(module, [], evidence, true);
    const deployment = await this.#source(
      worker.deploymentUid,
      this.#scope.deployment,
      execution,
      evidence,
      {
        operationId: worker.sourceOperationId,
        generation: worker.deploymentGeneration,
        ...(options.historical === undefined ? {} : { historical: options.historical }),
        ...(options.prospective === undefined ? {} : { claimed: options.prospective }),
      },
    );
    // The owning parser accepts either input order and returns a UID-ordered
    // copy. Core keeps its original accepted bytes, already captured/fenced
    // above; canonicalize only this semantic comparison with native pins.
    let desired: ReturnType<typeof parseWorkerDeploymentSpec>;
    try {
      desired = parseWorkerDeploymentSpec(deployment.spec);
    } catch (error) {
      if (error instanceof WorkerFormValidationError)
        throw new TypeError("accepted Deployment vector differs");
      throw error;
    }
    if (
      object(desired.worker)?.resourceUid !== worker.workerUid ||
      !Array.isArray(desired.versions) ||
      desired.versions.length !== worker.releases.length
    )
      throw new TypeError("accepted Deployment vector differs");
    const required = [
      {
        uid: worker.workerUid,
        formUrl: this.#scope.worker.formUrl,
        readiness: "observed" as const,
      },
      ...worker.releases.map((release) => ({
        uid: release.versionUid,
        formUrl: this.#scope.version.formUrl,
        readiness: "ready" as const,
        workerUid: worker.workerUid,
      })),
    ];
    await this.#references(deployment, required, evidence, true);
    if (!options.prospective && !options.historical) {
      const observed = object(JSON.parse(String(deployment.resource.observed_json)));
      const selected = observed?.selectedVersions;
      if (
        observed?.active !== true ||
        !Array.isArray(selected) ||
        selected.length !== worker.releases.length ||
        selected.some((entry) => {
          const pin = object(entry);
          return !worker.releases.some(
            (release) => pin?.resourceUid === release.versionUid && pin.weight === release.weight,
          );
        })
      )
        throw new TypeError("confirmed Deployment vector differs");
    }
    for (let index = 0; index < worker.releases.length; index++) {
      const pin = worker.releases[index];
      if (!pin) throw new TypeError("missing release pin");
      const wanted = formRecord(desired.versions[index], ["workerVersion", "weight"]);
      if (
        object(wanted.workerVersion)?.resourceUid !== pin.versionUid ||
        wanted.weight !== pin.weight
      )
        throw new TypeError("accepted ordered Deployment vector differs");
      const version = await this.#source(pin.versionUid, this.#scope.version, execution, evidence, {
        generation: pin.versionGeneration,
      });
      if (
        object(version.spec.worker)?.resourceUid !== worker.workerUid ||
        (options.http &&
          !(Array.isArray(version.spec.handlers) && version.spec.handlers.includes("fetch")) &&
          !object(version.spec.assets))
      )
        throw new TypeError("Version owner/HTTP capability differs");
      await this.#references(
        version,
        [{ uid: worker.workerUid, formUrl: this.#scope.worker.formUrl, readiness: "observed" }],
        evidence,
      );
      const native = await this.#one(
        "tf_v2_worker_native_effects",
        "operation_id",
        String(version.operation.id),
      );
      if (
        !native ||
        native.resource_uid !== pin.versionUid ||
        native.principal !== execution.principal ||
        native.space !== execution.space ||
        native.backend_key !== version.operation.backend_key ||
        native.backend_id !== this.#scope.version.backendId ||
        native.target_key !== this.#scope.targetKey ||
        native.generation !== pin.versionGeneration ||
        native.native_identity !== pin.scriptName ||
        native.closure_digest !== pin.descriptorDigest ||
        native.confirmed_receipt !== pin.providerEtag
      )
        throw new TypeError("actual0074 release pin differs");
      evidence.add("tf_v2_worker_native_effects", native);
    }
  }

  async #binding(
    endpointUid: string,
    organizationId: string,
    evidence: FormRouteEvidence,
    retained = false,
  ): Promise<FormEndpointBinding> {
    const row = await this.#one(bindings, "endpoint_uid", endpointUid);
    const scope = this.#scope.endpoint;
    if (
      !row ||
      row.organization_id !== organizationId ||
      row.product !== "takoserver" ||
      row.endpoint_uid !== endpointUid ||
      row.form_url !== scope.formUrl ||
      row.backend_id !== scope.backendId ||
      row.target_key !== this.#scope.targetKey ||
      !formPositive(row.endpoint_generation) ||
      typeof row.incarnation !== "string" ||
      !/^[0-9a-f]{32}$/u.test(row.incarnation) ||
      !formText(row.reservation_id, 128) ||
      typeof row.name !== "string" ||
      normalizeSharedAppName(row.name) !== row.name ||
      typeof row.create_operation_id !== "string" ||
      !operationIdPattern.test(row.create_operation_id) ||
      typeof row.current_operation_id !== "string" ||
      !operationIdPattern.test(row.current_operation_id)
    )
      throw new TypeError("actual shared Endpoint binding unavailable");
    const pin: SharedAppFormV2EndpointBindingPin = Object.freeze({
      incarnation: row.incarnation,
      organizationId,
      product: "takoserver",
      reservationId: row.reservation_id,
      name: row.name,
      endpointUid,
      endpointGeneration: row.endpoint_generation,
      formUrl: scope.formUrl,
      backendId: scope.backendId,
      targetKey: this.#scope.targetKey,
      createOperationId: row.create_operation_id,
      currentOperationId: row.current_operation_id,
    });
    const owner = this.#owner(organizationId);
    const claim = await owner.readOriginalRoute(pin.reservationId);
    const held = claim ? formPin(claim) : null;
    if (
      !claim ||
      !held ||
      held.environment !== "staging" ||
      held.organizationId !== organizationId ||
      held.product !== "takoserver" ||
      held.reservationId !== pin.reservationId ||
      held.name !== pin.name ||
      held.incarnation !== pin.incarnation ||
      (!retained && (formReleasedAt(claim) !== null || formState(claim) === "released"))
    )
      throw new TypeError("actual shared assignment unavailable");
    const guard = formCurrent(claim);
    if ((await this.#reads.query(`SELECT 1 WHERE (${guard.sql})`, guard.params)).length !== 1)
      throw new TypeError("shared name is not the current original");
    evidence.add(bindings, row);
    return Object.freeze({ row, pin, owner, claim });
  }

  async #endpointLineage(
    execution: PublicationExecution,
    binding: SharedAppFormV2EndpointBindingPin,
    evidence: FormRouteEvidence,
  ): Promise<void> {
    const created = await this.#one("tf_v2_operations", "id", binding.createOperationId);
    const latest =
      binding.currentOperationId === binding.createOperationId
        ? created
        : await this.#one("tf_v2_operations", "id", binding.currentOperationId);
    for (const [operation, generation] of [
      [created, 1],
      [latest, binding.endpointGeneration],
    ] as const) {
      if (
        !operation ||
        operation.resource_uid !== binding.endpointUid ||
        operation.principal !== execution.principal ||
        operation.generation !== generation ||
        operation.backend_id !== this.#scope.endpoint.backendId ||
        operation.target_key !== this.#scope.targetKey ||
        operation.backend_key !== operation.id ||
        operation.accepted_spec_json !== execution.specJson ||
        (generation === 1 ? operation.action !== "create" : operation.action !== "update") ||
        (operation.id === execution.operationId
          ? !["running", "reconciling"].includes(String(operation.status))
          : !(
              (operation.status === "succeeded" && operation.effect === "complete") ||
              (operation.status === "failed" && operation.effect === "none")
            ))
      )
        throw new TypeError("Endpoint accepted lineage differs");
      evidence.add("tf_v2_operations", operation);
    }
    if (execution.action === "delete") {
      if (binding.endpointGeneration >= execution.generation)
        throw new TypeError("DELETE binding is not a predecessor");
      const lineage = formFailedEndpointOperations(
        execution,
        binding.endpointGeneration,
        execution.generation - 1,
        "delete",
      );
      if ((await this.#reads.query(`SELECT 1 WHERE (${lineage.sql})`, lineage.params)).length !== 1)
        throw new TypeError("DELETE predecessor has effects or a missing generation");
      evidence.require(lineage);
    } else if (
      binding.endpointGeneration !== execution.generation ||
      binding.currentOperationId !== execution.operationId
    )
      throw new TypeError("Endpoint command is not its accepted binding");
  }

  #makeBinding(
    hostRow: SharedAppNativeRouteRowPin,
    workerRow: SharedAppNativeRouteRowPin,
  ): SharedAppFormV2Binding {
    const host = formHostValue(hostRow, this.#scope.targetKey);
    const worker = formWorkerValue(workerRow, this.#scope.targetKey);
    if (
      host.workerUid !== worker.workerUid ||
      host.deploymentUid !== worker.deploymentUid ||
      host.deploymentGeneration !== worker.deploymentGeneration ||
      host.sourceOperationId !== worker.sourceOperationId
    )
      throw new TypeError("Host/Worker vector differs");
    return Object.freeze({
      kind: formRouteTag,
      endpoint: Object.freeze({ uid: host.endpointUid, generation: host.endpointGeneration }),
      workerUid: host.workerUid,
      deployment: Object.freeze({ uid: host.deploymentUid, generation: host.deploymentGeneration }),
      providerId: this.#scope.providerId,
      targetKey: this.#scope.targetKey,
      nativeSourceOperationId: host.sourceOperationId,
      hostRow,
      workerRow,
      releases: worker.releases,
    });
  }

  async #prior(
    binding: FormEndpointBinding,
    beforeHost: SharedAppNativeRouteRowPin | null,
    beforeWorker: SharedAppNativeRouteRowPin | null,
    execution: PublicationExecution,
    evidence: FormRouteEvidence,
  ): Promise<SharedAppFormV2Binding | null> {
    const pin = formPin(binding.claim);
    const previous = await onePublicationRow(
      this.#reads,
      `SELECT * FROM ${routeHistory} WHERE incarnation = ? AND next_generation = ?`,
      [pin.incarnation, pin.generation],
    );
    if (formState(binding.claim) === "reserved") {
      if (binding.claim.kind === "scalar") {
        if (beforeHost || previous || pin.generation !== 1)
          throw new TypeError("reserved original already has native/history effects");
        evidence.admit(
          statement(`NOT EXISTS (SELECT 1 FROM ${routeHistory} WHERE incarnation = ?)`, [
            pin.incarnation,
          ]),
        );
      } else {
        if (
          !previous ||
          typeof previous.command_ref !== "string" ||
          !beforeHost ||
          beforeHost.state !== "tombstone"
        )
          throw new TypeError("tagged reserved original lacks its immutable retirement");
        const receipt = await binding.owner.readFormV2RouteCommand(previous.command_ref);
        if (
          !receipt ||
          receipt.original.action !== "retire" ||
          !formEqual(receipt.assignment, binding.claim) ||
          !receipt.original.nativeAfter.some((row) => formEqual(row.row, beforeHost))
        )
          throw new TypeError("tagged retirement is not the current native predecessor");
        evidence.add(routeHistory, previous);
      }
      return null;
    }
    if (
      !previous ||
      previous.organization_id !== pin.organizationId ||
      previous.product !== "takoserver" ||
      previous.reservation_id !== pin.reservationId ||
      previous.name !== pin.name ||
      previous.next_state !== "active" ||
      previous.endpoint_uid !== binding.pin.endpointUid ||
      previous.provider_id !== this.#scope.providerId ||
      previous.target_key !== this.#scope.targetKey ||
      !beforeHost ||
      !beforeWorker
    )
      throw new TypeError("genuine prior route history is missing");
    const prior = this.#makeBinding(beforeHost, beforeWorker);
    if (prior.endpoint.uid !== binding.pin.endpointUid)
      throw new TypeError("prior Endpoint differs");
    if (binding.claim.kind === formRouteTag) {
      if (typeof previous.command_ref !== "string")
        throw new TypeError("invalid typed prior reference");
      const receipt = await binding.owner.readFormV2RouteCommand(previous.command_ref);
      if (
        !receipt ||
        !formEqual(receipt.assignment, binding.claim) ||
        !formEqual(binding.claim.binding, prior) ||
        !formEqual(receipt.original.nextBinding, prior)
      )
        throw new TypeError("typed prior native/history binding differs");
    } else if (
      previous.form_v2_original_json != null ||
      previous.next_script !== binding.claim.value.script ||
      prior.releases.length !== 1 ||
      prior.releases[0]?.weight !== 10_000 ||
      prior.releases[0]?.scriptName !== binding.claim.value.script ||
      previous.worker_uid !== prior.workerUid ||
      previous.deployment_uid !== prior.deployment.uid ||
      previous.deployment_generation !== prior.deployment.generation ||
      previous.endpoint_generation !== prior.endpoint.generation ||
      previous.command_ref !==
        `v2-host:${String(previous.source_operation_id)}:${hostname(pin.name)}`
    )
      throw new TypeError("scalar prior is not a genuine one-release publication");
    const confirmed = await onePublicationRow(
      this.#reads,
      `SELECT * FROM tf_v2_operations WHERE resource_uid = ? AND generation = ?`,
      [prior.endpoint.uid, prior.endpoint.generation],
    );
    const endpoint = await this.#one("tf_v2_resources", "uid", prior.endpoint.uid);
    if (
      !confirmed ||
      !endpoint ||
      confirmed.principal !== execution.principal ||
      confirmed.backend_id !== this.#scope.endpoint.backendId ||
      confirmed.target_key !== this.#scope.targetKey ||
      confirmed.backend_key !== confirmed.id ||
      confirmed.status !== "succeeded" ||
      confirmed.effect !== "complete" ||
      (confirmed.action !== "create" && confirmed.action !== "update") ||
      endpoint.form_url !== this.#scope.endpoint.formUrl ||
      endpoint.backend_id !== this.#scope.endpoint.backendId ||
      endpoint.target_key !== this.#scope.targetKey ||
      endpoint.principal !== execution.principal ||
      endpoint.space !== execution.space ||
      object(JSON.parse(String(confirmed.accepted_spec_json)))?.worker === undefined ||
      object(object(JSON.parse(String(confirmed.accepted_spec_json)))?.worker)?.resourceUid !==
        prior.workerUid ||
      (prior.endpoint.generation === 1 && confirmed.id !== binding.pin.createOperationId)
    )
      throw new TypeError("last confirmed Endpoint operation differs");
    if (execution.form === this.#scope.endpoint.formUrl) {
      if (confirmed.accepted_spec_json !== execution.specJson)
        throw new TypeError("Endpoint spec lineage differs");
      const through =
        execution.action === "delete" ? binding.pin.endpointGeneration : execution.generation - 1;
      const lineage = formFailedEndpointOperations(
        execution,
        prior.endpoint.generation,
        through,
        "update-or-delete",
      );
      if ((await this.#reads.query(`SELECT 1 WHERE (${lineage.sql})`, lineage.params)).length !== 1)
        throw new TypeError("intervening Endpoint operation has unconfirmed effects");
      evidence.require(lineage);
    }
    evidence.add(routeHistory, previous);
    evidence.add("tf_v2_operations", confirmed);
    evidence.add("tf_v2_resources", endpoint);
    if (endpoint.deleted_at !== null)
      throw new TypeError(
        "a deleted Endpoint without its own retirement history cannot authorize cleanup",
      );
    await this.#references(
      {
        resource: endpoint,
        operation: confirmed,
        spec: object(JSON.parse(String(confirmed.accepted_spec_json))) ?? {},
      },
      [{ uid: prior.workerUid, formUrl: this.#scope.worker.formUrl, readiness: "observed" }],
      evidence,
      true,
    );
    await this.#releases(
      formWorkerValue(beforeWorker, this.#scope.targetKey),
      execution,
      evidence,
      { historical: true, http: true },
    );
    return prior;
  }

  async #hosts(workerUid: string): Promise<readonly SharedAppNativeRouteRowPin[]> {
    const rows = await this.#reads.query(
      `SELECT * FROM ${nativeRoutes} WHERE provider_id = ? AND route_kind = 'host'
        AND owner_native_id = ? AND state = 'active' AND route_key LIKE 'host/v2/%'
        ORDER BY route_key LIMIT 2`,
      [this.#scope.providerId, `v2-worker:${workerUid}`],
    );
    if (rows.length > 1) throw new TypeError("more than one actual v2 host is attached");
    return Object.freeze(rows.map((row) => formRow(row, this.#scope.providerId)));
  }

  #hostInventory(workerUid: string, hosts: readonly SharedAppNativeRouteRowPin[]): SqlStatement {
    return statement(
      `EXISTS (SELECT 1 FROM json_each(?) captured WHERE
      (SELECT count(*) FROM ${nativeRoutes} actual WHERE actual.provider_id = json_extract(captured.value,'$.providerId')
        AND actual.route_kind = 'host' AND actual.owner_native_id = json_extract(captured.value,'$.ownerNativeId')
        AND actual.state = 'active' AND actual.route_key LIKE 'host/v2/%') = json_array_length(captured.value,'$.keys')
      AND NOT EXISTS (SELECT 1 FROM ${nativeRoutes} actual WHERE actual.provider_id = json_extract(captured.value,'$.providerId')
        AND actual.route_kind = 'host' AND actual.owner_native_id = json_extract(captured.value,'$.ownerNativeId')
        AND actual.state = 'active' AND actual.route_key LIKE 'host/v2/%'
        AND actual.route_key NOT IN (SELECT value FROM json_each(captured.value,'$.keys'))))`,
      [
        JSON.stringify([
          {
            providerId: this.#scope.providerId,
            ownerNativeId: `v2-worker:${workerUid}`,
            keys: hosts.map((row) => row.routeKey),
          },
        ]),
      ],
    );
  }

  async #attachments(
    workerUid: string,
    scope: FormRouteScope["endpoint"],
    execution: PublicationExecution,
    evidence: FormRouteEvidence,
  ): Promise<readonly Row[]> {
    const rows = await this.#reads.query(
      `SELECT * FROM tf_v2_resources WHERE form_url = ? AND principal = ? AND space = ?
        AND target_key = ? AND deleted_at IS NULL AND json_extract(spec_json,'$.worker.resourceUid') = ?
        ORDER BY uid LIMIT 2`,
      [scope.formUrl, execution.principal, execution.space, this.#scope.targetKey, workerUid],
    );
    if (rows.length > 1) throw new TypeError("multiple actual Worker attachments");
    for (const row of rows) evidence.add("tf_v2_resources", row);
    evidence.require(
      statement(
        `EXISTS (SELECT 1 FROM json_each(?) captured WHERE
      (SELECT count(*) FROM tf_v2_resources WHERE form_url=json_extract(captured.value,'$.formUrl')
        AND principal=json_extract(captured.value,'$.principal') AND space=json_extract(captured.value,'$.space')
        AND target_key=json_extract(captured.value,'$.targetKey') AND deleted_at IS NULL
        AND json_extract(spec_json,'$.worker.resourceUid')=json_extract(captured.value,'$.workerUid'))
        = json_extract(captured.value,'$.count'))`,
        [
          JSON.stringify([
            {
              formUrl: scope.formUrl,
              principal: execution.principal,
              space: execution.space,
              targetKey: this.#scope.targetKey,
              workerUid,
              count: rows.length,
            },
          ]),
        ],
      ),
    );
    return rows;
  }

  async #atom(
    writes: readonly SharedAppNativeRouteRowPin[],
    workerUid: string,
    dependencyWorker: SharedAppNativeRouteRowPin | null = null,
  ): Promise<{
    readonly before: readonly SharedAppNativeRouteSnapshot[];
    readonly after: readonly SharedAppNativeRouteSnapshot[];
  }> {
    const before: SharedAppNativeRouteSnapshot[] = [];
    const after: SharedAppNativeRouteSnapshot[] = [];
    for (const write of writes) {
      const previous = await this.#route(write.routeKind, write.routeKey);
      if (
        (previous && previous.ownerNativeId !== `v2-worker:${workerUid}`) ||
        write.ownerNativeId !== `v2-worker:${workerUid}` ||
        write.generation !== (previous?.generation ?? 0) + 1
      )
        throw new TypeError("native predecessor/next generation differs");
      if (previous) {
        if (previous.state === "tombstone") formTombstone(previous);
        else if (previous.routeKind === "worker") formWorkerValue(previous, this.#scope.targetKey);
        else formHostValue(previous, this.#scope.targetKey);
      }
      before.push(formSnapshot(previous, write));
      after.push(formSnapshot(write, write));
    }
    if (dependencyWorker) {
      if (writes.some((row) => nativeTuple(row) === nativeTuple(dependencyWorker)))
        throw new TypeError("dependency row is also a declared mutation");
      before.push(formSnapshot(dependencyWorker, dependencyWorker));
      after.push(formSnapshot(dependencyWorker, dependencyWorker));
      before.sort((left, right) => (nativeTuple(left) < nativeTuple(right) ? -1 : 1));
      after.sort((left, right) => (nativeTuple(left) < nativeTuple(right) ? -1 : 1));
    }
    if (before.length < 1 || before.length > 3) throw new TypeError("native atom cardinality");
    return Object.freeze({ before: Object.freeze(before), after: Object.freeze(after) });
  }

  #accepted(
    execution: PublicationExecution,
    kind: "endpoint" | "deployment",
  ): SharedAppFormV2AcceptedCommand {
    return Object.freeze({
      kind,
      action: execution.action,
      resourceUid: execution.resourceUid,
      generation: execution.generation,
      operationId: execution.operationId,
      formUrl: execution.form,
      backendId: execution.backendId,
      targetKey: execution.targetKey,
    });
  }

  async #replay(
    receipt: SharedAppFormV2RouteReceipt,
    execution: PublicationExecution,
    kind: "endpoint" | "deployment",
    writes: readonly SharedAppNativeRouteRowPin[],
    name: string,
  ): Promise<boolean> {
    const original = receipt.original;
    const mutations = original.nativeAfter
      .filter((after, index) => !formEqual(after.row, original.nativeBefore[index]?.row))
      .map((snapshot) => snapshot.row);
    const sameData =
      original.principal === execution.principal &&
      original.space === execution.space &&
      original.environment === "staging" &&
      original.product === "takoserver" &&
      formPin(original.expected).name === name &&
      original.endpointBinding.name === name &&
      original.commandRef === `v2-host:${execution.operationId}:${hostname(name)}` &&
      formEqual(original.accepted, this.#accepted(execution, kind)) &&
      formEqual(mutations, writes);
    if (!sameData) return false;
    return this.#historicalSource(execution, kind, name);
  }

  async #historicalSource(
    execution: PublicationExecution,
    kind: "endpoint" | "deployment",
    sharedName?: string,
  ): Promise<boolean> {
    const operation = await this.#one("tf_v2_operations", "id", execution.operationId);
    const resource = await this.#one("tf_v2_resources", "uid", execution.resourceUid);
    return Boolean(
      operation &&
        resource &&
        operation.id === execution.operationId &&
        operation.resource_uid === execution.resourceUid &&
        operation.principal === execution.principal &&
        operation.action === execution.action &&
        operation.generation === execution.generation &&
        operation.backend_id === execution.backendId &&
        operation.backend_key === execution.backendKey &&
        operation.target_key === execution.targetKey &&
        operation.accepted_spec_json === execution.specJson &&
        resource.uid === execution.resourceUid &&
        resource.principal === execution.principal &&
        resource.space === execution.space &&
        resource.name === execution.name &&
        resource.form_url === execution.form &&
        resource.backend_id === execution.backendId &&
        resource.target_key === execution.targetKey &&
        (kind !== "endpoint" ||
          sharedName === undefined ||
          (execution.name === sharedName &&
            execution.outputJson === formJson(address(sharedName)) &&
            (operation.result_output_json === null ||
              formJson(JSON.parse(String(operation.result_output_json))) ===
                execution.outputJson))),
    );
  }

  /** Read recorded originals before looking at today's native generation or claim. */
  async readRecordedEffects(execution: Readonly<V2Execution>): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "refused" }
    | {
        readonly kind: "shared";
        readonly preparations: readonly WorkerEndpointOriginV2FormRoutePreparation[];
      }
  > {
    let captured: PublicationExecution;
    let kind: "endpoint" | "deployment";
    let organizationId: string;
    try {
      // Capture every caller-owned value before the first await. This method
      // accepts no candidate rows, SQL, currentness witness or mutation grant.
      captured = capturePublicationExecution(execution);
      const endpoint =
        captured.form === this.#scope.endpoint.formUrl &&
        captured.backendId === this.#scope.endpoint.backendId;
      const deployment =
        captured.form === this.#scope.deployment.formUrl &&
        captured.backendId === this.#scope.deployment.backendId;
      if (endpoint === deployment) return { kind: "refused" };
      kind = endpoint ? "endpoint" : "deployment";
      organizationId = this.#organization(captured, kind);
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return { kind: "refused" };
      throw error;
    }
    try {
      if (!(await this.#historicalSource(captured, kind))) return { kind: "refused" };
      // A native atom has at most two host keys plus its Worker. Read across
      // organizations so corrupt foreign history for this globally unique
      // operation cannot be mistaken for absence in this owner. LIMIT 4 is a
      // refusal bound, never a first-host selection.
      const retained = await this.#reads.query(
        `SELECT * FROM ${routeHistory} WHERE source_operation_id = ?
        ORDER BY organization_id,name LIMIT 4`,
        [captured.operationId],
      );
      if (retained.length === 0) return { kind: "absent" };
      if (retained.length > 2 || (kind === "endpoint" && retained.length !== 1))
        return { kind: "refused" };
      const owner = this.#owner(organizationId);
      const preparations: FormRoutePreparation[] = [];
      const actualNames = new Set<string>();
      const expectedNames = new Set<string>();
      let first: SharedAppFormV2RouteOriginal | null = null;
      for (const row of retained) {
        if (
          row.organization_id !== organizationId ||
          row.product !== "takoserver" ||
          typeof row.command_ref !== "string" ||
          typeof row.name !== "string" ||
          actualNames.has(row.name) ||
          (kind === "endpoint" && row.name !== captured.name)
        )
          return { kind: "refused" };
        const receipt = await owner.readFormV2RouteCommand(row.command_ref);
        if (!receipt) return { kind: "refused" };
        const original = receipt.original;
        const mutations: SharedAppNativeRouteRowPin[] = [];
        for (let index = 0; index < original.nativeAfter.length; index++) {
          const snapshot = original.nativeAfter[index];
          if (!snapshot) return { kind: "refused" };
          if (formEqual(snapshot.row, original.nativeBefore[index]?.row)) continue;
          // Real owners retain tombstones; a missing after-row cannot become a
          // historical hard-delete mutation or authorize recreating that row.
          if (!snapshot.row) return { kind: "refused" };
          mutations.push(snapshot.row);
        }
        if (
          original.commandRef !== row.command_ref ||
          !(await this.#replay(receipt, captured, kind, mutations, row.name)) ||
          (first &&
            (!formEqual(first.nativeBefore, original.nativeBefore) ||
              !formEqual(first.nativeAfter, original.nativeAfter)))
        )
          return { kind: "refused" };
        first = original;
        actualNames.add(row.name);
        for (const snapshot of [...original.nativeBefore, ...original.nativeAfter]) {
          if (snapshot.routeKind !== "host" || snapshot.row?.state !== "active") continue;
          const native = formHostValue(snapshot.row, this.#scope.targetKey);
          const name = sharedAppStagingNameFromHost(native.hostname);
          if (name !== null) expectedNames.add(name);
        }
        // This existing nominal constructor defaults effects to undefined.
        // Its settleOriginal and fresh observe remain separate read-only paths.
        preparations.push(this.#preparation(owner, original));
      }
      if (
        expectedNames.size !== actualNames.size ||
        [...actualNames].some((name) => !expectedNames.has(name))
      )
        return { kind: "refused" };
      return { kind: "shared", preparations: Object.freeze(preparations) };
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return { kind: "refused" };
      throw error;
    }
  }

  #preparation(
    owner: FormRouteOwner,
    original: SharedAppFormV2RouteOriginal,
    effects?: SharedAppFormV2RouteEffects,
  ): FormRoutePreparation {
    return new FormRoutePreparation(formRouteKey, owner, original, effects, () =>
      this.#observe(owner, original),
    );
  }

  async #neverLive(
    owner: FormRouteOwner,
    claim: SharedAppRouteAssignment,
    binding: SharedAppFormV2EndpointBindingPin,
    execution: PublicationExecution,
    workerUid: string,
    inventory?: FormRouteEvidence,
  ): Promise<"retired" | "unknown"> {
    const now = await owner.readOriginalRoute(binding.reservationId);
    if (!now || !formEqual(now, claim)) return "unknown";
    const evidence = inventory ?? new FormRouteEvidence();
    const actualBinding = await this.#one(bindings, "endpoint_uid", binding.endpointUid);
    const resource = await this.#one("tf_v2_resources", "uid", binding.endpointUid);
    const operation = await this.#one("tf_v2_operations", "id", execution.operationId);
    if (
      !actualBinding ||
      !resource ||
      !operation ||
      !formEqual(this.#bindingPin(actualBinding), binding) ||
      resource.principal !== execution.principal ||
      resource.space !== execution.space ||
      resource.form_url !== this.#scope.endpoint.formUrl ||
      resource.backend_id !== this.#scope.endpoint.backendId ||
      resource.target_key !== this.#scope.targetKey ||
      resource.generation !== execution.generation ||
      resource.last_operation !== execution.operationId ||
      resource.spec_json !== execution.specJson ||
      operation.resource_uid !== binding.endpointUid ||
      operation.principal !== execution.principal ||
      operation.action !== "delete" ||
      operation.generation !== execution.generation ||
      operation.backend_key !== execution.backendKey ||
      operation.backend_id !== execution.backendId ||
      operation.target_key !== execution.targetKey ||
      operation.accepted_spec_json !== execution.specJson ||
      !(
        (operation.status === "succeeded" &&
          operation.effect === "complete" &&
          resource.busy_operation === null) ||
        (["running", "reconciling"].includes(String(operation.status)) &&
          operation.lease_token === execution.leaseToken &&
          resource.busy_operation === operation.id)
      )
    )
      return "unknown";
    evidence.add(bindings, actualBinding);
    evidence.add("tf_v2_resources", resource);
    evidence.add("tf_v2_operations", operation);
    const created = await this.#one("tf_v2_operations", "id", binding.createOperationId);
    const latest = await this.#one("tf_v2_operations", "id", binding.currentOperationId);
    for (const [row, generation] of [
      [created, 1],
      [latest, binding.endpointGeneration],
    ] as const) {
      if (
        !row ||
        row.resource_uid !== binding.endpointUid ||
        row.principal !== execution.principal ||
        row.generation !== generation ||
        row.backend_id !== execution.backendId ||
        row.target_key !== execution.targetKey ||
        row.backend_key !== row.id ||
        row.accepted_spec_json !== execution.specJson ||
        (generation === 1 ? row.action !== "create" : row.action !== "update") ||
        !(
          (row.status === "succeeded" && row.effect === "complete") ||
          (row.status === "failed" && row.effect === "none")
        )
      )
        return "unknown";
      evidence.add("tf_v2_operations", row);
    }
    const invariants = [
      formCurrent(now),
      formFailedEndpointOperations(execution, 1, binding.endpointGeneration, "update-or-delete"),
      formFailedEndpointOperations(
        execution,
        binding.endpointGeneration,
        execution.generation - 1,
        "delete",
      ),
      statement(`NOT EXISTS (SELECT 1 FROM ${routeHistory} WHERE incarnation = ?)`, [
        binding.incarnation,
      ]),
      formNativeGuard([
        formSnapshot(null, {
          providerId: this.#scope.providerId,
          routeKind: "host",
          routeKey: `host/v2/${hostname(binding.name)}`,
        }),
      ]),
      ...(inventory ? [] : [this.#hostInventory(workerUid, [])]),
    ];
    if (inventory) for (const invariant of invariants) inventory.require(invariant);
    const check = conjunction([evidence.guard(), ...invariants]);
    return (await this.#reads.query(`SELECT 1 WHERE (${check.sql})`, check.params)).length === 1
      ? "retired"
      : "unknown";
  }

  async #observe(
    owner: FormRouteOwner,
    original: SharedAppFormV2RouteOriginal,
  ): Promise<"confirmed" | "retired" | "unknown"> {
    const receipt = await owner.settleFormV2Route(original, "unknown");
    const now = await owner.readOriginalRoute(original.endpointBinding.reservationId);
    if (!now || !formEqual(now, receipt.assignment)) return "unknown";
    const evidence = new FormRouteEvidence();
    const actualBinding = await this.#one(
      bindings,
      "endpoint_uid",
      original.endpointBinding.endpointUid,
    );
    if (!actualBinding || !formEqual(this.#bindingPin(actualBinding), original.endpointBinding))
      return "unknown";
    evidence.add(bindings, actualBinding);
    const resource = await this.#one("tf_v2_resources", "uid", original.accepted.resourceUid);
    const operation = await this.#one("tf_v2_operations", "id", original.accepted.operationId);
    if (
      !resource ||
      !operation ||
      resource.last_operation !== operation.id ||
      resource.generation !== original.accepted.generation ||
      operation.resource_uid !== resource.uid ||
      operation.generation !== original.accepted.generation ||
      operation.action !== original.accepted.action ||
      resource.form_url !== original.accepted.formUrl ||
      resource.backend_id !== original.accepted.backendId ||
      resource.target_key !== original.accepted.targetKey ||
      resource.principal !== original.principal ||
      resource.space !== original.space ||
      operation.principal !== original.principal ||
      operation.backend_id !== original.accepted.backendId ||
      operation.target_key !== original.accepted.targetKey ||
      operation.backend_key !== original.accepted.operationId ||
      !(
        (operation.status === "succeeded" &&
          operation.effect === "complete" &&
          resource.busy_operation === null) ||
        (["running", "reconciling"].includes(String(operation.status)) &&
          resource.busy_operation === operation.id)
      )
    )
      return "unknown";
    evidence.add("tf_v2_resources", resource);
    evidence.add("tf_v2_operations", operation);
    const execution: PublicationExecution = Object.freeze({
      operationId: String(operation.id),
      resourceUid: String(resource.uid),
      principal: original.principal,
      space: original.space,
      name: String(resource.name),
      form: String(resource.form_url),
      backendId: String(resource.backend_id),
      backendKey: String(operation.backend_key),
      targetKey: String(resource.target_key),
      leaseToken: typeof operation.lease_token === "string" ? operation.lease_token : "",
      action: original.accepted.action,
      generation: original.accepted.generation,
      specJson: String(operation.accepted_spec_json),
      outputJson: String(resource.output_json),
    });
    const live = original.nextBinding;
    if (live) {
      const worker = formWorkerValue(live.workerRow, this.#scope.targetKey);
      await this.#releases(worker, execution, evidence, {
        prospective: operation.status !== "succeeded" && original.accepted.kind === "deployment",
        http: true,
      });
      const endpoint = await this.#source(
        live.endpoint.uid,
        this.#scope.endpoint,
        execution,
        evidence,
        {
          generation: live.endpoint.generation,
          claimed: operation.status !== "succeeded" && original.accepted.kind === "endpoint",
        },
      );
      if (
        object(endpoint.spec.worker)?.resourceUid !== live.workerUid ||
        String(endpoint.resource.output_json) !== formJson(address(original.endpointBinding.name))
      )
        return "unknown";
      await this.#references(
        endpoint,
        [{ uid: live.workerUid, formUrl: this.#scope.worker.formUrl, readiness: "observed" }],
        evidence,
        true,
      );
    }
    const observedWorkerUid = (original.nextBinding ?? original.priorBinding)?.workerUid;
    if (!observedWorkerUid) return "unknown";
    const activeHosts = original.nativeAfter.flatMap((snapshot) =>
      snapshot.routeKind === "host" && snapshot.row?.state === "active" ? [snapshot.row] : [],
    );
    if (live) {
      const endpoints = await this.#attachments(
        live.workerUid,
        this.#scope.endpoint,
        execution,
        evidence,
      );
      if (endpoints.length !== 1 || endpoints[0]?.uid !== live.endpoint.uid) return "unknown";
    }
    const check = conjunction([
      formCurrent(now),
      evidence.guard(),
      formNativeGuard(original.nativeAfter),
      this.#hostInventory(observedWorkerUid, activeHosts),
    ]);
    return (await this.#reads.query(`SELECT 1 WHERE (${check.sql})`, check.params)).length === 1
      ? original.action === "retire"
        ? "retired"
        : "confirmed"
      : "unknown";
  }

  #bindingPin(row: Row): SharedAppFormV2EndpointBindingPin {
    // Called only on fixed DB columns, and compared with an already decoded original.
    return Object.freeze({
      incarnation: String(row.incarnation),
      organizationId: String(row.organization_id),
      product: row.product as SharedAppFormV2EndpointBindingPin["product"],
      reservationId: String(row.reservation_id),
      name: String(row.name),
      endpointUid: String(row.endpoint_uid),
      endpointGeneration: Number(row.endpoint_generation),
      formUrl: String(row.form_url),
      backendId: String(row.backend_id),
      targetKey: String(row.target_key),
      createOperationId: String(row.create_operation_id),
      currentOperationId: String(row.current_operation_id),
    });
  }

  /** The raw candidate is data; actual Core,0074,prior history and fixed SQL grant nothing from it alone. */
  async prepareEndpointFormV2(
    execution: Readonly<V2Execution>,
    declaredNativeRows: WorkerEndpointOriginV2FormRouteNativeRows,
  ): Promise<WorkerEndpointOriginV2FormRouteEndpointResult> {
    let captured: PublicationExecution;
    let writes: readonly SharedAppNativeRouteRowPin[];
    let organizationId: string;
    try {
      captured = capturePublicationExecution(execution);
      writes = captureFormNativeRows(declaredNativeRows, this.#scope.providerId);
      organizationId = this.#organization(captured, "endpoint");
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return { kind: "refused" };
      throw error;
    }
    try {
      return await this.#endpoint(captured, writes, organizationId);
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return { kind: "refused" };
      throw error;
    }
  }

  async #endpoint(
    execution: PublicationExecution,
    writes: readonly SharedAppNativeRouteRowPin[],
    organizationId: string,
  ): Promise<WorkerEndpointOriginV2FormRouteEndpointResult> {
    const actualBinding = await this.#one(bindings, "endpoint_uid", execution.resourceUid);
    const output = object(JSON.parse(execution.outputJson));
    if (!actualBinding && sharedAppStagingNameFromHost(output?.hostname) === null) {
      const previous = await this.#reads.query(
        `SELECT 1 FROM ${routeHistory} WHERE endpoint_uid = ? LIMIT 1`,
        [execution.resourceUid],
      );
      return { kind: previous.length === 0 ? "ordinary" : "refused" };
    }
    const host = hostname(execution.name);
    const commandRef = `v2-host:${execution.operationId}:${host}`;
    const owner = this.#owner(organizationId);
    const replay = await owner.readFormV2RouteCommand(commandRef);
    if (replay)
      return (await this.#replay(replay, execution, "endpoint", writes, execution.name))
        ? { kind: "shared", preparation: this.#preparation(owner, replay.original) }
        : { kind: "refused" };
    if (!actualBinding) return { kind: "refused" };
    const evidence = new FormRouteEvidence();
    await this.#owns(execution, evidence);
    const binding = await this.#binding(execution.resourceUid, organizationId, evidence);
    if (
      binding.pin.name !== execution.name ||
      execution.outputJson !== formJson(address(execution.name))
    )
      throw new TypeError("accepted Endpoint address differs");
    await this.#endpointLineage(execution, binding.pin, evidence);
    const spec = formRecord(JSON.parse(execution.specJson), ["worker"]);
    const workerUid = object(spec.worker)?.resourceUid;
    if (typeof workerUid !== "string" || !formUid.test(workerUid))
      throw new TypeError("invalid accepted Worker reference");
    const source = {
      resource: (await this.#one("tf_v2_resources", "uid", execution.resourceUid)) ?? {},
      operation: (await this.#one("tf_v2_operations", "id", execution.operationId)) ?? {},
      spec,
    };
    // DELETE has no new sealed set; the last accepted binding supplies its unchanged exact references.
    if (execution.action !== "delete")
      await this.#references(
        source,
        [{ uid: workerUid, formUrl: this.#scope.worker.formUrl, readiness: "observed" }],
        evidence,
        true,
      );
    const attachments = await this.#attachments(
      workerUid,
      this.#scope.endpoint,
      execution,
      evidence,
    );
    if (attachments.length !== 1 || attachments[0]?.uid !== execution.resourceUid)
      throw new TypeError("Endpoint is not the unique actual Worker attachment");
    const beforeHost = await this.#route("host", `host/v2/${host}`);
    const beforeWorker = await this.#route("worker", `worker/v2/${workerUid}`);
    const hosts = await this.#hosts(workerUid);
    if (hosts.some((row) => row.routeKey !== `host/v2/${host}`))
      throw new TypeError("another native host is attached");
    if (
      execution.action === "delete" &&
      writes.length === 0 &&
      !beforeHost &&
      formState(binding.claim) === "reserved" &&
      binding.claim.kind === "scalar" &&
      formPin(binding.claim).generation === 1
    ) {
      const lineage = formFailedEndpointOperations(
        execution,
        1,
        binding.pin.endpointGeneration,
        "update-or-delete",
      );
      const noHistory = statement(
        `NOT EXISTS (SELECT 1 FROM ${routeHistory} WHERE incarnation = ?)`,
        [binding.pin.incarnation],
      );
      const readback = conjunction([
        evidence.guard(),
        lineage,
        noHistory,
        formCurrent(binding.claim),
        formNativeGuard([
          formSnapshot(null, {
            providerId: this.#scope.providerId,
            routeKind: "host",
            routeKey: `host/v2/${host}`,
          }),
        ]),
        this.#hostInventory(workerUid, []),
      ]);
      if (
        (await this.#reads.query(`SELECT 1 WHERE (${readback.sql})`, readback.params)).length !== 1
      )
        throw new TypeError("never-live removal has partial or unknown effects");
      return {
        kind: "shared",
        preparation: new FormRoutePreparation(formRouteKey, owner, null, undefined, () =>
          this.#neverLive(owner, binding.claim, binding.pin, execution, workerUid),
        ),
      };
    }
    if (
      writes.length !== 1 ||
      writes[0]?.routeKind !== "host" ||
      writes[0].routeKey !== `host/v2/${host}` ||
      !beforeWorker
    )
      throw new TypeError(
        "Endpoint must declare its whole host mutation and existing Worker dependency",
      );
    const prior = await this.#prior(binding, beforeHost, beforeWorker, execution, evidence);
    const removing = execution.action === "delete";
    const nextHost = writes[0];
    if (removing) {
      if (!prior || nextHost.operationId !== `v2-host:${execution.operationId}:${host}`)
        throw new TypeError("DELETE does not own a confirmed prior route");
      formTombstone(nextHost);
    } else {
      const value = formHostValue(nextHost, this.#scope.targetKey);
      if (
        value.endpointUid !== execution.resourceUid ||
        value.endpointGeneration !== execution.generation ||
        value.hostname !== host ||
        value.workerUid !== workerUid
      )
        throw new TypeError("next Endpoint fields differ");
      await this.#releases(
        formWorkerValue(beforeWorker, this.#scope.targetKey),
        execution,
        evidence,
        { http: true },
      );
      // An initial failed CREATE/UPDATE chain is not an invented successful predecessor.
      if (!prior && binding.claim.kind === "scalar" && execution.action === "update") {
        const created = await this.#one("tf_v2_operations", "id", binding.pin.createOperationId);
        if (created?.status !== "failed" || created.effect !== "none")
          throw new TypeError("initial CREATE is not no-effect");
        const lineage = formFailedEndpointOperations(
          execution,
          1,
          execution.generation - 1,
          "update-or-delete",
        );
        if (
          (await this.#reads.query(`SELECT 1 WHERE (${lineage.sql})`, lineage.params)).length !== 1
        )
          throw new TypeError("first publication crosses an unconfirmed operation");
        evidence.require(lineage);
      }
    }
    const atom = await this.#atom(writes, workerUid, beforeWorker);
    const next = removing ? null : this.#makeBinding(nextHost, beforeWorker);
    const action = removing ? "retire" : prior ? "advance" : "activate";
    const guards = {
      admission: conjunction([
        evidence.guard(true),
        formNativeGuard(atom.before),
        this.#hostInventory(workerUid, hosts),
      ]),
      publication: conjunction([
        evidence.guard(),
        formNativeGuard(atom.after),
        this.#hostInventory(workerUid, removing ? [] : writes),
      ]),
    };
    const effects = owner.prepareFormV2Route(
      action,
      {
        commandRef,
        principal: execution.principal,
        space: execution.space,
        expected: binding.claim,
        accepted: this.#accepted(execution, "endpoint"),
        endpointBinding: binding.pin,
        priorBinding: prior,
        nextBinding: next,
        nativeBefore: atom.before,
        nativeAfter: atom.after,
      },
      guards,
    );
    return { kind: "shared", preparation: this.#preparation(owner, effects.original, effects) };
  }

  async prepareDeployment(
    execution: Readonly<V2Execution>,
    declaredNativeRows: WorkerEndpointOriginV2FormRouteNativeRows,
  ): Promise<WorkerEndpointOriginV2FormRouteDeploymentResult> {
    let captured: PublicationExecution;
    let writes: readonly SharedAppNativeRouteRowPin[];
    let organizationId: string;
    try {
      captured = capturePublicationExecution(execution);
      writes = captureFormNativeRows(declaredNativeRows, this.#scope.providerId);
      organizationId = this.#organization(captured, "deployment");
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return { kind: "refused" };
      throw error;
    }
    try {
      return await this.#deployment(captured, writes, organizationId);
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return { kind: "refused" };
      throw error;
    }
  }

  async #retainedAdoptions(
    workerUid: string,
    execution: PublicationExecution,
    organizationId: string,
    evidence: FormRouteEvidence,
    affected: ReadonlyMap<string, { endpointUid: string; next: boolean }>,
    beforeWorker: SharedAppNativeRouteRowPin | null,
  ): Promise<void> {
    const source = formAdoptionInventorySql();
    const inventory = await this.#reads.query(
      `${source}
      SELECT incarnation,endpoint_uid FROM form_route_inventory ORDER BY incarnation,endpoint_uid`,
      [JSON.stringify([{ workerUid }])],
    );
    const seen = new Set<string>();
    const identities = inventory.map((row) => {
      if (
        typeof row.incarnation !== "string" ||
        !/^[0-9a-f]{32}$/u.test(row.incarnation) ||
        typeof row.endpoint_uid !== "string" ||
        !formUid.test(row.endpoint_uid) ||
        seen.has(row.incarnation)
      )
        throw new TypeError("ambiguous retained shared Endpoint inventory");
      seen.add(row.incarnation);
      return Object.freeze({ incarnation: row.incarnation, endpointUid: row.endpoint_uid });
    });
    evidence.require(
      statement(
        `EXISTS (${source}
      SELECT 1 FROM form_route_inventory_context captured
      WHERE (SELECT count(*) FROM form_route_inventory)=json_array_length(captured.value,'$.identities')
      AND NOT EXISTS (SELECT 1 FROM form_route_inventory actual WHERE NOT EXISTS
        (SELECT 1 FROM json_each(captured.value,'$.identities') expected
         WHERE actual.incarnation=json_extract(expected.value,'$.incarnation')
           AND actual.endpoint_uid=json_extract(expected.value,'$.endpointUid'))))`,
        [JSON.stringify([{ workerUid, identities }])],
      ),
    );
    if (identities.length !== 0) {
      const worker = formNativeGuard([
        formSnapshot(beforeWorker, {
          providerId: this.#scope.providerId,
          routeKind: "worker",
          routeKey: `worker/v2/${workerUid}`,
        }),
      ]);
      // Ordinary retirement inventory also fences the actual Worker custody.
      // Shared atoms mutate it, so their existing full before/after atom guards
      // retain this predecessor fence only on admission.
      if (affected.size === 0) evidence.require(worker);
      else evidence.admit(worker);
    }
    for (const identity of identities) {
      const binding = await this.#binding(identity.endpointUid, organizationId, evidence, true);
      if (binding.pin.incarnation !== identity.incarnation)
        throw new TypeError("retained history/assignment has no matching actual binding");
      const endpoint = await this.#one("tf_v2_resources", "uid", identity.endpointUid);
      const operation =
        typeof endpoint?.last_operation === "string"
          ? await this.#one("tf_v2_operations", "id", endpoint.last_operation)
          : null;
      if (
        !endpoint ||
        !operation ||
        endpoint.principal !== execution.principal ||
        endpoint.space !== execution.space ||
        endpoint.name !== binding.pin.name ||
        endpoint.form_url !== this.#scope.endpoint.formUrl ||
        endpoint.backend_id !== this.#scope.endpoint.backendId ||
        endpoint.target_key !== this.#scope.targetKey ||
        object(object(JSON.parse(String(endpoint.spec_json)))?.worker)?.resourceUid !== workerUid ||
        !formPositive(endpoint.generation) ||
        endpoint.phase !== "idle" ||
        endpoint.busy_operation !== null ||
        endpoint.observed_generation !== endpoint.generation ||
        operation.resource_uid !== identity.endpointUid ||
        operation.principal !== execution.principal ||
        operation.generation !== endpoint.generation ||
        operation.backend_id !== this.#scope.endpoint.backendId ||
        operation.target_key !== this.#scope.targetKey ||
        operation.backend_key !== operation.id ||
        operation.accepted_spec_json !== endpoint.spec_json ||
        operation.status !== "succeeded" ||
        operation.effect !== "complete" ||
        (endpoint.deleted_at === null
          ? !["create", "update"].includes(String(operation.action)) ||
            operation.id !== binding.pin.currentOperationId ||
            operation.generation !== binding.pin.endpointGeneration
          : operation.action !== "delete")
      )
        throw new TypeError("retained adopted Endpoint has no exact confirmed Core owner");
      evidence.add("tf_v2_resources", endpoint);
      evidence.add("tf_v2_operations", operation);
      const held = formCurrent(binding.claim);
      if (affected.has(binding.pin.name)) evidence.admit(held);
      else evidence.require(held);
      const hostKey = `host/v2/${hostname(binding.pin.name)}`;
      const host = await this.#route("host", hostKey);
      if (formState(binding.claim) === "active") {
        // Native absence must not erase a surviving active assignment or its
        // mandatory publication history, even when Core's row is deleted.
        await this.#prior(binding, host, beforeWorker, execution, evidence);
        if (!affected.has(binding.pin.name))
          throw new TypeError("active shared original escaped the native affected set");
        continue;
      }
      const pin = formPin(binding.claim);
      const latest = await onePublicationRow(
        this.#reads,
        `SELECT * FROM ${routeHistory} WHERE incarnation = ? ORDER BY next_generation DESC LIMIT 1`,
        [pin.incarnation],
      );
      if (!latest) {
        const fresh =
          binding.claim.kind === "scalar" &&
          formState(binding.claim) === "reserved" &&
          pin.generation === 1;
        if (!fresh || host)
          throw new TypeError("retained original lacks its native/history custody");
        const noHistory = statement(
          `NOT EXISTS (SELECT 1 FROM ${routeHistory} WHERE incarnation = ?)`,
          [pin.incarnation],
        );
        if (affected.has(binding.pin.name)) {
          evidence.admit(noHistory);
          continue;
        }
        if (endpoint.deleted_at === null || operation.action !== "delete")
          throw new TypeError("unresolved shared intent cannot become ordinary");
        const removed: PublicationExecution = Object.freeze({
          operationId: String(operation.id),
          resourceUid: identity.endpointUid,
          principal: execution.principal,
          space: execution.space,
          name: binding.pin.name,
          form: this.#scope.endpoint.formUrl,
          backendId: this.#scope.endpoint.backendId,
          backendKey: String(operation.backend_key),
          targetKey: this.#scope.targetKey,
          leaseToken: typeof operation.lease_token === "string" ? operation.lease_token : "",
          action: "delete",
          generation: Number(endpoint.generation),
          specJson: String(operation.accepted_spec_json),
          outputJson: String(endpoint.output_json),
        });
        if (
          (await this.#neverLive(
            binding.owner,
            binding.claim,
            binding.pin,
            removed,
            workerUid,
            evidence,
          )) !== "retired"
        )
          throw new TypeError("retained no-history original is not genuinely never-live");
        continue;
      }
      const retiredGeneration =
        formState(binding.claim) === "released" ? pin.generation - 1 : pin.generation;
      if (
        latest.next_generation !== retiredGeneration ||
        latest.next_state !== "reserved" ||
        latest.action !== "retire" ||
        typeof latest.command_ref !== "string" ||
        latest.worker_uid !== workerUid ||
        latest.endpoint_uid !== identity.endpointUid ||
        latest.provider_id !== this.#scope.providerId ||
        latest.target_key !== this.#scope.targetKey ||
        !host ||
        host.state !== "tombstone" ||
        !beforeWorker ||
        beforeWorker.ownerNativeId !== `v2-worker:${workerUid}`
      )
        throw new TypeError("retained original is neither an active route nor a proven retirement");
      formTombstone(host);
      if (beforeWorker.state === "active") formWorkerValue(beforeWorker, this.#scope.targetKey);
      else formTombstone(beforeWorker);
      const expected =
        binding.claim.kind === "scalar"
          ? {
              ...binding.claim.value,
              generation: retiredGeneration,
              state: "reserved",
              releasedAt: null,
            }
          : {
              ...binding.claim,
              pin: { ...pin, generation: retiredGeneration },
              state: "reserved",
              releasedAt: null,
              binding: null,
            };
      if (binding.claim.kind === formRouteTag) {
        const receipt = await binding.owner.readFormV2RouteCommand(latest.command_ref);
        const expectedHost = receipt?.original.nativeAfter.find(
          (row) => row.routeKind === "host" && row.routeKey === hostKey,
        )?.row;
        if (
          !receipt ||
          receipt.original.action !== "retire" ||
          !formEqual(receipt.assignment, expected) ||
          !formEqual(receipt.original.endpointBinding, binding.pin) ||
          !formEqual(expectedHost, host)
        )
          throw new TypeError(
            "retained typed retirement differs from actual native/history custody",
          );
      } else {
        const receipt = await binding.owner.readRouteCommand(latest.command_ref);
        if (
          !receipt ||
          receipt.original.action !== "retire" ||
          !formEqual(receipt.assignment, expected) ||
          receipt.original.endpointUid !== identity.endpointUid ||
          receipt.original.workerUid !== workerUid ||
          receipt.original.providerId !== this.#scope.providerId ||
          receipt.original.targetKey !== this.#scope.targetKey ||
          host.ownerNativeId !== `v2-worker:${workerUid}` ||
          host.operationId !==
            `v2-host:${receipt.original.sourceOperationId}:${hostname(binding.pin.name)}`
        )
          throw new TypeError(
            "retained scalar retirement differs from actual native/history custody",
          );
      }
      evidence.add(routeHistory, latest);
      const last = statement(
        `NOT EXISTS (SELECT 1 FROM ${routeHistory} WHERE incarnation = ? AND next_generation > ?)`,
        [pin.incarnation, retiredGeneration],
      );
      const native = formNativeGuard([formSnapshot(host, host)]);
      if (affected.has(binding.pin.name)) {
        evidence.admit(last);
        evidence.admit(native);
      } else {
        evidence.require(last);
        evidence.require(native);
      }
    }
  }

  async #deployment(
    execution: PublicationExecution,
    writes: readonly SharedAppNativeRouteRowPin[],
    organizationId: string,
  ): Promise<WorkerEndpointOriginV2FormRouteDeploymentResult> {
    const owner = this.#owner(organizationId);
    const retained = await this.#reads.query(
      `SELECT * FROM ${routeHistory}
      WHERE organization_id = ? AND source_operation_id = ? ORDER BY name`,
      [organizationId, execution.operationId],
    );
    if (retained.length) {
      // An entire historical multi-host atom is recovered before any current claim
      // lookup. Partial history cannot authorize finishing the other half later.
      const preparations: FormRoutePreparation[] = [];
      let first: SharedAppFormV2RouteOriginal | null = null;
      const expectedNames = new Set<string>();
      for (const row of retained) {
        if (typeof row.command_ref !== "string" || typeof row.name !== "string")
          throw new TypeError("malformed Deployment history");
        const receipt = await owner.readFormV2RouteCommand(row.command_ref);
        if (!receipt || !(await this.#replay(receipt, execution, "deployment", writes, row.name)))
          throw new TypeError("Deployment replay differs from its original atom");
        if (
          first &&
          (!formEqual(first.nativeBefore, receipt.original.nativeBefore) ||
            !formEqual(first.nativeAfter, receipt.original.nativeAfter))
        )
          throw new TypeError("Deployment originals disagree about their atom");
        first = receipt.original;
        for (const snapshot of [...first.nativeBefore, ...first.nativeAfter]) {
          if (snapshot.routeKind !== "host" || snapshot.row?.state !== "active") continue;
          const native = formHostValue(snapshot.row, this.#scope.targetKey);
          const name = sharedAppStagingNameFromHost(native.hostname);
          if (name !== null) expectedNames.add(name);
        }
        preparations.push(this.#preparation(owner, receipt.original));
      }
      if (
        expectedNames.size !== retained.length ||
        retained.some((row) => !expectedNames.has(String(row.name)))
      )
        throw new TypeError("partial shared Deployment command history");
      return { kind: "shared", preparations: Object.freeze(preparations) };
    }
    const evidence = new FormRouteEvidence();
    await this.#owns(execution, evidence);
    const spec = formRecord(JSON.parse(execution.specJson), ["worker", "versions"]);
    const workerUid = object(spec.worker)?.resourceUid;
    if (typeof workerUid !== "string" || !formUid.test(workerUid))
      throw new TypeError("invalid Deployment Worker");
    const deployments = await this.#attachments(
      workerUid,
      this.#scope.deployment,
      execution,
      evidence,
    );
    if (deployments.length !== 1 || deployments[0]?.uid !== execution.resourceUid)
      throw new TypeError("Deployment is not the actual unique attachment");
    const endpoints = await this.#attachments(workerUid, this.#scope.endpoint, execution, evidence);
    let nextEndpoint: FormSource | null = null;
    let nextHostname: string | null = null;
    if (execution.action !== "delete" && endpoints[0]) {
      nextEndpoint = await this.#source(
        String(endpoints[0].uid),
        this.#scope.endpoint,
        execution,
        evidence,
      );
      await this.#references(
        nextEndpoint,
        [{ uid: workerUid, formUrl: this.#scope.worker.formUrl, readiness: "observed" }],
        evidence,
        true,
      );
      const output = object(JSON.parse(String(nextEndpoint.resource.output_json)));
      if (
        typeof output?.hostname !== "string" ||
        output.url !== `https://${output.hostname}/` ||
        output.hostname.length > 253
      )
        throw new TypeError("actual Endpoint output is not a host address");
      nextHostname = output.hostname;
    }
    const beforeWorker = await this.#route("worker", `worker/v2/${workerUid}`);
    const hosts = await this.#hosts(workerUid);
    for (const host of hosts) {
      const value = formHostValue(host, this.#scope.targetKey);
      if (value.workerUid !== workerUid || !beforeWorker)
        throw new TypeError("orphan or foreign native host");
      this.#makeBinding(host, beforeWorker);
    }
    const affected = new Map<string, { endpointUid: string; next: boolean }>();
    for (const host of hosts) {
      const native = formHostValue(host, this.#scope.targetKey);
      const name = sharedAppStagingNameFromHost(native.hostname);
      const existing = await this.#one(bindings, "endpoint_uid", native.endpointUid);
      if (name !== null) {
        if (!existing || existing.name !== name)
          throw new TypeError("shared old host has no actual binding");
        affected.set(name, { endpointUid: native.endpointUid, next: false });
      } else if (existing)
        throw new TypeError("an adopted Endpoint has a non-shared native address");
    }
    if (nextEndpoint && nextHostname) {
      const name = sharedAppStagingNameFromHost(nextHostname);
      const existing = await this.#one(bindings, "endpoint_uid", String(nextEndpoint.resource.uid));
      if (name !== null) {
        if (
          !existing ||
          existing.name !== name ||
          String(nextEndpoint.resource.output_json) !== formJson(address(name))
        )
          throw new TypeError("shared next host has no actual accepted binding");
        const previous = affected.get(name);
        if (previous && previous.endpointUid !== nextEndpoint.resource.uid)
          throw new TypeError("one name has two Endpoint owners");
        affected.set(name, { endpointUid: String(nextEndpoint.resource.uid), next: true });
      } else if (existing)
        throw new TypeError("an adopted Endpoint has a non-shared accepted address");
    }
    await this.#retainedAdoptions(
      workerUid,
      execution,
      organizationId,
      evidence,
      affected,
      beforeWorker,
    );
    if (affected.size === 0) {
      const ordinary = evidence.guard();
      return {
        kind:
          (await this.#reads.query(`SELECT 1 WHERE (${ordinary.sql})`, ordinary.params)).length ===
          1
            ? "ordinary"
            : "refused",
      };
    }
    if (writes.length < 1) throw new TypeError("shared Deployment omitted its native atom");
    const expectedKeys = new Set<string>([`worker\0worker/v2/${workerUid}`]);
    for (const host of hosts)
      if (host.routeKey !== (nextHostname ? `host/v2/${nextHostname}` : null))
        expectedKeys.add(nativeTuple(host));
    if (nextHostname) expectedKeys.add(`host\0host/v2/${nextHostname}`);
    const orderedKeys = [...expectedKeys].sort();
    if (!formEqual(writes.map(nativeTuple), orderedKeys))
      throw new TypeError("Deployment native rows are omitted or extra");
    const nextWorker = writes.find((row) => row.routeKind === "worker");
    if (
      !nextWorker ||
      nextWorker.ownerNativeId !== `v2-worker:${workerUid}` ||
      nextWorker.operationId !== `v2-worker:${execution.operationId}`
    )
      throw new TypeError("Deployment Worker write identity differs");
    if (execution.action === "delete") {
      if (!beforeWorker) throw new TypeError("Deployment has no Worker predecessor to remove");
      formTombstone(nextWorker);
    } else {
      const worker = formWorkerValue(nextWorker, this.#scope.targetKey);
      if (
        worker.workerUid !== workerUid ||
        worker.deploymentUid !== execution.resourceUid ||
        worker.deploymentGeneration !== execution.generation ||
        worker.sourceOperationId !== execution.operationId
      )
        throw new TypeError("Deployment prospective Worker differs");
      await this.#releases(worker, execution, evidence, {
        prospective: true,
        http: nextEndpoint !== null,
      });
    }
    let nextHost: SharedAppNativeRouteRowPin | null = null;
    for (const write of writes) {
      if (write.routeKind !== "host") continue;
      const host = write.routeKey.slice("host/v2/".length);
      if (write.operationId !== `v2-host:${execution.operationId}:${host}`)
        throw new TypeError("Deployment host write has a substituted source");
      if (nextEndpoint && nextHostname === host) {
        const native = formHostValue(write, this.#scope.targetKey);
        if (
          native.hostname !== nextHostname ||
          native.endpointUid !== nextEndpoint.resource.uid ||
          native.endpointGeneration !== nextEndpoint.operation.generation ||
          native.workerUid !== workerUid ||
          native.deploymentUid !== execution.resourceUid ||
          native.deploymentGeneration !== execution.generation ||
          native.sourceOperationId !== execution.operationId
        )
          throw new TypeError("Deployment next host fields differ");
        nextHost = write;
      } else {
        if (!hosts.some((previous) => previous.routeKey === write.routeKey))
          throw new TypeError("invented old host removal");
        formTombstone(write);
      }
    }
    if ((nextEndpoint !== null) !== (nextHost !== null))
      throw new TypeError("Deployment next host mutation is missing");
    const atom = await this.#atom(writes, workerUid);
    const plans: {
      binding: FormEndpointBinding;
      prior: SharedAppFormV2Binding | null;
      next: SharedAppFormV2Binding | null;
      name: string;
    }[] = [];
    for (const [name, host] of [...affected].sort(([left], [right]) => (left < right ? -1 : 1))) {
      const binding = await this.#binding(host.endpointUid, organizationId, evidence);
      if (binding.pin.name !== name) throw new TypeError("affected shared binding name differs");
      const oldHost =
        atom.before.find(
          (row) => row.routeKind === "host" && row.routeKey === `host/v2/${hostname(name)}`,
        )?.row ?? null;
      const prior = await this.#prior(binding, oldHost, beforeWorker, execution, evidence);
      const next = host.next && nextHost ? this.#makeBinding(nextHost, nextWorker) : null;
      if (
        next &&
        (!nextEndpoint ||
          binding.pin.endpointGeneration !== nextEndpoint.operation.generation ||
          binding.pin.currentOperationId !== nextEndpoint.operation.id ||
          next.endpoint.uid !== binding.pin.endpointUid)
      )
        throw new TypeError("next host does not retain the actual Endpoint accepted binding");
      if (!next && !prior) throw new TypeError("Deployment cannot invent a never-live retirement");
      plans.push({ binding, prior, next, name });
    }
    const common = evidence.guard();
    const guards = {
      admission: conjunction([
        evidence.guard(true),
        formNativeGuard(atom.before),
        this.#hostInventory(workerUid, hosts),
      ]),
      publication: conjunction([
        common,
        formNativeGuard(atom.after),
        this.#hostInventory(workerUid, nextHost ? [nextHost] : []),
      ]),
    };
    const preparations = plans.map(({ binding, prior, next, name }) => {
      const effects = owner.prepareFormV2Route(
        next ? (prior ? "advance" : "activate") : "retire",
        {
          commandRef: `v2-host:${execution.operationId}:${hostname(name)}`,
          principal: execution.principal,
          space: execution.space,
          expected: binding.claim,
          accepted: this.#accepted(execution, "deployment"),
          endpointBinding: binding.pin,
          priorBinding: prior,
          nextBinding: next,
          nativeBefore: atom.before,
          nativeAfter: atom.after,
        },
        guards,
      );
      return this.#preparation(owner, effects.original, effects);
    });
    return { kind: "shared", preparations: Object.freeze(preparations) };
  }
}

Object.freeze(FormRouteAcceptance.prototype);
Object.freeze(FormRouteAcceptance);
Object.freeze(FormRoutePreparation.prototype);
Object.freeze(FormRoutePreparation);
Object.freeze(FormRoutePublication.prototype);
Object.freeze(FormRoutePublication);

/** Fixed source-selected compiler, not a public constructor/permission brand. */
export type WorkerEndpointOriginV2FormRoutePublication = FormRoutePublication;

export function createWorkerEndpointOriginV2FormRoutePublication(
  options: FormRouteScope & { readonly sql: Sql; readonly ledger: SharedAppLedger },
): WorkerEndpointOriginV2FormRoutePublication {
  return new FormRoutePublication(formRouteKey, options);
}
