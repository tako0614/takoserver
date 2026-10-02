import { afterEach, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "..");
const CLI = resolve(REPOSITORY, "scripts/takoform.ts");
const LANE = "/apis/forms.takoform.com/v1";
const currentForm = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "2.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};
const supersededForm = {
  ...currentForm,
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
};

type RequestRecord = {
  readonly method: string;
  readonly pathname: string;
  readonly headers: Headers;
};

type Scenario = {
  readonly forms?: readonly (typeof currentForm)[];
  readonly resourceResponses?: (request: Request, pathname: string) => Response;
  readonly prepareResponse?: Response;
  readonly applyResponse?: Response;
};

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test.each([
  ["current resource GET 503", 503, { error: { code: "unavailable" } }],
  ["current resource GET 401", 401, { error: { code: "unauthorized" } }],
])("does not prepare or apply after %s", async (_label, status, body) => {
  const requests: RequestRecord[] = [];
  const server = startServer(
    {
      resourceResponses: () => Response.json(body, { status }),
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(`resource read failed: ${status}`);
  expect(
    requests.some(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare")),
  ).toBe(false);
  expect(requests.some(({ method }) => method === "PUT")).toBe(false);
});

test("does not prepare or apply when a superseded definition read fails", async () => {
  const requests: RequestRecord[] = [];
  const server = startServer(
    {
      forms: [currentForm, supersededForm],
      resourceResponses: (request) =>
        new URL(request.url).searchParams.get("definitionVersion") === "1.0.0"
          ? Response.json({ error: { code: "unavailable" } }, { status: 502 })
          : notFound(),
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("resource read failed: 502");
  expect(
    requests.some(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare")),
  ).toBe(false);
  expect(requests.some(({ method }) => method === "PUT")).toBe(false);
});

test("creates after authoritative resource_not_found 404 readbacks", async () => {
  const requests: RequestRecord[] = [];
  const server = startServer(
    {
      resourceResponses: () => notFound(),
      prepareResponse: Response.json({ review: { prepareDigest: "review-digest" } }),
      applyResponse: new Response('{"accepted":true}', { status: 201 }),
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('201 {"accepted":true}\n');
  expect(
    requests.filter(({ method, pathname }) => method === "GET" && pathname.includes("/resources/"))
      .length,
  ).toBe(2);
  expect(
    requests.some(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare")),
  ).toBe(true);
  expect(requests.find(({ method }) => method === "PUT")?.headers.get("if-none-match")).toBe("*");
});

test("does not treat a different 404 envelope as resource absence", async () => {
  const requests: RequestRecord[] = [];
  const server = startServer(
    {
      resourceResponses: () =>
        Response.json({ error: { code: "route_not_found" } }, { status: 404 }),
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("resource read failed: 404");
  expect(
    requests.some(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare")),
  ).toBe(false);
  expect(requests.some(({ method }) => method === "PUT")).toBe(false);
});

test.each([
  ["HTML", "<html>gateway error</html>"],
  ["empty", ""],
  ["malformed resource metadata", JSON.stringify({ ...JSON.parse(resourceBody()), metadata: {} })],
])(
  "rejects a successful %s readback instead of printing it as a resource",
  async (_label, body) => {
    const requests: RequestRecord[] = [];
    const server = startServer({ resourceResponses: () => new Response(body) }, requests);

    const result = await runCli(server.url, "get");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("resource read returned an invalid Takoform resource: 200");
  },
);

test("does not prepare or apply after a malformed successful current-resource readback", async () => {
  const requests: RequestRecord[] = [];
  const malformed = JSON.stringify({
    ...JSON.parse(resourceBody()),
    metadata: { generation: "0" },
  });
  const server = startServer({ resourceResponses: () => new Response(malformed) }, requests);

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("resource read returned an invalid Takoform resource: 200");
  expect(
    requests.some(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare")),
  ).toBe(false);
  expect(requests.some(({ method }) => method === "PUT")).toBe(false);
});

test.each([
  ["object", {}],
  ["null", null],
])(
  "rejects a malformed condition %s before get, apply, or delete succeeds",
  async (_label, condition) => {
    const requests: RequestRecord[] = [];
    const invalidResource = {
      ...JSON.parse(resourceBody()),
      status: { observedGeneration: "7", conditions: [condition] },
    };
    const server = startServer(
      { resourceResponses: () => new Response(JSON.stringify(invalidResource)) },
      requests,
    );

    const get = await runCli(server.url, "get");
    const apply = await runCli(server.url, "apply", "{}");
    const remove = await runCli(server.url, "delete");

    expect(get.exitCode).not.toBe(0);
    expect(get.stdout).toBe("");
    expect(apply.exitCode).not.toBe(0);
    expect(remove.exitCode).not.toBe(0);
    expect(
      requests.some(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare")),
    ).toBe(false);
    expect(requests.some(({ method }) => method === "PUT" || method === "DELETE")).toBe(false);
  },
);

test("preserves successful get, update, and delete behavior", async () => {
  const resource = resourceBody();
  const requests: RequestRecord[] = [];
  const server = startServer(
    {
      resourceResponses: () => new Response(resource),
      prepareResponse: Response.json({ review: { prepareDigest: "review-digest" } }),
      applyResponse: new Response('{"updated":true}', { status: 200 }),
    },
    requests,
  );

  const get = await runCli(server.url, "get");
  const update = await runCli(server.url, "apply", "{}");
  const remove = await runCli(server.url, "delete");

  expect(get.exitCode).toBe(0);
  expect(get.stdout).toBe(`${resource}\n`);
  expect(update.exitCode).toBe(0);
  expect(update.stdout).toBe('200 {"updated":true}\n');
  expect(
    requests
      .find(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare"))
      ?.headers.get("takoform-expected-generation"),
  ).toBe("7");
  expect(
    requests.find(({ method }) => method === "PUT")?.headers.get("takoform-expected-generation"),
  ).toBe("7");
  expect(remove.exitCode).toBe(0);
  expect(requests.some(({ method }) => method === "DELETE")).toBe(true);
  expect(
    requests.find(({ method }) => method === "DELETE")?.headers.get("takoform-expected-generation"),
  ).toBe("7");
});

function startServer(scenario: Scenario, requests: RequestRecord[]): { readonly url: string } {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push({ method: request.method, pathname, headers: request.headers });
      if (pathname === `${LANE}/support/forms`) {
        return Response.json({
          profiles: (scenario.forms ?? [currentForm]).map((formRef) => ({ formRef })),
        });
      }
      if (pathname === `${LANE}/resources/prepare`) {
        return (
          scenario.prepareResponse ?? Response.json({ review: { prepareDigest: "review-digest" } })
        );
      }
      if (pathname.startsWith(`${LANE}/resources/`) && request.method === "GET") {
        return scenario.resourceResponses?.(request, pathname) ?? notFound();
      }
      if (pathname.startsWith(`${LANE}/resources/`) && request.method === "PUT") {
        return scenario.applyResponse ?? new Response("ok", { status: 200 });
      }
      if (pathname.startsWith(`${LANE}/resources/`) && request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected request", { status: 500 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}` };
}

function notFound(): Response {
  return Response.json({ error: { code: "resource_not_found" } }, { status: 404 });
}

function resourceBody(): string {
  return JSON.stringify({
    apiVersion: currentForm.apiVersion,
    kind: currentForm.kind,
    form: { formRef: currentForm },
    metadata: {
      name: "bucket",
      space: "space",
      uid: "resource-uid",
      generation: "7",
      revision: "3",
    },
    spec: {},
    status: { observedGeneration: "7", conditions: [] },
  });
}

async function runCli(
  origin: string,
  command: "apply" | "get" | "delete",
  spec?: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      CLI,
      command,
      origin,
      "test-api-key",
      "ObjectBucket",
      "space",
      "bucket",
      ...(spec === undefined ? [] : [spec]),
    ],
    {
      cwd: REPOSITORY,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { HOME: process.env.HOME ?? "/tmp", PATH: dirname(process.execPath) },
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
