import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "..");
const CLI = resolve(REPOSITORY, "scripts/takoform.ts");
const LANE = "/apis/forms.takoform.com/v1";
const currentForm = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "2.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};
const operationId = "op_cli-async-0001";
const operationVersion = "operations.takoform.com/v1alpha1";
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
  readonly deleteResponse?: Response;
  readonly operationResponse?: (request: Request, pathname: string) => Response | Promise<Response>;
};

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("waits for an accepted apply and verifies the resulting resource readback", async () => {
  const requests: RequestRecord[] = [];
  const resource = resourceBody();
  let operationPolls = 0;
  const server = startServer(
    {
      resourceResponses: () => (operationPolls >= 2 ? new Response(resource) : notFound()),
      applyResponse: acceptedOperation(),
      operationResponse: () => {
        operationPolls += 1;
        return operationPolls === 1
          ? pendingOperation()
          : terminalOperation({ result: { resource: JSON.parse(resource) } });
      },
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${resource}\n`);
  const polls = requests.filter(({ pathname }) => pathname === `${LANE}/operations/${operationId}`);
  expect(polls).toHaveLength(2);
  expect(polls.every(({ method }) => method === "GET")).toBe(true);
  expect(polls.every(({ headers }) => headers.get("authorization") === "Bearer test-api-key")).toBe(
    true,
  );
  expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
  expect(
    requests
      .filter(
        ({ method, pathname }) =>
          method === "POST" ||
          method === "PUT" ||
          pathname.includes("/operations/") ||
          (method === "GET" && pathname.includes("/resources/")),
      )
      .map(({ method }) => method),
  ).toEqual(["GET", "GET", "POST", "PUT", "GET", "GET", "GET"]);
  expect(requests.at(-1)?.method).toBe("GET");
});

test("preserves the existing generation fence for an accepted async update", async () => {
  const requests: RequestRecord[] = [];
  const existing = JSON.parse(resourceBody()) as Record<string, unknown>;
  const metadata = existing.metadata as Record<string, unknown>;
  const status = existing.status as Record<string, unknown>;
  const updated = {
    ...existing,
    metadata: { ...metadata, generation: "8", revision: "4" },
    spec: { version: 2 },
    status: { ...status, observedGeneration: "8" },
  };
  let operationCompleted = false;
  const server = startServer(
    {
      resourceResponses: () =>
        new Response(JSON.stringify(operationCompleted ? updated : existing)),
      prepareResponse: Response.json({ review: { prepareDigest: "review-digest" } }),
      applyResponse: acceptedOperation(),
      operationResponse: () => {
        operationCompleted = true;
        return terminalOperation({ result: { resource: updated } });
      },
    },
    requests,
  );

  const result = await runCli(server.url, "apply", '{"version":2}');

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${JSON.stringify(updated)}\n`);
  expect(
    requests
      .find(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare"))
      ?.headers.get("takoform-expected-generation"),
  ).toBe("7");
  expect(
    requests.find(({ method }) => method === "PUT")?.headers.get("takoform-expected-generation"),
  ).toBe("7");
});

test("waits for an accepted delete and verifies the resource is absent", async () => {
  const requests: RequestRecord[] = [];
  const resource = resourceBody();
  let operationPolls = 0;
  const server = startServer(
    {
      resourceResponses: () => (operationPolls >= 2 ? notFound() : new Response(resource)),
      deleteResponse: acceptedOperation(),
      operationResponse: () => {
        operationPolls += 1;
        return operationPolls === 1
          ? pendingOperation()
          : terminalOperation({ result: { deleted: true } });
      },
    },
    requests,
  );

  const result = await runCli(server.url, "delete");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("deleted");
  expect(
    requests.filter(({ pathname }) => pathname === `${LANE}/operations/${operationId}`),
  ).toHaveLength(2);
  expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  expect(requests.at(-1)?.method).toBe("GET");
});

test.each(["apply", "delete"] as const)(
  "returns failure when an accepted %s reaches a terminal Host error",
  async (command) => {
    const requests: RequestRecord[] = [];
    const resource = resourceBody();
    const server = startServer(
      {
        resourceResponses: () => new Response(resource),
        ...(command === "apply"
          ? { applyResponse: acceptedOperation() }
          : { deleteResponse: acceptedOperation() }),
        operationResponse: () =>
          terminalOperation({
            error: {
              code: "backend_unavailable",
              message: "private provider detail must not be printed",
              requestId: "req_cli-async-0001",
              retryable: false,
            },
          }),
      },
      requests,
    );

    const result = await runCli(server.url, command, command === "apply" ? "{}" : undefined);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("backend_unavailable");
    expect(result.stderr).not.toContain("private provider detail");
    expect(
      requests.filter(({ method }) => method === (command === "apply" ? "PUT" : "DELETE")),
    ).toHaveLength(1);
  },
);

test("fails safely after a bounded pending-operation poll budget without retrying the mutation", async () => {
  const requests: RequestRecord[] = [];
  const server = startServer(
    {
      resourceResponses: () => notFound(),
      applyResponse: acceptedOperation(),
      operationResponse: () => pendingOperation(),
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(operationId);
  expect(result.stderr).toContain("did not finish");
  expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
  expect(
    requests.filter(({ pathname }) => pathname === `${LANE}/operations/${operationId}`).length,
  ).toBeGreaterThan(0);
  expect(
    requests.filter(({ method, pathname }) => method === "POST" && pathname.endsWith("/prepare")),
  ).toHaveLength(1);
});

test("rejects an invalid accepted operation handle without polling another address", async () => {
  const requests: RequestRecord[] = [];
  const server = startServer(
    {
      resourceResponses: () => notFound(),
      applyResponse: Response.json(
        {
          operation: {
            apiVersion: operationVersion,
            kind: "Operation",
            id: "op/other-operation",
            done: false,
          },
        },
        { status: 202 },
      ),
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("invalid operation handle");
  expect(
    requests
      .filter(({ pathname }) => pathname.includes("/operations/"))
      .map(({ pathname }) => pathname),
  ).toEqual([]);
  expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
});

test("rejects a poll response for a different operation ID", async () => {
  const requests: RequestRecord[] = [];
  const server = startServer(
    {
      resourceResponses: () => notFound(),
      applyResponse: acceptedOperation(),
      operationResponse: () =>
        Response.json({
          apiVersion: operationVersion,
          kind: "Operation",
          id: "op_someone-elses-operation",
          done: false,
        }),
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("returned an invalid response");
  expect(
    requests.filter(({ pathname }) => pathname === `${LANE}/operations/${operationId}`),
  ).toHaveLength(1);
  expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
});

test("does not report async apply success when the post-operation resource UID changed", async () => {
  const requests: RequestRecord[] = [];
  const terminal = JSON.parse(resourceBody()) as Record<string, unknown>;
  const metadata = terminal.metadata as Record<string, unknown>;
  const changed = { ...terminal, metadata: { ...metadata, uid: "different-resource-uid" } };
  let operationPolls = 0;
  const server = startServer(
    {
      resourceResponses: () => (operationPolls >= 1 ? new Response(resourceBody()) : notFound()),
      applyResponse: acceptedOperation(),
      operationResponse: () => {
        operationPolls += 1;
        return terminalOperation({ result: { resource: changed } });
      },
    },
    requests,
  );

  const result = await runCli(server.url, "apply", "{}");

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("does not match the current resource readback");
  expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
});

test.each(["headers", "body"] as const)(
  "bounds async polling when the operation response %s stall",
  async (stage) => {
    const requests: RequestRecord[] = [];
    const server = startServer(
      {
        resourceResponses: () => notFound(),
        applyResponse: acceptedOperation(),
        operationResponse: () =>
          stage === "headers"
            ? new Promise<Response>(() => {})
            : new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("{"));
                  },
                  pull() {
                    return new Promise<void>(() => {});
                  },
                }),
              ),
      },
      requests,
    );

    const result = await runCli(server.url, "apply", "{}", {
      preload: acceleratedTimerPreload().preload,
      watchdogMs: 1_000,
    });

    expect(result.watchdogExpired).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(operationId);
    expect(result.stderr).toContain("did not finish");
    expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(
      requests.filter(({ pathname }) => pathname === `${LANE}/operations/${operationId}`),
    ).toHaveLength(1);
  },
);

test.each(["headers", "body"] as const)(
  "recomputes the polling budget after Retry-After before bounding stalled %s",
  async (stage) => {
    const requests: RequestRecord[] = [];
    const timing = acceleratedTimerPreload();
    const server = startServer(
      {
        resourceResponses: () => notFound(),
        applyResponse: acceptedOperation("59"),
        operationResponse: () =>
          stage === "headers"
            ? new Promise<Response>(() => {})
            : new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("{"));
                  },
                  pull() {
                    return new Promise<void>(() => {});
                  },
                }),
              ),
      },
      requests,
    );

    const result = await runCli(server.url, "apply", "{}", {
      preload: timing.preload,
      watchdogMs: 1_000,
    });

    expect(result.watchdogExpired).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(operationId);
    expect(result.stderr).toContain("did not finish");
    expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(
      requests.filter(({ pathname }) => pathname === `${LANE}/operations/${operationId}`),
    ).toHaveLength(1);
    expect(readFileSync(timing.timeoutLog, "utf8").trim().split("\n")).toEqual(["59000", "1000"]);
  },
);

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
        return scenario.deleteResponse ?? new Response(null, { status: 204 });
      }
      if (pathname.startsWith(`${LANE}/operations/`) && request.method === "GET") {
        return (
          scenario.operationResponse?.(request, pathname) ??
          new Response("unexpected operation poll", { status: 500 })
        );
      }
      return new Response("unexpected request", { status: 500 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}` };
}

function acceptedOperation(retryAfter = "0"): Response {
  return Response.json(
    {
      operation: {
        apiVersion: operationVersion,
        kind: "Operation",
        id: operationId,
        done: false,
      },
    },
    { status: 202, headers: { "retry-after": retryAfter } },
  );
}

function pendingOperation(): Response {
  return Response.json(
    { apiVersion: operationVersion, kind: "Operation", id: operationId, done: false },
    { headers: { "retry-after": "0" } },
  );
}

function terminalOperation(fields: Record<string, unknown>): Response {
  return Response.json({
    apiVersion: operationVersion,
    kind: "Operation",
    id: operationId,
    done: true,
    ...fields,
  });
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
  options: { readonly preload?: string; readonly watchdogMs?: number } = {},
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly watchdogExpired: boolean;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      ...(options.preload === undefined ? [] : ["--preload", options.preload]),
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
  let watchdogExpired = false;
  const watchdog =
    options.watchdogMs === undefined
      ? undefined
      : setTimeout(() => {
          watchdogExpired = true;
          child.kill("SIGKILL");
        }, options.watchdogMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (watchdog !== undefined) clearTimeout(watchdog);
  return { exitCode, stdout, stderr, watchdogExpired };
}

function acceleratedTimerPreload(): { readonly preload: string; readonly timeoutLog: string } {
  const directory = mkdtempSync(join(tmpdir(), "takoserver-takoform-cli-timeout-"));
  temporaryDirectories.push(directory);
  const preload = join(directory, "accelerate-timers.mjs");
  const timeoutLog = join(directory, "timeouts.log");
  writeFileSync(timeoutLog, "");
  writeFileSync(
    preload,
    [
      'import { appendFileSync } from "node:fs";',
      "const originalSetTimeout = globalThis.setTimeout.bind(globalThis);",
      "let virtualNow = 0;",
      "Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: () => virtualNow });",
      "globalThis.setTimeout = (callback, delay = 0, ...args) => {",
      "  const requested = Number(delay) || 0;",
      `  if (requested >= 1000) appendFileSync(${JSON.stringify(timeoutLog)}, String(requested) + '\\n');`,
      "  return originalSetTimeout((...callbackArgs) => {",
      "    virtualNow += requested;",
      "    callback(...callbackArgs);",
      "  }, requested >= 1000 ? 10 : requested, ...args);",
      "};",
    ].join("\n"),
  );
  return { preload, timeoutLog };
}
