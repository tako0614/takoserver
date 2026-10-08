import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfhostV2WorkerEndpointHttpsListener,
  type SelfhostV2WorkerEndpointHttpsFactories,
  verifySelfhostV2WorkerEndpointHttpsSni,
} from "../src/selfhost-v2-worker-endpoint-https.ts";
import type { V2EndpointTlsObservation } from "../src/takoform-v2/worker-endpoint-backend.ts";

type V2WorkerEndpointAddress = Omit<V2EndpointTlsObservation, "ready">;

const suffix = "workers.example.test";
const address: V2WorkerEndpointAddress = {
  endpointUid: "r_endpoint1",
  workerUid: "r_worker1",
  hostname: `v2-${"a".repeat(32)}.${suffix}`,
  url: `https://v2-${"a".repeat(32)}.${suffix}/`,
};

async function certificateFixture(subjectAltName = `DNS:*.${suffix}`) {
  const directory = await mkdtemp(join(tmpdir(), "takoserver-v2-worker-endpoint-https-"));
  await chmod(directory, 0o700);
  const certificatePath = join(directory, "certificate.pem");
  const privateKeyPath = join(directory, "private-key.pem");
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-days",
      "2",
      "-subj",
      `/CN=${subjectAltName.replace(/^DNS:/u, "")}`,
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await child.exited) !== 0) throw new Error("temporary TLS certificate generation failed");
  await chmod(privateKeyPath, 0o600);
  return {
    certificateChain: await readFile(certificatePath, "utf8"),
    privateKey: await readFile(privateKeyPath, "utf8"),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function createLoopbackListener(input: {
  readonly certificateChain: string;
  readonly privateKey: string;
  readonly fetch: (request: Request) => Promise<Response | null>;
  readonly routeDenies: (address: V2WorkerEndpointAddress) => Promise<boolean>;
  readonly onSni?: (hostname: string) => void;
}) {
  let loopbackPort: number | undefined;
  let listenerFetch: ((request: Request) => Response | Promise<Response>) | undefined;
  const sniNames: string[] = [];
  const listener = await createSelfhostV2WorkerEndpointHttpsListener({
    configuration: { workerEndpointSuffix: suffix, port: 443 },
    ...input,
    factories: {
      serve(options) {
        listenerFetch = options.fetch;
        const server = Bun.serve({ ...options, port: 0, hostname: "127.0.0.1" });
        loopbackPort = server.port;
        // Tests remap the required logical 443 to an OS-selected loopback port.
        return { port: 443, stop: (force) => server.stop(force) };
      },
      async proveSni(probe) {
        if (loopbackPort === undefined) throw new Error("test listener was not created");
        sniNames.push(probe.hostname);
        input.onSni?.(probe.hostname);
        await verifySelfhostV2WorkerEndpointHttpsSni({
          ...probe,
          host: "127.0.0.1",
          port: loopbackPort,
        });
      },
    },
  });
  if (loopbackPort === undefined) throw new Error("test listener was not created");
  if (!listenerFetch) throw new Error("listener fetch was not installed");
  return { listener, port: loopbackPort, sniNames, listenerFetch };
}

function get(port: number, host: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        servername: host,
        path,
        headers: { host },
        rejectUnauthorized: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("test HTTPS request timed out")));
    request.once("error", reject);
    request.end();
  });
}

