import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  ApiError,
  createApi,
  type ResourceDeclaration,
  type ResourceOperation,
  type ResourceSummary,
} from "../console/src/api.ts";
import { createStaticStableInMemoryTakoformHost } from "./helpers/historical-takoform-host.ts";

const ORIGIN = "https://api.takoserver.test";
const ORGANIZATION = "org_console";
const FORM_REF = {
  apiVersion: "example.forms.test",
  kind: "Widget",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};
const DECLARATION: ResourceDeclaration = {
  form: FORM_REF,
  space: "tenant:console",
  name: "console-widget",
  spec: { message: "from the console", enabled: false },
};
const RESOURCE_PATH =
  "/apis/forms.takoform.com/v1/resources/example.forms.test/Widget/console-widget";
const RESOURCE: ResourceSummary = {
  apiVersion: FORM_REF.apiVersion,
  kind: FORM_REF.kind,
  form: { formRef: FORM_REF },
  metadata: {
    name: DECLARATION.name,
    space: DECLARATION.space,
    generation: "1",
    uid: "resource-console-widget",
    revision: "1",
    updatedAt: "2026-09-26T00:00:00.000Z",
  },
  spec: DECLARATION.spec,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function transport(handler: (request: Request) => Promise<Response> | Response): Request[] {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return handler(request);
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(fetch, { preconnect: originalFetch.preconnect }),
  );
  return requests;
}

function client() {
  let sessionLosses = 0;
  return {
    api: createApi({
      origin: ORIGIN,
      token: () => "console-session",
      onSessionLost: () => {
        sessionLosses += 1;
      },
    }),
    sessionLosses: () => sessionLosses,
  };
}

