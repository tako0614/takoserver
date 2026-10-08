import { canonicalJson } from "./json.ts";
import type { Sql } from "./ports.ts";
import {
  parseWorkerEndpointSpec,
  WORKER_ENDPOINT_FORM_URL,
} from "./takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "./takoform-v2/types.ts";
import {
  type V2EndpointRouteAbsenceObservation,
  type V2EndpointTlsObservation,
  WORKER_ENDPOINT_BACKEND_ID,
} from "./takoform-v2/worker-endpoint-backend.ts";
import type {
  V2WorkerCurrentServingIdentity,
  V2WorkerCurrentServingResolution,
  V2WorkerPublicationResolution,
} from "./takoform-v2/worker-publication-state.ts";
import type { WorkerdNativeWebSocket } from "./workerd-worker-execution-group.ts";
import type { WorkerdWorkerRuntimeOwner } from "./workerd-worker-runtime-owner.ts";

const ROUTE_COLUMNS = `r.uid, r.principal, r.form_url, r.space, r.name, r.backend_id,
  r.target_key, r.generation, r.observed_generation, r.observed_at, r.phase,
  r.spec_json, r.observed_json, r.output_json, r.last_operation, r.busy_operation,
  r.deleted_at, op.id AS operation_id, op.resource_uid AS operation_resource_uid,
  op.principal AS operation_principal, op.action AS operation_action,
  op.generation AS operation_generation, op.status AS operation_status,
  op.effect AS operation_effect, op.backend_id AS operation_backend_id,
  op.target_key AS operation_target_key, op.accepted_spec_json,
  op.result_output_json`;

const ROUTES_BY_HOST_SQL = `SELECT ${ROUTE_COLUMNS}
  FROM tf_v2_resources r
  JOIN tf_v2_operations op ON op.id = r.last_operation
  WHERE r.form_url = ? AND json_extract(r.output_json, '$.hostname') = ?
  ORDER BY r.uid LIMIT 2`;

export interface V2WorkerEndpointAddress {
  readonly endpointUid: string;
  readonly workerUid: string;
  readonly hostname: string;
  readonly url: string;
}

/**
 * The shared HTTPS listener owns these observations. The adapter never
 * manufactures TLS readiness from configuration or a successful Worker fetch.
 */
export interface SelfhostV2WorkerEndpointFrontendWitness {
  observeTls(input: V2WorkerEndpointAddress): Promise<V2EndpointTlsObservation>;
  observeRouteAbsent(input: V2WorkerEndpointAddress): Promise<V2EndpointRouteAbsenceObservation>;
}

type PublicationState = {
  resolve(input: { execution: V2Execution }): Promise<V2WorkerPublicationResolution>;
  resolveCurrentServing(input: {
    workerUid: string;
    targetKey: string;
    sourceOperationId: string;
    expectedIdentity: V2WorkerCurrentServingIdentity;
  }): Promise<V2WorkerCurrentServingResolution>;
};

type RuntimeOwner = Pick<
  WorkerdWorkerRuntimeOwner,
  "workerResourceUid" | "observeServing" | "observeRetirement" | "fetch" | "connectWebSocket"
>;

type ReadyPublication = Extract<V2WorkerPublicationResolution, { kind: "ready" }>;
type ExecutionRoute = {
  readonly address: { readonly hostname: string; readonly url: string };
  readonly resolution: ReadyPublication;
};

interface EndpointRouteRow {
  readonly uid: unknown;
  readonly principal: unknown;
  readonly form_url: unknown;
  readonly space: unknown;
  readonly backend_id: unknown;
  readonly target_key: unknown;
  readonly generation: unknown;
  readonly observed_generation: unknown;
  readonly phase: unknown;
  readonly spec_json: unknown;
  readonly observed_json: unknown;
  readonly output_json: unknown;
  readonly last_operation: unknown;
  readonly busy_operation: unknown;
  readonly deleted_at: unknown;
  readonly operation_id: unknown;
  readonly operation_resource_uid: unknown;
  readonly operation_principal: unknown;
  readonly operation_action: unknown;
  readonly operation_generation: unknown;
  readonly operation_status: unknown;
  readonly operation_effect: unknown;
  readonly operation_backend_id: unknown;
  readonly operation_target_key: unknown;
  readonly accepted_spec_json: unknown;
  readonly result_output_json: unknown;
}

