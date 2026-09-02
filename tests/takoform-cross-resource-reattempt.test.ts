import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { STABLE_ERROR_HTTP_STATUS } from "../src/error-envelope.ts";

import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject } from "../src/ports.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type {
  InstalledTakoformForm,
  TakoformHost,
  TakoformV1Alpha3FormRef,
} from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

/**
 * A refusal about a neighbour is not the answer to the next request.
 *
 * The released provider derives its `Idempotency-Key` from the plan, so an
 * operator who repairs something and re-runs `tofu apply` presents a
 * byte-identical request under a byte-identical key. ADR 0008 already answers
 * that: a refusal about the *request* is replayed, a refusal about the *Host*
 * is re-attempted. What the code alone could not say is which of the two an
 * `invalid_argument` is. "Your weights do not sum to 10000" is a fact about the
 * document that no repair elsewhere changes. "The ModuleWorker you name has no
 * WorkerDeployment", "another resource already claims this hostname", "a second
 * deployment already holds this Worker" are facts about a *neighbour* — and
 * each is cured by adding the deployment, releasing the hostname, or deleting
 * the other deployment, without one byte of this resource's plan moving.
 *
 * So those refusals carry `hostCode: cross_resource_precondition` and are
 * re-attempted; a malformed document still replays. The wire answer is
 * unchanged in both cases: `invalid_argument` 400, `retryable: false`, so
 * provider 4.0.0 surfaces the refusal to the operator now rather than retrying
 * it, and only the *next* identical apply gets a fresh attempt.
 */

const LANE = "/apis/forms.takoform.com/v1";
const EDGE = "edge.forms.takoform.com";
const ASYNC = { "takoform-conformance-probe": "async" } as const;

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
const WORKER_CUSTOM_DOMAIN = form("WorkerCustomDomain", "5", "attachment", {
  type: "object",
  additionalProperties: false,
  properties: {
    worker: reference("ModuleWorker", MODULE_WORKER.identity.formRef),
    hostname: { type: "string" },
  },
  required: ["worker", "hostname"],
});
const FORMS = [
  MODULE_WORKER,
  WORKER_VERSION,
  WORKER_DEPLOYMENT,
  WORKER_ENDPOINT,
  WORKER_CUSTOM_DOMAIN,
];

test("an endpoint refused for a missing WorkerDeployment is created by the identical apply once the deployment lands", async () => {
  const host = deferringHost();
  expect((await apply(host, MODULE_WORKER, "worker", {})).status).toBe(201);
  expect(
    (
      await apply(host, WORKER_VERSION, "version", {
        worker: named("ModuleWorker", "worker"),
        handlers: ["fetch"],
      })
    ).status,
  ).toBe(201);

  const endpoint = () =>
    applyAsync(host, WORKER_ENDPOINT, "endpoint", { worker: named("ModuleWorker", "worker") });

  const refused = await endpoint();
  expect(refused.terminal).toMatchObject({
    done: true,
    error: {
      code: "invalid_argument",
      retryable: false,
      hostCode: "cross_resource_precondition",
      message: expect.stringContaining("has no WorkerDeployment"),
    },
  });

  // The neighbour lands. Nothing in the endpoint's own plan moved, so the
  // provider re-presents the identical request under the identical key.
  expect(
    (
      await apply(host, WORKER_DEPLOYMENT, "deployment", {
        worker: named("ModuleWorker", "worker"),
        versions: [{ workerVersion: named("WorkerVersion", "version"), weight: 10_000 }],
      })
    ).status,
  ).toBe(201);

  const created = await endpoint();
  expect(created.operationId).not.toBe(refused.operationId);
  expect(created.terminal).toMatchObject({
    done: true,
    result: { resource: { metadata: { name: "endpoint" } } },
  });
});

test("a hostname refused as claimed elsewhere is claimed by the identical apply once the holder is gone", async () => {
  const host = deferringHost();
  await servingWorker(host);
  expect(
    (
      await apply(host, WORKER_CUSTOM_DOMAIN, "taken", {
        worker: named("ModuleWorker", "worker"),
        hostname: "app.example",
      })
    ).status,
  ).toBe(201);

  const wanted = () =>
    applyAsync(host, WORKER_CUSTOM_DOMAIN, "wanted", {
      worker: named("ModuleWorker", "worker"),
      hostname: "app.example",
    });

  const refused = await wanted();
  expect(refused.terminal).toMatchObject({
    done: true,
    error: {
      code: "invalid_argument",
      retryable: false,
      hostCode: "cross_resource_precondition",
      message: expect.stringContaining("already claimed by taken"),
    },
  });

  expect((await remove(host, WORKER_CUSTOM_DOMAIN, "taken")).status).toBe(204);

  const claimed = await wanted();
  expect(claimed.operationId).not.toBe(refused.operationId);
  expect(claimed.terminal).toMatchObject({
    done: true,
    result: { resource: { metadata: { name: "wanted" } } },
  });
});

