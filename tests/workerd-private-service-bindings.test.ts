import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkerdRuntime,
  readWorkerdSelectedActiveVersion,
  type WorkerdDeploymentPublication,
  type WorkerdDeploymentVariant,
  type WorkerdSelectedVersionIdentity,
  type WorkerdServiceBinding,
  type WorkerdSite,
  writeWorkerdPrivateExecution,
} from "../src/workerd-runtime.ts";

const encoder = new TextEncoder();
const HOST_ENTRYPOINT = "__takoserver-host.js";
const SERVICE_NAME = "__TAKOSERVER_SELFHOST_SERVICE_00001";
const SECOND_SERVICE_NAME = "__TAKOSERVER_SELFHOST_SERVICE_00002";
const SERVICE_TOKEN = "a".repeat(64);
const TARGET_UID = "uid-ModuleWorker-target";
const CALLER_UID = "uid-ModuleWorker-caller";

const SERVICE_BINDING: WorkerdServiceBinding = {
  name: SERVICE_NAME,
  target: "target",
  targetResourceUid: TARGET_UID,
  unavailableToken: SERVICE_TOKEN,
};

const SECOND_SERVICE_BINDING: WorkerdServiceBinding = {
  ...SERVICE_BINDING,
  name: SECOND_SERVICE_NAME,
  unavailableToken: "b".repeat(64),
};

let runtimeRoot: string;
let socketDirectory: string;
let temporaryRoots: string[];

interface ConfigProbe {
  readonly port: number;
  readonly onReload: (configPath: string) => Promise<void>;
  readonly removeUnixBind: (socketPath: string) => Promise<void>;
  readonly deferUnixBind: (socketPath: string) => {
    readonly bound: Promise<void>;
    readonly release: () => void;
  };
  readonly stop: () => void;
  readonly reloadCount: () => number;
  behavior?: (
    config: string,
    socketPaths: readonly string[],
    invocation: number,
  ) => void | Promise<void>;
}

let configProbes: ConfigProbe[];

beforeEach(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "tss-runtime-"));
  socketDirectory = mkdtempSync(join(tmpdir(), "tss-"));
  chmodSync(socketDirectory, 0o700);
  temporaryRoots = [];
  configProbes = [];
});

