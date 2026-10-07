import { expect, test } from "bun:test";
import { once } from "node:events";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import {
  closeSelfhostEntryOwnedResources,
  createSelfhostEntryShutdown,
} from "../src/selfhost-entry-shutdown.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function requestOnAgent(agent: Agent, port: number, path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, agent }, resolve);
    request.once("error", reject);
    request.end();
  });
}

test("shutdown fences new work and drains an accepted response body and pass", async () => {
  const pass = deferred();
  const passStarted = deferred();
  const body = deferred();
  const finalized: string[] = [];
  let acceptedHandlers = 0;
  let passStarts = 0;
  let succeeded = false;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  const lifecycle = createSelfhostEntryShutdown({
    stopIngress: async () => {
      finalized.push("ingress");
      server.stop(false);
    },
    finishShutdown: async () => {
      finalized.push("finish");
    },
    onFailure: (stage) => finalized.push(`failed:${stage}`),
    onSuccess: () => {
      succeeded = true;
      finalized.push("success");
    },
  });

  lifecycle.startInterval(
    "maintenance",
    10,
    async () => {
      passStarts += 1;
      passStarted.resolve();
      await pass.promise;
    },
    () => undefined,
  );

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      lifecycle.fetch(request, async () => {
        acceptedHandlers += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              void body.promise.then(() => {
                controller.enqueue(new TextEncoder().encode("last"));
                controller.close();
              });
            },
          }),
        );
      }),
  });
  const port = server.port;
  if (port === undefined) throw new Error("the test listener has no port");

  try {
    const response = await requestOnAgent(agent, port, "/held");
    expect(response.statusCode).toBe(200);
    await once(response, "readable");
    await passStarted.promise;

    const shutdown = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(shutdown);
    expect(lifecycle.isStopping()).toBe(true);

    // Queue a second request on the same keep-alive connection while the first
    // response body is still open. It must be rejected or the draining socket
    // must be closed; it may not reach the application handler.
    const secondResponse = requestOnAgent(agent, port, "/keep-alive").then(
      async (next) => {
        const status = next.statusCode;
        next.resume();
        await once(next, "end");
        return status;
      },
      () => null,
    );

    const fenced = await lifecycle.fetch(
      new Request(`http://127.0.0.1:${port}/keep-alive`),
      async () => {
        acceptedHandlers += 1;
        return new Response("must not run");
      },
    );
    expect(fenced.status).toBe(503);
    expect(fenced.headers.get("connection")).toBe("close");
    expect(acceptedHandlers).toBe(1);
    expect(succeeded).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(succeeded).toBe(false);

    body.resolve();
    pass.resolve();
    let responseText = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      responseText += chunk;
    });
    await once(response, "end");
    expect(responseText).toBe("firstlast");
    const secondStatus = await secondResponse;
    expect(secondStatus === null || secondStatus === 503).toBe(true);
    expect(acceptedHandlers).toBe(1);
    expect(passStarts).toBe(1);
    expect(await shutdown).toBe(true);
    expect(succeeded).toBe(true);
    expect(finalized).toEqual(["ingress", "finish", "success"]);
  } finally {
    agent.destroy();
    server.stop(true);
    body.resolve();
    pass.resolve();
  }
});

