import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { takoformCoreVerifierArtifactDigest } from "../scripts/deploy/form-authority.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { loadPublisherSetClosure } from "../src/takoform/publisher-set-closure.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import { workerPortOwnership } from "../src/workerd-linux-process.ts";
import { assertIsolatedSelfhostNativeEnvironment } from "./helpers/isolated-selfhost-native.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";
import {
  buildRealCoreVerifier,
  realCoreVerificationRequest,
} from "./helpers/real-core-verifier.ts";

// Presence is the explicit native-evidence opt-in. A configured but invalid or
// wrong workerd fails inside the test; it never silently substitutes another binary.
const WORKERD = nativeEvidenceBinary("workerd-artifact") ?? null;
const PUBLIC_ORIGIN = "http://127.0.0.1:8788";
const HOST_PORT = 8787;
const PUBLIC_PROXY_PORT = 8788;
const CORE_PORT = 8080;
const WORKER_PORT = 443;
const HOST_SUFFIX = "apps.actor-selfhost.test";
const LANE = "/apis/forms.takoform.com/v1";
const SPACE = "default";
const ACTOR_NAME = "same-room";
const BOOTSTRAP_DIAGNOSTIC_COMPLETE = Symbol("bootstrap_diagnostic_complete");
const WORKER_MODULE = `
export class Counter {
  constructor(context, env) { this.context = context; this.env = env; }
  async start() {
    await this.context.storage.execute("CREATE TABLE IF NOT EXISTS actor_counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/write") {
      const result = await this.context.storage.execute("INSERT INTO actor_counter VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1 RETURNING value");
      return Response.json({ id: this.context.id, value: Number(result.rows[0].value), version: this.env.VERSION });
    }
    if (path === "/read") {
      const result = await this.context.storage.query("SELECT value FROM actor_counter WHERE id = 1");
      return Response.json({ id: this.context.id, value: Number(result.rows[0]?.value ?? 0), version: this.env.VERSION });
    }
    if (path === "/socket") return (await this.context.sockets.accept(request)).response;
    return new Response(null, { status: 404 });
  }
  async alarm() {}
  async socketMessage(socket, data) { socket.send(this.env.VERSION + ":" + String(data)); }
  async socketClose() {}
}
export default {
  async fetch(request, env) {
    const id = env.ROOMS.idFromName(${JSON.stringify(ACTOR_NAME)});
    return env.ROOMS.get(id).fetch(request);
  },
};
`;

type Json = Record<string, unknown>;
type Child = ReturnType<typeof Bun.spawn>;
type ProcessIdentity = {
  readonly pid: number;
  readonly startTicks: string;
  readonly executable: string;
};
type HostReadinessObservation = {
  readonly hostPortOwnershipBefore: "owned";
  readonly hostPortOwnershipAfter: "owned";
  readonly directStatus: 200;
  readonly publicStatus: 200;
  readonly discoveryBodyBytes: number;
  readonly discoveryBodySha256: string;
};
type HostOutputObservation = {
  readonly state: {
    operatorKeyGeneratedAtExpectedPath: boolean;
    listeningAtConfiguredPort: boolean;
    stderrPresent: boolean;
    stderrClasses: string[];
  };
  readonly drained: Promise<void>;
};
type Auth = Record<string, string>;
type FormMap = Map<string, Json>;

test("public Actor proxy returns explicit 502 when its Host upstream is absent", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("actor_proxy_probe_port_missing");
  const upstreamPort = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );

  const proxy = await createPublicApiProxy(upstreamPort, 0);
  try {
    const address = proxy.server.address();
    if (!address || typeof address === "string")
      throw new Error("actor_proxy_probe_listener_missing");
    const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/takoform/v1`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(502);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  } finally {
    await closePublicApiProxy(proxy);
  }
});

test("public Actor proxy preserves successful upstream headers and streamed body", async () => {
  const upstream = createServer((_incoming, outgoing) => {
    outgoing.writeHead(200, {
      "content-type": "application/json",
      "x-upstream-marker": "preserved",
    });
    outgoing.write('{"part":');
    setTimeout(() => outgoing.end("true}"), 10);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    throw new Error("actor_proxy_upstream_port_missing");
  }
  const proxy = await createPublicApiProxy(upstreamAddress.port, 0);
  try {
    const publicAddress = proxy.server.address();
    if (!publicAddress || typeof publicAddress === "string") {
      throw new Error("actor_proxy_listener_missing");
    }
    const response = await fetch(`http://127.0.0.1:${publicAddress.port}/stream`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-marker")).toBe("preserved");
    expect(await response.text()).toBe('{"part":true}');
  } finally {
    await closePublicApiProxy(proxy);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test.skipIf(process.platform !== "linux")(
  "SIGTERM child completion is terminal for native-fixture cleanup",
  async () => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--eval", "setInterval(() => {}, 1_000)"],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      const identity = processIdentity(child.pid);
      child.kill("SIGTERM");
      const exitStatus = await Promise.race([child.exited, Bun.sleep(2_000).then(() => null)]);

      expect(exitStatus).toBe(143);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe("SIGTERM");
      expect(identityIsLive(identity)).toBe(false);
      expect(childHasTerminated(child)).toBe(true);
    } finally {
      if (!childHasTerminated(child)) child.kill("SIGKILL");
    }
  },
);

