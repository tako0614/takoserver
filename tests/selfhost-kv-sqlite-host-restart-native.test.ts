import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takoformCoreVerifierArtifactDigest } from "../scripts/deploy/form-authority.ts";
import { bytesDigest } from "../src/json.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { loadPublisherSetClosure } from "../src/takoform/publisher-set-closure.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import { assertIsolatedSelfhostNativeEnvironment } from "./helpers/isolated-selfhost-native.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";
import {
  buildRealCoreVerifier,
  realCoreVerificationRequest,
} from "./helpers/real-core-verifier.ts";

// Native-only: the accepted workerd artifact must be available, loopback must
// be enabled, and port 443 must be free in the isolated test namespace.
const WORKERD = nativeEvidenceBinary("workerd-artifact") ?? null;
const HOST_ORIGIN = "http://127.0.0.1:8787";
const API_PORT = 8787;
const CORE_VERIFIER_PORT = 8080;
const CORE_VERIFIER_ORIGIN = `http://127.0.0.1:${CORE_VERIFIER_PORT}`;
const WORKER_SUFFIX = "apps.selfhost.test";
const LANE = "/apis/forms.takoform.com/v1";
const SPACE = "default";
const TABLE = "restart_notes";
const KEY = "os-restart-note";
const VALUE = "kv-and-sqlite-survived-a-new-host-process";
const MODULE_V1 = `export default {
  async fetch(_request, env) {
    const url = new URL(_request.url);
    if (url.pathname === "/write") {
      await env.KV.put(${JSON.stringify(KEY)}, ${JSON.stringify(VALUE)});
      await env.DB.execute("INSERT INTO ${TABLE} (id, body) VALUES (?, ?)", ["kept", ${JSON.stringify(VALUE)}]);
      return Response.json({ version: "v1", written: true });
    }
    if (url.pathname === "/read") {
      const value = await env.KV.get(${JSON.stringify(KEY)});
      const rows = await env.DB.query("SELECT id, body FROM ${TABLE} ORDER BY id");
      return Response.json({ version: "v1", value: value === null ? null : new TextDecoder().decode(value), rows: rows.rows });
    }
    return new Response("v1");
  },
};`;
const MODULE_V2 = `export default {
  async fetch(_request, env) {
    const url = new URL(_request.url);
    if (url.pathname === "/read") {
      const value = await env.KV.get(${JSON.stringify(KEY)});
      const rows = await env.DB.query("SELECT id, body FROM ${TABLE} ORDER BY id");
      return Response.json({ version: "v2", value: value === null ? null : new TextDecoder().decode(value), rows: rows.rows });
    }
    return new Response("v2");
  },
};`;

type Json = Record<string, unknown>;
type Host = ReturnType<typeof startHost>;
type ProcessIdentity = {
  readonly pid: number;
  readonly startTicks: string;
  readonly executable: string;
};
const observedDescendants = new WeakMap<Host, Map<string, ProcessIdentity>>();

const resources = [
  ["ModuleWorker", "journey-worker"],
  ["EdgeKVNamespace", "journey-kv"],
  ["SQLiteDatabase", "journey-db"],
  ["SQLiteMigrationSet", "journey-migrations"],
  ["SQLiteMigrationApplication", "journey-migration-application"],
  ["WorkerBundle", "journey-bundle-v1"],
  ["WorkerVersion", "journey-version-v1"],
  ["WorkerBundle", "journey-bundle-v2"],
  ["WorkerVersion", "journey-version-v2"],
  ["WorkerDeployment", "journey-deployment"],
  ["WorkerEndpoint", "journey-endpoint"],
] as const;
const deleteOrder = [
  ["WorkerEndpoint", "journey-endpoint"],
  ["WorkerDeployment", "journey-deployment"],
  ["WorkerVersion", "journey-version-v2"],
  ["WorkerVersion", "journey-version-v1"],
  ["WorkerBundle", "journey-bundle-v2"],
  ["WorkerBundle", "journey-bundle-v1"],
  ["ModuleWorker", "journey-worker"],
  ["SQLiteMigrationApplication", "journey-migration-application"],
  ["SQLiteMigrationSet", "journey-migrations"],
  ["SQLiteDatabase", "journey-db"],
  ["EdgeKVNamespace", "journey-kv"],
] as const;

