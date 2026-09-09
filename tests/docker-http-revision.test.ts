import { expect, test } from "bun:test";
import type { JsonObject } from "../src/ports.ts";
import {
  createDockerHttpRevisionRuntime,
  type DockerHttpRevision,
  DockerHttpRevisionError,
  type DockerHttpRevisionOptions,
} from "../src/providers/docker-http-revision.ts";

const revision: DockerHttpRevision = {
  resourceUid: "resource-one",
  incarnationId: "deployment-one",
  revision: "revision-a",
  image: `registry.example/application@sha256:${"a".repeat(64)}`,
  port: 8080,
  healthPath: "/health",
  memoryBytes: 256 * 1024 * 1024,
  nanoCpus: 500_000_000,
  environment: { MODE: "test" },
};

function engineFixture() {
  const containers = new Map<string, JsonObject>();
  const calls: { method: string; path: string; body?: JsonObject }[] = [];
  let sequence = 0;
  const engine: NonNullable<DockerHttpRevisionOptions["engine"]> = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const url = new URL(path, "http://docker.invalid");
    if (url.pathname === "/images/create") return { status: 200, body: '{"status":"done"}\n' };
    if (url.pathname === "/containers/create" && body) {
      const name = url.searchParams.get("name");
      if (!name || body.Image === undefined || body.Labels === undefined) {
        throw new Error("Invalid Docker create request");
      }
      if (containers.has(name)) return { status: 409, body: "" };
      const Id = (++sequence).toString(16).padStart(64, "0");
      containers.set(name, {
        Id,
        Config: {
          Image: body.Image,
          Labels: body.Labels,
          Env: body.Env ?? [],
          ExposedPorts: body.ExposedPorts ?? {},
        },
        HostConfig: body.HostConfig ?? {},
        Mounts: [],
        State: { Running: false },
        NetworkSettings: { Networks: { "installation-net": { IPAddress: "172.22.0.2" } } },
      });
      return { status: 201, body: JSON.stringify({ Id }) };
    }
    const [nameOrId, operation] = url.pathname.slice("/containers/".length).split("/");
    const match = [...containers.entries()].find(
      ([name, value]) => name === nameOrId || value.Id === nameOrId,
    );
    if (!match) return { status: 404, body: "" };
    const [name, current] = match;
    if (operation === "json") return { status: 200, body: JSON.stringify(current) };
    if (operation === "start") {
      containers.set(name, { ...current, State: { Running: true } });
      return { status: 204, body: "" };
    }
    if (operation === "stop") {
      containers.set(name, { ...current, State: { Running: false } });
      return { status: 204, body: "" };
    }
    if (method === "DELETE") {
      containers.delete(name);
      return { status: 204, body: "" };
    }
    throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
  };
  const options: DockerHttpRevisionOptions = {
    socketPath: "/var/run/docker.sock",
    installationId: "selfhost-one",
    network: "installation-net",
    maxMemoryBytes: 1024 * 1024 * 1024,
    maxNanoCpus: 2_000_000_000,
    pidsLimit: 128,
    engine,
    healthFetch: async (request) =>
      new Response(request.url.endsWith("/health") ? "ok" : "missing", {
        status: request.url.endsWith("/health") ? 200 : 404,
      }),
  };
  return { containers, calls, options, engine };
}

test("Docker HTTP revisions create, recover, coexist across update and delete only the exact revision", async () => {
  const fixture = engineFixture();
  let runtime = createDockerHttpRevisionRuntime(fixture.options);
  expect(await runtime.observe(revision)).toEqual({ state: "absent" });
  expect(fixture.calls.every((call) => call.method === "GET")).toBe(true);
  const first = await runtime.reconcile(revision);
  expect(first).toEqual({
    state: "ready",
    nativeId: "1".padStart(64, "0"),
    endpoint: "http://172.22.0.2:8080",
  });
  runtime = createDockerHttpRevisionRuntime(fixture.options);
  expect(await runtime.reconcile(revision)).toEqual(first);
  expect(fixture.containers.size).toBe(1);
  expect(fixture.calls.filter((call) => call.path.startsWith("/containers/create"))).toHaveLength(
    1,
  );
  const create = fixture.calls.find((call) => call.path.startsWith("/containers/create"));
  if (!create) throw new Error("Docker revision was not created");
  expect(create.body?.Image).toBe(revision.image);
  expect(create.body?.HostConfig).toMatchObject({
    NetworkMode: "installation-net",
    Memory: 268435456,
    NanoCpus: 500000000,
    PidsLimit: 128,
    Privileged: false,
    CapDrop: ["ALL"],
    PublishAllPorts: false,
  });
  const next = {
    ...revision,
    revision: "revision-b",
    image: `registry.example/application@sha256:${"b".repeat(64)}`,
  };
  expect(await runtime.reconcile(next)).toMatchObject({
    state: "ready",
    nativeId: "2".padStart(64, "0"),
  });
  expect(fixture.containers.size).toBe(2);
  await runtime.remove(revision);
  await runtime.remove(revision);
  expect(await runtime.observe(revision)).toEqual({ state: "absent" });
  expect(await runtime.observe(next)).toMatchObject({ state: "ready" });
  await runtime.remove(next);
  expect(fixture.containers.size).toBe(0);
});