test.skipIf(WORKERD === null)(
  "public Host routes a released Actor over HTTP/WSS and restores it after SIGTERM Host restarts",
  async () => {
    const coreDigest = takoformCoreVerifierArtifactDigest();
    const fixture = mkdtempSync(join(tmpdir(), "a-"));
    const dataRoot = join(fixture, "data");
    const home = join(fixture, "home");
    const tlsDirectory = join(fixture, "tls");
    const controlDatabase = join(fixture, "control.sqlite");
    let verifier: Child | undefined;
    let host: Child | undefined;
    let admission: Child | undefined;
    let proxy: PublicApiProxy | undefined;
    let hostOutput: HostOutputObservation | undefined;
    let diagnosticHostIdentity: ProcessIdentity | undefined;
    let diagnosticVerifierIdentity: ProcessIdentity | undefined;
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    try {
      mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 });
      chmodSync(fixture, 0o700);
      const worstCaseUpgradeSocket = join(
        dataRoot,
        "actor-forward-sockets",
        `actor-${"x".repeat(6)}`,
        `${"0".repeat(20)}.u.sock`,
      );
      expect(Buffer.byteLength(worstCaseUpgradeSocket)).toBeLessThan(100);
      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [HOST_PORT, PUBLIC_PROXY_PORT, CORE_PORT, WORKER_PORT],
      });

      const baseEnvironment = childEnvironment(home);
      const hostEnvironment = {
        ...baseEnvironment,
        TAKOSERVER_DATA_ROOT: dataRoot,
        TAKOSERVER_DB: controlDatabase,
        TAKOSERVER_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        PORT: String(HOST_PORT),
        TAKOSERVER_WORKERD_BINARY: WORKERD as string,
        TAKOSERVER_WORKERD_PORT: String(WORKER_PORT),
        TAKOSERVER_WORKER_ENDPOINT_PORT: String(WORKER_PORT),
        TAKOSERVER_WORKER_ENDPOINT_SUFFIX: HOST_SUFFIX,
        TAKOSERVER_WORKERD_TLS_CERT_FILE: join(tlsDirectory, "worker-cert.pem"),
        TAKOSERVER_WORKERD_TLS_KEY_FILE: join(tlsDirectory, "worker-key.pem"),
      };
      proxy = await createPublicApiProxy(HOST_PORT, PUBLIC_PROXY_PORT);
      const verifierBinary = await buildRealCoreVerifier(join(fixture, "core-verifier"));
      verifier = Bun.spawn([verifierBinary], {
        cwd: process.cwd(),
        env: { ...baseEnvironment, TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: coreDigest },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await waitForCoreVerifier(verifier, coreDigest);
      await createTls(tlsDirectory);

      const bootstrapDiagnostic = process.env.TAKOSERVER_ACTOR_BOOTSTRAP_DIAGNOSTIC === "1";
      if (bootstrapDiagnostic) {
        const captured = startHostWithCapturedOutput(hostEnvironment);
        host = captured.child;
        hostOutput = observeHostOutput(
          captured.stdout,
          captured.stderr,
          join(dataRoot, "operator-key.jwk"),
          HOST_PORT,
        );
      } else {
        host = startHost(hostEnvironment);
      }
      let readiness: HostReadinessObservation;
      try {
        readiness = await waitForHost(host);
      } catch (error) {
        if (bootstrapDiagnostic) {
          diagnosticHostIdentity = processIdentity(host.pid);
          diagnosticVerifierIdentity = processIdentity(verifier.pid);
          const failedDiagnostic = {
            phase: "public_host_readiness_failed",
            cwd: process.cwd(),
            configuredDataRoot: dataRoot,
            configuredDatabase: controlDatabase,
            host: diagnosticHostIdentity,
            hostExitCode: host.exitCode,
            verifier: diagnosticVerifierIdentity,
            hostPortOwnership: await workerPortOwnership(HOST_PORT, host.pid),
            proxyListenerOwnership: await workerPortOwnership(PUBLIC_PROXY_PORT, process.pid),
            operatorKey: safeFileMetadata(join(dataRoot, "operator-key.jwk")),
            controlDatabase: safeFileMetadata(controlDatabase),
            hostOutput: hostOutput?.state,
            failureClass: error instanceof Error ? error.name : "unknown",
          };
          console.log(`ACTOR_BOOTSTRAP_DIAGNOSTIC=${JSON.stringify(failedDiagnostic)}`);
        }
        throw error;
      }
      if (bootstrapDiagnostic) {
        await Bun.sleep(25);
        const keyMetadata = safeFileMetadata(join(dataRoot, "operator-key.jwk"));
        diagnosticHostIdentity = processIdentity(host.pid);
        diagnosticVerifierIdentity = processIdentity(verifier.pid);
        const diagnostic = {
          phase: "public_host_bootstrap_ready",
          cwd: process.cwd(),
          configuredDataRoot: dataRoot,
          configuredDatabase: controlDatabase,
          cwdDefaultRoot: join(process.cwd(), ".takoserver"),
          host: diagnosticHostIdentity,
          hostExitCode: host.exitCode,
          verifier: diagnosticVerifierIdentity,
          testProcess: processIdentity(process.pid),
          readiness,
          proxyListenerOwnership: await workerPortOwnership(PUBLIC_PROXY_PORT, process.pid),
          operatorKey: keyMetadata,
          controlDatabase: safeFileMetadata(controlDatabase),
          cwdDefaultRootMetadata: safeFileMetadata(join(process.cwd(), ".takoserver")),
          hostOutput: hostOutput?.state,
        };
        console.log(`ACTOR_BOOTSTRAP_DIAGNOSTIC=${JSON.stringify(diagnostic)}`);
        expect(keyMetadata.exists).toBe(true);
        expect(keyMetadata.mode).toBe("600");
        throw BOOTSTRAP_DIAGNOSTIC_COMPLETE;
      }
      const { primary, secondary, primaryOrg, secondaryOrg } =
        await bootstrapOrganizations(dataRoot);

      // The admission CLI is the same exact released-17 Core gate used by the
      // existing public Host journeys; it runs only while the Host owns no DB.
      await stopOwned(host);
      host = undefined;
      const closure = await loadPublisherSetClosure();
      const verified = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/verify-set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await realCoreVerificationRequest(closure)),
        signal: AbortSignal.timeout(20_000),
      });
      expect(verified.status).toBe(200);
      const verifiedBody = (await verified.json()) as Json;
      expect(objectAt(verifiedBody, "identity")).toMatchObject({
        coreVersion: "v1.1.0",
        coreCommit: "e0e48b864de2a127a255cb0574d37bbb0f1cac29",
      });
      expect(Array.isArray(verifiedBody.packages) ? verifiedBody.packages.length : 0).toBe(17);
      for (const organizationId of [primaryOrg, secondaryOrg]) {
        admission = Bun.spawn(
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
            PUBLIC_ORIGIN,
            "--core-verifier",
            `http://127.0.0.1:${CORE_PORT}`,
          ],
          {
            cwd: process.cwd(),
            env: hostEnvironment,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          },
        );
        const status = await Promise.race([admission.exited, Bun.sleep(120_000).then(() => null)]);
        if (status === null) throw new Error("actor_form_admission_timeout");
        const output = await new Response(admission.stdout as ReadableStream<Uint8Array>).text();
        admission = undefined;
        expect(status).toBe(0);
        expect(output).toMatch(/^apply: converged \([1-9]\d* receipt\(s\), released-core\)$/m);
      }
      host = startHost(hostEnvironment);
      await waitForHost(host);

      const primaryForms = await catalog(primary);
      const secondaryForms = await catalog(secondary);
      for (const forms of [primaryForms, secondaryForms]) assertReleasedActorClosure(forms);

      // Worker must exist before the ActorNamespace relation can be admitted.
      await apply(primary, primaryForms, "ModuleWorker", "actor-worker", {});
      await apply(secondary, secondaryForms, "ModuleWorker", "actor-worker", {});

      const actorDesired = desiredResource(primaryForms, "ActorNamespace", "actor-room", {
        className: "Counter",
        worker: reference("ModuleWorker", "actor-worker"),
      });
      const actorCreate = await preparePut(primary, actorDesired, "actor-primary-create");
      proxy.dropNextAck("actor-primary-create");
      let acknowledgementWasLost = false;
      try {
        await putPrepared(primary, actorCreate, "actor-primary-create", [201]);
      } catch {
        acknowledgementWasLost = proxy.wasDropped("actor-primary-create");
      }
      expect(acknowledgementWasLost).toBe(true);
      const preRestartActor = await getResource(
        primary,
        primaryForms,
        "ActorNamespace",
        "actor-room",
      );
      const actorUid = stringAt(objectAt(preRestartActor, "metadata"), "uid");

      const moduleBytes = new TextEncoder().encode(WORKER_MODULE);
      const moduleDigest = await crypto.subtle.digest("SHA-256", moduleBytes);
      const digest = `sha256:${Buffer.from(moduleDigest).toString("hex")}`;
      const manifest = {
        apiVersion: "artifacts.takoform.com/v1alpha1",
        kind: "WorkerBundle",
        mainModule: "index.js",
        modules: [
          {
            name: "index.js",
            mediaType: "application/javascript+module",
            size: moduleBytes.byteLength,
            digest,
          },
        ],
      };
      const manifestPrimary = await uploadBundle(
        primary,
        manifest,
        digest,
        moduleBytes,
        "actor-primary",
      );
      const manifestSecondary = await uploadBundle(
        secondary,
        manifest,
        digest,
        moduleBytes,
        "actor-secondary",
      );
      await apply(primary, primaryForms, "WorkerBundle", "actor-bundle", {
        manifestDigest: manifestPrimary,
      });
      await apply(secondary, secondaryForms, "WorkerBundle", "actor-bundle", {
        manifestDigest: manifestSecondary,
      });
      await apply(
        primary,
        primaryForms,
        "WorkerVersion",
        "actor-v1",
        workerVersion("actor-worker", "actor-room", "actor-bundle", "v1"),
      );
      await apply(
        primary,
        primaryForms,
        "WorkerVersion",
        "actor-v2",
        workerVersion("actor-worker", "actor-room", "actor-bundle", "v2"),
      );

      // Exact idempotent replay follows a real Host process stop and restoration
      // of the same root; no private Actor owner API is used by this test.
      const originalHost = host;
      const oldHostIdentity = processIdentity(originalHost.pid);
      await stopOwned(originalHost);
      host = startHost(hostEnvironment);
      await waitForHost(host);
      const restoredAfterReplayRestart = processIdentity(host.pid);
      expect(identityIsLive(oldHostIdentity)).toBe(false);
      expect(restoredAfterReplayRestart).not.toEqual(oldHostIdentity);
      const restoredActor = await getResource(
        primary,
        primaryForms,
        "ActorNamespace",
        "actor-room",
      );
      expect(stringAt(objectAt(restoredActor, "metadata"), "uid")).toBe(actorUid);
      const replayedActor = await putPrepared(
        primary,
        actorCreate,
        "actor-primary-create",
        [200, 201],
      );
      expect(stringAt(objectAt(replayedActor, "metadata"), "uid")).toBe(actorUid);
      expect(
        stringAt(
          objectAt(
            await getResource(primary, primaryForms, "ActorNamespace", "actor-room"),
            "metadata",
          ),
          "uid",
        ),
      ).toBe(actorUid);

      await expectMissing(secondary, secondaryForms, "ActorNamespace", "actor-room");
      const secondaryActor = await apply(
        secondary,
        secondaryForms,
        "ActorNamespace",
        "actor-room",
        { className: "Counter", worker: reference("ModuleWorker", "actor-worker") },
      );
      const secondaryUid = stringAt(objectAt(secondaryActor, "metadata"), "uid");
      expect(secondaryUid).not.toBe(actorUid);

      const primaryDeployment = await apply(
        primary,
        primaryForms,
        "WorkerDeployment",
        "actor-deployment",
        {
          worker: reference("ModuleWorker", "actor-worker"),
          versions: [{ workerVersion: reference("WorkerVersion", "actor-v1"), weight: 10_000 }],
        },
      );
      const primaryEndpoint = await apply(
        primary,
        primaryForms,
        "WorkerEndpoint",
        "actor-endpoint",
        {
          worker: reference("ModuleWorker", "actor-worker"),
        },
      );
      await apply(
        secondary,
        secondaryForms,
        "WorkerVersion",
        "actor-v1",
        workerVersion("actor-worker", "actor-room", "actor-bundle", "v1"),
      );
      await apply(secondary, secondaryForms, "WorkerDeployment", "actor-deployment", {
        worker: reference("ModuleWorker", "actor-worker"),
        versions: [{ workerVersion: reference("WorkerVersion", "actor-v1"), weight: 10_000 }],
      });
      const secondaryEndpoint = await apply(
        secondary,
        secondaryForms,
        "WorkerEndpoint",
        "actor-endpoint",
        {
          worker: reference("ModuleWorker", "actor-worker"),
        },
      );
      const primaryUrl = output(primaryEndpoint, "url");
      const secondaryUrl = output(secondaryEndpoint, "url");
      const primaryHostname = new URL(primaryUrl).hostname;
      const secondaryHostname = new URL(secondaryUrl).hostname;
      expect(new URL(primaryUrl).protocol).toBe("https:");
      expect(new URL(secondaryUrl).protocol).toBe("https:");
      const certificate = join(tlsDirectory, "worker-cert.pem");

      expect(await workerJson(primaryHostname, certificate, "/write")).toMatchObject({
        id: expect.any(String),
        value: 1,
        version: "v1",
      });
      expect(await workerJson(secondaryHostname, certificate, "/write")).toMatchObject({
        id: expect.any(String),
        value: 1,
        version: "v1",
      });
      const primaryId = stringAt(await workerJson(primaryHostname, certificate, "/read"), "id");
      const secondaryId = stringAt(await workerJson(secondaryHostname, certificate, "/read"), "id");
      expect(primaryId).toBe(secondaryId);
      expect(
        await workerSocketEcho(primaryHostname, certificate, "/socket", "before-restart"),
      ).toBe("v1:before-restart");
      const acceptedWorkerd = acceptedWorkerdPath(dataRoot);

      const deploymentPath = resourcePath(primaryForms, "WorkerDeployment", "actor-deployment");
      const currentDeployment = await api<Json>("GET", deploymentPath, 200, undefined, primary);
      const updatedDeployment = await apply(
        primary,
        primaryForms,
        "WorkerDeployment",
        "actor-deployment",
        {
          worker: reference("ModuleWorker", "actor-worker"),
          versions: [{ workerVersion: reference("WorkerVersion", "actor-v2"), weight: 10_000 }],
        },
        currentDeployment,
      );
      expect(stringAt(objectAt(updatedDeployment, "metadata"), "uid")).toBe(
        stringAt(objectAt(primaryDeployment, "metadata"), "uid"),
      );
      expect(stringAt(objectAt(updatedDeployment, "metadata"), "revision")).not.toBe(
        stringAt(objectAt(primaryDeployment, "metadata"), "revision"),
      );
      expect(await workerJson(primaryHostname, certificate, "/read")).toMatchObject({
        value: 1,
        version: "v2",
      });
      expect(await workerSocketEcho(primaryHostname, certificate, "/socket", "after-update")).toBe(
        "v2:after-update",
      );

      const preRestartHost = host;
      const beforeRestart = processIdentity(preRestartHost.pid);
      const workerdBeforeRestart = uniqueWorkerd(preRestartHost, acceptedWorkerd);
      await stopOwned(preRestartHost);
      host = startHost(hostEnvironment);
      await waitForHost(host);
      const restoredHostIdentity = processIdentity(host.pid);
      expect(identityIsLive(beforeRestart)).toBe(false);
      expect(restoredHostIdentity).not.toEqual(beforeRestart);
      const restoredWorkerd = uniqueWorkerd(host, acceptedWorkerd);
      expect(identityIsLive(workerdBeforeRestart)).toBe(false);
      expect(restoredWorkerd).not.toEqual(workerdBeforeRestart);
      expect(restoredWorkerd.executable).toBe(acceptedWorkerd);
      const restoredDeployment = await getResource(
        primary,
        primaryForms,
        "WorkerDeployment",
        "actor-deployment",
      );
      const restoredNamespace = await getResource(
        primary,
        primaryForms,
        "ActorNamespace",
        "actor-room",
      );
      expect(stringAt(objectAt(restoredNamespace, "metadata"), "uid")).toBe(actorUid);
      expect(stringAt(objectAt(restoredDeployment, "metadata"), "uid")).toBe(
        stringAt(objectAt(primaryDeployment, "metadata"), "uid"),
      );
      expect(await workerJson(primaryHostname, certificate, "/read")).toMatchObject({
        id: primaryId,
        value: 1,
        version: "v2",
      });
      expect(await workerJson(primaryHostname, certificate, "/write")).toMatchObject({
        id: primaryId,
        value: 2,
        version: "v2",
      });
      expect(await workerJson(secondaryHostname, certificate, "/read")).toMatchObject({
        id: secondaryId,
        value: 1,
        version: "v1",
      });
      expect(await workerSocketEcho(primaryHostname, certificate, "/socket", "after-restart")).toBe(
        "v2:after-restart",
      );
      await expectMissing(primary, primaryForms, "ActorNamespace", "other-tenant-room");

      // Public dependency-ordered deletes; ActorNamespace itself has no update
      // operation in the released Form, so only WorkerDeployment is updated.
      await deleteResource(primary, primaryForms, "WorkerEndpoint", "actor-endpoint");
      await deleteResource(primary, primaryForms, "WorkerDeployment", "actor-deployment");
      await deleteResource(primary, primaryForms, "WorkerVersion", "actor-v2");
      await deleteResource(primary, primaryForms, "WorkerVersion", "actor-v1");
      await deleteResource(primary, primaryForms, "ActorNamespace", "actor-room");
      for (const path of actorCustodyPaths(dataRoot, primaryOrg, actorUid))
        expect(pathIsAbsent(path)).toBe(true);
      expect(await workerJson(secondaryHostname, certificate, "/read")).toMatchObject({
        id: secondaryId,
        value: 1,
        version: "v1",
      });
      expect(await workerJson(secondaryHostname, certificate, "/write")).toMatchObject({
        id: secondaryId,
        value: 2,
        version: "v1",
      });
      await deleteResource(primary, primaryForms, "WorkerBundle", "actor-bundle");
      await deleteResource(primary, primaryForms, "ModuleWorker", "actor-worker");
      await deleteResource(secondary, secondaryForms, "WorkerEndpoint", "actor-endpoint");
      await deleteResource(secondary, secondaryForms, "WorkerDeployment", "actor-deployment");
      await deleteResource(secondary, secondaryForms, "WorkerVersion", "actor-v1");
      await deleteResource(secondary, secondaryForms, "ActorNamespace", "actor-room");
      await deleteResource(secondary, secondaryForms, "WorkerBundle", "actor-bundle");
      await deleteResource(secondary, secondaryForms, "ModuleWorker", "actor-worker");
    } catch (error) {
      if (error !== BOOTSTRAP_DIAGNOSTIC_COMPLETE) {
        hasPrimaryFailure = true;
        primaryFailure = error;
      }
    } finally {
      const cleanupFailures: string[] = [];
      const attemptCleanup = async (label: string, action: () => Promise<void>): Promise<void> => {
        try {
          await action();
        } catch {
          cleanupFailures.push(label);
        }
      };
      if (admission && !childHasTerminated(admission))
        await attemptCleanup("admission", () => stopOwnedWithIdentity(admission as Child));
      if (host && !childHasTerminated(host))
        await attemptCleanup("host", () => stopOwnedWithIdentity(host as Child));
      if (verifier && !childHasTerminated(verifier))
        await attemptCleanup("verifier", () => stopOwnedWithIdentity(verifier as Child));
      if (proxy) await attemptCleanup("proxy", () => closePublicApiProxy(proxy as PublicApiProxy));
      if (hostOutput)
        await attemptCleanup("host_output", () => (hostOutput as HostOutputObservation).drained);
      const childrenExited = [admission, host, verifier].every(
        (child) => child === undefined || childHasTerminated(child),
      );
      if (childrenExited) {
        try {
          rmSync(fixture, { recursive: true, force: true });
        } catch {
          cleanupFailures.push("fixture");
        }
      } else {
        cleanupFailures.push("child_still_running");
      }
      let fixtureRemoved = false;
      try {
        fixtureRemoved = pathIsAbsent(fixture);
      } catch {
        cleanupFailures.push("fixture_check");
      }
      if (!fixtureRemoved && !cleanupFailures.includes("fixture")) {
        cleanupFailures.push("fixture_retained");
      }
      if (process.env.TAKOSERVER_ACTOR_BOOTSTRAP_DIAGNOSTIC === "1") {
        console.log(
          `ACTOR_BOOTSTRAP_CLEANUP=${JSON.stringify({
            phase: "cleanup_result",
            cleanupFailures,
            childExitCodes: {
              host: host?.exitCode ?? null,
              verifier: verifier?.exitCode ?? null,
            },
            childSignalCodes: {
              host: host?.signalCode ?? null,
              verifier: verifier?.signalCode ?? null,
            },
            hostIdentityStillLive: diagnosticHostIdentity
              ? identityIsLive(diagnosticHostIdentity)
              : null,
            verifierIdentityStillLive: diagnosticVerifierIdentity
              ? identityIsLive(diagnosticVerifierIdentity)
              : null,
            fixtureRemoved,
          })}`,
        );
      }
      if (cleanupFailures.length > 0) {
        if (!hasPrimaryFailure) {
          hasPrimaryFailure = true;
          primaryFailure = new Error("actor_host_restart_cleanup_failed");
        }
      }
    }
    if (hasPrimaryFailure) throw primaryFailure;
  },
  300_000,
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

