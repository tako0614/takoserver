import { expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";
import { createSyntheticPublisherSetVerifier } from "./helpers/synthetic-publisher-set-verifier.ts";

// Native-only: run inside an isolated network namespace with loopback enabled.
// The real Bun entry owns both listeners; 443 is required by WorkerEndpoint@0.1.0.
const WORKERD = nativeEvidenceBinary("workerd-artifact") ?? null;
const HOST_ORIGIN = "http://127.0.0.1:8787";
const API_PORT = 8787;
const WORKER_SUFFIX = "apps.selfhost.test";
const LANE = "/apis/forms.takoform.com/v1";
const SPACE = "default";
const WORKER_MARKER = "cold-restore-marker-v1";
const MODULE = `export default { async fetch() { return new Response("${WORKER_MARKER}"); } };`;
const RESOURCE_NAMES = [
  ["ModuleWorker", "cold-restore-worker"],
  ["WorkerBundle", "cold-restore-bundle"],
  ["WorkerVersion", "cold-restore-version"],
  ["WorkerDeployment", "cold-restore-deployment"],
  ["WorkerEndpoint", "cold-restore-endpoint"],
] as const;

type Json = Record<string, unknown>;
type Host = ReturnType<typeof startHost>;
type ProcessIdentity = {
  readonly pid: number;
  readonly startTicks: string;
  readonly executable: string;
};
const observedHostDescendants = new WeakMap<Host, Map<string, ProcessIdentity>>();

test.skipIf(WORKERD === null)(
  "a self-host recovers a crashed workerd child and restores its Worker at the same endpoint",
  async () => {
    const fixture = mkdtempSync(join(tmpdir(), "takoserver-selfhost-cold-restore-"));
    chmodSync(fixture, 0o700);
    const sourceRoot = join(fixture, "source", "data");
    const sourceDbDirectory = join(fixture, "source", "control-db");
    const sourceDb = join(sourceDbDirectory, "control.sqlite");
    const sourceTls = join(fixture, "source", "tls");
    const restoredBase = join(fixture, "restored");
    const restoredRoot = join(restoredBase, "data");
    const restoredDbDirectory = join(restoredBase, "control-db");
    const restoredDb = join(restoredDbDirectory, "control.sqlite");
    const restoredTls = join(restoredBase, "tls");
    mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(sourceDbDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(sourceTls, { recursive: true, mode: 0o700 });
    mkdirSync(restoredBase, { recursive: true, mode: 0o700 });

    const baseEnvironment = childEnvironment(fixture);
    const hostEnvironment = (root: string, database: string, tlsDirectory: string) => ({
      ...baseEnvironment,
      TAKOSERVER_DATA_ROOT: root,
      TAKOSERVER_DB: database,
      TAKOSERVER_PUBLIC_ORIGIN: HOST_ORIGIN,
      PORT: String(API_PORT),
      TAKOSERVER_WORKERD_BINARY: WORKERD as string,
      TAKOSERVER_WORKERD_PORT: "443",
      TAKOSERVER_WORKER_ENDPOINT_PORT: "443",
      TAKOSERVER_WORKER_ENDPOINT_SUFFIX: WORKER_SUFFIX,
      TAKOSERVER_WORKERD_TLS_CERT_FILE: join(tlsDirectory, "worker-cert.pem"),
      TAKOSERVER_WORKERD_TLS_KEY_FILE: join(tlsDirectory, "worker-key.pem"),
    });
    let host: Host | undefined;
    let admission: ReturnType<typeof Bun.spawn> | undefined;
    let verifier: ReturnType<typeof Bun.serve> | undefined;
    let verifierPort: number | undefined;
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    const cleanupFailures: string[] = [];
    try {
      await createTls(sourceTls);
      host = startHost(hostEnvironment(sourceRoot, sourceDb, sourceTls));
      await waitForHost(host, `${HOST_ORIGIN}/.well-known/takoform/v1`);

      const operatorPrivateJwk = readFileSync(join(sourceRoot, "operator-key.jwk"), "utf8");
      const assertion = await signOperatorAssertion({
        privateJwk: operatorPrivateJwk,
        claims: {
          purpose: "sign-in",
          aud: HOST_ORIGIN,
          provider: "google",
          subject: "cold-restore-operator",
          email: "cold-restore@localhost",
          displayName: "Cold Restore Operator",
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
      const created = await api<Json>(
        "POST",
        "/v1/organizations",
        201,
        { name: "Self-host cold restore" },
        { authorization: `Bearer ${sessionToken}` },
      );
      const organization = objectAt(created, "organization");
      const organizationId = stringAt(organization, "id");
      const apiKeyResponse = await api<Json>(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        201,
        {
          name: "cold-restore-native",
          scopes: ["resources:read", "resources:write"],
          expiresInSeconds: 600,
        },
        { authorization: `Bearer ${sessionToken}` },
      );
      const apiToken = stringAt(apiKeyResponse, "secret");
      const auth = {
        authorization: `Bearer ${apiToken}`,
        "takoform-organization": organizationId,
      };

      // Self-host Forms are durably admitted before Worker resources are created.
      // This fixture synthesizes verifier responses; it is not Core/Sigstore proof.
      await stopHost(host, { requireWorker: false, dataRoot: sourceRoot });
      host = undefined;
      const verifierFixture = createSyntheticPublisherSetVerifier();
      verifier = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => verifierFixture.fetch(request),
      });
      verifierPort = verifier.port;
      try {
        admission = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "scripts/selfhost-form-admission.ts",
            organizationId,
            SPACE,
            "--apply",
            "--data-root",
            sourceRoot,
            "--host-id",
            HOST_ORIGIN,
            "--core-verifier",
            `http://127.0.0.1:${verifier.port}`,
          ],
          {
            cwd: process.cwd(),
            env: hostEnvironment(sourceRoot, sourceDb, sourceTls),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        const completedAdmission = admission;
        const admissionDescendants = new Map<string, ProcessIdentity>();
        const admissionDeadline = Date.now() + 30_000;
        rememberDescendants(completedAdmission.pid, admissionDescendants);
        let exitCode: number | null = null;
        while (completedAdmission.exitCode === null) {
          if (Date.now() >= admissionDeadline) {
            throw new Error("selfhost_form_admission_cli_timeout");
          }
          rememberDescendants(completedAdmission.pid, admissionDescendants);
          await Bun.sleep(25);
        }
        exitCode = await completedAdmission.exited;
        rememberDescendants(completedAdmission.pid, admissionDescendants);
        await waitForProcessIdentitiesGone(admissionDescendants.values());
        admission = undefined;
        if (exitCode !== 0) throw new Error("selfhost_form_admission_cli_nonzero_exit");
      } finally {
        if (admission) await stopAdmissionProcess(admission);
        admission = undefined;
        if (verifier) {
          await verifier.stop(true);
          await waitForPortClosed(verifierPort as number);
          verifier = undefined;
          verifierPort = undefined;
        }
      }

      host = startHost(hostEnvironment(sourceRoot, sourceDb, sourceTls));
      await waitForHost(host, `${HOST_ORIGIN}/.well-known/takoform/v1`);
      const discovery = await api<Json>(
        "GET",
        `${LANE}/forms?space=${SPACE}`,
        200,
        undefined,
        auth,
      );
      const forms = new Map(
        (discovery.forms as Json[]).map((form) => {
          const identity = objectAt(form, "identity");
          return [stringAt(objectAt(identity, "formRef"), "kind"), objectAt(identity, "formRef")];
        }),
      );
      const moduleBytes = new TextEncoder().encode(MODULE);
      const moduleDigest = await bytesDigest(moduleBytes);
      const upload = await api<Json>(
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
                size: moduleBytes.byteLength,
                digest: moduleDigest,
              },
            ],
          },
        },
        { ...auth, "idempotency-key": "cold-restore-upload" },
      );
      const uploadId = stringAt(upload, "uploadId");
      expect(upload.missingBlobs).toContain(moduleDigest);
      const uploaded = await fetch(
        `${HOST_ORIGIN}${LANE}/artifacts/uploads/${uploadId}/blobs/${moduleDigest}`,
        {
          method: "PUT",
          headers: auth,
          body: moduleBytes,
        },
      );
      expect(uploaded.status).toBe(201);
      await uploaded.arrayBuffer();
      const artifact = await api<Json>(
        "POST",
        `${LANE}/artifacts/uploads/${uploadId}/commit`,
        201,
        undefined,
        { ...auth, "idempotency-key": "cold-restore-upload-commit" },
      );

      const reference = (kind: string, name: string) => ({
        apiVersion: "edge.forms.takoform.com",
        kind,
        name,
      });
      async function apply(kind: string, name: string, spec: Json): Promise<Json> {
        const formRef = forms.get(kind);
        if (!formRef) throw new Error(`selfhost_form_missing_${kind}`);
        const desired = {
          apiVersion: formRef.apiVersion,
          kind,
          form: { formRef },
          metadata: { name, space: SPACE },
          spec,
        };
        const prepared = await api<Json>("POST", `${LANE}/resources/prepare`, 200, desired, auth);
        const review = objectAt(prepared, "review");
        const query = new URLSearchParams({
          space: SPACE,
          definitionVersion: String(formRef.definitionVersion),
          schemaDigest: String(formRef.schemaDigest),
        });
        return api<Json>(
          "PUT",
          `${LANE}/resources/${formRef.apiVersion}/${kind}/${name}?${query}`,
          201,
          { ...desired, review },
          { ...auth, "idempotency-key": `${kind}-${name}-create`, "if-none-match": "*" },
        );
      }

      await apply("ModuleWorker", "cold-restore-worker", {});
      await apply("WorkerBundle", "cold-restore-bundle", {
        manifestDigest: stringAt(artifact, "manifestDigest"),
      });
      await apply("WorkerVersion", "cold-restore-version", {
        worker: reference("ModuleWorker", "cold-restore-worker"),
        bundle: reference("WorkerBundle", "cold-restore-bundle"),
        handlers: ["fetch"],
        requiredSensitiveVars: [],
      });
      await apply("WorkerDeployment", "cold-restore-deployment", {
        worker: reference("ModuleWorker", "cold-restore-worker"),
        versions: [
          { workerVersion: reference("WorkerVersion", "cold-restore-version"), weight: 10_000 },
        ],
      });
      const endpointResource = await apply("WorkerEndpoint", "cold-restore-endpoint", {
        worker: reference("ModuleWorker", "cold-restore-worker"),
      });
      const endpointBefore = output(endpointResource, "url");
      expect(new URL(endpointBefore).protocol).toBe("https:");
      expect(new URL(endpointBefore).port).toBe("");
      const hostname = new URL(endpointBefore).hostname;
      const markerBefore = await workerRequest(hostname, join(sourceTls, "worker-cert.pem"), "/");
      expect(markerBefore).toBe("cold-restore-marker-v1");
      rememberHostDescendants(host);
      const graphBefore = await readResourceGraph(auth, forms);

      // Kill only the exact accepted runtime child. Recovery must happen inside
      // this same Host process before any Resource read or client republish.
      const sourceHostIdentity = processIdentity(host.pid);
      const acceptedWorkerd = acceptedWorkerdSnapshot(sourceRoot);
      const crashedWorkerd = uniqueLiveWorkerd(host, acceptedWorkerd);
      const currentWorkerd = processIdentity(crashedWorkerd.pid);
      if (
        !sameIdentity(currentWorkerd, crashedWorkerd) ||
        currentWorkerd.executable !== acceptedWorkerd
      ) {
        throw new Error("selfhost_workerd_identity_changed_before_kill");
      }
      process.kill(crashedWorkerd.pid, "SIGKILL");
      await waitForProcessIdentitiesGone([crashedWorkerd]);
      assertHostStillSameProcess(host, sourceHostIdentity);
      const replacementWorkerd = await waitForWorkerdReplacement(
        host,
        sourceHostIdentity,
        acceptedWorkerd,
        crashedWorkerd,
      );
      if (sameIdentity(replacementWorkerd, crashedWorkerd)) {
        throw new Error("selfhost_workerd_replacement_identity_not_distinct");
      }
      const recoveredMarker = await waitForRecoveredWorkerMarker(
        host,
        sourceHostIdentity,
        replacementWorkerd,
        hostname,
        join(sourceTls, "worker-cert.pem"),
      );
      expect(recoveredMarker).toBe(WORKER_MARKER);

      // The source is quiescent before copying the entire installation root and
      // the complete external control-DB directory (including any SQLite sidecars).
      await stopHost(host, { requireWorker: true, dataRoot: sourceRoot });
      host = undefined;
      cpSync(sourceRoot, restoredRoot, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
      cpSync(sourceDbDirectory, restoredDbDirectory, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
      cpSync(sourceTls, restoredTls, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
      expect(existsSync(join(sourceRoot, "operator-key.jwk"))).toBe(true);
      expect(existsSync(join(restoredRoot, "operator-key.jwk"))).toBe(true);

      // Only external TLS file paths are rebased. The origin, ports, signing and
      // operator identities, API token, and Worker endpoint remain unchanged.
      // There is no client resource publication after this point.
      host = startHost(hostEnvironment(restoredRoot, restoredDb, restoredTls));
      await waitForHost(host, `${HOST_ORIGIN}/.well-known/takoform/v1`);
      expect(await workerRequest(hostname, join(restoredTls, "worker-cert.pem"), "/")).toBe(
        "cold-restore-marker-v1",
      );
      const graphAfter = await readResourceGraph(auth, forms);
      expect(graphAfter).toEqual(graphBefore);
      const endpointAfter = stringAt(
        objectAt(graphAfter.find((item) => item.kind === "WorkerEndpoint") ?? {}, "outputs"),
        "url",
      );
      expect(endpointAfter).toBe(endpointBefore);
    } catch (error) {
      primaryFailure = error;
      hasPrimaryFailure = true;
    } finally {
      if (admission) {
        try {
          await stopAdmissionProcess(admission);
          admission = undefined;
        } catch (error) {
          cleanupFailures.push(errorTag(error));
        }
      }
      if (verifier) {
        try {
          await verifier.stop(true);
          await waitForPortClosed(verifierPort as number);
          verifier = undefined;
          verifierPort = undefined;
        } catch (error) {
          cleanupFailures.push(errorTag(error));
        }
      }
      if (host) {
        try {
          await cleanupHost(host);
          host = undefined;
        } catch (error) {
          cleanupFailures.push(errorTag(error));
        }
      }
      if (cleanupFailures.length === 0) rmSync(fixture, { recursive: true, force: true });
    }
    if (cleanupFailures.length > 0) {
      const primaryTag = hasPrimaryFailure ? errorTag(primaryFailure) : "none";
      throw new Error(`selfhost_cleanup_failed_${cleanupFailures.join("_")}_after_${primaryTag}`);
    }
    if (hasPrimaryFailure) throw primaryFailure;
  },
  120_000,
);

function childEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? home,
    CI: "1",
    NO_COLOR: "1",
    CHECKPOINT_DISABLE: "1",
  };
}

