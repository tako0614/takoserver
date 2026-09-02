import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject } from "../src/ports.ts";
import type {
  InstalledTakoformForm,
  TakoformHost,
  TakoformResourceDriver,
  TakoformV1Alpha3FormRef,
} from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

/**
 * One `tofu apply` is a wave, not a sequence.
 *
 * OpenTofu orders only what the graph declares an edge for, and the Edge family
 * gives a `WorkerEndpoint` and the `WorkerDeployment` that makes its Worker
 * serve no edge to each other: both point at the ModuleWorker. So the endpoint
 * is routinely created while the deployment is still being created, and on the
 * way down the deployment is routinely deleted while the endpoint is still
 * being deleted. The Host used to answer the first with
 * `unsupported_capability` — "the required Host capability is unavailable",
 * sending the operator to find a different Host — and the second with
 * `dependency_in_use`, "the resource gained a blocking dependency", about a
 * holder that had already gone.
 */

const LANE = "/apis/forms.takoform.com/v1";
const EDGE = "edge.forms.takoform.com";

const MODULE_WORKER = form("ModuleWorker", "1", "identity", {
  type: "object",
  additionalProperties: false,
  properties: {},
});
const WORKER_VERSION = form("WorkerVersion", "2", "revision", {
  type: "object",
  additionalProperties: false,
  properties: {
    worker: reference("ModuleWorker", MODULE_WORKER.identity.formRef),
    handlers: { type: "array", items: { type: "string" } },
  },
  required: ["worker", "handlers"],
});
const WORKER_DEPLOYMENT = form(
  "WorkerDeployment",
  "3",
  "deployment",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      worker: reference("ModuleWorker", MODULE_WORKER.identity.formRef),
      versions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            workerVersion: reference("WorkerVersion", WORKER_VERSION.identity.formRef),
            weight: { type: "integer" },
          },
          required: ["workerVersion", "weight"],
        },
      },
    },
    required: ["worker", "versions"],
  },
  [
    { kind: "exclusive", reference: "/worker" },
    { kind: "sum", list: "/versions", member: "weight", total: 10_000 },
  ],
);
const WORKER_ENDPOINT = form("WorkerEndpoint", "4", "attachment", {
  type: "object",
  additionalProperties: false,
  properties: { worker: reference("ModuleWorker", MODULE_WORKER.identity.formRef) },
  required: ["worker"],
});
const FORMS = [MODULE_WORKER, WORKER_VERSION, WORKER_DEPLOYMENT, WORKER_ENDPOINT];

test("a WorkerEndpoint created before its own wave's WorkerDeployment succeeds", async () => {
  let releaseDeployment = () => {};
  const held = new Promise<void>((resolve) => {
    releaseDeployment = resolve;
  });
  let deploymentEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    deploymentEntered = resolve;
  });
  const host = stableHost({
    async apply(input) {
      if (input.form.identity.formRef.kind === "WorkerDeployment") {
        deploymentEntered();
        await held;
      }
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete() {},
  });

  expect((await apply(host, MODULE_WORKER, "worker", {})).status).toBe(201);
  expect(
    (
      await apply(host, WORKER_VERSION, "version", {
        worker: named("ModuleWorker", "worker"),
        handlers: ["fetch"],
      })
    ).status,
  ).toBe(201);

  const deploying = apply(host, WORKER_DEPLOYMENT, "deployment", {
    worker: named("ModuleWorker", "worker"),
    versions: [{ workerVersion: named("WorkerVersion", "version"), weight: 10_000 }],
  });
  await entered;
  const attaching = apply(host, WORKER_ENDPOINT, "endpoint", {
    worker: named("ModuleWorker", "worker"),
  });
  // Long enough that the endpoint's create has reached the aggregate check and
  // is parked in the wave wait: before this fix it had already been refused
  // `unsupported_capability` by now, and after it the reserved deployment claim
  // keeps the wait open for as long as the deployment's own create runs.
  await parked();
  releaseDeployment();

  expect((await deploying).status).toBe(201);
  expect((await attaching).status).toBe(201);
});

test("a WorkerEndpoint whose ModuleWorker declares no WorkerDeployment names what is missing", async () => {
  const host = stableHost({
    async apply(input) {
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete() {},
  });
  expect((await apply(host, MODULE_WORKER, "worker", {})).status).toBe(201);

  const refused = await apply(host, WORKER_ENDPOINT, "endpoint", {
    worker: named("ModuleWorker", "worker"),
  });
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({
    error: {
      code: "invalid_argument",
      retryable: false,
      message: expect.stringContaining("has no WorkerDeployment"),
    },
  });
});

test("a WorkerDeployment delete racing its WorkerEndpoint's delete succeeds", async () => {
  let releaseEndpoint = () => {};
  const held = new Promise<void>((resolve) => {
    releaseEndpoint = resolve;
  });
  let endpointEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    endpointEntered = resolve;
  });
  const host = stableHost({
    async apply(input) {
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete(input) {
      if (input.resource.kind === "WorkerEndpoint") {
        endpointEntered();
        await held;
      }
    },
  });
  await applyGraph(host);

  const removingEndpoint = remove(host, WORKER_ENDPOINT, "endpoint");
  await entered;
  const removingDeployment = remove(host, WORKER_DEPLOYMENT, "deployment");
  // Same rendezvous: before this fix the deployment's delete had already been
  // refused `dependency_in_use` by now, naming a holder that was in the act of
  // going away.
  await parked();
  releaseEndpoint();

  expect((await removingEndpoint).status).toBe(204);
  expect((await removingDeployment).status).toBe(204);
});