function startHost(environment: Record<string, string>): Child {
  return Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

function startHostWithCapturedOutput(environment: Record<string, string>): {
  readonly child: Child;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
} {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!child.stdout || !child.stderr) throw new Error("actor_host_diagnostic_stream_missing");
  return { child, stdout: child.stdout, stderr: child.stderr };
}

function observeHostOutput(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
  expectedKeyPath: string,
  hostPort: number,
): HostOutputObservation {
  const state = {
    operatorKeyGeneratedAtExpectedPath: false,
    listeningAtConfiguredPort: false,
    stderrPresent: false,
    stderrClasses: new Set<string>(),
  };
  const safeErrorClasses = [
    "EADDRINUSE",
    "ECONNREFUSED",
    "ENOENT",
    "EACCES",
    "EPERM",
    "EINVAL",
    "SQLITE_BUSY",
    "SQLITE_CORRUPT",
  ];
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    kind: "stdout" | "stderr",
  ): Promise<void> => {
    const reader = stream.getReader();
    let tail = "";
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      tail = (tail + new TextDecoder().decode(item.value)).slice(-8 * 1024);
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (kind === "stdout") {
          if (line.includes(`generated an operator key at ${expectedKeyPath}`)) {
            state.operatorKeyGeneratedAtExpectedPath = true;
          }
          if (line.includes(`takoserver listening on :${hostPort}`)) {
            state.listeningAtConfiguredPort = true;
          }
        } else {
          state.stderrPresent = true;
          for (const code of safeErrorClasses) {
            if (line.includes(code)) state.stderrClasses.add(code);
          }
        }
      }
    }
  };
  return {
    state: {
      get operatorKeyGeneratedAtExpectedPath() {
        return state.operatorKeyGeneratedAtExpectedPath;
      },
      get listeningAtConfiguredPort() {
        return state.listeningAtConfiguredPort;
      },
      get stderrPresent() {
        return state.stderrPresent;
      },
      get stderrClasses() {
        return [...state.stderrClasses].sort();
      },
    },
    drained: Promise.all([drain(stdout, "stdout"), drain(stderr, "stderr")]).then(() => undefined),
  };
}

