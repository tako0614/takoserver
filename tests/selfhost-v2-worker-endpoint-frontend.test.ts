import { describe, expect, test } from "bun:test";
import type { Row, Sql } from "../src/ports.ts";
import {
  createSelfhostV2WorkerEndpointFrontend,
  type V2WorkerEndpointAddress,
} from "../src/selfhost-v2-worker-endpoint-frontend.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";

const TARGET = "selfhost-v2-worker-primary";
const PUBLIC_ORIGIN = "https://api.example.test";
const SUFFIX = "workers.example.test";
const HOSTNAME = "sw-0123456789abcdef0123456789abcdef01234567.workers.example.test";
const ENDPOINT_UID = "endpoint-one";
const WORKER_UID = "worker-one";
const VERSION_UID = "version-one";
const OPERATION_ID = "6ac9c3c4-a76e-4a59-9b4a-8ac52df10c91";
const UPDATE_OPERATION_ID = "ca53d879-ff44-47a5-8846-117bf82f7717";
const DELETE_OPERATION_ID = "9d8b5fc4-066f-46a9-9a36-b9c57cabc971";
const DEPLOYMENT_OPERATION_ID = "15e57614-257a-4e7f-8126-2e438c5872fb";
const FORM = "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/";
const ENDPOINT_SPEC = { worker: { resourceUid: WORKER_UID } };
const ADDRESS = {
  hostname: HOSTNAME,
  url: `https://${HOSTNAME}/`,
};
const IDENTITY = {
  generation: `takoserver-v2-operation:${OPERATION_ID}`,
  workerResourceUid: WORKER_UID,
  hostnames: [HOSTNAME],
  versions: [{ workerVersionUid: VERSION_UID, weight: 10_000 }],
};

function endpointRows(): Row[] {
  const output = JSON.stringify(ADDRESS);
  const spec = JSON.stringify(ENDPOINT_SPEC);
  return [
    {
      uid: ENDPOINT_UID,
      principal: "org:acme",
      form_url: FORM,
      space: "org:acme",
      generation: 2,
      observed_generation: 2,
      phase: "idle",
      busy_operation: null,
      spec_json: spec,
      observed_json: JSON.stringify({ tlsReady: true, activeDeploymentRouteReady: true }),
      output_json: output,
      last_operation: OPERATION_ID,
      target_key: TARGET,
      backend_id: "selfhost-v2-worker-endpoint-owner-v1",
      deleted_at: null,
      operation_id: OPERATION_ID,
      operation_resource_uid: ENDPOINT_UID,
      operation_principal: "org:acme",
      operation_generation: 2,
      operation_action: "create",
      operation_status: "succeeded",
      operation_effect: "complete",
      operation_backend_id: "selfhost-v2-worker-endpoint-owner-v1",
      operation_target_key: TARGET,
      accepted_spec_json: spec,
      result_output_json: output,
    } as unknown as Row,
  ];
}

function publicationSnapshot(routeDelete = false, deploymentPublication = false) {
  return {
    sourceOperationId: routeDelete
      ? DELETE_OPERATION_ID
      : deploymentPublication
        ? DEPLOYMENT_OPERATION_ID
        : OPERATION_ID,
    // The accepted address belongs only to an Endpoint source operation.
    // A later Deployment publisher keeps the same selected Endpoint below.
    ...(deploymentPublication ? {} : { acceptedEndpointOutput: ADDRESS }),
    worker: { uid: WORKER_UID, principal: "org:acme", space: "org:acme", generation: 1 },
    deployment: {
      uid: "deployment-one",
      generation: 3,
      spec: {
        worker: { resourceUid: WORKER_UID },
        versions: [{ workerVersion: { resourceUid: VERSION_UID }, weight: 10_000 }],
      },
      versions: [
        {
          uid: VERSION_UID,
          sourceOperationId: "version-op",
          generation: 1,
          weight: 10_000,
          spec: { worker: { resourceUid: WORKER_UID }, handlers: ["fetch"], vars: {} },
        },
      ],
    },
    endpoint: routeDelete
      ? null
      : {
          uid: ENDPOINT_UID,
          generation: 2,
          spec: ENDPOINT_SPEC,
          output: ADDRESS,
        },
  };
}