function startHost(environment: Record<string, string>): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function stopHost(
  host: Host,
  options: { requireWorker: boolean; dataRoot?: string },
): Promise<void> {
  const observed = hostDescendants(host);
  rememberDescendants(host.pid, observed);
  if (host.exitCode !== null) throw new Error("selfhost_unexpected_host_exit_before_stop");
  if (options.requireWorker) {
    if (!options.dataRoot) throw new Error("selfhost_workerd_snapshot_root_missing");
    const expectedBinary = acceptedWorkerdSnapshot(options.dataRoot);
    if (![...observed.values()].some((identity) => identity.executable === expectedBinary)) {
      throw new Error("selfhost_workerd_child_not_observed_before_stop");
    }
  }
  host.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  let exitCode: number | null = null;
  while (Date.now() < deadline) {
    rememberDescendants(host.pid, observed);
    if (host.exitCode !== null) {
      exitCode = await host.exited;
      break;
    }
    await Bun.sleep(25);
  }
  if (exitCode === null) throw new Error("selfhost_stop_timeout");
  if (exitCode !== 0) throw new Error(`selfhost_host_exit_nonzero_${exitCode}`);
  await waitForProcessIdentitiesGone(observed.values());
  await waitForPortClosed(API_PORT);
  await waitForPortClosed(443);
}