test("a malformed desired document is still replayed under the same key", async () => {
  const host = deferringHost();
  expect((await apply(host, MODULE_WORKER, "worker", {})).status).toBe(201);
  expect(
    (
      await apply(host, WORKER_VERSION, "version", {
        worker: named("ModuleWorker", "worker"),
        handlers: ["fetch"],
      })
    ).status,
  ).toBe(201);

  // One WorkerVersion selected twice. The weights sum, the Worker exists, and
  // the deployment already holds its own `/worker` claim: nothing outside this
  // document can make it true, so the stored refusal is still the answer.
  const duplicated = () =>
    applyAsync(host, WORKER_DEPLOYMENT, "deployment", {
      worker: named("ModuleWorker", "worker"),
      versions: [
        { workerVersion: named("WorkerVersion", "version"), weight: 5_000 },
        { workerVersion: named("WorkerVersion", "version"), weight: 5_000 },
      ],
    });

  const refused = await duplicated();
  expect(refused.terminal).toMatchObject({
    done: true,
    error: { code: "invalid_argument", retryable: false },
  });
  expect((refused.terminal.error as Record<string, unknown>).hostCode).toBeUndefined();

  const replayed = await duplicated();
  expect(replayed.operationId).toBe(refused.operationId);
  expect(replayed.terminal).toEqual(refused.terminal);
});

/**
 * The marker travels on the one envelope the released provider decodes.
 *
 * `parseAPIError` and the terminal-operation decoder both read the envelope
 * with `DisallowUnknownFields`, and `hostCode` is the only member they declare
 * beyond the four required ones and `details`. So a Host that carried this
 * classification in a field of its own invention would not be adding a hint —
 * it would be making every refusal on that path protocol-invalid.
 */
test("a cross-resource refusal adds hostCode and nothing else to the envelope", async () => {
  const host = deferringHost();
  expect((await apply(host, MODULE_WORKER, "worker", {})).status).toBe(201);

  const refused = await apply(host, WORKER_ENDPOINT, "endpoint", {
    worker: named("ModuleWorker", "worker"),
  });
  expect(refused.status).toBe(400);
  const error = (refused.body as { error: Record<string, unknown> }).error;
  expect(Object.keys(error).sort()).toEqual([
    "code",
    "hostCode",
    "message",
    "requestId",
    "retryable",
  ]);
  expect(error).toMatchObject({
    code: "invalid_argument",
    retryable: false,
    hostCode: "cross_resource_precondition",
  });
  expect(STABLE_ERROR_HTTP_STATUS[String(error.code)]).toBe(400);
});

async function servingWorker(host: TakoformHost): Promise<void> {
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
}

/** The production shape: the mutation is a durable operation the caller polls. */
function deferringHost(): TakoformHost {
  return createStaticStableTestTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: FORMS,
    driver: new InMemoryTakoformResourceDriver(),
    deferredOperations: {
      shouldDefer: ({ request: incoming }) =>
        incoming.headers.get("takoform-conformance-probe") === "async",
      pollsBeforeCommit: 1,
      retryAfterSeconds: 0,
    },
  });
}

async function applyAsync(
  host: TakoformHost,
  installed: InstalledTakoformForm,
  name: string,
  spec: JsonObject,
): Promise<{ readonly operationId: string; readonly terminal: Record<string, unknown> }> {
  const accepted = await apply(host, installed, name, spec, ASYNC);
  expect(accepted.status).toBe(202);
  const operationId = (accepted.body as { operation: { id: string } }).operation.id;
  let terminal: Record<string, unknown> | undefined;
  for (let poll = 0; poll < 8 && !terminal?.done; poll += 1) {
    const polled = await host.handle(request(`${LANE}/operations/${operationId}`));
    terminal = (await polled?.json()) as Record<string, unknown>;
  }
  if (!terminal?.done) throw new Error(`operation ${operationId} never settled`);
  return { operationId, terminal };
}

async function apply(
  host: TakoformHost,
  installed: InstalledTakoformForm,
  name: string,
  spec: JsonObject,
  headers: Record<string, string> = {},
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
      headers: { ...headers, "idempotency-key": `create-${name}`, "if-none-match": "*" },
      body: JSON.stringify({ ...desired, review }),
    }),
  );
  return { status: applied?.status ?? 0, body: await applied?.json() };
}

async function remove(
  host: TakoformHost,
  installed: InstalledTakoformForm,
  name: string,
): Promise<{ readonly status: number }> {
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
  return { status: removed?.status ?? 0 };
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