test.skipIf(WORKERD === null)(
  "public self-host KV and SQLite data survive a Worker update and a new Host OS process",
  async () => {
    const fixture = join(tmpdir(), `takoserver-kv-sqlite-host-restart-${crypto.randomUUID()}`);
    const sourceRoot = join(fixture, "data");
    const controlDirectory = join(fixture, "control-db");
    const controlDatabase = join(controlDirectory, "control.sqlite");
    const tlsDirectory = join(fixture, "tls");
    mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 });
    chmodSync(fixture, 0o700);

    const baseEnvironment = childEnvironment(fixture);
    const coreArtifactDigest = takoformCoreVerifierArtifactDigest();
    const hostEnvironment = {
      ...baseEnvironment,
      TAKOSERVER_DATA_ROOT: sourceRoot,
      TAKOSERVER_DB: controlDatabase,
      TAKOSERVER_PUBLIC_ORIGIN: HOST_ORIGIN,
      PORT: String(API_PORT),
      TAKOSERVER_WORKERD_BINARY: WORKERD as string,
      TAKOSERVER_WORKERD_PORT: "443",
      TAKOSERVER_WORKER_ENDPOINT_PORT: "443",
      TAKOSERVER_WORKER_ENDPOINT_SUFFIX: WORKER_SUFFIX,
      TAKOSERVER_WORKERD_TLS_CERT_FILE: join(tlsDirectory, "worker-cert.pem"),
      TAKOSERVER_WORKERD_TLS_KEY_FILE: join(tlsDirectory, "worker-key.pem"),
    };

    let verifier: ReturnType<typeof Bun.spawn> | undefined;
    let admission: ReturnType<typeof Bun.spawn> | undefined;
    let host: Host | undefined;
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    let cleanupFailed = false;
    try {
      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [API_PORT, CORE_VERIFIER_PORT, 443],
      });
      const verifierBinary = buildRealCoreVerifier(join(fixture, "core-verifier"));
      verifier = Bun.spawn([verifierBinary], {
        cwd: process.cwd(),
        env: { ...baseEnvironment, TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: coreArtifactDigest },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await waitForCoreVerifier(verifier, coreArtifactDigest);
      await createTls(tlsDirectory);
      host = startHost(hostEnvironment);
      await waitForHost(host, `${HOST_ORIGIN}/.well-known/takoform/v1`);

      const operatorJwk = readFileSync(join(sourceRoot, "operator-key.jwk"), "utf8");
      const assertion = await signOperatorAssertion({
        privateJwk: operatorJwk,
        claims: {
          purpose: "sign-in",
          aud: HOST_ORIGIN,
          provider: "google",
          subject: "kv-sqlite-restart-operator",
          email: "kv-sqlite-restart@localhost",
          displayName: "KV SQLite Restart Operator",
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
        { name: "KV SQLite process restart" },
        { authorization: `Bearer ${sessionToken}` },
      );
      const organizationId = stringAt(objectAt(created, "organization"), "id");
      const keyResponse = await api<Json>(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        201,
        {
          name: "kv-sqlite-restart-native",
          scopes: ["resources:read", "resources:write"],
          expiresInSeconds: 600,
        },
        { authorization: `Bearer ${sessionToken}` },
      );
      const auth = {
        authorization: `Bearer ${stringAt(keyResponse, "secret")}`,
        "takoform-organization": organizationId,
      };

      // Run the same released-Core admission used by the other native Host
      // journey. The Host must be stopped while the CLI owns its SQLite file.
      await stopHost(host);
      host = undefined;
      const closure = await loadPublisherSetClosure();
      const verifyRequest = await realCoreVerificationRequest(closure);
      const verified = await fetch(`${CORE_VERIFIER_ORIGIN}/v1/verify-set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(verifyRequest),
        signal: AbortSignal.timeout(20_000),
      });
      expect(verified.status).toBe(200);
      const verifiedBody = (await verified.json()) as Json;
      expect(objectAt(verifiedBody, "identity")).toMatchObject({
        coreVersion: "v1.1.0",
        coreCommit: "e0e48b864de2a127a255cb0574d37bbb0f1cac29",
      });
      expect(Array.isArray(verifiedBody.packages) ? verifiedBody.packages.length : 0).toBe(17);
      const admissionProcess = Bun.spawn(
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
          CORE_VERIFIER_ORIGIN,
        ],
        {
          cwd: process.cwd(),
          env: hostEnvironment,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      admission = admissionProcess;
      const admissionStatus = await Promise.race([
        admissionProcess.exited,
        Bun.sleep(120_000).then(() => null),
      ]);
      if (admissionStatus === null) throw new Error("selfhost_form_admission_cli_timeout");
      const admissionOutput = await new Response(admissionProcess.stdout).text();
      admission = undefined;
      expect(admissionStatus).toBe(0);
      expect(admissionOutput).toMatch(
        /^apply: converged \([1-9]\d* receipt\(s\), released-core\)$/m,
      );

      host = startHost(hostEnvironment);
      await waitForHost(host, `${HOST_ORIGIN}/.well-known/takoform/v1`);
      const formsResponse = await api<Json>(
        "GET",
        `${LANE}/forms?space=${SPACE}`,
        200,
        undefined,
        auth,
      );
      const forms = new Map(
        (Array.isArray(formsResponse.forms) ? (formsResponse.forms as Json[]) : []).map((form) => {
          const identity = objectAt(form, "identity");
          return [
            stringAt(objectAt(identity, "formRef"), "kind"),
            objectAt(identity, "formRef"),
          ] as const;
        }),
      );
      for (const kind of [
        "EdgeKVNamespace",
        "SQLiteDatabase",
        "SQLiteMigrationSet",
        "SQLiteMigrationApplication",
      ]) {
        if (!forms.has(kind)) throw new Error(`selfhost_released_form_missing_${kind}`);
      }

      const apply = async (
        kind: string,
        name: string,
        spec: Json,
        update?: { readonly current: Json },
      ): Promise<Json> => {
        const formRef = forms.get(kind);
        if (!formRef) throw new Error(`selfhost_released_form_missing_${kind}`);
        const desired = {
          apiVersion: stringAt(formRef, "apiVersion"),
          kind,
          form: { formRef },
          metadata: { name, space: SPACE },
          spec,
        };
        const currentMetadata = update ? objectAt(update.current, "metadata") : undefined;
        const prepared = await api<Json>("POST", `${LANE}/resources/prepare`, 200, desired, {
          ...auth,
          ...(currentMetadata
            ? { "takoform-expected-generation": stringAt(currentMetadata, "generation") }
            : {}),
        });
        const review = objectAt(prepared, "review");
        const query = new URLSearchParams({
          space: SPACE,
          definitionVersion: stringAt(formRef, "definitionVersion"),
          schemaDigest: stringAt(formRef, "schemaDigest"),
        });
        return api<Json>(
          "PUT",
          `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${query}`,
          update ? 200 : 201,
          { ...desired, review },
          {
            ...auth,
            "idempotency-key": `${kind}-${name}-${update ? "update" : "create"}`,
            ...(currentMetadata
              ? {
                  "if-match": `"${stringAt(currentMetadata, "revision")}"`,
                  "takoform-expected-generation": stringAt(currentMetadata, "generation"),
                }
              : { "if-none-match": "*" }),
          },
        );
      };
      const reference = (kind: string, name: string) => ({
        apiVersion: "edge.forms.takoform.com",
        kind,
        name,
      });
      const uploadArtifact = async (
        manifest: Json,
        blobs: readonly { digest: string; bytes: Uint8Array<ArrayBuffer> }[],
        key: string,
      ) => {
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
        for (const blob of blobs) {
          if (!(upload.missingBlobs as unknown[]).includes(blob.digest)) continue;
          const response = await fetch(
            `${HOST_ORIGIN}${LANE}/artifacts/uploads/${uploadId}/blobs/${blob.digest}`,
            { method: "PUT", headers: auth, body: blob.bytes, signal: AbortSignal.timeout(10_000) },
          );
          if (response.status !== 201)
            throw new Error(`selfhost_blob_upload_status_${response.status}`);
          await response.arrayBuffer();
        }
        const committed = await api<Json>(
          "POST",
          `${LANE}/artifacts/uploads/${uploadId}/commit`,
          201,
          undefined,
          { ...auth, "idempotency-key": `${key}-commit` },
        );
        return stringAt(committed, "manifestDigest");
      };

      const moduleV1Bytes = new TextEncoder().encode(MODULE_V1);
      const moduleV1Digest = await bytesDigest(moduleV1Bytes);
      const moduleV1ManifestDigest = await uploadArtifact(
        {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: [
            {
              name: "index.js",
              mediaType: "application/javascript+module",
              size: moduleV1Bytes.byteLength,
              digest: moduleV1Digest,
            },
          ],
        },
        [{ digest: moduleV1Digest, bytes: moduleV1Bytes }],
        "journey-v1",
      );
      const migrationBytes = new TextEncoder().encode(
        `CREATE TABLE ${TABLE} (id TEXT PRIMARY KEY, body TEXT NOT NULL);`,
      );
      const migrationDigest = await bytesDigest(migrationBytes);
      const migrationManifestDigest = await uploadArtifact(
        {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: "MigrationBundle",
          files: [
            {
              path: "0001_restart_notes.sql",
              mediaType: "application/sql",
              size: migrationBytes.byteLength,
              digest: migrationDigest,
            },
          ],
        },
        [{ digest: migrationDigest, bytes: migrationBytes }],
        "journey-migration",
      );

      await apply("ModuleWorker", "journey-worker", {});
      const kvV1 = await apply("EdgeKVNamespace", "journey-kv", {});
      const databaseV1 = await apply("SQLiteDatabase", "journey-db", {});
      const migrationSet = await apply("SQLiteMigrationSet", "journey-migrations", {
        manifestDigest: migrationManifestDigest,
      });
      const migrationApplication = await apply(
        "SQLiteMigrationApplication",
        "journey-migration-application",
        {
          database: reference("SQLiteDatabase", "journey-db"),
          migrationSet: reference("SQLiteMigrationSet", "journey-migrations"),
        },
      );
      const moduleV2Bytes = new TextEncoder().encode(MODULE_V2);
      const moduleV2Digest = await bytesDigest(moduleV2Bytes);
      const moduleV2ManifestDigest = await uploadArtifact(
        {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: [
            {
              name: "index.js",
              mediaType: "application/javascript+module",
              size: moduleV2Bytes.byteLength,
              digest: moduleV2Digest,
            },
          ],
        },
        [{ digest: moduleV2Digest, bytes: moduleV2Bytes }],
        "journey-v2",
      );
      await apply("WorkerBundle", "journey-bundle-v1", { manifestDigest: moduleV1ManifestDigest });
      await apply("WorkerVersion", "journey-version-v1", {
        worker: reference("ModuleWorker", "journey-worker"),
        bundle: reference("WorkerBundle", "journey-bundle-v1"),
        handlers: ["fetch"],
        requiredSensitiveVars: [],
        kvBindings: [{ name: "KV", resource: reference("EdgeKVNamespace", "journey-kv") }],
        sqliteBindings: [{ name: "DB", resource: reference("SQLiteDatabase", "journey-db") }],
      });
      await apply("WorkerBundle", "journey-bundle-v2", { manifestDigest: moduleV2ManifestDigest });
      await apply("WorkerVersion", "journey-version-v2", {
        worker: reference("ModuleWorker", "journey-worker"),
        bundle: reference("WorkerBundle", "journey-bundle-v2"),
        handlers: ["fetch"],
        requiredSensitiveVars: [],
        kvBindings: [{ name: "KV", resource: reference("EdgeKVNamespace", "journey-kv") }],
        sqliteBindings: [{ name: "DB", resource: reference("SQLiteDatabase", "journey-db") }],
      });
      const deploymentV1 = await apply("WorkerDeployment", "journey-deployment", {
        worker: reference("ModuleWorker", "journey-worker"),
        versions: [
          { workerVersion: reference("WorkerVersion", "journey-version-v1"), weight: 10_000 },
        ],
      });
      const endpoint = await apply("WorkerEndpoint", "journey-endpoint", {
        worker: reference("ModuleWorker", "journey-worker"),
      });
      const endpointUrl = output(endpoint, "url");
      const hostname = new URL(endpointUrl).hostname;
      expect(new URL(endpointUrl).protocol).toBe("https:");
      expect(new URL(endpointUrl).port).toBe("");
      const cert = join(tlsDirectory, "worker-cert.pem");
      expect(await workerRequest(hostname, cert, "/")).toBe("v1");
      expect(JSON.parse(await workerRequest(hostname, cert, "/write"))).toEqual({
        version: "v1",
        written: true,
      });
      const beforeUpdate = JSON.parse(await workerRequest(hostname, cert, "/read")) as Json;
      expect(beforeUpdate).toMatchObject({
        version: "v1",
        value: VALUE,
        rows: [{ id: "kept", body: VALUE }],
      });

      const deploymentPath = resourcePath(forms, "WorkerDeployment", "journey-deployment");
      const deploymentCurrent = await api<Json>("GET", deploymentPath, 200, undefined, auth);
      const deploymentV2 = await apply(
        "WorkerDeployment",
        "journey-deployment",
        {
          worker: reference("ModuleWorker", "journey-worker"),
          versions: [
            { workerVersion: reference("WorkerVersion", "journey-version-v2"), weight: 10_000 },
          ],
        },
        { current: deploymentCurrent },
      );
      expect(stringAt(objectAt(deploymentV2, "metadata"), "uid")).toBe(
        stringAt(objectAt(deploymentV1, "metadata"), "uid"),
      );
      expect(stringAt(objectAt(deploymentV2, "metadata"), "revision")).not.toBe(
        stringAt(objectAt(deploymentV1, "metadata"), "revision"),
      );
      const beforeRestart = await resourceGraph(auth, forms, resources);
      expect(
        stringAt(
          resourceGraphItem(beforeRestart, "WorkerEndpoint", "journey-endpoint").outputs ?? {},
          "url",
        ),
      ).toBe(endpointUrl);
      expect(resourceGraphItem(beforeRestart, "EdgeKVNamespace", "journey-kv").uid).toBe(
        stringAt(objectAt(kvV1, "metadata"), "uid"),
      );
      expect(resourceGraphItem(beforeRestart, "SQLiteDatabase", "journey-db").uid).toBe(
        stringAt(objectAt(databaseV1, "metadata"), "uid"),
      );
      expect(resourceGraphItem(beforeRestart, "SQLiteMigrationSet", "journey-migrations").uid).toBe(
        stringAt(objectAt(migrationSet, "metadata"), "uid"),
      );
      expect(
        resourceGraphItem(
          beforeRestart,
          "SQLiteMigrationApplication",
          "journey-migration-application",
        ),
      ).toMatchObject({
        uid: stringAt(objectAt(migrationApplication, "metadata"), "uid"),
        revision: stringAt(objectAt(migrationApplication, "metadata"), "revision"),
      });
      expect(await workerRequest(hostname, cert, "/")).toBe("v2");

      rememberDescendants(host);
      const oldHostIdentity = processIdentity(host.pid);
      const acceptedWorkerd = acceptedWorkerdPath(sourceRoot);
      if (!existsSync(acceptedWorkerd)) throw new Error("accepted_workerd_snapshot_missing");
      const oldWorkerd = uniqueWorkerd(host, acceptedWorkerd);
      await stopHost(host);
      host = undefined;
      expect(identityIsLive(oldHostIdentity)).toBe(false);
      expect(identityIsLive(oldWorkerd)).toBe(false);

      // Restart the real entrypoint against the same data root, control DB, and
      // TLS paths. No resource mutation or migration-application PUT follows.
      host = startHost(hostEnvironment);
      await waitForHost(host, `${HOST_ORIGIN}/.well-known/takoform/v1`);
      const newHostIdentity = processIdentity(host.pid);
      expect(newHostIdentity.pid).not.toBe(oldHostIdentity.pid);
      expect(newHostIdentity.executable).toBe(oldHostIdentity.executable);
      const restored = await resourceGraph(auth, forms, resources);
      expect(restored).toEqual(beforeRestart);
      const afterRestartBody = JSON.parse(await workerRequest(hostname, cert, "/read")) as Json;
      expect(afterRestartBody).toMatchObject({
        version: "v2",
        value: VALUE,
        rows: [{ id: "kept", body: VALUE }],
      });
      rememberDescendants(host);
      const newWorkerd = uniqueWorkerd(host, acceptedWorkerd);
      expect(newWorkerd.pid).not.toBe(oldWorkerd.pid);
      expect(identityIsLive(newWorkerd)).toBe(true);

      for (const [kind, name] of deleteOrder) {
        await deleteResource(auth, forms, kind, name);
      }
      for (const [kind, name] of resources) {
        await expectResourceAbsent(auth, forms, kind, name);
      }
      const finalHostIdentity = processIdentity(host.pid);
      expect(identityIsLive(finalHostIdentity)).toBe(true);
    } catch (error) {
      primaryFailure = error;
      hasPrimaryFailure = true;
    } finally {
      if (admission) {
        try {
          await stopOwnedProcess(admission);
          admission = undefined;
        } catch {
          cleanupFailed = true;
        }
      }
      if (host) {
        try {
          await stopHost(host);
          host = undefined;
        } catch {
          cleanupFailed = true;
        }
      }
      if (verifier) {
        try {
          await stopOwnedProcess(verifier);
          await waitForPortClosed(CORE_VERIFIER_PORT);
          verifier = undefined;
        } catch {
          cleanupFailed = true;
        }
      }
      if (!cleanupFailed) rmSync(fixture, { recursive: true, force: true });
    }
    if (cleanupFailed) throw new Error("selfhost_kv_sqlite_restart_cleanup_failed");
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

function startHost(environment: Record<string, string>): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitForCoreVerifier(
  verifier: ReturnType<typeof Bun.spawn>,
  artifactDigest: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: verifier });
    try {
      const response = await fetch(`${CORE_VERIFIER_ORIGIN}/v1/identity`, {
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
          throw new Error("selfhost_real_core_verifier_identity_mismatch");
        return;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "selfhost_real_core_verifier_identity_mismatch"
      )
        throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error("selfhost_real_core_verifier_startup_timeout");
}

async function waitForHost(host: Host, url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
    rememberDescendants(host);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Probe the actual entrypoint listener rather than a log or a sidecar.
    }
    await Bun.sleep(50);
  }
  throw new Error("selfhost_api_listener_not_ready");
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
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== expectedStatus) {
    let code = "unknown";
    try {
      const payload = (await response.json()) as Json;
      const envelope = objectAt(payload, "error");
      if (typeof envelope.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(envelope.code))
        code = envelope.code;
    } catch {
      // Preserve only the stable classification in the failure.
    }
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(
      `selfhost_api_${method.toLowerCase()}_${response.status}_expected_${expectedStatus}_${code}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function resourcePath(forms: Map<string, Json>, kind: string, name: string): string {
  const formRef = forms.get(kind);
  if (!formRef) throw new Error(`selfhost_form_missing_${kind}`);
  const query = new URLSearchParams({
    space: SPACE,
    definitionVersion: stringAt(formRef, "definitionVersion"),
    schemaDigest: stringAt(formRef, "schemaDigest"),
  });
  return `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${query}`;
}

async function resourceGraph(
  auth: Record<string, string>,
  forms: Map<string, Json>,
  entries: readonly (readonly [string, string])[],
): Promise<
  {
    kind: string;
    name: string;
    uid: string;
    generation: string;
    revision: string;
    spec: Json;
    outputs?: Json;
  }[]
> {
  const result = [];
  for (const [kind, name] of entries) {
    const resource = await api<Json>("GET", resourcePath(forms, kind, name), 200, undefined, auth);
    const metadata = objectAt(resource, "metadata");
    const status = objectAt(resource, "status");
    const outputs = status.outputs;
    result.push({
      kind,
      name,
      uid: stringAt(metadata, "uid"),
      generation: stringAt(metadata, "generation"),
      revision: stringAt(metadata, "revision"),
      spec: objectAt(resource, "spec"),
      ...(outputs !== null && typeof outputs === "object" && !Array.isArray(outputs)
        ? { outputs: outputs as Json }
        : {}),
    });
  }
  return result;
}

function resourceGraphItem(
  graph: Awaited<ReturnType<typeof resourceGraph>>,
  kind: string,
  name: string,
) {
  const item = graph.find((entry) => entry.kind === kind && entry.name === name);
  if (!item) throw new Error(`selfhost_resource_missing_${kind}`);
  return item;
}

function output(resource: Json, name: string): string {
  return stringAt(objectAt(objectAt(resource, "status"), "outputs"), name);
}

async function deleteResource(
  auth: Record<string, string>,
  forms: Map<string, Json>,
  kind: string,
  name: string,
): Promise<void> {
  const path = resourcePath(forms, kind, name);
  const current = await api<Json>("GET", path, 200, undefined, auth);
  const metadata = objectAt(current, "metadata");
  await api<undefined>("DELETE", path, 204, undefined, {
    ...auth,
    "idempotency-key": `delete-${kind}-${name}`,
    "takoform-expected-generation": stringAt(metadata, "generation"),
    "if-match": `"${stringAt(metadata, "revision")}"`,
  });
  await expectResourceAbsent(auth, forms, kind, name);
}

async function expectResourceAbsent(
  auth: Record<string, string>,
  forms: Map<string, Json>,
  kind: string,
  name: string,
): Promise<void> {
  const missing = await api<Json>("GET", resourcePath(forms, kind, name), 404, undefined, auth);
  expect(stringAt(objectAt(missing, "error"), "code")).toBe("resource_not_found");
}

async function createTls(directory: string): Promise<void> {
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
  if ((await generated.exited) !== 0) throw new Error("synthetic_tls_generation_failed");
  chmodSync(privateKey, 0o600);
  chmodSync(certificate, 0o600);
}

function workerRequest(hostname: string, certificatePath: string, path: string): Promise<string> {
  const certificate = readFileSync(certificatePath, "utf8");
  return new Promise((resolve, reject) => {
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
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("error", () => reject(new Error("worker_https_response_error")));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200)
            reject(new Error(`worker_https_status_${response.statusCode ?? 0}`));
          else resolve(body);
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("worker_https_timeout")));
    request.once("error", (error: unknown) =>
      reject(error instanceof Error ? error : new Error("worker_https_error")),
    );
    request.end();
  });
}

async function stopHost(host: Host): Promise<void> {
  const descendants = observedDescendants.get(host) ?? new Map<string, ProcessIdentity>();
  rememberDescendants(host);
  if (host.exitCode === null) {
    host.kill("SIGTERM");
    const exitCode = await Promise.race([host.exited, Bun.sleep(5_000).then(() => null)]);
    if (exitCode === null) throw new Error("selfhost_host_stop_timeout");
    if (exitCode !== 0) throw new Error(`selfhost_host_exit_nonzero_${exitCode}`);
  }
  if (host.exitCode !== 0) throw new Error(`selfhost_host_exit_nonzero_${host.exitCode}`);
  await waitForProcessIdentitiesGone(descendants.values());
  await waitForPortClosed(API_PORT);
  await waitForPortClosed(443);
}

async function stopOwnedProcess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
    if (code === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
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

function uniqueWorkerd(host: Host, expectedExecutable: string): ProcessIdentity {
  const descendants = observedDescendants.get(host) ?? new Map<string, ProcessIdentity>();
  rememberDescendants(host);
  const matches = [...descendants.values()].filter(
    (identity) => identity.executable === expectedExecutable && identityIsLive(identity),
  );
  if (matches.length !== 1) throw new Error("selfhost_expected_one_pinned_workerd_child");
  return matches[0] as ProcessIdentity;
}

function processIdentity(pid: number): ProcessIdentity {
  const stat = processStat(pid);
  const executable = processExecutable(pid);
  if (!stat || !executable) throw new Error("selfhost_process_identity_not_live");
  return { pid, startTicks: stat.startTicks, executable };
}

function identityIsLive(identity: ProcessIdentity): boolean {
  return (
    processStat(identity.pid)?.startTicks === identity.startTicks &&
    processExecutable(identity.pid) === identity.executable
  );
}

function rememberDescendants(host: Host): void {
  let result = observedDescendants.get(host);
  if (!result) {
    result = new Map();
    observedDescendants.set(host, result);
  }
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
  while (pending.length) {
    const pid = pending.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    const stat = all.get(pid);
    if (!stat) continue;
    const executable = processExecutable(pid);
    if (executable) {
      const identity = { pid, startTicks: stat.startTicks, executable };
      result.set(`${pid}:${stat.startTicks}`, identity);
    }
    pending.push(...(children.get(pid) ?? []));
  }
}

function processStat(pid: number): { parentPid: number; startTicks: string } | null {
  let value: string;
  try {
    value = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw new Error("selfhost_process_identity_read_failed");
  }
  const close = value.lastIndexOf(")");
  if (close < 0) throw new Error("selfhost_process_identity_malformed");
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const parentPid = Number(fields[1]);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(parentPid) || typeof startTicks !== "string")
    throw new Error("selfhost_process_identity_malformed");
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
  const captured = [...identities];
  const deadline = Date.now() + 5_000;
  while (
    captured.some((identity) => processStat(identity.pid)?.startTicks === identity.startTicks)
  ) {
    if (Date.now() >= deadline) throw new Error("selfhost_descendant_quiescence_timeout");
    await Bun.sleep(25);
  }
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await portClosed(port)) return;
    await Bun.sleep(50);
  }
  throw new Error(`selfhost_listener_quiescence_timeout_${port}`);
}

function portClosed(port: number): Promise<boolean> {
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

function objectAt(value: Json, key: string): Json {
  const found = value[key];
  if (found === null || typeof found !== "object" || Array.isArray(found))
    throw new Error(`expected_object_${key}`);
  return found as Json;
}

function stringAt(value: Json, key: string): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0) throw new Error(`expected_string_${key}`);
  return found;
}
