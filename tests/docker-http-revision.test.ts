import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonObject } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import {
  createDockerContainerCreateCustody,
  type DockerContainerCreateCustody,
  type DockerContainerCreateOwnerPort,
  type DockerContainerCreateRecord,
} from "../src/providers/docker-container-create-custody.ts";
import {
  createDockerContainerRuntimePreparation,
  type DockerContainerNativeIdentity,
  type DockerContainerRuntimeReceipt,
} from "../src/providers/docker-container-runtime-preparation.ts";
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
  environment: { MODE: "test", "APP.MODE": "production", _TRACE: "enabled" },
};

function engineFixture(recordRequestBodies = true) {
  const containers = new Map<string, JsonObject>();
  const calls: { method: string; path: string; body?: JsonObject }[] = [];
  let sequence = 0;
  let network: JsonObject = {
    Name: "installation-net",
    Driver: "bridge",
    Scope: "local",
    Internal: true,
    Ingress: false,
    Attachable: false,
    Labels: { "takoserver.installation": "selfhost-one" },
  };
  const engine: NonNullable<DockerHttpRevisionOptions["engine"]> = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined || !recordRequestBodies ? {} : { body }) });
    const url = new URL(path, "http://docker.invalid");
    if (method === "GET" && url.pathname === "/networks/installation-net") {
      return { status: 200, body: JSON.stringify(network) };
    }
    if (method === "GET" && url.pathname.startsWith("/images/") && url.pathname.endsWith("/json")) {
      const image = decodeURIComponent(url.pathname.slice(8, -5));
      const digest = image.slice(image.lastIndexOf("@") + 1);
      return {
        status: 200,
        body: JSON.stringify({
          Id: digest,
          Os: "linux",
          Architecture: "amd64",
          Descriptor: { digest, mediaType: "application/vnd.oci.image.manifest.v1+json" },
        }),
      };
    }
    if (url.pathname === "/images/create") return { status: 200, body: '{"status":"done"}\n' };
    if (url.pathname === "/containers/create" && body) {
      const name = url.searchParams.get("name");
      if (!name || body.Image === undefined || body.Labels === undefined) {
        throw new Error("Invalid Docker create request");
      }
      if (containers.has(name)) return { status: 409, body: "" };
      const Id = (++sequence).toString(16).padStart(64, "0");
      const endpoints = isJsonObject(body.NetworkingConfig)
        ? body.NetworkingConfig.EndpointsConfig
        : null;
      const configured = isJsonObject(endpoints) ? endpoints["installation-net"] : null;
      containers.set(name, {
        Id,
        Image: String(body.Image).split("@")[1]!,
        Config: {
          Image: body.Image,
          Labels: body.Labels,
          Env: body.Env ?? [],
          ExposedPorts: body.ExposedPorts ?? {},
        },
        HostConfig: body.HostConfig ?? {},
        Mounts: [],
        State: { Running: false },
        NetworkSettings: {
          Networks: {
            "installation-net": {
              IPAddress: "",
              // Engine stopped-create records the requested binding only;
              // a network name lookup does not materialize an endpoint ID.
              ...(isJsonObject(configured) && typeof configured.NetworkID === "string"
                ? { NetworkID: configured.NetworkID }
                : {}),
            },
          },
        },
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
      const settings = current.NetworkSettings;
      const networks = isJsonObject(settings) ? settings.Networks : null;
      const configured = isJsonObject(networks) ? networks["installation-net"] : null;
      containers.set(name, {
        ...current,
        State: { Running: true },
        NetworkSettings: {
          Networks: {
            "installation-net": {
              ...(isJsonObject(configured) ? configured : {}),
              IPAddress: "172.22.0.2",
            },
          },
        },
      });
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
  return {
    containers,
    calls,
    options,
    engine,
    setNetwork: (value: JsonObject) => (network = value),
  };
}

function trustedFixture(fixture: ReturnType<typeof engineFixture>, internet = true) {
  // The trusted Internet-capable Host fixture chooses an explicit numeric DNS
  // override; the product has no default resolver or implicit opt-in.
  if (internet) fixture.options = { ...fixture.options, dnsServers: ["192.0.2.53"] };
  fixture.setNetwork({
    Id: "b".repeat(64),
    Name: "installation-net",
    Driver: "bridge",
    Scope: "local",
    Internal: !internet,
    Ingress: false,
    Attachable: false,
    Labels: { "takoserver.installation": "selfhost-one" },
  });
  const claimed = new Set<string>();
  const preparedNative: DockerContainerNativeIdentity[] = [];
  const revocation = new AbortController();
  let current = true;
  let transform: (receipt: DockerContainerRuntimeReceipt) => unknown = (receipt) => receipt;
  let beforePrepare: () => void = () => undefined;
  const policy = {
    tenantRef: "tenant-one",
    generation: 1,
    policyDigest: `sha256:${"c".repeat(64)}`,
    outboundInternet: internet,
  };
  const lease = (native: DockerContainerNativeIdentity) => ({
    revocation: revocation.signal,
    stillCurrent: async () => current,
    readback: async () =>
      transform({
        native,
        policy,
        installed: true,
        topology: {
          networkId: native.networkId,
          rulesetDigest: `sha256:${"d".repeat(64)}`,
          meterId: "meter-one",
        },
        coverage: {
          ipv4: true,
          ipv6: true,
          tcp: true,
          udp: true,
          hostInput: true,
          forwardedTraffic: true,
          tenantIsolation: true,
          privateAddressDeny: true,
          metadataDeny: true,
          tcp25Deny: true,
          connectionLimit: true,
          bandwidthLimit: true,
          rawEgressMeter: true,
          killSwitch: true,
          denyAllOutbound: !internet,
          publicInternet: internet,
        },
      }),
    claimStart: async () => {
      if (claimed.has(native.nativeId)) return "already-claimed" as const;
      claimed.add(native.nativeId);
      return "claimed" as const;
    },
  });
  const createPreparation = (createCustody?: DockerContainerCreateCustody) =>
    createDockerContainerRuntimePreparation({
      policy,
      ...(createCustody
        ? { createCustody, requiredSecretNames: createCustody.requiredSecretNames }
        : {}),
      readStartClaim: async (native) =>
        claimed.has(native.nativeId) ? ("claimed" as const) : ("unclaimed" as const),
      prepare: async (native) => {
        preparedNative.push(native);
        beforePrepare();
        return lease(native);
      },
      recover: async (native) => lease(native),
    });
  return {
    createPreparation,
    policy,
    preparedNative,
    revocation,
    setCurrent: (value: boolean) => {
      current = value;
    },
    setReadback: (value: typeof transform) => {
      transform = value;
    },
    setBeforePrepare: (value: () => void) => {
      beforePrepare = value;
    },
  };
}

test("Host DNS pins exact ordered Engine keys and changes the immutable revision fingerprint", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  const dnsServers = ["192.0.2.53", "2001:db8::53"];
  const configuration = {
    ...fixture.options,
    runtimePreparation: trusted.createPreparation(),
    dnsServers,
  };
  const runtime = createDockerHttpRevisionRuntime(configuration);
  dnsServers.reverse();
  configuration.dnsServers = ["203.0.113.53"];
  expect(await runtime.reconcile(revision)).toMatchObject({ state: "ready" });
  const body = fixture.calls.find((call) => call.path.startsWith("/containers/create"))?.body;
  expect(body?.HostConfig).toMatchObject({
    Dns: ["192.0.2.53", "2001:db8::53"],
    DnsOptions: [],
    DnsSearch: [],
  });
  expect(await runtime.observe(revision)).toMatchObject({ state: "ready" });
  const starts = fixture.calls.filter((call) => call.path.endsWith("/start")).length;
  await expect(
    createDockerHttpRevisionRuntime({
      ...fixture.options,
      runtimePreparation: trusted.createPreparation(),
      dnsServers: ["2001:db8::53", "192.0.2.53"],
    }).reconcile(revision),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(starts);
});

test("Internet preparation requires bounded explicit numeric DNS before any Engine access", () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  const { dnsServers, ...withoutDns } = fixture.options;
  expect(dnsServers).toEqual(["192.0.2.53"]);
  expect(() =>
    createDockerHttpRevisionRuntime({
      ...withoutDns,
      runtimePreparation: trusted.createPreparation(),
    }),
  ).toThrow("invalid_request");
  const invalid: unknown[] = [
    [],
    [""],
    ["resolver.example"],
    ["https://192.0.2.53"],
    ["[2001:db8::53]"],
    ["fe80::53%eth0"],
    ["192.0.2.53", "192.0.2.53"],
    ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"],
    ["192.000.2.53"],
    ["192.0.2.53:53"],
    [" 192.0.2.53"],
    ["192.0.2.53\n"],
    ["2001:db8::53/64"],
    [null],
    new Array(1),
    "192.0.2.53",
    null,
  ];
  for (const value of invalid)
    expect(() =>
      createDockerHttpRevisionRuntime({
        ...withoutDns,
        runtimePreparation: trusted.createPreparation(),
        dnsServers: value as readonly string[],
      }),
    ).toThrow("invalid_request");
  expect(fixture.calls).toHaveLength(0);
});

test("DNS pin remains a numeric configuration choice while legacy unpinned profiles retain their body", async () => {
  for (const preparation of [false, true]) {
    const fixture = engineFixture();
    const runtimePreparation = preparation
      ? trustedFixture(fixture, false).createPreparation()
      : undefined;
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      ...(runtimePreparation ? { runtimePreparation } : {}),
    });
    expect(await runtime.reconcile(revision)).toMatchObject({ state: "ready" });
    const body = fixture.calls.find((call) => call.path.startsWith("/containers/create"))?.body;
    expect(isJsonObject(body?.HostConfig) ? Object.hasOwn(body.HostConfig, "Dns") : null).toBe(
      false,
    );
    expect(
      isJsonObject(body?.HostConfig) ? Object.hasOwn(body.HostConfig, "DnsOptions") : null,
    ).toBe(false);
    expect(
      isJsonObject(body?.HostConfig) ? Object.hasOwn(body.HostConfig, "DnsSearch") : null,
    ).toBe(false);
  }
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    dnsServers: ["127.0.0.53", "10.0.0.53", "fd00::53"],
  });
  expect(await runtime.reconcile(revision)).toMatchObject({ state: "ready" });
  expect(
    fixture.calls.find((call) => call.path.startsWith("/containers/create"))?.body?.HostConfig,
  ).toMatchObject({ Dns: ["127.0.0.53", "10.0.0.53", "fd00::53"] });
  // Physical destination permission is the enforcer's responsibility; numeric
  // resolver validation does not duplicate or certify its address policy.
});

