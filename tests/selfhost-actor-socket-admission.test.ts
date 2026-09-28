import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkerdActorNamespace,
  WorkerdActorNamespaceOptions,
} from "../src/selfhost-actor-native-process.ts";
import { createWorkerdRuntime, type WorkerdDeploymentPublication } from "../src/workerd-runtime.ts";
import { actorForm, fixture, insert, resource, scope } from "./helpers/actor-resource-fixture.ts";

const opened: WorkerdActorNamespaceOptions[] = [];
const childMode = process.env.TAKOS_SOCKET_ADMISSION_ISOLATED_CHILD === "1";

if (childMode)
  mock.module("../src/selfhost-actor-native-process.ts", () => ({
    openWorkerdActorNamespace: async (
      _binary: string,
      options: WorkerdActorNamespaceOptions,
    ): Promise<WorkerdActorNamespace> => {
      opened.push(options);
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => {
        exit = resolve;
      });
      return {
        epoch: "test-epoch",
        actorProxySocketPath: "/tmp/unused-actor-upgrade.sock",
        duplexTarget: (id, variantKey) => ({
          socketPath: "/tmp/unused-actor-upgrade.sock",
          headers: { "x-test-id": id, "x-test-variant": variantKey },
        }),
        async settleDuplex() {},
        exited,
        fetch: async (_id, _request, variantKey) => Response.json({ variantKey }),
        enableAlarmAdmission() {},
        disableAlarmAdmission() {},
        async close() {
          exit();
        },
      };
    },
  }));

const { createSelfhostActorExecutionHost } = await import(
  "../src/selfhost-actor-execution-host.ts"
);
const nonce = () => crypto.randomUUID();

function publication(workerResourceUid: string): WorkerdDeploymentPublication {
  const generation = "socket-admission-test";
  return {
    generation,
    workerResourceUid,
    hostnames: [],
    versions: (["a", "b"] as const).map((suffix) => ({
      versionId: `version-${suffix}`,
      workerVersionUid: `version-uid-${suffix}`,
      weight: suffix === "a" ? 5_000 : 5_000,
      site: {
        directory: "worker",
        mainModule: "main.mjs",
        hostEntrypoint: "__host.mjs",
        hostnames: [],
        generation,
        workerResourceUid,
        fetchHandler: true,
      },
      modules: new Map([["main.mjs", new TextEncoder().encode("export default {}")]]),
      hostModules: new Map([
        ["__host.mjs", new TextEncoder().encode('export { default } from "./main.mjs"')],
      ]),
    })),
  };
}

const socketAdmissionTest = async () => {
  opened.length = 0;
  const root = await mkdtemp(join(tmpdir(), "actor-socket-admission-"));
  const f = fixture();
  const otherScope = { ...scope, namespaceResourceUid: "other-namespace-uid" };
  insert(f.database, resource(actorForm, "other-counter", otherScope.namespaceResourceUid), [
    f.relation,
  ]);
  let basisPoint = 0;
  let graphPresent = true;
  const graphScopes: string[] = [];
  await f.deployments.create({
    tenantId: scope.tenantId,
    id: "deployment-worker",
    resourceUid: f.target.metadata.uid,
    offeringId: "worker-local",
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
    nativeId: "selfhost-worker:worker:operation-1",
    state: "active",
    observed: {},
    outputs: { scriptName: "worker" },
  });
  const runtime = createWorkerdRuntime({ root: join(root, "runtime"), isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication unavailable");
  await runtime.publish("worker", publication(f.target.metadata.uid));
  const owner = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "storage"),
    binary: "/mock-workerd",
    graph: async (identity, signal) => {
      graphScopes.push(JSON.stringify(identity));
      return graphPresent || identity.namespaceResourceUid === otherScope.namespaceResourceUid
        ? f.read(identity, signal)
        : null;
    },
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
    basisPoint: () => basisPoint,
  });
  let leaseId: string | undefined;
  try {
    await (
      await owner.fetch({ ...scope, id: "actor-a" }, new Request("http://example.invalid/"))
    ).json();
    const bridge = opened[0];
    if (!bridge) throw new Error("first socket bridge unavailable");
    const signal = new AbortController().signal;
    const first = await bridge.admitSocket("actor-a", nonce(), signal);
    expect(first?.epoch).toBe("test-epoch");
    expect(first?.generationKey).toBe(bridge.graph.generationKey);
    expect(first?.variantKey).toBe(bridge.graph.versions[0]?.variantKey);
    if (!first) throw new Error("first socket admission denied");
    leaseId = first.leaseId;

    // The same namespace serves multiple Actor IDs. A socket ID cannot
    // supply a different tenant or namespace to this Host-private bridge.
    basisPoint = 9_999;
    const second = await bridge.admitSocket("actor-b", nonce(), signal);
    expect(second?.variantKey).toBe(bridge.graph.versions[1]?.variantKey);
    expect(
      graphScopes.every((value) => {
        const identity = JSON.parse(value) as typeof scope;
        return (
          identity.tenantId === scope.tenantId &&
          identity.namespaceResourceUid === scope.namespaceResourceUid
        );
      }),
    ).toBe(true);
    if (second) bridge.completeSocket(second.leaseId);

    await (
      await owner.fetch({ ...otherScope, id: "actor-a" }, new Request("http://example.invalid/"))
    ).json();
    const otherBridge = opened[1];
    if (!otherBridge) throw new Error("second socket bridge unavailable");
    expect(otherBridge.namespaceKey).not.toBe(bridge.namespaceKey);
    otherBridge.completeSocket(leaseId); // a different namespace cannot complete A's lease

    // Revoking the Resource denies a new event even while an old lease is held.
    graphPresent = false;
    expect(await bridge.admitSocket("actor-a", nonce(), signal)).toBeNull();
    const other = await otherBridge.admitSocket("actor-a", nonce(), signal);
    expect(other).not.toBeNull();
    if (other) otherBridge.completeSocket(other.leaseId);
    expect(await bridge.admitSocket("actor-a", "bad-nonce", signal)).toBeNull();
    expect(await bridge.admitSocket("actor-a\u0000", nonce(), signal)).toBeNull();

    const closing = owner.close();
    const beforeCompletion = await Promise.race([
      closing.then(() => "closed"),
      Bun.sleep(25).then(() => "draining"),
    ]);
    expect(beforeCompletion).toBe("draining");
    bridge.completeAlarm(leaseId); // alarm completion cannot release a socket lease
    const stillDraining = await Promise.race([
      closing.then(() => "closed"),
      Bun.sleep(25).then(() => "draining"),
    ]);
    expect(stillDraining).toBe("draining");
    bridge.completeSocket(leaseId);
    leaseId = undefined;
    await closing;
  } finally {
    if (leaseId) opened[0]?.completeSocket(leaseId);
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
};