test("V2 Worker Endpoint HTTPS serves exact suffix hosts and witnesses current local SNI", async () => {
  const fixture = await certificateFixture();
  let dispatched = 0;
  let routeDenied = false;
  const { listener, port, sniNames } = await createLoopbackListener({
    ...fixture,
    routeDenies: async () => routeDenied,
    fetch: async (request) => {
      dispatched++;
      expect(new URL(request.url).hostname).toBe(address.hostname);
      return new Response(`served:${new URL(request.url).pathname}`);
    },
  });
  try {
    await expect(listener.witness.observeTls(address)).resolves.toEqual({
      ...address,
      ready: true,
    });
    expect(sniNames).toContain(address.hostname);
    expect(await get(port, address.hostname, "/hello")).toEqual({
      status: 200,
      body: "served:/hello",
    });
    expect(dispatched).toBe(1);
    routeDenied = true;
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toEqual({
      ...address,
      absent: true,
    });
    const foreign = await get(port, "elsewhere.example.test", "/not-dispatched");
    expect(foreign.status).toBe(404);
    expect(dispatched).toBe(1);
    await listener.close();
    await expect(listener.witness.observeTls(address)).resolves.toEqual({
      ...address,
      ready: false,
    });
  } finally {
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("accepted upgrade holds route absence until the original client socket closes", async () => {
  const fixture = await certificateFixture();
  let options: Parameters<SelfhostV2WorkerEndpointHttpsFactories["serve"]>[0] | undefined;
  let bridge: { clientClosed(): void } | undefined;
  const upstreamSent: (string | Uint8Array)[] = [];
  let upstreamClose: { code: number | undefined; reason: string | undefined } | undefined;
  const upstream = new EventTarget();
  Object.assign(upstream, {
    readyState: 1,
    protocol: "",
    bufferedAmount: 0,
    forwardMessages(send: (value: string | Uint8Array) => void) {
      upstream.addEventListener("message", (event) => {
        send((event as MessageEvent).data);
      });
      send("welcome");
    },
    send(value: string | Uint8Array) {
      upstreamSent.push(value);
    },
    close(code?: number, reason?: string) {
      upstreamClose = { code, reason };
      upstream.dispatchEvent(new CloseEvent("close", { code: code ?? 1000, reason: reason ?? "" }));
    },
    terminate() {
      upstream.dispatchEvent(new Event("close"));
    },
  });
  const server = {
    port: 443,
    stop() {},
    upgrade(_request: Request, upgrade: { data: { clientClosed(): void } }) {
      bridge = upgrade.data;
      return true;
    },
  };
  let upgradeCalls = 0;
  const listener = await createSelfhostV2WorkerEndpointHttpsListener({
    configuration: { workerEndpointSuffix: suffix, port: 443 },
    ...fixture,
    fetch: async () => {
      throw new Error("ordinary fetch must not handle an upgrade");
    },
    upgrade: async () => {
      upgradeCalls++;
      return { kind: "accepted", socket: upstream as never };
    },
    routeDenies: async () => true,
    factories: {
      serve(value) {
        options = value;
        return server;
      },
      async proveSni() {},
    },
  });
  try {
    if (!options) throw new Error("listener options unavailable");
    expect(options.websocket.maxPayloadLength).toBe(33_554_432);
    expect(options.websocket.backpressureLimit).toBe(33_554_432);
    expect(options.websocket.closeOnBackpressureLimit).toBe(false);
    const request = new Request(`https://${address.hostname}/actor-socket`, {
      headers: {
        host: address.hostname,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==",
      },
    });
    const invalid = new Request(request.url, {
      headers: { host: address.hostname, upgrade: "websocket" },
    });
    expect((await options.fetch(invalid, server as never)).status).toBe(400);
    expect(upgradeCalls).toBe(0);
    expect(await options.fetch(request, server as never)).toBeUndefined();
    expect(upgradeCalls).toBe(1);
    expect(bridge).toBeDefined();
    expect((await listener.witness.observeRouteAbsent(address)).absent).toBe(false);
    const clientSent: (string | ArrayBuffer | Uint8Array)[] = [];
    let clientClose: { code: number | undefined; reason: string | undefined } | undefined;
    const client = {
      data: bridge,
      readyState: 1,
      close(code?: number, reason?: string) {
        clientClose = { code, reason };
      },
      terminate() {},
      send(value: string | ArrayBuffer | Uint8Array) {
        clientSent.push(value);
        return -1; // Bun accepted the frame into its bounded backpressure queue.
      },
    };
    options.websocket.open?.(client as never);
    expect(clientSent).toEqual(["welcome"]);
    const legalFrame = new Uint8Array(9 * 1024 * 1024);
    options.websocket.message(client as never, legalFrame as never);
    expect(upstreamSent).toEqual([legalFrame]);
    upstream.dispatchEvent(new MessageEvent("message", { data: legalFrame.buffer }));
    expect(clientSent).toHaveLength(2);
    expect(clientSent[1]).toBe(legalFrame.buffer);
    options.websocket.drain?.(client as never);
    const maximumFrame = new Uint8Array(33_554_432);
    options.websocket.message(client as never, maximumFrame as never);
    expect(upstreamSent[1]).toBe(maximumFrame);
    upstream.dispatchEvent(new MessageEvent("message", { data: maximumFrame.buffer }));
    expect(clientSent[2]).toBe(maximumFrame.buffer);
    upstream.dispatchEvent(new CloseEvent("close", { code: 4000, reason: "done" }));
    expect(clientClose).toEqual({ code: 4000, reason: "done" });
    expect((await listener.witness.observeRouteAbsent(address)).absent).toBe(false);
    options.websocket.close?.(client as never, 4001, "client done");
    expect(upstreamClose).toEqual({ code: 4001, reason: "client done" });
    expect((await listener.witness.observeRouteAbsent(address)).absent).toBe(true);
  } finally {
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("witness rejects a noncanonical or foreign Endpoint address", async () => {
  const fixture = await certificateFixture();
  const { listener, port, sniNames } = await createLoopbackListener({
    ...fixture,
    routeDenies: async () => true,
    fetch: async () => new Response("unexpected"),
  });
  try {
    const foreign = {
      ...address,
      hostname: `v2-${"b".repeat(32)}.foreign.example.test`,
      url: `https://v2-${"b".repeat(32)}.foreign.example.test/`,
    };
    await expect(listener.witness.observeTls(foreign)).resolves.toEqual({
      ...foreign,
      ready: false,
    });
    await expect(listener.witness.observeRouteAbsent(foreign)).resolves.toEqual({
      ...foreign,
      absent: false,
    });
    expect(sniNames).toEqual([`tls-probe.${suffix}`]);
    expect(await get(port, "wrong.other.test")).toEqual({ status: 404, body: "" });
  } finally {
    await listener.close();
    await fixture.cleanup();
  }
});

test("route absence requires a denied route and fully drained matching-host response bodies", async () => {
  const fixture = await certificateFixture();
  let routeDenied = false;
  let dispatched = 0;
  let closeBody: (() => void) | undefined;
  const { listener, listenerFetch } = await createLoopbackListener({
    ...fixture,
    routeDenies: async () => routeDenied,
    fetch: async () => {
      dispatched++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("stream-open"));
            closeBody = () => controller.close();
          },
        }),
      );
    },
  });
  try {
    const response = await listenerFetch(
      new Request(`https://${address.hostname}/stream`, { headers: { host: address.hostname } }),
    );
    expect(response.status).toBe(200);
    expect(dispatched).toBe(1);
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toMatchObject({
      absent: false,
    });

    routeDenied = true;
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toMatchObject({
      absent: false,
    });
    const reading = response.text();
    await Promise.resolve();
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toMatchObject({
      absent: false,
    });

    closeBody?.();
    await expect(reading).resolves.toBe("stream-open");
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toEqual({
      ...address,
      absent: true,
    });
  } finally {
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("route absence is rechecked after awaited SNI proof and rejects non-default request ports", async () => {
  const fixture = await certificateFixture();
  let routeChecks = 0;
  let routeDenied = true;
  let dispatched = 0;
  const { listener, listenerFetch } = await createLoopbackListener({
    ...fixture,
    routeDenies: async () => {
      routeChecks++;
      return routeDenied;
    },
    onSni(hostname) {
      if (hostname === address.hostname) routeDenied = false;
    },
    fetch: async () => {
      dispatched++;
      return new Response("unexpected");
    },
  });
  try {
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toMatchObject({
      absent: false,
    });
    expect(routeChecks).toBe(2);

    const nonDefaultPort = await listenerFetch(
      new Request(`https://${address.hostname}:444/`, { headers: { host: address.hostname } }),
    );
    expect(nonDefaultPort.status).toBe(404);
    expect(dispatched).toBe(0);
  } finally {
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("a matching-host body cancellation is awaited before route absence can be witnessed", async () => {
  const fixture = await certificateFixture();
  let beginSourceCancel: (() => void) | undefined;
  let finishSourceCancel: (() => void) | undefined;
  const sourceCancelStarted = new Promise<void>((resolve) => {
    beginSourceCancel = resolve;
  });
  const sourceCancelGate = new Promise<void>((resolve) => {
    finishSourceCancel = resolve;
  });
  let sourceCancelCompleted = false;
  const { listener, listenerFetch } = await createLoopbackListener({
    ...fixture,
    routeDenies: async () => true,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("streaming"));
          },
          async cancel() {
            beginSourceCancel?.();
            await sourceCancelGate;
            sourceCancelCompleted = true;
          },
        }),
      ),
  });
  try {
    const response = await listenerFetch(
      new Request(`https://${address.hostname}/cancel`, { headers: { host: address.hostname } }),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("streaming");
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toMatchObject({
      absent: false,
    });

    const cancelling = reader?.cancel("client disconnected");
    await sourceCancelStarted;
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toMatchObject({
      absent: false,
    });
    expect(sourceCancelCompleted).toBe(false);
    finishSourceCancel?.();
    await cancelling;
    expect(sourceCancelCompleted).toBe(true);
    await expect(listener.witness.observeRouteAbsent(address)).resolves.toEqual({
      ...address,
      absent: true,
    });
  } finally {
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("graceful close waits for tracked same-host bodies even when server.stop returns void", async () => {
  const fixture = await certificateFixture();
  let listenerFetch: ((request: Request) => Response | Promise<Response>) | undefined;
  let finishBody: (() => void) | undefined;
  const stopModes: boolean[] = [];
  const listener = await createSelfhostV2WorkerEndpointHttpsListener({
    configuration: { workerEndpointSuffix: suffix, port: 443 },
    ...fixture,
    routeDenies: async () => true,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hold"));
            let closed = false;
            finishBody = () => {
              if (closed) return;
              closed = true;
              controller.close();
            };
          },
        }),
      ),
    factories: {
      serve(options) {
        listenerFetch = options.fetch;
        return {
          port: 443,
          stop(force) {
            stopModes.push(force ?? false);
          },
        };
      },
      async proveSni() {},
    },
  });
  try {
    if (!listenerFetch) throw new Error("listener fetch was not installed");
    const response = await listenerFetch(
      new Request(`https://${address.hostname}/shutdown`, { headers: { host: address.hostname } }),
    );
    const close = listener.close(false);
    expect(listener.close(false)).toBe(close);
    expect(stopModes).toEqual([false]);
    let settled = false;
    void close.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    const finish = finishBody;
    finishBody = undefined;
    finish?.();
    await expect(response.text()).resolves.toBe("hold");
    await close;
    expect(settled).toBe(true);
    expect(stopModes).toEqual([false]);
  } finally {
    finishBody?.();
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("force close escalates a graceful body drain without claiming graceful completion", async () => {
  const fixture = await certificateFixture();
  let listenerFetch: ((request: Request) => Response | Promise<Response>) | undefined;
  let finishBody: (() => void) | undefined;
  const stopModes: boolean[] = [];
  const listener = await createSelfhostV2WorkerEndpointHttpsListener({
    configuration: { workerEndpointSuffix: suffix, port: 443 },
    ...fixture,
    routeDenies: async () => true,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("held"));
            let closed = false;
            finishBody = () => {
              if (closed) return;
              closed = true;
              controller.close();
            };
          },
        }),
      ),
    factories: {
      serve(options) {
        listenerFetch = options.fetch;
        return {
          port: 443,
          stop(force) {
            stopModes.push(force ?? false);
          },
        };
      },
      async proveSni() {},
    },
  });
  try {
    if (!listenerFetch) throw new Error("listener fetch was not installed");
    const response = await listenerFetch(
      new Request(`https://${address.hostname}/force-shutdown`, {
        headers: { host: address.hostname },
      }),
    );
    const graceful = listener.close(false);
    let settled = false;
    void graceful.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    expect(listener.close(true)).toBe(graceful);
    await graceful;
    expect(settled).toBe(true);
    expect(stopModes).toEqual([false, true]);

    const finish = finishBody;
    finishBody = undefined;
    finish?.();
    await response.text();
  } finally {
    finishBody?.();
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("listener rejects noncanonical suffix and validates matching wildcard cert before binding", async () => {
  const fixture = await certificateFixture();
  const wrongWildcard = await certificateFixture("DNS:*.unrelated.example.test");
  let serves = 0;
  const factories = {
    serve() {
      serves++;
      throw new Error("must not bind");
    },
    proveSni: async () => {},
  };
  try {
    await expect(
      createSelfhostV2WorkerEndpointHttpsListener({
        configuration: { workerEndpointSuffix: "Workers.example.test", port: 443 },
        ...fixture,
        routeDenies: async () => true,
        fetch: async () => null,
        factories,
      }),
    ).rejects.toThrow("canonical reserved DNS suffix");
    await expect(
      createSelfhostV2WorkerEndpointHttpsListener({
        configuration: { workerEndpointSuffix: suffix, port: 443 },
        certificateChain: wrongWildcard.certificateChain,
        privateKey: wrongWildcard.privateKey,
        routeDenies: async () => true,
        fetch: async () => null,
        factories,
      }),
    ).rejects.toThrow("cover the configured wildcard");
    await expect(
      createSelfhostV2WorkerEndpointHttpsListener({
        configuration: { workerEndpointSuffix: suffix, port: 443 },
        certificateChain: fixture.certificateChain,
        privateKey: "not a private key",
        routeDenies: async () => true,
        fetch: async () => null,
        factories,
      }),
    ).rejects.toThrow("private key is invalid");
    expect(serves).toBe(0);
  } finally {
    await fixture.cleanup();
    await wrongWildcard.cleanup();
  }
});
