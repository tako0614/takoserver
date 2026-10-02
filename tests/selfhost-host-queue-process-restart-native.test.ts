import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { ensureOperatorKey, signOperatorAssertion } from "../src/operator-key.ts";
import { selfhostObjectsRoot } from "../src/providers/selfhost.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import {
  isAcknowledgedQueueResponse,
  readQueueEventMessages,
  shouldInterceptQueueEvent,
} from "./fixtures/selfhost-host-queue-process-child.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";
import { createSyntheticPublisherSetVerifier } from "./helpers/synthetic-publisher-set-verifier.ts";

const EVENT_PATH = "/.well-known/takoserver/managed-worker-events/v1";
const WORKERD = nativeEvidenceBinary("workerd-artifact") ?? null;
const NATIVE_AVAILABLE = WORKERD !== null && process.platform === "linux";
const API_PORT = 8787;
const WORKERD_PORT = 443;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const WORKER_SUFFIX = "apps.queue-process-restart.test";
const SPACE = "default";
const LANE = "/apis/forms.takoform.com/v1";
const WORKER_SOURCE = `async function seen(env) {
  const value = await env.KV.get("seen");
  return value === null ? [] : JSON.parse(new TextDecoder().decode(value));
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/send" && request.method === "POST") {
      return Response.json({ id: await env.QUEUE.send("host-process-restart") });
    }
    if (path === "/seen") return Response.json({ seen: await seen(env) });
    if (path === "/object") {
      const object = await env.BUCKET.get("queue-recovery/effect");
      return object === null ? new Response(null, { status: 404 }) : new Response(object.body);
    }
    return Response.json({ ready: true });
  },
  async queue(batch, env) {
    const observed = await seen(env);
    for (const message of batch.messages) {
      observed.push({ id: message.id, attempts: message.attempts });
      if (message.attempts === 1) {
        await env.BUCKET.put("queue-recovery/effect", "persisted-before-unknown-ack");
      } else if (await env.BUCKET.get("queue-recovery/effect") === null) {
        throw new Error("object did not survive Host restart");
      }
    }
    await env.KV.put("seen", JSON.stringify(observed));
    for (const message of batch.messages) message.acknowledge();
  },
};`;

interface Json {
  readonly [key: string]: unknown;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly executable: string;
}

interface ProxyObservation {
  readonly messageId: string;
  readonly attempts: number;
  readonly status: number;
  readonly acknowledged: boolean;
  readonly withheld: boolean;
}

test("the queue response-loss fixture selects only the exact local Workerd event POST", () => {
  const target = {
    origin: "https://127.0.0.1",
    pathname: EVENT_PATH,
    method: "POST",
    host: "queue-worker.selfhost-events.invalid",
  };

  expect(shouldInterceptQueueEvent(target)).toBe(true);
  expect(shouldInterceptQueueEvent({ ...target, origin: "https://127.0.0.1:444" })).toBe(false);
  expect(shouldInterceptQueueEvent({ ...target, pathname: `${EVENT_PATH}/extra` })).toBe(false);
  expect(shouldInterceptQueueEvent({ ...target, method: "GET" })).toBe(false);
  expect(shouldInterceptQueueEvent({ ...target, host: "queue-worker.example.test" })).toBe(false);
});

test("the response-loss fixture records only a real ACK for the requested Queue message", () => {
  const id = "a1f8d202-a94f-46f2-9705-509f1152ebaf";
  expect(
    readQueueEventMessages(
      JSON.stringify({
        messages: [
          { messageId: id, attempts: 1 },
          { messageId: "other", attempts: 4 },
        ],
      }),
    ),
  ).toEqual([
    { messageId: id, attempts: 1 },
    { messageId: "other", attempts: 4 },
  ]);
  const ack = JSON.stringify({
    protocol: "takoserver.managed-worker-event@v1",
    kind: "queue",
    decisions: [{ messageId: id, outcome: "ack" }],
  });
  expect(isAcknowledgedQueueResponse(200, ack, id)).toBe(true);
  expect(isAcknowledgedQueueResponse(200, ack, "other")).toBe(false);
  expect(isAcknowledgedQueueResponse(204, ack, id)).toBe(false);
});