afterEach(() => {
  for (const probe of configProbes) probe.stop();
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(socketDirectory, { recursive: true, force: true });
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

interface PublicationOptions {
  readonly generation?: string;
  readonly workerResourceUid?: string;
  readonly serviceBindings?: readonly WorkerdServiceBinding[];
  readonly versionId?: string;
  readonly workerVersionUid?: string;
}

function publication(name: string, options: PublicationOptions = {}): WorkerdDeploymentPublication {
  const generation = options.generation ?? `${name}-generation-1`;
  const workerResourceUid = options.workerResourceUid ?? `uid-ModuleWorker-${name}`;
  const versionId = options.versionId ?? `${name}-v1`;
  const workerVersionUid = options.workerVersionUid ?? `uid-WorkerVersion-${name}-1`;
  const site: WorkerdSite = {
    directory: name,
    mainModule: "index.js",
    hostEntrypoint: HOST_ENTRYPOINT,
    hostnames: [],
    generation,
    workerResourceUid,
    fetchHandler: true,
    ...(options.serviceBindings === undefined ? {} : { serviceBindings: options.serviceBindings }),
  };
  const variant: WorkerdDeploymentVariant = {
    versionId,
    workerVersionUid,
    weight: 10_000,
    site,
    modules: new Map([
      [
        "index.js",
        encoder.encode(
          `export default { fetch() { return new Response(${JSON.stringify(name)}); } };`,
        ),
      ],
    ]),
    hostModules: new Map([
      [HOST_ENTRYPOINT, encoder.encode('export { default } from "./index.js";')],
    ]),
  };
  return {
    generation,
    workerResourceUid,
    hostnames: [`${name}.localhost`],
    versions: [variant],
  };
}

function newTemporaryRoot(prefix = "tss-exec-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function privateSocketPaths(config: string): readonly string[] {
  const paths: string[] = [];
  for (const match of config.matchAll(/address = "unix:([^"]+)"/gu)) {
    const path = match[1];
    if (path !== undefined && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function createConfigProbe(): ConfigProbe {
  let serving: { readonly identity: string; readonly token: string } | null = null;
  let invocation = 0;
  let unixServers: Array<{
    readonly path: string;
    readonly server: ReturnType<typeof Bun.serve>;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (
        serving !== null &&
        request.method === "POST" &&
        request.headers.get("host") === "runtime.selfhost-config.invalid" &&
        url.pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
        request.headers.get("x-takoserver-selfhost-runtime-config") === serving.token
      ) {
        return new Response(null, {
          status: 204,
          headers: {
            "x-takoserver-selfhost-config-identity": serving.identity,
          },
        });
      }
      return new Response("probe", { status: 200 });
    },
  });
  if (server.port === undefined) throw new Error("config probe did not bind a port");
  const probe: ConfigProbe = {
    port: server.port,
    async onReload(configPath) {
      const config = await readFile(configPath, "utf8");
      const identity = /\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      const token = /\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      if (!identity || !token) throw new Error("invalid config probe declaration");

      const socketPaths = privateSocketPaths(config);
      for (const unixServer of unixServers) unixServer.server.stop(true);
      unixServers = [];
      for (const socketPath of socketPaths) {
        unixServers.push({
          path: socketPath,
          server: Bun.serve({
            unix: socketPath,
            fetch() {
              return new Response(null, { status: 404 });
            },
          }),
        });
      }
      serving = { identity, token };
      invocation += 1;
      await probe.behavior?.(config, socketPaths, invocation);
    },
    async removeUnixBind(socketPath) {
      const remaining: typeof unixServers = [];
      for (const unixServer of unixServers) {
        if (unixServer.path === socketPath) unixServer.server.stop(true);
        else remaining.push(unixServer);
      }
      unixServers = remaining;
      await unlink(socketPath).catch((error) => {
        if ((error as { readonly code?: unknown }).code !== "ENOENT") throw error;
      });
    },
    deferUnixBind(socketPath) {
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const bound = gate.then(() => {
        unixServers.push({
          path: socketPath,
          server: Bun.serve({
            unix: socketPath,
            fetch() {
              return new Response(null, { status: 404 });
            },
          }),
        });
      });
      return {
        bound,
        release: releaseGate,
      };
    },
    stop() {
      server.stop(true);
      for (const unixServer of unixServers) unixServer.server.stop(true);
      unixServers = [];
    },
    reloadCount: () => invocation,
  };
  return probe;
}

function runtimeWithPrivateSockets(
  options: {
    readonly isReady?: () => boolean;
    readonly captureProbe?: (probe: ConfigProbe) => void;
  } = {},
) {
  const probe = createConfigProbe();
  configProbes.push(probe);
  options.captureProbe?.(probe);
  return createWorkerdRuntime({
    root: runtimeRoot,
    isReady: options.isReady ?? (() => true),
    serviceBindingSocketDirectory: socketDirectory,
    port: probe.port,
    onReload: probe.onReload,
  });
}

async function publish(
  runtime: ReturnType<typeof createWorkerdRuntime>,
  name: string,
  value: WorkerdDeploymentPublication | null,
): Promise<void> {
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  await runtime.publish(name, value);
}

async function selectedIdentity(
  script: string,
  workerResourceUid: string,
): Promise<WorkerdSelectedVersionIdentity> {
  const selected = await readWorkerdSelectedActiveVersion(runtimeRoot, script, {
    expectedWorkerResourceUid: workerResourceUid,
    basisPoint: 0,
  });
  if (!selected) throw new Error("active version was not selected");
  return {
    script,
    generation: selected.generation,
    generationKey: selected.generationKey,
    workerResourceUid: selected.workerResourceUid,
    versionId: selected.versionId,
    workerVersionUid: selected.workerVersionUid,
  };
}

async function runtimeConfig(): Promise<string> {
  return await readFile(join(runtimeRoot, "workers", "workerd.capnp"), "utf8");
}

function privateSocketPath(binding: WorkerdServiceBinding): string {
  const digest = createHash("sha256")
    .update("takoserver.selfhost-service-router@v1\u0000", "utf8")
    .update(binding.target, "utf8")
    .update("\u0000", "utf8")
    .update(binding.targetResourceUid, "utf8")
    .update("\u0000", "utf8")
    .update(binding.unavailableToken, "utf8")
    .digest("hex");
  return join(socketDirectory, `${digest}.sock`);
}

function writerSite(
  serviceBindings: readonly WorkerdServiceBinding[] = [SERVICE_BINDING],
): WorkerdSite {
  return {
    directory: "workflow",
    mainModule: "index.js",
    hostEntrypoint: "__workflow-host.js",
    hostModules: [],
    hostnames: ["public.example.invalid"],
    generation: "workflow-generation-1",
    workerResourceUid: "uid-ModuleWorker-workflow",
    fetchHandler: true,
    serviceBindings,
    assets: {
      notFoundHandling: "none",
      runWorkerFirst: false,
      mediaTypes: { "index.html": "text/html" },
    },
    events: {
      module: "__events.js",
      vars: [],
    },
  };
}

function writerModules(): {
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly hostModules: ReadonlyMap<string, Uint8Array>;
} {
  return {
    modules: new Map([["index.js", encoder.encode("export default {};")]]),
    hostModules: new Map([
      ["__workflow-host.js", encoder.encode('export { default } from "./index.js";')],
    ]),
  };
}

function writerOptions(
  root: string,
  site: WorkerdSite,
  serviceBindings: readonly { readonly name: string; readonly socketPath: string }[],
) {
  const modules = writerModules();
  return {
    root,
    site,
    ...modules,
    companionAddress: "127.0.0.1:4666",
    runSocketPath: join(root, "workflow.sock"),
    serviceBindings,
  };
}

test("does not expose private service routers by default", async () => {
  const runtime = createWorkerdRuntime({ root: runtimeRoot, isReady: () => true });
  await publish(runtime, "plain", publication("plain"));
  const config = await runtimeConfig();

  expect(config).not.toContain("selfhost-service-");
  expect(config).not.toContain("unix:");
});

test("without a private socket option, the existing serving service graph remains unchanged", async () => {
  const runtime = createWorkerdRuntime({ root: runtimeRoot, isReady: () => true });
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const config = await runtimeConfig();

  expect(config).toContain(SERVICE_NAME);
  expect(config).toMatch(/selfhost-service-[0-9a-f]{64}/u);
  expect(config).not.toContain("unix:");
});

test("validates private socket directory shape before rendering", async () => {
  expect(() =>
    createWorkerdRuntime({ root: runtimeRoot, serviceBindingSocketDirectory: "relative" }),
  ).toThrow("unusable private service socket directory");

  const tooLong = join(tmpdir(), `tss-${"x".repeat(90)}`);
  expect(() =>
    createWorkerdRuntime({ root: runtimeRoot, serviceBindingSocketDirectory: tooLong }),
  ).toThrow("unusable private service socket directory");

  const shortRoot = newTemporaryRoot("r-");
  expect(() =>
    createWorkerdRuntime({
      root: shortRoot,
      serviceBindingSocketDirectory: join(shortRoot, "nested"),
    }),
  ).toThrow("outside the runtime root");

  const missing = join(newTemporaryRoot("m-"), "missing");
  const missingRuntime = createWorkerdRuntime({
    root: runtimeRoot,
    serviceBindingSocketDirectory: missing,
  });
  await expect(missingRuntime.reload()).rejects.toThrow();

  chmodSync(socketDirectory, 0o755);
  const modeRuntime = createWorkerdRuntime({
    root: runtimeRoot,
    serviceBindingSocketDirectory: socketDirectory,
  });
  await expect(modeRuntime.reload()).rejects.toThrow();

  const linked = join(newTemporaryRoot("ln-"), "l");
  symlinkSync(socketDirectory, linked);
  const linkedRuntime = createWorkerdRuntime({
    root: runtimeRoot,
    serviceBindingSocketDirectory: linked,
  });
  await expect(linkedRuntime.reload()).rejects.toThrow();
});

test("acquisition returns private sockets without reloading the serving config", async () => {
  const runtime = runtimeWithPrivateSockets();
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const before = await runtimeConfig();
  const identity = await selectedIdentity("caller", CALLER_UID);

  const lease = await runtime.acquirePrivateServiceBindings(identity);
  const after = await runtimeConfig();
  expect(after).toBe(before);
  expect(lease.services).toHaveLength(1);
  const [service] = lease.services;
  if (!service) throw new Error("private service was not returned");
  expect(service.name).toBe(SERVICE_NAME);
  expect(service.unavailableToken).toBe(SERVICE_TOKEN);
  expect(service.upstreamSocket.startsWith(`${socketDirectory}/`)).toBe(true);
  expect(service.upstreamSocket.startsWith("unix:")).toBe(false);
  const socketName = service.upstreamSocket.slice(socketDirectory.length + 1);
  expect(socketName).toMatch(/^[0-9a-f]{64}\.sock$/u);
  expect(Buffer.byteLength(service.upstreamSocket)).toBeLessThanOrEqual(100);
  await lease.release();
});

test("aborted acquisition settles behind a held activation and cannot create late pins", async () => {
  let probe!: ConfigProbe;
  const runtime = runtimeWithPrivateSockets({
    captureProbe: (value) => {
      probe = value;
    },
  });
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const identity = await selectedIdentity("caller", CALLER_UID);
  let releaseReload!: () => void;
  let enteredReload!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredReload = resolve;
  });
  probe.behavior = async () => {
    enteredReload();
    await held;
  };
  const reloading = runtime.reload();
  await entered;
  const abort = new AbortController();
  const reason = new Error("cancel queued acquisition");
  const pending = runtime.acquirePrivateServiceBindings(identity, abort.signal);
  const settled = pending.then(
    (lease) => lease,
    (error: unknown) => error,
  );
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    abort.abort(reason);
    const bounded = new Promise<symbol>((resolve) => {
      timeout = setTimeout(() => resolve(Symbol("acquisition still queued")), 1_000);
    });
    // The activation lock is deliberately still held at this assertion.
    expect(await Promise.race([settled, bounded])).toBe(reason);
  } finally {
    clearTimeout(timeout);
    releaseReload();
    delete probe.behavior;
    await reloading;
    const result = await settled;
    if (typeof result === "object" && result !== null && "release" in result) {
      await (result as { release(): Promise<void> }).release();
    }
  }
  // This mutation queues after the abandoned read. Its continued execution
  // must see the aborted signal before pinning an otherwise retired router.
  await publish(runtime, "caller", null);
  expect(await runtimeConfig()).not.toContain(SERVICE_TOKEN);
});