interface ParsedRoute {
  readonly row: EndpointRouteRow;
  readonly workerUid: string;
  readonly address: { readonly hostname: string; readonly url: string };
  readonly operationId: string;
}

function objectJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function canonicalPublicOrigin(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TypeError("publicOrigin must be a canonical HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== input
  ) {
    throw new TypeError("publicOrigin must be a canonical HTTPS origin");
  }
  return parsed;
}

function canonicalSuffix(input: string): string {
  const suffix = input.trim().toLowerCase().replace(/\.$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(`https://${suffix}/`);
  } catch {
    throw new TypeError("workerEndpointSuffix must be a DNS hostname suffix");
  }
  if (
    !suffix ||
    parsed.hostname !== suffix ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new TypeError("workerEndpointSuffix must be a DNS hostname suffix");
  }
  return suffix;
}

function routeAddress(row: EndpointRouteRow, suffix: string): ParsedRoute | null {
  if (
    typeof row.uid !== "string" ||
    typeof row.principal !== "string" ||
    typeof row.space !== "string" ||
    row.form_url !== WORKER_ENDPOINT_FORM_URL ||
    row.target_key === null ||
    typeof row.target_key !== "string" ||
    row.backend_id !== WORKER_ENDPOINT_BACKEND_ID ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.operation_id !== row.last_operation ||
    row.operation_resource_uid !== row.uid ||
    row.operation_principal !== row.principal ||
    row.operation_generation !== row.generation ||
    row.operation_backend_id !== row.backend_id ||
    row.operation_target_key !== row.target_key ||
    row.accepted_spec_json !== row.spec_json ||
    typeof row.output_json !== "string" ||
    typeof row.result_output_json !== "string" ||
    row.result_output_json !== row.output_json ||
    typeof row.operation_id !== "string"
  ) {
    return null;
  }
  let spec: ReturnType<typeof parseWorkerEndpointSpec>;
  try {
    spec = parseWorkerEndpointSpec(objectJson(row.spec_json));
  } catch {
    return null;
  }
  const output = objectJson(row.output_json);
  const hostname = output?.hostname;
  const url = output?.url;
  if (
    !output ||
    Object.keys(output).sort().join(",") !== "hostname,url" ||
    typeof hostname !== "string" ||
    typeof url !== "string" ||
    hostname !== hostname.toLowerCase() ||
    !hostname.endsWith(`.${suffix}`) ||
    hostname.length > 253 ||
    url !== `https://${hostname}/` ||
    canonicalJson(output) !== row.output_json
  ) {
    return null;
  }
  return {
    row,
    workerUid: spec.worker.resourceUid,
    address: { hostname, url },
    operationId: row.operation_id,
  };
}

function activeRoute(parsed: ParsedRoute): boolean {
  const { row } = parsed;
  const observed = objectJson(row.observed_json);
  return (
    row.deleted_at === null &&
    row.busy_operation === null &&
    row.phase === "idle" &&
    row.observed_generation === row.generation &&
    row.operation_action !== "delete" &&
    (row.operation_action === "create" || row.operation_action === "update") &&
    row.operation_status === "succeeded" &&
    row.operation_effect === "complete" &&
    observed?.tlsReady === true &&
    observed.activeDeploymentRouteReady === true
  );
}

function exactIdentity(serving: {
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly hostnames: readonly string[];
  readonly versions: readonly { readonly workerVersionUid: string; readonly weight: number }[];
}): V2WorkerCurrentServingIdentity {
  if (
    typeof serving.generation !== "string" ||
    !serving.generation ||
    typeof serving.workerResourceUid !== "string" ||
    !serving.workerResourceUid ||
    !Array.isArray(serving.hostnames) ||
    !serving.hostnames.every((hostname) => typeof hostname === "string") ||
    !Array.isArray(serving.versions) ||
    !serving.versions.every(
      (version) =>
        version !== null &&
        typeof version === "object" &&
        typeof version.workerVersionUid === "string" &&
        Number.isSafeInteger(version.weight),
    )
  ) {
    throw new TypeError("serving identity is malformed");
  }
  return {
    generation: serving.generation,
    workerResourceUid: serving.workerResourceUid,
    hostnames: [...serving.hostnames],
    versions: serving.versions.map(({ workerVersionUid, weight }) => ({
      workerVersionUid,
      weight,
    })),
  };
}