// Native-only: fixed loopback 8787/443 belong in an isolated network namespace.
test.skipIf(!NATIVE_AVAILABLE)(
  "a stopped Host recovers an unknown Queue ACK from the same durable files and does not redeliver after ACK",
  async () => {
    const fixture = mkdtempSync(join(tmpdir(), "takoserver-host-queue-process-restart-"));
    chmodSync(fixture, 0o700);
    const dataRoot = join(fixture, "host-data");
    const databasePath = join(fixture, "control.sqlite");
    const tlsDirectory = join(fixture, "tls");
    const proxyReadyFile = join(fixture, "proxy.port");
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 });
    const baseEnvironment = childEnvironment(fixture);
    const hostEnvironment = (proxyOrigin?: string): Record<string, string> => ({
      ...baseEnvironment,
      TAKOSERVER_DATA_ROOT: dataRoot,
      TAKOSERVER_DB: databasePath,
      TAKOSERVER_PUBLIC_ORIGIN: API_ORIGIN,
      PORT: String(API_PORT),
      TAKOSERVER_WORKERD_BINARY: WORKERD as string,
      TAKOSERVER_WORKERD_PORT: String(WORKERD_PORT),
      TAKOSERVER_WORKER_ENDPOINT_PORT: String(WORKERD_PORT),
      TAKOSERVER_WORKER_ENDPOINT_SUFFIX: WORKER_SUFFIX,
      TAKOSERVER_SUFFIXES: WORKER_SUFFIX,
      TAKOSERVER_WORKERD_TLS_CERT_FILE: join(tlsDirectory, "worker-cert.pem"),
      TAKOSERVER_WORKERD_TLS_KEY_FILE: join(tlsDirectory, "worker-key.pem"),
      ...(proxyOrigin
        ? {
            TAKOSERVER_QUEUE_RESTART_FIXTURE_MODE: "preload",
            TAKOSERVER_QUEUE_RESTART_PROXY_ORIGIN: proxyOrigin,
          }
        : {}),
    });
    let verifierServer: ReturnType<typeof Bun.serve> | undefined;
    let proxyProcess: ReturnType<typeof Bun.spawn> | undefined;
    let firstHost: ReturnType<typeof Bun.spawn> | undefined;
    let secondHost: ReturnType<typeof Bun.spawn> | undefined;
    let firstHostDescendants: Map<string, ProcessIdentity> | undefined;
    let secondHostDescendants: Map<string, ProcessIdentity> | undefined;
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    const cleanupFailures: string[] = [];

    try {
      const tls = await createTls(tlsDirectory);
      const database = new Database(databasePath);
      try {
        migrateSqlite(database);
      } finally {
        database.close();
      }
      await ensureOperatorKey({
        hasIdentityProvider: false,
        path: join(dataRoot, "operator-key.jwk"),
        async readFile(path) {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return null;
          }
        },
        async writeFile(path, contents) {
          writeFileSync(path, contents, { mode: 0o600 });
        },
      });

      // Host #0 creates the test-owned organization and API key. It then exits
      // before the official admission command opens the durable database.
      firstHost = startHost(hostEnvironment());
      await waitForHost(firstHost);
      const privateOperatorKey = readFileSync(join(dataRoot, "operator-key.jwk"), "utf8");
      const assertion = await signOperatorAssertion({
        privateJwk: privateOperatorKey,
        claims: {
          purpose: "sign-in",
          aud: API_ORIGIN,
          provider: "google",
          subject: "host-queue-process-restart",
          email: "host-queue-process-restart@localhost",
          displayName: "Host queue process restart test",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
      const session = await api<Json>(API_ORIGIN, "POST", "/v1/sessions", 200, {
        provider: "google",
        method: "operator-assertion",
        assertion,
        sessionTtlSeconds: 60,
      });
      const sessionToken = stringAt(session, "sessionToken");
      const created = await api<Json>(
        API_ORIGIN,
        "POST",
        "/v1/organizations",
        201,
        { name: "Host queue process restart" },
        { authorization: `Bearer ${sessionToken}` },
      );
      const organizationId = stringAt(objectAt(created, "organization"), "id");
      const key = await api<Json>(
        API_ORIGIN,
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        201,
        {
          name: "queue-process-restart-native",
          scopes: ["resources:read", "resources:write"],
          expiresInSeconds: 600,
        },
        { authorization: `Bearer ${sessionToken}` },
      );
      const apiToken = stringAt(key, "secret");
      const ownerAuth = {
        authorization: `Bearer ${apiToken}`,
        "takoform-organization": organizationId,
      };
      await stopHost(firstHost, firstHostDescendants);
      firstHost = undefined;

      const syntheticVerifier = createSyntheticPublisherSetVerifier();
      // This replays the publisher-set verifier boundary for released package
      // bytes; it does not execute Core, Sigstore, Accounts, or OIDC.
      verifierServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => syntheticVerifier.fetch(request),
      });
      const admission = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "scripts/selfhost-form-admission.ts",
          organizationId,
          SPACE,
          "--apply",
          "--data-root",
          dataRoot,
          "--host-id",
          API_ORIGIN,
          "--core-verifier",
          `http://127.0.0.1:${verifierServer.port}`,
        ],
        {
          cwd: process.cwd(),
          env: hostEnvironment(),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const admissionExit = await Promise.race([
        admission.exited,
        Bun.sleep(30_000).then(() => null),
      ]);
      if (admissionExit === null) {
        admission.kill("SIGKILL");
        await admission.exited;
        throw new Error("selfhost_form_admission_timeout");
      }
      expect(admissionExit).toBe(0);
      verifierServer.stop(true);
      verifierServer = undefined;

      proxyProcess = Bun.spawn(
        [process.execPath, "--no-env-file", "tests/fixtures/selfhost-host-queue-process-child.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...baseEnvironment,
            TAKOSERVER_QUEUE_RESTART_FIXTURE_MODE: "proxy",
            TAKOSERVER_QUEUE_RESTART_PROXY_READY_FILE: proxyReadyFile,
            TAKOSERVER_QUEUE_RESTART_UPSTREAM_ORIGIN: "https://127.0.0.1",
            TAKOSERVER_QUEUE_RESTART_UPSTREAM_CA_FILE: join(tlsDirectory, "worker-cert.pem"),
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const proxyPort = await waitForFile(proxyReadyFile, proxyProcess);
      const proxyOrigin = `http://127.0.0.1:${proxyPort}`;

      // Host #1 accepts public Host resources and starts the actual Workerd
      // child. Identity/admission above are synthetic local fixtures only.
      firstHost = startHost(hostEnvironment(proxyOrigin));
      firstHostDescendants = new Map();
      await waitForHost(firstHost, firstHostDescendants);
      const workerAuth = ownerAuth;
      const formRefs = await discoverForms(workerAuth);
      const ref = (kind: string, name: string) => ({
        apiVersion: "edge.forms.takoform.com",
        kind,
        name,
      });
      const manifestDigest = await uploadModule(WORKER_SOURCE, workerAuth);
      await applyResource(formRefs, workerAuth, "ModuleWorker", "queue-restart-worker", {});
      await applyResource(formRefs, workerAuth, "EdgeKVNamespace", "queue-restart-kv", {});
      await applyResource(formRefs, workerAuth, "AtLeastOnceQueue", "queue-restart-source", {
        messageRetentionSeconds: 345_600,
        deliveryDelaySeconds: 0,
      });
      await applyResource(formRefs, workerAuth, "ObjectBucket", "queue-restart-bucket", {});
      await applyResource(formRefs, workerAuth, "WorkerBundle", "queue-restart-bundle", {
        manifestDigest,
      });
      await applyResource(formRefs, workerAuth, "WorkerVersion", "queue-restart-version", {
        worker: ref("ModuleWorker", "queue-restart-worker"),
        bundle: ref("WorkerBundle", "queue-restart-bundle"),
        handlers: ["fetch", "queue"],
        requiredSensitiveVars: [],
        kvBindings: [{ name: "KV", resource: ref("EdgeKVNamespace", "queue-restart-kv") }],
        bucketBindings: [{ name: "BUCKET", resource: ref("ObjectBucket", "queue-restart-bucket") }],
        queueProducerBindings: [
          { name: "QUEUE", resource: ref("AtLeastOnceQueue", "queue-restart-source") },
        ],
      });
      await applyResource(formRefs, workerAuth, "WorkerDeployment", "queue-restart-live", {
        worker: ref("ModuleWorker", "queue-restart-worker"),
        versions: [
          { workerVersion: ref("WorkerVersion", "queue-restart-version"), weight: 10_000 },
        ],
      });
      const endpoint = await applyResource(
        formRefs,
        workerAuth,
        "WorkerEndpoint",
        "queue-restart-endpoint",
        { worker: ref("ModuleWorker", "queue-restart-worker") },
      );
      await applyResource(formRefs, workerAuth, "QueueConsumer", "queue-restart-consumer", {
        worker: ref("ModuleWorker", "queue-restart-worker"),
        queue: ref("AtLeastOnceQueue", "queue-restart-source"),
        maxBatchSize: 1,
        maxBatchTimeoutSeconds: 0,
        maxConcurrency: 1,
        maxRetries: 2,
        retryDelaySeconds: 1,
      });
      const endpointUrl = new URL(outputAt(endpoint, "url"));
      expect(endpointUrl.protocol).toBe("https:");
      expect(endpointUrl.port).toBe("");
      const hostname = endpointUrl.hostname;
      const requestWorker = (path: string, method = "GET") =>
        workerRequest(hostname, path, tls.certificateChain, method);
      const ready = await requestWorker("/");
      expect(ready.status).toBe(200);
      await ready.arrayBuffer();

      const accepted = await requestWorker("/send", "POST");
      expect(accepted.status).toBe(200);
      const acceptedBody = (await accepted.json()) as { id: string };
      expect(acceptedBody.id).toMatch(/^[0-9a-f-]{36}$/u);

      const firstAck = await waitForProxyObservation(proxyOrigin, 1, proxyProcess);
      expect(firstAck).toEqual({
        messageId: acceptedBody.id,
        attempts: 1,
        status: 200,
        acknowledged: true,
        withheld: true,
      });
      expect(await readSeen(requestWorker)).toEqual([{ id: acceptedBody.id, attempts: 1 }]);
      expect(await readObject(requestWorker)).toBe("persisted-before-unknown-ack");

      const firstHostIdentity = processIdentity(firstHost.pid);
      const firstWorkerd = uniqueLiveWorkerd(firstHost, firstHostDescendants);
      await crashHost(firstHost, firstHostDescendants, firstHostIdentity, firstWorkerd);
      firstHost = undefined;
      const databaseIdentity = fileIdentity(databasePath);
      const objectRoot = selfhostObjectsRoot(dataRoot);
      const objectSnapshot = directorySnapshot(objectRoot);
      expect(objectSnapshot.length).toBeGreaterThan(0);

      secondHost = startHost(hostEnvironment(proxyOrigin));
      secondHostDescendants = new Map();
      await waitForHost(secondHost, secondHostDescendants);
      const secondHostIdentity = processIdentity(secondHost.pid);
      const secondWorkerd = uniqueLiveWorkerd(secondHost, secondHostDescendants);
      expect(secondHostIdentity.pid).not.toBe(firstHostIdentity.pid);
      expect(sameIdentity(secondHostIdentity, firstHostIdentity)).toBe(false);
      expect(secondWorkerd.pid).not.toBe(firstWorkerd.pid);
      expect(sameIdentity(secondWorkerd, firstWorkerd)).toBe(false);
      expect(fileIdentity(databasePath)).toEqual(databaseIdentity);
      expect(directorySnapshot(objectRoot)).toEqual(objectSnapshot);
      expect(await readSeen(requestWorker)).toEqual([{ id: acceptedBody.id, attempts: 1 }]);
      expect(await readObject(requestWorker)).toBe("persisted-before-unknown-ack");

      // Queue visibility is the existing 120s persisted lease. Wait for its
      // expiry rather than editing clocks, leases, or SQLite rows in the test.
      const secondAck = await waitForProxyObservation(proxyOrigin, 2, proxyProcess, 145_000);
      expect(secondAck).toEqual({
        messageId: acceptedBody.id,
        attempts: 2,
        status: 200,
        acknowledged: true,
        withheld: false,
      });
      expect(await readSeen(requestWorker)).toEqual([
        { id: acceptedBody.id, attempts: 1 },
        { id: acceptedBody.id, attempts: 2 },
      ]);
      expect(await readObject(requestWorker)).toBe("persisted-before-unknown-ack");
      await Bun.sleep(2_500);
      expect(await proxyObservations(proxyOrigin, proxyProcess)).toHaveLength(2);
      expect(await readSeen(requestWorker)).toEqual([
        { id: acceptedBody.id, attempts: 1 },
        { id: acceptedBody.id, attempts: 2 },
      ]);
      expect(directorySnapshot(objectRoot)).toEqual(objectSnapshot);
    } catch (error) {
      primaryFailure = error;
      hasPrimaryFailure = true;
    } finally {
      for (const [host, descendants] of [
        [secondHost, secondHostDescendants],
        [firstHost, firstHostDescendants],
      ] as const) {
        if (!host) continue;
        try {
          await stopHost(host, descendants);
        } catch (error) {
          cleanupFailures.push(errorTag(error));
        }
      }
      if (proxyProcess) {
        try {
          if (proxyProcess.exitCode === null) proxyProcess.kill("SIGTERM");
          const proxyExit = await Promise.race([
            proxyProcess.exited,
            Bun.sleep(5_000).then(() => null),
          ]);
          if (proxyExit === null) {
            proxyProcess.kill("SIGKILL");
            const killedExit = await Promise.race([
              proxyProcess.exited,
              Bun.sleep(5_000).then(() => null),
            ]);
            if (killedExit === null) cleanupFailures.push("queue_proxy_kill_timeout");
            else cleanupFailures.push("queue_proxy_stop_timeout");
          }
        } catch {
          cleanupFailures.push("queue_proxy_cleanup_failed");
        }
      }
      verifierServer?.stop(true);
      if (cleanupFailures.length === 0) rmSync(fixture, { recursive: true, force: true });
    }
    if (cleanupFailures.length > 0) {
      const primaryTag = hasPrimaryFailure ? errorTag(primaryFailure) : "none";
      throw new Error(
        `selfhost_queue_process_cleanup_${cleanupFailures.join("_")}_after_${primaryTag}`,
      );
    }
    if (hasPrimaryFailure) throw primaryFailure;
  },
  240_000,
);

function childEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    CI: "1",
    NO_COLOR: "1",
    CHECKPOINT_DISABLE: "1",
  };
}

function startHost(environment: Record<string, string>): ReturnType<typeof Bun.spawn> {
  const preload =
    environment.TAKOSERVER_QUEUE_RESTART_FIXTURE_MODE === "preload"
      ? ["--preload", "tests/fixtures/selfhost-host-queue-process-child.ts"]
      : [];
  const host = Bun.spawn([process.execPath, "--no-env-file", ...preload, "src/entry-bun.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const dataRoot = environment.TAKOSERVER_DATA_ROOT;
  if (dataRoot) hostDataRoots.set(host, dataRoot);
  return host;
}

async function waitForHost(
  host: ReturnType<typeof Bun.spawn>,
  descendants?: Map<string, ProcessIdentity>,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (descendants) rememberDescendants(host.pid, descendants);
    if (host.exitCode !== null) throw new Error(`selfhost_host_start_exit_${await host.exited}`);
    try {
      const response = await fetch(`${API_ORIGIN}/.well-known/takoform/v1`, {
        signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Readiness is the public Host listener, not a child log line.
    }
    await Bun.sleep(50);
  }
  throw new Error("selfhost_host_listener_not_ready");
}

async function stopHost(
  host: ReturnType<typeof Bun.spawn>,
  knownDescendants: Map<string, ProcessIdentity> | undefined,
): Promise<void> {
  const descendants = knownDescendants ?? new Map<string, ProcessIdentity>();
  rememberDescendants(host.pid, descendants);
  if (host.exitCode !== null || host.signalCode !== null) {
    throw new Error("selfhost_host_exited_before_stop");
  }
  host.kill("SIGTERM");
  const exitCode = await Promise.race([host.exited, Bun.sleep(10_000).then(() => null)]);
  if (exitCode === null) {
    host.kill("SIGKILL");
    const killedExit = await Promise.race([host.exited, Bun.sleep(5_000).then(() => null)]);
    if (killedExit === null) throw new Error("selfhost_host_kill_timeout");
  }
  await waitForProcessIdentitiesGone(descendants.values());
  await waitForPortClosed(API_PORT);
  await waitForPortClosed(WORKERD_PORT);
  const finalExitCode = exitCode ?? host.exitCode;
  if (finalExitCode !== 0) throw new Error(`selfhost_host_exit_nonzero_${finalExitCode}`);
}

async function crashHost(
  host: ReturnType<typeof Bun.spawn>,
  knownDescendants: Map<string, ProcessIdentity>,
  hostIdentity: ProcessIdentity,
  workerd: ProcessIdentity,
): Promise<void> {
  const descendants = knownDescendants;
  rememberDescendants(host.pid, descendants);
  if (host.exitCode !== null || host.signalCode !== null) {
    throw new Error("selfhost_host_exited_before_crash");
  }
  const currentHost = processIdentity(host.pid);
  if (
    !sameIdentity(currentHost, hostIdentity) ||
    currentHost.executable !== hostIdentity.executable
  ) {
    throw new Error("selfhost_host_identity_changed_before_crash");
  }
  const currentWorkerd = uniqueLiveWorkerd(host, descendants);
  if (!sameIdentity(currentWorkerd, workerd) || currentWorkerd.executable !== workerd.executable) {
    throw new Error("selfhost_workerd_identity_changed_before_crash");
  }
  host.kill("SIGKILL");
  const exitCode = await Promise.race([host.exited, Bun.sleep(10_000).then(() => null)]);
  if (exitCode === null) throw new Error("selfhost_host_sigkill_timeout");
  expect(host.signalCode).toBe("SIGKILL");

  // A SIGKILL cannot run Host shutdown hooks. If its one verified Workerd
  // child remains, signal only that exact PID while its start time and
  // executable still match the identity captured before the Host crash.
  if (identityIsLive(workerd)) {
    const current = processIdentity(workerd.pid);
    if (sameIdentity(current, workerd) && current.executable === workerd.executable) {
      try {
        process.kill(workerd.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw new Error("selfhost_workerd_sigkill_failed");
        }
      }
    }
  }
  await waitForProcessIdentitiesGone(descendants.values());
  await waitForPortClosed(API_PORT);
  await waitForPortClosed(WORKERD_PORT);
}

function uniqueLiveWorkerd(
  host: ReturnType<typeof Bun.spawn>,
  descendants: Map<string, ProcessIdentity>,
): ProcessIdentity {
  rememberDescendants(host.pid, descendants);
  const expected = acceptedWorkerdPath(hostDataRootFromHost(host));
  const matches = [...descendants.values()].filter(
    (identity) => identity.executable === expected && identityIsLive(identity),
  );
  if (matches.length !== 1) throw new Error("selfhost_expected_one_live_workerd_child");
  return matches[0] as ProcessIdentity;
}

// Every Host in this test has the same exact data root. The child Environment
// is recorded on the Bun subprocess to avoid inspecting application state.
const hostDataRoots = new WeakMap<ReturnType<typeof Bun.spawn>, string>();

function hostDataRootFromHost(host: ReturnType<typeof Bun.spawn>): string {
  const root = hostDataRoots.get(host);
  if (!root) throw new Error("selfhost_host_data_root_not_recorded");
  return root;
}

function acceptedWorkerdPath(dataRoot: string): string {
  return join(
    dataRoot,
    "runtime-probes",
    "artifacts",
    `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.sha256}`,
  );
}

function processIdentity(pid: number): ProcessIdentity {
  const stat = processStat(pid);
  const executable = processExecutable(pid);
  if (!stat || !executable) throw new Error("selfhost_process_identity_not_live");
  return { pid, startTicks: stat.startTicks, executable };
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.startTicks === right.startTicks;
}

function identityIsLive(identity: ProcessIdentity): boolean {
  const stat = processStat(identity.pid);
  return (
    stat?.startTicks === identity.startTicks &&
    processExecutable(identity.pid) === identity.executable
  );
}

function rememberDescendants(rootPid: number, output: Map<string, ProcessIdentity>): void {
  const processes = new Map<number, { readonly parentPid: number; readonly startTicks: string }>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    const stat = processStat(pid);
    if (stat) processes.set(pid, stat);
  }
  const children = new Map<number, number[]>();
  for (const [pid, stat] of processes) {
    const siblings = children.get(stat.parentPid) ?? [];
    siblings.push(pid);
    children.set(stat.parentPid, siblings);
  }
  const pending = [...(children.get(rootPid) ?? [])];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    const stat = processes.get(pid);
    if (!stat) continue;
    const executable = processExecutable(pid);
    if (executable) {
      const identity = { pid, startTicks: stat.startTicks, executable };
      output.set(`${pid}:${stat.startTicks}`, identity);
    }
    pending.push(...(children.get(pid) ?? []));
  }
}

function processStat(
  pid: number,
): { readonly parentPid: number; readonly startTicks: string } | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw new Error("selfhost_process_identity_read_failed");
  }
  const commandEnd = text.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("selfhost_process_identity_malformed");
  const fields = text
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const parentPid = Number(fields[1]);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(parentPid) || typeof startTicks !== "string") {
    throw new Error("selfhost_process_identity_malformed");
  }
  return { parentPid, startTicks };
}