test("pinned DNS rejects drift and malformed readback before adoption or another native effect", async () => {
  for (const patch of [
    { Dns: undefined },
    { Dns: null },
    { Dns: [] },
    { Dns: ["203.0.113.53", "2001:db8::53"] },
    { Dns: ["2001:db8::53", "192.0.2.53"] },
    { Dns: ["192.0.2.53", "2001:db8::53", "203.0.113.53"] },
    { Dns: ["192.0.2.53", null] },
    { Dns: "192.0.2.53" },
    { Dns: ["192.0.2.53", "192.0.2.53"] },
    { Dns: undefined, DNS: ["192.0.2.53", "2001:db8::53"] },
    { DnsOptions: ["rotate"] },
    { DnsSearch: ["foreign.example"] },
    { DnsOptions: {} },
    { DnsSearch: "" },
  ]) {
    const fixture = engineFixture();
    const trusted = trustedFixture(fixture);
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      dnsServers: ["192.0.2.53", "2001:db8::53"],
      runtimePreparation: trusted.createPreparation(),
    });
    await runtime.reconcile(revision);
    const [name, container] = [...fixture.containers.entries()][0] ?? [];
    if (!name || !container || !isJsonObject(container.HostConfig))
      throw new Error("Missing fixture");
    fixture.containers.set(name, {
      ...container,
      State: { Running: false },
      HostConfig: JSON.parse(JSON.stringify({ ...container.HostConfig, ...patch })) as JsonObject,
    });
    const before = fixture.calls.length;
    await expect(runtime.observe(revision)).rejects.toMatchObject({ code: "conflict" });
    await expect(runtime.reconcile(revision)).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
    expect(trusted.preparedNative).toHaveLength(1);
  }
});