test("repeated reload closes and rebinds each private Unix socket", async () => {
  let probe: ConfigProbe | undefined;
  const runtime = runtimeWithPrivateSockets({
    captureProbe: (captured) => {
      probe = captured;
    },
  });
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const socketPath = privateSocketPath(SERVICE_BINDING);
  const initial = await lstat(socketPath);
  expect(initial.isSocket()).toBe(true);
  if (!probe) throw new Error("config probe was not captured");
  const beforeReload = probe.reloadCount();

  await runtime.reload();

  expect(probe.reloadCount()).toBe(beforeReload + 1);
  const rebound = await lstat(socketPath);
  expect(rebound.isSocket()).toBe(true);
});

test("refuses a nonempty private socket directory without touching its contents", async () => {
  const sentinelPath = join(socketDirectory, "sentinel");
  await writeFile(sentinelPath, "keep");
  const before = await lstat(sentinelPath);
  const runtime = runtimeWithPrivateSockets();

  await expect(runtime.reload()).rejects.toThrow();

  const after = await lstat(sentinelPath);
  expect(after.isFile()).toBe(true);
  expect(after.dev).toBe(before.dev);
  expect(after.ino).toBe(before.ino);
  expect(await readFile(sentinelPath, "utf8")).toBe("keep");
});

