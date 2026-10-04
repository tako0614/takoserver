import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerHttpRevisionOptions } from "../src/providers/docker-http-revision.ts";
import type { SelfhostContainerIdentity } from "../src/providers/selfhost-container-runtime.ts";
import {
  createSelfhostContainerBootstrap,
  createSelfhostContainerSignalHandler,
  parseSelfhostContainerBootstrapConfiguration,
  SELFHOST_CONTAINER_CAPACITY_PROFILE,
  SELFHOST_CONTAINER_ENVIRONMENT,
  type SelfhostContainerBootstrapFactories,
  type SelfhostContainerRuntimeHandle,
} from "../src/selfhost-container-bootstrap.ts";

const dockerEnvironment = {
  [SELFHOST_CONTAINER_ENVIRONMENT.dockerSocket]: "/var/run/docker.sock",
  [SELFHOST_CONTAINER_ENVIRONMENT.network]: "takoserver-selfhost-internal",
};

test("unconfigured signal shutdown still stops workerd and exits", async () => {
  const calls: string[] = [];
  const handleSignal = createSelfhostContainerSignalHandler(
    undefined,
    () => calls.push("close-error"),
    () => calls.push("stop-workerd"),
    () => calls.push("exit"),
  );

  await handleSignal();

  expect(calls).toEqual(["stop-workerd", "exit"]);
});

test("configured signal shutdown closes before stopping workerd and exits on close failure", async () => {
  const calls: string[] = [];
  const handleSignal = createSelfhostContainerSignalHandler(
    {
      async close() {
        calls.push("close-container");
        throw new Error("close failed");
      },
    },
    () => calls.push("close-error"),
    () => calls.push("stop-workerd"),
    () => calls.push("exit"),
  );

  await handleSignal();

  expect(calls).toEqual(["close-container", "close-error", "stop-workerd", "exit"]);
});

test("a throwing close-failure reporter does not skip awaited Workerd shutdown", async () => {
  const calls: string[] = [];
  const handleSignal = createSelfhostContainerSignalHandler(
    {
      async close() {
        calls.push("close-container");
        throw new Error("private close failure");
      },
    },
    () => {
      calls.push("report-close-failure");
      throw new Error("private reporter failure");
    },
    async () => {
      calls.push("stop-workerd");
    },
    () => calls.push("exit"),
  );

  await handleSignal();
  expect(calls).toEqual(["close-container", "report-close-failure", "stop-workerd", "exit"]);
});

test("signal shutdown awaits asynchronous workerd stop before exiting", async () => {
  const calls: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const workerdStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handleSignal = createSelfhostContainerSignalHandler(
    {
      async close() {
        calls.push("close-container");
      },
    },
    () => calls.push("close-error"),
    async () => {
      calls.push("workerd-shutdown");
      started();
      await stopped;
      calls.push("actor-close");
      calls.push("data-plane-close");
      calls.push("control-database-close");
    },
    () => calls.push("exit"),
  );

  const shuttingDown = handleSignal();
  await workerdStarted;
  expect(calls).toEqual(["close-container", "workerd-shutdown"]);
  release();
  await shuttingDown;
  expect(calls).toEqual([
    "close-container",
    "workerd-shutdown",
    "actor-close",
    "data-plane-close",
    "control-database-close",
    "exit",
  ]);
});

test("signal shutdown does not report success when asynchronous workerd stop fails", async () => {
  const calls: string[] = [];
  const handleSignal = createSelfhostContainerSignalHandler(
    undefined,
    () => calls.push("close-error"),
    async () => {
      calls.push("stop-workerd");
      throw new Error("child exit was not proved");
    },
    () => calls.push("exit"),
  );

  await expect(handleSignal()).rejects.toThrow("child exit was not proved");
  expect(calls).toEqual(["stop-workerd"]);
});

test("container bootstrap is absent without explicit Docker opt-in", () => {
  const configuration = parseSelfhostContainerBootstrapConfiguration({
    DOCKER_HOST: "unix:///var/run/docker.sock",
  });
  expect(configuration).toBeUndefined();

  let factoryCalls = 0;
  const factories = {
    createDockerRuntime() {
      factoryCalls++;
      throw new Error("must not construct Docker runtime");
    },
    createSelfhostRuntime() {
      factoryCalls++;
      throw new Error("must not create local runtime state");
    },
  } as unknown as SelfhostContainerBootstrapFactories;
  expect(
    createSelfhostContainerBootstrap({
      environment: { DOCKER_HOST: "unix:///var/run/docker.sock" },
      dataRoot: "/tmp/takoserver-test-data",
      providerMode: "stable-selfhost",
      factories,
    }),
  ).toBeUndefined();
  expect(factoryCalls).toBe(0);
});