describe("console stable Host API contract", () => {
  test.each(["create", "delete"] as const)(
    "distinguishes accepted %s from completion against the real stable Host",
    async (operation) => {
      const host = createStaticStableInMemoryTakoformHost({
        authenticate: async () => ({ tenantId: ORGANIZATION, principalId: "console-user" }),
        forms: [
          {
            identity: { formRef: FORM_REF },
            desiredSchema: { type: "object" },
            operations: ["create", "read", "update", "delete"],
          },
        ],
        deferredOperations: {
          shouldDefer: (input) => input.operation === operation,
          pollsBeforeCommit: 1,
          retryAfterSeconds: 0,
        },
      });
      const responses: Response[] = [];
      const requests = transport(async (request) => {
        const response = (await host.handle(request)) ?? new Response(null, { status: 404 });
        responses.push(response.clone());
        return response;
      });
      const { api } = client();
      const created = await api.createResource(ORGANIZATION, DECLARATION);
      let outcome = created;
      if (operation === "delete") {
        expect(created.state).toBe("completed");
        if (created.state !== "completed") throw new Error("setup create was not completed");
        const deletion = await api.deleteResource(
          ORGANIZATION,
          DECLARATION,
          created.result.metadata.generation,
        );
        expect(deletion.state).toBe("accepted");
        if (deletion.state !== "accepted") throw new Error("delete did not return an operation");
        outcome = deletion;
      }
      expect(outcome.state).toBe("accepted");
      if (outcome.state !== "accepted") throw new Error("missing accepted operation");
      const accepted = responses.findIndex((response) => response.status === 202);
      expect(accepted).toBeGreaterThan(0);
      const envelope = (await responses[accepted]?.json()) as { operation: ResourceOperation };
      expect(outcome.operation).toEqual(envelope.operation);
      expect(requests).toHaveLength(accepted + 1);

      const pending = await api.resourceOperation(ORGANIZATION, outcome.operation.id);
      expect(pending).toMatchObject({ id: outcome.operation.id, done: false });
      const completed = await api.resourceOperation(ORGANIZATION, outcome.operation.id);
      expect(completed).toMatchObject({
        done: true,
        result:
          operation === "delete"
            ? { deleted: true }
            : { resource: { metadata: { name: DECLARATION.name, generation: "1" } } },
      });
      const polls = requests.slice(accepted + 1);
      expect(polls).toHaveLength(2);
      for (const poll of polls) {
        expect(poll.method).toBe("GET");
        expect(new URL(poll.url).pathname).toBe(
          `/apis/forms.takoform.com/v1/operations/${envelope.operation.id}`,
        );
        expect(poll.headers.get("authorization")).toBe("Bearer console-session");
        expect(poll.headers.get("takoform-organization")).toBe(ORGANIZATION);
        expect(poll.headers.has("idempotency-key")).toBe(false);
      }
      expect(await responses[accepted + 1]?.json()).toMatchObject({ done: false });
      expect(await responses.at(-1)?.json()).toEqual(completed);
      expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
      expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(
        operation === "delete" ? 1 : 0,
      );
    },
  );

  test("prepares, applies, reads and generation-fenced deletes against the real stable routes", async () => {
    const host = createStaticStableInMemoryTakoformHost({
      authenticate: async (authorization) =>
        authorization === "Bearer console-session"
          ? { tenantId: ORGANIZATION, principalId: "console-user" }
          : null,
      forms: [
        {
          identity: { formRef: FORM_REF },
          desiredSchema: {
            type: "object",
            properties: { message: { type: "string" }, enabled: { type: "boolean" } },
            required: ["message", "enabled"],
            additionalProperties: false,
          },
          operations: ["create", "read", "update", "delete"],
        },
      ],
    });
    const responses: Response[] = [];
    const requests = transport(async (request) => {
      const response = await host.handle(request);
      if (!response) return new Response(null, { status: 404 });
      responses.push(response.clone());
      return response;
    });
    const { api, sessionLosses } = client();

    const outcome = await api.createResource(ORGANIZATION, DECLARATION);
    expect(outcome.state).toBe("completed");
    if (outcome.state !== "completed") throw new Error("create did not complete");
    const created = outcome.result;
    expect(created).toMatchObject({
      apiVersion: "example.forms.test",
      kind: "Widget",
      form: { formRef: FORM_REF },
      metadata: { name: "console-widget", space: "tenant:console", generation: "1" },
      spec: { message: "from the console", enabled: false },
    });
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/apis/forms.takoform.com/v1/resources/prepare"],
      ["PUT", RESOURCE_PATH],
    ]);
    const preparedBody = await requests[0]?.json();
    expect(preparedBody).toEqual({
      apiVersion: "example.forms.test",
      kind: "Widget",
      form: { formRef: FORM_REF },
      metadata: { name: "console-widget", space: "tenant:console" },
      spec: { message: "from the console", enabled: false },
    });
    const prepared = (await responses[0]?.json()) as { review: { prepareDigest: string } };
    expect(await requests[1]?.json()).toEqual({
      ...preparedBody,
      review: { prepareDigest: prepared.review.prepareDigest },
    });
    expect(requests[0]?.headers.get("idempotency-key")).toBeNull();
    expect(requests[1]?.headers.get("if-none-match")).toBe("*");
    expect(requests[1]?.headers.get("idempotency-key")).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u,
    );
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer console-session");
      expect(request.headers.get("takoform-organization")).toBe(ORGANIZATION);
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.credentials).toBe("include");
    }

    // There is no single-resource GET wrapper: verify the Host can read the
    // identity produced by the console before using it as the deletion fence.
    const readUrl = new URL(`${ORIGIN}${RESOURCE_PATH}`);
    readUrl.search = new URLSearchParams({
      space: DECLARATION.space,
      definitionVersion: FORM_REF.definitionVersion,
      schemaDigest: FORM_REF.schemaDigest,
    }).toString();
    const read = () =>
      host.handle(new Request(readUrl, { headers: { authorization: "Bearer console-session" } }));
    const retrieved = await read();
    expect(retrieved?.status).toBe(200);
    expect(await retrieved?.json()).toMatchObject({
      metadata: created.metadata,
      spec: created.spec,
    });

    expect(
      await api.deleteResource(ORGANIZATION, DECLARATION, created.metadata.generation),
    ).toEqual({
      state: "completed",
      result: undefined,
    });
    const deleted = requests[2];
    expect(deleted?.method).toBe("DELETE");
    expect(new URL(deleted?.url ?? "").pathname).toBe(RESOURCE_PATH);
    expect([...new URL(deleted?.url ?? "").searchParams]).toEqual([
      ["space", "tenant:console"],
      ["definitionVersion", "1.0.0"],
      ["schemaDigest", FORM_REF.schemaDigest],
    ]);
    expect(deleted?.headers.get("takoform-organization")).toBe(ORGANIZATION);
    expect(deleted?.headers.get("takoform-expected-generation")).toBe("1");
    expect(deleted?.headers.get("idempotency-key")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
    expect(deleted?.headers.has("content-type")).toBe(false);
    expect(await deleted?.text()).toBe("");
    const missing = await read();
    expect(missing?.status).toBe(404);
    expect(await missing?.json()).toMatchObject({ error: { code: "resource_not_found" } });
    expect(sessionLosses()).toBe(0);
  });

  test("keeps resource names in one path segment and exact pins in deletion query values", async () => {
    // Wire-level escaping is independent of admission: this deliberately
    // invalid name must not become another route or inject a query parameter.
    const declaration = {
      ...DECLARATION,
      name: "name/with?x=1#part%",
      space: "tenant:日本 +&?%",
      form: { ...FORM_REF, definitionVersion: "1.0.0+console" },
    };
    const digest = `sha256:${"b".repeat(64)}`;
    const requests = transport((request) =>
      request.method === "POST"
        ? Response.json({ review: { prepareDigest: digest } })
        : request.method === "PUT"
          ? Response.json(RESOURCE)
          : new Response(null, { status: 204 }),
    );
    const { api } = client();
    // Use an ASCII space for create because the existing idempotency key
    // includes it; deletion transports the full Space value in its query.
    await api.createResource(ORGANIZATION, { ...declaration, space: "tenant:console" });
    await api.deleteResource(ORGANIZATION, declaration, "42");

    const encodedPath =
      "/apis/forms.takoform.com/v1/resources/example.forms.test/Widget/name%2Fwith%3Fx%3D1%23part%25";
    expect(new URL(requests[1]?.url ?? "").pathname).toBe(encodedPath);
    const deletedUrl = new URL(requests[2]?.url ?? "");
    expect(deletedUrl.pathname).toBe(encodedPath);
    expect(deletedUrl.hash).toBe("");
    expect(deletedUrl.search).toBe(
      `?space=tenant%3A%E6%97%A5%E6%9C%AC+%2B%26%3F%25&definitionVersion=1.0.0%2Bconsole&schemaDigest=sha256%3A${"a".repeat(64)}`,
    );
    expect([...deletedUrl.searchParams]).toEqual([
      ["space", "tenant:日本 +&?%"],
      ["definitionVersion", "1.0.0+console"],
      ["schemaDigest", FORM_REF.schemaDigest],
    ]);
    expect(requests[2]?.headers.get("takoform-expected-generation")).toBe("42");
  });

  test("does not apply after prepare fails, and preserves the Host error without losing the session", async () => {
    const requests = transport(() =>
      Response.json({ error: { code: "permission_denied" } }, { status: 403 }),
    );
    const { api, sessionLosses } = client();
    await expect(api.createResource(ORGANIZATION, DECLARATION)).rejects.toMatchObject({
      name: "ApiError",
      code: "permission_denied",
      status: 403,
      path: "/apis/forms.takoform.com/v1/resources/prepare",
      isExpiredSession: false,
    });
    expect(requests.map((request) => request.method)).toEqual(["POST"]);
    expect(sessionLosses()).toBe(0);
  });

  test("preserves apply errors after a successful review without retrying the mutation", async () => {
    const requests = transport((request) =>
      request.method === "POST"
        ? Response.json({ review: { prepareDigest: `sha256:${"b".repeat(64)}` } })
        : Response.json({ error: { code: "generation_conflict" } }, { status: 412 }),
    );
    const { api } = client();
    await expect(api.createResource(ORGANIZATION, DECLARATION)).rejects.toMatchObject({
      code: "generation_conflict",
      status: 412,
      path: RESOURCE_PATH,
    });
    expect(requests.map((request) => request.method)).toEqual(["POST", "PUT"]);
  });

  test("a Host-lane 401 is not mistaken for an expired control-plane session", async () => {
    transport(() => Response.json({ error: { code: "unauthenticated" } }, { status: 401 }));
    const { api, sessionLosses } = client();
    await expect(api.deleteResource(ORGANIZATION, DECLARATION, "1")).rejects.toMatchObject({
      code: "unauthenticated",
      status: 401,
      isExpiredSession: false,
    });
    expect(sessionLosses()).toBe(0);
  });
});

