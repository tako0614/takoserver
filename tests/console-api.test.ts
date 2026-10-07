import { afterEach, expect, test } from "bun:test";
import { createApi } from "../console/src/api.ts";

const origin = "https://api.example.test";
const org = "org/example?x=1#%";
const form = "https://forms.example.test/Widget/1.0.0";
const resource = {
  uid: "uid/one?%",
  form,
  space: org,
  name: "one",
  generation: 1,
  observedGeneration: 0,
  observedAt: null,
  phase: "pending" as const,
  spec: { value: 1 },
  observed: {},
  output: {},
  lastOperation: "operation-one",
};
const operation = {
  id: "operation-one",
  resourceUid: resource.uid,
  action: "create",
  generation: 1,
  status: "queued",
  effect: "none",
  createdAt: "2026-10-07T00:00:00Z",
  updatedAt: "2026-10-07T00:00:00Z",
  retainUntil: "2026-10-08T00:00:00Z",
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(onSessionLost: () => void = () => undefined) {
  return createApi({ origin, token: () => "session", onSessionLost });
}

function transport(handler: (request: Request) => Response | Promise<Response>): Request[] {
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request.clone());
      return handler(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  return seen;
}

test("v2 create, read, update and delete keep exact UID, generation and caller key", async () => {
  const seen = transport((request) => {
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" &&
      path.endsWith(`/operations/${encodeURIComponent(operation.id)}`)
    )
      return Response.json({ ...operation, status: "succeeded", effect: "complete" });
    if (request.method === "GET") return Response.json(resource);
    return Response.json(
      {
        ...operation,
        action:
          request.method === "DELETE" ? "delete" : request.method === "PUT" ? "update" : "create",
      },
      { status: 202 },
    );
  });
  const api = client();
  expect(
    await api.createResource(
      org,
      { form, space: org, name: "one", spec: { value: 1 } },
      "console-create-0001",
    ),
  ).toMatchObject({ status: "queued", effect: "none" });
  expect(await api.resource(org, resource.uid)).toEqual(resource);
  expect(
    await api.updateResource(org, resource.uid, 1, { value: 2 }, "console-update-0001"),
  ).toMatchObject({ action: "update" });
  expect(await api.deleteResource(org, resource.uid, 1, "console-delete-0001")).toMatchObject({
    action: "delete",
  });
  expect(await api.resourceOperation(org, operation.id)).toMatchObject({
    status: "succeeded",
    effect: "complete",
  });
  expect(seen.map((request) => request.method)).toEqual(["POST", "GET", "PUT", "DELETE", "GET"]);
  expect(seen.every((request) => request.headers.get("takoform-organization") === org)).toBe(true);
  expect(seen[0]?.headers.get("idempotency-key")).toBe("console-create-0001");
  expect(seen[2]?.headers.get("takoform-expected-generation")).toBe("1");
  expect(seen[2]?.headers.get("idempotency-key")).toBe("console-update-0001");
  expect(seen[3]?.headers.get("idempotency-key")).toBe("console-delete-0001");
  expect(new URL(seen[1]?.url ?? origin).pathname).toBe(
    `/apis/forms.takoform.com/v2/resources/${encodeURIComponent(resource.uid)}`,
  );
  expect(
    seen.filter((request) => new URL(request.url).pathname.includes("/v1/resources")),
  ).toHaveLength(0);
});

test("v2 list keeps signed cursor opaque and filters to organization space", async () => {
  const seen = transport(() => Response.json({ items: [resource], nextCursor: "opaque+/&?%" }));
  expect(await client().resources(org, { cursor: "prior+/&?%" })).toEqual({
    resources: [resource],
    cursor: "opaque+/&?%",
  });
  const url = new URL(seen[0]?.url ?? origin);
  expect(url.pathname).toBe("/apis/forms.takoform.com/v2/resources");
  expect(url.searchParams.get("space")).toBe(org);
  expect(url.searchParams.get("cursor")).toBe("prior+/&?%");
});

test("v2 support checks only the exact operator-supplied Form URL", async () => {
  const seen = transport(() =>
    Response.json({ form, supported: true, operations: ["create"], privateInputs: false }),
  );
  expect(await client().formSupport(org, form)).toBe(true);
  expect(new URL(seen[0]?.url ?? origin).searchParams.get("form")).toBe(form);
  transport(() =>
    Response.json({ form, supported: true, operations: ["read"], privateInputs: false }),
  );
  expect(await client().formSupport(org, form)).toBe(false);
});

test("ambiguous ACK stays unknown; client does not replay the mutation", async () => {
  const seen = transport(() => {
    throw new Error("connection reset after send");
  });
  await expect(
    client().createResource(
      org,
      { form, space: org, name: "one", spec: {} },
      "console-create-0001",
    ),
  ).rejects.toMatchObject({ code: "unreachable", status: 0 });
  expect(seen).toHaveLength(1);
});

test("v2 problem codes and session loss are distinct from malformed success", async () => {
  let lost = 0;
  transport(() =>
    Response.json({ code: "unauthenticated", message: "no session" }, { status: 401 }),
  );
  await expect(
    client(() => {
      lost += 1;
    }).resources(org),
  ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  expect(lost).toBe(1);
  transport(() => Response.json({ code: "generation_conflict" }, { status: 412 }));
  await expect(
    client().updateResource(org, resource.uid, 1, {}, "console-update-0001"),
  ).rejects.toMatchObject({ code: "generation_conflict", status: 412 });
  transport(() => Response.json({ id: operation.id }, { status: 202 }));
  await expect(
    client().createResource(
      org,
      { form, space: org, name: "one", spec: {} },
      "console-create-0001",
    ),
  ).rejects.toMatchObject({ code: "invalid_response", status: 202 });
  transport(() =>
    Response.json({ ...operation, status: "succeeded", effect: "unknown" }, { status: 200 }),
  );
  await expect(
    client().createResource(
      org,
      { form, space: org, name: "one", spec: {} },
      "console-create-0001",
    ),
  ).rejects.toMatchObject({ code: "invalid_response", status: 200 });
});