async function bootstrapOrganizations(dataRoot: string): Promise<{
  readonly primary: Auth;
  readonly secondary: Auth;
  readonly primaryOrg: string;
  readonly secondaryOrg: string;
}> {
  const operatorJwk = readFileSync(join(dataRoot, "operator-key.jwk"), "utf8");
  const assertion = await signOperatorAssertion({
    privateJwk: operatorJwk,
    claims: {
      purpose: "sign-in",
      aud: PUBLIC_ORIGIN,
      provider: "google",
      subject: "actor-host-restart-operator",
      email: "actor-host-restart@localhost",
      displayName: "Actor Host Restart Operator",
    },
    nowSeconds: Math.floor(Date.now() / 1_000),
    lifetimeSeconds: 60,
  });
  const session = await api<Json>("POST", "/v1/sessions", 200, {
    provider: "google",
    method: "operator-assertion",
    assertion,
    sessionTtlSeconds: 60,
  });
  const sessionToken = stringAt(session, "sessionToken");
  const createTenant = async (
    name: string,
    keyName: string,
  ): Promise<{ org: string; auth: Auth }> => {
    const created = await api<Json>(
      "POST",
      "/v1/organizations",
      201,
      { name },
      {
        authorization: `Bearer ${sessionToken}`,
      },
    );
    const org = stringAt(objectAt(created, "organization"), "id");
    const key = await api<Json>(
      "POST",
      `/v1/organizations/${encodeURIComponent(org)}/api-keys`,
      201,
      {
        name: keyName,
        scopes: ["resources:read", "resources:write"],
        expiresInSeconds: 600,
      },
      { authorization: `Bearer ${sessionToken}` },
    );
    return {
      org,
      auth: { authorization: `Bearer ${stringAt(key, "secret")}`, "takoform-organization": org },
    };
  };
  const primary = await createTenant("Actor Host restart primary", "actor-host-restart-primary");
  const secondary = await createTenant(
    "Actor Host restart isolated tenant",
    "actor-host-restart-secondary",
  );
  return {
    primary: primary.auth,
    secondary: secondary.auth,
    primaryOrg: primary.org,
    secondaryOrg: secondary.org,
  };
}