test("rejects a preexisting new socket path before deleting the old owned socket", async () => {
  const newBinding = SECOND_SERVICE_BINDING;
  let probe: ConfigProbe | undefined;
  const runtime = runtimeWithPrivateSockets({
    captureProbe: (captured) => {
      probe = captured;
    },
  });
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const oldPath = privateSocketPath(SERVICE_BINDING);
  const oldBefore = await lstat(oldPath);
  expect(oldBefore.isSocket()).toBe(true);
  const newPath = privateSocketPath(newBinding);
  expect(newPath).not.toBe(oldPath);
  await writeFile(newPath, "occupied");
  if (!probe) throw new Error("config probe was not captured");
  const beforeReload = probe.reloadCount();

  await expect(
    publish(
      runtime,
      "caller",
      publication("caller", {
        generation: "caller-generation-2",
        workerResourceUid: CALLER_UID,
        serviceBindings: [SERVICE_BINDING, newBinding],
      }),
    ),
  ).rejects.toThrow();

  const oldAfter = await lstat(oldPath);
  expect(oldAfter.isSocket()).toBe(true);
  expect(oldAfter.dev).toBe(oldBefore.dev);
  expect(oldAfter.ino).toBe(oldBefore.ino);
  const newAfter = await lstat(newPath);
  expect(newAfter.isFile()).toBe(true);
  expect(await readFile(newPath, "utf8")).toBe("occupied");
  expect(probe.reloadCount()).toBe(beforeReload);
});