describe("console resource inventory API contract", () => {
  test("GET encodes the organization and pagination query, and returns the server page unchanged", async () => {
    const page = {
      resources: [
        {
          apiVersion: "example.forms.test",
          kind: "Widget",
          metadata: {
            name: "console-widget",
            space: "tenant:日本 +&?%",
            generation: "7",
            uid: "resource-console-widget",
            revision: "9",
            updatedAt: "2026-09-26T00:00:00.000Z",
          },
          form: { formRef: FORM_REF },
          spec: { message: "declared" },
          status: { outputs: { endpoint: "https://widget.example.test" } },
        },
      ],
      cursor: "next+/=&?%",
    };
    const requests = transport(() => Response.json(page));
    const { api } = client();
    expect(
      await api.resources("org/console?x=1#%", {
        space: "tenant:日本 +&?%",
        cursor: "page+/=&?%",
      }),
    ).toEqual(page);
    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe(
      `${ORIGIN}/v1/organizations/org%2Fconsole%3Fx%3D1%23%25/resources?space=tenant%3A%E6%97%A5%E6%9C%AC+%2B%26%3F%25&cursor=page%2B%2F%3D%26%3F%25`,
    );
    expect(request?.headers.get("authorization")).toBe("Bearer console-session");
    expect(request?.headers.has("content-type")).toBe(false);
    expect(request?.credentials).toBe("include");
    expect(await request?.text()).toBe("");
  });

  test("unfiltered reads have no query suffix and resolve the current token for every call", async () => {
    const requests = transport(() => Response.json({ resources: [] }));
    let token: string | null = "first-session";
    const api = createApi({ origin: ORIGIN, token: () => token, onSessionLost: () => undefined });
    await api.resources(ORGANIZATION);
    token = "refreshed-session";
    await api.resources(ORGANIZATION);
    token = null;
    await api.resources(ORGANIZATION, { space: "", cursor: "" });
    expect(requests.map((request) => request.url)).toEqual([
      `${ORIGIN}/v1/organizations/org_console/resources`,
      `${ORIGIN}/v1/organizations/org_console/resources`,
      `${ORIGIN}/v1/organizations/org_console/resources`,
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer first-session",
      "Bearer refreshed-session",
      null,
    ]);
    expect(requests.every((request) => request.credentials === "include")).toBe(true);
  });

  test.each([
    { status: 401, body: { error: { code: "unauthenticated" } }, code: "unauthenticated", lost: 1 },
    {
      status: 403,
      body: { error: { code: "permission_denied" } },
      code: "permission_denied",
      lost: 0,
    },
    { status: 502, body: { error: { code: 123 } }, code: "http_502", lost: 0 },
  ])("reports control-plane errors: $status $code", async ({ status, body, code, lost }) => {
    transport(() => Response.json(body, { status }));
    const { api, sessionLosses } = client();
    await expect(api.resources(ORGANIZATION)).rejects.toMatchObject({
      name: "ApiError",
      code,
      message: code,
      status,
      path: "/v1/organizations/org_console/resources",
      isExpiredSession: lost === 1,
    });
    expect(sessionLosses()).toBe(lost);
  });

  test("non-JSON failures retain the HTTP status instead of leaking a JSON parsing error", async () => {
    transport(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
    const { api, sessionLosses } = client();
    await expect(api.resources(ORGANIZATION)).rejects.toMatchObject({
      code: "http_502",
      status: 502,
      path: "/v1/organizations/org_console/resources",
    });
    expect(sessionLosses()).toBe(0);
  });

  test("network failures are unreachable rather than an HTTP error or an expired session", async () => {
    const requests = transport(() => {
      throw new TypeError("connection refused");
    });
    const { api, sessionLosses } = client();
    const failure = await api.resources(ORGANIZATION).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "unreachable", status: 0, isExpiredSession: false });
    expect(requests).toHaveLength(1);
    expect(sessionLosses()).toBe(0);
  });
});