async function waitForCoreVerifier(child: Child, artifactDigest: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: child });
    try {
      const response = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/identity`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const identity = (await response.json()) as Json;
        if (
          identity.protocol !== "takoserver.takoform-core-verifier@v1" ||
          identity.coreVersion !== "v1.1.0" ||
          identity.coreCommit !== "e0e48b864de2a127a255cb0574d37bbb0f1cac29" ||
          identity.artifactDigest !== artifactDigest
        )
          throw new Error("actor_real_core_identity_mismatch");
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message === "actor_real_core_identity_mismatch")
        throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error("actor_real_core_startup_timeout");
}

async function waitForHost(child: Child): Promise<HostReadinessObservation> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: child });
    let ownerBefore: "vacant" | "owned" | "foreign";
    try {
      ownerBefore = await workerPortOwnership(HOST_PORT, child.pid);
    } catch {
      await Bun.sleep(50);
      continue;
    }
    if (ownerBefore !== "owned") {
      await Bun.sleep(50);
      continue;
    }
    try {
      const [directResponse, publicResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${HOST_PORT}/.well-known/takoform/v1`, {
          signal: AbortSignal.timeout(500),
        }),
        fetch(`${PUBLIC_ORIGIN}/.well-known/takoform/v1`, {
          signal: AbortSignal.timeout(500),
        }),
      ]);
      const [directBody, publicBody] = await Promise.all([
        directResponse.arrayBuffer().then((body) => new Uint8Array(body)),
        publicResponse.arrayBuffer().then((body) => new Uint8Array(body)),
      ]);
      const ownerAfter = await workerPortOwnership(HOST_PORT, child.pid);
      if (
        ownerAfter === "owned" &&
        directResponse.status === 200 &&
        publicResponse.status === 200 &&
        sameBytes(directBody, publicBody) &&
        isTakoformDiscoveryBody(directBody)
      ) {
        return {
          hostPortOwnershipBefore: ownerBefore,
          hostPortOwnershipAfter: ownerAfter,
          directStatus: 200,
          publicStatus: 200,
          discoveryBodyBytes: directBody.byteLength,
          discoveryBodySha256: createHash("sha256").update(directBody).digest("hex"),
        };
      }
    } catch {
      // A failed direct or proxied probe is not evidence of Host readiness.
    }
    await Bun.sleep(50);
  }
  throw new Error("actor_public_host_not_ready");
}