test("DNS empty option/search arrays tolerate Docker null or omitted serialization", async () => {
  for (const empty of [[], null, undefined]) {
    const fixture = engineFixture();
    const trusted = trustedFixture(fixture);
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      runtimePreparation: trusted.createPreparation(),
    });
    await runtime.reconcile(revision);
    const [name, container] = [...fixture.containers.entries()][0] ?? [];
    if (!name || !container || !isJsonObject(container.HostConfig))
      throw new Error("Missing fixture");
    fixture.containers.set(name, {
      ...container,
      HostConfig: JSON.parse(
        JSON.stringify({ ...container.HostConfig, DnsOptions: empty, DnsSearch: empty }),
      ) as JsonObject,
    });
    const before = fixture.calls.length;
    expect(await runtime.observe(revision)).toMatchObject({ state: "ready" });
    expect(fixture.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
  }
});

test("a mutable Engine request body cannot replace the captured DNS expectation before adoption", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: trusted.createPreparation(),
    engine: async (method, path, body, signal) => {
      if (method === "POST" && path.startsWith("/containers/create")) {
        const hostConfig = body?.HostConfig;
        if (isJsonObject(hostConfig) && Array.isArray(hostConfig.Dns))
          hostConfig.Dns[0] = "203.0.113.53";
      }
      return fixture.engine(method, path, body, signal);
    },
  });
  await expect(runtime.reconcile(revision)).rejects.toMatchObject({ code: "conflict" });
  expect(trusted.preparedNative).toHaveLength(0);
  expect(fixture.calls.some((call) => call.path.endsWith("/start"))).toBe(false);
});