function processExecutable(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw new Error("selfhost_process_identity_read_failed");
  }
}

async function waitForProcessIdentitiesGone(identities: Iterable<ProcessIdentity>): Promise<void> {
  const retained = [...identities];
  const deadline = Date.now() + 5_000;
  while (
    retained.some((identity) => processStat(identity.pid)?.startTicks === identity.startTicks)
  ) {
    if (Date.now() >= deadline) throw new Error("selfhost_descendant_quiescence_timeout");
    await Bun.sleep(25);
  }
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await tcpPortIsClosed(port)) return;
    await Bun.sleep(50);
  }
  throw new Error(`selfhost_listener_quiescence_timeout_${port}`);
}

function tcpPortIsClosed(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`selfhost_listener_probe_timeout_${port}`));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function objectAt(value: Json, key: string): Json {
  const child = value[key];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    throw new Error(`selfhost_response_object_missing_${key}`);
  }
  return child as Json;
}

function stringAt(value: Json, key: string): string {
  const child = value[key];
  if (typeof child !== "string") throw new Error(`selfhost_response_string_missing_${key}`);
  return child;
}

function outputAt(value: Json, name: string): string {
  return stringAt(objectAt(objectAt(value, "status"), "outputs"), name);
}

async function api<T extends Json>(
  origin: string,
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== expectedStatus) {
    await response.arrayBuffer();
    throw new Error(`selfhost_api_${method}_${path}_status_${response.status}`);
  }
  return (await response.json()) as T;
}