test("never unlinks a replacement at an owned socket path", async () => {
  const runtime = runtimeWithPrivateSockets();
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const socketPath = privateSocketPath(SERVICE_BINDING);
  const old = await lstat(socketPath);
  expect(old.isSocket()).toBe(true);
  await unlink(socketPath);
  await writeFile(socketPath, "replacement");
  const replacementBefore = await lstat(socketPath);

  await expect(
    publish(
      runtime,
      "caller",
      publication("caller", {
        generation: "caller-generation-2",
        workerResourceUid: CALLER_UID,
        serviceBindings: [SERVICE_BINDING],
      }),
    ),
  ).rejects.toThrow();

  const replacementAfter = await lstat(socketPath);
  expect(replacementAfter.isFile()).toBe(true);
  expect(replacementAfter.dev).toBe(replacementBefore.dev);
  expect(replacementAfter.ino).toBe(replacementBefore.ino);
  expect(await readFile(socketPath, "utf8")).toBe("replacement");
});

test("fails closed when a forward hook fails post-bind and does not sweep late sockets", async () => {
  let probe: ConfigProbe | undefined;
  const runtime = runtimeWithPrivateSockets({
    captureProbe: (captured) => {
      probe = captured;
    },
  });
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  if (!probe) throw new Error("config probe was not captured");
  const identity = await selectedIdentity("caller", CALLER_UID);
  const pointerPath = join(runtimeRoot, "workers", "caller", "takoserver-site.json");
  const pointerBefore = await readFile(pointerPath, "utf8");
  const latePath = privateSocketPath(SECOND_SERVICE_BINDING);
  let lateBind:
    | {
        readonly bound: Promise<void>;
        readonly release: () => void;
      }
    | undefined;
  let failNext = true;
  probe.behavior = async () => {
    if (failNext) {
      failNext = false;
      await probe?.removeUnixBind(latePath);
      lateBind = probe?.deferUnixBind(latePath);
      throw new Error("forward hook failure");
    }
  };

  await expect(
    publish(
      runtime,
      "caller",
      publication("caller", {
        generation: "caller-generation-2",
        workerResourceUid: CALLER_UID,
        serviceBindings: [SERVICE_BINDING, SECOND_SERVICE_BINDING],
      }),
    ),
  ).rejects.toThrow("forward hook failure");

  if (!lateBind) throw new Error("late socket bind was not scheduled");
  lateBind.release();
  await lateBind.bound;
  expect((await lstat(latePath)).isSocket()).toBe(true);
  expect(await readFile(pointerPath, "utf8")).toBe(pointerBefore);
  const activation = JSON.parse(
    await readFile(join(runtimeRoot, "workers", ".takoserver-active.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(activation).toEqual({});
  expect(probe.reloadCount()).toBe(3);
  await expect(runtime.acquirePrivateServiceBindings(identity)).rejects.toThrow();
  await expect(runtime.reload()).rejects.toThrow();
  expect(probe.reloadCount()).toBe(3);
});

test("returns null when an ordinary probe response completes after uncertainty", async () => {
  let probe: ConfigProbe | undefined;
  const runtime = runtimeWithPrivateSockets({
    captureProbe: (captured) => {
      probe = captured;
    },
  });
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  if (!probe || !runtime.probe) throw new Error("config probe was not captured");
  // Unit-control the body-read completion, not the shared server's transport.
  // Real request/stream behavior is qualified by the pinned native fixture.
  const bodyRead = Promise.withResolvers<void>();
  const body = Promise.withResolvers<string>();
  const response = new Response("probe");
  const text = spyOn(response, "text").mockImplementation(() => {
    bodyRead.resolve();
    return body.promise;
  });
  const originalFetch = globalThis.fetch;
  const probePort = String(probe.port);
  const interceptedFetch = Object.assign(
    (input: Parameters<typeof originalFetch>[0], init?: Parameters<typeof originalFetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.origin === `http://127.0.0.1:${probePort}` &&
        url.pathname === "/probe" &&
        init?.method === "GET" &&
        new Headers(init.headers).get("host") === "caller.selfhost-internal.invalid"
      ) {
        return Promise.resolve(response);
      }
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(interceptedFetch);
  try {
    const pendingProbe = runtime.probe("caller", "/probe", { method: "GET", headers: {} });
    await Promise.race([
      bodyRead.promise,
      pendingProbe.then(() => {
        throw new Error("probe completed before its body read");
      }),
    ]);
    probe.behavior = () => {
      throw new Error("forward hook failure");
    };
    await expect(runtime.reload()).rejects.toThrow("forward hook failure");
    body.resolve("probe");
    await expect(pendingProbe).resolves.toBeNull();
  } finally {
    body.resolve("probe");
    fetchMock.mockRestore();
    text.mockRestore();
  }
});

test("refuses a reload when an expected owned socket has the wrong type", async () => {
  const runtime = runtimeWithPrivateSockets();
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const socketPath = privateSocketPath(SERVICE_BINDING);
  await unlink(socketPath);
  await writeFile(socketPath, "wrong-type");

  await expect(runtime.reload()).rejects.toThrow();
});

test(
  "refuses activation when a bound expected socket disappears before proof",
  async () => {
    let probe: ConfigProbe | undefined;
    const runtime = runtimeWithPrivateSockets({
      captureProbe: (captured) => {
        probe = captured;
      },
    });
    await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
    await publish(
      runtime,
      "caller",
      publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
    );
    if (!probe) throw new Error("config probe was not captured");
    const socketPath = privateSocketPath(SERVICE_BINDING);
    const pointerPath = join(runtimeRoot, "workers", "caller", "takoserver-site.json");
    const pointerBefore = await readFile(pointerPath, "utf8");
    let removeNext = true;
    probe.behavior = async () => {
      if (!removeNext) return;
      removeNext = false;
      await probe?.removeUnixBind(socketPath);
    };

    await expect(runtime.reload()).rejects.toThrow();

    const activation = JSON.parse(
      await readFile(join(runtimeRoot, "workers", ".takoserver-active.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(activation).toEqual({});
    expect(await readFile(pointerPath, "utf8")).toBe(pointerBefore);
    expect(probe.reloadCount()).toBe(3);
  },
  { timeout: 10_000 },
);

test("rejects every stale caller identity component", async () => {
  const runtime = runtimeWithPrivateSockets();
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const identity = await selectedIdentity("caller", CALLER_UID);

  const stale: readonly [keyof WorkerdSelectedVersionIdentity, string][] = [
    ["script", "other"],
    ["generation", "caller-stale-generation"],
    ["generationKey", "f".repeat(64)],
    ["versionId", "caller-stale-version"],
    ["workerVersionUid", "uid-WorkerVersion-caller-stale"],
    ["workerResourceUid", "uid-ModuleWorker-caller-stale"],
  ];
  for (const [field, value] of stale) {
    await expect(
      runtime.acquirePrivateServiceBindings({ ...identity, [field]: value }),
    ).rejects.toThrow();
  }
});

test("pins a caller binding through deletion and prunes it after the final release and reload", async () => {
  const runtime = runtimeWithPrivateSockets();
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const identity = await selectedIdentity("caller", CALLER_UID);
  const firstLease = await runtime.acquirePrivateServiceBindings(identity);
  const secondLease = await runtime.acquirePrivateServiceBindings(identity);
  const retainedSocket = firstLease.services[0]?.upstreamSocket;
  if (!retainedSocket) throw new Error("private service was not returned");

  await publish(runtime, "caller", null);
  const retained = await runtimeConfig();
  expect(retained).toContain(retainedSocket);
  expect(retained).toContain(SERVICE_TOKEN);

  await firstLease.release();
  await firstLease.release();
  await runtime.reload();
  const stillPinned = await runtimeConfig();
  expect(stillPinned).toContain(retainedSocket);
  expect(stillPinned).toContain(SERVICE_TOKEN);

  await secondLease.release();
  await runtime.reload();
  const pruned = await runtimeConfig();
  expect(pruned).not.toContain(retainedSocket);
  expect(pruned).not.toContain(SERVICE_TOKEN);
});

test("omits TARGET when the target is deleted or replaced by a new Resource UID", async () => {
  const runtime = runtimeWithPrivateSockets();
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const active = await runtimeConfig();
  expect(active).toContain('(name = "TARGET", service = "target-selfhost-deployment")');

  await publish(runtime, "target", null);
  const deleted = await runtimeConfig();
  expect(deleted).not.toContain('(name = "TARGET", service = "target-selfhost-deployment")');

  await publish(
    runtime,
    "target",
    publication("target", {
      generation: "target-generation-2",
      workerResourceUid: "uid-ModuleWorker-target-new",
    }),
  );
  const replaced = await runtimeConfig();
  expect(replaced).not.toContain('(name = "TARGET", service = "target-selfhost-deployment")');
});

test("writes only exact private service mappings and no public ingress services", async () => {
  const root = newTemporaryRoot();
  const socketPath = join(root, "s0.sock");
  const configPath = await writeWorkerdPrivateExecution(
    writerOptions(root, writerSite(), [{ name: SERVICE_NAME, socketPath }]),
  );
  const config = await readFile(configPath, "utf8");

  expect(config).toContain(SERVICE_NAME);
  expect(config).toContain(`unix:${socketPath}`);
  expect(config).not.toContain('name = "router"');
  expect(config).not.toContain("ROUTES");
  expect(config).not.toContain("asset-router");
  expect(config).not.toContain("event-dispatcher");
  expect(config).not.toContain("event-dispatcher.js");
});

test("rejects missing, extra, duplicate, escaping, and colliding private mappings", async () => {
  const invalidCases: readonly ((root: string) => {
    readonly site: WorkerdSite;
    readonly mappings: readonly { readonly name: string; readonly socketPath: string }[];
  })[] = [
    () => ({
      site: writerSite(),
      mappings: [],
    }),
    (root) => ({
      site: writerSite(),
      mappings: [
        {
          name: SECOND_SERVICE_NAME,
          socketPath: join(root, "s1.sock"),
        },
      ],
    }),
    (root) => ({
      site: writerSite([SERVICE_BINDING, SECOND_SERVICE_BINDING]),
      mappings: [
        {
          name: SERVICE_NAME,
          socketPath: join(root, "s2.sock"),
        },
        {
          name: SERVICE_NAME,
          socketPath: join(root, "s3.sock"),
        },
      ],
    }),
    () => ({
      site: writerSite(),
      mappings: [
        {
          name: SERVICE_NAME,
          socketPath: join(tmpdir(), "s4.sock"),
        },
      ],
    }),
  ];
  for (const makeInvalid of invalidCases) {
    const root = newTemporaryRoot();
    const invalid = makeInvalid(root);
    await expect(
      writeWorkerdPrivateExecution(writerOptions(root, invalid.site, invalid.mappings)),
    ).rejects.toThrow();
  }

  const collisionRoot = newTemporaryRoot();
  const collisionSocket = join(collisionRoot, "s5.sock");
  await expect(
    writeWorkerdPrivateExecution(
      writerOptions(collisionRoot, writerSite([SERVICE_BINDING, SECOND_SERVICE_BINDING]), [
        { name: SERVICE_NAME, socketPath: collisionSocket },
        { name: SECOND_SERVICE_NAME, socketPath: collisionSocket },
      ]),
    ),
  ).rejects.toThrow();

  const runSocketCollisionRoot = newTemporaryRoot();
  await expect(
    writeWorkerdPrivateExecution(
      writerOptions(runSocketCollisionRoot, writerSite(), [
        { name: SERVICE_NAME, socketPath: join(runSocketCollisionRoot, "workflow.sock") },
      ]),
    ),
  ).rejects.toThrow();

  const relativeRoot = newTemporaryRoot();
  await expect(
    writeWorkerdPrivateExecution(
      writerOptions(relativeRoot, writerSite(), [{ name: SERVICE_NAME, socketPath: "s6.sock" }]),
    ),
  ).rejects.toThrow();

  const variableCollisionRoot = newTemporaryRoot();
  const variableCollisionSite: WorkerdSite = {
    ...writerSite(),
    vars: [{ name: SERVICE_NAME, value: "collision", kind: "text" }],
  };
  await expect(
    writeWorkerdPrivateExecution(
      writerOptions(variableCollisionRoot, variableCollisionSite, [
        {
          name: SERVICE_NAME,
          socketPath: join(variableCollisionRoot, "s7.sock"),
        },
      ]),
    ),
  ).rejects.toThrow();
});

test("refuses legacy write and remove with private sockets before touching the publication", async () => {
  const runtime = runtimeWithPrivateSockets();
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const pointerPath = join(runtimeRoot, "workers", "caller", "takoserver-site.json");
  const pointerBefore = await readFile(pointerPath, "utf8");
  const configBefore = await runtimeConfig();
  const modules = writerModules();

  await expect(
    runtime.write("caller", writerSite(), modules.modules, undefined, modules.hostModules),
  ).rejects.toThrow("private service runtime requires immutable weighted publication");
  await expect(runtime.remove("caller")).rejects.toThrow(
    "private service runtime requires immutable weighted publication",
  );

  expect(await readFile(pointerPath, "utf8")).toBe(pointerBefore);
  expect(await runtimeConfig()).toBe(configBefore);
});

test("refuses acquisition when private socket configuration is absent", async () => {
  const runtime = createWorkerdRuntime({ root: runtimeRoot, isReady: () => true });
  await publish(runtime, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    runtime,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const identity = await selectedIdentity("caller", CALLER_UID);
  await expect(runtime.acquirePrivateServiceBindings(identity)).rejects.toThrow();

  const stagedOnly = createWorkerdRuntime({
    root: runtimeRoot,
    isReady: () => true,
    serviceBindingSocketDirectory: socketDirectory,
  });
  await publish(stagedOnly, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    stagedOnly,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const stagedIdentity = await selectedIdentity("caller", CALLER_UID);
  await expect(stagedOnly.acquirePrivateServiceBindings(stagedIdentity)).rejects.toThrow();
});

test("refuses acquisition when readiness is false or a fresh runtime has not restored", async () => {
  let ready = true;
  const serving = runtimeWithPrivateSockets({ isReady: () => ready });
  await publish(serving, "target", publication("target", { workerResourceUid: TARGET_UID }));
  await publish(
    serving,
    "caller",
    publication("caller", { workerResourceUid: CALLER_UID, serviceBindings: [SERVICE_BINDING] }),
  );
  const identity = await selectedIdentity("caller", CALLER_UID);

  ready = false;
  await expect(serving.acquirePrivateServiceBindings(identity)).rejects.toThrow();

  const fresh = runtimeWithPrivateSockets();
  await expect(fresh.acquirePrivateServiceBindings(identity)).rejects.toThrow();
});