test("DNS drift during preparation and an unknown CREATE ACK cannot authorize START or replay CREATE", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  trusted.setBeforePrepare(() => {
    const [name, container] = [...fixture.containers.entries()][0] ?? [];
    if (!name || !container || !isJsonObject(container.HostConfig))
      throw new Error("Missing fixture");
    fixture.containers.set(name, {
      ...container,
      HostConfig: { ...container.HostConfig, Dns: ["203.0.113.53"] },
    });
  });
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: trusted.createPreparation(),
  });
  await expect(runtime.reconcile(revision)).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.calls.some((call) => call.path.endsWith("/start"))).toBe(false);

  const unknown = engineFixture(false);
  const creation = creationFixture(unknown);
  const engine: NonNullable<DockerHttpRevisionOptions["engine"]> = async (
    method,
    path,
    body,
    signal,
  ) => {
    const response = await unknown.engine(method, path, body, signal);
    if (method === "POST" && path.startsWith("/containers/create")) {
      const [name, container] = [...unknown.containers.entries()][0] ?? [];
      if (!name || !container || !isJsonObject(container.HostConfig))
        throw new Error("Missing fixture");
      unknown.containers.set(name, {
        ...container,
        HostConfig: { ...container.HostConfig, Dns: ["203.0.113.53"] },
      });
      throw new Error("synthetic CREATE acknowledgement lost");
    }
    return response;
  };
  const recover = () =>
    createDockerHttpRevisionRuntime({
      ...unknown.options,
      engine,
      dnsServers: ["192.0.2.53"],
      runtimePreparation: creation.preparation(),
    });
  await expect(recover().reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
  const before = unknown.calls.length;
  await expect(recover().reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
  expect(unknown.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
  expect(unknown.calls.filter((call) => call.path.startsWith("/containers/create"))).toHaveLength(
    1,
  );
  expect(unknown.calls.some((call) => call.path.endsWith("/start"))).toBe(false);
  expect(creation.claims()).toBe(1);
});

/** Synthetic owner only: its Map/current bit is not a production custody/grant. */
function creationFixture(
  fixture: ReturnType<typeof engineFixture>,
  value = "synthetic-create-only",
) {
  const trusted = trustedFixture(fixture, false);
  let saved: DockerContainerCreateRecord | null = null;
  const revocation = new AbortController();
  let current = true;
  let claims = 0;
  let transientMatch = false;
  let authorityUses = 0;
  let environmentUses = 0;
  let removalFailure: "ack" | "authority" | null = null;
  const owner: DockerContainerCreateOwnerPort = {
    read: async () => saved,
    claim: async (intent) => {
      claims++;
      if (saved) return { status: "existing", record: saved };
      saved = {
        claimId: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
        intent,
        nativeId: null,
        state: "pending",
      };
      return { status: "won", record: saved };
    },
    async withAuthority(record, _phase, use) {
      authorityUses++;
      if (record.claimId !== saved?.claimId) throw new Error("synthetic owner mismatch");
      const result = await use({
        revocation: revocation.signal,
        stillCurrent: async () => current,
        async withEnvironment(callback) {
          environmentUses++;
          const result = await callback(Object.freeze({ TOKEN: value }), revocation.signal);
          // Native daemon fixture retains Env; verify only inside this callback.
          transientMatch = [...fixture.containers.values()].some((native) => {
            const config = native.Config;
            return (
              isJsonObject(config) &&
              Array.isArray(config.Env) &&
              config.Env.includes(`TOKEN=${value}`)
            );
          });
          return result;
        },
      });
      if (removalFailure === "authority" && saved?.state === "removed") {
        removalFailure = null;
        throw new Error("synthetic terminal authority completion lost");
      }
      return result;
    },
    async bindNative(record, nativeId) {
      if (
        !saved ||
        saved.claimId !== record.claimId ||
        (saved.nativeId && saved.nativeId !== nativeId)
      )
        throw new Error("synthetic immutable binding mismatch");
      saved = { ...saved, nativeId, state: "bound" };
    },
    async confirmStopped(record, observation) {
      if (
        !saved ||
        saved.claimId !== record.claimId ||
        saved.nativeId !== observation.native.nativeId
      )
        throw new Error("synthetic stop mismatch");
    },
    async confirmRemoved(record, nativeId) {
      if (!saved || saved.claimId !== record.claimId || saved.nativeId !== nativeId)
        throw new Error("synthetic removal mismatch");
      saved = { ...saved, state: "removed" };
      if (removalFailure === "ack") {
        removalFailure = null;
        throw new Error("synthetic terminal commit acknowledgement lost");
      }
    },
  };
  const custody = createDockerContainerCreateCustody({
    policy: trusted.policy,
    requiredSecretNames: ["TOKEN"],
    owner,
  });
  return {
    trusted,
    custody,
    revocation,
    record: () => saved,
    claims: () => claims,
    transientMatch: () => transientMatch,
    authorityUses: () => authorityUses,
    environmentUses: () => environmentUses,
    failRemovalOnce: (mode: "ack" | "authority") => {
      removalFailure = mode;
    },
    setCurrent: (next: boolean) => {
      current = next;
    },
    preparation: () => trusted.createPreparation(custody),
  };
}

test("Docker CREATE receives secret overrides only through transient custody while revision and receipts stay nonsecret", async () => {
  const fixture = engineFixture(false);
  const creation = creationFixture(fixture);
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: creation.preparation(),
  });
  const before = JSON.stringify(revision);
  expect(await runtime.reconcile(revision)).toMatchObject({ state: "ready" });
  expect(creation.transientMatch()).toBe(true);
  expect(JSON.stringify(revision)).toBe(before);
  expect(JSON.stringify(creation.record()).includes("synthetic-create-only")).toBe(false);
  expect(JSON.stringify(fixture.calls).includes("synthetic-create-only")).toBe(false);
  expect(creation.claims()).toBe(1);
  await runtime.remove(revision);
  expect(fixture.containers.size).toBe(0);
  expect(creation.record()?.state).toBe("removed");
  // A lost terminal acknowledgement can repeat this exact retirement.
  await runtime.remove(revision);
  expect(creation.record()?.state).toBe("removed");
});