test("Docker HTTP revision refuses mutable image, capacity excess and changed immutable content", async () => {
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime(fixture.options);
  await expect(
    runtime.reconcile({ ...revision, image: "application:latest" }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    runtime.reconcile({ ...revision, memoryBytes: 2 * 1024 * 1024 * 1024 }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(fixture.calls).toHaveLength(0);
  await runtime.reconcile(revision);
  const before = fixture.calls.length;
  await expect(
    runtime.reconcile({ ...revision, environment: { MODE: "changed" } }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
  expect(fixture.containers.size).toBe(1);
});

test("Docker HTTP revision retirement fences the exact observed native instance", async () => {
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime(fixture.options);
  const first = await runtime.reconcile(revision);
  if (first.state !== "ready") throw new Error("Revision is not ready");
  const [name, original] = [...fixture.containers.entries()][0] ?? [];
  if (!name || !original) throw new Error("Missing native container");
  // An operator recreated the same immutable revision. Its labels and safety
  // settings still match, but a pending retirement for the old instance must
  // not stop the replacement.
  const replacementId = "f".repeat(64);
  fixture.containers.set(name, { ...original, Id: replacementId });
  const before = fixture.calls.length;
  await expect(runtime.remove(revision, first.nativeId)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(fixture.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
  expect(fixture.containers.get(name)?.Id).toBe(replacementId);
  expect(await runtime.observe(revision)).toMatchObject({
    state: "ready",
    nativeId: replacementId,
  });
  await runtime.remove(revision, replacementId);
  await runtime.remove(revision, replacementId);
  expect(await runtime.observe(revision)).toEqual({ state: "absent" });
});

test("Docker HTTP retirement never follows a replacement appearing after inspection", async () => {
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime(fixture.options);
  const first = await runtime.reconcile(revision);
  if (first.state !== "ready") throw new Error("Revision is not ready");
  const replacementId = "e".repeat(64);
  const retiring = createDockerHttpRevisionRuntime({
    ...fixture.options,
    engine: async (method, path, body) => {
      if (method === "POST" && path === `/containers/${first.nativeId}/stop?t=10`) {
        const [name, original] = [...fixture.containers.entries()][0] ?? [];
        if (!name || !original) throw new Error("Missing native container");
        fixture.containers.set(name, { ...original, Id: replacementId });
      }
      return fixture.engine(method, path, body);
    },
  });
  const before = fixture.calls.length;
  await expect(retiring.remove(revision, first.nativeId)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(
    fixture.calls
      .slice(before)
      .filter((call) => call.method !== "GET")
      .every((call) => call.path.startsWith(`/containers/${first.nativeId}`)),
  ).toBe(true);
  expect(await runtime.observe(revision)).toMatchObject({
    state: "ready",
    nativeId: replacementId,
  });
});

test("Docker HTTP retirement rejects an invalid native pin before engine access", async () => {
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime(fixture.options);
  for (const nativeId of ["", "short-id", "../other", "a".repeat(63), "A".repeat(64)]) {
    await expect(runtime.remove(revision, nativeId)).rejects.toMatchObject({
      code: "invalid_request",
    });
  }
  expect(fixture.calls).toHaveLength(0);
});

test("Docker HTTP revision refuses recovery when safety settings drift behind matching labels", async () => {
  const driftCases: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (container: JsonObject) => JsonObject;
  }> = [
    ...Object.entries({
      CapAdd: ["SYS_ADMIN"],
      Devices: [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }],
      DeviceRequests: [{ Count: -1, Capabilities: [["gpu"]] }],
      DeviceCgroupRules: ["a *:* rwm"],
      PortBindings: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
      Mounts: [{ Type: "bind", Source: "/", Target: "/host" }],
      PidMode: "host",
      IpcMode: "host",
      UTSMode: "host",
      UsernsMode: "host",
      CgroupnsMode: "host",
    } satisfies JsonObject).map(([field, value]) => ({
      name: field,
      mutate: (container: JsonObject): JsonObject => ({
        ...container,
        HostConfig: { ...(container.HostConfig as JsonObject), [field]: value },
      }),
    })),
    {
      name: "memory cap",
      mutate: (container) => ({
        ...container,
        HostConfig: {
          ...(container.HostConfig as JsonObject),
          Memory: revision.memoryBytes / 2,
        },
      }),
    },
    {
      name: "environment",
      mutate: (container) => ({
        ...container,
        Config: {
          ...(container.Config as JsonObject),
          Env: ["MODE=drifted"],
        },
      }),
    },
    {
      name: "network attachment",
      mutate: (container) => ({
        ...container,
        NetworkSettings: {
          ...(container.NetworkSettings as JsonObject),
          Networks: {
            ...((container.NetworkSettings as JsonObject).Networks as JsonObject),
            "untrusted-net": {},
          },
        },
      }),
    },
    {
      name: "mount",
      mutate: (container) => ({
        ...container,
        Mounts: [{ Source: "/host", Destination: "/app", RW: true }],
      }),
    },
  ];

  for (const driftCase of driftCases) {
    const fixture = engineFixture();
    const runtime = createDockerHttpRevisionRuntime(fixture.options);
    await runtime.reconcile(revision);
    const [name, container] = [...fixture.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("Docker revision was not created");
    fixture.containers.set(name, {
      ...driftCase.mutate(container),
      State: { Running: false },
    });
    const startsBeforeRecovery = fixture.calls.filter((call) =>
      call.path.endsWith("/start"),
    ).length;
    await expect(runtime.observe(revision)).rejects.toMatchObject({ code: "conflict" });
    await expect(runtime.reconcile(revision)).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(
      startsBeforeRecovery,
    );
  }
});

test("Docker HTTP revision pull errors cannot create a container or leak daemon diagnostics", async () => {
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    engine: async (method, path, body) =>
      path.startsWith("/images/create")
        ? { status: 200, body: '{"error":"private registry credential detail"}\n' }
        : fixture.engine(method, path, body),
  });
  const error = await runtime.reconcile(revision).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DockerHttpRevisionError);
  expect(String(error)).toBe("DockerHttpRevisionError: unavailable");
  expect(fixture.containers.size).toBe(0);
});