async function discoverForms(auth: Record<string, string>): Promise<Map<string, Json>> {
  const response = await api<Json>(
    API_ORIGIN,
    "GET",
    `${LANE}/forms?space=${SPACE}`,
    200,
    undefined,
    auth,
  );
  if (!Array.isArray(response.forms)) throw new Error("selfhost_form_discovery_shape_invalid");
  const forms = new Map<string, Json>();
  for (const entry of response.forms) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const form = (entry as Json).identity;
    if (typeof form !== "object" || form === null || Array.isArray(form)) continue;
    const formRef = (form as Json).formRef;
    if (
      typeof formRef === "object" &&
      formRef !== null &&
      !Array.isArray(formRef) &&
      typeof (formRef as Json).kind === "string"
    ) {
      forms.set((formRef as Json).kind as string, formRef as Json);
    }
  }
  return forms;
}

async function uploadModule(source: string, auth: Record<string, string>): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const digest = await bytesDigest(bytes);
  const upload = await api<Json>(
    API_ORIGIN,
    "POST",
    `${LANE}/artifacts/uploads`,
    201,
    {
      manifest: {
        apiVersion: "artifacts.takoform.com/v1alpha1",
        kind: "WorkerBundle",
        mainModule: "index.js",
        modules: [
          {
            name: "index.js",
            mediaType: "application/javascript+module",
            size: bytes.byteLength,
            digest,
          },
        ],
      },
    },
    auth,
  );
  const uploadId = stringAt(upload, "uploadId");
  const uploaded = await fetch(
    new URL(`${LANE}/artifacts/uploads/${uploadId}/blobs/${digest}`, API_ORIGIN),
    { method: "PUT", headers: auth, body: bytes },
  );
  if (uploaded.status !== 201) {
    await uploaded.arrayBuffer();
    throw new Error(`selfhost_worker_blob_upload_status_${uploaded.status}`);
  }
  await uploaded.arrayBuffer();
  const committed = await api<Json>(
    API_ORIGIN,
    "POST",
    `${LANE}/artifacts/uploads/${uploadId}/commit`,
    201,
    undefined,
    { ...auth, "idempotency-key": "queue-process-restart-artifact-commit" },
  );
  return stringAt(committed, "manifestDigest");
}