function safeFileMetadata(path: string): { exists: boolean; mode?: string; bytes?: number } {
  try {
    const stat = lstatSync(path);
    return { exists: true, mode: (stat.mode & 0o777).toString(8), bytes: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw new Error("actor_safe_file_metadata_unavailable");
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function isTakoformDiscoveryBody(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Json;
    const features = objectAt(value, "features");
    return (
      Array.isArray(value.api_versions) &&
      value.api_versions.includes("forms.takoform.com/v1") &&
      features.service_forms === true &&
      features.exact_form_ref === true
    );
  } catch {
    return false;
  }
}

async function stopOwned(child: Child): Promise<void> {
  if (childHasTerminated(child)) return;
  child.kill("SIGTERM");
  const status = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
  if (status === null) {
    child.kill("SIGKILL");
    const killed = await Promise.race([child.exited, Bun.sleep(3_000).then(() => null)]);
    if (killed === null) throw new Error("actor_owned_process_did_not_exit");
  }
  if (!childHasTerminated(child)) throw new Error("actor_owned_process_exit_status_missing");
}

function childHasTerminated(child: Child): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopOwnedWithIdentity(child: Child): Promise<void> {
  let identity: ProcessIdentity | undefined;
  try {
    identity = processIdentity(child.pid);
  } catch {
    // The child may already have exited before cleanup begins.
  }
  await stopOwned(child);
  if (identity && identityIsLive(identity)) throw new Error("actor_owned_process_identity_live");
}

async function api<T = Json>(
  method: string,
  path: string,
  expected: number | readonly number[],
  body?: unknown,
  headers: Auth = {},
): Promise<T> {
  const response = await fetch(`${PUBLIC_ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const expectedStatuses = typeof expected === "number" ? [expected] : expected;
  if (!expectedStatuses.includes(response.status)) {
    let code = "unknown";
    try {
      const payload = (await response.json()) as Json;
      const error = objectAt(payload, "error");
      if (typeof error.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code))
        code = error.code;
    } catch {
      // Only the bounded status and stable error code are exposed to the test failure.
    }
    throw new Error(`actor_api_${method.toLowerCase()}_${response.status}_${code}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function catalog(auth: Auth): Promise<FormMap> {
  const result = await api<Json>("GET", `${LANE}/forms?space=${SPACE}`, 200, undefined, auth);
  const forms = new Map<string, Json>();
  for (const item of Array.isArray(result.forms) ? (result.forms as Json[]) : []) {
    const ref = objectAt(objectAt(item, "identity"), "formRef");
    forms.set(stringAt(ref, "kind"), ref);
  }
  return forms;
}

function assertReleasedActorClosure(forms: FormMap): void {
  const expected = currentTakoformCandidates().forms;
  for (const kind of [
    "ActorNamespace",
    "ModuleWorker",
    "WorkerBundle",
    "WorkerVersion",
    "WorkerDeployment",
    "WorkerEndpoint",
  ]) {
    const actual = forms.get(kind);
    const pinned = expected.find((entry) => entry.identity.formRef.kind === kind)?.identity.formRef;
    if (
      !actual ||
      !pinned ||
      actual.apiVersion !== pinned.apiVersion ||
      actual.kind !== pinned.kind ||
      actual.definitionVersion !== pinned.definitionVersion ||
      actual.schemaDigest !== pinned.schemaDigest
    )
      throw new Error(`actor_released_form_mismatch_${kind}`);
  }
}

function reference(kind: string, name: string): Json {
  return { apiVersion: "edge.forms.takoform.com", kind, name };
}

function desiredResource(forms: FormMap, kind: string, name: string, spec: Json): Json {
  const formRef = forms.get(kind);
  if (!formRef) throw new Error(`actor_released_form_missing_${kind}`);
  return {
    apiVersion: stringAt(formRef, "apiVersion"),
    kind,
    form: { formRef },
    metadata: { name, space: SPACE },
    spec,
  };
}

async function preparePut(auth: Auth, desired: Json, key: string): Promise<Json> {
  const prepared = await api<Json>("POST", `${LANE}/resources/prepare`, 200, desired, auth);
  return { desired, review: objectAt(prepared, "review"), key };
}

async function putPrepared(
  auth: Auth,
  prepared: Json,
  key: string,
  expected: number | readonly number[],
): Promise<Json> {
  const desired = objectAt(prepared, "desired");
  const identity = objectAt(desired, "form");
  const ref = objectAt(identity, "formRef");
  const kind = stringAt(desired, "kind");
  const name = stringAt(objectAt(desired, "metadata"), "name");
  const query = new URLSearchParams({
    space: SPACE,
    definitionVersion: stringAt(ref, "definitionVersion"),
    schemaDigest: stringAt(ref, "schemaDigest"),
  });
  return api<Json>(
    "PUT",
    `${LANE}/resources/${stringAt(ref, "apiVersion")}/${kind}/${name}?${query}`,
    expected,
    { ...desired, review: objectAt(prepared, "review") },
    { ...auth, "idempotency-key": key, "if-none-match": "*" },
  );
}

async function apply(
  auth: Auth,
  forms: FormMap,
  kind: string,
  name: string,
  spec: Json,
  current?: Json,
): Promise<Json> {
  const desired = desiredResource(forms, kind, name, spec);
  const metadata = current ? objectAt(current, "metadata") : undefined;
  const prepared = await api<Json>("POST", `${LANE}/resources/prepare`, 200, desired, {
    ...auth,
    ...(metadata ? { "takoform-expected-generation": stringAt(metadata, "generation") } : {}),
  });
  const ref = objectAt(objectAt(desired, "form"), "formRef");
  const query = new URLSearchParams({
    space: SPACE,
    definitionVersion: stringAt(ref, "definitionVersion"),
    schemaDigest: stringAt(ref, "schemaDigest"),
  });
  return api<Json>(
    "PUT",
    `${LANE}/resources/${stringAt(ref, "apiVersion")}/${kind}/${name}?${query}`,
    current ? 200 : 201,
    { ...desired, review: objectAt(prepared, "review") },
    {
      ...auth,
      "idempotency-key": `actor-${kind}-${name}-${current ? "update" : "create"}`,
      ...(metadata
        ? {
            "if-match": `"${stringAt(metadata, "revision")}"`,
            "takoform-expected-generation": stringAt(metadata, "generation"),
          }
        : { "if-none-match": "*" }),
    },
  );
}

function workerVersion(worker: string, actor: string, bundle: string, version: string): Json {
  return {
    worker: reference("ModuleWorker", worker),
    bundle: reference("WorkerBundle", bundle),
    handlers: ["fetch"],
    requiredSensitiveVars: [],
    vars: { VERSION: version },
    actorBindings: [{ name: "ROOMS", resource: reference("ActorNamespace", actor) }],
  };
}

async function uploadBundle(
  auth: Auth,
  manifest: Json,
  digest: string,
  bytes: Uint8Array,
  key: string,
): Promise<string> {
  const upload = await api<Json>(
    "POST",
    `${LANE}/artifacts/uploads`,
    201,
    { manifest },
    {
      ...auth,
      "idempotency-key": `${key}-upload`,
    },
  );
  const uploadId = stringAt(upload, "uploadId");
  if ((upload.missingBlobs as unknown[]).includes(digest)) {
    const response = await fetch(
      `${PUBLIC_ORIGIN}${LANE}/artifacts/uploads/${uploadId}/blobs/${digest}`,
      {
        method: "PUT",
        headers: auth,
        body: new Uint8Array(bytes).buffer as ArrayBuffer,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status !== 201) throw new Error("actor_bundle_blob_upload_failed");
    await response.arrayBuffer();
  }
  const committed = await api<Json>(
    "POST",
    `${LANE}/artifacts/uploads/${uploadId}/commit`,
    201,
    undefined,
    {
      ...auth,
      "idempotency-key": `${key}-commit`,
    },
  );
  return stringAt(committed, "manifestDigest");
}

function resourcePath(forms: FormMap, kind: string, name: string): string {
  const ref = forms.get(kind);
  if (!ref) throw new Error(`actor_released_form_missing_${kind}`);
  const query = new URLSearchParams({
    space: SPACE,
    definitionVersion: stringAt(ref, "definitionVersion"),
    schemaDigest: stringAt(ref, "schemaDigest"),
  });
  return `${LANE}/resources/${stringAt(ref, "apiVersion")}/${kind}/${name}?${query}`;
}

async function getResource(auth: Auth, forms: FormMap, kind: string, name: string): Promise<Json> {
  return api<Json>("GET", resourcePath(forms, kind, name), 200, undefined, auth);
}

async function expectMissing(
  auth: Auth,
  forms: FormMap,
  kind: string,
  name: string,
): Promise<void> {
  const missing = await api<Json>("GET", resourcePath(forms, kind, name), 404, undefined, auth);
  expect(stringAt(objectAt(missing, "error"), "code")).toBe("resource_not_found");
}

async function deleteResource(
  auth: Auth,
  forms: FormMap,
  kind: string,
  name: string,
): Promise<void> {
  const path = resourcePath(forms, kind, name);
  const current = await getResource(auth, forms, kind, name);
  const metadata = objectAt(current, "metadata");
  await api<undefined>("DELETE", path, 204, undefined, {
    ...auth,
    "idempotency-key": `actor-delete-${kind}-${name}`,
    "takoform-expected-generation": stringAt(metadata, "generation"),
    "if-match": `"${stringAt(metadata, "revision")}"`,
  });
  await expectMissing(auth, forms, kind, name);
}

function output(resource: Json, name: string): string {
  return stringAt(objectAt(objectAt(resource, "status"), "outputs"), name);
}

async function workerJson(hostname: string, certificatePath: string, path: string): Promise<Json> {
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: WORKER_PORT,
        servername: hostname,
        path,
        method: path === "/write" ? "POST" : "GET",
        ca: readFileSync(certificatePath, "utf8"),
        timeout: 10_000,
      },
      resolve,
    );
    request.once("error", () => reject(new Error("actor_worker_https_failed")));
    request.end();
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  if (response.statusCode !== 200) throw new Error(`actor_worker_http_${response.statusCode ?? 0}`);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
}

async function workerSocketEcho(
  hostname: string,
  certificatePath: string,
  path: string,
  message: string,
): Promise<string> {
  const socket = tlsConnect({
    host: "127.0.0.1",
    port: WORKER_PORT,
    servername: hostname,
    ca: readFileSync(certificatePath, "utf8"),
    rejectUnauthorized: true,
  });
  const reader = new SocketReader(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", () => reject(new Error("actor_wss_tls_failed")));
    });
    const key = randomBytes(16).toString("base64");
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    const handshake = (await reader.until(Buffer.from("\r\n\r\n"))).toString("latin1");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    if (
      !/^HTTP\/1\.1 101\b/u.test(handshake) ||
      !handshake.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)
    )
      throw new Error("actor_wss_handshake_rejected");
    const payload = Buffer.from(message, "utf8");
    if (payload.byteLength > 125) throw new Error("actor_wss_message_too_large");
    const mask = randomBytes(4);
    const frame = Buffer.alloc(2 + 4 + payload.byteLength);
    frame[0] = 0x81;
    frame[1] = 0x80 | payload.byteLength;
    mask.copy(frame, 2);
    for (let index = 0; index < payload.byteLength; index += 1)
      frame[6 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    socket.write(frame);
    const header = await reader.bytes(2);
    const opcode = (header[0] ?? 0) & 0x0f;
    let size = (header[1] ?? 0) & 0x7f;
    if (size === 126) size = (await reader.bytes(2)).readUInt16BE(0);
    else if (size === 127) throw new Error("actor_wss_frame_too_large");
    if (opcode !== 1 || size > 1_024) throw new Error("actor_wss_reply_invalid");
    return (await reader.bytes(size)).toString("utf8");
  } finally {
    socket.destroy();
  }
}

class SocketReader {
  private buffered = Buffer.alloc(0);
  private readonly waiters: Array<() => void> = [];
  constructor(socket: TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }
  async bytes(count: number): Promise<Buffer> {
    const deadline = Date.now() + 10_000;
    while (this.buffered.byteLength < count && Date.now() < deadline) await this.wait();
    if (this.buffered.byteLength < count) throw new Error("actor_wss_read_timeout");
    const result = this.buffered.subarray(0, count);
    this.buffered = this.buffered.subarray(count);
    return result;
  }
  async until(delimiter: Buffer): Promise<Buffer> {
    const deadline = Date.now() + 10_000;
    while (true) {
      const index = this.buffered.indexOf(delimiter);
      if (index >= 0) {
        const end = index + delimiter.byteLength;
        const result = this.buffered.subarray(0, end);
        this.buffered = this.buffered.subarray(end);
        return result;
      }
      if (Date.now() >= deadline) throw new Error("actor_wss_handshake_timeout");
      await this.wait();
    }
  }
  private wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("actor_wss_read_timeout"));
      }, 500);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }
}

