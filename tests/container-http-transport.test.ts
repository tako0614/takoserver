import { expect, test } from "bun:test";
import {
  containerHttpTransport,
  createContainerHttpInvocation,
} from "../src/providers/container-http-transport.ts";
import {
  observeRawPromise as observed,
  ownedRawHttp as raw,
  rawTick as tick,
} from "./helpers/container-http-transport-fixture.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("owned HTTP head does not join the original unread body or unclosed request", async () => {
  const io = raw(),
    owner = createContainerHttpInvocation();
  try {
    const response = owner.send(new Request("http://owned.invalid/"));
    const joined = observed(owner.settlement);
    io.head();
    const head = await response;
    expect(head.status).toBe(200);
    expect(io.counts().ends).toBe(1);
    expect(joined.state()).toBe("pending");
    io.incoming.end("NONSECRET body");
    expect(await head.text()).toBe("NONSECRET body");
    await tick();
    expect(joined.state()).toBe("pending");
    io.closeResponse();
    await tick();
    expect(joined.state()).toBe("pending");
    io.closeRequest();
    await owner.settlement;
    owner.assertJoined();
    expect(io.counts()).toEqual({ calls: 1, ends: 1, requestDestroy: 0, responseDestroy: 0 });
    const repeated = observed(owner.send(new Request("http://owned.invalid/again")));
    expect(await repeated.value).toHaveProperty("error");
    expect(io.counts().calls).toBe(1);
  } finally {
    io.restore();
  }
});

test("owned HTTP close waits actual two closes and pending upload cancellation", async () => {
  const io = raw(),
    cancellation = gate();
  let canceled = 0;
  const upload = new ReadableStream<Uint8Array>(
    {
      pull() {
        /* pending original upload */
      },
      cancel() {
        canceled++;
        return cancellation.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const owner = createContainerHttpInvocation();
  try {
    const response = owner.send(
      new Request("http://owned.invalid/", {
        method: "POST",
        body: upload,
        ...({ duplex: "half" } as { duplex: "half" }),
      }),
    );
    io.head();
    const head = await response;
    const reader = head.body!.getReader();
    const body = observed(reader.read());
    const closed = observed(owner.close());
    await tick();
    expect(canceled).toBe(1);
    expect(body.state()).toBe("rejected");
    expect(closed.state()).toBe("pending");
    io.closeRequest();
    io.closeResponse();
    await tick();
    expect(closed.state()).toBe("pending");
    cancellation.release();
    expect(await closed.value).toHaveProperty("result");
    owner.assertJoined();
    await owner.close();
    expect(io.counts().requestDestroy).toBe(1);
    expect(io.counts().responseDestroy).toBe(1);
    expect(io.counts().calls).toBe(1);
    expect(canceled).toBe(1);
  } finally {
    cancellation.release();
    io.restore();
  }
});

test("owned HTTP abort during backpressure consumes no second write or request", async () => {
  const io = raw(),
    cancel = new AbortController(),
    owner = createContainerHttpInvocation();
  io.writable(false);
  const upload = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
    },
    { highWaterMark: 0 },
  );
  try {
    const response = observed(
      owner.send(
        new Request("http://owned.invalid/", {
          method: "POST",
          body: upload,
          ...({ duplex: "half" } as { duplex: "half" }),
          signal: cancel.signal,
        }),
      ),
    );
    await tick();
    expect(io.writes.length).toBe(1);
    cancel.abort();
    const closed = observed(owner.close());
    await tick();
    expect(closed.state()).toBe("pending");
    io.closeRequest();
    expect(await response.value).toHaveProperty("error");
    expect(await closed.value).toHaveProperty("result");
    io.request.emit("drain");
    await tick();
    expect(io.writes.length).toBe(1);
    expect(io.counts()).toEqual({ calls: 1, ends: 0, requestDestroy: 1, responseDestroy: 0 });
  } finally {
    io.restore();
  }
});

test("owned HTTP failed upload cancellation stays unknown after late actual close", async () => {
  const io = raw(),
    owner = createContainerHttpInvocation();
  const upload = new ReadableStream<Uint8Array>(
    {
      cancel() {
        return Promise.reject(Error("NONSECRET cancellation unknown"));
      },
    },
    { highWaterMark: 0 },
  );
  try {
    const response = observed(
      owner.send(
        new Request("http://owned.invalid/", {
          method: "POST",
          body: upload,
          ...({ duplex: "half" } as { duplex: "half" }),
        }),
      ),
    );
    const closed = observed(owner.close());
    await tick();
    expect(await closed.value).toHaveProperty("error");
    io.closeRequest();
    expect(await response.value).toHaveProperty("error");
    expect(() => owner.assertJoined()).toThrow("cancellation unknown");
    expect(await observed(owner.close()).value).toHaveProperty("error");
    expect(io.counts().requestDestroy).toBe(1);
    expect(io.counts().calls).toBe(1);
  } finally {
    io.restore();
  }
});

test("default HTTP transport still returns head before terminal closure", async () => {
  const io = raw();
  try {
    const response = containerHttpTransport(new Request("http://owned.invalid/"));
    io.head();
    const head = await response;
    expect(head.status).toBe(200);
    const body = observed(head.body!.cancel());
    io.closeRequest();
    io.closeResponse();
    expect(await body.value).toHaveProperty("result");
    expect(io.counts().calls).toBe(1);
  } finally {
    io.restore();
  }
});