async function cleanupHost(host: Host): Promise<void> {
  if (host.exitCode === null) {
    await stopHost(host, { requireWorker: false });
    return;
  }
  const exitCode = await host.exited;
  await waitForProcessIdentitiesGone(hostDescendants(host).values());
  await waitForPortClosed(API_PORT);
  await waitForPortClosed(443);
  if (exitCode !== 0) throw new Error(`selfhost_host_exit_nonzero_${exitCode}`);
}

async function stopAdmissionProcess(admission: ReturnType<typeof Bun.spawn>): Promise<void> {
  const descendants = new Map<string, ProcessIdentity>();
  rememberDescendants(admission.pid, descendants);
  if (admission.exitCode === null) admission.kill("SIGTERM");
  const exitCode = await Promise.race([admission.exited, Bun.sleep(5_000).then(() => null)]);
  if (exitCode === null) throw new Error("selfhost_form_admission_stop_timeout");
  rememberDescendants(admission.pid, descendants);
  await waitForProcessIdentitiesGone(descendants.values());
}

function hostDescendants(host: Host): Map<string, ProcessIdentity> {
  let descendants = observedHostDescendants.get(host);
  if (!descendants) {
    descendants = new Map();
    observedHostDescendants.set(host, descendants);
  }
  return descendants;
}

