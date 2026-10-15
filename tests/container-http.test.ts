import { expect, test } from "bun:test";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { forwardContainerHttp } from "../src/container-http.ts";

test("Container HTTP ignores authority, strips transport headers, keeps authorization and returns application errors", async () => {
  let calls = 0;
  let outgoingLength: string | null | undefined;
  const result = await forwardContainerHttp(
    new Request("https://arbitrary.example/a?b=1", {
      method: "POST",
      headers: {
        authorization: "application",
        host: "untrusted",
        connection: "x-hop",
        "x-hop": "no",
        "content-length": "5",
      },
      body: "hello",
    }),
    "http://127.0.0.1:8080",
    async (request) => {
      calls++;
      outgoingLength = request.headers.get("content-length");
      expect(request.url).toBe("http://127.0.0.1:8080/a?b=1");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe("application");
      expect(request.headers.has("host")).toBe(false);
      expect(request.headers.has("x-hop")).toBe(false);
      expect(await request.text()).toBe("hello");
      return new Response("application error", {
        status: 503,
        headers: { connection: "x-hop", "x-hop": "no", "content-length": "17" },
      });
    },
  );
  expect(result.status).toBe(503);
  expect(outgoingLength).toBeNull();
  expect(result.headers.has("content-length")).toBe(false);
  expect(result.headers.has("x-hop")).toBe(false);
  expect(await result.text()).toBe("application error");
  expect(calls).toBe(1);
});

test("known request oversize and invalid methods fail before dispatch", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return new Response();
  };
  await expect(
    forwardContainerHttp(
      new Request("http://a/", {
        method: "POST",
        headers: { "content-length": String(C.limits.bodyBytes + 1) },
      }),
      "http://127.0.0.1:1",
      transport,
    ),
  ).rejects.toMatchObject({ name: C.errorName, code: C.errors.requestTooLarge });
  await expect(
    forwardContainerHttp(
      new Request("http://a/", { method: "TRACE" }),
      "http://127.0.0.1:1",
      transport,
    ),
  ).rejects.toMatchObject({ code: C.errors.invalidRequest });
  expect(calls).toBe(0);
});

for (const connection of ["Content-Length", "keep-alive, CoNtEnT-LeNgTh, x-hop"]) {
  test(`request Connection nomination of ${connection} refuses before dispatch`, async () => {
    let dispatches = 0;
    await expect(
      forwardContainerHttp(
        new Request("http://a/", {
          method: "POST",
          headers: { connection, "content-length": "5", "x-hop": "private" },
          body: "hello",
        }),
        "http://127.0.0.1:1",
        async (request) => {
          dispatches++;
          expect(await request.text()).toBe("hello");
          return new Response();
        },
      ),
    ).rejects.toMatchObject({ name: C.errorName, code: C.errors.invalidRequest });
    expect(dispatches).toBe(0);
  });
}

for (const scenario of [
  { name: "comma Content-Length", headers: { "content-length": "1, 1" } },
  { name: "fractional Content-Length", headers: { "content-length": "1.0" } },
  { name: "leading-zero Content-Length", headers: { "content-length": "01" } },
  { name: "negative Content-Length", headers: { "content-length": "-1" } },
  { name: "unsafe Content-Length", headers: { "content-length": "9007199254740992" } },
  { name: "invalid Connection nomination", headers: { connection: "not a field name" } },
] as const) {
  test(`malformed native ${scenario.name} fails before publishing a head`, async () => {
    let dispatches = 0;
    let sourceCancels = 0;
    await expect(
      forwardContainerHttp(new Request("http://a/"), "http://127.0.0.1:1", async () => {
        dispatches++;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              cancel() {
                sourceCancels++;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: scenario.headers },
        );
      }),
    ).rejects.toMatchObject({ name: C.errorName, code: C.errors.backendUnavailable });
    expect(dispatches).toBe(1);
    expect(sourceCancels).toBe(1);
  });
}

for (const [method, status] of [
  ["HEAD", 200],
  ["GET", 204],
  ["GET", 205],
  ["GET", 304],
] as const) {
  for (const value of ["1, 1", "1.0", "9007199254740992"]) {
    test(`bodyless ${method}/${status} rejects noncanonical Content-Length ${value}`, async () => {
      let dispatches = 0;
      await expect(
        forwardContainerHttp(
          new Request("http://a/", { method }),
          "http://127.0.0.1:1",
          async () => {
            dispatches++;
            return new Response(null, { status, headers: { "content-length": value } });
          },
        ),
      ).rejects.toMatchObject({ name: C.errorName, code: C.errors.backendUnavailable });
      expect(dispatches).toBe(1);
    });
  }
}

test("resolve at response head and propagate cancellation without reading ahead", async () => {
  let reads = 0;
  let cancelled = false;
  const result = await forwardContainerHttp(
    new Request("http://a/"),
    "http://127.0.0.1:1",
    async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  expect(reads).toBe(0);
  await result.body!.cancel();
  expect(cancelled).toBe(true);
});

for (const scenario of [
  { cause: "caller", code: C.errors.requestAborted, sourceCancels: 1 },
  { cause: "backend", code: C.errors.responseAborted, sourceCancels: 0 },
  { cause: "external drain", code: C.errors.responseAborted, sourceCancels: 1 },
] as const) {
  test(`post-head ${scenario.cause} preserves its Container error cause`, async () => {
    const caller = new AbortController();
    const drain = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let dispatches = 0;
    let reads = 0;
    let sourceCancels = 0;
    let transportAborts = 0;
    const response = await forwardContainerHttp(
      new Request("http://a/", { signal: caller.signal }),
      "http://127.0.0.1:1",
      async (request) => {
        dispatches++;
        request.signal.addEventListener("abort", () => transportAborts++);
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                source = controller;
              },
              pull() {
                reads++;
              },
              cancel() {
                sourceCancels++;
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 202 },
        );
      },
      drain.signal,
    );
    expect(response.status).toBe(202);
    expect(reads).toBe(0);
    const pending = response.text();
    if (scenario.cause === "caller") caller.abort();
    else if (scenario.cause === "backend") source.error(new Error("private native reset"));
    else drain.abort(C.errors.requestAborted);
    await expect(pending).rejects.toMatchObject({ name: C.errorName, code: scenario.code });
    expect(response.status).toBe(202);
    expect(dispatches).toBe(1);
    expect(sourceCancels).toBe(scenario.sourceCancels);
    expect(transportAborts).toBe(1);
  });
}