type PublicApiProxy = Awaited<ReturnType<typeof createPublicApiProxy>>;
function createPublicApiProxy(upstreamPort: number, publicPort: number) {
  const dropped = new Set<string>();
  const armed = new Set<string>();
  const server = createServer((incoming, outgoing) => {
    const key = incoming.headers["idempotency-key"];
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        if (typeof key === "string" && armed.has(key)) {
          armed.delete(key);
          response.resume();
          response.once("end", () => {
            dropped.add(key);
            outgoing.destroy();
          });
          return;
        }
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.once("error", () => {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      // Bun's fetch can surface a destroyed proxy socket as an empty 200. Make
      // an upstream connect failure an explicit bounded error response instead.
      outgoing.writeHead(502, { "content-length": "0" });
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  return new Promise<{
    server: typeof server;
    dropNextAck(key: string): void;
    wasDropped(key: string): boolean;
  }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(publicPort, "127.0.0.1", () =>
      resolve({
        server,
        dropNextAck(key) {
          armed.add(key);
        },
        wasDropped(key) {
          return dropped.has(key);
        },
      }),
    );
  });
}

async function closePublicApiProxy(proxy: PublicApiProxy): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    proxy.server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function createTls(directory: string): Promise<void> {
  const certificate = join(directory, "worker-cert.pem");
  const privateKey = join(directory, "worker-key.pem");
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      privateKey,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      `/CN=*.${HOST_SUFFIX}`,
      "-addext",
      `subjectAltName=DNS:*.${HOST_SUFFIX}`,
    ],
    { env: childEnvironment(directory), stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await child.exited) !== 0) throw new Error("actor_test_tls_generation_failed");
  chmodSync(privateKey, 0o600);
  chmodSync(certificate, 0o600);
}