test("container bootstrap rejects partial and unsafe config before factories", () => {
  const partial = {
    [SELFHOST_CONTAINER_ENVIRONMENT.dockerSocket]: "/var/run/docker.sock",
  };
  expect(() => parseSelfhostContainerBootstrapConfiguration(partial)).toThrow(
    "must be configured together",
  );
  expect(() =>
    parseSelfhostContainerBootstrapConfiguration({
      ...dockerEnvironment,
      [SELFHOST_CONTAINER_ENVIRONMENT.dockerSocket]: "relative/docker.sock",
    }),
  ).toThrow("absolute Unix socket path");
  expect(() =>
    parseSelfhostContainerBootstrapConfiguration({
      ...dockerEnvironment,
      [SELFHOST_CONTAINER_ENVIRONMENT.network]: "bridge",
    }),
  ).toThrow("valid non-reserved Docker network name");

  let factoryCalls = 0;
  const factories = {
    createDockerRuntime() {
      factoryCalls++;
      throw new Error("must not construct Docker runtime");
    },
    createSelfhostRuntime() {
      factoryCalls++;
      throw new Error("must not create local runtime state");
    },
  } as unknown as SelfhostContainerBootstrapFactories;
  expect(() =>
    createSelfhostContainerBootstrap({
      environment: partial,
      dataRoot: "/tmp/takoserver-test-data",
      providerMode: "stable-selfhost",
      factories,
    }),
  ).toThrow("must be configured together");
  expect(factoryCalls).toBe(0);
});

test("container bootstrap requires durable stable self-host state", () => {
  expect(() =>
    createSelfhostContainerBootstrap({
      environment: dockerEnvironment,
      dataRoot: ":memory:",
      providerMode: "stable-selfhost",
    }),
  ).toThrow("requires the durable TAKOSERVER_DATA_ROOT");
  expect(() =>
    createSelfhostContainerBootstrap({
      environment: dockerEnvironment,
      dataRoot: "/tmp/takoserver-data",
      providerMode: "cloudflare-object-bucket-drain",
    }),
  ).toThrow("cannot be enabled in retired-provider mode");
});

