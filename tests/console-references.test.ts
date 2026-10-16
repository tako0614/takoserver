import { expect, test } from "bun:test";
import type { ResourceSummary } from "../console/src/api.ts";
import { servedWorkers } from "../console/src/references.ts";
import { health } from "../console/src/resource-state.ts";

const forms = "https://edge.forms.takoform.com/forms";
const resource = (
  uid: string,
  form: string,
  spec: unknown,
  output: ResourceSummary["output"] = {},
  observed: ResourceSummary["observed"] = {},
): ResourceSummary => ({
  uid,
  form: `${forms}/${form}/`,
  space: "org",
  name: uid,
  generation: 1,
  observedGeneration: 1,
  observedAt: "2026-10-16T00:00:00Z",
  phase: "idle",
  spec: spec as ResourceSummary["spec"],
  observed,
  output,
  lastOperation: `op-${uid}`,
});

test("finds each Worker's Deployment and published addresses", () => {
  const worker = resource("hello", "ModuleWorker/0.3.0", {});
  const quiet = resource("quiet", "ModuleWorker/0.3.0", {});
  const version = resource("hello-v1", "WorkerVersion/0.5.0", { worker: { resourceUid: "hello" } });
  const deployment = resource(
    "hello-deployment",
    "WorkerDeployment/0.4.0",
    {
      worker: { resourceUid: "hello" },
      versions: [{ workerVersion: { resourceUid: "hello-v1" }, weight: 10000 }],
    },
    {},
    { ready: true },
  );
  const endpoint = resource(
    "hello-endpoint",
    "WorkerEndpoint/0.3.0",
    { worker: { resourceUid: "hello" } },
    { hostname: "hello.apps.example.com", url: "https://hello.apps.example.com/" },
  );
  const served = servedWorkers([worker, version, deployment, endpoint, quiet]);
  expect(served.map((entry) => entry.worker.uid)).toEqual(["hello", "quiet"]);
  expect(served[0]?.deployment?.uid).toBe("hello-deployment");
  expect(served[0]?.endpoints.map((entry) => entry.uid)).toEqual(["hello-endpoint"]);
  expect(served[1]?.deployment).toBeUndefined();
  expect(served[1]?.endpoints).toEqual([]);
});

test("a WorkerEndpoint is ready when its active Deployment's route is", () => {
  const endpoint = (routeReady: boolean) =>
    resource("e", "WorkerEndpoint/0.3.0", {}, {}, { activeDeploymentRouteReady: routeReady });
  expect(health(endpoint(true)).phase).toBe("Ready");
  expect(health(endpoint(false)).phase).toBe("NotReady");
  // Only an Endpoint's route flag counts as its readiness.
  expect(
    health(resource("x", "SQLiteDatabase/0.2.0", {}, {}, { activeDeploymentRouteReady: true }))
      .phase,
  ).toBe("Applied");
});