test("one wake timer keeps stalled and rejected Queue lanes independent while shutdown drains them", async () => {
  const held = deferred();
  const heldStarted = deferred();
  const failureReported = deferred();
  const independentDelivery = deferred();
  const ingressStopped = deferred();
  let v2Starts = 0;
  let legacyStarts = 0;
  let finished = false;
  let succeeded = false;
  const failures: string[] = [];
  const lifecycle = createSelfhostEntryShutdown({
    stopIngress: async () => ingressStopped.resolve(),
    finishShutdown: async () => {
      finished = true;
    },
    onFailure: (stage) => failures.push(stage),
    onSuccess: () => {
      succeeded = true;
    },
  });
  const report = (name: string) => {
    failures.push(name);
    failureReported.resolve();
  };
  lifecycle.startInterval(
    "queue-wake",
    5,
    () => {
      void lifecycle
        .runPass("takoform-v2-queue-delivery", async () => {
          v2Starts += 1;
          if (v2Starts === 1) throw new Error("v2 recovery query failed");
          heldStarted.resolve();
          await held.promise;
        })
        .catch(() => report("takoform-v2-queue-delivery"));
      void lifecycle
        .runPass("queue-pump", async () => {
          legacyStarts += 1;
          if (legacyStarts >= 3) independentDelivery.resolve();
        })
        .catch(() => report("queue-pump"));
    },
    report,
  );
  try {
    await Promise.all([failureReported.promise, heldStarted.promise, independentDelivery.promise]);
    expect(failures).toEqual(["takoform-v2-queue-delivery"]);
    expect(v2Starts).toBe(2);
    expect(legacyStarts).toBeGreaterThanOrEqual(3);
    const shutdown = lifecycle.shutdown();
    await ingressStopped.promise;
    expect(lifecycle.isStopping()).toBe(true);
    expect(finished).toBe(false);
    expect(succeeded).toBe(false);
    const startsAtShutdown = legacyStarts;
    await lifecycle.runPass("queue-pump", async () => {
      legacyStarts += 1;
    });
    expect(legacyStarts).toBe(startsAtShutdown);
    held.resolve();
    expect(await shutdown).toBe(true);
    expect(finished).toBe(true);
    expect(succeeded).toBe(true);
  } finally {
    held.resolve();
    await lifecycle.shutdown();
  }
});

test("failed cleanup reports failure without invoking successful exit", async () => {
  const result: string[] = [];
  const lifecycle = createSelfhostEntryShutdown({
    stopIngress: async () => {
      result.push("ingress");
    },
    finishShutdown: async () => {
      throw new Error("private cleanup detail");
    },
    onFailure: (stage) => result.push(`failed:${stage}`),
    onSuccess: () => result.push("success"),
  });

  expect(await lifecycle.shutdown()).toBe(false);
  expect(result).toEqual(["ingress", "failed:cleanup"]);
});

test("reentrant shutdown joins the promise before ingress callback reenters", async () => {
  const calls: string[] = [];
  let lifecycle!: ReturnType<typeof createSelfhostEntryShutdown>;
  let reentered: Promise<boolean> | undefined;
  lifecycle = createSelfhostEntryShutdown({
    stopIngress: async () => {
      calls.push("ingress");
      reentered = lifecycle.shutdown();
    },
    finishShutdown: async () => {
      calls.push("finish");
    },
    onFailure: (stage) => calls.push(`failed:${stage}`),
    onSuccess: () => calls.push("success"),
  });

  const first = lifecycle.shutdown();
  expect(await first).toBe(true);
  expect(reentered).toBe(first);
  expect(calls).toEqual(["ingress", "finish", "success"]);
});

test("shutdown does not replace a response without a body", async () => {
  const lifecycle = createSelfhostEntryShutdown({
    stopIngress: async () => undefined,
    finishShutdown: async () => undefined,
    onFailure: () => undefined,
    onSuccess: () => undefined,
  });
  const upgradeLike = new Response(null, { status: 204 });
  const returned = await lifecycle.fetch(new Request("http://localhost/"), () => upgradeLike);
  expect(returned).toBe(upgradeLike);
});

test("uncertain Actor close preserves its dependent data plane and database", async () => {
  const calls: string[] = [];
  const failures: string[] = [];
  const closed = await closeSelfhostEntryOwnedResources({
    workerdShutdown: async () => {
      calls.push("workerd");
    },
    mayCloseDependents: () => true,
    actorClose: async () => {
      calls.push("actor");
      throw new Error("private actor close detail");
    },
    dataPlanesStop: async () => {
      calls.push("data-planes");
    },
    controlDatabaseClose: () => calls.push("database"),
    onFailure: (stage) => failures.push(stage),
  });

  expect(closed).toBe(false);
  expect(calls).toEqual(["workerd", "actor"]);
  expect(failures).toEqual(["actor-close"]);
});

test("unproven Container close preserves every dependent owner after Workerd exits", async () => {
  const calls: string[] = [];
  const closed = await closeSelfhostEntryOwnedResources({
    workerdShutdown: async () => {
      calls.push("workerd");
    },
    mayCloseDependents: () => false,
    actorClose: async () => {
      calls.push("actor");
    },
    dataPlanesStop: async () => {
      calls.push("data-planes");
    },
    controlDatabaseClose: () => calls.push("database"),
    onFailure: () => undefined,
  });

  expect(closed).toBe(false);
  expect(calls).toEqual(["workerd"]);
});
