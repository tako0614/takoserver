import { expect, test } from "bun:test";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { forwardContainerHttp } from "../src/container-http.ts";

test("Container HTTP ignores authority, strips transport headers, keeps authorization and returns application errors", async () => {
  let calls = 0;
  const result = await forwardContainerHttp(
    new Request("https://arbitrary.example/a?b=1", {
      method: "POST",
      headers: {
        authorization: "application",
        host: "untrusted",
        connection: "x-hop",
        "x-hop": "no",
      },
      body: "hello",
    }),
    "http://127.0.0.1:8080",
    async (request) => {
      calls++;
      expect(request.url).toBe("http://127.0.0.1:8080/a?b=1");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe("application");
      expect(request.headers.has("host")).toBe(false);
      expect(request.headers.has("x-hop")).toBe(false);
      expect(await request.text()).toBe("hello");
      return new Response("application error", {
        status: 503,
        headers: { connection: "x-hop", "x-hop": "no" },
      });
    },
  );
  expect(result.status).toBe(503);
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
    async () => new Response("short", { headers: { "content-length": "10" } }),
  );
  expect(result.status).toBe(200);
  await expect(result.text()).rejects.toMatchObject({ code: C.errors.responseAborted });
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

test("known response overflow fails at the head and HEAD retains representation length", async () => {
  await expect(
    forwardContainerHttp(
      new Request("http://a/"),
      "http://127.0.0.1:1",
      async () =>
        new Response(null, { headers: { "content-length": String(C.limits.bodyBytes + 1) } }),
    ),
  ).rejects.toMatchObject({ code: C.errors.responseTooLarge });
  const response = await forwardContainerHttp(
    new Request("http://a/", { method: "HEAD" }),
    "http://127.0.0.1:1",
    async () => new Response(null, { headers: { "content-length": "1024" } }),
  );
  expect(response.body).toBeNull();
  expect(response.headers.get("content-length")).toBe("1024");
});