test.each(["ack", "authority"] as const)(
  "Docker exact retirement converges after lost terminal %s without reopening secret Env",
  async (mode) => {
    const fixture = engineFixture(false);
    const creation = creationFixture(fixture);
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      runtimePreparation: creation.preparation(),
    });
    const ready = await runtime.reconcile(revision);
    if (ready.state !== "ready") throw new Error("synthetic candidate was not ready");
    creation.failRemovalOnce(mode);
    await expect(runtime.remove(revision, ready.nativeId)).rejects.toBeInstanceOf(
      DockerHttpRevisionError,
    );
    expect(creation.record()?.state).toBe("removed");
    expect(fixture.containers.size).toBe(0);
    const previousEnvironmentUses = creation.environmentUses();
    const previousCalls = fixture.calls.length;
    await runtime.remove(revision, ready.nativeId);
    expect(creation.environmentUses()).toBe(previousEnvironmentUses);
    expect(fixture.calls.slice(previousCalls)).toEqual([
      { method: "GET", path: `/containers/${ready.nativeId}/json` },
    ]);
    await expect(runtime.reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
    expect(creation.claims()).toBe(1);
  },
);

test("Docker custody refuses public-env collisions before any native effect", async () => {
  const fixture = engineFixture(false);
  const creation = creationFixture(fixture);
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: creation.preparation(),
  });
  await expect(
    runtime.reconcile({ ...revision, environment: { TOKEN: "public" } }),
  ).rejects.toBeInstanceOf(DockerHttpRevisionError);
  expect(fixture.calls).toHaveLength(0);
});

test("secret CREATE rechecks current authority after awaited image preflight before sending native Env", async () => {
  const fixture = engineFixture(false);
  const creation = creationFixture(fixture);
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: creation.preparation(),
    engine: async (method, path, body) => {
      const result = await fixture.engine(method, path, body);
      if (method === "GET" && path.startsWith("/images/")) creation.setCurrent(false);
      return result;
    },
  });
  await expect(runtime.reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
  expect(creation.revocation.signal.aborted).toBe(false);
  expect(fixture.calls.filter((call) => call.path.startsWith("/containers/create"))).toHaveLength(
    0,
  );
  expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(0);
  expect(creation.record()?.nativeId).toBe(null);
});

test("lost secret CREATE ACK and absent readback never replay CREATE or retire pending custody", async () => {
  const fixture = engineFixture(false);
  const creation = creationFixture(fixture);
  let hidden = true;
  let creates = 0;
  const engine: NonNullable<DockerHttpRevisionOptions["engine"]> = async (method, path, body) => {
    if (path.startsWith("/containers/create")) {
      creates++;
      await fixture.engine(method, path, body);
      throw new Error("synthetic-private-create-ACK");
    }
    if (hidden && method === "GET" && path.startsWith("/containers/"))
      return { status: 404, body: "" };
    return fixture.engine(method, path, body);
  };
  const create = () =>
    createDockerHttpRevisionRuntime({
      ...fixture.options,
      engine,
      runtimePreparation: creation.preparation(),
    });
  await expect(create().reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
  await expect(create().reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
  await expect(create().remove(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
  expect(creates).toBe(1);
  expect(creation.claims()).toBe(1);
  expect(creation.record()?.state).toBe("pending");
  expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(0);
  hidden = false;
  expect(await create().reconcile(revision)).toMatchObject({ state: "ready" });
  expect(creates).toBe(1);
  expect(creation.record()?.state).toBe("bound");
  await create().remove(revision);
  expect(creation.record()?.state).toBe("removed");
});

test("secret custody current-only expiration during health refuses readiness with enforcer still current", async () => {
  const fixture = engineFixture(false);
  const creation = creationFixture(fixture);
  let healthEntered: () => void = () => undefined;
  let releaseHealth: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    healthEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseHealth = resolve;
  });
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: creation.preparation(),
    healthFetch: async () => {
      healthEntered();
      await released;
      return new Response("ok");
    },
  });
  const pending = runtime.reconcile(revision);
  await entered;
  creation.setCurrent(false);
  releaseHealth();
  await expect(pending).rejects.toBeInstanceOf(DockerHttpRevisionError);
  expect(creation.revocation.signal.aborted).toBe(false);
  expect(creation.trusted.revocation.signal.aborted).toBe(false);
});

test("secret values never change revision fingerprints and custody markers cannot downgrade to secretless adoption", async () => {
  const fingerprints: string[] = [];
  for (const value of ["synthetic-value-a", "synthetic-value-b"]) {
    const fixture = engineFixture(false);
    const creation = creationFixture(fixture, value);
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      runtimePreparation: creation.preparation(),
    });
    await runtime.reconcile(revision);
    const config = [...fixture.containers.values()][0]?.Config;
    const labels = isJsonObject(config) ? config.Labels : null;
    if (!isJsonObject(labels) || typeof labels["takoserver.revision"] !== "string")
      throw new Error("Missing safe labels");
    fingerprints.push(labels["takoserver.revision"]);
    await runtime.remove(revision);
  }
  expect(fingerprints[0] === fingerprints[1]).toBe(true);
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime(fixture.options);
  await runtime.reconcile(revision);
  const [name, native] = [...fixture.containers.entries()][0] ?? [];
  if (!name || !native || !isJsonObject(native.Config) || !isJsonObject(native.Config.Labels))
    throw new Error("Missing fixture");
  fixture.containers.set(name, {
    ...native,
    Config: {
      ...native.Config,
      Labels: { ...native.Config.Labels, "takoserver.create-claim": "a".repeat(64) },
    },
  });
  await expect(runtime.observe(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
});