test("redirects stay responses and transport failure never retries", async () => {
  const redirect = await forwardContainerHttp(
    new Request("http://a/"),
    "http://127.0.0.1:1",
    async () =>
      new Response(null, { status: 302, headers: { location: "https://external.example/" } }),
  );
  expect(redirect.status).toBe(302);
  let calls = 0;
  await expect(
    forwardContainerHttp(new Request("http://a/"), "http://127.0.0.1:1", async () => {
      calls++;
      throw new Error("private diagnostic");
    }),
  ).rejects.toMatchObject({
    code: C.errors.backendUnavailable,
    message: C.errors.backendUnavailable,
  });
  expect(calls).toBe(1);
});

test("stream length mismatch fails in the stream after the response head", async () => {
  const result = await forwardContainerHttp(
    new Request("http://a/"),
    "http://127.0.0.1:1",
    async () =>
      new Response("short", {
        headers: { connection: "CoNtEnT-LeNgTh", "content-length": "10" },
      }),
  );
  expect(result.status).toBe(200);
  expect(result.headers.has("content-length")).toBe(false);
  await expect(result.text()).rejects.toMatchObject({ code: C.errors.responseAborted });
});

test("original request length still aborts and cancels an oversized stream after projection", async () => {
  let pulls = 0;
  let cancelled = false;
  let outgoingLength: string | null | undefined;
  let signal: AbortSignal | undefined;
  await expect(
    forwardContainerHttp(
      new Request("http://a/", {
        method: "POST",
        headers: { "content-length": "3" },
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("hello"));
              else controller.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        ...({ duplex: "half" } as { duplex: "half" }),
      }),
      "http://127.0.0.1:1",
      async (request) => {
        outgoingLength = request.headers.get("content-length");
        signal = request.signal;
        await request.text();
        return new Response();
      },
    ),
  ).rejects.toMatchObject({ code: C.errors.requestAborted });
  expect(outgoingLength).toBeNull();
  expect(pulls).toBe(1);
  expect(cancelled).toBe(true);
  expect(signal?.aborted).toBe(true);
});

test("unknown body overflow reports the directional code without buffering the body", async () => {
  const chunk = new Uint8Array(16 * 1024 * 1024);
  const stream = () =>
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
  const response = await forwardContainerHttp(
    new Request("http://a/"),
    "http://127.0.0.1:1",
    async () => new Response(stream()),
  );
  const reader = response.body!.getReader();
  for (let count = 0; count < 6; count++)
    expect((await reader.read()).value?.length).toBe(chunk.length);
  await expect(reader.read()).rejects.toMatchObject({ code: C.errors.responseTooLarge });
  await expect(
    forwardContainerHttp(
      new Request("http://a/", {
        method: "POST",
        body: stream(),
        ...({ duplex: "half" } as { duplex: "half" }),
      }),
      "http://127.0.0.1:1",
      async (request) => {
        const input = request.body!.getReader();
        while (!(await input.read()).done) {
          /* discard each bounded chunk */
        }
        return new Response();
      },
    ),
  ).rejects.toMatchObject({ code: C.errors.requestTooLarge });
});

test("header/path limits and upgrade refusal happen before delivery", async () => {
  let calls = 0;
  const send = async () => {
    calls++;
    return new Response();
  };
  const headers = new Headers();
  for (let count = 0; count < 65; count++) headers.set(`x-${count}`, "a");
  for (const request of [
    new Request("http://a/", { headers }),
    new Request("http://a/" + "a".repeat(C.limits.pathQuery)),
    new Request("http://a/", { headers: { upgrade: "websocket" } }),
  ])
    await expect(forwardContainerHttp(request, "http://127.0.0.1:1", send)).rejects.toBeDefined();
  expect(calls).toBe(0);
});

test("known response overflow fails at the head and bodyless responses omit representation length", async () => {
  await expect(
    forwardContainerHttp(
      new Request("http://a/"),
      "http://127.0.0.1:1",
      async () =>
        new Response(null, { headers: { "content-length": String(C.limits.bodyBytes + 1) } }),
    ),
  ).rejects.toMatchObject({ code: C.errors.responseTooLarge });
  for (const [method, status] of [
    ["HEAD", 200],
    ["GET", 204],
    ["GET", 205],
    ["GET", 304],
  ] as const) {
    let reads = 0;
    let sourceCancels = 0;
    const response = await forwardContainerHttp(
      new Request("http://a/", { method }),
      "http://127.0.0.1:1",
      async () =>
        new Response(
          method === "HEAD"
            ? new ReadableStream<Uint8Array>(
                {
                  pull() {
                    reads++;
                  },
                  cancel() {
                    sourceCancels++;
                  },
                },
                { highWaterMark: 0 },
              )
            : null,
          { status, headers: { "content-length": String(Number.MAX_SAFE_INTEGER) } },
        ),
    );
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(response.headers.has("content-length")).toBe(false);
    expect(reads).toBe(0);
    expect(sourceCancels).toBe(method === "HEAD" ? 1 : 0);
  }
});
