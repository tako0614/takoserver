import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type { InstalledTakoformForm, TakoformHost } from "../src/takoform/types.ts";
import { createConfiguredHistoricalTakoformHost } from "./helpers/historical-takoform-host.ts";

const ORIGIN = "https://module-worker-delete-regression.invalid";
const LANE = "/apis/forms.takoform.com/v1beta4";
const FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ModuleWorker",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:049df2fb1eda53e4ccb0d646022a3ded8bc17c44eb433fa2e5ac0861efe42ac7" as const,
};
const FORM: InstalledTakoformForm = {
  identity: { formRef: FORM_REF },
  role: "identity",
  desiredSchema: { type: "object", properties: {}, additionalProperties: false },
  operations: ["create", "read", "delete", "import", "observe"],
};

test("deferred ModuleWorker delete settles after its revision moves", async () => {
  const fixture = await deferredDeleteFixture("module-worker", "module-worker-delete-0001");

  // The live failure accepted this delete at revision 2 while a normal
  // derived-status update left the same UID/generation at revision 3 before
  // the durable operation acquired its lease. Rebuild that persisted state
  // directly, without changing the desired generation or relation graph.
  rewriteResourceRevision(fixture.database, fixture.name, "3", true);
  expect(
    fixture.database
      .query(
        "SELECT uid, generation, revision, json_array_length(relations_json) AS relation_count FROM tf_resources WHERE name = ?",
      )
      .get(fixture.name),
  ).toMatchObject({
    uid: fixture.uid,
    generation: "1",
    revision: "3",
    relation_count: 0,
  });

  const terminal = await drain(fixture.host, fixture.operationId);
  expect(terminal.status).toBe(200);
  expect(await terminal.json()).toMatchObject({
    done: true,
    result: { deleted: true },
  });
  expect(fixture.deleteCalls.count).toBe(1);
  // remove() observes that the current Ready status no longer matches the
  // live WorkerDeployment projection and persists that derived change before
  // it opens the delete saga. The delete fence must still carry revision 2,
  // while the commit evidence records the rendered revision 4.
  expect(
    fixture.database
      .query(
        "SELECT action, resource_generation, resource_revision FROM tf_resource_execution_evidence WHERE operation_id = ?",
      )
      .get(fixture.operationId),
  ).toEqual({
    action: "delete",
    resource_generation: "1",
    resource_revision: "4",
  });
  expect(
    fixture.database
      .query(
        "SELECT name FROM sqlite_schema WHERE name = 'tf_deferred_operations_selection_v1' AND sql LIKE '%accepted_authority_json%'",
      )
      .all(),
  ).toHaveLength(1);
  expect(
    fixture.database.query("SELECT name FROM tf_resources WHERE name = ?").all(fixture.name),
  ).toEqual([]);
  fixture.database.close();
});

test("deferred ModuleWorker delete keeps an explicit If-Match revision fence", async () => {
  const fixture = await deferredDeleteFixture(
    "module-worker-if-match",
    "module-worker-delete-0002",
    {
      "if-match": '"2"',
    },
  );
  rewriteResourceRevision(fixture.database, fixture.name, "3", true);

  const terminal = await drain(fixture.host, fixture.operationId);
  expect(await terminal.json()).toMatchObject({
    done: true,
    error: { code: "revision_conflict" },
  });
  expect(fixture.deleteCalls.count).toBe(0);
  expect(
    fixture.database.query("SELECT generation FROM tf_resources WHERE name = ?").get(fixture.name),
  ).toEqual({ generation: "1" });
  fixture.database.close();
});

test("deferred ModuleWorker delete keeps the generation fence", async () => {
  const fixture = await deferredDeleteFixture(
    "module-worker-generation",
    "module-worker-delete-0003",
  );
  rewriteResourceRevision(fixture.database, fixture.name, "3", true, "2");

  const terminal = await drain(fixture.host, fixture.operationId);
  expect(await terminal.json()).toMatchObject({
    done: true,
    error: { code: "generation_conflict" },
  });
  expect(fixture.deleteCalls.count).toBe(0);
  expect(
    fixture.database.query("SELECT generation FROM tf_resources WHERE name = ?").get(fixture.name),
  ).toEqual({ generation: "2" });
  fixture.database.close();
});

interface DeferredDeleteFixture {
  readonly database: Database;
  readonly host: TakoformHost;
  readonly deleteCalls: { count: number };
  readonly name: string;
  readonly uid: string;
  readonly operationId: string;
}