describe("console accepted operation reads", () => {
  const id = "operation/with?query#part%";
  const path = "/apis/forms.takoform.com/v1/operations/operation%2Fwith%3Fquery%23part%25";
  const operation = {
    apiVersion: "operations.takoform.com/v1alpha1",
    kind: "Operation",
    id,
  };

  test("preserves terminal Host failures carried by HTTP 200 without replaying a mutation", async () => {
    const requests = transport(() =>
      Response.json({
        ...operation,
        done: true,
        error: { code: "dependency_in_use", message: "still referenced", retryable: false },
      }),
    );
    const { api, sessionLosses } = client();
    await expect(api.resourceOperation(ORGANIZATION, id)).rejects.toMatchObject({
      name: "ApiError",
      code: "dependency_in_use",
      status: 200,
      path,
      isExpiredSession: false,
    });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `${ORIGIN}${path}`],
    ]);
    expect(requests[0]?.headers.get("takoform-organization")).toBe(ORGANIZATION);
    expect(sessionLosses()).toBe(0);
  });

  test.each([
    { done: true },
    { done: true, result: {} },
    { done: true, result: { deleted: false } },
    { done: true, result: { resource: { kind: "Widget" } } },
    { done: true, result: { resource: RESOURCE, deleted: true } },
    { done: true, result: { resource: RESOURCE }, error: { code: "failed" } },
    { done: "true", result: { deleted: true } },
    { done: true, result: { deleted: true }, id: "another-operation" },
  ])("rejects unknown or contradictory terminal results: %j", async (result) => {
    transport(() => Response.json({ ...operation, ...result }));
    const { api } = client();
    await expect(api.resourceOperation(ORGANIZATION, id)).rejects.toMatchObject({
      code: "invalid_response",
      status: 200,
      path,
    });
  });

  test.each([{}, { operation: { ...operation, done: true } }, { operation: { done: false } }])(
    "does not turn malformed 202 responses into completion: %j",
    async (body) => {
      transport((request) =>
        request.method === "POST"
          ? Response.json({ review: { prepareDigest: `sha256:${"b".repeat(64)}` } })
          : Response.json(body, { status: 202 }),
      );
      const { api } = client();
      await expect(api.createResource(ORGANIZATION, DECLARATION)).rejects.toMatchObject({
        code: "invalid_response",
        status: 202,
      });
      await expect(api.deleteResource(ORGANIZATION, DECLARATION, "1")).rejects.toMatchObject({
        code: "invalid_response",
        status: 202,
      });
    },
  );
});
