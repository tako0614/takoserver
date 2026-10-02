import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takoformCoreVerifierArtifactDigest } from "../scripts/deploy/form-authority.ts";
import { bytesDigest } from "../src/json.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { loadPublisherSetClosure } from "../src/takoform/publisher-set-closure.ts";
import { assertIsolatedSelfhostNativeEnvironment } from "./helpers/isolated-selfhost-native.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";
import {
  buildRealCoreVerifier,
  realCoreVerificationRequest,
} from "./helpers/real-core-verifier.ts";

const NATIVE_OPT_IN = process.env.TAKOSERVER_NATIVE_OBJECT_BUCKET_HOST_RESTART === "1";
const WORKERD = process.env.TAKOSERVER_WORKERD_BINARY;
const HOST_ORIGIN = "http://127.0.0.1:8787";
const API_PORT = 8787;
const CORE_VERIFIER_PORT = 8080;
const CORE_VERIFIER_ORIGIN = `http://127.0.0.1:${CORE_VERIFIER_PORT}`;
const WORKER_SUFFIX = "apps.selfhost.test";
const LANE = "/apis/forms.takoform.com/v1";
const SPACE = "default";
const KEY = "host-restart/shared-object.txt";
const FOREIGN_KEY = "host-restart/foreign-sentinel.txt";
const LOCAL_SECRET = "bucket-object-after-host-restart";
const FOREIGN_SECRET = "must-stay-in-the-other-bucket";
const BUCKETS = [
  ["ObjectBucket", "host-restart-media"],
  ["ObjectBucket", "host-restart-other"],
] as const;

type Json = Record<string, unknown>;
type Host = ReturnType<typeof Bun.spawn>;

const WORKER_MODULE = (bindingName: string) => `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const objects = env[${JSON.stringify(bindingName)}];
    const key = url.searchParams.get("key") || "${KEY}";
    if (url.pathname === "/write" || url.pathname === "/update") {
      const body = await request.text();
      await objects.put(key, body, { contentType: "text/plain" });
      const result = await objects.get(key);
      return new Response(result ? await new Response(result.body).text() : "missing");
    }
    if (url.pathname === "/get") {
      const result = await objects.get(key);
      return result ? new Response(result.body) : Response.json({ found: false });
    }
    if (url.pathname === "/delete") {
      await objects.delete(key);
      return new Response("deleted");
    }
    if (url.pathname === "/seed-foreign") {
      await objects.put("${FOREIGN_KEY}", "${FOREIGN_SECRET}", { contentType: "text/plain" });
      return new Response("seeded");
    }
    return new Response("not found", { status: 404 });
  },
};`;