async function applyResource(
  forms: Map<string, Json>,
  auth: Record<string, string>,
  kind: string,
  name: string,
  spec: Json,
): Promise<Json> {
  const formRef = forms.get(kind);
  if (!formRef) throw new Error(`selfhost_form_missing_${kind}`);
  const desired = {
    apiVersion: stringAt(formRef, "apiVersion"),
    kind,
    form: { formRef },
    metadata: { name, space: SPACE },
    spec,
  };
  const prepared = await api<Json>(
    API_ORIGIN,
    "POST",
    `${LANE}/resources/prepare`,
    200,
    desired,
    auth,
  );
  const query = new URLSearchParams({
    space: SPACE,
    definitionVersion: stringAt(formRef, "definitionVersion"),
    schemaDigest: stringAt(formRef, "schemaDigest"),
  });
  return api<Json>(
    API_ORIGIN,
    "PUT",
    `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${query}`,
    201,
    { ...desired, review: objectAt(prepared, "review") },
    {
      ...auth,
      "idempotency-key": `queue-process-restart-${kind}-${name}`,
      "if-none-match": "*",
    },
  );
}

async function workerRequest(
  hostname: string,
  path: string,
  ca: string,
  method = "GET",
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: WORKERD_PORT,
        servername: hostname,
        path,
        method,
        ca,
        headers: { host: hostname },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () =>
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 })),
        );
      },
    );
    request.setTimeout(2_000, () => request.destroy(new Error("worker_https_request_timeout")));
    request.on("error", reject);
    request.end();
  });
}