async function deferredDeleteFixture(
  name: string,
  idempotencyKey: string,
  extraHeaders: Record<string, string> = {},
): Promise<DeferredDeleteFixture> {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const deleteCalls = { count: 0 };
  const host = createHost(database, deleteCalls);
  const resource = {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF },
    metadata: { name, space: "main" },
    spec: {},
  };
  const prepared = await host.handle(request(`${LANE}/resources/prepare`, "POST", resource));
  expect(prepared?.status).toBe(200);
  const preparedBody = (await prepared?.json()) as { review?: { prepareDigest?: string } };
  const prepareDigest = preparedBody.review?.prepareDigest;
  expect(typeof prepareDigest).toBe("string");

  const created = await host.handle(
    request(
      `${LANE}/resources/edge.forms.takoform.com/ModuleWorker/${name}`,
      "PUT",
      { ...resource, review: { prepareDigest } },
      { "idempotency-key": `${idempotencyKey}-create`, "if-none-match": "*" },
    ),
  );
  expect(created?.status).toBe(201);
  const createdBody = (await created?.json()) as {
    metadata?: { generation?: string; uid?: string };
  };
  expect(createdBody.metadata?.generation).toBe("1");
  const uid = createdBody.metadata?.uid;
  expect(typeof uid).toBe("string");
  if (!uid) throw new Error("created ModuleWorker UID missing");

  // The delete is accepted at revision 2; the test mutates it to revision 3
  // only after acceptance, matching the live derived-status race.
  rewriteResourceRevision(database, name, "2", true);
  const query = new URLSearchParams({
    space: "main",
    group: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    definitionVersion: FORM_REF.definitionVersion,
    schemaDigest: FORM_REF.schemaDigest,
  });
  const accepted = await host.handle(
    request(
      `${LANE}/resources/edge.forms.takoform.com/ModuleWorker/${name}?${query}`,
      "DELETE",
      undefined,
      {
        "idempotency-key": idempotencyKey,
        "takoform-conformance-probe": "async",
        "takoform-expected-generation": "1",
        ...extraHeaders,
      },
    ),
  );
  expect(accepted?.status).toBe(202);
  const acceptedBody = (await accepted?.json()) as { operation?: { id?: string } };
  const operationId = acceptedBody.operation?.id;
  expect(typeof operationId).toBe("string");
  if (!operationId) throw new Error("deferred operation ID missing");
  expect(
    database
      .query("SELECT accepted_revision FROM tf_deferred_operations_selection_v1 WHERE id = ?")
      .get(operationId),
  ).toEqual({ accepted_revision: "2" });

  return { database, host, deleteCalls, name, uid, operationId };
}

async function drain(host: TakoformHost, operationId: string): Promise<Response> {
  let terminal: Response | null | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    terminal = await host.handle(request(`${LANE}/operations/${operationId}`, "GET"));
    const body = (await terminal?.clone().json()) as { done?: boolean };
    if (body.done === true) break;
  }
  if (!terminal) throw new Error("operation returned no response");
  return terminal;
}

function createHost(database: Database, deleteCalls: { count: number }): TakoformHost {
  let id = 0;
  const memory = new InMemoryTakoformResourceDriver();
  return createConfiguredHistoricalTakoformHost({
    sql: createSqliteSql(database),
    objects: createMemoryObjectStore(),
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer provider"
        ? { tenantId: "tenant-a", principalId: "principal-a" }
        : null,
    forms: [FORM],
    driver: {
      selectApply: (input) => memory.selectApply(input),
      apply: (input) => memory.apply(input),
      observe: (input) => memory.observe(input),
      delete: async (input) => {
        deleteCalls.count += 1;
        return await memory.delete(input);
      },
      import: (input) => memory.import(input),
      sqliteMigrations: memory.sqliteMigrations,
    },
    routes: {
      hostApiVersion: "forms.takoform.com/v1beta4",
      apiPath: LANE,
      supportProfileApiVersion: "support.takoform.com/v1alpha2",
      reviewSpecDigest: true,
    },
    deferredOperations: {
      shouldDefer: ({ request }) => request.headers.get("takoform-conformance-probe") === "async",
      pollsBeforeCommit: 2,
      retryAfterSeconds: 0,
    },
    randomId: () => `module-worker-${++id}`,
  });
}

function rewriteResourceRevision(
  database: Database,
  name: string,
  revision: string,
  ready: boolean,
  generation = "1",
): void {
  const row = database.query("SELECT resource_json FROM tf_resources WHERE name = ?").get(name) as {
    resource_json?: string;
  } | null;
  if (!row?.resource_json) throw new Error(`resource ${name} is missing`);
  const resource = JSON.parse(row.resource_json) as {
    metadata?: { generation?: string; revision?: string };
    status?: Record<string, unknown>;
  };
  if (!resource.metadata) throw new Error(`resource ${name} metadata is missing`);
  resource.metadata.revision = revision;
  resource.metadata.generation = generation;
  if (ready) {
    resource.status = {
      ...resource.status,
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: "2026-09-20T00:00:00.000Z",
        },
      ],
    };
  }
  database
    .query("UPDATE tf_resources SET generation = ?, revision = ?, resource_json = ? WHERE name = ?")
    .run(generation, revision, JSON.stringify(resource), name);
}

function request(
  path: string,
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  const headers = new Headers({ authorization: "Bearer provider", ...extraHeaders });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