test.skipIf(
  !NATIVE_OPT_IN ||
    nativeEvidenceBinary("object-bucket-host-restart", "TAKOSERVER_WORKERD_BINARY") === undefined,
)(
  "an ObjectBucket managed through the public Host API stays scoped and usable after Host restart",
  async () => {
    if (!WORKERD) throw new Error("workerd native evidence is required when this test is opted in");
    await assertIsolatedSelfhostNativeEnvironment({
      fixedPorts: [API_PORT, CORE_VERIFIER_PORT, 443],
    });

    // This is a real local Host journey: released publisher closure, real Core,
    // and the repository admission CLI. Do not replace that authority path with
    // hand-written activation rows; the CLI's slow-root work is tracked by its
    // owner, so this native case remains opt-in until that path is qualified.
    const fixture = mkdtempSync(join(tmpdir(), "takoserver-object-bucket-host-restart-"));
    chmodSync(fixture, 0o700);
    const dataRoot = join(fixture, "data");
    const databaseDirectory = join(fixture, "control-db");
    const databasePath = join(databaseDirectory, "control.sqlite");
    const tlsDirectory = join(fixture, "tls");
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 });

    const baseEnvironment = childEnvironment(fixture);
    const coreVerifierArtifactDigest = takoformCoreVerifierArtifactDigest();
    const hostEnvironment = () => ({
      ...baseEnvironment,
      TAKOSERVER_DATA_ROOT: dataRoot,
      TAKOSERVER_DB: databasePath,
      TAKOSERVER_PUBLIC_ORIGIN: HOST_ORIGIN,
      PORT: String(API_PORT),
      TAKOSERVER_WORKERD_BINARY: WORKERD,
      TAKOSERVER_WORKERD_PORT: "443",
      TAKOSERVER_WORKER_ENDPOINT_PORT: "443",
      TAKOSERVER_WORKER_ENDPOINT_SUFFIX: WORKER_SUFFIX,
      TAKOSERVER_WORKERD_TLS_CERT_FILE: join(tlsDirectory, "worker-cert.pem"),
      TAKOSERVER_WORKERD_TLS_KEY_FILE: join(tlsDirectory, "worker-key.pem"),
    });

    let host: Host | undefined;
    let verifier: ReturnType<typeof Bun.spawn> | undefined;
    let admission: ReturnType<typeof Bun.spawn> | undefined;
    const cleanupFailures: string[] = [];
    let caughtFailure = false;
    let testFailure: unknown;
    try {
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [CORE_VERIFIER_PORT] });
      const coreVerifierBinary = buildRealCoreVerifier(join(fixture, "core-verifier"));
      verifier = Bun.spawn([coreVerifierBinary], {
        cwd: process.cwd(),
        env: {
          ...baseEnvironment,
          TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: coreVerifierArtifactDigest,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: verifier });
      await waitForCoreVerifier(verifier, coreVerifierArtifactDigest);
      await createTls(tlsDirectory);

      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [API_PORT, 443],
        ownedChild: verifier,
      });
      host = startHost(hostEnvironment());
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
      await waitForHost(host);
      const operatorPrivateJwk = readFileSync(join(dataRoot, "operator-key.jwk"), "utf8");
      const assertion = await signOperatorAssertion({
        privateJwk: operatorPrivateJwk,
        claims: {
          purpose: "sign-in",
          aud: HOST_ORIGIN,
          provider: "google",
          subject: "object-bucket-host-restart-operator",
          email: "object-bucket-host-restart@localhost",
          displayName: "Object Bucket Host Restart",
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
      const organizationResponse = await api<Json>(
        "POST",
        "/v1/organizations",
        201,
        { name: "Object Bucket Host Restart" },
        { authorization: `Bearer ${sessionToken}` },
      );
      const organizationId = stringAt(objectAt(organizationResponse, "organization"), "id");
      const apiKeyResponse = await api<Json>(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        201,
        {
          name: "object-bucket-host-restart",
          scopes: ["resources:read", "resources:write"],
          expiresInSeconds: 600,
        },
        { authorization: `Bearer ${sessionToken}` },
      );
      const auth = {
        authorization: `Bearer ${stringAt(apiKeyResponse, "secret")}`,
        "takoform-organization": organizationId,
      };

      await stopHost(host);
      host = undefined;
      await verifyAndAdmitForms(
        {
          organizationId,
          dataRoot,
          environment: hostEnvironment(),
          closure: await loadPublisherSetClosure(),
        },
        (process) => {
          admission = process;
        },
      );
      admission = undefined;
      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [API_PORT, 443],
        ownedChild: verifier,
      });
      host = startHost(hostEnvironment());
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
      await waitForHost(host);
      const firstHostPid = host.pid;

      const forms = await discoverForms(auth);
      const reference = (kind: string, name: string) => ({
        apiVersion: stringAt(forms.get(kind) as Json, "apiVersion"),
        kind,
        name,
      });
      const apply = async (kind: string, name: string, spec: Json): Promise<Json> => {
        const formRef = forms.get(kind);
        if (!formRef) throw new Error(`selfhost_form_missing_${kind}`);
        const desired = {
          apiVersion: stringAt(formRef, "apiVersion"),
          kind,
          form: { formRef },
          metadata: { name, space: SPACE },
          spec,
        };
        const prepared = await api<Json>("POST", `${LANE}/resources/prepare`, 200, desired, auth);
        const query = formQuery(formRef);
        return await api<Json>(
          "PUT",
          `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${query}`,
          201,
          { ...desired, review: objectAt(prepared, "review") },
          { ...auth, "idempotency-key": `create-${kind}-${name}`, "if-none-match": "*" },
        );
      };

      const buckets = new Map<string, Json>();
      for (const [kind, name] of BUCKETS) buckets.set(name, await apply(kind, name, {}));
      const bucketNames = new Map<string, string>(
        [...buckets].map(([name, resource]) => [name, output(resource, "bucketName")]),
      );
      const bucketPaths = new Map(
        [...bucketNames].map(([name, bucketName]) => [
          name,
          join(dataRoot, "selfhost", "objects", bucketName),
        ]),
      );

      const publishModuleArtifact = async (source: string, id: string): Promise<string> => {
        const moduleBytes = new TextEncoder().encode(source);
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
          { ...auth, "idempotency-key": `${id}-upload` },
        );
        const uploadId = stringAt(upload, "uploadId");
        expect(upload.missingBlobs).toContain(moduleDigest);
        const put = await fetch(
          `${HOST_ORIGIN}${LANE}/artifacts/uploads/${uploadId}/blobs/${moduleDigest}`,
          { method: "PUT", headers: auth, body: moduleBytes },
        );
        expect(put.status).toBe(201);
        await put.arrayBuffer();
        const committed = await api<Json>(
          "POST",
          `${LANE}/artifacts/uploads/${uploadId}/commit`,
          201,
          undefined,
          { ...auth, "idempotency-key": `${id}-commit` },
        );
        return stringAt(committed, "manifestDigest");
      };

      const apps = [
        {
          worker: "object-bucket-media-worker",
          bundle: "object-bucket-media-bundle",
          version: "object-bucket-media-version",
          deployment: "object-bucket-media-deployment",
          endpoint: "object-bucket-media-endpoint",
          binding: "MEDIA",
          bucket: "host-restart-media",
        },
        {
          worker: "object-bucket-other-worker",
          bundle: "object-bucket-other-bundle",
          version: "object-bucket-other-version",
          deployment: "object-bucket-other-deployment",
          endpoint: "object-bucket-other-endpoint",
          binding: "PRIVATE",
          bucket: "host-restart-other",
        },
      ] as const;
      const appResources = new Map<string, Json>();
      for (const app of apps) {
        const bundleDigest = await publishModuleArtifact(WORKER_MODULE(app.binding), app.worker);
        const moduleWorker = await apply("ModuleWorker", app.worker, {});
        const workerBundle = await apply("WorkerBundle", app.bundle, {
          manifestDigest: bundleDigest,
        });
        const workerVersion = await apply("WorkerVersion", app.version, {
          worker: reference("ModuleWorker", app.worker),
          bundle: reference("WorkerBundle", app.bundle),
          handlers: ["fetch"],
          requiredSensitiveVars: [],
          bucketBindings: [{ name: app.binding, resource: reference("ObjectBucket", app.bucket) }],
        });
        const workerDeployment = await apply("WorkerDeployment", app.deployment, {
          worker: reference("ModuleWorker", app.worker),
          versions: [{ workerVersion: reference("WorkerVersion", app.version), weight: 10_000 }],
        });
        const workerEndpoint = await apply("WorkerEndpoint", app.endpoint, {
          worker: reference("ModuleWorker", app.worker),
        });
        appResources.set(app.worker, moduleWorker);
        appResources.set(app.bundle, workerBundle);
        appResources.set(app.version, workerVersion);
        appResources.set(app.deployment, workerDeployment);
        appResources.set(app.endpoint, workerEndpoint);
      }

      const endpoints = new Map<string, string>();
      for (const app of apps) {
        const resource = appResources.get(app.endpoint);
        if (!resource) throw new Error("selfhost_object_bucket_endpoint_missing");
        const url = new URL(output(resource, "url"));
        if (url.protocol !== "https:" || url.port !== "") {
          throw new Error("selfhost_object_bucket_endpoint_not_canonical_https");
        }
        endpoints.set(app.worker, url.hostname);
      }
      const mediaHost = endpoints.get("object-bucket-media-worker");
      const otherHost = endpoints.get("object-bucket-other-worker");
      if (!mediaHost || !otherHost) throw new Error("selfhost_object_bucket_endpoint_missing");
      const certificate = join(tlsDirectory, "worker-cert.pem");

      expect(await workerRequest(mediaHost, certificate, "POST", "/write", LOCAL_SECRET)).toEqual({
        status: 200,
        body: LOCAL_SECRET,
      });
      expect(
        await workerRequest(otherHost, certificate, "POST", "/write", FOREIGN_SECRET, FOREIGN_KEY),
      ).toEqual({
        status: 200,
        body: FOREIGN_SECRET,
      });
      expect(
        await workerRequest(
          mediaHost,
          certificate,
          "GET",
          `/get?key=${encodeURIComponent(FOREIGN_KEY)}`,
        ),
      ).toEqual({
        status: 200,
        body: JSON.stringify({ found: false }),
      });
      const mediaBucketPath = bucketPaths.get("host-restart-media");
      const otherBucketPath = bucketPaths.get("host-restart-other");
      if (!mediaBucketPath || !otherBucketPath)
        throw new Error("selfhost_object_bucket_path_missing");
      expect(existsSync(mediaBucketPath)).toBe(true);
      expect(existsSync(otherBucketPath)).toBe(true);

      await stopHost(host);
      host = undefined;
      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [API_PORT, 443],
        ownedChild: verifier,
      });
      host = startHost(hostEnvironment());
      if (host.pid === firstHostPid)
        throw new Error("selfhost_object_bucket_host_pid_not_replaced");
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
      await waitForHost(host);
      const retainedBucket = await readResource(auth, forms, "ObjectBucket", "host-restart-media");
      const expectedMediaBucketName = bucketNames.get("host-restart-media");
      if (!expectedMediaBucketName) throw new Error("selfhost_object_bucket_name_missing");
      expect(output(retainedBucket, "bucketName")).toBe(expectedMediaBucketName);
      expect(
        await workerRequest(mediaHost, certificate, "GET", `/get?key=${encodeURIComponent(KEY)}`),
      ).toEqual({
        status: 200,
        body: LOCAL_SECRET,
      });
      expect(
        await workerRequest(
          otherHost,
          certificate,
          "GET",
          `/get?key=${encodeURIComponent(FOREIGN_KEY)}`,
        ),
      ).toEqual({
        status: 200,
        body: FOREIGN_SECRET,
      });
      expect(
        await workerRequest(
          mediaHost,
          certificate,
          "GET",
          `/get?key=${encodeURIComponent(FOREIGN_KEY)}`,
        ),
      ).toEqual({
        status: 200,
        body: JSON.stringify({ found: false }),
      });
      expect(
        await workerRequest(otherHost, certificate, "POST", "/delete", undefined, FOREIGN_KEY),
      ).toEqual({
        status: 200,
        body: "deleted",
      });
      expect(
        await workerRequest(
          otherHost,
          certificate,
          "GET",
          `/get?key=${encodeURIComponent(FOREIGN_KEY)}`,
        ),
      ).toEqual({
        status: 200,
        body: JSON.stringify({ found: false }),
      });

      const updated = "updated-after-host-restart";
      expect(await workerRequest(mediaHost, certificate, "POST", "/update", updated)).toEqual({
        status: 200,
        body: updated,
      });
      expect(await workerRequest(mediaHost, certificate, "POST", "/delete")).toEqual({
        status: 200,
        body: "deleted",
      });
      expect(
        await workerRequest(mediaHost, certificate, "GET", `/get?key=${encodeURIComponent(KEY)}`),
      ).toEqual({
        status: 200,
        body: JSON.stringify({ found: false }),
      });
      expect(countRegularFiles(mediaBucketPath)).toBe(0);

      for (const app of [...apps].reverse()) {
        for (const [kind, name] of [
          ["WorkerEndpoint", app.endpoint],
          ["WorkerDeployment", app.deployment],
          ["WorkerVersion", app.version],
          ["WorkerBundle", app.bundle],
          ["ModuleWorker", app.worker],
        ] as const) {
          const resource = appResources.get(name);
          if (!resource) throw new Error(`selfhost_object_bucket_resource_missing_${name}`);
          await deleteResource(
            auth,
            forms,
            kind,
            name,
            stringAt(objectAt(resource, "metadata"), "uid"),
          );
        }
      }
      for (const [kind, name] of [...BUCKETS].reverse()) {
        const bucket = buckets.get(name);
        if (!bucket) throw new Error(`selfhost_object_bucket_resource_missing_${name}`);
        await deleteResource(
          auth,
          forms,
          kind,
          name,
          stringAt(objectAt(bucket, "metadata"), "uid"),
        );
      }
      expect(existsSync(mediaBucketPath)).toBe(false);
      expect(existsSync(otherBucketPath)).toBe(false);
      expect(statSync(join(dataRoot, "selfhost", "objects")).isDirectory()).toBe(true);
    } catch (error) {
      caughtFailure = true;
      testFailure = error;
    } finally {
      if (admission) {
        try {
          await stopChild(admission, "selfhost_object_bucket_admission");
          admission = undefined;
        } catch {
          cleanupFailures.push("admission");
        }
      }
      if (host) {
        try {
          await stopHost(host);
          host = undefined;
        } catch {
          cleanupFailures.push("host");
        }
      }
      if (verifier) {
        try {
          await stopChild(verifier, "selfhost_object_bucket_core");
          verifier = undefined;
        } catch {
          cleanupFailures.push("core");
        }
      }
      if (cleanupFailures.length === 0) rmSync(fixture, { recursive: true, force: true });
    }
    if (cleanupFailures.length > 0) {
      throw new Error(
        `selfhost_object_bucket_cleanup_unconfirmed_${cleanupFailures.join("_")}_${fixture}`,
        {
          cause: caughtFailure ? testFailure : undefined,
        },
      );
    }
    if (caughtFailure) throw testFailure;
  },
  240_000,
);