function rememberHostDescendants(host: Host): void {
  rememberDescendants(host.pid, hostDescendants(host));
}

function acceptedWorkerdSnapshot(dataRoot: string): string {
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
  if (stat === null || executable === null) throw new Error("selfhost_process_identity_not_live");
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

function uniqueLiveWorkerd(host: Host, expectedExecutable: string): ProcessIdentity {
  rememberHostDescendants(host);
  const matches = [...hostDescendants(host).values()].filter(
    (identity) => identity.executable === expectedExecutable && identityIsLive(identity),
  );
  if (matches.length !== 1) throw new Error("selfhost_expected_one_live_workerd_child");
  return matches[0] as ProcessIdentity;
}

function assertHostStillSameProcess(host: Host, expected: ProcessIdentity): void {
  if (host.exitCode !== null || !identityIsLive(expected)) {
    throw new Error("selfhost_host_process_changed_after_workerd_crash");
  }
}

async function waitForWorkerdReplacement(
  host: Host,
  hostIdentity: ProcessIdentity,
  expectedExecutable: string,
  crashed: ProcessIdentity,
): Promise<ProcessIdentity> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assertHostStillSameProcess(host, hostIdentity);
    const replacement = [...hostDescendants(host).values()].find(
      (identity) =>
        identity.executable === expectedExecutable &&
        !sameIdentity(identity, crashed) &&
        identityIsLive(identity),
    );
    if (replacement) return replacement;
    rememberHostDescendants(host);
    await Bun.sleep(25);
  }
  throw new Error("selfhost_workerd_replacement_timeout");
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
      const identity: ProcessIdentity = { pid, startTicks: stat.startTicks, executable };
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