function processIdentity(pid: number): ProcessIdentity {
  const stat = processStat(pid);
  const executable = processExecutable(pid);
  if (!stat || !executable) throw new Error("actor_process_identity_missing");
  return { pid, startTicks: stat.startTicks, executable };
}

function identityIsLive(identity: ProcessIdentity): boolean {
  try {
    const current = processIdentity(identity.pid);
    return current.startTicks === identity.startTicks && current.executable === identity.executable;
  } catch {
    return false;
  }
}

function acceptedWorkerdPath(dataRoot: string): string {
  return join(
    dataRoot,
    "runtime-probes",
    "artifacts",
    `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.sha256}`,
  );
}

function actorCustodyPaths(dataRoot: string, tenantId: string, namespaceUid: string): string[] {
  const key = createHash("sha256")
    .update(JSON.stringify([tenantId, namespaceUid]))
    .digest("hex");
  const root = join(dataRoot, "actor-namespaces");
  return [
    join(root, "registrations", `${key}.json`),
    join(root, "leases", key),
    join(root, "namespaces", key),
  ];
}

function pathIsAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function uniqueWorkerd(host: Child, expectedExecutable: string): ProcessIdentity {
  const all = new Map<number, { parentPid: number; startTicks: string }>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    const stat = processStat(pid);
    if (stat) all.set(pid, stat);
  }
  const children = new Map<number, number[]>();
  for (const [pid, stat] of all) {
    const group = children.get(stat.parentPid) ?? [];
    group.push(pid);
    children.set(stat.parentPid, group);
  }
  const pending = [...(children.get(host.pid) ?? [])];
  const visited = new Set<number>();
  const matches: ProcessIdentity[] = [];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    const stat = all.get(pid);
    if (!stat) continue;
    const executable = processExecutable(pid);
    if (executable === expectedExecutable)
      matches.push({ pid, startTicks: stat.startTicks, executable });
    pending.push(...(children.get(pid) ?? []));
  }
  if (matches.length !== 1) throw new Error("actor_expected_one_pinned_workerd_child");
  return matches[0] as ProcessIdentity;
}

function processStat(pid: number): { parentPid: number; startTicks: string } | null {
  let value: string;
  try {
    value = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw new Error("actor_process_identity_read_failed");
  }
  const close = value.lastIndexOf(")");
  if (close < 0) throw new Error("actor_process_identity_malformed");
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const parentPid = Number(fields[1]);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(parentPid) || typeof startTicks !== "string")
    throw new Error("actor_process_identity_malformed");
  return { parentPid, startTicks };
}

function processExecutable(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw new Error("actor_process_identity_read_failed");
  }
}

function objectAt(value: unknown, key: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`actor_api_object_missing_${key}`);
  const selected = (value as Json)[key];
  if (typeof selected !== "object" || selected === null || Array.isArray(selected))
    throw new Error(`actor_api_object_missing_${key}`);
  return selected as Json;
}

function stringAt(value: Json, key: string): string {
  const selected = value[key];
  if (typeof selected !== "string") throw new Error(`actor_api_string_missing_${key}`);
  return selected;
}