function execution(action: V2Execution["action"] = "create"): V2Execution {
  const operationId =
    action === "delete"
      ? DELETE_OPERATION_ID
      : action === "update"
        ? UPDATE_OPERATION_ID
        : OPERATION_ID;
  const generation = action === "create" ? 2 : action === "update" ? 3 : 4;
  return {
    operationId,
    leaseToken: `lease-${operationId}`,
    backendKey: "fixture-backend-key",
    backendId: "selfhost-v2-worker-endpoint-owner-v1",
    targetKey: TARGET,
    resourceUid: ENDPOINT_UID,
    principal: "org:acme",
    action,
    generation,
    form: FORM,
    space: "org:acme",
    name: "endpoint",
    spec: ENDPOINT_SPEC,
    previousObserved: {},
    previousOutput: ADDRESS,
  };
}

function fixture(
  input: {
    readonly rows?: Row[];
    readonly resolution?: "ready" | "unresolved";
    readonly stillCurrent?: boolean;
    readonly routeDelete?: boolean;
    readonly routeRows?: Row[];
    readonly liveClaimRows?: Row[];
    readonly routeWitnessAbsent?: boolean;
    readonly tlsWitnessReady?: boolean;
    readonly servingUnknown?: boolean;
    readonly deploymentExists?: boolean;
    readonly staleAfterFetch?: boolean;
    readonly deploymentPublication?: boolean;
    readonly action?: V2Execution["action"];
  } = {},
) {
  const fixtureOptions = input;
  const rows = input.rows ?? endpointRows();
  const fetchCalls: Request[] = [];
  const upgradeCalls: Request[] = [];
  const socketState = { terminated: false };
  const socket = Object.assign(new EventTarget(), {
    terminate() {
      socketState.terminated = true;
    },
    readyState: 1,
    protocol: "",
    bufferedAmount: 0,
  });
  const observationCalls: V2WorkerEndpointAddress[] = [];
  const publicationCalls: unknown[] = [];
  const responseBodyState = { cancelled: false };
  let currentChecks = 0;
  const servingSourceOperationId = input.routeDelete
    ? DELETE_OPERATION_ID
    : input.deploymentPublication
      ? DEPLOYMENT_OPERATION_ID
      : input.action === "update"
        ? UPDATE_OPERATION_ID
        : OPERATION_ID;
  const servingIdentity =
    input.routeDelete || input.deploymentPublication || input.action === "update"
      ? {
          ...IDENTITY,
          generation: `takoserver-v2-operation:${servingSourceOperationId}`,
          hostnames: input.routeDelete ? ([] as string[]) : [HOSTNAME],
        }
      : IDENTITY;
  const owner = {
    workerResourceUid: WORKER_UID,
    async observeServing(target: { workerResourceUid: string; targetKey: string }) {
      observationCalls.push(target as unknown as V2WorkerEndpointAddress);
      if (fixtureOptions.servingUnknown) return { kind: "unknown" as const };
      return {
        kind: "serving" as const,
        ...servingIdentity,
        sourceOperationId: servingSourceOperationId,
        targetKey: target.targetKey,
      };
    },
    async fetch(request: Request) {
      fetchCalls.push(request);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`worker:${new URL(request.url).pathname}`));
            controller.close();
          },
          cancel() {
            responseBodyState.cancelled = true;
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    },
    async connectWebSocket(request: Request) {
      upgradeCalls.push(request);
      return socket as never;
    },
    async observeRetirement() {
      return {
        kind: "confirmed_absent" as const,
        workerResourceUid: WORKER_UID,
        targetKey: TARGET,
        incarnationOperationIds: [],
      };
    },
  };
  const sql = {
    async query(query: string) {
      if (query.includes("AND NOT (r.uid = ? AND op.id = ?)")) return input.liveClaimRows ?? [];
      if (query.includes("json_extract(r.output_json")) return input.routeRows ?? rows;
      return [];
    },
  } as unknown as Sql;
  const frontend = createSelfhostV2WorkerEndpointFrontend({
    sql,
    targetKey: TARGET,
    publicOrigin: PUBLIC_ORIGIN,
    workerEndpointSuffix: SUFFIX,
    publicationState: {
      async resolve({ execution: operation }: { execution: V2Execution }) {
        publicationCalls.push({ operationId: operation.operationId, action: operation.action });
        if (fixtureOptions.resolution === "unresolved")
          return { kind: "unresolved", code: "graph_unresolved", message: "stale" };
        const snapshot = publicationSnapshot(
          operation.action === "delete",
          fixtureOptions.deploymentPublication,
        );
        return {
          kind: "ready",
          snapshot: {
            ...snapshot,
            sourceOperationId: operation.operationId,
            deployment: fixtureOptions.deploymentExists === false ? null : snapshot.deployment,
            endpoint:
              operation.action === "delete"
                ? null
                : {
                    uid: ENDPOINT_UID,
                    generation: operation.generation,
                    spec: ENDPOINT_SPEC,
                    output: ADDRESS,
                  },
          },
          async stillCurrent() {
            currentChecks += 1;
            return fixtureOptions.stillCurrent !== false;
          },
        };
      },
      async resolveCurrentServing(input: unknown) {
        publicationCalls.push(input);
        if (fixtureOptions.resolution === "unresolved")
          return { kind: "unresolved", code: "graph_unresolved", message: "stale" };
        return {
          kind: "ready",
          snapshot: publicationSnapshot(
            fixtureOptions.routeDelete,
            fixtureOptions.deploymentPublication,
          ),
          async stillCurrent() {
            currentChecks += 1;
            if (fixtureOptions.staleAfterFetch) return currentChecks < 3;
            return fixtureOptions.stillCurrent !== false;
          },
        };
      },
    } as never,
    ownerForWorkerUid: async () => owner as never,
    witness: {
      async observeTls(value) {
        observationCalls.push(value);
        return { ...value, ready: fixtureOptions.tlsWitnessReady ?? true };
      },
      async observeRouteAbsent(value) {
        observationCalls.push(value);
        return { ...value, absent: fixtureOptions.routeWitnessAbsent ?? true };
      },
    },
  });
  return {
    frontend,
    fetchCalls,
    upgradeCalls,
    socketState,
    socket,
    observationCalls,
    publicationCalls,
    responseBodyState,
  };
}