test("a WorkerDeployment delete still refuses a WorkerEndpoint nobody is deleting", async () => {
  const host = stableHost({
    async apply(input) {
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete() {},
  });
  await applyGraph(host);

  const refused = await remove(host, WORKER_DEPLOYMENT, "deployment");
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({
    error: {
      code: "dependency_in_use",
      retryable: false,
      message: expect.stringContaining("WorkerEndpoint endpoint"),
    },
  });
});

/** Time for a racing request to reach the aggregate check and start waiting. */
function parked(): Promise<void> {
  return new Promise<void>((wake) => {
    setTimeout(wake, 200);
  });
}

async function applyGraph(host: TakoformHost): Promise<void> {
  expect((await apply(host, MODULE_WORKER, "worker", {})).status).toBe(201);
  expect(
    (
      await apply(host, WORKER_VERSION, "version", {
        worker: named("ModuleWorker", "worker"),
        handlers: ["fetch"],
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await apply(host, WORKER_DEPLOYMENT, "deployment", {
        worker: named("ModuleWorker", "worker"),
        versions: [{ workerVersion: named("WorkerVersion", "version"), weight: 10_000 }],
      })
    ).status,
  ).toBe(201);
  expect(
    (await apply(host, WORKER_ENDPOINT, "endpoint", { worker: named("ModuleWorker", "worker") }))
      .status,
  ).toBe(201);
}

function stableHost(driver: TakoformResourceDriver): TakoformHost {
  return createStaticStableTestTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: FORMS,
    driver,
  });
}

async function apply(
  host: TakoformHost,
  installed: InstalledTakoformForm,
  name: string,
  spec: JsonObject,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const desired = {
    apiVersion: installed.identity.formRef.apiVersion,
    kind: installed.identity.formRef.kind,
    form: { formRef: installed.identity.formRef },
    metadata: { name, space: "main" },
    spec,
  };
  const prepared = await host.handle(
    request(`${LANE}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
  );
  if (prepared?.status !== 200) {
    return { status: prepared?.status ?? 0, body: await prepared?.json() };
  }
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;
  const applied = await host.handle(
    request(`${LANE}/resources/${EDGE}/${installed.identity.formRef.kind}/${name}`, {
      method: "PUT",
      headers: { "idempotency-key": `create-${name}`, "if-none-match": "*" },
      body: JSON.stringify({ ...desired, review }),
    }),
  );
  return { status: applied?.status ?? 0, body: await applied?.json() };
}

async function remove(
  host: TakoformHost,
  installed: InstalledTakoformForm,
  name: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const query = new URLSearchParams({
    space: "main",
    definitionVersion: installed.identity.formRef.definitionVersion,
    schemaDigest: installed.identity.formRef.schemaDigest,
  });
  const removed = await host.handle(
    request(`${LANE}/resources/${EDGE}/${installed.identity.formRef.kind}/${name}?${query}`, {
      method: "DELETE",
      headers: {
        "idempotency-key": `delete-${name}`,
        "takoform-expected-generation": "1",
      },
    }),
  );
  return {
    status: removed?.status ?? 0,
    body: removed?.status === 204 ? undefined : await removed?.json(),
  };
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer test");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://api.takoserver.com${path}`, { ...init, headers });
}

function named(kind: string, name: string): JsonObject {
  return { apiVersion: EDGE, kind, name };
}

function reference(kind: string, formRef: TakoformV1Alpha3FormRef): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      apiVersion: { const: EDGE },
      kind: { const: kind },
      name: { type: "string" },
    },
    required: ["apiVersion", "kind", "name"],
    "x-takoform-target-formrefs": [
      {
        apiVersion: formRef.apiVersion,
        kind: formRef.kind,
        definitionVersion: formRef.definitionVersion,
        schemaDigest: formRef.schemaDigest,
      },
    ],
  };
}

function form(
  kind: string,
  digit: string,
  role: NonNullable<InstalledTakoformForm["role"]>,
  desiredSchema: JsonObject,
  constraints?: InstalledTakoformForm["constraints"],
): InstalledTakoformForm {
  return {
    identity: {
      formRef: {
        apiVersion: EDGE,
        kind,
        definitionVersion: "0.1.0",
        schemaDigest: `sha256:${digit.repeat(64)}`,
      },
    },
    role,
    desiredSchema,
    ...(constraints ? { constraints } : {}),
    operations:
      role === "revision"
        ? ["create", "read", "delete"]
        : role === "deployment"
          ? ["create", "read", "update", "delete"]
          : ["create", "read", "delete"],
  };
}
