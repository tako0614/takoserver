import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfhostContainerEndpointHttpsDispatch,
  createSelfhostContainerEndpointHttpsListener,
  createSelfhostContainerEndpointHttpsListenerIfSupported,
  parseSelfhostContainerEndpointHttpsConfiguration,
  SELFHOST_CONTAINER_ENDPOINT_HTTPS_ENVIRONMENT,
  verifySelfhostContainerEndpointHttpsHandshake,
} from "../src/selfhost-container-endpoint-https.ts";

const suffix = "example.test";
const endpointEnvironment = {
  [SELFHOST_CONTAINER_ENDPOINT_HTTPS_ENVIRONMENT.suffix]: suffix,
};

async function certificateFixture(subjectAltName = "DNS:*.example.test") {
  const directory = await mkdtemp(join(tmpdir(), "takoserver-container-https-"));
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
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error("local OpenSSL certificate fixture failed");
  await chmod(privateKeyPath, 0o600);
  const certificateChain = await readFile(certificatePath, "utf8");
  const privateKey = await readFile(privateKeyPath, "utf8");
  return {
    certificateChain,
    privateKey,
    privateKeyPath,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function liveLoopbackListener(
  fixture: Awaited<ReturnType<typeof certificateFixture>>,
  options: { readonly rejectFirstStop?: boolean } = {},
) {
  let server:
    | {
        readonly port: number | undefined;
        stop(closeActiveConnections?: boolean): void | Promise<void>;
      }
    | undefined;
  let underlyingPort: number | undefined;
  let rejectNextStop = options.rejectFirstStop ?? false;
  const stopModes: boolean[] = [];
  const listener = await createSelfhostContainerEndpointHttpsListener({
    configuration: { configuredSuffix: suffix, publicOrigin: `https://${suffix}`, port: 443 },
    certificateChain: fixture.certificateChain,
    privateKey: fixture.privateKey,
    factories: {
      serve(options) {
        const liveServer = Bun.serve({ ...options, port: 0, hostname: "127.0.0.1" });
        server = liveServer;
        underlyingPort = liveServer.port;
        return {
          port: 443,
          stop(closeActiveConnections) {
            stopModes.push(closeActiveConnections ?? false);
            if (rejectNextStop) {
              rejectNextStop = false;
              return Promise.reject(new Error("synthetic stop outcome unknown"));
            }
            return server?.stop(closeActiveConnections);
          },
        };
      },
      async proveSni(input) {
        if (underlyingPort === undefined) throw new Error("loopback listener was not created");
        await verifySelfhostContainerEndpointHttpsHandshake({
          ...input,
          host: "127.0.0.1",
          port: underlyingPort,
        });
      },
    },
  });
  if (underlyingPort === undefined) throw new Error("loopback listener was not created");
  return { listener, port: underlyingPort, stopModes };
}

function tlsGet(
  port: number,
  path: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const host = `ce-${"0".repeat(40)}.${suffix}`;
  return new Promise((resolve) => {
    const request = httpsGet(
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
        response.on("data", (chunk) => (body += chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("test HTTPS request timed out")));
    request.once("error", () => resolve({ status: 0, body: "" }));
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("Container endpoint HTTPS requires explicit suffix and the existing runtime", () => {
  expect(
    parseSelfhostContainerEndpointHttpsConfiguration(
      {},
      {
        containerRuntimeConfigured: true,
        controlPort: 8787,
        workerdPort: 8788,
        workerEndpointPort: 8788,
      },
    ),
  ).toBeUndefined();

  expect(() =>
    parseSelfhostContainerEndpointHttpsConfiguration(endpointEnvironment, {
      containerRuntimeConfigured: false,
      controlPort: 8787,
      workerdPort: 8788,
      workerEndpointPort: 8788,
    }),
  ).toThrow("requires the opt-in self-host Container runtime");
  expect(
    parseSelfhostContainerEndpointHttpsConfiguration(
      { TAKOSERVER_SUFFIXES: "example.test" },
      {
        containerRuntimeConfigured: true,
        controlPort: 8787,
        workerdPort: 8788,
        workerEndpointPort: 8788,
      },
    ),
  ).toBeUndefined();
  expect(() =>
    parseSelfhostContainerEndpointHttpsConfiguration(
      { ...endpointEnvironment, TAKOSERVER_SUFFIXES: "ignored.example" },
      {
        containerRuntimeConfigured: true,
        controlPort: 8787,
        workerdPort: 8788,
        workerEndpointPort: 8788,
      },
    ),
  ).not.toThrow();
});

test("Container HTTPS refuses Workerd and Worker endpoint 443 conflicts before effects", () => {
  for (const ports of [
    { controlPort: 8787, workerdPort: 443, workerEndpointPort: 443 },
    { controlPort: 8787, workerdPort: 8788, workerEndpointPort: 443 },
    { controlPort: 443, workerdPort: 8788, workerEndpointPort: 8788 },
  ]) {
    expect(() =>
      parseSelfhostContainerEndpointHttpsConfiguration(endpointEnvironment, {
        containerRuntimeConfigured: true,
        ...ports,
      }),
    ).toThrow("cannot share the Bun control or Workerd listener");
  }
});

test("canonical Bun entry rejects 443 conflict and missing TLS material before opening state", async () => {
  const dataRoot = join(tmpdir(), `takoserver-container-https-entry-${crypto.randomUUID()}`);
  const child = Bun.spawn([process.execPath, "src/entry-bun.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TAKOSERVER_DATA_ROOT: dataRoot,
      TAKOSERVER_DB: join(dataRoot, "control.sqlite"),
      TAKOSERVER_SELFHOST_CONTAINER_DOCKER_SOCKET: "/run/no-contact.sock",
      TAKOSERVER_SELFHOST_CONTAINER_NETWORK: "takoserver-container-internal",
      TAKOSERVER_SELFHOST_CONTAINER_ENDPOINT_SUFFIX: suffix,
      TAKOSERVER_WORKERD_PORT: "443",
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("cannot share the Bun control or Workerd listener");
    expect(existsSync(dataRoot)).toBe(false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }

  const missingTlsDataRoot = join(
    tmpdir(),
    `takoserver-container-https-no-tls-${crypto.randomUUID()}`,
  );
  const missingTls = Bun.spawn([process.execPath, "src/entry-bun.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TAKOSERVER_DATA_ROOT: missingTlsDataRoot,
      TAKOSERVER_DB: join(missingTlsDataRoot, "control.sqlite"),
      TAKOSERVER_SELFHOST_CONTAINER_DOCKER_SOCKET: "/run/no-contact.sock",
      TAKOSERVER_SELFHOST_CONTAINER_NETWORK: "takoserver-container-internal",
      TAKOSERVER_SELFHOST_CONTAINER_ENDPOINT_SUFFIX: suffix,
    },
  });
  const [missingTlsExit, missingTlsStdout, missingTlsStderr] = await Promise.all([
    missingTls.exited,
    new Response(missingTls.stdout).text(),
    new Response(missingTls.stderr).text(),
  ]);
  try {
    expect(missingTlsExit).not.toBe(0);
    expect(`${missingTlsStdout}\n${missingTlsStderr}`).toContain(
      "requires the existing Worker TLS certificate and key material",
    );
    expect(existsSync(missingTlsDataRoot)).toBe(false);
  } finally {
    await rm(missingTlsDataRoot, { recursive: true, force: true });
  }
});

test("suffix parsing rejects URL, wildcard, IP, and invalid DNS spellings", () => {
  for (const invalid of ["", "https://example.test", "*.example.test", "127.0.0.1", "bad..test"]) {
    expect(() =>
      parseSelfhostContainerEndpointHttpsConfiguration(
        { [SELFHOST_CONTAINER_ENDPOINT_HTTPS_ENVIRONMENT.suffix]: invalid },
        {
          containerRuntimeConfigured: true,
          controlPort: 8787,
          workerdPort: 8788,
          workerEndpointPort: 8788,
        },
      ),
    ).toThrow();
  }
});

test("default published Forms do not cause a Container HTTPS listener to bind", async () => {
  let binds = 0;
  const factories = {
    serve() {
      binds++;
      throw new Error("must not bind without exact package pair");
    },
    async proveSni() {
      throw new Error("must not probe without exact package pair");
    },
  };
  const result = await createSelfhostContainerEndpointHttpsListenerIfSupported({
    configuration: {
      configuredSuffix: suffix,
      publicOrigin: `https://${suffix}`,
      port: 443,
    },
    containerRuntimeConfigured: true,
    exactCandidatePair: false,
    certificateChain: "ignored because the exact package pair is absent",
    privateKey: "ignored because the exact package pair is absent",
    factories,
  });
  expect(result).toBeUndefined();
  expect(binds).toBe(0);
});

test("dedicated TLS dispatch is Endpoint-only and never falls through to Host routes", async () => {
  const forwarded: string[] = [];
  const dispatch = createSelfhostContainerEndpointHttpsDispatch(async (request) => {
    const url = new URL(request.url);
    if (!url.hostname.endsWith(`.${suffix}`)) return null;
    forwarded.push(`${request.method} ${url.pathname}`);
    return new Response(`${request.method} ${url.pathname}`);
  });
  const endpointHost = `ce-${"0".repeat(40)}.${suffix}`;
  for (const [method, path] of [
    ["GET", "/_takoserver/health/live"],
    ["POST", "/provision/x"],
    ["OPTIONS", "/v1/resources/example"],
  ] as const) {
    const response = await dispatch(new Request(`https://${endpointHost}${path}`, { method }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`${method} ${path}`);
  }

  const unmatched = await dispatch(new Request("https://outside.example.invalid/v1/forms"));
  expect(unmatched.status).toBe(404);
  expect(unmatched.headers.get("cache-control")).toBe("no-store");
  expect(await unmatched.text()).toBe("");
  expect(forwarded).toEqual([
    "GET /_takoserver/health/live",
    "POST /provision/x",
    "OPTIONS /v1/resources/example",
  ]);
});

test("live listener capability is minted only after independent local SNI proof", async () => {
  const fixture = await certificateFixture();
  const calls: string[] = [];
  let dispatch: ((request: Request) => Response | Promise<Response>) | undefined;
  const listener = await createSelfhostContainerEndpointHttpsListener({
    configuration: { configuredSuffix: suffix, publicOrigin: `https://${suffix}`, port: 443 },
    certificateChain: fixture.certificateChain,
    privateKey: fixture.privateKey,
    factories: {
      serve(options) {
        expect(options.port).toBe(443);
        calls.push("bind");
        dispatch = options.fetch;
        return {
          port: 443,
          async stop(closeActiveConnections = true) {
            calls.push(`stop:${closeActiveConnections}`);
          },
        };
      },
      async proveSni() {
        calls.push("sni-proof");
      },
    },
  });

  try {
    expect(calls).toEqual(["bind", "sni-proof"]);
    expect(listener.ingress).toMatchObject({
      configuredSuffix: suffix,
      publicOrigin: `https://${suffix}`,
      port: 443,
    });
    expect(() => listener.ingress.assertServing()).not.toThrow();
    expect(
      (await dispatch?.(new Request("https://example.test/_takoserver/health/live")))?.status,
    ).toBe(503);
    expect(
      (await dispatch?.(new Request("https://example.test/provision/x", { method: "OPTIONS" })))
        ?.status,
    ).toBe(503);
    expect(
      (await dispatch?.(new Request("https://example.test/_takoserver/health/live")))?.headers.get(
        "cache-control",
      ),
    ).toBe("no-store");

    listener.installEndpointFetch((request) => {
      if (new URL(request.url).pathname === "/explode") {
        return Promise.reject(new Error("private endpoint error"));
      }
      return new Response(`${request.method} ${new URL(request.url).pathname}`);
    });
    expect(
      await (await dispatch?.(new Request("https://example.test/_takoserver/health/live")))?.text(),
    ).toBe("GET /_takoserver/health/live");
    expect(
      await (
        await dispatch?.(new Request("https://example.test/provision/x", { method: "OPTIONS" }))
      )?.text(),
    ).toBe("OPTIONS /provision/x");
    const failed = await dispatch?.(new Request("https://example.test/explode"));
    expect(failed?.status).toBe(503);
    expect(failed?.headers.get("cache-control")).toBe("no-store");
    expect(await failed?.text()).toBe("");
  } finally {
    await listener.close();
    expect(calls.at(-1)).toBe("stop:true");
    expect(() => listener.ingress.assertServing()).toThrow("not serving");
    await fixture.cleanup();
  }
});

test("default close force-cuts an accepted pending HTTPS response", async () => {
  const fixture = await certificateFixture();
  const accepted = deferred();
  const responseGate = deferred();
  const { listener, port, stopModes } = await liveLoopbackListener(fixture);
  listener.installEndpointFetch(async () => {
    accepted.resolve();
    await responseGate.promise;
    return new Response("completed after force close");
  });

  try {
    const response = tlsGet(port, "/pending-force");
    await accepted.promise;
    const close = listener.close();
    expect(listener.close()).toBe(close);
    await close;
    expect(stopModes).toEqual([true]);
    expect(() => listener.ingress.assertServing()).toThrow("not serving");
    responseGate.resolve();
    expect((await response).status).not.toBe(200);
  } finally {
    responseGate.resolve();
    await listener.close();
    await fixture.cleanup();
  }
});

test("graceful close waits for accepted response bodies and refuses new requests", async () => {
  const fixture = await certificateFixture();
  const accepted = deferred();
  const handlerGate = deferred();
  const bodyStarted = deferred();
  const bodyGate = deferred();
  const { listener, port, stopModes } = await liveLoopbackListener(fixture);
  listener.installEndpointFetch(async () => {
    accepted.resolve();
    await handlerGate.promise;
    let started = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          started = true;
          bodyStarted.resolve();
        }
        await bodyGate.promise;
        controller.enqueue(new TextEncoder().encode("drained"));
        controller.close();
      },
    });
    return new Response(body);
  });

  try {
    const response = tlsGet(port, "/pending-graceful");
    await accepted.promise;
    const close = listener.close(false);
    expect(listener.close(false)).toBe(close);
    expect(() => listener.ingress.assertServing()).toThrow("not serving");
    expect(stopModes).toEqual([false]);

    let closeSettled = false;
    void close.then(
      () => (closeSettled = true),
      () => (closeSettled = true),
    );
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    const refused = await tlsGet(port, "/after-close").then(
      (result) => result.status,
      () => 0,
    );
    expect(refused).not.toBe(200);

    handlerGate.resolve();
    await bodyStarted.promise;
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    bodyGate.resolve();
    expect(await response).toEqual({ status: 200, body: "drained" });
    await close;
    expect(closeSettled).toBe(true);
    expect(listener.close(true)).toBe(close);
    expect(stopModes).toEqual([false]);
  } finally {
    handlerGate.resolve();
    bodyGate.resolve();
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("force close escalates pending graceful stop through the retained listener", async () => {
  const fixture = await certificateFixture();
  const accepted = deferred();
  const responseGate = deferred();
  const { listener, port, stopModes } = await liveLoopbackListener(fixture);
  listener.installEndpointFetch(async () => {
    accepted.resolve();
    await responseGate.promise;
    return new Response("must not survive forced close");
  });

  try {
    const response = tlsGet(port, "/pending-escalation");
    await accepted.promise;
    const close = listener.close(false);
    expect(listener.close(true)).toBe(close);
    await close;
    expect(stopModes).toEqual([false, true]);
    expect(() => listener.ingress.assertServing()).toThrow("not serving");
    responseGate.resolve();
    expect((await response).status).not.toBe(200);
  } finally {
    responseGate.resolve();
    await listener.close(true);
    await fixture.cleanup();
  }
});

test("a rejected close keeps the listener handle available for forced retry", async () => {
  const fixture = await certificateFixture();
  const { listener, port, stopModes } = await liveLoopbackListener(fixture, {
    rejectFirstStop: true,
  });
  listener.installEndpointFetch(() => new Response("must refuse after close starts"));

  try {
    await expect(listener.close(false)).rejects.toThrow("synthetic stop outcome unknown");
    expect(() => listener.ingress.assertServing()).toThrow("not serving");
    expect(await tlsGet(port, "/after-rejected-close")).toEqual({ status: 503, body: "" });
    await listener.close(true);
    expect(stopModes).toEqual([false, true]);
    expect(() => listener.ingress.assertServing()).toThrow("not serving");
  } finally {
    await listener.close(true).catch(() => undefined);
    await fixture.cleanup();
  }
});

test("listener refuses an invalid certificate before binding and cleans up failed proof", async () => {
  const fixture = await certificateFixture();
  let binds = 0;
  let stops = 0;
  const factories = {
    serve() {
      binds++;
      return {
        port: 443,
        stop() {
          stops++;
        },
      };
    },
    async proveSni() {
      throw new Error("synthetic SNI failure");
    },
  };
  try {
    await expect(
      createSelfhostContainerEndpointHttpsListener({
        configuration: { configuredSuffix: suffix, publicOrigin: `https://${suffix}`, port: 443 },
        certificateChain: fixture.certificateChain,
        privateKey: "not a key",
        factories,
      }),
    ).rejects.toThrow();
    expect(binds).toBe(0);

    await expect(
      createSelfhostContainerEndpointHttpsListener({
        configuration: { configuredSuffix: suffix, publicOrigin: `https://${suffix}`, port: 443 },
        certificateChain: fixture.certificateChain,
        privateKey: fixture.privateKey,
        factories,
      }),
    ).rejects.toThrow("synthetic SNI failure");
    expect(binds).toBe(1);
    expect(stops).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test("listener requires a matching wildcard SAN and certificate key before binding", async () => {
  const wrongHost = await certificateFixture("DNS:one.example.test");
  const otherKey = await certificateFixture();
  let binds = 0;
  const factories = {
    serve() {
      binds++;
      return { port: 443, stop() {} };
    },
    async proveSni() {},
  };
  try {
    await expect(
      createSelfhostContainerEndpointHttpsListener({
        configuration: { configuredSuffix: suffix, publicOrigin: `https://${suffix}`, port: 443 },
        certificateChain: wrongHost.certificateChain,
        privateKey: wrongHost.privateKey,
        factories,
      }),
    ).rejects.toThrow("must cover the one-label Endpoint hostname wildcard");
    await expect(
      createSelfhostContainerEndpointHttpsListener({
        configuration: { configuredSuffix: suffix, publicOrigin: `https://${suffix}`, port: 443 },
        certificateChain: otherKey.certificateChain,
        privateKey: wrongHost.privateKey,
        factories,
      }),
    ).rejects.toThrow("certificate and private key do not match");
    expect(binds).toBe(0);
  } finally {
    await wrongHost.cleanup();
    await otherKey.cleanup();
  }
});

test("a non-443 binding is stopped before any ingress capability can be minted", async () => {
  const fixture = await certificateFixture();
  let stopCalls = 0;
  let proofCalls = 0;
  try {
    await expect(
      createSelfhostContainerEndpointHttpsListener({
        configuration: { configuredSuffix: suffix, publicOrigin: `https://${suffix}`, port: 443 },
        certificateChain: fixture.certificateChain,
        privateKey: fixture.privateKey,
        factories: {
          serve() {
            return {
              port: 444,
              stop() {
                stopCalls++;
              },
            };
          },
          async proveSni() {
            proofCalls++;
          },
        },
      }),
    ).rejects.toThrow("did not bind the required TCP port 443");
    expect(stopCalls).toBe(1);
    expect(proofCalls).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test("ephemeral local TLS SNI proof is real but does not mint fixed-443 capability", async () => {
  const fixture = await certificateFixture();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: fixture.certificateChain, key: fixture.privateKey },
    fetch: () => new Response(null, { status: 204 }),
  });
  try {
    const port = server.port;
    if (port === undefined) throw new Error("Bun did not bind the ephemeral TLS fixture");
    const proof = await verifySelfhostContainerEndpointHttpsHandshake({
      host: "127.0.0.1",
      port,
      suffix,
      certificateChain: fixture.certificateChain,
    });
    expect(proof).toBeUndefined();
    expect((await Bun.file(fixture.privateKeyPath).stat()).mode & 0o777).toBe(0o600);
  } finally {
    await server.stop(true);
    await fixture.cleanup();
  }
});