function errorTag(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) return error.message;
  return "unknown";
}

async function waitForProcessIdentitiesGone(identities: Iterable<ProcessIdentity>): Promise<void> {
  const captured = [...identities];
  const deadline = Date.now() + 5_000;
  for (;;) {
    const alive = captured.some(
      (identity) => processStat(identity.pid)?.startTicks === identity.startTicks,
    );
    if (!alive) return;
    if (Date.now() >= deadline) throw new Error("selfhost_descendant_quiescence_timeout");
    await Bun.sleep(25);
  }
}

async function waitForHost(host: Host, url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    rememberHostDescendants(host);
    if (host.exitCode !== null) throw new Error("selfhost_startup_exit");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Readiness is the real API listener, not a child log line.
    }
    await Bun.sleep(50);
  }
  throw new Error("selfhost_api_listener_not_ready");
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 3_000;
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
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(new Error(`selfhost_listener_probe_error_${port}_${error.code ?? "unknown"}`));
    });
  });
}

async function api<T extends Json>(
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${HOST_ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== expectedStatus) {
    let code = "unknown";
    try {
      const payload = (await response.json()) as { readonly error?: unknown };
      const envelope = payload.error;
      if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
        const candidate = (envelope as { readonly code?: unknown }).code;
        if (typeof candidate === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(candidate)) {
          code = candidate;
        }
      }
    } catch {
      // Keep only the stable classification; never forward Host response bodies.
    }
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(
      `selfhost_api_${method.toLowerCase()}_${response.status}_expected_${expectedStatus}_${code}`,
    );
  }
  return (await response.json()) as T;
}