async function readSeen(
  requestWorker: (path: string, method?: string) => Promise<Response>,
): Promise<readonly { readonly id: string; readonly attempts: number }[]> {
  const response = await requestWorker("/seen");
  if (response.status !== 200) throw new Error(`worker_seen_status_${response.status}`);
  const body = (await response.json()) as { readonly seen?: unknown };
  if (!Array.isArray(body.seen)) throw new Error("worker_seen_shape_invalid");
  return body.seen as { readonly id: string; readonly attempts: number }[];
}

async function readObject(
  requestWorker: (path: string, method?: string) => Promise<Response>,
): Promise<string> {
  const response = await requestWorker("/object");
  if (response.status !== 200) throw new Error(`worker_object_status_${response.status}`);
  return response.text();
}

async function waitForFile(path: string, owner: ReturnType<typeof Bun.spawn>): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const port = Number(readFileSync(path, "utf8"));
      if (Number.isSafeInteger(port) && port > 0 && port < 65_536) return port;
      throw new Error("queue_proxy_ready_port_invalid");
    }
    if (owner.exitCode !== null) throw new Error("queue_proxy_child_exited_before_ready");
    await Bun.sleep(25);
  }
  throw new Error("queue_proxy_ready_timeout");
}

async function proxyObservations(
  proxyOrigin: string,
  owner: ReturnType<typeof Bun.spawn>,
): Promise<readonly ProxyObservation[]> {
  if (owner.exitCode !== null) throw new Error("queue_proxy_child_exited");
  const response = await fetch(`${proxyOrigin}/__test/status`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (response.status !== 200) throw new Error("queue_proxy_status_unavailable");
  const body = (await response.json()) as { readonly observations?: unknown };
  if (!Array.isArray(body.observations)) throw new Error("queue_proxy_status_shape_invalid");
  return body.observations as ProxyObservation[];
}

async function waitForProxyObservation(
  proxyOrigin: string,
  count: number,
  owner: ReturnType<typeof Bun.spawn>,
  timeoutMillis = 15_000,
): Promise<ProxyObservation> {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    const observations = await proxyObservations(proxyOrigin, owner);
    if (observations.length >= count) return observations[count - 1] as ProxyObservation;
    await Bun.sleep(25);
  }
  throw new Error(`queue_proxy_observation_timeout_${count}`);
}

async function createTls(directory: string): Promise<{
  readonly certificateChain: string;
  readonly privateKey: string;
}> {
  const keyPath = join(directory, "worker-key.pem");
  const certificatePath = join(directory, "worker-cert.pem");
  const generated = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=queue-process-restart-test",
      "-addext",
      `subjectAltName=DNS:*.${WORKER_SUFFIX},IP:127.0.0.1`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await generated.exited) !== 0) throw new Error("queue_test_certificate_generation_failed");
  chmodSync(keyPath, 0o600);
  chmodSync(certificatePath, 0o600);
  return {
    certificateChain: readFileSync(certificatePath, "utf8"),
    privateKey: readFileSync(keyPath, "utf8"),
  };
}

function fileIdentity(path: string): { readonly dev: number; readonly ino: number } {
  const stat = statSync(path);
  return { dev: stat.dev, ino: stat.ino };
}

function directorySnapshot(root: string): readonly {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly digest: string;
}[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) files.push(path);
    }
  }
  return files.sort().map((path) => {
    const stat = statSync(path);
    return {
      path: relative(root, path),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  });
}

function errorTag(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_]+$/u.test(error.message) ? error.message : "unknown";
}