test("revoking a secret CREATE closes only its Unix request and leaves the durable outcome unknown without replay", async () => {
  const fixture = engineFixture(false);
  const creation = creationFixture(fixture);
  const directory = await mkdtemp(join(tmpdir(), "dcs-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "d.sock");
  const sockets = new Set<Socket>();
  let creates = 0;
  let starts = 0;
  let createSocketClosed = false;
  let enteredCreate: () => void = () => undefined;
  let closedCreate: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enteredCreate = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    closedCreate = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      const path = (request.url ?? "").slice("/v1.51".length);
      if (path.startsWith("/containers/create")) {
        creates++;
        request.socket.once("close", () => {
          createSocketClosed = true;
          closedCreate();
        });
        let bytes = 0;
        request.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 65536) request.destroy();
        });
        enteredCreate();
        return; // Withhold this ACK after headers; any send is now uncertain.
      }
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        let size = 0;
        request.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 65536) {
            reject(new Error("bounded fixture body"));
            request.destroy();
          } else chunks.push(Buffer.from(chunk));
        });
        request.once("end", resolve);
        request.once("error", reject);
      });
      if (path.endsWith("/start")) starts++;
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as JsonObject) : undefined;
      const result = await fixture.engine(request.method ?? "GET", path, body);
      response.writeHead(result.status, {
        connection: "close",
        "content-type": "application/json",
      });
      response.end(result.body);
    } catch {
      if (!response.destroyed) {
        response.writeHead(500);
        response.end();
      }
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const { engine: _engine, ...httpOptions } = fixture.options;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let enteredDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const runtime = createDockerHttpRevisionRuntime({
      ...httpOptions,
      socketPath,
      timeoutMs: 1500,
      runtimePreparation: creation.preparation(),
    });
    const pending = runtime.reconcile(revision);
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.race([
      entered,
      new Promise<never>((_resolve, reject) => {
        enteredDeadline = setTimeout(
          () => reject(new Error("controlled CREATE did not begin")),
          2000,
        );
      }),
    ]);
    if (enteredDeadline) clearTimeout(enteredDeadline);
    expect(createSocketClosed).toBe(false);
    const revokedAt = performance.now();
    creation.revocation.abort();
    const completed = await Promise.race([
      Promise.all([outcome, closed]),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error("own CREATE socket did not close on revocation before transport timeout"),
            ),
          500,
        );
      }),
    ]);
    expect(completed[0] instanceof DockerHttpRevisionError).toBe(true);
    expect(performance.now() - revokedAt < 500).toBe(true);
    await expect(runtime.reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
    expect(creates).toBe(1);
    expect(starts).toBe(0);
    expect(creation.record()?.state).toBe("pending");
  } finally {
    if (deadline) clearTimeout(deadline);
    if (enteredDeadline) clearTimeout(enteredDeadline);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host opted preparation reads exact stopped Docker identity before allowing an external bridge start", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  trusted.setBeforePrepare(() => {
    expect(fixture.containers.size).toBe(1);
    expect([...fixture.containers.values()][0]?.State).toEqual({ Running: false });
    expect(fixture.calls.some((call) => call.path.endsWith("/start"))).toBe(false);
  });
  const runtimePreparation = trusted.createPreparation();
  const runtime = createDockerHttpRevisionRuntime({ ...fixture.options, runtimePreparation });
  expect(await runtime.reconcile(revision)).toMatchObject({ state: "ready" });
  expect(trusted.preparedNative.map((native) => native.nativeId)).toEqual(["1".padStart(64, "0")]);
  expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(1);
  expect(
    fixture.calls.find((call) => call.path.startsWith("/containers/create"))?.body?.HostConfig,
  ).toMatchObject({
    RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    CapDrop: ["ALL"],
    Privileged: false,
    PublishAllPorts: false,
  });
});

test("opted denied-egress Docker create records the owned network ID before stopped preparation readback", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture, false);
  trusted.setBeforePrepare(() => {
    const stopped = [...fixture.containers.values()][0];
    expect(stopped?.State).toEqual({ Running: false });
    expect(stopped?.NetworkSettings).toEqual({
      Networks: { "installation-net": { NetworkID: "b".repeat(64), IPAddress: "" } },
    });
    expect(
      fixture.calls.find((call) => call.path.startsWith("/containers/create"))?.body
        ?.NetworkingConfig,
    ).toEqual({ EndpointsConfig: { "installation-net": { NetworkID: "b".repeat(64) } } });
    expect(fixture.calls.some((call) => call.path.endsWith("/start"))).toBe(false);
  });
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: trusted.createPreparation(),
  });
  expect(await runtime.reconcile(revision)).toMatchObject({ state: "ready" });
  expect(trusted.preparedNative[0]?.networkId).toBe("b".repeat(64));
});

