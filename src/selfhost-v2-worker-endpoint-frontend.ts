import { canonicalJson } from "./json.ts";
import type { Sql } from "./ports.ts";
import {
  parseWorkerEndpointSpec,
  WORKER_ENDPOINT_FORM_URL,
} from "./takoform-v2/forms/worker-specs.ts";
import {
  type V2EndpointRouteAbsenceObservation,
  type V2EndpointTlsObservation,
  WORKER_ENDPOINT_BACKEND_ID,
} from "./takoform-v2/worker-endpoint-backend.ts";
import type {
  V2WorkerCurrentServingIdentity,
  V2WorkerCurrentServingResolution,
} from "./takoform-v2/worker-publication-state.ts";
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

const ROUTE_BY_UID_SQL = `SELECT ${ROUTE_COLUMNS}
  FROM tf_v2_resources r
  JOIN tf_v2_operations op ON op.id = r.last_operation
  WHERE r.uid = ? AND r.form_url = ? AND r.target_key = ?
  LIMIT 2`;

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
  resolveCurrentServing(input: {
    workerUid: string;
    targetKey: string;
    sourceOperationId: string;
    expectedIdentity: V2WorkerCurrentServingIdentity;
  }): Promise<V2WorkerCurrentServingResolution>;
};

type RuntimeOwner = Pick<
  WorkerdWorkerRuntimeOwner,
  "workerResourceUid" | "observeServing" | "observeRetirement" | "fetch"