if (childMode) {
  test(
    "socket admission freshly selects a Version in its namespace and owns a distinct lease",
    socketAdmissionTest,
  );
} else {
  test("socket admission tests isolate their persistent module mock", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, TAKOS_SOCKET_ADMISSION_ISOLATED_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0, `${stdout}\n${stderr}`);

    const { createActorAlarmAttemptRegistry } = await import(
      "../src/selfhost-actor-native-process.ts"
    );
    const released: string[] = [];
    const attempts = createActorAlarmAttemptRegistry((leaseId) => released.push(leaseId));
    const grant = await attempts.begin("actor", "attempt", Date.now() + 5_000, async () => ({
      variantKey: "version",
      generationKey: "generation",
      epoch: "epoch",
      leaseId: "lease",
    }));
    expect(grant?.leaseId).toBe("lease");
    attempts.complete("attempt", Date.now() + 5_000);
    expect(released).toEqual(["lease"]);
  });
}

const duplexTargetLeaseTest = async () => {
  opened.length = 0;
  const root = await mkdtemp(join(tmpdir(), "actor-duplex-authority-"));
  const f = fixture();
  let graphPresent = true;
  await f.deployments.create({
    tenantId: scope.tenantId,
    id: "deployment-worker",
    resourceUid: f.target.metadata.uid,
    offeringId: "worker-local",
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
    nativeId: "selfhost-worker:worker:operation-1",
    state: "active",
    observed: {},
    outputs: { scriptName: "worker" },
  });
  const runtime = createWorkerdRuntime({ root: join(root, "runtime"), isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication unavailable");
  await runtime.publish("worker", publication(f.target.metadata.uid));
  const owner = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "storage"),
    binary: "/mock-workerd",
    graph: (identity, signal) => (graphPresent ? f.read(identity, signal) : Promise.resolve(null)),
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
    basisPoint: () => 9_999,
  });
  const ingress = () =>
    new Request("http://example.invalid/socket", {
      headers: {
        upgrade: "websocket",
        connection: "keep-alive, Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
  try {
    await expect(
      owner.reserveDuplex({ ...scope, id: "actor-a" }, new Request("http://example.invalid/")),
    ).rejects.toThrow("invalid_upgrade");
    expect(opened).toHaveLength(0);

    const first = await owner.reserveDuplex({ ...scope, id: "actor-a" }, ingress());
    expect(first.target.socketPath).toBe("/tmp/unused-actor-upgrade.sock");
    expect(first.target.headers["x-test-id"]).toBe("actor-a");
    expect(first.target.headers["x-test-variant"]).toBe(opened[0]?.graph.versions[1]?.variantKey);
    await first.commit();
    await expect(first.commit()).rejects.toThrow("expired");

    const revoked = await owner.reserveDuplex({ ...scope, id: "actor-a" }, ingress());
    graphPresent = false;
    await expect(revoked.commit()).rejects.toThrow("authority changed");
    revoked.abandon();
    await expect(owner.reserveDuplex({ ...scope, id: "actor-a" }, ingress())).rejects.toThrow();
  } finally {
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
};

if (childMode)
  test(
    "duplex target lease is selected under live authority and fenced again at commit",
    duplexTargetLeaseTest,
  );