test("Docker starts zero times for missing or incomplete trusted enforcement and revoked authority", async () => {
  for (const fault of ["missing", "foreign", "partial", "false-policy", "revoked"] as const) {
    const fixture = engineFixture();
    const trusted = trustedFixture(fixture, fault !== "false-policy");
    trusted.setReadback((receipt) => {
      if (fault === "missing") return null;
      if (fault === "foreign")
        return { ...receipt, native: { ...receipt.native, backend: "cloudflare" } };
      if (fault === "partial")
        return { ...receipt, coverage: { ...receipt.coverage, ipv6: false } };
      if (fault === "false-policy")
        return { ...receipt, coverage: { ...receipt.coverage, denyAllOutbound: false } };
      return receipt;
    });
    if (fault === "revoked") trusted.setBeforePrepare(() => trusted.revocation.abort());
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      runtimePreparation: trusted.createPreparation(),
    });
    await expect(runtime.reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
    expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(0);
    expect([...fixture.containers.values()][0]?.State).toEqual({ Running: false });
  }
});

test("Docker rereads native identity after preparation and never starts a replacement", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  trusted.setBeforePrepare(() => {
    const [name, value] = [...fixture.containers.entries()][0] ?? [];
    if (!name || !value) throw new Error("Missing stopped fixture");
    fixture.containers.set(name, { ...value, Id: "9".repeat(64) });
  });
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: trusted.createPreparation(),
  });
  expect(await runtime.reconcile(revision)).toMatchObject({ state: "stopped" });
  expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(0);
});

test("unknown Docker start ACK recovers by readback after a Host runtime restart without replay", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  let starts = 0;
  const engine: NonNullable<DockerHttpRevisionOptions["engine"]> = async (method, path, body) => {
    if (method === "POST" && path.endsWith("/start")) {
      starts++;
      throw new Error("synthetic-private-engine-diagnostic");
    }
    return fixture.engine(method, path, body);
  };
  const create = () =>
    createDockerHttpRevisionRuntime({
      ...fixture.options,
      engine,
      runtimePreparation: trusted.createPreparation(),
    });
  expect(await create().reconcile(revision)).toMatchObject({ state: "stopped" });
  expect(await create().reconcile(revision)).toMatchObject({ state: "stopped" });
  expect(starts).toBe(1);
});

test("Docker rejects missing or foreign attached network IDs before trusted preparation or start", async () => {
  for (const networkId of [undefined, "9".repeat(64), "invalid"] as const) {
    const fixture = engineFixture();
    const trusted = trustedFixture(fixture);
    const engine: NonNullable<DockerHttpRevisionOptions["engine"]> = async (method, path, body) => {
      const response = await fixture.engine(method, path, body);
      if (path.startsWith("/containers/create")) {
        const [name, value] = [...fixture.containers.entries()][0] ?? [];
        if (!name || !value) throw new Error("Missing stopped fixture");
        fixture.containers.set(name, {
          ...value,
          NetworkSettings: {
            Networks: {
              "installation-net": {
                IPAddress: "172.22.0.2",
                ...(networkId === undefined ? {} : { NetworkID: networkId }),
              },
            },
          },
        });
      }
      return response;
    };
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      engine,
      runtimePreparation: trusted.createPreparation(),
    });
    await expect(runtime.reconcile(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
    expect(trusted.preparedNative).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(0);
    expect([...fixture.containers.values()][0]?.State).toEqual({ Running: false });
  }
});

test("Docker refuses an attachment NetworkID that changes while trusted preparation awaits", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  trusted.setBeforePrepare(() => {
    const [name, value] = [...fixture.containers.entries()][0] ?? [];
    if (!name || !value) throw new Error("Missing stopped fixture");
    fixture.containers.set(name, {
      ...value,
      NetworkSettings: {
        Networks: { "installation-net": { IPAddress: "172.22.0.2", NetworkID: "9".repeat(64) } },
      },
    });
  });
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: trusted.createPreparation(),
  });
  expect(await runtime.reconcile(revision)).toMatchObject({ state: "stopped" });
  expect(trusted.preparedNative[0]?.networkId).toBe("b".repeat(64));
  expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(0);
});

test("Docker cannot report ready when its lease expires during awaited health without abort notification", async () => {
  for (const notification of ["current-only", "abort"] as const) {
    const fixture = engineFixture();
    const trusted = trustedFixture(fixture);
    let releaseHealth: () => void = () => undefined;
    let healthEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      healthEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      runtimePreparation: trusted.createPreparation(),
      healthFetch: async () => {
        healthEntered();
        await release;
        return new Response("ok");
      },
    });
    const pending = runtime.reconcile(revision);
    await entered;
    if (notification === "abort") trusted.revocation.abort();
    else trusted.setCurrent(false);
    releaseHealth();
    await expect(pending).rejects.toBeInstanceOf(DockerHttpRevisionError);
    expect(trusted.revocation.signal.aborted).toBe(notification === "abort");
    expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(1);
  }
});