async function verifyAndAdmitForms(
  input: {
    readonly organizationId: string;
    readonly dataRoot: string;
    readonly environment: Record<string, string>;
    readonly closure: Awaited<ReturnType<typeof loadPublisherSetClosure>>;
  },
  trackAdmission: (child: ReturnType<typeof Bun.spawn> | undefined) => void,
): Promise<void> {
  const request = await realCoreVerificationRequest(input.closure);
  const accepted = await fetch(`${CORE_VERIFIER_ORIGIN}/v1/verify-set`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (accepted.status !== 200)
    throw new Error("selfhost_object_bucket_core_refused_publisher_closure");
  const acceptedReceipt = (await accepted.json()) as Json;
  expect(objectAt(acceptedReceipt, "identity").protocol).toBe(
    "takoserver.takoform-core-verifier@v1",
  );
  expect(objectAt(acceptedReceipt, "identity").coreVersion).toBe("v1.1.0");
  expect(objectAt(acceptedReceipt, "identity").coreCommit).toBe(
    "e0e48b864de2a127a255cb0574d37bbb0f1cac29",
  );
  expect(acceptedReceipt.packages).toHaveLength(input.closure.identity.packageCount);
  const identityResponse = await fetch(`${CORE_VERIFIER_ORIGIN}/v1/identity`);
  if (!identityResponse.ok) throw new Error("selfhost_object_bucket_core_identity_missing");
  const identity = (await identityResponse.json()) as Json;
  expect(identity.protocol).toBe("takoserver.takoform-core-verifier@v1");
  expect(identity.coreVersion).toBe("v1.1.0");
  expect(identity.coreCommit).toBe("e0e48b864de2a127a255cb0574d37bbb0f1cac29");
  expect(identity.artifactDigest).toBe(takoformCoreVerifierArtifactDigest());

  const result = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "scripts/selfhost-form-admission.ts",
      input.organizationId,
      SPACE,
      "--apply",
      "--data-root",
      input.dataRoot,
      "--host-id",
      HOST_ORIGIN,
      "--core-verifier",
      CORE_VERIFIER_ORIGIN,
    ],
    {
      cwd: process.cwd(),
      env: input.environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  trackAdmission(result);
  const completed = await Promise.race([result.exited, Bun.sleep(120_000).then(() => null)]);
  if (completed === null) {
    result.kill("SIGTERM");
    const stopped = await Promise.race([result.exited, Bun.sleep(5_000).then(() => null)]);
    if (stopped === null) {
      result.kill("SIGKILL");
      const killed = await Promise.race([result.exited, Bun.sleep(2_000).then(() => null)]);
      if (killed === null) throw new Error("selfhost_object_bucket_admission_termination_unknown");
    }
    trackAdmission(undefined);
    throw new Error("selfhost_object_bucket_admission_cli_slowroot_timeout");
  }
  trackAdmission(undefined);
  if (completed !== 0) throw new Error("selfhost_object_bucket_admission_cli_nonzero_exit");
  const output = await new Response(result.stdout).text();
  expect(output).toMatch(/^apply: converged \([1-9]\d* receipt\(s\), released-core\)$/m);
}

function childEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    CI: "1",
    NO_COLOR: "1",
    CHECKPOINT_DISABLE: "1",
  };
}