async function readResourceGraph(
  auth: Record<string, string>,
  forms: Map<string, Json>,
): Promise<Json[]> {
  const resources: Json[] = [];
  for (const [kind, name] of RESOURCE_NAMES) {
    const formRef = forms.get(kind);
    if (!formRef) throw new Error(`selfhost_form_missing_${kind}`);
    const query = new URLSearchParams({
      space: SPACE,
      definitionVersion: stringAt(formRef, "definitionVersion"),
      schemaDigest: stringAt(formRef, "schemaDigest"),
    });
    const resource = await api<Json>(
      "GET",
      `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${query}`,
      200,
      undefined,
      auth,
    );
    const metadata = objectAt(resource, "metadata");
    const status = objectAt(resource, "status");
    resources.push({
      kind,
      name,
      uid: stringAt(metadata, "uid"),
      revision: stringAt(metadata, "revision"),
      ...(status.outputs === undefined ? {} : { outputs: objectValue(status.outputs, "outputs") }),
    });
  }
  return resources;
}

function output(resource: Json, name: string): string {
  return stringAt(objectAt(resource, "status").outputs as Json, name);
}

function objectAt(value: Json, key: string): Json {
  const found = value[key];
  return objectValue(found, key);
}

function objectValue(value: unknown, name: string): Json {
  const found = value;
  if (found === null || typeof found !== "object" || Array.isArray(found)) {
    throw new Error(`expected_object_${name}`);
  }
  return found as Json;
}

function stringAt(value: Json, key: string): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0) throw new Error(`expected_string_${key}`);
  return found;
}