test("Docker running recovery keeps its lease through awaited health body cancellation", async () => {
  const fixture = engineFixture();
  const trusted = trustedFixture(fixture);
  let recovering = false;
  const runtime = createDockerHttpRevisionRuntime({
    ...fixture.options,
    runtimePreparation: trusted.createPreparation(),
    healthFetch: async () =>
      new Response(
        new ReadableStream({
          cancel: async () => {
            if (recovering) trusted.setCurrent(false);
          },
        }),
      ),
  });
  expect(await runtime.reconcile(revision)).toMatchObject({ state: "ready" });
  recovering = true;
  await expect(runtime.observe(revision)).rejects.toBeInstanceOf(DockerHttpRevisionError);
  expect(trusted.revocation.signal.aborted).toBe(false);
  expect(fixture.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(1);
});

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
  expect(create.body?.NetworkingConfig).toBeUndefined();
  expect(create.body?.Image).toBe(revision.image);
  expect(create.body?.Env).toContain("APP.MODE=production");
  expect(create.body?.Env).toContain("_TRACE=enabled");
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

test("Docker HTTP revision validates its exact owned internal network before pull or create", async () => {
  const invalidNetworks: readonly JsonObject[] = [
    { Name: "replacement-net", Driver: "bridge", Scope: "local", Internal: true },
    { Name: "installation-net", Driver: "host", Scope: "local", Internal: true },
    { Name: "installation-net", Driver: "bridge", Scope: "swarm", Internal: true },
    { Name: "installation-net", Driver: "bridge", Scope: "local", Internal: false },
    {
      Name: "installation-net",
      Driver: "bridge",
      Scope: "local",
      Internal: true,
      Ingress: true,
    },
    {
      Name: "installation-net",
      Driver: "bridge",
      Scope: "local",
      Internal: true,
      Ingress: false,
      Attachable: true,
    },
    {
      Name: "installation-net",
      Driver: "bridge",
      Scope: "local",
      Internal: true,
      Ingress: false,
      Attachable: false,
      Labels: { "takoserver.installation": "another-installation" },
    },
  ];

  for (const network of invalidNetworks) {
    const fixture = engineFixture();
    fixture.setNetwork(network);
    const runtime = createDockerHttpRevisionRuntime(fixture.options);
    await expect(runtime.reconcile(revision)).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.calls.map((call) => call.path)).toContain("/networks/installation-net");
    expect(fixture.calls.some((call) => call.path.startsWith("/images/create"))).toBe(false);
    expect(fixture.calls.some((call) => call.path.startsWith("/containers/create"))).toBe(false);
    expect(fixture.containers.size).toBe(0);
  }
});

test("Docker HTTP revision keeps exact existing observation and removal safe after network drift", async () => {
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime(fixture.options);
  const active = await runtime.reconcile(revision);
  if (active.state !== "ready") throw new Error("Revision is not ready");

  fixture.setNetwork({
    Name: "installation-net",
    Driver: "bridge",
    Scope: "local",
    Internal: false,
    Ingress: false,
    Attachable: false,
    Labels: { "takoserver.installation": "selfhost-one" },
  });
  const before = fixture.calls.length;
  expect(await runtime.observe(revision)).toEqual(active);
  await runtime.remove(revision, active.nativeId);
  expect(
    fixture.calls.slice(before).some((call) => call.path === "/networks/installation-net"),
  ).toBe(false);
  expect(await runtime.observe(revision)).toEqual({ state: "absent" });
});

test("Docker HTTP revision refuses to start an exact stopped instance after network drift", async () => {
  const fixture = engineFixture();
  const runtime = createDockerHttpRevisionRuntime(fixture.options);
  const active = await runtime.reconcile(revision);
  if (active.state !== "ready") throw new Error("Revision is not ready");
  const [name, current] = [...fixture.containers.entries()][0] ?? [];
  if (!name || !current) throw new Error("Missing native container");
  fixture.containers.set(name, { ...current, State: { Running: false } });
  fixture.setNetwork({
    Name: "installation-net",
    Driver: "bridge",
    Scope: "local",
    Internal: false,
    Ingress: false,
    Attachable: false,
    Labels: { "takoserver.installation": "selfhost-one" },
  });

  const before = fixture.calls.length;
  await expect(runtime.reconcile(revision)).rejects.toMatchObject({ code: "conflict" });
  expect(await runtime.observe(revision)).toEqual({
    state: "stopped",
    nativeId: active.nativeId,
  });
  expect(
    fixture.calls
      .slice(before)
      .some((call) => call.path === `/containers/${active.nativeId}/start`),
  ).toBe(false);
  expect(
    fixture.calls.slice(before).some((call) => call.path === "/networks/installation-net"),
  ).toBe(true);

  await runtime.remove(revision, active.nativeId);
  expect(await runtime.observe(revision)).toEqual({ state: "absent" });
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
      if (method === "POST" && path === `/containers/${first.nativeId}/stop?t=0`) {
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

test("Docker verifies a single linux/amd64 manifest and digest before any container creation", async () => {
  for (const patch of [
    { Os: "windows" },
    { Architecture: "arm64" },
    {
      Descriptor: {
        digest: `sha256:${"b".repeat(64)}`,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      },
    },
    {
      Descriptor: {
        digest: revision.image.split("@")[1],
        mediaType: "application/vnd.oci.image.index.v1+json",
      },
    },
  ]) {
    const fixture = engineFixture();
    const runtime = createDockerHttpRevisionRuntime({
      ...fixture.options,
      engine: async (method, path, body) => {
        const result = await fixture.engine(method, path, body);
        return path.startsWith("/images/") && path.endsWith("/json")
          ? { ...result, body: JSON.stringify({ ...JSON.parse(result.body), ...patch }) }
          : result;
      },
    });
    await expect(runtime.reconcile(revision)).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.calls.some((call) => call.path.startsWith("/containers/create"))).toBe(false);
  }
});