function startHost(environment: Record<string, string>): Host {
  return Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitForHost(host: Host): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (host.exitCode !== null) throw new Error("selfhost_object_bucket_host_startup_exit");
    try {
      const response = await fetch(`${HOST_ORIGIN}/.well-known/takoform/v1`, {
        signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Probe the actual HTTP listener rather than treating process start as ready.
    }
    await Bun.sleep(50);
  }
  throw new Error("selfhost_object_bucket_host_listener_not_ready");
}

async function stopHost(host: Host): Promise<void> {
  if (host.exitCode !== null) throw new Error("selfhost_object_bucket_host_exited_early");
  host.kill("SIGTERM");
  const exitCode = await Promise.race([host.exited, Bun.sleep(10_000).then(() => null)]);
  if (exitCode === null) {
    host.kill("SIGKILL");
    const killed = await Promise.race([host.exited, Bun.sleep(2_000).then(() => null)]);
    if (killed === null) throw new Error("selfhost_object_bucket_host_termination_unknown");
    throw new Error("selfhost_object_bucket_host_required_sigkill");
  }
  if (exitCode !== 0) throw new Error(`selfhost_object_bucket_host_exit_${exitCode}`);
  await waitForPortClosed(API_PORT);
  await waitForPortClosed(443);
}

async function stopChild(child: ReturnType<typeof Bun.spawn>, name: string): Promise<void> {
  if (child.exitCode === null) child.kill("SIGTERM");
  const exitCode = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
  if (exitCode === null) {
    child.kill("SIGKILL");
    const killed = await Promise.race([child.exited, Bun.sleep(2_000).then(() => null)]);
    if (killed === null) throw new Error(`${name}_termination_unknown`);
    throw new Error(`${name}_required_sigkill`);
  }
}

async function waitForCoreVerifier(
  verifier: ReturnType<typeof Bun.spawn>,
  artifactDigest: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (verifier.exitCode !== null) throw new Error("selfhost_object_bucket_core_exited");
    try {
      const response = await fetch(`${CORE_VERIFIER_ORIGIN}/v1/identity`);
      if (response.ok) {
        const identity = (await response.json()) as Json;
        if (
          identity.protocol !== "takoserver.takoform-core-verifier@v1" ||
          identity.coreVersion !== "v1.1.0" ||
          identity.coreCommit !== "e0e48b864de2a127a255cb0574d37bbb0f1cac29" ||
          identity.artifactDigest !== artifactDigest
        ) {
          throw new Error("selfhost_object_bucket_core_identity_mismatch");
        }
        return;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "selfhost_object_bucket_core_identity_mismatch"
      )
        throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error("selfhost_object_bucket_core_startup_timeout");
}

async function createTls(directory: string): Promise<void> {
  const certificate = join(directory, "worker-cert.pem");
  const privateKey = join(directory, "worker-key.pem");
  const generated = Bun.spawnSync(
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
    {
      env: childEnvironment(directory),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 15_000,
    },
  );
  if (!generated.success) throw new Error("selfhost_object_bucket_tls_generation_failed");
  chmodSync(privateKey, 0o600);
  chmodSync(certificate, 0o600);
}

async function discoverForms(auth: Record<string, string>): Promise<Map<string, Json>> {
  const discovery = await api<Json>("GET", `${LANE}/forms?space=${SPACE}`, 200, undefined, auth);
  const forms = new Map<string, Json>();
  for (const item of discovery.forms as Json[]) {
    const formRef = objectAt(objectAt(item, "identity"), "formRef");
    forms.set(stringAt(formRef, "kind"), formRef);
  }
  for (const kind of [
    "ObjectBucket",
    "ModuleWorker",
    "WorkerBundle",
    "WorkerVersion",
    "WorkerDeployment",
    "WorkerEndpoint",
  ]) {
    if (!forms.has(kind)) throw new Error(`selfhost_form_missing_${kind}`);
  }
  return forms;
}

async function readResource(
  auth: Record<string, string>,
  forms: Map<string, Json>,
  kind: string,
  name: string,
): Promise<Json> {
  const formRef = forms.get(kind);
  if (!formRef) throw new Error(`selfhost_form_missing_${kind}`);
  return await api<Json>(
    "GET",
    `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${formQuery(formRef)}`,
    200,
    undefined,
    auth,
  );
}

async function deleteResource(
  auth: Record<string, string>,
  forms: Map<string, Json>,
  kind: string,
  name: string,
  expectedUid: string,
): Promise<void> {
  const formRef = forms.get(kind);
  if (!formRef) throw new Error(`selfhost_form_missing_${kind}`);
  const path = `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${formQuery(formRef)}`;
  const current = await api<Json>("GET", path, 200, undefined, auth);
  const metadata = objectAt(current, "metadata");
  expect(stringAt(metadata, "uid")).toBe(expectedUid);
  await api<undefined>("DELETE", path, 204, undefined, {
    ...auth,
    "idempotency-key": `delete-${kind}-${name}`,
    "takoform-expected-generation": stringAt(metadata, "generation"),
    "if-match": `"${stringAt(metadata, "revision")}"`,
  });
  const missing = await api<Json>("GET", path, 404, undefined, auth);
  expect(stringAt(objectAt(missing, "error"), "code")).toBe("resource_not_found");
}

function formQuery(formRef: Json): string {
  return new URLSearchParams({
    space: SPACE,
    definitionVersion: stringAt(formRef, "definitionVersion"),
    schemaDigest: stringAt(formRef, "schemaDigest"),
  }).toString();
}

async function api<T = Json>(
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${HOST_ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== expectedStatus) {
    let code = "unknown";
    try {
      const payload = (await response.json()) as Json;
      const envelope = payload.error;
      if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
        const candidate = (envelope as Json).code;
        if (typeof candidate === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(candidate))
          code = candidate;
      }
    } catch {
      // Keep only the stable classification; never forward response bodies.
    }
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(
      `selfhost_object_bucket_api_${method.toLowerCase()}_${response.status}_expected_${expectedStatus}_${code}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function workerRequest(
  hostname: string,
  certificatePath: string,
  method: string,
  path: string,
  body?: string,
  key = KEY,
): Promise<{ readonly status: number; readonly body: string }> {
  const certificate = readFileSync(certificatePath, "utf8");
  const requestPath =
    path === "/write" || path === "/update" || path === "/delete"
      ? `${path}?key=${encodeURIComponent(key)}`
      : path;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: hostname,
        path: requestPath,
        method,
        headers: {
          host: hostname,
          ...(body === undefined
            ? {}
            : { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) }),
        },
        ca: certificate,
        timeout: 5_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("error", () =>
          reject(new Error("selfhost_object_bucket_worker_response_error")),
        );
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("selfhost_object_bucket_worker_timeout")),
    );
    request.on("error", () => reject(new Error("selfhost_object_bucket_worker_transport_error")));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await portIsClosed(port)) return;
    await Bun.sleep(50);
  }
  throw new Error(`selfhost_object_bucket_listener_not_closed_${port}`);
}

function portIsClosed(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("selfhost_object_bucket_port_probe_timeout"));
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(new Error("selfhost_object_bucket_port_probe_error"));
    });
  });
}

function objectAt(value: Json, key: string): Json {
  const found = value[key];
  if (found === null || typeof found !== "object" || Array.isArray(found)) {
    throw new Error(`selfhost_object_bucket_expected_object_${key}`);
  }
  return found as Json;
}

function countRegularFiles(directory: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += countRegularFiles(path);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function stringAt(value: Json, key: string): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0) {
    throw new Error(`selfhost_object_bucket_expected_string_${key}`);
  }
  return found;
}

function output(resource: Json, name: string): string {
  return stringAt(objectAt(resource, "status").outputs as Json, name);
}