function matchesServing(
  value: unknown,
  expected: ReturnType<typeof exactIdentity>,
  workerUid: string,
  targetKey: string,
  sourceOperationId: string,
): boolean {
  if (!value || typeof value !== "object") return false;
  const serving = value as Record<string, unknown>;
  try {
    return (
      serving.kind === "serving" &&
      serving.workerResourceUid === workerUid &&
      serving.targetKey === targetKey &&
      serving.sourceOperationId === sourceOperationId &&
      canonicalJson(exactIdentity(serving as never)) === canonicalJson(expected)
    );
  } catch {
    return false;
  }
}

function noStore(status: number): Response {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function requestHostname(request: Request): string | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const header = request.headers.get("host");
  if (!header || header.includes("@")) return null;
  let host: URL;
  try {
    host = new URL(`https://${header}/`);
  } catch {
    return null;
  }
  if (
    host.username !== "" ||
    host.password !== "" ||
    host.port !== "" ||
    host.pathname !== "/" ||
    host.search !== "" ||
    host.hash !== "" ||
    host.hostname !== url.hostname ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return null;
  }
  return host.hostname.toLowerCase();
}

function authorityHostname(value: string | null): string | null {
  if (!value || value.includes("@")) return null;
  try {
    const parsed = new URL(`https://${value}/`);
    return parsed.username === "" && parsed.password === "" && parsed.pathname === "/"
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/**
 * Host-only request adapter for V2 WorkerEndpoint. SQL selects a candidate;
 * the exact per-Worker native owner and the complete accepted publication
 * reader must independently agree before `owner.fetch` is invoked.
 */
export function createSelfhostV2WorkerEndpointFrontend(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicOrigin: string;
  readonly workerEndpointSuffix: string;
  readonly publicationState: PublicationState;
  readonly ownerForWorkerUid: (workerUid: string) => RuntimeOwner | Promise<RuntimeOwner>;
  readonly witness: SelfhostV2WorkerEndpointFrontendWitness;
}): {
  /** `null` is reserved for unrelated authority; reserved misses are terminal. */
  fetch(request: Request): Promise<Response | null>;
  /** Original-client upgrade uses precisely the same route/Serving proof as fetch. */
  upgrade(
    request: Request,
  ): Promise<
    | { readonly kind: "unrelated" }
    | { readonly kind: "denied"; readonly response: Response }
    | { readonly kind: "accepted"; readonly socket: WorkerdNativeWebSocket }
  >;
  /** True only when the same settled predicate used by fetch denies this address. */
  routeDenies(input: V2WorkerEndpointAddress): Promise<boolean>;
  observeTls(
    input: V2WorkerEndpointAddress,
    execution: V2Execution,
  ): Promise<V2EndpointTlsObservation>;
  observeRouteAbsent(
    input: V2WorkerEndpointAddress,
    execution: V2Execution,
  ): Promise<V2EndpointRouteAbsenceObservation>;
} {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const publicOrigin = canonicalPublicOrigin(options.publicOrigin);
  const suffix = canonicalSuffix(options.workerEndpointSuffix);

  function isReserved(hostname: string): boolean {
    return (
      hostname !== publicOrigin.hostname && (hostname === suffix || hostname.endsWith(`.${suffix}`))
    );
  }

  async function rowsForHostname(hostname: string): Promise<readonly ParsedRoute[] | null> {
    try {
      const rows = await options.sql.query(ROUTES_BY_HOST_SQL, [
        WORKER_ENDPOINT_FORM_URL,
        hostname,
      ]);
      if (rows.length > 1) return null;
      const parsed = rows.map((row) => routeAddress(row as unknown as EndpointRouteRow, suffix));
      if (parsed.some((route) => route === null || route.row.target_key !== options.targetKey))
        return null;
      return parsed as ParsedRoute[];
    } catch {
      return null;
    }
  }

  async function activePublication(parsed: ParsedRoute): Promise<{
    owner: RuntimeOwner;
    serving: Extract<Awaited<ReturnType<RuntimeOwner["observeServing"]>>, { kind: "serving" }>;
    resolution: Extract<V2WorkerCurrentServingResolution, { kind: "ready" }>;
  } | null> {
    let owner: RuntimeOwner;
    try {
      owner = await options.ownerForWorkerUid(parsed.workerUid);
    } catch {
      return null;
    }
    if (owner.workerResourceUid !== parsed.workerUid) return null;
    let serving: Awaited<ReturnType<RuntimeOwner["observeServing"]>>;
    try {
      serving = await owner.observeServing({
        workerResourceUid: parsed.workerUid,
        targetKey: options.targetKey,
      });
    } catch {
      return null;
    }
    if (
      serving.kind !== "serving" ||
      serving.workerResourceUid !== parsed.workerUid ||
      serving.targetKey !== options.targetKey ||
      typeof serving.sourceOperationId !== "string" ||
      !Array.isArray(serving.hostnames) ||
      !serving.hostnames.includes(parsed.address.hostname)
    ) {
      return null;
    }
    let resolution: V2WorkerCurrentServingResolution;
    try {
      resolution = await options.publicationState.resolveCurrentServing({
        workerUid: parsed.workerUid,
        targetKey: options.targetKey,
        sourceOperationId: serving.sourceOperationId,
        expectedIdentity: exactIdentity(serving),
      });
    } catch {
      return null;
    }
    if (resolution.kind !== "ready") return null;
    const endpoint = resolution.snapshot.endpoint;
    if (
      resolution.snapshot.sourceOperationId !== serving.sourceOperationId ||
      resolution.snapshot.worker.uid !== parsed.workerUid ||
      resolution.snapshot.worker.principal !== parsed.row.principal ||
      resolution.snapshot.worker.space !== parsed.row.space ||
      !resolution.snapshot.deployment ||
      !endpoint ||
      endpoint.uid !== parsed.row.uid ||
      endpoint.generation !== parsed.row.generation ||
      canonicalJson(endpoint.spec) !== canonicalJson(objectJson(parsed.row.spec_json)) ||
      canonicalJson(endpoint.output) !== canonicalJson(parsed.address) ||
      // Only an Endpoint source operation carries an acceptedEndpointOutput.
      // A later Deployment operation retains the exact selected Endpoint, whose
      // UID, generation, spec and output were checked above.
      (resolution.snapshot.acceptedEndpointOutput !== undefined &&
        canonicalJson(resolution.snapshot.acceptedEndpointOutput) !== canonicalJson(parsed.address))
    ) {
      return null;
    }
    if (!(await resolution.stillCurrent())) return null;
    return { owner, serving, resolution };
  }

  async function routeForExecution(
    input: V2WorkerEndpointAddress,
    execution: V2Execution,
    action: "create" | "update" | "delete",
  ): Promise<ExecutionRoute | null> {
    if (
      execution.action !== action ||
      execution.form !== WORKER_ENDPOINT_FORM_URL ||
      execution.backendId !== WORKER_ENDPOINT_BACKEND_ID ||
      execution.targetKey !== options.targetKey ||
      execution.resourceUid !== input.endpointUid ||
      typeof execution.operationId !== "string" ||
      !execution.operationId ||
      typeof execution.leaseToken !== "string" ||
      !execution.leaseToken
    ) {
      return null;
    }
    let resolution: V2WorkerPublicationResolution;
    try {
      resolution = await options.publicationState.resolve({ execution });
    } catch {
      return null;
    }
    if (resolution.kind !== "ready") return null;
    const snapshot = resolution.snapshot;
    let spec: ReturnType<typeof parseWorkerEndpointSpec>;
    try {
      spec = parseWorkerEndpointSpec(execution.spec);
    } catch {
      return null;
    }
    const address = snapshot.acceptedEndpointOutput;
    if (
      snapshot.sourceOperationId !== execution.operationId ||
      snapshot.worker.uid !== spec.worker.resourceUid ||
      snapshot.worker.uid !== input.workerUid ||
      snapshot.worker.principal !== execution.principal ||
      snapshot.worker.space !== execution.space ||
      !address ||
      typeof address.hostname !== "string" ||
      address.hostname !== address.hostname.toLowerCase() ||
      !address.hostname.endsWith(`.${suffix}`) ||
      address.url !== `https://${address.hostname}/` ||
      address.hostname !== input.hostname ||
      address.url !== input.url
    ) {
      return null;
    }
    if (action === "delete") {
      if (snapshot.endpoint !== null) return null;
    } else if (
      !snapshot.deployment ||
      snapshot.endpoint?.uid !== execution.resourceUid ||
      snapshot.endpoint.generation !== execution.generation ||
      canonicalJson(snapshot.endpoint.spec) !== canonicalJson(spec) ||
      canonicalJson(snapshot.endpoint.output) !== canonicalJson(address)
    ) {
      return null;
    }
    if (!(await resolution.stillCurrent())) return null;
    return { address, resolution };
  }

  async function hasOtherLiveHostnameClaim(
    hostname: string,
    execution: V2Execution,
  ): Promise<boolean | null> {
    try {
      const rows = await options.sql.query(
        `SELECT r.uid FROM tf_v2_resources r
           JOIN tf_v2_operations op ON op.id = r.last_operation
           WHERE r.form_url = ? AND json_extract(r.output_json, '$.hostname') = ?
             AND r.deleted_at IS NULL AND NOT (r.uid = ? AND op.id = ?) LIMIT 1`,
        [WORKER_ENDPOINT_FORM_URL, hostname, execution.resourceUid, execution.operationId],
      );
      return rows.length > 0;
    } catch {
      return null;
    }
  }

  function expectedExecutionIdentity(
    route: ExecutionRoute,
    execution: V2Execution,
  ): V2WorkerCurrentServingIdentity {
    const deployment = route.resolution.snapshot.deployment;
    return {
      generation: `takoserver-v2-operation:${execution.operationId}`,
      workerResourceUid: route.resolution.snapshot.worker.uid,
      hostnames: execution.action === "delete" ? [] : [route.address.hostname],
      versions:
        deployment?.versions.map(({ uid, weight }) => ({ workerVersionUid: uid, weight })) ?? [],
    };
  }

  function matchesExecutionServing(
    value: unknown,
    route: ExecutionRoute,
    execution: V2Execution,
    expected: V2WorkerCurrentServingIdentity,
  ): boolean {
    if (!value || typeof value !== "object") return false;
    const serving = value as Record<string, unknown>;
    try {
      return (
        serving.kind === "serving" &&
        serving.workerResourceUid === route.resolution.snapshot.worker.uid &&
        serving.targetKey === options.targetKey &&
        serving.sourceOperationId === execution.operationId &&
        canonicalJson(exactIdentity(serving as never)) === canonicalJson(expected)
      );
    } catch {
      return false;
    }
  }

  async function ownerForExecution(route: ExecutionRoute): Promise<RuntimeOwner | null> {
    try {
      const owner = await options.ownerForWorkerUid(route.resolution.snapshot.worker.uid);
      return owner.workerResourceUid === route.resolution.snapshot.worker.uid ? owner : null;
    } catch {
      return null;
    }
  }

  async function nativeExecutionRouteMatches(
    route: ExecutionRoute,
    execution: V2Execution,
    owner: RuntimeOwner,
  ): Promise<boolean> {
    const expected = expectedExecutionIdentity(route, execution);
    try {
      const serving = await owner.observeServing({
        workerResourceUid: route.resolution.snapshot.worker.uid,
        targetKey: options.targetKey,
      });
      if (route.resolution.snapshot.deployment) {
        return matchesExecutionServing(serving, route, execution, expected);
      }
      if (execution.action !== "delete" || serving.kind !== "unknown") return false;
      const retired = await owner.observeRetirement({});
      return (
        retired.kind === "confirmed_absent" &&
        retired.workerResourceUid === route.resolution.snapshot.worker.uid &&
        retired.targetKey === options.targetKey &&
        retired.workerVersionUid === undefined
      );
    } catch {
      return false;
    }
  }

  async function stillSameExecution(
    input: V2WorkerEndpointAddress,
    execution: V2Execution,
    original: ExecutionRoute,
  ): Promise<ExecutionRoute | null> {
    if (
      execution.action !== "create" &&
      execution.action !== "update" &&
      execution.action !== "delete"
    )
      return null;
    const latest = await routeForExecution(input, execution, execution.action);
    if (
      !latest ||
      canonicalJson(latest.resolution.snapshot) !== canonicalJson(original.resolution.snapshot) ||
      !(await original.resolution.stillCurrent()) ||
      !(await latest.resolution.stillCurrent())
    ) {
      return null;
    }
    return latest;
  }

  async function observeTls(
    input: V2WorkerEndpointAddress,
    execution: V2Execution,
  ): Promise<V2EndpointTlsObservation> {
    const notReady = (): V2EndpointTlsObservation => ({ ...input, ready: false });
    if (execution.action !== "create" && execution.action !== "update") return notReady();
    const route = await routeForExecution(input, execution, execution.action);
    if (!route || (await hasOtherLiveHostnameClaim(input.hostname, execution)) !== false)
      return notReady();
    const owner = await ownerForExecution(route);
    if (!owner || !(await nativeExecutionRouteMatches(route, execution, owner))) return notReady();
    let witness: V2EndpointTlsObservation;
    try {
      witness = await options.witness.observeTls(input);
    } catch {
      return notReady();
    }
    const latest = await stillSameExecution(input, execution, route);
    const finalClaim = await hasOtherLiveHostnameClaim(input.hostname, execution);
    if (
      witness.ready !== true ||
      witness.endpointUid !== input.endpointUid ||
      witness.workerUid !== input.workerUid ||
      witness.hostname !== input.hostname ||
      witness.url !== input.url ||
      !latest ||
      finalClaim !== false ||
      !(await nativeExecutionRouteMatches(latest, execution, owner))
    ) {
      return notReady();
    }
    return { ...witness };
  }

  async function observeRouteAbsent(
    input: V2WorkerEndpointAddress,
    execution: V2Execution,
  ): Promise<V2EndpointRouteAbsenceObservation> {
    const notAbsent = (): V2EndpointRouteAbsenceObservation => ({ ...input, absent: false });
    const route = await routeForExecution(input, execution, "delete");
    if (!route || (await hasOtherLiveHostnameClaim(input.hostname, execution)) !== false)
      return notAbsent();
    if (!(await routeDenies(input))) return notAbsent();
    const owner = await ownerForExecution(route);
    if (!owner || !(await nativeExecutionRouteMatches(route, execution, owner))) return notAbsent();
    let witness: V2EndpointRouteAbsenceObservation;
    try {
      witness = await options.witness.observeRouteAbsent(input);
    } catch {
      return notAbsent();
    }
    const latest = await stillSameExecution(input, execution, route);
    const finalClaim = await hasOtherLiveHostnameClaim(input.hostname, execution);
    if (
      witness.absent !== true ||
      witness.endpointUid !== input.endpointUid ||
      witness.workerUid !== input.workerUid ||
      witness.hostname !== input.hostname ||
      witness.url !== input.url ||
      !latest ||
      finalClaim !== false ||
      !(await routeDenies(input)) ||
      !(await nativeExecutionRouteMatches(latest, execution, owner))
    ) {
      return notAbsent();
    }
    return { ...witness };
  }

  async function routeDenies(input: V2WorkerEndpointAddress): Promise<boolean> {
    if (
      typeof input.hostname !== "string" ||
      typeof input.url !== "string" ||
      input.url !== `https://${input.hostname}/` ||
      !isReserved(input.hostname)
    ) {
      return false;
    }
    const candidates = await rowsForHostname(input.hostname);
    // The fetch path also fails closed on SQL ambiguity/unavailability, so it
    // does not accept the address in that state. Lifecycle callers separately
    // require exact execution and owner readbacks before treating this as
    // route absence.
    if (candidates === null) return true;
    if (candidates.length === 0) return true;
    const [candidate] = candidates;
    if (!candidate || !activeRoute(candidate)) return true;
    // This mirrors fetch's complete current-serving authority check: a SQL
    // route is only accepting if its UID owner and publication reader agree.
    const current = await activePublication(candidate);
    if (!current) return true;
    return false;
  }

  async function qualifiedRequest<T>(
    request: Request,
    dispatch: (owner: RuntimeOwner) => Promise<T>,
    discard: (value: T) => Promise<void>,
  ): Promise<
    | { readonly kind: "unrelated" }
    | { readonly kind: "denied"; readonly response: Response }
    | { readonly kind: "accepted"; readonly value: T }
  > {
    const hostname = requestHostname(request);
    if (hostname === null) {
      let urlHostname: string | null = null;
      try {
        urlHostname = new URL(request.url).hostname.toLowerCase();
      } catch {
        // A malformed non-reserved request is left to the ordinary router.
      }
      const headerHostname = authorityHostname(request.headers.get("host"));
      return (urlHostname && isReserved(urlHostname)) ||
        (headerHostname && isReserved(headerHostname))
        ? { kind: "denied", response: noStore(421) }
        : { kind: "unrelated" };
    }
    if (!isReserved(hostname)) return { kind: "unrelated" };
    const candidates = await rowsForHostname(hostname);
    if (!candidates) return { kind: "denied", response: noStore(503) };
    if (candidates.length === 0) return { kind: "denied", response: noStore(404) };
    const [candidate] = candidates;
    if (!candidate || !activeRoute(candidate)) return { kind: "denied", response: noStore(503) };
    const current = await activePublication(candidate);
    if (!current) return { kind: "denied", response: noStore(503) };
    let serving: Awaited<ReturnType<RuntimeOwner["observeServing"]>>;
    try {
      serving = await current.owner.observeServing({
        workerResourceUid: candidate.workerUid,
        targetKey: options.targetKey,
      });
    } catch {
      return { kind: "denied", response: noStore(503) };
    }
    if (
      !matchesServing(
        serving,
        exactIdentity(current.serving),
        candidate.workerUid,
        options.targetKey,
        current.serving.sourceOperationId,
      ) ||
      !(await current.resolution.stillCurrent())
    ) {
      return { kind: "denied", response: noStore(503) };
    }
    let value: T;
    try {
      value = await dispatch(current.owner);
    } catch {
      return { kind: "denied", response: noStore(503) };
    }
    let afterServing: Awaited<ReturnType<RuntimeOwner["observeServing"]>>;
    const afterRoute = await rowsForHostname(hostname);
    try {
      afterServing = await current.owner.observeServing({
        workerResourceUid: candidate.workerUid,
        targetKey: options.targetKey,
      });
    } catch {
      await discard(value);
      return { kind: "denied", response: noStore(503) };
    }
    const afterCandidate = afterRoute?.[0];
    if (
      afterRoute?.length !== 1 ||
      !afterCandidate ||
      afterCandidate.row.uid !== candidate.row.uid ||
      !activeRoute(afterCandidate) ||
      !matchesServing(
        afterServing,
        exactIdentity(current.serving),
        candidate.workerUid,
        options.targetKey,
        current.serving.sourceOperationId,
      ) ||
      !(await current.resolution.stillCurrent())
    ) {
      await discard(value);
      return { kind: "denied", response: noStore(503) };
    }
    return { kind: "accepted", value };
  }

  return {
    routeDenies,
    async fetch(request) {
      const result = await qualifiedRequest(
        request,
        (owner) => owner.fetch(request),
        async (response) => {
          await response.body?.cancel().catch(() => undefined);
        },
      );
      return result.kind === "accepted"
        ? result.value
        : result.kind === "denied"
          ? result.response
          : null;
    },
    async upgrade(request) {
      const result = await qualifiedRequest(
        request,
        (owner) => owner.connectWebSocket(request),
        async (socket) => {
          socket.terminate();
        },
      );
      return result.kind === "accepted" ? { kind: "accepted", socket: result.value } : result;
    },
    observeTls,
    observeRouteAbsent,
  };
}
