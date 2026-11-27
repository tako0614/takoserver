import { expect, test } from "bun:test";
import { createSelfhostContainerBindingBroker } from "../src/providers/selfhost-container-binding-broker.ts";
import { CONTAINER_BINDING_WIRE as W } from "../src/providers/selfhost-container-binding-client.ts";

function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function observed(promise: Promise<void>) {
  let state: "pending" | "fulfilled" | "rejected" = "pending";
  const result = promise.then(
    () => {
      state = "fulfilled";
      return { status: "fulfilled" as const };
    },
    (reason: unknown) => {
      state = "rejected";
      return { status: "rejected" as const, reason };
    },
  );
  return { result, state: () => state };
}

async function microtasks() {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

// Pure original factory/wire/Web Streams, without an HTTP or provider boundary.
async function original() {
  const inner = gate();
  let cancels = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancels++;
        return inner.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const broker = createSelfhostContainerBindingBroker({
    async dispatch(request) {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://logical.invalid/original?q=yes");
      expect(request.headers.get("x-original")).toBe("kept");
      expect(request.headers.has(W.request)).toBe(false);
      expect(await request.text()).toBe("original upload");
      return new Response(source, {
        status: 201,
        statusText: "Created",
        headers: { "x-origin": "kept" },
      });
    },
  });
  const response = await broker(
    new Request("http://wire.invalid/", {
      method: "POST",
      headers: {
        [W.request]: JSON.stringify({
          method: "POST",
          path: "/original?q=yes",
          headers: [["x-original", "kept"]],
        }),
      },
      body: "original upload",
    }),
  );
  expect(JSON.parse(response.headers.get(W.result) ?? "")).toEqual({
    status: 201,
    statusText: "Created",
    headers: [["x-origin", "kept"]],
  });
  const reader = response.body?.getReader();
  if (!reader) throw Error("original wire body absent");
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(first.value).toEqual(new Uint8Array([0, 0, 0, 3, 1, 2, 3]));
  return { reader, inner, cancels: () => cancels };
}

test("broker cancellation propagates its actual inner reader rejection with framing intact", async () => {
  const io = await original();
  const cancellation = observed(io.reader.cancel());
  try {
    await microtasks();
    expect(cancellation.state()).toBe("pending");
    expect(io.cancels()).toBe(1);
    const error = Error("NONSECRET actual source cancellation failure");
    io.inner.reject(error);
    const result = await cancellation.result;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(error);
    expect(await io.reader.read()).toEqual({ done: true, value: undefined });
    expect(io.cancels()).toBe(1);
  } finally {
    io.inner.resolve();
    await cancellation.result;
  }
});

test("broker normal inner cancellation waits its source and preserves Request headers and frames", async () => {
  const io = await original();
  const cancellation = observed(io.reader.cancel());
  try {
    await microtasks();
    expect(cancellation.state()).toBe("pending");
    expect(io.cancels()).toBe(1);
    io.inner.resolve();
    expect(await cancellation.result).toEqual({ status: "fulfilled" });
    expect(await io.reader.read()).toEqual({ done: true, value: undefined });
    expect(io.cancels()).toBe(1);
  } finally {
    io.inner.resolve();
    await cancellation.result;
  }
});