describe("self-host v2 Worker Endpoint frontend adapter", () => {
  test("upgrades only the exact settled route and closes a socket on post-dispatch drift", async () => {
    const request = new Request(`https://${HOSTNAME}/actor-socket`, {
      headers: { host: HOSTNAME, upgrade: "websocket" },
    });
    const accepted = fixture();
    const acceptedResult = await accepted.frontend.upgrade(request);
    expect(acceptedResult.kind).toBe("accepted");
    if (acceptedResult.kind === "accepted") {
      expect(Object.is(acceptedResult.socket, accepted.socket)).toBe(true);
    }
    expect(accepted.upgradeCalls).toEqual([request]);
    expect(accepted.fetchCalls).toHaveLength(0);
    expect(accepted.socketState.terminated).toBe(false);

    const drifted = fixture({ staleAfterFetch: true });
    const denied = await drifted.frontend.upgrade(request);
    expect(denied.kind).toBe("denied");
    if (denied.kind === "denied") expect(denied.response.status).toBe(503);
    expect(drifted.upgradeCalls).toEqual([request]);
    expect(drifted.socketState.terminated).toBe(true);

    const unresolved = fixture({ resolution: "unresolved" });
    expect((await unresolved.frontend.upgrade(request)).kind).toBe("denied");
    expect(unresolved.upgradeCalls).toHaveLength(0);
  });
  test("dispatches a settled reserved hostname to its exact UID owner without rewriting the request", async () => {
    const { frontend, fetchCalls, publicationCalls } = fixture();
    const request = new Request(`https://${HOSTNAME}/hello?x=1`, {
      headers: { host: HOSTNAME },
    });

    const response = await frontend.fetch(request);

    expect(publicationCalls).toHaveLength(1);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("worker:/hello");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toBe(request);
    expect(publicationCalls[0]).toMatchObject({ workerUid: WORKER_UID, targetKey: TARGET });
  });

  test("keeps the Endpoint route when a later Deployment operation is the serving source", async () => {
    const { frontend, fetchCalls, publicationCalls } = fixture({ deploymentPublication: true });
    const response = await frontend.fetch(
      new Request(`https://${HOSTNAME}/after-deployment-update`, {
        headers: { host: HOSTNAME },
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("worker:/after-deployment-update");
    expect(fetchCalls).toHaveLength(1);
    expect(publicationCalls[0]).toMatchObject({ sourceOperationId: DEPLOYMENT_OPERATION_ID });
  });

  test("terminates an unmatched reserved hostname instead of falling through to the app/API", async () => {
    const { frontend, fetchCalls } = fixture({ rows: [] });
    const response = await frontend.fetch(
      new Request(`https://${HOSTNAME}/v2/forms`, { headers: { host: HOSTNAME } }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(fetchCalls).toHaveLength(0);
  });

  test("terminates a reserved Host whose URL authority disagrees", async () => {
    const { frontend, fetchCalls } = fixture();
    const response = await frontend.fetch(
      new Request(`${PUBLIC_ORIGIN}/v2/forms`, { headers: { host: HOSTNAME } }),
    );

    expect(response?.status).toBe(421);
    expect(fetchCalls).toHaveLength(0);
  });

  test("does not dispatch when current SQL/publication authority is unresolved", async () => {
    const { frontend, fetchCalls } = fixture({ resolution: "unresolved" });
    const response = await frontend.fetch(
      new Request(`https://${HOSTNAME}/`, { headers: { host: HOSTNAME } }),
    );

    expect(response?.status).toBe(503);
    expect(fetchCalls).toHaveLength(0);
  });

  test("reports a reserved address as denied only when settled fetch authority does not accept it", async () => {
    const active = fixture();
    expect(
      await active.frontend.routeDenies({
        endpointUid: ENDPOINT_UID,
        workerUid: WORKER_UID,
        ...ADDRESS,
      }),
    ).toBe(false);

    const absent = fixture({ routeRows: [] });
    expect(
      await absent.frontend.routeDenies({
        endpointUid: ENDPOINT_UID,
        workerUid: WORKER_UID,
        ...ADDRESS,
      }),
    ).toBe(true);
  });

  test("does not dispatch when the captured SQL graph changes before the owner call", async () => {
    const { frontend, fetchCalls } = fixture({ stillCurrent: false });
    const response = await frontend.fetch(
      new Request(`https://${HOSTNAME}/`, { headers: { host: HOSTNAME } }),
    );

    expect(response?.status).toBe(503);
    expect(fetchCalls).toHaveLength(0);
  });

  test("cancels the Worker response stream if its SQL route changes before handoff", async () => {
    const { frontend, fetchCalls, responseBodyState } = fixture({ staleAfterFetch: true });
    const response = await frontend.fetch(
      new Request(`https://${HOSTNAME}/`, { headers: { host: HOSTNAME } }),
    );

    expect(fetchCalls).toHaveLength(1);
    expect(response?.status).toBe(503);
    expect(responseBodyState.cancelled).toBe(true);
  });

  test("leaves the public application origin and unrelated hosts to normal app routing", async () => {
    const { frontend, fetchCalls } = fixture();

    expect(await frontend.fetch(new Request(`${PUBLIC_ORIGIN}/v2/forms`))).toBeNull();
    expect(await frontend.fetch(new Request("https://other.example.test/v2/forms"))).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  test("fails closed on duplicate hostname claims", async () => {
    const rows = endpointRows();
    rows.push({ ...rows[0], uid: "endpoint-two" } as Row);
    const { frontend, fetchCalls } = fixture({ rows });
    const response = await frontend.fetch(
      new Request(`https://${HOSTNAME}/`, { headers: { host: HOSTNAME } }),
    );

    expect(response?.status).toBe(503);
    expect(fetchCalls).toHaveLength(0);
  });

  test("fails closed when the hostname is claimed by a different Host target", async () => {
    const rows = endpointRows();
    rows[0] = { ...rows[0], target_key: "foreign-target" } as Row;
    const { frontend, fetchCalls } = fixture({ routeRows: rows });
    const response = await frontend.fetch(
      new Request(`https://${HOSTNAME}/`, { headers: { host: HOSTNAME } }),
    );

    expect(response?.status).toBe(503);
    expect(fetchCalls).toHaveLength(0);
  });

  test("fails closed when the Endpoint references a different Worker UID", async () => {
    const rows = endpointRows();
    const foreignSpec = JSON.stringify({ worker: { resourceUid: "worker-foreign" } });
    rows[0] = {
      ...rows[0],
      spec_json: foreignSpec,
      accepted_spec_json: foreignSpec,
    } as Row;
    const { frontend, fetchCalls } = fixture({ routeRows: rows });
    const response = await frontend.fetch(
      new Request(`https://${HOSTNAME}/`, { headers: { host: HOSTNAME } }),
    );

    expect(response?.status).toBe(503);
    expect(fetchCalls).toHaveLength(0);
  });

  test("only reports TLS ready after exact current Worker routing and listener witness", async () => {
    const { frontend, publicationCalls, observationCalls } = fixture({ routeRows: [] });
    const observation = await frontend.observeTls(
      { endpointUid: ENDPOINT_UID, workerUid: WORKER_UID, ...ADDRESS },
      execution(),
    );

    expect(publicationCalls).toHaveLength(2);
    expect(observationCalls).toHaveLength(3);
    expect(observation).toEqual({
      endpointUid: ENDPOINT_UID,
      workerUid: WORKER_UID,
      ...ADDRESS,
      ready: true,
    });
  });

  test("does not manufacture TLS readiness when the shared listener witness is negative", async () => {
    const { frontend } = fixture({ tlsWitnessReady: false });
    const observation = await frontend.observeTls(
      { endpointUid: ENDPOINT_UID, workerUid: WORKER_UID, ...ADDRESS },
      execution(),
    );

    expect(observation.ready).toBe(false);
  });

  test("does not report TLS ready while another live Endpoint claims the assigned hostname", async () => {
    const { frontend } = fixture({ liveClaimRows: endpointRows() });
    const observation = await frontend.observeTls(
      { endpointUid: ENDPOINT_UID, workerUid: WORKER_UID, ...ADDRESS },
      execution(),
    );

    expect(observation.ready).toBe(false);
  });

  test("does not echo TLS readiness for a mismatched observer Worker UID", async () => {
    const { frontend } = fixture();
    const observation = await frontend.observeTls(
      { endpointUid: ENDPOINT_UID, workerUid: "worker-foreign", ...ADDRESS },
      execution(),
    );

    expect(observation.ready).toBe(false);
  });

  test("confirms route absence only for the exact in-flight delete and both native/frontend readbacks", async () => {
    const { frontend } = fixture({ routeDelete: true, routeRows: [] });
    const observation = await frontend.observeRouteAbsent(
      { endpointUid: ENDPOINT_UID, workerUid: WORKER_UID, ...ADDRESS },
      execution("delete"),
    );

    expect(observation).toEqual({
      endpointUid: ENDPOINT_UID,
      workerUid: WORKER_UID,
      ...ADDRESS,
      absent: true,
    });
  });

  test("does not echo route absence for a mismatched observer Worker UID", async () => {
    const { frontend } = fixture({ routeDelete: true, routeRows: [] });
    const observation = await frontend.observeRouteAbsent(
      { endpointUid: ENDPOINT_UID, workerUid: "worker-foreign", ...ADDRESS },
      execution("delete"),
    );

    expect(observation.absent).toBe(false);
  });

  test("does not confirm route absence while another current SQL route claims the hostname", async () => {
    const { frontend } = fixture({
      routeDelete: true,
      routeRows: [],
      liveClaimRows: endpointRows(),
    });
    const observation = await frontend.observeRouteAbsent(
      { endpointUid: ENDPOINT_UID, workerUid: WORKER_UID, ...ADDRESS },
      execution("delete"),
    );

    expect(observation.absent).toBe(false);
  });

  test("does not confirm route absence without a frontend absence witness", async () => {
    const { frontend } = fixture({
      routeDelete: true,
      routeRows: [],
      routeWitnessAbsent: false,
    });
    const observation = await frontend.observeRouteAbsent(
      { endpointUid: ENDPOINT_UID, workerUid: WORKER_UID, ...ADDRESS },
      execution("delete"),
    );

    expect(observation.absent).toBe(false);
  });

  test("uses complete owner retirement proof for an Endpoint deleted without a Deployment", async () => {
    const { frontend } = fixture({
      routeDelete: true,
      routeRows: [],
      servingUnknown: true,
      deploymentExists: false,
    });
    const observation = await frontend.observeRouteAbsent(
      { endpointUid: ENDPOINT_UID, workerUid: WORKER_UID, ...ADDRESS },
      execution("delete"),
    );

    expect(observation.absent).toBe(true);
  });

  test("does not treat an unknown serving snapshot as no Deployment when SQL still has one", async () => {
    const { frontend } = fixture({
      routeDelete: true,
      routeRows: [],
      servingUnknown: true,
      deploymentExists: true,
    });
    const observation = await frontend.observeRouteAbsent(
      { endpointUid: ENDPOINT_UID, workerUid: WORKER_UID, ...ADDRESS },
      execution("delete"),
    );

    expect(observation.absent).toBe(false);
  });
});