async function createTls(directory: string): Promise<{ certificate: string; privateKey: string }> {
  const certificate = join(directory, "worker-cert.pem");
  const privateKey = join(directory, "worker-key.pem");
  const generated = Bun.spawn(
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
      "/CN=*.apps.selfhost.test",
      "-addext",
      "subjectAltName=DNS:*.apps.selfhost.test",
    ],
    { env: childEnvironment(directory), stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const status = await generated.exited;
  if (status !== 0) throw new Error("synthetic_tls_generation_failed");
  chmodSync(privateKey, 0o600);
  chmodSync(certificate, 0o600);
  return { certificate, privateKey };
}

type WorkerHttpsTransportFailureKind =
  | "connection_refused"
  | "connection_reset"
  | "timeout"
  | "tls_validation"
  | "other";

const RETRYABLE_WORKER_HTTPS_FAILURES = new Set<WorkerHttpsTransportFailureKind>([
  "connection_refused",
  "connection_reset",
  "timeout",
]);

class WorkerHttpsTransportFailure extends Error {
  constructor(readonly kind: WorkerHttpsTransportFailureKind) {
    super("worker_https_transport_failure");
  }
}

function workerRequest(hostname: string, certificatePath: string, path: string): Promise<string> {
  return workerRequestAttempt(hostname, certificatePath, path, 5_000).catch((error: unknown) => {
    if (error instanceof WorkerHttpsTransportFailure) {
      throw new Error("worker_https_transport_error");
    }
    throw error;
  });
}

function workerRequestAttempt(
  hostname: string,
  certificatePath: string,
  path: string,
  timeoutMs: number,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("worker_https_timeout_budget_invalid");
  }
  const certificate = readFileSync(certificatePath, "utf8");
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    };
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: hostname,
        path,
        method: "GET",
        headers: { host: hostname },
        ca: certificate,
      },
      (response) => {
        if (response.statusCode !== 200) {
          clearDeadline();
          const status = response.statusCode ?? 0;
          response.destroy();
          reject(new Error(`worker_https_status_${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("error", () => {
          clearDeadline();
          reject(new Error("worker_https_response_error"));
        });
        response.on("end", () => {
          clearDeadline();
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    timeout = setTimeout(
      () => request.destroy(new WorkerHttpsTransportFailure("timeout")),
      timeoutMs,
    );
    request.on("error", (error: unknown) => {
      clearDeadline();
      reject(new WorkerHttpsTransportFailure(workerHttpsTransportFailureKind(error)));
    });
    request.end();
  });
}

function workerHttpsTransportFailureKind(error: unknown): WorkerHttpsTransportFailureKind {
  if (error instanceof WorkerHttpsTransportFailure) return error.kind;
  if (typeof error !== "object" || error === null || !("code" in error)) return "other";
  const code = (error as { readonly code?: unknown }).code;
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ECONNRESET") return "connection_reset";
  if (code === "ETIMEDOUT") return "timeout";
  if (
    code === "CERT_HAS_EXPIRED" ||
    code === "CERT_NOT_YET_VALID" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return "tls_validation";
  }
  return "other";
}

async function waitForRecoveredWorkerMarker(
  host: Host,
  hostIdentity: ProcessIdentity,
  replacementWorkerd: ProcessIdentity,
  hostname: string,
  certificatePath: string,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    assertHostStillSameProcess(host, hostIdentity);
    if (!identityIsLive(replacementWorkerd)) {
      throw new Error("selfhost_replacement_workerd_changed_during_readiness");
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("selfhost_worker_endpoint_readiness_timeout");
    try {
      const marker = await workerRequestAttempt(
        hostname,
        certificatePath,
        "/",
        Math.min(5_000, remainingMs),
      );
      assertHostStillSameProcess(host, hostIdentity);
      if (!identityIsLive(replacementWorkerd)) {
        throw new Error("selfhost_replacement_workerd_changed_during_readiness");
      }
      if (marker !== WORKER_MARKER) throw new Error("selfhost_worker_marker_unexpected");
      return marker;
    } catch (error) {
      if (
        !(error instanceof WorkerHttpsTransportFailure) ||
        !RETRYABLE_WORKER_HTTPS_FAILURES.has(error.kind)
      ) {
        throw error;
      }
      const retryDelayMs = Math.min(50, deadline - Date.now());
      if (retryDelayMs <= 0) throw new Error("selfhost_worker_endpoint_readiness_timeout");
      await Bun.sleep(retryDelayMs);
    }
  }
}