>;

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
  observeTls(input: V2WorkerEndpointAddress): Promise<V2EndpointTlsObservation>;
  observeRouteAbsent(input: V2WorkerEndpointAddress): Promise<V2EndpointRouteAbsenceObservation>;
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

  async function candidateForAddress(
    input: V2WorkerEndpointAddress,
    deleted: boolean,
  ): Promise<ParsedRoute | null> {
    try {
      const rows = await options.sql.query(ROUTE_BY_UID_SQL, [
        input.endpointUid,
        WORKER_ENDPOINT_FORM_URL,
        options.targetKey,
      ]);
      if (rows.length !== 1) return null;
      const parsed = routeAddress(rows[0] as unknown as EndpointRouteRow, suffix);
      if (
        !parsed ||
        parsed.workerUid !== input.workerUid ||
        parsed.address.hostname !== input.hostname ||
        parsed.address.url !== input.url ||
        (deleted
          ? parsed.row.deleted_at === null ||
            parsed.row.operation_action !== "delete" ||
            parsed.row.operation_status !== "succeeded" ||
            parsed.row.operation_effect !== "complete"
          : !activeRoute(parsed))
      ) {
        return null;
      }
      return parsed;
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
      canonicalJson(resolution.snapshot.acceptedEndpointOutput) !== canonicalJson(parsed.address)
    ) {
      return null;
    }
    if (!(await resolution.stillCurrent())) return null;
    return { owner, serving, resolution };
  }

  async function observeTls(input: V2WorkerEndpointAddress): Promise<V2EndpointTlsObservation> {
    const notReady = (): V2EndpointTlsObservation => ({ ...input, ready: false });
    const parsed = await candidateForAddress(input, false);
    if (!parsed) return notReady();
    const current = await activePublication(parsed);
    if (!current) return notReady();
    let witness: V2EndpointTlsObservation;
    try {
      witness = await options.witness.observeTls(input);
    } catch {
      return notReady();
    }
    let serving: Awaited<ReturnType<RuntimeOwner["observeServing"]>>;
    try {
      serving = await current.owner.observeServing({
        workerResourceUid: parsed.workerUid,
        targetKey: options.targetKey,
      });
    } catch {
      return notReady();
    }
    const stillActive = await candidateForAddress(input, false);
    if (
      witness.ready !== true ||
      witness.endpointUid !== input.endpointUid ||
      witness.workerUid !== input.workerUid ||
      witness.hostname !== input.hostname ||
      witness.url !== input.url ||
      !matchesServing(
        serving,
        exactIdentity(current.serving),
        parsed.workerUid,
        options.targetKey,
        current.serving.sourceOperationId,
      ) ||
      !stillActive ||
      !(await current.resolution.stillCurrent())
    ) {
      return notReady();
    }
    return { ...witness };
  }

  async function provesNativeRouteAbsent(
    parsed: ParsedRoute,
    input: V2WorkerEndpointAddress,
  ): Promise<boolean> {
    let owner: RuntimeOwner;
    try {
      owner = await options.ownerForWorkerUid(input.workerUid);
    } catch {
      return false;
    }
    if (owner.workerResourceUid !== input.workerUid) return false;
    try {
      const serving = await owner.observeServing({
        workerResourceUid: input.workerUid,
        targetKey: options.targetKey,
      });
      if (
        serving.kind === "serving" &&
        serving.workerResourceUid === input.workerUid &&
        serving.targetKey === options.targetKey &&
        serving.sourceOperationId === parsed.operationId &&
        serving.generation === `takoserver-v2-operation:${parsed.operationId}` &&
        !serving.hostnames.includes(input.hostname)
      ) {
        const current = await options.publicationState.resolveCurrentServing({
          workerUid: input.workerUid,
          targetKey: options.targetKey,
          sourceOperationId: parsed.operationId,
          expectedIdentity: exactIdentity(serving),
        });
        return (
          current.kind === "ready" &&
          current.snapshot.sourceOperationId === parsed.operationId &&
          current.snapshot.worker.uid === input.workerUid &&
          current.snapshot.worker.principal === parsed.row.principal &&
          current.snapshot.worker.space === parsed.row.space &&
          current.snapshot.acceptedEndpointOutput?.hostname === input.hostname &&
          current.snapshot.acceptedEndpointOutput.url === input.url &&
          current.snapshot.endpoint === null &&
          current.snapshot.deployment !== null &&
          (await current.stillCurrent())
        );
      }
      if (serving.kind !== "unknown") return false;
      // With no active Deployment, the only positive native proof is the
      // owner's complete physical-retirement inventory; unknown is not absence.
      const deployments = await options.sql.query(
        `SELECT deployment.uid FROM tf_v2_resources deployment
           JOIN tf_v2_resource_references edge ON edge.referrer_uid = deployment.uid
           WHERE deployment.form_url = ? AND deployment.target_key = ?
             AND deployment.deleted_at IS NULL AND edge.target_uid = ?
           LIMIT 1`,
        [
          "https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/",
          options.targetKey,
          input.workerUid,
        ],
      );
      const retired = await owner.observeRetirement({});
      return (
        deployments.length === 0 &&
        retired.kind === "confirmed_absent" &&
        retired.workerResourceUid === input.workerUid &&
        retired.targetKey === options.targetKey &&
        retired.workerVersionUid === undefined
      );
    } catch {
      return false;
    }
  }

  async function observeRouteAbsent(
    input: V2WorkerEndpointAddress,
  ): Promise<V2EndpointRouteAbsenceObservation> {
    const notAbsent = (): V2EndpointRouteAbsenceObservation => ({ ...input, absent: false });
    const parsed = await candidateForAddress(input, true);
    if (!parsed) return notAbsent();
    const routes = await rowsForHostname(input.hostname);
    if (routes?.length !== 0) return notAbsent();
    if (!(await provesNativeRouteAbsent(parsed, input))) return notAbsent();
    let witness: V2EndpointRouteAbsenceObservation;
    try {
      witness = await options.witness.observeRouteAbsent(input);
    } catch {
      return notAbsent();
    }
    const finalRoutes = await rowsForHostname(input.hostname);
    const finalTombstone = await candidateForAddress(input, true);
    if (
      witness.absent !== true ||
      witness.endpointUid !== input.endpointUid ||
      witness.workerUid !== input.workerUid ||
      witness.hostname !== input.hostname ||
      witness.url !== input.url ||
      !finalRoutes ||
      finalRoutes.length !== 0 ||
      !finalTombstone ||
      !(await provesNativeRouteAbsent(finalTombstone, input))
    ) {
      return notAbsent();
    }
    return { ...witness };
  }

  return {
    async fetch(request) {
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
          ? noStore(421)
          : null;
      }
      if (!isReserved(hostname)) return null;
      const candidates = await rowsForHostname(hostname);
      if (!candidates) return noStore(503);
      if (candidates.length === 0) return noStore(404);
      const [candidate] = candidates;
      if (!candidate || !activeRoute(candidate)) return noStore(503);
      const current = await activePublication(candidate);
      if (!current) return noStore(503);
      let serving: Awaited<ReturnType<RuntimeOwner["observeServing"]>>;
      try {
        serving = await current.owner.observeServing({
          workerResourceUid: candidate.workerUid,
          targetKey: options.targetKey,
        });
      } catch {
        return noStore(503);
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
        return noStore(503);
      }
      let response: Response;
      try {
        response = await current.owner.fetch(request);
      } catch {
        return noStore(503);
      }
      let afterServing: Awaited<ReturnType<RuntimeOwner["observeServing"]>>;
      const afterRoute = await rowsForHostname(hostname);
      try {
        afterServing = await current.owner.observeServing({
          workerResourceUid: candidate.workerUid,
          targetKey: options.targetKey,
        });
      } catch {
        await response.body?.cancel().catch(() => undefined);
        return noStore(503);
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
        await response.body?.cancel().catch(() => undefined);
        return noStore(503);
      }
      return response;
    },
    observeTls,
    observeRouteAbsent,
  };
}