test("canonical bootstrap injects one bounded lazy runtime under dataRoot", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "selfhost-container-bootstrap-"));
  const dockerOptions: DockerHttpRevisionOptions[] = [];
  const runtimeOptions: Parameters<
    SelfhostContainerBootstrapFactories["createSelfhostRuntime"]
  >[0][] = [];
  let runtimeCloseCalls = 0;
  const runtimeHandle: SelfhostContainerRuntimeHandle = {
    async reconcile() {
      return { state: "ready" };
    },
    async observe() {
      return { state: "absent" };
    },
    async fetch() {
      return new Response("ok");
    },
    async remove() {
      return { state: "deleted" };
    },
    async close() {
      runtimeCloseCalls++;
    },
  };
  const factories: SelfhostContainerBootstrapFactories = {
    createDockerRuntime(options) {
      dockerOptions.push(options);
      return {} as ReturnType<SelfhostContainerBootstrapFactories["createDockerRuntime"]>;
    },
    async createSelfhostRuntime(options) {
      runtimeOptions.push(options);
      return runtimeHandle;
    },
  };

  try {
    const bootstrap = createSelfhostContainerBootstrap({
      environment: dockerEnvironment,
      dataRoot,
      providerMode: "stable-selfhost",
      factories,
    });
    expect(bootstrap).toBeDefined();
    if (!bootstrap) throw new Error("expected configured bootstrap");

    expect(dockerOptions).toEqual([
      {
        socketPath: "/var/run/docker.sock",
        installationId: "local.primary",
        network: "takoserver-selfhost-internal",
        maxMemoryBytes: SELFHOST_CONTAINER_CAPACITY_PROFILE.memoryBytes,
        maxNanoCpus: SELFHOST_CONTAINER_CAPACITY_PROFILE.nanoCpus,
        pidsLimit: SELFHOST_CONTAINER_CAPACITY_PROFILE.pidsLimit,
      },
    ]);
    expect(bootstrap.capacityProfile).toBe(SELFHOST_CONTAINER_CAPACITY_PROFILE);
    expect(runtimeOptions).toHaveLength(0);
    expect(runtimeCloseCalls).toBe(0);

    const identity: SelfhostContainerIdentity = {
      resourceUid: "resource-1",
      incarnationId: "incarnation-1",
    };
    await bootstrap.runtime.observe(identity);
    expect(runtimeOptions).toHaveLength(1);
    expect(runtimeOptions[0]?.root).toBe(join(dataRoot, "container-runtime"));
    expect(runtimeOptions[0]?.backend).toBeDefined();
    expect(runtimeOptions[0]?.drainTimeoutMs).toBe(5_000);

    await bootstrap.close();
    await bootstrap.close();
    expect(runtimeCloseCalls).toBe(1);
    await expect(bootstrap.runtime.observe(identity)).rejects.toMatchObject({ code: "closed" });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("startup cleanup closes an unopened runtime without creating runtime state", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "selfhost-container-startup-cleanup-"));
  let runtimeCreationCalls = 0;
  const factories = {
    createDockerRuntime() {
      return {} as ReturnType<SelfhostContainerBootstrapFactories["createDockerRuntime"]>;
    },
    async createSelfhostRuntime() {
      runtimeCreationCalls++;
      throw new Error("runtime must remain unopened during startup");
    },
  } as unknown as SelfhostContainerBootstrapFactories;

  try {
    const bootstrap = createSelfhostContainerBootstrap({
      environment: dockerEnvironment,
      dataRoot,
      providerMode: "stable-selfhost",
      factories,
    });
    expect(bootstrap).toBeDefined();
    if (!bootstrap) throw new Error("expected configured bootstrap");

    await bootstrap.close();
    expect(runtimeCreationCalls).toBe(0);
    await expect(stat(join(dataRoot, "container-runtime"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("container runtime close waits for an in-flight lazy open", async () => {
  let closeCalls = 0;
  const runtimeHandle: SelfhostContainerRuntimeHandle = {
    async reconcile() {
      return { state: "ready" };
    },
    async observe() {
      return { state: "absent" };
    },
    async fetch() {
      return new Response("ok");
    },
    async remove() {
      return { state: "deleted" };
    },
    async close() {
      closeCalls++;
    },
  };
  let resolveRuntime!: (runtime: SelfhostContainerRuntimeHandle) => void;
  const pendingRuntime = new Promise<SelfhostContainerRuntimeHandle>((resolve) => {
    resolveRuntime = resolve;
  });
  const factories: SelfhostContainerBootstrapFactories = {
    createDockerRuntime() {
      return {} as ReturnType<SelfhostContainerBootstrapFactories["createDockerRuntime"]>;
    },
    createSelfhostRuntime() {
      return pendingRuntime;
    },
  };
  const bootstrap = createSelfhostContainerBootstrap({
    environment: dockerEnvironment,
    dataRoot: "/tmp/takoserver-data",
    providerMode: "stable-selfhost",
    factories,
  });
  if (!bootstrap) throw new Error("expected configured bootstrap");

  const identity: SelfhostContainerIdentity = {
    resourceUid: "resource-race",
    incarnationId: "incarnation-race",
  };
  const observation = bootstrap.runtime.observe(identity);
  const closing = bootstrap.close();
  resolveRuntime(runtimeHandle);

  await expect(observation).resolves.toEqual({ state: "absent" });
  await closing;
  expect(closeCalls).toBe(1);
  await expect(bootstrap.runtime.observe(identity)).rejects.toMatchObject({ code: "closed" });
});

test("failed lazy runtime open is not retried and remains closeable", async () => {
  const openError = new Error("runtime open failed");
  let openCalls = 0;
  const factories: SelfhostContainerBootstrapFactories = {
    createDockerRuntime() {
      return {} as ReturnType<SelfhostContainerBootstrapFactories["createDockerRuntime"]>;
    },
    createSelfhostRuntime() {
      openCalls++;
      return Promise.reject(openError);
    },
  };
  const bootstrap = createSelfhostContainerBootstrap({
    environment: dockerEnvironment,
    dataRoot: "/tmp/takoserver-data",
    providerMode: "stable-selfhost",
    factories,
  });
  if (!bootstrap) throw new Error("expected configured bootstrap");

  const identity: SelfhostContainerIdentity = {
    resourceUid: "resource-failure",
    incarnationId: "incarnation-failure",
  };
  await expect(bootstrap.runtime.observe(identity)).rejects.toBe(openError);
  await expect(bootstrap.runtime.observe(identity)).rejects.toBe(openError);
  await expect(bootstrap.close()).rejects.toBe(openError);
  expect(openCalls).toBe(1);
});
